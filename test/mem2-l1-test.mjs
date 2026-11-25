// 第 2 期 · 第 1 步的单测：L1 人物档案 / 候选池 / 跨群索引的落地结构与 append-only。
//
// 这一步不调 LLM、不产业务数据，只钉死「数据长什么样、落在哪、怎么改状态」。
// 守的是三件后面每一步都会踩的事：
//   · 路径写错 → 数据落在没人读的地方，功能看起来正常但画像是空的
//   · 字段写多/写少 → 第 3 期注入时要么缺维度、要么多一份无法解释的语义
//   · 状态用原地重写 → 中途崩溃丢掉这个人全部历史（append-only 是硬约束）
//
// 覆盖施工单 §8.1 的：#8（出处字段）、#11（kind 只做标签）；§2.1/§2.2/§2.3/§2.4 的字段口径。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-mem2-l1-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const P = await import('../src/mem2/paths.js');
const M = await import('../src/mem2/store.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

let caseNo = 0;
function freshRoot() {
  caseNo += 1;
  P.setMem2Root(path.join(DATA, `case-${caseNo}`));
  return P.mem2Dir();
}

const K = 'group:900001';
const UID = '123456789';
const T0 = new Date(2026, 10, 14, 10, 0, 0).getTime();
const HOUR = 3600 * 1000;

const batch = (over = {}) => ({
  chatKey: K, userId: UID, startTs: T0, endTs: T0 + 2 * HOUR, msgCount: 120, ...over
});

const lines = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};

// ── #1 落地路径：三份文件必须在施工单 §2.1 钉死的位置 ──
{
  const root = freshRoot();
  const expectL1 = path.join(root, 'group_900001', 'l1', '123456789.jsonl');
  assert.equal(P.l1File(K, UID), expectL1, '★ L1 必须落在 <chatKey>/l1/<userId>.jsonl');
  assert.equal(P.candidatesFile(K), path.join(root, 'group_900001', 'candidates.jsonl'));
  assert.equal(P.crossGroupIndexFile(), path.join(root, 'cross_group_index.jsonl'),
    '★ 索引放根下且叫 cross_group_index（不能和旧目录 global___cross_group_index__ 撞名）');

  // 非法字符不能进文件名（Windows 上冒号直接写不进去）。只看 basename：盘符带冒号。
  assert.ok(!path.basename(P.l1File(K, 'qq:123')).includes(':'), '文件名里的冒号必须被过滤');
  ok('#1 路径：l1/<uid>.jsonl、candidates.jsonl、cross_group_index.jsonl 三处落点正确');
}

// ── #2 L1 字段：九个字段一个不多一个不少，类型对 ──
{
  freshRoot();
  P.ensureChatDirs(K);
  assert.ok(fs.existsSync(P.l1Dir(K)), 'ensureChatDirs 要顺手建出 l1/ 目录');

  const e = M.makeL1Entry({
    entryId: M.makeL1EntryId({ userId: UID, at: T0, seq: 1 }),
    chatKey: K, userId: UID, sourceBatch: batch(),
    sourceMsgIds: ['m3', 'm4'], content: '常在深夜出没，说话爱用波浪号',
    groups: ['说话风格', '性格特质'], createdAt: T0
  });
  assert.deepEqual(Object.keys(e).sort(), [
    'content', 'createdAt', 'deduped', 'entryId', 'groups', 'pinnedByUser', 'sourceBatch',
    'sourceChatKeys', 'sourceMsgIds', 'status', 'updatedAt'
  ].sort(), '★ 字段必须正好是 §2.2 那九个 + 补丁加的 sourceChatKeys + 3期前置的 deduped');
  assert.equal(e.deduped, false, '★ 新产条目 deduped 必须显式为 false（读侧「缺省视为 true」靠它区分迁移数据）');
  assert.deepEqual(e.sourceChatKeys, [K], 'sourceChatKeys 至少含本批的群');
  assert.equal(e.status, 'active');
  assert.equal(e.pinnedByUser, false);
  assert.equal(e.sourceBatch.msgCount, 120);
  assert.equal(e.sourceBatch.chatKey, K);
  assert.deepEqual(e.sourceMsgIds, ['m3', 'm4']);

  // 归纳性印象没有单句支撑 → 留空数组，不是 null
  const e2 = M.makeL1Entry({
    entryId: 'l1_x', chatKey: K, userId: UID, sourceBatch: batch(),
    content: '整体像个夜猫子', groups: ['性格特质']
  });
  assert.deepEqual(e2.sourceMsgIds, [], 'sourceMsgIds 缺省是空数组（不是 null）');

  M.appendL1(K, e);
  const back = M.readL1(K, UID);
  assert.equal(back.rows.length, 1);
  assert.deepEqual(back.list[0], e, '落盘再读回来必须一字不差');
  ok('#2 L1 字段：九字段齐全、类型对、sourceMsgIds 缺省空数组、落盘可原样读回');
}

// ── #3 append-only：改状态是追加一行，读时取最后一行 ──
{
  const root = freshRoot();
  const e = M.makeL1Entry({
    entryId: 'l1_u_1', chatKey: K, userId: UID, sourceBatch: batch(), content: '常聊手游',
    sourceMsgIds: ['m1'], groups: ['兴趣身份'], createdAt: T0
  });
  M.appendL1(K, e);
  const file = P.l1File(K, UID);
  assert.equal(lines(file).length, 1);
  const firstLine = lines(file)[0];

  const next = M.setL1Status(K, UID, 'l1_u_1', 'superseded', { nowTs: T0 + HOUR });
  assert.equal(next.status, 'superseded');
  assert.equal(next.content, '常聊手游', '状态流转不能丢内容（其余字段沿用上一版）');

  const after = M.readL1(K, UID);
  assert.equal(after.rows.length, 2, '★ 必须是追加第二行，不是重写第一行');
  assert.equal(lines(file)[0], firstLine, '★ 第一行字节不变（append-only 的硬证据）');
  assert.equal(after.list.length, 1, '同一 entryId 只算一条');
  assert.equal(after.list[0].status, 'superseded', '★ 读时取最后一行 = 后写覆盖先写');
  assert.equal(after.rows[0].status, 'active', '原始行仍保留 active，历史可回放');
  assert.equal(M.activeL1(K, UID).length, 0, 'superseded 不算 active');

  // 不存在的条目不能造孤儿状态行
  assert.equal(M.setL1Status(K, UID, 'l1_not_exist', 'void'), null);
  assert.equal(lines(file).length, 2, '孤儿状态不得落盘');
  assert.equal(root && P.mem2Dir(), root);
  ok('#3 append-only：状态变更追加新行、首行字节不变、读时取最后一行、不造孤儿行');
}

// ── #4 字段校验：能当场炸的错不要留到注入阶段 ──
{
  freshRoot();
  const base = { entryId: 'l1_v', chatKey: K, userId: UID, sourceBatch: batch(), content: 'x' };
  assert.throws(() => M.makeL1Entry({ ...base, content: '   ' }), /content 必填/);
  assert.throws(() => M.makeL1Entry({ ...base, entryId: '' }), /entryId 必填/);
  assert.throws(() => M.makeL1Entry({ ...base, content: 'x', groups: [] }), /1~3 个/);
  assert.throws(() => M.makeL1Entry({ ...base, content: 'x', groups: ['说话风格', '兴趣身份', '关系态度', '性格特质'] }), /1~3 个/);
  assert.throws(() => M.makeL1Entry({ ...base, content: 'x', groups: ['随便写的组'] }), /未知维度组/);
  assert.throws(() => M.makeL1Entry({ entryId: 'l1_w', content: 'x', groups: ['性格特质'] }), /sourceBatch/);
  // 维度组去重：重复标签不该变成 2 个
  const dup = M.makeL1Entry({ ...base, content: 'x', groups: ['性格特质', '性格特质'] });
  assert.deepEqual(dup.groups, ['性格特质']);
  ok('#4 校验：空 content / 空 entryId / 组数越界 / 未知维度组 / 缺 sourceBatch 全部抛；重复组自动去重');
}

// ── #5 每人一份文件：不同 userId 不串 ──
{
  freshRoot();
  const mk = (uid, entryId, text) => M.makeL1Entry({
    entryId, chatKey: K, userId: uid, sourceBatch: batch({ userId: uid }), content: text, groups: ['性格特质']
  });
  M.appendL1(K, mk('111', 'l1_a', '甲很安静'));
  M.appendL1(K, mk('222', 'l1_b', '乙很吵'));
  assert.equal(M.readL1(K, '111').list.length, 1);
  assert.equal(M.readL1(K, '111').list[0].content, '甲很安静');
  assert.equal(M.readL1(K, '222').list[0].content, '乙很吵');
  assert.notEqual(P.l1File(K, '111'), P.l1File(K, '222'));
  ok('#5 隔离：每人一份 jsonl，互不串写');
}

// ── #6 候选池：七字段 + pending 升序 + 采纳后留痕 ──
{
  freshRoot();
  const c1 = M.makeCandidateRow({
    entryId: 'c_old', kind: 'user_request', fromUserId: '111', msgId: 'm9',
    text: '你记住 阿杰姐姐是猪', ts: T0
  });
  assert.deepEqual(Object.keys(c1).sort(), ['entryId', 'fromUserId', 'kind', 'msgId', 'status', 'text', 'ts'],
    '★ 候选池必须正好是 §2.3 那七个字段');
  assert.equal(c1.kind, 'user_request');
  assert.equal(c1.status, 'pending');

  const c2 = M.makeCandidateRow({
    entryId: 'c_new', kind: 'model_proposal', fromUserId: '222', msgId: 'm10', text: '他好像要换工作', ts: T0 + HOUR
  });
  M.appendCandidate(K, c2);
  M.appendCandidate(K, c1);            // 故意先追加新的、后追加旧的：排序不能依赖写入顺序

  const pool = M.readCandidates(K);
  assert.equal(pool.pending.length, 2);
  assert.deepEqual(pool.pending.map((x) => x.entryId), ['c_old', 'c_new'], '★ pending 必须按 ts 升序（兜底扫描要最老的）');

  M.setCandidateStatus(K, 'c_old', 'adopted');
  const pool2 = M.readCandidates(K);
  assert.equal(pool2.pending.length, 1, '采纳后不再留在 pending');
  assert.equal(pool2.byId.get('c_old').status, 'adopted', '采纳留痕：条目本身不删');
  assert.equal(pool2.rows.length, 3, '状态流转也是追加一行');
  assert.equal(pool2.byId.get('c_old').text, '你记住 阿杰姐姐是猪', '留痕要保住原文');
  // kind 只做标签：拼错落回默认，不拒绝这条提议
  assert.equal(M.makeCandidateRow({ entryId: 'c_k', text: 'x', kind: 'user_reqest' }).kind, 'model_proposal');
  ok('#6 候选池：七字段、pending 按 ts 升序（不依赖写入顺序）、采纳后留痕、kind 拼错回落默认');
}

// ── #7 跨群索引：只有 qq/groups/nicknames，多传的键被丢掉 ──
{
  const root = freshRoot();
  const idx = M.makeIndexEntry({
    qq: '111', groups: [K, 'group:900002'],
    nicknames: { [K]: ['阿杰', '姐姐'], 'group:900002': ['小杰'] },
    focus: ['显卡', '手游'],                     // ★ 故意多传：§9 红线 6 说索引不许存关注点
    interests: ['装车']
  });
  assert.deepEqual(Object.keys(idx).sort(), ['groups', 'nicknames', 'qq'],
    '★ 索引只能有这三个字段（关注点是第二份数据，违反单层单写）');
  assert.equal(idx.focus, undefined);

  M.appendGlobalIndex(idx);
  M.appendGlobalIndex(M.makeIndexEntry({
    qq: '111', groups: [K], nicknames: { [K]: ['阿杰'] }
  }));
  const read = M.readGlobalIndex();
  assert.equal(read.rows.length, 2, '快照式追加：两行都在');
  assert.equal(read.list.length, 1, '按 qq 去重，取最后一行');
  assert.deepEqual(read.list[0].groups, [K], '后写的快照覆盖先写的');
  assert.equal(fs.existsSync(path.join(root, 'cross_group_index.jsonl')), true);
  ok('#7 跨群索引：只有三字段（多传的 focus/interests 被丢）、按 qq 取最后一行');
}

// ── #8 第 2 步：memory_append 降级为候选池（不写 L1、不可检索）──
{
  freshRoot();
  const tools = await import('../src/tools.js');
  const registry = await import('../src/tool-registry.js');
  tools.buildToolDefs();                       // 触发注册（幂等）
  const def = registry.getTool('memory_append');
  assert.ok(def, 'memory_append 应已注册');
  assert.deepEqual(def.parameters.properties.kind.enum, ['user_request', 'model_proposal'], 'kind 枚举要定死');
  assert.ok(!def.parameters.required.includes('kind'), 'kind 必须是可选参数（默认 model_proposal）');
  assert.ok(/user_request/.test(def.description), 'description 要教模型何时填 user_request');

  const appended = [];
  const ctx = {
    chatKey: K,
    // 只要这个被调用就说明还有第二个写入口（§9 红线 1）
    memory: { append: (...a) => { appended.push(a); return { evil: true }; } },
    store: { recent: () => [{ mid: 'm777' }] }
  };

  const r1 = JSON.parse((await def.execute(ctx, {
    category: 'memberImpression', userId: '111', target: '阿杰', content: '你记住 阿杰姐姐是猪', kind: 'user_request'
  })).content);
  assert.equal(r1.saved, true);
  assert.equal(r1.pending, true, '★ 返回值必须明说 pending（否则模型会以为已经生效）');
  assert.equal(r1.kind, 'user_request');
  assert.ok(/待定/.test(r1.note || ''), '回给模型的话要诚实：记入待定、现在检索不到');

  const r2 = JSON.parse((await def.execute(ctx, {
    category: 'memberImpression', userId: '222', target: '甲', content: '他最近在找工作'
  })).content);
  assert.equal(r2.kind, 'model_proposal', '不传 kind 默认 model_proposal');

  assert.deepEqual(appended, [], '★ 旧的 memory.append 一次都不能被调用（否则就是双写）');
  const pool = M.readCandidates(K);
  assert.equal(pool.rows.length, 2);
  assert.equal(pool.pending.length, 2, '★ 两条都必须是 pending');
  assert.equal(pool.pending[0].kind, 'user_request');
  assert.equal(pool.pending[0].fromUserId, '111');
  assert.equal(pool.pending[0].msgId, 'm777', 'msgId 用当前最后一条群友发言近似（提炼时按 ts 回看）');
  assert.equal(pool.pending[1].kind, 'model_proposal');

  // 不进 L1：这个人的 L1 文件压根不该被创建
  assert.equal(fs.existsSync(P.l1File(K, '111')), false, '★ 候选池写入不得顺手写 L1');
  assert.equal(M.readL1(K, '111').rows.length, 0);

  // 非法 userId 仍然要拦（沿旧行为）
  const bad = await def.execute(ctx, { category: 'memberImpression', userId: 'abc', content: 'x' });
  assert.equal(bad.isError, true);
  assert.equal(M.readCandidates(K).rows.length, 2, '被拒绝的调用不得落候选池');
  ok('#8 候选池降级：写 pending 不进 L1、旧 memory.append 零调用、kind 默认与显式都对、msgId 有值');
}

// ── #9 第 3 步：提炼四步（分批 / 四维度组 / 晚期覆盖早期 / 去重独立调用）──
const L1 = await import('../src/mem2/l1.js');
const PR = await import('../src/mem2/profile.js');

let seqM = 0;
const mkMsg = (ts, text = 'x', mid = null) => {
  seqM += 1;
  // _chatKey 是补丁后必须带的：分组切批靠它，缺了会让 sourceBatch.chatKey 为空而抛错
  return { mid: mid || `m${seqM}`, ts, text, senderId: UID, senderName: '甲', self: false, _chatKey: K };
};
/** 造 n 条连续消息，每条隔 1 分钟。 */
const msgsN = (n, base = T0, text = '随便聊聊') => Array.from({ length: n }, (_, i) => mkMsg(base + i * 60000, `${text} ${i + 1}`));

/** 假熔断出口：按调用序号返回脚本内容，并记录 kind。 */
function fakeLlm(replies) {
  const calls = [];
  const fn = async (kind, { messages, maxTokens } = {}) => {
    calls.push({ kind, messages, maxTokens });
    const content = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { ok: true, result: { message: { content } } };
  };
  fn.calls = calls;
  return fn;
}

/**
 * 造一个画像槽位。refine 的 `existing` 契约（L1 收敛 §5.3）：
 * 1..M 是槽位（带 sourceEntryIds），M+1..N 是 pinned 只读区（readOnly:true）。
 */
const mkSlot = (index, content, dim, sourceEntryIds, extra = {}) => ({
  index, content, groups: [dim], sourceEntryIds, sourceChatKeys: [K], readOnly: false, ...extra
});

/** 新四段格式：op || 内容 || 维度组 || 行首编号。 */
const sup = (content, groups = '性格特质', ids = '-') => `- || ${content} || ${groups} || ${ids}`;

/** 压缩回复的一行（PROFILE_PROMPT 格式：维度｜来源序号｜正文）。 */
const profLine = (dim, refs, text) => `${dim}｜${refs}｜${text}`;

{
  // 边界：< 30 条不做
  const few = await L1.refine({ userId: UID }, { rawMessages: msgsN(29), memLlmImpl: fakeLlm([sup('x')]) });
  assert.equal(few.ok, false);
  assert.equal(few.reason, 'too-few-messages');
  assert.equal(few.msgCount, 29, '★ 边界是按群友发言条数算的（self 不计数）');

  // 分批：250 条 → 100/100/50，且按时间升序
  const bs = L1.buildBatches(msgsN(250));
  assert.deepEqual(bs.map((b) => b.messages.length), [100, 100, 50]);
  assert.ok(bs[0].startTs < bs[1].startTs && bs[1].startTs < bs[2].startTs, '批次必须按时间升序');
  assert.equal(bs[0].startTs, msgsN(1)[0].ts, 'startTs 取该批第一条');
  ok('#9a 提炼边界：29 条不做（too-few-messages），250 条切成 100/100/50 且时间升序');
}

