import { describe, expect, it } from "vitest";

import { requestManagerPollInterval } from "../src/renderer-draft-prewarm-policy.js";

const WAIT_WINDOW_MS = 60_000;

describe("renderer request-manager probe backoff", () => {
  it("spaces probes out instead of hammering the renderer", () => {
    expect(requestManagerPollInterval(1)).toBe(25);
    expect(requestManagerPollInterval(2)).toBe(50);
    expect(requestManagerPollInterval(3)).toBe(100);
    expect(requestManagerPollInterval(4)).toBe(200);
  });

  it("caps the interval so readiness is still noticed promptly", () => {
    expect(requestManagerPollInterval(5)).toBe(250);
    expect(requestManagerPollInterval(50)).toBe(250);
  });

  it("tolerates a non-positive or fractional attempt", () => {
    expect(requestManagerPollInterval(0)).toBe(25);
    expect(requestManagerPollInterval(-3)).toBe(25);
    expect(requestManagerPollInterval(2.7)).toBe(50);
  });

  it("does not shorten the wait window: probes keep coming for the full 60s", () => {
    // The install still has REQUEST_MANAGER_WAIT_TIMEOUT_MS to succeed. Backoff must not turn a
    // slow-but-recoverable renderer into a failure, so accumulate the intervals and check that
    // many probes still fit inside the window.
    let elapsed = 0;
    let attempt = 0;
    let probes = 0;
    while (elapsed < WAIT_WINDOW_MS) {
      attempt += 1;
      probes += 1;
      elapsed += requestManagerPollInterval(attempt);
    }
    // Far fewer walks than the old fixed 25ms cadence (~2400), but still ample for a renderer
    // that becomes ready at any point in the window.
    expect(probes).toBeGreaterThan(200);
    expect(probes).toBeLessThan(300);
  });

  it("is strictly less work than the previous fixed cadence", () => {
    const fixedProbes = Math.floor(WAIT_WINDOW_MS / 25);
    let elapsed = 0;
    let attempt = 0;
    let backoffProbes = 0;
    while (elapsed < WAIT_WINDOW_MS) {
      attempt += 1;
      backoffProbes += 1;
      elapsed += requestManagerPollInterval(attempt);
    }
    expect(backoffProbes).toBeLessThan(fixedProbes / 4);
  });
});
