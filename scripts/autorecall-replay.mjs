// 自动检索（第 0 期 2a）—— 历史回放：不注入 prompt，只把「当时会注入什么」打出来
//
// ★ 解决的问题：`--check` 只能算「本应触发多少条」，算不出「会注入什么」。
//   而灰度的核心问题恰恰是注入质量 —— 判定对了但注入一堆噪音，等于没做。
//   靠等群友自然触发，两天可能只等到 1–2 条；回放一天能看完几十条历史真实表达。
//
// ★ 能替代什么、不能替代什么：
//   能：误报率、注入质量、抽词跑偏、跨群检索是否正确 —— 这些看注入内容就能判，不需要模型作答。
//   不能：① 模型「用了之后有没有答对」（当时没注入，无从验证）；
//        ② 精确排序（store.search 的时间衰减用 Date.now()，回放时越老的消息衰减越接近 0，
//           只影响同分消息的先后，不影响「是否命中」）。
//
// 用法：
//   node scripts/autorecall-replay.mjs          # 最近 7 天
//   node scripts/autorecall-replay.mjs 30       # 最近 30 天
//   node scripts/autorecall-replay.mjs 7 --full # 注入内容不截断
//
// ⚠️ 只读：不写任何文件、不改 config、不碰 src/。线上进程不受影响。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const MSG_DIR = path.join(ROOT, 'data/messages');

const argv = process.argv.slice(2);
const FULL = argv.includes('--full');
const arg = argv.find((a) => !a.startsWith('--'));
const DAYS = Math.max(1, Number(arg) || 7);

const { ChatStore } = await import('../src/store.js');
const { buildAutoRecall } = await import('../src/auto-recall.js');
const { isAtMe } = await import('../src/prompt.js');

// 与线上同源：从 config 取 bot 昵称，否则「@机器人」这条 B 条件永远不成立，回放全废。
// ⚠️ 坑：config 里 persona.selfNickname 常是空串、persona.botName 是小名，
//    而群里 @ 的是账号群昵称。线上靠 onebot.selfNickname 补，
//    脚本拿不到 → isAtMe 恒 false → 会把「@了我」误判成「没 @」。所以这里自动探测：
//    扫全库找出被 @ 最多的名字（机器人被 @ 的频率通常碾压任何群友）。
let botName = '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/config.json'), 'utf8'));
  botName = String(cfg?.persona?.selfNickname || cfg?.persona?.botName || '');
} catch { /* 读不到就走探测 */ }

const selfArg = argv.find((a) => a.startsWith('--self='));
const detectSelf = () => {
  const freq = new Map();
  const re = /@([\u4e00-\u9fa5A-Za-z0-9_·]{2,24})/g;
  for (const g of fs.existsSync(MSG_DIR) ? fs.readdirSync(MSG_DIR) : []) {
    const d = path.join(MSG_DIR, g);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (!m.text) continue;
        let x;
        while ((x = re.exec(String(m.text)))) freq.set(x[1], (freq.get(x[1]) || 0) + 1);
      }
    }
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  return top[0] ? { name: top[0][0], n: top[0][1], second: top[1]?.[1] || 0 } : null;
};

let atLabel;
if (selfArg) {
  botName = selfArg.slice(7);
  atLabel = `手动指定 --self=${botName}`;
} else {
  const det = detectSelf();
  if (det && det.n > det.second * 2) {
    botName = det.name;
    atLabel = `自动探测「@${botName}」${det.n} 次（次名仅 ${det.second} 次）`;
  } else {
    atLabel = `⚠️ 探测不可靠（${det ? `top1=${det.name}×${det.n} vs top2×${det.second}` : '无数据'}），@ 判断可能失真；可用 --self=昵称 指定`;
  }
}
console.log(`\n自身昵称：${atLabel}`);
const opts = { selfNickname: botName, botName, selfId: '' };

// 虚指/时间词：出现在选中词里就说明 VAGUE 表漏了它（表内的词根本走不到这里）
const LEAK = new Set(['昨晚', '前晚', '之前', '以前', '当时', '有人', '什么东西', '什么', '啥',
  '今天', '昨天', '刚才', '刚刚', '最近', '事情', '东西']);

const now = Date.now();
const from = now - DAYS * 864e5;
const store = new ChatStore();

// 收集窗口内的非自身消息
const items = [];
let scanned = 0;
for (const g of fs.existsSync(MSG_DIR) ? fs.readdirSync(MSG_DIR) : []) {
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
      if (!ts || ts < from) continue;
      scanned += 1;
      if (m.self) continue;
      const text = String(m.text ?? '');
      if (!text.trim()) continue;
      items.push({ ts, chat: g, text, senderName: String(m.senderName || m.senderId || '').slice(0, 10) });
    }
  }
}
items.sort((a, b) => a.ts - b.ts);

