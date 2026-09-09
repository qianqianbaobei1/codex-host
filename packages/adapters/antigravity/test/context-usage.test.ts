import { describe, expect, it } from "vitest";

import { parseAntigravityContextUsage } from "../src/context-usage.js";

const METADATA = {
  trajectory: {
    generatorMetadata: [
      {
        chatModel: {
          chatStartMetadata: {
            contextWindowMetadata: {
              maxContextTokens: 256_000,
              estimatedTokensUsed: 12_345,
              tokenBreakdown: { totalTokens: 12_345 },
            },
          },
        },
      },
    ],
  },
};

describe("Fusion: Language Server context usage", () => {
  it("parses real context counters from LS metadata", () => {
    const usage = parseAntigravityContextUsage(METADATA);
    expect(usage).toEqual({
      contextUsedTokens: 12_345,
      contextWindowTokens: 256_000,
    });
  });

  it("maps the Gemini 256k LS window onto the 1 Mi-token status-line window", () => {
    const usage = parseAntigravityContextUsage(METADATA, "gemini-3.7-flash");
    expect(usage?.contextWindowTokens).toBe(1_048_576);
    const nonGemini = parseAntigravityContextUsage(METADATA, "gpt-oss-120b");
    expect(nonGemini?.contextWindowTokens).toBe(256_000);
  });

  it("returns null for malformed or empty payloads", () => {
    expect(parseAntigravityContextUsage(null)).toBeNull();
    expect(parseAntigravityContextUsage({ trajectory: {} })).toBeNull();
    expect(parseAntigravityContextUsage({ generatorMetadata: [] })).toBeNull();
  });
});
