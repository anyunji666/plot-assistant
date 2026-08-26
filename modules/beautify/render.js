"use strict";

import { STATUS_TABLE_TITLE, escapeHtml, getCtx, getLastAiFloor } from "../core.js";
import { extractLabelLine, parseFloorSummaryFields } from "../summary/parser.js";
import {
  WEEKDAY_LABELS,
  buildHolidaySuffix,
  daysInMonth,
  parseCustomHolidaysText,
  parseStoryDate,
} from "../holiday/calc.js";
import { getCustomHolidaysRawText } from "../holiday/settings.js";
import { getLorebookEntriesArray, getOrCreateSummaryLorebook } from "../worldinfo.js";
import { classifyRelationshipValue } from "./badges.js";

// =====================================================================================
// 摘要卡片美化模块：把楼层摘要模块 / 状态存档消息里原生的
// <details><summary>摘要</summary>...</details> 折叠块，替换成统一风格的可视化卡片。
//
// 原则：
// - 只改"显示"，不改楼层原文。所有解析都直接读 context.chat[idx].mes（原文），
//   不依赖也不修改 DOM 里已渲染的文本，保证 parser.js 那一整套正则解析逻辑完全不受影响。
// - 普通楼层摘要（Time/Location/Relationships/Busy/ExpiredChapter/Overview）和
//   状态存档消息（Time/Relationships/Inventory/Setups/Overview）复用同一套模板，
//   缺字段的行直接不渲染。
// - Relationships/Inventory/Setups/Busy 这四项在"最新一层AI楼层"的卡片上，展示的都是世界书
//   「状态表」条目里合并后的当前完整状态，而不是这一层楼原文自己写的增量变化——语义对齐 Busy
//   一贯的做法。其余历史楼层的卡片，这几项仍然按各自楼层原文解析展示（当层增量），
//   保留"逐层回看变化"的历史价值，两者互不影响。
// - 全部楼层都处理，不做"只处理最近N层"的限制（一次性字符串正则解析，性能开销很小）。
// - 通过 MutationObserver 监听 #chat 的 DOM 变化实现：新消息生成完成、编辑、滑动切换、
//   切换对话之后都会被自动扫描到；流式输出过程中原文还没写完整的 </details> 闭合标签，
//   parseFloorSummaryFields 会返回 null，天然跳过不处理，等生成完毕再一次性替换。
// - 替换后原来的 <details> 节点被整个换成卡片节点，下一次扫描时该消息里已经找不到
//   "摘要" 的 <details>，不会重复处理、也不会死循环；如果消息被编辑/重新生成，
//   酒馆会整体重建 .mes_text 内容（带回一个全新的原生 <details>），下一次扫描自然会
//   重新生成一次卡片，不需要额外的哈希对比。
// =====================================================================================

const CARD_CLASS = "pa-summary-card";

let debounceTimer = null;
let observer = null;

// === Helper: 简单防抖，合并短时间内的大量 DOM 变化通知 ===
function debounce(fn, wait) {
  return (...args) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn(...args), wait);
  };
}

// === Helper: 把 "key: value" 或 "key：value" 形式的一段文本，按分号拆成多组 [key, value] ===
// 冒号只切第一个（value 里允许再出现冒号），跟 parser.js 里 key:value 的解析口径保持一致。
function splitKeyValuePairs(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((seg) => {
      const idx = seg.search(/[:：]/);
      if (idx === -1) return { key: seg, value: "" };
      return { key: seg.slice(0, idx).trim(), value: seg.slice(idx + 1).trim() };
    });
}

// === Helper: Overview 按事件拆条——优先按"；/;"拆，若只有一条再退回按中文句号拆 ===
function splitOverviewItems(text) {
  if (!text || typeof text !== "string") return [];
  let items = text
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length <= 1) {
    const bySentence = text
      .split(/。/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (bySentence.length > 1) items = bySentence;
  }
  return items;
}

