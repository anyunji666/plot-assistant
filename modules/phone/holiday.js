"use strict";

import { HOLIDAY_SLOT_PROMPT_KEY, getCtx } from "../core.js";
import { getLastAiFloor } from "./parser.js";
import { parseFloorSummaryFields } from "../summary/parser.js";

// =====================================================================================
// 星期/节假日播报：从"正文最新一层摘要模块的 Time 字段"解析出当前公历日期，
// 生成 <holiday_judgment>YYYY年M月D日 是 星期X（附近节假日提示）</holiday_judgment>，
// 生成前临时注入正文、渲染完这一轮立即清空（一次性，不常驻），跟私信槽位是同一种用法，
// 但彼此独立：不依赖通讯器模块是否开启，也不走 pending/persist 那一套状态机——
// 每轮都用当前最新的 Time 字段重新纯计算一遍，算不出来就完全不注入。
// =====================================================================================

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"]; // Date.getDay(): 0=周日

// 世界通用节日（中文），固定 月/日
const WORLD_HOLIDAYS = [
  { month: 1, day: 1, name: "元旦" },
  { month: 2, day: 14, name: "情人节" },
  { month: 5, day: 1, name: "国际劳动节" },
  { month: 10, day: 31, name: "万圣节" },
  { month: 12, day: 24, name: "平安夜" },
  { month: 12, day: 25, name: "圣诞节" },
  { month: 12, day: 31, name: "跨年夜" },
];

// 日本节日（日文），固定 月/日的部分。注意：元日 1/1 按"撞日期优先世界通用节日"的规则，
// 永远会被上面的"元旦"先命中，这条本来就不会被输出，所以不重复录入，避免维护两份重复数据。
const JAPAN_HOLIDAYS_FIXED = [
  { month: 2, day: 3, name: "節分" },
  { month: 3, day: 14, name: "ホワイトデー" },
  { month: 5, day: 5, name: "こどもの日" },
  { month: 7, day: 7, name: "七夕" },
  { month: 11, day: 3, name: "文化の日" },
];

// お盆：区间型节日，8/13~8/16，不参与"逐日匹配"，单独判断逻辑见 checkObon()。
const OBON_START = { month: 8, day: 13 };
const OBON_END = { month: 8, day: 16 };
const OBON_NAME = "お盆";

// 日本浮动日期节日：{ month, weekday(1=周一), nth, name }
const JAPAN_FLOATING_HOLIDAY_DEFS = [
  { month: 1, weekday: 1, nth: 2, name: "成人の日" },
  { month: 10, weekday: 1, nth: 2, name: "スポーツの日" },
];

// === Helper: 某年某月的"第 n 个周 weekday"是几号（weekday: 1=周一...0=周日，跟 Date.getDay() 一致）===
function nthWeekdayOfMonth(year, month, weekday, nth) {
  const firstOfMonth = new Date(year, month - 1, 1);
  const firstWeekday = firstOfMonth.getDay();
  const dayOfFirstOccurrence = 1 + ((weekday - firstWeekday + 7) % 7);
  return dayOfFirstOccurrence + (nth - 1) * 7;
}

// === Helper: 按年份现算日本浮动日期节日的具体 月/日（成人の日/スポーツの日）===
function getJapanFloatingHolidays(year) {
  return JAPAN_FLOATING_HOLIDAY_DEFS.map((def) => ({
    month: def.month,
    day: nthWeekdayOfMonth(year, def.month, def.weekday, def.nth),
    name: def.name,
  }));
}

// === Helper: 日历意义上的"加 N 天"（会正确处理跨月/跨年进位，不是给 day 数字直接 +N）===
function addDays(date, n) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + n);
  return result;
}

function sameMonthDay(date, month, day) {
  return date.getMonth() + 1 === month && date.getDate() === day;
}

// === Helper: お盆命中判断——
// 当天（offset=0）：date 本身是否落在 [8/13, 8/16] 区间内；
// 近1/近2天（offset=1/2）：只在区间"起始日"8/13 恰好是 date 时才提前预告，
// 不对区间内其它日期（8/14~8/16）做提前预告，避免同一个区间被连续三天反复播报。
// 命中时统一返回区间写法的提示句，不区分"当天/预告"。===
function checkObon(date, offset) {
  const isStart = sameMonthDay(date, OBON_START.month, OBON_START.day);
  // お盆的月/日区间本身落在同一个月内（8/13~8/16），用 AND 而不是 OR——
  // 写成 OR 会导致"当月只要 >=13 或者 <=16"两个条件恒有一个成立，等于把整个 8 月都误判成区间内。
  const isWithinRange =
    date.getMonth() + 1 === OBON_START.month &&
    date.getDate() >= OBON_START.day &&
    date.getDate() <= OBON_END.day;
  const hit = offset === 0 ? isWithinRange : isStart;
  if (!hit) return null;
  return `${OBON_START.month}月${OBON_START.day}日- ${OBON_END.month}月${OBON_END.day}日是日本的 ${OBON_NAME}`;
}

// === Helper: 单个具体日期（非区间型）在世界表/日本表里的命中提示句，世界表优先、命中即不再查日本表 ===
function checkSingleDayHoliday(date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();

  const worldHit = WORLD_HOLIDAYS.find((h) => h.month === month && h.day === day);
  if (worldHit) return `${month}月${day}日是${worldHit.name}`;

  const japanList = JAPAN_HOLIDAYS_FIXED.concat(
    getJapanFloatingHolidays(date.getFullYear()),
  );
  const japanHit = japanList.find((h) => h.month === month && h.day === day);
  if (japanHit) return `${month}月${day}日是日本的 ${japanHit.name}`;

  return null;
}

