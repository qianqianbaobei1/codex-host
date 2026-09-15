import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ATTACHMENT_LABELS: Record<string, string> = {
  image: "图片附件",
  localImage: "图片附件",
  audio: "音频附件",
  localAudio: "音频附件",
  mention: "文件引用",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function attachmentLabel(item: Record<string, unknown>): string {
  const type = typeof item.type === "string" ? item.type : "unknown";
  return ATTACHMENT_LABELS[type] ?? `附件 ${type}`;
}

function candidate(item: Record<string, unknown>, key: "path" | "url" | "name"): string {
  const value = item[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Inline attachments have no file on this machine; hand the Harness one it can
 * open. The name derives from the payload so a Desktop retry addresses the same
 * file instead of minting a new reference.
 */
async function writeInlineAttachment(url: string): Promise<string> {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/su.exec(url);
  if (!match) throw new Error("attachment URL is unreadable");
  const [, mime = "", base64 = "", payload = ""] = match;
  const bytes = base64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  const subtype = mime.split("/")[1]?.replace(/[^a-z0-9]/giu, "") ?? "";
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 32);
  const file = path.join(
    tmpdir(),
    `codexhost-attachment-${digest}${subtype ? `.${subtype}` : ".bin"}`,
  );
  await writeFile(file, bytes);
  return file;
}

async function attachmentReference(item: Record<string, unknown>): Promise<string> {
  const attachmentPath = candidate(item, "path");
  if (attachmentPath) return attachmentPath;
  const url = candidate(item, "url");
  if (url && !url.startsWith("data:")) return url;
  if (url) return writeInlineAttachment(url);
  const name = candidate(item, "name");
  if (name) return name;
  throw new Error(`${String(item.type)} attachment carries no readable reference`);
}

/**
 * External Harnesses speak text only, so an attachment becomes a reference the
 * Harness opens itself. Rejecting non-text input failed the whole Turn - and with
 * it a new Thread's first message - as soon as the composer held a picture.
 */
export async function externalInputText(items: readonly unknown[]): Promise<string> {
  const parts: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === "text") {
      if (typeof item.text === "string") parts.push(item.text);
      continue;
    }
    parts.push(`[${attachmentLabel(item)}] ${await attachmentReference(item)}`);
  }
  return parts.join("\n");
}
