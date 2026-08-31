"use strict";

import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { openCreateCharacterDialog } from "./modules/character.js";
import { getNovelAutoJumpSettings } from "./modules/novel/generator.js";
import { getActiveNovelChapterUid, listNovelChapterEntries, setActiveNovelChapter } from "./modules/novel/store.js";
import { openNovelEntryDialog } from "./modules/novel/ui.js";
import { NOVEL_SUMMARY_IDB_NAME, resetNovelSummaryBehaviorSettings } from "./modules/novel-summary/store.js";
import { closeDb as closeNovelSummaryDb } from "./modules/novel-summary/lib/novel-idb.js";
import { applyNovelSummaryNavbarVisibility, openNovelSummaryNavbarToggleDialog } from "./modules/novel-summary/ui.js";
import { LOCAL_CHAT_STORE_KEY, NOVEL_ACTIVE_CHAPTER_SETTINGS_KEY, NOVEL_AUTO_JUMP_SETTINGS_KEY, PHONE_IDB_NAME, SUMMARY_POPUP_ID, errorCatched, getCtx, notify, resetLocalChatStoreCache, resetTransientChatMetadataStore } from "./modules/core.js";
import { IDB_NAME, MAP_MODULE_NAME, getFabVisible, setFabVisibleSetting } from "./modules/map/store.js";
import { FAB_POS_KEY, applyFabVisibility, openModal, resetFabPos } from "./modules/map/ui.js";
import { MOBILE_OPT_SETTINGS_KEY, disableLazyLoadGroup, disableRenderOptimizeGroup, enableLazyLoadGroup, enableRenderOptimizeGroup, getMobileOptSettings } from "./modules/mobile-opt.js";
import { PHONE_MODULE_NAME, getPhoneFabVisible, setPhoneFabVisibleSetting } from "./modules/phone/store.js";
import { HOLIDAY_SETTINGS_KEY, getHolidayEnabled, setHolidayEnabledSetting } from "./modules/holiday/settings.js";
import { openRestPresetDialog, openCustomHolidaysDialog } from "./modules/holiday/ui.js";
import { PROMPT_TEMPLATE_SETTINGS_KEY, getPromptTemplateStageSyncEnabled, setPromptTemplateStageSyncEnabledSetting } from "./modules/summary/prompt-template/settings.js";
import { openPromptTemplateFormatDialog } from "./modules/summary/prompt-template/ui.js";
import { PHONE_FAB_POS_KEY, applyPhoneFabVisibility, openPhonePresetDialog, resetPhoneFabPos } from "./modules/phone/ui.js";
import { ensureSummaryLorebookOnLoad, runAutoLargeSummary, runAutoSmallSummary, runSetOffset } from "./modules/summary/generator.js";
import { openCustomFieldsDialog, openFieldMetaInstructionDialog, openHideFloorDialog, openPreEmphasisDialog, openStatusLlmConfigDialog } from "./modules/summary/ui.js";
import { clearAllCustomFieldsAcrossCharacters, getStatusLlmSettings } from "./modules/summary/status-llm/store.js";
import { getLorebookEntriesSummaryHtml, getOrCreateSummaryLorebook, isSummaryLorebookGloballyEnabled, mountSummaryLorebookGlobally, notifyWorldInfoUpdated } from "./modules/worldinfo.js";


// === Helper: 转义 HTML 特殊字符（章节名是用户自由输入的，拼进 <option> 前需要转义） ===
function escapeNovelChapterLabel(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


// === Helper: 构建"当前注入章节"下拉框的 <option> 列表 HTML ===
// 没有任何已录入章节：只显示一个禁用态占位项，提示先去"剧情录入"。
// 有章节：第一项固定是"不注入章节"（对应 activeUid=null），后面按序号顺序列出所有章节，
// 当前激活的那一项打上 selected。
function buildNovelActiveChapterOptionsHtml(chapters, activeUid) {
  if (!chapters || chapters.length === 0) {
    return `<option value="">暂无章节，请先录入</option>`;
  }
  let html = `<option value="__none__"${activeUid === null ? " selected" : ""}>不注入章节</option>`;
  chapters.forEach((chapter) => {
    const selected = chapter.uid === activeUid ? " selected" : "";
    html += `<option value="${chapter.uid}"${selected}>${escapeNovelChapterLabel(chapter.name)}</option>`;
  });
  return html;
}


// === Function: 删除一个 IndexedDB 数据库（用于"清空数据"）===
// 如果本页面还有该库的连接没关闭，浏览器会触发 onblocked 而不是立刻成功/失败，
// 这里给个超时兜底，避免整个清空流程卡住不返回；真遇到 blocked 的情况会在控制台留日志，
// 提醒用户刷新页面重试（IndexedDB 规范本身没有"强制踢掉其他连接"的办法）。
export function deleteIndexedDatabase(name) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => finish(true);
      req.onerror = () => finish(false);
      req.onblocked = () => {
        console.warn(
          `[剧情助手] 删除数据库 ${name} 被阻塞，可能还有未关闭的连接，请刷新页面后重试。`,
        );
      };
      // 兜底：万一 onblocked 之后也不再触发 onsuccess/onerror，别让调用方一直等下去。
      setTimeout(() => finish(false), 5000);
    } catch (error) {
      console.error(`[剧情助手] 删除数据库 ${name} 时出错:`, error);
      finish(false);
    }
  });
}


