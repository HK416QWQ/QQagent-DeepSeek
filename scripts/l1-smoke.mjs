// L1 首扫冒烟测试。三种模式：
//   默认          —— 真实数据 + 真 LLM。配额有剩余时拒绝执行（防止误烧），--allow-real 强制。
//   --fake        —— 真实消息 + 假 LLM（零调用、零 token）。写盘重定向到临时目录，
//                    在真数据上把**写路径**走通：逐批落盘、水位推进、deduped 标记、去重写回。
//   --allow-real  —— 确认要真烧调用时才加（0 点后配额重置、想验证真产出时用）。
// 用法：cd QQ-agent-main && node scripts/l1-smoke.mjs [--fake|--allow-real]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from '../src/store.js';
import { setMem2Root, mem2Dir } from '../src/mem2/paths.js';
import { readPerson } from '../src/mem2/store.js';
import { getConfig } from '../src/config.js';
import {
  runDailySweep, collectPeopleAcrossChats, buildBatchesByChat, MIN_MSGS_FOR_L1
} from '../src/mem2/l1.js';

const FAKE = process.argv.includes('--fake');

// ── 配额闸：**读配置**，不再写死 40 —— 配置包把 kindQuota 改成 120 后闸仍然准确。
//    --fake 模式零调用，不经过这个闸。
let used = 0;
let limit = 0;
if (!FAKE) {
  const quota = JSON.parse(fs.readFileSync('data/mem2/quota.json', 'utf8'));
  used = quota.counts?.['l1-refine'] ?? 0;
  limit = Number(getConfig().memory.l4.kindQuota?.['l1-refine']) || 40;
  if (used < limit && !process.argv.includes('--allow-real')) {
    console.error(`[smoke] 拒绝执行：l1-refine 今日配额还有余量（${used}/${limit}），跑了会真烧调用。`);
    console.error(`[smoke] 确认要真跑就加 --allow-real；只想验写路径请用 --fake（零成本）。`);
    process.exit(1);
  }
  console.log(`[smoke] 配额 ${used}/${limit}，${used >= limit ? '已满，本次全路径零成本' : '⚠️ --allow-real 已指定，将真实烧调用'}`);
}

// 真实消息源（只读，与 mem2 根无关）
const store = new ChatStore(0);
const now = Date.now();
const sources = [];
for (const chatKey of store.listChats()) {
  const messages = store.rangeByTs(chatKey, { fromTs: 0, toTs: now }) || [];
  if (messages.length) sources.push({ chatKey, messages });
}
console.log(`[smoke] 群数=${sources.length} 消息总数=${sources.reduce((s, x) => s + x.messages.length, 0)}`);

// 预演：候选榜 + 批次分布（纯函数，无调用）
const people = collectPeopleAcrossChats(sources);
console.log(`\n[smoke] 合格人数(≥${MIN_MSGS_FOR_L1}条)=${people.length}，前 10 名：`);
let batchTotal = 0;
for (const p of people.slice(0, 10)) {
  const batches = buildBatchesByChat(p.messages);
  batchTotal += batches.length;
  console.log(`  ${p.userId}(${p.nickname || '?'}): ${p.count}条 / ${p.chatKeys.size}群 / ${batches.length}批`);
}
console.log(`  前10名合计 ${batchTotal} 批`);

