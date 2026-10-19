// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.1

/**
 * ST-Echos 通用可排序条目列表（正则条目、提示词条目共用）。
 *
 * 每行：拖动把手（PC）/ ▲▼ 排序钮、图标、名称、编辑✏、删除🗑、开关。
 * 通过回调与外部数据交互，本模块不直接读写设置。
 */

/** 开关的 HTML（checkbox 语义，样式见 style.css 的 .stecho-switch） */
export function toggleHtml(checked) {
    return `<label class="stecho-switch"><input type="checkbox" class="stecho-entry-toggle" ${checked ? 'checked' : ''} /><span class="stecho-switch-slider"></span></label>`;
}

/**
 * 渲染条目列表。
 * @param {object} args
 * @param {jQuery} args.$container 容器
 * @param {Array<object>} args.entries 条目数组（每项至少 {id, name, enabled}）
 * @param {object} args.options { iconField?, lockedIds?:Set, dragExclude?:(entry)=>boolean, grayOut?:(entry)=>boolean }
 * @param {object} args.callbacks { onToggle(id, checked), onEdit(id), onDelete(id), onReorder(orderedIds) }
 */
export function renderEntryList(args) {
    const { $container, entries, options = {}, callbacks = {} } = args;
    const $list = $('<div class="stecho-entry-list"></div>');
    $container.empty().append($list);

    entries.forEach((entry, index) => {
        const icon = options.iconField ? (entry[options.iconField] || 'fa-rectangle-list') : 'fa-rectangle-list';
        const locked = options.lockedIds ? options.lockedIds.has(entry.id) : false; // 锁定=不可删除
        const gray = options.grayOut ? options.grayOut(entry) : false;
        // 拖拽只由 dragExclude 决定（首条系统提示词）；锁定条目（占位/Chat History）仍可拖拽排序
        const draggable = !(options.dragExclude && options.dragExclude(entry));
        const $row = $(`
            <div class="stecho-entry ${gray ? 'stecho-entry-gray' : ''}" data-id="${entry.id}" ${draggable ? 'draggable="true"' : ''}>
                <span class="stecho-entry-grip" title="拖拽排序">⋮⋮</span>
                <span class="stecho-entry-order">
                    <button class="stecho-order-btn" data-act="up" title="上移" ${index === 0 ? 'disabled' : ''}>▲</button>
                    <button class="stecho-order-btn" data-act="down" title="下移" ${index === entries.length - 1 ? 'disabled' : ''}>▼</button>
                </span>
                <i class="fa-solid ${icon} stecho-entry-icon"></i>
                <span class="stecho-entry-name" title="${escapeAttr(entry.name || '(未命名)')}">${escapeHtml(entry.name || '(未命名)')}</span>
                <span class="stecho-entry-btns">
                    <button class="stecho-icon-btn stecho-entry-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>
                    ${locked ? '' : '<button class="stecho-icon-btn stecho-entry-del stecho-danger" title="删除"><i class="fa-solid fa-trash-can"></i></button>'}
                    ${toggleHtml(!!entry.enabled)}
                </span>
            </div>`);
        $list.append($row);
    });

    // 事件委托
    $list.off('.stechoEntries');
    $list.on('click.stechoEntries', '.stecho-entry-toggle', function () {
        const id = $(this).closest('.stecho-entry').data('id');
        callbacks.onToggle && callbacks.onToggle(id, $(this).is(':checked'));
    });
    $list.on('click.stechoEntries', '.stecho-entry-edit', function () {
        const id = $(this).closest('.stecho-entry').data('id');
        callbacks.onEdit && callbacks.onEdit(id);
    });
    $list.on('click.stechoEntries', '.stecho-entry-del', function () {
        const id = $(this).closest('.stecho-entry').data('id');
        callbacks.onDelete && callbacks.onDelete(id);
    });
    $list.on('click.stechoEntries', '.stecho-order-btn', function () {
        const $row = $(this).closest('.stecho-entry');
        const id = $row.data('id');
        const dir = $(this).data('act');
        const entriesInOrder = $list.find('.stecho-entry').map((_, el) => $(el).data('id')).get();
        const i = entriesInOrder.indexOf(id);
        const j = dir === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= entriesInOrder.length) return;
        // 不可拖拽条目（首条系统提示词）禁止通过▲▼越过其位置；Chat History 占位条目可正常移动
        const isLocked = (eid) => {
            const entry = entries.find(x => x.id === eid);
            return !!entry && !!(options.dragExclude && options.dragExclude(entry));
        };
        if (isLocked(id) || isLocked(entriesInOrder[j])) return;
        const ids = entriesInOrder.slice();
        [ids[i], ids[j]] = [ids[j], ids[i]];
        callbacks.onReorder && callbacks.onReorder(ids);
    });

    // PC 拖拽排序（HTML5 DnD）
    let dragId = null;
    $list.on('dragstart.stechoEntries', '.stecho-entry[draggable=true]', function (e) {
        dragId = $(this).data('id');
        e.originalEvent.dataTransfer.effectAllowed = 'move';
    });
    $list.on('dragover.stechoEntries', '.stecho-entry', function (e) {
        e.preventDefault();
        e.originalEvent.dataTransfer.dropEffect = 'move';
        $(this).addClass('stecho-entry-dragover');
    });
    $list.on('dragleave.stechoEntries', '.stecho-entry', function () {
        $(this).removeClass('stecho-entry-dragover');
    });
    $list.on('drop.stechoEntries', '.stecho-entry', function (e) {
        e.preventDefault();
        $(this).removeClass('stecho-entry-dragover');
        const targetId = $(this).data('id');
        if (!dragId || dragId === targetId) return;
        const ids = $list.find('.stecho-entry').map((_, el) => $(el).data('id')).get();
        ids.splice(ids.indexOf(dragId), 1);
        ids.splice(ids.indexOf(targetId), 0, dragId);
        dragId = null;
        callbacks.onReorder && callbacks.onReorder(ids);
    });
}

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function escapeAttr(s) { return escapeHtml(s); }
