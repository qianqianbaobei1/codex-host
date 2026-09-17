/**
 * Session store layout: what a conversation *is* versus what an Account owns.
 *
 * AGY keeps conversation facts (the trajectory database, its brain, annotations
 * and the per-Session presence lock) next to Account-scoped state under one
 * `.gemini/antigravity-cli` directory. That layout is what makes a conversation
 * belong to an Account, and it is the reason a historical Thread cannot switch
 * Account: the other Account cannot see the files.
 *
 * This module owns the fix — a single canonical session store shared by every
 * Account, reached through directory symlinks — plus the offline migration that
 * moves existing data into it. Directory symlinks (never hard links) keep one
 * canonical path, so SQLite's `-wal`/`-shm` resolve to the same real files.
 *
 * Nothing here touches a store that still holds data: linking such an entry
 * would orphan its conversations. It reports `pending` instead.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** Entries that describe a conversation and therefore belong to the Session. */
export const ANTIGRAVITY_SHARED_SESSION_ENTRIES = [
  "conversations",
  "brain",
  "annotations",
  "presence",
] as const;

export type AntigravitySharedSessionEntry = (typeof ANTIGRAVITY_SHARED_SESSION_ENTRIES)[number];

/**
 * Account-scoped entries. Credentials and account-level server state must stay
 * per Account; `conversation_summaries.db` and `history.jsonl` are *derived*
 * indexes over the session store — AGY rebuilds them from `conversations/`
 * (verified: an empty index is re-reconciled on open), so sharing them would
 * only create two writers for one file.
 */
export const ANTIGRAVITY_ACCOUNT_LOCAL_ENTRIES = [
  "cache",
  "log",
  "crashes",
  "updater",
  "bin",
  "builtin",
  "implicit",
  "knowledge",
  "plugin_data",
  "settings.json",
  "installation_id",
  "jetski_state.pbtxt",
  "history.jsonl",
  "conversation_summaries.db",
  "jetbox_summaries_proto.pb",
] as const;

export const SHARED_SESSION_STORE_DIRECTORY = "shared";
export const SESSION_STORE_MIGRATION_DIRECTORY = "session-store-migration";
export const SHARED_SESSION_STORE_PREFIX = "antigravity-cli";
export const SESSION_STORE_MIGRATION_FORMAT_VERSION = 1;

/** `<accountsRoot>/shared/antigravity-cli` — the one canonical session store. */
export function sharedSessionStoreRoot(accountsRoot: string): string {
  return path.join(accountsRoot, SHARED_SESSION_STORE_DIRECTORY, SHARED_SESSION_STORE_PREFIX);
}

/** `<home>/.gemini/antigravity-cli` — what AGY itself uses for one Account. */
export function accountSessionStoreDirectory(home: string): string {
  return path.join(home, ".gemini", SHARED_SESSION_STORE_PREFIX);
}

export interface AntigravitySessionStoreLocation {
  accountId: string;
  accountHome: string;
  storeDir: string;
}

export type SessionStoreEntryKind = "shared" | "absent" | "empty" | "local" | "foreign-link";

export interface SessionStoreEntryState {
  entry: AntigravitySharedSessionEntry;
  kind: SessionStoreEntryKind;
  /** Where the entry lives today. */
  path: string;
  /** Where the entry must ultimately live. */
  shared: string;
  /** Symlink target, present only for `shared`/`foreign-link`. */
  linkTarget?: string;
  /** Payload count for `local`. */
  items?: number;
}

function entryPath(storeDir: string, entry: AntigravitySharedSessionEntry): string {
  return path.join(storeDir, entry);
}

function readLinkSyncOrNull(target: string): string | null {
  try {
    return readlinkSync(target);
  } catch {
    return null;
  }
}

/** Read-only layout inspection. Never creates, links, or deletes anything. */
export function inspectSessionStoreLayout(input: {
  storeDir: string;
  sharedRoot: string;
}): SessionStoreEntryState[] {
  return ANTIGRAVITY_SHARED_SESSION_ENTRIES.map((entry) => {
    const target = entryPath(input.storeDir, entry);
    const shared = path.join(input.sharedRoot, entry);
    const link = readLinkSyncOrNull(target);
    if (link !== null) {
      const resolved = path.resolve(input.storeDir, link);
      return path.resolve(shared) === resolved
        ? { entry, kind: "shared", path: target, shared, linkTarget: link }
        : { entry, kind: "foreign-link", path: target, shared, linkTarget: link };
    }
    const stats = statSync(target, { throwIfNoEntry: false });
    if (!stats) return { entry, kind: "absent", path: target, shared };
    if (!stats.isDirectory()) return { entry, kind: "local", path: target, shared, items: 1 };
    const items = readdirSync(target).filter((name) => !name.startsWith(".")).length;
    return items === 0
      ? { entry, kind: "empty", path: target, shared, items: 0 }
      : { entry, kind: "local", path: target, shared, items };
  });
}

