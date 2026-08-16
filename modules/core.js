"use strict";

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
export const AUTO_BATCH_SIZE = 30; // 自动小总结每批楼层数

export const SMALL_SUMMARY_TITLE_PREFIX = "小总结："; // 小总结世界书条目标题前缀，后面拼接"起-止"楼层号

export const LARGE_SUMMARY_TITLE = "大总结"; // 大总结世界书条目固定标题

export const PRE_EMPHASIS_TITLE = "对话前强调"; // 对话前强调世界书条目固定标题

export const MAP_INFO_TITLE = "地图信息"; // 地图标记模块自动生成/覆盖的世界书条目固定标题，跟其他总结条目同级存在

// 地图信息条目的插入位置：同样是"@D [系统]在深度"（position:4=atDepth，role:0=SYSTEM），
// 但深度给1（比状态表/同人章节的深度0更靠前一点）、order给100（比同人章节的500更靠前），
// 因为地图信息相对没那么需要紧贴最新消息。只在"首次创建"该条目时生效——已存在的条目
// saveOrOverwriteLorebookEntry 只更新标题/内容，不会覆盖你已经手动调整过的位置设置。
export const MAP_INFO_ENTRY_DEFAULTS = {
  position: 4, // 原生 world_info_position: atDepth
  depth: 1,
  role: 0, // extension_prompt_roles: SYSTEM
  order: 100,
  probability: 100,
};

export const PHONE_PRESET_TITLE = "私信预设"; // 手机私信开场白预设世界书条目固定标题，跟角色卡条目一样 disable:true 常驻、不参与主线注入，插件直接读取内容使用

// "私信预设"条目首次创建前用于预填编辑框的默认内容——手机私信生成提示词里唯一可编辑的部分（开场白/扮演指令），
// 其余结构（人设/最新正文/私信历史块）和输出格式要求都写死在代码里，不放进这段可编辑文本。
// "联系人"是占位符，实际调用时会被替换成真实联系人姓名。
export const DEFAULT_PHONE_PRESET_CONTENT = `请你在<private_letter name="联系人">中扮演联系人和{{user}}聊天，注意俩人当前关系，口吻参考角色性格背景。`;

