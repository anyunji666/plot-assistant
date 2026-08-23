"use strict";

import { confirmAction, getCtx, NOVEL_ENTRY_TITLE_PREFIX } from "./core.js";


// === Helper: 世界书条目对象 -> 数组（原生世界书 entries 是以 uid 为 key 的对象，不是数组） ===
export async function getLorebookEntriesArray(lorebookName) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries) return [];
  return Object.values(data.entries);
}


// === Helper: 为世界书数据分配一个未被占用的 uid（原生世界书条目以数字 uid 为 key） ===
export function getFreeUid(data) {
  const MAX_UID = 1000000;
  for (let uid = 0; uid < MAX_UID; uid++) {
    if (!(uid in data.entries)) return uid;
  }
  return null;
}


// === Helper: 保存世界书后通知酒馆"数据已更新"，让世界书面板/选择列表等处及时刷新，不用手动刷新页面 ===
export function notifyWorldInfoUpdated(lorebookName) {
  try {
    const context = getCtx();
    if (
      context.eventSource &&
      context.event_types &&
      context.event_types.WORLDINFO_UPDATED
    ) {
      context.eventSource.emit(
        context.event_types.WORLDINFO_UPDATED,
        lorebookName,
      );
    }
  } catch (error) {
    console.warn("[剧情助手] 触发 WORLDINFO_UPDATED 事件时出错:", error);
  }
}


// === Helper: 检查世界书里是否已存在指定标题的条目，不做任何创建/修改 ===
export async function lorebookEntryExists(lorebookName, title) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries) return false;
  return Object.values(data.entries).some((entry) => entry.comment === title);
}


// === Helper: 保存/覆盖 世界书条目 ===
// 主要关键字留空（条目为 constant 常驻类型，不依赖关键字触发）。
// 组评分固定关闭，且开启"不可递归"+"防止进一步递归"，避免总结条目被其他条目递归激活或再触发递归。
// keywords 为可选参数：不传（undefined）时完全不影响已存在条目的 key（状态表、对话前强调等调用方不受影响）；
// 新建条目时若也未传，key 用默认空数组。传入时（哪怕是空数组 []）都会写入/覆盖 key。
export async function saveOrOverwriteLorebookEntry(
  lorebookName,
  title,
  content,
  silentOverwrite,
  createDefaults,
  keywords,
) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  const existing = Object.values(data.entries).find(
    (entry) => entry.comment === title,
  );

  if (existing) {
    if (!silentOverwrite) {
      const confirmed = await context.callGenericPopup(
        `世界书中已存在标题为 "${title}" 的条目，是否覆盖？`,
        context.POPUP_TYPE.CONFIRM,
        "",
        { okButton: "覆盖", cancelButton: "取消" },
      );
      if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return false;
    }
    // 只更新标题和内容——位置/触发策略/深度等设置如果你在世界书面板里手动调整过，这里不再覆盖回去。
    data.entries[existing.uid].comment = title;
    data.entries[existing.uid].content = content;
    // 关键词跟随标题/正文一起刷新，但只在调用方主动传入时才动，避免影响不传关键词的调用方。
    if (keywords !== undefined) {
      data.entries[existing.uid].key = keywords;
    }
  } else {
    const newUid = getFreeUid(data);
    if (newUid === null) throw new Error("无法为新世界书条目分配 uid。");
    const baseFields = {
      comment: title,
      content,
      disable: false, // disable=false 表示启用
      constant: true, // constant=true 表示常驻类型
      key: keywords !== undefined ? keywords : [],
      position: 0, // 0 = 角色定义之前（对应原来的 before_prompt 语义）
      order: 0,
      useGroupScoring: false,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 0,
    };
    // createDefaults 只在新建时生效，用来覆盖上面这套默认位置/顺序等设置（比如状态表要靠近最新消息）。
    data.entries[newUid] = {
      uid: newUid,
      ...baseFields,
      ...(createDefaults || {}),
    };
  }

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
  return true;
}


