import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { codexhostLogDirectory } from "./diagnostic-log.js";
import {
  createFunctionalHealthTracker,
  describeFunctionalHealth,
  functionalHealthPath,
  writeFunctionalHealthRecord,
} from "./functional-health.js";

import {
  startControllerAttachmentServer,
  type ControllerAttachmentServer,
  type StartControllerAttachmentServerOptions,
} from "./controller-attachment-server.js";
import {
  installRendererCdpControlSession,
  type RendererCdpControlSession,
} from "./renderer-cdp-control-session.js";

export interface DesktopControllerOptions {
  rendererCdpEndpoint: string;
  rendererPath: string;
  defaultAgent: "codex" | "pi";
  attachmentPort: number;
  attachmentNonce: string;
}

export interface DesktopControllerReadiness {
  schemaVersion: 2;
  state: "compatible";
  issues: [];
}

export interface DesktopControllerDependencies {
  readRenderer(filePath: string): Promise<string>;
  install(options: {
    rendererCdpEndpoint: string;
    rendererSource: string;
    enabledAgents: readonly string[];
    timeoutMs: number;
  }): Promise<RendererCdpControlSession>;
  startAttachmentServer(
    options: StartControllerAttachmentServerOptions,
  ): Promise<ControllerAttachmentServer>;
  ready(readiness: DesktopControllerReadiness): void;
  sleep(milliseconds: number): Promise<void>;
  now?(): number;
  monitorIntervalMs: number;
}

const PRODUCTION_INSTALL_TIMEOUT_MS = 90_000;
const RENDERER_CSP_BOOTSTRAP =
  "globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;";
const DESKTOP_CONTROLLER_READINESS_MAX_BYTES = 512;
const TRANSIENT_INSTALL_ATTEMPTS = 3;
import { timestampedLogLine } from "./diagnostic-log.js";

const TRANSIENT_INSTALL_RETRY_MS = 250;
/**
 * A failed recovery is retried quickly at first: after a wake the Renderer document is often still
 * loading, so the first attempts are expected to fail and a 30s first delay turned that into
 * minutes without codexhost integration. The doubling still reaches `RECOVERY_RETRY_MAX_MS` so a
 * genuinely wedged Desktop is not re-probed in a tight loop.
 */
const RECOVERY_RETRY_INITIAL_MS = 2_000;
const RECOVERY_RETRY_MAX_MS = 300_000;
/**
 * A monitor gap this large means the process was not scheduled — system sleep, in practice. It sits
 * well above the 5s backoff-reset threshold on purpose: a briefly loaded machine must not trigger a
 * full renderer reinstall.
 */
const SLEEP_GAP_THRESHOLD_MS = 30_000;
const startupTraceStartedAt = Date.now();

function startupTrace(stage: string, detail?: unknown): void {
  if (process.env.CODEXHOST_STARTUP_TRACE !== "1") return;
  const suffix =
    detail === undefined ? "" : `: ${detail instanceof Error ? detail.message : String(detail)}`;
  console.error(
    timestampedLogLine(
      `[codexhost startup +${Date.now() - startupTraceStartedAt}ms] controller: ${stage}${suffix}`,
    ),
  );
}

export function serializeDesktopControllerReadiness(readiness: DesktopControllerReadiness): string {
  if (
    readiness.schemaVersion !== 2 ||
    readiness.state !== "compatible" ||
    !Array.isArray(readiness.issues) ||
    readiness.issues.length !== 0 ||
    Object.keys(readiness).length !== 3
  ) {
    throw new Error("Desktop Controller readiness is invalid");
  }
  const line = JSON.stringify(readiness);
  if (Buffer.byteLength(line, "utf8") > DESKTOP_CONTROLLER_READINESS_MAX_BYTES) {
    throw new Error("Desktop Controller readiness exceeds its size limit");
  }
  return line;
}

const defaultDependencies: DesktopControllerDependencies = {
  readRenderer: (filePath) => readFile(filePath, "utf8"),
  install: installRendererCdpControlSession,
  startAttachmentServer: startControllerAttachmentServer,
  ready: (readiness) => {
    process.stdout.write(`${serializeDesktopControllerReadiness(readiness)}\n`);
  },
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  monitorIntervalMs: 500,
};

function rendererCdpEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("--renderer-cdp-endpoint must be a loopback HTTP origin with an explicit port");
  }
  return url.origin;
}

