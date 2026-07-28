"use strict";

import { openCreateCharacterDialog } from "../character.js";
import { PHONE_PRESET_TITLE, errorCatched, getCtx, notify } from "../core.js";
import { sendPhoneMessageToCharacter } from "./generator.js";
import { addPhoneStickers, clearPhoneMessages, deletePhoneChatBackground, deletePhoneGlobalBackground, deletePhoneMessage, deletePhoneSticker, getAllPhoneAvatarsForCurrentCharacter, getAllPhoneMessages, getPhoneChatBackground, getPhoneContactsList, getPhoneFabVisible, getPhoneGlobalBackground, getPhoneStickerList, loadPhonePresetContent, parseContactExtra, readImageFileCompressed, renamePhoneSticker, savePhoneAvatar, savePhoneChatBackground, savePhoneGlobalBackground, savePhonePresetContent, splitStoryTime, updatePhoneMessageText } from "./store.js";


// === Function: 打开"私信预设"编辑框（纯文本，取消/保存，样式对齐"对话前强调"弹窗）===
export async function openPhonePresetDialog() {
  const currentContent = await loadPhonePresetContent();

  const $bodyEl = $("body");
  const prevBodyOverflow = $bodyEl.css("overflow");
  $bodyEl.css("overflow", "hidden");

  const result = await new Promise((resolve) => {
    const $overlay = $("<div>").css({
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: "rgba(0,0,0,0.72)",
      zIndex: 99999,
      boxSizing: "border-box",
    });

    const $box = $("<div>").css({
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#252525",
      border: "1px solid #3a3a3a",
      borderRadius: "10px",
      padding: "clamp(16px, 4vw, 24px)",
      width: "min(480px, calc(100% - 24px))",
      maxHeight: "min(85vh, calc(100dvh - 24px))",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      color: "#e8e8e8",
      fontFamily: "inherit",
      boxSizing: "border-box",
      boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
    });

    const $title = $("<div>").text(PHONE_PRESET_TITLE).css({
      fontSize: "1.05em",
      fontWeight: "600",
      color: "#f0f0f0",
      letterSpacing: "0.01em",
    });

    const $hint = $("<div>")
      .text(
        '手机私信生成回复时的开场白/扮演指令，"联系人"会自动替换成实际联系人姓名。',
      )
      .css({ fontSize: "0.8em", color: "#999", lineHeight: 1.5 });

    const $textarea = $("<textarea>").val(currentContent).css({
      width: "100%",
      boxSizing: "border-box",
      minHeight: "140px",
      padding: "10px",
      borderRadius: "6px",
      border: "1px solid #3a3a3a",
      background: "#1a1a1a",
      color: "#d0d0d0",
      fontSize: "max(0.95em, 16px)",
      fontFamily: "inherit",
      outline: "none",
      resize: "vertical",
    });

    const $btnRow = $("<div>").css({
      display: "flex",
      gap: "10px",
      justifyContent: "flex-end",
      marginTop: "4px",
    });
    const btnCss = {
      padding: "10px 20px",
      borderRadius: "6px",
      minHeight: "44px",
      boxSizing: "border-box",
      cursor: "pointer",
      fontSize: "0.95em",
      touchAction: "manipulation",
    };
    const $cancel = $("<button>")
      .text("取消")
      .css({
        ...btnCss,
        border: "1px solid #3a3a3a",
        background: "transparent",
        color: "#c0c0c0",
      });
    const $confirm = $("<button>")
      .text("保存")
      .css({
        ...btnCss,
        border: "none",
        background: "#5b9cf6",
        color: "#ffffff",
        fontWeight: "600",
      });
    $btnRow.append($cancel, $confirm);

    $box.append($title, $hint, $textarea, $btnRow);
    $overlay.append($box);
    $("body").append($overlay);
    setTimeout(() => $textarea.trigger("focus"), 50);

    const done = (confirmed) => {
      $(document).off("keydown.phonePresetDialog");
      $overlay.remove();
      $bodyEl.css("overflow", prevBodyOverflow || "");
      resolve(confirmed ? $textarea.val() : null);
    };

    $confirm.on("click", () => done(true));
    $cancel.on("click", () => done(false));

    let overlayPointerDownOnSelf = false;
    $overlay.on("mousedown touchstart", (e) => {
      overlayPointerDownOnSelf = $(e.target).is($overlay);
    });
    $overlay.on("mouseup touchend", (e) => {
      if (overlayPointerDownOnSelf && $(e.target).is($overlay)) done(false);
      overlayPointerDownOnSelf = false;
    });
    $(document).on("keydown.phonePresetDialog", (e) => {
      if (e.key === "Escape") done(false);
    });
  });

  if (result === null) return;

  try {
    const lorebookName = await savePhonePresetContent(result);
    notify("success", `「${PHONE_PRESET_TITLE}」已保存到「${lorebookName}」`);
  } catch (error) {
    console.error("[剧情助手] 保存私信预设失败:", error);
    notify("error", `保存私信预设失败：${error.message || error}`);
  }
}


