"use strict";

import { SMALL_SUMMARY_TITLE_PREFIX, STATUS_TABLE_ENTRY_DEFAULTS, STATUS_TABLE_TITLE, getCtx, getLastAiFloor, notify, persistChatMetadata } from "../core.js";
import { handleCharacterBecameFree } from "../phone/generator.js";
import { getPhoneChatState } from "../phone/store.js";
import { getLorebookEntriesArray, getOrCreateSummaryLorebook, saveOrOverwriteLorebookEntry } from "../worldinfo.js";


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
  return `对话原文每层楼开头标注楼层号和说话者（如"[第12楼] AI："或"[第12楼] 用户："）。
现在请你对归属于AI的楼层逐层还原缺失的摘要字段（Time/Location/Overview），不要续写故事，不要输出 <summary> 标签之外的任何文字。
还原规则：
- 目标楼层逐层单独输出，不合并多层、不跳过任何一层、不把一层拆成多组
- Time: 该层故事场景结束时的时刻；精确到年月日+时分
- Location: 该层场景最后所在地点
- Overview: 按时间顺序列出关键事件+实际改变(关系/处境/认知)，平铺直叙不用比喻/形容词，写成一段话不换行；无实质进展留空，不超150字
请严格按照下面的格式输出，每层楼一个区块，区块之间空一行：
<summary>
[第{楼层号}楼]
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
// 不带 <details> 外壳）===
export function parseSummaryContent(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/);
  return match ? match[1].trim() : null;
}


// =====================================================================================
// === 摘要模块解析 & 结构化数据表（状态表）===
// 对应酒馆预设里每层输出的 <details><summary>摘要</summary>...</details> 模块，
// 每层摘要模块字段并列为 Time / Location / Relationships / Inventory / Setups / Overview；
// 但持久化进"状态表"世界书条目的只有 Relationships / Inventory / Setups 三项——
// Time / Location / Overview 只存在于每层楼的摘要模块原文里（Overview 另外供小总结提取用），不写入状态表。
// Inventory 的 value 支持 +N/-N/=N 三种符号触发数值增减/覆盖（见 applyNumericMapUpdates），
// 其他格式（裸数字、带单位、纯文字）一律按普通文字整体覆盖。
// Relationships 的 value 允许两种合法形式：(a) 纯裸词（阶段词/身份词/血亲词表里的某一个词，原样写）；
// (b) 身份/血亲词后面用括号附带一个阶段词，如"师徒(朋友)"（全角/半角括号都兼容）。
// 状态表合并时会用 isValidRelationshipWord 校验，两种形式都不合规的值会被跳过并提示，不会写入状态表。
// Setups 仍是自由文本；对代码而言只是不透明字符串，按 key 整体覆盖，内容格式不影响解析逻辑。
// =====================================================================================

// === Helper: 从单层楼消息原文里解析摘要模块的各字段，解析不到 <details>摘要</details> 时返回 null ===
export function parseFloorSummaryFields(mesText) {
  if (!mesText || typeof mesText !== "string") return null;
  const detailsMatch = mesText.match(
    /<details>\s*<summary>\s*摘要\s*<\/summary>([\s\S]*?)<\/details>/,
  );
  if (!detailsMatch) return null;
  const inner = detailsMatch[1];

  const overviewMatch = inner.match(/Overview\s*[:：]\s*([\s\S]*)$/);

  return {
    time: extractLabelLine(inner, "Time"),
    location: extractLabelLine(inner, "Location"),
    relationships: extractLabelLine(inner, "Relationships"),
    inventory: extractLabelLine(inner, "Inventory"),
    setups: extractLabelLine(inner, "Setups"),
    busy: extractLabelLine(inner, "Busy"), // 仅供手机私信插件读取"角色: [REMOVE]"信号，不参与状态表 Relationships/Inventory/Setups 的常规合并
    expiredChapter: extractLabelLine(inner, "ExpiredChapter"), // 仅供剧情录入模块读取"章节名已演绎完"信号，同样不参与状态表合并
    overview: overviewMatch ? overviewMatch[1].trim() : "",
  };
}


// === Helper: 判断本层是否"疑似尝试输出了摘要模块但结构不完整"（如漏写 </details> 闭合标签），
// 用于和"这层压根没写摘要"区分开——前者需要提示用户（数据静默丢失了），后者是正常情况，不用提示。===
export function detectMalformedSummaryBlock(mesText) {
  if (!mesText || typeof mesText !== "string") return false;
  if (
    /<details>\s*<summary>\s*摘要\s*<\/summary>[\s\S]*?<\/details>/.test(
      mesText,
    )
  )
    return false; // 能正常解析，不算畸形
  return (
    /<summary>\s*摘要\s*<\/summary>/.test(mesText) ||
    (/<details>/.test(mesText) && /摘要/.test(mesText))
  );
}


// === Helper: 解析 "key: value; key2: value2" 形式的分号分隔键值列表，
// 额外收集"解析不出 key:value 结构"的原始片段供状态表合并时做格式校验 ===
// 分隔符/冒号同时兼容半角(; :)和中文全角(； ：)——中文语境下 AI 输出全角标点是常态，
// 只认半角会导致多组内容拆不开、被错误地整体塞进前一个 key 的 value 里（曾实际复现过此问题）。
// 容错：识别"[REMOVE]key"这类缺冒号、REMOVE写在key前面的错误格式（正确格式应为"key: [REMOVE]"）。
// 兼容半角/全角方括号及中文方头括号，REMOVE 大小写不敏感。
export const REMOVE_PREFIX_PATTERN = /^[\[［【]\s*remove\s*[\]］】]\s*(.+)$/i;

// 容错：识别"key[REMOVE]"这类缺冒号、REMOVE写在key后面（紧跟或隔空格）的错误格式。
export const REMOVE_SUFFIX_PATTERN = /^(.+?)\s*[\[［【]\s*remove\s*[\]］】]$/i;


export function parseKeyValueListWithSkipped(str) {
  const map = new Map();
  const skipped = [];
  const corrected = [];
  if (!str) return { map, skipped, corrected };
  str.split(/[;；]/).forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const idx = trimmed.search(/[:：]/);
    if (idx === -1) {
      const removePrefixMatch = trimmed.match(REMOVE_PREFIX_PATTERN);
      if (removePrefixMatch) {
        const key = removePrefixMatch[1].trim();
        if (key) {
          map.set(key, "[REMOVE]");
          corrected.push(
            `"${trimmed}" 缺少冒号分隔，已按 "${key}: [REMOVE]" 处理`,
          );
          return;
        }
      }
      const removeSuffixMatch = trimmed.match(REMOVE_SUFFIX_PATTERN);
      if (removeSuffixMatch) {
        const key = removeSuffixMatch[1].trim();
        if (key) {
          map.set(key, "[REMOVE]");
          corrected.push(
            `"${trimmed}" 缺少冒号分隔，已按 "${key}: [REMOVE]" 处理`,
          );
          return;
        }
      }
      skipped.push(trimmed);
      return;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) {
      map.set(key, value);
    } else {
      skipped.push(trimmed);
    }
  });
  return { map, skipped, corrected };
}


// === Helper: 键值 Map 序列化回 "key: value; key2: value2" ===
// 序列化统一输出半角分号/冒号，保证状态表世界书条目自身的格式始终规范，
// 下一轮读回来解析时不会再引入全角标点问题。
export function serializeKeyValueList(map) {
  return Array.from(map.entries())
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}


// === Helper: 把 Inventory 快照里纯数字的 value 改写成 "=数字" 格式（如 "3" → "=3"）。
// 状态表里数值型 Inventory 条目的存储形式本身就是裸数字（applyNumericMapUpdates 写回时用 formatNumericValue
// 生成的就是不带符号的纯数字字符串），但 mergeFloorIntoStatusTable 只认 +N/-N/=N 三种带符号前缀的写法，
// 裸数字会被 looksLikeAttemptedNumericButMalformed 判定成"疑似想写数值但格式不对"，整条跳过不写入。
// 状态存档是要粘回新对话第0层、经由 rebuildStatusTableFromChat 重新解析合并回状态表的，所以必须提前把裸数字
// 转换成 =N 的合法写法，否则这些数值条目会在新对话第一次全量重放时被静默丢弃。
// 非纯数字的 value（文字备注，如"未开封"）原样保留，不做任何改写。===
export const BARE_NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

export function convertInventorySnapshotToHardset(inventoryLine) {
  const { map } = parseKeyValueListWithSkipped(inventoryLine);
  map.forEach((value, key) => {
    if (BARE_NUMBER_PATTERN.test(value.trim())) {
      map.set(key, `=${value.trim()}`);
    }
  });
  return serializeKeyValueList(map);
}


// === Helper: 全角数字/正负号/等号 → 半角，用于数值类字段的宽松解析 ===
export function normalizeNumericToken(raw) {
  return String(raw)
    .replace(/＋/g, "+")
    .replace(/－/g, "-")
    .replace(/＝/g, "=")
    .replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    );
}


// === Helper: 判断是否为"删除该 key"标记，兼容 [REMOVE] 的全角方括号/中文方头括号写法 ===
export function isRemoveMarker(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed === "[REMOVE]" ||
    trimmed === "［REMOVE］" ||
    trimmed === "【REMOVE】"
  );
}


// === Helper: 判断是否"疑似想写删除标记但格式没写对"（大小写不对、漏括号、写成中文"移除/删除"等）===
// 命中时既不会当作删除执行（避免误删），也不会当作普通文字整体覆盖（避免状态表里出现"[remove]"这类明显是格式错误的文本），
// 而是交给调用方跳过该条写入并提示，留给使用者自行判断。
export function looksLikeAttemptedRemove(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (isRemoveMarker(trimmed)) return false; // 标准写法走正常删除逻辑，不算"疑似"
  return (
    /^[\[［【(（]?\s*remove\s*[\]］】)）]?$/i.test(trimmed) ||
    trimmed === "移除" ||
    trimmed === "删除"
  );
}


// === Constants: Relationships 字段允许的固定关系词表（对应摘要.txt 里的阶段词/身份词/血亲词），用于校验 AI 输出是否合规 ===
export const RELATIONSHIP_STAGE_WORDS = [
  "陌生",
  "相识",
  "相熟",
  "好感",
  "暧昧",
  "亲密",
  "恋人",
  "未婚夫妻",
  "夫妻",
  "对手",
  "仇人",
  "宿敌",
  "同伴",
  "盟友",
  "朋友",
  "挚友",
];

export const RELATIONSHIP_RANK_WORDS = [
  "师徒",
  "师兄弟",
  "师兄妹",
  "师姐妹",
  "师姐弟",
  "义兄弟",
  "义兄妹",
  "义姐妹",
  "义姐弟",
  "同门",
  "同学",
  "同事",
  "邻居",
  "网友",
  "战友",
  "上下级",
  "继父子",
  "继父女",
  "继母子",
  "继母女",
  "主仆",
  "学长学弟",
  "学长学妹",
  "学姐学弟",
  "学姐学妹",
  "师生",
  "校友",
  "室友",
  "甲乙方",
  "合伙人",
  "医患",
  "队友",
  "教练学员",
  "房东租客",
  "粉丝偶像",
];

export const RELATIONSHIP_KIN_WORDS = [
  "父女",
  "父子",
  "母女",
  "母子",
  "兄弟",
  "兄妹",
  "姐弟",
  "姐妹",
  "祖孙",
  "叔侄",
  "舅甥",
  "姑侄",
  "姨甥",
  "表兄弟",
  "表兄妹",
  "表姐弟",
  "表姐妹",
  "堂兄弟",
  "堂兄妹",
  "堂姐弟",
  "堂姐妹",
];

export const RELATIONSHIP_ALLOWED_WORDS = new Set([
  ...RELATIONSHIP_STAGE_WORDS,
  ...RELATIONSHIP_RANK_WORDS,
  ...RELATIONSHIP_KIN_WORDS,
]);


// === Constant: 身份/血亲词表（合并），用于校验"身份/血亲词(阶段词)"这种带括号的合法形式 ===
export const RELATIONSHIP_RANK_OR_KIN_WORDS = new Set([
  ...RELATIONSHIP_RANK_WORDS,
  ...RELATIONSHIP_KIN_WORDS,
]);

export const RELATIONSHIP_STAGE_WORDS_SET = new Set(RELATIONSHIP_STAGE_WORDS);


// === Helper: 判断 Relationships 字段的 value 是否合法——允许两种形式：
//   (a) 纯裸词：词表（阶段词/身份词/血亲词）里的某一个词，原样写；
//   (b) 身份/血亲词(阶段词)：身份/名分词或血亲词后面紧跟半角/全角括号，括号里是一个阶段词，如 "师徒(朋友)"/"师徒（朋友）"。
// 其他任何附加内容（括注理由、单位等）一律不合法。 ===
export function isValidRelationshipWord(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (RELATIONSHIP_ALLOWED_WORDS.has(trimmed)) return true; // 形式 (a)：纯裸词

  const bracketMatch = trimmed.match(/^(.+?)[（(]([^（()）]+)[）)]$/); // 形式 (b)：主词 + 括号阶段词
  if (!bracketMatch) return false;
  const mainWord = bracketMatch[1].trim();
  const stageWord = bracketMatch[2].trim();
  return (
    RELATIONSHIP_RANK_OR_KIN_WORDS.has(mainWord) &&
    RELATIONSHIP_STAGE_WORDS_SET.has(stageWord)
  );
}


// === Helper: 把 Map 视为"当前状态"，用一批更新做增删改（value 为 [REMOVE] 时删除该 key）===
// warnings/fieldLabel 可选：传入时，遇到"疑似删除标记但格式不对"的 value 会跳过写入并记录一条提示，而不是当普通文字存进去。
export function applyMapUpdates(baseMap, updatesMap, warnings, fieldLabel) {
  updatesMap.forEach((value, key) => {
    if (isRemoveMarker(value)) {
      baseMap.delete(key);
    } else if (looksLikeAttemptedRemove(value)) {
      if (warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${value}" 疑似想写删除标记但格式不对（应为 [REMOVE]），已跳过，未做任何修改`,
        );
      }
    } else {
      baseMap.set(key, value);
    }
  });
}


