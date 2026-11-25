// L1 收敛 · 一次性迁移：给「现有 5 人」建派生画像视图（施工单 §4.5）。
//
//   node scripts/l1-profile-build.mjs                      # dry：只打印，不花钱、不写盘
//   node scripts/l1-profile-build.mjs --apply              # 真跑：每人最多 1 次压缩
//   node scripts/l1-profile-build.mjs --uid <uid> --apply
//   node scripts/l1-profile-build.mjs --repair             # dry：只预览「零调用修复」
//   node scripts/l1-profile-build.mjs --repair --apply      # 真修：补空维、重算统计，0 次调用
//
// 边界：不启动应用、不改 active、不改 l1-state；只写 people/<uid>.profile.json。
// 其余人靠固定槽日扫逐步补（每轮最多 12 人），不在本脚本范围内。
import fs from 'node:fs';
import { ChatStore } from '../src/store.js';
import { getConfig } from '../src/config.js';
import { listPersonIds, readPerson } from '../src/mem2/store.js';
import {
  computeDigest, readProfile, buildProfileQueue, PROFILE_KIND, repairProfileSlots
} from '../src/mem2/profile.js';
import { compressProfile } from '../src/mem2/l1.js';
import { quotaFile } from '../src/mem2/paths.js';
import { dayKeyOf } from '../src/mem2/llm.js';

const DAY_MS = 86400000;
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
// --force：即使 digest 未变也重压（模板/字数口径改了之后用），仍然每人最多 1 次调用
const FORCE = argv.includes('--force');
// --repair：零调用修复（补空维 + 重算统计），不调模型、不改 digest、不删槽
const REPAIR = argv.includes('--repair');
const uidIdx = argv.indexOf('--uid');
const ONLY_UID = uidIdx >= 0 ? String(argv[uidIdx + 1] || '').trim() : '';
if (uidIdx >= 0 && !ONLY_UID) {
  console.error('[profile-build] --uid 后面必须跟一个 QQ 号');
  process.exit(1);
}

const now = Date.now();
const pad = (s, n) => String(s).padEnd(n, ' ');

