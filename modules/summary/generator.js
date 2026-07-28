"use strict";

import { AUTO_BATCH_SIZE, GENERATING_OVERLAY_ID, GENERATION_TIMEOUT, LARGE_SUMMARY_TITLE, SMALL_SUMMARY_ENTRY_DEFAULTS, SMALL_SUMMARY_TITLE_PREFIX, STATUS_TABLE_ENTRY_DEFAULTS, STATUS_TABLE_TITLE, STEP_DELAY, SummaryStopRequestedError, confirmAction, delay, errorCatched, getCtx, getOffsetRecord, notify, setOffsetRecord } from "../core.js";
import { buildFloorRestoreInstruction, buildFloorRestoreUserContent, buildLargeSummaryInstruction, buildMessagesText, convertInventorySnapshotToHardset, extractLabelLine, extractYearMonthKeyword, findNearestAnchorFloor, getLastMessageId, getMaxSummaryEnd, getSummaryProgress, handleMessageForStatusTable, parseFloorSummaryFields, parseLargeSummaryBlock, parseRestoredFloorFields, parseSummaryContent, serializeStatusTableContent } from "./parser.js";
import { getCurrentCharacterName, getLorebookEntriesArray, getOrCreateSummaryLorebook, isSummaryLorebookGloballyEnabled, saveOrOverwriteLorebookEntry } from "../worldinfo.js";


export async function buildRangeSummaryContent(batchStart, batchEnd, overlayOptions) {
  const chat = getCtx().chat;
  const floorInfos = [];
  for (let i = batchStart; i <= batchEnd; i++) {
    const message = chat[i];
    // 用户楼层永远不会有摘要模块，也不需要摘要：不参与"extract/ai"类型判定和分段，
    // 否则会把本该连续的一段AI楼层被中间穿插的用户发言切成很多段，导致每个用户楼层都被
    // 误当成"缺失摘要"单独触发一次AI还原调用（既浪费又慢，还会拖慢"停止总结"的响应）。
    // 用户楼层原文仍会通过 buildMessagesText 按下标范围被带入AI上下文，只是不再单独成段。
    if (!message || message.is_user) continue;
    floorInfos.push({ idx: i, parsed: parseFloorSummaryFields(message.mes) });
  }

  const runs = [];
  let currentRun = null;
  floorInfos.forEach((info) => {
    const type = info.parsed ? "extract" : "ai";
    if (!currentRun || currentRun.type !== type) {
      currentRun = { type, start: info.idx, end: info.idx, floors: [info] };
      runs.push(currentRun);
    } else {
      currentRun.end = info.idx;
      currentRun.floors.push(info);
    }
  });

  // 统一收集整个batch里每一层楼的 time/location/overview——有摘要模块的楼层直接读原文字段，
  // 没有摘要模块的楼层调用AI逐层还原补齐（见 buildFloorRestoreInstruction）；补齐后两种来源结构完全一致，
  // 后面用同一套逻辑合并成最终内容和关键词，不用再分 extract/ai 两条不同密度的拼装路径。
  const unifiedFloors = [];
  for (const run of runs) {
    if (run.type === "extract") {
      run.floors.forEach((f) => {
        unifiedFloors.push({
          idx: f.idx,
          time: f.parsed.time,
          location: f.parsed.location,
          overview: f.parsed.overview,
        });
      });
    } else {
      // 发起下一次AI调用前先检查是否已请求停止：避免"停止总结"点击后，
      // 剩余还未开始的还原调用还继续排队执行完才停下来。
      if (
        overlayOptions &&
        typeof overlayOptions.isStopRequested === "function" &&
        overlayOptions.isStopRequested()
      ) {
        throw new SummaryStopRequestedError();
      }

      const targetFloorIndices = run.floors.map((f) => f.idx);
      notify(
        "info",
        `第${run.start}-${run.end}楼区间内有${targetFloorIndices.length}层AI楼层未输出摘要模块，正在调用AI逐层还原这些楼层的摘要字段...`,
      );
      const messagesText = await buildMessagesText(run.start, run.end);
      if (!messagesText) continue;
      const systemPrompt = buildFloorRestoreInstruction();
      // 锚点扫描不受当前批次边界限制，直接在完整 chat 数组里向前/向后找最近的已知摘要楼层，
      // 避免"缺失段恰好卡在批次开头/结尾"导致本该有的锚点被批次边界截断。
      const prevAnchor = findNearestAnchorFloor(chat, run.start - 1, -1);
      const nextAnchor = findNearestAnchorFloor(chat, run.end + 1, 1);
      const userContent = buildFloorRestoreUserContent(
        run.start,
        run.end,
        messagesText,
        targetFloorIndices,
        { prev: prevAnchor, next: nextAnchor },
      );
      const rawResult = await generateSummaryWithOverlay(
        systemPrompt,
        userContent,
        overlayOptions,
      );
      const summaryContent = parseSummaryContent(rawResult);
      if (!summaryContent) {
        throw new Error(
          `第${run.start}-${run.end}楼 AI回复中未找到有效的 <summary> 标签内容。`,
        );
      }
      const restoredMap = parseRestoredFloorFields(summaryContent);
      run.floors.forEach((f) => {
        const restored = restoredMap.get(f.idx);
        if (!restored) {
          console.warn(
            `[剧情助手] 第${f.idx}楼在AI还原结果中未找到对应区块，该层按空字段处理。`,
          );
        }
        unifiedFloors.push({
          idx: f.idx,
          time: restored ? restored.time : "",
          location: restored ? restored.location : "",
          overview: restored ? restored.overview : "",
        });
      });
    }
  }

  const times = unifiedFloors.map((f) => f.time).filter(Boolean);
  const timeLabel = times.length
    ? times[0] === times[times.length - 1]
      ? times[0]
      : `${times[0]} ~ ${times[times.length - 1]}`
    : "未知";
  // 地点取整个batch内最后一个非空 Location（即这段区间结束时所在的场景）。
  const locations = unifiedFloors.map((f) => f.location).filter(Boolean);
  const locationLabel = locations.length
    ? locations[locations.length - 1]
    : "未知";
  const bullets = unifiedFloors
    .filter((f) => f.overview)
    .map((f) => `- [第${f.idx}楼] ${f.overview}`);

  const content = `时间：${timeLabel}\n地点：${locationLabel}\n关键事件：\n${bullets.length ? bullets.join("\n") : "（本段无实质推进）"}`;

  // 关键词取整个batch内第一个带 Time 的楼层，只取"年月"粒度；整批都没有可用 Time 时关键词留空。
  const firstTimedFloor = unifiedFloors.find((f) => f.time);
  const rangeKeyword = firstTimedFloor
    ? extractYearMonthKeyword(firstTimedFloor.time)
    : "";

  return { content, keyword: rangeKeyword };
}