// === Helper: 汇总当天/近1天/近2天的节假日提示，拼成 "（...）" 括注；没有任何命中时返回空字符串。
// 同一 offset 内如果お盆和单日节日同时命中（理论上不会撞，留作扩展节日表时的保险），并排空格连接；
// 不同 offset 之间按 0→1→2 顺序、用顿号连接。===
export function buildHolidaySuffix(date0) {
  const groups = [];
  for (let offset = 0; offset <= 2; offset++) {
    const date = addDays(date0, offset);
    const segments = [];
    const obonSegment = checkObon(date, offset);
    if (obonSegment) segments.push(obonSegment);
    const singleDaySegment = checkSingleDayHoliday(date);
    if (singleDaySegment) segments.push(singleDaySegment);
    if (segments.length > 0) groups.push(segments.join(" "));
  }
  if (groups.length === 0) return "";
  return `（${groups.join("、")}）`;
}

// === Helper: 解析摘要模块 Time 字段原始文本里的公历日期，只认严格锚定开头的三种写法：
// "YYYY年MM月DD日"、"YYYY-MM-DD"、"YYYY/MM/DD"（后面允许跟时辰等其它文字，不要求整段匹配到底）。
// 命中后还要做 Date 往返校验，排除"2024年2月30日"这类日历上不存在的日期。
// 虚构纪年、农历写法、格式不规整统统不会命中上面三条正则，直接返回 null，交由调用方"完全不注入"。===
export function parseStoryDate(timeText) {
  if (!timeText || typeof timeText !== "string") return null;

  const patterns = [
    /^(\d{4})年(\d{1,2})月(\d{1,2})日/,
    /^(\d{4})-(\d{1,2})-(\d{1,2})/,
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})/,
  ];

  for (const pattern of patterns) {
    const match = timeText.match(pattern);
    if (!match) continue;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;

    const date = new Date(year, month - 1, day);
    const isValid =
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day;
    if (!isValid) continue;

    return { year, month, day };
  }

  return null;
}

// === Helper: 拼出完整的 <holiday_judgment> 标签内容；解析不出合法公历日期时返回 null（完全不注入）===
export function buildHolidayTagContent(mesText) {
  const fields = parseFloorSummaryFields(mesText);
  const timeText = fields && fields.time;
  if (!timeText) return null;

  const parsed = parseStoryDate(timeText);
  if (!parsed) return null;

  const date0 = new Date(parsed.year, parsed.month - 1, parsed.day);
  const weekdayLabel = WEEKDAY_LABELS[date0.getDay()];
  const suffix = buildHolidaySuffix(date0);

  return `<holiday_judgment>${parsed.year}年${parsed.month}月${parsed.day}日 是 星期${weekdayLabel}${suffix}</holiday_judgment>`;
}

// ==== 注入 / 清空（独立于通讯器私信槽位，共用同一种 extension prompt 一次性注入的用法）====

export async function applyHolidaySlotPrompt() {
  try {
    const context = getCtx();
    if (typeof context.setExtensionPrompt !== "function") {
      console.warn(
        "[剧情助手] 当前酒馆版本未暴露 setExtensionPrompt，星期/节假日播报未启用。",
      );
      return;
    }
    // 先清空上一轮可能残留的内容，避免"上一层能解析、这一层解析不出"时旧内容继续挂在正文里。
    const position = context.extension_prompt_types?.IN_CHAT ?? 1;
    const role = context.extension_prompt_roles?.SYSTEM ?? 0;
    context.setExtensionPrompt(HOLIDAY_SLOT_PROMPT_KEY, "", position, 0, false, role);

    const { mes } = getLastAiFloor();
    const content = buildHolidayTagContent(mes);
    if (!content) return; // 解析不出合法公历日期，完全不注入

    context.setExtensionPrompt(HOLIDAY_SLOT_PROMPT_KEY, content, position, 0, false, role);
  } catch (error) {
    console.error("[剧情助手] 注入星期/节假日播报时出错:", error);
  }
}

export function clearHolidaySlotPromptAfterRound() {
  try {
    const context = getCtx();
    if (typeof context.setExtensionPrompt === "function") {
      const position = context.extension_prompt_types?.IN_CHAT ?? 1;
      const role = context.extension_prompt_roles?.SYSTEM ?? 0;
      context.setExtensionPrompt(HOLIDAY_SLOT_PROMPT_KEY, "", position, 0, false, role);
    }
  } catch (error) {
    console.error("[剧情助手] 清空星期/节假日播报时出错:", error);
  }
}

// 独立注册，不绑定通讯器模块（私信槽位）是否开启：插件加载即生效，无独立开关。
// GENERATION_STARTED 在部分酒馆版本里可能不存在，找不到时只打印警告、不阻断其它功能。
export function registerHolidayInjection() {
  try {
    const context = getCtx();
    if (!context.eventSource || !context.event_types) {
      console.warn(
        "[剧情助手] 未找到 eventSource/event_types，星期/节假日播报未启用。",
      );
      return;
    }
    const startEventName =
      context.event_types.GENERATION_STARTED ||
      context.event_types.GENERATE_BEFORE_COMBINE_PROMPTS;
    if (startEventName) {
      context.eventSource.on(startEventName, () => {
        applyHolidaySlotPrompt();
      });
    } else {
      console.warn(
        "[剧情助手] 未找到生成开始事件（GENERATION_STARTED），星期/节假日播报未启用，把控制台日志发我调整。",
      );
    }
    const renderEventName =
      context.event_types.CHARACTER_MESSAGE_RENDERED ||
      context.event_types.MESSAGE_RECEIVED;
    if (renderEventName) {
      context.eventSource.on(renderEventName, () => {
        clearHolidaySlotPromptAfterRound();
      });
    }
  } catch (error) {
    console.error("[剧情助手] 注册星期/节假日播报注入监听时出错:", error);
  }
}
