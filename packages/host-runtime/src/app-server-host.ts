import { appendFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { spawn } from "node:child_process";
import type {
  HarnessAdapter,
  HarnessOutput,
  HarnessSession,
  HostApprovalInteraction,
  HostSubagentState,
  HostApprovalResponse,
  HostQuestionInteraction,
  TurnCompletedEvent,
  TurnOutcome,
} from "@codexhost/harness-adapter";
import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  accountCreditsSnapshotSchema,
  externalThreadForkParamsSchema,
  harnessCommandCatalogSchema,
  harnessIdSchema,
  threadCommandExecuteParamsSchema,
  threadCommandExecuteResultSchema,
  threadCommandsInspectParamsSchema,
  externalThreadForkResultSchema,
  harnessInspectParamsSchema,
  harnessConfigurationStateSchema,
  harnessInspectionSchema,
  harnessModelRefSchema,
  harnessModelSelectionStateSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  jsonValueSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadModelSelectParamsSchema,
  threadUsageInspectionParamsSchema,
  threadUsageInspectionSchema,
  threadPermissionModeSelectParamsSchema,
  threadThinkingSelectParamsSchema,
  threadOwnershipListParamsSchema,
  threadOwnershipListResultSchema,
  permissionModeFixedAtCreate,
  updateCheckResultSchema,
  updateEmptyParamsSchema,
  updateStartResultSchema,
  updateStatusResultSchema,
  type AccountBalanceSnapshot,
  type AccountCreditsSnapshot,
  type HarnessCommandDescriptor,
  type HarnessInspection,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type HostTurnId,
  type HostThreadId,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";
import { executeExternalThreadFork } from "./external-thread-fork.js";
import {
  advanceGoalLoop,
  createGoalLoop,
  fromStoredGoal,
  goalContinuePrompt,
  goalSeedPrompt,
  hasTurnProgress,
  lastAgentMessageText,
  parseGoalDecision,
  parseGoalCommand,
  setGoalStatus,
  toStoredGoal,
  toThreadGoal,
  updateGoalActiveTime,
  type GoalLoopState,
  type ThreadGoal,
  type ThreadGoalStatus,
} from "./goal-loop.js";
import {
  ExternalHistoryRequestError,
  listExternalItems,
  listExternalTurns,
} from "./external-thread-history.js";
import { executeExternalThreadRollback } from "./external-thread-rollback.js";
import {
  createExternalThreadRecordInput,
  createProductionExternalThreadStore,
  ExternalThreadRepository,
  externalThreadValue,
  type ExternalThreadStore,
} from "./external-thread-repository.js";
import {
  ExternalThreadRuntime,
  type CachedExternalThread,
  type ExternalThread,
  type ExternalThreadLocation,
  type ExternalThreadResolution,
} from "./external-thread-runtime.js";
import { normalizeThreadTitle } from "./thread-title-normalizer.js";
import {
  DELEGATION_CLI_PATH_ENV,
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
  DelegationControlError,
  type DelegationControlRegistration,
  type DelegationStartInput,
  type DelegationStartResult,
  type DelegationThreadListResult,
  type DelegationThreadSnapshot,
  type HarnessInspectInput,
  type HarnessInspectResult,
  type ThreadCancelInput,
  type ThreadCancelResult,
  type ThreadListInput,
  type ThreadReadInput,
  type ThreadSendInput,
  type ThreadSendResult,
} from "./delegation-types.js";
import { HarnessDelegationCoordinator } from "./harness-delegation-coordinator.js";
import { allVisibleMessages, projectDelegationThreadSnapshot } from "./delegation-snapshot.js";
import { formatHandoverContext } from "./session-handover.js";
import { OfficialRequestBroker } from "./official-request-broker.js";
import {
  canonicalizeOfficialCodexModelRef,
  decodeOfficialCodexModelRef,
  encodeOfficialCodexModelRef,
} from "./official-codex-model-ref.js";
import {
  spawnOfficialAppServerConnection,
  type OfficialAppServerConnection,
} from "./official-app-server-connection.js";
import type { HostUpdateCoordinator } from "./update-coordinator.js";
import {
  classifyThreadPurpose,
  RequestRouteObservationTracker,
  type CreateRequestRouteObservation,
  type RequestRouteObservation,
} from "./route-observation.js";
import {
  aggregateThreadList,
  officialThreadListPageFromResponse,
  OfficialThreadListError,
} from "./thread-list-aggregator.js";
import {
  CodexTurnProjector,
  decodeCreateRoute,
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  decodeThreadArchiveRequest,
  decodeThreadForkRequest,
  decodeThreadListRequest,
  decodeThreadMetadataUpdateRequest,
  decodeThreadRevertRequest,
  decodeThreadRollbackRequest,
  mapExternalThreadHarnessError,
  projectCodexRateLimitsToCredits,
  observeCodexRateLimits,
  observeCodexTokenUsage,
  parseJsonFrame,
  projectCodexThreadUsage,
  readLfFrames,
  writeFrame,
  writeJsonFrame,
  jsonRpcRequestSchema,
  threadForkResult,
  threadRevertResult,
  threadRollbackResult,
  transportModelIdForHarness,
  type CodexApprovalProjection,
  type CodexApprovalRequestProjection,
  type CodexQuestionProjection,
  type CodexQuestionRequestProjection,
  type CreateRoute,
  type DecodedThreadForkRequest,
  type DecodedThreadListRequest,
  type DecodedThreadRevertRequest,
  type DecodedThreadRollbackRequest,
  type ExternalHarnessId,
  type RoutedHarnessId,
  type ExternalThreadRpcError,
  type JsonObject,
  type JsonRpcRequest,
  type JsonValue,
  type ProjectableHostEvent,
} from "@codexhost/protocol-core";

const SUBAGENT_TERMINAL_REFRESH_DELAYS_MS = [0, 50, 100, 150] as const;
const THREAD_USAGE_UPDATED_METHOD = "codexhost/thread/usage/updated";
// Native Codex account quota is still pulled through its official API; keep
// that reading briefly cached so concurrent Composer inspections coalesce.
const OFFICIAL_RATE_LIMIT_TTL_MS = 15_000;
const OFFICIAL_OUTPUT_DRAIN_TIMEOUT_MS = 250;
const OFFICIAL_METADATA_CACHE_TTL_MS = 10_000;
const OFFICIAL_METADATA_STALE_MAX_MS = 24 * 60 * 60_000;
const OFFICIAL_METADATA_CACHE_METHODS = new Set([
  "plugin/list",
  "plugin/installed",
  "mcpServerStatus/list",
]);
export const CODEXHOST_ENABLE_UNTRUSTED_CODEX_APP_TOOLS_ENV = "CODEXHOST_ENABLE_UNTRUSTED_CODEX_APP_TOOLS";
const NEVER_SETTLES = new Promise<never>(() => undefined);
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface AppServerHostOptions {
  stockCodexPath: string;
  arguments: string[];
  defaultAgent: "codex" | "pi";
  environment?: NodeJS.ProcessEnv;
  desktopInput?: Readable;
  desktopOutput?: Writable;
  diagnosticOutput?: Writable;
  externalAdapters: ReadonlyMap<ExternalHarnessId, HarnessAdapter>;
  mappingStore?: ExternalThreadStore;
  /** Defaults to true. A listener that shares one store across sessions owns closing it. */
  closeMappingStoreOnExit?: boolean;
  spawnOfficial?: typeof spawn;
  createOfficialConnection?: () =>
    OfficialAppServerConnection | Promise<OfficialAppServerConnection>;
  onCreateRequestRoute?: (observation: CreateRequestRouteObservation) => void;
  onRequestRoute?: (observation: RequestRouteObservation) => void;
  updateCoordinator?: HostUpdateCoordinator;
  onDelegationApi?: (api: DelegationControlRegistration) => (() => void) | undefined;
  /** Whether to automatically normalize thread titles to [标签] 规范. */
  normalizeThreadTitles?: boolean;
}

interface TurnProjectionGate {
  promise: Promise<void>;
  resolve(): void;
}

interface ProjectedTurn {
  projector: CodexTurnProjector;
}

type HostApprovalRequestId = number;
type HostQuestionRequestId = number;

interface PendingDesktopApproval {
  thread: ExternalThread;
  interaction: HostApprovalInteraction;
  projection: CodexApprovalRequestProjection;
}

interface PendingDesktopQuestion {
  thread: ExternalThread;
  interaction: HostQuestionInteraction;
  projection: CodexQuestionRequestProjection;
  timeout: NodeJS.Timeout | null;
}

type ExternalThreadStatus = { type: "active"; activeFlags: [] } | { type: "idle" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCreditsAdapter(adapter: HarnessAdapter): adapter is HarnessAdapter & {
  credits(): unknown;
  refreshCredits?: () => Promise<unknown>;
} {
  return typeof (adapter as { credits?: unknown }).credits === "function";
}

function isBalanceAdapter(adapter: HarnessAdapter): adapter is HarnessAdapter & {
  balance(): AccountBalanceSnapshot | null | undefined;
  refreshBalance?(): Promise<void>;
} {
  return typeof (adapter as { balance?: unknown }).balance === "function";
}

function projectAccountCredits(value: unknown): AccountCreditsSnapshot | null {
  if (!isRecord(value))
    return null;
  const rest = { ...value };
  delete rest.fetchedAt;
  const parsed = accountCreditsSnapshotSchema.safeParse(rest);
  return parsed.success ? parsed.data : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function officialEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    DELEGATION_CLI_PATH_ENV,
    DELEGATION_RUNTIME_ENDPOINT_ENV,
    DELEGATION_RUNTIME_TOKEN_ENV,
  ]);
  const internal = new Set([
    "CODEX_CLI_PATH",
    "CODEXHOST_HOST_NODE_PATH",
    "CODEXHOST_DATA_DIR",
    "CODEXHOST_DEFAULT_AGENT",
    "CODEXHOST_HOST_RUNTIME_PATH",
    "CODEXHOST_PI_COMMAND",
    "CODEXHOST_ENABLE_CLAUDE_CODE",
    "CODEXHOST_CLAUDE_COMMAND",
    "CODEXHOST_OPENCODE_COMMAND",
    "CODEXHOST_STOCK_CODEX_PATH",
    "CODEXHOST_LAUNCHER_PID",
    "CODEXHOST_LAUNCHER_EXECUTABLE",
    "CODEXHOST_RUNTIME_DESCRIPTOR_PATH",
    "CODEXHOST_CONTROL_PORT",
    "CODEXHOST_CONTROL_NONCE",
    "CODEXHOST_NPM_NODE_PATH",
    "CODEXHOST_NPM_CLI_PATH",
    "CODEXHOST_NPM_LAUNCHER_PATH",
    "CODEXHOST_NPM_PACKAGE_ROOT",
  ]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !internal.has(key) || allowed.has(key)));
}

function rpcEnvelope(request: JsonRpcRequest, value: JsonObject): JsonObject {
  return {
    ...(request.jsonrpc === "2.0" ? { jsonrpc: "2.0" } : {}),
    id: request.id,
    ...value,
  };
}

function rpcError(request: JsonRpcRequest, code: number, message: string): JsonObject {
  return rpcEnvelope(request, { error: { code, message } });
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function approvalServerName(harnessId: ExternalHarnessId): string {
  switch (harnessId) {
    case "pi":
      return "Pi";
    case "claude-code":
      return "Claude Code";
    case "deepseek-harness":
      return "DeepSeek Harness";
    case "grok":
      return "Grok";
    case "opencode":
      return "OpenCode";
    case "omp":
      return "Oh My Pi";
    case "antigravity":
      return "Gemini CLI";
  }
}
const HOST_APPROVAL_REQUEST_ID_MIN = -2_000_000;
const HOST_APPROVAL_REQUEST_ID_MAX = -1_000_001;
const HOST_QUESTION_REQUEST_ID_MIN = -1_000_000;
const HOST_QUESTION_REQUEST_ID_MAX = -1;
const EXPLICIT_EXTERNAL_THREAD_METHODS = new Set([
  "thread/archive",
  "thread/delete",
  "thread/fork",
  "thread/goal/clear",
  "thread/goal/get",
  "thread/goal/set",
  "thread/items/list",
  "thread/metadata/update",
  "thread/name/set",
  "thread/read",
  "thread/resume",
  "thread/revert",
  "thread/rollback",
  "thread/settings/update",
  "thread/turns/list",
  "thread/unarchive",
  "thread/unsubscribe",
]);
function isHostApprovalRequestId(value: unknown): value is HostApprovalRequestId {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= HOST_APPROVAL_REQUEST_ID_MIN &&
    value <= HOST_APPROVAL_REQUEST_ID_MAX
  );
}
function isHostQuestionRequestId(value: unknown): value is HostQuestionRequestId {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= HOST_QUESTION_REQUEST_ID_MIN &&
    value <= HOST_QUESTION_REQUEST_ID_MAX
  );
}
export function classifyCreateRequestRoute(
  request: JsonRpcRequest,
  defaultAgent: "codex" | "pi",
): CreateRequestRouteObservation | null {
  const route = decodeCreateRoute(request);
  if (!route)
    return null;
  if (route.harnessId !== "codex") {
    return {
      requestMethod: "thread/start",
      modelCarrier: `${route.harnessId}-transport`,
      selectedHarness: route.harnessId,
      selectionSource: "transport-model",
    };
  }
  return {
    requestMethod: "thread/start",
    modelCarrier: "official-model",
    selectedHarness: defaultAgent,
    selectionSource: defaultAgent === "pi" ? "default-agent" : "official-model",
  };
}

function requestObject(request: JsonRpcRequest): JsonObject {
  if (!isRecord(request.params))
    throw new Error(`${request.method} params must be an object`);
  return request.params as JsonObject;
}

