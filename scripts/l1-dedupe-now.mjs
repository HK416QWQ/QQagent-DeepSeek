// 对某个人跑**一次**语义去重（不重炼），用于 §16.5 事故恢复后的收敛验证。
//
// 背景：大 V 的 386 条已恢复成 active + deduped:false，但水位已经推到尾部（只剩 2 条未提炼），
// 按触发条件他要攒够 80 条才会再次进入 refine —— 那要等好几天。这个脚本直接用 refine 的
// 同一个 runDedup() 把这次去重跑掉，等价于「他下次触发时只花 1 次调用去重」。
//
// 用法：
//   node scripts/l1-dedupe-now.mjs                  # 默认 dry：只报到重条数，不发调用
//   node scripts/l1-dedupe-now.mjs --apply          # 真发 1 次 l1-refine 调用（计配额）
//   node scripts/l1-dedupe-now.mjs --apply --uid=X  # 指定人
import { readPerson, activePerson } from '../src/mem2/store.js';
import { runDedup } from '../src/mem2/l1.js';

const argUid = process.argv.find((a) => a.startsWith('--uid='));
const UID = (argUid ? argUid.split('=')[1] : '').trim();
if (!UID) {
  console.error('用法：node scripts/l1-dedupe-now.mjs --uid=<uid> [--apply] [--force]');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');   // 对已 deduped:true 的 active 条目再收一轮

const scope = FORCE
  ? activePerson(UID)
  : readPerson(UID).list.filter((e) => e.status === 'active' && e.deduped === false);
const active = activePerson(UID);
console.log(`[dedupe-now] uid=${UID}  active=${active.length}  待去重(deduped:false)=${scope.length}`);

if (scope.length <= 1) {
  console.log('[dedupe-now] 待去重条目 ≤1，无需调用。');
  process.exit(0);
}
if (!APPLY) {
  console.log('[dedupe-now] dry-run：未发调用。确认后加 --apply（会消耗 1 次 l1-refine 配额）。');
  process.exit(0);
}

const t0 = Date.now();
const r = await runDedup({ userId: UID, scope, now: t0, log: (...a) => console.log(...a) });
const ms = Date.now() - t0;
console.log(`[dedupe-now] 结果 ok=${r.ok}${r.ok ? '' : ` reason=${r.reason}`} collapsed=${r.collapsed}`
  + ` 调用=${r.calls} 合并条=${r.added} 覆盖=${r.superseded} 标去重=${r.markedDeduped}`
  + ` 坏组号=${r.badDedupIds} produced=${r.produced} 用时=${(ms / 1000).toFixed(1)}s`);

const after = activePerson(UID);
console.log(`[dedupe-now] 校验：active=${after.length}（目标 30~60）`
  + `  deduped=true 的=${after.filter((e) => e.deduped === true).length}`);
process.exit(r.ok && after.length >= 5 ? 0 : 1);
