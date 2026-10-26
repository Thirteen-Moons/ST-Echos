// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.2

/**
 * ST-Echos 面板 UI 绑定。
 * 步骤2：预设管理条的渲染与交互（切换/保存/新建/删除，含脏检查）。
 * 后续步骤会往 bindPanel 里追加各板块的绑定函数。
 */

import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import {
    loadSettings, saveSettings, listPresets, getStore, isOnPreset,
    switchPreset, savePreset, createPreset, deletePreset, getCurrentSettings,
} from './settings.js';
import { isDirty, clearDirty, markDirty, runtime } from './state.js';
import { testConnection } from './api.js';
import { renderEntryList, escapeHtml, escapeAttr } from './entries.js';
import { compileScript } from './regex.js';
import { uid } from './settings.js';
import { refreshInjection } from './injection.js';
import { getContext } from '../../../extensions.js';
import {
    getChatData, saveChatData, lastFloor, sortedSummaries, clampRangesToChat,
    shiftAllRangesOnDelete, countCovered, remapPoolEdit,
} from './storage.js';
import {
    runSmallSummary, regenerateSmallSummary, listSmallGenerations, selectSmallGeneration,
    saveSmallSummary, computableRange, uncoveredParts, statsText, SummaryError,
    runBigSummary, regenerateBigSummary, listBigGenerations, selectBigGeneration,
    saveBigSummaryCore, snapshotOfPool, bigSummaryThresholdMet,
} from './summary.js';
import { filterPoolText } from './tags.js';
import { resolveWorldbookName, listSummaryEntries, createSummaryEntry, ENTRY_COMMENT_PREFIX } from './lorebook.js';
import { applyVisibility } from './hide.js';
import { getFloors } from './prompts.js';
import { applyRegexToFloors } from './regex.js';
import { eventSource, event_types, streamingProcessor } from '../../../../script.js';
import { debounce } from '../../../utils.js';

/* ============================== 采样滑块定义 ============================== */
/* 滑块最左（0）= OFF（null，不传给API）。from/to 为滑块值与真实值的换算。 */
const SAMPLING_DEFS = [
    { key: 'temperature', name: 'Temperature', cn: '随机性', max: 200, from: v => v / 100, to: v => Math.round(v * 100), fmt: v => v.toFixed(2) },
    { key: 'topP', name: 'Top-p', cn: '核采样', max: 100, from: v => v / 100, to: v => Math.round(v * 100), fmt: v => v.toFixed(2) },
    { key: 'topK', name: 'Top-k', cn: '候选数量', max: 100, from: v => v, to: v => v, fmt: v => String(v) },
    { key: 'minP', name: 'Min-p', cn: '最小概率', max: 100, from: v => v / 100, to: v => Math.round(v * 100), fmt: v => v.toFixed(2) },
    { key: 'presencePenalty', name: 'Presence Penalty', cn: '存在惩罚', max: 400, offset: -200, from: v => (v - 200) / 100, to: v => Math.round(v * 100) + 200, fmt: v => v.toFixed(2) },
    { key: 'repetitionPenalty', name: 'Repetition Penalty', cn: '重复惩罚', max: 200, from: v => v / 100, to: v => Math.round(v * 100), fmt: v => v.toFixed(2) },
    { key: 'maxTokens', name: 'Max tokens', cn: '最大生成长度', max: 511, from: v => v * 16, to: v => Math.round(v / 16), fmt: v => String(v) },
];

function buildSamplingUI() {
    const $wrap = $('#stecho_sampling_sliders');
    $wrap.empty();
    for (const def of SAMPLING_DEFS) {
        const $row = $(`
            <div class="stecho-slider-row" data-key="${def.key}">
                <div class="stecho-slider-head">
                    <span class="stecho-slider-name">${def.name}<span class="stecho-hint">${def.cn}</span></span>
                    <span class="stecho-slider-val">OFF</span>
                </div>
                <input type="range" min="0" max="${def.max}" value="0" step="1" />
            </div>`);
        $wrap.append($row);
    }
}

function setSliderValue(key, realValue) {
    const def = SAMPLING_DEFS.find(d => d.key === key);
    const $row = $(`.stecho-slider-row[data-key="${key}"]`);
    if (!def || !$row.length) return;
    const sliderVal = (realValue == null) ? 0 : def.to(realValue);
    $row.find('input[type=range]').val(sliderVal);
    $row.find('.stecho-slider-val').text(realValue == null ? 'OFF' : def.fmt(realValue));
}

function bindSamplingSection() {
    buildSamplingUI();
    $('#stecho_sampling_sliders').on('input', 'input[type=range]', function () {
        const key = $(this).closest('.stecho-slider-row').data('key');
        const def = SAMPLING_DEFS.find(d => d.key === key);
        const sliderVal = Number($(this).val());
        const real = sliderVal === 0 ? null : def.from(sliderVal);
        $(this).closest('.stecho-slider-row').find('.stecho-slider-val').text(real == null ? 'OFF' : def.fmt(real));
        getCurrentSettings().sampling[key] = real;
        saveSettings();
        markDirty('sampling');
    });
}

/* ============================== 自定义API区 ============================== */

function bindApiSection() {
    const settings = () => getCurrentSettings().customApi;

    const syncDetailsVisibility = () => {
        $('#stecho_api_details').toggle(settings().enabled);
    };

    $('#stecho_api_enabled').on('change', function () {
        settings().enabled = $(this).is(':checked');
        syncDetailsVisibility();
        saveSettings();
        markDirty('api');
    });

    $('#stecho_api_url').on('input', function () {
        settings().url = $(this).val().trim();
        saveSettings();
        markDirty('api');
    });

    $('#stecho_api_key').on('input', function () {
        settings().key = $(this).val();
        saveSettings();
        markDirty('api');
    });

    $('#stecho_api_model').on('input', function () {
        settings().model = $(this).val().trim();
        saveSettings();
        markDirty('api');
    });

    $('#stecho_api_key_toggle').on('click', function () {
        const $key = $('#stecho_api_key');
        const show = $key.attr('type') === 'password';
        $key.attr('type', show ? 'text' : 'password');
        $(this).find('i').toggleClass('fa-eye fa-eye-slash');
    });

    $('#stecho_api_connect').on('click', async () => {
        const $btn = $('#stecho_api_connect'); // 箭头函数里 this 是 undefined，直接按 id 取
        const $status = $('#stecho_api_status');
        $btn.prop('disabled', true);
        $status.text('连接中…');
        try {
            const { models } = await testConnection({ url: settings().url, key: settings().key });
            if (models.length) {
                const $list = $('#stecho_api_models');
                $list.empty();
                for (const m of models) $list.append(`<option value="${escapeAttr(m)}"></option>`);
                $status.text(`连接成功，发现 ${models.length} 个模型（已填入候选列表）`);
                if (!settings().model) {
                    // 不自动填模型名，只提示候选；保持用户选择自由
                }
            } else {
                $status.text('连接成功');
            }
            toastr.success('自定义API连接成功');
        } catch (e) {
            $status.text(String(e && e.message || e));
            toastr.error(`连接失败：${String(e && e.message || e)}`);
        } finally {
            $btn.prop('disabled', false);
        }
    });

    syncDetailsVisibility();
}

/* ============================== 正则区 ============================== */

function renderRegexList() {
    const scripts = getCurrentSettings().regex.scripts;
    renderEntryList({
        $container: $('#stecho_regex_list'),
        entries: scripts,
        options: { grayOut: (s) => compileScript(s).regex === null },
        callbacks: {
            onToggle: (id, checked) => {
                const s = scripts.find(x => x.id === id);
                if (s) { s.enabled = checked; saveSettings(); markDirty('regex'); }
            },
            onEdit: (id) => openRegexEditor(id),
            onDelete: async (id) => {
                const s = scripts.find(x => x.id === id);
                const ok = await callGenericPopup(`确定删除正则条目「${s && s.name || ''}」吗？`, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: '取消' });
                if (!ok) return;
                const i = scripts.findIndex(x => x.id === id);
                if (i >= 0) scripts.splice(i, 1);
                saveSettings();
                markDirty('regex');
                renderRegexList();
            },
            onReorder: (orderedIds) => {
                const map = new Map(scripts.map(s => [s.id, s]));
                scripts.length = 0;
                scripts.push(...orderedIds.map(id => map.get(id)).filter(Boolean));
                saveSettings();
                markDirty('regex');
                renderRegexList();
            },
        },
    });
}

