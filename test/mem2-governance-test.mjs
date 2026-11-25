// 第 5 期 · 5b 第一批：候选池 / 冲突 / L3 的空态与硬约束。
//
// 这一组守的是四件「看起来做了、其实没接线」的事：
//   · 候选池被注入/被检索   → 等于绕开裁决，候选直接变事实（硬约束 17）
//   · 兜底另起定时器        → 两套扫描互相覆盖水位，还多一份配额（硬约束 ⑦）
//   · 冲突两边都还 active   → 注入逻辑必须猜哪条是真的（§7-③ 明文禁止）
//   · 7 天不自动了结        → 两套矛盾条目永久挂着，且谁也不记得为什么
//
// 覆盖 §6 的：#10b（候选删除留痕）、#8 的同族（pinned 冲突）、以及 5b 新增的 T6/冲突扫描。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-mem2-gov-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const P = await import('../src/mem2/paths.js');
const M = await import('../src/mem2/store.js');
const L1 = await import('../src/mem2/l1.js');
const API = await import('../src/mem2/ui-api.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const MIN = 60 * 1000;
const DAY = 86400000;
const T0 = new Date(2026, 10, 10, 10, 0, 0).getTime();
const UID = '9900000001';
const CHAT = 'group:999900001';

let caseNo = 0;
function freshRoot() {
  caseNo += 1;
  P.setMem2Root(path.join(DATA, `case-${caseNo}`));
  return P.mem2Dir();
}

/** 造 n 条群友消息（同一个人、同一个群），间隔 1 分钟。 */
function mkMsgs(n, { startTs = T0, uid = UID, chat = CHAT } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      mid: `m${startTs}_${i}`, ts: startTs + i * MIN,
      text: `群友第${i}句`, senderId: uid, senderName: '甲', self: false, _chatKey: chat
    });
  }
  return out;
}

/** 一条 active 画像；endTs 决定水位（用于制造「没有未提炼消息」）。 */
function addEntry({ uid = UID, chat = CHAT, content = '爱用短句', groups = ['说话风格'], pinned = false, endTs = T0, seq = 1, createdAt = T0 } = {}) {
  const e = M.makeL1Entry({
    entryId: M.makeL1EntryId({ userId: uid, at: createdAt, seq }),
    chatKey: chat, userId: uid,
    sourceBatch: { chatKey: chat, userId: uid, startTs: T0, endTs, msgCount: 10 },
    content, groups, status: 'active', pinnedByUser: pinned, createdAt
  });
  M.appendPerson(e);
  return e;
}

// ══ #22 候选池：chatKey 补位 + 删除留痕（append-only）

{
  freshRoot();
  M.appendCandidate(CHAT, M.makeCandidateRow({
    entryId: 'c1', kind: 'user_request', fromUserId: UID, msgId: 'm1', text: '他让我记住：下周三做手术', ts: T0
  }));
  M.appendCandidate(CHAT, M.makeCandidateRow({
    entryId: 'c2', kind: 'model_proposal', fromUserId: UID, msgId: 'm2', text: '好像很喜欢明日方舟', ts: T0 + MIN
  }));

  const listed = M.listCandidatesAll({ statuses: ['pending'] });
  assert.equal(listed.length, 2);
  // 候选行本身没有 chatKey 字段 —— 不补的话 UI 删除会写到 group_undefined/
  assert.equal(listed[0].chatKey, CHAT, '跨群列表必须补上 chatKey');
  assert.equal(listed[0].entryId, 'c1', '按 ts 升序：最老的悬空提议在最前');

  const before = M.readCandidates(CHAT).rows.length;
  const del = M.deleteCandidate(CHAT, 'c1', { reason: 'test' });
  assert.equal(del.status, 'deleted');
  assert.equal(M.readCandidates(CHAT).rows.length, before + 1, '删除是追加一行，不是物理抹掉');
  assert.deepEqual(M.readCandidates(CHAT).pending.map((x) => x.entryId), ['c2'], 'deleted 不再是 pending');
  assert.equal(M.deleteCandidate(CHAT, 'nope'), null, '不存在的候选不造孤儿行');

  const ui = API.listCandidates({ chat: CHAT, status: 'all' });
  assert.equal(ui.counts.deleted, 1);
  assert.equal(ui.counts.pending, 1);
  // 已删除的候选不能再删一次（只对 pending 有意义）
  assert.throws(() => API.deleteCandidateById({ chatKey: CHAT, entryId: 'c1' }), /只能删除 pending/);
  ok('#22 候选池：跨群列表带 chatKey、删除留痕不抹行、deleted 不进 pending');
}