// === Helper: 构造 Time 行——主日期文本 + 星期/本月天数 + 附近节假日提示（现算，不依赖 AI 输出）===
function buildTimeRowHtml(timeText) {
  const escapedTime = escapeHtml(timeText);
  const parsed = parseStoryDate(timeText);
  if (!parsed) {
    // 解析不出严格公历格式（虚构纪年/农历写法等）：只显示原文，不附星期/节日信息
    return `<div class="pa-field-row pa-time-row">
      <span class="pa-field-icon">📅</span>
      <span class="pa-field-value">${escapedTime}</span>
    </div>`;
  }
  const date0 = new Date(parsed.year, parsed.month - 1, parsed.day);
  const weekdayLabel = WEEKDAY_LABELS[date0.getDay()];
  const monthDays = daysInMonth(parsed.year, parsed.month);
  let customHolidays = [];
  try {
    customHolidays = parseCustomHolidaysText(getCustomHolidaysRawText()).items;
  } catch (error) {
    // 面板没配置过自定义节假日、或读取失败时静默忽略，不影响星期/本月天数的正常显示
  }
  const holidaySuffixRaw = buildHolidaySuffix(date0, customHolidays);
  const holidayText = holidaySuffixRaw
    ? holidaySuffixRaw.replace(/^（|）$/g, "")
    : "";

  return `<div class="pa-field-row pa-time-row">
    <span class="pa-field-icon">📅</span>
    <span class="pa-field-value">${escapedTime}</span>
    <span class="pa-weekday-tag">星期${weekdayLabel}・本月共${monthDays}天</span>
    ${holidayText ? `<span class="pa-holiday-tag">🎉 ${escapeHtml(holidayText)}</span>` : ""}
  </div>`;
}

// === Helper: 构造 Relationships 行——按"；"拆分，[REMOVE] 的不渲染，其余按关系词分级上色 ===
function buildRelationshipsRowsHtml(relationshipsText) {
  const pairs = splitKeyValuePairs(relationshipsText);
  const badges = pairs
    .filter((p) => !/^\[?remove\]?$/i.test(p.value.replace(/[【】]/g, "")))
    .map((p) => {
      const classified = classifyRelationshipValue(p.value);
      if (!classified) return "";
      const { label, color } = classified;
      return `<div class="pa-relationship-item">
        <span class="pa-relationship-key">${escapeHtml(p.key)}</span>
        <span class="pa-badge" style="background:${color.bg};color:${color.fg};border-color:${color.border}">${escapeHtml(label)}</span>
      </div>`;
    })
    .filter(Boolean);
  if (badges.length === 0) return "";
  return `<div class="pa-field-block">
    <div class="pa-field-block-title"><span class="pa-field-icon">🤝</span>人物关系</div>
    <div class="pa-relationship-list">${badges.join("")}</div>
  </div>`;
}

// === Helper: 一次性读取"状态表"世界书条目里的当前完整状态快照——Relationships/Inventory/Setups
// 三项合并后的原始行文本，以及 Busy 忙碌名单（手机私信模块判定并写入，正文AI只负责用 [REMOVE] 清除，
// 不负责标记"忙"）。四项都只反映"当前"这一个全局状态，不属于任何具体某一层楼的历史信息，
// 只应用在最新一层AI楼层的卡片上（见 scanAndBeautifyAll / beautifyOneMessageEl）。
// 拿不到（未选中角色卡/世界书还没创建/条目还不存在）时返回 null，由调用方回退到该层原文的
// 逐层解析结果，不报错、不阻断卡片渲染。===
async function fetchStatusTableSnapshot() {
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const entries = await getLorebookEntriesArray(lorebookName);
    const statusTableEntry = entries.find((entry) => entry.comment === STATUS_TABLE_TITLE);
    if (!statusTableEntry) return null;
    const content = statusTableEntry.content;
    const busyLine = extractLabelLine(content, "Busy");
    return {
      relationships: extractLabelLine(content, "Relationships"),
      inventory: extractLabelLine(content, "Inventory"),
      setups: extractLabelLine(content, "Setups"),
      // 格式固定是 "角色A: 忙; 角色B: 忙"（见 parser.js serializeStatusTableContent），只取角色名，值恒为"忙"不用管
      busyNames: busyLine
        ? splitKeyValuePairs(busyLine).map((p) => p.key).filter(Boolean)
        : [],
    };
  } catch (error) {
    return null;
  }
}

