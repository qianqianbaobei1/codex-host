import type { AccountBalanceSnapshot, AccountCreditsSnapshot } from "@codexhost/shared-contracts";

import {
  applyRendererPopoverChrome,
  createRendererUsageRing,
  formatRendererCreditsPercent,
} from "./renderer-usage-control.js";
import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

export interface RendererCreditsControl {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  anchor: HTMLElement | null;
  dispose(): void;
  place(anchor: HTMLElement | null): boolean;
}

export type RendererCreditsAvailability = "available" | "unavailable" | "unknown" | "hidden";

function formatCompactBalanceAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1000) return value.toFixed(2);
  const compact = value / 1000;
  return `${compact.toFixed(Math.abs(compact) < 10 ? 2 : 1).replace(/\.0+$/u, "")}k`;
}

export function formatAccountBalance(balance: AccountBalanceSnapshot): string {
  return balance.balances
    .map(({ currency, totalBalance }) => `${currency} ${formatCompactBalanceAmount(totalBalance)}`)
    .join(" · ");
}

function renderAccountBalanceDetails(
  popover: HTMLDivElement,
  balance: AccountBalanceSnapshot,
): void {
  popover.replaceChildren();
  for (const [index, item] of balance.balances.entries()) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.gap = "12px";
    row.style.padding = "4px 0";
    const currency = document.createElement("span");
    currency.textContent = item.currency;
    const amount = document.createElement("strong");
    amount.textContent = `${item.totalBalance.toFixed(2)}`;
    row.append(currency, amount);
    popover.append(row);
    if (index < balance.balances.length - 1) {
      const divider = document.createElement("div");
      divider.style.height = "1px";
      divider.style.background = "color-mix(in srgb, currentColor 12%, transparent)";
      popover.append(divider);
    }
  }
}

export type RendererCreditsTone = "ok" | "warn" | "hot";

