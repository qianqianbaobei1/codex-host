import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_ACCOUNT_ID_ENV,
  AntigravityAccountStore,
  type AntigravityAccountsFileV1,
} from "../src/accounts.js";
import {
  AntigravityAdapter,
  type AntigravityCliTransportLike,
} from "../src/antigravity-adapter.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `codexhost-antigravity-${prefix}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Fake `agy` that records argv/cwd/env and answers `models`. */
async function writeFakeAgy(root: string): Promise<string> {
  const file = path.join(root, "fake-agy.sh");
  await writeFile(
    file,
    `#!/bin/bash
{
  echo "ARGV:$*"
  echo "CWD:$(pwd)"
  env
} > "$CAPTURE_FILE"
printf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'
`,
    "utf8",
  );
  await chmod(file, 0o755);
  return file;
}

function parseCapture(raw: string): { argv: string; cwd: string; env: Record<string, string> } {
  const env: Record<string, string> = {};
  let argv = "";
  let cwd = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("ARGV:")) {
      argv = line.slice("ARGV:".length);
      continue;
    }
    if (line.startsWith("CWD:")) {
      cwd = line.slice("CWD:".length);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return { argv, cwd, env };
}

function accountsValue(
  overrides: Partial<AntigravityAccountsFileV1> = {},
): AntigravityAccountsFileV1 {
  return {
    formatVersion: 1,
    defaultAccountId: "default",
    accounts: [{ id: "default", name: "本机", legacy: true, enabled: true }],
    threadBindings: {},
    nativeSessionBindings: {},
    ...overrides,
  };
}

const MODELS_OUTPUT = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n";

