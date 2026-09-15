import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  GROK_DEFAULT_PERMISSION_MODE_ID,
  GROK_PERMISSION_MODE_CATALOG,
  decodeGrokPermissionModeId,
  grokPermissionModeSessionMeta,
  resolveGrokPermissionModeId,
} from "../src/index.js";

describe("Grok Permission Modes", () => {
  it("exposes native Grok Build Permission Modes and defaults to always-approve", () => {
    expect(GROK_PERMISSION_MODE_CATALOG).toEqual({
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
      defaultModeId: "always-approve",
    });
    expect(GROK_DEFAULT_PERMISSION_MODE_ID).toBe("always-approve");
  });

  it("keeps an explicit create-time Ask selection and migrates historical Ask", () => {
    const ask = harnessPermissionModeIdSchema.parse("ask");
    const auto = harnessPermissionModeIdSchema.parse("auto");
    expect(resolveGrokPermissionModeId(undefined)).toBe("always-approve");
    expect(resolveGrokPermissionModeId(ask)).toBe("ask");
    expect(resolveGrokPermissionModeId(auto)).toBe("auto");
    expect(resolveGrokPermissionModeId(ask, { migrateAsk: true })).toBe("always-approve");
    expect(resolveGrokPermissionModeId(auto, { migrateAsk: true })).toBe("auto");
  });

  it.each([
    ["ask", { yoloMode: false, autoMode: false }],
    ["auto", { yoloMode: false, autoMode: true }],
    ["always-approve", { yoloMode: true, autoMode: false }],
  ] as const)("maps %s to native create metadata", (mode, expected) => {
    const permissionModeId = harnessPermissionModeIdSchema.parse(mode);
    expect(grokPermissionModeSessionMeta(decodeGrokPermissionModeId(permissionModeId))).toEqual(
      expected,
    );
  });
});
