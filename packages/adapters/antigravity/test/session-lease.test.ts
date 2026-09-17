import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AntigravitySessionLeaseError,
  acquireSessionLease,
  inspectSessionLease,
  isSessionLeaseHolderLive,
  sessionLeasePath,
} from "../src/session-lease.js";

const roots: string[] = [];

async function makeLeases(): Promise<{ directory: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-session-lease-"));
  roots.push(root);
  const directory = path.join(root, "leases");
  await mkdir(directory, { recursive: true });
  return { directory, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CONVERSATION = "f96574c0-2b3b-419c-84a8-ae53d3b25086";

describe("Antigravity session write lease", () => {
  it("gives a conversation to exactly one writer", async () => {
    const { directory } = await makeLeases();
    const first = acquireSessionLease({
      leasesDirectory: directory,
      nativeSessionId: CONVERSATION,
      accountId: "default",
    });
    expect(first.record.generation).toBe(1);

    // A second Account (or Host) must not be able to name the same conversation.
    let refused: unknown;
    try {
      acquireSessionLease({
        leasesDirectory: directory,
        nativeSessionId: CONVERSATION,
        accountId: "gemini-2",
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AntigravitySessionLeaseError);
    expect(refused).toMatchObject({ code: "busy", holder: { accountId: "default" } });

    first.release();
    const second = acquireSessionLease({
      leasesDirectory: directory,
      nativeSessionId: CONVERSATION,
      accountId: "gemini-2",
    });
    expect(second.record).toMatchObject({ accountId: "gemini-2", generation: 2 });
    second.release();
    // A released lease keeps its counter so the next generation stays unique.
    expect(inspectSessionLease(directory, CONVERSATION)).toMatchObject({
      live: false,
      holder: { generation: 2, state: "released" },
    });
    const third = acquireSessionLease({
      leasesDirectory: directory,
      nativeSessionId: CONVERSATION,
      accountId: "default",
    });
    expect(third.record.generation).toBe(3);
    third.release();
  });

  it("takes over a lease whose owner process is gone, and logs the takeover", async () => {
    const { directory } = await makeLeases();
    const leasePath = sessionLeasePath(directory, CONVERSATION);
    await writeFile(
      leasePath,
      `${JSON.stringify({
        formatVersion: 1,
        nativeSessionId: CONVERSATION,
        accountId: "default",
        hostInstanceId: "crashed-host:1",
        // Pid 1 is never a Host; use a pid that cannot be alive.
        pid: 2 ** 22 - 1,
        processStartedAt: null,
        generation: 7,
        acquiredAt: "2026-09-16T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    expect(isSessionLeaseHolderLive(JSON.parse(await readFile(leasePath, "utf8")))).toBe(false);

    const lease = acquireSessionLease({
      leasesDirectory: directory,
      nativeSessionId: CONVERSATION,
      accountId: "gemini-2",
    });
    expect(lease.record).toMatchObject({
      accountId: "gemini-2",
      generation: 8,
      stolenFrom: { pid: 2 ** 22 - 1, generation: 7, reason: "owner process is gone" },
    });
    const log = await readFile(path.join(directory, "steal-log.jsonl"), "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(log.trim())).toMatchObject({ generation: 8, accountId: "gemini-2" });
    lease.release();
  });

  it("never lets a superseded writer release the new holder's lease", async () => {
    const { directory } = await makeLeases();
    const leasePath = sessionLeasePath(directory, CONVERSATION);
    const lease = acquireSessionLease({
      leasesDirectory: directory,
      nativeSessionId: CONVERSATION,
      accountId: "default",
    });
    // Another runtime takes the lease over after this writer was declared gone.
    await writeFile(
      leasePath,
      `${JSON.stringify({
        ...lease.record,
        accountId: "gemini-2",
        hostInstanceId: "other-host:999",
        generation: lease.record.generation + 1,
      })}\n`,
      "utf8",
    );
    lease.release();
    expect(inspectSessionLease(directory, CONVERSATION)).toMatchObject({
      live: true,
      holder: { accountId: "gemini-2", generation: lease.record.generation + 1 },
    });
    await rm(leasePath, { force: true });
  });

  it("excludes a second real process", async () => {
    const { directory, root } = await makeLeases();
    const script = path.join(root, "hold.mjs");
    const source = path.resolve("packages/adapters/antigravity/src/session-lease.ts");
    // Node strips types on import, so the child exercises the same source file.
    await writeFile(
      script,
      `import { acquireSessionLease } from ${JSON.stringify(source)};
const lease = acquireSessionLease({ leasesDirectory: ${JSON.stringify(directory)}, nativeSessionId: ${JSON.stringify(CONVERSATION)}, accountId: "child" });
process.stdout.write(JSON.stringify({ pid: process.pid, generation: lease.record.generation }));
setTimeout(() => { lease.release(); }, 5000);
`,
      "utf8",
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    const held = await new Promise<{ pid: number; generation: number }>((resolve, reject) => {
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("}")) return;
        try {
          resolve(JSON.parse(buffer) as { pid: number; generation: number });
        } catch (error) {
          reject(error as Error);
        }
      });
      child.on("error", reject);
    });
    expect(held.generation).toBe(1);
    expect(inspectSessionLease(directory, CONVERSATION)).toMatchObject({
      live: true,
      holder: { pid: held.pid, accountId: "child" },
    });
    // While the child holds it, this process is refused — across real processes.
    expect(() =>
      acquireSessionLease({
        leasesDirectory: directory,
        nativeSessionId: CONVERSATION,
        accountId: "parent",
      }),
    ).toThrow(AntigravitySessionLeaseError);
    child.kill("SIGTERM");
  });
});
