import { EventEmitter } from "node:events";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_UNCONFIRMED_LAUNCHES,
  UNCONFIRMED_FAILURE_WINDOW_MS,
  checkAndMaybeLaunch,
  createAutoLaunchLogWriter,
  desktopAppFromExecutable,
  desktopRootRunning,
  managedLauncherRunning,
  anyLauncherRunning,
  launchManagedCodex,
  openLaunchLog,
  parseProcessTable,
  readFunctionalHealth,
  recoverUnmanagedDesktop,
  retryDelayForAttempt,
  run,
} from "./auto-launch.mjs";

const desktopExecutable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const launcherExecutable = "/workspace/codexhost";

// Launching must never touch the real log path from a test.
const silentLog = { openLog: () => openSync("/dev/null", "a") };

// The watcher persists circuit-breaker state; keep that out of the real support directory.
const silentState = {
  readState: async () => ({ consecutiveLaunchFailures: 0, degradedUntil: 0 }),
  writeState: async () => undefined,
};

describe("codexhost macOS auto-launch watcher", () => {
  it("matches only the exact Desktop root executable", () => {
    const entries = parseProcessTable(
      `100 ${desktopExecutable}\n101 ${desktopExecutable} --inspect=1234\n102 /tmp/ChatGPT-helper\n`,
    );
    expect(desktopRootRunning(entries, desktopExecutable)).toBe(true);
    expect(managedLauncherRunning(entries, { launcher_pid: 102 }, launcherExecutable)).toBe(false);
  });

  it("does not relaunch an already managed Desktop", async () => {
    const result = await checkAndMaybeLaunch(
      {
        desktopExecutable,
        descriptorPath: "/tmp/runtime.json",
        launcher: launcherExecutable,
        dryRun: true,
      },
      {
        processTable: async () => [{ pid: 200, command: desktopExecutable }],
        readDescriptor: async () => ({ launcher_pid: 201 }),
        ...silentState,
      },
    );
    expect(result).toBe("would-launch");
  });

  it("recognizes the exact launcher recorded by the runtime descriptor", async () => {
    const result = await checkAndMaybeLaunch(
      {
        desktopExecutable,
        descriptorPath: "/tmp/runtime.json",
        launcher: launcherExecutable,
        dryRun: true,
      },
      {
        processTable: async () => [
          { pid: 200, command: desktopExecutable },
          { pid: 201, command: launcherExecutable + " launch" },
        ],
        readDescriptor: async () => ({ launcher_pid: 201 }),
        ...silentState,
      },
    );
    expect(result).toBe("already-managed");
  });

  it("blocks a second launch while an existing codexhost Launcher is warming up", async () => {
    const result = await checkAndMaybeLaunch(
      {
        desktopExecutable,
        descriptorPath: "/tmp/runtime.json",
        launcher: launcherExecutable,
        dryRun: true,
      },
      {
        processTable: async () => [
          { pid: 200, command: desktopExecutable },
          { pid: 201, command: launcherExecutable + " launch" },
        ],
        readDescriptor: async () => null,
      },
    );
    expect(
      anyLauncherRunning(
        [{ pid: 201, command: `${launcherExecutable} launch` }],
        launcherExecutable,
      ),
    ).toBe(true);
    expect(result).toBe("already-launching");
  });

  it("waits for launcher spawn and turns spawn failures into rejected work", async () => {
    const successfulChild = new EventEmitter();
    successfulChild.unref = () => undefined;
    const successful = launchManagedCodex(
      {
        root: "/workspace",
        launcher: launcherExecutable,
        shim: "/workspace/shim",
        node: "/workspace/node",
        hostRuntime: "/workspace/host.js",
        desktopController: "/workspace/desktop.js",
        renderer: "/workspace/renderer.js",
        path: "/usr/bin",
      },
      { spawn: () => successfulChild, ...silentLog },
    );
    successfulChild.emit("spawn");
    await expect(successful).resolves.toBe(successfulChild);

    const failedChild = new EventEmitter();
    failedChild.unref = () => undefined;
    const failed = launchManagedCodex(
      {
        root: "/workspace",
        launcher: launcherExecutable,
        shim: "/workspace/shim",
        node: "/workspace/node",
        hostRuntime: "/workspace/host.js",
        desktopController: "/workspace/desktop.js",
        renderer: "/workspace/renderer.js",
        path: "/usr/bin",
      },
      { spawn: () => failedChild, ...silentLog },
    );
    const error = new Error("spawn ENOENT");
    failedChild.emit("error", error);
    await expect(failed).rejects.toBe(error);
  });

  it("writes successful notices to the info logger and failures to the error logger", async () => {
    const info = [];
    const errors = [];
    await run(
      {
        once: true,
        desktopExecutable,
        descriptorPath: "/tmp/runtime.json",
        launcher: launcherExecutable,
        dryRun: true,
      },
      {
        processTable: async () => [{ pid: 200, command: desktopExecutable }],
        readDescriptor: async () => null,
        log: (message) => info.push(message),
        error: (message) => errors.push(message),
      },
    );
    expect(info).toEqual(["dry run: an unmanaged Codex Desktop would start codexhost"]);
    expect(errors).toEqual([]);

    await run(
      {
        once: true,
        desktopExecutable,
        descriptorPath: "/tmp/runtime.json",
        launcher: launcherExecutable,
      },
      {
        processTable: async () => {
          throw new Error("process table unavailable");
        },
        log: (message) => info.push(message),
        error: (message) => errors.push(message),
      },
    );
    expect(errors).toEqual(["process table unavailable (attempt 1, retrying in 10s)"]);
  });

  it("keeps adopting an unconfirmed Desktop until the streak spans the failure window", async () => {
    let clock = 1_000_000;
    const state = { consecutiveLaunchFailures: 0, degradedUntil: 0, firstUnconfirmedAt: 0 };
    let launches = 0;
    let recoveries = 0;
    const dependencies = {
      now: () => clock,
      processTable: async () => [{ pid: 200, command: desktopExecutable }],
      readDescriptor: async () => null,
      readState: async () => ({ ...state }),
      writeState: async (_path, next) => Object.assign(state, next),
      launch: async () => {
        launches += 1;
      },
      recoverDesktop: async () => {
        recoveries += 1;
        return true;
      },
    };
    const options = {
      desktopExecutable,
      descriptorPath: "/tmp/runtime.json",
      launcher: launcherExecutable,
    };

    // A cold start can lose two or three launches to a still-loading Renderer. None of those may
    // close the user's Desktop: the streak has to span real time first.
    for (let attempt = 0; attempt < MAX_UNCONFIRMED_LAUNCHES; attempt += 1) {
      await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("launched");
      clock += 30_000;
    }
    expect(launches).toBe(MAX_UNCONFIRMED_LAUNCHES);
    expect(recoveries).toBe(0);

    // Still inside the window: keep retrying rather than restarting the Desktop.
    clock += UNCONFIRMED_FAILURE_WINDOW_MS - 30_000 * MAX_UNCONFIRMED_LAUNCHES - 1;
    await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("launched");
    expect(recoveries).toBe(0);

    // The window has now elapsed, so the Desktop counts as wedged and the user gets a plain app.
    clock += 1;
    await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("degraded");
    expect(recoveries).toBe(1);
    expect(launches).toBe(MAX_UNCONFIRMED_LAUNCHES + 1);

    // Inside the retry window the watcher must stay quiet, not restart the wedge loop.
    await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("degraded-idle");
    expect(recoveries).toBe(1);

    // Once the window passes, injection gets a fresh streak: the persisted state must not carry
    // the old one over, or the Desktop would be restarted again on the very next attempt — and
    // then again every window, forever.
    clock += 15 * 60_000 + 1;
    await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("launched");
    expect(recoveries).toBe(1);
    expect(state.consecutiveLaunchFailures).toBe(1);
    expect(state.firstUnconfirmedAt).toBe(clock);
  });

  it("forgets the unconfirmed streak as soon as a launch is confirmed", async () => {
    const state = {
      consecutiveLaunchFailures: MAX_UNCONFIRMED_LAUNCHES,
      degradedUntil: 0,
      firstUnconfirmedAt: 1,
    };
    const writes = [];
    const options = {
      desktopExecutable,
      descriptorPath: "/tmp/runtime.json",
      launcher: launcherExecutable,
      statePath: "/tmp/state.json",
    };
    const result = await checkAndMaybeLaunch(options, {
      now: () => 1_000,
      processTable: async () => [
        { pid: 200, command: desktopExecutable },
        { pid: 201, command: `${launcherExecutable} launch` },
      ],
      readDescriptor: async () => ({ launcher_pid: 201 }),
      readState: async () => ({ ...state }),
      writeState: async (_path, next) => writes.push(next),
    });
    expect(result).toBe("already-managed");
    expect(writes).toEqual([
      { consecutiveLaunchFailures: 0, degradedUntil: 0, firstUnconfirmedAt: 0 },
    ]);
  });

  it("clears the failure counter once a managed launch is confirmed", async () => {
    const writes = [];
    const result = await checkAndMaybeLaunch(
      {
        desktopExecutable,
        descriptorPath: "/tmp/runtime.json",
        launcher: launcherExecutable,
        statePath: "/tmp/state.json",
      },
      {
        processTable: async () => [
          { pid: 200, command: desktopExecutable },
          { pid: 201, command: `${launcherExecutable} launch` },
        ],
        readDescriptor: async () => ({ launcher_pid: 201 }),
        readState: async () => ({ consecutiveLaunchFailures: 2, degradedUntil: 0 }),
        writeState: async (_path, next) => writes.push(next),
      },
    );
    expect(result).toBe("already-managed");
    expect(writes).toEqual([
      { consecutiveLaunchFailures: 0, degradedUntil: 0, firstUnconfirmedAt: 0 },
    ]);
  });

  it("recovers a wedged Desktop by restarting it as a plain app", async () => {
    const killed = [];
    const opened = [];
    const recovered = await recoverUnmanagedDesktop(
      { desktopExecutable },
      [
        { pid: 200, command: desktopExecutable },
        { pid: 999, command: "/Applications/Other.app/Contents/MacOS/Other" },
      ],
      {
        killProcess: (pid) => killed.push(pid),
        sleep: async () => undefined,
        openDesktop: async (app) => opened.push(app),
      },
    );
    expect(killed).toEqual([200]);
    expect(opened).toEqual(["/Applications/ChatGPT.app"]);
    expect(recovered).toBe(true);
  });

  it("derives the bundle path a plain relaunch needs", () => {
    expect(desktopAppFromExecutable(desktopExecutable)).toBe("/Applications/ChatGPT.app");
    expect(desktopAppFromExecutable("/usr/local/bin/chatgpt")).toBeNull();
  });

  it("writes watcher notices somewhere a human can read them", () => {
    const directory = join(tmpdir(), `codexhost-watcher-log-${process.pid}-${Date.now()}`);
    const logPath = join(directory, "launcher.log");
    try {
      // The watcher runs under launchd, so its stderr is unreadable; the file is the only place
      // a circuit-breaker warning can surface.
      const writeLog = createAutoLaunchLogWriter(logPath);
      writeLog("error", "Renderer injection failed 2 times in a row");
      const content = readFileSync(logPath, "utf8");
      expect(content).toContain("auto-launch error: Renderer injection failed 2 times in a row");
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("surfaces a live controller that reports degraded functional health", async () => {
    const options = {
      desktopExecutable,
      descriptorPath: "/tmp/runtime.json",
      launcher: launcherExecutable,
      healthPath: "/tmp/functional-health.json",
    };
    const dependencies = {
      processTable: async () => [
        { pid: 200, command: desktopExecutable },
        { pid: 201, command: `${launcherExecutable} launch` },
      ],
      readDescriptor: async () => ({ launcher_pid: 201 }),
      readState: async () => ({ consecutiveLaunchFailures: 0, degradedUntil: 0 }),
      writeState: async () => undefined,
      readHealth: async () => ({
        state: "degraded",
        lastProbeAt: Date.now(),
        consecutiveFailures: 4,
      }),
    };
    // A live launcher is not proof of a working integration.
    await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("managed-degraded");
  });

  it("treats a stale health record as no evidence", async () => {
    const options = {
      desktopExecutable,
      descriptorPath: "/tmp/runtime.json",
      launcher: launcherExecutable,
      healthPath: "/tmp/functional-health.json",
    };
    const dependencies = {
      processTable: async () => [
        { pid: 200, command: desktopExecutable },
        { pid: 201, command: `${launcherExecutable} launch` },
      ],
      readDescriptor: async () => ({ launcher_pid: 201 }),
      readState: async () => ({ consecutiveLaunchFailures: 0, degradedUntil: 0 }),
      writeState: async () => undefined,
      // Written ten minutes ago: it says nothing about the process running now.
      readHealth: async () => ({
        state: "degraded",
        lastProbeAt: Date.now() - 10 * 60_000,
        consecutiveFailures: 4,
      }),
    };
    await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("already-managed");
  });

  it("reads a health record defensively", () => {
    const directory = join(tmpdir(), `codexhost-health-read-${process.pid}-${Date.now()}`);
    const file = join(directory, "functional-health.json");
    try {
      mkdirSync(directory, { recursive: true });
      expect(readFunctionalHealth(file)).toBeNull();
      writeFileSync(file, "not json");
      expect(readFunctionalHealth(file)).toBeNull();
      writeFileSync(file, JSON.stringify({ state: "healthy" }));
      expect(readFunctionalHealth(file)).toBeNull();
      writeFileSync(file, JSON.stringify({ state: "healthy", lastProbeAt: 12 }));
      expect(readFunctionalHealth(file)).toEqual({
        state: "healthy",
        lastProbeAt: 12,
        consecutiveFailures: 0,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backs off exponentially on repeated launch failures and caps the delay", () => {
    expect(retryDelayForAttempt(1)).toBe(10_000);
    expect(retryDelayForAttempt(2)).toBe(20_000);
    expect(retryDelayForAttempt(3)).toBe(40_000);
    expect(retryDelayForAttempt(5)).toBe(160_000);
    // Capped so a permanently broken setup retries slowly instead of forever-hot.
    expect(retryDelayForAttempt(6)).toBe(300_000);
    expect(retryDelayForAttempt(20)).toBe(300_000);
  });

  it("rotates the launch log once it exceeds the cap", () => {
    const directory = join(tmpdir(), `codexhost-log-${process.pid}-${Date.now()}`);
    const logPath = join(directory, "launcher.log");
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(logPath, Buffer.alloc(5 * 1024 * 1024));
      const fd = openLaunchLog(logPath);
      try {
        expect(statSync(`${logPath}.1`).size).toBe(5 * 1024 * 1024);
        expect(statSync(logPath).size).toBe(0);
        expect(statSync(logPath).mode & 0o777).toBe(0o600);
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tightens a pre-existing world-readable launch log", () => {
    const directory = join(tmpdir(), `codexhost-log-mode-${process.pid}-${Date.now()}`);
    const logPath = join(directory, "launcher.log");
    try {
      mkdirSync(directory, { recursive: true });
      // Renderer exception text can quote conversation content, so an inherited loose mode
      // from an earlier version must not survive the upgrade.
      writeFileSync(logPath, "stale\n", { mode: 0o644 });
      const fd = openLaunchLog(logPath);
      try {
        expect(statSync(logPath).mode & 0o777).toBe(0o600);
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
