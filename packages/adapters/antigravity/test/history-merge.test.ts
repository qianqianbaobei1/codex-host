import { describe, expect, it } from "vitest";
import { nativeTurnRefSchema } from "@codexhost/shared-contracts";
import type { HostTurnSnapshot } from "@codexhost/harness-adapter";

import { mergeAntigravityHistoryTurns } from "../src/history.js";

function turn(key: string): HostTurnSnapshot {
  return {
    nativeTurnRef: nativeTurnRefSchema.parse({
      harnessId: "antigravity",
      nativeSessionId: "conversation-merge-test",
      nativeTurnKey: key,
      formatVersion: 1,
    }),
    input: [],
    items: [],
    outcome: { status: "succeeded" },
  } as unknown as HostTurnSnapshot;
}

describe("mergeAntigravityHistoryTurns", () => {
  it("keeps Native turns that the sidecar never recorded", () => {
    const native = [turn("conversation-merge-test:turn:3"), turn("conversation-merge-test:turn:2")];
    const sidecar = [turn("conversation-merge-test:turn:1")];
    const merged = mergeAntigravityHistoryTurns(native, sidecar);
    expect(merged.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey)).toEqual([
      "conversation-merge-test:turn:1",
      "conversation-merge-test:turn:2",
      "conversation-merge-test:turn:3",
    ]);
  });

  it("prefers Native content over a sidecar duplicate of the same Turn", () => {
    const native = [{ ...turn("conversation-merge-test:turn:1") }];
    // same key, different payload in the sidecar (stale tool output)
    const stale = { ...turn("conversation-merge-test:turn:1") };
    (stale as { outcome: { status: string } }).outcome = { status: "failed" } as never;
    const merged = mergeAntigravityHistoryTurns(native, [stale]);
    expect(merged).toHaveLength(1);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.outcome.status).toBe("succeeded");
  });

  it("keeps sidecar-only Turns so the final reply before a crash survives", () => {
    const native = [turn("conversation-merge-test:turn:1")];
    const sidecar = [
      turn("conversation-merge-test:turn:1"),
      turn("conversation-merge-test:turn:2"),
    ];
    const merged = mergeAntigravityHistoryTurns(native, sidecar);
    expect(merged.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey)).toEqual([
      "conversation-merge-test:turn:1",
      "conversation-merge-test:turn:2",
    ]);
  });

  it("returns the sidecar as-is when Native history is empty", () => {
    const sidecar = [
      turn("conversation-merge-test:turn:2"),
      turn("conversation-merge-test:turn:1"),
    ];
    expect(mergeAntigravityHistoryTurns([], sidecar)).toEqual(sidecar);
  });
});