// === Helper: 调用原生 generateRaw 生成总结（不进入聊天上下文，跟随当前连接配置） ===
export async function generateSummaryRaw(systemPrompt, userContent) {
  const context = getCtx();
  if (typeof context.generateRaw !== "function") {
    throw new Error(
      "当前酒馆版本不支持 context.generateRaw，请更新 SillyTavern 到较新版本。",
    );
  }

  const generationPromise = context.generateRaw({
    prompt: [{ role: "user", content: userContent }],
    systemPrompt,
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("生成超时")), GENERATION_TIMEOUT);
  });

  const result = await Promise.race([generationPromise, timeoutPromise]);

  if (typeof result === "string") return result;
  if (result && typeof result.content === "string") return result.content; // 兼容极端情况下的对象返回
  throw new Error("生成返回了无法识别的结果类型。");
}


// === Helper: "生成中"提示框（居中弹窗，半透明遮罩+卡片，带加载动画） ===
// 与批次相关的 toastr 进度提示（如"正在总结第X楼..."）相互独立，互不干扰、并存显示。
// options.showStopButton: 是否显示"停止总结"按钮（仅批量循环类功能需要）；
// options.onStop: 点击停止按钮时的回调（会设置调用方内部的停止标志位，当前批次仍会正常跑完并保存）；
// options.statusText: 覆盖默认的提示文字。
export function showGeneratingOverlay(options) {
  const {
    showStopButton = false,
    onStop = null,
    statusText = "正在生成总结，请稍候...",
  } = options || {};
  try {
    if ($(`#${GENERATING_OVERLAY_ID}`).length > 0) return; // 已存在则不重复创建

    if ($(`#${GENERATING_OVERLAY_ID}-style`).length === 0) {
      const styleElement = document.createElement("style");
      styleElement.id = `${GENERATING_OVERLAY_ID}-style`;
      styleElement.textContent = `
        @keyframes summaryAssistantSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes summaryAssistantFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;
      document.head.appendChild(styleElement);
    }

    const $overlay = $("<div></div>").attr("id", GENERATING_OVERLAY_ID).css({
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0, 0, 0, 0.5)",
      backdropFilter: "blur(2px)",
      zIndex: 10000,
      animation: "summaryAssistantFadeIn 0.15s ease-out",
    });

    // 与「剧情助手控制面板」「对话前强调」弹窗保持一致：固定锚定在屏幕顶部附近，而不是用 flex 居中。
    // 居中方案在移动端地址栏/工具栏收缩、或弹出虚拟键盘时，vh 不会随可视视口实时更新，
    // 会导致卡片被顶部裁掉、错位；顶部锚定 + dvh 可以避免这个问题。
    const $card = $("<div></div>").css({
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      width: "min(320px, calc(100% - 24px))",
      maxHeight: "min(85vh, calc(100dvh - 24px))",
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
      background: "#262626",
      color: "#e0e0e0",
      borderRadius: "8px",
      boxShadow: "0 15px 30px rgba(0, 0, 0, 0.6)",
      padding: "24px 32px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "14px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "14px",
      boxSizing: "border-box",
    });

    const $spinner = $("<div></div>").css({
      width: "32px",
      height: "32px",
      border: "3px solid #444",
      borderTopColor: "#3a7bd5",
      borderRadius: "50%",
      animation: "summaryAssistantSpin 0.8s linear infinite",
    });

    const $text = $("<div></div>").text(statusText);

    $card.append($spinner).append($text);

    if (showStopButton) {
      const $stopButton = $("<button></button>")
        .attr("id", `${GENERATING_OVERLAY_ID}-stop`)
        .text("停止总结")
        .css({
          background: "#d53a3a",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          fontSize: "12px",
          padding: "6px 14px",
          borderRadius: "4px",
          marginTop: "4px",
          transition: "background-color 0.2s",
        })
        .on("click", function () {
          $(this)
            .prop("disabled", true)
            .css("cursor", "default")
            .css("opacity", 0.6)
            .text("已请求停止，当前批次完成后停止...");
          if (typeof onStop === "function") onStop();
        })
        .hover(
          function () {
            if (!$(this).prop("disabled")) $(this).css("background", "#b32e2e");
          },
          function () {
            if (!$(this).prop("disabled")) $(this).css("background", "#d53a3a");
          },
        );
      $card.append($stopButton);
    }

    $overlay.append($card);
    $("body").append($overlay);
  } catch (error) {
    console.error("[剧情助手] 显示生成中提示框时出错:", error);
  }
}


export function closeGeneratingOverlay() {
  try {
    $(`#${GENERATING_OVERLAY_ID}`).remove();
  } catch (error) {
    console.error("[剧情助手] 关闭生成中提示框时出错:", error);
  }
}


// === Helper: 带"生成中"提示框的生成封装（DRY：多处调用统一走这里，成功/失败都会自动关闭提示框） ===
export async function generateSummaryWithOverlay(
  systemPrompt,
  userContent,
  overlayOptions,
) {
  showGeneratingOverlay(overlayOptions);
  try {
    return await generateSummaryRaw(systemPrompt, userContent);
  } finally {
    closeGeneratingOverlay();
  }
}


// =====================================================================================
// === Function: 自动小总结 ===
// 从世界书中已有进度自动往后按批总结，直至覆盖全部楼层。
// 如果本对话通过"设定起始楼层"设置过起始楼层，会自动按该起始楼层偏移写入世界书的楼层编号
// （读取原始聊天记录仍然用本地楼层号，只有世界书条目标题里的楼层号会加上起始楼层）；
// 没设置过则起始楼层视为 0，行为等同于楼层号不偏移。
// =====================================================================================
export const runAutoSmallSummary = errorCatched(async () => {
  const proceed = await confirmAction(
    "自动小总结",
    "将从世界书中已有的小总结进度开始，按每批30层自动往后总结，直至覆盖当前对话的全部楼层。<br><br>如果本对话设置过起始楼层，会自动按该起始楼层继续编号。<br><br>是否继续？",
  );
  if (!proceed) {
    notify("info", "已取消。");
    return;
  }

  notify("info", "开始自动小总结...");

  const summaryLorebookName = await getOrCreateSummaryLorebook();
  const lastMessageId = getLastMessageId();

  if (lastMessageId < 0) {
    notify("info", "当前没有消息，无需总结。");
    return;
  }

  const offsetRecord = getOffsetRecord();
  const offset = offsetRecord ? offsetRecord.offset : 0;

  let progress = await getSummaryProgress(summaryLorebookName, offset);

  if (progress >= lastMessageId) {
    notify(
      "info",
      `没有新内容需要总结（已总结到第${progress}楼，当前最后一楼为第${lastMessageId}楼）。`,
    );
    return;
  }

  const coveredStart = progress + 1;
  let batchesDone = 0;
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
  };

  while (progress < lastMessageId) {
    const batchStart = progress + 1;
    const batchEnd = Math.min(batchStart + AUTO_BATCH_SIZE - 1, lastMessageId);
    const rangeLabel = `${batchStart}-${batchEnd}`;
    const offsetRangeLabel =
      offset > 0 ? `${batchStart + offset}-${batchEnd + offset}` : rangeLabel;

    notify(
      "info",
      offset > 0
        ? `正在总结第${rangeLabel}楼（世界书中将保存为第${offsetRangeLabel}楼）...`
        : `正在总结第${rangeLabel}楼...`,
    );

    try {
      const { content: summaryContent, keyword: rangeKeyword } =
        await buildRangeSummaryContent(batchStart, batchEnd, {
          showStopButton: true,
          onStop: requestStop,
          statusText: `正在处理第${rangeLabel}楼，请稍候...`,
          isStopRequested: () => stopRequested,
        });

      if (!summaryContent) {
        throw new Error("该范围没有可用内容。");
      }

      const entryTitle = `${SMALL_SUMMARY_TITLE_PREFIX}${offsetRangeLabel}`;
      // order 用"起始楼层号 + 起始楼层偏移量"，与标题里的楼层号口径一致：
      // 楼层号越大（剧情越晚），order 越大，越靠近最后一条消息，
      // 保证同一本世界书跨对话续写（offset 不同）时，各批次的先后顺序依然正确。
      const summaryEntryOrder = batchStart + offset;
      await saveOrOverwriteLorebookEntry(
        summaryLorebookName,
        entryTitle,
        summaryContent,
        true,
        { ...SMALL_SUMMARY_ENTRY_DEFAULTS, order: summaryEntryOrder },
        rangeKeyword ? [rangeKeyword] : [],
      );

      progress = batchEnd;
      batchesDone += 1;

      if (stopRequested) {
        notify(
          "info",
          `已手动停止自动小总结，本轮生成 ${batchesDone} 批，进度保留到第${progress}楼${
            offset > 0 ? `（世界书中为第${batchEnd + offset}楼）` : ""
          }。`,
        );
        break;
      }

      await delay(STEP_DELAY);
    } catch (batchError) {
      if (batchError instanceof SummaryStopRequestedError) {
        // 用户在当前批次内层循环还没跑完时点了停止：本批次未完整生成，不保存、不推进进度，
        // 已成功保存的仍是上一批次的结果，下次点"自动小总结"会从原进度重新开始这一批。
        notify(
          "info",
          `已手动停止自动小总结，本轮生成 ${batchesDone} 批，进度保留到第${progress}楼${
            offset > 0 ? `（世界书中为第${progress + offset}楼）` : ""
          }。`,
        );
        break;
      }

      console.error(
        `[剧情助手] 自动小总结在第${rangeLabel}楼批次失败:`,
        batchError,
      );
      const context = getCtx();
      await context.callGenericPopup(
        `在总结第${rangeLabel}楼时失败：${batchError.message}<br><br>已成功保存到第${progress}楼，进度已保留，你可以稍后重新点击"自动小总结"从这里继续。`,
        context.POPUP_TYPE.TEXT,
        "",
        { okButton: "知道了" },
      );
      break;
    }
  }

  if (batchesDone > 0 && !stopRequested) {
    notify(
      "success",
      `自动小总结本轮完成，共生成 ${batchesDone} 批，覆盖第${coveredStart}楼到第${progress}楼${
        offset > 0
          ? `（世界书中为第${coveredStart + offset}楼到第${progress + offset}楼）`
          : ""
      }。`,
    );
  }
});