// === Function: 清空本插件的全部本地缓存数据（控制面板"清空数据"按钮）===
// 范围：三个 IndexedDB 库（私信/头像/图片/背景 + 地图图片 + 小说摘要提取的分段原文/摘要进度）、
// 两个悬浮球位置的 localStorage、
// 七块插件自己的 extension_settings（通讯器/地图/移动端优化/节假日/小说自动跳转与当前章节/小说摘要提取/
// 提示词模板联动，删掉后下次读取会自动用默认值重建，节假日这块连同你已经录入的自定义节假日一起清空；
// 提示词模板联动这块只有"阶段词开/关"一个布尔值，清空后还原为默认关闭；
// 小说摘要提取这块只重置导航栏显隐/流式/超时/限速/分段大小这些行为设置，
// API 地址/Key/模型/自定义提示词保留不清——提示词想恢复默认，去"摘要提示词（可自定义）"
// 弹窗里点"恢复默认"按钮即可）、
// 以及所有对话的起始楼层记录和私信忙闲缓存（本地存储，一份 localStorage 覆盖所有对话，一次性清空）、
// 以及所有角色卡绑定的"附加字段"定义（状态表LLM按角色卡分别存储的自定义字段，一并全部清空，
// 不只是当前选中的这一个角色卡；API 地址/Key/模型/自定义提示词仍然保留不清）。
// 不包含：总结功能生成的世界书条目（用户自己在世界书里删）。
export async function clearAllPluginLocalData() {
  // 小说摘要模块的连接是长期缓存的（用过一次就不会自动断开），
  // 不主动关掉的话下面 deleteDatabase(NOVEL_SUMMARY_IDB_NAME) 会被 onblocked 卡住。
  // 私信库、地图图片库每次操作都是用完即走，不缓存连接，不需要这一步。
  try {
    await closeNovelSummaryDb();
  } catch (error) {
    console.error("[剧情助手] 关闭小说摘要数据库连接失败:", error);
  }

  const results = await Promise.all([
    deleteIndexedDatabase(PHONE_IDB_NAME),
    deleteIndexedDatabase(IDB_NAME),
    deleteIndexedDatabase(NOVEL_SUMMARY_IDB_NAME),
  ]);

  try {
    localStorage.removeItem(FAB_POS_KEY);
    localStorage.removeItem(PHONE_FAB_POS_KEY);
  } catch (error) {
    console.error("[剧情助手] 清空 localStorage 悬浮球位置记忆失败:", error);
  }

  try {
    delete extension_settings[PHONE_MODULE_NAME];
    delete extension_settings[MAP_MODULE_NAME];
    delete extension_settings[MOBILE_OPT_SETTINGS_KEY];
    delete extension_settings[NOVEL_AUTO_JUMP_SETTINGS_KEY];
    delete extension_settings[NOVEL_ACTIVE_CHAPTER_SETTINGS_KEY];
    delete extension_settings[HOLIDAY_SETTINGS_KEY];
    delete extension_settings[PROMPT_TEMPLATE_SETTINGS_KEY];
    // 小说摘要提取的 apiUrl/apiKey/model/customPrompt 不属于本次清空范围，
    // 只重置导航栏显隐/流式/超时/限速/分段大小这些行为设置，跟下面状态表LLM的处理思路一致。
    resetNovelSummaryBehaviorSettings();
    // 状态表LLM的 apiUrl/apiKey/model/customPrompt 等配置不属于本次清空范围，
    // 只还原面板"再分析开/关"这一个开关状态（还原成当前默认值 true），避免清空数据时连带清掉用户填好的状态表 API 配置。
    getStatusLlmSettings().reanalyzeEnabled = true;
    saveSettingsDebounced();
    // 附加字段定义按角色卡分别存储（byCharacter），跟连接配置是两码事，属于"剧情内容相关的本地缓存"，
    // "清空数据"要覆盖所有角色卡一并清掉，不只是当前选中的这一个。
    clearAllCustomFieldsAcrossCharacters();
  } catch (error) {
    console.error("[剧情助手] 重置插件配置失败:", error);
  }

  try {
    localStorage.removeItem(LOCAL_CHAT_STORE_KEY);
    resetLocalChatStoreCache(); // 内存缓存也一并重置，避免清空后马上又读到清空前的旧对象
    resetTransientChatMetadataStore();
  } catch (error) {
    console.error("[剧情助手] 清空所有对话的楼层/忙闲缓存失败:", error);
  }

  const allDbOk = results.every(Boolean);

  // 清空设置后，界面上已渲染的显隐状态（导航栏图标/悬浮球）不会自动跟着刷新——
  // 这几个开关都是"读设置 → 手动设 CSS display"的模式，只在各自的开关按钮点击时触发，
  // 清空数据不属于那个入口，所以这里需要显式调用一遍同步，让清空动作立刻在界面上生效，
  // 不用等用户手动刷新页面或重新点一次对应开关。
  try {
    applyNovelSummaryNavbarVisibility();
    applyFabVisibility();
    applyPhoneFabVisibility();
  } catch (error) {
    console.error("[剧情助手] 清空数据后同步显隐状态失败:", error);
  }

  return { allDbOk };
}


