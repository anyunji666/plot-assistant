"use strict";

import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";

// =====================================================================================
// 剧情助手（原生 SillyTavern 第三方扩展，不依赖「酒馆助手」插件）
// 全部使用 SillyTavern.getContext() 暴露的原生接口：
//   - 读聊天记录：context.chat
//   - 生成文本：context.generateRaw({ prompt, systemPrompt })
//   - 世界书读写：context.loadWorldInfo / context.saveWorldInfo / context.getWorldInfoNames / context.updateWorldInfoList
//   - 弹窗/确认框：context.callGenericPopup + context.POPUP_TYPE / context.POPUP_RESULT
//   - 提示条：toastr（酒馆全局自带）
// 六个按钮：自动小总结 / 设定起始楼层 / 自动大总结 / 对话前强调 / 创建角色 / 地图标记。
// 入口收敛为扩展菜单里的一个「剧情助手」条目，点开弹出控制面板；地图编辑器另有一个右下角悬浮球入口。
// "对话前强调"与自动/大总结共用同一本总结世界书（getOrCreateSummaryLorebook 拿到的"角色名+总结"）。
// "地图标记"按角色名自动区分数据，内容写入同一本"角色名总结"世界书里固定标题为「地图信息」的一条条目，
// 跟其他总结条目同级存在。
// "创建角色"和总结/状态表共用同一本"角色名总结"世界书，标题固定加「角色卡：」前缀；
// 条目按人名关键词触发（selective，非常驻），只有正文提到该人名时才会注入上下文，节省 token。
// 编辑/删除复用面板下方已有的通用世界书条目列表，不再单独维护一套角色列表 UI。
// =====================================================================================

// === Constants ===
const AUTO_BATCH_SIZE = 30; // 自动小总结每批楼层数
const SMALL_SUMMARY_TITLE_PREFIX = "小总结："; // 小总结世界书条目标题前缀，后面拼接"起-止"楼层号
const LARGE_SUMMARY_TITLE = "大总结"; // 大总结世界书条目固定标题
const PRE_EMPHASIS_TITLE = "对话前强调"; // 对话前强调世界书条目固定标题
const MAP_INFO_TITLE = "地图信息"; // 地图标记模块自动生成/覆盖的世界书条目固定标题，跟其他总结条目同级存在
const PHONE_PRESET_TITLE = "私信预设"; // 手机私信开场白预设世界书条目固定标题，跟角色卡条目一样 disable:true 常驻、不参与主线注入，插件直接读取内容使用
// "私信预设"条目首次创建前用于预填编辑框的默认内容——手机私信生成提示词里唯一可编辑的部分（开场白/扮演指令），
// 其余结构（人设/最新正文/私信历史块）和输出格式要求都写死在代码里，不放进这段可编辑文本。
// "联系人"是占位符，实际调用时会被替换成真实联系人姓名。
const DEFAULT_PHONE_PRESET_CONTENT = `请你在<private_letter="联系人">中扮演联系人和{{user}}聊天，注意俩人当前关系，口吻参考角色性格背景。`;
// 对话前强调条目的默认位置设置：@D 在深度0、order 999、概率100%，仅在条目首次创建时生效；
// 已存在的条目只更新标题/内容/启用状态，
// 不会覆盖你之后在世界书面板里手动调整过的位置/深度等设置。
const PRE_EMPHASIS_ENTRY_DEFAULTS = {
  position: 4, // 原生 world_info_position: atDepth
  depth: 0,
  role: 1, // extension_prompt_roles: USER
  order: 999,
  probability: 100,
};

// "对话前强调"条目首次创建前（世界书里还没有这条条目时）用于预填编辑框的默认内容——
// 即摘要输出协议全文，与插件本身的解析逻辑（parseSummaryLayer / applyNumericMapUpdates 等）保持一致。
// 仅用于"首次打开编辑框时给你一个起点"，默认不启用（disable: true）；一旦你保存过一次（无论是否修改），
// 之后 loadPreEmphasisEntry 读到的就是你保存的实际内容，不会再被这个默认值覆盖。
const DEFAULT_PRE_EMPHASIS_CONTENT = `### [MANDATORY] Summary Output Protocol
每次回复必须以摘要块结尾（选项/备注等放在它前面），永远是回复最后一个模块。缺失=不合格。

---
**输出格式：**
\`\`\`
---
<details><summary>摘要</summary>
(字段标签需保持英文，内容为中文)
Time: \${本轮场景结束时刻，精确到年月日+时分；日期不明则自拟符合背景的纪年}
Location: \${本轮场景最后所在地点}
Relationships: \${{{user}}→角色: 关系词}
Inventory: \${角色名·物品名: 数量}
Setups: \${角色名·关键词: 简介}
Busy: \${仅当Snapshot Table的Busy快照里列出的角色本轮未出现或拿“通讯器”回复消息时才输出，格式见下方Busy规则}
Overview: \${本轮关键事件按时间顺序列出}
</details>
\`\`\`

---
**字段判定规则（伪代码）：**

**Relationships**（只写本轮变化，无变化则留空，多组分号分隔，按顺序执行）
\`\`\`
for 角色 in 本轮关系有变化的角色:
    if 死亡/永久离场: 值 = [REMOVE]  # Relationships中唯一使用REMOVE的情况，其余覆盖式改写
    elif 存在身份/血亲关系:
        值 = 从【身份词】∪【血亲词】表选唯一最匹配项
        # 身份词：师徒 / 师兄弟 / 师兄妹 / 师姐妹 / 师姐弟 / 义兄弟 / 义兄妹 / 义姐妹 / 义姐弟 / 同门 / 同学 / 同事 / 邻居 / 网友 / 战友 / 上下级 / 继父子 / 继父女 / 继母子 / 继母女 / 主仆 / 学长学弟 / 学长学妹 / 学姐学弟 / 学姐学妹 / 师生 / 校友 / 室友 / 甲乙方 / 合伙人 / 医患 / 队友 / 教练学员 / 房东租客 / 粉丝偶像
        # 血亲词：父女 / 父子 / 母女 / 母子 / 兄弟 / 兄妹 / 姐弟 / 姐妹 / 祖孙 / 叔侄 / 舅甥 / 姑侄 / 姨甥 / 表兄弟 / 表兄妹 / 表姐弟 / 表姐妹 / 堂兄弟 / 堂兄妹 / 堂姐弟 / 堂姐妹
    else:
        值 = 从【阶段词】表选唯一最匹配项
        # 阶段词：陌生 / 相识 / 相熟 / 好感 / 暧昧 / 恋人 / 未婚夫妻 / 夫妻 / 对手 / 仇人 / 宿敌 / 同伴 / 盟友 / 朋友 / 挚友
# 身份词/血亲词可加括号填写表示关系变化的阶段词。阶段词只能是独立词，不能加括号补充其它内容，关系变化直接选用新的阶段词覆盖式改写
# 格式：{{user}}→角色A: 值；
# 值只能是 [REMOVE] /表内词，禁止自造/留空。正例："师徒(暧昧)" 反例："朋友(渐生好感中)"
\`\`\`

**Inventory**（只写本轮变化，无变化则留空，多组分号分隔，按顺序执行）
\`\`\`
for 道具变化 in 本轮:
    if not 可随身携带实体物品: 跳过  # 状态/情形归Overview
    if 全部用尽/全部送出/丢失: 值 = [REMOVE]
    elif 首次记录/需硬修正历史值: 值 = "=N"
    elif 得到/获得/新增: 值 = "+N"
    elif 部分消耗/部分送出(未归零): 值 = "-N"
# 格式：角色名·物品名: 值；
# 值只能是[REMOVE]/=N/+N/-N，N为纯数字。正例："+2" "=3"　反例："+2瓶" "=3个(备用)"
\`\`\`

**Setups**（只写本轮变化，无变化则留空，多组分号分隔，按顺序执行）
\`\`\`
Step1 存量清理：旧条目已兑现/作废/不可能再被拾起 → 角色名·关键词: [REMOVE]
Step2 新增：本轮是否出现值得长线追踪的伏笔/线索/未解约定？
    以下情况不记录：
      - 单纯的意图/打算（"她想...""他计划..."）不记 → 需要记录的是已发生的事实
      - 单纯关系状态变化(归Relationships) / 纯事件叙述(归Overview) / 本轮内已解决的伏笔(归Overview)
Step3 格式：角色名·关键词: (日期·地点)+一句话钩子；（日期具体到年月日，整体不超30字）
\`\`\`

**Busy**（Busy条目唯一要做的是添加[REMOVE]标记，清除本轮未出现或拿起“通讯器”查看并回复消息的角色，多组分号分隔）
\`\`\`
for 角色 in Snapshot Table当前Busy快照里列出的角色:
    if 角色本轮没有出现在正文场景里（不在场/未登场/未被提及活动）或角色察觉到了“通讯器”有新消息并回复了: 值 = [REMOVE]
    else: 跳过，不输出这个角色
# 格式：角色名: [REMOVE]；
# 值只能是[REMOVE]，这是Busy字段唯一合法的值；不要自己新增角色到Busy、不要写"忙"这类其它取值
\`\`\`

**Overview**（无实质进展留空，不超150字）
\`\`\`
按时间顺序列出关键事件+其造成的实际改变(关系/处境/认知)，平铺直叙，不用比喻/形容词。
\`\`\`

---
**Snapshot Table**：上文已注入Relationships/Inventory/Setups/Busy的只读快照表，仅用于查看当前状态及填写[REMOVE]清除过期条目。其中Busy列出的是"被判定为忙碌、暂时没空回复私信"的角色——本轮如果这些角色没有出现在正文场景或回复消息了，需要在Busy字段里写"角色名: [REMOVE]"，把它从忙碌状态里清掉。

---
**示例（仅供格式参考）：**
\`\`\`
---
<details><summary>摘要</summary>
Time: 武定三年三月十五,申时
Location: 云隐山洞穴
Relationships: {{user}}→角色A: 恋人; {{user}}→角色B: 师徒(暧昧); {{user}}→角色C: [REMOVE]
Inventory: {{user}}·玉佩: =1; {{user}}·金创药: -1; {{user}}·解药: [REMOVE]
Setups: {{user}}·玉佩纹路之谜: (武定三年三月十五·云隐山洞穴)背面刻着一行字,含义不明; 角色A·旧日承诺: [REMOVE]
Overview: {{user}}向角色A表明心意确定恋人关系；与角色B切磋加深师徒情谊；拾得来历不明玉佩；服下最后一瓶解药；角色C战死永久离场。
</details>
\`\`\``;

const GENERATION_TIMEOUT = 300000; // 5分钟生成超时时间
const STEP_DELAY = 300; // 批次之间的延迟（毫秒）

const STATUS_TABLE_TITLE = "状态表"; // 结构化数据表世界书条目固定标题，与"小总结：起-止""大总结"同级存在
// 状态表要让AI记住"当前"状态，离最新消息越近权重越高，所以创建时用"@D 在深度"而不是小总结/大总结默认的"角色定义之前"。
// 对应你在世界书面板里手动设置好的参照值：@D 在深度1、[系统]角色、order 666、概率100%。
const STATUS_TABLE_ENTRY_DEFAULTS = {
  position: 4, // 原生 world_info_position: atDepth
  depth: 1,
  role: 0, // extension_prompt_roles: SYSTEM
  order: 666,
  probability: 100,
};

// 小总结条目的默认位置设置：用"@D 在深度"，深度定得比状态表深一点（深度6）。
// 触发方式为条件触发（非常驻），靠世界书自身的关键词匹配机制决定是否注入，
// 缓解长上下文里"始终存在"的条目被模型降权关注的问题。
const SMALL_SUMMARY_ENTRY_DEFAULTS = {
  constant: false, // 触发类型由常驻改成条件触发，靠 key 关键词匹配决定是否注入
  position: 4, // 原生 world_info_position: atDepth
  depth: 6,
  role: 0, // extension_prompt_roles: SYSTEM
  // order 不在这里固定：同一 depth 下 order 数字越大越靠近最后一条消息，
  // 若所有批次都用同一个固定值，最终顺序会退化成"按创建先后"这种脆弱的隐性规则，
  // 跟楼层号的实际先后顺序正好相反（详见自动小总结批次循环里的调用处）。
  // 因此实际创建时会用 { ...SMALL_SUMMARY_ENTRY_DEFAULTS, order: 批次楼层号 } 覆盖这里，
  // 让 order 直接跟随楼层号单调递增，楼层号越大顺序越靠后（越接近最后一条消息）。
  probability: 100,
};

// 角色卡条目标题前缀，后面拼接角色名，与"小总结：""大总结""状态表""对话前强调""地图信息"同级存在于同一本总结世界书。
const CHARACTER_ENTRY_TITLE_PREFIX = "角色卡：";
// 角色卡条目走关键词触发（selective），不是常驻类型：constant:false + key 数组即可，不需要额外的 position/depth 覆盖，
// 用 saveOrOverwriteLorebookEntry 的默认位置（角色定义之前）就够了，只单独给一个 order，避免和其他常驻条目抢排序。
const CHARACTER_ENTRY_DEFAULTS = {
  order: 100,
  probability: 100,
};

// === 手机（通讯器）私信系统相关常量 ===
// 本地对话缓存（LOCAL_CHAT_STORE_KEY）里存放"忙/闲判定缓存 + 待注入私信槽位标记"的 key，
// 跟起始楼层偏移量同一套持久化方式（浏览器本地存储），按"角色卡+对话文件"区分，换对话/换角色卡互不干扰。
const PHONE_CHAT_META_KEY = "plotAssistant_phoneChatState";
// 私信正文本地库（IndexedDB），跟地图图片库（mm_map_marker_db）是两个独立的库，互不影响。
const PHONE_IDB_NAME = "plot_assistant_phone_db";
const PHONE_IDB_STORE = "messages";
// 头像库：key 按"当前角色卡::联系人名"存一张压缩后的 dataURL，换角色卡不互相影响。
const PHONE_AVATAR_STORE = "avatars";
// 图片库（原"表情包"）：不分联系人/角色卡，全局公用一份，整份列表存在同一个 key 下（数量不大，不用建索引）。
const PHONE_STICKER_STORE = "stickers";
const PHONE_STICKER_LIST_KEY = "list";
// 背景库：分两类共用一个 store——
//   全局背景（通讯录/动态/设置三页共用）存在固定 key 下；
//   聊天页背景按"当前角色卡::联系人名"分别存，换角色卡/换联系人互不影响，跟头像库同一套 key 规则。
const PHONE_BACKGROUND_STORE = "backgrounds";
const PHONE_GLOBAL_BACKGROUND_KEY = "__global__";
// 私信槽位注入正文时用的 extension prompt key，平时为空，只有"今天有新私信"时临时写入内容，
// AI 生成完这一轮后立即清空（一次性注入，不常驻）。
const PHONE_SLOT_PROMPT_KEY = "plotAssistant_phoneSlot";

const SUMMARY_BUTTON_ID = "summary-assistant-menu-button";
const SUMMARY_BUTTON_ICON = "fa-solid fa-book";
const SUMMARY_BUTTON_TOOLTIP = "剧情助手";
const SUMMARY_BUTTON_TEXT = "剧情助手";
const SUMMARY_POPUP_ID = "summary-assistant-popup";
const GENERATING_OVERLAY_ID = "summary-assistant-generating-overlay";

// 起始楼层（原"接续小总结"的偏移量）：持久化存在浏览器本地（localStorage），按"角色卡+对话文件"
// 区分不同对话，重开同一个对话不会丢，换到别的对话也不会互相干扰；只有你再次点击"设定起始楼层"
// 并确认新值时才会覆盖。注意：这是存在浏览器本地的，换浏览器/清浏览器数据/控制面板里点"清空数据"都会丢，
// 不跟着对话文件本身走（不会随导出/分享对话文件带走）。
// 语义：本对话新写入的小总结，世界书楼层号从这个值开始编号。默认/未设置视为 0（不偏移）。
const OFFSET_META_KEY = "plotAssistant_summaryOffset";

// === Helper: 获取酒馆原生 context（每次都取最新的，避免切换角色/对话后引用过期） ===
function getCtx() {
  return SillyTavern.getContext();
}

// === Helper: 提示条 ===
function notify(type, message) {
  const text = `[剧情助手] ${message}`;
  if (typeof toastr !== "undefined" && typeof toastr[type] === "function") {
    toastr[type](text);
  } else {
    console.log(`[剧情助手][${type}]`, message);
  }
}

// === Helper: "自动小总结"手动停止时用来提前中断当前批次内层循环的信号类 ===
// 与普通生成失败区分开：捕获到这个错误时不应弹出失败提示，而是按"用户主动停止"处理。
class SummaryStopRequestedError extends Error {
  constructor() {
    super("已被用户手动停止。");
    this.name = "SummaryStopRequestedError";
  }
}

// === Helper: 错误捕获包装 ===
function errorCatched(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      console.error("[剧情助手] 错误:", error);
      notify(
        "error",
        error.stack ? error.stack : `${error.name}: ${error.message}`,
      );
      return undefined;
    }
  };
}

// === 本地对话缓存：起始楼层记录 + 私信忙闲缓存都存在这一份 localStorage 里 ===
// 原来存在酒馆的 chatMetadata 里（跟着对话文件本身持久化），现在改成存浏览器本地，
// 换来的好处是控制面板"清空数据"能一次性清掉所有对话的这两项缓存；代价是这份数据
// 不再跟着对话文件走（不会随导出/复制对话文件带走，换浏览器/清浏览器数据会丢）。
// 整份 JSON 存一个 key 下面，按"对话" 分别存一份小对象，key 用
// "角色卡 avatar 文件名::当前对话文件名" 区分不同对话（暂不支持群聊）。
const LOCAL_CHAT_STORE_KEY = "plotAssistant_localChatStore";

let localChatStoreCache = null; // 惰性加载：整份 JSON 只解析一次，后续都在内存里改，改完整份写回
let transientChatMetadataStore = null; // 拿不到稳定 key（比如没选中角色卡）时的内存兜底，不持久化

