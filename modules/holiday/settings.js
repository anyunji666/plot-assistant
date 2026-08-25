"use strict";

import { saveSettingsDebounced } from "../../../../../../script.js";
import { extension_settings } from "../../../../../extensions.js"; // 同级参照 modules/phone/store.js 的路径深度
import { getCtx } from "../core.js";

// =====================================================================================
// 节假日模块 - 设置读写：开关状态 + 假期预设原文 + 自定义节假日原文，存进 extension_settings。
// 跟随"角色卡"分别存储，不同角色卡可以设置不同的节假日；绑定方式照抄 modules/map/data.js
// 的 byCharacter 写法（而不是 worldinfo.js 里会抛错的 getCurrentCharacterName()）：
// 未选中角色卡/群聊场景不报错，退回一份仅当次会话有效的内存兜底对象，不落盘、不污染
// extension_settings，等真正进入某个角色卡的对话后再正常读写该角色名下的数据。
//
// restPresetText / customHolidaysRawText 都是"原样存原文"，不在保存时转换成结构化数据：
// - restPresetText 用法跟"私信预设"一样，整段文字直接拼进注入内容，不做任何解析；
// - customHolidaysRawText 是"## 分组\n日期 名称"这种多行文本，每次要用的时候（面板回显/生成注入内容时）
//   现场调用 modules/holiday/calc.js 的 parseCustomHolidaysText() 解析，这样文本框回显永远是用户
//   原始输入的样子（保留他自己写的 9/9、6.1、12-25 等不同日期写法），不会被重新格式化成统一样式。
// =====================================================================================

export const HOLIDAY_SETTINGS_KEY = "plot_assistant_holiday";

// 未选中角色卡/群聊时的内存兜底数据，仅当次会话有效，不写入 extension_settings。
let transientHolidaySettings = null;

function makeDefaultHolidaySettings() {
  return {
    enabled: false,
    restPresetText: "",
    customHolidaysRawText: "",
  };
}

// 当前角色名；群聊或未选中角色卡时返回 null（不抛错，方便各处直接判空），
// 逻辑照抄 modules/map/data.js 的 getMapCurrentCharacterName()。
function getHolidayCurrentCharacterName() {
  try {
    const context = getCtx();
    if (context.groupId) return null; // 不支持群聊
    const charId = context.characterId;
    if (charId === undefined || charId === null) return null;
    const char = context.characters?.[charId];
    if (!char || !char.name) return null;
    return char.name;
  } catch (e) {
    return null;
  }
}

// extension_settings[HOLIDAY_SETTINGS_KEY] 顶层结构：{ byCharacter: { 角色名: { enabled, restPresetText, customHolidaysRawText } } }
function getHolidayExtRoot() {
  if (!extension_settings[HOLIDAY_SETTINGS_KEY]) {
    extension_settings[HOLIDAY_SETTINGS_KEY] = { byCharacter: {} };
  }
  const root = extension_settings[HOLIDAY_SETTINGS_KEY];
  if (!root.byCharacter) root.byCharacter = {};
  return root;
}

// 取当前角色对应的节假日设置（自动创建默认结构）；未选中角色卡/群聊时退回内存临时数据。
export function getHolidaySettings() {
  const name = getHolidayCurrentCharacterName();
  if (!name) {
    if (!transientHolidaySettings) transientHolidaySettings = makeDefaultHolidaySettings();
    return transientHolidaySettings;
  }
  const root = getHolidayExtRoot();
  if (!root.byCharacter[name]) root.byCharacter[name] = makeDefaultHolidaySettings();
  const s = root.byCharacter[name];
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
  saveSettingsDebounced();
}

export function getRestPresetText() {
  return getHolidaySettings().restPresetText;
}

export function setRestPresetText(text) {
  getHolidaySettings().restPresetText = String(text ?? "");
  saveSettingsDebounced();
}

export function getCustomHolidaysRawText() {
  return getHolidaySettings().customHolidaysRawText;
}

export function setCustomHolidaysRawText(text) {
  getHolidaySettings().customHolidaysRawText = String(text ?? "");
  saveSettingsDebounced();
}