// === Function: 显示剧情助手控制面板 ===
export async function showSummaryPopup() {
  try {
    const POPUP_ID = SUMMARY_POPUP_ID;

    $(`#${POPUP_ID}`).remove();
    $(`#${POPUP_ID}-overlay`).remove();

    $(document).off("click", ".lorebook-entry .entry-header");
    $(document).off("click", ".entry-save");
    $(document).off("click", ".entry-delete");

    await ensureSummaryLorebookOnLoad();
    const summaryLorebookName = await getOrCreateSummaryLorebook();
    const lorebookEntriesHTML =
      await getLorebookEntriesSummaryHtml(summaryLorebookName);
    const isMountedGlobally =
      await isSummaryLorebookGloballyEnabled(summaryLorebookName);
    const novelChapters = await listNovelChapterEntries(summaryLorebookName);
    const { activeUid: activeNovelChapterUid } =
      await getActiveNovelChapterUid(summaryLorebookName);
    const popupContent = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #444;">
        <h3 style="margin: 0; color: #e0e0e0; font-weight: 500; font-size: 18px;">剧情助手控制面板</h3>
        <div>
          <button id="close-${POPUP_ID}" style="background: transparent; border: none; color: #aaa; cursor: pointer; font-size: 20px; padding: 0; margin: 0; transition: color 0.2s; vertical-align: middle;">&times;</button>
        </div>
      </div>

      <div id="${POPUP_ID}-content" style="max-height: 60vh; overflow-y: auto; font-size: 14px; color: #bbb; scrollbar-width: thin; scrollbar-color: #666 #333; padding-right: 10px;">
        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">总结功能</p>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button id="${POPUP_ID}-set-offset" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">起始楼层</button>
            <button id="${POPUP_ID}-auto-small" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">自动小总结</button>
            <button id="${POPUP_ID}-auto-large" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">状态存档</button>
            <button id="${POPUP_ID}-hide-floor" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">隐藏楼层</button>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px;">
            <p style="color: #72b1e8; font-weight: 500; margin: 0;">摘要配置</p>
            <button id="${POPUP_ID}-status-llm-reanalyze" title="开启后，每层AI消息渲染完会自动调用状态表LLM提取Inventory/Setups；关闭（默认）则不发送任何信息给状态表LLM" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button id="${POPUP_ID}-status-llm-config" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">API配置</button>
            <button id="${POPUP_ID}-pre-emphasis" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">对话前强调</button>
            <button id="${POPUP_ID}-custom-fields" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">附加字段</button>
            <button id="${POPUP_ID}-field-meta-instruction" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">字段修改</button>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">同人小说</p>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px;">
              <div style="display: flex; gap: 8px;">
                <button id="${POPUP_ID}-novel-entry" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">剧情录入</button>
                <button id="${POPUP_ID}-novel-summary-toggle" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">摘要提取</button>
              </div>
              <button id="${POPUP_ID}-novel-autojump" title="AI在摘要里判定当前章节已演绎完/过时时，自动切到下一章（没有下一章则关闭章节注入）" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px;">
              <label style="font-size: 12px; color: #888;">当前注入章节：</label>
              <select id="${POPUP_ID}-novel-active-chapter" ${novelChapters.length === 0 ? "disabled" : ""} style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid #3a3a3a; background: #ffffff; color: #000000; font-size: 13px; font-family: inherit;">${buildNovelActiveChapterOptionsHtml(novelChapters, activeNovelChapterUid)}</select>
            </div>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px;">
            <p style="color: #72b1e8; font-weight: 500; margin: 0;">世界书条目 (${summaryLorebookName})</p>
            <button id="${POPUP_ID}-mount-global" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
          <div id="${POPUP_ID}-lorebook" style="background: #333; border-radius: 6px; padding: 10px; font-size: 13px;">
            ${lorebookEntriesHTML}
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">提示词模板联动</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <button id="${POPUP_ID}-prompt-template-info" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">动态提示词</button>
            </div>
            <button id="${POPUP_ID}-prompt-template-stage-toggle" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">节假日</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <button id="${POPUP_ID}-holiday-rest-preset" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">假期预设</button>
              <button id="${POPUP_ID}-holiday-custom" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">设置节假日</button>
            </div>
            <button id="${POPUP_ID}-holiday-toggle" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">联系人</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <button id="${POPUP_ID}-phone-preset" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">私信预设</button>
              <button id="${POPUP_ID}-create-character" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">添加联系人</button>
            </div>
            <button id="${POPUP_ID}-phone-fab-toggle" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">地图</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px;">
            <button id="${POPUP_ID}-map-marker" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">地图标记</button>
            <button id="${POPUP_ID}-fab-toggle" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">移动端优化</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0;">
            <span style="font-size: 12px; color: #999; flex: 1;">折叠预设滑块 · 优化长聊渲染</span>
            <button id="${POPUP_ID}-mobile-opt-render" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid #3a3a3a;">
            <span style="font-size: 12px; color: #999; flex: 1;">懒加载头像与角色列表</span>
            <button id="${POPUP_ID}-mobile-opt-lazyload" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
        </div>

        <div>
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">数据管理</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0;">
            <span style="font-size: 12px; color: #999; flex: 1;">清除世界书以外的本插件数据</span>
            <button id="${POPUP_ID}-clear-all-data" style="background: #c0392b; border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;">清空数据</button>
          </div>
        </div>
      </div>
    `;

    const $overlay = $("<div></div>")
      .attr("id", `${POPUP_ID}-overlay`)
      .css({
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        zIndex: 9998,
        backdropFilter: "blur(2px)",
      })
      .on("click", function (e) {
        if (e.target === this) closePopup();
      });

    const $popup = $("<div></div>")
      .attr("id", POPUP_ID)
      .css({
        position: "fixed",
        top: "70px",
        left: "50%",
        transform: "translateX(-50%)",
        width: "600px",
        maxWidth: "90%",
        maxHeight: "80vh",
        background: "#262626",
        color: "#e0e0e0",
        border: "none",
        borderRadius: "8px",
        boxShadow: "0 15px 30px rgba(0, 0, 0, 0.6)",
        padding: "20px",
        zIndex: 9999,
        boxSizing: "border-box",
        overflow: "hidden",
        fontFamily: "system-ui, -apple-system, sans-serif",
        animation: "summaryAssistantPopupFadeIn 0.2s ease-out",
      })
      .html(popupContent);

    if ($("#summary-assistant-popup-animation-style").length === 0) {
      const styleElement = document.createElement("style");
      styleElement.id = "summary-assistant-popup-animation-style";
      styleElement.textContent = `
        @keyframes summaryAssistantPopupFadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `;
      document.head.appendChild(styleElement);
    }

    $("body").append($overlay).append($popup);

    function closePopup() {
      try {
        $(document).off("click", ".lorebook-entry .entry-header");
        $(document).off("click", ".entry-save");
        $(document).off("click", ".entry-delete");

        $(`#${POPUP_ID}`).remove();
        $(`#${POPUP_ID}-overlay`).remove();
        console.log("[剧情助手] 弹窗已关闭");
      } catch (e) {
        console.error("[剧情助手] 关闭弹窗失败:", e);
      }
    }

    $(`#close-${POPUP_ID}`)
      .on("click", closePopup)
      .hover(
        function () {
          $(this).css("color", "#fff");
        },
        function () {
          $(this).css("color", "#aaa");
        },
      );

    $(`#${POPUP_ID}-auto-small`)
      .on("click", () => {
        closePopup();
        runAutoSmallSummary();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-set-offset`)
      .on("click", () => {
        closePopup();
        runSetOffset();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-auto-large`)
      .on("click", () => {
        closePopup();
        runAutoLargeSummary();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-hide-floor`)
      .on("click", () => {
        closePopup();
        openHideFloorDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-novel-entry`)
      .on("click", () => {
        closePopup();
        openNovelEntryDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    // 摘要提取：点击弹出"是否在顶部导航栏增加「小说摘要提取」功能"确认框（原生弹窗，
    // 选是/选否都会自动关闭该弹窗），选择完成后再关闭剧情助手控制面板本身。
    $(`#${POPUP_ID}-novel-summary-toggle`)
      .on("click", async () => {
        await openNovelSummaryNavbarToggleDialog();
        closePopup();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    // 剧情录入·自动跳转章节：点击只切换开关状态，不关闭弹窗（跟移动端优化两个开关同一个视觉模式，
    // 但配色常量单独声明一份——移动端优化那两个 MOBILE_OPT_ON/OFF_STYLE 常量在本函数更后面才 const
    // 声明，这里提前引用会踩 TDZ）。
    const NOVEL_AUTOJUMP_ON_STYLE = { background: "#3a9d5a" };
    const NOVEL_AUTOJUMP_OFF_STYLE = { background: "#555" };
    const $novelAutoJumpBtn = $(`#${POPUP_ID}-novel-autojump`);
    function renderNovelAutoJumpButton($btn, isOn) {
      $btn
        .text(isOn ? "自跳转开" : "自跳转关")
        .css(isOn ? NOVEL_AUTOJUMP_ON_STYLE : NOVEL_AUTOJUMP_OFF_STYLE);
    }
    renderNovelAutoJumpButton($novelAutoJumpBtn, getNovelAutoJumpSettings().enabled);
    $novelAutoJumpBtn.on("click", () => {
      const s = getNovelAutoJumpSettings();
      s.enabled = !s.enabled;
      saveSettingsDebounced();
      renderNovelAutoJumpButton($novelAutoJumpBtn, s.enabled);
    });

    // "当前注入章节"下拉框：切换即时生效（本地写 extension_settings，不产生网络往返），
    // 下一次生成时会自动带上新选的章节内容。
    // 注意：errorCatched 返回的是箭头函数，会丢失 jQuery 通过 this 传入的元素上下文，
    // 这里改用 event.currentTarget 取元素，不依赖 this。
    $(`#${POPUP_ID}-novel-active-chapter`).on(
      "change",
      errorCatched(async (event) => {
        const $select = $(event.currentTarget);
        const val = $select.val();
        const targetUid = val === "__none__" ? null : parseInt(val, 10);
        const label = $select.find("option:selected").text();
        await setActiveNovelChapter(summaryLorebookName, targetUid);
        notify(
          "success",
          targetUid === null ? "已关闭章节注入" : `当前注入章节已切换为「${label}」`,
        );
      }),
    );

    $(`#${POPUP_ID}-status-llm-config`)
      .on("click", () => {
        closePopup();
        openStatusLlmConfigDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-custom-fields`)
      .on("click", () => {
        closePopup();
        openCustomFieldsDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    // 状态表LLM·再分析开关：点击只切换开关状态，不关闭弹窗，跟"自跳转开/关"同一套视觉模式。
    // 关闭（默认）时 extractInventorySetupsForLatestFloor 不会调用状态表LLM，即不发送任何信息给它。
    const $statusLlmReanalyzeBtn = $(`#${POPUP_ID}-status-llm-reanalyze`);
    function renderStatusLlmReanalyzeButton($btn, isOn) {
      $btn
        .text(isOn ? "再分析开" : "再分析关")
        .css(isOn ? NOVEL_AUTOJUMP_ON_STYLE : NOVEL_AUTOJUMP_OFF_STYLE);
    }
    renderStatusLlmReanalyzeButton(
      $statusLlmReanalyzeBtn,
      getStatusLlmSettings().reanalyzeEnabled,
    );
    $statusLlmReanalyzeBtn.on("click", () => {
      const s = getStatusLlmSettings();
      s.reanalyzeEnabled = !s.reanalyzeEnabled;
      saveSettingsDebounced();
      renderStatusLlmReanalyzeButton($statusLlmReanalyzeBtn, s.reanalyzeEnabled);
    });

    $(`#${POPUP_ID}-pre-emphasis`)
      .on("click", () => {
        closePopup();
        openPreEmphasisDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-field-meta-instruction`)
      .on("click", () => {
        closePopup();
        openFieldMetaInstructionDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-create-character`)
      .on("click", () => {
        closePopup();
        openCreateCharacterDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-phone-preset`)
      .on("click", () => {
        closePopup();
        openPhonePresetDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-map-marker`)
      .on("click", () => {
        closePopup();
        openModal();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    // 悬浮球显示开关：点击只切换状态，不关闭弹窗，方便连续切换/立刻在屏幕上看到效果。
    const FAB_TOGGLE_ON_STYLE = { background: "#3a9d5a" };
    const FAB_TOGGLE_OFF_STYLE = { background: "#555" };

    function renderFabToggleButton($btn, visible) {
      $btn
        .text(visible ? "悬浮球开" : "悬浮球关")
        .css(visible ? FAB_TOGGLE_ON_STYLE : FAB_TOGGLE_OFF_STYLE);
    }

    const $fabToggleBtn = $(`#${POPUP_ID}-fab-toggle`);
    renderFabToggleButton($fabToggleBtn, getFabVisible());

    $fabToggleBtn.on("click", () => {
      const nowVisible = !getFabVisible();
      setFabVisibleSetting(nowVisible);
      // 关闭悬浮球时顺带重置位置：不管之前拖到哪、坐标有没有问题，
      // 下次点「悬浮球开」都能回到干净的默认位置，等于顺手兼职一个重置入口。
      if (!nowVisible) resetFabPos();
      applyFabVisibility();
      renderFabToggleButton($fabToggleBtn, nowVisible);
    });

    // 通讯器悬浮球显示开关：逻辑跟上面地图悬浮球那个完全一致，独立的开关/独立的坐标存储。
    const PHONE_FAB_TOGGLE_ON_STYLE = { background: "#3a9d5a" };
    const PHONE_FAB_TOGGLE_OFF_STYLE = { background: "#555" };

    function renderPhoneFabToggleButton($btn, visible) {
      $btn
        .text(visible ? "通讯器开" : "通讯器关")
        .css(visible ? PHONE_FAB_TOGGLE_ON_STYLE : PHONE_FAB_TOGGLE_OFF_STYLE);
    }

    const $phoneFabToggleBtn = $(`#${POPUP_ID}-phone-fab-toggle`);
    renderPhoneFabToggleButton($phoneFabToggleBtn, getPhoneFabVisible());

    $phoneFabToggleBtn.on("click", () => {
      const nowVisible = !getPhoneFabVisible();
      setPhoneFabVisibleSetting(nowVisible);
      if (!nowVisible) resetPhoneFabPos();
      applyPhoneFabVisibility();
      renderPhoneFabToggleButton($phoneFabToggleBtn, nowVisible);
    });

    // 节假日播报开关：逻辑跟悬浮球开关一样，点击只切换状态、不关闭弹窗；
    // 跟悬浮球不同的是这里没有坐标要重置，纯粹是个布尔开关。
    const HOLIDAY_TOGGLE_ON_STYLE = { background: "#3a9d5a" };
    const HOLIDAY_TOGGLE_OFF_STYLE = { background: "#555" };

    function renderHolidayToggleButton($btn, enabled) {
      $btn
        .text(enabled ? "节假日开" : "节假日关")
        .css(enabled ? HOLIDAY_TOGGLE_ON_STYLE : HOLIDAY_TOGGLE_OFF_STYLE);
    }

    const $holidayToggleBtn = $(`#${POPUP_ID}-holiday-toggle`);
    renderHolidayToggleButton($holidayToggleBtn, getHolidayEnabled());

    $holidayToggleBtn.on("click", () => {
      const nowEnabled = !getHolidayEnabled();
      setHolidayEnabledSetting(nowEnabled); // 内部已调用 saveSettingsDebounced()，这里不用再调一次
      renderHolidayToggleButton($holidayToggleBtn, nowEnabled);
    });

    // 提示词模板联动：
    // "动态提示词"按钮打开只读的 EJS 格式说明浮层，关闭后重新打开控制面板（对齐用户对"退回面板"的预期，
    // 跟节假日两个弹窗"点击后直接 closePopup，不主动帮用户重新打开面板"的写法不同，是本栏的特例）；
    // "阶段词开/关"逻辑跟节假日播报开关完全一样，点击只切换状态、不关闭弹窗。
    const PROMPT_TEMPLATE_TOGGLE_ON_STYLE = { background: "#3a9d5a" };
    const PROMPT_TEMPLATE_TOGGLE_OFF_STYLE = { background: "#555" };

    function renderPromptTemplateToggleButton($btn, enabled) {
      $btn
        .text(enabled ? "阶段词开" : "阶段词关")
        .css(enabled ? PROMPT_TEMPLATE_TOGGLE_ON_STYLE : PROMPT_TEMPLATE_TOGGLE_OFF_STYLE);
    }

    const $promptTemplateToggleBtn = $(`#${POPUP_ID}-prompt-template-stage-toggle`);
    renderPromptTemplateToggleButton(
      $promptTemplateToggleBtn,
      getPromptTemplateStageSyncEnabled(),
    );

    $promptTemplateToggleBtn.on("click", () => {
      const nowEnabled = !getPromptTemplateStageSyncEnabled();
      setPromptTemplateStageSyncEnabledSetting(nowEnabled);
      saveSettingsDebounced();
      renderPromptTemplateToggleButton($promptTemplateToggleBtn, nowEnabled);
    });

    $(`#${POPUP_ID}-prompt-template-info`)
      .on("click", async () => {
        closePopup();
        await openPromptTemplateFormatDialog();
        showSummaryPopup();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-holiday-rest-preset`)
      .on("click", () => {
        closePopup();
        openRestPresetDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-holiday-custom`)
      .on("click", () => {
        closePopup();
        openCustomHolidaysDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    // 清空数据后，统一把弹窗里所有"读设置渲染文字+颜色"的开关按钮／下拉框重新刷一遍。
    // 清空数据不会关闭本控制面板弹窗，这些按钮在弹窗里已经渲染过一次了，对应的 extension_settings
    // 被清空数据流程删掉/还原后，如果不重新调用各自的 render 函数，按钮显示的开/关状态会跟被清空后的
    // 实际设置不一致，得等用户手动刷新页面或碰巧点一下对应开关才会更新。
    // 依赖的这些按钮变量/render 函数虽然有的在本函数更后面才声明（如移动端优化两个按钮），
    // 但这是一个函数声明会被提升，且真正调用只会发生在用户点击"清空数据"之后——
    // 那时弹窗已经整体渲染完毕，所有变量都已赋值，不会有 TDZ 问题。
    function syncAllPanelTogglesAfterClear() {
      renderPhoneFabToggleButton($phoneFabToggleBtn, getPhoneFabVisible());
      renderFabToggleButton($fabToggleBtn, getFabVisible());
      renderNovelAutoJumpButton(
        $novelAutoJumpBtn,
        getNovelAutoJumpSettings().enabled,
      );
      renderHolidayToggleButton($holidayToggleBtn, getHolidayEnabled());
      renderPromptTemplateToggleButton(
        $promptTemplateToggleBtn,
        getPromptTemplateStageSyncEnabled(),
      );
      const mobileOptSettingsNow = getMobileOptSettings();
      renderMobileOptButton($mobileOptRenderBtn, mobileOptSettingsNow.renderOptimize);
      renderMobileOptButton($mobileOptLazyBtn, mobileOptSettingsNow.lazyLoad);
      renderStatusLlmReanalyzeButton(
        $statusLlmReanalyzeBtn,
        getStatusLlmSettings().reanalyzeEnabled,
      );
      // "当前注入章节"下拉框：清空数据不影响已录入的章节列表本身，只会把"当前激活章节"这项设置
      // 还原为默认（不注入任何章节），所以这里不用重新拉取章节列表，直接把选中项拨回 __none__ 即可。
      $(`#${POPUP_ID}-novel-active-chapter`).val("__none__");
    }

    // 清空数据：二次确认，确认后清空本地缓存（不含世界书总结条目），成功后提示刷新手机弹窗
    $(`#${POPUP_ID}-clear-all-data`).on(
      "click",
      errorCatched(async () => {
        const context = getCtx();
        const confirmed = await context.callGenericPopup(
          "确定要清空本插件的本地缓存数据吗？",
          context.POPUP_TYPE.CONFIRM,
          "",
          { okButton: "清空", cancelButton: "取消" },
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;

        const { allDbOk } = await clearAllPluginLocalData();
        syncAllPanelTogglesAfterClear();
        if (allDbOk) {
          notify(
            "success",
            "已清空本地缓存数据。手机弹窗里的背景、头像等已被清除，建议重新打开一下手机弹窗。",
          );
        } else {
          notify(
            "warning",
            "部分数据库清空时被浏览器阻塞（可能有页面连接未关闭），其余数据已清空。请刷新页面后重新点一次「清空数据」。",
          );
        }
      }),
    );

    // 移动端优化：两个开关按钮，点击只切换状态，不关闭弹窗
    const MOBILE_OPT_ON_STYLE = { background: "#3a9d5a" };
    const MOBILE_OPT_OFF_STYLE = { background: "#555" };

    function renderMobileOptButton($btn, isOn) {
      $btn
        .text(isOn ? "已开启" : "未开启")
        .css(isOn ? MOBILE_OPT_ON_STYLE : MOBILE_OPT_OFF_STYLE);
    }

    const $mobileOptRenderBtn = $(`#${POPUP_ID}-mobile-opt-render`);
    const $mobileOptLazyBtn = $(`#${POPUP_ID}-mobile-opt-lazyload`);
    const mobileOptSettings = getMobileOptSettings();
    renderMobileOptButton(
      $mobileOptRenderBtn,
      mobileOptSettings.renderOptimize,
    );
    renderMobileOptButton($mobileOptLazyBtn, mobileOptSettings.lazyLoad);

    $mobileOptRenderBtn.on("click", () => {
      const s = getMobileOptSettings();
      s.renderOptimize = !s.renderOptimize;
      if (s.renderOptimize) {
        enableRenderOptimizeGroup();
      } else {
        disableRenderOptimizeGroup();
      }
      saveSettingsDebounced();
      renderMobileOptButton($mobileOptRenderBtn, s.renderOptimize);
    });

    $mobileOptLazyBtn.on("click", () => {
      const s = getMobileOptSettings();
      s.lazyLoad = !s.lazyLoad;
      if (s.lazyLoad) {
        enableLazyLoadGroup();
      } else {
        disableLazyLoadGroup();
      }
      saveSettingsDebounced();
      renderMobileOptButton($mobileOptLazyBtn, s.lazyLoad);
    });

    // 全局世界书挂载：真正的开关按钮。
    // 未挂载 -> 点击走"挂载"流程（会检测其他全局书，问是否顺带清理，只保留这一本）；
    // 已挂载 -> 点击只做单纯的 toggle off，不碰其他全局书，方便"先摘旧角色卡，再挂新角色卡"这种切换场景。
    const MOUNT_GLOBAL_ON_STYLE = { background: "#3a9d5a", cursor: "pointer" };
    const MOUNT_GLOBAL_OFF_STYLE = { background: "#555", cursor: "pointer" };

    function renderMountGlobalButton($btn, isOn) {
      $btn
        .text(isOn ? "全局挂载" : "尚未挂载")
        .css(isOn ? MOUNT_GLOBAL_ON_STYLE : MOUNT_GLOBAL_OFF_STYLE);
    }

    const $mountGlobalBtn = $(`#${POPUP_ID}-mount-global`);
    renderMountGlobalButton($mountGlobalBtn, isMountedGlobally);
    $mountGlobalBtn.data("mounted", isMountedGlobally);

    $mountGlobalBtn.on("click", async () => {
      const context = getCtx();
      try {
        if ($mountGlobalBtn.data("mounted")) {
          // 取消挂载：只 toggle off 这一本，不做任何清理
          await context.executeSlashCommandsWithOptions(
            `/world silent=true state=off "${summaryLorebookName}"`,
          );
        } else {
          // 挂载：保留原有"检测其他全局书，问是否顺带清理"的逻辑
          await mountSummaryLorebookGlobally(summaryLorebookName);
        }
        const nowMounted =
          await isSummaryLorebookGloballyEnabled(summaryLorebookName);
        $mountGlobalBtn.data("mounted", nowMounted);
        renderMountGlobalButton($mountGlobalBtn, nowMounted);
        notify(
          "success",
          nowMounted
            ? `已挂载「${summaryLorebookName}」为全局世界书`
            : `已取消挂载「${summaryLorebookName}」`,
        );
      } catch (error) {
        console.error("[剧情助手] 切换全局世界书挂载状态时出错:", error);
        notify("error", `切换全局世界书挂载状态时出错: ${error.message}`);
      }
    });
    $mountGlobalBtn.data("mounted", isMountedGlobally);

    // 世界书条目交互（展开/收起）
    $(document).on("click", ".lorebook-entry .entry-header", function () {
      const $content = $(this)
        .closest(".lorebook-entry")
        .find(".entry-content");
      const $toggle = $(this).find(".entry-toggle");

      if ($content.is(":visible")) {
        $content.hide();
        $toggle.text("▼");
      } else {
        $content.show();
        $toggle.text("▲");
      }
    });

    // 保存按钮事件
    $(document).on("click", ".entry-save", async function (e) {
      e.stopPropagation();
      const uid = $(this).data("uid");
      const $entry = $(this).closest(".lorebook-entry");
      const $textarea = $entry.find(".entry-textarea");
      const $title = $entry.find(".entry-header div:first");
      const titleText = $title.text();
      const updatedContent = $textarea.val();

      try {
        const context = getCtx();
        const lorebookName = await getOrCreateSummaryLorebook();
        const numericUid = parseInt(uid, 10);
        if (isNaN(numericUid)) throw new Error(`无效的条目ID: ${uid}`);

        const data = await context.loadWorldInfo(lorebookName);
        if (!data || !data.entries || !(numericUid in data.entries)) {
          throw new Error("世界书条目不存在，可能已被删除。");
        }
        data.entries[numericUid].content = updatedContent;
        await context.saveWorldInfo(lorebookName, data, true);
        notifyWorldInfoUpdated(lorebookName);

        notify("success", `已保存世界书条目: ${titleText}`);

        setTimeout(async () => {
          try {
            const $loreBookSection = $(`#${SUMMARY_POPUP_ID}-lorebook`);
            if ($loreBookSection.length > 0) {
              const updatedEntriesHTML =
                await getLorebookEntriesSummaryHtml(lorebookName);
              $loreBookSection.html(updatedEntriesHTML);
            }
          } catch (refreshError) {
            console.warn("[剧情助手] 刷新世界书显示时出错:", refreshError);
          }
        }, 500);
      } catch (error) {
        console.error("[剧情助手] 保存世界书条目时出错:", error);
        notify("error", `保存世界书条目时出错: ${error.message}`);
      }
    });

    // 删除按钮事件
    $(document).on("click", ".entry-delete", async function (e) {
      e.stopPropagation();
      const uid = $(this).data("uid");
      const $entry = $(this).closest(".lorebook-entry");
      const title = $entry.find(".entry-header div:first").text();

      const context = getCtx();
      const confirmed = await context.callGenericPopup(
        `确定要删除世界书条目 <b>${title}</b> 吗？`,
        context.POPUP_TYPE.CONFIRM,
        "",
        { okButton: "删除", cancelButton: "取消" },
      );
      if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) {
        console.log("[剧情助手] 用户取消删除条目:", title);
        return;
      }

      try {
        const lorebookName = await getOrCreateSummaryLorebook();
        const numericUid = parseInt(uid, 10);
        if (isNaN(numericUid)) throw new Error(`无效的条目ID: ${uid}`);

        const data = await context.loadWorldInfo(lorebookName);
        if (data && data.entries && numericUid in data.entries) {
          delete data.entries[numericUid];
          await context.saveWorldInfo(lorebookName, data, true);
          notifyWorldInfoUpdated(lorebookName);
        }

        $entry.fadeOut(300, function () {
          $(this).remove();
        });

        notify("success", `已删除世界书条目: ${title}`);
      } catch (error) {
        console.error("[剧情助手] 删除世界书条目时出错:", error);
        notify("error", `删除世界书条目时出错: ${error.message}`);
      }
    });
  } catch (error) {
    console.error("[剧情助手] 错误提醒:", error);
    notify("error", `错误提醒: ${error.message}`);
  }
}
