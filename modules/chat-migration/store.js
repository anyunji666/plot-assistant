"use strict";

// =====================================================================================
// === 聊天记录迁移 · 弹窗记住的上次配置（localStorage）===
// =====================================================================================

// 记住上次弹窗里填的配置（模式/标签/范围/导入方式），下次打开弹窗自动回填，不用每次重填。
// 导出是因为 panel.js「清空数据」按钮要把这份 localStorage 一并清掉。
export const CHAT_MIGRATION_CONFIG_KEY = "plotAssistant_chatMigrationConfig";

export function loadLastChatMigrationConfig() {
  try {
    const raw = localStorage.getItem(CHAT_MIGRATION_CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error("[剧情助手] 读取聊天记录迁移的记忆配置失败:", error);
    return {};
  }
}

export function saveLastChatMigrationConfig(config) {
  try {
    localStorage.setItem(CHAT_MIGRATION_CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    console.error("[剧情助手] 保存聊天记录迁移的记忆配置失败:", error);
  }
}
