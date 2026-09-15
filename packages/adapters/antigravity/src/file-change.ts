import path from "node:path";

import type { HostFileChange } from "@codexhost/harness-adapter";

function normalizeDisplayPath(nativePath: string, cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolvedPath = path.isAbsolute(nativePath)
    ? path.resolve(nativePath)
    : path.resolve(cwd, nativePath);
  const relative = path.relative(resolvedCwd, resolvedPath);
  const selected =
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`)
      ? relative
      : resolvedPath;
  return selected.replaceAll("\\", "/");
}

export function projectAntigravityFileChange(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): HostFileChange | null {
  if (toolName === "write_to_file") {
    const targetFile = typeof args.TargetFile === "string" ? args.TargetFile : null;
    const codeContent = typeof args.CodeContent === "string" ? args.CodeContent : null;
    if (!targetFile || codeContent === null) return null;

    const displayPath = normalizeDisplayPath(targetFile, cwd);
    const lines = codeContent.split(/\r?\n/u);
    const isOverwrite = args.Overwrite === true;
    const kind: HostFileChange["kind"] = isOverwrite ? "update" : "add";

    const oldHeader = kind === "add" ? "/dev/null" : `a/${displayPath}`;
    const newHeader = `b/${displayPath}`;
    const hunkHeader =
      kind === "add" ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,0 +1,${lines.length} @@`;

    const diffLines = lines.map((line) => `+${line}`);
    const unifiedDiff = [`--- ${oldHeader}`, `+++ ${newHeader}`, hunkHeader, ...diffLines, ""].join(
      "\n",
    );

    return {
      path: displayPath,
      kind,
      unifiedDiff,
    };
  }

  if (toolName === "replace_file_content") {
    const targetFile = typeof args.TargetFile === "string" ? args.TargetFile : null;
    const targetContent = typeof args.TargetContent === "string" ? args.TargetContent : null;
    const replacementContent =
      typeof args.ReplacementContent === "string" ? args.ReplacementContent : null;
    if (!targetFile || targetContent === null || replacementContent === null) return null;

    const displayPath = normalizeDisplayPath(targetFile, cwd);
    const startLine =
      typeof args.StartLine === "number" &&
      Number.isSafeInteger(args.StartLine) &&
      args.StartLine > 0
        ? args.StartLine
        : 1;

    const oldLines = targetContent.split(/\r?\n/u);
    const newLines = replacementContent.split(/\r?\n/u);

    const hunkHeader = `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`;
    const diffLines = [
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ];

    const unifiedDiff = [
      `--- a/${displayPath}`,
      `+++ b/${displayPath}`,
      hunkHeader,
      ...diffLines,
      "",
    ].join("\n");

    return {
      path: displayPath,
      kind: "update",
      unifiedDiff,
    };
  }

  return null;
}
