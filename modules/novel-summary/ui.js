"use strict";

import { getRequestHeaders } from "../../../../../../script.js";
import { getCtx, notify } from "../core.js";
import {
  DynamicSemaphore,
  RateQueue,
  niFetchModelIds,
  createSummaryApiClient,
} from "./lib/api.js";
import {
  splitNovelText,
  tailContext,
  summaryTailSection,
  niIsSupportedNovelFile,
  niExtractNovelText,
} from "./lib/parser.js";
import { saveNovelState, loadNovelState, clearNovelState } from "./lib/novel-idb.js";
import { DEFAULT_SUMMARY_PROMPT } from "./lib/prompts.js";
import { getNovelSummarySettings, isNovelSummaryNavbarVisible, saveNovelSummarySettings, setNovelSummaryNavbarVisible } from "./store.js";

// =====================================================================================
// === 摘要提取（原独立扩展 novel-summary，现合并进剧情助手）：UI + 业务逻辑 ===
// 功能本身完全照搬原插件：上传小说（.txt/.mobi）→ 按设定大小分段 → 逐段调用 AI 压缩为摘要 → 导出 TXT。
// 顶部导航栏图标默认不注入（display:none），只有通过控制面板「摘要提取」按钮的确认弹窗
// 选择"是"之后才会显示；抽屉本身和事件绑定在插件加载时就完成，只是显隐由 CSS 控制，
// 跟地图模块悬浮球（applyFabVisibility）是同一套思路。
// =====================================================================================

// ============================================================
// 运行期状态（不持久化到 extension_settings，持久化到 IndexedDB）
// ============================================================
const S = {
  fileName: "",
  fileSize: 0,
  rawText: "",
  chunkKbUsed: 0,
  chunks: [],
  chunkStatus: [], // 'pending' | 'running' | 'done' | 'error'
  chunkResults: [],
  running: false,
  stopRequested: false,
  abortControllers: new Map(),
  expandedResults: new Set(), // 哪些段的结果被展开，纯 UI 瞬态，不持久化
};

function q(sel) {
  return document.querySelector(sel);
}

// ============================================================
// API 客户端 / 限速 / 并发
// ============================================================
let currentAbortController = null;
const rateQueue = new RateQueue({ getLimit: () => getNovelSummarySettings().apiRateLimit, fallbackLimit: 3 });
// 摘要提取固定为串行处理：一次只发一段、等它跑完（含内部重试）再发下一段，
// 不再支持并发，semaphore 的并发上限恒定为 1。
const semaphore = new DynamicSemaphore(() => 1);
const { callSummaryApi } = createSummaryApiClient({
  getSettings: getNovelSummarySettings,
  rateQueue,
  semaphore,
  getRequestHeaders,
  getCurrentAbortController: () => currentAbortController,
  setCurrentAbortController: (c) => {
    currentAbortController = c;
  },
});

// ============================================================
// 状态持久化（IndexedDB）
// ============================================================
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 500);
}
async function doSave() {
  await saveNovelState({
    fileName: S.fileName,
    fileSize: S.fileSize,
    rawText: S.rawText,
    chunkKbUsed: S.chunkKbUsed,
    chunks: S.chunks,
    chunkStatus: S.chunkStatus,
    chunkResults: S.chunkResults,
  });
}

async function restoreFromDb() {
  const saved = await loadNovelState();
  if (!saved || !Array.isArray(saved.chunks) || !saved.chunks.length) return false;
  S.fileName = saved.fileName || "";
  S.fileSize = saved.fileSize || 0;
  S.rawText = saved.rawText || "";
  S.chunkKbUsed = saved.chunkKbUsed || 0;
  S.chunks = saved.chunks;
  S.chunkStatus = saved.chunkStatus || saved.chunks.map(() => "pending");
  S.chunkResults = saved.chunkResults || saved.chunks.map(() => "");
  return true;
}

// ============================================================
// 文件上传与解析
// ============================================================
function niOnDrop(e) {
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
}

function niOnFile(input) {
  const f = input.files?.[0];
  if (f) handleFile(f);
  input.value = "";
}

