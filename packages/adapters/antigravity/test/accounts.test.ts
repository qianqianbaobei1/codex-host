import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_ACCOUNTS_DIR,
  AntigravityAccountStore,
  antigravityAccountKeychain,
  antigravityAccountsFile,
  applyAntigravityAccountEnvironment,
  createEmptyAccountsFile,
  ensureAntigravityShadowHome,
  loadAntigravityAccountsSync,
  resolveAntigravityHostAnchors,
} from "../src/accounts.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `codexhost-antigravity-${prefix}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Antigravity accounts loading", () => {
  it("treats a missing file as legacy mode (zero behaviour change)", async () => {
    const realHome = await makeRoot("legacy");
    const loaded = loadAntigravityAccountsSync({ environment: { HOME: realHome } });
    expect(loaded).toEqual({ mode: "legacy" });
  });

  it("fails closed on malformed JSON instead of falling back to the real HOME", async () => {
    const realHome = await makeRoot("badjson");
    await mkdir(path.join(realHome, ANTIGRAVITY_ACCOUNTS_DIR), { recursive: true });
    await writeFile(antigravityAccountsFile({ HOME: realHome }), "{ not json", "utf8");
    const loaded = loadAntigravityAccountsSync({ environment: { HOME: realHome } });
    expect(loaded.mode).toBe("invalid");
  });

  it.each([
    ["unsupported formatVersion", { formatVersion: 2, defaultAccountId: "a", accounts: [] }],
    [
      "duplicate account id",
      {
        formatVersion: 1,
        defaultAccountId: "a",
        accounts: [
          { id: "a", name: "A", enabled: true },
          { id: "a", name: "A2", enabled: true },
        ],
      },
    ],
    [
      "unknown default account",
      {
        formatVersion: 1,
        defaultAccountId: "nope",
        accounts: [{ id: "a", name: "A", enabled: true }],
      },
    ],
    [
      "filename-unsafe id",
      {
        formatVersion: 1,
        defaultAccountId: "a/b",
        accounts: [{ id: "a/b", name: "A", enabled: true }],
      },
    ],
    [
      "invalid state",
      {
        formatVersion: 1,
        defaultAccountId: "a",
        accounts: [{ id: "a", name: "A", enabled: true, state: "bogus" }],
      },
    ],
  ])("fails closed on %s", async (_label, value) => {
    const realHome = await makeRoot("invalid");
    await mkdir(path.join(realHome, ANTIGRAVITY_ACCOUNTS_DIR), { recursive: true });
    await writeFile(antigravityAccountsFile({ HOME: realHome }), JSON.stringify(value), "utf8");
    expect(loadAntigravityAccountsSync({ environment: { HOME: realHome } }).mode).toBe("invalid");
  });

  it("drops bindings that point at removed accounts instead of failing the whole file", async () => {
    const realHome = await makeRoot("dangling");
    const file = antigravityAccountsFile({ HOME: realHome });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        defaultAccountId: "default",
        accounts: [{ id: "default", name: "本机", legacy: true, enabled: true }],
        threadBindings: {
          "thread-1": { accountId: "gone", state: "committed", createdAt: "2026-01-01T00:00:00Z" },
          "thread-2": {
            accountId: "default",
            state: "committed",
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
        nativeSessionBindings: { "conv-1": "gone" },
      }),
      "utf8",
    );
    const loaded = loadAntigravityAccountsSync({ environment: { HOME: realHome } });
    expect(loaded.mode).toBe("multi");
    if (loaded.mode !== "multi") return;
    expect(loaded.store.bindingForThread("thread-1")).toBeNull();
    expect(loaded.store.bindingForThread("thread-2")?.accountId).toBe("default");
    expect(loaded.store.bindingForNativeSession("conv-1")).toBeNull();
  });
});

