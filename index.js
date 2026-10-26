// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.2

/**
 * ST-Echos · 聊天记录总结与记忆注入扩展
 * 入口文件（薄）：加载面板模板、绑定 UI、注册宏、挂全局事件。
 */

import { renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { bindPanel, onChatChanged, maybeAutoTrigger } from './panel.js';
import { getPoolText } from './storage.js';
import { shiftAllRangesOnDelete } from './storage.js';

export const EXTENSION_NAME = 'third-party/ST-Echos';

/** 注册 {{echo}} 宏：返回当前聊天的小总结池全文（空池返回空串） */
async function registerMacro() {
    const ctx = getContext();
    const handler = () => getPoolText();
    try {
        if (ctx.macros && typeof ctx.macros.register === 'function') {
            ctx.macros.register('echo', {
                description: 'ST-Echos：当前聊天的小总结池全文',
                handler,
            });
            console.log('[ST-Echos] {{echo}} 宏已注册（新宏引擎）');
            return;
        }
        throw new Error('新宏引擎不可用');
    } catch (e) {
        try {
            const { MacrosParser } = await import('../../../macros.js');
            MacrosParser.registerMacro('echo', handler, 'ST-Echos：当前聊天的小总结池全文');
            console.log('[ST-Echos] {{echo}} 宏已注册（兼容模式）');
        } catch (e2) {
            console.error('[ST-Echos] {{echo}} 宏注册失败:', e2);
        }
    }
}

jQuery(async () => {
    try {
        const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
        $('#extensions_settings').append(settingsHtml);
        bindPanel();
        registerMacro();

        // 切换聊天后：暂存/丢弃未保存编辑、整体重渲染面板、刷新注入（防串聊天）
        eventSource.on(event_types.CHAT_CHANGED, () => {
            onChatChanged();
        });

        // 调试钩子（供自动化测试与排查；不影响功能）
        window.__stecho = { maybeAutoTrigger, testShift: (data, idx) => { shiftAllRangesOnDelete(data, idx); return data; } };

        console.log('[ST-Echos] 面板已加载');
    } catch (error) {
        console.error('[ST-Echos] 面板加载失败:', error);
    }
});