describe("Antigravity multi-account compatibility gate (spawn level)", () => {
  it("legacy mode spawns with an unchanged environment", async () => {
    const root = await makeRoot("compat-legacy");
    const realHome = path.join(root, "home");
    const cwd = path.join(root, "cwd");
    await mkdir(realHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const capture = path.join(root, "capture.txt");
    const command = await writeFakeAgy(root);

    const adapter = new AntigravityAdapter({
      command,
      environment: {
        ...process.env,
        HOME: realHome,
        CAPTURE_FILE: capture,
        CODEX_HOME: path.join(realHome, ".codex"),
        CODEXHOST_DATA_DIR: path.join(realHome, "data"),
        CODEX_DELIVERY_ROOT: path.join(realHome, "delivery"),
      },
    });
    try {
      const inspection = await adapter.inspect({ cwd });
      expect(inspection.status).toBe("ready");
    } finally {
      await adapter.close();
    }

    const { argv, cwd: spawnedCwd, env } = parseCapture(await readFile(capture, "utf8"));
    expect(argv).toBe("models");
    expect(spawnedCwd).toBe(await realpath(cwd));
    expect(env.HOME).toBe(realHome);
    expect(env.CODEX_HOME).toBe(path.join(realHome, ".codex"));
    expect(env.CODEXHOST_DATA_DIR).toBe(path.join(realHome, "data"));
    expect(env.CODEX_DELIVERY_ROOT).toBe(path.join(realHome, "delivery"));
    expect(env[ANTIGRAVITY_ACCOUNT_ID_ENV]).toBeUndefined();
  });

  it("shadow mode moves only HOME and restores the host anchors", async () => {
    const root = await makeRoot("compat-shadow");
    const realHome = path.join(root, "home");
    const cwd = path.join(root, "cwd");
    await mkdir(realHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const capture = path.join(root, "capture.txt");
    const command = await writeFakeAgy(root);
    const dataDir = path.join(realHome, "data");
    const store = new AntigravityAccountStore({
      file: path.join(realHome, ".agy-accounts", "accounts.json"),
      realHome,
      value: accountsValue({
        defaultAccountId: "work",
        accounts: [
          { id: "default", name: "本机", legacy: true, enabled: true },
          { id: "work", name: "工作", enabled: true },
        ],
      }),
    });

    const adapter = new AntigravityAdapter({
      command,
      accounts: { mode: "multi", store },
      environment: {
        ...process.env,
        HOME: realHome,
        CAPTURE_FILE: capture,
        CODEX_HOME: path.join(realHome, ".codex"),
        CODEXHOST_DATA_DIR: dataDir,
        CODEX_DELIVERY_ROOT: path.join(realHome, "delivery"),
      },
    });
    try {
      const inspection = await adapter.inspect({ cwd });
      expect(inspection.status).toBe("ready");
    } finally {
      await adapter.close();
    }

    const { env } = parseCapture(await readFile(capture, "utf8"));
    expect(env.HOME).toBe(path.join(realHome, ".agy-accounts", "work", "home"));
    expect(env.CODEX_HOME).toBe(path.join(realHome, ".codex"));
    expect(env.CODEXHOST_DATA_DIR).toBe(dataDir);
    expect(env.CODEX_DELIVERY_ROOT).toBe(path.join(realHome, "delivery"));
    expect(env[ANTIGRAVITY_ACCOUNT_ID_ENV]).toBeUndefined();
  });

  it("materialises host anchors when the host process never set them", async () => {
    const root = await makeRoot("compat-anchors");
    const realHome = path.join(root, "home");
    const cwd = path.join(root, "cwd");
    await mkdir(realHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const capture = path.join(root, "capture.txt");
    const command = await writeFakeAgy(root);
    const store = new AntigravityAccountStore({
      file: path.join(realHome, ".agy-accounts", "accounts.json"),
      realHome,
      value: accountsValue({
        defaultAccountId: "work",
        accounts: [
          { id: "default", name: "本机", legacy: true, enabled: true },
          { id: "work", name: "工作", enabled: true },
        ],
      }),
    });

    const adapter = new AntigravityAdapter({
      command,
      accounts: { mode: "multi", store },
      environment: {
        ...process.env,
        HOME: realHome,
        CAPTURE_FILE: capture,
        CODEX_HOME: undefined,
        CODEXHOST_DATA_DIR: undefined,
        CODEX_DELIVERY_ROOT: undefined,
      },
    });
    try {
      await adapter.inspect({ cwd });
    } finally {
      await adapter.close();
    }

    const { env } = parseCapture(await readFile(capture, "utf8"));
    expect(env.HOME).toBe(path.join(realHome, ".agy-accounts", "work", "home"));
    expect(env.CODEX_HOME).toBe(path.join(realHome, ".codex"));
    expect(env.CODEXHOST_DATA_DIR).toBe(path.join(realHome, ".codex", "codexhost-cache"));
    expect(env.CODEX_DELIVERY_ROOT).toBe(path.join(realHome, "PycharmProjects", "codex"));
  });

  it("fails closed on a corrupt accounts file without spawning agy", async () => {
    const root = await makeRoot("compat-invalid");
    const realHome = path.join(root, "home");
    const cwd = path.join(root, "cwd");
    await mkdir(realHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const capture = path.join(root, "capture.txt");
    const command = await writeFakeAgy(root);

    const adapter = new AntigravityAdapter({
      command,
      accounts: { mode: "invalid", error: new Error("accounts.json is corrupt") },
      environment: { ...process.env, HOME: realHome, CAPTURE_FILE: capture },
    });
    try {
      const opened = await adapter.open({ kind: "create", cwd });
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.error.code).toBe("unavailable");
      expect(opened.error.message).toMatch(/invalid/u);
    } finally {
      await adapter.close();
    }
    await expect(readFile(capture, "utf8")).rejects.toThrow();
  });
});

describe("Antigravity capability guardrail", () => {
  it("pins fork/rollback as unsupported so an upstream merge cannot silently enable them", () => {
    const adapter = new AntigravityAdapter();
    expect(adapter.capabilities.history.fork).toBe(false);
    expect(adapter.capabilities.history.forkAcrossCwd).toBe(false);
    expect(adapter.capabilities.history.rollbackLastTurn).toBe(false);
  });
});

describe("Antigravity account binding persistence", () => {
  it("keeps working when binding metadata cannot be written in a single-account setup", async () => {
    const root = await makeRoot("binding-readonly-single");
    const realHome = path.join(root, "home");
    const cwd = path.join(root, "cwd");
    const locked = path.join(root, "locked");
    await mkdir(realHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(locked, { recursive: true });
    const store = new AntigravityAccountStore({
      file: path.join(locked, "accounts.json"),
      realHome,
      value: accountsValue(),
    });
    await chmod(locked, 0o500);
    const adapter = new AntigravityAdapter(
      {
        accounts: { mode: "multi", store },
        environment: {
          ...process.env,
          HOME: realHome,
          CODEXHOST_DATA_DIR: path.join(realHome, "data"),
        },
      },
      {
        listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }),
        createTransport: () => fakeTransport("conv-single"),
      },
    );
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd,
        environment: { CODEXHOST_THREAD_ID: "thread-single" },
      });
      expect(opened.ok).toBe(true);
      if (opened.ok) await opened.value.close();
    } finally {
      await adapter.close();
      await chmod(locked, 0o700);
    }
  });

  it("fails closed when binding metadata cannot be written and several accounts exist", async () => {
    const root = await makeRoot("binding-readonly-multi");
    const realHome = path.join(root, "home");
    const cwd = path.join(root, "cwd");
    const locked = path.join(root, "locked");
    await mkdir(realHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(locked, { recursive: true });
    const store = new AntigravityAccountStore({
      file: path.join(locked, "accounts.json"),
      realHome,
      value: accountsValue({
        accounts: [
          { id: "default", name: "本机", legacy: true, enabled: true },
          { id: "work", name: "工作", enabled: true },
        ],
      }),
    });
    await chmod(locked, 0o500);
    const adapter = new AntigravityAdapter(
      {
        accounts: { mode: "multi", store },
        environment: {
          ...process.env,
          HOME: realHome,
          CODEXHOST_DATA_DIR: path.join(realHome, "data"),
        },
      },
      {
        listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }),
        createTransport: () => fakeTransport("conv-multi"),
      },
    );
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd,
        environment: { CODEXHOST_THREAD_ID: "thread-multi" },
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.error.message).toMatch(/binding/u);
    } finally {
      await adapter.close();
      await chmod(locked, 0o700);
    }
  });
});

