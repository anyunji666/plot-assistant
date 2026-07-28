"use strict";

import { MAP_INFO_TITLE, getCtx, notify } from "../core.js";
import { BIG_MAP_ID, BIG_MAP_SUMMARY_PLACEHOLDER, PALETTE, SMALL_MAP_NOTE_PLACEHOLDER, clearCurrentCharacterImages, deleteImage, escapeHtml, getActiveMap, getActiveMapId, getFabVisible, getMapCurrentCharacterName, getMapExtRoot, getSettings, isBigMapActive, loadImage, loadLeaflet, makeCharacterMapData, makeSmallMap, mapState, saveImage, saveSettings } from "./data.js";
import { bindPopupFormEvents, openMarkerForm, renderAllMarkers, renderMarkerList } from "./markers.js";
import { cancelRouteMode, renderAllRoutes, renderRouteList, startRouteMode } from "./routes.js";
import { getOrCreateSummaryLorebook, lorebookEntryExists, saveOrOverwriteLorebookEntry } from "../worldinfo.js";


// ============================================================
// 角色数据归属（不再需要手动绑定，数据自动跟随当前打开的角色卡）
// ============================================================

// 面板顶部的小字提示：当前是哪个角色的数据，或群聊/未选角色卡时的临时状态说明
export function updateCharIndicatorUI() {
  const el = document.getElementById("mm-char-indicator");
  if (!el) return;
  const name = getMapCurrentCharacterName();
  if (name) {
    el.textContent = `📍 当前角色：${name}（标记/路线/小地图数据自动跟随此角色卡）`;
    el.className = "mm-char-indicator mm-char-indicator-ok";
  } else {
    el.textContent =
      "⚠️ 群聊或未选中角色卡：本次编辑只临时保存在本地，不会写入任何世界书";
    el.className = "mm-char-indicator mm-char-indicator-warn";
  }
}


// ============================================================
// UI 构建
// ============================================================

// 注：不再有独立的扩展菜单入口（原 injectButton）。
// 现在只有两个入口打开同一个地图编辑器：剧情助手控制面板里的「地图标记」按钮，
// 以及下面这个右下角悬浮球。

// ---- 悬浮按钮（快捷入口，可拖拽，位置记忆） ----
// 注：默认位置几经调整——右下角会被酒馆自身的底部输入栏/工具栏遮住；改成左上角后
// 又发现容易和酒馆自身侧栏开关等常驻 UI 挤在一起、找不到；现在改成右上角，跟音效
// 插件的移动端默认停靠位置一致，同样能避开底部遮挡。
// 存储 key 换成新的 v5：拖拽逻辑改成跟音效插件悬浮窗一致的 left/top + clientX/clientY
// 写法（不再走 right/bottom 换算），存储字段也从 {right, bottom} 换成 {left, top}，
// 旧版本存的坐标格式对不上了，升级 key 让旧坐标作废，重新从右上角默认值开始。
export const FAB_POS_KEY = "mm_fab_pos_v5";


