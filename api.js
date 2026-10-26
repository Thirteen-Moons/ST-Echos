// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.2

/**
 * ST-Echos 总结 API 通道。
 *
 * 两条通道：
 *  - 自定义 OpenAI 兼容 API：浏览器直连 fetch（本地模型用，README 有 CORS 说明）；
 *  - 主聊天 LLM：走酒馆 generateRaw（安静生成，不打扰当前聊天）。
 *
 * 采样参数（settings.sampling，null=off 不传入）：
 *  - 自定义通道：直接进请求体；
 *  - 主LLM通道：generateRaw 不支持采样形参，用事件钩子临时改 generate_data，
 *    on+off 双路径摘除（成功/失败都清理），防止污染用户正常对话的采样。
 */

import { eventSource, event_types, generateRaw } from '../../../../script.js';

/* ============================== 采样参数映射 ============================== */

/** 采样字段 → generate_data 里的字段名（存在才覆盖，避免塞进后端不认识的键） */
const GENERATE_DATA_KEYS = {
    temperature: 'temperature',
    topP: 'top_p',
    topK: 'top_k',
    minP: 'min_p',
    presencePenalty: 'presence_penalty',
    repetitionPenalty: 'repetition_penalty',
};

/** 组装自定义 API 请求体里的采样字段（跳过 null） */
export function buildSamplingBody(sampling) {
    const body = {};
    if (!sampling) return body;
    if (sampling.temperature != null) body.temperature = sampling.temperature;
    if (sampling.topP != null) body.top_p = sampling.topP;
    if (sampling.topK != null) body.top_k = sampling.topK;
    if (sampling.minP != null) body.min_p = sampling.minP;
    if (sampling.presencePenalty != null) body.presence_penalty = sampling.presencePenalty;
    if (sampling.repetitionPenalty != null) body.repetition_penalty = sampling.repetitionPenalty;
    if (sampling.maxTokens != null) body.max_tokens = sampling.maxTokens;
    return body;
}

/* ============================== 主LLM通道采样覆盖 ============================== */

/**
 * 在 fn 执行期间临时覆盖主 LLM 的采样参数。
 * 成功、失败两条路径都会摘除监听器（审核修正的防泄漏写法）。
 * @param {object} sampling 采样设置（null 字段不覆盖）
 * @param {Function} fn 要执行的异步函数（内部应调用 generateRaw/generateQuietPrompt）
 */
export async function withSamplingOverride(sampling, fn) {
    const overrides = {};
    for (const [ourKey, dataKey] of Object.entries(GENERATE_DATA_KEYS)) {
        if (sampling && sampling[ourKey] != null) overrides[dataKey] = sampling[ourKey];
    }
    const hasOverrides = Object.keys(overrides).length > 0;
    const handlers = [];
    try {
        if (hasOverrides) {
            const makeHandler = (allowUnknownKeys) => (generate_data) => {
                if (!generate_data || typeof generate_data !== 'object') return;
                const applied = {};
                for (const [key, value] of Object.entries(overrides)) {
                    // 字段已存在才覆盖；allowUnknownKeys 的通道（如自定义源）可以直接塞
                    if (allowUnknownKeys || key in generate_data) { generate_data[key] = value; applied[key] = value; }
                }
                if (Object.keys(applied).length) console.debug('[ST-Echos] 主LLM采样覆盖已应用:', applied);
            };
            const ccHandler = makeHandler(false);
            const tcHandler = makeHandler(true);
            eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, ccHandler);
            eventSource.on(event_types.GENERATE_AFTER_DATA, tcHandler);
            handlers.push([event_types.CHAT_COMPLETION_SETTINGS_READY, ccHandler], [event_types.GENERATE_AFTER_DATA, tcHandler]);
        }
        return await fn();
    } finally {
        for (const [event, handler] of handlers) {
            eventSource.removeListener(event, handler);
        }
    }
}

/* ============================== 自定义 OpenAI 通道 ============================== */

/** 规范化 URL：补全 /chat/completions 后缀 */
export function normalizeChatUrl(url) {
    let u = String(url || '').trim();
    if (!u) return u;
    u = u.replace(/\/+$/, '');
    if (!u.endsWith('/chat/completions')) {
        if (u.endsWith('/v1') || u.endsWith('/v1beta')) u += '/chat/completions';
        else if (!/\/v\d+$/.test(u) && !u.endsWith('completions')) u += '/v1/chat/completions';
    }
    return u;
}

