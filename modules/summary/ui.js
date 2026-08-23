"use strict";

import { DEFAULT_PRE_EMPHASIS_CONTENT, GENERATING_OVERLAY_ID, PRE_EMPHASIS_TITLE, confirmAction, errorCatched, getCtx, getOffsetRecord, notify } from "../core.js";
import { loadPreEmphasisEntry, savePreEmphasisEntry } from "./generator.js";
import { getSummaryProgress } from "./parser.js";
import { getOrCreateSummaryLorebook } from "../worldinfo.js";


// === Helper: "生成中"提示框（居中弹窗，半透明遮罩+卡片，带加载动画） ===
// 与批次相关的 toastr 进度提示（如"正在总结第X楼..."）相互独立，互不干扰、并存显示。
// options.showStopButton: 是否显示"停止总结"按钮（仅批量循环类功能需要）；
// options.onStop: 点击停止按钮时的回调（会设置调用方内部的停止标志位，当前批次仍会正常跑完并保存）；
// options.statusText: 覆盖默认的提示文字。
export function showGeneratingOverlay(options) {
  const {
    showStopButton = false,
    onStop = null,
    statusText = "正在生成总结，请稍候...",
  } = options || {};
  try {
    if ($(`#${GENERATING_OVERLAY_ID}`).length > 0) return; // 已存在则不重复创建

    if ($(`#${GENERATING_OVERLAY_ID}-style`).length === 0) {
      const styleElement = document.createElement("style");
      styleElement.id = `${GENERATING_OVERLAY_ID}-style`;
      styleElement.textContent = `
        @keyframes summaryAssistantSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes summaryAssistantFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;
      document.head.appendChild(styleElement);
    }

    const $overlay = $("<div></div>").attr("id", GENERATING_OVERLAY_ID).css({
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0, 0, 0, 0.5)",
      backdropFilter: "blur(2px)",
      zIndex: 10000,
      animation: "summaryAssistantFadeIn 0.15s ease-out",
    });

    // 与「剧情助手控制面板」「对话前强调」弹窗保持一致：固定锚定在屏幕顶部附近，而不是用 flex 居中。
    // 居中方案在移动端地址栏/工具栏收缩、或弹出虚拟键盘时，vh 不会随可视视口实时更新，
    // 会导致卡片被顶部裁掉、错位；顶部锚定 + dvh 可以避免这个问题。
    const $card = $("<div></div>").css({
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      width: "min(320px, calc(100% - 24px))",
      maxHeight: "min(85vh, calc(100dvh - 24px))",
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
      background: "#262626",
      color: "#e0e0e0",
      borderRadius: "8px",
      boxShadow: "0 15px 30px rgba(0, 0, 0, 0.6)",
      padding: "24px 32px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "14px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "14px",
      boxSizing: "border-box",
    });

    const $spinner = $("<div></div>").css({
      width: "32px",
      height: "32px",
      border: "3px solid #444",
      borderTopColor: "#3a7bd5",
      borderRadius: "50%",
      animation: "summaryAssistantSpin 0.8s linear infinite",
    });

    const $text = $("<div></div>").text(statusText);

    $card.append($spinner).append($text);

    if (showStopButton) {
      const $stopButton = $("<button></button>")
        .attr("id", `${GENERATING_OVERLAY_ID}-stop`)
        .text("停止总结")
        .css({
          background: "#d53a3a",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          fontSize: "12px",
          padding: "6px 14px",
          borderRadius: "4px",
          marginTop: "4px",
          transition: "background-color 0.2s",
        })
        .on("click", function () {
          $(this)
            .prop("disabled", true)
            .css("cursor", "default")
            .css("opacity", 0.6)
            .text("已请求停止，当前批次完成后停止...");
          if (typeof onStop === "function") onStop();
        })
        .hover(
          function () {
            if (!$(this).prop("disabled")) $(this).css("background", "#b32e2e");
          },
          function () {
            if (!$(this).prop("disabled")) $(this).css("background", "#d53a3a");
          },
        );
      $card.append($stopButton);
    }

    $overlay.append($card);
    $("body").append($overlay);
  } catch (error) {
    console.error("[剧情助手] 显示生成中提示框时出错:", error);
  }
}


export function closeGeneratingOverlay() {
  try {
    $(`#${GENERATING_OVERLAY_ID}`).remove();
  } catch (error) {
    console.error("[剧情助手] 关闭生成中提示框时出错:", error);
  }
}


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
      background: "#ffffff",
      color: "#000000",
      colorScheme: "light",
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


// === Helper: 解析"隐藏楼层"弹窗里手填的楼层范围文本——支持单层号（如 5）或范围（如 2-45），
// 与 extractSmallSummaryRange（解析世界书条目标题"小总结：起-止"）是两套不同格式，不复用。
// 解析失败返回 null；单层号时 start === end。===
function parseHideFloorRangeInput(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^(\d+)(-(\d+))?$/);
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[3] !== undefined ? parseInt(match[3], 10) : start;
  if (start > end) return null;
  return { start, end };
}