// 从 localStorage 读整份本地对话缓存到内存，只在第一次调用时真正解析 JSON
function loadLocalChatStore() {
  if (localChatStoreCache) return localChatStoreCache;
  try {
    const raw = localStorage.getItem(LOCAL_CHAT_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    localChatStoreCache =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
  } catch (error) {
    console.error("[剧情助手] 读取本地对话缓存失败，已重置为空:", error);
    localChatStoreCache = {};
  }
  return localChatStoreCache;
}

// 拼一个能区分"具体某个对话"的稳定 key：角色卡 avatar 文件名 + 当前对话文件名。
// 拿不到（未选中角色卡、群聊、或酒馆版本没暴露 getCurrentChatId 等）时返回 null，
// 调用方会退化到内存兜底（不持久化，仅本次页面会话有效）。
function getStableChatKey() {
  try {
    const context = getCtx();
    if (context.groupId) return null; // 暂不支持群聊
    if (typeof context.getCurrentChatId !== "function") return null;
    const chatId = context.getCurrentChatId();
    if (!chatId) return null;
    const charId = context.characterId;
    if (charId === undefined || charId === null) return null;
    const avatar = context.characters?.[charId]?.avatar;
    if (!avatar) return null;
    return `${avatar}::${chatId}`;
  } catch (error) {
    return null;
  }
}

// === Helper: 拿到"当前对话"的本地缓存对象（起始楼层记录 + 私信忙闲缓存都存在这里）===
function getChatMetadataStore() {
  const key = getStableChatKey();
  if (!key) {
    if (!transientChatMetadataStore) transientChatMetadataStore = {};
    return transientChatMetadataStore;
  }
  const root = loadLocalChatStore();
  if (!root[key] || typeof root[key] !== "object") root[key] = {};
  return root[key];
}

// === Helper: 把 getChatMetadataStore() 的改动写回 localStorage（内存兜底的情况没地方可写，直接跳过）===
async function persistChatMetadata() {
  const key = getStableChatKey();
  if (!key) return;
  try {
    localStorage.setItem(
      LOCAL_CHAT_STORE_KEY,
      JSON.stringify(loadLocalChatStore()),
    );
  } catch (error) {
    console.error("[剧情助手] 保存本地对话缓存失败:", error);
  }
}

// === Helper: 读取"本对话"已设定的起始楼层记录，未设置过返回 null ===
function getOffsetRecord() {
  const store = getChatMetadataStore();
  const record = store[OFFSET_META_KEY];
  if (!record || typeof record.offset !== "number" || isNaN(record.offset))
    return null;
  return record;
}

// === Helper: 设定/覆盖"本对话"的起始楼层（每次点"设定起始楼层"并确认后调用，属于用户主动操作）===
async function setOffsetRecord(offset) {
  const store = getChatMetadataStore();
  store[OFFSET_META_KEY] = { offset, updatedAt: Date.now() };
  await persistChatMetadata();
}

// === Helper: Delay Function ===
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// === Helper: 从世界书中已有的"小总结：起-止"条目扫描进度（取最大的"止"楼层号），-1 表示尚未开始 ===
function extractSmallSummaryRange(comment) {
  if (
    typeof comment !== "string" ||
    !comment.startsWith(SMALL_SUMMARY_TITLE_PREFIX)
  )
    return null;
  const match = comment
    .slice(SMALL_SUMMARY_TITLE_PREFIX.length)
    .match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  return { start: parseInt(match[1], 10), end: parseInt(match[2], 10) };
}

// === Helper: 扫描世界书里所有"小总结：起-止"条目，取全局最大的"止"楼层号，-1 表示世界书里还没有任何小总结。
// 只用于"设定起始楼层"弹窗给默认值做参考，不参与"自动小总结"的进度判断。===
async function getMaxSummaryEnd(lorebookName) {
  try {
    const entries = await getLorebookEntriesArray(lorebookName);
    let maxEnd = -1;
    entries.forEach((entry) => {
      const range = extractSmallSummaryRange(entry.comment);
      if (range && range.end > maxEnd) maxEnd = range.end;
    });
    return maxEnd;
  } catch (error) {
    console.warn("[剧情助手] 扫描世界书历史总结失败:", error);
    return -1;
  }
}

// === Helper: "自动小总结"统一使用的进度扫描——只统计"起始楼层 ≥ offset"的条目，
// 避免把世界书里不属于本次编号区间的条目（比如换了起始楼层之前的旧条目）误判成当前进度。
// offset 为 0 时等价于扫描全部条目，与未设置起始楼层时的行为一致。
// 返回本地楼层视角下的进度（已减去 offset），-1 表示按当前 offset 还没写入过任何条目。===
async function getSummaryProgress(lorebookName, offset) {
  try {
    const entries = await getLorebookEntriesArray(lorebookName);
    let maxEnd = -1;
    entries.forEach((entry) => {
      const range = extractSmallSummaryRange(entry.comment);
      if (range && range.start >= offset && range.end > maxEnd)
        maxEnd = range.end;
    });
    return maxEnd < 0 ? -1 : maxEnd - offset;
  } catch (error) {
    console.warn("[剧情助手] 扫描自动小总结进度失败，视为尚未开始:", error);
    return -1;
  }
}

// === Helper: 最后一条消息的楼层号（原生 context.chat 数组下标即楼层号） ===
function getLastMessageId() {
  const chat = getCtx().chat;
  if (!Array.isArray(chat) || chat.length === 0) return -1;
  return chat.length - 1;
}

// === Helper: 拉取指定楼层范围的原文并拼成文本块（原生 context.chat 本身就包含隐藏楼层，无需额外参数） ===
async function buildMessagesText(start, end) {
  const chat = getCtx().chat;
  if (!Array.isArray(chat) || chat.length === 0) return "";
  const slice = chat.slice(start, end + 1);
  if (slice.length === 0) return "";
  return slice
    .map(
      (m, idx) =>
        `[第${start + idx}楼] ${m.name || (m.is_user ? "用户" : "AI")}：${m.mes}`,
    )
    .join("\n\n");
}

// === Helper: 从 fromIdx 开始沿 direction（-1 向前找上文，+1 向后找下文）逐层扫描聊天记录，
// 找到第一个能成功解析出摘要模块的 AI 楼层，作为逐层还原时的时间/地点锚点。
// 扫描范围不受当前批次(batchStart/batchEnd)限制，只受聊天记录本身边界限制，纯本地遍历不产生额外AI调用；
// 找不到（比如已经到聊天开头/结尾都没有摘要模块）时返回 null，由调用方决定留空锚点，不报错、不阻断。===
function findNearestAnchorFloor(chat, fromIdx, direction) {
  if (!Array.isArray(chat)) return null;
  let i = fromIdx;
  while (i >= 0 && i < chat.length) {
    const message = chat[i];
    if (message && !message.is_user) {
      const parsed = parseFloorSummaryFields(message.mes);
      if (parsed) return { idx: i, parsed };
    }
    i += direction;
  }
  return null;
}

// === Helper: 缺失摘要模块的楼层区间，让AI逐层还原 Time/Location/Overview（不合并、不压缩条数），
// 使这部分楼层产出的字段结构跟正常楼层（对话前强调规则写出的摘要模块）完全一致，方便 buildRangeSummaryContent
// 用同一套逻辑合并整个batch（合并时间跨度、取末尾地点、逐层列关键事件）和提取关键词（按"年/月"字面切分）。
// Overview 的写法、字数上限（150字）直接对齐"对话前强调"里 Overview 字段的规则，不单独维护一套压缩规则。
function buildFloorRestoreInstruction() {
  return `对话原文每层楼开头标注楼层号和说话者（如"[第12楼] AI："或"[第12楼] 用户："）。
现在请你对归属于AI的楼层逐层还原缺失的摘要字段（Time/Location/Overview），不要续写故事，不要输出 <summary> 标签之外的任何文字。
还原规则：
- 目标楼层逐层单独输出，不合并多层、不跳过任何一层、不把一层拆成多组
- Time: 该层故事场景结束时的时刻；精确到年月日+时分
- Location: 该层场景最后所在地点
- Overview: 按时间顺序列出关键事件+实际改变(关系/处境/认知)，平铺直叙不用比喻/形容词，写成一段话不换行；无实质进展留空，不超150字
请严格按照下面的格式输出，每层楼一个区块，区块之间空一行：
<summary>
[第{楼层号}楼]
Time: {...}
Location: {...}
Overview: {...}
</summary>`;
}

// anchors 可选，形如 { prev: {idx, parsed:{time,location,overview}}, next: {idx, parsed:{time,location}} }：
// prev（上文）给完整三项，帮AI判断是否与上文重复、避免时间倒退；
// next（下文）只给 Time，当作"本段时间不能超过这个点"的边界约束，不泄露下文 Location/Overview 以免剧透干扰本段还原。
function buildFloorRestoreUserContent(
  start,
  end,
  messagesText,
  targetFloorIndices,
  anchors,
) {
  const targetListStr = (targetFloorIndices || []).join("、");
  const { prev, next } = anchors || {};
  let anchorBlock = "";
  if (prev || next) {
    const lines = [];
    if (prev) {
      lines.push(
        `已知上文（第${prev.idx}楼）：Time: ${prev.parsed.time || "未知"}　Location: ${prev.parsed.location || "未知"}　Overview: ${prev.parsed.overview || "（无）"}`,
      );
    }
    if (next) {
      lines.push(
        `已知下文（第${next.idx}楼）：Time: ${next.parsed.time || "未知"}`,
      );
    }
    anchorBlock = `${lines.join("\n")}\n（以上仅供你判断本段所处时间点和地点参考，不要照抄，需结合本段对话实际内容推进）\n\n`;
  }
  return `${anchorBlock}以下是第${start}楼到第${end}楼的对话原文（其中用户发言楼层仅供参考，不需要输出摘要）：\n\n${messagesText}\n\n请只针对第 ${targetListStr} 楼分别还原摘要字段，不要遗漏其中任何一层，也不要为用户发言楼层输出内容。`;
}

// === Helper: 按标签取单行字段值，如 "Time: xxx" 中取出 "xxx"。
// 冒号前后只吃同一行内的空格/制表符（[ \t]*），不能用 \s*——\s 包含换行符，
// 一旦某字段本轮为空（很常见，比如没变化的 Relationships/Inventory），\s* 会贪婪地吃穿换行，
// 把下一行的标签+内容当成当前字段的值，造成标签错位、内容重复（曾实际复现并确认）。
// 三处调用方共用同一份正则规则：逐层还原结果解析、单层摘要模块解析、状态表条目快照读取，
// 避免各自维护一份同样的正则、慢慢跑偏。找不到该标签时返回空字符串，不报错。===
function extractLabelLine(text, label) {
  if (!text || typeof text !== "string") return "";
  const re = new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.*)$`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

// === Helper: 解析AI逐层还原结果——按"[第N楼]"标记切块，块内按 Time/Location/Overview 逐行取值
// （Overview要求AI写成不换行的一段话，用单行正则即可，不用像 parseFloorSummaryFields 那样特殊处理多行）。
// 返回 Map<楼层号, {time, location, overview}>；解析不到任何区块时返回空 Map，由调用方决定兜底策略。===
function parseRestoredFloorFields(text) {
  const result = new Map();
  if (!text || typeof text !== "string") return result;

  const markerRe = /\[第(\d+)楼\]/g;
  const matches = [...text.matchAll(markerRe)];

  matches.forEach((m, i) => {
    const idx = parseInt(m[1], 10);
    const blockStart = m.index + m[0].length;
    const blockEnd =
      i + 1 < matches.length ? matches[i + 1].index : text.length;
    const inner = text.slice(blockStart, blockEnd);

    result.set(idx, {
      time: extractLabelLine(inner, "Time"),
      location: extractLabelLine(inner, "Location"),
      overview: extractLabelLine(inner, "Overview"),
    });
  });

  return result;
}

// === Helper: 大总结提示词 ===
// 不再单独输出"当前人物关系"字段，理由同小总结：关系状态由状态表世界书条目实时持久化，这里只做主线脉络的叙事性提炼。
// 输出格式刻意与楼层摘要模块（<details><summary>摘要</summary>...）保持一致：
// 生成结果是整块直接保存供用户复制粘贴到新对话第0层续写用的，格式一致意味着粘贴后能被 parseFloorSummaryFields
// 直接识别为有效摘要模块，不必再为第0层多触发一次AI还原摘要的调用。
function buildLargeSummaryInstruction() {
  return `现在请你基于下面给出的多段小总结，提炼出故事目前为止的主线脉络，不要输出 <details>...</details> 标签之外的任何文字。

提炼原则：
- "主线脉络"只保留影响故事整体走向、后续无法轻易逆转的转折点（如阵营/立场的根本转变、关键身份或能力的解锁、影响多条故事线的重大决定、造成关系不可逆变化的节点）
- 判断标准：如果删掉这条事件，后面的剧情逻辑会讲不通，就保留；如果只是让某个场景更生动、删了不影响后续理解，就不保留
- 不要保留具体对话交锋、场景过程、短期情绪波动等细节，只保留事件本身对故事走向的意义
- 按时间顺序列出，条数不设硬性上限，由小总结数量和实际转折点多少决定
- 全文总长度控制在约2000字以内

请严格按以下格式输出：

<details><summary>摘要</summary>
Time: {整个故事目前为止的时间跨度}
Location: {故事目前最新所在地点}
Overview: 
- {阶段性关键事件1}
- {阶段性关键事件2}
...
</details>`;
}

// === Helper: 解析 <summary> 标签内容（供逐层还原调用方使用，输出的是裸 <summary>[第N楼]...</summary>，
// 不带 <details> 外壳，不要跟下面的 parseLargeSummaryBlock 混用）===
function parseSummaryContent(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/);
  return match ? match[1].trim() : null;
}

// === Helper: 提取大总结的完整 <details>...</details> 原文块（含标签本身，不拆字段）。
// 与 parseFloorSummaryFields 不同：那个函数是把内部字段拆开供小总结拼素材用；
// 这里要的是整块可直接粘贴当第0层用的原文，所以取 match[0] 而非 match[1]。===
function parseLargeSummaryBlock(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(
    /<details>\s*<summary>\s*摘要\s*<\/summary>[\s\S]*?<\/details>/,
  );
  return match ? match[0].trim() : null;
}

// =====================================================================================
// === 摘要模块解析 & 结构化数据表（状态表）===
// 对应酒馆预设里每层输出的 <details><summary>摘要</summary>...</details> 模块，
// 每层摘要模块字段并列为 Time / Location / Relationships / Inventory / Setups / Overview；
// 但持久化进"状态表"世界书条目的只有 Relationships / Inventory / Setups 三项——
// Time / Location / Overview 只存在于每层楼的摘要模块原文里（Overview 另外供小总结提取用），不写入状态表。
// Inventory 的 value 支持 +N/-N/=N 三种符号触发数值增减/覆盖（见 applyNumericMapUpdates），
// 其他格式（裸数字、带单位、纯文字）一律按普通文字整体覆盖。
// Relationships 的 value 允许两种合法形式：(a) 纯裸词（阶段词/身份词/血亲词表里的某一个词，原样写）；
// (b) 身份/血亲词后面用括号附带一个阶段词，如"师徒(朋友)"（全角/半角括号都兼容）。
// 状态表合并时会用 isValidRelationshipWord 校验，两种形式都不合规的值会被跳过并提示，不会写入状态表。
// Setups 仍是自由文本；对代码而言只是不透明字符串，按 key 整体覆盖，内容格式不影响解析逻辑。
// =====================================================================================

// === Helper: 从单层楼消息原文里解析摘要模块的各字段，解析不到 <details>摘要</details> 时返回 null ===
function parseFloorSummaryFields(mesText) {
  if (!mesText || typeof mesText !== "string") return null;
  const detailsMatch = mesText.match(
    /<details>\s*<summary>\s*摘要\s*<\/summary>([\s\S]*?)<\/details>/,
  );
  if (!detailsMatch) return null;
  const inner = detailsMatch[1];

  const overviewMatch = inner.match(/Overview\s*:\s*([\s\S]*)$/);

  return {
    time: extractLabelLine(inner, "Time"),
    location: extractLabelLine(inner, "Location"),
    relationships: extractLabelLine(inner, "Relationships"),
    inventory: extractLabelLine(inner, "Inventory"),
    setups: extractLabelLine(inner, "Setups"),
    busy: extractLabelLine(inner, "Busy"), // 仅供手机私信插件读取"角色: [REMOVE]"信号，不参与状态表 Relationships/Inventory/Setups 的常规合并
    overview: overviewMatch ? overviewMatch[1].trim() : "",
  };
}

// === Helper: 判断本层是否"疑似尝试输出了摘要模块但结构不完整"（如漏写 </details> 闭合标签），
// 用于和"这层压根没写摘要"区分开——前者需要提示用户（数据静默丢失了），后者是正常情况，不用提示。===
function detectMalformedSummaryBlock(mesText) {
  if (!mesText || typeof mesText !== "string") return false;
  if (
    /<details>\s*<summary>\s*摘要\s*<\/summary>[\s\S]*?<\/details>/.test(
      mesText,
    )
  )
    return false; // 能正常解析，不算畸形
  return (
    /<summary>\s*摘要\s*<\/summary>/.test(mesText) ||
    (/<details>/.test(mesText) && /摘要/.test(mesText))
  );
}

// === Helper: 解析 "key: value; key2: value2" 形式的分号分隔键值列表，
// 额外收集"解析不出 key:value 结构"的原始片段供状态表合并时做格式校验 ===
// 分隔符/冒号同时兼容半角(; :)和中文全角(； ：)——中文语境下 AI 输出全角标点是常态，
// 只认半角会导致多组内容拆不开、被错误地整体塞进前一个 key 的 value 里（曾实际复现过此问题）。
// 容错：识别"[REMOVE]key"这类缺冒号、REMOVE写在key前面的错误格式（正确格式应为"key: [REMOVE]"）。
// 兼容半角/全角方括号及中文方头括号，REMOVE 大小写不敏感。
const REMOVE_PREFIX_PATTERN = /^[\[［【]\s*remove\s*[\]］】]\s*(.+)$/i;
// 容错：识别"key[REMOVE]"这类缺冒号、REMOVE写在key后面（紧跟或隔空格）的错误格式。
const REMOVE_SUFFIX_PATTERN = /^(.+?)\s*[\[［【]\s*remove\s*[\]］】]$/i;

function parseKeyValueListWithSkipped(str) {
  const map = new Map();
  const skipped = [];
  const corrected = [];
  if (!str) return { map, skipped, corrected };
  str.split(/[;；]/).forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const idx = trimmed.search(/[:：]/);
    if (idx === -1) {
      const removePrefixMatch = trimmed.match(REMOVE_PREFIX_PATTERN);
      if (removePrefixMatch) {
        const key = removePrefixMatch[1].trim();
        if (key) {
          map.set(key, "[REMOVE]");
          corrected.push(
            `"${trimmed}" 缺少冒号分隔，已按 "${key}: [REMOVE]" 处理`,
          );
          return;
        }
      }
      const removeSuffixMatch = trimmed.match(REMOVE_SUFFIX_PATTERN);
      if (removeSuffixMatch) {
        const key = removeSuffixMatch[1].trim();
        if (key) {
          map.set(key, "[REMOVE]");
          corrected.push(
            `"${trimmed}" 缺少冒号分隔，已按 "${key}: [REMOVE]" 处理`,
          );
          return;
        }
      }
      skipped.push(trimmed);
      return;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) {
      map.set(key, value);
    } else {
      skipped.push(trimmed);
    }
  });
  return { map, skipped, corrected };
}

// === Helper: 键值 Map 序列化回 "key: value; key2: value2" ===
// 序列化统一输出半角分号/冒号，保证状态表世界书条目自身的格式始终规范，
// 下一轮读回来解析时不会再引入全角标点问题。
function serializeKeyValueList(map) {
  return Array.from(map.entries())
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

// === Helper: 把 Inventory 快照里纯数字的 value 改写成 "=数字" 格式（如 "3" → "=3"）。
// 状态表里数值型 Inventory 条目的存储形式本身就是裸数字（applyNumericMapUpdates 写回时用 formatNumericValue
// 生成的就是不带符号的纯数字字符串），但 mergeFloorIntoStatusTable 只认 +N/-N/=N 三种带符号前缀的写法，
// 裸数字会被 looksLikeAttemptedNumericButMalformed 判定成"疑似想写数值但格式不对"，整条跳过不写入。
// 大总结是要粘回新对话第0层、经由 rebuildStatusTableFromChat 重新解析合并回状态表的，所以必须提前把裸数字
// 转换成 =N 的合法写法，否则这些数值条目会在新对话第一次全量重放时被静默丢弃。
// 非纯数字的 value（文字备注，如"未开封"）原样保留，不做任何改写。===
const BARE_NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
function convertInventorySnapshotToHardset(inventoryLine) {
  const { map } = parseKeyValueListWithSkipped(inventoryLine);
  map.forEach((value, key) => {
    if (BARE_NUMBER_PATTERN.test(value.trim())) {
      map.set(key, `=${value.trim()}`);
    }
  });
  return serializeKeyValueList(map);
}

// === Helper: 全角数字/正负号/等号 → 半角，用于数值类字段的宽松解析 ===
function normalizeNumericToken(raw) {
  return String(raw)
    .replace(/＋/g, "+")
    .replace(/－/g, "-")
    .replace(/＝/g, "=")
    .replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    );
}

// === Helper: 判断是否为"删除该 key"标记，兼容 [REMOVE] 的全角方括号/中文方头括号写法 ===
function isRemoveMarker(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed === "[REMOVE]" ||
    trimmed === "［REMOVE］" ||
    trimmed === "【REMOVE】"
  );
}

// === Helper: 判断是否"疑似想写删除标记但格式没写对"（大小写不对、漏括号、写成中文"移除/删除"等）===
// 命中时既不会当作删除执行（避免误删），也不会当作普通文字整体覆盖（避免状态表里出现"[remove]"这类明显是格式错误的文本），
// 而是交给调用方跳过该条写入并提示，留给使用者自行判断。
function looksLikeAttemptedRemove(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (isRemoveMarker(trimmed)) return false; // 标准写法走正常删除逻辑，不算"疑似"
  return (
    /^[\[［【(（]?\s*remove\s*[\]］】)）]?$/i.test(trimmed) ||
    trimmed === "移除" ||
    trimmed === "删除"
  );
}

// === Constants: Relationships 字段允许的固定关系词表（对应摘要.txt 里的阶段词/身份词/血亲词），用于校验 AI 输出是否合规 ===
const RELATIONSHIP_STAGE_WORDS = [
  "陌生",
  "相识",
  "相熟",
  "好感",
  "暧昧",
  "恋人",
  "未婚夫妻",
  "夫妻",
  "对手",
  "仇人",
  "宿敌",
  "同伴",
  "盟友",
  "朋友",
  "挚友",
];
const RELATIONSHIP_RANK_WORDS = [
  "师徒",
  "师兄弟",
  "师兄妹",
  "师姐妹",
  "师姐弟",
  "义兄弟",
  "义兄妹",
  "义姐妹",
  "义姐弟",
  "同门",
  "同学",
  "同事",
  "邻居",
  "网友",
  "战友",
  "上下级",
  "继父子",
  "继父女",
  "继母子",
  "继母女",
  "主仆",
  "学长学弟",
  "学长学妹",
  "学姐学弟",
  "学姐学妹",
  "师生",
  "校友",
  "室友",
  "甲乙方",
  "合伙人",
  "医患",
  "队友",
  "教练学员",
  "房东租客",
  "粉丝偶像",
];
const RELATIONSHIP_KIN_WORDS = [
  "父女",
  "父子",
  "母女",
  "母子",
  "兄弟",
  "兄妹",
  "姐弟",
  "姐妹",
  "祖孙",
  "叔侄",
  "舅甥",
  "姑侄",
  "姨甥",
  "表兄弟",
  "表兄妹",
  "表姐弟",
  "表姐妹",
  "堂兄弟",
  "堂兄妹",
  "堂姐弟",
  "堂姐妹",
];
const RELATIONSHIP_ALLOWED_WORDS = new Set([
  ...RELATIONSHIP_STAGE_WORDS,
  ...RELATIONSHIP_RANK_WORDS,
  ...RELATIONSHIP_KIN_WORDS,
]);

// === Constant: 身份/血亲词表（合并），用于校验"身份/血亲词(阶段词)"这种带括号的合法形式 ===
const RELATIONSHIP_RANK_OR_KIN_WORDS = new Set([
  ...RELATIONSHIP_RANK_WORDS,
  ...RELATIONSHIP_KIN_WORDS,
]);
const RELATIONSHIP_STAGE_WORDS_SET = new Set(RELATIONSHIP_STAGE_WORDS);

// === Helper: 判断 Relationships 字段的 value 是否合法——允许两种形式：
//   (a) 纯裸词：词表（阶段词/身份词/血亲词）里的某一个词，原样写；
//   (b) 身份/血亲词(阶段词)：身份/名分词或血亲词后面紧跟半角/全角括号，括号里是一个阶段词，如 "师徒(朋友)"/"师徒（朋友）"。
// 其他任何附加内容（括注理由、单位等）一律不合法。 ===
function isValidRelationshipWord(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (RELATIONSHIP_ALLOWED_WORDS.has(trimmed)) return true; // 形式 (a)：纯裸词

  const bracketMatch = trimmed.match(/^(.+?)[（(]([^（()）]+)[）)]$/); // 形式 (b)：主词 + 括号阶段词
  if (!bracketMatch) return false;
  const mainWord = bracketMatch[1].trim();
  const stageWord = bracketMatch[2].trim();
  return (
    RELATIONSHIP_RANK_OR_KIN_WORDS.has(mainWord) &&
    RELATIONSHIP_STAGE_WORDS_SET.has(stageWord)
  );
}

// === Helper: 把 Map 视为"当前状态"，用一批更新做增删改（value 为 [REMOVE] 时删除该 key）===
// warnings/fieldLabel 可选：传入时，遇到"疑似删除标记但格式不对"的 value 会跳过写入并记录一条提示，而不是当普通文字存进去。
function applyMapUpdates(baseMap, updatesMap, warnings, fieldLabel) {
  updatesMap.forEach((value, key) => {
    if (isRemoveMarker(value)) {
      baseMap.delete(key);
    } else if (looksLikeAttemptedRemove(value)) {
      if (warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${value}" 疑似想写删除标记但格式不对（应为 [REMOVE]），已跳过，未做任何修改`,
        );
      }
    } else {
      baseMap.set(key, value);
    }
  });
}

// === Helper: 把数字格式化成字符串，去掉多余的浮点误差/尾随小数点 ===
function formatNumericValue(num) {
  const rounded = Math.round(num * 1000) / 1000; // 保留最多3位小数，规避浮点误差
  return String(rounded);
}

// === Constants: Inventory 数值格式的两种合法正则，提升为模块级常量供多处复用 ===
const NUMERIC_DELTA_PATTERN = /^([+-])(\d+(?:\.\d+)?)$/;
const NUMERIC_HARDSET_PATTERN = /^=(-?\d+(?:\.\d+)?)$/;

// === Helper: 判断是否"疑似想写数值/数量但格式或用法不对"——
// 覆盖两类情况：
//   (a) =N/+N/-N 开头但带了多余括注/单位/理由（如 "=1(上衣口袋,未贴肉佩戴)"）；
//   (b) 裸数字开头，不带任何符号前缀（如 "3日份干粮"、"80x"）——这类值大概率不是合法的物品状态备注，
//       而是把数量、天数等信息错塞进了 Inventory，应引导写作者改写到 Overview，或改用合法的 =N/+N/-N 格式。
// 命中时既不会当作数值运算，也不会当作普通文字整体覆盖，而是交给调用方跳过该条写入并提示。===
function looksLikeAttemptedNumericButMalformed(rawValue) {
  if (typeof rawValue !== "string") return false;
  const normalized = normalizeNumericToken(rawValue.trim());
  if (
    NUMERIC_DELTA_PATTERN.test(normalized) ||
    NUMERIC_HARDSET_PATTERN.test(normalized)
  )
    return false; // 合法格式，放行
  return /^[+\-=]?\d+(?:\.\d+)?/.test(normalized); // 数字开头（可选符号前缀），但整体不合法
}

// === Helper: 数值感知版的 Map 合并（供 Inventory 使用）——
// value 严格匹配两种格式才会触发数值运算，格式不符一律按普通文字整体覆盖（[REMOVE] 仍然是删除）：
//   +N / -N  → 在旧值基础上加减（旧值非数字或不存在时按 0 起算）
//   =N       → 直接覆盖成 N（N 可以带负号，如 =-5）
//   数字开头但不合法（含多余括注/单位，或裸数字开头）→ 疑似写错，跳过写入并警告，见 looksLikeAttemptedNumericButMalformed
//   其余非数字开头的纯文字 → 视为正常物品状态备注，原样整体覆盖
// 全角 ＋－＝ 和全角数字会先归一化成半角再匹配，未命中任何数值格式时仍保留原始文本（不做归一化覆盖），
// 避免把物品备注等纯文字误改写成归一化后的怪异内容。===
// warnings/fieldLabel 可选，用于收集校验提示；warnOnPlainFallback 参数保留供后续扩展使用——
// Inventory 允许非数值备注是正常用法（如物品状态说明），调用时传 false，不会提示（但数字开头的疑似误写始终会提示，不受此开关影响）。
function applyNumericMapUpdates(
  baseMap,
  updatesMap,
  warnings,
  fieldLabel,
  warnOnPlainFallback,
) {
  updatesMap.forEach((rawValue, key) => {
    if (isRemoveMarker(rawValue)) {
      baseMap.delete(key);
      return;
    }

    if (looksLikeAttemptedRemove(rawValue)) {
      if (warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${rawValue}" 疑似想写删除标记但格式不对（应为 [REMOVE]），已跳过，未做任何修改`,
        );
      }
      return;
    }

    const normalized = normalizeNumericToken(rawValue.trim());
    const deltaMatch = normalized.match(NUMERIC_DELTA_PATTERN);
    const hardsetMatch = normalized.match(NUMERIC_HARDSET_PATTERN);

    if (deltaMatch) {
      const sign = deltaMatch[1] === "-" ? -1 : 1;
      const delta = sign * parseFloat(deltaMatch[2]);
      const oldValue = parseFloat(baseMap.get(key));
      const base = Number.isFinite(oldValue) ? oldValue : 0;
      const result = base + delta;
      if (result <= 0) {
        baseMap.delete(key);
        if (warnings) {
          warnings.push(
            `${fieldLabel || ""} "${key}" 数值计算后为 ${formatNumericValue(result)}（≤0），已自动移除该条目`,
          );
        }
      } else {
        baseMap.set(key, formatNumericValue(result));
      }
    } else if (hardsetMatch) {
      const result = parseFloat(hardsetMatch[1]);
      if (result <= 0) {
        baseMap.delete(key);
        if (warnings) {
          warnings.push(
            `${fieldLabel || ""} "${key}" 被硬修正为 ${formatNumericValue(result)}（≤0），已自动移除该条目`,
          );
        }
      } else {
        baseMap.set(key, formatNumericValue(result));
      }
    } else if (looksLikeAttemptedNumericButMalformed(rawValue)) {
      if (warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${rawValue}" 疑似想写数量(=N/+N/-N)但格式或用法不对（多余括注/单位，或把非物品数量的数字塞进了 Inventory），已跳过，未做任何修改`,
        );
      }
      // 不写入：避免状态表里出现半数值半文字的怪异内容
    } else {
      baseMap.set(key, rawValue); // 非数字开头的纯文字，按普通文字整体覆盖
      if (warnOnPlainFallback && warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${rawValue}" 不是合法的 +N/-N/=N 数值格式，已按普通文字整体覆盖，请检查该属性是否被写错`,
        );
      }
    }
  });
}

// === Helper: 从 "{{user}}→角色名" 这类关系 key 里取出"另一方"角色名（排除 {{user}} 自身）===
function extractOtherPartyName(relationshipKey) {
  const parts = relationshipKey.split("→").map((s) => s.trim());
  const other = parts.find((p) => p && p !== "{{user}}");
  return other || null;
}

// === Helper: 把状态表结构化对象序列化回世界书条目文本 ===
// busyMap 为可选参数：手机私信插件维护的"当前忙碌角色"表（{角色名: true, ...}），
// 不来自聊天记录全量重放（跟 Relationships/Inventory/Setups 不同源），只在序列化这一步拼进状态表末尾，
// 让正文 AI 每轮都能看到"谁正忙"，从而在这些角色不再登场时输出 Busy: 角色名: [REMOVE] 清除标记。
function serializeStatusTableContent(state, busyMap) {
  const lines = [
    `Relationships: ${serializeKeyValueList(state.relationships)}`,
    `Inventory: ${serializeKeyValueList(state.inventory)}`,
    `Setups: ${serializeKeyValueList(state.setups)}`,
  ];
  const busyNames = busyMap
    ? Object.keys(busyMap).filter((name) => busyMap[name])
    : [];
  lines.push(`Busy: ${busyNames.map((name) => `${name}: 忙`).join("; ")}`);
  // 固定提醒行：每次序列化都重新生成，不写进任何 Map、不参与解析（不匹配任何字段标签的正则），
  // 纯粹是"贴在状态表末尾、每轮都会被 AI 看到"的复核提示，防止旧 Setups 条目（伏笔/未解线索）被长上下文遗忘。
  // 只在 Setups 非空时附加，避免空列表时提醒显得多余。
  if (state.setups && state.setups.size > 0) {
    lines.push(
      "（提醒：以上 Setups 每轮需逐条复核——已回收/已兑现/已废弃的，或因场景/时间线推进已不再可能被回收的，本轮请用 [REMOVE] 清除）",
    );
  }
  if (busyNames.length > 0) {
    lines.push(
      '（提醒：以上 Busy 中的角色若本轮未出现在正文场景里，请在摘要块的 Busy 字段输出"角色名: [REMOVE]"清除）',
    );
  }
  return lines.join("\n");
}

// === Helper: 把某一层解析出的摘要字段合并进状态表（Relationships/Inventory/Setups 按 key 增删改；Time/Location 不写入状态表；
// 角色在 Relationships 里被 [REMOVE]（死亡/永久退场）时，联动清理 Inventory/Setups 中"角色名·xxx"格式的相关条目）===
// warnings 为可选的数组，传入时会收集本次合并中发现的所有格式问题（不合规的部分会被跳过、不写入状态表，
// 但不会阻断其余合法字段的正常合并）。不传 warnings 时行为与之前完全一致，仅静默跳过不合规内容。
function mergeFloorIntoStatusTable(state, floorFields, warnings) {
  const relParsed = parseKeyValueListWithSkipped(floorFields.relationships);
  if (warnings) {
    relParsed.skipped.forEach((fragment) =>
      warnings.push(
        `Relationships 中的片段 "${fragment}" 无法解析出 key:value 结构，已跳过`,
      ),
    );
    relParsed.corrected.forEach((msg) =>
      warnings.push(`Relationships：${msg}`),
    );
  }
  const removedCharacters = [];
  relParsed.map.forEach((value, key) => {
    if (isRemoveMarker(value)) {
      state.relationships.delete(key);
      const other = extractOtherPartyName(key);
      if (other) removedCharacters.push(other);
    } else if (isValidRelationshipWord(value)) {
      state.relationships.set(key, value);
    } else if (warnings) {
      warnings.push(
        `Relationships "${key}" 的值 "${value}" 不在允许的固定关系词表中，且不是 [REMOVE] 标记，已跳过，未做任何修改`,
      );
    }
    // 不传 warnings 时（旧行为兜底）：不合规的值直接跳过，不写入，避免脏数据进入状态表。
  });

  const inventoryParsed = parseKeyValueListWithSkipped(floorFields.inventory);
  const setupsParsed = parseKeyValueListWithSkipped(floorFields.setups);
  if (warnings) {
    inventoryParsed.skipped.forEach((fragment) =>
      warnings.push(
        `Inventory 中的片段 "${fragment}" 无法解析出 key:value 结构，已跳过`,
      ),
    );
    inventoryParsed.corrected.forEach((msg) =>
      warnings.push(`Inventory：${msg}`),
    );
    setupsParsed.skipped.forEach((fragment) =>
      warnings.push(
        `Setups 中的片段 "${fragment}" 无法解析出 key:value 结构，已跳过`,
      ),
    );
    setupsParsed.corrected.forEach((msg) => warnings.push(`Setups：${msg}`));
  }

  applyNumericMapUpdates(
    state.inventory,
    inventoryParsed.map,
    warnings,
    "Inventory",
    false,
  );
  applyMapUpdates(state.setups, setupsParsed.map, warnings, "Setups");

  removedCharacters.forEach((name) => {
    const prefix = `${name}·`;
    Array.from(state.inventory.keys()).forEach((key) => {
      if (key.startsWith(prefix)) state.inventory.delete(key);
    });
    Array.from(state.setups.keys()).forEach((key) => {
      if (key.startsWith(prefix)) state.setups.delete(key);
    });
  });

  return state;
}

// === Helper: 记录"已经提示过格式问题"的楼层，避免全量重放模式下同一层反复弹同一条警告。
// key 用 "messageId::具体问题文本" 拼接——同一层如果问题内容变了（比如用户手动改了这层文本），会当成新问题重新提示一次；
// 只有内容和上次完全一样才会被去重。切换角色卡/刷新页面后该记录清空，属于预期行为（值不大，不做持久化）。===
const warnedStatusTableIssues = new Set();

