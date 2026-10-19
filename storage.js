// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.1

/**
 * ST-Echos 聊天级数据存取（chat_metadata.stecho）。
 *
 * 存在聊天文件里：切换/删除聊天天然隔离，酒馆的聊天 checkpoint 回滚也是整体一致。
 * 载入时做越界校验（区间超出当前末楼自动修正，并留痕告知用户）。
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { saveMetadataDebounced } from '../../../extensions.js';

const CHAT_KEY = 'stecho';

function defaultChatData() {
    return {
        version: 1,
        coverageRanges: [],   // [[起,止]…] 已保存小总结的楼层区间（统计/隐藏依据）
        hiddenRanges: [],     // [[起,止]…] 插件实际隐藏的楼层（独立记录）
        summaries: [],        // [{id, range:[起,止]|null, text, ts}…] 小总结池
        pendingSmall: null,   // {range, floorCountAtStart, generations[], current}
        pendingBig: null,     // {floorCountAtStart, poolSnapshot, generations[], current}
        lorebook: null,       // {name, uid, comment}
        lorebookAuto: false,  // 条目下拉是否停在"自动"档（true 时复用 lorebook 指向的条目）
        tags: [],             // 标签按聊天隔离（2026-10-10 决策变更：不再全局共享）
    };
}

/** 取当前聊天的插件数据（不存在则创建默认对象并挂上，但不触发保存） */
export function getChatData() {
    const ctx = getContext();
    const meta = ctx.chatMetadata;
    if (!meta[CHAT_KEY]) meta[CHAT_KEY] = defaultChatData();
    const data = meta[CHAT_KEY];
    // 兼容补齐
    const def = defaultChatData();
    for (const k of Object.keys(def)) if (!(k in data)) data[k] = def[k];
    // 旧版全局标签的一次性迁移（每个聊天以旧全局标签为起点，此后各自独立）
    if (!data.tagsMigrated) {
        const legacy = (extension_settings.stecho && extension_settings.stecho.custom && extension_settings.stecho.custom.tags) || [];
        if (!data.tags.length && Array.isArray(legacy) && legacy.length) {
            data.tags = JSON.parse(JSON.stringify(legacy));
        }
        data.tagsMigrated = true;
    }
    return data;
}

/** 立即落盘当前聊天的插件数据。
 *  不用防抖版的原因：酒馆的 openCharacterChat 不会冲刷旧聊天的元数据，
 *  防抖窗口（约1秒）内切聊天会丢刚写入的聊天级数据（测试代理实测）。 */
export function saveChatData() {
    const ctx = getContext();
    if (ctx && typeof ctx.saveMetadata === 'function') {
        ctx.saveMetadata();
        return;
    }
    saveMetadataDebounced();
}

/** 当前聊天末楼（消息总数-1）；无聊天返回 -1 */
export function lastFloor() {
    const chat = getContext().chat;
    return chat && chat.length ? chat.length - 1 : -1;
}

/* ============================== 区间工具 ============================== */

/** 合并相邻/重叠区间，返回排序后的新区间数组 */
export function mergeRanges(ranges) {
    const sorted = (ranges || []).filter(r => r && r[0] != null && r[1] != null && r[1] >= r[0])
        .map(r => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else out.push([r[0], r[1]]);
    }
    return out;
}

/** 区间覆盖的总楼数 */
export function countCovered(ranges) {
    return (ranges || []).reduce((sum, r) => sum + (r[1] - r[0] + 1), 0);
}

/**
 * 删除楼层后的区间平移/收缩。
 * @param {Array} ranges 区间数组
 * @param {number} deletedIndex 被删楼层的原位置
 */
export function shiftRangesOnDelete(ranges, deletedIndex) {
    return (ranges || []).map(([s, e]) => {
        if (e < deletedIndex) return [s, e];
        if (s > deletedIndex) return [s - 1, e - 1];
        // 被删楼层在区间内部：区间收缩一格
        return s === e ? null : [s, e - 1];
    }).filter(Boolean);
}

/**
 * 载入校验：把超出当前末楼的区间修回去。
 * @returns {string[]} 修正说明（空数组 = 无需修正）
 */
