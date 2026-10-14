// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.0

/**
 * ST-Echos 提示词组装。
 *
 * 把"提示词条目 + 聊天楼层"组装成发给总结 API 的 OpenAI messages 数组：
 *  - system 身份的条目合并成一条 system 消息（真 system 身份，用户明确要求）；
 *  - 用户/助手条目按序为对应角色消息；
 *  - Chat History 占位条目处插入楼层消息数组（每条楼层带原生角色与名字）；
 *  - 楼层正文在插入前应用第四层正则；
 *  - 所有提示词文本经 substituteParams 宏替换（{{char}}/{{user}} 等酒馆变量可用）。
 *
 * 关于"对话中指定深度"条目：安静生成（generateRaw）的上下文里没有真实聊天楼层，
 * 深度语义无法对主LLM通道生效；此时按条目顺序内联处理。自定义API通道按
 * "数组末尾为最新"的约定把深度条目插到倒数第 depth 条位置（0=最后之后=末尾）。
 */

import { getContext } from '../../../extensions.js';
import { substituteParams } from '../../../../script.js';
import { applyRegexToFloors } from './regex.js';
import { getCurrentSettings } from './settings.js';

export const NARRATOR_TYPE = 'narrator';

/** 取楼层区间 [start,end]（含），返回 {name, mes, isUser, isNarrator} 列表 */
export function getFloors(start, end) {
    const chat = getContext().chat || [];
    const out = [];
    for (let i = start; i <= end && i < chat.length; i++) {
        const m = chat[i];
        if (!m) continue;
        out.push({
            index: i,
            name: m.name || '',
            mes: m.mes || '',
            isUser: !!m.is_user,
            isNarrator: m.extra && m.extra.type === NARRATOR_TYPE,
        });
    }
    return out;
}

/**
 * 楼层 → messages（原生角色+名字，正文过正则）。
 * @param {Array} floors getFloors 的结果
 */
export function floorsToMessages(floors) {
    const s = getCurrentSettings();
    const processed = applyRegexToFloors(floors.map(f => f.mes), s.regex.scripts, s.regex.enabled);
    return floors.map((f, i) => ({
        role: f.isUser ? 'user' : (f.isNarrator ? 'system' : 'assistant'),
        content: processed[i],
        name: f.name,
    }));
}

/** 深度条目（含深度模式的 Chat History 占位）在自定义通道的落点计算 */
function spliceDepth(messages, depthMessages, depth) {
    const d = Math.max(0, depth | 0);
    const at = Math.max(0, messages.length - d);
    messages.splice(at, 0, ...depthMessages);
}

/**
 * 组装发给总结 API 的完整 messages 数组。
 * @param {Array} entries 提示词条目（小总结或大总结的条目组）
 * @param {Array} floorMessages floorsToMessages 的结果（楼层区间）
 * @param {boolean} forCustomApi 目标通道（true=自定义API，false=主LLM）
 */
export function buildSummaryMessages(entries, floorMessages, forCustomApi) {
    const messages = [];
    const pendingDepth = []; // 自定义通道：等待按深度插入的块
    const systemParts = [];

    for (const entry of entries || []) {
        if (!entry || !entry.enabled) continue;

        if (entry.isChatHistory) {
            if (!floorMessages.length) continue;
            if (entry.position === 'depth' && forCustomApi) {
                pendingDepth.push({ depth: entry.depth || 0, block: floorMessages });
            } else {
                messages.push(...floorMessages);
            }
            continue;
        }

        const content = substituteParams(entry.content || '').trim();
        if (!content) continue;

        if (entry.role === 'system') {
            systemParts.push(content);
            continue;
        }

        const msg = { role: entry.role === 'assistant' ? 'assistant' : 'user', content };
        if (entry.position === 'depth' && forCustomApi) {
            pendingDepth.push({ depth: entry.depth || 0, block: [msg] });
        } else {
            messages.push(msg);
        }
    }

    // system 合并为一条，置于最前
    if (systemParts.length) {
        messages.unshift({ role: 'system', content: systemParts.join('\n\n') });
    }

    // 自定义通道：深度块从深到浅插入（先插深的，避免落点互相干扰）
    pendingDepth.sort((a, b) => b.depth - a.depth);
    for (const { depth, block } of pendingDepth) {
        spliceDepth(messages, block, depth);
    }

    return messages;
}

/** 大总结的组装：system 条目合并置顶，池全文作为第一条 user 消息，其余条目随后 */
export function buildBigSummaryMessages(entries, poolText) {
    const rest = [];
    const systemParts = [];
    for (const entry of entries || []) {
        if (!entry || !entry.enabled || entry.isChatHistory) continue;
        const content = substituteParams(entry.content || '').trim();
        if (!content) continue;
        if (entry.role === 'system') systemParts.push(content);
        else rest.push({ role: entry.role === 'assistant' ? 'assistant' : 'user', content });
    }
    const messages = [];
    if (systemParts.length) messages.push({ role: 'system', content: systemParts.join('\n\n') });
    if (poolText && poolText.trim()) messages.push({ role: 'user', content: poolText });
    messages.push(...rest);
    return messages;
}
