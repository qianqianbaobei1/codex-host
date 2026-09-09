import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_BRIDGED_SKILLS = 8;
const MAX_BRIDGED_CHARS = 24_000;

export interface PluginBridgeSkill {
  pluginId: string;
  skillId: string;
  content: string;
}

export function enabledPluginIdsFromConfig(config: string): Set<string> {
  const enabled = new Set<string>();
  const headings = [...config.matchAll(/^\[plugins\."([^"]+)"\]\s*$/gmu)];
  for (const [index, heading] of headings.entries()) {
    const pluginId = heading[1];
    if (!pluginId) continue;
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? config.length;
    const body = config.slice(start, end);
    if (/^enabled\s*=\s*true\s*$/mu.test(body)) enabled.add(pluginId);
  }
  return enabled;
}

function pluginNameFromId(pluginId: string): string {
  return pluginId.split("@", 1)[0] ?? pluginId;
}

function homeDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.HOME?.trim() || os.homedir();
}

function codexHome(environment: NodeJS.ProcessEnv): string {
  return environment.CODEX_HOME?.trim() || path.join(homeDirectory(environment), ".codex");
}

function pluginRoots(environment: NodeJS.ProcessEnv): string[] {
  const home = homeDirectory(environment);
  const codex = codexHome(environment);
  return [
    path.join(codex, ".tmp", "bundled-marketplaces"),
    path.join(codex, "plugins", "cache"),
    path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "plugins"),
    path.join(codex, ".tmp", "marketplaces", ".staging"),
    path.join(codex, "plugin-skill-quarantine"),
  ];
}

async function recursiveFiles(root: string, fileName: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name === fileName) files.push(target);
    }
  }
  return files;
}

