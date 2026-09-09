/**
 * Normalizes thread titles according to the user standard:
 * - Format: [短标签] 核心词+动作结果
 * - Total length: 8~12 characters (max 14 characters)
 * - No redundant punctuation or conversational filler words
 */

const TAG_KEYWORDS: Array<{ tag: string; pattern: RegExp }> = [
  { tag: "Py", pattern: /python|py\b|pandas|numpy|django|flask|fastapi|pip|conda/i },
  { tag: "采购", pattern: /采购|比价|供应商|询价|招标|对账|发票|物料/ },
  { tag: "造价", pattern: /造价|算量|清单|定额|计价|概算|预算|决算/ },
  { tag: "建工", pattern: /建工|施工|工程|现场|中铁|珠海|建筑|勘察|监理|图纸|dwg/i },
  { tag: "测试", pattern: /测试|摸底|压测|验证|单测|test|eval|benchmark/i },
  { tag: "前端", pattern: /前端|ui|页面|组件|dom|css|react|electron|view|vue|html/i },
  { tag: "后端", pattern: /后端|api|server|db|sql|grpc|接口|数据库|redis/i },
  { tag: "规范", pattern: /规范|策略|命名|规则|配置|流程|标准|agents|路径|保存/i },
  { tag: "办公", pattern: /办公|整理|表格|excel|word|总结|汇报|ppt|pdf/i },
  { tag: "工具", pattern: /工具|插件|skill|mcp|脚本|automation|daemon/i },
];

export function inferTitleTag(text: string): string {
  for (const { tag, pattern } of TAG_KEYWORDS) {
    if (pattern.test(text)) return tag;
  }
  return "代码";
}

export function extractMeaningfulTitleText(rawTitle: string): string {
  if (!rawTitle || typeof rawTitle !== "string") return "";
  let text = rawTitle.trim();

  // 1. Strip instructions header / system prompts / protocol wrappers
  text = text.replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/gi, "");
  text = text.replace(/<USER_REQUEST>|<\/USER_REQUEST>/gi, "");
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "");
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "");
  text = text.replace(/\[System Note:[\s\S]*?--- Prior Conversation History ---/gi, "");
  text = text.replace(/--- Prior Conversation History ---[\s\S]*?--- End Prior Conversation History ---/gi, "");

  // 2. Strip attachment banners inserted by desktop
  text = text.replace(/# Files (?:pasted|mentioned) by the user:[\s\S]*?(?:## My request:|(?=\n[^\n#]))/gi, "");
  text = text.replace(/## My request:\s*/gi, "");

  // 3. Strip markdown headings
  text = text.replace(/^#+\s+[^\n]*$/gm, "");

  // 4. Strip Goal loop continuation and prefix prompts
  text = text.replace(/%%GOAL_CONTINUE%%[\s\S]*?请继续推进尚未完成的子任务[。\s]*/gi, "");
  text = text.replace(/^目标[：:]\s*/, "");
  text = text.replace(/请开始推进目标[\s\S]*$/gi, "");

  // 5. Strip URLs
  text = text.replace(/https?:\/\/\S+|codex:\/\/\S+/gi, " ");

  // 6. Strip file paths like /Users/... or /var/... or C:\... or ~/projects/...
  text = text.replace(/(?:^|\s)(?:(?:\/[a-zA-Z0-9._-]+)+|[a-zA-Z]:\\[a-zA-Z0-9._\-\\]+|~(?:\/[a-zA-Z0-9._-]+)+)/g, " ");

  // 7. Strip leading numbering like "1. ", "1、", "【1】"
  text = text.replace(/^(?:[0-9]+[、.\s]+|【[0-9]+】\s*)/, "");

  // 8. If text is empty because raw input was purely a file/folder path:
  if (text.trim().length === 0) {
    const pathMatch = rawTitle.match(/(?:(?:\/[a-zA-Z0-9._-]+)+|[a-zA-Z]:\\[a-zA-Z0-9._\-\\]+|~(?:\/[a-zA-Z0-9._-]+)+)/);
    if (pathMatch) {
      const parts = pathMatch[0].split(/[/\\]+/).filter(Boolean);
      text = parts[parts.length - 1] || "";
    }
  }

  return text.trim();
}

export function normalizeThreadTitle(rawTitle: string): string {
  if (!rawTitle || typeof rawTitle !== "string") return rawTitle;
  const trimmed = rawTitle.trim();
  if (trimmed.length === 0) return trimmed;

  // 1. If already tagged: [标签] 正文
  const taggedMatch = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (taggedMatch && taggedMatch[1] !== undefined && taggedMatch[2] !== undefined) {
    const tag = taggedMatch[1].trim();
    let body = taggedMatch[2].trim()
      .replace(/[，。！？、：；,.!?:;—\-_"“”'‘’`]/g, "")
      .replace(/(关于|进行|分析|的)/g, "")
      .trim();
    if (body.length > 9) body = body.slice(0, 9);
    return `[${tag}] ${body}`;
  }

  // 2. Clean and extract meaningful content from raw input
  const extracted = extractMeaningfulTitleText(trimmed);
  const subjectText = extracted.length > 0 ? extracted : trimmed;

  // 3. Infer category tag
  const tag = inferTitleTag(subjectText);

  // 4. Clean raw title to extract core terms
  let clean = subjectText
    .replace(/[，。！？、：；,.!?:;—\-_"“”'‘’`\(\)（）[\]【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip leading conversational openings
  clean = clean.replace(
    /^(?:我想知道|我想了解|帮我|请帮我|请问|请|如何|怎样|怎么|关于|针对|进行|对|查一下|看下|审视一下|看一下|介绍下|介绍|用|做一个|写一个|编写|实现|开始|尝试|讨论)\s*/,
    "",
  );

  // Strip demonstrative pronouns and modal particles
  clean = clean.replace(/^(?:这个|这份|这篇|这些|当前)\s*/, "");
  clean = clean.replace(/(?:一下|下)?[啊呀吧呢哦]+/g, "");

  // Strip filler phrases
  clean = clean.replace(/(关于|进行|分析|的的|一个|一下|并给出结论|给出结论|并给出答案|给出答案|按照|我们|之前的|为什么没有|为什么|为何)/g, "");

  // Collapse spaces between Chinese characters, but preserve single spaces adjacent to Latin characters
  clean = clean.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, "$1$2");
  clean = clean.replace(/([\u4e00-\u9fa5])\s+([a-zA-Z0-9])/g, "$1$2");
  clean = clean.replace(/([a-zA-Z0-9])\s+([\u4e00-\u9fa5])/g, "$1$2");
  clean = clean.trim();

  // Smart truncation: keep body within 8 Chinese characters (or equivalent weight)
  let body = "";
  let count = 0;
  for (const ch of clean) {
    const weight = /[\u4e00-\u9fa5]/.test(ch) ? 1 : 0.6;
    if (count + weight > 8) break;
    body += ch;
    count += weight;
  }

  body = body.trim().replace(/[并与和对在从向给与以及]+$/, "").trim();

  if (body.length < 2) {
    body = subjectText.replace(/[，。！？、：；,.!?:;—\-_/\\]/g, "").slice(0, 6);
  }

  return `[${tag}] ${body}`;
}
