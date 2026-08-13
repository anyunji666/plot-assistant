"use strict";

import { NOVEL_CHAPTER_REFERENCE_PROMPT, NOVEL_ENTRY_DEFAULTS, NOVEL_ENTRY_TITLE_PREFIX, getCtx, notify } from "./core.js";
import { getFreeUid, getOrCreateSummaryLorebook, notifyWorldInfoUpdated } from "./worldinfo.js";


// =====================================================================================
// === 同人小说录入功能 ===
// 与总结/状态表/角色卡共用同一本"角色名总结"世界书，条目标题固定加 NOVEL_ENTRY_TITLE_PREFIX 前缀。
// 用途：手动录入原著章节名+概述，供 AI 查阅参考，而不是依赖模型凭记忆回忆原著细节。
// 弹窗顶部下拉框可选择已创建章节进入"编辑模式"（按 uid 定位，允许改名而不产生重复条目）；
// 不选或选"新建章节"占位项则是"新建模式"。三个按钮：关闭（不保存）/ 保存（保存后关闭弹窗）/
// 下一章（保存后清空表单、退出编辑模式，留在弹窗里继续录入下一章）。
// =====================================================================================

const NEW_CHAPTER_OPTION_VALUE = "__new__";

// 标题里"序号"和"章节名"之间的分隔符；完整标题形如 "原著章节：001｜第一章 初遇"。
// 序号是这里手动维护的展示顺序（新建=已有最大序号+1，从 1 开始），不是世界书自带的 order 字段
// （那个字段管的是激活条目的注入优先级，跟这里的"面板下拉框显示顺序"是两回事，互不影响）。
const NOVEL_ORDER_SEPARATOR = "｜";
const NOVEL_ORDER_PAD_LENGTH = 3;

const NOVEL_TITLE_RE = new RegExp(
  `^${NOVEL_ENTRY_TITLE_PREFIX}(\\d+)${NOVEL_ORDER_SEPARATOR}([\\s\\S]*)$`,
);


// === Helper: 解析"原著章节：xxx"条目标题，拆出序号和章节名；不匹配返回 null ===
function parseNovelChapterTitle(comment) {
  if (typeof comment !== "string") return null;
  const match = NOVEL_TITLE_RE.exec(comment);
  if (!match) return null;
  return { order: parseInt(match[1], 10), name: match[2] };
}


// === Helper: 按序号+章节名拼出完整标题 ===
function buildNovelChapterTitle(order, chapterName) {
  const orderLabel = String(order).padStart(NOVEL_ORDER_PAD_LENGTH, "0");
  return `${NOVEL_ENTRY_TITLE_PREFIX}${orderLabel}${NOVEL_ORDER_SEPARATOR}${chapterName}`;
}


// === Helper: 扫描世界书里所有"原著章节：xxx"条目，取当前已用的最大序号（一个都没有则为 0） ===
function getMaxNovelChapterOrder(data) {
  let max = 0;
  for (const entry of Object.values(data.entries)) {
    const parsed = parseNovelChapterTitle(entry.comment);
    if (parsed && parsed.order > max) max = parsed.order;
  }
  return max;
}


// === Helper: 读取当前总结世界书里所有"原著章节：xxx"条目，按标题里的序号排序，供下拉框展示 ===
export async function listNovelChapterEntries(lorebookName) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries) return [];
  return Object.values(data.entries)
    .map((entry) => {
      const parsed = parseNovelChapterTitle(entry.comment);
      if (!parsed) return null;
      return {
        uid: entry.uid,
        order: parsed.order,
        name: parsed.name,
        content: entry.content || "",
      };
    })
    .filter((chapter) => chapter !== null)
    .sort((a, b) => a.order - b.order);
}


// === Helper: 从条目正文里提取概述文本（正文包了一层 <chapter_reference> 标签，标签内第一行是固定
// 提示词 NOVEL_CHAPTER_REFERENCE_PROMPT，后面才是真正的概述；编辑框只展示/编辑概述部分，
// 不把提示词本身也当成概述塞进输入框——否则每次编辑都要多删一行）。
function extractSummaryFromContent(content) {
  const match = /^<chapter_reference[^>]*>\n?([\s\S]*?)\n?<\/chapter_reference>\s*$/.exec(
    content || "",
  );
  let inner = match ? match[1] : content || "";
  if (inner.startsWith(NOVEL_CHAPTER_REFERENCE_PROMPT)) {
    inner = inner.slice(NOVEL_CHAPTER_REFERENCE_PROMPT.length).replace(/^\n/, "");
  }
  return inner;
}