async function openRegexEditor(existingId) {
    const scripts = getCurrentSettings().regex.scripts;
    const existing = existingId ? scripts.find(s => s.id === existingId) : null;
    const $editor = $(`
        <div class="stecho-regex-editor">
            <div class="stecho-field">
                <label class="stecho-field-label">名称</label>
                <input type="text" class="re-name stecho-input text_pole" />
            </div>
            <div class="stecho-field">
                <label class="stecho-field-label">正则表达式（Find Regex）</label>
                <textarea class="re-find stecho-input" rows="3" placeholder="匹配发送给总结API的楼层内容"></textarea>
            </div>
            <div class="stecho-field">
                <label class="stecho-field-label">替换内容（Replace With，支持 $1、$2 捕获组）</label>
                <textarea class="re-replace stecho-input" rows="3"></textarea>
            </div>
            <div class="stecho-field">
                <label class="stecho-field-label">作用深度（0 = 本次发送内容的最后一条；留空 = 不限）</label>
                <div class="stecho-row">
                    <input type="number" class="re-min stecho-input text_pole" min="0" placeholder="最小深度" style="max-width:110px" />
                    <span>~</span>
                    <input type="number" class="re-max stecho-input text_pole" min="0" placeholder="最大深度" style="max-width:110px" />
                </div>
            </div>
            <details class="stecho-regex-test">
                <summary>测试（可选）</summary>
                <textarea class="re-test-input stecho-input" rows="4" placeholder="粘贴一段楼层内容，实时查看替换结果"></textarea>
                <pre class="re-test-output"></pre>
            </details>
        </div>`);

    if (existing) {
        $editor.find('.re-name').val(existing.name || '');
        $editor.find('.re-find').val(existing.find || '');
        $editor.find('.re-replace').val(existing.replace || '');
        $editor.find('.re-min').val(existing.minDepth ?? '');
        $editor.find('.re-max').val(existing.maxDepth ?? '');
    }

    const runTest = () => {
        const probe = {
            find: String($editor.find('.re-find').val()),
            replace: String($editor.find('.re-replace').val()),
            enabled: true,
        };
        const { regex, error } = compileScript(probe);
        const $out = $editor.find('.re-test-output');
        const input = String($editor.find('.re-test-input').val());
        if (error === 'empty') { $out.text('（正则表达式为空）'); return; }
        if (!regex) { $out.text(`（正则编译失败：${error}）`); return; }
        $out.text(input.replace(regex, probe.replace ?? ''));
    };
    $editor.find('textarea').on('input', runTest);

    const ok = await callGenericPopup($editor, POPUP_TYPE.CONFIRM, '', { okButton: '保存', cancelButton: '取消', allowVerticalScrolling: true });
    if (!ok) return;

    const entry = existing || { id: uid(), enabled: true };
    entry.name = String($editor.find('.re-name').val()).trim() || '未命名正则';
    entry.find = String($editor.find('.re-find').val());
    entry.replace = String($editor.find('.re-replace').val());
    const minRaw = String($editor.find('.re-min').val()).trim();
    const maxRaw = String($editor.find('.re-max').val()).trim();
    entry.minDepth = minRaw === '' ? null : Math.max(0, parseInt(minRaw, 10) || 0);
    entry.maxDepth = maxRaw === '' ? null : Math.max(0, parseInt(maxRaw, 10) || 0);
    if (!existing) scripts.push(entry);
    saveSettings();
    markDirty('regex');
    renderRegexList();
}

function bindRegexSection() {
    $('#stecho_regex_enabled').on('change', function () {
        getCurrentSettings().regex.enabled = $(this).is(':checked');
        $('#stecho_regex_details').toggle($(this).is(':checked'));
        saveSettings();
        markDirty('regex');
    });
    $('#stecho_regex_new').on('click', () => openRegexEditor(null));
    $('#stecho_regex_details').toggle(!!getCurrentSettings().regex.enabled);
    renderRegexList();
}

/* ============================== 注入模板区 ============================== */

function bindInjectionSection() {
    const settings = () => getCurrentSettings().injection;
    const syncDepthField = () => {
        $('#stecho_injection_depth_field').toggle(settings().position === 'depth');
    };
    $('#stecho_injection_position').on('change', function () {
        settings().position = $(this).val();
        syncDepthField();
        saveSettings();
        markDirty('injection');
        refreshInjection();
    });
    $('#stecho_injection_depth').on('input', function () {
        settings().depth = Math.max(0, parseInt($(this).val(), 10) || 0);
        saveSettings();
        markDirty('injection');
        refreshInjection();
    });
    $('#stecho_injection_template').on('input', function () {
        settings().template = $(this).val();
        saveSettings();
        markDirty('injection');
        refreshInjection();
    });
    syncDepthField();
}

/* ============================== 小总结区 ============================== */

const PROMPT_ICONS = { system: 'fa-shield-halved', user: 'fa-user', assistant: 'fa-robot' };

function renderPromptList() {
    const entries = getCurrentSettings().smallSummary.promptEntries;
    const lockedIds = new Set(entries.filter(e => e.isSystemFirst || e.isChatHistory).map(e => e.id));
    renderEntryList({
        $container: $('#stecho_prompt_list'),
        entries,
        options: {
            iconField: null,
            lockedIds,
            dragExclude: (e) => !!e.isSystemFirst,
            grayOut: null,
        },
        callbacks: {
            onToggle: (id, checked) => {
                const e = entries.find(x => x.id === id);
                if (e) { e.enabled = checked; saveSettings(); markDirty('prompt'); }
            },
            onEdit: (id) => openPromptEditor(id),
            onDelete: async (id) => {
                const e = entries.find(x => x.id === id);
                const ok = await callGenericPopup(`确定删除提示词条目「${e && e.name || ''}」吗？`, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: '取消' });
                if (!ok) return;
                const i = entries.findIndex(x => x.id === id);
                if (i >= 0) entries.splice(i, 1);
                saveSettings();
                markDirty('prompt');
                renderPromptList();
            },
            onReorder: (orderedIds) => {
                const map = new Map(entries.map(e => [e.id, e]));
                entries.length = 0;
                entries.push(...orderedIds.map(id => map.get(id)).filter(Boolean));
                saveSettings();
                markDirty('prompt');
                renderPromptList();
            },
        },
    });
    // 身份图标
    $('#stecho_prompt_list .stecho-entry').each(function () {
        const id = $(this).data('id');
        const e = entries.find(x => x.id === id);
        if (e) $(this).find('.stecho-entry-icon').attr('class', `fa-solid ${e.isChatHistory ? 'fa-thumbtack' : (PROMPT_ICONS[e.role] || 'fa-rectangle-list')} stecho-entry-icon`);
    });
}

async function openPromptEditor(existingId) {
    const entries = getCurrentSettings().smallSummary.promptEntries;
    const existing = entries.find(e => e.id === existingId);
    if (!existing) return;
    const isFirstSystem = !!existing.isSystemFirst;
    const isChatHistory = !!existing.isChatHistory;

    const $editor = $(`
        <div class="stecho-prompt-editor">
            <div class="stecho-hint" style="margin-bottom:6px">系统身份的条目会合并为一条 system 消息、固定置于最前（OpenAI 兼容端点惯例）；拖拽排序在用户/助手条目之间生效。Chat History 条目内容=所有未隐藏的聊天记录。</div>
            <div class="stecho-field">
                <label class="stecho-field-label">名称</label>
                <input type="text" class="pe-name stecho-input text_pole" ${isChatHistory ? 'disabled' : ''} />
            </div>
            <div class="stecho-field">
                <label class="stecho-field-label">身份</label>
                <select class="pe-role stecho-select text_pole" ${isFirstSystem ? 'disabled' : ''}>
                    <option value="system">系统（以真正的 system 身份发送）</option>
                    <option value="user">用户</option>
                    <option value="assistant">助手</option>
                </select>
            </div>
            <div class="stecho-field">
                <label class="stecho-field-label">注入位置</label>
                <select class="pe-position stecho-select text_pole">
                    <option value="relative">相对（按条目排序进入提示词）</option>
                    <option value="depth">对话中的指定深度</option>
                </select>
            </div>
            <div class="stecho-field pe-depth-field" style="display:none">
                <label class="stecho-field-label">注入深度（0 = 最后一条之后，1 = 之前，依此类推）</label>
                <input type="number" class="pe-depth stecho-input text_pole" min="0" value="0" />
            </div>
            <div class="stecho-field">
                <label class="stecho-field-label">内容</label>
                <textarea class="pe-content stecho-input" rows="8" ${isChatHistory ? 'disabled' : ''} placeholder="这里写这条提示词的作用（Chat History 条目不可编辑，内容=所有未隐藏的聊天记录）"></textarea>
            </div>
        </div>`);

    $editor.find('.pe-name').val(existing.name || '');
    $editor.find('.pe-role').val(existing.role || 'user');
    $editor.find('.pe-position').val(existing.position || 'relative');
    $editor.find('.pe-depth').val(existing.depth ?? 0);
    $editor.find('.pe-content').val(existing.content || '');
    const syncDepth = () => $editor.find('.pe-depth-field').toggle($editor.find('.pe-position').val() === 'depth');
    $editor.find('.pe-position').on('change', syncDepth);
    syncDepth();

    const ok = await callGenericPopup($editor, POPUP_TYPE.CONFIRM, '', { okButton: '保存', cancelButton: '取消', allowVerticalScrolling: true });
    if (!ok) return;
    if (!isChatHistory) {
        existing.name = String($editor.find('.pe-name').val()).trim() || '未命名';
        existing.content = String($editor.find('.pe-content').val());
    }
    if (!isFirstSystem) existing.role = String($editor.find('.pe-role').val());
    existing.position = String($editor.find('.pe-position').val());
    existing.depth = Math.max(0, parseInt($editor.find('.pe-depth').val(), 10) || 0);
    saveSettings();
    markDirty('prompt');
    renderPromptList();
}

/* ---------- 6.6 预览 ---------- */

function currentPreviewText() {
    const data = getChatData();
    if (!data.pendingSmall) return '';
    return (data.pendingSmall.generations || [])[data.pendingSmall.current] ?? '';
}

function renderPreview() {
    const data = getChatData();
    runtime.currentChatPending = !!data.pendingSmall;
    const $preview = $('#stecho_preview');
    if (!$preview.data('focused')) $preview.val(currentPreviewText());
    const p = data.pendingSmall;
    const count = p ? (p.generations || []).length : 0;
    const $badge = $('#stecho_history_badge');
    if (count > 1) { $badge.text(count).show(); } else { $badge.hide(); }
    $('#stecho_preview_save').prop('disabled', !p);
    $('#stecho_preview_regen').prop('disabled', !p);
    $('#stecho_preview_history').prop('disabled', count <= 1);
}