if (FAKE) {
  // ── --fake：假 LLM 在真数据上走通写路径。写盘重定向到临时 mem2 根，真实画像零污染。──
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-smoke-fake-'));
  setMem2Root(fakeRoot);
  console.log(`\n[smoke --fake] 写盘根（临时）= ${fakeRoot}`);

  // 假熔断出口：
  //   提炼 → 每批回 2 条；
  //   去重 → **逐条回显输入**（新格式：序号 || 内容 || 组 || msgIds），等价于「本轮无需合并」。
  //   这样输出组数 = 输入条数，天然不触发坍缩阀，能完整验证写回路径（只 supersede 被列出的 =
  //   全部、未列出的 0 条、合并条 deduped:true）。
  const echoDedup = (userText) => userText
    .split('\n')
    .map((l) => {
      const mm = /^(\d+)\. \[([^\]]*)\] ([\s\S]*)$/.exec(l);
      if (!mm) return null;
      let rest = mm[3];
      const sep = rest.lastIndexOf(' || ');
      if (sep > 0) rest = rest.slice(0, sep);
      return `- ${mm[1]} || ${rest} || ${mm[2]} || -`;
    })
    .filter(Boolean)
    .join('\n');
  let n = 0;
  const fakeLlm = async (kind, { messages } = {}) => {
    n += 1;
    const userText = String(messages?.[1]?.content || '');
    const content = userText.startsWith('对这个人的印象条目')
      ? echoDedup(userText)
      : '- || 假·印象A：爱用波浪号 || 说话风格 || #1,#2\n- || 假·印象B：沉迷钓鱼 || 兴趣身份 || -';
    return { ok: true, result: { message: { content } } };
  };

  const done1 = [];                       // 首轮**跑完**的人（从日志行提取 uid）
  const partial1 = [];                    // 首轮被预算切断的人（半成品：deduped:false 是正确状态）
  const total = await runDailySweep({
    store, now, maxPeople: 4, maxCalls: 60, memLlmImpl: fakeLlm,
    log: (...a) => {
      const line = a.join(' '); console.log(line);
      const m = /\[l1\]\s*(\d+)\(/.exec(line);
      if (/→ (adopted|dropped)/.test(line) && m) done1.push(m[1]);
      if (line.includes('预算用尽') && m) partial1.push(m[1]);
    }
  });
  console.log(`[smoke --fake] 结果:`, JSON.stringify(total));

  // ── 写路径核验（全部对着临时根读）──
  const fail = (msg) => { console.error(`  ✗ ${msg}`); process.exitCode = 1; };
  const pass = (msg) => console.log(`  ✓ ${msg}`);
  const peopleDir = path.join(mem2Dir(), 'people');
  const files = fs.existsSync(peopleDir) ? fs.readdirSync(peopleDir).filter((f) => f.endsWith('.jsonl')) : [];
  if (!files.length) fail('people/ 下没有任何画像文件 —— 逐批落盘没发生');
  else pass(`逐批落盘：${files.length} 份画像文件`);

  let activeTotal = 0; let mergedTotal = 0; let supersededTotal = 0; let badDeduped = 0; let orderBad = 0;
  for (const f of files) {
    const uid = f.replace('.jsonl', '');
    const view = readPerson(uid);          // ★ 用 list（按 entryId 取最后一行的视图），不是 rows
    const rows = view.rows;
    const active = view.list.filter((r) => r.status === 'active');
    activeTotal += active.length;
    mergedTotal += active.filter((r) => r.deduped === true).length;
    supersededTotal += rows.filter((r) => r.status === 'superseded').length;
    // run 末去重后不允许再剩 active 且 deduped:false —— 但**被预算切断的人除外**：
    // 半成品保持 deduped:false 是设计（下 tick 的跨轮补账会捞回来），不是写回漏了。
    if (!partial1.includes(uid)) badDeduped += active.filter((r) => r.deduped === false).length;
    // 写回顺序：第一条 superseded 行必须晚于第一条 deduped:true 合并条（先 append 后 supersede）
    const firstMerged = rows.findIndex((r) => r.status === 'active' && r.deduped === true);
    const firstSuper = rows.findIndex((r) => r.status === 'superseded');
    if (firstMerged >= 0 && firstSuper >= 0 && firstSuper < firstMerged) orderBad += 1;
  }
  if (orderBad) fail(`写回顺序违规 ${orderBad} 处（superseded 行出现在合并条之前）`);
  else pass('去重写回顺序：合并条先落盘、superseded 行在后（崩在中间也只重不丢）');
  if (badDeduped) fail(`去重后仍剩 ${badDeduped} 条 active 且 deduped:false —— 写回漏了`);
  else pass(`deduped 标记：跑完的人零残留${partial1.length ? `（${partial1.length} 个被预算切断的半成品保留 deduped:false，待下轮补账）` : ''}`);
  console.log(`  [smoke --fake] active=${activeTotal} 合并条=${mergedTotal} superseded行=${supersededTotal} LLM调用=0`);

  // 水位推进：同一批人二轮必须被水位挡住（MAX_PEOPLE_PER_TICK 会轮到下一个人，那是正常轮转不是重炼）
  const done2 = [];
  await runDailySweep({
    store, now: now + 1, maxPeople: 4, maxCalls: 60,
    log: (...a) => { const line = a.join(' '); const m = /\[l1\]\s*(\d+)\(/.exec(line); if (line.includes('→') && m) done2.push(m[1]); },
    memLlmImpl: fakeLlm
  });
  const overlap = done1.filter((uid) => done2.includes(uid));
  if (overlap.length === 0) pass(`水位推进：首轮跑完的人二轮零重复提炼（二轮轮到 ${done2.length} 个新人 / 续跑半成品，均属正常）`);
  else fail(`水位没推进：二轮重复提炼了首轮跑完的人 ${overlap.join(',')}`);
  process.exit(process.exitCode || 0);
}

// 全路径：真 memLlm + 真配额（40/40 必拒，0 token、零写盘）
console.log(`\n[smoke] 开始全路径日扫（配额守卫兜底）...`);
const total = await runDailySweep({ store, now, log: (...a) => console.log(...a) });
console.log(`[smoke] 结果:`, JSON.stringify(total));
process.exit(0);
