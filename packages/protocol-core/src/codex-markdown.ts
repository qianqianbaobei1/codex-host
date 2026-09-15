import path from "node:path";

export interface NormalizeCodexMarkdownOptions {
  cwd?: string | undefined;
  holdIncomplete?: boolean | undefined;
}

const REMOTE_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export class StreamingMarkdownNormalizer {
  #cwd: string | undefined;
  #rawAccumulated = "";
  #projectedText = "";

  constructor(options: { cwd?: string | undefined } = {}) {
    this.#cwd = options.cwd;
  }

  get currentText(): string {
    return this.#projectedText;
  }

  get rawText(): string {
    return this.#rawAccumulated;
  }

  append(delta: string): string {
    if (delta.length === 0) return "";
    this.#rawAccumulated += delta;
    const projected = normalizeCodexMarkdown(this.#rawAccumulated, {
      cwd: this.#cwd,
      holdIncomplete: true,
    });
    if (projected.startsWith(this.#projectedText)) {
      const outputDelta = projected.slice(this.#projectedText.length);
      this.#projectedText = projected;
      return outputDelta;
    }
    // Fallback if projection diverged: emit delta directly
    this.#projectedText += delta;
    return delta;
  }

  flush(): string {
    const finalProjected = normalizeCodexMarkdown(this.#rawAccumulated, {
      cwd: this.#cwd,
      holdIncomplete: false,
    });
    if (finalProjected.startsWith(this.#projectedText)) {
      const delta = finalProjected.slice(this.#projectedText.length);
      this.#projectedText = finalProjected;
      return delta;
    }
    return "";
  }
}

/**
 * Normalizes Markdown text according to Codex Desktop / Astra rendering constraints:
 * 1. Converts file URIs (file://, vscode://) and local file links to [label](/abs/path:line).
 * 2. Normalizes line number fragments (#L10, #L10-L20, :10:5) to single :line.
 * 3. Wraps paths containing spaces in <...>.
 * 4. Strips backticks inside link labels (`[label]` or [`label`]).
 * 5. Ensures CommonMark blank lines before lists and after headings.
 * 6. Preserves code blocks (fenced ``` and inline `).
 * 7. Supports holdIncomplete for streaming stability.
 */
export function normalizeCodexMarkdown(
  text: string,
  options: NormalizeCodexMarkdownOptions = {},
): string {
  const { cwd, holdIncomplete = false } = options;
  let output = "";
  let index = 0;
  let fence = false;

  while (index < text.length) {
    if (fence) {
      const fenceEnd = text.indexOf("```", index);
      if (fenceEnd === -1) {
        output += text.slice(index);
        break;
      }
      output += text.slice(index, fenceEnd + 3);
      index = fenceEnd + 3;
      fence = false;
      continue;
    }

    const fenceStart = text.indexOf("```", index);
    const linkStart = findNextLinkCandidate(text, index);
    const tickStart = indexOfInlineTick(text, index);

    const next = earliestIndex([fenceStart, linkStart, tickStart]);

    if (next === -1) {
      output += text.slice(index);
      break;
    }

    output += text.slice(index, next);

    if (next === fenceStart) {
      output += "```";
      index = fenceStart + 3;
      fence = true;
      continue;
    }

    if (next === linkStart) {
      const parsed = parseMarkdownLink(text, linkStart);
      if (!parsed) {
        // Not a valid link start, emit character and advance. The scan index
        // must always move forward or the whole loop livelocks while appending
        // to `output` until the heap is exhausted.
        output += text[linkStart];
        index = Math.max(linkStart + 1, index + 1);
        continue;
      }

      if (!parsed.closed) {
        if (holdIncomplete) {
          // Hold the incomplete link until more text arrives
          break;
        }
        output += text.slice(linkStart);
        break;
      }

      const normalized = rewriteMarkdownLink(parsed, cwd);
      output += normalized;
      index = parsed.end;
      continue;
    }

    // Inline tick
    const inline = parseInlineCode(text, tickStart);
    if (!inline.closed) {
      if (holdIncomplete) {
        output += text.slice(tickStart);
        break;
      }
      output += text.slice(tickStart);
      break;
    }

    output += text.slice(tickStart, inline.end);
    index = inline.end;
  }

  // CommonMark spacing for headings and lists
  return normalizeCommonMarkSpacing(output);
}

function earliestIndex(candidates: readonly number[]): number {
  let next = -1;
  for (const candidate of candidates) {
    if (candidate === -1) continue;
    if (next === -1 || candidate < next) next = candidate;
  }
  return next;
}

function indexOfInlineTick(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const tick = text.indexOf("`", index);
    if (tick === -1) return -1;
    if (text.startsWith("```", tick)) {
      index = tick + 3;
      continue;
    }
    // Check if this tick is wrapping a link like `[foo](bar)`
    if (text[tick + 1] === "[") {
      return tick;
    }
    return tick;
  }
  return -1;
}

function findNextLinkCandidate(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const bracket = text.indexOf("[", index);
    if (bracket === -1) return -1;
    // Don't treat escaped \[ as link start
    if (bracket > 0 && text[bracket - 1] === "\\") {
      index = bracket + 1;
      continue;
    }
    // Check if preceded by ` e.g. `[label](dest)`
    if (bracket > 0 && text[bracket - 1] === "`") {
      // Never report a candidate before the caller's current scan position:
      // once the scan has resumed past the backtick, `bracket - 1` would stall
      // the caller's index forever (e.g. "`[y/N]`").
      return Math.max(bracket - 1, start);
    }
    return bracket;
  }
  return -1;
}

