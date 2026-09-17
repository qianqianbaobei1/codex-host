import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput, HarnessSession, TurnStartCommand } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import type { NativeSessionRef } from "@codexhost/shared-contracts";

import type {
  AntigravityCliTransportLike,
  AntigravityModelsResult,
} from "../src/antigravity-adapter.js";
import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import type {
  AntigravityInitEvent,
  AntigravityResultEvent,
  AntigravityStepUpdate,
} from "../src/transport.js";
import { encodeAntigravityModelRef } from "../src/model-catalog.js";
import { resolveAntigravityProxyEnvironment } from "../src/command.js";

const MODEL = "gemini-3.7-flash";
const MODEL_LABEL = "Gemini 3.7 Flash";

function fakeTransportFactory(
  conversationId: string,
  initialModel?: string,
): {
  create(): AntigravityCliTransportLike;
  lastModel(): string | undefined;
  lastEffort(): string | undefined;
  hibernateCalls(): number;
} {
  let currentModel: string | undefined = initialModel;
  let currentEffort: string | undefined;
  let hibernateCount = 0;
  return {
    create() {
      return {
        get conversationId() {
          return conversationId;
        },
        get effort() {
          return currentEffort;
        },
        get logPath() {
          return null;
        },
        async start(): Promise<AntigravityInitEvent> {
          return { conversationId, cwd: process.cwd(), model: currentModel ?? MODEL };
        },
        async setModel(model: string, effort?: string): Promise<AntigravityInitEvent> {
          currentModel = model;
          if (arguments.length > 1) {
            currentEffort = effort;
          }
          return { conversationId, cwd: process.cwd(), model };
        },
        async setEffort(effort: string | undefined): Promise<AntigravityInitEvent> {
          currentEffort = effort;
          return { conversationId, cwd: process.cwd(), model: currentModel ?? MODEL };
        },
        async setPermissionMode(): Promise<AntigravityInitEvent> {
          return { conversationId, cwd: process.cwd(), model: currentModel ?? MODEL };
        },
        async runTurn(
          _text: string,
          onStep: (step: AntigravityStepUpdate) => void,
        ): Promise<AntigravityResultEvent> {
          onStep({
            stepType: "agent_response",
            state: "DONE",
            textDelta: "hello from Gemini\n",
          });
          return {
            conversationId,
            status: "SUCCESS",
            response: "hello from Gemini\n",
            numTurns: 1,
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          };
        },
        async cancel(): Promise<void> {},
        async hibernate(): Promise<void> {
          hibernateCount += 1;
        },
        async close(): Promise<void> {},
      };
    },
    lastModel() {
      return currentModel;
    },
    lastEffort() {
      return currentEffort;
    },
    hibernateCalls() {
      return hibernateCount;
    },
  };
}

async function waitForTurnIterator(
  iterator: AsyncIterator<HarnessOutput>,
): Promise<HarnessOutput[]> {
  const values: HarnessOutput[] = [];
  while (true) {
    const result = await iterator.next();
    if (result.done) break;
    const value = result.value;
    values.push(value);
    if (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === "event" &&
      "event" in value &&
      typeof value.event === "object" &&
      value.event !== null &&
      "type" in value.event &&
      value.event.type === "turn.completed"
    ) {
      break;
    }
  }
  return values;
}

async function waitForTurn(session: HarnessSession): Promise<HarnessOutput[]> {
  return waitForTurnIterator(session.outputs[Symbol.asyncIterator]());
}

