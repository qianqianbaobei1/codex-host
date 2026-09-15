import { describe, expect, it } from "vitest";
import { normalizeCodexMarkdown, StreamingMarkdownNormalizer } from "../src/codex-markdown.js";

describe("normalizeCodexMarkdown", () => {
  it("normalizes file:// URI links to [label](/abs/path:line)", () => {
    const input = "Check [app.py](file:///Users/dev/project/src/app.py#L42) for details.";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe("Check [app.py](/Users/dev/project/src/app.py:42) for details.");
  });

  it("normalizes line ranges to the first line number", () => {
    const input = "See [server.ts](file:///workspace/src/server.ts#L10-L25).";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe("See [server.ts](/workspace/src/server.ts:10).");
  });

  it("normalizes vscode://file URIs", () => {
    const input = "Open [main.rs](vscode://file/Users/dev/main.rs:15:2).";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe("Open [main.rs](/Users/dev/main.rs:15).");
  });

  it("wraps paths with spaces in angle brackets <...>", () => {
    const input = "See [doc.md](/Users/dev/My Documents/doc.md:5).";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe("See [doc.md](</Users/dev/My Documents/doc.md:5>).");
  });

  it("strips backticks inside link labels", () => {
    const input = "Refer to [`config.json`](file:///workspace/config.json).";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe("Refer to [config.json](/workspace/config.json).");
  });

  it("strips backticks wrapping the whole markdown link", () => {
    const input = "Check `[index.ts](file:///workspace/index.ts:20)`.";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe("Check [index.ts](/workspace/index.ts:20).");
  });

  it("does not touch remote HTTP/HTTPS links", () => {
    const input =
      "Visit [Google](https://google.com#L10-L20) or [API](http://api.example.com/test).";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe(input);
  });

  it("preserves links and file:// URIs inside fenced code blocks", () => {
    const input = [
      "Here is bash:",
      "```bash",
      "curl file:///workspace/test.txt#L10-L20",
      "```",
    ].join("\n");
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe(input);
  });

  it("resolves relative paths when cwd is provided", () => {
    const input = "Inspect [utils.ts](./src/utils.ts:12).";
    const output = normalizeCodexMarkdown(input, { cwd: "/workspace" });
    expect(output).toBe("Inspect [utils.ts](/workspace/src/utils.ts:12).");
  });

  it("handles Windows drive file URIs", () => {
    const input = "See [win.txt](file:///C:/Users/dev/win.txt#L5).";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe("See [win.txt](C:/Users/dev/win.txt:5).");
  });

  it("handles multiple links on a single line", () => {
    const input =
      "Compare [a.ts](file:///workspace/a.ts:10) with [b.ts](file:///workspace/b.ts#L20-L30).";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe("Compare [a.ts](/workspace/a.ts:10) with [b.ts](/workspace/b.ts:20).");
  });

  it("handles links with titles", () => {
    const input = 'Open [doc.md](file:///workspace/doc.md:1 "Readme File").';
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe('Open [doc.md](/workspace/doc.md:1 "Readme File").');
  });

  it("ignores non-link brackets and array access", () => {
    const input = "Value at arr[0] is [pending] status.";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe(input);
  });

  it("enforces CommonMark blank line after headers", () => {
    const input = "# Header\nSome paragraph text.";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe("# Header\n\nSome paragraph text.");
  });

  it("enforces CommonMark blank line before lists", () => {
    const input = "Here are items:\n- Item 1\n- Item 2";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe("Here are items:\n\n- Item 1\n- Item 2");
  });

  it("does not insert extra blank lines if blank lines already exist", () => {
    const input = "# Header\n\nSome text.\n\n- Item 1\n- Item 2";
    const output = normalizeCodexMarkdown(input);
    expect(output).toBe(input);
  });
});

describe("StreamingMarkdownNormalizer", () => {
  it("streams plain text delta by delta", () => {
    const normalizer = new StreamingMarkdownNormalizer();
    const d1 = normalizer.append("Hello ");
    const d2 = normalizer.append("world!");
    const d3 = normalizer.flush();

    expect(d1).toBe("Hello ");
    expect(d2).toBe("world!");
    expect(d3).toBe("");
    expect(normalizer.currentText).toBe("Hello world!");
  });

  it("holds incomplete markdown link until closing paren arrives", () => {
    const normalizer = new StreamingMarkdownNormalizer({ cwd: "/workspace" });

    // Chunk 1 ends in the middle of destination
    const d1 = normalizer.append("Check [app.py](file:///workspace/src/");
    expect(d1).toBe("Check ");

    // Chunk 2 arrives with rest of link
    const d2 = normalizer.append("app.py#L10) for details.");
    expect(d2).toBe("[app.py](/workspace/src/app.py:10) for details.");

    const d3 = normalizer.flush();
    expect(d3).toBe("");
    expect(normalizer.currentText).toBe("Check [app.py](/workspace/src/app.py:10) for details.");
  });

  it("flushes remaining text when stream finishes with incomplete syntax", () => {
    const normalizer = new StreamingMarkdownNormalizer();
    const d1 = normalizer.append("Unclosed [label");
    expect(d1).toBe("Unclosed ");

    const d2 = normalizer.flush();
    expect(d2).toBe("[label");
    expect(normalizer.currentText).toBe("Unclosed [label");
  });
});