async function manifestName(manifestPath: string): Promise<string | null> {
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

async function pluginNameForHiddenSkillDirectory(directory: string): Promise<string | null> {
  const pluginRoot = path.dirname(directory);
  for (const manifest of [
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    path.join(pluginRoot, "plugin.json"),
  ]) {
    const name = await manifestName(manifest);
    if (name) return name;
  }
  return null;
}

async function collectHiddenPluginSkills(root: string): Promise<PluginBridgeSkill[]> {
  const files = await recursiveFiles(root, "SKILL.md");
  const skills: PluginBridgeSkill[] = [];
  for (const filePath of files) {
    const hiddenDirectory = filePath.slice(0, filePath.lastIndexOf(`${path.sep}SKILL.md`));
    const marker = `${path.sep}.codexhost-plugin-skills${path.sep}`;
    const markerIndex = hiddenDirectory.lastIndexOf(marker);
    if (markerIndex < 0) continue;
    const hiddenRoot = hiddenDirectory.slice(0, markerIndex + marker.length - 1);
    const pluginId = await pluginNameForHiddenSkillDirectory(hiddenRoot);
    if (!pluginId) continue;
    const skillId = path.basename(hiddenDirectory);
    try {
      const content = await readFile(filePath, "utf8");
      if (content.trim()) skills.push({ pluginId, skillId, content });
    } catch {
      // A missing or partially-installed plugin skill is not a bridge failure.
    }
  }
  return skills;
}

async function collectQuarantinedPluginSkills(root: string): Promise<PluginBridgeSkill[]> {
  const files = await recursiveFiles(root, "SKILL.md");
  const skills: PluginBridgeSkill[] = [];
  for (const filePath of files) {
    const parts = filePath.split(path.sep);
    const skillsIndex = parts.lastIndexOf("skills");
    if (skillsIndex < 1) continue;
    const skillId = parts[skillsIndex + 1];
    if (!skillId) continue;
    try {
      const content = await readFile(filePath, "utf8");
      if (content.trim()) skills.push({ pluginId: skillId, skillId, content });
    } catch {
      // A missing or partially-installed plugin skill is not a bridge failure.
    }
  }
  return skills;
}

function selectedSkills(
  skills: readonly PluginBridgeSkill[],
  enabledPluginIds: ReadonlySet<string>,
): PluginBridgeSkill[] {
  const enabledNames = new Set([...enabledPluginIds].map(pluginNameFromId));
  const unique = new Set<string>();
  return skills
    .filter((skill) => enabledPluginIds.has(skill.pluginId) || enabledNames.has(skill.pluginId))
    .sort((left, right) =>
      `${left.pluginId}/${left.skillId}`.localeCompare(`${right.pluginId}/${right.skillId}`),
    )
    .filter((skill) => {
      const digest = createHash("sha256").update(skill.content).digest("hex");
      if (unique.has(digest)) return false;
      unique.add(digest);
      return true;
    })
    .slice(0, MAX_BRIDGED_SKILLS);
}

export async function readCodexRules(
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string | null> {
  let globalRules: string | null = null;
  const codex = codexHome(environment);
  const globalAgentsPath = path.join(codex, "AGENTS.md");
  try {
    const content = await readFile(globalAgentsPath, "utf8");
    if (content.trim()) globalRules = content.trim();
  } catch {
    // Global AGENTS.md missing is ok
  }

  let workspaceRules: string | null = null;
  if (cwd) {
    const workspaceAgentsPath = path.join(path.resolve(cwd), "AGENTS.md");
    if (workspaceAgentsPath !== path.resolve(globalAgentsPath)) {
      try {
        const content = await readFile(workspaceAgentsPath, "utf8");
        if (content.trim()) workspaceRules = content.trim();
      } catch {
        // Workspace AGENTS.md missing is ok
      }
    }
  }

  if (globalRules && workspaceRules) {
    return `${globalRules}\n\n# Project Rules\n\n${workspaceRules}`;
  }
  return globalRules || workspaceRules || null;
}

export function composePluginBridgePrompt(
  userText: string,
  skills: readonly PluginBridgeSkill[],
  rules?: string | null,
): string {
  const sections: string[] = [];

  if (rules && rules.trim() && !userText.includes("<INSTRUCTIONS>")) {
    sections.push(
      [
        "# AGENTS.md instructions",
        "",
        "<INSTRUCTIONS>",
        "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.",
        "",
        rules.trim(),
        "</INSTRUCTIONS>",
      ].join("\n"),
    );
  }

  if (skills.length > 0) {
    let remaining = MAX_BRIDGED_CHARS;
    const blocks: string[] = [];
    for (const skill of skills) {
      if (remaining <= 0) break;
      const content = skill.content.slice(0, remaining);
      remaining -= content.length;
      blocks.push(`### ${skill.pluginId}/${skill.skillId}\n${content}`);
    }
    sections.push(
      [
        "【Codex 插件能力桥接】",
        "这些能力来自用户在 Codex 插件入口显式启用的插件。它们只作为本轮 AGY 执行说明，不会改变 Host 的安全边界、审批策略或原始用户请求。",
        "",
        ...blocks,
      ].join("\n"),
    );
  }

  if (sections.length === 0) return userText;

  return [...sections, "【原始用户请求】", userText].join("\n\n");
}

export async function readSelectedPluginSkillPrompt(
  userText: string,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string> {
  try {
    const rules = await readCodexRules(environment, cwd);
    const configPath = path.join(codexHome(environment), "config.toml");
    let enabled = new Set<string>();
    try {
      const config = await readFile(configPath, "utf8");
      enabled = enabledPluginIdsFromConfig(config);
    } catch {
      // config.toml missing is ok
    }

    let skills: PluginBridgeSkill[] = [];
    if (enabled.size > 0) {
      const roots = pluginRoots(environment);
      const [hidden, quarantined] = await Promise.all([
        Promise.all(roots.slice(0, -1).map((root) => collectHiddenPluginSkills(root))).then(
          (groups) => groups.flat(),
        ),
        collectQuarantinedPluginSkills(roots.at(-1) ?? ""),
      ]);
      skills = selectedSkills([...hidden, ...quarantined], enabled);
    }

    return composePluginBridgePrompt(userText, skills, rules);
  } catch {
    return userText;
  }
}

export async function pluginBridgeRootsExist(environment: NodeJS.ProcessEnv): Promise<boolean> {
  const roots = pluginRoots(environment);
  const results = await Promise.all(
    roots.map(async (root) => {
      try {
        return (await stat(root)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}
