"use strict";

// =====================================================================================
// === 聊天记录迁移 · 记住"最近一次导出/导入"的楼层范围（localStorage）===
// =====================================================================================

// 弹窗本身不再记忆上次填的模式/标签/范围/导入方式——每次打开都是默认选项。
// 这里只记两个东西：最近一次实际导出的楼层区间、最近一次实际导入的楼层区间，
// 供弹窗打开时在按钮旁边展示"最近一次 导出/导入：xx-xx"。
// 导出是因为 panel.js「清空数据」按钮要把这份 localStorage 一并清掉。
export const CHAT_MIGRATION_CONFIG_KEY = "plotAssistant_chatMigrationConfig";

function loadState() {
  try {
    const raw = localStorage.getItem(CHAT_MIGRATION_CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error("[剧情助手] 读取聊天记录迁移的记忆状态失败:", error);
    return {};
  }
}

function saveState(state) {
  try {
    localStorage.setItem(CHAT_MIGRATION_CONFIG_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("[剧情助手] 保存聊天记录迁移的记忆状态失败:", error);
  }
}

// === 最近一次导出的楼层区间：{start, end} 或 null（从没导出过）===
export function loadLastExportRange() {
  const state = loadState();
  return state.lastExportRange && Number.isFinite(state.lastExportRange.start) && Number.isFinite(state.lastExportRange.end)
    ? state.lastExportRange
    : null;
}

export function saveLastExportRange(start, end) {
  const state = loadState();
  state.lastExportRange = { start, end };
  saveState(state);
}

// === 最近一次导入的楼层区间：{start, end} 或 null（从没导入过）===
export function loadLastImportRange() {
  const state = loadState();
  return state.lastImportRange && Number.isFinite(state.lastImportRange.start) && Number.isFinite(state.lastImportRange.end)
    ? state.lastImportRange
    : null;
}

export function saveLastImportRange(start, end) {
  const state = loadState();
  state.lastImportRange = { start, end };
  saveState(state);
}
