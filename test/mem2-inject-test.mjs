// 第 3 期 · 注入（L1 画像装配）的单测。
//
// 这一层只做「读」：把 L1 画像拼成提示词的一个段落，并按配额裁剪。
// 守的是三件最容易做错的事：
//   · digests 自造哈希 → 启用那一刻旧摘要全「消失」→ 强制全量重建
//   · 槽位/兜底不确定 → 同一输入两轮输出不同 → 前缀缓存每轮归零
//   · 注入路径写盘 → 「注入 ≠ 召回」这条设计直接破掉
//
// 覆盖施工单 §9.1 的 #1–#15。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentDigest } from '../src/mem2/digest.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-mem2-inject-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const P = await import('../src/mem2/paths.js');
const M = await import('../src/mem2/store.js');
const I = await import('../src/mem2/inject.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

let caseNo = 0;
function freshRoot() {
  caseNo += 1;
  P.setMem2Root(path.join(DATA, `case-${caseNo}`));
  return P.mem2Dir();
}

const K = 'group:900001';
const T0 = new Date(2026, 10, 14, 10, 0, 0).getTime();

const batch = (over = {}) => ({
  chatKey: K, userId: '1', startTs: T0, endTs: T0 + 3600 * 1000, msgCount: 50, ...over
});

const mkEntry = (uid, entryId, content, groups, over = {}) => M.makeL1Entry({
  entryId, chatKey: K, userId: uid, content, groups,
  status: 'active', deduped: true, sourceBatch: batch({ userId: uid }), ...over
});

// ── §3.7-1/2/6/9/14 选条：profile 槽位 2/2/2/2、不足不补、兜底确定性 ──
{
  const PR = await import('../src/mem2/profile.js');
  const uid = '555';
  const mkSlots = (perDim) => {
    const out = [];
    for (const dim of I.PROFILE_DIMS) {
      for (let i = 0; i < (perDim[dim] ?? 0); i += 1) {
        out.push({ dim, content: `${dim}第${i + 1}条`, sourceEntryIds: [`e_${dim}_${i}`], chars: 8 });
      }
    }
    return out;
  };
  const activeOf = (slots) => slots.map((s) => mkEntry(uid, s.sourceEntryIds[0], s.content, [s.dim]));

  // 1) 8 槽 → 原样 8 条，维序固定
  const full = mkSlots({ 说话风格: 2, 关系态度: 2, 性格特质: 2, 兴趣身份: 2 });
  const r1 = I.resolvePersonItems(uid, activeOf(full), { slots: full });
  assert.equal(r1.slots.length, 8, '★ 每人正好 8 条');
  assert.deepEqual(r1.slots.map((s) => s.dim),
    ['说话风格', '说话风格', '关系态度', '关系态度', '性格特质', '性格特质', '兴趣身份', '兴趣身份'],
    '★ 维序固定：说话风格 → 关系态度 → 性格特质 → 兴趣身份');
  assert.equal(r1.usedFallback, false);

  // 2) 只有 5 槽 → 原样 5 条，不补通用套话
  const five = mkSlots({ 说话风格: 2, 关系态度: 2, 性格特质: 1, 兴趣身份: 0 });
  const r2 = I.resolvePersonItems(uid, activeOf(five), { slots: five });
  assert.equal(r2.slots.length, 5, '★ 不足 8 条照实注入，不补');
  // 6) 兴趣身份 0 条 → 不借风格名额
  assert.equal(r2.slots.filter((s) => s.dim === '说话风格').length, 2, '★ 兴趣 0 条不借风格名额');
  assert.equal(r2.slots.filter((s) => s.dim === '兴趣身份').length, 0);

  // 9) 无 profile → 确定性兜底 2/2/2/2（排除 pinned）
  const entries = [];
  for (let i = 0; i < 5; i += 1) entries.push(mkEntry(uid, `s${i}`, `风格${i}`, ['说话风格'], { createdAt: T0 + i, updatedAt: T0 + i }));
  for (let i = 0; i < 5; i += 1) entries.push(mkEntry(uid, `r${i}`, `关系${i}`, ['关系态度'], { createdAt: T0 + i, updatedAt: T0 + i }));
  for (let i = 0; i < 5; i += 1) entries.push(mkEntry(uid, `p${i}`, `性格${i}`, ['性格特质'], { createdAt: T0 + i, updatedAt: T0 + i }));
  for (let i = 0; i < 5; i += 1) entries.push(mkEntry(uid, `i${i}`, `兴趣${i}`, ['兴趣身份'], { createdAt: T0 + i, updatedAt: T0 + i * 1000 }));
  entries.push(mkEntry(uid, 'pin1', '用户钉住的话', ['说话风格'], { pinnedByUser: true }));
  const fb = I.resolvePersonItems(uid, entries, null);
  assert.equal(fb.usedFallback, true, '★ 无 profile 走兜底并留痕');
  assert.equal(fb.slots.length, 8, '★ 兜底也是 2/2/2/2');
  assert.ok(!fb.slots.some((s) => s.content === '用户钉住的话'), '★ 兜底排除 pinned（pinned 单独注入）');
  assert.equal(fb.pinned.length, 1);
  assert.deepEqual(fb.slots.filter((s) => s.dim === '说话风格').map((s) => s.content), ['风格0', '风格1'],
    '★ 风格按 createdAt 升序');
  assert.deepEqual(fb.slots.filter((s) => s.dim === '兴趣身份').map((s) => s.content), ['兴趣4', '兴趣3'],
    '★ 兴趣按 updatedAt 降序');

  // 14) 兜底确定性：并列 entryId 升序，两次调用逐字节相同
  const tie = [
    mkEntry(uid, 'b2', '兴趣乙', ['兴趣身份'], { createdAt: T0, updatedAt: T0 }),
    mkEntry(uid, 'a1', '兴趣甲', ['兴趣身份'], { createdAt: T0, updatedAt: T0 })
  ];
  const t1 = I.resolvePersonItems(uid, tie, null);
  const t2 = I.resolvePersonItems(uid, tie, null);
  assert.equal(JSON.stringify(t1), JSON.stringify(t2), '★ 同一输入两次输出逐字节相同');
  assert.deepEqual(t1.slots.map((s) => s.content), ['兴趣甲', '兴趣乙'], '★ 并列按 entryId 升序');
  assert.equal(PR.fallbackItems(tie).length, 2, '兜底函数与 inject 用的是同一份');

  // 8) 非 active 不注入（superseded 不进 active，也不进兜底）
  const root = freshRoot();
  M.appendPerson(mkEntry('777', 'a1', '仍然成立', ['性格特质']));
  M.appendPerson(mkEntry('777', 'a2', '已被推翻', ['性格特质']));
  M.setPersonStatus('777', 'a2', 'superseded');
  const adapter = I.createInjectAdapter({ peopleStore: null, cfg: {}, now: () => T0 });
  const snap = adapter.promptSnapshot(K, { userIds: ['777'] });
  assert.ok(snap.text.includes('仍然成立'));
  assert.ok(!snap.text.includes('已被推翻'), '★ status≠active 的条目绝不注入');
  assert.equal(snap.members['u:777'].impressions.length, 1, 'members 里也只算 active 的');
  assert.ok(root);
  ok('§3.7-1/2/6/8/9/14 选条：8 槽维序固定、不足不补、不借名额、兜底 2/2/2/2 且确定性');
}

// ── §3.7-8/15 槽位来源校验：来源死光 → 槽消失；全死 → 兜底；冲突条永不注入 ──
{
  const uid = '606';
  const slots = [
    { dim: '说话风格', content: '爱用波浪号', sourceEntryIds: ['dead1'] },
    { dim: '兴趣身份', content: '沉迷钓鱼', sourceEntryIds: ['live1'] }
  ];
  const active = [mkEntry(uid, 'live1', '沉迷钓鱼', ['兴趣身份'])];
  const r = I.resolvePersonItems(uid, active, { slots });
  assert.equal(r.slots.length, 1, '★ 来源全死的槽不注入（防彻底删除后旧画像复活）');
  assert.equal(r.slots[0].content, '沉迷钓鱼');
  assert.equal(r.usedFallback, false, '还有活槽就不走兜底');

  // 全部槽都失效但 active 非空 → 兜底，绝不「有 active 却零注入」
  const r2 = I.resolvePersonItems(uid, active, { slots: [slots[0]] });
  assert.equal(r2.usedFallback, true);
  assert.equal(r2.slots.length, 1);
  assert.equal(r2.slots[0].content, '沉迷钓鱼');

  // 坏 profile（slots 不是数组）→ 兜底，不抛
  const r3 = I.resolvePersonItems(uid, active, { slots: 'oops' });
  assert.equal(r3.usedFallback, true);

  // active 只有 pinned → 兜底为空、pinned 仍单独注入
  const onlyPin = [mkEntry(uid, 'p1', '钉住的话', ['说话风格'], { pinnedByUser: true })];
  const r4 = I.resolvePersonItems(uid, onlyPin, null);
  assert.equal(r4.slots.length, 0);
  assert.equal(r4.pinned.length, 1);

  // 15) conflicted / pending-conflict 都不注入
  freshRoot();
  M.appendPerson(mkEntry('607', 'c1', '正常条', ['性格特质']));
  M.appendPerson(mkEntry('607', 'c2', '冲突中', ['性格特质'], { status: 'conflicted' }));
  M.appendPerson(mkEntry('607', 'c3', '待裁决', ['性格特质'], { status: 'pending-conflict' }));
  const adapter = I.createInjectAdapter({ peopleStore: null, cfg: {}, now: () => T0 });
  const snap = adapter.promptSnapshot(K, { userIds: ['607'] });
  assert.ok(snap.text.includes('正常条'));
  assert.ok(!snap.text.includes('冲突中') && !snap.text.includes('待裁决'), '★ 冲突条永不注入');
  ok('§3.7-8/15 来源校验：死槽消失、全死走兜底、只有 pinned 时兜底为空、冲突条不注入');
}

// ── #9 #10 #14 promptSnapshot 的接口形状（快照机制的全部依赖）──
{
  freshRoot();
  // #9 无数据 → 空对象，不抛错
  const adapter = I.createInjectAdapter({ peopleStore: null, cfg: { interestTopN: 5 }, now: () => T0 });
  assert.deepEqual(adapter.promptSnapshot(K, { userIds: [] }), { text: '', members: {}, userIds: [] });
  const empty = adapter.promptSnapshot(K, { userIds: ['999999'] });
  assert.equal(empty.text, '', '★ 没有画像的人 → 空文本（不许输出只有标题的空段）');
  assert.deepEqual(empty.members, {});
  assert.equal(adapter.formatForPrompt(K, { userIds: ['999999'] }), empty.text, 'formatForPrompt = promptSnapshot().text');

  // #10 digests 非空、与 impressions 等长、key 是 u:<uid>
  M.appendPerson(mkEntry('888', 'k1', '说话极简短', ['说话风格']));
  M.appendPerson(mkEntry('888', 'k2', '爱玩手游', ['兴趣身份']));
  M.appendPerson(mkEntry('889', 'k3', '爱用波浪号', ['说话风格']));
  const snap = adapter.promptSnapshot(K, { userIds: ['888', '889'] });
  assert.ok(snap.text.startsWith(I.L1_HEADER), '★ text 第一行必须是固定引导语（稳定段，字节不能随数据变）');
  assert.ok(snap.text.includes('涉及性、身体、私密关系的内容只用于理解这个人，不主动提及、不据此调侃对方'),
    '★ 敏感内容的表达层护栏：只用于理解、不主动提及、不据此调侃（§16.7 裁决）');
  assert.ok(snap.text.includes('具体事件和计划不要主动提'), '原有的「具体事件不主动提」不能被新子句挤掉');
  assert.ok(snap.text.includes('- 888：说话极简短'), '缺昵称时退回 QQ 号，不能是空名字');
  assert.deepEqual(Object.keys(snap.members).sort(), ['u:888', 'u:889'], '★ members 的 key 必须是 u:<uid>');
  for (const [key, m] of Object.entries(snap.members)) {
    assert.ok(Array.isArray(m.digests) && m.digests.length > 0, `★ ${key}.digests 不能为空（空了快照每轮重建）`);
    assert.equal(m.digests.length, m.impressions.length, '★ digests 与 impressions 必须等长（下标对得上）');
    assert.ok(m.impressions.every((x) => typeof x === 'string' && x.length));
  }
  assert.deepEqual(snap.userIds.sort(), ['888', '889']);

  // #14 digest 与历史摘要算法同源（golden 锁定，★ 不许自造哈希）
  const expect = contentDigest('说话极简短');
  assert.equal(expect, '6235da20240d7a39', '★ digest 算法冻结（sha1 前 16 位）');
  assert.equal(snap.members['u:888'].digests[snap.members['u:888'].impressions.indexOf('说话极简短')], expect,
    '★ digest 必须等于冻结算法（换算法 = 启用瞬间全部旧摘要消失）');
  assert.ok(/^[0-9a-f]{16}$/.test(expect), 'contentDigest 是 sha1 前 16 位');
  ok('#9/#10/#14 promptSnapshot：空数据优雅返回、digests 非空等长、与历史摘要算法同源');
}

// ── #11 注入过程零写入 ──
{
  freshRoot();
  // 注入器只接受「读」依赖；这里把读依赖换成桩，并统计是否有任何写入口被触碰
  const adapter = I.createInjectAdapter({
    peopleStore: { activeMembers: () => [{ userId: '1', name: '甲' }], recent: () => [] },
    cfg: { interestTopN: 5 }, now: () => T0,
    readL1: () => [mkEntry('1', 'z1', '爱玩手游', ['兴趣身份'])]
  });
  const count = () => fs.readdirSync(DATA, { recursive: true }).length;
  const before = count();
  const s1 = adapter.promptSnapshot(K, { userIds: ['1'] });
  const s2 = adapter.formatForPrompt(K, { userIds: ['1'] });
  const after = count();
  assert.ok(s1.text.includes('爱玩手游') && s2 === s1.text, '注入确实产出了内容（不是空跑）');
  assert.equal(after, before, '★ 注入过程零写入：目录条目数不变（注入 ≠ 召回）');
  ok('#11 零写入：promptSnapshot/formatForPrompt 都不落盘');
}

// ── §3.7-3/4/5/12 选人：lastTs 降序取 5、受保护无条件保留、渲染按 uid 升序 ──
{
  const slot = (uid, i) => ({ dim: I.PROFILE_DIMS[i % 4], content: `${uid}印象${i}`, sourceEntryIds: [`e${uid}_${i}`] });
  const person = (uid, n = 2) => ({ uid, name: uid, slots: Array.from({ length: n }, (_, i) => slot(uid, i)), pinned: [] });
  const persons = ['101', '102', '103', '104', '105', '106'].map((u) => person(u));
  const lastTs = { 101: 1, 102: 2, 103: 3, 104: 4, 105: 5, 106: 6 };

  // 3) 第 6 人 → 剔 lastTs 最早者
  const r = I.fitProfileText(persons, { budget: 1e9, lastTsByUid: lastTs });
  assert.equal(r.selected.length, 5, '★ 最多 5 人');
  assert.ok(!r.selected.includes('101'), '★ 剔掉 lastTs 最早的 101');
  assert.deepEqual(r.selected, ['106', '105', '104', '103', '102'], '选人按 lastTs 降序');
  assert.equal(r.trimmed.overCap, false);

  // 4) 被剔者若是受保护 → 不剔，改剔下一个
  const r2 = I.fitProfileText(persons, { budget: 1e9, lastTsByUid: lastTs, protectedIds: ['101'] });
  assert.ok(r2.selected.includes('101'), '★ 受保护的触发者/@/回复目标不被剔');
  assert.ok(!r2.selected.includes('102'), '改剔下一个（102）');

  // 5) 受保护 6 人 → 全保留 + overCap 日志
  const logs = [];
  const r3 = I.fitProfileText(persons, {
    budget: 1e9, lastTsByUid: lastTs,
    protectedIds: persons.map((p) => p.uid), log: (m) => logs.push(m)
  });
  assert.equal(r3.selected.length, 6, '★ 受保护超过 5 人时全保留');
  assert.equal(r3.trimmed.overCap, true);
  assert.ok(logs.some((m) => String(m).includes('受保护人数 6 > 5')), '★ 超员必须留日志');

  // 12) 同一批人、不同 lastTs 顺序 → 选人顺序变、渲染字节不变
  const five = persons.slice(0, 5);
  const a = I.fitProfileText(five, { budget: 1e9, lastTsByUid: { 101: 9, 102: 8, 103: 7, 104: 6, 105: 5 } });
  const b = I.fitProfileText(five, { budget: 1e9, lastTsByUid: { 101: 1, 102: 2, 103: 3, 104: 4, 105: 5 } });
  assert.notDeepEqual(a.selected, b.selected, '选人顺序确实随 lastTs 变');
  assert.equal(a.text, b.text, '★ 渲染按 uid 升序 → 字节完全相同（前缀缓存不抖）');
  assert.deepEqual(a.perPerson.map((p) => p.uid), ['101', '102', '103', '104', '105']);
  ok('§3.7-3/4/5/12 选人：5 人上限、受保护优先、超员留痕、渲染字节与触发顺序无关');
}

// ── §3.7-7/10/13 pinned 与预算裁剪：档位顺序 + 确定性 ──
{
  const uid = '321';
  const mkSlots = (n) => Array.from({ length: n }, (_, i) => ({
    dim: I.PROFILE_DIMS[Math.floor(i / 2)],
    content: `印象${i}${'长'.repeat(20)}`,
    sourceEntryIds: [`e${i}`]
  }));
  const mkPinned = (id, ts) => mkEntry(uid, id, `钉住${id}${'长'.repeat(20)}`, ['说话风格'], { pinnedByUser: true, updatedAt: ts });
  const base = { uid, name: '甲', slots: mkSlots(8), pinned: [] };

  // 精确预算：n 行刚好塞下（header + n 行，每行后一个 \n）
  const fullText = I.fitProfileText([base], { budget: 1e9 }).text;
  const lines = fullText.split('\n');
  const headerLen = [...lines[0]].length;
  const budgetFor = (n) => headerLen + lines.slice(1, 1 + n).reduce((s, l) => s + [...l].length + 1, 0);

  const loose = I.fitProfileText([base], { budget: 1e9 });
  assert.equal(loose.perPerson[0].contents.length, 8);
  assert.equal(loose.trimmed.stage, 'none');

  // 档 3：预算只够 5 行 → 兴趣 2→0、性格 2→1
  const dims = I.fitProfileText([base], { budget: budgetFor(5) });
  assert.equal(dims.trimmed.stage, 'dims');
  assert.equal(dims.trimmed.perDim['兴趣身份'], 0, '★ 先砍兴趣身份');
  assert.equal(dims.trimmed.perDim['性格特质'], 1);
  assert.equal(dims.trimmed.perDim['说话风格'], 2, '★ 说话风格砍得最晚');
  assert.ok([...dims.text].length <= budgetFor(5));

  // 档 4：连 1 条说话风格都塞不下 → 地板（尽力保 1 条，不再保证不超预算）
  const floor = I.fitProfileText([base], { budget: budgetFor(1) - 1 });
  assert.equal(floor.trimmed.stage, 'floor');
  assert.equal(floor.perPerson[0].contents.length, 1);
  assert.ok(floor.perPerson[0].contents[0].startsWith('印象0'), '★ 地板留的是说话风格第一条');

  // 7) pinned 全部单独注入；与槽内容重复 → 去重
  const withPin = { ...base, pinned: [mkPinned('p1', T0 + 2000), mkPinned('p2', T0 + 1000)] };
  const pr = I.fitProfileText([withPin], { budget: 1e9 });
  assert.equal(pr.perPerson[0].contents.length, 10, '★ 8 槽 + 2 pinned 全注入');
  assert.equal(pr.perPerson[0].pinnedCount, 2);
  assert.ok(pr.text.includes('- 甲：钉住p1'), 'pinned 渲染格式与普通条一致');
  assert.ok(!pr.text.includes('【钉住'), '★ 不新增固定小标题（L1_HEADER 字节不能变）');
  const dupPin = { ...base, pinned: [mkEntry(uid, 'pd', base.slots[0].content, ['说话风格'], { pinnedByUser: true })] };
  const dr = I.fitProfileText([dupPin], { budget: 1e9 });
  assert.equal(dr.perPerson[0].contents.length, 8, '★ 与槽内容相同的 pinned 不重复注入');

  // 13) 有 pinned 的人不被档 1 整人剔除 → 档 2 从最老的 pinned 开始删
  const pinLines = I.fitProfileText([withPin], { budget: 1e9 }).text.split('\n');
  const pinBudgetFor = (n) => [...pinLines[0]].length + pinLines.slice(1, 1 + n).reduce((s, l) => s + [...l].length + 1, 0);
  const tight = I.fitProfileText([withPin], { budget: pinBudgetFor(8) });
  assert.equal(tight.trimmed.stage, 'pinned', '★ 档 1 剔不动有 pinned 的人 → 落到档 2');
  assert.equal(tight.trimmed.droppedUsers, 0);
  assert.equal(tight.trimmed.droppedPinned, 2);
  assert.equal(tight.perPerson[0].contents.length, 8);
  assert.ok(!tight.text.includes('钉住p2'), 'updatedAt 最老的先剔');

  // 档 1：无 pinned 的人先被整人剔除（lastTs 最早）
  const other = { uid: '322', name: '乙', slots: mkSlots(8), pinned: [] };
  const two = I.fitProfileText([withPin, other], { budget: 1e9, lastTsByUid: { 321: 1, 322: 2 } });
  const twoLines = two.text.split('\n');
  const twoBudget = [...twoLines[0]].length + twoLines.slice(1, 1 + 10).reduce((s, l) => s + [...l].length + 1, 0);
  const drop = I.fitProfileText([withPin, other], { budget: twoBudget, lastTsByUid: { 321: 1, 322: 2 } });
  assert.equal(drop.trimmed.stage, 'users');
  assert.equal(drop.trimmed.droppedUsers, 1);
  assert.ok(drop.selected.includes('321') && !drop.selected.includes('322'), '★ 有 pinned 的 321 留下，无 pinned 的 322 被剔');

  // 10) 确定性：同一输入两次结果完全相同（含裁剪档位）
  const x1 = I.fitProfileText([withPin, other], { budget: twoBudget, lastTsByUid: { 321: 1, 322: 2 } });
  const x2 = I.fitProfileText([withPin, other], { budget: twoBudget, lastTsByUid: { 321: 1, 322: 2 } });
  assert.equal(x1.text, x2.text, '★ 裁剪必须确定性');
  assert.deepEqual(x1.trimmed, x2.trimmed);
  assert.equal(x1.text, drop.text, '★ 裁剪不许改入参对象（否则第二次结果就变了）');
  ok('§3.7-7/10/13 裁剪：pinned 全注入+去重、档1跳过有pinned的人、档2剔最老pinned、档3维序、档4地板、两次同结果');
}

// ── §3.7-11 digests 含 pinned：钉住/取消钉住 → 快照失效 ──
{
  freshRoot();
  const adapter = I.createInjectAdapter({ peopleStore: null, cfg: {}, now: () => T0 });
  M.appendPerson(mkEntry('901', 'n1', '普通印象一条', ['说话风格']));
  const before = adapter.promptSnapshot(K, { userIds: ['901'] });
  M.appendPerson(mkEntry('901', 'n2', '用户亲手钉住的话', ['性格特质'], { pinnedByUser: true }));
  const after = adapter.promptSnapshot(K, { userIds: ['901'] });
  assert.ok(after.text.includes('用户亲手钉住的话'), 'pinned 必须注入');
  assert.notDeepEqual(before.members['u:901'].digests, after.members['u:901'].digests,
    '★ 钉住后 digests 必须变（否则快照判可用，最长 6 小时看不到变化）');
  assert.equal(after.members['u:901'].digests.length, after.members['u:901'].impressions.length);
  ok('§3.7-11 digests 含 pinned：钉住即快照失效，digests 与 impressions 等长');
}

// ── #16 关闭注入时提示词字节与改前完全一致（step 4 的硬要求）──
{
  const { ChatStore } = await import('../src/store.js');
  const { buildUserPrompt } = await import('../src/prompt.js');
  const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

  const cfg0 = structuredClone(DEFAULT_CONFIG);
  cfg0.persona.botName = '测试机';
  cfg0.persona.roleText = '你是测试群里的测试机。';
  cfg0.sticker.enabled = false;
  cfg0.store.historyCount = 5;
  cfg0.store.promptAnchor = { enabled: false };
  setRuntimeConfig(cfg0);

  const st = new ChatStore(0);
  const CHAT2 = 'group:424242';
  const e1 = st.appendIncoming(CHAT2, { mid: 1, ts: T0, senderId: 'uA', senderName: '甲', text: '在吗' });
  st.markEntryRead(CHAT2, e1.id);
  const trig = [st.appendIncoming(CHAT2, { mid: 2, ts: T0 + 1000, senderId: 'uA', senderName: '甲', text: '问个事' })];

  const base = {
    chatKey: CHAT2, kind: 'group', chatId: '424242', chatName: '测试群',
    triggerEntries: trig, store: st, memory: null, stickerEntries: [],
    selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
    contextLimit: 5, promptAnchor: { prev: null }, session: {}
  };

  // ① enabled:false 的等价条件：ctx 里没有 l3Text，且 memory 为 null（注入器未启用）
  const offPrompt = buildUserPrompt({ ...base });
  // ② 就算显式传了空串，也必须一个字节不多（prompt.js 那行是 if (text) 才 push）
  const offPromptEmpty = buildUserPrompt({ ...base, l3Text: '   ' });
  assert.equal(offPromptEmpty, offPrompt, '★ l3Text 为空（或纯空白）时提示词逐字节不变');
  assert.ok(!offPrompt.includes('【专名说明】'), '★ 关闭时不许出现空的【专名说明】标题');

  // ③ 打开后段确实出现，且位置在【记忆】之后（不许打断稳定前缀）
  const onPrompt = buildUserPrompt({ ...base, l3Text: '【专名说明】\n- 某词' });
  assert.ok(onPrompt.includes('【专名说明】\n- 某词'));
  assert.ok(onPrompt.indexOf('【专名说明】') > onPrompt.indexOf('【未读信息】'),
    '★ 【专名说明】必须在【未读信息】之后（关闭注入时无【记忆】段，同样不得打断稳定前缀）');
  ok('#16 字节一致：L3 关闭/空串不变，开启后出现在【未读信息】之后');
}

// ── #17 fail-open：读盘炸了退化成空记忆，但必须留日志 ──
{
  const logs = [];
  const bad = I.createInjectAdapter({
    peopleStore: null, cfg: {}, now: () => T0,
    readL1: () => { throw new Error('坏 jsonl'); },
    log: (m) => logs.push(m)
  });
  const s = bad.promptSnapshot(K, { userIds: ['1'] });
  assert.deepEqual(s, { text: '', members: {}, userIds: [] }, '★ 注入器读盘抛错时必须 fail-open（prompt.js 没有 try/catch，抛出去会拖崩整轮回复）');
  assert.ok(logs.some((m) => String(m).includes('退化为空记忆')),
    '★ 降级必须留日志（否则「静默没记忆」会被误判成「这个人没画像」）');

  // 日志函数本身抛错也不能二次崩
  const bad2 = I.createInjectAdapter({
    peopleStore: null, cfg: {}, now: () => T0,
    readL1: () => { throw new Error('又炸了'); },
    log: () => { throw new Error('logger also broken'); }
  });
  assert.deepEqual(bad2.promptSnapshot(K, { userIds: ['1'] }), { text: '', members: {}, userIds: [] });
  ok('#17 fail-open：读盘失败退化为空记忆且留日志，日志再炸也不影响回复');
}

// ── #18 读侧只统计：带题材词的槽/pinned/兜底照常注入，只计数 + 日志 ──
{
  const uid = '608';
  const active = [
    mkEntry(uid, 'a1', '爱用波浪号', ['说话风格']),
    mkEntry(uid, 'a2', '反感凌辱恶堕类题材', ['性格特质']),
    mkEntry(uid, 'a3', '有明确底线，不拿这类事开玩笑', ['性格特质'])
  ];
  const logs = [];
  const slots = [
    { dim: '说话风格', content: '爱用波浪号', sourceEntryIds: ['a1'] },
    { dim: '性格特质', content: '反感凌辱恶堕类题材', sourceEntryIds: ['a2'] }
  ];
  const r = I.resolvePersonItems(uid, active, { slots }, { log: (m) => logs.push(m) });
  assert.equal(r.slots.length, 2, '★ 命中题材词的槽照常注入（只统计、不拦截）');
  assert.equal(r.sensitiveSlots, 1, '★ 命中要计数，便于观测');
  assert.ok(JSON.stringify(r).includes('凌辱'), '★ 返回值照常带原文');
  assert.ok(logs.some((m) => String(m).includes('仅统计，不拦截')), '★ 命中要留日志');

  // 全部槽都命中 → 仍是有效内容，不会因此触发兜底
  const r2 = I.resolvePersonItems(uid, active, { slots: [slots[1]] });
  assert.equal(r2.usedFallback, false, '★ 命中不导致丢槽，也就不会触发兜底');
  assert.equal(r2.sensitiveSlots, 1);

  // 兜底路径：画像为空照常兜底，命中同样计数、不跳过
  const r3 = I.resolvePersonItems(uid, active, { slots: [] });
  assert.equal(r3.usedFallback, true, '空画像 → 兜底');
  assert.ok(r3.slots.some((s) => s.sourceEntryIds.includes('a2')), '★ 兜底里命中题材词的条目照常注入');
  assert.ok(r3.sensitiveFallback >= 1, '★ 兜底命中要计数');

  // 钉住条目照常注入 + 计数
  const pinActive = [
    mkEntry(uid, 'pin_ok', '钉住的一句话', ['说话风格'], { pinnedByUser: true }),
    mkEntry(uid, 'pin_bad', '钉住的凌辱类偏好', ['兴趣身份'], { pinnedByUser: true })
  ];
  const rp = I.resolvePersonItems(uid, pinActive, null);
  assert.equal(rp.pinned.length, 2, '★ 带题材词的 pinned 照常注入');
  assert.equal(rp.sensitivePinned, 1, '★ pinned 命中同样计数');
  assert.ok(JSON.stringify(rp).includes('凌辱'), '★ pinned 路径照常带原文');

  // 干净画像零影响（字节不变）+ 计数 0
  const okSlots = [{ dim: '说话风格', content: '爱用波浪号', sourceEntryIds: ['a1'] }];
  const clean = I.resolvePersonItems(uid, active, { slots: okSlots });
  assert.equal(JSON.stringify(clean.slots), JSON.stringify(I.resolvePersonItems(uid, active, { slots: okSlots }).slots));
  assert.equal(clean.sensitiveSlots, 0);
  ok('#18 读侧只统计：槽/pinned/兜底照常注入，命中只计数 + 留日志');
}

// ── 收尾：确认没有污染真实数据 ──
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── mem2-inject：${passed} 项通过`);