// === Helper: 获取当前角色名 ===
export function getCurrentCharacterName() {
  const context = getCtx();
  const char = context.characters?.[context.characterId];
  if (!char || !char.name) {
    throw new Error("未找到当前角色信息，请进入对话界面。");
  }
  return char.name;
}


// === Helper: 获取/创建 当前角色对应的总结世界书（角色名 + "总结"，与角色卡绑定世界书无关，独立存在） ===
// 用 loadWorldInfo 直接探测是否存在（返回 null / 无 entries 才视为不存在），
// 不依赖 getWorldInfoNames() 的本地缓存列表——那个列表只有调用过 updateWorldInfoList() 才会跟服务器同步，
// 用它来判断"存在与否"会因为同步延迟而误判成"不存在"，导致每次都重新创建、把已保存的内容覆盖掉。
export async function getOrCreateSummaryLorebook() {
  const context = getCtx();
  const characterName = getCurrentCharacterName();
  const lorebookName = `${characterName}总结`;

  const existingData = await context.loadWorldInfo(lorebookName);
  if (!existingData || !existingData.entries) {
    await context.saveWorldInfo(lorebookName, { entries: {} }, true);
    notifyWorldInfoUpdated(lorebookName);
    if (typeof context.updateWorldInfoList === "function") {
      await context.updateWorldInfoList();
    }
  }
  return lorebookName;
}


// === Helper: 在 #world_info（酒馆原生全局世界书多选框）里按书名文本找到对应的 <option> ===
// 不做"下标 -> 世界书数组"的换算（那样依赖两次读取之间 world_names 顺序一致，容易因为中间刷新一次列表而错位）。
// 直接按文本比对，跟酒馆自己内部 getWIElement() 判断选中项的方式一致，更可靠。
export function findWorldInfoOption(lorebookName) {
  return $("#world_info")
    .children()
    .filter(function () {
      return $(this).text().toLowerCase() === lorebookName.toLowerCase();
    });
}


// === Helper: 获取当前全局启用世界书的书名列表 ===
// 直接读 #world_info 里被选中的 <option> 的文本，不经过下标。
export function getGloballyEnabledWorldNames() {
  return $("#world_info option:selected")
    .map(function () {
      return $(this).text();
    })
    .get();
}


// === Helper: 检查总结世界书当前是否已挂载为全局世界书 ===
export async function isSummaryLorebookGloballyEnabled(lorebookName) {
  let $opt = findWorldInfoOption(lorebookName);
  if ($opt.length === 0) {
    // #world_info 可能还没初始化过（没打开过原生世界书面板），刷新一次列表再找
    const context = getCtx();
    if (typeof context.updateWorldInfoList === "function") {
      await context.updateWorldInfoList();
    }
    $opt = findWorldInfoOption(lorebookName);
  }
  return $opt.length > 0 && $opt.is(":selected");
}


// === Helper: 挂载总结世界书为全局世界书 ===
// 挂载前先检查全局列表里是否还有别的书（排除总结世界书自身），如果有，弹确认框询问是否顺带清理，
// 只保留这一本总结世界书——多数场景全局只需要挂这一本；如果用户就是想同时挂好几本，选"否"即可，插件不强制清理。
// 只处理"挂载"方向的清理逻辑；"取消挂载"由面板按钮直接调用 /world state=off 完成，不经过这个函数，
// 也不做任何清理——这样"先摘旧角色卡总结书，再挂新角色卡总结书"时，其他全局书不会被误动。
// 挂载动作固定用 state=on（不用 toggle）：不管插件自己判断的"当前状态"准不准，点一次「挂载」结果永远是"开"，
// 不会因为状态判断偶尔有误差就把方向弄反。
export async function mountSummaryLorebookGlobally(lorebookName) {
  const context = getCtx();
  if (typeof context.updateWorldInfoList === "function") {
    await context.updateWorldInfoList();
  }

  const otherEnabledNames = getGloballyEnabledWorldNames().filter(
    (name) => name !== lorebookName,
  );
  if (otherEnabledNames.length > 0) {
    const proceed = await confirmAction(
      "清理全局世界书",
      `检测到全局世界书列表里还有其他书：<b>${otherEnabledNames.join("、")}</b>，是否一并取消挂载，只保留「${lorebookName}」？<br><br>选"取消"则保留它们，只额外挂载「${lorebookName}」。`,
    );
    if (proceed) {
      for (const name of otherEnabledNames) {
        await context.executeSlashCommandsWithOptions(
          `/world silent=true state=off "${name}"`,
        );
      }
    }
  }

  await context.executeSlashCommandsWithOptions(
    `/world silent=true state=on "${lorebookName}"`,
  );
}


