"use strict";

// =====================================================================================
// === 状态表LLM：从 generator.js 拆出来的提取编排逻辑（2024年新增功能） ===
// 这里只负责"编排"——什么时候调用状态表LLM、结果怎么拼回正文、什么时候触发全量重放——
// 状态表LLM 本身的提示词/API调用/设置读写在同目录的 prompts.js / api.js / store.js
// 三个文件里，跟 novel-summary/lib/ 同一套子文件夹组织方式，方便按"状态表LLM"整体查找。
// =====================================================================================

import {
  STATUS_TABLE_TITLE,
  STATUS_LLM_FIELDS_START,
  STATUS_LLM_FIELDS_END,
  getCtx,
  getLastAiFloor,
} from "../../core.js";
import { handleMessageForStatusTable, parseFloorSummaryFields } from "../status-table.js";
import { getLorebookEntriesArray, getOrCreateSummaryLorebook } from "../../worldinfo.js";
import { commitPendingInventoryChanges, getPhoneChatState, peekPendingInventoryChangeSegments } from "../../phone/store.js";
import { buildPhoneLetterContentForStatusLlm } from "../../phone/generator.js";
import { callStatusLlm } from "./api.js";
import { buildStatusLlmSystemPrompt } from "./prompts.js";
import { getCustomFields, getStatusLlmSettings, saveStatusLlmSettings } from "./store.js";
import { extractLabelLine } from "../floor-restore.js";
import {
  hideStatusLlmIndicator,
  rerenderLatestSummaryCard,
  showStatusLlmIndicator,
} from "../../beautify/render.js";

// =====================================================================================
// === 状态表LLM：独立提取 Inventory / Setups ===
// 剧情LLM的摘要块协议里不再包含 Inventory/Setups 两个字段（改由本模块单独调用一次AI提取），
// 流程：读取最新一层AI原文 + 当前状态表快照 → 调用状态表LLM → 把返回的两行结果拼回这一层消息正文。
// 拼回正文（而不是另存一份按楼层索引的旁路数据）是为了跟"状态表全量重放"（rebuildStatusTableFromChat）
// 共用同一套解析/合并逻辑——重放是按当前 chat 数组内容重新推导，楼层被删除/回退时天然跟着收窄，
// 如果 Inventory/Setups 存在独立于正文之外的旁路存储里，楼层增删后旁路数据的楼层号就可能跟实际错位。
// =====================================================================================

// === Helper: 判断某一层是否已经处理过（正文里已出现 <!-- status-llm-fields --> 包裹标记，不管值是否为空），
// 避免同一层因为多个事件重复触发而重复调用状态表LLM。
// 依据从"裸 Inventory: 文本"改成"是否有这个包裹注释"——裸文本可能是剧情LLM在协议外手滑写的，
// 不能作为"状态表LLM已处理过"的证据，只有本模块自己包裹注释写进去的才算数。===
function hasStatusLlmFieldsMarker(mesText) {
  return (mesText || "").includes(STATUS_LLM_FIELDS_START);
}


// === Helper: 把状态表LLM返回的 Inventory/Setups（以及已配置的附加字段）结果拼进这一层摘要块正文里
// （插在 Relationships 行之后——必须早于 Overview 行，否则会被 Overview 的贪婪正则一起吞掉）===
// customFieldTexts: { 字段名: 提取到的本轮变化文本 }，来自面板"附加字段"里配置的定义，可为空对象。
// 覆盖式：先整体删掉已存在的 <!-- status-llm-fields -->...<!-- /status-llm-fields --> 区块（如果有），
// 再把这次的结果重新包上同样的注释插入——避免同一层因为多次触发（如提取失败重试）在正文里越叠越多。
export function spliceExtractedFieldsIntoMes(
  mesText,
  inventoryText,
  setupsText,
  customFieldTexts = {},
) {
  const customLines = Object.entries(customFieldTexts)
    .map(([name, value]) => `${name}: ${value || ""}\n`)
    .join("");
  const fieldsBlock = `Inventory: ${inventoryText || ""}\nSetups: ${setupsText || ""}\n${customLines}`;
  const insertion = `${STATUS_LLM_FIELDS_START}\n${fieldsBlock}${STATUS_LLM_FIELDS_END}\n`;

  const existingBlockRe = new RegExp(
    `${STATUS_LLM_FIELDS_START}[\\s\\S]*?${STATUS_LLM_FIELDS_END}\\n?`,
  );
  const cleanedMes = mesText.replace(existingBlockRe, "");

  const relRe = /(Relationships\s*[:：][^\n]*\n)/;
  if (relRe.test(cleanedMes)) {
    return cleanedMes.replace(relRe, (m) => `${m}${insertion}`);
  }
  // 兜底：没找到 Relationships 行——协议里这一项只在"本轮关系有变化"时才输出，没变化的轮次
  // AI 大概率会整行不写，属于常见情况而非异常；这时插在 <summary>摘要</summary> 标签后面，
  // 同样早于 Overview（比 Time/Location 还靠前也没关系，不影响解析，字段是逐行匹配的）。
  const headerRe = /(<details>\s*<summary>\s*摘要\s*<\/summary>\s*\n?)/;
  if (headerRe.test(cleanedMes)) {
    return cleanedMes.replace(headerRe, (m) => `${m}${insertion}`);
  }
  return mesText; // 没有摘要块，原样返回（用原始 mesText 而非 cleanedMes），调用方会先判断 parseFloorSummaryFields 是否为 null
}


