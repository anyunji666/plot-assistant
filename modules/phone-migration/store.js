"use strict";

// =====================================================================================
// === 私信数据迁移 · 记住"最近一次导出/导入"的时间戳（localStorage）===
// =====================================================================================

// 导出是因为 panel.js「清空数据」按钮要把这份 localStorage 一并清掉。
export const PHONE_MIGRATION_STATE_KEY = "plotAssistant_phoneMigrationState";

function loadState() {
  try {
    const raw = localStorage.getItem(PHONE_MIGRATION_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error("[剧情助手] 读取私信数据迁移的记忆状态失败:", error);
    return {};
  }
}

function saveState(state) {
  try {
    localStorage.setItem(PHONE_MIGRATION_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("[剧情助手] 保存私信数据迁移的记忆状态失败:", error);
  }
}

// === 最近一次导出/导入的时间（ISO 字符串），从没操作过返回 null ===
export function loadLastPhoneExportAt() {
  const state = loadState();
  return typeof state.lastExportAt === "string" ? state.lastExportAt : null;
}

export function saveLastPhoneExportAt(iso) {
  const state = loadState();
  state.lastExportAt = iso;
  saveState(state);
}

export function loadLastPhoneImportAt() {
  const state = loadState();
  return typeof state.lastImportAt === "string" ? state.lastImportAt : null;
}

export function saveLastPhoneImportAt(iso) {
  const state = loadState();
  state.lastImportAt = iso;
  saveState(state);
}