// ══ #23 候选池不可注入（硬约束 17）：结构守卫
//
// 这条用源码断言而不是运行时断言，因为「注入层不读候选池」是一个**结构**约束 ——
// 一旦有人图省事在 inject.js 里 readCandidates，运行时可能几个月都不出错，
// 但那时候候选池已经等于「绕过裁决的事实」了。
{
  const src = fs.readFileSync(new URL('../src/mem2/inject.js', import.meta.url), 'utf8');
  assert.ok(!/readCandidates|listCandidatesAll|candidatesFile/.test(src),
    '硬约束 17：注入层不得引用候选池的任何读函数');
  ok('#23 候选池不可注入：inject.js 不引用候选池（结构守卫）');
}

// ══ #24 T6 兜底：不说话的人 + 7 天前的候选 → 单独一次小调用

{
  freshRoot();
  const msgs = mkMsgs(35);
  const lastTs = msgs[msgs.length - 1].ts;
  addEntry({ endTs: lastTs });                    // 水位推到最新 → 未提炼 0 条 → 正常提炼不触发
  M.appendCandidate(CHAT, M.makeCandidateRow({
    entryId: 'stale1', kind: 'user_request', fromUserId: UID, msgId: msgs[5].mid,
    text: '他让我记住手术日期', ts: T0 - 8 * DAY
  }));

  const calls = [];
  const fake = async (kind, { messages }) => {
    calls.push({ kind, user: messages.map((m) => m.content).join('\n') });
    const content = kind === 'l1-profile'
      ? '性格特质｜1｜术后要静养一阵，近期状态明显偏保守，聊到这事就收话题'
      : '- || 术后要静养一阵 || 性格特质 || -';
    return { ok: true, result: { message: { content } }, usage: { totalTokens: 100 } };
  };

  const stat = await L1.sweepPeople({
    sources: [{ chatKey: CHAT, messages: msgs }], now: lastTs + MIN, memLlmImpl: fake, log: () => {}
  });

  assert.equal(stat.candidateFallback, 1, '必须走候选兜底这条路');
  const fbCalls = calls.filter((c) => c.kind === L1.CANDIDATE_FALLBACK_KIND);
  assert.equal(fbCalls.length, 1, '兜底只花一次调用（不重跑整段提炼）');
  assert.equal(calls.length, 2, '兜底 1 次 + 画像压缩 1 次（§4.4：兜底分支也要压缩）');
  assert.equal(calls[1].kind, 'l1-profile');
  assert.equal(fbCalls[0].kind, L1.CANDIDATE_FALLBACK_KIND, 'kind 必须是 candidate-fallback（配额分桶靠它）');
  assert.ok(fbCalls[0].user.includes('他让我记住手术日期'), '提示词里要有提议原文');
  assert.ok(fbCalls[0].user.includes('群友第5句'), '还要带回上下文（§5.1.7：候选池的价值在带回上下文）');
  assert.equal(stat.added, 1);

  const person = M.readPerson(UID);
  assert.ok(person.list.some((e) => e.content === '术后要静养一阵' && e.status === 'active'), '兜底产出的条目要落盘且 active');
  assert.equal(M.readCandidates(CHAT).byId.get('stale1').status, 'adopted', '裁决结果回写候选池');
  ok('#24 T6 兜底：7 天前的候选触发一次小调用（kind=candidate-fallback），带上下文、产出落盘、候选转 adopted');
}

// ══ #25 新鲜的候选不兜底（判据只看条目年龄，不看有没有新消息）

