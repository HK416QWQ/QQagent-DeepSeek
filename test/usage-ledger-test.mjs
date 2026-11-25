// P0-04 用量按天账本 + attempt 级幂等 —— 专项测试（对应施工单 §6.5 的 29 条）。
//
// 时钟由本文件注入（改 `Date.now` 的返回值，不动系统时间）：
// 跨零点、60 秒、90 秒这类判定只靠注入时钟才测得稳。
//
// 说明（与本单不一致之处，已在施工完结单标注）：
//   §6.5 第 10 条要求“模拟第 1 次抛可重试错误、usage=100、2 条 raw 后触发
//   #resetSessionForRetry”。现场 mock LLM（test/_harness.mjs）每次请求先查
//   forceStatus，无法造出“先成功累计 usage、后失败抛错”的同一次运行，
//   因此该条的**数值部分**在账本层验证（attempt 级累加、幂等键换代），
//   **插入点位置**用源码顺序断言（结算必须出现在 `live.messages = []` 之前）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 输出收敛：被测代码会打大量 [usage]/[telemetry] 日志 ──
const out = [];
const say = (s) => out.push(s);
const realLog = console.log, realErr = console.error, realWarn = console.warn;
let logBuf = [];
console.log = (...a) => logBuf.push(a.join(' '));
console.error = (...a) => logBuf.push(a.join(' '));
console.warn = (...a) => logBuf.push(a.join(' '));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-ledger-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  api: { baseUrl: '', apiKey: '', model: 'test-model' },
  server: { port: 3399 }
}));

// ── 注入时钟 ──
const at = (y, m, d, h, mi, s = 0) => new Date(y, m - 1, d, h, mi, s).getTime();
let NOW = at(2026, 11, 21, 12, 0);
const realNow = Date.now;
Date.now = () => NOW;

const { SessionRegistry } = await import('../src/sessions.js');
const telemetry = await import('../src/telemetry.js');

const SESSIONS = path.join(dataDir, 'sessions');
const LEDGER = path.join(dataDir, 'usage-ledger');
const PENDING = path.join(dataDir, 'usage-pending.json');
const MIRROR = path.join(dataDir, 'usage-today.json');
const TOTALS = path.join(dataDir, 'telemetry-totals.json');
const CACHE = path.join(dataDir, 'session-index-cache.json');

let pass = 0, fail = 0;
const check = async (name, fn) => {
  logBuf = [];
  try { await fn(); pass++; say(`  ✓ ${name}`); }
  catch (e) {
    fail++;
    say(`  ✗ ${name}\n      ${e.message}`);
    if (logBuf.length) say('      --- 日志 ---\n      ' + logBuf.slice(-12).join('\n      '));
  }
};

const dayKeyOf = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const ledgerOf = (day) => readJson(path.join(LEDGER, `${day}.json`));
const writeSession = (id, obj) => {
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS, `${id}.json`), JSON.stringify(obj, null, 1));
};
const readSession = (id) => readJson(path.join(SESSIONS, `${id}.json`));

