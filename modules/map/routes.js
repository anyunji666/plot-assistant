"use strict";

import { COMPASS_NAMES, colorForFaction, escapeHtml, getActiveMap, isBigMapActive, mapState, saveSettings, scheduleMapInfoSync } from "./data.js";
import { toggleMobileSidebar } from "./ui.js";


// ============================================================
// 路线（势力行动，仅大地图支持；小地图没有路线概念）
// ============================================================

export function startRouteMode() {
  if (!isBigMapActive()) {
    toastr?.warning?.(
      "路线功能仅支持大地图，小地图请用左侧的空间布局说明来描述位置关系",
    );
    return;
  }
  if (!mapState.imageOverlay) {
    toastr?.warning?.("请先上传地图图片");
    return;
  }
  const map = getActiveMap();
  if (map.markers.length < 2) {
    toastr?.warning?.("至少需要两个标记点才能添加路线");
    return;
  }
  mapState.routeMode = true;
  mapState.routeFromId = null;
  mapState.routeFollowUp = null;
  document.getElementById("mm-add-route-btn")?.classList.add("mm-active");
  showRouteHint("请点击【出发点】标记");
}


// 从"标记详情"弹窗里直接发起路线：当前这个标记默认作为出发点，
// 跳过"先点顶部添加路线按钮、再重新点一次这个标记"的两步操作，
// 提示语直接进入"请点击目标点"状态。
export function beginRouteFromMarker(marker) {
  if (!isBigMapActive()) {
    toastr?.warning?.("路线功能仅支持大地图");
    return;
  }
  if (!mapState.imageOverlay) {
    toastr?.warning?.("请先上传地图图片");
    return;
  }
  const map = getActiveMap();
  if (map.markers.length < 2) {
    toastr?.warning?.("至少需要两个标记点才能添加路线");
    return;
  }
  mapState.routeMode = true;
  mapState.routeFromId = marker.id;
  mapState.routeFollowUp = null;
  document.getElementById("mm-add-route-btn")?.classList.add("mm-active");
  showRouteHint(`出发点：${marker.name}，请点击【目标点】标记`);
}


// 从"路线操作"弹层里点【后续行动】：把这条路线的终点作为下一段的出发点，
// 并把队伍信息、（上一段的）预计到达时间记下来，等表单打开时预填进去。
export function beginFollowUpRoute(route, fromMarker) {
  if (!isBigMapActive()) return;
  const map = getActiveMap();
  if (map.markers.length < 2) {
    toastr?.warning?.("至少需要两个标记点才能添加路线");
    return;
  }
  mapState.routeMode = true;
  mapState.routeFromId = fromMarker.id;
  mapState.routeFollowUp = { party: route.party || "", departTime: route.arriveTime || "" };
  document.getElementById("mm-add-route-btn")?.classList.add("mm-active");
  showRouteHint(`${route.party || "该队伍"} 的后续行动，出发点：${fromMarker.name}，请点击【目标点】标记`);
}


export function cancelRouteMode() {
  mapState.routeMode = false;
  mapState.routeFromId = null;
  mapState.routeFollowUp = null;
  document.getElementById("mm-add-route-btn")?.classList.remove("mm-active");
  hideRouteHint();
}


export function showRouteHint(text) {
  const textEl = document.getElementById("mm-route-hint-text");
  if (textEl) textEl.textContent = text;
  document.getElementById("mm-route-hint")?.classList.remove("mm-hidden");
}


export function hideRouteHint() {
  document.getElementById("mm-route-hint")?.classList.add("mm-hidden");
}


export function handleRoutePointClick(marker) {
  if (!mapState.routeFromId) {
    mapState.routeFromId = marker.id;
    showRouteHint(`出发点：${marker.name}，请点击【目标点】标记`);
    return;
  }
  if (marker.id === mapState.routeFromId) {
    toastr?.warning?.("出发点和目标点不能是同一个标记，请重新点击目标点");
    return;
  }
  const map = getActiveMap();
  const fromMarker = map.markers.find((m) => m.id === mapState.routeFromId);
  const toMarker = marker;
  const pendingFollowUp = mapState.routeFollowUp; // cancelRouteMode 会清空这个字段，先存一下
  cancelRouteMode(); // 先退出选点模式，再弹表单，避免表单里点地图触发选点逻辑
  mapState.routeFollowUp = pendingFollowUp;
  openRouteForm(fromMarker, toMarker);
}