// === Helper: 把数字格式化成字符串，去掉多余的浮点误差/尾随小数点 ===
export function formatNumericValue(num) {
  const rounded = Math.round(num * 1000) / 1000; // 保留最多3位小数，规避浮点误差
  return String(rounded);
}


// === Constants: Inventory 数值格式的两种合法正则，提升为模块级常量供多处复用 ===
export const NUMERIC_DELTA_PATTERN = /^([+-])(\d+(?:\.\d+)?)$/;

export const NUMERIC_HARDSET_PATTERN = /^=(-?\d+(?:\.\d+)?)$/;


// === Helper: 判断是否"疑似想写数值/数量但格式或用法不对"——
// 覆盖两类情况：
//   (a) =N/+N/-N 开头但带了多余括注/单位/理由（如 "=1(上衣口袋,未贴肉佩戴)"）；
//   (b) 裸数字开头，不带任何符号前缀（如 "3日份干粮"、"80x"）——这类值大概率不是合法的物品状态备注，
//       而是把数量、天数等信息错塞进了 Inventory，应引导写作者改写到 Overview，或改用合法的 =N/+N/-N 格式。
// 命中时既不会当作数值运算，也不会当作普通文字整体覆盖，而是交给调用方跳过该条写入并提示。===
export function looksLikeAttemptedNumericButMalformed(rawValue) {
  if (typeof rawValue !== "string") return false;
  const normalized = normalizeNumericToken(rawValue.trim());
  if (
    NUMERIC_DELTA_PATTERN.test(normalized) ||
    NUMERIC_HARDSET_PATTERN.test(normalized)
  )
    return false; // 合法格式，放行
  return /^[+\-=]?\d+(?:\.\d+)?/.test(normalized); // 数字开头（可选符号前缀），但整体不合法
}