// === Helper: 全量重放——以当前 chat 数组里【现存】的所有 AI 楼层为准，从头重新解析并合并出状态表。
// 不再对单一楼层做"增量合并后原地覆盖"，而是每次都重新推导一遍完整状态，天然与当前对话内容保持一致：
// 楼层被删除/回退后，下一次触发时重放范围会自动收窄，不需要额外的"检测回退"分支。===
async function rebuildStatusTableFromChat() {
  const context = getCtx();
  const chat = context.chat;
  if (!Array.isArray(chat)) return;

  const state = {
    relationships: new Map(),
    inventory: new Map(),
    setups: new Map(),
  };
  const newIssues = []; // 本次重放中新出现（之前没提示过）的问题，收集齐后一次性提示

  chat.forEach((message, idx) => {
    if (!message || message.is_user) return;

    const floorFields = parseFloorSummaryFields(message.mes);
    if (!floorFields) {
      if (detectMalformedSummaryBlock(message.mes)) {
        const issueKey = `${idx}::malformed`;
        if (!warnedStatusTableIssues.has(issueKey)) {
          warnedStatusTableIssues.add(issueKey);
          newIssues.push(
            `第${idx}层似乎输出了摘要模块，但 <details>/<summary> 结构不完整（例如漏写闭合标签），未能解析，本层未计入状态表。`,
          );
        }
      }
      return;
    }

    const floorWarnings = [];
    mergeFloorIntoStatusTable(state, floorFields, floorWarnings);
    floorWarnings.forEach((w) => {
      const issueKey = `${idx}::${w}`;
      if (!warnedStatusTableIssues.has(issueKey)) {
        warnedStatusTableIssues.add(issueKey);
        newIssues.push(`第${idx}层：${w}`);
      }
    });
  });

  // 手机私信插件的 Busy 状态不参与上面的全量重放（它的来源是用户在手机里主动发消息，不是从聊天记录解析出来的），
  // 只在这里"读取当前值 → 拼进序列化结果"；REMOVE 信号只看【最新一层】AI 楼层，不回溯整段历史——
  // 忙碌状态本身只在"当前"有意义，没必要像 Relationships 那样重放整个对话。
  const phoneState = getPhoneChatState();
  const freedCharacters = [];
  const latestAiMessage = [...chat].reverse().find((m) => m && !m.is_user);
  if (latestAiMessage) {
    const latestFields = parseFloorSummaryFields(latestAiMessage.mes);
    if (latestFields && latestFields.busy) {
      const { map: busyRemoveMap } = parseKeyValueListWithSkipped(
        latestFields.busy,
      );
      busyRemoveMap.forEach((value, name) => {
        if (isRemoveMarker(value) && phoneState.busy[name]) {
          delete phoneState.busy[name];
          freedCharacters.push(name);
        }
      });
    }
  }

  const newContent = serializeStatusTableContent(state, phoneState.busy);
  const lorebookName = await getOrCreateSummaryLorebook();
  await saveOrOverwriteLorebookEntry(
    lorebookName,
    STATUS_TABLE_TITLE,
    newContent,
    true,
    STATUS_TABLE_ENTRY_DEFAULTS,
  );

  if (freedCharacters.length > 0) {
    await persistChatMetadata();
    for (const name of freedCharacters) {
      await handleCharacterBecameFree(name);
    }
  }

  if (newIssues.length > 0) {
    notify(
      "warning",
      `状态表重新计算时发现 ${newIssues.length} 处新的格式问题，相关内容已跳过：\n` +
        newIssues.map((w) => `· ${w}`).join("\n"),
    );
  }
}

// === Event handler: 楼层变化（新增/删除/编辑/重roll）后自动重算状态表（出错不弹窗打断阅读，仅打印控制台）===
const handleMessageForStatusTable = async () => {
  try {
    await rebuildStatusTableFromChat();
  } catch (error) {
    console.error("[剧情助手] 自动更新状态表时出错:", error);
  }
};

// === Helper: 生成一段楼层范围的"小总结"内容——连续有摘要模块的楼层直接读取并保留 Time/Location/Overview 拼接，
// 连续没有摘要模块的楼层区间才调用 AI 重新总结（方案A：分段回退）。不再提取/生成关系字段——
// 关系状态统一由状态表世界书条目实时持久化（见 mergeFloorIntoStatusTable），小总结/大总结只做叙事性回顾。===
// === Helper: 从摘要模块的 Time 原始文本里截取"年月"粒度的关键词——按字面"年"/"月"两个字切分，
// 不解析语义（纪年法/数字格式怎么变都不影响），取字符串开头到"月"字（含）为止；
// 找不到"年"或"月"就返回空字符串，交由调用方决定兜底策略。===
function extractYearMonthKeyword(timeText) {
  if (!timeText || typeof timeText !== "string") return "";
  const yearIdx = timeText.indexOf("年");
  if (yearIdx === -1) return "";
  const monthIdx = timeText.indexOf("月", yearIdx);
  if (monthIdx === -1) return "";
  return timeText.slice(0, monthIdx + 1);
}

async function buildRangeSummaryContent(batchStart, batchEnd, overlayOptions) {
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
async function generateSummaryRaw(systemPrompt, userContent) {
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
function showGeneratingOverlay(options) {
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

function closeGeneratingOverlay() {
  try {
    $(`#${GENERATING_OVERLAY_ID}`).remove();
  } catch (error) {
    console.error("[剧情助手] 关闭生成中提示框时出错:", error);
  }
}

// === Helper: 带"生成中"提示框的生成封装（DRY：多处调用统一走这里，成功/失败都会自动关闭提示框） ===
async function generateSummaryWithOverlay(
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

// === Helper: 统一的"功能说明 + 确认"弹窗（原生 Popup），三个总结按钮点击后的第一步 ===
async function confirmAction(title, messageHtml) {
  const context = getCtx();
  const result = await context.callGenericPopup(
    messageHtml,
    context.POPUP_TYPE.CONFIRM,
    "",
    {
      okButton: "继续",
      cancelButton: "取消",
      wide: true,
    },
  );
  return result === context.POPUP_RESULT.AFFIRMATIVE;
}

// === Helper: 世界书条目对象 -> 数组（原生世界书 entries 是以 uid 为 key 的对象，不是数组） ===
async function getLorebookEntriesArray(lorebookName) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries) return [];
  return Object.values(data.entries);
}

// === Helper: 为世界书数据分配一个未被占用的 uid（原生世界书条目以数字 uid 为 key） ===
function getFreeUid(data) {
  const MAX_UID = 1000000;
  for (let uid = 0; uid < MAX_UID; uid++) {
    if (!(uid in data.entries)) return uid;
  }
  return null;
}

// === Helper: 保存世界书后通知酒馆"数据已更新"，让世界书面板/选择列表等处及时刷新，不用手动刷新页面 ===
function notifyWorldInfoUpdated(lorebookName) {
  try {
    const context = getCtx();
    if (
      context.eventSource &&
      context.event_types &&
      context.event_types.WORLDINFO_UPDATED
    ) {
      context.eventSource.emit(
        context.event_types.WORLDINFO_UPDATED,
        lorebookName,
      );
    }
  } catch (error) {
    console.warn("[剧情助手] 触发 WORLDINFO_UPDATED 事件时出错:", error);
  }
}

// === Helper: 检查世界书里是否已存在指定标题的条目，不做任何创建/修改 ===
async function lorebookEntryExists(lorebookName, title) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries) return false;
  return Object.values(data.entries).some((entry) => entry.comment === title);
}

// === Helper: 保存/覆盖 世界书条目 ===
// 主要关键字留空（条目为 constant 常驻类型，不依赖关键字触发）。
// 组评分固定关闭，且开启"不可递归"+"防止进一步递归"，避免总结条目被其他条目递归激活或再触发递归。
// keywords 为可选参数：不传（undefined）时完全不影响已存在条目的 key（状态表、对话前强调等调用方不受影响）；
// 新建条目时若也未传，key 用默认空数组。传入时（哪怕是空数组 []）都会写入/覆盖 key。
async function saveOrOverwriteLorebookEntry(
  lorebookName,
  title,
  content,
  silentOverwrite,
  createDefaults,
  keywords,
) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  const existing = Object.values(data.entries).find(
    (entry) => entry.comment === title,
  );

  if (existing) {
    if (!silentOverwrite) {
      const confirmed = await context.callGenericPopup(
        `世界书中已存在标题为 "${title}" 的条目，是否覆盖？`,
        context.POPUP_TYPE.CONFIRM,
        "",
        { okButton: "覆盖", cancelButton: "取消" },
      );
      if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return false;
    }
    // 只更新标题和内容——位置/触发策略/深度等设置如果你在世界书面板里手动调整过，这里不再覆盖回去。
    data.entries[existing.uid].comment = title;
    data.entries[existing.uid].content = content;
    // 关键词跟随标题/正文一起刷新，但只在调用方主动传入时才动，避免影响不传关键词的调用方。
    if (keywords !== undefined) {
      data.entries[existing.uid].key = keywords;
    }
  } else {
    const newUid = getFreeUid(data);
    if (newUid === null) throw new Error("无法为新世界书条目分配 uid。");
    const baseFields = {
      comment: title,
      content,
      disable: false, // disable=false 表示启用
      constant: true, // constant=true 表示常驻类型
      key: keywords !== undefined ? keywords : [],
      position: 0, // 0 = 角色定义之前（对应原来的 before_prompt 语义）
      order: 0,
      useGroupScoring: false,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 0,
    };
    // createDefaults 只在新建时生效，用来覆盖上面这套默认位置/顺序等设置（比如状态表要靠近最新消息）。
    data.entries[newUid] = {
      uid: newUid,
      ...baseFields,
      ...(createDefaults || {}),
    };
  }

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
  return true;
}

// === Helper: 获取当前角色名 ===
function getCurrentCharacterName() {
  const context = getCtx();
  const char = context.characters?.[context.characterId];
  if (!char || !char.name) {
    throw new Error("未找到当前角色信息，请进入对话界面。");
  }
  return char.name;
}

// === Helper: 获取/创建 当前角色对应的总结世界书（角色名 + "总结"，与角色卡绑定世界书无关，独立存在） ===
// 用 loadWorldInfo 直接探测是否存在（返回 null / 无 entries 才视为不存在），
// 不依赖 getWorldInfoNames() 的本地缓存列表——那个列表只有调用过 updateWorldInfoList() 才会跟服务器同步，
// 用它来判断"存在与否"会因为同步延迟而误判成"不存在"，导致每次都重新创建、把已保存的内容覆盖掉。
async function getOrCreateSummaryLorebook() {
  const context = getCtx();
  const characterName = getCurrentCharacterName();
  const lorebookName = `${characterName}总结`;

  const existingData = await context.loadWorldInfo(lorebookName);
  if (!existingData || !existingData.entries) {
    await context.saveWorldInfo(lorebookName, { entries: {} }, true);
    notifyWorldInfoUpdated(lorebookName);
    if (typeof context.updateWorldInfoList === "function") {
      await context.updateWorldInfoList();
    }
  }
  return lorebookName;
}

// === Helper: 在 #world_info（酒馆原生全局世界书多选框）里按书名文本找到对应的 <option> ===
// 不做"下标 -> 世界书数组"的换算（那样依赖两次读取之间 world_names 顺序一致，容易因为中间刷新一次列表而错位）。
// 直接按文本比对，跟酒馆自己内部 getWIElement() 判断选中项的方式一致，更可靠。
function findWorldInfoOption(lorebookName) {
  return $("#world_info")
    .children()
    .filter(function () {
      return $(this).text().toLowerCase() === lorebookName.toLowerCase();
    });
}

// === Helper: 获取当前全局启用世界书的书名列表 ===
// 直接读 #world_info 里被选中的 <option> 的文本，不经过下标。
function getGloballyEnabledWorldNames() {
  return $("#world_info option:selected")
    .map(function () {
      return $(this).text();
    })
    .get();
}

// === Helper: 检查总结世界书当前是否已挂载为全局世界书 ===
async function isSummaryLorebookGloballyEnabled(lorebookName) {
  let $opt = findWorldInfoOption(lorebookName);
  if ($opt.length === 0) {
    // #world_info 可能还没初始化过（没打开过原生世界书面板），刷新一次列表再找
    const context = getCtx();
    if (typeof context.updateWorldInfoList === "function") {
      await context.updateWorldInfoList();
    }
    $opt = findWorldInfoOption(lorebookName);
  }
  return $opt.length > 0 && $opt.is(":selected");
}

// === Helper: 挂载总结世界书为全局世界书 ===
// 挂载前先检查全局列表里是否还有别的书（排除总结世界书自身），如果有，弹确认框询问是否顺带清理，
// 只保留这一本总结世界书——多数场景全局只需要挂这一本；如果用户就是想同时挂好几本，选"否"即可，插件不强制清理。
// 只处理"挂载"方向的清理逻辑；"取消挂载"由面板按钮直接调用 /world state=off 完成，不经过这个函数，
// 也不做任何清理——这样"先摘旧角色卡总结书，再挂新角色卡总结书"时，其他全局书不会被误动。
// 挂载动作固定用 state=on（不用 toggle）：不管插件自己判断的"当前状态"准不准，点一次「挂载」结果永远是"开"，
// 不会因为状态判断偶尔有误差就把方向弄反。
async function mountSummaryLorebookGlobally(lorebookName) {
  const context = getCtx();
  if (typeof context.updateWorldInfoList === "function") {
    await context.updateWorldInfoList();
  }

  const otherEnabledNames = getGloballyEnabledWorldNames().filter(
    (name) => name !== lorebookName,
  );
  if (otherEnabledNames.length > 0) {
    const proceed = await confirmAction(
      "清理全局世界书",
      `检测到全局世界书列表里还有其他书：<b>${otherEnabledNames.join("、")}</b>，是否一并取消挂载，只保留「${lorebookName}」？<br><br>选"取消"则保留它们，只额外挂载「${lorebookName}」。`,
    );
    if (proceed) {
      for (const name of otherEnabledNames) {
        await context.executeSlashCommandsWithOptions(
          `/world silent=true state=off "${name}"`,
        );
      }
    }
  }

  await context.executeSlashCommandsWithOptions(
    `/world silent=true state=on "${lorebookName}"`,
  );
}

// === Helper: 读取"对话前强调"条目当前内容（供打开编辑框时预填） ===
async function loadPreEmphasisEntry() {
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
async function savePreEmphasisEntry(content, enabled) {
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

// === Function: 打开"对话前强调"编辑框（启用开关 + 文本内容，取消/保存） ===
async function openPreEmphasisDialog() {
  let state;
  try {
    state = await loadPreEmphasisEntry();
  } catch (error) {
    console.error("[剧情助手] 加载对话前强调条目失败:", error);
    notify("error", `加载对话前强调条目失败：${error.message || error}`);
    return;
  }

  const existingContent = state.existing
    ? state.existing.content || ""
    : DEFAULT_PRE_EMPHASIS_CONTENT;
  const existingEnabled = state.existing ? !state.existing.disable : false;

  const $bodyEl = $("body");
  const prevBodyOverflow = $bodyEl.css("overflow");
  $bodyEl.css("overflow", "hidden");

  const result = await new Promise((resolve) => {
    const $overlay = $("<div>").css({
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: "rgba(0,0,0,0.72)",
      zIndex: 99999,
      boxSizing: "border-box",
    });

    // 与「剧情助手控制面板」保持一致：固定锚定在屏幕顶部附近，而不是用 flex 居中。
    // 居中方案在移动端弹出虚拟键盘时，vh 不会随可视视口收缩而实时更新，
    // 会导致对话框标题/底部按钮被键盘或屏幕边缘裁掉；顶部锚定 + dvh 可以避免这个问题。
    const $box = $("<div>").css({
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#252525",
      border: "1px solid #3a3a3a",
      borderRadius: "10px",
      padding: "clamp(16px, 4vw, 24px)",
      width: "min(400px, calc(100% - 24px))",
      maxHeight: "min(85vh, calc(100dvh - 24px))",
      display: "flex",
      flexDirection: "column",
      gap: "16px",
      color: "#e8e8e8",
      fontFamily: "inherit",
      boxSizing: "border-box",
      boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
    });

    const $title = $("<div>").text(PRE_EMPHASIS_TITLE).css({
      fontSize: "1.05em",
      fontWeight: "600",
      color: "#f0f0f0",
      letterSpacing: "0.01em",
    });

    const $switchRow = $("<label>").css({
      display: "flex",
      alignItems: "center",
      gap: "10px",
      fontSize: "0.9em",
      color: "#c0c0c0",
      cursor: "pointer",
      userSelect: "none",
      minHeight: "32px",
      touchAction: "manipulation",
    });
    const $switchInput = $('<input type="checkbox">')
      .prop("checked", existingEnabled)
      .css({
        width: "20px",
        height: "20px",
        cursor: "pointer",
        flexShrink: 0,
      });
    $switchRow.append($switchInput, $("<span>").text("启用此条目"));

    const inputCss = {
      width: "100%",
      boxSizing: "border-box",
      padding: "8px 10px",
      borderRadius: "6px",
      border: "1px solid #3a3a3a",
      background: "#1a1a1a",
      color: "#d0d0d0",
      fontSize: "max(0.95em, 16px)",
      fontFamily: "inherit",
      outline: "none",
    };

    const $textWrap = $("<div>").css({
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      minHeight: 0,
    });
    $textWrap.append(
      $("<label>").text("提示内容").css({ fontSize: "0.82em", color: "#999" }),
    );
    const $textInput = $("<textarea>")
      .attr({ rows: 8 })
      .css({
        ...inputCss,
        resize: "vertical",
        minHeight: "120px",
        maxHeight: "min(40vh, 40dvh)",
      })
      .val(existingContent);
    $textWrap.append($textInput);

    const $btnRow = $("<div>").css({
      display: "flex",
      gap: "10px",
      justifyContent: "flex-end",
      marginTop: "4px",
    });
    const btnCss = {
      padding: "10px 20px",
      borderRadius: "6px",
      minHeight: "44px",
      boxSizing: "border-box",
      cursor: "pointer",
      fontSize: "0.95em",
      touchAction: "manipulation",
    };
    const $cancel = $("<button>")
      .text("取消")
      .css({
        ...btnCss,
        border: "1px solid #3a3a3a",
        background: "transparent",
        color: "#c0c0c0",
      });
    const $confirm = $("<button>")
      .text("保存")
      .css({
        ...btnCss,
        border: "none",
        background: "#5b9cf6",
        color: "#ffffff",
        fontWeight: "600",
      });
    $btnRow.append($cancel, $confirm);

    $box.append($title, $switchRow, $textWrap, $btnRow);
    $overlay.append($box);
    $("body").append($overlay);
    setTimeout(() => $textInput.trigger("focus"), 50);

    const done = (confirmed) => {
      $(document).off("keydown.preEmphasisDialog");
      $overlay.remove();
      $bodyEl.css("overflow", prevBodyOverflow || "");
      resolve(
        confirmed
          ? { content: $textInput.val(), enabled: $switchInput.prop("checked") }
          : null,
      );
    };

    $confirm.on("click", () => done(true));
    $cancel.on("click", () => done(false));

    let overlayPointerDownOnSelf = false;
    $overlay.on("mousedown touchstart", (e) => {
      overlayPointerDownOnSelf = $(e.target).is($overlay);
    });
    $overlay.on("mouseup touchend", (e) => {
      if (overlayPointerDownOnSelf && $(e.target).is($overlay)) done(false);
      overlayPointerDownOnSelf = false;
    });
    $(document).on("keydown.preEmphasisDialog", (e) => {
      if (e.key === "Escape") done(false);
    });
  });

  if (!result) return;

  try {
    const lorebookName = await savePreEmphasisEntry(
      result.content,
      result.enabled,
    );
    notify(
      "success",
      `对话前强调已保存到「${lorebookName}」（${result.enabled ? "已启用" : "已禁用"}）`,
    );
  } catch (error) {
    console.error("[剧情助手] 保存对话前强调条目失败:", error);
    notify("error", `保存对话前强调条目失败：${error.message || error}`);
  }
}

// =====================================================================================
// === 角色卡功能 ===
// 与总结/状态表共用同一本"角色名总结"世界书，条目标题固定加 CHARACTER_ENTRY_TITLE_PREFIX 前缀，
// 关键词触发（selective），只有正文提到该人名时才会注入上下文。
// 已有条目的编辑/删除直接复用面板下方通用的"世界书条目"列表（.entry-save / .entry-delete），
// 这里只负责"新建"这一步。
// =====================================================================================

// === Helper: 从角色名提取触发关键词（全名 + 去姓简称），沿用原脚本规则 ===
function extractCharacterKeywords(name) {
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(name)) {
    const len = name.length;
    if (len === 2) return [name];
    if (len === 3) return [name, name.slice(1)];
    if (len === 4) return [name, name.slice(2)];
  }
  if (/^[A-Za-z]+([ ][A-Za-z]+)+$/.test(name)) {
    return [name, name.split(" ")[0]];
  }
  return [name];
}

// === Helper: 新建一条角色卡条目（重名会报错，请去下方世界书条目列表里直接编辑） ===
async function saveNewCharacterEntry(lorebookName, name, gender, other) {
  const context = getCtx();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  const title = CHARACTER_ENTRY_TITLE_PREFIX + name;
  const existing = Object.values(data.entries).find(
    (entry) => entry.comment === title,
  );
  if (existing) {
    throw new Error(
      `联系人「${name}」已存在，请在下方"世界书条目"列表里直接编辑，或换一个名字`,
    );
  }

  const newUid = getFreeUid(data);
  if (newUid === null) throw new Error("无法为新世界书条目分配 uid。");

  // 固定存 gender / other 两个字段（配合手机私信面板"读取姓名/性别/其它"，姓名已经在 comment/character 属性里了）。
  // other 支持多行文本，原样拼在 "other:" 之后，作为整个标签内最后一个字段。
  const content = `<character_information character="${name}">\ngender: ${gender || ""}\nother: ${other || ""}\n</character_information>`;

  data.entries[newUid] = {
    uid: newUid,
    comment: title,
    content,
    disable: true, // 默认关闭：不会自动注入正文，手机插件需要时直接读取内容即可
    constant: false, // 关键词触发，不常驻（关闭状态下这个也不生效，留着方便你以后手动开启）
    key: extractCharacterKeywords(name),
    position: 0, // 角色定义之前
    useGroupScoring: false,
    excludeRecursion: true,
    preventRecursion: true,
    delayUntilRecursion: 0,
    ...CHARACTER_ENTRY_DEFAULTS,
  };

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
  return name;
}

// === Function: 打开"新建角色"弹窗（角色名 + 其他信息，样式对齐"对话前强调"弹窗） ===
async function openCreateCharacterDialog() {
  const $bodyEl = $("body");
  const prevBodyOverflow = $bodyEl.css("overflow");
  $bodyEl.css("overflow", "hidden");

  const result = await new Promise((resolve) => {
    const $overlay = $("<div>").css({
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: "rgba(0,0,0,0.72)",
      zIndex: 99999,
      boxSizing: "border-box",
    });

    const $box = $("<div>").css({
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#252525",
      border: "1px solid #3a3a3a",
      borderRadius: "10px",
      padding: "clamp(16px, 4vw, 24px)",
      width: "min(400px, calc(100% - 24px))",
      maxHeight: "min(85vh, calc(100dvh - 24px))",
      display: "flex",
      flexDirection: "column",
      gap: "16px",
      color: "#e8e8e8",
      fontFamily: "inherit",
      boxSizing: "border-box",
      boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
    });

    const $title = $("<div>").text("添加联系人").css({
      fontSize: "1.05em",
      fontWeight: "600",
      color: "#f0f0f0",
      letterSpacing: "0.01em",
    });

    const inputCss = {
      width: "100%",
      boxSizing: "border-box",
      padding: "8px 10px",
      borderRadius: "6px",
      border: "1px solid #3a3a3a",
      background: "#1a1a1a",
      color: "#d0d0d0",
      fontSize: "max(0.95em, 16px)",
      fontFamily: "inherit",
      outline: "none",
    };

    const $errorMsg = $("<div>").css({
      fontSize: "0.82em",
      color: "#f28b82",
      display: "none",
    });

    const $nameWrap = $("<div>").css({
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });
    $nameWrap.append(
      $("<label>")
        .html('联系人姓名 <span style="color:#f28b82">*</span>')
        .css({ fontSize: "0.82em", color: "#999" }),
    );
    const $nameInput = $('<input type="text">')
      .attr("placeholder", "姓名")
      .css(inputCss);
    $nameWrap.append($nameInput);

    const $genderWrap = $("<div>").css({
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });
    $genderWrap.append(
      $("<label>")
        .html('性别 <span style="color:#f28b82">*</span>')
        .css({ fontSize: "0.82em", color: "#999" }),
    );
    const $genderInput = $('<input type="text">')
      .attr("placeholder", "男/女")
      .css(inputCss);
    $genderWrap.append($genderInput);

    const $otherWrap = $("<div>").css({
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });
    $otherWrap.append(
      $("<label>").text("其它").css({ fontSize: "0.82em", color: "#999" }),
    );
    const $otherInput = $("<textarea>")
      .attr("placeholder", "性格、背景、说话习惯等，选填")
      .css({ ...inputCss, minHeight: "90px", resize: "vertical" });
    $otherWrap.append($otherInput);

    const $btnRow = $("<div>").css({
      display: "flex",
      gap: "10px",
      justifyContent: "flex-end",
      marginTop: "4px",
    });
    const btnCss = {
      padding: "10px 20px",
      borderRadius: "6px",
      minHeight: "44px",
      boxSizing: "border-box",
      cursor: "pointer",
      fontSize: "0.95em",
      touchAction: "manipulation",
    };
    const $cancel = $("<button>")
      .text("取消")
      .css({
        ...btnCss,
        border: "1px solid #3a3a3a",
        background: "transparent",
        color: "#c0c0c0",
      });
    const $confirm = $("<button>")
      .text("写入世界书")
      .css({
        ...btnCss,
        border: "none",
        background: "#5b9cf6",
        color: "#ffffff",
        fontWeight: "600",
      });
    $btnRow.append($cancel, $confirm);

    $box.append($title, $nameWrap, $genderWrap, $otherWrap, $errorMsg, $btnRow);
    $overlay.append($box);
    $("body").append($overlay);
    setTimeout(() => $nameInput.trigger("focus"), 50);

    const done = (confirmed) => {
      $(document).off("keydown.createCharacterDialog");
      $overlay.remove();
      $bodyEl.css("overflow", prevBodyOverflow || "");
      resolve(
        confirmed
          ? {
              name: $nameInput.val().trim(),
              gender: $genderInput.val().trim(),
              other: $otherInput.val().trim(),
            }
          : null,
      );
    };

    // 姓名 + 性别必填，留空时不关闭弹窗，标红对应输入框并提示。
    const tryConfirm = () => {
      const nameVal = $nameInput.val().trim();
      const genderVal = $genderInput.val().trim();
      const missing = [];
      $nameInput.css("borderColor", nameVal ? "#3a3a3a" : "#f28b82");
      $genderInput.css("borderColor", genderVal ? "#3a3a3a" : "#f28b82");
      if (!nameVal) missing.push("姓名");
      if (!genderVal) missing.push("性别");
      if (missing.length > 0) {
        $errorMsg.text(`请填写：${missing.join("、")}`).css("display", "block");
        return;
      }
      done(true);
    };

    $confirm.on("click", tryConfirm);
    $cancel.on("click", () => done(false));

    let overlayPointerDownOnSelf = false;
    $overlay.on("mousedown touchstart", (e) => {
      overlayPointerDownOnSelf = $(e.target).is($overlay);
    });
    $overlay.on("mouseup touchend", (e) => {
      if (overlayPointerDownOnSelf && $(e.target).is($overlay)) done(false);
      overlayPointerDownOnSelf = false;
    });
    $(document).on("keydown.createCharacterDialog", (e) => {
      if (e.key === "Escape") done(false);
    });
  });

  if (!result || !result.name) return;

  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const saved = await saveNewCharacterEntry(
      lorebookName,
      result.name,
      result.gender,
      result.other,
    );
    notify("success", `联系人「${saved}」已写入「${lorebookName}」`);
  } catch (error) {
    console.error("[剧情助手] 写入联系人条目失败:", error);
    notify("error", `写入联系人条目失败：${error.message || error}`);
  }
}

