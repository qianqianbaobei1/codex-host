import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ThreadAliasStore } from "../src/thread-alias-store.js";

describe("ThreadAliasStore", () => {
  it("manages bi-directional thread alias mappings and persists to disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "thread-alias-test-"));
    try {
      const store = new ThreadAliasStore({ directory: dir });

      // Unmapped ids resolve to themselves, reverse resolves to null
      expect(store.resolve("unknown-ext")).toBe("unknown-ext");
      expect(store.reverseResolve("unknown-off")).toBeNull();
      expect(store.has("unknown-ext")).toBe(false);
      expect(store.hasOfficial("unknown-off")).toBe(false);

      // Set alias
      await store.setAlias("ext-1", "off-1");
      expect(store.resolve("ext-1")).toBe("off-1");
      expect(store.reverseResolve("off-1")).toBe("ext-1");
      expect(store.has("ext-1")).toBe(true);
      expect(store.hasOfficial("off-1")).toBe(true);

      // Reload store from disk to verify persistence
      const reloaded = new ThreadAliasStore({ directory: dir });
      expect(reloaded.resolve("ext-1")).toBe("off-1");
      expect(reloaded.reverseResolve("off-1")).toBe("ext-1");
      expect(reloaded.has("ext-1")).toBe(true);
      expect(reloaded.hasOfficial("off-1")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
