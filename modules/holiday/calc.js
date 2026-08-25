"use strict";

// =====================================================================================
// 节假日模块 - 纯计算部分：日期解析、星期计算、节假日判断。
// 全部是无副作用的纯函数，不碰 extension_settings/eventSource，方便单独跑测试用例。
// =====================================================================================

export const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"]; // Date.getDay(): 0=周日

// 世界通用节日（中文），固定 月/日
export const WORLD_HOLIDAYS = [
  { month: 1, day: 1, name: "元旦" },
  { month: 2, day: 14, name: "情人节" },
  { month: 5, day: 1, name: "国际劳工节" },
  { month: 10, day: 31, name: "万圣节" },
  { month: 12, day: 24, name: "平安夜" },
  { month: 12, day: 25, name: "圣诞节" },
  { month: 12, day: 31, name: "跨年夜" },
];

// 日本节日（日文），固定 月/日的部分。注意：元日 1/1 跟上面世界通用的"元旦"是同一天，
// 没有单独录入这条——避免维护两份指向同一天的重复数据（现在世界表/日本表撞期是并列显示，
// 不是谁覆盖谁，但"元旦"和"元日"本质是同一个新年，没必要真的录两条来回显）。
export const JAPAN_HOLIDAYS_FIXED = [
  { month: 2, day: 3, name: "節分" },
  { month: 3, day: 14, name: "ホワイトデー" },
  { month: 5, day: 5, name: "こどもの日" },
  { month: 7, day: 7, name: "七夕" },
  { month: 11, day: 3, name: "文化の日" },
];

// お盆：区间型节日，8/13~8/16，不参与"逐日匹配"，单独判断逻辑见 checkObon()。
export const OBON_START = { month: 8, day: 13 };
export const OBON_END = { month: 8, day: 16 };
export const OBON_NAME = "お盆";

// 日本浮动日期节日：{ month, weekday(1=周一), nth, name }
export const JAPAN_FLOATING_HOLIDAY_DEFS = [
  { month: 1, weekday: 1, nth: 2, name: "成人の日" },
  { month: 10, weekday: 1, nth: 2, name: "スポーツの日" },
];

// === Helper: 某年某月的"第 n 个周 weekday"是几号（weekday: 1=周一...0=周日，跟 Date.getDay() 一致）===
export function nthWeekdayOfMonth(year, month, weekday, nth) {
  const firstOfMonth = new Date(year, month - 1, 1);
  const firstWeekday = firstOfMonth.getDay();
  const dayOfFirstOccurrence = 1 + ((weekday - firstWeekday + 7) % 7);
  return dayOfFirstOccurrence + (nth - 1) * 7;
}

// === Helper: 按年份现算日本浮动日期节日的具体 月/日（成人の日/スポーツの日）===
export function getJapanFloatingHolidays(year) {
  return JAPAN_FLOATING_HOLIDAY_DEFS.map((def) => ({
    month: def.month,
    day: nthWeekdayOfMonth(year, def.month, def.weekday, def.nth),
    name: def.name,
  }));
}

// === Helper: 日历意义上的"加 N 天"（会正确处理跨月/跨年进位，不是给 day 数字直接 +N）===
export function addDays(date, n) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + n);
  return result;
}

function sameMonthDay(date, month, day) {
  return date.getMonth() + 1 === month && date.getDate() === day;
}

// === Helper: 判断某个 date（当年）是否落在 [startMonth/startDay, endMonth/endDay] 区间内。
// 只按"月日"比较（MM*100+DD）；支持跨年区间（比如 12/25~1/7）——此时 startKey > endKey，
// 命中"起始日期到年末"或"年初到结束日期"任一段即可，不要求 date 落在同一个自然年里。===
function isWithinMonthDayRange(date, startMonth, startDay, endMonth, endDay) {
  const key = (date.getMonth() + 1) * 100 + date.getDate();
  const startKey = startMonth * 100 + startDay;
  const endKey = endMonth * 100 + endDay;
  if (startKey <= endKey) return key >= startKey && key <= endKey; // 同年内区间，逻辑不变
  return key >= startKey || key <= endKey; // 跨年区间：落在"起始~年末"或"年初~结束"任一段即算命中
}

