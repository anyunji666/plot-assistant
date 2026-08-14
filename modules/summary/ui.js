"use strict";

import { DEFAULT_PRE_EMPHASIS_CONTENT, PRE_EMPHASIS_TITLE, notify } from "../core.js";
import { loadPreEmphasisEntry, savePreEmphasisEntry } from "./generator.js";


// === Function: 打开"对话前强调"编辑框（启用开关 + 文本内容，取消/保存） ===
export async function openPreEmphasisDialog() {
  let state;
  try {
    state = await loadPreEmphasisEntry();
  } catch (error) {
    console.error("[剧情助手] 加载对话前强调条目失败:", error);
    notify("error", `加载对话前强调条目失败：${error.message || error}`);
    return;
  }

  const existingContent = state.existing
    ? state.existing.content || ""
    : DEFAULT_PRE_EMPHASIS_CONTENT;
  const existingEnabled = state.existing ? !state.existing.disable : false;

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

    // 与「剧情助手控制面板」保持一致：固定锚定在屏幕顶部附近，而不是用 flex 居中。
    // 居中方案在移动端弹出虚拟键盘时，vh 不会随可视视口收缩而实时更新，
    // 会导致对话框标题/底部按钮被键盘或屏幕边缘裁掉；顶部锚定 + dvh 可以避免这个问题。
    const $box = $("<div>").css({
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#252525",
      border: "1px solid #3a3a3a",
      borderRadius: "10px",
      padding: "clamp(16px, 4vw, 24px)",
      width: "min(400px, calc(100% - 24px))",
      maxHeight: "min(85vh, calc(100dvh - 24px))",
      display: "flex",
      flexDirection: "column",
      gap: "16px",
      color: "#e8e8e8",
      fontFamily: "inherit",
      boxSizing: "border-box",
      boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
    });

    const $title = $("<div>").text(PRE_EMPHASIS_TITLE).css({
      fontSize: "1.05em",
      fontWeight: "600",
      color: "#f0f0f0",
      letterSpacing: "0.01em",
    });

    const $switchRow = $("<label>").css({
      display: "flex",
      alignItems: "center",
      gap: "10px",
      fontSize: "0.9em",
      color: "#c0c0c0",
      cursor: "pointer",
      userSelect: "none",
      minHeight: "32px",
      touchAction: "manipulation",
    });
    const $switchInput = $('<input type="checkbox">')
      .prop("checked", existingEnabled)
      .css({
        width: "20px",
        height: "20px",
        cursor: "pointer",
        flexShrink: 0,
      });
    $switchRow.append($switchInput, $("<span>").text("启用此条目"));

    const inputCss = {
      width: "100%",
      boxSizing: "border-box",
      padding: "8px 10px",
      borderRadius: "6px",
      border: "1px solid #3a3a3a",
      background: "#1a1a1a",
      color: "#d0d0d0",
      fontSize: "max(0.95em, 16px)",
      fontFamily: "inherit",
      outline: "none",
    };

    const $textWrap = $("<div>").css({
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      minHeight: 0,
    });
    $textWrap.append(
      $("<label>").text("提示内容").css({ fontSize: "0.82em", color: "#999" }),
    );
    const $textInput = $("<textarea>")
      .attr({ rows: 8 })
      .css({
        ...inputCss,
        resize: "vertical",
        minHeight: "120px",
        maxHeight: "min(40vh, 40dvh)",
      })
      .val(existingContent);
    $textWrap.append($textInput);

    const $btnRow = $("<div>").css({
      display: "flex",
      gap: "10px",
      justifyContent: "flex-end",
      marginTop: "4px",
    });
    const btnCss = {
      padding: "6px 10px",
      borderRadius: "6px",
      boxSizing: "border-box",
      cursor: "pointer",
      fontSize: "0.8em",
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

    $box.append($title, $switchRow, $textWrap, $btnRow);
    $overlay.append($box);
    $("body").append($overlay);
    setTimeout(() => $textInput.trigger("focus"), 50);

    const done = (confirmed) => {
      $(document).off("keydown.preEmphasisDialog");
      $overlay.remove();
      $bodyEl.css("overflow", prevBodyOverflow || "");
      resolve(
        confirmed
          ? { content: $textInput.val(), enabled: $switchInput.prop("checked") }
          : null,
      );
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
    $(document).on("keydown.preEmphasisDialog", (e) => {
      if (e.key === "Escape") done(false);
    });
  });

  if (!result) return;

  try {
    const lorebookName = await savePreEmphasisEntry(
      result.content,
      result.enabled,
    );
    notify(
      "success",
      `对话前强调已保存到「${lorebookName}」（${result.enabled ? "已启用" : "已禁用"}）`,
    );
  } catch (error) {
    console.error("[剧情助手] 保存对话前强调条目失败:", error);
    notify("error", `保存对话前强调条目失败：${error.message || error}`);
  }
}
