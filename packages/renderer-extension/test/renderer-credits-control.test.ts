import { describe, expect, it } from "vitest";

import {
  creditsPeriodLabel,
  formatRendererCreditsReset,
  rendererCreditsTone,
  resolveAdaptiveMeters,
} from "../src/renderer-credits-control.js";
import { formatRendererCreditsPercent } from "../src/renderer-usage-control.js";

describe("Renderer credits control", () => {
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

  it("adapts Antigravity credits to the active model group (Scheme A)", () => {
    const antigravityCredits = {
      usedPercent: 40.3,
      periodType: "five_hour" as const,
      productUsage: [
        { product: "Gemini Models · Weekly window", usagePercent: 15.7 },
        { product: "Gemini Models · 5-hour window", usagePercent: 40.3 },
        { product: "Claude and GPT models · Weekly window", usagePercent: 67.6 },
        { product: "Claude and GPT models · 5-hour window", usagePercent: 0 },
      ],
    };

    // When Gemini model is active, show only Gemini limits in Chinese
    const geminiResolved = resolveAdaptiveMeters(
      antigravityCredits,
      "zh-CN",
      {
        remaining: "剩余",
        resets: "重置",
        details: "账号额度详情",
        weekly: "周额度",
        monthly: "月额度",
        fiveHour: "5 小时额度",
        sevenDay: "7 天额度",
        account: "账号额度",
        geminiGroup: "Gemini",
        threePGroup: "3P 模型",
      },
      { agent: "antigravity", modelId: "Gemini 3.8 Flash (High)" },
    );

    expect(geminiResolved.meters).toHaveLength(2);
    expect(geminiResolved.meters[0]?.label).toBe("5 小时额度 (Gemini)");
    expect(geminiResolved.meters[0]?.usagePercent).toBe(40.3);
    expect(geminiResolved.meters[1]?.label).toBe("7 天额度 (Gemini)");
    expect(geminiResolved.meters[1]?.usagePercent).toBe(15.7);
    expect(geminiResolved.headlineUsage).toBe(40.3);

    // When 3P model is active, show only 3P limits
    const threePResolved = resolveAdaptiveMeters(
      antigravityCredits,
      "zh-CN",
      {
        remaining: "剩余",
        resets: "重置",
        details: "账号额度详情",
        weekly: "周额度",
        monthly: "月额度",
        fiveHour: "5 小时额度",
        sevenDay: "7 天额度",
        account: "账号额度",
        geminiGroup: "Gemini",
        threePGroup: "3P 模型",
      },
      { agent: "antigravity", modelId: "Claude 3.7 Sonnet" },
    );

    expect(threePResolved.meters).toHaveLength(2);
    expect(threePResolved.meters[0]?.label).toBe("5 小时额度 (3P 模型)");
    expect(threePResolved.meters[0]?.usagePercent).toBe(0);
    expect(threePResolved.meters[1]?.label).toBe("7 天额度 (3P 模型)");
    expect(threePResolved.meters[1]?.usagePercent).toBe(67.6);
  });
});
