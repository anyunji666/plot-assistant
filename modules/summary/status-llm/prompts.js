"use strict";

// =====================================================================================
// === 状态表LLM 默认提示词 ===
// 从原"对话前强调"协议里拆出来的 Inventory / Setups 两段判定规则，
// 剧情LLM不再输出这两个字段，改由本模块独立调用一次AI，从刚渲染完的那一层正文里提取。
// 内容/措辞可在"状态表配置"弹窗里自定义修改（比如遇到截断/拒绝时调整表述），
// 这里的常量只作为"恢复默认"按钮的兜底值。
// =====================================================================================
export const DEFAULT_STATUS_LLM_PROMPT = `### 任务
你是"状态表维护助手"，只负责在 <latest_floor> 标签包裹的最新故事正文（以及可能一并附上的 <private_letter> 标签包裹的当日私信）中，提取 Inventory（物品）和 Setups（伏笔/线索/约定）等项的本轮变化，不涉及未要求字段，也不需要评价、总结或复述正文内容。

已注入的 <snapshot_table> 标签内容是故事发展至当前的状态快照表，仅供你查看现状，分析Inventory/Setups等需要改动的过期条目，<snapshot_table>不需要你输出。

---
**输出格式：**
输出以下行，不要输出任何其它文字、标签、解释或前后缀说明：
\`\`\`
Inventory: \${本轮变化，规则见下，无变化则只输出 Inventory: }
Setups: \${本轮变化，规则见下，无变化则只输出 Setups: }
\`\`\`

---
**字段判定规则（伪代码）：**

**Inventory**（只写本轮变化，多组分号分隔，按顺序执行）
\`\`\`
for 道具变化 in 本轮:
    if not 可随身携带的物品: 跳过  # 状态/情形不记录
    if 全部用尽/全部送出/丢失: 值 = [REMOVE]
    elif 首次记录/需硬修正历史值: 值 = "=N"
    elif 得到/获得/新增: 值 = "+N"
    elif 部分消耗/部分送出(未归零): 值 = "-N"
# 格式：角色名·物品名: 值；（物品名可按需附加单位，如"玉佩（块）""金创药（瓶）"）
# 值只能是[REMOVE]/=N/+N/-N，N为纯数字，单位一律写进物品名、不要混进值里。正例："+2" "=3"　反例："+2瓶" "=3个(备用)"
\`\`\`

**Setups**（只写本轮变化，多组分号分隔，按顺序执行）
\`\`\`
Step1 存量清理：旧条目已兑现/作废/不可能再被拾起 → 角色名·关键词: [REMOVE]
Step2 新增：本轮正文及 <private_letter name="角色名"> 标签包裹的当日私信中，是否出现值得长线追踪的伏笔/线索/未解约定？
    以下情况不记录：
      - 单纯的意图/打算（"她想...""他计划..."）不记 → 需要记录的是已发生的事实
      - 单纯关系状态变化 / 纯事件叙述 / 本轮内已解决的伏笔
Step3 格式：角色名·关键词: (日期·地点)+一句话钩子；（日期具体到年月日，整体不超30字）
\`\`\`

---
**示例（仅供格式参考）：**
\`\`\`
Inventory: {{user}}·玉佩（块）: =1；{{user}}·金创药（瓶）: -1；{{user}}·解药: [REMOVE]
Setups: {{user}}·玉佩纹路之谜: (武定三年三月十五·云隐山洞穴)背面刻着一行字,含义不明；角色A·旧日承诺: [REMOVE]
\`\`\``;

// =====================================================================================
// === 附加字段：动态拼接进状态表LLM系统提示词 ===
// 面板"附加字段"里新增的每条定义都会在这里生成一段输出格式行 + 一段判定规则，
// 追加在 DEFAULT_STATUS_LLM_PROMPT（或用户自定义的覆盖版本）后面，两者不冲突——
// 基础协议负责 Inventory/Setups，这里只负责"此外还要多输出哪些字段"。
// =====================================================================================

