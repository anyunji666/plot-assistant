"use strict";

import { saveSettingsDebounced } from "../../../../../../script.js";
import { extension_settings } from "../../../../../extensions.js";
import { getCtx } from "../core.js";

export const mapState = {
  map: null,
  markersLayer: null,
  routesLayer: null,
  imageOverlay: null,
  routeMode: false,
  routeFromId: null,
  routeFollowUp: null, // { party, departTime }：从某条路线发起"后续行动"时的一次性预填数据，表单读取后即清空
  pendingFormContext: null,
  transientMapData: null,
};


// #####################################################################################
// === 地图标记模块（见文件末尾初始化处的调用）===
// #####################################################################################

export const MAP_MODULE_NAME = "map_marker";


// Leaflet 资源改为本地打包，路径基于当前模块自身的 URL 拼出，
// 不写死安装目录，无论装在默认扩展目录还是 third-party 目录下都能找到。
// 注意：这个文件现在位于 modules/map/ 下（相对插件根目录多嵌套了两层），
// 所以要往上跳两级（../../）才是 lib/leaflet/ 所在的插件根目录。
export const MODULE_BASE = new URL("../../", import.meta.url).href;

export const LEAFLET_CSS = `${MODULE_BASE}lib/leaflet/leaflet.css`;

export const LEAFLET_JS = `${MODULE_BASE}lib/leaflet/leaflet.js`;


// 大地图的固定 id（同时也是它在 IndexedDB 里的图片 key）
export const BIG_MAP_ID = "big";


export const DEFAULT_FACTIONS = [
  { name: "大宋", color: "#3b82f6" },
  { name: "倭寇", color: "#ef4444" },
];


// 8 方位罗盘文字，index = round(bearing/45) % 8，bearing 以正北为 0，顺时针增大
export const COMPASS_NAMES = [
  "正北方",
  "东北方",
  "正东方",
  "东南方",
  "正南方",
  "西南方",
  "正西方",
  "西北方",
];


export const SMALL_MAP_NOTE_PLACEHOLDER =
  "布局关系：\n" +
  "- 大门朝南，进门是照壁；\n" +
  "- 穿过照壁是前院，前院正对正房；\n" +
  "- 正房东侧隔一个天井是东厢房；\n" +
  "- 从大门到正房，会依次经过：照壁 → 前院 → 正房。\n\n" +
  "特别说明：\n" +
  "- 东厢房和正房之间的天井可以互相看到对方院子的情况。";


// ---- 默认设置结构 ----
export function makeBigMap() {
  return {
    markers: [], // { id, x, y, name, faction, description }
    routes: [], // { id, fromId, toId, bearing, distance, party, departTime, arriveTime }
    imageWidth: 2000,
    imageHeight: 1200,
    customSummary: "", // 用户可编辑的上下文说明，非空时替代自动拼接的标记/路线文本
  };
}


export const BIG_MAP_SUMMARY_PLACEHOLDER =
  "控图寨(大宋)：易守难攻的边境据点，扼守入山要道。\n" +
  "黑风口(倭寇)：倭寇偷渡登陆的隐蔽渡口。\n" +
  "海角滩(倭寇)：倭寇船队的秘密停泊点。\n\n" +
  "大宋行动——控图寨→黑风口。黑风口位于控图寨东南方约三百里，先锋营辰时出发，预计两日后申时到达黑风口。\n" +
  "倭寇行动——海角滩→控图寨。控图寨位于海角滩西北方约一百五十里，先遣队五更出发，预计次日午时到达控图寨。";


