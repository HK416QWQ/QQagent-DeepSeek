// 行为统计新维度（识别视频 / 音频识别）的回归测试。
//
// 为什么单独一个文件：`behavior-stats.js` 加一个计数维度要改 **11 处** 模板代码，
// 漏任何一处都不会报错、不会 NaN，只是数据在某个环节静默丢失。这里专挑
// 「漏了最容易看不出来」的几处来钉：
//   · 落盘往返  → serializeBucket / normalizeSerialized（第 5、6 处）
//   · 模拟重启  → initBehaviorStats 的白名单循环（第 11 处，漏了当天清零）
//   · 跨天汇总  → addDay / totals 累加（第 7、9 处）
//   · 旧数据兼容 → 缺字段的 archive 不能让 buildStats 抛错
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-beh-va-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const {
  recordVideo, recordAudio, recordSession, buildStats, flushBehaviorStats,
  initBehaviorStats, __testBehaviorStats
} = await import('../src/behavior-stats.js');

const STATS_DIR = path.join(dataDir, 'behavior-stats');
const dayKeyOf = (ms) => {
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

check('1. recordVideo → totals.videoCalls 计 1', () => {
  recordVideo({ chatKey: 'group:1' });
  assert.equal(buildStats({ range: 'today' }).totals.videoCalls, 1);
});

check('2. recordAudio → totals.audioCalls 计 1', () => {
  recordAudio({ chatKey: 'group:1' });
  assert.equal(buildStats({ range: 'today' }).totals.audioCalls, 1);
});

check('3. 落盘往返：flush 后 today.json 里有两个字段，重算仍是 1', () => {
  flushBehaviorStats();
  const f = path.join(STATS_DIR, 'today.json');
  assert.ok(fs.existsSync(f), `today.json 不存在：${f}`);
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(raw.videoCalls, 1, 'today.json 里没有 videoCalls（serializeBucket 漏了）');
  assert.equal(raw.audioCalls, 1, 'today.json 里没有 audioCalls（serializeBucket 漏了）');
  const s = buildStats({ range: 'today' });
  assert.equal(s.totals.videoCalls, 1, 'videoCalls 落盘后丢了');
  assert.equal(s.totals.audioCalls, 1, 'audioCalls 落盘后丢了');
});

check('4. 模拟重启：memory.clear() + initBehaviorStats → 仍是 1（第 11 处）', () => {
  const t = __testBehaviorStats();
  t.memory.clear();               // 相当于进程重启：内存没了，只剩磁盘
  // 注意：initBehaviorStats 收的是**数据根目录**，内部自己拼 behavior-stats；
  // 传错目录它会静默读不到文件，这条就会"假通过"——所以先断言文件在。
  assert.ok(fs.existsSync(path.join(STATS_DIR, 'today.json')), '重启前 today.json 应已存在');
  initBehaviorStats(dataDir);
  const s = buildStats({ range: 'today' });
  assert.equal(s.totals.videoCalls, 1, '重启后当天累计归零（initBehaviorStats 白名单漏了）');
  assert.equal(s.totals.audioCalls, 1, '重启后 audioCalls 归零（initBehaviorStats 白名单漏了）');
});

const writeArchive = (dayKey, counters) => {
  fs.mkdirSync(STATS_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATS_DIR, `archive-${dayKey}.json`), JSON.stringify({
    dayKey,
    sentCount: 0, charCount: 0, stickerCount: 0, imageSentCount: 0, mediaSentCount: 0,
    visionCalls: 0, thinkingCalls: 0, apiCalls: 0,
    cachedTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    hours: [], chats: [], sessions: [],
    ...counters
  }));
};

check('5. 跨天汇总：range=7 时 totals 为两天之和（第 7、9 处）', () => {
  writeArchive(dayKeyOf(Date.now() - 86400000), { videoCalls: 2, audioCalls: 3 });
  const s = buildStats({ range: '7' });
  assert.equal(s.totals.videoCalls, 3, `应为今天 1 + 昨天 2 = 3，实际 ${s.totals.videoCalls}`);
  assert.equal(s.totals.audioCalls, 4, `应为今天 1 + 昨天 3 = 4，实际 ${s.totals.audioCalls}`);
});

check('6. 旧数据兼容：archive 缺新字段时不抛错、按 0 参与汇总', () => {
  writeArchive(dayKeyOf(Date.now() - 2 * 86400000), { sentCount: 5, visionCalls: 2, apiCalls: 1 });
  const s = buildStats({ range: '7' });    // 不能抛
  assert.equal(s.totals.videoCalls, 3, '缺字段的旧数据不该改变已有计数');
  assert.equal(s.totals.audioCalls, 4, '缺字段的旧数据不该改变已有计数');
  assert.equal(s.totals.sentCount, 5, '旧数据自己的字段仍应被读到');
});

// 单次会话弹窗（08-modals）读的是 sessions 里的快照，不是 totals。
// 「识别视频」当初就漏过一次：totals 有、快照没有，弹窗里永远显示 0。
check('7. 会话快照带上 audioCalls（单次会话弹窗口径）', () => {
  recordSession({
    chatKey: 'group:1', sessionId: 'sess-va', rounds: 2,
    visionCalls: 0, videoCalls: 1, audioCalls: 2, thinkingCalls: 0,
    sentCount: 1, charCount: 10, usage: { totalTokens: 100 }
  });
  const s = buildStats({ range: 'today' });
  const snap = (s.sessions || []).find((x) => x.sessionId === 'sess-va');
  assert.ok(snap, '会话快照没进 sessions 数组');
  assert.equal(snap.audioCalls, 2, '快照里没有 audioCalls（recordSession 的 sanitize 漏了）');
  assert.equal(snap.videoCalls, 1, '快照里没有 videoCalls');
  // 旧数据没有这个字段时必须是 0，不能 NaN/undefined
  assert.equal(snap.thinkingCalls, 0, '缺省字段应为 0');
});

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n行为统计（视频/音频）：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
