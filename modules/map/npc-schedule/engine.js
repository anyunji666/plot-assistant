"use strict";

// =====================================================================================
// === NPC行程LLM：编排逻辑 ===
// 「NPC智能行程」开关打开后，每层AI消息渲染完成自动跑一次：
//   收集大地图 + 已加载到上下文的小地图的全部标记作为"候选地点清单"
//   → 拼上用户手写的NPC行程资料 + 最新一层正文 → 调用NPC行程LLM
//   → 解析返回的 JSON 数组，全量覆盖式重写各标记的 npcNote 字段
//   → 保存 + 刷新地图编辑器UI（如果正开着）+ 同步「地图信息」世界书条目（让主线剧情LLM也能看到）
// 静默失败：调用失败/解析失败只打印控制台，不弹窗打断阅读体验，这一轮的NPC位置维持不变。
// =====================================================================================

import { getCtx, getLastAiFloor } from "../../core.js";
import { getSettings, saveSettings } from "../store.js";
import { scheduleMapInfoSync } from "../generator.js";
import { renderMarkerList } from "../markers.js";
import { callNpcScheduleLlm } from "./api.js";
import {
  DEFAULT_NPC_SCHEDULE_SYSTEM_PROMPT,
  buildCandidateLocationsText,
  buildNpcScheduleUserContent,
} from "./prompts.js";

// === Helper: 非阻塞悬浮提示（复用状态表LLM同款胶囊样式，仅id/文案不同）===
const NPC_SCHEDULE_INDICATOR_ID = "pa-npc-schedule-indicator";

function showNpcScheduleIndicator() {
  try {
    if (document.getElementById(NPC_SCHEDULE_INDICATOR_ID)) return;
    const el = document.createElement("div");
    el.id = NPC_SCHEDULE_INDICATOR_ID;
    el.className = "pa-status-llm-indicator";
    el.textContent = "NPC行程更新中···";
    document.body.appendChild(el);
  } catch (error) {
    console.error("[剧情助手/地图] 显示NPC行程LLM进度提示时出错:", error);
  }
}

function hideNpcScheduleIndicator() {
  try {
    document.getElementById(NPC_SCHEDULE_INDICATOR_ID)?.remove();
  } catch (error) {
    console.error("[剧情助手/地图] 隐藏NPC行程LLM进度提示时出错:", error);
  }
}

// === Helper: 解析LLM返回的JSON数组，容错处理markdown代码块包裹/多余文字 ===
function parseNpcAssignments(rawResult) {
  const text = String(rawResult || "").trim();
  if (!text) return [];
  const tryParse = (s) => {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;

  // 去掉可能的 ```json ... ``` 包裹
  const stripped = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const strippedParsed = tryParse(stripped);
  if (strippedParsed) return strippedParsed;

  // 兜底：截取第一个 [ 到最后一个 ] 之间的内容再尝试一次
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1));
    if (sliced) return sliced;
  }

  console.warn("[剧情助手/地图] NPC行程LLM返回内容无法解析为JSON数组，本轮跳过：", text.slice(0, 300));
  return [];
}

// === Helper: 收集当前候选地点范围——大地图（始终包含）+ 已勾选"加载到本次对话"的小地图 ===
// 返回 [{ mapLabel, markers（标记对象数组，可直接改 npcNote） }]
function collectCandidateMaps(settings) {
  const candidateMaps = [{ mapLabel: "大地图", markers: settings.maps.big.markers }];
  settings.maps.small
    .filter((sm) => sm.loadedInContext)
    .forEach((sm) => {
      candidateMaps.push({ mapLabel: sm.name, markers: sm.markers });
    });
  return candidateMaps;
}

// === Helper: 刷新地图编辑器UI（如果正开着）===
function refreshMapUiIfOpen() {
  try {
    if (!document.getElementById("mm-modal-overlay")?.open) return;
    renderMarkerList();
  } catch (error) {
    console.error("[剧情助手/地图] 刷新NPC信息后刷新地图UI时出错:", error);
  }
}