export interface SessionStoreLayoutReport {
  /** Entries that now reach the shared store. */
  linked: AntigravitySharedSessionEntry[];
  /** Entries that already reached the shared store. */
  unchanged: AntigravitySharedSessionEntry[];
  /** Entries holding data (or a foreign link) that must be migrated first. */
  pending: AntigravitySharedSessionEntry[];
}

/**
 * Adopt the shared layout for the entries that cannot lose anything: absent or
 * empty directories are replaced by a symlink. An entry that still holds data is
 * reported as `pending` and left exactly as it is — that is what makes this safe
 * to call from provisioning, where a wrong move would orphan conversations.
 */
export function ensureSharedSessionStoreLayout(input: {
  storeDir: string;
  sharedRoot: string;
}): SessionStoreLayoutReport {
  const report: SessionStoreLayoutReport = { linked: [], unchanged: [], pending: [] };
  for (const state of inspectSessionStoreLayout(input)) {
    if (state.kind === "shared") {
      report.unchanged.push(state.entry);
      continue;
    }
    if (state.kind === "local" || state.kind === "foreign-link") {
      report.pending.push(state.entry);
      continue;
    }
    mkdirSync(state.shared, { recursive: true, mode: 0o700 });
    if (state.kind === "empty") rmSync(state.path, { recursive: true, force: true });
    symlinkSync(state.shared, state.path);
    report.linked.push(state.entry);
  }
  return report;
}

/* ------------------------------------------------------------------ *
 * Offline migration of existing stores into the shared session store.
 * ------------------------------------------------------------------ */

export type SessionStoreCollisionResolution = "identical" | "quarantine";

export interface SessionStoreCollision {
  item: string;
  resolution: SessionStoreCollisionResolution;
}

export interface SessionStoreMigrationAction {
  accountId: string;
  entry: AntigravitySharedSessionEntry;
  from: string;
  to: string;
  items: number;
  bytes: number;
  collisions: SessionStoreCollision[];
}

export interface SessionStoreMigrationPlan {
  formatVersion: 1;
  createdAt: string;
  sharedRoot: string;
  stores: AntigravitySessionStoreLocation[];
  actions: SessionStoreMigrationAction[];
  /** Entries with nothing to move, or already shared. */
  skipped: { accountId: string; entry: AntigravitySharedSessionEntry; reason: string }[];
  totalItems: number;
  totalBytes: number;
}

function digestOfFile(file: string): string {
  // ponytail: whole-file digest; the migration runs once, offline, on stores
  // whose median conversation is 50 KB. Stream it if stores grow to GBs.
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function samePayload(left: string, right: string): boolean {
  const a = statSync(left, { throwIfNoEntry: false });
  const b = statSync(right, { throwIfNoEntry: false });
  if (!a || !b) return false;
  if (a.isFile() !== b.isFile()) return false;
  if (!a.isFile() || !b.isFile()) return false; // directory collisions are never auto-resolved
  return a.size === b.size && digestOfFile(left) === digestOfFile(right);
}

function measure(directory: string): { items: number; bytes: number } {
  let items = 0;
  let bytes = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        items += 1;
        bytes += statSync(child, { throwIfNoEntry: false })?.size ?? 0;
      }
    }
  };
  walk(directory);
  return { items, bytes };
}

/**
 * Read-only. Builds the manifest a user reviews before anything moves, and
 * classifies every collision instead of letting the newest file win.
 */
export function planSessionStoreMigration(input: {
  sharedRoot: string;
  stores: readonly AntigravitySessionStoreLocation[];
  now?: Date;
}): SessionStoreMigrationPlan {
  const plan: SessionStoreMigrationPlan = {
    formatVersion: SESSION_STORE_MIGRATION_FORMAT_VERSION,
    createdAt: (input.now ?? new Date()).toISOString(),
    sharedRoot: input.sharedRoot,
    stores: [...input.stores],
    actions: [],
    skipped: [],
    totalItems: 0,
    totalBytes: 0,
  };
  for (const store of input.stores) {
    const states = inspectSessionStoreLayout({
      storeDir: store.storeDir,
      sharedRoot: input.sharedRoot,
    });
    for (const state of states) {
      if (state.kind !== "local") {
        plan.skipped.push({
          accountId: store.accountId,
          entry: state.entry,
          reason: state.kind === "shared" ? "already shared" : state.kind,
        });
        continue;
      }
      const collisions: SessionStoreCollision[] = [];
      for (const item of readdirSync(state.path).sort()) {
        const existing = path.join(state.shared, item);
        if (!statSync(existing, { throwIfNoEntry: false })) continue;
        collisions.push({
          item,
          resolution: samePayload(path.join(state.path, item), existing)
            ? "identical"
            : "quarantine",
        });
      }
      const { items, bytes } = measure(state.path);
      plan.actions.push({
        accountId: store.accountId,
        entry: state.entry,
        from: state.path,
        to: state.shared,
        items,
        bytes,
        collisions,
      });
      plan.totalItems += items;
      plan.totalBytes += bytes;
    }
  }
  return plan;
}

