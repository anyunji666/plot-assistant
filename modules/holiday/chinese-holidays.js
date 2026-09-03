"use strict";

import { lunarToSolar, qingmingDate } from "./lunar/lunar-convert.js";

// =====================================================================================
// 中国传统节日 —— 农历固定月日写死在这里，运行时用 lunar-convert.js 的转换算法
// 现算成任意年份对应的公历日期（清明是节气，单独用近似公式算，不是农历月日）。
// 法定/非法定都收录：区分只是给人看的注释，插件行为上一视同仁、都在同一张表里查。
// =====================================================================================

// 农历固定月日的节日（清明不在这里，见下面 getChineseHolidays 里单独处理）
export const CHINESE_LUNAR_HOLIDAYS_FIXED = [
  { lunarMonth: 1, lunarDay: 1, name: "春节" }, // 法定
  { lunarMonth: 1, lunarDay: 15, name: "元宵" }, // 非法定
  { lunarMonth: 5, lunarDay: 5, name: "端午" }, // 法定
  { lunarMonth: 7, lunarDay: 7, name: "七夕" }, // 非法定
  { lunarMonth: 8, lunarDay: 15, name: "中秋" }, // 法定
  { lunarMonth: 9, lunarDay: 9, name: "重阳" }, // 非法定
  { lunarMonth: 12, lunarDay: 8, name: "腊八" }, // 非法定
];

export const QINGMING_NAME = "清明"; // 法定，节气型，不是固定农历月日
export const CHUXI_NAME = "除夕"; // 法定（春节假期通常从除夕算起），也不是固定农历月日

// === Helper: 某农历年腊月最后一天是廿九还是三十，不是固定的——取决于腊月是大月(30天)还是
// 小月(29天)。所以除夕不适合像其它节日一样写死"腊月xx"，而是直接取"该年春节公历日期 − 1 天"，
// 这样不管腊月是大月小月都自动对，也不用额外查一次月份天数。传入的 solarDate 是已经算好的
// 公历 { year, month, day }，用 UTC 记账做"减一天"，避免时区/夏令时干扰，只取年月日结果。===
function subtractOneDay(solarDate) {
  const ms = Date.UTC(solarDate.year, solarDate.month - 1, solarDate.day) - 86400000;
  const result = new Date(ms);
  return { year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() };
}

// === Helper: 把"农历 Y 年"换算成公历，如果落在目标公历年就采用；否则尝试"农历 Y-1 年"。
// 原因：农历新年常年出现在公历 1 月下旬~2 月，腊八也常年落在公历 12 月或跨到次年 1 月初，
// "农历 Y 年"和"公历 Y 年"不是简单对齐的——比如公历 2027 年 1 月的腊八，其实是农历 2026 年
// 腊月初八换算过来的。所以每个节日分别用农历 targetYear 和 targetYear-1 去转换，
// 取换算结果公历年份等于 targetYear 的那一个，避免出现"某年缺春节/腊八"或算到错误年份。===
function resolveToTargetSolarYear(lunarMonth, lunarDay, targetSolarYear) {
  for (const lunarYear of [targetSolarYear, targetSolarYear - 1]) {
    const solar = lunarToSolar(lunarYear, lunarMonth, lunarDay);
    if (solar && solar.year === targetSolarYear) return solar;
  }
  return null;
}

/**
 * 按公历年份现算当年的中国传统节日（农历固定节日 + 除夕 + 清明），返回 { month, day, name } 列表。
 * @param {number} solarYear 公历年，如 2026
 * @returns {{month:number, day:number, name:string}[]}
 */
export function getChineseHolidays(solarYear) {
  const result = [];
  let springFestivalSolar = null;

  for (const def of CHINESE_LUNAR_HOLIDAYS_FIXED) {
    const solar = resolveToTargetSolarYear(def.lunarMonth, def.lunarDay, solarYear);
    if (solar) {
      result.push({ month: solar.month, day: solar.day, name: def.name });
      if (def.name === "春节") springFestivalSolar = solar; // 顺手记一下，供除夕复用
    }
  }

  // 除夕 = 春节前一天。理论上春节非常靠近 1 月初的极端年份会导致除夕跨到上一个公历年，
  // 这种情况下不强行把它塞进当年结果——跟这里其它节日"只在目标年出现一次"的规则保持一致。
  if (springFestivalSolar) {
    const chuxi = subtractOneDay(springFestivalSolar);
    if (chuxi.year === solarYear) result.push({ month: chuxi.month, day: chuxi.day, name: CHUXI_NAME });
  }

  const qingming = qingmingDate(solarYear);
  if (qingming) result.push({ month: qingming.month, day: qingming.day, name: QINGMING_NAME });

  return result;
}