{
  // 语义去重必须是**独立的一次调用**：14 条同义碎片 → 归并成 7 条。
  // 碎片来源 = 本批 3 条补充（新上限）+ 磁盘上 11 条 deduped:false 的遗留（上次掐断轮留下的）。
  freshRoot();
  for (let i = 0; i < 11; i += 1) {
    M.appendPerson(M.makeL1Entry({
      entryId: `l1_frag_${i + 1}`, chatKey: K, userId: UID,
      sourceBatch: batch({ startTs: T0 - 10 * 86400000, endTs: T0 - 9 * 86400000 }),
      sourceMsgIds: ['m1'], content: `打游戏很菜（说法${i + 1}）`, groups: ['性格特质'],
      deduped: false, createdAt: T0 - 10 * 86400000
    }));
  }
  const frags = [12, 13, 14].map((n) => sup(`打游戏很菜（说法${n}）`)).join('\n');
  // 去重格式（§16.5 ②）：首段是**输入序号**。7 组两两合并，覆盖 1~14 全部。
  const merged = ['1,2', '3,4', '5,6', '7,8', '9,10', '11,12', '13,14']
    .map((ids, i) => `- ${ids} || 打游戏水平不行（合并${i + 1}） || 性格特质 || m1`).join('\n');
  const llm = fakeLlm([frags, merged]);
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(60), memLlmImpl: llm });

  assert.equal(r.ok, true);
  assert.equal(llm.calls.length, 2, '★ 提炼 1 次 + 去重 1 次 = 2 次调用（去重不能省成 prompt 里一句话）');
  assert.deepEqual(llm.calls.map((c) => c.kind), ['l1-refine', 'l1-refine'], '★ 两次都必须走 l1-refine 这个 kind（熔断分桶靠它）');
  assert.equal(r.stats.dedupCalls, 1);
  assert.equal(r.stats.added, 3 + 7, '落盘 = 本批 3 条 + 去重合并 7 条');
  assert.equal(r.stats.produced, 7, '★ 14 条碎片要归并成 7 条独立集');
  // 逐批落盘 + run 末写回：7 条合并条 active（deduped:true），14 条原始碎片 superseded
  const active = M.activePerson(UID);
  assert.equal(active.length, 7, '落盘后的 active 条数与去重结果一致');
  assert.ok(active.every((e) => e.deduped === true), '★ 合并条必须 deduped:true（否则下轮会被重新捞进去重范围）');
  assert.equal(M.readPerson(UID).rows.filter((x) => x.status === 'superseded').length, 14, '被归并的原始条目留痕 superseded');
  assert.equal(new Set(active.map((e) => e.entryId)).size, 7, 'entryId 必须互不相同');

  // 去重那次调用的输入必须包含全部 14 条原文（否则等于没喂）
  const dedupInput = llm.calls[1].messages[1].content;
  for (let i = 1; i <= 14; i += 1) assert.ok(dedupInput.includes(`说法${i}`), `去重输入缺第 ${i} 条`);
  ok('#9b 去重独立：提炼 1 次 + 去重 1 次，14 条碎片（3 新 + 11 遗留）→ 7 条合并条落盘，原始条目留痕');
}

{
  // 晚期覆盖早期：画像槽位 1「常聊手游」被本批 R1「退坑了」取代。
  // 槽位的 sourceEntryIds 指向磁盘旧条目 —— supersede 随批写盘。
  freshRoot();
  M.appendPerson(M.makeL1Entry({
    entryId: 'l1_old_1', chatKey: K, userId: UID, sourceBatch: batch({ startTs: T0 - 10 * 86400000, endTs: T0 - 9 * 86400000 }),
    sourceMsgIds: ['m0'], content: '常聊手游', groups: ['兴趣身份'], createdAt: T0 - 10 * 86400000
  }));
  const existing = [mkSlot(1, '常聊手游', '兴趣身份', ['l1_old_1'])];
  const llm = fakeLlm(['R1 || 已经退坑手游了，现在不玩了 || 兴趣身份 || m5']);
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(40), existing, memLlmImpl: llm });

  assert.equal(r.ok, true);
  assert.equal(r.stats.superseded, 1, '★ R 判定随批写盘：被推翻的旧条目当场标 superseded');
  const all = M.readPerson(UID);
  assert.equal(all.byId.get('l1_old_1').status, 'superseded', '★ superseded 判定必须已落盘（掐断轮不丢 R 判定）');
  const active = M.activePerson(UID);
  assert.equal(active.length, 1);
  assert.ok(active[0].content.includes('退坑'), '留下的是晚期说法');
  assert.equal(active[0].op, 'replace', '★ 新条目要记住自己是 replace 出来的');
  assert.deepEqual(active[0].replaces, ['l1_old_1'], '★ replaces 落盘（白名单不声明就会静默丢）');
  // 既有画像必须真的喂进了提示词（否则模型无从判断"还成立吗"）。补丁后它搬到了 system。
  assert.ok(llm.calls[0].messages[0].content.includes('常聊手游'), '★ 增量提炼必须把已有画像喂进去（system 段）');
  ok('#9c 晚期覆盖早期：R1 指向槽位来源 → superseded 随批落盘，新条目带 op/replaces，画像进了 system');
}

{
  // ★ 编号范围写死 1..M（L1 收敛 §5.3）：R/M **不能**指向本次产出。
  //   旧行为是「合并编号池」，后批可以 R 前批刚落的条目；现在槽位只有 8 个，
  //   指向产出编号一律越界 → 整行丢弃 + 审计，两条产出都留着（交给 run 末去重收）。
  freshRoot();
  const llm = fakeLlm([
    sup('常聊手游', '兴趣身份'),
    `${sup('已经退坑手游了', '兴趣身份')}\nR1 || 退坑改写 || 兴趣身份 || -`,
    // 去重：两条各自单列、内容不变 → 原样保留（§7.4 单条组不换 entryId）
    '- 1 || 常聊手游 || 兴趣身份 || -\n- 2 || 已经退坑手游了 || 兴趣身份 || -'
  ]);
  // 两批：需要 > 100 条
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(120), memLlmImpl: llm });
  assert.equal(r.ok, true);
  assert.equal(r.stats.badRef, 1, '★ 没有槽位时 R1 越界 → badRef');
  assert.equal(r.stats.superseded, 0, '越界的 R 不许 supersede 任何东西');
  const active = M.activePerson(UID);
  assert.equal(active.length, 2, '两条补充都保留，越界那行不落盘');
  const audit = lines(P.l1OverflowFile());
  assert.equal(audit.length, 1, '★ 越界行必须留审计（不允许静默丢）');
  assert.equal(JSON.parse(audit[0]).reason, 'badRef');
  ok('#9d 编号范围：R/M 指向本次产出 → badRef 整行丢弃 + 审计，不 supersede');
}

{
  // 素材口径（§8.1 #9）：签名与调用都不接受 L4/L2；传了也要被忽略
  freshRoot();
  const llm = fakeLlm(['SKIP']);
  const r = await L1.refine({ userId: UID }, {
    rawMessages: msgsN(35),
    l4Summary: '【这段是 L4 摘要，绝不能进提炼】',
    l2Event: '【这段是 L2 event】',
    memLlmImpl: llm
  });
  assert.equal(r.ok, true);
  assert.equal(r.stats.produced, 0, 'SKIP = 这段没什么可记的，允许一条都不产');
  assert.equal(M.readPerson(UID).rows.length, 0, 'SKIP 的批次什么都不落盘（水位也不推进）');
  const sent = llm.calls[0].messages.map((m) => m.content).join('\n');
  assert.ok(!sent.includes('L4 摘要'), '★ 提炼不许喂 L4 摘要（说话风格 36% 靠原文，摘要把它丢了）');
  assert.ok(!sent.includes('L2 event'), '★ 提炼不许喂 L2 event');
  // 形参里不许出现「摘要 / event」这类入参名（§8.1 #9 的签名断言，比读全文更稳）
  const header = L1.refine.toString().split('{')[0];
  assert.ok(!/l4Summary|l4Text|l2Event/.test(header), '★ 签名里不许有 L4/L2 入参名');
  ok('#9e 素材口径：只喂原始消息，L4/L2 传进来也被忽略，SKIP 允许零产出');
}

{
  // 维度组：未知组被丢弃、组内去重、超过 3 个被截断
  const parsed = L1.parseRefineOutput('- || 甲 || 说话风格,说话风格,随便写的组 || -');
  assert.deepEqual(parsed.items[0].groups, ['说话风格'], '未知组要丢、重复组要去重');
  const p2 = L1.parseRefineOutput('- || 乙 || 说话风格,兴趣身份,关系态度,性格特质 || -');
  assert.equal(p2.items[0].groups.length, 3, '最多挂 3 个组');
  ok('#9f 维度组：未知组丢弃、重复组去重、超过 3 个截断');
}

// ── #10 第 4 步：触发调度（两条件 + 候选池兜底）──
{
  const DAY = 86400000;
  const now = T0 + 30 * DAY;

  // ① 80 条触发 / 79 条不触发
  assert.deepEqual(L1.shouldRefine({ unrefinedCount: 80, now }).reason, 'msg-threshold');
  assert.equal(L1.shouldRefine({ unrefinedCount: 79, now }).ok, false, '★ 79 条不许触发（阈值是 80）');
  // 记过提炼的人、79 条、才过 2 天 → 也不触发
  assert.equal(L1.shouldRefine({ unrefinedCount: 79, lastRefinedAt: now - 2 * DAY, now }).ok, false);

  // ② 满 7 天 + 25 条触发；7 天 + 24 条不触发
  const r25 = L1.shouldRefine({ unrefinedCount: 25, lastRefinedAt: now - 7 * DAY, now });
  assert.equal(r25.ok, true, '★ 7 天 + 25 条要触发');
  assert.equal(r25.reason, 'stale-and-new');
  assert.equal(L1.shouldRefine({ unrefinedCount: 24, lastRefinedAt: now - 7 * DAY, now }).ok, false,
    '★ 7 天 + 24 条不触发（差一条就是不跑）');
  // 只过了 3 天 → 即便 200 条也走 ① 而不是 ②
  assert.equal(L1.shouldRefine({ unrefinedCount: 200, lastRefinedAt: now - 3 * DAY, now }).reason, 'msg-threshold');
  // 从没提炼过（lastRefinedAt=0）时 ② 不成立（否则冷启动会被时间条件空跑一遍）
  assert.equal(L1.shouldRefine({ unrefinedCount: 10, lastRefinedAt: 0, now }).ok, false);
  ok('#10a 触发条件：80 触发/79 不触发；7 天+25 触发、+24 不触发；未提炼过时时间条件不成立');
}

{
  const DAY = 86400000;
  const now = T0 + 30 * DAY;
  const mk = (entryId, days, status = 'pending') => ({ entryId, status, ts: now - days * DAY, text: 'x' });
  const picked = L1.pickStaleCandidates([mk('a', 8), mk('b', 6), mk('c', 30, 'adopted'), mk('d', 7.1)], { now });
  assert.deepEqual(picked.map((x) => x.entryId), ['a', 'd'], '★ 只挑 pending 且超过 7 天的（adopted 再老也不碰）');
  assert.deepEqual(L1.pickStaleCandidates([mk('b', 6)], { now }), [], '6 天的不动');
  ok('#10b 候选池兜底：最老 pending > 7 天才挑，非 pending 与不足 7 天的一律不动');
}

{
  // 端到端：一个够 80 条的人被提炼并落盘，一个不够的人被跳过，候选池被裁决
  freshRoot();
  const DAY = 86400000;
  const now = T0 + 30 * DAY;
  const A = '111'; const B = '222'; const C = '333';
  const msgs = [];
  for (let i = 0; i < 85; i += 1) msgs.push({ ...mkMsg(T0 + i * 60000, '钓鱼真爽'), senderId: A, senderName: '钓佬' });
  for (let i = 0; i < 20; i += 1) msgs.push({ ...mkMsg(T0 + i * 60000, '嗯'), senderId: B, senderName: '潜水' });
  for (let i = 0; i < 35; i += 1) msgs.push({ ...mkMsg(T0 + i * 60000, '在的'), senderId: C, senderName: '路人' });
  // C 过了 30 条门槛，但刚提炼过（水位=最后一条消息）→ 应该被「跳过」而不是「处理」
  M.appendPerson(M.makeL1Entry({
    entryId: 'l1_c_old', chatKey: K, userId: C, content: '常在群里报个到',
    groups: ['性格特质'], sourceMsgIds: [],
    sourceBatch: { chatKey: K, userId: C, startTs: T0, endTs: T0 + 34 * 60000, msgCount: 35 }
  }));
  // B 的候选池条目：他不够 30 条，也不该被处理
  M.appendCandidate(K, M.makeCandidateRow({ entryId: 'c_b', fromUserId: B, text: '他好像要搬家', ts: T0 }));
  M.appendCandidate(K, M.makeCandidateRow({ entryId: 'c_a', fromUserId: A, text: '他最近沉迷钓鱼', ts: T0 }));

  // fakeLlm 的每个元素是「一次调用的完整回复」（可以多行）。
  // 顺序：A 提炼 → A 去重 → C 画像压缩（C 走「跳过」分支也要压缩，§4.4；
  // 队列是 tick 开始算的，A 还没进队列 → 下一轮再压）
  const llm = fakeLlm([
    [sup('沉迷钓鱼，一开口就是钓况', '兴趣身份,说话风格'), sup('只在深夜出现')].join('\n'),
    ['- 1 || 沉迷钓鱼，一开口就是钓况 || 兴趣身份,说话风格 || -',
      '- 2 || 只在深夜出现 || 性格特质 || -'].join('\n'),
    profLine('兴趣身份', '1', '他长期沉迷钓鱼，一开口就是钓况，说话也带着钓鱼佬的口吻'),
    profLine('性格特质', '1', '他常在群里报个到，存在感稳定但不多话')
  ]);
  const sources = [{ chatKey: K, messages: msgs }];
  const stat = await L1.sweepPeople({ sources, now, memLlmImpl: llm });

  assert.equal(stat.refined, 1, '★ 只提炼够资格的那个（85 条）');
  assert.equal(stat.skipped, 1, '★ 35 条但刚提炼过的人要走「跳过」分支，不烧调用');
  assert.equal(stat.callsUsed, 3, '提炼 1 + 去重 1 + 画像压缩 1（只压队列里的 C）');
  // §4.4：队列是 tick 开始算的。A 是本轮才第一次落盘（进队列前还没有 person 文件），
  // 所以这一轮只记 profilePending，留给下一槽 —— 不临时扩额挤掉提炼。
  assert.equal(stat.profilePending, 1, '★ 队列外新变脏的 A 记 pending，不临时扩额');
  assert.equal(stat.profileCalls, 1);
  assert.equal(stat.profilesBuilt, 1, '★ 本轮只建 C 的画像');
  assert.equal(PR.readProfile(A), null, 'A 的画像等下一槽');
  assert.ok(PR.readProfile(C), '画像落盘在 people/<uid>.profile.json');
  assert.equal(M.activePerson(B).length, 0, '★ 20 条的人连画像都不该有（< 30 条门槛在入口就滤掉）');
  const saved = M.activePerson(A);
  assert.equal(saved.length, 2, '落盘的条数与去重结果一致');
  assert.equal(saved[0].sourceBatch.msgCount, 85, 'sourceBatch 要带上这一批的条数');
  assert.ok(saved[0].sourceBatch.userId === A && saved[0].sourceBatch.chatKey === K);
  assert.ok(saved.every((e) => e.deduped === true), '★ 合并条 deduped:true');
  assert.ok(fs.existsSync(P.personFile(A)), '★ 落盘位置是 people/<uid>.jsonl（不是 group_xxx/l1/）');
  assert.deepEqual(saved[0].sourceChatKeys, [K], '来源群记的是本批的群');

  // 候选池裁决留痕：A 的候选被 adopted，B 的仍未动
  const pool = M.readCandidates(K);
  assert.equal(pool.byId.get('c_a').status, 'adopted', '★ 提炼跑过 = 裁决完毕，要有留痕');
  assert.equal(pool.byId.get('c_b').status, 'pending', '没跑的人候选保持 pending');
  assert.equal(fs.existsSync(path.join(P.mem2Dir(), 'group_undefined', 'candidates.jsonl')), false,
    '★ 候选回写不许落到 group_undefined/（说明用了不存在的 c.chatKey）');

  // 落盘后立刻再扫一次：没有新消息 → 不重复提炼；但 A 已进队列 → 这一轮补上画像
  const stat2 = await L1.sweepPeople({ sources, now: now + 60000, memLlmImpl: llm });
  assert.equal(stat2.refined, 0, '★ 提炼过的消息不该被重复提炼（水位来自 sourceBatch.endTs）');
  assert.equal(stat2.callsUsed, 1, '★ 跳过分支也必须压缩：A 在队列里 → 1 次压缩调用');
  assert.ok(PR.readProfile(A), '★ 没新消息的人也会因为画像脏被补上（「跳过」分支先压缩）');

  // 第三次：两个画像的 digest 都追平了 → 零调用
  const stat3 = await L1.sweepPeople({ sources, now: now + 120000, memLlmImpl: llm });
  assert.equal(stat3.callsUsed, 0, '★ 画像 digest 未变 → 压缩也不该重跑（空转零调用）');
  assert.equal(stat3.skipped, 2, 'A/C 都走跳过分支');

  // 默认不挂定时器
  assert.equal(L1.startL1Daily({ store: {}, l1cfg: { enabled: false } }), null, '未显式开启时不占定时器');
  ok('#10c 端到端：85 条的被提炼落盘、20 条的跳过、候选池 adopted 留痕、二次扫描不重复、默认不启定时器');
}