const wipe = () => {
  for (const p of [SESSIONS, LEDGER]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
  for (const f of [PENDING, MIRROR, TOTALS, CACHE]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
};
const newReg = () => { wipe(); return new SessionRegistry(0); };

const usage = (total, calls = 1, cached = 0) => ({
  promptTokens: Math.round(total * 0.8),
  completionTokens: total - Math.round(total * 0.8),
  totalTokens: total,
  cachedTokens: cached,
  calls
});
const rawMsg = (p, c) => ({ role: 'assistant', content: 'x', raw: { usage: { prompt_tokens: p, completion_tokens: c } } });

const adopt = (reg, id) => {
  const s = reg.get(id);
  assert.ok(s, `会话 ${id} 应存在于磁盘`);
  reg.current.set(id, s);
  return s;
};

// ══ 1. 跨零点：只记到结束日，且不覆盖其他日 ══
await check('1. 23:50 开始、00:10 结束的会话只记到结束日', () => {
  wipe();
  NOW = at(2026, 11, 21, 23, 50);
  let reg = new SessionRegistry(0);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.usage = usage(100);
  s.webSearchCount = 1;
  NOW = at(2026, 11, 22, 0, 10);          // 跨过零点才结束
  reg.finish(s.id, 'done');
  const d21 = dayKeyOf(at(2026, 11, 21, 12, 0));
  const d22 = dayKeyOf(NOW);
  assert.equal(fs.existsSync(path.join(LEDGER, `${d21}.json`)), false, '开始日不应有账本');
  assert.equal(ledgerOf(d22).totalTokens, 100, '必须记到结束日');
});

// ══ 2. 重复终态收尾只记一次 ══
await check('2. 同一 attempt 重复结算只加一次', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.usage = usage(100);
  reg.finish(s.id, 'done');
  const day = dayKeyOf(NOW);
  assert.equal(ledgerOf(day).totalTokens, 100);
  // 再结算两次（模拟重复收尾 / 重启后再次结算）
  assert.equal(reg.settleAttempt(s, s.endedAt), true);
  reg.settleAttempt(s, s.endedAt);
  assert.equal(ledgerOf(day).totalTokens, 100, '重复结算不得双计');
  assert.equal(ledgerOf(day).runs, 1);
});

// ══ 3. 僵尸回收：三个入口 + endedAt 三级 guard ══
const zombieCase = (name, { startedAt, endedAt, mtime }, expectDay) => async () => {
  wipe();
  const id = 'zb-1';
  writeSession(id, {
    id, chatKey: 'group:1', startedAt, endedAt: endedAt ?? null, status: 'running',
    trigger: 'message', triggerSummary: 't', messages: [], sent: [],
    usage: usage(60), webSearchCount: 0
  });
  if (mtime) {
    const sec = Math.floor(mtime / 1000);
    fs.utimesSync(path.join(SESSIONS, `${id}.json`), sec, sec);
  }
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const data = readSession(id);
  assert.equal(data.status, 'aborted');
  assert.equal(data.accountPending, false, '记账成功后必须清 accountPending');
  assert.equal(data.abortedOnBoot, true);
  assert.equal(ledgerOf(expectDay).totalTokens, 60, `应记到 ${expectDay}`);
  assert.ok(reg.index.find((e) => e.id === id), '索引里应有该条目');
};
await check('3a. 僵尸回收：data.endedAt 有效时用它（慢路径入口）',
  zombieCase('3a', { startedAt: at(2026, 11, 20, 10, 0), endedAt: at(2026, 11, 20, 11, 0), mtime: at(2026, 11, 21, 9, 0) }, dayKeyOf(at(2026, 11, 20, 11, 0))));
await check('3b. 僵尸回收：data.endedAt 早于本次 startedAt 时忽略，改用 mtime',
  zombieCase('3b', { startedAt: at(2026, 11, 20, 10, 0), endedAt: at(2026, 11, 19, 10, 0), mtime: at(2026, 11, 20, 15, 0) }, dayKeyOf(at(2026, 11, 20, 15, 0))));
await check('3c. 僵尸回收：两者都越界时回退 Date.now()',
  zombieCase('3c', { startedAt: at(2026, 11, 21, 10, 0), endedAt: null, mtime: at(2026, 11, 20, 10, 0) }, dayKeyOf(at(2026, 11, 21, 12, 0))));

await check('3d. 僵尸回收：缓存缺失入口（missing）也补记一次', () => {
  wipe();
  const id = 'zb-miss';
  writeSession(id, {
    id, chatKey: 'group:1', startedAt: at(2026, 11, 21, 9, 0), endedAt: null, status: 'running',
    trigger: 'message', triggerSummary: 't', messages: [], sent: [], usage: usage(30)
  });
  NOW = at(2026, 11, 21, 12, 0);
  // 先建一次索引缓存（把这个文件排除在外），再新增文件 → 走 missing 分支
  const reg1 = new SessionRegistry(0);
  assert.ok(reg1.index.length === 1);
  // 手工把缓存里的条目清空，模拟“磁盘有、缓存无”
  fs.writeFileSync(CACHE, JSON.stringify({ version: 1, savedAt: 0, entries: [] }));
  fs.rmSync(path.join(LEDGER, `${dayKeyOf(NOW)}.json`), { force: true });
  const reg2 = new SessionRegistry(0);
  assert.equal(readSession(id).accountPending, false);
  assert.equal(ledgerOf(dayKeyOf(NOW)).totalTokens, 30, 'missing 分支必须补记');
  void reg2;
});

// ══ 4/6. 零消耗 waiting：改判 aborted、保留文件、runs=0 但仍写 appliedAttempts ══
await check('4/6. 零消耗 waiting 改判 aborted、文件保留、runs=0、appliedAttempts 写入', () => {
  wipe();
  const id = 'zw-1';
  writeSession(id, {
    id, chatKey: 'group:1', startedAt: at(2026, 11, 21, 9, 0), endedAt: null, status: 'waiting',
    trigger: 'message', triggerSummary: 't', messages: [], sent: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
  });
  NOW = at(2026, 11, 21, 12, 0);
  new SessionRegistry(0);
  assert.equal(fs.existsSync(path.join(SESSIONS, `${id}.json`)), true, '不能物理删除');
  const data = readSession(id);
  assert.equal(data.status, 'aborted');
  const l = ledgerOf(dayKeyOf(NOW));
  assert.equal(l.runs, 0, '零消耗不计 runs');
  assert.equal(l.totalTokens, 0);
  assert.ok(l.appliedAttempts.includes(`${id}:0`), '仍要写 appliedAttempts');
});

// ══ 5. 旧终态会话无基线：只设基线，不补记 ══
await check('5. 旧终态会话只设基线、不补记', () => {
  wipe();
  const id = 'old-1';
  writeSession(id, {
    id, chatKey: 'group:1', startedAt: at(2026, 11, 20, 9, 0), endedAt: at(2026, 11, 20, 9, 30),
    status: 'done', trigger: 'message', triggerSummary: 't', messages: [rawMsg(10, 5)], sent: [],
    usage: usage(40)
  });
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  assert.equal(reg.index.length, 1);
  assert.equal(fs.existsSync(path.join(LEDGER, `${dayKeyOf(at(2026, 11, 20, 9, 30))}.json`)), false, '不应产生账本');
  // 直接结算一次（模拟旧会话被结算）：只设基线
  const s = reg.get(id);
  assert.equal(reg.settleAttempt(s, s.endedAt), true);
  assert.equal(ledgerOf(dayKeyOf(s.endedAt)).totalTokens, 0, '旧终态不补记');
  assert.ok(ledgerOf(dayKeyOf(s.endedAt)).appliedAttempts.includes(`${id}:0`));
  assert.deepEqual(s.accountedUsage.totalTokens, 40, '基线为当前 usage');
});

// ══ 7. telemetry 的 calls/toolCounts 每个 attempt 只加一次 ══
await check('7. telemetry calls/toolCounts 每个 attempt 只加一次', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.messages = [rawMsg(10, 5), rawMsg(20, 5), { toolCall: { name: 'send_message' } }, { toolCall: { name: 'send_message' } }];
  s.usage = usage(100, 2);
  reg.finish(s.id, 'done');
  let t = readJson(TOTALS);
  assert.equal(t.calls, 2, 'calls 按带 usage 的 raw 条数');
  assert.equal(t.toolCounts.send_message, 2);
  // 重复结算不重复加
  reg.settleAttempt(s, s.endedAt);
  t = readJson(TOTALS);
  assert.equal(t.calls, 2);
  assert.equal(t.toolCounts.send_message, 2);
});

