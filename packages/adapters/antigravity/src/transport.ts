import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

import {
  AntigravityExecutableError,
  DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,
  antigravitySessionInvocation,
  resolveAntigravityExecutable,
  resolveAntigravityProxyEnvironment,
} from "./command.js";

export type AntigravityTransportFaultKind =
  | "notInstalled"
  | "authenticationRequired"
  | "unavailable"
  | "protocolError"
  | "processExited"
  | "quotaExhausted";

export class AntigravityTransportError extends Error {
  readonly diagnostic: string | undefined;

  constructor(
    readonly kind: AntigravityTransportFaultKind,
    message: string,
    options?: ErrorOptions & { diagnostic?: string },
  ) {
    super(message, options);
    this.diagnostic = options?.diagnostic;
    this.name = "AntigravityTransportError";
  }
}

export interface AntigravityInitEvent {
  conversationId: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
}

export interface AntigravityStepUpdate {
  conversationId?: string;
  stepIndex?: number;
  state?: string;
  stepType?: string;
  textDelta?: string;
  text?: string;
  content?: string;
  message?: string;
  thinkingDelta?: string;
  toolName?: string;
  toolInfo?: Record<string, unknown>;
  durationSeconds?: number;
  usage?: unknown;
}

export interface AntigravityResultEvent {
  conversationId: string;
  status: string;
  response: string;
  numTurns: number;
  usage?: unknown;
  error?: string;
}

export interface AntigravityTransportOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  conversationId?: string;
  model?: string;
  effort?: string;
  /** Native AGY per-Turn ceiling; defaults to the adapter's 2-hour backstop. */
  printTimeout?: string;
  skipPermissions?: boolean;
  startupTimeoutMs?: number;
  /** @deprecated former single wall-clock cap; now an alias for `idleTimeoutMs`. */
  turnTimeoutMs?: number;
  /**
   * Resettable inactivity budget: a Turn stalls (and is rejected) only when no
   * stream activity arrives for this long. Each `step_update` refreshes it, so
   * a busy autonomous run (model streaming / tool activity) never trips it.
   * @default 30 minutes
   */
  idleTimeoutMs?: number;
  /**
   * Absolute overall ceiling for a single Turn. Pure backstop for a runaway
   * Turn that keeps emitting activity forever without yielding.
   * Set to `0` to disable this host-side backstop. The native AGY
   * `--print-timeout` remains an independent protection.
   * @default 2 hours
   */
  turnDeadlineMs?: number;
  closeTimeoutMs?: number;
  onFault?: (error: AntigravityTransportError) => void;
}

interface AntigravityActiveTurn {
  resolve(result: AntigravityResultEvent): void;
  reject(error: AntigravityTransportError): void;
  onStep(step: AntigravityStepUpdate): void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
/** Resettable inactivity budget for a genuinely silent Turn. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
/** Absolute per-Turn backstop; see `turnDeadlineMs`. */
const DEFAULT_TURN_DEADLINE_MS = 2 * 60 * 60_000;
/** Watchdog cadence for checking idle/deadline stalls. */
const WATCHDOG_INTERVAL_MS = 1_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/**
 * AGY reports an exhausted quota on stderr and then retries with backoff for as
 * long as `--print-timeout` allows, so the Turn would otherwise stay silent
 * until the idle watchdog fires.
 */
const QUOTA_EXHAUSTED_PATTERN =
  /RESOURCE_EXHAUSTED|Individual quota reached|quota (?:is )?(?:reached|exhausted)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyError(error: unknown, diagnostic?: string): AntigravityTransportError {
  if (error instanceof AntigravityTransportError) return error;
  if (error instanceof AntigravityExecutableError) {
    return new AntigravityTransportError("notInstalled", error.message, { cause: error });
  }
  const text = `${errorText(error)} ${diagnostic ?? ""}`;
  if (QUOTA_EXHAUSTED_PATTERN.test(text)) {
    return new AntigravityTransportError(
      "quotaExhausted",
      "Antigravity CLI quota is exhausted; switch accounts or wait for the quota to reset",
      { cause: error, ...(diagnostic ? { diagnostic } : {}) },
    );
  }
  if (/sign[ -]?in|authenticat|credential|login/iu.test(text)) {
    return new AntigravityTransportError(
      "authenticationRequired",
      "Antigravity CLI authentication is required; run an interactive 'agy' session first",
      { cause: error, ...(diagnostic ? { diagnostic } : {}) },
    );
  }
  return new AntigravityTransportError("unavailable", errorText(error), {
    cause: error,
    ...(diagnostic ? { diagnostic } : {}),
  });
}

function classifyExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  diagnostic?: string,
): AntigravityTransportError {
  const text = diagnostic ?? "";
  if (QUOTA_EXHAUSTED_PATTERN.test(text)) {
    return new AntigravityTransportError(
      "quotaExhausted",
      "Antigravity CLI quota is exhausted; switch accounts or wait for the quota to reset",
      diagnostic ? { diagnostic } : undefined,
    );
  }
  if (/sign[ -]?in|authenticat|credential|login/iu.test(text)) {
    return new AntigravityTransportError(
      "authenticationRequired",
      "Antigravity CLI authentication is required; run an interactive 'agy' session first",
      diagnostic ? { diagnostic } : undefined,
    );
  }
  return new AntigravityTransportError(
    "processExited",
    `Antigravity CLI exited before completing the Session (${signal ?? code ?? "unknown"})`,
    diagnostic ? { diagnostic } : undefined,
  );
}

