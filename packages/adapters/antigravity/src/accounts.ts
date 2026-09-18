/**
 * Optional Antigravity multi-account overlay.
 *
 * Antigravity CLI (agy) keeps settings, cache, and conversations in
 * `$HOME/.gemini`, while OAuth identity is held by the operating-system
 * keyring. This module owns a shadow HOME plus the serialized keychain lease
 * needed to keep those two state sources aligned per account:
 *
 *   <realHome>/.agy-accounts/
 *   ├── accounts.json          metadata only; never credentials
 *   └── <accountId>/home/      shadow HOME (symlinks everything but .gemini)
 *       ├── Library/           real dir; children linked except Keychains
 *       │   └── Keychains      dedicated per-account keychain on Darwin
 *       └── .gemini/
 *           ├── config  -> <realHome>/.gemini/config    (shared)
 *           ├── skills  -> <realHome>/.gemini/skills    (shared)
 *           └── antigravity-cli/                        (per account: token, sessions)
 *
 * On macOS agy reads OAuth credentials from the operating-system keyring. A
 * shared keychain would make every account the same Google user, so Darwin
 * callers must acquire the account's dedicated keychain lease before starting
 * AGY. The shadow HOME still isolates AGY's settings, cache, and conversations;
 * it is not treated as proof of OAuth isolation by itself.
 *
 * Compatibility contract: when `accounts.json` is absent the overlay is inert.
 * `loadAntigravityAccountsSync` reports `legacy`, the adapter never resolves an
 * account, and `applyAntigravityAccountEnvironment` is never called.
 *
 * Failure contract: only a missing file means "not configured". A present but
 * malformed file is reported as `invalid` and callers must fail closed rather
 * than silently falling back to the real HOME.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  symlink,
  chmod,
  writeFile,
} from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  accountSessionStoreDirectory,
  ensureSharedSessionStoreLayout,
  sharedSessionStoreRoot,
  type AntigravitySharedSessionEntry,
} from "./session-store.js";

/** Root of the shadow layout, relative to the real HOME. */
export const ANTIGRAVITY_ACCOUNTS_DIR = ".agy-accounts";
/** Internal marker: the account resolved for the current Session. */
export const ANTIGRAVITY_ACCOUNT_ID_ENV = "CODEXHOST_ANTIGRAVITY_ACCOUNT_ID";
/** Host Thread id, present in every `OpenSessionInput.environment`. */
export const ANTIGRAVITY_THREAD_ID_ENV = "CODEXHOST_THREAD_ID";

/**
 * Keep aligned with the Codex AccountRepository account ID grammar
 * (`packages/host-runtime/src/account/account-repository.ts`). The rule is
 * copied rather than imported: this plugin must not depend on host-runtime.
 * Additionally reject `.`/`..`, which the Codex grammar allows but which would
 * let an account id escape the shadow root when used as a path segment.
 */
const ACCOUNT_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._~-]+$/u;
const THREAD_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

export type AntigravityAccountHealth = "ready" | "cooldown" | "needs_login" | "disabled";

export interface AntigravityAccount {
  id: string;
  name: string;
  email?: string;
  /** The legacy account keeps using the real HOME; its sessions never migrate. */
  legacy?: boolean;
  enabled: boolean;
  state?: AntigravityAccountHealth;
  cooldownUntil?: string;
}

export interface AntigravityThreadBinding {
  accountId: string;
  nativeSessionId?: string;
  /**
   * `reserved` means the account was chosen but no native Session exists yet,
   * so a pre-session failure may still re-route. `committed` is final.
   */
  state: "reserved" | "committed";
  createdAt: string;
}

export interface AntigravityAccountsFileV1 {
  formatVersion: 1;
  defaultAccountId: string;
  accounts: AntigravityAccount[];
  threadBindings: Record<string, AntigravityThreadBinding>;
  nativeSessionBindings: Record<string, string>;
}

export type AntigravityAccountsLoad =
  | { mode: "legacy" }
  | { mode: "multi"; store: AntigravityAccountStore }
  | { mode: "invalid"; error: Error };

export interface AntigravityHostAnchors {
  CODEX_HOME: string;
  CODEXHOST_DATA_DIR: string;
  CODEX_DELIVERY_ROOT: string;
}

export function isAntigravityAccountId(value: string): boolean {
  return ACCOUNT_ID_PATTERN.test(value);
}

export function antigravityRealHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.HOME?.trim() || os.homedir();
}

export function antigravityAccountsRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityRealHome(environment), ANTIGRAVITY_ACCOUNTS_DIR);
}

export function antigravityAccountsFile(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityAccountsRoot(environment), "accounts.json");
}

