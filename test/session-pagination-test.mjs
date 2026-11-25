// P0-02：SessionRegistry.listPage 游标分页（施工单 v2.15 §4.5 测试 1–9）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-page-'));
process.env.QQ_AGENT_DATA_DIR = dir;

const { SessionRegistry } = await import('../src/sessions.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { const extra = fn(); pass++; console.log('  OK   ' + name + (extra ? ` —— ${extra}` : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        -> ' + String(e?.message ?? e)); }
};

const fresh = () => {
  const reg = new SessionRegistry(0);
  reg.index = [];
  return reg;
};
const entry = (id, startedAt, status = 'done') => ({ id, chatKey: 'group:1', startedAt, status });

/** 按游标把全部页拉完 */
const drainAll = (reg, limit) => {
  const out = [];
  let cursor = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = reg.listPage({ limit, beforeTs: cursor?.beforeTs ?? null, beforeId: cursor?.beforeId ?? null });
    out.push(...page.sessions);
    if (!page.hasMore) return { all: out, last: page };
    cursor = page.nextCursor;
  }
  throw new Error('翻页超过 100 页还没结束（疑似 hasMore 恒真）');
};

console.log('=== P0-02 分页 ===');

check('1. 500 条：第一页 200，游标连续，无重复无漏项', () => {
  const reg = fresh();
  const base = 1_700_000_000_000;
  for (let i = 0; i < 500; i++) reg.index.push(entry(`s${String(i).padStart(3, '0')}`, base + i * 1000));
  const p1 = reg.listPage({ limit: 200 });
  assert.equal(p1.sessions.length, 200);
  assert.equal(p1.hasMore, true);
  assert.ok(p1.nextCursor);
  const { all } = drainAll(reg, 200);
  assert.equal(all.length, 500);
  assert.equal(new Set(all.map((e) => e.id)).size, 500, '不能有重复');
  return `${all.length} 条`;
});

check('2. 新会话插入后旧游标仍稳定', () => {
  const reg = fresh();
  const base = 1_700_000_000_000;
  for (let i = 0; i < 300; i++) reg.index.push(entry(`s${String(i).padStart(3, '0')}`, base + i * 1000));
  const p1 = reg.listPage({ limit: 100 });
  const cursor = p1.nextCursor;
  // 新会话比所有已有会话都新
  reg.index.push(entry('new', base + 999_999));
  const p2 = reg.listPage({ limit: 100, ...cursor });
  assert.ok(!p2.sessions.some((e) => e.id === 'new'), '新会话不应出现在旧游标之后');
  assert.equal(p2.sessions.length, 100);
  return '稳定';
});

check('3. active 只出现在 active，不出现在当前页', () => {
  const reg = fresh();
  for (let i = 0; i < 10; i++) reg.index.push(entry(`d${i}`, 1000 + i));
  reg.index.push(entry('run1', 5000, 'running'));
  reg.index.push(entry('wait1', 6000, 'waiting'));
  const page = reg.listPage({ limit: 200 });
  assert.equal(page.active.length, 2);
  assert.ok(!page.sessions.some((e) => e.status === 'running' || e.status === 'waiting'));
  return `active=${page.active.length}`;
});

check('4. totalFinished + active = total；active 为空时相等', () => {
  const reg = fresh();
  for (let i = 0; i < 7; i++) reg.index.push(entry(`d${i}`, 1000 + i));
  reg.index.push(entry('run1', 5000, 'running'));
  const a = reg.listPage({ limit: 3 });
  assert.equal(a.totalFinished + a.active.length, a.total);
  const reg2 = fresh();
  for (let i = 0; i < 4; i++) reg2.index.push(entry(`x${i}`, 1000 + i));
  const b = reg2.listPage({ limit: 10 });
  assert.equal(b.totalFinished, b.total);
  return `total=${a.total}`;
});

check('5. 相同 startedAt 用 id 倒序稳定', () => {
  const reg = fresh();
  reg.index.push(entry('a', 5000), entry('c', 5000), entry('b', 5000));
  const page = reg.listPage({ limit: 10 });
  assert.deepEqual(page.sessions.map((e) => e.id), ['c', 'b', 'a']);
  return page.sessions.map((e) => e.id).join(',');
});

check('6. startedAt 为 null/0 排末尾且无 NaN', () => {
  const reg = fresh();
  reg.index.push(entry('n1', null), entry('n2', 0), entry('ok', 9000), entry('n3', undefined));
  const page = reg.listPage({ limit: 10 });
  assert.equal(page.sessions[0].id, 'ok');
  assert.deepEqual(page.sessions.slice(1).map((e) => e.id).sort(), ['n1', 'n2', 'n3']);
  assert.ok(page.sessions.every((e) => !Number.isNaN(Number(e.startedAt) || 0)));
  return 'NaN 安全';
});

check('7. listPage 后 this.index 原顺序不变', () => {
  const reg = fresh();
  reg.index.push(entry('a', 1000), entry('b', 3000), entry('c', 2000));
  const before = reg.index.map((e) => e.id).join(',');
  reg.listPage({ limit: 2 });
  assert.equal(reg.index.map((e) => e.id).join(','), before);
  return before;
});

check('8. 重试改 startedAt 后只出现在 active，历史页不重复', () => {
  const reg = fresh();
  const base = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) reg.index.push(entry(`s${i}`, base + i * 1000));
  // 重试 s1：startedAt 改成 now，状态 running
  const target = reg.index.find((e) => e.id === 's1');
  target.startedAt = Date.now() + 10000;
  target.status = 'running';
  const page = reg.listPage({ limit: 10 });
  assert.ok(page.active.some((e) => e.id === 's1'));
  assert.ok(!page.sessions.some((e) => e.id === 's1'), '已完成页不应再有它');
  assert.equal(page.totalFinished, 4);
  assert.equal(page.total, 5);
  return '只出现在 active';
});

check('9. 重试会话再次 finish 后按新位置出现，连续两页无重复', () => {
  const reg = fresh();
  const base = 1_700_000_000_000;
  for (let i = 0; i < 250; i++) reg.index.push(entry(`s${String(i).padStart(3, '0')}`, base + i * 1000));
  const target = reg.index.find((e) => e.id === 's100');
  target.startedAt = base + 900_000;   // 移到最后（最新）
  target.status = 'done';
  const { all } = drainAll(reg, 100);
  assert.equal(all.length, 250);
  assert.equal(new Set(all.map((e) => e.id)).size, 250);
  assert.equal(all[0].id, 's100', '新 startedAt 应排第一');
  return `首页=${all[0].id}`;
});

check('10. limit 边界：0→1、1001→1000、非数字→200', () => {
  const reg = fresh();
  for (let i = 0; i < 1200; i++) reg.index.push(entry(`s${i}`, 1000 + i));
  assert.equal(reg.listPage({ limit: 0 }).sessions.length, 1);
  assert.equal(reg.listPage({ limit: 1001 }).sessions.length, 1000);
  assert.equal(reg.listPage({ limit: 'abc' }).sessions.length, 200);
  return 'clamp 正确';
});

check('11. beforeTs 为空字符串/null 不当作游标 0', () => {
  const reg = fresh();
  reg.index.push(entry('a', 5000), entry('b', 6000));
  assert.equal(reg.listPage({ limit: 10, beforeTs: null }).sessions.length, 2);
  assert.equal(reg.listPage({ limit: 10, beforeTs: '' }).sessions.length, 2);
  return '不会从 0 开始';
});

console.log(`\nP0-02 分页：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