// === Helper: 读取"状态表"世界书条目当前内容（供拼装状态表LLM的上下文用）===
// Busy 数据行（手机私信插件维护，仅剧情LLM需要据此输出 [REMOVE]）以及两条固定的
// "（提醒：...）"说明/提示行（分别针对 Setups 说明和 Busy 清理提示，仅剧情LLM需要），
// 均与状态表LLM只负责的 Inventory/Setups 提取无关，过滤掉以减少无关上下文。
function stripBusyAndReminderLines(text) {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith("Busy:") && !t.startsWith("（提醒：");
    })
    .join("\n");
}

async function getStatusTableSnapshotText(lorebookName) {
  try {
    const entries = await getLorebookEntriesArray(lorebookName);
    const entry = entries.find((e) => e.comment === STATUS_TABLE_TITLE);
    const raw = entry ? entry.content || "" : "";
    return stripBusyAndReminderLines(raw);
  } catch (error) {
    console.error("[剧情助手] 读取状态表快照失败:", error);
    return "";
  }
}


// === Helper: 持久化对某一层消息正文的修改（写回 chat 数组 + 尝试刷新DOM + 尝试保存聊天文件）===
// 除了改 .mes，还要同步写回 .swipes[swipe_id]（如果这条消息有swipes数组的话）——
// 酒馆自己只在流式生成结束时调用一次 syncMesToSwipe 做这层同步，我们这里是生成完全结束之后
// 才异步回来改 .mes（等状态表LLM调用完才拼回去），时机已经晚于酒馆那次同步，
// 不主动补一次的话，Inventory/Setups这两行就只留在 .mes 上、没进 swipes 数据结构，
// 后续任何依赖 swipes 数组重建/导出 mes 的场景都可能把这次拼接结果冲掉。
async function persistMesEdit(context, idx, newMes) {
  if (!Array.isArray(context.chat) || !context.chat[idx]) return;
  context.chat[idx].mes = newMes;
  const message = context.chat[idx];
  if (
    Array.isArray(message.swipes) &&
    typeof message.swipe_id === "number" &&
    message.swipe_id >= 0 &&
    message.swipe_id < message.swipes.length
  ) {
    message.swipes[message.swipe_id] = newMes;
  }
  if (typeof context.updateMessageBlock === "function") {
    try {
      context.updateMessageBlock(idx, context.chat[idx]);
    } catch (error) {
      console.warn("[剧情助手] 刷新楼层显示失败（不影响数据已保存）:", error);
    }
  }
  if (typeof context.saveChat === "function") {
    try {
      await context.saveChat();
    } catch (error) {
      console.error("[剧情助手] 保存聊天记录失败:", error);
    }
  }
}