// ══ 8. 迁移旧 usage-today.json ══
await check('8. 迁移后 todayUsage 与账本一致，镜像仍存在且 dayKey 正确', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const day = dayKeyOf(NOW);
  fs.writeFileSync(MIRROR, JSON.stringify({
    dayKey: day, promptTokens: 70, completionTokens: 30, totalTokens: 100, cachedTokens: 5, runs: 3, webSearchCount: 2
  }));
  const reg = new SessionRegistry(0);
  const l = ledgerOf(day);
  assert.equal(l.totalTokens, 100);
  assert.equal(l.runs, 3);
  assert.equal(l.webSearchCount, 2);
  assert.equal(l.migratedFrom, 'usage-today.json');
  assert.equal(l.llmCallsComplete, false);
  assert.equal(l.llmCalls, 0, '迁移不补算 llmCalls');
  const tu = reg.todayUsage(day);
  assert.equal(tu.totalTokens, 100, 'todayUsage 必须读账本');
  const mir = readJson(MIRROR);
  assert.equal(mir.dayKey, day, '镜像仍在且 dayKey 为迁移日（回滚兼容）');
});

// ══ 9. 联网搜索按 attempt 记 ══
await check('9. 同一会话两次 attempt 各 1 次 web_search → webSearchCount=2', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  const day = dayKeyOf(NOW);
  s.usage = usage(100);
  s.webSearchCount = 1;
  reg.finish(s.id, 'error');
  // 重试：attemptSeq 换代（与 #resetSessionForRetry 同语义）
  reg.current.set(s.id, s);
  reg.settleAttempt(s, s.endedAt);
  s.attemptSeq = 1;
  s.accountedUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
  s.accountedRuns = 0;
  s.accountedWebSearchCount = 0;
  s.usage = usage(50);
  s.webSearchCount = 1;
  reg.finish(s.id, 'done');
  const l = ledgerOf(day);
  assert.equal(l.webSearchCount, 2, '每次 attempt 各记 1 次');
  assert.equal(l.totalTokens, 150);
  assert.equal(l.runs, 2, 'runs 按 attempt 计');
});

// ══ 10. 自动重试：结算点在 messages 清空之前（源码顺序断言） ══
await check('10a. 结算调用出现在 live.messages = [] 之前', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'orchestrator.js'), 'utf8');
  const start = src.indexOf('#resetSessionForRetry(session) {');
  assert.ok(start > 0, '应能定位方法体');
  const body = src.slice(start, start + 2000);
  const iSettle = body.indexOf('settleAttempt(');
  const iClear = body.indexOf('live.messages = [];');
  assert.ok(iSettle > 0, '必须调用 settleAttempt');
  assert.ok(iClear > 0, '必须仍有 live.messages = []');
  assert.ok(iSettle < iClear, '结算必须在清空 messages 之前（否则 llmCalls/toolCounts 永久少记）');
  const iBump = body.indexOf('live.attemptSeq = (Number(live.attemptSeq) || 0) + 1');
  assert.ok(iBump > iSettle, 'attemptSeq 换代必须在结算之后');
});

await check('10b. attempt 级累加：两段消耗合计、runs=2、ap pendAttempts 两个键', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const day = dayKeyOf(NOW);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.messages = [rawMsg(60, 20), rawMsg(10, 10)];
  s.usage = usage(100, 2);
  // 自动重试路径不经过 finish：直接结算 + 换代
  assert.equal(reg.settleAttempt(s), true);
  assert.equal(ledgerOf(day).totalTokens, 100, '清空前必须已入账');
  assert.equal(ledgerOf(day).runs, 1);
  assert.equal(readJson(TOTALS).calls, 2, 'telemetry 已按 messages 计入 2 次');
  s.attemptSeq = 1;
  s.accountedUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
  s.accountedRuns = 0;
  s.accountedWebSearchCount = 0;
  s.messages = [];
  s.usage = usage(50);
  reg.finish(s.id, 'done');
  const l = ledgerOf(day);
  assert.equal(l.totalTokens, 150, '两次 attempt 合计');
  assert.equal(l.runs, 2);
  assert.ok(l.appliedAttempts.includes(`${s.id}:0`) && l.appliedAttempts.includes(`${s.id}:1`));
});

// ══ 11. 同日手动重试 ══
await check('11. 同日手动重试：attempt0=100 + attempt1=50 → 150 / runs2', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const day = dayKeyOf(NOW);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.usage = usage(100);
  reg.finish(s.id, 'error');
  assert.equal(ledgerOf(day).totalTokens, 100);
  // 手动重试：先结算（幂等命中 attempt0），再换代
  reg.current.set(s.id, s);
  assert.equal(reg.settleAttempt(s, s.endedAt), true);
  s.attemptSeq = 1;
  s.accountedUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
  s.accountedRuns = 0;
  s.accountedWebSearchCount = 0;
  s.usage = usage(50);
  reg.finish(s.id, 'done');
  const l = ledgerOf(day);
  assert.equal(l.totalTokens, 150);
  assert.equal(l.runs, 2);
});