export function rendererCreditsTone(usedPercent: number): RendererCreditsTone {
  if (usedPercent >= 90) return "hot";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

/**
 * A same-day reset reads as a precise time ("4:12 PM today") — the moment is
 * imminent and worth being exact about. Every other reset — tomorrow, or a
 * full week out — still carries its exact time alongside the date ("Aug 28,
 * 6:00 PM"): the source data is precise to the minute for both the 5-hour
 * and 7-day windows, so the display never throws that away.
 */
export function formatRendererCreditsReset(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (date.getTime() < now.getTime() - 60_000) {
    return "refreshing";
  }
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return `${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} today`;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function creditsPeriodLabel(periodType: AccountCreditsSnapshot["periodType"]): string {
  if (periodType === "weekly") return "Weekly limit";
  if (periodType === "monthly") return "Monthly limit";
  if (periodType === "five_hour") return "5-hour limit";
  if (periodType === "seven_day") return "7-day limit";
  return "Account limit";
}

function productLabel(product: string): string {
  if (product === "GrokBuild") return "Build";
  if (product === "GrokChat") return "Chat";
  if (product === "GrokImagine") return "Imagine";
  if (product === "GrokVoice") return "Voice";
  if (product === "Weekly limit") return "周限额";
  if (product === "3P Weekly limit") return "第三方周限额";
  if (product === "3P 5-hour limit") return "第三方 5 小时限额";
  if (product === "Gemini Weekly limit") return "Gemini 周限额";
  if (product === "Gemini 5-hour limit") return "Gemini 5 小时限额";
  if (product.includes("Weekly window")) return "周限额";
  if (product.includes("5-hour window")) return "5 小时限额";
  return product;
}

function periodLabelZh(periodType: AccountCreditsSnapshot["periodType"]): string {
  if (periodType === "weekly") return "周限额";
  if (periodType === "monthly") return "月限额";
  if (periodType === "five_hour") return "5 小时限额";
  if (periodType === "seven_day") return "7 天限额";
  return "账户限额";
}

function formatResetLabel(resetsAt: string): string {
  const formatted = formatRendererCreditsReset(resetsAt);
  if (formatted === "refreshing") return "正在刷新重置时间";
  if (formatted.endsWith(" today")) {
    return `今天 ${formatted.replace(" today", "")} 重置`;
  }
  return `${formatted} 重置`;
}

export function formatResetLabelZh(resetsAt: string, now: Date = new Date()): string {
  if (!resetsAt) return "";
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return resetsAt;
  if (date.getTime() < now.getTime() - 60_000) {
    return "正在刷新";
  }
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const timeStr = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (isToday) {
    return `今天 ${timeStr} 重置`;
  }
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${monthDay} ${timeStr} 重置`;
}

export function formatCodexResetTime(resetsAtStr?: string, now: Date = new Date()): string {
  if (!resetsAtStr) return "";
  const target = new Date(resetsAtStr);
  if (Number.isNaN(target.getTime())) return "";
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= -120_000) return "";
  if (diffMs <= 0) return "刷新中";

  const diffHours = diffMs / (1000 * 60 * 60);

  // 不足 24 小时：按照时间点 / 小时展示 (如 11:31)
  if (diffHours < 24) {
    const isToday =
      target.getFullYear() === now.getFullYear() &&
      target.getMonth() === now.getMonth() &&
      target.getDate() === now.getDate();
    if (isToday) {
      return target.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    }
    return `${Math.max(1, Math.ceil(diffHours))}小时`;
  }

  // 超过 24 小时：按照天 / 月日展示 (如 9月12日)
  const month = target.getMonth() + 1;
  const day = target.getDate();
  return `${month}月${day}日`;
}

function toneColor(tone: RendererCreditsTone): string {
  if (tone === "hot") return "#c45c4a";
  if (tone === "warn") return "#c9a227";
  return "#3d9a64";
}

export function premiumMetricColor(remaining: number | null | undefined): string {
  if (remaining === null || remaining === undefined || !Number.isFinite(remaining)) {
    return "color-mix(in srgb, currentColor 45%, transparent)";
  }
  if (remaining >= 35) {
    return "light-dark(#059669, #34d399)";
  }
  if (remaining >= 15) {
    return "light-dark(#d97706, #fbbf24)";
  }
  return "light-dark(#dc2626, #f87171)";
}

interface QuotaMetric {
  usagePercent: number;
  remainingPercent: number;
  resetsAt?: string | undefined;
}

interface ModelGroupQuota {
  name: string;
  isGemini: boolean;
  weekly?: QuotaMetric | undefined;
  fiveHour?: QuotaMetric | undefined;
}

export type RendererAntigravityQuotaGroup = "gemini" | "other";

function isAntigravityOrMultiGroup(credits: AccountCreditsSnapshot): boolean {
  if (!credits.productUsage || credits.productUsage.length === 0) {
    return (
      credits.periodType === "weekly" ||
      credits.periodType === "five_hour" ||
      credits.periodType === "seven_day"
    );
  }
  return credits.productUsage.some((item) => {
    const p = item.product.toLowerCase();
    return (
      p.includes("gemini") ||
      p.includes("claude") ||
      p.includes("gpt") ||
      p.includes("3p") ||
      p.includes("window") ||
      p.includes("limit") ||
      p.includes("限额")
    );
  });
}

export function extractAntigravityGroups(credits: AccountCreditsSnapshot): {
  gemini: ModelGroupQuota;
  other: ModelGroupQuota;
} {
  const gemini: ModelGroupQuota = { name: "Gemini", isGemini: true };
  const other: ModelGroupQuota = { name: "其他", isGemini: false };

  const assign = (
    group: "gemini" | "other",
    window: "weekly" | "five_hour",
    usagePercent: number,
    resetsAt?: string,
  ) => {
    const remaining = Math.max(0, 100 - usagePercent);
    const metric: QuotaMetric = {
      usagePercent,
      remainingPercent: remaining,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
    if (group === "gemini") {
      if (window === "weekly") gemini.weekly = metric;
      else gemini.fiveHour = metric;
    } else {
      if (window === "weekly") other.weekly = metric;
      else other.fiveHour = metric;
    }
  };

  for (const item of credits.productUsage ?? []) {
    const p = item.product.toLowerCase();
    const isGemini = p.includes("gemini");
    const isOther =
      p.includes("claude") || p.includes("gpt") || p.includes("3p") || p.includes("第三方");
    const is5h =
      p.includes("5h") || p.includes("5-hour") || p.includes("5小时") || p.includes("5 小时");
    const window = is5h ? "five_hour" : "weekly";

    if (isGemini) {
      assign("gemini", window, item.usagePercent, item.resetsAt);
    } else if (isOther) {
      assign("other", window, item.usagePercent, item.resetsAt);
    } else {
      if (window === "weekly") {
        if (!gemini.weekly) assign("gemini", "weekly", item.usagePercent, item.resetsAt);
        else if (!other.weekly) assign("other", "weekly", item.usagePercent, item.resetsAt);
      } else {
        if (!gemini.fiveHour) assign("gemini", "five_hour", item.usagePercent, item.resetsAt);
        else if (!other.fiveHour) assign("other", "five_hour", item.usagePercent, item.resetsAt);
      }
    }
  }

  // When product buckets omit the primary bucket (e.g. Gemini 5-hour limit when
  // preferredGroup is gemini, since it is held as top-level primary), populate
  // the corresponding window on the Gemini group.
  if (!gemini.fiveHour && credits.periodType === "five_hour") {
    assign("gemini", "five_hour", credits.usedPercent, credits.resetsAt);
  } else if (!gemini.weekly && credits.periodType === "weekly") {
    assign("gemini", "weekly", credits.usedPercent, credits.resetsAt);
  }

  return { gemini, other };
}

function renderCompactQuotaRow(group: ModelGroupQuota): HTMLDivElement {
  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.justifyContent = "space-between";
  row.style.gap = "8px";
  row.style.padding = "2px 0";
  row.style.whiteSpace = "nowrap";

  // 1. Group Badge (Gemini / 其他)
  const badge = document.createElement("span");
  badge.textContent = group.name;
  badge.style.fontSize = "11px";
  badge.style.fontWeight = "600";
  badge.style.padding = "1px 6px";
  badge.style.borderRadius = "4px";
  badge.style.flex = "0 0 46px";
  badge.style.textAlign = "center";
  badge.style.boxSizing = "border-box";
  if (group.isGemini) {
    badge.style.background = "light-dark(rgba(66, 133, 244, 0.10), rgba(138, 180, 248, 0.15))";
    badge.style.color = "light-dark(#1a73e8, #8ab4f8)";
  } else {
    badge.style.background = "light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.08))";
    badge.style.color = "light-dark(#4b5563, #9ca3af)";
  }
  row.append(badge);

  const formatPercentStr = (m?: QuotaMetric): string => {
    if (!m) return "--";
    const rem = m.remainingPercent;
    return `${rem % 1 === 0 ? rem.toFixed(0) : rem.toFixed(1)}%`;
  };

  // 2. Weekly Metric
  const weeklyCol = document.createElement("div");
  weeklyCol.style.display = "inline-flex";
  weeklyCol.style.alignItems = "center";
  weeklyCol.style.gap = "4px";
  weeklyCol.style.flex = "1 1 auto";

  const weeklyLabel = document.createElement("span");
  weeklyLabel.textContent = "周";
  weeklyLabel.style.fontSize = "11px";
  weeklyLabel.style.color = "color-mix(in srgb, currentColor 55%, transparent)";

  const weeklyVal = document.createElement("span");
  weeklyVal.textContent = formatPercentStr(group.weekly);
  weeklyVal.style.fontSize = "11.5px";
  weeklyVal.style.fontWeight = "600";
  weeklyVal.style.fontVariantNumeric = "tabular-nums";
  weeklyVal.style.color = premiumMetricColor(group.weekly?.remainingPercent);

  weeklyCol.append(weeklyLabel, weeklyVal);

  if (group.weekly) {
    const weeklyBar = document.createElement("div");
    weeklyBar.dataset.codexhostCreditsBar = "";
    weeklyBar.style.width = "18px";
    weeklyBar.style.height = "2.5px";
    weeklyBar.style.borderRadius = "9999px";
    weeklyBar.style.background = "color-mix(in srgb, currentColor 12%, transparent)";
    weeklyBar.style.overflow = "hidden";
    weeklyBar.style.flex = "0 0 18px";
    const weeklyFill = document.createElement("div");
    weeklyFill.style.height = "100%";
    weeklyFill.style.width = `${Math.min(100, Math.max(0, group.weekly.remainingPercent))}%`;
    weeklyFill.style.borderRadius = "9999px";
    weeklyFill.style.background = premiumMetricColor(group.weekly.remainingPercent);
    weeklyBar.append(weeklyFill);
    weeklyCol.append(weeklyBar);

    const weeklyReset = formatCodexResetTime(group.weekly.resetsAt);
    if (weeklyReset) {
      const resetSpan = document.createElement("span");
      resetSpan.textContent = weeklyReset;
      resetSpan.style.fontSize = "10.5px";
      resetSpan.style.color = "color-mix(in srgb, currentColor 45%, transparent)";
      resetSpan.style.fontVariantNumeric = "tabular-nums";
      weeklyCol.append(resetSpan);
    }

    const resetStr = formatResetLabelZh(group.weekly.resetsAt ?? "");
    weeklyCol.title = `周额度剩余 ${formatPercentStr(group.weekly)} (已用 ${group.weekly.usagePercent}%)${resetStr ? ` · ${resetStr}` : ""}`;
  } else {
    weeklyCol.title = "周额度: 暂无数据";
  }
  row.append(weeklyCol);

  // 3. 5-hour Metric
  const fiveHourCol = document.createElement("div");
  fiveHourCol.style.display = "inline-flex";
  fiveHourCol.style.alignItems = "center";
  fiveHourCol.style.gap = "4px";
  fiveHourCol.style.flex = "1 1 auto";
  fiveHourCol.style.justifyContent = "flex-end";

  const fiveHourLabel = document.createElement("span");
  fiveHourLabel.textContent = "5小时:";
  fiveHourLabel.style.fontSize = "11px";
  fiveHourLabel.style.color = "color-mix(in srgb, currentColor 55%, transparent)";

  const fiveHourVal = document.createElement("span");
  fiveHourVal.textContent = formatPercentStr(group.fiveHour);
  fiveHourVal.style.fontSize = "11.5px";
  fiveHourVal.style.fontWeight = "600";
  fiveHourVal.style.fontVariantNumeric = "tabular-nums";
  fiveHourVal.style.color = premiumMetricColor(group.fiveHour?.remainingPercent);

  fiveHourCol.append(fiveHourLabel, fiveHourVal);

  if (group.fiveHour) {
    const fiveHourBar = document.createElement("div");
    fiveHourBar.dataset.codexhostCreditsBar = "";
    fiveHourBar.style.width = "18px";
    fiveHourBar.style.height = "2.5px";
    fiveHourBar.style.borderRadius = "9999px";
    fiveHourBar.style.background = "color-mix(in srgb, currentColor 12%, transparent)";
    fiveHourBar.style.overflow = "hidden";
    fiveHourBar.style.flex = "0 0 18px";
    const fiveHourFill = document.createElement("div");
    fiveHourFill.style.height = "100%";
    fiveHourFill.style.width = `${Math.min(100, Math.max(0, group.fiveHour.remainingPercent))}%`;
    fiveHourFill.style.borderRadius = "9999px";
    fiveHourFill.style.background = premiumMetricColor(group.fiveHour.remainingPercent);
    fiveHourBar.append(fiveHourFill);
    fiveHourCol.append(fiveHourBar);

    const fiveHourReset = formatCodexResetTime(group.fiveHour.resetsAt);
    if (fiveHourReset) {
      const resetSpan = document.createElement("span");
      resetSpan.textContent = fiveHourReset;
      resetSpan.style.fontSize = "10.5px";
      resetSpan.style.color = "color-mix(in srgb, currentColor 45%, transparent)";
      resetSpan.style.fontVariantNumeric = "tabular-nums";
      fiveHourCol.append(resetSpan);
    }

    const resetStr = formatResetLabelZh(group.fiveHour.resetsAt ?? "");
    fiveHourCol.title = `5小时额度剩余 ${formatPercentStr(group.fiveHour)} (已用 ${group.fiveHour.usagePercent}%)${resetStr ? ` · ${resetStr}` : ""}`;
  } else {
    fiveHourCol.title = "5小时额度: 暂无数据";
  }
  row.append(fiveHourCol);

  return row;
}

function renderCreditsBar(usagePercent: number, color: string): HTMLDivElement {
  const track = document.createElement("div");
  track.dataset.codexhostCreditsBar = "";
  track.style.height = "6px";
  track.style.borderRadius = "9999px";
  track.style.background = "color-mix(in srgb, currentColor 16%, transparent)";
  track.style.overflow = "hidden";
  const fill = document.createElement("span");
  fill.style.display = "block";
  fill.style.height = "100%";
  fill.style.borderRadius = "9999px";
  fill.style.width = `${Math.min(100, Math.max(0, usagePercent))}%`;
  fill.style.background = color;
  track.append(fill);
  return track;
}

function renderCreditsHeader(credits: AccountCreditsSnapshot): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.style.marginBottom = "11px";

  const top = document.createElement("div");
  top.style.display = "flex";
  top.style.alignItems = "flex-start";
  top.style.justifyContent = "space-between";
  top.style.gap = "12px";
  top.style.marginBottom = "5px";

  const remainingPercent = Math.max(0, 100 - credits.usedPercent);

  const left = document.createElement("div");
  const label = document.createElement("div");
  label.textContent = `${periodLabelZh(credits.periodType)} (剩余)`;
  label.style.fontSize = "12.5px";
  label.style.fontWeight = "600";
  left.append(label);
  if (credits.resetsAt) {
    const reset = document.createElement("div");
    reset.textContent = formatResetLabel(credits.resetsAt);
    reset.style.fontSize = "11px";
    reset.style.color = "color-mix(in srgb, currentColor 62%, transparent)";
    left.append(reset);
  }

  const color = toneColor(rendererCreditsTone(credits.usedPercent));
  const percent = document.createElement("span");
  percent.textContent = formatRendererCreditsPercent(remainingPercent);
  percent.style.fontSize = "26px";
  percent.style.fontWeight = "700";
  percent.style.fontVariantNumeric = "tabular-nums";
  percent.style.color = color;

  top.append(left, percent);

  const remainingHeader = remainingPercent.toFixed(1).replace(/\.0$/, "");
  wrapper.title = `剩余可用: ${remainingHeader}% · 已消耗: ${formatRendererCreditsPercent(credits.usedPercent)}`;
  wrapper.append(top, renderCreditsBar(remainingPercent, color));
  return wrapper;
}

function renderCreditsTile(label: string, usagePercent: number, resetsAt?: string): HTMLDivElement {
  const remainingPercent = Math.max(0, 100 - usagePercent);
  const color = toneColor(rendererCreditsTone(usagePercent));

  const tile = document.createElement("div");
  tile.style.marginBottom = "11px";

  const top = document.createElement("div");
  top.style.display = "flex";
  top.style.alignItems = "flex-start";
  top.style.justifyContent = "space-between";
  top.style.gap = "12px";
  top.style.marginBottom = "5px";

  const left = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = `${productLabel(label)} (剩余)`;
  name.style.fontSize = "12px";
  left.append(name);
  if (resetsAt) {
    const reset = document.createElement("div");
    reset.textContent = formatResetLabel(resetsAt);
    reset.style.fontSize = "10.5px";
    reset.style.color = "color-mix(in srgb, currentColor 62%, transparent)";
    left.append(reset);
  }

  const percent = document.createElement("span");
  percent.textContent = formatRendererCreditsPercent(remainingPercent);
  percent.style.fontSize = "12px";
  percent.style.fontVariantNumeric = "tabular-nums";
  percent.style.color = color;
  top.append(left, percent);

  const remainingTile = remainingPercent.toFixed(1).replace(/\.0$/, "");
  tile.title = `剩余可用: ${remainingTile}% · 已消耗: ${formatRendererCreditsPercent(usagePercent)}`;
  tile.append(top, renderCreditsBar(remainingPercent, color));
  return tile;
}

function renderDetails(
  popover: HTMLDivElement,
  credits: AccountCreditsSnapshot,
  selectedGroup?: RendererAntigravityQuotaGroup,
): void {
  popover.replaceChildren();

  if (isAntigravityOrMultiGroup(credits)) {
    popover.style.backgroundImage = "none";
    popover.style.padding = "7px 10px";
    popover.style.boxShadow =
      "light-dark(0 8px 20px -4px rgba(0, 0, 0, 0.12), 0 12px 28px -4px rgba(0, 0, 0, 0.38))";

    const { gemini, other } = extractAntigravityGroups(credits);

    if (selectedGroup) {
      popover.append(renderCompactQuotaRow(selectedGroup === "gemini" ? gemini : other));
      return;
    }

    const rowGemini = renderCompactQuotaRow(gemini);
    const rowOther = renderCompactQuotaRow(other);

    const divider = document.createElement("div");
    divider.style.height = "1px";
    divider.style.background = "color-mix(in srgb, currentColor 7%, transparent)";
    divider.style.margin = "3px 0";

    popover.append(rowGemini, divider, rowOther);
    return;
  }

  const glowColor = toneColor(rendererCreditsTone(credits.usedPercent));
  popover.style.backgroundImage = `radial-gradient(160px 100px at 18% -10%, color-mix(in srgb, ${glowColor} 20%, transparent), transparent 70%)`;
  popover.append(renderCreditsHeader(credits));
  const tiles = (credits.productUsage ?? []).map((product) =>
    renderCreditsTile(productLabel(product.product), product.usagePercent, product.resetsAt),
  );
  const lastTile = tiles.at(-1);
  if (lastTile) lastTile.style.marginBottom = "0";
  popover.append(...tiles);
}

function popoverIsOpen(popover: HTMLDivElement): boolean {
  try {
    return popover.matches(":popover-open");
  } catch {
    return !popover.hidden;
  }
}

function positionPopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  const triggerRect = control.trigger.getBoundingClientRect();
  const width = Math.min(320, Math.max(280, window.innerWidth - 24));
  const left = Math.max(12, Math.min(triggerRect.left, window.innerWidth - width - 12));
  control.popover.style.width = `${width}px`;
  control.popover.style.left = `${left}px`;
  control.popover.style.right = "auto";
  control.popover.style.top = "auto";
  control.popover.style.bottom = `${Math.max(12, window.innerHeight - triggerRect.top + 8)}px`;
}

function closePopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  if (popoverIsOpen(control.popover) && typeof control.popover.hidePopover === "function") {
    control.popover.hidePopover();
  }
  control.popover.hidden = true;
  control.trigger.setAttribute("aria-expanded", "false");
}

function openPopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  positionPopover(control);
  control.popover.hidden = false;
  if (typeof control.popover.showPopover === "function" && !popoverIsOpen(control.popover)) {
    control.popover.showPopover();
  }
  control.trigger.setAttribute("aria-expanded", "true");
}

function togglePopover(control: Pick<RendererCreditsControl, "trigger" | "popover">): void {
  if (control.trigger.getAttribute("aria-expanded") === "true") closePopover(control);
  else openPopover(control);
}

export function mountRendererCreditsControl(composerId: string): RendererCreditsControl {
  ensureRendererTriggerChipStyle(document);

  const root = document.createElement("div");
  root.dataset.codexhostCreditsControl = composerId;
  root.className = "relative min-w-0";
  root.style.display = "none";
  root.style.alignItems = "center";
  root.style.alignSelf = "center";
  root.style.height = "28px";
  root.style.flex = "0 0 auto";
  root.style.verticalAlign = "middle";

  const trigger = document.createElement("button");
  trigger.className = TRIGGER_CHIP_CLASS;
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "Account limit");
  trigger.title = "Account limit";
  trigger.style.gap = "5px";
  trigger.style.width = "fit-content";
  trigger.style.maxWidth = "min(96px, 20vw)";
  // Match the 28px height shared by the Model/Permission-mode/Agent triggers
  // it sits next to — a shorter box here previously threw off the row's
  // vertical alignment (visible as Credits sitting a few px lower than its
  // neighbors), whether the host lays this row out as flex or inline content.
  trigger.style.height = "28px";
  trigger.style.padding = "0 8px";
  trigger.style.verticalAlign = "middle";
  trigger.style.fontSize = "12px";
  trigger.style.lineHeight = "16px";
  trigger.style.fontVariantNumeric = "tabular-nums";
  trigger.style.letterSpacing = "0";

  const ringSlot = document.createElement("span");
  ringSlot.dataset.codexhostCreditsRing = "";
  ringSlot.style.display = "inline-flex";
  ringSlot.style.flex = "0 0 auto";

  const label = document.createElement("span");
  label.dataset.codexhostCreditsLabel = "";
  label.style.display = "inline-block";
  label.style.maxWidth = "100%";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  trigger.append(ringSlot, label);

  const popover = document.createElement("div");
  popover.id = `${composerId}-credits-popover`;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Account limit details");
  popover.setAttribute("popover", "auto");
  popover.hidden = typeof popover.showPopover !== "function";
  popover.style.position = "fixed";
  popover.style.inset = "auto";
  popover.style.width = "280px";
  popover.style.maxWidth = "min(320px, calc(100vw - 24px))";
  popover.style.padding = "7px 10px";
  applyRendererPopoverChrome(popover);
  popover.style.font =
    "12px/1.35 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
  popover.style.letterSpacing = "0";
  popover.style.zIndex = "2147483647";
  trigger.setAttribute("aria-controls", popover.id);

  let placementReference: Element | null = null;
  const control: RendererCreditsControl = {
    root,
    trigger,
    popover,
    anchor: null,
    dispose() {
      closePopover(control);
      if (closeTimer !== null) window.clearTimeout(closeTimer);
      root.remove();
      popover.remove();
      placementReference = null;
    },
    place(anchor) {
      // Credits sits immediately *before* its anchor (the permission-mode
      // picker) rather than being derived by walking up from the Usage
      // control's current DOM position. Anchoring directly to a
      // renderer-owned, already-tracked element keeps this stable across
      // reconciliation passes instead of re-deriving a different ancestor
      // once the host page's own DOM settles a few seconds after mount.
      if (!anchor?.parentElement) return false;
      const parent = anchor.parentElement;
      if (
        control.anchor === anchor &&
        placementReference === anchor &&
        root.parentElement === parent &&
        root.nextElementSibling === anchor
      ) {
        return true;
      }
      control.anchor = anchor;
      placementReference = anchor;
      if (root !== anchor) parent.insertBefore(root, anchor);
      return true;
    },
  };

  let closeTimer: number | null = null;
  const cancelClose = (): void => {
    if (closeTimer === null) return;
    window.clearTimeout(closeTimer);
    closeTimer = null;
  };
  const scheduleClose = (): void => {
    cancelClose();
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      if (!trigger.matches(":hover") && !popover.matches(":hover")) closePopover(control);
    }, 140);
  };

  trigger.addEventListener("click", () => togglePopover(control));
  trigger.addEventListener("pointerenter", () => {
    cancelClose();
    openPopover(control);
  });
  trigger.addEventListener("pointerleave", scheduleClose);
  trigger.addEventListener("focus", () => {
    cancelClose();
    openPopover(control);
  });
  trigger.addEventListener("blur", scheduleClose);
  popover.addEventListener("pointerenter", cancelClose);
  popover.addEventListener("pointerleave", scheduleClose);
  popover.addEventListener("toggle", () => {
    trigger.setAttribute("aria-expanded", String(popoverIsOpen(popover)));
  });
  root.append(trigger);
  document.body.append(popover);
  return control;
}

export function renderRendererCreditsControl(
  control: RendererCreditsControl,
  accountCredits: AccountCreditsSnapshot | null,
  selectedGroup?: RendererAntigravityQuotaGroup,
  availability: RendererCreditsAvailability = "unknown",
  accountBalance: AccountBalanceSnapshot | null = null,
): boolean {
  if (availability === "hidden") {
    control.root.style.display = "none";
    closePopover(control);
    return false;
  }
  if (accountCredits === null) {
    control.root.style.display = "inline-flex";
    closePopover(control);
    const label = control.trigger.querySelector<HTMLElement>("[data-codexhost-credits-label]");
    if (accountBalance) {
      const text = formatAccountBalance(accountBalance);
      if (label) label.textContent = text;
      control.trigger.setAttribute("aria-label", `账户余额 ${text}`);
      control.trigger.title = "当前 Agent 的账户余额";
      renderAccountBalanceDetails(control.popover, accountBalance);
      return true;
    }
    if (label) label.textContent = availability === "unknown" ? "…" : "—";
    control.trigger.setAttribute(
      "aria-label",
      availability === "unknown" ? "额度未知" : "额度不可用",
    );
    control.trigger.title =
      availability === "unknown"
        ? "正在等待当前 Agent 的额度信息"
        : "当前 Agent 未提供可验证的额度信息";
    return false;
  }
  const percent = formatRendererCreditsPercent(accountCredits.usedPercent);
  const title = `${creditsPeriodLabel(accountCredits.periodType)} ${percent}`;
  const tone = rendererCreditsTone(accountCredits.usedPercent);
  const ringSlot = control.trigger.querySelector<HTMLElement>("[data-codexhost-credits-ring]");
  const label = control.trigger.querySelector<HTMLElement>("[data-codexhost-credits-label]");
  if (ringSlot) {
    ringSlot.replaceChildren(
      createRendererUsageRing(accountCredits.usedPercent, {
        size: 14,
        strokeWidth: 2.4,
        color: toneColor(tone),
      }),
    );
  }
  if (label) label.textContent = percent;
  control.root.style.display = "inline-flex";
  control.trigger.setAttribute("aria-label", title);
  control.trigger.title = title;
  renderDetails(control.popover, accountCredits, selectedGroup);
  return true;
}