// === Helper: 获取世界书条目摘要 HTML（面板展示用） ===
export async function getLorebookEntriesSummaryHtml(lorebookName) {
  try {
    if (!lorebookName) return "未关联世界书";

    const allEntries = await getLorebookEntriesArray(lorebookName);
    const entries = (allEntries || []).filter(
      (entry) => !(entry.comment || "").startsWith(NOVEL_ENTRY_TITLE_PREFIX),
    );
    if (!entries || entries.length === 0) return "当前世界书中没有条目";

    let summaryHTML =
      "<ul style='list-style: none; padding-left: 0; margin: 0;'>";

    entries.forEach((entry, index) => {
      const title = entry.comment || "无标题";
      const content = entry.content || "无内容";
      const uid = entry.uid;

      const isValidUid =
        uid !== null && uid !== undefined && !isNaN(parseInt(uid, 10));
      const displayUid = isValidUid ? uid : `(无效ID-${index})`;
      const sanitizedContent = (content || "")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      summaryHTML += `
        <li id="lorebook-entry-${displayUid}" class="lorebook-entry" style="margin-bottom: 5px; padding: 3px 8px; border-radius: 6px; background: #333; ${
          !isValidUid ? "opacity: 0.7;" : ""
        }">
          <div class="entry-header" style="display: flex; justify-content: space-between; align-items: center; cursor: ${
            isValidUid ? "pointer" : "default"
          }; min-height: 24px;">
            <div style="font-weight: 500; color: #72b1e8; font-size: 13px;">${title} ${
              !isValidUid
                ? '<span style="color:#d53a3a; font-size:11px;">(无法编辑)</span>'
                : ""
            }</div>
            <div style="display: flex; gap: 5px;">
              ${
                isValidUid
                  ? '<span class="entry-toggle" style="color: #aaa; font-size: 11px; line-height: 1;">▼</span>'
                  : ""
              }
            </div>
          </div>
          ${
            isValidUid
              ? `
          <div class="entry-content" style="display: none; margin-top: 8px;">
            <div style="position: relative;">
              <textarea class="entry-textarea" style="width: 100%; min-height: 100px; background: #ffffff; color: #000000; color-scheme: light; border: 1px solid #444; border-radius: 4px; padding: 8px; font-size: 13px; margin-bottom: 8px;">${sanitizedContent}</textarea>
              <div style="display: flex; justify-content: flex-end; gap: 8px;">
                <button class="entry-save" data-uid="${uid}" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px;">保存</button>
                <button class="entry-delete" data-uid="${uid}" style="background: #d53a3a; border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px;">删除</button>
              </div>
            </div>
          </div>
          `
              : `
          <div class="entry-content" style="margin-top: 8px; padding: 8px; background: #2a2a2a; border-radius: 4px; color: #aaa; font-size: 13px;">${sanitizedContent.replace(
            /\n/g,
            "<br>",
          )}</div>
          `
          }
        </li>`;
    });

    summaryHTML += "</ul>";
    return summaryHTML;
  } catch (error) {
    console.error("[剧情助手] 获取世界书条目时出错:", error);
    return "获取世界书条目时出错";
  }
}
