"use strict";

import { extension_settings } from "../../../../extensions.js";
import { delay, getCtx, notify } from "./core.js";


// =====================================================================================
// 移动端优化模块：默认关闭，可在控制面板里随时开关的两组功能：
//   开关①「渲染/输入优化」= 折叠预设滑块 + 优化长聊渲染
//   开关②「懒加载优化」  = 懒加载头像与角色列表 + 不预载最近聊天页对话
// 开关状态存进 extension_settings（全局设置，随酒馆账号走，不跟随单个角色卡/对话）。
// =====================================================================================

export const MOBILE_OPT_SETTINGS_KEY = "plot_assistant_mobile_optimize";

export const MOBILE_OPT_LOG_PREFIX = "[剧情助手/移动端优化]";


export function getMobileOptSettings() {
  if (!extension_settings[MOBILE_OPT_SETTINGS_KEY]) {
    extension_settings[MOBILE_OPT_SETTINGS_KEY] = {
      renderOptimize: false,
      lazyLoad: false,
    };
  }
  const s = extension_settings[MOBILE_OPT_SETTINGS_KEY];
  if (typeof s.renderOptimize !== "boolean") s.renderOptimize = false;
  if (typeof s.lazyLoad !== "boolean") s.lazyLoad = false;
  return s;
}


// 通用防抖，用于 MutationObserver 回调合并高频 DOM 变化
export function mobileOptDebounce(fn, delay) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}


// ------------------------------------------------------------
// 子功能 A1：长聊天渲染优化（content-visibility）
// ------------------------------------------------------------
export const MOBILE_OPT_LONG_CHAT_THRESHOLD = 60;

export const MOBILE_OPT_OFFSCREEN_BUFFER = "800px 0px 800px 0px";

export let longChatState = null;


export function initLongChatOptimization() {
  if (longChatState) return;
  if (!("IntersectionObserver" in window)) {
    console.warn(
      `${MOBILE_OPT_LOG_PREFIX} 当前浏览器不支持 IntersectionObserver，长聊天渲染优化未启用`,
    );
    return;
  }
  const chatEl = document.getElementById("chat");
  if (!chatEl) {
    console.warn(
      `${MOBILE_OPT_LOG_PREFIX} 未找到 #chat 容器，长聊天渲染优化未启用`,
    );
    return;
  }

  if (!document.getElementById("lite-opt-long-chat-style")) {
    const style = document.createElement("style");
    style.id = "lite-opt-long-chat-style";
    style.textContent = `
      .lite-opt-long-chat .mes.lite-opt-offscreen {
        content-visibility: auto;
        contain-intrinsic-size: 0 300px;
      }
    `;
    document.head.appendChild(style);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle(
          "lite-opt-offscreen",
          !entry.isIntersecting,
        );
      }
    },
    { root: chatEl, rootMargin: MOBILE_OPT_OFFSCREEN_BUFFER, threshold: 0 },
  );

  function refresh() {
    const mesList = chatEl.querySelectorAll(".mes");
    if (mesList.length < MOBILE_OPT_LONG_CHAT_THRESHOLD) {
      chatEl.classList.remove("lite-opt-long-chat");
      observer.disconnect();
      mesList.forEach((mes) => mes.classList.remove("lite-opt-offscreen"));
      return;
    }
    chatEl.classList.add("lite-opt-long-chat");
    mesList.forEach((mes) => observer.observe(mes));
  }

  const mo = new MutationObserver(mobileOptDebounce(() => refresh(), 120));
  mo.observe(chatEl, { childList: true });
  refresh();

  longChatState = { mo, observer, chatEl };
}


export function disableLongChatOptimization() {
  if (!longChatState) return;
  longChatState.mo.disconnect();
  longChatState.observer.disconnect();
  longChatState.chatEl.classList.remove("lite-opt-long-chat");
  longChatState.chatEl
    .querySelectorAll(".mes.lite-opt-offscreen")
    .forEach((mes) => mes.classList.remove("lite-opt-offscreen"));
  longChatState = null;
}