// ══ 12. 跨日重试 ══
await check('12. 跨日重试：昨日账本不变，今日只加 50', () => {
  wipe();
  NOW = at(2026, 11, 21, 23, 0);
  const reg = new SessionRegistry(0);
  const yDay = dayKeyOf(NOW);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.usage = usage(100);
  reg.finish(s.id, 'error');
  assert.equal(ledgerOf(yDay).totalTokens, 100);
  NOW = at(2026, 11, 22, 0, 30);
  const tDay = dayKeyOf(NOW);
  reg.current.set(s.id, s);
  reg.settleAttempt(s);                   // 自动重试路径：endedAt 为 null → 取当前时间
  s.attemptSeq = 1;
  s.accountedUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
  s.accountedRuns = 0;
  s.accountedWebSearchCount = 0;
  s.usage = usage(50);
  reg.finish(s.id, 'done');
  assert.equal(ledgerOf(yDay).totalTokens, 100, '昨日账本不得变化');
  assert.equal(ledgerOf(tDay).totalTokens, 50, '今日只加第二次 attempt');
});

// ══ 13. 旧 id 重试后崩溃：按 attemptSeq=1 补记 ══
await check('13. 重试后崩溃：按 attemptSeq=1 补记，不重复 attempt0', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const day = dayKeyOf(NOW);
  // 先写一本已含 id:0 的账本
  fs.mkdirSync(LEDGER, { recursive: true });
  fs.writeFileSync(path.join(LEDGER, `${day}.json`), JSON.stringify({
    version: 1, day, promptTokens: 80, completionTokens: 20, totalTokens: 100, cachedTokens: 0,
    runs: 1, webSearchCount: 0, llmCalls: 0, toolCounts: {}, appliedAttempts: ['crash-1:0']
  }));
  // 崩溃现场：running 文件里 attemptSeq 已是 1
  writeSession('crash-1', {
    id: 'crash-1', chatKey: 'group:1', startedAt: at(2026, 11, 21, 11, 0), endedAt: null,
    status: 'running', trigger: 'message', triggerSummary: 't', messages: [], sent: [],
    usage: usage(70), attemptSeq: 1
  });
  new SessionRegistry(0);
  const l = ledgerOf(day);
  assert.equal(l.totalTokens, 170, 'attempt0 的 100 保持 + attempt1 的 70');
  assert.ok(l.appliedAttempts.includes('crash-1:1'), '必须按 attempt 1 记账');
  assert.equal(l.appliedAttempts.filter((k) => k.startsWith('crash-1:')).length, 2, '两个 attempt 各一条');
});

// ══ 14. 写账失败 → pending；读账失败也不抛 ══
await check('14a. 写账失败进 pending，补写一次且重复 flush 不双计', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const day = dayKeyOf(NOW);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.messages = [rawMsg(60, 20)];
  s.usage = usage(100);
  s.webSearchCount = 2;
  // 让账本写盘失败
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (p, ...rest) {
    if (/usage-ledger[\\/]/.test(String(p))) { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; }
    return realWrite.call(this, p, ...rest);
  };
  try { reg.finish(s.id, 'done'); } finally { fs.writeFileSync = realWrite; }
  const pend = readJson(PENDING);
  assert.equal(Array.isArray(pend) && pend.length, 1, '必须留下一条快照');
  assert.equal(pend[0].attemptKey, `${s.id}:0`);
  assert.equal(pend[0].llmCalls, 1);
  assert.equal(pend[0].webSearchDelta, 2);
  assert.equal(fs.existsSync(path.join(LEDGER, `${day}.json`)), false, '账本没写成');
  // 下次启动 flush
  const reg2 = new SessionRegistry(0);
  const l = ledgerOf(day);
  assert.equal(l.totalTokens, 100, '补写成功');
  assert.equal(l.webSearchCount, 2);
  assert.equal(l.llmCalls, 1);
  assert.deepEqual(readJson(PENDING), [], '成功项已移除');
  // 重复 flush 不双计
  reg2.settleAttempt(s, s.endedAt);
  assert.equal(ledgerOf(day).totalTokens, 100);
});

await check('14b. 读账本抛错：不向上抛、返回 false、可入 pending', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const day = dayKeyOf(NOW);
  fs.mkdirSync(LEDGER, { recursive: true });
  fs.writeFileSync(path.join(LEDGER, `${day}.json`), '{ 坏 JSON');
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.usage = usage(80);
  let threw = false;
  let ret;
  try { ret = reg.settleAttempt(s, NOW); } catch { threw = true; }
  assert.equal(threw, false, '不得向上抛');
  assert.equal(ret, false, '失败返回 false');
  const pend = readJson(PENDING);
  assert.equal(pend.length, 1, '能入 pending 的按 pending 处理');
  assert.equal(pend[0].usage.totalTokens, 80);
});

// ══ 15. 运行中叠加 ══
await check('15. todayUsage = 账本 + 运行中实时；终态后不双计', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const day = dayKeyOf(NOW);
  const a = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  a.usage = usage(100);
  reg.finish(a.id, 'done');
  const b = reg.create({ chatKey: 'group:2', trigger: 'message', triggerSummary: 't' });
  b.usage = usage(40);
  assert.equal(reg.todayUsage(day).totalTokens, 140, '账本 100 + 实时 40');
  reg.finish(b.id, 'done');
  assert.equal(reg.todayUsage(day).totalTokens, 140, '终态后不得双计');
});

// ══ 16. 多日账本隔离 ══
await check('16. 连续三天互不覆盖', () => {
  wipe();
  const days = [at(2026, 11, 19, 12, 0), at(2026, 11, 20, 12, 0), at(2026, 11, 21, 12, 0)];
  NOW = days[0];
  const reg = new SessionRegistry(0);
  let i = 1;
  for (const ts of days) {
    NOW = ts;
    const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
    s.usage = usage(100 * i);
    reg.finish(s.id, 'done');
    i += 1;
  }
  assert.equal(ledgerOf(dayKeyOf(days[0])).totalTokens, 100);
  assert.equal(ledgerOf(dayKeyOf(days[1])).totalTokens, 200);
  assert.equal(ledgerOf(dayKeyOf(days[2])).totalTokens, 300);
});

