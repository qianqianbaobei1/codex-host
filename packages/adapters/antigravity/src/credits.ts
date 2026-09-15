import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  accountCreditsSnapshotSchema,
  type AccountCreditsSnapshot,
} from "@codexhost/shared-contracts";

export type AntigravityCreditsProductUsage = NonNullable<
  AccountCreditsSnapshot["productUsage"]
>[number];

const execFileAsync = promisify(execFile);

export const DEFAULT_ANTIGRAVITY_STATUSLINE_RAW_PATH = "/tmp/agy_statusline_raw.json";
export const DEFAULT_ANTIGRAVITY_QUOTA_SNAPSHOT_PATH = "/tmp/agy_quota_snapshot.json";

function resolveQuotaScriptPath(): string {
  return (
    process.env.AGY_QUOTA_STATUS_SCRIPT ||
    path.join(os.homedir(), ".gemini", "antigravity-cli", "bin", "quota-status.py")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round1(num: number): number {
  return Math.round(num * 10) / 10;
}

function clampPercent(num: number): number {
  return Math.min(100, Math.max(0, round1(num)));
}

function quotaProductMatchesModel(product: string, modelId: string | undefined): boolean {
  const normalized = product.trim().toLowerCase();
  const thirdParty = /\b3p\b|claude|gpt|third[- ]party|other|其他/u.test(
    (modelId ?? "").trim().toLowerCase(),
  );
  if (thirdParty) {
    return /\b3p\b|claude|gpt|third[- ]party|other|其他/u.test(normalized);
  }
  return /gemini|native|first[- ]party|自有/u.test(normalized);
}

/**
 * Whether a cached quota snapshot still has capacity for the requested model
 * group. The top-level summary can describe another group (for example a
 * Claude/GPT weekly bucket while the user is selecting Gemini), so callers
 * must prefer the product-level bucket when it is available.
 */
export function antigravityQuotaAvailableForModel(
  credits: AccountCreditsSnapshot | null | undefined,
  modelId?: string,
): boolean {
  if (!credits) return true;
  const products = credits.productUsage ?? [];
  const scoped = modelId
    ? products.filter((product) => quotaProductMatchesModel(product.product, modelId))
    : products;
  if (scoped.length > 0) return scoped.some((product) => product.usagePercent < 100);
  return credits.usedPercent < 100;
}

function normalizeIsoReset(resetTime: unknown, resetInSeconds?: unknown): string | undefined {
  if (typeof resetTime === "string" && resetTime.trim().length > 0) {
    const parsed = Date.parse(resetTime);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  if (typeof resetTime === "number" && Number.isFinite(resetTime)) {
    const ms = resetTime > 1e11 ? resetTime : resetTime * 1000;
    return new Date(ms).toISOString();
  }
  if (
    typeof resetInSeconds === "number" &&
    Number.isFinite(resetInSeconds) &&
    resetInSeconds >= 0
  ) {
    return new Date(Date.now() + resetInSeconds * 1000).toISOString();
  }
  return undefined;
}

interface MetricItem {
  remainingFraction?: number | undefined;
  remainingPercent?: number | undefined;
  usedPercent: number;
  resetsAt?: string | undefined;
}

function parseMetricItem(value: unknown): MetricItem | null {
  if (!isRecord(value)) return null;

  let remainingFraction: number | undefined;
  let remainingPercent: number | undefined;
  let usedPercent: number | undefined;

  if (typeof value.remaining_fraction === "number" && Number.isFinite(value.remaining_fraction)) {
    remainingFraction = value.remaining_fraction;
    usedPercent = clampPercent((1 - remainingFraction) * 100);
  } else if (
    typeof value.remaining_percent === "number" &&
    Number.isFinite(value.remaining_percent)
  ) {
    remainingPercent = value.remaining_percent;
    usedPercent = clampPercent(100 - remainingPercent);
  } else if (typeof value.pct === "number" && Number.isFinite(value.pct)) {
    remainingPercent = value.pct;
    usedPercent = clampPercent(100 - remainingPercent);
  } else if (typeof value.used_percent === "number" && Number.isFinite(value.used_percent)) {
    usedPercent = clampPercent(value.used_percent);
  } else if (typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent)) {
    usedPercent = clampPercent(value.usedPercent);
  }

  if (usedPercent === undefined) return null;

  let resetsAt: string | undefined = normalizeIsoReset(
    value.reset_time ?? value.resetsAt,
    value.reset_in_seconds,
  );

  if (
    !resetsAt &&
    typeof value.refresh_in_minutes === "number" &&
    Number.isFinite(value.refresh_in_minutes)
  ) {
    resetsAt = new Date(Date.now() + value.refresh_in_minutes * 60 * 1000).toISOString();
  }

  const result: MetricItem = { usedPercent };
  if (remainingFraction !== undefined) result.remainingFraction = remainingFraction;
  if (remainingPercent !== undefined) result.remainingPercent = remainingPercent;
  if (resetsAt !== undefined) result.resetsAt = resetsAt;
  return result;
}

export function isSnapshotExpired(
  credits: AccountCreditsSnapshot,
  now: number = Date.now(),
): boolean {
  if (credits.resetsAt) {
    const resetMs = new Date(credits.resetsAt).getTime();
    if (!Number.isNaN(resetMs) && resetMs <= now) {
      return true;
    }
  }
  return false;
}

/**
 * Projects raw Antigravity statusline telemetry (e.g. from `/tmp/agy_statusline_raw.json`)
 * into the standard `AccountCreditsSnapshot`.
 */
export function projectAntigravityRawQuota(
  payload: unknown,
  preferredGroup?: "gemini" | "3p",
): AccountCreditsSnapshot | null {
  let root: unknown = payload;
  if (typeof payload === "string") {
    try {
      root = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!isRecord(root)) return null;

  const quota = isRecord(root.quota) ? root.quota : isRecord(root.groups) ? null : root;
  if (!isRecord(quota)) return null;

  const gemini5h = parseMetricItem(quota["gemini-5h"] ?? quota["gemini_5h"]);
  const geminiWeekly = parseMetricItem(quota["gemini-weekly"] ?? quota["gemini_weekly"]);
  const threeP5h = parseMetricItem(quota["3p-5h"] ?? quota["3p_5h"]);
  const threePWeekly = parseMetricItem(quota["3p-weekly"] ?? quota["3p_weekly"]);

  const primary =
    preferredGroup === "3p"
      ? (threeP5h ?? threePWeekly ?? gemini5h ?? geminiWeekly)
      : (gemini5h ?? threeP5h ?? geminiWeekly ?? threePWeekly);
  if (!primary) return null;

  const periodType: AccountCreditsSnapshot["periodType"] =
    primary === gemini5h || primary === threeP5h ? "five_hour" : "weekly";

  const productUsage: AntigravityCreditsProductUsage[] = [];

  const addProduct = (product: string, item: MetricItem | null) => {
    if (!item) return;
    const entry: AntigravityCreditsProductUsage = {
      product,
      usagePercent: item.usedPercent,
    };
    if (item.resetsAt) entry.resetsAt = item.resetsAt;
    productUsage.push(entry);
  };

  if (preferredGroup === "3p") {
    addProduct("3P 5-hour limit", threeP5h);
    addProduct("3P Weekly limit", threePWeekly);
    addProduct("Gemini 5-hour limit", gemini5h);
    addProduct("Gemini Weekly limit", geminiWeekly);
  } else {
    addProduct("Gemini 5-hour limit", gemini5h);
    addProduct("Gemini Weekly limit", geminiWeekly);
    addProduct("3P 5-hour limit", threeP5h);
    addProduct("3P Weekly limit", threePWeekly);
  }

  const candidate: AccountCreditsSnapshot = {
    usedPercent: primary.usedPercent,
    periodType,
  };
  if (primary.resetsAt) candidate.resetsAt = primary.resetsAt;
  if (productUsage.length > 0) candidate.productUsage = productUsage;

  const parsed = accountCreditsSnapshotSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Projects snapshot telemetry (e.g. from `/tmp/agy_quota_snapshot.json`)
 * into the standard `AccountCreditsSnapshot`.
 */
export function projectAntigravitySnapshotQuota(
  payload: unknown,
  preferredGroup?: "gemini" | "3p",
): AccountCreditsSnapshot | null {
  let root: unknown = payload;
  if (typeof payload === "string") {
    try {
      root = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!isRecord(root)) return null;

  const groups = isRecord(root.groups) ? root.groups : null;
  if (!groups) return null;

  const geminiGroup = isRecord(groups.gemini) ? groups.gemini : null;
  const claudeGptGroup = isRecord(groups.claude_gpt) ? groups.claude_gpt : null;

  const gemini5h = geminiGroup ? parseMetricItem(geminiGroup.five_hour) : null;
  const geminiWeekly = geminiGroup ? parseMetricItem(geminiGroup.weekly) : null;
  const claudeGpt5h = claudeGptGroup ? parseMetricItem(claudeGptGroup.five_hour) : null;
  const claudeGptWeekly = claudeGptGroup ? parseMetricItem(claudeGptGroup.weekly) : null;

  const primary =
    preferredGroup === "3p"
      ? (claudeGpt5h ?? claudeGptWeekly ?? gemini5h ?? geminiWeekly)
      : (gemini5h ?? claudeGpt5h ?? geminiWeekly ?? claudeGptWeekly);
  if (!primary) return null;

  const periodType: AccountCreditsSnapshot["periodType"] =
    primary === gemini5h || primary === claudeGpt5h ? "five_hour" : "weekly";

  const productUsage: AntigravityCreditsProductUsage[] = [];

  const addProduct = (product: string, item: MetricItem | null) => {
    if (!item) return;
    const entry: AntigravityCreditsProductUsage = {
      product,
      usagePercent: item.usedPercent,
    };
    if (item.resetsAt) entry.resetsAt = item.resetsAt;
    productUsage.push(entry);
  };

  if (preferredGroup === "3p") {
    addProduct("Claude and GPT models · 5-hour limit", claudeGpt5h);
    addProduct("Claude and GPT models · Weekly limit", claudeGptWeekly);
    addProduct("Gemini 5-hour limit", gemini5h);
    addProduct("Gemini Weekly limit", geminiWeekly);
  } else {
    addProduct("Gemini 5-hour limit", gemini5h);
    addProduct("Gemini Weekly limit", geminiWeekly);
    addProduct("Claude and GPT models · 5-hour limit", claudeGpt5h);
    addProduct("Claude and GPT models · Weekly limit", claudeGptWeekly);
  }

  const candidate: AccountCreditsSnapshot = {
    usedPercent: primary.usedPercent,
    periodType,
  };
  if (primary.resetsAt) candidate.resetsAt = primary.resetsAt;
  if (productUsage.length > 0) candidate.productUsage = productUsage;

  const parsed = accountCreditsSnapshotSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function parseAntigravityQuotaPayload(
  payload: unknown,
  preferredGroup?: "gemini" | "3p",
): AccountCreditsSnapshot | null {
  return (
    projectAntigravityRawQuota(payload, preferredGroup) ??
    projectAntigravitySnapshotQuota(payload, preferredGroup)
  );
}

export interface AntigravityCreditsPathOptions {
  rawPath?: string | undefined;
  snapshotPath?: string | undefined;
  scriptPath?: string | undefined;
  preferredGroup?: "gemini" | "3p" | undefined;
  allowExpired?: boolean | undefined;
  expectedEmail?: string | undefined;
}

function matchExpectedEmail(text: string, expectedEmail?: string): boolean {
  if (!expectedEmail) return true;
  try {
    const obj = JSON.parse(text);
    return Boolean(
      obj &&
      typeof obj === "object" &&
      typeof obj.email === "string" &&
      obj.email &&
      obj.email.trim().toLowerCase() === expectedEmail.trim().toLowerCase(),
    );
  } catch {
    return false;
  }
}

function resolvePaths(options?: AntigravityCreditsPathOptions): {
  rawPath?: string | undefined;
  snapshotPath?: string | undefined;
  scriptPath: string;
  preferredGroup?: "gemini" | "3p" | undefined;
  allowExpired: boolean;
} {
  const hasExplicit = Boolean(options?.rawPath || options?.snapshotPath);
  return {
    rawPath:
      options?.rawPath ??
      (hasExplicit
        ? undefined
        : (process.env.AGY_STATUSLINE_RAW_PATH ?? DEFAULT_ANTIGRAVITY_STATUSLINE_RAW_PATH)),
    snapshotPath:
      options?.snapshotPath ??
      (hasExplicit
        ? undefined
        : (process.env.AGY_QUOTA_SNAPSHOT_PATH ?? DEFAULT_ANTIGRAVITY_QUOTA_SNAPSHOT_PATH)),
    scriptPath: options?.scriptPath ?? resolveQuotaScriptPath(),
    ...(options?.preferredGroup ? { preferredGroup: options.preferredGroup } : {}),
    allowExpired: options?.allowExpired ?? false,
  };
}

export function readAntigravityCreditsSync(
  options?: AntigravityCreditsPathOptions,
): AccountCreditsSnapshot | null {
  const { rawPath, snapshotPath, preferredGroup, allowExpired } = resolvePaths(options);

  if (rawPath && fs.existsSync(rawPath)) {
    try {
      const rawText = fs.readFileSync(rawPath, "utf-8");
      if (matchExpectedEmail(rawText, options?.expectedEmail)) {
        const credits = parseAntigravityQuotaPayload(rawText, preferredGroup);
        if (credits && (allowExpired || !isSnapshotExpired(credits))) return credits;
      }
    } catch {
      // Ignore read error, fall through to snapshot
    }
  }

  if (snapshotPath && fs.existsSync(snapshotPath)) {
    try {
      const snapshotText = fs.readFileSync(snapshotPath, "utf-8");
      if (matchExpectedEmail(snapshotText, options?.expectedEmail)) {
        const credits = parseAntigravityQuotaPayload(snapshotText, preferredGroup);
        if (credits && (allowExpired || !isSnapshotExpired(credits))) return credits;
      }
    } catch {
      // Ignore read error
    }
  }

  return null;
}

export async function readAntigravityCredits(
  options?: AntigravityCreditsPathOptions,
): Promise<AccountCreditsSnapshot | null> {
  const { rawPath, snapshotPath, preferredGroup, allowExpired } = resolvePaths(options);

  if (rawPath) {
    try {
      const rawText = await fs.promises.readFile(rawPath, "utf-8");
      if (matchExpectedEmail(rawText, options?.expectedEmail)) {
        const credits = parseAntigravityQuotaPayload(rawText, preferredGroup);
        if (credits && (allowExpired || !isSnapshotExpired(credits))) return credits;
      }
    } catch {
      // Ignore read error, fall through to snapshot
    }
  }

  if (snapshotPath) {
    try {
      const snapshotText = await fs.promises.readFile(snapshotPath, "utf-8");
      if (matchExpectedEmail(snapshotText, options?.expectedEmail)) {
        const credits = parseAntigravityQuotaPayload(snapshotText, preferredGroup);
        if (credits && (allowExpired || !isSnapshotExpired(credits))) return credits;
      }
    } catch {
      // Ignore read error
    }
  }

  return null;
}

export async function refreshAntigravityCredits(
  options?: AntigravityCreditsPathOptions,
): Promise<AccountCreditsSnapshot | null> {
  const { rawPath, snapshotPath, scriptPath, preferredGroup } = resolvePaths(options);

  const subOptions: AntigravityCreditsPathOptions = {
    allowExpired: false,
    ...(rawPath !== undefined ? { rawPath } : {}),
    ...(snapshotPath !== undefined ? { snapshotPath } : {}),
    ...(preferredGroup !== undefined ? { preferredGroup } : {}),
  };

  // First attempt reading existing file (only if NOT expired)
  const current = await readAntigravityCredits(subOptions);
  if (current) return current;

  // If no fresh snapshot exists yet, attempt to run quota-status.py if present
  if (fs.existsSync(scriptPath)) {
    try {
      await execFileAsync("python3", [scriptPath], {
        timeout: 2500,
      });
      const refreshed = await readAntigravityCredits(subOptions);
      if (refreshed) return refreshed;
    } catch {
      // Script execution failure is non-fatal
    }
  }

  return null;
}
