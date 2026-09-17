/**
 * Keeps Thread titles useful in the Desktop sidebar.
 *
 * The title generator is responsible for understanding the request. This
 * module is deliberately a conservative second pass: it removes transport
 * wrappers and conversational noise, preserves meaningful nouns and verbs,
 * and adds a topic only when the topic is explicit or recognizable.
 *
 * Preferred shape: `[主题] 动作对象`.
 * A generic category such as `[代码]` is never invented as a fallback.
 */

const MAX_TITLE_LENGTH = 32;
const MAX_TOPIC_LENGTH = 16;

const LEGACY_TAG_KEYWORDS: Array<{ tag: string; pattern: RegExp }> = [
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

/**
 * Kept for compatibility with the earlier normalizer API. New formatting does
 * not use these generic labels as a title prefix.
 */
export function inferTitleTag(text: string): string {
  for (const { tag, pattern } of LEGACY_TAG_KEYWORDS) {
    if (pattern.test(text)) return tag;
  }
  return "代码";
}

const RECOGNIZABLE_TOPICS: Array<{ topic: string; pattern: RegExp }> = [
  { topic: "Codex Host", pattern: /\bcodex\s*host\b/i },
  { topic: "Codex", pattern: /\bcodex\b/i },
  { topic: "Claude Code", pattern: /\bclaude\s+code\b/i },
  { topic: "Claude", pattern: /\bclaude\b/i },
  { topic: "ChatGPT", pattern: /\bchatgpt\b/i },
  { topic: "OpenAI", pattern: /\bopenai\b/i },
  { topic: "Gemini", pattern: /\bgemini\b/i },
  { topic: "DeepSeek", pattern: /\bdeepseek\b/i },
  { topic: "Grok", pattern: /\bgrok\b/i },
  { topic: "Clash", pattern: /\bclash\b/i },
  { topic: "Python", pattern: /\bpython\b/i },
  { topic: "React", pattern: /\breact\b/i },
  { topic: "Electron", pattern: /\belectron\b/i },
  { topic: "DWG", pattern: /\bdwg\b/i },
  { topic: "Excel", pattern: /\bexcel\b/i },
  { topic: "Word", pattern: /\bword\b/i },
  { topic: "PDF", pattern: /\bpdf\b/i },
  { topic: "API", pattern: /\bapi\b/i },
  { topic: "MCP", pattern: /\bmcp\b/i },
  { topic: "Git", pattern: /\bgit\b/i },
  { topic: "Docker", pattern: /\bdocker\b/i },
  { topic: "Axure", pattern: /\baxure\b/i },
  { topic: "LoopX", pattern: /\bloopx\b/i },
  { topic: "配电箱", pattern: /配电箱/ },
  { topic: "中国中铁", pattern: /中国中铁/ },
  { topic: "平方网", pattern: /平方网/ },
  { topic: "采购", pattern: /采购/ },
  { topic: "造价", pattern: /造价/ },
  { topic: "建工", pattern: /建工/ },
];

const OBJECT_SUFFIX =
  "规则|策略|方案|报告|脚本|接口|页面|组件|图纸|清单|数据|问题|流程|配置|逻辑|标题|命名|文档|账号|额度|路径|文件|报错|错误|异常|故障|需求";

const ACTION_WORDS = [
  "重新设计",
  "重构",
  "重写",
  "改写",
  "修复",
  "排查",
  "实现",
  "编写",
  "生成",
  "整理",
  "调研",
  "核验",
  "验证",
  "审计",
  "总结",
  "对比",
  "评估",
  "解释",
  "部署",
  "配置",
  "迁移",
  "接入",
  "开发",
  "优化",
  "替换",
  "制作",
  "分析",
  "审视",
  "梳理",
  "检查",
  "解决",
  "设计",
  "写",
  "做",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactMixedSpacing(text: string): string {
  return text
    .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, "$1$2")
    .replace(/([\u4e00-\u9fa5])\s+([a-zA-Z0-9])/g, "$1$2")
    .replace(/([a-zA-Z0-9])\s+([\u4e00-\u9fa5])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function clipText(text: string, limit: number): string {
  const characters = Array.from(text.trim());
  if (characters.length <= limit) return text.trim();

  let clipped = characters.slice(0, limit).join("").trim();
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace >= Math.floor(limit * 0.6)) clipped = clipped.slice(0, lastSpace).trim();
  return clipped.replace(/[，。！？、：；,.!?:;—\-_/\\\s]+$/g, "");
}

function cleanTopic(rawTopic: string): string {
  return compactMixedSpacing(
    rawTopic
      .replace(/[\[\]【】（）()"“”'‘’`，。！？、：；,.!?:;|｜—]/g, " ")
      .replace(/^(?:这个|这份|这篇|当前|关于)\s*/g, "")
      .trim(),
  );
}

function removeTopic(text: string, topic: string): string {
  if (!topic) return text;
  const topicPattern = new RegExp(escapeRegExp(topic).replace(/\\ /g, "\\s+"), "ig");
  return text
    .replace(topicPattern, " ")
    .replace(/^\s*(?:的|：|:)\s*/, "")
    .replace(/\s+的(?=[\u4e00-\u9fa5])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeTitleNoise(rawText: string): string {
  let text = rawText
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = text
    .replace(/^\s*["“‘'`]+|["”’'`]+\s*$/g, "")
    .replace(/(?:我希望你|希望你|我希望|请你|帮我|请帮我|麻烦你|我需要你|需要你|请问)/g, " ")
    .replace(/(?:请开始推进(?:目标)?|请仔细思考|仔细思考|以高质量为第一优先级)/g, " ")
    .replace(/(?:并给出|给出)(?:结论|答案)/g, " ")
    .replace(/(?:太差了|太糟了|很差|不好|不合理|不行|有问题|存在问题|太乱了)[啊呀吧呢哦]?/g, " ")
    .replace(/(?:这个|这次|本次)对话的/g, "对话")
    .replace(/(?:这份|这篇)内容的/g, " ")
    .replace(/你?看(?:一下|下)?(?:当前|现在)?(?:的)?(?:规则|方案|内容)?/g, " ")
    .replace(/(?:重新(?:帮我|请你|请)?写)(?:一下)?/g, "重写")
    .replace(/重新\s*写(?:一下)?/g, "重写")
    .replace(/(重写|改写|修复|排查|实现|设计|分析|审视|检查)(?:一下|下)/g, "$1")
    .replace(/(?:一下|下)[啊呀吧呢哦]+/g, "")
    .replace(/(?:谢谢|感谢|辛苦了)[啊呀吧呢哦]?$/g, "")
    .replace(/(?:[，,、\s]+)?(?:请)?(?:帮我)?(?:查|看|排查|想知道|搞清楚)?(?:一下|下)?(?:是)?(?:为什么|为啥|怎么回事|是什么原因)[？?啊呀吧呢哦]*$/g, "")
    .replace(/(?:这是)?(?:什么原因|为什么|为啥)(?:导致的|引起的)?[？?啊呀吧呢哦]*$/g, "")
    .replace(/(?:这是为啥|这是为什么|怎么回事)[？?啊呀吧呢哦]*$/g, "")
    .replace(/\[(?:图片|图片附件|附件)\]/gi, " ")
    .replace(/(?:我想请教一个问题|帮我想一个问题)[：:，,\s]*/g, " ")
    .replace(/^(?:这是|是)?(?:什么问题|什么原因)(?:导致的)?[？?啊呀吧呢哦]*$/, "排查问题原因");

  // Remove leading request grammar but leave the requested action intact.
  for (let i = 0; i < 3; i += 1) {
    text = text.replace(
      /^\s*(?:如何|怎样|怎么|能否|是否|请|帮我|我想(?:知道|了解)?|需要|继续|针对|关于|对|用|使用|看一下|看下|目前)\s*/,
      "",
    );
  }

  return compactMixedSpacing(text);
}

function extractObject(text: string): string | null {
  const matches = Array.from(
    text.matchAll(new RegExp(`(?:[\\u4e00-\\u9fa5A-Za-z0-9_-]{1,12})?(?:${OBJECT_SUFFIX})`, "g")),
  )
    .map((match) => match[0]?.trim() ?? "")
    .filter(Boolean);
  return matches.at(-1) ?? null;
}

function normalizeSingleClause(clause: string): string {
  let body = compactMixedSpacing(
    clause
      .replace(/[【】（）()]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

  const object = extractObject(body);
  const trailingAction = ACTION_WORDS.find((action) =>
    new RegExp(`${escapeRegExp(action)}$`, "i").test(body),
  );
  if (object && trailingAction) {
    body = `${trailingAction}${object}`;
  } else {
    const leadingAction = ACTION_WORDS.find((action) =>
      new RegExp(`^${escapeRegExp(action)}`, "i").test(body),
    );
    const firstObject = Array.from(
      body.matchAll(new RegExp(`(?:[\\u4e00-\\u9fa5A-Za-z0-9_-]{1,12})?(?:${OBJECT_SUFFIX})`, "g")),
    )
      .map((match) => match[0]?.trim() ?? "")
      .filter(Boolean)[0];
    if (leadingAction && firstObject) {
      let coreObject = firstObject;
      if (coreObject.startsWith(leadingAction)) {
        coreObject = coreObject.slice(leadingAction.length);
      }
      coreObject = coreObject.replace(/^(?:当前|现在|这个|本次|这次|的|\s)+/, "");
      if (coreObject) {
        body = `${leadingAction}${coreObject}`;
      }
    }
  }

  body = body
    .replace(/\s+(?:并|然后|同时)?\s*(?:请)?(?:告诉我|说明一下|给出答案|给出结论).*$/g, "")
    .replace(/[并与和对在从向给与以及]+$/g, "")
    .trim();

  return compactMixedSpacing(body);
}

function normalizeActionBody(rawBody: string): string {
  const clauses = rawBody
    .split(/[，。！？、：；,.!?:;—\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);

  if (clauses.length > 1 && clauses[0]) {
    const firstNormalized = normalizeSingleClause(clauses[0]);
    const hasAction = ACTION_WORDS.some((action) => firstNormalized.includes(action));
    const hasObject = new RegExp(`(?:${OBJECT_SUFFIX})`).test(firstNormalized);
    if (hasAction && hasObject) {
      return firstNormalized;
    }
  }

  return normalizeSingleClause(rawBody.replace(/[，。！？、：；,.!?:;—]/g, " "));
}

/**
 * Finds a concrete product, project, file format, or business subject. This
 * is intentionally not a generic category classifier: a topic is only added
 * when it helps a person find the Thread again.
 */
export function inferTitleTopic(text: string): string | null {
  for (const { topic, pattern } of RECOGNIZABLE_TOPICS) {
    if (pattern.test(text)) return topic;
  }

  const explicitTopic = text.match(/^\s*(.{2,20}?)\s*[：:|｜]\s*(?:.+)$/);
  if (explicitTopic?.[1]) {
    const topic = cleanTopic(explicitTopic[1]);
    if (topic && !/^(?:请|帮我|我想|如何|怎样|怎么|关于|针对|当前|这个)$/i.test(topic)) {
      return topic;
    }
  }

  const actionIndex = ACTION_WORDS.map((action) => text.indexOf(action))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];
  if (actionIndex !== undefined) {
    const prefix = cleanTopic(text.slice(0, actionIndex));
    if (
      prefix.length >= 2 &&
      !/^(?:请|帮我|我想|需要|继续|再次|重新|如何|怎样|怎么|用|使用)$/i.test(prefix)
    ) {
      return clipText(prefix, MAX_TOPIC_LENGTH);
    }
  }

  return null;
}

export function extractMeaningfulTitleText(rawTitle: string): string {
  if (!rawTitle || typeof rawTitle !== "string") return "";
  let text = rawTitle.trim();

  // These wrappers are injected by Desktop or the goal loop, not user intent.
  text = text.replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/gi, "");
  text = text.replace(/<USER_REQUEST>|<\/USER_REQUEST>/gi, "");
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "");
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "");
  text = text.replace(/\[System Note:[\s\S]*?--- End Prior Conversation History ---\s*/gi, "");
  text = text.replace(
    /--- Prior Conversation History ---[\s\S]*?--- End Prior Conversation History ---\s*/gi,
    "",
  );

  text = text.replace(
    /# Files (?:pasted|mentioned) by the user:[\s\S]*?(?:## My request:|(?=\n[^\n#]))/gi,
    "",
  );
  text = text.replace(/## My request:\s*/gi, "");
  text = text.replace(/^#+\s+[^\n]*$/gm, "");

  text = text.replace(/%%GOAL_CONTINUE%%[\s\S]*?请继续推进尚未完成的子任务[。\s]*/gi, "");
  text = text.replace(/^目标[：:]\s*/, "");
  text = text.replace(/请开始推进目标[\s\S]*$/gi, "");

  text = text.replace(/https?:\/\/\S+|codex:\/\/\S+/gi, " ");
  text = text.replace(
    /(?:^|\s)(?:(?:\/[a-zA-Z0-9._-]+)+|[a-zA-Z]:\\[a-zA-Z0-9._\-\\]+|~(?:\/[a-zA-Z0-9._-]+)+)/g,
    " ",
  );
  text = text.replace(/^(?:[0-9]+[、.\s]+|【[0-9]+】\s*)/, "");

  if (text.trim().length === 0) {
    const pathMatch = rawTitle.match(
      /(?:(?:\/[a-zA-Z0-9._-]+)+|[a-zA-Z]:\\[a-zA-Z0-9._\-\\]+|~(?:\/[a-zA-Z0-9._-]+)+)/,
    );
    if (pathMatch) {
      const parts = pathMatch[0].split(/[/\\]+/).filter(Boolean);
      text = parts.at(-1) ?? "";
    }
  }

  return text.trim();
}

function formatTitle(topic: string | null, body: string): string {
  const normalizedTopic = topic ? clipText(cleanTopic(topic), MAX_TOPIC_LENGTH) : "";
  const cleanedBody = normalizedTopic ? removeTopic(body, normalizedTopic) : body;
  const normalizedBody = normalizeActionBody(cleanedBody);
  if (!normalizedBody) return normalizedTopic;
  if (!normalizedTopic) return clipText(normalizedBody, MAX_TITLE_LENGTH);

  const prefix = `[${normalizedTopic}] `;
  return `${prefix}${clipText(normalizedBody, MAX_TITLE_LENGTH - Array.from(prefix).length)}`;
}

export function normalizeThreadTitle(rawTitle: string): string {
  if (!rawTitle || typeof rawTitle !== "string") return rawTitle;

  const extracted = extractMeaningfulTitleText(rawTitle);
  if (!extracted) return rawTitle.trim();

  const taggedMatch = extracted.match(/^\[([^\]]+)\]\s*(.*)$/s);
  if (taggedMatch?.[1] !== undefined && taggedMatch[2] !== undefined) {
    return formatTitle(cleanTopic(taggedMatch[1]), removeTitleNoise(taggedMatch[2]));
  }

  const delimiterMatch = extracted.match(/^(.{2,24}?)\s*[：:|｜]\s*(.+)$/s);
  if (delimiterMatch?.[1] && delimiterMatch[2]) {
    return formatTitle(cleanTopic(delimiterMatch[1]), removeTitleNoise(delimiterMatch[2]));
  }

  const cleaned = removeTitleNoise(extracted);
  const topic = inferTitleTopic(cleaned);
  return formatTitle(topic, cleaned);
}