export function loadFabPos() {
  try {
    const raw = localStorage.getItem(FAB_POS_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (typeof pos.left === "number" && typeof pos.top === "number") return pos;
  } catch (e) {
    /* 忽略，用默认位置 */
  }
  return null;
}


export function saveFabPos(left, top) {
  try {
    localStorage.setItem(FAB_POS_KEY, JSON.stringify({ left, top }));
  } catch (e) {
    /* 存储失败不影响功能 */
  }
}


// 清掉本地存的拖拽坐标（left/top），并把 fab 身上覆盖过 CSS 的内联定位样式一并清空，
// 让 #mm-fab 的静态 CSS（右上角）重新生效。用在「关闭悬浮球」这个动作上：
// 不管之前拖到了哪、算出来的坐标有没有问题，关了再开永远回到一个干净的默认位置，
// 相当于顺手给了一个"重置"的入口，不用再额外加按钮。
export function resetFabPos() {
  try {
    localStorage.removeItem(FAB_POS_KEY);
  } catch (e) {
    /* 忽略 */
  }
  const fab = document.getElementById("mm-fab");
  if (fab) {
    fab.style.top = "";
    fab.style.left = "";
    fab.style.right = "";
    fab.style.bottom = "";
  }
}


// 根据 fabVisible 设置切换悬浮球的显隐；只是 display:none/""，不销毁 DOM，
// 拖拽记住的位置不会丢。悬浮球还没注入时（例如还没到初始化那一步）静默跳过即可，
// 后面 injectFloatingButton() 里会再调用一次自己套用当前设置。
export function applyFabVisibility() {
  const fab = document.getElementById("mm-fab");
  if (!fab) return;
  fab.style.display = getFabVisible() ? "" : "none";
}


export function injectFloatingButton() {
  if (document.getElementById("mm-fab")) return;

  // 悬浮球退回最基础、最安全的 <div> 写法。之前改用 <dialog>.show() 是为了绕开
  // "祖先元素 transform 导致 position:fixed 的 div 被顶到页面中间"的坑，但自检结果显示
  // 这个环境里祖先链根本没有 transform/filter/contain 问题——反而是 <dialog> 自己的
  // top layer 定位/命中测试不稳定，实测出现过整个按钮被算到屏幕外（y 是负数看不见），
  // 以及"点哪都误触发"的问题。所以换回普通 div，逻辑更简单可控。
  const html = `
        <div id="mm-fab" title="地图标记">
            <div class="mm-fab-icon">🗺️</div>
        </div>`;
  document.body.insertAdjacentHTML("beforeend", html);

  const fab = document.getElementById("mm-fab");

  // 默认位置（右上角）完全交给 style.css 里 #mm-fab 的静态样式，这里不再用
  // window.innerWidth/innerHeight 现算一个初始坐标——部分浏览器/WebView 在这个脚本
  // 执行的时刻报的窗口尺寸不一定可靠，现算出来的坐标可能有误差甚至把按钮塞到屏幕外。
  // JS 只在"用户之前真的拖拽过、本地存了坐标"时才用内联样式覆盖 CSS 默认值；
  // 没拖过的话完全不碰 fab.style.right/bottom，让 CSS 说了算，跟音效插件悬浮窗的
  // 默认定位方式保持一致。
  const FAB_MARGIN = 16;
  const FAB_SIZE = 44;

  // 把 left/top 夹到"当前屏幕范围内"：用于套用本地存储的旧坐标，或者拖拽结束时
  // 夹取新坐标，避免坐标落到屏幕外找不到按钮（拖拽这时候窗口尺寸已经渲染稳定，
  // 读 window.innerWidth/innerHeight 比脚本刚注入那一刻更可靠）。
  function clampPos(left, top) {
    const maxLeft = Math.max(
      FAB_MARGIN,
      window.innerWidth - FAB_MARGIN - FAB_SIZE,
    );
    const maxTop = Math.max(
      FAB_MARGIN,
      window.innerHeight - FAB_MARGIN - FAB_SIZE,
    );
    return {
      left: Math.min(Math.max(left, FAB_MARGIN), maxLeft),
      top: Math.min(Math.max(top, FAB_MARGIN), maxTop),
    };
  }

  const savedPos = loadFabPos();
  if (savedPos) {
    const pos = clampPos(savedPos.left, savedPos.top);
    // 直接写 left/top，right/bottom 置 auto：跟音效插件悬浮窗一致的写法，
    // 不再需要像以前 right/bottom 那套那样额外操心"top 没清掉导致纵向位置被吃掉"的坑。
    fab.style.right = "auto";
    fab.style.bottom = "auto";
    fab.style.left = `${pos.left}px`;
    fab.style.top = `${pos.top}px`;
  }
  // 显隐由控制面板里的「悬浮球开/悬浮球关」按钮控制（见 setFabVisibleSetting /
  // applyFabVisibility），这里只负责套用启动时已保存的状态，PC/移动端同一套逻辑。
  applyFabVisibility();

  // 拖拽逻辑：跟音效插件悬浮窗（floating-panel.js 的 onDragStart/onDragMove）保持
  // 一致的写法——全程只用 clientX/clientY 换算 left/top，不反过来推算 right/bottom。
  // 之前那套「按下时读一次 innerWidth 算 startRight，移动时又读一次 innerWidth 做
  // clamp」的写法，在地址栏收起/展开导致 innerWidth/innerHeight 拖拽途中变化时，
  // 两次读到的值对不上，算出来的坐标就可能直接跳出屏幕——这才是"一拖就没影"的真正
  // 原因。改成 left/top 之后，move 阶段只在同一帧里读一次窗口尺寸做 clamp，从根上
  // 绕开了这个问题；区分"点击"和"拖动"避免拖完松手误触发打开面板的逻辑不变。
  let dragging = false;
  let moved = false;
  let startX = 0,
    startY = 0;
  let offsetX = 0,
    offsetY = 0;

  const DRAG_THRESHOLD = 6; // 像素，超过这个位移才算拖拽而不是点击

  function onPointerDown(e) {
    dragging = true;
    moved = false;
    const point = e.touches ? e.touches[0] : e;
    const rect = fab.getBoundingClientRect();
    offsetX = point.clientX - rect.left;
    offsetY = point.clientY - rect.top;
    startX = point.clientX;
    startY = point.clientY;
    document.addEventListener("mousemove", onPointerMove);
    document.addEventListener("mouseup", onPointerUp);
    document.addEventListener("touchmove", onPointerMove, { passive: false });
    document.addEventListener("touchend", onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const point = e.touches ? e.touches[0] : e;
    if (
      Math.abs(point.clientX - startX) > DRAG_THRESHOLD ||
      Math.abs(point.clientY - startY) > DRAG_THRESHOLD
    ) {
      moved = true;
      if (e.touches) e.preventDefault();
    }
    if (!moved) return;

    const x = point.clientX - offsetX;
    const y = point.clientY - offsetY;

    // 限制在可视区域内，留一点边距，避免拖出屏幕外找不到；这里的
    // window.innerWidth/innerHeight 只在这一帧读一次，不存在跟按下时的读数对不上的问题。
    const margin = 4;
    const size = fab.offsetWidth;
    const newLeft = Math.min(
      Math.max(x, margin),
      window.innerWidth - size - margin,
    );
    const newTop = Math.min(
      Math.max(y, margin),
      window.innerHeight - size - margin,
    );

    fab.style.right = "auto";
    fab.style.bottom = "auto";
    fab.style.left = `${newLeft}px`;
    fab.style.top = `${newTop}px`;
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("mousemove", onPointerMove);
    document.removeEventListener("mouseup", onPointerUp);
    document.removeEventListener("touchmove", onPointerMove);
    document.removeEventListener("touchend", onPointerUp);

    if (moved) {
      const left = parseFloat(fab.style.left) || 0;
      const top = parseFloat(fab.style.top) || 0;
      saveFabPos(left, top);
    } else {
      // 没有明显位移，视为一次点击
      openModal();
    }
  }

  fab.addEventListener("mousedown", onPointerDown);
  fab.addEventListener("touchstart", onPointerDown, { passive: true });
}


export function buildModalSkeleton() {
  const html = `
    <dialog id="mm-modal-overlay">
        <div id="mm-modal">
            <div id="mm-toolbar">
                <span class="mm-title">🗺️ 地图标记</span>

                <select id="mm-map-switch" title="切换当前编辑/查看的地图"></select>

                <label class="mm-file-btn" id="mm-upload-image-label">
                    上传大地图
                    <input type="file" id="mm-upload-image" accept="image/*" style="display:none;">
                </label>
                <button id="mm-new-smallmap-btn">新建小地图</button>

                <button id="mm-add-route-btn">添加路线</button>
                <button id="mm-export-btn">导出标记 JSON</button>
                <label class="mm-file-btn">
                    导入标记 JSON
                    <input type="file" id="mm-import-json" accept="application/json" style="display:none;">
                </label>
                <button id="mm-manage-factions-btn">管理势力</button>
                <button id="mm-clear-all-btn" class="mm-danger">清除当前角色的地图数据</button>
                <button id="mm-sidebar-toggle-btn">📋 列表</button>
                <button id="mm-close-btn">关闭</button>
            </div>
            <div id="mm-char-indicator"></div>
            <div id="mm-body">
                <div id="mm-map-container">
                    <div id="mm-route-hint" class="mm-hidden">
                        <span id="mm-route-hint-text"></span>
                        <button id="mm-route-cancel-btn">取消</button>
                    </div>
                    <div id="mm-map" class="mm-empty"></div>
                </div>
                <div id="mm-sidebar-backdrop"></div>
                <div id="mm-sidebar">
                    <div id="mm-map-meta"></div>
                    <div class="mm-sidebar-header">
                        <span>标记列表</span>
                    </div>
                    <div id="mm-marker-list"></div>
                    <div id="mm-route-section">
                        <div class="mm-sidebar-header mm-sidebar-subheader">
                            <span>路线（势力行动，仅大地图）</span>
                        </div>
                        <div id="mm-route-list"></div>
                    </div>
                    <div id="mm-sidebar-footer">
                        点击地图任意位置添加标记。大地图上点击"添加路线"后依次点击两个已有标记，
                        再填写方位、队伍信息与时间即可生成一条路线。小地图没有路线，
                        用左侧"布局关系/特别说明"手写空间描述即可。大地图左侧可点击"自动载入"
                        生成一版说明文字后自行修改，改过之后就不会再被自动覆盖。以上信息会自动写入当前角色的
                        「角色名总结」世界书里固定标题为「地图信息」的一条条目，是否启用仍需去世界书面板里自己勾选。
                    </div>
                </div>
            </div>
        </div>
    </dialog>`;
  document.body.insertAdjacentHTML("beforeend", html);

  document.getElementById("mm-close-btn").addEventListener("click", closeModal);
  // dialog 元素本身撑满视口并用 flex 居中 #mm-modal，点在 #mm-modal 之外、
  // dialog 自身范围内（即视觉上的半透明遮罩区域）时 e.target 会是 dialog 本身。
  document.getElementById("mm-modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "mm-modal-overlay") closeModal();
  });
  // 原生 dialog 默认按 Esc 会直接关闭（触发 cancel 事件）；路线选点模式下希望
  // Esc 先取消选点、不要连带把整个面板关掉，所以这里拦一下。
  document
    .getElementById("mm-modal-overlay")
    .addEventListener("cancel", (e) => {
      if (mapState.routeMode) {
        e.preventDefault();
        cancelRouteMode();
      }
    });
  document
    .getElementById("mm-map-switch")
    .addEventListener("change", (e) => switchActiveMap(e.target.value));
  document
    .getElementById("mm-upload-image")
    .addEventListener("change", handleImageUpload);
  document
    .getElementById("mm-new-smallmap-btn")
    .addEventListener("click", handleNewSmallMap);
  document
    .getElementById("mm-export-btn")
    .addEventListener("click", exportMarkersJson);
  document
    .getElementById("mm-import-json")
    .addEventListener("change", importMarkersJson);
  document
    .getElementById("mm-manage-factions-btn")
    .addEventListener("click", openFactionManager);
  document
    .getElementById("mm-add-route-btn")
    .addEventListener("click", startRouteMode);
  document
    .getElementById("mm-route-cancel-btn")
    .addEventListener("click", cancelRouteMode);
  document
    .getElementById("mm-clear-all-btn")
    .addEventListener("click", clearAllData);
  // 移动端：侧栏（标记列表/路线列表/地图设置）改为可收起的抽屉，
  // 桌面端该按钮通过 CSS 隐藏，不影响原有并排布局。
  document
    .getElementById("mm-sidebar-toggle-btn")
    .addEventListener("click", () => toggleMobileSidebar());
  document
    .getElementById("mm-sidebar-backdrop")
    .addEventListener("click", () => toggleMobileSidebar(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mapState.routeMode) cancelRouteMode();
  });
}


