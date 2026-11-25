// P0-01：启动索引 Set 化 + 僵尸候选集回收（施工单 v2.15 §3.5 测试 1–14）
//
// 全部在系统临时目录里构造会话文件与索引缓存，不碰真实 data/。
// 断言口径：启动日志 `[sessions] disk= cached= missing= suspicious= reclaimed= skipped= elapsed=`。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-idx-fast-'));
process.env.QQ_AGENT_DATA_DIR = dir;

const { SessionRegistry } = await import('../src/sessions.js');

const SDIR = path.join(dir, 'sessions');
const CACHE = path.join(dir, 'session-index-cache.json');
fs.mkdirSync(SDIR, { recursive: true });

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try {
    const extra = await fn();
    pass++; console.log('  OK   ' + name + (extra ? ` —— ${extra}` : ''));
  } catch (e) {
    fail++; console.log('  FAIL ' + name + '\n        -> ' + String(e?.message ?? e));
  }
};

// ── 夹具工具 ─────────────────────────────────────────────────────────────
function reset() {
  for (const f of fs.readdirSync(SDIR)) { try { fs.rmSync(path.join(SDIR, f), { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(CACHE, { force: true }); } catch { /* ignore */ }
}

function writeSession(id, patch = {}) {
  const now = Date.now();
  const data = {
    id, chatKey: 'group:1', startedAt: now - 60000, endedAt: now - 1000,
    status: 'done', triggerSummary: 'T', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, calls: 1 },
    ...patch
  };
  fs.writeFileSync(path.join(SDIR, `${id}.json`), JSON.stringify(data), 'utf8');
  return data;
}

function readSession(id) {
  return JSON.parse(fs.readFileSync(path.join(SDIR, `${id}.json`), 'utf8'));
}

function writeCache(entries) {
  fs.writeFileSync(CACHE, JSON.stringify({ version: 1, savedAt: Date.now(), entries }), 'utf8');
}

function readCache() {
  return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
}

/** 跑一次构造，收集启动日志行 */
function boot() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(' ')); };
  try {
    const reg = new SessionRegistry(0);
    return { reg, lines };
  } finally { console.log = orig; }
}

function parseLog(lines) {
  const line = lines.find((l) => l.includes('[sessions] disk='));
  assert.ok(line, `没有打印启动日志：${JSON.stringify(lines.slice(0, 5))}`);
  const num = (k) => {
    const m = line.match(new RegExp(`${k}=(-?\\d+)`));
    assert.ok(m, `日志缺少 ${k}=：${line}`);
    return Number(m[1]);
  };
  return {
    line,
    disk: num('disk'), cached: num('cached'), missing: num('missing'),
    suspicious: num('suspicious'), reclaimed: num('reclaimed'), skipped: num('skipped'),
    elapsed: num('elapsed')
  };
}

const entryOf = (s) => ({
  id: s.id, chatKey: s.chatKey, startedAt: s.startedAt, endedAt: s.endedAt ?? null,
  status: s.status, waitUntil: null, activity: '', webSearchCount: 0, outcome: null,
  usage: s.usage, model: '', trigger: s.triggerSummary ?? '', promptChars: 0, rounds: 0
});

console.log('=== P0-01 启动索引 ===');

// 1. 缓存 3 条、磁盘 2 条 → 缺文件被剔除
await check('1. 缓存多出的条目被剔除', async () => {
  reset();
  const a = writeSession('a', { startedAt: 1000 });
  const b = writeSession('b', { startedAt: 2000 });
  writeCache([entryOf(a), entryOf(b), { ...entryOf(a), id: 'ghost' }]);
  const { reg, lines } = boot();
  const log = parseLog(lines);
  assert.equal(reg.index.length, 2, `索引应 2 条，实际 ${reg.index.length}`);
  assert.equal(log.cached, 2);
  assert.equal(log.missing, 0);
  return log.line;
});

// 2. 磁盘 running、缓存无该条 → 启动改判 aborted
await check('2. 运行中崩溃的会话被回收为 aborted', async () => {
  reset();
  const alive = writeSession('alive', { startedAt: 1000 });
  writeSession('z1', { status: 'running', startedAt: Date.now() - 5000, endedAt: null, accountPending: undefined });
  writeCache([entryOf(alive)]);
  const { reg, lines } = boot();
  const log = parseLog(lines);
  const d = readSession('z1');
  assert.equal(d.status, 'aborted');
  assert.equal(d.abortedOnBoot, true);
  // P0-04 起：回收时立刻结算，成功即清 accountPending（§6.3 第 8 条）。
  // P0-01-only 的中间态才恒为 true，本单落地后新建的僵尸在同一启动内就结清。
  assert.equal(d.accountPending, false, 'P0-04 记账成功后必须清 accountPending');
  assert.equal(log.reclaimed, 1);
  assert.equal(reg.index.length, 2);
  const s = reg.index.find((e) => e.id === 'z1');
  assert.equal(s.status, 'aborted');
  assert.equal(s.accountPending, false, '结算后索引摘要的 accountPending 也必须是 false');
  return log.line;
});

