"use strict";

import { SUMMARY_BUTTON_ICON, SUMMARY_BUTTON_ID, SUMMARY_BUTTON_TEXT, SUMMARY_BUTTON_TOOLTIP, delay, notify } from "./modules/core.js";
import { showSummaryPopup } from "./panel.js";
import { registerLorebookAutoCreate, registerStatusTableAutoUpdate } from "./modules/summary/generator.js";
import { applyMobileOptSettingsOnLoad } from "./modules/mobile-opt.js";
import { injectPhoneFloatingButton } from "./modules/phone/ui.js";
import { registerPhoneSlotInjection } from "./modules/phone/generator.js";
import { registerHolidayInjection } from "./modules/phone/holiday.js";
import { getSettings } from "./modules/map/data.js";
import { injectFloatingButton, registerMapGlobalEvents } from "./modules/map/ui.js";
import { syncMapInfoEntry } from "./modules/map/generator.js";
import { registerNovelAutoJump } from "./modules/novel/generator.js";


// === Function: 在扩展菜单里插入「剧情助手」入口 ===
export function createMenuButton() {
  try {
    let $button = $(`#${SUMMARY_BUTTON_ID}`);

    if ($button.length > 0) return; // 已存在则不重复插入

    addButtonStyles();

    const buttonHtml = `
      <div id="${SUMMARY_BUTTON_ID}" class="list-group-item flex-container flexGap5 interactable"
           title="${SUMMARY_BUTTON_TOOLTIP}" tabIndex="0">
        <i class="${SUMMARY_BUTTON_ICON}"></i>
        <span>${SUMMARY_BUTTON_TEXT}</span>
      </div>
    `;

    const $extensionsMenu = $("#extensionsMenu");

    if ($extensionsMenu.length) {
      $extensionsMenu.append(buttonHtml);
      $(document)
        .off(`click.${SUMMARY_BUTTON_ID}`)
        .on(`click.${SUMMARY_BUTTON_ID}`, `#${SUMMARY_BUTTON_ID}`, (event) => {
          event.preventDefault();
          showSummaryPopup();
        });
      console.log("[剧情助手] 按钮已插入扩展菜单");
    } else {
      console.warn("[剧情助手] 未找到扩展菜单 (#extensionsMenu)");
    }
  } catch (error) {
    console.error("[剧情助手] 创建菜单按钮时出错:", error);
  }
}


export function addButtonStyles() {
  if ($("#summary-assistant-button-styles").length === 0) {
    const styles = `
      <style id="summary-assistant-button-styles">
        #${SUMMARY_BUTTON_ID} {
          cursor: pointer;
        }
      </style>
    `;
    $("head").append(styles);
  }
}

// === Initialization ===
jQuery(() => {
  console.log("[剧情助手] 初始化...");
  createMenuButton();
  registerLorebookAutoCreate();
  registerStatusTableAutoUpdate();

  // --- 移动端优化模块 ---
  applyMobileOptSettingsOnLoad(); // 默认关闭，只有之前手动开启过才会在这里生效

  // --- 通讯器（手机）悬浮窗模块 ---
  injectPhoneFloatingButton(); // 默认关闭，只有之前手动开启过才会在这里显示出来
  registerPhoneSlotInjection(); // 私信槽位：生成前注入当天新私信，生成后立即清空

  // --- 星期/节假日播报模块（独立于通讯器，无开关，插件加载即生效） ---
  registerHolidayInjection(); // 生成前从最后一层摘要 Time 字段现算星期/附近节假日并注入，生成后立即清空

  // --- 剧情录入模块：自动跳转章节（默认关闭，面板"自跳转开/自跳转关"按钮控制） ---
  registerNovelAutoJump();

  // --- 地图标记模块 ---
  getSettings(); // 确保当前角色（或临时）的地图数据结构已就绪
  injectFloatingButton();
  registerMapGlobalEvents();
  // 插件刚加载时如果已经在某个角色的聊天里，主动同步一次「地图信息」条目，不用等切换聊天才触发；
  // 延迟一下给酒馆本身留出初始化时间，跟世界书自动创建那边的 1500ms 错开，避免同时抢着读写世界书。
  delay(1600).then(() => syncMapInfoEntry(false));

  notify("info", "初始化完成，可从扩展菜单中打开「剧情助手」。");
  console.log("[剧情助手] 初始化完成。");
});