async function openHistoryPopup() {
    const gens = listSmallGenerations();
    if (!gens.length) return;
    const data = getChatData();
    const $list = $('<div class="stecho-history-list"></div>');
    gens.forEach((g, i) => {
        const isCur = data.pendingSmall && data.pendingSmall.current === i;
        const $item = $(`<div class="stecho-history-item ${isCur ? 'current' : ''}" data-i="${i}">
            <b>第 ${i + 1} 次生成</b><span class="stecho-hint">${escapeHtml(String(g).slice(0, 80))}…</span>
        </div>`);
        $list.append($item);
    });
    const popup = callGenericPopup($list, POPUP_TYPE.DISPLAY, '', {});
    $list.on('click', '.stecho-history-item', function () {
        const i = Number($(this).data('i'));
        selectSmallGeneration(i);
        renderPreview();
        // 关闭弹窗
        $(document).find('.popup-button-close, .popup-x-close').first().click();
    });
    await popup;
}

/* ---------- 6.5 手动总结 ---------- */

async function updateManualTokenCount() {
    const s = parseInt($('#stecho_manual_start').val(), 10);
    const e = parseInt($('#stecho_manual_end').val(), 10);
    const $label = $('#stecho_manual_token');
    if (isNaN(s) || isNaN(e) || e < s || s < 0) { $label.text('所选内容 token 数：—'); return; }
    const { floors, skipped } = getFloors(s, e);
    if (!floors.length) {
        $label.text(skipped.length ? `所选区间的楼层均被手动隐藏（${skipped.length} 层），没有可发送的内容` : '所选内容 token 数：—');
        return;
    }
    // 与实际发送保持一致：楼层正文先过正则，再拼名字计数
    const settings = getCurrentSettings();
    const processedMes = applyRegexToFloors(floors.map(f => f.mes), settings.regex.scripts, settings.regex.enabled);
    const text = floors.map((f, i) => `${f.name}: ${processedMes[i]}`).join('\n');
    try {
        const n = await getContext().getTokenCountAsync(text);
        const skipNote = skipped.length ? `（已跳过 ${skipped.length} 层手动隐藏）` : '';
        $label.text(`所选内容 token 数：约 ${n}${skipNote}${n > 16000 ? '（偏大，注意总结API的上下文上限）' : ''}`);
    } catch {
        $label.text('所选内容 token 数：计算失败');
    }
}

async function onManualSummarize() {
    const s = getCurrentSettings();
    const data = getChatData();
    const start = parseInt($('#stecho_manual_start').val(), 10);
    const end = parseInt($('#stecho_manual_end').val(), 10);
    const last = lastFloor();
    if (isNaN(start) || isNaN(end) || start < 0 || start > end || end > last) {
        toastr.error(`楼层范围无效：需满足 0 ≤ 起 ≤ 止 ≤ 当前末楼（${last}）`);
        return;
    }
    // 可见楼层保护
    const N = Math.max(0, s.smallSummary.protectionN | 0);
    if (last - end < N) {
        await callGenericPopup(`与楼层保护的设置不符：总结 ${start}~${end} 后，可见楼层将少于 ${N} 条。请再多聊几楼再总结。`, POPUP_TYPE.CONFIRM, '', { okButton: '知道了', cancelButton: false });
        return;
    }
    // 范围重叠 → 三选一（customButtons 的 result 即返回值）
    let range = [start, end];
    const overlaps = (data.coverageRanges || []).some(([cs, ce]) => end >= cs && start <= ce);
    if (overlaps) {
        const choice = await callGenericPopup(
            `范围 ${start}~${end} 与已总结的楼层有重叠。要怎么处理？`,
            POPUP_TYPE.TEXT,
            '',
            {
                customButtons: [
                    { text: '只总结未覆盖部分', result: 1 },
                    { text: '重新总结全部范围', result: 2 },
                    { text: '取消', result: 0 },
                ],
            },
        );
        if (!choice) return; // 取消或关窗
        if (choice === 1) {
            const parts = uncoveredParts(data, start, end);
            if (!parts.length) { toastr.info('该范围已全部总结过了'); return; }
            if (parts.length > 1) toastr.info(`未覆盖部分有 ${parts.length} 段，本次先总结第一段 ${parts[0][0]}~${parts[0][1]}，其余请再操作一次`);
            range = parts[0];
        }
        // choice === 2：重新总结全部范围，直接用原 range
    }
    await doSummarize(range[0], range[1], 'manual');
}

async function doSummarize(start, end, source) {
    if (runtime.generating) return;
    runtime.generating = true;
    const $btn = source === 'manual' ? $('#stecho_manual_run') : null;
    if ($btn) $btn.prop('disabled', true);
    toastr.info(`正在总结 ${start}~${end} ……`, 'ST-Echos');
    try {
        const { floorChanged } = await runSmallSummary(start, end, { source });
        renderPreview();
        if (source === 'auto') {
            const go = await callGenericPopup('自动小总结已生成，要去预览保存吗？（不保存则暂存预览，继续聊不会重复总结）', POPUP_TYPE.CONFIRM, '', { okButton: '去预览', cancelButton: '稍后' });
            if (go) scrollToPreview();
        } else if (floorChanged) {
            toastr.warning('总结期间楼层有变动，保存时会再次确认');
        }
    } catch (e) {
        const msg = e instanceof SummaryError ? e.message : String(e && e.message || e);
        if (source === 'auto') {
            // 暂停态横幅先设置（带失败原因），再弹失败对话框
            $('#stecho_auto_fail_reason').text(msg);
            $('#stecho_auto_suspended').show();
        }
        if (e instanceof SummaryError && e.code === 'chat-changed') {
            toastr.warning(msg);
        } else {
            await callGenericPopup(`总结失败：${msg}`, POPUP_TYPE.CONFIRM, '', { okButton: '知道了', cancelButton: false });
        }
        renderPreview();
    } finally {
        runtime.generating = false;
        if ($btn) $btn.prop('disabled', false);
    }
}

/** 打开右侧扩展抽屉：酒馆的开关绑在 .drawer-toggle 上（点容器无效） */
function openExtensionsDrawer() {
    if (!$('#rm_extensions_block').hasClass('closedDrawer')) return;
    const $t = $('#extensions-settings-button .drawer-toggle');
    if ($t.length) $t.first().trigger('click');
    else $('#rm_extensions_block').removeClass('closedDrawer');
}

/** 展开 ST-Echos 内层抽屉；对第三方抽屉动画类扩展（如 cocktail 的 ui-animation-optimizer）
 *  的兼容兜底：点开关后仍被收起时，500ms 后直接显示 */
function revealInlineDrawer($header, $drawer) {
    if ($drawer.is(':hidden')) $header.trigger('click');
    setTimeout(() => { if ($drawer.is(':hidden')) $drawer.show(); }, 500);
}

function scrollToPreview() {
    openExtensionsDrawer();
    $('#stecho_section_small').removeClass('stecho-folded');
    const $panel = $('#stecho_container');
    const $header = $panel.find('.inline-drawer-toggle');
    const $drawer = $panel.find('.inline-drawer-content');
    revealInlineDrawer($header, $drawer);
    setTimeout(() => {
        $panel.get(0).scrollIntoView({ behavior: 'smooth', block: 'start' });
        $('#stecho_preview').trigger('focus');
    }, 150);
}

/* ---------- 6.7 池与标签 ---------- */

function renderTagList() {
    const tags = getChatData().tags;
    const $list = $('#stecho_tag_list');
    $list.empty();
    for (const tag of tags) {
        const $row = $(`<div class="stecho-entry" data-id="${tag.id}">
            <i class="fa-solid fa-tag stecho-entry-icon"></i>
            <span class="stecho-entry-name" title="${escapeAttr(tag.keywords.join('、'))}">${escapeHtml(tag.name)}<span class="stecho-hint">（${escapeHtml(tag.keywords.join('、'))}）</span></span>
            <span class="stecho-entry-btns">
                <button class="stecho-icon-btn tag-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>
                <button class="stecho-icon-btn tag-del stecho-danger" title="删除"><i class="fa-solid fa-trash-can"></i></button>
            </span>
        </div>`);
        $list.append($row);
    }
    // 筛选下拉（自定义多选下拉，含默认的"全部（不筛选）"）
    const prev = getSelectedTagIds();
    const $ddList = $('#stecho_tag_filter_dd .stecho-dropdown-list');
    $ddList.empty();
    const mkItem = (id, name, checked) => $(`<label><input type="checkbox" value="${escapeAttr(id)}" ${checked ? 'checked' : ''} /> ${escapeHtml(name)}</label>`);
    $ddList.append(mkItem('', '全部（不筛选）', !prev.length));
    for (const tag of tags) $ddList.append(mkItem(tag.id, tag.name, prev.includes(tag.id)));
    syncDropdownBarLabel();
}

/** 当前选中的标签筛选（空数组 = 全部） */
function getSelectedTagIds() {
    return $('#stecho_tag_filter_dd .stecho-dropdown-list input[type=checkbox]:checked')
        .map((_, el) => $(el).val()).get().filter(Boolean);
}

function syncDropdownBarLabel() {
    const ids = getSelectedTagIds();
    const tags = getChatData().tags;
    const label = ids.length
        ? ids.map(id => (tags.find(t => t.id === id) || {}).name || '?').join('、')
        : '全部（不筛选）';
    $('#stecho_tag_filter_dd .dd-label').text(label);
}

