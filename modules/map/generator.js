"use strict";

import { MAP_INFO_ENTRY_DEFAULTS, MAP_INFO_TITLE } from "../core.js";
import {
  getOrCreateSummaryLorebook,
  lorebookEntryExists,
  saveOrOverwriteLorebookEntry,
} from "../worldinfo.js";
import { getMapCurrentCharacterName, getSettings } from "./store.js";

// ============================================================
// AI 上下文注入
// ============================================================

// 把大地图路线列表拼成完整的行动描述句子数组，过滤掉引用了已删除标记的脏数据
export function buildRouteSummaryList(bigMap) {
  const markerById = Object.fromEntries(bigMap.markers.map((m) => [m.id, m]));
  return (bigMap.routes || [])
    .map((r) => {
      const from = markerById[r.fromId];
      const to = markerById[r.toId];
      if (!from || !to) return null;

      const relativePosition = `${r.bearing || ""}${r.distance || ""}`;
      const departClause = r.departTime
        ? `${r.party}${r.departTime}出发，`
        : `${r.party}`;

      return `${from.faction}行动——${from.name}→${to.name}。${to.name}位于${from.name}${relativePosition}。${departClause}预计${r.arriveTime}到达${to.name}。`;
    })
    .filter(Boolean);
}

// 把"当前NPC"信息（大地图 + 已加载到上下文的小地图）单独拼成一段说明文字，
// 跟大地图 customSummary 是否被用户自定义覆盖无关——不管标记/路线文本走的是自动生成还是
// 手动编辑，只要标记上填了 npcNote（不管是「NPC智能行程」自动写的还是手动填的），
// 都要能让主线剧情LLM看到，所以单独拼、不塞进上面那个 if/else 分支里。
function buildNpcPositionsSummary(settings) {
  const lines = [];
  settings.maps.big.markers.forEach((m) => {
    if (m.npcNote && m.npcNote.trim()) {
      lines.push(`【大地图】${m.name}：${m.npcNote.trim()}`);
    }
  });
  settings.maps.small
    .filter((sm) => sm.loadedInContext)
    .forEach((sm) => {
      const entries = sm.markers
        .filter((m) => m.npcNote && m.npcNote.trim())
        .map((m) => `${m.name}-${m.npcNote.trim()}`);
      if (entries.length > 0) {
        lines.push(`【${sm.name}】内部地点：${entries.join("；")}`);
      }
    });
  if (lines.length === 0) return "";
  return `各地点暂时停留的NPC有：\n${lines.join("\n")}`;
}

export function buildSummaryText() {
  const settings = getSettings();
  const parts = [];

  const big = settings.maps.big;
  const routeLines = buildRouteSummaryList(big); // 无论是否使用自定义文本，都要算一遍，用于下面判断是否加免责声明

  if (big.customSummary && big.customSummary.trim()) {
    // 用户已手动编辑/载入过自定义说明，直接用它替代自动拼接的标记/路线文本
    parts.push(big.customSummary.trim());
  } else {
    if (big.markers.length > 0) {
      const lines = big.markers.map(
        (m) => `${m.name}(${m.faction})：${m.description || ""}`,
      );
      parts.push(lines.join("\n"));
    }
    if (routeLines.length > 0) {
      parts.push(routeLines.join("\n"));
    }
  }

  // 小地图：只注入用户勾选了"加载到本次对话"的
  settings.maps.small
    .filter((m) => m.loadedInContext)
    .forEach((m) => {
      const noteParts = [];
      if (m.markers.length > 0) {
        noteParts.push(`标记点：${m.markers.map((mk) => mk.name).join("、")}`);
      }
      if (m.layoutNote && m.layoutNote.trim()) {
        noteParts.push(m.layoutNote.trim());
      }
      if (noteParts.length > 0) {
        parts.push(`"${m.name}"的空间布局：\n${noteParts.join("\n")}`);
      }
    });

  const npcPositionsText = buildNpcPositionsSummary(settings);
  if (npcPositionsText) parts.push(npcPositionsText);

  if (parts.length === 0) return "";

  // 免责声明只在整段开头出现一次，不再逐条路线重复
  const disclaimer =
    routeLines.length > 0
      ? "（势力行动路线及到达时间仅供参考，具体以故事实际发展为准）"
      : "";

  return `<cartographic_information>\n用户当前设有以下地点信息/行动${disclaimer}：\n${parts.join("\n\n")}\n</cartographic_information>`;
}

// === 把「地图信息」写入当前角色的"角色名总结"世界书===
// 群聊 / 未选中角色卡时直接跳过，不创建/不写入任何世界书，数据只留在内存里。
// force=false（默认，几乎所有自动触发点用这个）：条目不存在就直接跳过，不自动新建——
//   避免你手动把「地图信息」条目删掉之后，随便编辑一下标记/切个对话它又自己冒出来。
// force=true：不管条目在不在都直接创建/覆盖——唯一的调用点是打开地图编辑器（点击"地图标记"按钮）。
export async function syncMapInfoEntry(force = false) {
  const name = getMapCurrentCharacterName();
  if (!name) return;
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    if (!force) {
      const exists = await lorebookEntryExists(lorebookName, MAP_INFO_TITLE);
      if (!exists) return; // 还没打开过地图编辑器创建过条目，不自动新建
    }
    const content = buildSummaryText();
    await saveOrOverwriteLorebookEntry(
      lorebookName,
      MAP_INFO_TITLE,
      content,
      true,
      MAP_INFO_ENTRY_DEFAULTS,
    );
  } catch (err) {
    console.warn("[剧情助手/地图] 同步「地图信息」世界书条目失败：", err);
  }
}

// 标记/路线/小地图任何一次编辑都会调用这个，短暂防抖一下，避免连续操作时反复读写世界书。
// force 透传给 syncMapInfoEntry：默认 false，只在条目已存在时更新。
export let mmSyncDebounceTimer = null;

export function scheduleMapInfoSync(force = false) {
  if (mmSyncDebounceTimer) clearTimeout(mmSyncDebounceTimer);
  mmSyncDebounceTimer = setTimeout(() => {
    mmSyncDebounceTimer = null;
    syncMapInfoEntry(force);
  }, 400);
}
