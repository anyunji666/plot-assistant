"use strict";

import { AUTO_BATCH_SIZE, GENERATION_TIMEOUT, LARGE_SUMMARY_TITLE, PRE_EMPHASIS_ENTRY_DEFAULTS, PRE_EMPHASIS_TITLE, SMALL_SUMMARY_ENTRY_DEFAULTS, SMALL_SUMMARY_TITLE_PREFIX, STATUS_TABLE_ENTRY_DEFAULTS, STATUS_TABLE_TITLE, STEP_DELAY, SummaryStopRequestedError, confirmAction, delay, errorCatched, getCtx, getOffsetRecord, notify, persistChatMetadata, setOffsetRecord } from "../core.js";
import { buildArchiveOverviewInstruction, buildArchiveOverviewUserContent, buildArchiveTimeLabel, buildFloorRestoreInstruction, buildFloorRestoreUserContent, buildMessagesText, convertInventorySnapshotToHardset, extractLabelLine, extractYearMonthKeyword, findNearestAnchorFloor, getLastMessageId, getMaxSummaryEnd, getSortedSmallSummaryEntries, getSummaryProgress, parseFloorSummaryFields, parseRestoredFloorFields, parseSummaryContent, serializeStatusTableContent } from "./parser.js";
import { closeGeneratingOverlay, showGeneratingOverlay } from "./ui.js";
import { getCurrentCharacterName, getFreeUid, getLorebookEntriesArray, getOrCreateSummaryLorebook, isSummaryLorebookGloballyEnabled, notifyWorldInfoUpdated, saveOrOverwriteLorebookEntry } from "../worldinfo.js";


