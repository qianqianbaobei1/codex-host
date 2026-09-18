import { describe, expect, it } from "vitest";

import { harnessAccountCreditsCell } from "../../src/settings/harness-accounts.js";

const credits = { usedPercent: 25, periodType: "weekly" as const };

describe("Harness account Credits cell", () => {
  it("shows the reading when the probe succeeded", () => {
    expect(harnessAccountCreditsCell({ credits })).toEqual({ kind: "credits", credits });
  });

  it("never presents a failed reading as the current one", () => {
    // The stored numbers must not reach the cell: two Accounts once displayed the
    // same figures because both probes had failed.
    expect(
      harnessAccountCreditsCell({ credits, creditsStale: true, creditsError: "timed out" }),
    ).toEqual({ kind: "unknown", reason: "timed out" });
    expect(harnessAccountCreditsCell({ credits, creditsStale: true })).toEqual({
      kind: "unknown",
    });
  });

  it("keeps sign-in distinct from an unreadable quota", () => {
    expect(
      harnessAccountCreditsCell({ credits, creditsStale: true, authState: "needs_login" }),
    ).toEqual({ kind: "needs_login" });
  });

  it("reports no data when nothing has ever been read", () => {
    expect(harnessAccountCreditsCell({})).toEqual({ kind: "idle" });
  });
});
