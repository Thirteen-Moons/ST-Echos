// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.2

/**
 * ST-Echos 正则引擎。
 *
 * 只作用于"发给总结API的楼层正文"：
 *  - 不改聊天记录、不改显示、不影响酒馆自身的正则；
 *  - 多条按列表顺序依次应用（前一条的替换产物会被后一条再处理）；
 *  - 作用深度：0 = 本次发送内容的最后一条，1 = 倒数第二条，依此类推；留空 = 无限；
 *  - Find 为空或编译失败的条目自动跳过（防空条目把一切匹配掉）。
 *
 * 替换内容支持 $1 $2 等捕获组引用（JS String.replace 原生语法）。
 */

/** 编译条目，返回 { script, regex, error }；空 Find 或编译失败 regex 为 null */
export function compileScript(script) {
    if (!script || typeof script.find !== 'string' || script.find.trim().length === 0) {
        return { script, regex: null, error: 'empty' };
    }
    let src = script.find.trim();
    // 兼容用户写成 /pattern/flags 的形式：剥掉首尾斜杠，flags 与默认 gm 合并（g/m 以我们的为准，保留 i/s/u 等）
    let extraFlags = '';
    const wrapped = src.match(/^\/([\s\S]*)\/([a-z]*)$/);
    if (wrapped && !src.startsWith('//')) {
        src = wrapped[1];
        extraFlags = wrapped[2].replace(/[gm]/g, '');
    }
    try {
        return { script, regex: new RegExp(src, `gm${extraFlags}`), error: null };
    } catch (e) {
        return { script, regex: null, error: String(e && e.message || e) };
    }
}

/**
 * 对楼层正文数组应用全部启用的正则条目。
 * @param {string[]} floorTexts 楼层正文数组（按楼层顺序，最后一条在末尾）
 * @param {Array} scripts 正则条目数组（已按顺序）
 * @param {boolean} enabled 总开关
 * @returns {string[]} 处理后的新数组（不修改原数组）
 */
export function applyRegexToFloors(floorTexts, scripts, enabled) {
    if (!enabled || !Array.isArray(floorTexts) || floorTexts.length === 0) return floorTexts;
    const compiled = (scripts || [])
        .filter(s => s && s.enabled)
        .map(compileScript)
        .filter(c => c.regex !== null);
    if (compiled.length === 0) return floorTexts;

    const lastIndex = floorTexts.length - 1;
    return floorTexts.map((text, i) => {
        const depth = lastIndex - i; // 0 = 最后一条（本次发送内容的末尾）
        let out = String(text);
        for (const { script, regex } of compiled) {
            const min = (script.minDepth == null || script.minDepth === '') ? null : Number(script.minDepth);
            const max = (script.maxDepth == null || script.maxDepth === '') ? null : Number(script.maxDepth);
            if (min != null && depth < min) continue;
            if (max != null && depth > max) continue;
            out = out.replace(regex, script.replace ?? '');
        }
        return out;
    });
}