// ══ 17 / 24. 跨零点崩溃双计（全局索引拦截）══
await check('17/24. 昨日 mtime 的 running 僵尸，今日账本已含其 attempt0 → 不写第二本账', () => {
  wipe();
  const yTs = at(2026, 11, 21, 23, 59);
  const tTs = at(2026, 11, 22, 10, 0);
  const yDay = dayKeyOf(yTs);
  const tDay = dayKeyOf(tTs);
  const id = 'xmid-1';
  fs.mkdirSync(LEDGER, { recursive: true });
  fs.writeFileSync(path.join(LEDGER, `${tDay}.json`), JSON.stringify({
    version: 1, day: tDay, promptTokens: 80, completionTokens: 20, totalTokens: 100, cachedTokens: 0,
    runs: 1, webSearchCount: 0, llmCalls: 1, toolCounts: {}, appliedAttempts: [`${id}:0`]
  }));
  writeSession(id, {
    id, chatKey: 'group:1', startedAt: yTs, endedAt: null, status: 'running',
    trigger: 'message', triggerSummary: 't', messages: [], sent: [], usage: usage(100)
  });
  fs.utimesSync(path.join(SESSIONS, `${id}.json`), Math.floor(yTs / 1000), Math.floor(yTs / 1000));
  NOW = tTs;
  new SessionRegistry(0);
  assert.equal(fs.existsSync(path.join(LEDGER, `${yDay}.json`)), false, '不得写出第二本账');
  assert.equal(ledgerOf(tDay).totalTokens, 100, '既有账本不变');
});

// ══ 18. 迁移顺序（迁移先于 #loadIndex 的僵尸结算）══
await check('18. 迁移先发生，随后僵尸记账不覆盖账本', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const day = dayKeyOf(NOW);
  fs.writeFileSync(MIRROR, JSON.stringify({
    dayKey: day, promptTokens: 50, completionTokens: 50, totalTokens: 100, cachedTokens: 0, runs: 1, webSearchCount: 0
  }));
  const id = 'mg-1';
  writeSession(id, {
    id, chatKey: 'group:1', startedAt: at(2026, 11, 21, 10, 0), endedAt: at(2026, 11, 21, 10, 30),
    status: 'running', trigger: 'message', triggerSummary: 't', messages: [], sent: [], usage: usage(30)
  });
  new SessionRegistry(0);
  const l = ledgerOf(day);
  assert.equal(l.migratedFrom, 'usage-today.json', '迁移必须先发生');
  assert.equal(l.totalTokens, 130, '旧数据 100 + 僵尸 30');
});

// ══ 19. P0-01 中间态 accountPending 补记 + 索引/缓存同步 ══
await check('19. accountPending 补记一次，index 与缓存都变 false', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const day = dayKeyOf(NOW);
  const id = 'ap-1';
  writeSession(id, {
    id, chatKey: 'group:1', startedAt: at(2026, 11, 21, 9, 0), endedAt: at(2026, 11, 21, 9, 30),
    status: 'aborted', abortedOnBoot: true, accountPending: true, attemptSeq: 0,
    trigger: 'message', triggerSummary: 't', messages: [], sent: [], usage: usage(70)
  });
  const reg = new SessionRegistry(0);
  assert.equal(readSession(id).accountPending, false, '文件里的标记必须清掉');
  assert.equal(ledgerOf(day).totalTokens, 70, '补记一次');
  const entry = reg.index.find((e) => e.id === id);
  assert.ok(entry, '索引应有该条');
  assert.equal(entry.accountPending, false, 'index 里的 summary 必须同步为 false');
  reg.flushIndexCache();
  const cached = readJson(CACHE).entries.find((e) => e.id === id);
  assert.ok(cached, '缓存里应有该条');
  assert.equal(cached.accountPending, false, '缓存条目也必须为 false');
  // 第二次启动不再补记
  const before = ledgerOf(day).totalTokens;
  new SessionRegistry(0);
  assert.equal(ledgerOf(day).totalTokens, before, '第二次启动不得重复补记');
});

// ══ 20. 历史旧终态不补 ══
await check('20. 历史旧终态（无 accountPending）不自动补记', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const id = 'hist-1';
  writeSession(id, {
    id, chatKey: 'group:1', startedAt: at(2026, 10, 1, 9, 0), endedAt: at(2026, 10, 1, 9, 30),
    status: 'aborted', abortedOnBoot: true, trigger: 'message', triggerSummary: 't',
    messages: [], sent: [], usage: usage(999)
  });
  const reg = new SessionRegistry(0);
  assert.equal(reg.index.length, 1);
  assert.equal(fs.existsSync(path.join(LEDGER, `${dayKeyOf(at(2026, 10, 1, 9, 30))}.json`)), false);
});

// ══ 21. 全局索引重建 ══
await check('21. 重启后从全部账本重建 appliedIndex，重复结算仍只一次', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.usage = usage(100);
  reg.finish(s.id, 'done');
  const day = dayKeyOf(NOW);
  // 重启
  const reg2 = new SessionRegistry(0);
  const s2 = reg2.get(s.id);
  reg2.settleAttempt(s2, s2.endedAt);
  assert.equal(ledgerOf(day).totalTokens, 100, '重启后仍不得双计');
});

