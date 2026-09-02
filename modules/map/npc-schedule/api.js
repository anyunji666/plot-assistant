"use strict";

import { getRequestHeaders } from "../../../../../../../script.js";
import {
  DynamicSemaphore,
  RateQueue,
  createSummaryApiClient,
} from "../../novel-summary/lib/api.js";
import { getNpcScheduleLlmSettings } from "./store.js";

// =====================================================================================
// === NPC行程LLM：API 客户端 ===
// 复用"摘要提取"模块（novel-summary/lib/api.js）里已经跑通的通用请求/限速/并发/流式解析逻辑，
// 跟状态表LLM（summary/status-llm/api.js）是同一套写法。每次只在"最新一层渲染完成后"触发一次，
// 天然串行，这里的限速队列/信号量只是为了复用同一个工厂函数，不额外暴露限速设置给用户。
// =====================================================================================

let currentAbortController = null;
const rateQueue = new RateQueue({ getLimit: () => 0, fallbackLimit: 0 }); // 不做时间间隔限速，只保证"一条一条来"
const semaphore = new DynamicSemaphore(() => 1);

const { callSummaryApi } = createSummaryApiClient({
  getSettings: getNpcScheduleLlmSettings,
  rateQueue,
  semaphore,
  getRequestHeaders,
  getCurrentAbortController: () => currentAbortController,
  setCurrentAbortController: (c) => {
    currentAbortController = c;
  },
});

// === Function: 调用NPC行程LLM，messages 为 [{role, content}] 数组，返回纯文本 ===
export async function callNpcScheduleLlm(messages) {
  return callSummaryApi(messages);
}
