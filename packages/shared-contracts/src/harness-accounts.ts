import { z } from "zod";
import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";
import { accountCreditsSnapshotSchema } from "./thread-usage.js";

/** Read-only telemetry for the Harness's current native authentication, never a login record. */
export const harnessAccountSnapshotSchema = z
  .object({
    email: z.string().trim().min(1).max(320).optional(),
    label: z.string().trim().min(1).max(256).optional(),
    plan: z.string().trim().min(1).max(128).optional(),
    credits: accountCreditsSnapshotSchema.optional(),
    /**
     * The quota numbers are the last known snapshot rather than the current state: the most
     * recent probe for this Account failed. The numbers are kept so a transient failure does
     * not erase them, but they must not be presented as a fresh reading.
     */
    creditsStale: z.boolean().optional(),
    /** Why the most recent probe failed, for the row's tooltip. Never a login record. */
    creditsError: z.string().trim().min(1).max(200).optional(),
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
    authState: z.enum(["ready", "needs_login", "cooldown", "disabled"]).optional(),
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

/** Point one existing Thread at another native Account and continue it there. */
export const THREAD_ACCOUNT_SELECT_METHOD = "codexhost/thread/account/select" as const;

export const threadAccountSelectParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    accountId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._~-]+$/u),
  })
  .strict();
export type ThreadAccountSelectParams = z.infer<typeof threadAccountSelectParamsSchema>;

export const threadAccountSelectResultSchema = z
  .object({
    threadId: hostThreadIdSchema,
    harnessId: harnessIdSchema,
    accountId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._~-]+$/u),
  })
  .strict();
export type ThreadAccountSelectResult = z.infer<typeof threadAccountSelectResultSchema>;

/** Explicitly refresh read-only quota telemetry for all reported Harness accounts. */
export const HARNESS_ACCOUNT_REFRESH_METHOD = "codexhost/harness/accounts/refresh" as const;

/** Start an explicit, user-authorized login for one native Harness account. */
export const HARNESS_ACCOUNT_LOGIN_START_METHOD = "codexhost/harness/accounts/login/start" as const;

/** Create a new isolated account for a Harness that supports multi-account management. */
export const HARNESS_ACCOUNT_CREATE_METHOD = "codexhost/harness/accounts/create" as const;

export const harnessAccountCreateParamsSchema = z
  .object({
    harnessId: harnessIdSchema,
    accountId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._~-]+$/u),
    name: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type HarnessAccountCreateParams = z.infer<typeof harnessAccountCreateParamsSchema>;

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

export const harnessAccountLoginStartParamsSchema = z
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
export type HarnessAccountLoginStartParams = z.infer<typeof harnessAccountLoginStartParamsSchema>;

export const harnessAccountLoginStartResultSchema = z
  .object({
    started: z.literal(true),
    harnessId: harnessIdSchema,
    accountId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._~-]+$/u),
  })
  .strict();
export type HarnessAccountLoginStartResult = z.infer<typeof harnessAccountLoginStartResultSchema>;

/** Delete a custom isolated account for a Harness that supports multi-account management. */
export const HARNESS_ACCOUNT_DELETE_METHOD = "codexhost/harness/accounts/delete" as const;

export const harnessAccountDeleteParamsSchema = z
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
export type HarnessAccountDeleteParams = z.infer<typeof harnessAccountDeleteParamsSchema>;