export function antigravityShadowHome(
  accountId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(antigravityAccountsRoot(environment), accountId, "home");
}

/**
 * Resolve the host-owned paths that must not drift when HOME is swapped for an
 * account. Values mirror the pre-overlay behaviour of `#inspectionCachePath`,
 * `ledger.dataDirectory`, `history-sidecar.historyRoot` and `command.ts`.
 */
export function resolveAntigravityHostAnchors(
  environment: NodeJS.ProcessEnv,
): AntigravityHostAnchors {
  const home = antigravityRealHome(environment);
  const codexHome = environment.CODEX_HOME?.trim() || path.join(home, ".codex");
  return {
    CODEX_HOME: codexHome,
    CODEXHOST_DATA_DIR:
      environment.CODEXHOST_DATA_DIR?.trim() || path.join(codexHome, "codexhost-cache"),
    CODEX_DELIVERY_ROOT:
      environment.CODEX_DELIVERY_ROOT?.trim() || path.join(home, "PycharmProjects", "codex"),
  };
}

/**
 * Point HOME at the account's shadow home while restoring the host anchors, so
 * only Antigravity moves. The legacy account is returned unchanged.
 */
export function applyAntigravityAccountEnvironment(
  environment: NodeJS.ProcessEnv,
  account: AntigravityAccount,
  realHome: string,
): NodeJS.ProcessEnv {
  if (account.legacy === true) return environment;
  const anchors = resolveAntigravityHostAnchors({ ...environment, HOME: realHome });
  return {
    ...environment,
    HOME: path.join(realHome, ANTIGRAVITY_ACCOUNTS_DIR, account.id, "home"),
    ...anchors,
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAncestorOrSelf(ancestor: string, candidate: string): boolean {
  return candidate === ancestor || candidate.startsWith(ancestor + path.sep);
}

function invalid(message: string): AntigravityAccountsLoad {
  return { mode: "invalid", error: new Error(message) };
}

export interface ShadowHomeReport {
  linked: string[];
  skipped: string[];
  /** Account keychains that existed but could not be opened, and were rebuilt. */
  repaired: string[];
  /**
   * Session-domain entries that still hold data in this HOME, so they must be
   * migrated before this Account can see every conversation. Provisioning never
   * moves them: linking a populated `conversations/` would orphan its Threads.
   */
  sessionStorePending?: AntigravitySharedSessionEntry[];
}

const execFileAsync = promisify(execFile);

/** Path of the keychain that belongs to one account's shadow HOME. */
export function antigravityAccountKeychain(shadowHome: string): string {
  return path.join(shadowHome, "Library", "Keychains", "login.keychain-db");
}

/**
 * macOS shows a blocking「找不到钥匙串」dialog when a process tries to store a
 * credential and no keychain exists at `$HOME/Library/Keychains`. Creating a
 * dedicated, unlocked, empty-password keychain per account keeps agy working
 * without a prompt and without reaching the shared login keychain.
 */
function darwinUserLoginKeychain(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityRealHome(environment), "Library", "Keychains", "login.keychain-db");
}

/**
 * Every keychain command runs with the account's HOME. `security` resolves the
 * user keychain domain from `$HOME/Library/Keychains`, so this keeps the whole
 * keychain world account-local and never touches the real user's settings.
 */
function keychainEnvironment(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home };
}

/**
 * Repair a user keychain list that an older build left pointing at an account
 * keychain. Accounts now keep their keychain inside their own HOME, so nothing
 * installs one globally any more; this remains as a one-way repair for machines
 * that ran the previous build.
 */