// 移动端侧栏抽屉开关（桌面端侧栏常驻显示，这两个 class 不生效）
export function toggleMobileSidebar(force) {
  const sidebar = document.getElementById("mm-sidebar");
  const backdrop = document.getElementById("mm-sidebar-backdrop");
  if (!sidebar || !backdrop) return;
  const open =
    typeof force === "boolean"
      ? force
      : !sidebar.classList.contains("mm-sidebar-open");
  sidebar.classList.toggle("mm-sidebar-open", open);
  backdrop.classList.toggle("mm-sidebar-open", open);
}


export async function openModal() {
  if (!getMapCurrentCharacterName()) {
    notify(
      "warning",
      "请先进入某个角色卡的对话界面，再打开地图标记——否则现在标记的内容只是临时的，不会保存到任何角色卡上，切换角色或刷新页面就会丢失。",
    );
    return;
  }

  if (!document.getElementById("mm-modal-overlay")) {
    buildModalSkeleton();
  }
  const dialog = document.getElementById("mm-modal-overlay");
  if (!dialog.open) {
    try {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        // 极少数不支持 <dialog> 的旧浏览器兜底：退化成普通显示，
        // 至少还能用，只是失去了 top layer 带来的抗祖先 transform 干扰能力。
        dialog.setAttribute("open", "");
      }
    } catch (err) {
      // showModal 理论上可能因为一些环境限制抛错（比如被塞进了受限 iframe），
      // 兜底降级成普通显示，不能让报错导致面板“点了完全没反应”。
      console.error("[MapMarker] showModal 失败，已降级为普通显示", err);
      dialog.setAttribute("open", "");
    }
  }

  updateCharIndicatorUI();
  populateMapSwitch();

  // 打开地图编辑器是「地图信息」世界书条目唯一的自动创建入口：
  // 之前删掉过这条条目的话，其它编辑操作不会把它自动建回来，只有点这个按钮才会。
  syncMapInfoEntry(true);

  await loadLeaflet().catch((err) => {
    toastr?.error?.(err.message);
  });
  if (!mapState.map) {
    await initMap();
  } else {
    // 弹窗此前已经打开过，但期间可能切换了角色卡——mapState.map 实例复用，
    // 必须重新按当前角色的地图数据刷新一遍图片/标记/路线，否则会显示上一个角色的旧内容。
    await loadActiveMapImageAndRender();
  }
  setTimeout(() => mapState.map && mapState.map.invalidateSize(), 50);
  renderMarkerList();
  renderRouteList();
  renderMapMeta();
}


