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
  pendingMetaInstruction: "", // 面板"字段修改"弹窗提交的一次性元指令：只在下一次实际调用状态表LLM时拼进请求末尾，发出后（无论调用成功与否）立即清空，不重复发送
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

// 取值方式/维度的中文标签，UI 展示和 TXT 导入导出共用同一份映射，避免两处各写一份互相漂移。
export const CUSTOM_FIELD_VALUE_TYPE_LABEL = { numeric: "数值", text: "文本" };
export const CUSTOM_FIELD_SCOPE_LABEL = { character: "角色", global: "全局" };
// 上面两份的反向映射（中文标签 -> 内部值），导入解析时用。
const CUSTOM_FIELD_VALUE_TYPE_BY_LABEL = { 数值: "numeric", 文本: "text" };
const CUSTOM_FIELD_SCOPE_BY_LABEL = { 角色: "character", 全局: "global" };

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

// === Function: 控制面板"清空数据"专用——清空所有角色卡绑定的附加字段定义 ===
// 附加字段跟着角色卡走（byCharacter），不属于全局连接配置（apiUrl/apiKey/model/customPrompt），
// 但内容上属于"剧情内容相关的本地缓存"，"清空数据"按钮应当一并清掉，覆盖所有角色卡，
// 而不只是当前选中的这一个；同时把未选中角色卡时的内存兜底数组也一并重置，避免清空后
// 立刻又在没选角色卡的场景下看到清空前残留的临时数据。
export function clearAllCustomFieldsAcrossCharacters() {
  const settings = getStatusLlmSettings();
  settings.byCharacter = {};
  transientCustomFields = null;
  saveSettingsDebounced();
}

// =====================================================================================
// === 附加字段 TXT 导入/导出（面板"附加字段"弹窗新增按钮） ===
// 导出：当前角色卡下全部字段 -> 纯文本，每字段一块，块间空一行：
//   [字段名]
//   取值方式：数值/文本
//   维度：角色/全局
//   提取依据：单行说明
// 导入：同名字段覆盖更新（保留原 id），新名字段新增；不合法的块（字段名为空/内置字段名/
// 取值方式或维度不认识）直接跳过、不中断整体导入，最终把跳过明细一并返回给调用方展示。
// =====================================================================================

// === Function: 把当前角色卡下的全部附加字段序列化成导入导出用的纯文本 ===
export function exportCustomFieldsText() {
  const fields = getCustomFields();
  return fields
    .map((field) => {
      const valueTypeLabel = CUSTOM_FIELD_VALUE_TYPE_LABEL[field.valueType] || field.valueType;
      const scopeLabel = CUSTOM_FIELD_SCOPE_LABEL[field.scope] || field.scope;
      return `[${field.name}]\n取值方式：${valueTypeLabel}\n维度：${scopeLabel}\n提取依据：${field.rule || ""}`;
    })
    .join("\n\n");
}

// === Helper: 解析导出格式的文本，按 "[字段名]" 起头切块 ===
// 提取依据允许跨行书写（比如用户手动编辑文件时加了换行），解析时会折成"；"，
// 跟面板手动保存时对 rule 的清洗规则保持一致，不会因为导入导出一趟就产生格式差异。
function parseCustomFieldsExportText(text) {
  const blockRe = /\[(.+?)\]\s*\r?\n取值方式[：:]\s*(.*?)\s*\r?\n维度[：:]\s*(.*?)\s*\r?\n提取依据[：:]\s*([\s\S]*?)(?=\r?\n\s*\r?\n\[|\r?\n\[|$)/g;
  const blocks = [];
  let match;
  while ((match = blockRe.exec(text || "")) !== null) {
    const [, rawName, rawValueType, rawScope, rawRule] = match;
    blocks.push({
      name: rawName.trim(),
      valueTypeLabel: rawValueType.trim(),
      scopeLabel: rawScope.trim(),
      rule: rawRule.replace(/\s*\r?\n+\s*/g, "；").replace(/`/g, "'").trim(),
    });
  }
  return blocks;
}

// === Function: 从导出格式的文本批量导入附加字段（写入当前角色卡） ===
// 同名覆盖更新（沿用原 id，不改变已有引用），不同名新增；文件内部若有重复字段名，
// 以后出现的为准。非法块（字段名空/内置字段名/取值方式或维度不认识）跳过并计入 skipped，
// 不中断其余块的导入。全部处理完只调用一次 saveSettingsDebounced。
export function importCustomFieldsText(text) {
  const blocks = parseCustomFieldsExportText(text);
  if (blocks.length === 0) {
    throw new Error(
      "未解析到任何字段，请检查格式：每个字段需以「[字段名]」另起一行开头。",
    );
  }

  // 文件内部同名去重，后出现的覆盖先出现的（Map 保序，最后 values() 顺序=最后一次出现的位置）。
  const dedupedByName = new Map();
  const skipped = [];
  for (const block of blocks) {
    if (!block.name) {
      skipped.push({ name: "(空)", reason: "字段名不能为空" });
      continue;
    }
    if (RESERVED_FIELD_NAMES.has(block.name)) {
      skipped.push({ name: block.name, reason: "是内置字段名" });
      continue;
    }
    const valueType = CUSTOM_FIELD_VALUE_TYPE_BY_LABEL[block.valueTypeLabel];
    if (!valueType) {
      skipped.push({ name: block.name, reason: `取值方式"${block.valueTypeLabel}"无法识别` });
      continue;
    }
    const scope = CUSTOM_FIELD_SCOPE_BY_LABEL[block.scopeLabel];
    if (!scope) {
      skipped.push({ name: block.name, reason: `维度"${block.scopeLabel}"无法识别` });
      continue;
    }
    dedupedByName.set(block.name, { name: block.name, valueType, scope, rule: block.rule });
  }

  const list = getCustomFieldsListRef();
  let created = 0;
  let overwritten = 0;

  for (const field of dedupedByName.values()) {
    const existing = list.find((f) => f.name === field.name);
    if (existing) {
      existing.valueType = field.valueType;
      existing.scope = field.scope;
      existing.rule = field.rule;
      overwritten++;
    } else {
      list.push({
        id: `cf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: field.name,
        valueType: field.valueType,
        scope: field.scope,
        rule: field.rule,
      });
      created++;
    }
  }

  saveSettingsDebounced();
  return { created, overwritten, skipped, total: blocks.length };
}
