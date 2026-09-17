import { z } from "zod";

import { codexhostErrorSchema } from "./errors.js";
import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
} from "./harness-permission-modes.js";
import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";
import {
  accountBalanceSnapshotSchema,
  accountCreditsSnapshotSchema,
  accountCreditsStatusSchema,
  threadUsageSnapshotSchema,
} from "./thread-usage.js";

export const HARNESS_MODEL_REF_MAX_LENGTH = 512;
export const HARNESS_MODEL_LABEL_MAX_LENGTH = 256;
export const HARNESS_THINKING_OPTION_ID_MAX_LENGTH = 128;
export const THREAD_OWNERSHIP_LIST_MAX_LENGTH = 100;

const nonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Value must not be empty or whitespace",
});

export const harnessModelRefIdSchema = nonBlankTextSchema
  .max(HARNESS_MODEL_REF_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._~-]+$/u, "Model Ref must use transport-safe opaque characters")
  .brand<"HarnessModelRefId">();

export const harnessModelRefSchema = z
  .object({
    id: harnessModelRefIdSchema,
  })
  .strict();

export type HarnessModelRef = z.infer<typeof harnessModelRefSchema>;

export const harnessThinkingOptionIdSchema = nonBlankTextSchema
  .max(HARNESS_THINKING_OPTION_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._~-]+$/u, "Thinking option ID must use transport-safe characters")
  .brand<"HarnessThinkingOptionId">();

export type HarnessThinkingOptionId = z.infer<typeof harnessThinkingOptionIdSchema>;

export const harnessResolvedModelLabelSchema = nonBlankTextSchema.max(
  HARNESS_MODEL_LABEL_MAX_LENGTH,
);

export const harnessThinkingOptionSchema = z
  .object({
    id: harnessThinkingOptionIdSchema,
    label: nonBlankTextSchema.max(HARNESS_MODEL_LABEL_MAX_LENGTH),
  })
  .strict();

export type HarnessThinkingOption = z.infer<typeof harnessThinkingOptionSchema>;

export function thinkingEffortRank(option: HarnessThinkingOption): number {
  const normalizedId = option.id.toLowerCase().replace(/[-_]/g, "");
  const normalizedLabel = option.label.toLowerCase().replace(/[-_\s]/g, "");

  // Level 0: Off / None / Disabled / 关闭
  if (
    normalizedId === "off" ||
    normalizedId === "none" ||
    normalizedId === "disabled" ||
    normalizedId === "false" ||
    normalizedLabel === "off" ||
    normalizedLabel.includes("关闭") ||
    normalizedLabel.includes("不思考")
  ) {
    return 0;
  }

  // Level 1: Minimal / Tiny / Lowest / 极低 / 微度 / 微量
  if (
    normalizedId === "minimal" ||
    normalizedId === "min" ||
    normalizedId === "tiny" ||
    normalizedId === "lowest" ||
    normalizedLabel.includes("minimal") ||
    normalizedLabel.includes("极低") ||
    normalizedLabel.includes("微度") ||
    normalizedLabel.includes("微量")
  ) {
    return 10;
  }

  // Level 2: Auto / 自动
  if (normalizedId === "auto" || normalizedLabel === "auto" || normalizedLabel.includes("自动")) {
    return 15;
  }

  // Level 3: Low / Light / 轻度 / 低 / 节能
  if (
    normalizedId === "low" ||
    normalizedId === "light" ||
    normalizedLabel.includes("low") ||
    normalizedLabel.includes("轻度") ||
    normalizedLabel.includes("低") ||
    normalizedLabel.includes("节能")
  ) {
    return 20;
  }

  // Level 4: Medium / Moderate / Standard / Default / Normal / 中 / 中度 / 中等 / 均衡 / 标准
  if (
    normalizedId === "medium" ||
    normalizedId === "med" ||
    normalizedId === "moderate" ||
    normalizedId === "standard" ||
    normalizedId === "default" ||
    normalizedId === "normal" ||
    normalizedLabel.includes("medium") ||
    normalizedLabel.includes("moderate") ||
    normalizedLabel.includes("standard") ||
    normalizedLabel.includes("中度") ||
    normalizedLabel.includes("中等") ||
    normalizedLabel.includes("均衡") ||
    normalizedLabel.includes("标准") ||
    normalizedLabel.includes("默认") ||
    (normalizedLabel.includes("中") && !normalizedLabel.includes("超"))
  ) {
    return 30;
  }

  // Level 5: High / Deep / 高 / 深度
  if (
    normalizedId === "high" ||
    normalizedId === "deep" ||
    normalizedLabel.includes("high") ||
    normalizedLabel.includes("deep") ||
    normalizedLabel.includes("深度") ||
    (normalizedLabel.includes("高") &&
      !normalizedLabel.includes("极高") &&
      !normalizedLabel.includes("最高") &&
      !normalizedLabel.includes("超高"))
  ) {
    return 40;
  }

  // Level 6: Extra High / XHigh / Very High / 超高 / 最高
  if (
    normalizedId === "xhigh" ||
    normalizedId === "extrahigh" ||
    normalizedId === "veryhigh" ||
    normalizedId === "higher" ||
    normalizedLabel.includes("extrahigh") ||
    normalizedLabel.includes("veryhigh") ||
    normalizedLabel.includes("超高") ||
    normalizedLabel.includes("最高")
  ) {
    return 50;
  }

  // Level 7: Max / Ultra / Extreme / 极高 / 极限 / 最大
  if (
    normalizedId === "max" ||
    normalizedId === "maximum" ||
    normalizedId === "ultra" ||
    normalizedId === "extreme" ||
    normalizedLabel.includes("max") ||
    normalizedLabel.includes("ultra") ||
    normalizedLabel.includes("extreme") ||
    normalizedLabel.includes("极高") ||
    normalizedLabel.includes("极限") ||
    normalizedLabel.includes("最大")
  ) {
    return 60;
  }

  const num = Number(option.id);
  if (!Number.isNaN(num)) {
    return 100 + num;
  }

  return 25;
}