// =====================================================================================
// === Function: 设定起始楼层（原"接续小总结"，现在只负责设置偏移量本身，不触发任何总结生成）===
// 用于"总结完一段故事后，重置角色卡或新开一个对话继续写，但仍沿用同一个总结世界书"的场景。
// 设置后，"自动小总结"会自动按这个起始楼层继续编号（世界书楼层号 = 本对话本地楼层号 + 起始楼层）。
// 默认值始终实时扫描世界书计算（不使用本对话已保存的偏移量作为默认值）：
//   - 世界书里已有历史小总结 → 预填"历史最大止楼层 + 1"
//   - 世界书是空的（全新故事）→ 预填 0
// 本对话当前实际生效的起始楼层，改为在面板"总结功能"区块下方只读展示，不再影响这里的默认值。
// =====================================================================================
export const runSetOffset = errorCatched(async () => {
  const summaryLorebookName = await getOrCreateSummaryLorebook();
  const context = getCtx();

  // 默认值始终实时扫描世界书计算（不使用本对话已保存的偏移量作为默认值），
  // 这样世界书里有新条目时，弹窗预填的建议值总是跟世界书当前实际内容一致。
  const maxEnd = await getMaxSummaryEnd(summaryLorebookName);
  const defaultOffset = maxEnd < 0 ? 0 : maxEnd + 1;

  const inputRaw = await context.callGenericPopup(
    `新对话的小总结楼层号从第几层开始编号？<br>（全新故事填 0；用于大总结后的新对话续写，已根据世界书当前内容自动预填建议值，直接确认即可）`,
    context.POPUP_TYPE.INPUT,
    String(defaultOffset),
    { okButton: "确定", cancelButton: "取消" },
  );
  if (
    inputRaw === null ||
    inputRaw === undefined ||
    inputRaw === false ||
    inputRaw === ""
  ) {
    notify("info", "已取消。");
    return;
  }

  const offset = parseInt(String(inputRaw).trim(), 10);
  if (isNaN(offset) || !Number.isInteger(offset) || offset < 0) {
    notify("error", `无效的起始楼层: "${inputRaw}"，必须是 0 或更大的整数。`);
    return;
  }

  await setOffsetRecord(offset);
  notify("success", `已设定本对话小总结起始楼层为第${offset}层。`);
});


