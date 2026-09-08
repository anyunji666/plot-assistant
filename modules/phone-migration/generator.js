"use strict";

// =====================================================================================
// === 私信数据迁移 · 导出/导入业务逻辑 ===
// 用途：PC 和移动端不是同一份浏览器本地存储时，把当前角色卡下手机模块的私信数据打包成一份
// JSON，拿到另一端导入。
//
// 导出范围（只取跟"当前角色卡"绑定的两类数据）：
//   1. 私信聊天记录：所有联系人的消息正文 + 时间，不带 id/关联表情图（图片消息的 text 本身
//      已经是"[图片:图片名]"这样的文字描述，足够还原语境，不需要额外带走表情图本身）。
//   2. 联系人角色卡资料：世界书里所有"角色卡：xxx"条目的原文，方便导入端原样重建。
// 不导出：头像/背景/图片库（都是本地图片数据，体积大且非必需）、忙闲状态与待生效物品改动
// （绑定在"当前具体聊天文件"上的运行时缓存，换端后没有意义，会在下一次状态表重算时自动重建）。
//
// 导入规则（两类数据分别处理）：
//   - 私信聊天记录：按联系人整份覆盖——文件里有的联系人，本地对应联系人的记录会被文件内容替换；
//     文件里没提到的联系人不受影响。
//   - 联系人角色卡资料：只新增缺失的联系人，已存在同名角色卡的不会被覆盖（增量导入）。
// =====================================================================================

import { CHARACTER_ENTRY_DEFAULTS, CHARACTER_ENTRY_TITLE_PREFIX, PHONE_IDB_STORE, confirmAction, getCtx } from "../core.js";
import { extractCharacterKeywords } from "../character.js";
import { getCurrentCharacterName, getFreeUid, getLorebookEntriesArray, getOrCreateSummaryLorebook, notifyWorldInfoUpdated } from "../worldinfo.js";
import { clearPhoneMessages, getAllPhoneMessages, openPhoneDB, phoneDbDateIndexKey, phoneDbMessagesKey } from "../phone/store.js";

export const PHONE_MIGRATION_EXPORT_TYPE = "plot-assistant-phone-export";

// === Helper: 扫描本地私信库，找出"当前角色卡"下有聊天记录的所有联系人名 ===
// 联系人角色卡条目有可能已经被删掉，但私信记录还在本地库里，所以不能只靠世界书条目枚举联系人，
// 这里直接按 key 前缀（当前角色卡::）+ 后缀（::__dates__，日期索引专用后缀）扫一遍。
async function getContactNamesWithLocalMessages() {
  try {
    const db = await openPhoneDB();
    const keys = await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readonly");
      const req = tx.objectStore(PHONE_IDB_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const prefix = `${getCurrentCharacterName()}::`;
    const suffix = "::__dates__";
    const names = [];
    keys.forEach((key) => {
      if (typeof key === "string" && key.startsWith(prefix) && key.endsWith(suffix)) {
        names.push(key.slice(prefix.length, key.length - suffix.length));
      }
    });
    return names;
  } catch (error) {
    console.error("[剧情助手] 扫描本地私信联系人列表失败:", error);
    return [];
  }
}

// === Function: 汇总当前角色卡下的私信数据，组装成可导出的 JSON 对象 ===
export async function buildPhoneMigrationExport() {
  const characterName = getCurrentCharacterName() || "";

  const lorebookName = await getOrCreateSummaryLorebook();
  const entries = await getLorebookEntriesArray(lorebookName);
  const contacts = entries
    .filter((e) => typeof e.comment === "string" && e.comment.startsWith(CHARACTER_ENTRY_TITLE_PREFIX))
    .map((e) => ({ name: e.comment.slice(CHARACTER_ENTRY_TITLE_PREFIX.length), content: e.content || "" }));

  // 联系人名单 = 有角色卡条目的 ∪ 本地有聊天记录的，避免角色卡被删掉但私信还在的联系人被漏掉。
  const messageContactNames = new Set(contacts.map((c) => c.name));
  (await getContactNamesWithLocalMessages()).forEach((name) => messageContactNames.add(name));

  const messages = [];
  for (const name of messageContactNames) {
    const days = await getAllPhoneMessages(name);
    if (days.length === 0) continue;
    messages.push({
      contactName: name,
      days: days.map((day) => ({
        dateKey: day.dateKey,
        msgs: day.msgs.map((m) => ({
          from: m.from,
          text: m.text || "",
          ts: m.ts,
          storyTime: m.storyTime || "",
        })),
      })),
    });
  }

  if (contacts.length === 0 && messages.length === 0) {
    throw new Error("当前角色卡下没有可导出的联系人角色卡或私信记录。");
  }

  return {
    type: PHONE_MIGRATION_EXPORT_TYPE,
    version: 1,
    characterName,
    exportedAt: new Date().toISOString(),
    contacts,
    messages,
  };
}

// === Function: 触发导出 JSON 文件下载，返回 {contactCount, messageContactCount} ===
export async function downloadPhoneMigrationExport() {
  const data = await buildPhoneMigrationExport();
  const text = JSON.stringify(data, null, 2);
  const safeName = data.characterName || "未命名";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `私信数据-${safeName}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return { contactCount: data.contacts.length, messageContactCount: data.messages.length };
}

// === Helper: 把某个联系人的本地聊天记录整份替换成 days 里的内容（先清空再写入）===
async function replacePhoneMessagesForContact(contactName, days) {
  await clearPhoneMessages(contactName);
  if (!Array.isArray(days) || days.length === 0) return;

  const db = await openPhoneDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PHONE_IDB_STORE, "readwrite");
    const store = tx.objectStore(PHONE_IDB_STORE);
    const dateKeys = [];
    days.forEach((day) => {
      const dateKey = day && day.dateKey;
      if (!dateKey) return;
      const msgs = (Array.isArray(day.msgs) ? day.msgs : []).map((m, i) => ({
        id: `${Number(m.ts) || Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        from: m.from === "user" || m.from === "character" ? m.from : "system",
        text: typeof m.text === "string" ? m.text : "",
        stickerId: null,
        ts: Number(m.ts) || Date.now(),
        storyTime: typeof m.storyTime === "string" ? m.storyTime : "",
      }));
      store.put(msgs, phoneDbMessagesKey(contactName, dateKey));
      dateKeys.push(dateKey);
    });
    store.put(dateKeys, phoneDbDateIndexKey(contactName));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// === Helper: 联系人角色卡资料增量导入——已存在同名角色卡的跳过，不存在的才新建，返回 {added, skipped} ===
