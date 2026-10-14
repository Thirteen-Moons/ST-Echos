// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.0

/**
 * ST-Echos 小总结核心流程。
 *
 * 手动/自动共用：runSmallSummary(区间) → 生成 → 存 pendingSmall → 面板预览
 * → 用户编辑/重说/翻历史 → saveSmallSummary() 进池（更新覆盖区间、按设置隐藏、刷新注入）。
 *
 * 防线（审核定案，勿简化）：
 *  - 生成完成比对发起时的 chatId 与楼层数，不符不保存（防切聊天写错）；
 *  - 保存时再次校验 chatId + 楼层数，变了弹"期间楼层有变动"确认；
 *  - 自动总结失败 → 暂停自动触发（auto.suspended=true），手动成功自动恢复。
 */

import { getContext } from '../../../extensions.js';
import { callSummaryApi, ApiError } from './api.js';
import { getCurrentSettings, saveSettings } from './settings.js';
import {
    getChatData, saveChatData, lastFloor, mergeRanges, getPoolText, sortedSummaries,
} from './storage.js';
import { buildSummaryMessages, buildBigSummaryMessages, floorsToMessages, getFloors } from './prompts.js';
import { refreshInjection } from './injection.js';
import { hideFloors } from './hide.js';
import { uid } from './settings.js';
import { runtime } from './state.js';
import { appendToEntry } from './lorebook.js';
import { countListItems } from './tags.js';

export class SummaryError extends Error {
    constructor(message, code = 'unknown') { super(message); this.name = 'SummaryError'; this.code = code; }
}

const GENERATION_HISTORY_MAX = 20;

/* ============================== 生成 ============================== */

/**
 * 对楼层区间 [start,end] 执行小总结。
 * @returns {Promise<{text:string}>} 成功时（已写入 pendingSmall）
 */
export async function runSmallSummary(start, end, { source = 'manual' } = {}) {
    const ctx = getContext();
    const chatIdAtStart = ctx.chatId;
    const floorCountAtStart = (ctx.chat || []).length;
    const s = getCurrentSettings();

    const floors = getFloors(start, end);
    if (!floors.length) throw new SummaryError('所选区间没有可总结的楼层', 'empty-range');
    const messages = buildSummaryMessages(s.smallSummary.promptEntries, floorsToMessages(floors), s.customApi.enabled);
    console.debug('[ST-Echos] 总结请求 messages:', JSON.parse(JSON.stringify(messages)));

    let text;
    try {
        text = await callSummaryApi({ settings: s, messages });
    } catch (e) {
        if (source === 'auto') {
            s.smallSummary.auto.suspended = true;
            saveSettings();
        }
        if (e instanceof ApiError) throw new SummaryError(e.message, 'api');
        throw new SummaryError(String(e && e.message || e), 'api');
    }

    // 切聊天防护：回来的不是发起时的聊天/楼层数 → 丢弃
    const ctxNow = getContext();
    if (ctxNow.chatId !== chatIdAtStart) {
        throw new SummaryError('总结完成前切换了聊天，结果已丢弃，请重新总结', 'chat-changed');
    }
    const floorChanged = (ctxNow.chat || []).length !== floorCountAtStart;

    const data = getChatData();
    data.pendingSmall = {
        range: [start, end],
        floorCountAtStart,
        floorChanged,
        generations: [text],
        current: 0,
    };
    saveChatData();
    if (source === 'auto') {
        // 自动成功同样恢复触发权
        if (s.smallSummary.auto.suspended) { s.smallSummary.auto.suspended = false; saveSettings(); }
    }
    return { text, floorChanged };
}

/** 重说：同内容重新生成，进生成历史 */
export async function regenerateSmallSummary() {
    const data = getChatData();
    const p = data.pendingSmall;
    if (!p) throw new SummaryError('没有待保存的预览', 'no-pending');
    const [start, end] = p.range;
    const result = await runSmallSummary(start, end, { source: 'manual' });
    const p2 = getChatData().pendingSmall;
    // runSmallSummary 重置了 generations；把历史接回去
    const prevGens = p.generations || [];
    p2.generations = [...prevGens, result.text].slice(-GENERATION_HISTORY_MAX);
    p2.current = p2.generations.length - 1;
    p2.floorChanged = p.floorChanged || p2.floorChanged;
    saveChatData();
    return { text: result.text, generationCount: p2.generations.length };
}

