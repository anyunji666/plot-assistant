"use strict";

import { extension_settings } from "../../../../../extensions.js";
import {
  EXPIRED_CHAPTER_INSTRUCTION,
  EXPIRED_CHAPTER_PROMPT_KEY,
  NOVEL_AUTO_JUMP_SETTINGS_KEY,
  getCtx,
  notify,
} from "../core.js";
import { parseFloorSummaryFields } from "../summary/parser.js";
import { getOrCreateSummaryLorebook } from "../worldinfo.js";
import { getActiveNovelChapterUid, listNovelChapterEntries, setActiveNovelChapter } from "./store.js";


// =====================================================================================
// === 剧情录入功能：自动跳转章节 ===
// 思路：生成前（有激活章节时）临时注入一句判定指令，要求 AI 结合已注入的原著章节参考资料自行判断
// 是否演绎完/过时，判断结果写进摘要块的 ExpiredChapter 字段；AI 消息渲染完成后清空这条临时指令，
// 并读取刚渲染那一层的摘要块，核对信号后自动把"当前进度"切到下一章（没有下一章则关闭章节注入）。
// 判定指令是一次性 extension prompt（跟私信槽位/库存变更提醒同一种用法），不写进世界书、不常驻。
// 默认关闭，由面板"剧情录入"按钮右侧的"自跳转开/自跳转关"按钮控制；关闭时下面几个函数直接跳过。
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


// === Function: 生成前，若当前有激活章节，临时注入判定指令；没有激活章节则不注入（也不用维护额外状态，
// 下一次有章节激活时这个函数自然又会开始注入）===
export async function applyExpiredChapterPrompt() {
  try {
    if (!isNovelAutoJumpEnabled()) return;
    const context = getCtx();
    if (typeof context.setExtensionPrompt !== "function") return;

    const lorebookName = await getOrCreateSummaryLorebook();
    const { activeUid, hasConflict } = await getActiveNovelChapterUid(lorebookName);
    // 没有激活章节：没什么可判定的，不注入。
    // 检测到冲突（不止一章同时启用）：状态本身就异常，不在这里自作主张，交给用户在面板里手动收敛。
    if (activeUid === null || hasConflict) return;

    const position = context.extension_prompt_types?.IN_CHAT ?? 1;
    const role = context.extension_prompt_roles?.SYSTEM ?? 0;
    context.setExtensionPrompt(
      EXPIRED_CHAPTER_PROMPT_KEY,
      EXPIRED_CHAPTER_INSTRUCTION,
      position,
      0,
      false,
      role,
    );
  } catch (error) {
    console.error("[剧情助手] 注入章节判定指令时出错:", error);
  }
}


export function clearExpiredChapterPromptAfterRound() {
  try {
    const context = getCtx();
    if (typeof context.setExtensionPrompt !== "function") return;
    const position = context.extension_prompt_types?.IN_CHAT ?? 1;
    const role = context.extension_prompt_roles?.SYSTEM ?? 0;
    context.setExtensionPrompt(EXPIRED_CHAPTER_PROMPT_KEY, "", position, 0, false, role);
  } catch (error) {
    console.error("[剧情助手] 清空章节判定指令时出错:", error);
  }
}


// === Function: AI 消息渲染完成后调用——读取最新一层摘要块的 ExpiredChapter 字段，核对后自动切换章节 ===
export async function handleExpiredChapterAutoJump() {
  try {
    if (!isNovelAutoJumpEnabled()) return;

    const context = getCtx();
    const chat = context.chat;
    if (!chat || chat.length === 0) return;
    const lastMessage = chat[chat.length - 1];
    if (!lastMessage || lastMessage.is_user) return; // 只关心 AI 楼层

    const fields = parseFloorSummaryFields(lastMessage.mes);
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


// === Function: 注册自动跳转监听（无条件注册，跟项目里其它 registerXxx 函数一致；开关状态在
// 上面几个函数内部各自判断，关闭时直接提前返回，不实际做事）===
export function registerNovelAutoJump() {
  try {
    const context = getCtx();
    if (!context.eventSource || !context.event_types) {
      console.warn(
        "[剧情助手] 未找到 eventSource/event_types，剧情自动跳转未启用。",
      );
      return;
    }

    const startEventName =
      context.event_types.GENERATION_STARTED ||
      context.event_types.GENERATE_BEFORE_COMBINE_PROMPTS;
    if (startEventName) {
      context.eventSource.on(startEventName, () => {
        applyExpiredChapterPrompt();
      });
    } else {
      console.warn(
        "[剧情助手] 未找到生成开始事件，剧情自动跳转的判定指令注入未启用。",
      );
    }

    const renderEventName =
      context.event_types.CHARACTER_MESSAGE_RENDERED ||
      context.event_types.MESSAGE_RECEIVED;
    if (renderEventName) {
      context.eventSource.on(renderEventName, () => {
        clearExpiredChapterPromptAfterRound();
        handleExpiredChapterAutoJump();
      });
    } else {
      console.warn(
        "[剧情助手] 未找到消息渲染事件，剧情自动跳转未启用。",
      );
    }
  } catch (error) {
    console.error("[剧情助手] 注册剧情自动跳转监听时出错:", error);
  }
}
