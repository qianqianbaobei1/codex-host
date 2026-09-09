import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  commandInvocation,
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export const ANTIGRAVITY_COMMAND_ENV = "CODEXHOST_ANTIGRAVITY_COMMAND";
/** Keep AGY's native print-mode watchdog above the host's normal Turn budget. */
export const DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT = "2h";

let cachedSystemProxy: Record<string, string> | null = null;

const LOCALHOST_EXCEPTIONS = ["127.0.0.1", "localhost", "::1"] as const;

function appendLocalhostNoProxy(environment: NodeJS.ProcessEnv): void {
  const existingNoProxy = environment.NO_PROXY || environment.no_proxy || "";
  const parts = existingNoProxy
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set(parts);
  for (const exp of LOCALHOST_EXCEPTIONS) {
    set.add(exp);
  }
  const merged = Array.from(set).join(",");
  environment.NO_PROXY = merged;
  environment.no_proxy = merged;
}

export function resolveAntigravityProxyEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...environment };
  const hasProxy =
    result.HTTPS_PROXY ||
    result.https_proxy ||
    result.HTTP_PROXY ||
    result.http_proxy ||
    result.ALL_PROXY ||
    result.all_proxy;

  if (!hasProxy && platform === "darwin") {
    if (cachedSystemProxy === null) {
      cachedSystemProxy = {};
      try {
        const out = execSync("scutil --proxy", { encoding: "utf8", timeout: 1500 });
        const dict: Record<string, string> = {};
        for (const line of out.split(/\r?\n/u)) {
          const match = line.match(/^\s*(\w+)\s*:\s*(.+)$/);
          if (match && match[1] && match[2]) {
            dict[match[1]] = match[2].trim();
          }
        }
        if (dict.HTTPEnable === "1" && dict.HTTPProxy && dict.HTTPPort) {
          cachedSystemProxy.HTTP_PROXY = `http://${dict.HTTPProxy}:${dict.HTTPPort}`;
          cachedSystemProxy.http_proxy = cachedSystemProxy.HTTP_PROXY;
        }
        if (dict.HTTPSEnable === "1" && dict.HTTPSProxy && dict.HTTPSPort) {
          cachedSystemProxy.HTTPS_PROXY = `http://${dict.HTTPSProxy}:${dict.HTTPSPort}`;
          cachedSystemProxy.https_proxy = cachedSystemProxy.HTTPS_PROXY;
        }
        if (dict.SOCKSEnable === "1" && dict.SOCKSProxy && dict.SOCKSPort) {
          cachedSystemProxy.ALL_PROXY = `socks5://${dict.SOCKSProxy}:${dict.SOCKSPort}`;
          cachedSystemProxy.all_proxy = cachedSystemProxy.ALL_PROXY;
        }
      } catch {
        // Ignore errors when querying scutil
      }
    }
    Object.assign(result, cachedSystemProxy);
  }

  const activeProxy =
    result.HTTPS_PROXY ||
    result.https_proxy ||
    result.HTTP_PROXY ||
    result.http_proxy ||
    result.ALL_PROXY ||
    result.all_proxy;

  if (activeProxy) {
    appendLocalhostNoProxy(result);
  }

  if (!result.CODEX_DELIVERY_ROOT || result.CODEX_DELIVERY_ROOT.trim() === "") {
    const home = result.HOME?.trim() || os.homedir();
    result.CODEX_DELIVERY_ROOT = path.join(home, "PycharmProjects", "codex");
  }

  return result;
}

export class AntigravityExecutableError extends Error {
  readonly code = "ANTIGRAVITY_NOT_FOUND";

  constructor(message = "Antigravity CLI (agy) is not installed") {
    super(message);
    this.name = "AntigravityExecutableError";
  }
}

export const antigravityDiscoverySpec: HarnessDiscoverySpec = {
  id: "antigravity",
  command: "agy",
  commandEnvironmentVariable: ANTIGRAVITY_COMMAND_ENV,
  installRoots: {
    posix: [
      "~/.local/bin",
      "~/.antigravity/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: ["${LOCALAPPDATA}/agy/bin", "${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};

export function resolveAntigravityExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const platform = input.platform ?? process.platform;
  const environment = resolveAntigravityProxyEnvironment(
    input.environment ?? process.env,
    platform,
  );
  const resolution = resolveHarnessExecutable(antigravityDiscoverySpec, {
    ...(input.command ? { command: input.command } : {}),
    environment,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform,
  });
  if (!resolution) throw new AntigravityExecutableError();
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}

export function antigravityModelsInvocation(
  executable: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  const env = resolveAntigravityProxyEnvironment(environment, platform);
  return commandInvocation(executable, ["models"], env, platform);
}

export function antigravitySessionInvocation(
  executable: string,
  input: {
    cwd?: string;
    conversationId?: string;
    model?: string;
    effort?: string;
    printTimeout?: string;
    skipPermissions?: boolean;
    logFile?: string;
  },
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  const env = resolveAntigravityProxyEnvironment(environment, platform);
  const arguments_ = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    input.printTimeout ?? DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,
  ];
  if (input.conversationId) arguments_.push("--conversation", input.conversationId);
  if (input.model) arguments_.push("--model", input.model);
  if (input.effort) arguments_.push("--effort", input.effort);
  // Antigravity is configured for unattended Host work by default. The
  // configured-permissions mode remains an explicit opt-in from the picker.
  if (input.skipPermissions === true) arguments_.push("--dangerously-skip-permissions");
  if (input.cwd) arguments_.push("--add-dir", input.cwd);
  if (input.logFile) arguments_.push("--log-file", input.logFile);
  return commandInvocation(executable, arguments_, env, platform);
}