async function handleFile(file) {
  if (!niIsSupportedNovelFile(file)) {
    alert("仅支持 .txt / .mobi 文件");
    return;
  }
  if (S.running) {
    alert("正在运行中，请先暂停再更换文件。");
    return;
  }
  if (S.chunks.length && S.chunkStatus.some((s) => s === "done")) {
    const ok = confirm("已有进行中的提取进度，上传新文件会覆盖并清空当前进度，确定继续吗？");
    if (!ok) return;
  }

  try {
    const buf = await file.arrayBuffer();
    const { text } = niExtractNovelText(buf, file.name);
    if (!text || !text.trim()) throw new Error("未能从文件中提取到正文");

    const kb = getCfgKb();

    S.fileName = file.name;
    S.fileSize = file.size;
    S.rawText = text;
    S.chunkKbUsed = kb;
    S.chunks = splitNovelText(text, kb, 0.5);
    S.chunkStatus = S.chunks.map(() => "pending");
    S.chunkResults = S.chunks.map(() => "");
    S.stopRequested = false;
    S.expandedResults.clear();

    await doSave();
    renderAll();
  } catch (e) {
    console.error("[剧情助手/摘要提取] 文件解析失败:", e);
    alert(`文件解析失败：${e.message || e}`);
  }
}

function getCfgKb() {
  return Math.max(10, parseInt(q("#ns-chunk-kb")?.value, 10) || getNovelSummarySettings().chunkKb || 100);
}

// ============================================================
// 渲染
// ============================================================
function renderAll() {
  renderUploadInfo();
  renderChunkList();
  renderProgress();
  renderResult();
  syncRunButtons();
}

function renderUploadInfo() {
  const uz = q("#ns-uz");
  const stats = q("#ns-chunk-stats");
  if (!S.fileName) {
    uz?.classList.remove("loaded");
    if (stats) stats.style.display = "none";
    q("#ns-u-label").textContent = "点击或拖拽上传 .txt / .mobi 文件";
    q("#ns-u-hint").textContent = "单次只处理一本小说，重新上传会覆盖当前进度";
    return;
  }
  uz?.classList.add("loaded");
  q("#ns-u-label").textContent = S.fileName;
  q("#ns-u-hint").textContent = `${Math.round((S.fileSize || 0) / 1024)} KB · 共 ${S.chunks.length} 段（${S.chunkKbUsed} KB/段）`;
  if (stats) stats.style.display = "inline";
  q("#ns-st-chunks").textContent = S.chunks.length;
  q("#ns-st-size").textContent = `${Math.round((S.fileSize || 0) / 1024)} KB`;
  const kbInput = q("#ns-chunk-kb");
  if (kbInput && document.activeElement !== kbInput) kbInput.value = S.chunkKbUsed || 100;
}

function chunkStatStyle(st) {
  return (
    {
      pending: { cls: "ns-cs-w", txt: "待处理" },
      running: { cls: "ns-cs-r", txt: "处理中…" },
      done: { cls: "ns-cs-d", txt: "已完成" },
      error: { cls: "ns-cs-e", txt: "失败" },
    }[st] || { cls: "ns-cs-w", txt: "待处理" }
  );
}

function renderChunkList() {
  const list = q("#ns-chunk-list");
  if (!list) return;
  list.innerHTML = S.chunks
    .map((c, i) => {
      const kb = Math.round(c.length / (0.5 * 1024));
      const st = S.chunkStatus[i] || "pending";
      const { cls, txt } = chunkStatStyle(st);
      return `<div class="ns-chunk-row">
          <span class="ns-chunk-idx">${i + 1}</span>
          <span class="ns-chunk-info">第 ${i + 1} 段 · 约 ${kb} KB</span>
          <span class="ns-chunk-stat ${cls}" id="ns-cs-${i}">${txt}</span>
          <button class="ns-chunk-retry-btn" data-chunk-idx="${i}" title="单独重跑此段"><i class="fa-solid fa-rotate-right"></i></button>
        </div>`;
    })
    .join("");
}

