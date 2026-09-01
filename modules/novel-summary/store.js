"use strict";

import { saveSettingsDebounced } from "../../../../../../script.js";
import { extension_settings } from "../../../../../extensions.js";

// =====================================================================================
// === 摘要提取（原独立扩展 novel-summary，现合并进剧情助手）：设置层 ===
// 与原插件一致，仍然把 API 地址/Key/模型/提示词等全部存进 extension_settings，
// 明文保存，不做额外加密——本模块处于测试阶段，暂不考虑旧数据迁移。
// 额外新增 navbarVisible 字段：控制顶部导航栏「小说摘要提取」图标的显隐，
// 默认关闭，只有在控制面板「摘要提取」按钮的确认弹窗里选"是"才会打开。
// =====================================================================================

export const NOVEL_SUMMARY_SETTINGS_KEY = "plot_assistant_novel_summary";

// 分段原文/摘要进度的 IndexedDB 库名，需跟 lib/novel-idb.js 里 DB_NAME 保持一致，
// 仅供控制面板"清空数据"按钮统一删库使用。
export const NOVEL_SUMMARY_IDB_NAME = "novel-summary-db";

const DEFAULT_NOVEL_SUMMARY_SETTINGS = {
  navbarVisible: false, // 默认不在顶部导航栏显示图标
  // 默认留空：未设置 API 地址时，跟"自动小总结"一样跟随酒馆当前对话连接（context.generateRaw），
  // 只有明确填写了 chat/completions 兼容端点后，才会走本模块自己的反代请求。
  apiUrl: "",
  apiKey: "",
  model: "",
  stream: false,
  apiTimeoutMin: 15,
  apiRateLimit: 3,
  chunkKb: 100,
  customPrompt: "",
};

export function getNovelSummarySettings() {
  if (!extension_settings[NOVEL_SUMMARY_SETTINGS_KEY]) {
    extension_settings[NOVEL_SUMMARY_SETTINGS_KEY] = {};
  }
  const cfg = extension_settings[NOVEL_SUMMARY_SETTINGS_KEY];
  for (const key of Object.keys(DEFAULT_NOVEL_SUMMARY_SETTINGS)) {
    if (cfg[key] === undefined) cfg[key] = DEFAULT_NOVEL_SUMMARY_SETTINGS[key];
  }
  return cfg;
}

export function saveNovelSummarySettings() {
  saveSettingsDebounced();
}

// 控制面板"清空数据"按钮点清空时，这几项不跟着清：API 地址/Key/模型/自定义提示词。
// 提示词想恢复默认的话，用户自己在"摘要提示词（可自定义）"弹窗里点"恢复默认"按钮即可，
// 不需要靠"清空数据"这种大范围操作顺带清掉。
const NOVEL_SUMMARY_KEYS_PRESERVED_ON_CLEAR = ["apiUrl", "apiKey", "model", "customPrompt"];

// === Function: "清空数据"专用——只把导航栏显隐/流式/超时/限速/分段大小这些行为类设置还原为默认值，
// API 地址/Key/模型/自定义提示词保留不动 ===
// 复用上面 DEFAULT_NOVEL_SUMMARY_SETTINGS 这份默认值，不在调用方另起一份，避免以后改默认值时两处不同步。
export function resetNovelSummaryBehaviorSettings() {
  const cfg = getNovelSummarySettings();
  for (const key of Object.keys(DEFAULT_NOVEL_SUMMARY_SETTINGS)) {
    if (NOVEL_SUMMARY_KEYS_PRESERVED_ON_CLEAR.includes(key)) continue;
    cfg[key] = DEFAULT_NOVEL_SUMMARY_SETTINGS[key];
  }
  saveSettingsDebounced();
}

export function isNovelSummaryNavbarVisible() {
  return !!getNovelSummarySettings().navbarVisible;
}

// 由「摘要提取」按钮的确认弹窗调用：写入设置并立即持久化。
export function setNovelSummaryNavbarVisible(visible) {
  getNovelSummarySettings().navbarVisible = !!visible;
  saveSettingsDebounced();
}