export function sortThinkingOptionsByEffort(
  options: readonly HarnessThinkingOption[],
): HarnessThinkingOption[] {
  return [...options].sort((a, b) => thinkingEffortRank(a) - thinkingEffortRank(b));
}

export const harnessModelSchema = z
  .object({
    ref: harnessModelRefSchema,
    label: nonBlankTextSchema.max(HARNESS_MODEL_LABEL_MAX_LENGTH),
    resolvedModelLabel: harnessResolvedModelLabelSchema.optional(),
    supportedThinkingOptionIds: z.array(harnessThinkingOptionIdSchema).optional(),
  })
  .strict();

export type HarnessModel = z.infer<typeof harnessModelSchema>;

const harnessThinkingOptionsSchema = z
  .array(harnessThinkingOptionSchema)
  .superRefine((options, context) => {
    const ids = new Set<string>();
    for (const [index, option] of options.entries()) {
      if (ids.has(option.id)) {
        context.addIssue({
          code: "custom",
          message: "Thinking option IDs must be unique",
          path: [index, "id"],
        });
      }
      ids.add(option.id);
    }
  });

export const harnessModelCatalogSchema = z
  .object({
    models: z.array(harnessModelSchema),
    defaultModel: harnessModelRefSchema.optional(),
    thinkingOptions: harnessThinkingOptionsSchema,
    defaultThinkingOptionId: harnessThinkingOptionIdSchema.optional(),
  })
  .strict()
  .superRefine((catalog, context) => {
    const refs = new Set<string>();
    const thinkingIds = new Set(catalog.thinkingOptions.map(({ id }) => id));
    for (const [index, model] of catalog.models.entries()) {
      if (refs.has(model.ref.id)) {
        context.addIssue({
          code: "custom",
          message: "Model Catalog refs must be unique",
          path: ["models", index, "ref", "id"],
        });
      }
      refs.add(model.ref.id);
      const supportedThinkingIds = new Set<string>();
      for (const [optionIndex, optionId] of (model.supportedThinkingOptionIds ?? []).entries()) {
        if (supportedThinkingIds.has(optionId)) {
          context.addIssue({
            code: "custom",
            message: "Supported Thinking option IDs must be unique per Model",
            path: ["models", index, "supportedThinkingOptionIds", optionIndex],
          });
        }
        supportedThinkingIds.add(optionId);
        if (!thinkingIds.has(optionId)) {
          context.addIssue({
            code: "custom",
            message: "Supported Thinking option must exist in the catalog",
            path: ["models", index, "supportedThinkingOptionIds", optionIndex],
          });
        }
      }
    }
    if (catalog.defaultModel && !refs.has(catalog.defaultModel.id)) {
      context.addIssue({
        code: "custom",
        message: "Default Model must exist in the Model Catalog",
        path: ["defaultModel", "id"],
      });
    }
    if (catalog.defaultThinkingOptionId && !thinkingIds.has(catalog.defaultThinkingOptionId)) {
      context.addIssue({
        code: "custom",
        message: "Default Thinking option must exist in the catalog",
        path: ["defaultThinkingOptionId"],
      });
    }
  });

