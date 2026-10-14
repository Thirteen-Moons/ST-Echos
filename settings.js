// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.0

/**
 * ST-Echos 设置存储与预设管理。
 *
 * 存储结构（extension_settings.stecho，酒馆自动持久化到 settings.json）：
 * {
 *   version: 1,
 *   presets: { 预设名: { ...面板全量设置 } },   // 多套方案
 *   activePreset: 预设名 | null,               // null = 使用 custom（自定义档）
 *   custom: { ...面板全量设置 },                // 不在任何预设下时的实时设置
 * }
 *
 * 面板全量设置 = 自定义API + 采样 + 正则 + 注入模板 + 小总结 + 大总结 + 标签 + 世界书名。
 * 聊天级数据（总结池、楼层区间等）不在这里，见 storage.js。
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

export const MODULE_KEY = 'stecho';

/** 生成唯一 ID */
export function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) || `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 默认提示词（初始示例，用户可改；改动后生效，不改用默认） */
export const DEFAULT_SMALL_PROMPT = `你是信息提取专家，负责从对话中识别并提取：
1. 与{{user}}相关的关键个人信息（仅限重要信息）
2. {{user}}与{{char}}之间发生的重要事件

# 提取重点
- 关键信息：仅提取{{user}}的重要信息，忽略日常琐事
- 重要事件：记忆深刻的互动，需包含人物、时间、地点（如有）

# 提取范围
- 个人：年龄、生日、职业、学历、居住地
- 偏好：明确表达的喜好或厌恶
- 健康：身体状况、过敏史、饮食禁忌
- 事件：与{{char}}的重要互动、约定
- 关系：家人、朋友、重要同事
- 价值观：表达的信念或长期目标

# 已知信息处理【重要】
<已知信息>
{{echo}}
</已知信息>
- 新信息必须与已知信息比对
- 相同、相似或冲突的信息必须忽略
- 仅提取完全新增且不矛盾的信息

# 输出规范
- 用普通陈述式文本，无需结构化。
- 回复应仅包含总结/提取内容
- 无序列表开头
- 无新信息时返回空白
- 每条60汉字内`;

export const DEFAULT_INJECTION_TEMPLATE = `以下是关于{{char}}与{{user}}之间的关键记忆与事件，旧信息在上，新信息在下：
{{echo}}

# 记忆应用
- 自然运用这些记忆，不刻意展示
- 仅在相关话题出现时引用，避免主动提及
- 对重要信息(如过敏、日期)保持一致性
- 新信息与记忆冲突时，以新信息为准
- 模糊记忆可表达不确定性："记得你似乎说过..."

# 交流方式
- 自然引用："记得你说过..."或"上次我们谈到..."
- 避免机械式表达如"根据我的记忆..."
- 共同经历时可温情回忆："上次我们讨论很有趣"

记忆是丰富对话的工具，而非对话焦点。`;

export const DEFAULT_BIG_PROMPT = `你擅长总结与信息归纳整理，并有着良好的表达能力。
# 任务：将以下内容总结/合并，你的回复应仅包含总结内容。