// === Helper: 构造 Busy 行——只在有人正忙碌时才渲染，展示的是"当前"忙碌名单 ===
function buildBusyRowsHtml(busyNames) {
  if (!Array.isArray(busyNames) || busyNames.length === 0) return "";
  const lines = busyNames.map(
    (name) => `<div class="pa-plain-row"><span class="pa-field-icon">📱</span>${escapeHtml(name)} 忙碌中</div>`,
  );
  return lines.join("");
}

// === Helper: 构造 Inventory / Setups 这类 key:value 列表字段的通用渲染（图标+标题+逐条列出）===
function buildKeyValueBlockHtml(icon, title, text) {
  const pairs = splitKeyValuePairs(text);
  if (pairs.length === 0) return "";
  const items = pairs
    .map(
      (p) =>
        `<div class="pa-kv-item"><span class="pa-kv-key">${escapeHtml(p.key)}</span>${
          p.value ? `<span class="pa-kv-value">${escapeHtml(p.value)}</span>` : ""
        }</div>`,
    )
    .join("");
  return `<div class="pa-field-block">
    <div class="pa-field-block-title"><span class="pa-field-icon">${icon}</span>${title}</div>
    <div class="pa-kv-list">${items}</div>
  </div>`;
}

// === Helper: 构造 Overview 分句列表 ===
function buildOverviewBlockHtml(overviewText) {
  const items = splitOverviewItems(overviewText);
  if (items.length === 0) return "";
  const lis = items.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  return `<div class="pa-field-block">
    <div class="pa-field-block-title"><span class="pa-field-icon">📜</span>本轮概览</div>
    <ul class="pa-overview-list">${lis}</ul>
  </div>`;
}

// === 主函数：字段对象 → 完整卡片 HTML 字符串。
// fields.relationships/inventory/setups：调用方按需传入——最新一层楼传状态表当前完整状态，
// 其余楼层传该层原文自己的增量变化，本函数不关心来源，只负责渲染。
// busyNames 是可选的"当前忙碌名单"（只有最新一层楼的卡片会传入非空值，见 beautifyOneMessageEl），
// 不来自 fields.busy——楼层原文里的 Busy 字段只会是正文AI写的 [REMOVE] 清除信号，没有展示价值。===
export function buildSummaryCardHtml(fields, busyNames = []) {
  const parts = [];

  parts.push(`<div class="pa-card-header"><span class="pa-field-icon">📖</span>剧情摘要</div>`);

  if (fields.time) parts.push(buildTimeRowHtml(fields.time));

  if (fields.location) {
    parts.push(`<div class="pa-field-row">
      <span class="pa-field-icon">📍</span>
      <span class="pa-field-value">${escapeHtml(fields.location)}</span>
    </div>`);
  }

  if (fields.relationships) parts.push(buildRelationshipsRowsHtml(fields.relationships));
  if (fields.inventory) parts.push(buildKeyValueBlockHtml("🎒", "物品", fields.inventory));
  if (fields.setups) parts.push(buildKeyValueBlockHtml("🧩", "伏笔", fields.setups));

  const busyHtml = buildBusyRowsHtml(busyNames);
  if (busyHtml) parts.push(busyHtml);

  if (fields.expiredChapter) {
    parts.push(`<div class="pa-plain-row">
      <span class="pa-field-icon">📕</span>「${escapeHtml(fields.expiredChapter)}」已完结
    </div>`);
  }

  if (fields.overview) parts.push(buildOverviewBlockHtml(fields.overview));

  return `<div class="${CARD_CLASS}">${parts.join("")}</div>`;
}

// === Helper: 在单条消息 DOM 里查找"摘要"这个 <details>（可能存在也可能不存在）===
function findSummaryDetailsEl(mesTextEl) {
  const detailsList = mesTextEl.querySelectorAll("details");
  for (const el of detailsList) {
    const summaryEl = el.querySelector(":scope > summary");
    if (summaryEl && summaryEl.textContent.trim() === "摘要") return el;
  }
  return null;
}

