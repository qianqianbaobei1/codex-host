import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_SHARED_SESSION_ENTRIES,
  accountSessionStoreDirectory,
  applySessionStoreMigration,
  ensureSharedSessionStoreLayout,
  inspectSessionStoreLayout,
  findIncompleteSessionStoreMigration,
  planSessionStoreMigration,
  rollbackSessionStoreMigration,
  sharedSessionStoreRoot,
} from "../src/session-store.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `codexhost-session-store-${prefix}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** One Account's store, with only the entries the test asks for. */
async function makeStore(options: {
  root: string;
  accountId: string;
  conversations?: readonly [string, string][];
  brain?: readonly [string, readonly [string, string][]][];
  annotations?: readonly string[];
  presence?: readonly string[];
}): Promise<{ accountId: string; accountHome: string; storeDir: string }> {
  const accountHome = path.join(options.root, "accounts", options.accountId, "home");
  const storeDir = accountSessionStoreDirectory(accountHome);
  await mkdir(storeDir, { recursive: true });
  if (options.conversations) {
    await mkdir(path.join(storeDir, "conversations"), { recursive: true });
    for (const [name, body] of options.conversations) {
      await writeFile(path.join(storeDir, "conversations", name), body, "utf8");
    }
  }
  if (options.brain) {
    await mkdir(path.join(storeDir, "brain"), { recursive: true });
    for (const [conversationId, files] of options.brain) {
      await mkdir(path.join(storeDir, "brain", conversationId), { recursive: true });
      for (const [name, body] of files) {
        await writeFile(path.join(storeDir, "brain", conversationId, name), body, "utf8");
      }
    }
  }
  if (options.annotations) {
    await mkdir(path.join(storeDir, "annotations"), { recursive: true });
    for (const name of options.annotations) {
      await writeFile(path.join(storeDir, "annotations", name), "annotation", "utf8");
    }
  }
  if (options.presence) {
    await mkdir(path.join(storeDir, "presence"), { recursive: true });
    for (const name of options.presence) {
      await writeFile(path.join(storeDir, "presence", name), "", "utf8");
    }
  }
  return { accountId: options.accountId, accountHome, storeDir };
}