// ------------------------------------------------------------
// 子功能 A4：预设界面折叠（一次性 DOM 改造，不做实时还原）
// 关闭开关时只提示"刷新页面后生效"，不做复杂的 DOM 复原逻辑。
// ------------------------------------------------------------
export const MOBILE_OPT_PRESET_COLLAPSE_TARGET_IDS = [
  "range_block_openai",
  "wrapper_openai",
];

export const MOBILE_OPT_PRESET_COLLAPSE_WRAPPER_ID = "lite-opt-preset-collapse";

export let presetCollapseMo = null;

export let presetCollapseApplied = false;


export function initPresetCollapse() {
  if (presetCollapseMo) return;

  function tryCollapse() {
    const existing = document.getElementById(
      MOBILE_OPT_PRESET_COLLAPSE_WRAPPER_ID,
    );
    const targets = MOBILE_OPT_PRESET_COLLAPSE_TARGET_IDS.map((id) =>
      document.getElementById(id),
    ).filter((el) => el && !existing?.contains(el));

    if (targets.length === 0) return;

    const details = document.createElement("details");
    details.id = MOBILE_OPT_PRESET_COLLAPSE_WRAPPER_ID;
    details.open = false;

    const summary = document.createElement("summary");
    summary.textContent = "预设设置（更多）";
    summary.style.cursor = "pointer";
    summary.style.opacity = "0.8";
    details.appendChild(summary);

    const anchor = targets[0];
    anchor.parentElement.insertBefore(details, anchor);
    targets.forEach((el) => details.appendChild(el));
    presetCollapseApplied = true;
  }

  tryCollapse();
  presetCollapseMo = new MutationObserver(
    mobileOptDebounce(() => tryCollapse(), 120),
  );
  presetCollapseMo.observe(document.body, { childList: true, subtree: true });
}


// 关闭开关时调用：停止继续折叠新出现的预设块；已经折叠过的块提示刷新页面还原
export function disablePresetCollapse() {
  if (presetCollapseMo) {
    presetCollapseMo.disconnect();
    presetCollapseMo = null;
  }
  if (presetCollapseApplied) {
    notify("info", "预设折叠效果需要刷新页面才能完全取消。");
    presetCollapseApplied = false;
  }
}


// ------------------------------------------------------------
// 开关① 汇总：渲染/输入优化
// ------------------------------------------------------------
export function enableRenderOptimizeGroup() {
  initPresetCollapse();
  initLongChatOptimization();
}


export function disableRenderOptimizeGroup() {
  disablePresetCollapse();
  disableLongChatOptimization();
}


// ------------------------------------------------------------
// 子功能 B1：头像缩略图懒加载
// ------------------------------------------------------------
export const MOBILE_OPT_AVATAR_SELECTORS = [
  "#rm_print_characters_block .avatar img",
  "#rm_print_characters_block img.avatar",
  ".recent_chat_avatar img",
  "#right-nav-panel .avatar img",
];

export const MOBILE_OPT_PLACEHOLDER_SRC =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
  );

export let avatarLazyLoadState = null;


export function initAvatarLazyLoad() {
  if (avatarLazyLoadState) return;
  const hasIO = "IntersectionObserver" in window;
  if (!hasIO) {
    console.warn(
      `${MOBILE_OPT_LOG_PREFIX} 当前浏览器不支持 IntersectionObserver，头像懒加载未启用`,
    );
  }

  const observer = hasIO
    ? new IntersectionObserver(
        (entries, obs) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const img = entry.target;
            const realSrc = img.dataset.liteSrc;
            if (realSrc) {
              img.src = realSrc;
              delete img.dataset.liteSrc;
            }
            obs.unobserve(img);
          }
        },
        { rootMargin: "400px 0px 400px 0px" },
      )
    : null;

  function processImg(img) {
    if (img.dataset.liteProcessed) return;
    const realSrc = img.getAttribute("src");
    if (!realSrc || realSrc.startsWith("data:")) return;

    img.dataset.liteProcessed = "1";
    img.loading = "lazy";
    img.decoding = "async";

    if (observer) {
      img.dataset.liteSrc = realSrc;
      img.src = MOBILE_OPT_PLACEHOLDER_SRC;
      observer.observe(img);
    }
  }

  function scan() {
    for (const sel of MOBILE_OPT_AVATAR_SELECTORS) {
      document.querySelectorAll(sel).forEach(processImg);
    }
  }

  const mo = new MutationObserver(mobileOptDebounce(() => scan(), 120));
  mo.observe(document.body, { childList: true, subtree: true });
  scan();

  avatarLazyLoadState = { mo, observer };
}


