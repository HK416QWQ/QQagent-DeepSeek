// 自动检索（第 0 期 2a）灰度观测报告
//
// 读 data/logs/qq-agent-YYYY-MM-DD.log 里 orchestrator 打的
//   [autoRecall] chat=... words=a,b hits=N ms=M
// 汇总成「日均触发 / 抽词可读性 / 检索命中率 / 耗时」四项，
// 并按大纲 §15 第 0 期的验收窗口（1–3 次/天）判红绿。
//
// 用法：
//   node scripts/autorecall-report.mjs            # 最近 7 天
//   node scripts/autorecall-report.mjs 3          # 最近 3 天
//   node scripts/autorecall-report.mjs 2026-11-13 # 指定某天
//   node scripts/autorecall-report.mjs 1 --check  # 追加「离线复算应触发条数」
//
// ★ --check 解决一个反复出现的诊断难题：日志零记录时，无法区分
//   「没人问」和「功能没生效」。它拿同一窗口的真实消息离线跑一遍判定，
//   算出「本应触发多少条」。两者对比才知道是没需求还是链路断了。
//   ⚠️ 口径差：离线算的是「群聊里所有判定命中的消息」，而线上只在
//   agent 真要回复的那一轮才跑判定（#runAgent）。所以 应触发 ≥ 实际，
//   差额来自「群友间对话/未被唤醒」，属正常。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const LOG_DIR = path.join(ROOT, 'data/logs');
const MSG_DIR = path.join(ROOT, 'data/messages');
const LINE_RE = /\[autoRecall\]\s+chat=(\S+)\s+words=(.*?)\s+hits=(\d+)\s+ms=(\d+)/;
const MARKER_WORDS = new Set(['记得', '还记得', '上次', '上回', '那次', '说过', '讲过', '提过', '那天', '那会儿', '前面说', '刚才说']);

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const arg = argv.find((a) => !a.startsWith('--'));
let files = [];
if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
  const f = path.join(LOG_DIR, `qq-agent-${arg}.log`);
  if (!fs.existsSync(f)) { console.error(`没有这天的日志：${f}`); process.exit(1); }
  files = [f];
} else {
  const n = Math.max(1, Number(arg) || 7);
  const all = fs.existsSync(LOG_DIR)
    ? fs.readdirSync(LOG_DIR).filter((f) => /^qq-agent-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
    : [];
  files = all.slice(-n).map((f) => path.join(LOG_DIR, f));
}

if (!files.length) { console.error(`日志目录里没有可读的日志：${LOG_DIR}`); process.exit(1); }

const rows = [];
for (const f of files) {
  const day = path.basename(f).replace(/^qq-agent-|\.log$/g, '');
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    rows.push({
      day,
      time: line.slice(0, 8),
      chat: m[1],
      words: m[2].split(',').map((w) => w.trim()).filter(Boolean),
      hits: Number(m[3]),
      ms: Number(m[4])
    });
  }
}

const days = [...new Set(files.map((f) => path.basename(f).replace(/^qq-agent-|\.log$/g, '')))];
console.log(`窗口：${days[0]} ~ ${days[days.length - 1]}（${days.length} 天，${files.length} 个日志文件）`);

if (!rows.length) {
  console.log('\n没有任何 [autoRecall] 记录。');
  console.log('可能原因：① autoRecall 仍是 false；② 进程没重启（配置只在启动时读一次）；');
  console.log('         ③ 这期间确实没人问「还记得/上次」这类问题（正常，量本来就只有 1–3 条/天）。');
  console.log(CHECK ? '\n→ 跑 --check 离线复算，看是「没需求」还是「链路断了」：' : '\n→ 加 --check 可离线复算「本应触发多少条」，用来区分「没需求」和「没生效」。');
  if (!CHECK) process.exit(0);
}

const flag = (ok, txt) => `${ok ? '✅' : '⚠️ '} ${txt}`;

