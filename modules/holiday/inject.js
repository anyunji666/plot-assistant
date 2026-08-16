"use strict";

import { getCtx, getLastAiFloor } from "../core.js";
import { parseFloorSummaryFields } from "../summary/parser.js";
import { buildHolidayTagContent, parseCustomHolidaysText } from "./calc.js";
import { getHolidayEnabled, getRestPresetText, getCustomHolidaysRawText } from "./settings.js";

// =====================================================================================
// 节假日模块 - 注入部分：从"正文最新一层摘要模块的 Time 字段"解析出当前公历日期，
// 生成 <holiday_judgment>YYYY年M月D日 是 星期X（附近节假日提示）</holiday_judgment>，
// 生成前临时注入正文、渲染完这一轮立即清空（一次性，不常驻）。
// 完全独立的模块：自己的开关（面板"节假日开/节假日关"）、自己的 extension prompt key、
// 自己注册事件监听，不依赖通讯器模块是否开启，也不走 pending/persist 那一套状态机——
// 每轮都用当前最新的 Time 字段 + 当前开关状态重新纯计算一遍。
// =====================================================================================

const HOLIDAY_SLOT_PROMPT_KEY = "plotAssistant_holidaySlot";

function clearHolidayPrompt(context) {
  if (typeof context.setExtensionPrompt !== "function") return;
  const position = context.extension_prompt_types?.IN_CHAT ?? 1;
  const role = context.extension_prompt_roles?.SYSTEM ?? 0;
  context.setExtensionPrompt(HOLIDAY_SLOT_PROMPT_KEY, "", position, 0, false, role);
}

export async function applyHolidaySlotPrompt() {
  try {
    const context = getCtx();
    if (typeof context.setExtensionPrompt !== "function") {
      console.warn(
        "[剧情助手] 当前酒馆版本未暴露 setExtensionPrompt，节假日播报未启用。",
      );
      return;
    }
    // 先清空上一轮可能残留的内容，避免"上一层能解析、这一层解析不出/开关被关掉"时旧内容继续挂在正文里。
    clearHolidayPrompt(context);

    if (!getHolidayEnabled()) return; // 面板开关关闭，直接不注入

    const { mes } = getLastAiFloor();
    const fields = parseFloorSummaryFields(mes);
    const timeText = fields && fields.time;
    if (!timeText) return; // 没有 Time 字段，完全不注入

    const content = buildHolidayTagContent(timeText, {
      customHolidays: parseCustomHolidaysText(getCustomHolidaysRawText()).items,
      restPresetText: getRestPresetText(),
    });
    if (!content) return; // 解析不出合法公历日期，完全不注入（哪怕假期预设填了内容也不会单独注入）

    const position = context.extension_prompt_types?.IN_CHAT ?? 1;
    const role = context.extension_prompt_roles?.SYSTEM ?? 0;
    context.setExtensionPrompt(HOLIDAY_SLOT_PROMPT_KEY, content, position, 0, false, role);
  } catch (error) {
    console.error("[剧情助手] 注入节假日播报时出错:", error);
  }
}

export function clearHolidaySlotPromptAfterRound() {
  try {
    clearHolidayPrompt(getCtx());
  } catch (error) {
    console.error("[剧情助手] 清空节假日播报时出错:", error);
  }
}

// 独立注册，不绑定通讯器模块（私信槽位）是否开启：插件加载即可监听，实际是否注入由面板开关决定。
// GENERATION_STARTED 在部分酒馆版本里可能不存在，找不到时只打印警告、不阻断其它功能。
export function registerHolidayInjection() {
  try {
    const context = getCtx();
    if (!context.eventSource || !context.event_types) {
      console.warn(
        "[剧情助手] 未找到 eventSource/event_types，节假日播报未启用。",
      );
      return;
    }
    const startEventName =
      context.event_types.GENERATION_STARTED ||
      context.event_types.GENERATE_BEFORE_COMBINE_PROMPTS;
    if (startEventName) {
      context.eventSource.on(startEventName, () => {
        applyHolidaySlotPrompt();
      });
    } else {
      console.warn(
        "[剧情助手] 未找到生成开始事件（GENERATION_STARTED），节假日播报未启用，把控制台日志发我调整。",
      );
    }
    const renderEventName =
      context.event_types.CHARACTER_MESSAGE_RENDERED ||
      context.event_types.MESSAGE_RECEIVED;
    if (renderEventName) {
      context.eventSource.on(renderEventName, () => {
        clearHolidaySlotPromptAfterRound();
      });
    }
  } catch (error) {
    console.error("[剧情助手] 注册节假日播报注入监听时出错:", error);
  }
}
