import { describe, expect, it } from "vitest";

import { harnessModelRefSchema, type HarnessThinkingOptionId } from "@codexhost/shared-contracts";

import {
  decodeAntigravityModelRef,
  encodeAntigravityModelRef,
  normalizeAntigravityModelCatalog,
  parseAntigravityModelsOutput,
  ANTIGRAVITY_THINKING_OPTION_IDS,
} from "../src/model-catalog.js";

describe("Antigravity Model catalog", () => {
  it("parses all reported model slugs, deduplicates, separates effort from base model and preserves clean labels", () => {
    expect(
      parseAntigravityModelsOutput(
        [
          "Fetching available models...",
          "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
          "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
          "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
          "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
          "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
          "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
          "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
        ].join("\n"),
      ),
    ).toEqual([
      { slug: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      {
        slug: "gemini-3.7-flash",
        label: "Gemini 3.7 Flash",
        supportedThinkingOptionIds: ["low", "medium", "high"],
      },
      {
        slug: "gemini-3.1-pro",
        label: "Gemini 3.1 Pro",
        supportedThinkingOptionIds: ["low", "high"],
      },
      {
        slug: "gpt-oss-120b",
        label: "GPT-OSS 120B",
        supportedThinkingOptionIds: ["medium"],
      },
    ]);
  });

  it("round-trips opaque Model Refs and publishes a default with thinking options", () => {
    const ref = encodeAntigravityModelRef("gemini-3.7-flash");
    expect(ref.id).toMatch(/^antigravity-model-v1\.[A-Za-z0-9_-]+$/u);
    expect(decodeAntigravityModelRef(ref)).toBe("gemini-3.7-flash");
    const catalog = normalizeAntigravityModelCatalog([
      {
        slug: "gemini-3.7-flash",
        label: "Gemini 3.7 Flash",
        supportedThinkingOptionIds: [...ANTIGRAVITY_THINKING_OPTION_IDS],
      },
    ]);
    expect(catalog.defaultModel).toEqual(ref);
    expect(catalog.models[0]?.label).toBe("Gemini 3.7 Flash");
    expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual(["low", "medium", "high"]);
    expect(catalog.thinkingOptions.map((opt) => opt.id)).toEqual(ANTIGRAVITY_THINKING_OPTION_IDS);
    // The catalog default leads with the strongest listed effort (the CLI's own
    // default), upstream-aligned.
    expect(catalog.defaultThinkingOptionId).toBe("high");
  });

  it("normalizes legacy effectiveModel with effort suffix to base model", () => {
    const catalog = normalizeAntigravityModelCatalog(
      [
        {
          slug: "gemini-3.7-flash",
          label: "Gemini 3.7 Flash",
          supportedThinkingOptionIds: [...ANTIGRAVITY_THINKING_OPTION_IDS],
        },
      ],
      "gemini-3.7-flash-high",
      "high" as HarnessThinkingOptionId,
    );
    const defaultModel = catalog.defaultModel;
    if (!defaultModel) throw new Error("Catalog has no default Model");
    expect(decodeAntigravityModelRef(defaultModel)).toBe("gemini-3.7-flash");
    expect(catalog.defaultThinkingOptionId).toBe("high");
  });

  it("rejects foreign and non-canonical Model Refs", () => {
    expect(() =>
      decodeAntigravityModelRef(harnessModelRefSchema.parse({ id: "other-model-v1.value" })),
    ).toThrow("AntigravityAdapter");
    expect(() =>
      decodeAntigravityModelRef(harnessModelRefSchema.parse({ id: "antigravity-model-v1.Zh" })),
    ).toThrow("not canonical");
  });
});
