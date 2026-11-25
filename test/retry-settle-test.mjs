// 手动重试（真实 #resetSessionForRetry 路径）—— P0-04 第 10 条的集成补证。
//
// 背景：usage-ledger-test 的第 10 条只能做“源码顺序断言 + 账本层模拟”，
//   mock LLM 无法造出“先成功累计 usage、后失败抛错”的同一次运行。
//   本文件用真实 bootApp 跑完整链路：
//     ① 真实失败（3×HTTP 500）→ finish('error') 结算 attempt0；
//     ② 调真实的 orchestrator.retrySession() → 走 #resetSessionForRetry；
//     ③ 断言结算发生在清空之前（账本已含 token、会话 usage 已归零、attemptSeq 换代）；
//     ④ 模拟“结算成功但会话文件没写成”（把磁盘文件回写成旧内容）→ 重启不双计。
//
// 同进程只能 bootApp 一次（DATA_DIR 在模块加载时固定），本文件单独进程运行。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp } from './_harness.mjs';

// ── 输出收敛：bootApp/orchestrator 会打大量日志 ──
const out = [];
const say = (s) => out.push(s);
let logBuf = [];
console.log = (...a) => logBuf.push(a.join(' '));
console.error = (...a) => logBuf.push(a.join(' '));
console.warn = (...a) => logBuf.push(a.join(' '));

let pass = 0, fail = 0;
const check = async (name, fn) => {
  logBuf = [];
  const realLog = (...a) => out.push(a.join(' '));
  try { await fn(); pass++; say(`  ✓ ${name}`); }
  catch (e) {
    fail++;
    say(`  ✗ ${name}\n      ${e.message}`);
    if (logBuf.length) say('      --- 日志 ---\n      ' + logBuf.slice(-15).join('\n      '));
    void realLog;
  }
};

const dayKey = (ts = Date.now()) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// 第一轮成功（带一次工具调用，让循环继续到第 2 轮），第二轮开始一律 500。
// sessionRetryAttempts=0：关掉自动重试，让手动 retrySession 成为唯一换代入口。
const env = await bootApp({
  config: { wakeDelayMs: 100, drainDelayMs: 100, sessionRetryAttempts: 0 },
  script: [{ content: null, toolCalls: [{ name: 'get_recent_messages', args: {} }] }]
});
const { app, dataDir } = env;
const ledgerOf = (day = dayKey()) => {
  const f = path.join(dataDir, 'usage-ledger', `${day}.json`);
  return fs.existsSync(f) ? readJson(f) : null;
};
const tokensToday = () => Number(ledgerOf()?.totalTokens) || 0;
const readSession = (id) => readJson(path.join(dataDir, 'sessions', `${id}.json`));

let seq = 0;
const sendTrigger = (text) => {
  seq += 1;
  env.pushGroupMsg(41915 + seq, '测试', text, `mid-${Date.now()}-${seq}`);
};

try {
  let sid = null;
  let tokensAfterFail = 0;

  // ══ 1. 真实失败 → 手动重试：结算在清空之前，且幂等键换代 ══
  await check('1. retrySession 真实路径：attempt0 已结算、usage 清零、attemptSeq=1', async () => {
    // 第一轮正常返回并累计 usage；从第 2 次请求起一律 500（内部 3 次重试后抛错）。
    env.llm.state.failAfter = 1;
    sendTrigger('真实重试路径');
    const done = await env.waitSessionDone('真实重试路径', 25000);
    assert.equal(done.status, 'error', `应先以 error 收尾（实际 ${done.status}）`);
    sid = done.id;

    tokensAfterFail = tokensToday();
    assert.ok(tokensAfterFail > 0, `失败会话也应有 token 入账（实际 ${tokensAfterFail}）`);
    const l0 = ledgerOf();
    assert.ok(l0.appliedAttempts.includes(`${sid}:0`), 'attempt0 幂等键应已写入');

    const r = app.orchestrator.retrySession(sid);
    assert.equal(r.ok, true, `重试应成功（拒绝原因：${r.reason || '无'}）`);

    const live = app.sessions.current.get(sid);
    assert.ok(live, '重试后会话必须回到 current（复活）');
    assert.equal(live.attemptSeq, 1, '★ 换代必须在结算之后（1 = attempt0 已结算）');
    assert.equal(Number(live.usage?.totalTokens) || 0, 0, '★ 重试必须清空实时 usage');
    assert.deepEqual(live.messages, [], '★ 重试必须清空 messages');
    assert.equal(tokensToday(), tokensAfterFail, '★ 重试本身不得再记一笔（结算只发生一次）');
    const after = readSession(sid);
    assert.equal(Number(after.usage?.totalTokens) || 0, 0, '磁盘文件也应是清零后的状态');
  });

  // ══ 2. attempt1 正常完成：两次 attempt 合计、runs=2 ══
  await check('2. attempt1 完成后：账本 = attempt0 + attempt1，runs=2', async () => {
    env.llm.state.failAfter = null;   // 放行第二次运行
    const r1 = Number(ledgerOf()?.runs) || 0;
    assert.equal(tokensToday(), tokensAfterFail, '刚重试、还没跑完时不得有新账');
    const done = await env.waitSessionDone('真实重试路径', 25000);
    assert.ok(['done', 'noreply'].includes(done.status), `第二次应正常收尾（实际 ${done.status}）`);
    const l = ledgerOf();
    assert.ok(l.totalTokens > tokensAfterFail, `应新增 attempt1 的 token（之前 ${tokensAfterFail}，现在 ${l.totalTokens}）`);
    assert.equal(l.runs - r1, 1, 'attempt1 只加 1 次 runs');
    assert.ok(l.appliedAttempts.includes(`${sid}:1`), 'attempt1 幂等键应写入');
  });

  // ══ 3. 结算成功但会话文件没写成（模拟持久化失败）→ 重启不双计 ══
  await check('3. 结算成功 + 文件未落盘：重启后按 appliedAttempts 兜住，不双计', async () => {
    // 造一个“账本已结算、但磁盘会话文件仍停在旧 usage”的状态：
    //   finish 先在内存结算并写账，再 #persist；这里把文件回写成结算前的内容。
    const file = path.join(dataDir, 'sessions', `${sid}.json`);
    const now = readSession(sid);
    const stale = { ...now, usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 0, calls: 1 }, accountPending: true };
    fs.writeFileSync(file, JSON.stringify(stale, null, 1));
    const before = tokensToday();

    const { SessionRegistry } = await import('../src/sessions.js');
    new SessionRegistry(0);   // 模拟重启：扫到 stale，但账本 appliedAttempts 已含 sid:1

    assert.equal(tokensToday(), before, '★ 重启不得把同一 attempt 再记一次');
    const data = readSession(sid);
    assert.equal(data.accountPending, false, 'accountPending 应被清掉（结算成功）');
  });
} finally {
  try { await env.teardown(); } catch { /* ignore */ }
}

say(`\n重试结算（P0-04 第 10 条集成补证）：通过 ${pass}，失败 ${fail}`);
process.stdout.write(out.join('\n') + '\n');
process.exit(fail ? 1 : 0);
