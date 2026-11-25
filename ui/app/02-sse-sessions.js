// 〔SSE / 会话视图〕——M9 拆分第 3 段
'use strict';
// chat-update 可能一秒来很多条，状态栏最多每 2 秒刷一次；
// 服务端已有 10 秒缓存，这里再挡一下请求量。
let lastStatusRefreshAt = 0;
function refreshStatusThrottled() {
  const now = Date.now();
  if (now - lastStatusRefreshAt < 2000) return;
  lastStatusRefreshAt = now;
  refreshStatus();
}
// 未读点：SSE 报来一条新会话时在左侧打点，用户点开即消。
//
// 为什么需要它：自 2026-11-09 起不再"新会话一来就把当前详情顶掉"（见下方守卫），
// 代价是用户盯着旧会话时新消息**没有任何可见痕迹** —— .new-item 只是一次性的
// 淡入动画，播完就没了。没有这个持久点，等于静默丢消息。
// 只活在内存里：刷新页面后 currentSessionId 为空 → 自动选中最新会话，无需跨刷新保持。
function markSessionUnread(id) {
  const key = String(id || '');
  if (!key) return;
  state.unseenSessionIds = state.unseenSessionIds || new Set();
  if (key === state.currentSessionId) { state.unseenSessionIds.delete(key); return; }
  state.unseenSessionIds.add(key);
}
// ── P0-03 列表状态（全单唯一权威口径）────────────────────────────────────
// state.sessions      只存**已完成**会话，不含任何 running/waiting；
// state.sessionActive 只存 running/waiting，独立数组；
// 两者只在 renderSessionList() 里合并渲染，绝不把 active merge 回 state.sessions。
// 计数只按《计数转移表》：先判位置（wasActive/wasFinished），再迁移，最后加减。
function sortSessionRows(arr) {
  return (arr || []).sort((a, b) => {
    const d = (Number(b?.startedAt) || 0) - (Number(a?.startedAt) || 0);
    if (d) return d;
    const ai = String(a?.id ?? '');
    const bi = String(b?.id ?? '');
    return ai < bi ? 1 : (ai > bi ? -1 : 0);
  });
}

