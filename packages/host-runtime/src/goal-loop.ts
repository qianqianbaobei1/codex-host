import type { StoredExternalGoalV1 } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  hostTurnIdSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";
import { randomUUID } from "node:crypto";

export const GOAL_MAX_OBJECTIVE_LENGTH = 4_000;
export const GOAL_MAX_LOOP_TURNS = 50;
export const GOAL_STALL_THRESHOLD = 3;

export type ThreadGoalStatus =
  "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

export type GoalLoopStatus = ThreadGoalStatus;

export type GoalStopReason =
  | "same_blocker"
  | "no_progress"
  | "max_turns"
  | "user_pause"
  | "user_interrupt"
  | "runtime_error"
  | "usage_limit"
  | "token_budget"
  | "completion_audit_failed";

export type GoalDecisionKind = "continue" | "complete" | "blocked";

export interface GoalTurnDecision {
  version: 1;
  kind: GoalDecisionKind;
  goalId?: string;
  goalRevision?: number;
  progressEvidence: JsonObject[];
  completionEvidence: JsonObject[];
  blockerFingerprint?: string;
  blockerCategory?: string;
}

export interface GoalLoopState {
  readonly goalId: string;
  objective: string;
  tokenBudget?: number;
  tokensUsed: number;
  consecutiveNoProgress: number;
  loopTurnCount: number;
  status: ThreadGoalStatus;
  stopReason?: GoalStopReason;
  revision: number;
  lastCompletedTurnId?: string;
  inFlightTurnId?: string;
  blockerFingerprint?: string;
  blockerStallCount: number;
  lastProgressAtMs?: number;
  usageBaselineTokens?: number;
  usageTotalTokens?: number;
  readonly createdAtMs: number;
  updatedAtMs: number;
  timeUsedSeconds: number;
}

export type ThreadGoal = {
  id: string;
  origin: "codexhost";
  objective: string;
  status: ThreadGoalStatus;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  tokenBudget: number | null;
  tokensUsed: number;
  stopReason: GoalStopReason | null;
  [key: string]: JsonValue;
};

const GOAL_COMMAND = "/goal";
const GOAL_DONE_MARKER = "goal.done";
const GOAL_CONTINUE_PROMPT = "%%GOAL_CONTINUE%%";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function jsonObjects(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is JsonObject => jsonValueSchema.safeParse(item).success && isRecord(item),
  );
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Parse a `/goal <objective>` command without accepting `/goalist` as `/goal`. */
export function parseGoalCommand(text: string): { objective: string; tokenBudget?: number } | null {
  const trimmed = text.trim();
  const command = trimmed.match(/^\/goal(?:\s+|$)/iu);
  if (!command) return null;

  let rest = trimmed.slice(command[0].length).trim();
  if (!rest) return null;

  let tokenBudget: number | undefined;
  const budgetMatch = rest.match(
    /(?:[,，;；]\s*|^)(?:token\s*)?预算\s*[:：]\s*(\d+)|[,，;；]\s*budget\s*[:：]\s*(\d+)/iu,
  );
  if (budgetMatch) {
    const value = Number(budgetMatch[1] ?? budgetMatch[2]);
    if (Number.isSafeInteger(value) && value > 0) tokenBudget = value;
    rest = rest.replace(budgetMatch[0], "").trim();
  }
  rest = rest.replace(/^[,，;；\s]+/u, "").trim();
  return rest ? { objective: rest, ...(tokenBudget ? { tokenBudget } : {}) } : null;
}

/** Create a fresh external Goal state. */
export function createGoalLoop(
  objective: string,
  tokenBudget?: number,
  nowMs = Date.now(),
): GoalLoopState {
  const normalized = objective.trim();
  if (!normalized) throw new Error("Goal objective must not be empty");
  if (normalized.length > GOAL_MAX_OBJECTIVE_LENGTH) {
    throw new Error(`Goal objective must be at most ${GOAL_MAX_OBJECTIVE_LENGTH} characters`);
  }
  if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
    throw new Error("Goal tokenBudget must be a positive safe integer");
  }
  return {
    goalId: randomUUID(),
    objective: normalized,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    tokensUsed: 0,
    consecutiveNoProgress: 0,
    loopTurnCount: 0,
    status: "active",
    revision: 1,
    blockerStallCount: 0,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    timeUsedSeconds: 0,
  };
}

