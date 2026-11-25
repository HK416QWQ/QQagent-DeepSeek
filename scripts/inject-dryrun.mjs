// 第 3 期 step 6：注入干跑（真实群、真实 L1，**不调 LLM**）。
//
// 只做一件事：把每个群按「最近一批消息 → relevantUserIds → L1/L3（+摘要头）装配」跑一遍，
// 统计动态尾部的字数分布，用来判断 §4 的 L1 3,250 字配额是不是拍得合理。
//
// 关键：这条链路**零写入**。跑完比一次 mem2 下所有文件的 mtime/数量，必须一模一样。
//
// 用法：
//   node scripts/inject-dryrun.mjs            # 用 data/config.json 里的 memory.inject
//   node scripts/inject-dryrun.mjs --tail=30  # 每群取最近 30 条当作触发批
import fs from 'node:fs';
import path from 'node:path';
import { ChatStore } from '../src/store.js';
import { getConfig } from '../src/config.js';
import { mem2Dir } from '../src/mem2/paths.js';
import { createInjectAdapter } from '../src/mem2/inject.js';

const args = process.argv.slice(2);
const tailArg = args.find((a) => a.startsWith('--tail='));
const TAIL = tailArg ? Math.max(1, Number(tailArg.split('=')[1]) || 30) : 30;

const cfg = getConfig();
const injectCfg = cfg.memory?.inject || {};
const summaryHeadCfg = cfg.memory?.autoRecallSummaryHead || {};

const stamp = () => {
  const snap = new Map();
  const root = mem2Dir();
  if (!fs.existsSync(root)) return snap;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else snap.set(p, fs.statSync(p).mtimeMs + ':' + fs.statSync(p).size);
    }
  };
  walk(root);
  return snap;
};

const before = stamp();
const store = new ChatStore(0);
const adapter = createInjectAdapter({ peopleStore: store, cfg: injectCfg });
const now = Date.now();

const chats = store.listChats();
const rows = [];
let l3Count = 0;

for (const chatKey of chats) {
  const all = store.rangeByTs(chatKey, { fromTs: 0, toTs: now }) || [];
  if (!all.length) continue;
  // 触发批 = 最近 TAIL 条（真实运行时是未读批；干跑取最近一批最接近稳态）
  const trig = all.slice(-TAIL);
  const userIds = [...new Set(trig.filter((m) => !m.self && m.senderId).map((m) => String(m.senderId)))];
  const snap = adapter.promptSnapshot(chatKey, { userIds });
  // L3 本期无数据源：orchestrator 传的是空串，这里恒 0
  const l3Text = '';
  if (l3Text) l3Count += 1;

  rows.push({
    chatKey,
    msgs: all.length,
    userIds: userIds.length,
    people: Object.keys(snap.members || {}).length,
    impressions: Object.values(snap.members || {}).reduce((n, m) => n + m.impressions.length, 0),
    l1Chars: [...snap.text].length,
    tailChars: [...snap.text].length + [...l3Text].length,
    trimmed: snap.trimmed?.stage || 'none',
    droppedUsers: snap.trimmed?.droppedUsers ?? 0,
    droppedPinned: snap.trimmed?.droppedPinned ?? 0,
    overCap: snap.trimmed?.overCap === true
  });
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
};

const tail = rows.map((r) => r.tailChars);
const l1s = rows.map((r) => r.l1Chars);
const trimmedRows = rows.filter((r) => r.trimmed !== 'none');
const total = tail.reduce((a, b) => a + b, 0) || 1;

const after = stamp();
const changed = [];
for (const [p, sig] of after) if (before.get(p) !== sig) changed.push(p);
for (const p of before.keys()) if (!after.has(p)) changed.push(`${p}（被删）`);

const report = {
  generatedAt: new Date(now).toISOString(),
  config: injectCfg,
  chats: rows.length,
  tailPerChat: TAIL,
  tailChars: { p50: pct(tail, 50), p95: pct(tail, 95), max: Math.max(0, ...tail), avg: Math.round(total / Math.max(1, rows.length)) },
  l1Chars: { p50: pct(l1s, 50), p95: pct(l1s, 95), max: Math.max(0, ...l1s) },
  share: {
    l1: Math.round((l1s.reduce((a, b) => a + b, 0) / total) * 1000) / 10,
    l3: 0,
    // 【回溯命中】上限：第 0 期 2a 是 200 字；第 4 期带会话摘要头时 320（200 + extraBudget 120）。
    // 取**上界**：是否 attach 取决于当轮命中分布，注入干跑不逐条模拟回溯。
    recallUpperBound: summaryHeadCfg.enabled === true ? 320 : 200,
  },
  l3Appearances: l3Count,
  trimTriggered: trimmedRows.length,
  trimRate: Math.round((trimmedRows.length / Math.max(1, rows.length)) * 1000) / 10,
  writes: changed.length,
  changedFiles: changed.slice(0, 5),
  rows
};

const line = (k, v) => console.log(`  ${k.padEnd(14)} ${v}`);
console.log('════ 注入干跑（真实数据，未调 LLM）════');
line('群数', rows.length);
line('尾部字数 P50', report.tailChars.p50);
line('尾部字数 P95', report.tailChars.p95);
line('尾部最大', report.tailChars.max);
line('L1 P50/P95', `${report.l1Chars.p50} / ${report.l1Chars.p95}`);
line('裁剪触发率', `${report.trimRate}%（${trimmedRows.length}/${rows.length}）`);
line('L3 出现次数', report.l3Appearances);
line('写入文件数', report.writes);
console.log('\n  每群明细：');
for (const r of rows) {
  console.log(`   ${r.chatKey.padEnd(18)} 消息${String(r.msgs).padStart(6)} 人${String(r.people).padStart(3)}/${String(r.userIds).padStart(3)}`
    + ` 条${String(r.impressions).padStart(4)} L1=${String(r.l1Chars).padStart(4)}`
    + ` 尾=${String(r.tailChars).padStart(4)}${r.trimmed !== 'none' ? ` 裁:${r.trimmed}` : ''}`);
}

if (report.writes !== 0) {
  console.error(`\n  ✗ 注入过程写入了 ${report.writes} 个文件 —— 「注入 ≠ 召回」被破坏`);
  process.exit(1);
}
if (report.l3Appearances !== 0) {
  console.error('\n  ✗ L3 段出现了 —— 本期应恒为 0');
  process.exit(1);
}
