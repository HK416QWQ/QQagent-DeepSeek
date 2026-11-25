// P0-01 附：重试时失效索引缓存条目（施工单 v2.15 §3.5 retry-cache-invalidate-test）
//
// 锁死四件事：
//   ① retrySession() 成功返回后，缓存 entries 不含该 id；
//   ② 失效发生在 update() 落盘之前（顺序断言）；
//   ③ 新顺序允许的两个崩溃窗口都能自愈；
//   ④ invalidate 抛错时 retrySession 仍返回 ok。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { bootApp, waitFor, sleep, createChecker, ROOT } from './_harness.mjs';

const { check, finish } = createChecker('重试失效索引缓存');

const env = await bootApp({
  config: { allow: { groups: ['456', '457', '458'], private: [] }, sessionRetryAttempts: 0 }
});
const { app, pushGroupMsg, waitSessionDone, dataDir } = env;
const CACHE = path.join(dataDir, 'session-index-cache.json');
const readCache = () => JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const cacheHas = (id) => readCache().entries.some((e) => e.id === id);

try {
  // 造两条失败会话（500 不重试：sessionRetryAttempts=0）
  const failOnce = async (mid, text, groupId) => {
    // LLM 层每个模型最多 3 次尝试（chatCompletionWithRetry 默认 retries=2），
    // 必须把这 3 发全部打成 500，否则第二发会用默认脚本成功收尾成 noreply。
    env.llm.state.forceStatus.push(500, 500, 500);
    pushGroupMsg(111, '张三', text, mid, { group_id: groupId });
    const s = await waitSessionDone(text, 20000);
    assert.equal(s.status, 'error', `应失败收尾，实际 ${s.status}`);
    return s;
  };
  const s1 = await failOnce(42001, '@覆盖Bot 失效用例一', 456);
  const s2 = await failOnce(42002, '@覆盖Bot 失效用例二', 457);

  await check('0. 两条失败会话都已写入索引缓存', async () => {
    app.sessions.flushIndexCache();
    assert.ok(cacheHas(s1.id), '缓存应含用例一');
    assert.ok(cacheHas(s2.id), '缓存应含用例二');
    return `${s1.id.slice(0, 8)} / ${s2.id.slice(0, 8)}`;
  });

  await check('1. retrySession 成功后缓存 entries 不含该 id', async () => {
    const r = app.orchestrator.retrySession(s1.id);
    assert.equal(r.ok, true, `重试应成功：${r.reason || ''}`);
    assert.ok(!cacheHas(s1.id), '失效后缓存不应再含该 id');
    assert.ok(cacheHas(s2.id), '不应误删其它会话的缓存条目');
    return '已失效';
  });

  await check('2. 顺序断言：失效发生在 update() 落盘之前', async () => {
    const calls = [];
    const realUpdate = app.sessions.update.bind(app.sessions);
    const realInvalidate = app.sessions.invalidateIndexCacheEntry.bind(app.sessions);
    const realCurrent = app.sessions.current.set.bind(app.sessions.current);
    app.sessions.update = (id) => { calls.push('update:' + id); return realUpdate(id); };
    app.sessions.invalidateIndexCacheEntry = (id) => { calls.push('invalidate:' + id); return realInvalidate(id); };
    app.sessions.current.set = (id, v) => { calls.push('set:' + id); return realCurrent(id, v); };
    try {
      const r = app.orchestrator.retrySession(s2.id);
      assert.equal(r.ok, true, `重试应成功：${r.reason || ''}`);
    } finally {
      app.sessions.update = realUpdate;
      app.sessions.invalidateIndexCacheEntry = realInvalidate;
      app.sessions.current.set = realCurrent;
    }
    // resetSessionForRetry 内部会先 update 一次（那时还没 current.set），
    // 顺序断言只针对 current.set 之后的那一对：set → invalidate → update。
    const iSet = calls.indexOf('set:' + s2.id);
    const iInv = calls.indexOf('invalidate:' + s2.id);
    const iUpd = calls.findIndex((c, i) => i > iSet && c === 'update:' + s2.id);
    assert.ok(iSet >= 0, `应有 current.set：${JSON.stringify(calls)}`);
    assert.ok(iInv > iSet, `失效必须在 current.set 之后：${JSON.stringify(calls)}`);
    assert.ok(iUpd > iInv, `失效必须先于 update()：${JSON.stringify(calls)}`);
    return calls.join(' → ');
  });

  await check('2b. 源码顺序：invalidate 位于 current.set 之后、update 之前', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'orchestrator.js'), 'utf8');
    const iSet = src.indexOf('this.sessions.current.set(id, s);');
    const iInv = src.indexOf('invalidateIndexCacheEntry(id)', iSet);
    const iUpd = src.indexOf('this.sessions.update(id);', iSet);
    assert.ok(iSet >= 0 && iInv > iSet && iUpd > iInv, `源码顺序不符：set=${iSet} inv=${iInv} upd=${iUpd}`);
    return '顺序正确';
  });

  await check('3. 崩溃窗口①：缓存无该 id + 磁盘终态 → missing 重读', async () => {
    // 直接构造：一条终态会话文件，缓存里没有它
    const id = 'crash-done-1';
    fs.writeFileSync(path.join(dataDir, 'sessions', `${id}.json`), JSON.stringify({
      id, chatKey: 'group:456', startedAt: Date.now() - 60000, endedAt: Date.now() - 50000,
      status: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, calls: 1 }
    }), 'utf8');
    const { SessionRegistry } = await import('../src/sessions.js');
    const reg = new SessionRegistry(0);
    const hit = reg.index.filter((e) => e.id === id);
    assert.equal(hit.length, 1, 'missing 补读应恢复该条');
    assert.equal(hit[0].status, 'done');
    return '已恢复';
  });

  await check('3b. 崩溃窗口②：缓存无该 id + 磁盘 running → 启动回收', async () => {
    const id = 'crash-run-1';
    fs.writeFileSync(path.join(dataDir, 'sessions', `${id}.json`), JSON.stringify({
      id, chatKey: 'group:456', startedAt: Date.now() - 60000, endedAt: null,
      status: 'running', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, calls: 1 }
    }), 'utf8');
    const { SessionRegistry } = await import('../src/sessions.js');
    const reg = new SessionRegistry(0);
    const hit = reg.index.filter((e) => e.id === id);
    assert.equal(hit.length, 1, '应出现在索引');
    assert.equal(hit[0].status, 'aborted', '应被回收为 aborted');
    return '已回收';
  });

  await check('4. invalidate 抛错时 retrySession 仍返回 ok', async () => {
    // 前两次重试的运行可能还在跑；它会抢走下面为 s3 准备的 500 响应，
    // 导致 s3 用默认脚本成功收尾成 noreply。先等运行清空并清掉残留状态码。
    await waitFor(() => app.sessions.current.size === 0, 20000, '前序重试会话收尾');
    await sleep(300);
    env.llm.state.forceStatus.length = 0;
    const s3 = await failOnce(42003, '@覆盖Bot 失效用例三', 458);
    app.sessions.flushIndexCache();
    const real = app.sessions.invalidateIndexCacheEntry;
    app.sessions.invalidateIndexCacheEntry = () => { throw new Error('模拟缓存写失败'); };
    let r;
    try { r = app.orchestrator.retrySession(s3.id); }
    finally { app.sessions.invalidateIndexCacheEntry = real; }
    assert.equal(r.ok, true, `抛错不应影响重试：${r.reason || ''}`);
    return '仍返回 ok';
  });
} finally {
  await env.teardown();
}

const code = finish();
process.exit(code ? 0 : 1);
