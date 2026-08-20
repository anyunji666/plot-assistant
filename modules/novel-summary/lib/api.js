import { getCtx } from "../../core.js";

// ============================================================
// 并发控制
// ============================================================

export function concurrencyLimit(value, fallback = 0) {
    const parsed = parseInt(value ?? fallback, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export class DynamicSemaphore {
    constructor(getLimit) {
        this.getLimit = getLimit;
        this.running = 0;
        this.queue = [];
    }

    async acquire() {
        if (this.running < this._limit()) {
            this.running++;
            return;
        }
        await new Promise(resolve => this.queue.push(resolve));
    }

    release() {
        this.running = Math.max(0, this.running - 1);
        this._drain();
    }

    _limit() {
        return concurrencyLimit(this.getLimit?.(), 1);
    }

    _drain() {
        while (this.queue.length && this.running < this._limit()) {
            const resolve = this.queue.shift();
            this.running++;
            resolve();
        }
    }
}

export async function runWithSemaphore(semaphore, task) {
    await semaphore.acquire();
    try {
        return await task();
    } finally {
        semaphore.release();
    }
}

// ============================================================
// 请求限速队列（保证两次请求之间至少间隔 60s / rpm）
// ============================================================

export function parseRateLimit(value, fallback = 3) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

export class RateQueue {
    constructor({ getLimit, fallbackLimit = 3, now = () => Date.now(), setTimer = (cb, ms) => setTimeout(cb, ms) }) {
        this.pending = [];
        this.processing = false;
        this.getLimit = getLimit;
        this.fallbackLimit = fallbackLimit;
        this.now = now;
        this.setTimer = setTimer;
        this.lastAt = 0;
        // 前一条请求是否仍未返回（尚未调用 release()）。
        // 为 true 时，即使限速间隔已到，也绝不放行下一条排队请求。
        this.busy = false;
    }

    async acquire(signal) {
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, signal };
            if (signal) {
                signal.addEventListener('abort', () => {
                    const idx = this.pending.indexOf(entry);
                    if (idx !== -1) this.pending.splice(idx, 1);
                    reject(new Error('AbortError'));
                }, { once: true });
            }
            this.pending.push(entry);
            this._flush();
        });
    }

    // 必须在 acquire() 放行的这次请求彻底结束后调用一次
    // （无论成功、失败、超时还是被中止），否则队列会一直卡住，
    // 不会给下一条排队的请求放行。
    // 注意：这里不更新 lastAt —— 限速间隔的基准是“发送时刻”
    // （在下面 _tick 里出队时记录），跟这条请求处理了多久无关，
    // 避免“限速间隔”和“等待返回”这两个独立条件被叠加等待。
    release() {
        this.busy = false;
        this._flush();
    }

    _flush() {
        if (this.processing) return;
        this.processing = true;
        this._tick();
    }

    _tick() {
        // 上一条还没返回：无论限速间隔是否已到，都不放行下一条。
        if (this.busy) {
            this.processing = false;
            return;
        }
        if (!this.pending.length) {
            this.processing = false;
            return;
        }
        const limit = parseRateLimit(this.getLimit?.(), this.fallbackLimit);
        if (limit <= 0) {
            // 限速关闭时仍保持“一条一条来”，只是不做时间间隔等待。
            const entry = this.pending.shift();
            this.busy = true;
            entry.resolve();
            this.processing = false;
            return;
        }
        const interval = Math.ceil(60000 / limit);
        const elapsed = this.now() - this.lastAt;
        const wait = Math.max(0, interval - elapsed);
        this.setTimer(() => {
            const entry = this.pending.shift();
            if (entry) {
                this.busy = true;
                entry.resolve();
            } else {
                this.processing = false;
                return;
            }
            this.processing = false;
        }, wait);
    }
}

// ============================================================
// 模型列表
// ============================================================

export function niBuildModelsUrl(url) {
    const normalizedUrl = String(url ?? '').trim();
    const base = normalizedUrl
        .replace(/\/chat\/completions\/?$/, '')
        .replace(/\/$/, '');
    return `${base}/models`;
}

export function niNormalizeModelIds(payload) {
    const items = payload?.data || payload?.models || [];
    if (!Array.isArray(items)) return [];
    return items
        .map(model => typeof model === 'string' ? model : model?.id)
        .filter(Boolean);
}

