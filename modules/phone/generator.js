"use strict";

import { PHONE_MESSAGE_FROM, PHONE_SLOT_PROMPT_KEY, getCtx, getLastAiFloor, notify, persistChatMetadata } from "../core.js";
import { appendPhoneMessage, getAllPhoneMessages, getPhoneChatState, getPhoneContactCardBody, getRelationshipStageForCharacter, loadPhonePresetContent, markPhoneUpdatedToday, splitStoryTime } from "./store.js";
import { characterActiveInText, getCurrentStoryTime } from "./parser.js";
import { refreshPhoneChatViewIfOpen, setPhoneTypingIndicator } from "./ui.js";
import { generateSummaryRaw } from "../summary/generator.js";
import { rebuildStatusTableFromChat } from "../summary/status-table.js";


// ==== 手机私信系统：调用 AI 生成角色回复 ====

// === Helper: 把某联系人的全部历史私信拼成 <private_letter> 标签内的正文。
// 连续消息的 storyTime 相同就归在同一个"时间：xxx"块下，storyTime 变化（含从空变有）时另起一行时间标注；
// 关系阶段统一取"当前实时值"（没有逐条历史快照，只能反映现在的关系状态，不代表发那条消息时的历史关系）。===
export async function buildPrivateLetterBody(characterName) {
  const groups = await getAllPhoneMessages(characterName); // [{dateKey, msgs}]，按时间升序
  const flatMsgs = [];
  groups.forEach((g) => flatMsgs.push(...g.msgs));
  const relevant = flatMsgs.filter(
    (m) => m.from === PHONE_MESSAGE_FROM.USER || m.from === PHONE_MESSAGE_FROM.CHARACTER,
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
    lines.push(`${m.from === PHONE_MESSAGE_FROM.USER ? "{{user}}" : characterName}: ${m.text}`);
  });
  return lines.join("\n");
}


// 忙碌哨兵：合并判断命中"忙"分支时的约定输出。选一句不太可能出现在正常私信回复里的完整短句，
// 而不是单字「忙」，避免角色正常回复里恰好带到"忙"字（比如"今天有点忙，晚点聊~"）被误判成忙碌分支。
const PHONE_BUSY_SENTINEL = "忙碌中~现在没空回复私信。";

