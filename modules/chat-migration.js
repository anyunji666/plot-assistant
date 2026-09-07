"use strict";

// =====================================================================================
// === 聊天记录迁移（数据管理栏「聊天记录」按钮） ===
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

import { confirmAction, errorCatched, escapeHtml, getCtx, notify } from "./core.js";
import { getCurrentCharacterName } from "./worldinfo.js";
import { rebuildStatusTableFromChat } from "./summary/status-table.js";

export const CHAT_MIGRATION_EXPORT_TYPE = "plot-assistant-chat-export";

// 记住上次弹窗里填的配置（模式/标签/范围/导入方式），下次打开弹窗自动回填，不用每次重填。
// 导出是因为 panel.js「清空数据」按钮要把这份 localStorage 一并清掉。
export const CHAT_MIGRATION_CONFIG_KEY = "plotAssistant_chatMigrationConfig";

// 跟 modules/summary/status-table.js 里 parseFloorSummaryFields 用的同一个摘要块正则保持一致，
// 只取整段（不解析内部字段），保证导出的原文跟解析端的匹配规则不会脱节。
const SUMMARY_DETAILS_RE =
  /<details>\s*<summary>\s*摘要\s*<\/summary>[\s\S]*?<\/details>/;

// === Helper: 从单层 mes 原文里切出摘要块，返回 {summaryBlock, rest}；没有摘要块时 summaryBlock 为空 ===
export function extractSummaryBlock(mesText) {
  const text = mesText || "";
  const match = text.match(SUMMARY_DETAILS_RE);
  if (!match) return { summaryBlock: "", rest: text };
  const summaryBlock = match[0];
  const rest = text.slice(0, match.index) + text.slice(match.index + summaryBlock.length);
  return { summaryBlock, rest };
}

