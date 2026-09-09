"use strict";

import { CHAT_MIGRATION_TAG_MODE } from "../core.js";

// =====================================================================================
// === 聊天记录迁移 · 解析工具 ===
// 纯文本处理，不依赖酒馆 context，供 generator.js / ui.js 复用。
// =====================================================================================

// 跟 modules/summary/status-table.js 里 parseFloorSummaryFields 用的同一个摘要块正则保持一致，
// 只取整段（不解析内部字段），保证导出的原文跟解析端的匹配规则不会脱节。
const SUMMARY_DETAILS_RE =
  /<details>\s*<summary>\s*摘要\s*<\/summary>[\s\S]*?<\/details>/;

// === Helper: 从单层 mes 原文里切出摘要块，返回 {summaryBlock, rest}；没有摘要块时 summaryBlock 为空 ===
export function extractSummaryBlock(mesText) {
  const text = mesText || "";
  const match = text.match(SUMMARY_DETAILS_RE);
  if (!match) return { summaryBlock: "", rest: text };
  const summaryBlock = match[0];
  const rest = text.slice(0, match.index) + text.slice(match.index + summaryBlock.length);
  return { summaryBlock, rest };
}

// === Helper: 逗号分隔的标签名输入 -> 去空白、去空项数组 ===
export function parseTagList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// === Helper: 把标签名转成能安全塞进正则里的转义形式 ===
export function escapeForRegex(tagName) {
  return tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// === Helper: 从文本里按标签名找出所有 <tag ...>...</tag> 整段（含标签本身），忽略标签上的属性 ===
function extractTagBlocks(text, tagName) {
  const escaped = escapeForRegex(tagName);
  const re = new RegExp(`<${escaped}[^>]*>[\\s\\S]*?<\\/${escaped}>`, "g");
  return text.match(re) || [];
}

// === Helper: 剔除命中标签列表的整段（用于 exclude 模式）===
function removeTagBlocks(text, tagNames) {
  let result = text;
  tagNames.forEach((tag) => {
    extractTagBlocks(result, tag).forEach((block) => {
      result = result.replace(block, "");
    });
  });
  return result.trim();
}

// === Helper: 只保留命中标签列表的整段，按标签在原文里出现的先后顺序拼接（用于 whitelist 模式）===
function keepTagBlocks(text, tagNames) {
  if (tagNames.length === 0) return "";
  const escaped = tagNames.map(escapeForRegex);
  const re = new RegExp(`<(${escaped.join("|")})[^>]*>[\\s\\S]*?<\\/\\1>`, "g");
  const blocks = text.match(re) || [];
  return blocks.join("\n\n").trim();
}

// === Function: 按选中模式，从"去掉摘要块之后剩余的原文"里截取正文 ===
export function buildBody(rest, mode, tagNames) {
  if (mode === CHAT_MIGRATION_TAG_MODE.SUMMARY_ONLY) return "";
  if (mode === CHAT_MIGRATION_TAG_MODE.WHITELIST) return keepTagBlocks(rest, tagNames);
  return removeTagBlocks(rest, tagNames); // mode === CHAT_MIGRATION_TAG_MODE.EXCLUDE（默认）
}

// === Helper: 输入框里的楼层号字符串 -> 非负整数，空/非法输入返回 undefined（代表"不限"）===
export function parseFloorRangeInput(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : undefined;
}
