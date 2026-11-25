// 第 5 期 · 第 8 步：记忆浏览器（5a）的业务层。
//
// ── 为什么逻辑不写在 routes.js 里 ──────────────────────────────────────
// 路由那一层只该做「解析参数 → 调这里 → 回 JSON」。把判断写在路由里，
// 想测「PATCH 只收 content」就得起一个 server 或者 mock 一堆 deps；
// 写在这里，一个纯函数就能测 —— 而这三条硬约束（只改内容 / pinned / 软删可撤销）
// 恰恰是本期最容易被改坏的地方。
//
// ── 三条硬约束（施工单 §4.2）──────────────────────────────────────────
//   1. PATCH **只接受 content**；改 status / groups / entryId 一律 400。
//      为什么这么严：这两个字段一旦能被前端改，注入时的分组权重和条目身份就
//      由 UI 说了算，而它们分别由提炼阶段与 append-only 存储决定。
//   2. 编辑写入**新版本** `{pinnedByUser:true, editedFrom:原entryId}`，原条目 superseded。
//      pinned 是"别去重我"的标记（第 7 步），editedFrom 是溯源（makeL1Entry 白名单）。
//   3. 删除是软删 `status:'void'`，可撤销；只有"彻底删除"才需要二次确认（5b）。

import {
  readPerson, appendPerson, setPersonStatus, listPersonIds,
  makeL1Entry, makeL1EntryId, readCoverage, readL4, activePerson,
  readCandidates, listCandidatesAll, deleteCandidate,
  listConflicts, resolveConflict, purgePersonEntry, readDeletions
} from './store.js';
import { readRun, readTotals, gateRemain, BACKFILL_LIMITS } from './backfill-state.js';
import { readProfile, computeDigest, scanSensitive } from './profile.js';
import { ymOf, readSchema } from './paths.js';

/** 参数错误的统一形状：路由层据此回 400。 */
export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad-request';
    this.status = 400;
  }
}

export class NotFound extends Error {
  constructor(message) {
    super(message);
    this.code = 'not-found';
    this.status = 404;
  }
}

/** entryId → userId。id 形如 `l1_<uid>_<ts>_<seq>`（第 2 期定的格式）。 */
export function userIdOfEntry(entryId) {
  const m = /^l1_(.+)_\d+_\d+$/.exec(String(entryId || '').trim());
  return m ? m[1] : '';
}

/** 一条画像对 UI 的投影（不外泄内部字段，也不带上整份 sourceBatch 的噪音）。 */
function viewEntry(e) {
  return {
    entryId: e.entryId,
    content: e.content,
    groups: e.groups || [],
    status: e.status || 'active',
    pinnedByUser: e.pinnedByUser === true,
    deduped: e.deduped === true,
    editedFrom: e.editedFrom || '',
    sourceMsgIds: e.sourceMsgIds || [],
    sourceChatKeys: e.sourceChatKeys || [],
    createdAt: e.createdAt || 0,
    updatedAt: e.updatedAt || e.createdAt || 0
  };
}

/**
 * 人物列表。
 * @param {object} opts
 * @param {string} [opts.chat]  只看在这个群出现过的（sourceChatKeys 命中）
 * @param {string} [opts.q]     按 uid / 内容模糊查
 */