export type SessionStoreMigrationState = "prepared" | "applying" | "committed";

/** Structural fingerprint of one shared entry, used to refuse unsafe rollback. */
export interface SessionStoreEntryBaseline {
  entry: AntigravitySharedSessionEntry;
  itemCount: number;
  /** Digest of the sorted item names: any add/remove/rename breaks the rollback. */
  nameDigest: string;
}

export interface SessionStoreMigrationJournal {
  formatVersion: 1;
  /** `prepared` before the first mutation, `applying` while moving, `committed` when done. */
  state: SessionStoreMigrationState;
  startedAt: string;
  finishedAt: string;
  sharedRoot: string;
  journalDirectory: string;
  /** Entries that moved into the shared store, with their rollback targets. */
  moved: { entry: string; item: string; from: string; to: string }[];
  /** Conflicting payloads parked for review, with their original locations. */
  quarantined: { entry: string; item: string; original: string; path: string }[];
  /** Symlinks created by the migration; rollback removes exactly these. */
  createdLinks: string[];
  /** Directories the migration removed once they were empty. */
  removedDirectories: string[];
  /** What each shared entry looked like when this migration committed. */
  baseline: SessionStoreEntryBaseline[];
  /**
   * Which Account each migrated conversation came from. Ownership must be
   * explicit metadata: once every Account reaches the same store, the physical
   * location can no longer answer "who created this conversation?".
   */
  conversationOwners: { accountId: string; nativeSessionId: string }[];
  stores: AntigravitySessionStoreLocation[];
}

function entryNameDigest(directory: string): { itemCount: number; nameDigest: string } {
  const names = readdirSync(directory).sort();
  return {
    itemCount: names.length,
    nameDigest: createHash("sha256").update(names.join("\u0000")).digest("hex"),
  };
}

export interface IncompleteSessionStoreMigration {
  journalPath: string;
  journal: SessionStoreMigrationJournal;
}

/**
 * A migration that never reached `committed`. Callers must refuse to start a
 * second migration while one exists: the shared store is in an unknown half-moved
 * state, and rollback (or rollback-then-apply) is the only safe next step.
 */
export function findIncompleteSessionStoreMigration(
  accountsRoot: string,
): IncompleteSessionStoreMigration | null {
  const root = path.join(accountsRoot, SESSION_STORE_MIGRATION_DIRECTORY);
  let directories: string[];
  try {
    directories = readdirSync(root).sort().reverse();
  } catch {
    return null;
  }
  for (const directory of directories) {
    const journalPath = path.join(root, directory, "journal.json");
    let journal: SessionStoreMigrationJournal;
    try {
      journal = JSON.parse(readFileSync(journalPath, "utf8")) as SessionStoreMigrationJournal;
    } catch {
      continue;
    }
    if (journal.state !== "committed") return { journalPath, journal };
  }
  return null;
}

function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, file);
}

/**
 * Move every planned store into the shared session store, then link it back.
 * Payloads are *moved*, never copied: the shared store holds the only copy, so
 * two Accounts can never diverge. Everything touched is recorded in a journal
 * that `rollbackSessionStoreMigration` replays.
 *
 * Callers must be offline; this function does not stop running AGY processes.
 */