// === Helper: 把一串楼层号（升序）压缩成"2-26、30、45-50"这样的范围展示文本，连续的合并成一段 ===
function compressFloorsToLabel(floors) {
  if (!floors || floors.length === 0) return "无";
  const segments = [];
  let segStart = floors[0];
  let segEnd = floors[0];
  for (let i = 1; i < floors.length; i++) {
    if (floors[i] === segEnd + 1) {
      segEnd = floors[i];
    } else {
      segments.push(segStart === segEnd ? `${segStart}` : `${segStart}-${segEnd}`);
      segStart = floors[i];
      segEnd = floors[i];
    }
  }
  segments.push(segStart === segEnd ? `${segStart}` : `${segStart}-${segEnd}`);
  return segments.join("、");
}


// === Helper: 扫描当前对话 context.chat，找出被 /hide 标记 is_system 的楼层号（升序），
// 用于"隐藏楼层"弹窗底部展示。is_system 是酒馆 /hide 命令本身用来标记"不发给AI"的原生字段，
// 没有另开一份数据单独记录隐藏范围——直接读原生状态最准，不会跟手动在别处 /hide 的楼层脱节。===
function getHiddenFloorsLabel() {
  const chat = getCtx().chat;
  if (!Array.isArray(chat) || chat.length === 0) return "无";
  const floors = [];
  chat.forEach((mes, index) => {
    if (mes && mes.is_system) floors.push(index);
  });
  return compressFloorsToLabel(floors);
}


