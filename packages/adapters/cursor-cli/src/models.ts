import {
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
} from "@codexhost/shared-contracts";
import type { HarnessModelCatalog, HarnessSessionCapabilities } from "@codexhost/harness-adapter";
import type { CursorSessionInfo } from "./transport.js";

export const CURSOR_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: false,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: true, readTranscript: false },
};
export const CURSOR_MODES = harnessPermissionModeCatalogSchema.parse({
  defaultModeId: "agent",
  modes: [
    { id: "agent", label: "Agent", description: "Native agent mode with Cursor tool approvals" },
    { id: "plan", label: "Plan", description: "Native read-only planning mode" },
    { id: "ask", label: "Ask", description: "Native read-only question mode" },
  ],
});
export const cursorModelRef = (nativeId: string) =>
  harnessModelRefSchema.parse({ id: `cursor.${Buffer.from(nativeId).toString("base64url")}` });
export function cursorModels(info: CursorSessionInfo) {
  const option = info.configOptions?.find((option) => option.id === "model");
  if (!option || option.type !== "select")
    throw new Error("Cursor returned no model configuration");
  const models = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
  return { models, current: option.currentValue };
}
export function cursorCatalog(info: CursorSessionInfo): HarnessModelCatalog {
  const native = cursorModels(info);
  const models = native.models.map((model) => ({
    ref: cursorModelRef(model.value),
    label: model.name,
  }));
  if (!models.length) throw new Error("Cursor returned no model catalog");
  return { models, defaultModel: cursorModelRef(native.current), thinkingOptions: [] };
}
export function cursorNativeModel(info: CursorSessionInfo, ref: string): string {
  const native = cursorModels(info).models.find((model) => cursorModelRef(model.value).id === ref);
  if (!native) throw new Error("Model is not in this Cursor session's native catalog");
  return native.value;
}

/**
 * Parse `cursor-agent models` stdout into a Harness Model catalog.
 *
 * The lightweight subcommand lists the same account catalog as an ACP session
 * (`id - Label`, with `(current, default)` on the active entry) and answers in
 * ~2.4s, while opening a full ACP session for discovery costs ~14s on large
 * workspaces. Keep this parser strictly line-based: anything that does not
 * match the `id - Label` shape is skipped rather than guessed.
 */
export function parseCursorModelsOutput(output: string): HarnessModelCatalog {
  const entries: Array<{ value: string; name: string }> = [];
  const seen = new Set<string>();
  let current: string | null = null;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || /^tip:/iu.test(line)) continue;
    const separator = line.indexOf(" - ");
    if (separator <= 0) continue;
    const value = line.slice(0, separator).trim();
    if (value.length === 0 || /\s/u.test(value)) continue;
    const isCurrent = /\(current\b/u.test(line);
    const name = line
      .slice(separator + 3)
      .replace(/\s*\((?:current|default)[^)]*\)/giu, "")
      .trim();
    if (name.length === 0 || seen.has(value)) continue;
    seen.add(value);
    entries.push({ value, name });
    if (isCurrent && current === null) current = value;
  }
  if (entries.length === 0) throw new Error("Cursor returned no model catalog");
  const firstEntry = entries[0];
  if (!firstEntry) throw new Error("Cursor returned no default Model");
  return {
    models: entries.map((entry) => ({ ref: cursorModelRef(entry.value), label: entry.name })),
    defaultModel: cursorModelRef(current ?? firstEntry.value),
    thinkingOptions: [],
  };
}
