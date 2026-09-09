import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AntigravityCliTransport } from "../src/transport.js";

// A stubborn process: emits a valid init event, then on the first user line
// ignores SIGINT/SIGTERM and blocks forever. This mirrors Antigravity (a Go
// runtime) stuck on a dead proxy — the exact hang users reported.
const STUBBORN_AGY_SH = `#!/bin/bash
trap '' INT TERM
echo '{"event":"init","conversation_id":"conv-test","init":{"cwd":"/tmp","model":"gemini-3.7-flash-high","permission_mode":"always-proceed"}}'
while read -r line; do
  case "$line" in
    *'{"event":"user"'*) sleep 86400 ;;
  esac
done
`;

async function writeStubbornAgy(root: string): Promise<string> {
  const script = path.join(root, "stubborn-agy.sh");
  await writeFile(script, STUBBORN_AGY_SH, "utf8");
  await chmod(script, 0o755);
  return script;
}

describe("AntigravityCliTransport cancellation", () => {
  it("force-kills a Turn that ignores SIGINT/SIGTERM (stuck proxy scenario)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-antigravity-cancel-"));
    try {
      const command = await writeStubbornAgy(root);
      const transport = new AntigravityCliTransport({ cwd: root, command });

      const init = await transport.start();
      expect(init.conversationId).toBe("conv-test");

      // Start a Turn. The stubborn decoy ignores INT/TERM, so its promise
      // would hang until the Turn watchdog if cancel only sent SIGINT.
      const turnPromise = transport
        .runTurn("hi", () => {})
        .then(
          () => ({ settled: true }),
          (error) => ({
            settled: true,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Cancel: with the fix this escalates past ignored INT/TERM to SIGKILL,
      // so the process dies and the Turn promise settles promptly.
      await transport.cancel();

      // The Turn must settle quickly (grace window), not after the 5-min timeout.
      const settled = await Promise.race([
        turnPromise,
        new Promise<{ settled: boolean }>((resolve) =>
          setTimeout(() => resolve({ settled: false }), 6000),
        ),
      ]);

      expect(settled.settled).toBe(true);
      await transport.close().catch(() => undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
