"use strict";

import { PHONE_INVENTORY_PROMPT_KEY, PHONE_SLOT_PROMPT_KEY, getCtx, notify, persistChatMetadata } from "../core.js";
import { appendPhoneMessage, characterActiveInText, getAllPhoneMessages, getCurrentStoryTime, getLastAiFloor, getPhoneChatState, getPhoneContactCardBody, getRelationshipStageForCharacter, loadPhonePresetContent, markPhoneUpdatedToday, splitInventoryKey, splitStoryTime } from "./store.js";
import { refreshPhoneChatViewIfOpen, setPhoneTypingIndicator } from "./ui.js";
import { generateSummaryRaw } from "../summary/generator.js";
import { rebuildStatusTableFromChat } from "../summary/parser.js";


// ==== 手机私信系统：调用 AI 生成角色回复 ====

// === Helper: 把某联系人的全部历史私信拼成 <private_letter> 标签内的正文。
// 连续消息的 storyTime 相同就归在同一个"时间：xxx"块下，storyTime 变化（含从空变有）时另起一行时间标注；
// 关系阶段统一取"当前实时值"（没有逐条历史快照，只能反映现在的关系状态，不代表发那条消息时的历史关系）。===
export async function buildPrivateLetterBody(characterName) {
  const groups = await getAllPhoneMessages(characterName); // [{dateKey, msgs}]，按时间升序
  const flatMsgs = [];
  groups.forEach((g) => flatMsgs.push(...g.msgs));
  const relevant = flatMsgs.filter(
    (m) => m.from === "user" || m.from === "character",
  );
  if (relevant.length === 0) return "（还没有聊天记录）";

  const relationshipStage =
    await getRelationshipStageForCharacter(characterName);
  const lines = [];
  let lastStoryTime = null;
  relevant.forEach((m) => {
    const storyTime = m.storyTime || "";
    if (storyTime !== lastStoryTime) {
      const stageSuffix = relationshipStage
        ? `  当前俩人关系阶段：${relationshipStage}`
        : "";
      lines.push(`时间：${storyTime || "（未知）"}${stageSuffix}`);
      lastStoryTime = storyTime;
    }
    lines.push(`${m.from === "user" ? "{{user}}" : characterName}: ${m.text}`);
  });
  return lines.join("\n");
}


