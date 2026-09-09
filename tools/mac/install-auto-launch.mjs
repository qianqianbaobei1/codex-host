#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LABEL = "com.bytepioneer.codexhost.auto-launch";
const SUPPORTED_NODE_MESSAGE =
  "codexhost requires Node.js 22.19+ or 24.x; set CODEXHOST_NODE_PATH to a supported executable";

function supportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 19) || major === 24;
}

async function nodeVersion(nodePath) {
  try {
    const result = await execFileAsync(nodePath, ["--version"], { encoding: "utf8" });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function candidateNodePaths() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.CODEXHOST_NODE_PATH) candidates.push(process.env.CODEXHOST_NODE_PATH);
  candidates.push(process.execPath);
  for (const root of [
    path.join(home, ".nvm/versions/node"),
    "/opt/homebrew/opt/node@24/bin",
    "/usr/local/opt/node@24/bin",
  ]) {
    if (root.endsWith("/bin")) {
      candidates.push(path.join(root, "node"));
      continue;
    }
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries
        .filter((candidate) => candidate.isDirectory())
        .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))) {
        candidates.push(path.join(root, entry.name, "bin/node"));
      }
    } catch {
      // Optional version-manager roots may not exist.
    }
  }
  return [...new Set(candidates)];
}

async function resolveNodePath() {
  const candidates = await candidateNodePaths();
  for (const candidate of candidates) {
    const version = await nodeVersion(candidate);
    if (version && supportedNodeVersion(version)) return candidate;
  }
  throw new Error(SUPPORTED_NODE_MESSAGE);
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringArray(values) {
  return `<array>\n${values.map((value) => `    <string>${xml(value)}</string>`).join("\n")}\n  </array>`;
}

function pathsForRoot(root, nodePath) {
  return {
    root,
    node: nodePath,
    launcher: path.join(root, "target/debug/codexhost"),
    shim: path.join(root, "target/debug/codexhost-shim"),
    hostRuntime: path.join(root, "packages/host-runtime/dist/main.js"),
    desktopController: path.join(root, "packages/desktop-control/dist/release-main.js"),
    renderer: path.join(root, "packages/renderer-extension/dist/production.js"),
    watcher: path.join(root, "tools/mac/auto-launch.mjs"),
    desktopExecutable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  };
}

function plistFor(options) {
  const args = [
    options.node,
    options.watcher,
    "--launcher",
    options.launcher,
    "--shim",
    options.shim,
    "--node",
    options.node,
    "--host-runtime",
    options.hostRuntime,
    "--desktop-controller",
    options.desktopController,
    "--renderer",
    options.renderer,
    "--desktop-executable",
    options.desktopExecutable,
    "--descriptor",
    options.descriptor,
    "--root",
    options.root,
    "--path",
    options.pathValue,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  ${stringArray(args)}
  <key>WorkingDirectory</key>
  <string>${xml(options.root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${xml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.stderrPath)}</string>
</dict>
</plist>
`;
}

async function launchctl(arguments_) {
  return execFileAsync("/bin/launchctl", arguments_, { encoding: "utf8" });
}

function userPaths() {
  const home = os.homedir();
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("macOS user ID is unavailable");
  return {
    uid,
    home,
    plistPath: path.join(home, "Library/LaunchAgents", `${LABEL}.plist`),
    descriptor: path.join(home, "Library/Application Support/codexhost/desktop-runtime-v1.json"),
    stdoutPath: path.join(home, "Library/Logs/codexhost-auto-launcher.log"),
    stderrPath: path.join(home, "Library/Logs/codexhost-auto-launcher.error.log"),
  };
}

async function install(root, activate) {
  const user = userPaths();
  const nodePath = await resolveNodePath();
  const paths = pathsForRoot(root, nodePath);
  const options = {
    ...paths,
    ...user,
    pathValue: [
      path.dirname(nodePath),
      path.join(user.home, ".local/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
  };
  await mkdir(path.dirname(user.plistPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(user.stdoutPath), { recursive: true, mode: 0o700 });
  await writeFile(user.plistPath, plistFor(options), { encoding: "utf8", mode: 0o600 });
  console.log(`wrote ${user.plistPath}`);
  if (!activate) {
    console.log("activation deferred; log out and back in, or rerun with --activate");
    return;
  }
  const target = `gui/${user.uid}/${LABEL}`;
  await launchctl(["bootout", target]).catch(() => undefined);
  await launchctl(["bootstrap", `gui/${user.uid}`, user.plistPath]);
  await launchctl(["kickstart", "-k", target]);
  console.log(`activated ${target}`);
}

async function status() {
  const user = userPaths();
  const target = `gui/${user.uid}/${LABEL}`;
  try {
    const result = await launchctl(["print", target]);
    process.stdout.write(result.stdout);
  } catch (error) {
    const stderr = error?.stderr?.trim();
    console.error(stderr || `${LABEL} is not loaded`);
    process.exitCode = 1;
  }
}

async function uninstall() {
  const user = userPaths();
  const target = `gui/${user.uid}/${LABEL}`;
  await launchctl(["bootout", target]).catch(() => undefined);
  await unlink(user.plistPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  console.log(`removed ${user.plistPath}`);
}

async function main(arguments_) {
  const root = path.resolve(import.meta.dirname, "../..");
  const action = arguments_[0] ?? "--install";
  if (action === "--status") return status();
  if (action === "--uninstall") return uninstall();
  if (action !== "--install")
    throw new Error(
      "usage: install-auto-launch.mjs --install [--activate] | --status | --uninstall",
    );
  return install(root, arguments_.includes("--activate"));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
