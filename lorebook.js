// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.0

/**
 * ST-Echos 世界书（lorebook）读写。
 *
 * 目标世界书解析顺序：①聊天绑定的聊天世界书（chat_metadata.world_info）
 * → ②角色主世界书（characters[chid].data.extensions.world）→ ③面板手填名（不存在则新建）。
 *
 * 条目约定：comment 以 "ST-Echos大总结" 前缀标识本插件的条目（下拉列表靠它识别）；
 * 创建默认值写死：constant=true（常驻注入）、position=0（角色定义之前）、order=100、
 * preventRecursion=true、excludeRecursion=false。
 * 创建后插件只改 comment/content——用户在世界书里改的 关闭/关键词/位置 均保留。
 */

import { getContext } from '../../../extensions.js';
import { loadWorldInfo, createWorldInfoEntry, saveWorldInfo, METADATA_KEY } from '../../../world-info.js';

export const ENTRY_COMMENT_PREFIX = 'ST-Echos大总结';

/** 解析目标世界书名；都解析不到返回 null（调用方兜底手填名或报错） */
export async function resolveWorldbookName() {
    const ctx = getContext();
    const chatWorld = ctx.chatMetadata && ctx.chatMetadata[METADATA_KEY];
    if (chatWorld) return chatWorld;
    const chid = ctx.characterId;
    const charWorld = chid != null && ctx.characters && ctx.characters[chid] && ctx.characters[chid].data && ctx.characters[chid].data.extensions && ctx.characters[chid].data.extensions.world;
    if (charWorld) return charWorld;
    return null;
}

/** 列出目标世界书中本插件的大总结条目 */
export async function listSummaryEntries(worldName) {
    if (!worldName) return [];
    const data = await loadWorldInfo(worldName);
    if (!data || !data.entries) return [];
    return Object.values(data.entries)
        .filter(e => e && typeof e.comment === 'string' && e.comment.startsWith(ENTRY_COMMENT_PREFIX))
        .map(e => ({ uid: e.uid, comment: e.comment, chars: (e.content || '').length }))
        .sort((a, b) => a.comment.localeCompare(b.comment, 'zh'));
}

/** 创建一个新的大总结条目（空内容，constant 注入；只创建，内容由保存时追加） */
export async function createSummaryEntry(worldName, comment) {
    const data = await loadWorldInfo(worldName);
    if (!data) throw new Error(`世界书「${worldName}」不存在或读取失败`);
    const entry = createWorldInfoEntry(worldName, data);
    if (!entry) throw new Error('创建世界书条目失败（UID 分配失败）');
    Object.assign(entry, {
        comment,
        content: '',
        constant: true,
        position: 0,              // 角色定义之前
        order: 100,
        preventRecursion: true,
        excludeRecursion: false,
    });
    await saveWorldInfo(worldName, data, true);
    return { uid: entry.uid, comment: entry.comment };
}

/**
 * 把文本追加进条目（旧内容在上，新内容在下）。
 * @param {object} target { name: 世界书名, uid?, comment? }
 * @returns {Promise<{name, uid, comment}>} 实际写入的条目定位信息
 */
export async function appendToEntry(target, text) {
    const worldName = target.name;
    if (!worldName) throw new Error('未指定目标世界书');
    const data = await loadWorldInfo(worldName);
    if (!data || !data.entries) throw new Error(`世界书「${worldName}」不存在或读取失败`);

    let entry = target.uid != null ? data.entries[target.uid] : null;
    if (!entry && target.comment) {
        entry = Object.values(data.entries).find(e => e && e.comment === target.comment);
    }
    if (!entry) {
        entry = createWorldInfoEntry(worldName, data);
        if (!entry) throw new Error('创建世界书条目失败（UID 分配失败）');
        Object.assign(entry, {
            constant: true,
            position: 0,
            order: 100,
            preventRecursion: true,
            excludeRecursion: false,
        });
    }
    // 自动创建的条目按聊天命名，便于"自动档"下次复用识别，也避免堆积同名条目
    entry.comment = target.comment || entry.comment || `${ENTRY_COMMENT_PREFIX}-${getContext().chatId || '未命名聊天'}`;
    entry.content = entry.content ? `${entry.content}\n${text}` : text;
    await saveWorldInfo(worldName, data, true);
    return { name: worldName, uid: entry.uid, comment: entry.comment };
}
