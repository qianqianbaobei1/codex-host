import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  antigravityQuotaAvailableForModel,
  parseAntigravityQuotaPayload,
  projectAntigravityRawQuota,
  projectAntigravitySnapshotQuota,
  readAntigravityCreditsSync,
  readAntigravityCredits,
} from "../src/credits.js";

describe("Antigravity credits", () => {
  it("scopes account availability to the selected model group", () => {
    const credits = {
      usedPercent: 100,
      periodType: "five_hour" as const,
      productUsage: [
        { product: "Gemini Models · 5-hour window", usagePercent: 100 },
        { product: "Gemini Models · Weekly window", usagePercent: 27.1 },
        { product: "Claude and GPT models · 5-hour window", usagePercent: 0 },
      ],
    };

    expect(antigravityQuotaAvailableForModel(credits, "gemini-3.8-flash")).toBe(true);
    expect(antigravityQuotaAvailableForModel(credits, "claude-sonnet-4-6")).toBe(true);
    expect(
      antigravityQuotaAvailableForModel(
        {
          usedPercent: 100,
          periodType: "five_hour" as const,
          productUsage: [{ product: "Gemini Models · 5-hour window", usagePercent: 100 }],
        },
        "gemini-3.8-flash",
      ),
    ).toBe(false);
  });

  it("does not treat a quota window that already reset as exhausted", () => {
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    const rolledOver = {
      usedPercent: 100,
      periodType: "five_hour" as const,
      resetsAt: "2026-09-15T05:01:10.000Z",
      productUsage: [
        {
          product: "Gemini Models · 5-hour window",
          usagePercent: 100,
          resetsAt: "2026-09-15T05:01:10.000Z",
        },
      ],
    };
    // The snapshot predates the reset, so its 100% describes a window that is gone.
    expect(antigravityQuotaAvailableForModel(rolledOver, "gemini-3.8-flash", now)).toBe(true);
    expect(
      antigravityQuotaAvailableForModel(
        {
          ...rolledOver,
          resetsAt: "2026-09-16T17:00:00.000Z",
          productUsage: [
            {
              product: "Gemini Models · 5-hour window",
              usagePercent: 100,
              resetsAt: "2026-09-16T17:00:00.000Z",
            },
          ],
        },
        "gemini-3.8-flash",
        now,
      ),
    ).toBe(false);
  });

  it("projects quota from raw statusline json correctly", () => {
    const rawPayload = {
      quota: {
        "gemini-5h": {
          remaining_fraction: 0.7438333,
          reset_time: "2026-09-03T05:01:41Z",
          reset_in_seconds: 9663,
        },
        "gemini-weekly": {
          remaining_fraction: 0.604304,
          reset_time: "2026-09-07T06:34:34Z",
          reset_in_seconds: 360836,
        },
        "3p-5h": {
          remaining_fraction: 1,
          reset_time: "2026-09-03T07:19:47Z",
          reset_in_seconds: 17949,
        },
        "3p-weekly": {
          remaining_fraction: 0.3599756,
          reset_time: "2026-09-09T02:34:17Z",
          reset_in_seconds: 519219,
        },
      },
    };

    const credits = projectAntigravityRawQuota(rawPayload);
    expect(credits).not.toBeNull();
    expect(credits?.periodType).toBe("five_hour");
    expect(credits?.usedPercent).toBe(25.6);
    expect(credits?.resetsAt).toBe("2026-09-03T05:01:41.000Z");
    expect(credits?.productUsage).toEqual([
      {
        product: "Gemini 5-hour limit",
        usagePercent: 25.6,
        resetsAt: "2026-09-03T05:01:41.000Z",
      },
      {
        product: "Gemini Weekly limit",
        usagePercent: 39.6,
        resetsAt: "2026-09-07T06:34:34.000Z",
      },
      {
        product: "3P 5-hour limit",
        usagePercent: 0,
        resetsAt: "2026-09-03T07:19:47.000Z",
      },
      {
        product: "3P Weekly limit",
        usagePercent: 64,
        resetsAt: "2026-09-09T02:34:17.000Z",
      },
    ]);

    // Test preferredGroup: "3p"
    const threePCredits = projectAntigravityRawQuota(rawPayload, "3p");
    expect(threePCredits?.periodType).toBe("five_hour");
    expect(threePCredits?.usedPercent).toBe(0); // 3p-5h is remaining 1 => 0% used
    expect(threePCredits?.resetsAt).toBe("2026-09-03T07:19:47.000Z");
    expect(threePCredits?.productUsage?.[0]?.product).toBe("3P 5-hour limit");
    expect(threePCredits?.productUsage?.[1]?.product).toBe("3P Weekly limit");
    expect(threePCredits?.productUsage?.[2]?.product).toBe("Gemini 5-hour limit");
    expect(threePCredits?.productUsage?.[3]?.product).toBe("Gemini Weekly limit");
  });

  it("projects quota from snapshot format", () => {
    const snapshotPayload = {
      timestamp: 1788402037.220234,
      groups: {
        gemini: {
          group_name: "gemini",
          five_hour: {
            remaining_percent: 74.38333,
            refresh_in_minutes: 161,
          },
          weekly: {
            remaining_percent: 60.43039999999999,
            refresh_in_minutes: 6013,
          },
        },
      },
    };

    const credits = projectAntigravitySnapshotQuota(snapshotPayload);
    expect(credits).not.toBeNull();
    expect(credits?.periodType).toBe("five_hour");
    expect(credits?.usedPercent).toBe(25.6);
    expect(credits?.productUsage?.[0]?.product).toBe("Gemini 5-hour limit");
    expect(credits?.productUsage?.[0]?.usagePercent).toBe(25.6);
    expect(credits?.productUsage?.[1]?.product).toBe("Gemini Weekly limit");
    expect(credits?.productUsage?.[1]?.usagePercent).toBe(39.6);
  });

  it("returns null for malformed or empty payloads", () => {
    expect(projectAntigravityRawQuota(null)).toBeNull();
    expect(projectAntigravityRawQuota({})).toBeNull();
    expect(projectAntigravityRawQuota({ quota: {} })).toBeNull();
    expect(parseAntigravityQuotaPayload("invalid json")).toBeNull();
  });

  it("reads credits from filesystem paths and enforces expiration", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-credits-test-"));
    try {
      const rawPath = path.join(tmpDir, "agy_statusline_raw.json");
      fs.writeFileSync(
        rawPath,
        JSON.stringify({
          quota: {
            "gemini-5h": {
              remaining_fraction: 0.5,
              reset_time: "2026-09-03T12:00:00Z",
            },
          },
        }),
      );

      // With allowExpired: true, it should parse the snapshot
      const syncCredits = readAntigravityCreditsSync({ rawPath, allowExpired: true });
      expect(syncCredits?.usedPercent).toBe(50);
      expect(syncCredits?.periodType).toBe("five_hour");

      const asyncCredits = await readAntigravityCredits({ rawPath, allowExpired: true });
      expect(asyncCredits?.usedPercent).toBe(50);

      // Without allowExpired, since 2026-09-03T12:00:00Z is in the past, it should reject expired data
      const expiredSync = readAntigravityCreditsSync({ rawPath });
      expect(expiredSync).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a global quota file without the expected account identity", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-credits-identity-test-"));
    try {
      const rawPath = path.join(tmpDir, "agy_statusline_raw.json");
      const snapshotPath = path.join(tmpDir, "agy_quota_snapshot.json");
      fs.writeFileSync(
        rawPath,
        JSON.stringify({
          email: "lucy@example.com",
          quota: { "gemini-5h": { remaining_fraction: 0.25 } },
        }),
      );
      fs.writeFileSync(
        snapshotPath,
        JSON.stringify({ groups: { gemini: { five_hour: { remaining_percent: 25 } } } }),
      );

      const options = { rawPath, snapshotPath, expectedEmail: "lure@example.com" };
      expect(readAntigravityCreditsSync(options)).toBeNull();
      await expect(readAntigravityCredits(options)).resolves.toBeNull();
      expect(
        readAntigravityCreditsSync({ ...options, expectedEmail: "lucy@example.com" })?.usedPercent,
      ).toBe(75);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
