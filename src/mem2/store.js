// 记忆产物的读写（第 1 期第 3 步）：coverage / l4。
//
// 三条不可动的约定：
//   1. **只 append**。coverage 的「状态变化」也是追加一行同主键的新记录，
//      读时按 convStartTs 取**最后一行**（施工单 §2.2）。不重写整月文件。
//   2. **empty 不落盘**（§2.3）。那一刻没有会话，就没有记录可写；`empty` 是
//      **查询态**，由「扫描水位 + 无记录」推导。造占位记录会把月度扫描从
//      「585 条」变成「2000 条，其中 1400 条是空的」。
//   3. **人话与计数分开存**：`msgCount` / `humanMsgCount` 是两个不同口径，
//      T2 与 T3 各用一个，绝不能合并成一个字段。

import fs from 'node:fs';
import path from 'node:path';
import {
  appendLine, readJsonl, coverageFile, l4File, ymOf,
  l1File, candidatesFile, crossGroupIndexFile, safeKey, personFile, peopleDir,
  mem2Dir, chatKeyFromDir, deletionsFile
} from './paths.js';

/** 覆盖表一行（§2.2 的字段，一个不多一个不少）。 */
export function makeCoverageRow({
  chatKey, convStartTs, convEndTs, msgCount, humanMsgCount,
  state, deferredReason = null, parseErrors = null, attempts = 0, nowTs = Date.now()
}) {
  return {
    chatKey,
    convStartTs: Math.round(Number(convStartTs) || 0),
    convEndTs: Math.round(Number(convEndTs) || 0),
    msgCount: Number(msgCount) || 0,
    humanMsgCount: Number(humanMsgCount) || 0,
    state,
    deferredReason: deferredReason || null,
    parseErrors: parseErrors || { topic: 0 },
    attempts: Number(attempts) || 0,
    updatedAt: nowTs
  };
}

export function appendCoverage(chatKey, row) {
  appendLine(coverageFile(chatKey), row);
}

/**
 * 读覆盖表：返回追加序的原始行 + 按主键取最后一行的索引。
 * @returns {{rows:Array, byStart:Map<number,object>, list:Array}}
 */
export function readCoverage(chatKey) {
  const rows = readJsonl(coverageFile(chatKey));
  const byStart = new Map();
  for (const r of rows) {
    const k = Number(r?.convStartTs);
    if (!Number.isFinite(k)) continue;
    byStart.set(k, r);                 // 后写覆盖先写 = 取最后一行
  }
  const list = [...byStart.values()].sort((a, b) => a.convStartTs - b.convStartTs);
  return { rows, byStart, list };
}

export function findCoverage(chatKey, convStartTs) {
  return readCoverage(chatKey).byStart.get(Number(convStartTs)) || null;
}

/**
 * 按 `convEndTs` 定位覆盖行（第 5 期补丁）。
 *
 * ── 为什么需要这个 ──────────────────────────────────────────────────────
 * `convStartTs` 是 `splitConvs` 切出来的边界，**取决于切分时刻与消息序列**，
 * 同一段历史不同时刻切、起点会漂（实测 117 行里 43 行漂 3 秒~30 分钟，36.8%）。
 * 用 startTs 精确等值找行，漂移的 `failed` 行就永远查不到 → 判「无覆盖」→
 * 回填用新 startTs 再写一行 ok → 旧 failed 的 key 是老的，**永远清不掉**，
 * 「failed 归零」这条验收就永远黄。
 *
 * `convEndTs` 稳得多（108/117 = 92.3% 能对上），因为漂移主要发生在前一个 gap 的位置，
 * 终点由下一条消息或下一个会话的起点决定，相对稳。
 *
 * ── 为什么用「落在区间内」而不是 ±N 分钟 ───────────────────────────────
 * 容差是个魔法数：给 5 分钟挡不住 21 分钟那种漂，给 30 分钟会把隔壁会话也吞进来。
 * 「endTs 落在某行的 [start,end] 内」是确定性判据，可测、可解释。
 *
 * 端点算命中（`convEndTs == row.convStartTs` / `== row.convEndTs` 都在内），
 * 与 `findConvRow` 的端点语义保持一致。
 *
 * ── 两遍扫：先「终点正好对上」，再「落在区间内」──────────────────────
 * 只用一遍会有一个边界坑：若两行首尾相接（A.end == B.start），`t` 恰好等于那个点，
 * 两行都"包含"它，返回哪一行取决于遍历顺序 —— 那是隐式行为，不是判据。
 * 已知终点时，「谁的 end 就是它」是唯一确定的答案，所以先扫这一遍把它钉死。
 *
 * @param {{list:Array}} cov readCoverage 的返回值
 * @returns {object|null} 行；多行命中时取 convStartTs 最小的（list 已按它排序）
 */
