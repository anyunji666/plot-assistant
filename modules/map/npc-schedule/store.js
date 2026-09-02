"use strict";

import { saveSettingsDebounced } from "../../../../../../../script.js";
import { extension_settings } from "../../../../../../extensions.js";

// =====================================================================================
// === NPC行程LLM：设置层 ===
// 独立于剧情LLM（酒馆当前连接）和状态表LLM之外，专门跑"根据NPC行程资料+当前剧情判断NPC
// 当前所在地点"这一路可选配置。跟状态表LLM同一套思路：apiUrl 留空 = 跟随酒馆当前连接
// （context.generateRaw），非空 = 走本模块自己的 chat/completions 反代请求。
// 明文保存在插件设置里，不做额外加密。
// 这里只保存"连接层面"的配置（全局共享，不分角色卡）；"是否启用"「NPC智能行程」开关
// 和 NPC 行程资料文本按角色卡分别存储，跟着 modules/map/store.js 的 npcScheduleEnabled /
// npcScheduleText 走（原因：那两项是"剧情内容相关的东西"，跟地图数据本身同级更合理）。
// =====================================================================================

export const NPC_SCHEDULE_LLM_SETTINGS_KEY = "plot_assistant_npc_schedule_llm";

const DEFAULT_NPC_SCHEDULE_LLM_SETTINGS = {
  apiUrl: "",
  apiKey: "",
  model: "",
  stream: false,
  apiTimeoutMin: 15,
};

export function getNpcScheduleLlmSettings() {
  if (!extension_settings[NPC_SCHEDULE_LLM_SETTINGS_KEY]) {
    extension_settings[NPC_SCHEDULE_LLM_SETTINGS_KEY] = {};
  }
  const cfg = extension_settings[NPC_SCHEDULE_LLM_SETTINGS_KEY];
  for (const key of Object.keys(DEFAULT_NPC_SCHEDULE_LLM_SETTINGS)) {
    if (cfg[key] === undefined) cfg[key] = DEFAULT_NPC_SCHEDULE_LLM_SETTINGS[key];
  }
  cfg.stream = false; // 固定走非流式（跟状态表LLM一致，本模块也只需要一次性拿到完整JSON结果）
  return cfg;
}

export function saveNpcScheduleLlmSettings() {
  saveSettingsDebounced();
}
