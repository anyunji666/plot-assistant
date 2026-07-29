"use strict";

import { saveSettingsDebounced } from "../../../../../../script.js";
import { extension_settings } from "../../../../../extensions.js";
import { extractCharacterKeywords } from "../character.js";
import { CHARACTER_ENTRY_DEFAULTS, CHARACTER_ENTRY_TITLE_PREFIX, DEFAULT_PHONE_PRESET_CONTENT, PHONE_AVATAR_STORE, PHONE_BACKGROUND_STORE, PHONE_CHAT_META_KEY, PHONE_GLOBAL_BACKGROUND_KEY, PHONE_IDB_NAME, PHONE_IDB_STORE, PHONE_PRESET_TITLE, PHONE_STICKER_LIST_KEY, PHONE_STICKER_STORE, STATUS_TABLE_TITLE, getChatMetadataStore, getCtx, notify } from "../core.js";
import { extractLabelLine, extractOtherPartyName, parseFloorSummaryFields, parseKeyValueListWithSkipped } from "../summary/parser.js";
import { getCurrentCharacterName, getFreeUid, getLorebookEntriesArray, getOrCreateSummaryLorebook, notifyWorldInfoUpdated } from "../worldinfo.js";


// #####################################################################################
// === 手机（通讯器）悬浮窗模块 ===
// 全局开关，控制右下角「通讯器」悬浮球是否显示，默认关闭。
// 点开后弹出手机界面：通讯录 / 聊天 / 动态 / 设置 四个页签（动态页暂未实现，占位）。
// 数据来源：
//   - 联系人：读取当前"角色名总结"世界书里所有「角色卡：」前缀的条目（复用"创建角色"功能写入的数据）。
//   - 私信正文：本地 IndexedDB（PHONE_IDB_NAME），按"角色名::日期"存储，不占世界书 token。
//   - 忙/闲判定缓存 + 待注入私信槽位标记：本地存储（PHONE_CHAT_META_KEY），跟随"角色卡+对话文件"走。
// 忙/闲判定：纯文本匹配——角色名（含去姓简称）是否出现在最后一层 AI 楼层正文里；
//   出现 → 判定"忙"，把角色写进本地缓存的 busy 表，由状态表序列化时拼出 Busy 字段供正文 AI 感知，
//     正文 AI 在该角色本轮不再出现时输出 Busy: 角色名: [REMOVE]，插件在下一次状态表重算时读到这个信号，
//     自动生成一条该角色的补发私信；
//   不出现 → 判定"闲"，立即调用 AI 生成一条回复，并记住当前最后一层楼层号，
//     只要楼层号没变，下次发消息直接沿用"闲"的判断，不重新做文本匹配。
// 私信槽位：今天只要有新的私信更新（用户发送或角色回复），下一次正文生成前临时通过
//   context.setExtensionPrompt() 把当天聊天记录注入正文，AI 生成完这一轮后立即清空（一次性注入，不常驻）。
//   ⚠️ setExtensionPrompt 的具体参数/位置枚举没有在本项目其它地方实测过，接入后请在实际酒馆环境验证一遍，
//   如果没生效或控制台报错，把日志发我再调整（这一点和 README 里"已知需要你在实际环境验证的点"性质一致）。
// #####################################################################################

export const PHONE_MODULE_NAME = "plot_assistant_phone";


// extension_settings[PHONE_MODULE_NAME] 顶层结构：{ fabVisible: boolean }
export function getPhoneExtRoot() {
  if (!extension_settings[PHONE_MODULE_NAME]) {
    extension_settings[PHONE_MODULE_NAME] = {};
  }
  const root = extension_settings[PHONE_MODULE_NAME];
  if (typeof root.fabVisible !== "boolean") root.fabVisible = false;
  return root;
}


// 读取通讯器悬浮球是否应该显示（默认 false）
export function getPhoneFabVisible() {
  return getPhoneExtRoot().fabVisible === true;
}