// 3. 重试后崩溃：先失效缓存条目，再构造“磁盘 running + 缓存无该条”
await check('3. 重试失效缓存后崩溃可自愈', async () => {
  reset();
  const s = writeSession('r1', { status: 'done', startedAt: Date.now() - 10000 });
  writeCache([entryOf(s)]);
  // 模拟 retrySession：先把会话放进 current，再失效缓存（写缓存会剔除 current）
  const reg0 = boot().reg;
  const live = { ...s, status: 'running', endedAt: null, startedAt: Date.now() - 1000 };
  reg0.current.set('r1', live);
  writeSession('r1', live);
  reg0.invalidateIndexCacheEntry('r1');
  assert.ok(!readCache().entries.some((e) => e.id === 'r1'), 'retry 后缓存 entries 不应含该 id');
  // 模拟崩溃后重启
  const { reg, lines } = boot();
  const log = parseLog(lines);
  const d = readSession('r1');
  assert.equal(d.status, 'aborted');
  assert.equal(log.reclaimed, 1);
  assert.equal(reg.index.filter((e) => e.id === 'r1').length, 1, '不能出现重复条目');
  return log.line;
});

// 4. 缓存残留 running 条目（mtime 10 天前）→ 防御性重读
await check('4. 缓存残留 running 条目被重读回收且不重复', async () => {
  reset();
  const s = writeSession('oldrun', { status: 'running', startedAt: Date.now() - 11 * 86400000, endedAt: null });
  const old = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(path.join(SDIR, 'oldrun.json'), old, old);
  writeCache([{ ...entryOf(s), status: 'running' }]);
  const { reg, lines } = boot();
  const log = parseLog(lines);
  assert.equal(log.suspicious, 1);
  assert.equal(reg.index.filter((e) => e.id === 'oldrun').length, 1);
  assert.equal(reg.index[0].status, 'aborted');
  assert.equal(readSession('oldrun').status, 'aborted');
  return log.line;
});

// 5. waiting 零消耗 → 文件保留、状态 aborted、结算后 accountPending=false
await check('5. 零消耗 waiting 保留文件并改判 aborted', async () => {
  reset();
  writeSession('w0', {
    status: 'waiting', startedAt: Date.now() - 3000, endedAt: null,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
  });
  const { reg } = boot();
  assert.ok(fs.existsSync(path.join(SDIR, 'w0.json')), '文件不能删');
  const d = readSession('w0');
  assert.equal(d.status, 'aborted');
  assert.equal(d.accountPending, false, '零消耗也算一个已结算的 attempt');
  assert.equal(reg.index.length, 1);
  return '文件保留';
});

// 6. endedAt 取值顺序
await check('6a. 有效 data.endedAt 优先', async () => {
  reset();
  const startedAt = Date.now() - 60000;
  const endedAt = startedAt + 30000;
  writeSession('e1', { status: 'running', startedAt, endedAt });
  boot();
  assert.equal(readSession('e1').endedAt, endedAt);
  return `endedAt=${endedAt}`;
});

await check('6b. 旧 attempt 的 endedAt（早于 startedAt）被忽略，改用 mtime', async () => {
  reset();
  const startedAt = Date.now() - 60000;
  const mt = startedAt + 20000;
  writeSession('e2', { status: 'running', startedAt, endedAt: startedAt - 10000 });
  fs.utimesSync(path.join(SDIR, 'e2.json'), new Date(mt), new Date(mt));
  boot();
  assert.equal(readSession('e2').endedAt, Math.floor(mt), '应取整后的 mtime');
  return 'mtime 生效';
});

await check('6c. data.endedAt 与 mtime 都越界 → 回退 now', async () => {
  reset();
  const startedAt = Date.now() - 60000;
  writeSession('e3', { status: 'running', startedAt, endedAt: Date.now() + 3600000 });
  const old = new Date(startedAt - 86400000);
  fs.utimesSync(path.join(SDIR, 'e3.json'), old, old);
  const before = Date.now();
  boot();
  const got = readSession('e3').endedAt;
  assert.ok(got >= before && got <= Date.now() + 2000, `应回退 Date.now()，实际 ${got}`);
  return '回退 now';
});

