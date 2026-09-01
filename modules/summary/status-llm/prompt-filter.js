"use strict";

import { STATUS_LLM_FIELDS_START, STATUS_LLM_FIELDS_END } from "../../core.js";

// =====================================================================================
// === 状态表LLM：生成前过滤——不让剧情LLM在历史楼层里重复看到 status-llm-fields 标记块 ===
// 世界书「状态表」条目已经把 Inventory/Setups/附加字段的合并后最新值正常注入进上下文，
// 每层楼摘要块里那份是"当层增量片段"，留在正文里只是给状态表全量重放/逐层回看用的，
// 不需要也不应该再让剧情LLM在对话历史里重复读一遍——多花token，且措辞未必跟状态表当前值一致。
//
// 通过酒馆扩展 API 的 Prompt Interceptor 机制实现（manifest.json 的 generate_interceptor
// 字段 + 一个全局函数），只处理"即将发给AI的这份 chat 拷贝"，不碰真实存档：
// 文档特别提醒，传入的 chat 数组和真实聊天记录是同一批消息对象引用，直接改 message.mes
// 会把清洗结果永久写回真实存档；正确做法是给命中的楼层整体换一个新对象（浅拷贝+改mes），
// 只让这次要发送的数组元素指向新对象，原始消息对象（真实存档仍持有的那份引用）不受影响。
// =====================================================================================

const STATUS_LLM_FIELDS_BLOCK_RE = new RegExp(
  `${STATUS_LLM_FIELDS_START}[\\s\\S]*?${STATUS_LLM_FIELDS_END}\\n?`,
  "g",
);

// === Helper: 从消息正文里剥离状态表LLM维护的标记块，找不到标记时原样返回（不产生无谓的新字符串）===
export function stripStatusLlmFieldsBlock(mesText) {
  if (!mesText || typeof mesText !== "string") return mesText;
  if (!mesText.includes(STATUS_LLM_FIELDS_START)) return mesText;
  return mesText.replace(STATUS_LLM_FIELDS_BLOCK_RE, "");
}

// === Function: 生成拦截器本体——只替换"命中的那几层"为新对象，其余楼层原样保留同一引用，
// 不会产生任何持久化的多余数据（每次生成都是现算现丢，不写回 .mes，也不额外占用存储）===
export async function filterStatusLlmFieldsForGeneration(chat) {
  try {
    if (!Array.isArray(chat)) return;
    for (let i = 0; i < chat.length; i++) {
      const message = chat[i];
      if (!message || typeof message.mes !== "string") continue;
      if (!message.mes.includes(STATUS_LLM_FIELDS_START)) continue;
      chat[i] = { ...message, mes: stripStatusLlmFieldsBlock(message.mes) };
    }
  } catch (error) {
    console.error("[剧情助手] 生成前过滤 status-llm-fields 标记块时出错:", error);
  }
}
