"use strict";

import { saveSettingsDebounced } from "../../../../../../../script.js";
import { extension_settings } from "../../../../../../extensions.js";
import { getCtx } from "../../core.js";

// =====================================================================================
// === 状态表LLM：设置层 ===
// 独立于剧情LLM（酒馆当前连接）之外，专门跑 Inventory/Setups 提取的一路可选配置。
// 跟"摘要提取"（novel-summary）同一套思路：apiUrl 留空 = 跟随酒馆当前连接
// （context.generateRaw），非空 = 走本模块自己的 chat/completions 反代请求。
// 明文保存在插件设置里，不做额外加密。
//
// API配置（地址/Key/模型/自定义提示词/再分析开关）是连接层面的东西，保持全局共享；
// 附加字段定义（customFields）是剧情内容相关的东西，按"角色卡"分别存储——
// 绑定方式照抄 modules/holiday/settings.js 的 byCharacter 写法：未选中角色卡/群聊场景
// 不报错，退回一份仅当次会话有效的内存兜底对象，不落盘、不污染 extension_settings。
// =====================================================================================

export const STATUS_LLM_SETTINGS_KEY = "plot_assistant_status_llm";

const DEFAULT_STATUS_LLM_SETTINGS = {
  apiUrl: "",
  apiKey: "",
  model: "",
  stream: true,
  apiTimeoutMin: 15,
  customPrompt: "", // 空 = 使用 DEFAULT_STATUS_LLM_PROMPT
  reanalyzeEnabled: true, // 面板"再分析"开关：默认开启，Inventory/Setups 完全依赖这次AI提取才能进状态表，关掉的话这两项永远不会更新，属于影响最大的开关，所以默认打开
};

export function getStatusLlmSettings() {
  if (!extension_settings[STATUS_LLM_SETTINGS_KEY]) {
    extension_settings[STATUS_LLM_SETTINGS_KEY] = {};
  }
  const cfg = extension_settings[STATUS_LLM_SETTINGS_KEY];
  for (const key of Object.keys(DEFAULT_STATUS_LLM_SETTINGS)) {
    if (cfg[key] === undefined) cfg[key] = DEFAULT_STATUS_LLM_SETTINGS[key];
  }
  if (!cfg.byCharacter) cfg.byCharacter = {};
  return cfg;
}

export function saveStatusLlmSettings() {
  saveSettingsDebounced();
}

// =====================================================================================
// === 附加字段（面板"附加字段"按钮新增功能，按角色卡分别存储） ===
// 让使用者自己起字段名+写提取规则，动态拼进状态表LLM的提示词、动态解析AI返回、动态合并进状态表，
// 不用改代码就能加新的LLM控制变量。每条定义：
//   { id, name, valueType: "numeric" | "text", scope: "character" | "global", rule }
// valueType 决定合并语义（numeric=+N/-N/=N/[REMOVE] 数值增减；text=整条文本覆盖）；
// scope 决定是否按角色区分（character="角色名: 值"多角色分号分隔；global=不分角色，全局只有一个值）
// ——注意这个 scope 是"状态表里角色维度 vs 全局维度"，跟这里"按角色卡存储字段定义"是两个不同维度的概念，
// 不要混淆：字段定义本身跟着角色卡走，而每条定义内部还可以再选是否要按状态表里的角色细分取值。
// 具体提示词拼接见 prompts.js 的 buildCustomFieldsAppendix，合并逻辑见 status-table.js。
// =====================================================================================

// 内置字段名，附加字段不能与之重名，避免解析/合并时互相冲突。
export const RESERVED_FIELD_NAMES = new Set([
  "Time",
  "Location",
  "Relationships",
  "Inventory",
  "Setups",
  "Busy",
  "ExpiredChapter",
  "Overview",
]);

// 未选中角色卡/群聊时的内存兜底数据，仅当次会话有效，不写入 extension_settings。
let transientCustomFields = null;

// 当前角色名；群聊或未选中角色卡时返回 null（不抛错，方便各处直接判空），
// 逻辑照抄 modules/holiday/settings.js 的 getHolidayCurrentCharacterName()。
function getCustomFieldsCurrentCharacterName() {
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

// 供 UI 提示文案使用：当前角色名，未选中角色卡/群聊时给个占位文案而不是 null，
// 方便直接拼进弹窗提示语里，不需要调用方再判空。
export function getCustomFieldsCharacterLabel() {
  return getCustomFieldsCurrentCharacterName() || "（未选中角色卡）";
}

// 取当前角色卡对应的附加字段列表（数组引用，可直接 push/splice 修改）；
// 未选中角色卡/群聊时退回内存临时数组，不落盘。
function getCustomFieldsListRef() {
  const name = getCustomFieldsCurrentCharacterName();
  if (!name) {
    if (!transientCustomFields) transientCustomFields = [];
    return transientCustomFields;
  }
  const settings = getStatusLlmSettings();
  if (!settings.byCharacter[name]) settings.byCharacter[name] = { customFields: [] };
  if (!Array.isArray(settings.byCharacter[name].customFields)) {
    settings.byCharacter[name].customFields = [];
  }
  return settings.byCharacter[name].customFields;
}

export function getCustomFields() {
  return getCustomFieldsListRef();
}

// === Function: 新增或编辑一条附加字段定义（有 field.id 走编辑，否则新增）===
// 校验：字段名不能为空、不能与内置字段重名、不能与当前角色卡下其它附加字段重名（编辑自己除外）。
// 返回最新的 customFields 数组，供调用方直接刷新列表展示。
export function saveCustomField(field) {
  const name = (field?.name || "").trim();
  if (!name) throw new Error("字段名不能为空");
  if (RESERVED_FIELD_NAMES.has(name)) {
    throw new Error(`"${name}" 是内置字段名，不能使用`);
  }
  const list = getCustomFieldsListRef();
  const isDuplicate = list.some(
    (f) => f.name === name && f.id !== field.id,
  );
  if (isDuplicate) throw new Error(`字段名 "${name}" 已存在`);

  const valueType = field.valueType === "text" ? "text" : "numeric";
  const scope = field.scope === "global" ? "global" : "character";
  const rule = (field.rule || "").trim();

  if (field.id) {
    const idx = list.findIndex((f) => f.id === field.id);
    if (idx === -1) throw new Error("未找到要编辑的字段，可能已被删除");
    list[idx] = { ...list[idx], name, valueType, scope, rule };
  } else {
    list.push({
      id: `cf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      valueType,
      scope,
      rule,
    });
  }
  saveSettingsDebounced();
  return list;
}

export function deleteCustomField(id) {
  const list = getCustomFieldsListRef();
  const idx = list.findIndex((f) => f.id === id);
  if (idx !== -1) list.splice(idx, 1);
  saveSettingsDebounced();
  return list;
}