{
  freshRoot();
  const msgs = mkMsgs(35);
  const lastTs = msgs[msgs.length - 1].ts;
  addEntry({ endTs: lastTs });
  M.appendCandidate(CHAT, M.makeCandidateRow({
    entryId: 'fresh1', kind: 'user_request', fromUserId: UID, msgId: msgs[3].mid,
    text: '他让我记住一件刚说的事', ts: lastTs - 1 * DAY
  }));

  let calls = 0;
  const fake = async (kind) => {
    if (kind === L1.CANDIDATE_FALLBACK_KIND) calls += 1;
    return { ok: true, result: { message: { content: 'SKIP' } } };
  };
  const stat = await L1.sweepPeople({
    sources: [{ chatKey: CHAT, messages: msgs }], now: lastTs + MIN, memLlmImpl: fake, log: () => {}
  });
  assert.equal(calls, 0, '1 天前的候选不该触发兜底');
  assert.equal(stat.candidateFallback, 0);
  assert.equal(stat.skipped, 1);
  ok('#25 未满 7 天的候选不触发兜底（判据是条目年龄，不是人的活跃度）');
}

// ══ #26 冲突：两边都不生效、可裁决、conflictPeer 能落盘

{
  freshRoot();
  const oldE = addEntry({ content: '他常聊手游', pinned: true, createdAt: T0, seq: 1 });
  const newE = addEntry({ content: '他退坑了', createdAt: T0 + DAY, seq: 2 });

  const pair = M.markConflict({ userId: UID, oldEntryId: oldE.entryId, newEntryId: newE.entryId, reason: '新证据与 pin 冲突' });
  assert.equal(pair.old.status, 'conflicted');
  assert.equal(pair.new.status, 'pending-conflict');

  const onDisk = M.readPerson(UID).byId;
  assert.equal(onDisk.get(oldE.entryId).conflictPeer, newE.entryId, 'conflictPeer 必须落盘（makeL1Entry 白名单）');
  assert.equal(onDisk.get(newE.entryId).conflictPeer, oldE.entryId);

  // 硬约束：两个互相矛盾的条目都不能进注入
  const active = M.activePerson(UID).map((e) => e.entryId);
  assert.deepEqual(active, [], 'conflicted / pending-conflict 都不在 activePerson 里 → 不注入');

  const conf = API.listConflictPairs();
  assert.equal(conf.total, 1);
  assert.equal(conf.conflicts[0].oldContent, '他常聊手游');
  assert.equal(conf.conflicts[0].oldPinned, true);

  // 采纳新证据
  const r = API.resolveConflictPair({ userId: UID, entryId: oldE.entryId, keep: 'new' });
  assert.equal(r.kept.entryId, newE.entryId);
  assert.deepEqual(M.activePerson(UID).map((e) => e.content), ['他退坑了']);

  // 已被裁决成 superseded 的条目不能再被标冲突（状态机只认两个都还 active 的）
  const pair2 = M.markConflict({ userId: UID, oldEntryId: newE.entryId, newEntryId: oldE.entryId });
  assert.equal(pair2, null, 'superseded 的条目不能再进冲突状态');
  ok('#26 冲突：两侧都不注入、conflictPeer 落盘、裁决后只剩一条 active');
}

// ══ #27 冲突 7 天默认放行（逾期自动采纳新证据 + 留日志）

{
  freshRoot();
  const oldE = addEntry({ content: '他常聊手游', pinned: true, createdAt: T0 - 10 * DAY, seq: 1 });
  const newE = addEntry({ content: '他退坑了', createdAt: T0 - 8 * DAY, seq: 2 });
  M.markConflict({ userId: UID, oldEntryId: oldE.entryId, newEntryId: newE.entryId });

  const before = API.listConflictPairs();
  assert.equal(before.conflicts[0].expired, true, '8 天前立的冲突应判逾期');

  const logs = [];
  const r = M.sweepConflicts({ now: T0, log: (m) => logs.push(m) });
  assert.equal(r.resolved, 1);
  assert.equal(M.readPerson(UID).byId.get(oldE.entryId).status, 'superseded');
  assert.equal(M.readPerson(UID).byId.get(newE.entryId).status, 'active');
  assert.ok(logs[0].includes('默认采纳新证据'), '逾期必须留一条日志');
  assert.equal(M.sweepConflicts({ now: T0, log: () => {} }).resolved, 0, '幂等：再扫一次不能再了结一次');
  ok('#27 冲突逾期 7 天：自动采纳新证据、旧条 superseded、留痕、幂等');
}