// === Function: 跑一次NPC行程LLM，把结果写回各标记的 npcNote 字段 ===
// 返回布尔值：true = 真的发起了请求并成功写回了结果；false = 因为开关未开/资料为空/
// 没有任何标记点/请求失败等原因被跳过或中止，调用方可以据此决定要不要给用户反馈。
export async function runNpcScheduleUpdate() {
  try {
    const settings = getSettings();
    if (!settings.npcScheduleEnabled) return false; // 开关未打开，不发请求

    const scheduleText = (settings.npcScheduleText || "").trim();
    if (!scheduleText) return false; // 没填资料，没法判断，跳过

    const candidateMaps = collectCandidateMaps(settings);
    const hasAnyMarker = candidateMaps.some((m) => m.markers.length > 0);
    if (!hasAnyMarker) return false; // 没有任何地点标记，没法分配，跳过

    const candidateLocationsText = buildCandidateLocationsText(
      candidateMaps.map((m) => ({
        mapLabel: m.mapLabel,
        markerNames: m.markers.map((mk) => mk.name),
      })),
    );

    const { mes: latestFloorText } = getLastAiFloor();
    const userContent = buildNpcScheduleUserContent({
      scheduleText,
      candidateLocationsText,
      latestFloorText,
    });

    showNpcScheduleIndicator();
    let rawResult = "";
    try {
      rawResult = await callNpcScheduleLlm([
        { role: "system", content: DEFAULT_NPC_SCHEDULE_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ]);
    } catch (error) {
      console.error(
        "[剧情助手/地图] NPC行程LLM调用失败，本轮NPC位置维持不变（可稍后随下一层自动重试）:",
        error,
      );
      return false;
    } finally {
      hideNpcScheduleIndicator();
    }

    const assignments = parseNpcAssignments(rawResult);

    // 建立"地图+地点名" -> 标记对象 的精确索引，以及"地点名" -> 标记对象数组 的兜底索引
    // （兜底用于 LLM 返回的 map 字段没能精确对上候选清单分组名、但地点名在全局唯一时仍能落地）
    const exactIndex = new Map();
    const nameOnlyIndex = new Map();
    candidateMaps.forEach((m) => {
      m.markers.forEach((marker) => {
        exactIndex.set(`${m.mapLabel}::${marker.name}`, marker);
        if (!nameOnlyIndex.has(marker.name)) nameOnlyIndex.set(marker.name, []);
        nameOnlyIndex.get(marker.name).push(marker);
      });
    });

    // 全量覆盖式重写：先清空这次候选范围内所有标记的 npcNote，避免NPC离开旧地点后留下幽灵记录
    candidateMaps.forEach((m) => {
      m.markers.forEach((marker) => {
        marker.npcNote = "";
      });
    });

    const grouped = new Map(); // marker引用 -> [{npc, note}]
    assignments.forEach((a) => {
      if (!a || typeof a !== "object") return;
      const npc = String(a.npc || "").trim();
      const location = String(a.location || "").trim();
      if (!npc || !location) return;
      const mapLabel = String(a.map || "").trim();

      let target = mapLabel ? exactIndex.get(`${mapLabel}::${location}`) : null;
      if (!target) {
        const candidates = nameOnlyIndex.get(location);
        if (candidates && candidates.length === 1) target = candidates[0];
      }
      if (!target) return; // 候选清单里找不到匹配地点，按规则跳过，不强行分配

      const note = String(a.note || "").trim();
      if (!grouped.has(target)) grouped.set(target, []);
      grouped.get(target).push({ npc, note });
    });

    grouped.forEach((entries, marker) => {
      marker.npcNote = entries
        .map((e) => (e.note ? `${e.npc}（${e.note}）` : e.npc))
        .join("；");
    });

    saveSettings();
    refreshMapUiIfOpen();
    scheduleMapInfoSync();
    return true;
  } catch (error) {
    console.error("[剧情助手/地图] NPC行程LLM运行时出错:", error);
    return false;
  }
}

// === Function: 注册「每层AI消息渲染完成」自动触发监听 ===
// 是否真正发起请求由 runNpcScheduleUpdate 内部读取「NPC智能行程」开关决定，
// 这里只负责挂事件，跟状态表LLM的 registerStatusTableAutoUpdate 挂同一个渲染事件。
export function registerNpcScheduleAutoUpdate() {
  try {
    const context = getCtx();
    if (!context.eventSource || !context.event_types) {
      console.warn(
        "[剧情助手/地图] 当前酒馆版本未暴露 eventSource/event_types，NPC智能行程自动更新未启用。",
      );
      return;
    }
    const renderEventName =
      context.event_types.CHARACTER_MESSAGE_RENDERED ||
      context.event_types.MESSAGE_RECEIVED;
    if (!renderEventName) {
      console.warn("[剧情助手/地图] 未找到可用的消息渲染事件，NPC智能行程自动更新未启用。");
      return;
    }
    context.eventSource.on(renderEventName, () => {
      runNpcScheduleUpdate();
    });
    console.log(`[剧情助手/地图] NPC智能行程自动更新监听已注册（事件: ${renderEventName}）。`);
  } catch (error) {
    console.error("[剧情助手/地图] 注册NPC智能行程自动更新监听时出错:", error);
  }
}