// === Helper: 新建或更新一条章节条目 ===
// existingUid 为 null/undefined 时新建；传入具体 uid 时按 uid 定位更新（允许改名，不按标题匹配）。
// 新建模式下章节名重复会报错，不静默覆盖，避免误覆盖别的章节内容；
// 编辑模式下改名后与另一条已有条目撞名同样报错。
// 标题里的序号：新建=当前已有最大序号+1（一个都没有则为 1）；编辑改名沿用该条目原有序号，不重新计算。
export async function saveNovelChapterEntry(
  lorebookName,
  existingUid,
  chapterName,
  summary,
) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  const content = `<chapter_reference chapter="${chapterName}">\n${NOVEL_CHAPTER_REFERENCE_PROMPT}\n${summary}\n</chapter_reference>`;

  const hasExisting =
    existingUid !== null &&
    existingUid !== undefined &&
    existingUid in data.entries;

  // 查重按解析出来的章节名比较，不能再比较整个标题字符串——标题里带了序号，
  // 两条不同章节的完整标题必然不同，只有拆出章节名单独比较才能判断"是否重名"。
  const findByName = (excludeUid) =>
    Object.values(data.entries).find((entry) => {
      if (entry.uid === excludeUid) return false;
      const parsed = parseNovelChapterTitle(entry.comment);
      return parsed !== null && parsed.name === chapterName;
    });

  let title;

  if (hasExisting) {
    const conflict = findByName(existingUid);
    if (conflict) {
      throw new Error(
        `章节名「${chapterName}」已被其它条目占用，请换一个名字。`,
      );
    }
    const existingEntry = data.entries[existingUid];
    const parsed = parseNovelChapterTitle(existingEntry.comment);
    // 正常情况下已有条目一定能解析出序号；解析失败（理论上不会出现）时兜底追加到末尾，避免丢序号。
    const order = parsed ? parsed.order : getMaxNovelChapterOrder(data) + 1;
    title = buildNovelChapterTitle(order, chapterName);
    data.entries[existingUid].comment = title;
    data.entries[existingUid].content = content;
  } else {
    const existing = findByName(null);
    if (existing) {
      throw new Error(
        `章节「${chapterName}」已存在，请在上方下拉框里选择它进行编辑，或换一个章节名。`,
      );
    }
    const order = getMaxNovelChapterOrder(data) + 1;
    title = buildNovelChapterTitle(order, chapterName);
    const newUid = getFreeUid(data);
    if (newUid === null) throw new Error("无法为新世界书条目分配 uid。");
    data.entries[newUid] = {
      uid: newUid,
      comment: title,
      content,
      disable: true, // 默认关闭：不自动注入正文，需在世界书面板手动启用，或配合后续自动切换功能
      constant: true, // 启用后即常驻注入，不依赖关键词匹配
      key: [],
      useGroupScoring: false,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 0,
      ...NOVEL_ENTRY_DEFAULTS,
    };
  }

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
  return title;
}


// === Helper: 查询当前"启用"（disable:false）的原著章节条目 ===
// 正常情况下同一时间只应该有 0 或 1 条启用；如果检测到不止一条同时启用（比如用户绕过插件、
// 直接在原生世界书面板里手动改过），activeUid 取序号最小的那条，同时把 hasConflict 置 true，
// 供面板提示"当前状态异常"，不在这里自作主张帮用户纠正。
export async function getActiveNovelChapterUid(lorebookName) {
  const chapters = await listNovelChapterEntries(lorebookName);
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries) return { activeUid: null, hasConflict: false };

  const enabledUids = chapters
    .filter((chapter) => data.entries[chapter.uid]?.disable === false)
    .map((chapter) => chapter.uid);

  if (enabledUids.length === 0) return { activeUid: null, hasConflict: false };
  return { activeUid: enabledUids[0], hasConflict: enabledUids.length > 1 };
}


// === Function: 切换"当前进度"章节 ===
// 把 targetUid 对应的原著章节条目设为启用，其它所有原著章节条目设为禁用；
// targetUid 传 null 表示"不启用任何章节"（全部禁用）。只动 disable 字段，不碰内容/序号/其它设置。
export async function setActiveNovelChapter(lorebookName, targetUid) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  let matched = targetUid === null;
  for (const entry of Object.values(data.entries)) {
    if (parseNovelChapterTitle(entry.comment) === null) continue;
    const isTarget = targetUid !== null && entry.uid === targetUid;
    if (isTarget) matched = true;
    entry.disable = !isTarget;
  }

  if (!matched) {
    throw new Error("未找到目标章节条目，可能已被删除，请刷新后重试。");
  }

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
}


