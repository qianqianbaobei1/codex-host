import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { antigravitySessionInvocation } from "../src/command.js";
import { AntigravityCliTransport } from "../src/transport.js";

const INIT_LINE =
  '{"event":"init","conversation_id":"conv-live","init":{"cwd":"/tmp","model":"gemini-3.7-flash"}}';
const STEP_LINE =
  '{"event":"step_update","step_update":{"step_type":"think","thinking_delta":"delta"}}';
const RESULT_LINE =
  '{"event":"result","result":{"conversation_id":"conv-live","status":"COMPLETED","response":"done","num_turns":1}}';

// Busy decoy: on a user message, stream a step_update ~every 50ms for ~6s,
// then emit a result. Sustained activity must keep refreshing the idle budget.
const BUSY_SCRIPT = `#!/bin/bash
echo '${INIT_LINE}'
while read -r line; do
  case "$line" in
    *user*)
      i=0
      while [ "$i" -lt 120 ]; do
        echo '${STEP_LINE}'
        i=$((i+1))
        sleep 0.05
      done
      echo '${RESULT_LINE}'
      ;;
  esac
done
`;

// Silent decoy: on a user message, emit nothing for a few seconds (no steps),
// then a result. The idle watchdog must trip before the result arrives.
const SILENT_SCRIPT = `#!/bin/bash
echo '${INIT_LINE}'
while read -r line; do
  case "$line" in
    *user*)
      sleep 4
      echo '${RESULT_LINE}'
      ;;
  esac
done
`;

const STAYING_ALIVE_AFTER_RESULT_SCRIPT = `#!/bin/bash
echo "$AGY_TEST_PID_FILE" >/dev/null
echo "$$" > "$AGY_TEST_PID_FILE"
echo '${INIT_LINE}'
while read -r line; do
  case "$line" in
    *user*)
      echo '${RESULT_LINE}'
      sleep 60
      ;;
  esac
done
`;

async function writeAgy(root: string, name: string, body: string): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, body, "utf8");
  await chmod(file, 0o755);
  return file;
}

describe("AntigravityCliTransport turn liveness (activity-aware timeout)", () => {
  it("uses the 2-hour native print budget by default", () => {
    const invocation = antigravitySessionInvocation("/tmp/agy", {}, {}, "darwin");
    expect(invocation.arguments).toEqual(expect.arrayContaining(["--print-timeout", "2h"]));
  });

  it("keeps an actively streaming Turn alive, resetting the idle budget on each step", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-busy-"));
    try {
      const command = await writeAgy(root, "busy.sh", BUSY_SCRIPT);
      const transport = new AntigravityCliTransport({
        cwd: root,
        command,
        // ~6s of continuous streaming. The host-side absolute backstop is
        // explicitly disabled; each step_update must still refresh the idle budget.
        idleTimeoutMs: 400,
        turnDeadlineMs: 0,
      });

      const init = await transport.start();
      expect(init.conversationId).toBe("conv-live");

      const result = await transport.runTurn("work long", () => undefined);
      expect(result.response).toBe("done");
      await transport.close().catch(() => undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);

  it("enforces an explicitly configured absolute deadline even while streaming", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-deadline-"));
    try {
      const command = await writeAgy(root, "busy.sh", BUSY_SCRIPT);
      const transport = new AntigravityCliTransport({
        cwd: root,
        command,
        idleTimeoutMs: 5000,
        turnDeadlineMs: 400,
      });

      await transport.start();
      await expect(transport.runTurn("work too long", () => undefined)).rejects.toThrow(
        /absolute .* ceiling/u,
      );
      await transport.close().catch(() => undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  it("rejects a fully silent Turn through the idle watchdog", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-idle-"));
    try {
      const command = await writeAgy(root, "silent.sh", SILENT_SCRIPT);
      const transport = new AntigravityCliTransport({
        cwd: root,
        command,
        idleTimeoutMs: 500,
        turnDeadlineMs: 30000,
      });

      const init = await transport.start();
      expect(init.conversationId).toBe("conv-live");

      const outcome = await transport
        .runTurn("hang silently", () => undefined)
        .then(
          () => ({ settled: true as const, error: undefined as string | undefined }),
          (error: unknown) => ({
            settled: true as const,
            error: error instanceof Error ? error.message : String(error),
          }),
        );

      expect(outcome.settled).toBe(true);
      expect(outcome.error ?? "").toContain("Antigravity Turn execution timed out");
      expect(outcome.error ?? "").toContain("no stream activity");
      await transport.close().catch(() => undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  it("hibernates the resident CLI on demand and keeps the transport restartable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-retire-"));
    try {
      const pidFile = path.join(root, "agy.pid");
      const command = await writeAgy(root, "staying-alive.sh", STAYING_ALIVE_AFTER_RESULT_SCRIPT);
      const transport = new AntigravityCliTransport({
        cwd: root,
        command,
        environment: { ...process.env, AGY_TEST_PID_FILE: pidFile },
        idleTimeoutMs: 30_000,
        turnDeadlineMs: 30_000,
      });

      await transport.start();
      await expect(transport.runTurn("finish then wait", () => undefined)).resolves.toMatchObject({
        response: "done",
      });
      const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);
      await transport.hibernate();
      alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
      await expect(transport.runTurn("after hibernate", () => undefined)).resolves.toMatchObject({
        response: "done",
      });
      await transport.close().catch(() => undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);
});
