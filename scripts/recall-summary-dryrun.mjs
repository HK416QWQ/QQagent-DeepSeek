// 第 4 期 step 4：会话摘要头干跑（真实 6 群，**零 LLM 调用**）。
//
// 三件事：
//   1. 先出三个分母（L4 覆盖率 / sparse 占比 / 可用会话数）—— 不先看分母，
//      任何 attach 率都无法判读（全局上界只有 L4 覆盖率）。
//   2. 每群构造 5 个会话级 + 5 个事件级问句，走 buildAutoRecall 两遍
//      （enabled:false / true），比较 attach 行为与字数/耗时。
//   3. 只写一个统计 JSON：施工备份/.../摘要头干跑.json。
//
// ★ 全程不写 data/ 下任何文件：配置经 opts 传入（buildAutoRecall 不读 getConfig）。
import fs from 'node:fs';
import path from 'node:path';
import { ChatStore } from '../src/store.js';
import { getConfig } from '../src/config.js';
import { readCoverage, readSummaryForConv, findConvRow } from '../src/mem2/store.js';
import { buildAutoRecall } from '../src/auto-recall.js';

const cfg = getConfig();
const NICK = cfg.persona?.botName || '机器人';
const OUT = path.resolve(process.cwd(), '..', '施工备份', '2026.11.14 记忆架构第4期', '摘要头干跑.json');
const DAY = 24 * 3600 * 1000;
const now = Date.now();

const store = new ChatStore(0);
const chats = store.listChats();

// ── 1. 三个分母 ──────────────────────────────────────────────────────────
let totalConv = 0; let okConv = 0; let sparseOk = 0; let usable = 0;
const covByChat = new Map();
for (const chatKey of chats) {
  const list = readCoverage(chatKey).list || [];
  covByChat.set(chatKey, list);
  totalConv += list.length;
  for (const r of list) {
    if (r.state !== 'ok') continue;
    okConv += 1;
    const sum = readSummaryForConv(chatKey, r.convStartTs);
    if (!sum) continue;
    usable += 1;
    if (sum.sparse) sparseOk += 1;
  }
}
const denominators = {
  totalConvs: totalConv,
  okConvs: okConv,
  okRate: totalConv ? Math.round((okConv / totalConv) * 1000) / 10 : 0,
  sparseInOk: sparseOk,
  sparseRate: okConv ? Math.round((sparseOk / okConv) * 1000) / 10 : 0,
  usableConvs: usable,                                  // 有 L4 且非空 = attach 的理论上界
  usableRate: totalConv ? Math.round((usable / totalConv) * 1000) / 10 : 0
};

// ── 2. 构造问句 ──────────────────────────────────────────────────────────
// 会话级：从「有 L4 的会话」里取一条消息的特征词（那个词只在该会话里出现 → 命中会集中）
// 事件级：取该群最近消息里的实体词，故意不指定会话（命中天然分散）
const CJK = /[\u4e00-\u9fa5]{2,4}/g;
function wordsOf(texts, skip) {
  const df = new Map();
  for (const t of texts) {
    for (const w of String(t ?? '').match(CJK) || []) {
      if (skip.has(w)) continue;
      df.set(w, (df.get(w) || 0) + 1);
    }
  }
  return df;
}

const probes = [];
for (const chatKey of chats) {
  const msgs = store.rangeByTs(chatKey, { fromTs: now - 30 * DAY, toTs: now }) || [];
  if (msgs.length < 20) continue;
  const skip = new Set(['还记得', '上次', '那天', '那会', '什么', '怎么', '我们', '你们', '他们', '这个', '那个', '就是', '不是', '可以', '没有']);
  const df = wordsOf(msgs.map((m) => m.text), skip);

  // 会话级：从有 L4 的会话里挑特征词
  const withL4 = (covByChat.get(chatKey) || []).filter((r) => r.state === 'ok'
    && readSummaryForConv(chatKey, r.convStartTs));
  let made = 0;
  for (const row of withL4.slice(-8)) {
    if (made >= 5) break;
    const inConv = msgs.filter((m) => m.ts >= row.convStartTs && m.ts <= row.convEndTs && !m.self);
    const cand = wordsOf(inConv.map((m) => m.text), skip);
    // 取「只在这一个会话里出现」的词：命中必然集中
    const uniq = [...cand.entries()].filter(([w]) => (df.get(w) || 0) <= 3 && w.length >= 2)
      .sort((a, b) => b[1] - a[1]);
    if (!uniq.length) continue;
    probes.push({
      chatKey, kind: 'conv', convStartTs: row.convStartTs, word: uniq[0][0],
      text: `@${NICK} 你还记得那天说的${uniq[0][0]}吗`
    });
    made += 1;
  }
  // 事件级：跨会话的常见实体词
  const common = [...df.entries()].filter(([w, n]) => n >= 5 && w.length >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [w] of common) {
    probes.push({ chatKey, kind: 'event', word: w, text: `@${NICK} 你还记得上次说的${w}那事吗` });
  }
}

// ── 3. 跑两遍 ────────────────────────────────────────────────────────────
const base = cfg.memory?.autoRecallSummaryHead || {};
const ON = { ...base, enabled: true };
const OFF = { ...base, enabled: false };