export function closeModal() {
  const dialog = document.getElementById("mm-modal-overlay");
  if (dialog?.open) {
    if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }
  toggleMobileSidebar(false);
}


// ============================================================
// 地图初始化 / 切换
// ============================================================

export async function initMap() {
  const L = window.L;
  mapState.map = L.map("mm-map", {
    crs: L.CRS.Simple,
    minZoom: -5,
    maxZoom: 4,
    zoomSnap: 0.25,
  });

  mapState.markersLayer = L.layerGroup().addTo(mapState.map);
  mapState.routesLayer = L.layerGroup().addTo(mapState.map);
  bindPopupFormEvents(); // 用 popupopen 事件统一绑定表单按钮，解决 DOM 时机问题

  mapState.map.on("click", (e) => {
    if (mapState.routeMode) return; // 路线选点模式下，空白处点击不做任何事，只能点已有标记
    if (!mapState.imageOverlay) return; // 没有底图时不允许打点
    openMarkerForm(null, e.latlng);
  });

  // 路线的角度/间距是按"当前缩放级别下的屏幕像素"算的，缩放变化后重新渲染一次，
  // 让路线和标记之间的视觉间距在任意缩放级别下都保持一致，不会显得忽远忽近。
  mapState.map.on("zoomend", renderAllRoutes);

  await loadActiveMapImageAndRender();
}