function parseInit(payload: Record<string, unknown>): AntigravityInitEvent {
  if (!nonBlankString(payload.conversation_id) || !isRecord(payload.init)) {
    throw new AntigravityTransportError("protocolError", "Antigravity init event is invalid");
  }
  const init = payload.init;
  if (!nonBlankString(init.cwd)) {
    throw new AntigravityTransportError("protocolError", "Antigravity init event has no cwd");
  }
  return {
    conversationId: payload.conversation_id,
    cwd: init.cwd,
    ...(nonBlankString(init.model) ? { model: init.model } : {}),
    ...(nonBlankString(init.permission_mode) ? { permissionMode: init.permission_mode } : {}),
  };
}

function parseStep(payload: Record<string, unknown>): AntigravityStepUpdate {
  if (!isRecord(payload.step_update)) {
    throw new AntigravityTransportError(
      "protocolError",
      "Antigravity step_update event is invalid",
    );
  }
  const step = payload.step_update;
  return {
    ...(nonBlankString(step.conversation_id) ? { conversationId: step.conversation_id } : {}),
    ...(nonNegativeInteger(step.step_index) ? { stepIndex: step.step_index } : {}),
    ...(typeof step.state === "string" ? { state: step.state } : {}),
    ...(typeof step.step_type === "string" ? { stepType: step.step_type } : {}),
    ...(typeof step.text_delta === "string"
      ? { textDelta: step.text_delta }
      : typeof step.text === "string"
        ? { textDelta: step.text }
        : typeof step.content === "string"
          ? { textDelta: step.content }
          : typeof step.message === "string"
            ? { textDelta: step.message }
            : {}),
    ...(typeof step.text === "string" ? { text: step.text } : {}),
    ...(typeof step.content === "string" ? { content: step.content } : {}),
    ...(typeof step.message === "string" ? { message: step.message } : {}),
    ...(typeof step.thinking_delta === "string"
      ? { thinkingDelta: step.thinking_delta }
      : typeof step.thought === "string"
        ? { thinkingDelta: step.thought }
        : typeof step.thinking === "string"
          ? { thinkingDelta: step.thinking }
          : typeof step.reasoning === "string"
            ? { thinkingDelta: step.reasoning }
            : {}),
    ...(typeof step.tool_name === "string" ? { toolName: step.tool_name } : {}),
    ...(isRecord(step.tool_info) ? { toolInfo: step.tool_info } : {}),
    ...(typeof step.duration_seconds === "number"
      ? { durationSeconds: step.duration_seconds }
      : {}),
    ...(step.usage !== undefined ? { usage: step.usage } : {}),
  };
}

function parseResult(payload: Record<string, unknown>): AntigravityResultEvent {
  if (!isRecord(payload.result)) {
    throw new AntigravityTransportError("protocolError", "Antigravity result event is invalid");
  }
  const result = payload.result;
  if (!nonBlankString(result.conversation_id) || typeof result.status !== "string") {
    throw new AntigravityTransportError("protocolError", "Antigravity result envelope is invalid");
  }
  return {
    conversationId: result.conversation_id,
    status: result.status,
    response: typeof result.response === "string" ? result.response : "",
    numTurns:
      typeof result.num_turns === "number" &&
      Number.isSafeInteger(result.num_turns) &&
      result.num_turns >= 0
        ? result.num_turns
        : 0,
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(typeof result.error === "string" ? { error: result.error } : {}),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Send a signal to the whole Antigravity process group.
 *
 * Antigravity is spawned `detached`, so it owns its own session/process group.
 * A negative pid targets the entire group, which lets us tear down any helper
 * children (tool executions, browser drivers) the CLI forks mid-turn. Without
 * this those children survive as orphans with PPID=1.
 *
 * Antigravity's Go runtime swallows SIGINT and SIGTERM (they only trigger an
 * in-process graceful stop that blocks on network I/O), so SIGKILL is the only
 * signal it reliably obeys. Prefer the graceful signal for a short grace window,
 * then escalate to SIGKILL.
 */
export function signalAntigravityProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") throw error;
  }
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  signalAntigravityProcessGroup(child.pid, signal);
}

