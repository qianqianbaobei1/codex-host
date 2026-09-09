/**
 * Optional Antigravity multi-account overlay.
 *
 * Antigravity CLI (agy) keeps its identity in `$HOME/.gemini`, so one isolated
 * HOME per account yields one isolated account. This module owns that layout:
 *
 *   <realHome>/.agy-accounts/
 *   ├── accounts.json          metadata only; never credentials
 *   └── <accountId>/home/      shadow HOME (symlinks everything but .gemini)
 *       ├── Library/           real dir; children linked except Keychains
 *       │   └── Keychains      intentionally absent: agy then uses the file token
 *       └── .gemini/
 *           ├── config  -> <realHome>/.gemini/config    (shared)
 *           ├── skills  -> <realHome>/.gemini/skills    (shared)
 *           └── antigravity-cli/                        (per account: token, sessions)
 *
 * On macOS agy reads its OAuth credential from `$HOME/Library/Keychains`, so a
 * shared keychain would make every account the same Google user. Excluding the
 * keychain makes agy fall back to `<account>/home/.gemini/antigravity-cli/
 * antigravity-oauth-token`, which is per account.
 *
 * Compatibility contract: when `accounts.json` is absent the overlay is inert.
 * `loadAntigravityAccountsSync` reports `legacy`, the adapter never resolves an
 * account, and `applyAntigravityAccountEnvironment` is never called.
 *
 * Failure contract: only a missing file means "not configured". A present but
 * malformed file is reported as `invalid` and callers must fail closed rather
 * than silently falling back to the real HOME.
 */
import { readFileSync, statSync } from "node:fs";
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
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

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
}

/**
 * Build (or repair) a shadow HOME. Everything in the real HOME is symlinked so
 * shell tools keep the user's git/ssh/gh/npm credentials, except:
 *  - `.gemini`, which is rebuilt per account (config/skills shared by link),
 *  - `Library/Keychains`, which must stay per account or every account would
 *    resolve the same macOS keychain credential,
 *  - any entry that would place the shadow root inside its own link target.
 * Idempotent: existing entries are left untouched.
 */
export async function ensureAntigravityShadowHome(input: {
  realHome: string;
  shadowHome: string;
  shadowRoot: string;
}): Promise<ShadowHomeReport> {
  const realHome = path.resolve(input.realHome);
  const shadowHome = path.resolve(input.shadowHome);
  const shadowRoot = path.resolve(input.shadowRoot);
  await mkdir(path.join(shadowHome, ".gemini", "antigravity-cli"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(path.join(shadowHome, "Library"), { recursive: true, mode: 0o700 });

  // Resolve AFTER creating the directories: on macOS `/var` is a symlink to
  // `/private/var`, so resolving first would compare a resolved source against
  // an unresolved shadow root and silently disable the cycle guard.
  const shadowRootReal = await realpath(shadowRoot).catch(() => shadowRoot);
  const shadowHomeReal = await realpath(shadowHome).catch(() => shadowHome);

  const linked: string[] = [];
  const skipped: string[] = [];
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
  // per account; without it agy falls back to the per-account token file.
  await linkChildren(path.join(realHome, "Library"), path.join(shadowHome, "Library"), "Library/", [
    "Keychains",
  ]);

  await chmod(shadowHome, 0o700).catch(() => undefined);
  return { linked, skipped };
}

export function loadAntigravityAccountsSync(
  input: {
    environment?: NodeJS.ProcessEnv;
    file?: string;
  } = {},
): AntigravityAccountsLoad {
  const environment = input.environment ?? process.env;
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
    accounts.push({
      id,
      name: account.name,
      enabled: account.enabled,
      ...(account.legacy === true ? { legacy: true } : {}),
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
   * Session it points at, then the configured default.
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
    return this.defaultAccount() ?? this.#firstEnabledAccount();
  }

  accountForNativeSession(nativeSessionId: string): AntigravityAccount | null {
    this.#reloadIfChanged();
    return this.bindingForNativeSession(nativeSessionId);
  }

  async ensureHome(account: AntigravityAccount): Promise<string> {
    const home = this.homeFor(account);
    if (account.legacy === true || this.#shadowReady.has(account.id)) return home;
    await ensureAntigravityShadowHome({
      realHome: this.#realHome,
      shadowHome: home,
      shadowRoot: this.shadowRoot,
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

  async setEnabled(accountId: string, enabled: boolean): Promise<void> {
    const account = this.#accounts.get(accountId);
    if (!account) throw new Error(`Unknown Antigravity account '${accountId}'`);
    await this.#mutate(async () => {
      this.#accounts.set(accountId, { ...account, enabled });
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