// becauseFreedReply=true 表示"角色刚从忙碌里变闲，主动补发一条回复"，此时没有用户刚发的新消息可以针对性回复，
// 走"补聊"语气；false 表示针对 userText 这条新消息正常回复。
export async function generateCharacterPhoneReply(
  characterName,
  userText,
  becauseFreedReply,
) {
  const cardBody = await getPhoneContactCardBody(characterName);
  const presetContent = await loadPhonePresetContent();
  // 预设默认内容里用"联系人"占位真实联系人姓名，用户如果保存过自己的版本也统一按这个占位符替换。
  const openingLine = presetContent.split("联系人").join(characterName);
  const { mes: lastAiMes } = getLastAiFloor();
  const letterBody = await buildPrivateLetterBody(characterName);

  const systemPrompt = [
    openingLine,
    `<character_information character="${characterName}">\n${
      cardBody || "gender: \nother: "
    }\n</character_information>`,
    `<Latest_plot>\n${lastAiMes || "（暂无正文）"}\n</Latest_plot>`,
    `<private_letter="${characterName}">\n{{user}}和${characterName}的私信：\n${letterBody}\n</private_letter="${characterName}">`,
    "回复的语气和内容基于 <Latest_plot> 结尾处的最新进展。如果正文角色已经看到了消息并回复了，直接抄录正文角色回复的消息输出就行，" +
      "如果正文角色没有回复消息，且正文结尾角色已经和发信人面对面在一起了，依照情境判断私信是属于悄悄话还是过时的内容，过时内容回复笑脸表情就行。",
    "只输出这一条私信正文本身：第一人称、符合角色说话习惯的一两句话，可以带口语化的语气词/表情，" +
      "但不要加任何前缀、不要写「角色名：」这种称呼前缀，不要加动作/心理描写的括号说明，不要输出多余的解释。",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userContent = becauseFreedReply
    ? `{{user}}之前给你发过消息，需要你输出回复，` +
      `请以「${characterName}」的身份，用一两句话主动回复{{user}}之前的消息（要像真实私信的样子）。`
    : `{{user}}刚发来的新消息：${userText}\n请以「${characterName}」的身份回复这条消息。`;

  const reply = await generateSummaryRaw(systemPrompt, userContent);
  return (reply || "").trim();
}


// === Helper: 角色名出现在最后一层正文里时，调用AI判断这个角色此刻有没有空看/回私信。
// 返回 true=有空（按闲处理，正常生成回复）/false=没空（按忙处理，走 Busy 流程）。
// AI 判断调用失败或解析不出明确结果时，保守按"没空"处理，避免误判打断状态表的 Busy 记录逻辑。===
export async function judgeCharacterHasTimeForPhone(characterName, lastAiMes) {
  const relationshipStage =
    await getRelationshipStageForCharacter(characterName);
  const systemPrompt = [
    `你负责判断角色"${characterName}"此刻是否有空回复{{user}}的私信。`,
    relationshipStage
      ? `{{user}}与该角色当前关系阶段：${relationshipStage}`
      : "",
    `<Latest_plot>\n${lastAiMes || "（暂无正文）"}\n</Latest_plot>`,
    "只根据以上正文里这个角色当前正在做的事、所处场合，判断ta此刻方不方便看通讯器/回私信。" +
      "如果正文里没有出现这个角色，直接输出「是」。" +
      "只输出一个字：方便就输出「是」，不方便就输出「否」，不要输出任何其它内容。",
  ]
    .filter(Boolean)
    .join("\n\n");
  const userContent = `请判断"${characterName}"现在是否有空回私信，只回答"是"或"否"。`;

  try {
    const raw = (await generateSummaryRaw(systemPrompt, userContent)) || "";
    // AI 有时会照抄 prompt 里示范用的引号/书名号格式，输出「是」"否"这类带符号的结果，
    // 先剥掉首尾常见的引号/书名号/标点/星号（markdown加粗）再匹配，避免被误判成"解析不出结果"。
    const trimmed = raw
      .trim()
      .replace(/^[「」『』【】《》（）()""''"'*＊．.。！!,，:：\s]+/, "")
      .replace(/[「」『』【】《》（）()""''"'*＊．.。！!,，:：\s]+$/, "");
    if (/^是/.test(trimmed) || /有空|方便/.test(trimmed)) return true;
    if (/^否/.test(trimmed) || /没空|没有空|不方便/.test(trimmed)) return false;
    return false; // 解析不出明确结果，保守按"没空"处理
  } catch (error) {
    console.error("[剧情助手] 忙闲AI判断失败:", error);
    return false; // 调用失败同样保守按"没空"处理
  }
}


// ==== 手机私信系统：核心流程 ====

// 用户在手机聊天页给某角色发一条消息，返回 { status: "replied", reply } 或 { status: "busy" }。
// 忙/闲判定：楼层号缓存命中就沿用上次"闲"的判断（不重新做文本匹配）；否则按"角色名是否出现在最后一层AI正文里"判定。
export async function sendPhoneMessageToCharacter(characterName, payload) {
  // payload 兼容两种形式：纯文本字符串（原有用法），或 { text, stickerId }（发图片用）。
  const msg = typeof payload === "string" ? { text: payload } : payload || {};
  const text = (msg.text || "").trim();
  if (!text) return null;

  await appendPhoneMessage(characterName, {
    from: "user",
    text,
    stickerId: msg.stickerId || null,
    ts: Date.now(),
    storyTime: getCurrentStoryTime(),
  });
  refreshPhoneChatViewIfOpen(characterName); // 先把用户自己发的这条显示出来，再去判断忙闲状态

  const phoneState = getPhoneChatState();
  const { idx: lastAiIdx, mes: lastAiMes } = getLastAiFloor();

  let treatAsIdle;
  if (lastAiIdx !== -1 && phoneState.idleFloor[characterName] === lastAiIdx) {
    treatAsIdle = true; // 楼层没变，沿用上次"闲"的判断，跳过重新判断
  } else if (!characterActiveInText(characterName, lastAiMes)) {
    treatAsIdle = true; // 正文没出现这个角色名，直接判"闲"，不调用AI
  } else {
    // 正文里出现了角色名，调用AI判断ta此刻有没有空看/回私信，而不是直接判"忙"
    treatAsIdle = await judgeCharacterHasTimeForPhone(characterName, lastAiMes);
  }

  markPhoneUpdatedToday(characterName);

  if (treatAsIdle) {
    phoneState.idleFloor[characterName] = lastAiIdx;
    delete phoneState.busy[characterName];
    await persistChatMetadata();
    setPhoneTypingIndicator(characterName, true); // 确认要调用AI生成回复了，顶部换成"对方正在输入…"
    try {
      const reply = await generateCharacterPhoneReply(
        characterName,
        text,
        false,
      );
      await appendPhoneMessage(characterName, {
        from: "character",
        text: reply || "（对方没有回复任何内容）",
        ts: Date.now(),
        storyTime: getCurrentStoryTime(),
      });
      markPhoneUpdatedToday(characterName);
      await persistChatMetadata();
      return { status: "replied", reply };
    } catch (error) {
      console.error("[剧情助手] 生成私信回复失败:", error);
      notify("error", "私信回复生成失败，请稍后重试。");
      return { status: "error" };
    } finally {
      setPhoneTypingIndicator(characterName, false); // 无论成功/失败，都把顶部标题换回联系人名字
    }
  }

  // 忙碌分支：写入本地缓存的 busy 表，楼层缓存作废（下次变闲要重新走一次完整判断），
  // 立即重算一次状态表把 Busy 行刷进去，不用等下一层新的 AI 楼层。
  phoneState.busy[characterName] = true;
  delete phoneState.idleFloor[characterName];
  await persistChatMetadata();
  await rebuildStatusTableFromChat();
  return { status: "busy" };
}


// 状态表重算时检测到某角色 Busy 被正文 AI 标记 [REMOVE]（即"变闲"）后调用：自动补发一条该角色的回复。
export async function handleCharacterBecameFree(characterName) {
  try {
    const reply = await generateCharacterPhoneReply(characterName, null, true);
    await appendPhoneMessage(characterName, {
      from: "character",
      text: reply || "（对方没有回复任何内容）",
      ts: Date.now(),
      storyTime: getCurrentStoryTime(),
    });
    markPhoneUpdatedToday(characterName);
    await persistChatMetadata();
    notify("info", `「来自${characterName}」的新消息～`);
    refreshPhoneChatViewIfOpen(characterName);
  } catch (error) {
    console.error("[剧情助手] 角色变闲后自动回复生成失败:", error);
    notify(
      "warning",
      `「${characterName}」变闲后自动回复生成失败，请稍后在手机里手动重新发一条消息试试。`,
    );
  }
}


// ==== 手机私信系统：私信槽位（一次性注入正文，AI 生成完这一轮后立即清空）====

// 返回 { content, injectedNames }：content 是拼好的注入文本（可能为空字符串），
// injectedNames 是这一轮实际有消息被塞进 content 的角色列表——只有真正注入了的角色，
// 才允许 clearPhoneSlotPromptAfterRound 清掉它的 pending 标记，避免把没注入成功的私信悄悄标记为"已处理"而丢失。
export async function buildPhoneSlotContent() {
  const phoneState = getPhoneChatState();
  const pendingNames = Object.keys(phoneState.pendingInjection || {}).filter(
    (name) => phoneState.pendingInjection[name],
  );
  if (pendingNames.length === 0) return { content: "", injectedNames: [] };

  // 用"剧情当日"（最后一层正文摘要 Time 字段的日期部分）过滤，而不是现实日历日期——
  // 私信该不该被这一轮正文看到，取决于它是否发生在同一个虚构日期里，跟触发注入这一刻的现实时间无关。
  const currentStoryDate = splitStoryTime(getCurrentStoryTime()).date;

  const blocks = [];
  const injectedNames = [];
  for (const name of pendingNames) {
    // 不再按现实日期查单个分桶，而是拿该角色全部私信（跨真实自然日也没问题），
    // 自己按 storyTime 的日期部分过滤出属于"剧情当日"的那些。
    const allGroups = await getAllPhoneMessages(name);
    const msgs = allGroups
      .flatMap((g) => g.msgs)
      .filter(
        (m) =>
          (m.from === "user" || m.from === "character") &&
          splitStoryTime(m.storyTime).date === currentStoryDate,
      );
    if (msgs.length === 0) continue; // 剧情日期暂时对不上，这轮不注入，pending 保留，等日期对上再补

    // 按 storyTime 分组：只有当这条消息的 storyTime 跟上一条不一样时才插入一行"时间："，
    // 同一时间点下的连续消息共用这一行，不重复输出（同一剧情日的消息本来就同属一天，storyTime 只会是时辰在变）。
    const lines = [];
    let lastStoryTime = null;
    msgs.forEach((m) => {
      const speaker = m.from === "user" ? "{{user}}" : name;
      if (m.storyTime && m.storyTime !== lastStoryTime) {
        lines.push(`时间：${m.storyTime}`);
        lastStoryTime = m.storyTime;
      }
      lines.push(`${speaker}: ${m.text}`);
    });

    blocks.push(
      `<private_letter="${name}">\n今日{{user}}和${name}的私信：\n${lines.join("\n")}\n</private_letter="${name}">`,
    );
    injectedNames.push(name);
  }
  return { content: blocks.join("\n\n"), injectedNames };
}


// 记录"最近一次 applyPhoneSlotPrompt 实际注入了哪些角色"，供 clearPhoneSlotPromptAfterRound 精确清理 pending 用。
// 生成开始（写入这个变量）和生成结束（读取并清空）之间由酒馆的事件顺序保证先后，同一时刻只有一轮生成在跑，
// 不需要更复杂的传参/加锁机制。
export let lastInjectedPhoneNames = [];


export async function applyPhoneSlotPrompt() {
  try {
    const context = getCtx();
    if (typeof context.setExtensionPrompt !== "function") {
      console.warn(
        "[剧情助手] 当前酒馆版本未暴露 setExtensionPrompt，私信槽位注入未启用。",
      );
      return;
    }
    const { content, injectedNames } = await buildPhoneSlotContent();
    lastInjectedPhoneNames = injectedNames;
    // 用 IN_CHAT + depth=0，让内容紧贴最新一楼插入聊天记录里（跟"对话前强调"等常驻注入的 atDepth 语义一致），
    // 而不是 IN_PROMPT（插在角色卡定义附近，跟实际聊天记录结构性隔开，容易被当成孤立指令而非背景上下文）。
    const position = context.extension_prompt_types?.IN_CHAT ?? 1;
    const role = context.extension_prompt_roles?.SYSTEM ?? 0;
    context.setExtensionPrompt(
      PHONE_SLOT_PROMPT_KEY,
      content,
      position,
      0,
      false,
      role,
    );
  } catch (error) {
    console.error("[剧情助手] 注入私信槽位时出错:", error);
  }
}


export function clearPhoneSlotPromptAfterRound() {
  try {
    const context = getCtx();
    if (typeof context.setExtensionPrompt === "function") {
      const position = context.extension_prompt_types?.IN_CHAT ?? 1;
      const role = context.extension_prompt_roles?.SYSTEM ?? 0;
      context.setExtensionPrompt(
        PHONE_SLOT_PROMPT_KEY,
        "",
        position,
        0,
        false,
        role,
      );
    }
    const phoneState = getPhoneChatState();
    // 只清掉这一轮实际注入了的角色。没被注入的——剧情日期没对上、或者注入快照之后、
    // 这轮生成结束之前又新产生的 pending——继续保留，等下一轮再补注入，不会被这里误清掉。
    lastInjectedPhoneNames.forEach((name) => {
      phoneState.pendingInjection[name] = false;
    });
    lastInjectedPhoneNames = [];
    persistChatMetadata();
  } catch (error) {
    console.error("[剧情助手] 清空私信槽位时出错:", error);
  }
}


// 购物页手动改动库存后，一次性提醒正文AI"这一轮请在摘要模块的 Inventory 字段里同步这些变化"。
// AI 输出后经由常规的 mergeFloorIntoStatusTable 合并进状态表，就变成"历史"的一部分了——
// 后续再触发 rebuildStatusTableFromChat 全量重放时也不会把这次手动改动冲掉。
export function applyPendingInventoryChangePrompt() {
  try {
    const context = getCtx();
    if (typeof context.setExtensionPrompt !== "function") return;
    const pending = getPhoneChatState().pendingInventoryChanges;
    const keys = Object.keys(pending);
    if (keys.length === 0) return;
    const lines = keys
      .map((key) => {
        const parsed = splitInventoryKey(key);
        if (!parsed) return null;
        const change = pending[key];
        return change.deleted
          ? `- ${parsed.owner}的"${parsed.item}"应被移除`
          : `- ${parsed.owner}的"${parsed.item}"应变为：${change.quantity}`;
      })
      .filter(Boolean);
    if (lines.length === 0) return;
    const content =
      `{{user}}刚在手机购物页手动调整了随身物品，请在本轮摘要模块的 Inventory 字段里同步输出这些变化` +
      `（沿用 +N/-N/=N/[REMOVE] 格式，格式：所有者·物品名: 值）：\n` +
      lines.join("\n");
    const position = context.extension_prompt_types?.IN_CHAT ?? 1;
    const role = context.extension_prompt_roles?.SYSTEM ?? 0;
    context.setExtensionPrompt(
      PHONE_INVENTORY_PROMPT_KEY,
      content,
      position,
      0,
      false,
      role,
    );
  } catch (error) {
    console.error("[剧情助手] 注入购物页库存变更提醒时出错:", error);
  }
}


export function clearPendingInventoryChangePromptAfterRound() {
  try {
    const context = getCtx();
    if (typeof context.setExtensionPrompt === "function") {
      const position = context.extension_prompt_types?.IN_CHAT ?? 1;
      const role = context.extension_prompt_roles?.SYSTEM ?? 0;
      context.setExtensionPrompt(
        PHONE_INVENTORY_PROMPT_KEY,
        "",
        position,
        0,
        false,
        role,
      );
    }
    getPhoneChatState().pendingInventoryChanges = {};
    persistChatMetadata();
  } catch (error) {
    console.error("[剧情助手] 清空购物页库存变更提醒时出错:", error);
  }
}


// 注册"生成前注入 / 生成后清空"监听。GENERATION_STARTED 在部分酒馆版本里可能不存在，
// 找不到时只打印警告、不阻断其它功能——这一点需要你在实际环境验证一下具体的事件名是否可用。
export function registerPhoneSlotInjection() {
  try {
    const context = getCtx();
    if (!context.eventSource || !context.event_types) {
      console.warn(
        "[剧情助手] 未找到 eventSource/event_types，私信槽位注入未启用。",
      );
      return;
    }
    const startEventName =
      context.event_types.GENERATION_STARTED ||
      context.event_types.GENERATE_BEFORE_COMBINE_PROMPTS;
    if (startEventName) {
      context.eventSource.on(startEventName, () => {
        applyPhoneSlotPrompt();
        applyPendingInventoryChangePrompt();
      });
    } else {
      console.warn(
        "[剧情助手] 未找到生成开始事件（GENERATION_STARTED），私信槽位注入未启用，把控制台日志发我调整。",
      );
    }
    const renderEventName =
      context.event_types.CHARACTER_MESSAGE_RENDERED ||
      context.event_types.MESSAGE_RECEIVED;
    if (renderEventName) {
      context.eventSource.on(renderEventName, () => {
        clearPhoneSlotPromptAfterRound();
        clearPendingInventoryChangePromptAfterRound();
      });
    }
  } catch (error) {
    console.error("[剧情助手] 注册私信槽位注入监听时出错:", error);
  }
}