function requestText(params: JsonObject): string {
  if (!Array.isArray(params.input))
    throw new Error("turn/start input must be an array");
  const text = params.input
    .filter((item): item is JsonObject => isRecord(item) && item.type === "text")
    .map((item) => item.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (!text)
    throw new Error("turn/start must contain text input");
  return text;
}

/**
 * ChatGPT's dynamic app-tools pipe accepts only its packaged signing chain.
 * A source-checkout Host must not repeatedly start a doomed MCP client on
 * every thread. A signed production build can explicitly opt back in.
 */
export function sanitizeOfficialAppServerArguments(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  if (environment[CODEXHOST_ENABLE_UNTRUSTED_CODEX_APP_TOOLS_ENV] === "1") {
    return [...arguments_];
  }
  return arguments_.map((argument) => {
    if (!argument.startsWith("mcp_servers.codex_app=") || !/"enabled"=true/u.test(argument)) {
      return argument;
    }
    return argument.replace(/("enabled"=)true/u, "$1false");
  });
}

function sandboxResult(params: Record<string, unknown>) {
  const sandbox = params.sandbox;
  if (sandbox === "read-only")
    return { type: "readOnly", networkAccess: false };
  if (sandbox === "danger-full-access")
    return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    networkAccess: false,
    writableRoots: [],
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function turnProjectionGate(): TurnProjectionGate {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class OrderedWriter {
  readonly stream: Writable;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(stream: Writable) {
    this.stream = stream;
  }
  frame(frame: Buffer<ArrayBufferLike>): Promise<void> {
    return this.#enqueue(() => writeFrame(this.stream, frame));
  }
  json(value: unknown): Promise<void> {
    return this.#enqueue(() => writeJsonFrame(this.stream, value as JsonValue));
  }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export class AppServerHost {
  #options: Required<Pick<AppServerHostOptions, "desktopInput" | "desktopOutput" | "diagnosticOutput">> & AppServerHostOptions;
  #official: OfficialAppServerConnection | null = null;
  #externalAdapters: Map<ExternalHarnessId, HarnessAdapter>;
  #externalRuntime: ExternalThreadRuntime;
  #writer: OrderedWriter;
  #repository: ExternalThreadRepository;
  #harnessInspectionCache = new Map<string, HarnessInspection>();
  #harnessInspectionRefreshes = new Map<string, Promise<HarnessInspection>>();
  #pendingDesktopApprovals = new Map<HostApprovalRequestId, PendingDesktopApproval>();
  #pendingDesktopQuestions = new Map<HostQuestionRequestId, PendingDesktopQuestion>();
  #nextApprovalRequestId: HostApprovalRequestId = HOST_APPROVAL_REQUEST_ID_MAX;
  #nextQuestionRequestId: HostQuestionRequestId = HOST_QUESTION_REQUEST_ID_MAX;
  #officialRequestBroker: OfficialRequestBroker;
  #delegationCoordinator: HarnessDelegationCoordinator;
  #unregisterDelegationApi: (() => void) | null = null;
  #activeOfficialTurns = new Map<string, string>();
  #pendingOfficialTurnStarts = new Map<string | number, string>();
  #activeWorkDrainWaiters = new Set<() => void>();
  #pendingOfficialDelegationThreads = new Set<string>();
  #pendingOfficialTerminalStatuses = new Map<string, "completed" | "failed" | "interrupted">();
  #officialUsageByThread = new Map<string, HostUsage>();
  #officialRateLimitUsage: Partial<HostUsage> | null = null;
  #officialRateLimitRefresh: Promise<void> | null = null;
  #officialRateLimitFreshUntilMs = 0;
  #officialAccountGeneration = 0;
  #officialMetadataCache = new Map<string, { response: JsonObject; updatedAtMs: number }>();
  #officialMetadataRefreshes = new Map<string, Promise<JsonObject>>();
  #officialMetadataCacheWrite: Promise<void> | null = null;
  #officialMetadataPrimed = false;
  #routeObservationTracker = new RequestRouteObservationTracker();
  #subagentThreadStatuses = new Map<HostThreadId, "active" | "idle">();
  #goalLoops = new Map<string, GoalLoopState>();
  #goalContinuationTimers = new Map<string, NodeJS.Timeout>();
  #runningSubagentsByParent = new Map<HostThreadId, Set<HostThreadId>>();
  #closeRequested = false;
  #drainActiveWorkOnInputEnd = false;
  #desktopInputEnded = false;
  constructor(options: AppServerHostOptions) {
        this.#options = {
            desktopInput: process.stdin,
            desktopOutput: process.stdout,
            diagnosticOutput: process.stderr,
            ...options,
        };
        this.#writer = new OrderedWriter(this.#options.desktopOutput);
        this.#officialRequestBroker = new OfficialRequestBroker({
            send: async (request) => {
                const official = this.#official;
                if (!official)
                    throw new Error("official app-server is unavailable");
                await writeJsonFrame(official.stdin, request);
            },
        });
        this.#repository = new ExternalThreadRepository(options.mappingStore ??
            createProductionExternalThreadStore(this.#options.environment ?? process.env));
        this.#externalAdapters = new Map(options.externalAdapters);
        for (const [harnessId, adapter] of this.#externalAdapters) {
            if (adapter.harnessId !== harnessId) {
                throw new Error(`External Adapter '${harnessId}' has mismatched Harness ID`);
            }
        }
        this.#externalRuntime = new ExternalThreadRuntime({
            adapters: this.#externalAdapters,
            environment: this.#options.environment ?? process.env,
            repository: this.#repository,
            consumeOutputs: (thread) => this.#consumeHarnessOutputs(thread),
            diagnose: (error) => this.#diagnose(error),
            onRegistered: (thread) => this.#onExternalThreadRegistered(thread),
        });
        this.#delegationCoordinator = new HarnessDelegationCoordinator({
            adapters: this.#externalAdapters,
            environment: this.#options.environment ?? process.env,
            externalRuntime: this.#externalRuntime,
            repository: this.#repository,
            registerExternalThread: (input) => this.#registerExternalThread(input),
            startExternalTurn: (thread, text, turnId) => this.#startDelegatedExternalTurn(thread, text, turnId),
            notifyThreadStarted: (thread) => this.#notifyExternalThreadStarted(thread),
            inspectOfficial: (input) => this.#inspectOfficialDelegationTarget(input),
            readOfficial: (input) => this.#readOfficialDelegationThread(input),
            sendOfficial: (input) => this.#sendOfficialDelegationThread(input),
            cancelOfficial: (input) => this.#cancelOfficialDelegationThread(input),
            startOfficial: (input) => this.#startOfficialDelegation(input),
            listOfficial: (input) => this.#listDelegationThreads(input),
            activeOfficialParents: () => [...this.#activeOfficialTurns.keys()],
        });
        const unregisterDelegationApi = options.onDelegationApi?.({
            inspect: (input) => this.#delegationCoordinator.inspect(input),
            start: (input) => this.#delegationCoordinator.start(input),
            send: (input) => this.#delegationCoordinator.send(input),
            cancel: (input) => this.#delegationCoordinator.cancel(input),
            read: (input) => this.#delegationCoordinator.read(input),
            wait: (input) => this.#delegationCoordinator.wait(input),
            list: (input) => this.#delegationCoordinator.list(input),
            canHandleStart: (input) => this.#canHandleDelegationStart(input),
            ownsThread: (threadId) => this.#ownsDelegationThread(threadId),
        });
        this.#unregisterDelegationApi =
            typeof unregisterDelegationApi === "function" ? unregisterDelegationApi : null;
    }
    close() {
        if (this.#closeRequested)
            return;
        this.#closeRequested = true;
        this.#signalActiveWorkChanged();
        this.#options.desktopInput.destroy();
        this.#terminateOfficial();
    }
    disconnect() {
        if (this.#closeRequested || this.#desktopInputEnded || this.#drainActiveWorkOnInputEnd)
            return;
        this.#drainActiveWorkOnInputEnd = true;
        const desktopInput = this.#options.desktopInput as { end?(): void; destroy(): void };
        if (typeof desktopInput.end === "function")
            desktopInput.end();
        else
            desktopInput.destroy();
    }
    async run() {
        try {
            await this.#repository.initialize();
        }
        catch (error) {
            this.#diagnose(`Mapping Store initialization failed: ${errorMessage(error)}`);
            return 1;
        }
        let official;
        try {
            official = this.#options.createOfficialConnection
                ? await this.#options.createOfficialConnection()
                : spawnOfficialAppServerConnection({
                    stockCodexPath: this.#options.stockCodexPath,
                    arguments: sanitizeOfficialAppServerArguments(this.#options.arguments, this.#options.environment ?? process.env),
                    environment: officialEnvironment(this.#options.environment ?? process.env),
                    ...(this.#options.spawnOfficial ? { spawnOfficial: this.#options.spawnOfficial } : {}),
                });
        }
        catch (error) {
            this.#diagnose(`Official app-server connection failed: ${errorMessage(error)}`);
            await Promise.allSettled([...new Set(this.#externalAdapters.values())].map((adapter) => adapter.close()));
            if (this.#options.closeMappingStoreOnExit !== false) {
                await this.#repository.close().catch((closeError) => this.#diagnose(closeError));
            }
            return 1;
        }
        official.stderr.pipe(this.#options.diagnosticOutput, { end: false });
        this.#official = official;
        await this.#loadOfficialMetadataCache();
        const exited = official.closed;
        if (this.#closeRequested)
            this.#terminateOfficial();
        const forwardDesktop = this.#forwardDesktop();
        const forwardOfficial = this.#forwardOfficial();
        const officialOutput = forwardOfficial.then(() => {
            if (!this.#closeRequested && !this.#desktopInputEnded) {
                throw new Error("official app-server output closed before Desktop input ended");
            }
        });
        const officialExit = exited.then((result) => {
            if (!this.#closeRequested && !this.#desktopInputEnded) {
                const status = result.error
                    ? result.error.message
                    : result.signal
                        ? `signal ${result.signal}`
                        : `code ${String(result.code ?? "unknown")}`;
                throw new Error(`official app-server exited before Desktop input ended (${status})`);
            }
            return result;
        });
        try {
            const [, , result] = await Promise.all([forwardDesktop, officialOutput, officialExit]);
            if (result.error)
                throw result.error;
            if (result.signal) {
                if (this.#closeRequested)
                    return 0;
                throw new Error(`official app-server exited by signal ${result.signal}`);
            }
            return result.code ?? 1;
        }
        catch (error) {
            if (!this.#closeRequested)
                this.#diagnose(error);
            this.#options.desktopInput.destroy();
            this.#terminateOfficial();
            let forwardingSettled = false;
            const forwarding = Promise.allSettled([forwardDesktop, forwardOfficial]).then(() => {
                forwardingSettled = true;
            });
            let drainTimer = null;
            const drainTimeout = new Promise((resolve) => {
                drainTimer = setTimeout(resolve, OFFICIAL_OUTPUT_DRAIN_TIMEOUT_MS);
            });
            await Promise.race([forwarding, drainTimeout]);
            if (drainTimer)
                clearTimeout(drainTimer);
            if (!forwardingSettled) {
                official.stdin.destroy();
                official.stdout.destroy();
                this.#options.desktopOutput.destroy();
            }
            void exited.catch(() => undefined);
            return this.#closeRequested ? 0 : 1;
        }
        finally {
            const threads = this.#externalRuntime.values();
            await Promise.allSettled(threads.map(({ session }) => session.close()));
            await Promise.allSettled(threads.map(({ outputTask }) => outputTask));
            await Promise.allSettled([...new Set(this.#externalAdapters.values())].map((adapter) => adapter.close()));
            for (const pending of [...this.#pendingDesktopApprovals.values()]) {
                await this.#resolveDesktopApproval(pending.interaction.interactionId).catch(() => undefined);
            }
            for (const pending of [...this.#pendingDesktopQuestions.values()]) {
                await this.#resolveDesktopQuestion(pending.interaction.interactionId).catch(() => undefined);
            }
            this.#officialRequestBroker.failAll(new Error("codexhost Host Runtime closed"));
            this.#externalRuntime.clear();
            this.#pendingOfficialTurnStarts.clear();
            for (const timer of this.#goalContinuationTimers.values())
                clearTimeout(timer);
            this.#goalContinuationTimers.clear();
            this.#goalLoops.clear();
            this.#routeObservationTracker.clear();
            this.#officialMetadataCache.clear();
            this.#officialMetadataRefreshes.clear();
            this.#harnessInspectionCache.clear();
            this.#harnessInspectionRefreshes.clear();
            this.#unregisterDelegationApi?.();
            this.#unregisterDelegationApi = null;
            if (this.#options.closeMappingStoreOnExit !== false) {
                await this.#repository.close().catch((error) => this.#diagnose(error));
            }
        }
    }
    #terminateOfficial() {
        const official = this.#official;
        if (!official)
            return;
        official.close();
    }
    #hasActiveWork() {
        return (this.#pendingOfficialTurnStarts.size > 0 ||
            this.#activeOfficialTurns.size > 0 ||
            this.#runningSubagentsByParent.size > 0 ||
            this.#externalRuntime
                .values()
                .some((thread) => thread.running || thread.activeTurnId !== null));
    }
    async #waitForActiveWorkToDrain() {
        while (!this.#closeRequested && this.#hasActiveWork()) {
            await new Promise<void>((resolve) => this.#activeWorkDrainWaiters.add(() => { resolve(); }));
        }
    }
    #signalActiveWorkChanged() {
        if (!this.#closeRequested && this.#hasActiveWork())
            return;
        const waiters = [...this.#activeWorkDrainWaiters];
        this.#activeWorkDrainWaiters.clear();
        for (const resolve of waiters)
            resolve();
    }
    #observeOfficialTurnStartResponse(value: unknown): void {
        if (!isRecord(value) || !("id" in value) || (typeof value.id !== "string" && typeof value.id !== "number"))
            return;
        const threadId = this.#pendingOfficialTurnStarts.get(value.id);
        if (!threadId)
            return;
        this.#pendingOfficialTurnStarts.delete(value.id);
        const result = isRecord(value.result) ? value.result : null;
        const turn = result && isRecord(result.turn) ? result.turn : null;
        if (turn && typeof turn.id === "string") {
            this.#activeOfficialTurns.set(threadId, turn.id);
        }
        this.#signalActiveWorkChanged();
    }
    #forgetPendingOfficialTurnStarts(threadId: string): void {
        for (const [requestId, pendingThreadId] of this.#pendingOfficialTurnStarts) {
            if (pendingThreadId === threadId)
                this.#pendingOfficialTurnStarts.delete(requestId);
        }
    }
    #officialMetadataKey(method: string, params: unknown): string {
        return `${method}\u0000${JSON.stringify(params)}`;
    }
    #officialMetadataCachePath() {
        const environment = this.#options.environment ?? process.env;
        const root = environment.CODEXHOST_DATA_DIR?.trim() ||
            path.join(environment.HOME?.trim() || homedir(), ".codex", "codexhost-cache");
        return path.join(root, "official-metadata-v1.json");
    }
    async #loadOfficialMetadataCache() {
        try {
            const value = JSON.parse(await readFile(this.#officialMetadataCachePath(), "utf8"));
            if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries))
                return;
            for (const entry of value.entries) {
                if (!isRecord(entry) || typeof entry.key !== "string")
                    continue;
                if (!isRecord(entry.response) || typeof entry.updatedAtMs !== "number")
                    continue;
                if (!Number.isFinite(entry.updatedAtMs) || entry.updatedAtMs <= 0)
                    continue;
                const separator = entry.key.indexOf("\u0000");
                if (separator <= 0 || !OFFICIAL_METADATA_CACHE_METHODS.has(entry.key.slice(0, separator))) {
                    continue;
                }
                this.#officialMetadataCache.set(entry.key, {
                    response: entry.response as JsonObject,
                    updatedAtMs: entry.updatedAtMs,
                });
            }
        }
        catch {
            // The cache is an optimization. A missing or corrupt file falls back to
            // the official request path without affecting startup correctness.
        }
    }
    #persistOfficialMetadataCache() {
        const entries = [...this.#officialMetadataCache.entries()].map(([key, entry]) => ({
            key,
            response: entry.response,
            updatedAtMs: entry.updatedAtMs,
        }));
        const filePath = this.#officialMetadataCachePath();
        const previous = this.#officialMetadataCacheWrite ?? Promise.resolve();
        const write = previous
            .catch(() => undefined)
            .then(async () => {
            const directory = path.dirname(filePath);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const temporary = `${filePath}.tmp-${process.pid}`;
            await writeFile(temporary, JSON.stringify({ version: 1, entries }), {
                encoding: "utf8",
                mode: 0o600,
            });
            await rename(temporary, filePath);
        });
        this.#officialMetadataCacheWrite = write.catch((error) => this.#diagnose(error));
    }
    #invalidateOfficialMetadataCache() {
        let changed = false;
        for (const key of this.#officialMetadataCache.keys()) {
            const method = key.split("\u0000", 1)[0];
            if (method === "plugin/list" || method === "plugin/installed") {
                this.#officialMetadataCache.delete(key);
                changed = true;
            }
        }
        if (changed)
            this.#persistOfficialMetadataCache();
    }
    #refreshOfficialMetadata(method: string, params: unknown): Promise<JsonObject> {
        const key = this.#officialMetadataKey(method, params);
        const existing = this.#officialMetadataRefreshes.get(key);
        if (existing)
            return existing;
        const requestParams: JsonObject = isRecord(params) ? (params as JsonObject) : {};
        const refresh = this.#officialRequestBroker
            .request(method, requestParams)
            .then((response) => {
            if ("result" in response) {
                this.#officialMetadataCache.set(key, {
                    response,
                    updatedAtMs: Date.now(),
                });
                this.#persistOfficialMetadataCache();
            }
            return response;
        })
            .finally(() => {
            if (this.#officialMetadataRefreshes.get(key) === refresh) {
                this.#officialMetadataRefreshes.delete(key);
            }
        });
        this.#officialMetadataRefreshes.set(key, refresh);
        return refresh;
    }
    async #handleOfficialMetadataRequest(request: JsonRpcRequest): Promise<boolean> {
        if (!OFFICIAL_METADATA_CACHE_METHODS.has(request.method))
            return false;
        if (request.method.startsWith("plugin/") && request.method !== "plugin/list") {
            this.#invalidateOfficialMetadataCache();
        }
        const params = isRecord(request.params) ? request.params : {};
        const key = this.#officialMetadataKey(request.method, params);
        const cached = this.#officialMetadataCache.get(key);
        const staleAgeMs = cached ? Date.now() - cached.updatedAtMs : Number.POSITIVE_INFINITY;
        if (cached && staleAgeMs <= OFFICIAL_METADATA_STALE_MAX_MS) {
            const { id: _responseId, ...payload } = cached.response;
            await this.#writer.json({
                ...(request.jsonrpc === "2.0" ? { jsonrpc: "2.0" } : {}),
                id: request.id,
                ...payload,
            });
            if (staleAgeMs > OFFICIAL_METADATA_CACHE_TTL_MS) {
                void this.#refreshOfficialMetadata(request.method, params).catch((error: unknown) => this.#diagnose(error));
            }
            return true;
        }
        const response = await this.#refreshOfficialMetadata(request.method, params);
        const { id: _responseId, ...payload } = response;
        await this.#writer.json({
            ...(request.jsonrpc === "2.0" ? { jsonrpc: "2.0" } : {}),
            id: request.id,
            ...payload,
        });
        return true;
    }
    #primeOfficialMetadata() {
        if (this.#officialMetadataPrimed)
            return;
        this.#officialMetadataPrimed = true;
        for (const method of OFFICIAL_METADATA_CACHE_METHODS) {
            void this.#refreshOfficialMetadata(method, {}).catch((error) => this.#diagnose(error));
        }
    }
    async #forwardDesktop() {
        const official = this.#official;
        if (!official)
            throw new Error("official app-server is unavailable");
        for await (let frame of readLfFrames(this.#options.desktopInput)) {
            const parsed = parseJsonFrame(frame);
            if (await this.#handleDesktopApprovalResponse(parsed))
                continue;
            if (await this.#handleDesktopQuestionResponse(parsed))
                continue;
            const requestResult = jsonRpcRequestSchema.safeParse(parsed);
            if (!requestResult.success) {
                await writeFrame(official.stdin, frame);
                continue;
            }
            const request = requestResult.data;
            if (request.method.startsWith("plugin/") &&
                !OFFICIAL_METADATA_CACHE_METHODS.has(request.method)) {
                this.#invalidateOfficialMetadataCache();
            }
            if (request.method === "initialize") {
                await writeFrame(official.stdin, frame);
                this.#primeOfficialMetadata();
                continue;
            }
            if (request.method === "codexhost/update/check" ||
                request.method === "codexhost/update/start" ||
                request.method === "codexhost/update/status") {
                this.#dispatchDesktopRequest(() => this.#handleUpdateRequest(request));
                continue;
            }
            if (request.method === "codexhost/harness/inspect") {
                this.#dispatchDesktopRequest(() => this.#inspectHarness(request));
                continue;
            }
            if (request.method === "codexhost/thread/fork") {
                await this.#forkExternalThreadFromRenderer(request);
                continue;
            }
            if (request.method === "codexhost/thread/inspect") {
                await this.#inspectThread(request);
                continue;
            }
            if (request.method === "codexhost/thread/usage/inspect") {
                await this.#inspectThreadUsage(request);
                continue;
            }
            if (request.method === "codexhost/thread/ownership/list") {
                await this.#listThreadOwnership(request);
                continue;
            }
            if (request.method === "codexhost/thread/handover") {
                await this.#handleThreadHandover(request);
                continue;
            }
            if (request.method === "codexhost/thread/model/select") {
                await this.#selectThreadModel(request);
                continue;
            }
            if (request.method === "codexhost/thread/thinking/select") {
                await this.#selectThreadThinking(request);
                continue;
            }
            if (request.method === "codexhost/thread/permission-mode/select") {
                await this.#selectThreadPermissionMode(request);
                continue;
            }
            if (request.method === "codexhost/thread/commands/inspect") {
                await this.#inspectThreadCommands(request);
                continue;
            }
            if (request.method === "codexhost/thread/command/execute") {
                await this.#executeThreadCommand(request);
                continue;
            }
            if (await this.#handleOfficialMetadataRequest(request))
                continue;
            if (request.method === "thread/list") {
                let listRequest;
                try {
                    const decoded = decodeThreadListRequest(request);
                    if (!decoded)
                        throw new Error("Expected thread/list request");
                    listRequest = decoded;
                }
                catch (error) {
                    await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
                    continue;
                }
                if (!listRequest.supportsExternal) {
                    await writeFrame(official.stdin, frame);
                    continue;
                }
                this.#dispatchDesktopRequest(() => this.#listThreads(request, listRequest));
                continue;
            }
            if (request.method === "thread/archive" || request.method === "thread/unarchive") {
                let threadId;
                try {
                    const decoded = decodeThreadArchiveRequest(request);
                    if (!decoded)
                        throw new Error(`Expected ${request.method} request`);
                    threadId = decoded.threadId;
                }
                catch (error) {
                    await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
                    continue;
                }
                const location = await this.#locateExternalThread(threadId);
                if (await this.#writeResolutionError(request, location))
                    continue;
                if (location.kind === "official") {
                    await writeFrame(official.stdin, frame);
                    continue;
                }
                if (location.kind === "external") {
                    await this.#setExternalThreadArchived(request, location, request.method === "thread/archive");
                }
                continue;
            }
            if (request.method === "thread/metadata/update") {
                let threadId;
                try {
                    const decoded = decodeThreadMetadataUpdateRequest(request);
                    if (!decoded)
                        throw new Error("Expected thread/metadata/update request");
                    threadId = decoded.threadId;
                }
                catch (error) {
                    await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
                    continue;
                }
                const location = await this.#locateExternalThread(threadId);
                if (await this.#writeResolutionError(request, location))
                    continue;
                if (location.kind === "official") {
                    await writeFrame(official.stdin, frame);
                    continue;
                }
                await this.#writer.json(rpcError(request, -32078, "External Thread metadata updates are unsupported"));
                continue;
            }
            if (request.method === "thread/settings/update") {
                const params = requestObject(request);
                const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
                const location = threadId
                    ? await this.#locateExternalThread(threadId)
                    : ({ kind: "official" } as const);
                if (await this.#writeResolutionError(request, location))
                    continue;
                if (location.kind === "official") {
                    await writeFrame(official.stdin, frame);
                    continue;
                }
                if (location.kind === "external") {
                    await this.#updateExternalThreadSettings(request, location);
                    continue;
                }
            }
            let createRoute;
            try {
                createRoute = classifyCreateRequestRoute(request, this.#options.defaultAgent);
            }
            catch (error) {
                await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
                continue;
            }
            if (createRoute) {
                this.#options.onCreateRequestRoute?.(createRoute);
                this.#options.onRequestRoute?.(this.#routeObservationTracker.registerCreate(request.id, createRoute, classifyThreadPurpose(request)));
            }
            if (createRoute && createRoute.selectedHarness !== "codex") {
                await this.#startExternalThread(request, createRoute.selectedHarness);
                continue;
            }
            if (request.method === "thread/fork") {
                const params = isRecord(request.params) ? request.params : {};
                const resolution = typeof params.threadId === "string"
                    ? await this.#resolveExternalThread(params.threadId)
                    : ({ kind: "official" } as const);
                if (resolution.kind === "error") {
                    await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
                    continue;
                }
                if (resolution.kind === "external") {
                    let fork;
                    try {
                        const decoded = decodeThreadForkRequest(request);
                        if (!decoded)
                            throw new Error("Expected thread/fork request");
                        fork = decoded;
                    }
                    catch (error) {
                        await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
                        continue;
                    }
                    await this.#forkExternalThread(request, resolution.thread, fork);
                    continue;
                }
            }
            if (request.method === "thread/revert") {
                const params = isRecord(request.params) ? request.params : {};
                const resolution = typeof params.threadId === "string"
                    ? await this.#resolveExternalThread(params.threadId)
                    : ({ kind: "official" } as const);
                if (resolution.kind === "error") {
                    await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
                    continue;
                }
                if (resolution.kind === "external") {
                    let revert;
                    try {
                        const decoded = decodeThreadRevertRequest(request);
                        if (!decoded)
                            throw new Error("Expected thread/revert request");
                        revert = decoded;
                    }
                    catch (error) {
                        await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
                        continue;
                    }
                    await this.#revertExternalThread(request, resolution.thread, revert);
                    continue;
                }
            }
            if (request.method === "thread/rollback") {
                const params = isRecord(request.params) ? request.params : {};
                const resolution = typeof params.threadId === "string"
                    ? await this.#resolveExternalThread(params.threadId)
                    : ({ kind: "official" } as const);
                if (resolution.kind === "error") {
                    await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
                    continue;
                }
                if (resolution.kind === "external") {
                    let rollback;
                    try {
                        const decoded = decodeThreadRollbackRequest(request);
                        if (!decoded)
                            throw new Error("Expected thread/rollback request");
                        rollback = decoded;
                    }
                    catch (error) {
                        await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
                        continue;
                    }
                    await this.#rollbackExternalThread(request, resolution.thread, rollback);
                    continue;
                }
            }
            if (request.method === "thread/turns/list" || request.method === "thread/items/list") {
                const params = requestObject(request);
                const location = typeof params.threadId === "string"
                    ? await this.#locateExternalThread(params.threadId)
                    : ({ kind: "official" } as const);
                if (await this.#writeResolutionError(request, location))
                    continue;
                if (location.kind === "external") {
                    const cached = await this.#externalRuntime.readCached(location);
                    if (cached) {
                        await this.#writeCachedExternalHistory(request, cached.turns, params);
                        this.#externalRuntime.prewarm(location.record.hostThreadId);
                        continue;
                    }
                }
                const resolution = location.kind === "external"
                    ? await this.#resolveExternalThread(location.record.hostThreadId)
                    : location;
                if (await this.#writeResolutionError(request, resolution))
                    continue;
                if (resolution.kind === "external") {
                    await this.#listExternalHistory(request, resolution.thread, params, resolution.historyFresh);
                    continue;
                }
            }
            if (request.method === "turn/start") {
                const params = requestObject(request);
                const threadId = params.threadId;
                const resolution = typeof threadId === "string"
                    ? await this.#resolveExternalThread(threadId)
                    : ({ kind: "official" } as const);
                if (typeof threadId === "string") {
                    this.#options.onRequestRoute?.(this.#routeObservationTracker.observeTurn(threadId, resolution.kind === "external" ? resolution.thread.harnessId : "codex"));
                }
                if (await this.#writeResolutionError(request, resolution))
                    continue;
                if (resolution.kind === "external") {
                    let route = null;
                    if (typeof params.model === "string") {
                        try {
                            route = decodeCreateRoute({ id: request.id, method: "thread/start", params });
                        }
                        catch {
                            route = null;
                        }
                    }
                    if (route &&
                        route.harnessId === "codex" &&
                        typeof params.model === "string" &&
                        (params.model === "codex" ||
                            params.model === "codexhost/codex-native" ||
                            params.model.startsWith("codexhost/codex-native@"))) {
                        await this.#handoverExternalThreadToOfficial(request, resolution.thread, frame);
                        if (typeof threadId === "string") {
                            this.#pendingOfficialTurnStarts.set(request.id, threadId);
                        }
                        continue;
                    }
                    await this.#startExternalTurn(request, resolution.thread);
                    continue;
                }
                if (typeof threadId === "string" && typeof params.model === "string") {
                    let route = null;
                    try {
                        route = decodeCreateRoute({ id: request.id, method: "thread/start", params });
                    }
                    catch {
                        route = null;
                    }
                    if (route && route.harnessId !== "codex") {
                        await this.#handoverOfficialThreadToExternal(request, threadId, route);
                        continue;
                    }
                }
                if (typeof threadId === "string") {
                    this.#pendingOfficialTurnStarts.set(request.id, threadId);
                }
            }
            if (request.method === "turn/interrupt") {
                const params = requestObject(request);
                const resolution = typeof params.threadId === "string"
                    ? await this.#resolveExternalThread(params.threadId)
                    : ({ kind: "official" } as const);
                if (await this.#writeResolutionError(request, resolution))
                    continue;
                if (resolution.kind === "external") {
                    await this.#interruptExternalTurn(request, resolution.thread, params.turnId);
                    continue;
                }
            }
            if (request.method === "thread/goal/set") {
                const params = requestObject(request);
                const threadId = params.threadId;
                const resolution = typeof threadId === "string"
                    ? await this.#resolveExternalThread(threadId)
                    : ({ kind: "official" } as const);
                if (await this.#writeResolutionError(request, resolution))
                    continue;
                if (resolution.kind === "external") {
                    this.#traceGoal("own", request.method, typeof params.threadId === "string" ? params.threadId : undefined);
                    await this.#setExternalThreadGoal(request, resolution.thread);
                    continue;
                }
            }
            if (request.method === "thread/goal/clear") {
                const params = requestObject(request);
                const threadId = params.threadId;
                const resolution = typeof threadId === "string"
                    ? await this.#resolveExternalThread(threadId)
                    : ({ kind: "official" } as const);
                if (await this.#writeResolutionError(request, resolution))
                    continue;
                if (resolution.kind === "external") {
                    this.#traceGoal("own", request.method, typeof params.threadId === "string" ? params.threadId : undefined);
                    await this.#clearExternalThreadGoal(request, resolution.thread);
                    continue;
                }
            }
            if (request.method === "thread/goal/get") {
                const params = requestObject(request);
                const threadId = params.threadId;
                const location = typeof threadId === "string"
                    ? await this.#locateExternalThread(threadId)
                    : ({ kind: "official" } as const);
                if (await this.#writeResolutionError(request, location))
                    continue;
                if (location.kind === "external" && !location.thread) {
                    // Goal state is persisted in the Mapping Store. Reading it must not
                    // restore an AGY process or contact the upstream provider just to
                    // paint the native Goal UI for a cold historical Thread.
                    await this.#getCachedExternalThreadGoal(request, location.record);
                    this.#externalRuntime.prewarm(location.record.hostThreadId);
                    continue;
                }
                if (location.kind === "external") {
                    const thread = location.thread;
                    if (!thread)
                        continue;
                    this.#traceGoal("own", request.method, typeof params.threadId === "string" ? params.threadId : undefined);
                    await this.#getExternalThreadGoal(request, thread);
                    continue;
                }
            }
            if (request.method === "thread/read") {
                const params = requestObject(request);
                const location = typeof params.threadId === "string"
                    ? await this.#locateExternalThread(params.threadId)
                    : ({ kind: "official" } as const);
                if (location.kind === "error") {
                    await this.#writer.json(rpcError(request, location.error.code, location.error.message));
                    continue;
                }
                if (location.kind === "official") {
                    await writeFrame(official.stdin, frame);
                    continue;
                }
                if (params.includeTurns !== true) {
                    await this.#readExternalThreadMetadata(request, location);
                    continue;
                }
                if (location.record.historyMode === "paginated") {
                    await this.#writer.json(rpcError(request, -32602, "Paginated External Threads require thread/turns/list"));
                    continue;
                }
                const cached = await this.#externalRuntime.readCached(location);
                if (cached) {
                    await this.#writer.json(rpcEnvelope(request, {
                        result: {
                            thread: {
                                ...cached.thread,
                                turns: cached.turns,
                            },
                        },
                    }));
                    // Painting local history must not make the first user turn race a
                    // second restore; the runtime coalesces this background warm-up.
                    this.#externalRuntime.prewarm(location.record.hostThreadId);
                    continue;
                }
            }
            if (request.method === "thread/read" || request.method === "thread/resume") {
                const params = requestObject(request);
                if (request.method === "thread/resume" && typeof params.threadId === "string") {
                    const location = await this.#locateExternalThread(params.threadId);
                    if (await this.#writeResolutionError(request, location))
                        continue;
                    if (location.kind === "external") {
                        const cached = await this.#externalRuntime.readCached(location);
                        if (cached) {
                            await this.#resumeCachedExternalThread(request, cached, params);
                            this.#externalRuntime.prewarm(location.record.hostThreadId);
                            continue;
                        }
                    }
                }
                const resolution = typeof params.threadId === "string"
                    ? await this.#resolveExternalThread(params.threadId)
                    : ({ kind: "official" } as const);
                if (await this.#writeResolutionError(request, resolution))
                    continue;
                if (resolution.kind === "external") {
                    if (request.method === "thread/read") {
                        await this.#readExternalThread(request, resolution.thread, params.includeTurns === true, resolution.historyFresh);
                    }
                    else {
                        await this.#resumeExternalThread(request, resolution.thread, params, resolution.historyFresh);
                    }
                    continue;
                }
            }
            if (request.method === "thread/unsubscribe") {
                const params = requestObject(request);
                if (typeof params.threadId === "string") {
                    const location = await this.#locateExternalThread(params.threadId);
                    if (await this.#writeResolutionError(request, location))
                        continue;
                    if (location.kind === "official") {
                        await writeFrame(official.stdin, frame);
                        continue;
                    }
                    if (location.kind === "external") {
                        await this.#writer.json(rpcEnvelope(request, {
                            result: { status: location.thread ? "notSubscribed" : "notLoaded" },
                        }));
                        continue;
                    }
                }
            }
            if (request.method === "thread/name/set" || request.method === "thread/delete") {
                const params = requestObject(request);
                const location = typeof params.threadId === "string"
                    ? await this.#locateExternalThread(params.threadId)
                    : ({ kind: "official" } as const);
                if (await this.#writeResolutionError(request, location))
                    continue;
                if (location.kind === "external") {
                    if (request.method === "thread/name/set") {
                        const rawName = typeof params.name === "string" ? params.name : "";
                        const normalizedName = this.#options.normalizeThreadTitles
                            ? normalizeThreadTitle(rawName)
                            : rawName;
                        await this.#setExternalThreadName(request, location, normalizedName);
                    }
                    else {
                        await this.#deleteExternalThread(request, location);
                    }
                    continue;
                }
                else if (request.method === "thread/name/set") {
                    const rawName = typeof params.name === "string" ? params.name : "";
                    const normalizedName = this.#options.normalizeThreadTitles
                        ? normalizeThreadTitle(rawName)
                        : rawName;
                    const modifiedRequest = {
                        ...request,
                        params: {
                            ...params,
                            name: normalizedName,
                        },
                    };
                    frame = Buffer.from(JSON.stringify(modifiedRequest) + "\n");
                }
            }
            if (request.method.startsWith("thread/") &&
                !EXPLICIT_EXTERNAL_THREAD_METHODS.has(request.method) &&
                isRecord(request.params) &&
                typeof request.params.threadId === "string") {
                const location = await this.#locateExternalThread(request.params.threadId);
                if (await this.#writeResolutionError(request, location))
                    continue;
                if (location.kind === "external") {
                    await this.#writer.json(rpcError(request, -32076, `External Thread does not support ${request.method}`));
                    continue;
                }
            }
            if (request.method === "thread/goal/set" ||
                request.method === "thread/goal/clear" ||
                request.method === "thread/goal/get") {
                // Goal RPCs that fall through here were NOT handled as codexhost-owned
                // (their threadId did not resolve as an external/bridged thread). They now
                // get forwarded to the official binary, which rejects foreign/ephemeral
                // threads and is what surfaces as the desktop “设置目标模式错误”.
                this.#traceGoal("forward", request.method, isRecord(request.params) && typeof request.params.threadId === "string" ? request.params.threadId : undefined);
            }
            try {
                await writeFrame(official.stdin, frame);
            }
            catch (error) {
                if (request.method === "turn/start") {
                    this.#pendingOfficialTurnStarts.delete(request.id);
                    this.#signalActiveWorkChanged();
                }
                throw error;
            }
        }
        this.#desktopInputEnded = true;
        if (this.#drainActiveWorkOnInputEnd)
            await this.#waitForActiveWorkToDrain();
        if (!this.#closeRequested)
            official.stdin.end();
    }
    async #forwardOfficial() {
        const official = this.#official;
        if (!official)
            throw new Error("official app-server is unavailable");
        try {
            const frames = readLfFrames(official.stdout)[Symbol.asyncIterator]();
            let current = await frames.next();
            while (!current.done) {
                let frame = current.value;
                const following = frames.next();
                const parsed = parseJsonFrame(frame);
                if (this.#options.normalizeThreadTitles &&
                    isRecord(parsed) &&
                    parsed.method === "thread/name/updated" &&
                    isRecord(parsed.params) &&
                    typeof parsed.params.threadName === "string") {
                    const normalized = normalizeThreadTitle(parsed.params.threadName);
                    if (normalized !== parsed.params.threadName) {
                        parsed.params.threadName = normalized;
                        frame = Buffer.from(JSON.stringify(parsed) + "\n");
                    }
                }
                this.#observeOfficialTurnStartResponse(parsed);
                if (isRecord(parsed) && parsed.method === "account/updated")
                    this.#resetOfficialUsageState();
                if (this.#officialRequestBroker.handle(parsed)) {
                    current = await following;
                    continue;
                }
                const tokenUsage = observeCodexTokenUsage(parsed);
                if (tokenUsage) {
                    const previous = this.#officialUsageByThread.get(tokenUsage.threadId);
                    try {
                        this.#officialUsageByThread.set(tokenUsage.threadId, parseHostUsage({ ...(previous ?? {}), ...tokenUsage.usage }));
                    }
                    catch {
                        // Ignore an invalid native observation while preserving the official frame.
                    }
                }
                const rateLimits = observeCodexRateLimits(parsed);
                if (rateLimits)
                    this.#mergeOfficialRateLimits(rateLimits, "push");
                try {
                    await this.#observeOfficialTurnLifecycle(parsed);
                }
                catch (error) {
                    this.#diagnose(error);
                }
                this.#routeObservationTracker.bindOfficialResponse(parsed);
                const prematureOutputEnd = following.then((result) => {
                    if (!result.done || this.#closeRequested || this.#desktopInputEnded)
                        return NEVER_SETTLES;
                    throw new Error("official app-server output closed before Desktop input ended");
                });
                await Promise.race([this.#writer.frame(frame), prematureOutputEnd]);
                current = await following;
            }
        }
        finally {
            this.#officialRequestBroker.failAll(new Error("official app-server output closed"));
        }
    }
    async #observeOfficialTurnLifecycle(value: unknown): Promise<void> {
        if (!isRecord(value) || !isRecord(value.params))
            return;
        const params = value.params;
        if (value.method === "turn/started" && typeof params.threadId === "string") {
            const turn = isRecord(params.turn) ? params.turn : null;
            if (turn && typeof turn.id === "string") {
                this.#forgetPendingOfficialTurnStarts(params.threadId);
                this.#activeOfficialTurns.set(params.threadId, turn.id);
            }
        }
        if (value.method === "turn/completed" && typeof params.threadId === "string") {
            this.#forgetPendingOfficialTurnStarts(params.threadId);
            this.#activeOfficialTurns.delete(params.threadId);
            this.#signalActiveWorkChanged();
            const delegation = await this.#repository.getDelegationByChild(hostThreadIdSchema.parse(params.threadId));
            const turn = isRecord(params.turn) ? params.turn : null;
            const status = turn?.status === "failed"
                ? "failed"
                : turn?.status === "interrupted" || turn?.status === "cancelled"
                    ? "interrupted"
                    : "completed";
            if (this.#pendingOfficialDelegationThreads.has(params.threadId)) {
                this.#pendingOfficialTerminalStatuses.set(params.threadId, status);
            }
            if (delegation) {
                await this.#repository.setDelegationStatus(delegation.delegationId, status);
            }
        }
    }
    async #canHandleDelegationStart(input: DelegationStartInput): Promise<boolean> {
        if (input.parentThreadId)
            return this.#ownsDelegationThread(input.parentThreadId);
        const externalActive = this.#externalRuntime.values().some((thread) => thread.running);
        return externalActive || this.#activeOfficialTurns.size > 0;
    }
    async #ownsDelegationThread(threadId: string): Promise<boolean> {
        if (this.#externalRuntime.get(threadId) !== undefined ||
            this.#activeOfficialTurns.has(threadId)) {
            return true;
        }
        const parsed = hostThreadIdSchema.safeParse(threadId);
        if (!parsed.success)
            return false;
        const [thread, childDelegation, delegation] = await Promise.all([
            this.#repository.find(parsed.data),
            this.#repository.getDelegationByChild(parsed.data),
            this.#repository.getDelegation(parsed.data),
        ]);
        return thread !== null || childDelegation !== null || delegation !== null;
    }
    async #inspectOfficialDelegationTarget(input: HarnessInspectInput): Promise<HarnessInspectResult> {
        const response = await this.#officialRequestBroker.request("model/list", {});
        if (isRecord(response.error)) {
            throw new DelegationControlError("DELEGATION_FAILED", typeof response.error.message === "string"
                ? response.error.message
                : "Official Model catalog could not be read");
        }
        const result = isRecord(response.result) ? response.result : null;
        const data = result && Array.isArray(result.data) ? result.data : [];
        const thinkingById = new Map();
        const models = data.flatMap((candidate) => {
            if (!isRecord(candidate) || typeof candidate.model !== "string" || !candidate.model.trim()) {
                return [];
            }
            const supportedThinkingOptionIds = Array.isArray(candidate.supportedReasoningEfforts)
                ? candidate.supportedReasoningEfforts.flatMap((option) => {
                    if (!isRecord(option) ||
                        typeof option.reasoningEffort !== "string" ||
                        !option.reasoningEffort.trim()) {
                        return [];
                    }
                    const id = harnessThinkingOptionIdSchema.safeParse(option.reasoningEffort);
                    if (!id.success)
                        return [];
                    thinkingById.set(id.data, typeof option.description === "string" && option.description.trim()
                        ? option.description
                        : option.reasoningEffort);
                    return [id.data];
                })
                : [];
            return [
                {
                    ref: encodeOfficialCodexModelRef(candidate.model),
                    label: typeof candidate.displayName === "string" && candidate.displayName.trim()
                        ? candidate.displayName
                        : candidate.model,
                    ...(supportedThinkingOptionIds.length > 0 ? { supportedThinkingOptionIds } : {}),
                },
            ];
        });
        const defaultEntry = data.find((candidate) => isRecord(candidate) && candidate.isDefault === true);
        const defaultModel = isRecord(defaultEntry) && typeof defaultEntry.model === "string"
            ? encodeOfficialCodexModelRef(defaultEntry.model)
            : undefined;
        return {
            harnessId: input.harnessId,
            inspection: {
                status: "ready",
                catalog: {
                    models,
                    ...(defaultModel ? { defaultModel } : {}),
                    thinkingOptions: [...thinkingById].map(([id, label]) => ({ id, label })),
                },
                capabilities: {
                    configuration: {
                        selectModel: models.length > 0,
                        selectThinkingOption: thinkingById.size > 0,
                        selectPermissionMode: false,
                        permissionModeScope: "live",
                    },
                    history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
                },
            },
        };
    }
    async #startOfficialDelegation(input: DelegationStartInput): Promise<DelegationStartResult> {
        let requestedModel;
        try {
            requestedModel = input.model ? canonicalizeOfficialCodexModelRef(input.model) : undefined;
        }
        catch {
            throw new DelegationControlError("INVALID_ARGUMENT", "Official Model Ref is invalid");
        }
        const nativeModelId = requestedModel ? decodeOfficialCodexModelRef(requestedModel) : undefined;
        const digest = createHash("sha256")
            .update(JSON.stringify({
            task: input.task,
            cwd: input.cwd,
            modelId: requestedModel?.id ?? null,
            thinkingOptionId: input.thinkingOptionId ?? null,
        }))
            .digest("hex");
        const existing = input.requestId
            ? await this.#repository.findDelegationByRequest(input.requestId)
            : await this.#repository.findRecentDelegation({
                parentHostThreadId: hostThreadIdSchema.parse(input.parentThreadId),
                targetHarnessId: harnessIdSchema.parse("codex"),
                taskDigest: digest,
                since: new Date(Date.now() - 30_000),
            });
        if (existing &&
            input.requestId &&
            (existing.targetHarnessId !== "codex" || existing.taskDigest !== digest)) {
            throw new DelegationControlError("INVALID_ARGUMENT", "Request ID is already associated with another Delegation configuration");
        }
        if (existing) {
            const turnId = this.#activeOfficialTurns.get(existing.childHostThreadId) ?? "pending";
            return {
                delegationId: existing.delegationId,
                threadId: existing.childHostThreadId,
                turnId,
                harnessId: "codex",
                deepLink: `codex://threads/${existing.childHostThreadId}`,
                status: existing.status,
                next: {
                    read: `codexhost thread read ${existing.childHostThreadId}`,
                    wait: `codexhost thread wait ${existing.childHostThreadId} --timeout-ms 30000`,
                },
            };
        }
        if (requestedModel || input.thinkingOptionId) {
            const inspected = await this.#inspectOfficialDelegationTarget({
                harnessId: "codex",
                cwd: input.cwd,
            });
            if (inspected.inspection.status !== "ready") {
                throw new DelegationControlError("DELEGATION_FAILED", "Official Model catalog is unavailable");
            }
            if (requestedModel &&
                !inspected.inspection.catalog.models.some((candidate) => candidate.ref.id === requestedModel.id)) {
                throw new DelegationControlError("INVALID_ARGUMENT", "Official Model is unavailable", {
                    validModelIds: inspected.inspection.catalog.models.map((candidate) => candidate.ref.id),
                });
            }
            if (input.thinkingOptionId) {
                const selectedModel = requestedModel ?? inspected.inspection.catalog.defaultModel;
                const selectedEntry = selectedModel
                    ? inspected.inspection.catalog.models.find((candidate) => candidate.ref.id === selectedModel.id)
                    : undefined;
                const validThinkingOptionIds = selectedEntry?.supportedThinkingOptionIds ?? [];
                if (!validThinkingOptionIds.includes(input.thinkingOptionId)) {
                    throw new DelegationControlError("INVALID_ARGUMENT", "Official Thinking option is unavailable for the selected Model", { validThinkingOptionIds });
                }
            }
        }
        const started = await this.#officialRequestBroker.request("thread/start", {
            cwd: input.cwd,
            ...(nativeModelId ? { model: nativeModelId } : {}),
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            ephemeral: false,
            historyMode: "paginated",
        });
        const startedResult = isRecord(started.result) ? started.result : null;
        const thread = startedResult && isRecord(startedResult.thread) ? startedResult.thread : null;
        const threadId = thread && typeof thread.id === "string" ? thread.id : null;
        if (!threadId)
            throw new Error("Official thread/start returned no Thread identity");
        this.#pendingOfficialDelegationThreads.add(threadId);
        let turnId;
        try {
            const turn = await this.#officialRequestBroker.request("turn/start", {
                threadId,
                input: [{ type: "text", text: input.task }],
                ...(nativeModelId ? { model: nativeModelId } : {}),
                ...(input.thinkingOptionId ? { effort: input.thinkingOptionId } : {}),
            });
            const turnResult = isRecord(turn.result) ? turn.result : null;
            const turnValue = turnResult && isRecord(turnResult.turn) ? turnResult.turn : null;
            const parsedTurnId = turnValue && typeof turnValue.id === "string" ? turnValue.id : null;
            if (!parsedTurnId)
                throw new Error("Official turn/start returned no Turn identity");
            turnId = parsedTurnId;
        }
        catch (error) {
            this.#pendingOfficialDelegationThreads.delete(threadId);
            this.#pendingOfficialTerminalStatuses.delete(threadId);
            await this.#officialRequestBroker
                .request("thread/delete", { threadId })
                .catch(() => undefined);
            throw error;
        }
        this.#activeOfficialTurns.set(threadId, turnId);
        const delegationId = hostThreadIdSchema.parse(randomUUID());
        try {
            const parentHostThreadId = input.parentThreadId ? hostThreadIdSchema.parse(input.parentThreadId) : hostThreadIdSchema.parse(threadId);
            const source = input.parentThreadId ? await this.#repository.find(input.parentThreadId) : null;
            const pendingTerminal = this.#pendingOfficialTerminalStatuses.get(threadId);
            await this.#repository.createDelegation({
                delegationId,
                parentHostThreadId,
                childHostThreadId: hostThreadIdSchema.parse(threadId),
                sourceHarnessId: source?.harnessId ?? harnessIdSchema.parse("codex"),
                targetHarnessId: harnessIdSchema.parse("codex"),
                status: pendingTerminal ?? "running",
                ...(input.requestId ? { requestId: input.requestId } : {}),
                taskDigest: digest,
            });
            return {
                delegationId,
                threadId,
                turnId,
                harnessId: "codex",
                deepLink: `codex://threads/${threadId}`,
                status: pendingTerminal ?? "running",
                ...(requestedModel || input.thinkingOptionId
                    ? {
                        configuration: {
                            requested: {
                                ...(requestedModel ? { model: requestedModel } : {}),
                                ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
                            },
                            effective: {
                                ...(startedResult && typeof startedResult.model === "string"
                                    ? { effectiveModel: encodeOfficialCodexModelRef(startedResult.model) }
                                    : {}),
                            },
                        },
                    }
                    : {}),
                next: {
                    read: `codexhost thread read ${threadId}`,
                    wait: `codexhost thread wait ${threadId} --timeout-ms 30000`,
                },
            };
        }
        catch (error) {
            this.#activeOfficialTurns.delete(threadId);
            this.#signalActiveWorkChanged();
            await this.#officialRequestBroker
                .request("thread/delete", { threadId })
                .catch(() => undefined);
            throw error;
        }
        finally {
            this.#pendingOfficialDelegationThreads.delete(threadId);
            this.#pendingOfficialTerminalStatuses.delete(threadId);
        }
    }
    async #sendOfficialDelegationThread(input: ThreadSendInput): Promise<ThreadSendResult> {
        if (!input.message?.trim()) {
            throw new DelegationControlError("INVALID_ARGUMENT", "Message must not be empty");
        }
        if (this.#activeOfficialTurns.has(input.threadId)) {
            throw new DelegationControlError("THREAD_BUSY", "Thread already has an active Turn");
        }
        const current = await this.#officialRequestBroker.request("thread/read", {
            threadId: input.threadId,
            includeTurns: true,
        });
        if (isRecord(current.error) || !isRecord(current.result)) {
            throw new DelegationControlError("THREAD_NOT_FOUND", "Official Thread was not found");
        }
        const currentThread = isRecord(current.result.thread) ? current.result.thread : null;
        const currentTurns = currentThread && Array.isArray(currentThread.turns) ? currentThread.turns : [];
        const latestTurn = currentTurns.at(-1);
        if ((currentThread && isRecord(currentThread.status) && currentThread.status.type === "active") ||
            (isRecord(latestTurn) &&
                (latestTurn.status === "inProgress" || latestTurn.status === "running"))) {
            throw new DelegationControlError("THREAD_BUSY", "Thread already has an active Turn");
        }
        const response = await this.#officialRequestBroker.request("turn/start", {
            threadId: input.threadId,
            input: [{ type: "text", text: input.message }],
        });
        if (isRecord(response.error)) {
            throw new DelegationControlError("DELEGATION_FAILED", typeof response.error.message === "string" ? response.error.message : "Turn start failed");
        }
        const result = isRecord(response.result) ? response.result : null;
        const turn = result && isRecord(result.turn) ? result.turn : null;
        const turnId = turn && typeof turn.id === "string" ? turn.id : null;
        if (!turnId)
            throw new Error("Official turn/start returned no Turn identity");
        this.#activeOfficialTurns.set(input.threadId, turnId);
        return {
            threadId: input.threadId,
            turnId,
            harnessId: "codex",
            status: "running",
            next: {
                read: `codexhost thread read ${input.threadId}`,
                wait: `codexhost thread wait ${input.threadId} --timeout-ms 30000`,
            },
        };
    }
    async #cancelOfficialDelegationThread(input: ThreadCancelInput): Promise<ThreadCancelResult> {
        let turnId = this.#activeOfficialTurns.get(input.threadId);
        if (!turnId) {
            const current = await this.#officialRequestBroker.request("thread/read", {
                threadId: input.threadId,
                includeTurns: true,
            });
            if (isRecord(current.error) || !isRecord(current.result)) {
                throw new DelegationControlError("THREAD_NOT_FOUND", "Official Thread was not found");
            }
            const currentThread = isRecord(current.result.thread) ? current.result.thread : null;
            const currentTurns = currentThread && Array.isArray(currentThread.turns) ? currentThread.turns : [];
            const latestTurn = currentTurns.at(-1);
            if (isRecord(latestTurn) &&
                typeof latestTurn.id === "string" &&
                (latestTurn.status === "inProgress" || latestTurn.status === "running")) {
                turnId = latestTurn.id;
                this.#activeOfficialTurns.set(input.threadId, turnId);
            }
            else {
                return { threadId: input.threadId, turnId: null, harnessId: "codex", cancelled: false };
            }
        }
        const response = await this.#officialRequestBroker.request("turn/interrupt", {
            threadId: input.threadId,
            turnId,
        });
        if (isRecord(response.error)) {
            throw new DelegationControlError("DELEGATION_FAILED", typeof response.error.message === "string" ? response.error.message : "Turn cancel failed");
        }
        return { threadId: input.threadId, turnId, harnessId: "codex", cancelled: true };
    }
    async #readOfficialDelegationThread(input: ThreadReadInput): Promise<DelegationThreadSnapshot> {
        const response = await this.#officialRequestBroker.request("thread/read", {
            threadId: input.threadId,
            includeTurns: true,
        });
        if (isRecord(response.error)) {
            throw new DelegationControlError("THREAD_NOT_FOUND", typeof response.error.message === "string"
                ? response.error.message
                : "Official Thread was not found");
        }
        const result = isRecord(response.result) ? response.result : null;
        const thread = result && isRecord(result.thread) ? result.thread : null;
        if (!thread)
            throw new DelegationControlError("THREAD_NOT_FOUND", "Official Thread was not found");
        const turns = Array.isArray(thread.turns)
            ? thread.turns.filter((turn) => isRecord(turn))
            : [];
        const running = this.#activeOfficialTurns.has(input.threadId) ||
            (isRecord(thread.status) && thread.status.type === "active");
        const snapshot = projectDelegationThreadSnapshot({
            threadId: input.threadId,
            harnessId: "codex",
            thread,
            turns,
            running,
            view: input.view,
            ...(input.cursor ? { cursor: input.cursor } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        const delegation = await this.#repository.getDelegationByChild(hostThreadIdSchema.parse(input.threadId));
        if (delegation && delegation.status !== snapshot.status) {
            await this.#repository.setDelegationStatus(delegation.delegationId, snapshot.status);
        }
        return snapshot;
    }
    async #listDelegationThreads(input: ThreadListInput): Promise<DelegationThreadListResult> {
        const [sortKey, sortDirection] = input.sort.split("-");
        const request = {
            id: `codexhost:delegation-list:${randomUUID()}`,
            method: "thread/list",
            params: {
                cwd: input.cwd ? [input.cwd] : null,
                limit: input.limit,
                cursor: input.cursor ?? null,
                sortKey: `${sortKey}_at`,
                ...(sortDirection ? { sortDirection } : {}),
            },
        };
        const decoded = decodeThreadListRequest(request as JsonRpcRequest);
        if (!decoded)
            throw new Error("Delegation thread/list request could not be decoded");
        const records = await this.#repository.list();
        const result = await aggregateThreadList({
            query: decoded,
            records,
            runtimeFor: (threadId) => {
                const thread = this.#externalRuntime.get(threadId);
                return thread ? { running: thread.running } : null;
            },
            requestOfficialPage: async (params) => officialThreadListPageFromResponse(await this.#officialRequestBroker.request("thread/list", params)),
        });
        return {
            threads: result.data.flatMap((entry) => {
                if (typeof entry.id !== "string")
                    return [];
                const record = records.find((candidate) => candidate.hostThreadId === entry.id);
                const status = isRecord(entry.status) && entry.status.type === "active" ? "running" : "completed";
                return [
                    {
                        threadId: entry.id,
                        harnessId: record ? (record.harnessId as RoutedHarnessId) : "codex",
                        deepLink: `codex://threads/${entry.id}`,
                        status,
                        ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
                        ...(typeof entry.name === "string"
                            ? { title: entry.name }
                            : typeof entry.preview === "string"
                                ? { title: entry.preview }
                                : {}),
                    },
                ];
            }),
            nextCursor: result.nextCursor,
        };
    }
    async #listThreads(
        request: JsonRpcRequest,
        listRequest: DecodedThreadListRequest,
    ): Promise<void> {
        try {
            const records = await this.#repository.list();
            const result = await aggregateThreadList({
                query: listRequest,
                records,
                runtimeFor: (threadId) => {
                    const thread = this.#externalRuntime.get(threadId);
                    return thread ? { running: thread.running } : null;
                },
                requestOfficialPage: async (params) => officialThreadListPageFromResponse(await this.#officialRequestBroker.request("thread/list", params)),
            });
            await this.#writer.json(rpcEnvelope(request, { result }));
        }
        catch (error) {
            if (error instanceof OfficialThreadListError) {
                await this.#writer.json(rpcEnvelope(request, { error: error.rpcError }));
                return;
            }
            await this.#writer.json(rpcError(request, -32082, "Thread list aggregation failed"));
            this.#diagnose(error);
        }
    }
    async #setExternalThreadArchived(
        request: JsonRpcRequest,
        location: Extract<ExternalThreadLocation, { kind: "external" }>,
        archived: boolean,
    ): Promise<void> {
        if (location.record.state !== "ready" || !location.record.nativeSessionRef) {
            await this.#writer.json(rpcError(request, -32079, "External Native Session is unavailable"));
            return;
        }
        const sessionId = location.thread?.sessionId ??
            (await this.#repository.sessionTreeId(location.record).catch(() => null));
        if (!sessionId) {
            await this.#writer.json(rpcError(request, -32081, "External Thread metadata could not be projected"));
            return;
        }
        let record;
        try {
            record = await this.#repository.setArchived(location.record.hostThreadId, archived);
        }
        catch {
            await this.#writer.json(rpcError(request, -32081, "External Thread archive state could not be persisted"));
            return;
        }
        const projected = externalThreadValue({
            record,
            turns: [],
            sessionId,
            ...(location.thread ? { running: location.thread.running } : { loaded: false }),
        });
        if (location.thread) {
            location.thread.record = record;
            location.thread.thread = {
                ...location.thread.thread,
                ...projected,
                turns: location.thread.thread.turns ?? [],
            };
        }
        await this.#writer.json(rpcEnvelope(request, { result: archived ? {} : { thread: projected } }));
        await this.#writer.json({
            method: archived ? "thread/archived" : "thread/unarchived",
            params: { threadId: record.hostThreadId },
        });
    }
    async #updateExternalThreadSettings(
        request: JsonRpcRequest,
        location: Extract<ExternalThreadLocation, { kind: "external" }>,
    ): Promise<void> {
        const params = requestObject(request);
        let record = location.record;
        let transportModelId =
            typeof params.model === "string" && params.model.length > 0 ? params.model : undefined;
        if (transportModelId && transportModelId !== record.transportModelId) {
            const harnessId = this.#externalAdapters.has(record.harnessId as ExternalHarnessId)
                ? (record.harnessId as ExternalHarnessId)
                : null;
            let selection: ReturnType<typeof decodeExternalTransportSelection> = null;
            if (harnessId) {
                try {
                    selection = decodeExternalTransportSelection(harnessId, transportModelId);
                }
                catch {
                    selection = null;
                }
            }
            if (selection === null) {
                if (!harnessId || transportModelId.startsWith("codexhost/")) {
                    await this.#writer.json(rpcError(request, -32602, `Model '${transportModelId}' is not a valid selection for the current Harness`));
                    return;
                }
                const parsedModel = harnessModelRefSchema.safeParse({ id: transportModelId });
                if (!parsedModel.success) {
                    await this.#writer.json(rpcError(request, -32602, `Model '${transportModelId}' is not a valid selection for the current Harness`));
                    return;
                }
                // Native upstream model id: normalize it into this Harness's
                // carrier so the persisted route still decodes after a restart.
                transportModelId = encodeExternalTransportSelection(harnessId, {
                    model: parsedModel.data,
                });
            }
            try {
                record = await this.#repository.setTransportModelId(record.hostThreadId, transportModelId);
            }
            catch (error) {
                this.#diagnose(error);
            }
        }
        if (location.thread) {
            location.thread.record = record;
            if (transportModelId) {
                location.thread.transportModelId = transportModelId;
                let route: CreateRoute | null = null;
                try {
                    route = decodeCreateRoute({
                        id: request.id,
                        method: "thread/start",
                        params: { model: transportModelId },
                    });
                }
                catch {
                    route = null;
                }
                if (route &&
                    route.harnessId !== "codex" &&
                    route.harnessId === location.thread.harnessId &&
                    route.model &&
                    location.thread.session.capabilities.configuration.selectModel) {
                    const requestedModel = route.model;
                    void location.thread.session
                        .execute({ type: "model.select", model: requestedModel })
                        .catch((err: unknown) => this.#diagnose(err));
                    location.thread.requestedModel = requestedModel;
                }
            }
            if (typeof params.effort === "string" && params.effort.length > 0) {
                const effortParsed = harnessThinkingOptionIdSchema.safeParse(params.effort);
                if (effortParsed.success) {
                    location.thread.requestedThinkingOptionId = effortParsed.data;
                    if (location.thread.session.capabilities.configuration.selectThinkingOption) {
                        void location.thread.session
                            .execute({
                            type: "thinking.select",
                            thinkingOptionId: effortParsed.data,
                        })
                            .catch((err: unknown) => this.#diagnose(err));
                    }
                }
            }
            location.thread.thread = externalThreadValue({
                record,
                turns: location.thread.turns,
                sessionId: location.thread.sessionId,
                running: location.thread.running,
            });
        }
        await this.#writer.json(rpcEnvelope(request, { result: {} }));
        await this.#writer.json({
            method: "thread/settings/updated",
            params: {
                threadId: record.hostThreadId,
                threadSettings: params,
            },
        });
    }
    async #handleUpdateRequest(request: JsonRpcRequest): Promise<void> {
        const params = updateEmptyParamsSchema.safeParse(request.params === undefined ? {} : request.params);
        if (!params.success) {
            await this.#writer.json(rpcError(request, -32602, "Update params must be empty"));
            return;
        }
        const coordinator = this.#options.updateCoordinator;
        if (!coordinator) {
            await this.#writer.json(rpcError(request, -32090, "Application updates are unavailable"));
            return;
        }
        try {
            if (request.method === "codexhost/update/check") {
                const result = updateCheckResultSchema.parse(await coordinator.check());
                await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
                return;
            }
            if (request.method === "codexhost/update/status") {
                const result = updateStatusResultSchema.parse(await coordinator.status());
                await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
                return;
            }
            const result = updateStartResultSchema.parse(await coordinator.start());
            await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
        }
        catch (error) {
            await this.#writer.json(rpcError(request, -32091, errorMessage(error).slice(0, 500)));
        }
    }
    #harnessInspectionKey(harnessId: ExternalHarnessId, cwd?: string): string {
        return `${harnessId}\u0000${cwd ?? process.cwd()}`;
    }
    #refreshHarnessInspection(
        harnessId: ExternalHarnessId,
        adapter: HarnessAdapter,
        input: { cwd?: string; refresh?: boolean },
    ): Promise<HarnessInspection> {
        const key = this.#harnessInspectionKey(harnessId, input.cwd);
        const existing = this.#harnessInspectionRefreshes.get(key);
        if (existing)
            return existing;
        const refresh = adapter
            .inspect(input)
            .then((inspection) => {
            if (inspection.status === "ready")
                this.#harnessInspectionCache.set(key, inspection);
            return inspection;
        })
            .finally(() => {
            if (this.#harnessInspectionRefreshes.get(key) === refresh) {
                this.#harnessInspectionRefreshes.delete(key);
            }
        });
        this.#harnessInspectionRefreshes.set(key, refresh);
        return refresh;
    }
    #decorateHarnessInspection(adapter: HarnessAdapter, inspection: HarnessInspection): HarnessInspection {
        if (inspection.status !== "ready")
            return inspection;
        const creditsAdapter = isCreditsAdapter(adapter) ? adapter : null;
        const balanceAdapter = isBalanceAdapter(adapter) ? adapter : null;
        const credits = creditsAdapter ? projectAccountCredits(creditsAdapter.credits()) : null;
        const balance = balanceAdapter?.balance();
        return {
            ...inspection,
            accountCreditsStatus: credits ? "available" : creditsAdapter ? "unknown" : "unavailable",
            ...(credits ? { accountCredits: credits } : {}),
            ...(balance
                ? { accountBalance: balance, accountBalanceStatus: "available" }
                : balanceAdapter
                    ? { accountBalanceStatus: "unknown" }
                    : { accountBalanceStatus: "unavailable" }),
        };
    }
    async #inspectHarness(request: JsonRpcRequest): Promise<void> {
        const params = harnessInspectParamsSchema.safeParse(request.params);
        if (!params.success) {
            await this.#writer.json(rpcError(request, -32602, "Invalid Harness inspection params"));
            return;
        }
        const registered = [...this.#externalAdapters].find(([harnessId]) => harnessId === params.data.harnessId);
        if (!registered) {
            await this.#writer.json(rpcError(request, -32077, `Harness '${params.data.harnessId}' is unavailable`));
            return;
        }
        const [harnessId, adapter] = registered;
        const inspectionKey = this.#harnessInspectionKey(harnessId, params.data.cwd);
        const inspectionInput = {
            ...(params.data.cwd ? { cwd: params.data.cwd } : {}),
            ...(params.data.refresh !== undefined ? { refresh: params.data.refresh } : {}),
        };
        if (!params.data.refresh) {
            const cached = this.#harnessInspectionCache.get(inspectionKey);
            if (cached) {
                const validated = harnessInspectionSchema.safeParse(this.#decorateHarnessInspection(adapter, cached));
                if (validated.success) {
                    await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(validated.data) }));
                    void this.#refreshHarnessInspection(harnessId, adapter, inspectionInput).catch((error: unknown) => this.#diagnose(error));
                    return;
                }
                this.#harnessInspectionCache.delete(inspectionKey);
            }
        }
        let inspection;
        try {
            const creditsAdapter = isCreditsAdapter(adapter) ? adapter : null;
            const balanceAdapter = isBalanceAdapter(adapter) ? adapter : null;
            if (params.data.refresh) {
                await Promise.allSettled([
                    creditsAdapter?.refreshCredits?.() ?? Promise.resolve(),
                    balanceAdapter?.refreshBalance?.() ?? Promise.resolve(),
                ]);
            }
            const refreshedInspection = await this.#refreshHarnessInspection(harnessId, adapter, inspectionInput);
            inspection = this.#decorateHarnessInspection(adapter, refreshedInspection);
        }
        catch (error) {
            await this.#writer.json(rpcError(request, -32077, `Harness inspection failed: ${errorMessage(error)}`));
            return;
        }
        const validated = harnessInspectionSchema.safeParse(inspection);
        if (!validated.success) {
            this.#diagnose(validated.error);
            await this.#writer.json(rpcError(request, -32077, "Harness inspection returned an invalid result"));
            return;
        }
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(validated.data) }));
    }
    async #inspectThread(request: JsonRpcRequest): Promise<void> {
        const params = threadInspectionParamsSchema.safeParse(request.params);
        if (!params.success) {
            await this.#writer.json(rpcError(request, -32602, "Invalid Thread inspection params"));
            return;
        }
        const location = await this.#locateExternalThread(params.data.threadId);
        if (await this.#writeResolutionError(request, location))
            return;
        if (location.kind === "external" &&
            !location.thread &&
            location.record.harnessId === "antigravity") {
            const adapter = this.#externalAdapters.get("antigravity");
            const cachedCapabilities = adapter?.cachedThreadCapabilities;
            if (cachedCapabilities) {
                const cached = await this.#externalRuntime.readCached(location);
                if (cached) {
                    try {
                        const selection = decodeExternalTransportSelection("antigravity", cached.record.transportModelId);
                        const inspection = threadInspectionSchema.parse({
                            owner: "external",
                            harnessId: "antigravity",
                            transportModelId: cached.record.transportModelId,
                            ...(selection?.model ? { effectiveModel: selection.model } : {}),
                            ...(selection?.thinkingOptionId
                                ? { effectiveThinkingOptionId: selection.thinkingOptionId }
                                : {}),
                            ...(selection?.permissionModeId
                                ? { effectivePermissionModeId: selection.permissionModeId }
                                : {}),
                            history: cachedCapabilities.history,
                            locked: true,
                        });
                        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(inspection) }));
                        // The inspection is now cheap; wake the real Session in parallel
                        // so subsequent commands observe a normal writable thread.
                        this.#externalRuntime.prewarm(location.record.hostThreadId);
                        return;
                    }
                    catch (error) {
                        this.#diagnose(error);
                    }
                }
            }
        }
        const resolution = await this.#resolveExternalThread(params.data.threadId);
        if (resolution.kind === "error") {
            await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
            return;
        }
        const inspection = threadInspectionSchema.parse(resolution.kind === "official"
            ? { owner: "codex", locked: true }
            : {
                owner: "external",
                harnessId: resolution.thread.harnessId,
                transportModelId: resolution.thread.transportModelId,
                ...(resolution.thread.stateObserver.state.effectiveModel
                    ? { effectiveModel: resolution.thread.stateObserver.state.effectiveModel }
                    : {}),
                ...(resolution.thread.stateObserver.state.resolvedModelLabel
                    ? { resolvedModelLabel: resolution.thread.stateObserver.state.resolvedModelLabel }
                    : {}),
                ...(resolution.thread.stateObserver.state.effectiveThinkingOptionId
                    ? {
                        effectiveThinkingOptionId: resolution.thread.stateObserver.state.effectiveThinkingOptionId,
                    }
                    : {}),
                ...(resolution.thread.stateObserver.state.availableThinkingOptions
                    ? {
                        availableThinkingOptions: resolution.thread.stateObserver.state.availableThinkingOptions,
                    }
                    : {}),
                ...(resolution.thread.stateObserver.state.effectivePermissionModeId
                    ? {
                        effectivePermissionModeId: resolution.thread.stateObserver.state.effectivePermissionModeId,
                    }
                    : {}),
                history: resolution.thread.session.capabilities.history,
                ...(resolution.thread.latestUsage ? { usage: resolution.thread.latestUsage } : {}),
                locked: true,
            });
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(inspection) }));
    }
    async #inspectThreadUsage(request: JsonRpcRequest): Promise<void> {
        const params = threadUsageInspectionParamsSchema.safeParse(request.params);
        if (!params.success) {
            await this.#writer.json(rpcError(request, -32602, "Invalid Thread Usage inspection params"));
            return;
        }
        const location = await this.#locateExternalThread(params.data.threadId);
        if (await this.#writeResolutionError(request, location))
            return;
        if (location.kind === "external" &&
            location.record.harnessId === "antigravity" &&
            !location.thread &&
            params.data.refresh !== "exact") {
            // Initial Usage is optional UI telemetry. Do not hold the conversation
            // open on AGY startup; the renderer already retries this snapshot and an
            // exact refresh below remains available when the user explicitly asks.
            const adapter = this.#externalAdapters.get("antigravity");
            const creditsAdapter = adapter && isCreditsAdapter(adapter) ? adapter : null;
            const balanceAdapter = adapter && isBalanceAdapter(adapter) ? adapter : null;
            try {
                const selection = decodeExternalTransportSelection("antigravity", location.record.transportModelId);
                const credits = creditsAdapter ? projectAccountCredits(creditsAdapter.credits()) : null;
                const result = threadUsageInspectionSchema.parse({
                    threadId: params.data.threadId,
                    usage: null,
                    accountCreditsStatus: credits ? "available" : creditsAdapter ? "unknown" : "unavailable",
                    accountBalanceStatus: balanceAdapter?.balance()
                        ? "available"
                        : balanceAdapter
                            ? "unknown"
                            : "unavailable",
                    owner: {
                        harnessId: "antigravity",
                        ...(selection?.model ? { modelId: selection.model.id } : {}),
                    },
                    ...(credits ? { accountCredits: credits } : {}),
                    ...(balanceAdapter?.balance() ? { accountBalance: balanceAdapter.balance() } : {}),
                });
                await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
                this.#externalRuntime.prewarm(location.record.hostThreadId);
                return;
            }
            catch (error) {
                this.#diagnose(error);
            }
        }
        const resolution = location.kind === "external"
            ? location.thread
                ? ({ kind: "external", thread: location.thread, historyFresh: false } as const)
                : await this.#resolveExternalThread(location.record.hostThreadId)
            : location;
        if (resolution.kind === "error") {
            await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
            return;
        }
        if (resolution.kind === "official") {
            if (params.data.refresh !== undefined) {
                await this.#writer.json(rpcError(request, -32602, "Exact Usage refresh is only available for External Threads"));
                return;
            }
            // A native Codex thread may have no token-usage observation yet, but its
            // account quota is still useful to the Credits pill. Start a refresh for
            // that case without blocking the first inspection; subsequent renderer
            // retries will observe the populated snapshot. When token usage already
            // exists, await the refresh so Usage and Credits arrive together.
            const rateLimitRefresh = this.#refreshOfficialRateLimits();
            if (this.#officialUsageByThread.has(params.data.threadId)) {
                await rateLimitRefresh;
            }
            const accountCredits = projectCodexRateLimitsToCredits(this.#officialRateLimitUsage);
            const result = threadUsageInspectionSchema.parse({
                threadId: params.data.threadId,
                usage: this.#combinedOfficialUsage(this.#officialUsageByThread.get(params.data.threadId)),
                owner: { harnessId: "codex" },
                accountCreditsStatus: accountCredits ? "available" : "unknown",
                ...(accountCredits ? { accountCredits } : {}),
            });
            await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
            return;
        }
        const adapter = this.#externalAdapters.get(resolution.thread.harnessId);
        const creditsAdapter = adapter && isCreditsAdapter(adapter) ? adapter : null;
        const balanceAdapter = adapter && isBalanceAdapter(adapter) ? adapter : null;
        // Exact inspection is the Renderer contract for opening the Usage details
        // popover. Do not answer before the owning Session has finished refreshing:
        // returning the pre-refresh snapshot makes a newly selected Harness/Model
        // appear to keep the previous balance, and there is no guaranteed follow-up
        // notification for account credits.
        if (params.data.refresh === "exact") {
            await Promise.allSettled([
                resolution.thread.session.refreshUsage?.() ?? Promise.resolve(),
                creditsAdapter?.refreshCredits?.() ?? Promise.resolve(),
            ]);
            // A Session may publish its refreshed Usage through the output stream;
            // that stream is consumed independently of this RPC. Read the Session's
            // own post-refresh snapshot as well, otherwise this response can still
            // race the notification consumer and return the previous turn's value.
            if (resolution.thread.session.readUsage) {
                const refreshedUsage = await resolution.thread.session.readUsage().catch(() => null);
                if (refreshedUsage)
                    resolution.thread.latestUsage = refreshedUsage;
            }
        }
        const credits = creditsAdapter ? projectAccountCredits(creditsAdapter.credits()) : null;
        const result = threadUsageInspectionSchema.parse({
            threadId: params.data.threadId,
            usage: resolution.thread.latestUsage,
            accountCreditsStatus: credits ? "available" : creditsAdapter ? "unknown" : "unavailable",
            accountBalanceStatus: balanceAdapter?.balance()
                ? "available"
                : balanceAdapter
                    ? "unknown"
                    : "unavailable",
            owner: {
                harnessId: resolution.thread.harnessId,
                ...(resolution.thread.stateObserver.state.effectiveModel
                    ? { modelId: resolution.thread.stateObserver.state.effectiveModel.id }
                    : {}),
            },
            ...(credits ? { accountCredits: credits } : {}),
            ...(balanceAdapter?.balance() ? { accountBalance: balanceAdapter.balance() } : {}),
        });
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
    }
    /**
     * Native Codex reports account quota the same two ways the Claude Code
     * Adapter does, and arbitrates them the same way: the on-demand
     * `account/rateLimits/read` pull is authoritative, while a notification push
     * may only fill an empty snapshot or expire the cached one. Letting both
     * write freely made the credits pill flip between readings taken at
     * different moments. See `ClaudeCodeAdapter#recordPlanLimit`.
     */
    #mergeOfficialRateLimits(rateLimits: Partial<HostUsage>, source: "push" | "pull"): void {
        if (source === "push" && this.#officialRateLimitUsage) {
            this.#officialRateLimitFreshUntilMs = 0;
            return;
        }
        try {
            this.#officialRateLimitUsage = parseHostUsage({
                ...(this.#officialRateLimitUsage ?? {}),
                ...rateLimits,
            });
            this.#officialRateLimitFreshUntilMs =
                source === "pull" ? Date.now() + OFFICIAL_RATE_LIMIT_TTL_MS : 0;
        }
        catch {
            // Ignore a malformed sparse update while preserving the last valid snapshot.
        }
    }
    #resetOfficialUsageState(): void {
        // Native Codex can change accounts without restarting the app-server. Do
        // not carry the previous account's thread or quota snapshot into the next
        // account's Usage popover.
        this.#officialAccountGeneration += 1;
        this.#officialUsageByThread.clear();
        this.#officialRateLimitUsage = null;
        this.#officialRateLimitFreshUntilMs = 0;
    }
    #combinedOfficialUsage(usage?: HostUsage): HostUsage | null {
        const combined = { ...(usage ?? {}), ...(this.#officialRateLimitUsage ?? {}) };
        if (Object.keys(combined).length === 0)
            return null;
        try {
            return parseHostUsage(combined);
        }
        catch {
            return usage ?? this.#officialRateLimitUsage;
        }
    }
    async #refreshOfficialRateLimits(): Promise<void> {
        // Serve the cached snapshot only while it is still fresh. This used to
        // return on any non-null snapshot, which made the refresh a permanent
        // no-op after the first success: the pill then froze at that first reading
        // for the rest of the process, and only a push could ever move it again.
        if (this.#officialRateLimitUsage && Date.now() < this.#officialRateLimitFreshUntilMs)
            return;
        if (this.#officialRateLimitRefresh)
            return this.#officialRateLimitRefresh;
        const accountGeneration = this.#officialAccountGeneration;
        this.#officialRateLimitRefresh = this.#officialRequestBroker
            .request("account/rateLimits/read", {})
            .then((response) => {
            if (accountGeneration !== this.#officialAccountGeneration)
                return;
            const rateLimits = observeCodexRateLimits(response);
            if (rateLimits)
                this.#mergeOfficialRateLimits(rateLimits, "pull");
        })
            .catch(() => undefined)
            .finally(() => {
            this.#officialRateLimitRefresh = null;
        });
        return this.#officialRateLimitRefresh;
    }
    async #listThreadOwnership(request: JsonRpcRequest): Promise<void> {
        const params = threadOwnershipListParamsSchema.safeParse(request.params);
        if (!params.success) {
            await this.#writer.json(rpcError(request, -32602, "Invalid Thread ownership-list params"));
            return;
        }
        try {
            const threads = await Promise.all(params.data.threadIds.map(async (threadId) => {
                const record = await this.#repository.find(threadId);
                return record
                    ? { threadId, owner: "external", harnessId: record.harnessId }
                    : { threadId, owner: "codex" };
            }));
            const result = threadOwnershipListResultSchema.parse({ threads });
            await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
        }
        catch {
            await this.#writer.json(rpcError(request, -32081, "Thread ownership metadata could not be read"));
        }
    }
    async #handleThreadHandover(request: JsonRpcRequest): Promise<void> {
        const params = isRecord(request.params) ? request.params : null;
        const parsed = hostThreadIdSchema.safeParse(params?.threadId);
        if (!parsed.success) {
            await this.#writer.json(rpcError(request, -32602, "Invalid Thread handover params: valid threadId required"));
            return;
        }
        const threadId = parsed.data;
        const resolution = await this.#resolveExternalThread(threadId);
        if (resolution.kind === "external") {
            const thread = resolution.thread;
            try {
                if (thread.session) {
                    await thread.session.close().catch((err) => this.#diagnose(err));
                    await thread.outputTask.catch((err) => this.#diagnose(err));
                }
            }
            catch (error) {
                this.#diagnose(error);
            }
            try {
                await this.#repository.removeThread(threadId);
            }
            catch (error) {
                this.#diagnose(error);
            }
            this.#externalRuntime.remove(threadId);
            this.#cancelGoalContinuation(threadId);
            this.#goalLoops.delete(threadId);
            this.#routeObservationTracker.forgetThread(threadId);
            await this.#writer.json({
                method: THREAD_USAGE_UPDATED_METHOD,
                params: { threadId },
            }).catch(() => undefined);
        }
        else {
            try {
                await this.#repository.removeThread(threadId);
            }
            catch (error) {
                this.#diagnose(error);
            }
            this.#cancelGoalContinuation(threadId);
            this.#goalLoops.delete(threadId);
            this.#routeObservationTracker.forgetThread(threadId);
        }
        await this.#writer.json(rpcEnvelope(request, { result: { ok: true } }));
    }
    async #inspectThreadCommands(request: JsonRpcRequest): Promise<void> {
        const params = threadCommandsInspectParamsSchema.safeParse(request.params);
        if (!params.success) {
            await this.#writer.json(rpcError(request, -32602, "Invalid Thread command inspection params"));
            return;
        }
        const location = await this.#locateExternalThread(params.data.threadId);
        if (await this.#writeResolutionError(request, location))
            return;
        if (location.kind === "external" &&
            location.record.harnessId === "antigravity" &&
            !location.thread) {
            // Antigravity headless mode exposes no Host command catalog. Returning
            // the empty catalog is authoritative and avoids waking AGY just for a
            // secondary UI request while a cold Thread is being opened.
            await this.#writer.json(rpcEnvelope(request, { result: { commands: [] } }));
            return;
        }
        const resolution = location.kind === "external"
            ? location.thread
                ? ({ kind: "external", thread: location.thread, historyFresh: false } as const)
                : await this.#resolveExternalThread(location.record.hostThreadId)
            : location;
        if (await this.#writeResolutionError(request, resolution))
            return;
        if (resolution.kind !== "external" || !resolution.thread.session.commands) {
            await this.#writer.json(rpcEnvelope(request, { result: { commands: [] } }));
            return;
        }
        const result = await resolution.thread.session.commands.list();
        if (!result.ok) {
            await this.#writer.json(rpcError(request, -32078, result.error.message));
            return;
        }
        try {
            await this.#writer.json(rpcEnvelope(request, {
                result: jsonValueSchema.parse(harnessCommandCatalogSchema.parse(result.value)),
            }));
        }
        catch (error) {
            await this.#writer.json(rpcError(request, -32078, `Harness command catalog is invalid: ${errorMessage(error)}`));
        }
    }
    async #executeThreadCommand(request: JsonRpcRequest): Promise<void> {
        const params = threadCommandExecuteParamsSchema.safeParse(request.params);
        if (!params.success) {
            await this.#writer.json(rpcError(request, -32602, "Invalid Thread command parameters"));
            return;
        }
        const resolution = await this.#resolveExternalThread(params.data.threadId);
        if (await this.#writeResolutionError(request, resolution))
            return;
        if (resolution.kind !== "external") {
            await this.#writer.json(rpcError(request, -32078, "Thread is not externally owned"));
            return;
        }
        const thread = resolution.thread;
        if (thread.running) {
            await this.#writer.json(rpcError(request, -32072, "External Thread already has an active operation"));
            return;
        }
        const commands = thread.session.commands;
        if (!commands) {
            await this.#writer.json(rpcError(request, -32078, "External Harness does not expose commands"));
            return;
        }
        const catalog = await commands.list();
        if (!catalog.ok) {
            await this.#writer.json(rpcError(request, -32078, catalog.error.message));
            return;
        }
        if (!catalog.value.commands.some(({ id }) => id === params.data.commandId)) {
            await this.#writer.json(rpcError(request, -32078, `External Harness does not expose command '${params.data.commandId}'`));
            return;
        }
        try {
            await this.#startExternalCommand(request, thread, params.data.commandId, params.data.arguments, params.data.turnId, "command");
        }
        catch (error) {
            this.#diagnose(error);
            await this.#writer.json(rpcError(request, -32073, `External Harness command failed: ${errorMessage(error)}`));
        }
    }
    async #startExternalCommand(
        request: JsonRpcRequest,
        thread: ExternalThread,
        commandId: string,
        arguments_: JsonObject | undefined,
        requestedTurnId: HostTurnId | undefined,
        responseKind: "command" | "turn",
    ): Promise<void> {
        const commands = thread.session.commands;
        if (!commands) {
            await this.#writer.json(rpcError(request, -32078, "External Harness does not expose commands"));
            return;
        }
        if (thread.running) {
            await this.#writer.json(rpcError(request, -32072, "External Thread already has an active operation"));
            return;
        }
        const turnId = requestedTurnId ?? hostTurnIdSchema.parse(randomUUID());
        const projection: ProjectedTurn = {
            projector: new CodexTurnProjector({
                threadId: thread.id,
                turnId,
                cwd: thread.cwd,
                startedAtMs: Date.now(),
            }),
        };
        const gate = turnProjectionGate();
        thread.running = true;
        thread.activeTurnId = turnId;
        thread.projectedTurns.set(turnId, projection);
        thread.responseGates.set(turnId, gate);
        thread.ephemeralTurnIds.add(turnId);
        let result;
        try {
            result = await commands.execute({
                turnId,
                commandId,
                ...(arguments_ ? { arguments: arguments_ } : {}),
            });
        }
        catch (error) {
            thread.running = false;
            thread.activeTurnId = null;
            thread.projectedTurns.delete(turnId);
            thread.responseGates.delete(turnId);
            thread.ephemeralTurnIds.delete(turnId);
            gate.resolve();
            this.#signalActiveWorkChanged();
            throw error;
        }
        if (!result.ok) {
            thread.running = false;
            thread.activeTurnId = null;
            thread.projectedTurns.delete(turnId);
            thread.responseGates.delete(turnId);
            thread.ephemeralTurnIds.delete(turnId);
            gate.resolve();
            this.#signalActiveWorkChanged();
            await this.#writer.json(rpcError(request, -32073, result.error.message));
            return;
        }
        try {
            const response = responseKind === "command"
                ? jsonValueSchema.parse(threadCommandExecuteResultSchema.parse({
                    accepted: true,
                    turnId: result.value.turnId,
                }))
                : { turn: projection.projector.pendingTurn() };
            await this.#writer.json(rpcEnvelope(request, { result: response }));
        }
        finally {
            gate.resolve();
        }
    }
    async #selectThreadModel(request: JsonRpcRequest): Promise<void> {
        const params = threadModelSelectParamsSchema.safeParse(request.params);
        if (!params.success) {
            await this.#writer.json(rpcError(request, -32602, "Invalid Thread Model selection params"));
            return;
        }
        const resolution = await this.#resolveExternalThread(params.data.threadId);
        if (resolution.kind === "error") {
            await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
            return;
        }
        const thread = resolution.kind === "external" ? resolution.thread : undefined;
        if (!thread) {
            await this.#writer.json(rpcError(request, -32078, "Model selection requires a current-process external Thread"));
            return;
        }
        if (!thread.session.capabilities.configuration.selectModel) {
            await this.#writer.json(rpcError(request, -32078, "External Harness does not support Model selection"));
            return;
        }
        const beforeRevision = thread.stateObserver.revision;
        const result = await thread.session.execute({
            type: "model.select",
            model: params.data.model,
        });
        if (!result.ok) {
            await this.#writer.json(rpcError(request, -32078, result.error.message));
            return;
        }
        try {
            const state = await thread.stateObserver.waitForChange(beforeRevision);
            const projected = harnessModelSelectionStateSchema.parse({
                ...(state.effectiveModel ? { effectiveModel: state.effectiveModel } : {}),
                ...(state.resolvedModelLabel ? { resolvedModelLabel: state.resolvedModelLabel } : {}),
                ...(state.effectiveThinkingOptionId
                    ? { effectiveThinkingOptionId: state.effectiveThinkingOptionId }
                    : {}),
                ...(state.availableThinkingOptions
                    ? { availableThinkingOptions: state.availableThinkingOptions }
                    : {}),
                ...(state.effectivePermissionModeId
                    ? { effectivePermissionModeId: state.effectivePermissionModeId }
                    : {}),
            });
            if (!projected.effectiveModel) {
                throw new Error("Harness Session did not report an effective Model");
            }
            await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(projected) }));
        }
        catch (error) {
            await this.#writer.json(rpcError(request, -32078, `Model state was not confirmed: ${errorMessage(error)}`));
        }
    }
    async #selectThreadThinking(request: JsonRpcRequest): Promise<void> {
        const params = threadThinkingSelectParamsSchema.safeParse(request.params);
        if (!params.success) {
            await this.#writer.json(rpcError(request, -32602, "Invalid Thread Thinking selection params"));
            return;
        }
        const resolution = await this.#resolveExternalThread(params.data.threadId);
        if (resolution.kind === "error") {
            await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
            return;
        }
        const thread = resolution.kind === "external" ? resolution.thread : undefined;
        if (!thread) {
            await this.#writer.json(rpcError(request, -32078, "Thinking selection requires a current-process external Thread"));
            return;
        }
        if (!thread.session.capabilities.configuration.selectThinkingOption) {
            await this.#writer.json(rpcError(request, -32078, "External Harness does not support Thinking selection"));
            return;
        }
        const beforeRevision = thread.stateObserver.revision;
        const result = await thread.session.execute({
            type: "thinking.select",
            thinkingOptionId: params.data.thinkingOptionId,
        });
        if (!result.ok) {
            await this.#writer.json(rpcError(request, -32078, result.error.message));
            return;
        }
        try {
            const state = await thread.stateObserver.waitForChange(beforeRevision);
            const projected = harnessModelSelectionStateSchema.parse({
                ...(state.effectiveModel ? { effectiveModel: state.effectiveModel } : {}),
                ...(state.resolvedModelLabel ? { resolvedModelLabel: state.resolvedModelLabel } : {}),
                ...(state.effectiveThinkingOptionId
                    ? { effectiveThinkingOptionId: state.effectiveThinkingOptionId }
                    : {}),
                ...(state.availableThinkingOptions
                    ? { availableThinkingOptions: state.availableThinkingOptions }
                    : {}),
                ...(state.effectivePermissionModeId
                    ? { effectivePermissionModeId: state.effectivePermissionModeId }
                    : {}),
            });
            if (!projected.effectiveThinkingOptionId) {
                throw new Error("Harness Session did not report effective Thinking");
            }
            thread.requestedThinkingOptionId = projected.effectiveThinkingOptionId;
            const previousSelection = decodeExternalTransportSelection(thread.harnessId, thread.transportModelId);
            const effectiveModel = projected.effectiveModel ?? thread.requestedModel ?? previousSelection?.model;
            if (effectiveModel) {
                const transportModelId = encodeExternalTransportSelection(thread.harnessId, {
                    ...(previousSelection ?? {}),
                    model: effectiveModel,
                    thinkingOptionId: projected.effectiveThinkingOptionId,
                });
                thread.transportModelId = transportModelId;
                thread.requestedModel = effectiveModel;
                try {
                    thread.record = await this.#repository.setTransportModelId(thread.record.hostThreadId, transportModelId);
                }
                catch (error) {
                    this.#diagnose(error);
                }
                thread.thread = externalThreadValue({
                    record: { ...thread.record, transportModelId },
                    turns: thread.turns,
                    sessionId: thread.sessionId,
                    running: thread.running,
                });
            }
            await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(projected) }));
        }
        catch (error) {
            await this.#writer.json(rpcError(request, -32078, `Thinking state was not confirmed: ${errorMessage(error)}`));
        }
    }
    async #selectThreadPermissionMode(request: JsonRpcRequest): Promise<void> {
        const params = threadPermissionModeSelectParamsSchema.safeParse(request.params);
        if (!params.success) {
            await this.#writer.json(rpcError(request, -32602, "Invalid Thread Permission Mode selection params"));
            return;
        }
        const resolution = await this.#resolveExternalThread(params.data.threadId);
        if (resolution.kind === "error") {
            await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
            return;
        }
        const thread = resolution.kind === "external" ? resolution.thread : undefined;
        if (!thread) {
            await this.#writer.json(rpcError(request, -32078, "Permission Mode selection requires a current-process external Thread"));
            return;
        }
        if (!thread.session.capabilities.configuration.selectPermissionMode) {
            await this.#writer.json(rpcError(request, -32078, "External Harness does not support Permission Mode selection"));
            return;
        }
        if (permissionModeFixedAtCreate(thread.session.capabilities.configuration)) {
            await this.#writer.json(rpcError(request, -32078, "Permission Mode is fixed at Session creation"));
            return;
        }
        const beforeRevision = thread.stateObserver.revision;
        const result = await thread.session.execute({
            type: "permissionMode.select",
            permissionModeId: params.data.permissionModeId,
        });
        if (!result.ok) {
            await this.#writer.json(rpcError(request, -32078, result.error.message));
            return;
        }
        try {
            const state = await thread.stateObserver.waitForChange(beforeRevision);
            const projected = harnessConfigurationStateSchema.parse({
                ...(state.effectiveModel ? { effectiveModel: state.effectiveModel } : {}),
                ...(state.resolvedModelLabel ? { resolvedModelLabel: state.resolvedModelLabel } : {}),
                ...(state.effectiveThinkingOptionId
                    ? { effectiveThinkingOptionId: state.effectiveThinkingOptionId }
                    : {}),
                ...(state.availableThinkingOptions
                    ? { availableThinkingOptions: state.availableThinkingOptions }
                    : {}),
                ...(state.effectivePermissionModeId
                    ? { effectivePermissionModeId: state.effectivePermissionModeId }
                    : {}),
            });
            if (!projected.effectivePermissionModeId) {
                throw new Error("Harness Session did not report its current Permission Mode");
            }
            thread.requestedPermissionModeId = projected.effectivePermissionModeId;
            const previousSelection = decodeExternalTransportSelection(thread.harnessId, thread.transportModelId);
            const effectiveModel = projected.effectiveModel ?? thread.requestedModel ?? previousSelection?.model;
            if (effectiveModel) {
                const transportModelId = encodeExternalTransportSelection(thread.harnessId, {
                    ...(previousSelection ?? {}),
                    model: effectiveModel,
                    permissionModeId: projected.effectivePermissionModeId,
                });
                thread.transportModelId = transportModelId;
                thread.requestedModel = effectiveModel;
                try {
                    thread.record = await this.#repository.setTransportModelId(thread.record.hostThreadId, transportModelId);
                }
                catch (error) {
                    this.#diagnose(error);
                }
                thread.thread = externalThreadValue({
                    record: { ...thread.record, transportModelId },
                    turns: thread.turns,
                    sessionId: thread.sessionId,
                    running: thread.running,
                });
            }
            await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(projected) }));
        }
        catch (error) {
            await this.#writer.json(rpcError(request, -32078, `Permission Mode state was not confirmed: ${errorMessage(error)}`));
        }
    }
    async #startExternalThread(request: JsonRpcRequest, harnessId: ExternalHarnessId): Promise<void> {
        const adapter = this.#externalAdapters.get(harnessId);
        if (!adapter) {
            this.#routeObservationTracker.rejectCreate(request.id);
            await this.#writer.json(rpcError(request, -32070, `External Harness '${harnessId}' is unavailable`));
            return;
        }
        const params = requestObject(request);
        const route = decodeCreateRoute(request);
        const requestedModel = route && route.harnessId !== "codex" ? route.model : undefined;
        const requestedThinkingOptionId = route && route.harnessId !== "codex" ? route.thinkingOptionId : undefined;
        const requestedPermissionModeId = route && route.harnessId !== "codex" ? route.permissionModeId : undefined;
        const transportModelId = route && route.harnessId === harnessId
            ? route.transportModelId
            : transportModelIdForHarness(harnessId);
        const cwd = params.cwd;
        if (typeof cwd !== "string" || cwd.length === 0) {
            this.#routeObservationTracker.rejectCreate(request.id);
            await this.#writer.json(rpcError(request, -32602, `External Harness '${harnessId}' thread/start requires cwd`));
            return;
        }
        const recordInput = createExternalThreadRecordInput({
            harnessId: adapter.harnessId,
            cwd,
            transportModelId,
            ephemeral: params.ephemeral === true,
            historyMode: params.historyMode === "paginated" ? "paginated" : "legacy",
        });
        let record;
        try {
            record = await this.#repository.createProvisional(recordInput);
        }
        catch {
            this.#routeObservationTracker.rejectCreate(request.id);
            await this.#writer.json(rpcError(request, -32081, "External Thread could not be persisted"));
            return;
        }
        const sessionResult = await adapter.open({
            kind: "create",
            cwd,
            environment: {
                ...(this.#options.environment ?? process.env),
                [DELEGATION_THREAD_ID_ENV]: record.hostThreadId,
            },
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(requestedThinkingOptionId ? { thinkingOptionId: requestedThinkingOptionId } : {}),
            ...(requestedPermissionModeId ? { permissionModeId: requestedPermissionModeId } : {}),
        });
        if (!sessionResult.ok) {
            this.#routeObservationTracker.rejectCreate(request.id);
            await this.#repository.removeProvisional(record.hostThreadId).catch(() => undefined);
            const mapped = mapExternalThreadHarnessError(sessionResult.error, "create");
            await this.#writer.json(rpcError(request, mapped.code, mapped.message));
            return;
        }
        const session = sessionResult.value;
        try {
            if (session.initialState.nativeRef) {
                record = await this.#repository.commitNative(record.hostThreadId, session.initialState.nativeRef);
            }
            const thread = externalThreadValue({
                record,
                turns: [],
                sessionId: record.hostThreadId,
            });
            const externalThread = this.#registerExternalThread({
                record,
                session,
                sessionId: record.hostThreadId,
                thread,
                turns: [],
                ...(requestedModel ? { requestedModel } : {}),
                ...(requestedThinkingOptionId ? { requestedThinkingOptionId } : {}),
                ...(requestedPermissionModeId ? { requestedPermissionModeId } : {}),
            });
            this.#routeObservationTracker.bindCreatedThread(request.id, externalThread.id);
            await this.#writer.json(rpcEnvelope(request, {
                result: {
                    thread,
                    model: transportModelId,
                    modelProvider: "codexhost",
                    cwd,
                    approvalPolicy: typeof params.approvalPolicy === "string" ? params.approvalPolicy : "never",
                    approvalsReviewer: "user",
                    sandbox: sandboxResult(params),
                    reasoningEffort: "medium",
                    serviceTier: "flex",
                    multiAgentMode: "explicitRequestOnly",
                    activePermissionProfile: null,
                    runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
                        ? params.runtimeWorkspaceRoots
                        : [],
                    instructionSources: [],
                },
            }));
            await this.#writer.json({
                method: "thread/started",
                emittedAtMs: Date.now(),
                params: { thread },
            });
        }
        catch {
            this.#externalRuntime.remove(record.hostThreadId);
            this.#routeObservationTracker.forgetThread(record.hostThreadId);
            await session.close().catch(() => undefined);
            await this.#repository.removeProvisional(record.hostThreadId).catch(() => undefined);
            await this.#writer.json(rpcError(request, -32081, "External Thread could not be persisted"));
        }
    }
    #registerExternalThread(
        input: Parameters<ExternalThreadRuntime["register"]>[0],
    ): ExternalThread {
        const thread = this.#externalRuntime.register(input);
        this.#onExternalThreadRegistered(thread);
        return thread;
    }
    #onExternalThreadRegistered(thread: ExternalThread): void {
        const storedGoal = thread.record.goal;
        if (!storedGoal)
            return;
        const goal = fromStoredGoal(storedGoal);
        this.#goalLoops.set(thread.id, goal);
        if (goal.status === "active") {
            // A Host restart closes the old Session. Treat any persisted in-flight
            // Turn as an interrupted boundary and recover from the durable history.
            this.#scheduleGoalContinuation(thread, true);
        }
    }
    #locateExternalThread(threadId: string): Promise<ExternalThreadLocation> {
        return this.#externalRuntime.locate(threadId);
    }
    #resolveExternalThread(threadId: string): Promise<ExternalThreadResolution> {
        return this.#externalRuntime.resolve(threadId);
    }
    async #writeResolutionError(
        request: JsonRpcRequest,
        resolution: ExternalThreadLocation | ExternalThreadResolution,
    ): Promise<boolean> {
        if (resolution.kind !== "error")
            return false;
        await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
        return true;
    }
    #refreshExternalThread(thread: ExternalThread): Promise<ExternalThreadRpcError | null> {
        return this.#externalRuntime.refresh(thread);
    }
    #persistTerminalIdentity(
        thread: ExternalThread,
        event: Parameters<ExternalThreadRuntime["persistTerminalIdentity"]>[1],
    ): Promise<Error | null> {
        return this.#externalRuntime.persistTerminalIdentity(thread, event);
    }
    async #forkExternalThreadFromRenderer(request: JsonRpcRequest): Promise<void> {
        const parsed = externalThreadForkParamsSchema.safeParse(request.params);
        if (!parsed.success) {
            await this.#writer.json(rpcError(request, -32602, "External Fork request is invalid"));
            return;
        }
        const resolution = await this.#resolveExternalThread(parsed.data.threadId);
        if (await this.#writeResolutionError(request, resolution))
            return;
        if (resolution.kind !== "external") {
            await this.#writer.json(rpcError(request, -32078, "Thread is not externally owned"));
            return;
        }
        const result = await executeExternalThreadFork({
            source: resolution.thread,
            fork: {
                threadId: parsed.data.threadId,
                lastTurnId: parsed.data.lastTurnId,
                excludeTurns: true,
            },
            adapters: this.#externalAdapters,
            repository: this.#repository,
            runtime: this.#externalRuntime,
            environment: this.#options.environment ?? process.env,
        });
        if (!result.ok) {
            await this.#writer.json(rpcError(request, result.error.code, result.error.message));
            return;
        }
        await this.#writer.json(rpcEnvelope(request, {
            result: externalThreadForkResultSchema.parse({ threadId: result.derived.id }),
        }));
        await this.#notifyExternalThreadStarted(result.thread);
    }
    async #forkExternalThread(
        request: JsonRpcRequest,
        source: ExternalThread,
        fork: DecodedThreadForkRequest,
    ): Promise<void> {
        const result = await executeExternalThreadFork({
            source,
            fork,
            adapters: this.#externalAdapters,
            repository: this.#repository,
            runtime: this.#externalRuntime,
            environment: this.#options.environment ?? process.env,
        });
        if (!result.ok) {
            await this.#writer.json(rpcError(request, result.error.code, result.error.message));
            return;
        }
        const params: JsonObject = {
            ...(fork.sandbox ? { sandbox: fork.sandbox } : {}),
        };
        await this.#writer.json(rpcEnvelope(request, {
            result: threadForkResult(result.responseThread, {
                model: result.derived.transportModelId,
                cwd: result.derived.cwd,
                ...(fork.runtimeWorkspaceRoots
                    ? { runtimeWorkspaceRoots: fork.runtimeWorkspaceRoots }
                    : {}),
                ...(fork.approvalPolicy ? { approvalPolicy: fork.approvalPolicy } : {}),
                sandbox: sandboxResult(params),
                ...(fork.serviceTier ? { serviceTier: fork.serviceTier } : {}),
            }),
        }));
        await this.#notifyExternalThreadStarted(result.thread);
    }
    async #notifyExternalThreadStarted(thread: JsonObject): Promise<void> {
        await this.#writer.json({
            method: "thread/started",
            emittedAtMs: Date.now(),
            params: { thread: { ...thread, turns: [] } },
        });
    }
    async #revertExternalThread(
        request: JsonRpcRequest,
        thread: ExternalThread,
        revert: DecodedThreadRevertRequest,
    ): Promise<void> {
        if (thread.record.historyMode !== "paginated") {
            await this.#writer.json(rpcError(request, -32602, "External thread/revert requires paginated history"));
            return;
        }
        const result = await executeExternalThreadRollback({
            derived: thread,
            rollback: { threadId: revert.threadId, numTurns: 1 },
            expectedLastTurnId: revert.beforeTurnId,
            adapters: this.#externalAdapters,
            repository: this.#repository,
            runtime: this.#externalRuntime,
            environment: this.#options.environment ?? process.env,
        });
        if (!result.ok) {
            await this.#writer.json(rpcError(request, result.error.code, result.error.message));
            return;
        }
        await this.#writer.json(rpcEnvelope(request, { result: threadRevertResult(result.thread) }));
        await this.#writer.json({ method: "thread/reverted", params: { threadId: thread.id } });
    }
    async #rollbackExternalThread(
        request: JsonRpcRequest,
        derived: ExternalThread,
        rollback: DecodedThreadRollbackRequest,
    ): Promise<void> {
        const result = await executeExternalThreadRollback({
            derived,
            rollback,
            adapters: this.#externalAdapters,
            repository: this.#repository,
            runtime: this.#externalRuntime,
            environment: this.#options.environment ?? process.env,
        });
        if (!result.ok) {
            await this.#writer.json(rpcError(request, result.error.code, result.error.message));
            return;
        }
        await this.#writer.json(rpcEnvelope(request, { result: threadRollbackResult(result.thread) }));
    }
    async #setExternalThreadName(
        request: JsonRpcRequest,
        location: Extract<ExternalThreadLocation, { kind: "external" }>,
        name: JsonValue | undefined,
    ): Promise<void> {
        const rawName = typeof name === "string" ? name : "";
        const normalizedName = this.#options.normalizeThreadTitles
            ? normalizeThreadTitle(rawName)
            : rawName;
        if (normalizedName.length === 0) {
            await this.#writer.json(rpcError(request, -32602, "External Thread name must be a non-empty string"));
            return;
        }
        let record;
        try {
            record = await this.#repository.setTitle(location.record.hostThreadId, normalizedName);
        }
        catch {
            await this.#writer.json(rpcError(request, -32081, "External Thread title could not be persisted"));
            return;
        }
        if (location.thread) {
            location.thread.record = record;
            location.thread.thread.name = normalizedName;
            location.thread.thread.updatedAt = unixSeconds();
        }
        await this.#writer.json(rpcEnvelope(request, { result: {} }));
        await this.#writer.json({
            method: "thread/name/updated",
            params: { threadId: location.record.hostThreadId, threadName: normalizedName },
        });
    }
    async #deleteExternalThread(
        request: JsonRpcRequest,
        location: Extract<ExternalThreadLocation, { kind: "external" }>,
    ): Promise<void> {
        const thread = location.thread;
        if (thread) {
            thread.stateObserver.fault(new Error("External Thread was deleted"));
            try {
                await thread.session.close();
                await thread.outputTask;
            }
            catch (error) {
                await this.#writer.json(rpcError(request, -32075, `External Thread could not close: ${errorMessage(error)}`));
                return;
            }
        }
        try {
            await this.#repository.removeThread(location.record.hostThreadId);
        }
        catch {
            await this.#writer.json(rpcError(request, -32081, "External Thread could not be removed"));
            return;
        }
        this.#externalRuntime.remove(location.record.hostThreadId);
        this.#cancelGoalContinuation(location.record.hostThreadId);
        this.#goalLoops.delete(location.record.hostThreadId);
        this.#routeObservationTracker.forgetThread(location.record.hostThreadId);
        await this.#writer.json(rpcEnvelope(request, { result: {} }));
    }
    async #readExternalThreadMetadata(
        request: JsonRpcRequest,
        location: Extract<ExternalThreadLocation, { kind: "external" }>,
    ): Promise<void> {
        try {
            const thread = location.thread
                ? { ...location.thread.thread, turns: [] }
                : externalThreadValue({
                    record: location.record,
                    turns: [],
                    sessionId: await this.#repository.sessionTreeId(location.record),
                });
            await this.#writer.json(rpcEnvelope(request, { result: { thread } }));
            if (location.thread)
                await this.#replayExternalUsage(location.thread);
        }
        catch {
            await this.#writer.json(rpcError(request, -32081, "External Thread metadata could not be read"));
        }
    }
    async #readExternalThread(
        request: JsonRpcRequest,
        thread: ExternalThread,
        includeTurns: boolean,
        historyFresh: boolean,
    ): Promise<void> {
        if (includeTurns && thread.record.historyMode === "paginated") {
            await this.#writer.json(rpcError(request, -32602, "Paginated External Threads require thread/turns/list"));
            return;
        }
        if (includeTurns && !thread.running && !historyFresh) {
            const refreshed = await this.#refreshExternalThread(thread);
            if (refreshed) {
                await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
                return;
            }
        }
        await this.#writer.json(rpcEnvelope(request, {
            result: {
                thread: {
                    ...thread.thread,
                    turns: includeTurns ? this.#externalHistoryTurns(thread) : [],
                },
            },
        }));
        await this.#replayExternalUsage(thread);
    }
    async #listExternalHistory(
        request: JsonRpcRequest,
        thread: ExternalThread,
        params: JsonObject,
        historyFresh: boolean,
    ): Promise<void> {
        const headPage = params.cursor === null || params.cursor === undefined;
        const requiresRefresh = request.method === "thread/turns/list" ||
            (request.method === "thread/items/list" && !thread.historyHydrated);
        if (!thread.running && !historyFresh && headPage && requiresRefresh) {
            const refreshed = await this.#refreshExternalThread(thread);
            if (refreshed) {
                await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
                return;
            }
        }
        try {
            const turns = this.#externalHistoryTurns(thread);
            const result = request.method === "thread/turns/list"
                ? listExternalTurns(turns, params)
                : listExternalItems(turns, params);
            await this.#writer.json(rpcEnvelope(request, { result }));
        }
        catch (error) {
            await this.#writer.json(rpcError(request, error instanceof ExternalHistoryRequestError ? -32602 : -32076, error instanceof ExternalHistoryRequestError
                ? error.message
                : "External Thread history projection failed"));
        }
    }
    async #writeCachedExternalHistory(
        request: JsonRpcRequest,
        turns: JsonObject[],
        params: JsonObject,
    ): Promise<void> {
        try {
            const result = request.method === "thread/turns/list"
                ? listExternalTurns(turns, params)
                : listExternalItems(turns, params);
            await this.#writer.json(rpcEnvelope(request, { result }));
        }
        catch (error) {
            await this.#writer.json(rpcError(request, error instanceof ExternalHistoryRequestError ? -32602 : -32076, error instanceof ExternalHistoryRequestError
                ? error.message
                : "External Thread history projection failed"));
        }
    }
    async #resumeExternalThread(
        request: JsonRpcRequest,
        thread: ExternalThread,
        params: JsonObject,
        historyFresh: boolean,
    ): Promise<void> {
        if (!thread.running && !historyFresh) {
            const refreshed = await this.#refreshExternalThread(thread);
            if (refreshed) {
                await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
                return;
            }
        }
        await this.#writeExternalResume(request, {
            thread: thread.thread,
            record: thread.record,
            transportModelId: thread.transportModelId,
            cwd: thread.cwd,
            turns: this.#externalHistoryTurns(thread),
        }, params);
    }
    async #resumeCachedExternalThread(
        request: JsonRpcRequest,
        cached: CachedExternalThread,
        params: JsonObject,
    ): Promise<void> {
        await this.#writeExternalResume(request, {
            thread: cached.thread,
            record: cached.record,
            transportModelId: cached.record.transportModelId,
            cwd: cached.record.cwd,
            turns: cached.turns,
        }, params);
    }
    async #writeExternalResume(
        request: JsonRpcRequest,
        input: {
            thread: JsonObject;
            record: StoredThreadRecordV1;
            transportModelId: string;
            cwd: string;
            turns: JsonObject[];
        },
        params: JsonObject,
    ): Promise<void> {
        const responseThread = {
            ...input.thread,
            turns: params.excludeTurns === true ? [] : input.turns,
        };
        const result = threadForkResult(responseThread, {
            model: input.transportModelId,
            cwd: input.cwd,
            runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
                ? params.runtimeWorkspaceRoots.filter((value: unknown): value is string => typeof value === "string")
                : [],
            approvalPolicy: typeof params.approvalPolicy === "string" ? params.approvalPolicy : "never",
            sandbox: sandboxResult(params),
            ...(typeof params.serviceTier === "string" ? { serviceTier: params.serviceTier } : {}),
        });
        try {
            if (params.initialTurnsPage !== undefined &&
                params.initialTurnsPage !== null &&
                !isRecord(params.initialTurnsPage)) {
                throw new ExternalHistoryRequestError("initialTurnsPage must be an object");
            }
            const initialPageParams = isRecord(params.initialTurnsPage)
                ? (params.initialTurnsPage as JsonObject)
                : null;
            const initialTurnsPage = initialPageParams
                ? listExternalTurns(input.turns, initialPageParams)
                : null;
            const paginated = input.record.historyMode === "paginated";
            const turnsBackwardsCursor = paginated
                ? listExternalTurns(input.turns, { limit: 1, itemsView: "notLoaded" }).backwardsCursor
                : null;
            const itemsBackwardsCursor = paginated
                ? listExternalItems(input.turns, { limit: 1, sortDirection: "desc" }).backwardsCursor
                : null;
            await this.#writer.json(rpcEnvelope(request, {
                result: {
                    ...result,
                    initialTurnsPage,
                    turnsBackwardsCursor,
                    itemsBackwardsCursor,
                },
            }));
        }
        catch (error) {
            await this.#writer.json(rpcError(request, error instanceof ExternalHistoryRequestError ? -32602 : -32076, error instanceof ExternalHistoryRequestError
                ? error.message
                : "External Thread history projection failed"));
        }
    }
    #externalHistoryTurns(thread: ExternalThread): JsonObject[] {
        if (!thread.activeTurnId)
            return thread.turns;
        const active = thread.projectedTurns.get(thread.activeTurnId);
        return active ? [...thread.turns, active.projector.pendingTurn()] : thread.turns;
    }
    async #startDelegatedExternalTurn(
        thread: ExternalThread,
        text: string,
        requestedTurnId: string,
    ): Promise<void> {
        // A Goal loop timer can outlive a faulted Session; restore the live Thread first.
        if (this.#externalRuntime.get(thread.id) !== thread) {
            const resolution = await this.#resolveExternalThread(thread.id);
            if (resolution.kind !== "external")
                throw new Error("External Thread is unavailable");
            thread = resolution.thread;
        }
        if (thread.running) {
            throw new Error("External Thread already has an active Turn");
        }
        const turnId = hostTurnIdSchema.parse(requestedTurnId);
        const goal = this.#goalForThread(thread);
        if (goal?.status === "active") {
            goal.inFlightTurnId = turnId;
            await this.#persistGoal(thread, goal);
        }
        const projection: ProjectedTurn = {
            projector: new CodexTurnProjector({
                threadId: thread.id,
                turnId,
                cwd: thread.cwd,
                startedAtMs: Date.now(),
                initialInput: [{ type: "text", text }],
            }),
        };
        thread.running = true;
        thread.activeTurnId = turnId;
        thread.projectedTurns.set(turnId, projection);
        thread.responseGates.set(turnId, { promise: Promise.resolve(), resolve: () => undefined });
        const result = await thread.session.execute({
            type: "turn.start",
            turnId,
            input: [{ type: "text", text }],
        });
        if (!result.ok) {
            thread.running = false;
            thread.activeTurnId = null;
            thread.projectedTurns.delete(turnId);
            thread.responseGates.delete(turnId);
            this.#signalActiveWorkChanged();
            if (goal?.inFlightTurnId === turnId) {
                delete goal.inFlightTurnId;
                await this.#persistGoal(thread, goal).catch((error) => this.#diagnose(error));
            }
            throw new Error(result.error.message);
        }
    }
    async #handoverExternalThreadToOfficial(
        request: JsonRpcRequest,
        thread: ExternalThread,
        frame?: Buffer,
    ): Promise<void> {
        const threadId = thread.id;
        try {
            if (thread.session) {
                await thread.session.close().catch((err: unknown) => this.#diagnose(err));
                await thread.outputTask.catch((err: unknown) => this.#diagnose(err));
            }
        }
        catch (error) {
            this.#diagnose(error);
        }
        try {
            await this.#repository.removeThread(threadId);
        }
        catch (error) {
            this.#diagnose(error);
        }
        this.#externalRuntime.remove(threadId);
        this.#cancelGoalContinuation(threadId);
        this.#goalLoops.delete(threadId);
        this.#routeObservationTracker.forgetThread(threadId);
        await this.#writer.json({
            method: THREAD_USAGE_UPDATED_METHOD,
            params: { threadId },
        }).catch(() => undefined);
        if (!this.#official) {
            await this.#writer.json(rpcError(request, -32603, "Official Codex process is not running"));
            return;
        }
        const sanitizedParams = isRecord(request.params) ? { ...request.params } : {};
        delete sanitizedParams.model;
        const sanitizedFrame = Buffer.from(JSON.stringify({ ...request, params: sanitizedParams }) + "\n");
        await writeFrame(this.#official.stdin, sanitizedFrame);
    }
    async #handoverOfficialThreadToExternal(
        request: JsonRpcRequest,
        threadId: string,
        route: Extract<CreateRoute, { harnessId: ExternalHarnessId }>,
    ): Promise<void> {
        const targetHarnessId = route.harnessId;
        const adapter = this.#externalAdapters.get(targetHarnessId);
        if (!adapter) {
            await this.#writer.json(rpcError(request, -32070, `External Harness '${targetHarnessId}' is unavailable`));
            return;
        }
        let officialThread: JsonObject | null = null;
        let officialTurns: JsonObject[] = [];
        try {
            const current = await this.#officialRequestBroker.request("thread/read", {
                threadId,
                includeTurns: true,
            });
            if (!isRecord(current.error) && isRecord(current.result) && isRecord(current.result.thread)) {
                officialThread = current.result.thread as JsonObject;
                if (Array.isArray(officialThread.turns)) {
                    officialTurns = officialThread.turns.filter((turn): turn is JsonObject => isRecord(turn));
                }
            }
        }
        catch (error) {
            this.#diagnose(error);
        }
        const params = requestObject(request);
        const cwd = typeof params.cwd === "string" && params.cwd.length > 0
            ? params.cwd
            : typeof officialThread?.cwd === "string" && (officialThread.cwd as string).length > 0
                ? (officialThread.cwd as string)
                : process.cwd();
        const title = typeof officialThread?.title === "string" ? (officialThread.title as string) : "";
        const requestedModel = route.model;
        const sessionResult = await adapter.open({
            kind: "create",
            cwd,
            environment: {
                ...(this.#options.environment ?? process.env),
                [DELEGATION_THREAD_ID_ENV]: threadId,
            },
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(route.thinkingOptionId ? { thinkingOptionId: route.thinkingOptionId } : {}),
            ...(route.permissionModeId ? { permissionModeId: route.permissionModeId } : {}),
        });
        if (!sessionResult.ok) {
            const mapped = mapExternalThreadHarnessError(sessionResult.error, "create");
            await this.#writer.json(rpcError(request, mapped.code, mapped.message));
            return;
        }
        const session = sessionResult.value;
        let hostThreadId: HostThreadId;
        try {
            hostThreadId = hostThreadIdSchema.parse(threadId);
        }
        catch (error) {
            await session.close().catch(() => undefined);
            await this.#writer.json(rpcError(request, -32602, `Invalid threadId: ${errorMessage(error)}`));
            return;
        }
        const recordInput = createExternalThreadRecordInput({
            hostThreadId,
            harnessId: adapter.harnessId,
            cwd,
            title,
            transportModelId: route.transportModelId,
            ephemeral: false,
            historyMode: "legacy",
        });
        let record;
        try {
            record = await this.#repository.createProvisional(recordInput);
            if (session.initialState.nativeRef) {
                record = await this.#repository.commitNative(record.hostThreadId, session.initialState.nativeRef);
            }
        }
        catch (error) {
            await session.close().catch(() => undefined);
            await this.#writer.json(rpcError(request, -32081, `External Thread could not be persisted: ${errorMessage(error)}`));
            return;
        }
        const threadValue = externalThreadValue({
            record,
            turns: officialTurns,
            sessionId: threadId,
        });
        const externalThread = this.#registerExternalThread({
            record,
            session,
            sessionId: threadId,
            thread: threadValue,
            turns: officialTurns,
            transportModelId: route.transportModelId,
            ...(requestedModel ? { requestedModel } : {}),
            ...(route.thinkingOptionId ? { requestedThinkingOptionId: route.thinkingOptionId } : {}),
            ...(route.permissionModeId ? { requestedPermissionModeId: route.permissionModeId } : {}),
            priorTurns: officialTurns,
        });
        this.#routeObservationTracker.bindCreatedThread(request.id, externalThread.id);
        // The Thread identity is now owned by the target Harness. Tell the
        // Renderer to discard the previous owner's Usage/credits and inspect the
        // new owner, even when the target has no token-usage event to emit.
        await this.#writer.json({
            method: THREAD_USAGE_UPDATED_METHOD,
            params: { threadId: externalThread.id },
        });
        await this.#startExternalTurn(request, externalThread, {
            handoverFrom: "official",
            turns: officialTurns,
        });
    }
    async #startExternalTurn(
        request: JsonRpcRequest,
        thread: ExternalThread,
        handoverContext?: { handoverFrom: string; turns: JsonObject[] },
    ): Promise<void> {
        if (thread.running) {
            await this.#writer.json(rpcError(request, -32072, "External Thread already has an active Turn"));
            return;
        }
        const params = requestObject(request);
        let route = null;
        if (typeof params.model === "string") {
            try {
                route = decodeCreateRoute({ id: request.id, method: "thread/start", params });
            }
            catch (error) {
                await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
                return;
            }
        }
        if (route && route.harnessId !== "codex") {
            if (route.harnessId !== thread.harnessId) {
                const targetHarnessId = route.harnessId;
                const adapter = this.#externalAdapters.get(targetHarnessId);
                if (!adapter) {
                    await this.#writer.json(rpcError(request, -32070, `External Harness '${targetHarnessId}' is unavailable`));
                    return;
                }
                const requestedModel = route.model;
                const sessionResult = await adapter.open({
                    kind: "create",
                    cwd: thread.cwd,
                    environment: {
                        ...(this.#options.environment ?? process.env),
                        [DELEGATION_THREAD_ID_ENV]: thread.id,
                    },
                    ...(requestedModel ? { model: requestedModel } : {}),
                    ...(route.thinkingOptionId ? { thinkingOptionId: route.thinkingOptionId } : {}),
                    ...(route.permissionModeId ? { permissionModeId: route.permissionModeId } : {}),
                });
                if (!sessionResult.ok) {
                    const mapped = mapExternalThreadHarnessError(sessionResult.error, "create");
                    await this.#writer.json(rpcError(request, mapped.code, mapped.message));
                    return;
                }
                const newSession = sessionResult.value;
                let updatedRecord;
                try {
                    updatedRecord = await this.#repository.handoverHarness({
                        hostThreadId: thread.id,
                        harnessId: adapter.harnessId,
                        transportModelId: route.transportModelId,
                        ...(newSession.initialState.nativeRef
                            ? { nativeSessionRef: newSession.initialState.nativeRef }
                            : {}),
                    });
                }
                catch (error) {
                    await newSession.close().catch(() => undefined);
                    await this.#writer.json(rpcError(request, -32081, `External Thread could not be persisted: ${errorMessage(error)}`));
                    return;
                }
                const priorTurns = [...thread.turns];
                const replacedThread = await this.#externalRuntime.replace(thread, {
                    record: updatedRecord,
                    session: newSession,
                    sessionId: thread.id,
                    thread: externalThreadValue({
                        record: updatedRecord,
                        turns: thread.turns,
                        sessionId: thread.id,
                    }),
                    turns: thread.turns,
                    transportModelId: route.transportModelId,
                    ...(requestedModel ? { requestedModel } : {}),
                    ...(route.thinkingOptionId ? { requestedThinkingOptionId: route.thinkingOptionId } : {}),
                    ...(route.permissionModeId ? { requestedPermissionModeId: route.permissionModeId } : {}),
                    priorTurns,
                });
                thread = replacedThread;
                handoverContext = { handoverFrom: "external", turns: priorTurns };
                await this.#writer.json({
                    method: THREAD_USAGE_UPDATED_METHOD,
                    params: { threadId: thread.id },
                });
            }
            else {
                try {
                    if (route.model &&
                        route.model.id !==
                            (thread.stateObserver.state.effectiveModel ?? thread.requestedModel)?.id) {
                        if (!thread.session.capabilities.configuration.selectModel) {
                            throw new Error("External Harness does not support Model selection");
                        }
                        const result = await thread.session.execute({
                            type: "model.select",
                            model: route.model,
                        });
                        if (!result.ok)
                            throw new Error(result.error.message);
                        thread.requestedModel = route.model;
                    }
                    if (route.thinkingOptionId &&
                        route.thinkingOptionId !== thread.requestedThinkingOptionId) {
                        if (!thread.session.capabilities.configuration.selectThinkingOption) {
                            throw new Error("External Harness does not support Thinking selection");
                        }
                        const result = await thread.session.execute({
                            type: "thinking.select",
                            thinkingOptionId: route.thinkingOptionId,
                        });
                        if (!result.ok)
                            throw new Error(result.error.message);
                        thread.requestedThinkingOptionId = route.thinkingOptionId;
                    }
                    if (route.permissionModeId &&
                        route.permissionModeId !== thread.requestedPermissionModeId) {
                        if (!thread.session.capabilities.configuration.selectPermissionMode) {
                            throw new Error("External Harness does not support Permission Mode selection");
                        }
                        const result = await thread.session.execute({
                            type: "permissionMode.select",
                            permissionModeId: route.permissionModeId,
                        });
                        if (!result.ok)
                            throw new Error(result.error.message);
                        thread.requestedPermissionModeId = route.permissionModeId;
                    }
                }
                catch (error) {
                    await this.#writer.json(rpcError(request, -32078, errorMessage(error)));
                    return;
                }
                if (route.transportModelId !== thread.transportModelId) {
                    thread.transportModelId = route.transportModelId;
                    await this.#repository
                        .setTransportModelId(thread.id, route.transportModelId)
                        .catch((err) => this.#diagnose(err));
                }
            }
        }
        else if (route && route.harnessId === "codex") {
            if (route.transportModelId !== thread.transportModelId) {
                thread.transportModelId = route.transportModelId;
                await this.#repository
                    .setTransportModelId(thread.id, route.transportModelId)
                    .catch((err) => this.#diagnose(err));
            }
        }
        let text;
        try {
            text = requestText(params);
        }
        catch (error) {
            await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
            return;
        }
        // External Goal loop: `/goal <objective>` seeds a goal that codexhost
        // keeps driving with automatic turns until completion, budget, stall, or
        // a user interrupt. This is codexhost-controlled, not the official Codex
        // `/goal` (which only drives Codex native threads).
        const goalCommand = parseGoalCommand(text);
        if (this.#options.normalizeThreadTitles &&
            (!thread.record.title || thread.record.title.trim() === "")) {
            const sourceForTitle = goalCommand ? goalCommand.objective : text;
            const autoTitle = normalizeThreadTitle(sourceForTitle);
            if (autoTitle && autoTitle.trim().length > 0) {
                try {
                    thread.record = await this.#repository.setTitle(thread.id, autoTitle);
                    thread.thread.name = autoTitle;
                    thread.thread.updatedAt = unixSeconds();
                    await this.#writer.json({
                        method: "thread/name/updated",
                        params: { threadId: thread.id, threadName: autoTitle },
                    });
                }
                catch (error) {
                    this.#diagnose(error);
                }
            }
        }
        if (goalCommand) {
            let goal;
            try {
                goal = createGoalLoop(goalCommand.objective, goalCommand.tokenBudget);
            }
            catch (error) {
                await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
                return;
            }
            this.#initializeGoalUsage(thread, goal);
            this.#goalLoops.set(thread.id, goal);
            try {
                await this.#persistGoal(thread, goal);
            }
            catch (error) {
                this.#goalLoops.delete(thread.id);
                await this.#writer.json(rpcError(request, -32081, `External Goal could not be persisted: ${errorMessage(error)}`));
                return;
            }
            text = goalSeedPrompt(goal);
            this.#emitGoalUpdated(thread, goal);
        }
        if (!goalCommand && this.#goalForThread(thread)?.status === "active") {
            await this.#writer.json(rpcError(request, -32072, "External Goal is active; pause it before sending a normal Turn"));
            return;
        }
        if (thread.session.commands) {
            const catalog = await thread.session.commands.list();
            if (!catalog.ok) {
                await this.#writer.json(rpcError(request, -32073, catalog.error.message));
                return;
            }
            const matched = catalog.value.commands
                .toSorted((left: HarnessCommandDescriptor, right: HarnessCommandDescriptor) => right.invocation.length - left.invocation.length)
                .find((command: HarnessCommandDescriptor) => {
                if (text === command.invocation)
                    return true;
                return command.argumentMode === "text" && text.startsWith(`${command.invocation} `);
            });
            if (matched) {
                const argumentText = text.slice(matched.invocation.length).trimStart();
                try {
                    await this.#startExternalCommand(request, thread, matched.id, argumentText.length > 0 ? { text: argumentText } : undefined, undefined, "turn");
                }
                catch (error) {
                    this.#diagnose(error);
                    await this.#writer.json(rpcError(request, -32073, `External Harness command failed: ${errorMessage(error)}`));
                }
                return;
            }
        }
        const turnId = hostTurnIdSchema.parse(randomUUID());
        const startedAtMs = Date.now();
        const goal = this.#goalForThread(thread);
        if (goal?.status === "active") {
            goal.inFlightTurnId = turnId;
            try {
                await this.#persistGoal(thread, goal);
            }
            catch (error) {
                delete goal.inFlightTurnId;
                await this.#writer.json(rpcError(request, -32081, `External Goal could not be persisted: ${errorMessage(error)}`));
                return;
            }
        }
        const projection: ProjectedTurn = {
            projector: new CodexTurnProjector({
                threadId: thread.id,
                turnId,
                cwd: thread.cwd,
                startedAtMs,
            }),
        };
        const gate = turnProjectionGate();
        thread.running = true;
        thread.activeTurnId = turnId;
        thread.projectedTurns.set(turnId, projection);
        thread.responseGates.set(turnId, gate);
        let sessionInputText = text;
        if (handoverContext && handoverContext.turns.length > 0) {
            const visible = allVisibleMessages(handoverContext.turns);
            if (visible.length > 0) {
                sessionInputText = formatHandoverContext(visible, text);
            }
        }
        const result = await thread.session.execute({
            type: "turn.start",
            turnId,
            input: [{ type: "text", text: sessionInputText }],
        });
        if (!result.ok) {
            thread.running = false;
            thread.activeTurnId = null;
            thread.projectedTurns.delete(turnId);
            thread.responseGates.delete(turnId);
            gate.resolve();
            this.#signalActiveWorkChanged();
            if (goal?.inFlightTurnId === turnId) {
                delete goal.inFlightTurnId;
                await this.#persistGoal(thread, goal).catch((error) => this.#diagnose(error));
            }
            await this.#writer.json(rpcError(request, -32073, result.error.message));
            return;
        }
        try {
            await this.#writer.json(rpcEnvelope(request, { result: { turn: projection.projector.pendingTurn() } }));
        }
        finally {
            gate.resolve();
        }
    }
    async #interruptExternalTurn(
        request: JsonRpcRequest,
        thread: ExternalThread,
        requestedTurnId: JsonValue | undefined,
    ): Promise<void> {
        if (typeof requestedTurnId !== "string" ||
            !thread.running ||
            thread.activeTurnId !== requestedTurnId) {
            await this.#writer.json(rpcError(request, -32074, "External turn/interrupt must reference the active Turn"));
            return;
        }
        const turnId = thread.activeTurnId;
        const gate = turnProjectionGate();
        thread.responseGates.set(turnId, gate);
        const result = await thread.session.execute({ type: "turn.cancel", turnId });
        if (!result.ok) {
            gate.resolve();
            await this.#writer.json(rpcError(request, -32074, result.error.message));
            return;
        }
        // A user interrupt pauses any active External Goal loop.
        const goal = this.#goalForThread(thread);
        if (goal && goal.status === "active") {
            setGoalStatus(goal, "paused", Date.now(), "user_interrupt");
            await this.#persistGoal(thread, goal).catch((error) => this.#diagnose(error));
            this.#emitGoalUpdated(thread, goal);
        }
        try {
            await this.#writer.json(rpcEnvelope(request, { result: {} }));
        }
        finally {
            gate.resolve();
        }
    }
    async #consumeHarnessOutputs(thread: ExternalThread): Promise<void> {
        try {
            for await (const output of thread.session.outputs) {
                try {
                    await this.#projectHarnessOutput(thread, output);
                }
                catch (error) {
                    this.#diagnose(error);
                }
            }
        }
        catch (error) {
            this.#diagnose(error);
        }
        finally {
            const activeTurnId = thread.activeTurnId ?? [...thread.projectedTurns.keys()][0];
            if (activeTurnId) {
                await this.#finalizeExternalTurn(thread, activeTurnId, {
                    status: "failed",
                    error: {
                        code: "internalError",
                        message: "External harness output stream terminated unexpectedly",
                        retryable: false,
                    },
                }).catch((error) => this.#diagnose(error));
            }
            else if (thread.running) {
                thread.running = false;
                await this.#setThreadStatus(
                    thread,
                    this.#hasRunningSubagents(thread.id)
                        ? { type: "active", activeFlags: [] }
                        : { type: "idle" },
                ).catch(() => undefined);
                this.#signalActiveWorkChanged();
            }
            // A terminated output stream always means the Session is gone, whatever
            // terminal state the Adapter managed to publish before it ended.
            await this.#finalizeFaultedSubagents(thread);
            this.#retireFaultedSession(thread, false);
        }
    }
    #goalForThread(thread: ExternalThread): GoalLoopState | undefined {
        const current = this.#goalLoops.get(thread.id);
        if (current)
            return current;
        if (!thread.record.goal)
            return undefined;
        const restored = fromStoredGoal(thread.record.goal);
        this.#goalLoops.set(thread.id, restored);
        return restored;
    }
    async #persistGoal(thread: ExternalThread, goal: GoalLoopState): Promise<void> {
        const expectedRevision = thread.record.goal?.revision;
        const record = await this.#repository.setGoal(thread.id, toStoredGoal(goal, thread.harnessId), expectedRevision);
        thread.record = record;
        thread.thread.updatedAt = unixSeconds();
    }
    #cancelGoalContinuation(threadId: string): void {
        const timer = this.#goalContinuationTimers.get(threadId);
        if (timer)
            clearTimeout(timer);
        this.#goalContinuationTimers.delete(threadId);
    }
    #scheduleGoalContinuation(thread: ExternalThread, recovery = false, seed = false): void {
        if (this.#goalContinuationTimers.has(thread.id))
            return;
        const timer = setTimeout(() => {
            this.#goalContinuationTimers.delete(thread.id);
            void (async () => {
                const goal = this.#goalForThread(thread);
                if (!goal || goal.status !== "active" || thread.running)
                    return;
                let prompt = seed ? goalSeedPrompt(goal) : goalContinuePrompt(goal);
                if (recovery && goal.inFlightTurnId) {
                    delete goal.inFlightTurnId;
                    await this.#persistGoal(thread, goal);
                    prompt = this.#goalRecoveryPrompt(goal);
                }
                await this.#startDelegatedExternalTurn(thread, prompt, randomUUID());
            })().catch(async (error) => {
                const goal = this.#goalForThread(thread);
                if (goal && goal.status === "active") {
                    setGoalStatus(goal, "blocked", Date.now(), "runtime_error");
                    await this.#persistGoal(thread, goal).catch(() => undefined);
                    this.#emitGoalUpdated(thread, goal);
                }
                this.#diagnose(error);
            });
        }, 0);
        this.#goalContinuationTimers.set(thread.id, timer);
    }
    #goalUsageTokens(usage: HostUsage | null | undefined): number | undefined {
        if (!usage)
            return undefined;
        if (usage.totalTokens !== undefined)
            return usage.totalTokens;
        if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
            return usage.inputTokens + usage.outputTokens;
        }
        return undefined;
    }
    async #readGoalUsage(thread: ExternalThread, turnId: HostTurnId): Promise<number | undefined> {
        const known = thread.usageByTurn.get(hostTurnIdSchema.parse(turnId));
        if (known)
            return this.#goalUsageTokens(known);
        const usage = thread.session.readUsage
            ? await thread.session.readUsage().catch(() => null)
            : null;
        if (usage) {
            thread.latestUsage = usage;
            thread.usageTurnId = hostTurnIdSchema.parse(turnId);
            thread.usageByTurn.set(hostTurnIdSchema.parse(turnId), usage);
            return this.#goalUsageTokens(usage);
        }
        if (thread.usageTurnId === turnId)
            return this.#goalUsageTokens(thread.latestUsage);
        return undefined;
    }
    #initializeGoalUsage(thread: ExternalThread, goal: GoalLoopState): void {
        const current = this.#goalUsageTokens(thread.latestUsage);
        if (current === undefined)
            return;
        goal.usageBaselineTokens = current;
        goal.usageTotalTokens = current;
    }
    #accountGoalUsage(goal: GoalLoopState, currentTotal: number | undefined): number {
        if (currentTotal === undefined)
            return 0;
        if (goal.usageBaselineTokens === undefined)
            goal.usageBaselineTokens = currentTotal;
        const previous = goal.usageTotalTokens ?? goal.usageBaselineTokens;
        const delta = Math.max(0, currentTotal - previous);
        goal.usageTotalTokens = Math.max(previous, currentTotal);
        goal.tokensUsed += delta;
        return delta;
    }
    #goalDecisionMatches(goal: GoalLoopState, decision: ReturnType<typeof parseGoalDecision>): boolean {
        return Boolean(decision &&
            (!decision.goalId || decision.goalId === goal.goalId) &&
            (decision.goalRevision === undefined || decision.goalRevision === goal.revision));
    }
    async #hasCompletionEvidence(thread: ExternalThread, decision: NonNullable<ReturnType<typeof parseGoalDecision>>): Promise<boolean> {
        for (const evidence of decision.completionEvidence) {
            const type = evidence.type;
            if (type === "loopx-audit") {
                if (evidence.status === "pass")
                    return true;
                continue;
            }
            if (type === "command") {
                if (evidence.exit_code === 0 || evidence.exitCode === 0)
                    return true;
                continue;
            }
            if (type === "research-source") {
                if (typeof evidence.uri !== "string" || evidence.uri.trim().length === 0)
                    continue;
                try {
                    if (new URL(evidence.uri).protocol.length > 0)
                        return true;
                }
                catch {
                    // An invalid source URI is not completion evidence.
                }
                continue;
            }
            if (type !== "file" && type !== "artifact")
                continue;
            if (typeof evidence.path !== "string" || evidence.path.trim().length === 0)
                continue;
            const resolved = path.resolve(thread.cwd, evidence.path);
            const relative = path.relative(thread.cwd, resolved);
            if (relative.startsWith("..") || path.isAbsolute(relative))
                continue;
            try {
                await stat(resolved);
                return true;
            }
            catch {
                // The model named an artifact that is not present on disk.
            }
        }
        return false;
    }
    async #maybeContinueGoalLoop(thread: ExternalThread, completedTurnId: HostTurnId): Promise<void> {
        const goal = this.#goalForThread(thread);
        if (!goal || goal.lastCompletedTurnId === completedTurnId)
            return;
        if (goal.inFlightTurnId !== completedTurnId)
            return;
        delete goal.inFlightTurnId;
        goal.lastCompletedTurnId = completedTurnId;
        const lastTurn = thread.turns[thread.turns.length - 1];
        const response = lastAgentMessageText(lastTurn);
        const parsedDecision = parseGoalDecision(response);
        const decision = this.#goalDecisionMatches(goal, parsedDecision) ? parsedDecision : null;
        const currentTotal = await this.#readGoalUsage(thread, completedTurnId);
        this.#accountGoalUsage(goal, currentTotal);
        if (goal.status !== "active") {
            await this.#persistGoal(thread, goal);
            this.#emitGoalUpdated(thread, goal);
            return;
        }
        if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
            setGoalStatus(goal, "budget_limited", Date.now(), "token_budget");
            await this.#persistGoal(thread, goal);
            this.#emitGoalUpdated(thread, goal);
            return;
        }
        if (decision?.kind === "complete" && (await this.#hasCompletionEvidence(thread, decision))) {
            goal.loopTurnCount += 1;
            goal.lastProgressAtMs = Date.now();
            setGoalStatus(goal, "complete");
            await this.#persistGoal(thread, goal);
            this.#emitGoalUpdated(thread, goal);
            return;
        }
        const failed = this.#lastTurnFailed(lastTurn);
        const progress = !failed && hasTurnProgress(lastTurn, decision);
        const blocker = failed
            ? "turn_failed"
            : decision?.kind === "blocked"
                ? decision.blockerFingerprint
                : decision?.kind === "complete"
                    ? "completion_audit_failed"
                    : undefined;
        const status = advanceGoalLoop(goal, 0, progress, Date.now(), blocker);
        await this.#persistGoal(thread, goal);
        this.#emitGoalUpdated(thread, goal);
        if (status === "active")
            this.#scheduleGoalContinuation(thread);
    }
    /** True when the most recent completed Turn ended in failure rather than an agent reply. */
    #lastTurnFailed(lastTurn: unknown): boolean {
        return isRecord(lastTurn) && lastTurn.status === "failed";
    }
    /** Trace how a desktop thread/goal RPC was routed (stderr + a stable temp file). */
    #traceGoal(action: string, method: string, threadId: string | null | undefined): void {
        const line = `codexhost goal-${action} §threads ${method} threadId=${JSON.stringify(threadId ?? null)} pid=${process.pid}`;
        void this.#options.diagnosticOutput.write(`${line}\n`);
        try {
            appendFileSync(`${tmpdir()}/codexhost-goal-diag.log`, `${new Date().toISOString()} ${line}\n`, "utf8");
        }
        catch {
            // Diagnostics must never crash the request loop.
        }
    }
    #goalRecoveryPrompt(goal: GoalLoopState): string {
        const budgetLine = goal.tokenBudget !== undefined ? `\n\n总 token 预算 ${goal.tokenBudget} 不变。` : "";
        return [
            `【自主目标续做 · 上一轮被中断】目标仍是：${goal.objective}${budgetLine}`,
            "上一轮在未产生最终回复前被超时中断。请先核对目前磁盘/对话中已落地的进度",
            "（已改的文件、已跑通的部分），挑出最近一个真正未完成且仍可继续的子任务，",
            "从那里继续推进；不要从零重复已经做完的工作。",
            "彻底完成时提供 completion_evidence；确实无法继续时提供 blocker_fingerprint。",
        ].join("\n");
    }
    #emitGoalUpdated(thread: ExternalThread, goal: GoalLoopState): void {
        void this.#writer.json({
            method: "thread/goal/updated",
            params: {
                threadId: thread.id,
                goal: toThreadGoal(goal),
            },
        });
    }
    #emitGoalCleared(threadId: string): void {
        void this.#writer.json({
            method: "thread/goal/cleared",
            params: {
                threadId,
            },
        });
    }
    async #setExternalThreadGoal(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
        const params = requestObject(request);
        const rawObjective = typeof params.objective === "string" ? params.objective.trim() : undefined;
        const rawStatus = typeof params.status === "string" ? params.status : undefined;
        const rawBudget = params.tokenBudget;
        if (rawBudget !== undefined &&
            (typeof rawBudget !== "number" || !Number.isSafeInteger(rawBudget) || rawBudget <= 0)) {
            await this.#writer.json(rpcError(request, -32602, "tokenBudget must be a positive integer"));
            return;
        }
        const goal = this.#goalForThread(thread);
        if (rawObjective) {
            if (rawStatus && rawStatus !== "active") {
                await this.#writer.json(rpcError(request, -32602, "A new objective can only be set with status active"));
                return;
            }
            if (thread.running) {
                await this.#writer.json(rpcError(request, -32072, "Pause the External Goal before replacing its objective"));
                return;
            }
            let nextGoal;
            try {
                nextGoal = createGoalLoop(rawObjective, rawBudget);
            }
            catch (error) {
                await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
                return;
            }
            this.#initializeGoalUsage(thread, nextGoal);
            this.#goalLoops.set(thread.id, nextGoal);
            try {
                await this.#persistGoal(thread, nextGoal);
            }
            catch (error) {
                this.#goalLoops.delete(thread.id);
                await this.#writer.json(rpcError(request, -32081, `External Goal could not be persisted: ${errorMessage(error)}`));
                return;
            }
            this.#emitGoalUpdated(thread, nextGoal);
            await this.#writer.json(rpcEnvelope(request, { result: { goal: toThreadGoal(nextGoal) } }));
            this.#scheduleGoalContinuation(thread, false, true);
            return;
        }
        if (rawStatus) {
            if (!goal) {
                await this.#writer.json(rpcError(request, -32602, "No active goal found for thread"));
                return;
            }
            const allowed = new Set<string>([
                "active",
                "paused",
                "blocked",
                "usage_limited",
                "budget_limited",
                "complete",
            ]);
            if (!allowed.has(rawStatus)) {
                await this.#writer.json(rpcError(request, -32602, `Unsupported Goal status '${rawStatus}'`));
                return;
            }
            const status = rawStatus as ThreadGoalStatus;
            const reason = status === "paused"
                ? "user_pause"
                : status === "blocked"
                    ? "runtime_error"
                    : status === "usage_limited"
                        ? "usage_limit"
                        : status === "budget_limited"
                            ? "token_budget"
                            : undefined;
            setGoalStatus(goal, status, Date.now(), reason);
            if (status !== "active")
                this.#cancelGoalContinuation(thread.id);
            try {
                await this.#persistGoal(thread, goal);
            }
            catch (error) {
                await this.#writer.json(rpcError(request, -32081, `External Goal could not be persisted: ${errorMessage(error)}`));
                return;
            }
            this.#emitGoalUpdated(thread, goal);
            await this.#writer.json(rpcEnvelope(request, { result: { goal: toThreadGoal(goal) } }));
            if (status === "paused" ||
                status === "complete" ||
                status === "blocked" ||
                status === "usage_limited" ||
                status === "budget_limited") {
                if (thread.running && thread.activeTurnId) {
                    await thread.session
                        .execute({ type: "turn.cancel", turnId: thread.activeTurnId })
                        .catch(() => undefined);
                }
            }
            else if (status === "active" && !thread.running) {
                this.#scheduleGoalContinuation(thread, Boolean(goal.inFlightTurnId));
            }
            return;
        }
        if (!goal) {
            await this.#writer.json(rpcError(request, -32602, "Objective or status is required for thread/goal/set"));
            return;
        }
        await this.#writer.json(rpcEnvelope(request, { result: { goal: toThreadGoal(goal) } }));
    }
    async #clearExternalThreadGoal(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
        const goal = this.#goalForThread(thread);
        this.#cancelGoalContinuation(thread.id);
        try {
            thread.record = await this.#repository.clearGoal(thread.id, goal?.revision);
        }
        catch (error) {
            await this.#writer.json(rpcError(request, -32081, `External Goal could not be cleared: ${errorMessage(error)}`));
            return;
        }
        this.#goalLoops.delete(thread.id);
        if (thread.running && thread.activeTurnId) {
            await thread.session
                .execute({ type: "turn.cancel", turnId: thread.activeTurnId })
                .catch(() => undefined);
        }
        this.#emitGoalCleared(thread.id);
        await this.#writer.json(rpcEnvelope(request, { result: {} }));
    }
    async #getExternalThreadGoal(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
        const goal = this.#goalForThread(thread);
        if (!goal) {
            await this.#writer.json(rpcEnvelope(request, { result: { goal: null } }));
            return;
        }
        if (goal.status === "active") {
            updateGoalActiveTime(goal);
        }
        await this.#writer.json(rpcEnvelope(request, { result: { goal: toThreadGoal(goal) } }));
    }
    async #getCachedExternalThreadGoal(request: JsonRpcRequest, record: StoredThreadRecordV1): Promise<void> {
        const goal = record.goal ? fromStoredGoal(record.goal) : null;
        await this.#writer.json(rpcEnvelope(request, {
            result: { goal: goal ? toThreadGoal(goal) : null },
        }));
    }
    async #finalizeExternalTurn(
        thread: ExternalThread,
        turnId: HostTurnId,
        outcome: TurnOutcome,
        nativeTurnRef?: NativeTurnRef,
    ): Promise<void> {
        if (!thread.projectedTurns.has(turnId)) {
            if (thread.activeTurnId === turnId) {
                thread.activeTurnId = null;
                thread.running = false;
                await this.#setThreadStatus(
                    thread,
                    this.#hasRunningSubagents(thread.id)
                        ? { type: "active", activeFlags: [] }
                        : { type: "idle" },
                ).catch(() => undefined);
                this.#signalActiveWorkChanged();
            }
            return;
        }
        const projection = this.#projectedTurn(thread, turnId);
        await this.#waitForTurnResponse(thread, turnId);
        // A Harness that dies mid-Turn never publishes the Interaction closure that
        // normally retires the Desktop prompt, so the terminal Turn owns that cleanup.
        await this.#retireTurnDesktopInteractions(thread, turnId);
        let event: TurnCompletedEvent = {
            type: "turn.completed",
            turnId,
            outcome,
            ...(nativeTurnRef ? { nativeTurnRef } : {}),
        };
        const ephemeralTurn = thread.ephemeralTurnIds.has(turnId);
        if (!ephemeralTurn) {
            const persistenceError = await this.#persistTerminalIdentity(thread, event);
            if (persistenceError) {
                event = {
                    type: "turn.completed",
                    turnId,
                    outcome: {
                        status: "failed",
                        error: {
                            code: "internalError",
                            message: "External Turn identity could not be persisted",
                            retryable: false,
                        },
                    },
                };
            }
        }
        const result = projection.projector.project(event);
        if (!result.completedTurn)
            throw new Error("Turn projector returned no completed Turn");
        const completedAt = Math.floor(Date.now() / 1000);
        if (ephemeralTurn) {
            thread.ephemeralTurnIds.delete(turnId);
        }
        else {
            thread.turns.push(result.completedTurn);
            thread.thread.updatedAt = completedAt;
            thread.thread.recencyAt = completedAt;
        }
        thread.historyHydrated = false;
        thread.running = false;
        thread.activeTurnId = null;
        thread.projectedTurns.delete(turnId);
        thread.responseGates.delete(turnId);
        this.#signalActiveWorkChanged();
        const delegation = await this.#repository.getDelegationByChild(thread.record.hostThreadId);
        if (delegation) {
            const status = result.completedTurn.status === "failed"
                ? "failed"
                : result.completedTurn.status === "interrupted"
                    ? "interrupted"
                    : "completed";
            await this.#repository.setDelegationStatus(delegation.delegationId, status);
        }
        for (const message of result.messages)
            await this.#writer.json(message);
        await this.#setThreadStatus(thread, this.#hasRunningSubagents(thread.id)
            ? { type: "active", activeFlags: [] }
            : { type: "idle" });
        await this.#maybeContinueGoalLoop(thread, turnId).catch((error) => this.#diagnose(error));
    }
    /** Retires Desktop approval/question prompts that belong to a Turn that will never answer them. */
    async #retireTurnDesktopInteractions(thread: ExternalThread, turnId: HostTurnId): Promise<void> {
        const interactionIds = new Set<HostInteractionId>();
        for (const pending of this.#pendingDesktopApprovals.values()) {
            if (pending.thread === thread && pending.interaction.turnId === turnId)
                interactionIds.add(pending.interaction.interactionId);
        }
        for (const pending of this.#pendingDesktopQuestions.values()) {
            if (pending.thread === thread && pending.interaction.turnId === turnId)
                interactionIds.add(pending.interaction.interactionId);
        }
        for (const interactionId of interactionIds) {
            await this.#resolveDesktopApproval(interactionId);
            await this.#resolveDesktopQuestion(interactionId);
        }
    }
    /**
     * A dead Session can never publish Subagent terminal states, so a Parent that owned
     * running Subagents would otherwise stay "active" forever.
     */
    async #finalizeFaultedSubagents(thread: ExternalThread): Promise<void> {
        const running = this.#runningSubagentsByParent.get(thread.id);
        if (!running || running.size === 0)
            return;
        for (const childThreadId of [...running]) {
            this.#trackRunningSubagent(thread.id, childThreadId, "idle");
            await this.#setSubagentThreadStatus(childThreadId, "idle").catch((error) =>
                this.#diagnose(error),
            );
        }
        if (!thread.running && !thread.activeTurnId)
            await this.#setThreadStatus(thread, { type: "idle" }).catch(() => undefined);
    }
    /**
     * Drops a Session that can no longer execute so the next command restores the Thread
     * through the ordinary resume path instead of failing with "Session is not open".
     */
    #retireFaultedSession(thread: ExternalThread, closeSession = true): void {
        if (this.#externalRuntime.get(thread.id) !== thread)
            return;
        this.#externalRuntime.remove(thread.id);
        if (closeSession)
            void thread.session.close().catch((error) => this.#diagnose(error));
    }
    async #projectHarnessOutput(thread: ExternalThread, output: HarnessOutput): Promise<void> {
        if (output.kind === "interaction") {
            if (output.interaction.type === "approval") {
                await this.#projectApproval(thread, output.interaction);
            }
            else {
                await this.#projectQuestion(thread, output.interaction);
            }
            return;
        }
        let event = output.event;
        if (event.type === "item.started" && event.item.type === "subagentDelegation") {
            event = {
                ...event,
                item: {
                    ...event.item,
                    subagents: await Promise.all(event.item.subagents.map((subagent: HostSubagentState) => this.#materializeSubagent(thread, subagent).catch(() => subagent))),
                },
            };
        }
        if (event.type === "item.updated" && event.update.type === "subagents.replace") {
            event = {
                ...event,
                update: {
                    ...event.update,
                    subagents: await Promise.all(event.update.subagents.map((subagent: HostSubagentState) => this.#materializeSubagent(thread, subagent).catch(() => subagent))),
                },
            };
        }
        if (event.type === "item.completed" && event.snapshot.item.type === "subagentDelegation") {
            event = {
                ...event,
                snapshot: {
                    ...event.snapshot,
                    item: {
                        ...event.snapshot.item,
                        subagents: await Promise.all(event.snapshot.item.subagents.map((subagent: HostSubagentState) => this.#materializeSubagent(thread, subagent).catch(() => subagent))),
                    },
                },
            };
        }
        if (event.type === "session.state.changed") {
            try {
                if (event.state.nativeRef) {
                    if (!thread.record.nativeSessionRef) {
                        thread.record = await this.#repository.commitNative(thread.id, event.state.nativeRef);
                    }
                    else if (thread.record.nativeSessionRef.harnessId !== event.state.nativeRef.harnessId ||
                        thread.record.nativeSessionRef.nativeSessionId !== event.state.nativeRef.nativeSessionId) {
                        throw new Error("External Session changed Native identity");
                    }
                }
                thread.stateObserver.update(event.state);
            }
            catch (error) {
                thread.persistenceError = error instanceof Error ? error : new Error(errorMessage(error));
                thread.stateObserver.fault(thread.persistenceError);
                this.#diagnose("External Session state could not be persisted");
            }
            return;
        }
        if (event.type === "session.usage.changed") {
            if (this.#externalRuntime.get(thread.id) !== thread)
                return;
            thread.latestUsage = event.usage;
            if (event.usage === null) {
                thread.usageTurnId = null;
                await this.#writer.json({
                    method: THREAD_USAGE_UPDATED_METHOD,
                    params: { threadId: thread.id },
                });
                return;
            }
            const turnId = event.observedForTurnId
                ? this.#isKnownExternalTurn(thread, event.observedForTurnId)
                    ? event.observedForTurnId
                    : null
                : (thread.activeTurnId ?? this.#latestCompletedTurnId(thread));
            thread.usageTurnId = turnId;
            if (turnId) {
                thread.usageByTurn.set(turnId, event.usage);
                const goal = this.#goalForThread(thread);
                if (goal &&
                    goal.status === "active" &&
                    goal.lastCompletedTurnId === turnId &&
                    !goal.inFlightTurnId) {
                    const beforeTokens = goal.tokensUsed;
                    this.#accountGoalUsage(goal, this.#goalUsageTokens(event.usage));
                    if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
                        setGoalStatus(goal, "budget_limited", Date.now(), "token_budget");
                        this.#cancelGoalContinuation(thread.id);
                    }
                    if (goal.tokensUsed !== beforeTokens || goal.status !== "active") {
                        await this.#persistGoal(thread, goal).catch((error) => this.#diagnose(error));
                        this.#emitGoalUpdated(thread, goal);
                    }
                }
                await this.#waitForTurnResponse(thread, turnId);
                await this.#writeExternalUsage(thread, turnId);
            }
            await this.#writer.json({
                method: THREAD_USAGE_UPDATED_METHOD,
                params: { threadId: thread.id },
            });
            return;
        }
        if (event.type === "subagent.transcript.changed") {
            const nativeSubagentId = event.nativeSubagentId;
            const record = (await this.#repository.list()).find((candidate) => candidate.subagent && candidate.subagent.parentHostThreadId === thread.id &&
                candidate.subagent.nativeSubagentId === nativeSubagentId);
            if (record)
                await this.#refreshOpenSubagentThread(record.hostThreadId, false);
            return;
        }
        if (event.type === "subagent.state.changed") {
            const nativeSubagentId = event.nativeSubagentId;
            const record = (await this.#repository.list()).find((candidate) => candidate.subagent && candidate.subagent.parentHostThreadId === thread.id &&
                candidate.subagent.nativeSubagentId === nativeSubagentId);
            if (!record)
                return;
            const status = event.status === "pending" || event.status === "running" ? "active" : "idle";
            this.#trackRunningSubagent(thread.id, record.hostThreadId, status);
            await this.#setSubagentThreadStatus(record.hostThreadId, status);
            if (!thread.running && !thread.activeTurnId && !this.#hasRunningSubagents(thread.id)) {
                await this.#setThreadStatus(thread, { type: "idle" });
            }
            return;
        }
        if (event.type === "session.faulted") {
            thread.stateObserver.fault(new Error(event.error.message));
            this.#diagnose(`${thread.harnessId} Harness Session faulted: ${event.error.message}`);
            const activeTurnId = thread.activeTurnId ?? [...thread.projectedTurns.keys()][0];
            try {
                if (activeTurnId) {
                    await this.#finalizeExternalTurn(thread, activeTurnId, {
                        status: "failed",
                        error: {
                            code: "nativeFailure",
                            message: event.error.message,
                            retryable: false,
                        },
                    });
                } else if (thread.running) {
                    thread.running = false;
                    await this.#setThreadStatus(
                        thread,
                        this.#hasRunningSubagents(thread.id)
                            ? { type: "active", activeFlags: [] }
                            : { type: "idle" },
                    );
                    this.#signalActiveWorkChanged();
                }
            }
            finally {
                await this.#finalizeFaultedSubagents(thread);
                this.#retireFaultedSession(thread);
            }
            return;
        }
        if (event.type === "turn.autonomous.started") {
            if (thread.running || thread.activeTurnId) {
                throw new Error("External autonomous Turn started while another Turn is active");
            }
            const projection = {
                projector: new CodexTurnProjector({
                    threadId: thread.id,
                    turnId: event.turnId,
                    cwd: thread.cwd,
                    startedAtMs: Date.now(),
                }),
            };
            thread.running = true;
            thread.activeTurnId = event.turnId;
            thread.projectedTurns.set(event.turnId, projection);
            thread.responseGates.set(event.turnId, {
                promise: Promise.resolve(),
                resolve: () => undefined,
            });
            return;
        }
        if (event.type === "turn.completed") {
            await this.#finalizeExternalTurn(thread, event.turnId, event.outcome, event.nativeTurnRef);
            return;
        }
        const projection = this.#projectedTurn(thread, event.turnId);
        await this.#waitForTurnResponse(thread, event.turnId);
        if (event.type === "interaction.closed" &&
            thread.ignoredInteractionIds.delete(event.interactionId)) {
            return;
        }
        if (event.type === "interaction.closed") {
            await this.#resolveDesktopApproval(event.interactionId);
            await this.#resolveDesktopQuestion(event.interactionId);
        }
        const result = projection.projector.project(event);
        if (event.type === "turn.started") {
            await this.#setThreadStatus(thread, { type: "active", activeFlags: [] });
        }
        for (const message of result.messages)
            await this.#writer.json(message);
    }
    async #materializeSubagent(
        parent: ExternalThread,
        subagent: HostSubagentState,
    ): Promise<HostSubagentState> {
        if (!subagent.nativeSubagentId || !parent.record.nativeSessionRef)
            return subagent;
        const status = subagent.status === "pending" || subagent.status === "running" ? "active" : "idle";
        const records = await this.#repository.list();
        const existing = records.find((record) => record.subagent && record.subagent.parentHostThreadId === parent.id &&
            record.subagent.nativeSubagentId === subagent.nativeSubagentId);
        if (existing) {
            this.#trackRunningSubagent(parent.id, existing.hostThreadId, status);
            await this.#setSubagentThreadStatus(existing.hostThreadId, status);
            return { ...subagent, subagentId: existing.hostThreadId };
        }
        const recordInput = createExternalThreadRecordInput({
            harnessId: parent.record.harnessId,
            cwd: parent.cwd,
            title: subagent.description,
            transportModelId: parent.transportModelId,
            ephemeral: false,
            historyMode: "paginated",
            subagent: {
                parentHostThreadId: parent.id,
                nativeSubagentId: subagent.nativeSubagentId,
                ...(subagent.role ? { role: subagent.role } : {}),
            },
        });
        let record = await this.#repository.createProvisional(recordInput);
        record = await this.#repository.commitNative(record.hostThreadId, parent.record.nativeSessionRef);
        const thread = externalThreadValue({
            record,
            turns: [],
            sessionId: parent.sessionId,
            running: status === "active",
        });
        this.#subagentThreadStatuses.set(record.hostThreadId, status);
        this.#trackRunningSubagent(parent.id, record.hostThreadId, status);
        await this.#writer.json({
            method: "thread/started",
            emittedAtMs: Date.now(),
            params: { thread },
        });
        return { ...subagent, subagentId: record.hostThreadId };
    }
    async #refreshOpenSubagentThread(threadId: HostThreadId, terminal = true): Promise<void> {
        const child = this.#externalRuntime.get(threadId);
        if (!child)
            return;
        const previousItems = new Map(child.turns.flatMap((turn) => Array.isArray(turn.items)
            ? turn.items.flatMap((item) => isRecord(item) && typeof item.id === "string"
                ? ([[item.id, JSON.stringify(item)]] as const)
                : [])
            : []));
        const refreshed = await this.#refreshExternalThread(child);
        if (refreshed) {
            this.#diagnose(refreshed.message);
            return;
        }
        const emittedAtMs = Date.now();
        for (const turn of child.turns) {
            if (typeof turn.id !== "string" || !Array.isArray(turn.items))
                continue;
            const changedItems = turn.items.filter((item): item is JsonObject => isRecord(item) &&
                typeof item.id === "string" &&
                previousItems.get(item.id) !== JSON.stringify(item));
            if (changedItems.length > 0) {
                await this.#writer.json({
                    method: "turn/started",
                    emittedAtMs,
                    params: {
                        threadId,
                        turn: {
                            ...turn,
                            status: "inProgress",
                            completedAt: null,
                            durationMs: null,
                        },
                    },
                });
            }
            for (const item of changedItems) {
                await this.#writer.json({
                    method: "item/started",
                    emittedAtMs,
                    params: {
                        threadId,
                        turnId: turn.id,
                        startedAtMs: emittedAtMs,
                        item,
                    },
                });
                await this.#writer.json({
                    method: "item/completed",
                    emittedAtMs,
                    params: {
                        threadId,
                        turnId: turn.id,
                        completedAtMs: emittedAtMs,
                        item,
                    },
                });
            }
            if (terminal) {
                await this.#writer.json({
                    method: "turn/completed",
                    emittedAtMs,
                    params: { threadId, turn },
                });
            }
        }
    }
    #trackRunningSubagent(parentThreadId: HostThreadId, childThreadId: HostThreadId, status: "active" | "idle"): void {
        let running = this.#runningSubagentsByParent.get(parentThreadId);
        if (status === "active") {
            if (!running) {
                running = new Set();
                this.#runningSubagentsByParent.set(parentThreadId, running);
            }
            running.add(childThreadId);
            return;
        }
        if (!running)
            return;
        running.delete(childThreadId);
        if (running.size === 0)
            this.#runningSubagentsByParent.delete(parentThreadId);
    }
    #hasRunningSubagents(parentThreadId: HostThreadId): boolean {
        return (this.#runningSubagentsByParent.get(parentThreadId)?.size ?? 0) > 0;
    }
    async #setSubagentThreadStatus(threadId: HostThreadId, status: "active" | "idle"): Promise<void> {
        const previousStatus = this.#subagentThreadStatuses.get(threadId);
        const child = this.#externalRuntime.get(threadId);
        if (child) {
            child.running = status === "active";
            if (status === "idle")
                child.historyHydrated = false;
            child.thread = externalThreadValue({
                record: child.record,
                turns: child.turns,
                sessionId: child.sessionId,
                running: child.running,
            });
        }
        if (status === "idle" && previousStatus === "active") {
            for (const [index, waitMs] of SUBAGENT_TERMINAL_REFRESH_DELAYS_MS.entries()) {
                if (waitMs > 0)
                    await delay(waitMs);
                await this.#refreshOpenSubagentThread(threadId, index === SUBAGENT_TERMINAL_REFRESH_DELAYS_MS.length - 1);
            }
        }
        if (previousStatus === status)
            return;
        this.#subagentThreadStatuses.set(threadId, status);
        await this.#writer.json({
            method: "thread/status/changed",
            emittedAtMs: Date.now(),
            params: {
                threadId,
                status: status === "active" ? { type: "active", activeFlags: [] } : { type: "idle" },
            },
        });
    }
    async #projectApproval(thread: ExternalThread, interaction: HostApprovalInteraction): Promise<void> {
        const projection = this.#projectedTurn(thread, interaction.turnId);
        await this.#waitForTurnResponse(thread, interaction.turnId);
        let result: CodexApprovalProjection;
        try {
            result = projection.projector.projectApproval(interaction, approvalServerName(thread.harnessId));
        }
        catch (error) {
            this.#diagnose(error);
            thread.ignoredInteractionIds.add(interaction.interactionId);
            const denied = await this.#denyApproval(thread, interaction);
            if (!denied)
                thread.ignoredInteractionIds.delete(interaction.interactionId);
            return;
        }
        for (const message of result.messages)
            await this.#writer.json(message);
        const requestId = this.#allocateApprovalRequestId();
        const pending: PendingDesktopApproval = {
            thread,
            interaction,
            projection: result.approvalRequest,
        };
        this.#pendingDesktopApprovals.set(requestId, pending);
        try {
            await this.#writer.json({ id: requestId, ...result.approvalRequest.request });
        }
        catch (error) {
            this.#pendingDesktopApprovals.delete(requestId);
            await this.#denyApproval(thread, interaction);
            throw error;
        }
    }
    async #handleDesktopApprovalResponse(value: JsonValue): Promise<boolean> {
        if (!isRecord(value) || !isHostApprovalRequestId(value.id))
            return false;
        const pending = this.#pendingDesktopApprovals.get(value.id);
        if (!pending)
            return true;
        this.#pendingDesktopApprovals.delete(value.id);
        let response: HostApprovalResponse;
        try {
            response =
                "error" in value
                    ? pending.projection.denyResponse
                    : pending.projection.parseResponse(value.result);
        }
        catch (error) {
            this.#diagnose(error);
            response = pending.projection.denyResponse;
        }
        const result = await pending.thread.session.execute({
            type: "interaction.respond",
            interactionId: pending.interaction.interactionId,
            response,
        });
        if (!result.ok && result.error.code !== "invalidState") {
            this.#diagnose(`Approval response failed: ${result.error.message}`);
            const cancelled = await pending.thread.session.execute({
                type: "turn.cancel",
                turnId: pending.interaction.turnId,
            });
            if (!cancelled.ok && cancelled.error.code !== "invalidState") {
                this.#diagnose(`Approval fail-closed cancellation failed: ${cancelled.error.message}`);
            }
        }
        return true;
    }
    async #denyApproval(thread: ExternalThread, interaction: HostApprovalInteraction): Promise<boolean> {
        const denyActions = interaction.actions.filter((action) => action.effect === "deny");
        if (denyActions.length !== 1) {
            const cancelled = await thread.session.execute({
                type: "turn.cancel",
                turnId: interaction.turnId,
            });
            if (!cancelled.ok) {
                this.#diagnose(`Unsupported Approval cancellation failed: ${cancelled.error.message}`);
            }
            return cancelled.ok;
        }
        const action = denyActions[0];
        if (!action)
            return false;
        const denied = await thread.session.execute({
            type: "interaction.respond",
            interactionId: interaction.interactionId,
            response: { type: "approval", actionId: action.id },
        });
        if (!denied.ok) {
            this.#diagnose(`Unsupported Approval denial failed: ${denied.error.message}`);
        }
        return denied.ok;
    }
    async #resolveDesktopApproval(interactionId: HostInteractionId): Promise<void> {
        for (const [requestId, pending] of this.#pendingDesktopApprovals) {
            if (pending.interaction.interactionId !== interactionId)
                continue;
            this.#pendingDesktopApprovals.delete(requestId);
            await this.#writer.json({
                method: "serverRequest/resolved",
                params: { threadId: pending.thread.id, requestId },
            });
        }
    }
    #allocateApprovalRequestId(): HostApprovalRequestId {
        if (this.#nextApprovalRequestId < HOST_APPROVAL_REQUEST_ID_MIN) {
            throw new Error("Host Approval Request ID namespace is exhausted");
        }
        const requestId = this.#nextApprovalRequestId;
        this.#nextApprovalRequestId -= 1;
        return requestId;
    }
    async #projectQuestion(thread: ExternalThread, interaction: HostQuestionInteraction): Promise<void> {
        const projection = this.#projectedTurn(thread, interaction.turnId);
        await this.#waitForTurnResponse(thread, interaction.turnId);
        let result: CodexQuestionProjection;
        try {
            result = projection.projector.projectQuestion(interaction, hostItemIdSchema.parse(randomUUID()));
        }
        catch (error) {
            this.#diagnose(error);
            thread.ignoredInteractionIds.add(interaction.interactionId);
            const cancelled = await thread.session.execute({
                type: "interaction.respond",
                interactionId: interaction.interactionId,
                response: { type: "question", answers: {}, cancelled: true },
            });
            if (!cancelled.ok) {
                thread.ignoredInteractionIds.delete(interaction.interactionId);
                this.#diagnose(`Unsupported Question cancellation failed: ${cancelled.error.message}`);
            }
            return;
        }
        for (const message of result.messages)
            await this.#writer.json(message);
        const requestId = this.#allocateQuestionRequestId();
        const expiresAtMs = interaction.expiresAt ? Date.parse(interaction.expiresAt) : Number.NaN;
        const timeoutMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - Date.now()) : null;
        const pending: PendingDesktopQuestion = {
            thread,
            interaction,
            projection: result.questionRequest,
            timeout: null,
        };
        if (timeoutMs !== null) {
            pending.timeout = setTimeout(() => {
                void this.#cancelExpiredQuestion(requestId);
            }, timeoutMs);
        }
        this.#pendingDesktopQuestions.set(requestId, pending);
        try {
            await this.#writer.json({ id: requestId, ...result.questionRequest.request });
        }
        catch (error) {
            this.#retireDesktopQuestion(interaction.interactionId);
            await thread.session
                .execute({
                type: "interaction.respond",
                interactionId: interaction.interactionId,
                response: { type: "question", answers: {}, cancelled: true },
            })
                .catch(() => undefined);
            throw error;
        }
    }
    async #handleDesktopQuestionResponse(value: JsonValue): Promise<boolean> {
        if (!isRecord(value) || !isHostQuestionRequestId(value.id))
            return false;
        const pending = this.#pendingDesktopQuestions.get(value.id);
        if (!pending)
            return true;
        this.#pendingDesktopQuestions.delete(value.id);
        if (pending.timeout)
            clearTimeout(pending.timeout);
        let response;
        try {
            response =
                "error" in value
                    ? { type: "question" as const, answers: {}, cancelled: true as const }
                    : pending.projection.parseResponse(value.result);
        }
        catch (error) {
            this.#diagnose(error);
            response = { type: "question" as const, answers: {}, cancelled: true as const };
        }
        const result = await pending.thread.session.execute({
            type: "interaction.respond",
            interactionId: pending.interaction.interactionId,
            response,
        });
        if (!result.ok && result.error.code !== "invalidState") {
            this.#diagnose(`Question response failed: ${result.error.message}`);
        }
        return true;
    }
    async #cancelExpiredQuestion(requestId: HostQuestionRequestId): Promise<void> {
        const pending = this.#pendingDesktopQuestions.get(requestId);
        if (!pending)
            return;
        await this.#resolveDesktopQuestion(pending.interaction.interactionId);
        const result = await pending.thread.session.execute({
            type: "interaction.respond",
            interactionId: pending.interaction.interactionId,
            response: { type: "question", answers: {}, cancelled: true },
        });
        if (!result.ok && result.error.code !== "invalidState") {
            this.#diagnose(`Question expiry failed: ${result.error.message}`);
        }
    }
    #retireDesktopQuestion(interactionId: HostInteractionId): void {
        for (const [requestId, pending] of this.#pendingDesktopQuestions) {
            if (pending.interaction.interactionId !== interactionId)
                continue;
            if (pending.timeout)
                clearTimeout(pending.timeout);
            this.#pendingDesktopQuestions.delete(requestId);
        }
    }
    async #resolveDesktopQuestion(interactionId: HostInteractionId): Promise<void> {
        for (const [requestId, pending] of this.#pendingDesktopQuestions) {
            if (pending.interaction.interactionId !== interactionId)
                continue;
            if (pending.timeout)
                clearTimeout(pending.timeout);
            this.#pendingDesktopQuestions.delete(requestId);
            await this.#writer.json({
                method: "serverRequest/resolved",
                params: { threadId: pending.thread.id, requestId },
            });
        }
    }
    #allocateQuestionRequestId(): HostQuestionRequestId {
        if (this.#nextQuestionRequestId < HOST_QUESTION_REQUEST_ID_MIN) {
            throw new Error("Host Question Request ID namespace is exhausted");
        }
        const requestId = this.#nextQuestionRequestId;
        this.#nextQuestionRequestId -= 1;
        return requestId;
    }
    async #setThreadStatus(thread: ExternalThread, status: ExternalThreadStatus): Promise<void> {
        thread.thread.status = status;
        await this.#writer.json({
            method: "thread/status/changed",
            emittedAtMs: Date.now(),
            params: { threadId: thread.id, status },
        });
    }
    #projectedTurn(thread: ExternalThread, turnId: HostTurnId): ProjectedTurn {
        const projection = thread.projectedTurns.get(turnId);
        if (!projection)
            throw new Error("Harness output references an unknown Host Turn");
        return projection;
    }
    async #waitForTurnResponse(thread: ExternalThread, turnId: HostTurnId): Promise<void> {
        await thread.responseGates.get(turnId)?.promise;
    }
    #latestCompletedTurnId(thread: ExternalThread): HostTurnId | null {
        const parsed = hostTurnIdSchema.safeParse(thread.turns.at(-1)?.id);
        return parsed.success ? parsed.data : null;
    }
    #isKnownExternalTurn(thread: ExternalThread, turnId: HostTurnId): boolean {
        return thread.projectedTurns.has(turnId) || thread.turns.some((turn) => turn.id === turnId);
    }
    async #replayExternalUsage(thread: ExternalThread): Promise<void> {
        const latestTurnId = this.#latestCompletedTurnId(thread);
        if (!latestTurnId || !thread.latestUsage)
            return;
        thread.usageTurnId = latestTurnId;
        await this.#writeExternalUsage(thread, latestTurnId);
    }
    async #writeExternalUsage(thread: ExternalThread, turnId: HostTurnId): Promise<void> {
        const usage = thread.latestUsage;
        if (!usage || this.#externalRuntime.get(thread.id) !== thread)
            return;
        const projection = projectCodexThreadUsage({ threadId: thread.id, turnId, usage });
        if (!projection)
            return;
        await this.#waitForTurnResponse(thread, turnId);
        if (this.#externalRuntime.get(thread.id) !== thread ||
            thread.latestUsage !== usage ||
            thread.usageTurnId !== turnId) {
            return;
        }
        await this.#writer.json(projection);
    }
    #dispatchDesktopRequest(run: () => Promise<void>): void {
        void run().catch((error) => this.#diagnose(error));
    }
    #diagnose(error: unknown): void {
        this.#options.diagnosticOutput.write(`codexhost Host Runtime: ${errorMessage(error)}\n`);
    }
}