// ==== 手机：通用图片裁剪弹窗（头像 / 全局背景 / 聊天页背景共用一套交互）====
// 用法：openImageCropDialog({ file, title, ratio, shape, outputWidth, outputHeight })
//   file: 用户选中的图片文件
//   ratio: 裁剪框宽高比（宽/高），shape: "circle"（头像用圆形遮罩预览） | "rect"
//   outputWidth/outputHeight: 最终导出画布像素尺寸
// 返回 Promise<string|null>：确定则 resolve 裁剪后的 JPEG dataURL，取消则 resolve null。
// 交互：单指/鼠标拖拽平移，滚轮或双指捏合缩放，另附一个缩放滑杆方便精细调节。
export function openImageCropDialog({
  file,
  title = "裁剪图片",
  ratio = 1,
  shape = "rect",
  outputWidth = 320,
  outputHeight = 320,
  quality = 0.85,
}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.onload = () => {
        try {
          mountCropDialog(img);
        } catch (error) {
          reject(error);
        }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);

    function mountCropDialog(img) {
      document.getElementById("pa-crop-dialog")?.remove();

      // 裁剪框尺寸：按目标比例，在弹窗可用空间内尽量大，但不超出屏幕。
      let viewportW = Math.min(300, window.innerWidth * 0.82);
      let viewportH = viewportW / ratio;
      const maxViewportH = window.innerHeight * 0.56;
      if (viewportH > maxViewportH) {
        viewportH = maxViewportH;
        viewportW = viewportH * ratio;
      }

      const html = `
        <dialog id="pa-crop-dialog">
          <div id="pa-crop-panel">
            <div id="pa-crop-title">${escapePhoneHtml(title)}</div>
            <div id="pa-crop-viewport" class="${shape === "circle" ? "pa-crop-viewport-circle" : ""}" style="width:${viewportW}px;height:${viewportH}px;">
              <img id="pa-crop-img" draggable="false" alt="" />
            </div>
            <div id="pa-crop-zoom-row">
              <span id="pa-crop-zoom-icon-min">－</span>
              <input type="range" id="pa-crop-zoom" min="100" max="300" value="100" />
              <span id="pa-crop-zoom-icon-max">＋</span>
            </div>
            <div id="pa-crop-actions">
              <button id="pa-crop-cancel">取消</button>
              <button id="pa-crop-confirm">确定</button>
            </div>
          </div>
        </dialog>`;
      document.body.insertAdjacentHTML("beforeend", html);

      const dialog = document.getElementById("pa-crop-dialog");
      const viewport = document.getElementById("pa-crop-viewport");
      const imgEl = document.getElementById("pa-crop-img");
      const zoomInput = document.getElementById("pa-crop-zoom");

      const natW = img.naturalWidth;
      const natH = img.naturalHeight;
      const coverScale = Math.max(viewportW / natW, viewportH / natH);
      let scale = coverScale;
      let left = (viewportW - natW * scale) / 2;
      let top = (viewportH - natH * scale) / 2;

      imgEl.src = img.src;

      function clamp(v, min, max) {
        return Math.min(max, Math.max(min, v));
      }

      function applyTransform() {
        const dispW = natW * scale;
        const dispH = natH * scale;
        left = dispW <= viewportW ? (viewportW - dispW) / 2 : clamp(left, viewportW - dispW, 0);
        top = dispH <= viewportH ? (viewportH - dispH) / 2 : clamp(top, viewportH - dispH, 0);
        imgEl.style.width = `${dispW}px`;
        imgEl.style.height = `${dispH}px`;
        imgEl.style.left = `${left}px`;
        imgEl.style.top = `${top}px`;
      }
      applyTransform();

      function setZoomVal(val) {
        const clamped = clamp(Math.round(val), 100, 300);
        zoomInput.value = clamped;
        scale = coverScale * (clamped / 100);
        applyTransform();
      }

      // 单指/鼠标拖拽平移
      let dragging = false;
      let dragStartX = 0,
        dragStartY = 0,
        dragStartLeft = 0,
        dragStartTop = 0;
      // 双指捏合缩放
      const activePointers = new Map();
      let pinchStartDist = 0;
      let pinchStartZoom = 100;

      viewport.addEventListener("pointerdown", (e) => {
        viewport.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (activePointers.size === 1) {
          dragging = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          dragStartLeft = left;
          dragStartTop = top;
        } else if (activePointers.size === 2) {
          dragging = false;
          const pts = [...activePointers.values()];
          pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          pinchStartZoom = Number(zoomInput.value);
        }
      });
      viewport.addEventListener("pointermove", (e) => {
        if (!activePointers.has(e.pointerId)) return;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (activePointers.size === 2) {
          const pts = [...activePointers.values()];
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          if (pinchStartDist > 0) {
            setZoomVal(pinchStartZoom * (dist / pinchStartDist));
          }
        } else if (dragging) {
          left = dragStartLeft + (e.clientX - dragStartX);
          top = dragStartTop + (e.clientY - dragStartY);
          applyTransform();
        }
      });
      const endPointer = (e) => {
        activePointers.delete(e.pointerId);
        if (activePointers.size === 1) {
          const [pt] = [...activePointers.values()];
          dragging = true;
          dragStartX = pt.x;
          dragStartY = pt.y;
          dragStartLeft = left;
          dragStartTop = top;
        } else {
          dragging = false;
        }
      };
      viewport.addEventListener("pointerup", endPointer);
      viewport.addEventListener("pointercancel", endPointer);
      viewport.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          setZoomVal(Number(zoomInput.value) + (e.deltaY < 0 ? 8 : -8));
        },
        { passive: false },
      );
      zoomInput.addEventListener("input", () => setZoomVal(Number(zoomInput.value)));

      function cleanup(result) {
        dialog.close();
        dialog.remove();
        resolve(result);
      }

      document.getElementById("pa-crop-cancel").addEventListener("click", () => cleanup(null));
      document.getElementById("pa-crop-confirm").addEventListener(
        "click",
        errorCatched(() => {
          const srcX = -left / scale;
          const srcY = -top / scale;
          const srcW = viewportW / scale;
          const srcH = viewportH / scale;
          const canvas = document.createElement("canvas");
          canvas.width = outputWidth;
          canvas.height = outputHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outputWidth, outputHeight);
          cleanup(canvas.toDataURL("image/jpeg", quality));
        }),
      );
      dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        cleanup(null);
      });

      dialog.showModal();
    }
  });
}