// =====================================================================================
// === Function: 自动大总结 ===
// 只读取世界书中已有的全部"小总结：xx-xx"条目，整合成一段连贯概况文字，不重新读取原始聊天记录。
// =====================================================================================
export const runAutoLargeSummary = errorCatched(async () => {
  const summaryLorebookName = await getOrCreateSummaryLorebook();

  const proceed = await confirmAction(
    "自动大总结",
    "大总结会基于已有的小总结条目，生成一段连贯的故事概况（用于节省Token。开始新聊天后粘贴到第0层以接续对话）。<br><br>是否继续？",
  );
  if (!proceed) {
    notify("info", "已取消。");
    return;
  }

  const entries = await getLorebookEntriesArray(summaryLorebookName);
  const smallSummaries = entries
    .filter(
      (entry) =>
        typeof entry.comment === "string" &&
        entry.comment.startsWith(SMALL_SUMMARY_TITLE_PREFIX),
    )
    .map((entry) => {
      const match = entry.comment.match(/(\d+)-(\d+)\s*$/);
      const start = match ? parseInt(match[1]) : Number.MAX_SAFE_INTEGER;
      return { ...entry, _start: start };
    })
    .sort((a, b) => a._start - b._start);

  if (smallSummaries.length === 0) {
    notify("warning", "世界书中没有找到任何小总结条目，无法生成大总结。");
    return;
  }

  const combinedText = smallSummaries
    .map((entry) => `${entry.comment}\n${entry.content}`)
    .join("\n\n---\n\n");

  notify(
    "info",
    `正在生成大总结（共整合 ${smallSummaries.length} 条小总结）...`,
  );

  let summaryContent = null;
  try {
    const systemPrompt = buildLargeSummaryInstruction();
    const userContent = `以下是已有的分段小总结：\n\n${combinedText}`;
    const rawResult = await generateSummaryWithOverlay(
      systemPrompt,
      userContent,
    );
    const aiSummaryBlock = parseLargeSummaryBlock(rawResult);
    if (!aiSummaryBlock) {
      throw new Error(
        "AI回复中未找到有效的 <details><summary>摘要</summary>...</details> 内容。",
      );
    }

    // AI 只负责 Time/Location/Overview 三项（它本来也拿不到状态表数据）；
    // Relationships/Inventory/Setups 由代码从当前状态表世界书条目里读快照，二次拼接进去。
    // 这样粘到新对话第0层后天然带着完整字段，新对话首次触发 rebuildStatusTableFromChat 全量重放时
    // 就能把这些字段解析回状态表，不会因为第0层缺字段而被当成"没有历史数据"清空。
    const aiFields = parseFloorSummaryFields(aiSummaryBlock) || {
      time: "",
      location: "",
      overview: "",
    };

    const statusTableEntry = entries.find(
      (entry) => entry.comment === STATUS_TABLE_TITLE,
    );
    const statusTableText = statusTableEntry ? statusTableEntry.content : "";
    const relationshipsSnapshot = extractLabelLine(
      statusTableText,
      "Relationships",
    );
    const inventorySnapshot = convertInventorySnapshotToHardset(
      extractLabelLine(statusTableText, "Inventory"),
    );
    const setupsSnapshot = extractLabelLine(statusTableText, "Setups");

    summaryContent = [
      "<details><summary>摘要</summary>",
      `Time: ${aiFields.time}`,
      `Location: ${aiFields.location}`,
      `Relationships: ${relationshipsSnapshot}`,
      `Inventory: ${inventorySnapshot}`,
      `Setups: ${setupsSnapshot}`,
      "Overview: ",
      aiFields.overview,
      "</details>",
    ].join("\n");
  } catch (genError) {
    console.error("[剧情助手] 大总结生成失败:", genError);
    const context = getCtx();
    await context.callGenericPopup(
      `生成大总结时出错：${genError.message}`,
      context.POPUP_TYPE.TEXT,
      "",
      {
        okButton: "知道了",
      },
    );
    return;
  }

  // 大总结是手动复制到重开对话开头用的，不需要在当前对话里被引擎扫描注入上下文：
  // 新建时改成条件触发（非常驻）+ 默认禁用；禁用状态下 position/depth/order/key 不生效，沿用原生默认即可。
  await saveOrOverwriteLorebookEntry(
    summaryLorebookName,
    LARGE_SUMMARY_TITLE,
    summaryContent,
    true,
    {
      constant: false,
      disable: true,
    },
  );
  notify("success", `大总结已生成并保存 (${LARGE_SUMMARY_TITLE})。`);
});