// 7/9. 条目数 = cached + missing − skipped；suspicious 不参与
await check('9. suspicious 不改变条目数（cached+missing-skipped）', async () => {
  reset();
  const entries = [];
  for (let i = 0; i < 100; i++) {
    const s = writeSession(`d${i}`, { startedAt: 1000 + i });
    entries.push(entryOf(s));
  }
  const run = writeSession('run1', { status: 'running', startedAt: 5000, endedAt: null });
  entries.push({ ...entryOf(run), status: 'running' });
  writeCache(entries);
  const { reg, lines } = boot();
  const log = parseLog(lines);
  assert.equal(log.cached, 101);
  assert.equal(log.missing, 0);
  assert.equal(log.suspicious, 1);
  assert.equal(log.skipped, 0);
  assert.equal(reg.index.length, log.cached + log.missing - log.skipped, '101 条');
  return log.line;
});

// 8. 第二次启动 missing/suspicious/skipped 全 0 且缓存不重写；两次都打日志
await check('8. 稳态第二次启动不重写缓存且两次都打日志', async () => {
  reset();
  const a = writeSession('a', { startedAt: 1000 });
  writeSession('z', { status: 'running', startedAt: Date.now() - 2000, endedAt: null });
  writeCache([entryOf(a)]);
  const first = boot();            // 首次：回收 + 写缓存
  const savedAfterFirst = readCache().savedAt;
  assert.ok(parseLog(first.lines), '首次启动必须打日志');
  await new Promise((r) => setTimeout(r, 30));
  const second = boot();
  const log = parseLog(second.lines);
  assert.equal(log.missing, 0);
  assert.equal(log.suspicious, 0);
  assert.equal(log.skipped, 0);
  assert.equal(readCache().savedAt, savedAfterFirst, '稳态第二次启动不应重写缓存');
  return `savedAt=${savedAfterFirst}`;
});

// 10. 坏 JSON / 无 id → skipped
await check('10. 坏文件计入 skipped', async () => {
  reset();
  const a = writeSession('a', { startedAt: 1000 });
  writeCache([entryOf(a)]);
  fs.writeFileSync(path.join(SDIR, 'bad.json'), '{坏 JSON', 'utf8');
  fs.writeFileSync(path.join(SDIR, 'noid.json'), JSON.stringify({ status: 'done' }), 'utf8');
  const { reg, lines } = boot();
  const log = parseLog(lines);
  assert.equal(log.skipped, 2);
  assert.equal(reg.index.length, log.cached + log.missing - log.skipped);
  return log.line;
});

// 12. 缓存 running + 文件坏 JSON → 从索引移除
await check('12. suspicious 重读失败时移除残留条目', async () => {
  reset();
  const a = writeSession('a', { startedAt: 1000 });
  writeCache([entryOf(a), { ...entryOf(a), id: 'broken', status: 'running', startedAt: 2000 }]);
  fs.writeFileSync(path.join(SDIR, 'broken.json'), 'not json', 'utf8');
  const { reg, lines } = boot();
  const log = parseLog(lines);
  assert.equal(log.skipped, 1);
  assert.ok(!reg.index.some((e) => e.id === 'broken'), '坏条目必须从索引移除');
  assert.ok(!reg.index.some((e) => e.status === 'running'));
  assert.equal(reg.index.length, log.cached + log.missing - log.skipped);
  return log.line;
});

// 13. 无缓存首启 → 慢路径
await check('13. 无缓存首启走慢路径并写回缓存', async () => {
  reset();
  writeSession('a', { startedAt: 1000 });
  writeSession('b', { startedAt: 2000 });
  writeSession('z', { status: 'running', startedAt: Date.now() - 1000, endedAt: null });
  const { reg, lines } = boot();
  const log = parseLog(lines);
  assert.equal(log.cached, 0);
  assert.equal(log.missing, log.disk);
  assert.equal(log.disk, 3);
  assert.equal(log.suspicious, 0);
  assert.equal(log.reclaimed, 1);
  assert.equal(reg.index.length, 3);
  assert.ok(fs.existsSync(CACHE), '首启必须写回缓存');
  return log.line;
});

// 14. missing > 200 全量重建分支
await check('14. missing>200 重建分支日志 cached=0 missing=disk', async () => {
  reset();
  const entries = [];
  for (let i = 0; i < 300; i++) {
    const s = writeSession(`c${i}`, { startedAt: 1000 + i });
    entries.push(entryOf(s));
  }
  for (let i = 0; i < 220; i++) writeSession(`m${i}`, { startedAt: 5000 + i });
  writeCache(entries);
  const { reg, lines } = boot();
  const log = parseLog(lines);
  assert.equal(log.disk, 520);
  assert.equal(log.cached, 0, '重建分支 cached 必须为 0');
  assert.equal(log.missing, 520, '重建分支 missing 必须是 diskFiles.length，不是缓存缺失数 220');
  assert.equal(log.suspicious, 0);
  assert.equal(reg.index.length, 520 - log.skipped);
  assert.equal(readCache().entries.length, 520 - log.skipped, '缓存必须被写回一次');
  return log.line;
});

console.log(`\nP0-01 启动索引：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
