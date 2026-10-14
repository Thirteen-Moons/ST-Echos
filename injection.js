// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.0

/**
 * ST-Echos 记忆注入。
 *
 * 用酒馆的 setExtensionPrompt 把"注入模板"送进主 LLM 上下文。
 * 模板里写 {{echo}}（动态宏，指向当前聊天的小总结池）。
 *
 * 关键（审核修正）：setExtensionPrompt 设进去的是快照，必须在以下时机主动刷新：
 *  - 切换聊天（CHAT_CHANGED）
 *  - 池保存 / 编辑 / 清空（summary.js 里调用 refreshInjection）
 *  - 预设切换、注入设置变更
 * 空池或"不注入"时清除注入（设空串即可，酒馆组装时会跳过空内容）。
 */

import { extension_prompt_types, extension_prompt_roles, setExtensionPrompt } from '../../../../script.js';
import { getCurrentSettings } from './settings.js';
import { getPoolText } from './storage.js';

export const INJECTION_KEY = 'stecho_injection';

/**
 * 按当前设置重新计算并刷新注入。
 * @param {object} [opts] { silent: 失败时不弹窗 }
 */
export function refreshInjection() {
    const s = getCurrentSettings();
    const pos = s.injection.position || 'none';
    const template = (s.injection.template || '').trim();

    const clear = () => setExtensionPrompt(INJECTION_KEY, '', extension_prompt_types.IN_PROMPT, 0);

    if (pos === 'none' || !template) { clear(); return; }
    const pool = getPoolText();
    if (!pool) { clear(); return; }

    // 模板未引用宏时，把池内容直接附在模板后面，保证注入有意义
    const value = template.includes('{{echo}}') ? template : `${template}\n{{echo}}`;

    switch (pos) {
        case 'beforeMain': // 主提示词之前
            setExtensionPrompt(INJECTION_KEY, value, extension_prompt_types.BEFORE_PROMPT, 0);
            break;
        case 'afterMain': // 主提示词之后（提示词区内、聊天记录之前）
            setExtensionPrompt(INJECTION_KEY, value, extension_prompt_types.IN_PROMPT, 0);
            break;
        case 'beforeHistory': // 聊天记录之前（最深处）
            setExtensionPrompt(INJECTION_KEY, value, extension_prompt_types.IN_CHAT, 999, false, extension_prompt_roles.SYSTEM);
            break;
        case 'afterHistory': // 聊天记录之后（紧贴最新一条）
            setExtensionPrompt(INJECTION_KEY, value, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
            break;
        case 'depth': { // 指定深度（0=最后一条之后）
            const depth = Math.max(0, parseInt(s.injection.depth, 10) || 0);
            setExtensionPrompt(INJECTION_KEY, value, extension_prompt_types.IN_CHAT, depth, false, extension_prompt_roles.SYSTEM);
            break;
        }
        default:
            clear();
    }
}