export async function niFetchModelIds({ url, key = '', fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
    const response = await fetchImpl(niBuildModelsUrl(url), {
        headers: {
            'Authorization': `Bearer ${String(key ?? '').trim()}`,
            'Content-Type': 'application/json',
        },
    });
    if (!response.ok) throw new Error(`${response.status}`);
    return niNormalizeModelIds(await response.json());
}

// ============================================================
// 聊天补全响应解析（含流式 SSE）
// ============================================================

function niContentPartToText(part) {
    if (part === undefined || part === null) return '';
    if (typeof part === 'string') return part;
    if (Array.isArray(part)) return part.map(niContentPartToText).join('');
    if (typeof part === 'object') {
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
    }
    return '';
}

export function niExtractChatCompletionText(data) {
    if (data === undefined || data === null) return '';
    if (typeof data === 'string') return data;

    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    const candidates = [
        choice?.delta?.content,
        choice?.delta?.text,
        choice?.message?.content,
        choice?.text,
        data?.delta?.text,
        data?.delta?.content,
        data?.delta,
        data?.message?.content,
        data?.content,
        data?.output_text,
        data?.output,
        data?.completion,
        data?.response,
        data?.text,
        data?.generated_text,
        data?.candidates?.[0]?.content?.parts,
        data?.candidates?.[0]?.content,
        data?.candidates?.[0]?.text,
    ];

    for (const candidate of candidates) {
        const text = niContentPartToText(candidate);
        if (text && text.trim()) return text;
    }
    return '';
}

function niExtractChatCompletionTextFromRaw(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';

    if (text.startsWith('{') || text.startsWith('[')) {
        try {
            return niExtractChatCompletionText(JSON.parse(text));
        } catch (_) {}
    }

    let full = '';
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            full += niExtractChatCompletionText(JSON.parse(payload));
        } catch (_) {}
    }
    return full;
}

export function niHasLengthFinishReason(data) {
    const choices = Array.isArray(data?.choices) ? data.choices : [];
    return choices.some(choice => String(choice?.finish_reason || '').toLowerCase() === 'length');
}

export async function niReadChatCompletionStream(resp, controller, cleanup, emptyMessage = '流式响应内容为空') {
    const reader = resp.body?.getReader();
    if (!reader) {
        cleanup?.();
        throw new Error(emptyMessage);
    }

    const decoder = new TextDecoder();
    const signal = controller?.signal;
    let full = '';
    let raw = '';
    let pending = '';
    let hitLengthLimit = false;

    const processLine = (line) => {
        const trimmed = String(line || '').trim();
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
            const data = JSON.parse(payload);
            if (niHasLengthFinishReason(data)) hitLengthLimit = true;
            full += niExtractChatCompletionText(data);
        } catch (_) {}
    };

    try {
        while (true) {
            const readPromise = reader.read();
            const readResult = signal
                ? await Promise.race([
                    readPromise,
                    new Promise((_, rej) => {
                        if (signal.aborted) rej(new Error('AbortError'));
                        else signal.addEventListener('abort', () => rej(new Error('AbortError')), { once: true });
                    }),
                ])
                : await readPromise;
            const { done, value } = readResult;
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            raw += chunk;
            pending += chunk;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || '';
            for (const line of lines) processLine(line);
        }

        const tail = decoder.decode(undefined, { stream: false });
        if (tail) {
            raw += tail;
            pending += tail;
        }
        if (pending.trim()) processLine(pending);
    } catch (err) {
        reader.cancel().catch(() => {});
        cleanup?.();
        if (signal?.aborted || err?.message === 'AbortError') throw new Error('请求已中止（超时或用户操作）');
        throw err;
    }

    cleanup?.();
    if (hitLengthLimit) throw new Error('AI 返回被长度截断');
    if (full.trim()) return full.trim();

    const fallback = niExtractChatCompletionTextFromRaw(raw);
    if (fallback.trim()) return fallback.trim();

    throw new Error(emptyMessage);
}

// 是否"未设置 API 地址"——为空/空白时视为未设置，走酒馆当前对话连接。
function isTavernConnectionMode(cfg) {
    return !String(cfg?.apiUrl ?? '').trim();
}

