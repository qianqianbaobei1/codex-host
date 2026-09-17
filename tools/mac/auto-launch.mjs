#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_MS = 3_000;
const RETRY_INTERVAL_MS = 10_000;
const MAX_RETRY_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LOG_PATH = `${process.env.HOME ?? ""}/Library/Logs/codexhost/launcher.log`;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_STATE_PATH = `${process.env.HOME ?? ""}/Library/Application Support/codexhost/auto-launch-state.json`;
const DEFAULT_HEALTH_PATH = `${process.env.HOME ?? ""}/Library/Logs/codexhost/functional-health.json`;
/** How stale a health record may be before it stops being evidence about the current run. */
const FUNCTIONAL_HEALTH_MAX_AGE_MS = 5 * 60_000;
// A managed launch is only confirmed once the runtime descriptor names a live launcher. Two
// unconfirmed attempts in a row mean injection is broken, not slow.
const MAX_UNCONFIRMED_LAUNCHES = 2;
// While degraded the Desktop stays usable as a plain app; retry injection only occasionally.
const DEGRADED_RETRY_MS = 15 * 60_000;

export function parseProcessTable(stdout) {
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return match ? [{ pid: Number.parseInt(match[1], 10), command: match[2] }] : [];
  });
}

function commandMatches(entry, executable) {
  return entry.command === executable || entry.command.startsWith(`${executable} `);
}

/**
 * `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT` -> `/Applications/ChatGPT.app`.
 * The plain-app fallback needs a bundle path for LaunchServices, not the executable.
 */
export function desktopAppFromExecutable(executable) {
  const marker = ".app/Contents/MacOS/";
  const index = executable.indexOf(marker);
  return index < 0 ? null : executable.slice(0, index + ".app".length);
}

export function readAutoLaunchState(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      consecutiveLaunchFailures:
        Number.isSafeInteger(parsed?.consecutiveLaunchFailures) &&
        parsed.consecutiveLaunchFailures >= 0
          ? parsed.consecutiveLaunchFailures
          : 0,
      degradedUntil: Number.isSafeInteger(parsed?.degradedUntil) ? parsed.degradedUntil : 0,
    };
  } catch {
    // A missing or corrupt state file must never block launching.
    return { consecutiveLaunchFailures: 0, degradedUntil: 0 };
  }
}

export function writeAutoLaunchState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

/**
 * Read the Controller's functional-health record.
 *
 * Process liveness cannot distinguish "the Controller is running" from "the Controller is running
 * but its renderer integration died hours ago". The Controller publishes that separately, because
 * the cross-process readiness handshake can only ever say "compatible".
 */
export function readFunctionalHealth(healthPath) {
  try {
    const parsed = JSON.parse(readFileSync(healthPath, "utf8"));
    if (typeof parsed?.state !== "string") return null;
    if (!Number.isSafeInteger(parsed?.lastProbeAt)) return null;
    return {
      state: parsed.state,
      lastProbeAt: parsed.lastProbeAt,
      consecutiveFailures: Number.isSafeInteger(parsed?.consecutiveFailures)
        ? parsed.consecutiveFailures
        : 0,
    };
  } catch {
    // No record yet, or an unreadable one, is not itself a failure signal.
    return null;
  }
}

/**
 * Last-resort recovery: a failed injection can leave a Desktop whose renderer is wedged, so
 * hand the user a clean plain app instead of a white window. Sessions live server-side, so
 * restarting the Desktop loses nothing.
 */
export async function recoverUnmanagedDesktop(options, entries, dependencies = {}) {
  const killProcess = dependencies.killProcess ?? ((pid) => process.kill(pid, "SIGTERM"));
  for (const entry of entries) {
    if (!commandMatches(entry, options.desktopExecutable)) continue;
    try {
      killProcess(entry.pid);
    } catch {
      // Already gone; nothing to recover.
    }
  }
  await (dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(2_000);
  const app = options.desktopApp ?? desktopAppFromExecutable(options.desktopExecutable);
  if (!app) return false;
  const openDesktop =
    dependencies.openDesktop ??
    ((bundlePath) =>
      new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/open", ["-a", bundlePath], {
          detached: true,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref?.();
          resolve();
        });
      }));
  await openDesktop(app);
  return true;
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