# 要求：
- 用普通，连贯的陈述式文本，无需结构化；但完全无关的总结条目应使用无序列表。
- 判断内容中是否有相同日期，同一事件。
- 根据相关性进行合并：包括且不限于，同一天发生的琐事，或同一段时间发生的某几件相互有关联的事，或都属于某一类别（如爱好、习惯等）。
- 保留人物、地点、时间、关键事件、情感态度与转折。
- 使用文本中有的具体化的词汇与描述，避免用模糊的抽象化词汇指代概括。
- 总结数量：根据不同事件，可以有一条或多条总结，根据具体内容灵活判断。
- 字数：每一条200汉字内。`;

/** 首次给空内容填入默认提示词（用户改过的不动） */
function fillDefaultPrompts(panel) {
    const small = panel.smallSummary && panel.smallSummary.promptEntries && panel.smallSummary.promptEntries[0];
    if (small && small.content === '') small.content = DEFAULT_SMALL_PROMPT;
    const big = panel.bigSummary && panel.bigSummary.promptEntries && panel.bigSummary.promptEntries[0];
    if (big && big.content === '') big.content = DEFAULT_BIG_PROMPT;
    if (panel.injection && panel.injection.template === '') panel.injection.template = DEFAULT_INJECTION_TEMPLATE;
}

/** 默认的小总结系统提示词条目（首条，真正 system 身份） */
export function defaultSystemEntry() {
    return {
        id: uid(),
        name: '系统提示词',
        role: 'system',
        position: 'relative',      // relative=按条目顺序排；depth=对话中指定深度
        depth: 0,
        content: '',
        enabled: true,
        isSystemFirst: true,       // 锁定为系统身份
    };
}

/** 默认的 Chat History 占位条目（不可编辑内容，只参与排序与定位） */
export function defaultChatHistoryEntry() {
    return {
        id: uid(),
        name: 'Chat History',
        role: 'user',
        position: 'relative',
        depth: 0,
        content: '',
        enabled: true,
        isChatHistory: true,
        locked: true,
    };
}

/** 面板全量设置的默认值 */
export function defaultPanelSettings() {
    return {
        version: 1,
        customApi: { enabled: false, url: '', key: '', model: '' },
        sampling: {
            temperature: null, topP: null, topK: null, minP: null,
            presencePenalty: null, repetitionPenalty: null, maxTokens: null,
        },
        regex: {
            enabled: false,
            scripts: [{ id: uid(), name: '', find: '', replace: '', minDepth: null, maxDepth: null, enabled: false }],
        },
        injection: { position: 'none', depth: 1, template: DEFAULT_INJECTION_TEMPLATE },
        smallSummary: {
            promptEntries: [{ ...defaultSystemEntry(), content: DEFAULT_SMALL_PROMPT }, defaultChatHistoryEntry()],
            autoHide: false,
            showHiddenOverride: false,
            tempShow: { all: true, start: 0, end: 0 },
            showFloorMarkers: false,
            auto: { enabled: false, interval: 50, suspended: false },
            protectionN: 30,
            lazyThreshold: 80,
        },
        bigSummary: {
            auto: { enabled: false, metric: 'chars', threshold: 5000, suspended: false },
            promptEntries: [{ ...defaultSystemEntry(), content: DEFAULT_BIG_PROMPT }],
        },
        tags: [],
        lorebookName: '',
    };
}

/** 深合并：以 defaults 为骨架，data 里已有的字段覆盖（缺啥补啥，防止旧数据缺新字段） */
function mergeDefaults(defaults, data) {
    if (Array.isArray(defaults)) return Array.isArray(data) ? data : defaults;
    if (defaults !== null && typeof defaults === 'object') {
        const out = {};
        for (const key of Object.keys(defaults)) {
            out[key] = mergeDefaults(defaults[key], data ? data[key] : undefined);
        }
        return out;
    }
    return data === undefined ? defaults : data;
}

function ensureStore() {
    if (!extension_settings[MODULE_KEY]) {
        extension_settings[MODULE_KEY] = { version: 1, presets: {}, activePreset: null, custom: defaultPanelSettings() };
    }
    const store = extension_settings[MODULE_KEY];
    if (!store.custom) store.custom = defaultPanelSettings();
    if (!store.presets) store.presets = {};
    if (!('activePreset' in store)) store.activePreset = null;
    return store;
}

/** 加载设置（补齐默认值），返回 store */
export function loadSettings() {
    const store = ensureStore();
    store.custom = mergeDefaults(defaultPanelSettings(), store.custom);
    for (const name of Object.keys(store.presets)) {
        store.presets[name] = mergeDefaults(defaultPanelSettings(), store.presets[name]);
    }
    fillDefaultPrompts(store.custom);
    for (const name of Object.keys(store.presets)) fillDefaultPrompts(store.presets[name]);
    return store;
}

export function saveSettings() {
    saveSettingsDebounced();
}

/** 当前正在编辑的设置对象（活动预设或 custom）。面板控件直接读写它。 */
export function getCurrentSettings() {
    const store = ensureStore();
    if (store.activePreset && store.presets[store.activePreset]) {
        return store.presets[store.activePreset];
    }
    return store.custom;
}

export function getStore() {
    return ensureStore();
}

/** 当前是否有活动预设 */
export function isOnPreset() {
    const store = ensureStore();
    return !!(store.activePreset && store.presets[store.activePreset]);
}

/* ============================== 预设操作 ============================== */

export function listPresets() {
    return Object.keys(ensureStore().presets);
}

/** 切换预设；newPresetName 为 null 表示切到"自定义档" */
export function switchPreset(newPresetName) {
    const store = ensureStore();
    if (newPresetName && !store.presets[newPresetName]) return false;
    store.activePreset = newPresetName;
    saveSettings();
    return true;
}

/** 把当前面板设置保存为预设（已存在则覆盖更新） */
export function savePreset(name) {
    const store = ensureStore();
    const snapshot = JSON.parse(JSON.stringify(getCurrentSettings()));
    const existed = name in store.presets;
    store.presets[name] = snapshot;
    store.activePreset = name;
    saveSettings();
    return existed;
}

/** 新建空预设并切换过去 */
export function createPreset(name) {
    const store = ensureStore();
    if (name in store.presets) return false;
    store.presets[name] = defaultPanelSettings();
    store.activePreset = name;
    saveSettings();
    return true;
}

/** 删除预设；删除的是当前活动预设则切回自定义档 */
export function deletePreset(name) {
    const store = ensureStore();
    if (!(name in store.presets)) return false;
    delete store.presets[name];
    if (store.activePreset === name) store.activePreset = null;
    saveSettings();
    return true;
}