// 把背景 dataURL 套用到对应容器：传 null/空则清空自定义背景，露出下层默认样式。
// 全局背景套在 #pa-phone-modal 内专门的背景图层上：#pa-phone-modal 自己背景透明，靠
// isolation: isolate + backdrop-filter: blur(8px) 模糊弹窗外面（小说正文）透过来的内容，
// 建立独立层叠上下文。纯色底层 z-index:-2、背景图层 z-index:-1，明确摁在 header/body/tabbar
// 之下（不依赖"DOM 顺序谁写在后面盖在上面"这种在部分 webview 环境里不可靠的隐式规则）。
// 没设置背景图时：纯色底层 0.9 透明度的蓝叠在模糊结果上面，是磨砂玻璃质感。
// 设置了背景图后：① 纯色底层透明度改成 0，蓝色完全隐藏；② 背景图层自己也改成 0.86 透明度，
// 露出来的部分直接是模糊后的正文本身（不带蓝色），图片和玻璃通透感同时保留。
// 聊天页背景只套在消息滚动区域 #pa-phone-chat-messages 上（即头部标题栏和输入栏这两条线之间），
// 因为要跟气泡文字保持足够对比度，这里保留一层浅色蒙层。
export function applyPhoneGlobalBackground(dataUrl) {
  const layer = document.getElementById("pa-phone-global-bg-layer");
  const colorLayer = document.getElementById("pa-phone-base-color-layer");
  if (!layer) return;
  if (dataUrl) {
    layer.style.backgroundImage = `url("${dataUrl}")`;
    layer.style.opacity = "0.86";
    if (colorLayer) colorLayer.style.opacity = "0";
  } else {
    layer.style.backgroundImage = "";
    layer.style.opacity = "1";
    if (colorLayer) colorLayer.style.opacity = "0.9";
  }
}


export function applyPhoneChatBackground(dataUrl) {
  const el = document.getElementById("pa-phone-chat-messages");
  if (!el) return;
  if (dataUrl) {
    el.style.backgroundImage = `linear-gradient(rgba(0,20,90,0.35), rgba(0,20,90,0.35)), url("${dataUrl}")`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  } else {
    el.style.backgroundImage = "";
    el.style.backgroundSize = "";
    el.style.backgroundPosition = "";
  }
}


// ---- 通讯器悬浮球：结构和拖拽逻辑照搬上面的地图悬浮球，独立存一份坐标/独立的显隐开关，
// 互不干扰。默认停靠左下角（地图悬浮球在右上角，避免两个球叠在一起）。
// 点击目前只弹一个"开发中"提示——具体的手机界面（通讯录/聊天/动态/设置）还没做，
// 先把入口和开关打通，后面往 openPhoneModal() 里继续填内容即可。
export const PHONE_FAB_POS_KEY = "plotAssistant_phoneFabPos";


export function loadPhoneFabPos() {
  try {
    const raw = localStorage.getItem(PHONE_FAB_POS_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (typeof pos.left === "number" && typeof pos.top === "number") return pos;
  } catch (e) {
    /* 忽略，用默认位置 */
  }
  return null;
}


export function savePhoneFabPos(left, top) {
  try {
    localStorage.setItem(PHONE_FAB_POS_KEY, JSON.stringify({ left, top }));
  } catch (e) {
    /* 存储失败不影响功能 */
  }
}


// 关闭通讯器悬浮球时顺带重置位置，逻辑跟 resetFabPos 一致：下次开永远回到干净的默认位置。
export function resetPhoneFabPos() {
  try {
    localStorage.removeItem(PHONE_FAB_POS_KEY);
  } catch (e) {
    /* 忽略 */
  }
  const fab = document.getElementById("plot-assistant-phone-fab");
  if (fab) {
    fab.style.top = "";
    fab.style.left = "";
    fab.style.right = "";
    fab.style.bottom = "";
  }
}


// 只是 display:none/""，不销毁 DOM，拖拽记住的位置不会丢。
export function applyPhoneFabVisibility() {
  const fab = document.getElementById("plot-assistant-phone-fab");
  if (!fab) return;
  fab.style.display = getPhoneFabVisible() ? "" : "none";
}


// ==== 手机界面 UI（通讯录 / 聊天 / 动态 / 设置）====
// DOM 结构/拖拽/弹窗关闭逻辑参照地图编辑器的 <dialog> 写法（buildModalSkeleton/openModal/closeModal），
// 只是内容换成克莱因蓝风格的手机屏幕，四个页签对应之前 mockup 里的四页。

export const phoneUIState = {
  activeTab: "contacts", // contacts / moments / settings；进入聊天页时记录在 activeChatCharacter，不算独立 tab
  activeChatCharacter: null,
};


export function escapePhoneHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
}


// 聊天页头部"…"下拉菜单（清空对话/上传头像）的开关，供 action-btn 点击和各处导航切换时调用。
export function togglePhoneActionMenu() {
  document.getElementById("pa-phone-action-menu")?.classList.toggle("pa-phone-hidden");
}

export function closePhoneActionMenu() {
  document
    .getElementById("pa-phone-action-menu")
    ?.classList.add("pa-phone-hidden");
}