// === Function: 进入角色卡/切换聊天时，主动确保总结世界书和状态表条目存在（不再等到第一次状态表合并才创建）===
// 世界书绑定提醒不再只弹一次，而是和初始化提示一样，每次运行到这里都会提醒一遍，避免用户漏看/忘记绑定。
export async function ensureSummaryLorebookOnLoad() {
  let characterName;
  try {
    characterName = getCurrentCharacterName();
  } catch (error) {
    // 常见于 CHAT_CHANGED 事件触发的一瞬间，酒馆内部角色状态可能还没同步好——不算真正的错误，
    // 打个 warn 方便排查，同时返回 false 让调用方决定要不要稍后重试。
    console.warn(
      "[剧情助手] 暂时无法获取当前角色信息（可能是切换聊天时机太早），本次跳过创建世界书:",
      error.message,
    );
    return false;
  }

  const readyLorebookName = await getOrCreateSummaryLorebook();

  const context = getCtx();
  const data = await context.loadWorldInfo(readyLorebookName);
  const hasStatusTable =
    data &&
    data.entries &&
    Object.values(data.entries).some(
      (entry) => entry.comment === STATUS_TABLE_TITLE,
    );
  if (!hasStatusTable) {
    const emptyState = {
      relationships: new Map(),
      inventory: new Map(),
      setups: new Map(),
    };
    await saveOrOverwriteLorebookEntry(
      readyLorebookName,
      STATUS_TABLE_TITLE,
      serializeStatusTableContent(emptyState),
      true,
      STATUS_TABLE_ENTRY_DEFAULTS,
    );
  }

  const isMountedGlobally =
    await isSummaryLorebookGloballyEnabled(readyLorebookName);
  if (!isMountedGlobally) {
    notify(
      "warning",
      `需「${readyLorebookName}」加入世界书全局启用列表配合使用。`,
    );
  }
  return true;
}


