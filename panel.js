"use strict";

import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { openCreateCharacterDialog } from "./modules/character.js";
import { getNovelAutoJumpSettings } from "./modules/novel/generator.js";
import { getActiveNovelChapterUid, listNovelChapterEntries, setActiveNovelChapter } from "./modules/novel/store.js";
import { openNovelEntryDialog } from "./modules/novel/ui.js";
import { LOCAL_CHAT_STORE_KEY, PHONE_IDB_NAME, SUMMARY_POPUP_ID, errorCatched, getCtx, getOffsetRecord, localChatStoreCache, notify, transientChatMetadataStore } from "./modules/core.js";
import { IDB_NAME, MAP_MODULE_NAME, getFabVisible, setFabVisibleSetting } from "./modules/map/data.js";
import { FAB_POS_KEY, applyFabVisibility, openModal, resetFabPos } from "./modules/map/ui.js";
import { MOBILE_OPT_SETTINGS_KEY, disableLazyLoadGroup, disableRenderOptimizeGroup, enableLazyLoadGroup, enableRenderOptimizeGroup, getMobileOptSettings } from "./modules/mobile-opt.js";
import { PHONE_MODULE_NAME, getPhoneFabVisible, setPhoneFabVisibleSetting } from "./modules/phone/store.js";
import { PHONE_FAB_POS_KEY, applyPhoneFabVisibility, openPhonePresetDialog, resetPhoneFabPos } from "./modules/phone/ui.js";
import { ensureSummaryLorebookOnLoad, runAutoLargeSummary, runAutoSmallSummary, runSetOffset } from "./modules/summary/generator.js";
import { openPreEmphasisDialog } from "./modules/summary/ui.js";
import { getLorebookEntriesSummaryHtml, getOrCreateSummaryLorebook, isSummaryLorebookGloballyEnabled, mountSummaryLorebookGlobally, notifyWorldInfoUpdated } from "./modules/worldinfo.js";


