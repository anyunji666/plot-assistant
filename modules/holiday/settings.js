"use strict";

import { extension_settings } from "../../../../../extensions.js"; // 同级参照 modules/phone/store.js 的路径深度

// =====================================================================================
// 节假日模块 - 设置读写：开关状态 + 假期预设原文 + 自定义节假日原文，存进 extension_settings
// （全局设置，随酒馆账号走，不跟随单个角色卡/对话），风格跟 mobile-opt.js 一致。
//
// restPresetText / customHolidaysRawText 都是"原样存原文"，不在保存时转换成结构化数据：
// - restPresetText 用法跟"私信预设"一样，整段文字直接拼进注入内容，不做任何解析；
// - customHolidaysRawText 是"## 分组\n日期 名称"这种多行文本，每次要用的时候（面板回显/生成注入内容时）
//   现场调用 modules/holiday/calc.js 的 parseCustomHolidaysText() 解析，这样文本框回显永远是用户
//   原始输入的样子（保留他自己写的 9/9、6.1、12-25 等不同日期写法），不会被重新格式化成统一样式。
// =====================================================================================

export const HOLIDAY_SETTINGS_KEY = "plot_assistant_holiday";

export function getHolidaySettings() {
  if (!extension_settings[HOLIDAY_SETTINGS_KEY]) {
    extension_settings[HOLIDAY_SETTINGS_KEY] = {
      enabled: false,
      restPresetText: "",
      customHolidaysRawText: "",
    };
  }
  const s = extension_settings[HOLIDAY_SETTINGS_KEY];
  if (typeof s.enabled !== "boolean") s.enabled = false;
  if (typeof s.restPresetText !== "string") s.restPresetText = "";
  if (typeof s.customHolidaysRawText !== "string") s.customHolidaysRawText = "";
  return s;
}

export function getHolidayEnabled() {
  return getHolidaySettings().enabled;
}

export function setHolidayEnabledSetting(enabled) {
  getHolidaySettings().enabled = !!enabled;
}

export function getRestPresetText() {
  return getHolidaySettings().restPresetText;
}

export function setRestPresetText(text) {
  getHolidaySettings().restPresetText = String(text ?? "");
}

export function getCustomHolidaysRawText() {
  return getHolidaySettings().customHolidaysRawText;
}

export function setCustomHolidaysRawText(text) {
  getHolidaySettings().customHolidaysRawText = String(text ?? "");
}