export function restoreDarwinUserKeychain(environment: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== "darwin") return;
  try {
    const realLogin = darwinUserLoginKeychain(environment);
    if (!existsSync(realLogin)) return;
    const rawDefault = execFileSync("security", ["default-keychain", "-d", "user"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const rawList = execFileSync("security", ["list-keychains", "-d", "user"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    })
      .split("\n")
      .map((l) => l.trim().replace(/^"|"$/gu, ""))
      .filter(Boolean);
    const filteredList = rawList.filter((p) => !p.includes(ANTIGRAVITY_ACCOUNTS_DIR));
    const sanitizedList = filteredList.length > 0 ? filteredList : [realLogin];
    if (rawDefault.includes(".agy-accounts") || !rawList.includes(realLogin)) {
      execFileSync("security", ["list-keychains", "-d", "user", "-s", ...sanitizedList], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      execFileSync("security", ["default-keychain", "-d", "user", "-s", realLogin], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    }
  } catch {
    // Ignore keychain query/restore errors
  }
}

/**
 * True when this account keychain opens with the empty password it is created with.
 *
 * `-p ""` is passed explicitly so a keychain that has a *different* password fails immediately
 * (errSecAuthFailed) instead of asking the user for one they cannot know. AGY reaches its
 * credential through this keychain with `go-keyring`, i.e. by running `/usr/bin/security`, which is
 * how a locked keychain turns into a recurring「unlock」dialog attributed to that CLI.
 */
async function darwinKeychainUnlocks(file: string, home: string): Promise<boolean> {
  const environment = keychainEnvironment(home);
  try {
    await execFileAsync("security", ["unlock-keychain", "-p", "", file], { env: environment });
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace an account keychain that can no longer be opened. Its content is AGY's per-account
 * credential, which AGY also keeps in `<shadowHome>/.gemini/antigravity-cli/antigravity-oauth-token`,
 * so a repair costs at most one account re-login — and never the user's real login keychain.
 */
async function recreateDarwinKeychain(file: string, home: string): Promise<void> {
  const environment = keychainEnvironment(home);
  await execFileAsync("security", ["delete-keychain", file], { env: environment }).catch(
    () => undefined,
  );
  await createDarwinKeychain(file, home);
}

async function createDarwinKeychain(file: string, home: string): Promise<void> {
  const environment = keychainEnvironment(home);
  // `-p ""` creates the keychain unlocked; `unlock-keychain -p ""` rejects the
  // empty passphrase on current macOS, so it must not be called.
  await execFileAsync("security", ["create-keychain", "-p", "", file], { env: environment });
  // Never auto-lock: a locked keychain would prompt again on the next write.
  await execFileAsync("security", ["set-keychain-settings", file], { env: environment }).catch(
    () => undefined,
  );
}

/** Point one HOME at its own keychain. Idempotent and free of global side effects. */
async function selectDarwinKeychain(file: string, home: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const environment = keychainEnvironment(home);
  await execFileAsync("security", ["list-keychains", "-d", "user", "-s", file], {
    env: environment,
  });
  await execFileAsync("security", ["default-keychain", "-d", "user", "-s", file], {
    env: environment,
  });
}

/**
 * Build (or repair) a shadow HOME. Everything in the real HOME is symlinked so
 * shell tools keep the user's git/ssh/gh/npm credentials, except:
 *  - `.gemini`, which is rebuilt per account (config/skills shared by link),
 *  - `Library/Keychains`, which is created per account and selected as that
 *    HOME's keychain domain,
 *  - any entry that would place the shadow root inside its own link target.
 * Idempotent: existing entries are left untouched.
 */
export async function ensureAntigravityShadowHome(input: {
  realHome: string;
  shadowHome: string;
  shadowRoot: string;
  /** Skip every keychain command; used by tests and by non-macOS hosts. */
  manageDarwinKeychain?: boolean;
  /** Test seam; defaults to `security create-keychain` on macOS. */
  createKeychain?: (file: string, home: string) => Promise<void>;
  /** Test seam; defaults to `security list-keychains/default-keychain`. */
  selectKeychain?: (file: string, home: string) => Promise<void>;
  /** Test seam; defaults to probing `security unlock-keychain -p ""` on macOS. */
  unlockKeychain?: (file: string, home: string) => Promise<boolean>;
  /** Test seam; defaults to `security delete-keychain` followed by a fresh create. */
  recreateKeychain?: (file: string, home: string) => Promise<void>;
}): Promise<ShadowHomeReport> {
  const realHome = path.resolve(input.realHome);
  const shadowHome = path.resolve(input.shadowHome);
  const shadowRoot = path.resolve(input.shadowRoot);
  await mkdir(path.join(shadowHome, ".gemini", "antigravity-cli"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(path.join(shadowHome, "Library"), { recursive: true, mode: 0o700 });
  const keychainDirectory = path.join(shadowHome, "Library", "Keychains");
  await mkdir(keychainDirectory, { recursive: true, mode: 0o700 });

  // Resolve AFTER creating the directories: on macOS `/var` is a symlink to
  // `/private/var`, so resolving first would compare a resolved source against
  // an unresolved shadow root and silently disable the cycle guard.
  const shadowRootReal = await realpath(shadowRoot).catch(() => shadowRoot);
  const shadowHomeReal = await realpath(shadowHome).catch(() => shadowHome);

  const linked: string[] = [];
  const skipped: string[] = [];
  const repaired: string[] = [];
  const linkChildren = async (
    source: string,
    destination: string,
    prefix: string,
    exclude: readonly string[],
  ): Promise<void> => {
    for (const entry of await readdir(source).catch(() => [] as string[])) {
      const label = `${prefix}${entry}`;
      if (exclude.includes(entry)) {
        skipped.push(label);
        continue;
      }
      const target = path.join(destination, entry);
      if (
        await lstat(target).then(
          () => true,
          () => false,
        )
      ) {
        skipped.push(label);
        continue;
      }
      await symlink(path.join(source, entry), target).then(
        () => linked.push(label),
        () => skipped.push(label),
      );
    }
  };

  const entries = await readdir(realHome).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry === ".gemini" || entry === "Library") {
      skipped.push(entry);
      continue;
    }
    const source = path.join(realHome, entry);
    const destination = path.join(shadowHome, entry);
    const sourceReal = await realpath(source).catch(() => source);
    if (
      isAncestorOrSelf(sourceReal, shadowRootReal) ||
      isAncestorOrSelf(sourceReal, shadowHomeReal) ||
      isAncestorOrSelf(shadowHomeReal, sourceReal)
    ) {
      skipped.push(entry);
      continue;
    }
    if (
      await lstat(destination).then(
        () => true,
        () => false,
      )
    ) {
      skipped.push(entry);
      continue;
    }
    await symlink(source, destination).then(
      () => linked.push(entry),
      () => skipped.push(entry),
    );
  }

  await linkChildren(path.join(realHome, ".gemini"), path.join(shadowHome, ".gemini"), ".gemini/", [
    "antigravity-cli",
  ]);
  // The macOS keychain is the credential agy actually reads, so it must stay
  // per account. It is intentionally not linked from the real HOME.
  await linkChildren(path.join(realHome, "Library"), path.join(shadowHome, "Library"), "Library/", [
    "Keychains",
  ]);

  // macOS shows a blocking「找不到钥匙串」dialog when agy stores a credential and
  // no keychain exists at `$HOME/Library/Keychains`. A dedicated per-account
  // keychain is prepared here and then selected as this HOME's keychain domain:
  // AGY resolves its keyring through `$HOME`, so the account keeps its own
  // credentials while other accounts — and the real login keychain — stay
  // untouched and usable at the same time.
  const keychainFile = antigravityAccountKeychain(shadowHome);
  const manageKeychain = input.manageDarwinKeychain !== false;
  if (
    !(await lstat(keychainFile).then(
      () => true,
      () => false,
    ))
  ) {
    const create =
      input.createKeychain ??
      (process.platform === "darwin" && manageKeychain
        ? createDarwinKeychain
        : async () => undefined);
    try {
      await create(keychainFile, shadowHome);
      linked.push("Library/Keychains/login.keychain-db");
    } catch {
      skipped.push("Library/Keychains/login.keychain-db");
    }
  } else {
    // A keychain that exists but cannot be opened with its own (empty) password is unusable and
    // asks the user for a password on every AGY credential call, forever. Rebuild it instead:
    // silently leaving that state is what made the prompts look like an unrelated macOS problem.
    const unlock =
      input.unlockKeychain ?? (process.platform === "darwin" ? darwinKeychainUnlocks : null);
    const recreate =
      input.recreateKeychain ??
      (process.platform === "darwin" && manageKeychain
        ? recreateDarwinKeychain
        : async () => undefined);
    if (unlock && !(await unlock(keychainFile, shadowHome).catch(() => false))) {
      try {
        await recreate(keychainFile, shadowHome);
        repaired.push("Library/Keychains/login.keychain-db");
      } catch {
        skipped.push("Library/Keychains/login.keychain-db");
      }
    }
  }
  if (manageKeychain) {
    const select = input.selectKeychain ?? selectDarwinKeychain;
    await select(keychainFile, shadowHome).catch(() => {
      skipped.push("Library/Keychains/selection");
    });
  }

  // A conversation belongs to the Session, not to the Account, so every Account
  // reaches the same canonical session store. Only entries that cannot lose data
  // adopt the layout here; a populated entry is reported and left untouched for
  // the offline migration (`antigravity-shared-store.mjs`).
  const sessionStore = ensureSharedSessionStoreLayout({
    storeDir: accountSessionStoreDirectory(shadowHome),
    sharedRoot: sharedSessionStoreRoot(shadowRoot),
  });
  for (const entry of sessionStore.linked) linked.push(`.gemini/antigravity-cli/${entry}`);
  for (const entry of sessionStore.pending)
    skipped.push(`.gemini/antigravity-cli/${entry} (migrate)`);

  await chmod(shadowHome, 0o700).catch(() => undefined);
  return {
    linked,
    skipped,
    repaired,
    ...(sessionStore.pending.length > 0 ? { sessionStorePending: sessionStore.pending } : {}),
  };
}

export function loadAntigravityAccountsSync(
  input: {
    environment?: NodeJS.ProcessEnv;
    file?: string;
  } = {},
): AntigravityAccountsLoad {
  const environment = input.environment ?? process.env;
  if (process.platform === "darwin") {
    restoreDarwinUserKeychain(environment);
  }
  const realHome = antigravityRealHome(environment);
  const file = input.file ?? antigravityAccountsFile(environment);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { mode: "legacy" };
    return invalid(`Antigravity accounts file is unreadable: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid(`Antigravity accounts file is not valid JSON: ${file}`);
  }
  const validated = validateAccountsFile(parsed);
  if (!validated.ok)
    return invalid(`Antigravity accounts file is invalid (${validated.reason}): ${file}`);
  return {
    mode: "multi",
    store: new AntigravityAccountStore({ file, realHome, value: validated.value }),
  };
}

type ValidationResult =
  { ok: true; value: AntigravityAccountsFileV1 } | { ok: false; reason: string };

function validateAccountsFile(parsed: unknown): ValidationResult {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "root is not an object" };
  }
  const value = parsed as Record<string, unknown>;
  if (value.formatVersion !== 1) return { ok: false, reason: "unsupported formatVersion" };
  if (!Array.isArray(value.accounts) || value.accounts.length === 0) {
    return { ok: false, reason: "accounts must be a non-empty array" };
  }

  const accounts: AntigravityAccount[] = [];
  const seen = new Set<string>();
  for (const entry of value.accounts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: "account entry is not an object" };
    }
    const account = entry as Record<string, unknown>;
    const id = account.id;
    if (typeof id !== "string" || !ACCOUNT_ID_PATTERN.test(id)) {
      return { ok: false, reason: "account id is not filename-safe" };
    }
    if (seen.has(id)) return { ok: false, reason: `duplicate account id '${id}'` };
    seen.add(id);
    if (typeof account.name !== "string" || account.name.trim().length === 0) {
      return { ok: false, reason: `account '${id}' has no name` };
    }
    if (typeof account.enabled !== "boolean") {
      return { ok: false, reason: `account '${id}' has no enabled flag` };
    }
    if (account.legacy !== undefined && typeof account.legacy !== "boolean") {
      return { ok: false, reason: `account '${id}' has an invalid legacy flag` };
    }
    if (
      account.state !== undefined &&
      account.state !== "ready" &&
      account.state !== "cooldown" &&
      account.state !== "needs_login" &&
      account.state !== "disabled"
    ) {
      return { ok: false, reason: `account '${id}' has an invalid state` };
    }
    if (account.cooldownUntil !== undefined && typeof account.cooldownUntil !== "string") {
      return { ok: false, reason: `account '${id}' has an invalid cooldownUntil` };
    }
    if (account.email !== undefined && typeof account.email !== "string") {
      return { ok: false, reason: `account '${id}' has an invalid email` };
    }
    accounts.push({
      id,
      name: account.name,
      enabled: account.enabled,
      ...(account.legacy === true ? { legacy: true } : {}),
      ...(typeof account.email === "string" ? { email: account.email } : {}),
      ...(typeof account.state === "string" ? { state: account.state } : {}),
      ...(typeof account.cooldownUntil === "string"
        ? { cooldownUntil: account.cooldownUntil }
        : {}),
    });
  }

  const defaultAccountId = value.defaultAccountId;
  if (typeof defaultAccountId !== "string" || !seen.has(defaultAccountId)) {
    return { ok: false, reason: "defaultAccountId does not reference a known account" };
  }

  const threadBindings: Record<string, AntigravityThreadBinding> = {};
  const rawBindings = value.threadBindings;
  if (rawBindings !== undefined) {
    if (!rawBindings || typeof rawBindings !== "object" || Array.isArray(rawBindings)) {
      return { ok: false, reason: "threadBindings is not an object" };
    }
    for (const [threadId, entry] of Object.entries(rawBindings as Record<string, unknown>)) {
      if (!THREAD_ID_PATTERN.test(threadId)) continue;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const binding = entry as Record<string, unknown>;
      const accountId = binding.accountId;
      // A binding for a removed account is dropped, not fatal.
      if (typeof accountId !== "string" || !seen.has(accountId)) continue;
      if (binding.state !== "reserved" && binding.state !== "committed") continue;
      threadBindings[threadId] = {
        accountId,
        state: binding.state,
        ...(typeof binding.nativeSessionId === "string"
          ? { nativeSessionId: binding.nativeSessionId }
          : {}),
        createdAt:
          typeof binding.createdAt === "string" ? binding.createdAt : new Date().toISOString(),
      };
    }
  }

  const nativeSessionBindings: Record<string, string> = {};
  const rawNative = value.nativeSessionBindings;
  if (rawNative !== undefined) {
    if (!rawNative || typeof rawNative !== "object" || Array.isArray(rawNative)) {
      return { ok: false, reason: "nativeSessionBindings is not an object" };
    }
    for (const [nativeSessionId, accountId] of Object.entries(
      rawNative as Record<string, unknown>,
    )) {
      if (typeof accountId !== "string" || !seen.has(accountId)) continue;
      nativeSessionBindings[nativeSessionId] = accountId;
    }
  }

  return {
    ok: true,
    value: {
      formatVersion: 1,
      defaultAccountId,
      accounts,
      threadBindings,
      nativeSessionBindings,
    },
  };
}

export class AntigravityAccountStore {
  readonly #file: string;
  readonly #realHome: string;
  readonly #accounts = new Map<string, AntigravityAccount>();
  readonly #threadBindings = new Map<string, AntigravityThreadBinding>();
  readonly #nativeSessionBindings = new Map<string, string>();
  readonly #shadowReady = new Set<string>();
  #defaultAccountId = "";
  #fingerprint: { mtimeMs: number; size: number } | null = null;
  #mutationsPending = 0;
  #mutationTail: Promise<unknown> = Promise.resolve();
  #writeTail: Promise<unknown> = Promise.resolve();

  constructor(input: { file: string; realHome: string; value: AntigravityAccountsFileV1 }) {
    this.#file = input.file;
    this.#realHome = path.resolve(input.realHome);
    this.#apply(input.value);
    this.#fingerprint = fingerprintOf(input.file);
  }

  #apply(value: AntigravityAccountsFileV1): void {
    this.#accounts.clear();
    this.#threadBindings.clear();
    this.#nativeSessionBindings.clear();
    this.#defaultAccountId = value.defaultAccountId;
    for (const account of value.accounts) this.#accounts.set(account.id, { ...account });
    for (const [threadId, binding] of Object.entries(value.threadBindings)) {
      this.#threadBindings.set(threadId, { ...binding });
    }
    for (const [nativeSessionId, accountId] of Object.entries(value.nativeSessionBindings)) {
      this.#nativeSessionBindings.set(nativeSessionId, accountId);
    }
  }

  /**
   * Pick up edits made by the account CLI without restarting the Host. A file
   * that becomes unreadable or malformed keeps the last good state: a mid-flight
   * edit must not break running Sessions.
   */
  #reloadIfChanged(): void {
    if (this.#mutationsPending > 0) return;
    const current = fingerprintOf(this.#file);
    if (!current) return;
    if (
      this.#fingerprint &&
      current.mtimeMs === this.#fingerprint.mtimeMs &&
      current.size === this.#fingerprint.size
    ) {
      return;
    }
    this.#fingerprint = current;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#file, "utf8"));
    } catch {
      return;
    }
    const validated = validateAccountsFile(parsed);
    if (validated.ok) this.#apply(validated.value);
  }

  get file(): string {
    return this.#file;
  }

  get realHome(): string {
    return this.#realHome;
  }

  get shadowRoot(): string {
    return path.join(this.#realHome, ANTIGRAVITY_ACCOUNTS_DIR);
  }

  list(): AntigravityAccount[] {
    this.#reloadIfChanged();
    return [...this.#accounts.values()].map((account) => ({ ...account }));
  }

  get(accountId: string): AntigravityAccount | null {
    this.#reloadIfChanged();
    const account = this.#accounts.get(accountId);
    return account ? { ...account } : null;
  }

  /** Whether a new Session may be assigned to this account right now. */
  isUsable(account: AntigravityAccount, now = Date.now()): boolean {
    if (!account.enabled || account.state === "disabled" || account.state === "needs_login") {
      return false;
    }
    if (account.state !== "cooldown") return true;
    const until = account.cooldownUntil ? Date.parse(account.cooldownUntil) : Number.NaN;
    return Number.isFinite(until) && until <= now;
  }

  /** Pick a healthy account for a brand-new Thread without reusing an exhausted one. */
  firstAvailableAccount(now = Date.now()): AntigravityAccount | null {
    this.#reloadIfChanged();
    const preferred = this.#accounts.get(this.#defaultAccountId);
    const account =
      (preferred && this.isUsable(preferred, now) ? preferred : undefined) ??
      [...this.#accounts.values()].find((candidate) => this.isUsable(candidate, now));
    return account ? { ...account } : null;
  }

  defaultAccount(): AntigravityAccount | null {
    this.#reloadIfChanged();
    return this.get(this.#defaultAccountId);
  }

  homeFor(account: AntigravityAccount): string {
    return account.legacy === true
      ? this.#realHome
      : path.join(this.shadowRoot, account.id, "home");
  }

  bindingForThread(threadId: string): AntigravityThreadBinding | null {
    this.#reloadIfChanged();
    const binding = this.#threadBindings.get(threadId);
    return binding ? { ...binding } : null;
  }

  bindingForNativeSession(nativeSessionId: string): AntigravityAccount | null {
    this.#reloadIfChanged();
    const accountId = this.#nativeSessionBindings.get(nativeSessionId);
    return accountId ? this.get(accountId) : null;
  }

  /**
   * Resolution order for an existing Thread: explicit binding, then the native
   * Session it points at. New/unbound Threads prefer an available account so a
   * stale default cannot trigger repeated authentication attempts.
   */
  resolveAccountForThread(threadId: string | undefined): AntigravityAccount {
    this.#reloadIfChanged();
    if (threadId) {
      const binding = this.#threadBindings.get(threadId);
      if (binding) {
        const bound = this.#accounts.get(binding.accountId);
        if (bound) return { ...bound };
      }
      if (binding?.nativeSessionId) {
        const byNative = this.bindingForNativeSession(binding.nativeSessionId);
        if (byNative) return byNative;
      }
    }
    return this.firstAvailableAccount() ?? this.defaultAccount() ?? this.#firstEnabledAccount();
  }

  accountForNativeSession(nativeSessionId: string): AntigravityAccount | null {
    this.#reloadIfChanged();
    return this.bindingForNativeSession(nativeSessionId);
  }

  async ensureHome(
    account: AntigravityAccount,
    options: { manageDarwinKeychain?: boolean } = {},
  ): Promise<string> {
    const home = this.homeFor(account);
    if (account.legacy === true || this.#shadowReady.has(account.id)) return home;
    await ensureAntigravityShadowHome({
      realHome: this.#realHome,
      shadowHome: home,
      shadowRoot: this.shadowRoot,
      ...(options.manageDarwinKeychain === false ? { manageDarwinKeychain: false } : {}),
    });
    this.#shadowReady.add(account.id);
    return home;
  }

  async bindThread(input: {
    threadId: string;
    accountId: string;
    nativeSessionId?: string;
    state: AntigravityThreadBinding["state"];
  }): Promise<void> {
    if (!THREAD_ID_PATTERN.test(input.threadId)) {
      throw new Error(`Antigravity Thread id is not filename-safe: '${input.threadId}'`);
    }
    if (!this.#accounts.has(input.accountId)) {
      throw new Error(`Unknown Antigravity account '${input.accountId}'`);
    }
    await this.#mutate(async () => {
      const previous = this.#threadBindings.get(input.threadId);
      this.#threadBindings.set(input.threadId, {
        accountId: input.accountId,
        state: input.state,
        ...(input.nativeSessionId
          ? { nativeSessionId: input.nativeSessionId }
          : previous?.nativeSessionId
            ? { nativeSessionId: previous.nativeSessionId }
            : {}),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
      });
      if (input.nativeSessionId) {
        this.#nativeSessionBindings.set(input.nativeSessionId, input.accountId);
      }
      await this.#persist();
    });
  }

  async commitThread(input: { threadId: string; nativeSessionId: string }): Promise<void> {
    const binding = this.#threadBindings.get(input.threadId);
    if (!binding) return;
    await this.bindThread({
      threadId: input.threadId,
      accountId: binding.accountId,
      nativeSessionId: input.nativeSessionId,
      state: "committed",
    });
  }

  /**
   * Record which Account owns an existing native conversation, without inventing
   * a Thread for it. Used by the shared-store migration, which is the last moment
   * at which the owning Account is still knowable from disk.
   */
  async recordNativeSessionOwner(input: {
    nativeSessionId: string;
    accountId: string;
  }): Promise<void> {
    if (!this.#accounts.has(input.accountId)) {
      throw new Error(`Unknown Antigravity account '${input.accountId}'`);
    }
    if (!input.nativeSessionId.trim()) return;
    await this.#mutate(async () => {
      this.#nativeSessionBindings.set(input.nativeSessionId, input.accountId);
      await this.#persist();
    });
  }

  async createAccount(input: {
    id: string;
    name?: string;
    legacy?: boolean;
  }): Promise<AntigravityAccount> {
    if (!ACCOUNT_ID_PATTERN.test(input.id)) {
      throw new Error("Antigravity account id must be filename-safe");
    }
    if (this.#accounts.has(input.id)) {
      throw new Error(`Antigravity account '${input.id}' already exists`);
    }
    if (input.legacy === true && this.#legacyAccount()) {
      throw new Error("An Antigravity legacy account already exists");
    }
    const account: AntigravityAccount = {
      id: input.id,
      name: input.name?.trim() || input.id,
      enabled: true,
      ...(input.legacy === true ? { legacy: true } : {}),
    };
    await this.#mutate(async () => {
      this.#accounts.set(account.id, account);
      await this.#persist();
    });
    return { ...account };
  }

  async removeAccount(accountId: string): Promise<AntigravityAccount> {
    const account = this.#accounts.get(accountId);
    if (!account) throw new Error(`Unknown Antigravity account '${accountId}'`);
    if (account.legacy === true)
      throw new Error("The legacy Antigravity account cannot be removed");
    return this.#mutate(async () => {
      this.#accounts.delete(accountId);
      for (const [threadId, binding] of this.#threadBindings) {
        if (binding.accountId === accountId) this.#threadBindings.delete(threadId);
      }
      for (const [nativeSessionId, bound] of this.#nativeSessionBindings) {
        if (bound === accountId) this.#nativeSessionBindings.delete(nativeSessionId);
      }
      if (this.#defaultAccountId === accountId) {
        this.#defaultAccountId = this.#legacyAccount()?.id ?? this.#firstEnabledAccount().id;
      }
      await this.#persist();
      return { ...account };
    });
  }

  async setDefaultAccount(accountId: string): Promise<void> {
    if (!this.#accounts.has(accountId))
      throw new Error(`Unknown Antigravity account '${accountId}'`);
    await this.#mutate(async () => {
      this.#defaultAccountId = accountId;
      await this.#persist();
    });
  }

  async setEmail(accountId: string, email: string): Promise<void> {
    const account = this.#accounts.get(accountId);
    if (!account) throw new Error(`Unknown Antigravity account '${accountId}'`);
    if (account.email === email) return;
    await this.#mutate(async () => {
      account.email = email;
      await this.#persist();
    });
  }

  async setEnabled(accountId: string, enabled: boolean): Promise<void> {
    const account = this.#accounts.get(accountId);
    if (!account) throw new Error(`Unknown Antigravity account '${accountId}'`);
    await this.#mutate(async () => {
      this.#accounts.set(accountId, { ...account, enabled });
      await this.#persist();
    });
  }

  async markCooldown(accountId: string, cooldownUntil: string): Promise<void> {
    const account = this.#accounts.get(accountId);
    if (!account) throw new Error(`Unknown Antigravity account '${accountId}'`);
    await this.#mutate(async () => {
      this.#accounts.set(accountId, {
        ...account,
        state: "cooldown",
        cooldownUntil,
      });
      await this.#persist();
    });
  }

  async markReady(accountId: string): Promise<void> {
    const account = this.#accounts.get(accountId);
    if (!account) throw new Error(`Unknown Antigravity account '${accountId}'`);
    await this.#mutate(async () => {
      const next = { ...account };
      delete next.state;
      delete next.cooldownUntil;
      this.#accounts.set(accountId, next);
      await this.#persist();
    });
  }

  snapshot(): AntigravityAccountsFileV1 {
    this.#reloadIfChanged();
    return {
      formatVersion: 1,
      defaultAccountId: this.#defaultAccountId,
      accounts: [...this.#accounts.values()].map((account) => ({ ...account })),
      threadBindings: Object.fromEntries(
        [...this.#threadBindings.entries()].map(([threadId, binding]) => [
          threadId,
          { ...binding },
        ]),
      ),
      nativeSessionBindings: Object.fromEntries(this.#nativeSessionBindings.entries()),
    };
  }

  #legacyAccount(): AntigravityAccount | undefined {
    return [...this.#accounts.values()].find((account) => account.legacy === true);
  }

  #firstEnabledAccount(): AntigravityAccount {
    const enabled = [...this.#accounts.values()].find((account) => account.enabled);
    const fallback = enabled ?? this.#legacyAccount() ?? [...this.#accounts.values()][0];
    if (!fallback) throw new Error("Antigravity accounts file has no usable account");
    return { ...fallback };
  }

  #persist(): Promise<void> {
    const value = this.snapshot();
    const operation = this.#writeTail.then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#file);
      this.#fingerprint = fingerprintOf(this.#file);
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.#mutationsPending += 1;
      try {
        return await operation();
      } finally {
        this.#mutationsPending -= 1;
      }
    };
    const pending = this.#mutationTail.then(run);
    this.#mutationTail = pending.catch(() => undefined);
    return pending;
  }
}

function fingerprintOf(file: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = statSync(file);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

/** Create a store for a brand-new accounts file (used by the account CLI). */
export function createEmptyAccountsFile(input: {
  legacyAccountId?: string;
  legacyAccountName?: string;
}): AntigravityAccountsFileV1 {
  const id = input.legacyAccountId ?? "default";
  return {
    formatVersion: 1,
    defaultAccountId: id,
    accounts: [{ id, name: input.legacyAccountName ?? "本机登录", legacy: true, enabled: true }],
    threadBindings: {},
    nativeSessionBindings: {},
  };
}
