// B1. 正常退出（真跑一个会话后 app.stop）—— P0-05 §7.5-B1。
//
// 2026-11-22 从 shutdown-settle-test.mjs 拆出独立进程：
//   原文件里 B2 会人为构造“activeRuns 卡死”的现场（不响应 abort 的 controller），
//   B1 紧随其后要真跑一个 LLM 会话。两者共用同一 orchestrator 时，
//   实测约 25% 概率 `startRunningSession` 等不到 running（会话卡在 waiting 或提前结束）。
//   拆分后本文件在干净进程里只做一件事：起会话 → 显式赋 usage → app.stop()。
//
// 同进程只能 bootApp 一次（DATA_DIR 在模块加载时固定），所以本文件单独运行。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp, waitFor } from './_harness.mjs';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const readSessionFile = (dataDir, id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', `${id}.json`), 'utf8'));
const readLedger = (dataDir, day) => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'usage-ledger', `${day}.json`), 'utf8')); } catch { return null; }
};
const dayKey = (ts = Date.now()) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const tokensToday = (dataDir) => Number(readLedger(dataDir, dayKey())?.totalTokens) || 0;

let seq = 0;
/** 起一个会话并等到它真的进入 running（LLM 请求在途）。 */
async function startRunningSession(env, text, { delayMs = 4000 } = {}) {
  env.llm.state.script.length = 0;
  env.llm.state.script.push({ content: '（慢回复）', delayMs });
  seq += 1;
  env.pushGroupMsg(41915 + seq, '测试', text, `mid-${Date.now()}-${seq}`);
  const sessionId = await waitFor(() => {
    const s = env.app.sessions.listSummaries(20).find((e) => (e.trigger || '').includes(text));
    return s ? s.id : null;
  }, 9000, '会话创建');
  await waitFor(() => {
    const s = env.app.sessions.current.get(sessionId);
    return !!(s && s.status === 'running');
  }, 15000, '会话进入 running');
  return sessionId;
}

const env = await bootApp({ config: { wakeDelayMs: 100, drainDelayMs: 100 } });
const { app, dataDir } = env;

try {
  await check('B1. app.stop() 后 current 为空、flushPending 返回 0、账本有 token', async () => {
    const b1Id = await startRunningSession(env, 'B1组消息');
    // 显式给一个非零 usage：会话在 LLM 请求在途时被 abort，此刻还没累计任何 token，
    // 不显式赋值就断言不到“账本里留下了退出前的 usage”。
    const live = app.sessions.current.get(b1Id);
    live.usage = { promptTokens: 70, completionTokens: 30, totalTokens: 100, cachedTokens: 0, calls: 1 };
    const before = tokensToday(dataDir);
    await app.stop();
    const data = readSessionFile(dataDir, b1Id);
    assert.equal(data.status, 'aborted', '正常退出也必须 aborted');
    assert.equal(data.error, null);
    assert.ok(Number(data.usage?.totalTokens) > 0, 'mock 会话必须带显式非零 usage');
    assert.equal(app.sessions.current.size, 0, '会话已被 finish 移出 current');
    const settled = app.sessions.flushPending();
    assert.equal(settled, 0, 'B1 路径下 flushPending 必须返回 0（没有残留）');
    assert.ok(tokensToday(dataDir) - before > 0, '账本必须含该会话的 token');
  });
} finally {
  try { await env.teardown(); } catch { /* ignore */ }
}

console.log(`\n退出结算 B1（独立进程）：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
