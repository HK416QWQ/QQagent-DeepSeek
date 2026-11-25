// 数据保留策略自测：只使用系统临时目录，绝不读写真实 data/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-retention-'));
process.env.QQ_AGENT_DATA_DIR = dir;

const DAY = 86400000;
const old = Date.now() - 200 * DAY;
const now = Date.now();
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v));
};
write(path.join(dir, 'sessions', 'old.json'), {
  id: 'old', chatKey: 'group:1', startedAt: old, endedAt: old, status: 'done',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, calls: 1 }
});
write(path.join(dir, 'sessions', 'new.json'), {
  id: 'new', chatKey: 'group:1', startedAt: now, endedAt: now, status: 'done',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, calls: 1 }
});
// ── 消息存档夹具（2026-11-11 改为按月分片格式）──
// 分片后 saveChat 写的是 messages/group_1/<YYYY-MM>.jsonl + _meta.json，
// 不再有 messages/group_1.json。夹具必须跟着变，否则断言读的是没人再写的旧文件。
const mdir = path.join(dir, 'messages', 'group_1');
fs.mkdirSync(mdir, { recursive: true });
const ymOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
{
  const byMonth = new Map();
  for (const e of [{ id: 1, ts: old, text: 'old' }, { id: 2, ts: now, text: 'new' }]) {
    const ym = ymOf(e.ts);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(e);
  }
  for (const [ym, arr] of byMonth) {
    fs.writeFileSync(path.join(mdir, `${ym}.jsonl`), arr.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(mdir, '_meta.json'), JSON.stringify({ schema: 1, nextLocalId: 3 }));
}
const oldMonthFile = path.join(mdir, `${ymOf(old)}.jsonl`);
assert.notEqual(ymOf(old), ymOf(now), '测试前提：200 天前必然落在不同月份');
fs.mkdirSync(path.join(dir, 'video-cache'), { recursive: true });
const vOld = path.join(dir, 'video-cache', 'v_old.mp4');
fs.writeFileSync(vOld, 'x');
fs.utimesSync(vOld, new Date(old), new Date(old));

const { SessionRegistry } = await import('../src/sessions.js');
const { ChatStore } = await import('../src/store.js');
const { runRetention } = await import('../src/retention.js');

const sessions = new SessionRegistry(0);
const store = new ChatStore(0);
// messagesDays: 180 —— 消息存档的保留期 2026-11-11 起是**独立开关**
// （config.store.messagesRetentionDays，默认 0 = 永久保留）。不显式传的话
// 消息一条都不会删，这条断言就失去意义。
const r = await runRetention({ sessions, store, days: 180, messagesDays: 180, log: () => {} });

assert.equal(r.sessions, 1, '应删除 1 个旧会话');
assert.equal(r.messages, 1, '应删除 1 条旧消息');
assert.equal(r.videoCache, 1, '应删除 1 个旧视频缓存');
assert.ok(!fs.existsSync(path.join(dir, 'sessions', 'old.json')), '旧会话文件应已删除');
assert.ok(fs.existsSync(path.join(dir, 'sessions', 'new.json')), '新会话文件必须保留');
// ── 消息存档：读回所有分片合并，并单独验旧月文件真的被删了 ──
const readAllShards = () => fs.readdirSync(mdir)
  .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()
  .flatMap((f) => fs.readFileSync(path.join(mdir, f), 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l)));
assert.deepEqual(readAllShards().map((m) => m.id), [2], '新消息必须保留、旧消息删除');
// ★ 这条是本单最值钱的回归：它直接咬住「被删空的月份要真的删掉 .jsonl」。
//   如果 saveChat 只用内存月（而不是 磁盘现有月 ∪ 内存月），旧月文件会留下来，
//   重启就把数据读回来了 —— 而且任何"同进程内再读一次"的断言都不会红。
assert.ok(!fs.existsSync(oldMonthFile),
  `★ 被删空的月份文件必须真的消失（${path.basename(oldMonthFile)} 还在 = clear/prune 会静默失效）`);
assert.equal(JSON.parse(fs.readFileSync(path.join(mdir, '_meta.json'), 'utf8')).nextLocalId, 3,
  'nextLocalId 不能被改动');
assert.ok(!fs.existsSync(vOld), '旧视频缓存应已删除');

// ── 视频缓存的两道闸（2026-11-08）──────────────────────────────────────
// 它脱离 retentionDays 独立管理：只看「活多久」和「总多大」。
// 上面那条 200 天前的 v_old 被删，已经顺带证明它不再依赖 days；
// 这里把两个闸的边界钉死。
const { pruneVideoCache } = await import('../src/retention.js');
const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-vcache-'));
const mkFile = (name, mb, ageH) => {
  const p = path.join(vdir, name);
  fs.writeFileSync(p, Buffer.alloc(mb * 1024 * 1024));
  const t = Date.now() - ageH * 3600000;
  fs.utimesSync(p, new Date(t), new Date(t));
  return p;
};
mkFile('a_100h.mp4', 1, 100);   // 超 72 小时
mkFile('b_90h.mp4', 1, 90);     // 超 72 小时
mkFile('c_30h.mp4', 1, 30);     // 未超
mkFile('d_1h.mp4', 1, 1);       // 未超