// === Helper: 按 valueType(numeric/text) × scope(character/global) 四种组合各生成一段判定规则 ===
function buildCustomFieldRuleBlock(field) {
  const ruleText =
    (field.rule || "").trim() ||
    "（未填写提取依据说明，请根据字段名自行判断本轮是否有相关变化）";

  if (field.scope === "character") {
    if (field.valueType === "numeric") {
      return `**${field.name}**（角色维度·数值，只写本轮变化，多个角色分号分隔）
\`\`\`
for 角色 in 本轮${field.name}有变化的角色:
    if 需要清除该角色本项记录: 值 = [REMOVE]
    elif 首次记录/需硬修正历史值: 值 = "=N"
    elif 增加: 值 = "+N"
    elif 减少(未归零): 值 = "-N"
# 格式：角色名: 值；
# 值只能是[REMOVE]/=N/+N/-N，N为纯数字
# 提取依据：${ruleText}
\`\`\``;
    }
    return `**${field.name}**（角色维度·文本，只写本轮变化，多个角色分号分隔）
\`\`\`
Step1 存量清理：旧值已过期/不再适用 → 角色名: [REMOVE]
Step2 新增/更新：角色名: 新文本值（整条覆盖旧值，不是追加）
# 格式：角色名: 值；
# 提取依据：${ruleText}
\`\`\``;
  }

  // scope === "global"：不分角色，整个字段只有一个值，值本身就是内容（不需要 "key: value" 结构）
  if (field.valueType === "numeric") {
    return `**${field.name}**（全局·数值，不分角色，只有一个值）
\`\`\`
if 需要清除: 值 = [REMOVE]
elif 首次记录/需硬修正: 值 = "=N"
elif 增加: 值 = "+N"
elif 减少(未归零): 值 = "-N"
# 值只能是[REMOVE]/=N/+N/-N，N为纯数字，不需要"角色名:"前缀
# 提取依据：${ruleText}
\`\`\``;
  }
  return `**${field.name}**（全局·文本，不分角色，只有一个值）
\`\`\`
if 需要清除: 值 = [REMOVE]
elif 有更新: 值 = 新文本值（整条覆盖旧值，不是追加），不需要"角色名:"前缀
# 提取依据：${ruleText}
\`\`\``;
}

// === Function: 生成"附加字段"整段附录文本，customFields 为空数组时返回空字符串（不影响原有提示词）===
export function buildCustomFieldsAppendix(customFields) {
  if (!Array.isArray(customFields) || customFields.length === 0) return "";

  const outputLines = customFields
    .map((f) => `${f.name}: \${本轮变化，规则见下，无变化则只输出 ${f.name}: }`)
    .join("\n");
  const ruleBlocks = customFields.map(buildCustomFieldRuleBlock).join("\n\n");

  return `

---
**附加字段（在上面 Inventory/Setups 两行之后继续追加输出，每个字段单独一行，同样"只写本轮变化"）：**
\`\`\`
${outputLines}
\`\`\`

**附加字段判定规则：**

${ruleBlocks}`;
}

// === Function: 拼出状态表LLM最终系统提示词 = 基础协议（默认或用户自定义覆盖）+ 附加字段 ===
// 优先"融合式"拼接：把附加字段的输出行插进第一个代码块（跟Inventory/Setups同一块），
// 判定规则插在Setups规则块之后、"---\n**示例"之前（跟Inventory/Setups同一份规则列表），
// 让LLM看到的是一份结构统一的协议，而不是"主协议+外挂说明"式的两段式结构，理解和执行起来更直接。
//
// 融合依赖基础协议遵循默认格式的两个锚点：①第一个围栏代码块=输出格式行所在处；
// ②"\n---\n**示例"=判定规则区结尾。用户如果在"状态表配置"弹窗把自定义提示词改得
// 面目全非（比如删掉了示例区、换了别的标题），这两个锚点可能找不到——这时候不强行拼、
// 也不报错，安全退回旧的"整体追加在最后"方案（buildCustomFieldsAppendix），
// 保证不管自定义提示词写成什么样，附加字段的内容都不会丢，只是退化成外挂式的展示。
function spliceOutputLines(base, outputLines) {
  const codeBlockRe = /```\n[\s\S]*?\n```/;
  const match = codeBlockRe.exec(base);
  if (!match) return null;
  const insertPos = match.index + match[0].length - "\n```".length;
  return base.slice(0, insertPos) + "\n" + outputLines + base.slice(insertPos);
}

function spliceRuleBlocks(base, ruleBlocksText) {
  const marker = /\n\n---\n\*\*示例/;
  const match = marker.exec(base);
  if (!match) return null;
  const insertPos = match.index + 1; // 保留原有那一个换行符作为跟上一个规则块之间的空行
  return base.slice(0, insertPos) + "\n" + ruleBlocksText + base.slice(insertPos);
}

export function buildStatusLlmSystemPrompt(customPromptOverride, customFields) {
  const base = customPromptOverride?.trim() || DEFAULT_STATUS_LLM_PROMPT;
  const fields = customFields || [];
  if (fields.length === 0) return base;

  const outputLines = fields
    .map((f) => `${f.name}: \${本轮变化，规则见下，无变化则只输出 ${f.name}: }`)
    .join("\n");
  const ruleBlocksText = fields.map(buildCustomFieldRuleBlock).join("\n\n");

  const withOutput = spliceOutputLines(base, outputLines);
  const withRules = withOutput !== null ? spliceRuleBlocks(withOutput, ruleBlocksText) : null;
  if (withRules !== null) return withRules;

  // 融合失败，安全退回：用原始 base（不是 withOutput，避免只融合了一半的中间态），整体追加在最后
  return base + buildCustomFieldsAppendix(fields);
}