// ── #11 第 5 步：出处字段 + 跨群索引聚合 ──
{
  freshRoot();
  // 固定 mid（m1..m60）：序号回填要能从 #1,#2 解出真 mid，用全局 seqM 造的消息对不上号
  const fixed60 = Array.from({ length: 60 }, (_, i) => ({
    mid: `m${i + 1}`, ts: T0 + i * 60000, text: `第 ${i + 1} 条`, senderId: UID, senderName: '甲', self: false, _chatKey: K
  }));
  const llm = fakeLlm([
    // 一条有原话支撑、一条是归纳（没有人能指到某句话）
    [sup('钓鱼佬，一开口就是钓况', '兴趣身份', '#1,#2'), sup('脾气挺好，被怼也不急')].join('\n'),
    ['- 1 || 钓鱼佬，一开口就是钓况 || 兴趣身份 || -',
      '- 2 || 脾气挺好，被怼也不急 || 性格特质 || -'].join('\n')
  ]);
  const r = await L1.refine({ userId: UID }, { rawMessages: fixed60, memLlmImpl: llm });
  assert.equal(r.ok, true);
  for (const e of M.activePerson(UID)) {
    const b = e.sourceBatch || {};
    assert.ok(b.chatKey === K && b.userId === UID, '★ 每条都必须有 sourceBatch（谁、哪个群）');
    assert.ok(b.startTs > 0 && b.endTs >= b.startTs, '★ sourceBatch 要带批次时间窗');
    assert.equal(b.msgCount, 60, '★ sourceBatch 要带这一批的条数');
  }
  // sourceMsgIds 是「有单句支撑才填」，归纳性的必须为空
  const withIds = M.activePerson(UID).find((e) => e.content.includes('钓况'));
  const without = M.activePerson(UID).find((e) => e.content.includes('脾气'));
  assert.deepEqual(withIds.sourceMsgIds, ['m1', 'm2'], '有原话的条目要带 msgId');
  assert.deepEqual(without.sourceMsgIds, [], '★ 归纳性印象不留 msgId（伪精确比空更糟）');
  ok('#11a 出处：每条都有 sourceBatch（群/人/时间窗/条数），sourceMsgIds 只在有原话时出现');
}

{
  const root = freshRoot();
  const sources = [
    { chatKey: 'group:100', messages: [
      { mid: 'a1', ts: T0, text: 'x', senderId: '888', senderName: '老王', self: false },
      { mid: 'a2', ts: T0 + 1, text: 'y', senderId: '888', senderName: '王哥', self: false },
      { mid: 'a3', ts: T0 + 2, text: 'z', senderId: '999', senderName: '小李', self: false }
    ] },
    { chatKey: 'group:200', messages: [
      { mid: 'b1', ts: T0, text: 'x', senderId: '888', senderName: '老W', self: false },
      { mid: 'b2', ts: T0 + 1, text: '自己的话', senderId: '888', senderName: '老王', self: true }
    ] }
  ];
  const n = L1.refreshCrossGroupIndex(sources);
  assert.equal(n, 2, '两个人 → 两条索引');

  const idx = M.readGlobalIndex();
  const wang = idx.byQq.get('888');
  assert.deepEqual(wang.groups.sort(), ['group:100', 'group:200'], '★ 两个群都要聚合进来');
  assert.deepEqual(wang.nicknames['group:100'], ['老王', '王哥'], '同一群里的多个叫法按出现顺序保留');
  assert.deepEqual(wang.nicknames['group:200'], ['老W'], '★ 昵称按群分开存（合并成一个数组就丢了"哪群叫法"）');
  assert.deepEqual(Object.keys(wang).sort(), ['groups', 'nicknames', 'qq'],
    '★ 索引只许有三个字段：不存关注点/兴趣/画像内容');
  assert.equal(wang.focus, undefined);
  assert.equal(M.readGlobalIndex().byQq.get('999').groups.length, 1, '只在单群出现的人也入索引');
  assert.equal(fs.existsSync(path.join(root, 'cross_group_index.jsonl')), true);
  ok('#11b 索引聚合：跨群 groups 合并、昵称按群分开、只有三字段（无关注点）、自己发言不入索引');
}

// ── §9.1 #1 批次格式压缩：无逐条时间戳、有跨天分隔行、行首是 #序号 ──
{
  const msgs = [
    { mid: 'm1', ts: T0, text: '第一天的第一句', senderId: UID, senderName: '甲', self: false },
    { mid: 'm2', ts: T0 + 60000, text: '第一天的第二句', senderId: UID, senderName: '甲', self: false },
    { mid: 'm3', ts: T0 + 86400000, text: '第二天了', senderId: UID, senderName: '甲', self: false }
  ];
  const text = L1.formatBatchMessages(msgs);
  assert.ok(/^--- \d\d-\d\d ---$/m.test(text), '★ 要有跨天分隔行 --- MM-DD ---');
  assert.ok(/#1 /.test(text) && /#3 /.test(text), '行首要是批次内序号');
  assert.ok(!/^\d\d-\d\d \d\d:\d\d /m.test(text),
    '★ 行首不许再有 MM-DD HH:MM 时间戳（正则锚定行首：正文里出现 22:07 是合法的）');
  const { text: t2, idMap } = L1.formatBatchMessages(msgs, { withIdMap: true });
  assert.equal(t2, text, 'withIdMap 不能改变渲染结果');
  assert.equal(idMap.get('2'), 'm2', 'idMap 是 序号→真实 mid');
  ok('§9.1#1 格式压缩：无时间戳、有 --- MM-DD --- 分隔行、行首 #序号、idMap 可溯源');
}

{
  // §9.1 #2 序号回填成**裸**真 mid；#3 越界序号被丢弃并计入 badMsgIds
  freshRoot();
  const fixed = (n) => Array.from({ length: n }, (_, i) => ({
    mid: `m${i + 1}`, ts: T0 + i * 60000, text: `第 ${i + 1} 条`, senderId: UID, senderName: '甲', self: false,
    _chatKey: K
  }));

  const llm = fakeLlm([sup('打游戏很菜但爱玩', '性格特质', '#3,#7')]);
  const r = await L1.refine({ userId: UID }, { rawMessages: fixed(40), memLlmImpl: llm });
  assert.equal(r.ok, true);
  assert.equal(llm.calls.length, 1, '单条产出没有可归并的 → 去重调用省掉（scope ≤ 1）');
  const saved1 = M.activePerson(UID);
  assert.equal(saved1.length, 1);
  assert.deepEqual(saved1[0].sourceMsgIds, ['m3', 'm7'],
    '★ 模型写 #3,#7 → 存裸真 mid m3/m7（不带 #，也不是 "3" 这种废数据）');
  assert.equal(r.stats.badMsgIds, 0);

  freshRoot();
  const llm2 = fakeLlm([sup('打游戏很菜但爱玩', '性格特质', '#999')]);
  const r2 = await L1.refine({ userId: UID }, { rawMessages: fixed(40), memLlmImpl: llm2 });
  assert.equal(r2.ok, true);
  const saved2 = M.activePerson(UID);
  assert.deepEqual(saved2[0].sourceMsgIds, [], '越界序号不许进 sourceMsgIds');
  assert.equal(r2.stats.badMsgIds, 1, '★ 越界要计数：badMsgIds>0 说明提示词没教明白或批次太长');
  ok('§9.1#2/#3 序号回填：存裸 mid、越界丢弃并计入 badMsgIds（逐批落盘后从盘上验）');
}

{
  // §9.1 #11 提示词约束（字符串断言，故意脆：丢了不会有任何报错）
  assert.ok(L1.REFINE_PROMPT.includes('一次性的计划和日程'), '★ 「一次性计划不记」这条约束丢了');
  const timeWords = ['下周', '明天', '这周末'].filter((w) => L1.REFINE_PROMPT.includes(w));
  assert.ok(timeWords.length >= 2, `需要至少 2 个时效反例词，实际命中 ${JSON.stringify(timeWords)}`);
  assert.ok(L1.REFINE_PROMPT.includes('11-20 生日'), '生日要记「日期本身」，这条写法示例不能删');
  assert.ok(L1.REFINE_PROMPT.includes('行首的编号'), '支撑消息改成编号引用，不能还写「消息 id」');
  ok('§9.1#11 提示词：含「一次性计划和日程」+ 2 个以上时效反例 + 生日写法 + 编号引用');
}

// ── §9.1 #8 按人存：appendPerson 只凭 sourceBatch.userId 落盘 ──
{
  const root = freshRoot();
  assert.equal(P.personFile(UID), path.join(root, 'people', `${UID}.jsonl`), '★ 画像落在 mem2/people/<uid>.jsonl');

  // 条目上**没有**顶层 userId —— 模拟落盘数据真实形状，专治「读 entry.userId」这种直觉写法
  const e = M.makeL1Entry({
    entryId: 'p_1', chatKey: K, userId: UID, sourceBatch: batch(),
    content: '说话爱用波浪号', groups: ['说话风格'], createdAt: T0
  });
  assert.equal(e.userId, undefined, '条目本身不带顶层 userId（字段口径见 §3.2）');

  let threw = null;
  try { M.appendPerson({ ...e, sourceBatch: { ...e.sourceBatch, userId: '' } }); } catch (err) { threw = err; }
  assert.ok(threw && /sourceBatch\.userId/.test(threw.message), '缺 sourceBatch.userId 要当场抛，不能静默写 group_undefined');

  M.appendPerson(e);
  assert.equal(M.readPerson(UID).rows.length, 1);
  assert.equal(M.readPerson(UID).list[0].content, '说话爱用波浪号');

  // append-only：状态变更追加新行，读时以最后一行为准
  const before = fs.readFileSync(P.personFile(UID), 'utf8').split('\n').filter(Boolean);
  assert.equal(before.length, 1);
  const next = M.setPersonStatus(UID, 'p_1', 'superseded', { nowTs: T0 + 1000 });
  assert.equal(next.status, 'superseded');
  const after = fs.readFileSync(P.personFile(UID), 'utf8').split('\n').filter(Boolean);
  assert.equal(after.length, 2, '★ setPersonStatus 必须是追加一行，不是原地改写');
  assert.equal(after[0], before[0], '首行字节不变');
  assert.equal(M.readPerson(UID).list.length, 1, '同 entryId 只算一条');
  assert.equal(M.activePerson(UID).length, 0, 'superseded 不算 active');
  assert.equal(M.setPersonStatus(UID, 'p_404', 'void'), null, '不造孤儿状态行');
  ok('§9.1#8 按人存：people/<uid>.jsonl、凭 sourceBatch.userId 落盘、缺字段即抛、状态流转 append-only');
}

// ── §9.1 #6 覆盖时继承旧来源群（sourceChatKeys 并集且排序）──
{
  freshRoot();
  const A = 'group:100';
  const B = 'group:200';
  const old = M.makeL1Entry({
    entryId: 'old_1', chatKey: A, userId: UID, sourceBatch: batch({ chatKey: A }),
    sourceChatKeys: [A], content: '常聊手游', groups: ['兴趣身份'], createdAt: T0
  });
  const merged = M.makeL1Entry({
    entryId: 'new_1', chatKey: B, userId: UID, sourceBatch: batch({ chatKey: B }),
    sourceChatKeys: [B, ...old.sourceChatKeys], content: '已经退坑手游了', groups: ['兴趣身份'], createdAt: T0 + 1000
  });
  assert.deepEqual(merged.sourceChatKeys, [A, B].sort(), '★ 新条目要并上旧条目的来源群，且排好序');
  assert.equal(merged.sourceBatch.chatKey, B, 'sourceBatch.chatKey 是本批的群，不是近似值');
  ok('§9.1#6 覆盖继承：sourceChatKeys 取并集且排序；sourceBatch.chatKey 记本批的群');
}

// ── §9.1 #4/#10 跨群水位：一个群炼过不许把另一个群判成已炼 ──
{
  const A = 'group:100';
  const B = 'group:200';
  const T1 = T0 + 10 * 86400000;
  const existing = [{
    entryId: 'e_a', content: 'A 群的印象', groups: ['性格特质'], status: 'active',
    createdAt: T1, sourceChatKeys: [A],
    sourceBatch: { chatKey: A, userId: UID, startTs: T1 - 1000, endTs: T1, msgCount: 60 }
  }];
  const wm = L1.lastRefinedEndByChat(existing);
  assert.equal(wm.get(A), T1);
  assert.equal(wm.has(B), false, 'B 群没有水印');

  // B 群的消息比 T1 还早 —— 用单一 lastEnd 会被判成「已提炼」而永久跳过
  const olderB = { mid: 'b1', ts: T1 - 86400000, text: 'B 群的旧话', senderName: '甲', _chatKey: B };
  const selected = [olderB].filter((m) => (Number(m.ts) || 0) > (wm.get(m._chatKey) || 0));
  assert.equal(selected.length, 1, '★ B 群旧消息仍要被选中（单一时钟会把它吞掉）');

  // #10：B 群从没炼过 → oldestWm 必须是 0，而不是「A 群昨天的水位」
  assert.equal(L1.oldestWatermark([A, B], wm), 0, '★ 只要有一个群没水印就取 0');
  assert.equal(L1.oldestWatermark([A], wm), T1, '全都有水印时取最小');
  const verdict = L1.shouldRefine({
    unrefinedCount: 40, lastRefinedAt: L1.oldestWatermark([A, B], wm), now: T1 + 1000, refinedSomewhere: true
  });
  assert.equal(verdict.ok, true, '★ 无水印群的 40 条要走 stale 分支触发（否则永远进不了画像）');
  assert.equal(verdict.missingChatWatermark, true);
  // 从没炼过的人不走这条：否则首次提炼门槛会从 80 掉到 25
  assert.equal(L1.shouldRefine({ unrefinedCount: 40, lastRefinedAt: 0, now: T1 }).ok, false,
    '★ 从没炼过的人仍受 80 条门槛约束');
  ok('§9.1#4/#10 跨群水位：按群记水位、B 群旧消息不被吞、缺水群 oldestWm=0 且能触发');
}

// ── §9.1 #7 分组切批：两群各 60 条交错 → 2 批，每批只含一个群 ──
{
  const A = 'group:100';
  const B = 'group:200';
  const mk = (chatKey, i) => ({ mid: `${chatKey}-${i}`, ts: T0 + i * 120000 + (chatKey === B ? 60000 : 0), text: `第${i}条`, senderName: '甲', _chatKey: chatKey });
  const mixed = [];
  for (let i = 0; i < 60; i += 1) { mixed.push(mk(A, i)); mixed.push(mk(B, i)); }

  const batches = L1.buildBatchesByChat(mixed);
  assert.equal(batches.length, 2, '★ 两个群各 1 批（不是把 120 条混成 2 批）');
  assert.notEqual(batches[0].chatKey, batches[1].chatKey, '两批的群必须互异');
  for (const b of batches) {
    const keys = new Set(b.messages.map((m) => m._chatKey));
    assert.equal(keys.size, 1, '★ 每批只能含一个群');
    assert.equal([...keys][0], b.chatKey, '批次自带的 chatKey 必须等于批内消息的群');
  }
  assert.ok(batches[0].startTs <= batches[1].startTs, '批次仍按时间排序（R 覆盖靠它）');

  // 炼完之后再过滤：这 120 条必须一条都不再入选（每群水位各自推进）
  const done = batches.map((b) => ({
    entryId: `x_${b.chatKey}`, content: 'x', groups: ['性格特质'], status: 'active', createdAt: b.endTs,
    sourceChatKeys: [b.chatKey],
    sourceBatch: { chatKey: b.chatKey, userId: UID, startTs: b.startTs, endTs: b.endTs, msgCount: b.messages.length }
  }));
  const wm2 = L1.lastRefinedEndByChat(done);
  const left = mixed.filter((m) => (Number(m.ts) || 0) > (wm2.get(m._chatKey) || 0));
  assert.equal(left.length, 0, '★ 两个群的水位都要推进，否则另一个群每轮重炼');
  ok('§9.1#7 分组切批：2 批各含一个群、chatKey 互异且准确、炼完 120 条全被水位挡掉');
}

// ── §9.1 #5 system 段跨批逐字节一致（前缀缓存的前提）──
{
  freshRoot();
  // 两批各产 1 条同内容 → 去重 1 组（新格式带序号）
  const llm = fakeLlm([sup('爱用波浪号', '说话风格'), '- 1,2 || 爱用波浪号 || 说话风格 || -']);
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(150), memLlmImpl: llm });
  assert.equal(r.ok, true);
  assert.ok(llm.calls.length >= 2, '150 条要切 2 批');
  const sys0 = llm.calls[0].messages[0].content;
  assert.equal(llm.calls[1].messages[0].content, sys0,
    '★ 两批的 system 必须逐字节相同 —— 一旦含了本批产出，前缀缓存一次都命中不了');
  // 本批产出走 user 段的独立小节，**不带编号**（R/M 的编号只属于 system 里的槽位）
  assert.ok(llm.calls[1].messages[1].content.includes('【本次已产出】'),
    '★ 第 2 批要能在 user 里看到第 1 批的产出（否则会重复写同一个意思）');
  ok('§9.1#5 system 稳定：两批字节一致；本批产出走 user 的【本次已产出】小节');
}

// ── §5.4 R/M 写回：一个槽位可能压了多条 active，取代它要 supersede **全部**来源 ──
{
  freshRoot();
  for (const id of ['old_1', 'old_2']) {
    M.appendPerson(M.makeL1Entry({
      entryId: id, chatKey: K, userId: UID, sourceBatch: batch(),
      sourceChatKeys: [K], content: id === 'old_1' ? '常聊手游' : '手游里爱玩德系',
      groups: ['兴趣身份'], createdAt: T0
    }));
  }
  const existing = [mkSlot(1, '他常聊手游，偏好德系', '兴趣身份', ['old_1', 'old_2'])];
  const llm = fakeLlm(['M1 || 他常聊手游但最近开始玩新游戏了 || 兴趣身份 || #2']);
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(60), existing, memLlmImpl: llm });
  assert.equal(r.ok, true);
  assert.equal(r.stats.superseded, 2, '★ 槽位的全部来源都要 superseded，不是只挑一条');
  const all = M.readPerson(UID);
  assert.equal(all.byId.get('old_1').status, 'superseded');
  assert.equal(all.byId.get('old_2').status, 'superseded');
  const active = M.activePerson(UID);
  assert.equal(active.length, 1);
  assert.equal(active[0].op, 'merge', '★ M<k> → op=merge');
  assert.deepEqual(active[0].replaces, ['old_1', 'old_2'], 'replaces 记下被取代的全部来源');
  assert.deepEqual(active[0].sourceChatKeys, [K], '来源群 = 本批群 ∪ 槽位来源群');
  ok('§5.4 R/M 写回：M1 指向双来源槽位 → 两条来源都 superseded，新条目 op=merge + replaces');
}

