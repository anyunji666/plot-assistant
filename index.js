"use strict";

import { SUMMARY_BUTTON_ICON, SUMMARY_BUTTON_ID, SUMMARY_BUTTON_TEXT, SUMMARY_BUTTON_TOOLTIP, delay } from "./modules/core.js";
import { showSummaryPopup } from "./panel.js";
import { registerLorebookAutoCreate } from "./modules/summary/generator.js";
import { registerStatusTableAutoUpdate } from "./modules/summary/status-llm-extract.js";
import { applyMobileOptSettingsOnLoad } from "./modules/mobile-opt.js";
import { injectPhoneFloatingButton } from "./modules/phone/ui.js";
import { registerPhoneSlotInjection } from "./modules/phone/generator.js";
import { registerHolidayInjection } from "./modules/holiday/inject.js";
import { getSettings } from "./modules/map/data.js";
import { injectFloatingButton, registerMapGlobalEvents } from "./modules/map/ui.js";
import { syncMapInfoEntry } from "./modules/map/generator.js";
import { registerNovelAutoJump } from "./modules/novel/generator.js";
import { initNovelSummaryModule } from "./modules/novel-summary/ui.js";
import { initSummaryBeautify } from "./modules/beautify/render.js";


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

  // --- 节假日模块（完全独立模块，默认关闭，面板"节假日开/节假日关"按钮控制） ---
  registerHolidayInjection(); // 生成前若开关开启，从最后一层摘要 Time 字段现算星期/附近节假日并注入，生成后立即清空

  // --- 摘要卡片美化（默认开启，纯前端显示层，不改楼层原文，不需要开关） ---
  initSummaryBeautify();

  // --- 剧情录入模块：自动跳转章节（默认关闭，面板"自跳转开/自跳转关"按钮控制） ---
  registerNovelAutoJump();

  // --- 摘要提取模块（原独立扩展 novel-summary，现合并进本插件）：
  // 顶部导航栏图标默认关闭，只有面板"摘要提取"按钮的确认弹窗选"是"才会显示 ---
  initNovelSummaryModule().catch((error) => {
    console.error("[剧情助手] 摘要提取模块初始化失败:", error);
  });

  // --- 地图标记模块 ---
  getSettings(); // 确保当前角色（或临时）的地图数据结构已就绪
  injectFloatingButton();
  registerMapGlobalEvents();
  // 插件刚加载时如果已经在某个角色的聊天里，主动同步一次「地图信息」条目，不用等切换聊天才触发；
  // 延迟一下给酒馆本身留出初始化时间，跟世界书自动创建那边的 1500ms 错开，避免同时抢着读写世界书。
  delay(1600).then(() => syncMapInfoEntry(false));

  console.log("[剧情助手] 初始化完成。");
});