// === Function: 注册"进入角色卡自动建世界书"的监听（切换聊天时触发，插件刚加载时也主动跑一次）===
export function registerLorebookAutoCreate() {
  try {
    const context = getCtx();
    if (
      context.eventSource &&
      context.event_types &&
      context.event_types.CHAT_CHANGED
    ) {
      context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        // 切换聊天这一刻酒馆内部的角色状态可能还没同步好，先等一小会儿再读；
        // 如果第一次还是拿不到角色信息（ensureSummaryLorebookOnLoad 返回 false），再多等一会儿重试一次。
        delay(300)
          .then(() => ensureSummaryLorebookOnLoad())
          .catch((error) => {
            console.error("[剧情助手] 切换聊天时自动创建世界书出错:", error);
            return false;
          })
          .then(async (ok) => {
            if (ok) return;
            await delay(1000);
            await ensureSummaryLorebookOnLoad().catch((error) => {
              console.error(
                "[剧情助手] 切换聊天时自动创建世界书重试仍出错:",
                error,
              );
            });
          });
      });
    } else {
      console.warn(
        "[剧情助手] 未找到 CHAT_CHANGED 事件，世界书自动创建仅在插件加载时触发一次。",
      );
    }
    // 插件刚加载时如果已经在某个角色的聊天里，也主动跑一次，不用等切换聊天才触发。
    // 延迟一下再跑：给酒馆本身留出初始化时间，避免过早访问世界书/角色卡相关接口出问题。
    delay(1500).then(() =>
      ensureSummaryLorebookOnLoad().catch((error) => {
        console.error("[剧情助手] 初始化时自动创建世界书出错:", error);
      }),
    );
  } catch (error) {
    console.error("[剧情助手] 注册世界书自动创建监听时出错:", error);
  }
}