export function applySessionStoreMigration(input: {
  plan: SessionStoreMigrationPlan;
  journalDirectory: string;
  now?: Date;
}): SessionStoreMigrationJournal {
  const timestamp = (input.now ?? new Date()).toISOString();
  const journal: SessionStoreMigrationJournal = {
    formatVersion: SESSION_STORE_MIGRATION_FORMAT_VERSION,
    state: "prepared",
    startedAt: timestamp,
    finishedAt: timestamp,
    sharedRoot: input.plan.sharedRoot,
    journalDirectory: input.journalDirectory,
    moved: [],
    quarantined: [],
    createdLinks: [],
    removedDirectories: [],
    baseline: [],
    conversationOwners: [],
    stores: input.plan.stores,
  };
  mkdirSync(input.journalDirectory, { recursive: true, mode: 0o700 });
  const journalPath = path.join(input.journalDirectory, "journal.json");
  // Durable before the first mutation: a crash from here on is visible as an
  // incomplete migration instead of looking like a clean store.
  writeJson(journalPath, journal);

  // Establish the shared layout first, so the merge below has one destination.
  for (const store of input.plan.stores) {
    mkdirSync(store.storeDir, { recursive: true, mode: 0o700 });
    for (const entry of ANTIGRAVITY_SHARED_SESSION_ENTRIES) {
      mkdirSync(path.join(input.plan.sharedRoot, entry), { recursive: true, mode: 0o700 });
    }
  }

  journal.state = "applying";
  writeJson(journalPath, journal);
  for (const action of input.plan.actions) {
    for (const item of readdirSync(action.from).sort()) {
      const source = path.join(action.from, item);
      const destination = path.join(action.to, item);
      const occupied = statSync(destination, { throwIfNoEntry: false });
      const collision = action.collisions.find((entry) => entry.item === item);
      if (occupied && collision?.resolution === "identical") {
        rmSync(source, { recursive: true, force: true });
        continue;
      }
      if (occupied) {
        const quarantineDirectory = path.join(input.journalDirectory, "quarantine", action.entry);
        mkdirSync(quarantineDirectory, { recursive: true, mode: 0o700 });
        const quarantine = path.join(quarantineDirectory, `${action.accountId}-${item}`);
        renameSync(source, quarantine);
        journal.quarantined.push({ entry: action.entry, item, original: source, path: quarantine });
        continue;
      }
      renameSync(source, destination);
      journal.moved.push({ entry: action.entry, item, from: source, to: destination });
      if (action.entry === "conversations" && item.endsWith(".db")) {
        journal.conversationOwners.push({
          accountId: action.accountId,
          nativeSessionId: item.slice(0, -".db".length),
        });
      }
    }
    rmSync(action.from, { recursive: true, force: true });
    journal.removedDirectories.push(action.from);
    symlinkSync(action.to, action.from);
    journal.createdLinks.push(action.from);
    writeJson(journalPath, journal);
  }

  // Entries that held nothing still adopt the shared layout, so the next write
  // from that Account lands in the shared store.
  for (const store of input.plan.stores) {
    const report = ensureSharedSessionStoreLayout({
      storeDir: store.storeDir,
      sharedRoot: input.plan.sharedRoot,
    });
    for (const entry of report.linked) journal.createdLinks.push(entryPath(store.storeDir, entry));
  }

  for (const entry of ANTIGRAVITY_SHARED_SESSION_ENTRIES) {
    const directory = path.join(input.plan.sharedRoot, entry);
    if (!statSync(directory, { throwIfNoEntry: false })) continue;
    journal.baseline.push({ entry, ...entryNameDigest(directory) });
  }
  journal.state = "committed";
  journal.finishedAt = (input.now ?? new Date()).toISOString();
  writeJson(journalPath, journal);
  return journal;
}

/**
 * Refuse a rollback that would misattribute data created after the migration.
 *
 * A migration moves payloads, so anything written into the shared store after it
 * committed has no original Account to return to. Rather than "best effort"
 * overwrite later data, a diverged store is left alone and reported.
 */
function assertRollbackIsSafe(journal: SessionStoreMigrationJournal): void {
  for (const link of journal.createdLinks) {
    const target = readLinkSyncOrNull(link);
    if (target === null) {
      throw new Error(
        `Refusing to roll back: '${link}' is no longer a shared-store link. Inspect the migration before continuing.`,
      );
    }
  }
  for (const baseline of journal.baseline) {
    const directory = path.join(journal.sharedRoot, baseline.entry);
    const current = statSync(directory, { throwIfNoEntry: false })
      ? entryNameDigest(directory)
      : { itemCount: 0, nameDigest: "" };
    if (current.itemCount !== baseline.itemCount || current.nameDigest !== baseline.nameDigest) {
      throw new Error(
        `Refusing to roll back: shared '${baseline.entry}' changed after the migration ` +
          `(${baseline.itemCount} -> ${current.itemCount} items). New conversations have no original Account to return to; ` +
          `resolve them manually, or restore from the journal's quarantine directory.`,
      );
    }
  }
}

/** Restore the exact pre-migration layout. Requires a stopped Host, as above. */
export function rollbackSessionStoreMigration(journalPath: string): void {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as SessionStoreMigrationJournal;
  assertRollbackIsSafe(journal);
  for (const link of journal.createdLinks) rmSync(link, { recursive: true, force: true });
  for (const directory of journal.removedDirectories) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  for (const moved of journal.moved) {
    mkdirSync(path.dirname(moved.from), { recursive: true, mode: 0o700 });
    renameSync(moved.to, moved.from);
  }
  for (const quarantined of journal.quarantined) {
    mkdirSync(path.dirname(quarantined.original), { recursive: true, mode: 0o700 });
    renameSync(quarantined.path, quarantined.original);
  }
  for (const store of journal.stores) mkdirSync(store.storeDir, { recursive: true, mode: 0o700 });
}