export function createAutoLaunchLogWriter(logPath) {
  // The watcher runs under launchd, whose stdio nobody reads, so its own notices (including the
  // circuit-breaker warning) have to reach the same file the Launcher's stderr goes to.
  let fd;
  return (level, message) => {
    try {
      fd ??= openLaunchLog(logPath);
      appendFileSync(fd, `[${new Date().toISOString()}] auto-launch ${level}: ${message}\n`);
    } catch {
      // Logging must never break launching.
    }
  };
}

export function retryDelayForAttempt(attempt) {
  // Retrying a broken launch every few seconds burns CPU and hides the failure. Back off
  // exponentially and cap it so a permanently broken setup settles into a slow retry.
  const exponent = Math.max(0, attempt - 1);
  return Math.min(RETRY_INTERVAL_MS * 2 ** exponent, MAX_RETRY_INTERVAL_MS);
}

export function openLaunchLog(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  try {
    if (statSync(logPath).size >= MAX_LOG_BYTES) renameSync(logPath, `${logPath}.1`);
  } catch {
    // A missing log file is the normal first-run case.
  }
  const fd = openSync(logPath, "a", 0o600);
  // The mode argument only applies at creation, so tighten a pre-existing file too: renderer
  // exception text can quote conversation content.
  fchmodSync(fd, 0o600);
  return fd;
}

export async function launchManagedCodex(options, dependencies = {}) {
  const spawnImplementation = dependencies.spawn ?? spawn;
  const openLog = dependencies.openLog ?? openLaunchLog;
  // Synchronous on purpose: spawning must stay on this tick so callers that await the child's
  // "spawn" event cannot race the listener registration below.
  const logFd = openLog(options.logPath ?? DEFAULT_LOG_PATH);
  let child;
  try {
    child = spawnImplementation(options.launcher, launcherArguments(options), {
      cwd: options.root,
      env: {
        ...process.env,
        PATH: options.path,
      },
      detached: true,
      // The Launcher's stderr is inherited by the Desktop Controller, so discarding stdio here
      // silently drops every diagnostic line both of them emit — including renderer failures.
      stdio: ["ignore", logFd, logFd],
      windowsHide: false,
    });
  } finally {
    // The child owns its duplicated descriptors; release ours so repeated launches cannot leak.
    closeSync(logFd);
  }
  child.unref?.();
  await new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener?.("error", onError);
      child.on?.("error", () => {});
      resolve();
    };
    const onError = (error) => {
      child.removeListener?.("spawn", onSpawn);
      child.on?.("error", () => {});
      reject(error);
    };
    child.once?.("spawn", onSpawn);
    child.once?.("error", onError);
  });
  return child;
}

