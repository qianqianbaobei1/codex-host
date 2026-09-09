import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { hostItemIdSchema, nativeTurnRefSchema } from "@codexhost/shared-contracts";

import { AntigravityHistory } from "../src/history-sidecar.js";

describe("AntigravityHistory compatibility", () => {
  it("fills missing historical tool output without changing the Turn identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-history-"));
    const threadId = "history-sidecar-test";
    const conversationId = "conversation-history-test";
    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: "antigravity",
      nativeSessionId: conversationId,
      nativeTurnKey: `${conversationId}:turn:1`,
      formatVersion: 1,
    });
    const item = {
      type: "toolExecution" as const,
      itemId: hostItemIdSchema.parse("antigravity:history-sidecar-test:tool"),
      toolName: "run_command",
      arguments: {},
    };
    try {
      const file = path.join(root, "antigravity-history", `${threadId}.json`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `${JSON.stringify({
          formatVersion: 1,
          nativeSessionId: conversationId,
          turns: [
            {
              nativeTurnRef,
              input: [{ type: "text", text: "continue" }],
              items: [{ item, outcome: { status: "succeeded" } }],
              outcome: { status: "succeeded" },
            },
          ],
        })}\n`,
        "utf8",
      );

      const history = await AntigravityHistory.open({
        environment: { CODEXHOST_DATA_DIR: root, CODEXHOST_THREAD_ID: threadId },
        nativeSessionId: conversationId,
      });
      expect(history.snapshot()[0]?.items[0]?.item).toMatchObject({
        type: "toolExecution",
        output: { content: [] },
      });

      const secondTurnRef = nativeTurnRefSchema.parse({
        ...nativeTurnRef,
        nativeTurnKey: `${conversationId}:turn:2`,
      });
      history.append({
        nativeTurnRef: secondTurnRef,
        turnInput: [{ type: "text", text: "again" }],
        items: [{ item, outcome: { status: "succeeded" } }],
        outcome: { status: "succeeded" },
      });
      await history.flush();
      const persisted = JSON.parse(await readFile(file, "utf8")) as {
        turns: Array<{ items: Array<{ item: { output?: { content?: unknown[] } } }> }>;
      };
      expect(persisted.turns[1]?.items[0]?.item.output).toEqual({ content: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