// === Helper: 解析导出/导入用的纯文本格式 ===
// 格式：每章一个块，单独一行 "## 章节名" 起头，后面到下一个 "## " 之前（或文件末尾）都算这一章的概述。
// "## " 之前如果有游离文字（比如文件说明），直接忽略，不当成任何一章的内容。
function parseNovelChapterExportText(text) {
  const lines = (text || "").split(/\r?\n/);
  const chapters = [];
  let current = null;

  for (const line of lines) {
    const headerMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headerMatch) {
      if (current) chapters.push(current);
      current = { name: headerMatch[1], summaryLines: [] };
    } else if (current) {
      current.summaryLines.push(line);
    }
  }
  if (current) chapters.push(current);

  return chapters
    .map((chapter) => ({
      name: chapter.name.trim(),
      summary: chapter.summaryLines.join("\n").trim(),
    }))
    .filter((chapter) => chapter.name.length > 0);
}


// === Function: 导出当前所有原著章节为纯文本（"## 章节名" + 概述），按世界书里的实际序号顺序 ===
// 导出的概述是"剥掉固定提示词之后"的干净文本（复用 extractSummaryFromContent），导入时会自动重新拼上，
// 不会因为反复导出/导入导致提示词越叠越多。
export async function exportNovelChaptersText(lorebookName) {
  const chapters = await listNovelChapterEntries(lorebookName);
  return chapters
    .map((chapter) => `## ${chapter.name}\n${extractSummaryFromContent(chapter.content)}`)
    .join("\n\n");
}


// === Function: 从导出格式的文本批量导入章节 ===
// 章节名跟已有条目重复：直接覆盖旧概述，序号沿用该条目原有位置不变；
// 新章节名：按文本里出现的先后顺序依次追加到当前最大序号之后。
// 只做一次 loadWorldInfo / 一次 saveWorldInfo，不管导入多少章都只有一轮网络往返。
export async function importNovelChapters(lorebookName, text) {
  const parsed = parseNovelChapterExportText(text);
  if (parsed.length === 0) {
    throw new Error(
      "未解析到任何章节，请检查格式：每章需要另起一行以「## 章节名」开头。",
    );
  }

  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  let created = 0;
  let overwritten = 0;

  for (const chapter of parsed) {
    const content = `<chapter_reference chapter="${chapter.name}">\n${NOVEL_CHAPTER_REFERENCE_PROMPT}\n${chapter.summary}\n</chapter_reference>`;

    const existingEntry = Object.values(data.entries).find((entry) => {
      const parsedTitle = parseNovelChapterTitle(entry.comment);
      return parsedTitle !== null && parsedTitle.name === chapter.name;
    });

    if (existingEntry) {
      const parsedTitle = parseNovelChapterTitle(existingEntry.comment);
      const order = parsedTitle ? parsedTitle.order : getMaxNovelChapterOrder(data) + 1;
      existingEntry.comment = buildNovelChapterTitle(order, chapter.name);
      existingEntry.content = content;
      overwritten++;
    } else {
      const order = getMaxNovelChapterOrder(data) + 1;
      const newUid = getFreeUid(data);
      if (newUid === null)
        throw new Error("无法为新世界书条目分配 uid，可能条目数量已达上限。");
      data.entries[newUid] = {
        uid: newUid,
        comment: buildNovelChapterTitle(order, chapter.name),
        content,
        disable: true,
        constant: true,
        key: [],
        useGroupScoring: false,
        excludeRecursion: true,
        preventRecursion: true,
        delayUntilRecursion: 0,
        ...NOVEL_ENTRY_DEFAULTS,
      };
      created++;
    }
  }

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
  return { created, overwritten, total: parsed.length };
}


// === Function: 打开"同人小说录入"弹窗 ===
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

  const $title = $("<div>").text("同人小说录入").css({
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

  const $btnRow = $("<div>").css({
    display: "flex",
    gap: "10px",
    justifyContent: "flex-end",
    marginTop: "4px",
    flexWrap: "wrap",
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
      a.download = `同人小说章节-${Date.now()}.txt`;
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