function dedupeSessions(arr) {
  const seen = new Set();
  const out = [];
  for (const s of (arr || [])) {
    if (!s || !s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

const clampCount = (n) => Math.max(0, Number(n) || 0);

function noteFinishedAdded({ wasActive, wasFinished }) {
  if (wasActive) state.sessionTotalFinished = clampCount(state.sessionTotalFinished) + 1;
  else if (!wasFinished) {
    state.sessionTotal = clampCount(state.sessionTotal) + 1;
    state.sessionTotalFinished = clampCount(state.sessionTotalFinished) + 1;
  }
}

function noteActiveAdded({ wasActive, wasFinished }) {
  if (wasFinished) state.sessionTotalFinished = Math.max(0, clampCount(state.sessionTotalFinished) - 1);
  else if (!wasActive) state.sessionTotal = clampCount(state.sessionTotal) + 1;
}

function noteRemoved({ wasActive, wasFinished }) {
  if (wasActive) state.sessionTotal = Math.max(0, clampCount(state.sessionTotal) - 1);
  else if (wasFinished) {
    state.sessionTotal = Math.max(0, clampCount(state.sessionTotal) - 1);
    state.sessionTotalFinished = Math.max(0, clampCount(state.sessionTotalFinished) - 1);
  }
}

/** SSE payload → 列表行摘要（缺字段降级成最小行，下一次分页/详情补齐）。 */
function summaryFromEvent(data) {
  const id = data?.sessionId;
  if (!id) return null;
  const out = {
    id,
    chatKey: data.chatKey || '',
    status: data.status || 'running',
    startedAt: data.startedAt ?? 0,
    waitUntil: data.waitUntil ?? null,
    activity: data.activity || '',
    webSearchCount: data.webSearchCount || 0,
    rounds: data.rounds || 0,
    usage: data.usage || null,
    trigger: data.trigger || data.triggerSummary || '',
    triggerSummary: data.triggerSummary ?? data.trigger ?? ''
  };
  if (Array.isArray(data.sent)) out.sent = data.sent;
  if (data.finishReason !== undefined) out.finishReason = data.finishReason;
  if (data.error !== undefined) out.error = data.error;
  if (data.endedAt !== undefined) out.endedAt = data.endedAt;
  return out;
}

/**
 * 应用一条会话事件/补丁（实时与重放共用）。
 * @param {string} id
 * @param {object} patch 摘要（status 决定落到 active 还是已完成）
 * @param {{replay?:boolean}} opts replay=true 时“未知终态”跳过（它属于未加载页，
 *        或快照 total 已包含），不会凭空插入一行。
 */
function applySessionEvent(id, patch, { replay = false } = {}) {
  if (!id || !patch) return;
  state.sessionActive = state.sessionActive || [];
  state.sessions = state.sessions || [];
  const active = state.sessionActive;
  const finished = state.sessions;
  const ia = active.findIndex((s) => s.id === id);
  const iF = finished.findIndex((s) => s.id === id);
  const isActive = patch.status === 'running' || patch.status === 'waiting';
  // 摘要缺 startedAt 时不要把它冲成 0（列表会按 1970 排序掉到最底）：
  // 已在列表里的保留原值，新建的最小行用当前时间兜底。
  const insertRow = () => ({ ...patch, startedAt: patch.startedAt || Date.now() });
  const assignRow = (row) => {
    const prevStartedAt = row.startedAt;
    Object.assign(row, patch);
    if (!patch.startedAt) row.startedAt = prevStartedAt || Date.now();
  };

  if (isActive) {
    if (ia >= 0) {
      assignRow(active[ia]);
    } else {
      if (iF >= 0) {
        finished.splice(iF, 1);
        noteActiveAdded({ wasFinished: true });
      } else {
        noteActiveAdded({ wasActive: false, wasFinished: false });
      }
      active.unshift(insertRow());
    }
  } else if (ia >= 0) {
    // active → 终态：只 +finished，total 不变
    const [row] = active.splice(ia, 1);
    const merged = { ...row, ...patch, startedAt: row.startedAt || patch.startedAt || Date.now() };
    if (iF >= 0) finished[iF] = merged;
    else finished.push(merged);
    noteFinishedAdded({ wasActive: true });
  } else if (iF >= 0) {
    assignRow(finished[iF]);
  } else if (!replay) {
    // 断线补事件 / 未知终态 session-end：插入并两者各 +1
    finished.push(insertRow());
    noteFinishedAdded({ wasActive: false, wasFinished: false });
  } else {
    return;   // 重放未知终态：跳过，不插入、不加计数
  }

  sortSessionRows(active);
  sortSessionRows(finished);
  state.sessionTotalFinished = clampCount(state.sessionTotalFinished);
  state.sessionTotal = clampCount(state.sessionTotal);
}

/** 按 id 从两个数组移除（删除类事件）。只有原本存在才回退计数。 */
function removeSessionById(id) {
  const active = state.sessionActive || [];
  const finished = state.sessions || [];
  const ia = active.findIndex((s) => s.id === id);
  if (ia >= 0) { active.splice(ia, 1); noteRemoved({ wasActive: true }); return true; }
  const iF = finished.findIndex((s) => s.id === id);
  if (iF >= 0) { finished.splice(iF, 1); noteRemoved({ wasFinished: true }); return true; }
  return false;
}

function addSessionTombstone(id) {
  if (!id) return;
  state.sessionTombstones = state.sessionTombstones || new Map();
  state.sessionTombstones.set(String(id), Date.now());
  const cutoff = Date.now() - 60_000;
  for (const [k, ts] of state.sessionTombstones) if (ts < cutoff) state.sessionTombstones.delete(k);
}

/** 记录在途补丁（只记录，不应用）。seq 做 key：同 id 的 start+end 各存一条。 */
function recordSessionPatch(id, summary) {
  if (!id) return;
  const seq = ++state.sessionsEventSeq;
  state.sessionPatches.set(seq, { id, summary, ts: Date.now() });
  pruneSessionPatches();
}

/**
 * 补丁清理：只清 `seq <= minInflight` 且超过 60 秒的。
 * 有慢请求在途时，它之后到达的事件一律保留；没有在途请求时按 60 秒清。
 */
function pruneSessionPatches() {
  const inflight = state.sessionInflightSeqs;
  const minInflight = inflight && inflight.size ? Math.min(...inflight) : Infinity;
  const now = Date.now();
  for (const [seq, p] of state.sessionPatches) {
    if (seq <= minInflight && now - p.ts > 60_000) state.sessionPatches.delete(seq);
  }
}

/** 重放 seq > requestSeq 的补丁：只应用、不记录（不得 ++seq / set 新补丁）。 */
function replaySessionPatches(requestSeq) {
  if (!state.sessionPatches) return;
  const keys = [...state.sessionPatches.keys()].sort((a, b) => a - b);
  for (const seq of keys) {
    if (seq <= requestSeq) continue;
    const p = state.sessionPatches.get(seq);
    if (!p) continue;
    if (p.summary === null) removeSessionById(p.id);
    else applySessionEvent(p.id, p.summary, { replay: true });
  }
}

/** 合批渲染列表（session-update 很密，逐条重绘会把主线程打满）。 */
let sessionListRenderTimer = null;
function scheduleSessionListRender() {
  if (sessionListRenderTimer) return;
  sessionListRenderTimer = setTimeout(() => {
    sessionListRenderTimer = null;
    renderSessionList();
  }, 100);
}

// ── SSE ──
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('session-start', (ev) => {
    let data = {};
    try { data = JSON.parse(ev?.data || '{}') || {}; } catch { /* 坏数据不影响后续 */ }
    const id = data.sessionId;
    if (!id) return;
    // 先打点：新会话在左侧留一个持久未读点（点开即消）
    markSessionUnread(id);
    const summary = summaryFromEvent(data);
    // session-start 一定是 running/waiting：写 active，不写已完成
    applySessionEvent(id, summary, { replay: false });
    recordSessionPatch(id, summary);
    scheduleSessionListRender();
    refreshStatus();
    // 自动跟随：直接选中 active 第一条，不再先拉列表
    if (state.autoFollowRunning && !state.currentSessionId) {
      const active = (state.sessionActive || []).find((s) => s.status === 'waiting' || s.status === 'running');
      if (active) selectSession(active.id);
    }
  });
  es.addEventListener('session-update', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const id = data.sessionId;
    if (!id) return;
    // 详情用的完整 patch（含 messages）；列表行只要摘要，不带 messages
    const detail = {
      id,
      chatKey: data.chatKey || '',
      status: data.status,
      waitUntil: data.waitUntil ?? null,
      activity: data.activity || '',
      webSearchCount: data.webSearchCount || 0,
      rounds: data.rounds || 0,
      usage: data.usage || null,
      messages: data.messages || [],
      triggerSummary: data.triggerSummary ?? '',
      trigger: data.trigger || data.triggerSummary || '',
      startedAt: data.startedAt ?? 0
    };
    // sent/finishReason 等收尾字段：后端给了才进 patch。
    // 不能无脑写 null —— pending 合并时 null 会把之前已有的值冲掉。
    if (Array.isArray(data.sent)) detail.sent = data.sent;
    if (data.finishReason !== undefined) detail.finishReason = data.finishReason;
    if (data.error !== undefined) detail.error = data.error;
    if (data.endedAt !== undefined) detail.endedAt = data.endedAt;

    // 列表：先查 state.sessionActive，再查 state.sessions，命中哪个改哪个；
    // 两个都没有才按 status 插入。只查 state.sessions 会让每次 activity/rounds
    // 更新都走"插入已完成"，同一条运行中会话出现两份且计数错乱。
    // 终态→active（retrySession 只发 session-update）与 active→终态也在这里迁移。
    const summary = summaryFromEvent(data);
    applySessionEvent(id, summary, { replay: false });
    recordSessionPatch(id, summary);
    scheduleSessionListRender();

    // 详情 patch 合并暂存，渲染合批到每帧一次（不再来一条事件全量重建一次）
    pendingSessionDetail.set(id, { ...pendingSessionDetail.get(id), ...detail });
    scheduleSessionRender();
  });
  es.addEventListener('session-end', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data || '{}') || {}; } catch { /* 坏数据按"无 id"处理 */ }
    const id = data.sessionId;
    const status = data.status;
    refreshStatus();

    // cleared / 无 sessionId：服务端只发 { status:'cleared', removed }。
    // 不解析 removed、不列被移除的 id、不写 tombstone —— 只清未读并 reset 一次，
    // 在途的旧快照由 loadSessions 的 generation 校验丢弃（见 §5.2 第 5 条）。
    if (!id || status === 'cleared') {
      state.unseenSessionIds = new Set();
      loadSessions({ reset: true, quiet: true, force: true });
      return;
    }

    // deleted / discarded：服务端已把记录（连同磁盘文件）删掉，本地立即摘掉。
    // 先判位置再移除（removeSessionById 只在原本存在时回退计数）。
    if (status === 'deleted' || status === 'discarded') {
      removeSessionById(id);
      state.unseenSessionIds?.delete(id);
      addSessionTombstone(id);
      if (state.currentSessionId === id) {
        state.currentSessionId = null;
        state.sessionDetail = null;
        lastDetailFp = null;
        const box = $('#session-detail');
        if (box) box.innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
      }
      recordSessionPatch(id, null);
      renderSessionList();
      return;
    }

    // 普通结束：摘要随事件下发（服务端 peek 拿不到时会是极简行）。
    // applySessionEvent 内部先判 wasActive/wasFinished 再迁移，计数走转移表：
    // 原在 active → 只 +finished；已在已完成 → 就地改；两边都不在 → 插入 +1/+1。
    const summary = summaryFromEvent({ status: 'aborted', ...data });
    applySessionEvent(id, summary, { replay: false });
    recordSessionPatch(id, summary);
    scheduleSessionListRender();

    // ⚠️ 会话刚结束必须主动重拉一次详情：轮询只刷 running/waiting 的会话，
    //    最终态（sent / finishReason / error）之后再也不来 —— 不重拉的话，
    //    "已发送到 QQ"徽标和收尾状态只能等用户手动刷新才出现。
    if (id === state.currentSessionId) {
      pendingSessionDetail.delete(id);   // 丢弃残留的过期 patch，防止把刚拉的最终态回闪成旧值
      loadSessionDetail(id, { quiet: true });
    }
  });
  es.addEventListener('chat-update', () => {
    scheduleListReload();
    refreshStatusThrottled();
  });
  es.addEventListener('onebot-status', () => {
    refreshStatus();
    if (state.tab === 'snowluma') scheduleSnowlumaReload();
  });
  // 启动阶段变化（2026-11-11）：后台任务就绪/失败时立即刷新，让「⏳ 正在启动」
  // 横幅及时消失。不加也能工作 —— 下面的 refreshStatus 轮询会在下一个周期取回
  // bootPhase，加它只是把延迟从「一个轮询周期」压到毫秒级。
  es.addEventListener('boot-phase', () => refreshStatus());
  es.addEventListener('status', () => refreshStatus());
  es.addEventListener('snowluma-status', () => { refreshStatus(); if (state.tab === 'snowluma') scheduleSnowlumaReload(); });
  es.addEventListener('qq-portable-status', () => { refreshStatus(); if (state.tab === 'snowluma') scheduleSnowlumaReload(); });
  // 日志事件只刷日志文本，不整页重建（曾经每条日志都 innerHTML 重绘整页）
  es.addEventListener('qq-portable-log', () => { if (state.tab === 'snowluma') refreshSnowlumaLogs(); });
  es.addEventListener('snowluma-log', (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { /* 坏数据跳过本条，不断流 */ }
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && state.tab === 'snowluma') {
      refreshSnowlumaLogs();
    }
  });
  es.addEventListener('feedback', (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  // 视觉能力扫描进度：POST /api/vision/scan 是异步的（202），完成后靠这个事件告诉前端。
  // 此前后端会 emit 但全项目没有任何监听者，扫描结果只能在重载页面后才看得到。
  es.addEventListener('vision-scan', async (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { /* ignore */ }
    // 2026-09-19（M9 清理）：扫描入口搬到「模型配置」弹窗（mc-vision-hint 承接进度）。
    const hint = $('#mc-vision-hint');
    if (hint) {
      if (d.phase === 'start') hint.textContent = '扫描中…（会真实请求每个模型，请稍候）';
      else if (d.phase === 'done') hint.textContent = `完成：${d.total ?? 0} 个模型`;
      else if (d.phase === 'error') hint.textContent = `失败：${d.error || '未知错误'}`;
    }
    if (d.phase === 'done' || d.phase === 'error') {
      try {
        const v = await api('/api/vision/results');
        state.visionResults = v.results || {};
        state.visionScanning = !!v.scanning;
        if (state.tab === 'settings') renderSettings();
      } catch { /* 拉结果失败就保持现状 */ }
    }
  });
  // 首连/重连都要核对第一页：去轮询后这是唯一的"补齐断线期间丢失事件"的入口。
  // 首次连接时若 boot 已成功拉过（sessionsLoadedOnce）就跳过；boot 失败则补拉。
  // 重连一律 reset（断线期间的事件已经丢了，只能整页对齐）。
  es.onopen = () => {
    const first = !state.sseOpenedOnce;
    state.sseOpenedOnce = true;
    state.sseDisconnected = false;
    if (first && state.sessionsLoadedOnce) return;
    requestFirstPage();
  };
  es.onerror = () => {
    // EventSource 自己会重连；这里只记"掉过线"，让下一次 onopen 按重连处理
    state.sseDisconnected = true;
  };
}

// ── 会话视图 ──
/** 服务端分页大小：首屏与续页都用 200 条（渲染窗口另由 SESSION_PAGE 控制）。 */
const SESSION_FETCH_LIMIT = 200;

/**
 * 快照落地 + 补丁重放 + 一次渲染。
 *
 * ⚠️ 必须是一个**同步**函数：从"判代际"到"重放补丁"之间不得 await、不得渲染、
 * 不得让出事件循环。一旦让出，窗口内到达的事件会被"实时应用一次 + 重放一次"
 * 双计，列表和计数都会错（见 §5.2 第 1 条）。
 */
function applySessionsSnapshot(data, requestSeq) {
  const tombstones = state.sessionTombstones || new Map();
  const active = dedupeSessions(data.active || [])
    .filter((s) => !tombstones.has(String(s.id)));
  sortSessionRows(active);

  const finished = [];
  const seen = new Set(active.map((s) => String(s.id)));
  for (const s of dedupeSessions(data.sessions || [])) {
    const key = String(s.id);
    // 已删除的（tombstone）、以及同时出现在 active 里的，都不进已完成列表
    if (tombstones.has(key) || seen.has(key)) continue;
    seen.add(key);
    finished.push(s);
  }
  sortSessionRows(finished);

  state.sessionActive = active;
  state.sessions = finished;
  state.sessionTotal = clampCount(data.total);
  state.sessionTotalFinished = Number.isFinite(Number(data.totalFinished))
    ? clampCount(data.totalFinished)
    : finished.length;
  state.sessionCursor = data.nextCursor ?? null;
  state.sessionHasMore = !!data.hasMore && data.nextCursor != null;

  // 快照落地之后、同一个同步块内重放窗口内到达的补丁（只应用、不记录）
  replaySessionPatches(requestSeq);
  renderSessionList();
}

/**
 * 拉第一页（reset）。
 *
 * - `quiet` 只影响错误日志，不改变"reset 第一页"这件事：删除/重试/中止后
 *   需要立即对齐状态，所以 quiet 调用同样是 reset（有意行为，勿当回归返工）。
 * - 请求去重只由 `state.sessionsBootPromise` 负责；`sessionsLoadedOnce` 只表示
 *   "是否成功拿到过第一页"，不参与去重（否则 boot 失败后 onopen 会直接跳过）。
 */
async function loadSessions({ reset = true, quiet = false, force = false } = {}) {
  // reset=false 只可能来自"按已有游标继续"，交给 loadMoreSessions
  if (!reset) return loadMoreSessions({ quiet });

  const pending = state.sessionsBootPromise;
  if (pending) {
    if (!force) return pending;
    state.sessionsGeneration = clampCount(state.sessionsGeneration) + 1;
    await pending;
    return loadSessions({ reset: true, quiet });
  }

  // reset：代际递增 → 之前所有在途响应的落地都会被代际校验丢弃；
  // 渲染窗口回到一页，避免上一轮的滚动深度把首屏一次性铺开。
  state.sessionsGeneration = clampCount(state.sessionsGeneration) + 1;
  state.sessionLimit = SESSION_PAGE;

  const generation = state.sessionsGeneration;
  const requestSeq = state.sessionsEventSeq;
  state.sessionInflightSeqs.add(requestSeq);

  const run = (async () => {
    try {
      const data = await api(`/api/sessions?limit=${SESSION_FETCH_LIMIT}`);
      // 期间发生过 reset → 整页丢弃（不落地、不重放、不渲染）
      if (generation !== state.sessionsGeneration) return false;
      applySessionsSnapshot(data, requestSeq);
      state.sessionsLoadedOnce = true;
      followAndRefreshDetail();
      return true;
    } catch (e) {
      if (!quiet) console.error(e);
      return false;
    } finally {
      // 无论成功失败都必须删掉在途 seq，否则补丁永远不会被清理
      state.sessionInflightSeqs.delete(requestSeq);
      state.sessionsBootPromise = null;   // 只清 promise；sessionsLoadedOnce 只在成功路径置位
      pruneSessionPatches();
    }
  })();
  state.sessionsBootPromise = run;
  return run;
}

/**
 * 首屏落地后的跟随与详情刷新。
 *
 * 两处都必须查 `state.sessionActive`：改造后 `state.sessions` 只含已完成，
 * 运行中/等待中的会话**不在**里面 —— 只查 `state.sessions` 会让自动跟随失效、
 * 当前打开的运行中会话也不再刷新详情。
 */
function followAndRefreshDetail() {
  const idBefore = state.currentSessionId;
  const active = state.sessionActive || [];

  // 当前打开的会话在等待/运行中时顺手刷新详情：先找 active，再找已完成
  if (idBefore) {
    const cur = active.find((s) => s.id === idBefore)
      || (state.sessions || []).find((s) => s.id === idBefore);
    if (cur && (cur.status === 'running' || cur.status === 'waiting')) {
      loadSessionDetail(idBefore, { quiet: true });
    }
  }

  // 自动跟随最新运行中的会话（active 已按 startedAt 倒序）
  if (state.autoFollowRunning && !idBefore && active.length) selectSession(active[0].id);
}

/**
 * 首屏补拉（onopen 重连 / 页面恢复可见）：两条路径共用一个 5 秒节流，
 * 避免"断线重连"与"切回页面"同时发生时连发两次第一页请求。
 * 在途去重仍由 loadSessions 内部的 sessionsBootPromise 兜底。
 */
let lastFirstPageAt = 0;
function requestFirstPage() {
  const now = Date.now();
  if (now - lastFirstPageAt < 5000) return state.sessionsBootPromise;
  lastFirstPageAt = now;
  return loadSessions({ reset: true, quiet: true });
}

/** 续页请求锁：必须覆盖整个 await，否则滚到底会并发打出多页。 */
let sessionMorePromise = null;

/**
 * 追加下一页已完成会话。
 *
 * 不回写游标的后果：`sessionCursor` 永远停在第 1 页的 `nextCursor`，滚到底
 * 每次都取回同一页 → 去重后不追加、`hasMore` 恒 true → 无限请求。
 */
async function loadMoreSessions({ quiet = false } = {}) {
  if (sessionMorePromise) return sessionMorePromise;
  if (!state.sessionHasMore) return false;
  const cursor = state.sessionCursor;
  if (!cursor) { state.sessionHasMore = false; return false; }

  const generation = state.sessionsGeneration;
  const requestSeq = state.sessionsEventSeq;
  state.sessionInflightSeqs.add(requestSeq);

  const run = (async () => {
    try {
      const q = new URLSearchParams({ limit: String(SESSION_FETCH_LIMIT) });
      q.set('beforeTs', String(cursor.beforeTs));
      q.set('beforeId', String(cursor.beforeId));
      const data = await api(`/api/sessions?${q.toString()}`);
      // 期间发生过 reset → 整页丢弃，不追加
      if (generation !== state.sessionsGeneration) return false;

      // 判代际 → 追加 → 回写游标 → 重放补丁 → 一次渲染（同一同步块，不 await）
      const tombstones = state.sessionTombstones || new Map();
      const activeIds = new Set((state.sessionActive || []).map((s) => String(s.id)));
      const have = new Set((state.sessions || []).map((s) => String(s.id)));
      for (const s of (data.sessions || [])) {
        const key = String(s?.id ?? '');
        if (!key || have.has(key) || activeIds.has(key) || tombstones.has(key)) continue;
        have.add(key);
        state.sessions.push(s);
      }
      sortSessionRows(state.sessions);
      state.sessionCursor = data.nextCursor ?? null;
      state.sessionHasMore = !!data.hasMore && data.nextCursor != null;
      // 用服务端值校准总数（本地加减只是让"立刻显示"正确，口径以服务端为准）
      state.sessionTotal = clampCount(data.total);
      if (Number.isFinite(Number(data.totalFinished))) {
        state.sessionTotalFinished = clampCount(data.totalFinished);
      }
      // 渲染窗口只按 SESSION_PAGE 增长，不一次铺开到整页大小
      state.sessionLimit = clampCount(state.sessionLimit) + SESSION_PAGE;
      replaySessionPatches(requestSeq);
      renderSessionList();
      return true;
    } catch (e) {
      if (!quiet) console.error(e);
      return false;
    } finally {
      state.sessionInflightSeqs.delete(requestSeq);
      sessionMorePromise = null;
      pruneSessionPatches();
    }
  })();
  sessionMorePromise = run;
  return run;
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
// 间隔取自配置的 ui.refreshMs（设置页「界面刷新间隔」）；此前这里硬编码 4000，
// 配置项从未被读取 —— 用户改了完全没效果。
let listPoller = null;
function refreshIntervalMs() {
  const n = Number(state.config?.ui?.refreshMs);
  // 兜底值必须与后端 DEFAULT_CONFIG.ui.refreshMs 一致（15000），
  // 否则"拿不到配置"时前端按 4 秒轮询、后端默认 15 秒，两边对不上。
  return Number.isFinite(n) && n >= 1000 ? n : 15000;
}

/**
 * 状态栏轮询。用 setTimeout 自续期而不是 setInterval：
 * 每一轮都重新读 ui.refreshMs，用户在设置页改「界面刷新间隔」后立刻生效，
 * 不必刷新页面（此前这里是 setInterval(..., 15000) 写死的，改了设置不生效）。
 */
let statusPollTimer = null;
function startStatusPoller() {
  if (statusPollTimer) { clearTimeout(statusPollTimer); statusPollTimer = null; }
  const tick = async () => {
    try { await refreshStatus(); } catch { /* 单次失败不中断轮询 */ }
    statusPollTimer = setTimeout(tick, refreshIntervalMs());
  };
  statusPollTimer = setTimeout(tick, refreshIntervalMs());
}
// 存档页列表的增量刷新：`chat-update` 一秒可能来很多条，2 秒内合并成一次。
// 会话页**不再走这里** —— 会话列表已改为"首屏一页 + SSE 增量 + 滚动追加"，
// 没有任何列表定时器（见 §5.2 第 7 条）。
let sseListReloadTimer = null;
function scheduleListReload() {
  if (sseListReloadTimer) return;
  sseListReloadTimer = setTimeout(() => {
    sseListReloadTimer = null;
    // 页面不可见时跳过：chat-update 是存档页唯一的增量入口，后台不该继续发请求；
    // 恢复可见时由 visibilitychange 补一次（见文件末尾）。
    if (document.hidden) return;
    if (state.tab === 'chats') loadChats({ quiet: true });
  }, 2000);
}
/**
 * 给滚动容器挂"滚到底部就加载更多"的监听。
 *
 * 要点：
 *   1. 节流必须带"尾随调用"：曾经是被节流的事件直接丢弃 —— 快速滚动时
 *      事件密集，"抵达底部"那一下几乎总是落在 120ms 窗口内被扔掉，
 *      用户停手后又不会再有新事件 → 加载永远不触发，表现为
 *      "滚得快会滚不下去，像撞墙"。现在窗口内的事件会留下一个尾随定时器，
 *      停手后最多 120ms 内补一次检查。
 *   2. 距底部 <400px 就触发（曾经是 100px）：快速甩滚时惯性大，
 *      100px 的提前量太小，内容还没加载出来人已经撞底了。
 *   3. 交给 onLoadMore 自己判断是否真有更多数据；没有就直接返回，避免空转重渲染
 */
function attachScrollLoader(elId, onLoadMore) {
  const el = document.getElementById(elId);
  if (!el) return;

  // ⚠️ 防重复绑定：这个函数会被多次调用（渲染一次调一次），
  //    曾经没做防护，结果加载 N 批就挂了 N 个监听器 ——
  //    滚一次会同时触发 N 次 onLoadMore，一次跳好几批，
  //    而且每个监听器各有自己的 last 变量，120ms 节流形同虚设。
  //    这里把状态存在元素自身上，重复调用直接复用。
  if (el.__scrollLoader) {
    el.__scrollLoader.onLoadMore = onLoadMore;   // 只更新回调，不重复挂监听
    return;
  }
  const stateLoader = { last: 0, pending: null, onLoadMore };
  el.__scrollLoader = stateLoader;

  const THROTTLE_MS = 120;
  const NEAR_BOTTOM_PX = 400;
  const check = () => {
    stateLoader.last = Date.now();
    // scrollTop + 可视高度 >= 总高度 - 400 就认为快到底了
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX) stateLoader.onLoadMore();
  };

  el.addEventListener('scroll', () => {
    const elapsed = Date.now() - stateLoader.last;
    if (elapsed >= THROTTLE_MS) {
      // 窗口外的正常事件：立即处理；有尾随定时器就取消（避免重复检查）
      if (stateLoader.pending) { clearTimeout(stateLoader.pending); stateLoader.pending = null; }
      check();
    } else if (!stateLoader.pending) {
      // 窗口内被节流的事件：不丢，留一个尾随调用 —— 停手后补做最后一次检查
      stateLoader.pending = setTimeout(() => { stateLoader.pending = null; check(); }, THROTTLE_MS - elapsed);
    }
  }, { passive: true });
}

/**
 * 会话列表：滚到底部先放本地缓冲，本地放完再向服务端要下一页。
 *
 * ⚠️ 不能用"`all.length` 到了就 return"当唯一出口 —— `state.sessions` 现在只是
 * 已加载的几页，到了它的长度恰恰是该发请求的时候；只用本地长度判断会让列表
 * 永远停在第一页。
 */
function initSessionScrollLoader() {
  // 滚动源必须是真正 overflow 的列表容器（#session-items），不是外层 aside
  attachScrollLoader('session-items', () => {
    const loaded = (state.sessions || []).length;
    // 1) 本地缓冲还有没显示的（服务端已给的条数 > 渲染窗口）→ 只扩窗口，不发请求
    if (state.sessionLimit < loaded) {
      state.sessionLimit = Math.min(loaded, clampCount(state.sessionLimit) + SESSION_PAGE);
      renderSessionList();
      return;
    }
    // 2) 本地已全显示 → 服务端还有更早的页就去取
    if (state.sessionHasMore) loadMoreSessions();
    // 3) 本地全显示且服务端没有了 → 什么都不做
  });
}

/**
 * 存档页消息列表：滚到底部再追加 CHAT_MSG_MORE 条。
 *
 * ⚠️ 监听目标是 #chat-detail —— 它自带 .detail-pane 类（overflow-y:auto），
 *   是真正滚动的容器。曾经在它内部又套了一层 .archive-scroll 想做内层滚动，
 *   结果内层没有高度基准、被内容撑开，滚动事件全发生在外层，
 *   导致监听挂空、"继续滚动没反应"。现在只保留一层滚动容器。
 *
 * ⚠️ 加载更多只走"追加"（appendChatMessageRows）：
 *   曾经这里调 updateChatMessagesBody(true)，每批都要全量 sort + 全量
 *   innerHTML 重建（行数越滚越多），还有 scrollTop 补偿把视口"吸"在底部
 *   → 连锁触发下一批加载 → 主线程被反复长阻塞，
 *   表现为"滑到临界线继续向下滚动反应迟钝"。
 */
function initChatScrollLoader() {
  attachScrollLoader('chat-detail', () => {
    const total = (state.chatMessages || []).length;
    const prev = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
    if (prev >= total) return;                     // 已经全显示了
    state.chatMsgLimit = Math.min(total, prev + CHAT_MSG_MORE);
    // 行数账本对不上（结构刚被轮询重建过等异常）→ 全量兜底；正常走追加
    if ((state.chatMsgRendered || 0) !== Math.min(prev, total)) {
      updateChatMessagesBody(true);
    } else {
      appendChatMessageRows(prev);
    }
  });
}

function startListPoller() {
  if (listPoller) clearInterval(listPoller);
  listPoller = setInterval(() => {
    // 会话列表与存档列表已不再轮询（P0-03）：会话靠首屏一页 + SSE 增量 + 滚动追加，
    // 存档靠 chat-update（2 秒节流，隐藏时跳过）与 visibilitychange 补齐。
    // 这里**不加** `if (document.hidden) return` —— snowluma / settings 的隐藏时
    // 轮询行为保持原样，不被本单顺手改掉。
    if (state.tab === 'snowluma') {
      refreshSnowlumaLogs();
      scheduleSnowlumaReload();
    }
    // 用量页不自动刷新：打开/切范围/点「刷新」才请求
    if (state.tab === 'settings') refreshStatus();
  }, refreshIntervalMs());
}

startListPoller();

/**
 * 页面恢复可见时补数据。
 *
 * 会话/存档的轮询已经删除，`chat-update` 在隐藏时又被跳过 —— 没有这个监听，
 * 切走再回来会长期停在旧数据上（存档页尤其明显）。
 * 会话第一页与 onopen 共用同一个"在途 promise + 5 秒节流"（见 requestFirstPage），
 * 因为"断线重连"与"切回页面"经常同时发生。
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.tab === 'sessions') requestFirstPage();
  // 无论当前页都补一次存档列表：设置页的分群下拉也读 state.chats
  loadChats({ quiet: true });
});

function renderSessionList() {
  const box = $('#session-items');
  state.seenSessionIds = state.seenSessionIds || new Set();
  // 渲染窗口：一次只渲染 sessionLimit 条已完成的，滚到底部再长一截（SESSION_PAGE）。
  state.sessionLimit = Math.max(SESSION_PAGE, clampCount(state.sessionLimit) || SESSION_PAGE);
  // 渲染序列 = active（置顶）+ 已完成的前 sessionLimit 条。
  // ⚠️ 这是全项目唯一允许把两个数组合并的地方，绝不写回 state.sessions。
  const activeRows = state.sessionActive || [];
  const finishedAll = state.sessions || [];
  const shown = finishedAll.slice(0, state.sessionLimit);
  const rows = activeRows.concat(shown);
  box.innerHTML = rows.map((s) => {
    const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
    const waitHtml = s.status === 'waiting' && s.waitUntil
      ? `<span class="session-wait" data-until="${Number(s.waitUntil)}">等待中 · ${fmtWaitRemain(Number(s.waitUntil))}</span>`
      : '';
    const activityHtml = s.status === 'running' && s.activity
      ? `<span class="session-activity">${esc(s.activity)}</span>`
      : '';
    const searchHtml = Number(s.webSearchCount) > 0
      ? `<span class="muted">搜 ${s.webSearchCount}</span>`
      : '';
    const isNew = !state.seenSessionIds.has(s.id);
    // 未读点：新会话来了但用户正看着别的会话（点开即消，见 selectSession）
    const isUnread = !!(state.unseenSessionIds && state.unseenSessionIds.has(s.id));
    // 失败会话的重试按钮：只有 error 状态且没发出过消息的才显示
    // （已发言的重试会导致群里重复内容，后端同样会拒绝）
    const retryHtml = s.status === 'error' && !(s.sent && s.sent.length)
      ? `<button class="btn btn-small session-retry-btn" data-id="${esc(s.id)}" title="把这条会话的触发消息翻回未读并重新处理">重试</button>`
      : '';
    // 运行中/等待中会话的中止按钮：运行中在下一轮请求前安全收尾，等待中直接干净消失
    const abortHtml = (s.status === 'running' || s.status === 'waiting')
      ? `<button class="btn btn-small btn-danger session-abort-btn" data-id="${esc(s.id)}" title="中止这次处理（已发出的消息不受影响）">中止</button>`
      : '';
    return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''} ${s.status === 'waiting' ? 'session-waiting-row' : ''} ${isNew ? 'new-item' : ''}" data-id="${s.id}">
        <div class="session-title">
          ${isUnread ? '<span class="session-unread-dot" title="有新会话，点开即消"></span>' : ''}
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          ${waitHtml}
          ${activityHtml}
          ${retryHtml}
          ${abortHtml}
          ${s.status !== 'waiting' ? `<span>${s.usage ? fmtTokens(s.usage.totalTokens) : '-'}</span><span>${s.rounds || 0} 轮</span>${searchHtml}</span>` : ''}
        </div>
      </div>`;
  }).join('');
  // 计数口径：分子/分母都只数**已完成**，active 另标"＋N 运行中"。
  // 用本地已加载数当分母会显示成"15/200"；用 all.length 当分子在 active 存在时
  // 会出现"15 / 12"这类分子大于分母的荒谬值。
  const finishedShown = Math.min(state.sessionLimit, finishedAll.length);
  const totalFinished = clampCount(state.sessionTotalFinished);
  const restFinished = Math.max(0, totalFinished - finishedShown);
  // 底部提示：服务端还剩多少条没显示 / 已全部显示
  const more = $('#session-more');
  if (more) {
    more.textContent = restFinished > 0
      ? `向下滚动加载更多（还有 ${restFinished} 条）`
      : (totalFinished > SESSION_PAGE ? `已显示全部 ${totalFinished} 条` : '');
  }
  // 头部显示（已完成已显示 / 已完成总数）＋运行中条数
  const cnt = $('#session-count');
  if (cnt) {
    const parts = [];
    if (totalFinished > 0) parts.push(`${finishedShown}/${totalFinished}`);
    if (activeRows.length) parts.push(`+${activeRows.length} 运行中`);
    cnt.textContent = parts.join(' ');
  }
  // 已见标记对渲染序列（active + 已完成）一起累加：只加已完成的话，
  // active 行每次重绘都会重新播一遍 new-item 淡入。
  for (const s of rows) state.seenSessionIds.add(s.id);
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });
  // 失败会自动重试一次的 api 封装（用于"偶发 failed to fetch"的点击类操作：
  // 中止/重试等）。后端在收尾时会做同步落盘（大会话 JSON 写盘可达几百毫秒），
  // 期间其它请求会在 TCP 队列里排队；偶发的连接抖动/瞬间拒绝会以
  // TypeError: Failed to fetch 冒出来 —— 这类瞬态失败重试一次几乎必成。
  // 只重试网络层失败（TypeError），HTTP 4xx/5xx 是服务器的明确答复，不重试。
  async function apiWithRetry(path, options = {}, retries = 1) {
    try {
      return await api(path, options);
    } catch (err) {
      const transient = err instanceof TypeError || /failed to fetch|network|load failed/i.test(String(err?.message || ''));
      if (!transient || retries <= 0) throw err;
      await new Promise((r) => setTimeout(r, 350));
      return apiWithRetry(path, options, retries - 1);
    }
  }

  // 失败会话的「重试」：把触发消息翻回未读并重新处理。
  // stopPropagation：点了重试就别选中这条会话（用户意图是重跑，不是看详情）
  $$('.session-retry-btn', box).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '重试中…';
      try {
        const r = await apiWithRetry(`/api/sessions/${encodeURIComponent(btn.dataset.id)}/retry`, {
          method: 'POST',
          body: '{}'
        });
        if (!r.ok) throw new Error(r.error || '无法重试');
        // 新会话由唤醒流程创建；列表靠 SSE/轮询刷新，这里立即拉一次
        await loadSessions({ quiet: true });
      } catch (err) {
        alert(`重试失败：${err.message}`);
        btn.disabled = false;
        btn.textContent = '重试';
      }
    });
  });
  // 运行中/等待中的「中止」：请求后端安全收尾这条会话。
  // 中止是"尽快别再继续"，不是立即截断 —— 后端在下一轮 LLM 请求前收尾，
  // 已发出的消息不受影响。列表刷新靠 SSE/轮询，这里立即拉一次。
  $$('.session-abort-btn', box).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '中止中…';
      try {
        const r = await apiWithRetry(`/api/sessions/${encodeURIComponent(btn.dataset.id)}/abort`, {
          method: 'POST',
          body: '{}'
        });
        if (!r.ok) throw new Error(r.error || '无法中止');
        await loadSessions({ quiet: true });
      } catch (err) {
        alert(`中止失败：${err.message}`);
        btn.disabled = false;
        btn.textContent = '中止';
      }
    });
  });
  // 等待中会话的剩余时间按 0.1s 本地刷新（不重新拉列表）
  if ($$('.session-wait[data-until]', box).length) startWaitTicker();
}

function fmtWaitRemain(untilMs) {
  const remain = Math.max(0, Number(untilMs) - Date.now());
  return `${(remain / 1000).toFixed(1)}s`;
}

let waitTicker = null;
function startWaitTicker() {
  if (waitTicker) return;
  waitTicker = setInterval(() => {
    const els = $$('.session-wait[data-until]');
    if (!els.length) {
      clearInterval(waitTicker);
      waitTicker = null;
      return;
    }
    for (const el of els) {
      const until = Number(el.dataset.until);
      const remain = until - Date.now();
      el.textContent = remain > 0 ? `等待中 · ${(remain / 1000).toFixed(1)}s` : '等待中 · 启动…';
    }
  }, 100);
}

async function selectSession(id) {
  state.currentSessionId = id;
  // 点开即消未读点（无论从列表点还是自动跟随）
  state.unseenSessionIds?.delete(id);
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  $('#session-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadSessionDetail(id);
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

async function loadSessionDetail(id, { quiet = false } = {}) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.sessionDetail = s;
    if (state.currentSessionId === id && state.tab === 'sessions') renderSessionDetail(s);
  } catch (e) {
    if (!quiet) $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  if (!detail) return;
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  // json 模式切换也要触发重渲染
  const fp = `${s.id}|${s.status}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.activity || ''}|${state.sessionJsonMode === s.id ? 'json' : 'ui'}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const usage = s.usage || {};

  const html = [];
  const canDelete = s.status !== 'running';   // 运行中的会话不能删（usage 还在累加）
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}
        <button class="btn btn-small" id="json-mode-btn" style="margin-left:10px">JSON 模式</button>
        ${canDelete ? `<button class="btn btn-small btn-danger" id="session-delete-btn" style="margin-left:6px" title="删除这条会话记录">删除</button>` : ''}
      </h2>
      <div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总</span>
        <span>${s.rounds || 0} 轮工具</span>
        <span>联网搜索 ${Number(s.webSearchCount) || 0} 次</span>
      </div>
    </div>`);

  const jsonMode = state.sessionJsonMode === s.id;
  if (jsonMode) {
    // JSON 模式：原模原样展示输入给模型的内容 + 模型返回的原始内容
    const raw = {
      sessionId: s.id,
      chatKey: s.chatKey,
      model: s.model || '',
      systemPrompt: s.systemPrompt || '',
      userPrompt: s.userPrompt || '',
      inputMessages: (s.inputMessages || []).map((m) => ({ role: m.role, content: m.content })),
      llmMessages: (s.messages || []).filter((m) => m.role === 'assistant').map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls ?? null,
        raw: m.raw ?? null
      })),
      toolResults: (s.messages || []).filter((m) => m.toolCall).map((m) => ({
        toolCall: m.toolCall
      })),
      sent: s.sent || [],
      usage: s.usage || null,
      status: s.status,
      error: s.error ?? null
    };
    html.push(`
      <details class="collapsible" open>
        <summary>JSON 模式（模型输入/输出的原始内容）</summary>
        <div class="coll-body" style="max-height:none">${esc(JSON.stringify(raw, null, 2))}</div>
      </details>`);
  } else {
    if (s.systemPrompt) {
      html.push(`
        <details class="collapsible">
          <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
          <div class="coll-body">${esc(s.systemPrompt)}</div>
        </details>`);
    }
    if (s.userPrompt) {
      html.push(`
        <details class="collapsible">
          <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
          <div class="coll-body">${esc(s.userPrompt)}</div>
        </details>`);
    }
  }

  html.push('<div class="msg-flow">');
  if (!jsonMode) {
    for (const item of s.messages || []) {
      if (item.toolCall) {
        const meta = (typeof TOOL_META === 'object' && TOOL_META) ? TOOL_META[item.toolCall.name] : null;
        const ico = meta?.icon || '⚒';
        const label = meta?.name || item.toolCall.name;
        const err = item.toolCall.isError;
        html.push(`
          <details class="collapsible tool-flow ${err ? 'tool-error' : ''}">
            <summary>
              <span class="tool-ico">${ico}</span>
              <span class="tool-name-flow">${esc(item.toolCall.name)}</span>
              <span class="tool-label">${esc(label)}</span>
              ${err ? '<span class="badge err">失败</span>' : '<span class="badge ok">成功</span>'}
            </summary>
            <div class="coll-body">
              <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
              <div class="tool-result ${err ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
            </div>
          </details>`);
      } else if (item.toolImages) {
        html.push(`
          <details class="collapsible tool-flow">
            <summary>
              <span class="tool-ico">🖼️</span>
              <span class="tool-name-flow">${esc(item.toolImages.tool)}</span>
              <span class="tool-label">${item.toolImages.count} 张图片</span>
            </summary>
            <div class="coll-body muted">已作为图像输入注入模型</div>
          </details>`);
      } else if (item.role === 'assistant') {
        const text = typeof item.content === 'string' ? item.content : '';
        if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
        html.push(`
          <details class="collapsible tool-flow think-flow">
            <summary>
              <span class="tool-ico">💭</span>
              <span class="tool-name-flow">思考</span>
              <span class="tool-label">不发送</span>
            </summary>
            <div class="coll-body think-body">${esc(text || '（无文本输出，仅调用工具）')}</div>
          </details>`);
      }
    }
    // 发出的消息
    // 已发送到 QQ：全部合并成一张卡（默认展开），逐条换行展示
    const sentList = s.sent || [];
    if (sentList.length) {
      const sentLines = sentList.map((sent) =>
        `已发送到 QQ${sent.at ? ` · ${esc(sent.at)}` : ''}\n${esc(sent.text)}`
      ).join('\n\n');
      html.push(`
        <details class="collapsible tool-flow sent-flow" open>
          <summary>
            <span class="tool-ico">💬</span>
            <span class="tool-name-flow">已发送到 QQ</span>
            <span class="tool-label">${sentList.length} 条消息</span>
            <span class="badge ok">已送达</span>
          </summary>
          <div class="coll-body sent-body">${sentLines}</div>
        </details>`);
    }
  }
  if (s.error) {
    html.push(`
      <details class="collapsible tool-flow error-flow" open>
        <summary>
          <span class="tool-ico">⚠</span>
          <span class="tool-name-flow">错误</span>
          <span class="tool-label">运行失败</span>
          <span class="badge err">异常</span>
        </summary>
        <div class="coll-body error-body">${esc(s.error)}</div>
      </details>`);
  }
  // finish 收尾：单独一张卡（默认展开）
  if (s.finishReason) {
    html.push(`
      <details class="collapsible tool-flow finish-flow" open>
        <summary>
          <span class="tool-ico">🏁</span>
          <span class="tool-name-flow">finish</span>
          <span class="tool-label">结束本次</span>
        </summary>
        <div class="coll-body finish-body">${esc(s.finishReason)}</div>
      </details>`);
  }
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  // 切换会话（首次渲染）时详情整体淡入；轮询/SSE 的原地刷新不播，避免运行中闪烁
  if (firstRender) uiEnter(detail);
  const jsonBtn = $('#json-mode-btn');
  if (jsonBtn) jsonBtn.addEventListener('click', () => {
    state.sessionJsonMode = state.sessionJsonMode === s.id ? null : s.id;
    lastDetailFp = null;   // 强制重渲染
    renderSessionDetail(s);
  });
  // 删除这条会话记录
  const delBtn = $('#session-delete-btn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!(await uiConfirm(`确定删除这条会话记录？\n\n触发：${s.triggerSummary || '-'}\n时间：${fmtClock(s.startedAt)}\n\n删除后不可恢复（不影响用量统计的历史数据）。`))) return;
    try {
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
      state.currentSessionId = null;
      // 本地按 id 移除（幂等）：随后到达的 session-end(deleted) 找不到该行，
      // 不会二次回退计数；tombstone 挡住 reset 在途的旧快照把它复活。
      // 不再补一次全量请求 —— 服务端的 deleted 事件已经足够。
      removeSessionById(s.id);
      addSessionTombstone(s.id);
      state.unseenSessionIds?.delete(s.id);
      $('#session-detail').innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
      renderSessionList();
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
  if (firstRender || (s.status === 'running' && wasAtBottom)) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  // 说明：此处原先有一段"运行中每 2s 自递归拉详情"的兜底轮询，已移除。
  // 原因：renderSessionDetail 会被 SSE 事件和高频刷新反复调用，每次都新起一个
  // setTimeout 且从不取消旧的，切换/高频刷新时 timer 会不断累积。
  // P0-03 起会话列表轮询也已删除：运行中会话的详情改由 session-update 的
  // pendingSessionDetail 合并刷新，终态由 session-end 主动重拉一次，
  // 首屏/断线重连时由 loadSessions 的 followAndRefreshDetail 兜一次。
}
