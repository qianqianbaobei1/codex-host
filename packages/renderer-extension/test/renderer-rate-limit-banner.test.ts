import { describe, expect, it } from "vitest";
import {
  FALLBACK_COPY_BAR_CLASS,
  RATE_LIMIT_BANNER_STYLE_ATTRIBUTE,
  SUPPRESSED_ERROR_ATTRIBUTE,
  SUPPRESSED_WRAPPER_ATTRIBUTE,
  ensureRateLimitBannerSuppressionStyle,
  isSuppressedTurnErrorText,
  reconcileComposerRateLimitBanner,
  reconcileTurnErrorBannersAndCopy,
} from "../src/renderer-composer-dom.js";

class MockElement {
  style: Record<string, any> = { display: "" };
  className = "";
  type = "";
  innerHTML = "";
  private _textContent = "";
  get textContent(): string {
    if (this._textContent) return this._textContent;
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join("");
    }
    return "";
  }
  set textContent(v: string) {
    this._textContent = v;
  }
  attributes: Record<string, string> = {};
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  ownerDocument: any = null;

  get classList() {
    return {
      contains: (c: string) => this.className.split(/\s+/).includes(c),
    };
  }

  constructor(public tagName: string) {
    this.style.setProperty = (k: string, v: string) => {
      this.style[k] = v;
    };
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  appendChild(child: MockElement) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  append(...children: MockElement[]) {
    for (const c of children) {
      this.appendChild(c);
    }
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const selectors = selector.split(",").map((s) => s.trim());
    const matchOne = (node: MockElement, sel: string): boolean => {
      if (sel === "aside" && node.tagName.toLowerCase() === "aside") return true;
      if (sel === "button" && node.tagName.toLowerCase() === "button") return true;
      if (sel === "div" && node.tagName.toLowerCase() === "div") return true;
      if (sel.includes("empty:hidden") && node.className.includes("empty:hidden")) return true;
      if (sel.includes("outline-none") && node.className.includes("outline-none")) return true;
      if (sel.includes("rounded-2xl") && node.className.includes("rounded-2xl")) return true;
      if (sel.includes("rounded-xl") && node.className.includes("rounded-xl")) return true;
      if (sel.includes("border") && node.className.includes("border")) return true;
      if (sel.includes('[role="alert"]') && node.getAttribute("role") === "alert") return true;
      if (sel.includes("turn-action-controls") && node.className.includes("turn-action-controls")) return true;
      if (sel.includes(FALLBACK_COPY_BAR_CLASS) && node.className.includes(FALLBACK_COPY_BAR_CLASS)) return true;
      if (sel.includes("assistant-message") && node.getAttribute("data-markdown-text-style") === "assistant-message") return true;
      if (
        (sel.includes('button[aria-label="复制消息"]') || sel.includes('button[aria-label="复制"]')) &&
        node.tagName.toLowerCase() === "button" &&
        (node.getAttribute("aria-label") === "复制消息" || node.getAttribute("aria-label") === "复制")
      ) {
        return true;
      }
      return false;
    };
    const check = (node: MockElement) => {
      if (selectors.some((sel) => matchOne(node, sel))) {
        results.push(node);
      }
      for (const child of node.children) {
        check(child);
      }
    };
    for (const child of this.children) {
      check(child);
    }
    return results;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): MockElement | null {
    let curr: MockElement | null = this.parentElement;
    while (curr) {
      if (
        (selector === "div.empty\\:hidden" || selector === "div.empty:hidden") &&
        curr.tagName.toLowerCase() === "div" &&
        curr.className.includes("empty:hidden")
      ) {
        return curr;
      }
      if (
        selector === "div.outline-none" &&
        curr.tagName.toLowerCase() === "div" &&
        curr.className.includes("outline-none")
      ) {
        return curr;
      }
      if (
        selector === "[data-turn-key]" &&
        curr.getAttribute("data-turn-key") !== null
      ) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }
}

function createMockDocument(): any {
  const head = new MockElement("head");
  const doc = {
    head,
    createElement: (tag: string) => {
      const el = new MockElement(tag);
      el.ownerDocument = doc;
      return el;
    },
    querySelector: (selector: string) => {
      if (selector === `style[${RATE_LIMIT_BANNER_STYLE_ATTRIBUTE}]`) {
        return (
          head.children.find(
            (c: MockElement) =>
              c.tagName.toLowerCase() === "style" &&
              c.getAttribute(RATE_LIMIT_BANNER_STYLE_ATTRIBUTE) === "true",
          ) ?? null
        );
      }
      return null;
    },
  };
  head.ownerDocument = doc;
  return doc;
}

describe("ensureRateLimitBannerSuppressionStyle", () => {
  it("injects suppression stylesheet into head once", () => {
    const doc = createMockDocument();

    ensureRateLimitBannerSuppressionStyle(doc as any);
    expect(doc.head.children.length).toBe(1);
    expect(doc.head.children[0].tagName).toBe("style");
    expect(doc.head.children[0].getAttribute(RATE_LIMIT_BANNER_STYLE_ATTRIBUTE)).toBe("true");

    // Calling again does not duplicate
    ensureRateLimitBannerSuppressionStyle(doc as any);
    expect(doc.head.children.length).toBe(1);
  });
});

describe("reconcileComposerRateLimitBanner", () => {
  function createComposerWithBanner(): {
    composer: MockElement;
    aside: MockElement;
    wrapper: MockElement;
  } {
    const doc = createMockDocument();
    const composer = doc.createElement("div");
    composer.setAttribute("data-codex-composer-root", "");

    const wrapper = doc.createElement("div");
    wrapper.className = "empty:hidden";

    const aside = doc.createElement("aside");
    aside.textContent = "Codex 和工作使用额度已用完。你的速率限制将于 9月19日 17:51 重置。";

    wrapper.appendChild(aside);
    composer.appendChild(wrapper);

    return { composer, aside, wrapper };
  }

  it("unconditionally hides the rate limit banner and parent container", () => {
    const { composer, aside, wrapper } = createComposerWithBanner();

    reconcileComposerRateLimitBanner(composer as any, false);

    expect(aside.style.display).toBe("none");
    expect(wrapper.style.display).toBe("none");
  });

  it("also hides when hideBanner is true", () => {
    const { composer, aside, wrapper } = createComposerWithBanner();

    reconcileComposerRateLimitBanner(composer as any, true);

    expect(aside.style.display).toBe("none");
    expect(wrapper.style.display).toBe("none");
  });
});

describe("isSuppressedTurnErrorText", () => {
  it("matches FAILED_PRECONDITION and user location unsupported errors", () => {
    expect(
      isSuppressedTurnErrorText("FAILED_PRECONDITION (code 400): User location is not supported for the API use."),
    ).toBe(true);
    expect(isSuppressedTurnErrorText("User location is not supported")).toBe(true);
    expect(isSuppressedTurnErrorText("location is not supported")).toBe(true);
    expect(isSuppressedTurnErrorText("API error (attempt 1)")).toBe(true);
    expect(isSuppressedTurnErrorText("Service Unavailable")).toBe(true);
  });

  it("does not match normal assistant text", () => {
    expect(isSuppressedTurnErrorText("大哥，你好！这是业务方案。")).toBe(false);
    expect(isSuppressedTurnErrorText("")).toBe(false);
  });
});

describe("reconcileTurnErrorBannersAndCopy", () => {
  it("suppresses FAILED_PRECONDITION aside and its outline-none wrapper", () => {
    const doc = createMockDocument();
    const root = doc.createElement("div");
    const turn = doc.createElement("div");
    turn.setAttribute("data-turn-key", "turn-1");

    const outlineWrapper = doc.createElement("div");
    outlineWrapper.className = "outline-none";

    const aside = doc.createElement("aside");
    aside.textContent = "FAILED_PRECONDITION (code 400): User location is not supported for the API use.";

    outlineWrapper.appendChild(aside);
    turn.appendChild(outlineWrapper);
    root.appendChild(turn);

    reconcileTurnErrorBannersAndCopy(root as any);

    expect(aside.getAttribute(SUPPRESSED_ERROR_ATTRIBUTE)).toBe("true");
    expect(aside.style.display).toBe("none");
    expect(outlineWrapper.getAttribute(SUPPRESSED_WRAPPER_ATTRIBUTE)).toBe("true");
    expect(outlineWrapper.style.display).toBe("none");
  });

  it("suppresses div.rounded-2xl error card without hiding assistant message body", () => {
    const doc = createMockDocument();
    const root = doc.createElement("div");
    const turn = doc.createElement("div");
    turn.setAttribute("data-turn-key", "turn-1");

    const msg = doc.createElement("div");
    msg.setAttribute("data-markdown-text-style", "assistant-message");
    msg.textContent = "三、具体研发与落地三步走节奏";
    turn.appendChild(msg);

    const errorCard = doc.createElement("div");
    errorCard.className = "rounded-2xl border border-token-border-danger p-4";
    const errorText = doc.createElement("span");
    errorText.textContent = "FAILED_PRECONDITION (code 400): User location is not supported for the API use.";
    errorCard.appendChild(errorText);
    turn.appendChild(errorCard);

    root.appendChild(turn);

    reconcileTurnErrorBannersAndCopy(root as any);

    expect(errorCard.getAttribute(SUPPRESSED_WRAPPER_ATTRIBUTE)).toBe("true");
    expect(errorCard.style.display).toBe("none");
    expect(msg.style.display).not.toBe("none");
  });

  it("injects fallback copy button when native copy button is absent", () => {
    const doc = createMockDocument();
    const root = doc.createElement("div");
    const turn = doc.createElement("div");
    turn.setAttribute("data-turn-key", "turn-1");

    const msg = doc.createElement("div");
    msg.setAttribute("data-markdown-text-style", "assistant-message");
    msg.textContent = "大哥，这是完整回复。";

    turn.appendChild(msg);
    root.appendChild(turn);

    reconcileTurnErrorBannersAndCopy(root as any);

    const fallbackBar = turn.querySelector(`.${FALLBACK_COPY_BAR_CLASS}`);
    expect(fallbackBar).not.toBeNull();
    const btn = fallbackBar?.querySelector("button");
    expect(btn?.getAttribute("aria-label")).toBe("复制");
  });

  it("does not inject duplicate fallback copy button when native copy button exists", () => {
    const doc = createMockDocument();
    const root = doc.createElement("div");
    const turn = doc.createElement("div");
    turn.setAttribute("data-turn-key", "turn-1");

    const msg = doc.createElement("div");
    msg.setAttribute("data-markdown-text-style", "assistant-message");
    msg.textContent = "大哥，这是完整回复。";

    const nativeControls = doc.createElement("div");
    nativeControls.className = "turn-action-controls";
    const nativeCopyBtn = doc.createElement("button");
    nativeCopyBtn.setAttribute("aria-label", "复制");
    nativeControls.appendChild(nativeCopyBtn);

    turn.appendChild(msg);
    turn.appendChild(nativeControls);
    root.appendChild(turn);

    reconcileTurnErrorBannersAndCopy(root as any);

    const fallbackBar = turn.querySelector(`.${FALLBACK_COPY_BAR_CLASS}`);
    expect(fallbackBar).toBeNull();
  });
});
