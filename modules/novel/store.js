"use strict";

import { saveSettingsDebounced } from "../../../../../../script.js";
import { extension_settings } from "../../../../../extensions.js";
import { NOVEL_ACTIVE_CHAPTER_SETTINGS_KEY, NOVEL_CHAPTER_REFERENCE_PROMPT, NOVEL_ENTRY_DEFAULTS, NOVEL_ENTRY_TITLE_PREFIX, getCtx } from "../core.js";
import { getFreeUid, notifyWorldInfoUpdated } from "../worldinfo.js";


// =====================================================================================
// === 剧情录入功能：数据层 ===
// 与总结/状态表/角色卡共用同一本"角色名总结"世界书，条目标题固定加 NOVEL_ENTRY_TITLE_PREFIX 前缀。
// 用途：手动录入原著章节名+概述，供 AI 查阅参考，而不是依赖模型凭记忆回忆原著细节。
// 本文件只负责世界书条目的读写（增删改查/导入导出），不涉及任何 DOM/弹窗逻辑，UI 部分见 ./ui.js。
// =====================================================================================

export const NEW_CHAPTER_OPTION_VALUE = "__new__";

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
export function extractSummaryFromContent(content) {
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
      disable: true, // 固定关闭：章节条目不参与世界书原生注入，纯粹是数据仓库
      constant: false, // 固定为选择性触发类型（而非常驻），配合空 key 保证原生引擎在任何情况下都不会触发它
      key: [], // 固定为空数组：没有关键字可匹配，即使这本书被挂载为全局世界书，原生引擎也不会扫描到这条条目
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


// === Helper: 读写"当前激活章节"指针存储对象（extension_settings，按世界书名分组） ===
function getActiveChapterSettingsStore() {
  if (!extension_settings[NOVEL_ACTIVE_CHAPTER_SETTINGS_KEY]) {
    extension_settings[NOVEL_ACTIVE_CHAPTER_SETTINGS_KEY] = {};
  }
  return extension_settings[NOVEL_ACTIVE_CHAPTER_SETTINGS_KEY];
}


// === Helper: 查询当前"激活"的原著章节 uid ===
// 不再读世界书条目的 disable 字段（章节条目现在固定 disable:true，纯数据仓库），
// 改为读 extension_settings 里按世界书名存的指针。若指针指向的条目已被删除（自愈），
// 自动清除这条失效指针并持久化，避免下次继续读到一个不存在的 uid。
// hasConflict 字段保留只是为了不改动调用方（generator.js/panel.js）的解构写法，
// 新机制下同一时间只可能有 0 或 1 个激活章节，恒为 false。
export async function getActiveNovelChapterUid(lorebookName) {
  const store = getActiveChapterSettingsStore();
  const storedUid = store[lorebookName];
  if (storedUid === undefined || storedUid === null) {
    return { activeUid: null, hasConflict: false };
  }

  const chapters = await listNovelChapterEntries(lorebookName);
  const stillExists = chapters.some((chapter) => chapter.uid === storedUid);
  if (!stillExists) {
    delete store[lorebookName];
    saveSettingsDebounced();
    return { activeUid: null, hasConflict: false };
  }

  return { activeUid: storedUid, hasConflict: false };
}


// === Function: 切换"当前进度"章节 ===
// targetUid 传 null 表示"不注入任何章节"。只更新 extension_settings 里的指针，
// 不再读写世界书条目（章节条目的 disable/constant 恒定不变），因此不需要任何网络往返，
// 切换是本地、即时的。
export async function setActiveNovelChapter(lorebookName, targetUid) {
  if (targetUid !== null) {
    const chapters = await listNovelChapterEntries(lorebookName);
    const exists = chapters.some((chapter) => chapter.uid === targetUid);
    if (!exists) {
      throw new Error("未找到目标章节条目，可能已被删除，请刷新后重试。");
    }
  }

  const store = getActiveChapterSettingsStore();
  if (targetUid === null) {
    delete store[lorebookName];
  } else {
    store[lorebookName] = targetUid;
  }
  saveSettingsDebounced();
}


// === Helper: 获取当前激活章节的完整信息（uid/name/content），没有激活章节则返回 null ===
export async function getActiveNovelChapter(lorebookName) {
  const { activeUid } = await getActiveNovelChapterUid(lorebookName);
  if (activeUid === null) return null;
  const chapters = await listNovelChapterEntries(lorebookName);
  return chapters.find((chapter) => chapter.uid === activeUid) || null;
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
        disable: true, // 固定关闭：章节条目不参与世界书原生注入，纯粹是数据仓库
        constant: false, // 固定为选择性触发类型，配合空 key 保证原生引擎不会触发它
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
