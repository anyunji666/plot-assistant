"use strict";

import { escapeHtml } from "../core.js";
import { colorForFaction, getActiveMap, getSettings, isBigMapActive, mapState, saveSettings } from "./store.js";
import { scheduleMapInfoSync } from "./generator.js";
import { beginRouteFromMarker, bindRouteActionsEvents, bindRouteFormEvents, handleRoutePointClick, renderAllRoutes, renderRouteList } from "./routes.js";
import { toggleMobileSidebar } from "./ui.js";


// ============================================================
// 标记 CRUD（大地图/小地图通用，作用于当前 getActiveMap()）
// ============================================================

export function renderAllMarkers() {
  if (!mapState.markersLayer) return;
  mapState.markersLayer.clearLayers();
  const map = getActiveMap();
  map.markers.forEach((m) => addLeafletMarker(m));
}


export function addLeafletMarker(marker) {
  const L = window.L;
  const color = colorForFaction(marker.faction);
  const icon = L.divIcon({
    className: "",
    html: `<div class="mm-leaflet-icon" style="width:16px;height:16px;background:${color};"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  const lm = L.marker([marker.y, marker.x], { icon }).addTo(mapState.markersLayer);
  lm.bindTooltip(marker.name, { direction: "top", offset: [0, -8] });
  lm.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    if (mapState.routeMode) {
      handleRoutePointClick(marker);
      return;
    }
    openMarkerForm(marker);
  });
}


export function openMarkerForm(existingMarker, latlng) {
  const L = window.L;
  const isEdit = !!existingMarker;
  const big = isBigMapActive();

  let formHtml;
  if (big) {
    const settings = getSettings();
    const factionOptions = settings.factions
      .map(
        (t) =>
          `<option value="${escapeHtml(t.name)}" ${isEdit && existingMarker.faction === t.name ? "selected" : ""}>${escapeHtml(t.name)}</option>`,
      )
      .join("");
    formHtml = `
            <div class="mm-form-popup">
                <label>地点名称</label>
                <input type="text" id="mm-f-name" value="${isEdit ? escapeHtml(existingMarker.name) : ""}" placeholder="例如：黑风寨">
                <label>所属势力</label>
                <select id="mm-f-faction">${factionOptions}</select>
                <label>地点描述</label>
                <textarea id="mm-f-description" placeholder="例如：这是一个易守难攻的据点">${isEdit ? escapeHtml(existingMarker.description || "") : ""}</textarea>
                <div class="mm-form-actions">
                    ${isEdit ? '<button id="mm-f-delete" class="mm-danger">删除</button>' : ""}
                    ${isEdit ? '<button id="mm-f-route">添加路线</button>' : ""}
                    <button id="mm-f-cancel">取消</button>
                    <button id="mm-f-save">保存</button>
                </div>
            </div>`;
  } else {
    // 小地图标记只需要一个名称，不需要势力/描述
    formHtml = `
            <div class="mm-form-popup">
                <label>标记名称</label>
                <input type="text" id="mm-f-name" value="${isEdit ? escapeHtml(existingMarker.name) : ""}" placeholder="例如：正房">
                <div class="mm-form-actions">
                    ${isEdit ? '<button id="mm-f-delete" class="mm-danger">删除</button>' : ""}
                    <button id="mm-f-cancel">取消</button>
                    <button id="mm-f-save">保存</button>
                </div>
            </div>`;
  }

  mapState.pendingFormContext = { type: "marker", existingMarker, latlng, isEdit };

  const popupLatLng = isEdit
    ? [existingMarker.y, existingMarker.x]
    : [latlng.lat, latlng.lng];
  // maxHeight：Leaflet 会给弹层内容自动套一层可滚动容器，避免内容比可视区域高时
  // 直接溢出屏幕、划不到看不全（横屏矮屏尤其明显）。用地图容器高度的 70% 做上限。
  const mapH1 = mapState.map.getContainer().clientHeight || window.innerHeight;
  L.popup({
    closeButton: false,
    minWidth: 200,
    autoPan: true,
    maxHeight: Math.round(mapH1 * 0.7),
  })
    .setLatLng(popupLatLng)
    .setContent(formHtml)
    .openOn(mapState.map);
}


// 在地图初始化时只绑定一次：Leaflet 保证 popupopen 触发时 DOM 已经插入完毕，可以安全操作表单元素。
export function bindPopupFormEvents() {
  mapState.map.on("popupopen", (e) => {
    const ctx = mapState.pendingFormContext;
    if (!ctx) return; // 不是我们插件打开的 popup（理论上不会发生，做个保护）

    const root = e.popup.getElement();
    if (!root) return;

    if (ctx.type === "route") {
      bindRouteFormEvents(root, ctx);
      return;
    }

    if (ctx.type === "route-actions") {
      bindRouteActionsEvents(root, ctx);
      return;
    }

    bindMarkerFormEvents(root, ctx);
  });

  mapState.map.on("popupclose", () => {
    mapState.pendingFormContext = null;
  });
}


export function bindMarkerFormEvents(root, ctx) {
  const { existingMarker, latlng, isEdit } = ctx;

  const cancelBtn = root.querySelector("#mm-f-cancel");
  const saveBtn = root.querySelector("#mm-f-save");
  const deleteBtn = root.querySelector("#mm-f-delete");
  const routeBtn = root.querySelector("#mm-f-route");

  if (cancelBtn) {
    cancelBtn.onclick = () => mapState.map.closePopup();
  }

  if (routeBtn) {
    routeBtn.onclick = () => {
      mapState.map.closePopup();
      beginRouteFromMarker(existingMarker);
    };
  }

  if (deleteBtn) {
    deleteBtn.onclick = () => {
      const map = getActiveMap();
      map.markers = map.markers.filter((m) => m.id !== existingMarker.id);
      // 级联删除引用了这个标记的路线（仅大地图有 routes）
      if (Array.isArray(map.routes)) {
        map.routes = map.routes.filter(
          (r) => r.fromId !== existingMarker.id && r.toId !== existingMarker.id,
        );
      }
      saveSettings();
      renderAllMarkers();
      renderAllRoutes();
      renderMarkerList();
      renderRouteList();
      scheduleMapInfoSync();
      mapState.map.closePopup();
    };
  }

  if (saveBtn) {
    saveBtn.onclick = () => {
      const name = root.querySelector("#mm-f-name").value.trim();
      if (!name) {
        toastr?.warning?.(
          isBigMapActive() ? "请填写地点名称" : "请填写标记名称",
        );
        return;
      }

      const map = getActiveMap();

      if (isBigMapActive()) {
        const faction = root.querySelector("#mm-f-faction").value;
        const description = root
          .querySelector("#mm-f-description")
          .value.trim();
        if (isEdit) {
          const target = map.markers.find((m) => m.id === existingMarker.id);
          Object.assign(target, { name, faction, description });
        } else {
          map.markers.push({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            x: latlng.lng,
            y: latlng.lat,
            name,
            faction,
            description,
          });
        }
      } else {
        // 小地图标记只有名称
        if (isEdit) {
          const target = map.markers.find((m) => m.id === existingMarker.id);
          target.name = name;
        } else {
          map.markers.push({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            x: latlng.lng,
            y: latlng.lat,
            name,
          });
        }
      }

      saveSettings();
      renderAllMarkers();
      renderAllRoutes(); // 标记所属势力可能变了，路线颜色跟着重绘
      renderMarkerList();
      renderRouteList();
      scheduleMapInfoSync();
      mapState.map.closePopup();
    };
  }
}


export function renderMarkerList() {
  const listEl = document.getElementById("mm-marker-list");
  if (!listEl) return;
  const map = getActiveMap();

  if (map.markers.length === 0) {
    listEl.innerHTML = `<div style="opacity:0.6;font-size:0.85em;padding:6px;">暂无标记</div>`;
    return;
  }

  if (!isBigMapActive()) {
    // 小地图标记列表只需要名称，不做势力分组/颜色区分
    let smallHtml = "";
    map.markers.forEach((m) => {
      smallHtml += `<div class="mm-marker-item" data-id="${m.id}">
                <span class="mm-marker-name">${escapeHtml(m.name)}</span>
            </div>`;
    });
    listEl.innerHTML = smallHtml;
    listEl.querySelectorAll(".mm-marker-item").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.id;
        const marker = getActiveMap().markers.find((m) => m.id === id);
        if (!marker) return;
        mapState.map.setView([marker.y, marker.x], mapState.map.getZoom());
        openMarkerForm(marker);
      });
    });
    return;
  }

  const groups = {};
  map.markers.forEach((m) => {
    if (!groups[m.faction]) groups[m.faction] = [];
    groups[m.faction].push(m);
  });

  let html = "";
  Object.keys(groups).forEach((faction) => {
    const color = colorForFaction(faction);
    html += `<div class="mm-faction-group">
            <div class="mm-faction-group-title"><span class="mm-color-dot" style="background:${color};"></span>${escapeHtml(faction)}</div>`;
    groups[faction].forEach((m) => {
      html += `<div class="mm-marker-item" data-id="${m.id}">
                <span class="mm-color-dot" style="background:${color};"></span>
                <span class="mm-marker-name">${escapeHtml(m.name)}</span>
            </div>`;
    });
    html += `</div>`;
  });
  listEl.innerHTML = html;

  listEl.querySelectorAll(".mm-marker-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      const marker = getActiveMap().markers.find((m) => m.id === id);
      if (!marker) return;
      mapState.map.setView([marker.y, marker.x], mapState.map.getZoom());
      openMarkerForm(marker);
      toggleMobileSidebar(false); // 移动端点完列表项收起抽屉，露出地图上弹出的编辑表单
    });
  });
}