export class AntigravityCliTransport {
  readonly #options: AntigravityTransportOptions;
  readonly #startupTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #turnDeadlineMs: number;
  readonly #closeTimeoutMs: number;
  #child: ChildProcessWithoutNullStreams | null = null;
  #reader: Interface | null = null;
  #readerTask: Promise<void> | null = null;
  #exitPromise: Promise<void> | null = null;
  #resolveExit: (() => void) | null = null;
  #startPromise: Promise<AntigravityInitEvent> | null = null;
  #resolveStart: ((event: AntigravityInitEvent) => void) | null = null;
  #rejectStart: ((error: AntigravityTransportError) => void) | null = null;
  #activeTurn: AntigravityActiveTurn | null = null;
  #retiringChild: ChildProcessWithoutNullStreams | null = null;
  #lifecyclePromise: Promise<void> | null = null;
  #lastActivityAt: number | null = null;
  #watchdog: ReturnType<typeof setInterval> | null = null;
  #init: AntigravityInitEvent | null = null;
  #conversationId: string | undefined;
  #stderrTail = "";
  #logPath: string | null = null;
  #closed = false;
  #faultReported = false;

  constructor(options: AntigravityTransportOptions) {
    this.#options = options;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? options.turnTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#turnDeadlineMs = options.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#conversationId = options.conversationId;
  }

  get conversationId(): string | undefined {
    return this.#conversationId;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  /**
   * Path of the `--log-file` handed to the CLI, when one was created. The
   * Language Server HTTPS port is discovered from this file (context usage).
   */
  get logPath(): string | null {
    return this.#logPath;
  }

  async start(): Promise<AntigravityInitEvent> {
    await this.#waitForLifecycle();
    if (this.#closed) {
      throw new AntigravityTransportError("unavailable", "Antigravity Session is closed");
    }
    if (this.#init && this.#child) return this.#init;
    if (!this.#startPromise) {
      this.#startPromise = new Promise<AntigravityInitEvent>((resolve, reject) => {
        this.#resolveStart = resolve;
        this.#rejectStart = reject;
        this.#spawn();
      }).finally(() => {
        this.#startPromise = null;
        this.#resolveStart = null;
        this.#rejectStart = null;
      });
    }
    try {
      return await this.#withTimeout(this.#startPromise, this.#startupTimeoutMs, "Session startup");
    } catch (error) {
      // A live spawn may still be initializing (proxy, auth, resume). Kill only
      // when nothing is left to join; otherwise the next start() waits on it.
      if (this.#closed || !this.#child) {
        await this.#terminate("SIGTERM").catch(() => undefined);
      }
      throw error;
    }
  }

  get effort(): string | undefined {
    return this.#options.effort;
  }

  async setModel(model: string, effort?: string): Promise<AntigravityInitEvent> {
    await this.#waitForLifecycle();
    if (this.#closed) {
      throw new AntigravityTransportError("unavailable", "Antigravity Session is closed");
    }
    if (this.#activeTurn) {
      throw new AntigravityTransportError(
        "unavailable",
        "Antigravity Session cannot change Model during an active Turn",
      );
    }
    this.#options.model = model;
    if (arguments.length > 1) {
      if (effort === undefined) {
        delete this.#options.effort;
      } else {
        this.#options.effort = effort;
      }
    }
    this.#init = null;
    this.#faultReported = false;
    await this.#terminate("SIGTERM");
    return this.start();
  }