// ── §5.4-12 多批 R/M 槽位漂移：第 2 批再改同一槽 → 覆盖第 1 批的产出，不留双活 ──
// 旧实现 existingList 在 run 开始时固定：两批都写 R1，第 1 批的新条不会被第 2 批接管，
// 结果是同一槽两条新条目同时 active（旧来源只 supersede 一次，看不出来）。
{
  freshRoot();
  M.appendPerson(M.makeL1Entry({
    entryId: 'old_1', chatKey: K, userId: UID, sourceBatch: batch(),
    sourceChatKeys: [K], content: '旧槽内容', groups: ['说话风格'], createdAt: T0
  }));
  const existing = [mkSlot(1, '旧槽内容', '说话风格', ['old_1'])];
  const K2 = 'group:900002';
  const m1 = msgsN(100, T0);
  const m2 = msgsN(100, T0 + 200 * 60000).map((m) => ({ ...m, _chatKey: K2, mid: `${m.mid}b` }));
  const llm = fakeLlm([
    'R1 || 新说法A：说话短促爱抢话 || 说话风格 || -',
    'R1 || 新说法B：说话短促爱抢话且爱反问 || 说话风格 || -'
  ]);
  // callsLeft=2：两批提炼刚好用满；R/M 后只剩 1 条待去重条目，A2 重建 scope 后不再假 aborted
  const r = await L1.refine({ userId: UID }, { rawMessages: [...m1, ...m2], existing, memLlmImpl: llm, callsLeft: 2 });
  assert.ok(!r.aborted, '★ scope 只剩 1 条时不该因预算刚好用满而报 aborted');
  assert.equal(r.stats.batches, 2, '两个群 → 两批');
  assert.equal(r.stats.superseded, 2, '★ old_1 被第 1 批 supersede，新说法A 被第 2 批 supersede');
  const all = M.readPerson(UID);
  assert.equal(all.byId.get('old_1').status, 'superseded');
  const a = all.list.find((e) => e.content.startsWith('新说法A'));
  assert.equal(a.status, 'superseded', '★ 第 1 批的产出被第 2 批的 R1 接管（不留双活）');
  const active = M.activePerson(UID);
  assert.equal(active.length, 1, '★ 同一槽只留最后一条');
  assert.ok(active[0].content.startsWith('新说法B'));
  assert.deepEqual(active[0].replaces, [a.entryId], '第 2 批取代的是第 1 批的产出，不是已 superseded 的 old_1');
  ok('§5.4-12 多批 R/M：槽位就地回写，后一批接管前一批，同一槽不留双活');
}

// ── §5.4-13 同批双 R：同一条回复里两条 R1 → 未落盘的那条直接作废，不留双活 ──
// 旧实现：第 2 条 R1 指向第 1 条刚产出但还没落盘的条目，setPersonStatus 写不到（文件里没有），
// 返回 false 不计数，但新条目照落 → 同一槽两条 active。
{
  freshRoot();
  M.appendPerson(M.makeL1Entry({
    entryId: 'old_x', chatKey: K, userId: UID, sourceBatch: batch(),
    sourceChatKeys: [K], content: '旧槽内容', groups: ['说话风格'], createdAt: T0
  }));
  const existing = [mkSlot(1, '旧槽内容', '说话风格', ['old_x'])];
  const llm = fakeLlm([
    'R1 || 新说法A：说话短促爱抢话 || 说话风格 || -\nR1 || 新说法B：说话短促爱抢话且爱反问 || 说话风格 || -'
  ]);
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(100), existing, memLlmImpl: llm });
  assert.equal(r.ok, true);
  assert.equal(r.stats.batchSuperseded, 1, '★ 同批第二条 R1 取消了第一条未落盘的产出');
  assert.equal(r.stats.added, 1, '★ 只有 B 落盘（A 从未存在，不需要 superseded 行）');
  const all = M.readPerson(UID);
  assert.equal(all.list.filter((e) => e.content.startsWith('新说法A')).length, 0, 'A 不该出现在文件里');
  const active = M.activePerson(UID);
  assert.equal(active.length, 1, '★ 同一槽只留一条 active');
  assert.ok(active[0].content.startsWith('新说法B'));
  assert.deepEqual(active[0].replaces, ['old_x'], '★ 血统接回真实前驱，不指向被取消的 A');
  ok('§5.4-13 同批双 R：未落盘条目直接作废，replaces 接回真实前驱，不留双活');
}

// ── §4.6-16 空维度补位（2026-11-17 复核）：模型漏一维 → 按 active 确定性补 top-2，注入不缺维 ──
{
  freshRoot();
  const mk = (id, content, group, updatedAt) => M.makeL1Entry({
    entryId: id, chatKey: K, userId: UID, sourceBatch: batch(), sourceChatKeys: [K],
    content, groups: [group], createdAt: T0, updatedAt
  });
  M.appendPerson(mk('s1', '说话爱用波浪号，一句话拆三条发', '说话风格', T0 + 8));
  M.appendPerson(mk('s2', '常回"草"，情绪外露', '说话风格', T0 + 7));
  M.appendPerson(mk('r1', '对熟人爱搭话，玩笑尺度偏大', '关系态度', T0 + 6));
  M.appendPerson(mk('r2', '对看不惯的人语气刻薄', '关系态度', T0 + 5));
  M.appendPerson(mk('c1', '嘴硬但恢复快，被怼会自嘲', '性格特质', T0 + 4));
  M.appendPerson(mk('c2', '最在意别人说他菜', '性格特质', T0 + 3));
  M.appendPerson(mk('i2', '自己写同人，偶尔发存档', '兴趣身份', T0 + 2));
  M.appendPerson(mk('i1', '长期玩某款手游，熟悉版本黑话', '兴趣身份', T0 + 1));

  // 模型只写说话风格（模拟 367：漏掉材料最厚的兴趣身份）
  const llm = fakeLlm(['说话风格｜1,2｜说话短促，爱用波浪号（合并说法）']);
  const res = await L1.compressProfile(UID, { activeEntries: M.activePerson(UID), profile: null, memLlmImpl: llm, now: T0 + 7 });
  assert.equal(res.ok, true);
  assert.equal(res.stats.calls, 1, '补位不额外调模型');
  const prof = PR.readProfile(UID);
  const dims = prof.slots.map((s) => s.dim);
  assert.ok(dims.includes('兴趣身份'), '★ 漏掉的兴趣身份必须补上（否则注入永久少一维）');
  assert.equal(prof.slots.length, 7, '1 条模型产出 + 3 维各 2 条补位 = 7');
  const filled = prof.slots.filter((s) => s.filled === true);
  assert.equal(filled.length, 6);
  assert.ok(filled.every((s) => s.sourceEntryIds.length === 1 && M.activePerson(UID).some((e) => e.entryId === s.sourceEntryIds[0])),
    '★ 补位来源必须是真实 entryId');
  // 兴趣按 updatedAt 降序 → i2 先于 i1
  const interest = prof.slots.filter((s) => s.dim === '兴趣身份');
  assert.deepEqual(interest.map((s) => s.sourceEntryIds[0]), ['i2', 'i1']);
  assert.deepEqual(prof.stats.missingDims.slice().sort(), ['关系态度', '兴趣身份', '性格特质'].sort(), '漏维要记在 stats');
  assert.deepEqual(prof.stats.filledDims.slice().sort(), ['关系态度', '兴趣身份', '性格特质'].sort());
  assert.equal(prof.stats.retry, 1, '同一 digest 只留 1 次重试机会');

  // 端到端：注入端必须出现兴趣行（不是「槽全空才兜底」那条老路）
  const INJ = await import('../src/mem2/inject.js');
  const items = INJ.resolvePersonItems(UID, M.activePerson(UID), prof);
  assert.equal(items.usedFallback, false, '走的是画像槽位，不是全量兜底');
  assert.ok(items.slots.some((s) => s.dim === '兴趣身份'), '★ 注入条里有兴趣身份');
  const fit = INJ.fitProfileText([{ uid: UID, name: '甲', slots: items.slots, pinned: items.pinned }]);
  assert.ok(fit.text.includes('手游'), '★ 注入正文出现兴趣内容');

  // 队列不再判脏（重试用尽），下一轮不会反复烧调用
  assert.equal(PR.buildProfileQueue().length, 0, '★ 补位后 retry 用尽 → 不再每轮重压');
  ok('§4.6-16 空维度补位：模型漏维 → 确定性补 top-2、注入不缺维、stats 记 missingDims、只重试一次');
}

// ── §4.6-17 题材词只统计、不拦截：命中照常进画像，只计数 + 日志 ──
{
  freshRoot();
  const mk = (id, content, group, updatedAt) => M.makeL1Entry({
    entryId: id, chatKey: K, userId: UID, sourceBatch: batch(), sourceChatKeys: [K],
    content, groups: [group], createdAt: T0, updatedAt
  });
  M.appendPerson(mk('p1', '对同人内容有明确底线', '性格特质', T0 + 1));
  M.appendPerson(mk('p2', '说话爱用波浪号，情绪外露', '说话风格', T0 + 2));

  const logs = [];
  const llm = fakeLlm([
    '性格特质｜1｜对同人内容有明确底线，反感凌辱恶堕类，自认有分寸\n关系态度｜2｜对熟人爱搭话，玩笑尺度偏大'
  ]);
  const res = await L1.compressProfile(UID, {
    activeEntries: M.activePerson(UID), profile: null, memLlmImpl: llm, now: T0 + 3, log: (m) => logs.push(m)
  });
  assert.equal(res.ok, true);
  const prof = PR.readProfile(UID);
  assert.equal(prof.stats.sensitiveHits, 1, '★ 命中题材词要计数');
  const text = prof.slots.map((s) => s.content).join('｜');
  assert.ok(text.includes('凌辱') && text.includes('恶堕'), '★ 题材名照常进画像（只统计、不拦截）');
  const trait = prof.slots.filter((s) => s.dim === '性格特质');
  assert.equal(trait.length, 1, '★ 命中的槽没被丢，也不需要补位');
  assert.equal(trait[0].filled, undefined, '★ 命中的是模型产出的原槽，不是补位槽');
  assert.ok(prof.slots.some((s) => s.content.includes('对熟人爱搭话')), '其余模型产出照常保留');
  assert.ok(logs.some((m) => m.includes('仅统计，不拦截')), '★ 日志要说明只统计');
  ok('§4.6-17 题材词只统计：命中照常进画像、计数 + 日志、不触发补位');
}

// ── §4.6-18 命中不丢槽：注入照常带上原文；队列不再因题材词判脏 ──
{
  freshRoot();
  const mk = (id, content, group, updatedAt) => M.makeL1Entry({
    entryId: id, chatKey: K, userId: UID, sourceBatch: batch(), sourceChatKeys: [K],
    content, groups: [group], createdAt: T0, updatedAt
  });
  M.appendPerson(mk('c1', '嘴硬但情绪恢复快，被怼会自嘲两句', '性格特质', T0 + 3));
  M.appendPerson(mk('c2', '对同人内容有明确底线，不拿这类事开玩笑', '性格特质', T0 + 9));
  M.appendPerson(mk('c3', '被劝时先顶两句，冷静后会认', '性格特质', T0 + 5));
  M.appendPerson(mk('s1', '说话短促，爱用波浪号', '说话风格', T0 + 1));

  // 输入顺序按 updatedAt 降序：1=c2(底线) 2=c3 3=c1(自嘲) 4=s1
  const llm = fakeLlm([
    '说话风格｜4｜说话短促，爱用波浪号\n性格特质｜3｜嘴硬但情绪恢复快，被怼会自嘲两句\n'
    + '性格特质｜1｜对凌辱恶堕类有明确底线，反感这类玩笑'
  ]);
  const logs = [];
  const res = await L1.compressProfile(UID, {
    activeEntries: M.activePerson(UID), profile: null, memLlmImpl: llm, now: T0 + 9, log: (m) => logs.push(m)
  });
  assert.equal(res.ok, true);
  assert.equal(res.stats.calls, 1);
  const prof = PR.readProfile(UID);
  const trait = prof.slots.filter((s) => s.dim === '性格特质');
  assert.equal(trait.length, 2, '★ 两条模型产出都在（命中不丢槽）');
  assert.ok(trait.some((s) => s.content.includes('凌辱')), '★ 原文照常落盘');
  assert.equal(prof.stats.sensitiveHits, 1);
  assert.equal(prof.stats.droppedDims, undefined, '★ 不再记录丢槽维（丢槽机制已移除）');
  assert.equal(prof.stats.droppedFilled, undefined, '★ 不再记录丢槽补位');
  assert.ok(logs.some((m) => m.includes('仅统计，不拦截')));

  // 注入端：命中槽照常注入，只计数
  const INJ = await import('../src/mem2/inject.js');
  const items = INJ.resolvePersonItems(UID, M.activePerson(UID), prof);
  assert.equal(items.sensitiveSlots, 1, '★ 读侧命中只计数');
  assert.ok(items.slots.some((s) => s.content.includes('明确底线')), '★ 行为禁区照常进注入');

  // 队列不再因题材词判脏（缺维读时现算 = 0）
  assert.equal(PR.buildProfileQueue().length, 0, '★ 命中题材词不判脏 → 队列 clean');
  ok('§4.6-18 命中不丢槽：原文落盘、注入只计数、队列不因题材词反复烧调用');
}


{
  freshRoot();
  const cand = M.makeCandidateRow({ entryId: 'c9', fromUserId: UID, text: '他说要换工作', ts: T0 });
  assert.deepEqual(Object.keys(cand).sort(), ['entryId', 'fromUserId', 'kind', 'msgId', 'status', 'text', 'ts'],
    '候选行只有七个字段（没有 chatKey）');
  M.appendCandidate(K, cand);

  const llm = fakeLlm(['SKIP']);                    // 判为空 → dropped
  // 85 条才会触发首次提炼（80 条门槛）；40 条要等下一条条件的 stale 分支
  const s = await L1.sweepPeople({ sources: [{ chatKey: K, messages: msgsN(85) }], memLlmImpl: llm });
  assert.equal(s.refined, 1);
  assert.equal(s.added, 0, 'SKIP 不产出');
  assert.equal(M.readCandidates(K).byId.get('c9').status, 'dropped',
    '★ 候选要回写到**原群**并被裁决（pending 必须消解，否则每轮重复喂）');
  assert.equal(fs.existsSync(path.join(P.mem2Dir(), 'group_undefined')), false,
    '★ 不许出现 group_undefined/（说明回写用了不存在的 c.chatKey）');
  ok('§9.1#9 候选回写：七字段无 chatKey、按 _chatKey 回原群、SKIP 记 dropped、无 group_undefined');
}

// ── §16.2 #16 水位必须读**全状态**（superseded 条目也占水位）──
{
  freshRoot();
  const A = 'group:100';
  const msgs = msgsN(85, T0).map((m) => ({ ...m, _chatKey: A }));
  // 这个人在 A 群唯一的画像已被覆盖（superseded）—— active 视图是空的。
  // 若水位误用 active 视图 → wm=0 → 85 条 ≥ 80 阈值 → 整段历史被重炼（不报错、纯烧配额）。
  M.appendPerson(M.makeL1Entry({
    entryId: 'sup_1', chatKey: A, userId: UID,
    sourceBatch: { chatKey: A, userId: UID, startTs: T0, endTs: msgs[msgs.length - 1].ts, msgCount: msgs.length },
    content: '旧印象', groups: ['性格特质'], createdAt: T0, deduped: true
  }));
  M.setPersonStatus(UID, 'sup_1', 'superseded', { nowTs: T0 + 1000 });
  assert.equal(M.activePerson(UID).length, 0, '前置：active 视图为空（只有 superseded 行）');

  const llm = fakeLlm([sup('不该出现的重炼印象')]);
  const stat = await L1.sweepPeople({ sources: [{ chatKey: A, messages: msgs }], now: T0 + 2000, memLlmImpl: llm });
  assert.equal(stat.refined, 0, '★ 全部消息都在水位之下（superseded 条目也占水位）→ 不得重炼');
  assert.equal(stat.callsUsed, 0, '★ 一次调用都不该烧');
  assert.equal(stat.skipped, 1);
  ok('#16 水位读全状态：某群唯一画像被 superseded 后，该群历史不得被当成「从未提炼」重炼');
}

// ── §16.2 #17 去重写回与自愈 ──
{
  freshRoot();
  // 场景：上次 run 掐断在去重之前 —— 条目已落盘（deduped:false），去重没跑成。
  const mk = (entryId, content) => M.makeL1Entry({
    entryId, chatKey: K, userId: UID, sourceBatch: batch({ endTs: T0 + HOUR }),
    content, groups: ['说话风格'], createdAt: T0, deduped: false
  });
  M.appendPerson(mk('crash_1', '爱用波浪号'));
  M.appendPerson(mk('crash_2', '爱用波浪号～（另一种说法）'));

  // 本次 run：批产出 1 条新印象；去重把 3 条并成 2 组（1 组合并 + 1 条单列）
  // —— 坍缩阀要求输出 ≥ scope×0.5，3 条输入至少要 2 组输出。
  const llm = fakeLlm([
    sup('新印象：沉迷钓鱼', '兴趣身份'),
    ['- 1,2 || 爱用波浪号（合并说法） || 说话风格 || -',
      '- 3 || 爱用波浪号～（另一种说法） || 说话风格 || -'].join('\n')
  ]);
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(60), memLlmImpl: llm });
  assert.equal(r.ok, true);
  assert.equal(r.stats.dedupCalls, 1);
  assert.equal(r.collapsed, false, '2 组 ≥ 3×0.5 → 不触发坍缩阀');
  // 去重输入必须包含上次掐断轮留下的条目（自愈的机制所在）
  const dedupInput = llm.calls[1].messages[1].content;
  assert.ok(dedupInput.includes('爱用波浪号'), '★ 上次 run 留下的 deduped:false 条目要被捞进本次去重范围');

  const active = M.activePerson(UID);
  assert.equal(active.length, 2, '★ 3 条并成 2 组 active');
  assert.ok(active.every((e) => e.deduped === true), '合并条必须 deduped:true');
  const view = M.readPerson(UID);
  const rows = view.rows;
  const mi = rows.findIndex((x) => x.entryId === active[0].entryId);
  const si = rows.findIndex((x) => x.entryId === 'crash_1' && x.status === 'superseded');
  assert.ok(mi >= 0 && si > mi, '★ 写回顺序：先 append 合并条、后 supersede 原条目（反了崩在中间会净丢条）');
  // §7.4：单成员组内容不变 → 保留原 entryId 只标 deduped（不算 supersede），
  // 所以被 supersede 的是「本轮产出 + 被并进多成员组的 crash_1」= 2 行。
  assert.equal(rows.filter((x) => x.status === 'superseded').length, 2, '本轮产出 + crash_1 留痕 superseded；crash_2 单列不 supersede');
  assert.equal(view.byId.get('crash_2').deduped, true, '★ 单列未改写的旧条目要标 deduped:true（否则下轮再被捞）');
  ok('#17 去重写回与自愈：掐断轮的 deduped:false 条目下轮被捞回归并；先合并后 supersede（崩溃只重不丢）');
}