async function importContactsAdditively(contacts) {
  if (!Array.isArray(contacts) || contacts.length === 0) return { added: 0, skipped: 0 };

  const lorebookName = await getOrCreateSummaryLorebook();
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries) throw new Error(`无法加载世界书: ${lorebookName}`);

  const existingTitles = new Set(Object.values(data.entries).map((e) => e.comment));
  let added = 0;
  let skipped = 0;

  contacts.forEach((contact) => {
    const name = ((contact && contact.name) || "").trim();
    if (!name) return;
    const title = CHARACTER_ENTRY_TITLE_PREFIX + name;
    if (existingTitles.has(title)) {
      skipped += 1;
      return;
    }
    const newUid = getFreeUid(data);
    if (newUid === null) return; // 极端情况：uid 分配不出来了，跳过这一条

    data.entries[newUid] = {
      uid: newUid,
      comment: title,
      content: typeof contact.content === "string" ? contact.content : "",
      disable: true,
      constant: false,
      key: extractCharacterKeywords(name),
      position: 0,
      useGroupScoring: false,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 0,
      ...CHARACTER_ENTRY_DEFAULTS,
    };
    existingTitles.add(title);
    added += 1;
  });

  if (added > 0) {
    await context.saveWorldInfo(lorebookName, data, true);
    notifyWorldInfoUpdated(lorebookName);
  }
  return { added, skipped };
}

// === Function: 解析导入文件文本，分别处理"私信聊天记录"（按联系人整份覆盖）和
// "联系人角色卡资料"（增量新增，已有同名不覆盖）。
// 返回 {messageContactCount, contactAdded, contactSkipped}；用户在确认弹窗里点了"取消"则返回 null。===
export async function importPhoneMigrationFromText(rawText) {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    throw new Error("文件不是有效的 JSON 格式，无法解析。");
  }
  if (!data || data.type !== PHONE_MIGRATION_EXPORT_TYPE) {
    throw new Error("文件格式不是本插件导出的私信数据，无法导入。");
  }

  const messages = Array.isArray(data.messages) ? data.messages : [];
  const contacts = Array.isArray(data.contacts) ? data.contacts : [];

  const confirmed = await confirmAction(
    "导入私信数据",
    `即将导入「${data.characterName || "未知角色"}」的私信数据：<br>` +
      `· ${messages.length} 位联系人的聊天记录（同名联系人的记录会被文件内容整份覆盖，此操作不可撤销）<br>` +
      `· ${contacts.length} 条联系人角色卡资料（只新增缺失的，已有同名角色卡不会被覆盖）<br><br>确定继续吗？`,
  );
  if (!confirmed) return null;

  // 先导入联系人角色卡资料，再导入私信记录：顺序上更符合直觉（先有联系人、再有聊天记录），
  // 虽然两者存储上互相独立、顺序颠倒也不影响最终结果，但先创建角色卡条目更稳妥
  // （万一中途失败，至少通讯录里已经能看到这个联系人）。
  const { added, skipped } = await importContactsAdditively(contacts);

  for (const item of messages) {
    const name = ((item && item.contactName) || "").trim();
    if (!name) continue;
    await replacePhoneMessagesForContact(name, item.days);
  }

  return { messageContactCount: messages.length, contactAdded: added, contactSkipped: skipped };
}