// === Helper: お盆命中判断——
// 当天（offset=0）：date 本身是否落在 [8/13, 8/16] 区间内；
// 近1/近2天（offset=1/2）：只在区间"起始日"8/13 恰好是 date 时才提前预告，
// 不对区间内其它日期（8/14~8/16）做提前预告，避免同一个区间被连续三天反复播报。
// 命中时统一返回区间写法的提示句，不区分"当天/预告"。===
function checkObon(date, offset) {
  const isStart = sameMonthDay(date, OBON_START.month, OBON_START.day);
  const isWithinRange = isWithinMonthDayRange(
    date,
    OBON_START.month,
    OBON_START.day,
    OBON_END.month,
    OBON_END.day,
  );
  const hit = offset === 0 ? isWithinRange : isStart;
  if (!hit) return null;
  return `${OBON_START.month}月${OBON_START.day}日- ${OBON_END.month}月${OBON_END.day}日是日本的 ${OBON_NAME}`;
}

// === Helper: 单个具体日期（非区间型）在世界表/日本表里的命中提示句（不含自定义，自定义单独处理，见下）。
// 世界通用节日和日本内置节日是并列关系，都查一遍、命中的都列出来，不是"谁先命中谁赢"——
// 跟自定义节日和内置表之间现在的"并列显示"规则保持一致。目前两张表里没有实际撞日期的条目
// （日本的"元日"1/1 跟世界通用的"元旦"是同一天，没有收录进 JAPAN_HOLIDAYS_FIXED，避免维护
// 两条指向同一天的重复数据），所以眼下这条分支基本不会触发，但逻辑上留着更严谨、也方便以后
// 万一要收录别的真会撞期的日本节日时不用再改这里。===
function checkBuiltinSingleDayHoliday(date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const segments = [];

  const worldHit = WORLD_HOLIDAYS.find((h) => h.month === month && h.day === day);
  if (worldHit) segments.push(`${month}月${day}日是${worldHit.name}`);

  const japanList = JAPAN_HOLIDAYS_FIXED.concat(
    getJapanFloatingHolidays(date.getFullYear()),
  );
  const japanHit = japanList.find((h) => h.month === month && h.day === day);
  if (japanHit) segments.push(`${month}月${day}日是日本的 ${japanHit.name}`);

  return segments.length > 0 ? segments.join(" ") : null;
}

// === Helper: 自定义节假日命中判断——同时兼容单日型（type: "day"）和区间型（type: "range"）两种条目。
// customHolidays 格式：
//   单日：{ type: "day", month, day, name, region }
//   区间：{ type: "range", startMonth, startDay, endMonth, endDay, name, region }
// region 是任意字符串（比如"日本"、"中国"），为 null/空 时不加前缀；非空时输出"{region}的 {name}"。
// 自定义节假日和内置节日表（世界通用/日本内置/お盆）是并列关系，不是覆盖关系：撞了同一天，两条都显示，
// 具体怎么并列由调用方 buildHolidaySuffix 统一拼接。
// 一个 date 理论上可能同时命中多条自定义（比如单日和区间恰好都在这天），并排空格连接。===
function checkCustomHoliday(date, offset, customHolidays) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const segments = [];

  for (const h of customHolidays || []) {
    if (h.type === "range") {
      const isStart = sameMonthDay(date, h.startMonth, h.startDay);
      const isWithinRange = isWithinMonthDayRange(
        date,
        h.startMonth,
        h.startDay,
        h.endMonth,
        h.endDay,
      );
      const hit = offset === 0 ? isWithinRange : isStart;
      if (!hit) continue;
      const label = h.region ? `${h.region}的 ${h.name}` : h.name;
      segments.push(
        `${h.startMonth}月${h.startDay}日-${h.endMonth}月${h.endDay}日是${label}`,
      );
    } else {
      // 单日型（type: "day"，或历史数据没有 type 字段时默认按单日处理）
      if (h.month !== month || h.day !== day) continue;
      segments.push(h.region ? `${month}月${day}日是${h.region}的 ${h.name}` : `${month}月${day}日是${h.name}`);
    }
  }

  return segments.length > 0 ? segments.join(" ") : null;
}

