"use strict";

import { saveSettingsDebounced } from "../../../../../../script.js";
import { extension_settings } from "../../../../../extensions.js";

import { STATUS_TABLE_TITLE, escapeHtml, getCtx, getLastAiFloor } from "../core.js";
import { extractLabelLine } from "../summary/floor-restore.js";
import { parseFloorSummaryFields } from "../summary/status-table.js";
import {
  WEEKDAY_LABELS,
  buildHolidaySuffix,
  daysInMonth,
  parseCustomHolidaysText,
  parseStoryDate,
} from "../holiday/calc.js";
import { getCustomHolidaysRawText } from "../holiday/settings.js";
import { getLorebookEntriesArray, getOrCreateSummaryLorebook } from "../worldinfo.js";
import { getCustomFields } from "../summary/status-llm/store.js";
import { classifyRelationshipValue } from "./badges.js";

// =====================================================================================
// 摘要卡片美化模块：把楼层摘要模块 / 状态存档消息里原生的
// <details><summary>摘要</summary>...</details> 折叠块，替换成统一风格的可视化卡片。
//
// 原则：
// - 只改"显示"，不改楼层原文。所有解析都直接读 context.chat[idx].mes（原文），
//   不依赖也不修改 DOM 里已渲染的文本，保证 status-table.js 那一整套正则解析逻辑完全不受影响。
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

// === 顶栏日期图标：用内嵌 SVG 替代 Unicode 表情 📅，避免 PC / 移动端各自系统 emoji 字体
// 画法不一致（尤其安卓 Noto Emoji 固定带数字"17"）的问题，保证任何平台都渲染同一张图。
// 图标来源 freeicon.com（个人及商业用途免费使用）。===
const PA_ICON_CALENDAR =
  '<svg class="pa-icon-calendar" viewBox="49 98.5 414 414" width="1em" height="1em" ' +
  'style="vertical-align:-2px" aria-hidden="true" focusable="false">' +
  '<path fill="#E4EBF8" d="M256,163.5c0,0-241.69,25-250,25c0,31.203,0,247.691,0,280c112.634,0,378.955,0,500,0' +
  'c0-17.657,0-268.197,0-280C495.261,188.5,256,163.5,256,163.5z"/>' +
  '<path fill="#FF3445" d="M6,98.5v90c23.067,0,476.97,0,500,0v-90C20.772,98.5,478.56,98.5,6,98.5z"/>' +
  '<polygon fill="#B5E237" points="354.99,281.22 256,380.22 227.71,408.5 199.43,380.22 157,337.79 185.29,309.51 ' +
  '227.71,351.93 326.71,252.94"/>' +
  "</svg>";

// === 摘要卡片展开/收拢：全局偏好设置，不区分角色卡/对话——跟酒馆账号本身持久化，
// 换设备登录同一酒馆账号也能同步（用的是酒馆自带的 extension_settings + saveSettingsDebounced，
// 跟 status-llm/store.js 同一套存储方式）。
// 点击任意一张卡片的顶栏时，会把新状态同步应用到"当前聊天里所有已渲染的卡片"（见 initSummaryBeautify
// 的委托点击事件），后续新生成/重新扫描出的卡片（包括历史楼层）在构建时也会读取这份偏好决定初始状态，
// 不需要逐层单独记忆，天然保持全局一致。===
const SUMMARY_CARD_UI_SETTINGS_KEY = "plot_assistant_summary_card_ui";

function getSummaryCardCollapsed() {
  const cfg = extension_settings[SUMMARY_CARD_UI_SETTINGS_KEY];
  return !!(cfg && cfg.collapsed);
}

function setSummaryCardCollapsed(collapsed) {
  if (!extension_settings[SUMMARY_CARD_UI_SETTINGS_KEY]) {
    extension_settings[SUMMARY_CARD_UI_SETTINGS_KEY] = {};
  }
  extension_settings[SUMMARY_CARD_UI_SETTINGS_KEY].collapsed = collapsed;
  saveSettingsDebounced();
}

// === Helper: 字段列表内相邻条目之间的分隔符——同一行内横向流式排列时用来隔开条目，
// Relationships/Inventory/Setups 这类"逐条列出"的字段统一复用，保持视觉风格一致 ===
const ITEM_SEPARATOR_HTML = `<span class="pa-item-sep">|</span>`;

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
// 冒号只切第一个（value 里允许再出现冒号），跟 status-table.js 里 key:value 的解析口径保持一致。
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

