import { z } from "zod";
import { harnessIdSchema } from "./ids.js";
import { accountCreditsSnapshotSchema } from "./thread-usage.js";

/** Read-only telemetry for the Harness's current native authentication, never a login record. */
export const harnessAccountSnapshotSchema = z
  .object({
    email: z.string().trim().min(1).max(320).optional(),
    label: z.string().trim().min(1).max(256).optional(),
    plan: z.string().trim().min(1).max(128).optional(),
    credits: accountCreditsSnapshotSchema,
    /**
     * Present only for Harnesses that expose more than one selectable native
     * account. `accountId` is opaque and owned by the adapter.
     */
    accountId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._~-]+$/u)
      .optional(),
    isDefault: z.boolean().optional(),
    selectable: z.boolean().optional(),
  })
  .strict();
export type HarnessAccountSnapshot = z.infer<typeof harnessAccountSnapshotSchema>;

export const harnessAccountListParamsSchema = z.object({}).strict();
export const harnessAccountListResultSchema = z
  .object({
    accounts: z
      .array(
        harnessAccountSnapshotSchema.extend({
          harnessId: harnessIdSchema,
          harnessName: z.string().min(1),
        }),
      )
      .max(128),
  })
  .strict();
export type HarnessAccountListResult = z.infer<typeof harnessAccountListResultSchema>;

/** Select the default native account for a Harness that exposes selectable accounts. */
export const HARNESS_ACCOUNT_SELECT_METHOD = "codexhost/harness/accounts/select" as const;

export const harnessAccountSelectParamsSchema = z
  .object({
    harnessId: harnessIdSchema,
    accountId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._~-]+$/u),
  })
  .strict();
export type HarnessAccountSelectParams = z.infer<typeof harnessAccountSelectParamsSchema>;
