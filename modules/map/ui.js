"use strict";

import { escapeHtml, getCtx, notify } from "../core.js";
import { BIG_MAP_ID, BIG_MAP_SUMMARY_PLACEHOLDER, PALETTE, SMALL_MAP_NOTE_PLACEHOLDER, clearCurrentCharacterImages, colorForFaction, deleteImage, exportMarkersJson, getActiveMap, getActiveMapId, getFabVisible, getMapCurrentCharacterName, getMapExtRoot, getSettings, importMarkersJson, isBigMapActive, loadImage, loadLeaflet, makeCharacterMapData, makeSmallMap, mapState, saveImage, saveSettings } from "./store.js";
import { buildRouteSummaryList, scheduleMapInfoSync, syncMapInfoEntry } from "./generator.js";
import { bindPopupFormEvents, openMarkerForm, renderAllMarkers, renderMarkerList } from "./markers.js";
import { cancelRouteMode, renderAllRoutes, renderRouteList, startRouteMode } from "./routes.js";
import { runNpcScheduleUpdate } from "./npc-schedule/engine.js";
import { getNpcScheduleLlmSettings, saveNpcScheduleLlmSettings } from "./npc-schedule/store.js";
import { niFetchModelIds } from "../novel-summary/lib/api.js";


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


// === Function: 更新"显示/隐藏标记点名称"按钮的文案与高亮状态 ===
// 跟 mapState.showMarkerLabels 保持一致；开关本身不持久化，纯UI状态，跟切换地图/打开路线模式同级。
function updateMarkerLabelsToggleBtn() {
  const btn = document.getElementById("mm-marker-labels-toggle-btn");
  if (!btn) return;
  const on = mapState.showMarkerLabels;
  btn.textContent = on ? "🏷️ 隐藏标记名称" : "🏷️ 显示标记名称";
  btn.classList.toggle("mm-active", on);
}