// === Helper: 汇总当天/近1天/近2天的节假日提示，拼成 "（...）" 括注；没有任何命中时返回空字符串。
// 每个 offset 内，自定义（单日+区间）和内置表（お盆+世界通用/日本内置单日）都各自检查、都不互相排斥——
// 撞了同一天的话，两条会并排都显示（比如内置"12月25日是圣诞节"、自定义"12月25日是公司年会"同时出现），
// 不是谁盖谁；这样自定义节日永远保证会出现，同时不会丢内置节日的信息。
// 不同 offset 之间按 0→1→2 顺序、用顿号连接。
// customHolidays：自定义节假日列表（parseCustomHolidaysText 的 items），默认空数组。===
export function buildHolidaySuffix(date0, customHolidays = []) {
  const groups = [];
  for (let offset = 0; offset <= 2; offset++) {
    const date = addDays(date0, offset);
    const segments = [];

    const obonSegment = checkObon(date, offset);
    if (obonSegment) segments.push(obonSegment);
    const builtinSingleSegment = checkBuiltinSingleDayHoliday(date);
    if (builtinSingleSegment) segments.push(builtinSingleSegment);
    const customSegment = checkCustomHoliday(date, offset, customHolidays);
    if (customSegment) segments.push(customSegment);

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

// === Helper: 某年某月有多少天。用 `new Date(year, month, 0)` 这个技巧——月份传"下一个月"、
// 日期传 0，JS 会自动倒推到"上个月的最后一天"，天然处理闰年 2 月是 28 还是 29 天，
// 不用手写"1/3/5/7/8/10/12 是31天"这种表。month 是 1-12（跟 parseStoryDate 返回值一致）。===
export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// === Helper: 拼出完整的 <holiday_judgment> 标签内容；解析不出合法公历日期时返回 null（完全不注入）。
// restPresetText：假期预设的原文，非空时原样拼在最前面、用"— "（破折号+空格）跟日期部分隔开，
// 不做任何解析，用法跟"私信预设"一样是整段发给AI。哪怕填了假期预设，只要 Time 字段解析不出合法日期，
// 整个标签依然完全不注入，不会单独把这句预设文字注入进去。
// "本月共N天"这条紧跟在星期后面单独一个括注，跟节假日提示的括注分开、不合并，纯计算不会出错，
// 主要是给 LLM 兜底——LLM 容易凭感觉编错"这个月有几天"（比如编出 2月30日、算错闰年），这条信息
// 帮它避免这类低级错误。这条信息不额外做开关判断，天然跟随整个标签是否注入（节假日开关关闭、或
// Time 字段解析不出日期时，调用方根本不会走到这里，自然什么都不发）。===
export function buildHolidayTagContent(timeText, options = {}) {
  const { customHolidays = [], restPresetText = "" } = options;

  const parsed = parseStoryDate(timeText);
  if (!parsed) return null;

  const date0 = new Date(parsed.year, parsed.month - 1, parsed.day);
  const weekdayLabel = WEEKDAY_LABELS[date0.getDay()];
  const monthDays = daysInMonth(parsed.year, parsed.month);
  const suffix = buildHolidaySuffix(date0, customHolidays);
  const trimmedPreset = String(restPresetText ?? "").trim();
  const prefix = trimmedPreset ? `${trimmedPreset}— ` : "";

  return `<holiday_judgment>${prefix}${parsed.year}年${parsed.month}月${parsed.day}日 是 星期${weekdayLabel}（本月共${monthDays}天）${suffix}</holiday_judgment>`;
}

// === Helper: 解析"设置节假日"文本框里的多行自定义节假日文本。
// 格式：
//   ## 分组名              —— 分组头，之后的行都归到这个 region，直到下一个分组头或文本结束；
//                             分组名是"世界"、或者文本开头（第一个分组头之前）不写分组头，都按"世界通用节日"
//                             处理（region: null，输出不加前缀）；其它任意分组名原样当作 region 使用。
//   日期 名称              —— 单日，一行一条，日期支持 9/9、6.1、12-25、6月1日 四种写法（不含年份），
//                             解析为 { type: "day", month, day, name, region }。
//   起始日期~截止日期 名称  —— 区间，比如 8/13~8/16、8.13~8.16、8月13日~8月16日，起止用同一种写法，
//                             解析为 { type: "range", startMonth, startDay, endMonth, endDay, name, region }。
//                             支持跨年区间（比如 12/25~1/7 小学寒假），起始日期按月日比较大于截止日期时
//                             即视为跨年，命中判断见 isWithinMonthDayRange()；跨年区间同样支持临近提前
//                             1/2 天预告（在起始日期前）。
//   名称                   —— 都是日期之后的剩余部分（原样保留，可以带空格）。
// 每行先尝试按区间格式匹配，不匹配再按单日格式匹配，这样即使区间用的是跟单日相同的分隔符（比如 "-"），
// 也不会被单日的正则提前"半匹配"截胡。
// 空行、无法识别的行直接跳过，计入 skipped，不中断后续行的解析。
// 返回 { items: [...], skipped }。===
export function parseCustomHolidaysText(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const items = [];
  let skipped = 0;
  let currentRegion = null; // null = 世界通用节日，不加前缀

  const rangePatterns = [
    /^(\d{1,2})\/(\d{1,2})\s*~\s*(\d{1,2})\/(\d{1,2})\s*(.+)$/,
    /^(\d{1,2})\.(\d{1,2})\s*~\s*(\d{1,2})\.(\d{1,2})\s*(.+)$/,
    /^(\d{1,2})-(\d{1,2})\s*~\s*(\d{1,2})-(\d{1,2})\s*(.+)$/,
    /^(\d{1,2})月(\d{1,2})日\s*~\s*(\d{1,2})月(\d{1,2})日\s*(.+)$/,
  ];
  const dayPatterns = [
    /^(\d{1,2})\/(\d{1,2})\s*(.+)$/,
    /^(\d{1,2})\.(\d{1,2})\s*(.+)$/,
    /^(\d{1,2})-(\d{1,2})\s*(.+)$/,
    /^(\d{1,2})月(\d{1,2})日\s*(.+)$/,
  ];
  // Feb 按 29 放宽（允许录入 2/29 这种闰日节假日），其它月份按正常上限校验。
  const MAX_DAY_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isValidMonthDay = (month, day) =>
    month >= 1 && month <= 12 && day >= 1 && day <= MAX_DAY_IN_MONTH[month - 1];

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return; // 空行不计入 skipped，避免数字虚高

    const groupMatch = trimmed.match(/^##\s*(.+)$/);
    if (groupMatch) {
      const groupName = groupMatch[1].trim();
      currentRegion = groupName === "世界" ? null : groupName || null;
      return;
    }

    // 先按区间格式尝试。注意：只要正则语法上匹配到了"起始~截止"这个形状，就不再回退去尝试单日格式——
    // 否则像 "13/1~1/3 活动"（语法是区间、但月份超范围不合法）会被单日正则的 "(.+)" 兜底吞掉
    // 前半段当日期、后半段当名称存下来，变成一条错误数据。
    // 语法匹配但校验不通过（月日超范围/名称为空）的情况，直接计入 skipped，不再尝试其它格式。
    // 支持跨年区间（比如 12/25~1/7）：不要求 startKey <= endKey，起始 > 截止时视为跨年，
    // 命中判断交给 isWithinMonthDayRange()（区间型）/下面 offset!==0 的分支（提前预告）处理。
    for (const pattern of rangePatterns) {
      const match = trimmed.match(pattern);
      if (!match) continue;
      const startMonth = parseInt(match[1], 10);
      const startDay = parseInt(match[2], 10);
      const endMonth = parseInt(match[3], 10);
      const endDay = parseInt(match[4], 10);
      const name = match[5].trim();
      const isValidRange =
        isValidMonthDay(startMonth, startDay) &&
        isValidMonthDay(endMonth, endDay) &&
        !!name;

      if (isValidRange) {
        items.push({ type: "range", startMonth, startDay, endMonth, endDay, name, region: currentRegion });
      } else {
        skipped += 1;
      }
      return;
    }

    // 没匹配上区间格式，再按单日格式尝试
    for (const pattern of dayPatterns) {
      const match = trimmed.match(pattern);
      if (!match) continue;
      const month = parseInt(match[1], 10);
      const day = parseInt(match[2], 10);
      const name = match[3].trim();
      if (!isValidMonthDay(month, day)) break;
      if (!name) break;

      items.push({ type: "day", month, day, name, region: currentRegion });
      return;
    }

    skipped += 1;
  });

  return { items, skipped };
}
