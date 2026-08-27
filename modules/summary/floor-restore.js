"use strict";

import { SMALL_SUMMARY_TITLE_PREFIX, getCtx } from "../core.js";
import { getLorebookEntriesArray } from "../worldinfo.js";
import { parseFloorSummaryFields } from "./status-table.js";

// =====================================================================================
// === 楼层还原 / 小总结进度扫描 ===
// 负责"小总结：起-止"世界书条目的进度扫描，以及缺失摘要模块的楼层区间
// 用AI逐层还原 Time/Location/Overview（不合并、不压缩条数）。
// 跟状态表（Relationships/Inventory/Setups）的解析合并逻辑（见 status-table.js）是两回事——
// 这里只关心"楼层本身的摘要文本"，不涉及状态表的增删改与校验。
// =====================================================================================

// === Helper: 从世界书中已有的"小总结：起-止"条目扫描进度（取最大的"止"楼层号），-1 表示尚未开始 ===
export function extractSmallSummaryRange(comment) {
  if (
    typeof comment !== "string" ||
    !comment.startsWith(SMALL_SUMMARY_TITLE_PREFIX)
  )
    return null;
  const match = comment
    .slice(SMALL_SUMMARY_TITLE_PREFIX.length)
    .match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  return { start: parseInt(match[1], 10), end: parseInt(match[2], 10) };
}


// === Helper: 扫描世界书里所有"小总结：起-止"条目，取全局最大的"止"楼层号，-1 表示世界书里还没有任何小总结。
// 只用于"设定起始楼层"弹窗给默认值做参考，不参与"自动小总结"的进度判断。===
export async function getMaxSummaryEnd(lorebookName) {
  try {
    const entries = await getLorebookEntriesArray(lorebookName);
    let maxEnd = -1;
    entries.forEach((entry) => {
      const range = extractSmallSummaryRange(entry.comment);
      if (range && range.end > maxEnd) maxEnd = range.end;
    });
    return maxEnd;
  } catch (error) {
    console.warn("[剧情助手] 扫描世界书历史总结失败:", error);
    return -1;
  }
}


// === Helper: "自动小总结"统一使用的进度扫描——只统计"起始楼层 ≥ offset"的条目，
// 避免把世界书里不属于本次编号区间的条目（比如换了起始楼层之前的旧条目）误判成当前进度。
// offset 为 0 时等价于扫描全部条目，与未设置起始楼层时的行为一致。
// 返回本地楼层视角下的进度（已减去 offset），-1 表示按当前 offset 还没写入过任何条目。===
export async function getSummaryProgress(lorebookName, offset) {
  try {
    const entries = await getLorebookEntriesArray(lorebookName);
    let maxEnd = -1;
    entries.forEach((entry) => {
      const range = extractSmallSummaryRange(entry.comment);
      if (range && range.start >= offset && range.end > maxEnd)
        maxEnd = range.end;
    });
    return maxEnd < 0 ? -1 : maxEnd - offset;
  } catch (error) {
    console.warn("[剧情助手] 扫描自动小总结进度失败，视为尚未开始:", error);
    return -1;
  }
}


// === Helper: 最后一条消息的楼层号（原生 context.chat 数组下标即楼层号） ===
export function getLastMessageId() {
  const chat = getCtx().chat;
  if (!Array.isArray(chat) || chat.length === 0) return -1;
  return chat.length - 1;
}


// === Helper: 拉取指定楼层范围的原文并拼成文本块（原生 context.chat 本身就包含隐藏楼层，无需额外参数） ===
export async function buildMessagesText(start, end) {
  const chat = getCtx().chat;
  if (!Array.isArray(chat) || chat.length === 0) return "";
  const slice = chat.slice(start, end + 1);
  if (slice.length === 0) return "";
  return slice
    .map(
      (m, idx) =>
        `[第${start + idx}楼] ${m.name || (m.is_user ? "用户" : "AI")}：${m.mes}`,
    )
    .join("\n\n");
}


// === Helper: 从 fromIdx 开始沿 direction（-1 向前找上文，+1 向后找下文）逐层扫描聊天记录，
// 找到第一个能成功解析出摘要模块的 AI 楼层，作为逐层还原时的时间/地点锚点。
// 扫描范围不受当前批次(batchStart/batchEnd)限制，只受聊天记录本身边界限制，纯本地遍历不产生额外AI调用；
// 找不到（比如已经到聊天开头/结尾都没有摘要模块）时返回 null，由调用方决定留空锚点，不报错、不阻断。===
export function findNearestAnchorFloor(chat, fromIdx, direction) {
  if (!Array.isArray(chat)) return null;
  let i = fromIdx;
  while (i >= 0 && i < chat.length) {
    const message = chat[i];
    if (message && !message.is_user) {
      const parsed = parseFloorSummaryFields(message.mes);
      if (parsed) return { idx: i, parsed };
    }
    i += direction;
  }
  return null;
}