function bindTagDropdown() {
    const $dd = $('#stecho_tag_filter_dd');
    $dd.find('.stecho-dropdown-bar').on('click', (e) => {
        e.stopPropagation();
        $dd.find('.stecho-dropdown-list').toggle();
    });
    $dd.find('.stecho-dropdown-list').on('click', (e) => e.stopPropagation());
    $dd.on('change', '.stecho-dropdown-list input[type=checkbox]', function () {
        const $cb = $(this);
        if ($cb.val() === '') {
            // 选"全部"则清掉其他；且不允许一个都不选
            if ($cb.is(':checked')) $dd.find('.stecho-dropdown-list input[type=checkbox]').not($cb).prop('checked', false);
            else $cb.prop('checked', true);
        } else {
            $dd.find('.stecho-dropdown-list input[type=checkbox][value=""]').prop('checked', false);
            if (!getSelectedTagIds().length) $cb.prop('checked', true);
        }
        syncDropdownBarLabel();
        renderPool();
    });
    $(document).on('click.stechoTagDd', () => $dd.find('.stecho-dropdown-list').hide());
}

async function openTagEditor(existingId) {
    const tags = getChatData().tags;
    const existing = existingId ? tags.find(t => t.id === existingId) : null;
    const $editor = $(`
        <div class="stecho-tag-editor">
            <div class="stecho-field">
                <label class="stecho-field-label">标签名（需与提示词中 [标签] 的写法一致）</label>
                <input type="text" class="te-name stecho-input text_pole" />
            </div>
            <div class="stecho-field">
                <label class="stecho-field-label">关键词（逗号分隔，可填多个近义词；摘要行命中任一词即归入本标签）</label>
                <input type="text" class="te-keywords stecho-input text_pole" />
            </div>
        </div>`);
    if (existing) {
        $editor.find('.te-name').val(existing.name);
        $editor.find('.te-keywords').val(existing.keywords.join('，'));
    }
    const ok = await callGenericPopup($editor, POPUP_TYPE.CONFIRM, '', { okButton: '保存', cancelButton: '取消' });
    if (!ok) return;
    const name = String($editor.find('.te-name').val()).trim();
    if (!name) { toastr.warning('标签名不能为空'); return; }
    const keywords = String($editor.find('.te-keywords').val()).split(/[,，、]/).map(x => x.trim()).filter(Boolean);
    if (!keywords.length) keywords.push(name);
    if (existing) {
        existing.name = name;
        existing.keywords = keywords;
    } else {
        tags.push({ id: uid(), name, keywords });
    }
    saveChatData();
    markDirty('tags');
    renderTagList();
    renderPool();
}

function currentTempVisibleRanges(data) {
    const s = getCurrentSettings().smallSummary;
    if (!s.showHiddenOverride) return null;
    const t = s.tempShow || { all: true, start: 0, end: 0 };
    if (t.all) return data.hiddenRanges;
    const start = Math.max(0, parseInt(t.start, 10) || 0);
    const end = Math.max(start, parseInt(t.end, 10) || 0);
    // 叠加"临时显示期间只记未藏"的楼层（显式记录于 runtime.deferredHidden，保存时写入；
    // 不能用 is_system 反推——"所有"模式下已藏楼层也可见，会自我强化导致区间收窄失效）
    return [[start, end], ...runtime.deferredHidden];
}

function renderPool() {
    const data = getChatData();
    const selected = getSelectedTagIds();
    const markersOn = !!getCurrentSettings().smallSummary.showFloorMarkers;
    // 楼层标注视图：只读分段，标注仅为显示、不写进池内容
    const displayText = markersOn
        ? sortedSummaries(data).map(s => `━━ ${s.range ? `${s.range[0]}~${s.range[1]} 楼` : '未关联楼层'} ━━\n${s.text}`).join('\n\n')
        : sortedSummaries(data).map(s => s.text).join('\n');
    const filtered = filterPoolText(displayText, getChatData().tags, selected);
    const $pool = $('#stecho_pool');
    $pool.val(filtered);
    $pool.prop('readonly', selected.length > 0 || markersOn);
    $pool.data('baseline', filtered);
    $pool.data('dirty', false);
}

// token 计数走远程 tokenizer，输入时防抖 300ms，避免逐键重复计数
const updateManualTokenCountDebounced = debounce(updateManualTokenCount, 300);

function bindSmallSection() {
    const s = () => getCurrentSettings().smallSummary;

    // 6.1
    $('#stecho_prompt_new').on('click', () => {
        const entries = s().promptEntries;
        entries.push({ id: uid(), name: '新提示词', role: 'user', position: 'relative', depth: 0, content: '', enabled: true });
        saveSettings();
        markDirty('prompt');
        renderPromptList();
    });
    $('#stecho_prompt_save').on('click', () => {
        saveSettings();
        clearDirty();
        toastr.success('提示词与开关、排序已保存');
    });
    renderPromptList();

    // 6.2 自动隐藏
    $('#stecho_autohide').on('change', async function () {
        s().autoHide = $(this).is(':checked');
        saveSettings();
        markDirty('autohide');
        const data = getChatData();
        if (s().autoHide) await applyVisibility(data.hiddenRanges, currentTempVisibleRanges(data));
        // 取消勾选：不恢复已隐藏的（保持现状，用户可用"临时显示"恢复）
    });
    // 6.2b 临时显示（所有 / 指定区间，不影响统计）
    $('#stecho_show_hidden').on('change', async function () {
        s().showHiddenOverride = $(this).is(':checked');
        $('#stecho_temp_show_details').toggle(s().showHiddenOverride);
        saveSettings();
        markDirty('showHidden');
        const data = getChatData();
        await applyVisibility(data.hiddenRanges, currentTempVisibleRanges(data));
        if (!s().showHiddenOverride) runtime.deferredHidden = []; // 取消勾选：只记未藏的楼层已按记录恢复，清账
    });
    $('#stecho_temp_show_all').on('change', async function () {
        s().tempShow.all = $(this).is(':checked');
        $('#stecho_temp_show_start, #stecho_temp_show_end').prop('disabled', s().tempShow.all);
        saveSettings();
        const data = getChatData();
        await applyVisibility(data.hiddenRanges, currentTempVisibleRanges(data));
    });
    const applyTempShowRange = debounce(async () => {
        s().tempShow.start = Math.max(0, parseInt($('#stecho_temp_show_start').val(), 10) || 0);
        s().tempShow.end = Math.max(0, parseInt($('#stecho_temp_show_end').val(), 10) || 0);
        saveSettings();
        const data = getChatData();
        await applyVisibility(data.hiddenRanges, currentTempVisibleRanges(data));
    }, 300);
    $('#stecho_temp_show_start, #stecho_temp_show_end').on('input', applyTempShowRange);

    // 6.3 自动小总结（触发逻辑在步骤7，这里只管设置与界面）
    $('#stecho_auto_enabled').on('change', function () {
        s().auto.enabled = $(this).is(':checked');
        $('#stecho_auto_details').toggle(s().auto.enabled);
        saveSettings();
        markDirty('auto');
    });
    $('#stecho_auto_interval').on('input', function () {
        s().auto.interval = Number($(this).val());
        $('#stecho_auto_interval_val').text($(this).val());
        saveSettings();
        markDirty('auto');
    });
    $('#stecho_auto_resume').on('click', () => {
        s().auto.suspended = false;
        saveSettings();
        $('#stecho_auto_suspended').hide();
        toastr.info('自动总结已恢复（若攒够楼层会立即触发一次）', 'ST-Echos');
        markDirty('auto');
        setTimeout(maybeAutoTrigger, 500);
    });

    // 6.5 手动
    $('#stecho_manual_run').on('click', onManualSummarize);
    $('#stecho_manual_start, #stecho_manual_end').on('input', updateManualTokenCountDebounced);

    // 6.5.2 防懒
    $('#stecho_lazy_threshold').on('input', function () {
        s().lazyThreshold = Math.max(0, parseInt($(this).val(), 10) || 0);
        saveSettings();
        markDirty('lazy');
    });

    // 6.6 预览
    $('#stecho_preview').on('input', function () { $(this).data('dirty', true); });
    $('#stecho_preview').on('focus', function () { $(this).data('focused', true); });
    $('#stecho_preview').on('blur', function () { $(this).data('focused', false); });
    $('#stecho_preview_regen').on('click', async () => {
        if (runtime.generating) return;
        runtime.generating = true;
        try {
            const { generationCount } = await regenerateSmallSummary();
            renderPreview();
            toastr.success(`已重新生成（第 ${generationCount} 次）`);
        } catch (e) {
            await callGenericPopup(`重说失败：${String(e && e.message || e)}`, POPUP_TYPE.CONFIRM, '', { okButton: '知道了', cancelButton: false });
        } finally {
            runtime.generating = false;
        }
    });
    $('#stecho_preview_history').on('click', openHistoryPopup);
    $('#stecho_preview_discard').on('click', async () => {
        const data = getChatData();
        if (!data.pendingSmall) return;
        const ok = await callGenericPopup('删除本次预览？预览未保存，删除后这些楼层不会被记为已总结，自动总结的计数会继续累积。', POPUP_TYPE.CONFIRM, '', { okButton: '删除预览', cancelButton: '取消' });
        if (!ok) return;
        data.pendingSmall = null;
        saveChatData();
        renderPreview();
        toastr.info('预览已删除');
    });
    $('#stecho_preview_save').on('click', async () => {
        const data = getChatData();
        if (!data.pendingSmall) return;
        // 预览被编辑过 → 把编辑内容写回当前代
        const edited = $('#stecho_preview').val();
        if ($('#stecho_preview').data('dirty')) {
            data.pendingSmall.generations[data.pendingSmall.current] = edited;
            $('#stecho_preview').data('dirty', false);
        }
        if (data.pendingSmall.floorChanged) {
            const ok = await callGenericPopup('生成总结期间楼层有变动（可能新增了消息），仍要按原楼层区间保存吗？', POPUP_TYPE.CONFIRM, '', { okButton: '保存', cancelButton: '取消' });
            if (!ok) return;
        }
        try {
            const { start, end, resumed } = await saveSmallSummary();
            toastr.success(`已保存 ${start}~${end} 的小总结`);
            if (resumed) toastr.info('自动总结已恢复（若攒够楼层会立即触发一次）', 'ST-Echos');
            afterSmallSaved();
        } catch (e) {
            await callGenericPopup(`保存失败：${String(e && e.message || e)}`, POPUP_TYPE.CONFIRM, '', { okButton: '知道了', cancelButton: false });
        }
    });

    // 6.7 池与标签
    $('#stecho_pool').on('input', function () {
        $(this).data('dirty', $(this).val() !== $(this).data('baseline'));
    });
    $('#stecho_pool_markers').on('change', async function () {
        const turnOn = $(this).is(':checked');
        // 开启标注会重置池文本框，未保存的编辑将丢失，先确认
        if (turnOn && $('#stecho_pool').data('dirty')) {
            const ok = await callGenericPopup('开启楼层标注会重置池编辑区，当前未保存的池修改将丢失。继续吗？', POPUP_TYPE.CONFIRM, '', { okButton: '继续（丢弃修改）', cancelButton: '取消' });
            if (!ok) { $(this).prop('checked', false); return; }
        }
        s().showFloorMarkers = turnOn;
        saveSettings();
        markDirty('markers');
        renderPool();
    });
    $('#stecho_pool_save').on('click', async () => {
        const data = getChatData();
        const selected = getSelectedTagIds();
        if (selected.length > 0) { toastr.info('筛选状态下池为只读，请先清空筛选再编辑'); return; }
        const $pool = $('#stecho_pool');
        if (!$pool.data('dirty')) { toastr.info('池内容没有改动'); return; }
        const newText = $pool.val();
        const old = sortedSummaries(data);
        // 池与统计/隐藏完全解耦：这里的删改只影响池文本（注入内容），
        // 不动已统计数据、不动已隐藏楼层；归位仅为尽量保留楼层归属信息。
        if (!newText.trim()) {
            data.summaries = [];
        } else {
            data.summaries = remapPoolEdit(old, newText).entries;
        }
        saveChatData();
        renderChatPanel();
        refreshInjection();
        toastr.success('小总结池已更新（统计与隐藏不受影响）');
    });
    bindTagDropdown();
    $('#stecho_tag_new').on('click', () => openTagEditor(null));
    $('#stecho_tag_list').on('click', '.tag-edit', function () {
        openTagEditor($(this).closest('.stecho-entry').data('id'));
    });
    $('#stecho_tag_list').on('click', '.tag-del', async function () {
        const id = $(this).closest('.stecho-entry').data('id');
        const tag = getChatData().tags.find(t => t.id === id);
        const ok = await callGenericPopup(`确定删除标签「${tag && tag.name || ''}」吗？（不影响池内容）`, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: '取消' });
        if (!ok) return;
        const tags = getChatData().tags;
        const i = tags.findIndex(t => t.id === id);
        if (i >= 0) tags.splice(i, 1);
        saveChatData();
        markDirty('tags');
        renderTagList();
        renderPool();
    });
    // 「进行大总结」按钮在 bindBigSection 中绑定为真实的大总结流程
}

