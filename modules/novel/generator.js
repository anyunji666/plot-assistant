"use strict";

import { extension_settings } from "../../../../../extensions.js";
import {
  EXPIRED_CHAPTER_INSTRUCTION,
  NOVEL_AUTO_JUMP_SETTINGS_KEY,
  NOVEL_CHAPTER_PROMPT_KEY,
  getCtx,
  getLastAiFloor,
  notify,
} from "../core.js";
import { parseFloorSummaryFields } from "../summary/parser.js";
import { getOrCreateSummaryLorebook } from "../worldinfo.js";
import { getActiveNovelChapter, getActiveNovelChapterUid, listNovelChapterEntries, setActiveNovelChapter } from "./store.js";


// =====================================================================================
// === 剧情录入功能：章节内容注入 + 自动跳转章节 ===
// 章节内容不再依赖世界书原生引擎注入（不挂载、不受 token 预算/深度排序影响），
// 而是生成前由插件直接读取"当前激活章节"的正文，与判定指令拼成同一段文本，
// 用同一次 setExtensionPrompt 调用一起发送，保证两者位置完全一致。
// 判定指令部分：要求 AI 结合已注入的原著章节参考资料自行判断是否演绎完/过时，
// 判断结果写进摘要块的 ExpiredChapter 字段；AI 消息渲染完成后清空这条临时指令，
// 并读取刚渲染那一层的摘要块，核对信号后自动把"当前进度"切到下一章（没有下一章则关闭章节注入）。
// 只在开启"自跳转"时才拼接判定指令；章节内容本身只要有激活章节就会注入，不受自跳转开关影响。
// =====================================================================================


export function getNovelAutoJumpSettings() {
  if (!extension_settings[NOVEL_AUTO_JUMP_SETTINGS_KEY]) {
    extension_settings[NOVEL_AUTO_JUMP_SETTINGS_KEY] = { enabled: false };
  }
  const s = extension_settings[NOVEL_AUTO_JUMP_SETTINGS_KEY];
  if (typeof s.enabled !== "boolean") s.enabled = false;
  return s;
}


export function isNovelAutoJumpEnabled() {
  return getNovelAutoJumpSettings().enabled;
}


// === Function: 生成前，若当前有激活章节，直接读取其内容并注入；若同时开启了"自跳转"，
// 再把判定指令拼在后面一起发送。没有激活章节则清空注入（不留旧内容）。===
export async function applyActiveChapterPrompt() {
  try {
    const context = getCtx();
    if (typeof context.setExtensionPrompt !== "function") return;

    const lorebookName = await getOrCreateSummaryLorebook();
    const chapter = await getActiveNovelChapter(lorebookName);

    const position = context.extension_prompt_types?.IN_CHAT ?? 1;
    const role = context.extension_prompt_roles?.SYSTEM ?? 0;

    if (!chapter) {
      // 没有激活章节：没什么可发送的，清空（避免残留上一次的内容/指令）。
      context.setExtensionPrompt(NOVEL_CHAPTER_PROMPT_KEY, "", position, 0, false, role);
      return;
    }

    let promptText = chapter.content;
    if (isNovelAutoJumpEnabled()) {
      promptText += `\n\n${EXPIRED_CHAPTER_INSTRUCTION}`;
    }

    context.setExtensionPrompt(
      NOVEL_CHAPTER_PROMPT_KEY,
      promptText,
      position,
      0,
      false,
      role,
    );
  } catch (error) {
    console.error("[剧情助手] 注入章节内容/判定指令时出错:", error);
  }
}


export function clearActiveChapterPromptAfterRound() {
  try {
    const context = getCtx();
    if (typeof context.setExtensionPrompt !== "function") return;
    const position = context.extension_prompt_types?.IN_CHAT ?? 1;
    const role = context.extension_prompt_roles?.SYSTEM ?? 0;
    context.setExtensionPrompt(NOVEL_CHAPTER_PROMPT_KEY, "", position, 0, false, role);
  } catch (error) {
    console.error("[剧情助手] 清空章节内容/判定指令时出错:", error);
  }
}


// === Function: AI 消息渲染完成后调用——读取最新一层摘要块的 ExpiredChapter 字段，核对后自动切换章节 ===
export async function handleExpiredChapterAutoJump() {
  try {
    if (!isNovelAutoJumpEnabled()) return;

    const { idx: lastAiIdx, mes: lastAiMes } = getLastAiFloor();
    if (lastAiIdx === -1) return;

    const fields = parseFloorSummaryFields(lastAiMes);
    const expiredChapter = fields ? fields.expiredChapter : "";
    if (!expiredChapter) return; // 没输出这个字段，说明 AI 判定还没演绎完，什么都不做

    const lorebookName = await getOrCreateSummaryLorebook();
    const { activeUid, hasConflict } = await getActiveNovelChapterUid(lorebookName);
    if (activeUid === null || hasConflict) return;

    const chapters = await listNovelChapterEntries(lorebookName);
    const activeIndex = chapters.findIndex((c) => c.uid === activeUid);
    if (activeIndex === -1) return;
    const activeChapter = chapters[activeIndex];

    // AI 报的章节名要跟当前激活章节完全一致才处理，防止楼层错位/AI 瞎报导致误触发。
    if (expiredChapter.trim() !== activeChapter.name) return;

    const nextChapter = chapters[activeIndex + 1];
    if (nextChapter) {
      await setActiveNovelChapter(lorebookName, nextChapter.uid);
      notify(
        "success",
        `剧情已自动跳转：「${activeChapter.name}」→「${nextChapter.name}」`,
      );
    } else {
      await setActiveNovelChapter(lorebookName, null);
      notify(
        "success",
        `「${activeChapter.name}」已是最后一章，已自动关闭章节注入。`,
      );
    }
  } catch (error) {
    console.error("[剧情助手] 自动跳转章节时出错:", error);
  }
}


// === Function: 注册章节内容注入 + 自动跳转监听（无条件注册，跟项目里其它 registerXxx 函数一致；
// 章节内容只要有激活章节就会注入，自跳转判定指令/自动切章则由各函数内部按开关状态判断，
// 关闭时直接提前返回，不实际做事）===
export function registerNovelAutoJump() {
  try {
    const context = getCtx();
    if (!context.eventSource || !context.event_types) {
      console.warn(
        "[剧情助手] 未找到 eventSource/event_types，章节内容注入与剧情自动跳转均未启用。",
      );
      return;
    }

    const startEventName =
      context.event_types.GENERATION_STARTED ||
      context.event_types.GENERATE_BEFORE_COMBINE_PROMPTS;
    if (startEventName) {
      context.eventSource.on(startEventName, () => {
        applyActiveChapterPrompt();
      });
    } else {
      console.warn(
        "[剧情助手] 未找到生成开始事件，章节内容/判定指令注入未启用。",
      );
    }

    const renderEventName =
      context.event_types.CHARACTER_MESSAGE_RENDERED ||
      context.event_types.MESSAGE_RECEIVED;
    if (renderEventName) {
      context.eventSource.on(renderEventName, () => {
        clearActiveChapterPromptAfterRound();
        handleExpiredChapterAutoJump();
      });
    } else {
      console.warn(
        "[剧情助手] 未找到消息渲染事件，剧情自动跳转未启用。",
      );
    }
  } catch (error) {
    console.error("[剧情助手] 注册章节内容注入/剧情自动跳转监听时出错:", error);
  }
}
