import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  composePluginBridgePrompt,
  enabledPluginIdsFromConfig,
  pluginBridgeRootsExist,
  readSelectedPluginSkillPrompt,
} from "../src/plugin-bridge.js";

describe("Antigravity Codex plugin bridge", () => {
  it("reads only explicitly enabled plugin sections", () => {
    expect([
      ...enabledPluginIdsFromConfig(`
[plugins."documents@openai-primary-runtime"]
enabled = true

[plugins."browser@openai-bundled"]
enabled = false
`),
    ]).toEqual(["documents@openai-primary-runtime"]);
  });

  it("does not alter a prompt when no plugin skill is selected", () => {
    expect(composePluginBridgePrompt("hello", [])).toBe("hello");
  });

  it("bridges a selected plugin skill without exposing it as a standalone skill", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-plugin-bridge-"));
    try {
      const pluginRoot = path.join(
        home,
        ".codex",
        "plugins",
        "cache",
        "openai-primary-runtime",
        "documents",
        "1.0.0",
      );
      const skillRoot = path.join(pluginRoot, ".codexhost-plugin-skills", "documents");
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        path.join(home, ".codex", "config.toml"),
        '[plugins."documents@openai-primary-runtime"]\nenabled = true\n',
      );
      await writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "documents" }),
      );
      await writeFile(path.join(skillRoot, "SKILL.md"), "Use the selected document workflow.");

      await expect(pluginBridgeRootsExist({ HOME: home })).resolves.toBe(true);
      await expect(readSelectedPluginSkillPrompt("make a doc", { HOME: home })).resolves.toContain(
        "Use the selected document workflow.",
      );
      await expect(readSelectedPluginSkillPrompt("make a doc", { HOME: home })).resolves.toContain(
        "make a doc",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("bridges global AGENTS.md rules into the prompt", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-rules-bridge-"));
    try {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await writeFile(
        path.join(home, ".codex", "AGENTS.md"),
        "# Personal Codex defaults\n\n回复以大哥开头。\n",
      );

      const prompt = await readSelectedPluginSkillPrompt("生成一份报表", { HOME: home });
      expect(prompt).toContain("# AGENTS.md instructions");
      expect(prompt).toContain("<INSTRUCTIONS>");
      expect(prompt).toContain("回复以大哥开头。");
      expect(prompt).toContain("</INSTRUCTIONS>");
      expect(prompt).toContain("生成一份报表");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("combines global and workspace AGENTS.md rules", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-rules-combo-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexhost-workspace-"));
    try {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await writeFile(path.join(home, ".codex", "AGENTS.md"), "Global rule: preserve formatting.");
      await writeFile(path.join(workspace, "AGENTS.md"), "Workspace rule: target Python 3.12.");

      const prompt = await readSelectedPluginSkillPrompt("run task", { HOME: home }, workspace);
      expect(prompt).toContain("Global rule: preserve formatting.");
      expect(prompt).toContain("# Project Rules");
      expect(prompt).toContain("Workspace rule: target Python 3.12.");
      expect(prompt).toContain("run task");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not duplicate instructions if prompt already contains <INSTRUCTIONS>", () => {
    const existing = "# AGENTS.md instructions\n<INSTRUCTIONS>Already there</INSTRUCTIONS>\nhello";
    const prompt = composePluginBridgePrompt(existing, [], "New rules");
    expect(prompt).toBe(existing);
  });

  it("skips rule bridge when CODEXHOST_DISABLE_RULE_BRIDGE is enabled", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-rules-skip-env-"));
    try {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await writeFile(
        path.join(home, ".codex", "AGENTS.md"),
        "# Personal Codex defaults\n\nRule here.\n",
      );

      const prompt = await readSelectedPluginSkillPrompt("hello", {
        HOME: home,
        CODEXHOST_DISABLE_RULE_BRIDGE: "1",
      });
      expect(prompt).toBe("hello");
      expect(prompt).not.toContain("# AGENTS.md instructions");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("skips rule bridge when config.toml sets [codexhost] bridge_rules = false", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-rules-skip-cfg-"));
    try {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await writeFile(
        path.join(home, ".codex", "AGENTS.md"),
        "# Personal Codex defaults\n\nRule here.\n",
      );
      await writeFile(
        path.join(home, ".codex", "config.toml"),
        "[codexhost]\nbridge_rules = false\n",
      );

      const prompt = await readSelectedPluginSkillPrompt("hello", { HOME: home });
      expect(prompt).toBe("hello");
      expect(prompt).not.toContain("# AGENTS.md instructions");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
