"use strict";

import { getRequestHeaders } from "../../../../../../script.js";
import {
  DynamicSemaphore,
  RateQueue,
  createSummaryApiClient,
  niFetchModelIds,
} from "../novel-summary/lib/api.js";
import { getStatusLlmSettings } from "./status-llm-store.js";

// =====================================================================================
// === 状态表LLM：API 客户端 ===
// 复用"摘要提取"模块（novel-summary/lib/api.js）里已经跑通的通用请求/限速/并发/流式解析逻辑，
// 不重新实现一套——两边的需求（跟随酒馆连接 or 走自定义反代、SSE 解析、超时/中止）完全一致。
// 状态表LLM每次只在"最新一层渲染完成后"触发一次，天然串行，
// 这里的限速队列/信号量只是为了复用同一个工厂函数，不额外暴露限速设置给用户。
// =====================================================================================

let currentAbortController = null;
const rateQueue = new RateQueue({ getLimit: () => 0, fallbackLimit: 0 }); // 不做时间间隔限速，只保证"一条一条来"
const semaphore = new DynamicSemaphore(() => 1);

const { callSummaryApi } = createSummaryApiClient({
  getSettings: getStatusLlmSettings,
  rateQueue,
  semaphore,
  getRequestHeaders,
  getCurrentAbortController: () => currentAbortController,
  setCurrentAbortController: (c) => {
    currentAbortController = c;
  },
});

// === Function: 调用状态表LLM，messages 为 [{role, content}] 数组，返回纯文本 ===
export async function callStatusLlm(messages) {
  return callSummaryApi(messages);
}

export { niFetchModelIds };