/** 查看生成历史：返回列表与切换某代 */
export function listSmallGenerations() {
    const p = getChatData().pendingSmall;
    return p ? (p.generations || []) : [];
}
export function selectSmallGeneration(index) {
    const data = getChatData();
    const p = data.pendingSmall;
    if (!p || !p.generations || !p.generations[index]) return null;
    p.current = index;
    saveChatData();
    return p.generations[index];
}

/* ============================== 保存 ============================== */

/**
 * 把待保存预览存入小总结池。
 * @returns {Promise<{start:number, end:number}>}
 */
export async function saveSmallSummary() {
    const ctx = getContext();
    const data = getChatData();
    const p = data.pendingSmall;
    if (!p) throw new SummaryError('没有待保存的预览', 'no-pending');

    // 保存前校验（审核定案）：chatId 变了根本不该到这（生成时已拦）；楼层数变了要确认——由面板层弹窗后调用 doSaveSmallSummary
    const [start, end] = p.range;
    const text = (p.generations || [])[p.current];
    if (!text || !text.trim()) throw new SummaryError('预览内容为空', 'empty-text');

    data.summaries.push({ id: uid(), range: [start, end], text, ts: Date.now() });
    data.coverageRanges = mergeRanges([...data.coverageRanges, [start, end]]);
    data.pendingSmall = null;
    saveChatData();

    // 手动总结成功同样恢复自动触发（规格：手动成功一次自动恢复，恢复后立即补触发一次）
    const s = getCurrentSettings();
    let resumed = false;
    if (s.smallSummary.auto.suspended) {
        s.smallSummary.auto.suspended = false;
        saveSettings();
        resumed = true;
    }

    // 自动隐藏（6.2）：记录永远写入；"临时显示已隐藏的楼层"勾选期间只记不藏（规格：记录照常更新，取消勾选后按记录恢复）
    if (s.smallSummary.autoHide) {
        const defer = s.smallSummary.showHiddenOverride;
        await hideFloors(data, start, end, { deferApply: defer });
        if (defer) {
            // 显式记下"只记未藏"的楼层（不能用 is_system 反推——"所有"模式下已藏楼层也可见，会自我强化）
            runtime.deferredHidden = mergeRanges([...runtime.deferredHidden, [start, end]]);
        }
        saveChatData(); // deferApply 分支不会触发 saveChat，这里补一次落盘
    }

    refreshInjection();
    return { start, end, resumed };
}

/* ============================== 区间计算（自动/手动共用） ============================== */

/** 上次覆盖末楼；无则 -1 */
export function lastCoveredEndOf(data) {
    const merged = mergeRanges(data.coverageRanges);
    return merged.length ? merged[merged.length - 1][1] : -1;
}

/** 可总结区间 [起,止]；长度不足返回 null */
export function computableRange(data, protectionN) {
    const last = lastFloor();
    if (last < 0) return null;
    const start = lastCoveredEndOf(data) + 1;
    const end = last - Math.max(0, protectionN | 0);
    return end >= start ? [start, end] : null;
}

/** 计算 [start,end] 与已覆盖区间的未覆盖部分；返回区间数组（可能多个） */
export function uncoveredParts(data, start, end) {
    const merged = mergeRanges(data.coverageRanges);
    let parts = [[start, end]];
    for (const [cs, ce] of merged) {
        const next = [];
        for (const [s, e] of parts) {
            if (ce < s || cs > e) { next.push([s, e]); continue; }
            if (cs > s) next.push([s, cs - 1]);
            if (ce < e) next.push([ce + 1, e]);
        }
        parts = next;
    }
    return parts;
}

/** 统计文本：合并区间 → "已总结 x~y、a~b 层" */
export function statsText(data) {
    const merged = mergeRanges(data.coverageRanges);
    if (!merged.length) return '尚未总结';
    return '已总结 ' + merged.map(([s, e]) => `${s}~${e}`).join('、') + ' 层';
}

/* ============================== 大总结 ============================== */

