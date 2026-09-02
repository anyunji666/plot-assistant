"use strict";

import { DEFAULT_PRE_EMPHASIS_CONTENT, GENERATING_OVERLAY_ID, PRE_EMPHASIS_TITLE, confirmAction, errorCatched, getCtx, getOffsetRecord, notify } from "../core.js";
import { loadPreEmphasisEntry, savePreEmphasisEntry } from "./pre-emphasis.js";
import { getSummaryProgress } from "./floor-restore.js";
import { getOrCreateSummaryLorebook } from "../worldinfo.js";
import { niFetchModelIds } from "./status-llm/api.js";
import { DEFAULT_STATUS_LLM_PROMPT } from "./status-llm/prompts.js";
import { CUSTOM_FIELD_SCOPE_LABEL, CUSTOM_FIELD_VALUE_TYPE_LABEL, RESERVED_FIELD_NAMES, deleteCustomField, exportCustomFieldsText, getCustomFields, getCustomFieldsCharacterLabel, getStatusLlmSettings, importCustomFieldsText, saveCustomField, saveStatusLlmSettings } from "./status-llm/store.js";
import { rebuildStatusTableFromChat } from "./status-table.js";


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


// === Function: 打开"字段修改"弹窗——面板"摘要配置"区新增按钮，让用户直接向状态表LLM
// 发一条自然语言的一次性修改指令（Inventory/Setups/附加字段），不用理解字段格式规则，
// 由AI自己按现有协议算出增量。指令只存一份，拼进下一次实际调用状态表LLM的请求末尾后立即清空——
// 不是常驻配置，跟"对话前强调"/"状态表配置"这类持久化设置性质不同，所以弹窗骨架照抄后者，
// 但保存目标是 pendingMetaInstruction 而不是长期生效的字段。===
export async function openFieldMetaInstructionDialog() {
  const cfg = getStatusLlmSettings();
  const existingContent = cfg.pendingMetaInstruction || "";

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

    const $title = $("<div>").text("字段修改").css({
      fontSize: "1.05em",
      fontWeight: "600",
      color: "#f0f0f0",
      letterSpacing: "0.01em",
    });

    const $desc = $("<div>")
      .text(
        "对状态表LLM维护的字段向AI发送修改要求，有Inventory（物品）、Setups（伏笔/线索/约定）及“附加字段”。指令为单次指令，只拼接发送在下一次对话中。",
      )
      .css({ fontSize: "0.8em", color: "#999", lineHeight: 1.5 });

    const inputCss = {
      width: "100%",
      boxSizing: "border-box",
      padding: "8px 10px",
      borderRadius: "6px",
      border: "1px solid #3a3a3a",
      background: "#ffffff",
      color: "#000000",
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
      $("<label>").text("修改指令").css({ fontSize: "0.82em", color: "#999" }),
    );
    const $textInput = $("<textarea>")
      .attr({ rows: 6, placeholder: "例如：把{{user}}的玉佩数量改成3；清除角色A的“旧日承诺”这条伏笔" })
      .css({
        ...inputCss,
        resize: "vertical",
        minHeight: "100px",
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
      .text("关闭")
      .css({
        ...btnCss,
        border: "1px solid #3a3a3a",
        background: "transparent",
        color: "#c0c0c0",
      });
    const $confirm = $("<button>")
      .text("提交")
      .css({
        ...btnCss,
        border: "none",
        background: "#5b9cf6",
        color: "#ffffff",
        fontWeight: "600",
      });
    $btnRow.append($cancel, $confirm);

    $box.append($title, $desc, $textWrap, $btnRow);
    $overlay.append($box);
    $("body").append($overlay);
    setTimeout(() => $textInput.trigger("focus"), 50);

    const done = (confirmed) => {
      $(document).off("keydown.fieldMetaInstructionDialog");
      $overlay.remove();
      $bodyEl.css("overflow", prevBodyOverflow || "");
      resolve(confirmed ? { content: $textInput.val() } : null);
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
    $(document).on("keydown.fieldMetaInstructionDialog", (e) => {
      if (e.key === "Escape") done(false);
    });
  });

  if (!result) return;

  cfg.pendingMetaInstruction = (result.content || "").trim();
  saveStatusLlmSettings();
  notify(
    "success",
    cfg.pendingMetaInstruction
      ? "修改指令已记录，将在下一次状态表LLM调用时发送"
      : "修改指令已清空",
  );
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


// =====================================================================================
// === 附加字段管理弹窗（面板"附加字段"按钮） ===
// 让使用者自己起字段名+写提取规则，新增/编辑/删除后立即触发一次状态表全量重放
// （rebuildStatusTableFromChat），把最新的字段结构写回世界书"状态表"条目，不用等下一层楼才生效。
// 提取本身仍走状态表LLM那一路 API 调用（跟 Inventory/Setups 共用同一次请求），
// 弹窗只负责维护字段定义，不在这里发起AI调用。
// =====================================================================================

// === Function: 打开"附加字段"管理弹窗——常驻式（跟"隐藏楼层"同一套骨架），
// 列表 + 增/改表单在同一弹窗内，操作后不关闭，方便连续维护多个字段 ===
export function openCustomFieldsDialog() {
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
    width: "min(440px, calc(100% - 24px))",
    maxHeight: "min(85vh, calc(100dvh - 24px))",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
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
  const $title = $("<div>").text("附加字段").css({
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

  const $desc = $("<div>")
    .text(
      "自定义状态表LLM需要额外维护的变量，保存后会立即写入世界书「状态表」条目。数值型支持 +N/-N/=N 增减，文本型整条覆盖；角色维度按角色各存一份，全局维度不分角色只有一个值。",
    )
    .css({ fontSize: "0.8em", color: "#999", lineHeight: 1.5 });

  const characterLabel = getCustomFieldsCharacterLabel();
  const $charLabel = $("<div>")
    .text(
      characterLabel === "（未选中角色卡）"
        ? "未选中角色卡：这里的改动不会保存，仅本次会话临时生效"
        : "附加字段跟随角色卡存储，规则会自动拼接进状态表提示词末尾",
    )
    .css({
      fontSize: "0.78em",
      color: characterLabel === "（未选中角色卡）" ? "#d5a03a" : "#6a9dd0",
      lineHeight: 1.4,
    });

  const inputCss = {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3a3a",
    background: "#ffffff",
    color: "#000000",
    fontSize: "max(0.95em, 16px)",
    fontFamily: "inherit",
    outline: "none",
  };
  const btnCss = {
    padding: "6px 12px",
    borderRadius: "6px",
    boxSizing: "border-box",
    border: "none",
    cursor: "pointer",
    fontSize: "0.82em",
    fontWeight: "600",
    color: "#fff",
    touchAction: "manipulation",
    whiteSpace: "nowrap",
  };

  // === 字段列表区 ===
  const $listWrap = $("<div>").css({
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  });

  // === 增/改 表单区（默认隐藏，点"新增字段"或某行"编辑"时展开） ===
  const $formWrap = $("<div>").css({
    display: "none",
    flexDirection: "column",
    gap: "10px",
    borderTop: "1px solid #3a3a3a",
    paddingTop: "12px",
  });

  const $formTitle = $("<div>").text("新增字段").css({
    fontSize: "0.92em",
    fontWeight: "600",
    color: "#e0e0e0",
  });

  function buildFieldRow(labelText, $input) {
    const $wrap = $("<div>").css({ display: "flex", flexDirection: "column", gap: "4px" });
    $wrap.append($("<label>").text(labelText).css({ fontSize: "0.82em", color: "#999" }));
    $wrap.append($input);
    return $wrap;
  }

  function buildRadioGroup(name, options, defaultValue) {
    const $group = $("<div>").css({ display: "flex", gap: "14px" });
    options.forEach(([value, label]) => {
      const $label = $("<label>").css({
        display: "flex",
        alignItems: "center",
        gap: "5px",
        fontSize: "0.88em",
        color: "#c0c0c0",
        cursor: "pointer",
        userSelect: "none",
      });
      const $radio = $("<input>")
        .attr({ type: "radio", name })
        .prop("checked", value === defaultValue)
        .val(value)
        .css({ cursor: "pointer" });
      $label.append($radio, $("<span>").text(label));
      $group.append($label);
    });
    return $group;
  }

  const $nameInput = $('<input type="text" placeholder="如：武力值、青云宗声望值、内心想法、天气状况">').css(inputCss);

  const valueTypeGroupName = "custom-field-value-type";
  const $valueTypeGroup = buildRadioGroup(
    valueTypeGroupName,
    [
      ["numeric", "数值增减（+N/-N/=N）"],
      ["text", "文本覆盖（整条替换）"],
    ],
    "numeric",
  );

  const scopeGroupName = "custom-field-scope";
  const $scopeGroup = buildRadioGroup(
    scopeGroupName,
    [
      ["character", "按角色（各角色各一份）"],
      ["global", "全局（不分角色，只一份）"],
    ],
    "character",
  );

  // 提取依据说明的示例文案，按"取值方式×维度"四种组合各写一条，随单选切换动态展示——
  // 因为四种组合下游拼出来的伪代码结构完全不同（数值型是+N/-N/=N增减，文本型是整条覆盖；
  // 角色维度要分角色写，全局维度不用带角色名前缀），通用示例不够贴切，示例必须跟着当前选择走。
  const RULE_EXAMPLES = {
    "numeric|character": "根据本轮剧情描写的角色经历，调整角色的武力值，如境界突破/身负重伤算大幅变化(±200)，精神极佳/身体疲劳算小幅变化(±20)",
    "numeric|global": "剧情中出现明显提升或损害团队名声的事件才记，如帮派铲除恶霸算+15，成员当众失礼算-10，日常互动不记",
    "text|character": "本轮非{{user}}的角色心理想法是怎样的？代入角色视角用第一人称书写，不超过30字",
    "text|global": "场景当前的天气是什么样的，如晴朗、多云、小雨、暴雨、台风天等，不超过6个字",
  };

  const $ruleExample = $("<div>").css({
    fontSize: "0.76em",
    color: "#888",
    lineHeight: 1.4,
  });

  function updateRuleExample() {
    const valueType = $valueTypeGroup.find("input:checked").val();
    const scope = $scopeGroup.find("input:checked").val();
    const example = RULE_EXAMPLES[`${valueType}|${scope}`] || "";
    $ruleExample.text(
      `格式要求：写成一句话，只说明触发条件和取值逻辑，不要换行、不要用反引号。参考：${example}`,
    );
  }
  $valueTypeGroup.find("input").on("change", updateRuleExample);
  $scopeGroup.find("input").on("change", updateRuleExample);
  updateRuleExample();

  const $ruleInput = $("<textarea>")
    .attr({ rows: 3, placeholder: "提取依据说明，会拼进状态表LLM的提示词，指导AI怎么判断本轮该怎么变" })
    .css({ ...inputCss, resize: "vertical", minHeight: "60px" });

  const $formBtnRow = $("<div>").css({ display: "flex", gap: "10px", justifyContent: "flex-end" });
  const $formCancelBtn = $("<button>").text("取消").css({
    ...btnCss,
    border: "1px solid #3a3a3a",
    background: "transparent",
    color: "#c0c0c0",
  });
  const $formSaveBtn = $("<button>").text("保存").css({ ...btnCss, background: "#5b9cf6" });
  $formBtnRow.append($formCancelBtn, $formSaveBtn);

  $formWrap.append(
    $formTitle,
    buildFieldRow("字段名", $nameInput),
    buildFieldRow("取值方式", $valueTypeGroup),
    buildFieldRow("维度", $scopeGroup),
    buildFieldRow("提取依据说明", $("<div>").css({ display: "flex", flexDirection: "column", gap: "4px" }).append($ruleInput, $ruleExample)),
    $formBtnRow,
  );

  const $addBtn = $("<button>").text("+ 新增字段").css({
    ...btnCss,
    background: "#3a9d5a",
  });

  // === 导入/导出 TXT（跟"+ 新增字段"同一行，紧挨在旁边）===
  // 导出：当前角色卡下全部字段打包成一份 TXT；导入：解析同样格式的 TXT，同名字段覆盖更新。
  const secondaryBtnCss = {
    ...btnCss,
    border: "1px solid #3a3a3a",
    background: "transparent",
    color: "#9db8e0",
    fontWeight: "500",
  };
  const $exportBtn = $("<button>").text("导出").css(secondaryBtnCss);
  const $importBtn = $("<button>").text("导入").css(secondaryBtnCss);
  const $importFileInput = $('<input type="file" accept=".txt,text/plain">').css({
    display: "none",
  });
  const $addBtnRow = $("<div>").css({
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  });
  $addBtnRow.append($addBtn, $exportBtn, $importBtn, $importFileInput);

  let editingFieldId = null; // null = 新增；否则是正在编辑的字段 id

  function openForm(field) {
    editingFieldId = field ? field.id : null;
    $formTitle.text(field ? "编辑字段" : "新增字段");
    $nameInput.val(field ? field.name : "");
    $valueTypeGroup
      .find("input")
      .each(function () {
        $(this).prop("checked", $(this).val() === (field ? field.valueType : "numeric"));
      });
    $scopeGroup
      .find("input")
      .each(function () {
        $(this).prop("checked", $(this).val() === (field ? field.scope : "character"));
      });
    $ruleInput.val(field ? field.rule || "" : "");
    updateRuleExample();
    $formWrap.css("display", "flex");
    setTimeout(() => $nameInput.trigger("focus"), 50);
  }

  function closeForm() {
    editingFieldId = null;
    $formWrap.css("display", "none");
  }

  // === 渲染字段列表 ===
  function renderList() {
    $listWrap.empty();
    const fields = getCustomFields();
    if (fields.length === 0) {
      $listWrap.append(
        $("<div>").text("暂无附加字段").css({ fontSize: "0.85em", color: "#777" }),
      );
      return;
    }
    fields.forEach((field) => {
      const $row = $("<div>").css({
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        background: "#2f2f2f",
        borderRadius: "6px",
        padding: "8px 10px",
      });
      const $info = $("<div>").css({ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 });
      $info.append(
        $("<div>").text(field.name).css({
          fontSize: "0.92em",
          color: "#f0f0f0",
          fontWeight: "600",
          wordBreak: "break-all",
        }),
      );
      $info.append(
        $("<div>")
          .text(
            `${CUSTOM_FIELD_VALUE_TYPE_LABEL[field.valueType] || field.valueType} · ${CUSTOM_FIELD_SCOPE_LABEL[field.scope] || field.scope}`,
          )
          .css({ fontSize: "0.76em", color: "#999" }),
      );
      const $actions = $("<div>").css({ display: "flex", gap: "6px", flexShrink: 0 });
      const $editBtn = $("<button>").text("编辑").css({
        ...btnCss,
        padding: "4px 10px",
        fontSize: "0.78em",
        background: "#3a3a3a",
      });
      const $delBtn = $("<button>").text("删除").css({
        ...btnCss,
        padding: "4px 10px",
        fontSize: "0.78em",
        background: "#8a3a3a",
      });
      $editBtn.on("click", () => openForm(field));
      $delBtn.on(
        "click",
        errorCatched(async () => {
          const proceed = await confirmAction(
            "删除附加字段",
            `确定删除字段「${field.name}」吗？状态表里该字段的已有数据会在下次重新计算时被移除。`,
          );
          if (!proceed) return;
          deleteCustomField(field.id);
          renderList();
          await rebuildStatusTableFromChat();
          notify("success", `已删除字段「${field.name}」，状态表已同步更新`);
        }),
      );
      $actions.append($editBtn, $delBtn);
      $row.append($info, $actions);
      $listWrap.append($row);
    });
  }
  renderList();

  $box.append($titleRow, $desc, $charLabel, $listWrap, $addBtnRow, $formWrap);
  $overlay.append($box);
  $("body").append($overlay);

  const close = () => {
    $(document).off("keydown.customFieldsDialog");
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
  $(document).on("keydown.customFieldsDialog", (e) => {
    if (e.key === "Escape") close();
  });

  $addBtn.on("click", () => openForm(null));
  $formCancelBtn.on("click", () => closeForm());

  $exportBtn.on(
    "click",
    errorCatched(() => {
      const text = exportCustomFieldsText();
      if (!text) {
        notify("error", "当前还没有附加字段，无需导出。");
        return;
      }
      const characterLabelForFile = getCustomFieldsCharacterLabel();
      const safeName =
        characterLabelForFile === "（未选中角色卡）" ? "未命名" : characterLabelForFile;
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `附加字段-${safeName}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      notify("success", "附加字段已导出为文本文件。");
    }),
  );

  $importBtn.on("click", () => $importFileInput.trigger("click"));

  $importFileInput.on("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = errorCatched(async (ev) => {
      const result = importCustomFieldsText(ev.target.result);
      closeForm();
      renderList();
      await rebuildStatusTableFromChat();
      const skippedNote =
        result.skipped.length > 0
          ? `，跳过 ${result.skipped.length} 个（${result.skipped
              .map((s) => `${s.name}：${s.reason}`)
              .join("；")}）`
          : "";
      notify(
        "success",
        `导入完成：新增 ${result.created} 个，覆盖 ${result.overwritten} 个${skippedNote}，状态表已同步更新`,
      );
    });
    reader.onerror = () => {
      notify("error", "读取文件失败，请重试。");
    };
    reader.readAsText(file, "utf-8");
    // 清空 value，允许连续两次选同一个文件都能触发 change
    $importFileInput.val("");
  });

  $formSaveBtn.on(
    "click",
    errorCatched(async () => {
      const name = $nameInput.val().trim();
      if (!name) {
        notify("error", "字段名不能为空");
        return;
      }
      if (RESERVED_FIELD_NAMES.has(name)) {
        notify("error", `"${name}" 是内置字段名，不能使用`);
        return;
      }
      const valueType = $valueTypeGroup.find("input:checked").val();
      const scope = $scopeGroup.find("input:checked").val();
      // 防呆：提取依据最终会拼成代码块里的单行注释（# 提取依据：xxx），
      // 换行会让后半截内容跑出注释范围、混进代码块里；反引号会跟包裹代码块的 ``` 冲突。
      // 这里静默清理，不用为了这种排版问题单独弹窗打断用户保存。
      const rule = $ruleInput.val().replace(/\s*\n+\s*/g, "；").replace(/`/g, "'").trim();

      try {
        saveCustomField({ id: editingFieldId, name, valueType, scope, rule });
      } catch (error) {
        notify("error", error.message || String(error));
        return;
      }
      closeForm();
      renderList();
      await rebuildStatusTableFromChat();
      notify("success", `字段「${name}」已保存，状态表已同步更新`);
    }),
  );

  [$addBtn, $exportBtn, $importBtn, $formSaveBtn, $formCancelBtn].forEach(($btn) => {
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


// =====================================================================================
// === 状态表LLM配置弹窗 ===
// Inventory/Setups 两个字段独立于剧情LLM之外的一路可选配置：apiUrl 留空 = 跟随酒馆当前连接
// （与"自动小总结"/"摘要提取"未配置时的行为一致），非空 = 走这里填写的自定义反代。
// 提示词默认值 = DEFAULT_STATUS_LLM_PROMPT，可在这里自定义（遇到截断/拒绝时常见的调整点）。
// =====================================================================================
export async function openStatusLlmConfigDialog() {
  const cfg = getStatusLlmSettings();

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
      width: "min(440px, calc(100% - 24px))",
      maxHeight: "min(85vh, calc(100dvh - 24px))",
      display: "flex",
      flexDirection: "column",
      gap: "14px",
      color: "#e8e8e8",
      fontFamily: "inherit",
      boxSizing: "border-box",
      boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
    });

    const $title = $("<div>").text("状态表配置").css({
      fontSize: "1.05em",
      fontWeight: "600",
      color: "#f0f0f0",
      letterSpacing: "0.01em",
    });

    const $desc = $("<div>")
      .text(
        "独立于剧情LLM之外，专门用于从每层正文提取 Inventory/Setups 两个字段。API地址留空则跟随酒馆当前对话连接（同自动小总结）。",
      )
      .css({ fontSize: "0.8em", color: "#999", lineHeight: 1.5 });

    const inputCss = {
      width: "100%",
      boxSizing: "border-box",
      padding: "8px 10px",
      borderRadius: "6px",
      border: "1px solid #3a3a3a",
      background: "#ffffff",
      color: "#000000",
      fontSize: "max(0.95em, 16px)",
      fontFamily: "inherit",
      outline: "none",
    };

    function buildFieldRow(labelText, $input) {
      const $wrap = $("<div>").css({
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      });
      $wrap.append(
        $("<label>").text(labelText).css({ fontSize: "0.82em", color: "#999" }),
      );
      $wrap.append($input);
      return $wrap;
    }

    const $apiUrlInput = $('<input type="text" placeholder="留空=跟随酒馆当前连接">')
      .css(inputCss)
      .val(cfg.apiUrl || "");
    const $apiKeyInput = $('<input type="password" placeholder="仅自定义反代时需要">')
      .css(inputCss)
      .val(cfg.apiKey || "");

    const $modelRow = $("<div>").css({ display: "flex", gap: "6px" });
    const $modelInput = $('<input type="text" placeholder="模型 ID，例如 gpt-4o-mini">')
      .css({ ...inputCss, flex: 1 })
      .val(cfg.model || "");
    const $modelSelect = $("<select>")
      .css({ ...inputCss, flex: 1, display: "none" });
    const $modelFetchBtn = $("<button>")
      .text("获取列表")
      .css({
        padding: "8px 10px",
        borderRadius: "6px",
        border: "1px solid #3a3a3a",
        background: "#333",
        color: "#e8e8e8",
        cursor: "pointer",
        fontSize: "0.82em",
        whiteSpace: "nowrap",
      });
    $modelRow.append($modelInput, $modelSelect, $modelFetchBtn);

    $modelFetchBtn.on("click", async () => {
      const url = $apiUrlInput.val().trim();
      if (!url) {
        notify("error", "请先填写 API 地址");
        return;
      }
      $modelFetchBtn.prop("disabled", true).text("获取中…");
      try {
        const models = await niFetchModelIds({
          url,
          key: $apiKeyInput.val().trim(),
          fetchImpl: fetch,
        });
        if (!models.length) {
          notify("error", "未获取到模型列表");
          return;
        }
        $modelSelect
          .html(
            ['<option value="" disabled selected>请选择模型</option>']
              .concat(
                models.map(
                  (m) => `<option value="${m.replace(/"/g, "&quot;")}">${m}</option>`,
                ),
              )
              .join(""),
          )
          .css("display", "")
          .off("change")
          .on("change", function () {
            $modelInput.val($(this).val());
            $modelSelect.css("display", "none");
            $modelInput.css("display", "");
          });
        $modelInput.css("display", "none");
      } catch (e) {
        notify("error", `拉取失败: ${e.message || e}`);
      } finally {
        $modelFetchBtn.prop("disabled", false).text("获取列表");
      }
    });

    const $timeoutInput = $('<input type="number" min="1" step="1">')
      .css(inputCss)
      .val(Number.isFinite(cfg.apiTimeoutMin) ? cfg.apiTimeoutMin : 15);

    const $promptHeader = $("<div>").css({
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    });
    $promptHeader.append(
      $("<label>").text("提示词（Inventory/Setups 提取规则）").css({
        fontSize: "0.82em",
        color: "#999",
      }),
    );
    const $resetBtn = $("<button>")
      .text("恢复默认")
      .css({
        padding: "4px 8px",
        borderRadius: "6px",
        border: "1px solid #3a3a3a",
        background: "transparent",
        color: "#c0c0c0",
        cursor: "pointer",
        fontSize: "0.78em",
      });
    $promptHeader.append($resetBtn);

    const $promptInput = $("<textarea>")
      .attr({ rows: 10 })
      .css({
        ...inputCss,
        resize: "vertical",
        minHeight: "160px",
        maxHeight: "min(40vh, 40dvh)",
        fontFamily: "monospace",
        fontSize: "0.82em",
      })
      .val(cfg.customPrompt?.trim() ? cfg.customPrompt : DEFAULT_STATUS_LLM_PROMPT);

    $resetBtn.on("click", () => $promptInput.val(DEFAULT_STATUS_LLM_PROMPT));

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

    $box.append(
      $title,
      $desc,
      buildFieldRow("API 地址", $apiUrlInput),
      buildFieldRow("API Key", $apiKeyInput),
      buildFieldRow("模型", $modelRow),
      buildFieldRow("超时（分钟）", $timeoutInput),
      $promptHeader,
      $promptInput,
      $btnRow,
    );
    $overlay.append($box);
    $("body").append($overlay);

    const done = (confirmed) => {
      $(document).off("keydown.statusLlmConfigDialog");
      $overlay.remove();
      $bodyEl.css("overflow", prevBodyOverflow || "");
      resolve(
        confirmed
          ? {
              apiUrl: $apiUrlInput.val().trim(),
              apiKey: $apiKeyInput.val(),
              model: $modelInput.val().trim(),
              apiTimeoutMin: parseInt($timeoutInput.val(), 10),
              customPrompt: $promptInput.val(),
            }
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
    $(document).on("keydown.statusLlmConfigDialog", (e) => {
      if (e.key === "Escape") done(false);
    });
  });

  if (!result) return;

  cfg.apiUrl = result.apiUrl;
  cfg.apiKey = result.apiKey;
  cfg.model = result.model;
  cfg.apiTimeoutMin =
    Number.isFinite(result.apiTimeoutMin) && result.apiTimeoutMin > 0
      ? result.apiTimeoutMin
      : 15;
  cfg.customPrompt =
    result.customPrompt && result.customPrompt.trim() !== DEFAULT_STATUS_LLM_PROMPT.trim()
      ? result.customPrompt
      : "";
  saveStatusLlmSettings();
  notify(
    "success",
    `状态表配置已保存（${cfg.apiUrl ? "使用自定义API" : "跟随酒馆当前连接"}）`,
  );
}
