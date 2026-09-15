import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type GrokPermissionMode = "ask" | "auto" | "always-approve";

const nativePermissionModes = new Set<GrokPermissionMode>(["ask", "auto", "always-approve"]);

export const GROK_DEFAULT_PERMISSION_MODE_ID =
  harnessPermissionModeIdSchema.parse("always-approve");
const GROK_ASK_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("ask");

export const GROK_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "ask",
        label: "Ask",
        description: "Ask before protected tool actions.",
      },
      {
        id: "auto",
        label: "Auto",
        description: "Let Grok Build decide which tool actions may run automatically.",
      },
      {
        id: "always-approve",
        label: "Always approve",
        description: "Approve all tool actions without prompting.",
        dangerous: true,
      },
    ],
    defaultModeId: GROK_DEFAULT_PERMISSION_MODE_ID,
  });

export function decodeGrokPermissionModeId(
  permissionModeId: HarnessPermissionModeId,
): GrokPermissionMode {
  const parsed = harnessPermissionModeIdSchema.parse(permissionModeId);
  if (!nativePermissionModes.has(parsed as GrokPermissionMode)) {
    throw new Error("Grok Permission Mode belongs to another Adapter");
  }
  return parsed as GrokPermissionMode;
}

export function resolveGrokPermissionModeId(
  requested: HarnessPermissionModeId | undefined,
  options: { readonly migrateAsk?: boolean } = {},
): HarnessPermissionModeId {
  if (!requested || (options.migrateAsk === true && requested === GROK_ASK_PERMISSION_MODE_ID)) {
    return GROK_DEFAULT_PERMISSION_MODE_ID;
  }
  return requested;
}

export function grokPermissionModeSessionMeta(permissionMode: GrokPermissionMode): {
  yoloMode: boolean;
  autoMode: boolean;
} {
  return {
    yoloMode: permissionMode === "always-approve",
    autoMode: permissionMode === "auto",
  };
}