describe("Antigravity shadow HOME", () => {
  it("links the real HOME except .gemini and never creates a cycle through the shadow root", async () => {
    const realHome = await makeRoot("shadow");
    await mkdir(path.join(realHome, ".ssh"), { recursive: true });
    await writeFile(path.join(realHome, ".gitconfig"), "[user]\n", "utf8");
    await mkdir(path.join(realHome, ".gemini", "config"), { recursive: true });
    await writeFile(path.join(realHome, ".gemini", "config", "mcp_config.json"), "{}", "utf8");
    await mkdir(path.join(realHome, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(
      path.join(realHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      "token",
      "utf8",
    );
    await mkdir(path.join(realHome, "Library", "Keychains"), { recursive: true });
    await writeFile(path.join(realHome, "Library", "Keychains", "login.keychain-db"), "k", "utf8");
    await mkdir(path.join(realHome, "Library", "Caches"), { recursive: true });

    const shadowRoot = path.join(realHome, ANTIGRAVITY_ACCOUNTS_DIR);
    const shadowHome = path.join(shadowRoot, "work", "home");
    const report = await ensureAntigravityShadowHome({
      realHome,
      shadowHome,
      shadowRoot,
      createKeychain: async (file) => {
        await writeFile(file, "fake keychain", "utf8");
      },
      selectKeychain: async () => undefined,
    });

    expect(report.linked).toEqual(
      expect.arrayContaining([
        ".ssh",
        ".gitconfig",
        ".gemini/config",
        "Library/Caches",
        "Library/Keychains/login.keychain-db",
      ]),
    );
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        ".gemini",
        ".gemini/antigravity-cli",
        "Library",
        "Library/Keychains",
        ANTIGRAVITY_ACCOUNTS_DIR,
      ]),
    );
    expect(await readlink(path.join(shadowHome, ".ssh"))).toBe(path.join(realHome, ".ssh"));
    expect(await readlink(path.join(shadowHome, ".gemini", "config"))).toBe(
      path.join(realHome, ".gemini", "config"),
    );
    // The shadow root must never appear inside the shadow HOME.
    await expect(lstat(path.join(shadowHome, ANTIGRAVITY_ACCOUNTS_DIR))).rejects.toThrow();
    // The macOS keychain stays per account: a dedicated keychain prevents both
    // credential sharing and the blocking「找不到钥匙串」dialog.
    expect(
      await readFile(path.join(shadowHome, "Library", "Keychains", "login.keychain-db"), "utf8"),
    ).toBe("fake keychain");
    expect(await readlink(path.join(shadowHome, "Library", "Caches"))).toBe(
      path.join(realHome, "Library", "Caches"),
    );
    // antigravity-cli stays a real per-account directory.
    const cli = await lstat(path.join(shadowHome, ".gemini", "antigravity-cli"));
    expect(cli.isDirectory()).toBe(true);
    expect(cli.isSymbolicLink()).toBe(false);
    expect((await stat(shadowHome)).mode & 0o777).toBe(0o700);
  });

  it("tolerates a keychain that cannot be created", async () => {
    const realHome = await makeRoot("shadow-keychain-fail");
    const shadowRoot = path.join(realHome, ANTIGRAVITY_ACCOUNTS_DIR);
    const shadowHome = path.join(shadowRoot, "work", "home");
    const report = await ensureAntigravityShadowHome({
      realHome,
      shadowHome,
      shadowRoot,
      createKeychain: async () => {
        throw new Error("security unavailable");
      },
      selectKeychain: async () => undefined,
    });
    expect(report.skipped).toContain("Library/Keychains/login.keychain-db");
    expect((await stat(shadowHome)).mode & 0o777).toBe(0o700);
  });

  it("selects the account keychain inside the shadow HOME, never the real domain", async () => {
    const realHome = await makeRoot("shadow-select");
    const shadowRoot = path.join(realHome, ANTIGRAVITY_ACCOUNTS_DIR);
    const shadowHome = path.join(shadowRoot, "work", "home");
    const selected: Array<{ file: string; home: string }> = [];
    await ensureAntigravityShadowHome({
      realHome,
      shadowHome,
      shadowRoot,
      createKeychain: async (file) => {
        await writeFile(file, "fake keychain", "utf8");
      },
      selectKeychain: async (file, home) => {
        selected.push({ file, home });
      },
    });
    // `security` derives its keychain domain from $HOME, so every selection is
    // scoped by the account HOME. That is what lets one account run while
    // another account — or the real login keychain — stays usable.
    expect(selected).toEqual([{ file: antigravityAccountKeychain(shadowHome), home: shadowHome }]);
    expect(selected[0]?.home).not.toBe(realHome);
  });

  it("runs no keychain command at all when keychain management is disabled", async () => {
    const realHome = await makeRoot("shadow-no-keychain");
    const shadowRoot = path.join(realHome, ANTIGRAVITY_ACCOUNTS_DIR);
    const shadowHome = path.join(shadowRoot, "work", "home");
    const boom = async (): Promise<void> => {
      throw new Error("keychain command must not run");
    };
    const report = await ensureAntigravityShadowHome({
      realHome,
      shadowHome,
      shadowRoot,
      manageDarwinKeychain: false,
      createKeychain: boom,
      selectKeychain: boom,
    });
    expect(report.linked).not.toContain("Library/Keychains/login.keychain-db");
    expect(report.skipped).not.toContain("Library/Keychains/selection");
  });

  it("is idempotent and never clobbers existing entries", async () => {
    const realHome = await makeRoot("shadow-idempotent");
    await writeFile(path.join(realHome, ".gitconfig"), "[user]\n", "utf8");
    const shadowRoot = path.join(realHome, ANTIGRAVITY_ACCOUNTS_DIR);
    const shadowHome = path.join(shadowRoot, "work", "home");
    const createKeychain = async (file: string): Promise<void> => {
      await writeFile(file, "fake keychain", "utf8");
    };
    const selectKeychain = async (): Promise<void> => undefined;
    const options = { realHome, shadowHome, shadowRoot, createKeychain, selectKeychain };
    await ensureAntigravityShadowHome(options);
    await rm(path.join(shadowHome, ".gitconfig"));
    await writeFile(path.join(shadowHome, ".gitconfig"), "local override", "utf8");
    await ensureAntigravityShadowHome(options);
    expect(await readFile(path.join(shadowHome, ".gitconfig"), "utf8")).toBe("local override");
  });
});