export function clampRangesToChat(data) {
    const fixes = [];
    const maxF = lastFloor();
    if (maxF < 0) return fixes;
    const fix = (ranges, label) => (ranges || []).map(([s, e]) => {
        const ns = Math.min(s, maxF);
        const ne = Math.min(e, maxF);
        if (ns !== s || ne !== e) fixes.push(`${label} ${s}~${e} 超出末楼${maxF}，已修正为 ${ns}~${ne}`);
        return [ns, ne];
    }).filter(([s, e]) => e >= s);
    data.coverageRanges = fix(data.coverageRanges, '已总结区间');
    data.hiddenRanges = fix(data.hiddenRanges, '隐藏区间');
    for (const s of data.summaries) {
        if (s.range && s.range[1] > maxF) { fixes.push(`总结条目楼层 ${s.range[0]}~${s.range[1]} 已修正到末楼${maxF}`); s.range = [s.range[0], maxF]; }
    }
    if (data.pendingSmall && data.pendingSmall.range) {
        const r = data.pendingSmall.range;
        if (r[1] > maxF) { fixes.push('待保存预览的区间已修正'); data.pendingSmall.range = [r[0], maxF]; }
    }
    return fixes;
}

/* ============================== 池 ============================== */

/** 池按楼层区间排序（range=null 的排最后，保持相对顺序），返回新数组 */
export function sortedSummaries(data) {
    const withRange = data.summaries.filter(s => s.range);
    const without = data.summaries.filter(s => !s.range);
    withRange.sort((a, b) => (a.range[0] - b.range[0]) || (a.ts - b.ts));
    return [...withRange, ...without];
}

/** 池全文（排序后拼接），供 {{echo}} 宏与注入使用 */
export function getPoolText() {
    const data = getChatData();
    return sortedSummaries(data).map(s => s.text).filter(Boolean).join('\n');
}

/** 删除楼层后，把插件记录的所有楼层区间统一平移/收缩（含池条目的 range 与待保存预览） */
export function shiftAllRangesOnDelete(data, deletedIndex) {
    if (deletedIndex == null || deletedIndex < 0) return;
    data.coverageRanges = shiftRangesOnDelete(data.coverageRanges, deletedIndex);
    data.hiddenRanges = shiftRangesOnDelete(data.hiddenRanges, deletedIndex);
    for (const s of data.summaries) {
        if (!s.range) continue;
        const r = shiftRangesOnDelete([s.range], deletedIndex);
        s.range = r.length ? r[0] : null; // 区间缩没 → 变未关联段落
    }
    if (data.pendingSmall && data.pendingSmall.range) {
        const r = shiftRangesOnDelete([data.pendingSmall.range], deletedIndex);
        data.pendingSmall.range = r.length ? r[0] : [0, -1];
    }
}


/* ============================== 池编辑归位（锚点法） ============================== */

/**
 * 间隙"列表续行"判定：旧条目是列表体（多数行以同一列表符开头）时，间隙里同符开头的行
 * 视为给该条目追加的内容；其余行（手写备注、换格式的新段落）视为游离文字。
 * 旧条目不是列表体（散文）时无法区分，保守全部并入。
 * @returns 间隙中应并入旧条目的结束行（cut 点），[from, cut) 并入、[cut, to) 为游离
 */
function continuationCut(newLines, from, to, oldText) {
    const oldLines = oldText.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
    if (!oldLines.length) return to;
    const m = oldLines[0].match(/^(\s*(?:[-*•+]|\d+[.、．])\s*)/);
    if (!m) return to;
    const marker = m[1].trim();
    const withMarker = oldLines.filter(l => l.trimStart().startsWith(marker)).length;
    if (withMarker < Math.ceil(oldLines.length * 0.6)) return to;
    let cut = from;
    while (cut < to && newLines[cut].trimStart().startsWith(marker)) cut++;
    return cut;
}

/**
 * 池编辑后的归位（锚点法）：
 *  - 以"在旧文本和新文本中都唯一出现的非空行"为锚，把旧条目重新定位到新文本中；
 *  - 条目新文本 = 从它的第一个锚行到下一个条目的第一个锚行之前（吸收了条目内的新增/修改）；
 *  - 一个锚都没有的条目进 removed（调用方可按需处理；当前池与统计解耦，调用方忽略之）；
 *  - 无处归属的游离文字记为"未关联楼层"段落。
 */