const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

const hit = [];      // 判定命中且抽得出词
const dead = [];     // 判定命中但抽词为空（这条本来就不该注入，是好事）
const noise = [];    // 有注入但注入内容明显与提问无关（启发式，需人工复核）

for (const it of items) {
  const r = buildAutoRecall(store, it.chat, [{ ts: it.ts, text: it.text, self: false, senderName: it.senderName }], opts);
  const used = r.stats.words || [];
  if (!used.length) {
    if (r.stats.hit === false && r.stats.words?.length === 0) {
      // 完全没判定命中，跳过；只有「判定过了但抽词空」才值得记
      continue;
    }
    dead.push({ ...it, stats: r.stats });
    continue;
  }
  const row = { ...it, stats: r.stats, body: r.text, at: isAtMe(it.text, opts) };
  hit.push(row);
  // 启发式判噪音：选中词是虚指/时间词，或命中数极低（≤2 基本只有那一两条）
  if (LEAK.has(used[0]) || r.stats.hits <= 2) noise.push(row);
}

const dist = new Map();
for (const h of hit) dist.set(h.chat, (dist.get(h.chat) || 0) + 1);

console.log(`\n窗口：最近 ${DAYS} 天（${fmt(from)} ~ ${fmt(now)}）`);
console.log(`扫描 ${scanned} 条（含自身）| 参与判定 ${items.length} 条（他人消息）`);
console.log(`判定命中且抽得出词 ${hit.length} 条 | 命中但抽词为空 ${dead.length} 条（这类不会注入，正常）`);
if (!hit.length) {
  console.log('\n窗口内没有任何「问机器人回忆旧事」的句子。');
  console.log('→ 说明这段时间群里确实没这个需求，不是功能失效。把天数调大再试：node scripts/autorecall-replay.mjs 30');
  process.exit(0);
}
console.log(`日均 ${(hit.length / DAYS).toFixed(2)} 条（注意：这是「所有被判定命中的消息」，`);
console.log(`线上还要求该轮 agent 被唤醒，所以真实触发 ≤ 这个数）`);

console.log('\n每群分布：');
[...dist.entries()].sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${String(n).padStart(3)} × ${c}`));

const atMe = hit.filter((h) => h.at);
console.log(`\n★ 关键拆分：${atMe.length} 条明确 @ 了我，${hit.length - atMe.length} 条没有。`);
console.log('  没有 @ 我的那些，线上多半不会被唤醒 → 判定根本不会跑。所以它们的噪音');
console.log('  不构成线上误报，但能暴露「判定/抽词本身有多松」，照样值得看。');

console.log(`\n${'═'.repeat(24)} 逐条注入内容（人工判：这跟提问有关吗？）${'═'.repeat(8)}`);
// @了我的排前面：这才是线上真会发生的场景
for (const h of [...hit].sort((a, b) => Number(b.at) - Number(a.at) || a.ts - b.ts)) {
  const flag = LEAK.has(h.stats.words[0]) ? '🔴 虚指词' : h.stats.hits <= 2 ? '🟡 命中过少' : '🟢';
  const atTag = h.at ? '【@我】' : '      ';
  console.log(`\n${flag}${atTag} [${fmt(h.ts)}] ${h.chat} ${h.senderName}`);
  console.log(`   问: ${h.text.replace(/\s+/g, ' ').slice(0, 70)}`);
  console.log(`   词: [${h.stats.words.join(',')}]  hits=${h.stats.hits}  ${h.stats.ms}ms`);
  const lines = String(h.body || '').split('\n').slice(1);  // 去掉固定表头
  if (!lines.length) { console.log('   注: (空)'); continue; }
  lines.forEach((l) => console.log('   注: ' + (FULL ? l : l.slice(0, 78))));
}

console.log(`\n${'═'.repeat(24)} 汇总 ${'═'.repeat(24)}`);
console.log(`有注入 ${hit.length} 条，其中启发式疑似噪音 ${noise.length} 条（${(noise.length / hit.length * 100).toFixed(0)}%）`);
if (noise.length) {
  console.log('疑似噪音的选中词分布：');
  const nw = new Map();
  for (const h of noise) nw.set(h.stats.words[0], (nw.get(h.stats.words[0]) || 0) + 1);
  [...nw.entries()].sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${String(n).padStart(3)} × ${w}`));
  console.log('\n→ 🔴 组的词如果不在 VAGUE 表里，说明表漏了它；🟡 组要人工看是不是真的没有相关内容。');
}
console.log(`\n★ 别忘了：回放只能证明「注入什么」，不能证明「模型用了答得对」。后者仍需线上样本。\n`);