export type HarnessModelCatalog = z.infer<typeof harnessModelCatalogSchema>;

const harnessHistoryCapabilitiesSchema = z
  .object({
    fork: z.boolean(),
    forkAcrossCwd: z.boolean(),
    rollbackLastTurn: z.boolean(),
  })
  .strict()
  .refine((history) => history.fork || !history.forkAcrossCwd, {
    path: ["forkAcrossCwd"],
    message: "Cross-cwd Fork requires exact history Fork support",
  });

export const harnessPermissionModeScopeSchema = z.enum(["live", "atCreate"]);

export type HarnessPermissionModeScope = z.infer<typeof harnessPermissionModeScopeSchema>;

export function permissionModeFixedAtCreate(configuration: {
  permissionModeScope?: HarnessPermissionModeScope;
}): boolean {
  return configuration.permissionModeScope === "atCreate";
}

export const harnessSessionCapabilitiesSchema = z
  .object({
    configuration: z
      .object({
        selectModel: z.boolean(),
        selectThinkingOption: z.boolean(),
        selectPermissionMode: z.boolean(),
        permissionModeScope: harnessPermissionModeScopeSchema.default("live"),
      })
      .strict(),
    history: harnessHistoryCapabilitiesSchema,
    subagents: z
      .object({
        observe: z.boolean(),
        readTranscript: z.boolean(),
      })
      .strict()
      .optional(),
    autonomousTurns: z
      .object({
        observe: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type HarnessSessionCapabilities = z.infer<typeof harnessSessionCapabilitiesSchema>;

export const harnessConfigurationStateSchema = z
  .object({
    effectiveModel: harnessModelRefSchema.optional(),
    resolvedModelLabel: harnessResolvedModelLabelSchema.optional(),
    effectiveThinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    availableThinkingOptions: harnessThinkingOptionsSchema.optional(),
    effectivePermissionModeId: harnessPermissionModeIdSchema.optional(),
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.effectiveThinkingOptionId &&
      state.availableThinkingOptions &&
      !state.availableThinkingOptions.some(({ id }) => id === state.effectiveThinkingOptionId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Effective Thinking option must be currently available",
        path: ["effectiveThinkingOptionId"],
      });
    }
  });

export type HarnessConfigurationState = z.infer<typeof harnessConfigurationStateSchema>;

export const harnessModelSelectionStateSchema = harnessConfigurationStateSchema;
export type HarnessModelSelectionState = HarnessConfigurationState;

export const harnessWebUiCapabilitySchema = z
  .object({
    open: z.literal(true),
  })
  .strict();

export type HarnessWebUiCapability = z.infer<typeof harnessWebUiCapabilitySchema>;

const readyHarnessInspectionSchema = z
  .object({
    status: z.literal("ready"),
    catalog: harnessModelCatalogSchema,
    accountCredits: accountCreditsSnapshotSchema.optional(),
    accountBalance: accountBalanceSnapshotSchema.optional(),
    accountBalanceStatus: accountCreditsStatusSchema.optional(),
    accountCreditsStatus: accountCreditsStatusSchema.optional(),
    permissionModes: harnessPermissionModeCatalogSchema.optional(),
    capabilities: harnessSessionCapabilitiesSchema,
    webUi: harnessWebUiCapabilitySchema.optional(),
  })
  .strict()
  .superRefine((inspection, context) => {
    const selectable = inspection.capabilities.configuration.selectPermissionMode;
    if (selectable !== Boolean(inspection.permissionModes)) {
      context.addIssue({
        code: "custom",
        message: "Permission Mode catalog and capability must agree",
        path: selectable
          ? ["permissionModes"]
          : ["capabilities", "configuration", "selectPermissionMode"],
      });
    }
  });

const failedHarnessInspectionSchema = z
  .object({
    status: z.enum(["notInstalled", "unavailable", "error"]),
    error: codexhostErrorSchema,
  })
  .strict();

export const harnessInspectionSchema = z.union([
  readyHarnessInspectionSchema,
  failedHarnessInspectionSchema,
]);

export type HarnessInspection = z.infer<typeof harnessInspectionSchema>;

export const harnessInspectParamsSchema = z
  .object({
    harnessId: harnessIdSchema,
    cwd: nonBlankTextSchema.max(16_384).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

export type HarnessInspectParams = z.infer<typeof harnessInspectParamsSchema>;

export const harnessWebUiOpenParamsSchema = z
  .object({
    harnessId: harnessIdSchema,
  })
  .strict();

export type HarnessWebUiOpenParams = z.infer<typeof harnessWebUiOpenParamsSchema>;

export const harnessWebUiOpenResultSchema = z.object({}).strict();

export type HarnessWebUiOpenResult = z.infer<typeof harnessWebUiOpenResultSchema>;

export const threadModelSelectParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    model: harnessModelRefSchema,
  })
  .strict();

export type ThreadModelSelectParams = z.infer<typeof threadModelSelectParamsSchema>;

export const threadThinkingSelectParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    thinkingOptionId: harnessThinkingOptionIdSchema,
  })
  .strict();