interface ParsedLink {
  closed: boolean;
  isImage: boolean;
  wrappedInBackticks: boolean;
  label: string;
  rawDestination: string;
  rawTitle?: string | undefined;
  start: number;
  end: number;
}

function parseMarkdownLink(text: string, start: number): ParsedLink | null {
  let cursor = start;
  let wrappedInBackticks = false;

  if (text[cursor] === "`" && text[cursor + 1] === "[") {
    wrappedInBackticks = true;
    cursor += 1;
  }

  const isImage = cursor > 0 && text[cursor - 1] === "!";
  if (text[cursor] !== "[") return null;

  cursor += 1; // skip [
  const labelStart = cursor;
  let labelEnd = -1;
  let depth = 1;

  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "\n") {
      return null;
    }
    if (char === "\\" && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        labelEnd = cursor;
        cursor += 1;
        break;
      }
    }
    cursor += 1;
  }

  if (labelEnd === -1) {
    return {
      closed: false,
      isImage,
      wrappedInBackticks,
      label: text.slice(labelStart),
      rawDestination: "",
      start,
      end: text.length,
    };
  }

  const rawLabel = text.slice(labelStart, labelEnd);

  // Skip whitespace between ] and (
  while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor += 1;
  }

  if (cursor >= text.length || text[cursor] !== "(") {
    return null;
  }

  cursor += 1; // skip (

  while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor += 1;
  }

  if (cursor >= text.length) {
    return {
      closed: false,
      isImage,
      wrappedInBackticks,
      label: rawLabel,
      rawDestination: "",
      start,
      end: text.length,
    };
  }

  let rawDestination = "";
  let rawTitle: string | undefined;

  if (text[cursor] === "<") {
    cursor += 1;
    const innerStart = cursor;
    const closeAngle = text.indexOf(">", cursor);
    if (closeAngle === -1 || text.slice(cursor, closeAngle).includes("\n")) {
      return {
        closed: false,
        isImage,
        wrappedInBackticks,
        label: rawLabel,
        rawDestination: text.slice(innerStart),
        start,
        end: text.length,
      };
    }
    rawDestination = text.slice(innerStart, closeAngle);
    cursor = closeAngle + 1;
  } else {
    // Read destination until closing ')' or title quotes
    const begin = cursor;
    let parenDepth = 0;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === "\n") break;
      if (char === "\\" && cursor + 1 < text.length) {
        cursor += 2;
        continue;
      }
      if (char === "(") {
        parenDepth += 1;
      } else if (char === ")") {
        if (parenDepth === 0) {
          break;
        }
        parenDepth -= 1;
      } else if (
        (char === '"' || char === "'") &&
        cursor > begin &&
        (text[cursor - 1] === " " || text[cursor - 1] === "\t")
      ) {
        // Start of title
        rawDestination = text.slice(begin, cursor - 1).trim();
        const quote = char;
        cursor += 1;
        const titleStart = cursor;
        while (cursor < text.length && text[cursor] !== quote && text[cursor] !== "\n") {
          if (text[cursor] === "\\" && cursor + 1 < text.length) {
            cursor += 2;
            continue;
          }
          cursor += 1;
        }
        if (cursor < text.length && text[cursor] === quote) {
          rawTitle = text.slice(titleStart, cursor);
          cursor += 1;
        }
        break;
      }
      cursor += 1;
    }
    if (!rawDestination) {
      rawDestination = text.slice(begin, cursor).trim();
    }
  }

  // Skip trailing whitespace
  while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor += 1;
  }

  if (cursor >= text.length || text[cursor] !== ")") {
    return {
      closed: false,
      isImage,
      wrappedInBackticks,
      label: rawLabel,
      rawDestination,
      rawTitle,
      start,
      end: text.length,
    };
  }

  cursor += 1; // skip )

  if (wrappedInBackticks && cursor < text.length && text[cursor] === "`") {
    cursor += 1; // skip closing `
  }

  return {
    closed: true,
    isImage,
    wrappedInBackticks,
    label: rawLabel,
    rawDestination,
    rawTitle,
    start,
    end: cursor,
  };
}

