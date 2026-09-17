import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANTIGRAVITY_ACCOUNT_ID_ENV,
  AntigravityAccountStore,
  type AntigravityAccountsFileV1,
} from "../src/accounts.js";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import {
  AntigravityAdapter,
  type AntigravityCliTransportLike,
} from "../src/antigravity-adapter.js";
import { AntigravityTransportError } from "../src/transport.js";

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

/** Fake agy that answers `models` and a per-HOME `/usage` quota. */
async function writeFakeAgyWithUsage(root: string): Promise<string> {
  const file = path.join(root, "fake-agy-usage.sh");
  await writeFile(
    file,
    `#!/bin/bash
if [ "$1" = "--print=/usage" ]; then
  case "$HOME" in
    *"/work/"*) RF=0.10 ;;
    *) RF=0.75 ;;
  esac
  printf '{"event":"command_result","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":%s}]}]}}}\n' "$RF"
  exit 0
fi
printf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'
`,
    "utf8",
  );
  await chmod(file, 0o755);
  return file;
}

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
      manageDarwinKeychain: false,
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
      manageDarwinKeychain: false,
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
        manageDarwinKeychain: false,
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
        manageDarwinKeychain: false,
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

describe("Antigravity account settings surface", () => {
  it("reports one row per account and switches the default", async () => {
    const root = await makeRoot("settings");
    const realHome = path.join(root, "home");
    await mkdir(realHome, { recursive: true });
    const command = await writeFakeAgyWithUsage(root);
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
    const adapter = new AntigravityAdapter({
      command,
      accounts: { mode: "multi", store },
      manageDarwinKeychain: false,
      environment: {
        ...process.env,
        HOME: realHome,
        CODEXHOST_DATA_DIR: path.join(realHome, "data"),
      },
    });
    try {
      const rows = await adapter.inspectAccounts();
      expect(rows).not.toBeNull();
      if (!rows) return;
      expect(rows.map((row) => row.accountId).sort()).toEqual(["default", "work"]);
      expect(rows.every((row) => row.selectable === true)).toBe(true);
      expect(rows.find((row) => row.accountId === "default")?.isDefault).toBe(true);
      // Account listing is metadata-only and must not trigger a quota/auth
      // probe. A previously written host-level snapshot may still be exposed
      // for the explicitly legacy account.

      await adapter.selectAccount("work");
      expect(store.defaultAccount()?.id).toBe("work");
      const after = await adapter.inspectAccounts();
      expect(after?.find((row) => row.accountId === "work")?.isDefault).toBe(true);
      expect(after?.find((row) => row.accountId === "default")?.isDefault).toBe(false);

      // Quota probing is explicit: the lightweight account listing above must
      // stay metadata-only, while Settings can ask for fresh per-account data.
      await adapter.refreshAccountCredits();
      const refreshed = await adapter.inspectAccounts();
      expect(refreshed?.find((row) => row.accountId === "default")?.credits).toMatchObject({
        usedPercent: 25,
        periodType: "weekly",
      });
      expect(refreshed?.find((row) => row.accountId === "work")?.credits).toMatchObject({
        usedPercent: 90,
        periodType: "weekly",
      });
    } finally {
      await adapter.close();
    }
  });

  it("reports nothing when multi-account mode is not configured", async () => {
    const adapter = new AntigravityAdapter();
    expect(await adapter.inspectAccounts()).toBeNull();
    await expect(adapter.selectAccount("work")).rejects.toThrow(/multi-account/u);
    await adapter.close();
  });

  it("opens an explicit account login terminal without running AGY in the Host", async () => {
    const root = await makeRoot("login-terminal");
    const realHome = path.join(root, "home");
    await mkdir(realHome, { recursive: true });
    const command = await writeFakeAgy(root);
    const store = new AntigravityAccountStore({
      file: path.join(realHome, ".agy-accounts", "accounts.json"),
      realHome,
      value: accountsValue({
        accounts: [
          { id: "default", name: "本机", legacy: true, enabled: true },
          { id: "work", name: "工作", enabled: true, state: "needs_login" },
        ],
      }),
    });
    let scriptPath = "";
    const adapter = new AntigravityAdapter(
      {
        command,
        accounts: { mode: "multi", store },
        environment: { ...process.env, HOME: realHome },
        manageDarwinKeychain: false,
      },
      {
        openLoginTerminal: async (input) => {
          scriptPath = input.scriptPath;
        },
      },
    );
    try {
      await adapter.loginAccount("work");
      expect(scriptPath).toMatch(/work-[0-9a-f-]+\.command$/u);
      const script = await readFile(scriptPath, "utf8");
      expect(script).toContain('--prompt-interactive ""');
      expect(script).toContain(
        `export HOME='${path.join(realHome, ".agy-accounts", "work", "home")}'`,
      );
      expect(store.get("work")?.state).toBe("needs_login");
    } finally {
      await adapter.close();
    }
  });
});

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

  it("reports the Thread's own Account for read-only display", async () => {
    const { realHome, store, environment } = await setup();
    await store.bindThread({ threadId: "thread-9", accountId: "work", state: "committed" });
    const adapter = new AntigravityAdapter({
      accounts: { mode: "multi", store },
      manageDarwinKeychain: false,
      environment,
    });
    try {
      expect(adapter.threadAccountId("thread-9")).toBe("work");
      // An unbound Thread must not be guessed from the Harness-wide default.
      expect(store.defaultAccount()?.id).toBe("default");
      expect(adapter.threadAccountId("thread-other")).toBeNull();

      // Threads created before Account bindings existed are located by the store
      // that physically holds their conversation, never by the default Account.
      const legacyStore = path.join(realHome, ".gemini", "antigravity-cli", "conversations");
      const workStore = path.join(
        realHome,
        ".agy-accounts",
        "work",
        "home",
        ".gemini",
        "antigravity-cli",
        "conversations",
      );
      await mkdir(legacyStore, { recursive: true });
      await mkdir(workStore, { recursive: true });
      await writeFile(path.join(legacyStore, "conv-legacy.db"), "", "utf8");
      await writeFile(path.join(workStore, "conv-work.db"), "", "utf8");
      expect(adapter.threadAccountId("thread-other", "conv-work")).toBe("work");
      expect(adapter.threadAccountId("thread-other", "conv-legacy")).toBe("default");
      expect(adapter.threadAccountId("thread-other", "conv-missing")).toBeNull();
      // Sharing the session store makes the physical location ambiguous for every
      // Account, so an explicit owner is the only correct answer.
      await writeFile(path.join(workStore, "conv-both.db"), "", "utf8");
      await writeFile(path.join(legacyStore, "conv-both.db"), "", "utf8");
      expect(adapter.threadAccountId("thread-other", "conv-both")).toBeNull();
      await store.recordNativeSessionOwner({ nativeSessionId: "conv-both", accountId: "work" });
      expect(adapter.threadAccountId("thread-other", "conv-both")).toBe("work");
      expect(adapter.threadAccountId("thread-other", "../../etc/passwd")).toBeNull();
      // A bound Thread always wins over the on-disk location.
      expect(adapter.threadAccountId("thread-9", "conv-legacy")).toBe("work");
    } finally {
      await adapter.close();
    }
  });

  it("routes a create to the Thread-bound account and commits the binding", async () => {
    const { realHome, cwd, store, environment } = await setup();
    await store.bindThread({ threadId: "thread-9", accountId: "work", state: "committed" });
    let captured: NodeJS.ProcessEnv | undefined;
    const adapter = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
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

  it("routes an unbound create to the selected default account", async () => {
    const { realHome, cwd, store, environment } = await setup();
    await store.setDefaultAccount("work");
    let captured: NodeJS.ProcessEnv | undefined;
    const adapter = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
      {
        listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }),
        createTransport: (options) => {
          captured = options.environment;
          return fakeTransport("conv-default");
        },
      },
    );
    try {
      const opened = await adapter.open({ kind: "create", cwd });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(captured?.HOME).toBe(path.join(realHome, ".agy-accounts", "work", "home"));
      await opened.value.close();
    } finally {
      await adapter.close();
    }
  });

  it("skips a default account whose cached quota is exhausted", async () => {
    const { realHome, cwd, store, environment } = await setup();
    await store.setDefaultAccount("work");
    const accountDirectory = path.join(realHome, ".agy-accounts", "work");
    await mkdir(accountDirectory, { recursive: true });
    await writeFile(
      path.join(accountDirectory, "quota-snapshot.json"),
      JSON.stringify({
        accountId: "work",
        credits: {
          usedPercent: 100,
          periodType: "five_hour",
          productUsage: [{ product: "Gemini 5-hour limit", usagePercent: 100 }],
        },
      }),
      "utf8",
    );
    let captured: NodeJS.ProcessEnv | undefined;
    const adapter = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
      {
        listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }),
        createTransport: (options) => {
          captured = options.environment;
          return fakeTransport("conv-quota-fallback");
        },
      },
    );
    try {
      const opened = await adapter.open({ kind: "create", cwd });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(captured?.HOME).toBe(realHome);
      await opened.value.close();
    } finally {
      await adapter.close();
    }
  });

  it("resume follows the native Session owner, not a stale Thread binding", async () => {
    const { realHome, cwd, store, environment } = await setup();
    await store.bindThread({ threadId: "thread-owner", accountId: "work", state: "committed" });
    const creator = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
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
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
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

  it("moves a Thread to another Account only when the target can reach the conversation", async () => {
    const { store, environment } = await setup();
    await store.bindThread({
      threadId: "thread-9",
      accountId: "default",
      nativeSessionId: "conv-move",
      state: "committed",
    });
    const adapter = new AntigravityAdapter({
      accounts: { mode: "multi", store },
      manageDarwinKeychain: false,
      environment,
    });
    try {
      // Before the session store is shared the target Account cannot see the files,
      // so the switch fails closed instead of silently starting a new conversation.
      await expect(
        adapter.selectThreadAccount({
          threadId: "thread-9",
          accountId: "work",
          nativeSessionId: "conv-move",
        }),
      ).rejects.toThrow(/cannot see this conversation/u);
      expect(store.bindingForThread("thread-9")?.accountId).toBe("default");

      // With the canonical session store in place every Account reaches it.
      const workConversations = path.join(
        store.homeFor(store.get("work") as never),
        ".gemini",
        "antigravity-cli",
        "conversations",
      );
      await mkdir(workConversations, { recursive: true });
      await writeFile(path.join(workConversations, "conv-move.db"), "", "utf8");
      await adapter.selectThreadAccount({
        threadId: "thread-9",
        accountId: "work",
        nativeSessionId: "conv-move",
      });
      expect(store.bindingForThread("thread-9")?.accountId).toBe("work");
      // The native owner follows the switch, so the next resume uses this credential.
      expect(store.accountForNativeSession("conv-move")?.id).toBe("work");
      // The default Account for new Threads is untouched by a Thread-scoped switch.
      expect(store.defaultAccount()?.id).toBe("default");
    } finally {
      await adapter.close();
    }
  });

  it("refuses to open a conversation another live Session already owns", async () => {
    const { realHome, cwd, store, environment } = await setup();
    const adapter = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
      {
        listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }),
        createTransport: () => fakeTransport("conv-leased"),
      },
    );
    const other = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
      {
        listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }),
        createTransport: () => fakeTransport("conv-leased"),
      },
    );
    try {
      const created = await adapter.open({
        kind: "create",
        cwd,
        environment: { CODEXHOST_THREAD_ID: "thread-lease" },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const nativeRef = created.value.initialState.nativeRef;
      if (!nativeRef) throw new Error("synthetic Session did not publish a Native Ref");
      const leaseFile = path.join(
        realHome,
        ".agy-accounts",
        "runtime",
        "leases",
        "conv-leased.lock",
      );
      expect(JSON.parse(await readFile(leaseFile, "utf8"))).toMatchObject({
        nativeSessionId: "conv-leased",
        generation: 1,
        state: "held",
      });

      // A second runtime (another Account or another Host) must be refused before
      // it can touch the same conversation files.
      const refused = await other.open({
        kind: "resume",
        cwd,
        nativeRef,
        environment: { CODEXHOST_THREAD_ID: "thread-lease-2" },
      });
      expect(refused).toMatchObject({
        ok: false,
        error: { code: "unavailable", retryable: true },
      });

      // Closing the Session hands the conversation over with a fresh generation.
      await created.value.close();
      expect(JSON.parse(await readFile(leaseFile, "utf8"))).toMatchObject({ state: "released" });
      const reopened = await other.open({
        kind: "resume",
        cwd,
        nativeRef,
        environment: { CODEXHOST_THREAD_ID: "thread-lease-2" },
      });
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) return;
      expect(JSON.parse(await readFile(leaseFile, "utf8"))).toMatchObject({
        generation: 2,
        state: "held",
      });
      await reopened.value.close();
    } finally {
      await adapter.close();
      await other.close();
    }
  });

  it("reads cached history from the native Session owner's account", async () => {
    const { realHome, cwd, store, environment } = await setup();
    await store.bindThread({
      threadId: "owner-thread",
      accountId: "work",
      nativeSessionId: "native-cache",
      state: "committed",
    });
    const baseEnvironment = {
      ...environment,
      CODEX_HOME: undefined,
      CODEXHOST_DATA_DIR: undefined,
    };
    const historyDirectory = path.join(
      realHome,
      ".codex",
      "codexhost-cache",
      "antigravity-history",
    );
    await mkdir(historyDirectory, { recursive: true });
    await writeFile(
      path.join(historyDirectory, "cache-thread.json"),
      `${JSON.stringify({
        formatVersion: 1,
        nativeSessionId: "native-cache",
        turns: [
          {
            nativeTurnRef: {
              harnessId: "antigravity",
              nativeSessionId: "native-cache",
              nativeTurnKey: "native-cache:turn:1",
              formatVersion: 1,
            },
            input: [{ type: "text", text: "cached" }],
            items: [],
            outcome: { status: "succeeded" },
          },
        ],
      })}\n`,
      "utf8",
    );
    const adapter = new AntigravityAdapter({
      accounts: { mode: "multi", store },
      manageDarwinKeychain: false,
      environment: baseEnvironment,
    });
    try {
      const result = await adapter.readCachedSnapshot({
        kind: "resume",
        cwd,
        environment: { ...baseEnvironment, CODEXHOST_THREAD_ID: "cache-thread" },
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: "antigravity",
          nativeSessionId: "native-cache",
          formatVersion: 1,
        }),
      });
      expect(result.ok).toBe(true);
      if (!result.ok || !result.value) throw new Error("Cached history was not returned");
      expect(result.value.turns[0]?.input[0]?.text).toBe("cached");
    } finally {
      await adapter.close();
    }
  });

  it("persists an exhausted account cooldown from the transport fault callback", async () => {
    const { cwd, store, environment } = await setup();
    let onFault: ((error: AntigravityTransportError) => void) | undefined;
    const adapter = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
      {
        listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }),
        createTransport: (options) => {
          onFault = options.onFault;
          return fakeTransport("conv-quota");
        },
      },
    );
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd,
        environment: { [ANTIGRAVITY_ACCOUNT_ID_ENV]: "work" },
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      onFault?.(
        new AntigravityTransportError("quotaExhausted", "quota exhausted", {
          diagnostic: "Resets in 2h48m22s",
        }),
      );
      await vi.waitFor(() => expect(store.get("work")?.state).toBe("cooldown"));
      const cooledAccount = store.get("work");
      if (!cooledAccount) throw new Error("Cooled account was not persisted");
      expect(store.isUsable(cooledAccount)).toBe(false);
      await opened.value.close();
    } finally {
      await adapter.close();
    }
  });

  it("loads quota snapshot from disk for custom accounts when available", async () => {
    const { store, realHome, environment } = await setup();
    const snapshotFile = path.join(realHome, ".agy-accounts", "work", "quota-snapshot.json");
    await mkdir(path.dirname(snapshotFile), { recursive: true });
    await writeFile(
      snapshotFile,
      JSON.stringify({
        usedPercent: 20,
        periodType: "five_hour",
      }),
      "utf8",
    );
    const adapter = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
      { listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }) },
    );
    try {
      const rows = await adapter.inspectAccounts();
      const workRow = rows?.find((r) => r.accountId === "work");
      expect(workRow?.credits?.usedPercent).toBe(20);
    } finally {
      await adapter.close();
    }
  });

  it("does not use the global quota files for a multi-account listing", async () => {
    const { store, environment } = await setup();
    const adapter = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
      { listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }) },
    );
    try {
      const rows = await adapter.inspectAccounts();
      expect(rows?.every((row) => row.credits === undefined)).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("rejects an account snapshot carrying another account's identity", async () => {
    const { store, realHome, environment } = await setup();
    await store.setEmail("work", "lucy@example.com");
    const snapshotFile = path.join(realHome, ".agy-accounts", "work", "quota-snapshot.json");
    await mkdir(path.dirname(snapshotFile), { recursive: true });
    await writeFile(
      snapshotFile,
      JSON.stringify({
        accountId: "work",
        email: "other@example.com",
        credits: { usedPercent: 20, periodType: "five_hour" },
      }),
      "utf8",
    );
    const adapter = new AntigravityAdapter(
      { accounts: { mode: "multi", store }, manageDarwinKeychain: false, environment },
      { listModels: async () => ({ stdout: MODELS_OUTPUT, stderr: "" }) },
    );
    try {
      const workRow = (await adapter.inspectAccounts())?.find((row) => row.accountId === "work");
      expect(workRow?.credits).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
});