// === 跟随酒馆当前对话连接生成（不走自定义 chat/completions 反代）===
// 与"自动小总结"（modules/summary/generator.js 的 generateSummaryRaw）用的是同一条路径：
// context.generateRaw，跟随酒馆当前连接配置的模型/Key，不需要本模块的 apiUrl/apiKey/model 设置。
// generateRaw 既不支持流式，也不接受 AbortSignal，这里用 Promise.race 兼容超时和"停止"按钮。
async function callViaTavernConnection(messages, signal, timeoutMs) {
    const context = getCtx();
    if (typeof context.generateRaw !== 'function') {
        throw new Error('当前酒馆版本不支持 context.generateRaw，请更新 SillyTavern 到较新版本。');
    }

    const systemPrompt = messages.find((m) => m?.role === 'system')?.content || '';
    const userContent = messages.find((m) => m?.role === 'user')?.content || '';

    const generationPromise = context.generateRaw({
        prompt: [{ role: 'user', content: userContent }],
        systemPrompt,
    });

    const racers = [generationPromise];

    racers.push(
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error('生成超时')), timeoutMs);
        }),
    );

    if (signal) {
        racers.push(
            new Promise((_, reject) => {
                if (signal.aborted) {
                    reject(new Error('请求已中止（超时或用户操作）'));
                    return;
                }
                signal.addEventListener(
                    'abort',
                    () => reject(new Error('请求已中止（超时或用户操作）')),
                    { once: true },
                );
            }),
        );
    }

    const result = await Promise.race(racers);

    if (typeof result === 'string') return result.trim();
    if (result && typeof result.content === 'string') return result.content.trim();
    throw new Error('生成返回了无法识别的结果类型。');
}

// ============================================================
// 清洗 API 客户端
// ============================================================

export function createSummaryApiClient({
    getSettings,
    rateQueue,
    semaphore,
    getRequestHeaders,
    getCurrentAbortController,
    setCurrentAbortController,
    fetch: fetchFn = globalThis.fetch,
} = {}) {
    async function callSummaryApi(messages, { signal = null } = {}) {
        // acquire() 在这里 resolve，即代表限速队列已经把“发送权”交给本次请求；
        // 在这之后、release() 之前，队列会认为“上一条还没返回”，不会放行下一条。
        await rateQueue.acquire(signal);
        try {
            return await callSummaryApiOnce(messages, signal);
        } finally {
            // 不管成功、失败、超时还是中止，都要显式释放，
            // 否则限速队列会一直卡住，后续请求永远发不出去。
            rateQueue.release();
        }
    }

    async function callSummaryApiOnce(messages, signal) {
        const cfg = getSettings?.() || {};
        const useStream = cfg.stream ?? true;
        const TIMEOUT_MS = (cfg.apiTimeoutMin ?? 15) * 60 * 1000;

        if (isTavernConnectionMode(cfg)) {
            // 跟随酒馆连接时并发强制按 1 处理（DynamicSemaphore 的 getLimit 已在
            // ui.js 里做了同样判断），这里的 runWithSemaphore 仍然要走一遍，
            // 保证和自定义反代路径共用同一把并发闸门，不会绕过限制。
            return runWithSemaphore(semaphore, () =>
                callViaTavernConnection(messages, signal, TIMEOUT_MS),
            );
        }

        const body = {
            chat_completion_source: 'openai',
            messages,
            model: cfg.model,
            max_tokens: 8000,
            temperature: 0.3,
            stream: useStream,
            reverse_proxy: cfg.apiUrl,
            proxy_password: cfg.apiKey,
        };

        return runWithSemaphore(semaphore, async () => {
            const controller = new AbortController();
            setCurrentAbortController?.(controller);
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
            const abortFromOuter = () => controller.abort();
            if (signal?.aborted) controller.abort();
            else signal?.addEventListener?.('abort', abortFromOuter, { once: true });

            const cleanup = () => {
                clearTimeout(timeoutId);
                signal?.removeEventListener?.('abort', abortFromOuter);
                if (getCurrentAbortController?.() === controller) setCurrentAbortController?.(null);
            };

            let resp;
            try {
                resp = await fetchFn('/api/backends/chat-completions/generate', {
                    method: 'POST',
                    headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
            } catch (err) {
                cleanup();
                if (err.name === 'AbortError') throw new Error('请求已中止（超时或用户操作）');
                throw err;
            }

            if (!resp.ok) {
                cleanup();
                const txt = await resp.text().catch(() => '');
                throw new Error(`API ${resp.status}: ${txt.slice(0, 200)}`);
            }

            if (useStream) {
                return await niReadChatCompletionStream(resp, controller, cleanup, '流式响应内容为空');
            }

            let json;
            try {
                json = await resp.json();
            } catch (err) {
                cleanup();
                throw err;
            }
            cleanup();
            if (niHasLengthFinishReason(json)) throw new Error('AI 返回被长度截断');
            const text = niExtractChatCompletionText(json?.choices?.[0]) || niExtractChatCompletionText(json);
            if (text && text.trim()) return text.trim();

            console.error('[NS] 无法解析 API 响应，完整内容:', JSON.stringify(json).slice(0, 500));
            throw new Error('API 返回格式异常，请查看控制台');
        });
    }

    return { callSummaryApi };
}