function setChunkStat(i, st) {
  S.chunkStatus[i] = st;
  const el = q(`#ns-cs-${i}`);
  if (el) {
    const { cls, txt } = chunkStatStyle(st);
    el.className = `ns-chunk-stat ${cls}`;
    el.textContent = txt;
  }
  renderProgress();
  if (st === "done") renderResult();
}

function getProgressStats() {
  const total = S.chunks.length;
  let done = 0,
    error = 0;
  S.chunkStatus.forEach((st) => {
    if (st === "done") done++;
    else if (st === "error") error++;
  });
  return { total, done, error };
}

function renderProgress() {
  const { total, done, error } = getProgressStats();
  const wrap = q("#ns-progress-wrap");
  if (!wrap) return;
  if (!total) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "flex";
  const pct = total ? Math.round((done / total) * 100) : 0;
  q("#ns-progress-fill").style.width = `${pct}%`;
  q("#ns-progress-text").textContent = error > 0 ? `${done} / ${total}（${error} 段失败）` : `${done} / ${total}`;
  q("#ns-btn-retry-failed").style.display = error > 0 && !S.running ? "inline-flex" : "none";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderResult() {
  const list = q("#ns-result-list");
  if (!list) return;

  const doneIdx = S.chunkResults.map((text, i) => (S.chunkStatus[i] === "done" && text ? i : -1)).filter((i) => i !== -1);

  if (!doneIdx.length) {
    list.innerHTML = '<div class="ns-result-empty">完成的段落摘要会依次显示在这里…</div>';
    return;
  }

  list.innerHTML = doneIdx
    .map((i) => {
      const text = S.chunkResults[i].trim();
      const preview = text.replace(/\s+/g, " ").slice(0, 40);
      const expanded = S.expandedResults.has(i);
      return `<div class="ns-result-item${expanded ? " expanded" : ""}" data-result-idx="${i}">
          <div class="ns-result-item-header" data-result-toggle="${i}">
            <span class="ns-result-item-toggle"><i class="fa-solid fa-chevron-right"></i></span>
            <span class="ns-result-item-title">第 ${i + 1} 段</span>
            <span class="ns-result-item-preview">${escapeHtml(preview)}</span>
            <button class="ns-result-item-export-btn" data-result-export="${i}" title="导出本段"><i class="fa-solid fa-download"></i></button>
          </div>
          <div class="ns-result-item-body">${escapeHtml(text)}</div>
        </div>`;
    })
    .join("");
}

function syncRunButtons() {
  const runBtn = q("#ns-btn-run");
  const pauseBtn = q("#ns-btn-pause");
  if (!runBtn) return;
  runBtn.disabled = !S.chunks.length || S.running;
  const { total, done } = getProgressStats();
  runBtn.innerHTML = total && done > 0 && done < total ? '<i class="fa-solid fa-play"></i> 继续提取' : '<i class="fa-solid fa-play"></i> 开始提取摘要';
  pauseBtn.style.display = S.running ? "inline-flex" : "none";
}

// ============================================================
// 摘要提取核心流程
// ============================================================
// 生成分段摘要时，找不到"上一段摘要结果"（比如前一段还失败没成功过）时，
// 退回取上一段原文结尾的字符数兜底。
const NI_TAIL_RAW_CHARS_FALLBACK = 800;

// 取当前段（第 i 段）的"衔接参考"：优先用上一段（i-1）已生成的摘要——按摘要自身的
// "## 章节名"标题边界取最后一整块，不按字符数硬切；只有上一段还没有摘要结果时
// （比如重试失败段落，前一段仍未成功过），才退回取上一段原文结尾 800 字兜底。
function getPreviousContext(i) {
  if (i <= 0) return "";
  const prevSummary = S.chunkStatus[i - 1] === "done" ? (S.chunkResults[i - 1] || "").trim() : "";
  if (prevSummary) return summaryTailSection(prevSummary);
  if (S.chunks[i - 1]) return tailContext(S.chunks[i - 1], NI_TAIL_RAW_CHARS_FALLBACK);
  return "";
}

function buildMessages(i) {
  const previousContext = getPreviousContext(i);
  const systemPrompt = getNovelSummarySettings().customPrompt?.trim() || DEFAULT_SUMMARY_PROMPT;
  const userContent = previousContext
    ? `<previous_context>\n${previousContext}\n</previous_context>\n<previous_context>是已处理的上段内容，不要对这部分内容进行分析和摘要处理，仅供时间和角色名参考。\n---\n<chunk_text>\n${S.chunks[i]}\n</chunk_text>\n<chunk_text>为本次需要处理的原文内容。`
    : `<chunk_text>\n${S.chunks[i]}\n</chunk_text>\n<chunk_text>为本次需要处理的原文内容。`;
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

async function processChunk(i) {
  if (S.stopRequested || S.chunkStatus[i] === "done") return;
  setChunkStat(i, "running");
  const messages = buildMessages(i);
  const maxRetry = 2;

  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    if (S.stopRequested) {
      setChunkStat(i, S.chunkStatus[i] === "done" ? "done" : "pending");
      return;
    }
    if (attempt > 1) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    const controller = new AbortController();
    S.abortControllers.set(i, controller);
    try {
      const text = await callSummaryApi(messages, { signal: controller.signal });
      if (!text || !text.trim()) throw new Error("返回内容为空");
      S.chunkResults[i] = text.trim();
      setChunkStat(i, "done");
      scheduleSave();
      return;
    } catch (err) {
      if (S.stopRequested) {
        setChunkStat(i, "pending");
        return;
      }
      console.warn(`[剧情助手/摘要提取] 第 ${i + 1} 段第 ${attempt} 次失败:`, err);
      if (attempt === maxRetry) {
        setChunkStat(i, "error");
        scheduleSave();
        return;
      }
    } finally {
      if (S.abortControllers.get(i) === controller) S.abortControllers.delete(i);
    }
  }
}

async function runQueue(indices) {
  for (const idx of indices) {
    if (S.stopRequested) return;
    await processChunk(idx);
  }
}

async function startRun({ onlyFailed = false } = {}) {
  if (S.running || !S.chunks.length) return;
  S.running = true;
  S.stopRequested = false;
  syncRunButtons();

  const indices = [];
  for (let i = 0; i < S.chunks.length; i++) {
    const st = S.chunkStatus[i];
    if (st === "done") continue;
    if (onlyFailed && st !== "error") continue;
    indices.push(i);
  }
  if (onlyFailed) {
    indices.forEach((i) => setChunkStat(i, "pending"));
  }

  try {
    await runQueue(indices);
  } finally {
    S.running = false;
    S.abortControllers.clear();
    syncRunButtons();
    renderProgress();
    await doSave();
    const { total, done } = getProgressStats();
    if (!S.stopRequested && total > 0 && done === total) {
      notify("success", "全部分段摘要已完成");
    }
  }
}

function pauseRun() {
  if (!S.running) return;
  S.stopRequested = true;
  S.abortControllers.forEach((c) => {
    try {
      c.abort();
    } catch (_) {
      /* 忽略 */
    }
  });
}

async function resetAll() {
  if (S.running) {
    alert("请先暂停当前运行中的任务。");
    return;
  }
  const ok = confirm("确定要清空当前小说与全部提取进度吗？此操作不可撤销。");
  if (!ok) return;
  S.fileName = "";
  S.fileSize = 0;
  S.chunkKbUsed = 0;
  S.chunks = [];
  S.chunkStatus = [];
  S.chunkResults = [];
  S.stopRequested = false;
  S.expandedResults.clear();
  await clearNovelState();
  renderAll();
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportTxt() {
  const text = S.chunkResults
    .map((t, i) => (S.chunkStatus[i] === "done" && t ? t.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  if (!text.trim()) {
    alert("还没有可导出的摘要内容。");
    return;
  }
  const baseName = (S.fileName || "novel").replace(/\.[^.]+$/, "");
  downloadTextFile(text, `${baseName}-摘要.txt`);
}

function exportChunkTxt(i) {
  const text = (S.chunkResults[i] || "").trim();
  if (!text) return;
  downloadTextFile(text, `第${i + 1}段.txt`);
}

// ============================================================
// 设置面板绑定
// ============================================================
function loadSettingsIntoUI() {
  const cfg = getNovelSummarySettings();
  q("#ns-api-url").value = cfg.apiUrl || "";
  q("#ns-api-key").value = cfg.apiKey || "";
  q("#ns-model-input").value = cfg.model || "";
  q("#ns-stream").checked = cfg.stream !== false;
  q("#ns-rpm").value = cfg.apiRateLimit ?? 3;
  q("#ns-prompt").value = cfg.customPrompt?.trim() ? cfg.customPrompt : DEFAULT_SUMMARY_PROMPT;
  if (!S.chunks.length) q("#ns-chunk-kb").value = cfg.chunkKb ?? 100;
}

function bindSettingsInputs() {
  const cfg = getNovelSummarySettings();
  q("#ns-api-url").addEventListener("change", function () {
    cfg.apiUrl = this.value.trim();
    saveNovelSummarySettings();
  });
  q("#ns-api-key").addEventListener("change", function () {
    cfg.apiKey = this.value;
    saveNovelSummarySettings();
  });
  q("#ns-model-input").addEventListener("change", function () {
    cfg.model = this.value.trim();
    saveNovelSummarySettings();
  });
  q("#ns-stream").addEventListener("change", function () {
    cfg.stream = this.checked;
    saveNovelSummarySettings();
  });
  q("#ns-rpm").addEventListener("change", function () {
    cfg.apiRateLimit = Math.max(0, parseInt(this.value, 10) || 0);
    saveNovelSummarySettings();
  });
  q("#ns-prompt").addEventListener("change", function () {
    const val = this.value.trim();
    cfg.customPrompt = val && val !== DEFAULT_SUMMARY_PROMPT.trim() ? val : "";
    saveNovelSummarySettings();
  });
  q("#ns-prompt-reset-btn").addEventListener("click", () => {
    q("#ns-prompt").value = DEFAULT_SUMMARY_PROMPT;
    cfg.customPrompt = "";
    saveNovelSummarySettings();
  });
}

async function handleFetchModels() {
  const cfg = getNovelSummarySettings();
  const url = q("#ns-api-url").value.trim();
  if (!url) {
    alert("请先填写 API 地址");
    return;
  }
  const btn = q("#ns-model-fetch-btn");
  btn.disabled = true;
  btn.textContent = "获取中…";
  try {
    const models = await niFetchModelIds({ url, key: q("#ns-api-key").value.trim(), fetchImpl: fetch });
    if (!models.length) {
      alert("未获取到模型列表");
      return;
    }
    const select = q("#ns-model-select");
    const input = q("#ns-model-input");
    select.innerHTML = ['<option value="" disabled selected>请选择模型</option>'].concat(models.map((m) => `<option value="${m.replace(/"/g, "&quot;")}">${m}</option>`)).join("");
    select.style.display = "";
    input.style.display = "none";
    select.onchange = () => {
      input.value = select.value;
      select.style.display = "none";
      input.style.display = "";
      cfg.model = select.value;
      saveNovelSummarySettings();
    };
  } catch (e) {
    alert(`拉取失败: ${e.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "获取列表";
  }
}

// ============================================================
// 抽屉内容模板（原 template.html，内联为字符串，跟本插件其它弹窗写法保持一致）
// ============================================================
function buildNovelSummaryTemplateHtml() {
  return `
<div id="ns-app" class="ns-app">

  <div class="ns-header">
    <div class="ns-title"><i class="fa-solid fa-book-open"></i> 小说摘要提取</div>
    <div class="ns-sub">上传小说 → AI 分段压缩为摘要 → 导出 TXT</div>
  </div>

  <div class="ns-scroll">

    <div class="ns-section">
      <div id="ns-uz" class="ns-upload-zone">
        <input id="ns-fi" type="file" accept=".txt,.mobi" style="display:none;">
        <i class="fa-solid fa-cloud-arrow-up ns-upload-icon"></i>
        <div id="ns-u-label" class="ns-upload-label">点击或拖拽上传 .txt / .mobi 文件</div>
        <div id="ns-u-hint" class="ns-upload-hint">单次只处理一本小说，重新上传会覆盖当前进度</div>
      </div>
      <div class="ns-chunk-info-row">
        <span id="ns-chunk-stats" style="display:none;"><span id="ns-st-chunks">0</span> 段 · <span id="ns-st-size">0 KB</span></span>
        <label class="ns-inline-label">
          分段大小
          <input id="ns-chunk-kb" type="number" min="10" step="10" value="100" class="ns-num-input"> KB
        </label>
      </div>
    </div>

    <div class="ns-section">
      <button id="ns-settings-btn" class="ns-collapse-btn">
        <i class="fa-solid fa-sliders"></i> API 与提示词设置
        <i class="fa-solid fa-chevron-down ns-collapse-caret"></i>
      </button>
      <div id="ns-settings-panel" class="ns-collapse-panel">

        <div class="ns-field">
          <label>API 地址（chat/completions 兼容端点，未填写时使用当前对话API）</label>
          <input id="ns-api-url" type="text" placeholder="https://api.openai.com/v1/chat/completions">
        </div>

        <div class="ns-field">
          <label>API Key</label>
          <input id="ns-api-key" type="password" placeholder="sk-...">
        </div>

        <div class="ns-field">
          <label>模型</label>
          <div class="ns-model-row">
            <input id="ns-model-input" type="text" placeholder="模型 ID，例如 gpt-4o-mini">
            <select id="ns-model-select" style="display:none;"></select>
            <button id="ns-model-fetch-btn" class="ns-btn ns-btn-sm" title="拉取模型列表">获取列表</button>
          </div>
        </div>

        <div class="ns-field">
          <label>限速（次/分钟，0=不限）</label>
          <input id="ns-rpm" type="number" min="0" value="3" class="ns-num-input">
        </div>

        <div class="ns-field ns-checkbox-field">
          <label><input id="ns-stream" type="checkbox" checked> 使用流式响应</label>
        </div>

        <div class="ns-field">
          <div class="ns-prompt-header">
            <label>摘要提示词（可自定义）</label>
            <button id="ns-prompt-reset-btn" class="ns-btn ns-btn-sm">恢复默认</button>
          </div>
          <textarea id="ns-prompt" class="ns-prompt-textarea" rows="8"></textarea>
        </div>

      </div>
    </div>

    <div class="ns-section">
      <div class="ns-run-row">
        <button id="ns-btn-run" class="ns-btn ns-btn-primary" disabled>
          <i class="fa-solid fa-play"></i> 开始提取摘要
        </button>
        <button id="ns-btn-pause" class="ns-btn" style="display:none;">
          <i class="fa-solid fa-pause"></i> 暂停
        </button>
        <button id="ns-btn-retry-failed" class="ns-btn" style="display:none;">
          <i class="fa-solid fa-rotate-right"></i> 重试失败段
        </button>
        <button id="ns-btn-reset" class="ns-btn ns-btn-danger">
          <i class="fa-solid fa-trash"></i> 清空重来
        </button>
      </div>
      <div id="ns-progress-wrap" class="ns-progress-wrap" style="display:none;">
        <div class="ns-progress-bar"><div id="ns-progress-fill" class="ns-progress-fill"></div></div>
        <div id="ns-progress-text" class="ns-progress-text">0 / 0</div>
      </div>
      <div id="ns-chunk-list" class="ns-chunk-list"></div>
    </div>

    <div class="ns-section">
      <div class="ns-result-header">
        <label>摘要结果（按段展示，点击展开）</label>
        <button id="ns-export-btn" class="ns-btn ns-btn-primary ns-btn-sm">
          <i class="fa-solid fa-download"></i> 导出全部为 TXT
        </button>
      </div>
      <div id="ns-result-list" class="ns-result-list">
        <div class="ns-result-empty">完成的段落摘要会依次显示在这里…</div>
      </div>
    </div>

  </div>
</div>`;
}

// ============================================================
// 挂载 / 显隐控制
// ============================================================

// 根据 navbarVisible 设置切换顶部导航栏图标+抽屉的显隐；只是 display:none/""，
// 不销毁 DOM，跟地图模块悬浮球的 applyFabVisibility 是同一套思路。
export function applyNovelSummaryNavbarVisibility() {
  const $drawer = $("#ns_drawer");
  if (!$drawer.length) return;
  $drawer.css("display", isNovelSummaryNavbarVisible() ? "" : "none");
}

let mounted = false;

// 插件加载时调用一次：始终把抽屉图标+内容注入 DOM（初始显隐直接按当前设置来，
// 避免刷新页面时先闪一下再被隐藏），事件绑定、IndexedDB 进度恢复等也在这里完成。
// 之后「摘要提取」按钮只需要调用 applyNovelSummaryNavbarVisibility() 切换显隐，
// 不需要重新构建 DOM。
export async function initNovelSummaryModule() {
  if (mounted) return;
  mounted = true;

  getNovelSummarySettings();

  const settingsHtml = buildNovelSummaryTemplateHtml();
  const initialDisplay = isNovelSummaryNavbarVisible() ? "" : "none";

  const drawerHtml = `
      <div id="ns_drawer" class="drawer" style="display:${initialDisplay};">
        <div class="drawer-toggle">
          <div id="ns_drawer_icon"
               class="drawer-icon fa-solid fa-book-open fa-fw closedIcon interactable"
               title="小说摘要提取"
               tabindex="0">
          </div>
        </div>
        <div id="ns_drawer_content" class="drawer-content closedDrawer" style="padding:0;">
          ${settingsHtml}
        </div>
      </div>`;

  const extensionsBtn = document.querySelector(".drawer-icon.fa-solid.fa-cubes");
  const extensionsDrawer = extensionsBtn?.closest(".drawer");
  if (extensionsDrawer) {
    extensionsDrawer.before($(drawerHtml)[0]);
  } else {
    $("#extensions-settings-button").after(drawerHtml);
  }

  let _navbarClick = null;
  try {
    const scriptModule = await import("../../../../../../script.js");
    if (scriptModule.doNavbarIconClick) _navbarClick = scriptModule.doNavbarIconClick;
  } catch (_) {
    /* 忽略，走下面的降级实现 */
  }

  const toggle = $("#ns_drawer .drawer-toggle");
  if (typeof _navbarClick === "function") {
    toggle.on("click", _navbarClick);
  } else {
    $("#ns_drawer_content").attr("data-slide-toggle", "hidden").css("display", "none");
    toggle.on("click", function () {
      const icon = $("#ns_drawer_icon");
      const content = $("#ns_drawer_content");
      if (icon.hasClass("closedIcon")) {
        $(".openDrawer").not("#ns_drawer_content").not(".pinnedOpen").removeClass("openDrawer").addClass("closedDrawer").hide();
        $(".openIcon").not("#ns_drawer_icon").not(".drawerPinnedOpen").removeClass("openIcon").addClass("closedIcon");
        icon.removeClass("closedIcon").addClass("openIcon");
        content.removeClass("closedDrawer").addClass("openDrawer").css("display", "");
      } else {
        icon.removeClass("openIcon").addClass("closedIcon");
        content.removeClass("openDrawer").addClass("closedDrawer").css("display", "none");
      }
    });
  }

  const $app = $("#ns-app");

  // 上传
  $app.on("click", "#ns-uz", () => document.getElementById("ns-fi").click());
  $app.on("dragover", "#ns-uz", (e) => e.preventDefault());
  $app.on("drop", "#ns-uz", (e) => {
    e.preventDefault();
    niOnDrop(e.originalEvent);
  });
  $app.on("change", "#ns-fi", function () {
    niOnFile(this);
  });
  $app.on("change", "#ns-chunk-kb", async function () {
    const kb = Math.max(10, parseInt(this.value, 10) || 100);
    this.value = kb;
    getNovelSummarySettings().chunkKb = kb;
    saveNovelSummarySettings();

    if (!S.chunks.length) return;
    if (kb === S.chunkKbUsed) return;
    if (S.running) {
      this.value = S.chunkKbUsed;
      alert("运行中不能调整分段大小，请先暂停。");
      return;
    }
    const hasProgress = S.chunkStatus.some((st) => st === "done" || st === "error");
    if (hasProgress) {
      const ok = confirm("调整分段大小会清空当前所有提取进度，确定继续吗？");
      if (!ok) {
        this.value = S.chunkKbUsed;
        return;
      }
    }
    if (!S.rawText) {
      alert("未找到原始正文，请重新上传文件。");
      this.value = S.chunkKbUsed;
      return;
    }
    S.chunkKbUsed = kb;
    S.chunks = splitNovelText(S.rawText, kb, 0.5);
    S.chunkStatus = S.chunks.map(() => "pending");
    S.chunkResults = S.chunks.map(() => "");
    S.expandedResults.clear();
    await doSave();
    renderAll();
  });

  // 设置折叠面板
  $app.on("click", "#ns-settings-btn", function () {
    $(this).toggleClass("on");
    $("#ns-settings-panel").toggleClass("on");
  });

  // 运行控制
  $app.on("click", "#ns-btn-run", () => startRun());
  $app.on("click", "#ns-btn-pause", () => pauseRun());
  $app.on("click", "#ns-btn-retry-failed", () => startRun({ onlyFailed: true }));
  $app.on("click", "#ns-btn-reset", () => resetAll());
  $app.on("click", ".ns-chunk-retry-btn", function () {
    if (S.running) {
      alert("运行中不能单独重跑分段，请先暂停。");
      return;
    }
    const i = parseInt(this.dataset.chunkIdx, 10);
    if (Number.isNaN(i)) return;
    setChunkStat(i, "pending");
    startRun();
  });

  // 模型列表 & 提示词
  $app.on("click", "#ns-model-fetch-btn", () => handleFetchModels());

  // 导出
  $app.on("click", "#ns-export-btn", () => exportTxt());

  // 结果区：点击段标题展开/折叠，点击下载图标单独导出该段
  $app.on("click", ".ns-result-item-header", function (e) {
    if (e.target.closest(".ns-result-item-export-btn")) return;
    const idx = parseInt(this.dataset.resultToggle, 10);
    if (Number.isNaN(idx)) return;
    if (S.expandedResults.has(idx)) S.expandedResults.delete(idx);
    else S.expandedResults.add(idx);
    this.closest(".ns-result-item")?.classList.toggle("expanded");
  });
  $app.on("click", ".ns-result-item-export-btn", function (e) {
    e.stopPropagation();
    const idx = parseInt(this.dataset.resultExport, 10);
    if (!Number.isNaN(idx)) exportChunkTxt(idx);
  });

  loadSettingsIntoUI();
  bindSettingsInputs();

  await restoreFromDb();
  renderAll();
}

// ============================================================
// 控制面板「摘要提取」按钮：确认弹窗
// ============================================================
// 复用 confirmAction 同款原生弹窗（context.callGenericPopup），按钮文案换成"是/否"。
// 无论选哪个，原生弹窗都会自己关闭；这里只负责写入设置 + 切换导航栏图标显隐。
// 是否关闭剧情助手控制面板本身，由调用方（panel.js）在 await 之后处理。
export async function openNovelSummaryNavbarToggleDialog() {
  const context = getCtx();
  const result = await context.callGenericPopup(
    "是否在顶部导航栏增加「小说摘要提取」功能？",
    context.POPUP_TYPE.CONFIRM,
    "",
    {
      okButton: "是",
      cancelButton: "否",
    },
  );
  const enable = result === context.POPUP_RESULT.AFFIRMATIVE;
  setNovelSummaryNavbarVisible(enable);
  applyNovelSummaryNavbarVisibility();
  notify("success", enable ? "已在顶部导航栏显示「小说摘要提取」入口" : "已隐藏顶部导航栏「小说摘要提取」入口");
}
