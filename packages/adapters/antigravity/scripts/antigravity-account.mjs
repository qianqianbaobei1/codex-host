#!/usr/bin/env node
/**
 * Antigravity multi-account CLI (Phase 1: metadata only).
 *
 *   node packages/adapters/antigravity/scripts/antigravity-account.mjs list
 *   node packages/adapters/antigravity/scripts/antigravity-account.mjs add work --name 工作号
 *   node packages/adapters/antigravity/scripts/antigravity-account.mjs login work
 *   node packages/adapters/antigravity/scripts/antigravity-account.mjs default work
 *   node packages/adapters/antigravity/scripts/antigravity-account.mjs disable work
 *   node packages/adapters/antigravity/scripts/antigravity-account.mjs remove work
 *   node packages/adapters/antigravity/scripts/antigravity-account.mjs purge work --yes
 *
 * `remove` only drops metadata; the shadow HOME (token, conversations, brain)
 * survives until an explicit `purge`.
 */
import { parseArgs } from "node:util";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let accountsModule;
try {
  accountsModule = await import(path.join(here, "..", "dist", "accounts.js"));
} catch {
  console.error(
    "找不到 dist/accounts.js。请先在仓库根目录执行：\n" +
      "  npm --workspace @codexhost/adapter-antigravity run build",
  );
  process.exit(2);
}
const {
  AntigravityAccountStore,
  antigravityAccountsFile,
  antigravityAccountsRoot,
  createEmptyAccountsFile,
  ensureAntigravityShadowHome,
  isAntigravityAccountId,
  loadAntigravityAccountsSync,
} = accountsModule;

