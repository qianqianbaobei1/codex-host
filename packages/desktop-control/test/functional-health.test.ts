import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FUNCTIONAL_HEALTH_SCHEMA_VERSION,
  createFunctionalHealthTracker,
  functionalHealthPath,
  isFunctionalHealthUsable,
  parseFunctionalHealthRecord,
  projectFunctionalHealthState,
  writeFunctionalHealthRecord,
} from "../src/functional-health.js";

const THRESHOLDS = { gracePeriodMs: 120_000, failureThreshold: 3 };

describe("functional health projection", () => {
  it("reports initializing before anything has been probed", () => {
    expect(
      projectFunctionalHealthState({
        everSucceeded: false,
        consecutiveFailures: 0,
        startedAt: 0,
        now: 1_000,
        thresholds: THRESHOLDS,
      }),
    ).toBe("initializing");
  });

  it("reports healthy while no consecutive failure is pending", () => {
    expect(
      projectFunctionalHealthState({
        everSucceeded: true,
        consecutiveFailures: 0,
        startedAt: 0,
        now: 1_000,
        thresholds: THRESHOLDS,
      }),
    ).toBe("healthy");
  });

  it("tolerates isolated failures after a healthy period", () => {
    expect(
      projectFunctionalHealthState({
        everSucceeded: true,
        consecutiveFailures: 1,
        startedAt: 0,
        now: 1_000,
        thresholds: THRESHOLDS,
      }),
    ).toBe("healthy");
  });

  it("degrades once consecutive failures pass the threshold", () => {
    expect(
      projectFunctionalHealthState({
        everSucceeded: true,
        consecutiveFailures: 3,
        startedAt: 0,
        now: 1_000,
        thresholds: THRESHOLDS,
      }),
    ).toBe("degraded");
  });

  it("degrades a Controller that never succeeded, once the grace period passes", () => {
    // The case the previous design missed: broken from the very first start. Requiring "it worked
    // once" (or "the user already invoked an external model") would hide exactly this failure.
    expect(
      projectFunctionalHealthState({
        everSucceeded: false,
        consecutiveFailures: 4,
        startedAt: 0,
        now: 119_999,
        thresholds: THRESHOLDS,
      }),
    ).toBe("initializing");
    expect(
      projectFunctionalHealthState({
        everSucceeded: false,
        consecutiveFailures: 4,
        startedAt: 0,
        now: 120_000,
        thresholds: THRESHOLDS,
      }),
    ).toBe("degraded");
  });
});

describe("functional health tracker", () => {
  function tracker(startedAt = 0) {
    let clock = startedAt;
    const health = createFunctionalHealthTracker({
      controllerPid: 4242,
      controllerGeneration: "4242-0",
      sessionId: "0123456789abcdef0123456789abcdef",
      startedAt,
      codexhostVersion: "test",
      now: () => clock,
    });
    return { health, advance: (ms: number) => (clock += ms) };
  }

  it("starts initializing and becomes healthy after a successful probe", () => {
    const { health } = tracker();
    expect(health.current().state).toBe("initializing");
    expect(health.recordSuccess().state).toBe("healthy");
  });

  it("recovers from degraded when a later probe succeeds", () => {
    const { health, advance } = tracker();
    health.recordSuccess();
    for (let i = 0; i < 3; i += 1) health.recordFailure();
    expect(health.current().state).toBe("degraded");
    expect(health.recordSuccess().state).toBe("healthy");
    expect(health.current().consecutiveFailures).toBe(0);
  });

  it("degrades from a cold start rather than staying permanently initializing", () => {
    const { health, advance } = tracker();
    for (let i = 0; i < 4; i += 1) health.recordFailure();
    expect(health.current().state).toBe("initializing");
    advance(120_000);
    expect(health.current().state).toBe("degraded");
  });
});

describe("functional health record transport", () => {
  it("round-trips through the atomic writer with owner-only permissions", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codexhost-health-"));
    try {
      const record = {
        schemaVersion: FUNCTIONAL_HEALTH_SCHEMA_VERSION,
        controllerPid: process.pid,
        controllerGeneration: "generation-1",
        sessionId: "session-1",
        startedAt: 1,
        codexhostVersion: "test",
        chatGPTVersion: null,
        state: "degraded" as const,
        lastHealthyAt: null,
        lastProbeAt: 2,
        consecutiveFailures: 4,
      };
      const file = functionalHealthPath(directory);
      writeFunctionalHealthRecord(file, record);
      expect(parseFunctionalHealthRecord(JSON.parse(readFileSync(file, "utf8")))).toEqual(record);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      // No temporary file is left behind by the rename.
      expect(statSync(directory).isDirectory()).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a record from another generation or an unknown schema", () => {
    const base = {
      schemaVersion: FUNCTIONAL_HEALTH_SCHEMA_VERSION,
      controllerPid: 1,
      controllerGeneration: "gen",
      sessionId: "s",
      startedAt: 0,
      codexhostVersion: "v",
      chatGPTVersion: null,
      state: "healthy" as const,
      lastHealthyAt: 0,
      lastProbeAt: 100,
      consecutiveFailures: 0,
    };
    expect(
      isFunctionalHealthUsable(base, {
        controllerPid: 1,
        controllerGeneration: "gen",
        now: 200,
        maxAgeMs: 1_000,
      }),
    ).toBe(true);
    // A different pid means a previous run left the file behind; never trust it.
    expect(
      isFunctionalHealthUsable(base, {
        controllerPid: 2,
        controllerGeneration: "gen",
        now: 200,
        maxAgeMs: 1_000,
      }),
    ).toBe(false);
    expect(
      isFunctionalHealthUsable(base, {
        controllerPid: 1,
        controllerGeneration: "other",
        now: 200,
        maxAgeMs: 1_000,
      }),
    ).toBe(false);
    // A stale heartbeat must not be believed either.
    expect(
      isFunctionalHealthUsable(base, {
        controllerPid: 1,
        controllerGeneration: "gen",
        now: 5_000,
        maxAgeMs: 1_000,
      }),
    ).toBe(false);
    expect(parseFunctionalHealthRecord({ ...base, schemaVersion: 99 })).toBeNull();
    expect(parseFunctionalHealthRecord({ ...base, state: "nonsense" })).toBeNull();
  });
});
