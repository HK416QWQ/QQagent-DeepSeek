// 并发满时的「等待中」会话不得重复创建（2026-11-15 刷屏事故回归）
//
// 事故现场：maxConcurrentRuns=2，同时有 3 个群有新消息。其中 2 个群先占满并发位，
// 第 3 个群每 3 秒重试一次；而重试走的是 `scheduleWake(chatKey, 0)` —— 此时
// `pendingSessions` 已被上一个 timer 清空，于是它每次都 `sessions.create` 一个新的
// waiting 会话。并发满持续 20 秒 → 同一个群刷出 20 个「等待中」，全部
// rounds=0 / messages=0（从未调过 LLM），UI 上就是满屏重复条目，且「中止」按钮
// 清不掉（它们已不在 pendingSessions 里，abortSession 找不到活对象）。
//
// 本用例锁死两件事：
//   ① 并发满期间，同一群**始终只有 1 个** waiting 会话；
//   ② 并发位释放后，它用**同一个**会话跑起来，不新建、不残留 waiting。

import assert from 'node:assert/strict';
import { bootApp, sleep, waitFor, createChecker } from './_harness.mjs';

const { check, finish } = createChecker('并发等待会话不重复创建');

const env = await bootApp({
  config: {
    allow: { groups: ['456', '999'], private: ['777'] },
    maxConcurrentRuns: 1          // 只留一个并发位：群 456 占住，群 999 必然撞满
  }
});
const { app, pushGroupMsg, llm } = env;

const listOf = (chatKey) => app.sessions.listSummaries(300).filter((s) => s.chatKey === chatKey);
const waitingOf = (chatKey) => listOf(chatKey).filter((s) => s.status === 'waiting');

try {
  // 群 456 的响应拖到 6 秒，稳稳占住唯一并发位，覆盖群 999 至少一轮 3 秒重试
  for (let i = 0; i < 30; i++) llm.state.script.push({ content: '（慢速响应）', delayMs: 6000 });

  await check('1. 群 456 先占住唯一的并发位', async () => {
    pushGroupMsg(111, '张三', '@覆盖Bot 占位', 41001);
    await waitFor(() => llm.state.requests.length >= 1, 8000, '群 456 开跑');
    return 'LLM 已被调用';
  });

  await check('2. 并发满期间群 999 只产生 1 个等待会话', async () => {
    pushGroupMsg(222, '李四', '@覆盖Bot B 组', 41002, { group_id: 999 });
    // 等它进入「等待中」（wakeDelayMs=200 → 撞并发满 → 续期 3 秒）
    await waitFor(() => waitingOf('group:999').length >= 1, 6000, '群 999 进入等待');
    // 观察 5 秒：跨过至少一轮 3 秒重试，而群 456 仍在跑（6 秒才结束）
    await sleep(5000);
    const n = waitingOf('group:999').length;
    assert.ok(n <= 1,
      `并发满期间应始终只有 1 个等待会话，实际 ${n} 个`
      + `（>1 = 每次 3 秒重试都新建了一个孤儿，就是 2026-11-15 的刷屏事故）`);
    return `观察 5 秒后仍是 ${n} 个`;
  });

  await check('3. 并发位释放后，群 999 用同一个会话跑起来且无 waiting 残留', async () => {
    await waitFor(
      () => listOf('group:999').some((s) => ['running', 'done', 'noreply', 'error'].includes(s.status)),
      25000, '群 999 开跑'
    );
    const all = listOf('group:999');
    assert.equal(all.length, 1, `群 999 应只有 1 个会话（复用它自己的等待会话），实际 ${all.length} 个`);
    await waitFor(() => waitingOf('group:999').length === 0, 15000, '群 999 waiting 收尾');
    return `会话数 ${all.length}，无 waiting 残留`;
  });
} finally {
  await env.teardown();
}

finish();
process.exit(process.exitCode || 0);
