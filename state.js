// Copyright (c) 2026 Thirteen-Moons
// Licensed under AGPL-3.0; see LICENSE for full terms
// Derivative works must retain attribution to Thirteen-Moons
// v1.0.0

/**
 * ST-Echos 共享运行时状态（非持久化）。
 * 脏标记：面板有任何未保存/未应用的修改时为 true，用于预设切换、切聊天前的确认。
 */

let dirty = false;
let dirtySource = null; // 哪个模块标记的（调试用途）

export function markDirty(source = 'unknown') {
    dirty = true;
    dirtySource = source;
}

export function clearDirty() {
    dirty = false;
    dirtySource = null;
}

export function isDirty() {
    return dirty;
}


/** 运行时状态（非持久化）。所有字段在此显式声明，避免散落"幽灵字段"。 */
export const runtime = {
    generating: false,        // 是否有总结生成在进行（并发锁）
    currentChatId: null,      // 当前聊天 id（切走时的脏检查/暂存用）
    currentChatPending: false,// 当前聊天是否有待保存预览（切走瞬间旧数据不可达，靠它判断）
    lazyPrompted: false,      // 防懒提示本次是否已弹（保存后重新武装）
    knownChatIds: null,       // 消息标识快照（删除楼层定位用）
    inChatChange: false,      // CHAT_CHANGED 处理中（防重入）
    autoConfirmOpen: false,   // 切聊天自动总结确认框是否开着（防堆叠）
    autoDeclinedFor: null,    // 本次会话用户对哪个聊天选了"暂不"自动总结
    bigRenderSeq: 0,          // 大总结面板渲染序号（防异步覆盖陈旧 DOM）
    deferredHidden: [],       // "临时显示"勾选期间只记未藏的楼层区间（显式记录，不能用 is_system 反推）
};