export function findCoverageByEnd(cov, convEndTs) {
  const t = Number(convEndTs);
  if (!Number.isFinite(t) || t <= 0) return null;
  const list = Array.isArray(cov?.list) ? cov.list : [];
  for (const row of list) {
    if (Number(row.convEndTs) === t) return row;
  }
  for (const row of list) {
    if (t >= Number(row.convStartTs) && t <= Number(row.convEndTs)) return row;
  }
  return null;
}

/**
 * 命中消息 ts → 所属会话行（覆盖表二分，O(log n)）。**只看区间，不看 state。**
 *
 * 语义写死（第 4 期 §2.1）：
 *   「最后一个 `convStartTs ≤ t`，且 `t ≤ 该行 convEndTs`」→ 返回该行；否则 null。
 * 端点算命中（`t == convStartTs`、`t == convEndTs` 都在内）。
 *
 * ⚠️ 不要实现成「任一区间包含 t」：当前覆盖表 0 重叠所以两者结果相同，
 *    但一旦出现嵌套/重叠会话，两种语义给出的行不一样。语义必须先定死再实现。
 *
 * 调用方一次要查多个 ts 时，**先 readCoverage 一次、把 `.list` 传进来**，
 * 别每查一次都 filter+sort 一遍全表。
 *
 * @returns {object|null}
 */
export function findConvRow(coverageList, ts) {
  const arr = (Array.isArray(coverageList) ? coverageList : [])
    .filter((r) => Number.isFinite(Number(r?.convStartTs)))
    .sort((a, b) => Number(a.convStartTs) - Number(b.convStartTs));
  const t = Number(ts);
  if (!Number.isFinite(t) || !arr.length) return null;

  let lo = 0;
  let hi = arr.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(arr[mid].convStartTs) <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return null;

  const row = arr[idx];
  const end = Number(row.convEndTs);
  if (!Number.isFinite(end) || t > end) return null;      // 空档 / 数据缺 convEndTs
  return row;
}

/**
 * 某会话的 L4 摘要（第 4 期 2b）。
 *
 * `readL4` 返回**裸数组**、按追加序；同一 convStartTs 可能有多行（重跑摘要），
 * 所以这里自己实现 last-wins：取最后一行。
 *
 * ★ `sparse=1` **不降级**：实测 26/26 都有正文（avg 73 字），样本可用。
 *   把 sparse 记进返回值让调用方打标，但绝不据此丢弃 —— 一刀切会丢掉 57% 的可用摘要。
 *
 * @returns {{summary:string, convStartTs:number, convEndTs:number, sparse:boolean}|null}
 *   摘要为空/纯空白 → null（调用方据此走 no-l4）
 */
export function readSummaryForConv(chatKey, convStartTs) {
  const start = Number(convStartTs);
  if (!Number.isFinite(start) || start <= 0) return null;
  const rows = readL4(chatKey, ymOf(start));
  let hit = null;
  for (const r of rows) {
    if (Number(r?.convStartTs) === start) hit = r;        // 后写覆盖先写
  }
  if (!hit) return null;
  const summary = String(hit.summary ?? '').trim();
  if (!summary) return null;
  return {
    summary,
    convStartTs: start,
    convEndTs: Number(hit.convEndTs) || 0,
    sparse: hit.sparse === true || hit.sparse === 1
  };
}

/**
 * pending 队列（§5.3.1 的拾取源）。
 *
 * 排序 **attempts 升序、再 convStartTs 升序**：先跑还没怎么试过的，同分时先跑旧的。
 * 「先旧后新」在这里不是排序细节，是防活锁 —— 若总是先跑新会话，配额会在新会话上
 * 耗尽，pending 永远轮不到（表现为"功能正常但老数据一直缺"）。
 */
export function pendingOf(cov) {
  return cov.list
    .filter((r) => r.state === 'pending')
    .sort((a, b) => (Number(a.attempts) || 0) - (Number(b.attempts) || 0)
      || a.convStartTs - b.convStartTs);
}

/** 便捷版：自己读一遍覆盖表再挑 pending。调用方若一轮里要用多次，先 readCoverage 再 pendingOf。 */
export function readPending(chatKey) {
  return pendingOf(readCoverage(chatKey));
}

export function appendL4(chatKey, rec) {
  appendLine(l4File(chatKey, ymOf(rec.convStartTs)), rec);
}

/** 读某月的 L4 记录（默认当月）。摘要页 / 自动回溯摘要头按需传月。 */
export function readL4(chatKey, ym = ymOf(Date.now())) {
  return readJsonl(l4File(chatKey, ym));
}