export async function loadActiveMapImageAndRender() {
  const map = getActiveMap();
  const id = getActiveMapId();

  mapState.markersLayer?.clearLayers();
  mapState.routesLayer?.clearLayers();
  if (mapState.imageOverlay) {
    mapState.map.removeLayer(mapState.imageOverlay);
    mapState.imageOverlay = null;
  }

  const savedImage = await loadImage(id);
  if (savedImage) {
    renderImageOverlay(savedImage, map.imageWidth, map.imageHeight);
  } else {
    document.getElementById("mm-map")?.classList.add("mm-empty");
    mapState.map.setView([0, 0], 0);
  }

  renderAllMarkers();
  renderAllRoutes();
}


export async function switchActiveMap(mapId) {
  if (mapState.routeMode) cancelRouteMode();
  const settings = getSettings();
  settings.activeMapId = mapId;
  saveSettings();

  if (mapState.map) {
    await loadActiveMapImageAndRender();
  }
  renderMarkerList();
  renderRouteList();
  renderMapMeta();
}


export function populateMapSwitch() {
  const sel = document.getElementById("mm-map-switch");
  if (!sel) return;
  const settings = getSettings();
  let html = `<option value="${BIG_MAP_ID}">大地图（世界地图）</option>`;
  settings.maps.small.forEach((m) => {
    html += `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`;
  });
  sel.innerHTML = html;
  sel.value = settings.activeMapId;
}


export function renderImageOverlay(dataUrl, width, height) {
  const L = window.L;
  document.getElementById("mm-map").classList.remove("mm-empty");

  if (mapState.imageOverlay) {
    mapState.map.removeLayer(mapState.imageOverlay);
  }
  // 用图片的像素尺寸作为坐标系边界：y 用负数让图片方向正常显示
  const bounds = [
    [-height, 0],
    [0, width],
  ];
  mapState.imageOverlay = L.imageOverlay(dataUrl, bounds).addTo(mapState.map);
  mapState.map.fitBounds(bounds);
}


export function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    const img = new Image();
    img.onload = async () => {
      const map = getActiveMap();
      map.imageWidth = img.width;
      map.imageHeight = img.height;
      saveSettings();
      renderImageOverlay(dataUrl, img.width, img.height); // 先渲染，不等待存储完成
      await saveImage(getActiveMapId(), dataUrl);
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
  e.target.value = "";
}


// 生成一张纯白底图（小地图默认底图），避免用户新建小地图时必须先准备好图片
export function createBlankImageDataUrl(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png");
}


export async function handleNewSmallMap() {
  const width = 1200;
  const height = 800;
  const dataUrl = createBlankImageDataUrl(width, height);

  const settings = getSettings();
  const newMap = makeSmallMap({
    name: `未命名地图${settings.maps.small.length + 1}`,
    imageWidth: width,
    imageHeight: height,
  });
  settings.maps.small.push(newMap);
  settings.activeMapId = newMap.id;
  saveSettings();
  await saveImage(newMap.id, dataUrl);

  populateMapSwitch();
  await loadActiveMapImageAndRender();
  renderMarkerList();
  renderRouteList();
  renderMapMeta();
  scheduleMapInfoSync();
  toastr?.success?.(
    "已新建小地图（默认白底图），可在右侧改名，也可以点【替换底图图片】换成真实图片",
  );
}


// ============================================================
// 小地图管理（名称 / 是否加载 / 布局说明 / 删除）
// ============================================================