// === Helper: 剥掉AI输出首尾常见的引号/书名号/标点/星号（markdown加粗）等包装符号，
// 给下面两处"判断输出是不是某个约定哨兵/关键词"的场景共用，避免格式包装导致精确匹配失败。===
function stripWrappingPunctuation(raw) {
  return (raw || "")
    .trim()
    .replace(/^[「」『』【】《》（）()""''"'*＊．.。！!,，:：\s]+/, "")
    .replace(/[「」『』【】《》（）()""''"'*＊．.。！!,，:：\s]+$/, "");
}


// === 简化模板：纯粹"以角色口吻回复{{user}}的私信"，不做忙闲/已读/抄录判断，也不带 <Latest_plot>。
// 两处共用：①同一楼层已经判过"闲"、后续新消息直接走这里；②角色没出现在最新正文里。
// 这两种场景下角色都是"单纯有空看手机"，且这条新消息不可能已经被"更早生成"的正文回复或已读，
// 已读😊/抄录正文这两条规则天然不会命中，没有必要再带正文进去判断（省 token，也避免节外生枝套用正文情节）。
export async function generateSimplePhoneReply(characterName, userText) {
  const cardBody = await getPhoneContactCardBody(characterName);
  const presetContent = loadPhonePresetContent();
  const letterBody = await buildPrivateLetterBody(characterName);

  const systemPrompt = [
    presetContent,
    `你负责扮演角色"${characterName}"，根据<private_letter>历史聊天内容，给{{user}}回一条私信。`,
    "你会收到以下几部分输入：\n" +
      `1. <character_information>：角色"${characterName}"的角色卡资料（性别、性格背景等）。\n` +
      "2. <private_letter>：{{user}}和该角色迄今为止的私信记录，包含时间和当前俩人关系阶段。",
    `<character_information character="${characterName}">\n${
      cardBody || "gender: \nother: "
    }\n</character_information>`,
    `<private_letter name="${characterName}">\n{{user}}和${characterName}的私信：\n${letterBody}\n</private_letter>`,
    "正常编一条符合角色语气、针对最新这条私信内容的回复。\n" +
      "输出格式要求：只输出这一条私信正文本身——第一人称、符合角色说话习惯的一两句话，可以带口语化的语气词/表情。\n" +
      "不要加任何前缀，不要写「角色名：」这种称呼前缀，不要加动作/心理描写的括号说明，不要输出多余的解释。",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userContent = `{{user}}刚发来的新消息：${userText}\n请以「${characterName}」的身份回复这条消息。`;

  const reply = await generateSummaryRaw(systemPrompt, userContent);
  return (reply || "").trim();
}


// === 补聊模板：状态表检测到角色 Busy 被 [REMOVE]（正文里判定角色变闲）后专用。
// 跟上面的简化模板不同，这里必须带 <Latest_plot>——角色是刚从忙碌解除，正文里很可能就是
// "角色变闲的那个动作/场景"，里面有不小概率已经当面回复过用户私信里最新的内容（比如原本在忙，
// 后来忙完了在正文里转头回了一句），这种情况要抄录正文原话，而不是凭空再编一条重复的回复；
// 没有当面回过，才走"主动补聊"生成一条新的。===
export async function generateFreedPhoneReply(characterName) {
  const cardBody = await getPhoneContactCardBody(characterName);
  const presetContent = loadPhonePresetContent();
  const { mes: lastAiMes } = getLastAiFloor();
  const letterBody = await buildPrivateLetterBody(characterName);

  const systemPrompt = [
    presetContent,
    `你负责扮演角色"${characterName}"，ta刚从忙碌中脱身，需要给{{user}}回一条私信。`,
    "你会收到以下几部分输入：\n" +
      `1. <character_information>：角色"${characterName}"的角色卡资料（性别、性格背景等）。\n` +
      "2. <Latest_plot>：酒馆正文最后一层AI楼层原文，代表\"当前时刻\"实际发生的事（角色刚变闲的那个场景）。\n" +
      "3. <private_letter>：{{user}}和该角色迄今为止的私信记录，包含时间和当前俩人关系阶段。",
    `<character_information character="${characterName}">\n${
      cardBody || "gender: \nother: "
    }\n</character_information>`,
    `<Latest_plot>\n${lastAiMes || "（暂无正文）"}\n</Latest_plot>`,
    `<private_letter name="${characterName}">\n{{user}}和${characterName}的私信：\n${letterBody}\n</private_letter>`,
    "判断规则（依次检查，命中哪条就按哪条执行，不要同时套用多条）：\n" +
      "1. 如果 <Latest_plot> 里角色已经当面/在场景中回复过 {{user}} 最新这条私信的内容：\n" +
      "   直接原样照抄正文里角色说的那句话，作为私信回复输出。\n" +
      "2. 否则（正文里没有当面回过）：\n" +
      "   正常编一条符合角色语气、主动补聊的回复，遵循下面的输出格式要求。",
    "输出格式要求（仅适用于命中规则2的情况）：\n" +
      "只输出这一条私信正文本身——第一人称、符合角色说话习惯的一两句话，可以带口语化的语气词/表情。\n" +
      "不要加任何前缀，不要写「角色名：」这种称呼前缀，不要加动作/心理描写的括号说明，不要输出多余的解释。",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userContent =
    `{{user}}之前给你发过消息，需要你输出回复，` +
    `请以「${characterName}」的身份判断并输出结果。`;

  const reply = await generateSummaryRaw(systemPrompt, userContent);
  return (reply || "").trim();
}




// === 合并 5 分支判断：只在"新楼层、角色出现在正文里、这一层还没判过"时调用，一次调用同时完成
// 忙闲判断 + 已读/抄录/正常回复的生成，取代原来"先判忙闲、闲了再单独生成回复"的两次调用。
// 返回 { busy: true } 表示命中忙碌分支；否则返回 { busy: false, reply }。
// AI 判断调用失败时，保守按"没空"处理，避免误判打断状态表的 Busy 记录逻辑。===
export async function judgeAndGeneratePhoneReply(characterName, userText) {
  const cardBody = await getPhoneContactCardBody(characterName);
  const presetContent = loadPhonePresetContent();
  const { mes: lastAiMes } = getLastAiFloor();
  const letterBody = await buildPrivateLetterBody(characterName);
  const relationshipStage =
    await getRelationshipStageForCharacter(characterName);

  const systemPrompt = [
    presetContent,
    `你负责扮演角色"${characterName}"，判断ta此刻要怎么处理{{user}}刚发来的这条私信，并直接给出最终要发送的内容。`,
    "你会收到以下几部分输入：\n" +
      `1. <character_information>：角色"${characterName}"的角色卡资料（性别、性格背景等）。\n` +
      "2. <Latest_plot>：酒馆正文最后一层AI楼层原文，代表\"当前时刻\"实际发生的事。\n" +
      "3. <private_letter>：{{user}}和该角色迄今为止的私信记录，包含时间和当前俩人关系阶段。",
    `<character_information character="${characterName}">\n${
      cardBody || "gender: \nother: "
    }\n</character_information>`,
    relationshipStage
      ? `{{user}}与该角色当前关系阶段：${relationshipStage}`
      : "",
    `<Latest_plot>\n${lastAiMes || "（暂无正文）"}\n</Latest_plot>`,
    `<private_letter name="${characterName}">\n{{user}}和${characterName}的私信：\n${letterBody}\n</private_letter>`,
    "判断规则（依次检查，命中哪条就按哪条执行，不要同时套用多条）：\n" +
      "1. 如果角色没有出现在 <Latest_plot> 里（不在最新正文场景中）：\n" +
      "   以角色口吻对{{user}}的私信内容输出正常回复，遵循下面的输出格式要求。\n" +
      "2. 否则，如果<Latest_plot> 里这个角色此刻正忙于某事，没空看/回通讯器：\n" +
      `   只输出这一句固定内容，不要输出任何其它文字：${PHONE_BUSY_SENTINEL}\n` +
      "3. 否则，如果 <Latest_plot> 角色已经知晓{{user}}的私信内容但未回复{{user}}：\n" +
      "   只输出「😊」这一个表情符号代表\"已读\"，不输出任何其它文字。\n" +
      "4. 否则，如果 <Latest_plot> 里角色已经在场景中回复过这条私信的内容：\n" +
      "   直接照抄正文里角色的回复内容原样输出。\n" +
      "5. 否则（角色在正文里出现，就是单纯有空看手机，默认ta阅读到了这条私信）：\n" +
      "   以角色口吻对{{user}}的私信内容输出正常回复，遵循下面的输出格式要求。",
    "输出格式要求（仅适用于命中规则1、5的情况）：\n" +
      "只输出这一条私信正文本身——第一人称、符合角色说话习惯的一两句话，可以带口语化的语气词/表情。\n" +
      "不要加任何前缀，不要写「角色名：」这种称呼前缀，不要加动作/心理描写的括号说明，不要输出多余的解释。",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userContent = `{{user}}刚发来的新消息：${userText}\n请以「${characterName}」的身份判断并输出结果。`;

  try {
    const raw = (await generateSummaryRaw(systemPrompt, userContent)) || "";
    const trimmed = stripWrappingPunctuation(raw);
    if (trimmed === stripWrappingPunctuation(PHONE_BUSY_SENTINEL)) {
      return { busy: true };
    }
    return { busy: false, reply: raw.trim() };
  } catch (error) {
    console.error("[剧情助手] 私信合并判断失败:", error);
    return { busy: true }; // 调用失败保守按"没空"处理，不误判打断状态表的 Busy 记录逻辑
  }
}


// ==== 手机私信系统：核心流程 ====

// 用户在手机聊天页给某角色发一条消息，返回 { status: "replied", reply } 或 { status: "busy" }。
// 忙/闲判定：
// - 忙标记（busy）只由下面的合并判断打上，不跟随楼层，一直生效到被状态表联动清除（handleCharacterBecameFree），
//   所以只要 busy[characterName] 为 true 就直接静默返回，不再调用任何 AI。
// - 闲标记（judgedFloor）跟随楼层号：同一楼层内判过一次闲，后续新消息直接走简化模板，跳过合并判断；
//   楼层一变就要重新走一次完整的合并判断（前提是这时 busy 不是 true）。
export async function sendPhoneMessageToCharacter(characterName, payload) {
  // payload 兼容两种形式：纯文本字符串（原有用法），或 { text, stickerId }（发图片用）。
  const msg = typeof payload === "string" ? { text: payload } : payload || {};
  const text = (msg.text || "").trim();
  if (!text) return null;

  await appendPhoneMessage(characterName, {
    from: PHONE_MESSAGE_FROM.USER,
    text,
    stickerId: msg.stickerId || null,
    ts: Date.now(),
    storyTime: getCurrentStoryTime(),
  });
  await refreshPhoneChatViewIfOpen(characterName); // 先把用户自己发的这条显示出来，再去判断忙闲状态

  const phoneState = getPhoneChatState();

  // 忙标记只受状态表联动控制，跟楼层无关：只要还没被解除，就一直静默返回，不调用任何 AI。
  if (phoneState.busy[characterName]) {
    markPhoneUpdatedToday(characterName);
    await persistChatMetadata();
    return { status: "busy" };
  }

  const { idx: lastAiIdx, mes: lastAiMes } = getLastAiFloor();
  const alreadyJudgedThisFloor =
    lastAiIdx !== -1 && phoneState.judgedFloor[characterName] === lastAiIdx;
  const characterActive = characterActiveInText(characterName, lastAiMes);

  markPhoneUpdatedToday(characterName);
  setPhoneTypingIndicator(characterName, true); // 确认要调用AI了，顶部换成"对方正在输入…"
  try {
    if (alreadyJudgedThisFloor || !characterActive) {
      // 同层已判过闲，或角色压根没出现在最新正文里：都是"单纯有空看手机"，直接用简化模板生成回复，不必再走合并判断。
      phoneState.judgedFloor[characterName] = lastAiIdx;
      await persistChatMetadata();
      const reply = await generateSimplePhoneReply(characterName, text);
      await appendPhoneMessage(characterName, {
        from: PHONE_MESSAGE_FROM.CHARACTER,
        text: reply || "（对方没有回复任何内容）",
        ts: Date.now(),
        storyTime: getCurrentStoryTime(),
      });
      markPhoneUpdatedToday(characterName);
      await persistChatMetadata();
      return { status: "replied", reply };
    }

    // 新楼层、角色在场、这一层还没判过：走合并判断，一次调用同时给出忙/闲结果和（如果闲）最终回复内容。
    const result = await judgeAndGeneratePhoneReply(characterName, text);
    if (result.busy) {
      // 忙碌分支：写入本地缓存的 busy 表，立即重算一次状态表把 Busy 行刷进去，不用等下一层新的 AI 楼层。
      phoneState.busy[characterName] = true;
      await persistChatMetadata();
      await rebuildStatusTableFromChat();
      return { status: "busy" };
    }

    phoneState.judgedFloor[characterName] = lastAiIdx;
    await persistChatMetadata();
    const reply = result.reply;
    await appendPhoneMessage(characterName, {
      from: PHONE_MESSAGE_FROM.CHARACTER,
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


// 状态表重算时检测到某角色 Busy 被正文 AI 标记 [REMOVE]（即"变闲"）后调用：自动补发一条该角色的回复。
// 用专门的补聊模板（带 <Latest_plot>，内含"抄录/主动补聊"两分支），不复用合并判断的 5 分支模板；
// 生成完之后把这一层记为"已判过闲"，避免用户紧接着在同一楼层继续私信时又触发一次合并判断。
export async function handleCharacterBecameFree(characterName) {
  try {
    const reply = await generateFreedPhoneReply(characterName);
    await appendPhoneMessage(characterName, {
      from: PHONE_MESSAGE_FROM.CHARACTER,
      text: reply || "（对方没有回复任何内容）",
      ts: Date.now(),
      storyTime: getCurrentStoryTime(),
    });
    const { idx: lastAiIdx } = getLastAiFloor();
    const phoneState = getPhoneChatState();
    if (lastAiIdx !== -1) phoneState.judgedFloor[characterName] = lastAiIdx;
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

// === Helper: 给定一批角色名，拼出他们"剧情当日"私信的 <private_letter> 文本块。
// 剧情LLM（buildPhoneSlotContent）和状态表LLM（buildPhoneLetterContentForStatusLlm）
// 都靠这份文本判断当天私信里的关系变化/约定，两边内容必须一致，所以抽成同一份实现，不各写一套。===
async function buildPhoneLetterBlocksForNames(names) {
  if (!names || names.length === 0) return { content: "", injectedNames: [] };

  // 用"剧情当日"（最后一层正文摘要 Time 字段的日期部分）过滤，而不是现实日历日期——
  // 私信该不该被这一轮看到，取决于它是否发生在同一个虚构日期里，跟触发这一刻的现实时间无关。
  const currentStoryDate = splitStoryTime(getCurrentStoryTime()).date;

  const blocks = [];
  const injectedNames = [];
  for (const name of names) {
    // 不按现实日期查单个分桶，而是拿该角色全部私信（跨真实自然日也没问题），
    // 自己按 storyTime 的日期部分过滤出属于"剧情当日"的那些。
    const allGroups = await getAllPhoneMessages(name);
    const msgs = allGroups
      .flatMap((g) => g.msgs)
      .filter(
        (m) =>
          (m.from === PHONE_MESSAGE_FROM.USER || m.from === PHONE_MESSAGE_FROM.CHARACTER) &&
          splitStoryTime(m.storyTime).date === currentStoryDate,
      );
    if (msgs.length === 0) continue; // 剧情日期暂时对不上，这轮跳过

    // 按 storyTime 分组：只有当这条消息的 storyTime 跟上一条不一样时才插入一行"时间："，
    // 同一时间点下的连续消息共用这一行，不重复输出（同一剧情日的消息本来就同属一天，storyTime 只会是时辰在变）。
    const lines = [];
    let lastStoryTime = null;
    msgs.forEach((m) => {
      const speaker = m.from === PHONE_MESSAGE_FROM.USER ? "{{user}}" : name;
      if (m.storyTime && m.storyTime !== lastStoryTime) {
        lines.push(`时间：${m.storyTime}`);
        lastStoryTime = m.storyTime;
      }
      lines.push(`${speaker}: ${m.text}`);
    });

    blocks.push(
      `<private_letter name="${name}">\n今日{{user}}和${name}的私信：\n${lines.join("\n")}\n</private_letter>`,
    );
    injectedNames.push(name);
  }
  return { content: blocks.join("\n\n"), injectedNames };
}


// 返回 { content, injectedNames }：content 是拼好的注入文本（可能为空字符串），
// injectedNames 是这一轮实际有消息被塞进 content 的角色列表——只有真正注入了的角色，
// 才允许 clearPhoneSlotPromptAfterRound 清掉它的 pending 标记，避免把没注入成功的私信悄悄标记为"已处理"而丢失。
export async function buildPhoneSlotContent() {
  const phoneState = getPhoneChatState();
  const pendingNames = Object.keys(phoneState.pendingInjection || {}).filter(
    (name) => phoneState.pendingInjection[name],
  );
  return buildPhoneLetterBlocksForNames(pendingNames);
}


// 供状态表LLM复用：拼出"这一轮实际注入给剧情LLM看过"的私信内容，供状态表LLM判断 Agreements（约定）
// 时也能看到同一批私信——不这样做的话，私信里提到的约定状态表LLM完全看不到，会漏记。
// 故意不依赖 pendingInjection 标记：那个标记在 clearPhoneSlotPromptAfterRound 里会被清掉，
// 而"状态表LLM提取"和"清空私信槽位"绑在同一个渲染事件上，谁先跑不可控，依赖它会有时序竞争；
// lastInjectedPhoneNames 只是"这一轮实际注入过谁"的只读记录，不受清空动作影响，读到的永远是这一轮的真实名单。
export async function buildPhoneLetterContentForStatusLlm() {
  return buildPhoneLetterBlocksForNames(lastInjectedPhoneNames);
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
    // 忙碌中的角色额外保留 pending=true：只要 busy 状态没被正文 AI 用 [REMOVE] 解除，
    // 私信内容就每轮持续注入，直到 busy 解除的下一轮才会走到这里被清空（此时 busy[name] 已不存在）。
    lastInjectedPhoneNames.forEach((name) => {
      if (phoneState.busy[name]) return;
      phoneState.pendingInjection[name] = false;
    });
    lastInjectedPhoneNames = [];
    persistChatMetadata();
  } catch (error) {
    console.error("[剧情助手] 清空私信槽位时出错:", error);
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
      });
    }
  } catch (error) {
    console.error("[剧情助手] 注册私信槽位注入监听时出错:", error);
  }
}
