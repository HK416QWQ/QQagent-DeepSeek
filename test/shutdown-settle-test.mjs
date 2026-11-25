// P0-05 退出结算 —— 专项测试（对应施工单 §7.5 的 12 条）。
//
// 为什么只启一个 app 实例：`src/config.js` 的 DATA_DIR 在模块加载时固定，
// 同一进程内第二次 bootApp 会读到第一个实例的数据目录（表现为 OneBot WS 连不上）。
// 因此本文件按“单实例顺序执行”：先跑不需要停服的 Orchestrator 层用例，
// 最后跑只碰 SessionRegistry 的用例。
//
// A 组：Orchestrator 层（真跑一个会话，mock 运行循环会响应 abort）。
// B1 组：正常收尾（会话被 abort 后自行 finish，flushPending 无活可干 → 0）。
//   ★ 2026-11-22 拆到 `shutdown-settle-b1-test.mjs` 独立进程：
//     它要与 B2 构造的卡死现场共用同一 orchestrator，实测约 25% 概率等不到 running。
//     拆分后本文件不再包含 B1；B1 的断言在独立文件里原样保留。
// B2 组：运行循环不响应 abort（直接构造 activeRuns 卡死态，超时后靠 flushPending 兜底）。
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
let stopped = false;

try {
  // ══ A 组：Orchestrator.shutdown ══
  await check('A. shutdown 打断在途请求、打完标记并等运行循环收尾', async () => {
    const id = await startRunningSession(env, 'A组消息');
    assert.ok(app.orchestrator.sessionAbortControllers.has(id), '应有在途 controller');
    const r = await app.orchestrator.shutdown({ timeoutMs: 3000 });
    assert.equal(r.timedOut, false, '运行循环应能在超时前退出');
    assert.equal(app.orchestrator.sessionAbortMarks.has(id), false, '标记应被收尾逻辑（wake 的 catch）自行清除');
    assert.equal(app.sessions.current.size, 0, 'current 应已清空');
    const data = readSessionFile(dataDir, id);
    assert.equal(data.status, 'aborted', '退出时必须 aborted 而不是 error');
    assert.equal(data.error, null, 'session.error 必须为 null');
    // 恢复可运行状态，供后续用例继续起会话（shutdown 把 aborted 置真了）
    app.orchestrator.aborted = false;
  });

  // ══ B2 组：运行循环不响应 abort（直接构造卡死态）══
  await check('B2. 运行循环卡死：shutdown 超时返回，flushPending 兜底 > 0', async () => {
    const s = app.sessions.create({ chatKey: 'group:999', trigger: 'message', triggerSummary: '卡死会话' });
    s.usage = { promptTokens: 80, completionTokens: 20, totalTokens: 100, cachedTokens: 0, calls: 1 };
    app.sessions.update(s.id);
    const before = tokensToday(dataDir);
    app.orchestrator.activeRuns.set('group:999', s.id);
    const ctrl = new AbortController();
    app.orchestrator.sessionAbortControllers.set(s.id, ctrl);

    const t0 = Date.now();
    const r = await app.orchestrator.shutdown({ timeoutMs: 100 });
    const elapsed = Date.now() - t0;
    assert.equal(ctrl.signal.aborted, true, 'controller 必须被 abort');
    assert.equal(r.timedOut, true, '运行循环不退出时必须报超时');
    assert.ok(elapsed >= 90, `shutdown 应等满 timeout（实际 ${elapsed}ms）`);
    assert.ok(elapsed < 1500, `shutdown 不得无限等（实际 ${elapsed}ms）`);
    assert.equal(app.sessions.current.has(s.id), true, '超时场景下会话仍在 current');

    const settled = app.sessions.flushPending();
    assert.ok(settled > 0, `flushPending 应兜底结算（实际 ${settled}）`);
    const data = readSessionFile(dataDir, s.id);
    assert.equal(data.status, 'aborted');
    assert.equal(data.error, null);
    assert.equal(tokensToday(dataDir) - before, 100, '账本应增加该会话的 100 token');
    app.orchestrator.activeRuns.clear();          // 清掉卡死现场
    app.orchestrator.sessionAbortControllers.delete(s.id);
    app.orchestrator.aborted = false;
  });

  // ══ 5. 重复 finish 返回 null 且不双计 ══
  await check('5. flushPending 后再 finish 返回 null，账本不双计', async () => {
    const s = app.sessions.create({ chatKey: 'group:998', trigger: 'message', triggerSummary: '重复收尾' });
    s.usage = { promptTokens: 40, completionTokens: 10, totalTokens: 50, cachedTokens: 0, calls: 1 };
    app.sessions.update(s.id);
    const before = tokensToday(dataDir);
    assert.equal(app.sessions.flushPending(), 1);
    const after = tokensToday(dataDir);
    assert.equal(after - before, 50);
    assert.equal(app.sessions.finish(s.id, 'aborted'), null, '重复 finish 必须返回 null');
    assert.equal(tokensToday(dataDir), after, '不得双计');
  });

  // ══ 6. 索引最终状态为 aborted ══
  await check('6. 索引条目最终状态为 aborted', async () => {
    const s = app.sessions.create({ chatKey: 'group:997', trigger: 'message', triggerSummary: '索引状态' });
    s.usage = { promptTokens: 10, completionTokens: 10, totalTokens: 20, cachedTokens: 0, calls: 1 };
    app.sessions.update(s.id);
    app.sessions.flushPending();
    const entry = app.sessions.index.find((e) => e.id === s.id);
    assert.ok(entry);
    assert.equal(entry.status, 'aborted');
    assert.ok(entry.endedAt, '必须有 endedAt');
  });

  // ══ 7. waiting 且零消耗 ══
  await check('7. waiting 零消耗：文件保留、aborted、零 token attempt 入账', async () => {
    const s = app.sessions.create({ chatKey: 'group:996', trigger: 'message', triggerSummary: '零消耗等待', status: 'waiting' });
    const before = tokensToday(dataDir);
    const runsBefore = Number(readLedger(dataDir, dayKey())?.runs) || 0;
    assert.equal(app.sessions.flushPending(), 1);
    const f = path.join(dataDir, 'sessions', `${s.id}.json`);
    assert.equal(fs.existsSync(f), true, '不能物理删除');
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).status, 'aborted');
    const l = readLedger(dataDir, dayKey());
    assert.equal(tokensToday(dataDir) - before, 0, '零消耗不加 token');
    assert.equal(Number(l.runs) - runsBefore, 0, '零消耗不计 runs');
    assert.ok(l.appliedAttempts.includes(`${s.id}:0`), '仍要写 appliedAttempts');
    assert.equal(app.sessions.index.find((e) => e.id === s.id).status, 'aborted');
  });

  // ══ 8. waiting 但已有消耗 ══
  await check('8. waiting 但已有消耗：flush 后 aborted，账本有 usage', async () => {
    const s = app.sessions.create({ chatKey: 'group:995', trigger: 'message', triggerSummary: '有消耗等待', status: 'waiting' });
    s.usage = { promptTokens: 30, completionTokens: 10, totalTokens: 40, cachedTokens: 0, calls: 1 };
    app.sessions.update(s.id);
    const before = tokensToday(dataDir);
    app.sessions.flushPending();
    assert.equal(readSessionFile(dataDir, s.id).status, 'aborted');
    assert.equal(tokensToday(dataDir) - before, 40);
  });

  // ══ 10. stop() 调两次 ══
  // B1（真实会话 + app.stop）已拆到 shutdown-settle-b1-test.mjs 独立进程执行：
  // 它需要在干净进程里真跑一次 LLM，与 B2 人为构造的卡死现场同进程会互相影响
  // （2026-11-22 实测约 25% 概率等不到 running，4 次全绿不足以证明稳定）。
  await check('10. app.stop() 调两次：flushPending 返回 0、账本不双计', async () => {
    await app.stop();
    stopped = true;
    const before = tokensToday(dataDir);
    assert.equal(app.sessions.flushPending(), 0, '第二次必须返回 0');
    let threw = false;
    try { await app.stop(); } catch { threw = true; }
    assert.equal(threw, false, '重复 stop 不应抛');
    assert.equal(tokensToday(dataDir), before, '不得重复写账');
  });

  // ══ 9. reset-data 仍走无参 abortAll；/api/pause 不走 abortAll ══
  await check('9a. reset-data 路径仍调用无参 abortAll()', async () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'routes.js'), 'utf8');
    const i = src.indexOf('/api/sessions/reset-data') >= 0 ? src.indexOf('/api/sessions/reset-data') : src.indexOf('/api/reset-data');
    assert.ok(i > 0, '应能定位 reset-data 路由');
    const block = src.slice(i, i + 1600);
    assert.ok(/orchestrator\.abortAll\(\)/.test(block), 'reset-data 必须仍用无参 abortAll()');
  });
  await check('9b. /api/pause 不经过 abortAll', async () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'routes.js'), 'utf8');
    const i = src.indexOf('/api/pause');
    assert.ok(i > 0);
    const block = src.slice(i, i + 800);
    assert.ok(/setPaused\(/.test(block), '暂停走 setPaused');
    assert.equal(/abortAll/.test(block), false, '暂停不得调用 abortAll');
  });

  // ══ 12. 账本读抛错（放在最后：会把今日账本写成坏文件）══
  await check('12. 账本读抛错时 flushPending 不中断，坏账入 pending、其余正常落盘', async () => {
    // 本用例与前面的用例共用同一份数据目录，今日账本里已有累计 token，
    // 因此只能断言“相对增量 40”，不能断言绝对值。
    const before = tokensToday(dataDir);
    const bad = app.sessions.create({ chatKey: 'group:993', trigger: 'message', triggerSummary: '坏账会话' });
    bad.usage = { promptTokens: 10, completionTokens: 10, totalTokens: 20, cachedTokens: 0, calls: 1 };
    app.sessions.update(bad.id);
    const good = app.sessions.create({ chatKey: 'group:992', trigger: 'message', triggerSummary: '正常会话' });
    good.usage = { promptTokens: 15, completionTokens: 5, totalTokens: 20, cachedTokens: 0, calls: 1 };
    app.sessions.update(good.id);
    // 把今日账本变成坏文件：读它会抛，写账之前也读
    fs.mkdirSync(path.join(dataDir, 'usage-ledger'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'usage-ledger', `${dayKey()}.json`), '{ 坏账本');
    let threw = false;
    let settled = 0;
    try { settled = app.sessions.flushPending(); } catch { threw = true; }
    assert.equal(threw, false, 'flushPending 不得抛出');
    assert.equal(settled, 2, '两条都要结算');
    for (const s of [bad, good]) {
      assert.equal(readSessionFile(dataDir, s.id).status, 'aborted', '会话文件必须正常落盘为 aborted');
    }
    const pendPath = path.join(dataDir, 'usage-pending.json');
    assert.equal(fs.existsSync(pendPath), true, '坏账必须进 pending');
    assert.ok(JSON.parse(fs.readFileSync(pendPath, 'utf8')).length >= 1);
    // 修好账本后再启动一次（模拟重启），pending 补写且不双计。
    // 注意：账本被删后由 `usage-today.json` 镜像恢复当日基线（迁移逻辑），
    // 因此补写前后的差值必须恰好是两条之和 40。
    fs.rmSync(path.join(dataDir, 'usage-ledger', `${dayKey()}.json`), { force: true });
    const { SessionRegistry } = await import('../src/sessions.js');
    new SessionRegistry(0);
    const after = tokensToday(dataDir);
    assert.equal(after - before, 40, `补写应只增加两条之和 40（before=${before} after=${after}）`);
  });
} finally {
  if (!stopped) { try { await env.teardown(); } catch { /* ignore */ } }
  else { try { env.onebotWs.close(); env.onebotHttp.server.close(); env.llm.server.close(); } catch { /* ignore */ } }
}

console.log(`\n退出结算（P0-05）：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