// ══ #28 L3 知识是空态（不是没做完）

{
  freshRoot();
  const k = API.listKnowledge();
  assert.equal(k.total, 0);
  assert.equal(k.available, false);
  assert.equal(k.source, 'search+correction');
  assert.ok(k.note.includes('搜索'), '空态必须说明来源，否则会被当成"记忆坏了"');
  ok('#28 L3 空态：返回空 + 来源说明（不从摘要/提炼里提取）');
}

// ══ #29 R<k> 指向 pinned → 整条忽略（v1.1：不 markConflict、不 supersede）

{
  freshRoot();
  const pinned = addEntry({ content: '他常聊手游', pinned: true, createdAt: T0, seq: 1 });
  const msgs = mkMsgs(35);
  const fake = async () => ({
    ok: true,
    // R1 = 「覆盖已有画像第 1 条」，而第 1 条正是 pinned
    result: { message: { content: 'R1 || 他退坑了 || 兴趣身份 || -' } },
    usage: { totalTokens: 50 }
  });

  const r = await L1.refine(
    { userId: UID, chatKeys: [CHAT] },
    {
      rawMessages: msgs,
      // 槽位 1 的来源就是那条 pinned（readOnly 标记由 refine 从来源条目自己判）
      existing: [{ index: 1, content: '他常聊手游', groups: ['兴趣身份'], sourceEntryIds: [pinned.entryId], sourceChatKeys: [CHAT], readOnly: false }],
      memLlmImpl: fake, now: T0 + 40 * MIN, log: () => {}
    }
  );

  const byId = M.readPerson(UID).byId;
  assert.equal(byId.get(pinned.entryId).status, 'active', '★ pinned 条目状态一个字都不能动');
  assert.equal(byId.get(pinned.entryId).content, '他常聊手游', '内容一个字都不能改（pin 保护的就是这个）');
  assert.equal(r.stats.pinnedRefIgnored, 1, '★ 指向 pinned 的 R/M 记 pinnedRefIgnored');
  assert.equal(r.stats.superseded, 0, '不 supersede');
  assert.equal(r.stats.added, 0, '整条忽略：既不改旧条、也不落新条');
  assert.ok(!M.readPerson(UID).list.some((e) => e.content === '他退坑了'), '被忽略的行不产出「他退坑了」');
  assert.deepEqual(M.activePerson(UID).map((e) => e.entryId), [pinned.entryId], '只有 pinned 在注入视图里');
  ok('#29 R<k> 指向 pinned：整条忽略（记 pinnedRefIgnored），状态/内容都不动、不落新条');
}

// ══ 5b 第二批：候选 API / 彻底删除 / 冲突 API／路由接线

// #31 候选池 API：listCandidates 带 chatKey 与状态计数、deleteCandidateById 留痕
{
  freshRoot();
  M.appendCandidate(CHAT, M.makeCandidateRow({
    entryId: 'cap1', kind: 'user_request', fromUserId: UID, msgId: 'm1', text: '记一下这事', ts: T0
  }));
  const listed = API.listCandidates({ chat: CHAT, status: 'pending' });
  assert.equal(listed.total, 1);
  assert.equal(listed.candidates[0].chatKey, CHAT, 'UI 每行必须带 chatKey');
  const d = API.deleteCandidateById({ chatKey: CHAT, entryId: 'cap1', reason: '不想记了' });
  assert.equal(d.candidate.status, 'deleted');
  assert.equal(M.readCandidates(CHAT).rows.length, 2, '删除留痕：append 一行，不是抹掉');
  assert.throws(() => API.deleteCandidateById({ chatKey: CHAT, entryId: 'cap1' }), /只能删除 pending/);
  ok('#31 候选池 API：列表带 chatKey + 状态计数、删除留痕不抹行、二次删被拒');
}