const r1 = pruneVideoCache(vdir, { hours: 72, maxMb: 0, dryRun: true });
assert.equal(r1.expired, 2, '时长闸：超 72 小时应命中 2 个');
assert.equal(r1.kept, 2, '时长闸：未超时的必须保留');

const r2 = pruneVideoCache(vdir, { hours: 0, maxMb: 2, dryRun: true });
assert.equal(r2.evicted, 2, '容量闸：4MB 压到 2MB 应淘汰 2 个');
assert.deepEqual(
  r2.victims.map((v) => v.name).sort(),
  ['a_100h.mp4', 'b_90h.mp4'],
  '容量闸必须按 mtime 从最老开始（LRU），不能随机删'
);

const r3 = pruneVideoCache(vdir, { hours: 0, maxMb: 0.5, dryRun: true });
assert.equal(r3.kept, 1, '容量上限小于单条时必须保留最新 1 个，绝不能清空目录');

const r4 = pruneVideoCache(vdir, { hours: 72, maxMb: 0 });
assert.equal(r4.removed, 2, '真删应删掉 2 个超时文件');
assert.equal(fs.readdirSync(vdir).sort().join(','), 'c_30h.mp4,d_1h.mp4', '真删后只剩两个未超时的');

assert.equal(pruneVideoCache(path.join(vdir, 'not-exist'), { dryRun: true }).removed, 0, '目录不存在时应静默返回 0');
fs.rmSync(vdir, { recursive: true, force: true });

// ── 消息保留期与 session 保留期互相独立（2026-11-11）──────────────────
// 四种组合都必须对。最关键的是第 3 种：retentionDays=0 + messagesRetentionDays=30
// —— 用户只想让消息过期、不想动 785MB 会话文件。如果消息清理写在
// `if (!cutoff) return` 之后，这一组会连消息一起被跳过：设了 30 天却一条都不删，
// 而且没有任何日志，看起来像功能没做。
//
// ⚠️ pruneBefore 遍历 listChats()，是**全局**操作。所以每组开跑前把 messages/
//    整个清掉，只留本轮要用的那个群 —— 否则上一组的残留会把返回值算进来。
{
  const safeKey = (k) => String(k).replace(/[^a-z0-9_]/gi, '_');
  const oldTs = Date.now() - 200 * 86400000;
  const newTs = Date.now();

  const seed = (chatKey) => {
    fs.rmSync(path.join(dir, 'messages'), { recursive: true, force: true });
    const d = path.join(dir, 'messages', safeKey(chatKey));
    fs.mkdirSync(d, { recursive: true });
    const byMonth = new Map();
    for (const e of [{ id: 1, ts: oldTs, text: 'old' }, { id: 2, ts: newTs, text: 'new' }]) {
      const ym = ymOf(e.ts);
      if (!byMonth.has(ym)) byMonth.set(ym, []);
      byMonth.get(ym).push(e);
    }
    for (const [ym, arr] of byMonth) {
      fs.writeFileSync(path.join(d, `${ym}.jsonl`), arr.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    return new ChatStore(0);
  };
  const remaining = (chatKey) => {
    const d = path.join(dir, 'messages', safeKey(chatKey));
    return fs.readdirSync(d).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  };

  // 1) retentionDays=180 + messages=0（默认）：消息不动
  {
    const K = 'group:2';
    const s = seed(K);
    const rr = await runRetention({ sessions: null, store: s, days: 180, messagesDays: 0, log: () => {} });
    assert.equal(rr.messages, 0, 'messages=0 时消息必须一条都不删（默认永久保留）');
    assert.equal(remaining(K).length, 2);
  }

  // 2) 都是 0：全都不动
  {
    const K = 'group:3';
    const s = seed(K);
    const rr = await runRetention({ sessions: null, store: s, days: 0, messagesDays: 0, log: () => {} });
    assert.equal(rr.messages, 0);
    assert.equal(rr.skipped, true);
    assert.equal(remaining(K).length, 2);
  }

  // 3) ★ retentionDays=0 + messages=30：只删消息，不碰 session
  {
    const K = 'group:4';
    const s = seed(K);
    const rr = await runRetention({ sessions: null, store: s, days: 0, messagesDays: 30, log: () => {} });
    assert.equal(rr.messages, 1,
      '★ retentionDays=0 + messages=30 时消息仍必须被清理（这条曾被 if (!cutoff) return 整段跳过）');
    assert.equal(rr.skipped, true, 'session 侧仍然算跳过');
    assert.deepEqual(remaining(K).map((m) => m.id), [2], '旧消息必须真的删掉');
  }

  // 4) 都按各自天数：200 天前的消息被删
  {
    const K = 'group:5';
    const s = seed(K);
    const rr = await runRetention({ sessions: null, store: s, days: 30, messagesDays: 30, log: () => {} });
    assert.equal(rr.messages, 1);
    assert.deepEqual(remaining(K).map((m) => m.id), [2]);
  }

  console.log('  ✓ 消息保留期与 session 保留期互相独立（四种组合）');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('retention-test OK');
