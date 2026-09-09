import { describe, expect, it } from "vitest";

import {
  creditsPeriodLabel,
  extractAntigravityGroups,
  formatAccountBalance,
  formatCodexResetTime,
  formatRendererCreditsReset,
  formatResetLabelZh,
  premiumMetricColor,
  rendererCreditsTone,
} from "../src/renderer-credits-control.js";
import { formatRendererCreditsPercent } from "../src/renderer-usage-control.js";

describe("Renderer credits control", () => {
  it("uses compact balance text in the toolbar while keeping cents for small values", () => {
    expect(formatAccountBalance({ balances: [{ currency: "CNY", totalBalance: 1926.14 }] })).toBe(
      "CNY 1.93k",
    );
    expect(formatAccountBalance({ balances: [{ currency: "CNY", totalBalance: 26.14 }] })).toBe(
      "CNY 26.14",
    );
  });
  it("maps used percent into a status tone", () => {
    expect(rendererCreditsTone(0)).toBe("ok");
    expect(rendererCreditsTone(52)).toBe("ok");
    expect(rendererCreditsTone(70)).toBe("warn");
    expect(rendererCreditsTone(89.9)).toBe("warn");
    expect(rendererCreditsTone(90)).toBe("hot");
  });

  it("formats the compact percent and period label", () => {
    expect(formatRendererCreditsPercent(47)).toBe("47%");
    expect(creditsPeriodLabel("weekly")).toBe("Weekly limit");
    expect(creditsPeriodLabel("monthly")).toBe("Monthly limit");
    expect(creditsPeriodLabel("five_hour")).toBe("5-hour limit");
    expect(creditsPeriodLabel("seven_day")).toBe("7-day limit");
    expect(creditsPeriodLabel("unknown")).toBe("Account limit");
    expect(creditsPeriodLabel("weekly", "zh-CN")).toBe("周额度");
    expect(creditsPeriodLabel("monthly", "zh-CN")).toBe("月额度");
    expect(creditsPeriodLabel("five_hour", "zh-CN")).toBe("5 小时额度");
    expect(creditsPeriodLabel("seven_day", "zh-CN")).toBe("7 天额度");
    expect(creditsPeriodLabel("unknown", "zh-CN")).toBe("账号额度");
    expect(formatRendererCreditsReset("not-a-date")).toBe("not-a-date");
  });

  it("formats a same-day reset as a precise time and every other reset as a dated time", () => {
    // Built with the local Date constructor throughout (never a bare UTC ISO string against a
    // separately-computed "now") so the "same calendar day" check holds regardless of the
    // machine's own timezone.
    const now = new Date(2026, 7, 25, 12, 0, 0);
    const sameDayReset = new Date(2026, 7, 25, 16, 12, 0);
    const nextWeekReset = new Date(2026, 8, 5, 18, 0, 0);

    expect(formatRendererCreditsReset(sameDayReset.toISOString(), now)).toBe(
      `${sameDayReset.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} today`,
    );
    expect(formatRendererCreditsReset(sameDayReset.toISOString(), now, "zh-CN")).toBe(
      `今天 ${sameDayReset.toLocaleTimeString("zh-CN", { hour: "numeric", minute: "2-digit" })}`,
    );
    expect(formatRendererCreditsReset(nextWeekReset.toISOString(), now)).toBe(
      nextWeekReset.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  it("keeps the time when a near-term reset has crossed local midnight", () => {
    const now = new Date(2026, 7, 25, 23, 0, 0);
    const justAfterMidnight = new Date(2026, 7, 26, 0, 10, 0);
    expect(formatRendererCreditsReset(justAfterMidnight.toISOString(), now)).toBe(
      justAfterMidnight.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  it("handles past expired reset times cleanly", () => {
    const now = new Date(2026, 8, 4, 10, 0, 0);
    const yesterdayReset = new Date(2026, 8, 3, 13, 0, 0);
    expect(formatRendererCreditsReset(yesterdayReset.toISOString(), now)).toBe("refreshing");
  });

  it("formats Chinese reset times cleanly for same-day and future dates", () => {
    const now = new Date(2026, 8, 4, 12, 0, 0);
    const todayReset = new Date(2026, 8, 4, 18, 10, 0);
    const nextWeekReset = new Date(2026, 8, 11, 8, 10, 0);

    const todayStr = formatResetLabelZh(todayReset.toISOString(), now);
    expect(todayStr).toContain("今天");
    expect(todayStr).toContain("18:10");
    expect(todayStr).toContain("重置");

    const nextWeekStr = formatResetLabelZh(nextWeekReset.toISOString(), now);
    expect(nextWeekStr).toContain("9月11日");
    expect(nextWeekStr).toContain("08:10");
    expect(nextWeekStr).toContain("重置");
  });

  it("assigns premium adaptive colors based on remaining quota risk", () => {
    // Healthy >= 35% -> emerald
    expect(premiumMetricColor(84.1)).toContain("#34d399");
    expect(premiumMetricColor(100)).toContain("#34d399");
    // Warning 15% ~ 35% -> amber
    expect(premiumMetricColor(35.3)).toContain("#34d399");
    expect(premiumMetricColor(25)).toContain("#fbbf24");
    // Critical < 15% -> coral red
    expect(premiumMetricColor(5)).toContain("#f87171");
    expect(premiumMetricColor(0)).toContain("#f87171");
    // Unknown -> muted
    expect(premiumMetricColor(null)).toContain("color-mix");
  });

  it("extracts Gemini and other model groups with weekly and 5-hour metrics", () => {
    // Simulated live snapshot matching the user's exact screenshot
    const credits = {
      usedPercent: 64.7,
      periodType: "weekly" as const,
      resetsAt: "2026-09-09T02:34:00.000Z",
      productUsage: [
        {
          product: "Gemini Models · Weekly window",
          usagePercent: 15.9,
          resetsAt: "2026-09-11T00:10:00.000Z",
        },
        {
          product: "Gemini Models · 5-hour window",
          usagePercent: 26.6,
          resetsAt: "2026-09-04T10:10:00.000Z",
        },
        {
          product: "Claude and GPT models · 5-hour window",
          usagePercent: 0,
          resetsAt: "2026-09-04T13:30:00.000Z",
        },
      ],
    };

    const { gemini, other } = extractAntigravityGroups(credits);

    // Gemini group verification
    expect(gemini.name).toBe("Gemini");
    expect(gemini.isGemini).toBe(true);
    expect(gemini.weekly?.remainingPercent).toBeCloseTo(84.1, 1);
    expect(gemini.weekly?.usagePercent).toBe(15.9);
    expect(gemini.weekly?.resetsAt).toBe("2026-09-11T00:10:00.000Z");

    expect(gemini.fiveHour?.remainingPercent).toBeCloseTo(73.4, 1);
    expect(gemini.fiveHour?.usagePercent).toBe(26.6);
    expect(gemini.fiveHour?.resetsAt).toBe("2026-09-04T10:10:00.000Z");

    // Other (Claude / GPT) group verification
    expect(other.name).toBe("其他");
    expect(other.isGemini).toBe(false);
    // The aggregate primary bucket has no group identity in this payload, so
    // it must not be copied into the unknown group.
    expect(other.weekly).toBeUndefined();

    expect(other.fiveHour?.remainingPercent).toBeCloseTo(100, 1);
    expect(other.fiveHour?.usagePercent).toBe(0);
    expect(other.fiveHour?.resetsAt).toBe("2026-09-04T13:30:00.000Z");
  });

  it("populates Gemini 5-hour quota from primary when productUsage omits it", () => {
    const credits = {
      usedPercent: 0,
      periodType: "five_hour" as const,
      resetsAt: "2026-09-07T07:49:03.000Z",
      productUsage: [
        {
          product: "Weekly limit",
          usagePercent: 62.3,
          resetsAt: "2026-09-11T00:10:55.000Z",
        },
        {
          product: "3P Weekly limit",
          usagePercent: 67.8,
          resetsAt: "2026-09-09T02:34:17.000Z",
        },
        {
          product: "3P 5-hour limit",
          usagePercent: 0,
          resetsAt: "2026-09-07T08:03:31.000Z",
        },
      ],
    };

    const { gemini, other } = extractAntigravityGroups(credits);
    expect(gemini.weekly?.usagePercent).toBe(62.3);
    expect(gemini.weekly?.remainingPercent).toBeCloseTo(37.7, 1);
    expect(gemini.fiveHour?.usagePercent).toBe(0);
    expect(gemini.fiveHour?.remainingPercent).toBe(100);
    expect(gemini.fiveHour?.resetsAt).toBe("2026-09-07T07:49:03.000Z");
    expect(other.weekly?.usagePercent).toBe(67.8);
    expect(other.fiveHour?.usagePercent).toBe(0);
  });

  it("formats reset time in Codex style: hours/time for <24h, date for >=24h", () => {
    const now = new Date(2026, 8, 5, 11, 0, 0); // 2026-09-05 11:00

    // Within 24h on same day -> clock time (like 11:31)
    const resetToday = new Date(2026, 8, 5, 11, 31, 0);
    expect(formatCodexResetTime(resetToday.toISOString(), now)).toBe("11:31");

    // Beyond 24h -> month/day (like 9月12日)
    const resetNextWeek = new Date(2026, 8, 12, 11, 31, 0);
    expect(formatCodexResetTime(resetNextWeek.toISOString(), now)).toBe("9月12日");

    // Empty or invalid input
    expect(formatCodexResetTime(undefined, now)).toBe("");
    expect(formatCodexResetTime("", now)).toBe("");
    expect(formatCodexResetTime("invalid", now)).toBe("");
  });
});
