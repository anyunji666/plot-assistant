"use strict";

// =====================================================================================
// === 私信数据迁移 · 弹窗 UI：跟 chat-migration/ui.js 同一套骨架 ===
// =====================================================================================

import { errorCatched, notify } from "../core.js";
import { downloadPhoneMigrationExport, importPhoneMigrationFromText } from "./generator.js";
import { loadLastPhoneExportAt, loadLastPhoneImportAt, saveLastPhoneExportAt, saveLastPhoneImportAt } from "./store.js";

// === Helper: ISO 字符串 -> "MM-DD HH:mm"，解析失败返回 null ===
function formatTimestamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatLastHint(prefix, iso) {
  const t = formatTimestamp(iso);
  return t ? `最近一次 ${prefix}：${t}` : `最近一次 ${prefix}：暂无`;
}

export function openPhoneMigrationDialog() {
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
  const $title = $("<div>").text("私信数据").css({
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
      "导出当前角色卡下所有联系人的私信聊天记录（正文+时间，图片消息只保留文字描述）与联系人角色卡资料（世界书「角色卡：」条目），可以拿到另一端导入。导入规则：聊天记录按联系人整份覆盖同名记录；角色卡资料只新增缺失的联系人，已有同名角色卡不会被覆盖。",
    )
    .css({ fontSize: "0.8em", color: "#999", lineHeight: 1.5 });

  const btnCss = {
    padding: "8px 14px",
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
  const lastHintCss = { fontSize: "0.8em", color: "#999" };

  const $lastExportHint = $("<span>").css(lastHintCss).text(formatLastHint("导出", loadLastPhoneExportAt()));
  const $lastImportHint = $("<span>").css(lastHintCss).text(formatLastHint("导入", loadLastPhoneImportAt()));

  const $exportRow = $("<div>").css({ display: "flex", gap: "10px", alignItems: "center", justifyContent: "space-between" });
  const $exportBtn = $("<button>").text("导出").css({ ...btnCss, background: "#3a9d5a" });
  $exportRow.append($lastExportHint, $exportBtn);

  const $importRow = $("<div>").css({ display: "flex", gap: "10px", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" });
  const $importBtn = $("<button>").text("导入").css({ ...btnCss, background: "#3a9d5a" });
  const $importFileInput = $('<input type="file" accept=".json,application/json">').css({ display: "none" });
  $importRow.append($lastImportHint, $importBtn, $importFileInput);

  $box.append($titleRow, $desc, $exportRow, $importRow);
  $overlay.append($box);
  $("body").append($overlay);

  const close = () => {
    $(document).off("keydown.phoneMigrationDialog");
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
  $(document).on("keydown.phoneMigrationDialog", (e) => {
    if (e.key === "Escape") close();
  });

  $exportBtn.on(
    "click",
    errorCatched(async () => {
      const { contactCount, messageContactCount } = await downloadPhoneMigrationExport();
      notify("success", `已导出 ${messageContactCount} 位联系人的私信记录、${contactCount} 条联系人角色卡资料。`);
      const nowIso = new Date().toISOString();
      saveLastPhoneExportAt(nowIso);
      $lastExportHint.text(formatLastHint("导出", nowIso));
    }),
  );

  $importBtn.on("click", () => $importFileInput.trigger("click"));

  $importFileInput.on("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = errorCatched(async (ev) => {
      const rawText = ev.target.result;
      const result = await importPhoneMigrationFromText(rawText);
      if (result === null) return; // 用户在确认弹窗里点了取消
      notify(
        "success",
        `已导入 ${result.messageContactCount} 位联系人的私信记录；角色卡资料新增 ${result.contactAdded} 条，跳过已存在的 ${result.contactSkipped} 条。`,
      );
      const nowIso = new Date().toISOString();
      saveLastPhoneImportAt(nowIso);
      close();
    });
    reader.onerror = () => {
      notify("error", "读取文件失败，请重试。");
    };
    reader.readAsText(file, "utf-8");
    $importFileInput.val("");
  });

  [$exportBtn, $importBtn].forEach(($btn) => {
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