// === Helper: 获取世界书条目摘要 HTML（面板展示用） ===
async function getLorebookEntriesSummaryHtml(lorebookName) {
  try {
    if (!lorebookName) return "未关联世界书";

    const entries = await getLorebookEntriesArray(lorebookName);
    if (!entries || entries.length === 0) return "当前世界书中没有条目";

    let summaryHTML =
      "<ul style='list-style: none; padding-left: 0; margin: 0;'>";

    entries.forEach((entry, index) => {
      const title = entry.comment || "无标题";
      const content = entry.content || "无内容";
      const uid = entry.uid;

      const isValidUid =
        uid !== null && uid !== undefined && !isNaN(parseInt(uid, 10));
      const displayUid = isValidUid ? uid : `(无效ID-${index})`;
      const sanitizedContent = (content || "")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      summaryHTML += `
        <li id="lorebook-entry-${displayUid}" class="lorebook-entry" style="margin-bottom: 5px; padding: 3px 8px; border-radius: 6px; background: #333; ${
          !isValidUid ? "opacity: 0.7;" : ""
        }">
          <div class="entry-header" style="display: flex; justify-content: space-between; align-items: center; cursor: ${
            isValidUid ? "pointer" : "default"
          }; min-height: 24px;">
            <div style="font-weight: 500; color: #72b1e8; font-size: 13px;">${title} ${
              !isValidUid
                ? '<span style="color:#d53a3a; font-size:11px;">(无法编辑)</span>'
                : ""
            }</div>
            <div style="display: flex; gap: 5px;">
              ${
                isValidUid
                  ? '<span class="entry-toggle" style="color: #aaa; font-size: 11px; line-height: 1;">▼</span>'
                  : ""
              }
            </div>
          </div>
          ${
            isValidUid
              ? `
          <div class="entry-content" style="display: none; margin-top: 8px;">
            <div style="position: relative;">
              <textarea class="entry-textarea" style="width: 100%; min-height: 100px; background: #262626; color: #ddd; border: 1px solid #444; border-radius: 4px; padding: 8px; font-size: 13px; margin-bottom: 8px;">${sanitizedContent}</textarea>
              <div style="display: flex; justify-content: flex-end; gap: 8px;">
                <button class="entry-save" data-uid="${uid}" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px;">保存</button>
                <button class="entry-delete" data-uid="${uid}" style="background: #d53a3a; border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px;">删除</button>
              </div>
            </div>
          </div>
          `
              : `
          <div class="entry-content" style="margin-top: 8px; padding: 8px; background: #2a2a2a; border-radius: 4px; color: #aaa; font-size: 13px;">${sanitizedContent.replace(
            /\n/g,
            "<br>",
          )}</div>
          `
          }
        </li>`;
    });

    summaryHTML += "</ul>";
    return summaryHTML;
  } catch (error) {
    console.error("[剧情助手] 获取世界书条目时出错:", error);
    return "获取世界书条目时出错";
  }
}