// A CLI must never dump a stack trace at the user.
function reportAndExit(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
process.on("uncaughtException", reportAndExit);
process.on("unhandledRejection", reportAndExit);

const USAGE = `用法: antigravity-account <command> [id] [flags]

  list                    列出账号、默认账号与线程绑定数量
  add <id> [--name <名称>] 新增账号并创建隔离 HOME
  remove <id>             删除账号元数据（保留 HOME 与凭据）
  purge <id> --yes        物理删除账号 HOME（不可恢复）
  default <id>            设为默认账号（新线程使用）
  enable|disable <id>     启用/停用
  login <id> [--run]      登录账号（--run 自动接管隔离钥匙串与 HOME）
  ready <id>              官方登录成功后解除 needs_login 保险丝
  where <id>              打印该账号的 HOME 路径
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function openStore() {
  const loaded = loadAntigravityAccountsSync({});
  if (loaded.mode === "multi") return loaded.store;
  if (loaded.mode === "invalid") fail(loaded.error.message);
  return new AntigravityAccountStore({
    file: antigravityAccountsFile({}),
    realHome: process.env.HOME || "",
    value: createEmptyAccountsFile({}),
  });
}

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    yes: { type: "boolean", default: false },
    run: { type: "boolean", default: false },
  },
});

const [command, accountId] = positionals;
const store = openStore();

function requireId() {
  if (!accountId) fail(`缺少账号 id\n\n${USAGE}`);
  const account = store.get(accountId);
  if (!account) fail(`未知账号 '${accountId}'`);
  return account;
}

switch (command) {
  case "list": {
    const snapshot = store.snapshot();
    const boundCounts = new Map();
    for (const binding of Object.values(snapshot.threadBindings)) {
      boundCounts.set(binding.accountId, (boundCounts.get(binding.accountId) ?? 0) + 1);
    }
    console.log(`accounts.json : ${store.file}`);
    console.log(`shadow root   : ${antigravityAccountsRoot({})}`);
    console.log(`default       : ${snapshot.defaultAccountId}`);
    console.log("");
    for (const account of snapshot.accounts) {
      const marks = [
        account.id === snapshot.defaultAccountId ? "default" : "",
        account.legacy ? "legacy(真实 HOME)" : "",
        account.enabled ? "" : "disabled",
        account.state && account.state !== "ready" ? account.state : "",
      ].filter(Boolean);
      const threads = boundCounts.get(account.id) ?? 0;
      console.log(
        `${account.id.padEnd(16)} ${account.name.padEnd(20)} ` +
          `threads=${String(threads).padEnd(4)} ${marks.join(" ")}`,
      );
    }
    break;
  }
  case "add": {
    if (!accountId) fail(`缺少账号 id\n\n${USAGE}`);
    const account = await store.createAccount({
      id: accountId,
      ...(flags.name ? { name: flags.name } : {}),
    });
    const home = await store.ensureHome(account);
    console.log(`已创建账号 '${account.id}'`);
    console.log(`隔离 HOME : ${home}`);
    console.log(
      `下一步    : node ${path.relative(process.cwd(), path.join(here, "antigravity-account.mjs"))} login ${account.id}`,
    );
    break;
  }
  case "login": {
    const account = requireId();
    if (account.legacy) {
      if (flags.run) {
        const { spawnSync } = await import("node:child_process");
        spawnSync("agy", [], { stdio: "inherit" });
      } else {
        console.log("该账号使用真实 HOME，直接运行： agy");
      }
      break;
    }
    const home = await store.ensureHome(account);
    if (flags.run) {
      console.log(`正在为账号 '${account.id}' 启动隔离登录（专用钥匙串 + 影子 HOME）...`);
      const { spawnSync } = await import("node:child_process");
      const agyCmd = process.env.CODEXHOST_ANTIGRAVITY_COMMAND || "agy";
      spawnSync(agyCmd, [], {
        stdio: "inherit",
        env: {
          ...process.env,
          HOME: home,
        },
      });
      await store.markReady(account.id);
      console.log(`\n账号 '${account.id}' 登录已完成并标记为 ready`);
    } else {
      console.log(`HOME=${home} agy`);
      console.log(`\n💡 提示：如需直接启动交互登录并接管隔离钥匙串，请执行：`);
      console.log(
        `  node ${path.relative(process.cwd(), path.join(here, "antigravity-account.mjs"))} login ${account.id} --run`,
      );
    }
    break;
  }
  case "ready": {
    const account = requireId();
    await store.markReady(account.id);
    console.log(`账号 '${account.id}' 已恢复为 ready`);
    break;
  }
  case "where": {
    const account = requireId();
    console.log(store.homeFor(account));
    break;
  }
  case "default": {
    const account = requireId();
    await store.setDefaultAccount(account.id);
    console.log(`默认账号已设为 '${account.id}'（仅影响新建线程）`);
    break;
  }
  case "enable":
  case "disable": {
    const account = requireId();
    await store.setEnabled(account.id, command === "enable");
    console.log(`账号 '${account.id}' 已${command === "enable" ? "启用" : "停用"}`);
    break;
  }
  case "remove": {
    const account = requireId();
    await store.removeAccount(account.id);
    console.log(`已删除账号元数据 '${account.id}'（HOME 与凭据保留）`);
    console.log(`如需彻底删除：antigravity-account purge ${account.id} --yes`);
    break;
  }
  case "purge": {
    if (!accountId) fail(`缺少账号 id\n\n${USAGE}`);
    if (!isAntigravityAccountId(accountId)) fail(`账号 id 非法 '${accountId}'`);
    const account = store.get(accountId);
    if (account?.legacy) fail("legacy 账号使用真实 HOME，不能 purge");
    const accountDir = path.join(antigravityAccountsRoot({}), accountId);
    if (!flags.yes) fail(`purge 会删除 ${accountDir}，请加 --yes 确认`);
    if (account) await store.removeAccount(accountId).catch(() => undefined);
    await rm(accountDir, { recursive: true, force: true });
    if (process.platform === "darwin") {
      const realKeychain = path.join(store.realHome, "Library", "Keychains", "login.keychain-db");
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        const { stdout: curDefault } = await exec("security", ["default-keychain", "-d", "user"]);
        const { stdout: curList } = await exec("security", ["list-keychains", "-d", "user"]);
        // Restore if default OR search list still points at this account (or at a
        // now-missing file). Checking only default-keychain misses the case where
        // default was already reset but list-keychains still names the shadow db.
        if (
          curDefault.includes(accountId) ||
          curList.includes(accountId) ||
          curList.includes(accountDir) ||
          !curList.includes(realKeychain)
        ) {
          await exec("security", ["default-keychain", "-d", "user", "-s", realKeychain]);
          await exec("security", ["list-keychains", "-d", "user", "-s", realKeychain]);
        }
      } catch {
        // Ignore errors during best-effort keychain recovery.
      }
    }
    console.log(`已物理删除 '${accountId}' 的 HOME`);
    break;
  }
  case "rebuild": {
    // Repair links for every shadow account (safe, idempotent).
    for (const account of store.list()) {
      if (account.legacy) continue;
      const report = await ensureAntigravityShadowHome({
        realHome: store.realHome,
        shadowHome: store.homeFor(account),
        shadowRoot: store.shadowRoot,
      });
      console.log(`${account.id}: linked=${report.linked.length} skipped=${report.skipped.length}`);
    }
    break;
  }
  default:
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}
