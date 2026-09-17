#!/usr/bin/env node
/**
 * Antigravity shared session store (offline migration).
 *
 * Today every Account keeps its own conversation files under its own HOME, so a
 * historical conversation cannot be resumed by another Account. This tool moves
 * the session-domain entries (`conversations`, `brain`, `annotations`,
 * `presence`) of every Account into one canonical store and links them back, so
 * later a Thread only has to change *which credential runs it*.
 *
 *   node packages/adapters/antigravity/scripts/antigravity-shared-store.mjs plan
 *   node packages/adapters/antigravity/scripts/antigravity-shared-store.mjs apply
 *   node packages/adapters/antigravity/scripts/antigravity-shared-store.mjs status
 *   node packages/adapters/antigravity/scripts/antigravity-shared-store.mjs rollback [journal]
 *
 * `plan` is read-only and prints the manifest. `apply` refuses to run while a
 * Host or an `agy` process is alive: moving a store under a live writer is how
 * data gets lost.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
async function load(module) {
  try {
    return await import(path.join(here, "..", "dist", module));
  } catch {
    console.error(
      "找不到 dist/ 产物。请先在仓库根目录执行：\n" +
        "  npm --workspace @codexhost/adapter-antigravity run build",
    );
    process.exit(2);
  }
}
const { antigravityAccountsRoot, loadAntigravityAccountsSync } = await load("accounts.js");

const {
  SESSION_STORE_MIGRATION_DIRECTORY,
  accountSessionStoreDirectory,
  applySessionStoreMigration,
  findIncompleteSessionStoreMigration,
  inspectSessionStoreLayout,
  planSessionStoreMigration,
  rollbackSessionStoreMigration,
  sharedSessionStoreRoot,
} = await load("session-store.js");

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Every selectable Account plus the real (legacy) HOME, which owns the real store. */
function sessionStores() {
  const environment = process.env;
  const realHome = process.env.HOME ?? "";
  const loaded = loadAntigravityAccountsSync({ environment });
  const stores = [];
  if (loaded.mode === "multi") {
    for (const account of loaded.store.list()) {
      stores.push({
        accountId: account.id,
        accountHome: loaded.store.homeFor(account),
        storeDir: accountSessionStoreDirectory(loaded.store.homeFor(account)),
      });
    }
  } else {
    stores.push({
      accountId: "legacy",
      accountHome: realHome,
      storeDir: accountSessionStoreDirectory(realHome),
    });
  }
  return {
    stores,
    sharedRoot: sharedSessionStoreRoot(antigravityAccountsRoot(environment)),
    loaded,
  };
}

/** A live writer would corrupt a store that is being moved underneath it. */
function assertOffline() {
  const running = [];
  try {
    const output = execFileSync("/bin/ps", ["-Ao", "command"], { encoding: "utf8" });
    for (const line of output.split("\n")) {
      if (
        /(^|\/)(agy|codexhost)( |$)/u.test(line) &&
        !line.includes("antigravity-shared-store") &&
        !line.includes("auto-launch.mjs")
      ) {
        running.push(line.trim().slice(0, 120));
      }
    }
  } catch {
    /* `ps` unavailable: fall through to the explicit user check below. */
  }
  if (running.length > 0) {
    console.error("检测到仍在运行的 AGY/宿主进程，先退出应用再执行：\n");
    for (const line of running.slice(0, 8)) console.error(`  ${line}`);
    console.error("\n（如果你确认这些进程与本工具无关，可用 --force 跳过此检查，但风险自负。）");
    return false;
  }
  return true;
}

/**
 * A half-finished migration must be resolved before anything else runs: the
 * shared store is in an unknown state, and rollback (then apply) is the only
 * safe continuation. Starting a second migration would double-move payloads.
 */
function assertNoIncompleteMigration() {
  const incomplete = findIncompleteSessionStoreMigration(antigravityAccountsRoot(process.env));
  if (!incomplete) return true;
  console.error(
    `检测到未完成的迁移（state=${incomplete.journal.state}）：\n  ${incomplete.journalPath}\n\n` +
      "请先回滚，再重新执行 apply：\n" +
      `  npm run antigravity:shared-store -- rollback ${incomplete.journalPath}`,
  );
  return false;
}