export function disableAvatarLazyLoad() {
  if (!avatarLazyLoadState) return;
  avatarLazyLoadState.mo.disconnect();
  if (avatarLazyLoadState.observer) avatarLazyLoadState.observer.disconnect();
  avatarLazyLoadState = null;
  // 已替换为占位图但尚未进入可视区域的 <img> 不做强制复原，
  // 用户滚动到附近或刷新页面时会恢复正常显示，不影响使用。
}


// ------------------------------------------------------------
// 子功能 B2：角色列表整行 content-visibility
// ------------------------------------------------------------
export const MOBILE_OPT_CHARACTER_LIST_ROW_SELECTORS = [
  "#rm_print_characters_block .character_select",
  "#rm_print_characters_block .group_select",
];

export const MOBILE_OPT_CHARACTER_ROW_BUFFER = "600px 0px 600px 0px";

export const MOBILE_OPT_CHARACTER_ROW_THRESHOLD = 20;

export let characterListRowState = null;


export function initCharacterListRowOptimization() {
  if (characterListRowState) return;
  if (!("IntersectionObserver" in window)) return;

  if (!document.getElementById("lite-opt-char-list-style")) {
    const style = document.createElement("style");
    style.id = "lite-opt-char-list-style";
    style.textContent = `
      .lite-opt-long-list .lite-opt-row-offscreen {
        content-visibility: auto;
        contain-intrinsic-size: 0 60px;
      }
    `;
    document.head.appendChild(style);
  }

  let observer = null;
  function ensureObserver() {
    if (observer) return observer;
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          entry.target.classList.toggle(
            "lite-opt-row-offscreen",
            !entry.isIntersecting,
          );
        }
      },
      { rootMargin: MOBILE_OPT_CHARACTER_ROW_BUFFER, threshold: 0 },
    );
    return observer;
  }

  function refresh() {
    const container = document.getElementById("rm_print_characters_block");
    if (!container) return;
    const rows = MOBILE_OPT_CHARACTER_LIST_ROW_SELECTORS.flatMap((sel) =>
      Array.from(container.querySelectorAll(sel)),
    );

    if (rows.length < MOBILE_OPT_CHARACTER_ROW_THRESHOLD) {
      container.classList.remove("lite-opt-long-list");
      rows.forEach((row) => row.classList.remove("lite-opt-row-offscreen"));
      return;
    }
    container.classList.add("lite-opt-long-list");
    const obs = ensureObserver();
    rows.forEach((row) => obs.observe(row));
  }

  const mo = new MutationObserver(mobileOptDebounce(() => refresh(), 120));
  mo.observe(document.body, { childList: true, subtree: true });
  refresh();

  characterListRowState = { mo, getObserver: () => observer };
}


export function disableCharacterListRowOptimization() {
  if (!characterListRowState) return;
  characterListRowState.mo.disconnect();
  const observer = characterListRowState.getObserver();
  if (observer) observer.disconnect();
  const container = document.getElementById("rm_print_characters_block");
  if (container) {
    container.classList.remove("lite-opt-long-list");
    container
      .querySelectorAll(".lite-opt-row-offscreen")
      .forEach((row) => row.classList.remove("lite-opt-row-offscreen"));
  }
  characterListRowState = null;
}


// ------------------------------------------------------------
// 子功能 B3：主页进入聊天优化（不预载角色最近激活的聊天，直接打开点击的那个）
// ------------------------------------------------------------
export let welcomeRecentChatClickHandler = null;

export let welcomeRecentChatOpenPromise = null;


export const MOBILE_OPT_WELCOME_RECENT_CHAT_SELECTOR = ".welcomePanel .recentChat";