/**
 * 查询某区间的状态（§2.3 的四态 + 一个"还没扫到"）。
 *
 * | 情况 | 返回 | 含义 |
 * |---|---|---|
 * | 区间内有 ok | `ok` | 正常回答 |
 * | 否则有 pending | `pending` | 这段还在整理 |
 * | 否则有 failed | `failed` | 这段没记下（**绝不能说没人说话**） |
 * | 无记录且 to <= lastScanTs | `empty` | 确认没人说话 |
 * | 无记录且 to > lastScanTs | `unscanned` | 还没扫到（**不确定**，不能说 empty） |
 *
 * ⚠️ 最后两行是这整道设计的价值所在：少了它，刚启动时问「昨天聊了啥」会得到
 * 「没人说话」—— 那是撒谎，不是缺数据。
 *
 * 「有 ok 但同区间也有 pending」时按表里第一行返回 `ok`（表是 if-else 顺序）。
 */
export function queryState(chatKey, { fromTs = 0, toTs = Date.now(), lastScanTs = 0 } = {}) {
  const from = Number(fromTs) || 0;
  const to = Number(toTs) || 0;
  const inRange = readCoverage(chatKey).list.filter((r) => r.convEndTs >= from && r.convStartTs <= to);
  if (inRange.some((r) => r.state === 'ok')) return 'ok';
  if (inRange.some((r) => r.state === 'pending')) return 'pending';
  if (inRange.some((r) => r.state === 'failed')) return 'failed';
  // short 也算"处理过了，只是没内容"：它不该被说成 empty（empty = 没人说话），
  // 但也不该被说成"还没扫到"。这里归到 ok（确实处理完、确实没什么可说的）。
  if (inRange.some((r) => r.state === 'short')) return 'ok';
  return to <= (Number(lastScanTs) || 0) ? 'empty' : 'unscanned';
}

// ── 第 2 期：L1 人物档案 / 候选池 / 跨群索引 ───────────────────────────────
//
// 和第 1 期同一套规矩：**只 append，状态变化也追加一行同主键的新行，读时取最后一行**。
// 为什么 L1 不能原地改 status：改画像是一天几次的稀疏操作，重写整份文件却要
// 先读全量再落盘，中途崩了就丢这个人全部历史；而 append 一条只多几十字节。
//
// 字段是施工单 §2.2 定死的「一个不多一个不少」。多出来的字段一律丢弃 ——
// 这条不是洁癖：L1 是第 3 期要注入上下文的东西，多一个字段就多一份要解释的语义。

/** 四个维度组（§5.1）。顺序即存储序；注入序见 inject.js 的 PROFILE_DIMS。 */
export const L1_GROUPS = Object.freeze(['说话风格', '兴趣身份', '关系态度', '性格特质']);
// 第 5 期 5b：`pending-conflict` 是冲突的**新证据**侧（大纲 §7-③）。它和 `conflicted`
// 都必须**不注入**——注入读的是 `activePerson`（filter status==='active'），
// 所以这里加状态不需要改注入代码，但**需要一条断言盯着**，否则以后有人把注入改成
// 「读全量再过滤」就会静默把两个互相矛盾的条目一起喂给模型。
export const L1_STATUS = Object.freeze(['active', 'superseded', 'conflicted', 'pending-conflict', 'void']);
export const CANDIDATE_KINDS = Object.freeze(['user_request', 'model_proposal']);
// `deleted` 是 5b 加的：UI 删除候选**不物理抹行**，而是追加一行 deleted 状态
// （append-only，与 L1 状态流转同构）。这样「他让我记的那事后来为什么没记」还能回答。
export const CANDIDATE_STATUS = Object.freeze(['pending', 'adopted', 'dropped', 'deleted']);

const num = (v) => Math.round(Number(v) || 0);

/**
 * L1 条目 id：`l1_<userId>_<ts>_<seq>`。
 * 永不复用靠的是 ts+seq —— seq 由调用方在同一毫秒内递增，重复即覆盖，
 * 所以提炼时生成一批 id 要用同一个 nowTs，靠 seq 区分。
 */
export function makeL1EntryId({ userId, at = Date.now(), seq = 1 } = {}) {
  return `l1_${safeKey(userId) || 'u'}_${num(at)}_${Number(seq) || 1}`;
}

/**
 * 造一条 L1 条目（§2.2 的九个字段）。
 *
 * `groups` 必须落在四个维度组里、1~3 个：挂不上组等于这条画像没法按占比注入，
 * 与其静默留着不如当场抛 —— 提炼阶段的 bug 越早暴露越便宜。
 * `sourceMsgIds` 是「有明确单句支撑」才有的，归纳性印象留空数组。
 */