// =====================================================================================
// === Function: 自动小总结 ===
// 从世界书中已有进度自动往后按批总结，直至覆盖全部楼层。
// 如果本对话通过"设定起始楼层"设置过起始楼层，会自动按该起始楼层偏移写入世界书的楼层编号
// （读取原始聊天记录仍然用本地楼层号，只有世界书条目标题里的楼层号会加上起始楼层）；
// 没设置过则起始楼层视为 0，行为等同于楼层号不偏移。
// =====================================================================================
const runAutoSmallSummary = errorCatched(async () => {
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
const runSetOffset = errorCatched(async () => {
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
const runAutoLargeSummary = errorCatched(async () => {
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

// === Function: 在扩展菜单里插入「剧情助手」入口 ===
function createMenuButton() {
  try {
    let $button = $(`#${SUMMARY_BUTTON_ID}`);

    if ($button.length > 0) return; // 已存在则不重复插入

    addButtonStyles();

    const buttonHtml = `
      <div id="${SUMMARY_BUTTON_ID}" class="list-group-item flex-container flexGap5 interactable"
           title="${SUMMARY_BUTTON_TOOLTIP}" tabIndex="0">
        <i class="${SUMMARY_BUTTON_ICON}"></i>
        <span>${SUMMARY_BUTTON_TEXT}</span>
      </div>
    `;

    const $extensionsMenu = $("#extensionsMenu");

    if ($extensionsMenu.length) {
      $extensionsMenu.append(buttonHtml);
      $(document)
        .off(`click.${SUMMARY_BUTTON_ID}`)
        .on(`click.${SUMMARY_BUTTON_ID}`, `#${SUMMARY_BUTTON_ID}`, (event) => {
          event.preventDefault();
          showSummaryPopup();
        });
      console.log("[剧情助手] 按钮已插入扩展菜单");
    } else {
      console.warn("[剧情助手] 未找到扩展菜单 (#extensionsMenu)");
    }
  } catch (error) {
    console.error("[剧情助手] 创建菜单按钮时出错:", error);
  }
}

function addButtonStyles() {
  if ($("#summary-assistant-button-styles").length === 0) {
    const styles = `
      <style id="summary-assistant-button-styles">
        #${SUMMARY_BUTTON_ID} {
          cursor: pointer;
        }
      </style>
    `;
    $("head").append(styles);
  }
}

// === Function: 删除一个 IndexedDB 数据库（用于"清空数据"）===
// 如果本页面还有该库的连接没关闭，浏览器会触发 onblocked 而不是立刻成功/失败，
// 这里给个超时兜底，避免整个清空流程卡住不返回；真遇到 blocked 的情况会在控制台留日志，
// 提醒用户刷新页面重试（IndexedDB 规范本身没有"强制踢掉其他连接"的办法）。
function deleteIndexedDatabase(name) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => finish(true);
      req.onerror = () => finish(false);
      req.onblocked = () => {
        console.warn(
          `[剧情助手] 删除数据库 ${name} 被阻塞，可能还有未关闭的连接，请刷新页面后重试。`,
        );
      };
      // 兜底：万一 onblocked 之后也不再触发 onsuccess/onerror，别让调用方一直等下去。
      setTimeout(() => finish(false), 5000);
    } catch (error) {
      console.error(`[剧情助手] 删除数据库 ${name} 时出错:`, error);
      finish(false);
    }
  });
}

// === Function: 清空本插件的全部本地缓存数据（控制面板"清空数据"按钮）===
// 范围：两个 IndexedDB 库（私信/头像/图片/背景 + 地图图片）、两个悬浮球位置的 localStorage、
// 三块插件自己的 extension_settings（通讯器/地图/移动端优化，删掉后下次读取会自动用默认值重建）、
// 以及所有对话的起始楼层记录和私信忙闲缓存（本地存储，一份 localStorage 覆盖所有对话，一次性清空）。
// 不包含：总结功能生成的世界书条目（用户自己在世界书里删）。
async function clearAllPluginLocalData() {
  const results = await Promise.all([
    deleteIndexedDatabase(PHONE_IDB_NAME),
    deleteIndexedDatabase(IDB_NAME),
  ]);

  try {
    localStorage.removeItem(FAB_POS_KEY);
    localStorage.removeItem(PHONE_FAB_POS_KEY);
  } catch (error) {
    console.error("[剧情助手] 清空 localStorage 悬浮球位置记忆失败:", error);
  }

  try {
    delete extension_settings[PHONE_MODULE_NAME];
    delete extension_settings[MAP_MODULE_NAME];
    delete extension_settings[MOBILE_OPT_SETTINGS_KEY];
    saveSettingsDebounced();
  } catch (error) {
    console.error("[剧情助手] 重置插件配置失败:", error);
  }

  try {
    localStorage.removeItem(LOCAL_CHAT_STORE_KEY);
    localChatStoreCache = null; // 内存缓存也一并重置，避免清空后马上又读到清空前的旧对象
    transientChatMetadataStore = null;
  } catch (error) {
    console.error("[剧情助手] 清空所有对话的楼层/忙闲缓存失败:", error);
  }

  const allDbOk = results.every(Boolean);
  return { allDbOk };
}

// === Function: 显示剧情助手控制面板 ===
async function showSummaryPopup() {
  try {
    const POPUP_ID = SUMMARY_POPUP_ID;

    $(`#${POPUP_ID}`).remove();
    $(`#${POPUP_ID}-overlay`).remove();

    $(document).off("click", ".lorebook-entry .entry-header");
    $(document).off("click", ".entry-save");
    $(document).off("click", ".entry-delete");

    await ensureSummaryLorebookOnLoad();
    const summaryLorebookName = await getOrCreateSummaryLorebook();
    const lorebookEntriesHTML =
      await getLorebookEntriesSummaryHtml(summaryLorebookName);
    const isMountedGlobally =
      await isSummaryLorebookGloballyEnabled(summaryLorebookName);
    const currentOffsetRecord = getOffsetRecord();
    const currentOffsetDisplay = currentOffsetRecord
      ? `第 ${currentOffsetRecord.offset} 层`
      : "未设置（默认第 0 层，不偏移）";

    const popupContent = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #444;">
        <h3 style="margin: 0; color: #e0e0e0; font-weight: 500; font-size: 18px;">剧情助手控制面板</h3>
        <div>
          <button id="close-${POPUP_ID}" style="background: transparent; border: none; color: #aaa; cursor: pointer; font-size: 20px; padding: 0; margin: 0; transition: color 0.2s; vertical-align: middle;">&times;</button>
        </div>
      </div>

      <div id="${POPUP_ID}-content" style="max-height: 60vh; overflow-y: auto; font-size: 14px; color: #bbb; scrollbar-width: thin; scrollbar-color: #666 #333; padding-right: 10px;">
        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">总结功能</p>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button id="${POPUP_ID}-auto-small" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">自动小总结</button>
            <button id="${POPUP_ID}-set-offset" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">设定起始楼层</button>
            <button id="${POPUP_ID}-auto-large" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">自动大总结</button>
          </div>
          <div style="margin-top: 8px; font-size: 12px; color: #888;">本对话当前起始楼层：<span style="color: #aaa;">${currentOffsetDisplay}</span></div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">输出强调</p>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button id="${POPUP_ID}-pre-emphasis" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">对话前强调</button>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">联系人</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <button id="${POPUP_ID}-create-character" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">添加联系人</button>
              <button id="${POPUP_ID}-phone-preset" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">私信预设</button>
            </div>
            <button id="${POPUP_ID}-phone-fab-toggle" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">地图</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px;">
            <button id="${POPUP_ID}-map-marker" style="background: #3a7bd5; border: none; color: #fff; cursor: pointer; font-size: 13px; padding: 8px 12px; border-radius: 4px; transition: background-color 0.2s;">地图标记</button>
            <button id="${POPUP_ID}-fab-toggle" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px;">
            <p style="color: #72b1e8; font-weight: 500; margin: 0;">世界书条目 (${summaryLorebookName})</p>
            <button id="${POPUP_ID}-mount-global" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
          <div id="${POPUP_ID}-lorebook" style="background: #333; border-radius: 6px; padding: 10px; font-size: 13px;">
            ${lorebookEntriesHTML}
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">数据管理</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0;">
            <span style="font-size: 12px; color: #999; flex: 1;">清空私信记录、头像库、图片库、背景库、地图标记数据、悬浮球位置记忆、所有对话的起始楼层/忙闲缓存等本地缓存（不含世界书总结条目）</span>
            <button id="${POPUP_ID}-clear-all-data" style="background: #c0392b; border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;">清空数据</button>
          </div>
        </div>

        <div>
          <p style="color: #72b1e8; font-weight: 500; margin-bottom: 10px;">移动端优化</p>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0;">
            <span style="font-size: 12px; color: #999; flex: 1;">折叠预设滑块 · 优化输入法弹窗 · 优化长聊渲染</span>
            <button id="${POPUP_ID}-mobile-opt-render" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid #3a3a3a;">
            <span style="font-size: 12px; color: #999; flex: 1;">懒加载头像与角色列表 · 不预载最近聊天页对话</span>
            <button id="${POPUP_ID}-mobile-opt-lazyload" style="border: none; color: #fff; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transition: background-color 0.2s;"></button>
          </div>
        </div>
      </div>
    `;

    const $overlay = $("<div></div>")
      .attr("id", `${POPUP_ID}-overlay`)
      .css({
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        zIndex: 9998,
        backdropFilter: "blur(2px)",
      })
      .on("click", function (e) {
        if (e.target === this) closePopup();
      });

    const $popup = $("<div></div>")
      .attr("id", POPUP_ID)
      .css({
        position: "fixed",
        top: "70px",
        left: "50%",
        transform: "translateX(-50%)",
        width: "600px",
        maxWidth: "90%",
        maxHeight: "80vh",
        background: "#262626",
        color: "#e0e0e0",
        border: "none",
        borderRadius: "8px",
        boxShadow: "0 15px 30px rgba(0, 0, 0, 0.6)",
        padding: "20px",
        zIndex: 9999,
        boxSizing: "border-box",
        overflow: "hidden",
        fontFamily: "system-ui, -apple-system, sans-serif",
        animation: "summaryAssistantPopupFadeIn 0.2s ease-out",
      })
      .html(popupContent);

    if ($("#summary-assistant-popup-animation-style").length === 0) {
      const styleElement = document.createElement("style");
      styleElement.id = "summary-assistant-popup-animation-style";
      styleElement.textContent = `
        @keyframes summaryAssistantPopupFadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `;
      document.head.appendChild(styleElement);
    }

    $("body").append($overlay).append($popup);

    function closePopup() {
      try {
        $(document).off("click", ".lorebook-entry .entry-header");
        $(document).off("click", ".entry-save");
        $(document).off("click", ".entry-delete");

        $(`#${POPUP_ID}`).remove();
        $(`#${POPUP_ID}-overlay`).remove();
        console.log("[剧情助手] 弹窗已关闭");
      } catch (e) {
        console.error("[剧情助手] 关闭弹窗失败:", e);
      }
    }

    $(`#close-${POPUP_ID}`)
      .on("click", closePopup)
      .hover(
        function () {
          $(this).css("color", "#fff");
        },
        function () {
          $(this).css("color", "#aaa");
        },
      );

    $(`#${POPUP_ID}-auto-small`)
      .on("click", () => {
        closePopup();
        runAutoSmallSummary();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-set-offset`)
      .on("click", () => {
        closePopup();
        runSetOffset();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-auto-large`)
      .on("click", () => {
        closePopup();
        runAutoLargeSummary();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-pre-emphasis`)
      .on("click", () => {
        closePopup();
        openPreEmphasisDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-create-character`)
      .on("click", () => {
        closePopup();
        openCreateCharacterDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-phone-preset`)
      .on("click", () => {
        closePopup();
        openPhonePresetDialog();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    $(`#${POPUP_ID}-map-marker`)
      .on("click", () => {
        closePopup();
        openModal();
      })
      .hover(
        function () {
          $(this).css("background", "#2c5d9e");
        },
        function () {
          $(this).css("background", "#3a7bd5");
        },
      );

    // 悬浮球显示开关：点击只切换状态，不关闭弹窗，方便连续切换/立刻在屏幕上看到效果。
    const FAB_TOGGLE_ON_STYLE = { background: "#3a9d5a" };
    const FAB_TOGGLE_OFF_STYLE = { background: "#555" };

    function renderFabToggleButton($btn, visible) {
      $btn
        .text(visible ? "悬浮球开" : "悬浮球关")
        .css(visible ? FAB_TOGGLE_ON_STYLE : FAB_TOGGLE_OFF_STYLE);
    }

    const $fabToggleBtn = $(`#${POPUP_ID}-fab-toggle`);
    renderFabToggleButton($fabToggleBtn, getFabVisible());

    $fabToggleBtn.on("click", () => {
      const nowVisible = !getFabVisible();
      setFabVisibleSetting(nowVisible);
      // 关闭悬浮球时顺带重置位置：不管之前拖到哪、坐标有没有问题，
      // 下次点「悬浮球开」都能回到干净的默认位置，等于顺手兼职一个重置入口。
      if (!nowVisible) resetFabPos();
      applyFabVisibility();
      renderFabToggleButton($fabToggleBtn, nowVisible);
    });

    // 通讯器悬浮球显示开关：逻辑跟上面地图悬浮球那个完全一致，独立的开关/独立的坐标存储。
    const PHONE_FAB_TOGGLE_ON_STYLE = { background: "#3a9d5a" };
    const PHONE_FAB_TOGGLE_OFF_STYLE = { background: "#555" };

    function renderPhoneFabToggleButton($btn, visible) {
      $btn
        .text(visible ? "通讯器开" : "通讯器关")
        .css(visible ? PHONE_FAB_TOGGLE_ON_STYLE : PHONE_FAB_TOGGLE_OFF_STYLE);
    }

    const $phoneFabToggleBtn = $(`#${POPUP_ID}-phone-fab-toggle`);
    renderPhoneFabToggleButton($phoneFabToggleBtn, getPhoneFabVisible());

    $phoneFabToggleBtn.on("click", () => {
      const nowVisible = !getPhoneFabVisible();
      setPhoneFabVisibleSetting(nowVisible);
      if (!nowVisible) resetPhoneFabPos();
      applyPhoneFabVisibility();
      renderPhoneFabToggleButton($phoneFabToggleBtn, nowVisible);
    });

    // 清空数据：二次确认，确认后清空本地缓存（不含世界书总结条目），成功后提示刷新手机弹窗
    $(`#${POPUP_ID}-clear-all-data`).on(
      "click",
      errorCatched(async () => {
        const context = getCtx();
        const confirmed = await context.callGenericPopup(
          "确定要清空本插件的本地缓存数据吗？包括：私信记录、头像库、图片库、背景库、地图标记数据、悬浮球位置记忆、所有对话的起始楼层记录和私信忙闲缓存。<br>不包含世界书里生成的总结条目。<br>此操作不可撤销。",
          context.POPUP_TYPE.CONFIRM,
          "",
          { okButton: "清空", cancelButton: "取消" },
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;

        const { allDbOk } = await clearAllPluginLocalData();
        if (allDbOk) {
          notify(
            "success",
            "已清空本地缓存数据。手机弹窗里的背景、头像等已被清除，建议重新打开一下手机弹窗。",
          );
        } else {
          notify(
            "warning",
            "部分数据库清空时被浏览器阻塞（可能有页面连接未关闭），其余数据已清空。请刷新页面后重新点一次「清空数据」。",
          );
        }
      }),
    );

    // 移动端优化：两个开关按钮，点击只切换状态，不关闭弹窗
    const MOBILE_OPT_ON_STYLE = { background: "#3a9d5a" };
    const MOBILE_OPT_OFF_STYLE = { background: "#555" };

    function renderMobileOptButton($btn, isOn) {
      $btn
        .text(isOn ? "已开启" : "未开启")
        .css(isOn ? MOBILE_OPT_ON_STYLE : MOBILE_OPT_OFF_STYLE);
    }

    const $mobileOptRenderBtn = $(`#${POPUP_ID}-mobile-opt-render`);
    const $mobileOptLazyBtn = $(`#${POPUP_ID}-mobile-opt-lazyload`);
    const mobileOptSettings = getMobileOptSettings();
    renderMobileOptButton(
      $mobileOptRenderBtn,
      mobileOptSettings.renderOptimize,
    );
    renderMobileOptButton($mobileOptLazyBtn, mobileOptSettings.lazyLoad);

    $mobileOptRenderBtn.on("click", () => {
      const s = getMobileOptSettings();
      s.renderOptimize = !s.renderOptimize;
      if (s.renderOptimize) {
        enableRenderOptimizeGroup();
      } else {
        disableRenderOptimizeGroup();
      }
      saveSettingsDebounced();
      renderMobileOptButton($mobileOptRenderBtn, s.renderOptimize);
    });

    $mobileOptLazyBtn.on("click", () => {
      const s = getMobileOptSettings();
      s.lazyLoad = !s.lazyLoad;
      if (s.lazyLoad) {
        enableLazyLoadGroup();
      } else {
        disableLazyLoadGroup();
      }
      saveSettingsDebounced();
      renderMobileOptButton($mobileOptLazyBtn, s.lazyLoad);
    });

    // 全局世界书挂载：真正的开关按钮。
    // 未挂载 -> 点击走"挂载"流程（会检测其他全局书，问是否顺带清理，只保留这一本）；
    // 已挂载 -> 点击只做单纯的 toggle off，不碰其他全局书，方便"先摘旧角色卡，再挂新角色卡"这种切换场景。
    const MOUNT_GLOBAL_ON_STYLE = { background: "#3a9d5a", cursor: "pointer" };
    const MOUNT_GLOBAL_OFF_STYLE = { background: "#3a7bd5", cursor: "pointer" };

    function renderMountGlobalButton($btn, isOn) {
      $btn
        .text(isOn ? "取消挂载" : "挂载为全局世界书")
        .css(isOn ? MOUNT_GLOBAL_ON_STYLE : MOUNT_GLOBAL_OFF_STYLE);
    }

    const $mountGlobalBtn = $(`#${POPUP_ID}-mount-global`);
    renderMountGlobalButton($mountGlobalBtn, isMountedGlobally);
    $mountGlobalBtn.data("mounted", isMountedGlobally);

    $mountGlobalBtn.on("click", async () => {
      const context = getCtx();
      try {
        if ($mountGlobalBtn.data("mounted")) {
          // 取消挂载：只 toggle off 这一本，不做任何清理
          await context.executeSlashCommandsWithOptions(
            `/world silent=true state=off "${summaryLorebookName}"`,
          );
        } else {
          // 挂载：保留原有"检测其他全局书，问是否顺带清理"的逻辑
          await mountSummaryLorebookGlobally(summaryLorebookName);
        }
        const nowMounted =
          await isSummaryLorebookGloballyEnabled(summaryLorebookName);
        $mountGlobalBtn.data("mounted", nowMounted);
        renderMountGlobalButton($mountGlobalBtn, nowMounted);
        notify(
          "success",
          nowMounted
            ? `已挂载「${summaryLorebookName}」为全局世界书`
            : `已取消挂载「${summaryLorebookName}」`,
        );
      } catch (error) {
        console.error("[剧情助手] 切换全局世界书挂载状态时出错:", error);
        notify("error", `切换全局世界书挂载状态时出错: ${error.message}`);
      }
    });
    $mountGlobalBtn.data("mounted", isMountedGlobally);

    // 世界书条目交互（展开/收起）
    $(document).on("click", ".lorebook-entry .entry-header", function () {
      const $content = $(this)
        .closest(".lorebook-entry")
        .find(".entry-content");
      const $toggle = $(this).find(".entry-toggle");

      if ($content.is(":visible")) {
        $content.hide();
        $toggle.text("▼");
      } else {
        $content.show();
        $toggle.text("▲");
      }
    });

    // 保存按钮事件
    $(document).on("click", ".entry-save", async function (e) {
      e.stopPropagation();
      const uid = $(this).data("uid");
      const $entry = $(this).closest(".lorebook-entry");
      const $textarea = $entry.find(".entry-textarea");
      const $title = $entry.find(".entry-header div:first");
      const titleText = $title.text();
      const updatedContent = $textarea.val();

      try {
        const context = getCtx();
        const lorebookName = await getOrCreateSummaryLorebook();
        const numericUid = parseInt(uid, 10);
        if (isNaN(numericUid)) throw new Error(`无效的条目ID: ${uid}`);

        const data = await context.loadWorldInfo(lorebookName);
        if (!data || !data.entries || !(numericUid in data.entries)) {
          throw new Error("世界书条目不存在，可能已被删除。");
        }
        data.entries[numericUid].content = updatedContent;
        await context.saveWorldInfo(lorebookName, data, true);
        notifyWorldInfoUpdated(lorebookName);

        notify("success", `已保存世界书条目: ${titleText}`);

        setTimeout(async () => {
          try {
            const $loreBookSection = $(`#${SUMMARY_POPUP_ID}-lorebook`);
            if ($loreBookSection.length > 0) {
              const updatedEntriesHTML =
                await getLorebookEntriesSummaryHtml(lorebookName);
              $loreBookSection.html(updatedEntriesHTML);
            }
          } catch (refreshError) {
            console.warn("[剧情助手] 刷新世界书显示时出错:", refreshError);
          }
        }, 500);
      } catch (error) {
        console.error("[剧情助手] 保存世界书条目时出错:", error);
        notify("error", `保存世界书条目时出错: ${error.message}`);
      }
    });

    // 删除按钮事件
    $(document).on("click", ".entry-delete", async function (e) {
      e.stopPropagation();
      const uid = $(this).data("uid");
      const $entry = $(this).closest(".lorebook-entry");
      const title = $entry.find(".entry-header div:first").text();

      const context = getCtx();
      const confirmed = await context.callGenericPopup(
        `确定要删除世界书条目 <b>${title}</b> 吗？`,
        context.POPUP_TYPE.CONFIRM,
        "",
        { okButton: "删除", cancelButton: "取消" },
      );
      if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) {
        console.log("[剧情助手] 用户取消删除条目:", title);
        return;
      }

      try {
        const lorebookName = await getOrCreateSummaryLorebook();
        const numericUid = parseInt(uid, 10);
        if (isNaN(numericUid)) throw new Error(`无效的条目ID: ${uid}`);

        const data = await context.loadWorldInfo(lorebookName);
        if (data && data.entries && numericUid in data.entries) {
          delete data.entries[numericUid];
          await context.saveWorldInfo(lorebookName, data, true);
          notifyWorldInfoUpdated(lorebookName);
        }

        $entry.fadeOut(300, function () {
          $(this).remove();
        });

        notify("success", `已删除世界书条目: ${title}`);
      } catch (error) {
        console.error("[剧情助手] 删除世界书条目时出错:", error);
        notify("error", `删除世界书条目时出错: ${error.message}`);
      }
    });
  } catch (error) {
    console.error("[剧情助手] 错误提醒:", error);
    notify("error", `错误提醒: ${error.message}`);
  }
}

// === Function: 进入角色卡/切换聊天时，主动确保总结世界书和状态表条目存在（不再等到第一次状态表合并才创建）===
// 世界书绑定提醒不再只弹一次，而是和初始化提示一样，每次运行到这里都会提醒一遍，避免用户漏看/忘记绑定。
async function ensureSummaryLorebookOnLoad() {
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
function registerLorebookAutoCreate() {
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
function registerStatusTableAutoUpdate() {
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

// #####################################################################################
// === 手机（通讯器）悬浮窗模块 ===
// 全局开关，控制右下角「通讯器」悬浮球是否显示，默认关闭。
// 点开后弹出手机界面：通讯录 / 聊天 / 动态 / 设置 四个页签（动态页暂未实现，占位）。
// 数据来源：
//   - 联系人：读取当前"角色名总结"世界书里所有「角色卡：」前缀的条目（复用"创建角色"功能写入的数据）。
//   - 私信正文：本地 IndexedDB（PHONE_IDB_NAME），按"角色名::日期"存储，不占世界书 token。
//   - 忙/闲判定缓存 + 待注入私信槽位标记：本地存储（PHONE_CHAT_META_KEY），跟随"角色卡+对话文件"走。
// 忙/闲判定：纯文本匹配——角色名（含去姓简称）是否出现在最后一层 AI 楼层正文里；
//   出现 → 判定"忙"，把角色写进本地缓存的 busy 表，由状态表序列化时拼出 Busy 字段供正文 AI 感知，
//     正文 AI 在该角色本轮不再出现时输出 Busy: 角色名: [REMOVE]，插件在下一次状态表重算时读到这个信号，
//     自动生成一条该角色的补发私信；
//   不出现 → 判定"闲"，立即调用 AI 生成一条回复，并记住当前最后一层楼层号，
//     只要楼层号没变，下次发消息直接沿用"闲"的判断，不重新做文本匹配。
// 私信槽位：今天只要有新的私信更新（用户发送或角色回复），下一次正文生成前临时通过
//   context.setExtensionPrompt() 把当天聊天记录注入正文，AI 生成完这一轮后立即清空（一次性注入，不常驻）。
//   ⚠️ setExtensionPrompt 的具体参数/位置枚举没有在本项目其它地方实测过，接入后请在实际酒馆环境验证一遍，
//   如果没生效或控制台报错，把日志发我再调整（这一点和 README 里"已知需要你在实际环境验证的点"性质一致）。
// #####################################################################################

const PHONE_MODULE_NAME = "plot_assistant_phone";

// extension_settings[PHONE_MODULE_NAME] 顶层结构：{ fabVisible: boolean }
function getPhoneExtRoot() {
  if (!extension_settings[PHONE_MODULE_NAME]) {
    extension_settings[PHONE_MODULE_NAME] = {};
  }
  const root = extension_settings[PHONE_MODULE_NAME];
  if (typeof root.fabVisible !== "boolean") root.fabVisible = false;
  return root;
}

// 读取通讯器悬浮球是否应该显示（默认 false）
function getPhoneFabVisible() {
  return getPhoneExtRoot().fabVisible === true;
}

// 写入通讯器悬浮球显示开关并立即持久化
function setPhoneFabVisibleSetting(visible) {
  getPhoneExtRoot().fabVisible = !!visible;
  saveSettingsDebounced();
}

// ==== 手机私信系统：本地对话缓存存取（忙/闲缓存 + 待注入私信槽位标记）====

// 读取"当前对话"的手机私信状态记录，不存在则就地初始化一份默认结构并返回（引用，改了要记得调用 persistChatMetadata）。
// 结构：{ busy: {角色名: true}, idleFloor: {角色名: 楼层号}, pendingInjection: {角色名: true/false} }
function getPhoneChatState() {
  const store = getChatMetadataStore();
  if (
    !store[PHONE_CHAT_META_KEY] ||
    typeof store[PHONE_CHAT_META_KEY] !== "object"
  ) {
    store[PHONE_CHAT_META_KEY] = {
      busy: {},
      idleFloor: {},
      pendingInjection: {},
    };
  }
  const s = store[PHONE_CHAT_META_KEY];
  if (!s.busy || typeof s.busy !== "object") s.busy = {};
  if (!s.idleFloor || typeof s.idleFloor !== "object") s.idleFloor = {};
  if (!s.pendingInjection || typeof s.pendingInjection !== "object")
    s.pendingInjection = {};
  return s;
}

// 标记"今天有新私信更新"，下一次正文生成前会把当天聊天记录注入私信槽位；调用方需要自己 persistChatMetadata。
function markPhoneUpdatedToday(characterName) {
  getPhoneChatState().pendingInjection[characterName] = true;
}

// === Helper: 角色名（含去姓简称，复用"创建角色"功能已有的 extractCharacterKeywords）是否出现在给定文本里 ===
function characterActiveInText(characterName, text) {
  if (!text) return false;
  return extractCharacterKeywords(characterName).some(
    (kw) => kw && text.includes(kw),
  );
}

// === Helper: 取"最后一层 AI 楼层"的索引与正文，找不到返回 idx=-1 ===
function getLastAiFloor() {
  const chat = getCtx().chat;
  if (!Array.isArray(chat)) return { idx: -1, mes: "" };
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i] && !chat[i].is_user) return { idx: i, mes: chat[i].mes || "" };
  }
  return { idx: -1, mes: "" };
}

// === Helper: 取"正文当前时间"——即最后一层AI楼层摘要模块里的 Time 字段，取不到返回空字符串。
// 供手机私信系统在创建每条消息时记录"这条消息是正文走到哪个时间点时发的"，不是现实时间。===
function getCurrentStoryTime() {
  const { mes } = getLastAiFloor();
  const fields = parseFloorSummaryFields(mes);
  return (fields && fields.time) || "";
}

// ==== 手机私信系统：联系人（复用"创建角色"写入的「角色卡：」世界书条目）====

// 从角色卡条目正文里取出 <character_information character="..."> 标签内的内容；取不到就退回整段正文。
function extractCharacterInfoBody(content) {
  const match =
    /<character_information[^>]*>([\s\S]*?)<\/character_information>/.exec(
      content || "",
    );
  return (match ? match[1] : content || "").trim();
}

// === Helper: 取"标签: 值"里值部分一直到文本末尾的多行内容（用于 other 这种允许多行的字段）。
// extractLabelLine 只取标签所在那一行，取不到多行内容，这里单独按"从标签行到末尾"整体截取。===
function extractMultilineLabelField(text, label) {
  if (!text || typeof text !== "string") return "";
  const re = new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*([\\s\\S]*)$`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

// === Helper: 从角色卡正文里解析固定的 gender/other 两个字段（配合"添加联系人"面板固定输入项）。
// gender 是单行值，other 允许多行、取到标签所在行之后的所有内容。取不到就是空字符串，不报错。===
function parseContactExtra(extraText) {
  return {
    gender: extractLabelLine(extraText, "gender"),
    other: extractMultilineLabelField(extraText, "other"),
  };
}

// 返回联系人列表：[{ name, extra }]，按名字排序。读不到世界书/没有任何角色卡时返回空数组，不报错。
async function getPhoneContactsList() {
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const entries = await getLorebookEntriesArray(lorebookName);
    return entries
      .filter(
        (e) =>
          typeof e.comment === "string" &&
          e.comment.startsWith(CHARACTER_ENTRY_TITLE_PREFIX),
      )
      .map((e) => ({
        name: e.comment.slice(CHARACTER_ENTRY_TITLE_PREFIX.length),
        extra: extractCharacterInfoBody(e.content),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  } catch (error) {
    console.error("[剧情助手] 读取联系人列表失败:", error);
    return [];
  }
}

// 读取单个联系人角色卡正文（供生成回复时拼系统提示词用），读不到返回空字符串。
async function getPhoneContactCardBody(characterName) {
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const entries = await getLorebookEntriesArray(lorebookName);
    const entry = entries.find(
      (e) => e.comment === CHARACTER_ENTRY_TITLE_PREFIX + characterName,
    );
    return entry ? extractCharacterInfoBody(entry.content) : "";
  } catch (error) {
    console.error("[剧情助手] 读取联系人角色卡失败:", error);
    return "";
  }
}

// === Helper: 读取"私信预设"条目，取不到时返回默认内容（不写入世界书，仅供编辑框预填）。===
async function loadPhonePresetContent() {
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const entries = await getLorebookEntriesArray(lorebookName);
    const existing = entries.find((e) => e.comment === PHONE_PRESET_TITLE);
    return existing &&
      typeof existing.content === "string" &&
      existing.content.trim()
      ? existing.content
      : DEFAULT_PHONE_PRESET_CONTENT;
  } catch (error) {
    console.error("[剧情助手] 读取私信预设失败:", error);
    return DEFAULT_PHONE_PRESET_CONTENT;
  }
}

// === Helper: 保存/新建"私信预设"条目。始终 disable:true、非常驻关键词触发——
// 这条条目不参与酒馆正文的世界书注入，只是插件生成私信回复时直接读取内容拼提示词用。===
async function savePhonePresetContent(content) {
  const context = getCtx();
  const lorebookName = await getOrCreateSummaryLorebook();
  const data = await context.loadWorldInfo(lorebookName);
  if (!data || !data.entries)
    throw new Error(`无法加载世界书: ${lorebookName}`);

  const existing = Object.values(data.entries).find(
    (entry) => entry.comment === PHONE_PRESET_TITLE,
  );

  if (existing) {
    data.entries[existing.uid].content = content;
    data.entries[existing.uid].disable = true;
  } else {
    const newUid = getFreeUid(data);
    if (newUid === null) throw new Error("无法为新世界书条目分配 uid。");
    data.entries[newUid] = {
      uid: newUid,
      comment: PHONE_PRESET_TITLE,
      content,
      disable: true,
      constant: false,
      key: [],
      position: 0,
      useGroupScoring: false,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 0,
      ...CHARACTER_ENTRY_DEFAULTS,
    };
  }

  await context.saveWorldInfo(lorebookName, data, true);
  notifyWorldInfoUpdated(lorebookName);
  return lorebookName;
}

// === Function: 打开"私信预设"编辑框（纯文本，取消/保存，样式对齐"对话前强调"弹窗）===
async function openPhonePresetDialog() {
  const currentContent = await loadPhonePresetContent();

  const $bodyEl = $("body");
  const prevBodyOverflow = $bodyEl.css("overflow");
  $bodyEl.css("overflow", "hidden");

  const result = await new Promise((resolve) => {
    const $overlay = $("<div>").css({
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: "rgba(0,0,0,0.72)",
      zIndex: 99999,
      boxSizing: "border-box",
    });

    const $box = $("<div>").css({
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#252525",
      border: "1px solid #3a3a3a",
      borderRadius: "10px",
      padding: "clamp(16px, 4vw, 24px)",
      width: "min(480px, calc(100% - 24px))",
      maxHeight: "min(85vh, calc(100dvh - 24px))",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      color: "#e8e8e8",
      fontFamily: "inherit",
      boxSizing: "border-box",
      boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
    });

    const $title = $("<div>").text(PHONE_PRESET_TITLE).css({
      fontSize: "1.05em",
      fontWeight: "600",
      color: "#f0f0f0",
      letterSpacing: "0.01em",
    });

    const $hint = $("<div>")
      .text(
        '手机私信生成回复时的开场白/扮演指令，"联系人"会自动替换成实际联系人姓名。',
      )
      .css({ fontSize: "0.8em", color: "#999", lineHeight: 1.5 });

    const $textarea = $("<textarea>").val(currentContent).css({
      width: "100%",
      boxSizing: "border-box",
      minHeight: "140px",
      padding: "10px",
      borderRadius: "6px",
      border: "1px solid #3a3a3a",
      background: "#1a1a1a",
      color: "#d0d0d0",
      fontSize: "max(0.95em, 16px)",
      fontFamily: "inherit",
      outline: "none",
      resize: "vertical",
    });

    const $btnRow = $("<div>").css({
      display: "flex",
      gap: "10px",
      justifyContent: "flex-end",
      marginTop: "4px",
    });
    const btnCss = {
      padding: "10px 20px",
      borderRadius: "6px",
      minHeight: "44px",
      boxSizing: "border-box",
      cursor: "pointer",
      fontSize: "0.95em",
      touchAction: "manipulation",
    };
    const $cancel = $("<button>")
      .text("取消")
      .css({
        ...btnCss,
        border: "1px solid #3a3a3a",
        background: "transparent",
        color: "#c0c0c0",
      });
    const $confirm = $("<button>")
      .text("保存")
      .css({
        ...btnCss,
        border: "none",
        background: "#5b9cf6",
        color: "#ffffff",
        fontWeight: "600",
      });
    $btnRow.append($cancel, $confirm);

    $box.append($title, $hint, $textarea, $btnRow);
    $overlay.append($box);
    $("body").append($overlay);
    setTimeout(() => $textarea.trigger("focus"), 50);

    const done = (confirmed) => {
      $(document).off("keydown.phonePresetDialog");
      $overlay.remove();
      $bodyEl.css("overflow", prevBodyOverflow || "");
      resolve(confirmed ? $textarea.val() : null);
    };

    $confirm.on("click", () => done(true));
    $cancel.on("click", () => done(false));

    let overlayPointerDownOnSelf = false;
    $overlay.on("mousedown touchstart", (e) => {
      overlayPointerDownOnSelf = $(e.target).is($overlay);
    });
    $overlay.on("mouseup touchend", (e) => {
      if (overlayPointerDownOnSelf && $(e.target).is($overlay)) done(false);
      overlayPointerDownOnSelf = false;
    });
    $(document).on("keydown.phonePresetDialog", (e) => {
      if (e.key === "Escape") done(false);
    });
  });

  if (result === null) return;

  try {
    const lorebookName = await savePhonePresetContent(result);
    notify("success", `「${PHONE_PRESET_TITLE}」已保存到「${lorebookName}」`);
  } catch (error) {
    console.error("[剧情助手] 保存私信预设失败:", error);
    notify("error", `保存私信预设失败：${error.message || error}`);
  }
}

// === Helper: 从状态表世界书条目的 Relationships 行里，摘出 {{user}} 与指定角色之间的关系阶段值。
// 取不到（没有状态表/该角色不在关系表里）返回空字符串，不报错。===
async function getRelationshipStageForCharacter(characterName) {
  try {
    const lorebookName = await getOrCreateSummaryLorebook();
    const entries = await getLorebookEntriesArray(lorebookName);
    const statusEntry = entries.find((e) => e.comment === STATUS_TABLE_TITLE);
    if (!statusEntry) return "";
    const relationshipsLine = extractLabelLine(
      statusEntry.content,
      "Relationships",
    );
    if (!relationshipsLine) return "";
    const { map } = parseKeyValueListWithSkipped(relationshipsLine);
    for (const [key, value] of map.entries()) {
      if (extractOtherPartyName(key) === characterName) return value;
    }
    return "";
  } catch (error) {
    console.error("[剧情助手] 读取关系阶段失败:", error);
    return "";
  }
}

// ==== 手机私信系统：本地 IndexedDB（按"角色名::日期"存储，独立于地图图片库）====

function openPhoneDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHONE_IDB_NAME, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHONE_IDB_STORE)) {
        db.createObjectStore(PHONE_IDB_STORE);
      }
      if (!db.objectStoreNames.contains(PHONE_AVATAR_STORE)) {
        db.createObjectStore(PHONE_AVATAR_STORE);
      }
      if (!db.objectStoreNames.contains(PHONE_STICKER_STORE)) {
        db.createObjectStore(PHONE_STICKER_STORE);
      }
      if (!db.objectStoreNames.contains(PHONE_BACKGROUND_STORE)) {
        db.createObjectStore(PHONE_BACKGROUND_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 把图片文件读成压缩后的 dataURL：等比缩放到 maxSize 以内、输出 JPEG，用于头像/图片库这类
// 不需要保留原图精度、但要控制 IndexedDB 体积的场景（跟小地图底图保留原图精度的诉求不同，不复用那套）。
function readImageFileCompressed(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          const scale = maxSize / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ==== 手机：通用图片裁剪弹窗（头像 / 全局背景 / 聊天页背景共用一套交互）====
// 用法：openImageCropDialog({ file, title, ratio, shape, outputWidth, outputHeight })
//   file: 用户选中的图片文件
//   ratio: 裁剪框宽高比（宽/高），shape: "circle"（头像用圆形遮罩预览） | "rect"
//   outputWidth/outputHeight: 最终导出画布像素尺寸
// 返回 Promise<string|null>：确定则 resolve 裁剪后的 JPEG dataURL，取消则 resolve null。
// 交互：单指/鼠标拖拽平移，滚轮或双指捏合缩放，另附一个缩放滑杆方便精细调节。
function openImageCropDialog({
  file,
  title = "裁剪图片",
  ratio = 1,
  shape = "rect",
  outputWidth = 320,
  outputHeight = 320,
  quality = 0.85,
}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.onload = () => {
        try {
          mountCropDialog(img);
        } catch (error) {
          reject(error);
        }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);

    function mountCropDialog(img) {
      document.getElementById("pa-crop-dialog")?.remove();

      // 裁剪框尺寸：按目标比例，在弹窗可用空间内尽量大，但不超出屏幕。
      let viewportW = Math.min(300, window.innerWidth * 0.82);
      let viewportH = viewportW / ratio;
      const maxViewportH = window.innerHeight * 0.56;
      if (viewportH > maxViewportH) {
        viewportH = maxViewportH;
        viewportW = viewportH * ratio;
      }

      const html = `
        <dialog id="pa-crop-dialog">
          <div id="pa-crop-panel">
            <div id="pa-crop-title">${escapePhoneHtml(title)}</div>
            <div id="pa-crop-viewport" class="${shape === "circle" ? "pa-crop-viewport-circle" : ""}" style="width:${viewportW}px;height:${viewportH}px;">
              <img id="pa-crop-img" draggable="false" alt="" />
            </div>
            <div id="pa-crop-zoom-row">
              <span id="pa-crop-zoom-icon-min">－</span>
              <input type="range" id="pa-crop-zoom" min="100" max="300" value="100" />
              <span id="pa-crop-zoom-icon-max">＋</span>
            </div>
            <div id="pa-crop-actions">
              <button id="pa-crop-cancel">取消</button>
              <button id="pa-crop-confirm">确定</button>
            </div>
          </div>
        </dialog>`;
      document.body.insertAdjacentHTML("beforeend", html);

      const dialog = document.getElementById("pa-crop-dialog");
      const viewport = document.getElementById("pa-crop-viewport");
      const imgEl = document.getElementById("pa-crop-img");
      const zoomInput = document.getElementById("pa-crop-zoom");

      const natW = img.naturalWidth;
      const natH = img.naturalHeight;
      const coverScale = Math.max(viewportW / natW, viewportH / natH);
      let scale = coverScale;
      let left = (viewportW - natW * scale) / 2;
      let top = (viewportH - natH * scale) / 2;

      imgEl.src = img.src;

      function clamp(v, min, max) {
        return Math.min(max, Math.max(min, v));
      }

      function applyTransform() {
        const dispW = natW * scale;
        const dispH = natH * scale;
        left = dispW <= viewportW ? (viewportW - dispW) / 2 : clamp(left, viewportW - dispW, 0);
        top = dispH <= viewportH ? (viewportH - dispH) / 2 : clamp(top, viewportH - dispH, 0);
        imgEl.style.width = `${dispW}px`;
        imgEl.style.height = `${dispH}px`;
        imgEl.style.left = `${left}px`;
        imgEl.style.top = `${top}px`;
      }
      applyTransform();

      function setZoomVal(val) {
        const clamped = clamp(Math.round(val), 100, 300);
        zoomInput.value = clamped;
        scale = coverScale * (clamped / 100);
        applyTransform();
      }

      // 单指/鼠标拖拽平移
      let dragging = false;
      let dragStartX = 0,
        dragStartY = 0,
        dragStartLeft = 0,
        dragStartTop = 0;
      // 双指捏合缩放
      const activePointers = new Map();
      let pinchStartDist = 0;
      let pinchStartZoom = 100;

      viewport.addEventListener("pointerdown", (e) => {
        viewport.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (activePointers.size === 1) {
          dragging = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          dragStartLeft = left;
          dragStartTop = top;
        } else if (activePointers.size === 2) {
          dragging = false;
          const pts = [...activePointers.values()];
          pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          pinchStartZoom = Number(zoomInput.value);
        }
      });
      viewport.addEventListener("pointermove", (e) => {
        if (!activePointers.has(e.pointerId)) return;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (activePointers.size === 2) {
          const pts = [...activePointers.values()];
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          if (pinchStartDist > 0) {
            setZoomVal(pinchStartZoom * (dist / pinchStartDist));
          }
        } else if (dragging) {
          left = dragStartLeft + (e.clientX - dragStartX);
          top = dragStartTop + (e.clientY - dragStartY);
          applyTransform();
        }
      });
      const endPointer = (e) => {
        activePointers.delete(e.pointerId);
        if (activePointers.size === 1) {
          const [pt] = [...activePointers.values()];
          dragging = true;
          dragStartX = pt.x;
          dragStartY = pt.y;
          dragStartLeft = left;
          dragStartTop = top;
        } else {
          dragging = false;
        }
      };
      viewport.addEventListener("pointerup", endPointer);
      viewport.addEventListener("pointercancel", endPointer);
      viewport.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          setZoomVal(Number(zoomInput.value) + (e.deltaY < 0 ? 8 : -8));
        },
        { passive: false },
      );
      zoomInput.addEventListener("input", () => setZoomVal(Number(zoomInput.value)));

      function cleanup(result) {
        dialog.close();
        dialog.remove();
        resolve(result);
      }

      document.getElementById("pa-crop-cancel").addEventListener("click", () => cleanup(null));
      document.getElementById("pa-crop-confirm").addEventListener(
        "click",
        errorCatched(() => {
          const srcX = -left / scale;
          const srcY = -top / scale;
          const srcW = viewportW / scale;
          const srcH = viewportH / scale;
          const canvas = document.createElement("canvas");
          canvas.width = outputWidth;
          canvas.height = outputHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outputWidth, outputHeight);
          cleanup(canvas.toDataURL("image/jpeg", quality));
        }),
      );
      dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        cleanup(null);
      });

      dialog.showModal();
    }
  });
}

// ==== 手机：头像库（按"当前角色卡::联系人名"存取）====

function phoneAvatarDbKey(characterName) {
  return `${getCurrentCharacterName()}::${characterName}`;
}

async function savePhoneAvatar(characterName, dataUrl) {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_AVATAR_STORE, "readwrite");
      tx.objectStore(PHONE_AVATAR_STORE).put(
        dataUrl,
        phoneAvatarDbKey(characterName),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 保存头像失败:", error);
    notify("error", "头像保存失败，请查看控制台报错。");
  }
}

// 一次性取当前角色卡下所有联系人的头像，返回 Map（联系人名 -> dataURL），供通讯录列表批量渲染用，
// 避免每个联系人单独发一次 IDB 请求。
async function getAllPhoneAvatarsForCurrentCharacter() {
  try {
    const db = await openPhoneDB();
    const prefix = phoneAvatarDbKey("");
    const { keys, values } = await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_AVATAR_STORE, "readonly");
      const store = tx.objectStore(PHONE_AVATAR_STORE);
      const keysReq = store.getAllKeys();
      const valuesReq = store.getAll();
      let keys, values;
      keysReq.onsuccess = () => {
        keys = keysReq.result;
        if (values !== undefined) resolve({ keys, values });
      };
      valuesReq.onsuccess = () => {
        values = valuesReq.result;
        if (keys !== undefined) resolve({ keys, values });
      };
      keysReq.onerror = () => reject(keysReq.error);
      valuesReq.onerror = () => reject(valuesReq.error);
    });
    const map = new Map();
    keys.forEach((key, i) => {
      if (typeof key === "string" && key.startsWith(prefix)) {
        map.set(key.slice(prefix.length), values[i]);
      }
    });
    return map;
  } catch (error) {
    console.error("[剧情助手] 批量读取头像失败:", error);
    return new Map();
  }
}

// ==== 手机：背景库 ====
// 全局背景：通讯录/动态/设置三页共用一张，存在固定 key 下，不分角色卡。
async function getPhoneGlobalBackground() {
  try {
    const db = await openPhoneDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readonly");
      const req = tx
        .objectStore(PHONE_BACKGROUND_STORE)
        .get(PHONE_GLOBAL_BACKGROUND_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error("[剧情助手] 读取全局背景失败:", error);
    return null;
  }
}

async function savePhoneGlobalBackground(dataUrl) {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readwrite");
      tx.objectStore(PHONE_BACKGROUND_STORE).put(
        dataUrl,
        PHONE_GLOBAL_BACKGROUND_KEY,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 保存全局背景失败:", error);
    notify("error", "背景保存失败，请查看控制台报错。");
  }
}

async function deletePhoneGlobalBackground() {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readwrite");
      tx.objectStore(PHONE_BACKGROUND_STORE).delete(PHONE_GLOBAL_BACKGROUND_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 清除全局背景失败:", error);
  }
}

// 聊天页背景：按"当前角色卡::联系人名"分别存，跟头像库同一套 key 规则，换角色卡/联系人互不影响。
function phoneChatBackgroundDbKey(characterName) {
  return `${getCurrentCharacterName()}::${characterName}`;
}

async function getPhoneChatBackground(characterName) {
  try {
    const db = await openPhoneDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readonly");
      const req = tx
        .objectStore(PHONE_BACKGROUND_STORE)
        .get(phoneChatBackgroundDbKey(characterName));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error("[剧情助手] 读取聊天页背景失败:", error);
    return null;
  }
}

async function savePhoneChatBackground(characterName, dataUrl) {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readwrite");
      tx.objectStore(PHONE_BACKGROUND_STORE).put(
        dataUrl,
        phoneChatBackgroundDbKey(characterName),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 保存聊天页背景失败:", error);
    notify("error", "背景保存失败，请查看控制台报错。");
  }
}

async function deletePhoneChatBackground(characterName) {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_BACKGROUND_STORE, "readwrite");
      tx.objectStore(PHONE_BACKGROUND_STORE).delete(
        phoneChatBackgroundDbKey(characterName),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 清除聊天页背景失败:", error);
  }
}

// 把背景 dataURL 套用到对应容器：传 null/空则清空自定义背景，露出下层默认样式。
// 全局背景套在 #pa-phone-modal 内专门的背景图层上（z-index 在内容之下）：
//   没设置自定义背景时，图层本身没有背景图，保持 style.css 里默认的 opacity: 0.9，
//   露出 #pa-phone-modal 的纯蓝底，还原原来的半透明蓝底效果；
//   一旦设置了自定义背景图，就把图层调成完全不透明（opacity: 1），彻底盖住下面的蓝底，
//   避免蓝色透过 10% 的透明度叠加到图片上，导致背景图发暗发闷。
// 聊天页背景只套在消息滚动区域 #pa-phone-chat-messages 上（即头部标题栏和输入栏这两条线之间），
// 因为要跟气泡文字保持足够对比度，这里保留一层浅色蒙层，本身就是不透明的，本来就不会漏出全局背景层。
function applyPhoneGlobalBackground(dataUrl) {
  const layer = document.getElementById("pa-phone-global-bg-layer");
  if (!layer) return;
  if (dataUrl) {
    layer.style.backgroundImage = `url("${dataUrl}")`;
    layer.style.opacity = "1";
  } else {
    layer.style.backgroundImage = "";
    layer.style.opacity = "";
  }
}

function applyPhoneChatBackground(dataUrl) {
  const el = document.getElementById("pa-phone-chat-messages");
  if (!el) return;
  if (dataUrl) {
    el.style.backgroundImage = `linear-gradient(rgba(0,20,90,0.35), rgba(0,20,90,0.35)), url("${dataUrl}")`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  } else {
    el.style.backgroundImage = "";
    el.style.backgroundSize = "";
    el.style.backgroundPosition = "";
  }
}

// ==== 手机：图片库（原"表情包"，全局公用一份，整份列表存在同一个 key 下）====

async function getPhoneStickerList() {
  try {
    const db = await openPhoneDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_STICKER_STORE, "readonly");
      const req = tx
        .objectStore(PHONE_STICKER_STORE)
        .get(PHONE_STICKER_LIST_KEY);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error("[剧情助手] 读取图片列表失败:", error);
    return [];
  }
}

async function savePhoneStickerList(list) {
  try {
    const db = await openPhoneDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_STICKER_STORE, "readwrite");
      tx.objectStore(PHONE_STICKER_STORE).put(list, PHONE_STICKER_LIST_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 保存图片列表失败:", error);
    notify("error", "图片保存失败，请查看控制台报错。");
  }
}

// items: [{ name, dataUrl }]，批量导入用。
async function addPhoneStickers(items) {
  const list = await getPhoneStickerList();
  items.forEach((item) => {
    list.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: item.name,
      dataUrl: item.dataUrl,
    });
  });
  await savePhoneStickerList(list);
  return list;
}

async function renamePhoneSticker(stickerId, newName) {
  const list = await getPhoneStickerList();
  const record = list.find((s) => s.id === stickerId);
  if (!record) return;
  record.name = newName;
  await savePhoneStickerList(list);
}

async function deletePhoneSticker(stickerId) {
  const list = (await getPhoneStickerList()).filter(
    (s) => s.id !== stickerId,
  );
  await savePhoneStickerList(list);
  return list;
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// === Helper: 把 storyTime（如"武定三年三月十五,申时"或"2023年8月28日 07:35"）拆成 {date, time} 两段，
// 供手机聊天界面显示用：日期部分给日期分割线，时辰/时间部分给单条消息的时间标签。
// 优先按逗号切（架空纪年常用格式）；没有逗号再按最后一个空格切（公历日期+时间常用格式）；
// 两种分隔符都没有就整段当 date、time 留空；storyTime 本身为空则两段都返回空字符串。===
function splitStoryTime(storyTime) {
  if (!storyTime) return { date: "", time: "" };
  const commaIdx = storyTime.indexOf(",");
  if (commaIdx !== -1) {
    return {
      date: storyTime.slice(0, commaIdx).trim(),
      time: storyTime.slice(commaIdx + 1).trim(),
    };
  }
  const spaceIdx = storyTime.lastIndexOf(" ");
  if (spaceIdx !== -1) {
    return {
      date: storyTime.slice(0, spaceIdx).trim(),
      time: storyTime.slice(spaceIdx + 1).trim(),
    };
  }
  return { date: storyTime, time: "" };
}

// 私信存储 key 先按"当前角色卡"分一层、再按联系人名/日期分，跟地图数据（角色名::原id）同思路，
// 避免不同角色卡下刚好有同名联系人时，私信记录互相串在一起。
function phoneDbMessagesKey(characterName, dateKey) {
  return `${getCurrentCharacterName()}::${characterName}::${dateKey}`;
}
function phoneDbDateIndexKey(characterName) {
  return `${getCurrentCharacterName()}::${characterName}::__dates__`;
}

// 读取某个联系人某一天的消息数组（[{id, from, text, ts}]，from 为 "user"/"character"/"system"），
// 没有记录时返回空数组，不抛错。
async function getPhoneMessagesForDate(characterName, dateKey) {
  try {
    const db = await openPhoneDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readonly");
      const req = tx
        .objectStore(PHONE_IDB_STORE)
        .get(phoneDbMessagesKey(characterName, dateKey));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error("[剧情助手] 读取私信记录失败:", error);
    return [];
  }
}

// 读取某个联系人"有消息的日期"索引（用于聊天页一次性拉全部历史），按字符串升序排列即时间顺序。
async function getPhoneDateIndex(characterName) {
  try {
    const db = await openPhoneDB();
    const list = await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readonly");
      const req = tx
        .objectStore(PHONE_IDB_STORE)
        .get(phoneDbDateIndexKey(characterName));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return [...list].sort();
  } catch (error) {
    console.error("[剧情助手] 读取私信日期索引失败:", error);
    return [];
  }
}

// 追加一条消息（自动按 ts 归入对应日期、更新日期索引），返回写入后的消息对象；写入失败返回 null。
async function appendPhoneMessage(characterName, msg) {
  const ts = msg.ts || Date.now();
  const dateKey = formatDateKey(new Date(ts));
  const record = {
    id: `${ts}_${Math.random().toString(36).slice(2, 8)}`,
    from: msg.from,
    text: msg.text,
    stickerId: msg.stickerId || null, // 关联图片库图片，仅发图片的消息才有值；旧数据没有此字段，读到的是 undefined -> 按无图片处理
    ts,
    storyTime: msg.storyTime || "", // 这条消息发出时，正文摘要模块里的 Time 字段值；旧数据没有此字段，读到的是 undefined -> ""
  };
  try {
    const db = await openPhoneDB();
    const list = await getPhoneMessagesForDate(characterName, dateKey);
    list.push(record);
    const dateIndex = await getPhoneDateIndex(characterName);
    if (!dateIndex.includes(dateKey)) dateIndex.push(dateKey);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readwrite");
      tx.objectStore(PHONE_IDB_STORE).put(
        list,
        phoneDbMessagesKey(characterName, dateKey),
      );
      tx.objectStore(PHONE_IDB_STORE).put(
        dateIndex,
        phoneDbDateIndexKey(characterName),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return record;
  } catch (error) {
    console.error("[剧情助手] 保存私信记录失败:", error);
    notify("error", "私信保存失败，请查看控制台报错。");
    return null;
  }
}

// 按日期分组返回某联系人的全部聊天记录：[{ dateKey, msgs }]，按时间升序。
async function getAllPhoneMessages(characterName) {
  const dateIndex = await getPhoneDateIndex(characterName);
  const result = [];
  for (const dateKey of dateIndex) {
    const msgs = await getPhoneMessagesForDate(characterName, dateKey);
    if (msgs.length > 0) result.push({ dateKey, msgs });
  }
  return result;
}

// 清空某联系人的全部本地私信记录（供设置页"清空聊天记录"用），不影响其他联系人。
async function clearPhoneMessages(characterName) {
  try {
    const db = await openPhoneDB();
    const dateIndex = await getPhoneDateIndex(characterName);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readwrite");
      const store = tx.objectStore(PHONE_IDB_STORE);
      dateIndex.forEach((dateKey) =>
        store.delete(phoneDbMessagesKey(characterName, dateKey)),
      );
      store.delete(phoneDbDateIndexKey(characterName));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 清空私信记录失败:", error);
    notify("error", "清空私信记录失败，请查看控制台报错。");
  }
}

// === Helper: 消息 id 是 appendPhoneMessage 里按 `${ts}_${随机串}` 生成的，随机串来自
// Math.random().toString(36) 不含下划线，所以按第一个 "_" 切开取前半段就是 ts，
// 反推出它当初落库用的 dateKey（跟 appendPhoneMessage 存的时候算法一致），不用额外记录。===
function dateKeyFromMessageId(messageId) {
  const ts = Number(String(messageId).split("_")[0]);
  return formatDateKey(new Date(ts));
}

// 修改某联系人某条私信的文本内容（编辑功能用）；找不到这条消息时静默返回，不报错。
async function updatePhoneMessageText(characterName, messageId, newText) {
  try {
    const db = await openPhoneDB();
    const dateKey = dateKeyFromMessageId(messageId);
    const list = await getPhoneMessagesForDate(characterName, dateKey);
    const record = list.find((m) => m.id === messageId);
    if (!record) return;
    record.text = newText;
    record.stickerId = null; // 手动编辑过文字后退化成普通文字消息，不再关联图片
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readwrite");
      tx.objectStore(PHONE_IDB_STORE).put(
        list,
        phoneDbMessagesKey(characterName, dateKey),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 修改私信内容失败:", error);
    notify("error", "修改私信内容失败，请查看控制台报错。");
  }
}

// 删除某联系人的一条私信（删除功能用）；分桶删空后顺手把这个 dateKey 从日期索引里摘掉，保持数据干净。
async function deletePhoneMessage(characterName, messageId) {
  try {
    const db = await openPhoneDB();
    const dateKey = dateKeyFromMessageId(messageId);
    const list = (await getPhoneMessagesForDate(characterName, dateKey)).filter(
      (m) => m.id !== messageId,
    );
    const dateIndex = await getPhoneDateIndex(characterName);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHONE_IDB_STORE, "readwrite");
      const store = tx.objectStore(PHONE_IDB_STORE);
      if (list.length > 0) {
        store.put(list, phoneDbMessagesKey(characterName, dateKey));
      } else {
        store.delete(phoneDbMessagesKey(characterName, dateKey));
        const nextIndex = dateIndex.filter((d) => d !== dateKey);
        store.put(nextIndex, phoneDbDateIndexKey(characterName));
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error("[剧情助手] 删除私信失败:", error);
    notify("error", "删除私信失败，请查看控制台报错。");
  }
}

// ==== 手机私信系统：调用 AI 生成角色回复 ====

// === Helper: 把某联系人的全部历史私信拼成 <private_letter> 标签内的正文。
// 连续消息的 storyTime 相同就归在同一个"时间：xxx"块下，storyTime 变化（含从空变有）时另起一行时间标注；
// 关系阶段统一取"当前实时值"（没有逐条历史快照，只能反映现在的关系状态，不代表发那条消息时的历史关系）。===
async function buildPrivateLetterBody(characterName) {
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
async function generateCharacterPhoneReply(
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
async function judgeCharacterHasTimeForPhone(characterName, lastAiMes) {
  const cardBody = await getPhoneContactCardBody(characterName);
  const relationshipStage =
    await getRelationshipStageForCharacter(characterName);
  const systemPrompt = [
    `你负责判断角色"${characterName}"此刻是否有空看手机、回复{{user}}的私信。`,
    cardBody ? `人设参考：\n${cardBody}` : "",
    relationshipStage
      ? `{{user}}与该角色当前关系阶段：${relationshipStage}`
      : "",
    `<Latest_plot>\n${lastAiMes || "（暂无正文）"}\n</Latest_plot>`,
    "只根据以上正文里这个角色当前正在做的事、所处场合，判断ta此刻方不方便看手机/回私信。" +
      "只输出一个字：方便就输出「是」，不方便就输出「否」，不要输出任何其它内容。",
  ]
    .filter(Boolean)
    .join("\n\n");
  const userContent = `请判断"${characterName}"现在有没有空回私信，只回答"是"或"否"。`;

  try {
    const raw = (await generateSummaryRaw(systemPrompt, userContent)) || "";
    const trimmed = raw.trim();
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
async function sendPhoneMessageToCharacter(characterName, payload) {
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
async function handleCharacterBecameFree(characterName) {
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
async function buildPhoneSlotContent() {
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
let lastInjectedPhoneNames = [];

async function applyPhoneSlotPrompt() {
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

function clearPhoneSlotPromptAfterRound() {
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

// 注册"生成前注入 / 生成后清空"监听。GENERATION_STARTED 在部分酒馆版本里可能不存在，
// 找不到时只打印警告、不阻断其它功能——这一点需要你在实际环境验证一下具体的事件名是否可用。
function registerPhoneSlotInjection() {
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

// #####################################################################################
// === 地图标记模块（见文件末尾初始化处的调用）===
// #####################################################################################

const MAP_MODULE_NAME = "map_marker";

// Leaflet 资源改为本地打包，路径基于当前模块自身的 URL 拼出，
// 不写死安装目录，无论装在默认扩展目录还是 third-party 目录下都能找到。
const MODULE_BASE = new URL(".", import.meta.url).href;
const LEAFLET_CSS = `${MODULE_BASE}lib/leaflet/leaflet.css`;
const LEAFLET_JS = `${MODULE_BASE}lib/leaflet/leaflet.js`;

// 大地图的固定 id（同时也是它在 IndexedDB 里的图片 key）
const BIG_MAP_ID = "big";

const DEFAULT_FACTIONS = [
  { name: "大宋", color: "#3b82f6" },
  { name: "倭寇", color: "#ef4444" },
];

// 8 方位罗盘文字，index = round(bearing/45) % 8，bearing 以正北为 0，顺时针增大
const COMPASS_NAMES = [
  "正北方",
  "东北方",
  "正东方",
  "东南方",
  "正南方",
  "西南方",
  "正西方",
  "西北方",
];

const SMALL_MAP_NOTE_PLACEHOLDER =
  "布局关系：\n" +
  "- 大门朝南，进门是照壁；\n" +
  "- 穿过照壁是前院，前院正对正房；\n" +
  "- 正房东侧隔一个天井是东厢房；\n" +
  "- 从大门到正房，会依次经过：照壁 → 前院 → 正房。\n\n" +
  "特别说明：\n" +
  "- 东厢房和正房之间的天井可以互相看到对方院子的情况。";

// ---- 默认设置结构 ----
function makeBigMap() {
  return {
    markers: [], // { id, x, y, name, faction, description }
    routes: [], // { id, fromId, toId, bearing, distance, party, departTime, arriveTime }
    imageWidth: 2000,
    imageHeight: 1200,
    customSummary: "", // 用户可编辑的上下文说明，非空时替代自动拼接的标记/路线文本
  };
}

const BIG_MAP_SUMMARY_PLACEHOLDER =
  "控图寨(大宋)：易守难攻的边境据点，扼守入山要道。\n" +
  "黑风口(倭寇)：倭寇偷渡登陆的隐蔽渡口。\n" +
  "海角滩(倭寇)：倭寇船队的秘密停泊点。\n\n" +
  "大宋行动——控图寨→黑风口。黑风口位于控图寨东南方约三百里，先锋营辰时出发，预计两日后申时到达黑风口。\n" +
  "倭寇行动——海角滩→控图寨。控图寨位于海角滩西北方约一百五十里，先遣队五更出发，预计次日午时到达控图寨。";

function makeSmallMap(overrides) {
  return Object.assign(
    {
      id: `map_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: "未命名地图",
      layoutNote: "", // 用户手写的"布局关系/特别说明"
      loadedInContext: true, // 是否加载进本次对话的 AI 上下文
      markers: [], // 小地图没有路线/移动路径概念，只有标记点
      imageWidth: 2000,
      imageHeight: 1200,
    },
    overrides || {},
  );
}

// ---- 单个角色的地图数据结构（不再有 boundCharAvatar，改为按角色名自动区分）----
function makeCharacterMapData() {
  return {
    activeMapId: BIG_MAP_ID, // 当前正在编辑/查看的地图："big" 或某张小地图的 id
    factions: JSON.parse(JSON.stringify(DEFAULT_FACTIONS)),
    maps: {
      big: makeBigMap(),
      small: [],
    },
  };
}

// extension_settings[MAP_MODULE_NAME] 顶层结构：{ byCharacter: { 角色名: 单角色数据 }, fabVisible: boolean }
// fabVisible 是全局开关（不分角色、不分设备），控制地图悬浮球是否显示，默认开启。
function getMapExtRoot() {
  if (!extension_settings[MAP_MODULE_NAME]) {
    extension_settings[MAP_MODULE_NAME] = { byCharacter: {} };
  }
  const root = extension_settings[MAP_MODULE_NAME];
  if (!root.byCharacter) root.byCharacter = {};
  if (typeof root.fabVisible !== "boolean") root.fabVisible = true;
  return root;
}

// 读取悬浮球是否应该显示（默认 true）
function getFabVisible() {
  return getMapExtRoot().fabVisible !== false;
}

// 写入悬浮球显示开关并立即持久化
function setFabVisibleSetting(visible) {
  getMapExtRoot().fabVisible = !!visible;
  saveSettingsDebounced();
}

// 群聊 / 未选中角色卡时，地图数据只临时存在这个内存变量里，不写入 extension_settings，
// 刷新页面或切换到别的角色卡就会丢失（符合"不会同步进任何世界书"的预期）。
let mmTransientMapData = null;

// 当前地图数据对应的角色名；群聊或未选中角色卡时返回 null（不是抛错，方便各处直接判空）
function getMapCurrentCharacterName() {
  try {
    const context = getCtx();
    if (context.groupId) return null; // 不支持群聊
    const charId = context.characterId;
    if (charId === undefined || charId === null) return null;
    const char = context.characters?.[charId];
    if (!char || !char.name) return null;
    return char.name;
  } catch (e) {
    return null;
  }
}

// 取当前角色对应的地图数据（自动创建默认结构），群聊/未选中角色卡时退回内存临时数据
function getSettings() {
  const name = getMapCurrentCharacterName();
  if (!name) {
    if (!mmTransientMapData) mmTransientMapData = makeCharacterMapData();
    return mmTransientMapData;
  }
  const root = getMapExtRoot();
  if (!root.byCharacter[name]) root.byCharacter[name] = makeCharacterMapData();
  return root.byCharacter[name];
}

function saveSettings() {
  saveSettingsDebounced();
}

// ---- 当前正在编辑/查看的地图 ----
function isBigMapActive() {
  return getSettings().activeMapId === BIG_MAP_ID;
}

function getActiveMap() {
  const settings = getSettings();
  if (settings.activeMapId === BIG_MAP_ID) return settings.maps.big;
  const found = settings.maps.small.find((m) => m.id === settings.activeMapId);
  if (found) return found;
  // 引用的小地图不存在了（比如被删除），兜底回退到大地图
  settings.activeMapId = BIG_MAP_ID;
  return settings.maps.big;
}

function getActiveMapId() {
  return getSettings().activeMapId;
}

// ---- 图片单独存 IndexedDB（容量远大于 localStorage，避免大图超限）----
// 每张地图（大地图固定 key "big"，每张小地图用自己的 id）各自存一份图片。
const IDB_NAME = "mm_map_marker_db";
const IDB_STORE = "images";

function openImageDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 图片按"角色名::原id"存储，数据按角色区分；群聊/未选中角色卡时用固定占位符，
// 仅供当次会话临时使用（反正对应的地图数据本身也不会持久化）。
function mmImageDbKey(id) {
  const name = getMapCurrentCharacterName();
  return `${name || "__no_character__"}::${id}`;
}

async function saveImage(id, dataUrl) {
  try {
    const db = await openImageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(dataUrl, mmImageDbKey(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("[MapMarker] 图片保存失败（IndexedDB）", e);
    toastr?.error?.("地图图片保存失败，请查看控制台报错。");
  }
}

async function loadImage(id) {
  try {
    const db = await openImageDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(mmImageDbKey(id));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error("[MapMarker] 图片读取失败（IndexedDB）", e);
    return null;
  }
}

async function deleteImage(id) {
  try {
    const db = await openImageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(mmImageDbKey(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("[MapMarker] 删除图片失败（IndexedDB）", e);
  }
}

// 只清除当前角色名下的图片（key 前缀匹配），不影响其他角色存过的底图
async function clearCurrentCharacterImages() {
  const prefix = `${getMapCurrentCharacterName() || "__no_character__"}::`;
  try {
    const db = await openImageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("[MapMarker] 清空当前角色图片失败（IndexedDB）", e);
  }
}

// ---- 动态加载本地打包的 Leaflet ----
let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;

  leafletLoading = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = LEAFLET_JS;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(
        new Error(
          "Leaflet 本地文件加载失败，请检查插件目录是否完整（lib/leaflet/）。",
        ),
      );
    document.head.appendChild(script);
  });
  return leafletLoading;
}

// ---- 颜色分配（自定义势力没指定颜色时循环取色） ----
const PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];
function colorForFaction(factionName) {
  const settings = getSettings();
  const found = settings.factions.find((t) => t.name === factionName);
  if (found) return found.color;
  return "#999999";
}

let mmMap = null;
let mmMarkersLayer = null;
let mmRoutesLayer = null;
let mmImageOverlay = null;

// ---- 路线"选点"模式状态（仅大地图可用） ----
let mmRouteMode = false;
let mmRouteFromId = null;

// ============================================================
// 角色数据归属（不再需要手动绑定，数据自动跟随当前打开的角色卡）
// ============================================================

// 面板顶部的小字提示：当前是哪个角色的数据，或群聊/未选角色卡时的临时状态说明
function updateCharIndicatorUI() {
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
const FAB_POS_KEY = "mm_fab_pos_v5";

function loadFabPos() {
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

function saveFabPos(left, top) {
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
function resetFabPos() {
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
function applyFabVisibility() {
  const fab = document.getElementById("mm-fab");
  if (!fab) return;
  fab.style.display = getFabVisible() ? "" : "none";
}

function injectFloatingButton() {
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

// ---- 通讯器悬浮球：结构和拖拽逻辑照搬上面的地图悬浮球，独立存一份坐标/独立的显隐开关，
// 互不干扰。默认停靠左下角（地图悬浮球在右上角，避免两个球叠在一起）。
// 点击目前只弹一个"开发中"提示——具体的手机界面（通讯录/聊天/动态/设置）还没做，
// 先把入口和开关打通，后面往 openPhoneModal() 里继续填内容即可。
const PHONE_FAB_POS_KEY = "plotAssistant_phoneFabPos";

function loadPhoneFabPos() {
  try {
    const raw = localStorage.getItem(PHONE_FAB_POS_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (typeof pos.left === "number" && typeof pos.top === "number") return pos;
  } catch (e) {
    /* 忽略，用默认位置 */
  }
  return null;
}

function savePhoneFabPos(left, top) {
  try {
    localStorage.setItem(PHONE_FAB_POS_KEY, JSON.stringify({ left, top }));
  } catch (e) {
    /* 存储失败不影响功能 */
  }
}

// 关闭通讯器悬浮球时顺带重置位置，逻辑跟 resetFabPos 一致：下次开永远回到干净的默认位置。
function resetPhoneFabPos() {
  try {
    localStorage.removeItem(PHONE_FAB_POS_KEY);
  } catch (e) {
    /* 忽略 */
  }
  const fab = document.getElementById("plot-assistant-phone-fab");
  if (fab) {
    fab.style.top = "";
    fab.style.left = "";
    fab.style.right = "";
    fab.style.bottom = "";
  }
}

// 只是 display:none/""，不销毁 DOM，拖拽记住的位置不会丢。
function applyPhoneFabVisibility() {
  const fab = document.getElementById("plot-assistant-phone-fab");
  if (!fab) return;
  fab.style.display = getPhoneFabVisible() ? "" : "none";
}

// ==== 手机界面 UI（通讯录 / 聊天 / 动态 / 设置）====
// DOM 结构/拖拽/弹窗关闭逻辑参照地图编辑器的 <dialog> 写法（buildModalSkeleton/openModal/closeModal），
// 只是内容换成克莱因蓝风格的手机屏幕，四个页签对应之前 mockup 里的四页。

const phoneUIState = {
  activeTab: "contacts", // contacts / moments / settings；进入聊天页时记录在 activeChatCharacter，不算独立 tab
  activeChatCharacter: null,
};

function escapePhoneHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
}

// 聊天页头部"…"下拉菜单（清空对话/上传头像）的开关，供 action-btn 点击和各处导航切换时调用。
function togglePhoneActionMenu() {
  document.getElementById("pa-phone-action-menu")?.classList.toggle("pa-phone-hidden");
}
function closePhoneActionMenu() {
  document
    .getElementById("pa-phone-action-menu")
    ?.classList.add("pa-phone-hidden");
}

function buildPhoneModalSkeleton() {
  if (document.getElementById("pa-phone-modal-overlay")) return;
  const html = `
    <dialog id="pa-phone-modal-overlay">
        <div id="pa-phone-modal">
            <div id="pa-phone-base-color-layer"></div>
            <div id="pa-phone-global-bg-layer"></div>
            <div id="pa-phone-header">
                <button id="pa-phone-back-btn" class="pa-phone-hidden" title="返回">‹</button>
                <button id="pa-phone-close-btn" title="关闭">✕</button>
                <span id="pa-phone-header-title">通讯录</span>
                <button id="pa-phone-action-btn" class="pa-phone-hidden"></button>
                <div id="pa-phone-action-menu" class="pa-phone-hidden">
                    <button id="pa-phone-action-menu-clear">清空对话</button>
                    <button id="pa-phone-action-menu-avatar">上传头像</button>
                    <button id="pa-phone-action-menu-bg">上传背景</button>
                    <button id="pa-phone-action-menu-bg-reset">恢复默认背景</button>
                </div>
                <input type="file" id="pa-phone-avatar-upload-input" accept="image/*" class="pa-phone-hidden" />
                <input type="file" id="pa-phone-chat-bg-upload-input" accept="image/*" class="pa-phone-hidden" />
            </div>
            <div id="pa-phone-body">
                <div id="pa-phone-page-contacts" class="pa-phone-page"></div>
                <div id="pa-phone-page-chat" class="pa-phone-page pa-phone-hidden"></div>
                <div id="pa-phone-page-moments" class="pa-phone-page pa-phone-hidden"></div>
                <div id="pa-phone-page-settings" class="pa-phone-page pa-phone-hidden"></div>
            </div>
            <div id="pa-phone-tabbar">
                <div class="pa-phone-tab" data-tab="contacts">通讯</div>
                <div class="pa-phone-tab" data-tab="moments">动态</div>
                <div class="pa-phone-tab" data-tab="settings">设置</div>
            </div>
        </div>
    </dialog>`;
  document.body.insertAdjacentHTML("beforeend", html);

  document
    .getElementById("pa-phone-close-btn")
    .addEventListener("click", closePhoneModal);
  document
    .getElementById("pa-phone-modal-overlay")
    .addEventListener("click", (e) => {
      if (e.target.id === "pa-phone-modal-overlay") closePhoneModal();
      // 点菜单和触发它的按钮以外的地方，顺手把菜单收起来。
      const menu = document.getElementById("pa-phone-action-menu");
      const btn = document.getElementById("pa-phone-action-btn");
      if (
        !menu.classList.contains("pa-phone-hidden") &&
        !menu.contains(e.target) &&
        e.target !== btn
      ) {
        menu.classList.add("pa-phone-hidden");
      }
    });
  document.getElementById("pa-phone-action-btn").addEventListener(
    "click",
    errorCatched(async () => {
      const btn = document.getElementById("pa-phone-action-btn");
      const mode = btn.dataset.mode;
      if (mode === "add-contact") {
        closePhoneModal();
        await openCreateCharacterDialog();
        await openPhoneModal();
        return;
      }
      if (mode === "chat-menu") {
        togglePhoneActionMenu();
      }
    }),
  );
  document.getElementById("pa-phone-action-menu-clear").addEventListener(
    "click",
    errorCatched(async () => {
      closePhoneActionMenu();
      const name = phoneUIState.activeChatCharacter;
      if (!name) return;
      const context = getCtx();
      const confirmed = await context.callGenericPopup(
        `确定要清空和「${name}」的全部私信记录吗？此操作不可撤销。`,
        context.POPUP_TYPE.CONFIRM,
        "",
        { okButton: "清空", cancelButton: "取消" },
      );
      if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;
      await clearPhoneMessages(name);
      notify("success", `已清空和「${name}」的私信记录。`);
      await renderPhoneChatMessages(name);
    }),
  );
  document
    .getElementById("pa-phone-action-menu-avatar")
    .addEventListener("click", () => {
      closePhoneActionMenu();
      document.getElementById("pa-phone-avatar-upload-input").click();
    });
  document.getElementById("pa-phone-avatar-upload-input").addEventListener(
    "change",
    errorCatched(async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const name = phoneUIState.activeChatCharacter;
      if (!name) return;
      const cropped = await openImageCropDialog({
        file,
        title: "裁剪头像",
        ratio: 1,
        shape: "circle",
        outputWidth: 320,
        outputHeight: 320,
      });
      if (!cropped) return;
      await savePhoneAvatar(name, cropped);
      notify("success", `已更新「${name}」的头像。`);
    }),
  );
  document
    .getElementById("pa-phone-action-menu-bg")
    .addEventListener("click", () => {
      closePhoneActionMenu();
      document.getElementById("pa-phone-chat-bg-upload-input").click();
    });
  document.getElementById("pa-phone-chat-bg-upload-input").addEventListener(
    "change",
    errorCatched(async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const name = phoneUIState.activeChatCharacter;
      if (!name) return;
      const cropped = await openImageCropDialog({
        file,
        title: "裁剪背景",
        ratio: PHONE_CHAT_BG_RATIO,
        shape: "rect",
        outputWidth: 720,
        outputHeight: Math.round(720 / PHONE_CHAT_BG_RATIO),
      });
      if (!cropped) return;
      await savePhoneChatBackground(name, cropped);
      if (phoneUIState.activeChatCharacter === name) {
        applyPhoneChatBackground(cropped);
      }
      notify("success", `已更新「${name}」的聊天背景。`);
    }),
  );
  document.getElementById("pa-phone-action-menu-bg-reset").addEventListener(
    "click",
    errorCatched(async () => {
      closePhoneActionMenu();
      const name = phoneUIState.activeChatCharacter;
      if (!name) return;
      const existing = await getPhoneChatBackground(name);
      if (!existing) {
        notify("warning", "当前使用默认背景，无需恢复。");
        return;
      }
      await deletePhoneChatBackground(name);
      if (phoneUIState.activeChatCharacter === name) {
        applyPhoneChatBackground(null);
      }
      notify("success", `已恢复「${name}」的默认背景。`);
    }),
  );
  document.getElementById("pa-phone-back-btn").addEventListener("click", () => {
    closePhoneActionMenu();
    phoneUIState.activeChatCharacter = null;
    switchPhoneTab("contacts");
  });
  document.querySelectorAll("#pa-phone-tabbar .pa-phone-tab").forEach((el) => {
    el.addEventListener("click", () => {
      phoneUIState.activeChatCharacter = null;
      switchPhoneTab(el.dataset.tab);
    });
  });
}

// 切换页签（不含聊天页——聊天页由 openPhoneChat 单独进入，退出走"返回"按钮）
async function switchPhoneTab(tab) {
  closePhoneActionMenu();
  phoneUIState.activeTab = tab;
  document
    .querySelectorAll("#pa-phone-tabbar .pa-phone-tab")
    .forEach((el) =>
      el.classList.toggle("pa-phone-tab-active", el.dataset.tab === tab),
    );
  document
    .getElementById("pa-phone-tabbar")
    .classList.remove("pa-phone-hidden");
  document.getElementById("pa-phone-back-btn").classList.add("pa-phone-hidden");
  document
    .getElementById("pa-phone-close-btn")
    .classList.remove("pa-phone-hidden");

  const titles = { contacts: "通讯录", moments: "动态", settings: "设置" };
  document.getElementById("pa-phone-header-title").textContent =
    titles[tab] || "";

  // 右侧动作按钮：通讯页是"添加联系人"，动态/设置页暂时不需要，先隐藏。
  const actionBtn = document.getElementById("pa-phone-action-btn");
  if (tab === "contacts") {
    actionBtn.textContent = "＋";
    actionBtn.title = "添加联系人";
    actionBtn.dataset.mode = "add-contact";
    actionBtn.classList.add("pa-phone-action-icon");
    actionBtn.classList.remove("pa-phone-hidden");
  } else {
    actionBtn.classList.add("pa-phone-hidden");
    delete actionBtn.dataset.mode;
  }

  ["contacts", "chat", "moments", "settings"].forEach((name) => {
    document
      .getElementById(`pa-phone-page-${name}`)
      .classList.toggle("pa-phone-hidden", name !== tab);
  });

  if (tab === "contacts") await renderPhoneContactsPage();
  else if (tab === "moments") renderPhoneMomentsPage();
  else if (tab === "settings") await renderPhoneSettingsPage();
}

async function renderPhoneContactsPage() {
  const container = document.getElementById("pa-phone-page-contacts");
  container.innerHTML = `<div class="pa-phone-loading">加载中...</div>`;
  const contacts = await getPhoneContactsList();
  if (contacts.length === 0) {
    container.innerHTML = `<div class="pa-phone-empty">还没有联系人，先用「创建角色」功能建一个角色卡吧～</div>`;
    return;
  }
  const avatarMap = await getAllPhoneAvatarsForCurrentCharacter();
  container.innerHTML = contacts
    .map((c) => {
      const { gender } = parseContactExtra(c.extra);
      const metaText = gender ? `${gender}` : "";
      const avatarUrl = avatarMap.get(c.name);
      const avatarInner = avatarUrl
        ? `<img class="pa-phone-avatar-img" src="${avatarUrl}" alt="${escapePhoneHtml(c.name)}" />`
        : escapePhoneHtml(c.name.slice(0, 1));
      return `
      <div class="pa-phone-contact-item" data-name="${escapePhoneHtml(c.name)}">
        <div class="pa-phone-avatar">${avatarInner}</div>
        <div class="pa-phone-contact-meta">
          <div class="pa-phone-contact-name">${escapePhoneHtml(c.name)}</div>
          <div class="pa-phone-contact-extra">${escapePhoneHtml(metaText)}</div>
        </div>
      </div>`;
    })
    .join("");
  container.querySelectorAll(".pa-phone-contact-item").forEach((el) => {
    el.addEventListener("click", () => openPhoneChat(el.dataset.name));
  });
}

function renderPhoneMomentsPage() {
  document.getElementById("pa-phone-page-moments").innerHTML =
    `<div class="pa-phone-empty">「动态」页正在开发中，敬请期待～</div>`;
}

// 全局背景（通讯录/动态/设置三页共用）的裁剪宽高比，参照手机弹窗内容区域的大致比例（360:550）。
const PHONE_GLOBAL_BG_RATIO = 360 / 550;
// 聊天页背景（按联系人分别设置）的裁剪宽高比，参照消息滚动区域（顶部标题栏和底部输入栏之间）的大致比例（360:540）。
const PHONE_CHAT_BG_RATIO = 360 / 540;

// 设置页：第一行是"背景"（全局背景，铺满通讯录/动态/设置三页），下面是"图片"（原表情包）批量导入 + 网格管理。
// 清空聊天记录、更换头像、更换聊天页背景都挪去了聊天页头部"…"菜单里，按当前联系人操作，这里不再重复。
async function renderPhoneSettingsPage() {
  const container = document.getElementById("pa-phone-page-settings");
  container.innerHTML = `<div class="pa-phone-loading">加载中...</div>`;
  const [stickers, globalBg] = await Promise.all([
    getPhoneStickerList(),
    getPhoneGlobalBackground(),
  ]);

  const gridHtml = stickers.length
    ? stickers
        .map(
          (s) => `
      <div class="pa-phone-sticker-manage-item" data-id="${escapePhoneHtml(s.id)}">
        <button class="pa-phone-sticker-delete-btn" title="删除">✕</button>
        <img src="${s.dataUrl}" alt="${escapePhoneHtml(s.name)}" />
        <div class="pa-phone-sticker-manage-name" title="点击改名">${escapePhoneHtml(s.name)}</div>
      </div>`,
        )
        .join("")
    : `<div class="pa-phone-empty">还没有图片，点右上角"添加"批量导入几张吧～</div>`;

  container.innerHTML = `
    <div class="pa-phone-settings-section">
      <div class="pa-phone-settings-title-row">
        <div class="pa-phone-settings-title">背景</div>
        <div class="pa-phone-bg-btns">
          <button id="pa-phone-global-bg-upload-btn" class="pa-phone-sticker-add-btn">上传背景</button>
          <button id="pa-phone-global-bg-reset-btn" class="pa-phone-bg-reset-btn${globalBg ? "" : " pa-phone-hidden"}">恢复默认</button>
        </div>
      </div>
      <div id="pa-phone-global-bg-preview" class="pa-phone-bg-preview"${globalBg ? ` style="background-image:url('${globalBg}')"` : ""}>
        ${globalBg ? "" : '<span class="pa-phone-bg-preview-empty">未设置，通讯录/动态/设置页将使用此背景</span>'}
      </div>
    </div>
    <input type="file" id="pa-phone-global-bg-upload-input" accept="image/*" class="pa-phone-hidden" />
    <div class="pa-phone-settings-section">
      <div class="pa-phone-settings-title-row">
        <div class="pa-phone-settings-title">图片</div>
        <button id="pa-phone-sticker-add-btn" class="pa-phone-sticker-add-btn">+ 添加</button>
      </div>
      <div class="pa-phone-sticker-manage-grid">${gridHtml}</div>
    </div>
    <input type="file" id="pa-phone-sticker-upload-input" accept="image/*" multiple class="pa-phone-hidden" />`;

  document
    .getElementById("pa-phone-global-bg-upload-btn")
    .addEventListener("click", () => {
      document.getElementById("pa-phone-global-bg-upload-input").click();
    });
  document.getElementById("pa-phone-global-bg-upload-input").addEventListener(
    "change",
    errorCatched(async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const cropped = await openImageCropDialog({
        file,
        title: "裁剪背景",
        ratio: PHONE_GLOBAL_BG_RATIO,
        shape: "rect",
        outputWidth: 720,
        outputHeight: Math.round(720 / PHONE_GLOBAL_BG_RATIO),
      });
      if (!cropped) return;
      await savePhoneGlobalBackground(cropped);
      applyPhoneGlobalBackground(cropped);
      notify("success", "已更新背景。");
      await renderPhoneSettingsPage();
    }),
  );
  document.getElementById("pa-phone-global-bg-reset-btn").addEventListener(
    "click",
    errorCatched(async () => {
      await deletePhoneGlobalBackground();
      applyPhoneGlobalBackground(null);
      notify("success", "已恢复默认背景。");
      await renderPhoneSettingsPage();
    }),
  );

  document
    .getElementById("pa-phone-sticker-add-btn")
    .addEventListener("click", () => {
      document.getElementById("pa-phone-sticker-upload-input").click();
    });

  document.getElementById("pa-phone-sticker-upload-input").addEventListener(
    "change",
    errorCatched(async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (!files.length) return;
      const items = [];
      for (const file of files) {
        const dataUrl = await readImageFileCompressed(file, 200);
        const baseName = file.name.replace(/\.[^.]+$/, "") || "图片";
        items.push({ name: baseName, dataUrl });
      }
      await addPhoneStickers(items);
      notify("success", `已导入 ${items.length} 张图片。`);
      await renderPhoneSettingsPage();
    }),
  );

  container.querySelectorAll(".pa-phone-sticker-delete-btn").forEach((btn) => {
    btn.addEventListener(
      "click",
      errorCatched(async () => {
        const item = btn.closest(".pa-phone-sticker-manage-item");
        await deletePhoneSticker(item.dataset.id);
        await renderPhoneSettingsPage();
      }),
    );
  });

  container.querySelectorAll(".pa-phone-sticker-manage-name").forEach((nameEl) => {
    nameEl.addEventListener("click", () => {
      const item = nameEl.closest(".pa-phone-sticker-manage-item");
      const id = item.dataset.id;
      const current = nameEl.textContent;
      nameEl.outerHTML = `<input class="pa-phone-sticker-name-input" value="${escapePhoneHtml(current)}" />`;
      const input = item.querySelector(".pa-phone-sticker-name-input");
      input.focus();
      input.select();
      const save = errorCatched(async () => {
        const newName = input.value.trim() || current;
        await renamePhoneSticker(id, newName);
        await renderPhoneSettingsPage();
      });
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
      });
    });
  });
}

// 进入某个联系人的聊天页：隐藏 tabbar，显示返回按钮，标题换成联系人名字。
async function openPhoneChat(characterName) {
  phoneUIState.activeChatCharacter = characterName;
  document.getElementById("pa-phone-header-title").textContent = characterName;
  document
    .getElementById("pa-phone-back-btn")
    .classList.remove("pa-phone-hidden");
  document
    .getElementById("pa-phone-close-btn")
    .classList.add("pa-phone-hidden");
  document.getElementById("pa-phone-tabbar").classList.add("pa-phone-hidden");

  closePhoneActionMenu();
  const actionBtn = document.getElementById("pa-phone-action-btn");
  actionBtn.textContent = "⋯";
  actionBtn.title = "更多操作";
  actionBtn.dataset.mode = "chat-menu";
  actionBtn.classList.add("pa-phone-action-icon");
  actionBtn.classList.remove("pa-phone-hidden");
  ["contacts", "chat", "moments", "settings"].forEach((name) => {
    document
      .getElementById(`pa-phone-page-${name}`)
      .classList.toggle("pa-phone-hidden", name !== "chat");
  });

  const page = document.getElementById("pa-phone-page-chat");
  page.innerHTML = `
    <div id="pa-phone-chat-messages"><div class="pa-phone-loading">加载中...</div></div>
    <div id="pa-phone-sticker-panel" class="pa-phone-hidden"></div>
    <div id="pa-phone-chat-inputbar">
      <button id="pa-phone-sticker-btn" title="图片">☺</button>
      <input id="pa-phone-chat-input" type="text" placeholder="发消息给${escapePhoneHtml(
        characterName,
      )}..." />
      <button id="pa-phone-chat-send-btn">发送</button>
    </div>`;

  const chatBg = await getPhoneChatBackground(characterName);
  applyPhoneChatBackground(chatBg);

  await renderPhoneChatMessages(characterName);

  const input = document.getElementById("pa-phone-chat-input");
  const sendBtn = document.getElementById("pa-phone-chat-send-btn");
  const stickerBtn = document.getElementById("pa-phone-sticker-btn");
  const stickerPanel = document.getElementById("pa-phone-sticker-panel");
  const doSend = errorCatched(async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendBtn.disabled = true;
    input.disabled = true;
    try {
      await sendPhoneMessageToCharacter(characterName, text);
      if (phoneUIState.activeChatCharacter === characterName) {
        await renderPhoneChatMessages(characterName);
      }
    } finally {
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  });
  sendBtn.addEventListener("click", doSend);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSend();
  });
  stickerBtn.addEventListener(
    "click",
    errorCatched(async () => {
      const willShow = stickerPanel.classList.contains("pa-phone-hidden");
      if (willShow) await renderPhoneStickerPanel(characterName, stickerPanel);
      stickerPanel.classList.toggle("pa-phone-hidden", !willShow);
    }),
  );
}

