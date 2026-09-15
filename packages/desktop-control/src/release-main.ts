import { parseDesktopControllerArguments, runDesktopController } from "./production-controller.js";

const abort = new AbortController();
let stopping = false;
let forceExitTimer: NodeJS.Timeout | undefined;

const stop = (): void => {
  if (stopping) {
    process.exit(1);
  }
  stopping = true;
  abort.abort();
  forceExitTimer = setTimeout(() => {
    process.exit(0);
  }, 4_000);
  forceExitTimer.unref?.();
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const initialParentPid = process.ppid;
if (initialParentPid > 1) {
  const parentWatchdog = setInterval(() => {
    if (process.ppid !== initialParentPid) {
      stop();
      return;
    }
    try {
      process.kill(initialParentPid, 0);
    } catch {
      stop();
    }
  }, 2_000);
  parentWatchdog.unref?.();
}

try {
  await runDesktopController(parseDesktopControllerArguments(process.argv.slice(2)), abort.signal);
  if (forceExitTimer) clearTimeout(forceExitTimer);
  process.exit(0);
} catch (error) {
  if (forceExitTimer) clearTimeout(forceExitTimer);
  console.error(
    `codexhost Desktop Controller: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
