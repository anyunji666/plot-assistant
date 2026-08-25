"use strict";

import { extension_settings } from "../../../../../extensions.js"; // 同级参照 holiday/settings.js 的路径深度

// =====================================================================================
// 提示词模板联动模块 - 设置读写：只有一个开关状态，存进 extension_settings（全局设置，
// 随酒馆账号走，不跟随单个角色卡/对话），风格跟 holiday/settings.js 一致。
//
// stageVarSyncEnabled 控制的是 modules/summary/parser.js 里 syncRelationshipStagesToVariables()
// 是否执行 /setvar 同步"阶段_角色名"变量——真正的同步逻辑写在 parser.js（跟状态表解析耦合较深，
// 依赖同文件内的 getCtx()/extractOtherPartyName()，没有挪过来的必要），这里只存一个开关值，
// 关闭时该函数直接跳过 /setvar，不影响状态表本身的解析/落盘。
// 默认关闭：没装 ST-Prompt-Template 扩展的人不会被无意义地跑一堆 /setvar 命令。
// =====================================================================================

export const PROMPT_TEMPLATE_SETTINGS_KEY = "plot_assistant_prompt_template";

export function getPromptTemplateSettings() {
  if (!extension_settings[PROMPT_TEMPLATE_SETTINGS_KEY]) {
    extension_settings[PROMPT_TEMPLATE_SETTINGS_KEY] = {
      stageVarSyncEnabled: false,
    };
  }
  const s = extension_settings[PROMPT_TEMPLATE_SETTINGS_KEY];
  if (typeof s.stageVarSyncEnabled !== "boolean") s.stageVarSyncEnabled = false;
  return s;
}

export function getPromptTemplateStageSyncEnabled() {
  return getPromptTemplateSettings().stageVarSyncEnabled;
}

export function setPromptTemplateStageSyncEnabledSetting(enabled) {
  getPromptTemplateSettings().stageVarSyncEnabled = !!enabled;
}