// ══ 22. 镜像只写今天 + 全量快照 ══
await check('22a. 旧日僵尸今日补记：旧日账本更新、镜像仍只反映今天', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const tDay = dayKeyOf(NOW);
  const yDay = dayKeyOf(at(2026, 11, 20, 12, 0));
  // 先造一笔今天的正常结算，让镜像有今天的数值
  {
    const reg = new SessionRegistry(0);
    const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
    s.usage = usage(100);
    reg.finish(s.id, 'done');
  }
  const mirBefore = readJson(MIRROR);
  assert.equal(mirBefore.dayKey, tDay);
  assert.equal(mirBefore.totalTokens, 100);
  // 再放一个昨日 running 僵尸（endedAt / mtime 都在昨天）→ 今日启动补记
  writeSession('old-zb', {
    id: 'old-zb', chatKey: 'group:1', startedAt: at(2026, 11, 20, 9, 0), endedAt: at(2026, 11, 20, 9, 30),
    status: 'running', trigger: 'message', triggerSummary: 't', messages: [], sent: [], usage: usage(40)
  });
  new SessionRegistry(0);
  assert.equal(ledgerOf(yDay).totalTokens, 40, '旧日账本被更新');
  const mir = readJson(MIRROR);
  assert.equal(mir.dayKey, tDay, '镜像 dayKey 必须是今天');
  assert.equal(mir.totalTokens, 100, '旧日补记不得污染今天镜像');
});

await check('22a2. 昨日会话跨零点今日 finish：按结束日只记今天', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const yStart = at(2026, 11, 20, 23, 50);
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.startedAt = yStart;
  s.usage = usage(100);
  NOW = at(2026, 11, 22, 0, 10);          // 跨零点结束
  reg.finish(s.id, 'done');
  const yDay = dayKeyOf(yStart);
  const tDay = dayKeyOf(NOW);
  assert.equal(fs.existsSync(path.join(LEDGER, `${yDay}.json`)), false, '开始日不得有账本');
  assert.equal(ledgerOf(tDay).totalTokens, 100, '按结束日归到今天');
  assert.equal(readJson(MIRROR).dayKey, tDay);
  assert.equal(readJson(MIRROR).totalTokens, 100);
});

await check('22b. 镜像内容是账本全量快照（不是本次 delta）', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const reg = new SessionRegistry(0);
  const day = dayKeyOf(NOW);
  const a = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  a.usage = usage(100, 1, 10);
  a.webSearchCount = 2;
  reg.finish(a.id, 'done');
  const b = reg.create({ chatKey: 'group:2', trigger: 'message', triggerSummary: 't' });
  b.usage = usage(50);
  reg.finish(b.id, 'done');
  const l = ledgerOf(day);
  const mir = readJson(MIRROR);
  assert.equal(mir.dayKey, l.day, 'dayKey 与账本 day 一致');
  for (const k of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'runs', 'webSearchCount']) {
    assert.equal(mir[k], l[k], `镜像字段 ${k} 必须等于账本全量值`);
  }
  assert.equal(mir.totalTokens, 150, '第二次写镜像时是 150，不是 delta 50');
  assert.equal(mir.appliedAttempts, undefined, '镜像不得带内部字段');
});

// ══ 23. telemetry 重建不双计 ══
await check('23. totals 重建：账本日不扫会话文件，只补更早的历史', () => {
  wipe();
  const d20 = at(2026, 11, 20, 12, 0);
  const d19 = at(2026, 11, 19, 12, 0);
  fs.mkdirSync(LEDGER, { recursive: true });
  fs.writeFileSync(path.join(LEDGER, `${dayKeyOf(d20)}.json`), JSON.stringify({
    version: 1, day: dayKeyOf(d20), promptTokens: 80, completionTokens: 20, totalTokens: 100, cachedTokens: 0,
    runs: 1, webSearchCount: 0, llmCalls: 1, toolCounts: {}, appliedAttempts: ['l20:0']
  }));
  // 同一天（11-20）的会话文件写一个不可能的 9999：绝不能被计入
  writeSession('same-day', {
    id: 'same-day', chatKey: 'group:1', startedAt: d20, endedAt: d20 + 1000, status: 'done',
    trigger: 'message', triggerSummary: 't', messages: [rawMsg(9999, 0)], sent: [], usage: usage(9999)
  });
  // 更早的会话文件（11-19）补一次旧基数
  writeSession('older', {
    id: 'older', chatKey: 'group:1', startedAt: d19, endedAt: d19 + 1000, status: 'done',
    trigger: 'message', triggerSummary: 't', messages: [], sent: [], usage: usage(40)
  });
  // 跨零点会话：startedAt=11-19 23:50、endedAt=11-20 00:10 → 按 endedAt 归 11-20，不计入旧基数
  const xStart = at(2026, 11, 19, 23, 50);
  const xEnd = at(2026, 11, 20, 0, 10);
  writeSession('xday', {
    id: 'xday', chatKey: 'group:1', startedAt: xStart, endedAt: xEnd, status: 'done',
    trigger: 'message', triggerSummary: 't', messages: [], sent: [], usage: usage(7)
  });
  NOW = at(2026, 11, 21, 12, 0);
  const t = telemetry.ensureTelemetryTotals(() => {});
  assert.equal(t.totalTokens, 140, '账本 100 + 更早历史 40（9999 与跨零点 7 都不计入）');
});

