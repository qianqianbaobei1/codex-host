import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AntigravityDraftReservationPool,
  purgeAntigravitySessionFiles,
  type DraftReservationKeyParams,
} from "../src/draft-reservation.js";
import type { AntigravityCliTransportLike } from "../src/antigravity-adapter.js";
import type { AntigravityInitEvent } from "../src/transport.js";

describe("AntigravityDraftReservationPool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `agy-draft-res-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(tmpDir, "conversations"), { recursive: true });
    mkdirSync(path.join(tmpDir, "brain"), { recursive: true });
    mkdirSync(path.join(tmpDir, "presence"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.useRealTimers();
  });

  function createMockTransport(conversationId: string): AntigravityCliTransportLike {
    let closed = false;
    return {
      conversationId,
      logPath: null,
      async start(): Promise<AntigravityInitEvent> {
        return {
          type: "init",
          conversationId,
          model: "gemini-3.8-flash",
          cwd: "/test",
        };
      },
      async setModel() {
        return { type: "init", conversationId, model: "gemini-3.8-flash", cwd: "/test" };
      },
      async setEffort() {
        return { type: "init", conversationId, model: "gemini-3.8-flash", cwd: "/test" };
      },
      async setPermissionMode() {
        return { type: "init", conversationId, model: "gemini-3.8-flash", cwd: "/test" };
      },
      async runTurn() {
        return { type: "result", text: "done" };
      },
      async cancel() {},
      async close() {
        closed = true;
      },
    };
  }

  it("purges native session files from all store roots", () => {
    const convId = "test-uuid-1234";
    const dbFile = path.join(tmpDir, "conversations", `${convId}.db`);
    const brainDir = path.join(tmpDir, "brain", convId);
    const lockFile = path.join(tmpDir, "presence", `${convId}.lock`);

    writeFileSync(dbFile, "fake db");
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(path.join(brainDir, "info.json"), "{}");
    writeFileSync(lockFile, "{}");

    expect(existsSync(dbFile)).toBe(true);
    expect(existsSync(brainDir)).toBe(true);
    expect(existsSync(lockFile)).toBe(true);

    purgeAntigravitySessionFiles([tmpDir], convId);

    expect(existsSync(dbFile)).toBe(false);
    expect(existsSync(brainDir)).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("reserves and claims matching draft", async () => {
    const convId = "conv-match-1";
    const mockTransport = createMockTransport(convId);
    const createTransport = vi.fn(() => mockTransport);

    const pool = new AntigravityDraftReservationPool({
      storeRoots: [tmpDir],
      createTransport,
      transportOptionsFactory: () => ({ cwd: "/test" }),
    });

    const params: DraftReservationKeyParams = {
      cwd: "/test",
      model: "gemini-3.8-flash",
      accountId: "acc-1",
    };

    const reservation = pool.reserve(params);
    expect(reservation).not.toBeNull();
    expect(pool.size).toBe(1);
    expect(pool.has(params)).toBe(true);

    const init = await reservation!.startPromise;
    expect(init.conversationId).toBe(convId);

    // Claim
    const claimed = pool.claim(params);
    expect(claimed).toBe(reservation);
    expect(pool.size).toBe(0);
    expect(claimed?.conversationId).toBe(convId);

    // After claim, calling release does nothing because it's no longer in the pool
    pool.release(params);
    expect(claimed?.transport).toBe(mockTransport);

    await pool.close();
  });

  it("evacuates old reservation when switching model for the same cwd", async () => {
    const convId1 = "conv-switch-1";
    const convId2 = "conv-switch-2";
    const transport1 = createMockTransport(convId1);
    const transport2 = createMockTransport(convId2);

    // Simulate disk side effects for convId1
    const dbFile1 = path.join(tmpDir, "conversations", `${convId1}.db`);
    writeFileSync(dbFile1, "db1");

    let callCount = 0;
    const createTransport = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? transport1 : transport2;
    });

    const pool = new AntigravityDraftReservationPool({
      storeRoots: [tmpDir],
      createTransport,
      transportOptionsFactory: () => ({ cwd: "/test" }),
    });

    const params1: DraftReservationKeyParams = {
      cwd: "/test",
      model: "gemini-3.8-flash",
    };
    const res1 = pool.reserve(params1);
    await res1!.startPromise;

    const params2: DraftReservationKeyParams = {
      cwd: "/test",
      model: "gemini-3.8-pro",
    };
    const res2 = pool.reserve(params2);
    await res2!.startPromise;

    expect(pool.size).toBe(1);
    expect(pool.has(params1)).toBe(false);
    expect(pool.has(params2)).toBe(true);

    // Verify convId1 disk files were cleaned up
    expect(existsSync(dbFile1)).toBe(false);

    await pool.close();
  });

  it("evacuates and cleans up on TTL expiry", async () => {
    vi.useFakeTimers();

    const convId = "conv-expire-1";
    const transport = createMockTransport(convId);
    const dbFile = path.join(tmpDir, "conversations", `${convId}.db`);
    writeFileSync(dbFile, "db-expire");

    const pool = new AntigravityDraftReservationPool({
      ttlMs: 5000,
      storeRoots: [tmpDir],
      createTransport: () => transport,
      transportOptionsFactory: () => ({ cwd: "/test" }),
    });

    const params: DraftReservationKeyParams = {
      cwd: "/test",
      model: "gemini-3.8-flash",
    };

    const res = pool.reserve(params);
    await res!.startPromise;
    expect(pool.size).toBe(1);
    expect(existsSync(dbFile)).toBe(true);

    // Advance past TTL
    await vi.advanceTimersByTimeAsync(5100);

    expect(pool.size).toBe(0);
    expect(existsSync(dbFile)).toBe(false);

    await pool.close();
  });
});