// 图片选择面板：网格展示图片库，点一下就直接发出去（跟真实聊天软件的表情选择一致）。
async function renderPhoneStickerPanel(characterName, panel) {
  const list = await getPhoneStickerList();
  if (!list.length) {
    panel.innerHTML = `<div class="pa-phone-empty" style="padding:14px 10px;">还没有图片，去设置页导入几张吧～</div>`;
    return;
  }
  panel.innerHTML = list
    .map(
      (s) => `
    <div class="pa-phone-sticker-item" data-id="${escapePhoneHtml(s.id)}" title="${escapePhoneHtml(s.name)}">
      <img src="${s.dataUrl}" alt="${escapePhoneHtml(s.name)}" />
    </div>`,
    )
    .join("");
  panel.querySelectorAll(".pa-phone-sticker-item").forEach((el) => {
    el.addEventListener(
      "click",
      errorCatched(async () => {
        const sticker = list.find((s) => s.id === el.dataset.id);
        if (!sticker) return;
        panel.classList.add("pa-phone-hidden");
        await sendPhoneStickerToCharacter(characterName, sticker);
      }),
    );
  });
}

// 发一张图片：text 存 `[图片:图片名]` 文字标记（AI 靠这个感知"用户发了张图片"），
// stickerId 关联图片库图片，供本地气泡渲染真实图片用。
async function sendPhoneStickerToCharacter(characterName, sticker) {
  const sendBtn = document.getElementById("pa-phone-chat-send-btn");
  const input = document.getElementById("pa-phone-chat-input");
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;
  try {
    await sendPhoneMessageToCharacter(characterName, {
      text: `[图片:${sticker.name}]`,
      stickerId: sticker.id,
    });
    if (phoneUIState.activeChatCharacter === characterName) {
      await renderPhoneChatMessages(characterName);
    }
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.disabled = false;
  }
}

