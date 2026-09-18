export interface RendererDebugger {
  isAttached(): boolean;
  attach(version: string): void;
  detach(): void;
  sendCommand(method: string, parameters?: Record<string, unknown>): Promise<unknown>;
}

export interface RendererWebContents {
  isDestroyed(): boolean;
  getType(): string;
  debugger: RendererDebugger;
}

export interface DraftPrewarmPolicyTarget {
  [key: string]: unknown;
  addEventListener?: (type: string, listener: (event: Event) => void) => void;
  dispatchEvent?: (event: Event) => boolean;
  removeEventListener?: (type: string, listener: (event: Event) => void) => void;
}

export interface RendererHostRequestBridge {
  sendRequest(method: string, parameters: unknown, options?: unknown): unknown;
  prewarmThreadStart(parameters: unknown, options?: unknown): unknown;
  enqueueRequest(
    method: string,
    parameters: unknown,
    options?: unknown,
    dispatch?: (request: Record<string, unknown>) => void,
  ): unknown;
  onResult(id: unknown, result: unknown, metrics?: unknown): void;
  onError(id: unknown, error: unknown, metrics?: unknown): void;
}

export interface RendererHostRequestManager {
  onNotification(method: string, parameters: unknown): void;
  onRequest(request: Record<string, unknown>): void;
  dispatchAppServerResponse(method: string, response: Record<string, unknown>): unknown;
}

export interface RendererPrewarmedThreadManager {
  discardAllPrewarmedThreads(): void;
}

