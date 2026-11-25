// 去重坍缩事故的数据恢复脚本（2026-11-16 §16.5，一次性工具）。
//
// 背景：首扫 386 条画像被一次坍缩的语义去重压成 3 条，383 条被标 superseded。
// append-only 状态机的好处：383 条正文还在文件里，恢复只需追加状态行，**无需重炼**。
//
// 用法：
//   node scripts/l1-recover-dedup.mjs                 # 默认 dry-run，只打印计划
//   node scripts/l1-recover-dedup.mjs --apply         # 真正落盘
//   node scripts/l1-recover-dedup.mjs --uid=123456    # 指定人（默认事故当事人）
//
// 计划（undo 那次坍缩的去重，把 386 条恢复成「去重从未发生」的样子）：
//   1. 383 条被误废的条目 → 追加 status:'active'（deduped 保持 false）
//   2. 3 条坍缩合并条（_900/_901/_902）→ 保持 active，但把 deduped 翻回 false
//      （它们要作为「一条普通输入」参加下一次正确去重，而不是被标成「已去重」永远留着）
//   3. 校验 activePerson(uid) === 386，且这 386 条 deduped 全为 false
//
// 与施工单 §16.5「数据恢复」第 2 步的偏差（必须说明）：
//   单里第 2 步写「对 3 条合并条 append status:'superseded'」，但第 3 步的验收门槛是
//   activePerson === 386 —— 两者矛盾（383 恢复 + 3 废掉 = 383，不是 386）。
//   取 386：把 3 条合并条留在 active、只翻 deduped，这样下一轮去重看到的输入正好 386 条，
//   与「看 386 条去重是否收敛到 30~60」这条验收叙述一致。
import fs from 'node:fs';
import path from 'node:path';
import { readPerson, setPersonStatus, setPersonDeduped, activePerson } from '../src/mem2/store.js';
import { personFile } from '../src/mem2/paths.js';

const DEFAULT_UID = '';
const argUid = process.argv.find((a) => a.startsWith('--uid='));
const UID = (argUid ? argUid.split('=')[1] : DEFAULT_UID).trim();
if (!UID) {
  console.error('用法：node scripts/l1-recover-dedup.mjs --uid=<uid> [--apply]');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');
const DRY = !APPLY;

const file = personFile(UID);
if (!fs.existsSync(file)) {
  console.error(`[recover] 找不到 ${file}`);
  process.exit(1);
}

const view = readPerson(UID);
const rows = view.rows;
const list = view.list;

const isMerged = (e) => /_9\d\d$/.test(String(e.entryId));   // _900/_901/_902 段
const superseded = list.filter((e) => e.status === 'superseded');
const mergedActive = list.filter((e) => e.status === 'active' && isMerged(e));
const otherActive = list.filter((e) => e.status === 'active' && !isMerged(e));

console.log(`[recover] uid=${UID}  文件=${file}`);
console.log(`[recover] 行数=${rows.length}  唯一 entryId=${list.length}`);
console.log(`[recover] 现状：active=${list.filter((e) => e.status === 'active').length}`
  + `（其中合并条 ${mergedActive.length}） superseded=${superseded.length}`);
console.log('');

console.log('[recover] 计划：');
console.log(`  1) ${superseded.length} 条 status:'superseded' → 'active'（正文还在，只追加一行状态）`);
console.log(`  2) ${mergedActive.length} 条坍缩合并条（${mergedActive.map((e) => e.entryId.slice(-4)).join('/')}）`
  + ` 保持 active，deduped → false（作为普通输入参加下次正确去重）`);
console.log(`  3) 预期恢复后：active = ${superseded.length + mergedActive.length + otherActive.length}`
  + `（目标 386），deduped=false 的 active 数同样 ${superseded.length + mergedActive.length + otherActive.length}`);
console.log('');

// 断言计划里不夹带意外：除 383 被废 + 3 合并条外，不该有别的 active 条目
if (otherActive.length) {
  console.log(`  ⚠️ 注意：还有 ${otherActive.length} 条非合并条的 active 条目（不在恢复范围内，保持不动）：`);
  for (const e of otherActive.slice(0, 5)) console.log(`     - ${e.entryId} ${String(e.content).slice(0, 30)}`);
  console.log('');
}

if (DRY) {
  console.log('[recover] dry-run：未写任何行。核对上面数字无误后加 --apply。');
  process.exit(0);
}

let restored = 0;
for (const e of superseded) {
  if (setPersonStatus(UID, e.entryId, 'active', { nowTs: Date.now() })) restored += 1;
}
let flagged = 0;
for (const e of mergedActive) {
  if (setPersonDeduped(UID, e.entryId, false, { nowTs: Date.now() })) flagged += 1;
}
console.log(`[recover] 已写：恢复 ${restored} 条 active / 合并条翻 deduped ${flagged} 条`);

const after = activePerson(UID);
const afterAll = readPerson(UID).list;
const undeduped = after.filter((e) => e.deduped === false);
console.log(`[recover] 校验：activePerson=${after.length}（目标 386）  active 中 deduped=false=${undeduped.length}`);
console.log(`[recover] 行数=${readPerson(UID).rows.length}（原 ${rows.length} + ${restored + flagged}）`);
const ok = after.length === 386 && undeduped.length === 386 && afterAll.filter((e) => e.status === 'active').length === 386;
console.log(ok ? '[recover] ✅ 校验通过' : '[recover] ❌ 校验未通过，请人工检查');
process.exit(ok ? 0 : 1);
