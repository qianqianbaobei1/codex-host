import { describe, expect, it } from "vitest";

import { ensureRateLimitBannerSuppressionStyle } from "../src/renderer-composer-dom.js";

/**
 * Regression: the suppression style installer runs from the renderer scan hot path.
 * Writing `style.textContent` produces a childList mutation inside
 * `document.documentElement`, which the binding probe observes with
 * `{ childList: true, characterData: true, subtree: true }`. The observer then calls
 * `scheduleScan()`, which defers `scan()` through `queueMicrotask` — evaluated outside
 * the observer callback, so the spec's transient-observer suppression does not apply.
 * Rewriting the identical CSS on every pass therefore spins an endless microtask chain:
 * the ChatGPT renderer never paints (white splash) and sits at 100% CPU.
 *
 * The installer must be idempotent: one write per document, then no further mutations.
 */
function createDocumentStub(): { document: Document; writes: string[] } {
  const writes: string[] = [];
  let style: Record<string, unknown> | null = null;
  const createStyleElement = (): Record<string, unknown> => {
    let text = "";
    const element: Record<string, unknown> = { setAttribute: () => undefined };
    Object.defineProperty(element, "textContent", {
      get: () => text,
      set: (value: string) => {
        text = value;
        writes.push(value);
      },
    });
    return element;
  };
  const documentStub = {
    createElement: () => {
      style = createStyleElement();
      return style;
    },
    querySelector: () => style,
    head: { append: () => undefined },
    documentElement: {},
  };
  return { document: documentStub as unknown as Document, writes };
}

describe("ensureRateLimitBannerSuppressionStyle", () => {
  it("writes the suppression style only once per document", () => {
    const { document, writes } = createDocumentStub();

    ensureRateLimitBannerSuppressionStyle(document);
    ensureRateLimitBannerSuppressionStyle(document);
    ensureRateLimitBannerSuppressionStyle(document);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("data-codexhost-suppressed-error");
  });

  it("still installs the style on a document that has none", () => {
    const { document, writes } = createDocumentStub();

    ensureRateLimitBannerSuppressionStyle(document);

    expect(writes).toHaveLength(1);
  });

  it("tolerates a missing document", () => {
    expect(() =>
      ensureRateLimitBannerSuppressionStyle(undefined as unknown as Document),
    ).not.toThrow();
  });
});