// === Helper: 数值感知版的 Map 合并（供 Inventory 使用）——
// value 严格匹配两种格式才会触发数值运算，格式不符一律按普通文字整体覆盖（[REMOVE] 仍然是删除）：
//   +N / -N  → 在旧值基础上加减（旧值非数字或不存在时按 0 起算）
//   =N       → 直接覆盖成 N（N 可以带负号，如 =-5）
//   数字开头但不合法（含多余括注/单位，或裸数字开头）→ 疑似写错，跳过写入并警告，见 looksLikeAttemptedNumericButMalformed
//   其余非数字开头的纯文字 → 视为正常物品状态备注，原样整体覆盖
// 全角 ＋－＝ 和全角数字会先归一化成半角再匹配，未命中任何数值格式时仍保留原始文本（不做归一化覆盖），
// 避免把物品备注等纯文字误改写成归一化后的怪异内容。===
// warnings/fieldLabel 可选，用于收集校验提示；warnOnPlainFallback 参数保留供后续扩展使用——
// Inventory 允许非数值备注是正常用法（如物品状态说明），调用时传 false，不会提示（但数字开头的疑似误写始终会提示，不受此开关影响）。
export function applyNumericMapUpdates(
  baseMap,
  updatesMap,
  warnings,
  fieldLabel,
  warnOnPlainFallback,
) {
  updatesMap.forEach((rawValue, key) => {
    if (isRemoveMarker(rawValue)) {
      baseMap.delete(key);
      return;
    }

    if (looksLikeAttemptedRemove(rawValue)) {
      if (warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${rawValue}" 疑似想写删除标记但格式不对（应为 [REMOVE]），已跳过，未做任何修改`,
        );
      }
      return;
    }

    const normalized = normalizeNumericToken(rawValue.trim());
    const deltaMatch = normalized.match(NUMERIC_DELTA_PATTERN);
    const hardsetMatch = normalized.match(NUMERIC_HARDSET_PATTERN);

    if (deltaMatch) {
      const sign = deltaMatch[1] === "-" ? -1 : 1;
      const delta = sign * parseFloat(deltaMatch[2]);
      const oldValue = parseFloat(baseMap.get(key));
      const base = Number.isFinite(oldValue) ? oldValue : 0;
      const result = base + delta;
      if (result <= 0) {
        baseMap.delete(key);
        if (warnings) {
          warnings.push(
            `${fieldLabel || ""} "${key}" 数值计算后为 ${formatNumericValue(result)}（≤0），已自动移除该条目`,
          );
        }
      } else {
        baseMap.set(key, formatNumericValue(result));
      }
    } else if (hardsetMatch) {
      const result = parseFloat(hardsetMatch[1]);
      if (result <= 0) {
        baseMap.delete(key);
        if (warnings) {
          warnings.push(
            `${fieldLabel || ""} "${key}" 被硬修正为 ${formatNumericValue(result)}（≤0），已自动移除该条目`,
          );
        }
      } else {
        baseMap.set(key, formatNumericValue(result));
      }
    } else if (looksLikeAttemptedNumericButMalformed(rawValue)) {
      if (warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${rawValue}" 疑似想写数量(=N/+N/-N)但格式或用法不对（多余括注/单位，或把非物品数量的数字塞进了 Inventory），已跳过，未做任何修改`,
        );
      }
      // 不写入：避免状态表里出现半数值半文字的怪异内容
    } else {
      baseMap.set(key, rawValue); // 非数字开头的纯文字，按普通文字整体覆盖
      if (warnOnPlainFallback && warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${rawValue}" 不是合法的 +N/-N/=N 数值格式，已按普通文字整体覆盖，请检查该属性是否被写错`,
        );
      }
    }
  });
}


