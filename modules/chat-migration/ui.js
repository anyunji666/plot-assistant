"use strict";

// =====================================================================================
// === 聊天记录迁移 · 弹窗 UI：仿 openHideFloorDialog / openCustomFieldsDialog 同一套骨架
// （常驻式，不一次性关闭）===
// =====================================================================================

import { CHAT_MIGRATION_IMPORT_MODE, CHAT_MIGRATION_TAG_MODE, confirmAction, errorCatched, escapeHtml, notify } from "../core.js";
import { parseFloorRangeInput } from "./parser.js";
import { checkChatMigrationIssues, downloadChatMigrationExport, importChatMigrationFromText } from "./generator.js";
import { loadLastExportRange, loadLastImportRange, saveLastExportRange, saveLastImportRange } from "./store.js";

export function openChatMigrationDialog() {
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
  const $title = $("<div>").text("聊天记录").css({
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
      "导出当前聊天的正文+摘要块为一份 JSON 文件，可以拿到另一端导入。摘要块（含状态数据）恒定保留，导入后会自动重建状态表。0层开场白和所有用户楼层始终原样导出，下方模式只对非0层的AI回复楼层生效。",
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

  // === 单选组通用构造 ===
  function buildRadioGroup(name, options, defaultValue) {
    const $group = $("<div>").css({ display: "flex", flexDirection: "column", gap: "8px" });
    options.forEach(([value, label]) => {
      const $label = $("<label>").css({
        display: "flex",
        alignItems: "flex-start",
        gap: "8px",
        fontSize: "0.86em",
        color: "#c0c0c0",
        cursor: "pointer",
        userSelect: "none",
      });
      const $radio = $("<input>")
        .attr({ type: "radio", name })
        .prop("checked", value === defaultValue)
        .val(value)
        .css({ cursor: "pointer", marginTop: "3px" });
      $label.append($radio, $("<span>").text(label));
      $group.append($label);
    });
    return $group;
  }

  // === 正文截取模式（每次打开弹窗都用默认选项，不再记忆上次的选择）===
  const modeGroupName = "chat-migration-mode";
  const $modeGroup = buildRadioGroup(
    modeGroupName,
    [
      [CHAT_MIGRATION_TAG_MODE.SUMMARY_ONLY, "仅摘要块 —— 正文整层留空"],
      [CHAT_MIGRATION_TAG_MODE.WHITELIST, "摘要块 + 保留标签块 —— 只保留下方标签命中的整段"],
      [CHAT_MIGRATION_TAG_MODE.EXCLUDE, "摘要块 + 其它（默认）—— 正文全保留，剔除下方标签命中的整段"],
    ],
    CHAT_MIGRATION_TAG_MODE.EXCLUDE,
  );

  const $tagWrap = $("<div>").css({ display: "flex", flexDirection: "column", gap: "4px" });
  const $tagLabel = $("<label>").css({ fontSize: "0.82em", color: "#999" });
  const $tagInput = $("<input>").attr({ type: "text", placeholder: "如 thinking,ooc" }).css(inputCss);
  $tagWrap.append($tagLabel, $tagInput);

  function syncTagWrapToMode() {
    const mode = $modeGroup.find("input:checked").val();
    if (mode === CHAT_MIGRATION_TAG_MODE.SUMMARY_ONLY) {
      $tagWrap.css("display", "none");
    } else if (mode === CHAT_MIGRATION_TAG_MODE.WHITELIST) {
      $tagWrap.css("display", "flex");
      $tagLabel.text("保留标签（逗号分隔，只有命中的标签块会被保留为正文）");
    } else {
      $tagWrap.css("display", "flex");
      $tagLabel.text("排除标签（逗号分隔，命中的标签块会从正文里剔除，留空则整层原样保留）");
    }
  }
  $modeGroup.find("input").on("change", syncTagWrapToMode);
  syncTagWrapToMode();

  // === 导出楼层范围（可选）===
  const $rangeWrap = $("<div>").css({ display: "flex", flexDirection: "column", gap: "4px" });
  const $rangeLabel = $("<label>")
    .text("导出楼层范围（可选，留空导出全部；起始/结束都是楼层号，含首尾）")
    .css({ fontSize: "0.82em", color: "#999" });
  const $rangeInputRow = $("<div>").css({ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" });
  const rangeInputCss = { ...inputCss, width: "8em", flex: "0 0 auto" };
  const $rangeStartInput = $("<input>")
    .attr({ type: "number", min: "0", placeholder: "起始" })
    .css(rangeInputCss);
  const $rangeSep = $("<span>").text("—").css({ color: "#999" });
  const $rangeEndInput = $("<input>")
    .attr({ type: "number", min: "0", placeholder: "结束" })
    .css(rangeInputCss);

  $rangeInputRow.append($rangeStartInput, $rangeSep, $rangeEndInput);

  // === "最近一次导出/导入" 提示文字：靠按钮左边 ===
  const lastHintCss = { fontSize: "0.8em", color: "#999" };
  function formatLastHint(prefix, range) {
    return range ? `最近一次 ${prefix}：${range.start}-${range.end}` : `最近一次 ${prefix}：暂无`;
  }
  const $lastExportHint = $("<span>").css(lastHintCss).text(formatLastHint("导出", loadLastExportRange()));
  const $lastImportHint = $("<span>").css(lastHintCss).text(formatLastHint("导入", loadLastImportRange()));

  // === 导出按钮：另起一行放在导出楼层范围输入框下面，左边是"最近一次导出"提示 ===
  const $exportRow = $("<div>").css({ display: "flex", gap: "10px", alignItems: "center", justifyContent: "space-between" });
  const $exportBtn = $("<button>").text("导出").css({ ...btnCss, background: "#3a9d5a" });
  $exportRow.append($lastExportHint, $exportBtn);
  $rangeWrap.append($rangeLabel, $rangeInputRow, $exportRow);

  // === 导入方式 ===
  const $importModeDivider = $("<div>").css({ borderTop: "1px solid #3a3a3a", margin: "4px 0" });
  const importModeGroupName = "chat-migration-import-mode";
  const $importModeGroup = buildRadioGroup(
    importModeGroupName,
    [
      [CHAT_MIGRATION_IMPORT_MODE.OVERWRITE, "覆盖当前聊天（默认，整份替换，不可撤销）"],
      [CHAT_MIGRATION_IMPORT_MODE.MERGE, "按楼层号合并更新（推荐配合“导出楼层范围”做增量同步）"],
      [CHAT_MIGRATION_IMPORT_MODE.NEWCHAT, "导入为新聊天（新建一个聊天，不影响当前聊天）"],
    ],
    CHAT_MIGRATION_IMPORT_MODE.OVERWRITE,
  );

  const $importBtn = $("<button>").text("导入").css({ ...btnCss, background: "#3a9d5a" });
  const $importFileInput = $('<input type="file" accept=".json,application/json">').css({ display: "none" });
  const $btnRow = $("<div>").css({ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" });
  $btnRow.append($lastImportHint, $importBtn, $importFileInput);

  $box.append($titleRow, $desc, $modeGroup, $tagWrap, $rangeWrap, $importModeDivider, $importModeGroup, $btnRow);
  $overlay.append($box);
  $("body").append($overlay);

  const close = () => {
    $(document).off("keydown.chatMigrationDialog");
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
  $(document).on("keydown.chatMigrationDialog", (e) => {
    if (e.key === "Escape") close();
  });

  $exportBtn.on(
    "click",
    errorCatched(async () => {
      const mode = $modeGroup.find("input:checked").val();
      const tagsRaw = $tagInput.val();
      const rangeStart = parseFloorRangeInput($rangeStartInput.val());
      const rangeEnd = parseFloorRangeInput($rangeEndInput.val());

      const issues = checkChatMigrationIssues(mode, tagsRaw, rangeStart, rangeEnd);
      if (issues.length > 0) {
        const issueHtml = issues.map((msg) => `• ${escapeHtml(msg)}`).join("<br><br>");
        const proceed = await confirmAction("导出前检测到以下问题", `${issueHtml}<br><br>是否仍然导出？`);
        if (!proceed) return;
      }

      const { count, floorStart, floorEnd } = downloadChatMigrationExport(mode, tagsRaw, rangeStart, rangeEnd);
      notify("success", `已导出 ${count} 层楼的聊天记录。`);
      if (Number.isFinite(floorStart) && Number.isFinite(floorEnd)) {
        saveLastExportRange(floorStart, floorEnd);
        $lastExportHint.text(formatLastHint("导出", { start: floorStart, end: floorEnd }));
      }
    }),
  );

  $importBtn.on("click", () => $importFileInput.trigger("click"));

  $importFileInput.on("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = errorCatched(async (ev) => {
      const rawText = ev.target.result;

      // 提前瞄一眼文件是不是"范围导出"：如果是，且用户还停在默认的"覆盖当前聊天"，
      // 自动切换成"按楼层号合并更新"并提示一下，避免手滑用局部数据整份覆盖掉当前聊天。
      let peekData = null;
      try {
        peekData = JSON.parse(rawText);
      } catch (error) {
        peekData = null;
      }
      const isPeekRangeExport = peekData && (Number.isFinite(peekData.rangeStart) || Number.isFinite(peekData.rangeEnd));
      let importMode = $importModeGroup.find("input:checked").val();
      if (isPeekRangeExport && importMode === CHAT_MIGRATION_IMPORT_MODE.OVERWRITE) {
        importMode = CHAT_MIGRATION_IMPORT_MODE.MERGE;
        $importModeGroup.find(`input[value="${CHAT_MIGRATION_IMPORT_MODE.MERGE}"]`).prop("checked", true);
        notify("info", "检测到这是范围导出文件，已自动切换为「按楼层号合并更新」。");
      }

      const result = await importChatMigrationFromText(rawText, importMode);
      if (result === null) return; // 用户在某个确认弹窗里点了取消
      const { count, floorStart, floorEnd } = result;
      notify("success", `已处理 ${count} 层楼，状态表已同步重建。`);
      if (Number.isFinite(floorStart) && Number.isFinite(floorEnd)) {
        saveLastImportRange(floorStart, floorEnd);
      }
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
