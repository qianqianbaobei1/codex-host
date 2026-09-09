import { describe, expect, it } from "vitest";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import {
  ANTIGRAVITY_DEFAULT_PERMISSION_MODE_ID,
  decodeAntigravityPermissionModeId,
} from "../src/permission-modes.js";
import { fetchAntigravityQuota, parseAntigravityUsageCommand } from "../src/quota.js";
import {
  antigravityToolErrorMessage,
  isAntigravityPermissionDenial,
} from "../src/stream-events.js";

describe("Fusion: upstream permission modes", () => {
  it("accepts only the two Antigravity modes", () => {
    expect(
      decodeAntigravityPermissionModeId(harnessPermissionModeIdSchema.parse("configured")),
    ).toBe("configured");
    expect(
      decodeAntigravityPermissionModeId(
        harnessPermissionModeIdSchema.parse("dangerously-skip-permissions"),
      ),
    ).toBe("dangerously-skip-permissions");
    expect(() =>
      decodeAntigravityPermissionModeId(harnessPermissionModeIdSchema.parse("acceptEdits")),
    ).toThrow();
  });
});

describe("Fusion: permission denial recognition", () => {
  it("recognises headless denials and extracts tool diagnostics", () => {
    expect(
      isAntigravityPermissionDenial(
        "permission check failed: write_file is denied by permission rules",
      ),
    ).toBe(true);
    expect(isAntigravityPermissionDenial("read denied permission to run command")).toBe(true);
    expect(isAntigravityPermissionDenial("tool crashed with ENOENT")).toBe(false);
    expect(antigravityToolErrorMessage({ message: "boom" })).toBe("boom");
    expect(antigravityToolErrorMessage("  trimmed  ")).toBe("trimmed");
    expect(antigravityToolErrorMessage({})).toBeNull();
  });
});

describe("Fusion: --print=/usage quota projection", () => {
  it("projects a usage command_result into a credits snapshot", () => {
    const payload = {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini",
            buckets: [
              {
                id: "5h",
                window: "5h",
                remaining_fraction: 0.4,
                reset_time: "2026-09-05T00:00:00Z",
              },
              {
                id: "weekly",
                window: "weekly",
                remaining_fraction: 0.9,
                reset_time: "2026-09-09T00:00:00Z",
              },
            ],
          },
        ],
      },
    };
    const snapshot = parseAntigravityUsageCommand(payload);
    expect(snapshot).not.toBeNull();
    // The 5-hour bucket is the leading one (most consumed), so it drives usedPercent.
    expect(snapshot?.usedPercent).toBe(60);
    expect(snapshot?.periodType).toBe("five_hour");
    expect(snapshot?.productUsage?.some((b) => b.usagePercent === 10)).toBe(true);
  });

  it("rejects payloads that are not a usage command result", () => {
    expect(parseAntigravityUsageCommand({ name: "other", data: { groups: [] } })).toBeNull();
    expect(parseAntigravityUsageCommand(null)).toBeNull();
  });

  it("reads quota from the dedicated --print=/usage invocation", async () => {
    const stdout = [
      JSON.stringify({
        event: "command_result",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini",
                buckets: [{ id: "weekly", window: "weekly", remaining_fraction: 0.5 }],
              },
            ],
          },
        },
      }),
      "",
    ].join("\n");
    const snapshot = await fetchAntigravityQuota(async () => stdout);
    expect(snapshot?.periodType).toBe("weekly");
    expect(snapshot?.usedPercent).toBe(50);
  });

  it("degrades to null when the CLI cannot answer /usage", async () => {
    const snapshot = await fetchAntigravityQuota(async () => {
      throw new Error("agy not installed");
    });
    expect(snapshot).toBeNull();
  });
});

describe("Fusion: inspection contract", () => {
  it("returns a permission catalog that satisfies the shared inspection schema", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { AntigravityAdapter } = await import("../src/antigravity-adapter.js");
    const { harnessInspectionSchema } = await import("@codexhost/shared-contracts");
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-inspect-test-"));
    try {
      const adapter = new AntigravityAdapter(
        { command: path.join(os.homedir(), ".local/bin/agy"), environment: {} },
        {
          listModels: async () => ({
            stdout: "gemini-3.7-flash\tGemini 3.7 Flash\n",
            stderr: "",
          }),
        },
      );
      const inspection = await adapter.inspect({ cwd: root });
      expect(inspection.status).toBe("ready");
      if (inspection.status !== "ready") return;
      // The shared schema cross-checks selectPermissionMode against the catalog.
      expect(() => harnessInspectionSchema.parse(inspection)).not.toThrow();
      expect(inspection.permissionModes?.defaultModeId).toBe(
        ANTIGRAVITY_DEFAULT_PERMISSION_MODE_ID,
      );
      expect(inspection.permissionModes?.defaultModeId).toBe("dangerously-skip-permissions");
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