// === Function: 注册状态表自动更新监听——每次新楼层（AI消息）渲染完成后自动解析并合并进状态表 ===
export function registerStatusTableAutoUpdate() {
  try {
    const context = getCtx();
    if (!context.eventSource || !context.event_types) {
      console.warn(
        "[剧情助手] 当前酒馆版本未暴露 eventSource/event_types，状态表自动更新未启用。",
      );
      return;
    }
    // 优先用 CHARACTER_MESSAGE_RENDERED（AI消息渲染完成），退回 MESSAGE_RECEIVED——覆盖"新增楼层"的场景。
    const renderEventName =
      context.event_types.CHARACTER_MESSAGE_RENDERED ||
      context.event_types.MESSAGE_RECEIVED;
    // 覆盖"楼层被删除/编辑/重roll"的场景——不同酒馆版本暴露的事件名不完全一致，能找到几个就都挂上，
    // 全量重放本身是幂等的，多触发几次不会产生副作用，只是多做几次无害的重算。
    const rollbackEventNames = [
      context.event_types.MESSAGE_DELETED,
      context.event_types.MESSAGE_EDITED,
      context.event_types.MESSAGE_SWIPED,
      context.event_types.CHAT_MESSAGE_DELETED,
    ].filter(Boolean);

    if (!renderEventName && rollbackEventNames.length === 0) {
      console.warn("[剧情助手] 未找到可用的消息事件，状态表自动更新未启用。");
      return;
    }

    if (renderEventName) {
      context.eventSource.on(renderEventName, () =>
        handleMessageForStatusTable(),
      );
    }
    rollbackEventNames.forEach((eventName) => {
      context.eventSource.on(eventName, () => handleMessageForStatusTable());
    });

    console.log(
      `[剧情助手] 状态表自动更新监听已注册（新增楼层事件: ${renderEventName || "无"}；回退/编辑相关事件: ${
        rollbackEventNames.length > 0
          ? rollbackEventNames.join(", ")
          : "无（该场景需等下一条新消息触发才会同步）"
      }）。`,
    );
  } catch (error) {
    console.error("[剧情助手] 注册状态表自动更新监听时出错:", error);
  }
}
