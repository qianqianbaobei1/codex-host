import type {
  HistoricalTurnOutcome,
  HostAgentMessageItem,
  HostItemOutcome,
  HostThreadSnapshot,
  HostTurnSnapshot,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
} from "@codexhost/shared-contracts";

import type { AntigravityLedgerData, AntigravityLedgerTurn } from "./ledger.js";
import { encodeAntigravityModelRef } from "./model-catalog.js";
import {
  readAntigravityTranscript,
  resolveAntigravityTranscriptPath,
} from "./transcript.js";

const antigravityHarnessId: HarnessId = harnessIdSchema.parse("antigravity");

function outcomeForTurn(turn: AntigravityLedgerTurn): HistoricalTurnOutcome {
  if (turn.status === "succeeded") return { status: "succeeded" };
  if (turn.status === "cancelled") {
    return { status: "cancelled", reason: turn.error ?? "Cancelled by user" };
  }
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message: turn.error ?? "Antigravity Turn failed",
      retryable: false,
    },
  };
}

function itemOutcome(outcome: HistoricalTurnOutcome): HostItemOutcome {
  if (outcome.status === "failed") return { status: "failed", error: outcome.error };
  if (outcome.status === "cancelled") {
    return { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
  return { status: "succeeded" };
}

function turnSnapshot(sessionId: string, turn: AntigravityLedgerTurn): HostTurnSnapshot {
  const nativeTurnRef = nativeTurnRefSchema.parse({
    harnessId: antigravityHarnessId,
    nativeSessionId: sessionId,
    nativeTurnKey: turn.nativeTurnKey,
    formatVersion: 1,
  });
  const checkpoint = nativeCheckpointRefSchema.parse({
    harnessId: antigravityHarnessId,
    nativeSessionId: sessionId,
    checkpointId: turn.nativeTurnKey,
    formatVersion: 1,
  });
  const outcome = outcomeForTurn(turn);
  const items: HostTurnSnapshot["items"] = [];
  if (turn.response.length > 0) {
    const item: HostAgentMessageItem = {
      type: "agentMessage",
      itemId: hostItemIdSchema.parse(`antigravity:${turn.nativeTurnKey}:agent`),
      text: turn.response,
    };
    items.push({ item, outcome: itemOutcome(outcome) });
  }
  return {
    nativeTurnRef,
    checkpoint,
    input: [{ type: "text", text: turn.input }],
    items,
    outcome,
    ...(turn.modelSlug ? { model: encodeAntigravityModelRef(turn.modelSlug) } : {}),
  };
}

export function mapAntigravitySnapshot(
  data: AntigravityLedgerData,
  state: HarnessSessionState,
): HostThreadSnapshot {
  return {
    turns: data.turns.map((turn) => turnSnapshot(data.conversationId, turn)),
    state,
  };
}

export function mergeAntigravityHistoryTurns(
  nativeTurns: readonly HostTurnSnapshot[],
  sidecarTurns: readonly HostTurnSnapshot[],
): HostTurnSnapshot[] {
  if (nativeTurns.length === 0) return [...sidecarTurns];
  const byKey = new Map<string, HostTurnSnapshot>();
  for (const turn of nativeTurns) byKey.set(turn.nativeTurnRef.nativeTurnKey, turn);
  for (const turn of sidecarTurns) {
    const key = turn.nativeTurnRef.nativeTurnKey;
    if (!byKey.has(key)) byKey.set(key, turn);
  }
  return [...byKey.values()].sort((a, b) => {
    const indexA = nativeTurnIndex(a);
    const indexB = nativeTurnIndex(b);
    if (indexA !== indexB) return indexA - indexB;
    return a.nativeTurnRef.nativeTurnKey.localeCompare(b.nativeTurnRef.nativeTurnKey);
  });
}

function nativeTurnIndex(turn: HostTurnSnapshot): number {
  const match = /:turn:(\d+)$/u.exec(turn.nativeTurnRef.nativeTurnKey ?? "");
  const index = match?.[1];
  return index ? Number.parseInt(index, 10) : Number.MAX_SAFE_INTEGER;
}

export async function loadAntigravitySnapshot(
  conversationId: string,
  state: HarnessSessionState,
  options: {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    fallbackLedger?: () => Promise<AntigravityLedgerData | null>;
  } = {},
): Promise<HostThreadSnapshot | null> {
  const transcriptPath = resolveAntigravityTranscriptPath(
    conversationId,
    options.environment ?? process.env,
  );
  const transcriptTurns = await readAntigravityTranscript(
    transcriptPath,
    conversationId,
    options.cwd,
  );
  if (transcriptTurns && transcriptTurns.length > 0) {
    return {
      turns: transcriptTurns,
      state,
    };
  }
  if (options.fallbackLedger) {
    const ledgerData = await options.fallbackLedger();
    if (ledgerData) {
      return mapAntigravitySnapshot(ledgerData, state);
    }
  }
  return null;
}