// 对话前强调条目的默认位置设置：@D 在深度0、order 999、概率100%，仅在条目首次创建时生效；
// 已存在的条目只更新标题/内容/启用状态，
// 不会覆盖你之后在世界书面板里手动调整过的位置/深度等设置。
export const PRE_EMPHASIS_ENTRY_DEFAULTS = {
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
export const DEFAULT_PRE_EMPHASIS_CONTENT = `### [MANDATORY] Summary Output Protocol
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
Busy: \${仅当<snapshot_table>标签内Busy列表角色本轮未出现或拿“通讯器”回复消息时才输出，格式见下方Busy规则}
ExpiredChapter: \${仅当前文含有<expired_chapter_instruction>规则，且判定该章节已完整演绎/过时时才输出，无该规则或未判定过时则忽略此字段}
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
        # 阶段词：陌生 / 相识 / 相熟 / 好感 / 暧昧 / 亲密 / 恋人 / 未婚夫妻 / 夫妻 / 对手 / 仇人 / 宿敌 / 同伴 / 盟友 / 朋友 / 挚友
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
Step2 新增：本轮及<private_letter name="角色名">包裹的私信中是否出现值得长线追踪的伏笔/线索/约定？
    以下情况不记录：
      - 单纯的意图/打算（"她想...""他计划..."）不记 → 需要记录的是已发生的事实
      - 单纯关系状态变化(归Relationships) / 纯事件叙述(归Overview) / 本轮内已解决的伏笔(归Overview)
Step3 格式：角色名·关键词: (日期·地点)+一句话钩子；（日期具体到年月日，整体不超30字）
\`\`\`

**Busy**（Busy条目唯一要做的是添加[REMOVE]标记，清除本轮未出现或拿起“通讯器”查看并回复消息的角色，多组分号分隔）
\`\`\`
for 角色 in 已注入的<snapshot_table>标签内Busy列表:
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
**Snapshot Table**：<snapshot_table>标签包裹的是上文已注入的只读快照表，仅供查看当前状态、判断哪些条目需要在对应字段填[REMOVE]清除，具体判定规则见上方各字段说明。

---
**示例（仅供格式参考）：**
\`\`\`
---
<details><summary>摘要</summary>
Time: 武定三年三月十五,申时
Location: 云隐山洞穴
Relationships: {{user}}→角色A: 恋人；{{user}}→角色B: 师徒(暧昧)；{{user}}→角色C: [REMOVE]
Inventory: {{user}}·玉佩（块）: =1；{{user}}·金创药（瓶）: -1；{{user}}·解药: [REMOVE]；
Setups: {{user}}·玉佩纹路之谜: (武定三年三月十五·云隐山洞穴)背面刻着一行字,含义不明；角色A·旧日承诺: [REMOVE]
Overview: {{user}}向角色A表明心意确定恋人关系；与角色B切磋加深师徒情谊；拾得来历不明玉佩；服下最后一瓶解药；角色C战死永久离场。
</details>
\`\`\``;

export const GENERATION_TIMEOUT = 300000; // 5分钟生成超时时间

export const STEP_DELAY = 300; // 批次之间的延迟（毫秒）

export const STATUS_TABLE_TITLE = "状态表"; // 结构化数据表世界书条目固定标题，与"小总结：起-止""大总结"同级存在

// 状态表要让AI记住"当前"状态，离最新消息越近权重越高，所以创建时用"@D 在深度"而不是小总结/大总结默认的"角色定义之前"。
// 对应你在世界书面板里手动设置好的参照值：@D 在深度0、[系统]角色、order 666、概率100%。
export const STATUS_TABLE_ENTRY_DEFAULTS = {
  position: 4, // 原生 world_info_position: atDepth
  depth: 0,
  role: 0, // extension_prompt_roles: SYSTEM
  order: 666,
  probability: 100,
};

// 小总结条目的默认位置设置：用"@D 在深度"，深度定得比状态表深一点（深度6）。
// 触发方式为条件触发（非常驻），靠世界书自身的关键词匹配机制决定是否注入，
// 缓解长上下文里"始终存在"的条目被模型降权关注的问题。
export const SMALL_SUMMARY_ENTRY_DEFAULTS = {
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
export const CHARACTER_ENTRY_TITLE_PREFIX = "角色卡：";

// 角色卡条目走关键词触发（selective），不是常驻类型：constant:false + key 数组即可，不需要额外的 position/depth 覆盖，
// 用 saveOrOverwriteLorebookEntry 的默认位置（角色定义之前）就够了，只单独给一个 order，避免和其他常驻条目抢排序。
export const CHARACTER_ENTRY_DEFAULTS = {
  order: 100,
  probability: 100,
};

// 章节条目标题前缀，后面拼接章节名，与"小总结：""大总结""状态表""对话前强调""地图信息""角色卡："
// 同级存在于同一本总结世界书；用于录入原著章节名+概述（供 AI 查阅参考的原著内容，而非同人创作正文本身），
// 让 AI 有据可查，而不是凭记忆回忆原著细节。
export const NOVEL_ENTRY_TITLE_PREFIX = "原著章节：";

// 写在 <chapter_reference> 标签内、概述正文之前的默认提示词，告诉 AI 这段是原著剧情概述、
// 供演绎时参考而非照抄；新建/编辑章节条目时自动拼在概述前面，不需要每次手动打字。
export const NOVEL_CHAPTER_REFERENCE_PROMPT =
  "以下是原著小说的章节概述，仅供你在演绎时参考背景与走向，需结合实际情况自然演绎：";

// 章节条目不走世界书原生引擎注入（不依赖挂载/深度/token 预算），只作为数据仓库存在：
// disable 固定为 true、constant 固定为 false、key 固定为空数组——世界书原生引擎在任何情况下
// （哪怕这本书被挂载为全局世界书）都不会扫描/触发这条条目。"当前激活哪一章"和"是否注入"
// 完全由插件自己在生成前通过 setExtensionPrompt 直接读取内容并发送（见 NOVEL_CHAPTER_PROMPT_KEY），
// 与状态表/小总结等仍依赖世界书原生引擎的条目类型不同。
// position 显式设为 0（原生 world_info_position: 角色定义之前）、触发策略为关键词（constant:false）——
// 虽然这条目实际上永远不会被原生引擎扫描到，但显式写死这两项，而不是依赖 saveWorldInfo 的隐式默认值，
// 保证条目在原生世界书面板里呈现的样式稳定、不随酒馆版本更新而变化。
export const NOVEL_ENTRY_DEFAULTS = {
  position: 0, // 原生 world_info_position: 角色定义之前
  order: 100,
  probability: 100,
};

// === 剧情录入·自动跳转章节 相关常量 ===
// 开关状态存进 extension_settings（全局设置，随酒馆账号走），默认关闭；
// 面板"剧情录入"按钮右侧的"自跳转开/自跳转关"按钮读写这个 key。
export const NOVEL_AUTO_JUMP_SETTINGS_KEY = "plot_assistant_novel_auto_jump";

// "当前激活章节"指针存进 extension_settings，按世界书名分组：{ [lorebookName]: uid }。
// 不再借用世界书条目的 disable 字段表示"当前章节"——章节条目的 disable 现在固定为 true，
// 纯粹是数据仓库，不参与任何原生注入判断。面板下拉框"当前注入章节"读写的就是这个 key。
export const NOVEL_ACTIVE_CHAPTER_SETTINGS_KEY = "plot_assistant_novel_active_chapter";

// 章节内容 + 判定指令合并注入用的 extension prompt key，用法跟 PHONE_SLOT_PROMPT_KEY 一样：
// 只在"当前有激活章节"时生成前临时注入、AI 渲染完这一轮后立即清空，不写进世界书、不常驻。
// 章节内容本身（<chapter_reference>）与 EXPIRED_CHAPTER_INSTRUCTION 拼在同一段文本里、
// 用同一次 setExtensionPrompt 调用发送，保证两者位置完全一致。
export const NOVEL_CHAPTER_PROMPT_KEY = "plotAssistant_novelChapterPrompt";

// 摘要块里新增字段的标签名，跟 Busy 字段是同一种"仅触发时才输出"的写法。
export const EXPIRED_CHAPTER_FIELD_LABEL = "ExpiredChapter";

// 生成前注入给 AI 的判定指令原文：要求 AI 结合已注入的 <chapter_reference chapter="章节名"> 标签自行判断
// 当前章节是否已经演绎完/过时，并在摘要块里用 ExpiredChapter 字段回报，报的章节名需要跟 chapter 属性一致，
// 插件才能精确核对是"针对哪一章"的信号。要求写在 Overview 字段之前——Overview 字段的解析正则会贪婪吃到
// 字符串末尾（跟 Busy 字段必须写在 Overview 前面是同一个原因），写在后面会被吞进 Overview 文本里。
export const EXPIRED_CHAPTER_INSTRUCTION =
  '<expired_chapter_instruction>\n参考已注入的 <chapter_reference chapter="章节名"> 标签，若你判断该章节内容已被正文完整演绎或已过时无参考价值，则在摘要块追加 `ExpiredChapter: {与chapter属性一致的章节名}`；否则该字段留空。该字段需写在 Overview 字段之前的独立一行。\n</expired_chapter_instruction>';

// === 手机（通讯器）私信系统相关常量 ===
// 本地对话缓存（LOCAL_CHAT_STORE_KEY）里存放"忙/闲判定缓存 + 待注入私信槽位标记"的 key，
// 跟起始楼层偏移量同一套持久化方式（浏览器本地存储），按"角色卡+对话文件"区分，换对话/换角色卡互不干扰。
export const PHONE_CHAT_META_KEY = "plotAssistant_phoneChatState";

// 私信正文本地库（IndexedDB），跟地图图片库（mm_map_marker_db）是两个独立的库，互不影响。
export const PHONE_IDB_NAME = "plot_assistant_phone_db";

export const PHONE_IDB_STORE = "messages";

// 头像库：key 按"当前角色卡::联系人名"存一张压缩后的 dataURL，换角色卡不互相影响。
export const PHONE_AVATAR_STORE = "avatars";

// 图片库（原"表情包"）：不分联系人/角色卡，全局公用一份，整份列表存在同一个 key 下（数量不大，不用建索引）。
export const PHONE_STICKER_STORE = "stickers";

export const PHONE_STICKER_LIST_KEY = "list";

// 背景库：分两类共用一个 store——
//   全局背景（通讯录/动态/设置三页共用）存在固定 key 下；
//   聊天页背景按"当前角色卡::联系人名"分别存，换角色卡/换联系人互不影响，跟头像库同一套 key 规则。
export const PHONE_BACKGROUND_STORE = "backgrounds";

export const PHONE_GLOBAL_BACKGROUND_KEY = "__global__";

// 私信槽位注入正文时用的 extension prompt key，平时为空，只有"今天有新私信"时临时写入内容，
// AI 生成完这一轮后立即清空（一次性注入，不常驻）。
export const PHONE_SLOT_PROMPT_KEY = "plotAssistant_phoneSlot";

// 背包页手动改动库存后，下一轮生成前一次性提醒正文AI"请在摘要模块Inventory字段里同步这些变化"的注入key，
// 用法跟 PHONE_SLOT_PROMPT_KEY 一样：生成前注入、渲染完清空，不常驻。
export const PHONE_INVENTORY_PROMPT_KEY = "plotAssistant_inventoryChangeSlot";

// === 星期/节假日播报 相关常量已迁移到 modules/holiday/inject.js（独立模块，自带开关/自带 prompt key）===

export const SUMMARY_BUTTON_ID = "summary-assistant-menu-button";

export const SUMMARY_BUTTON_ICON = "fa-solid fa-book";

export const SUMMARY_BUTTON_TOOLTIP = "剧情助手";

export const SUMMARY_BUTTON_TEXT = "剧情助手";

export const SUMMARY_POPUP_ID = "summary-assistant-popup";

export const GENERATING_OVERLAY_ID = "summary-assistant-generating-overlay";

// 起始楼层（原"接续小总结"的偏移量）：持久化存在浏览器本地（localStorage），按"角色卡+对话文件"
// 区分不同对话，重开同一个对话不会丢，换到别的对话也不会互相干扰；只有你再次点击"设定起始楼层"
// 并确认新值时才会覆盖。注意：这是存在浏览器本地的，换浏览器/清浏览器数据/控制面板里点"清空数据"都会丢，
// 不跟着对话文件本身走（不会随导出/分享对话文件带走）。
// 语义：本对话新写入的小总结，世界书楼层号从这个值开始编号。默认/未设置视为 0（不偏移）。
export const OFFSET_META_KEY = "plotAssistant_summaryOffset";

// === Helper: 获取酒馆原生 context（每次都取最新的，避免切换角色/对话后引用过期） ===
export function getCtx() {
  return SillyTavern.getContext();
}

// === Helper: 取"最后一层 AI 楼层"的索引与正文，找不到返回 idx=-1 ===
// 通用基础设施：单纯扫描 chat 数组找最后一条 is_user 为 false 的消息，跟具体功能模块无关，
// 供手机私信、节假日播报、状态表重放等多个模块共用，避免各自重复实现。
export function getLastAiFloor() {
  const chat = getCtx().chat;
  if (!Array.isArray(chat)) return { idx: -1, mes: "" };
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i] && !chat[i].is_user) return { idx: i, mes: chat[i].mes || "" };
  }
  return { idx: -1, mes: "" };
}

