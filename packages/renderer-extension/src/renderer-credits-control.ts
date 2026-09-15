import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

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

export type RendererCreditsTone = "ok" | "warn" | "hot";

export function rendererCreditsTone(usedPercent: number): RendererCreditsTone {
  if (usedPercent >= 90) return "hot";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

interface RendererCreditsMessages {
  readonly remaining: string;
  readonly resets: string;
  readonly details: string;
  readonly weekly: string;
  readonly monthly: string;
  readonly fiveHour: string;
  readonly sevenDay: string;
  readonly account: string;
  readonly geminiGroup: string;
  readonly threePGroup: string;
}

const ENGLISH_CREDITS_MESSAGES: RendererCreditsMessages = Object.freeze({
  remaining: "Remaining",
  resets: "Resets",
  details: "Account limit details",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
  fiveHour: "5-hour limit",
  sevenDay: "7-day limit",
  account: "Account limit",
  geminiGroup: "Gemini",
  threePGroup: "3P",
});

const CHINESE_CREDITS_MESSAGES: RendererCreditsMessages = Object.freeze({
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
});

function rendererCreditsMessages(locale: RendererSettingsLocale): RendererCreditsMessages {
  return locale === "zh-CN" ? CHINESE_CREDITS_MESSAGES : ENGLISH_CREDITS_MESSAGES;
}

/**
 * Keep the source's minute precision, while making same-day resets easier to
 * scan and formatting both English and Chinese popovers in one presentation layer.
 */
export function formatRendererCreditsReset(
  value: string,
  now: Date = new Date(),
  locale: RendererSettingsLocale = "en",
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    const time = date.toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return locale === "zh-CN" ? `今天 ${time}` : `${time} today`;
  }
  return date.toLocaleString(locale === "zh-CN" ? "zh-CN" : undefined, {
    month: locale === "zh-CN" ? "long" : "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function creditsPeriodLabel(
  periodType: AccountCreditsSnapshot["periodType"],
  locale: RendererSettingsLocale = "en",
): string {
  const messages = rendererCreditsMessages(locale);
  if (periodType === "weekly") return messages.weekly;
  if (periodType === "monthly") return messages.monthly;
  if (periodType === "five_hour") return messages.fiveHour;
  if (periodType === "seven_day") return messages.sevenDay;
  return messages.account;
}

export function isAntigravityProductList(products: readonly { product: string }[]): boolean {
  return products.some((p) => {
    const n = p.product.trim().toLowerCase();
    return /gemini|\b3p\b|claude.*gpt|gpt.*claude|first[- ]party|third[- ]party/u.test(n);
  });
}

function productLabel(product: string, locale: RendererSettingsLocale): string {
  if (product === "GrokBuild") return "Build";
  if (product === "GrokChat") return "Chat";
  if (product === "GrokImagine") return "Imagine";
  if (product === "GrokVoice") return "Voice";
  const messages = rendererCreditsMessages(locale);
  const normalized = product.trim().toLowerCase();
  if (
    (/^5(?:[- ]?hour|h)|five[- ]?hour/u.test(normalized) && /limit|window/u.test(normalized)) ||
    normalized === "5-hour window" ||
    normalized === "5-hour limit"
  ) {
    return messages.fiveHour;
  }
  if (
    (/^7(?:[- ]?day)/u.test(normalized) && /limit|window/u.test(normalized)) ||
    normalized === "7-day window" ||
    normalized === "7-day limit"
  ) {
    return messages.sevenDay;
  }
  if (
    (/^weekly|week/u.test(normalized) && /limit|window/u.test(normalized)) ||
    normalized === "weekly window" ||
    normalized === "weekly limit"
  ) {
    return messages.weekly;
  }
  if (product.endsWith(" · 5-hour window") || product.endsWith(" · 5-hour limit")) {
    const prefix = product.split(" · ")[0];
    return `${prefix} · ${messages.fiveHour}`;
  }
  if (product.endsWith(" · 7-day window") || product.endsWith(" · 7-day limit")) {
    const prefix = product.split(" · ")[0];
    return `${prefix} · ${messages.sevenDay}`;
  }
  if (product.endsWith(" · Weekly window") || product.endsWith(" · Weekly limit")) {
    const prefix = product.split(" · ")[0];
    return `${prefix} · ${messages.sevenDay}`;
  }
  return product;
}

function toneColor(tone: RendererCreditsTone): string {
  if (tone === "hot") return "#dc2626";
  if (tone === "warn") return "#d97706";
  return "color-mix(in srgb, currentColor 68%, transparent)";
}

function remainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

function renderCreditsBar(
  usagePercent: number,
  color: string,
  tone: RendererCreditsTone,
): HTMLDivElement {
  const track = document.createElement("div");
  track.dataset.codexhostCreditsBar = "";
  track.style.height = "2.5px";
  track.style.borderRadius = "2px";
  track.style.background = "color-mix(in srgb, currentColor 8%, transparent)";
  track.style.overflow = "hidden";
  const fill = document.createElement("span");
  fill.style.display = "block";
  fill.style.height = "100%";
  fill.style.borderRadius = "2px";
  fill.style.width = `${Math.min(100, Math.max(0, usagePercent))}%`;
  fill.style.background =
    tone === "ok" ? "color-mix(in srgb, currentColor 68%, transparent)" : color;
  track.append(fill);
  return track;
}

function resetLabel(
  resetsAt: string,
  locale: RendererSettingsLocale,
  messages: RendererCreditsMessages,
): string {
  const formatted = formatRendererCreditsReset(resetsAt, new Date(), locale);
  return locale === "zh-CN" ? `${formatted} ${messages.resets}` : `${messages.resets} ${formatted}`;
}

function renderCreditsMeter(
  periodLabel: string,
  usagePercent: number,
  locale: RendererSettingsLocale,
  messages: RendererCreditsMessages,
  resetsAt: string | undefined,
): HTMLDivElement {
  const tone = rendererCreditsTone(usagePercent);
  const color = toneColor(tone);
  const remaining = remainingPercent(usagePercent);
  const meter = document.createElement("div");
  meter.style.display = "flex";
  meter.style.flexDirection = "column";
  meter.style.gap = "4px";
  meter.style.boxSizing = "border-box";
  meter.style.margin = "0";
  meter.style.padding = "0";
  meter.setAttribute("aria-label", periodLabel);

  const top = document.createElement("div");
  top.style.display = "flex";
  top.style.alignItems = "baseline";
  top.style.justifyContent = "space-between";
  top.style.gap = "8px";

  const label = document.createElement("div");
  label.textContent = periodLabel;
  label.style.fontSize = "12px";
  label.style.fontWeight = "500";
  label.style.color = "var(--settings-text, currentColor)";
  label.style.whiteSpace = "nowrap";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";

  const value = document.createElement("div");
  value.style.display = "flex";
  value.style.alignItems = "baseline";
  value.style.gap = "3px";
  value.style.color = tone === "ok" ? "currentColor" : color;
  value.style.whiteSpace = "nowrap";

  const remainingLabel = document.createElement("span");
  remainingLabel.textContent = `${messages.remaining} `;
  remainingLabel.style.fontSize = "10.5px";
  remainingLabel.style.fontWeight = "400";
  remainingLabel.style.opacity = "0.75";

  const remainingValue = document.createElement("span");
  remainingValue.textContent = formatRendererCreditsPercent(remaining);
  remainingValue.style.fontSize = "13px";
  remainingValue.style.fontWeight = "600";
  remainingValue.style.fontVariantNumeric = "tabular-nums";
  remainingValue.style.lineHeight = "1";
  value.append(remainingLabel, remainingValue);

  top.append(label, value);

  meter.append(top, renderCreditsBar(remaining, color, tone));

  if (resetsAt) {
    const reset = document.createElement("div");
    reset.textContent = resetLabel(resetsAt, locale, messages);
    reset.style.fontSize = "10.5px";
    reset.style.color = "color-mix(in srgb, currentColor 55%, transparent)";
    reset.style.fontVariantNumeric = "tabular-nums";
    reset.style.lineHeight = "1.2";
    meter.append(reset);
  }

  return meter;
}

export interface RendererCreditsOptions {
  readonly agent?: string;
  readonly modelId?: string | null;
}

interface ResolvedCreditMeter {
  readonly label: string;
  readonly usagePercent: number;
  readonly resetsAt?: string;
}

export function resolveAdaptiveMeters(
  credits: AccountCreditsSnapshot,
  locale: RendererSettingsLocale,
  messages: RendererCreditsMessages,
  options?: RendererCreditsOptions,
): {
  readonly meters: readonly ResolvedCreditMeter[];
  readonly headlineUsage: number;
} {
  const products = credits.productUsage ?? [];
  const isAntigravity = options?.agent === "antigravity" || isAntigravityProductList(products);

  if (isAntigravity && products.length > 0) {
    const is3PModel = Boolean(options?.modelId && /claude|gpt|\b3p\b/i.test(options.modelId));
    const targetGroup = is3PModel ? "other" : "own";
    const groupName = is3PModel ? messages.threePGroup : messages.geminiGroup;

    const matchesTargetGroup = (p: string): boolean => {
      const n = p.trim().toLowerCase();
      if (targetGroup === "other") {
        return /\b3p\b|claude|gpt|third[- ]party|other|其他/u.test(n);
      }
      return (
        /gemini|native|first[- ]party|自有/u.test(n) ||
        /^(weekly|5[- ]?hour|7[- ]?day) (limit|window)/u.test(n)
      );
    };

    let fiveHourBucket: { usagePercent: number; resetsAt?: string } | null = null;
    let weeklyBucket: { usagePercent: number; resetsAt?: string } | null = null;

    for (const p of products) {
      if (!matchesTargetGroup(p.product)) continue;
      const n = p.product.trim().toLowerCase();
      const is5h = /5(?:[- ]?hour|h)|five[- ]?hour/u.test(n);
      const isWeekly = /7(?:[- ]?day)|weekly|week/u.test(n);

      if (is5h && (!fiveHourBucket || p.usagePercent > fiveHourBucket.usagePercent)) {
        fiveHourBucket = {
          usagePercent: p.usagePercent,
          ...(p.resetsAt ? { resetsAt: p.resetsAt } : {}),
        };
      }
      if (isWeekly && (!weeklyBucket || p.usagePercent > weeklyBucket.usagePercent)) {
        weeklyBucket = {
          usagePercent: p.usagePercent,
          ...(p.resetsAt ? { resetsAt: p.resetsAt } : {}),
        };
      }
    }

    if (targetGroup === "own" && !fiveHourBucket && credits.periodType === "five_hour") {
      fiveHourBucket = {
        usagePercent: credits.usedPercent,
        ...(credits.resetsAt ? { resetsAt: credits.resetsAt } : {}),
      };
    }
    if (
      targetGroup === "own" &&
      !weeklyBucket &&
      (credits.periodType === "weekly" || credits.periodType === "seven_day")
    ) {
      weeklyBucket = {
        usagePercent: credits.usedPercent,
        ...(credits.resetsAt ? { resetsAt: credits.resetsAt } : {}),
      };
    }

    const meters: ResolvedCreditMeter[] = [];
    if (fiveHourBucket) {
      meters.push({
        label: `${messages.fiveHour} (${groupName})`,
        usagePercent: fiveHourBucket.usagePercent,
        ...(fiveHourBucket.resetsAt ? { resetsAt: fiveHourBucket.resetsAt } : {}),
      });
    }
    if (weeklyBucket) {
      meters.push({
        label: `${messages.sevenDay} (${groupName})`,
        usagePercent: weeklyBucket.usagePercent,
        ...(weeklyBucket.resetsAt ? { resetsAt: weeklyBucket.resetsAt } : {}),
      });
    }

    if (meters.length > 0) {
      const headline = fiveHourBucket
        ? fiveHourBucket.usagePercent
        : (weeklyBucket?.usagePercent ?? credits.usedPercent);
      return { meters, headlineUsage: headline };
    }
  }

  const meters: ResolvedCreditMeter[] = [
    {
      label: credits.label ?? creditsPeriodLabel(credits.periodType, locale),
      usagePercent: credits.usedPercent,
      ...(credits.resetsAt ? { resetsAt: credits.resetsAt } : {}),
    },
    ...products.map((product) => ({
      label: productLabel(product.product, locale),
      usagePercent: product.usagePercent,
      ...(product.resetsAt ? { resetsAt: product.resetsAt } : {}),
    })),
  ];

  return { meters, headlineUsage: credits.usedPercent };
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
  const width = Math.min(218, Math.max(200, window.innerWidth - 24));
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
  trigger.style.maxWidth = "min(72px, 18vw)";
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
  popover.style.width = "218px";
  popover.style.maxWidth = "min(218px, calc(100vw - 24px))";
  popover.style.padding = "10px 14px";
  applyRendererPopoverChrome(popover);
  popover.style.borderRadius = "12px";
  popover.style.boxShadow =
    "light-dark(0 4px 16px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.28))";
  popover.style.display = "flex";
  popover.style.flexDirection = "column";
  popover.style.gap = "10px";
  popover.style.font = "13px/1.35 system-ui, sans-serif";
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
  locale: RendererSettingsLocale = "en",
  options?: RendererCreditsOptions,
): boolean {
  if (accountCredits === null) {
    control.root.style.display = "none";
    closePopover(control);
    return false;
  }
  const messages = rendererCreditsMessages(locale);
  const { meters, headlineUsage } = resolveAdaptiveMeters(
    accountCredits,
    locale,
    messages,
    options,
  );

  const remaining = remainingPercent(headlineUsage);
  const percent = formatRendererCreditsPercent(remaining);
  const title = `${meters[0]?.label ?? creditsPeriodLabel(accountCredits.periodType, locale)} ${percent}`;
  const tone = rendererCreditsTone(headlineUsage);
  const ringSlot = control.trigger.querySelector<HTMLElement>("[data-codexhost-credits-ring]");
  const label = control.trigger.querySelector<HTMLElement>("[data-codexhost-credits-label]");
  if (ringSlot) {
    ringSlot.replaceChildren(
      createRendererUsageRing(remaining, {
        size: 14,
        strokeWidth: 2,
        color:
          tone === "ok" ? "color-mix(in srgb, currentColor 68%, transparent)" : toneColor(tone),
        trackColor: "color-mix(in srgb, currentColor 10%, transparent)",
      }),
    );
  }
  if (label) label.textContent = percent;
  control.root.style.display = "inline-flex";
  control.trigger.setAttribute("aria-label", title);
  control.trigger.title = title;
  control.popover.setAttribute("aria-label", messages.details);
  control.popover.replaceChildren(
    ...meters.map((m) => renderCreditsMeter(m.label, m.usagePercent, locale, messages, m.resetsAt)),
  );
  return true;
}
