// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.2

/**
 * ST-Echos 标签解析与筛选。
 *
 * 匹配规则：关键词对"整行摘要文本"做包含匹配——某行命中标签的任一词即归入该标签。
 * 筛选时实时计算（不建索引），编辑池文本后标签即时生效。
 */

/** 某行是否命中某标签（标签的任一词出现在行内即命中） */
export function lineMatchesTag(line, tag) {
    const lineStr = String(line || '');
    if (!lineStr.trim()) return false;
    const kws = tag.keywords && tag.keywords.length ? tag.keywords : [tag.name];
    for (const kw of kws) {
        const k = String(kw).trim();
        if (k && lineStr.includes(k)) return true;
    }
    return false;
}

/** 池全文 + 选中标签 → 筛选后的文本（多选 = AND：行须同时命中全部所选标签） */
export function filterPoolText(poolText, tags, selectedTagIds) {
    const ids = (selectedTagIds || []).filter(Boolean);
    if (!ids.length) return poolText;
    const selected = tags.filter(t => ids.includes(t.id));
    if (!selected.length) return poolText;
    return String(poolText || '').split('\n')
        .filter(line => line.trim() && selected.every(tag => lineMatchesTag(line, tag)))
        .join('\n');
}

/** 池的列表符行数（行首 - 或 * 且后跟空格） */
export function countListItems(poolText) {
    const re = /^[-*]\s/gm;
    const m = String(poolText || '').match(re);
    return m ? m.length : 0;
}