export function makeL1Entry({
  entryId, chatKey, userId, sourceBatch = null, sourceMsgIds = [], sourceChatKeys = [],
  content, groups = [], status = 'active', pinnedByUser = false,
  deduped = false,
  // ★ 第 5 期第 8 步：UI 编辑写入的新版本要能记住"我从哪条改来的"。
  //   本函数是**白名单构造**（显式重建每个字段），所以不在这里声明的字段一律不落盘 ——
  //   与 paths.js 的 readSchema 白名单重建同族：写了、读不到、还不报错。
  editedFrom = '',
  // ★ 第 5 期 5b：冲突对端的 entryId（大纲 §7-③）。
  //   和 editedFrom 同族 —— 白名单不声明就一定丢，断言 #14 的教训在这里复制一份。
  conflictPeer = '',
  // ★ L1 收敛：提炼操作类型（supplement/replace/merge）与被替换的 entryId 列表。
  op = '',
  replaces = [],
  createdAt = Date.now(), updatedAt = null
} = {}) {
  const id = String(entryId || '').trim();
  const text = String(content || '').trim();
  if (!id) throw new Error('makeL1Entry: entryId 必填（它是唯一的写入口主键）');
  if (!text) throw new Error('makeL1Entry: content 必填（空画像没有意义）');
  const batch = sourceBatch || {};
  const bChat = String(batch.chatKey || chatKey || '').trim();
  const bUser = String(batch.userId || userId || '').trim();
  if (!bChat || !bUser) throw new Error('makeL1Entry: sourceBatch 必须有 chatKey 与 userId');

  const gs = [...new Set((Array.isArray(groups) ? groups : [groups]).map((g) => String(g).trim()).filter(Boolean))];
  const unknown = gs.filter((g) => !L1_GROUPS.includes(g));
  if (unknown.length) throw new Error(`makeL1Entry: 未知维度组 ${unknown.join('/')}（只允许 ${L1_GROUPS.join('/')}）`);
  if (!gs.length || gs.length > 3) throw new Error(`makeL1Entry: groups 要 1~3 个，实际 ${gs.length} 个`);

  const st = L1_STATUS.includes(status) ? status : 'active';
  const ids = [...new Set((Array.isArray(sourceMsgIds) ? sourceMsgIds : [sourceMsgIds])
    .map((x) => String(x ?? '').trim()).filter(Boolean))];

  // 来源群：本批的群一定在其中，再并上调用方给的（覆盖时继承旧条目的来源群）。
  // ★ 排序后再存：顺序不稳会让同一份画像两次读盘字节不同，快照/缓存白建。
  const chatKeys = [...new Set([
    bChat,
    ...(Array.isArray(sourceChatKeys) ? sourceChatKeys : [sourceChatKeys])
      .map((x) => String(x ?? '').trim()).filter(Boolean)
  ])].sort();

  return {
    entryId: id,
    sourceBatch: {
      chatKey: bChat,
      userId: bUser,
      startTs: num(batch.startTs),
      endTs: num(batch.endTs),
      msgCount: num(batch.msgCount)
    },
    sourceMsgIds: ids,
    // 这条印象的依据来自哪些群。**只用于溯源，不参与注入过滤**（本单裁决，别拿它做筛选）。
    sourceChatKeys: chatKeys,
    content: text,
    groups: gs,
    // ★ 第 3 期前置（§16.2）：false = 「已落盘但还没参加过语义去重」。
    //   读侧口径是「**字段缺省视为 true**」——迁移的旧条目没有这个字段，自动被排除在
    //   去重范围外，82 条历史零改动。所以这里必须显式写 false，绝不能省略字段。
    deduped: deduped === true,
    createdAt: num(createdAt) || Date.now(),
    updatedAt: num(updatedAt) || num(createdAt) || Date.now(),
    status: st,
    pinnedByUser: pinnedByUser === true,
    // 只在有值时才写这个键：老条目/正常提炼的条目不该多出一个空字段，
    // 否则同一份画像两次读盘字节不同，前缀缓存白建（第 3 期踩过）。
    ...(String(editedFrom || '').trim() ? { editedFrom: String(editedFrom).trim() } : {}),
    ...(String(conflictPeer || '').trim() ? { conflictPeer: String(conflictPeer).trim() } : {}),
    // L1 收敛：op/replaces 只在有值时写入，保持老条目字节稳定
    ...(String(op || '').trim() ? { op: String(op).trim() } : {}),
    ...(Array.isArray(replaces) && replaces.length ? { replaces: replaces.map(String) } : {})
  };
}

/**
 * @deprecated 2026-11-15：L1 已改成按人存，写入一律走 `appendPerson`。
 * 这四个 `*L1` 函数保留**只为迁移期读历史数据**（`group_xxx/l1/`），不要再用于写入。
 */
export function appendL1(chatKey, entry) {
  const uid = entry?.sourceBatch?.userId || '';
  appendLine(l1File(chatKey || entry?.sourceBatch?.chatKey, uid), entry);
}

/**
 * 读某人的 L1：原始行 + 按 entryId 取最后一行的索引。
 * `list` 是「当前有效视图」，按 createdAt 升序（= 早期的在前，便于覆盖判断）。
 */
