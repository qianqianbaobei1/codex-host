import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  HarnessOutputChannel,
  parseHostUsage,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostFileChangeItem,
  type HostItem,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostEvent,
  type HostReasoningItem,
  type HostToolExecutionItem,
  type HostToolOutput,
  type HostThreadSnapshot,
  type HostUsage,
  type InspectHarnessInput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
  type ResumeSessionInput,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessInspectionSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type JsonValue,
  type NativeSessionRef,
  type AccountCreditsSnapshot,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";

import {
  antigravityModelsInvocation,
  AntigravityExecutableError,
  resolveAntigravityExecutable,
  resolveAntigravityProxyEnvironment,
} from "./command.js";
import { readAntigravityCreditsSync } from "./credits.js";
import { pollAntigravityContextUsage } from "./context-usage.js";
import { projectAntigravityFileChange } from "./file-change.js";
import {
  loadAntigravitySnapshot,
  mergeAntigravityHistoryTurns,
} from "./history.js";
import { AntigravityHistory } from "./history-sidecar.js";
import { AntigravitySessionLedger, type AntigravityLedgerTurn } from "./ledger.js";
import { readSelectedPluginSkillPrompt } from "./plugin-bridge.js";
import {
  decodeAntigravityModelRef,
  encodeAntigravityModelRef,
  modelBySlug,
  normalizeAntigravityModelCatalog,
  parseAntigravityModelsOutput,
  antigravityAvailableThinkingOptions,
  modelAcceptsThinking,
  type AntigravityNativeModel,
} from "./model-catalog.js";
import {
  ANTIGRAVITY_PERMISSION_MODE_CATALOG,
  decodeAntigravityPermissionModeId,
  type AntigravityPermissionMode,
} from "./permission-modes.js";
import { fetchAntigravityQuota } from "./quota.js";
import {
  ANTIGRAVITY_ACCOUNT_ID_ENV,
  ANTIGRAVITY_THREAD_ID_ENV,
  applyAntigravityAccountEnvironment,
  antigravityRealHome,
  type AntigravityAccount,
  type AntigravityAccountsLoad,
} from "./accounts.js";
import { antigravityToolErrorMessage, isAntigravityPermissionDenial } from "./stream-events.js";
import { parseToolArgs } from "./transcript.js";
import {
  AntigravityCliTransport,
  AntigravityTransportError,
  signalAntigravityProcessGroup,
  type AntigravityInitEvent,
  type AntigravityResultEvent,
  type AntigravityStepUpdate,
  type AntigravityTransportOptions,
} from "./transport.js";

export interface AntigravityAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  /** Optional multi-account overlay; omitted means legacy single-account mode. */
  accounts?: AntigravityAccountsLoad;
  startupTimeoutMs?: number;
  turnTimeoutMs?: number;
  idleTimeoutMs?: number;
  turnDeadlineMs?: number;
  /** How long an unused logical Session may keep its native process warm. */
  sessionIdleTimeoutMs?: number;
  closeTimeoutMs?: number;
  printTimeout?: string;
  toolOutputLimit?: number;
}

export interface AntigravityModelsResult {
  stdout: string;
  stderr: string;
}

export interface AntigravityAdapterDependencies {
  createTransport(options: AntigravityTransportOptions): AntigravityCliTransportLike;
  listModels(input: {
    cwd: string;
    command?: string;
    environment: NodeJS.ProcessEnv;
  }): Promise<AntigravityModelsResult>;
}

export interface AntigravityCliTransportLike {
  readonly conversationId: string | undefined;
  readonly effort?: string | undefined;
  readonly stderrTail?: string;
  /** Path of the CLI `--log-file` when one is active (context-usage discovery). */
  readonly logPath: string | null;
  start(): Promise<AntigravityInitEvent>;
  setModel(model: string, effort?: string): Promise<AntigravityInitEvent>;
  setEffort(effort: string | undefined): Promise<AntigravityInitEvent>;
  setPermissionMode(skipPermissions: boolean): Promise<AntigravityInitEvent>;
  runTurn(
    text: string,
    onStep: (step: AntigravityStepUpdate) => void,
  ): Promise<AntigravityResultEvent>;
  cancel(): Promise<void>;
  /** Stop the native process while keeping this logical Session restartable. */
  hibernate?(): Promise<void>;
  close(): Promise<void>;
}

const antigravityHarnessId: HarnessId = harnessIdSchema.parse("antigravity");
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;
const DEFAULT_MODELS_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
// Quota is telemetry; it must not compete with Session startup or every open.
const CREDITS_REFRESH_COOLDOWN_MS = 60_000;
// Do not turn an upstream auth/network failure into a probe storm. An explicit
// refresh still bypasses this window immediately after login or recovery.
const INSPECTION_FAILURE_COOLDOWN_MS = 15_000;
/** After a failed context probe, skip further probes on the same log for a while. */
const CONTEXT_PROBE_BACKOFF_MS = 60_000;
const PERSISTED_INSPECTION_VERSION = 1;
const PERSISTED_INSPECTION_MAX_AGE_MS = 6 * 60 * 60_000;

function processHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForProbeExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (processHasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    timer = setTimeout(finish, timeoutMs);
  });
}

async function terminateProbe(child: ChildProcess): Promise<void> {
  if (processHasExited(child)) return;
  signalAntigravityProcessGroup(child.pid, "SIGTERM");
  await waitForProbeExit(child, 2_000);
  if (!processHasExited(child)) {
    signalAntigravityProcessGroup(child.pid, "SIGKILL");
    await waitForProbeExit(child, 2_000);
  }
}

const ANTIGRAVITY_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: false, readTranscript: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const LEGACY_ACCOUNT_KEY = "legacy";