// === Function: 对"最新一层AI楼层"跑一次状态表LLM提取，把结果写回该层正文 ===
// 静默失败：调用失败/超时（很多情况是模型截断）只打印控制台，不弹窗打断阅读体验，
// 这一层的 Inventory/Setups 暂时不更新，等下一层生成完 getLastAiFloor 指向新的最新层再自然重试。
// 不在这里触发状态表重放——统一交给调用方（registerStatusTableAutoUpdate 的渲染事件处理器）
// 在这之后固定跑一次 handleMessageForStatusTable，覆盖"提取失败但 Relationships/Busy 仍要正常更新"的情况。
export async function extractInventorySetupsForLatestFloor() {
  try {
    const context = getCtx();
    const { idx, mes } = getLastAiFloor();
    if (idx === -1 || !mes) return;

    // 楼层"翻篇"检测：如果上次有一份待生效改动的快照被拼进了【别的、更早的】楼层，
    // 说明那一层楼现在已经不是"最新一层"了——用户已经往下继续推进对话，不会再回头重新生成那一层，
    // 这时候才是真正可以把那份快照从 pendingInventoryChanges 里摘掉的安全时机。
    // 如果拿到的是同一层楼（idx相同，只是这一层被重新生成/swipe出了新内容），说明还没翻篇，先不提交，
    // 等下面重新走一遍完整pending拼进这一层新内容里。
    const phoneState = getPhoneChatState();
    const pendingSplice = phoneState.pendingInventorySplice;
    if (pendingSplice && pendingSplice.floorIdx !== idx) {
      // 提交前校验一下：那层楼是否还在、且仍带着当初拼进去的 Inventory 内容——
      // 如果那层楼后来被删除/编辑没了这段内容，说明快照记录的那次拼接其实没能真正留存下来，
      // 不能当成"已安全落地"直接清空，否则这份背包改动会彻底消失；跳过提交，让它留在pending里，
      // 下面会被当作当前最新层的待生效改动重新读取、重新尝试拼进这一层。
      const referencedFloor = context.chat?.[pendingSplice.floorIdx];
      const stillPresent =
        referencedFloor && hasStatusLlmFieldsMarker(referencedFloor.mes);
      if (stillPresent) {
        try {
          await commitPendingInventoryChanges(pendingSplice.snapshot);
        } catch (error) {
          console.error("[剧情助手] 提交背包待生效改动失败:", error);
        }
      }
      phoneState.pendingInventorySplice = null;
      try {
        await persistChatMetadata();
      } catch (error) {
        console.error("[剧情助手] 清空待提交快照指针失败:", error);
      }
    }

    const floorFields = parseFloorSummaryFields(mes);
    if (!floorFields) return; // 没有摘要块（比如纯闲聊分支之类），跳过

    if (hasStatusLlmFieldsMarker(mes)) return; // 已经处理过，跳过（避免多个事件重复触发同一层）

    // AI调用单独 try/catch：失败（很多情况是模型截断）只跳过"AI从正文里判断的那部分变化"，
    // 不影响下面背包页手动改动的合并——两者来源独立，不该互相拖累。
    let inventoryText = "";
    let setupsText = "";
    let customFieldTexts = {};
    // 面板"再分析"开关默认关闭：关闭时完全不调用状态表LLM（不发请求、不产生token消耗），
    // Inventory/Setups/附加字段的AI提取部分保持为空，跟下面调用失败时的兜底行为一致，
    // 不影响背包页手动改动的合并——两者走的是独立分支。
    if (getStatusLlmSettings().reanalyzeEnabled) {
      try {
        const lorebookName = await getOrCreateSummaryLorebook();
        const snapshotText = await getStatusTableSnapshotText(lorebookName);
        const settings = getStatusLlmSettings();
        const customFields = getCustomFields();
        const systemPrompt = buildStatusLlmSystemPrompt(
          settings.customPrompt,
          customFields,
        );

        let letterContent = "";
        try {
          const letterResult = await buildPhoneLetterContentForStatusLlm();
          letterContent = letterResult.content || "";
        } catch (error) {
          console.error("[剧情助手] 读取本轮私信内容失败（Setups判断可能漏看私信）:", error);
        }

        // "字段修改"弹窗提交的一次性元指令：读到就立即清空（无论下面的AI调用最终是否成功），
        // 保证只拼接发送这一次，不会在之后每一层都反复带上同一条旧指令。
        const metaInstructionText = (settings.pendingMetaInstruction || "").trim();
        if (metaInstructionText) {
          settings.pendingMetaInstruction = "";
          saveStatusLlmSettings();
        }
        const metaInstructionBlock = metaInstructionText
          ? `\n\n另外，用户还有一条本轮追加的修改指令，请一并按此输出对应字段变化，格式仍需遵循上文规范：\n${metaInstructionText}`
          : "";

        const userContent = `${snapshotText ? `${snapshotText}\n\n` : ""}${letterContent ? `${letterContent}\n\n` : ""}<latest_floor>\n${mes}\n</latest_floor>${metaInstructionBlock}`;

        const rawResult = await callStatusLlm([
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ]);

        inventoryText = extractLabelLine(rawResult, "Inventory");
        setupsText = extractLabelLine(rawResult, "Setups");
        customFields.forEach((field) => {
          customFieldTexts[field.name] = extractLabelLine(rawResult, field.name);
        });
      } catch (error) {
        console.error(
          "[剧情助手] 状态表LLM调用失败，本层Inventory/Setups/附加字段的AI提取部分已跳过（很多情况是模型截断，可在「状态表配置」弹窗调整提示词后重试）:",
          error,
        );
      }
    }

    // 背包页手动改库存的"待生效改动"：不管上面AI调用成不成功都要合并进来，
    // 避免因为AI这次调用失败，连带把用户手动改的库存也一起丢了。
    // 只读不清空（peek）——真正的清空挪到下面 persistMesEdit 成功之后，且只记一笔"待提交快照"，
    // 等这层楼真正翻篇了才提交，覆盖"这层楼后面还会被重新生成"的场景。
    let pendingSegments = [];
    let pendingSnapshot = {};
    try {
      const peeked = await peekPendingInventoryChangeSegments();
      pendingSegments = peeked.segments;
      pendingSnapshot = peeked.snapshot;
    } catch (error) {
      console.error("[剧情助手] 读取背包页待生效改动失败:", error);
    }
    const combinedInventoryText = [inventoryText, ...pendingSegments]
      .filter(Boolean)
      .join("；");

    const hasAnyCustomFieldValue = Object.values(customFieldTexts).some(
      (v) => v && v.trim(),
    );
    if (!combinedInventoryText && !setupsText && !hasAnyCustomFieldValue) return; // 都没有变化，不用改这一层正文

    const newMes = spliceExtractedFieldsIntoMes(
      mes,
      combinedInventoryText,
      setupsText,
      customFieldTexts,
    );
    if (newMes === mes) return; // 拼装失败（没找到可插入的位置），跳过——pending未被清空，下次还有机会重试

    await persistMesEdit(context, idx, newMes);

    // 拼装+持久化都确认成功后，才记下"这份快照已经拼进了第idx层"，供下次楼层翻篇时提交清空；
    // 注意这里不直接清空 pendingInventoryChanges——万一这一层楼后面又被重新生成，
    // 下一次提取还需要能重新读到完整的pending，原样再拼一遍进新的swipe里。
    if (Object.keys(pendingSnapshot).length > 0) {
      phoneState.pendingInventorySplice = { floorIdx: idx, snapshot: pendingSnapshot };
      await persistChatMetadata();
    }
  } catch (error) {
    console.error("[剧情助手] 状态表LLM提取 Inventory/Setups 时出错:", error);
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
      context.eventSource.on(renderEventName, async () => {
        // 非阻塞悬浮提示：整个提取+整合期间用户仍可以正常操作（含继续发下一条），
        // 提示本身不做任何拦截，只是告诉用户"状态表还在算"。三种收尾场景（正常结束/
        // 状态表LLM调用失败被内部吞掉/下面 GENERATION_STARTED 监听到用户抢先发下一条）
        // 都会让它消失，不需要用户手动关闭。
        showStatusLlmIndicator();
        try {
          // 先跑状态表LLM提取（同步等待，剧情LLM生成下一层前状态表已是最新）；
          // 提取内部静默失败不抛出，这里始终固定接一次全量重放，
          // 覆盖"提取失败/跳过，但 Relationships/Busy 仍要正常从正文解析更新"的情况。
          await extractInventorySetupsForLatestFloor();
          // 必须等这次全量重放（写入世界书「状态表」条目）真正完成，下面强制刷新卡片时
          // fetchStatusTableSnapshot 读到的才是这一轮的最新值，不然会读到刷新前的旧快照。
          await handleMessageForStatusTable();
          // 状态表已整合完毕：只强制刷新"最新一层"卡片，让附加字段等内容不用刷新页面就能看到，
          // 其余历史楼层不受影响（见 rerenderLatestSummaryCard 的说明）。
          await rerenderLatestSummaryCard();
        } finally {
          // extractInventorySetupsForLatestFloor / handleMessageForStatusTable 内部各自已经
          // try/catch 吞掉了失败，理论上走不到这个 finally 是因为异常；这里用 finally 只是
          // 兜底保证任何将来的改动即便抛错，提示也一定会消失，不会卡在屏幕上关不掉。
          hideStatusLlmIndicator();
        }
      });
    }
    rollbackEventNames.forEach((eventName) => {
      context.eventSource.on(eventName, () => handleMessageForStatusTable());
    });

    // 用户打断场景：如果状态表LLM还在处理时用户已经把下一条发出去了（新一轮生成开始），
    // 提示应该立即消失——不去打断后台仍在进行的提取/整合本身（它会正常跑完，跑完后
    // hideStatusLlmIndicator 再调一次也没有副作用），只是不再需要显示"生成中"这个状态了。
    const generationStartedEventName = context.event_types.GENERATION_STARTED;
    if (generationStartedEventName) {
      context.eventSource.on(generationStartedEventName, () => hideStatusLlmIndicator());
    }

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