export function remapPoolEdit(oldEntries, newText) {
    const oldText = oldEntries.map(e => e.text).join('\n');
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // 统计新旧文本中各非空行的出现次数
    const countIn = (lines) => {
        const map = new Map();
        for (const l of lines) { const t = l.trim(); if (t) map.set(t, (map.get(t) || 0) + 1); }
        return map;
    };
    const oldCount = countIn(oldLines);
    const newCount = countIn(newLines);

    // 旧行 → 条目序号（池文本以单个 \n 拼接条目，join 不产生额外行，故步进 n）
    const lineOwner = [];
    {
        let i = 0;
        oldEntries.forEach((e, idx) => {
            const n = e.text.split('\n').length;
            for (let k = 0; k < n; k++) lineOwner[i + k] = idx;
            i += n;
        });
    }

    // 锚点：在旧/新文本中都唯一出现的非空行；记录它在新文本中的行号
    const anchors = []; // { oldLine, newLine }
    {
        const newLineOfUnique = new Map();
        for (let i = 0; i < newLines.length; i++) {
            const t = newLines[i].trim();
            if (t && newCount.get(t) === 1) newLineOfUnique.set(t, i);
        }
        for (let i = 0; i < oldLines.length; i++) {
            const t = oldLines[i].trim();
            if (!t) continue;
            if (oldCount.get(t) === 1 && newLineOfUnique.has(t)) {
                anchors.push({ oldLine: i, newLine: newLineOfUnique.get(t) });
            }
        }
    }

    // 每个条目的锚点
    const entryAnchors = oldEntries.map(() => []);
    for (const a of anchors) {
        const owner = lineOwner[a.oldLine];
        if (owner != null) entryAnchors[owner].push(a);
    }

    const out = [];
    const removed = [];
    let pos = 0; // 新文本已消费到的行
    const pushResidue = (a, b) => {
        const t = newLines.slice(a, b).join('\n').trim();
        if (t) out.push({ id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, range: null, text: t, ts: Date.now(), unlinked: true });
    };
    const nextAnchorStartAfter = (idx) => {
        for (let j = idx + 1; j < oldEntries.length; j++) {
            if (entryAnchors[j].length) return entryAnchors[j][0].newLine;
        }
        return newLines.length;
    };

    // 依次消费：有锚条目取 [首个锚行, 末锚行+1)；其后的间隙按邻居类型与格式分配
    //  - 下一个是有锚条目 → 间隙按"列表续行"规则处理：与旧条目同列表符的行并入本条，
    //    其余（游离文字）记为未关联段落（如"（手写）备注"、换格式的新段落）
    //  - 下一个是无锚条目组 → 间隙给组内首条（吸收"单条整段改写"），组内其余视为删除
    let k = 0;
    while (k < oldEntries.length) {
        const myAnchors = entryAnchors[k];
        if (myAnchors.length) {
            const startLine = myAnchors[0].newLine;
            pushResidue(pos, startLine);
            const ownEnd = myAnchors[myAnchors.length - 1].newLine + 1;
            let endLine = ownEnd;
            let j = k + 1;
            while (j < oldEntries.length && !entryAnchors[j].length) j++;
            if (j === k + 1) {
                const gapEnd = nextAnchorStartAfter(k);
                endLine = continuationCut(newLines, ownEnd, gapEnd, oldEntries[k].text);
                pushResidue(endLine, gapEnd); // 间隙尾部（非续行）→ 未关联段落
                pos = gapEnd; // 整个间隙已消费（避免后续重复产出游离段落）
            } else {
                pos = endLine;
            }
            out.push({ ...oldEntries[k], text: newLines.slice(startLine, endLine).join('\n').trim() });
            k++;
        } else {
            let j = k;
            while (j < oldEntries.length && !entryAnchors[j].length) j++;
            const group = oldEntries.slice(k, j);
            const gapEnd = (j < oldEntries.length) ? entryAnchors[j][0].newLine : newLines.length;
            const gapText = newLines.slice(pos, gapEnd).join('\n').trim();
            if (gapText) out.push({ ...group[0], text: gapText });
            else removed.push(group[0]); // 间隙为空 → 该条目确实被删
            for (const g of group.slice(1)) removed.push(g);
            pos = gapEnd;
            k = j;
        }
    }
    pushResidue(pos, newLines.length);
    return { entries: out, removed };
}