/** Tag the routed Session so every downstream `#environment()` call resolves the same account. */
function withAntigravityAccountMarker<T extends OpenSessionInput>(input: T, accountId: string): T {
  return {
    ...input,
    environment: { ...(input.environment ?? {}), [ANTIGRAVITY_ACCOUNT_ID_ENV]: accountId },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function normalizeError(
  error: unknown,
  fallback: HarnessError["code"],
  stderrTail?: string,
): HarnessError {
  if (error instanceof AntigravityTransportError) {
    return {
      code: error.kind,
      message: error.message,
      retryable: error.kind === "unavailable" || error.kind === "processExited",
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
      ...(stderrTail && !error.diagnostic ? { stderrTail } : {}),
    };
  }
  if (error instanceof AntigravityExecutableError) {
    return { code: "notInstalled", message: error.message, retryable: false };
  }
  const msg = errorMessage(error);
  const textToCheck = `${msg} ${stderrTail ?? ""}`;
  if (/sign[ -]?in|authenticat|credential|login/iu.test(textToCheck)) {
    return {
      code: "authenticationRequired",
      message: msg,
      retryable: false,
      ...(stderrTail ? { stderrTail } : {}),
    };
  }
  return {
    code: fallback,
    message: msg,
    retryable: fallback === "unavailable" || fallback === "nativeFailure",
    ...(stderrTail ? { stderrTail } : {}),
  };
}

function harnessErrorFromInspection(
  error: Extract<HarnessInspection, { status: "notInstalled" | "unavailable" | "error" }>["error"],
): HarnessError {
  const codes: HarnessError["code"][] = [
    "notInstalled",
    "unavailable",
    "authenticationRequired",
    "sessionNotFound",
    "sessionBusy",
    "checkpointNotFound",
    "unsupported",
    "invalidRequest",
    "invalidState",
    "protocolError",
    "processExited",
    "nativeFailure",
    "internalError",
  ];
  const code = codes.includes(error.code as HarnessError["code"])
    ? (error.code as HarnessError["code"])
    : "unavailable";
  return {
    code,
    message: error.message,
    retryable: error.retryable,
    ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
  };
}

function errorFromResult(result: AntigravityResultEvent): HarnessError {
  const message = result.error || `Antigravity Turn ended with status ${result.status}`;
  const authentication = /sign[ -]?in|authenticat|credential|login/iu.test(message);
  return {
    code: authentication ? "authenticationRequired" : "nativeFailure",
    message,
    retryable: false,
  };
}

function modelSlugFromLocator(ref: NativeSessionRef): {
  model?: string;
  effort?: HarnessThinkingOptionId;
  skipPermissions: boolean;
} {
  // New and legacy refs without an explicit permission bit follow the current
  // Antigravity default: the Host runs unattended. An explicit `false` stays
  // respected for a user who deliberately chose configured permissions.
  if (!isRecord(ref.locator)) return { skipPermissions: true };
  if (ref.locator.model !== undefined && !nonBlankString(ref.locator.model)) {
    throw new Error("Antigravity Native Session locator has an invalid Model slug");
  }
  const parsedEffort =
    ref.locator.effort !== undefined
      ? harnessThinkingOptionIdSchema.safeParse(ref.locator.effort)
      : null;
  if (parsedEffort && !parsedEffort.success) {
    throw new Error("Antigravity Native Session locator has an invalid Thinking option");
  }
  if (
    ref.locator.skipPermissions !== undefined &&
    typeof ref.locator.skipPermissions !== "boolean"
  ) {
    throw new Error("Antigravity Native Session locator has an invalid permission flag");
  }
  return {
    ...(typeof ref.locator.model === "string" ? { model: ref.locator.model } : {}),
    ...(parsedEffort?.success ? { effort: parsedEffort.data } : {}),
    skipPermissions: ref.locator.skipPermissions !== false,
  };
}

function sessionState(
  init: AntigravityInitEvent,
  model: AntigravityNativeModel | undefined,
  modelSlug: string | undefined,
  thinkingOptionId: HarnessThinkingOptionId | undefined,
  skipPermissions: boolean,
): HarnessSessionState {
  if (!nonBlankString(init.conversationId)) {
    throw new AntigravityTransportError(
      "protocolError",
      "Antigravity Session has no conversation ID",
    );
  }
  const ref = nativeSessionRefSchema.parse({
    harnessId: antigravityHarnessId,
    nativeSessionId: init.conversationId,
    locator: {
      ...(modelSlug ? { model: modelSlug } : {}),
      ...(thinkingOptionId ? { effort: thinkingOptionId } : {}),
      skipPermissions,
    },
    formatVersion: 1,
  });
  const availableThinkingOptions = antigravityAvailableThinkingOptions(model);
  return {
    nativeRef: ref,
    ...(modelSlug ? { effectiveModel: encodeAntigravityModelRef(modelSlug) } : {}),
    ...(thinkingOptionId ? { effectiveThinkingOptionId: thinkingOptionId } : {}),
    ...(availableThinkingOptions.length > 0
      ? { availableThinkingOptions: [...availableThinkingOptions] }
      : {}),
  };
}

function usageFromResult(value: unknown): HostUsage | null {
  if (!isRecord(value)) return null;
  const usage: Record<string, number> = {};
  const fields: Array<[string, keyof HostUsage]> = [
    ["input_tokens", "inputTokens"],
    ["output_tokens", "outputTokens"],
    ["thinking_tokens", "reasoningOutputTokens"],
    ["cache_read_tokens", "cachedInputTokens"],
    ["total_tokens", "totalTokens"],
  ];
  for (const [source, target] of fields) {
    if (nonNegativeInteger(value[source])) usage[target] = value[source];
  }
  if (Object.keys(usage).length === 0) return null;
  try {
    return parseHostUsage(usage);
  } catch {
    return null;
  }
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function boundedToolOutput(value: unknown, limit: number): HostToolOutput | undefined {
  const text = textFromValue(value);
  if (!text) return undefined;
  const truncated = text.length > limit;
  return {
    content: [{ type: "text", text: truncated ? text.slice(0, limit) : text }],
    ...(truncated ? { truncated: true } : {}),
  };
}

function stepToolArguments(step: AntigravityStepUpdate): JsonValue {
  const candidate = step.toolInfo?.parameters ?? step.toolInfo?.arguments ?? {};
  const parsed = jsonValueSchema.safeParse(candidate);
  return parsed.success ? parsed.data : {};
}

function stepToolOutput(step: AntigravityStepUpdate): unknown {
  return step.toolInfo?.output ?? step.toolInfo?.result ?? step.toolInfo?.error;
}

function isSuccessfulStatus(status: string): boolean {
  return status === "SUCCESS";
}

function isCancelledStatus(status: string): boolean {
  return status === "CANCELED" || status === "CANCELLED" || status === "INTERRUPTED";
}

interface ActiveTurn {
  command: TurnStartCommand;
  text: string;
  agent: HostAgentMessageItem | null;
  agentText: string;
  reasoning: HostReasoningItem | null;
  tools: Map<string, { item: HostToolExecutionItem; output: string }>;
  completedItems: HostItemSnapshot[];
  /** First permission denial seen this Turn (tool error shape), kept to explain an empty result. */
  permissionDenial: string | null;
  cancellationRequested: boolean;
}

class AntigravityHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = antigravityHarnessId;
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #models: readonly AntigravityNativeModel[];
  readonly #ledger: AntigravitySessionLedger;
  readonly #toolOutputLimit: number;
  readonly #sessionIdleTimeoutMs: number;
  readonly #history: AntigravityHistory | null;
  #transport: AntigravityCliTransportLike;
  #state: HarnessSessionState;
  #permissionMode: AntigravityPermissionMode;
  #nativePermissionMode: string | null = null;
  #active: ActiveTurn | null = null;
  #configuring = false;
  #closed = false;
  #historyRequired: number;
  #sessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
  #sessionActivityGeneration = 0;
  /** Back-off bookkeeping for the Language Server context probe. */
  #contextProbeLogPath: string | null = null;
  #contextProbeFailedAt = 0;

  constructor(input: {
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    models: readonly AntigravityNativeModel[];
    transport: AntigravityCliTransportLike;
    initialState: HarnessSessionState;
    ledger: AntigravitySessionLedger;
    history: AntigravityHistory | null;
    permissionMode: AntigravityPermissionMode;
    nativePermissionMode?: string | null;
    historyRequired?: number;
    toolOutputLimit: number;
    sessionIdleTimeoutMs?: number;
  }) {
    this.#cwd = input.cwd;
    this.#environment = input.environment ?? process.env;
    this.#models = input.models;
    this.#transport = input.transport;
    this.initialState = input.initialState;
    this.#state = input.initialState;
    this.#ledger = input.ledger;
    this.#history = input.history;
    this.#permissionMode = input.permissionMode;
    this.#nativePermissionMode = input.nativePermissionMode ?? null;
    this.#historyRequired = input.historyRequired ?? 0;
    this.#toolOutputLimit = input.toolOutputLimit;
    this.#sessionIdleTimeoutMs = input.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    this.outputs = this.#channel.outputs;
    this.#armSessionIdleTimer();
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Session is closed") };
    try {
      const history = this.#history;
      const sidecarTurns = history?.snapshot() ?? [];
      let turns: HostThreadSnapshot["turns"];
      if (sidecarTurns.length > 0 && sidecarTurns.length >= this.#historyRequired) {
        // The sidecar already covers everything the Host recorded; reading
        // Native history here could not add Turns the Host never saw.
        turns = sidecarTurns;
      }
      else {
        // Native transcript/ledger is authoritative and may contain Turns that
        // predate or postdate the sidecar; merge instead of shadowing it.
        const snapshot = await loadAntigravitySnapshot(this.#conversationId(), this.#state, {
          cwd: this.#cwd,
          environment: this.#environment,
          fallbackLedger: () => this.#ledger.read(),
        });
        turns = mergeAntigravityHistoryTurns(snapshot?.turns ?? [], sidecarTurns);
      }
      if (turns.length < this.#historyRequired) {
        const conversationId = this.#conversationId();
        const existingKeys = new Set(turns.map((t) => t.nativeTurnRef.nativeTurnKey));
        for (let i = turns.length + 1; i <= this.#historyRequired; i++) {
          const nativeTurnKey = `${conversationId}:turn:${i}`;
          if (!existingKeys.has(nativeTurnKey)) {
            turns.push({
              nativeTurnRef: nativeTurnRefSchema.parse({
                harnessId: antigravityHarnessId,
                nativeSessionId: conversationId,
                nativeTurnKey,
                formatVersion: 1,
              }),
              input: [],
              items: [],
              outcome: {
                status: "unknown",
                reason: "Antigravity Turn details were not recorded",
              },
            });
          }
        }
      }
      return { ok: true, value: { turns, state: this.#state } };
    } catch (error) {
      return { ok: false, error: normalizeError(error, "protocolError") };
    }
  }

  async execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  async execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  async execute(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>>;
  async execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  async execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  async execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command:
      | TurnStartCommand
      | TurnCancelCommand
      | InteractionRespondCommand
      | ModelSelectCommand
      | ThinkingSelectCommand
      | PermissionModeSelectCommand,
  ): Promise<HarnessResult<unknown>> {
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Session is closed") };
    switch (command.type) {
      case "turn.start":
        return this.#startTurn(command);
      case "turn.cancel":
        return this.#cancelTurn(command);
      case "model.select":
        return this.#selectModel(command);
      case "thinking.select":
        return this.#selectThinking(command);
      case "permissionMode.select":
        return this.#selectPermissionMode(command);
      case "interaction.respond":
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "Antigravity CLI headless mode has no interactive Host prompts",
            retryable: false,
          },
        };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#clearSessionIdleTimer();
    this.#closed = true;
    if (this.#active) {
      this.#active.cancellationRequested = true;
      this.#active = null;
    }
    await this.#transport.close().catch(() => undefined);
    await this.#history?.flush().catch(() => undefined);
    this.#channel.end();
  }

  #startTurn(command: TurnStartCommand): HarnessResult<TurnStartAccepted> {
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Antigravity Session already has an active operation",
          retryable: true,
        },
      };
    }
    const text = command.input.map(({ text: input }) => input).join("");
    if (!text.trim()) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Antigravity Turn must not be empty",
          retryable: false,
        },
      };
    }
    this.#touchSessionActivity();
    const active: ActiveTurn = {
      command,
      text,
      agent: null,
      agentText: "",
      reasoning: null,
      tools: new Map(),
      completedItems: [],
      permissionDenial: null,
      cancellationRequested: false,
    };
    this.#active = active;
    this.#event({ type: "turn.started", turnId: command.turnId });
    void this.#runTurn(active);
    return { ok: true, value: { turnId: command.turnId } };
  }

  async #runTurn(active: ActiveTurn): Promise<void> {
    let result: AntigravityResultEvent | null = null;
    try {
      const prompt = await readSelectedPluginSkillPrompt(
        active.text,
        this.#environment,
        this.#cwd,
      );
      result = await this.#transport.runTurn(prompt, (step) => this.#handleStep(active, step));
      if (result.conversationId !== this.#conversationId()) {
        throw new AntigravityTransportError(
          "protocolError",
          "Antigravity changed the Native Session identity",
        );
      }
      if (active.reasoning) this.#completeReasoning(active, { status: "succeeded" });
      if (result.response) {
        this.#appendOrSyncAgentText(active, result.response, false);
      }
      const usage = usageFromResult(result.usage);
      if (usage) {
        this.#event({
          type: "session.usage.changed",
          usage,
          observedForTurnId: active.command.turnId,
        });
      }
      // A permission denial with no assistant output explains an otherwise
      // silent Turn (upstream-aligned). The denial text itself stays out of the
      // surfaced error; the failed tool item already carries the detail.
      const deniedEmptyTurn =
        active.permissionDenial !== null && !active.agent && !active.agentText;
      const outcome = deniedEmptyTurn
        ? {
            status: "failed" as const,
            error: this.#permissionDeniedError(),
          }
        : isSuccessfulStatus(result.status)
          ? ({ status: "succeeded" } satisfies TurnOutcome)
          : isCancelledStatus(result.status)
            ? ({
                status: "cancelled",
                reason: result.error ?? "Cancelled by user",
              } satisfies TurnOutcome)
            : ({ status: "failed", error: errorFromResult(result) } satisfies TurnOutcome);
      await this.#persistLedger(active, result, outcome);
      this.#completeTurn(active, outcome, result);
      this.#recordSidecarTurn(active, outcome, result);
      // Real context-window usage from agy's local Language Server; never
      // blocks the Turn, degrades to a no-op when the LS is unreachable. The
      // counters are merged onto this Turn's own usage before publishing so a
      // token-less context event can never overwrite the Host's per-Turn usage.
      void this.#observeContextUsage(active, result, usage);
    } catch (error) {
      const outcome: TurnOutcome = active.cancellationRequested
        ? { status: "cancelled", reason: "Cancelled by user" }
        : {
            status: "failed",
            error: normalizeError(error, "nativeFailure", this.#transport.stderrTail),
          };
      if (result) await this.#persistLedger(active, result, outcome).catch(() => undefined);
      this.#completeTurn(active, outcome, result ?? undefined);
      if (result) {
        this.#recordSidecarTurn(active, outcome, result);
        void this.#observeContextUsage(active, result, null);
      }
    }
  }

  async #persistLedger(
    active: ActiveTurn,
    result: AntigravityResultEvent,
    outcome: TurnOutcome,
  ): Promise<void> {
    if (!nonNegativeInteger(result.numTurns) || result.numTurns < 1) {
      if (outcome.status === "succeeded") {
        throw new AntigravityTransportError(
          "protocolError",
          "Antigravity successful Turn has no native Turn index",
        );
      }
      return;
    }
    const nativeTurnKey = `${result.conversationId}:turn:${result.numTurns}`;
    const ledgerTurn: AntigravityLedgerTurn = {
      nativeTurnKey,
      input: active.text,
      response: result.response,
      status:
        outcome.status === "succeeded"
          ? "succeeded"
          : outcome.status === "cancelled"
            ? "cancelled"
            : "failed",
      ...(outcome.status === "failed" ? { error: outcome.error.message } : {}),
      ...(this.#modelSlug() ? { modelSlug: this.#modelSlug() as string } : {}),
    };
    await this.#ledger.append(ledgerTurn);
  }

  #completeTurn(active: ActiveTurn, outcome: TurnOutcome, result?: AntigravityResultEvent): void {
    if (this.#active !== active) return;
    const itemOutcome: HostItemOutcome =
      outcome.status === "failed"
        ? { status: "failed", error: outcome.error }
        : outcome.status === "cancelled"
          ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
          : { status: "succeeded" };
    if (active.reasoning) this.#completeReasoning(active, itemOutcome);
    for (const tool of active.tools.values()) this.#completeItem(active, tool.item, itemOutcome);
    active.tools.clear();
    if (active.agent) this.#completeItem(active, active.agent, itemOutcome);
    const nativeTurnRef = result && result.numTurns > 0 ? this.#nativeTurnRef(result) : undefined;
    const checkpoint = nativeTurnRef
      ? {
          harnessId: antigravityHarnessId,
          nativeSessionId: nativeTurnRef.nativeSessionId,
          checkpointId: nativeTurnRef.nativeTurnKey,
          formatVersion: 1 as const,
        }
      : undefined;
    this.#active = null;
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      ...(nativeTurnRef ? { nativeTurnRef } : {}),
      outcome: {
        ...outcome,
        ...(checkpoint ? { checkpoint } : {}),
      },
    });
    this.#armSessionIdleTimer();
  }

  #handleStep(active: ActiveTurn, step: AntigravityStepUpdate): void {
    if (this.#active !== active || this.#closed) return;
    // Per-step token telemetry reaches the Host as it streams (upstream-aligned).
    if (step.usage !== undefined) {
      const stepUsage = usageFromResult(step.usage);
      if (stepUsage) {
        this.#event({
          type: "session.usage.changed",
          usage: stepUsage,
          observedForTurnId: active.command.turnId,
        });
      }
    }
    if (step.thinkingDelta) {
      this.#appendReasoning(active, step.thinkingDelta);
    } else if (step.stepType === "thinking" && step.textDelta) {
      this.#appendReasoning(active, step.textDelta);
    }
    if (step.stepType !== "tool" && step.stepType !== "thinking") {
      const hasExplicitDelta =
        typeof step.textDelta === "string" && step.textDelta.length > 0 && step.text === undefined;
      const textCandidate =
        step.textDelta ??
        step.text ??
        (typeof step.content === "string" ? step.content : undefined) ??
        (typeof step.message === "string" ? step.message : undefined);
      if (textCandidate) {
        this.#completeReasoning(active, { status: "succeeded" });
        this.#appendOrSyncAgentText(active, textCandidate, hasExplicitDelta);
      }
    }
    if (step.stepType !== "tool") return;
    this.#completeReasoning(active, { status: "succeeded" });
    const callId = String(step.stepIndex ?? `tool-${active.tools.size}`);
    let tool = active.tools.get(callId);
    if (!tool) {
      const item: HostToolExecutionItem = {
        type: "toolExecution",
        itemId: hostItemIdSchema.parse(`antigravity:${this.#conversationId()}:${callId}`),
        toolName:
          step.toolName ??
          (nonBlankString(step.toolInfo?.name) ? step.toolInfo.name : "Antigravity tool"),
        arguments: stepToolArguments(step),
      };
      tool = { item, output: "" };
      active.tools.set(callId, tool);
      if (active.agent) {
        this.#completeItem(active, active.agent, { status: "succeeded" });
        active.agent = null;
      }
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
    }
    const output = boundedToolOutput(stepToolOutput(step), this.#toolOutputLimit);
    if (output) {
      const text = output.content
        .filter(
          (content): content is Extract<(typeof output.content)[number], { type: "text" }> =>
            content.type === "text",
        )
        .map(({ text: content }) => content)
        .join("");
      const delta = text.startsWith(tool.output) ? text.slice(tool.output.length) : text;
      tool.output = text;
      tool.item = { ...tool.item, output };
      if (delta)
        this.#event({
          type: "item.updated",
          turnId: active.command.turnId,
          itemId: tool.item.itemId,
          update: { type: "output.append", text: delta },
        });
    }
    if (step.state === "DONE") {
      const hasError = step.toolInfo?.error !== undefined;
      const toolError = hasError ? antigravityToolErrorMessage(step.toolInfo?.error) : null;
      if (hasError && active.permissionDenial === null && toolError !== null) {
        // Headless agy answers permission failures as tool errors; keep the first
        // one so an otherwise empty Turn can be explained (upstream-aligned).
        if (isAntigravityPermissionDenial(toolError)) active.permissionDenial = toolError;
      }
      const toolOutcome: HostItemOutcome = hasError
        ? {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: toolError ?? textFromValue(step.toolInfo?.error),
              retryable: false,
            },
          }
        : { status: "succeeded" };

      const completedItem: HostToolExecutionItem =
        typeof step.durationSeconds === "number"
          ? { ...tool.item, durationMs: Math.max(0, Math.round(step.durationSeconds * 1_000)) }
          : tool.item;
      tool.item = completedItem;
      this.#completeItem(active, completedItem, toolOutcome);

      if (!hasError) {
        const toolName =
          step.toolName ?? (nonBlankString(step.toolInfo?.name) ? step.toolInfo.name : "");
        const args = parseToolArgs(step.toolInfo?.parameters ?? step.toolInfo?.arguments);
        const fileChange = projectAntigravityFileChange(toolName, args, this.#cwd);
        if (fileChange) {
          const fileChangeItem: HostFileChangeItem = {
            type: "fileChange",
            itemId: hostItemIdSchema.parse(
              `antigravity:${this.#conversationId()}:${callId}:fileChange`,
            ),
            changes: [fileChange],
          };
          this.#event({
            type: "item.started",
            turnId: active.command.turnId,
            item: fileChangeItem,
          });
          this.#completeItem(active, fileChangeItem, { status: "succeeded" });
        }
      }

      active.tools.delete(callId);
    }
  }

  #appendOrSyncAgentText(active: ActiveTurn, text: string, isExplicitDelta: boolean): void {
    if (!text) return;
    if (isExplicitDelta || !active.agent) {
      this.#appendAgent(active, text);
      return;
    }
    if (text === active.agentText) return;
    if (text.startsWith(active.agentText)) {
      const delta = text.slice(active.agentText.length);
      if (delta.length > 0) this.#appendAgent(active, delta);
      return;
    }
    this.#appendAgent(active, text);
  }

  #appendAgent(active: ActiveTurn, text: string): void {
    if (!text) return;
    if (!active.agent) {
      active.agent = { type: "agentMessage", itemId: this.#newItemId(), text: "" };
      this.#event({ type: "item.started", turnId: active.command.turnId, item: active.agent });
    }
    active.agent = { ...active.agent, text: active.agent.text + text };
    active.agentText += text;
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.agent.itemId,
      update: { type: "text.append", text },
    });
  }

  #appendReasoning(active: ActiveTurn, text: string): void {
    if (!text) return;
    if (!active.reasoning) {
      active.reasoning = { type: "reasoning", itemId: this.#newItemId(), text: "" };
      this.#event({ type: "item.started", turnId: active.command.turnId, item: active.reasoning });
    }
    active.reasoning = { ...active.reasoning, text: active.reasoning.text + text };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.reasoning.itemId,
      update: { type: "text.append", text },
    });
  }

  #completeReasoning(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.reasoning;
    if (!item) return;
    active.reasoning = null;
    this.#completeItem(active, item, outcome);
  }

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    active.completedItems.push({ item, outcome });
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item, outcome },
    });
  }

  async #cancelTurn(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "Antigravity Turn is not active",
          retryable: false,
        },
      };
    }
    active.cancellationRequested = true;
    try {
      await this.#transport.cancel();
    } catch {
      // Best-effort cancel
    }
    return { ok: true, value: { cancellationRequested: true } };
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Antigravity Session cannot select a Model while busy",
          retryable: true,
        },
      };
    }
    let requestedSlug: string;
    try {
      requestedSlug = decodeAntigravityModelRef(command.model);
    } catch (error) {
      return { ok: false, error: normalizeError(error, "invalidRequest") };
    }
    const targetModel = modelBySlug(this.#models, requestedSlug);
    if (!targetModel) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Antigravity Model is not in the Catalog",
          retryable: false,
        },
      };
    }
    this.#touchSessionActivity();
    this.#configuring = true;
    try {
      const currentThinking = this.#state.effectiveThinkingOptionId;
      // Efforts are per-Model: a retained option the new Model rejects must be
      // dropped rather than passed to the CLI (upstream-aligned).
      let nextThinking: HarnessThinkingOptionId | undefined =
        currentThinking !== undefined && modelAcceptsThinking(targetModel, currentThinking)
          ? currentThinking
          : undefined;
      // agy requires an explicit --effort for Models with effort variants (e.g. gemini-3.7-flash);
      // default to the strongest supported one when none was retained.
      if (
        !nextThinking &&
        targetModel.supportedThinkingOptionIds &&
        targetModel.supportedThinkingOptionIds.length > 0
      ) {
        nextThinking =
          targetModel.supportedThinkingOptionIds[targetModel.supportedThinkingOptionIds.length - 1];
      }
      const init = await this.#transport.setModel(requestedSlug, nextThinking);
      const effectiveModelSlug =
        (init.model ? modelBySlug(this.#models, init.model)?.slug : undefined) ??
        init.model ??
        requestedSlug;
      const effectiveModel = modelBySlug(this.#models, effectiveModelSlug) ?? targetModel;
      const effectiveModelRef = encodeAntigravityModelRef(effectiveModel.slug);
      const available = antigravityAvailableThinkingOptions(effectiveModel);
      this.#state = {
        ...this.#state,
        effectiveModel: effectiveModelRef,
        resolvedModelLabel: effectiveModel.label,
        ...(nextThinking ? { effectiveThinkingOptionId: nextThinking } : {}),
        ...(available.length > 0 ? { availableThinkingOptions: [...available] } : {}),
      };
      if (!nextThinking) {
        delete this.#state.effectiveThinkingOptionId;
      }
      if (this.#state.nativeRef) {
        const locator =
          typeof this.#state.nativeRef.locator === "object" &&
          this.#state.nativeRef.locator !== null
            ? (this.#state.nativeRef.locator as Record<string, unknown>)
            : {};
        const nextLocator = {
          ...locator,
          model: effectiveModelSlug,
          ...(nextThinking ? { effort: nextThinking } : {}),
        };
        if (!nextThinking) {
          delete nextLocator.effort;
        }
        this.#state.nativeRef = nativeSessionRefSchema.parse({
          ...this.#state.nativeRef,
          locator: nextLocator,
        });
      }
      this.#history?.setSelection(effectiveModelRef, nextThinking);
      this.#event({
        type: "session.state.changed",
        state: this.#state,
      });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return {
        ok: false,
        error: normalizeError(error, "nativeFailure", this.#transport.stderrTail),
      };
    } finally {
      this.#configuring = false;
      this.#armSessionIdleTimer();
    }
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Antigravity Session cannot select Thinking while busy",
          retryable: true,
        },
      };
    }
    const modelSlug = this.#modelSlug();
    const model = modelSlug ? modelBySlug(this.#models, modelSlug) : undefined;
    const effectiveThinkingOptionId = modelAcceptsThinking(model, command.thinkingOptionId)
      ? command.thinkingOptionId
      : model?.supportedThinkingOptionIds?.at(-1);
    if (!model || !effectiveThinkingOptionId) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: `Antigravity Model does not accept effort "${command.thinkingOptionId}"`,
          retryable: false,
        },
      };
    }
    this.#touchSessionActivity();
    this.#configuring = true;
    try {
      await this.#transport.setEffort(effectiveThinkingOptionId);
      const available = antigravityAvailableThinkingOptions(model);
      this.#state = {
        ...this.#state,
        effectiveThinkingOptionId,
        ...(available.length > 0 ? { availableThinkingOptions: [...available] } : {}),
      };
      if (this.#state.nativeRef) {
        const locator =
          typeof this.#state.nativeRef.locator === "object" &&
          this.#state.nativeRef.locator !== null
            ? (this.#state.nativeRef.locator as Record<string, unknown>)
            : {};
        this.#state.nativeRef = nativeSessionRefSchema.parse({
          ...this.#state.nativeRef,
          locator: {
            ...locator,
            effort: effectiveThinkingOptionId,
          },
        });
      }
      this.#history?.setSelection(this.#modelRef(), effectiveThinkingOptionId);
      this.#event({
        type: "session.state.changed",
        state: this.#state,
      });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return {
        ok: false,
        error: normalizeError(error, "nativeFailure", this.#transport.stderrTail),
      };
    } finally {
      this.#configuring = false;
      this.#armSessionIdleTimer();
    }
  }

  async #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Antigravity Session cannot select a Permission Mode while busy",
          retryable: true,
        },
      };
    }
    let mode: AntigravityPermissionMode;
    try {
      mode = decodeAntigravityPermissionModeId(command.permissionModeId);
    } catch (error) {
      return { ok: false, error: normalizeError(error, "invalidRequest") };
    }
    this.#touchSessionActivity();
    if (mode === this.#permissionMode) {
      return { ok: true, value: { completed: true } };
    }
    this.#configuring = true;
    try {
      // The CLI fixes the permission mode at process start; switching means
      // restarting the Session process with the same conversation (same cost
      // as a Model switch on the resident-transport architecture).
      await this.#transport.setPermissionMode(mode === "dangerously-skip-permissions");
      this.#permissionMode = mode;
      this.#event({ type: "session.state.changed", state: this.#state });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return {
        ok: false,
        error: normalizeError(error, "nativeFailure", this.#transport.stderrTail),
      };
    } finally {
      this.#configuring = false;
      this.#armSessionIdleTimer();
    }
  }

  #permissionDeniedError(): HarnessError {
    const mode = this.#nativePermissionMode ? ` '${this.#nativePermissionMode}'` : "";
    return {
      code: "nativeFailure",
      message:
        `Antigravity denied a tool call under its${mode} permission mode and produced no response. ` +
        "Headless Antigravity evaluates its own permission rules and cannot ask for approval; " +
        "retry with the Skip permissions Permission Mode.",
      retryable: false,
    };
  }

  /** Persists the finished Turn into the upstream sidecar when one is attached. */
  #recordSidecarTurn(
    active: ActiveTurn,
    outcome: TurnOutcome,
    result: AntigravityResultEvent,
  ): void {
    const history = this.#history;
    if (!history) return;
    const nativeTurnRef = result.numTurns > 0 ? this.#nativeTurnRef(result) : undefined;
    if (!nativeTurnRef) return;
    const model = this.#modelRef();
    history.bindNativeSession(nativeTurnRef.nativeSessionId);
    history.append({
      nativeTurnRef,
      turnInput: [{ type: "text", text: active.text }],
      items: active.completedItems,
      outcome,
      ...(model ? { model } : {}),
    });
  }

  /**
   * Reads real context-window usage from agy's local Language Server. Resolves
   * to a no-op when the LS port is not discoverable or the metadata is not yet
   * available; never rejects. Failures are remembered per log file so a CLI
   * without a Language Server does not burn an 8s probe window on every Turn.
   */
  async #observeContextUsage(
    active: ActiveTurn,
    result: AntigravityResultEvent,
    turnUsage: HostUsage | null,
  ): Promise<void> {
    const logPath = this.#transport.logPath;
    if (!logPath || !result.conversationId) return;
    const now = Date.now();
    if (
      this.#contextProbeLogPath === logPath &&
      now - this.#contextProbeFailedAt < CONTEXT_PROBE_BACKOFF_MS
    ) {
      return;
    }
    try {
      const context = await pollAntigravityContextUsage(
        logPath,
        result.conversationId,
        this.#modelSlug(),
      );
      if (!context || this.#closed) {
        if (!this.#closed) {
          this.#contextProbeLogPath = logPath;
          this.#contextProbeFailedAt = Date.now();
        }
        return;
      }
      this.#contextProbeLogPath = null;
      const merged = turnUsage ? { ...turnUsage, ...context } : context;
      this.#event({
        type: "session.usage.changed",
        usage: merged,
        observedForTurnId: active.command.turnId,
      });
    } catch {
      // Best-effort context telemetry
    }
  }

  #conversationId(): string {
    const id = this.#transport.conversationId ?? this.initialState.nativeRef?.nativeSessionId;
    if (!id)
      throw new AntigravityTransportError(
        "protocolError",
        "Antigravity has no Conversation identity",
      );
    return id;
  }

  #clearSessionIdleTimer(): void {
    if (this.#sessionIdleTimer) {
      clearTimeout(this.#sessionIdleTimer);
      this.#sessionIdleTimer = null;
    }
  }

  #touchSessionActivity(): void {
    this.#sessionActivityGeneration += 1;
    this.#clearSessionIdleTimer();
  }

  #armSessionIdleTimer(): void {
    this.#clearSessionIdleTimer();
    if (
      this.#closed ||
      this.#active ||
      this.#configuring ||
      !Number.isSafeInteger(this.#sessionIdleTimeoutMs) ||
      this.#sessionIdleTimeoutMs <= 0
    ) {
      return;
    }
    const generation = this.#sessionActivityGeneration;
    const timer = setTimeout(() => {
      this.#sessionIdleTimer = null;
      if (generation !== this.#sessionActivityGeneration) return;
      void this.#hibernateIfIdle();
    }, this.#sessionIdleTimeoutMs);
    timer.unref?.();
    this.#sessionIdleTimer = timer;
  }

  async #hibernateIfIdle(): Promise<void> {
    if (this.#closed || this.#active || this.#configuring) {
      this.#armSessionIdleTimer();
      return;
    }
    try {
      await this.#transport.hibernate?.();
    } catch {
      // A failed idle cleanup must not fault the logical Session. Retry on the
      // next idle window while keeping the user's resumable Thread intact.
      this.#armSessionIdleTimer();
    }
  }

  #modelSlug(): string | undefined {
    return this.#state.effectiveModel
      ? decodeAntigravityModelRef(this.#state.effectiveModel)
      : undefined;
  }

  #modelRef(): HarnessModelRef | undefined {
    return this.#state.effectiveModel;
  }

  #newItemId() {
    return hostItemIdSchema.parse(`antigravity:${this.#conversationId()}:${randomUUID()}`);
  }

  #nativeTurnRef(result: AntigravityResultEvent) {
    return nativeTurnRefSchema.parse({
      harnessId: antigravityHarnessId,
      nativeSessionId: result.conversationId,
      nativeTurnKey: `${result.conversationId}:turn:${result.numTurns}`,
      formatVersion: 1,
    });
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
}