export function readL1(chatKey, userId) {
  const rows = readJsonl(l1File(chatKey, userId));
  const byId = new Map();
  for (const r of rows) {
    const k = String(r?.entryId || '');
    if (!k) continue;
    byId.set(k, r);                    // 后写覆盖先写 = 取最后一行
  }
  const list = [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return { rows, byId, list };
}

/** 只要还挂着的画像（注入侧用得到，本期只供测试与第 6 步人工读）。 */
export function activeL1(chatKey, userId) {
  return readL1(chatKey, userId).list.filter((r) => r.status === 'active');
}

/** 状态流转：追加一行同 entryId 的新记录，其余字段沿用上一版。 */
export function setL1Status(chatKey, userId, entryId, status, { nowTs = Date.now() } = {}) {
  if (!L1_STATUS.includes(status)) throw new Error(`setL1Status: 未知状态 ${status}`);
  const cur = readL1(chatKey, userId).byId.get(String(entryId));
  if (!cur) return null;               // 不造孤儿行：没有原条目就不该有它的状态
  const next = { ...cur, status, updatedAt: num(nowTs) || Date.now() };
  appendL1(chatKey, next);
  return next;
}

/** 候选池条目（§2.3 的七个字段）。`kind` 只是溯源标签，不参与裁决。 */
export function makeCandidateRow({
  entryId, kind = 'model_proposal', fromUserId = '', msgId = '', text = '',
  ts = Date.now(), status = 'pending'
} = {}) {
  const id = String(entryId || '').trim();
  const body = String(text || '').trim();
  if (!id) throw new Error('makeCandidateRow: entryId 必填');
  if (!body) throw new Error('makeCandidateRow: text 必填（空提议没有回头看的价值）');
  return {
    entryId: id,
    // 拼错的 kind 一律落回默认：这个字段只影响 UI 筛选，不值得为它拒绝一条提议
    kind: CANDIDATE_KINDS.includes(kind) ? kind : 'model_proposal',
    fromUserId: String(fromUserId || '').trim(),
    msgId: String(msgId || '').trim(),
    text: body,
    ts: num(ts) || Date.now(),
    status: CANDIDATE_STATUS.includes(status) ? status : 'pending'
  };
}

export function appendCandidate(chatKey, row) {
  appendLine(candidatesFile(chatKey), row);
}

/**
 * 读候选池。`pending` 按 ts 升序 —— 兜底扫描要的是「最老的悬空提议」，
 * 排序方向搞反会让新提议一直插队，老条目永远等不到（和第 1 期 pending 活锁同型）。
 */
export function readCandidates(chatKey) {
  const rows = readJsonl(candidatesFile(chatKey));
  const byId = new Map();
  for (const r of rows) {
    const k = String(r?.entryId || '');
    if (!k) continue;
    byId.set(k, r);
  }
  const list = [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { rows, byId, list, pending: list.filter((r) => r.status === 'pending') };
}

/** 候选池状态流转（采纳/丢弃后保留原条目，留痕）。 */
export function setCandidateStatus(chatKey, entryId, status, { nowTs = Date.now() } = {}) {
  if (!CANDIDATE_STATUS.includes(status)) throw new Error(`setCandidateStatus: 未知状态 ${status}`);
  const cur = readCandidates(chatKey).byId.get(String(entryId));
  if (!cur) return null;
  const next = { ...cur, status, updatedAt: num(nowTs) || Date.now() };
  appendCandidate(chatKey, next);
  return next;
}

/**
 * 删除一条候选（§5.1.7 约束 3「UI 要能逐条查看/删除」）。
 *
 * **不物理删行**：追加一行 `status='deleted'`，原行留着。
 * 理由和 L1 的 void 一样 —— append-only 下「删掉」和「从没存在过」必须能区分，
 * 否则用户问「我让他记的那句怎么没了」时，档案里找不到任何痕迹。
 *
 * @returns {object|null} 新行；条目不存在返回 null（不造孤儿行）
 */
export function deleteCandidate(chatKey, entryId, { nowTs = Date.now(), reason = '' } = {}) {
  const id = String(entryId || '').trim();
  if (!id) return null;
  const cur = readCandidates(chatKey).byId.get(id);
  if (!cur) return null;
  const next = {
    ...cur,
    status: 'deleted',
    deletedAt: num(nowTs) || Date.now(),
    ...(String(reason || '').trim() ? { deleteReason: String(reason).trim() } : {})
  };
  appendCandidate(chatKey, next);
  return next;
}

/**
 * 跨群列候选（UI 用）。**每行都补 `chatKey`** —— 候选行本身没有这个字段（只有 entryId/
 * kind/fromUserId/msgId/text/ts/status），不补的话 UI 点「删除」会拿着 undefined 去写
 * `group_undefined/`，而原群的 pending 永远消解不掉，每轮重复喂进提炼（不报错、不告警）。
 * 这个坑在 sweepPeople 里已经踩过一次，别踩第二次。
 *
 * @returns {Array<object>} 按 ts 升序（最老的悬空提议排在最前）
 */
export function listCandidatesAll({ chatKeys = null, statuses = ['pending'], limit = 0 } = {}) {
  const keys = Array.isArray(chatKeys) ? chatKeys : listChatDirs();
  const want = new Set((Array.isArray(statuses) ? statuses : [statuses]).map((s) => String(s)));
  const all = [];
  for (const chatKey of keys) {
    const c = readCandidates(chatKey);
    for (const row of c.list) {
      if (want.size && !want.has(String(row.status))) continue;
      all.push({ ...row, chatKey });
    }
  }
  all.sort((a, b) => (num(a.ts) - num(b.ts)) || String(a.entryId).localeCompare(String(b.entryId)));
  return limit > 0 ? all.slice(0, limit) : all;
}

/** `data/mem2/` 下的会话目录（`group_xxx` / `private_xxx`）→ chatKey，排序稳定。 */
function listChatDirs() {
  try {
    return fs.readdirSync(mem2Dir())
      .filter((d) => /^(group|private)_/.test(d))
      .map(chatKeyFromDir)
      .filter(Boolean)
      .sort();
  } catch { return []; }
}

/**
 * 跨群索引一行（§2.4）：**只有 qq / groups / nicknames 三个字段**。
 * 多传的键（尤其「关注点」「兴趣」）在这里被丢掉，见 §9 红线 6。
 */
export function makeIndexEntry({ qq, groups = [], nicknames = {} } = {}) {
  const id = String(qq || '').trim();
  if (!id) throw new Error('makeIndexEntry: qq 必填');
  const gs = [...new Set((Array.isArray(groups) ? groups : [groups]).map((x) => String(x || '').trim()).filter(Boolean))];
  const nicks = {};
  if (nicknames && typeof nicknames === 'object' && !Array.isArray(nicknames)) {
    for (const [k, v] of Object.entries(nicknames)) {
      const arr = [...new Set((Array.isArray(v) ? v : [v]).map((x) => String(x || '').trim()).filter(Boolean))];
      if (arr.length) nicks[String(k)] = arr;
    }
  }
  return { qq: id, groups: gs, nicknames: nicks };
}

export function appendGlobalIndex(entry) {
  appendLine(crossGroupIndexFile(), entry);
}

/** 读跨群索引：按 qq 取最后一行（快照式覆盖，不做字段级合并）。 */
export function readGlobalIndex() {
  const rows = readJsonl(crossGroupIndexFile());
  const byQq = new Map();
  for (const r of rows) {
    const k = String(r?.qq || '');
    if (!k) continue;
    byQq.set(k, r);
  }
  const list = [...byQq.values()].sort((a, b) => String(a.qq).localeCompare(String(b.qq)));
  return { rows, byQq, list };
}

// ── 第 2 期补丁：按人存的画像（跨群一份）────────────────────────────────
//
// 为什么从「按（群,人）」改成「按人」：同一人在 6 个群会被写 6 份薄画像、互相覆盖，
// 而人只有一个。代价是丢掉了天然的群隔离 —— 已裁决接受（跨 ≥2 群且各群 ≥30 条的人
// 只有 15 个，聊的都是公开话题），串群风险改由「L1 不记一次性事件」+ 第 3 期表达层兜。

/** 追加一条画像。★ 条目上没有顶层 userId，只有 sourceBatch.userId。 */
export function appendPerson(entry) {
  const userId = String(entry?.sourceBatch?.userId || '').trim();
  if (!userId) throw new Error('appendPerson: 缺 sourceBatch.userId');
  const file = personFile(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/**
 * 彻底删除（5b ①）：物理抹掉一个 entryId 的**全部版本行**（append-only 状态机下
 * 同一 entryId 会有 active/superseded/void 多行，「彻底」必须是全删，只删末行
 * 会让旧版本在读时 last-wins 复活）。
 *
 * 唯一允许重写 people 文件的场景（其余改动一律 append）。顺序是「先审计、后删」：
 *   1. 把被删的所有行原样写进 deletions.jsonl（append-only，带 userId/deletedAt/reason）
 *   2. 审计写成功后才重写 people/<uid>.jsonl 去掉这些行
 * 中途崩溃的最坏情况：审计多行、实际没删 → 下次重删会再记一笔（有重复但没丢数据）；
 * 绝不会「删了却没留痕」。
 *
 * ★ 这是不可逆操作，调用方（UI/API）必须做二次确认，不是点一下就删。
 *
 * @returns {{deletedRows:number, entryId:string, userId:string}|null} 找不到返回 null
 */
export function purgePersonEntry(userId, entryId, { reason = '', nowTs = Date.now() } = {}) {
  const uid = String(userId || '').trim();
  const id = String(entryId || '').trim();
  if (!uid || !id) return null;
  const file = personFile(uid);
  let rows = [];
  try { rows = readJsonl(file); } catch { return null; }
  const removed = rows.filter((r) => String(r?.entryId || '') === id);
  if (!removed.length) return null;

  const at = num(nowTs) || Date.now();
  // ① 先写审计（每条被删的版本行一条，原样保留 + 删除元数据）
  for (const row of removed) {
    appendLine(deletionsFile(), {
      userId: uid,
      entryId: id,
      deletedAt: at,
      reason: String(reason || '').trim(),
      row                       // 原样保留被删的那一行（含它当时的 status/content）
    });
  }
  // ② 再重写 people 文件（去掉被删的行；保留所有其他 entryId 的全部版本）
  const kept = rows.filter((r) => String(r?.entryId || '') !== id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
  return { deletedRows: removed.length, entryId: id, userId: uid };
}

/** 读删除审计（UI 可选展示「已彻底删除 N 条」）。 */
export function readDeletions() {
  return readJsonl(deletionsFile());
}

/** 读某人的全部画像行 + 按 entryId 取最后一行的视图。 */
/** 列出所有有画像的人（people/ 下的文件名即 uid）。UI 的人列表用它。 */
export function listPersonIds() {
  try {
    return fs.readdirSync(peopleDir())
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .filter(Boolean)
      .sort();
  } catch { return []; }          // 目录还不存在 = 还没提炼过任何人
}

export function readPerson(userId) {
  const rows = readJsonl(personFile(userId));
  const byId = new Map();
  for (const r of rows) {
    const k = String(r?.entryId || '');
    if (!k) continue;
    byId.set(k, r);                    // 后写覆盖先写
  }
  const list = [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return { rows, byId, list };
}

/** 还挂着的画像，按 createdAt 升序（R 序号要稳定，不能随读盘顺序抖）。 */
export function activePerson(userId) {
  return readPerson(userId).list.filter((r) => r.status === 'active');
}

/** 状态流转：追加一行同 entryId 的新记录，其余字段沿用上一版（append-only）。 */
export function setPersonStatus(userId, entryId, status, { nowTs = Date.now() } = {}) {
  if (!L1_STATUS.includes(status)) throw new Error(`setPersonStatus: 未知状态 ${status}`);
  const cur = readPerson(userId).byId.get(String(entryId));
  if (!cur) return null;               // 不造孤儿行
  const next = { ...cur, status, updatedAt: num(nowTs) || Date.now() };
  appendPerson(next);
  return next;
}

/**
 * 只改 `deduped` 标记，**不动 status**（2026-11-16 事故修正 ④）。
 *
 * 为什么不能用 setPersonStatus：它会把状态改成 superseded —— 而这里要表达的是
 * 「这条已参加过去重、无需再合并，但它仍然有效」。用错就是「去重一次，全库清空」。
 * 与状态流转同一套 append-only：追加一行同 entryId 的新记录，读时取最后一行。
 */
export function setPersonDeduped(userId, entryId, deduped = true, { nowTs = Date.now() } = {}) {
  const cur = readPerson(userId).byId.get(String(entryId));
  if (!cur) return null;
  if (cur.status !== 'active') return null;   // 已失效的条目不写无意义的标记行
  const next = { ...cur, deduped: deduped === true, updatedAt: num(nowTs) || Date.now() };
  appendPerson(next);
  return next;
}

// ── 冲突（§7-③）：`pinnedByUser` 只保护「内容不被静默改写」，不保护「永远注入」 ─────
//
// 状态机（大纲原文）：
//   新证据与 pinned 条目语义冲突
//     → 旧条目 status = conflicted        （不覆盖、不删除、不注入）
//     → 新条目 status = pending-conflict  （不生效）
//     → 两者都进 UI 待裁决
//     → 7 天无人处理 → 默认采用新证据：旧 → superseded，并记一条日志
//
// 为什么必须有「7 天默认放行」：用户不一定回来裁决，而**永远挂着两个互相矛盾的条目**
// 比「可能判错」更糟 —— 前者逼注入逻辑去猜，后者至少是确定的。

/**
 * 标一对冲突。两个 entryId 都必须是 `active` 的现存条目。
 *
 * @returns {{old:object, new:object}|null} 两侧的新行；任一不存在/状态不对返回 null
 */
export function markConflict({ userId, oldEntryId, newEntryId, reason = '', nowTs = Date.now() } = {}) {
  const uid = String(userId || '').trim();
  const oldId = String(oldEntryId || '').trim();
  const newId = String(newEntryId || '').trim();
  if (!uid || !oldId || !newId || oldId === newId) return null;
  const person = readPerson(uid);
  const a = person.byId.get(oldId);
  const b = person.byId.get(newId);
  if (!a || !b) return null;
  if (a.status !== 'active' || b.status !== 'active') return null;   // 只对「两个都还有效」的条目设冲突
  const at = num(nowTs) || Date.now();
  const reasonText = String(reason || '').trim();
  const oldNext = {
    ...a, status: 'conflicted', conflictPeer: newId, conflictAt: at,
    ...(reasonText ? { conflictReason: reasonText } : {}), updatedAt: at
  };
  const newNext = {
    ...b, status: 'pending-conflict', conflictPeer: oldId, conflictAt: at,
    ...(reasonText ? { conflictReason: reasonText } : {}), updatedAt: at
  };
  appendPerson(oldNext);
  appendPerson(newNext);
  return { old: oldNext, new: newNext };
}

/**
 * 裁决一对冲突：`keep='new'` 采纳新证据（旧 → superseded），`keep='old'` 保旧的
 * （新 → superseded）。传冲突任一侧的 entryId 都行 —— UI 上点哪边都是「我选这条」。
 *
 * @returns {{kept:object, dropped:object}|null}
 */
export function resolveConflict({ userId, entryId, keep = 'new', nowTs = Date.now() } = {}) {
  const uid = String(userId || '').trim();
  const id = String(entryId || '').trim();
  if (!uid || !id) return null;
  const person = readPerson(uid);
  const row = person.byId.get(id);
  if (!row) return null;
  const peerId = String(row.conflictPeer || '').trim();
  if (!peerId) return null;
  const peer = person.byId.get(peerId);
  if (!peer) return null;
  // 谁新谁旧不看调用方，看状态：`conflicted` 恒为旧（被 pin 的那条），`pending-conflict` 恒为新
  const oldRow = row.status === 'conflicted' ? row : (peer.status === 'conflicted' ? peer : null);
  const newRow = row.status === 'pending-conflict' ? row : (peer.status === 'pending-conflict' ? peer : null);
  if (!oldRow || !newRow) return null;          // 已经裁决过 / 状态被别处改过
  const at = num(nowTs) || Date.now();
  const pickNew = keep !== 'old';
  const keptRow = pickNew ? newRow : oldRow;
  const dropRow = pickNew ? oldRow : newRow;
  const kept = {
    ...keptRow, status: 'active', conflictResolved: pickNew ? 'keep-new' : 'keep-old', conflictResolvedAt: at,
    updatedAt: at
  };
  const dropped = {
    ...dropRow, status: 'superseded', conflictResolved: pickNew ? 'keep-new' : 'keep-old', conflictResolvedAt: at,
    updatedAt: at
  };
  appendPerson(kept);
  appendPerson(dropped);
  return { kept, dropped };
}

/** 未裁决的冲突对（UI「待裁决」列表 + 7 天扫描共用这一个判据）。 */
export function listConflicts({ userId = '', now = Date.now(), maxAgeDays = 7 } = {}) {
  const uids = userId ? [String(userId).trim()] : listPersonIds();
  const cut = (num(now) || Date.now()) - maxAgeDays * 86400000;
  const out = [];
  for (const uid of uids) {
    const person = readPerson(uid);
    for (const oldRow of person.list) {
      if (oldRow.status !== 'conflicted') continue;
      const peerId = String(oldRow.conflictPeer || '').trim();
      if (!peerId) continue;
      const newRow = person.byId.get(peerId);
      if (!newRow || newRow.status !== 'pending-conflict') continue;   // 已裁决
      const born = num(newRow.createdAt) || num(newRow.conflictAt) || 0;
      out.push({
        userId: uid,
        oldEntryId: oldRow.entryId,
        newEntryId: newRow.entryId,
        oldContent: oldRow.content,
        newContent: newRow.content,
        oldPinned: oldRow.pinnedByUser === true,
        createdAt: born,
        ageDays: born ? Math.floor(((num(now) || Date.now()) - born) / 86400000) : 0,
        expired: born > 0 && born < cut
      });
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 7 天默认放行：逾期未裁决的冲突按「采纳新证据」自动了结，并**记一条日志**（大纲要求留痕）。
 *
 * 幂等：了结后两侧状态变成 active/superseded，不再落进 `listConflicts`。
 * 挂在每日扫描里跑（不另起定时器，硬约束 ⑦）。
 *
 * @returns {{resolved:number, items:Array}}
 */
export function sweepConflicts({ now = Date.now(), maxAgeDays = 7, log = () => {} } = {}) {
  const expired = listConflicts({ now, maxAgeDays }).filter((c) => c.expired);
  const done = [];
  for (const c of expired) {
    const r = resolveConflict({ userId: c.userId, entryId: c.newEntryId, keep: 'new', nowTs: now });
    if (!r) continue;
    done.push(c);
    log(`[l1] 冲突逾期 ${c.ageDays} 天未裁决 → 默认采纳新证据：${c.userId} `
      + `${c.oldEntryId} → superseded，${c.newEntryId} → active`);
  }
  return { resolved: done.length, items: done };
}
