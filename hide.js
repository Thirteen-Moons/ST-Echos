// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.0

/**
 * ST-Echos 楼层隐藏/恢复。
 *
 * 用酒馆官方机制：message.is_system = true（不发给主LLM，界面变灰仍可见，随聊天文件持久）。
 * 铁律：
 *  - 只按 hiddenRanges（插件自己的隐藏记录）操作，绝不扫描/恢复用户手动隐藏的楼层；
 *  - 跳过叙事者系统消息（extra.type === 'narrator'）：它不是我们隐藏的，任何时候都不动它；
 *  - 「临时显示已隐藏的楼层」= 临时把某段已隐藏楼层恢复显示（可选"所有"或指定区间），
 *    不触碰统计数据；关闭临时显示后按 hiddenRanges 重新隐藏。
 */

import { getContext } from '../../../extensions.js';
import { mergeRanges } from './storage.js';
import { NARRATOR_TYPE } from './prompts.js';

function isInRanges(index, ranges) {
    return (ranges || []).some(([s, e]) => index >= s && index <= e);
}

function isNarrator(m) {
    return !!(m && m.extra && m.extra.type === NARRATOR_TYPE);
}

/**
 * 统一应用可见性。铁律：只翻转"插件管理集"（hiddenRanges 命中的楼层），
 * 管理集之外的楼层一律不动——那里可能有用户手动隐藏的楼层，绝不能替用户恢复显示。
 * @param {Array} hiddenRanges 插件隐藏的楼层区间
 * @param {Array|null} tempVisibleRanges 临时显示区间（null/undefined = 无临时显示）；
 *        命中此区间的管理集楼层强制可见，其余管理集楼层隐藏。
 */
export async function applyVisibility(hiddenRanges, tempVisibleRanges) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    let changed = false;
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || isNarrator(m)) continue;
        if (!isInRanges(i, hiddenRanges)) continue; // 插件管理集之外：不碰
        const tempShown = !!(tempVisibleRanges && isInRanges(i, tempVisibleRanges));
        const target = !tempShown; // is_system = 隐藏
        if (target !== !!m.is_system) {
            m.is_system = target;
            $(`.mes[mesid="${i}"]`).attr('is_system', String(target));
            changed = true;
        }
    }
    if (changed) await ctx.saveChat();
}

/** 保存小总结成功后：并入 hiddenRanges；deferApply 时只记不藏（"临时显示"勾选期间），取消勾选后由 applyVisibility 按记录恢复 */
export async function hideFloors(data, start, end, { deferApply = false } = {}) {
    data.hiddenRanges = mergeRanges([...data.hiddenRanges, [start, end]]);
    if (deferApply) return;
    await applyVisibility(data.hiddenRanges, null);
}
