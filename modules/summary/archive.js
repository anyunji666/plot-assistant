"use strict";

import { getLorebookEntriesArray } from "../worldinfo.js";
import { extractLabelLine, extractSmallSummaryRange } from "./floor-restore.js";

// =====================================================================================
// === 状态存档：Time 本地拼接 + Overview 二次总结 ===
// 状态存档的 Time/Overview 都来自世界书里已有的"小总结：起-止"条目，不重新扫描聊天记录：
// Time 本地拼接（不调用AI，直接取最早/最晚小总结条目里的"时间："字段头尾）；
// Overview 调用AI把全部小总结正文交给它二次提炼（唯一的AI调用点）。
// =====================================================================================

// === Helper: 扫描世界书全部"小总结：起-止"条目，按起始楼层升序排列，供状态存档拼接使用 ===
export async function getSortedSmallSummaryEntries(lorebookName) {
  const entries = await getLorebookEntriesArray(lorebookName);
  const smallSummaries = [];
  entries.forEach((entry) => {
    const range = extractSmallSummaryRange(entry.comment);
    if (range) {
      smallSummaries.push({
        ...range,
        comment: entry.comment,
        content: entry.content || "",
      });
    }
  });
  smallSummaries.sort((a, b) => a.start - b.start);
  return smallSummaries;
}


// === Helper: 从小总结正文的"时间：A ~ B"或"时间：A"或"时间：未知"里取头部或尾部时间点，
// "未知"返回 null，交由调用方跳过并继续找下一条。side 传 "head" 取起点，"tail" 取止点。===
export function extractTimeBoundary(timeLabel, side) {
  if (!timeLabel || timeLabel === "未知") return null;
  const parts = timeLabel.split("~").map((s) => s.trim());
  const value = side === "head" ? parts[0] : parts[parts.length - 1];
  return value || null;
}


// === Helper: 状态存档的 Time 字段——从排序后的小总结条目里，正向找第一条有效时间点当起点，
// 反向找第一条有效时间点当止点；起止相同只显示一个值；全部"未知"或没有任何小总结条目时返回空字符串。===
export function buildArchiveTimeLabel(sortedSmallSummaries) {
  let headTime = null;
  for (const entry of sortedSmallSummaries) {
    const timeLabel = extractLabelLine(entry.content, "时间");
    headTime = extractTimeBoundary(timeLabel, "head");
    if (headTime) break;
  }

  let tailTime = null;
  for (let i = sortedSmallSummaries.length - 1; i >= 0; i--) {
    const timeLabel = extractLabelLine(sortedSmallSummaries[i].content, "时间");
    tailTime = extractTimeBoundary(timeLabel, "tail");
    if (tailTime) break;
  }

  if (!headTime && !tailTime) return "";
  if (!headTime) return tailTime;
  if (!tailTime) return headTime;
  return headTime === tailTime ? headTime : `${headTime} ~ ${tailTime}`;
}


// === Helper: 状态存档的 Overview 二次总结提示词（systemPrompt，固定不变）===
export function buildArchiveOverviewInstruction() {
  return `<story_history>是这个故事按时间顺序排列的分段事件记录。
请提炼成一份不超过1000字的剧情总览，展现故事的完整脉络。
直接输出剧情总览，不带任何标签。`;
}


// === Helper: 状态存档的 Overview 二次总结用户输入——把排序后全部小总结正文拼接进 <story_history> 标签 ===
export function buildArchiveOverviewUserContent(sortedSmallSummaries) {
  const storyHistoryText = sortedSmallSummaries
    .map((entry) => entry.content)
    .join("\n\n");
  return `<story_history>\n${storyHistoryText}\n</story_history>`;
}