function rewriteMarkdownLink(parsed: ParsedLink, cwd?: string): string {
  // If it's an image, keep as-is (Grok or others handle images)
  if (parsed.isImage) {
    return parsed.wrappedInBackticks
      ? `\`![${parsed.label}](${parsed.rawDestination})\``
      : `![${parsed.label}](${parsed.rawDestination})`;
  }

  // Strip backticks inside label: [`app.py`] -> [app.py]
  let cleanLabel = parsed.label;
  if (cleanLabel.startsWith("`") && cleanLabel.endsWith("`") && cleanLabel.length >= 2) {
    cleanLabel = cleanLabel.slice(1, -1);
  }

  const { resolvedPath, lineNumber } = parseAndNormalizeDestination(parsed.rawDestination, cwd);

  if (!resolvedPath) {
    // Non-local or unresolvable destination (e.g. https://...), keep original destination
    const dest = parsed.rawDestination;
    const titlePart = parsed.rawTitle ? ` "${parsed.rawTitle}"` : "";
    return `[${cleanLabel}](${dest}${titlePart})`;
  }

  const target = lineNumber ? `${resolvedPath}:${lineNumber}` : resolvedPath;
  const formattedTarget = /[\s()]/.test(target) ? `<${target}>` : target;
  const titlePart = parsed.rawTitle ? ` "${parsed.rawTitle}"` : "";

  return `[${cleanLabel}](${formattedTarget}${titlePart})`;
}