export function buildPhoneModalSkeleton() {
  if (document.getElementById("pa-phone-modal-overlay")) return;
  const html = `
    <dialog id="pa-phone-modal-overlay">
        <div id="pa-phone-modal">
            <div id="pa-phone-base-color-layer"></div>
            <div id="pa-phone-global-bg-layer"></div>
            <div id="pa-phone-header">
                <button id="pa-phone-back-btn" class="pa-phone-hidden" title="返回">‹</button>
                <button id="pa-phone-close-btn" title="关闭">✕</button>
                <span id="pa-phone-header-title">通讯录</span>
                <button id="pa-phone-action-btn" class="pa-phone-hidden"></button>
                <div id="pa-phone-action-menu" class="pa-phone-hidden">
                    <button id="pa-phone-action-menu-clear">清空对话</button>
                    <button id="pa-phone-action-menu-avatar">上传头像</button>
                    <button id="pa-phone-action-menu-bg">上传背景</button>
                    <button id="pa-phone-action-menu-bg-reset">恢复默认背景</button>
                </div>
                <input type="file" id="pa-phone-avatar-upload-input" accept="image/*" class="pa-phone-hidden" />
                <input type="file" id="pa-phone-chat-bg-upload-input" accept="image/*" class="pa-phone-hidden" />
            </div>
            <div id="pa-phone-body">
                <div id="pa-phone-page-contacts" class="pa-phone-page"></div>
                <div id="pa-phone-page-chat" class="pa-phone-page pa-phone-hidden"></div>
                <div id="pa-phone-page-moments" class="pa-phone-page pa-phone-hidden"></div>
                <div id="pa-phone-page-settings" class="pa-phone-page pa-phone-hidden"></div>
            </div>
            <div id="pa-phone-tabbar">
                <div class="pa-phone-tab" data-tab="contacts">通讯</div>
                <div class="pa-phone-tab" data-tab="moments">动态</div>
                <div class="pa-phone-tab" data-tab="settings">设置</div>
            </div>
        </div>
    </dialog>`;
  document.body.insertAdjacentHTML("beforeend", html);

  document
    .getElementById("pa-phone-close-btn")
    .addEventListener("click", closePhoneModal);
  document
    .getElementById("pa-phone-modal-overlay")
    .addEventListener("click", (e) => {
      if (e.target.id === "pa-phone-modal-overlay") closePhoneModal();
      // 点菜单和触发它的按钮以外的地方，顺手把菜单收起来。
      const menu = document.getElementById("pa-phone-action-menu");
      const btn = document.getElementById("pa-phone-action-btn");
      if (
        !menu.classList.contains("pa-phone-hidden") &&
        !menu.contains(e.target) &&
        e.target !== btn
      ) {
        menu.classList.add("pa-phone-hidden");
      }
    });
  document.getElementById("pa-phone-action-btn").addEventListener(
    "click",
    errorCatched(async () => {
      const btn = document.getElementById("pa-phone-action-btn");
      const mode = btn.dataset.mode;
      if (mode === "add-contact") {
        closePhoneModal();
        await openCreateCharacterDialog();
        await openPhoneModal();
        return;
      }
      if (mode === "chat-menu") {
        togglePhoneActionMenu();
      }
    }),
  );
  document.getElementById("pa-phone-action-menu-clear").addEventListener(
    "click",
    errorCatched(async () => {
      closePhoneActionMenu();
      const name = phoneUIState.activeChatCharacter;
      if (!name) return;
      const context = getCtx();
      const confirmed = await context.callGenericPopup(
        `确定要清空和「${name}」的全部私信记录吗？此操作不可撤销。`,
        context.POPUP_TYPE.CONFIRM,
        "",
        { okButton: "清空", cancelButton: "取消" },
      );
      if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;
      await clearPhoneMessages(name);
      notify("success", `已清空和「${name}」的私信记录。`);
      await renderPhoneChatMessages(name);
    }),
  );
  document
    .getElementById("pa-phone-action-menu-avatar")
    .addEventListener("click", () => {
      closePhoneActionMenu();
      document.getElementById("pa-phone-avatar-upload-input").click();
    });
  document.getElementById("pa-phone-avatar-upload-input").addEventListener(
    "change",
    errorCatched(async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const name = phoneUIState.activeChatCharacter;
      if (!name) return;
      const cropped = await openImageCropDialog({
        file,
        title: "裁剪头像",
        ratio: 1,
        shape: "circle",
        outputWidth: 320,
        outputHeight: 320,
      });
      if (!cropped) return;
      await savePhoneAvatar(name, cropped);
      notify("success", `已更新「${name}」的头像。`);
    }),
  );
  document
    .getElementById("pa-phone-action-menu-bg")
    .addEventListener("click", () => {
      closePhoneActionMenu();
      document.getElementById("pa-phone-chat-bg-upload-input").click();
    });
  document.getElementById("pa-phone-chat-bg-upload-input").addEventListener(
    "change",
    errorCatched(async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const name = phoneUIState.activeChatCharacter;
      if (!name) return;
      const cropped = await openImageCropDialog({
        file,
        title: "裁剪背景",
        ratio: PHONE_CHAT_BG_RATIO,
        shape: "rect",
        outputWidth: 720,
        outputHeight: Math.round(720 / PHONE_CHAT_BG_RATIO),
      });
      if (!cropped) return;
      await savePhoneChatBackground(name, cropped);
      if (phoneUIState.activeChatCharacter === name) {
        applyPhoneChatBackground(cropped);
      }
      notify("success", `已更新「${name}」的聊天背景。`);
    }),
  );
  document.getElementById("pa-phone-action-menu-bg-reset").addEventListener(
    "click",
    errorCatched(async () => {
      closePhoneActionMenu();
      const name = phoneUIState.activeChatCharacter;
      if (!name) return;
      const existing = await getPhoneChatBackground(name);
      if (!existing) {
        notify("warning", "当前使用默认背景，无需恢复。");
        return;
      }
      await deletePhoneChatBackground(name);
      if (phoneUIState.activeChatCharacter === name) {
        applyPhoneChatBackground(null);
      }
      notify("success", `已恢复「${name}」的默认背景。`);
    }),
  );
  document.getElementById("pa-phone-back-btn").addEventListener("click", () => {
    closePhoneActionMenu();
    phoneUIState.activeChatCharacter = null;
    switchPhoneTab("contacts");
  });
  document.querySelectorAll("#pa-phone-tabbar .pa-phone-tab").forEach((el) => {
    el.addEventListener("click", () => {
      phoneUIState.activeChatCharacter = null;
      switchPhoneTab(el.dataset.tab);
    });
  });
}


// 切换页签（不含聊天页——聊天页由 openPhoneChat 单独进入，退出走"返回"按钮）
export async function switchPhoneTab(tab) {
  closePhoneActionMenu();
  phoneUIState.activeTab = tab;
  document
    .querySelectorAll("#pa-phone-tabbar .pa-phone-tab")
    .forEach((el) =>
      el.classList.toggle("pa-phone-tab-active", el.dataset.tab === tab),
    );
  document
    .getElementById("pa-phone-tabbar")
    .classList.remove("pa-phone-hidden");
  document.getElementById("pa-phone-back-btn").classList.add("pa-phone-hidden");
  document
    .getElementById("pa-phone-close-btn")
    .classList.remove("pa-phone-hidden");

  const titles = { contacts: "通讯录", moments: "动态", settings: "设置" };
  document.getElementById("pa-phone-header-title").textContent =
    titles[tab] || "";

  // 右侧动作按钮：通讯页是"添加联系人"，动态/设置页暂时不需要，先隐藏。
  const actionBtn = document.getElementById("pa-phone-action-btn");
  if (tab === "contacts") {
    actionBtn.textContent = "＋";
    actionBtn.title = "添加联系人";
    actionBtn.dataset.mode = "add-contact";
    actionBtn.classList.add("pa-phone-action-icon");
    actionBtn.classList.remove("pa-phone-hidden");
  } else {
    actionBtn.classList.add("pa-phone-hidden");
    delete actionBtn.dataset.mode;
  }

  ["contacts", "chat", "moments", "settings"].forEach((name) => {
    document
      .getElementById(`pa-phone-page-${name}`)
      .classList.toggle("pa-phone-hidden", name !== tab);
  });

  if (tab === "contacts") await renderPhoneContactsPage();
  else if (tab === "moments") renderPhoneMomentsPage();
  else if (tab === "settings") await renderPhoneSettingsPage();
}