// === Helper: 缺失摘要模块的楼层区间，让AI逐层还原 Time/Location/Overview（不合并、不压缩条数），
// 使这部分楼层产出的字段结构跟正常楼层（对话前强调规则写出的摘要模块）完全一致，方便 buildRangeSummaryContent
// 用同一套逻辑合并整个batch（合并时间跨度、取末尾地点、逐层列关键事件）和提取关键词（按"年/月"字面切分）。
// Overview 的写法、字数上限（150字）直接对齐"对话前强调"里 Overview 字段的规则，不单独维护一套压缩规则。
export function buildFloorRestoreInstruction() {
  return `对话原文每层楼开头标注楼层号和说话者（如"[第10楼] AI："或"[第11楼] 用户："）。
现在请你分析归属于AI层的每楼正文原文，逐层提取摘要字段（Time/Location/Overview），不要续写故事，不要输出 <summary> 标签之外的任何文字。
还原规则：
- 目标楼层逐层单独输出，不合并多层、不跳过任何一层、不把一层拆成多组
- Time: 该层故事场景结束时的时刻；精确到年月日+时分
- Location: 该层场景最后所在地点
- Overview: 按时间顺序列出关键事件+实际改变(关系/处境/认知)，平铺直叙不用比喻/形容词，写成一段话不换行；无实质进展留空，不超150字
请严格按照下面的格式输出：所有目标楼层共用同一对 <summary></summary> 标签包裹，标签内每层楼一个区块，区块之间空一行，不要为每一层楼各自输出一对 <summary></summary>。
例如目标楼层是第0、2、4楼时，应该输出（仅此一对标签，包裹全部三层）：
<summary>
[第0楼]
Time: {...}
Location: {...}
Overview: {...}

[第2楼]
Time: {...}
Location: {...}
Overview: {...}

[第4楼]
Time: {...}
Location: {...}
Overview: {...}
</summary>`;
}


// anchors 可选，形如 { prev: {idx, parsed:{time,location,overview}}, next: {idx, parsed:{time,location}} }：
// prev（上文）给完整三项，帮AI判断是否与上文重复、避免时间倒退；
// next（下文）只给 Time，当作"本段时间不能超过这个点"的边界约束，不泄露下文 Location/Overview 以免剧透干扰本段还原。
export function buildFloorRestoreUserContent(
  start,
  end,
  messagesText,
  targetFloorIndices,
  anchors,
) {
  const targetListStr = (targetFloorIndices || []).join("、");
  const { prev, next } = anchors || {};
  let anchorBlock = "";
  if (prev || next) {
    const lines = [];
    if (prev) {
      lines.push(
        `已知上文（第${prev.idx}楼）：Time: ${prev.parsed.time || "未知"}　Location: ${prev.parsed.location || "未知"}　Overview: ${prev.parsed.overview || "（无）"}`,
      );
    }
    if (next) {
      lines.push(
        `已知下文（第${next.idx}楼）：Time: ${next.parsed.time || "未知"}`,
      );
    }
    anchorBlock = `${lines.join("\n")}\n（以上仅供你判断本段所处时间点和地点参考，不要照抄，需结合本段对话实际内容推进）\n\n`;
  }
  return `${anchorBlock}以下是第${start}楼到第${end}楼的对话原文（其中用户发言楼层仅供参考，不需要输出摘要）：\n\n${messagesText}\n\n请只针对第 ${targetListStr} 楼分别还原摘要字段，不要遗漏其中任何一层，也不要为用户发言楼层输出内容。`;
}


// === Helper: 按标签取单行字段值，如 "Time: xxx" 中取出 "xxx"。
// 冒号前后只吃同一行内的空格/制表符（[ \t]*），不能用 \s*——\s 包含换行符，
// 一旦某字段本轮为空（很常见，比如没变化的 Relationships/Inventory），\s* 会贪婪地吃穿换行，
// 把下一行的标签+内容当成当前字段的值，造成标签错位、内容重复（曾实际复现并确认）。
// 冒号同时兼容半角(:)和中文全角(：)——跟 parseKeyValueListWithSkipped 同样的原因，
// 中文语境下 AI 输出全角标点是常态，只认半角会导致该字段静默提取失败、返回空字符串。
// 三处调用方共用同一份正则规则：逐层还原结果解析、单层摘要模块解析、状态表条目快照读取，
// 避免各自维护一份同样的正则、慢慢跑偏。找不到该标签时返回空字符串，不报错。===
export function extractLabelLine(text, label) {
  if (!text || typeof text !== "string") return "";
  const re = new RegExp(`^[ \\t]*${label}[ \\t]*[:：][ \\t]*(.*)$`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}


// === Helper: 解析AI逐层还原结果——按"[第N楼]"标记切块，块内按 Time/Location/Overview 逐行取值
// （Overview要求AI写成不换行的一段话，用单行正则即可，不用像 parseFloorSummaryFields 那样特殊处理多行）。
// 返回 Map<楼层号, {time, location, overview}>；解析不到任何区块时返回空 Map，由调用方决定兜底策略。===
export function parseRestoredFloorFields(text) {
  const result = new Map();
  if (!text || typeof text !== "string") return result;

  const markerRe = /\[第(\d+)楼\]/g;
  const matches = [...text.matchAll(markerRe)];

  matches.forEach((m, i) => {
    const idx = parseInt(m[1], 10);
    const blockStart = m.index + m[0].length;
    const blockEnd =
      i + 1 < matches.length ? matches[i + 1].index : text.length;
    const inner = text.slice(blockStart, blockEnd);

    result.set(idx, {
      time: extractLabelLine(inner, "Time"),
      location: extractLabelLine(inner, "Location"),
      overview: extractLabelLine(inner, "Overview"),
    });
  });

  return result;
}


// === Helper: 解析 <summary> 标签内容（供逐层还原调用方使用，输出的是裸 <summary>[第N楼]...</summary>，
// 不带 <details> 外壳）。
// 提示词已要求所有目标楼层共用同一对标签，但模型偶尔仍可能按层各自输出多对 <summary></summary>——
// 这里用全局匹配把所有标签内容都提取出来并拼接，做兜底，避免只取到第一对标签导致后面楼层的还原结果被静默丢弃。===
export function parseSummaryContent(text) {
  if (!text || typeof text !== "string") return null;
  const matches = [...text.matchAll(/<summary>([\s\S]*?)<\/summary>/g)];
  if (matches.length === 0) return null;
  return matches
    .map((m) => m[1].trim())
    .filter(Boolean)
    .join("\n\n");
}