export function fromStoredGoal(goal: StoredExternalGoalV1): GoalLoopState {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    tokensUsed: goal.tokensUsed,
    consecutiveNoProgress: goal.noProgressCount,
    loopTurnCount: goal.turnCount,
    status: goal.status,
    ...(goal.stopReason ? { stopReason: goal.stopReason } : {}),
    revision: goal.revision,
    ...(goal.lastCompletedTurnId ? { lastCompletedTurnId: goal.lastCompletedTurnId } : {}),
    ...(goal.inFlightTurnId ? { inFlightTurnId: goal.inFlightTurnId } : {}),
    ...(goal.blockerFingerprint ? { blockerFingerprint: goal.blockerFingerprint } : {}),
    blockerStallCount: goal.blockerStallCount,
    ...(goal.lastProgressAt ? { lastProgressAtMs: Date.parse(goal.lastProgressAt) } : {}),
    ...(goal.usageBaselineTokens !== undefined
      ? { usageBaselineTokens: goal.usageBaselineTokens }
      : {}),
    ...(goal.usageTotalTokens !== undefined ? { usageTotalTokens: goal.usageTotalTokens } : {}),
    createdAtMs: Date.parse(goal.createdAt),
    updatedAtMs: Date.parse(goal.updatedAt),
    timeUsedSeconds: goal.timeUsedSeconds,
  };
}

export function toStoredGoal(goal: GoalLoopState, harnessId: string): StoredExternalGoalV1 {
  return {
    formatVersion: 1,
    goalId: goal.goalId,
    origin: "codexhost",
    harnessId: harnessIdSchema.parse(harnessId),
    objective: goal.objective,
    status: goal.status,
    ...(goal.stopReason ? { stopReason: goal.stopReason } : {}),
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    revision: goal.revision,
    turnCount: goal.loopTurnCount,
    noProgressCount: goal.consecutiveNoProgress,
    ...(goal.lastCompletedTurnId
      ? { lastCompletedTurnId: hostTurnIdSchema.parse(goal.lastCompletedTurnId) }
      : {}),
    ...(goal.inFlightTurnId ? { inFlightTurnId: hostTurnIdSchema.parse(goal.inFlightTurnId) } : {}),
    ...(goal.blockerFingerprint ? { blockerFingerprint: goal.blockerFingerprint } : {}),
    blockerStallCount: goal.blockerStallCount,
    ...(goal.lastProgressAtMs !== undefined
      ? { lastProgressAt: new Date(goal.lastProgressAtMs).toISOString() }
      : {}),
    ...(goal.usageBaselineTokens !== undefined
      ? { usageBaselineTokens: goal.usageBaselineTokens }
      : {}),
    ...(goal.usageTotalTokens !== undefined ? { usageTotalTokens: goal.usageTotalTokens } : {}),
    createdAt: new Date(goal.createdAtMs).toISOString(),
    updatedAt: new Date(goal.updatedAtMs).toISOString(),
  };
}

export function toThreadGoal(goal: GoalLoopState): ThreadGoal {
  return {
    id: goal.goalId,
    origin: "codexhost",
    objective: goal.objective,
    status: goal.status,
    timeUsedSeconds: Math.max(0, Math.floor(goal.timeUsedSeconds)),
    createdAt: Math.floor(goal.createdAtMs / 1000),
    updatedAt: Math.floor(goal.updatedAtMs / 1000),
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed,
    stopReason: goal.stopReason ?? null,
  };
}

export function updateGoalActiveTime(goal: GoalLoopState, nowMs = Date.now()): void {
  if (goal.status === "active") {
    goal.timeUsedSeconds += Math.max(0, (nowMs - goal.updatedAtMs) / 1000);
  }
  goal.updatedAtMs = nowMs;
}

export function setGoalStatus(
  goal: GoalLoopState,
  newStatus: ThreadGoalStatus,
  nowMs = Date.now(),
  stopReason?: GoalStopReason,
): void {
  updateGoalActiveTime(goal, nowMs);
  goal.status = newStatus;
  if (newStatus === "active") delete goal.stopReason;
  else if (stopReason) goal.stopReason = stopReason;
}