// ── §16.5 #18 序号映射：只 supersede 被列出的、合并条取组内最新批次、越界行丢弃 ──
{
  freshRoot();
  // 10 条已落盘、待去重的旧条目（endTs 各不相同 → 可验证「组内最新」）
  const ids = [];
  for (let i = 1; i <= 10; i += 1) {
    const e = M.makeL1Entry({
      entryId: `seed_${String(i).padStart(2, '0')}`,
      chatKey: K, userId: UID,
      sourceBatch: { chatKey: K, userId: UID, startTs: T0 + i * HOUR, endTs: T0 + i * HOUR, msgCount: 100 },
      content: `旧印象${i}`, groups: ['性格特质'], createdAt: T0 + i * HOUR, deduped: false
    });
    M.appendPerson(e);
    ids.push(e.entryId);
  }

  // 7 组覆盖 1~9（覆盖率 90% ≥ 80% 阈值），10 未列出（应标 deduped:true 且保持 active），另加一条越界行
  const llm = fakeLlm([
    'SKIP',
    ['- 1,2 || 合并甲 || 性格特质 || -',
      '- 3,4 || 合并乙 || 性格特质 || -',
      '- 5 || 合并丙 || 性格特质 || -',
      '- 6 || 合并丁 || 性格特质 || -',
      '- 7 || 合并戊 || 性格特质 || -',
      '- 8 || 合并己 || 性格特质 || -',
      '- 9 || 合并庚 || 性格特质 || -',
      '- 99 || 越界该丢 || 性格特质 || -'].join('\n')
  ]);
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(40), memLlmImpl: llm });

  assert.equal(r.ok, true);
  assert.equal(r.collapsed, false, '覆盖率 90% ≥ 80% → 不触发坍缩阀');
  assert.equal(r.stats.badDedupIds, 1, '★ 越界序号整行丢弃并计数（badDedupIds）');
  const view = M.readPerson(UID);
  assert.equal(view.byId.get('seed_01').status, 'superseded', '★ 被列出的原条目才 superseded');
  assert.equal(view.byId.get('seed_05').status, 'active', '§7.4：单成员组改写保留原 entryId、只换内容');
  assert.equal(view.byId.get('seed_05').content, '合并丙', '单成员组的新说法写回原条目');
  assert.equal(r.stats.singleRewritten, 5, '5~9 五个单成员组各改写一条，不算新增');
  assert.equal(view.byId.get('seed_10').status, 'active', '★ 未被列出的条目不许动状态（旧代码一刀切 = 383 条事故）');
  assert.equal(view.byId.get('seed_10').deduped, true, '★ 未列出的条目要标 deduped:true（否则每轮被捞回来重跑）');
  const active = M.activePerson(UID);
  assert.equal(active.length, 8, '2 条合并条 + 5 条原地改写 + 1 条未列出的原条目');
  const merged = active.filter((e) => String(e.entryId).includes('_90'));
  assert.equal(merged.length, 2, '只有两组多成员合并才产出新 entryId');
  const jia = merged.find((e) => e.content === '合并甲');
  assert.equal(jia.sourceBatch.endTs, T0 + 2 * HOUR, '★ 合并条 sourceBatch 取组内 endTs 最大（不是 scope[0]）');
  assert.equal(jia.sourceMsgIds.length, 0, '组内条目都没有 msgIds → 合并条也不造');
  ok('#18 序号映射：只 supersede 被列出的多成员组、单成员组原地改写、未列出的标 deduped:true 保持 active、合并条取组内最新、越界计入 badDedupIds');
}

// ── §16.5 #19 坍缩阀：386 条输入 → 3 条输出 → 零写回 ──
{
  freshRoot();
  for (let i = 1; i <= 386; i += 1) {
    M.appendPerson(M.makeL1Entry({
      entryId: `bulk_${String(i).padStart(3, '0')}`,
      chatKey: K, userId: UID,
      sourceBatch: { chatKey: K, userId: UID, startTs: T0, endTs: T0 + i, msgCount: 100 },
      content: `画像碎片${i}`, groups: ['兴趣身份'], createdAt: T0 + i, deduped: false
    }));
  }
  const logs = [];
  const llm = fakeLlm([
    'SKIP',
    ['- 1,2,3,4,5,6,7,8,9,10 || 三条泛化 || 兴趣身份 || -',
      '- 11,12,13,14,15 || 泛化乙 || 兴趣身份 || -',
      '- 16,17,18,19,20 || 泛化丙 || 兴趣身份 || -'].join('\n')
  ]);
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(40), memLlmImpl: llm, log: (...a) => logs.push(a.join(' ')) });

  assert.equal(r.ok, true);
  assert.equal(r.collapsed, true, '★ 3 < 386×0.5 → 坍缩阀必须触发');
  assert.equal(M.activePerson(UID).length, 386, '★ 零写回：386 条全部保持 active');
  assert.equal(M.readPerson(UID).list.filter((e) => e.status === 'active' && e.deduped === false).length, 386,
    '★ 坍缩时不标 deduped，下轮还要重试');
  assert.equal(M.readPerson(UID).rows.filter((e) => e.status === 'superseded').length, 0, '不许 supersede 任何一条');
  assert.ok(logs.some((l) => l.includes('去重坍缩疑似')), '★ 日志必须留下坍缩告警（scope/输出两个数）');
  assert.equal(r.stats.produced, 386, '终态数 = 386（日志里的 produced 不再撒谎）');
  ok('#19 坍缩阀：386→3 零写回、全部 active+deduped:false、日志含坍缩疑似、produced 报真实值');
}

// ── §16.5 #20 预算内断：调用预算在批边界生效，下 tick 从断点续跑 ──
{
  freshRoot();
  // 550 条 → 6 批；每批必须是不同内容，否则 A2 的批前精确去重会把 3 条同文合成 1 条
  const llm = fakeLlm([sup('印象1'), sup('印象2'), sup('印象3')]);
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(550), callsLeft: 3, memLlmImpl: llm });
  assert.equal(r.ok, true);
  assert.equal(r.aborted, true, '★ 预算不足 → aborted（不是失败）');
  assert.equal(r.stats.calls, 3, '★ 只在批边界停：3 批正好烧 3 次');
  assert.equal(M.activePerson(UID).length, 3, '★ 前 3 批已落盘（水位已推进）');

  // 下 tick 续跑：按水位过滤后只应剩第 4~6 批
  const wm = L1.lastRefinedEndByChat(M.readPerson(UID).list);
  const rest = msgsN(550).filter((m) => (Number(m.ts) || 0) > (wm.get(m._chatKey) || 0));
  assert.equal(rest.length, 250, '★ 断点续跑：只剩后 250 条（第 4~6 批）');
  const llm2 = fakeLlm([
    sup('印象4'), sup('印象5'), sup('印象6'),
    ['- 1 || 印象1 || 性格特质 || -', '- 2 || 印象2 || 性格特质 || -', '- 3 || 印象3 || 性格特质 || -',
      '- 4 || 印象4 || 性格特质 || -', '- 5 || 印象5 || 性格特质 || -', '- 6 || 印象6 || 性格特质 || -'].join('\n')
  ]);
  const r2 = await L1.refine({ userId: UID }, { rawMessages: rest, memLlmImpl: llm2 });
  assert.equal(r2.ok, true);
  assert.ok(!r2.aborted, '续跑这次没触预算，正常跑完');
  assert.equal(M.activePerson(UID).length, 6, '续跑后共 6 条，不重复前 3 批');
  ok('#20 预算内断：callsLeft=3 → 3 批落盘后 aborted；下 tick 从第 4 批续跑，无双份');
}

