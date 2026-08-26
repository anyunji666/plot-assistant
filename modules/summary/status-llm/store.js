"use strict";

import { saveSettingsDebounced } from "../../../../../../../script.js";
import { extension_settings } from "../../../../../../extensions.js";

// =====================================================================================
// === 状态表LLM：设置层 ===
// 独立于剧情LLM（酒馆当前连接）之外，专门跑 Inventory/Setups 提取的一路可选配置。
// 跟"摘要提取"（novel-summary）同一套思路：apiUrl 留空 = 跟随酒馆当前连接
// （context.generateRaw），非空 = 走本模块自己的 chat/completions 反代请求。
// 明文保存在插件设置里，不做额外加密。
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
  return cfg;
}

export function saveStatusLlmSettings() {
  saveSettingsDebounced();
}