export function listPeople({ chat = '', q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const out = [];
  for (const uid of listPersonIds()) {
    const person = readPerson(uid);
    const active = person.list.filter((e) => e.status === 'active');
    if (chat && !active.some((e) => (e.sourceChatKeys || []).includes(chat))) continue;
    if (needle && !uid.toLowerCase().includes(needle)
      && !active.some((e) => String(e.content || '').toLowerCase().includes(needle))) continue;
    const chats = new Set();
    for (const e of active) for (const k of e.sourceChatKeys || []) chats.add(k);
    // ★ 印象/知识/摘要三页（2026-11-17 重写）：每个群的 active 出现次数 + 最近更新时间。
    //   只用于前端选「主群」（决定主昵称与第一行群信息），**不参与记忆语义、去重、注入**。
    //   一条多群来源的条目会在多个群各计一次 —— 这是「出现次数」不是严格分区计数，
    //   与真实活跃度一致；多群全 tie 时落第三键 chatKey 字典序（有意接受，见施工单 §4.2）。
    const stats = new Map();
    for (const e of active) {
      for (const k of e.sourceChatKeys || []) {
        const s = stats.get(k) || { chatKey: k, activeCount: 0, lastUpdatedAt: 0 };
        s.activeCount += 1;
        s.lastUpdatedAt = Math.max(s.lastUpdatedAt, Number(e.updatedAt) || Number(e.createdAt) || 0);
        stats.set(k, s);
      }
    }
    const chatStats = [...stats.values()].sort((a, b) =>
      Number(!a.chatKey.startsWith('group:')) - Number(!b.chatKey.startsWith('group:'))
      || b.activeCount - a.activeCount
      || b.lastUpdatedAt - a.lastUpdatedAt
      || a.chatKey.localeCompare(b.chatKey)
    );
    out.push({
      userId: uid,
      activeCount: active.length,
      totalCount: person.list.length,
      chatCount: chats.size,
      chatKeys: [...chats].sort(),
      chatStats,
      lastUpdatedAt: Math.max(0, ...person.list.map((e) => Number(e.updatedAt) || Number(e.createdAt) || 0))
    });
  }
  return out.sort((a, b) => b.activeCount - a.activeCount || a.userId.localeCompare(b.userId));
}

/**
 * 印象 3D 星图的只读数据：人物 + 每条 active 印象的轻量元数据。
 * 图是全量：不接收 chat/q，群筛选与搜索只影响左栏列表。
 */
export function graphData() {
  const people = [];
  const impressions = [];
  for (const p of listPeople({})) {
    const uid = String(p.userId || '');
    const activeCount = Number(p.activeCount) || 0;
    if (!uid || activeCount <= 0) continue;
    people.push({
      userId: uid,
      activeCount,
      chatKeys: Array.isArray(p.chatKeys) ? p.chatKeys.slice() : [],
      chatStats: Array.isArray(p.chatStats) ? p.chatStats : []
    });
    for (const e of activePerson(uid)) {
      const chars = Array.from(String(e.content || ''));
      impressions.push({
        entryId: String(e.entryId || ''),
        userId: uid,
        groups: Array.isArray(e.groups) ? e.groups.slice() : [],
        createdAt: Number(e.createdAt) || 0,
        preview: chars.slice(0, 50).join(''),
        previewTruncated: chars.length > 50
      });
    }
  }
  return { people, impressions, total: impressions.length };
}

/** 某个人的全部条目。默认隐藏 superseded（UI 默认列表只该看有效的）。 */
export function getPerson(userId, { includeSuperseded = false } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw new BadRequest('userId 必填');
  const person = readPerson(uid);
  if (!person.list.length) throw new NotFound(`没有这个人的画像：${uid}`);
  const list = person.list.filter((e) => includeSuperseded || e.status !== 'superseded');
  const active = person.list.filter((e) => e.status === 'active');
  // 派生画像只读摘要（A 方案：profile.json 不是事实来源，UI 不许改它）。
  // dirty = profile 建好之后 active 又变过（digest 含 pinned、不含 updatedAt）。
  const prof = readProfile(uid);
  const profile = prof ? {
    builtAt: Number(prof.builtAt) || 0,
    model: prof.model || '',
    slots: (prof.slots || []).map((s) => ({
      dim: s.dim,
      content: s.content,
      chars: s.chars,
      sourceEntryIds: s.sourceEntryIds || [],
      // 审计用：题材词只统计、不拦截，槽照常注入；这里给出命中词供后台观测
      sensitive: scanSensitive(s.content)
    })),
    dirty: prof.sourceDigest !== computeDigest(active)
  } : null;
  return {
    userId: uid,
    entries: list.map(viewEntry),
    profile,
    counts: {
      active: person.list.filter((e) => e.status === 'active').length,
      superseded: person.list.filter((e) => e.status === 'superseded').length,
      void: person.list.filter((e) => e.status === 'void').length,
      conflicted: person.list.filter((e) => e.status === 'conflicted').length
    }
  };
}

const ALLOWED_PATCH_KEYS = new Set(['content']);
const FORBIDDEN_PATCH_KEYS = new Set(['status', 'groups', 'entryId', 'userId', 'pinnedByUser', 'sourceBatch', 'sourceMsgIds']);

/**
 * 改一条画像的内容（唯一的写入口）。
 *
 * @returns {{oldEntryId:string, entry:object}} 新版本 + 被它取代的原条目
 */
export function editEntry(entryId, body = {}, { now = Date.now() } = {}) {
  const id = String(entryId || '').trim();
  if (!id) throw new BadRequest('entryId 必填');

  const keys = Object.keys(body || {});
  const bad = keys.filter((k) => FORBIDDEN_PATCH_KEYS.has(k));
  if (bad.length) {
    // 明确拒绝，不做"忽略掉就算了"——静默忽略会让前端以为改成功了
    throw new BadRequest(`不允许修改 ${bad.join('/')}：只接受 content`);
  }
  const extra = keys.filter((k) => !ALLOWED_PATCH_KEYS.has(k));
  if (extra.length) throw new BadRequest(`未知字段 ${extra.join('/')}：只接受 content`);

  const content = String(body?.content ?? '').trim();
  if (!content) throw new BadRequest('content 不能为空');

  const uid = userIdOfEntry(id);
  if (!uid) throw new BadRequest('entryId 格式不对（应为 l1_<uid>_<ts>_<seq>）');
  const cur = readPerson(uid).byId.get(id);
  if (!cur) throw new NotFound(`找不到这条画像：${id}`);

  // 新版本主键：同一毫秒内多次编辑要能区分，所以从 1 递增找一个没人用的 seq。
  // 不用时间戳后缀 —— entryId 的排序价值在于 createdAt 段，后缀乱了就失去意义。
  const taken = readPerson(uid).byId;
  let seq = 1;
  let newId = makeL1EntryId({ userId: uid, at: now, seq });
  while (taken.has(newId)) { seq += 1; newId = makeL1EntryId({ userId: uid, at: now, seq }); }

  const next = makeL1Entry({
    entryId: newId,
    chatKey: cur?.sourceBatch?.chatKey,
    userId: uid,
    sourceBatch: cur?.sourceBatch || { chatKey: 'unknown', userId: uid },
    sourceMsgIds: cur?.sourceMsgIds || [],
    sourceChatKeys: cur?.sourceChatKeys || [],
    content,
    groups: cur?.groups || [],          // 分组不让 UI 改，原样继承
    status: 'active',
    pinnedByUser: true,                  // ★ 标了 pinned，两处去重都不会再动它
    deduped: true,                       // 已经过人工确认，不必再送去语义去重
    editedFrom: id,                      // ★ 溯源（makeL1Entry 白名单里必须有它）
    createdAt: now,
    updatedAt: now
  });
  appendPerson(next);
  // 原条目退场。注意用 setPersonStatus（追加同 entryId 的状态行），不是原地改。
  setPersonStatus(uid, id, 'superseded', { nowTs: now });
  return { oldEntryId: id, entry: viewEntry(next) };
}

/**
 * 软删 / 撤销。
 * `void` → status:'void'（还能 undo 回来）；`undo` → 回到 'active'。
 * 彻底删除不在这里（5b），它要二次确认参数，不该和"点一下就删"混用一个口子。
 */
export function setEntryStatus(entryId, action, { now = Date.now() } = {}) {
  const id = String(entryId || '').trim();
  const act = String(action || '').trim();
  if (!['void', 'undo'].includes(act)) throw new BadRequest(`action 只能是 void / undo，收到 ${act}`);
  const uid = userIdOfEntry(id);
  if (!uid) throw new BadRequest('entryId 格式不对');
  const cur = readPerson(uid).byId.get(id);
  if (!cur) throw new NotFound(`找不到这条画像：${id}`);

  if (act === 'undo' && cur.status !== 'void') {
    throw new BadRequest(`只有 void 状态的条目能撤销，当前是 ${cur.status}`);
  }
  if (act === 'void' && cur.status === 'void') {
    return { entry: viewEntry(cur), changed: false };   // 幂等
  }
  const next = setPersonStatus(uid, id, act === 'void' ? 'void' : 'active', { nowTs: now });
  return { entry: viewEntry(next), changed: true };
}

/**
 * 彻底删除（5b ①）：物理抹掉一个 entryId 的**全部版本行**，不可逆。
 *
 * ★ 二次确认是**后端强制**的，不只是前端弹窗 —— 否则有人直接 POST 接口就能绕过
 *   「你确定吗」。调用方必须显式传 `confirm === 'DELETE'` 这个字符串（和界面上
 *   要求用户输入的确认词一致），少一个字都 400。
 *
 * 这与软删 `setEntryStatus('void')` 是两个完全不同的口子：软删可撤销、幂等、日常用；
 * 彻底删除不可逆、要确认、留审计。绝不混用。
 *
 * @param {object} opts
 * @param {string} opts.entryId
 * @param {string} opts.confirm  必须恰好是 'DELETE'
 * @param {string} [opts.reason] 删除理由（写进审计）
 */
export function purgeEntry({ entryId = '', confirm = '', reason = '' } = {}, { now = Date.now() } = {}) {
  const id = String(entryId || '').trim();
  if (!id) throw new BadRequest('entryId 必填');
  if (String(confirm || '') !== 'DELETE') {
    throw new BadRequest('彻底删除需要二次确认：confirm 必须恰好是 "DELETE"（此操作不可逆）');
  }
  const uid = userIdOfEntry(id);
  if (!uid) throw new BadRequest('entryId 格式不对');
  const r = purgePersonEntry(uid, id, { reason: String(reason || '').trim() || '用户在记忆库彻底删除', nowTs: now });
  if (!r) throw new NotFound(`找不到这条画像的全部版本：${id}`);
  return { ok: true, ...r };
}

/** 删除审计条数（UI 顶部可展示，也方便核对「删了有没有留痕」）。 */
export function deletionCount() {
  return readDeletions().length;
}

/** 摘要列表（L4）。 */
export function listL4({ chat = '', ym = '' } = {}) {
  const chatKey = String(chat || '').trim();
  if (!chatKey) throw new BadRequest('chat 必填');
  const month = String(ym || '').trim() || ymOf(Date.now());
  const rows = readL4(chatKey, month);
  return { chat: chatKey, ym: month, count: rows.length, summaries: rows };
}

/** 覆盖表：六态 + deferredReason（UI 要能回答"这段为什么没摘要"）。 */
export function listCoverage({ chat = '' } = {}) {
  const chatKey = String(chat || '').trim();
  if (!chatKey) throw new BadRequest('chat 必填');
  const cov = readCoverage(chatKey);
  const counts = { ok: 0, short: 0, pending: 0, failed: 0, other: 0 };
  for (const r of cov.list) counts[counts[r.state] === undefined ? 'other' : r.state] += 1;
  return {
    chat: chatKey,
    total: cov.list.length,
    counts,
    rows: cov.list.map((r) => ({
      convStartTs: r.convStartTs, convEndTs: r.convEndTs,
      msgCount: r.msgCount, humanMsgCount: r.humanMsgCount,
      state: r.state,
      deferredReason: r.deferredReason || null,
      attempts: r.attempts || 0,
      failedReason: r.parseErrors?.failed || '',
      resolvedByBackfill: r.resolvedByBackfill || '',
      updatedAt: r.updatedAt || 0
    }))
  };
}

/** 回填状态（跑没跑、用了多少、闸门余量）。供命令行/运维查询，UI 已不展示回填入口。 */
export function backfillStatus({ runId = '' } = {}) {
  const id = String(runId || '').trim();
  const run = id ? readRun(id) : null;
  const totals = readTotals();
  const remain = gateRemain();
  return {
    runId: id || null,
    run: run ? {
      runId: run.runId,
      calls: run.calls || 0,
      cost: run.cost || 0,
      doneCount: Object.keys(run.done || {}).length,
      aborted: run.aborted === true,
      abortReason: run.abortReason || '',
      startedAt: run.startedAt || 0,
      finishedAt: run.finishedAt || 0
    } : null,
    totals,
    limits: { maxCalls: BACKFILL_LIMITS.maxCalls, maxCost: BACKFILL_LIMITS.maxCost },
    remain: { callsLeft: remain.callsLeft, costLeft: remain.costLeft },
    switchTs: Number(readSchema()?.switchTs) || 0
  };
}

/** 人列表里的条目数：给 UI 顶部的总览用（不出错就返回数字）。 */
export function overview() {
  let active = 0;
  let people = 0;
  for (const uid of listPersonIds()) {
    const n = activePerson(uid).length;
    if (n) people += 1;
    active += n;
  }
  return { people, activeEntries: active };
}

// ══════════════════════════════════════════════════════════════════════════
// 5b · 治理闭环（候选池 / 冲突 / L3 知识）
// ══════════════════════════════════════════════════════════════════════════

/** 一条候选对 UI 的投影。**必须带 chatKey**（候选行本身没有这个字段）。 */
function viewCandidate(c) {
  return {
    entryId: c.entryId,
    chatKey: c.chatKey || '',
    kind: c.kind || 'model_proposal',
    fromUserId: c.fromUserId || '',
    msgId: c.msgId || '',
    text: c.text || '',
    ts: Number(c.ts) || 0,
    status: c.status || 'pending',
    updatedAt: Number(c.updatedAt) || Number(c.ts) || 0
  };
}

/**
 * 候选池列表（UI「候选池」页签）。
 *
 * ⚠️ 硬约束 17：候选池**不可注入、不可被模型检索**。这里是给**人**看的，
 * 出现在 UI 上不等于出现在提示词里 —— 两者走的是完全不同的读路径
 * （注入只看 activePerson 的 L1 条目，永远不会碰 candidates.jsonl）。
 *
 * @param {object} opts
 * @param {string} [opts.chat]   只看某个群（空 = 全部群）
 * @param {string} [opts.status] pending / adopted / dropped / deleted，或 'all'
 */
export function listCandidates({ chat = '', status = 'pending' } = {}) {
  const st = String(status || 'pending').trim();
  const statuses = st === 'all'
    ? ['pending', 'adopted', 'dropped', 'deleted']
    : [st];
  const rows = listCandidatesAll({
    chatKeys: chat ? [String(chat)] : null,
    statuses
  });
  // 各状态计数：UI 的页签角标要它，图省事不额外开接口
  const all = listCandidatesAll({ chatKeys: chat ? [String(chat)] : null, statuses: ['pending', 'adopted', 'dropped', 'deleted'] });
  const counts = { pending: 0, adopted: 0, dropped: 0, deleted: 0 };
  for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;
  return { candidates: rows.map(viewCandidate), counts, total: all.length };
}

/**
 * 删除一条候选（append-only：写一行 `status='deleted'`，原行留着）。
 * 删除只对 pending 有意义 —— 已 adopted/dropped 的是历史裁决，删了等于抹掉留痕。
 */
export function deleteCandidateById({ chatKey = '', entryId = '', reason = '用户在记忆库删除' } = {}) {
  const ck = String(chatKey || '').trim();
  const id = String(entryId || '').trim();
  if (!ck || !id) throw new BadRequest('chatKey 与 entryId 都必填');
  const cur = readCandidates(ck).byId.get(id);
  if (!cur) throw new NotFound(`候选不存在：${id}`);
  if (cur.status !== 'pending') throw new BadRequest(`只能删除 pending 的候选，这条是 ${cur.status}`);
  const row = deleteCandidate(ck, id, { reason });
  return { ok: true, candidate: viewCandidate({ ...row, chatKey: ck }) };
}

/** 冲突对（UI「待裁决」）。`expired` 的那批会在下一次日扫被自动了结，UI 可以提前提示。 */
export function listConflictPairs({ uid = '' } = {}) {
  const conflicts = listConflicts({ userId: String(uid || '').trim() });
  return {
    conflicts: conflicts.map((c) => ({
      userId: c.userId,
      oldEntryId: c.oldEntryId,
      newEntryId: c.newEntryId,
      oldContent: c.oldContent,
      newContent: c.newContent,
      oldPinned: c.oldPinned,
      createdAt: c.createdAt,
      ageDays: c.ageDays,
      expired: c.expired
    })),
    total: conflicts.length
  };
}

/**
 * 裁决一对冲突。`keep='new'` 采纳新证据，`keep='old'` 保住被 pin 的那条。
 * 传任一侧的 entryId 都行（UI 上点哪边都是「我选这条」）。
 */
export function resolveConflictPair({ userId = '', entryId = '', keep = 'new' } = {}) {
  const uid = String(userId || '').trim();
  const id = String(entryId || '').trim();
  const k = String(keep || 'new').trim();
  if (!uid || !id) throw new BadRequest('userId 与 entryId 都必填');
  if (k !== 'new' && k !== 'old') throw new BadRequest(`keep 只能是 new 或 old，收到 ${k}`);
  const r = resolveConflict({ userId: uid, entryId: id, keep: k });
  if (!r) throw new BadRequest('这条不在冲突状态（可能已被裁决，或 conflictPeer 缺失）');
  return {
    ok: true,
    kept: { entryId: r.kept.entryId, status: r.kept.status, content: r.kept.content },
    dropped: { entryId: r.dropped.entryId, status: r.dropped.status, content: r.dropped.content }
  };
}

/**
 * L3 知识（大纲 §5.3.7b）。
 *
 * **这里返回空是正确结果，不是没做完**：L3 的唯一来源是「搜索 + 纠正」，
 * 不设候选池、不从摘要/提炼里提。当前系统还没有接「搜索 → 验证 → 入库」那条链路，
 * 所以库里一条都没有。UI 该显示空态 + 来源说明，**不许硬造内容填充**。
 */
export function listKnowledge() {
  return {
    entries: [],
    total: 0,
    available: false,
    source: 'search+correction',
    note: 'L3 只从「搜索 + 纠正」入库（路径 A 被纠正 / 路径 B 冷静期后仍被引用），'
      + '不从摘要或提炼里提取。这条链路尚未接线，所以这里是空的 —— 空是正确状态。'
  };
}