interface PreparedAntigravityTransport {
  transport: AntigravityCliTransportLike;
  startPromise: Promise<AntigravityInitEvent>;
}

export class AntigravityAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = antigravityHarnessId;
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;
  readonly cachedThreadCapabilities = ANTIGRAVITY_CAPABILITIES;
  readonly #options: AntigravityAdapterOptions;
  readonly #createTransport: (options: AntigravityTransportOptions) => AntigravityCliTransportLike;
  readonly #listModels: (input: {
    cwd: string;
    command?: string;
    environment: NodeJS.ProcessEnv;
  }) => Promise<AntigravityModelsResult>;
  readonly #sessions = new Set<AntigravityHarnessSession>();
  readonly #probeProcesses = new Set<ChildProcessWithoutNullStreams>();
  readonly #inspectionCache = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #inspectionFailures = new Map<
    string,
    { inspection: HarnessInspection; retryAt: number }
  >();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();
  #inspectionPersistentLoad: Promise<void> | null = null;
  #inspectionPersistentWrite: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  readonly #accounts: AntigravityAccountsLoad;
  readonly #accountsRealHome: string;
  readonly #creditsByAccount = new Map<string, AccountCreditsSnapshot>();
  readonly #creditsRefreshByAccount = new Map<string, Promise<AccountCreditsSnapshot | null>>();
  readonly #creditsRefreshStartedAt = new Map<string, number>();

  constructor(
    options: AntigravityAdapterOptions = {},
    dependencies: Partial<AntigravityAdapterDependencies> = {},
  ) {
    this.#options = options;
    this.#createTransport =
      dependencies.createTransport ?? ((opts) => new AntigravityCliTransport(opts));
    this.#listModels = dependencies.listModels ?? defaultListModels;
    this.#accounts = options.accounts ?? { mode: "legacy" };
    this.#accountsRealHome = antigravityRealHome({ ...process.env, ...options.environment });
    const initialCredits = readAntigravityCreditsSync();
    if (initialCredits) this.#creditsByAccount.set(LEGACY_ACCOUNT_KEY, initialCredits);
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    return this.#inspectWithEnvironment(input, this.#environment());
  }

  async #inspectWithEnvironment(
    input: InspectHarnessInput,
    environment: NodeJS.ProcessEnv,
  ): Promise<HarnessInspection> {
    if (this.#closePromise) {
      return {
        status: "unavailable",
        error: invalidState("Antigravity Adapter is closed"),
      };
    }
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const key = this.#inspectionKey(environment, cwd);
    await this.#loadPersistedInspectionCache();
    const inFlight = this.#inspectionInFlight.get(key);
    if (inFlight) return inFlight;
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(key);
      if (cached) return cached;
      const failure = this.#inspectionFailures.get(key);
      if (failure && failure.retryAt > Date.now()) return failure.inspection;
      if (failure) this.#inspectionFailures.delete(key);
    }

    const inspection = this.#inspectCatalog(cwd, environment).then((result) => {
      if (result.status === "ready") {
        this.#inspectionCache.set(key, result);
        this.#inspectionFailures.delete(key);
        this.#persistInspectionCache();
      } else {
        this.#inspectionFailures.set(key, {
          inspection: result,
          retryAt: Date.now() + INSPECTION_FAILURE_COOLDOWN_MS,
        });
      }
      return result;
    });
    this.#inspectionInFlight.set(key, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(key) === inspection) {
        this.#inspectionInFlight.delete(key);
      }
    });
  }

  #inspectionKey(environment: NodeJS.ProcessEnv, cwd: string): string {
    const accountId = this.#resolveAccount(environment)?.id ?? LEGACY_ACCOUNT_KEY;
    return `${accountId}\u0000${path.resolve(cwd)}`;
  }

  /**
   * Return the restart-safe local history cache without spawning AGY or
   * contacting Google. The Host uses this only to paint an existing thread;
   * execution still goes through the normal resume path below.
   */
  async readCachedSnapshot(
    input: ResumeSessionInput,
  ): Promise<HarnessResult<HostThreadSnapshot | null>> {
    try {
      const environment = this.#environment(input.environment);
      const history = await AntigravityHistory.open({
        environment,
        nativeSessionId: input.nativeRef.nativeSessionId,
      });
      const cachedTurns = history.snapshot();
      if (cachedTurns.length > 0) {
        return {
          ok: true,
          value: {
            turns: cachedTurns,
            state: { nativeRef: input.nativeRef },
          },
        };
      }
      const snapshot = await loadAntigravitySnapshot(
        input.nativeRef.nativeSessionId,
        { nativeRef: input.nativeRef },
        {
          cwd: input.cwd,
          environment,
        },
      );
      return { ok: true, value: snapshot };
    } catch {
      // A cache read is an optimization. If it is unavailable or corrupt, the
      // regular resume path remains authoritative and reports the real error.
      return { ok: true, value: null };
    }
  }

  async #inspectCatalog(cwd: string, environment: NodeJS.ProcessEnv): Promise<HarnessInspection> {
    const startedAt = Date.now();
    let stage: HarnessInspection["status"] = "notInstalled";
    try {
      stage = "unavailable";
      resolveAntigravityExecutable({
        ...(this.#options.command ? { command: this.#options.command } : {}),
        environment,
      });
      const result = await this.#listModels({
        cwd,
        ...(this.#options.command ? { command: this.#options.command } : {}),
        environment,
      });
      const models = parseAntigravityModelsOutput(result.stdout);
      const catalog = normalizeAntigravityModelCatalog(models);
      return {
        status: "ready",
        catalog,
        // Upstream: the Permission Mode catalog must accompany the capability
        // (the shared inspection schema cross-checks the two).
        permissionModes: ANTIGRAVITY_PERMISSION_MODE_CATALOG,
        capabilities: ANTIGRAVITY_CAPABILITIES,
      };
    } catch (error) {
      const normalized = normalizeError(error, "unavailable");
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "error",
        error: { ...normalized, stage, durationMs: Date.now() - startedAt },
      };
    }
  }

  credits(): AccountCreditsSnapshot | null {
    return this.#creditsFor(this.#creditsKey());
  }

  /**
   * One row per configured account so the account settings page can show quota
   * and switch the default. Accounts whose quota probe fails are omitted rather
   * than shown with fabricated numbers.
   */
  async inspectAccounts(): Promise<readonly HarnessAccountSnapshot[] | null> {
    if (this.#accounts.mode !== "multi") return null;
    const store = this.#accounts.store;
    const defaultAccountId = store.defaultAccount()?.id;
    const rows = await Promise.all(
      store
        .list()
        .filter((account) => account.enabled)
        .map(async (account): Promise<HarnessAccountSnapshot | null> => {
          const environment = this.#environment({ [ANTIGRAVITY_ACCOUNT_ID_ENV]: account.id });
          const credits = await this.#refreshCreditsFor(account.id, environment).catch(() => null);
          if (!credits) return null;
          return {
            accountId: account.id,
            label: account.name,
            isDefault: account.id === defaultAccountId,
            selectable: true,
            credits,
          };
        }),
    );
    return rows.filter((row): row is HarnessAccountSnapshot => row !== null);
  }

  async selectAccount(accountId: string): Promise<void> {
    if (this.#accounts.mode !== "multi") {
      throw new Error("Antigravity multi-account mode is not configured");
    }
    await this.#accounts.store.setDefaultAccount(accountId);
  }

  refreshCredits(): Promise<AccountCreditsSnapshot | null> {
    const key = this.#creditsKey();
    return this.#refreshCreditsFor(key, undefined);
  }

  #creditsKey(environment?: NodeJS.ProcessEnv): string {
    return this.#resolveAccount(environment)?.id ?? LEGACY_ACCOUNT_KEY;
  }

  #creditsFor(key: string): AccountCreditsSnapshot | null {
    let credits = this.#creditsByAccount.get(key) ?? null;
    // The statusline fallback is produced by the host-level agy process, so it
    // only ever describes the legacy account.
    if (!credits && key === LEGACY_ACCOUNT_KEY) {
      credits = readAntigravityCreditsSync();
      if (credits) this.#creditsByAccount.set(key, credits);
    }
    return credits;
  }

  #refreshCreditsFor(
    key: string,
    environment?: NodeJS.ProcessEnv,
  ): Promise<AccountCreditsSnapshot | null> {
    if (this.#closePromise) return Promise.resolve(this.#creditsFor(key));
    const inFlight = this.#creditsRefreshByAccount.get(key);
    if (inFlight) return inFlight;
    const now = Date.now();
    if (now - (this.#creditsRefreshStartedAt.get(key) ?? 0) < CREDITS_REFRESH_COOLDOWN_MS) {
      return Promise.resolve(this.#creditsFor(key));
    }
    this.#creditsRefreshStartedAt.set(key, now);
    const refresh = this.#loadCredits(key, environment).finally(() => {
      this.#creditsRefreshByAccount.delete(key);
    });
    this.#creditsRefreshByAccount.set(key, refresh);
    return refresh;
  }

  #scheduleCreditsRefresh(environment?: NodeJS.ProcessEnv): void {
    const key = this.#creditsKey(environment);
    void this.#refreshCreditsFor(key, environment);
  }

  async #loadCredits(
    key: string,
    environment?: NodeJS.ProcessEnv,
  ): Promise<AccountCreditsSnapshot | null> {
    // Fusion: the CLI's own `--print=/usage` is the primary quota source; the
    // local statusline/snapshot files stay as a fallback when it is unavailable.
    const resolvedEnvironment = environment ?? this.#environment();
    try {
      const quota = await fetchAntigravityQuota((arguments_) =>
        this.#runAntigravityCommand(arguments_, resolvedEnvironment),
      );
      if (quota) {
        // The Host validates against the shared credits contract; project the
        // CLI bucket shape onto it (upstream keeps them field-for-field).
        const credits: AccountCreditsSnapshot = {
          usedPercent: quota.usedPercent,
          periodType: quota.periodType,
          ...(quota.resetsAt ? { resetsAt: quota.resetsAt } : {}),
          ...(quota.productUsage && quota.productUsage.length > 0
            ? { productUsage: [...quota.productUsage] }
            : {}),
        };
        this.#creditsByAccount.set(key, credits);
        return credits;
      }
    } catch {
      // Fall through to the filesystem-backed fallback below.
    }
    return this.#creditsFor(key);
  }

  /** Runs the Antigravity CLI once and resolves stdout (quota probes). */
  #runAntigravityCommand(
    arguments_: readonly string[],
    environment?: NodeJS.ProcessEnv,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const resolvedEnvironment = environment ?? this.#environment();
      let executable: string;
      try {
        executable = resolveAntigravityExecutable({
          ...(this.#options.command ? { command: this.#options.command } : {}),
          environment: resolvedEnvironment,
        });
      } catch (error) {
        reject(error);
        return;
      }
      const child = spawn(executable, [...arguments_], {
        env: resolvedEnvironment,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      this.#probeProcesses.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#probeProcesses.delete(child);
        reject(new Error("Antigravity quota probe timed out"));
        void terminateProbe(child).catch(() => undefined);
      }, DEFAULT_PROBE_TIMEOUT_MS);
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#probeProcesses.delete(child);
        callback();
      };
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code) => {
        finish(() => {
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr.trim() || `agy exited with code ${String(code)}`));
        });
      });
    });
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise)
      return { ok: false, error: invalidState("Antigravity Adapter is closed") };
    if (!input.cwd)
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Antigravity Adapter requires cwd",
          retryable: false,
        },
      };
    const accountFailure = this.#accountsFailure();
    if (accountFailure) return { ok: false, error: accountFailure };
    const account = this.#resolveAccountForOpen(input);
    const routed = account ? withAntigravityAccountMarker(input, account.id) : input;
    const environment = this.#environment(routed.environment);
    const prepared = this.#prepareTransport(routed);
    const cwd = path.resolve(routed.cwd);
    const cachedInspection = this.#inspectionCache.get(this.#inspectionKey(environment, cwd));
    let inspection: HarnessInspection;
    if (cachedInspection) {
      inspection = cachedInspection;
    } else {
      inspection = await this.#inspectWithEnvironment({ cwd: routed.cwd }, environment);
    }
    if (inspection.status !== "ready") {
      await this.#closePreparedTransport(prepared);
      return { ok: false, error: harnessErrorFromInspection(inspection.error) };
    }
    const models = inspection.catalog.models.map((model) => {
      const slug = decodeAntigravityModelRef(model.ref);
      return {
        slug,
        label: model.label,
        ...(model.supportedThinkingOptionIds && model.supportedThinkingOptionIds.length > 0
          ? { supportedThinkingOptionIds: [...model.supportedThinkingOptionIds] }
          : {}),
      };
    });
    if (routed.kind === "create") {
      const opened = await this.#openCreate(routed, models, prepared);
      if (opened.ok) {
        const bindingFailure = await this.#recordBinding(account, routed, opened.value);
        if (bindingFailure) {
          await opened.value.close().catch(() => undefined);
          return { ok: false, error: bindingFailure };
        }
        this.#scheduleCreditsRefresh(environment);
      }
      return opened;
    }
    if (routed.kind !== "resume") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Antigravity CLI does not expose exact Fork or rollback operations",
          retryable: false,
        },
      };
    }
    const opened = await this.#openResume(routed, models, prepared);
    if (opened.ok) {
      const bindingFailure = await this.#recordBinding(account, routed, opened.value);
      if (bindingFailure) {
        await opened.value.close().catch(() => undefined);
        return { ok: false, error: bindingFailure };
      }
      this.#scheduleCreditsRefresh(environment);
    }
    return opened;
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      const sessions = Array.from(this.#sessions);
      const probes = Array.from(this.#probeProcesses);
      await Promise.allSettled([
        ...sessions.map((s) => s.close()),
        ...probes.map((probe) => terminateProbe(probe)),
      ]);
      await this.#inspectionPersistentWrite?.catch(() => undefined);
      this.#sessions.clear();
      this.#probeProcesses.clear();
      this.#inspectionCache.clear();
      this.#inspectionFailures.clear();
      this.#inspectionInFlight.clear();
      this.#inspectionPersistentLoad = null;
      this.#inspectionPersistentWrite = null;
    })();
    return this.#closePromise;
  }

  #inspectionCachePath(): string | null {
    const environment = this.#environment();
    const root =
      environment.CODEXHOST_DATA_DIR?.trim() ||
      path.join(
        environment.CODEX_HOME?.trim() || path.join(environment.HOME || homedir(), ".codex"),
        "codexhost-cache",
      );
    return path.join(root, "antigravity-model-catalog-v1.json");
  }

  async #loadPersistedInspectionCache(): Promise<void> {
    if (!this.#inspectionPersistentLoad) {
      const filePath = this.#inspectionCachePath();
      this.#inspectionPersistentLoad = (async () => {
        if (!filePath) return;
        try {
          const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            (parsed as { version?: unknown }).version !== PERSISTED_INSPECTION_VERSION ||
            !Array.isArray((parsed as { entries?: unknown }).entries)
          ) {
            return;
          }
          for (const entry of (parsed as { entries: unknown[] }).entries) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
            const cwd = (entry as { cwd?: unknown }).cwd;
            const accountId = (entry as { accountId?: unknown }).accountId;
            const updatedAtMs = (entry as { updatedAtMs?: unknown }).updatedAtMs;
            const inspection = harnessInspectionSchema.safeParse(
              (entry as { inspection?: unknown }).inspection,
            );
            if (
              typeof cwd === "string" &&
              typeof updatedAtMs === "number" &&
              Number.isFinite(updatedAtMs) &&
              Date.now() - updatedAtMs <= PERSISTED_INSPECTION_MAX_AGE_MS &&
              inspection.success &&
              inspection.data.status === "ready"
            ) {
              this.#inspectionCache.set(
                `${typeof accountId === "string" ? accountId : LEGACY_ACCOUNT_KEY}\u0000${path.resolve(cwd)}`,
                inspection.data,
              );
            }
          }
        } catch {
          // Persisted model metadata is an optimization; stale or corrupt data
          // falls back to the normal AGY catalog request.
        }
      })();
    }
    await this.#inspectionPersistentLoad;
  }

  #persistInspectionCache(): void {
    const filePath = this.#inspectionCachePath();
    if (!filePath || this.#inspectionCache.size === 0) return;
    const updatedAtMs = Date.now();
    const entries = [...this.#inspectionCache.entries()].map(([key, inspection]) => {
      const separator = key.indexOf("\u0000");
      return {
        accountId: separator >= 0 ? key.slice(0, separator) : LEGACY_ACCOUNT_KEY,
        cwd: separator >= 0 ? key.slice(separator + 1) : key,
        inspection,
        updatedAtMs,
      };
    });
    const previous = this.#inspectionPersistentWrite ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const temporary = `${filePath}.tmp-${process.pid}`;
        await writeFile(
          temporary,
          JSON.stringify({ version: PERSISTED_INSPECTION_VERSION, entries }),
          {
            encoding: "utf8",
            mode: 0o600,
          },
        );
        await rename(temporary, filePath);
      });
    this.#inspectionPersistentWrite = write.catch(() => undefined);
  }

  async #openCreate(
    input: Extract<OpenSessionInput, { kind: "create" }>,
    models: readonly AntigravityNativeModel[],
    prepared?: PreparedAntigravityTransport | null,
  ): Promise<HarnessResult<HarnessSession>> {
    let modelSlug: string | undefined;
    let model: AntigravityNativeModel | undefined;
    let permissionMode: AntigravityPermissionMode = "dangerously-skip-permissions";
    let thinkingOptionId: HarnessThinkingOptionId | undefined;
    try {
      modelSlug = input.model ? decodeAntigravityModelRef(input.model) : models[0]?.slug;
      model = modelSlug ? modelBySlug(models, modelSlug) : undefined;
      if (!modelSlug || !model)
        throw new Error("Antigravity create Model is not in the current Catalog");
      if (input.permissionModeId) {
        permissionMode = decodeAntigravityPermissionModeId(input.permissionModeId);
      }
      thinkingOptionId = input.thinkingOptionId;
      // agy requires an explicit --effort for Models with effort variants; the
      // CLI default is the strongest one, so lead with it when none was chosen.
      if (!thinkingOptionId) {
        const supported = model.supportedThinkingOptionIds;
        if (supported && supported.length > 0) {
          thinkingOptionId = supported[supported.length - 1];
        }
      }
      if (thinkingOptionId && !modelAcceptsThinking(model, thinkingOptionId)) {
        throw new Error("Antigravity create Thinking option is not accepted by the selected Model");
      }
    } catch (error) {
      await this.#closePreparedTransport(prepared);
      return { ok: false, error: normalizeError(error, "invalidRequest") };
    }
    const skipPermissions = permissionMode === "dangerously-skip-permissions";
    const transport =
      prepared?.transport ??
      this.#createTransport(
        this.#transportOptions(input, modelSlug, undefined, skipPermissions, thinkingOptionId),
      );
    try {
      const init = await (prepared?.startPromise ?? transport.start());
      const effectiveModelSlug =
        (init.model ? modelBySlug(models, init.model)?.slug : undefined) ??
        modelSlug ??
        init.model ??
        models[0]?.slug;
      const effectiveModel = effectiveModelSlug ? modelBySlug(models, effectiveModelSlug) : model;
      const state = {
        ...sessionState(
          init,
          effectiveModel,
          effectiveModelSlug,
          thinkingOptionId,
          skipPermissions,
        ),
        ...(effectiveModel ? { resolvedModelLabel: effectiveModel.label } : {}),
      };
      const ledger = new AntigravitySessionLedger({
        conversationId: init.conversationId,
        cwd: input.cwd,
        environment: this.#environment(input.environment),
      });
      const history = await AntigravityHistory.open({
        environment: this.#environment(input.environment),
        nativeSessionId: init.conversationId,
      });
      const session = this.#trackSession(
        new AntigravityHarnessSession({
          cwd: input.cwd,
          environment: this.#environment(input.environment),
          models,
          transport,
          initialState: state,
          ledger,
          history,
          permissionMode,
          nativePermissionMode: init.permissionMode ?? null,
          toolOutputLimit: this.#options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT,
          ...(this.#options.sessionIdleTimeoutMs !== undefined
            ? { sessionIdleTimeoutMs: this.#options.sessionIdleTimeoutMs }
            : {}),
        }),
      );
      return { ok: true, value: session };
    } catch (error) {
      await transport.close().catch(() => undefined);
      return { ok: false, error: normalizeError(error, "unavailable", transport.stderrTail) };
    }
  }

  async #openResume(
    input: Extract<OpenSessionInput, { kind: "resume" }>,
    models: readonly AntigravityNativeModel[],
    prepared?: PreparedAntigravityTransport | null,
  ): Promise<HarnessResult<HarnessSession>> {
    let sourceRef: NativeSessionRef;
    let locator: {
      model?: string;
      effort?: HarnessThinkingOptionId;
      skipPermissions: boolean;
    };
    try {
      sourceRef = nativeSessionRefSchema.parse(input.nativeRef);
      if (sourceRef.harnessId !== this.harnessId)
        throw new Error("Antigravity Adapter cannot open another Harness's Native Session");
      locator = modelSlugFromLocator(sourceRef);
    } catch (error) {
      return { ok: false, error: normalizeError(error, "invalidRequest") };
    }
    const transport =
      prepared?.transport ??
      this.#createTransport(
        this.#transportOptions(
          input,
          locator.model,
          sourceRef.nativeSessionId,
          locator.skipPermissions,
          locator.effort,
        ),
      );
    try {
      const init = await (prepared?.startPromise ?? transport.start());
      if (
        init.conversationId &&
        sourceRef.nativeSessionId &&
        init.conversationId !== sourceRef.nativeSessionId
      )
        throw new AntigravityTransportError(
          "protocolError",
          "Antigravity resume changed the Native Session identity",
        );
      const effectiveModelSlug =
        (init.model ? modelBySlug(models, init.model)?.slug : undefined) ??
        locator.model ??
        init.model ??
        models[0]?.slug;
      const model = effectiveModelSlug ? modelBySlug(models, effectiveModelSlug) : undefined;
      // A retained effort the Model does not accept must be dropped rather than
      // passed to the CLI (upstream-aligned); the CLI then applies its own default.
      let effort =
        locator.effort && model && !modelAcceptsThinking(model, locator.effort)
          ? undefined
          : locator.effort;
      // Resume spawns still pass --model; Models with effort variants require an
      // explicit --effort, so default to the strongest when none was retained.
      if (
        !effort &&
        model?.supportedThinkingOptionIds &&
        model.supportedThinkingOptionIds.length > 0
      ) {
        effort = model.supportedThinkingOptionIds[model.supportedThinkingOptionIds.length - 1];
      }
      const skipPermissions = locator.skipPermissions;
      const state = {
        ...sessionState(init, model, effectiveModelSlug, effort, skipPermissions),
        ...(model ? { resolvedModelLabel: model.label } : {}),
      };
      const ledger = new AntigravitySessionLedger({
        conversationId: sourceRef.nativeSessionId,
        cwd: input.cwd,
        environment: this.#environment(input.environment),
      });
      const history = await AntigravityHistory.open({
        environment: this.#environment(input.environment),
        nativeSessionId: sourceRef.nativeSessionId,
        ...(input.knownTurnRefs ? { knownTurnRefs: input.knownTurnRefs } : {}),
      });
      const session = this.#trackSession(
        new AntigravityHarnessSession({
          cwd: input.cwd,
          environment: this.#environment(input.environment),
          models,
          transport,
          initialState: state,
          ledger,
          history,
          permissionMode: skipPermissions ? "dangerously-skip-permissions" : "configured",
          nativePermissionMode: init.permissionMode ?? null,
          historyRequired: input.knownTurnRefs?.length ?? 0,
          toolOutputLimit: this.#options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT,
          ...(this.#options.sessionIdleTimeoutMs !== undefined
            ? { sessionIdleTimeoutMs: this.#options.sessionIdleTimeoutMs }
            : {}),
        }),
      );
      return { ok: true, value: session };
    } catch (error) {
      await transport.close().catch(() => undefined);
      return { ok: false, error: normalizeError(error, "unavailable", transport.stderrTail) };
    }
  }

  #trackSession(session: AntigravityHarnessSession): AntigravityHarnessSession {
    this.#sessions.add(session);
    return session;
  }

  #transportOptions(
    input: OpenSessionInput,
    model: string | undefined,
    conversationId: string | undefined,
    skipPermissions: boolean,
    effort?: string,
  ): AntigravityTransportOptions {
    return {
      cwd: input.cwd,
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: this.#environment(input.environment),
      ...(conversationId ? { conversationId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      skipPermissions,
      ...(this.#options.startupTimeoutMs !== undefined
        ? { startupTimeoutMs: this.#options.startupTimeoutMs }
        : {}),
      ...(this.#options.turnTimeoutMs !== undefined
        ? { turnTimeoutMs: this.#options.turnTimeoutMs }
        : {}),
      ...(this.#options.idleTimeoutMs !== undefined
        ? { idleTimeoutMs: this.#options.idleTimeoutMs }
        : {}),
      ...(this.#options.turnDeadlineMs !== undefined
        ? { turnDeadlineMs: this.#options.turnDeadlineMs }
        : {}),
      ...(this.#options.closeTimeoutMs !== undefined
        ? { closeTimeoutMs: this.#options.closeTimeoutMs }
        : {}),
      ...(this.#options.printTimeout !== undefined
        ? { printTimeout: this.#options.printTimeout }
        : {}),
    };
  }

  #prepareTransport(input: OpenSessionInput): PreparedAntigravityTransport | null {
    let model: string | undefined;
    let conversationId: string | undefined;
    let effort: string | undefined;
    let skipPermissions = false;
    try {
      if (input.kind === "create") {
        // Pre-starting needs the full launch shape; the default effort for
        // effort-variant Models is only known after the model catalog loads, so
        // only pre-start when a Thinking option was explicitly requested.
        if (!input.model || !input.thinkingOptionId) return null;
        model = decodeAntigravityModelRef(input.model);
        effort = input.thinkingOptionId;
        skipPermissions = input.permissionModeId
          ? decodeAntigravityPermissionModeId(input.permissionModeId) ===
            "dangerously-skip-permissions"
          : true;
      } else if (input.kind === "resume") {
        const sourceRef = nativeSessionRefSchema.parse(input.nativeRef);
        if (sourceRef.harnessId !== this.harnessId) return null;
        const locator = modelSlugFromLocator(sourceRef);
        model = locator.model;
        effort = locator.effort;
        conversationId = sourceRef.nativeSessionId;
        skipPermissions = locator.skipPermissions;
      } else {
        return null;
      }
      const transport = this.#createTransport(
        this.#transportOptions(input, model, conversationId, skipPermissions, effort),
      );
      const startPromise = transport.start();
      void startPromise.catch(() => undefined);
      return { transport, startPromise };
    } catch {
      return null;
    }
  }

  async #closePreparedTransport(prepared?: PreparedAntigravityTransport | null): Promise<void> {
    if (!prepared) return;
    await prepared.transport.close().catch(() => undefined);
  }

  #environment(explicit?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const base = resolveAntigravityProxyEnvironment({
      ...process.env,
      ...this.#options.environment,
      ...explicit,
    });
    const account = this.#resolveAccount(explicit);
    if (!account) return base;
    return applyAntigravityAccountEnvironment(base, account, this.#accountsRealHome);
  }

  /** Configured-but-broken accounts must fail closed instead of using the real HOME. */
  #accountsFailure(): HarnessError | null {
    if (this.#accounts.mode !== "invalid") return null;
    return {
      code: "unavailable",
      message: `Antigravity multi-account configuration is invalid: ${this.#accounts.error.message}`,
      retryable: false,
    };
  }

  #resolveAccount(explicit?: NodeJS.ProcessEnv): AntigravityAccount | null {
    if (this.#accounts.mode !== "multi") return null;
    const store = this.#accounts.store;
    const marker = explicit?.[ANTIGRAVITY_ACCOUNT_ID_ENV]?.trim();
    if (marker) {
      const marked = store.get(marker);
      if (marked) return marked;
    }
    return store.resolveAccountForThread(explicit?.[ANTIGRAVITY_THREAD_ID_ENV]?.trim());
  }

  /**
   * Resume prefers the account that owns the native Session, so a lost Thread
   * binding can never move an existing conversation onto another account.
   */
  #resolveAccountForOpen(input: OpenSessionInput): AntigravityAccount | null {
    if (this.#accounts.mode !== "multi") return null;
    if (input.kind === "resume") {
      const byNativeSession = this.#accounts.store.accountForNativeSession(
        input.nativeRef.nativeSessionId,
      );
      if (byNativeSession) return byNativeSession;
    }
    return this.#resolveAccount(input.environment);
  }

  async #recordBinding(
    account: AntigravityAccount | null,
    input: OpenSessionInput,
    session: HarnessSession,
  ): Promise<HarnessError | null> {
    if (!account || this.#accounts.mode !== "multi") return null;
    const threadId = input.environment?.[ANTIGRAVITY_THREAD_ID_ENV]?.trim();
    if (!threadId) return null;
    const nativeSessionId = session.initialState.nativeRef?.nativeSessionId;
    try {
      await this.#accounts.store.bindThread({
        threadId,
        accountId: account.id,
        ...(nativeSessionId ? { nativeSessionId } : {}),
        state: nativeSessionId ? "committed" : "reserved",
      });
      return null;
    } catch (error) {
      // A single enabled account cannot route to the wrong account, so a failed
      // metadata write must not break every new Thread. With several accounts we
      // fail closed rather than risk resuming on the wrong one.
      if (this.#accounts.store.list().filter((account) => account.enabled).length <= 1) {
        return null;
      }
      return {
        code: "unavailable",
        message: `Antigravity account binding could not be persisted: ${errorMessage(error)}`,
        retryable: false,
      };
    }
  }
}

async function defaultListModels(input: {
  cwd: string;
  command?: string;
  environment: NodeJS.ProcessEnv;
}): Promise<AntigravityModelsResult> {
  const executable = resolveAntigravityExecutable({
    ...(input.command ? { command: input.command } : {}),
    environment: input.environment,
  });
  const invocation = antigravityModelsInvocation(executable, input.environment);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: input.cwd,
      env: input.environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Antigravity models listing timed out"));
      void terminateProbe(child).catch(() => undefined);
    }, DEFAULT_MODELS_TIMEOUT_MS);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`Antigravity models failed with exit code ${code}: ${stderr}`));
      });
    });
  });
}