  async setEffort(effort: string | undefined): Promise<AntigravityInitEvent> {
    await this.#waitForLifecycle();
    if (this.#closed) {
      throw new AntigravityTransportError("unavailable", "Antigravity Session is closed");
    }
    if (this.#activeTurn) {
      throw new AntigravityTransportError(
        "unavailable",
        "Antigravity Session cannot change Thinking effort during an active Turn",
      );
    }
    if (effort === undefined) {
      // Clearing the effort lets the CLI apply its own default on restart.
      delete this.#options.effort;
    } else {
      this.#options.effort = effort;
    }
    this.#init = null;
    this.#faultReported = false;
    await this.#terminate("SIGTERM");
    return this.start();
  }

  async setPermissionMode(skipPermissions: boolean): Promise<AntigravityInitEvent> {
    await this.#waitForLifecycle();
    if (this.#closed) {
      throw new AntigravityTransportError("unavailable", "Antigravity Session is closed");
    }
    if (this.#activeTurn) {
      throw new AntigravityTransportError(
        "unavailable",
        "Antigravity Session cannot change Permission Mode during an active Turn",
      );
    }
    this.#options.skipPermissions = skipPermissions;
    this.#init = null;
    this.#faultReported = false;
    await this.#terminate("SIGTERM");
    return this.start();
  }

