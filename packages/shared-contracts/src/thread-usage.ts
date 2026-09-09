import { z } from "zod";

import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";

const nonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const finiteNonNegativeNumberSchema = z.number().finite().nonnegative();
const cacheHitRatePercentSchema = z.number().finite().min(0).max(100);

export const threadUsageSnapshotSchema = z
  .object({
    inputTokens: nonNegativeSafeIntegerSchema.optional(),
    cachedInputTokens: nonNegativeSafeIntegerSchema.optional(),
    cacheWriteInputTokens: nonNegativeSafeIntegerSchema.optional(),
    outputTokens: nonNegativeSafeIntegerSchema.optional(),
    outputTokensPerSecond: finiteNonNegativeNumberSchema.optional(),
    reasoningOutputTokens: nonNegativeSafeIntegerSchema.optional(),
    totalTokens: nonNegativeSafeIntegerSchema.optional(),
    totalCostUsd: finiteNonNegativeNumberSchema.optional(),
    cacheHitRatePercent: cacheHitRatePercentSchema.optional(),
    contextWindowTokens: nonNegativeSafeIntegerSchema.optional(),
    contextUsedTokens: nonNegativeSafeIntegerSchema.optional(),
    planFiveHourUsedPercent: cacheHitRatePercentSchema.optional(),
    planFiveHourResetsAtUnix: nonNegativeSafeIntegerSchema.optional(),
    planSevenDayUsedPercent: cacheHitRatePercentSchema.optional(),
    planSevenDayResetsAtUnix: nonNegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (Object.keys(usage).length === 0) {
      context.addIssue({ code: "custom", message: "Thread Usage must contain a reliable field" });
    }
    const hasContextUsed = usage.contextUsedTokens !== undefined;
    const hasContextWindow = usage.contextWindowTokens !== undefined;
    if (hasContextUsed !== hasContextWindow) {
      context.addIssue({
        code: "custom",
        message: "Thread Usage context fields must be provided together",
        path: [hasContextUsed ? "contextWindowTokens" : "contextUsedTokens"],
      });
    }
    if (usage.contextWindowTokens === 0) {
      context.addIssue({
        code: "custom",
        message: "Thread Usage contextWindowTokens must be greater than zero",
        path: ["contextWindowTokens"],
      });
    }
    if (
      usage.planFiveHourResetsAtUnix !== undefined &&
      usage.planFiveHourUsedPercent === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Thread Usage planFiveHourResetsAtUnix must be provided with planFiveHourUsedPercent",
        path: ["planFiveHourResetsAtUnix"],
      });
    }
    if (
      usage.planSevenDayResetsAtUnix !== undefined &&
      usage.planSevenDayUsedPercent === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Thread Usage planSevenDayResetsAtUnix must be provided with planSevenDayUsedPercent",
        path: ["planSevenDayResetsAtUnix"],
      });
    }
  });

export type ThreadUsageSnapshot = z.infer<typeof threadUsageSnapshotSchema>;

const usagePercentSchema = z.number().finite().min(0).max(100);

export const accountCreditsProductUsageSchema = z
  .object({
    product: z.string().min(1),
    usagePercent: usagePercentSchema,
    resetsAt: z.string().min(1).optional(),
  })
  .strict();

export const accountCreditsSnapshotSchema = z
  .object({
    usedPercent: usagePercentSchema,
    resetsAt: z.string().min(1).optional(),
    periodType: z.enum(["weekly", "monthly", "five_hour", "seven_day", "unknown"]),
    productUsage: z.array(accountCreditsProductUsageSchema).min(1).optional(),
  })
  .strict();

export type AccountCreditsSnapshot = z.infer<typeof accountCreditsSnapshotSchema>;

export const accountBalanceInfoSchema = z
  .object({
    currency: z.string().min(1),
    totalBalance: z.number().finite().nonnegative(),
    grantedBalance: z.number().finite().nonnegative().optional(),
    toppedUpBalance: z.number().finite().nonnegative().optional(),
  })
  .strict();

export type AccountBalanceInfo = z.infer<typeof accountBalanceInfoSchema>;

export const accountBalanceSnapshotSchema = z
  .object({ balances: z.array(accountBalanceInfoSchema).min(1) })
  .strict();

export type AccountBalanceSnapshot = z.infer<typeof accountBalanceSnapshotSchema>;

export const accountCreditsStatusSchema = z.enum(["available", "unavailable", "unknown"]);
export type AccountCreditsStatus = z.infer<typeof accountCreditsStatusSchema>;

export const threadUsageOwnerSchema = z
  .object({
    harnessId: harnessIdSchema,
    modelId: z.string().min(1).optional(),
  })
  .strict();

export type ThreadUsageOwner = z.infer<typeof threadUsageOwnerSchema>;

export const threadUsageInspectionParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    refresh: z.literal("exact").optional(),
  })
  .strict();

export type ThreadUsageInspectionParams = z.infer<typeof threadUsageInspectionParamsSchema>;

export const threadUsageInspectionSchema = z
  .object({
    threadId: hostThreadIdSchema,
    usage: threadUsageSnapshotSchema.nullable(),
    accountCredits: accountCreditsSnapshotSchema.optional(),
    accountBalance: accountBalanceSnapshotSchema.optional(),
    accountBalanceStatus: accountCreditsStatusSchema.optional(),
    accountCreditsStatus: accountCreditsStatusSchema.optional(),
    owner: threadUsageOwnerSchema.optional(),
  })
  .strict();

export type ThreadUsageInspection = z.infer<typeof threadUsageInspectionSchema>;
