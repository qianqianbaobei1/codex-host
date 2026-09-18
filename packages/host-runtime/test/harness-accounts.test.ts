import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, type HarnessAccountSnapshot } from "@codexhost/shared-contracts";
import { inspectHarnessAccounts } from "../src/harness-accounts.js";

const snapshot: HarnessAccountSnapshot = {
  email: "person@example.com",
  plan: "max",
  credits: { usedPercent: 25, periodType: "five_hour" },
};
const adapter = (id: string) => new FakeHarnessAdapter(harnessIdSchema.parse(id));

describe("read-only Harness accounts", () => {
  it("returns only real quota, isolates failure, and uses plugin display metadata without opening Threads", async () => {
    const ready = Object.assign(adapter("sample-agent"), {
      inspectAccount: vi.fn(async () => snapshot),
    });
    const open = vi.spyOn(ready, "open");
    const api = Object.assign(adapter("api-agent"), { inspectAccount: vi.fn(async () => null) });
    const failed = Object.assign(adapter("broken-agent"), {
      inspectAccount: vi.fn(async () => {
        throw new Error("secret diagnostic");
      }),
    });
    expect(
      await inspectHarnessAccounts(
        [ready, api, failed, adapter("legacy-agent")],
        [{ id: ready.harnessId, name: "Sample Agent", version: "1.0.0" }],
      ),
    ).toEqual({
      accounts: [{ ...snapshot, harnessId: "sample-agent", harnessName: "Sample Agent" }],
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("does not reuse the previous account when native authentication stops returning quota", async () => {
    const inspectAccount = vi
      .fn<() => Promise<HarnessAccountSnapshot | null>>()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(null);
    const native = Object.assign(adapter("sample-agent"), { inspectAccount });
    expect((await inspectHarnessAccounts([native], [])).accounts).toHaveLength(1);
    expect(await inspectHarnessAccounts([native], [])).toEqual({ accounts: [] });
  });

  it("bounds unresponsive plugins and rejects malformed or secret-bearing snapshots", async () => {
    const hung = Object.assign(adapter("hung-agent"), {
      inspectAccount: () => new Promise<null>(() => undefined),
    });
    const malformed = Object.assign(adapter("bad-agent"), {
      inspectAccount: async () => ({ ...snapshot, token: "must not escape" }),
    });
    expect(await inspectHarnessAccounts([hung, malformed], [], 5)).toEqual({ accounts: [] });
  });

  it("aggregates one row per selectable account and prefers inspectAccounts", async () => {
    const inspectAccount = vi.fn(async () => snapshot);
    const multi = Object.assign(adapter("multi-agent"), {
      inspectAccount,
      inspectAccounts: vi.fn(async () => [
        { ...snapshot, accountId: "default", label: "本机", isDefault: true, selectable: true },
        { ...snapshot, accountId: "work", label: "工作", isDefault: false, selectable: true },
      ]),
    });
    const result = await inspectHarnessAccounts(
      [multi],
      [{ id: multi.harnessId, name: "Multi Agent", version: "1.0.0" }],
    );
    expect(result.accounts).toMatchObject([
      {
        harnessId: "multi-agent",
        harnessName: "Multi Agent",
        accountId: "default",
        isDefault: true,
      },
      { harnessId: "multi-agent", harnessName: "Multi Agent", accountId: "work", isDefault: false },
    ]);
    expect(inspectAccount).not.toHaveBeenCalled();
  });

  it("only probes quota when asked and keeps background refreshes unforced", async () => {
    const calls: Array<{ force?: boolean } | undefined> = [];
    const multi = Object.assign(adapter("multi-agent"), {
      inspectAccounts: vi.fn(async () => [
        { ...snapshot, accountId: "default", label: "本机", isDefault: true, selectable: true },
      ]),
      refreshAccountCredits: vi.fn(async (options?: { force?: boolean }) => {
        calls.push(options);
      }),
    });

    await inspectHarnessAccounts([multi], []);
    expect(calls).toHaveLength(0);
    await inspectHarnessAccounts([multi], [], 12_000, "stale");
    expect(calls).toEqual([{ force: false }]);
    await inspectHarnessAccounts([multi], [], 12_000, "force");
    expect(calls).toEqual([{ force: false }, { force: true }]);
  });

  it("drops malformed rows from a multi-account list and treats null as no rows", async () => {
    const multi = Object.assign(adapter("multi-agent"), {
      inspectAccounts: vi.fn(async () => [snapshot, { ...snapshot, accountId: "bad/id" }]),
    });
    expect(await inspectHarnessAccounts([multi], [])).toEqual({
      accounts: [{ ...snapshot, harnessId: "multi-agent", harnessName: "multi-agent" }],
    });
    const empty = Object.assign(adapter("empty-agent"), {
      inspectAccounts: vi.fn(async () => null),
    });
    expect(await inspectHarnessAccounts([empty], [])).toEqual({ accounts: [] });
  });

  it("reports a row the shared contract rejects instead of dropping it silently", async () => {
    // A Host Bundle whose inlined contract predates a plugin's new row field used
    // to make the whole Account disappear with nothing written anywhere.
    const invalidRow = { ...snapshot, creditsStale: "yes" } as unknown as HarnessAccountSnapshot;
    const multi = Object.assign(adapter("future-agent"), {
      inspectAccounts: vi.fn(async () => [invalidRow]),
    });
    const reported: string[] = [];
    const result = await inspectHarnessAccounts([multi], [], 12_000, "none", (message) =>
      reported.push(message),
    );
    expect(result).toEqual({ accounts: [] });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("future-agent");
    expect(reported[0]).toContain("creditsStale");
  });
});