function decisionLine(response: string): JsonObject | null {
  const line = response.trim().split(/\r?\n/u).at(-1)?.trim();
  if (!line || !line.startsWith("{") || !line.endsWith("}")) return null;
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(line));
    return parsed.success && isRecord(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Parse only a complete JSON terminal line; quoted prose cannot trigger a decision. */
export function parseGoalDecision(response: string): GoalTurnDecision | null {
  const value = decisionLine(response);
  if (!value || value.version !== 1) return null;
  const kind = value.goal_event;
  if (kind !== "continue" && kind !== "complete" && kind !== "blocked") return null;
  const goalRevision = safeNonNegativeInteger(value.goal_revision);
  const goalId = nonBlankString(value.goal_id);
  const blockerFingerprint = nonBlankString(value.blocker_fingerprint);
  if (kind === "blocked" && !blockerFingerprint) return null;
  const blockerCategory = nonBlankString(value.blocker_category);
  return {
    version: 1,
    kind,
    ...(goalId ? { goalId } : {}),
    ...(goalRevision !== undefined ? { goalRevision } : {}),
    progressEvidence: jsonObjects(value.progress_evidence),
    completionEvidence: jsonObjects(value.completion_evidence),
    ...(blockerFingerprint ? { blockerFingerprint } : {}),
    ...(blockerCategory ? { blockerCategory } : {}),
  };
}

/** Build the first-turn contract that seeds the goal into a Harness. */
export function goalSeedPrompt(goal: GoalLoopState): string {
  const budgetLine =
    goal.tokenBudget !== undefined
      ? `\n本目标总 token 预算为 ${goal.tokenBudget}；预算耗尽由宿主停止，不要伪造完成。`
      : "";
  return [
    `目标：${goal.objective}${budgetLine}`,
    "请开始推进目标，并以文件、测试、产物或 LoopX 审计作为进展依据。",
    "只有目标已被可验证地完成时，才输出 complete；无法继续时输出 blocked。",
    "报告必须是回复最后一行的单独 JSON，不能放在解释文字中：",
    `{"version":1,"goal_event":"complete","goal_id":"${goal.goalId}","goal_revision":${goal.revision},"completion_evidence":[...]}`,
    `blocked 示例：{"version":1,"goal_event":"blocked","goal_id":"${goal.goalId}","goal_revision":${goal.revision},"blocker_fingerprint":"auth_required:github","blocker_category":"auth_required"}`,
    "没有完成或阻塞时不要输出 JSON 决策行；不要询问是否继续。",
  ].join("\n");
}

export function goalContinuePrompt(goal?: GoalLoopState): string {
  const prefix = goal
    ? `当前目标（goalId=${goal.goalId}, revision=${goal.revision}）：${goal.objective}\n`
    : "";
  return [
    `${GOAL_CONTINUE_PROMPT}\n${prefix}请继续推进尚未完成的子任务。`,
    "先检查当前工作区、Todo 和证据，不要重复已经完成的工作。",
    "只有可验证完成时才输出最后一行 JSON complete；确实无法继续时输出 JSON blocked。",
  ].join("\n");
}

/** Kept for compatibility with callers; production completion uses parseGoalDecision. */
export function isGoalDone(response: string): boolean {
  return response.split(/\r?\n/u).some((line) => line.trim() === GOAL_DONE_MARKER);
}

export function lastAgentMessageText(turn: unknown): string {
  if (!isRecord(turn) || !Array.isArray(turn.items)) return "";
  const parts: string[] = [];
  for (const item of turn.items) {
    if (!isRecord(item) || item.type !== "agentMessage") continue;
    if (typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (!isRecord(item.output) || !Array.isArray(item.output.content)) continue;
    for (const part of item.output.content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

/** Evidence-based progress heuristic used only when no external evaluator is configured. */
export function hasTurnProgress(turn: unknown, decision: GoalTurnDecision | null = null): boolean {
  if (decision?.progressEvidence.length) return true;
  if (!isRecord(turn) || !Array.isArray(turn.items)) return false;
  return turn.items.some((item) => {
    if (!isRecord(item)) return false;
    if (item.type === "fileChange") return true;
    if (item.type === "commandExecution") {
      return item.status === "completed" && item.exitCode !== 1;
    }
    return item.type === "toolExecution" && item.status === "completed" && item.success !== false;
  });
}

export function advanceGoalLoop(
  goal: GoalLoopState,
  tokensThisTurn: number,
  madeProgress: boolean,
  nowMs = Date.now(),
  blockerFingerprint?: string,
): GoalLoopStatus {
  if (goal.status !== "active") return goal.status;
  updateGoalActiveTime(goal, nowMs);
  goal.tokensUsed +=
    Number.isSafeInteger(tokensThisTurn) && tokensThisTurn > 0 ? tokensThisTurn : 0;
  goal.loopTurnCount += 1;

  if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    goal.status = "budget_limited";
    goal.stopReason = "token_budget";
    return goal.status;
  }
  if (goal.loopTurnCount >= GOAL_MAX_LOOP_TURNS) {
    goal.status = "blocked";
    goal.stopReason = "max_turns";
    return goal.status;
  }
  if (madeProgress) {
    goal.consecutiveNoProgress = 0;
    goal.blockerStallCount = 0;
    delete goal.blockerFingerprint;
    goal.lastProgressAtMs = nowMs;
    return goal.status;
  }

  goal.consecutiveNoProgress += 1;
  if (blockerFingerprint) {
    if (goal.blockerFingerprint === blockerFingerprint) goal.blockerStallCount += 1;
    else {
      goal.blockerFingerprint = blockerFingerprint;
      goal.blockerStallCount = 1;
    }
    if (goal.blockerStallCount >= GOAL_STALL_THRESHOLD) {
      goal.status = "blocked";
      goal.stopReason = "same_blocker";
    }
  } else if (goal.consecutiveNoProgress >= GOAL_STALL_THRESHOLD) {
    goal.status = "blocked";
    goal.stopReason = "no_progress";
  }
  return goal.status;
}

export { GOAL_COMMAND, GOAL_CONTINUE_PROMPT, GOAL_DONE_MARKER };
