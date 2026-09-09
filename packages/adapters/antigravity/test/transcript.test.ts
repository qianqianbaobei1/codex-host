import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { harnessIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { HarnessSessionState } from "@codexhost/harness-adapter";

import {
  parseTranscriptTurns,
  readAntigravityTranscript,
  resolveAntigravityTranscriptPath,
} from "../src/transcript.js";
import { projectAntigravityFileChange } from "../src/file-change.js";
import { loadAntigravitySnapshot } from "../src/history.js";
import type { AntigravityLedgerData } from "../src/ledger.js";

const antigravityHarnessId = harnessIdSchema.parse("antigravity");

describe("Antigravity Transcript and File Change", () => {
  it("projects write_to_file into a unified diff file change", () => {
    const change = projectAntigravityFileChange(
      "write_to_file",
      {
        TargetFile: "/test/path/hello.py",
        CodeContent: "print('hello')\nprint('world')",
        Overwrite: false,
      },
      "/test/path",
    );
    expect(change).not.toBeNull();
    expect(change?.path).toBe("hello.py");
    expect(change?.kind).toBe("add");
    expect(change?.unifiedDiff).toContain("--- /dev/null");
    expect(change?.unifiedDiff).toContain("+++ b/hello.py");
    expect(change?.unifiedDiff).toContain("+print('hello')");
    expect(change?.unifiedDiff).toContain("+print('world')");
  });

  it("projects replace_file_content into a unified diff file change", () => {
    const change = projectAntigravityFileChange(
      "replace_file_content",
      {
        TargetFile: "/test/path/hello.py",
        StartLine: 2,
        TargetContent: "print('world')",
        ReplacementContent: "print('Antigravity')\nprint('Codex')",
      },
      "/test/path",
    );
    expect(change).not.toBeNull();
    expect(change?.path).toBe("hello.py");
    expect(change?.kind).toBe("update");
    expect(change?.unifiedDiff).toContain("--- a/hello.py");
    expect(change?.unifiedDiff).toContain("+++ b/hello.py");
    expect(change?.unifiedDiff).toContain("-print('world')");
    expect(change?.unifiedDiff).toContain("+print('Antigravity')");
  });

  it("parses transcript steps with user request, thinking, command execution, and file change", () => {
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        content:
          "<USER_REQUEST>\nCreate a script and run it\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        thinking: "Let me first write the script",
        tool_calls: [
          {
            name: "write_to_file",
            args: {
              TargetFile: "test.py",
              CodeContent: "print('success')",
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        content: "File written successfully",
      }),
      JSON.stringify({
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: '"python3 test.py"',
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 4,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        content: "The command exited with code 0.\nOutput:\nsuccess\n",
      }),
      JSON.stringify({
        step_index: 5,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "I have created and executed the script successfully.",
      }),
    ];

    const turns = parseTranscriptTurns(lines, "conv-1", "/test/dir");
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    if (!turn) throw new Error("expected turn");

    expect(turn.input).toEqual([{ type: "text", text: "Create a script and run it" }]);
    expect(turn.items.map((i) => i.item.type)).toEqual([
      "reasoning",
      "toolExecution",
      "fileChange",
      "commandExecution",
      "agentMessage",
    ]);

    const reasoning = turn.items.find((i) => i.item.type === "reasoning")?.item;
    expect(reasoning?.type).toBe("reasoning");
    if (reasoning?.type === "reasoning") {
      expect(reasoning.text).toBe("Let me first write the script");
    }

    const cmd = turn.items.find((i) => i.item.type === "commandExecution")?.item;
    expect(cmd).toMatchObject({
      command: "python3 test.py",
      output: "success\n",
      exitCode: 0,
    });

    const fileChange = turn.items.find((i) => i.item.type === "fileChange")?.item;
    expect(fileChange).toMatchObject({
      changes: [expect.objectContaining({ path: "test.py", kind: "add" })],
    });

    const agentMsg = turn.items.find((i) => i.item.type === "agentMessage")?.item;
    expect(agentMsg?.type).toBe("agentMessage");
    if (agentMsg?.type === "agentMessage") {
      expect(agentMsg.text).toBe("I have created and executed the script successfully.");
    }
  });

  it("loads snapshot from disk transcript and falls back to ledger when absent", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "antigravity-transcript-test-"));
    const convId = "test-conv-fallback-1";
    const state: HarnessSessionState = {
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: antigravityHarnessId,
        nativeSessionId: convId,
        locator: { skipPermissions: true },
        formatVersion: 1,
      }),
    };

    try {
      const fallbackData: AntigravityLedgerData = {
        version: 1,
        conversationId: convId,
        cwd: tmpDir,
        turns: [
          {
            nativeTurnKey: `${convId}:turn:1`,
            input: "Ledger input",
            response: "Ledger response",
            status: "succeeded",
          },
        ],
      };

      // When transcript does not exist, uses fallback ledger
      const snapshotFromLedger = await loadAntigravitySnapshot(convId, state, {
        cwd: tmpDir,
        environment: { ANTIGRAVITY_APP_DATA_DIR: tmpDir },
        fallbackLedger: async () => fallbackData,
      });
      expect(snapshotFromLedger?.turns).toHaveLength(1);
      expect(snapshotFromLedger?.turns[0]?.input).toEqual([{ type: "text", text: "Ledger input" }]);

      // When transcript exists, uses transcript
      const transcriptPath = resolveAntigravityTranscriptPath(convId, {
        ANTIGRAVITY_APP_DATA_DIR: tmpDir,
      });
      await mkdir(path.dirname(transcriptPath), { recursive: true });
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 0,
            type: "USER_INPUT",
            content: "<USER_REQUEST>\nTranscript input\n</USER_REQUEST>",
          }),
          JSON.stringify({
            step_index: 1,
            type: "PLANNER_RESPONSE",
            content: "Transcript response",
          }),
        ].join("\n"),
        "utf8",
      );

      const directTurns = await readAntigravityTranscript(transcriptPath, convId, tmpDir);
      expect(directTurns).toHaveLength(1);

      const snapshotFromTranscript = await loadAntigravitySnapshot(convId, state, {
        cwd: tmpDir,
        environment: { ANTIGRAVITY_APP_DATA_DIR: tmpDir },
        fallbackLedger: async () => fallbackData,
      });
      expect(snapshotFromTranscript?.turns).toHaveLength(1);
      expect(snapshotFromTranscript?.turns[0]?.input).toEqual([
        { type: "text", text: "Transcript input" },
      ]);
      expect(snapshotFromTranscript?.turns[0]?.items[0]?.item).toMatchObject({
        type: "agentMessage",
        text: "Transcript response",
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