// === Function: 打开"隐藏楼层"弹窗（隐藏范围+隐藏按钮、恢复范围+恢复按钮，同一弹窗内） ===
// 仿 openPreEmphasisDialog 的弹窗骨架，但不是一次性表单提交：右上角常驻×关闭，
// 隐藏/恢复各自独立触发、可连续操作，不会点一次就整个弹窗关掉。
export function openHideFloorDialog() {
  const $bodyEl = $("body");
  const prevBodyOverflow = $bodyEl.css("overflow");
  $bodyEl.css("overflow", "hidden");

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

  const $titleRow = $("<div>").css({
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  });
  const $title = $("<div>").text("隐藏楼层").css({
    fontSize: "1.05em",
    fontWeight: "600",
    color: "#f0f0f0",
    letterSpacing: "0.01em",
  });
  const $closeBtn = $("<button>").html("&times;").css({
    background: "transparent",
    border: "none",
    color: "#aaa",
    cursor: "pointer",
    fontSize: "20px",
    padding: "0",
    margin: "0",
    lineHeight: "1",
    transition: "color 0.2s",
  });
  $titleRow.append($title, $closeBtn);

  const inputCss = {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3a3a",
    background: "#ffffff",
    color: "#000000",
    colorScheme: "light",
    fontSize: "max(0.95em, 16px)",
    fontFamily: "inherit",
    outline: "none",
  };
  const btnCss = {
    padding: "6px 14px",
    borderRadius: "6px",
    boxSizing: "border-box",
    border: "none",
    cursor: "pointer",
    fontSize: "0.85em",
    fontWeight: "600",
    color: "#fff",
    touchAction: "manipulation",
    whiteSpace: "nowrap",
  };

  // === 隐藏范围 一行 ===
  const $hideWrap = $("<div>").css({
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  });
  $hideWrap.append(
    $("<label>").text("隐藏范围").css({ fontSize: "0.82em", color: "#999" }),
  );
  const $hideRow = $("<div>").css({ display: "flex", gap: "8px", alignItems: "center" });
  const $hideInput = $("<input>").attr({ type: "text", placeholder: "如 2-26或6" }).css(inputCss);
  const $hideBtn = $("<button>").text("隐藏").css({ ...btnCss, background: "#5b9cf6" });
  $hideRow.append($hideInput, $hideBtn);
  $hideWrap.append($hideRow);

  // === 恢复范围 一行 ===
  const $unhideWrap = $("<div>").css({
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  });
  $unhideWrap.append(
    $("<label>").text("恢复范围").css({ fontSize: "0.82em", color: "#999" }),
  );
  const $unhideRow = $("<div>").css({ display: "flex", gap: "8px", alignItems: "center" });
  const $unhideInput = $("<input>").attr({ type: "text", placeholder: "如 2-26或6" }).css(inputCss);
  const $unhideBtn = $("<button>").text("恢复").css({ ...btnCss, background: "#3a9d5a" });
  $unhideRow.append($unhideInput, $unhideBtn);
  $unhideWrap.append($unhideRow);

  // === 面板底部：已隐藏楼层展示，隐藏/恢复操作后刷新 ===
  const $hiddenInfoWrap = $("<div>").css({
    borderTop: "1px solid #3a3a3a",
    paddingTop: "10px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  });
  $hiddenInfoWrap.append(
    $("<label>").text("已隐藏楼层").css({ fontSize: "0.82em", color: "#999" }),
  );
  const $hiddenInfoText = $("<div>").css({
    fontSize: "0.9em",
    color: "#c0c0c0",
    wordBreak: "break-all",
  });
  $hiddenInfoWrap.append($hiddenInfoText);

  const refreshHiddenInfo = () => {
    $hiddenInfoText.text(getHiddenFloorsLabel());
  };
  refreshHiddenInfo();

  $box.append($titleRow, $hideWrap, $unhideWrap, $hiddenInfoWrap);
  $overlay.append($box);
  $("body").append($overlay);
  setTimeout(() => $hideInput.trigger("focus"), 50);

  const close = () => {
    $(document).off("keydown.hideFloorDialog");
    $overlay.remove();
    $bodyEl.css("overflow", prevBodyOverflow || "");
  };

  $closeBtn
    .on("click", () => close())
    .hover(
      function () {
        $(this).css("color", "#fff");
      },
      function () {
        $(this).css("color", "#aaa");
      },
    );

  let overlayPointerDownOnSelf = false;
  $overlay.on("mousedown touchstart", (e) => {
    overlayPointerDownOnSelf = $(e.target).is($overlay);
  });
  $overlay.on("mouseup touchend", (e) => {
    if (overlayPointerDownOnSelf && $(e.target).is($overlay)) close();
    overlayPointerDownOnSelf = false;
  });
  $(document).on("keydown.hideFloorDialog", (e) => {
    if (e.key === "Escape") close();
  });

  // === 隐藏按钮点击逻辑 ===
  $hideBtn.on(
    "click",
    errorCatched(async () => {
      const range = parseHideFloorRangeInput($hideInput.val());
      if (!range) {
        notify("error", "隐藏范围格式不对，请输入如 2-45 或单个楼层号 5");
        return;
      }

      const summaryLorebookName = await getOrCreateSummaryLorebook();
      const offset = getOffsetRecord()?.offset ?? 0;
      const progress = await getSummaryProgress(summaryLorebookName, offset);

      if (range.end > progress) {
        const proceed = await confirmAction(
          "隐藏楼层",
          "这段楼层还没被小总结覆盖，隐藏后AI会看不到这段还没存档的剧情，确定继续吗？",
        );
        if (!proceed) return;
      }

      const context = getCtx();
      await context.executeSlashCommandsWithOptions(
        `/hide ${range.start}-${range.end}`,
      );
      notify("success", `已隐藏第${range.start}-${range.end}楼`);
      $hideInput.val("");
      refreshHiddenInfo();
    }),
  );

  // === 恢复按钮点击逻辑（相对安全，不做覆盖范围校验拦截） ===
  $unhideBtn.on(
    "click",
    errorCatched(async () => {
      const range = parseHideFloorRangeInput($unhideInput.val());
      if (!range) {
        notify("error", "恢复范围格式不对，请输入如 2-45 或单个楼层号 5");
        return;
      }

      const context = getCtx();
      await context.executeSlashCommandsWithOptions(
        `/unhide ${range.start}-${range.end}`,
      );
      notify("success", `已恢复第${range.start}-${range.end}楼`);
      $unhideInput.val("");
      refreshHiddenInfo();
    }),
  );

  [$hideBtn, $unhideBtn].forEach(($btn) => {
    $btn.hover(
      function () {
        $(this).css("opacity", 0.85);
      },
      function () {
        $(this).css("opacity", 1);
      },
    );
  });
}