export function installDraftPrewarmPolicyBridge(
  manager: RendererHostRequestManager,
  bridge: RendererHostRequestBridge,
  hostId: string,
  target: DraftPrewarmPolicyTarget,
  prewarmedThreadManager: RendererPrewarmedThreadManager,
): { state: "ready"; reason: "owned-request-bridge" } {
  const existing = target.__codexhostDraftPrewarmPolicyV1 as
    | {
        owns?: (
          candidateManager: RendererHostRequestManager,
          candidate: RendererHostRequestBridge,
          candidateHostId: string,
          candidatePrewarmedThreadManager: RendererPrewarmedThreadManager,
        ) => boolean;
        dispose?: () => void;
      }
    | undefined;
  if (
    existing?.owns?.length === 4 &&
    existing.owns(manager, bridge, hostId, prewarmedThreadManager) === true
  ) {
    return { state: "ready", reason: "owned-request-bridge" };
  }
  existing?.dispose?.();

  const originalSend = bridge.sendRequest;
  const originalPrewarm = bridge.prewarmThreadStart;
  const originalOnNotification = manager.onNotification;
  const originalDispatchAppServerResponse = manager.dispatchAppServerResponse;
  let selectedModel: string | null = null;
  // A Thread keeps the Model carrier chosen for it, so a mid-conversation
  // Agent switch can be injected into that Thread's next Turn instead of
  // leaking into another Thread's draft.
  let pendingDraftThreadModel: string | null = null;
  const threadSelectedModels = new Map<string, string | null>();
  let selectedCodexAccountId: string | null = null;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  let lastKnownCwd: string | null = null;
  const observeParameters = (parameters: unknown): void => {
    if (
      isRecord(parameters) &&
      typeof parameters.cwd === "string" &&
      parameters.cwd.trim().length > 0
    ) {
      lastKnownCwd = parameters.cwd;
    }
  };
  const isDraftPrewarmCarrier = (model: string | null): model is string =>
    typeof model === "string" && model.startsWith("codexhost/");
  const isRemoteControlHost = hostId.startsWith("remote-control:");
  const knownExternalThreadIds = new Set<string>();
  const knownOfficialThreadIds = new Set<string>();
  const threadOwnershipResolutions = new Map<string, Promise<"external" | "codex">>();
  const createBridgeProcessHandle = (): string =>
    `codexhost-${
      typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    }`;
  let bridgeProcessHandle = createBridgeProcessHandle();
  const bridgeReadyMethod = "codexhost/remote-control-bridge/ready";
  const bridgeRequests = new Map<unknown, { method: string; parameters: unknown }>();
  const bridgeServerRequestIdPrefix = "codexhost/remote-control-bridge/server-request/";
  const bridgeServerRequests = new Map<string, unknown>();
  let nextBridgeServerRequestOrdinal = 1;
  let outputDecoders = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  };
  const outputBuffers = { stdout: "", stderr: "" };
  let bridgeState: "idle" | "starting" | "ready" | "failed" | "disposed" = "idle";
  let bridgeReadyPromise: Promise<void> | null = null;
  let bridgeReadyResolve: (() => void) | null = null;
  let bridgeReadyReject: ((error: Error) => void) | null = null;
  let bridgeReadyTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  let bridgeInitialization: Promise<void> | null = null;
  let writeTail = Promise.resolve();

  const transportError = (message: string, cause?: unknown): Error => {
    const error = new Error(`codexhost Remote Control bridge: ${message}`);
    if (cause !== undefined) Object.assign(error, { cause });
    return error;
  };
  const utf8Base64 = (value: string): string => {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  };
  const utf16LeBase64 = (value: string): string => {
    let binary = "";
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      binary += String.fromCharCode(codeUnit & 0xff, codeUnit >>> 8);
    }
    return btoa(binary);
  };
  const failBridge = (cause: unknown, terminateProcess = true): void => {
    if (bridgeState === "failed" || bridgeState === "disposed") return;
    const failedProcessHandle = bridgeProcessHandle;
    const terminate = terminateProcess && (bridgeState === "starting" || bridgeState === "ready");
    bridgeState = "failed";
    if (bridgeReadyTimeout !== null) globalThis.clearTimeout(bridgeReadyTimeout);
    bridgeReadyTimeout = null;
    const stderr = outputBuffers.stderr.trim().slice(-1_000);
    const error = transportError(
      `${cause instanceof Error ? cause.message : String(cause)}${stderr ? `; ${stderr}` : ""}`,
      cause,
    );
    bridgeReadyReject?.(error);
    bridgeReadyReject = null;
    bridgeReadyResolve = null;
    for (const requestId of bridgeRequests.keys()) bridge.onError(requestId, error);
    bridgeRequests.clear();
    if (isRemoteControlHost && terminate) {
      void Promise.resolve(
        originalSend.call(bridge, "process/kill", { processHandle: failedProcessHandle }),
      ).catch(() => undefined);
    }
  };
  const resetFailedBridge = (): void => {
    if (bridgeState !== "failed") return;
    bridgeProcessHandle = createBridgeProcessHandle();
    outputDecoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    outputBuffers.stdout = "";
    outputBuffers.stderr = "";
    bridgeReadyPromise = null;
    bridgeReadyResolve = null;
    bridgeReadyReject = null;
    bridgeInitialization = null;
    writeTail = Promise.resolve();
    bridgeServerRequests.clear();
    nextBridgeServerRequestOrdinal = 1;
    bridgeState = "idle";
  };
  const rememberExternalThread = (value: unknown): void => {
    if (!isRecord(value) || typeof value.id !== "string") return;
    if (value.modelProvider === "codexhost" || value.cliVersion === "codexhost") {
      knownExternalThreadIds.add(value.id);
      knownOfficialThreadIds.delete(value.id);
      if (typeof value.model === "string" && value.model.startsWith("codexhost/")) {
        threadSelectedModels.set(value.id, value.model);
      }
    }
  };
  const observeBridgeResult = (
    request: { method: string; parameters: unknown } | undefined,
    result: unknown,
  ): void => {
    if (!request || !isRecord(result)) return;
    if (request.method === "thread/list" && Array.isArray(result.data)) {
      for (const thread of result.data) rememberExternalThread(thread);
      return;
    }
    if (
      request.method === "thread/start" ||
      request.method === "thread/read" ||
      request.method === "thread/resume"
    ) {
      rememberExternalThread(result.thread);
      return;
    }
    if (
      request.method === "codexhost/thread/inspect" &&
      isRecord(request.parameters) &&
      typeof request.parameters.threadId === "string"
    ) {
      if (result.owner === "external") {
        knownExternalThreadIds.add(request.parameters.threadId);
        knownOfficialThreadIds.delete(request.parameters.threadId);
        if (typeof result.transportModelId === "string") {
          threadSelectedModels.set(request.parameters.threadId, result.transportModelId);
        }
      } else if (result.owner === "codex") {
        knownOfficialThreadIds.add(request.parameters.threadId);
        knownExternalThreadIds.delete(request.parameters.threadId);
        threadSelectedModels.delete(request.parameters.threadId);
      }
      pendingDraftThreadModel = null;
      return;
    }
    if (
      request.method === "thread/delete" &&
      isRecord(request.parameters) &&
      typeof request.parameters.threadId === "string"
    ) {
      knownExternalThreadIds.delete(request.parameters.threadId);
      knownOfficialThreadIds.delete(request.parameters.threadId);
    }
  };
  const handleBridgeFrame = (value: unknown): void => {
    if (!isRecord(value)) {
      failBridge("received a non-object app-server frame");
      return;
    }
    if (value.method === bridgeReadyMethod && value.id === undefined) {
      if (isRecord(value.params) && value.params.protocolVersion === 1) {
        bridgeState = "ready";
        if (bridgeReadyTimeout !== null) globalThis.clearTimeout(bridgeReadyTimeout);
        bridgeReadyTimeout = null;
        bridgeReadyResolve?.();
        bridgeReadyResolve = null;
        bridgeReadyReject = null;
      } else {
        failBridge("reported an unsupported protocol version");
      }
      return;
    }
    if (typeof value.method === "string" && value.id === undefined) {
      if (value.method === "thread/started" && isRecord(value.params)) {
        rememberExternalThread(value.params.thread);
      }
      originalOnNotification.call(manager, value.method, value.params);
      return;
    }
    if (typeof value.method === "string" && value.id !== undefined) {
      const outerRequestId = `${bridgeServerRequestIdPrefix}${bridgeProcessHandle}/${nextBridgeServerRequestOrdinal}`;
      nextBridgeServerRequestOrdinal += 1;
      bridgeServerRequests.set(outerRequestId, value.id);
      manager.onRequest({ ...value, id: outerRequestId });
      return;
    }
    if (value.id === undefined) {
      failBridge("received an app-server response without an id");
      return;
    }
    const request = bridgeRequests.get(value.id);
    bridgeRequests.delete(value.id);
    if ("error" in value) {
      bridge.onError(value.id, value.error, value.metrics);
      return;
    }
    observeBridgeResult(request, value.result);
    bridge.onResult(value.id, value.result, value.metrics);
  };
  const consumeBridgeOutput = (stream: "stdout" | "stderr", base64: string): void => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    outputBuffers[stream] += outputDecoders[stream].decode(bytes, { stream: true });
    if (stream === "stderr") {
      outputBuffers.stderr = outputBuffers.stderr.slice(-4_000);
      return;
    }
    while (true) {
      const newline = outputBuffers.stdout.indexOf("\n");
      if (newline < 0) break;
      const line = outputBuffers.stdout.slice(0, newline).trim();
      outputBuffers.stdout = outputBuffers.stdout.slice(newline + 1);
      if (!line) continue;
      try {
        handleBridgeFrame(JSON.parse(line));
      } catch (error) {
        failBridge(
          `emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
  };
  const handleOuterNotification = (method: string, parameters: unknown): boolean => {
    if (
      method === "process/exited" &&
      isRecord(parameters) &&
      parameters.processHandle === bridgeProcessHandle
    ) {
      const exitCode = typeof parameters.exitCode === "number" ? parameters.exitCode : "unknown";
      const stderr = typeof parameters.stderr === "string" ? parameters.stderr.trim() : "";
      failBridge(
        `process exited unexpectedly with code ${exitCode}${stderr ? `: ${stderr}` : ""}`,
        false,
      );
      return true;
    }
    if (
      method !== "process/outputDelta" ||
      !isRecord(parameters) ||
      parameters.processHandle !== bridgeProcessHandle ||
      (parameters.stream !== "stdout" && parameters.stream !== "stderr") ||
      typeof parameters.deltaBase64 !== "string"
    ) {
      return false;
    }
    if (parameters.capReached === true) {
      failBridge(`${parameters.stream} was truncated`);
      return true;
    }
    consumeBridgeOutput(parameters.stream, parameters.deltaBase64);
    return true;
  };
  const startBridge = (): Promise<void> => {
    if (!isRemoteControlHost) return Promise.resolve();
    if (bridgeReadyPromise) return bridgeReadyPromise;
    bridgeState = "starting";
    bridgeReadyPromise = new Promise<void>((resolve, reject) => {
      bridgeReadyResolve = resolve;
      bridgeReadyReject = reject;
    });
    bridgeReadyTimeout = globalThis.setTimeout(
      () => failBridge("startup timed out after 15000ms"),
      15_000,
    );
    // Windows PowerShell's native `-Command` argument is reparsed from the
    // CreateProcess command line. Passing the script as plain argv can split
    // drive-qualified values (for example, `C:\`) even though process/spawn
    // preserves its command vector. EncodedCommand keeps the script as one
    // opaque UTF-16LE argument across the Remote Control process boundary.
    const powershellScript =
      "$ErrorActionPreference = 'Stop'; " +
      "$descriptorPath = Join-Path $env:LOCALAPPDATA 'codexhost\\remote-control-bridge-v1.json'; " +
      "$descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json; " +
      "if ($descriptor.schemaVersion -ne 1) { throw 'Unsupported codexhost Remote Control descriptor' }; " +
      "$nodePath = [string]$descriptor.nodePath; " +
      "$runtimePath = [string]$descriptor.runtimePath; " +
      "if (-not [System.IO.Path]::IsPathRooted($nodePath) -or -not [System.IO.Path]::IsPathRooted($runtimePath)) { throw 'Invalid codexhost Remote Control runtime path' }; " +
      "$owner = Get-Process -Id ([int]$descriptor.ownerPid) -ErrorAction SilentlyContinue; " +
      "if ($null -eq $owner) { throw 'CodexHost Remote Control runtime is not running' }; " +
      "$env:CODEXHOST_REMOTE_CONTROL_BRIDGE_PIPE = [string]$descriptor.pipePath; " +
      "& $nodePath $runtimePath '--codexhost-remote-control-bridge'; " +
      "exit $LASTEXITCODE";
    const command = [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      utf16LeBase64(powershellScript),
    ];
    const startedProcessHandle = bridgeProcessHandle;
    try {
      const started = originalSend.call(bridge, "process/spawn", {
        command,
        processHandle: startedProcessHandle,
        cwd: "C:\\",
        streamStdin: true,
        streamStdoutStderr: true,
        outputBytesCap: null,
        timeoutMs: null,
      });
      void Promise.resolve(started).catch((error) => {
        if (bridgeProcessHandle === startedProcessHandle) failBridge(error, false);
      });
    } catch (error) {
      failBridge(error);
    }
    return bridgeReadyPromise;
  };
  const writeBridgeFrame = (value: Record<string, unknown>): Promise<void> => {
    const operation = async (): Promise<void> => {
      await startBridge();
      if (bridgeState !== "ready") throw transportError("is not ready");
      await originalSend.call(bridge, "process/writeStdin", {
        processHandle: bridgeProcessHandle,
        deltaBase64: utf8Base64(`${JSON.stringify(value)}\n`),
      });
    };
    const next = writeTail.then(operation, operation);
    writeTail = next.catch(() => undefined);
    return next;
  };
  const enqueueBridgeRequest = (method: string, parameters: unknown, options?: unknown): unknown =>
    bridge.enqueueRequest(method, parameters, options, (request) => {
      bridgeRequests.set(request.id, { method, parameters });
      void writeBridgeFrame(request).catch((error) => failBridge(error));
    });
  const initializeBridgeProtocol = (): Promise<unknown> => {
    const initialization = enqueueBridgeRequest("initialize", {
      clientInfo: {
        name: "codexhost_remote_control_bridge",
        title: "codexhost Remote Control bridge",
        version: "1",
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
      },
    }) as Promise<unknown>;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        const message = "initialization timed out after 15000ms";
        failBridge(message);
        reject(transportError(message));
      }, 15_000);
      void Promise.resolve(initialization).then(
        (value) => {
          globalThis.clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          globalThis.clearTimeout(timeout);
          reject(error);
        },
      );
    });
  };
  const initializeBridge = (): Promise<void> => {
    resetFailedBridge();
    if (bridgeInitialization) return bridgeInitialization;
    bridgeInitialization = startBridge()
      .then(() => initializeBridgeProtocol())
      .then(() => writeBridgeFrame({ method: "initialized", params: {} }));
    return bridgeInitialization;
  };
  const threadIdFromParameters = (parameters: unknown): string | null => {
    if (!isRecord(parameters)) return null;
    const value = parameters.threadId ?? parameters.conversationId;
    return typeof value === "string" ? value : null;
  };
  const isThreadScopedMethod = (method: string): boolean =>
    method.startsWith("thread/") || method.startsWith("turn/") || method.startsWith("review/");
  const resolveThreadOwnership = (threadId: string): Promise<"external" | "codex"> => {
    if (knownExternalThreadIds.has(threadId)) return Promise.resolve("external");
    if (knownOfficialThreadIds.has(threadId)) return Promise.resolve("codex");
    const pending = threadOwnershipResolutions.get(threadId);
    if (pending) return pending;
    const resolution = initializeBridge()
      .then(
        () =>
          enqueueBridgeRequest("codexhost/thread/ownership/list", {
            threadIds: [threadId],
          }) as Promise<unknown>,
      )
      .then((value) => {
        const ownerships = isRecord(value) && Array.isArray(value.threads) ? value.threads : null;
        const ownership = ownerships?.[0];
        if (
          !ownerships ||
          !isRecord(ownership) ||
          ownerships.length !== 1 ||
          ownership.threadId !== threadId ||
          (ownership.owner !== "external" && ownership.owner !== "codex")
        ) {
          throw transportError("Thread ownership lookup returned an invalid result");
        }
        if (ownership.owner === "external") {
          knownExternalThreadIds.add(threadId);
          knownOfficialThreadIds.delete(threadId);
          return "external" as const;
        }
        knownOfficialThreadIds.add(threadId);
        knownExternalThreadIds.delete(threadId);
        return "codex" as const;
      });
    threadOwnershipResolutions.set(threadId, resolution);
    const clearResolution = (): void => {
      if (threadOwnershipResolutions.get(threadId) === resolution) {
        threadOwnershipResolutions.delete(threadId);
      }
    };
    void resolution.then(clearResolution, clearResolution);
    return resolution;
  };
  const shouldResolveThreadOwnership = (method: string, parameters: unknown): string | null => {
    if (!isRemoteControlHost || method.startsWith("codexhost/") || !isThreadScopedMethod(method)) {
      return null;
    }
    const threadId = threadIdFromParameters(parameters);
    if (!threadId || knownExternalThreadIds.has(threadId) || knownOfficialThreadIds.has(threadId)) {
      return null;
    }
    return threadId;
  };
  const shouldUseBridge = (method: string, parameters: unknown): boolean => {
    if (!isRemoteControlHost) return false;
    if (method.startsWith("codexhost/")) return true;
    if (method === "thread/list") return true;
    if (method === "thread/start") {
      return (
        isRecord(parameters) &&
        ((typeof parameters.model === "string" && parameters.model.startsWith("codexhost/")) ||
          typeof parameters.__codexhostAccountId === "string")
      );
    }
    const threadId = threadIdFromParameters(parameters);
    if (threadId && threadSelectedModels.has(threadId)) {
      const configured = threadSelectedModels.get(threadId);
      return configured !== null && configured !== undefined;
    }
    if (threadId && knownExternalThreadIds.has(threadId)) return true;
    if (threadId && knownOfficialThreadIds.has(threadId)) return false;
    return (
      selectedModel !== null &&
      (method.startsWith("thread/") || method.startsWith("turn/") || method.startsWith("review/"))
    );
  };
  const routeThreadStart = (parameters: unknown): unknown => {
    if (!isRecord(parameters) || parameters.ephemeral === true) {
      return parameters;
    }
    pendingDraftThreadModel = selectedModel;
    const routed = {
      ...parameters,
      ...(selectedModel === null ? {} : { model: selectedModel }),
      ...(selectedCodexAccountId === null ? {} : { __codexhostAccountId: selectedCodexAccountId }),
    };
    selectedCodexAccountId = null;
    return routed;
  };
  const routeTurnStart = (parameters: unknown): unknown => {
    if (!isRecord(parameters)) return parameters;
    const threadId = threadIdFromParameters(parameters);
    if (threadId && threadSelectedModels.has(threadId)) {
      const configured = threadSelectedModels.get(threadId);
      return configured !== null && configured !== undefined
        ? { ...parameters, model: configured }
        : parameters;
    }
    if (
      threadId &&
      (knownExternalThreadIds.has(threadId) || knownOfficialThreadIds.has(threadId))
    ) {
      return parameters;
    }
    if (pendingDraftThreadModel !== null) {
      const model = pendingDraftThreadModel;
      if (threadId) {
        threadSelectedModels.set(threadId, model);
        knownExternalThreadIds.add(threadId);
        knownOfficialThreadIds.delete(threadId);
      }
      pendingDraftThreadModel = null;
      return { ...parameters, model };
    }
    return parameters;
  };
  // ChatGPT 26.908 ships an external-agent import surface that can poll
  // externalAgentConfig/import/readHistories hundreds of times per second,
  // flooding the request channel and stalling the renderer's task queue
  // (measured: setTimeout(100ms) took ~700ms while it ran). The data is a
  // slowly-changing import history, so serve repeat polls from a short-lived
  // cache instead of an IPC round trip.
  const POLL_CACHE_TTL_MS = new Map<string, number>([
    ["externalAgentConfig/import/readHistories", 2_000],
  ]);
  const pollCache = new Map<string, { at: number; value: unknown }>();
  const dispatchSend = (method: string, parameters: unknown, options?: unknown): unknown => {
    observeParameters(parameters);
    const routedParameters =
      method === "thread/start"
        ? routeThreadStart(parameters)
        : method === "turn/start"
          ? routeTurnStart(parameters)
          : parameters;
    const sendBridged = (): Promise<unknown> =>
      initializeBridge().then(
        () => enqueueBridgeRequest(method, routedParameters, options) as Promise<unknown>,
      );
    const observeDirectResult = (result: unknown): unknown => {
      if (isRecord(result)) {
        if (method === "thread/start" || method === "thread/read" || method === "thread/resume") {
          rememberExternalThread(result.thread);
          if (
            method === "thread/start" &&
            pendingDraftThreadModel !== null &&
            isRecord(result.thread) &&
            typeof result.thread.id === "string"
          ) {
            threadSelectedModels.set(result.thread.id, pendingDraftThreadModel);
            knownExternalThreadIds.add(result.thread.id);
            knownOfficialThreadIds.delete(result.thread.id);
            pendingDraftThreadModel = null;
          } else if (method !== "thread/start") {
            pendingDraftThreadModel = null;
          }
        }
      }
      return result;
    };
    const sendDirect = (): unknown => {
      const response =
        options === undefined
          ? originalSend.call(bridge, method, routedParameters)
          : originalSend.call(bridge, method, routedParameters, options);
      if (response && typeof (response as Promise<unknown>).then === "function") {
        return (response as Promise<unknown>).then(observeDirectResult);
      }
      return observeDirectResult(response);
    };
    const unresolvedThreadId = shouldResolveThreadOwnership(method, routedParameters);
    if (unresolvedThreadId) {
      return resolveThreadOwnership(unresolvedThreadId).then((owner) =>
        owner === "external" ? sendBridged() : sendDirect(),
      );
    }
    return shouldUseBridge(method, routedParameters) ? sendBridged() : sendDirect();
  };
  const routedSend = (method: string, parameters: unknown, options?: unknown): unknown => {
    const cacheTtl = POLL_CACHE_TTL_MS.get(method);
    if (cacheTtl === undefined) return dispatchSend(method, parameters, options);
    const hit = pollCache.get(method);
    if (hit !== undefined && Date.now() - hit.at < cacheTtl) return Promise.resolve(hit.value);
    const result = dispatchSend(method, parameters, options);
    if (result !== null && typeof (result as Promise<unknown>)?.then === "function") {
      return (result as Promise<unknown>).then((value) => {
        pollCache.set(method, { at: Date.now(), value });
        return value;
      });
    }
    return result;
  };
  const routedPrewarm = (parameters: unknown, options?: unknown): unknown => {
    observeParameters(parameters);
    const routedParameters = routeThreadStart(parameters);
    if (
      isDraftPrewarmCarrier(selectedModel) &&
      lastKnownCwd &&
      (!isRecord(parameters) || parameters.ephemeral !== true)
    ) {
      void Promise.resolve(
        routedSend("codexhost/draft/prepare", {
          model: selectedModel,
          cwd: lastKnownCwd,
        }),
      ).catch(() => undefined);
    }
    if (shouldUseBridge("thread/start", routedParameters)) {
      return routedSend("thread/start", routedParameters, options);
    }
    return options === undefined
      ? originalPrewarm.call(bridge, routedParameters)
      : originalPrewarm.call(bridge, routedParameters, options);
  };
  bridge.sendRequest = routedSend;
  bridge.prewarmThreadStart = routedPrewarm;
  const routedWindowMessage = (event: Event): void => {
    const message = (event as Event & { data?: unknown }).data;
    if (
      !isRecord(message) ||
      message.type !== "mcp-notification" ||
      message.hostId !== hostId ||
      typeof message.method !== "string"
    ) {
      return;
    }
    handleOuterNotification(message.method, message.params);
  };
  const observesWindowNotifications =
    isRemoteControlHost &&
    typeof target.addEventListener === "function" &&
    typeof target.removeEventListener === "function";
  if (observesWindowNotifications) target.addEventListener?.("message", routedWindowMessage);
  const routedOnNotification = (method: string, parameters: unknown): void => {
    if (!handleOuterNotification(method, parameters)) {
      originalOnNotification.call(manager, method, parameters);
    }
  };
  const routedDispatchAppServerResponse = (
    method: string,
    response: Record<string, unknown>,
  ): unknown => {
    if (isRemoteControlHost && typeof response.id === "string") {
      const innerRequestId = bridgeServerRequests.get(response.id);
      if (innerRequestId !== undefined || bridgeServerRequests.has(response.id)) {
        bridgeServerRequests.delete(response.id);
        void writeBridgeFrame({ ...response, id: innerRequestId }).catch((error) =>
          failBridge(error),
        );
        return undefined;
      }
      if (response.id.startsWith(bridgeServerRequestIdPrefix)) return undefined;
    }
    return originalDispatchAppServerResponse.call(manager, method, response);
  };
  if (!observesWindowNotifications) manager.onNotification = routedOnNotification;
  manager.dispatchAppServerResponse = routedDispatchAppServerResponse;

  const policy = Object.freeze({
    state: "ready" as const,
    hostId,
    owns(
      candidateManager: RendererHostRequestManager,
      candidate: RendererHostRequestBridge,
      candidateHostId: string,
      candidatePrewarmedThreadManager: RendererPrewarmedThreadManager,
    ): boolean {
      return (
        candidateManager === manager &&
        candidate === bridge &&
        candidateHostId === hostId &&
        candidatePrewarmedThreadManager === prewarmedThreadManager
      );
    },
    requestTarget(): RendererHostRequestManager {
      return manager;
    },
    select(model: string | null, threadId?: string): boolean {
      if (model !== null && (typeof model !== "string" || !model.startsWith("codexhost/"))) {
        throw new Error("Draft route Model must be a codexhost transport carrier");
      }
      if (threadId) {
        const previous = threadSelectedModels.get(threadId);
        if (previous === model) return false;
        threadSelectedModels.set(threadId, model);
        if (model !== null) {
          knownExternalThreadIds.add(threadId);
          knownOfficialThreadIds.delete(threadId);
        } else {
          knownOfficialThreadIds.add(threadId);
          knownExternalThreadIds.delete(threadId);
        }
        return true;
      }
      if (selectedModel === model) return false;
      const previousModel = selectedModel;
      selectedModel = model;
      if (isDraftPrewarmCarrier(previousModel) && lastKnownCwd) {
        void Promise.resolve(
          routedSend("codexhost/draft/release", {
            model: previousModel,
            cwd: lastKnownCwd,
          }),
        ).catch(() => undefined);
      }
      if (isDraftPrewarmCarrier(model) && lastKnownCwd) {
        void Promise.resolve(
          routedSend("codexhost/draft/prepare", {
            model,
            cwd: lastKnownCwd,
          }),
        ).catch(() => undefined);
      }
      return true;
    },
    selectAccount(accountId: string | null): boolean {
      if (accountId !== null && !/^[A-Za-z0-9._~-]+$/u.test(accountId)) {
        throw new Error("Draft Codex Account ID must be filename-safe");
      }
      if (selectedCodexAccountId === accountId) return false;
      selectedCodexAccountId = accountId;
      return true;
    },
    clear(): Promise<void> {
      prewarmedThreadManager.discardAllPrewarmedThreads();
      if (isDraftPrewarmCarrier(selectedModel) && lastKnownCwd) {
        void Promise.resolve(
          routedSend("codexhost/draft/prepare", {
            model: selectedModel,
            cwd: lastKnownCwd,
          }),
        ).catch(() => undefined);
      }
      return Promise.resolve();
    },
    lastKnownCwd(): string | null {
      return lastKnownCwd;
    },
    dispose(): void {
      if (bridge.sendRequest === routedSend) bridge.sendRequest = originalSend;
      if (bridge.prewarmThreadStart === routedPrewarm) {
        bridge.prewarmThreadStart = originalPrewarm;
      }
      if (observesWindowNotifications) {
        target.removeEventListener?.("message", routedWindowMessage);
      } else if (manager.onNotification === routedOnNotification) {
        manager.onNotification = originalOnNotification;
      }
      if (manager.dispatchAppServerResponse === routedDispatchAppServerResponse) {
        manager.dispatchAppServerResponse = originalDispatchAppServerResponse;
      }
      if (bridgeReadyTimeout !== null) globalThis.clearTimeout(bridgeReadyTimeout);
      bridgeReadyTimeout = null;
      if (isRemoteControlHost && (bridgeState === "starting" || bridgeState === "ready")) {
        void Promise.resolve(
          originalSend.call(bridge, "process/kill", { processHandle: bridgeProcessHandle }),
        ).catch(() => undefined);
      }
      bridgeState = "disposed";
      const disposedError = transportError("was disposed");
      bridgeReadyReject?.(disposedError);
      for (const requestId of bridgeRequests.keys()) bridge.onError(requestId, disposedError);
      bridgeRequests.clear();
      bridgeServerRequests.clear();
      knownExternalThreadIds.clear();
      knownOfficialThreadIds.clear();
      threadOwnershipResolutions.clear();
      if (isDraftPrewarmCarrier(selectedModel) && lastKnownCwd) {
        void Promise.resolve(
          routedSend("codexhost/draft/release", {
            model: selectedModel,
            cwd: lastKnownCwd,
          }),
        ).catch(() => undefined);
      }
      selectedModel = null;
      selectedCodexAccountId = null;
    },
  });
  Object.defineProperty(target, "__codexhostDraftPrewarmPolicyV1", {
    configurable: true,
    value: policy,
  });
  if (typeof target.dispatchEvent === "function" && typeof CustomEvent === "function") {
    target.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
  }
  return { state: "ready", reason: "owned-request-bridge" };
}

export async function installDraftPrewarmPolicyInRenderer(
  contents: RendererWebContents | null,
  findRequestManagerExpression: string,
  installRendererPolicyFunction: string,
): Promise<unknown> {
  if (contents === null || contents.isDestroyed() || contents.getType() !== "window") {
    throw new Error("Owned Renderer is unavailable for draft prewarm policy");
  }

  let attachedHere = false;
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
      attachedHere = true;
    }
    await contents.debugger.sendCommand("Runtime.enable");
    const managerResult = (await contents.debugger.sendCommand("Runtime.evaluate", {
      expression: findRequestManagerExpression,
    })) as { result?: { objectId?: unknown } };
    const managerResultId = managerResult.result?.objectId;
    if (typeof managerResultId !== "string") {
      throw new Error("Renderer request manager inspection failed");
    }
    const managerProperties = (await contents.debugger.sendCommand("Runtime.getProperties", {
      objectId: managerResultId,
      ownProperties: true,
    })) as {
      result?: Array<{
        name?: unknown;
        value?: { objectId?: unknown; value?: unknown };
      }>;
    };
    const candidateCount = managerProperties.result?.find(
      (property) => property.name === "candidateCount",
    )?.value?.value;
    const hostId = managerProperties.result?.find((property) => property.name === "hostId")?.value
      ?.value;
    const manager = managerProperties.result?.find(
      (property) => property.name === "manager",
    )?.value;
    const requestClient = managerProperties.result?.find(
      (property) => property.name === "requestClient",
    )?.value;
    const prewarmedThreadManager = managerProperties.result?.find(
      (property) => property.name === "prewarmedThreadManager",
    )?.value;
    if (
      candidateCount !== 1 ||
      typeof hostId !== "string" ||
      hostId.length === 0 ||
      typeof manager?.objectId !== "string" ||
      typeof requestClient?.objectId !== "string"
    ) {
      throw new Error("Renderer request manager is ambiguous");
    }
    if (typeof prewarmedThreadManager?.objectId !== "string") {
      throw new Error("Renderer prewarmed Thread manager is unavailable");
    }

    const installed = (await contents.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId: manager.objectId,
      functionDeclaration: installRendererPolicyFunction,
      arguments: [
        { objectId: requestClient.objectId },
        { value: hostId },
        { objectId: prewarmedThreadManager.objectId },
      ],
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    return installed.result?.value;
  } finally {
    if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
  }
}