export function parseDesktopControllerArguments(
  arguments_: readonly string[],
): DesktopControllerOptions {
  let endpoint: string | undefined;
  let rendererPath: string | undefined;
  let defaultAgent: "codex" | "pi" | undefined;
  let attachmentPort: number | undefined;
  let attachmentNonce: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--renderer-cdp-endpoint") {
      if (endpoint !== undefined) {
        throw new Error("--renderer-cdp-endpoint may only be provided once");
      }
      if (!value) throw new Error("--renderer-cdp-endpoint requires a value");
      endpoint = rendererCdpEndpoint(value);
      index += 1;
      continue;
    }
    if (argument === "--renderer") {
      if (rendererPath !== undefined) throw new Error("--renderer may only be provided once");
      if (!value) throw new Error("--renderer requires a value");
      if (!path.isAbsolute(value)) throw new Error("--renderer must be an absolute path");
      rendererPath = path.normalize(value);
      index += 1;
      continue;
    }
    if (argument === "--default-agent") {
      if (defaultAgent !== undefined) throw new Error("--default-agent may only be provided once");
      if (value !== "codex" && value !== "pi") {
        throw new Error("--default-agent must be 'codex' or 'pi'");
      }
      defaultAgent = value;
      index += 1;
      continue;
    }
    if (argument === "--attachment-port") {
      if (attachmentPort !== undefined) {
        throw new Error("--attachment-port may only be provided once");
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--attachment-port must be a valid TCP port");
      }
      attachmentPort = port;
      index += 1;
      continue;
    }
    if (argument === "--attachment-nonce") {
      if (attachmentNonce !== undefined) {
        throw new Error("--attachment-nonce may only be provided once");
      }
      if (value === undefined || !/^[0-9a-f]{32}$/.test(value)) {
        throw new Error("--attachment-nonce must be 32 lowercase hexadecimal characters");
      }
      attachmentNonce = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown Desktop Controller option: ${argument}`);
  }
  if (endpoint === undefined) throw new Error("--renderer-cdp-endpoint is required");
  if (rendererPath === undefined) throw new Error("--renderer is required");
  if (defaultAgent === undefined) throw new Error("--default-agent is required");
  if (attachmentPort === undefined) throw new Error("--attachment-port is required");
  if (attachmentNonce === undefined) throw new Error("--attachment-nonce is required");
  return {
    rendererCdpEndpoint: endpoint,
    rendererPath,
    defaultAgent,
    attachmentPort,
    attachmentNonce,
  };
}

function isTransientRendererInstallError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes("Execution context was destroyed") ||
      message.includes("Promise was collected")
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
    if (current === undefined) break;
  }
  return false;
}

async function installProductionSession(
  options: Parameters<DesktopControllerDependencies["install"]>[0],
  dependencies: DesktopControllerDependencies,
): Promise<RendererCdpControlSession> {
  for (let attempt = 1; attempt <= TRANSIENT_INSTALL_ATTEMPTS; attempt += 1) {
    try {
      return await dependencies.install(options);
    } catch (error) {
      if (attempt === TRANSIENT_INSTALL_ATTEMPTS || !isTransientRendererInstallError(error)) {
        throw error;
      }
      await dependencies.sleep(TRANSIENT_INSTALL_RETRY_MS);
    }
  }
  throw new Error("Desktop Controller exhausted Renderer installation attempts");
}

export async function runDesktopController(
  options: DesktopControllerOptions,
  signal: AbortSignal,
  dependencies: DesktopControllerDependencies = defaultDependencies,
): Promise<void> {
  const configuration = `Object.defineProperty(window, "__codexhostProductionConfigV1", { configurable: true, value: { defaultAgent: ${JSON.stringify(options.defaultAgent)} } });`;
  const now = dependencies.now ?? Date.now;
  let session: RendererCdpControlSession | undefined;
  let nextRecoveryAt = 0;
  let recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
  // Functional health is published on a side channel: the cross-process readiness handshake can
  // only ever report "compatible", so "process alive but no longer working" needs its own signal
  // rather than being inferred from process liveness.
  const healthStartedAt = now();
  const healthTracker = createFunctionalHealthTracker({
    controllerPid: process.pid,
    controllerGeneration: `${process.pid}-${healthStartedAt}`,
    sessionId: options.attachmentNonce,
    startedAt: healthStartedAt,
    codexhostVersion: `contract-${WORKSPACE_CONTRACT_VERSION}`,
    now,
  });
  const healthFile = functionalHealthPath(codexhostLogDirectory());
  const publishHealth = (next: () => ReturnType<typeof healthTracker.current>): void => {
    try {
      const record = next();
      writeFunctionalHealthRecord(healthFile, record);
      // Only announce the transition that matters; a healthy probe would be pure noise.
      if (record.state === "degraded") console.error(describeFunctionalHealth(record));
    } catch (error) {
      // Health reporting must never take the Controller down.
      startupTrace("functional health could not be published", error);
    }
  };
  const recordRecoveryFailure = (): void => {
    nextRecoveryAt = now() + recoveryDelayMs;
    recoveryDelayMs = Math.min(recoveryDelayMs * 2, RECOVERY_RETRY_MAX_MS);
    publishHealth(() => healthTracker.recordFailure());
  };
  const recordRecoverySuccess = (): void => {
    nextRecoveryAt = 0;
    recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
    publishHealth(() => healthTracker.recordSuccess());
  };
  const createSession = async (): Promise<RendererCdpControlSession> => {
    startupTrace("reading Renderer bundle");
    const rendererSource = await dependencies.readRenderer(options.rendererPath);
    if (rendererSource.trim().length === 0) throw new Error("production Renderer Bundle is empty");
    startupTrace("installing Renderer Session");
    const installed = await installProductionSession(
      {
        rendererCdpEndpoint: options.rendererCdpEndpoint,
        rendererSource: `${RENDERER_CSP_BOOTSTRAP}\n${configuration}\n${rendererSource}`,
        enabledAgents: [
          "codex",
          "pi",
          "claude-code",
          "deepseek-harness",
          "opencode",
          "grok",
          "omp",
          "antigravity",
          "kiro-cli",
          "cursor-cli",
        ],
        timeoutMs: PRODUCTION_INSTALL_TIMEOUT_MS,
      },
      dependencies,
    );
    startupTrace("Renderer Session installed");
    return installed;
  };
  startupTrace("initialization started");
  try {
    session = await createSession();
    recordRecoverySuccess();
  } catch (error) {
    startupTrace("initial Renderer Session unavailable", error);
    session = undefined;
    recordRecoveryFailure();
  }

  let operation = Promise.resolve<unknown>(undefined);
  const useSession = <T>(callback: () => Promise<T>): Promise<T> => {
    const next = operation.then(callback, callback);
    operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const resetSession = (): void => {
    session?.close();
    session = undefined;
  };
  const ensureSession = async (): Promise<RendererCdpControlSession> => {
    if (!session) session = await createSession();
    else await session.ensureInstalled();
    return session;
  };
  const recoverSession = async (): Promise<RendererCdpControlSession> => {
    try {
      const current = await ensureSession();
      recordRecoverySuccess();
      return current;
    } catch (error) {
      resetSession();
      recordRecoveryFailure();
      throw error;
    }
  };

  let attachmentServer: ControllerAttachmentServer | undefined;
  try {
    startupTrace("starting attachment server");
    attachmentServer = await dependencies.startAttachmentServer({
      port: options.attachmentPort,
      nonce: options.attachmentNonce,
      attach: () =>
        useSession(async () => {
          nextRecoveryAt = 0;
          const current = await recoverSession();
          await current.activateDesktop();
        }),
    });
    startupTrace("attachment server ready");
    startupTrace("publishing readiness");
    dependencies.ready({
      schemaVersion: 2,
      state: "compatible",
      issues: [],
    });
    let lastTickAt = now();
    while (!signal.aborted) {
      await dependencies.sleep(dependencies.monitorIntervalMs);
      if (signal.aborted) continue;
      const currentTickAt = now();
      const tickGap = currentTickAt - lastTickAt;
      if (tickGap > Math.max(dependencies.monitorIntervalMs * 3, 5_000)) {
        nextRecoveryAt = 0;
        recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
      }
      // A much larger gap means this process was not scheduled for tens of seconds — in practice a
      // system sleep. The CDP connection and the renderer generation may both be stale, so drop
      // the session and force a full reinstall rather than trusting an incremental check. The
      // threshold is deliberately far above the backoff reset so ordinary scheduling jitter (a
      // loaded machine delaying a tick by a few seconds) never triggers a reinstall.
      if (tickGap > SLEEP_GAP_THRESHOLD_MS) {
        startupTrace("detected a long monitor gap; forcing renderer reinstall", tickGap);
        resetSession();
        nextRecoveryAt = 0;
        recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
      }
      lastTickAt = currentTickAt;
      await useSession(async () => {
        if (!session && now() < nextRecoveryAt) return;
        try {
          await recoverSession();
        } catch {
          // Renderer integration remains unavailable until a later bounded retry succeeds.
        }
      });
    }
  } finally {
    await attachmentServer?.close().catch(() => undefined);
    let operationTimeout: NodeJS.Timeout | undefined;
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        operationTimeout = setTimeout(resolve, 2_000);
        operationTimeout.unref?.();
      }),
    ]).catch(() => undefined);
    if (operationTimeout) clearTimeout(operationTimeout);
    resetSession();
  }
}
