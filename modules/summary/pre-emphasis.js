"use strict";

import { PRE_EMPHASIS_ENTRY_DEFAULTS, PRE_EMPHASIS_TITLE, getCtx } from "../core.js";
import { getFreeUid, getOrCreateSummaryLorebook, notifyWorldInfoUpdated } from "../worldinfo.js";

// =====================================================================================
// === "对话前强调"条目：读取 & 保存 ===
// 从 generator.js 拆出来的独立小功能，跟"设定起始楼层"等命令式逻辑不是一类东西——
// 这里只负责"对话前强调"这一条世界书条目本身的读写，供 ui.js 的编辑面板调用。
// =====================================================================================

// === Helper: 读取"对话前强调"条目当前内容（供打开编辑框时预填） ===
export async function loadPreEmphasisEntry() {
  const lorebookName = await getOrCreateSummaryLorebook();
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  const entries = data && data.entries ? Object.values(data.entries) : [];
  const existing =
    entries.find((entry) => entry.comment === PRE_EMPHASIS_TITLE) || null;
  return { lorebookName, existing };
}


// === Helper: 保存/新建"对话前强调"条目 ===
// 与总结条目不同，这里的"启用/禁用"是用户主动切换的核心状态，每次保存都要写回 disable 字段，
// 不能像 saveOrOverwriteLorebookEntry 那样对已存在条目只更新标题/内容。
export async function savePreEmphasisEntry(content, enabled) {
  const context = getCtx();
  const lorebookName = await getOrCreateSummaryLorebook();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  const existing = Object.values(data.entries).find(
    (entry) => entry.comment === PRE_EMPHASIS_TITLE,
  );

  if (existing) {
    data.entries[existing.uid].content = content;
    data.entries[existing.uid].disable = !enabled;
  } else {
    const newUid = getFreeUid(data);
    if (newUid === null) throw new Error("无法为新世界书条目分配 uid。");
    data.entries[newUid] = {
      uid: newUid,
      comment: PRE_EMPHASIS_TITLE,
      content,
      disable: !enabled,
      constant: true,
      key: [],
      useGroupScoring: false,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 0,
      ...PRE_EMPHASIS_ENTRY_DEFAULTS,
    };
  }

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
  return lorebookName;
}