/* ---------- 6.3 自动总结 / 6.5.2 防懒 / 删除修正 ---------- */

function snapshotChatIds() {
    runtime.knownChatIds = (getContext().chat || []).map(m => (m.extra && m.extra.gen_id) || m.send_date || String(m.mes || '').slice(0, 40));
}

/** 通过与上次快照比对，找出被删楼层的原位置（支持中间删除，比事件带的 chat.length 可靠） */
function findDeletedIndex() {
    const now = (getContext().chat || []).map(m => (m.extra && m.extra.gen_id) || m.send_date || String(m.mes || '').slice(0, 40));
    const old = runtime.knownChatIds || [];
    for (let i = 0; i < Math.min(old.length, now.length); i++) {
        if (old[i] !== now[i]) return i;
    }
    return now.length; // 删的是末尾
}

/** 触发语义（钉死版）：可总结区间长度 ≥ 阈值 才触发，触发时总结整个区间 */
export function maybeAutoTrigger() {
    const s = getCurrentSettings().smallSummary;
    if (!s.auto.enabled || s.auto.suspended) return;
    if (runtime.generating) return;
    const data = getChatData();
    if (data.pendingSmall) return; // 有待保存预览：暂停触发，计数不停
    if (streamingProcessor && !streamingProcessor.isFinished) return; // 主LLM生成中
    const range = computableRange(data, s.protectionN);
    if (!range) return;
    if (range[1] - range[0] + 1 < s.auto.interval) return;
    // 区间楼层若全被手动隐藏跳过，静默不触发（否则会在发请求前抛 empty-range 且反复弹错）
    if (getFloors(range[0], range[1]).floors.length === 0) return;
    doSummarize(range[0], range[1], 'auto');
}

/** 防懒提示：计数口径 = 当前总楼数 − 插件隐藏的楼数（按 hiddenRanges 推算，不看实际显示状态） */
function maybeLazyPrompt() {
    const s = getCurrentSettings().smallSummary;
    if (!s.lazyThreshold || s.lazyThreshold <= 0) return;
    if (runtime.lazyPrompted) return;
    const data = getChatData();
    const visible = (lastFloor() + 1) - countCovered(data.hiddenRanges);
    if (visible >= s.lazyThreshold) {
        runtime.lazyPrompted = true;
        callGenericPopup(`当前未隐藏的楼层已达 ${visible} 层，建议进行小总结。`, POPUP_TYPE.CONFIRM, '', { okButton: '去总结', cancelButton: '稍后' })
            .then(ok => { if (ok) scrollToManual(); });
    }
}

function scrollToManual() {
    openExtensionsDrawer();
    $('#stecho_section_small').removeClass('stecho-folded');
    const $panel = $('#stecho_container');
    const $header = $panel.find('.inline-drawer-toggle');
    const $drawer = $panel.find('.inline-drawer-content');
    revealInlineDrawer($header, $drawer);
    setTimeout(() => {
        $panel.get(0).scrollIntoView({ behavior: 'smooth', block: 'start' });
        $('#stecho_manual_start').trigger('focus');
    }, 150);
}

const onChatActivity = debounce(() => {
    snapshotChatIds();
    maybeLazyPrompt();
    maybeAutoTrigger();
}, 3000);

function bindAutoSection() {
    // AI 回复渲染后：防懒检查 + 自动触发检查（防抖）
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onChatActivity);
    // 用户消息发出/渲染后也刷新快照（防"无渲染事件直接删楼"时删除定位失准）
    eventSource.on(event_types.MESSAGE_SENT, snapshotChatIds);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, snapshotChatIds);

    // 删除楼层：插件记录的楼层区间统一平移/收缩（含池条目 range 与待保存预览）
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        const idx = findDeletedIndex();
        snapshotChatIds();
        if (idx == null || idx < 0) return;
        const data = getChatData();
        shiftAllRangesOnDelete(data, idx);
        saveChatData();
        renderChatPanel();
        toastr.info('已删除楼层，楼层记录已自动修正', 'ST-Echos');
    });

    // 可见楼层保护 N
    $('#stecho_protection_n').on('input', function () {
        getCurrentSettings().smallSummary.protectionN = Math.max(0, parseInt($(this).val(), 10) || 0);
        saveSettings();
        markDirty('protectionN');
    });
}

/** 小总结保存后的联动：防懒重新武装 + 补触发检查（追平积压） + 自动大总结检查 */
export function afterSmallSaved() {
    runtime.lazyPrompted = false;
    renderChatPanel();
    renderBigPanel();
    setTimeout(() => {
        maybeAutoTrigger();
        // 自动大总结：池达阈值且没有待保存的大总结预览时触发
        const data = getChatData();
        if (!data.pendingBig && bigSummaryThresholdMet()) {
            toastr.info('小总结池已达到自动大总结条件，开始生成大总结……', 'ST-Echos');
            doBigSummarize('auto');
        }
    }, 500);
}

/* ============================== 大总结区 ============================== */

function renderBigPromptList() {
    const entries = getCurrentSettings().bigSummary.promptEntries;
    const lockedIds = new Set(entries.filter(e => e.isSystemFirst || e.isPool).map(e => e.id));
    renderEntryList({
        $container: $('#stecho_big_prompt_list'),
        entries,
        options: { lockedIds, dragExclude: (e) => !!e.isSystemFirst },
        callbacks: {
            onToggle: (id, checked) => {
                const e = entries.find(x => x.id === id);
                if (e) { e.enabled = checked; saveSettings(); markDirty('bigPrompt'); }
            },
            onEdit: (id) => openBigPromptEditor(id),
            onDelete: async (id) => {
                const e = entries.find(x => x.id === id);
                const ok = await callGenericPopup(`确定删除提示词条目「${e && e.name || ''}」吗？`, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: '取消' });
                if (!ok) return;
                const i = entries.findIndex(x => x.id === id);
                if (i >= 0) entries.splice(i, 1);
                saveSettings(); markDirty('bigPrompt'); renderBigPromptList();
            },
            onReorder: (orderedIds) => {
                const map = new Map(entries.map(e => [e.id, e]));
                entries.length = 0;
                entries.push(...orderedIds.map(id => map.get(id)).filter(Boolean));
                saveSettings(); markDirty('bigPrompt'); renderBigPromptList();
            },
        },
    });
    $('#stecho_big_prompt_list .stecho-entry').each(function () {
        const id = $(this).data('id');
        const e = entries.find(x => x.id === id);
        if (e) $(this).find('.stecho-entry-icon').attr('class', `fa-solid ${e.isPool ? 'fa-layer-group' : (PROMPT_ICONS[e.role] || 'fa-rectangle-list')} stecho-entry-icon`);
    });
}