// ── L1 收敛 §2.6：固定槽调度 / 重试持久化 / 立刻运行（全部假 timerApi，不等真实时间）──
// 旧 #21–#29 是「tickMs 周期锚点」语义，nextRegularAt 恢复断言全部作废，这里整段重写。
{
  const MIN = 60000;
  const at = (day, h, m = 0) => new Date(2026, 10, day, h, m, 0, 0).getTime();
  const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

  /** 假时钟 + 假定时器。fireNext() 把时钟推到最早一个未清除的定时器并触发它。 */
  function makeClock(t0) {
    const clock = { t: t0 };
    const timers = [];
    const timerApi = {
      setTimeout: (fn, ms) => { const h = { fn, ms, at: clock.t + ms, cleared: false }; timers.push(h); return h; },
      clearTimeout: (h) => { if (h) h.cleared = true; }
    };
    const pending = () => timers.filter((h) => !h.cleared).sort((a, b) => a.at - b.at);
    const fireNext = async () => {
      const h = pending()[0];
      if (!h) return null;
      h.cleared = true;
      clock.t = h.at;
      h.fn();
      await flush();
      return h;
    };
    const dropPending = () => { for (const h of pending()) h.cleared = true; };
    return { clock, timers, timerApi, pending, fireNext, dropPending };
  }

  const cfg = (over = {}) => ({
    enabled: true, slots: [0, 6, 12, 18], graceMs: 10 * MIN, maxCallsPerTick: 30, ...over
  });
  const boot = (o) => L1.startL1Daily({ l1cfg: cfg(), log: () => {}, ...o });
  const failing = async () => ({ ok: false, reason: 'call-error' });
  const quotaFail = async () => ({ ok: false, reason: 'quota' });
  const okLlm = () => fakeLlm(['- 一条印象 || 性格特质 || - || -']);
  /** 空群 → runDailySweep 走 quiet tick（零候选零失败），用来单测调度本身。 */
  const quietStore = () => {
    let sweeps = 0;
    return { store: { listChats: () => { sweeps += 1; return []; }, rangeByTs: () => [] }, sweeps: () => sweeps };
  };
  /** 85 条未提炼 → 必触发调用，用来测失败 / 重试。 */
  const busyStore = (base) => ({ listChats: () => [K], rangeByTs: () => msgsN(85, base) });
  const statePathOf = (tag) => path.join(DATA, `case-${caseNo}`, `l1-state-${tag}.json`);
  const putState = (p, obj) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  };
  const getState = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

  // §2.6-1 槽计算纯函数（含 00:00 之前 / 整点 / 23:59 三个边界）
  {
    assert.equal(L1.nextSlotAfter(at(14, 0, 0) - 1), at(14, 0, 0), '00:00 前 → 当天 00:00');
    assert.equal(L1.slotAtOrBefore(at(14, 0, 0) - 1), at(13, 18, 0), '★ 00:00 前 → 前一天 18:00');
    assert.equal(L1.nextSlotAfter(at(14, 6, 5)), at(14, 12, 0), '06:05 → 12:00');
    assert.equal(L1.nextSlotAfter(at(14, 12, 0)), at(14, 18, 0), '★ 整点严格晚于 → 下一槽');
    assert.equal(L1.slotAtOrBefore(at(14, 12, 0)), at(14, 12, 0), '整点算「已开始」');
    assert.equal(L1.nextSlotAfter(at(14, 23, 59)), at(15, 0, 0), '23:59 → 次日 00:00');
    assert.equal(L1.slotAtOrBefore(at(14, 23, 59)), at(14, 18, 0), '23:59 → 当天 18:00');
    assert.deepEqual(L1.normalizeSlots([18, 0, 6, 12, 6]), [0, 6, 12, 18], '去重 + 升序');
    const warns = [];
    assert.deepEqual(L1.normalizeSlots([0, 25], (m) => warns.push(m)), [0, 6, 12, 18], '越界 → 回落默认');
    assert.deepEqual(L1.normalizeSlots([], () => {}), [0, 6, 12, 18], '空 → 回落默认');
    assert.deepEqual(L1.normalizeSlots([1.5], () => {}), [0, 6, 12, 18], '非整数 → 回落默认');
    assert.ok(warns.some((w) => w.includes('slots 非法')), '★ 非法 slots 必须 warn');
    ok('§2.6-1 槽计算：00:00 前 / 06:05 / 12:00 整 / 23:59 四边界 + 非法 slots 回落并 warn');
  }

  // §2.6-2 无状态启动 → 下一槽；状态文件 v2 落盘；启动日志固定格式
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 10, 0));
    const sp = statePathOf('fresh');
    const logs = [];
    const h = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, log: (m) => logs.push(m), statePath: sp });
    assert.equal(h.state().nextRegularAt, at(14, 12, 0), '无状态 → nextSlotAfter(now)');
    assert.equal(c.pending()[0].ms, 2 * HOUR, '定时器 ms = 距下一槽的剩余毫秒');
    assert.equal(getState(sp).v, 2, '★ 状态文件版本 = 2');
    assert.ok(logs.some((l) => l.includes('已启用：固定槽 00/06/12/18，下一轮 11-14 12:00')), '启动日志格式');
    assert.equal(q.sweeps(), 0, '10:00 不在任何槽的宽限期内 → 不补跑');
    h.stop();
    ok('§2.6-2 无状态启动：下一槽 = nextSlotAfter(now)，v2 落盘，启动日志含固定槽');
  }

  // §2.6-3 槽后 5 分钟启动且本槽未扫 → 立即补跑（0–30s 抖动）
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 12, 5));
    const sp = statePathOf('catchup');
    const logs = [];
    const h = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, log: (m) => logs.push(m), statePath: sp });
    assert.ok(logs.some((l) => l.includes('当前槽内补跑（12:00）')), '★ 补跑日志');
    assert.ok(c.pending()[0].ms <= L1.CATCHUP_JITTER_MS, '补跑延迟 ≤ 30s（只有抖动，不再有 60s 固定延迟）');
    await c.fireNext();
    assert.equal(q.sweeps(), 1, '补跑真的跑了一轮');
    assert.equal(h.state().lastSlotTs, at(14, 12, 0), '★ 补跑记的是槽时刻，不是抖动后的时刻');
    assert.equal(h.state().nextRegularAt, at(14, 18, 0), '补跑成功 → 排下一槽');
    h.stop();
    ok('§2.6-3 槽后 5 分钟 + 本槽未扫 → 立即补跑，lastSlotTs = 槽时刻，成功后排下一槽');
  }

  // §2.6-4 槽后 11 分钟（超出宽限）→ 不补跑，等下一槽
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 12, 11));
    const h = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, statePath: statePathOf('late') });
    assert.equal(h.state().nextRegularAt, at(14, 18, 0), '超出 graceMs → 下一槽');
    assert.equal(c.pending()[0].ms, 5 * HOUR + 49 * MIN);
    await flush();
    assert.equal(q.sweeps(), 0, '★ 宽限期外不补跑');
    h.stop();
    ok('§2.6-4 槽后 11 分钟 → 不补跑，直接等 18:00');
  }

  // §2.6-5 槽后 5 分钟但本槽已扫（lastAttemptAt / lastSlotTs >= 本槽）→ 不重复扫
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 12, 5));
    const sp = statePathOf('done');
    putState(sp, { v: 2, lastAttemptAt: at(14, 12, 0), lastSuccessAt: at(14, 12, 1), lastSlotTs: at(14, 12, 0), retryAt: 0, retryCount: 0, retrySlotTs: 0 });
    const h = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, statePath: sp });
    assert.equal(h.state().nextRegularAt, at(14, 18, 0), '本槽已扫 → 下一槽');
    await flush();
    assert.equal(q.sweeps(), 0, '★ 宽限期内重启不重复扫');
    h.stop();
    ok('§2.6-5 槽后 5 分钟但 lastSlotTs 已 >= 本槽 → 不重复扫');
  }

  // §2.6-6 / -8 / -16 / -17 重试恢复：未来 retryAt / 已过 retryAt / retryCount 保留 / 不写 lastSlotTs
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 16, 0));
    const sp = statePathOf('retry');
    putState(sp, { v: 2, lastAttemptAt: at(14, 12, 0), lastSuccessAt: 0, lastSlotTs: at(14, 12, 0), retryAt: at(14, 16, 10), retryCount: 2, retrySlotTs: at(14, 12, 0) });
    const logs = [];
    const h = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, log: (m) => logs.push(m), statePath: sp });
    assert.equal(h.state().nextRegularAt, at(14, 16, 10), '距下一槽 2h → 恢复 retryAt');
    assert.equal(c.pending()[0].ms, 10 * MIN);
    assert.equal(h.state().retryCount, 2, '★ 重启后 retryCount 保留');
    assert.equal(getState(sp).retryAt, at(14, 16, 10), '★ 重试中重启 → retryAt 不变');
    assert.ok(logs.some((l) => l.includes('距下一槽 > 10 分钟') && l.includes('retriedFrom=12:00')), '恢复日志带 retriedFrom');
    await c.fireNext();
    assert.equal(q.sweeps(), 1);
    assert.ok(logs.some((l) => l.includes('重试轮开始 retriedFrom=12:00')), '★ 重试轮日志必须带 retriedFrom=原槽');
    assert.equal(h.state().lastSlotTs, at(14, 12, 0), '★ 重试轮不写 lastSlotTs');
    assert.equal(h.state().nextRegularAt, at(14, 18, 0), '★ 重试成功 → 定时器回到固定槽，不停在 retryAt');
    assert.equal(h.state().retryCount, 0);
    h.stop();

    // retryAt 已过 → 立即跑（带抖动），slotTs 仍取 retrySlotTs
    const c2 = makeClock(at(14, 16, 0));
    const sp2 = statePathOf('retry-past');
    putState(sp2, { v: 2, lastAttemptAt: at(14, 12, 0), lastSuccessAt: 0, lastSlotTs: at(14, 12, 0), retryAt: at(14, 15, 50), retryCount: 1, retrySlotTs: at(14, 12, 0) });
    const logs2 = [];
    const h2 = boot({ store: q.store, now: () => c2.clock.t, memLlmImpl: okLlm(), timerApi: c2.timerApi, log: (m) => logs2.push(m), statePath: sp2 });
    assert.ok(logs2.some((l) => l.includes('立即恢复')), '过期 retryAt → 立即恢复');
    assert.ok(c2.pending()[0].ms <= L1.CATCHUP_JITTER_MS, '立即跑只带 0–30s 抖动');
    await c2.fireNext();
    assert.equal(h2.state().lastSlotTs, at(14, 12, 0), '★ 恢复的重试轮同样不写 lastSlotTs');
    h2.stop();
    ok('§2.6-6/8/16/17 重试恢复：未来/过期都对，retryCount 跨重启保留，重试不写 lastSlotTs，成功后回固定槽');
  }

  // §2.6-7 重试点与固定槽重叠（距下一槽 ≤ graceMs，或 retryAt >= nextSlot）→ 丢重试
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 17, 55));
    const sp = statePathOf('overlap');
    putState(sp, { v: 2, lastAttemptAt: at(14, 12, 0), lastSuccessAt: 0, lastSlotTs: at(14, 12, 0), retryAt: at(14, 17, 58), retryCount: 3, retrySlotTs: at(14, 12, 0) });
    const logs = [];
    const h = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, log: (m) => logs.push(m), statePath: sp });
    assert.ok(logs.some((l) => l.includes('重试点与固定槽重叠，并入 18:00 槽')), '★ 重叠日志');
    assert.equal(h.state().nextRegularAt, at(14, 18, 0));
    assert.equal(h.state().retryCount, 0, '丢弃重试 → 三个字段全清零');
    assert.equal(h.state().retryAt, 0);
    assert.equal(h.state().retrySlotTs, 0);
    assert.equal(getState(sp).retryCount, 0, '★ 清零必须落盘');
    h.stop();

    const c2 = makeClock(at(14, 16, 0));
    const sp2 = statePathOf('overlap2');
    putState(sp2, { v: 2, lastAttemptAt: 0, lastSuccessAt: 0, lastSlotTs: at(14, 12, 0), retryAt: at(14, 18, 0), retryCount: 1, retrySlotTs: at(14, 12, 0) });
    const h2 = boot({ store: q.store, now: () => c2.clock.t, memLlmImpl: okLlm(), timerApi: c2.timerApi, statePath: sp2 });
    assert.equal(h2.state().retryAt, 0, 'retryAt >= nextSlot 同样丢弃');
    assert.equal(h2.state().nextRegularAt, at(14, 18, 0));
    h2.stop();
    ok('§2.6-7 重试点撞固定槽（≤graceMs 或 >=nextSlot）→ 丢重试、清零落盘、等槽');
  }

  // §2.6-9 / -10 / -16 网络类失败 → 10 分钟重试；lastSuccessAt 不更新；成功后更新
  {
    freshRoot();
    const c = makeClock(at(14, 12, 0));
    const sp = statePathOf('fail');
    let impl = failing;
    const logs = [];
    const h = boot({
      store: busyStore(at(14, 10, 0)), now: () => c.clock.t, memLlmImpl: (...a) => impl(...a),
      timerApi: c.timerApi, log: (m) => logs.push(m), statePath: sp
    });
    c.dropPending();
    await h.tick({ source: 'scheduled', slotTs: at(14, 12, 0) });
    const s1 = h.state();
    assert.equal(s1.retryCount, 1, '网络类失败 → 第 1 次重试');
    assert.equal(s1.retryAt, at(14, 12, 10), '★ retryAt = now + 10min');
    assert.equal(s1.retrySlotTs, at(14, 12, 0), 'retrySlotTs = 触发失败的原槽');
    assert.equal(s1.lastSlotTs, at(14, 12, 0));
    assert.equal(s1.lastSuccessAt, 0, '★ 失败（refined=0/added=0）→ lastSuccessAt 不更新');
    assert.equal(getState(sp).retryAt, at(14, 12, 10), '★ 重试状态跨重启保留（已落盘）');
    assert.equal(c.pending()[0].at, at(14, 12, 10), '定时器排在 retryAt');

    impl = okLlm();
    c.clock.t = at(14, 12, 10);
    await h.tick({ source: 'retry', slotTs: s1.retrySlotTs });
    const s2 = h.state();
    assert.equal(s2.lastSuccessAt, at(14, 12, 10), '★ 重试成功 → lastSuccessAt 更新');
    assert.equal(s2.lastSlotTs, at(14, 12, 0), '★ 重试轮 lastSlotTs 保持不变');
    assert.equal(s2.retryCount, 0);
    assert.equal(s2.retryAt, 0);
    assert.equal(s2.nextRegularAt, at(14, 18, 0), '★ 重试成功把定时器拉回固定槽');
    assert.equal(c.pending()[0].at, at(14, 18, 0));
    assert.ok(logs.some((l) => l.includes('疑似网络故障') && l.includes('retriedFrom=12:00')), '失败日志带 retriedFrom');
    h.stop();

    // 成功后重启 → 无重试状态，直接等下一槽
    const c3 = makeClock(at(14, 12, 20));
    const h3 = boot({ store: busyStore(at(14, 10, 0)), now: () => c3.clock.t, memLlmImpl: okLlm(), timerApi: c3.timerApi, statePath: sp });
    assert.equal(h3.state().retryAt, 0, '★ 成功后重启 → 无重试');
    assert.equal(h3.state().retryCount, 0);
    assert.equal(h3.state().nextRegularAt, at(14, 18, 0));
    assert.equal(h3.state().lastSlotTs, at(14, 12, 0), 'lastSlotTs 跨重启保留');
    h3.stop();
    ok('§2.6-9/10/16 失败→10 分钟重试且 lastSuccessAt 不动；重试成功→更新 lastSuccessAt、回固定槽');
  }

  // §2.6-10（配额分支）配额类失败一次都不重试
  // 注：按 §2.4-4 的判定式，allNonQuota=false → 不算 failure（quiet），lastSuccessAt 会推进。
  {
    freshRoot();
    const c = makeClock(at(14, 12, 0));
    const h = boot({ store: busyStore(at(14, 10, 0)), now: () => c.clock.t, memLlmImpl: quotaFail, timerApi: c.timerApi, statePath: statePathOf('quota') });
    c.dropPending();
    await h.tick({ source: 'scheduled', slotTs: at(14, 12, 0) });
    assert.equal(h.state().retryCount, 0, '★ 配额类失败不重试（当日预算用完，重试纯烧日志）');
    assert.equal(h.state().retryAt, 0);
    assert.equal(h.state().nextRegularAt, at(14, 18, 0), '配额失败直接排下一槽');
    h.stop();
    ok('§2.6-10 配额类失败：不建立重试，直接排下一槽');
  }

  // §2.6-11 定时器触发时 running=true → 跳过本槽 + **本轮结束后补跑**，setTimeout 链不断
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 10, 0));
    const logs = [];
    const h = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, log: (m) => logs.push(m), statePath: statePathOf('busy') });
    const r = h.runNow();                       // 同步置锁
    assert.equal(r.started, true);
    const t = c.pending()[0];                   // 12:00 的固定槽定时器
    t.cleared = true;
    c.clock.t = t.at;
    t.fn();                                     // 锁还没释放就触发 → busy
    await flush(20);
    assert.ok(logs.some((l) => l.includes('上一轮未结束，跳过 12:00 槽')), '★ 跳过日志');
    // ★ 2026-11-17 复核补：跳过不等于丢掉。手动轮一结束就要补跑这一槽，
    //   否则 12:00 的提炼永远不发生（旧实现只重排定时器，静默丢一槽）。
    assert.ok(logs.some((l) => l.includes('补跑被跳过的 12:00 槽')), '★ 必须补跑被跳过的槽');
    assert.equal(h.state().lastSlotTs, at(14, 12, 0), '★ 补跑把 lastSlotTs 记成被跳过的槽时刻');
    assert.equal(q.sweeps(), 2, '手动轮 + 补跑 = 2 轮');
    assert.equal(c.pending().length, 1, '★ 链没断：仍有一个待触发定时器');
    assert.equal(c.pending()[0].at, at(14, 18, 0), '重排到下一槽');
    h.stop();
    ok('§2.6-11 定时器触发时忙 → 跳过本槽、本轮结束后补跑、链不断（不静默丢槽）');
  }

  // §2.6-12 runNow()：忙 → busy；空闲 → started 且 nextRegularAt 不变；并发点两下不双跑
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 10, 0));
    const h = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, statePath: statePathOf('runnow') });
    const before = h.state().nextRegularAt;
    const r1 = h.runNow();
    assert.equal(r1.started, true);
    assert.equal(r1.nextRegularAt, before);
    const r2 = h.runNow();                      // 同步锁：微任务还没跑，第二次必须 busy
    assert.deepEqual(r2, { started: false, busy: true }, '★ 绝不能先返回再置锁');
    await flush();
    assert.equal(q.sweeps(), 1, '只跑了一轮');
    assert.equal(h.state().nextRegularAt, before, '★ 手动轮不动固定槽定时器');
    assert.equal(h.state().retryCount, 0, '手动轮不建立重试');
    assert.ok(h.state().lastAttemptAt > 0);
    assert.equal(c.pending()[0].at, before, '固定槽定时器还在原位');
    const r3 = h.runNow();
    assert.equal(r3.started, true, '跑完后可以再点');
    await flush();
    assert.equal(q.sweeps(), 2);
    h.stop();
    ok('§2.6-12 runNow：忙→busy、空闲→started、nextRegularAt 不变、并发不双跑');
  }

  // §2.6-13 同一 statePath 反复 start/stop 不产生双扫
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 12, 5));
    const sp = statePathOf('restart');
    const h1 = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, statePath: sp });
    assert.equal(c.pending().length, 1);
    h1.stop();
    assert.equal(c.pending().length, 0, 'stop 必须清掉定时器');
    const h2 = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, statePath: sp });
    assert.equal(c.pending().length, 1, '★ 重启后只有一个待触发定时器');
    await c.fireNext();
    assert.equal(q.sweeps(), 1);
    h2.stop();
    c.clock.t = at(14, 12, 6);
    const h3 = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, statePath: sp });
    assert.equal(h3.state().nextRegularAt, at(14, 18, 0), '本槽已扫 → 不再补跑');
    await flush();
    assert.equal(q.sweeps(), 1, '★ 反复 start/stop 不双扫');
    h3.stop();
    ok('§2.6-13 同一 statePath 反复 start/stop：只有一个定时器、本槽只扫一次');
  }

  // §2.6-14 05:55 失败 → retryAt 撞上 06:00 槽 → 不排重试，直接等槽
  {
    freshRoot();
    const c = makeClock(at(14, 5, 55));
    const logs = [];
    const h = boot({ store: busyStore(at(14, 4, 0)), now: () => c.clock.t, memLlmImpl: failing, timerApi: c.timerApi, log: (m) => logs.push(m), statePath: statePathOf('edge') });
    c.dropPending();
    await h.tick({ source: 'scheduled', slotTs: at(14, 0, 0) });
    assert.ok(logs.some((l) => l.includes('重试点与固定槽重叠，并入 06:00 槽')), '★ 边界日志');
    assert.equal(h.state().retryAt, 0, 'min(now+10min, nextSlot) == nextSlot → 不排重试');
    assert.equal(h.state().retryCount, 0);
    assert.equal(h.state().nextRegularAt, at(14, 6, 0));
    assert.equal(c.pending()[0].at, at(14, 6, 0));
    h.stop();
    ok('§2.6-14 05:55 失败：重试点 ≥ 下一槽 → 取消重试直接等 06:00');
  }

  // §2.6-15 空轮（零候选零失败）算成功（quiet tick）
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 10, 0));
    const h = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, statePath: statePathOf('quiet') });
    c.dropPending();
    await h.tick({ source: 'scheduled', slotTs: at(14, 6, 0) });
    assert.equal(h.state().lastSuccessAt, at(14, 10, 0), '★ 空轮也更新 lastSuccessAt');
    assert.equal(h.state().retryCount, 0);
    assert.equal(h.state().nextRegularAt, at(14, 12, 0));
    h.stop();
    ok('§2.6-15 空轮 = 成功：lastSuccessAt 更新、不重试、排下一槽');
  }

  // 连续 6 次失败 → 第 7 次放弃本窗口，等下一槽（旧 #23 的固定槽版）
  {
    freshRoot();
    const c = makeClock(at(14, 0, 0));
    const h = boot({ store: busyStore(at(13, 22, 0)), now: () => c.clock.t, memLlmImpl: failing, timerApi: c.timerApi, statePath: statePathOf('cap') });
    c.dropPending();
    let slotTs = at(14, 0, 0);
    for (let i = 0; i < 7; i += 1) {
      await h.tick({ source: i === 0 ? 'scheduled' : 'retry', slotTs });
      if (i < 6) {
        assert.equal(h.state().retryCount, i + 1, `第 ${i + 1} 次失败 → retryCount=${i + 1}`);
        assert.equal(h.state().retrySlotTs, at(14, 0, 0), '★ 重试轮的原槽一路不变');
        c.clock.t = h.state().retryAt;
        slotTs = h.state().retrySlotTs;
      }
    }
    assert.equal(h.state().retryCount, 0, '第 7 次放弃 → 清零');
    assert.equal(h.state().retryAt, 0);
    assert.equal(h.state().nextRegularAt, at(14, 6, 0), '★ 放弃本窗口 → 等下一固定槽');
    h.stop();
    ok('重试上限：6 次 10 分钟重试后第 7 次放弃，原槽不变，回固定槽');
  }

  // 配置容错：未启用 / tickMs 废弃 / 非法 slots / 负 graceMs / v1 升级 / 坏 JSON
  {
    freshRoot();
    const q = quietStore();
    const c = makeClock(at(14, 10, 0));
    const sp = statePathOf('misc');
    assert.equal(boot({ store: q.store, l1cfg: { enabled: false }, now: () => c.clock.t, timerApi: c.timerApi, statePath: sp }), null, '未启用 → null');
    assert.equal(fs.existsSync(sp), false, '★ 未启用不读不写状态');

    const logs = [];
    const h1 = boot({ store: q.store, l1cfg: cfg({ tickMs: 6 * HOUR }), now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, log: (m) => logs.push(m), statePath: sp });
    assert.ok(logs.some((l) => l.includes('tickMs 已废弃，调度改为固定槽 00/06/12/18')), '★ tickMs 废弃 warn');
    assert.equal(h1.state().nextRegularAt, at(14, 12, 0), 'tickMs 被忽略，仍按固定槽');
    h1.stop();
    const logs2 = [];
    const h2 = boot({ store: q.store, l1cfg: cfg({ tickMs: 6 * HOUR, slots: [0, 25], graceMs: -5 }), now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, log: (m) => logs2.push(m), statePath: sp });
    assert.equal(logs2.filter((l) => l.includes('tickMs 已废弃')).length, 0, '★ 废弃 warn 只打一次');
    assert.deepEqual(h2.state().slots, [0, 6, 12, 18], '非法 slots → 默认');
    assert.equal(h2.state().graceMs, 0, '★ graceMs < 0 → 0');
    assert.ok(logs2.some((l) => l.includes('slots 非法')));
    h2.stop();

    // v1 → v2：retries 映射 retryCount，nextRegularAt 丢弃
    putState(sp, { v: 1, lastAttemptAt: at(14, 6, 0), lastSuccessAt: at(14, 6, 1), nextRegularAt: at(14, 23, 0), retries: 2 });
    const logs3 = [];
    const h3 = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, log: (m) => logs3.push(m), statePath: sp });
    assert.ok(logs3.some((l) => l.includes('旧状态已升级：nextRegularAt 不再作为锚点')), '★ v1 升级日志');
    assert.equal(h3.state().retryCount, 2, 'retries → retryCount');
    assert.equal(h3.state().lastSuccessAt, at(14, 6, 1), 'lastSuccessAt 保留');
    assert.equal(h3.state().nextRegularAt, at(14, 12, 0), '★ 旧 nextRegularAt 不再当锚点');
    assert.equal(getState(sp).v, 2);
    h3.stop();

    // 坏 JSON → 不抛，按无状态处理
    fs.writeFileSync(sp, '{ bad json !!!', 'utf8');
    const logs4 = [];
    let threw = false;
    try {
      const h4 = boot({ store: q.store, now: () => c.clock.t, memLlmImpl: okLlm(), timerApi: c.timerApi, log: (m) => logs4.push(m), statePath: sp });
      assert.equal(h4.state().nextRegularAt, at(14, 12, 0), '坏文件 → 无状态 → 下一槽');
      assert.equal(h4.state().retryCount, 0);
      h4.stop();
    } catch { threw = true; }
    assert.equal(threw, false, '★ 坏 JSON 不许抛异常');
    assert.ok(logs4.some((l) => l.includes('状态文件损坏')), '坏文件要 warn 一行');
    ok('配置容错：未启用 null / tickMs 只 warn 一次 / 非法 slots / 负 graceMs / v1 升级 / 坏 JSON');
  }
}

// ── §16.5 ⑤ 展示截断：>60 条时更早只留编号、单条 40 字截断、去重仍覆盖全部 ──
{
  freshRoot();
  const longText = '很长'.repeat(30);
  // 展示上限 60、每批补充上限 3 条 → 要累积到 >60 条展示至少 21 批：2200 条消息 = 22 批 × 3 条
  const BATCHES = 22;
  const contents = [];
  for (let b = 0; b < BATCHES; b += 1) {
    for (let i = 1; i <= 3; i += 1) contents.push(`印象条目${b * 3 + i} ${longText}`);
  }
  const llm = fakeLlm([
    ...Array.from({ length: BATCHES }, (_, b) => contents.slice(b * 3, b * 3 + 3).map((c) => sup(c)).join('\n')),
    // 去重按 60 条一片切 → 66 条要两次回复（片内序号各自从 1 起）
    contents.slice(0, 60).map((c, i) => `- ${i + 1} || ${c} || 性格特质 || -`).join('\n'),
    contents.slice(60).map((c, i) => `- ${i + 1} || ${c} || 性格特质 || -`).join('\n')
  ]);
  const r = await L1.refine({ userId: UID }, { rawMessages: msgsN(BATCHES * 100), memLlmImpl: llm });
  assert.equal(r.ok, true);
  const pLast = llm.calls[BATCHES - 1].messages[1].content;   // 最后一批的 user prompt
  assert.ok(pLast.includes('内容已略'), '★ 超过 60 条时更早的只保留条数');
  assert.ok(!pLast.includes('印象条目1 '), '★ 第 1 条内容不再出现（否则每批都背全部历史，token 线性膨胀）');
  assert.ok(pLast.includes('印象条目63'), '最近 60 条仍给全文');
  assert.ok(pLast.includes('…'), '★ 单条 content 超 40 字截断展示');
  // ★ 截断只影响展示：66 条原始碎片必须全部进过去重并被裁决（不是被丢弃、也不是没喂）
  const activeNow = M.activePerson(UID);
  assert.equal(r.stats.produced, activeNow.length, 'produced 以盘上 active 为准');
  assert.equal(activeNow.length, 66, '★ 66 条全部进过去重范围（截断只是展示层）');
  assert.ok(activeNow.every((e) => e.deduped === true), '去重后全部标 deduped');
  ok('§16.5 ⑤ 展示截断：>60 条只留条数、40 字截断、去重仍覆盖全部 66 条');
}

