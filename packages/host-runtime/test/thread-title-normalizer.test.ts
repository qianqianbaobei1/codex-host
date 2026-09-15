import { describe, expect, it } from "vitest";

import {
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
});