// ── 近 30 天发言量 + 全库排名（dry 必须打印，让「只覆盖 5 人」这件事可见）──
const store = new ChatStore(0);
const fromTs = now - 30 * DAY_MS;
const countByUid = new Map();
let msgTotal = 0;
for (const chatKey of store.listChats()) {
  for (const m of store.rangeByTs(chatKey, { fromTs, toTs: now, includeSelf: false }) || []) {
    const uid = String(m?.senderId ?? '').trim();
    if (!/^\d+$/.test(uid)) continue;          // 排除 self / 非数字发送者
    msgTotal += 1;
    countByUid.set(uid, (countByUid.get(uid) || 0) + 1);
  }
}
const ranked = [...countByUid.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
const rankOf = new Map(ranked.map(([uid], i) => [uid, i + 1]));
const qualified = ranked.filter(([, n]) => n >= 30).length;

console.log(`[profile-build] 近30天：消息 ${msgTotal} 条 / 发言人 ${ranked.length} 人 / ≥30条 ${qualified} 人`);
console.log(`[profile-build] 模式=${APPLY ? 'apply（真调 LLM）' : 'dry（零调用、零写盘）'}`
  + `${FORCE ? ' force（digest 未变也重压）' : ''}${REPAIR ? ' repair（零调用修复）' : ''}`
  + `${ONLY_UID ? ` uid=${ONLY_UID}` : ''}`);

// ── 配额与 token 余量（压缩与提炼共享 token 预算）──
let quota = { counts: {}, tokens: 0, dayKey: '' };
try { quota = JSON.parse(fs.readFileSync(quotaFile(), 'utf8')); } catch { /* 首次运行没有 */ }
const limits = getConfig()?.memory?.l4 || {};
const kindLimit = Number(limits.kindQuota?.[PROFILE_KIND]) || 60;
const tokenLimit = Number(limits.tokenBudgetPerDay) || 1400000;
const sameDay = quota.dayKey === dayKeyOf(now);
const usedToday = sameDay ? (quota.counts?.[PROFILE_KIND] || 0) : 0;
const tokensToday = sameDay ? (quota.tokens || 0) : 0;
console.log(`[profile-build] 配额 ${PROFILE_KIND}=${usedToday}/${kindLimit}`
  + ` token余量=${Math.max(0, tokenLimit - tokensToday)}/${tokenLimit}`
  + `${sameDay ? '' : '（quota.json 是昨天的，今天从 0 起算）'}`);

// ── 目标：现有 people 文件（= 现有 5 人），或 --uid 指定的一个人 ──
// 非 QQ 号的文件（测试残留，如 u1.jsonl）直接点名跳过：给它建画像只会把覆盖指标做假。
const allIds = listPersonIds();
const oddIds = allIds.filter((u) => !/^\d+$/.test(u));
if (oddIds.length) console.log(`[profile-build] 跳过非 QQ 号 people 文件：${oddIds.join(', ')}`);
const targets = ONLY_UID ? [ONLY_UID] : allIds.filter((u) => /^\d+$/.test(u));
if (!targets.length) {
  console.log('[profile-build] people/ 下没有任何画像文件，无需迁移');
  process.exit(0);
}

console.log(`\n${pad('uid', 14)}${pad('active', 8)}${pad('pinned', 8)}${pad('profile', 9)}${pad('dirty', 7)}${pad('近30天', 9)}${pad('排名', 7)}预计调用`);
// 判脏用日扫那套口径（digest / 漏维 / 题材词），不要另写一份：
// 另写会把「模型漏了一维」「画像里带题材词」判成干净，脚本说没事、日扫说脏，两边打架。
const queueReason = new Map(buildProfileQueue().map((q) => [q.uid, q.reason]));
const rows = [];
for (const uid of targets) {
  const person = readPerson(uid);
  const active = (person.list || []).filter((e) => e.status === 'active');
  const pinned = active.filter((e) => e.pinnedByUser === true).length;
  const profile = readProfile(uid);
  const digest = computeDigest(active);
  const reason = queueReason.get(uid) || '';
  const dirty = Boolean(reason);
  const calls = (FORCE || dirty) && active.length ? 1 : 0;   // active 为空写空画像，0 次调用
  const n30 = countByUid.get(uid) || 0;
  const rank = rankOf.get(uid) || '-';
  rows.push({ uid, active, pinned, profile, dirty, reason, calls, n30, rank });
  console.log(`${pad(uid, 14)}${pad(active.length, 8)}${pad(pinned, 8)}`
    + `${pad(profile ? `${profile.slots?.length ?? 0}槽` : '无', 9)}${pad(dirty ? `是(${reason})` : '否', 7)}`
    + `${pad(n30, 9)}${pad(rank, 7)}${calls}`);
}

const planned = rows.reduce((s, r) => s + r.calls, 0);
console.log(`\n[profile-build] 目标 ${rows.length} 人：脏 ${rows.filter((r) => r.dirty).length}`
  + ` / 有active ${rows.filter((r) => r.active.length).length}`
  + ` / 有profile ${rows.filter((r) => r.profile).length}`
  + ` / 预计调用 ${planned}`);
const top5 = ranked.slice(0, 5).map(([uid]) => uid);
console.log(`[profile-build] 发言量前5：${top5.join(', ')}`);
console.log(`[profile-build] 本次目标在全库的排名：${rows.map((r) => `${r.uid}=${r.rank}`).join('、')}`);

if (REPAIR) {
  // 零调用路径：只补空维（题材词只统计、不拦截，不删任何槽）。
  let changed = 0; let filledN = 0; let hitN = 0; let missing = 0;
  console.log(`\n[profile-build] ${APPLY ? '修复' : '预览修复'}（零调用）`);
  for (const r of rows) {
    const res = repairProfileSlots(r.uid, { activeEntries: r.active, now, apply: APPLY });
    if (!res.ok) { missing += 1; console.log(`  ${r.uid}: 无画像，跳过`); continue; }
    if (res.changed) changed += 1;
    filledN += res.filledDims.length;
    hitN += res.sensitiveHits;
    const dims = ['说话风格', '关系态度', '性格特质', '兴趣身份']
      .map((d) => `${d.slice(0, 2)}=${res.profile.slots.filter((s) => s.dim === d).length}`).join(' ');
    console.log(`  ${r.uid}: 槽=${res.profile.slots.length}（${dims}）`
      + ` 补维=${res.filledDims.join('/') || '-'} 敏感命中=${res.sensitiveHits}（不拦截）`);
  }
  console.log(`[profile-build] 修复${APPLY ? '完成' : '预览'}：改动 ${changed} 人 / 补维 ${filledN} 处`
    + ` / 敏感命中 ${hitN} 条 / 无画像 ${missing} 人（0 次调用）`);
  if (!APPLY) console.log('[profile-build] dry 结束（未写盘）。确认无误后加 --apply。');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n[profile-build] dry 结束（未写盘、未调用）。确认无误后加 --apply。');
  process.exit(0);
}

// ── apply：每人最多 1 次压缩 ──
let built = 0; let calls = 0; let skipped = 0; let failed = 0; let clean = 0;
for (const r of rows) {
  if (!r.dirty && !FORCE) { clean += 1; continue; }
  if (FORCE && !r.active.length) { clean += 1; continue; }   // 没有 active 时重压没意义
  const res = await compressProfile(r.uid, {
    now, activeEntries: r.active, profile: FORCE ? null : r.profile, force: FORCE,
    log: (...a) => console.log(...a)
  });
  calls += res.calls || 0;
  if (res.built) built += 1;
  else if (res.skipped) skipped += 1;
  else if (res.reason === 'clean') clean += 1;
  else failed += 1;
}

const after = rows.map((r) => ({ ...r, profile: readProfile(r.uid) }));
console.log(`\n[profile-build] 完成：建=${built} 干净=${clean} 配额跳过=${skipped} 失败=${failed} 调用=${calls}`);
console.log(`[profile-build] 覆盖：目标 ${after.length} 人中 有profile=${after.filter((r) => r.profile).length}`
  + ` / 有active=${after.filter((r) => r.active.length).length}`
  + ` / 两者都有=${after.filter((r) => r.profile && r.active.length).length}`);
for (const r of after) {
  if (!r.profile) continue;
  console.log(`  ${r.uid}: 槽=${r.profile.slots.length}/8 builtAt=${new Date(r.profile.builtAt).toLocaleString()}`
    + ` 覆盖=${r.profile.stats?.covered ?? '?'}/${r.profile.stats?.active ?? '?'}`);
}
process.exit(failed ? 1 : 0);