// === Helper: 转义 HTML 特殊字符（章节名是用户自由输入的，拼进 <option> 前需要转义） ===
function escapeNovelChapterLabel(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
// 范围：两个 IndexedDB 库（私信/头像/图片/背景 + 地图图片）、两个悬浮球位置的 localStorage、
// 三块插件自己的 extension_settings（通讯器/地图/移动端优化，删掉后下次读取会自动用默认值重建）、
// 以及所有对话的起始楼层记录和私信忙闲缓存（本地存储，一份 localStorage 覆盖所有对话，一次性清空）。
// 不包含：总结功能生成的世界书条目（用户自己在世界书里删）。
export async function clearAllPluginLocalData() {
  const results = await Promise.all([
    deleteIndexedDatabase(PHONE_IDB_NAME),
    deleteIndexedDatabase(IDB_NAME),
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
    saveSettingsDebounced();
  } catch (error) {
    console.error("[剧情助手] 重置插件配置失败:", error);
  }

  try {
    localStorage.removeItem(LOCAL_CHAT_STORE_KEY);
    localChatStoreCache = null; // 内存缓存也一并重置，避免清空后马上又读到清空前的旧对象
    transientChatMetadataStore = null;
  } catch (error) {
    console.error("[剧情助手] 清空所有对话的楼层/忙闲缓存失败:", error);
  }

  const allDbOk = results.every(Boolean);
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
    const currentOffsetRecord = getOffsetRecord();
    const currentOffsetDisplay = currentOffsetRecord
      ? `第 ${currentOffsetRecord.offset} 层`
      : "未设置（默认第 0 层，不偏移）";

    // "当前进度"下拉框数据：章节列表已经按标题里的序号排好序，直接用于展示；
    // 同时探测当前哪一章处于启用状态，作为下拉框默认选中项。
    const novelChapters = await listNovelChapterEntries(summaryLorebookName);
    const { activeUid: activeNovelChapterUid, hasConflict: novelChapterConflict } =
      await getActiveNovelChapterUid(summaryLorebookName);
    const novelChapterOptionsHTML =
      novelChapters.length === 0
        ? `<option value="">暂无章节，请先录入</option>`
        : [`<option value=""${activeNovelChapterUid === null ? " selected" : ""}>-- 不启用任何章节 --</option>`]
            .concat(
              novelChapters.map((chapter) => {
                const orderLabel = String(chapter.order).padStart(3, "0");
                const selected = chapter.uid === activeNovelChapterUid ? " selected" : "";
                return `<option value="${chapter.uid}"${selected}>${orderLabel} ${escapeNovelChapterLabel(chapter.name)}</option>`;
              }),
            )
            .join("");

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
            <button id="${POPUP_ID}-auto-small" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">自动小总结</button>
            <button id="${POPUP_ID}-set-offset" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">设定起始楼层</button>
            <button id="${POPUP_ID}-auto-large" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">自动大总结</button>
          </div>
          <div style="margin-top: 8px; font-size: 12px; color: #888;">本对话当前起始楼层：<span style="color: #aaa;">${currentOffsetDisplay}</span></div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">同人小说</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <button id="${POPUP_ID}-novel-entry" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">剧情录入</button>
              <span style="color: #888; font-size: 12px;">当前进度：</span>
              <select id="${POPUP_ID}-novel-chapter-select" ${novelChapters.length === 0 ? "disabled" : ""} style="background: #262626; color: #ddd; border: 1px solid #444; border-radius: 4px; padding: 6px 8px; font-size: 13px; max-width: 200px;">
                ${novelChapterOptionsHTML}
              </select>
            </div>
            <button id="${POPUP_ID}-novel-autojump" title="AI在摘要里判定当前章节已演绎完/过时时，自动切到下一章（没有下一章则关闭章节注入）" style="border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;"></button>
          </div>
          ${novelChapterConflict ? `<div style="margin-top: 6px; font-size: 12px; color: #e0a030;">检测到不止一章同时启用（可能在原生世界书面板里手动改过），下拉框暂显示序号最小的一章；重新选择一次即可统一收敛为一章。</div>` : ""}
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">输出强调</p>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button id="${POPUP_ID}-pre-emphasis" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">对话前强调</button>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">联系人</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <button id="${POPUP_ID}-create-character" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">添加联系人</button>
              <button id="${POPUP_ID}-phone-preset" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">私信预设</button>
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
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px;">
            <p style="color: #72b1e8; font-weight: 500; margin: 0;">世界书条目 (${summaryLorebookName})</p>
            <button id="${POPUP_ID}-mount-global" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
          <div id="${POPUP_ID}-lorebook" style="background: #333; border-radius: 6px; padding: 10px; font-size: 13px;">
            ${lorebookEntriesHTML}
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">数据管理</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0;">
            <span style="font-size: 12px; color: #999; flex: 1;">清空私信记录、头像库、图片库、背景库、地图标记数据、悬浮球位置记忆、所有对话的起始楼层/忙闲缓存等本地缓存（不含世界书总结条目）</span>
            <button id="${POPUP_ID}-clear-all-data" style="background: #c0392b; border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;">清空数据</button>
          </div>
        </div>

        <div>
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">移动端优化</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0;">
            <span style="font-size: 12px; color: #999; flex: 1;">折叠预设滑块 · 优化输入法弹窗 · 优化长聊渲染</span>
            <button id="${POPUP_ID}-mobile-opt-render" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid #3a3a3a;">
            <span style="font-size: 12px; color: #999; flex: 1;">懒加载头像与角色列表 · 不预载最近聊天页对话</span>
            <button id="${POPUP_ID}-mobile-opt-lazyload" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
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

    $(`#${POPUP_ID}-novel-chapter-select`).on("change", async function () {
      const val = $(this).val();
      const targetUid = val === "" ? null : parseInt(val, 10);
      const label = $(this).find("option:selected").text();
      try {
        await setActiveNovelChapter(summaryLorebookName, targetUid);
        notify("success", `已切换到「${label}」`);
      } catch (error) {
        console.error("[剧情助手] 切换原著章节进度失败:", error);
        notify("error", `切换失败：${error.message || error}`);
      }
    });

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

    // 清空数据：二次确认，确认后清空本地缓存（不含世界书总结条目），成功后提示刷新手机弹窗
    $(`#${POPUP_ID}-clear-all-data`).on(
      "click",
      errorCatched(async () => {
        const context = getCtx();
        const confirmed = await context.callGenericPopup(
          "确定要清空本插件的本地缓存数据吗？包括：私信记录、头像库、图片库、背景库、地图标记数据、悬浮球位置记忆、所有对话的起始楼层记录和私信忙闲缓存。<br>不包含世界书里生成的总结条目。<br>此操作不可撤销。",
          context.POPUP_TYPE.CONFIRM,
          "",
          { okButton: "清空", cancelButton: "取消" },
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;

        const { allDbOk } = await clearAllPluginLocalData();
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
    const MOUNT_GLOBAL_OFF_STYLE = { background: "#3a7bd5", cursor: "pointer" };

    function renderMountGlobalButton($btn, isOn) {
      $btn
        .text(isOn ? "取消挂载" : "挂载为全局世界书")
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
