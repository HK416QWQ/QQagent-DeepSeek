// src/boot-wait.js 的单测：纯离线、零依赖、注入假时钟。
//
// 为什么必须注入时钟：这段逻辑的核心是"等多久、探几次"，用真实 setTimeout 跑
// 一次 60 秒预算的用例要 60 秒 —— 测试会变成摆设，没人愿意跑。
// 注入 now + sleep 之后，虚拟时间可以精确推到任意毫秒，断言"间隔正好是 150ms"
// 这种硬指标才有可能。

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'boot-wait.js')).href);
const { waitForPort } = mod;

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

/**
 * 假时钟 + 预设探测结果。
 * results：每次探测依次返回的值（用完后一律 false）。
 * 探测本身不推进时间（与真实 isPortOpen 的毫秒级开销同量级，可忽略）。
 */
function fakeClock(results = []) {
  let t = 0;
  let i = 0;
  const delays = [];
  return {
    isOpen: async () => (i < results.length ? results[i++] : false),
    sleep: async (ms) => { delays.push(ms); t += ms; },
    now: () => t,
    delays,
    get elapsed() { return t; },
    get probes() { return i; },
  };
}

// ── 1. 首个探测即成功 ──
{
  const c = fakeClock([true]);
  const r = await waitForPort(c.isOpen, { sleep: c.sleep, now: c.now });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1, '一次就成功，不该多探');
  assert.equal(r.elapsedMs, 0, '零等待');
  assert.equal(c.delays.length, 0, '成功时一次都不该睡');
  ok('首个探测即成功：attempts=1、elapsedMs=0、零 sleep');
}

// ── 2. 第 5 次成功 ──
{
  const c = fakeClock([false, false, false, false, true]);
  const r = await waitForPort(c.isOpen, { sleep: c.sleep, now: c.now });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 5);
  assert.equal(c.delays.length, 4, '4 次失败 → 4 次 sleep');
  ok('第 5 次成功：ok=true、attempts=5');
}

// ── 3. 全程失败：elapsedMs 不越过预算 ──
{
  const c = fakeClock([]);
  const r = await waitForPort(c.isOpen, { sleep: c.sleep, now: c.now, budgetMs: 1000 });
  assert.equal(r.ok, false);
  assert.ok(r.elapsedMs <= 1000, `不得越过预算，实际 ${r.elapsedMs}`);
  assert.equal(r.elapsedMs, 1000, '最后一次只睡剩余量，正好停在预算上');
  assert.ok(r.attempts >= 2, '至少探过两次才叫"等过"');
  ok(`全程失败：ok=false、elapsedMs=${r.elapsedMs}（不越过 1000）、attempts=${r.attempts}`);
}