export type ThreadThinkingSelectParams = z.infer<typeof threadThinkingSelectParamsSchema>;

export const threadInspectionParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
  })
  .strict();

export type ThreadInspectionParams = z.infer<typeof threadInspectionParamsSchema>;

const codexThreadInspectionSchema = z
  .object({
    owner: z.literal("codex"),
    accountId: nonBlankTextSchema.optional(),
    locked: z.literal(true),
  })
  .strict();

const externalThreadInspectionSchema = z
  .object({
    owner: z.literal("external"),
    harnessId: nonBlankTextSchema.max(256),
    /** Native Account this Thread is bound to; omitted when unknown or single-account. */
    harnessAccountId: nonBlankTextSchema.max(256).optional(),
    transportModelId: nonBlankTextSchema.max(1_024),
    effectiveModel: harnessModelRefSchema.optional(),
    resolvedModelLabel: harnessResolvedModelLabelSchema.optional(),
    effectiveThinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    availableThinkingOptions: harnessThinkingOptionsSchema.optional(),
    effectivePermissionModeId: harnessPermissionModeIdSchema.optional(),
    history: harnessHistoryCapabilitiesSchema,
    usage: threadUsageSnapshotSchema.optional(),
    locked: z.literal(true),
  })
  .strict();

export const threadInspectionSchema = z.discriminatedUnion("owner", [
  codexThreadInspectionSchema,
  externalThreadInspectionSchema,
]);

export type ThreadInspection = z.infer<typeof threadInspectionSchema>;

export const threadOwnershipListParamsSchema = z
  .object({
    threadIds: z.array(hostThreadIdSchema).min(1).max(THREAD_OWNERSHIP_LIST_MAX_LENGTH),
  })
  .strict()
  .superRefine(({ threadIds }, context) => {
    const seen = new Set<string>();
    for (const [index, threadId] of threadIds.entries()) {
      if (seen.has(threadId)) {
        context.addIssue({
          code: "custom",
          message: "Thread ownership-list IDs must be unique",
          path: ["threadIds", index],
        });
      }
      seen.add(threadId);
    }
  });

export type ThreadOwnershipListParams = z.infer<typeof threadOwnershipListParamsSchema>;

const codexThreadOwnershipSchema = z
  .object({
    threadId: hostThreadIdSchema,
    owner: z.literal("codex"),
  })
  .strict();

const externalThreadOwnershipSchema = z
  .object({
    threadId: hostThreadIdSchema,
    owner: z.literal("external"),
    harnessId: z.string().max(256).pipe(harnessIdSchema),
  })
  .strict();

export const threadOwnershipSchema = z.discriminatedUnion("owner", [
  codexThreadOwnershipSchema,
  externalThreadOwnershipSchema,
]);

export type ThreadOwnership = z.infer<typeof threadOwnershipSchema>;

export const threadOwnershipListResultSchema = z
  .object({
    threads: z.array(threadOwnershipSchema).min(1).max(THREAD_OWNERSHIP_LIST_MAX_LENGTH),
  })
  .strict()
  .superRefine(({ threads }, context) => {
    const seen = new Set<string>();
    for (const [index, thread] of threads.entries()) {
      if (seen.has(thread.threadId)) {
        context.addIssue({
          code: "custom",
          message: "Thread ownership-list results must be unique",
          path: ["threads", index, "threadId"],
        });
      }
      seen.add(thread.threadId);
    }
  });

export type ThreadOwnershipListResult = z.infer<typeof threadOwnershipListResultSchema>;