// 写入通讯器悬浮球显示开关并立即持久化
export function setPhoneFabVisibleSetting(visible) {
  getPhoneExtRoot().fabVisible = !!visible;
  saveSettingsDebounced();
}


// ==== 手机私信系统：本地对话缓存存取（忙/闲缓存 + 待注入私信槽位标记）====

// 读取"当前对话"的手机私信状态记录，不存在则就地初始化一份默认结构并返回（引用，改了要记得调用 persistChatMetadata）。
// 结构：{ busy: {角色名: true}, idleFloor: {角色名: 楼层号}, pendingInjection: {角色名: true/false} }
export function getPhoneChatState() {
  const store = getChatMetadataStore();
  if (
    !store[PHONE_CHAT_META_KEY] ||
    typeof store[PHONE_CHAT_META_KEY] !== "object"
  ) {
    store[PHONE_CHAT_META_KEY] = {
      busy: {},
      idleFloor: {},
      pendingInjection: {},
    };
  }
  const s = store[PHONE_CHAT_META_KEY];
  if (!s.busy || typeof s.busy !== "object") s.busy = {};
  if (!s.idleFloor || typeof s.idleFloor !== "object") s.idleFloor = {};
  if (!s.pendingInjection || typeof s.pendingInjection !== "object")
    s.pendingInjection = {};
  return s;
}


// 标记"今天有新私信更新"，下一次正文生成前会把当天聊天记录注入私信槽位；调用方需要自己 persistChatMetadata。
export function markPhoneUpdatedToday(characterName) {
  getPhoneChatState().pendingInjection[characterName] = true;
}


// === Helper: 角色名（含去姓简称，复用"创建角色"功能已有的 extractCharacterKeywords）是否出现在给定文本里 ===
export function characterActiveInText(characterName, text) {
  if (!text) return false;
  return extractCharacterKeywords(characterName).some(
    (kw) => kw && text.includes(kw),
  );
}


// === Helper: 取"最后一层 AI 楼层"的索引与正文，找不到返回 idx=-1 ===
export function getLastAiFloor() {
  const chat = getCtx().chat;
  if (!Array.isArray(chat)) return { idx: -1, mes: "" };
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i] && !chat[i].is_user) return { idx: i, mes: chat[i].mes || "" };
  }
  return { idx: -1, mes: "" };
}


// === Helper: 取"正文当前时间"——即最后一层AI楼层摘要模块里的 Time 字段，取不到返回空字符串。
// 供手机私信系统在创建每条消息时记录"这条消息是正文走到哪个时间点时发的"，不是现实时间。===
export function getCurrentStoryTime() {
  const { mes } = getLastAiFloor();
  const fields = parseFloorSummaryFields(mes);
  return (fields && fields.time) || "";
}


// ==== 手机私信系统：联系人（复用"创建角色"写入的「角色卡：」世界书条目）====

// 从角色卡条目正文里取出 <character_information character="..."> 标签内的内容；取不到就退回整段正文。
export function extractCharacterInfoBody(content) {
  const match =
    /<character_information[^>]*>([\s\S]*?)<\/character_information>/.exec(
      content || "",
    );
  return (match ? match[1] : content || "").trim();
}