// ── 4. budgetMs=0：立即返回，一次都不探 ──
{
  const c = fakeClock([true]);
  const r = await waitForPort(c.isOpen, { sleep: c.sleep, now: c.now, budgetMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 0, '零预算不该探任何一次');
  assert.equal(c.probes, 0);
  assert.equal(c.delays.length, 0);
  ok('budgetMs=0：立即 false、attempts=0、零探测零 sleep');
}

// ── 5. 前 1 秒内用 fastDelayMs ──
{
  const c = fakeClock([]);
  await waitForPort(c.isOpen, {
    sleep: c.sleep, now: c.now, budgetMs: 2000,
    fastUntilMs: 1000, fastDelayMs: 150, slowDelayMs: 1000,
  });
  // 前 6 次 sleep 都发生在 elapsed<1000 时 → 应全是 150
  const firstFast = c.delays.slice(0, 6);
  assert.deepEqual(firstFast, [150, 150, 150, 150, 150, 150],
    `前 1 秒内间隔必须都是 150，实际 ${JSON.stringify(firstFast)}`);
  ok('前 1 秒内间隔 = fastDelayMs（150ms × 6 次）');
}

// ── 6. 超过 fastUntilMs 后退避到 slowDelayMs ──
{
  const c = fakeClock([]);
  await waitForPort(c.isOpen, {
    sleep: c.sleep, now: c.now, budgetMs: 3000,
    fastUntilMs: 500, fastDelayMs: 150, slowDelayMs: 1000,
  });
  const slowOnes = c.delays.filter((d) => d === 1000);
  assert.ok(slowOnes.length > 0, '退避后必须出现 slowDelayMs');
  // 800 只剩 200，最后一次会睡 min(1000, 200)=200；中间必须出现完整的 1000
  assert.ok(c.delays.includes(1000), `退避段应出现 1000，实际 ${JSON.stringify(c.delays)}`);
  ok('超过 fastUntilMs 后退避为 slowDelayMs（并出现完整 1000ms 的等待）');
}

// ── 7. 探测抛异常 → 当作 false 继续，不外抛 ──
{
  let calls = 0;
  let t = 0;
  const r = await waitForPort(
    async () => { calls += 1; if (calls <= 2) throw new Error('ECONNREFUSED 之类'); return true; },
    { sleep: async (ms) => { t += ms; }, now: () => t, budgetMs: 10_000 }
  );
  assert.equal(r.ok, true, '前两次抛异常后第三次成功，应最终 ok');
  assert.equal(r.attempts, 3);
  ok('探测抛异常：当作"还没开"继续等，不向调用方抛');
}

// ── 8. 返回值形状固定 ──
{
  const c = fakeClock([true]);
  const r = await waitForPort(c.isOpen, { sleep: c.sleep, now: c.now });
  assert.deepEqual(Object.keys(r).sort(), ['attempts', 'elapsedMs', 'ok'],
    '成功时形状必须是 {ok, elapsedMs, attempts}');
  const c2 = fakeClock([]);
  const r2 = await waitForPort(c2.isOpen, { sleep: c2.sleep, now: c2.now, budgetMs: 300 });
  assert.deepEqual(Object.keys(r2).sort(), ['attempts', 'elapsedMs', 'ok'],
    '失败时也必须是同一形状（调用方不该分两种读法）');
  ok('返回值形状固定：成功/失败都是 {ok, elapsedMs, attempts}');
}

// ── 9. shouldStop：退出中提前放弃 ──
{
  const c = fakeClock([]);
  let stop = false;
  const r = await waitForPort(c.isOpen, {
    sleep: async (ms) => { c.delays.push(ms); stop = true; },   // 第一次睡完就"退出"
    now: () => 0,
    budgetMs: 60_000,
    shouldStop: () => stop,
  });
  assert.equal(r.ok, false, '中止时不算就绪');
  assert.equal(r.aborted, true, '必须标 aborted，让调用方能区分"超时"和"被中止"');
  assert.equal(r.attempts, 1, '中止发生在下一次探测之前');
  ok('shouldStop：退出中提前放弃并标 aborted，不跑满 60 秒预算');
}

// ── 10. isOpen 不是函数 → 安全返回 ──
{
  const r = await waitForPort(null, {});
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 0);
  const r2 = await waitForPort(undefined, {});
  assert.equal(r2.ok, false);
  ok('isOpen 非函数：返回失败而不是抛 TypeError');
}

// ── 11. 同步返回值也认（不必是 Promise）──
{
  const c = fakeClock([]);
  let n = 0;
  const r = await waitForPort(() => { n += 1; return n >= 2; }, { sleep: c.sleep, now: c.now });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  ok('isOpen 同步返回布尔也能工作（不必 async）');
}

// ── 12. 探测次数 = sleep 次数 + 1（不漏探也不空转）──
{
  const c = fakeClock([]);
  const r = await waitForPort(c.isOpen, {
    sleep: c.sleep, now: c.now, budgetMs: 2000, fastUntilMs: 10_000, fastDelayMs: 200,
  });
  assert.equal(r.attempts, c.delays.length + 1,
    `应满足 attempts = sleep 次数 + 1（实际 ${r.attempts} vs ${c.delays.length}）`);
  ok(`探测次数 = sleep 次数 + 1（${r.attempts} = ${c.delays.length} + 1，无空转）`);
}

// ── 13. 真实默认 sleep 也能跑（极小预算，验证 unref 不炸）──
// ⚠️ 必须放一个**不 unref** 的锚：defaultSleep 故意把 timer unref 掉（生产上
// 不能让 60 秒的后台等待拖住进程退出），但如果整个进程只剩这些 unref 定时器，
// Node 会判定事件循环已空、直接退出 —— 表现就是本文件在这行报
// "unsettled top-level await" 然后 exit 13。锚不影响被测逻辑，只是撑住循环。
{
  const anchor = setTimeout(() => {}, 5000);
  try {
    const started = Date.now();
    const r = await waitForPort(() => false, { budgetMs: 60, fastUntilMs: 0, slowDelayMs: 20 });
    const real = Date.now() - started;
    assert.equal(r.ok, false);
    assert.ok(r.attempts >= 2, '极小预算也应探测多次');
    assert.ok(real < 2000, `真实耗时应很小，实际 ${real}ms`);
    ok(`真实默认 sleep 可用：预算 60ms → ${r.attempts} 次探测 / 实际 ${real}ms`);
  } finally {
    clearTimeout(anchor);
  }
}

console.log(`  ── boot-wait：${passed} 项通过`);
