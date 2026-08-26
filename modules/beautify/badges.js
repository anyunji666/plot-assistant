"use strict";

// =====================================================================================
// 摘要卡片美化 - Relationships 关系词 → 徽章分级配色表。
// 词表照抄 core.js 里 DEFAULT_PRE_EMPHASIS_CONTENT 协议原文的三张表（身份词/血亲词/阶段词），
// 保持跟"对话前强调"协议同步，协议表以后如果增删词，这里也要跟着改。
// 一个关系值允许两种合法形式（跟 parser.js isValidRelationshipWord 的校验口径一致）：
//   (a) 纯裸词：阶段词，或身份词/血亲词
//   (b) 身份/血亲词 + 括号阶段词，如"师徒(暧昧)"——此时按括号里的阶段词上色，
//       因为阶段词才反映"当前实际关系温度"，身份词本身只是关系类型，不代表亲疏。
// =====================================================================================

export const IDENTITY_WORDS = [
  "师徒", "师兄弟", "师兄妹", "师姐妹", "师姐弟", "义兄弟", "义兄妹", "义姐妹", "义姐弟",
  "同门", "同学", "同事", "邻居", "网友", "战友", "上下级", "继父子", "继父女", "继母子",
  "继母女", "主仆", "学长学弟", "学长学妹", "学姐学弟", "学姐学妹", "师生", "校友", "室友",
  "甲乙方", "合伙人", "医患", "队友", "教练学员", "房东租客", "粉丝偶像",
];

export const BLOOD_WORDS = [
  "父女", "父子", "母女", "母子", "兄弟", "兄妹", "姐弟", "姐妹", "祖孙", "叔侄", "舅甥",
  "姑侄", "姨甥", "表兄弟", "表兄妹", "表姐弟", "表姐妹", "堂兄弟", "堂兄妹", "堂姐弟", "堂姐妹",
];

// 阶段词按"关系温度"分成四组，各组对应一种徽章配色（粉色系内部再按顺序渐深）。
export const STAGE_GROUPS = {
  distant: ["陌生", "相识"], // 灰蓝：还没什么感情基础
  warm: ["相熟", "好感", "暧昧", "亲密", "恋人", "未婚夫妻", "夫妻"], // 粉色渐深：暧昧升温到婚姻
  friendly: ["同伴", "盟友", "朋友", "挚友"], // 中性偏暖：正向但非爱情
  hostile: ["对手", "仇人", "宿敌"], // 冷色/警示：敌对关系
};

// warm 组内部按顺序位置再细分深浅（index 越大颜色越深）
const WARM_COLOR_STEPS = [
  { bg: "#FFE5F0", fg: "#C86A8A", border: "#FFD0E2" }, // 相熟
  { bg: "#FFDCE8", fg: "#C05B7D", border: "#FFC5DA" }, // 好感
  { bg: "#FFD0E0", fg: "#B84E71", border: "#FFB8D0" }, // 暧昧
  { bg: "#FFC3D5", fg: "#B04066", border: "#FFA8C4" }, // 亲密
  { bg: "#FFB0C8", fg: "#A8385C", border: "#FF98B8" }, // 恋人
  { bg: "#FF9FBC", fg: "#9E2E52", border: "#FF88AC" }, // 未婚夫妻
  { bg: "#FF8CAE", fg: "#962648", border: "#FF74A0" }, // 夫妻
];

const DISTANT_COLOR = { bg: "#E8DFF5", fg: "#4A3A5A", border: "#DCCEEE" };
const FRIENDLY_COLOR = { bg: "#E0F2E8", fg: "#2A5A3A", border: "#CDEBD9" };
const HOSTILE_COLOR = { bg: "#FFD4D8", fg: "#A83848", border: "#FFBFC5" };
const IDENTITY_COLOR = { bg: "#FFF0E0", fg: "#8A5A2A", border: "#FFE2C2" };
const NEUTRAL_COLOR = { bg: "#F0EDEB", fg: "#6A6058", border: "#E2DCD7" };

// === Helper: 单个阶段词 → 配色 ===
function colorForStageWord(word) {
  if (STAGE_GROUPS.distant.includes(word)) return DISTANT_COLOR;
  if (STAGE_GROUPS.friendly.includes(word)) return FRIENDLY_COLOR;
  if (STAGE_GROUPS.hostile.includes(word)) return HOSTILE_COLOR;
  const warmIdx = STAGE_GROUPS.warm.indexOf(word);
  if (warmIdx !== -1) return WARM_COLOR_STEPS[warmIdx];
  return null;
}

// === Helper: 解析"身份词(阶段词)"或纯裸词，返回 { label, color }；识别不出的词给中性色兜底，不报错 ===
export function classifyRelationshipValue(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) return null;

  // 兼容全角/半角括号
  const bracketMatch = value.match(/^(.+?)[（(]([^）)]+)[）)]$/);
  if (bracketMatch) {
    const base = bracketMatch[1].trim();
    const stage = bracketMatch[2].trim();
    const stageColor = colorForStageWord(stage);
    if (stageColor) return { label: value, color: stageColor };
    // 阶段词部分识别不出时，退回按身份/血亲词本身上色
  }

  const baseWord = bracketMatch ? bracketMatch[1].trim() : value;
  if (IDENTITY_WORDS.includes(baseWord) || BLOOD_WORDS.includes(baseWord)) {
    return { label: value, color: IDENTITY_COLOR };
  }

  const stageColor = colorForStageWord(value);
  if (stageColor) return { label: value, color: stageColor };

  // 表外词（理论上不该出现，因为状态表合并时已经校验过，但楼层摘要原文本身没强制校验）：中性色兜底
  return { label: value, color: NEUTRAL_COLOR };
}