// === Helper: 取"标签: 值"里值部分一直到文本末尾的多行内容（用于 other 这种允许多行的字段）。
// extractLabelLine 只取标签所在那一行，取不到多行内容，这里单独按"从标签行到末尾"整体截取。===
export function extractMultilineLabelField(text, label) {
  if (!text || typeof text !== "string") return "";
  const re = new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*([\\s\\S]*)$`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}


// === Helper: 从角色卡正文里解析固定的 gender/other 两个字段（配合"添加联系人"面板固定输入项）。
// gender 是单行值，other 允许多行、取到标签所在行之后的所有内容。取不到就是空字符串，不报错。===
export function parseContactExtra(extraText) {
  return {
    gender: extractLabelLine(extraText, "gender"),
    other: extractMultilineLabelField(extraText, "other"),
  };
}


// 返回联系人列表：[{ name, extra }]，按名字排序。读不到世界书/没有任何角色卡时返回空数组，不报错。
export async function getPhoneContactsList() {
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const entries = await getLorebookEntriesArray(lorebookName);
    return entries
      .filter(
        (e) =>
          typeof e.comment === "string" &&
          e.comment.startsWith(CHARACTER_ENTRY_TITLE_PREFIX),
      )
      .map((e) => ({
        name: e.comment.slice(CHARACTER_ENTRY_TITLE_PREFIX.length),
        extra: extractCharacterInfoBody(e.content),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  } catch (error) {
    console.error("[剧情助手] 读取联系人列表失败:", error);
    return [];
  }
}


// 读取单个联系人角色卡正文（供生成回复时拼系统提示词用），读不到返回空字符串。
export async function getPhoneContactCardBody(characterName) {
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const entries = await getLorebookEntriesArray(lorebookName);
    const entry = entries.find(
      (e) => e.comment === CHARACTER_ENTRY_TITLE_PREFIX + characterName,
    );
    return entry ? extractCharacterInfoBody(entry.content) : "";
  } catch (error) {
    console.error("[剧情助手] 读取联系人角色卡失败:", error);
    return "";
  }
}


// === Helper: 读取"私信预设"条目，取不到时返回默认内容（不写入世界书，仅供编辑框预填）。===
export async function loadPhonePresetContent() {
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const entries = await getLorebookEntriesArray(lorebookName);
    const existing = entries.find((e) => e.comment === PHONE_PRESET_TITLE);
    return existing &&
      typeof existing.content === "string" &&
      existing.content.trim()
      ? existing.content
      : DEFAULT_PHONE_PRESET_CONTENT;
  } catch (error) {
    console.error("[剧情助手] 读取私信预设失败:", error);
    return DEFAULT_PHONE_PRESET_CONTENT;
  }
}


// === Helper: 保存/新建"私信预设"条目。始终 disable:true、非常驻关键词触发——
// 这条条目不参与酒馆正文的世界书注入，只是插件生成私信回复时直接读取内容拼提示词用。===
export async function savePhonePresetContent(content) {
  const context = getCtx();
  const lorebookName = await getOrCreateSummaryLorebook();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  const existing = Object.values(data.entries).find(
    (entry) => entry.comment === PHONE_PRESET_TITLE,
  );

  if (existing) {
    data.entries[existing.uid].content = content;
    data.entries[existing.uid].disable = true;
  } else {
    const newUid = getFreeUid(data);
    if (newUid === null) throw new Error("无法为新世界书条目分配 uid。");
    data.entries[newUid] = {
      uid: newUid,
      comment: PHONE_PRESET_TITLE,
      content,
      disable: true,
      constant: false,
      key: [],
      position: 0,
      useGroupScoring: false,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 0,
      ...CHARACTER_ENTRY_DEFAULTS,
    };
  }

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
  return lorebookName;
}


// === Helper: 从状态表世界书条目的 Relationships 行里，摘出 {{user}} 与指定角色之间的关系阶段值。
// 取不到（没有状态表/该角色不在关系表里）返回空字符串，不报错。===
export async function getRelationshipStageForCharacter(characterName) {
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const entries = await getLorebookEntriesArray(lorebookName);
    const statusEntry = entries.find((e) => e.comment === STATUS_TABLE_TITLE);
    if (!statusEntry) return "";
    const relationshipsLine = extractLabelLine(
      statusEntry.content,
      "Relationships",
    );
    if (!relationshipsLine) return "";
    const { map } = parseKeyValueListWithSkipped(relationshipsLine);
    for (const [key, value] of map.entries()) {
      if (extractOtherPartyName(key) === characterName) return value;
    }
    return "";
  } catch (error) {
    console.error("[剧情助手] 读取关系阶段失败:", error);
    return "";
  }
}


// ==== 手机私信系统：本地 IndexedDB（按"角色名::日期"存储，独立于地图图片库）====

export function openPhoneDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHONE_IDB_NAME, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHONE_IDB_STORE)) {
        db.createObjectStore(PHONE_IDB_STORE);
      }
      if (!db.objectStoreNames.contains(PHONE_AVATAR_STORE)) {
        db.createObjectStore(PHONE_AVATAR_STORE);
      }
      if (!db.objectStoreNames.contains(PHONE_STICKER_STORE)) {
        db.createObjectStore(PHONE_STICKER_STORE);
      }
      if (!db.objectStoreNames.contains(PHONE_BACKGROUND_STORE)) {
        db.createObjectStore(PHONE_BACKGROUND_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}


// 把图片文件读成压缩后的 dataURL：等比缩放到 maxSize 以内、输出 JPEG，用于头像/图片库这类
// 不需要保留原图精度、但要控制 IndexedDB 体积的场景（跟小地图底图保留原图精度的诉求不同，不复用那套）。
export function readImageFileCompressed(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          const scale = maxSize / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}


// 尝试下载外部图片链接并压缩转成本地 base64（复用跟本地上传一致的压缩逻辑），
// 用于"链接导入"时就地转存，避免链接失效后图片跟着失效。
// 常见失败原因：图床没开放跨域（CORS），或链接本身已经失效——这两种情况都会走 reject，
// 调用方应该 catch 住，退回保存原始链接，而不是让整次导入直接失败。
export function readImageUrlCompressed(url, maxSize) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          const scale = maxSize / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        // 图床没有返回 CORS 头时，canvas 会被判定为"污染"，toDataURL 在这一步抛 SecurityError
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = url;
  });
}


// ==== 手机：头像库（按"当前角色卡::联系人名"存取）====

export function phoneAvatarDbKey(characterName) {
  return `${getCurrentCharacterName()}::${characterName}`;
}


export async function savePhoneAvatar(characterName, dataUrl) {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_AVATAR_STORE, "readwrite");
      tx.objectStore(PHONE_AVATAR_STORE).put(
        dataUrl,
        phoneAvatarDbKey(characterName),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 保存头像失败:", error);
    notify("error", "头像保存失败，请查看控制台报错。");
  }
}


// 一次性取当前角色卡下所有联系人的头像，返回 Map（联系人名 -> dataURL），供通讯录列表批量渲染用，
// 避免每个联系人单独发一次 IDB 请求。
export async function getAllPhoneAvatarsForCurrentCharacter() {
  try {
    const db = await openPhoneDB();
    const prefix = phoneAvatarDbKey("");
    const { keys, values } = await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_AVATAR_STORE, "readonly");
      const store = tx.objectStore(PHONE_AVATAR_STORE);
      const keysReq = store.getAllKeys();
      const valuesReq = store.getAll();
      let keys, values;
      keysReq.onsuccess = () => {
        keys = keysReq.result;
        if (values !== undefined) resolve({ keys, values });
      };
      valuesReq.onsuccess = () => {
        values = valuesReq.result;
        if (keys !== undefined) resolve({ keys, values });
      };
      keysReq.onerror = () => reject(keysReq.error);
      valuesReq.onerror = () => reject(valuesReq.error);
    });
    const map = new Map();
    keys.forEach((key, i) => {
      if (typeof key === "string" && key.startsWith(prefix)) {
        map.set(key.slice(prefix.length), values[i]);
      }
    });
    return map;
  } catch (error) {
    console.error("[剧情助手] 批量读取头像失败:", error);
    return new Map();
  }
}


// ==== 手机：背景库 ====
// 全局背景：通讯录/动态/设置三页共用一张，存在固定 key 下，不分角色卡。
export async function getPhoneGlobalBackground() {
  try {
    const db = await openPhoneDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readonly");
      const req = tx
        .objectStore(PHONE_BACKGROUND_STORE)
        .get(PHONE_GLOBAL_BACKGROUND_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error("[剧情助手] 读取全局背景失败:", error);
    return null;
  }
}


export async function savePhoneGlobalBackground(dataUrl) {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readwrite");
      tx.objectStore(PHONE_BACKGROUND_STORE).put(
        dataUrl,
        PHONE_GLOBAL_BACKGROUND_KEY,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 保存全局背景失败:", error);
    notify("error", "背景保存失败，请查看控制台报错。");
  }
}


export async function deletePhoneGlobalBackground() {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readwrite");
      tx.objectStore(PHONE_BACKGROUND_STORE).delete(PHONE_GLOBAL_BACKGROUND_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 清除全局背景失败:", error);
  }
}


// 聊天页背景：按"当前角色卡::联系人名"分别存，跟头像库同一套 key 规则，换角色卡/联系人互不影响。
export function phoneChatBackgroundDbKey(characterName) {
  return `${getCurrentCharacterName()}::${characterName}`;
}


export async function getPhoneChatBackground(characterName) {
  try {
    const db = await openPhoneDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readonly");
      const req = tx
        .objectStore(PHONE_BACKGROUND_STORE)
        .get(phoneChatBackgroundDbKey(characterName));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error("[剧情助手] 读取聊天页背景失败:", error);
    return null;
  }
}


export async function savePhoneChatBackground(characterName, dataUrl) {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readwrite");
      tx.objectStore(PHONE_BACKGROUND_STORE).put(
        dataUrl,
        phoneChatBackgroundDbKey(characterName),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 保存聊天页背景失败:", error);
    notify("error", "背景保存失败，请查看控制台报错。");
  }
}


export async function deletePhoneChatBackground(characterName) {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readwrite");
      tx.objectStore(PHONE_BACKGROUND_STORE).delete(
        phoneChatBackgroundDbKey(characterName),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 清除聊天页背景失败:", error);
  }
}


// ==== 手机：图片库（原"表情包"，全局公用一份，整份列表存在同一个 key 下）====

export async function getPhoneStickerList() {
  try {
    const db = await openPhoneDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_STICKER_STORE, "readonly");
      const req = tx
        .objectStore(PHONE_STICKER_STORE)
        .get(PHONE_STICKER_LIST_KEY);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error("[剧情助手] 读取图片列表失败:", error);
    return [];
  }
}


export async function savePhoneStickerList(list) {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_STICKER_STORE, "readwrite");
      tx.objectStore(PHONE_STICKER_STORE).put(list, PHONE_STICKER_LIST_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 保存图片列表失败:", error);
    notify("error", "图片保存失败，请查看控制台报错。");
  }
}


// === Helper: 解析"名称--图片链接"格式的批量导入文本，一行一条（如"好想念你--https://xxx.jpg"）。
// 用贪婪匹配抓最后一个"--"到行尾的 http(s) 链接，前面剩余部分整体当名称（允许名称本身含"--"）；
// 不含合法链接的行（空行、格式不符的备注行等）直接跳过，计入 skipped 但不算错误、不中断解析。===
export function parsePhoneStickerImportText(text) {
  const lines = (text || "").split(/\r?\n/);
  const items = [];
  let skipped = 0;
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return; // 空行不计入 skipped，避免数字虚高
    const match = trimmed.match(/^(.*)--\s*(https?:\/\/\S+)\s*$/);
    if (!match) {
      skipped += 1;
      return;
    }
    const name = match[1].trim() || "图片";
    const url = match[2].trim();
    items.push({ name, dataUrl: url });
  });
  return { items, skipped };
}


// items: [{ name, dataUrl }]，批量导入用。dataUrl 既可以是本地压缩后的 base64，也可以是外部图片链接
// （链接导入会在调用方那一层先尝试用 readImageUrlCompressed 下载转存成本地 base64；
// 图床不支持跨域下载或链接已失效时才会退回存原始 URL，这里不关心具体是哪种，照单存就行）。
export async function addPhoneStickers(items) {
  const list = await getPhoneStickerList();
  items.forEach((item) => {
    list.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: item.name,
      dataUrl: item.dataUrl,
    });
  });
  await savePhoneStickerList(list);
  return list;
}


export async function renamePhoneSticker(stickerId, newName) {
  const list = await getPhoneStickerList();
  const record = list.find((s) => s.id === stickerId);
  if (!record) return;
  record.name = newName;
  await savePhoneStickerList(list);
}


export async function deletePhoneSticker(stickerId) {
  const list = (await getPhoneStickerList()).filter(
    (s) => s.id !== stickerId,
  );
  await savePhoneStickerList(list);
  return list;
}


export function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}


// === Helper: 把 storyTime（如"武定三年三月十五,申时"或"2023年8月28日 07:35"）拆成 {date, time} 两段，
// 供手机聊天界面显示用：日期部分给日期分割线，时辰/时间部分给单条消息的时间标签。
// 优先按逗号切（架空纪年常用格式）；没有逗号再按最后一个空格切（公历日期+时间常用格式）；
// 两种分隔符都没有就整段当 date、time 留空；storyTime 本身为空则两段都返回空字符串。===
export function splitStoryTime(storyTime) {
  if (!storyTime) return { date: "", time: "" };
  const commaIdx = storyTime.indexOf(",");
  if (commaIdx !== -1) {
    return {
      date: storyTime.slice(0, commaIdx).trim(),
      time: storyTime.slice(commaIdx + 1).trim(),
    };
  }
  const spaceIdx = storyTime.lastIndexOf(" ");
  if (spaceIdx !== -1) {
    return {
      date: storyTime.slice(0, spaceIdx).trim(),
      time: storyTime.slice(spaceIdx + 1).trim(),
    };
  }
  return { date: storyTime, time: "" };
}


// 私信存储 key 先按"当前角色卡"分一层、再按联系人名/日期分，跟地图数据（角色名::原id）同思路，
// 避免不同角色卡下刚好有同名联系人时，私信记录互相串在一起。
export function phoneDbMessagesKey(characterName, dateKey) {
  return `${getCurrentCharacterName()}::${characterName}::${dateKey}`;
}

export function phoneDbDateIndexKey(characterName) {
  return `${getCurrentCharacterName()}::${characterName}::__dates__`;
}


// 读取某个联系人某一天的消息数组（[{id, from, text, ts}]，from 为 "user"/"character"/"system"），
// 没有记录时返回空数组，不抛错。
export async function getPhoneMessagesForDate(characterName, dateKey) {
  try {
    const db = await openPhoneDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readonly");
      const req = tx
        .objectStore(PHONE_IDB_STORE)
        .get(phoneDbMessagesKey(characterName, dateKey));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error("[剧情助手] 读取私信记录失败:", error);
    return [];
  }
}


// 读取某个联系人"有消息的日期"索引（用于聊天页一次性拉全部历史），按字符串升序排列即时间顺序。
export async function getPhoneDateIndex(characterName) {
  try {
    const db = await openPhoneDB();
    const list = await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readonly");
      const req = tx
        .objectStore(PHONE_IDB_STORE)
        .get(phoneDbDateIndexKey(characterName));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return [...list].sort();
  } catch (error) {
    console.error("[剧情助手] 读取私信日期索引失败:", error);
    return [];
  }
}


// 追加一条消息（自动按 ts 归入对应日期、更新日期索引），返回写入后的消息对象；写入失败返回 null。
export async function appendPhoneMessage(characterName, msg) {
  const ts = msg.ts || Date.now();
  const dateKey = formatDateKey(new Date(ts));
  const record = {
    id: `${ts}_${Math.random().toString(36).slice(2, 8)}`,
    from: msg.from,
    text: msg.text,
    stickerId: msg.stickerId || null, // 关联图片库图片，仅发图片的消息才有值；旧数据没有此字段，读到的是 undefined -> 按无图片处理
    ts,
    storyTime: msg.storyTime || "", // 这条消息发出时，正文摘要模块里的 Time 字段值；旧数据没有此字段，读到的是 undefined -> ""
  };
  try {
    const db = await openPhoneDB();
    const list = await getPhoneMessagesForDate(characterName, dateKey);
    list.push(record);
    const dateIndex = await getPhoneDateIndex(characterName);
    if (!dateIndex.includes(dateKey)) dateIndex.push(dateKey);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readwrite");
      tx.objectStore(PHONE_IDB_STORE).put(
        list,
        phoneDbMessagesKey(characterName, dateKey),
      );
      tx.objectStore(PHONE_IDB_STORE).put(
        dateIndex,
        phoneDbDateIndexKey(characterName),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return record;
  } catch (error) {
    console.error("[剧情助手] 保存私信记录失败:", error);
    notify("error", "私信保存失败，请查看控制台报错。");
    return null;
  }
}


// 按日期分组返回某联系人的全部聊天记录：[{ dateKey, msgs }]，按时间升序。
export async function getAllPhoneMessages(characterName) {
  const dateIndex = await getPhoneDateIndex(characterName);
  const result = [];
  for (const dateKey of dateIndex) {
    const msgs = await getPhoneMessagesForDate(characterName, dateKey);
    if (msgs.length > 0) result.push({ dateKey, msgs });
  }
  return result;
}


// 清空某联系人的全部本地私信记录（供设置页"清空聊天记录"用），不影响其他联系人。
export async function clearPhoneMessages(characterName) {
  try {
    const db = await openPhoneDB();
    const dateIndex = await getPhoneDateIndex(characterName);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readwrite");
      const store = tx.objectStore(PHONE_IDB_STORE);
      dateIndex.forEach((dateKey) =>
        store.delete(phoneDbMessagesKey(characterName, dateKey)),
      );
      store.delete(phoneDbDateIndexKey(characterName));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 清空私信记录失败:", error);
    notify("error", "清空私信记录失败，请查看控制台报错。");
  }
}


// === Helper: 消息 id 是 appendPhoneMessage 里按 `${ts}_${随机串}` 生成的，随机串来自
// Math.random().toString(36) 不含下划线，所以按第一个 "_" 切开取前半段就是 ts，
// 反推出它当初落库用的 dateKey（跟 appendPhoneMessage 存的时候算法一致），不用额外记录。===
export function dateKeyFromMessageId(messageId) {
  const ts = Number(String(messageId).split("_")[0]);
  return formatDateKey(new Date(ts));
}


// 修改某联系人某条私信的文本内容（编辑功能用）；找不到这条消息时静默返回，不报错。
export async function updatePhoneMessageText(characterName, messageId, newText) {
  try {
    const db = await openPhoneDB();
    const dateKey = dateKeyFromMessageId(messageId);
    const list = await getPhoneMessagesForDate(characterName, dateKey);
    const record = list.find((m) => m.id === messageId);
    if (!record) return;
    record.text = newText;
    record.stickerId = null; // 手动编辑过文字后退化成普通文字消息，不再关联图片
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readwrite");
      tx.objectStore(PHONE_IDB_STORE).put(
        list,
        phoneDbMessagesKey(characterName, dateKey),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 修改私信内容失败:", error);
    notify("error", "修改私信内容失败，请查看控制台报错。");
  }
}


// 删除某联系人的一条私信（删除功能用）；分桶删空后顺手把这个 dateKey 从日期索引里摘掉，保持数据干净。
export async function deletePhoneMessage(characterName, messageId) {
  try {
    const db = await openPhoneDB();
    const dateKey = dateKeyFromMessageId(messageId);
    const list = (await getPhoneMessagesForDate(characterName, dateKey)).filter(
      (m) => m.id !== messageId,
    );
    const dateIndex = await getPhoneDateIndex(characterName);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readwrite");
      const store = tx.objectStore(PHONE_IDB_STORE);
      if (list.length > 0) {
        store.put(list, phoneDbMessagesKey(characterName, dateKey));
      } else {
        store.delete(phoneDbMessagesKey(characterName, dateKey));
        const nextIndex = dateIndex.filter((d) => d !== dateKey);
        store.put(nextIndex, phoneDbDateIndexKey(characterName));
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 删除私信失败:", error);
    notify("error", "删除私信失败，请查看控制台报错。");
  }
}