describe("AntigravityAdapter", () => {
  it("coalesces concurrent model inspections for the same working directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-inspect-test-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    let listCalls = 0;
    const listModels = async (): Promise<AntigravityModelsResult> => {
      listCalls += 1;
      await Promise.resolve();
      return { stdout: `${MODEL}\t${MODEL_LABEL}\n`, stderr: "" };
    };
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => fakeTransportFactory("inspect").create(), listModels },
    );
    try {
      const [first, second] = await Promise.all([
        adapter.inspect({ cwd: root }),
        adapter.inspect({ cwd: root }),
      ]);
      expect(first.status).toBe("ready");
      expect(second.status).toBe("ready");
      expect(listCalls).toBe(1);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the CLI model catalog, streams a Turn, and persists a resumable ledger", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-test-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const first = fakeTransportFactory("conversation-1");
    const listModels = async (): Promise<AntigravityModelsResult> => ({
      stdout: `${MODEL}\t${MODEL_LABEL}\n`,
      stderr: "",
    });
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      {
        createTransport: () => first.create(),
        listModels,
      },
    );
    try {
      const inspection = await adapter.inspect({ cwd: root });
      expect(inspection).toMatchObject({
        status: "ready",
        catalog: { defaultModel: encodeAntigravityModelRef(MODEL) },
      });
      if (inspection.status !== "ready") throw new Error("synthetic inspection failed");
      const opened = await adapter.open({ kind: "create", cwd: root, environment });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      expect(session.initialState.nativeRef).toMatchObject({
        locator: { skipPermissions: true },
      });
      const outputs = waitForTurn(session);
      const command: TurnStartCommand = {
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("host-turn-1"),
        input: [{ type: "text", text: "Say hello" }],
      };
      const accepted = await session.execute(command);
      expect(accepted).toEqual({ ok: true, value: { turnId: "host-turn-1" } });
      const events = await outputs;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "event",
            event: expect.objectContaining({ type: "session.usage.changed" }),
          }),
          expect.objectContaining({
            kind: "event",
            event: expect.objectContaining({
              type: "turn.completed",
              nativeTurnRef: expect.objectContaining({
                nativeSessionId: "conversation-1",
                nativeTurnKey: "conversation-1:turn:1",
              }),
            }),
          }),
        ]),
      );
      const nativeRef = session.initialState.nativeRef;
      if (!nativeRef) throw new Error("synthetic Session did not publish a Native Ref");
      await session.close();

      const second = fakeTransportFactory("conversation-1");
      const resumed = await new AntigravityAdapter(
        { command: path.join(os.homedir(), ".local/bin/agy"), environment },
        { createTransport: () => second.create(), listModels },
      ).open({
        kind: "resume",
        cwd: root,
        environment,
        nativeRef,
        knownTurnRefs: [
          {
            harnessId: harnessIdSchema.parse("antigravity"),
            nativeSessionId: "conversation-1",
            nativeTurnKey: "conversation-1:turn:1",
            formatVersion: 1,
          },
        ],
      });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(resumed.value.initialState.nativeRef).toMatchObject({
        locator: { skipPermissions: true },
      });
      const snapshot = await resumed.value.readSnapshot();
      expect(snapshot).toMatchObject({
        ok: true,
        value: {
          turns: [
            {
              input: [{ type: "text", text: "Say hello" }],
              items: [{ item: { type: "agentMessage", text: "hello from Gemini\n" } }],
            },
          ],
        },
      });
      await resumed.value.close();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams reasoning items when thinkingDelta arrives", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-reasoning-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const transport: AntigravityCliTransportLike = {
      conversationId: "conv-reasoning-1",
      logPath: null,
      async start() {
        return { conversationId: "conv-reasoning-1", cwd: root, model: MODEL };
      },
      async setModel(model: string) {
        return { conversationId: "conv-reasoning-1", cwd: root, model };
      },
      async setEffort() {
        return { conversationId: "conv-reasoning-1", cwd: root, model: MODEL };
      },
      async setPermissionMode() {
        return { conversationId: "conv-reasoning-1", cwd: root, model: MODEL };
      },
      async runTurn(_text, onStep) {
        onStep({ stepType: "thinking", thinkingDelta: "Analyzing problem..." });
        onStep({ stepType: "thinking", thinkingDelta: " Found solution." });
        onStep({ stepType: "agent_response", textDelta: "Here is the answer." });
        return {
          conversationId: "conv-reasoning-1",
          status: "SUCCESS",
          response: "Here is the answer.",
          numTurns: 1,
        };
      },
      async cancel() {},
      async close() {},
    };
    const listModels = async (): Promise<AntigravityModelsResult> => ({
      stdout: `${MODEL}\t${MODEL_LABEL}\n`,
      stderr: "",
    });
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => transport, listModels },
    );
    try {
      const opened = await adapter.open({ kind: "create", cwd: root, environment });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const outputs = waitForTurn(session);
      const command: TurnStartCommand = {
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-reasoning-1"),
        input: [{ type: "text", text: "Think and answer" }],
      };
      await session.execute(command);
      const events = await outputs;
      const reasoningStarted = events.some(
        (e) =>
          e.kind === "event" &&
          e.event.type === "item.started" &&
          e.event.item.type === "reasoning",
      );
      const reasoningUpdated = events.some(
        (e) =>
          e.kind === "event" &&
          e.event.type === "item.updated" &&
          e.event.update.type === "text.append" &&
          e.event.update.text === " Found solution.",
      );
      expect(reasoningStarted).toBe(true);
      expect(reasoningUpdated).toBe(true);
      await session.close();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects Antigravity tool output as structured replacements", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-tool-output-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const transport: AntigravityCliTransportLike = {
      conversationId: "conv-tool-output-1",
      logPath: null,
      async start() {
        return { conversationId: "conv-tool-output-1", cwd: root, model: MODEL };
      },
      async setModel(model: string) {
        return { conversationId: "conv-tool-output-1", cwd: root, model };
      },
      async setEffort() {
        return { conversationId: "conv-tool-output-1", cwd: root, model: MODEL };
      },
      async setPermissionMode() {
        return { conversationId: "conv-tool-output-1", cwd: root, model: MODEL };
      },
      async runTurn(_text, onStep) {
        onStep({
          stepType: "tool",
          state: "ACTIVE",
          stepIndex: 1,
          toolName: "ViewFile",
          toolInfo: { parameters: { path: "README.md" }, output: "first" },
        });
        onStep({
          stepType: "tool",
          state: "DONE",
          stepIndex: 1,
          toolName: "ViewFile",
          toolInfo: { parameters: { path: "README.md" }, output: "first second" },
        });
        return {
          conversationId: "conv-tool-output-1",
          status: "SUCCESS",
          response: "finished",
          numTurns: 1,
        };
      },
      async cancel() {},
      async close() {},
    };
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      {
        createTransport: () => transport,
        listModels: async () => ({ stdout: `${MODEL}\t${MODEL_LABEL}\n`, stderr: "" }),
      },
    );
    try {
      const opened = await adapter.open({ kind: "create", cwd: root, environment });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const outputs = waitForTurn(opened.value);
      await opened.value.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("tool-output-turn"),
        input: [{ type: "text", text: "read the file" }],
      });
      const events = await outputs;
      const updates = events.flatMap((output) =>
        output.kind === "event" && output.event.type === "item.updated" ? [output.event] : [],
      );
      expect(updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: {
              type: "output.replace",
              output: { content: [{ type: "text", text: "first" }] },
            },
          }),
          expect.objectContaining({
            update: {
              type: "output.replace",
              output: { content: [{ type: "text", text: "first second" }] },
            },
          }),
        ]),
      );
      expect(updates.some((event) => event.update.type === "output.append")).toBe(false);
      await opened.value.close();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports thinking.select and updates effectiveThinkingOptionId", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-thinking-test-"));
    const environment = {
      HOME: root,
      ANTIGRAVITY_APP_DATA_DIR: root,
      CODEXHOST_DATA_DIR: root,
    };
    const transportFactory = fakeTransportFactory("conv-thinking-select-1");
    // The CLI lists effort variants as separate rows; the Model catalog then
    // exposes them as Thinking options (upstream-aligned parsing).
    const effortRows = ["low", "medium", "high"]
      .map((effort) => `${MODEL}-${effort}\t${MODEL_LABEL} (${effort})\n`)
      .join("");
    const listModels = async (): Promise<AntigravityModelsResult> => ({
      stdout: `${MODEL}\t${MODEL_LABEL}\n${effortRows}`,
      stderr: "",
    });
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => transportFactory.create(), listModels },
    );
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: root,
        environment,
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("low"),
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;

      const snapshotBefore = await session.readSnapshot();
      expect(snapshotBefore.ok).toBe(true);
      if (!snapshotBefore.ok || !snapshotBefore.value.state) {
        throw new Error(snapshotBefore.ok ? "Missing state" : snapshotBefore.error.message);
      }
      expect(snapshotBefore.value.state.effectiveThinkingOptionId).toBe("low");
      expect(snapshotBefore.value.state.availableThinkingOptions?.map((o) => o.id)).toEqual([
        "low",
        "medium",
        "high",
      ]);

      const selectResult = await session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      });
      expect(selectResult.ok).toBe(true);
      expect(transportFactory.lastEffort()).toBe("high");

      const snapshotAfter = await session.readSnapshot();
      expect(snapshotAfter.ok).toBe(true);
      if (!snapshotAfter.ok || !snapshotAfter.value.state) {
        throw new Error(snapshotAfter.ok ? "Missing state" : snapshotAfter.error.message);
      }
      expect(snapshotAfter.value.state.effectiveThinkingOptionId).toBe("high");

      await session.close();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hibernates an idle Session and allows the next Turn to restart it", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-session-idle-test-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const transportFactory = fakeTransportFactory("conv-session-idle-1");
    const listModels = async (): Promise<AntigravityModelsResult> => ({
      stdout: `${MODEL}\t${MODEL_LABEL}\n`,
      stderr: "",
    });
    const adapter = new AntigravityAdapter(
      {
        command: path.join(os.homedir(), ".local/bin/agy"),
        environment,
        sessionIdleTimeoutMs: 100,
      },
      { createTransport: () => transportFactory.create(), listModels },
    );
    try {
      const opened = await adapter.open({ kind: "create", cwd: root, environment });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;

      const outputIterator = session.outputs[Symbol.asyncIterator]();
      const firstTurn = waitForTurnIterator(outputIterator);
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("idle-turn-1"),
        input: [{ type: "text", text: "first" }],
      });
      await firstTurn;
      expect(transportFactory.hibernateCalls()).toBe(0);

      await vi.advanceTimersByTimeAsync(101);
      expect(transportFactory.hibernateCalls()).toBe(1);

      const secondTurn = waitForTurnIterator(outputIterator);
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("idle-turn-2"),
        input: [{ type: "text", text: "second" }],
      });
      await secondTurn;
      expect(transportFactory.hibernateCalls()).toBe(1);
    } finally {
      await adapter.close();
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not start a Turn when Session startup fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-start-fail-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    let startCalls = 0;
    const transport: AntigravityCliTransportLike = {
      conversationId: undefined,
      logPath: null,
      async start() {
        startCalls += 1;
        if (startCalls === 1) {
          return { conversationId: "conv-start-fail", cwd: root, model: MODEL };
        }
        throw new Error("Antigravity Session startup timed out");
      },
      async setModel(model: string) {
        return { conversationId: "conv-start-fail", cwd: root, model };
      },
      async setEffort() {
        return { conversationId: "conv-start-fail", cwd: root, model: MODEL };
      },
      async setPermissionMode() {
        return { conversationId: "conv-start-fail", cwd: root, model: MODEL };
      },
      async runTurn() {
        throw new Error("runTurn must not run when start failed");
      },
      async cancel() {},
      async close() {},
    };
    const adapter = new AntigravityAdapter(
      {
        command: path.join(os.homedir(), ".local/bin/agy"),
        environment,
      },
      {
        createTransport: () => transport,
        listModels: async () => ({ stdout: `${MODEL}\t${MODEL_LABEL}\n`, stderr: "" }),
      },
    );
    try {
      const opened = await adapter.open({ kind: "create", cwd: root, environment });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const events: HarnessOutput[] = [];
      const consuming = (async () => {
        for await (const output of session.outputs) events.push(output);
      })();
      const started = await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("start-fail-turn"),
        input: [{ type: "text", text: "hello" }],
      });
      expect(started).toMatchObject({
        ok: false,
        error: { message: "Antigravity Session startup timed out" },
      });
      await session.close();
      await consuming;
      expect(
        events.filter((output) => output.kind === "event" && output.event.type === "turn.started"),
      ).toHaveLength(0);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caches inspect results and only refreshes when refresh is requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-cache-test-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    let listCalls = 0;
    const listModels = async (): Promise<AntigravityModelsResult> => {
      listCalls += 1;
      return { stdout: `${MODEL}\t${MODEL_LABEL}\n`, stderr: "" };
    };
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => fakeTransportFactory("inspect-cache").create(), listModels },
    );
    try {
      const first = await adapter.inspect({ cwd: root });
      expect(first.status).toBe("ready");
      expect(listCalls).toBe(1);

      // Subsequent inspect returns from cache without running listModels
      const second = await adapter.inspect({ cwd: root });
      expect(second.status).toBe("ready");
      expect(listCalls).toBe(1);

      // open() also reuses cache
      const opened = await adapter.open({ kind: "create", cwd: root, environment });
      expect(opened.ok).toBe(true);
      expect(listCalls).toBe(1);
      if (opened.ok) await opened.value.close();

      // With refresh: true, it re-queries
      const refreshed = await adapter.inspect({ cwd: root, refresh: true });
      expect(refreshed.status).toBe("ready");
      expect(listCalls).toBe(2);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses the persisted account catalog across cwd changes and adapter restarts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-persisted-cache-"));
    const firstCwd = path.join(root, "first-cwd");
    const secondCwd = path.join(root, "second-cwd");
    await mkdir(firstCwd, { recursive: true });
    await mkdir(secondCwd, { recursive: true });
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    let listCalls = 0;
    const listModels = async (): Promise<AntigravityModelsResult> => {
      listCalls += 1;
      return { stdout: `${MODEL}\t${MODEL_LABEL}\n`, stderr: "" };
    };
    const createAdapter = (): AntigravityAdapter =>
      new AntigravityAdapter(
        { command: path.join(os.homedir(), ".local/bin/agy"), environment },
        { createTransport: () => fakeTransportFactory("persisted-cache").create(), listModels },
      );
    const first = createAdapter();
    try {
      await first.inspect({ cwd: firstCwd });
    } finally {
      await first.close();
    }

    const second = createAdapter();
    try {
      await expect(second.inspect({ cwd: secondCwd })).resolves.toMatchObject({ status: "ready" });
      expect(listCalls).toBe(1);
    } finally {
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat persisted readiness as valid after the configured CLI disappears", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-cache-command-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const listModels = async (): Promise<AntigravityModelsResult> => ({
      stdout: `${MODEL}\t${MODEL_LABEL}\n`,
      stderr: "",
    });
    const first = new AntigravityAdapter(
      { command: "/bin/sh", environment },
      { createTransport: () => fakeTransportFactory("persisted-command").create(), listModels },
    );
    await expect(first.inspect({ cwd: root })).resolves.toMatchObject({ status: "ready" });
    await first.close();

    const second = new AntigravityAdapter(
      {
        environment: {
          ...environment,
          CODEXHOST_ANTIGRAVITY_COMMAND: path.join(root, "missing-agy"),
        },
      },
      { createTransport: () => fakeTransportFactory("persisted-command").create(), listModels },
    );
    try {
      await expect(second.inspect({ cwd: root })).resolves.toMatchObject({
        status: "notInstalled",
      });
    } finally {
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the local history cache without starting AGY", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-fast-history-"));
    const threadId = "cached-thread";
    const conversationId = "cached-conversation";
    const environment = {
      HOME: root,
      CODEXHOST_DATA_DIR: root,
      CODEXHOST_THREAD_ID: threadId,
      PATH: "/synthetic",
    };
    const nativeRef: NativeSessionRef = {
      harnessId: harnessIdSchema.parse("antigravity"),
      nativeSessionId: conversationId,
      locator: { model: MODEL },
      formatVersion: 1,
    };
    const nativeTurnRef = {
      harnessId: "antigravity",
      nativeSessionId: conversationId,
      nativeTurnKey: `${conversationId}:turn:1`,
      formatVersion: 1,
    };
    await mkdir(path.join(root, "antigravity-history"), { recursive: true });
    await writeFile(
      path.join(root, "antigravity-history", `${threadId}.json`),
      `${JSON.stringify({
        formatVersion: 1,
        nativeSessionId: conversationId,
        turns: [
          {
            nativeTurnRef,
            input: [{ type: "text", text: "cached prompt" }],
            items: [],
            outcome: { status: "succeeded" },
          },
        ],
      })}\n`,
      "utf8",
    );
    let transportStarts = 0;
    const factory = fakeTransportFactory(conversationId);
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      {
        createTransport: () => {
          const transport = factory.create();
          const start = transport.start;
          return {
            ...transport,
            async start() {
              transportStarts += 1;
              return start();
            },
          };
        },
      },
    );
    try {
      const result = await adapter.readCachedSnapshot({
        kind: "resume",
        cwd: root,
        environment,
        nativeRef,
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok || !result.value) throw new Error("Cached history was not returned");
      expect(result.value.turns).toHaveLength(1);
      expect(result.value.turns[0]?.input[0]?.text).toBe("cached prompt");
      expect(transportStarts).toBe(0);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prewarms create sessions even when a Permission Mode is selected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-prewarm-mode-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const transportFactory = fakeTransportFactory("prewarm-mode");
    let startsBeforeCatalog = 0;
    const listModels = async (): Promise<AntigravityModelsResult> => {
      startsBeforeCatalog = transportStarts;
      return {
        stdout: `${MODEL}\t${MODEL_LABEL}\n${MODEL}-low\t${MODEL_LABEL} (Low)\n`,
        stderr: "",
      };
    };
    let transportStarts = 0;
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      {
        createTransport: () => {
          const transport = transportFactory.create();
          const start = transport.start;
          return {
            ...transport,
            async start() {
              transportStarts += 1;
              return start();
            },
          };
        },
        listModels,
      },
    );
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: root,
        environment,
        model: encodeAntigravityModelRef(MODEL),
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("low"),
        permissionModeId: harnessPermissionModeIdSchema.parse("configured"),
      });
      expect(opened.ok).toBe(true);
      expect(startsBeforeCatalog).toBe(1);
      expect(transportStarts).toBe(1);
      if (opened.ok) await opened.value.close();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies authentication and login failures as authenticationRequired", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-auth-test-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const listModels = async (): Promise<AntigravityModelsResult> => {
      throw new Error("Authentication required: please run 'agy login' or sign in to continue");
    };
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => fakeTransportFactory("inspect-auth").create(), listModels },
    );
    try {
      const result = await adapter.inspect({ cwd: root });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("authenticationRequired");
      }
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cools down repeated inspection failures until an explicit refresh", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "codexhost-antigravity-inspect-failure-cache-"),
    );
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    let listCalls = 0;
    const listModels = async (): Promise<AntigravityModelsResult> => {
      listCalls += 1;
      throw new Error("Authentication required: please sign in to continue");
    };
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => fakeTransportFactory("inspect-failure-cache").create(), listModels },
    );
    try {
      await expect(adapter.inspect({ cwd: root })).resolves.toMatchObject({ status: "error" });
      await expect(adapter.inspect({ cwd: root })).resolves.toMatchObject({ status: "error" });
      expect(listCalls).toBe(1);

      await expect(adapter.inspect({ cwd: root, refresh: true })).resolves.toMatchObject({
        status: "error",
      });
      expect(listCalls).toBe(2);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes session gracefully when active model differs from locator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-resume-model-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const transport = fakeTransportFactory("resume-model-diff", "gemini-flash");
    const listModels = async (): Promise<AntigravityModelsResult> => ({
      stdout: `${MODEL}\t${MODEL_LABEL}\ngemini-flash\tGemini Flash\n`,
      stderr: "",
    });
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => transport.create(), listModels },
    );
    try {
      const nativeRef: NativeSessionRef = {
        harnessId: harnessIdSchema.parse("antigravity"),
        nativeSessionId: "resume-model-diff",
        locator: { model: MODEL },
        formatVersion: 1,
      };
      const resumed = await adapter.open({
        kind: "resume",
        cwd: root,
        environment,
        nativeRef,
      });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(resumed.value.initialState.nativeRef).toMatchObject({
        locator: { skipPermissions: true },
      });
      expect(resumed.value.initialState.effectiveModel).toEqual(
        encodeAntigravityModelRef("gemini-flash"),
      );
      await resumed.value.close();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects localhost and IPv6 loopback into NO_PROXY when proxy is present in environment", () => {
    const envWithProxy = {
      HTTP_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "corp.internal",
    };
    const resolved = resolveAntigravityProxyEnvironment(envWithProxy, "linux");
    expect(resolved.NO_PROXY).toContain("corp.internal");
    expect(resolved.NO_PROXY).toContain("127.0.0.1");
    expect(resolved.NO_PROXY).toContain("localhost");
    expect(resolved.NO_PROXY).toContain("::1");
    expect(resolved.no_proxy).toEqual(resolved.NO_PROXY);
  });

  it("handles model selection gracefully when transport normalizes model to alias", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-select-model-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const transportFactory = fakeTransportFactory("select-model-test", MODEL);
    const transport = transportFactory.create();
    // Simulate CLI normalising "gemini-flash" to "gemini-3.7-flash"
    transport.setModel = async () => ({
      conversationId: "select-model-test",
      cwd: root,
      model: MODEL,
    });
    const listModels = async (): Promise<AntigravityModelsResult> => ({
      stdout: `${MODEL}\t${MODEL_LABEL}\ngemini-flash\tGemini Flash\n`,
      stderr: "",
    });
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => transport, listModels },
    );
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: root,
        environment,
        model: encodeAntigravityModelRef(MODEL),
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;

      // Select "gemini-flash", which CLI responds with canonical MODEL
      const result = await session.execute({
        type: "model.select",
        model: encodeAntigravityModelRef("gemini-flash"),
      });
      expect(result.ok).toBe(true);

      const snapshot = await session.readSnapshot();
      expect(snapshot.ok).toBe(true);
      if (snapshot.ok && snapshot.value.state) {
        expect(snapshot.value.state.effectiveModel).toEqual(encodeAntigravityModelRef(MODEL));
      }
      await session.close();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves or defaults effort when switching models mid-session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-switch-effort-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    let capturedModel: string | undefined;
    let capturedEffort: string | undefined;
    const transport: AntigravityCliTransportLike = {
      conversationId: "conv-switch-1",
      logPath: null,
      async start() {
        return { conversationId: "conv-switch-1", cwd: root, model: "gemini-2.5-flash" };
      },
      async setModel(model: string, effort?: string) {
        capturedModel = model;
        capturedEffort = effort;
        return { conversationId: "conv-switch-1", cwd: root, model };
      },
      async setEffort(effort: string | undefined) {
        capturedEffort = effort;
        return {
          conversationId: "conv-switch-1",
          cwd: root,
          model: capturedModel ?? "gemini-2.5-flash",
        };
      },
      async setPermissionMode() {
        return {
          conversationId: "conv-switch-1",
          cwd: root,
          model: capturedModel ?? "gemini-2.5-flash",
        };
      },
      async runTurn(_text, onStep) {
        onStep({ stepType: "agent_response", textDelta: "ok" });
        return { conversationId: "conv-switch-1", status: "SUCCESS", response: "ok", numTurns: 1 };
      },
      async cancel() {},
      async close() {},
    };
    const listModels = async (): Promise<AntigravityModelsResult> => ({
      stdout:
        "gemini-2.5-flash\tGemini 2.5 Flash\n" +
        "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n" +
        "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n" +
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n" +
        "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n" +
        "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n" +
        "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n",
      stderr: "",
    });
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => transport, listModels },
    );
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: root,
        environment,
        model: encodeAntigravityModelRef("gemini-3.8-flash"),
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("medium"),
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;

      // Switch to gemini-3.7-flash: should retain "medium" effort
      const res1 = await session.execute({
        type: "model.select",
        model: encodeAntigravityModelRef("gemini-3.7-flash"),
      });
      expect(res1.ok).toBe(true);
      expect(capturedModel).toBe("gemini-3.7-flash");
      expect(capturedEffort).toBe("medium");

      const snap1 = await session.readSnapshot();
      expect(snap1.ok).toBe(true);
      if (snap1.ok && snap1.value.state) {
        expect(snap1.value.state.effectiveModel).toEqual(
          encodeAntigravityModelRef("gemini-3.7-flash"),
        );
        expect(snap1.value.state.effectiveThinkingOptionId).toBe("medium");
      }

      // Now switch to gemini-2.5-flash (which does not support effort)
      const res2 = await session.execute({
        type: "model.select",
        model: encodeAntigravityModelRef("gemini-2.5-flash"),
      });
      expect(res2.ok).toBe(true);
      expect(capturedModel).toBe("gemini-2.5-flash");
      expect(capturedEffort).toBeUndefined();

      // Now switch back to gemini-3.7-flash: should default to strongest effort ("high")
      const res3 = await session.execute({
        type: "model.select",
        model: encodeAntigravityModelRef("gemini-3.7-flash"),
      });
      expect(res3.ok).toBe(true);
      expect(capturedModel).toBe("gemini-3.7-flash");
      expect(capturedEffort).toBe("high");

      await session.close();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats completed turn with transient network retry error as succeeded without surfacing error banner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-net-retry-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const transport: AntigravityCliTransportLike = {
      conversationId: "conv-net-retry-1",
      logPath: null,
      async start() {
        return { conversationId: "conv-net-retry-1", cwd: root, model: MODEL };
      },
      async setModel(model: string) {
        return { conversationId: "conv-net-retry-1", cwd: root, model };
      },
      async setEffort() {
        return { conversationId: "conv-net-retry-1", cwd: root, model: MODEL };
      },
      async setPermissionMode() {
        return { conversationId: "conv-net-retry-1", cwd: root, model: MODEL };
      },
      async runTurn(_text, onStep) {
        onStep({ stepType: "agent_response", textDelta: "Full response generated after retry." });
        return {
          conversationId: "conv-net-retry-1",
          status: "ERROR",
          error:
            'API error (attempt 2): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp 127.0.0.1:50999->127.0.0.1:7897: read: connection reset by peer',
          response: "Full response generated after retry.",
          numTurns: 1,
        };
      },
      async cancel() {},
      async close() {},
    };
    const listModels = async (): Promise<AntigravityModelsResult> => ({
      stdout: `${MODEL}\t${MODEL_LABEL}\n`,
      stderr: "",
    });
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => transport, listModels },
    );
    try {
      const opened = await adapter.open({ kind: "create", cwd: root, environment });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const outputs = waitForTurn(session);
      const command: TurnStartCommand = {
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-net-retry-1"),
        input: [{ type: "text", text: "Hello" }],
      };
      await session.execute(command);
      const events = await outputs;
      const completedEvent = events.find(
        (e) => e.kind === "event" && e.event.type === "turn.completed",
      );
      expect(completedEvent).toBeDefined();
      if (
        completedEvent &&
        completedEvent.kind === "event" &&
        completedEvent.event.type === "turn.completed"
      ) {
        expect(completedEvent.event.outcome.status).toBe("succeeded");
        expect((completedEvent.event.outcome as { error?: unknown }).error).toBeUndefined();
      }
      await session.close();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reroutes transient network error steps during streaming to reasoning instead of agent text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-net-stream-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    const transport: AntigravityCliTransportLike = {
      conversationId: "conv-net-stream-1",
      logPath: null,
      async start() {
        return { conversationId: "conv-net-stream-1", cwd: root, model: MODEL };
      },
      async setModel(model: string) {
        return { conversationId: "conv-net-stream-1", cwd: root, model };
      },
      async setEffort() {
        return { conversationId: "conv-net-stream-1", cwd: root, model: MODEL };
      },
      async setPermissionMode() {
        return { conversationId: "conv-net-stream-1", cwd: root, model: MODEL };
      },
      async runTurn(_text, onStep) {
        onStep({ stepType: "thinking", thinkingDelta: "Analyzing..." });
        // Simulating a transient error step that agy might send
        onStep({
          stepType: "error",
          message: "API error (attempt 1): request failed: unexpected EOF",
        });
        onStep({ stepType: "agent_response", textDelta: "Here is the valid answer." });
        return {
          conversationId: "conv-net-stream-1",
          status: "SUCCESS",
          response: "Here is the valid answer.",
          numTurns: 1,
        };
      },
      async cancel() {},
      async close() {},
    };
    const listModels = async (): Promise<AntigravityModelsResult> => ({
      stdout: `${MODEL}\t${MODEL_LABEL}\n`,
      stderr: "",
    });
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport: () => transport, listModels },
    );
    try {
      const opened = await adapter.open({ kind: "create", cwd: root, environment });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const outputs = waitForTurn(session);
      const command: TurnStartCommand = {
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-net-stream-1"),
        input: [{ type: "text", text: "Question" }],
      };
      await session.execute(command);
      const events = await outputs;

      // Reasoning should contain the retry notification
      const reasoningAppends = events.filter(
        (e) =>
          e.kind === "event" &&
          e.event.type === "item.updated" &&
          e.event.update.type === "text.append" &&
          e.event.update.text.includes("网络连接出现波动"),
      );
      expect(reasoningAppends.length).toBeGreaterThan(0);

      // Agent message text should NOT contain "API error"
      const agentItems = events.filter(
        (e) =>
          e.kind === "event" &&
          e.event.type === "item.started" &&
          e.event.item.type === "agentMessage",
      );
      expect(agentItems.length).toBeGreaterThan(0);

      await session.close();
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pre-warms draft via reserveDraft and claims it cleanly on open", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-draft-test-"));
    const environment = { HOME: root, CODEXHOST_DATA_DIR: root, PATH: "/synthetic" };
    let transportCreatedCount = 0;
    const createTransport = (): AntigravityCliTransportLike => {
      transportCreatedCount += 1;
      return fakeTransportFactory(`draft-transport-${transportCreatedCount}`).create();
    };
    const listModels = async (): Promise<AntigravityModelsResult> => {
      return { stdout: `${MODEL}\t${MODEL_LABEL}\n`, stderr: "" };
    };
    const adapter = new AntigravityAdapter(
      { command: path.join(os.homedir(), ".local/bin/agy"), environment },
      { createTransport, listModels },
    );
    try {
      await adapter.reserveDraft({
        cwd: root,
        model: encodeAntigravityModelRef(MODEL),
      });

      expect(transportCreatedCount).toBe(1);

      // open() should claim the reserved transport without creating a second one
      const opened = await adapter.open({
        kind: "create",
        cwd: root,
        model: encodeAntigravityModelRef(MODEL),
        environment,
      });

      expect(opened.ok).toBe(true);
      expect(transportCreatedCount).toBe(1);

      if (opened.ok) {
        await opened.value.close();
      }
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

