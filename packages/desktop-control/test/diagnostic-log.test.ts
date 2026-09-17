import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEXHOST_LOG_DIR_ENV,
  codexhostLogDirectory,
  codexhostLogPath,
  timestampedLogLine,
} from "../src/diagnostic-log.js";

describe("shared diagnostic log location", () => {
  it("defaults to one directory per user so components can be correlated", () => {
    expect(codexhostLogDirectory({})).toBe(path.join(os.homedir(), "Library", "Logs", "codexhost"));
    expect(codexhostLogPath("host-runtime", {})).toBe(
      path.join(os.homedir(), "Library", "Logs", "codexhost", "host-runtime.log"),
    );
  });

  it("honours the override so tests never touch the real directory", () => {
    const environment = { [CODEXHOST_LOG_DIR_ENV]: "/scratch/codexhost-logs" };
    expect(codexhostLogDirectory(environment)).toBe("/scratch/codexhost-logs");
    expect(codexhostLogPath("adapter", environment)).toBe("/scratch/codexhost-logs/adapter.log");
  });

  it("ignores a blank override instead of writing to the filesystem root", () => {
    expect(codexhostLogDirectory({ [CODEXHOST_LOG_DIR_ENV]: "   " })).toBe(
      path.join(os.homedir(), "Library", "Logs", "codexhost"),
    );
  });

  it("stamps every line so a failure can be placed in time", () => {
    const line = timestampedLogLine("something failed", 1_700_000_000_000);
    expect(line).toContain("[2023-11-14T22:13:20.000Z]");
    expect(line).toContain(`(pid:${process.pid})`);
    expect(line).toContain("something failed");
  });

  it("keeps this very test run out of the real log directory", () => {
    // The vitest config injects a scratch directory; if that regresses, real diagnostics get
    // polluted by test output again.
    expect(process.env[CODEXHOST_LOG_DIR_ENV]).toBeTruthy();
    expect(codexhostLogDirectory()).not.toBe(
      path.join(os.homedir(), "Library", "Logs", "codexhost"),
    );
  });
});