// === 处理单条消息：原文能解析出摘要字段 且 DOM 里还存在原生 <details> 时，替换成卡片。
// lastAiIdx：当前聊天里最新一层AI楼层的下标。只有这一层的卡片，Relationships/Inventory/Setups/Busy
// 四项才会换成 snapshot（状态表当前完整状态），其余历史楼层这几项仍展示该层原文自己的增量变化。
// snapshot 为 null（世界书还没创建/条目不存在）时，最新层也照常回退到该层原文的解析结果。===
function beautifyOneMessageEl(mesEl, lastAiIdx, snapshot) {
  const mesTextEl = mesEl.querySelector(".mes_text");
  if (!mesTextEl) return;

  const detailsEl = findSummaryDetailsEl(mesTextEl);
  if (!detailsEl) return; // 没有摘要块，或已经被替换过（卡片不是 <details>，不会再被选中）

  const mesIdRaw = mesEl.getAttribute("mesid");
  const mesId = mesIdRaw !== null ? parseInt(mesIdRaw, 10) : NaN;
  let rawMes = null;
  if (!isNaN(mesId)) {
    const chat = getCtx().chat;
    rawMes = Array.isArray(chat) && chat[mesId] ? chat[mesId].mes : null;
  }
  // 拿不到 mesid/原文时（极端情况），退回读取 DOM 里 <details> 的纯文本内容做兜底解析，
  // 保证至少能正常显示，不至于因为拿不到原文就完全不美化。
  const sourceText = typeof rawMes === "string" ? rawMes : detailsEl.outerHTML;

  const fields = parseFloorSummaryFields(sourceText);
  if (!fields) return; // 原文里的摘要块还没写完整（流式输出中）或解析失败，跳过，等下一次变化再试

  const isLatest = mesId === lastAiIdx;
  const displayFields =
    isLatest && snapshot
      ? {
          ...fields,
          relationships: snapshot.relationships,
          inventory: snapshot.inventory,
          setups: snapshot.setups,
        }
      : fields;
  const busyNames = isLatest && snapshot ? snapshot.busyNames : [];

  const wrapper = document.createElement("div");
  wrapper.innerHTML = buildSummaryCardHtml(displayFields, busyNames);
  detailsEl.replaceWith(wrapper.firstElementChild);
}

// === 全量扫描当前聊天里所有消息。状态表快照只读取一次（世界书条目是全局状态，跟具体哪层楼无关），
// 读取失败/为空时不影响卡片其余部分的正常渲染（回退到各层原文解析结果）。===
async function scanAndBeautifyAll() {
  const chatEl = document.getElementById("chat");
  if (!chatEl) return;

  const lastAiIdx = getLastAiFloor().idx;
  const snapshot = lastAiIdx >= 0 ? await fetchStatusTableSnapshot() : null;

  chatEl.querySelectorAll(".mes").forEach((mesEl) => {
    try {
      beautifyOneMessageEl(mesEl, lastAiIdx, snapshot);
    } catch (error) {
      console.error("[剧情助手] 摘要卡片美化单条消息时出错:", error);
    }
  });
}

const debouncedScan = debounce(scanAndBeautifyAll, 150);

// === 对外入口：注册 MutationObserver，随聊天区域任意变化（新消息/编辑/滑动/切换对话）自动重新扫描 ===
export function initSummaryBeautify() {
  const chatEl = document.getElementById("chat");
  if (!chatEl) {
    console.warn("[剧情助手] 未找到 #chat 容器，摘要卡片美化未启用。");
    return;
  }
  if (observer) return; // 避免重复注册

  observer = new MutationObserver(() => debouncedScan());
  observer.observe(chatEl, { childList: true, subtree: true, characterData: true });

  // 插件加载/切换到已有聊天时，先手动跑一次，不用等下一次 DOM 变化才触发
  scanAndBeautifyAll();
}
