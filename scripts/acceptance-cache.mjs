#!/usr/bin/env node
// 缓存验收统计（只读 data/sessions/*.json）
// 用法：
//   node scripts/acceptance-cache.mjs --from "2026-11-04 14:00" --to "2026-11-04 20:00"
//   node scripts/acceptance-cache.mjs --from ... --to ... --baseline base.json
//   node scripts/acceptance-cache.mjs --from ... --to ... > cur.json
//
// 判据（2026-11-04 修订，替代原来的「锚定轮未命中 ≤ 450」）：
//   锚定轮未命中/调用 ≤ 基线 × 0.4 ；整体未命中/调用 ≤ 基线 × 0.8 ；
//   记忆块一致率 = 1.0 ；快照重建率 ≤ 0.20
// 基线必须在**同一版本**上跑一轮取得（代码或配置有改动就要重取）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS = path.join(ROOT, 'data', 'sessions');
const TZ = 'Asia/Shanghai';

/** 记忆块起止标记。外层段落标题是「【记忆】」，正文首行是「【对群友的印象】」。
 *  用外层标题定位，才能与 11-04 验收报告的断点口径对齐（内层标题会差 4 个字符，
 *  导致「断点是否落在记忆段」的边界判定多算或少算几次）。 */
const MEM_START = '【记忆】';
const MEM_FALLBACK = '【对群友的印象】';
const MEM_ENDS = ['【新已读信息】以下是', '【未读信息】以下是'];

function memOf(userPrompt) {
  const u = String(userPrompt || '');
  let s = u.indexOf(MEM_START);
  if (s < 0) s = u.indexOf(MEM_FALLBACK);
  if (s < 0) return null;
  const ends = MEM_ENDS.map((k) => u.indexOf(k, s)).filter((i) => i > s);
  if (!ends.length) return null;
  return u.slice(s, Math.min(...ends));
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function parseTs(s) {
  if (!s) return 0;
  // 支持 "2026-11-04 14:00"（按 Asia/Shanghai 解释）
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) return 0;
  const [, y, mo, d, h = '00', mi = '00'] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:00+08:00`).getTime();
}

const since = parseTs(arg('from'));
const until = parseTs(arg('to')) || Date.now();
if (!since) {
  console.error('缺少 --from "YYYY-MM-DD HH:mm"');
  process.exit(2);
}

const rows = [];
for (const f of fs.readdirSync(SESSIONS)) {
  if (!f.endsWith('.json')) continue;
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8')); } catch { continue; }
  if (!j.startedAt || j.startedAt < since || j.startedAt >= until) continue;
  if (!j.usage) continue;
  rows.push(j);
}
rows.sort((a, b) => a.startedAt - b.startedAt);

const calls = (r) => Number(r.usage?.calls) || 1;
const fresh = (r) => Number(r.usage?.promptTokens || 0) - Number(r.usage?.cachedTokens || 0);
const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);

const anchored = rows.filter((r) => r.promptAnchorMode === 'anchored');
const anchoredFreshPerCall = anchored.length
  ? Math.round(sum(anchored, fresh) / sum(anchored, calls)) : null;
const freshPerCall = rows.length ? Math.round(sum(rows, fresh) / sum(rows, calls)) : null;
const promptTokens = sum(rows, (r) => Number(r.usage?.promptTokens || 0));
const cachedTokens = sum(rows, (r) => Number(r.usage?.cachedTokens || 0));
const cacheHitRate = promptTokens ? +(cachedTokens / promptTokens * 100).toFixed(1) : null;

// 按群分组，统计相邻运行
const by = new Map();
for (const r of rows) {
  const k = r.chatKey || '?';
  if (!by.has(k)) by.set(k, []);
  by.get(k).push(r);
}

let eligible = 0, rebuilds = 0, memPairs = 0, memSame = 0;
let steadyFresh = 0, steadyCalls = 0, steadyN = 0;
let breakTotal = 0, pairs = 0;

for (const rs of by.values()) {
  for (let i = 1; i < rs.length; i++) {
    const a = rs[i - 1], b = rs[i];
    if (a.systemPrompt !== b.systemPrompt) continue;

    // 共同前缀长度 → 断点对统计
    const A = String(a.userPrompt || ''), B = String(b.userPrompt || '');
    const lim = Math.min(A.length, B.length);
    let cp = 0;
    while (cp < lim && A[cp] === B[cp]) cp++;
    if (cp < lim) {
      pairs++;
      let ms = B.indexOf(MEM_START);
      if (ms < 0) ms = B.indexOf(MEM_FALLBACK);
      const me = MEM_ENDS.map((k) => B.indexOf(k, ms)).filter((i) => i > ms);
      const memEnd = me.length ? Math.min(...me) : Infinity;
      if (ms >= 0 && cp >= ms && cp < memEnd) breakTotal++;
    }

    if (b.promptAnchorMode !== 'anchored') continue;
    eligible++;

    const aAt = Number(a.promptAnchorState?.memory?.at) || 0;
    const bAt = Number(b.promptAnchorState?.memory?.at) || 0;
    const rebuilt = !aAt || !bAt || aAt !== bAt;
    if (rebuilt) { rebuilds++; continue; }

    const ma = memOf(A), mb = memOf(B);
    if (ma !== null && mb !== null) {
      memPairs++;
      if (ma === mb) memSame++;
    }
    if (a.promptAnchorMode === 'anchored') {
      steadyFresh += fresh(b);
      steadyCalls += calls(b);
      steadyN++;
    }
  }
}

const out = {
  window: {
    from: new Date(since).toLocaleString('zh-CN', { timeZone: TZ }),
    to: new Date(until).toLocaleString('zh-CN', { timeZone: TZ })
  },
  runs: rows.length,
  calls: sum(rows, calls),
  anchoredShare: rows.length ? +(anchored.length / rows.length).toFixed(3) : null,
  anchoredFreshPerCall,
  steadyAnchoredFreshPerCall: steadyCalls ? Math.round(steadyFresh / steadyCalls) : null,
  steadyN,
  freshPerCall,
  cacheHitRate,
  anchoredRebuildRate: eligible ? +(rebuilds / eligible).toFixed(3) : null,
  anchoredEligible: eligible,
  memoryIdenticalRate: memPairs ? +(memSame / memPairs).toFixed(3) : null,
  memPairs,
  memoryBreakRate: pairs ? +(breakTotal / pairs).toFixed(3) : null,
  pairs
};

const baselinePath = arg('baseline');
if (baselinePath) {
  const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const gates = [
    ['锚定轮未命中/调用', out.anchoredFreshPerCall, base.anchoredFreshPerCall * 0.4],
    ['整体未命中/调用', out.freshPerCall, base.freshPerCall * 0.8],
    ['记忆块一致率', out.memoryIdenticalRate, 1.0, 'eq'],
    ['快照重建率', out.anchoredRebuildRate, 0.20, 'max']
  ];
  out.gates = gates.map(([name, cur, limit, mode]) => {
    const pass = mode === 'eq' ? cur === limit : cur <= limit;
    // 阈值小于 1 时不能四舍五入：Math.round(0.20) === 0，会显示成
    // 「actual 0.024 / limit 0 / pass true」三个自相矛盾的数字（判定本身用原值，是对的）。
    const shownLimit = limit >= 1 ? Math.round(limit) : Number(limit.toFixed(3));
    return { name, actual: cur, limit: shownLimit, pass };
  });
  out.pass = out.gates.every((g) => g.pass);
}

console.log(JSON.stringify(out, null, 2));
