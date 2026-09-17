/**
 * Session write lease: one writer per native conversation, process-wide.
 *
 * Once every Account reaches the same canonical session store, "the Account's
 * HOME is the boundary" stops being true: two runtimes — two Hosts, two Accounts,
 * a crash survivor, a debug CLI — can name the same `conversations/<id>.db`.
 * SQLite WAL handles the *file*, but AGY also runs session-scoped background
 * writers (summary reconciliation, annotations) that no database lock protects.
 *
 * So the invariant is enforced one level up: before a Session is opened, its
 * native conversation is claimed with an exclusive lease; the lease is released
 * when the Session closes. Ownership is decided by the kernel (`O_EXCL`), never
 * by a "does the file look free?" check.
 *
 * The record carries a `generation` so that a superseded writer can never act on
 * the new holder's behalf — `release()` refuses to delete a lease it no longer
 * owns, which is the same guard any deferred writer needs before it flushes.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import path from "node:path";

export const SESSION_LEASE_FORMAT_VERSION = 1;

export interface AntigravitySessionLeaseRecord {
  formatVersion: 1;
  nativeSessionId: string;
  accountId: string;
  /** Identifies the owning runtime instance (host process start + pid). */
  hostInstanceId: string;
  pid: number;
  /** `ps -o lstart=` of `pid`, used to detect a recycled pid. */
  processStartedAt: string | null;
  /**
   * Monotonic per conversation: every acquisition, clean handover or crash
   * takeover alike, takes the next number. A writer from an older generation can
   * therefore never act on the current holder's behalf.
   */
  generation: number;
  acquiredAt: string;
  /** `released` keeps the counter alive so the next acquisition is unique. */
  state: "held" | "released";
  releasedAt?: string;
  /** Present when this acquisition took over an abandoned lease. */
  stolenFrom?: { pid: number; generation: number; reason: string };
}

export interface AntigravitySessionLease {
  readonly record: AntigravitySessionLeaseRecord;
  readonly path: string;
  /** Idempotent. Refuses to release a lease another generation now owns. */
  release(): void;
}

export class AntigravitySessionLeaseError extends Error {
  readonly code: "busy" | "unavailable";
  readonly holder: AntigravitySessionLeaseRecord | null;

  constructor(
    code: "busy" | "unavailable",
    message: string,
    holder: AntigravitySessionLeaseRecord | null,
  ) {
    super(message);
    this.name = "AntigravitySessionLeaseError";
    this.code = code;
    this.holder = holder;
  }
}

const NATIVE_ID_PATTERN = /^[A-Za-z0-9._~-]+$/u;

export function sessionLeasePath(leasesDirectory: string, nativeSessionId: string): string {
  if (!NATIVE_ID_PATTERN.test(nativeSessionId)) {
    throw new AntigravitySessionLeaseError(
      "unavailable",
      `Native Session id is not filename-safe: '${nativeSessionId}'`,
      null,
    );
  }
  return path.join(leasesDirectory, `${nativeSessionId}.lock`);
}