export async function renderPhoneContactsPage() {
  const container = document.getElementById("pa-phone-page-contacts");
  container.innerHTML = `<div class="pa-phone-loading">加载中...</div>`;
  const contacts = await getPhoneContactsList();
  if (contacts.length === 0) {
    container.innerHTML = `<div class="pa-phone-empty">还没有联系人，先用「创建角色」功能建一个角色卡吧～</div>`;
    return;
  }
  const avatarMap = await getAllPhoneAvatarsForCurrentCharacter();
  container.innerHTML = contacts
    .map((c) => {
      const { gender } = parseContactExtra(c.extra);
      const metaText = gender ? `${gender}` : "";
      const avatarUrl = avatarMap.get(c.name);
      const avatarInner = avatarUrl
        ? `<img class="pa-phone-avatar-img" src="${avatarUrl}" alt="${escapePhoneHtml(c.name)}" />`
        : escapePhoneHtml(c.name.slice(0, 1));
      return `
      <div class="pa-phone-contact-item" data-name="${escapePhoneHtml(c.name)}">
        <div class="pa-phone-avatar">${avatarInner}</div>
        <div class="pa-phone-contact-meta">
          <div class="pa-phone-contact-name">${escapePhoneHtml(c.name)}</div>
          <div class="pa-phone-contact-extra">${escapePhoneHtml(metaText)}</div>
        </div>
      </div>`;
    })
    .join("");
  container.querySelectorAll(".pa-phone-contact-item").forEach((el) => {
    el.addEventListener("click", () => openPhoneChat(el.dataset.name));
  });
}


export function renderPhoneMomentsPage() {
  document.getElementById("pa-phone-page-moments").innerHTML =
    `<div class="pa-phone-empty">「动态」页正在开发中，敬请期待～</div>`;
}


// 全局背景（通讯录/动态/设置三页共用）的裁剪宽高比，参照手机弹窗内容区域的大致比例（360:550）。
export const PHONE_GLOBAL_BG_RATIO = 360 / 550;

// 聊天页背景（按联系人分别设置）的裁剪宽高比，参照消息滚动区域（顶部标题栏和底部输入栏之间）的大致比例（360:540）。
export const PHONE_CHAT_BG_RATIO = 360 / 540;


// 设置页：第一行是"背景"（全局背景，铺满通讯录/动态/设置三页），下面是"图片"（原表情包）批量导入 + 网格管理。
// 清空聊天记录、更换头像、更换聊天页背景都挪去了聊天页头部"…"菜单里，按当前联系人操作，这里不再重复。
export async function renderPhoneSettingsPage() {
  const container = document.getElementById("pa-phone-page-settings");
  const prevScrollTop = container.scrollTop; // 记住滚动位置：改名/删除/上传后重绘不应该把页面弹回顶部
  container.innerHTML = `<div class="pa-phone-loading">加载中...</div>`;
  const [stickers, globalBg] = await Promise.all([
    getPhoneStickerList(),
    getPhoneGlobalBackground(),
  ]);

  const gridHtml = stickers.length
    ? stickers
        .map(
          (s) => `
      <div class="pa-phone-sticker-manage-item" data-id="${escapePhoneHtml(s.id)}">
        <button class="pa-phone-sticker-delete-btn" title="删除">✕</button>
        <img src="${s.dataUrl}" alt="${escapePhoneHtml(s.name)}" />
        <div class="pa-phone-sticker-manage-name" title="点击改名">${escapePhoneHtml(s.name)}</div>
      </div>`,
        )
        .join("")
    : `<div class="pa-phone-empty">还没有图片，点右上角"添加"批量导入几张吧～</div>`;

  container.innerHTML = `
    <div class="pa-phone-settings-section">
      <div class="pa-phone-settings-title-row">
        <div class="pa-phone-settings-title">背景</div>
        <div class="pa-phone-bg-btns">
          <button id="pa-phone-global-bg-upload-btn" class="pa-phone-sticker-add-btn">上传背景</button>
          <button id="pa-phone-global-bg-reset-btn" class="pa-phone-bg-reset-btn${globalBg ? "" : " pa-phone-hidden"}">恢复默认</button>
        </div>
      </div>
      <div id="pa-phone-global-bg-preview" class="pa-phone-bg-preview"${globalBg ? ` style="background-image:url('${globalBg}')"` : ""}>
        ${globalBg ? "" : '<span class="pa-phone-bg-preview-empty">未设置，通讯录/动态/设置页将使用此背景</span>'}
      </div>
    </div>
    <input type="file" id="pa-phone-global-bg-upload-input" accept="image/*" class="pa-phone-hidden" />
    <div class="pa-phone-settings-section">
      <div class="pa-phone-settings-title-row">
        <div class="pa-phone-settings-title">图片</div>
        <button id="pa-phone-sticker-add-btn" class="pa-phone-sticker-add-btn">+ 添加</button>
      </div>
      <div class="pa-phone-sticker-manage-hint">发送图片时，AI 实际读取到的是「图片：图片名称」这段文字，请把图片名称改成能描述图片内容的文字（点图片名即可改名），AI 才能"看懂"这张图。</div>
      <div class="pa-phone-sticker-manage-grid">${gridHtml}</div>
    </div>
    <input type="file" id="pa-phone-sticker-upload-input" accept="image/*" multiple class="pa-phone-hidden" />`;

  container.scrollTop = prevScrollTop;

  document
    .getElementById("pa-phone-global-bg-upload-btn")
    .addEventListener("click", () => {
      document.getElementById("pa-phone-global-bg-upload-input").click();
    });
  document.getElementById("pa-phone-global-bg-upload-input").addEventListener(
    "change",
    errorCatched(async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const cropped = await openImageCropDialog({
        file,
        title: "裁剪背景",
        ratio: PHONE_GLOBAL_BG_RATIO,
        shape: "rect",
        outputWidth: 720,
        outputHeight: Math.round(720 / PHONE_GLOBAL_BG_RATIO),
      });
      if (!cropped) return;
      await savePhoneGlobalBackground(cropped);
      applyPhoneGlobalBackground(cropped);
      notify("success", "已更新背景。");
      await renderPhoneSettingsPage();
    }),
  );
  document.getElementById("pa-phone-global-bg-reset-btn").addEventListener(
    "click",
    errorCatched(async () => {
      await deletePhoneGlobalBackground();
      applyPhoneGlobalBackground(null);
      notify("success", "已恢复默认背景。");
      await renderPhoneSettingsPage();
    }),
  );

  document
    .getElementById("pa-phone-sticker-add-btn")
    .addEventListener("click", () => {
      document.getElementById("pa-phone-sticker-upload-input").click();
    });

  document.getElementById("pa-phone-sticker-upload-input").addEventListener(
    "change",
    errorCatched(async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (!files.length) return;
      const items = [];
      for (const file of files) {
        const dataUrl = await readImageFileCompressed(file, 200);
        const baseName = file.name.replace(/\.[^.]+$/, "") || "图片";
        items.push({ name: baseName, dataUrl });
      }
      await addPhoneStickers(items);
      notify("success", `已导入 ${items.length} 张图片。`);
      await renderPhoneSettingsPage();
    }),
  );

  container.querySelectorAll(".pa-phone-sticker-delete-btn").forEach((btn) => {
    btn.addEventListener(
      "click",
      errorCatched(async () => {
        const item = btn.closest(".pa-phone-sticker-manage-item");
        await deletePhoneSticker(item.dataset.id);
        await renderPhoneSettingsPage();
      }),
    );
  });

  container.querySelectorAll(".pa-phone-sticker-manage-name").forEach((nameEl) => {
    nameEl.addEventListener("click", () => {
      const item = nameEl.closest(".pa-phone-sticker-manage-item");
      const id = item.dataset.id;
      const current = nameEl.textContent;
      nameEl.outerHTML = `<input class="pa-phone-sticker-name-input" value="${escapePhoneHtml(current)}" />`;
      const input = item.querySelector(".pa-phone-sticker-name-input");
      input.focus();
      input.select();
      const save = errorCatched(async () => {
        const newName = input.value.trim() || current;
        await renamePhoneSticker(id, newName);
        await renderPhoneSettingsPage();
      });
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
      });
    });
  });
}


