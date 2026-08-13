"use strict";

import { notify } from "../core.js";
import { getOrCreateSummaryLorebook } from "../worldinfo.js";
import {
  NEW_CHAPTER_OPTION_VALUE,
  extractSummaryFromContent,
  exportNovelChaptersText,
  importNovelChapters,
  listNovelChapterEntries,
  saveNovelChapterEntry,
} from "./store.js";


// =====================================================================================
// === 剧情录入功能：弹窗 UI ===
// 弹窗顶部下拉框可选择已创建章节进入"编辑模式"（按 uid 定位，允许改名而不产生重复条目）；
// 不选或选"新建章节"占位项则是"新建模式"。三个按钮：关闭（不保存）/ 保存（保存后关闭弹窗）/
// 下一章（保存后清空表单、退出编辑模式，留在弹窗里继续录入下一章）。
// =====================================================================================


// === Function: 打开"剧情录入"弹窗 ===
export async function openNovelEntryDialog() {
  let lorebookName;
  try {
    lorebookName = await getOrCreateSummaryLorebook();
  } catch (error) {
    console.error("[剧情助手] 获取总结世界书失败:", error);
    notify("error", `获取总结世界书失败：${error.message || error}`);
    return;
  }

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

  const BOX_BG = "#252525";
  const BOX_PADDING = "clamp(16px, 4vw, 24px)";

  const $box = $("<div>").css({
    position: "fixed",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    background: BOX_BG,
    border: "1px solid #3a3a3a",
    borderRadius: "10px",
    padding: `${BOX_PADDING} ${BOX_PADDING} 0 ${BOX_PADDING}`,
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

  const $title = $("<div>").text("剧情录入").css({
    fontSize: "1.05em",
    fontWeight: "600",
    color: "#f0f0f0",
    letterSpacing: "0.01em",
  });

  const smallBtnCss = {
    padding: "6px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3a3a",
    background: "transparent",
    color: "#9db8e0",
    fontSize: "0.8em",
    cursor: "pointer",
    touchAction: "manipulation",
  };
  const $ioRow = $("<div>").css({
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  });
  const $exportBtn = $("<button>").text("导出章节").css(smallBtnCss);
  const $importBtn = $("<button>").text("导入章节").css(smallBtnCss);
  const $importFileInput = $('<input type="file" accept=".txt,.md,text/plain">').css({
    display: "none",
  });
  $ioRow.append($exportBtn, $importBtn, $importFileInput);

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

  const $selectWrap = $("<div>").css({
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  });
  $selectWrap.append(
    $("<label>")
      .text("读取已创建章节")
      .css({ fontSize: "0.82em", color: "#999" }),
  );
  const $select = $("<select>").css(inputCss);
  $selectWrap.append($select);

  const $nameWrap = $("<div>").css({
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  });
  $nameWrap.append(
    $("<label>")
      .html('章节名 <span style="color:#f28b82">*</span>')
      .css({ fontSize: "0.82em", color: "#999" }),
  );
  const $nameInput = $('<input type="text">')
    .attr("placeholder", "如：第三章 云隐山遇袭")
    .css(inputCss);
  $nameWrap.append($nameInput);

  const $summaryWrap = $("<div>").css({
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    minHeight: 0,
  });
  $summaryWrap.append(
    $("<label>").text("概述").css({ fontSize: "0.82em", color: "#999" }),
  );
  const $summaryInput = $("<textarea>")
    .attr({ rows: 8, placeholder: "该章节的起因、经过、结局概述" })
    .css({
      ...inputCss,
      minHeight: "140px",
      maxHeight: "min(40vh, 40dvh)",
      resize: "vertical",
    });
  $summaryWrap.append($summaryInput);

  const $errorMsg = $("<div>").css({
    fontSize: "0.82em",
    color: "#f28b82",
    display: "none",
  });

  // 按钮行吸底（position: sticky）：$box 本身是可滚动容器（overflowY: auto），
  // 移动端弹出键盘时 dvh 收缩、概述输入框占位又比较大，如果按钮行只是排在流的最后面，
  // 会被顶到滚动区域下方看不见、甚至视觉上挤进概述框里。改成 sticky 贴底后，
  // 不管容器怎么滚动，按钮行始终固定在弹窗可视区域的最下沿。
  // 背景色 + 顶部分割线用来跟上方滚动内容做视觉区隔；左右负 margin 撑满宽度抵消 $box 的左右 padding，
  // 自带上下 padding 补回按钮和边缘的间距（$box 的 padding-bottom 已经在上面设为 0，避免和这里重复）。
  const $btnRow = $("<div>").css({
    position: "sticky",
    bottom: 0,
    left: 0,
    right: 0,
    display: "flex",
    gap: "10px",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    background: BOX_BG,
    borderTop: "1px solid #3a3a3a",
    padding: `10px ${BOX_PADDING} ${BOX_PADDING} ${BOX_PADDING}`,
    margin: `0 calc(-1 * ${BOX_PADDING}) 0 calc(-1 * ${BOX_PADDING})`,
    boxSizing: "border-box",
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
  const $close = $("<button>").text("关闭").css({
    ...btnCss,
    border: "1px solid #3a3a3a",
    background: "transparent",
    color: "#c0c0c0",
  });
  const $next = $("<button>").text("下一章").css({
    ...btnCss,
    border: "1px solid #3a3a3a",
    background: "transparent",
    color: "#c0c0c0",
  });
  const $save = $("<button>").text("保存").css({
    ...btnCss,
    border: "none",
    background: "#5b9cf6",
    color: "#ffffff",
    fontWeight: "600",
  });
  $btnRow.append($close, $next, $save);

  $box.append($title, $ioRow, $selectWrap, $nameWrap, $summaryWrap, $errorMsg, $btnRow);
  $overlay.append($box);
  $("body").append($overlay);

  // 移动端键盘弹出时的高度/位置纠正：CSS 的 100dvh 在不少移动端浏览器/WebView 里并不会
  // 随软键盘弹出而收缩（dvh 主要针对地址栏收起设计，键盘不一定计入），导致 $box 高度、
  // 位置都没变化，只是被键盘从下往上盖住；此时浏览器把聚焦的输入框滚入可视区域，会连带
  // 把贴底的按钮行"滚"到概述框原来的位置。这里改用 window.visualViewport 实时读取真正
  // 可见的视口尺寸，动态纠正 $box 的 maxHeight / top，让按钮行始终贴在真实可见区域底部。
  // 不支持 visualViewport 的环境（极少数老浏览器）会退回最初的纯 CSS dvh 效果。
  function updateBoxForViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const topOffset = vv.offsetTop + 12;
    const availableHeight = vv.height - 24;
    $box.css({
      top: `${topOffset}px`,
      maxHeight: `${Math.min(window.innerHeight * 0.85, availableHeight)}px`,
    });
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateBoxForViewport);
    window.visualViewport.addEventListener("scroll", updateBoxForViewport);
    updateBoxForViewport();
  }

  // 当前正在编辑的条目 uid；null 表示"新建模式"。
  let editingUid = null;
  let chaptersCache = [];

  async function refreshSelectOptions(selectValue) {
    chaptersCache = await listNovelChapterEntries(lorebookName);
    $select.empty();
    $select.append(
      $("<option>").val(NEW_CHAPTER_OPTION_VALUE).text("-- 新建章节 --"),
    );
    chaptersCache.forEach((chapter) => {
      $select.append(
        $("<option>").val(String(chapter.uid)).text(chapter.name),
      );
    });
    $select.val(
      selectValue !== undefined ? String(selectValue) : NEW_CHAPTER_OPTION_VALUE,
    );
  }

  function clearForm() {
    editingUid = null;
    $nameInput.val("");
    $summaryInput.val("");
    $errorMsg.hide();
    $nameInput.css("borderColor", "#3a3a3a");
  }

  await refreshSelectOptions();

  $exportBtn.on("click", async () => {
    try {
      const text = await exportNovelChaptersText(lorebookName);
      if (!text) {
        notify("error", "当前还没有已录入的章节，无需导出。");
        return;
      }
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `剧情章节-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      notify("success", "章节已导出为文本文件。");
    } catch (error) {
      console.error("[剧情助手] 导出原著章节失败:", error);
      notify("error", `导出失败：${error.message || error}`);
    }
  });

  $importBtn.on("click", () => $importFileInput.trigger("click"));

  $importFileInput.on("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const result = await importNovelChapters(lorebookName, ev.target.result);
        notify(
          "success",
          `导入完成：共解析到 ${result.total} 章，新建 ${result.created} 章，覆盖 ${result.overwritten} 章。`,
        );
        await refreshSelectOptions(NEW_CHAPTER_OPTION_VALUE);
        clearForm();
      } catch (error) {
        console.error("[剧情助手] 导入原著章节失败:", error);
        notify("error", `导入失败：${error.message || error}`);
      }
    };
    reader.onerror = () => {
      notify("error", "读取文件失败，请重试。");
    };
    reader.readAsText(file, "utf-8");
    // 清空 value，允许连续两次选同一个文件都能触发 change
    $importFileInput.val("");
  });

  $select.on("change", () => {
    const val = $select.val();
    if (val === NEW_CHAPTER_OPTION_VALUE) {
      clearForm();
      return;
    }
    const uid = parseInt(val, 10);
    const chapter = chaptersCache.find((c) => c.uid === uid);
    if (!chapter) return;
    editingUid = uid;
    $nameInput.val(chapter.name);
    $summaryInput.val(extractSummaryFromContent(chapter.content));
    $errorMsg.hide();
    $nameInput.css("borderColor", "#3a3a3a");
  });

  function validate() {
    const nameVal = $nameInput.val().trim();
    $nameInput.css("borderColor", nameVal ? "#3a3a3a" : "#f28b82");
    if (!nameVal) {
      $errorMsg.text("请填写章节名").show();
      return null;
    }
    return { name: nameVal, summary: $summaryInput.val().trim() };
  }

  async function doSave() {
    const values = validate();
    if (!values) return false;
    try {
      await saveNovelChapterEntry(
        lorebookName,
        editingUid,
        values.name,
        values.summary,
      );
      notify("success", `章节「${values.name}」已保存到「${lorebookName}」`);
      return true;
    } catch (error) {
      console.error("[剧情助手] 保存原著章节条目失败:", error);
      notify("error", `保存原著章节条目失败：${error.message || error}`);
      $errorMsg.text(error.message || String(error)).show();
      return false;
    }
  }

  function closeDialog() {
    $(document).off("keydown.novelEntryDialog");
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", updateBoxForViewport);
      window.visualViewport.removeEventListener("scroll", updateBoxForViewport);
    }
    $overlay.remove();
    $bodyEl.css("overflow", prevBodyOverflow || "");
  }

  $close.on("click", closeDialog);

  $save.on("click", async () => {
    const ok = await doSave();
    if (ok) closeDialog();
  });

  $next.on("click", async () => {
    const ok = await doSave();
    if (!ok) return;
    // 保存成功后清空表单、退出编辑模式，为下一章录入做准备；下拉框刷新以包含刚保存的这一章。
    await refreshSelectOptions(NEW_CHAPTER_OPTION_VALUE);
    clearForm();
    $nameInput.trigger("focus");
  });

  let overlayPointerDownOnSelf = false;
  $overlay.on("mousedown touchstart", (e) => {
    overlayPointerDownOnSelf = $(e.target).is($overlay);
  });
  $overlay.on("mouseup touchend", (e) => {
    if (overlayPointerDownOnSelf && $(e.target).is($overlay)) closeDialog();
    overlayPointerDownOnSelf = false;
  });
  $(document).on("keydown.novelEntryDialog", (e) => {
    if (e.key === "Escape") closeDialog();
  });

  setTimeout(() => $nameInput.trigger("focus"), 50);
}
