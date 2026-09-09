#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_MS = 1_000;
const RETRY_INTERVAL_MS = 10_000;

export function parseProcessTable(stdout) {
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return match ? [{ pid: Number.parseInt(match[1], 10), command: match[2] }] : [];
  });
}

function commandMatches(entry, executable) {
  return entry.command === executable || entry.command.startsWith(`${executable} `);
}

export function desktopRootRunning(entries, desktopExecutable) {
  return entries.some((entry) => commandMatches(entry, desktopExecutable));
}

export function managedLauncherRunning(entries, descriptor, launcherExecutable) {
  if (
    !descriptor ||
    !Number.isSafeInteger(descriptor.launcher_pid) ||
    descriptor.launcher_pid <= 0
  ) {
    return false;
  }
  const launcher = entries.find((entry) => entry.pid === descriptor.launcher_pid);
  return launcher !== undefined && commandMatches(launcher, launcherExecutable);
}

export function anyLauncherRunning(entries, launcherExecutable) {
  return entries.some((entry) => commandMatches(entry, launcherExecutable));
}

async function processTable() {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return parseProcessTable(stdout);
}

async function readDescriptor(descriptorPath) {
  try {
    return JSON.parse(await readFile(descriptorPath, "utf8"));
  } catch {
    return null;
  }
}

export function launcherArguments(options) {
  return [
    "launch",
    "--shim",
    options.shim,
    "--node",
    options.node,
    "--host-runtime",
    options.hostRuntime,
    "--desktop-controller",
    options.desktopController,
    "--renderer",
    options.renderer,
  ];
}

export async function launchManagedCodex(options, dependencies = {}) {
  const spawnImplementation = dependencies.spawn ?? spawn;
  const child = spawnImplementation(options.launcher, launcherArguments(options), {
    cwd: options.root,
    env: {
      ...process.env,
      PATH: options.path,
    },
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref?.();
  return child;
}

export async function checkAndMaybeLaunch(options, dependencies = {}) {
  const readProcesses = dependencies.processTable ?? processTable;
  const entries = await readProcesses();
  if (!desktopRootRunning(entries, options.desktopExecutable)) return "desktop-not-running";
  const descriptor = await (dependencies.readDescriptor ?? readDescriptor)(options.descriptorPath);
  if (managedLauncherRunning(entries, descriptor, options.launcher)) return "already-managed";
  if (anyLauncherRunning(entries, options.launcher)) return "already-launching";
  if (options.dryRun) return "would-launch";
  await (dependencies.launch ?? launchManagedCodex)(options, dependencies);
  return "launched";
}

export function parseOptions(arguments_) {
  const options = {
    once: false,
    dryRun: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    launcher: null,
    shim: null,
    node: null,
    hostRuntime: null,
    desktopController: null,
    renderer: null,
    desktopExecutable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    descriptorPath: `${process.env.HOME ?? ""}/Library/Application Support/codexhost/desktop-runtime-v1.json`,
    root: process.cwd(),
    path: process.env.PATH ?? "/usr/bin:/bin",
  };
  const value = (index, option) => {
    const next = arguments_[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${option} requires a value`);
    return next;
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--once") options.once = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--launcher") options.launcher = value(index++, argument);
    else if (argument === "--shim") options.shim = value(index++, argument);
    else if (argument === "--node") options.node = value(index++, argument);
    else if (argument === "--host-runtime") options.hostRuntime = value(index++, argument);
    else if (argument === "--desktop-controller")
      options.desktopController = value(index++, argument);
    else if (argument === "--renderer") options.renderer = value(index++, argument);
    else if (argument === "--desktop-executable")
      options.desktopExecutable = value(index++, argument);
    else if (argument === "--descriptor") options.descriptorPath = value(index++, argument);
    else if (argument === "--root") options.root = value(index++, argument);
    else if (argument === "--path") options.path = value(index++, argument);
    else if (argument === "--interval-ms") {
      const milliseconds = Number.parseInt(value(index++, argument), 10);
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 250) {
        throw new Error("--interval-ms must be an integer of at least 250ms");
      }
      options.intervalMs = milliseconds;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  for (const [name, filePath] of Object.entries(options)) {
    if (
      [
        "once",
        "dryRun",
        "intervalMs",
        "desktopExecutable",
        "descriptorPath",
        "root",
        "path",
      ].includes(name)
    )
      continue;
    if (!filePath)
      throw new Error(
        `--${name.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`,
      );
  }
  return options;
}

export async function run(options, dependencies = {}) {
  const logger =
    dependencies.log ?? ((message) => console.log(`[codexhost auto-launch] ${message}`));
  const errorLogger =
    dependencies.error ?? ((message) => console.error(`[codexhost auto-launch] ${message}`));
  let inFlight = null;
  let nextAttemptAt = 0;
  const tick = async () => {
    if (inFlight || Date.now() < nextAttemptAt) return;
    try {
      const result = await checkAndMaybeLaunch(options, dependencies);
      if (result === "launched") {
        nextAttemptAt = Date.now() + RETRY_INTERVAL_MS;
        logger("detected an unmanaged Codex Desktop; started codexhost");
      } else if (result === "would-launch") {
        logger("dry run: an unmanaged Codex Desktop would start codexhost");
      }
    } catch (error) {
      nextAttemptAt = Date.now() + RETRY_INTERVAL_MS;
      errorLogger(error instanceof Error ? error.message : String(error));
    }
  };
  inFlight = tick().finally(() => {
    inFlight = null;
  });
  await inFlight;
  if (options.once) return;
  setInterval(() => {
    if (!inFlight) {
      inFlight = tick().finally(() => {
        inFlight = null;
      });
    }
  }, options.intervalMs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `[codexhost auto-launch] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
