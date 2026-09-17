import os from "node:os";
import path from "node:path";

/**
 * Every Codex Host component logs beneath one directory so a single user action can be followed
 * across launcher → controller → host runtime → adapter.
 *
 * Tests must point `CODEXHOST_LOG_DIR` at a scratch directory: the previous default was
 * `tmpdir()/codexhost-runtime.log`, which test runs and real runs shared. That made the real log
 * unreadable — a full 186-line capture turned out to be entirely test output — and it is the same
 * class of mistake as writing diagnostics into a path another process owns.
 */
export const CODEXHOST_LOG_DIR_ENV = "CODEXHOST_LOG_DIR";

export function codexhostLogDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment[CODEXHOST_LOG_DIR_ENV]?.trim();
  if (override) return override;
  return path.join(os.homedir(), "Library", "Logs", "codexhost");
}

export function codexhostLogPath(
  component: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(codexhostLogDirectory(environment), `${component}.log`);
}

/** Components that may appear under the shared log directory. */
export type CodexhostLogComponent = "launcher" | "desktop-control" | "host-runtime" | "adapter";

export function timestampedLogLine(message: string, at: number = Date.now()): string {
  return `[${new Date(at).toISOString()}] (pid:${process.pid}) ${message}`;
}