function processStartTime(pid: number): string | null {
  try {
    const output = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function writeRecord(file: string, record: AntigravitySessionLeaseRecord): void {
  const descriptor = openSync(file, "w", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function readRecord(file: string): AntigravitySessionLeaseRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<AntigravitySessionLeaseRecord>;
    if (record.formatVersion !== SESSION_LEASE_FORMAT_VERSION) return null;
    if (typeof record.nativeSessionId !== "string" || typeof record.pid !== "number") return null;
    if (typeof record.generation !== "number") return null;
    return {
      ...(record as AntigravitySessionLeaseRecord),
      state: record.state === "released" ? "released" : "held",
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A holder is live only if its pid is alive *and* is still the same process: a
 * recycled pid would otherwise block a conversation forever.
 */
export function isSessionLeaseHolderLive(record: AntigravitySessionLeaseRecord): boolean {
  if (record.state === "released") return false;
  if (!isProcessAlive(record.pid)) return false;
  if (!record.processStartedAt) return true;
  const current = processStartTime(record.pid);
  return current === null || current === record.processStartedAt;
}

export interface AcquireSessionLeaseInput {
  leasesDirectory: string;
  nativeSessionId: string;
  accountId: string;
  hostInstanceId?: string;
  /** Test seams. */
  pid?: number;
  processStartedAt?: string | null;
  now?: Date;
}

/**
 * Claim the conversation, or fail with `busy` and the current holder.
 * An abandoned lease (dead pid, recycled pid, or unreadable file) is taken over
 * with a bumped generation, and the takeover is appended to `steal-log.jsonl`
 * so a surprise is never silent.
 */
export function acquireSessionLease(input: AcquireSessionLeaseInput): AntigravitySessionLease {
  const leasePath = sessionLeasePath(input.leasesDirectory, input.nativeSessionId);
  mkdirSync(input.leasesDirectory, { recursive: true, mode: 0o700 });
  const pid = input.pid ?? process.pid;
  const startedAt =
    input.processStartedAt === undefined ? processStartTime(pid) : input.processStartedAt;
  const hostInstanceId = input.hostInstanceId ?? `${hostname()}:${pid}`;
  let stolenFrom: AntigravitySessionLeaseRecord["stolenFrom"];
  let generation = 1;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor: number;
    try {
      descriptor = openSync(leasePath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new AntigravitySessionLeaseError(
          "unavailable",
          `Session lease could not be created: ${(error as Error).message}`,
          null,
        );
      }
      const holder = readRecord(leasePath);
      if (holder && isSessionLeaseHolderLive(holder)) {
        throw new AntigravitySessionLeaseError(
          "busy",
          `Native Session '${input.nativeSessionId}' is already owned by pid ${holder.pid} (account '${holder.accountId}')`,
          holder,
        );
      }
      // An unreadable record is treated as abandoned rather than trusted, and a
      // recycled pid must not block the conversation forever.
      if (holder && holder.state === "held") {
        stolenFrom = {
          pid: holder.pid,
          generation: holder.generation,
          reason: isProcessAlive(holder.pid)
            ? "process identity changed (pid reuse)"
            : "owner process is gone",
        };
      } else if (!holder) {
        stolenFrom = { pid: -1, generation: 0, reason: "lease record was unreadable" };
      }
      generation = (holder?.generation ?? 0) + 1;
      takeOver(leasePath);
      continue;
    }
    const record: AntigravitySessionLeaseRecord = {
      formatVersion: SESSION_LEASE_FORMAT_VERSION,
      nativeSessionId: input.nativeSessionId,
      accountId: input.accountId,
      hostInstanceId,
      pid,
      processStartedAt: startedAt,
      generation,
      acquiredAt: (input.now ?? new Date()).toISOString(),
      state: "held",
      ...(stolenFrom ? { stolenFrom } : {}),
    };
    if (stolenFrom) appendTakeoverLog(input.leasesDirectory, record);
    return acquireWithDescriptor(leasePath, record, hostInstanceId, descriptor);
  }
  throw new AntigravitySessionLeaseError(
    "unavailable",
    `Session lease for '${input.nativeSessionId}' could not be acquired`,
    null,
  );
}

function acquireWithDescriptor(
  leasePath: string,
  record: AntigravitySessionLeaseRecord,
  hostInstanceId: string,
  descriptor: number,
): AntigravitySessionLease {
  let released = false;
  try {
    writeSync(descriptor, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(descriptor);
  }
  return {
    record,
    path: leasePath,
    release(): void {
      if (released) return;
      released = true;
      const current = readRecord(leasePath);
      // Only the generation that still owns the lease may retire it: a superseded
      // writer must never touch the record a newer holder relies on.
      if (
        !current ||
        current.generation !== record.generation ||
        current.pid !== record.pid ||
        current.hostInstanceId !== hostInstanceId
      ) {
        return;
      }
      try {
        writeRecord(leasePath, {
          ...current,
          state: "released",
          releasedAt: new Date().toISOString(),
        });
      } catch {
        /* the lease is no longer observable; the next acquisition treats it as stale */
      }
    },
  };
}

/**
 * Drop a lease that nobody holds. `O_EXCL` is what actually decides the race;
 * this only clears the way, so a losing racer simply re-reads the new state.
 */
function takeOver(leasePath: string): void {
  try {
    unlinkSync(leasePath);
  } catch {
    // Another racer already took it over; the retry loop re-reads the new state.
  }
}

function appendTakeoverLog(leasesDirectory: string, record: AntigravitySessionLeaseRecord): void {
  try {
    appendFileSync(path.join(leasesDirectory, "steal-log.jsonl"), `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    /* Observability must never fail an acquisition. */
  }
}

/** Read-only view of who owns a conversation right now. */
export function inspectSessionLease(
  leasesDirectory: string,
  nativeSessionId: string,
): { holder: AntigravitySessionLeaseRecord | null; live: boolean } {
  const leasePath = sessionLeasePath(leasesDirectory, nativeSessionId);
  const holder = readRecord(leasePath);
  if (!holder) {
    // Report an unreadable lease rather than pretending the conversation is free.
    const present = statSync(leasePath, { throwIfNoEntry: false });
    return { holder: null, live: present !== undefined };
  }
  return { holder, live: isSessionLeaseHolderLive(holder) };
}

/** The generation a writer must still hold before it may flush its work. */
export function currentSessionLeaseGeneration(
  leasesDirectory: string,
  nativeSessionId: string,
): number {
  return readRecord(sessionLeasePath(leasesDirectory, nativeSessionId))?.generation ?? 0;
}