describe("Antigravity shared session store", () => {
  it("links only entries that cannot lose data and reports the rest as pending", async () => {
    const root = await makeRoot("layout");
    const sharedRoot = sharedSessionStoreRoot(path.join(root, "accounts"));
    const withData = await makeStore({
      root,
      accountId: "with-data",
      conversations: [["conv-a.db", "A"]],
      presence: ["conv-a.lock"],
    });
    const empty = await makeStore({ root, accountId: "empty" });

    const report = ensureSharedSessionStoreLayout({ storeDir: withData.storeDir, sharedRoot });

    // The Account that owns conversations keeps them: linking now would orphan them.
    expect(report.pending.sort()).toEqual(["conversations", "presence"]);
    expect((await readdir(path.join(withData.storeDir, "conversations"))).sort()).toEqual([
      "conv-a.db",
    ]);
    // The empty Account adopts the layout immediately.
    const emptyReport = ensureSharedSessionStoreLayout({
      storeDir: empty.storeDir,
      sharedRoot,
    });
    expect(emptyReport.linked.sort()).toEqual([...ANTIGRAVITY_SHARED_SESSION_ENTRIES].sort());
    for (const entry of ANTIGRAVITY_SHARED_SESSION_ENTRIES) {
      expect(await readlink(path.join(empty.storeDir, entry))).toBe(path.join(sharedRoot, entry));
    }

    const states = inspectSessionStoreLayout({ storeDir: empty.storeDir, sharedRoot });
    expect(states.every((state) => state.kind === "shared")).toBe(true);
    // Idempotent: a second pass links nothing and still refuses to touch data.
    const again = ensureSharedSessionStoreLayout({ storeDir: empty.storeDir, sharedRoot });
    expect(again.linked).toEqual([]);
    expect(again.unchanged.sort()).toEqual([...ANTIGRAVITY_SHARED_SESSION_ENTRIES].sort());
  });

  it("treats a symlink that points elsewhere as data, not as an adopted store", async () => {
    const root = await makeRoot("foreign");
    const sharedRoot = sharedSessionStoreRoot(path.join(root, "accounts"));
    const store = await makeStore({ root, accountId: "foreign" });
    await symlink(path.join(root, "elsewhere"), path.join(store.storeDir, "conversations"));

    const [conversations] = inspectSessionStoreLayout({ storeDir: store.storeDir, sharedRoot });
    expect(conversations).toMatchObject({ kind: "foreign-link" });
    expect(
      ensureSharedSessionStoreLayout({ storeDir: store.storeDir, sharedRoot }).pending,
    ).toContain("conversations");
  });

  it("plans a manifest with sizes and classifies collisions instead of overwriting", async () => {
    const root = await makeRoot("plan");
    const sharedRoot = sharedSessionStoreRoot(path.join(root, "accounts"));
    await mkdir(path.join(sharedRoot, "conversations"), { recursive: true });
    await writeFile(path.join(sharedRoot, "conversations", "conv-same.db"), "SAME", "utf8");
    await writeFile(path.join(sharedRoot, "conversations", "conv-clash.db"), "OTHER", "utf8");
    const store = await makeStore({
      root,
      accountId: "a",
      conversations: [
        ["conv-same.db", "SAME"],
        ["conv-clash.db", "MINE"],
        ["conv-new.db", "NEW"],
      ],
    });

    const plan = planSessionStoreMigration({ sharedRoot, stores: [store] });
    const conversations = plan.actions.find((action) => action.entry === "conversations");
    expect(conversations?.items).toBe(3);
    expect(conversations?.bytes).toBe("SAME".length + "MINE".length + "NEW".length);
    expect(conversations?.collisions).toEqual([
      { item: "conv-clash.db", resolution: "quarantine" },
      { item: "conv-same.db", resolution: "identical" },
    ]);
    // Planning is read-only.
    expect((await readdir(path.join(store.storeDir, "conversations"))).length).toBe(3);
  });

  it("moves payloads into one canonical store, links both Accounts, and rolls back", async () => {
    const root = await makeRoot("apply");
    const sharedRoot = sharedSessionStoreRoot(path.join(root, "accounts"));
    const owner = await makeStore({
      root,
      accountId: "owner",
      conversations: [
        ["conv-a.db", "A"],
        ["conv-clash.db", "MINE"],
      ],
      brain: [["conv-a", [["scratch", "brain"]]]],
      annotations: ["conv-a.pbtxt"],
      presence: ["conv-a.lock"],
    });
    const other = await makeStore({ root, accountId: "other" });
    ensureSharedSessionStoreLayout({ storeDir: other.storeDir, sharedRoot });
    await mkdir(path.join(sharedRoot, "conversations"), { recursive: true });
    await writeFile(path.join(sharedRoot, "conversations", "conv-clash.db"), "OTHER", "utf8");

    const plan = planSessionStoreMigration({ sharedRoot, stores: [owner, other] });
    const journalDirectory = path.join(root, "journal");
    const journal = applySessionStoreMigration({ plan, journalDirectory });

    // One canonical copy, reached through both Accounts' paths.
    expect(await readFile(path.join(owner.storeDir, "conversations", "conv-a.db"), "utf8")).toBe(
      "A",
    );
    expect(await readFile(path.join(other.storeDir, "conversations", "conv-a.db"), "utf8")).toBe(
      "A",
    );
    expect(await readFile(path.join(sharedRoot, "conversations", "conv-a.db"), "utf8")).toBe("A");
    expect(await readFile(path.join(sharedRoot, "brain", "conv-a", "scratch"), "utf8")).toBe(
      "brain",
    );
    expect(await readlink(path.join(owner.storeDir, "brain"))).toBe(path.join(sharedRoot, "brain"));
    // Conflicting payload is parked, the shared copy is untouched.
    expect(journal.quarantined).toEqual([
      {
        entry: "conversations",
        item: "conv-clash.db",
        original: path.join(owner.storeDir, "conversations", "conv-clash.db"),
        path: path.join(journalDirectory, "quarantine", "conversations", "owner-conv-clash.db"),
      },
    ]);
    expect(await readFile(path.join(sharedRoot, "conversations", "conv-clash.db"), "utf8")).toBe(
      "OTHER",
    );

    // A re-run finds nothing left to move.
    const replanned = planSessionStoreMigration({ sharedRoot, stores: [owner, other] });
    expect(replanned.actions).toEqual([]);

    rollbackSessionStoreMigration(path.join(journalDirectory, "journal.json"));
    expect(await readFile(path.join(owner.storeDir, "conversations", "conv-a.db"), "utf8")).toBe(
      "A",
    );
    expect(
      await readFile(path.join(owner.storeDir, "conversations", "conv-clash.db"), "utf8"),
    ).toBe("MINE");
    expect(await readFile(path.join(owner.storeDir, "brain", "conv-a", "scratch"), "utf8")).toBe(
      "brain",
    );
    expect(await lstat(path.join(owner.storeDir, "brain"))).toMatchObject({});
    expect((await lstat(path.join(owner.storeDir, "brain"))).isSymbolicLink()).toBe(false);
    expect((await readdir(path.join(sharedRoot, "conversations"))).sort()).toEqual([
      "conv-clash.db",
    ]);
  });

  it("keeps one copy of a byte-identical duplicate", async () => {
    const root = await makeRoot("duplicate");
    const sharedRoot = sharedSessionStoreRoot(path.join(root, "accounts"));
    const first = await makeStore({ root, accountId: "first", conversations: [["c.db", "SAME"]] });
    const second = await makeStore({
      root,
      accountId: "second",
      conversations: [["c.db", "SAME"]],
    });

    const plan = planSessionStoreMigration({ sharedRoot, stores: [first, second] });
    expect(plan.actions.flatMap((action) => action.collisions)).toEqual([]);
    applySessionStoreMigration({ plan, journalDirectory: path.join(root, "journal") });

    expect(await readdir(path.join(sharedRoot, "conversations"))).toEqual(["c.db"]);
    expect(await readFile(path.join(second.storeDir, "conversations", "c.db"), "utf8")).toBe(
      "SAME",
    );
    expect(await readFile(path.join(first.storeDir, "conversations", "c.db"), "utf8")).toBe("SAME");
  });

  it("records which Account owned each migrated conversation and commits its baseline", async () => {
    const root = await makeRoot("owners");
    const sharedRoot = sharedSessionStoreRoot(path.join(root, "accounts"));
    const owner = await makeStore({
      root,
      accountId: "legacy",
      conversations: [
        ["conv-one.db", "ONE"],
        ["conv-one.db-wal", "WAL"],
      ],
    });
    const other = await makeStore({
      root,
      accountId: "work",
      conversations: [["conv-two.db", "TWO"]],
    });

    const journalDirectory = path.join(root, "journal");
    const journal = applySessionStoreMigration({
      plan: planSessionStoreMigration({ sharedRoot, stores: [owner, other] }),
      journalDirectory,
    });

    // Ownership becomes explicit metadata; sidecars are not conversations.
    expect(journal.conversationOwners).toEqual([
      { accountId: "legacy", nativeSessionId: "conv-one" },
      { accountId: "work", nativeSessionId: "conv-two" },
    ]);
    expect(journal.state).toBe("committed");
    expect(journal.baseline.map((entry) => entry.entry)).toEqual([
      "conversations",
      "brain",
      "annotations",
      "presence",
    ]);
    expect(journal.baseline[0]).toMatchObject({ itemCount: 3 });
    expect(findIncompleteSessionStoreMigration(path.join(root, "accounts"))).toBeNull();
  });

  it("refuses a rollback once the shared store gained conversations", async () => {
    const root = await makeRoot("diverge");
    const accountsRoot = path.join(root, "accounts");
    const sharedRoot = sharedSessionStoreRoot(accountsRoot);
    const store = await makeStore({
      root,
      accountId: "legacy",
      conversations: [["conv-a.db", "A"]],
    });
    const journalDirectory = path.join(accountsRoot, "session-store-migration", "one");
    applySessionStoreMigration({
      plan: planSessionStoreMigration({ sharedRoot, stores: [store] }),
      journalDirectory,
    });
    const journalPath = path.join(journalDirectory, "journal.json");

    // A conversation created after the migration has no original Account to
    // return to, so rolling back would silently lose track of it.
    await writeFile(path.join(sharedRoot, "conversations", "conv-later.db"), "LATER", "utf8");
    expect(() => rollbackSessionStoreMigration(journalPath)).toThrow(
      /changed after the migration/u,
    );
    expect(await readFile(path.join(sharedRoot, "conversations", "conv-later.db"), "utf8")).toBe(
      "LATER",
    );

    await rm(path.join(sharedRoot, "conversations", "conv-later.db"));
    rollbackSessionStoreMigration(journalPath);
    expect(await readFile(path.join(store.storeDir, "conversations", "conv-a.db"), "utf8")).toBe(
      "A",
    );
  });

  it("reports an unfinished migration so a second one cannot start", async () => {
    const root = await makeRoot("incomplete");
    const accountsRoot = path.join(root, "accounts");
    const journalDirectory = path.join(accountsRoot, "session-store-migration", "one");
    await mkdir(journalDirectory, { recursive: true });
    await writeFile(
      path.join(journalDirectory, "journal.json"),
      `${JSON.stringify({
        formatVersion: 1,
        state: "applying",
        startedAt: "2026-09-16T00:00:00.000Z",
        finishedAt: "2026-09-16T00:00:00.000Z",
        sharedRoot: sharedSessionStoreRoot(accountsRoot),
        journalDirectory,
        moved: [{ entry: "conversations", item: "conv-a.db", from: "a", to: "b" }],
        quarantined: [],
        createdLinks: [],
        removedDirectories: [],
        baseline: [],
        conversationOwners: [],
        stores: [],
      })}\n`,
      "utf8",
    );

    const incomplete = findIncompleteSessionStoreMigration(accountsRoot);
    expect(incomplete?.journal.state).toBe("applying");
    expect(incomplete?.journalPath).toBe(path.join(journalDirectory, "journal.json"));
  });
});