async function openBigPromptEditor(existingId) {
    const entries = getCurrentSettings().bigSummary.promptEntries;
    const existing = entries.find(e => e.id === existingId);
    if (!existing) return;
    const isFirstSystem = !!existing.isSystemFirst;
    const isPool = !!existing.isPool;
    const $editor = $(`
        <div class="stecho-prompt-editor">
            ${isPool ? '<div class="stecho-hint" style="margin-bottom:6px">此条目代表小总结池全文：内容不可编辑；大总结时池内容以 user 身份插入在该条目所在位置，可用开关停发、拖拽/▲▼移动。</div>' : ''}
            <div class="stecho-field">
                <label class="stecho-field-label">名称</label>
                <input type="text" class="pe-name stecho-input text_pole" ${isPool ? 'disabled' : ''} />
            </div>
            <div class="stecho-field">
                <label class="stecho-field-label">身份</label>
                <select class="pe-role stecho-select text_pole" ${(isFirstSystem || isPool) ? 'disabled' : ''}>
                    <option value="system">系统（合并为一条 system 消息置于最前）</option>
                    <option value="user">用户</option>
                    <option value="assistant">助手</option>
                </select>
            </div>
            <div class="stecho-field">
                <label class="stecho-field-label">内容</label>
                <textarea class="pe-content stecho-input" rows="8" ${isPool ? 'disabled' : ''} placeholder="${isPool ? '此条目自动填入小总结池全文，不可编辑' : ''}"></textarea>
            </div>
        </div>`);
    $editor.find('.pe-name').val(existing.name || '');
    $editor.find('.pe-role').val(existing.role || 'user');
    $editor.find('.pe-content').val(existing.content || '');
    const ok = await callGenericPopup($editor, POPUP_TYPE.CONFIRM, '', { okButton: '保存', cancelButton: '取消', allowVerticalScrolling: true });
    if (!ok) return;
    if (!isPool) {
        existing.name = String($editor.find('.pe-name').val()).trim() || '未命名';
        existing.content = String($editor.find('.pe-content').val());
    }
    if (!isFirstSystem && !isPool) existing.role = String($editor.find('.pe-role').val());
    saveSettings(); markDirty('bigPrompt'); renderBigPromptList();
}

function currentBigPreviewText() {
    const data = getChatData();
    if (!data.pendingBig) return '';
    return (data.pendingBig.generations || [])[data.pendingBig.current] ?? '';
}

/** 渲染保存目标条目下拉 + 预览区；渲染序号防异步覆盖（连续触发时旧结果不覆盖新结果） */
async function renderBigPanel() {
    const seq = ++runtime.bigRenderSeq;
    const isStale = () => seq !== runtime.bigRenderSeq;
    const data = getChatData();
    // 预览
    const $preview = $('#stecho_big_preview');
    if (!$preview.data('focused')) $preview.val(currentBigPreviewText());
    const p = data.pendingBig;
    const count = p ? (p.generations || []).length : 0;
    const $badge = $('#stecho_big_history_badge');
    if (count > 1) { $badge.text(count).show(); } else { $badge.hide(); }
    $('#stecho_big_preview_save').prop('disabled', !p);
    $('#stecho_big_preview_regen').prop('disabled', !p);
    $('#stecho_big_preview_history').prop('disabled', count <= 1);

    // 条目下拉（含 await，回填前校验渲染序号）
    const $select = $('#stecho_big_entry');
    const worldName = await resolveWorldbookName() || getCurrentSettings().lorebookName;
    if (isStale()) return;
    $select.empty();
    if (!worldName) {
        $select.append('<option value="">（未找到目标世界书：请给聊天或角色绑定世界书）</option>');
        $select.prop('disabled', true);
        $('#stecho_big_entry_chars').text('');
        return;
    }
    $select.prop('disabled', false);
    const entries = await listSummaryEntries(worldName);
    if (isStale()) return;
    const currentUid = data.lorebook && data.lorebook.uid;
    const isAuto = !!data.lorebookAuto || currentUid == null;
    $select.append(`<option value="auto" ${isAuto ? 'selected' : ''}>（自动：按本聊天创建/使用专属条目）</option>`);
    for (const e of entries) {
        $select.append(`<option value="${e.uid}" ${!isAuto && currentUid === e.uid ? 'selected' : ''}>${escapeHtml(e.comment)}（${e.chars} 字）</option>`);
    }
    $select.append('<option value="__new">＋ 新建条目…</option>');
    const cur = entries.find(e => e.uid === currentUid);
    $('#stecho_big_entry_chars').text(cur ? `当前条目：${cur.chars} 字` : '');
}

async function onBigEntrySelect() {
    const val = $('#stecho_big_entry').val();
    const data = getChatData();
    const worldName = await resolveWorldbookName() || getCurrentSettings().lorebookName;
    if (val === '__new') {
        const name = await callGenericPopup('新条目名称（会加 "ST-Echos大总结-" 前缀）：', POPUP_TYPE.INPUT, '', { okButton: '创建', cancelButton: '取消' });
        const trimmed = name == null ? '' : String(name).trim();
        if (!trimmed) { renderBigPanel(); return; }
        try {
            const created = await createSummaryEntry(worldName, `${ENTRY_COMMENT_PREFIX}-${trimmed}`);
            data.lorebookAuto = false;
            data.lorebook = { name: worldName, uid: created.uid, comment: created.comment };
            saveChatData();
            toastr.success(`已创建条目「${created.comment}」`);
        } catch (e) {
            await callGenericPopup(`创建条目失败：${String(e && e.message || e)}`, POPUP_TYPE.CONFIRM, '', { okButton: '知道了', cancelButton: false });
        }
        renderBigPanel();
        return;
    }
    if (val === 'auto') {
        // "自动"= 使用本聊天当前已分配/自动创建的条目；仅从未分配过时下次保存才自动创建
        data.lorebookAuto = true;
        if (!(data.lorebook && data.lorebook.uid != null)) data.lorebook = null;
        saveChatData();
        renderBigPanel();
        return;
    }
    const uidNum = Number(val);
    const entries = await listSummaryEntries(worldName);
    const e = entries.find(x => x.uid === uidNum);
    data.lorebookAuto = false;
    data.lorebook = e ? { name: worldName, uid: e.uid, comment: e.comment } : null;
    saveChatData();
    renderBigPanel();
}

async function doBigSummarize(source) {
    if (runtime.generating) return;
    runtime.generating = true;
    try {
        await runBigSummary({ source });
        renderBigPanel();
        if (source === 'auto') {
            const go = await callGenericPopup('自动大总结已生成，要去预览吗？（保存后才进世界书并清空小总结池）', POPUP_TYPE.CONFIRM, '', { okButton: '去预览', cancelButton: '稍后' });
            if (go) scrollToBigPreview();
        }
    } catch (e) {
        const msg = e instanceof SummaryError ? e.message : String(e && e.message || e);
        if (source === 'auto') {
            $('#stecho_big_auto_fail_reason').text(msg);
            $('#stecho_big_auto_suspended').show();
        }
        await callGenericPopup(`大总结失败：${msg}`, POPUP_TYPE.CONFIRM, '', { okButton: '知道了', cancelButton: false });
        renderBigPanel();
    } finally {
        runtime.generating = false;
    }
}

function scrollToBigPreview() {
    openExtensionsDrawer();
    $('#stecho_section_big').removeClass('stecho-folded');
    const $panel = $('#stecho_container');
    const $header = $panel.find('.inline-drawer-toggle');
    const $drawer = $panel.find('.inline-drawer-content');
    revealInlineDrawer($header, $drawer);
    setTimeout(() => {
        $('#stecho_big_preview').get(0).scrollIntoView({ behavior: 'smooth', block: 'center' });
        $('#stecho_big_preview').trigger('focus');
    }, 150);
}

async function onBigSave() {
    const data = getChatData();
    if (!data.pendingBig) return;
    const $preview = $('#stecho_big_preview');
    if ($preview.data('dirty')) {
        data.pendingBig.generations[data.pendingBig.current] = $preview.val();
        $preview.data('dirty', false);
    }
    // 并发窗口①：存在未保存的小总结预览
    if (data.pendingSmall) {
        const choice = await callGenericPopup(
            '还有未保存的小总结预览。如果继续，大总结将不包含它的内容；保存大总结会清空小总结池，该预览也会被清掉。怎么办？',
            POPUP_TYPE.TEXT, '',
            { customButtons: [
                { text: '先保存小总结并继续', result: 1 },
                { text: '放弃小总结，继续大总结', result: 2 },
                { text: '取消', result: 0 },
            ] },
        );
        if (!choice || choice === 0) return;
        if (choice === 1) {
            try { await saveSmallSummary(); afterSmallSaved(); }
            catch (e) { await callGenericPopup(`保存小总结失败：${String(e && e.message || e)}`, POPUP_TYPE.CONFIRM, '', { okButton: '知道了', cancelButton: false }); return; }
        } else {
            data.pendingSmall = null;
            saveChatData();
        }
    }
    // 并发窗口②：生成期间池有变动
    const now = snapshotOfPool();
    const snap = data.pendingBig.poolSnapshot;
    if (!snap || now.hash !== snap.hash || now.count !== snap.count || now.chars !== snap.chars) {
        const go = await callGenericPopup(
            '生成大总结期间，小总结池有新保存的内容（这些内容不在本次大总结里，保存后会被清空）。仍要保存吗？',
            POPUP_TYPE.CONFIRM, '', { okButton: '继续保存并清空', cancelButton: '取消' },
        );
        if (!go) return;
    }
    // 目标条目
    let target = data.lorebook;
    if (!target || !target.name) {
        const worldName = await resolveWorldbookName() || getCurrentSettings().lorebookName;
        if (!worldName) {
            await callGenericPopup('无法确定目标世界书：请给当前聊天绑定聊天世界书、给角色绑定主世界书，或在设置里手填世界书名。', POPUP_TYPE.CONFIRM, '', { okButton: '知道了', cancelButton: false });
            return;
        }
        target = { name: worldName, uid: target && target.uid != null ? target.uid : null, comment: target && target.comment };
    }
    try {
        const final = await saveBigSummaryCore(target);
        toastr.success(`大总结已存入世界书条目「${final.comment}」，小总结池已清空`);
        renderChatPanel();
        renderBigPanel();
    } catch (e) {
        await callGenericPopup(`保存大总结失败：${String(e && e.message || e)}`, POPUP_TYPE.CONFIRM, '', { okButton: '知道了', cancelButton: false });
    }
}