function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
    return String(h);
}

/** 池快照（生成大总结时拍摄，保存时比对，防"生成期间池有新增"被误清） */
export function snapshotOfPool() {
    const text = getPoolText();
    const data = getChatData();
    return { count: data.summaries.length, chars: text.length, hash: simpleHash(text) };
}

/** 执行大总结（发送池全文+大总结提示词） */
export async function runBigSummary({ source = 'manual' } = {}) {
    const ctx = getContext();
    const chatIdAtStart = ctx.chatId;
    const s = getCurrentSettings();
    const poolText = getPoolText();
    if (!poolText.trim()) throw new SummaryError('小总结池是空的，无法大总结', 'empty-pool');
    const messages = buildBigSummaryMessages(s.bigSummary.promptEntries, poolText);
    console.debug('[ST-Echos] 大总结请求 messages:', JSON.parse(JSON.stringify(messages)));
    // 快照必须在发起请求前拍：保存时比对，才能发现"生成期间池有新增"（审核修正 #3）
    const poolSnapshot = snapshotOfPool();
    const floorCountAtStart = (ctx.chat || []).length;

    let text;
    try {
        text = await callSummaryApi({ settings: s, messages });
    } catch (e) {
        if (source === 'auto') {
            s.bigSummary.auto.suspended = true;
            saveSettings();
        }
        if (e instanceof ApiError) throw new SummaryError(e.message, 'api');
        throw new SummaryError(String(e && e.message || e), 'api');
    }

    const ctxNow = getContext();
    if (ctxNow.chatId !== chatIdAtStart) {
        throw new SummaryError('大总结完成前切换了聊天，结果已丢弃', 'chat-changed');
    }

    const data = getChatData();
    data.pendingBig = {
        poolSnapshot,
        floorCountAtStart,
        generations: [text],
        current: 0,
    };
    if (source === 'auto' && s.bigSummary.auto.suspended) { s.bigSummary.auto.suspended = false; saveSettings(); }
    saveChatData();
    return { text };
}

/** 大总结重说 */
export async function regenerateBigSummary() {
    const data = getChatData();
    const p = data.pendingBig;
    if (!p) throw new SummaryError('没有待保存的大总结预览', 'no-pending');
    const prevGens = (p.generations || []).slice();
    await runBigSummary({ source: 'manual' });
    const p2 = getChatData().pendingBig;
    p2.generations = [...prevGens, p2.generations[0]].slice(-GENERATION_HISTORY_MAX);
    p2.current = p2.generations.length - 1;
    saveChatData();
    return { text: p2.generations[p2.current], generationCount: p2.generations.length };
}

export function listBigGenerations() {
    const p = getChatData().pendingBig;
    return p ? (p.generations || []) : [];
}
export function selectBigGeneration(index) {
    const data = getChatData();
    const p = data.pendingBig;
    if (!p || !p.generations || !p.generations[index]) return null;
    p.current = index;
    saveChatData();
    return p.generations[index];
}

/**
 * 保存大总结（并发窗口的弹窗在面板层处理完后调用）。
 * @param {object} target 世界书定位 {name, uid?, comment?}
 */
export async function saveBigSummaryCore(target) {
    const data = getChatData();
    const p = data.pendingBig;
    if (!p) throw new SummaryError('没有待保存的大总结预览', 'no-pending');
    const text = (p.generations || [])[p.current];
    if (!text || !text.trim()) throw new SummaryError('预览内容为空', 'empty-text');

    const finalTarget = await appendToEntry(target, text);
    data.lorebook = finalTarget; // 记住本聊天用哪个条目
    data.summaries = [];         // 清空小总结池（统计/隐藏水印不动）
    data.pendingBig = null;
    saveChatData();
    refreshInjection();
    return finalTarget;
}

/** 自动大总结判定（每次小总结保存后调用） */
export function bigSummaryThresholdMet() {
    const s = getCurrentSettings().bigSummary;
    if (!s.auto.enabled || s.auto.suspended) return false;
    const text = getPoolText();
    if (s.auto.metric === 'items') return countListItems(text) >= (s.auto.threshold || 100);
    return text.length >= (s.auto.threshold || 5000);
}