export function renderMapMeta() {
  const el = document.getElementById("mm-map-meta");
  const routeSection = document.getElementById("mm-route-section");
  const addRouteBtn = document.getElementById("mm-add-route-btn");
  const uploadBigLabel = document.getElementById("mm-upload-image-label");
  if (!el) return;

  if (isBigMapActive()) {
    routeSection?.classList.remove("mm-hidden");
    addRouteBtn?.classList.remove("mm-hidden");
    uploadBigLabel?.classList.remove("mm-hidden");

    const big = getSettings().maps.big;
    el.innerHTML = `
            <div class="mm-map-meta-block">
                <label>自定义上下文说明（可编辑，非空时会替代自动生成的标记/路线文本）</label>
                <textarea id="mm-bigmap-summary" placeholder="${escapeHtml(BIG_MAP_SUMMARY_PLACEHOLDER)}">${escapeHtml(big.customSummary || "")}</textarea>
                <button id="mm-bigmap-autoload-btn">根据当前标记 自动载入</button>
            </div>`;

    document
      .getElementById("mm-bigmap-summary")
      .addEventListener("change", (ev) => {
        big.customSummary = ev.target.value;
        saveSettings();
        scheduleMapInfoSync();
      });
    document
      .getElementById("mm-bigmap-autoload-btn")
      .addEventListener("click", () => {
        const autoParts = [];
        if (big.markers.length > 0) {
          autoParts.push(
            big.markers
              .map((m) => `${m.name}(${m.faction})：${m.description || ""}`)
              .join("\n"),
          );
        }
        const routeLines = buildRouteSummaryList(big);
        if (routeLines.length > 0) {
          autoParts.push(routeLines.join("\n"));
        }
        const autoText = autoParts.join("\n\n");

        if (
          big.customSummary &&
          big.customSummary.trim() &&
          !confirm(
            "这会覆盖当前文本框里的内容，确定要用当前标记/路线自动生成的内容替换吗？",
          )
        ) {
          return;
        }

        big.customSummary = autoText;
        document.getElementById("mm-bigmap-summary").value = autoText;
        saveSettings();
        scheduleMapInfoSync();
      });
    return;
  }

  routeSection?.classList.add("mm-hidden");
  addRouteBtn?.classList.add("mm-hidden");
  uploadBigLabel?.classList.add("mm-hidden");

  const map = getActiveMap();
  el.innerHTML = `
        <div class="mm-map-meta-block">
            <label>地图名称（局部地点的名称）</label>
            <input type="text" id="mm-smallmap-name" value="${escapeHtml(map.name)}">
            <label class="mm-checkbox-label">
                <input type="checkbox" id="mm-smallmap-loaded" ${map.loadedInContext ? "checked" : ""}>
                加载到本次对话的 AI 上下文
            </label>
            <label>布局关系 / 特别说明</label>
            <textarea id="mm-smallmap-note" placeholder="${escapeHtml(SMALL_MAP_NOTE_PLACEHOLDER)}">${escapeHtml(map.layoutNote || "")}</textarea>
            <label class="mm-file-btn mm-smallmap-replace-btn">
                替换底图图片
                <input type="file" id="mm-smallmap-replace-image" accept="image/*" style="display:none;">
            </label>
            <button id="mm-smallmap-delete" class="mm-danger">删除这张小地图</button>
        </div>`;

  document
    .getElementById("mm-smallmap-name")
    .addEventListener("change", (ev) => {
      const val = ev.target.value.trim();
      map.name = val || map.name;
      ev.target.value = map.name;
      saveSettings();
      populateMapSwitch();
      scheduleMapInfoSync();
    });
  document
    .getElementById("mm-smallmap-loaded")
    .addEventListener("change", (ev) => {
      map.loadedInContext = ev.target.checked;
      saveSettings();
      scheduleMapInfoSync();
    });
  document
    .getElementById("mm-smallmap-note")
    .addEventListener("change", (ev) => {
      map.layoutNote = ev.target.value;
      saveSettings();
      scheduleMapInfoSync();
    });
  document
    .getElementById("mm-smallmap-delete")
    .addEventListener("click", () => deleteSmallMap(map.id));
  document
    .getElementById("mm-smallmap-replace-image")
    .addEventListener("change", handleImageUpload);
}


export async function deleteSmallMap(id) {
  if (
    !confirm(
      "确定删除这张小地图吗？它的标记点和图片都会被一并删除，此操作不可恢复。",
    )
  )
    return;

  const settings = getSettings();
  settings.maps.small = settings.maps.small.filter((m) => m.id !== id);
  settings.activeMapId = BIG_MAP_ID;
  saveSettings();
  await deleteImage(id);

  populateMapSwitch();
  await loadActiveMapImageAndRender();
  renderMarkerList();
  renderRouteList();
  renderMapMeta();
  scheduleMapInfoSync();
}


// ============================================================
// 势力管理（全局共用，不区分大/小地图）
// ============================================================

export function openFactionManager() {
  const settings = getSettings();
  const existing = document.getElementById("mm-faction-manager");
  if (existing) existing.remove();

  const rows = settings.factions
    .map(
      (t, i) => `
        <div class="mm-faction-row">
            <input type="color" value="${t.color}" data-idx="${i}" class="mm-faction-color">
            <input type="text" value="${escapeHtml(t.name)}" data-idx="${i}" class="mm-faction-name">
            <button data-idx="${i}" class="mm-faction-del">✕</button>
        </div>`,
    )
    .join("");

  const html = `
        <div id="mm-faction-manager">
            <div style="font-weight:bold;margin-bottom:8px;">管理势力</div>
            <div id="mm-faction-rows">${rows}</div>
            <button id="mm-faction-add" style="margin-top:6px;">+ 新增势力</button>
            <div style="margin-top:10px;text-align:right;">
                <button id="mm-faction-close">完成</button>
            </div>
        </div>`;
  document
    .getElementById("mm-map-container")
    .insertAdjacentHTML("beforeend", html);

  function bindEvents() {
    document.querySelectorAll(".mm-faction-color").forEach((el) => {
      el.onchange = () => {
        settings.factions[el.dataset.idx].color = el.value;
        saveSettings();
        renderAllMarkers();
        renderAllRoutes(); // 该势力颜色变了，从这个势力出发的路线颜色也要跟着变
        renderMarkerList();
        renderRouteList();
      };
    });
    document.querySelectorAll(".mm-faction-name").forEach((el) => {
      el.onchange = () => {
        const idx = el.dataset.idx;
        const oldName = settings.factions[idx].name;
        const newName = el.value.trim() || oldName;
        settings.factions[idx].name = newName;
        // 同步更新已使用该势力的标记（大地图 + 全部小地图）
        settings.maps.big.markers.forEach((m) => {
          if (m.faction === oldName) m.faction = newName;
        });
        settings.maps.small.forEach((sm) => {
          sm.markers.forEach((m) => {
            if (m.faction === oldName) m.faction = newName;
          });
        });
        saveSettings();
        renderAllMarkers();
        renderAllRoutes();
        renderMarkerList();
        renderRouteList();
        scheduleMapInfoSync();
      };
    });
    document.querySelectorAll(".mm-faction-del").forEach((el) => {
      el.onclick = () => {
        settings.factions.splice(el.dataset.idx, 1);
        saveSettings();
        renderAllRoutes();
        openFactionManager(); // 重新渲染
        renderMarkerList();
        renderRouteList();
      };
    });
  }
  bindEvents();

  document.getElementById("mm-faction-add").onclick = () => {
    const color = PALETTE[settings.factions.length % PALETTE.length];
    settings.factions.push({ name: "新势力", color });
    saveSettings();
    openFactionManager();
  };
  document.getElementById("mm-faction-close").onclick = () => {
    document.getElementById("mm-faction-manager")?.remove();
  };
}