// ── §16.6 ⑨ 确定性去重：content 字符串完全相同不需要模型判断 ──
{
  // (a) 单元层：留最新、出处并集、其余 supersede
  freshRoot();
  const mkDup = (entryId, createdAt, msgIds, chatKeys) => M.makeL1Entry({
    entryId, chatKey: K, userId: UID, content: '爱用波浪号，一句话要飘一下',
    groups: ['说话风格'], status: 'active', deduped: true, createdAt,
    sourceMsgIds: msgIds, sourceChatKeys: chatKeys,
    sourceBatch: batch({ startTs: createdAt, endTs: createdAt })
  });
  M.appendPerson(mkDup('dup_a', T0 - 2000, ['m1'], [K]));
  M.appendPerson(mkDup('dup_b', T0 - 1000, ['m2'], ['group:999']));
  M.appendPerson(mkDup('dup_c', T0, [], []));                 // 最新，但没有出处
  M.appendPerson(M.makeL1Entry({                              // 对照组：内容不同，绝不能被吞
    entryId: 'dup_other', chatKey: K, userId: UID, content: '爱玩手游',
    groups: ['兴趣身份'], status: 'active', deduped: true, createdAt: T0,
    sourceBatch: batch()
  }));

  const ex = L1.collapseExactDuplicates(UID, { now: T0 + 1000 });
  assert.equal(ex.groups, 1, '只应识别出 1 组完全重复');
  assert.equal(ex.superseded, 2, '★ 同组留 1 条、其余 2 条 supersede（零调用）');
  const after = M.activePerson(UID);
  assert.equal(after.length, 2, '★ 一条重复组 + 一条不同内容的 → active 只剩 2 条');
  const keep = after.find((e) => e.content.includes('波浪号'));
  assert.equal(keep.entryId, 'dup_c', '★ 留最新那条（createdAt 最大）');
  assert.deepEqual(keep.sourceMsgIds.sort(), ['m1', 'm2'], '★ 并掉重复不许把出处一起丢掉');
  assert.deepEqual(keep.sourceChatKeys, [K, 'group:999'].sort(), '来源群也要并集');
  assert.equal(keep.status, 'active', '留下的那条状态不变');

  // (b) 流程层：分片归并的片边界各产一条同内容 → ⑨ 收掉，且不多一次调用
  freshRoot();
  const list = Array.from({ length: 70 }, (_, i) => M.makeL1Entry({
    entryId: `sd_${String(i + 1).padStart(2, '0')}`, chatKey: K, userId: UID,
    content: `第 ${i + 1} 条`, groups: ['性格特质'], status: 'active', deduped: false,
    sourceBatch: batch({ startTs: T0 + i * 60000, endTs: T0 + i * 60000 })
  }));
  for (const e of list) M.appendPerson(e);

  let dedupCalls = 0;
  const sameLlm = async (kind, { messages } = {}) => {
    dedupCalls += 1;
    const text = String(messages?.[1]?.content || '');
    // 把这一片的序号全部列进同一个组（覆盖率 100%），内容故意全片相同 → 片间必然撞车
    const idxs = [...text.matchAll(/^(\d+)\. /gm)].map((m) => m[1]);
    return { ok: true, result: { message: { content: `- ${idxs.join(',')} || 分片边界留下的重复 || 性格特质 || -` } } };
  };
  const d = await L1.runDedup({ userId: UID, scope: M.activePerson(UID), now: T0 + HOUR, memLlmImpl: sameLlm, log: () => {} });

  assert.equal(d.ok, true);
  assert.equal(d.collapsed, false, '输出覆盖了全部输入 → 不该触发坍缩阀');
  assert.equal(dedupCalls, 2, '★ 70 条切 2 片 = 2 次调用；⑨ 不许额外加调用');
  assert.equal(d.exactSuperseded, 1, '★ 片边界的两条同内容被确定性去重收掉 1 条');
  assert.equal(M.activePerson(UID).length, 1, '★ 终态 active = 1（内容相同的都归到一条）');
  assert.equal(d.produced, 1, 'produced 以盘上 active 为准');
  ok('#24 确定性去重：content 完全相同零调用收掉（留最新、出处并集），不额外发调用');
}

// ── #8（第 5 期）pinned 免疫：两处去重都不许动用户改过的条目 ──
//
// 硬约束 13：UI 编辑写入 `pinnedByUser:true`。若去重不排除它：
//   · runDedup 会按语义把它并掉/被并掉；
//   · collapseExactDuplicates（⑨，零调用、按 content 完全相同直接合并）更狠，
//     用户刚改的措辞只要和另一条一样就当场被吃。
// 两种都是**静默**的：编辑变成一次性，日志里什么都不会出现。
{
  freshRoot();
  const mk = (id, content, extra = {}) => M.makeL1Entry({
    entryId: id, chatKey: K, userId: UID, content, groups: ['性格特质'],
    status: 'active', deduped: false, sourceBatch: batch({ startTs: T0 }), ...extra
  });

  // ① ⑨ 确定性去重：两条内容完全相同，其中一条 pinned
  M.appendPerson(mk('pin_a', '喜欢安静地看别人聊天', { pinnedByUser: true }));
  M.appendPerson(mk('pin_b', '喜欢安静地看别人聊天'));
  const ex = L1.collapseExactDuplicates(UID, { now: T0 + 1000 });

  const after = M.activePerson(UID);
  const pinned = after.find((e) => e.entryId === 'pin_a');
  assert.ok(pinned, '★ pinned 条目不许被 ⑨ 合并掉');
  assert.equal(pinned.status, 'active');
  assert.equal(ex.superseded, 0, '★ 分组里只有 1 条（pinned 被排除）→ 没有任何条目被 supersede');
  assert.equal(after.length, 2, '两条都还在：pinned 不动，非 pinned 也不该被它吞掉');

  // ② runDedup 的 scope：pinned 的 deduped 即使还是 false，也不该进 scope
  const scopeAll = M.activePerson(UID).filter((e) => e.pinnedByUser !== true);
  const d = await L1.runDedup({ userId: UID, scope: scopeAll, now: T0 + HOUR, memLlmImpl: async () => ({ ok: true, result: { message: { content: '' } } }), log: () => {} });
  assert.equal(M.activePerson(UID).find((e) => e.entryId === 'pin_a').status, 'active',
    '★ 跑完一轮去重后 pinned 仍是 active');
  assert.equal(M.readPerson(UID).list.filter((e) => e.entryId === 'pin_a').at(-1).pinnedByUser, true);
  ok('#8 pinned 免疫：⑨ 不合并、runDedup 不动，用户改过的条目不会被下一轮静默吞掉');
}

// ── L1 收敛 §5.4 解析器：三种 op / 补充 3 条 / 总 12 行 / 坏 op 与旧格式拒收 / 候选只收补充 ──
{
  const p1 = L1.parseRefineOutput([
    '- || 爱用波浪号 || 说话风格 || #1,#2',
    'R3 || 他已经退坑了 || 兴趣身份 || -',
    'M2 || 脾气好，但最近话少 || 性格特质 || #5'
  ].join('\n'));
  assert.equal(p1.skip, false);
  assert.deepEqual(p1.items.map((x) => [x.op, x.replace]),
    [['supplement', 0], ['replace', 3], ['merge', 2]], '★ 三种 op 都解析对');
  assert.deepEqual(p1.items[0].msgIds, ['#1', '#2'], 'msgIds 原样带出（回填真 mid 在后面）');
  assert.equal(p1.overflow, 0);
  assert.equal(p1.badOp, 0);

  const p2 = L1.parseRefineOutput(Array.from({ length: 4 }, (_, i) => sup(`第${i + 1}条`)).join('\n'));
  assert.equal(p2.items.length, 3, '★ 补充上限 3 条');
  assert.equal(p2.overflow, 1);
  assert.equal(p2.overflowLines[0].reason, 'overflow-supplement');

  const p3 = L1.parseRefineOutput([
    ...Array.from({ length: 3 }, (_, i) => sup(`补充${i + 1}`)),
    ...Array.from({ length: 12 }, (_, i) => `R${i + 1} || 替换${i + 1} || 性格特质 || -`)
  ].join('\n'));
  assert.equal(p3.items.length, 12, '★ 总上限 12 条（R/M 不占补充名额）');
  assert.equal(p3.overflow, 3);
  assert.equal(p3.badOp, 0);

  const p4 = L1.parseRefineOutput([
    'X1 || 未知 op || 性格特质 || -',
    'R0 || 零号 || 性格特质 || -',
    '他爱钓鱼 || 兴趣身份 || 1 || R1'          // 旧三段格式：首段是正文
  ].join('\n'));
  assert.equal(p4.items.length, 0, '坏行一条都不落');
  assert.equal(p4.badOp, 3, '★ 未知 op / R0 / 旧格式全部计 badOp');

  const p5 = L1.parseRefineOutput([
    '- || 该记 || 性格特质 || -',
    'R3 || 不许 || 兴趣身份 || -',
    'M2 || 也不许 || 说话风格 || -'
  ].join('\n'), { onlySupplement: true });
  assert.equal(p5.items.length, 1);
  assert.equal(p5.badOp, 2, '★ 候选没有槽位上下文，R/M 必然指错 → 整行丢弃');

  // SKIP 判定收紧：整段恰好 SKIP 才算；SKIP 换行加解释不算
  assert.equal(L1.parseRefineOutput('  skip  ').skip, true, '不区分大小写 + trim');
  assert.equal(L1.parseRefineOutput('SKIP\n（解释）').skip, false, '★ 不是整段恰好 SKIP → 不跳过');
  const p7 = L1.parseRefineOutput(['SKIP', sup('正文里的 SKIP 行只当无效行')].join('\n'));
  assert.equal(p7.skip, false);
  assert.equal(p7.items.length, 1, '正文中间出现 SKIP 不影响其余条目');
  ok('§5.4-1~4/11 解析器：三种 op、补充 3、总 12、坏 op/旧格式拒收、候选只收补充、SKIP 收紧');
}

// ── §5.4-2 溢出必须可见：stats + 日志 + l1-overflow.jsonl 审计行 ──
{
  freshRoot();
  const responses = [];
  const llm = fakeLlm([Array.from({ length: 4 }, (_, i) => sup(`补充 ${i + 1}`)).join('\n')]);
  const r = await L1.refine({ userId: UID }, {
    rawMessages: msgsN(85), memLlmImpl: llm, callsLeft: 1, log: (...a) => responses.push(a.join(' '))
  });
  assert.equal(r.stats.added, 3, '落 3 条');
  assert.equal(r.stats.overflow, 1, 'stats.overflow 可见');
  assert.ok(responses.some((l) => l.includes('解析溢出') && l.includes('overflow=1')), '日志必须写溢出条数');
  const audit = lines(P.l1OverflowFile()).map((l) => JSON.parse(l));
  assert.equal(audit.length, 1, '★ 审计文件 l1-overflow.jsonl 落 1 行');
  assert.equal(audit[0].reason, 'overflow-supplement');
  assert.equal(audit[0].uid, UID);
  assert.equal(audit[0].batch.chatKey, K);
  ok('§5.4-2 补充 4 → 落 3 条，overflow=1，日志 + 审计文件各留痕 1 处');
}

// ── §5.4-8/9 system 只喂 8 条画像 + pinned 只读区；无 profile 用兜底槽位 ──
{
  freshRoot();
  const dims = ['说话风格', '性格特质', '兴趣身份', '关系态度'];
  for (let i = 1; i <= 30; i += 1) {
    M.appendPerson(M.makeL1Entry({
      entryId: `act_${String(i).padStart(2, '0')}`, chatKey: K, userId: UID,
      sourceBatch: batch({ endTs: T0 + i * 60000 }),
      content: `active 条目${i}`, groups: [dims[i % 4]], createdAt: T0 + i, updatedAt: T0 + i
    }));
  }
  M.appendPerson(M.makeL1Entry({
    entryId: 'act_pin', chatKey: K, userId: UID, sourceBatch: batch(),
    content: '用户钉住：别写他真名', groups: ['关系态度'], pinnedByUser: true, createdAt: T0
  }));
  PR.writeProfile(UID, {
    v: 1, uid: UID, builtAt: T0, model: 'test', stats: {},
    sourceDigest: PR.computeDigest(M.activePerson(UID)),
    slots: Array.from({ length: 8 }, (_, i) => ({
      dim: dims[i % 4], content: `画像槽${i + 1}`, sourceEntryIds: [`act_${String(i + 1).padStart(2, '0')}`], chars: 4
    }))
  });

  const llm = fakeLlm(['SKIP']);
  await L1.refine({ userId: UID }, { rawMessages: msgsN(85), memLlmImpl: llm, now: T0 + 3 * HOUR });
  const system = llm.calls[0].messages[0].content;
  for (let i = 1; i <= 8; i += 1) assert.ok(system.includes(`画像槽${i}`), `8 个槽都在：${i}`);
  assert.ok(system.includes('9. [只读][关系态度] 用户钉住：别写他真名'), '★ pinned 只读区编号 M+1 并标注只读');
  assert.ok(system.includes('不得引用'), '提示词写明钉住条目不得引用');
  assert.ok(!system.includes('active 条目9') && !system.includes('active 条目30'),
    '★ 30 条 active 不许整份喂进 system（只喂 8 条画像）');

  // 无 profile → 确定性兜底槽位，不抛；R1 正常覆盖兜底槽位的来源
  const e2 = (uid) => {
    const msgs = msgsN(85);
    return msgs;
  };
  freshRoot();
  const srcA = M.makeL1Entry({
    entryId: 'fb_1', chatKey: K, userId: UID, sourceBatch: batch(),
    content: '爱用波浪号', groups: ['说话风格'], createdAt: T0, updatedAt: T0
  });
  M.appendPerson(srcA);
  const llm2 = fakeLlm([`R1 || 爱用波浪号但更收敛 || 说话风格 || -`]);
  const r2 = await L1.refine({ userId: UID }, { rawMessages: e2(UID), memLlmImpl: llm2, now: T0 + 3 * HOUR });
  assert.equal(r2.ok, true, '无 profile 也不抛');
  assert.equal(r2.stats.profileFallback, true, '★ 无 profile 时标脏（本轮后压缩会重建）');
  assert.equal(M.readPerson(UID).byId.get('fb_1').status, 'superseded', 'R1 覆盖兜底槽位的来源');
  ok('§5.4-8/9 system 只含 8 槽 + pinned 只读；无 profile 走兜底槽位、失败不抛');
}

// ── §5.4-10 日扫日志带溢出/画像字段 ──
{
  freshRoot();
  const store = { listChats: () => [K], rangeByTs: () => msgsN(85) };
  const logs = [];
  const llm = fakeLlm([
    Array.from({ length: 3 }, (_, i) => sup(`印象 ${i + 1}`)).join('\n') + `\n${sup('第四条溢出', '兴趣身份')}`,
    ['- 1 || 印象 1 || 性格特质 || -', '- 2 || 印象 2 || 性格特质 || -', '- 3 || 印象 3 || 性格特质 || -'].join('\n'),
    profLine('性格特质', '1', '这个人平时话不多，但一开口就很有条理，属于慢热型')
  ]);
  const total = await L1.runDailySweep({ store, now: T0 + 5 * HOUR, memLlmImpl: llm, log: (m) => logs.push(m) });
  assert.equal(total.overflow, 1);
  const line = logs.find((l) => l.includes('日扫完成')) || '';
  assert.ok(line.includes('溢出=1'), '★ 日扫日志必须带 溢出=');
  assert.ok(line.includes('画像=') && line.includes('覆盖'), '★ 日扫日志必须带画像/覆盖字段');
  assert.ok(line.includes('token余='), '★ 日扫日志必须带 token 余量（否则「压缩被预算挤掉」只能猜）');
  ok('§5.4-10 日扫日志：溢出/坏op/解析0条/画像/覆盖/token余 全都可见');
}

// ── §7.1 扫描游标：SKIP / 空输出才推进；解析 0 条、失败、预算 abort 都不推进 ──
{
  freshRoot();
  const msgs = msgsN(85);
  const endTs = msgs[msgs.length - 1].ts;
  const r1 = await L1.refine({ userId: UID }, { rawMessages: msgs, memLlmImpl: fakeLlm(['SKIP']), now: T0 + 3 * HOUR });
  assert.equal(r1.ok, true);
  assert.equal(L1.readScanCursor()[UID][K], endTs, '★ SKIP → 游标推进到 batch.endTs');
  assert.equal(L1.effectiveWatermarks(M.readPerson(UID).list, L1.readScanCursor()[UID]).get(K), endTs,
    '有效水位 = max(条目水位, 游标)');
  // 下一轮同一批消息 → 不再提炼（unrefined 为空）
  const s2 = await L1.sweepPeople({
    sources: [{ chatKey: K, messages: msgs }], now: T0 + 4 * HOUR, memLlmImpl: fakeLlm(['SKIP'])
  });
  assert.equal(s2.refined, 0, '★ 游标推进后同一批不会被重炼');
  assert.equal(s2.callsUsed, 0, '零调用');

  // 重启：游标落盘可重读（JSON 结构 v1）
  const raw = JSON.parse(fs.readFileSync(P.l1ScanFile(), 'utf8'));
  assert.equal(raw.v, 1);
  assert.equal(raw.cursor[UID][K], endTs, '★ 重启后游标仍在');

  // 空输出 → 同样推进
  freshRoot();
  const msgs2 = msgsN(85);
  await L1.refine({ userId: UID }, { rawMessages: msgs2, memLlmImpl: fakeLlm(['   ']), now: T0 + 3 * HOUR });
  assert.equal(L1.readScanCursor()[UID][K], msgs2[msgs2.length - 1].ts, '空输出 = 无可提炼 → 推进');

  // 非空但解析 0 条 → 不动 + zeroParsed
  freshRoot();
  const msgs3 = msgsN(85);
  const logs3 = [];
  const r3 = await L1.refine({ userId: UID }, {
    rawMessages: msgs3, memLlmImpl: fakeLlm(['这不是任何合法行']), now: T0 + 3 * HOUR,
    log: (m) => logs3.push(m)
  });
  assert.equal(r3.stats.zeroParsed, 1, '★ zeroParsed 计数 +1');
  assert.equal(L1.readScanCursor()[UID], undefined, '★ 解析 0 条 → 游标不动（下槽重发）');
  assert.ok(logs3.some((l) => l.includes('游标不动')), '日志要明说「下槽重发」');

  // 调用失败 → 不动
  const failLlm = async () => ({ ok: false, reason: 'call-error' });
  await L1.refine({ userId: UID }, { rawMessages: msgs3, memLlmImpl: failLlm, now: T0 + 4 * HOUR });
  assert.equal(L1.readScanCursor()[UID], undefined, '★ 调用失败 → 游标不动');

  // 'SKIP\n（解释）' 不整段跳过 → 按非空原文处理（0 条 → 不动）
  const r4 = await L1.refine({ userId: UID }, {
    rawMessages: msgs3, memLlmImpl: fakeLlm(['SKIP\n（没有新信息）']), now: T0 + 5 * HOUR
  });
  assert.equal(r4.stats.zeroParsed, 1, '★ 不是整段恰好 SKIP → 记 zeroParsed');
  assert.equal(L1.readScanCursor()[UID], undefined, '游标仍不动');

  // 游标与条目水位取最大；缺群仍 0
  const e = M.makeL1Entry({
    entryId: 'wm_1', chatKey: K, userId: UID, sourceBatch: batch({ endTs: T0 + 5 * HOUR }),
    content: '水位更靠后', groups: ['性格特质'], createdAt: T0
  });
  const wm = L1.effectiveWatermarks([e], { [K]: T0 + 2 * HOUR });
  assert.equal(wm.get(K), T0 + 5 * HOUR, '★ max(游标, 条目水位)');
  assert.equal(L1.oldestWatermark(['group:没有'], wm), 0, '两边都没有 → 0（不会把整段历史吞掉）');
  ok('§7.1 扫描游标：SKIP/空输出推进，解析0条/失败/解释型SKIP 不动，重启仍在，水位取最大值');
}