export async function checkAndMaybeLaunch(options, dependencies = {}) {
  const readProcesses = dependencies.processTable ?? processTable;
  const entries = await readProcesses();
  if (!desktopRootRunning(entries, options.desktopExecutable)) return "desktop-not-running";
  const descriptor = await (dependencies.readDescriptor ?? readDescriptor)(options.descriptorPath);
  const statePath = options.statePath ?? DEFAULT_STATE_PATH;
  const readState = dependencies.readState ?? readAutoLaunchState;
  const writeState = dependencies.writeState ?? writeAutoLaunchState;
  if (managedLauncherRunning(entries, descriptor, options.launcher)) {
    // Injection is confirmed. Forget earlier failures so the next one starts from scratch.
    const state = await readState(statePath);
    if (state.consecutiveLaunchFailures !== 0 || state.degradedUntil !== 0) {
      await writeState(statePath, { consecutiveLaunchFailures: 0, degradedUntil: 0 });
    }
    // A live launcher is not proof of a working integration. Report the Controller's own
    // functional verdict so "alive but broken" is visible instead of looking like all-clear.
    const health = await (dependencies.readHealth ?? readFunctionalHealth)(options.healthPath);
    if (
      health?.state === "degraded" &&
      Date.now() - health.lastProbeAt <= FUNCTIONAL_HEALTH_MAX_AGE_MS
    ) {
      return "managed-degraded";
    }
    return "already-managed";
  }
  if (anyLauncherRunning(entries, options.launcher)) return "already-launching";
  if (options.dryRun) return "would-launch";

  const state = await readState(statePath);
  const now = Date.now();
  // Degraded: the Desktop is already running as a plain app, which is the whole point. Stay
  // quiet until the retry window opens, so a broken bundle cannot restart the wedge loop.
  if (state.degradedUntil > now) return "degraded-idle";

  if (state.consecutiveLaunchFailures >= MAX_UNCONFIRMED_LAUNCHES) {
    // Circuit break. Repeated injection failures used to leave the Desktop wedged in a white
    // window while every tick relaunched codexhost into it. Give the user a working plain app.
    const recovered = await (dependencies.recoverDesktop ?? recoverUnmanagedDesktop)(
      options,
      entries,
      dependencies,
    );
    await writeState(statePath, {
      consecutiveLaunchFailures: state.consecutiveLaunchFailures + 1,
      degradedUntil: now + DEGRADED_RETRY_MS,
    });
    return recovered ? "degraded" : "degraded-without-recovery";
  }

  await (dependencies.launch ?? launchManagedCodex)(options, dependencies);
  await writeState(statePath, {
    consecutiveLaunchFailures: state.consecutiveLaunchFailures + 1,
    degradedUntil: 0,
  });
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
    logPath: DEFAULT_LOG_PATH,
    statePath: DEFAULT_STATE_PATH,
    healthPath: DEFAULT_HEALTH_PATH,
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
    else if (argument === "--log") options.logPath = value(index++, argument);
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
        "statePath",
        "healthPath",
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
  const logPath = options.logPath ?? DEFAULT_LOG_PATH;
  const writeLog = dependencies.writeLog ?? createAutoLaunchLogWriter(logPath);
  const logger =
    dependencies.log ??
    ((message) => {
      console.log(`[codexhost auto-launch] ${message}`);
      writeLog("info", message);
    });
  const errorLogger =
    dependencies.error ??
    ((message) => {
      console.error(`[codexhost auto-launch] ${message}`);
      writeLog("error", message);
    });
  let inFlight = null;
  let nextAttemptAt = 0;
  let consecutiveFailures = 0;
  let lastReportedResult = null;
  const tick = async () => {
    if (inFlight || Date.now() < nextAttemptAt) return;
    let result;
    try {
      result = await checkAndMaybeLaunch(options, dependencies);
      if (result === "launched") {
        consecutiveFailures = 0;
        nextAttemptAt = Date.now() + RETRY_INTERVAL_MS;
        logger("detected an unmanaged Codex Desktop; started codexhost");
      } else if (result === "would-launch") {
        logger("dry run: an unmanaged Codex Desktop would start codexhost");
      } else if (result === "managed-degraded") {
        // A live Controller whose integration is broken. Announce the transition once rather than
        // every tick, and do not relaunch: health is published by the Controller itself, so
        // launching another one cannot be inferred to help.
        if (lastReportedResult !== "managed-degraded") {
          errorLogger(
            "Codex Host controller is running but reports degraded functional health; external models may be unavailable in this window",
          );
        }
      } else if (result === "degraded") {
        consecutiveFailures = 0;
        // The retry window lives in the persisted state, not here: an in-memory backoff would
        // also block recovery after an operator clears that state.
        nextAttemptAt = Date.now() + RETRY_INTERVAL_MS;
        errorLogger(
          `Renderer injection failed ${MAX_UNCONFIRMED_LAUNCHES} times in a row; restarted Codex Desktop without codexhost and will retry injection in ${Math.round(DEGRADED_RETRY_MS / 60_000)} minutes`,
        );
      } else if (result === "degraded-without-recovery") {
        consecutiveFailures = 0;
        nextAttemptAt = Date.now() + RETRY_INTERVAL_MS;
        errorLogger(
          `Renderer injection failed ${MAX_UNCONFIRMED_LAUNCHES} times in a row and no .app bundle could be derived from '${options.desktopExecutable}'; pausing codexhost for ${Math.round(DEGRADED_RETRY_MS / 60_000)} minutes. Restart Codex Desktop manually if it is wedged.`,
        );
      }
    } catch (error) {
      result = "check-failed";
      consecutiveFailures += 1;
      const delay = retryDelayForAttempt(consecutiveFailures);
      nextAttemptAt = Date.now() + delay;
      errorLogger(
        `${error instanceof Error ? error.message : String(error)} (attempt ${consecutiveFailures}, retrying in ${Math.round(delay / 1000)}s)`,
      );
    }
    lastReportedResult = result;
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
