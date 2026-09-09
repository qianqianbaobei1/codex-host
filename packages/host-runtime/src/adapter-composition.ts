import { AntigravityAdapter } from "@codexhost/adapter-antigravity";
import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { DeepSeekHarnessAdapter } from "@codexhost/adapter-deepseek-harness";
import { GrokAdapter } from "@codexhost/adapter-grok";
import { OpenCodeAdapter } from "@codexhost/adapter-opencode";
import { PiAdapter } from "@codexhost/adapter-pi";
import { OmpAdapter } from "@codexhost/adapter-omp";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { ExternalHarnessId } from "@codexhost/protocol-core";

export const CLAUDE_CODE_COMMAND_ENV = "CODEXHOST_CLAUDE_COMMAND";
export const DEEPSEEK_HARNESS_COMMAND_ENV = "CODEXHOST_DEEPSEEK_HARNESS_COMMAND";
export const DEEPSEEK_HARNESS_ENDPOINT_ENV = "CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT";
export const PI_COMMAND_ENV = "CODEXHOST_PI_COMMAND";
export const GROK_COMMAND_ENV = "CODEXHOST_GROK_COMMAND";
export const OMP_COMMAND_ENV = "CODEXHOST_OMP_COMMAND";
export const OPENCODE_COMMAND_ENV = "CODEXHOST_OPENCODE_COMMAND";
export const ANTIGRAVITY_COMMAND_ENV = "CODEXHOST_ANTIGRAVITY_COMMAND";
/** Optional ms override for the resettable inactivity budget of each Antigravity Turn. */
export const ANTIGRAVITY_IDLE_TIMEOUT_ENV = "CODEXHOST_ANTIGRAVITY_IDLE_TIMEOUT_MS";
/** Optional ms override for the absolute per-Turn ceiling of each Antigravity Turn. */
export const ANTIGRAVITY_DEADLINE_ENV = "CODEXHOST_ANTIGRAVITY_DEADLINE_MS";
/** Optional ms override for keeping an unused Antigravity Session process warm. */
export const ANTIGRAVITY_SESSION_IDLE_TIMEOUT_ENV = "CODEXHOST_ANTIGRAVITY_SESSION_IDLE_TIMEOUT_MS";

const CODEX_APP_PRIVATE_ENVIRONMENT_KEYS = new Set([
  "CODEX_APP_TOOLS_PIPE_PATH",
  "CODEX_MCP_NODE_PATH",
  "CODEX_BROWSER_USE_NODE_PATH",
  "CODEX_ELECTRON_RESOURCES_PATH",
]);

export function externalHarnessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !CODEX_APP_PRIVATE_ENVIRONMENT_KEYS.has(key)),
  );
}

function positiveIntEnv(environment: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeIntEnv(environment: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function antigravityTimeoutOptions(environment: NodeJS.ProcessEnv): {
  idleTimeoutMs?: number;
  turnDeadlineMs?: number;
  sessionIdleTimeoutMs?: number;
} {
  const options: {
    idleTimeoutMs?: number;
    turnDeadlineMs?: number;
    sessionIdleTimeoutMs?: number;
  } = {};
  const idle = positiveIntEnv(environment, ANTIGRAVITY_IDLE_TIMEOUT_ENV);
  if (idle !== undefined) options.idleTimeoutMs = idle;
  const deadline = nonNegativeIntEnv(environment, ANTIGRAVITY_DEADLINE_ENV);
  if (deadline !== undefined) options.turnDeadlineMs = deadline;
  const sessionIdle = positiveIntEnv(environment, ANTIGRAVITY_SESSION_IDLE_TIMEOUT_ENV);
  if (sessionIdle !== undefined) options.sessionIdleTimeoutMs = sessionIdle;
  return options;
}

type InspectableHarnessAdapter = Pick<HarnessAdapter, "inspect">;

export async function prefetchClaudeCodeModelCatalog(
  adapters: ReadonlyMap<ExternalHarnessId, InspectableHarnessAdapter>,
): Promise<void> {
  try {
    // AGY model discovery is an external CLI/network round trip. Keep it lazy
    // so opening the Host does not wake Gemini before the user selects it.
    await adapters.get("claude-code")?.inspect();
  } catch {
    // Startup prefetch must not affect official Codex or another Harness.
  }
}

export function createExternalHarnessAdapters(
  environment: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform;
    managedRemoteHost?: boolean;
    brokerDescriptorPath?: string;
  } = {},
): ReadonlyMap<ExternalHarnessId, HarnessAdapter> {
  const adapterEnvironment = externalHarnessEnvironment(environment);
  const claudeAdapter =
    (options.platform ?? process.platform) === "darwin" && options.managedRemoteHost === true
      ? new BrokeredHarnessAdapter({
          environment: adapterEnvironment,
          ...(options.brokerDescriptorPath ? { descriptorPath: options.brokerDescriptorPath } : {}),
        })
      : new ClaudeCodeAdapter({
          ...(environment[CLAUDE_CODE_COMMAND_ENV]
            ? { command: environment[CLAUDE_CODE_COMMAND_ENV] }
            : {}),
          environment: adapterEnvironment,
        });
  return new Map<ExternalHarnessId, HarnessAdapter>([
    [
      "pi",
      new PiAdapter({
        ...(environment[PI_COMMAND_ENV] ? { command: environment[PI_COMMAND_ENV] } : {}),
        environment: adapterEnvironment,
      }),
    ],
    ["claude-code", claudeAdapter],
    [
      "deepseek-harness",
      new DeepSeekHarnessAdapter({
        ...(environment[DEEPSEEK_HARNESS_COMMAND_ENV]
          ? { command: environment[DEEPSEEK_HARNESS_COMMAND_ENV] }
          : {}),
        ...(environment[DEEPSEEK_HARNESS_ENDPOINT_ENV]
          ? { endpoint: environment[DEEPSEEK_HARNESS_ENDPOINT_ENV] }
          : {}),
        environment: adapterEnvironment,
      }),
    ],
    [
      "opencode",
      new OpenCodeAdapter({
        ...(environment[OPENCODE_COMMAND_ENV]
          ? { command: environment[OPENCODE_COMMAND_ENV] }
          : {}),
        environment: adapterEnvironment,
      }),
    ],
    [
      "grok",
      new GrokAdapter({
        ...(environment[GROK_COMMAND_ENV] ? { command: environment[GROK_COMMAND_ENV] } : {}),
        environment: adapterEnvironment,
      }),
    ],
    [
      "omp",
      new OmpAdapter({
        ...(environment[OMP_COMMAND_ENV] ? { command: environment[OMP_COMMAND_ENV] } : {}),
        environment: adapterEnvironment,
      }),
    ],
    [
      "antigravity",
      new AntigravityAdapter({
        ...(environment[ANTIGRAVITY_COMMAND_ENV]
          ? { command: environment[ANTIGRAVITY_COMMAND_ENV] }
          : {}),
        ...antigravityTimeoutOptions(environment),
        environment: adapterEnvironment,
      }),
    ],
  ]);
}