// === Helper: HTML 转义（各模块拼接 innerHTML 时统一用这个，避免各写各的）===
// 用 ?? "" 兜底 null/undefined，同时转义单引号，兼容"值可能为空"以及"属性用单引号包裹"两种场景，
// 是原先 map/data.js 版本（不转义单引号）和 phone/ui.js 版本（不兜底 null）两者的合并/加强版。
export function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
}

// === Helper: 提示条 ===
export function notify(type, message) {
  const text = `[剧情助手] ${message}`;
  if (typeof toastr !== "undefined" && typeof toastr[type] === "function") {
    toastr[type](text);
  } else {
    console.log(`[剧情助手][${type}]`, message);
  }
}

// === Helper: "自动小总结"手动停止时用来提前中断当前批次内层循环的信号类 ===
// 与普通生成失败区分开：捕获到这个错误时不应弹出失败提示，而是按"用户主动停止"处理。
export class SummaryStopRequestedError extends Error {
  constructor() {
    super("已被用户手动停止。");
    this.name = "SummaryStopRequestedError";
  }
}

// === Helper: 错误捕获包装 ===
export function errorCatched(fn) {
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
export const LOCAL_CHAT_STORE_KEY = "plotAssistant_localChatStore";

export let localChatStoreCache = null; // 惰性加载：整份 JSON 只解析一次，后续都在内存里改，改完整份写回

export let transientChatMetadataStore = null; // 拿不到稳定 key（比如没选中角色卡）时的内存兜底，不持久化

// 从 localStorage 读整份本地对话缓存到内存，只在第一次调用时真正解析 JSON
export function loadLocalChatStore() {
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
export function getStableChatKey() {
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
export function getChatMetadataStore() {
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
export async function persistChatMetadata() {
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
export function getOffsetRecord() {
  const store = getChatMetadataStore();
  const record = store[OFFSET_META_KEY];
  if (!record || typeof record.offset !== "number" || isNaN(record.offset))
    return null;
  return record;
}

// === Helper: 设定/覆盖"本对话"的起始楼层（每次点"设定起始楼层"并确认后调用，属于用户主动操作）===
export async function setOffsetRecord(offset) {
  const store = getChatMetadataStore();
  store[OFFSET_META_KEY] = { offset, updatedAt: Date.now() };
  await persistChatMetadata();
}

// === Helper: Delay Function ===
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// === Helper: 统一的"功能说明 + 确认"弹窗（原生 Popup），三个总结按钮点击后的第一步 ===
export async function confirmAction(title, messageHtml) {
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
