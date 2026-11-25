// retention 20 小时门闩（P1-03，对应施工单 §10.3）。
//
// 门闩的语义就一条：**只有本次真的没出错才写时间戳**。一次失败被门闩压住，
// 等于这一天再也不会重试；反过来，errors 非空却写了门闩，用户永远看不出问题。
//
// 这里直接测 `runRetentionTick`（app.js 只接线），并另外用真 `runRetention`
// 跑一遍「子任务抛错 → errors 非空」，确认错误摘要确实能传出来。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-retlatch-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const {
  runRetentionTick, readRetentionLatch, writeRetentionLatch,
  runRetention, RETENTION_LATCH_MS
} = await import(pathToFileURL(path.join(ROOT, 'src', 'retention.js')).href);

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const LATCH = path.join(DATA, 'retention-last.json');
const fresh = () => fs.rmSync(LATCH, { force: true });

try {
  // ══ 1. 全部成功 → 写门闩 ══
  await check('1. 子任务全部成功（errors 为空）→ 写门闩', async () => {
    fresh();
    let calls = 0;
    const r = await runRetentionTick({
      file: LATCH,
      run: async () => { calls += 1; return { sessions: 0, messages: 0, errors: [] }; },
      now: () => 1_700_000_000_000,
    });
    assert.equal(calls, 1);
    assert.equal(r.ran, true);
    assert.equal(r.wrote, true);
    assert.equal(readRetentionLatch(LATCH), 1_700_000_000_000, '门闩应写入本次 ts');
  });

  // ══ 2. 门闩内 20h 不重复跑 ══
  await check('2. 20 小时内不重复执行', async () => {
    let calls = 0;
    const r = await runRetentionTick({
      file: LATCH,
      run: async () => { calls += 1; return { errors: [] }; },
      now: () => 1_700_000_000_000 + RETENTION_LATCH_MS - 1000,
    });
    assert.equal(calls, 0, '门闩内不得再跑');
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'latch');
    assert.equal(readRetentionLatch(LATCH), 1_700_000_000_000, '门闩不得被改写');
  });

  // ══ 3. 超过 20h 再跑并刷新门闩 ══
  await check('3. 超过 20 小时再执行一次并刷新门闩', async () => {
    let calls = 0;
    const t = 1_700_000_000_000 + RETENTION_LATCH_MS + 1;
    const r = await runRetentionTick({
      file: LATCH,
      run: async () => { calls += 1; return { errors: [] }; },
      now: () => t,
    });
    assert.equal(calls, 1);
    assert.equal(r.wrote, true);
    assert.equal(readRetentionLatch(LATCH), t);
  });

  // ══ 4. 有错误 → 不写门闩；下一次 tick 仍会重试 ══
  await check('4. errors 非空时不写门闩，下一次 tick 仍会重试', async () => {
    fresh();
    let n = 0;
    const failing = async () => { n += 1; return { errors: ['存档清理失败: boom'] }; };
    const r1 = await runRetentionTick({ file: LATCH, run: failing, now: () => 2_000_000_000_000 });
    assert.equal(r1.ran, true);
    assert.equal(r1.wrote, false, '有错误绝不能写门闩');
    assert.equal(fs.existsSync(LATCH), false, '门闩文件都不应出现');
    assert.equal(n, 1);

    // 同一时刻再来一次：门闩没写 → 必须继续跑（这就是“下次重试”）
    const r2 = await runRetentionTick({ file: LATCH, run: failing, now: () => 2_000_000_000_000 + 60_000 });
    assert.equal(n, 2, '失败后下一次 tick 必须重试');
    assert.equal(r2.wrote, false);

    // 修好后写门闩
    const r3 = await runRetentionTick({
      file: LATCH, run: async () => ({ errors: [] }), now: () => 2_000_000_000_000 + 120_000
    });
    assert.equal(r3.wrote, true);
  });

  // ══ 5. skipped:true 且无错误 → 视为成功 ══
  await check('5. 按配置 skipped:true 且 errors 为空 → 写门闩', async () => {
    fresh();
    const r = await runRetentionTick({
      file: LATCH,
      run: async () => ({ skipped: true, cutoff: 0, messages: 0, errors: [] }),
      now: () => 3_000_000_000_000,
    });
    assert.equal(r.ran, true);
    assert.equal(r.wrote, true, 'skipped 且无错误算成功');
    assert.equal(readRetentionLatch(LATCH), 3_000_000_000_000);
  });

  // ══ 6. 真 runRetention：子任务抛错 → errors 非空、其余子任务不受影响 ══
  await check('6. 真 runRetention：pruneBefore 抛错 → errors 非空且其它子任务照常', async () => {
    fresh();
    const logs = [];
    const r = await runRetention({
      store: { pruneBefore() { throw new Error('存档坏了'); } },
      sessions: { pruneOlderThan() { return 3; } },
      days: 180,
      messagesDays: 30,
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.ok(Array.isArray(r.errors), 'runRetention 必须返回 errors 数组');
    assert.equal(r.errors.length, 1, `应恰好一条错误（实际 ${JSON.stringify(r.errors)}）`);
    assert.ok(/存档清理失败/.test(r.errors[0]), '错误摘要要带子任务名');
    assert.equal(r.sessions, 3, '会话清理不受存档失败影响');
    assert.ok(logs.some((l) => /存档清理失败/.test(l)), '错误也要进日志');
  });

  // ══ 7. skipped 分支也带 errors 字段 ══
  await check('7. cutoff=0 的 skipped 分支同样带 errors:[]', async () => {
    const r = await runRetention({ store: { pruneBefore: () => 0 }, days: 0, messagesDays: 0, log: () => {} });
    assert.equal(r.skipped, true);
    assert.deepEqual(r.errors, []);
  });

  // ══ 8. 门闩写入是原子的（不留 .tmp）══
  await check('8. 原子写：不残留 .tmp 文件', () => {
    fresh();
    assert.equal(writeRetentionLatch(123, LATCH), true);
    const leftovers = fs.readdirSync(path.dirname(LATCH)).filter((f) => f.includes('retention-last.json.') && f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '不得残留临时文件');
    assert.deepEqual(JSON.parse(fs.readFileSync(LATCH, 'utf8')), { ts: 123 });
  });
  // ══ 9. 启动错峰：5000 / 20000 / 180000，且不再有 60s retention ══
  await check('9. app.js 启动错峰为 5s/20s/180s，retention 不在 0–120s', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    const lines = src.split('\n');
    assert.ok(lines.some((l) => l.includes('reconcileInBackground') && /, 5000\)/.test(l)), '索引对账应在 t+5s');
    assert.ok(lines.some((l) => l.includes('collectUsageRows') && /20_000\)/.test(l)), 'usage 预热应在 t+20s');
    assert.ok(/setTimeout\(retentionTick, 180_000\)/.test(src), 'retention 应在 t+180s');
    assert.equal(/setTimeout\(retentionTick, 60_000\)/.test(src), false, '不得残留 t+60s');
    assert.ok(lines.every((l) => !(l.includes('reconcileInBackground') && /, 3000\)/.test(l))), '不得残留 t+3s 对账');
    assert.ok(/setInterval\(retentionTick, 24 \* 60 \* 60 \* 1000\)/.test(src), '仍应每 24h 一次');
    assert.ok(/runRetentionTick\(/.test(src), 'app.js 应走 runRetentionTick（顺序固定在 retention.js）');
  });
} finally {
  /* 临时目录留给 OS 清理 */
}

console.log(`\nretention 门闩（P1-03）：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
