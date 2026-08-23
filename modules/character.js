"use strict";

import { CHARACTER_ENTRY_DEFAULTS, CHARACTER_ENTRY_TITLE_PREFIX, getCtx, notify } from "./core.js";
import { getFreeUid, getOrCreateSummaryLorebook, notifyWorldInfoUpdated } from "./worldinfo.js";


// =====================================================================================
// === 角色卡功能 ===
// 与总结/状态表共用同一本"角色名总结"世界书，条目标题固定加 CHARACTER_ENTRY_TITLE_PREFIX 前缀，
// 关键词触发（selective），只有正文提到该人名时才会注入上下文。
// 已有条目的编辑/删除直接复用面板下方通用的"世界书条目"列表（.entry-save / .entry-delete），
// 这里只负责"新建"这一步。
// =====================================================================================

// === Helper: 从角色名提取触发关键词（全名 + 去姓简称），沿用原脚本规则 ===
export function extractCharacterKeywords(name) {
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(name)) {
    const len = name.length;
    if (len === 2) return [name];
    if (len === 3) return [name, name.slice(1)];
    if (len === 4) return [name, name.slice(2)];
  }
  if (/^[A-Za-z]+([ ][A-Za-z]+)+$/.test(name)) {
    return [name, name.split(" ")[0]];
  }
  return [name];
}


// === Helper: 新建一条角色卡条目（重名会报错，请去下方世界书条目列表里直接编辑） ===
export async function saveNewCharacterEntry(lorebookName, name, gender, other) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  const title = CHARACTER_ENTRY_TITLE_PREFIX + name;
  const existing = Object.values(data.entries).find(
    (entry) => entry.comment === title,
  );
  if (existing) {
    throw new Error(
      `联系人「${name}」已存在，请在下方"世界书条目"列表里直接编辑，或换一个名字`,
    );
  }

  const newUid = getFreeUid(data);
  if (newUid === null) throw new Error("无法为新世界书条目分配 uid。");

  // 固定存 gender / other 两个字段（配合手机私信面板"读取姓名/性别/其它"，姓名已经在 comment/character 属性里了）。
  // other 支持多行文本，原样拼在 "other:" 之后，作为整个标签内最后一个字段。
  const content = `<character_information character="${name}">\ngender: ${gender || ""}\nother: ${other || ""}\n</character_information>`;

  data.entries[newUid] = {
    uid: newUid,
    comment: title,
    content,
    disable: true, // 默认关闭：不会自动注入正文，手机插件需要时直接读取内容即可
    constant: false, // 关键词触发，不常驻（关闭状态下这个也不生效，留着方便你以后手动开启）
    key: extractCharacterKeywords(name),
    position: 0, // 角色定义之前
    useGroupScoring: false,
    excludeRecursion: true,
    preventRecursion: true,
    delayUntilRecursion: 0,
    ...CHARACTER_ENTRY_DEFAULTS,
  };

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
  return name;
}


// === Function: 打开"新建角色"弹窗（角色名 + 其他信息，样式对齐"对话前强调"弹窗） ===
export async function openCreateCharacterDialog() {
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

    const $title = $("<div>").text("添加联系人").css({
      fontSize: "1.05em",
      fontWeight: "600",
      color: "#f0f0f0",
      letterSpacing: "0.01em",
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

    const $errorMsg = $("<div>").css({
      fontSize: "0.82em",
      color: "#f28b82",
      display: "none",
    });

    const $nameWrap = $("<div>").css({
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });
    $nameWrap.append(
      $("<label>")
        .html('联系人姓名 <span style="color:#f28b82">*</span>')
        .css({ fontSize: "0.82em", color: "#999" }),
    );
    const $nameInput = $('<input type="text">')
      .attr("placeholder", "姓名")
      .css(inputCss);
    $nameWrap.append($nameInput);

    const $genderWrap = $("<div>").css({
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });
    $genderWrap.append(
      $("<label>")
        .html('性别 <span style="color:#f28b82">*</span>')
        .css({ fontSize: "0.82em", color: "#999" }),
    );
    const $genderInput = $('<input type="text">')
      .attr("placeholder", "男/女")
      .css(inputCss);
    $genderWrap.append($genderInput);

    const $otherWrap = $("<div>").css({
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });
    $otherWrap.append(
      $("<label>").text("其它").css({ fontSize: "0.82em", color: "#999" }),
    );
    const $otherInput = $("<textarea>")
      .attr("placeholder", "性格、背景、说话习惯等，选填")
      .css({ ...inputCss, minHeight: "90px", resize: "vertical" });
    $otherWrap.append($otherInput);

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
      .text("写入世界书")
      .css({
        ...btnCss,
        border: "none",
        background: "#5b9cf6",
        color: "#ffffff",
        fontWeight: "600",
      });
    $btnRow.append($cancel, $confirm);

    $box.append($title, $nameWrap, $genderWrap, $otherWrap, $errorMsg, $btnRow);
    $overlay.append($box);
    $("body").append($overlay);
    setTimeout(() => $nameInput.trigger("focus"), 50);

    const done = (confirmed) => {
      $(document).off("keydown.createCharacterDialog");
      $overlay.remove();
      $bodyEl.css("overflow", prevBodyOverflow || "");
      resolve(
        confirmed
          ? {
              name: $nameInput.val().trim(),
              gender: $genderInput.val().trim(),
              other: $otherInput.val().trim(),
            }
          : null,
      );
    };

    // 姓名 + 性别必填，留空时不关闭弹窗，标红对应输入框并提示。
    const tryConfirm = () => {
      const nameVal = $nameInput.val().trim();
      const genderVal = $genderInput.val().trim();
      const missing = [];
      $nameInput.css("borderColor", nameVal ? "#3a3a3a" : "#f28b82");
      $genderInput.css("borderColor", genderVal ? "#3a3a3a" : "#f28b82");
      if (!nameVal) missing.push("姓名");
      if (!genderVal) missing.push("性别");
      if (missing.length > 0) {
        $errorMsg.text(`请填写：${missing.join("、")}`).css("display", "block");
        return;
      }
      done(true);
    };

    $confirm.on("click", tryConfirm);
    $cancel.on("click", () => done(false));

    let overlayPointerDownOnSelf = false;
    $overlay.on("mousedown touchstart", (e) => {
      overlayPointerDownOnSelf = $(e.target).is($overlay);
    });
    $overlay.on("mouseup touchend", (e) => {
      if (overlayPointerDownOnSelf && $(e.target).is($overlay)) done(false);
      overlayPointerDownOnSelf = false;
    });
    $(document).on("keydown.createCharacterDialog", (e) => {
      if (e.key === "Escape") done(false);
    });
  });

  if (!result || !result.name) return;

  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const saved = await saveNewCharacterEntry(
      lorebookName,
      result.name,
      result.gender,
      result.other,
    );
    notify("success", `联系人「${saved}」已写入「${lorebookName}」`);
  } catch (error) {
    console.error("[剧情助手] 写入联系人条目失败:", error);
    notify("error", `写入联系人条目失败：${error.message || error}`);
  }
}
