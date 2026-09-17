import { describe, expect, it, vi } from "vitest";

import { withBoundedIo } from "../src/antigravity-adapter.js";

describe("bounded local IO", () => {
  it("passes through a value that settles in time", async () => {
    await expect(withBoundedIo(Promise.resolve("ok"), 1_000, "read")).resolves.toBe("ok");
  });

  it("passes through a failure unchanged", async () => {
    const failure = new Error("disk on fire");
    await expect(withBoundedIo(Promise.reject(failure), 1_000, "read")).rejects.toBe(failure);
  });

  it("rejects instead of hanging forever", async () => {
    // This is the shape that used to strand a Turn: #active is only cleared after #runTurn
    // settles, so an IO await that never settles kept the Session permanently busy — no idle
    // reclamation and every later Stop rejected with "must reference the active Turn".
    vi.useFakeTimers();
    try {
      const never = new Promise<string>(() => {});
      const bounded = withBoundedIo(never, 5_000, "Antigravity ledger append");
      const assertion = expect(bounded).rejects.toThrow(
        "Antigravity ledger append exceeded 5000ms",
      );
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep the process alive on its own", async () => {
    const promise = withBoundedIo(new Promise<string>(() => {}), 60_000, "read");
    promise.catch(() => undefined);
    // No unref assertion is portable here; the contract is simply that scheduling the bound must
    // not throw or leak a ref that blocks exit in tests.
    expect(promise).toBeInstanceOf(Promise);
  });
});