// 重新渲染聊天页消息列表（发送/收到新消息后调用），并自动滚到底部。
async function renderPhoneChatMessages(characterName) {
  const list = document.getElementById("pa-phone-chat-messages");
  if (!list) return;
  const groups = await getAllPhoneMessages(characterName);
  if (groups.length === 0) {
    list.innerHTML = `<div class="pa-phone-empty">还没有聊天记录，发第一条消息试试吧～</div>`;
    return;
  }
  // 一次性把图片库读出来建个 id -> 记录的索引，气泡渲染时按 stickerId 查图；
  // 图片后来被删了查不到时，退化成显示 [图片:xxx] 文字标记，不会渲染出坏图标。
  const stickerMap = new Map(
    (await getPhoneStickerList()).map((s) => [s.id, s]),
  );
  list.innerHTML = groups
    .map((g) => {
      // 分割线：取这一组消息里第一条带 storyTime 的日期部分；这组里没有任何消息带 storyTime（旧数据）时，退回显示现实日期。
      const firstStoryDate = g.msgs
        .map((m) => splitStoryTime(m.storyTime).date)
        .find((d) => d);
      const dividerText = firstStoryDate || g.dateKey;
      return `
      <div class="pa-phone-date-divider">${escapePhoneHtml(dividerText)}</div>
      ${g.msgs
        .map((m) => {
          const storyParts = splitStoryTime(m.storyTime);
          const timeStr =
            storyParts.time || new Date(m.ts).toTimeString().slice(0, 5);
          const side =
            m.from === "user" ? "pa-phone-msg-right" : "pa-phone-msg-left";
          const sticker = m.stickerId ? stickerMap.get(m.stickerId) : null;
          const bubbleClass = sticker
            ? "pa-phone-msg-bubble pa-phone-msg-bubble-sticker"
            : "pa-phone-msg-bubble";
          const bubbleInner = sticker
            ? `<img class="pa-phone-msg-sticker-img" src="${sticker.dataUrl}" alt="${escapePhoneHtml(sticker.name)}" />`
            : escapePhoneHtml(m.text);
          return `
          <div class="pa-phone-msg-row ${side}" data-id="${escapePhoneHtml(m.id)}" data-text="${escapePhoneHtml(m.text)}">
            <div class="pa-phone-msg-bubble-line">
              <div class="${bubbleClass}">${bubbleInner}</div>
              <button class="pa-phone-msg-more-btn" title="编辑/删除">⋯</button>
            </div>
            <div class="pa-phone-msg-actions pa-phone-hidden">
              <button class="pa-phone-msg-edit-btn">编辑</button>
              <button class="pa-phone-msg-delete-btn">删除</button>
            </div>
            <div class="pa-phone-msg-time">${timeStr}</div>
          </div>`;
        })
        .join("")}`;
    })
    .join("");
  list.scrollTop = list.scrollHeight;
  bindPhoneChatMessageActions(list, characterName);
}

// 给每条消息挂"···"展开/收起、编辑、删除的交互；每次 renderPhoneChatMessages 重绘后重新绑定一遍。
function bindPhoneChatMessageActions(list, characterName) {
  list.querySelectorAll(".pa-phone-msg-row").forEach((row) => {
    const actions = row.querySelector(".pa-phone-msg-actions");

    row
      .querySelector(".pa-phone-msg-more-btn")
      .addEventListener("click", () => {
        const willShow = actions.classList.contains("pa-phone-hidden");
        // 同一时间只保留一行展开，点别的行的"···"先把上一行收起。
        list
          .querySelectorAll(".pa-phone-msg-actions")
          .forEach((el) => el.classList.add("pa-phone-hidden"));
        actions.classList.toggle("pa-phone-hidden", !willShow);
      });

    row
      .querySelector(".pa-phone-msg-edit-btn")
      .addEventListener("click", () => {
        actions.classList.add("pa-phone-hidden");
        const bubbleLine = row.querySelector(".pa-phone-msg-bubble-line");
        // 从 data-text 读原文，而不是气泡的 textContent——图片消息的气泡里是 <img>，
        // textContent 读不到 [图片:xxx] 这个真实存的文字标记。保存后 updatePhoneMessageText
        // 会顺带清掉 stickerId，这条消息就退化成普通文字消息了。
        const originalText = row.dataset.text || "";
        bubbleLine.outerHTML = `
        <div class="pa-phone-msg-edit-box">
          <textarea class="pa-phone-msg-edit-input">${escapePhoneHtml(originalText)}</textarea>
          <div class="pa-phone-msg-edit-btns">
            <button class="pa-phone-msg-edit-cancel">取消</button>
            <button class="pa-phone-msg-edit-save">保存</button>
          </div>
        </div>`;
        const box = row.querySelector(".pa-phone-msg-edit-box");
        box
          .querySelector(".pa-phone-msg-edit-cancel")
          .addEventListener("click", () =>
            renderPhoneChatMessages(characterName),
          );
        box.querySelector(".pa-phone-msg-edit-save").addEventListener(
          "click",
          errorCatched(async () => {
            const newText = box
              .querySelector(".pa-phone-msg-edit-input")
              .value.trim();
            if (!newText) {
              notify("warning", "私信内容不能为空，没有保存。");
              return;
            }
            await updatePhoneMessageText(
              characterName,
              row.dataset.id,
              newText,
            );
            await renderPhoneChatMessages(characterName);
          }),
        );
      });

    row.querySelector(".pa-phone-msg-delete-btn").addEventListener(
      "click",
      errorCatched(async () => {
        const context = getCtx();
        const confirmed = await context.callGenericPopup(
          "确定要删除这条私信吗？此操作不可撤销。",
          context.POPUP_TYPE.CONFIRM,
          "",
          { okButton: "删除", cancelButton: "取消" },
        );
        if (confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;
        await deletePhoneMessage(characterName, row.dataset.id);
        await renderPhoneChatMessages(characterName);
      }),
    );
  });
}

// 角色"变闲"自动补发回复后，如果手机聊天页当前正好开着这个联系人，实时刷新一下。
function refreshPhoneChatViewIfOpen(characterName) {
  const overlay = document.getElementById("pa-phone-modal-overlay");
  if (!overlay || !overlay.open) return;
  if (phoneUIState.activeChatCharacter !== characterName) return;
  renderPhoneChatMessages(characterName);
}

function closePhoneModal() {
  const overlay = document.getElementById("pa-phone-modal-overlay");
  if (overlay && overlay.open) overlay.close();
  closePhoneActionMenu();
  document
    .getElementById("pa-phone-sticker-panel")
    ?.classList.add("pa-phone-hidden");
}

async function openPhoneModal() {
  buildPhoneModalSkeleton();
  phoneUIState.activeChatCharacter = null;
  const globalBg = await getPhoneGlobalBackground();
  applyPhoneGlobalBackground(globalBg);
  document.getElementById("pa-phone-modal-overlay").showModal();
  await switchPhoneTab("contacts");
}

function injectPhoneFloatingButton() {
  if (document.getElementById("plot-assistant-phone-fab")) return;

  const html = `
        <div id="plot-assistant-phone-fab" title="通讯器">
            <div class="plot-assistant-phone-fab-icon">📱</div>
        </div>`;
  document.body.insertAdjacentHTML("beforeend", html);

  const fab = document.getElementById("plot-assistant-phone-fab");

  const FAB_MARGIN = 16;
  const FAB_SIZE = 44;

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

  const savedPos = loadPhoneFabPos();
  if (savedPos) {
    const pos = clampPos(savedPos.left, savedPos.top);
    fab.style.right = "auto";
    fab.style.bottom = "auto";
    fab.style.left = `${pos.left}px`;
    fab.style.top = `${pos.top}px`;
  }
  // 显隐由控制面板里的「通讯器开/通讯器关」按钮控制，这里只负责套用启动时已保存的状态。
  applyPhoneFabVisibility();

  let dragging = false;
  let moved = false;
  let startX = 0,
    startY = 0;
  let offsetX = 0,
    offsetY = 0;

  const DRAG_THRESHOLD = 6;

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
      savePhoneFabPos(left, top);
    } else {
      openPhoneModal();
    }
  }

  fab.addEventListener("mousedown", onPointerDown);
  fab.addEventListener("touchstart", onPointerDown, { passive: true });
}

function buildModalSkeleton() {
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
      if (mmRouteMode) {
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
    if (e.key === "Escape" && mmRouteMode) cancelRouteMode();
  });
}

