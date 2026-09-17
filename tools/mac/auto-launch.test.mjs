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
  checkAndMaybeLaunch,
  createAutoLaunchLogWriter,
  desktopAppFromExecutable,
  desktopRootRunning,
  managedLauncherRunning,
  anyLauncherRunning,
  launchManagedCodex,
  openLaunchLog,
  parseProcessTable,
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

  it("degrades to a plain Desktop after repeated unconfirmed launches instead of wedging", async () => {
    const state = { consecutiveLaunchFailures: 0, degradedUntil: 0 };
    let launches = 0;
    let recoveries = 0;
    const dependencies = {
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

    // A broken injection is not assumed from one attempt: it is retried once.
    await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("launched");
    await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("launched");
    expect(launches).toBe(2);

    // Third pass: give the user a working app instead of relaunching into the wedge again.
    await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("degraded");
    expect(recoveries).toBe(1);
    expect(launches).toBe(2);

    // Inside the retry window the watcher must stay quiet, not restart the wedge loop.
    await expect(checkAndMaybeLaunch(options, dependencies)).resolves.toBe("degraded-idle");
    expect(launches).toBe(2);
    expect(recoveries).toBe(1);
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
    expect(writes).toEqual([{ consecutiveLaunchFailures: 0, degradedUntil: 0 }]);
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
