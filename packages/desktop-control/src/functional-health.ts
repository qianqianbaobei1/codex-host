import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

import { timestampedLogLine } from "./diagnostic-log.js";

export const FUNCTIONAL_HEALTH_SCHEMA_VERSION = 1;

/**
 * Functional health, deliberately separate from process liveness.
 *
 * The launcher's readiness handshake can only ever say "compatible": the Controller reports it as
 * soon as its attachment server is up, which happens *before* the renderer has been installed, and
 * the Controller never exits while it keeps retrying. So a Controller that is alive but whose
 * renderer integration has failed for hours still looks perfectly healthy from the outside — the
 * launcher's circuit breaker can only ever notice "the Controller died".
 *
 * This record closes that gap on a side channel, so the existing cross-process readiness schema
 * (which uses `deny_unknown_fields`, and would reject an unknown state and kill the app) stays
 * untouched.
 */
export type FunctionalHealthState = "initializing" | "healthy" | "degraded";

export interface FunctionalHealthRecord {
  schemaVersion: number;
  /** Identifies the process that produced this record, so a stale file can be ignored. */
  controllerPid: number;
  controllerGeneration: string;
  sessionId: string;
  startedAt: number;
  codexhostVersion: string;
  chatGPTVersion: string | null;
  state: FunctionalHealthState;
  lastHealthyAt: number | null;
  lastProbeAt: number;
  consecutiveFailures: number;
}

export interface FunctionalHealthThresholds {
  /** How long a brand-new Controller may try before failure counts as "degraded". */
  gracePeriodMs: number;
  /** Consecutive failures after a healthy period before counting as "degraded". */
  failureThreshold: number;
}

export const DEFAULT_FUNCTIONAL_HEALTH_THRESHOLDS: FunctionalHealthThresholds = {
  // Renderer installation is bounded at 90s; a little slack keeps a slow-but-working start from
  // being reported as broken.
  gracePeriodMs: 120_000,
  failureThreshold: 3,
};

/**
 * Decide the state from observed facts only.
 *
 * The important case is the first branch pair: a Controller that has *never* succeeded must still
 * reach `degraded` once the grace period passes. Requiring "the user already invoked an external
 * model" (or "it worked once") would leave the worst case — broken from the very first start —
 * permanently invisible.
 */
export function projectFunctionalHealthState(input: {
  everSucceeded: boolean;
  consecutiveFailures: number;
  startedAt: number;
  now: number;
  thresholds?: FunctionalHealthThresholds;
}): FunctionalHealthState {
  const thresholds = input.thresholds ?? DEFAULT_FUNCTIONAL_HEALTH_THRESHOLDS;
  if (input.consecutiveFailures === 0) {
    return input.everSucceeded ? "healthy" : "initializing";
  }
  if (input.everSucceeded) {
    return input.consecutiveFailures >= thresholds.failureThreshold ? "degraded" : "healthy";
  }
  return input.now - input.startedAt >= thresholds.gracePeriodMs ? "degraded" : "initializing";
}

export interface FunctionalHealthProbeInput {
  controllerPid: number;
  controllerGeneration: string;
  sessionId: string;
  startedAt: number;
  codexhostVersion: string;
  chatGPTVersion?: string | null;
  thresholds?: FunctionalHealthThresholds;
  now?: () => number;
}

export interface FunctionalHealthTracker {
  recordSuccess(): FunctionalHealthRecord;
  recordFailure(): FunctionalHealthRecord;
  current(): FunctionalHealthRecord;
}

export function createFunctionalHealthTracker(
  input: FunctionalHealthProbeInput,
): FunctionalHealthTracker {
  const thresholds = input.thresholds ?? DEFAULT_FUNCTIONAL_HEALTH_THRESHOLDS;
  const now = input.now ?? Date.now;
  let everSucceeded = false;
  let consecutiveFailures = 0;
  let lastHealthyAt: number | null = null;
  let lastProbeAt = input.startedAt;

  const snapshot = (): FunctionalHealthRecord => {
    const at = now();
    return {
      schemaVersion: FUNCTIONAL_HEALTH_SCHEMA_VERSION,
      controllerPid: input.controllerPid,
      controllerGeneration: input.controllerGeneration,
      sessionId: input.sessionId,
      startedAt: input.startedAt,
      codexhostVersion: input.codexhostVersion,
      chatGPTVersion: input.chatGPTVersion ?? null,
      state: projectFunctionalHealthState({
        everSucceeded,
        consecutiveFailures,
        startedAt: input.startedAt,
        now: at,
        thresholds,
      }),
      lastHealthyAt,
      lastProbeAt,
      consecutiveFailures,
    };
  };

  return {
    recordSuccess() {
      everSucceeded = true;
      consecutiveFailures = 0;
      lastHealthyAt = now();
      lastProbeAt = lastHealthyAt;
      return snapshot();
    },
    recordFailure() {
      consecutiveFailures += 1;
      lastProbeAt = now();
      return snapshot();
    },
    current: snapshot,
  };
}

/** True when a record belongs to this Controller generation and is recent enough to trust. */
export function isFunctionalHealthUsable(
  record: FunctionalHealthRecord | null,
  expectation: {
    controllerPid: number;
    controllerGeneration: string;
    now: number;
    maxAgeMs: number;
  },
): boolean {
  if (!record) return false;
  if (record.schemaVersion !== FUNCTIONAL_HEALTH_SCHEMA_VERSION) return false;
  if (record.controllerPid !== expectation.controllerPid) return false;
  if (record.controllerGeneration !== expectation.controllerGeneration) return false;
  if (expectation.now - record.lastProbeAt > expectation.maxAgeMs) return false;
  return true;
}

export function parseFunctionalHealthRecord(value: unknown): FunctionalHealthRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<FunctionalHealthRecord>;
  if (record.schemaVersion !== FUNCTIONAL_HEALTH_SCHEMA_VERSION) return null;
  if (typeof record.controllerPid !== "number" || !Number.isInteger(record.controllerPid)) {
    return null;
  }
  if (typeof record.controllerGeneration !== "string") return null;
  if (typeof record.sessionId !== "string") return null;
  if (typeof record.startedAt !== "number") return null;
  if (typeof record.lastProbeAt !== "number") return null;
  if (
    record.state !== "initializing" &&
    record.state !== "healthy" &&
    record.state !== "degraded"
  ) {
    return null;
  }
  return record as FunctionalHealthRecord;
}

/**
 * Publish atomically. A reader must never observe a half-written JSON document, and the file
 * carries a pid/version so a record from a previous run is never mistaken for this one.
 */
export function writeFunctionalHealthRecord(
  filePath: string,
  record: FunctionalHealthRecord,
): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const payload = `${JSON.stringify(record)}\n`;
  const descriptor = openSync(temporary, "w", 0o600);
  try {
    writeSync(descriptor, payload);
    // Flush before the rename so a crash cannot publish a truncated record.
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, filePath);
}

export function functionalHealthPath(directory: string): string {
  return path.join(directory, "functional-health.json");
}

/** Log helper so a degradation is visible in the same place as every other diagnostic. */
export function describeFunctionalHealth(record: FunctionalHealthRecord): string {
  return timestampedLogLine(
    `codexhost functional health: ${record.state} (failures=${record.consecutiveFailures}, lastHealthyAt=${record.lastHealthyAt ?? "never"})`,
  );
}