function printPlan(plan, stores) {
  console.log(`共享会话域: ${plan.sharedRoot}\n`);
  console.log("账号与环境:");
  for (const store of stores) {
    console.log(`  ${store.accountId.padEnd(12)} ${store.storeDir}`);
  }
  const actions = plan.actions.filter((action) => action.items > 0);
  console.log(
    `\n待迁移条目 (${actions.length} 项, ${plan.totalItems} 个文件, ${humanBytes(plan.totalBytes)}):`,
  );
  for (const action of actions) {
    const collisions = action.collisions.length
      ? `  冲突 ${action.collisions.length} (${action.collisions
          .map((entry) => `${entry.item}:${entry.resolution}`)
          .join(", ")})`
      : "";
    console.log(
      `  ${action.accountId.padEnd(12)} ${action.entry.padEnd(14)} ${String(action.items).padStart(5)} 文件 ${humanBytes(action.bytes).padStart(9)}${collisions}`,
    );
  }
  const skipped = plan.skipped.filter((entry) => entry.reason !== "already shared");
  if (skipped.length > 0) {
    console.log("\n无需搬运:");
    for (const entry of skipped)
      console.log(`  ${entry.accountId.padEnd(12)} ${entry.entry}: ${entry.reason}`);
  }
}

async function main() {
  const [command = "plan", ...rest] = process.argv.slice(2);
  const force = rest.includes("--force");
  const { stores, sharedRoot, loaded } = sessionStores();
  if (stores.length === 0) {
    console.error("没有可迁移的账号。");
    process.exit(1);
  }

  if (command === "status") {
    const incomplete = findIncompleteSessionStoreMigration(antigravityAccountsRoot(process.env));
    if (incomplete) {
      console.log(
        `⚠ 存在未完成的迁移（state=${incomplete.journal.state}）: ${incomplete.journalPath}\n`,
      );
    }
    for (const store of stores) {
      const states = inspectSessionStoreLayout({ storeDir: store.storeDir, sharedRoot });
      const summary = states.map((state) => `${state.entry}=${state.kind}`).join(" ");
      console.log(`${store.accountId.padEnd(12)} ${summary}`);
    }
    console.log(`\nshared: ${sharedRoot}`);
    return;
  }

  if (command === "plan") {
    printPlan(planSessionStoreMigration({ sharedRoot, stores }), stores);
    console.log("\n这是只读预览，未改动任何文件。执行 apply 才会搬运。");
    return;
  }

  if (command === "apply") {
    if (!assertNoIncompleteMigration()) process.exit(4);
    const plan = planSessionStoreMigration({ sharedRoot, stores });
    printPlan(plan, stores);
    if (plan.actions.length === 0) {
      console.log("\n无需搬运。仅补齐空白条目的共享链接。");
    }
    if (!force && !assertOffline()) process.exit(3);
    const journalDirectory = path.join(
      antigravityAccountsRoot(process.env),
      SESSION_STORE_MIGRATION_DIRECTORY,
      new Date().toISOString().replace(/[:.]/gu, "-"),
    );
    const journal = applySessionStoreMigration({ plan, journalDirectory });
    console.log(
      `\n完成。搬运 ${journal.moved.length} 个文件，隔离 ${journal.quarantined.length} 个冲突，创建 ${journal.createdLinks.length} 个链接。`,
    );
    // Ownership must become explicit metadata at the moment it is still knowable:
    // after sharing, every Account sees every conversation file.
    if (loaded.mode === "multi" && journal.conversationOwners.length > 0) {
      for (const owner of journal.conversationOwners) {
        await loaded.store.recordNativeSessionOwner(owner);
      }
      console.log(`已记录 ${journal.conversationOwners.length} 段会话的归属账号。`);
    }
    console.log(`回滚日志: ${path.join(journalDirectory, "journal.json")}`);
    if (journal.quarantined.length > 0) {
      console.log("被隔离的冲突文件（请人工确认后再删除）:");
      for (const entry of journal.quarantined) console.log(`  ${entry.path}`);
    }
    const order = stores.map((store) => store.accountId).join(", ");
    console.log(`\n下一步：重启应用。账号 ${order} 现在共享同一份会话数据。`);
    return;
  }

  if (command === "rollback") {
    const journalPath =
      rest.find((value) => !value.startsWith("--")) ??
      (() => {
        console.error("用法: rollback <journal.json 路径>");
        process.exit(1);
      })();
    if (!force && !assertOffline()) process.exit(3);
    rollbackSessionStoreMigration(journalPath);
    console.log(`已回滚: ${journalPath}`);
    return;
  }

  console.error(`未知命令: ${command}\n可用: status | plan | apply | rollback`);
  void loaded;
  process.exit(1);
}

await main();