// 进入某个联系人的聊天页：隐藏 tabbar，显示返回按钮，标题换成联系人名字。
export async function openPhoneChat(characterName) {
  phoneUIState.activeChatCharacter = characterName;
  document.getElementById("pa-phone-header-title").textContent = characterName;
  document
    .getElementById("pa-phone-back-btn")
    .classList.remove("pa-phone-hidden");
  document
    .getElementById("pa-phone-close-btn")
    .classList.add("pa-phone-hidden");
  document.getElementById("pa-phone-tabbar").classList.add("pa-phone-hidden");

  closePhoneActionMenu();
  const actionBtn = document.getElementById("pa-phone-action-btn");
  actionBtn.textContent = "⋯";
  actionBtn.title = "更多操作";
  actionBtn.dataset.mode = "chat-menu";
  actionBtn.classList.add("pa-phone-action-icon");
  actionBtn.classList.remove("pa-phone-hidden");
  ["contacts", "chat", "moments", "settings"].forEach((name) => {
    document
      .getElementById(`pa-phone-page-${name}`)
      .classList.toggle("pa-phone-hidden", name !== "chat");
  });

  const page = document.getElementById("pa-phone-page-chat");
  page.innerHTML = `
    <div id="pa-phone-chat-messages"><div class="pa-phone-loading">加载中...</div></div>
    <div id="pa-phone-sticker-panel" class="pa-phone-hidden"></div>
    <div id="pa-phone-chat-inputbar">
      <button id="pa-phone-sticker-btn" title="图片">☺</button>
      <input id="pa-phone-chat-input" type="text" placeholder="发消息给${escapePhoneHtml(
        characterName,
      )}..." />
      <button id="pa-phone-chat-send-btn">发送</button>
    </div>`;

  const chatBg = await getPhoneChatBackground(characterName);
  applyPhoneChatBackground(chatBg);

  await renderPhoneChatMessages(characterName);

  const input = document.getElementById("pa-phone-chat-input");
  const sendBtn = document.getElementById("pa-phone-chat-send-btn");
  const stickerBtn = document.getElementById("pa-phone-sticker-btn");
  const stickerPanel = document.getElementById("pa-phone-sticker-panel");
  const doSend = errorCatched(async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendBtn.disabled = true;
    input.disabled = true;
    try {
      await sendPhoneMessageToCharacter(characterName, text);
      if (phoneUIState.activeChatCharacter === characterName) {
        await renderPhoneChatMessages(characterName);
      }
    } finally {
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  });
  sendBtn.addEventListener("click", doSend);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSend();
  });
  stickerBtn.addEventListener(
    "click",
    errorCatched(async () => {
      const willShow = stickerPanel.classList.contains("pa-phone-hidden");
      if (willShow) await renderPhoneStickerPanel(characterName, stickerPanel);
      stickerPanel.classList.toggle("pa-phone-hidden", !willShow);
    }),
  );
}


