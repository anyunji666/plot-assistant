"use strict";

// =====================================================================================
// === 聊天记录迁移 · 导出/导入业务逻辑 ===
// 用途：PC 和移动端不是同一份酒馆账号/后端时，把当前聊天的正文+摘要块打包成一份 JSON，
// 拿到另一端导入。
//
// 每层楼的 mes 原文里，摘要块固定是 <details><summary>摘要</summary>...</details>
// （里面还嵌着 status-llm-fields 标记），这部分是状态表重建的唯一依据，导出时恒定保留、
// 不受下面"正文怎么截取"的模式影响；导入后会自动调用 rebuildStatusTableFromChat()
// 重新生成"状态表"世界书条目，不需要额外导出/导入世界书条目本身。
//
// 正文截取三选一：
//   summary_only —— 只要摘要块，正文整层留空
//   whitelist    —— 只保留标签列表命中的 <标签>...</标签> 整段（含标签本身），标签名是"保留清单"
//   exclude      —— 默认：正文全保留，命中标签列表的 <标签>...</标签> 整段被剔除，标签名是"排除清单"
//
// 导出楼层范围（可选）：留空导出全部；填了起始/结束楼层号后，只导出这个区间。
// 范围导出的文件里会带上 rangeStart/rangeEnd，导入时据此识别"这是一份局部数据"。
//
// 导入方式三选一：
//   overwrite —— 全量覆盖当前聊天（整份替换，不可撤销）
//   merge     —— 按楼层号合并更新：文件里带的楼层号，在当前聊天范围内的只覆盖 mes，
//                超出范围的追加到末尾，配合"范围导出"做增量同步
//   newchat   —— 给当前角色新建一个空聊天再导入，不影响当前正在用的聊天
// 如果检测到导入的文件是"范围导出"生成的，但用户选的是 overwrite，会额外弹一次警告
// （范围文件拿去全量覆盖，会把范围外的楼层全部冲掉）。
// =====================================================================================

import { confirmAction, getCtx } from "../core.js";
import { getCurrentCharacterName } from "../worldinfo.js";
import { rebuildStatusTableFromChat } from "../summary/status-table.js";
import { buildBody, escapeForRegex, extractSummaryBlock, parseTagList } from "./parser.js";

export const CHAT_MIGRATION_EXPORT_TYPE = "plot-assistant-chat-export";

// === Function: 扫描当前聊天，按模式/标签/范围拆成 floors，同时收集"标签未闭合/提取结果为空"等问题 ===
// 不直接对外暴露：导出真正落盘的数据（buildChatMigrationExport）和导出前的预检查
// （checkChatMigrationIssues）复用同一份扫描逻辑，避免两边规则慢慢跑偏。
function computeFloorsAndIssues(mode, tagNames, rangeStart, rangeEnd) {
  const context = getCtx();
  const chat = context.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    throw new Error("当前没有可导出的聊天记录。");
  }

  const hasRange = Number.isFinite(rangeStart) || Number.isFinite(rangeEnd);
  const start = Number.isFinite(rangeStart) ? rangeStart : 0;
  const end = Number.isFinite(rangeEnd) ? rangeEnd : chat.length - 1;

  const issues = [];
  if (mode === "whitelist" && tagNames.length === 0) {
    issues.push(
      "保留标签列表是空的：所有非开场白/非用户楼层的正文都会导出为空（只保留摘要块），效果等同于「仅摘要块」模式。",
    );
  }

  const floors = [];
  chat.forEach((message, index) => {
    if (hasRange && (index < start || index > end)) return;

    const mesText = (message && message.mes) || "";
    const isUser = !!(message && message.is_user);
    const name = (message && message.name) || "";

    // 0层开场白 + 所有用户楼层：不套用任何模式/标签规则，整层原文原样导出。
    if (index === 0 || isUser) {
      floors.push({ index, isUser, name, body: mesText, summaryBlock: "" });
      return;
    }

    const { summaryBlock, rest } = extractSummaryBlock(mesText);
    const body = buildBody(rest, mode, tagNames);

    if (tagNames.length > 0) {
      tagNames.forEach((tag) => {
        const escaped = escapeForRegex(tag);
        const openCount = (rest.match(new RegExp(`<${escaped}(?:[^>]*)>`, "g")) || []).length;
        const closeCount = (rest.match(new RegExp(`<\\/${escaped}>`, "g")) || []).length;
        if (openCount !== closeCount) {
          issues.push(
            `第 ${index} 层：标签 <${tag}> 数量不配对（开始标签 ${openCount} 个，结束标签 ${closeCount} 个），提取结果可能被截断。`,
          );
        }
      });
      if (mode === "whitelist" && rest.trim() && !body) {
        issues.push(
          `第 ${index} 层：这层正文不是空的，但没有命中任何保留标签，导出后这层正文会变成空，建议检查标签名是否填对。`,
        );
      }
    }

    floors.push({ index, isUser, name, body, summaryBlock });
  });

  if (floors.length === 0) {
    throw new Error(hasRange ? "指定的楼层范围内没有可导出的聊天记录，请检查范围填写。" : "当前没有可导出的聊天记录。");
  }

  return { floors, issues, hasRange, start, end };
}

