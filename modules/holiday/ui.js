"use strict";

import { notify } from "../core.js";
import { parseCustomHolidaysText } from "./calc.js";
import {
  getRestPresetText,
  setRestPresetText,
  getCustomHolidaysRawText,
  setCustomHolidaysRawText,
} from "./settings.js";

// === Helper: 通用"标题+提示+多行 textarea+取消/保存"弹窗，样式对齐 phone/ui.js 的
// openPhonePresetDialog，两个节假日相关弹窗（假期预设/设置节假日）共用这一份 UI 骨架，
// 只是标题/提示文案/初始内容不同。返回 Promise<string|null>，取消时是 null。===
async function openTextDialog({ title, hint, initialValue }) {
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

    const $title = $("<div>").text(title).css({
      fontSize: "1.05em",
      fontWeight: "600",
      color: "#f0f0f0",
      letterSpacing: "0.01em",
    });

    const $hint = $("<div>")
      .text(hint)
      .css({
        fontSize: "0.8em",
        color: "#999",
        lineHeight: 1.5,
        whiteSpace: "pre-line",
      });

    const $textarea = $("<textarea>").val(initialValue).css({
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

    $box.append($title, $hint, $textarea, $btnRow);
    $overlay.append($box);
    $("body").append($overlay);
    setTimeout(() => $textarea.trigger("focus"), 50);

    const done = (confirmed) => {
      $(document).off("keydown.holidayTextDialog");
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
    $(document).on("keydown.holidayTextDialog", (e) => {
      if (e.key === "Escape") done(false);
    });
  });

  return result;
}

// === Function: 打开"假期预设"编辑框——纯文本，原样拼进 <holiday_judgment> 最前面，不做任何解析 ===
export async function openRestPresetDialog() {
  const result = await openTextDialog({
    title: "假期预设",
    hint: '整段文字会原样发送给AI，示例："高中生周一至周六上课，周日休息。"',
    initialValue: getRestPresetText(),
  });
  if (result === null) return;

  setRestPresetText(result);
  notify("success", "「假期预设」已保存");
}

// 没保存过内容时预填的默认示例，直接写进输入框里给你改，不用另外在提示文字里罗列示例
// （跟"对话前强调"弹窗预填 DEFAULT_PRE_EMPHASIS_CONTENT 是同一个思路）。
// 示例选的是插件内置表（对照 modules/holiday/calc.js 的 WORLD_HOLIDAYS / JAPAN_HOLIDAYS_FIXED /
// OBON_*）里没有的真实节日，避免预填内容一打开就跟内置表撞日期、显示成"两条一模一样的重复播报"。
// 内置节日本身已经在插件里自动生效，不需要用户填进这个文本框；插件内置了哪些节日，写在下面
// openCustomHolidaysDialog 的 hint 提示语里给用户对照，纯展示，不影响这个默认预填值。
const DEFAULT_CUSTOM_HOLIDAYS_TEXT = `6/1 国际儿童节
## 日本
11/23 勤労感謝の日
7/13~7/16 東京のお盆`;

// === Function: 打开"设置节假日"编辑框——多行文本，"## 分组名"起一个分组，之后每行"日期 名称"，
// 日期支持 9/9、6.1、12-25、6月1日 四种写法；区间节日用"起始日期~截止日期 名称"，比如
// 8/13~8/16 暑休（起止用同一种写法，不支持跨年区间）。保存时只做一次解析用于统计成功/跳过条数，
// 存储时原样保存整段文本（不重新格式化），下次打开时保留用户自己的写法。
// 自定义节假日和插件内置的节日表是并列关系：日期撞了内置节日/内置お盆时，两条会一起显示，不是谁盖谁。
// hint 里额外列出"已内置节日"清单（对照 calc.js 的 WORLD_HOLIDAYS/JAPAN_HOLIDAYS_FIXED/OBON_*），
// 纯展示用，告诉用户插件已经自动覆盖了哪些节日、不用重复填；这份清单不进文本框，只在弹窗里回显。===
export async function openCustomHolidaysDialog() {
  const hint =
    "功能：读取摘要模块的公历日期，计算出是星期几发送给AI；在临近节日的前两天/节日期间，" +
    "提醒AI几月几日是什么节日。\n" +
    '格式：日期 名称。支持 9/9、6.1、12-25、6月1日，区间用"起始~截止 名称"。' +
    '用 "## 地区名" 作类目标题为该地区的专属节日。\n' +
    "已内置节日：\n" +
    "1/1 元旦、2/14 情人节、5/1 国际劳工节、10/31 万圣节、12/24 平安夜、12/25 圣诞节、12/31 跨年夜\n" +
    "## 日本　2/3 節分、3/14 ホワイトデー、5/5 こどもの日、7/7 七夕、11/3 文化の日、8/13~8/16 お盆";

  const savedText = getCustomHolidaysRawText();
  const result = await openTextDialog({
    title: "设置节假日",
    hint,
    initialValue: savedText || DEFAULT_CUSTOM_HOLIDAYS_TEXT,
  });
  if (result === null) return;

  const { items, skipped } = parseCustomHolidaysText(result);
  setCustomHolidaysRawText(result);

  const message =
    skipped > 0
      ? `已保存，识别到 ${items.length} 条节假日，跳过 ${skipped} 行无法识别的内容`
      : `已保存，识别到 ${items.length} 条节假日`;
  notify("success", message);
}