// 用"当前缩放级别下的屏幕像素坐标"算方位角——
// 用 map.project()/unproject()（带上当前 zoom）保证和屏幕上实际看到的方向一致，
// 不同缩放级别下结果也不会跑偏。
export function computeScreenVector(from, to) {
  const L = window.L;
  const zoom = mapState.map.getZoom();
  const p1 = mapState.map.project(L.latLng(from.y, from.x), zoom);
  const p2 = mapState.map.project(L.latLng(to.y, to.x), zoom);
  return { dx: p2.x - p1.x, dy: p2.y - p1.y };
}


// 箭身连线用的角度：0° = 指向右侧（东），顺时针为正（用于 CSS rotate）
export function computeRouteAngle(from, to) {
  const { dx, dy } = computeScreenVector(from, to);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}


// 军事罗盘方位：0° = 正北，顺时针增大（用于生成"东南方"这类文字）
export function computeBearingText(from, to) {
  const { dx, dy } = computeScreenVector(from, to);
  let bearing = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (bearing < 0) bearing += 360;
  const idx = Math.round(bearing / 45) % 8;
  return COMPASS_NAMES[idx];
}


// 在连线上、离终点 backOffsetPx（当前缩放级别下的屏幕像素）处取一点，
// 用于放路线终点箭头三角形，让它和终点的标记圆点保持一段距离，不贴在一起。
// 因为是按屏幕像素算的，缩放变化后需要重新渲染（见 initMap 里的 zoomend 监听）。
export function pointAlongLine(from, to, backOffsetPx) {
  const L = window.L;
  const zoom = mapState.map.getZoom();
  const p1 = mapState.map.project(L.latLng(from.y, from.x), zoom);
  const p2 = mapState.map.project(L.latLng(to.y, to.x), zoom);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const ratio = Math.max(0, (dist - backOffsetPx) / dist);
  const px = p1.x + dx * ratio;
  const py = p1.y + dy * ratio;
  return mapState.map.unproject(L.point(px, py), zoom);
}


// ============================================================
// 同起点→终点的多条路线：第一条(curveIndex=0)保持直线，
// 后面依次错开画成曲线，避免重叠在一起分不清、点不到。
// ============================================================

const CURVE_SEGMENTS = 24; // 曲线采样点数，越大越平滑

// 第 curveIndex 条（1起）曲线的法向偏移量（像素）：交替左右两侧，幅度随缩放/距离自适应
function curveOffsetPx(curveIndex, distancePx) {
  const step = Math.max(30, distancePx * 0.18);
  const magnitude = step * Math.ceil(curveIndex / 2);
  const side = curveIndex % 2 === 1 ? 1 : -1;
  return magnitude * side;
}


// 计算一条二次贝塞尔曲线的屏幕像素采样点：控制点 = 起终点中点，沿垂直方向偏移 offsetPx
function computeCurveScreenPoints(from, to, offsetPx) {
  const L = window.L;
  const zoom = mapState.map.getZoom();
  const p1 = mapState.map.project(L.latLng(from.y, from.x), zoom);
  const p2 = mapState.map.project(L.latLng(to.y, to.x), zoom);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / dist;
  const ny = dx / dist;
  const control = {
    x: (p1.x + p2.x) / 2 + nx * offsetPx,
    y: (p1.y + p2.y) / 2 + ny * offsetPx,
  };

  const points = [];
  for (let i = 0; i <= CURVE_SEGMENTS; i++) {
    const t = i / CURVE_SEGMENTS;
    const mt = 1 - t;
    points.push({
      x: mt * mt * p1.x + 2 * mt * t * control.x + t * t * p2.x,
      y: mt * mt * p1.y + 2 * mt * t * control.y + t * t * p2.y,
    });
  }
  return points;
}


