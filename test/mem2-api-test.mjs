// 第 5 期 · 第 8 步的单测：记忆浏览器 5a 的接口契约。
//
// 守的是三条「一旦松了就会静默变坏」的约束：
//   · PATCH 只接受 content —— 能改 status/groups 就等于让 UI 决定注入权重与条目身份
//   · 编辑必须落成「新版本 + pinnedByUser + editedFrom」，原条目 superseded
//     （editedFrom 若不在 makeL1Entry 白名单里，会写了、读不到、还不报错）
//   · 删除是软删且可撤销；撤销不能把 superseded 的条目复活
//
// 覆盖 §6 的：#9 #10 #14
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-mem2-api-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const P = await import('../src/mem2/paths.js');
const M = await import('../src/mem2/store.js');
const API = await import('../src/mem2/ui-api.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const MIN = 60 * 1000;
const T0 = new Date(2026, 10, 16, 10, 0, 0).getTime();
const UID = '9900000001';
const K = 'group:999900001';

P.setMem2Root(path.join(DATA, 'root'));

const batch = (startTs) => ({ chatKey: K, userId: UID, startTs, endTs: startTs + 10 * MIN, msgCount: 30 });
const mk = (id, content, extra = {}) => M.makeL1Entry({
  entryId: id, chatKey: K, userId: UID, content, groups: ['性格特质'],
  status: 'active', deduped: true, sourceBatch: batch(T0), ...extra
});

M.appendPerson(mk(`l1_${UID}_${T0}_1`, '喜欢在深夜聊技术，说话直接'));
M.appendPerson(mk(`l1_${UID}_${T0}_2`, '对显卡和主机配置很熟'));
M.appendPerson(mk(`l1_${UID}_${T0}_3`, '旧的一条', { status: 'superseded' }));

// ── #9 / #14 编辑：只收 content、新版本带 pinned+editedFrom、原条目 superseded ──
{
  const oldId = `l1_${UID}_${T0}_1`;

  // 结构字段一律 400（这是契约，不是"忽略掉就算了"）
  for (const bad of [{ content: 'x', status: 'void' }, { content: 'x', groups: ['兴趣身份'] },
    { content: 'x', entryId: 'l1_x_1_1' }, { content: 'x', pinnedByUser: false }]) {
    assert.throws(() => API.editEntry(oldId, bad), (e) => e.status === 400,
      `改结构字段必须 400：${JSON.stringify(bad)}`);
  }
  assert.throws(() => API.editEntry(oldId, { content: '   ' }), (e) => e.status === 400, '空内容 400');
  assert.throws(() => API.editEntry(oldId, { content: 'x', foo: 1 }), (e) => e.status === 400, '未知字段 400');
  assert.throws(() => API.editEntry(`l1_${UID}_${T0}_999`, { content: 'x' }), (e) => e.status === 404, '找不到 404');
  assert.throws(() => API.editEntry('乱写', { content: 'x' }), (e) => e.status === 400, 'entryId 不合法 400');

  const r = API.editEntry(oldId, { content: '喜欢在深夜聊技术，说话很直接（改过）' });
  assert.equal(r.oldEntryId, oldId);
  assert.equal(r.entry.status, 'active');
  assert.equal(r.entry.pinnedByUser, true, '编辑必须带上 pinnedByUser（去重靠它绕开）');
  assert.equal(r.entry.editedFrom, oldId, '返回体里要有溯源');
  assert.deepEqual(r.entry.groups, ['性格特质'], '分组原样继承（UI 不能改）');

  // ★ #14：从盘上读回来校验 —— makeL1Entry 是白名单构造，没进签名就会在这里消失
  const disk = M.readPerson(UID).byId.get(r.entry.entryId);
  assert.ok(disk, '新版本必须落盘');
  assert.equal(disk.editedFrom, oldId, '★ editedFrom 必须真的落盘（白名单里漏了它就是这条会红）');
  assert.equal(disk.pinnedByUser, true);
  assert.equal(M.readPerson(UID).byId.get(oldId).status, 'superseded', '原条目要 superseded');

  // 同一个人再改一次：主键不能撞
  const r2 = API.editEntry(r.entry.entryId, { content: '再改一次' });
  assert.notEqual(r2.entry.entryId, r.entry.entryId, '同一毫秒内的第二次编辑要换主键');
  assert.equal(r2.entry.editedFrom, r.entry.entryId, '溯源指向上一版（链式）');
  ok('#9/#14 编辑：只收 content（结构字段 400）、新版本 pinned+editedFrom 落盘、原条目 superseded、链式溯源');
}

// ── #10 软删可撤销；撤销不能复活 superseded ──
{
  const id = `l1_${UID}_${T0}_2`;
  const v = API.setEntryStatus(id, 'void');
  assert.equal(v.entry.status, 'void');
  assert.equal(v.changed, true);
  assert.equal(M.readPerson(UID).byId.get(id).status, 'void', '软删要落盘');

  const again = API.setEntryStatus(id, 'void');
  assert.equal(again.changed, false, '重复删除是幂等，不报错');

  const u = API.setEntryStatus(id, 'undo');
  assert.equal(u.entry.status, 'active', '撤销回到 active');
  assert.equal(M.readPerson(UID).byId.get(id).status, 'active');

  assert.throws(() => API.setEntryStatus(id, 'undo'), (e) => e.status === 400, '非 void 状态不能撤销');
  assert.throws(() => API.setEntryStatus(id, 'delete-forever'), (e) => e.status === 400, '未知动作 400');
  assert.throws(() => API.setEntryStatus(id, 'delete-forever'), (e) => e.status === 400, '未知动作 400');
  ok('#10 软删可撤销：void 幂等、undo 回 active、非 void 撤销 400（彻底删除留给 5b 的二次确认）');
}

// ── 列表类接口的形状（UI 依赖这些字段，缺一个就白屏）──
{
  const people = API.listPeople({});
  assert.equal(people.length, 1);
  assert.equal(people[0].userId, UID);
  // 初始 3 条里 1 条已 superseded → 编辑两轮后仍只有 2 条 active（新版本取代旧版本，不是叠加）
  assert.equal(people[0].activeCount, 2, 'active = 编辑后的最新版 + 撤销回来的那条');
  assert.ok(people[0].chatKeys.includes(K), 'chatKeys 要能用于按群筛选');
  assert.ok(Array.isArray(people[0].chatStats), 'chatStats 必须存在');
  assert.equal(people[0].chatStats[0].chatKey, K, '主群排第一');
  assert.ok(people[0].chatStats.every((s) => s.activeCount > 0), '只返回有 active 条目的群');

  assert.equal(API.listPeople({ chat: 'group:999' }).length, 0, '别的群筛不到');
  assert.equal(API.listPeople({ chat: K }).length, 1);
  assert.equal(API.listPeople({ q: '显卡' }).length, 1, '按内容模糊查');
  assert.equal(API.listPeople({ q: '不存在的东西' }).length, 0);

  const one = API.getPerson(UID);
  assert.ok(one.entries.every((e) => e.status !== 'superseded'), '默认不返回 superseded');
  const all = API.getPerson(UID, { includeSuperseded: true });
  assert.ok(all.entries.some((e) => e.status === 'superseded'), '?all=1 才带出历史版本');
  assert.equal(one.counts.superseded >= 1, true);

  assert.throws(() => API.getPerson('999'), (e) => e.status === 404);
  assert.throws(() => API.listCoverage({}), (e) => e.status === 400, 'chat 必填');

  // 两张表都要能读（空数据也不能抛）
  assert.equal(API.listL4({ chat: K }).count, 0);
  const cov = API.listCoverage({ chat: K });
  assert.equal(cov.total, 0);
  assert.deepEqual(Object.keys(cov.counts).sort(), ['failed', 'ok', 'other', 'pending', 'short']);

  const bf = API.backfillStatus({});
  assert.equal(bf.limits.maxCalls, 600);
  assert.ok(bf.remain && typeof bf.remain.callsLeft === 'number');
  assert.equal(bf.switchTs, 0, '没写过 switchTs 时是 0（不是 undefined）');

  // 图数据（全量、只读、轻量）：此时 1 人 / 2 条 active，不传 chat
  const graph = API.graphData();
  assert.equal(graph.people.length, 1, '图 people 应是全量（1 人）');
  assert.equal(graph.people[0].userId, UID);
  assert.equal(graph.people[0].activeCount, 2);
  assert.ok(Array.isArray(graph.people[0].chatKeys) && graph.people[0].chatKeys.length > 0, 'chatKeys 非空');
  assert.ok(Array.isArray(graph.people[0].chatStats) && graph.people[0].chatStats.length > 0, 'chatStats 是数组');
  const cs0 = graph.people[0].chatStats[0];
  assert.equal(typeof cs0.chatKey, 'string');
  assert.equal(typeof cs0.activeCount, 'number');
  assert.equal(typeof cs0.lastUpdatedAt, 'number');
  assert.equal(graph.impressions.length, 2, '图 impressions 是全部 active');
  assert.equal(graph.impressions.length, graph.people.reduce((n, p) => n + p.activeCount, 0),
    '★ impressions.length === sum(activeCount)');
  assert.equal(graph.total, graph.impressions.length);
  const activeIds = M.readPerson(UID).list.filter((e) => e.status === 'active').map((e) => e.entryId).sort();
  assert.deepEqual(graph.impressions.map((i) => i.entryId).sort(), activeIds,
    '只含 active（superseded/void/conflicted 都不入图）');
  for (const im of graph.impressions) {
    assert.equal(im.userId, UID, 'userId 用外层人物 uid');
    assert.equal(typeof im.entryId, 'string');
    assert.ok(Array.isArray(im.groups));
    assert.equal(typeof im.createdAt, 'number');
    assert.equal(typeof im.preview, 'string');
    assert.equal(im.previewTruncated, false, '短正文不截断');
    assert.equal('content' in im, false, '★ 图接口不得返回完整 content');
  }
  assert.deepEqual(API.overview(), { people: 1, activeEntries: 2 });
  ok('列表接口：按群/按内容筛选、默认隐藏 superseded、两张表空数据不抛、回填状态形状齐全');
}

// ── getPerson：派生画像只读摘要（§5 / §8：slots / builtAt / dirty）──
{
  const PR = await import('../src/mem2/profile.js');
  const active = M.readPerson(UID).list.filter((e) => e.status === 'active');
  const digest = PR.computeDigest(active);
  PR.writeProfile(UID, {
    v: 1, uid: UID, builtAt: T0 + 5000, sourceDigest: digest, model: 'test',
    slots: [
      { dim: '性格特质', content: '说话直接，习惯先给结论再补理由', sourceEntryIds: [active[0].entryId], chars: 17 },
      { dim: '兴趣身份', content: '对显卡和主机配置很熟，常帮群友装机', sourceEntryIds: [active[1].entryId], chars: 18 }
    ],
    stats: { calls: 1 }
  });
  const p = API.getPerson(UID);
  assert.ok(p.profile, 'getPerson 带出 profile');
  assert.equal(p.profile.slots.length, 2, 'slots 原样带出');
  assert.equal(p.profile.slots[0].dim, '性格特质');
  assert.equal(p.profile.slots[0].chars, 17, 'chars 以文件为准');
  assert.deepEqual(p.profile.slots[1].sourceEntryIds, [active[1].entryId]);
  assert.equal(p.profile.builtAt, T0 + 5000);
  assert.equal(p.profile.dirty, false, 'digest 与 active 相等 → 不脏');
  assert.equal('stats' in p.profile, false, 'UI 摘要不带 stats 全量');

  const first = p.entries[0];
  API.editEntry(first.entryId, { content: '改过的内容' });
  assert.equal(API.getPerson(UID).profile.dirty, true, 'active 变化后画像标脏');
  ok('getPerson.profile：只读摘要（slots/builtAt/dirty），active 变化会标脏');
}

// ── chatStats：全 tie 落 chatKey 字典序（施工单 §4.3，v1.4 可执行版）──
//
// 三个坑（v1.4 已踩过）：
//   ① 必须用独立 UID —— 加人会让上面 overview() 的 { people: 1 } 变红，所以放文件末尾；
//   ② 不能直接用现成的 mk()：它的 sourceBatch.chatKey 固定是 K，
//      而 makeL1Entry 会把 batch.chatKey 并入 sourceChatKeys（store.js），
//      chatStats 就会多出一个 K。要正好等于 TA/TB，必须 sourceBatch.chatKey = TA + sourceChatKeys = [TB]；
//   ③ 真正被测的是「第三键 chatKey 字典序」，前两条打平断言只是证明「确实进了第三键」。
{
  const TIE_UID = '9900000002';
  const TA = 'group:111';
  const TB = 'group:222';
  const T1 = new Date(2026, 10, 16, 12, 0, 0).getTime();   // 两条同时间 → 前两键必然打平

  // sourceBatch.chatKey = TA、sourceChatKeys = [TB] →
  // makeL1Entry 合并后 sourceChatKeys 正好是 [TA, TB]，不带 K。
  const mkTie = (seq) => M.makeL1Entry({
    entryId: `l1_${TIE_UID}_${T1}_${seq}`,
    chatKey: TA,
    userId: TIE_UID,
    content: `全 tie 用例 ${seq}`,
    groups: ['性格特质'],
    status: 'active',
    deduped: true,
    sourceBatch: { chatKey: TA, userId: TIE_UID, startTs: T1, endTs: T1 + 600000, msgCount: 10 },
    sourceChatKeys: [TB],
    createdAt: T1,
    updatedAt: T1
  });
  M.appendPerson(mkTie(1));
  M.appendPerson(mkTie(2));

  const tiePeople = API.listPeople({ q: TIE_UID });
  assert.equal(tiePeople.length, 1, 'TIE_UID 只该有一个人');
  const s = tiePeople[0].chatStats;
  assert.equal(s.length, 2, '只统计 TA/TB，不许混进 K');
  // 前提：两群各出现 2 次、时间同为 T1（不是被测行为，只是证明「确实进了第三键」）
  assert.equal(s[0].activeCount, 2, '构造错了：两群计数应当打平');
  assert.equal(s[1].activeCount, 2, '构造错了：两群计数应当打平');
  assert.equal(s[0].lastUpdatedAt, T1);
  assert.equal(s[1].lastUpdatedAt, T1);
  // 被测行为：第三键 chatKey 字典序升序
  assert.equal(s[0].chatKey, TA, '全 tie 时主群必须是群号字典序最小的那个');
  assert.equal(s[1].chatKey, TB);
  ok('chatStats：全 tie 落 chatKey 字典序（不按条目先后）');
}

// ── 删除审计口径：删 1 个「磁盘两行」的条目 → 审计 +2（按磁盘行，不按条目数）──
//
// 放在文件末尾（与 tie 用例同区）：purge 会写 deletions.jsonl，别让前面的
// 「只有 1 个人」「overview 形状」类断言被它污染。
{
  const PURGE_UID = '9900000003';
  const PEID = `l1_${PURGE_UID}_${T0}_1`;
  const PCHAT = 'group:333';
  const row = (status, at, content) => ({
    entryId: PEID, content, groups: ['性格特质'], status,
    sourceBatch: { chatKey: PCHAT, userId: PURGE_UID, startTs: T0, endTs: T0 + 60000, msgCount: 5 },
    sourceChatKeys: [PCHAT], createdAt: at, updatedAt: at
  });
  // superseded 在前、active 在后（readPerson 是 last-wins，UI 只会看到 1 条 active）
  M.appendPerson(row('superseded', T0, '审计 旧'));
  M.appendPerson(row('active', T0 + 1000, '审计 新'));

  const before = API.deletionCount();
  const r = API.purgeEntry({ entryId: PEID, confirm: 'DELETE', reason: '单测：审计增量' });
  assert.equal(r.deletedRows, 2, '磁盘上该 entryId 的两行都要删（只删末行会让旧版本复活）');
  assert.equal(API.deletionCount() - before, 2, '审计按磁盘行计：删一个 2 版本条目应 +2，不是 +1');

  const audit = M.readDeletions().filter((x) => x.entryId === PEID);
  assert.equal(audit.length, 2, '两行各写一条审计');
  assert.deepEqual(audit.map((x) => x.row?.status).sort(), ['active', 'superseded'], '审计原样保留每行状态');
  ok('删除审计：删 1 个 2 版本条目 → 审计 +2（按磁盘行，不按条目数）');
}

// ── graphData：>50 字正文只出 50 字 preview（独立 UID，放文件末尾）──
{
  const LONG_UID = '9900000004';
  const LONG = '这是一条用于验证星图接口只返回前五十个字符预览的长正文'.repeat(4);
  M.appendPerson(M.makeL1Entry({
    entryId: `l1_${LONG_UID}_${T0}_1`, chatKey: 'group:444', userId: LONG_UID,
    content: LONG, groups: ['兴趣身份'], status: 'active', deduped: true,
    sourceBatch: { chatKey: 'group:444', userId: LONG_UID, startTs: T0, endTs: T0 + 60000, msgCount: 5 },
    sourceChatKeys: ['group:444'], createdAt: T0, updatedAt: T0
  }));
  const g = API.graphData();
  const row = g.impressions.find((i) => i.userId === LONG_UID);
  assert.ok(row, '长正文人物的印象必须入图');
  assert.equal(Array.from(row.preview).length, 50, 'preview 按 Unicode 字符截 50');
  assert.equal(row.previewTruncated, true);
  assert.equal(row.content, undefined, '不得返回完整 content');
  ok('graphData：>50 字正文只出 50 字 preview + truncated，无 content');
}

// 清理
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── mem2-api：${passed} 项通过`);