// ============================================================
// 清除所有数据
// ============================================================

export async function clearAllData() {
  const name = getMapCurrentCharacterName();
  const ok = confirm(
    (name
      ? `确定要清除角色「${name}」的地图数据吗？\n`
      : "确定要清除当前这份临时地图数据吗？\n") +
      "包括：大地图和所有小地图的图片、标记、路线、势力设置。不会影响其他角色的地图数据。\n" +
      "此操作不可恢复（标记数据可以提前导出 JSON 备份）。",
  );
  if (!ok) return;

  await clearCurrentCharacterImages();

  if (name) {
    getMapExtRoot().byCharacter[name] = makeCharacterMapData();
  } else {
    mapState.transientMapData = makeCharacterMapData();
  }
  saveSettings();

  mapState.markersLayer?.clearLayers();
  mapState.routesLayer?.clearLayers();
  if (mapState.imageOverlay && mapState.map) {
    mapState.map.removeLayer(mapState.imageOverlay);
    mapState.imageOverlay = null;
  }
  document.getElementById("mm-map")?.classList.add("mm-empty");

  updateCharIndicatorUI();
  populateMapSwitch();
  renderMarkerList();
  renderRouteList();
  renderMapMeta();
  scheduleMapInfoSync();

  toastr?.success?.(
    name ? `已清除角色「${name}」的地图数据` : "已清除本次临时地图数据",
  );
}


// ============================================================
// 导出 / 导入 JSON（仅标记数据，不含图片）
// ============================================================

