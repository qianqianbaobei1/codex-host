import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HostAgentMessageItem,
  HostCommandExecutionItem,
  HostReasoningItem,
  HostToolExecutionItem,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
} from "@codexhost/shared-contracts";

import { projectAntigravityFileChange } from "./file-change.js";

const antigravityHarnessId: HarnessId = harnessIdSchema.parse("antigravity");

export interface RawTranscriptStep {
  step_index: number;
  source: string;
  type: string;
  status: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  thought?: string;
  reasoning?: string;
  tool_calls?: Array<{
    name: string;
    args?: Record<string, unknown>;
  }>;
}

export function resolveAntigravityTranscriptPath(
  conversationId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const root =
    environment.ANTIGRAVITY_APP_DATA_DIR ??
    environment.CODEXHOST_ANTIGRAVITY_DATA_DIR ??
    path.join(os.homedir(), ".gemini", "antigravity-cli");
  return path.join(root, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

function cleanUserContent(raw: string): string {
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/u.exec(raw);
  if (match && match[1]) {
    return match[1].trim();
  }
  return raw.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseToolArgs(rawArgs: unknown): Record<string, unknown> {
  if (!isRecord(rawArgs)) return {};
  const parsed: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(rawArgs)) {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
      ) {
        try {
          parsed[key] = JSON.parse(trimmed);
          continue;
        } catch {
          // not JSON, keep string
        }
      }
      parsed[key] = val;
    } else {
      parsed[key] = val;
    }
  }
  return parsed;
}

interface InFlightTool {
  stepIndex: number;
  callIndex: number;
  toolName: string;
  args: Record<string, unknown>;
}

export function parseTranscriptTurns(
  rawLines: string[],
  conversationId: string,
  cwd?: string,
): HostTurnSnapshot[] {
  const turns: HostTurnSnapshot[] = [];

  let currentInput: string | null = null;
  let currentItems: HostTurnSnapshot["items"] = [];
  let turnNumber = 0;
  let pendingTools: InFlightTool[] = [];

  const finalizeCurrentTurn = () => {
    if (currentInput === null) return;
    turnNumber += 1;
    const nativeTurnKey = `${conversationId}:turn:${turnNumber}`;
    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: antigravityHarnessId,
      nativeSessionId: conversationId,
      nativeTurnKey,
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: antigravityHarnessId,
      nativeSessionId: conversationId,
      checkpointId: nativeTurnKey,
      formatVersion: 1,
    });

    turns.push({
      nativeTurnRef,
      checkpoint,
      input: [{ type: "text", text: currentInput }],
      items: currentItems,
      outcome: { status: "succeeded" },
    });

    currentInput = null;
    currentItems = [];
    pendingTools = [];
  };

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let step: RawTranscriptStep;
    try {
      step = JSON.parse(trimmed) as RawTranscriptStep;
    } catch {
      continue;
    }

    if (step.type === "USER_INPUT") {
      finalizeCurrentTurn();
      currentInput = cleanUserContent(step.content ?? "");
      continue;
    }

    if (currentInput === null) {
      if (step.type === "PLANNER_RESPONSE" || step.type === "GENERIC") {
        currentInput = "...";
      } else {
        continue;
      }
    }

    const turnIndex = turnNumber + 1;
    const stepIndex = step.step_index ?? currentItems.length;

    if (step.type === "PLANNER_RESPONSE") {
      const thinkingText = step.thinking || step.thought || step.reasoning;
      if (thinkingText && thinkingText.trim()) {
        const reasoningItem: HostReasoningItem = {
          type: "reasoning",
          itemId: hostItemIdSchema.parse(
            `antigravity:${conversationId}:turn-${turnIndex}:step-${stepIndex}:reasoning`,
          ),
          text: thinkingText,
        };
        currentItems.push({ item: reasoningItem, outcome: { status: "succeeded" } });
      }

      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        for (let callIndex = 0; callIndex < step.tool_calls.length; callIndex += 1) {
          const call = step.tool_calls[callIndex];
          if (!call || typeof call.name !== "string") continue;
          const parsedArgs = parseToolArgs(call.args);
          pendingTools.push({
            stepIndex,
            callIndex,
            toolName: call.name,
            args: parsedArgs,
          });
        }
      }

      if (step.content && step.content.trim()) {
        const agentItem: HostAgentMessageItem = {
          type: "agentMessage",
          itemId: hostItemIdSchema.parse(
            `antigravity:${conversationId}:turn-${turnIndex}:step-${stepIndex}:agent`,
          ),
          text: step.content,
        };
        currentItems.push({ item: agentItem, outcome: { status: "succeeded" } });
      }
    } else if (step.type === "GENERIC") {
      const outputText = step.content ?? "";
      const inFlight = pendingTools.shift();
      if (inFlight) {
        const toolItemId = hostItemIdSchema.parse(
          `antigravity:${conversationId}:turn-${turnIndex}:step-${inFlight.stepIndex}:tool-${inFlight.callIndex}`,
        );

        const fileChange = projectAntigravityFileChange(
          inFlight.toolName,
          inFlight.args,
          cwd ?? process.cwd(),
        );

        if (inFlight.toolName === "run_command") {
          const commandStr =
            typeof inFlight.args.CommandLine === "string"
              ? inFlight.args.CommandLine
              : JSON.stringify(inFlight.args);

          const exitCodeMatch = /The command exited with code (\d+)/u.exec(outputText);
          const exitCode = exitCodeMatch ? Number.parseInt(exitCodeMatch[1] as string, 10) : 0;
          const outputMatch = /Output:\s*\n([\s\S]*)$/u.exec(outputText);
          const formattedOutput = outputMatch ? (outputMatch[1] as string) : outputText;

          const cmdItem: HostCommandExecutionItem = {
            type: "commandExecution",
            itemId: toolItemId,
            command: commandStr,
            ...(typeof inFlight.args.Cwd === "string" ? { cwd: inFlight.args.Cwd } : {}),
            output: formattedOutput,
            exitCode,
          };
          currentItems.push({
            item: cmdItem,
            outcome:
              exitCode === 0
                ? { status: "succeeded" }
                : {
                    status: "failed",
                    error: {
                      code: "nativeFailure",
                      message: `Command exited with code ${exitCode}`,
                      retryable: false,
                    },
                  },
          });
        } else {
          const argsResult = jsonValueSchema.safeParse(inFlight.args);
          const toolItem: HostToolExecutionItem = {
            type: "toolExecution",
            itemId: toolItemId,
            toolName: inFlight.toolName,
            arguments: argsResult.success ? argsResult.data : {},
            output: {
              content: [{ type: "text", text: outputText }],
            },
          };

          currentItems.push({
            item: toolItem,
            outcome: { status: "succeeded" },
          });
        }

        if (fileChange) {
          const fileChangeItemId = hostItemIdSchema.parse(
            `antigravity:${conversationId}:turn-${turnIndex}:step-${inFlight.stepIndex}:fileChange-${inFlight.callIndex}`,
          );
          currentItems.push({
            item: {
              type: "fileChange",
              itemId: fileChangeItemId,
              changes: [fileChange],
            },
            outcome: { status: "succeeded" },
          });
        }
      }
    }
  }

  finalizeCurrentTurn();
  return turns;
}

export async function readAntigravityTranscript(
  filePath: string,
  conversationId: string,
  cwd?: string,
): Promise<HostTurnSnapshot[] | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/u);
    return parseTranscriptTurns(lines, conversationId, cwd);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}