export const MOBILE_OPT_WELCOME_RECENT_CHAT_ACTION_SELECTOR =
  ".welcomePanel .recentChat .recentChatAction, .welcomePanel .recentChat button, .welcomePanel .recentChat a";


export function initWelcomeRecentChatOptimization() {
  if (welcomeRecentChatClickHandler) return;

  let context = null;
  try {
    context = getCtx();
  } catch (e) {
    console.warn(
      `${MOBILE_OPT_LOG_PREFIX} 调用 getContext() 失败，"不预载最近聊天页对话"未启用`,
      e,
    );
    return;
  }
  if (
    !context ||
    typeof context.selectCharacterById !== "function" ||
    !Array.isArray(context.characters)
  ) {
    console.warn(
      `${MOBILE_OPT_LOG_PREFIX} getContext() 未提供所需接口，"不预载最近聊天页对话"未启用`,
    );
    return;
  }

  welcomeRecentChatClickHandler = (event) =>
    handleWelcomeRecentChatClick(event);
  document.addEventListener("click", welcomeRecentChatClickHandler, true);
}


export function disableWelcomeRecentChatOptimization() {
  if (!welcomeRecentChatClickHandler) return;
  document.removeEventListener("click", welcomeRecentChatClickHandler, true);
  welcomeRecentChatClickHandler = null;
}


export function handleWelcomeRecentChatClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(MOBILE_OPT_WELCOME_RECENT_CHAT_ACTION_SELECTOR))
    return;

  const item = target.closest(MOBILE_OPT_WELCOME_RECENT_CHAT_SELECTOR);
  if (!(item instanceof HTMLElement)) return;

  const avatarId = item.getAttribute("data-avatar");
  const groupId = item.getAttribute("data-group");
  const fileName = item.getAttribute("data-file");

  if (!avatarId || !fileName || groupId) return;

  const context = getCtx();
  const characterId = context.characters.findIndex(
    (c) => c?.avatar === avatarId,
  );
  if (characterId === -1) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  if (welcomeRecentChatOpenPromise) return;
  welcomeRecentChatOpenPromise = openWelcomeRecentChatDirectly(
    characterId,
    fileName,
  )
    .catch((e) => console.error(`${MOBILE_OPT_LOG_PREFIX} 打开最近聊天失败`, e))
    .finally(() => {
      welcomeRecentChatOpenPromise = null;
    });
}


export async function openWelcomeRecentChatDirectly(characterId, fileName) {
  const context = getCtx();
  const character = context.characters[characterId];
  if (!character) return;

  if (String(context.characterId) === String(characterId)) {
    if (
      typeof context.getCurrentChatId === "function" &&
      context.getCurrentChatId() === fileName
    ) {
      return;
    }
    await context.openCharacterChat(fileName);
    return;
  }

  const previousChat = character.chat;
  character.chat = fileName;

  await context.selectCharacterById(characterId);

  const contextAfter = getCtx();
  if (String(contextAfter.characterId) !== String(characterId)) {
    if (character.chat === fileName && previousChat !== fileName) {
      character.chat = previousChat;
    }
    return;
  }

  if (
    typeof contextAfter.getCurrentChatId === "function" &&
    contextAfter.getCurrentChatId() !== fileName
  ) {
    await contextAfter.openCharacterChat(fileName);
  }
}


// ------------------------------------------------------------
// 开关② 汇总：懒加载优化
// ------------------------------------------------------------
export function enableLazyLoadGroup() {
  initAvatarLazyLoad();
  initCharacterListRowOptimization();
  initWelcomeRecentChatOptimization();
}


export function disableLazyLoadGroup() {
  disableAvatarLazyLoad();
  disableCharacterListRowOptimization();
  disableWelcomeRecentChatOptimization();
}


// ------------------------------------------------------------
// 启动时根据已保存设置应用两个开关（默认都是 false，不会自动开启）
// ------------------------------------------------------------
export function applyMobileOptSettingsOnLoad() {
  const s = getMobileOptSettings();
  if (s.renderOptimize) enableRenderOptimizeGroup();
  if (s.lazyLoad) enableLazyLoadGroup();
}