export function makeSmallMap(overrides) {
  return Object.assign(
    {
      id: `map_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: "未命名地图",
      layoutNote: "", // 用户手写的"布局关系/特别说明"
      loadedInContext: true, // 是否加载进本次对话的 AI 上下文
      markers: [], // 小地图没有路线/移动路径概念，只有标记点
      imageWidth: 2000,
      imageHeight: 1200,
    },
    overrides || {},
  );
}


// ---- 单个角色的地图数据结构（不再有 boundCharAvatar，改为按角色名自动区分）----
export function makeCharacterMapData() {
  return {
    activeMapId: BIG_MAP_ID, // 当前正在编辑/查看的地图："big" 或某张小地图的 id
    factions: JSON.parse(JSON.stringify(DEFAULT_FACTIONS)),
    maps: {
      big: makeBigMap(),
      small: [],
    },
  };
}


// extension_settings[MAP_MODULE_NAME] 顶层结构：{ byCharacter: { 角色名: 单角色数据 }, fabVisible: boolean }
// fabVisible 是全局开关（不分角色、不分设备），控制地图悬浮球是否显示，默认关闭。
export function getMapExtRoot() {
  if (!extension_settings[MAP_MODULE_NAME]) {
    extension_settings[MAP_MODULE_NAME] = { byCharacter: {} };
  }
  const root = extension_settings[MAP_MODULE_NAME];
  if (!root.byCharacter) root.byCharacter = {};
  if (typeof root.fabVisible !== "boolean") root.fabVisible = false;
  return root;
}


// 读取悬浮球是否应该显示（默认 false）
export function getFabVisible() {
  return getMapExtRoot().fabVisible === true;
}


// 写入悬浮球显示开关并立即持久化
export function setFabVisibleSetting(visible) {
  getMapExtRoot().fabVisible = !!visible;
  saveSettingsDebounced();
}


// 当前地图数据对应的角色名；群聊或未选中角色卡时返回 null（不是抛错，方便各处直接判空）
export function getMapCurrentCharacterName() {
  try {
    const context = getCtx();
    if (context.groupId) return null; // 不支持群聊
    const charId = context.characterId;
    if (charId === undefined || charId === null) return null;
    const char = context.characters?.[charId];
    if (!char || !char.name) return null;
    return char.name;
  } catch (e) {
    return null;
  }
}


// 取当前角色对应的地图数据（自动创建默认结构），群聊/未选中角色卡时退回内存临时数据
export function getSettings() {
  const name = getMapCurrentCharacterName();
  if (!name) {
    if (!mapState.transientMapData) mapState.transientMapData = makeCharacterMapData();
    return mapState.transientMapData;
  }
  const root = getMapExtRoot();
  if (!root.byCharacter[name]) root.byCharacter[name] = makeCharacterMapData();
  return root.byCharacter[name];
}


export function saveSettings() {
  saveSettingsDebounced();
}


// ---- 当前正在编辑/查看的地图 ----
export function isBigMapActive() {
  return getSettings().activeMapId === BIG_MAP_ID;
}


export function getActiveMap() {
  const settings = getSettings();
  if (settings.activeMapId === BIG_MAP_ID) return settings.maps.big;
  const found = settings.maps.small.find((m) => m.id === settings.activeMapId);
  if (found) return found;
  // 引用的小地图不存在了（比如被删除），兜底回退到大地图
  settings.activeMapId = BIG_MAP_ID;
  return settings.maps.big;
}


export function getActiveMapId() {
  return getSettings().activeMapId;
}


// ---- 图片单独存 IndexedDB（容量远大于 localStorage，避免大图超限）----
// 每张地图（大地图固定 key "big"，每张小地图用自己的 id）各自存一份图片。
export const IDB_NAME = "mm_map_marker_db";

export const IDB_STORE = "images";


export function openImageDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}


// 图片按"角色名::原id"存储，数据按角色区分；群聊/未选中角色卡时用固定占位符，
// 仅供当次会话临时使用（反正对应的地图数据本身也不会持久化）。
export function mmImageDbKey(id) {
  const name = getMapCurrentCharacterName();
  return `${name || "__no_character__"}::${id}`;
}


export async function saveImage(id, dataUrl) {
  try {
    const db = await openImageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(dataUrl, mmImageDbKey(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("[MapMarker] 图片保存失败（IndexedDB）", e);
    toastr?.error?.("地图图片保存失败，请查看控制台报错。");
  }
}


export async function loadImage(id) {
  try {
    const db = await openImageDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(mmImageDbKey(id));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error("[MapMarker] 图片读取失败（IndexedDB）", e);
    return null;
  }
}


export async function deleteImage(id) {
  try {
    const db = await openImageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(mmImageDbKey(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("[MapMarker] 删除图片失败（IndexedDB）", e);
  }
}


// 只清除当前角色名下的图片（key 前缀匹配），不影响其他角色存过的底图
export async function clearCurrentCharacterImages() {
  const prefix = `${getMapCurrentCharacterName() || "__no_character__"}::`;
  try {
    const db = await openImageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("[MapMarker] 清空当前角色图片失败（IndexedDB）", e);
  }
}


// ---- 动态加载本地打包的 Leaflet ----
export let leafletLoading = null;

export function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;

  leafletLoading = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = LEAFLET_JS;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(
        new Error(
          "Leaflet 本地文件加载失败，请检查插件目录是否完整（lib/leaflet/）。",
        ),
      );
    document.head.appendChild(script);
  });
  return leafletLoading;
}


// ---- 颜色分配（自定义势力没指定颜色时循环取色） ----
export const PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export function colorForFaction(factionName) {
  const settings = getSettings();
  const found = settings.factions.find((t) => t.name === factionName);
  if (found) return found.color;
  return "#999999";
}


// ============================================================
// 工具函数
// ============================================================

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