function baseUrlOf(url) {
    // 去掉末尾的 /chat/completions 得到 base，用于拼 /models
    return normalizeChatUrl(url).replace(/\/chat\/completions$/, '');
}

export class ApiError extends Error {
    constructor(message, { status = null, isCors = false } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.isCors = isCors;
    }
}

function corsHint() {
    return '若地址与密钥确认无误，可能是浏览器跨域（CORS）拦截：本地后端需在服务端放行酒馆来源（如 Ollama 设置 OLLAMA_ORIGINS，llama.cpp/LM Studio 一般默认放行）。详见插件 README。';
}

/** 测试连接：拉取模型列表。成功返回 { models: string[] } */
export async function testConnection({ url, key }) {
    const base = baseUrlOf(url);
    if (!base) throw new ApiError('请先填写 API 地址');
    let response;
    try {
        response = await fetch(`${base}/models`, {
            method: 'GET',
            headers: key ? { Authorization: `Bearer ${key}` } : {},
        });
    } catch (e) {
        throw new ApiError(`无法连接到 ${base}。${corsHint()}`, { isCors: true });
    }
    if (!response.ok) {
        throw new ApiError(`连接失败：HTTP ${response.status}${response.status === 401 ? '（密钥可能无效）' : ''}`, { status: response.status });
    }
    let models = [];
    try {
        const data = await response.json();
        const list = data.data || data.models || [];
        models = list.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean).sort();
    } catch { /* 返回格式异常时忽略列表 */ }
    return { models };
}

/**
 * 调用自定义 OpenAI 兼容 API 做总结。
 * @param {object} args
 * @param {Array<{role:string, content:string, name?:string}>} args.messages 完整消息数组（可含 system）
 * @param {object} args.sampling 采样设置
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<string>} 总结文本
 */
export async function callCustomOpenAI({ url, key, model, messages, sampling, signal }) {
    const endpoint = normalizeChatUrl(url);
    if (!endpoint) throw new ApiError('请先填写 API 地址');
    // 部分严格的 OpenAI 兼容端点（如 LM Studio）不允许非 tool 消息带 name 字段，统一剥掉
    const cleanMessages = (messages || []).map(({ role, content }) => ({ role, content }));
    const body = {
        model: model || 'default',
        messages: cleanMessages,
        stream: false,
        ...buildSamplingBody(sampling),
    };
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify(body),
            signal,
        });
    } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw new ApiError(`请求失败：${String(e && e.message || e)}。${corsHint()}`, { isCors: true });
    }
    if (!response.ok) {
        let detail = '';
        try { detail = (await response.text()).slice(0, 300); } catch { /* ignore */ }
        throw new ApiError(`总结API返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`, { status: response.status });
    }
    const data = await response.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== 'string' || !text.trim()) {
        throw new ApiError('总结API返回了空内容');
    }
    return text;
}

/* ============================== 主LLM通道 ============================== */

/**
 * 用主聊天 LLM 做总结。
 * @param {Array<{role:string, content:string, name?:string}>} messages 完整消息数组
 * @param {object} sampling 采样设置（maxTokens 走 responseLength，其余事件覆盖）
 * @returns {Promise<string>} 总结文本
 */
export async function callMainLLM({ messages, sampling }) {
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content).filter(Boolean);
    const rest = messages.filter(m => m.role !== 'system');
    const systemPrompt = systemParts.join('\n\n');
    const prompt = rest.map(m => ({ role: m.role, content: m.content, name: m.name }));
    const params = {
        prompt,
        systemPrompt,
        quietToLoud: false,
        trimNames: false,
    };
    if (sampling && sampling.maxTokens != null) params.responseLength = sampling.maxTokens;
    const result = await withSamplingOverride(sampling, () => generateRaw(params));
    if (typeof result !== 'string' || !result.trim()) {
        throw new ApiError('主LLM返回了空内容');
    }
    return result;
}

/**
 * 统一出口：按设置选择通道。
 * @param {object} args.settings 当前面板设置
 * @param {Array} args.messages 完整消息数组
 */
export async function callSummaryApi({ settings, messages, signal }) {
    const useCustom = settings.customApi.enabled;
    if (useCustom) {
        return await callCustomOpenAI({
            url: settings.customApi.url,
            key: settings.customApi.key,
            model: settings.customApi.model,
            messages,
            sampling: settings.sampling,
            signal,
        });
    }
    return await callMainLLM({ messages, sampling: settings.sampling });
}