// ══ 25. 迁移日 telemetry 已知少计 ══
await check('25. 迁移账本：token 取账本、该日会话文件不补扫、日志含 incomplete', () => {
  wipe();
  const day = dayKeyOf(at(2026, 11, 21, 12, 0));
  fs.mkdirSync(LEDGER, { recursive: true });
  fs.writeFileSync(path.join(LEDGER, `${day}.json`), JSON.stringify({
    version: 1, day, promptTokens: 80, completionTokens: 20, totalTokens: 100, cachedTokens: 0,
    runs: 1, webSearchCount: 2, llmCalls: 0, toolCounts: {},
    appliedAttempts: [], migratedFrom: 'usage-today.json', llmCallsComplete: false
  }));
  writeSession('mig-day', {
    id: 'mig-day', chatKey: 'group:1', startedAt: at(2026, 11, 21, 9, 0), endedAt: at(2026, 11, 21, 9, 30),
    status: 'done', trigger: 'message', triggerSummary: 't',
    messages: [rawMsg(10, 5), { toolCall: { name: 'send_message' } }], sent: [], usage: usage(5000)
  });
  const logs = [];
  const t = telemetry.ensureTelemetryTotals((m) => logs.push(m));
  assert.equal(t.totalTokens, 100, 'token 取账本，不被该日会话文件补扫');
  assert.equal(t.calls, 0, '迁移日 llmCalls 保持 0（已知少计）');
  assert.ok(logs.some((m) => /migrated day .*incomplete/.test(m)), '必须打 incomplete 日志');
  // llmCallsComplete 改成 true → 按普通账本处理（不再打该日志，但仍不扫同一天）
  const l = readJson(path.join(LEDGER, `${day}.json`));
  l.llmCallsComplete = true;
  fs.writeFileSync(path.join(LEDGER, `${day}.json`), JSON.stringify(l));
  const logs2 = [];
  telemetry.ensureTelemetryTotals((m) => logs2.push(m));
  assert.equal(logs2.some((m) => /incomplete/.test(m)), false, '普通账本不打 incomplete');
});

// ══ 26. 账本元字段/未知字段保留 ══
await check('26. 正常写账 read-modify-write 不丢 migratedFrom/llmCallsComplete/未知字段', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const day = dayKeyOf(NOW);
  fs.writeFileSync(MIRROR, JSON.stringify({
    dayKey: day, promptTokens: 10, completionTokens: 10, totalTokens: 20, cachedTokens: 0, runs: 0, webSearchCount: 0
  }));
  const reg = new SessionRegistry(0);
  // 人为加一个未知字段
  const l0 = ledgerOf(day);
  l0.someUnknownField = { keep: 'me' };
  fs.writeFileSync(path.join(LEDGER, `${day}.json`), JSON.stringify(l0));
  const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
  s.usage = usage(50);
  reg.finish(s.id, 'done');
  const l = ledgerOf(day);
  assert.equal(l.migratedFrom, 'usage-today.json', '迁移标记不得丢');
  assert.equal(l.llmCallsComplete, false, 'llmCallsComplete 不得丢');
  assert.deepEqual(l.someUnknownField, { keep: 'me' }, '未知字段不得丢');
  assert.equal(l.totalTokens, 70);
});

// ══ 27. totals 缺失时的重建顺序 ══
await check('27. totals 缺失：构造后 = 账本 100 + 僵尸 50（不是只有 50）', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const day = dayKeyOf(NOW);
  // 先用一次正常结算造出 100 的账本与 totals
  {
    const reg = new SessionRegistry(0);
    const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
    s.usage = usage(100);
    reg.finish(s.id, 'done');
  }
  assert.equal(readJson(TOTALS).totalTokens, 100);
  fs.rmSync(TOTALS, { force: true });     // 模拟 totals 丢失
  // 再放一个 running 僵尸（50）
  writeSession('tot-zb', {
    id: 'tot-zb', chatKey: 'group:1', startedAt: at(2026, 11, 21, 11, 0), endedAt: null, status: 'running',
    trigger: 'message', triggerSummary: 't', messages: [], sent: [], usage: usage(50)
  });
  const reg2 = new SessionRegistry(0);
  const t = readJson(TOTALS);
  assert.equal(t.totalTokens, 150, '账本 100 + 僵尸 50（不得只有 50）');
  void reg2;
  // 构造完成后即可直接读取，不必等 90 秒上报
  const again = telemetry.ensureTelemetryTotals(() => {});
  assert.equal(again.totalTokens, 150);
});

// ══ 28. 回滚后迁移不跳过 ══
await check('28. 目录里有旧日账本、今天没有 → 今天仍迁移；已有今天账本不覆盖', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const today = dayKeyOf(NOW);
  const old = '2026-11-19';
  fs.mkdirSync(LEDGER, { recursive: true });
  fs.writeFileSync(path.join(LEDGER, `${old}.json`), JSON.stringify({
    version: 1, day: old, promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0,
    runs: 1, webSearchCount: 0, llmCalls: 0, toolCounts: {}, appliedAttempts: []
  }));
  fs.writeFileSync(MIRROR, JSON.stringify({
    dayKey: today, promptTokens: 60, completionTokens: 40, totalTokens: 100, cachedTokens: 0, runs: 1, webSearchCount: 0
  }));
  new SessionRegistry(0);
  assert.equal(ledgerOf(today).totalTokens, 100, '今天账本必须被创建');
  assert.equal(ledgerOf(old).totalTokens, 2, '旧日账本不变');
  // 已有今天账本不覆盖
  fs.writeFileSync(path.join(LEDGER, `${today}.json`), JSON.stringify({
    ...ledgerOf(today), totalTokens: 777
  }));
  new SessionRegistry(0);
  assert.equal(ledgerOf(today).totalTokens, 777, '已有账本不得被迁移覆盖');
});