// 从曲线终点往回走 backOffsetPx（屏幕像素），找到箭头该停靠的点、该处切线角度，
// 以及"保留到这个点为止"的采样点截断下标（用于画线身，不让线穿到箭头前面）
function pointAndAngleAlongScreenPoints(points, backOffsetPx) {
  let remaining = backOffsetPx;
  for (let i = points.length - 1; i > 0; i--) {
    const a = points[i];
    const b = points[i - 1];
    const segDx = a.x - b.x;
    const segDy = a.y - b.y;
    const segLen = Math.sqrt(segDx * segDx + segDy * segDy) || 0.0001;
    if (remaining <= segLen) {
      const ratio = remaining / segLen;
      const point = { x: a.x - segDx * ratio, y: a.y - segDy * ratio };
      const angle = (Math.atan2(segDy, segDx) * 180) / Math.PI;
      return { point, angle, cutIndex: i };
    }
    remaining -= segLen;
  }
  // 曲线总长比 backOffsetPx 还短（极短路线），退化到起点附近
  const first = points[0];
  const second = points[1] || points[0];
  const angle = (Math.atan2(second.y - first.y, second.x - first.x) * 180) / Math.PI;
  return { point: first, angle, cutIndex: 1 };
}


export function openRouteForm(fromMarker, toMarker) {
  const L = window.L;
  const defaultBearing = computeBearingText(fromMarker, toMarker);

  // 一次性预填数据：来自"后续行动"，队伍信息、上一段的到达时间直接带过来（读完即清空，不影响下一次）
  const followUp = mapState.routeFollowUp;
  mapState.routeFollowUp = null;
  const defaultParty = followUp?.party || "";
  const defaultDepart = followUp?.departTime || "";

  const formHtml = `
        <div class="mm-form-popup mm-route-form">
            <div class="mm-route-form-title">${escapeHtml(fromMarker.name)} → ${escapeHtml(toMarker.name)}</div>
            <label>目标相对方位</label>
            <input type="text" id="mm-r-bearing" value="${escapeHtml(defaultBearing)}" placeholder="例如：东南方">
            <label>距离（可留空）</label>
            <input type="text" id="mm-r-distance" placeholder="例如：20公里">
            <label>队伍信息 *</label>
            <input type="text" id="mm-r-party" value="${escapeHtml(defaultParty)}" placeholder="例如：黑风小队200人">
            <label>预计出发时间（可留空）</label>
            <input type="text" id="mm-r-depart" value="${escapeHtml(defaultDepart)}" placeholder="例如：七月十五日卯时">
            <label>预计到达时间 *</label>
            <input type="text" id="mm-r-arrive" placeholder="例如：七月十五日酉时">
            <div class="mm-form-actions">
                <button id="mm-r-cancel">取消</button>
                <button id="mm-r-save">保存</button>
            </div>
        </div>`;

  mapState.pendingFormContext = { type: "route", fromMarker, toMarker };

  // 同上：限制最大高度，内容过长时弹层内部出滚动条，而不是溢出屏幕外划不到。
  const mapH2 = mapState.map.getContainer().clientHeight || window.innerHeight;
  L.popup({
    closeButton: false,
    minWidth: 260,
    autoPan: true,
    maxHeight: Math.round(mapH2 * 0.7),
  })
    .setLatLng([toMarker.y, toMarker.x])
    .setContent(formHtml)
    .openOn(mapState.map);
}


