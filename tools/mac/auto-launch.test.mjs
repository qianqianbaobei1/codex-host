import { describe, expect, it } from "vitest";

import {
  checkAndMaybeLaunch,
  desktopRootRunning,
  managedLauncherRunning,
  anyLauncherRunning,
  parseProcessTable,
  run,
} from "./auto-launch.mjs";

const desktopExecutable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const launcherExecutable = "/workspace/codexhost";

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
    expect(anyLauncherRunning([{ pid: 201, command: `${launcherExecutable} launch` }], launcherExecutable)).toBe(true);
    expect(result).toBe("already-launching");
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
    expect(errors).toEqual(["process table unavailable"]);
  });
});