// 图片选择面板：网格展示图片库，点一下就直接发出去（跟真实聊天软件的表情选择一致）。
export async function renderPhoneStickerPanel(characterName, panel) {
  const list = await getPhoneStickerList();
  if (!list.length) {
    panel.innerHTML = `<div class="pa-phone-empty" style="padding:14px 10px;">还没有图片，去设置页导入几张吧～</div>`;
    return;
  }
  panel.innerHTML = list
    .map(
      (s) => `
    <div class="pa-phone-sticker-item" data-id="${escapePhoneHtml(s.id)}" title="${escapePhoneHtml(s.name)}">
      <img src="${s.dataUrl}" alt="${escapePhoneHtml(s.name)}" />
    </div>`,
    )
    .join("");
  panel.querySelectorAll(".pa-phone-sticker-item").forEach((el) => {
    el.addEventListener(
      "click",
      errorCatched(async () => {
        const sticker = list.find((s) => s.id === el.dataset.id);
        if (!sticker) return;
        panel.classList.add("pa-phone-hidden");
        await sendPhoneStickerToCharacter(characterName, sticker);
      }),
    );
  });
}


// 发一张图片：text 存 `[图片:图片名]` 文字标记（AI 靠这个感知"用户发了张图片"），
// stickerId 关联图片库图片，供本地气泡渲染真实图片用。
export async function sendPhoneStickerToCharacter(characterName, sticker) {
  const sendBtn = document.getElementById("pa-phone-chat-send-btn");
  const input = document.getElementById("pa-phone-chat-input");
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;
  try {
    await sendPhoneMessageToCharacter(characterName, {
      text: `[图片:${sticker.name}]`,
      stickerId: sticker.id,
    });
    if (phoneUIState.activeChatCharacter === characterName) {
      await renderPhoneChatMessages(characterName);
    }
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.disabled = false;
  }
}


// 重新渲染聊天页消息列表（发送/收到新消息后调用），并自动滚到底部。
export async function renderPhoneChatMessages(characterName) {
  const list = document.getElementById("pa-phone-chat-messages");
  if (!list) return;
  const groups = await getAllPhoneMessages(characterName);
  if (groups.length === 0) {
    list.innerHTML = `<div class="pa-phone-empty">还没有聊天记录，发第一条消息试试吧～</div>`;
    return;
  }
  // 一次性把图片库读出来建个 id -> 记录的索引，气泡渲染时按 stickerId 查图；
  // 图片后来被删了查不到时，退化成显示 [图片:xxx] 文字标记，不会渲染出坏图标。
  const stickerMap = new Map(
    (await getPhoneStickerList()).map((s) => [s.id, s]),
  );
  list.innerHTML = groups
    .map((g) => {
      // 分割线：取这一组消息里第一条带 storyTime 的日期部分；这组里没有任何消息带 storyTime（旧数据）时，退回显示现实日期。
      const firstStoryDate = g.msgs
        .map((m) => splitStoryTime(m.storyTime).date)
        .find((d) => d);
      const dividerText = firstStoryDate || g.dateKey;
      return `
      <div class="pa-phone-date-divider">${escapePhoneHtml(dividerText)}</div>
      ${g.msgs
        .map((m) => {
          const storyParts = splitStoryTime(m.storyTime);
          const timeStr =
            storyParts.time || new Date(m.ts).toTimeString().slice(0, 5);
          const side =
            m.from === "user" ? "pa-phone-msg-right" : "pa-phone-msg-left";
          const sticker = m.stickerId ? stickerMap.get(m.stickerId) : null;
          const bubbleClass = sticker
            ? "pa-phone-msg-bubble pa-phone-msg-bubble-sticker"
            : "pa-phone-msg-bubble";
          const bubbleInner = sticker
            ? `<img class="pa-phone-msg-sticker-img" src="${sticker.dataUrl}" alt="${escapePhoneHtml(sticker.name)}" />`
            : escapePhoneHtml(m.text);
          return `
          <div class="pa-phone-msg-row ${side}" data-id="${escapePhoneHtml(m.id)}" data-text="${escapePhoneHtml(m.text)}">
            <div class="pa-phone-msg-bubble-line">
              <div class="${bubbleClass}">${bubbleInner}</div>
              <button class="pa-phone-msg-more-btn" title="编辑/删除">⋯</button>
            </div>
            <div class="pa-phone-msg-actions pa-phone-hidden">
              <button class="pa-phone-msg-edit-btn">编辑</button>
              <button class="pa-phone-msg-delete-btn">删除</button>
            </div>
            <div class="pa-phone-msg-time">${timeStr}</div>
          </div>`;
        })
        .join("")}`;
    })
    .join("");
  list.scrollTop = list.scrollHeight;
  bindPhoneChatMessageActions(list, characterName);
}