// === Function: 导出前预检查，返回问题列表（不阻断导出，交给用户自己判断要不要继续）===
export function checkChatMigrationIssues(mode, tagsRaw, rangeStart, rangeEnd) {
  const tagNames = parseTagList(tagsRaw);
  const { issues } = computeFloorsAndIssues(mode, tagNames, rangeStart, rangeEnd);
  return issues;
}

// === Function: 汇总当前聊天（或指定楼层范围），逐层拆成 {index, isUser, name, body, summaryBlock} ===
export function buildChatMigrationExport(mode, tagsRaw, rangeStart, rangeEnd) {
  const tagNames = parseTagList(tagsRaw);
  const { floors, hasRange, start, end } = computeFloorsAndIssues(mode, tagNames, rangeStart, rangeEnd);
  return {
    type: CHAT_MIGRATION_EXPORT_TYPE,
    version: 2,
    characterName: getCurrentCharacterName() || "",
    mode,
    tags: tagNames,
    // 没指定范围时是 null，代表这是一份"全量导出"；导入端靠这两个字段识别"局部数据"。
    rangeStart: hasRange ? start : null,
    rangeEnd: hasRange ? end : null,
    exportedAt: new Date().toISOString(),
    floors,
  };
}

// === Function: 触发导出 JSON 文件下载，返回导出的楼层数 ===
export function downloadChatMigrationExport(mode, tagsRaw, rangeStart, rangeEnd) {
  const data = buildChatMigrationExport(mode, tagsRaw, rangeStart, rangeEnd);
  const text = JSON.stringify(data, null, 2);
  const safeName = data.characterName || "未命名";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const rangeTag = data.rangeStart !== null ? `-第${data.rangeStart}-${data.rangeEnd}层` : "";
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `聊天记录-${safeName}${rangeTag}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return data.floors.length;
}

// === Helper: 文件里的 floors -> 完整的酒馆消息对象数组（用于 overwrite / newchat 两种整份写入的场景）===
function buildMessagesFromFloors(floors, context) {
  return floors.map((floor) => {
    const body = typeof floor.body === "string" ? floor.body : "";
    const summaryBlock = typeof floor.summaryBlock === "string" ? floor.summaryBlock : "";
    const mes = body && summaryBlock ? `${body}\n${summaryBlock}` : `${body}${summaryBlock}`;
    const isUser = !!floor.isUser;
    return {
      name: floor.name || (isUser ? context.name1 : context.name2) || "",
      is_user: isUser,
      is_system: false,
      send_date: Date.now(),
      mes,
      extra: {},
    };
  });
}

// === Helper: 导入完成后统一收尾（存盘 + 刷新聊天界面 + 重建状态表）===
async function finishImport(context) {
  await context.saveChat();
  if (typeof context.reloadCurrentChat === "function") {
    await context.reloadCurrentChat();
  } else {
    if (typeof context.clearChat === "function") context.clearChat();
    if (typeof context.printMessages === "function") context.printMessages();
  }
  await rebuildStatusTableFromChat();
}

// === Function: 全量覆盖当前聊天 ===
async function overwriteChatMigrationFloors(data) {
  const confirmed = await confirmAction(
    "导入聊天记录 · 全量覆盖",
    `即将导入「${data.characterName || "未知角色"}」的聊天记录（共 ${data.floors.length} 层）。<br><b>这会覆盖当前聊天的全部内容，且不可撤销</b>，建议先自行备份当前聊天。确定继续吗？`,
  );
  if (!confirmed) return null;

  const context = getCtx();
  const newMessages = buildMessagesFromFloors(data.floors, context);
  context.chat.length = 0;
  newMessages.forEach((m) => context.chat.push(m));

  await finishImport(context);
  return newMessages.length;
}

// === Function: 按楼层号合并更新——文件里带的楼层号在当前聊天范围内的只覆盖 mes，超出范围的追加到末尾 ===
// 主要配合"范围导出"做增量同步：另一端只改了后面几层，就只导出那几层，回来合并进当前聊天，
// 不用整份覆盖冲掉双方各自的进度。
async function mergeChatMigrationFloors(data) {
  const context = getCtx();
  const chat = context.chat;
  if (!Array.isArray(chat)) {
    throw new Error("当前没有可合并的聊天记录，请先在当前角色下打开一个聊天。");
  }

  const sortedFloors = [...data.floors].sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));

  // 先扫一遍找"是否用户发言"跟当前聊天对不上的楼层——说明两边聊天已经分叉，
  // 提前告诉用户，而不是静默覆盖掉可能是完全不同内容的那一层。
  const mismatches = [];
  sortedFloors.forEach((floor) => {
    const idx = Number(floor.index);
    if (!Number.isFinite(idx) || idx < 0 || idx >= chat.length) return;
    const existingIsUser = !!(chat[idx] && chat[idx].is_user);
    if (existingIsUser !== !!floor.isUser) mismatches.push(idx);
  });

  const updateCount = sortedFloors.filter((f) => {
    const idx = Number(f.index);
    return Number.isFinite(idx) && idx >= 0 && idx < chat.length;
  }).length;
  const appendCount = sortedFloors.length - updateCount;
  const mismatchNote =
    mismatches.length > 0
      ? `<br><br>⚠️ 第 ${mismatches.join("、")} 层的"是否用户发言"跟当前聊天里的记录对不上，两边聊天内容可能已经分叉。继续会强制按文件内容覆盖这些层。`
      : "";

  const confirmed = await confirmAction(
    "按楼层号合并更新",
    `即将把「${data.characterName || "未知角色"}」文件里的 ${sortedFloors.length} 层合并进当前聊天：覆盖已有的 ${updateCount} 层正文，追加 ${appendCount} 层新楼层。${mismatchNote}<br><br>此操作不可撤销，建议先自行备份当前聊天。确定继续吗？`,
  );
  if (!confirmed) return null;

  sortedFloors.forEach((floor) => {
    const idx = Number(floor.index);
    if (!Number.isFinite(idx) || idx < 0) return;
    const isUser = !!floor.isUser;
    const body = typeof floor.body === "string" ? floor.body : "";
    const summaryBlock = typeof floor.summaryBlock === "string" ? floor.summaryBlock : "";
    const mes = body && summaryBlock ? `${body}\n${summaryBlock}` : `${body}${summaryBlock}`;

    if (idx < chat.length) {
      // 只覆盖正文/发言人/是否用户三个字段，保留这一层原有的其他字段（swipes、extra 等）不动。
      chat[idx].mes = mes;
      chat[idx].name = floor.name || chat[idx].name || (isUser ? context.name1 : context.name2) || "";
      chat[idx].is_user = isUser;
    } else {
      // 超出当前长度的楼层追加到末尾；文件里楼层号不连续时不额外补空楼层，按追加顺序处理。
      chat.push({
        name: floor.name || (isUser ? context.name1 : context.name2) || "",
        is_user: isUser,
        is_system: false,
        send_date: Date.now(),
        mes,
        extra: {},
      });
    }
  });

  await finishImport(context);
  return sortedFloors.length;
}

// === Function: 给当前角色新建一个空聊天，再把文件内容整份写进去；不影响当前正在使用的聊天 ===
async function importChatMigrationAsNewChat(data) {
  const confirmed = await confirmAction(
    "导入为新聊天",
    `即将为当前角色新建一个聊天，导入「${data.characterName || "未知角色"}」的聊天记录（共 ${data.floors.length} 层）。<b>不会影响当前正在使用的聊天</b>。确定继续吗？`,
  );
  if (!confirmed) return null;

  const context = getCtx();
  if (typeof context.executeSlashCommandsWithOptions !== "function") {
    throw new Error("当前酒馆版本不支持新建聊天指令（executeSlashCommandsWithOptions 不可用），请改用「覆盖当前聊天」或「按楼层号合并更新」。");
  }
  // /newchat 是酒馆内置斜杠指令：给当前角色新建一个空聊天并切换过去，不动原有的聊天文件。
  await context.executeSlashCommandsWithOptions("/newchat silent=true");

  const contextAfter = getCtx();
  if (!Array.isArray(contextAfter.chat)) {
    throw new Error("新建聊天失败，请手动新建一个聊天后重试，或改用其他导入方式。");
  }
  const newMessages = buildMessagesFromFloors(data.floors, contextAfter);
  contextAfter.chat.length = 0;
  newMessages.forEach((m) => contextAfter.chat.push(m));

  await finishImport(contextAfter);
  return newMessages.length;
}

// === Function: 解析导入文件文本，按选定的导入方式处理，最后重建状态表 ===
// 返回处理的楼层数；用户在确认弹窗里点了"取消"则返回 null。
export async function importChatMigrationFromText(rawText, importMode = "overwrite") {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    throw new Error("文件不是有效的 JSON 格式，无法解析。");
  }
  if (!data || data.type !== CHAT_MIGRATION_EXPORT_TYPE || !Array.isArray(data.floors)) {
    throw new Error("文件格式不是本插件导出的聊天记录，无法导入。");
  }
  if (data.floors.length === 0) {
    throw new Error("文件里没有任何楼层数据，无需导入。");
  }

  const isRangeExport = Number.isFinite(data.rangeStart) || Number.isFinite(data.rangeEnd);
  if (isRangeExport && importMode === "overwrite") {
    const proceedAnyway = await confirmAction(
      "范围导出文件 · 全量覆盖警告",
      `这份文件只包含第 ${data.rangeStart ?? 0} - ${data.rangeEnd ?? "末尾"} 层（共 ${data.floors.length} 层），是"范围导出"生成的。<br><b>用它做全量覆盖会导致范围外的楼层全部丢失</b>。<br>建议改用「按楼层号合并更新」或「导入为新聊天」。仍要继续全量覆盖吗？`,
    );
    if (!proceedAnyway) return null;
  }

  if (importMode === "merge") return await mergeChatMigrationFloors(data);
  if (importMode === "newchat") return await importChatMigrationAsNewChat(data);
  return await overwriteChatMigrationFloors(data);
}