describe("Antigravity account environment overlay", () => {
  const baseEnvironment: NodeJS.ProcessEnv = {
    HOME: "/Users/example",
    CODEX_HOME: "/Users/example/.codex",
    CODEXHOST_DATA_DIR: "/Users/example/.codexhost",
    CODEX_DELIVERY_ROOT: "/Users/example/PycharmProjects/codex",
    PATH: "/usr/bin",
  };

  it("returns the environment untouched for the legacy account", () => {
    const account = { id: "default", name: "本机", legacy: true, enabled: true };
    expect(applyAntigravityAccountEnvironment(baseEnvironment, account, "/Users/example")).toBe(
      baseEnvironment,
    );
  });

  it("moves HOME for a shadow account and restores the host anchors", () => {
    const account = { id: "work", name: "工作", enabled: true };
    const result = applyAntigravityAccountEnvironment(baseEnvironment, account, "/Users/example");
    expect(result.HOME).toBe(path.join("/Users/example", ANTIGRAVITY_ACCOUNTS_DIR, "work", "home"));
    expect(result.CODEX_HOME).toBe("/Users/example/.codex");
    expect(result.CODEXHOST_DATA_DIR).toBe("/Users/example/.codexhost");
    expect(result.CODEX_DELIVERY_ROOT).toBe("/Users/example/PycharmProjects/codex");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("materialises anchors when the host never set them explicitly", () => {
    const anchors = resolveAntigravityHostAnchors({ HOME: "/Users/example" });
    expect(anchors).toEqual({
      CODEX_HOME: "/Users/example/.codex",
      CODEXHOST_DATA_DIR: "/Users/example/.codex/codexhost-cache",
      CODEX_DELIVERY_ROOT: "/Users/example/PycharmProjects/codex",
    });
  });
});

describe("AntigravityAccountStore", () => {
  async function makeStore(): Promise<{
    store: AntigravityAccountStore;
    file: string;
    realHome: string;
  }> {
    const realHome = await makeRoot("store");
    const file = antigravityAccountsFile({ HOME: realHome });
    await mkdir(path.dirname(file), { recursive: true });
    const store = new AntigravityAccountStore({
      file,
      realHome,
      value: createEmptyAccountsFile({}),
    });
    return { store, file, realHome };
  }

  it("persists accounts with 0600 and reloads them", async () => {
    const { store, file, realHome } = await makeStore();
    await store.createAccount({ id: "work", name: "工作号" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const reloaded = loadAntigravityAccountsSync({ environment: { HOME: realHome } });
    expect(reloaded.mode).toBe("multi");
    if (reloaded.mode !== "multi") return;
    expect(
      reloaded.store
        .list()
        .map((account) => account.id)
        .sort(),
    ).toEqual(["default", "work"]);
    expect(reloaded.store.get("work")?.name).toBe("工作号");
  });

  it("resolves Thread binding, then native Session, then default", async () => {
    const { store } = await makeStore();
    await store.createAccount({ id: "work" });
    await store.bindThread({
      threadId: "thread-1",
      accountId: "work",
      nativeSessionId: "conv-1",
      state: "committed",
    });
    expect(store.resolveAccountForThread("thread-1").id).toBe("work");
    expect(store.accountForNativeSession("conv-1")?.id).toBe("work");
    expect(store.resolveAccountForThread("thread-unknown").id).toBe("default");
    expect(store.resolveAccountForThread(undefined).id).toBe("default");
  });

  it("persists quota cooldowns and skips exhausted accounts for new Threads", async () => {
    const { store } = await makeStore();
    await store.createAccount({ id: "work" });
    await store.markCooldown("default", new Date(Date.now() + 60_000).toISOString());

    const defaultAccount = store.get("default");
    if (!defaultAccount) throw new Error("Default account was not created");
    expect(store.isUsable(defaultAccount)).toBe(false);
    expect(store.firstAvailableAccount()?.id).toBe("work");

    const reloaded = loadAntigravityAccountsSync({ environment: { HOME: store.realHome } });
    expect(reloaded.mode).toBe("multi");
    if (reloaded.mode !== "multi") return;
    expect(reloaded.store.get("default")?.state).toBe("cooldown");
  });

  it("does not route an unbound Thread to an unavailable configured default", async () => {
    const { store } = await makeStore();
    await store.createAccount({ id: "work" });
    await store.setDefaultAccount("work");
    await store.markCooldown("work", new Date(Date.now() + 60_000).toISOString());

    expect(store.resolveAccountForThread("new-thread").id).toBe("default");
    await store.bindThread({
      threadId: "existing-thread",
      accountId: "work",
      nativeSessionId: "conv-work",
      state: "committed",
    });
    expect(store.resolveAccountForThread("existing-thread").id).toBe("work");
  });

  it("clears the login fuse after an explicit successful login", async () => {
    const { store } = await makeStore();
    await store.createAccount({ id: "work" });
    await store.markCooldown("work", new Date(Date.now() + 60_000).toISOString());
    await store.markReady("work");

    expect(store.get("work")).toMatchObject({ id: "work", enabled: true });
    expect(store.get("work")).not.toHaveProperty("state");
    expect(store.get("work")).not.toHaveProperty("cooldownUntil");
  });

  it("drops bindings when an account is removed and keeps the legacy account", async () => {
    const { store } = await makeStore();
    await store.createAccount({ id: "work" });
    await store.bindThread({
      threadId: "thread-1",
      accountId: "work",
      nativeSessionId: "conv-1",
      state: "committed",
    });
    await store.setDefaultAccount("work");
    await store.removeAccount("work");
    expect(store.bindingForThread("thread-1")).toBeNull();
    expect(store.bindingForNativeSession("conv-1")).toBeNull();
    expect(store.defaultAccount()?.id).toBe("default");
    await expect(store.removeAccount("default")).rejects.toThrow(/legacy/u);
  });

  it("picks up CLI edits without a Host restart", async () => {
    const { store, file } = await makeStore();
    await store.createAccount({ id: "work" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const value = JSON.parse(await readFile(file, "utf8")) as { defaultAccountId: string };
    value.defaultAccountId = "work";
    await writeFile(file, JSON.stringify(value, null, 2), "utf8");
    expect(store.defaultAccount()?.id).toBe("work");
    expect(store.resolveAccountForThread("thread-new").id).toBe("work");
  });

  it("keeps the last good state when the file becomes malformed", async () => {
    const { store, file } = await makeStore();
    await store.createAccount({ id: "work" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(file, "{ broken", "utf8");
    expect(
      store
        .list()
        .map((account) => account.id)
        .sort(),
    ).toEqual(["default", "work"]);
    expect(store.defaultAccount()?.id).toBe("default");
  });

  it("drops an account removed by the CLI", async () => {
    const { store, file } = await makeStore();
    await store.createAccount({ id: "work" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const value = JSON.parse(await readFile(file, "utf8")) as {
      accounts: Array<{ id: string }>;
    };
    value.accounts = value.accounts.filter((account) => account.id !== "work");
    await writeFile(file, JSON.stringify(value, null, 2), "utf8");
    expect(store.get("work")).toBeNull();
  });

  it("rejects filename-unsafe account ids", async () => {
    const { store } = await makeStore();
    await expect(store.createAccount({ id: "bad/id" })).rejects.toThrow(/filename-safe/u);
    await expect(store.createAccount({ id: ".." })).rejects.toThrow(/filename-safe/u);
  });

  it("maps the legacy account to the real HOME and others to the shadow root", async () => {
    const { store, realHome } = await makeStore();
    await store.createAccount({ id: "work" });
    const legacy = store.get("default");
    const work = store.get("work");
    expect(legacy && store.homeFor(legacy)).toBe(realHome);
    expect(work && store.homeFor(work)).toBe(
      path.join(realHome, ANTIGRAVITY_ACCOUNTS_DIR, "work", "home"),
    );
  });
});

describe("Antigravity account id grammar", () => {
  it("accepts the Codex AccountRepository id charset", () => {
    const pattern = /^(?!\.{1,2}$)[A-Za-z0-9._~-]+$/u;
    for (const id of ["default", "work-2", "a.b_c~d"]) expect(pattern.test(id)).toBe(true);
    for (const id of ["", "a b", "a/b", "..", ".", "账户"]) expect(pattern.test(id)).toBe(false);
  });
});
