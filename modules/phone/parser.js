"use strict";

import { extractCharacterKeywords } from "../character.js";
import { getCtx, getLastAiFloor } from "../core.js";
import { extractLabelLine, parseFloorSummaryFields } from "../summary/parser.js";


// === Helper: 角色名（含去姓简称，复用"创建角色"功能已有的 extractCharacterKeywords）是否出现在给定文本里 ===
export function characterActiveInText(characterName, text) {
  if (!text) return false;
  return extractCharacterKeywords(characterName).some(
    (kw) => kw && text.includes(kw),
  );
}


// === Helper: 取"正文当前时间"——即最后一层AI楼层摘要模块里的 Time 字段，取不到返回空字符串。
// 供手机私信系统在创建每条消息时记录"这条消息是正文走到哪个时间点时发的"，不是现实时间。===
export function getCurrentStoryTime() {
  const { mes } = getLastAiFloor();
  const fields = parseFloorSummaryFields(mes);
  return (fields && fields.time) || "";
}


// ==== 手机私信系统：联系人文本解析（复用"创建角色"写入的「角色卡：」世界书条目正文）====

// 从角色卡条目正文里取出 <character_information character="..."> 标签内的内容；取不到就退回整段正文。
export function extractCharacterInfoBody(content) {
  const match =
    /<character_information[^>]*>([\s\S]*?)<\/character_information>/.exec(
      content || "",
    );
  return (match ? match[1] : content || "").trim();
}


// === Helper: 取"标签: 值"里值部分一直到文本末尾的多行内容（用于 other 这种允许多行的字段）。
// extractLabelLine 只取标签所在那一行，取不到多行内容，这里单独按"从标签行到末尾"整体截取。===
export function extractMultilineLabelField(text, label) {
  if (!text || typeof text !== "string") return "";
  const re = new RegExp(`^[ \\t]*${label}[ \\t]*[:：][ \\t]*([\\s\\S]*)$`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}


// === Helper: 从角色卡正文里解析固定的 gender/other 两个字段（配合"添加联系人"面板固定输入项）。
// gender 是单行值，other 允许多行、取到标签所在行之后的所有内容。取不到就是空字符串，不报错。===
export function parseContactExtra(extraText) {
  return {
    gender: extractLabelLine(extraText, "gender"),
    other: extractMultilineLabelField(extraText, "other"),
  };
}
