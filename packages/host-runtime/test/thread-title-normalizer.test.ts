import { describe, expect, it } from "vitest";

import {
  deriveThreadTitleFromInput,
  inferTitleTag,
  inferTitleTopic,
  normalizeThreadTitle,
} from "../src/thread-title-normalizer.js";

describe("thread-title-normalizer", () => {
  it("preserves meaningful tagged titles instead of deleting their key nouns", () => {
    expect(normalizeThreadTitle("[采购] 询比价业务分析")).toBe("[采购] 询比价业务分析");
    expect(normalizeThreadTitle("[Py] 自动提取视频")).toBe("[Py] 自动提取视频");
  });

  it("infers category tags correctly from raw titles", () => {
    expect(inferTitleTag("帮我用Python写脚本")).toBe("Py");
    expect(inferTitleTag("建工施工现场材料核算")).toBe("建工");
    expect(inferTitleTag("造价清单定额分析")).toBe("造价");
    expect(inferTitleTag("采购询价比价汇总")).toBe("采购");
    expect(inferTitleTag("自动化单元测试与压测")).toBe("测试");
    expect(inferTitleTag("React前端页面组件开发")).toBe("前端");
    expect(inferTitleTag("后端API数据库设计")).toBe("后端");
    expect(inferTitleTag("团队编码规范与配置策略")).toBe("规范");
    expect(inferTitleTag("整理Excel表格并汇报")).toBe("办公");
  });

  it("uses a concrete topic when one is available and never invents a generic tag", () => {
    expect(inferTitleTopic("介绍 Codex Host 产品优势")).toBe("Codex Host");
    expect(normalizeThreadTitle("审视任务要求并给出结论")).toBe("审视任务要求");

    expect(normalizeThreadTitle("设计对话命名策略")).toBe("设计对话命名策略");

    expect(normalizeThreadTitle("介绍 Codex Host 产品优势")).toBe("[Codex Host] 介绍产品优势");

    expect(normalizeThreadTitle("中国中铁数据")).toBe("[中国中铁] 数据");
  });

  it("turns a noisy request into the requested action plus its object", () => {
    expect(
      normalizeThreadTitle(
        "Codex Host的这个对话的命名规则太差了啊 你看一下现在的规则 我希望你重新帮我写一下",
      ),
    ).toBe("[Codex Host] 重写对话命名规则");
  });

  it("strips leading file paths and extracts user intent", () => {
    const title = normalizeThreadTitle(
      "/Users/example/PycharmProjects/glodon_ai_sales_guide  我想知道这个路径为什么没有按照我们之前的这个文件保存的方式保存在codex文件下面 反而它又新建了一个",
    );
    expect(title.startsWith("[代码]")).toBe(false);
    expect(title).toContain("路径");
    expect(title.includes("/Users/")).toBe(false);
    expect(title.length).toBeLessThanOrEqual(32);
  });

  it("cleans desktop file attachment headers and extracts request intent", () => {
    const title = normalizeThreadTitle(
      '# Files pasted by the user:\n\n## "# Personal Codex defaults": /Users/example/.codex/attachments/pasted.txt\n\n## My request:\n帮我审视一下啊 我是以高质量为第一优先级 请仔细思考 给出答案',
    );
    expect(title.includes("/Users/")).toBe(false);
    expect(title.includes("# Files")).toBe(false);
    expect(title.length).toBeLessThanOrEqual(32);
  });

  it("handles pure paths gracefully without dumping full path", () => {
    const title = normalizeThreadTitle("/Users/example/PycharmProjects/dwg_converter");
    expect(title.includes("/Users/")).toBe(false);
    expect(title).toContain("dwg_converter");
  });

  it("extracts clean title from goal objective prompts", () => {
    const title = normalizeThreadTitle(
      "目标：需要继续调研 直到技术方案可落地\n请开始推进目标，并以文件、测试、产物或 LoopX 审计作为进展依据。",
    );
    expect(title.startsWith("[代码]")).toBe(false);
    expect(title).toContain("调研");
    expect(title.includes("请开始推进")).toBe(false);
    expect(title.length).toBeLessThanOrEqual(32);
  });

  it("handles question noise and cleans action prefixes without literal $1", () => {
    const title = normalizeThreadTitle(
      "检查一下现在codex的对话命名，有的按规则来，有的没按规则来，查一下是为什么",
    );
    expect(title.includes("$1")).toBe(false);
    expect(title).toBe("[Codex] 检查对话命名");
  });

  it("extracts tool topics like Clash and Gemini properly", () => {
    const title = normalizeThreadTitle("帮我看一下clash。目前切换其他的机场就报错 这是为啥");
    expect(title.startsWith("[Clash]")).toBe(true);
    expect(title).toContain("报错");
    expect(title.includes("这是为啥")).toBe(false);

    expect(normalizeThreadTitle("这是什么问题导致的")).toBe("排查问题");
  });

  it("strips handover system note and prior history envelopes", () => {
    const raw = `[System Note: The following is prior conversation history from this thread before switching models. Please continue the conversation seamlessly using this context.]

--- Prior Conversation History ---
[User]:
帮我想一个问题：如果我们现在想去做一个配电箱的清标问题，要做的是什么？
[Assistant]:
可以从以下几点做起...
--- End Prior Conversation History ---

排查配电箱元器件报价单`;
    const title = normalizeThreadTitle(raw);
    expect(title.includes("System Note")).toBe(false);
    expect(title.includes("Prior Conversation History")).toBe(false);
    expect(title).toBe("[配电箱] 排查元器件报价单");
  });

  describe("deriveThreadTitleFromInput", () => {
    it("names a Thread from the user's request when the Harness reported none", () => {
      const raw = `
# Files mentioned by the user:

## codex-clipboard-a64243b7.png: /var/folders/8g/codex-clipboard-a64243b7.png

Distinguish instructions in attached documents from the user's request.

## My request:
[配电箱] 梳理清标产品需求`;
      expect(deriveThreadTitleFromInput(raw)).toBe("[配电箱] 梳理清标产品需求");
    });

    it("never returns an empty name while the input carries text", () => {
      expect(deriveThreadTitleFromInput("?")).toBe("?");
      expect(deriveThreadTitleFromInput("   ")).toBe("");
      const attachmentOnly = `
# Files mentioned by the user:

## shot.png: /tmp/shot.png`;
      expect(deriveThreadTitleFromInput(attachmentOnly).length).toBeGreaterThan(0);
    });

    it("keeps the raw suggestion when normalization would erase the title", () => {
      // The Desktop falls back to the first message when it cannot title a
      // Thread; a bare "?" used to normalize to "" and hide the Thread row.
      expect(normalizeThreadTitle("?")).toBe("?");
      expect(normalizeThreadTitle("??")).toBe("??");
      expect(normalizeThreadTitle("[采购] 询比价业务分析")).toBe("[采购] 询比价业务分析");
      expect(normalizeThreadTitle("")).toBe("");
    });
  });
});