// 移动端侧栏抽屉开关（桌面端侧栏常驻显示，这两个 class 不生效）
function toggleMobileSidebar(force) {
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

async function openModal() {
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
  if (!mmMap) {
    await initMap();
  } else {
    // 弹窗此前已经打开过，但期间可能切换了角色卡——mmMap 实例复用，
    // 必须重新按当前角色的地图数据刷新一遍图片/标记/路线，否则会显示上一个角色的旧内容。
    await loadActiveMapImageAndRender();
  }
  setTimeout(() => mmMap && mmMap.invalidateSize(), 50);
  renderMarkerList();
  renderRouteList();
  renderMapMeta();
}

function closeModal() {
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

async function initMap() {
  const L = window.L;
  mmMap = L.map("mm-map", {
    crs: L.CRS.Simple,
    minZoom: -5,
    maxZoom: 4,
    zoomSnap: 0.25,
  });

  mmMarkersLayer = L.layerGroup().addTo(mmMap);
  mmRoutesLayer = L.layerGroup().addTo(mmMap);
  bindPopupFormEvents(); // 用 popupopen 事件统一绑定表单按钮，解决 DOM 时机问题

  mmMap.on("click", (e) => {
    if (mmRouteMode) return; // 路线选点模式下，空白处点击不做任何事，只能点已有标记
    if (!mmImageOverlay) return; // 没有底图时不允许打点
    openMarkerForm(null, e.latlng);
  });

  // 路线的角度/间距是按"当前缩放级别下的屏幕像素"算的，缩放变化后重新渲染一次，
  // 让路线和标记之间的视觉间距在任意缩放级别下都保持一致，不会显得忽远忽近。
  mmMap.on("zoomend", renderAllRoutes);

  await loadActiveMapImageAndRender();
}

async function loadActiveMapImageAndRender() {
  const map = getActiveMap();
  const id = getActiveMapId();

  mmMarkersLayer?.clearLayers();
  mmRoutesLayer?.clearLayers();
  if (mmImageOverlay) {
    mmMap.removeLayer(mmImageOverlay);
    mmImageOverlay = null;
  }

  const savedImage = await loadImage(id);
  if (savedImage) {
    renderImageOverlay(savedImage, map.imageWidth, map.imageHeight);
  } else {
    document.getElementById("mm-map")?.classList.add("mm-empty");
    mmMap.setView([0, 0], 0);
  }

  renderAllMarkers();
  renderAllRoutes();
}

async function switchActiveMap(mapId) {
  if (mmRouteMode) cancelRouteMode();
  const settings = getSettings();
  settings.activeMapId = mapId;
  saveSettings();

  if (mmMap) {
    await loadActiveMapImageAndRender();
  }
  renderMarkerList();
  renderRouteList();
  renderMapMeta();
}

function populateMapSwitch() {
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

function renderImageOverlay(dataUrl, width, height) {
  const L = window.L;
  document.getElementById("mm-map").classList.remove("mm-empty");

  if (mmImageOverlay) {
    mmMap.removeLayer(mmImageOverlay);
  }
  // 用图片的像素尺寸作为坐标系边界：y 用负数让图片方向正常显示
  const bounds = [
    [-height, 0],
    [0, width],
  ];
  mmImageOverlay = L.imageOverlay(dataUrl, bounds).addTo(mmMap);
  mmMap.fitBounds(bounds);
}

function handleImageUpload(e) {
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
function createBlankImageDataUrl(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png");
}

async function handleNewSmallMap() {
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

function renderMapMeta() {
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

async function deleteSmallMap(id) {
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
// 标记 CRUD（大地图/小地图通用，作用于当前 getActiveMap()）
// ============================================================

function renderAllMarkers() {
  if (!mmMarkersLayer) return;
  mmMarkersLayer.clearLayers();
  const map = getActiveMap();
  map.markers.forEach((m) => addLeafletMarker(m));
}

function addLeafletMarker(marker) {
  const L = window.L;
  const color = colorForFaction(marker.faction);
  const icon = L.divIcon({
    className: "",
    html: `<div class="mm-leaflet-icon" style="width:16px;height:16px;background:${color};"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  const lm = L.marker([marker.y, marker.x], { icon }).addTo(mmMarkersLayer);
  lm.bindTooltip(marker.name, { direction: "top", offset: [0, -8] });
  lm.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    if (mmRouteMode) {
      handleRoutePointClick(marker);
      return;
    }
    openMarkerForm(marker);
  });
}

// 当前正在编辑/新建的标记或路线表单上下文，供 popupopen 事件里的绑定函数读取
// { type: "marker", existingMarker, latlng, isEdit } 或 { type: "route", fromMarker, toMarker }
let mmPendingFormContext = null;

function openMarkerForm(existingMarker, latlng) {
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

  mmPendingFormContext = { type: "marker", existingMarker, latlng, isEdit };

  const popupLatLng = isEdit
    ? [existingMarker.y, existingMarker.x]
    : [latlng.lat, latlng.lng];
  // maxHeight：Leaflet 会给弹层内容自动套一层可滚动容器，避免内容比可视区域高时
  // 直接溢出屏幕、划不到看不全（横屏矮屏尤其明显）。用地图容器高度的 70% 做上限。
  const mapH1 = mmMap.getContainer().clientHeight || window.innerHeight;
  L.popup({
    closeButton: false,
    minWidth: 200,
    autoPan: true,
    maxHeight: Math.round(mapH1 * 0.7),
  })
    .setLatLng(popupLatLng)
    .setContent(formHtml)
    .openOn(mmMap);
}

// 在地图初始化时只绑定一次：Leaflet 保证 popupopen 触发时 DOM 已经插入完毕，可以安全操作表单元素。
function bindPopupFormEvents() {
  mmMap.on("popupopen", (e) => {
    const ctx = mmPendingFormContext;
    if (!ctx) return; // 不是我们插件打开的 popup（理论上不会发生，做个保护）

    const root = e.popup.getElement();
    if (!root) return;

    if (ctx.type === "route") {
      bindRouteFormEvents(root, ctx);
      return;
    }

    bindMarkerFormEvents(root, ctx);
  });

  mmMap.on("popupclose", () => {
    mmPendingFormContext = null;
  });
}

function bindMarkerFormEvents(root, ctx) {
  const { existingMarker, latlng, isEdit } = ctx;

  const cancelBtn = root.querySelector("#mm-f-cancel");
  const saveBtn = root.querySelector("#mm-f-save");
  const deleteBtn = root.querySelector("#mm-f-delete");

  if (cancelBtn) {
    cancelBtn.onclick = () => mmMap.closePopup();
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
      mmMap.closePopup();
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
      mmMap.closePopup();
    };
  }
}

function renderMarkerList() {
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
        mmMap.setView([marker.y, marker.x], mmMap.getZoom());
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
      mmMap.setView([marker.y, marker.x], mmMap.getZoom());
      openMarkerForm(marker);
      toggleMobileSidebar(false); // 移动端点完列表项收起抽屉，露出地图上弹出的编辑表单
    });
  });
}

// ============================================================
// 路线（势力行动，仅大地图支持；小地图没有路线概念）
// ============================================================

function startRouteMode() {
  if (!isBigMapActive()) {
    toastr?.warning?.(
      "路线功能仅支持大地图，小地图请用左侧的空间布局说明来描述位置关系",
    );
    return;
  }
  if (!mmImageOverlay) {
    toastr?.warning?.("请先上传地图图片");
    return;
  }
  const map = getActiveMap();
  if (map.markers.length < 2) {
    toastr?.warning?.("至少需要两个标记点才能添加路线");
    return;
  }
  mmRouteMode = true;
  mmRouteFromId = null;
  document.getElementById("mm-add-route-btn")?.classList.add("mm-active");
  showRouteHint("请点击【出发点】标记");
}

function cancelRouteMode() {
  mmRouteMode = false;
  mmRouteFromId = null;
  document.getElementById("mm-add-route-btn")?.classList.remove("mm-active");
  hideRouteHint();
}

function showRouteHint(text) {
  const textEl = document.getElementById("mm-route-hint-text");
  if (textEl) textEl.textContent = text;
  document.getElementById("mm-route-hint")?.classList.remove("mm-hidden");
}

function hideRouteHint() {
  document.getElementById("mm-route-hint")?.classList.add("mm-hidden");
}

function handleRoutePointClick(marker) {
  if (!mmRouteFromId) {
    mmRouteFromId = marker.id;
    showRouteHint(`出发点：${marker.name}，请点击【目标点】标记`);
    return;
  }
  if (marker.id === mmRouteFromId) {
    toastr?.warning?.("出发点和目标点不能是同一个标记，请重新点击目标点");
    return;
  }
  const map = getActiveMap();
  const fromMarker = map.markers.find((m) => m.id === mmRouteFromId);
  const toMarker = marker;
  cancelRouteMode(); // 先退出选点模式，再弹表单，避免表单里点地图触发选点逻辑
  openRouteForm(fromMarker, toMarker);
}

// 用"当前缩放级别下的屏幕像素坐标"算方位角——
// 用 map.project()/unproject()（带上当前 zoom）保证和屏幕上实际看到的方向一致，
// 不同缩放级别下结果也不会跑偏。
function computeScreenVector(from, to) {
  const L = window.L;
  const zoom = mmMap.getZoom();
  const p1 = mmMap.project(L.latLng(from.y, from.x), zoom);
  const p2 = mmMap.project(L.latLng(to.y, to.x), zoom);
  return { dx: p2.x - p1.x, dy: p2.y - p1.y };
}

// 箭身连线用的角度：0° = 指向右侧（东），顺时针为正（用于 CSS rotate）
function computeRouteAngle(from, to) {
  const { dx, dy } = computeScreenVector(from, to);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

// 军事罗盘方位：0° = 正北，顺时针增大（用于生成"东南方"这类文字）
function computeBearingText(from, to) {
  const { dx, dy } = computeScreenVector(from, to);
  let bearing = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (bearing < 0) bearing += 360;
  const idx = Math.round(bearing / 45) % 8;
  return COMPASS_NAMES[idx];
}

// 在连线上、离终点 backOffsetPx（当前缩放级别下的屏幕像素）处取一点，
// 用于放路线终点箭头三角形，让它和终点的标记圆点保持一段距离，不贴在一起。
// 因为是按屏幕像素算的，缩放变化后需要重新渲染（见 initMap 里的 zoomend 监听）。
function pointAlongLine(from, to, backOffsetPx) {
  const L = window.L;
  const zoom = mmMap.getZoom();
  const p1 = mmMap.project(L.latLng(from.y, from.x), zoom);
  const p2 = mmMap.project(L.latLng(to.y, to.x), zoom);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const ratio = Math.max(0, (dist - backOffsetPx) / dist);
  const px = p1.x + dx * ratio;
  const py = p1.y + dy * ratio;
  return mmMap.unproject(L.point(px, py), zoom);
}

function openRouteForm(fromMarker, toMarker) {
  const L = window.L;
  const defaultBearing = computeBearingText(fromMarker, toMarker);

  const formHtml = `
        <div class="mm-form-popup mm-route-form">
            <div class="mm-route-form-title">${escapeHtml(fromMarker.name)} → ${escapeHtml(toMarker.name)}</div>
            <label>目标相对方位</label>
            <input type="text" id="mm-r-bearing" value="${escapeHtml(defaultBearing)}" placeholder="例如：东南方">
            <label>距离（可留空）</label>
            <input type="text" id="mm-r-distance" placeholder="例如：20公里">
            <label>队伍信息 *</label>
            <input type="text" id="mm-r-party" placeholder="例如：黑风小队200人">
            <label>预计出发时间（可留空）</label>
            <input type="text" id="mm-r-depart" placeholder="例如：七月十五日卯时">
            <label>预计到达时间 *</label>
            <input type="text" id="mm-r-arrive" placeholder="例如：七月十五日酉时">
            <div class="mm-form-actions">
                <button id="mm-r-cancel">取消</button>
                <button id="mm-r-save">保存</button>
            </div>
        </div>`;

  mmPendingFormContext = { type: "route", fromMarker, toMarker };

  // 同上：限制最大高度，内容过长时弹层内部出滚动条，而不是溢出屏幕外划不到。
  const mapH2 = mmMap.getContainer().clientHeight || window.innerHeight;
  L.popup({
    closeButton: false,
    minWidth: 260,
    autoPan: true,
    maxHeight: Math.round(mapH2 * 0.7),
  })
    .setLatLng([toMarker.y, toMarker.x])
    .setContent(formHtml)
    .openOn(mmMap);
}

function bindRouteFormEvents(root, ctx) {
  const { fromMarker, toMarker } = ctx;

  const cancelBtn = root.querySelector("#mm-r-cancel");
  const saveBtn = root.querySelector("#mm-r-save");

  if (cancelBtn) {
    cancelBtn.onclick = () => mmMap.closePopup();
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
      mmMap.closePopup();
    };
  }
}

function renderAllRoutes() {
  if (!mmRoutesLayer) return;
  mmRoutesLayer.clearLayers();
  if (!isBigMapActive()) return; // 小地图没有路线概念
  const map = getActiveMap();
  const markerById = Object.fromEntries(map.markers.map((m) => [m.id, m]));
  (map.routes || []).forEach((r) => {
    const from = markerById[r.fromId];
    const to = markerById[r.toId];
    if (!from || !to) return; // 引用的标记已被删除，忽略（不渲染，也不在这里清理数据）
    addLeafletRoute(r, from, to);
  });
}

function addLeafletRoute(route, from, to) {
  const L = window.L;
  const color = colorForFaction(from.faction); // 颜色跟随出发点标记的所属势力

  const headLatLng = pointAlongLine(from, to, 22);
  const angle = computeRouteAngle(from, to);
  const tooltipText = `${from.name} → ${to.name}`;

  const line = L.polyline(
    [
      [from.y, from.x],
      [headLatLng.lat, headLatLng.lng],
    ],
    {
      color,
      weight: 3,
      opacity: 0.85,
    },
  ).addTo(mmRoutesLayer);
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
  }).addTo(mmRoutesLayer);
  head.bindTooltip(tooltipText, { sticky: true });

  const onRouteClick = (e) => {
    L.DomEvent.stopPropagation(e);
    if (confirm(`删除路线"${tooltipText}"？`)) {
      deleteRoute(route.id);
    }
  };
  line.on("click", onRouteClick);
  head.on("click", onRouteClick);
}

function deleteRoute(routeId) {
  const map = getActiveMap();
  if (!Array.isArray(map.routes)) return;
  map.routes = map.routes.filter((r) => r.id !== routeId);
  saveSettings();
  renderAllRoutes();
  renderRouteList();
  scheduleMapInfoSync();
}

function renderRouteList() {
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
      if (from) mmMap.setView([from.y, from.x], mmMap.getZoom());
      toggleMobileSidebar(false);
    });
  });
}

// ============================================================
// 势力管理（全局共用，不区分大/小地图）
// ============================================================

function openFactionManager() {
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

async function clearAllData() {
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
    mmTransientMapData = makeCharacterMapData();
  }
  saveSettings();

  mmMarkersLayer?.clearLayers();
  mmRoutesLayer?.clearLayers();
  if (mmImageOverlay && mmMap) {
    mmMap.removeLayer(mmImageOverlay);
    mmImageOverlay = null;
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

function exportMarkersJson() {
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

function importMarkersJson(e) {
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
function buildRouteSummaryList(bigMap) {
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

function buildSummaryText() {
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
async function syncMapInfoEntry(force = false) {
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
let mmSyncDebounceTimer = null;
function scheduleMapInfoSync(force = false) {
  if (mmSyncDebounceTimer) clearTimeout(mmSyncDebounceTimer);
  mmSyncDebounceTimer = setTimeout(() => {
    mmSyncDebounceTimer = null;
    syncMapInfoEntry(force);
  }, 400);
}

// 切换角色卡时：重新同步该角色的「地图信息」条目；如果弹窗正开着，也要把地图画面刷新成新角色的数据
function registerMapGlobalEvents() {
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

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// =====================================================================================
// 移动端优化模块：默认关闭，可在控制面板里随时开关的两组功能：
//   开关①「渲染/输入优化」= 折叠预设滑块 + 优化输入法弹窗 + 优化长聊渲染
//   开关②「懒加载优化」  = 懒加载头像与角色列表 + 不预载最近聊天页对话
// 开关状态存进 extension_settings（全局设置，随酒馆账号走，不跟随单个角色卡/对话）。
// =====================================================================================

const MOBILE_OPT_SETTINGS_KEY = "plot_assistant_mobile_optimize";
const MOBILE_OPT_LOG_PREFIX = "[剧情助手/移动端优化]";

function getMobileOptSettings() {
  if (!extension_settings[MOBILE_OPT_SETTINGS_KEY]) {
    extension_settings[MOBILE_OPT_SETTINGS_KEY] = {
      renderOptimize: false,
      lazyLoad: false,
    };
  }
  const s = extension_settings[MOBILE_OPT_SETTINGS_KEY];
  if (typeof s.renderOptimize !== "boolean") s.renderOptimize = false;
  if (typeof s.lazyLoad !== "boolean") s.lazyLoad = false;
  return s;
}

// 通用防抖，用于 MutationObserver 回调合并高频 DOM 变化
function mobileOptDebounce(fn, delay) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ------------------------------------------------------------
// 子功能 A1：长聊天渲染优化（content-visibility）
// ------------------------------------------------------------
const MOBILE_OPT_LONG_CHAT_THRESHOLD = 60;
const MOBILE_OPT_OFFSCREEN_BUFFER = "800px 0px 800px 0px";
let longChatState = null;

function initLongChatOptimization() {
  if (longChatState) return;
  if (!("IntersectionObserver" in window)) {
    console.warn(
      `${MOBILE_OPT_LOG_PREFIX} 当前浏览器不支持 IntersectionObserver，长聊天渲染优化未启用`,
    );
    return;
  }
  const chatEl = document.getElementById("chat");
  if (!chatEl) {
    console.warn(
      `${MOBILE_OPT_LOG_PREFIX} 未找到 #chat 容器，长聊天渲染优化未启用`,
    );
    return;
  }

  if (!document.getElementById("lite-opt-long-chat-style")) {
    const style = document.createElement("style");
    style.id = "lite-opt-long-chat-style";
    style.textContent = `
      .lite-opt-long-chat .mes.lite-opt-offscreen {
        content-visibility: auto;
        contain-intrinsic-size: 0 300px;
      }
    `;
    document.head.appendChild(style);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle(
          "lite-opt-offscreen",
          !entry.isIntersecting,
        );
      }
    },
    { root: chatEl, rootMargin: MOBILE_OPT_OFFSCREEN_BUFFER, threshold: 0 },
  );

  function refresh() {
    const mesList = chatEl.querySelectorAll(".mes");
    if (mesList.length < MOBILE_OPT_LONG_CHAT_THRESHOLD) {
      chatEl.classList.remove("lite-opt-long-chat");
      observer.disconnect();
      mesList.forEach((mes) => mes.classList.remove("lite-opt-offscreen"));
      return;
    }
    chatEl.classList.add("lite-opt-long-chat");
    mesList.forEach((mes) => observer.observe(mes));
  }

  const mo = new MutationObserver(mobileOptDebounce(() => refresh(), 120));
  mo.observe(chatEl, { childList: true });
  refresh();

  longChatState = { mo, observer, chatEl };
}

function disableLongChatOptimization() {
  if (!longChatState) return;
  longChatState.mo.disconnect();
  longChatState.observer.disconnect();
  longChatState.chatEl.classList.remove("lite-opt-long-chat");
  longChatState.chatEl
    .querySelectorAll(".mes.lite-opt-offscreen")
    .forEach((mes) => mes.classList.remove("lite-opt-offscreen"));
  longChatState = null;
}

// ------------------------------------------------------------
// 子功能 A2：输入框响应优化（节流 resize）
// ------------------------------------------------------------
let mobileOptInputResponsivenessHandler = null;

function enableInputResponsiveness() {
  if (mobileOptInputResponsivenessHandler) return;
  let lastRun = 0;
  const THROTTLE_MS = 200;
  mobileOptInputResponsivenessHandler = (evt) => {
    const now = Date.now();
    if (now - lastRun < THROTTLE_MS) {
      evt.stopImmediatePropagation();
      evt.stopPropagation();
    } else {
      lastRun = now;
    }
  };
  window.addEventListener("resize", mobileOptInputResponsivenessHandler, true);
}

function disableInputResponsiveness() {
  if (!mobileOptInputResponsivenessHandler) return;
  window.removeEventListener(
    "resize",
    mobileOptInputResponsivenessHandler,
    true,
  );
  mobileOptInputResponsivenessHandler = null;
}

// ------------------------------------------------------------
// 子功能 A3：禁止输入法自动弹出（仅放行真实用户手势触发的 focus）
// ------------------------------------------------------------
const MOBILE_OPT_AUTO_FOCUS_TARGET_SELECTOR =
  "#send_textarea, .mes .edit_textarea, #dialogue_popup textarea";
const MOBILE_OPT_USER_GESTURE_WINDOW_MS = 400;
let mobileOptUserGestureUntil = 0;
let mobileOptOriginalFocus = null;
let mobileOptGestureListenersAttached = false;

function mobileOptMarkUserGesture() {
  mobileOptUserGestureUntil = Date.now() + MOBILE_OPT_USER_GESTURE_WINDOW_MS;
}

function enableBlockAutoFocus() {
  if (!mobileOptGestureListenersAttached) {
    document.addEventListener("pointerdown", mobileOptMarkUserGesture, true);
    document.addEventListener("touchstart", mobileOptMarkUserGesture, true);
    mobileOptGestureListenersAttached = true;
  }
  if (mobileOptOriginalFocus) return;

  mobileOptOriginalFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...args) {
    try {
      if (
        this.matches &&
        this.matches(MOBILE_OPT_AUTO_FOCUS_TARGET_SELECTOR) &&
        Date.now() > mobileOptUserGestureUntil
      ) {
        return;
      }
    } catch (e) {
      // matches() 极少数节点上可能抛错，出错时不拦截，走原生逻辑保证不破坏功能
    }
    return mobileOptOriginalFocus.apply(this, args);
  };
}

function disableBlockAutoFocus() {
  if (mobileOptOriginalFocus) {
    HTMLElement.prototype.focus = mobileOptOriginalFocus;
    mobileOptOriginalFocus = null;
  }
}

// ------------------------------------------------------------
// 子功能 A4：预设界面折叠（一次性 DOM 改造，不做实时还原）
// 关闭开关时只提示"刷新页面后生效"，不做复杂的 DOM 复原逻辑。
// ------------------------------------------------------------
const MOBILE_OPT_PRESET_COLLAPSE_TARGET_IDS = [
  "range_block_openai",
  "wrapper_openai",
];
const MOBILE_OPT_PRESET_COLLAPSE_WRAPPER_ID = "lite-opt-preset-collapse";
let presetCollapseMo = null;
let presetCollapseApplied = false;

function initPresetCollapse() {
  if (presetCollapseMo) return;

  function tryCollapse() {
    const existing = document.getElementById(
      MOBILE_OPT_PRESET_COLLAPSE_WRAPPER_ID,
    );
    const targets = MOBILE_OPT_PRESET_COLLAPSE_TARGET_IDS.map((id) =>
      document.getElementById(id),
    ).filter((el) => el && !existing?.contains(el));

    if (targets.length === 0) return;

    const details = document.createElement("details");
    details.id = MOBILE_OPT_PRESET_COLLAPSE_WRAPPER_ID;
    details.open = false;

    const summary = document.createElement("summary");
    summary.textContent = "预设设置（更多）";
    summary.style.cursor = "pointer";
    summary.style.opacity = "0.8";
    details.appendChild(summary);

    const anchor = targets[0];
    anchor.parentElement.insertBefore(details, anchor);
    targets.forEach((el) => details.appendChild(el));
    presetCollapseApplied = true;
  }

  tryCollapse();
  presetCollapseMo = new MutationObserver(
    mobileOptDebounce(() => tryCollapse(), 120),
  );
  presetCollapseMo.observe(document.body, { childList: true, subtree: true });
}

// 关闭开关时调用：停止继续折叠新出现的预设块；已经折叠过的块提示刷新页面还原
function disablePresetCollapse() {
  if (presetCollapseMo) {
    presetCollapseMo.disconnect();
    presetCollapseMo = null;
  }
  if (presetCollapseApplied) {
    notify("info", "预设折叠效果需要刷新页面才能完全取消。");
    presetCollapseApplied = false;
  }
}

// ------------------------------------------------------------
// 开关① 汇总：渲染/输入优化
// ------------------------------------------------------------
function enableRenderOptimizeGroup() {
  initPresetCollapse();
  enableInputResponsiveness();
  enableBlockAutoFocus();
  initLongChatOptimization();
}

function disableRenderOptimizeGroup() {
  disablePresetCollapse();
  disableInputResponsiveness();
  disableBlockAutoFocus();
  disableLongChatOptimization();
}

// ------------------------------------------------------------
// 子功能 B1：头像缩略图懒加载
// ------------------------------------------------------------
const MOBILE_OPT_AVATAR_SELECTORS = [
  "#rm_print_characters_block .avatar img",
  "#rm_print_characters_block img.avatar",
  ".recent_chat_avatar img",
  "#right-nav-panel .avatar img",
];
const MOBILE_OPT_PLACEHOLDER_SRC =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
  );
let avatarLazyLoadState = null;

function initAvatarLazyLoad() {
  if (avatarLazyLoadState) return;
  const hasIO = "IntersectionObserver" in window;
  if (!hasIO) {
    console.warn(
      `${MOBILE_OPT_LOG_PREFIX} 当前浏览器不支持 IntersectionObserver，头像懒加载未启用`,
    );
  }

  const observer = hasIO
    ? new IntersectionObserver(
        (entries, obs) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const img = entry.target;
            const realSrc = img.dataset.liteSrc;
            if (realSrc) {
              img.src = realSrc;
              delete img.dataset.liteSrc;
            }
            obs.unobserve(img);
          }
        },
        { rootMargin: "400px 0px 400px 0px" },
      )
    : null;

  function processImg(img) {
    if (img.dataset.liteProcessed) return;
    const realSrc = img.getAttribute("src");
    if (!realSrc || realSrc.startsWith("data:")) return;

    img.dataset.liteProcessed = "1";
    img.loading = "lazy";
    img.decoding = "async";

    if (observer) {
      img.dataset.liteSrc = realSrc;
      img.src = MOBILE_OPT_PLACEHOLDER_SRC;
      observer.observe(img);
    }
  }

  function scan() {
    for (const sel of MOBILE_OPT_AVATAR_SELECTORS) {
      document.querySelectorAll(sel).forEach(processImg);
    }
  }

  const mo = new MutationObserver(mobileOptDebounce(() => scan(), 120));
  mo.observe(document.body, { childList: true, subtree: true });
  scan();

  avatarLazyLoadState = { mo, observer };
}

function disableAvatarLazyLoad() {
  if (!avatarLazyLoadState) return;
  avatarLazyLoadState.mo.disconnect();
  if (avatarLazyLoadState.observer) avatarLazyLoadState.observer.disconnect();
  avatarLazyLoadState = null;
  // 已替换为占位图但尚未进入可视区域的 <img> 不做强制复原，
  // 用户滚动到附近或刷新页面时会恢复正常显示，不影响使用。
}

// ------------------------------------------------------------
// 子功能 B2：角色列表整行 content-visibility
// ------------------------------------------------------------
const MOBILE_OPT_CHARACTER_LIST_ROW_SELECTORS = [
  "#rm_print_characters_block .character_select",
  "#rm_print_characters_block .group_select",
];
const MOBILE_OPT_CHARACTER_ROW_BUFFER = "600px 0px 600px 0px";
const MOBILE_OPT_CHARACTER_ROW_THRESHOLD = 20;
let characterListRowState = null;

function initCharacterListRowOptimization() {
  if (characterListRowState) return;
  if (!("IntersectionObserver" in window)) return;

  if (!document.getElementById("lite-opt-char-list-style")) {
    const style = document.createElement("style");
    style.id = "lite-opt-char-list-style";
    style.textContent = `
      .lite-opt-long-list .lite-opt-row-offscreen {
        content-visibility: auto;
        contain-intrinsic-size: 0 60px;
      }
    `;
    document.head.appendChild(style);
  }

  let observer = null;
  function ensureObserver() {
    if (observer) return observer;
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          entry.target.classList.toggle(
            "lite-opt-row-offscreen",
            !entry.isIntersecting,
          );
        }
      },
      { rootMargin: MOBILE_OPT_CHARACTER_ROW_BUFFER, threshold: 0 },
    );
    return observer;
  }

  function refresh() {
    const container = document.getElementById("rm_print_characters_block");
    if (!container) return;
    const rows = MOBILE_OPT_CHARACTER_LIST_ROW_SELECTORS.flatMap((sel) =>
      Array.from(container.querySelectorAll(sel)),
    );

    if (rows.length < MOBILE_OPT_CHARACTER_ROW_THRESHOLD) {
      container.classList.remove("lite-opt-long-list");
      rows.forEach((row) => row.classList.remove("lite-opt-row-offscreen"));
      return;
    }
    container.classList.add("lite-opt-long-list");
    const obs = ensureObserver();
    rows.forEach((row) => obs.observe(row));
  }

  const mo = new MutationObserver(mobileOptDebounce(() => refresh(), 120));
  mo.observe(document.body, { childList: true, subtree: true });
  refresh();

  characterListRowState = { mo, getObserver: () => observer };
}

function disableCharacterListRowOptimization() {
  if (!characterListRowState) return;
  characterListRowState.mo.disconnect();
  const observer = characterListRowState.getObserver();
  if (observer) observer.disconnect();
  const container = document.getElementById("rm_print_characters_block");
  if (container) {
    container.classList.remove("lite-opt-long-list");
    container
      .querySelectorAll(".lite-opt-row-offscreen")
      .forEach((row) => row.classList.remove("lite-opt-row-offscreen"));
  }
  characterListRowState = null;
}

// ------------------------------------------------------------
// 子功能 B3：主页进入聊天优化（不预载角色最近激活的聊天，直接打开点击的那个）
// ------------------------------------------------------------
let welcomeRecentChatClickHandler = null;
let welcomeRecentChatOpenPromise = null;

const MOBILE_OPT_WELCOME_RECENT_CHAT_SELECTOR = ".welcomePanel .recentChat";
const MOBILE_OPT_WELCOME_RECENT_CHAT_ACTION_SELECTOR =
  ".welcomePanel .recentChat .recentChatAction, .welcomePanel .recentChat button, .welcomePanel .recentChat a";

function initWelcomeRecentChatOptimization() {
  if (welcomeRecentChatClickHandler) return;

  let context = null;
  try {
    context = getCtx();
  } catch (e) {
    console.warn(
      `${MOBILE_OPT_LOG_PREFIX} 调用 getContext() 失败，"不预载最近聊天页对话"未启用`,
      e,
    );
    return;
  }
  if (
    !context ||
    typeof context.selectCharacterById !== "function" ||
    !Array.isArray(context.characters)
  ) {
    console.warn(
      `${MOBILE_OPT_LOG_PREFIX} getContext() 未提供所需接口，"不预载最近聊天页对话"未启用`,
    );
    return;
  }

  welcomeRecentChatClickHandler = (event) =>
    handleWelcomeRecentChatClick(event);
  document.addEventListener("click", welcomeRecentChatClickHandler, true);
}

function disableWelcomeRecentChatOptimization() {
  if (!welcomeRecentChatClickHandler) return;
  document.removeEventListener("click", welcomeRecentChatClickHandler, true);
  welcomeRecentChatClickHandler = null;
}

function handleWelcomeRecentChatClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(MOBILE_OPT_WELCOME_RECENT_CHAT_ACTION_SELECTOR))
    return;

  const item = target.closest(MOBILE_OPT_WELCOME_RECENT_CHAT_SELECTOR);
  if (!(item instanceof HTMLElement)) return;

  const avatarId = item.getAttribute("data-avatar");
  const groupId = item.getAttribute("data-group");
  const fileName = item.getAttribute("data-file");

  if (!avatarId || !fileName || groupId) return;

  const context = getCtx();
  const characterId = context.characters.findIndex(
    (c) => c?.avatar === avatarId,
  );
  if (characterId === -1) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  if (welcomeRecentChatOpenPromise) return;
  welcomeRecentChatOpenPromise = openWelcomeRecentChatDirectly(
    characterId,
    fileName,
  )
    .catch((e) => console.error(`${MOBILE_OPT_LOG_PREFIX} 打开最近聊天失败`, e))
    .finally(() => {
      welcomeRecentChatOpenPromise = null;
    });
}

async function openWelcomeRecentChatDirectly(characterId, fileName) {
  const context = getCtx();
  const character = context.characters[characterId];
  if (!character) return;

  if (String(context.characterId) === String(characterId)) {
    if (
      typeof context.getCurrentChatId === "function" &&
      context.getCurrentChatId() === fileName
    ) {
      return;
    }
    await context.openCharacterChat(fileName);
    return;
  }

  const previousChat = character.chat;
  character.chat = fileName;

  await context.selectCharacterById(characterId);

  const contextAfter = getCtx();
  if (String(contextAfter.characterId) !== String(characterId)) {
    if (character.chat === fileName && previousChat !== fileName) {
      character.chat = previousChat;
    }
    return;
  }

  if (
    typeof contextAfter.getCurrentChatId === "function" &&
    contextAfter.getCurrentChatId() !== fileName
  ) {
    await contextAfter.openCharacterChat(fileName);
  }
}

// ------------------------------------------------------------
// 开关② 汇总：懒加载优化
// ------------------------------------------------------------
function enableLazyLoadGroup() {
  initAvatarLazyLoad();
  initCharacterListRowOptimization();
  initWelcomeRecentChatOptimization();
}

function disableLazyLoadGroup() {
  disableAvatarLazyLoad();
  disableCharacterListRowOptimization();
  disableWelcomeRecentChatOptimization();
}

// ------------------------------------------------------------
// 启动时根据已保存设置应用两个开关（默认都是 false，不会自动开启）
// ------------------------------------------------------------
function applyMobileOptSettingsOnLoad() {
  const s = getMobileOptSettings();
  if (s.renderOptimize) enableRenderOptimizeGroup();
  if (s.lazyLoad) enableLazyLoadGroup();
}

// === Initialization ===
jQuery(() => {
  console.log("[剧情助手] 初始化...");
  createMenuButton();
  registerLorebookAutoCreate();
  registerStatusTableAutoUpdate();

  // --- 移动端优化模块 ---
  applyMobileOptSettingsOnLoad(); // 默认关闭，只有之前手动开启过才会在这里生效

  // --- 通讯器（手机）悬浮窗模块 ---
  injectPhoneFloatingButton(); // 默认关闭，只有之前手动开启过才会在这里显示出来
  registerPhoneSlotInjection(); // 私信槽位：生成前注入当天新私信，生成后立即清空

  // --- 地图标记模块 ---
  getSettings(); // 确保当前角色（或临时）的地图数据结构已就绪
  injectFloatingButton();
  registerMapGlobalEvents();
  // 插件刚加载时如果已经在某个角色的聊天里，主动同步一次「地图信息」条目，不用等切换聊天才触发；
  // 延迟一下给酒馆本身留出初始化时间，跟世界书自动创建那边的 1500ms 错开，避免同时抢着读写世界书。
  delay(1600).then(() => syncMapInfoEntry(false));

  notify("info", "初始化完成，可从扩展菜单中打开「剧情助手」。");
  console.log("[剧情助手] 初始化完成。");
});