if (rows.length) {
  const perDay = rows.length / days.length;
  const zeroHit = rows.filter((r) => r.hits === 0);
  const wordFreq = new Map();
  for (const r of rows) for (const w of r.words) wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
  const badWords = [...wordFreq.entries()].filter(([w]) => MARKER_WORDS.has(w));
  const msSorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const p95 = msSorted[Math.min(msSorted.length - 1, Math.floor(msSorted.length * 0.95))];

  console.log(`\n触发 ${rows.length} 次 / ${days.length} 天 = ${perDay.toFixed(2)} 次/天  ${perDay >= 1 && perDay <= 3 ? '✅ 落在 1–3 窗口' : perDay < 1 ? '⚠️  偏少（可能没人问，也可能判定太严）' : '⚠️  偏多（条件松了）'}`);
  console.log(`${flag(zeroHit.length / rows.length <= 0.5, `检索空手率 ${zeroHit.length}/${rows.length} = ${(zeroHit.length / rows.length * 100).toFixed(0)}%`)}  ${zeroHit.length / rows.length <= 0.5 ? '（空手=抽词对但库里没有；>50% 说明抽词跑偏）' : ''}`);
  console.log(`${flag(badWords.length === 0, `抽词里出现标记词 ${badWords.length} 次`)}${badWords.length ? ' → ' + badWords.map(([w, c]) => `${w}×${c}`).join(' ') : '（停用表正常工作）'}`);
  console.log(`${flag(p95 < 500, `耗时 P95 ${p95}ms`)}${p95 >= 500 ? '（检索变慢，看是否建了索引/日志暴涨）' : ''}`);

  console.log('\n每群分布：');
  const byChat = new Map();
  for (const r of rows) byChat.set(r.chat, (byChat.get(r.chat) || 0) + 1);
  [...byChat.entries()].sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${String(n).padStart(3)} × ${c}`));

  console.log('\n高频抽词（前 10）：');
  [...wordFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([w, n]) => console.log(`  ${String(n).padStart(3)} × ${w}`));

  console.log('\n最近 10 条明细（要人工看「这条问的到底是什么」）：');
  rows.slice(-10).forEach((r) => {
    console.log(`  ${r.day} ${r.time} ${r.chat}  words=[${r.words.join(',')}]  hits=${r.hits}  ${r.ms}ms`);
  });
}

// ── 离线复算：本应触发多少条（区分「没需求」和「没生效」）──
if (CHECK) {
  const { isRecallIntent, pickWords } = await import('../src/auto-recall.js');
  let selfNickname = '';
  try {
    const cfgPath = path.join(ROOT, 'data/config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      selfNickname = String(cfg?.persona?.botName || cfg?.onebot?.nickname || '');
    }
  } catch { /* 读不到就只靠句式判定，不影响结论方向 */ }
  const opts = { selfNickname, botName: selfNickname, selfId: '' };

  const daySet = new Set(days);
  const candidates = [];
  let scanned = 0;
  if (fs.existsSync(MSG_DIR)) {
    for (const g of fs.readdirSync(MSG_DIR)) {
      const d = path.join(MSG_DIR, g);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.jsonl')) continue;
        for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
          const s = line.trim();
          if (!s) continue;
          let m;
          try { m = JSON.parse(s); } catch { continue; }
          const ts = Number(m.ts) || 0;
          if (!ts) continue;
          const day = new Date(ts).toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
          if (!daySet.has(day)) continue;
          scanned++;
          if (m.self) continue;
          const text = String(m.text ?? '');
          if (!text.trim()) continue;
          if (!isRecallIntent(text, opts)) continue;
          candidates.push({ ts, chat: g, text, words: pickWords(text, [selfNickname]) });
        }
      }
    }
  }

  const withWords = candidates.filter((c) => c.words.length);
  console.log('\n════ 离线复算（--check）════');
  console.log(`扫描 ${scanned} 条消息 / ${days.length} 天`);
  console.log(`判定命中 ${candidates.length} 条，其中抽得出词（线上会真检索）${withWords.length} 条`);
  console.log(`日志实际记录 ${rows.length} 条 → 差额 ${withWords.length - rows.length} 条`);

  if (!withWords.length) {
    console.log('\n✅ 结论：本窗口内群里没有任何「问机器人回忆旧事」的句子 → 零日志是「没需求」，不是故障。');
  } else {
    console.log(`\n⚠️  有 ${withWords.length} 条本应触发，但日志只有 ${rows.length} 条：`);
    console.log('   差额的正常解释：这些句子所在的轮次 agent 没有被唤醒/没决定回复（#runAgent 只在要回复时跑判定）。');
    console.log('   若差额里有明确 @机器人 且 agent 当时回过话的，才是真 bug（判定到注入之间断了）。');
    withWords.forEach((c) => {
      const t = new Date(c.ts).toLocaleString('zh-CN', { hour12: false });
      console.log(`   ${t} ${c.chat} words=[${c.words.join(',')}] | ${c.text.replace(/\s+/g, ' ').slice(0, 44)}`);
    });
  }
}