// 给每条消息挂"···"展开/收起、编辑、删除的交互；每次 renderPhoneChatMessages 重绘后重新绑定一遍。
export function bindPhoneChatMessageActions(list, characterName) {
  list.querySelectorAll(".pa-phone-msg-row").forEach((row) => {
    const actions = row.querySelector(".pa-phone-msg-actions");

    row
      .querySelector(".pa-phone-msg-more-btn")
      .addEventListener("click", () => {
        const willShow = actions.classList.contains("pa-phone-hidden");
        // 同一时间只保留一行展开，点别的行的"···"先把上一行收起。
        list
          .querySelectorAll(".pa-phone-msg-actions")
          .forEach((el) => el.classList.add("pa-phone-hidden"));
        actions.classList.toggle("pa-phone-hidden", !willShow);
      });

    row
      .querySelector(".pa-phone-msg-edit-btn")
      .addEventListener("click", () => {
        actions.classList.add("pa-phone-hidden");
        const bubbleLine = row.querySelector(".pa-phone-msg-bubble-line");
        // 从 data-text 读原文，而不是气泡的 textContent——图片消息的气泡里是 <img>，
        // textContent 读不到 [图片:xxx] 这个真实存的文字标记。保存后 updatePhoneMessageText
        // 会顺带清掉 stickerId，这条消息就退化成普通文字消息了。
        const originalText = row.dataset.text || "";
        bubbleLine.outerHTML = `
        <div class="pa-phone-msg-edit-box">
          <textarea class="pa-phone-msg-edit-input">${escapePhoneHtml(originalText)}</textarea>
          <div class="pa-phone-msg-edit-btns">
            <button class="pa-phone-msg-edit-cancel">取消</button>
            <button class="pa-phone-msg-edit-save">保存</button>
          </div>
        </div>`;
        const box = row.querySelector(".pa-phone-msg-edit-box");
        box
          .querySelector(".pa-phone-msg-edit-cancel")
          .addEventListener("click", () =>
            renderPhoneChatMessages(characterName),
          );
        box.querySelector(".pa-phone-msg-edit-save").addEventListener(
          "click",
          errorCatched(async () => {
            const newText = box
              .querySelector(".pa-phone-msg-edit-input")
              .value.trim();
            if (!newText) {
              notify("warning", "私信内容不能为空，没有保存。");
              return;
            }
            await updatePhoneMessageText(
              characterName,
              row.dataset.id,
              newText,
            );
            await renderPhoneChatMessages(characterName);
          }),
        );
      });

    row.querySelector(".pa-phone-msg-delete-btn").addEventListener(
      "click",
      errorCatched(async () => {
        const context = getCtx();
        const confirmed = await context.callGenericPopup(
          "确定要删除这条私信吗？此操作不可撤销。",
          context.POPUP_TYPE.CONFIRM,
          "",
          { okButton: "删除", cancelButton: "取消" },
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;
        await deletePhoneMessage(characterName, row.dataset.id);
        await renderPhoneChatMessages(characterName);
      }),
    );
  });
}


// 角色"变闲"自动补发回复后，如果手机聊天页当前正好开着这个联系人，实时刷新一下。
export function refreshPhoneChatViewIfOpen(characterName) {
  const overlay = document.getElementById("pa-phone-modal-overlay");
  if (!overlay || !overlay.open) return;
  if (phoneUIState.activeChatCharacter !== characterName) return;
  renderPhoneChatMessages(characterName);
}


export function closePhoneModal() {
  const overlay = document.getElementById("pa-phone-modal-overlay");
  if (overlay && overlay.open) overlay.close();
  closePhoneActionMenu();
  document
    .getElementById("pa-phone-sticker-panel")
    ?.classList.add("pa-phone-hidden");
}


export async function openPhoneModal() {
  const ctx = getCtx();
  const char = ctx.characters?.[ctx.characterId];
  if (ctx.groupId || !char || !char.name) {
    notify(
      "warning",
      "请先进入某个角色卡的对话界面，再打开通讯器——群聊和未选中角色卡时无法定位私信记录归属于哪个角色。",
    );
    return;
  }

  buildPhoneModalSkeleton();
  phoneUIState.activeChatCharacter = null;
  const globalBg = await getPhoneGlobalBackground();
  applyPhoneGlobalBackground(globalBg);
  document.getElementById("pa-phone-modal-overlay").showModal();
  await switchPhoneTab("contacts");
}


export function injectPhoneFloatingButton() {
  if (document.getElementById("plot-assistant-phone-fab")) return;

  const html = `
        <div id="plot-assistant-phone-fab" title="通讯器">
            <div class="plot-assistant-phone-fab-icon">📱</div>
        </div>`;
  document.body.insertAdjacentHTML("beforeend", html);

  const fab = document.getElementById("plot-assistant-phone-fab");

  const FAB_MARGIN = 16;
  const FAB_SIZE = 44;

  function clampPos(left, top) {
    const maxLeft = Math.max(
      FAB_MARGIN,
      window.innerWidth - FAB_MARGIN - FAB_SIZE,
    );
    const maxTop = Math.max(
      FAB_MARGIN,
      window.innerHeight - FAB_MARGIN - FAB_SIZE,
    );
    return {
      left: Math.min(Math.max(left, FAB_MARGIN), maxLeft),
      top: Math.min(Math.max(top, FAB_MARGIN), maxTop),
    };
  }

  const savedPos = loadPhoneFabPos();
  if (savedPos) {
    const pos = clampPos(savedPos.left, savedPos.top);
    fab.style.right = "auto";
    fab.style.bottom = "auto";
    fab.style.left = `${pos.left}px`;
    fab.style.top = `${pos.top}px`;
  }
  // 显隐由控制面板里的「通讯器开/通讯器关」按钮控制，这里只负责套用启动时已保存的状态。
  applyPhoneFabVisibility();

  let dragging = false;
  let moved = false;
  let startX = 0,
    startY = 0;
  let offsetX = 0,
    offsetY = 0;

  const DRAG_THRESHOLD = 6;

  function onPointerDown(e) {
    dragging = true;
    moved = false;
    const point = e.touches ? e.touches[0] : e;
    const rect = fab.getBoundingClientRect();
    offsetX = point.clientX - rect.left;
    offsetY = point.clientY - rect.top;
    startX = point.clientX;
    startY = point.clientY;
    document.addEventListener("mousemove", onPointerMove);
    document.addEventListener("mouseup", onPointerUp);
    document.addEventListener("touchmove", onPointerMove, { passive: false });
    document.addEventListener("touchend", onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const point = e.touches ? e.touches[0] : e;
    if (
      Math.abs(point.clientX - startX) > DRAG_THRESHOLD ||
      Math.abs(point.clientY - startY) > DRAG_THRESHOLD
    ) {
      moved = true;
      if (e.touches) e.preventDefault();
    }
    if (!moved) return;

    const x = point.clientX - offsetX;
    const y = point.clientY - offsetY;

    const margin = 4;
    const size = fab.offsetWidth;
    const newLeft = Math.min(
      Math.max(x, margin),
      window.innerWidth - size - margin,
    );
    const newTop = Math.min(
      Math.max(y, margin),
      window.innerHeight - size - margin,
    );

    fab.style.right = "auto";
    fab.style.bottom = "auto";
    fab.style.left = `${newLeft}px`;
    fab.style.top = `${newTop}px`;
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("mousemove", onPointerMove);
    document.removeEventListener("mouseup", onPointerUp);
    document.removeEventListener("touchmove", onPointerMove);
    document.removeEventListener("touchend", onPointerUp);

    if (moved) {
      const left = parseFloat(fab.style.left) || 0;
      const top = parseFloat(fab.style.top) || 0;
      savePhoneFabPos(left, top);
    } else {
      openPhoneModal();
    }
  }

  fab.addEventListener("mousedown", onPointerDown);
  fab.addEventListener("touchstart", onPointerDown, { passive: true });
}