// === Helper: 逗号分隔的标签名输入 -> 去空白、去空项数组 ===
export function parseTagList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// === Helper: 把标签名转成能安全塞进正则里的转义形式 ===
function escapeForRegex(tagName) {
  return tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// === Helper: 从文本里按标签名找出所有 <tag ...>...</tag> 整段（含标签本身），忽略标签上的属性 ===
function extractTagBlocks(text, tagName) {
  const escaped = escapeForRegex(tagName);
  const re = new RegExp(`<${escaped}[^>]*>[\\s\\S]*?<\\/${escaped}>`, "g");
  return text.match(re) || [];
}

// === Helper: 剔除命中标签列表的整段（用于 exclude 模式）===
function removeTagBlocks(text, tagNames) {
  let result = text;
  tagNames.forEach((tag) => {
    extractTagBlocks(result, tag).forEach((block) => {
      result = result.replace(block, "");
    });
  });
  return result.trim();
}

// === Helper: 只保留命中标签列表的整段，按标签在原文里出现的先后顺序拼接（用于 whitelist 模式）===
function keepTagBlocks(text, tagNames) {
  if (tagNames.length === 0) return "";
  const escaped = tagNames.map(escapeForRegex);
  const re = new RegExp(`<(${escaped.join("|")})[^>]*>[\\s\\S]*?<\\/\\1>`, "g");
  const blocks = text.match(re) || [];
  return blocks.join("\n\n").trim();
}

// === Function: 按选中模式，从"去掉摘要块之后剩余的原文"里截取正文 ===
export function buildBody(rest, mode, tagNames) {
  if (mode === "summary_only") return "";
  if (mode === "whitelist") return keepTagBlocks(rest, tagNames);
  return removeTagBlocks(rest, tagNames); // mode === "exclude"（默认）
}

// === Helper: 输入框里的楼层号字符串 -> 非负整数，空/非法输入返回 undefined（代表"不限"）===
export function parseFloorRangeInput(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : undefined;
}

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

// =====================================================================================
// === 弹窗记住的上次配置（localStorage）===
// =====================================================================================

function loadLastChatMigrationConfig() {
  try {
    const raw = localStorage.getItem(CHAT_MIGRATION_CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error("[剧情助手] 读取聊天记录迁移的记忆配置失败:", error);
    return {};
  }
}

function saveLastChatMigrationConfig(config) {
  try {
    localStorage.setItem(CHAT_MIGRATION_CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    console.error("[剧情助手] 保存聊天记录迁移的记忆配置失败:", error);
  }
}

// =====================================================================================
// === 弹窗 UI：仿 openHideFloorDialog / openCustomFieldsDialog 同一套骨架（常驻式，不一次性关闭）===
// =====================================================================================

export function openChatMigrationDialog() {
  const $bodyEl = $("body");
  const prevBodyOverflow = $bodyEl.css("overflow");
  $bodyEl.css("overflow", "hidden");

  const $overlay = $("<div>").css({
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.72)",
    zIndex: 99999,
    boxSizing: "border-box",
  });

  const $box = $("<div>").css({
    position: "fixed",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "#252525",
    border: "1px solid #3a3a3a",
    borderRadius: "10px",
    padding: "clamp(16px, 4vw, 24px)",
    width: "min(440px, calc(100% - 24px))",
    maxHeight: "min(85vh, calc(100dvh - 24px))",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    color: "#e8e8e8",
    fontFamily: "inherit",
    boxSizing: "border-box",
    boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
  });

  const $titleRow = $("<div>").css({
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  });
  const $title = $("<div>").text("聊天记录").css({
    fontSize: "1.05em",
    fontWeight: "600",
    color: "#f0f0f0",
    letterSpacing: "0.01em",
  });
  const $closeBtn = $("<button>").html("&times;").css({
    background: "transparent",
    border: "none",
    color: "#aaa",
    cursor: "pointer",
    fontSize: "20px",
    padding: "0",
    margin: "0",
    lineHeight: "1",
    transition: "color 0.2s",
  });
  $titleRow.append($title, $closeBtn);

  const $desc = $("<div>")
    .text(
      "导出当前聊天的正文+摘要块为一份 JSON 文件，可以拿到另一端导入。摘要块（含状态数据）恒定保留，导入后会自动重建状态表。0层开场白和所有用户楼层始终原样导出，下方模式只对非0层的AI回复楼层生效。",
    )
    .css({ fontSize: "0.8em", color: "#999", lineHeight: 1.5 });

  const inputCss = {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3a3a",
    background: "#ffffff",
    color: "#000000",
    fontSize: "max(0.95em, 16px)",
    fontFamily: "inherit",
    outline: "none",
  };
  const btnCss = {
    padding: "8px 14px",
    borderRadius: "6px",
    boxSizing: "border-box",
    border: "none",
    cursor: "pointer",
    fontSize: "0.85em",
    fontWeight: "600",
    color: "#fff",
    touchAction: "manipulation",
    whiteSpace: "nowrap",
  };

  // === 单选组通用构造 ===
  function buildRadioGroup(name, options, defaultValue) {
    const $group = $("<div>").css({ display: "flex", flexDirection: "column", gap: "8px" });
    options.forEach(([value, label]) => {
      const $label = $("<label>").css({
        display: "flex",
        alignItems: "flex-start",
        gap: "8px",
        fontSize: "0.86em",
        color: "#c0c0c0",
        cursor: "pointer",
        userSelect: "none",
      });
      const $radio = $("<input>")
        .attr({ type: "radio", name })
        .prop("checked", value === defaultValue)
        .val(value)
        .css({ cursor: "pointer", marginTop: "3px" });
      $label.append($radio, $("<span>").text(label));
      $group.append($label);
    });
    return $group;
  }

  const lastConfig = loadLastChatMigrationConfig();

  // === 正文截取模式 ===
  const modeGroupName = "chat-migration-mode";
  const $modeGroup = buildRadioGroup(
    modeGroupName,
    [
      ["summary_only", "仅摘要块 —— 正文整层留空"],
      ["whitelist", "摘要块 + 保留标签块 —— 只保留下方标签命中的整段"],
      ["exclude", "摘要块 + 其它（默认）—— 正文全保留，剔除下方标签命中的整段"],
    ],
    lastConfig.mode || "exclude",
  );

  const $tagWrap = $("<div>").css({ display: "flex", flexDirection: "column", gap: "4px" });
  const $tagLabel = $("<label>").css({ fontSize: "0.82em", color: "#999" });
  const $tagInput = $("<input>").attr({ type: "text", placeholder: "如 thinking,ooc" }).css(inputCss);
  if (lastConfig.tags) $tagInput.val(lastConfig.tags);
  $tagWrap.append($tagLabel, $tagInput);

  function syncTagWrapToMode() {
    const mode = $modeGroup.find("input:checked").val();
    if (mode === "summary_only") {
      $tagWrap.css("display", "none");
    } else if (mode === "whitelist") {
      $tagWrap.css("display", "flex");
      $tagLabel.text("保留标签（逗号分隔，只有命中的标签块会被保留为正文）");
    } else {
      $tagWrap.css("display", "flex");
      $tagLabel.text("排除标签（逗号分隔，命中的标签块会从正文里剔除，留空则整层原样保留）");
    }
  }
  $modeGroup.find("input").on("change", syncTagWrapToMode);
  syncTagWrapToMode();

  // === 导出楼层范围（可选）===
  const $rangeWrap = $("<div>").css({ display: "flex", flexDirection: "column", gap: "4px" });
  const $rangeLabel = $("<label>")
    .text("导出楼层范围（可选，留空导出全部；起始/结束都是楼层号，含首尾）")
    .css({ fontSize: "0.82em", color: "#999" });
  const $rangeInputRow = $("<div>").css({ display: "flex", gap: "8px", alignItems: "center" });
  const $rangeStartInput = $("<input>")
    .attr({ type: "number", min: "0", placeholder: "起始" })
    .css({ ...inputCss, width: "auto", flex: "1" });
  const $rangeSep = $("<span>").text("—").css({ color: "#999" });
  const $rangeEndInput = $("<input>")
    .attr({ type: "number", min: "0", placeholder: "结束" })
    .css({ ...inputCss, width: "auto", flex: "1" });
  if (Number.isFinite(lastConfig.rangeStart)) $rangeStartInput.val(lastConfig.rangeStart);
  if (Number.isFinite(lastConfig.rangeEnd)) $rangeEndInput.val(lastConfig.rangeEnd);
  $rangeInputRow.append($rangeStartInput, $rangeSep, $rangeEndInput);
  $rangeWrap.append($rangeLabel, $rangeInputRow);

  // === 导出按钮 ===
  const $exportBtn = $("<button>").text("导出为文件").css({ ...btnCss, background: "#3a7bd5" });

  // === 导入方式 ===
  const $importModeDivider = $("<div>").css({ borderTop: "1px solid #3a3a3a", margin: "4px 0" });
  const importModeGroupName = "chat-migration-import-mode";
  const $importModeGroup = buildRadioGroup(
    importModeGroupName,
    [
      ["overwrite", "覆盖当前聊天（默认，整份替换，不可撤销）"],
      ["merge", "按楼层号合并更新（推荐配合“导出楼层范围”做增量同步）"],
      ["newchat", "导入为新聊天（新建一个聊天，不影响当前聊天）"],
    ],
    lastConfig.importMode || "overwrite",
  );

  const $importBtn = $("<button>").text("选择文件导入").css({ ...btnCss, background: "#c0392b" });
  const $importFileInput = $('<input type="file" accept=".json,application/json">').css({ display: "none" });
  const $btnRow = $("<div>").css({ display: "flex", gap: "8px", flexWrap: "wrap" });
  $btnRow.append($exportBtn, $importBtn, $importFileInput);

  $box.append($titleRow, $desc, $modeGroup, $tagWrap, $rangeWrap, $importModeDivider, $importModeGroup, $btnRow);
  $overlay.append($box);
  $("body").append($overlay);

  const close = () => {
    $(document).off("keydown.chatMigrationDialog");
    $overlay.remove();
    $bodyEl.css("overflow", prevBodyOverflow || "");
  };

  $closeBtn
    .on("click", () => close())
    .hover(
      function () {
        $(this).css("color", "#fff");
      },
      function () {
        $(this).css("color", "#aaa");
      },
    );

  let overlayPointerDownOnSelf = false;
  $overlay.on("mousedown touchstart", (e) => {
    overlayPointerDownOnSelf = $(e.target).is($overlay);
  });
  $overlay.on("mouseup touchend", (e) => {
    if (overlayPointerDownOnSelf && $(e.target).is($overlay)) close();
    overlayPointerDownOnSelf = false;
  });
  $(document).on("keydown.chatMigrationDialog", (e) => {
    if (e.key === "Escape") close();
  });

  // === 记住当前弹窗里的配置，供下次打开时回填 ===
  function persistCurrentConfig(extra) {
    saveLastChatMigrationConfig({
      mode: $modeGroup.find("input:checked").val(),
      tags: $tagInput.val(),
      rangeStart: parseFloorRangeInput($rangeStartInput.val()) ?? null,
      rangeEnd: parseFloorRangeInput($rangeEndInput.val()) ?? null,
      importMode: $importModeGroup.find("input:checked").val(),
      ...extra,
    });
  }

  $exportBtn.on(
    "click",
    errorCatched(async () => {
      const mode = $modeGroup.find("input:checked").val();
      const tagsRaw = $tagInput.val();
      const rangeStart = parseFloorRangeInput($rangeStartInput.val());
      const rangeEnd = parseFloorRangeInput($rangeEndInput.val());

      const issues = checkChatMigrationIssues(mode, tagsRaw, rangeStart, rangeEnd);
      if (issues.length > 0) {
        const issueHtml = issues.map((msg) => `• ${escapeHtml(msg)}`).join("<br><br>");
        const proceed = await confirmAction("导出前检测到以下问题", `${issueHtml}<br><br>是否仍然导出？`);
        if (!proceed) return;
      }

      const count = downloadChatMigrationExport(mode, tagsRaw, rangeStart, rangeEnd);
      notify("success", `已导出 ${count} 层楼的聊天记录。`);
      persistCurrentConfig();
    }),
  );

  $importBtn.on("click", () => $importFileInput.trigger("click"));

  $importFileInput.on("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = errorCatched(async (ev) => {
      const rawText = ev.target.result;

      // 提前瞄一眼文件是不是"范围导出"：如果是，且用户还停在默认的"覆盖当前聊天"，
      // 自动切换成"按楼层号合并更新"并提示一下，避免手滑用局部数据整份覆盖掉当前聊天。
      let peekData = null;
      try {
        peekData = JSON.parse(rawText);
      } catch (error) {
        peekData = null;
      }
      const isPeekRangeExport = peekData && (Number.isFinite(peekData.rangeStart) || Number.isFinite(peekData.rangeEnd));
      let importMode = $importModeGroup.find("input:checked").val();
      if (isPeekRangeExport && importMode === "overwrite") {
        importMode = "merge";
        $importModeGroup.find('input[value="merge"]').prop("checked", true);
        notify("info", "检测到这是范围导出文件，已自动切换为「按楼层号合并更新」。");
      }

      const count = await importChatMigrationFromText(rawText, importMode);
      if (count === null) return; // 用户在某个确认弹窗里点了取消
      notify("success", `已处理 ${count} 层楼，状态表已同步重建。`);
      persistCurrentConfig({ importMode });
      close();
    });
    reader.onerror = () => {
      notify("error", "读取文件失败，请重试。");
    };
    reader.readAsText(file, "utf-8");
    $importFileInput.val("");
  });

  [$exportBtn, $importBtn].forEach(($btn) => {
    $btn.hover(
      function () {
        $(this).css("opacity", 0.85);
      },
      function () {
        $(this).css("opacity", 1);
      },
    );
  });
}