// #32 彻底删除：二次确认是后端强制的（confirm 差一个字都 400）
{
  freshRoot();
  const e = addEntry({ content: '要被彻底删', seq: 1 });
  assert.throws(() => API.purgeEntry({ entryId: e.entryId, confirm: 'delete' }), /二次确认/, '小写 confirm 必须被拒');
  assert.throws(() => API.purgeEntry({ entryId: e.entryId, confirm: '' }), /二次确认/, '空 confirm 必须被拒');
  assert.equal(M.readPerson(UID).list.length, 1, '被拒后条目还在');
  const r = API.purgeEntry({ entryId: e.entryId, confirm: 'DELETE', reason: '用户要求' });
  assert.equal(r.ok, true);
  assert.equal(r.deletedRows, 1);
  assert.equal(M.readPerson(UID).list.length, 0, '彻底删除后文件里没有这一行');
  assert.throws(() => API.purgeEntry({ entryId: e.entryId, confirm: 'DELETE' }), /找不到/, '删除幂等失败要明确报错，不静默成功');
  ok('#32 彻底删除：后端强制二次确认（confirm 差一字即 400），无确认时条目完好');
}

// #33 彻底删除删的是「全部版本行」，且删前写审计（append-only 留痕）
{
  freshRoot();
  const e = addEntry({ content: '多版本', seq: 1 });
  M.setPersonStatus(UID, e.entryId, 'void', { nowTs: T0 + 1000 });   // 同 entryId 追加第二行
  M.setPersonStatus(UID, e.entryId, 'active', { nowTs: T0 + 2000 }); // 第三行
  assert.equal(M.readPerson(UID).rows.length, 3, '此时该 entryId 有 3 行版本');

  const r = API.purgeEntry({ entryId: e.entryId, confirm: 'DELETE', reason: '测试全版本' });
  assert.equal(r.deletedRows, 3, '必须删掉全部 3 行，只删末行会让旧版本 last-wins 复活');
  assert.equal(M.readPerson(UID).rows.length, 0);

  const dels = M.readDeletions();
  assert.equal(dels.length, 3, '3 行各留一条审计');
  assert.equal(dels[0].userId, UID);
  assert.equal(dels[0].row.entryId, e.entryId, '审计里原样保留被删的行');
  assert.equal(API.deletionCount(), 3);
  ok('#33 彻底删除：删全部版本行（3 行）、删前写 deletions.jsonl 审计（append-only 留痕）');
}

// #34 冲突 API：待裁决列表 + 人工裁决
{
  freshRoot();
  const oldE = addEntry({ content: '旧的', pinned: true, seq: 1 });
  const newE = addEntry({ content: '新的', createdAt: T0 + DAY, seq: 2 });
  M.markConflict({ userId: UID, oldEntryId: oldE.entryId, newEntryId: newE.entryId });
  const pairs = API.listConflictPairs();
  assert.equal(pairs.total, 1);
  assert.equal(pairs.conflicts[0].oldContent, '旧的');
  const r = API.resolveConflictPair({ userId: UID, entryId: newE.entryId, keep: 'new' });
  assert.equal(r.kept.entryId, newE.entryId);
  assert.deepEqual(M.activePerson(UID).map((e) => e.content), ['新的']);
  assert.throws(() => API.resolveConflictPair({ userId: UID, entryId: newE.entryId, keep: 'sideways' }), /keep 只能是/);
  ok('#34 冲突 API：待裁决列表 + 人工裁决');
}

// #35 路由接线（不起服务，直接调 handler 验 7 条新路由都能吐 JSON）
{
  freshRoot();
  const routesMod = await import('../src/routes.js');
  // routes.js 的 registerRoutes 需要一堆 deps，这里只验证导出面 + ui-api 覆盖足够，
  // 真路由联通在最后 headless Edge 真渲染里验（5a 同款）。
  assert.equal(typeof routesMod.createRoutes, 'function');
  const requiredFns = ['listCandidates', 'deleteCandidateById', 'listConflictPairs',
    'resolveConflictPair', 'listKnowledge', 'purgeEntry', 'deletionCount'];
  for (const fn of requiredFns) assert.equal(typeof API[fn], 'function', `${fn} 必须导出供路由调用`);
  ok('#35 路由接线：7 个业务函数齐全、registerRoutes 可加载（真联通留待真浏览器）');
}

console.log(`\nmem2-governance: ${passed} 项通过`);