export async function buildRangeSummaryContent(batchStart, batchEnd, offset = 0, overlayOptions) {
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
  const bullets = unifiedFloors
    .filter((f) => f.overview)
    .map((f) => `- [第${f.idx + offset}楼] ${f.overview}`);

  // 世界书里的小总结正文只保留时间跨度和关键事件——地点取"批次内最后一个场景"意义有限，
  // 且作为世界书条目被注入进上下文后反而可能跟正文实际所在场景不一致，造成干扰，故不写入正文。
  const content = `时间：${timeLabel}\n关键事件：\n${bullets.length ? bullets.join("\n") : "（本段无实质推进）"}`;

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
    "将从世界书中已有的小总结进度开始，按每批30层自动往后总结，直至覆盖当前对话的全部楼层。<br><br>每批总结保存成功后，对应楼层会自动隐藏，避免原文与小总结内容重复占用上下文。<br><br>如果本对话设置过起始楼层，会自动按该起始楼层继续编号。<br><br>是否继续？",
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

  // 设置过起始楼层（offset > 0）且本对话还没生成过任何小总结时，第0楼是"状态存档"粘贴内容
  // （不是新产生的剧情），第1楼通常是接续后的第一条用户发言（本身也不会有摘要模块，正常扫描也会跳过）。
  // 这里直接把起点定到第2楼，不必再把第0楼纳入扫描——省一次无意义的解析，也彻底避免它被当成"新内容"处理。
  // 只在"从未总结过"（progress < 0）时生效：一旦本对话已经生成过小总结，progress 就会有实际值，
  // 不会再触发这个跳过逻辑，不影响后续正常批次。
  if (progress < 0 && offset > 0) {
    progress = 1;
  }

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
        await buildRangeSummaryContent(batchStart, batchEnd, offset, {
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

      // 小总结联动隐藏楼层：这一批已经被小总结覆盖存档，原始楼层不再需要留给AI看，
      // 隐藏失败不影响本批总结已保存的结果，只记日志+提示，不中断循环。
      try {
        const context = getCtx();
        await context.executeSlashCommandsWithOptions(
          `/hide ${batchStart}-${batchEnd}`,
        );
      } catch (hideError) {
        console.error(
          `[剧情助手] 自动小总结联动隐藏第${rangeLabel}楼失败:`,
          hideError,
        );
        notify(
          "warning",
          `第${rangeLabel}楼小总结已保存，但自动隐藏失败：${hideError.message}`,
        );
      }

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
    `新对话的小总结楼层号从第几层开始编号？<br>（全新故事填 0；用于状态存档后的新对话续写，已根据世界书当前内容自动预填建议值，直接确认即可）`,
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
// === Function: 状态存档 ===
// Relationships/Inventory/Setups：直接读取当前状态表世界书条目，不调用AI，原样存档。
// Time：本地拼接，不调用AI——扫描世界书全部"小总结：起-止"条目，取最早条目的时间起点、
// 最晚条目的时间止点（见 buildArchiveTimeLabel），不重新计算或推理。
// Overview：唯一的AI调用点——把全部小总结正文按顺序拼进 <story_history> 标签交给AI二次提炼，
// 生成一份不超过1000字的剧情总览（见 buildArchiveOverviewInstruction/buildArchiveOverviewUserContent）。
// 外壳仍然是 <details><summary>摘要</summary>...</details>，因为新对话第0层要靠
// parseFloorSummaryFields 识别出这是一层"摘要模块"，首次触发 rebuildStatusTableFromChat
// 全量重放时把 Relationships/Inventory/Setups 解析合并回状态表；Time 顺带能被
// findNearestAnchorFloor 当作新对话里逐层还原摘要时的上文时间锚点使用。
// 世界书里没有任何"小总结"条目时（比如刚开局就存档），跳过AI调用，Time/Overview 都留空，
// 其余逻辑不受影响。
// =====================================================================================
export const runAutoLargeSummary = errorCatched(async () => {
  const summaryLorebookName = await getOrCreateSummaryLorebook();

  const proceed = await confirmAction(
    "状态存档",
    "状态存档会读取当前状态表（人物关系/物品/伏笔）和已有的小总结（时间线/剧情总览），生成可粘贴到新对话第0层的存档内容，用于新对话接续时恢复进度。<br><br>是否继续？",
  );
  if (!proceed) {
    notify("info", "已取消。");
    return;
  }

  const entries = await getLorebookEntriesArray(summaryLorebookName);
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

  if (!relationshipsSnapshot && !inventorySnapshot && !setupsSnapshot) {
    notify("warning", "当前状态表是空的，没有可存档的内容。");
    return;
  }

  const sortedSmallSummaries = await getSortedSmallSummaryEntries(
    summaryLorebookName,
  );

  const timeLabel = buildArchiveTimeLabel(sortedSmallSummaries);

  let overview = "";
  if (sortedSmallSummaries.length > 0) {
    notify("info", "正在总结Overview，请稍候...");
    const systemPrompt = buildArchiveOverviewInstruction();
    const userContent = buildArchiveOverviewUserContent(sortedSmallSummaries);
    try {
      const rawResult = await generateSummaryWithOverlay(
        systemPrompt,
        userContent,
        { statusText: "正在总结剧情总览，请稍候..." },
      );
      overview = (rawResult || "").trim();
    } catch (generateError) {
      console.error("[剧情助手] 状态存档生成Overview失败:", generateError);
      notify(
        "error",
        `生成剧情总览失败：${generateError.message}，将只存档状态表快照。`,
      );
    }
  }

  const summaryContent = [
    "<details><summary>摘要</summary>",
    `Time: ${timeLabel}`,
    `Relationships: ${relationshipsSnapshot}`,
    `Inventory: ${inventorySnapshot}`,
    `Setups: ${setupsSnapshot}`,
    `Overview: ${overview}`,
    "</details>",
  ].join("\n");

  // 状态存档是手动复制到重开对话开头用的，不需要在当前对话里被引擎扫描注入上下文：
  // 新建时改成条件触发（非常驻）+ 默认禁用 + 触发概率0；禁用状态下 position/depth/order/key 不生效，沿用原生默认即可，
  // 概率归零是双保险——万一之后被手动启用，也不会被原生引擎意外抽中注入。
  try {
    await saveOrOverwriteLorebookEntry(
      summaryLorebookName,
      LARGE_SUMMARY_TITLE,
      summaryContent,
      true,
      {
        constant: false,
        disable: true,
        probability: 0,
      },
    );
  } catch (saveError) {
    console.error("[剧情助手] 状态存档保存失败:", saveError);
    notify("error", `状态存档保存失败：${saveError.message}`);
    return;
  }
  notify("success", `状态存档已生成并保存 (${LARGE_SUMMARY_TITLE})。`);
});


// === Function: 进入角色卡/切换聊天时，主动确保总结世界书和状态表条目存在（不再等到第一次状态表合并才创建）===
// 世界书绑定提醒改为"每个角色卡只提醒一次"：同一本世界书只要提醒过就不再重复弹，
// 直到你把它挂载为全局世界书后又手动取消挂载，才会重新触发一次新的提醒。
let warnedLorebookName = null;

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
    if (warnedLorebookName !== readyLorebookName) {
      notify(
        "warning",
        `需「${readyLorebookName}」加入世界书全局启用列表配合使用。`,
      );
      warnedLorebookName = readyLorebookName;
    }
  } else {
    // 已挂载全局：清空提醒记录，万一之后又被手动取消挂载，能重新提醒一次。
    if (warnedLorebookName === readyLorebookName) warnedLorebookName = null;
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


// 状态表LLM 独立提取 Inventory / Setups 的编排逻辑（含自动更新监听注册）已搬到同目录的
// status-llm-extract.js，跟 status-llm-api.js / status-llm-prompts.js / status-llm-store.js
// 归到一起，按"状态表LLM"整体查找。此处不再保留，仅留这条索引注释。


// === Helper: 读取"对话前强调"条目当前内容（供打开编辑框时预填） ===
export async function loadPreEmphasisEntry() {
  const lorebookName = await getOrCreateSummaryLorebook();
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  const entries = data && data.entries ? Object.values(data.entries) : [];
  const existing =
    entries.find((entry) => entry.comment === PRE_EMPHASIS_TITLE) || null;
  return { lorebookName, existing };
}


// === Helper: 保存/新建"对话前强调"条目 ===
// 与总结条目不同，这里的"启用/禁用"是用户主动切换的核心状态，每次保存都要写回 disable 字段，
// 不能像 saveOrOverwriteLorebookEntry 那样对已存在条目只更新标题/内容。
export async function savePreEmphasisEntry(content, enabled) {
  const context = getCtx();
  const lorebookName = await getOrCreateSummaryLorebook();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  const existing = Object.values(data.entries).find(
    (entry) => entry.comment === PRE_EMPHASIS_TITLE,
  );

  if (existing) {
    data.entries[existing.uid].content = content;
    data.entries[existing.uid].disable = !enabled;
  } else {
    const newUid = getFreeUid(data);
    if (newUid === null) throw new Error("无法为新世界书条目分配 uid。");
    data.entries[newUid] = {
      uid: newUid,
      comment: PRE_EMPHASIS_TITLE,
      content,
      disable: !enabled,
      constant: true,
      key: [],
      useGroupScoring: false,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 0,
      ...PRE_EMPHASIS_ENTRY_DEFAULTS,
    };
  }

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
  return lorebookName;
}