export function buildModalSkeleton() {
  const html = `
    <dialog id="mm-modal-overlay">
        <div id="mm-modal">
            <div id="mm-toolbar">
                <span class="mm-title">🗺️ 地图标记</span>

                <button id="mm-marker-labels-toggle-btn" title="切换标记点名称是常驻显示、还是只有鼠标悬停时才显示">🏷️ 显示标记名称</button>

                <button id="mm-recenter-btn" title="回到图片（视野被拖远、找不到图片时点这个）">🎯</button>

                <select id="mm-map-switch" title="切换当前编辑/查看的地图"></select>

                <label class="mm-file-btn" id="mm-upload-image-label">
                    上传大地图
                    <input type="file" id="mm-upload-image" accept="image/*" style="display:none;">
                </label>
                <button id="mm-new-smallmap-btn">新建小地图</button>

                <button id="mm-add-route-btn">添加路线</button>
                <button id="mm-export-btn" title="导出的文件包含标记点位和当前底图图片，一次导入即可全部恢复">导出地图数据</button>
                <label class="mm-file-btn">
                    导入地图数据
                    <input type="file" id="mm-import-json" accept="application/json" style="display:none;">
                </label>
                <button id="mm-manage-factions-btn">管理势力</button>
                <button id="mm-npc-schedule-btn">📜 NPC行程</button>
                <button id="mm-npc-llm-config-btn" title="配置NPC行程LLM连接与「启用AI调度」开关">⚙️NPC模型</button>
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
                        大地图上点击"添加路线"后选择标记点，输入"行动规划"即可生成一条路线。
                        小地图没有自动载入功能，左侧"布局关系/特别说明"框里手写空间描述。
                        以上信息会自动写入当前角色的
                        「角色名总结」世界书里固定标题为「地图信息」的一条条目，
                        需要取消注入的话可去世界书面板里关闭或删除「地图信息」栏。
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
    .getElementById("mm-marker-labels-toggle-btn")
    .addEventListener("click", () => {
      mapState.showMarkerLabels = !mapState.showMarkerLabels;
      updateMarkerLabelsToggleBtn();
      renderAllMarkers(); // 重新绑定所有标记的tooltip，让 permanent 立即生效
    });
  updateMarkerLabelsToggleBtn(); // 初始按钮文案跟当前状态（默认隐藏）保持一致
  document
    .getElementById("mm-recenter-btn")
    .addEventListener("click", () => {
      if (!mapState.imageOverlay) return; // 没有底图时按钮点了不做任何事
      mapState.map.fitBounds(mapState.imageOverlay.getBounds());
    });
  document
    .getElementById("mm-map-switch")
    .addEventListener("change", (e) => switchActiveMap(e.target.value));
  document
    .getElementById("mm-upload-image")
    .addEventListener("change", handleImageUpload);
  document
    .getElementById("mm-new-smallmap-btn")
    .addEventListener("click", openSmallMapMarkerPicker);
  document
    .getElementById("mm-export-btn")
    .addEventListener("click", exportMarkersJson);
  document
    .getElementById("mm-import-json")
    .addEventListener("change", (e) =>
      importMarkersJson(e, () => {
        populateMapSwitch();
        loadActiveMapImageAndRender().then(() => {
          renderMarkerList();
          renderRouteList();
          renderMapMeta();
          scheduleMapInfoSync();
        });
      }),
    );
  document
    .getElementById("mm-manage-factions-btn")
    .addEventListener("click", openFactionManager);
  document
    .getElementById("mm-npc-schedule-btn")
    .addEventListener("click", openNpcScheduleEditor);
  document
    .getElementById("mm-npc-llm-config-btn")
    .addEventListener("click", openNpcScheduleLlmConfig);
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
    if (mapState.pendingFormContext) {
      // 当前已有弹窗（标记表单/路线表单/路线操作）打开，点击地图空白区域视为"关闭弹窗"，
      // 不再在点击位置新建标记（否则会出现"关闭又立刻弹出一个新的"的怪现象）
      mapState.map.closePopup();
      return;
    }
    openMarkerForm(null, e.latlng);
  });

  // 路线的角度/间距是按"当前缩放级别下的屏幕像素"算的，缩放变化后重新渲染一次，
  // 让路线和标记之间的视觉间距在任意缩放级别下都保持一致，不会显得忽远忽近。
  mapState.map.on("zoomend", renderAllRoutes);

  // 地图上的点击（含空白处/标记）都由上面 map 自己的 click 事件处理好了；
  // 但点击右侧菜单栏/侧边栏这些完全在 Leaflet 地图容器之外的区域，Leaflet 感知不到，
  // 所以这里额外兜底：只要还有表单弹窗开着，点击地图容器以外的任何地方都直接关掉它。
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!mapState.pendingFormContext) return;
      const mapContainer = document.getElementById("mm-map-container");
      if (mapContainer && !mapContainer.contains(e.target)) {
        mapState.map.closePopup();
      }
    },
    true,
  );

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


export async function handleNewSmallMap(marker) {
  const name = marker?.name?.trim();
  if (!name) return; // 理论上不会走到这：入口只有 openSmallMapMarkerPicker，一定会传合法标记

  const settings = getSettings();
  const existing = settings.maps.small.find((m) => m.name === name);
  if (existing) {
    // 小地图硬关联大地图标记名，同名即视为已创建（含之前的孤儿小地图被自动认领的情况）：
    // 不再弹改名副本框，直接提醒并切换过去，方便用户接着编辑。
    toastr?.info?.(`"${name}"已创建过小地图，已为你切换过去`);
    settings.activeMapId = existing.id;
    saveSettings();
    populateMapSwitch();
    await loadActiveMapImageAndRender();
    renderMarkerList();
    renderRouteList();
    renderMapMeta();
    return;
  }

  await createSmallMapWithName(name);
}


// 实际执行新建：生成白底图 + 写入 settings.maps.small + 切换为当前地图。
async function createSmallMapWithName(name) {
  const settings = getSettings();
  const width = 1200;
  const height = 800;
  const dataUrl = createBlankImageDataUrl(width, height);

  const newMap = makeSmallMap({
    name,
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
    `已新建"${name}"的小地图（默认白底图），可在右侧点【替换底图图片】换成真实图片`,
  );
}



// 小地图的定位是"大地图某个地点的内部详图"，所以新建时强制先从大地图已有标记里选一个，
// 用它的名称作为小地图名，避免出现小地图和大地图地点对不上号的情况。
export function openSmallMapMarkerPicker() {
  closeAllSidePanels();
  const settings = getSettings();
  const bigMarkers = settings.maps.big.markers;

  let listHtml;
  if (bigMarkers.length === 0) {
    listHtml = `<div class="mm-side-panel-hint">大地图上还没有任何标记点，请先去大地图上点击添加一个地点标记，再回来新建它的内部详图。</div>`;
  } else {
    const groups = {};
    bigMarkers.forEach((m) => {
      if (!groups[m.faction]) groups[m.faction] = [];
      groups[m.faction].push(m);
    });
    listHtml = Object.keys(groups)
      .map((faction) => {
        const color = colorForFaction(faction);
        const items = groups[faction]
          .map(
            (m) => `
                <div class="mm-marker-item" data-id="${m.id}">
                    <span class="mm-color-dot" style="background:${color};"></span>
                    <span class="mm-marker-name">${escapeHtml(m.name)}</span>
                </div>`,
          )
          .join("");
        return `<div class="mm-faction-group">
                <div class="mm-faction-group-title"><span class="mm-color-dot" style="background:${color};"></span>${escapeHtml(faction)}</div>
                ${items}
            </div>`;
      })
      .join("");
  }

  const html = `
        <div id="mm-smallmap-picker" class="mm-side-panel">
            <div class="mm-side-panel-title">选择要新建详图的地点</div>
            <div class="mm-side-panel-hint">
                小地图是大地图某个地点的内部详图，点击一个大地图标记，即用该标记的名称新建一张小地图。
            </div>
            <div id="mm-smallmap-picker-list">${listHtml}</div>
            <div class="mm-side-panel-actions">
                <button id="mm-smallmap-picker-cancel">取消</button>
            </div>
        </div>`;
  document
    .getElementById("mm-map-container")
    .insertAdjacentHTML("beforeend", html);
  bindOutsideClickClose("mm-smallmap-picker");

  document.getElementById("mm-smallmap-picker-cancel").onclick = () => {
    document.getElementById("mm-smallmap-picker")?.remove();
  };

  document
    .querySelectorAll("#mm-smallmap-picker .mm-marker-item")
    .forEach((el) => {
      el.addEventListener("click", () => {
        const marker = bigMarkers.find((m) => m.id === el.dataset.id);
        document.getElementById("mm-smallmap-picker")?.remove();
        if (marker) handleNewSmallMap(marker);
      });
    });
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
  // 小地图名称硬关联大地图同名标记，不再支持手动改名（改名请去大地图上改标记名，会自动同步）。
  // 大地图上找不到同名标记时，说明这是一张孤儿小地图（原关联标记被删了），给个提示。
  const settings = getSettings();
  const isOrphan = !settings.maps.big.markers.some((bm) => bm.name === map.name);
  el.innerHTML = `
        <div class="mm-map-meta-block">
            <label>地图名称（跟随大地图同名标记，自动同步）</label>
            <div class="mm-smallmap-name-display">${escapeHtml(map.name)}</div>
            ${isOrphan ? `<div class="mm-smallmap-orphan-hint">⚠️ 未关联大地图标记，新建同名标记后自动绑定</div>` : ""}
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
// 通用：三个浮层弹窗（管理势力 / NPC行程 / NPC模型配置）共用的
// "同时只显示一个" + "点击弹窗外部区域自动关闭" 逻辑
// ============================================================

const SIDE_PANEL_IDS = ["mm-faction-manager", "mm-npc-schedule-editor", "mm-npc-llm-config", "mm-smallmap-picker"];

// 打开任意一个浮层前先调用一次：保证同一时间只有一个浮层显示，不会互相重叠。
function closeAllSidePanels() {
  SIDE_PANEL_IDS.forEach((id) => document.getElementById(id)?.remove());
}

// 每个 panelId 只保留一个"外部点击关闭"监听，重新打开/刷新同一个浮层时会先顶掉旧的，
// 避免同一个浮层每刷新一次就叠加一个新监听。用 mousedown 而不是 click，是为了在
// "点击打开按钮"这类会触发浮层重建的场景里，跟浮层自身内部的 click 事件保持时序一致；
// 绑定动作本身延后到下一个事件循环（setTimeout 0），避免"打开浮层"这一次点击本身
// 被当成"点了外部"而立刻把刚打开的浮层关掉。
const sidePanelOutsideClickHandlers = new Map();

function bindOutsideClickClose(panelId) {
  const prevHandler = sidePanelOutsideClickHandlers.get(panelId);
  if (prevHandler) document.removeEventListener("mousedown", prevHandler, true);

  const handler = (e) => {
    const panel = document.getElementById(panelId);
    if (!panel || !panel.isConnected) {
      document.removeEventListener("mousedown", handler, true);
      sidePanelOutsideClickHandlers.delete(panelId);
      return;
    }
    if (!panel.contains(e.target)) {
      panel.remove();
      document.removeEventListener("mousedown", handler, true);
      sidePanelOutsideClickHandlers.delete(panelId);
    }
  };
  sidePanelOutsideClickHandlers.set(panelId, handler);
  setTimeout(() => document.addEventListener("mousedown", handler, true), 0);
}


// ============================================================
// 势力管理（全局共用，不区分大/小地图）
// ============================================================

export function openFactionManager() {
  const settings = getSettings();
  closeAllSidePanels();

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
  bindOutsideClickClose("mm-faction-manager");

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
// NPC智能行程（资料编辑 + LLM连接配置 + 启用开关）
// ============================================================


// 「NPC行程」资料编辑面板：一个大文本框，自由格式填写NPC活动规律，按角色卡区分存储。
// 同时提供一个「立即刷新」按钮，方便不等下一层AI消息就手动触发一次NPC位置判断。
export function openNpcScheduleEditor() {
  const settings = getSettings();
  closeAllSidePanels();

  const html = `
        <div id="mm-npc-schedule-editor" class="mm-side-panel">
            <div class="mm-side-panel-title">NPC行程资料</div>
            <div class="mm-side-panel-hint">
                把NPC的活动规律/日程写在这里即可，自由格式。
                <br><br>
                配置好NPC模型并启用AI调度后，每层AI消息生成完，会结合这份资料 + 最新剧情，
                自动判断各NPC此刻大致在地图哪个已有标记点，写进对应标记的"当前此地停留的NPC"栏位。
                <br><br>
                "立即刷新NPC位置"按钮用于手动触发：用当前已保存的资料 + 最新一层剧情正文，
                立刻调用配置好的AI算一遍NPC位置并写入标记点。
            </div>
            <textarea id="mm-npc-schedule-text" placeholder="例如：
李文远：卯时-巳时在演武场操练，午后多在书房处理军务，入夜后常去黑风寨巡视。
赵敏：素日深居王府绣楼，逢集市日会去城中集市走动。">${escapeHtml(settings.npcScheduleText || "")}</textarea>
            <div class="mm-side-panel-actions">
                <button id="mm-npc-schedule-refresh-btn">立即刷新NPC位置</button>
                <button id="mm-npc-schedule-close">保存</button>
            </div>
        </div>`;
  document
    .getElementById("mm-map-container")
    .insertAdjacentHTML("beforeend", html);
  bindOutsideClickClose("mm-npc-schedule-editor");

  document
    .getElementById("mm-npc-schedule-text")
    .addEventListener("change", (ev) => {
      settings.npcScheduleText = ev.target.value;
      saveSettings();
    });

  document
    .getElementById("mm-npc-schedule-refresh-btn")
    .addEventListener("click", async () => {
      // 手动刷新前先把文本框里可能还没触发 change 事件的最新内容存一下，避免用刚打完字
      // 还没失焦就点刷新时，用到的还是上一次保存的旧资料。
      settings.npcScheduleText = document.getElementById("mm-npc-schedule-text").value;
      saveSettings();

      const btn = document.getElementById("mm-npc-schedule-refresh-btn");
      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "刷新中···";
      try {
        const ran = await runNpcScheduleUpdate();
        if (ran) toastr?.success?.("NPC位置已刷新");
      } catch (err) {
        console.error("[剧情助手/地图] 手动刷新NPC位置失败:", err);
        toastr?.error?.("刷新失败，请查看控制台报错");
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    });

  document
    .getElementById("mm-npc-schedule-close")
    .addEventListener("click", () => {
      // 显式存一次，不完全依赖 textarea 的 change/blur 事件，跟"立即刷新"按钮保持同样的保险写法
      settings.npcScheduleText = document.getElementById("mm-npc-schedule-text").value;
      saveSettings();
      document.getElementById("mm-npc-schedule-editor")?.remove();
    });
}


// NPC行程LLM连接配置：连接参数全局共享（不分角色卡），留空反代地址即跟随酒馆当前对话连接。
// 「启用AI调度」开关本身仍按角色卡分别存储（跟 npcScheduleText 同级，见 map/store.js），
// 只是入口从工具栏挪到了这个弹窗里，跟连接配置放在一起更符合"这是同一件事的配置"的直觉。
export function openNpcScheduleLlmConfig() {
  closeAllSidePanels();
  const cfg = getNpcScheduleLlmSettings();
  const mapSettings = getSettings();

  const html = `
        <div id="mm-npc-llm-config" class="mm-side-panel">
            <div class="mm-side-panel-title">NPC行程LLM连接配置</div>
            <div class="mm-side-panel-hint">
                留空「反代地址」= 跟随酒馆当前对话连接（不需要额外配置，推荐直接留空）。
                填写后走自定义 chat/completions 反代，与剧情LLM、状态表LLM相互独立、互不影响。
            </div>
            <label>反代地址（留空跟随酒馆连接）</label>
            <input type="text" id="mm-npc-llm-url" value="${escapeHtml(cfg.apiUrl || "")}" placeholder="https://...">
            <label>API Key</label>
            <input type="password" id="mm-npc-llm-key" value="${escapeHtml(cfg.apiKey || "")}">
            <label>模型名</label>
            <div class="mm-model-row">
                <input type="text" id="mm-npc-llm-model" value="${escapeHtml(cfg.model || "")}" placeholder="模型 ID，例如 gpt-4o-mini">
                <select id="mm-npc-llm-model-select" class="mm-hidden"></select>
                <button id="mm-npc-llm-model-fetch-btn" type="button">获取列表</button>
            </div>
            <label>超时（分钟）</label>
            <input type="number" id="mm-npc-llm-timeout" min="1" value="${Number.isFinite(cfg.apiTimeoutMin) ? cfg.apiTimeoutMin : 15}">
            <div class="mm-side-panel-actions">
                <label class="mm-checkbox-label" id="mm-npc-enabled-label">
                    <input type="checkbox" id="mm-npc-auto-toggle" ${mapSettings.npcScheduleEnabled ? "checked" : ""}>
                    启用AI调度
                </label>
                <button id="mm-npc-llm-config-close">保存</button>
            </div>
        </div>`;
  document
    .getElementById("mm-map-container")
    .insertAdjacentHTML("beforeend", html);
  bindOutsideClickClose("mm-npc-llm-config");

  document
    .getElementById("mm-npc-auto-toggle")
    .addEventListener("change", (ev) => {
      mapSettings.npcScheduleEnabled = ev.target.checked;
      saveSettings();
    });

  const persist = () => {
    cfg.apiUrl = document.getElementById("mm-npc-llm-url").value.trim();
    cfg.apiKey = document.getElementById("mm-npc-llm-key").value.trim();
    cfg.model = document.getElementById("mm-npc-llm-model").value.trim();
    const timeout = parseInt(
      document.getElementById("mm-npc-llm-timeout").value,
      10,
    );
    cfg.apiTimeoutMin = Number.isFinite(timeout) && timeout > 0 ? timeout : 15;
    saveNpcScheduleLlmSettings();
  };
  ["mm-npc-llm-url", "mm-npc-llm-key", "mm-npc-llm-model", "mm-npc-llm-timeout"].forEach(
    (id) => {
      document.getElementById(id).addEventListener("change", persist);
    },
  );

  // 拉取模型列表：跟状态表配置弹窗（modules/summary/ui.js）同一套交互——文本框先隐藏，
  // 换成一个下拉框，选中后把值写回文本框、下拉框重新隐藏，方便跟已有的手填/自动保存逻辑复用。
  document
    .getElementById("mm-npc-llm-model-fetch-btn")
    .addEventListener("click", async () => {
      const url = document.getElementById("mm-npc-llm-url").value.trim();
      if (!url) {
        toastr?.error?.("请先填写反代地址，再获取模型列表");
        return;
      }
      const fetchBtn = document.getElementById("mm-npc-llm-model-fetch-btn");
      const oldText = fetchBtn.textContent;
      fetchBtn.disabled = true;
      fetchBtn.textContent = "获取中…";
      try {
        const models = await niFetchModelIds({
          url,
          key: document.getElementById("mm-npc-llm-key").value.trim(),
          fetchImpl: fetch,
        });
        if (!models.length) {
          toastr?.error?.("未获取到模型列表");
          return;
        }
        const select = document.getElementById("mm-npc-llm-model-select");
        const input = document.getElementById("mm-npc-llm-model");
        select.innerHTML = ['<option value="" disabled selected>请选择模型</option>']
          .concat(
            models.map(
              (m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`,
            ),
          )
          .join("");
        select.classList.remove("mm-hidden");
        input.classList.add("mm-hidden");
        select.onchange = () => {
          input.value = select.value;
          select.classList.add("mm-hidden");
          input.classList.remove("mm-hidden");
          persist();
        };
      } catch (err) {
        toastr?.error?.(`拉取失败: ${err?.message || err}`);
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = oldText;
      }
    });

  document
    .getElementById("mm-npc-llm-config-close")
    .addEventListener("click", () => {
      persist();
      document.getElementById("mm-npc-llm-config")?.remove();
    });
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
      "此操作不可恢复（可以提前用「导出标记数据」备份，标记和底图会一起存进备份文件）。",
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
// 导出 / 导入标记数据（JSON，含标记点位 + 底图图片，一次导入即可全部恢复）
// ============================================================

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