function parseAndNormalizeDestination(
  raw: string,
  cwd?: string,
): { resolvedPath: string | null; lineNumber?: string | undefined } {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return { resolvedPath: null };

  // Strip enclosing angle brackets if any
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  // Check if remote URL (http:, https:, ftp:, mailto:)
  if (REMOTE_SCHEME_PATTERN.test(trimmed)) {
    if (
      !trimmed.toLowerCase().startsWith("file://") &&
      !trimmed.toLowerCase().startsWith("vscode://")
    ) {
      return { resolvedPath: null };
    }
  }

  // Extract line number
  let pathname = trimmed;
  let lineNumber: string | undefined;

  // Handle file:///... or vscode://file/...
  if (pathname.toLowerCase().startsWith("vscode://file/")) {
    pathname = pathname.slice("vscode://file".length);
  } else if (pathname.toLowerCase().startsWith("vscode://")) {
    pathname = pathname.slice("vscode://".length);
  } else if (pathname.toLowerCase().startsWith("file://")) {
    try {
      const url = new URL(pathname);
      pathname = decodeURIComponent(url.pathname);
      if (url.hash) {
        lineNumber = extractLineNumber(url.hash);
      }
      // Windows file:///C:/path
      if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) {
        pathname = pathname.slice(1);
      }
    } catch {
      pathname = pathname.replace(/^file:\/\/(?:localhost)?/i, "");
    }
  }

  // Extract line number from #L10-L20 or #L10 or #line=10 or :10:5 or :10
  if (!lineNumber) {
    const hashIndex = pathname.indexOf("#");
    if (hashIndex !== -1) {
      const fragment = pathname.slice(hashIndex + 1);
      lineNumber = extractLineNumber(fragment);
      pathname = pathname.slice(0, hashIndex);
    }
  }

  if (!lineNumber) {
    // Check for :line:column or :line at the end
    const lineColMatch = pathname.match(/:(\d+)(?::\d+)?$/);
    if (lineColMatch) {
      lineNumber = lineColMatch[1];
      pathname = pathname.slice(0, lineColMatch.index);
    }
  }

  // Clean trailing query params if any
  const queryIndex = pathname.indexOf("?");
  if (queryIndex !== -1) {
    pathname = pathname.slice(0, queryIndex);
  }

  pathname = decodeURIPath(pathname);

  // Check if absolute or resolvable local path
  const isAbsolute = path.isAbsolute(pathname) || /^[a-zA-Z]:[\\/]/.test(pathname);

  if (isAbsolute) {
    return { resolvedPath: normalizeSeparators(pathname), lineNumber };
  }

  // Relative path
  if (
    cwd &&
    (pathname.startsWith("./") || pathname.startsWith("../") || isLikelyFilePath(pathname))
  ) {
    const resolved = path.resolve(cwd, pathname);
    return { resolvedPath: normalizeSeparators(resolved), lineNumber };
  }

  return { resolvedPath: null };
}

function decodeURIPath(val: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function normalizeSeparators(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function isLikelyFilePath(pathname: string): boolean {
  return /\.[a-zA-Z0-9_-]+$/.test(pathname) || pathname.includes("/");
}

function extractLineNumber(fragment: string): string | undefined {
  const clean = fragment.replace(/^#/, "");
  // L10-L25 or L10-25 or L10 or 10-20 or 10
  const lMatch = clean.match(/^L?(\d+)(?:(?:-L?|\.\.)\d+)?$/i);
  if (lMatch) return lMatch[1];

  const lineParam = clean.match(/(?:line|L)=(\d+)/i);
  if (lineParam) return lineParam[1];

  return undefined;
}

function parseInlineCode(
  text: string,
  start: number,
): { closed: boolean; content: string; end: number } {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\n") {
      return { closed: false, content: text.slice(start + 1, index), end: index };
    }
    if (char === "`") {
      return { closed: true, content: text.slice(start + 1, index), end: index + 1 };
    }
    index += 1;
  }
  return { closed: false, content: text.slice(start + 1), end: text.length };
}

/**
 * Ensures CommonMark spacing rules:
 * - Empty line before any list if preceded by non-empty non-list text
 * - Empty line after a heading if followed by non-empty text
 */
function normalizeCommonMarkSpacing(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i] ?? "";
    const prev = result.length > 0 ? (result[result.length - 1] ?? "") : "";

    const isCurrentList = /^[\t ]*(?:[-*+]|\d+\.)\s+/.test(current);
    const isPrevHeading = /^#{1,6}\s+/.test(prev);
    const isPrevList = /^[\t ]*(?:[-*+]|\d+\.)\s+/.test(prev);
    const isPrevBlank = prev.trim().length === 0;

    // Blank line after heading
    if (isPrevHeading && !isPrevBlank && current.trim().length > 0) {
      result.push("");
    }

    // Blank line before list (if prev is non-blank and not a list)
    if (isCurrentList && !isPrevBlank && !isPrevList) {
      result.push("");
    }

    result.push(current);
  }

  return result.join("\n");
}