// === Helper: 把楼层摘要文本里等于"当前人格名"的整词换回状态表统一约定的字面量 {{user}} ===
// "对话前强调"提示词注入给正文AI之前，酒馆会先把其中的 {{user}} 宏替换成真实人格名，
// 正文AI从始至终都没见过字面量 {{user}}，它在 Relationships/Inventory/Setups 里写"自己"这一方时，
// 写的必然是当前人格名。这里在合并进状态表前统一转换回 {{user}}，让状态表内部数据保持
// extractOtherPartyName / 背包页 PHONE_INVENTORY_SELF_KEY 等下游代码一直依赖的那个约定，
// 不用在每处消费逻辑里都重新适配"真实人格名"。
// 只在紧跟着 "·"（Inventory/Setups 的 owner 分隔符）或 "→"（Relationships 的关系箭头）时才替换，
// 避免误伤人格名恰好出现在物品名、Setups 简介等自由文本内容里的情况。
export function normalizeSelfNameToLiteral(text) {
  if (!text) return text;
  const personaName = getCtx().name1;
  if (!personaName || personaName === "{{user}}") return text;
  const escaped = personaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[；;])\\s*${escaped}(?=\\s*[·→])`, "g");
  return text.replace(pattern, (_match, prefix) => `${prefix}{{user}}`);
}


// === Helper: 从 "{{user}}→角色名" 这类关系 key 里取出"另一方"角色名（排除 {{user}} 自身）===
export function extractOtherPartyName(relationshipKey) {
  const parts = relationshipKey.split("→").map((s) => s.trim());
  const other = parts.find((p) => p && p !== "{{user}}");
  return other || null;
}


// === Helper: 把状态表结构化对象序列化回世界书条目文本 ===
// busyMap 为可选参数：手机私信插件维护的"当前忙碌角色"表（{角色名: true, ...}），
// 不来自聊天记录全量重放（跟 Relationships/Inventory/Setups 不同源），只在序列化这一步拼进状态表末尾，
// 让正文 AI 每轮都能看到"谁正忙"，从而在这些角色不再登场时输出 Busy: 角色名: [REMOVE] 清除标记。
export function serializeStatusTableContent(state, busyMap) {
  const lines = [
    "<snapshot_table>",
    `Relationships: ${serializeKeyValueList(state.relationships)}`,
    `Inventory: ${serializeKeyValueList(state.inventory)}`,
    `Setups: ${serializeKeyValueList(state.setups)}`,
  ];
  const busyNames = busyMap
    ? Object.keys(busyMap).filter((name) => busyMap[name])
    : [];
  lines.push(`Busy: ${busyNames.map((name) => `${name}: 忙`).join("; ")}`);
  // 固定提醒行：每次序列化都重新生成，不写进任何 Map、不参与解析（不匹配任何字段标签的正则），
  // 纯粹是"贴在状态表末尾、每轮都会被 AI 看到"的复核提示，防止旧 Setups 条目（伏笔/未解线索）被长上下文遗忘。
  // 只在 Setups 非空时附加，避免空列表时提醒显得多余。
  if (state.setups && state.setups.size > 0) {
    lines.push(
      "（提醒：以上 Setups 每轮需逐条复核——已回收/已兑现/已废弃的，或因场景/时间线推进已不再可能被回收的，本轮请用 [REMOVE] 清除）",
    );
  }
  if (busyNames.length > 0) {
    lines.push(
      '（提醒：以上 Busy 中的角色若本轮未出现在正文场景里，请在摘要块的 Busy 字段输出"角色名: [REMOVE]"清除）',
    );
  }
  lines.push("</snapshot_table>");
  return lines.join("\n");
}


// === Helper: 把某一层解析出的摘要字段合并进状态表（Relationships/Inventory/Setups 按 key 增删改；Time/Location 不写入状态表；
// 角色在 Relationships 里被 [REMOVE]（死亡/永久退场）时，联动清理 Inventory/Setups 中"角色名·xxx"格式的相关条目）===
// warnings 为可选的数组，传入时会收集本次合并中发现的所有格式问题（不合规的部分会被跳过、不写入状态表，
// 但不会阻断其余合法字段的正常合并）。不传 warnings 时行为与之前完全一致，仅静默跳过不合规内容。
// removedOut 为可选的数组，传入时会把本层新death/离场（Relationships被标[REMOVE]）的角色名追加进去，
// 供调用方（rebuildStatusTableFromChat）联动清理这些角色残留的手机"忙碌"标记，不传则不影响原有行为。
export function mergeFloorIntoStatusTable(state, floorFields, warnings, removedOut) {
  const relationshipsText = normalizeSelfNameToLiteral(floorFields.relationships);
  const inventoryText = normalizeSelfNameToLiteral(floorFields.inventory);
  const setupsText = normalizeSelfNameToLiteral(floorFields.setups);

  const relParsed = parseKeyValueListWithSkipped(relationshipsText);
  if (warnings) {
    relParsed.skipped.forEach((fragment) =>
      warnings.push(
        `Relationships 中的片段 "${fragment}" 无法解析出 key:value 结构，已跳过`,
      ),
    );
    relParsed.corrected.forEach((msg) =>
      warnings.push(`Relationships：${msg}`),
    );
  }
  const removedCharacters = [];
  relParsed.map.forEach((value, key) => {
    if (isRemoveMarker(value)) {
      state.relationships.delete(key);
      const other = extractOtherPartyName(key);
      if (other) {
        removedCharacters.push(other);
        if (removedOut) removedOut.push(other);
      }
    } else if (isValidRelationshipWord(value)) {
      state.relationships.set(key, value);
    } else if (warnings) {
      warnings.push(
        `Relationships "${key}" 的值 "${value}" 不在允许的固定关系词表中，且不是 [REMOVE] 标记，已跳过，未做任何修改`,
      );
    }
    // 不传 warnings 时（旧行为兜底）：不合规的值直接跳过，不写入，避免脏数据进入状态表。
  });

  const inventoryParsed = parseKeyValueListWithSkipped(inventoryText);
  const setupsParsed = parseKeyValueListWithSkipped(setupsText);
  if (warnings) {
    inventoryParsed.skipped.forEach((fragment) =>
      warnings.push(
        `Inventory 中的片段 "${fragment}" 无法解析出 key:value 结构，已跳过`,
      ),
    );
    inventoryParsed.corrected.forEach((msg) =>
      warnings.push(`Inventory：${msg}`),
    );
    setupsParsed.skipped.forEach((fragment) =>
      warnings.push(
        `Setups 中的片段 "${fragment}" 无法解析出 key:value 结构，已跳过`,
      ),
    );
    setupsParsed.corrected.forEach((msg) => warnings.push(`Setups：${msg}`));
  }

  applyNumericMapUpdates(
    state.inventory,
    inventoryParsed.map,
    warnings,
    "Inventory",
    false,
  );
  applyMapUpdates(state.setups, setupsParsed.map, warnings, "Setups");

  removedCharacters.forEach((name) => {
    const prefix = `${name}·`;
    Array.from(state.inventory.keys()).forEach((key) => {
      if (key.startsWith(prefix)) state.inventory.delete(key);
    });
    Array.from(state.setups.keys()).forEach((key) => {
      if (key.startsWith(prefix)) state.setups.delete(key);
    });
  });

  return state;
}


// === Helper: 记录"已经提示过格式问题"的楼层，避免全量重放模式下同一层反复弹同一条警告。
// key 用 "messageId::具体问题文本" 拼接——同一层如果问题内容变了（比如用户手动改了这层文本），会当成新问题重新提示一次；
// 只有内容和上次完全一样才会被去重。切换角色卡/刷新页面后该记录清空，属于预期行为（值不大，不做持久化）。===
export const warnedStatusTableIssues = new Set();


// === Helper: 全量重放——以当前 chat 数组里【现存】的所有 AI 楼层为准，从头重新解析并合并出状态表。
// 不再对单一楼层做"增量合并后原地覆盖"，而是每次都重新推导一遍完整状态，天然与当前对话内容保持一致：
// 楼层被删除/回退后，下一次触发时重放范围会自动收窄，不需要额外的"检测回退"分支。===
export async function rebuildStatusTableFromChat() {
  const context = getCtx();
  const chat = context.chat;
  if (!Array.isArray(chat)) return;

  const state = {
    relationships: new Map(),
    inventory: new Map(),
    setups: new Map(),
  };
  const newIssues = []; // 本次重放中新出现（之前没提示过）的问题，收集齐后一次性提示
  const everRemovedCharacters = []; // 整段重放期间，所有被 Relationships [REMOVE]（死亡/永久离场）过的角色名

  chat.forEach((message, idx) => {
    if (!message || message.is_user) return;

    const floorFields = parseFloorSummaryFields(message.mes);
    if (!floorFields) {
      if (detectMalformedSummaryBlock(message.mes)) {
        const issueKey = `${idx}::malformed`;
        if (!warnedStatusTableIssues.has(issueKey)) {
          warnedStatusTableIssues.add(issueKey);
          newIssues.push(
            `第${idx}层似乎输出了摘要模块，但 <details>/<summary> 结构不完整（例如漏写闭合标签），未能解析，本层未计入状态表。`,
          );
        }
      }
      return;
    }

    const floorWarnings = [];
    mergeFloorIntoStatusTable(state, floorFields, floorWarnings, everRemovedCharacters);
    floorWarnings.forEach((w) => {
      const issueKey = `${idx}::${w}`;
      if (!warnedStatusTableIssues.has(issueKey)) {
        warnedStatusTableIssues.add(issueKey);
        newIssues.push(`第${idx}层：${w}`);
      }
    });
  });

  // 手机私信插件的 Busy 状态不参与上面的全量重放（它的来源是用户在手机里主动发消息，不是从聊天记录解析出来的），
  // 只在这里"读取当前值 → 拼进序列化结果"；常规 REMOVE 信号只看【最新一层】AI 楼层，不回溯整段历史——
  // 忙碌状态本身只在"当前"有意义，没必要像 Relationships 那样重放整个对话。
  // 例外：角色死亡/永久离场（Relationships [REMOVE]）这种"确定不会再有下文"的情况，不受上面这条限制，
  // 见下方 everRemovedCharacters 的联动清理。
  const phoneState = getPhoneChatState();

  // 死亡/永久离场角色联动清理"忙碌"标记：这类角色已经确定不会再回复私信，
  // 不等 AI 在某一层想起来补一句 Busy: 角色名: [REMOVE]（它未必会记得），直接用上面重放时已经拿到的
  // "谁被 Relationships [REMOVE] 过"结论同步清掉，避免状态表里一直挂着一条不会再被清除的"角色: 忙"。
  // 注意：这里不走 freedCharacters/handleCharacterBecameFree 那条自动补发私信回复的路径——
  // 角色已经死亡/离场，不该再让手机弹出一条"ta的新消息"。
  let busyCleanupChanged = false;
  everRemovedCharacters.forEach((name) => {
    if (phoneState.busy[name]) {
      delete phoneState.busy[name];
      busyCleanupChanged = true;
    }
  });

  const freedCharacters = [];
  const { idx: latestAiIdx, mes: latestAiMes } = getLastAiFloor();
  if (latestAiIdx !== -1) {
    const latestFields = parseFloorSummaryFields(latestAiMes);
    if (latestFields && latestFields.busy) {
      const { map: busyRemoveMap } = parseKeyValueListWithSkipped(
        latestFields.busy,
      );
      busyRemoveMap.forEach((value, name) => {
        if (isRemoveMarker(value) && phoneState.busy[name]) {
          delete phoneState.busy[name];
          freedCharacters.push(name);
        }
      });
    }
  }

  const newContent = serializeStatusTableContent(state, phoneState.busy);
  const lorebookName = await getOrCreateSummaryLorebook();
  await saveOrOverwriteLorebookEntry(
    lorebookName,
    STATUS_TABLE_TITLE,
    newContent,
    true,
    STATUS_TABLE_ENTRY_DEFAULTS,
  );

  if (freedCharacters.length > 0 || busyCleanupChanged) {
    await persistChatMetadata();
    for (const name of freedCharacters) {
      await handleCharacterBecameFree(name);
    }
  }

  if (newIssues.length > 0) {
    notify(
      "warning",
      `状态表重新计算时发现 ${newIssues.length} 处新的格式问题，相关内容已跳过：\n` +
        newIssues.map((w) => `· ${w}`).join("\n"),
    );
  }
}


// === Event handler: 楼层变化（新增/删除/编辑/重roll）后自动重算状态表（出错不弹窗打断阅读，仅打印控制台）===
export const handleMessageForStatusTable = async () => {
  try {
    await rebuildStatusTableFromChat();
  } catch (error) {
    console.error("[剧情助手] 自动更新状态表时出错:", error);
  }
};


// === Helper: 生成一段楼层范围的"小总结"内容——连续有摘要模块的楼层直接读取并保留 Time/Location/Overview 拼接，
// 连续没有摘要模块的楼层区间才调用 AI 重新总结（方案A：分段回退）。不再提取/生成关系字段——
// 关系状态统一由状态表世界书条目实时持久化（见 mergeFloorIntoStatusTable），小总结只做叙事性回顾，状态存档只做状态快照。===
// === Helper: 从摘要模块的 Time 原始文本里截取"年月"粒度的关键词——按字面"年"/"月"两个字切分，
// 不解析语义（纪年法/数字格式怎么变都不影响），取字符串开头到"月"字（含）为止；
// 找不到"年"或"月"就返回空字符串，交由调用方决定兜底策略。===
export function extractYearMonthKeyword(timeText) {
  if (!timeText || typeof timeText !== "string") return "";
  const yearIdx = timeText.indexOf("年");
  if (yearIdx === -1) return "";
  const monthIdx = timeText.indexOf("月", yearIdx);
  if (monthIdx === -1) return "";
  return timeText.slice(0, monthIdx + 1);
}


// =====================================================================================
// === 状态存档：Time 本地拼接 + Overview 二次总结 ===
// 状态存档的 Time/Overview 都来自世界书里已有的"小总结：起-止"条目，不重新扫描聊天记录：
// Time 本地拼接（不调用AI，直接取最早/最晚小总结条目里的"时间："字段头尾）；
// Overview 调用AI把全部小总结正文交给它二次提炼（唯一的AI调用点）。
// =====================================================================================

// === Helper: 扫描世界书全部"小总结：起-止"条目，按起始楼层升序排列，供状态存档拼接使用 ===
export async function getSortedSmallSummaryEntries(lorebookName) {
  const entries = await getLorebookEntriesArray(lorebookName);
  const smallSummaries = [];
  entries.forEach((entry) => {
    const range = extractSmallSummaryRange(entry.comment);
    if (range) {
      smallSummaries.push({ ...range, content: entry.content || "" });
    }
  });
  smallSummaries.sort((a, b) => a.start - b.start);
  return smallSummaries;
}


// === Helper: 从小总结正文的"时间：A ~ B"或"时间：A"或"时间：未知"里取头部或尾部时间点，
// "未知"返回 null，交由调用方跳过并继续找下一条。side 传 "head" 取起点，"tail" 取止点。===
export function extractTimeBoundary(timeLabel, side) {
  if (!timeLabel || timeLabel === "未知") return null;
  const parts = timeLabel.split("~").map((s) => s.trim());
  const value = side === "head" ? parts[0] : parts[parts.length - 1];
  return value || null;
}


// === Helper: 状态存档的 Time 字段——从排序后的小总结条目里，正向找第一条有效时间点当起点，
// 反向找第一条有效时间点当止点；起止相同只显示一个值；全部"未知"或没有任何小总结条目时返回空字符串。===
export function buildArchiveTimeLabel(sortedSmallSummaries) {
  let headTime = null;
  for (const entry of sortedSmallSummaries) {
    const timeLabel = extractLabelLine(entry.content, "时间");
    headTime = extractTimeBoundary(timeLabel, "head");
    if (headTime) break;
  }

  let tailTime = null;
  for (let i = sortedSmallSummaries.length - 1; i >= 0; i--) {
    const timeLabel = extractLabelLine(sortedSmallSummaries[i].content, "时间");
    tailTime = extractTimeBoundary(timeLabel, "tail");
    if (tailTime) break;
  }

  if (!headTime && !tailTime) return "";
  if (!headTime) return tailTime;
  if (!tailTime) return headTime;
  return headTime === tailTime ? headTime : `${headTime} ~ ${tailTime}`;
}


// === Helper: 状态存档的 Overview 二次总结提示词（systemPrompt，固定不变）===
export function buildArchiveOverviewInstruction() {
  return `<story_history>是这个故事按时间顺序排列的分段事件记录。
请提炼成一份不超过1000字的剧情总览，展现故事的完整脉络。
直接输出剧情总览，不带任何标签。`;
}


// === Helper: 状态存档的 Overview 二次总结用户输入——把排序后全部小总结正文拼接进 <story_history> 标签 ===
export function buildArchiveOverviewUserContent(sortedSmallSummaries) {
  const storyHistoryText = sortedSmallSummaries
    .map((entry) => entry.content)
    .join("\n\n");
  return `<story_history>\n${storyHistoryText}\n</story_history>`;
}