function bindBigSection() {
    const bs = () => getCurrentSettings().bigSummary;
    $('#stecho_big_auto_enabled').on('change', function () {
        bs().auto.enabled = $(this).is(':checked');
        $('#stecho_big_auto_details').toggle(bs().auto.enabled);
        saveSettings(); markDirty('bigAuto');
    });
    $('#stecho_big_auto_metric').on('change', function () {
        bs().auto.metric = $(this).val() === 'items' ? 'items' : 'chars';
        saveSettings(); markDirty('bigAuto');
    });
    $('#stecho_big_auto_threshold').on('input', function () {
        bs().auto.threshold = Math.max(1, parseInt($(this).val(), 10) || 1);
        saveSettings(); markDirty('bigAuto');
    });
    $('#stecho_big_auto_resume').on('click', () => {
        bs().auto.suspended = false;
        saveSettings();
        $('#stecho_big_auto_suspended').hide();
        toastr.info('自动大总结已恢复', 'ST-Echos');
        markDirty('bigAuto');
    });
    $('#stecho_big_prompt_new').on('click', () => {
        const entries = bs().promptEntries;
        entries.push({ id: uid(), name: '新提示词', role: 'user', position: 'relative', depth: 0, content: '', enabled: true });
        saveSettings(); markDirty('bigPrompt'); renderBigPromptList();
    });
    $('#stecho_big_prompt_save').on('click', () => {
        saveSettings(); clearDirty(); toastr.success('大总结提示词已保存');
    });
    renderBigPromptList();
    $('#stecho_big_entry').on('change', onBigEntrySelect);
    $('#stecho_pool_big').on('click', () => doBigSummarize('manual'));
    $('#stecho_big_preview').on('input', function () { $(this).data('dirty', true); });
    $('#stecho_big_preview').on('focus', function () { $(this).data('focused', true); });
    $('#stecho_big_preview').on('blur', function () { $(this).data('focused', false); });
    $('#stecho_big_preview_regen').on('click', async () => {
        if (runtime.generating) return;
        runtime.generating = true;
        try {
            const { generationCount } = await regenerateBigSummary();
            renderBigPanel();
            toastr.success(`已重新生成（第 ${generationCount} 次）`);
        } catch (e) {
            await callGenericPopup(`重说失败：${String(e && e.message || e)}`, POPUP_TYPE.CONFIRM, '', { okButton: '知道了', cancelButton: false });
        } finally { runtime.generating = false; }
    });
    $('#stecho_big_preview_history').on('click', async () => {
        const gens = listBigGenerations();
        if (!gens.length) return;
        const data = getChatData();
        const $list = $('<div class="stecho-history-list"></div>');
        gens.forEach((g, i) => {
            const isCur = data.pendingBig && data.pendingBig.current === i;
            $list.append(`<div class="stecho-history-item ${isCur ? 'current' : ''}" data-i="${i}"><b>第 ${i + 1} 次生成</b><span class="stecho-hint">${escapeHtml(String(g).slice(0, 80))}…</span></div>`);
        });
        const popup = callGenericPopup($list, POPUP_TYPE.DISPLAY, '', {});
        $list.on('click', '.stecho-history-item', function () {
            selectBigGeneration(Number($(this).data('i')));
            renderBigPanel();
            $(document).find('.popup-button-close, .popup-x-close').first().click();
        });
        await popup;
    });
    $('#stecho_big_preview_save').on('click', onBigSave);
    $('#stecho_big_preview_discard').on('click', async () => {
        const data = getChatData();
        if (!data.pendingBig) return;
        const ok = await callGenericPopup('删除本次大总结预览？（小总结池保持原样）', POPUP_TYPE.CONFIRM, '', { okButton: '删除预览', cancelButton: '取消' });
        if (!ok) return;
        data.pendingBig = null;
        saveChatData();
        renderBigPanel();
        toastr.info('大总结预览已删除');
    });
}

/* ---------- 聊天相关面板整体渲染 ---------- */

export function renderChatPanel() {
    const data = getChatData();
    // 载入校验：越界修正并留痕
    const fixes = clampRangesToChat(data);
    if (fixes.length) {
        saveChatData();
        console.log('[ST-Echos] 载入校验修正:', fixes);
        toastr.info(`ST-Echos 已修正 ${fixes.length} 处越界的楼层记录（详见控制台）`);
    }
    $('#stecho_stats').text(statsText(data));
    runtime.currentChatPending = !!data.pendingSmall; // 供切走时的脏检查判断（切走后旧聊天数据不可达）
    renderPromptList();
    renderPreview();
    renderTagList();
    renderPool();
    updateManualTokenCount();
    // 自动隐藏的同步（载入聊天时按记录恢复隐藏状态；临时显示期间尊重其区间）
    const s = getCurrentSettings().smallSummary;
    if (s.autoHide) applyVisibility(data.hiddenRanges, currentTempVisibleRanges(data));
}

/** 切聊天时的暂存编辑（STAGED EDITS）：CHAT_CHANGED 时旧聊天已切走，
 *  无法直接写回旧聊天文件，改为暂存到设置里，回到该聊天时恢复为未保存编辑；
 *  也可选择"丢弃预览"（暂存一个丢弃标记，回到该聊天时清掉其待保存预览）。 */
function stageOrDropEdits(oldChatId) {
    const poolDirty = $('#stecho_pool').data('dirty');
    const previewDirty = $('#stecho_preview').data('dirty');
    // CHAT_CHANGED 时聊天已切走，getChatData() 是新聊天的——必须用切走前缓存的旧聊天状态
    const hasPending = !!runtime.currentChatPending;
    if (!poolDirty && !previewDirty) return Promise.resolve();
    const captured = {
        pool: poolDirty ? $('#stecho_pool').val() : null,
        preview: previewDirty ? $('#stecho_preview').val() : null,
    };
    // 处理完即清脏标记，避免之后每次切聊天重复弹窗
    $('#stecho_pool').data('dirty', false);
    $('#stecho_preview').data('dirty', false);
    const buttons = [
        { text: '暂存修改', result: 1 },
        { text: '丢弃修改', result: 2 },
    ];
    if (hasPending) buttons.push({ text: '丢弃预览', result: 3 });
    return callGenericPopup(
        `上一个聊天有未保存的内容。切换时已无法直接写回该聊天，请选择处理方式（回到该聊天时生效）。`,
        POPUP_TYPE.TEXT,
        '',
        { customButtons: buttons },
    ).then(choice => {
        if (!choice || choice === 2) return; // 关窗=丢弃修改
        const store = getStore();
        if (!store.stagedEdits) store.stagedEdits = {};
        if (choice === 1) store.stagedEdits[oldChatId] = captured;
        else if (choice === 3) store.stagedEdits[oldChatId] = { discardPreview: true };
        saveSettings();
    });
}

function restoreStagedEdits() {
    const store = getStore();
    const chatId = getContext().chatId;
    if (store.stagedEdits && store.stagedEdits[chatId]) {
        const st = store.stagedEdits[chatId];
        delete store.stagedEdits[chatId];
        saveSettings();
        renderChatPanel();
        if (st.discardPreview) {
            const data = getChatData();
            data.pendingSmall = null;
            saveChatData();
            renderPreview();
            toastr.info('已按上次的选择丢弃该聊天的待保存预览', 'ST-Echos');
        }
        if (st.pool != null) {
            $('#stecho_pool').val(st.pool).data('dirty', true);
            toastr.info('已恢复上次暂存的小总结池编辑（未保存，记得点保存）', 'ST-Echos');
        }
        if (st.preview != null && getChatData().pendingSmall) {
            $('#stecho_preview').val(st.preview).data('dirty', true);
        }
        return true;
    }
    return false;
}

/** 切到"有多条未总结楼层"的聊天时，先问再总结（防止一切换就意外发起API请求） */
async function confirmAutoSummaryOnSwitch() {
    const s = getCurrentSettings().smallSummary;
    if (!s.auto.enabled || s.auto.suspended) return;
    if (runtime.generating || runtime.autoConfirmOpen) return; // 防连续切聊天堆叠确认框
    const data = getChatData();
    if (data.pendingSmall) return;
    const chatId = getContext().chatId;
    if (runtime.autoDeclinedFor === chatId) return; // 本次会话已选择"暂不"
    const range = computableRange(data, s.protectionN);
    if (!range) return;
    const len = range[1] - range[0] + 1;
    if (len < s.auto.interval) return;
    runtime.autoConfirmOpen = true;
    try {
        const choice = await callGenericPopup(
            `该聊天有 ${len} 条消息已达到自动总结条件（${range[0]}~${range[1]} 层），要立即总结吗？`,
            POPUP_TYPE.TEXT,
            '',
            { customButtons: [{ text: '立即总结', result: 1 }, { text: '暂不', result: 2 }] },
        );
        if (choice === 1) maybeAutoTrigger();
        else if (choice === 2) runtime.autoDeclinedFor = chatId;
    } finally {
        runtime.autoConfirmOpen = false;
    }
}