  async runTurn(
    text: string,
    onStep: (step: AntigravityStepUpdate) => void,
  ): Promise<AntigravityResultEvent> {
    await this.start();
    if (this.#activeTurn) {
      throw new AntigravityTransportError(
        "unavailable",
        "Antigravity Session already has an active Turn",
      );
    }
    const child = this.#child;
    if (!child)
      throw new AntigravityTransportError("processExited", "Antigravity CLI is not running");

    const result = new Promise<AntigravityResultEvent>((resolve, reject) => {
      this.#activeTurn = {
        resolve,
        reject,
        onStep,
      };
    });
    try {
      const started = Date.now();
      this.#lastActivityAt = started;
      // Activity-aware watchdog: a busy Turn (streaming thinking / tool deltas)
      // refreshes #lastActivityAt on every step_update, so only genuine silence
      // trips the idle branch. The absolute deadline is a pure backstop for a
      // runaway Turn that streams forever without ever yielding a result.
      this.#watchdog = setInterval(() => {
        this.#checkWatchdog(started);
      }, WATCHDOG_INTERVAL_MS);

      child.stdin.write(
        `${JSON.stringify({ event: "user", message: { content: text } })}\n`,
        "utf8",
      );
      const completed = await result;
      return completed;
    } catch (error) {
      // Free the CLI process only when we decided to stop the Turn (the idle or
      // absolute-deadline watchdog fired). Other rejections (user cancel, process
      // exit, protocol errors) retain their original behaviour and don't kill the
      // transport here.
      if (
        error instanceof AntigravityTransportError &&
        error.message.includes("Turn execution timed out")
      ) {
        await this.#terminate("SIGTERM");
      }
      throw error instanceof AntigravityTransportError
        ? error
        : classifyError(error, this.#stderrTail);
    } finally {
      this.#stopWatchdog();
      this.#lastActivityAt = null;
      this.#activeTurn = null;
    }
  }

  /** True if the current Turn has seen no stream activity for longer than the idle budget. */
  #isIdleStalled(started: number): boolean {
    const last = this.#lastActivityAt ?? started;
    return Date.now() - last > this.#idleTimeoutMs;
  }

  /** True if the current Turn has exceeded the absolute per-Turn ceiling. */
  #isPastDeadline(started: number): boolean {
    return this.#turnDeadlineMs > 0 && Date.now() - started > this.#turnDeadlineMs;
  }

  /** Called on every streamed step to mark the Turn as still alive. */
  #pokeActivity(): void {
    this.#lastActivityAt = Date.now();
  }

  #stopWatchdog(): void {
    if (this.#watchdog) {
      clearInterval(this.#watchdog);
      this.#watchdog = null;
    }
  }

  /** Reject an active Turn on a stall, describing which budget was exceeded. */
  #checkWatchdog(started: number): void {
    const active = this.#activeTurn;
    if (!active) return;
    if (!this.#isPastDeadline(started) && !this.#isIdleStalled(started)) return;
    const detail = this.#isPastDeadline(started)
      ? `exceeded its absolute ${this.#turnDeadlineMs / 60_000}-minute ceiling`
      : `had no stream activity for ${this.#idleTimeoutMs / 60_000} minutes`;
    // Stop the watchdog first so it doesn't re-fire before the promise settles.
    this.#stopWatchdog();
    active.reject(
      new AntigravityTransportError(
        "unavailable",
        `Antigravity Turn execution timed out (${detail}). ` +
          "If the task was legitimately working but silent for longer than this window " +
          "(e.g. an unusually long tool or test), raise the Antigravity idle/deadline budget " +
          "(CODEXHOST_ANTIGRAVITY_IDLE_TIMEOUT_MS / CODEXHOST_ANTIGRAVITY_DEADLINE_MS).",
      ),
    );
  }

  async cancel(): Promise<void> {
    // Antigravity swallows SIGINT/SIGTERM; #terminate escalates to SIGKILL
    // after the grace window so a network-hung Turn cannot hang the Session.
    await this.#terminate("SIGINT");
  }

  /**
   * Stop the native AGY process without closing the logical Session.
   *
   * The conversation ID and launch options stay on this transport, so the next
   * `start()` creates a fresh stream-json process and resumes the same native
   * conversation. This is intentionally different from `close()`, which is
   * permanent and is used when a Thread is deleted or the Host exits.
   */
  async hibernate(): Promise<void> {
    if (this.#closed) return;
    if (this.#activeTurn) return;
    const existing = this.#lifecyclePromise;
    if (existing) return existing;

    const child = this.#child;
    if (!child) {
      this.#init = null;
      return;
    }
    const operation = (async () => {
      this.#retiringChild = child;
      try {
        // Ending stdin gives AGY a graceful exit opportunity; #terminate then
        // bounds the wait and kills the complete detached process group if the
        // CLI or one of its helpers remains blocked.
        try {
          child.stdin.end();
        } catch {
          // The process-group termination below is still authoritative.
        }
        await this.#terminate("SIGTERM");
      } finally {
        this.#init = null;
        if (this.#retiringChild === child) this.#retiringChild = null;
      }
    })();
    this.#lifecyclePromise = operation;
    try {
      await operation;
    } finally {
      if (this.#lifecyclePromise === operation) this.#lifecyclePromise = null;
    }
  }

  async close(): Promise<void> {
    await this.#waitForLifecycle();
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#activeTurn;
    if (active) {
      active.reject(
        new AntigravityTransportError("processExited", "Antigravity Session was closed"),
      );
      this.#activeTurn = null;
    }
    const child = this.#child;
    if (!child) return;
    child.stdin.end();
    await this.#waitForExit(child);
    if (this.#child === child) {
      // Tear down the whole group: graceful first, then force SIGKILL.
      signalProcessTree(child, "SIGTERM");
      await this.#waitForExit(child);
      if (this.#child === child) {
        signalProcessTree(child, "SIGKILL");
        await this.#waitForExit(child);
      }
    }
    this.#reader?.close();
  }

  #spawn(): void {
    this.#faultReported = false;
    let executable: string;
    try {
      executable = resolveAntigravityExecutable({
        ...(this.#options.command ? { command: this.#options.command } : {}),
        ...(this.#options.environment ? { environment: this.#options.environment } : {}),
      });
    } catch (error) {
      const normalized = classifyError(error, this.#stderrTail);
      this.#rejectStart?.(normalized);
      return;
    }
    const environment = resolveAntigravityProxyEnvironment(
      this.#options.environment ?? process.env,
    );
    const logPath = path.join(os.tmpdir(), `codexhost-antigravity-${randomUUID()}.log`);
    this.#logPath = logPath;
    const invocation = antigravitySessionInvocation(
      executable,
      {
        cwd: this.#options.cwd,
        ...(this.#conversationId ? { conversationId: this.#conversationId } : {}),
        ...(this.#options.model ? { model: this.#options.model } : {}),
        ...(this.#options.effort ? { effort: this.#options.effort } : {}),
        printTimeout: this.#options.printTimeout ?? DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,
        skipPermissions: this.#options.skipPermissions === true,
        logFile: logPath,
      },
      environment,
    );
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(invocation.command, invocation.arguments, {
        cwd: this.#options.cwd,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (error) {
      this.#rejectStart?.(classifyError(error, this.#stderrTail));
      return;
    }
    this.#child = child;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk}`);
      this.#failTurnOnQuotaExhaustion(chunk);
    });
    child.once("error", (error) => this.#handleProcessError(error, child));
    child.once("exit", (code, signal) => this.#handleProcessExit(child, code, signal));
    const reader = createInterface({ input: child.stdout });
    this.#reader = reader;
    this.#readerTask = this.#consume(reader, child).catch((error: unknown) => {
      this.#handleProcessError(error, child);
    });
  }

  async #consume(reader: Interface, child: ChildProcessWithoutNullStreams): Promise<void> {
    for await (const rawLine of reader) {
      const line = String(rawLine).trim();
      if (!line) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        // agy's stream-json mode can print human-readable diagnostics (e.g.
        // "Error: authentication required...") to stdout before any NDJSON;
        // keep them for exit classification instead of killing the Session.
        this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}\n${line}`);
        continue;
      }
      if (!isRecord(payload) || typeof payload.event !== "string") {
        this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}\n${line}`);
        continue;
      }
      try {
        if (payload.event === "init") {
          const init = parseInit(payload);
          this.#conversationId = init.conversationId;
          this.#init = init;
          this.#resolveStart?.(init);
        } else if (payload.event === "step_update") {
          this.#pokeActivity();
          this.#activeTurn?.onStep(parseStep(payload));
        } else if (payload.event === "result") {
          const active = this.#activeTurn;
          if (!active) {
            // A result without an active Turn (e.g. an auth failure before any
            // init) is not a protocol violation; the exit classification below
            // surfaces the real diagnostic from the collected tail.
            this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}\n${line}`);
            continue;
          }
          active.resolve(parseResult(payload));
        }
      } catch (error) {
        this.#handleProcessError(error, child);
      }
    }
  }

  /**
   * Fail the active Turn as soon as AGY reports an exhausted quota. AGY keeps
   * retrying on its own for up to `--print-timeout`, which otherwise leaves the
   * user staring at a spinning Turn with no error and no result.
   */
  #failTurnOnQuotaExhaustion(chunk: string): void {
    if (!this.#activeTurn || !QUOTA_EXHAUSTED_PATTERN.test(chunk)) return;
    const normalized = new AntigravityTransportError(
      "quotaExhausted",
      "Antigravity CLI quota is exhausted; switch accounts or wait for the quota to reset",
      { diagnostic: this.#stderrTail },
    );
    const active = this.#activeTurn;
    // Clear the reference before rejecting. The native process may emit an
    // exit/error synchronously while it is being terminated; a stale active
    // turn would otherwise be rejected a second time and retain the Session.
    this.#activeTurn = null;
    active.reject(normalized);
    this.#reportFault(normalized);
    void this.#terminate("SIGTERM").catch(() => undefined);
  }

  #handleProcessError(error: unknown, child: ChildProcessWithoutNullStreams): void {
    if (this.#child !== child && this.#child !== null) return;
    const normalized = classifyError(error, this.#stderrTail);
    this.#rejectStart?.(normalized);
    this.#activeTurn?.reject(normalized);
    this.#reportFault(normalized);
  }

  #handleProcessExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.#child !== child) return;
    this.#child = null;
    this.#reader = null;
    this.#readerTask = null;
    this.#resolveExit?.();
    this.#resolveExit = null;
    this.#exitPromise = null;
    if (this.#logPath) {
      const logPath = this.#logPath;
      this.#logPath = null;
      void unlink(logPath).catch(() => undefined);
    }
    const normalized = classifyExit(code, signal, this.#stderrTail);
    this.#rejectStart?.(normalized);
    this.#activeTurn?.reject(normalized);
    if (
      !this.#closed &&
      this.#retiringChild !== child &&
      signal !== "SIGINT" &&
      signal !== "SIGTERM"
    ) {
      this.#reportFault(normalized);
    }
  }

  #reportFault(error: AntigravityTransportError): void {
    if (this.#faultReported || this.#closed) return;
    this.#faultReported = true;
    this.#options.onFault?.(error);
  }

  async #waitForLifecycle(): Promise<void> {
    const lifecycle = this.#lifecyclePromise;
    if (lifecycle) await lifecycle;
  }

  async #terminate(signal: NodeJS.Signals): Promise<void> {
    const child = this.#child;
    if (!child) return;
    // Signal the whole process group so helper children are torn down too.
    signalProcessTree(child, signal);
    await this.#waitForExit(child);
    if (this.#child === child) {
      // Antigravity ignores SIGINT/SIGTERM when blocked on network I/O; force
      // SIGKILL after the grace window so the Turn/Termination cannot hang.
      signalProcessTree(child, "SIGKILL");
      await this.#waitForExit(child);
    }
  }

  async #waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    const exitPromise = this.#exitPromise;
    if (!exitPromise || this.#child !== child) return;
    await Promise.race([exitPromise, delay(this.#closeTimeoutMs)]);
  }

  async #withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AntigravityTransportError("unavailable", `Antigravity ${operation} timed out`),
              ),
            milliseconds,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