export function exportMarkersJson() {
  const settings = getSettings();
  const payload = {
    version: 2,
    factions: settings.factions,
    maps: {
      big: {
        markers: settings.maps.big.markers,
        routes: settings.maps.big.routes,
        customSummary: settings.maps.big.customSummary || "",
      },
      small: settings.maps.small.map((m) => ({
        id: m.id,
        name: m.name,
        layoutNote: m.layoutNote,
        loadedInContext: m.loadedInContext,
        markers: m.markers,
      })),
    },
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `map-markers-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}


export function importMarkersJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      const settings = getSettings();

      if (Array.isArray(data.factions)) settings.factions = data.factions;

      if (data.maps) {
        if (data.maps.big) {
          if (Array.isArray(data.maps.big.markers))
            settings.maps.big.markers = data.maps.big.markers;
          if (Array.isArray(data.maps.big.routes))
            settings.maps.big.routes = data.maps.big.routes;
          if (typeof data.maps.big.customSummary === "string")
            settings.maps.big.customSummary = data.maps.big.customSummary;
        }
        if (Array.isArray(data.maps.small)) {
          settings.maps.small = data.maps.small.map((m) =>
            makeSmallMap({
              id: m.id,
              name: m.name,
              layoutNote: m.layoutNote,
              loadedInContext: m.loadedInContext,
              markers: Array.isArray(m.markers) ? m.markers : [],
            }),
          );
        }
      }

      settings.activeMapId = BIG_MAP_ID;
      saveSettings();

      populateMapSwitch();
      loadActiveMapImageAndRender().then(() => {
        renderMarkerList();
        renderRouteList();
        renderMapMeta();
        scheduleMapInfoSync();
      });
      toastr?.success?.("标记数据导入成功（小地图需要重新上传对应图片）");
    } catch (err) {
      console.error(err);
      toastr?.error?.("JSON 解析失败，请检查文件格式");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
}


// ============================================================
// AI 上下文注入
// ============================================================

// 把大地图路线列表拼成完整的行动描述句子数组，过滤掉引用了已删除标记的脏数据
export function buildRouteSummaryList(bigMap) {
  const markerById = Object.fromEntries(bigMap.markers.map((m) => [m.id, m]));
  return (bigMap.routes || [])
    .map((r) => {
      const from = markerById[r.fromId];
      const to = markerById[r.toId];
      if (!from || !to) return null;

      const relativePosition = `${r.bearing || ""}${r.distance || ""}`;
      const departClause = r.departTime
        ? `${r.party}${r.departTime}出发，`
        : `${r.party}`;

      return `${from.faction}行动——${from.name}→${to.name}。${to.name}位于${from.name}${relativePosition}。${departClause}预计${r.arriveTime}到达${to.name}。`;
    })
    .filter(Boolean);
}


export function buildSummaryText() {
  const settings = getSettings();
  const parts = [];

  const big = settings.maps.big;
  const routeLines = buildRouteSummaryList(big); // 无论是否使用自定义文本，都要算一遍，用于下面判断是否加免责声明

  if (big.customSummary && big.customSummary.trim()) {
    // 用户已手动编辑/载入过自定义说明，直接用它替代自动拼接的标记/路线文本
    parts.push(big.customSummary.trim());
  } else {
    if (big.markers.length > 0) {
      const lines = big.markers.map(
        (m) => `${m.name}(${m.faction})：${m.description || ""}`,
      );
      parts.push(lines.join("\n"));
    }
    if (routeLines.length > 0) {
      parts.push(routeLines.join("\n"));
    }
  }

  // 小地图：只注入用户勾选了"加载到本次对话"的
  settings.maps.small
    .filter((m) => m.loadedInContext)
    .forEach((m) => {
      const noteParts = [];
      if (m.markers.length > 0) {
        noteParts.push(`标记点：${m.markers.map((mk) => mk.name).join("、")}`);
      }
      if (m.layoutNote && m.layoutNote.trim()) {
        noteParts.push(m.layoutNote.trim());
      }
      if (noteParts.length > 0) {
        parts.push(`地图"${m.name}"的空间布局：\n${noteParts.join("\n")}`);
      }
    });

  if (parts.length === 0) return "";

  // 免责声明只在整段开头出现一次，不再逐条路线重复
  const disclaimer =
    routeLines.length > 0
      ? "（势力行动路线及到达时间仅供参考，具体以故事实际发展为准）"
      : "";

  return `[用户当前设有以下地点信息/行动${disclaimer}：\n${parts.join("\n\n")}]`;
}


// === 把「地图信息」写入当前角色的"角色名总结"世界书（跟小总结/大总结同一本、同一套默认位置）===
// 群聊 / 未选中角色卡时直接跳过，不创建/不写入任何世界书，数据只留在内存里。
// force=false（默认，几乎所有自动触发点用这个）：条目不存在就直接跳过，不自动新建——
//   避免你手动把「地图信息」条目删掉之后，随便编辑一下标记/切个对话它又自己冒出来。
// force=true：不管条目在不在都直接创建/覆盖——唯一的调用点是打开地图编辑器（点击"地图标记"按钮）。
export async function syncMapInfoEntry(force = false) {
  const name = getMapCurrentCharacterName();
  if (!name) return;
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    if (!force) {
      const exists = await lorebookEntryExists(lorebookName, MAP_INFO_TITLE);
      if (!exists) return; // 还没打开过地图编辑器创建过条目，不自动新建
    }
    const content = buildSummaryText();
    await saveOrOverwriteLorebookEntry(
      lorebookName,
      MAP_INFO_TITLE,
      content,
      true,
    );
  } catch (err) {
    console.warn("[剧情助手/地图] 同步「地图信息」世界书条目失败：", err);
  }
}


// 标记/路线/小地图任何一次编辑都会调用这个，短暂防抖一下，避免连续操作时反复读写世界书。
// force 透传给 syncMapInfoEntry：默认 false，只在条目已存在时更新。
export let mmSyncDebounceTimer = null;

export function scheduleMapInfoSync(force = false) {
  if (mmSyncDebounceTimer) clearTimeout(mmSyncDebounceTimer);
  mmSyncDebounceTimer = setTimeout(() => {
    mmSyncDebounceTimer = null;
    syncMapInfoEntry(force);
  }, 400);
}


// 切换角色卡时：重新同步该角色的「地图信息」条目；如果弹窗正开着，也要把地图画面刷新成新角色的数据
export function registerMapGlobalEvents() {
  try {
    const context = getCtx();
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
      scheduleMapInfoSync();
      if (document.getElementById("mm-modal-overlay")?.open) {
        updateCharIndicatorUI();
        populateMapSwitch();
        loadActiveMapImageAndRender().then(() => {
          renderMarkerList();
          renderRouteList();
          renderMapMeta();
        });
      }
    });
  } catch (err) {
    console.warn(
      "[剧情助手/地图] 事件绑定失败，切换角色卡时地图数据可能无法自动更新：",
      err,
    );
  }
}