function fakeTransport(conversationId: string): AntigravityCliTransportLike {
  const init = () => ({ conversationId, cwd: process.cwd(), model: "gemini-3.8-flash-high" });
  return {
    get conversationId() {
      return conversationId;
    },
    get effort() {
      return undefined;
    },
    get logPath() {
      return null;
    },
    async start() {
      return init();
    },
    async setModel(model: string) {
      return { ...init(), model };
    },
    async setEffort() {
      return init();
    },
    async setPermissionMode() {
      return init();
    },
    async runTurn() {
      return { conversationId, status: "SUCCESS", response: "ok", numTurns: 1 };
    },
    async cancel() {},
    async hibernate() {},
    async close() {},
  };
}

describe("Antigravity per-Thread account routing", () => {
  async function setup(): Promise<{
    realHome: string;
    cwd: string;
    store: AntigravityAccountStore;
    environment: NodeJS.ProcessEnv;
  }> {
    const root = await makeRoot("routing");
    const realHome = path.join(root, "home");
    const cwd = path.join(root, "cwd");
    await mkdir(realHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const store = new AntigravityAccountStore({
      file: path.join(realHome, ".agy-accounts", "accounts.json"),
      realHome,
      value: accountsValue({
        accounts: [
          { id: "default", name: "本机", legacy: true, enabled: true },
          { id: "work", name: "工作", enabled: true },
        ],
      }),
    });
    return {
      realHome,
      cwd,
      store,
      environment: {
        ...process.env,
        HOME: realHome,
        CODEXHOST_DATA_DIR: path.join(realHome, "data"),
      },
    };
  }

  it("routes a create to the Thread-bound account and commits the binding", async () => {
    const { realHome, cwd, store, environment } = await setup();
    await store.bindThread({ threadId: "thread-9", accountId: "work", state: "committed" });
    let captured: NodeJS.ProcessEnv | undefined;
    const adapter = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, environment },
      {
        listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }),
        createTransport: (options) => {
          captured = options.environment;
          return fakeTransport("conv-created");
        },
      },
    );
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd,
        environment: { CODEXHOST_THREAD_ID: "thread-9" },
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(captured?.HOME).toBe(path.join(realHome, ".agy-accounts", "work", "home"));
      expect(captured?.[ANTIGRAVITY_ACCOUNT_ID_ENV]).toBe("work");
      const binding = store.bindingForThread("thread-9");
      expect(binding?.accountId).toBe("work");
      expect(binding?.state).toBe("committed");
      expect(binding?.nativeSessionId).toBe("conv-created");
      await opened.value.close();
    } finally {
      await adapter.close();
    }
  });

  it("resume follows the native Session owner, not a stale Thread binding", async () => {
    const { realHome, cwd, store, environment } = await setup();
    await store.bindThread({ threadId: "thread-owner", accountId: "work", state: "committed" });
    const creator = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, environment },
      {
        listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }),
        createTransport: () => fakeTransport("conv-own"),
      },
    );
    const created = await creator.open({
      kind: "create",
      cwd,
      environment: { CODEXHOST_THREAD_ID: "thread-owner" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const nativeRef = created.value.initialState.nativeRef;
    if (!nativeRef) throw new Error("synthetic Session did not publish a Native Ref");
    await created.value.close();
    await creator.close();

    // The Thread that resumes was (wrongly) bound to the legacy account.
    await store.bindThread({ threadId: "thread-9", accountId: "default", state: "committed" });
    let captured: NodeJS.ProcessEnv | undefined;
    const adapter = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, environment },
      {
        listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }),
        createTransport: (options) => {
          captured = options.environment;
          return fakeTransport("conv-own");
        },
      },
    );
    try {
      const opened = await adapter.open({
        kind: "resume",
        cwd,
        nativeRef,
        environment: { CODEXHOST_THREAD_ID: "thread-9" },
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(captured?.HOME).toBe(path.join(realHome, ".agy-accounts", "work", "home"));
      await opened.value.close();
    } finally {
      await adapter.close();
    }
  });
});