export function bindRouteFormEvents(root, ctx) {
  const { fromMarker, toMarker } = ctx;

  const cancelBtn = root.querySelector("#mm-r-cancel");
  const saveBtn = root.querySelector("#mm-r-save");

  if (cancelBtn) {
    cancelBtn.onclick = () => mapState.map.closePopup();
  }

  if (saveBtn) {
    saveBtn.onclick = () => {
      const bearing = root.querySelector("#mm-r-bearing").value.trim();
      const distance = root.querySelector("#mm-r-distance").value.trim();
      const party = root.querySelector("#mm-r-party").value.trim();
      const departTime = root.querySelector("#mm-r-depart").value.trim();
      const arriveTime = root.querySelector("#mm-r-arrive").value.trim();

      if (!party) {
        toastr?.warning?.("请填写队伍信息");
        return;
      }
      if (!arriveTime) {
        toastr?.warning?.("请填写预计到达时间");
        return;
      }

      const map = getActiveMap();
      if (!Array.isArray(map.routes)) map.routes = [];
      map.routes.push({
        id: `route_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        fromId: fromMarker.id,
        toId: toMarker.id,
        bearing,
        distance,
        party,
        departTime,
        arriveTime,
      });
      saveSettings();
      renderAllRoutes();
      renderRouteList();
      scheduleMapInfoSync();
      toastr?.success?.("路线已添加");
      mapState.map.closePopup();
    };
  }
}


export function renderAllRoutes() {
  if (!mapState.routesLayer) return;
  mapState.routesLayer.clearLayers();
  if (!isBigMapActive()) return; // 小地图没有路线概念
  const map = getActiveMap();
  const markerById = Object.fromEntries(map.markers.map((m) => [m.id, m]));

  // 同一起点→终点可能有多条路线（不同队伍）：第一条画直线，
  // 后面的按出现顺序编号，画成左右交替的曲线，避免完全重叠。
  const groupSeen = {};
  (map.routes || []).forEach((r) => {
    const from = markerById[r.fromId];
    const to = markerById[r.toId];
    if (!from || !to) return; // 引用的标记已被删除，忽略（不渲染，也不在这里清理数据）
    const key = `${r.fromId}__${r.toId}`;
    const curveIndex = groupSeen[key] || 0;
    groupSeen[key] = curveIndex + 1;
    addLeafletRoute(r, from, to, curveIndex);
  });
}


export function addLeafletRoute(route, from, to, curveIndex = 0) {
  const L = window.L;
  const color = colorForFaction(from.faction); // 颜色跟随出发点标记的所属势力
  const tooltipText = `${from.name} → ${to.name}`;

  let latlngs;
  let headLatLng;
  let angle;

  if (curveIndex === 0) {
    // 该起终点组的第一条：保持原来的直线画法
    headLatLng = pointAlongLine(from, to, 22);
    angle = computeRouteAngle(from, to);
    latlngs = [
      [from.y, from.x],
      [headLatLng.lat, headLatLng.lng],
    ];
  } else {
    // 同组后续路线：错开画成曲线，避免和前面的线重叠
    const zoom = mapState.map.getZoom();
    const { dx, dy } = computeScreenVector(from, to);
    const distPx = Math.sqrt(dx * dx + dy * dy) || 1;
    const offsetPx = curveOffsetPx(curveIndex, distPx);
    const screenPoints = computeCurveScreenPoints(from, to, offsetPx);
    const { point: headPoint, angle: headAngle, cutIndex } = pointAndAngleAlongScreenPoints(screenPoints, 22);
    const trimmedPoints = screenPoints.slice(0, cutIndex).concat([headPoint]);
    latlngs = trimmedPoints.map((p) => {
      const ll = mapState.map.unproject(L.point(p.x, p.y), zoom);
      return [ll.lat, ll.lng];
    });
    headLatLng = mapState.map.unproject(L.point(headPoint.x, headPoint.y), zoom);
    angle = headAngle;
  }

  const line = L.polyline(latlngs, {
    color,
    weight: 3,
    opacity: 0.85,
  }).addTo(mapState.routesLayer);
  line.bindTooltip(tooltipText, { sticky: true });

  const headIcon = L.divIcon({
    className: "mm-routehead-icon",
    html: `<svg viewBox="0 0 24 24" width="22" height="22" style="transform:rotate(${angle}deg);">
                 <polygon points="2,4 21,12 2,20" fill="${color}"></polygon>
               </svg>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
  const head = L.marker(headLatLng, {
    icon: headIcon,
    interactive: true,
  }).addTo(mapState.routesLayer);
  head.bindTooltip(tooltipText, { sticky: true });

  const onRouteClick = (e) => {
    L.DomEvent.stopPropagation(e);
    openRouteActionsPopup(route, from, to);
  };
  line.on("click", onRouteClick);
  head.on("click", onRouteClick);
}


// 点击路线弹出的操作层：后续行动 / 删除路线（删除不做二次确认）
export function openRouteActionsPopup(route, from, to) {
  const L = window.L;
  const tooltipText = `${from.name} → ${to.name}`;

  const html = `
        <div class="mm-form-popup mm-route-actions">
            <div class="mm-route-form-title">${escapeHtml(tooltipText)}</div>
            ${route.party ? `<div class="mm-route-actions-party">${escapeHtml(route.party)}</div>` : ""}
            <div class="mm-form-actions">
                <button id="mm-ra-delete" class="mm-danger">删除路线</button>
                <button id="mm-ra-followup">后续行动</button>
            </div>
        </div>`;

  mapState.pendingFormContext = { type: "route-actions", route, from, to };

  L.popup({
    closeButton: false,
    minWidth: 200,
    autoPan: true,
  })
    .setLatLng([to.y, to.x])
    .setContent(html)
    .openOn(mapState.map);
}


export function bindRouteActionsEvents(root, ctx) {
  const { route, to } = ctx;

  const deleteBtn = root.querySelector("#mm-ra-delete");
  const followUpBtn = root.querySelector("#mm-ra-followup");

  if (deleteBtn) {
    deleteBtn.onclick = () => {
      mapState.map.closePopup();
      deleteRoute(route.id);
    };
  }

  if (followUpBtn) {
    followUpBtn.onclick = () => {
      mapState.map.closePopup();
      beginFollowUpRoute(route, to);
    };
  }
}


export function deleteRoute(routeId) {
  const map = getActiveMap();
  if (!Array.isArray(map.routes)) return;
  map.routes = map.routes.filter((r) => r.id !== routeId);
  saveSettings();
  renderAllRoutes();
  renderRouteList();
  scheduleMapInfoSync();
}


export function renderRouteList() {
  const listEl = document.getElementById("mm-route-list");
  if (!listEl) return;

  if (!isBigMapActive()) {
    listEl.innerHTML = "";
    return;
  }

  const map = getActiveMap();
  const markerById = Object.fromEntries(map.markers.map((m) => [m.id, m]));
  const validRoutes = (map.routes || []).filter(
    (r) => markerById[r.fromId] && markerById[r.toId],
  );

  if (validRoutes.length === 0) {
    listEl.innerHTML = `<div style="opacity:0.6;font-size:0.85em;padding:6px;">暂无路线</div>`;
    return;
  }

  let html = "";
  validRoutes.forEach((r) => {
    const from = markerById[r.fromId];
    const to = markerById[r.toId];
    const color = colorForFaction(from.faction);
    const subLabel = [r.party, r.arriveTime && `预计${r.arriveTime}到达`]
      .filter(Boolean)
      .join(" · ");
    html += `<div class="mm-route-item" data-id="${r.id}">
            <span class="mm-color-dot" style="background:${color};"></span>
            <div class="mm-route-item-text">
                <span class="mm-route-label">${escapeHtml(from.name)} → ${escapeHtml(to.name)}</span>
                ${subLabel ? `<span class="mm-route-sublabel">${escapeHtml(subLabel)}</span>` : ""}
            </div>
            <button class="mm-route-del" data-id="${r.id}" title="删除">✕</button>
        </div>`;
  });
  listEl.innerHTML = html;

  listEl.querySelectorAll(".mm-route-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteRoute(btn.dataset.id);
    });
  });
  listEl.querySelectorAll(".mm-route-item").forEach((el) => {
    el.addEventListener("click", () => {
      const r = (getActiveMap().routes || []).find(
        (x) => x.id === el.dataset.id,
      );
      if (!r) return;
      const from = markerById[r.fromId];
      if (from) mapState.map.setView([from.y, from.x], mapState.map.getZoom());
      toggleMobileSidebar(false);
    });
  });
}