const rows = [];
for (const p of probes) {
  const entries = [{ mid: 1, ts: now, text: p.text }];
  const opt = { selfNickname: NICK, botName: NICK, selfId: cfg.onebot?.selfId || '' };

  const t0 = Date.now();
  const rOn = buildAutoRecall(store, p.chatKey, entries, { ...opt, summaryHead: ON });
  const msTotal = Date.now() - t0;
  const rOff = buildAutoRecall(store, p.chatKey, entries, { ...opt, summaryHead: OFF });

  const sh = rOn.stats?.summaryHead || {};
  // 「命中过有 L4 会话」：这轮 hitTsList 里有没有落在 usable 会话上的
  const hitsWithL4 = (rOn.stats?.hitTsList || []).filter((ts) => {
    const row = findConvRow(covByChat.get(p.chatKey) || [], ts);
    return row && row.state === 'ok' && readSummaryForConv(p.chatKey, row.convStartTs);
  }).length;

  rows.push({
    chatKey: p.chatKey, kind: p.kind, word: p.word,
    hit: Boolean(rOn.stats?.hit),
    hitsWithL4,
    attached: sh.attached === true,
    reason: sh.reason || '-',
    chars: [...String(rOn.text || '')].length,
    charsOff: [...String(rOff.text || '')].length,
    headMs: Number(sh.ms) || 0,          // ★ 只算摘要头自己的耗时（不含检索）
    msTotal,                              // 整段（含检索）—— 仅作参考
    // 未 attach 时开/关必须逐字节相同；attached 时不适用
    byteSameWhenOff: sh.attached === true ? null : (rOn.text === rOff.text),
    summaryChars: sh.chars || 0,
    sparse: sh.sparse === true
  });
}

// ── 4. 统计 ──────────────────────────────────────────────────────────────
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const hit = rows.filter((r) => r.hit);
const convRows = rows.filter((r) => r.kind === 'conv' && r.hit);
const convEligible = convRows.filter((r) => r.hitsWithL4 > 0);
const eventRows = rows.filter((r) => r.kind === 'event' && r.hit);
const attachedRows = rows.filter((r) => r.attached);
const hitRows = rows.filter((r) => r.hit);
const offRows = rows.filter((r) => r.byteSameWhenOff !== null);

const report = {
  generatedAt: new Date(now).toISOString(),
  config: ON,
  denominators,
  probes: { total: rows.length, hit: hit.length, conv: convRows.length, convEligible: convEligible.length, event: eventRows.length },
  rates: {
    convAttachInEligible: convEligible.length
      ? Math.round((convEligible.filter((r) => r.attached).length / convEligible.length) * 1000) / 10 : null,
    eventAttach: eventRows.length
      ? Math.round((eventRows.filter((r) => r.attached).length / eventRows.length) * 1000) / 10 : null,
    overallAttach: hit.length
      ? Math.round((attachedRows.length / hit.length) * 1000) / 10 : 0
  },
  // 字数只在「真注入」的样本上统计：未命中的 0 会把 P50 拖成 0，毫无信息量
  chars: {
    p50: pct(hitRows.map((r) => r.chars), 50),
    p95: pct(hitRows.map((r) => r.chars), 95),
    max: Math.max(0, ...hitRows.map((r) => r.chars))
  },
  charsOffP95: pct(offRows.map((r) => r.charsOff), 95),
  // ★ 摘要头的**额外**耗时（不含检索）。整段的 msTotal 混着 search 的成本，不能用来判这条线。
  headMs: { p50: pct(rows.map((r) => r.headMs), 50), p95: pct(rows.map((r) => r.headMs), 95), max: Math.max(0, ...rows.map((r) => r.headMs)) },
  msTotalP95: pct(rows.map((r) => r.msTotal), 95),
  offByteSame: offRows.every((r) => r.byteSameWhenOff === true),
  reasons: rows.reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {}),
  writes: 0,
  rows
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
console.log('════ 会话摘要头干跑（真实数据，未调 LLM）════');
line('总会话数 / ok', `${denominators.totalConvs} / ${denominators.okConvs}（${denominators.okRate}%）`);
line('sparse 占 ok 的比例', `${denominators.sparseInOk}/${denominators.okConvs}（${denominators.sparseRate}%）`);
line('可用会话（有 L4 非空）', `${denominators.usableConvs}（理论上界 ${denominators.usableRate}%）`);
line('问句 总数/命中', `${report.probes.total} / ${report.probes.hit}`);
line('会话级 命中/有L4可判', `${convRows.length} / ${convEligible.length}`);
line('会话级 attach 率', report.rates.convAttachInEligible === null ? 'n/a' : `${report.rates.convAttachInEligible}%  （线 ≥60%）`);
line('事件级 attach 率', report.rates.eventAttach === null ? 'n/a' : `${report.rates.eventAttach}%  （线 ≤20%）`);
line('总长 P50/P95/max', `${report.chars.p50} / ${report.chars.p95} / ${report.chars.max}  （线 P95 ≤320，只算命中样本）`);
line('关闭时总长 P95', `${report.charsOffP95}  （旧口径 ≤200）`);
line('摘要头额外耗时 P95', `${report.headMs.p95}ms（max ${report.headMs.max}ms）  （线 ≤5ms）`);
line('整段耗时 P95（参考）', `${report.msTotalP95}ms（含检索，不作判定）`);
line('关闭时逐字节一致', report.offByteSame ? '是' : '否（有样本不一致！）');
line('reason 分布', JSON.stringify(report.reasons));
console.log(`\n  报告：${OUT}`);

const pass = (report.rates.convAttachInEligible === null || report.rates.convAttachInEligible >= 60)
  && (report.rates.eventAttach === null || report.rates.eventAttach <= 20)
  && report.chars.p95 <= 320
  && report.headMs.p95 <= 5
  && report.offByteSame === true;
console.log(pass ? '\n  ✅ 通过线达标' : '\n  ⚠️ 有指标未达标（见上）');
if (!pass) process.exitCode = 2;