// === Helper: 构造卡片顶栏——直接把原来"Time 行"的内容（日期 + 星期/本月天数 + 附近节假日提示，
// 现算，不依赖 AI 输出）当顶栏正文用，不再单独占一行、也不再显示"剧情摘要"这个标题文字；
// 顶栏本身可点击展开/收拢（见 initSummaryBeautify 的委托点击事件），末尾固定带一个箭头图标。
// 没有 Time 字段时（理论上不该发生，Time 是摘要模块的必填项）兜底显示回原来的"剧情摘要"文字，
// 保证顶栏任何情况下都不会空着。===
function buildCardHeaderHtml(timeText) {
  let bodyHtml;
  if (!timeText) {
    bodyHtml = `<span class="pa-field-icon">📖</span>剧情摘要`;
  } else {
    const escapedTime = escapeHtml(timeText);
    const parsed = parseStoryDate(timeText);
    if (!parsed) {
      // 解析不出严格公历格式（虚构纪年/农历写法等）：只显示原文，不附星期/节日信息
      bodyHtml = `<span class="pa-field-icon">${PA_ICON_CALENDAR}</span>${escapedTime}`;
    } else {
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
      bodyHtml = `<span class="pa-field-icon">${PA_ICON_CALENDAR}</span>${escapedTime}
        <span class="pa-weekday-tag">星期${weekdayLabel}・本月共${monthDays}天</span>
        ${holidayText ? `<span class="pa-holiday-tag">🎉 ${escapeHtml(holidayText)}</span>` : ""}`;
    }
  }
  return `<div class="pa-card-header">
    ${bodyHtml}
    <span class="pa-card-toggle">▾</span>
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
    <div class="pa-relationship-list">${badges.join(ITEM_SEPARATOR_HTML)}</div>
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
    const custom = {};
    getCustomFields().forEach((field) => {
      custom[field.name] = extractLabelLine(content, field.name);
    });
    return {
      relationships: extractLabelLine(content, "Relationships"),
      inventory: extractLabelLine(content, "Inventory"),
      setups: extractLabelLine(content, "Setups"),
      custom, // { 附加字段名: 状态表当前值（角色维度是"角色A: 值；角色B: 值"，全局维度是单个值） }
      // 格式固定是 "角色A: 忙; 角色B: 忙"（见 status-table.js serializeStatusTableContent），只取角色名，值恒为"忙"不用管
      busyNames: busyLine
        ? splitKeyValuePairs(busyLine).map((p) => p.key).filter(Boolean)
        : [],
    };
  } catch (error) {
    return null;
  }
}

// === Helper: 构造 Busy 字段——只在有人正忙碌时才渲染，展示的是"当前"忙碌名单。
// 跟 Inventory/Relationships 一样同行展示、自动换行，不再逐人单独占一行 ===
function buildBusyRowsHtml(busyNames) {
  if (!Array.isArray(busyNames) || busyNames.length === 0) return "";
  const items = busyNames
    .map((name) => `<span class="pa-busy-item">${escapeHtml(name)}</span>`)
    .join(ITEM_SEPARATOR_HTML);
  return `<div class="pa-field-block">
    <div class="pa-field-block-title"><span class="pa-field-icon">📱</span>忙碌中</div>
    <div class="pa-kv-list">${items}</div>
  </div>`;
}

// === Helper: 字段列表内相邻条目之间的分隔符——同一行内横向流式排列时用来隔开条目，
// Relationships/Inventory/Setups 这类"逐条列出"的字段统一复用，保持视觉风格一致 ===

// === Helper: 构造 Inventory / Setups 这类 key:value 列表字段的通用渲染（图标+标题+逐条列出）
// emphasizeValue：true 时 value 用强调样式（加粗徽标，视觉呼应人物关系的 badge），key 转为淡色——
// 目前只有 Inventory（物品名淡、数量显眼）传 true；Setups 的 value 是自由描述文本，不适合套徽标，维持原样。===
function buildKeyValueBlockHtml(icon, title, text, emphasizeValue = false) {
  const pairs = splitKeyValuePairs(text);
  if (pairs.length === 0) return "";
  const keyClass = emphasizeValue ? "pa-kv-key pa-kv-key--muted" : "pa-kv-key";
  const valueClass = emphasizeValue ? "pa-kv-value pa-kv-value--emphasis" : "pa-kv-value";
  const items = pairs
    .map(
      (p) =>
        `<div class="pa-kv-item"><span class="${keyClass}">${escapeHtml(p.key)}</span>${
          p.value ? `<span class="${valueClass}">${escapeHtml(p.value)}</span>` : ""
        }</div>`,
    )
    .join(ITEM_SEPARATOR_HTML);
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

// === Helper: 附加字段·全局维度——单值展示，样式对齐 Location 单行（图标+值），不带"角色名:"前缀 ===
function buildCustomGlobalFieldHtml(icon, title, value) {
  if (!value) return "";
  return `<div class="pa-field-row">
    <span class="pa-field-icon">${icon}</span>
    <span class="pa-field-value">${escapeHtml(title)}：${escapeHtml(value)}</span>
  </div>`;
}

// === Helper: 附加字段整体渲染——遍历已配置字段，按维度分流到对应样式，某个字段本轮/当前无值时该字段跳过不渲染。
// icon 固定用⭐（附加字段是用户自定义的通用变量，不像 Inventory/Setups 有明确语义，不单独为每个字段做图标选择）。===
function buildCustomFieldsHtml(customFields, customValues, scope) {
  const CUSTOM_FIELD_ICON = "⭐";
  return customFields
    .filter((f) => f.scope === scope)
    .map((f) => {
      const value = customValues ? customValues[f.name] : "";
      if (!value) return "";
      return scope === "global"
        ? buildCustomGlobalFieldHtml(CUSTOM_FIELD_ICON, f.name, value)
        : buildKeyValueBlockHtml(CUSTOM_FIELD_ICON, f.name, value);
    })
    .filter(Boolean)
    .join("");
}

// === 主函数：字段对象 → 完整卡片 HTML 字符串。
// fields.relationships/inventory/setups：调用方按需传入——最新一层楼传状态表当前完整状态，
// 其余楼层传该层原文自己的增量变化，本函数不关心来源，只负责渲染。
// busyNames 是可选的"当前忙碌名单"（只有最新一层楼的卡片会传入非空值，见 beautifyOneMessageEl），
// 不来自 fields.busy——楼层原文里的 Busy 字段只会是正文AI写的 [REMOVE] 清除信号，没有展示价值。===
export function buildSummaryCardHtml(fields, busyNames = []) {
  const parts = [];
  const customFields = getCustomFields();

  if (fields.location) {
    parts.push(`<div class="pa-field-row">
      <span class="pa-field-icon">📍</span>
      <span class="pa-field-value">${escapeHtml(fields.location)}</span>
    </div>`);
  }

  parts.push(buildCustomFieldsHtml(customFields, fields.custom, "global"));

  if (fields.relationships) parts.push(buildRelationshipsRowsHtml(fields.relationships));
  if (fields.inventory) parts.push(buildKeyValueBlockHtml("🎒", "物品", fields.inventory, true));
  parts.push(buildCustomFieldsHtml(customFields, fields.custom, "character"));
  if (fields.setups) parts.push(buildKeyValueBlockHtml("🧩", "伏笔", fields.setups));

  const busyHtml = buildBusyRowsHtml(busyNames);
  if (busyHtml) parts.push(busyHtml);

  if (fields.expiredChapter) {
    parts.push(`<div class="pa-plain-row">
      <span class="pa-field-icon">📕</span>「${escapeHtml(fields.expiredChapter)}」已完结
    </div>`);
  }

  if (fields.overview) parts.push(buildOverviewBlockHtml(fields.overview));

  // pa-collapsed 初始类由全局偏好决定，保证历史楼层重新扫描/新楼层生成时天然跟上次的
  // 展开/收拢选择一致；点击后的即时同步另见 initSummaryBeautify 里的委托点击事件。
  const collapsedClass = getSummaryCardCollapsed() ? " pa-collapsed" : "";
  return `<div class="${CARD_CLASS}${collapsedClass}">
    ${buildCardHeaderHtml(fields.time)}
    <div class="pa-card-body">${parts.join("")}</div>
  </div>`;
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
// snapshot 为 null（世界书还没创建/条目不存在）时，最新层也照常回退到该层原文的解析结果。
//
// force：默认 false，此时维持原有行为——一旦 <details> 被换成卡片就不会再被二次处理，
// 避免 replaceWith 触发的 DOM 变化反过来被 MutationObserver 捕获、形成无意义的重复替换/死循环。
// force=true 时，即便这条消息已经是卡片（不再有 <details>），也会按当前最新数据强制重新渲染一次——
// 只在明确知道"数据源已经变化、需要让已渲染的卡片跟上"的场景下由调用方主动传 true
// （目前只有 rerenderLatestSummaryCard 会传 true，且只处理最新一层楼，其余历史楼层不受影响，
// 因为历史楼层展示的是各自楼层原文当时的增量，跟"之后"状态表/附加字段配置怎么变都无关）。===
function beautifyOneMessageEl(mesEl, lastAiIdx, snapshot, force = false) {
  const mesTextEl = mesEl.querySelector(".mes_text");
  if (!mesTextEl) return;

  const detailsEl = findSummaryDetailsEl(mesTextEl);
  const existingCardEl = detailsEl ? null : mesTextEl.querySelector(`.${CARD_CLASS}`);
  if (!detailsEl && !existingCardEl) return; // 没有摘要块
  if (!detailsEl && !force) return; // 已经渲染过卡片，且不是强制刷新，维持"只处理一次"的原有行为

  const targetEl = detailsEl || existingCardEl;

  const mesIdRaw = mesEl.getAttribute("mesid");
  const mesId = mesIdRaw !== null ? parseInt(mesIdRaw, 10) : NaN;
  let rawMes = null;
  if (!isNaN(mesId)) {
    const chat = getCtx().chat;
    rawMes = Array.isArray(chat) && chat[mesId] ? chat[mesId].mes : null;
  }
  // 拿不到 mesid/原文时（极端情况），首次渲染可以退回读取 DOM 里 <details> 的纯文本内容做兜底解析；
  // 强制重渲染已生成的卡片时 <details> 已经不存在，没有原文就没法安全重建，直接跳过。
  const sourceText =
    typeof rawMes === "string" ? rawMes : detailsEl ? detailsEl.outerHTML : null;
  if (!sourceText) return;

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
          custom: snapshot.custom,
        }
      : fields;
  const busyNames = isLatest && snapshot ? snapshot.busyNames : [];

  const wrapper = document.createElement("div");
  wrapper.innerHTML = buildSummaryCardHtml(displayFields, busyNames);
  targetEl.replaceWith(wrapper.firstElementChild);
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

// === 对外入口：强制刷新"最新一层AI楼层"的卡片——供状态表LLM结果整合完毕之后调用。
// 只处理最新一层，不影响其余历史楼层（历史楼层展示的是各自当层原文的增量，本来就跟
// "之后"状态表怎么变化无关，不需要跟着刷新）。找不到最新层/世界书还没有状态表条目时静默跳过。===
export async function rerenderLatestSummaryCard() {
  try {
    const chatEl = document.getElementById("chat");
    if (!chatEl) return;
    const { idx: lastAiIdx } = getLastAiFloor();
    if (lastAiIdx < 0) return;
    const mesEl = chatEl.querySelector(`.mes[mesid="${lastAiIdx}"]`);
    if (!mesEl) return;
    const snapshot = await fetchStatusTableSnapshot();
    beautifyOneMessageEl(mesEl, lastAiIdx, snapshot, true);
  } catch (error) {
    console.error("[剧情助手] 强制刷新最新楼层摘要卡片时出错:", error);
  }
}

// === 对外入口：状态表LLM 进度提示——非阻塞悬浮胶囊，不带关闭按钮（半透明、不遮挡任何点击，
// 用户不需要主动关它）。show 调用是幂等的（已存在就不重复创建），hide 同理（不存在就什么都不做），
// 三种收尾场景（正常结束/状态表LLM调用失败被内部吞掉/用户抢先发下一条打断）都直接调用 hide 即可，
// 不需要调用方关心当前是不是已经显示。===
const STATUS_LLM_INDICATOR_ID = "pa-status-llm-indicator";

export function showStatusLlmIndicator() {
  try {
    if (document.getElementById(STATUS_LLM_INDICATOR_ID)) return;
    const el = document.createElement("div");
    el.id = STATUS_LLM_INDICATOR_ID;
    el.className = "pa-status-llm-indicator";
    el.textContent = "状态表生成中···";
    document.body.appendChild(el);
  } catch (error) {
    console.error("[剧情助手] 显示状态表LLM进度提示时出错:", error);
  }
}

export function hideStatusLlmIndicator() {
  try {
    const el = document.getElementById(STATUS_LLM_INDICATOR_ID);
    if (el) el.remove();
  } catch (error) {
    console.error("[剧情助手] 隐藏状态表LLM进度提示时出错:", error);
  }
}

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

  // 顶栏点击展开/收拢：用事件委托挂在 #chat 上一次性注册，而不是每张卡片单独挂监听——
  // 卡片是随聊天记录变化不断重新生成/替换的（见 beautifyOneMessageEl），委托到常驻的 #chat
  // 容器上可以让新卡片天然可用，不用在每次生成卡片后额外补一次 addEventListener。
  // 点击后：(1) 立即同步应用到"当前聊天里所有已渲染的卡片"（包括历史楼层，不止点的那一张）；
  // (2) 把新状态存进全局偏好（见 setSummaryCardCollapsed），下次生成/重新扫描出的卡片
  // （含切换对话、刷新页面后重新渲染的历史楼层）会在 buildSummaryCardHtml 里读到这份偏好，
  // 天然保持一致，不需要逐层单独记忆。
  chatEl.addEventListener("click", (event) => {
    const header = event.target.closest(".pa-card-header");
    if (!header) return;
    const card = header.closest(`.${CARD_CLASS}`);
    if (!card) return;
    const collapsed = !card.classList.contains("pa-collapsed");
    chatEl.querySelectorAll(`.${CARD_CLASS}`).forEach((el) => {
      el.classList.toggle("pa-collapsed", collapsed);
    });
    setSummaryCardCollapsed(collapsed);
  });

  // 插件加载/切换到已有聊天时，先手动跑一次，不用等下一次 DOM 变化才触发
  scanAndBeautifyAll();
}