/** CHAT_CHANGED 入口（index.js 调用）；防重入：切聊天过程中的事件不叠加处理 */
export async function onChatChanged() {
    if (runtime.inChatChange) return;
    runtime.inChatChange = true;
    try {
        const oldChatId = runtime.currentChatId;
        await stageOrDropEdits(oldChatId);
        // 标签筛选是聊天级视图，切聊天时重置（旧聊天的标签 id 在新聊天里不存在；不放 renderChatPanel，避免删楼等操作冲掉用户的筛选）
        $('#stecho_tag_filter_dd .stecho-dropdown-list input[type=checkbox]').prop('checked', false);
        if (!restoreStagedEdits()) renderChatPanel();
        runtime.currentChatId = getContext().chatId;
        runtime.lazyPrompted = false;
        runtime.deferredHidden = []; // 只记未藏是会话态，切聊天清账（记录本身在 hiddenRanges 里，载入后按记录处理）
        snapshotChatIds();
        refreshInjection();
        renderBigPanel();
        confirmAutoSummaryOnSwitch();
    } finally {
        runtime.inChatChange = false;
    }
}

/* ============================== 从设置填充控件 ============================== */

export function fillControlsFromSettings() {
    const s = getCurrentSettings();
    $('#stecho_api_enabled').prop('checked', !!s.customApi.enabled);
    $('#stecho_api_url').val(s.customApi.url || '');
    $('#stecho_api_key').val(s.customApi.key || '');
    $('#stecho_api_key').attr('type', 'password');
    $('#stecho_api_key_toggle i').removeClass('fa-eye-slash').addClass('fa-eye');
    $('#stecho_api_model').val(s.customApi.model || '');
    $('#stecho_api_details').toggle(!!s.customApi.enabled);
    $('#stecho_api_status').text('');
    for (const def of SAMPLING_DEFS) setSliderValue(def.key, s.sampling[def.key]);
    $('#stecho_regex_enabled').prop('checked', !!s.regex.enabled);
    $('#stecho_regex_details').toggle(!!s.regex.enabled);
    renderRegexList();
    $('#stecho_injection_position').val(s.injection.position || 'none');
    $('#stecho_injection_depth').val(s.injection.depth ?? 1);
    $('#stecho_injection_depth_field').toggle((s.injection.position || 'none') === 'depth');
    $('#stecho_injection_template').val(s.injection.template || '');
    // 小总结区
    $('#stecho_autohide').prop('checked', !!s.smallSummary.autoHide);
    $('#stecho_show_hidden').prop('checked', !!s.smallSummary.showHiddenOverride);
    $('#stecho_temp_show_details').toggle(!!s.smallSummary.showHiddenOverride);
    $('#stecho_temp_show_all').prop('checked', s.smallSummary.tempShow?.all !== false);
    $('#stecho_temp_show_start').val(s.smallSummary.tempShow?.start ?? 0).prop('disabled', s.smallSummary.tempShow?.all !== false);
    $('#stecho_temp_show_end').val(s.smallSummary.tempShow?.end ?? 0).prop('disabled', s.smallSummary.tempShow?.all !== false);
    $('#stecho_auto_enabled').prop('checked', !!s.smallSummary.auto.enabled);
    $('#stecho_auto_details').toggle(!!s.smallSummary.auto.enabled);
    $('#stecho_auto_interval').val(s.smallSummary.auto.interval ?? 50);
    $('#stecho_auto_interval_val').text(s.smallSummary.auto.interval ?? 50);
    $('#stecho_auto_suspended').toggle(!!(s.smallSummary.auto.enabled && s.smallSummary.auto.suspended));
    $('#stecho_lazy_threshold').val(s.smallSummary.lazyThreshold ?? 0);
    $('#stecho_protection_n').val(s.smallSummary.protectionN ?? 30);
    $('#stecho_pool_markers').prop('checked', !!s.smallSummary.showFloorMarkers);
    // 大总结区
    $('#stecho_big_auto_enabled').prop('checked', !!s.bigSummary.auto.enabled);
    $('#stecho_big_auto_details').toggle(!!s.bigSummary.auto.enabled);
    $('#stecho_big_auto_metric').val(s.bigSummary.auto.metric || 'chars');
    $('#stecho_big_auto_threshold').val(s.bigSummary.auto.threshold ?? 5000);
    $('#stecho_big_auto_suspended').toggle(!!(s.bigSummary.auto.enabled && s.bigSummary.auto.suspended));
    // 提示词条目列表随预设切换重渲染（原只刷了控件值，条目列表会停留在旧预设）
    renderPromptList();
    renderBigPromptList();
    refreshInjection();
}

/** 切换预设前的脏检查；返回 true 表示可以继续切换 */
async function confirmDiscardIfDirty(actionName) {
    if (!isDirty()) return true;
    const ok = await callGenericPopup(
        `当前有未保存的修改，${actionName}将丢弃这些修改。确定继续吗？`,
        POPUP_TYPE.CONFIRM,
        '',
        { okButton: '继续', cancelButton: '取消' },
    );
    return !!ok;
}

/** 弹出输入框询问预设名；返回名字或 null（取消） */
async function askPresetName(title, initial = '') {
    const name = await callGenericPopup(title, POPUP_TYPE.INPUT, initial, {
        okButton: '确定', cancelButton: '取消',
    });
    if (name === null || name === undefined) return null;
    const trimmed = String(name).trim();
    return trimmed || null;
}

function refreshPresetSelect() {
    const store = getStore();
    const $select = $('#stecho_preset_select');
    $select.empty();
    $select.append('<option value="">（自定义档）</option>');
    for (const name of listPresets()) {
        const selected = store.activePreset === name ? ' selected' : '';
        $select.append(`<option value="${escapeAttr(name)}"${selected}>${escapeHtml(name)}</option>`);
    }
}

function bindPresetBar() {
    refreshPresetSelect();

    $('#stecho_preset_select').on('change', async function () {
        const target = $(this).val() || null;
        const store = getStore();
        if (target === store.activePreset) return;
        if (!(await confirmDiscardIfDirty('切换预设'))) {
            refreshPresetSelect();
            return;
        }
        switchPreset(target);
        renderPresetBar(); // 预设条 + 各板块控件 + 提示词条目列表整体重刷
    });

    $('#stecho_preset_save').on('click', async () => {
        const store = getStore();
        const currentName = isOnPreset() ? store.activePreset : null;
        const title = currentName ? `将当前设置保存到预设「${currentName}」？（原有内容会被覆盖）` : '把当前设置保存为预设，请输入预设名：';
        if (currentName) {
            const ok = await callGenericPopup(title, POPUP_TYPE.CONFIRM, '', { okButton: '保存', cancelButton: '取消' });
            if (!ok) return;
            savePreset(currentName);
        } else {
            const name = await askPresetName('把当前设置保存为预设，请输入预设名：');
            if (!name) return;
            if (listPresets().includes(name)) {
                const overwrite = await callGenericPopup(`预设「${name}」已存在，要覆盖它吗？`, POPUP_TYPE.CONFIRM, '', { okButton: '覆盖', cancelButton: '取消' });
                if (!overwrite) return;
            }
            savePreset(name);
        }
        renderPresetBar();
    });

    $('#stecho_preset_new').on('click', async () => {
        if (!(await confirmDiscardIfDirty('新建预设'))) return;
        const name = await askPresetName('新建预设，请输入预设名（将基于默认设置创建）：');
        if (!name) return;
        if (listPresets().includes(name)) {
            toastr.warning(`预设「${name}」已存在`);
            return;
        }
        createPreset(name);
        renderPresetBar();
    });

    $('#stecho_preset_delete').on('click', async () => {
        const store = getStore();
        const currentName = isOnPreset() ? store.activePreset : null;
        if (!currentName) {
            toastr.info('当前不在任何预设上（自定义档无法删除）。请先在左侧下拉框选择一个预设。');
            return;
        }
        const ok = await callGenericPopup(
            `确定删除预设「${currentName}」吗？删除后切回自定义档，此操作不可恢复。`,
            POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: '取消' },
        );
        if (!ok) return;
        deletePreset(currentName);
        renderPresetBar();
    });
}

/** 重渲染预设条、从设置填充控件并清空脏标记（切换/保存/新建/删除后设置与面板一致） */
export function renderPresetBar() {
    refreshPresetSelect();
    fillControlsFromSettings();
    clearDirty();
}

/** 绑定整个面板（在模板注入后调用一次） */
export function bindPanel() {
    loadSettings();
    // 板块折叠：点标题切换
    $(document).on('click.stechoFold', '.stecho-section-title', function () {
        $(this).parent().toggleClass('stecho-folded');
    });
    bindPresetBar();
    bindApiSection();
    bindSamplingSection();
    bindRegexSection();
    bindInjectionSection();
    bindSmallSection();
    bindAutoSection();
    bindBigSection();
    fillControlsFromSettings();
    renderChatPanel();
    renderBigPanel();
    runtime.currentChatId = getContext().chatId;
    runtime.lazyPrompted = false;
    snapshotChatIds();
}
