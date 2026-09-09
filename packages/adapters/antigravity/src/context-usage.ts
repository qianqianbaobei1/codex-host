/**
 * Real context usage via agy's local Language Server (gRPC-over-HTTPS).
 *
 * Imported from the upstream CodexHost adapter (PR #84, `feat/antigravity`):
 * agy logs "Language server listening on random port at <port> for HTTPS
 * (gRPC)" into its `--log-file`; we read that port, POST a
 * `GetCascadeTrajectoryGeneratorMetadata` request over HTTPS, and project the
 * real `contextUsedTokens` / `contextWindowTokens` counters. The CLI's own
 * `step_update`/`result` usage does not carry these.
 *
 * Kept as a standalone module so the Session orchestration only calls
 * `pollAntigravityContextUsage` fire-and-forget per Turn.
 */
import { readFile } from "node:fs/promises";
import https from "node:https";
import type { HostUsage } from "@codexhost/harness-adapter";

export const CONTEXT_USAGE_TIMEOUT_MS = 8_000;
export const CONTEXT_USAGE_RETRY_MS = 100;
/** agy's Gemini status line uses a 1 Mi-token window while LS metadata reports 256k. */
export const GEMINI_CONTEXT_WINDOW_TOKENS = 1_048_576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function contextWindowMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const trajectory = isRecord(value.trajectory) ? value.trajectory : value;
  const generatorMetadata = trajectory.generatorMetadata;
  if (!Array.isArray(generatorMetadata)) return null;
  const first = generatorMetadata[0];
  if (!isRecord(first) || !isRecord(first.chatModel)) return null;
  const chatStartMetadata = first.chatModel.chatStartMetadata;
  if (!isRecord(chatStartMetadata) || !isRecord(chatStartMetadata.contextWindowMetadata)) {
    return null;
  }
  return chatStartMetadata.contextWindowMetadata;
}

/** Parses the real context counters exposed by agy's local Language Server. */
export function parseAntigravityContextUsage(
  value: unknown,
  modelId?: string,
): Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null {
  const metadata = contextWindowMetadata(value);
  if (!metadata) return null;
  const breakdown = isRecord(metadata.tokenBreakdown) ? metadata.tokenBreakdown : null;
  const used = safeToken(
    metadata.estimatedTokensUsed ??
      metadata.estimated_tokens_used ??
      breakdown?.totalTokens ??
      breakdown?.total_tokens,
  );
  const window = safeToken(metadata.maxContextTokens ?? metadata.max_context_tokens);
  if (used === undefined || window === undefined || window <= 0) return null;
  // agy's Gemini status line uses a 1 Mi-token window while LS metadata reports 256k.
  const contextWindowTokens =
    /^gemini(?:[-_.]|$)/iu.test(modelId ?? "") && window === 256_000
      ? GEMINI_CONTEXT_WINDOW_TOKENS
      : window;
  return { contextUsedTokens: used, contextWindowTokens };
}

function requestAntigravityContextUsage(
  port: number,
  conversationId: string,
  timeoutMs: number,
  modelId?: string,
): Promise<Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null> {
  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata",
        method: "POST",
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: { "content-type": "application/json" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return resolve(null);
          try {
            resolve(parseAntigravityContextUsage(JSON.parse(body), modelId));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end(
      JSON.stringify({
        cascadeId: conversationId,
        generatorMetadataOffset: 0,
        includeMessages: false,
      }),
    );
  });
}

/** Extracts the Language Server HTTPS port from an agy `--log-file`. */
export async function antigravityHttpsPort(logPath: string): Promise<number | null> {
  try {
    const log = await readFile(logPath, "utf8");
    const match = log.match(
      /Language server listening on random port at (\d+) for HTTPS \(gRPC\)/iu,
    );
    const port = match ? Number(match[1]) : Number.NaN;
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Polls the Language Server until the context metadata for the conversation is
 * available (or the deadline passes), then resolves to real context counters.
 * Never rejects; returns null when the LS is unreachable or not yet warmed.
 */
export async function pollAntigravityContextUsage(
  logPath: string,
  conversationId: string,
  modelId?: string,
): Promise<Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null> {
  const deadline = Date.now() + CONTEXT_USAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const port = await antigravityHttpsPort(logPath);
    if (port !== null) {
      const usage = await requestAntigravityContextUsage(
        port,
        conversationId,
        CONTEXT_USAGE_RETRY_MS,
        modelId,
      );
      if (usage) return usage;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CONTEXT_USAGE_RETRY_MS));
  }
  return null;
}