// ══ 29. pending flush 三副作用 ══
await check('29. pending flush：账本 + appliedIndex + telemetry + 今天镜像全补齐', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const day = dayKeyOf(NOW);
  // 先建一次 registry，拿到可读的 totals
  new SessionRegistry(0);
  const tBefore = readJson(TOTALS);
  // ★ 预置今日账本已有 500 token / 4 runs / 2 次搜索：
  //   镜像断言必须能区分“全量快照”与“只写本次 delta”。
  //   账本为空时 30 和 30 无法区分（上一版测试的缺口）。
  fs.mkdirSync(LEDGER, { recursive: true });
  fs.writeFileSync(path.join(LEDGER, `${day}.json`), JSON.stringify({
    version: 1, day,
    promptTokens: 400, completionTokens: 100, totalTokens: 500, cachedTokens: 0,
    runs: 4, webSearchCount: 2, llmCalls: 4, toolCounts: {}, appliedAttempts: []
  }));
  fs.writeFileSync(PENDING, JSON.stringify([{
    id: 'pd-1', attemptKey: 'pd-1:0', dayTs: NOW,
    usage: { promptTokens: 24, completionTokens: 6, totalTokens: 30, cachedTokens: 0, calls: 1 },
    runsDelta: 1, webSearchDelta: 1, llmCalls: 2, toolCounts: { send_message: 1 }
  }]));
  const reg = new SessionRegistry(0);
  const l = ledgerOf(day);
  assert.equal(l.totalTokens, 530, '账本 = 既有 500 + 补写 30');
  assert.equal(l.runs, 5);
  assert.equal(l.webSearchCount, 3);
  const t = readJson(TOTALS);
  assert.equal(t.calls - tBefore.calls, 2, 'telemetry calls +2');
  assert.equal((t.toolCounts.send_message || 0) - (tBefore.toolCounts.send_message || 0), 1, 'toolCounts +1');
  const mir = readJson(MIRROR);
  assert.equal(mir.totalTokens, 530, '★ 镜像是账本全量快照（不是只含 30 的 delta）');
  assert.equal(mir.runs, 5, '镜像 runs 也是全量');
  assert.equal(mir.webSearchCount, 3, '镜像 webSearchCount 也是全量');
  assert.equal(mir.dayKey, day);

  // ★ 直接断言 #appliedIndex：清掉账本里的 appliedAttempts（模拟“索引与账本不一致”），
  //   再在同一实例上结算同一 attempt。只有内存索引命中才会不重复入账 ——
  //   仅靠“pending 为空 + 再 flush 不双计”推断不唯一（账本 appliedAttempts 也会兜住）。
  const cleared = ledgerOf(day);
  cleared.appliedAttempts = [];
  fs.writeFileSync(path.join(LEDGER, `${day}.json`), JSON.stringify(cleared));
  const fake = {
    id: 'pd-1', attemptSeq: 0, abortedOnBoot: false,
    usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100, cachedTokens: 0, calls: 1 },
    accountedUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 },
    accountedRuns: 0, accountedWebSearchCount: 0, webSearchCount: 0, messages: []
  };
  assert.equal(reg.settleAttempt(fake), true, '应命中内存索引并返回 true');
  assert.equal(ledgerOf(day).totalTokens, 530, '#appliedIndex 命中：不再加 100');
  assert.deepEqual(readJson(PENDING), []);
  void reg;
});

// ══ 29c. 纯联网搜索僵尸：无 token/calls 也必须补记 searchCount ══
await check('29c. 纯 web search 僵尸（usage 全 0）补记 searchCount', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const yDay = dayKeyOf(at(2026, 11, 20, 12, 0));
  writeSession('ws-zb', {
    id: 'ws-zb', chatKey: 'group:1',
    startedAt: at(2026, 11, 20, 9, 0), endedAt: at(2026, 11, 20, 9, 30),
    status: 'running', trigger: 'message', triggerSummary: 't', messages: [], sent: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 },
    webSearchCount: 3
  });
  new SessionRegistry(0);
  const l = ledgerOf(yDay);
  assert.equal(l.webSearchCount, 3, '★ 无 token 也要补记 3 次搜索');
  assert.equal(l.totalTokens, 0, '不得凭空加 token');
  assert.equal(l.runs, 0, '无消耗不计 runs');
  assert.ok(l.appliedAttempts.includes('ws-zb:0'), '仍写幂等键');
  // 旧日补记不得污染今天镜像
  assert.equal(fs.existsSync(MIRROR), false, '今天没有结算就不该有镜像');
});

await check('29b. 旧日 pending：旧账本更新、镜像 dayKey 仍为今天', () => {
  wipe();
  NOW = at(2026, 11, 21, 12, 0);
  const today = dayKeyOf(NOW);
  const yTs = at(2026, 11, 20, 12, 0);
  // 先造一笔今天的结算，让镜像存在
  {
    const reg = new SessionRegistry(0);
    const s = reg.create({ chatKey: 'group:1', trigger: 'message', triggerSummary: 't' });
    s.usage = usage(100);
    reg.finish(s.id, 'done');
  }
  const mirBefore = readJson(MIRROR);
  assert.equal(mirBefore.dayKey, today);
  fs.writeFileSync(PENDING, JSON.stringify([{
    id: 'pd-old', attemptKey: 'pd-old:0', dayTs: yTs,
    usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10, cachedTokens: 0, calls: 1 },
    runsDelta: 1, webSearchDelta: 0, llmCalls: 1, toolCounts: {}
  }]));
  new SessionRegistry(0);
  assert.equal(ledgerOf(dayKeyOf(yTs)).totalTokens, 10, '旧日账本被更新');
  const mir = readJson(MIRROR);
  assert.equal(mir.dayKey, today, '镜像 dayKey 仍为今天');
  assert.equal(mir.totalTokens, mirBefore.totalTokens, '旧日补记不碰今天镜像数值');
});

console.log = realLog; console.error = realErr; console.warn = realWarn;
for (const line of out) console.log(line);
console.log(`\n用量账本（P0-04）：通过 ${pass}，失败 ${fail}`);
Date.now = realNow;
process.exit(fail ? 1 : 0);