// ── §7.2/7.3 候选兜底：endTs 用候选 ts、按群分组归因 ──
{
  freshRoot();
  const A = 'group:A';
  const B = 'group:B';
  const now = T0 + 6 * HOUR;
  const candA = { entryId: 'cA', fromUserId: UID, text: '他换了工作', ts: T0, _chatKey: A };
  const candB = { entryId: 'cB', fromUserId: UID, text: '他养了猫', ts: T0 + HOUR, _chatKey: B };
  const ctxA = [{ mid: 'x1', ts: T0 + 2 * HOUR, text: '候选之后的新消息', senderName: '甲' }];
  const llm = fakeLlm([
    '- || 他换了工作 || 兴趣身份 || -',
    '- || 他养了猫 || 兴趣身份 || -'
  ]);
  const r = await L1.refineCandidates(
    { userId: UID, chatKeys: [A, B] },
    {
      candidates: [candA, candB],
      contextByCandidate: new Map([['cA', ctxA]]),
      memLlmImpl: llm, now, log: () => {}
    }
  );
  assert.equal(r.ok, true);
  assert.equal(r.stats.added, 2);
  assert.equal(llm.calls.length, 2, '★ 按群分组：A 群一次、B 群一次');
  const list = M.readPerson(UID).list;
  const job = list.find((x) => x.content === '他换了工作');
  const cat = list.find((x) => x.content === '他养了猫');
  assert.equal(job.sourceBatch.chatKey, A, '★ 归因到 A 群');
  assert.deepEqual(job.sourceChatKeys, [A], 'sourceChatKeys 只写本群');
  assert.equal(job.sourceBatch.endTs, T0, '★ endTs = 候选 ts（不是上下文 ts、更不是 now）');
  assert.equal(job.sourceBatch.startTs, T0, 'startTs = min(上下文 ts, 候选 ts)');
  assert.equal(job.sourceBatch.msgCount, 1, 'msgCount = 本组候选数');
  assert.equal(cat.sourceBatch.chatKey, B, '★ 归因到 B 群，不出现「都记到 A」');
  assert.equal(cat.sourceBatch.endTs, T0 + HOUR);
  // 候选 ts 之后、上下文 ts 之前的消息，下一轮仍算未提炼
  const wm = L1.effectiveWatermarks(list, {});
  assert.ok(T0 + 30 * 60000 > (wm.get(A) || 0), '★ 1–2 小时之间的消息没被水位越过');
  ok('§7.2/7.3 候选兜底：endTs=候选 ts、按群分组各一次调用、sourceChatKeys 只写本群');
}

// ── §7.4 单条去重保留原 entryId：不变 / 改写 / 下轮不再捞回 / 多成员组照旧合并 ──
{
  freshRoot();
  const mk = (entryId, content) => M.makeL1Entry({
    entryId, chatKey: K, userId: UID, sourceBatch: batch({ endTs: T0 }),
    content, groups: ['性格特质'], createdAt: T0, deduped: false
  });
  M.appendPerson(mk('s1', '爱用波浪号'));
  M.appendPerson(mk('s2', '喜欢钓鱼'));
  M.appendPerson(mk('m1', '爱喝奶茶'));
  M.appendPerson(mk('m2', '爱喝奶茶，只喝三分糖'));
  const llm = fakeLlm([
    ['- 1 || 爱用波浪号 || 性格特质 || -',
      '- 2 || 喜欢钓鱼，周末常去 || 性格特质 || -',
      '- 3,4 || 爱喝奶茶 || 兴趣身份 || -'].join('\n')
  ]);
  const scope = M.readPerson(UID).list.filter((e) => e.status === 'active' && e.deduped === false);
  const r = await L1.runDedup({ userId: UID, scope, now: T0 + HOUR, memLlmImpl: llm, log: () => {} });
  assert.equal(r.ok, true);
  const byId = M.readPerson(UID).byId;
  assert.equal(byId.get('s1').entryId, 's1', '单条不变：entryId 不变');
  assert.equal(byId.get('s1').content, '爱用波浪号', '内容不变');
  assert.equal(byId.get('s1').deduped, true, '★ 不变也标 deduped，下轮不再捞');
  assert.equal(byId.get('s2').entryId, 's2', '单条改写：entryId 不变');
  assert.equal(byId.get('s2').content, '喜欢钓鱼，周末常去', '★ 改写用原 entryId append 新版本');
  assert.equal(byId.get('m1').status, 'superseded', '多成员组照旧 supersede');
  assert.equal(byId.get('m2').status, 'superseded');
  const activeNow = M.activePerson(UID);
  assert.equal(activeNow.length, 3, '★ 单条组不改变 active 条数（2 单条 + 1 合并）');
  assert.equal(r.singleRewritten, 1, '只计 s2 这一条改写');
  assert.ok(activeNow.some((e) => e.content === '爱喝奶茶'), '合并产物落盘');
  const again = M.readPerson(UID).list.filter((e) => e.status === 'active' && e.deduped === false);
  assert.equal(again.length, 0, '★ 下一轮去重范围为空（不会把已评估的条目捞回来）');
  ok('§7.4 单条去重：不变/改写都保留原 entryId，active 条数不变，下轮不再捞回，多成员组照旧');
}

// ── A2 确定性去重必须在预算闸门前：零调用也能收历史重复 ──
{
  freshRoot();
  const mk = (id, content, createdAt) => M.makeL1Entry({
    entryId: id, chatKey: K, userId: UID, sourceBatch: batch(),
    content, groups: ['性格特质'], createdAt, deduped: false
  });
  M.appendPerson(mk('dup_old', '同一句完全重复', T0));
  M.appendPerson(mk('dup_new', '同一句完全重复', T0 + 1000));
  const llm = fakeLlm([sup('绝不该调用')]);
  const r = await L1.refine({ userId: UID }, { rawMessages: [], callsLeft: 0, memLlmImpl: llm, now: T0 + 2000 });
  assert.equal(r.reason, 'too-few-messages');
  assert.equal(llm.calls.length, 0, '★ callsLeft=0 且没有新消息时，确定性去重仍零调用');
  assert.equal(r.stats.exactSuperseded, 1);
  assert.equal(r.stats.superseded, 1, '★ exact 的 supersede 必须并入 stats.superseded');
  assert.equal(M.activePerson(UID).length, 1, '★ 历史完全重复被收掉');
  assert.equal(M.activePerson(UID)[0].entryId, 'dup_new', '留最新那条');
  assert.equal(M.readPerson(UID).byId.get('dup_old').status, 'superseded');
  assert.equal(r.stats.produced, 1);

  const r2 = await L1.refine({ userId: UID }, { rawMessages: [], callsLeft: 0, memLlmImpl: llm, now: T0 + 3000 });
  assert.equal(r2.stats.exactSuperseded, 0, '★ 再跑幂等，不再减少');
  assert.equal(M.activePerson(UID).length, 1);
  ok('A2-1 零调用精确去重：callsLeft=0/无新消息也合并历史重复，幂等');
}

// ── A2 scope 重建：已被 exact collapse supersede 的条目不许送进模型 ──
{
  freshRoot();
  const mk = (id, content) => M.makeL1Entry({
    entryId: id, chatKey: K, userId: UID, sourceBatch: batch(),
    content, groups: ['性格特质'], createdAt: T0, deduped: false
  });
  M.appendPerson(mk('hist_dup_a', '历史重复句'));
  M.appendPerson(mk('hist_dup_b', '历史重复句'));
  M.appendPerson(mk('hist_unique', '历史独特句'));
  const dedupReply = [
    '- 1 || 本轮新句 || 性格特质 || -',
    '- 2 || 历史重复句 || 性格特质 || -',
    '- 3 || 历史独特句 || 性格特质 || -'
  ].join('\n');
  const llm = fakeLlm([sup('本轮新句'), dedupReply]);
  const r = await L1.refine({ userId: UID }, {
    rawMessages: msgsN(35), callsLeft: 2, memLlmImpl: llm, now: T0 + HOUR
  });
  assert.equal(r.ok, true);
  assert.equal(r.stats.scope, 3, '★ scope = 新条 + 历史去重后的 1 条 + 历史独特 1 条');
  assert.equal(llm.calls.length, 2);
  const dedupInput = llm.calls[1].messages[1].content;
  assert.equal((dedupInput.match(/历史重复句/g) || []).length, 1,
    '★ 已被 supersede 的重复条不许出现在模型 scope 里');
  assert.equal(r.stats.exactSuperseded, 1);
  assert.equal(r.stats.superseded, 1, '★ exact 的 supersede 必须并入 stats.superseded');
  ok('A2-2 scope 干净：精确去重后重建 scope，模型看不到已 supersede 的条目');
}

// ── A2 调用失败也要先做精确去重 ──
{
  freshRoot();
  const mk = (id, content) => M.makeL1Entry({
    entryId: id, chatKey: K, userId: UID, sourceBatch: batch(),
    content, groups: ['性格特质'], createdAt: T0, deduped: false
  });
  M.appendPerson(mk('fail_dup_a', '调用失败前的重复'));
  M.appendPerson(mk('fail_dup_b', '调用失败前的重复'));
  const r = await L1.refine({ userId: UID }, {
    rawMessages: msgsN(35), memLlmImpl: async () => ({ ok: false, reason: 'call-error' }), now: T0 + HOUR
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'call-error');
  assert.equal(r.stats.exactSuperseded, 1, '★ 模型调用失败不影响已经完成的精确去重');
  assert.equal(r.stats.superseded, 1, '★ exact 的 supersede 必须并入 stats.superseded');
  assert.equal(M.activePerson(UID).length, 1);
  ok('A2-3 失败兜底：调用失败时 exact collapse 仍已执行');
}

// ── A3 提示词两条硬约束 ──
{
  assert.ok(L1.REFINE_PROMPT.includes('【已有画像】为空（M=0）时'),
    '★ M=0 时必须禁止 R/M');
  assert.ok(L1.REFINE_PROMPT.includes('不要输出第 4 条 supplement'),
    '★ 补充超过 3 条必须自行合并/取舍');
  ok('A3 提示词：M=0 禁 R/M、补充硬上限 3');
}

// ── L1-2026-11-18-01 阶段A：提示词只做澄清，动态槽位行只进 refine() ──
{
  assert.ok(L1.REFINE_PROMPT.includes('最多 8 条'), '★ 提示词不能再暗示固定 8 条槽位');
  assert.ok(L1.REFINE_PROMPT.includes('第 4 段是消息行号'), '★ 提示词必须写明第 4 段是消息行号');

  // 无槽位：M=0 禁令必须进 system
  freshRoot();
  const llm0 = fakeLlm(['SKIP']);
  await L1.refine({ userId: UID }, { rawMessages: msgsN(85), memLlmImpl: llm0 });
  const sys0 = llm0.calls[0].messages[0].content;
  assert.ok(sys0.includes('M=0'), '★ 无槽位时 system 必须写 M=0');
  assert.ok(sys0.includes('禁止输出 R/M'), 'M=0 时禁止输出 R/M');
  assert.ok(sys0.includes('第 4 段是消息行号'), 'M=0 时也要讲清两套编号');

  // 8 槽 + 1 条 pinned 只读：M=8、1..8、钉住区 9..9、来源 pinned 提示都要在
  freshRoot();
  const existing8 = Array.from({ length: 8 }, (_, i) => mkSlot(i + 1, `槽${i + 1}`, '性格特质', [`src_${i + 1}`]));
  existing8.push(mkSlot(9, '用户钉住：别写真名', '关系态度', ['pin_1'], { readOnly: true }));
  const llm8 = fakeLlm(['SKIP']);
  await L1.refine({ userId: UID }, { rawMessages: msgsN(85), existing: existing8, memLlmImpl: llm8 });
  const sys8 = llm8.calls[0].messages[0].content;
  assert.ok(sys8.includes('M=8'), '★ 8 槽时 system 必须写 M=8');
  assert.ok(sys8.includes('1..8'), '8 槽时写明 1..8');
  assert.ok(sys8.includes('来源含用户钉住的仍会被忽略'), '★ 动态行不能承诺 1..8 都可安全引用');
  assert.ok(sys8.includes('钉住只读区 9..9 不得引用'), 'pinned 区单独分区');

  // 候选兜底：onlySupplement 路径不该看到 R/M 槽位规则
  const llmC = fakeLlm(['- || 他换了工作 || 兴趣身份 || -']);
  await L1.refineCandidates({ userId: UID }, {
    candidates: [{ entryId: 'c_slot', fromUserId: UID, text: 'x', ts: T0, _chatKey: K }],
    memLlmImpl: llmC, now: T0
  });
  const sysC = llmC.calls[0].messages[0].content;
  assert.ok(!sysC.includes('【槽位编号】'), '★ 候选兜底 system 不许出现动态槽位行');
  ok('阶段A 提示词：最多 8 条、第 4 段是消息行号、M=0/M=8 动态行、候选 system 不带槽位行');
}

// ── A4 昵称控制字符：名字清洗、正文不动、日志/prompt 干净 ──
{
  freshRoot();
  const dirty = '45（工作\u0000\u0012中\u0005）';
  const msgs30 = Array.from({ length: 30 }, (_, i) => ({
    ...mkMsg(T0 + i * 60000, `正文${i}\u0000保留`), senderName: dirty
  }));
  const people = L1.collectPeople(msgs30, { minMsgs: 1 });
  assert.equal(people[0].nickname, '45（工作中）', '★ 昵称 C0 被清掉');
  assert.ok(!/[\u0000-\u001F]/.test(people[0].messages[0].senderName), '消息 senderName 也清');
  assert.ok(people[0].messages[0].text.includes('\u0000'), '★ 正文里的控制字符不改');

  const across = L1.collectPeopleAcrossChats([{ chatKey: K, messages: msgs30 }])[0];
  assert.equal(across.nickname, '45（工作中）');
  assert.ok(!/[\u0000-\u001F]/.test(across.messages[0].senderName));

  const llm = fakeLlm(['- || 他换了工作 || 兴趣身份 || -']);
  await L1.refineCandidates({ userId: UID }, {
    candidates: [{ entryId: 'c_ctrl', fromUserId: UID, text: 'x', ts: T0, _chatKey: K }],
    contextByCandidate: new Map([['c_ctrl', [{ mid: 'm1', ts: T0, text: '上下文正文', senderName: dirty }]]]),
    memLlmImpl: llm, now: T0
  });
  const prompt = llm.calls[0].messages[1].content;
  assert.ok(!prompt.includes('\u0000') && !prompt.includes('\u0012') && !prompt.includes('\u0005'),
    '★ 候选上下文 speaker 不含 C0（提示词本身的换行不算）');

  const logs = [];
  await L1.sweepPeople({
    sources: [{ chatKey: K, messages: msgsN(150).map((m) => ({ ...m, senderName: dirty })) }],
    maxCalls: 1, memLlmImpl: fakeLlm([sup('日志用')]), log: (m) => logs.push(m), now: T0
  });
  assert.ok(logs.some((l) => l.includes('45（工作中）')), '日志里的昵称已清洗');
  assert.ok(logs.every((l) => !/[\u0000-\u001F]/.test(l)), '★ 日志不再出现 C0');
  ok('A4 昵称控制字符：昵称/日志/prompt speaker 清 C0，正文不动');
}

// ── A5 aborted 汇总字段：只加观测，不改 refined/failed ──
{
  freshRoot();
  const s = await L1.sweepPeople({
    sources: [{ chatKey: K, messages: msgsN(150) }],
    maxCalls: 1, memLlmImpl: fakeLlm([sup('印象1'), sup('印象2')]), now: T0
  });
  assert.equal(s.refined, 0, '★ aborted 不计 refined');
  assert.equal(s.failed, 0, '★ aborted 不计 failed');
  assert.equal(s.abortedPeople, 1);
  assert.equal(s.abortedAdded, 1);
  assert.equal(s.abortedCalls, 1);
  assert.equal(s.budgetHit, true);

  freshRoot();
  const logs = [];
  const total = await L1.runDailySweep({
    store: { listChats: () => [K], rangeByTs: () => msgsN(150) },
    maxCalls: 1, memLlmImpl: fakeLlm([sup('印象1'), sup('印象2')]),
    log: (m) => logs.push(m), now: T0
  });
  assert.equal(total.refined, 0);
  assert.equal(total.abortedPeople, 1);
  const line = logs.find((l) => l.includes('日扫完成')) || '';
  assert.ok(line.includes('中断=1/新增1/调用1'), '★ 汇总行必须带 aborted 三段');
  ok('A5 aborted 汇总：abortedPeople/abortedAdded/abortedCalls 入 stats 和日志，refined/failed 不变');
}

// 清理
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── mem2-l1：${passed} 项通过`);
