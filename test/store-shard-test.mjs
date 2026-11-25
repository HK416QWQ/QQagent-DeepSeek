// 消息存档分片的文件级测试。
//
// ── 为什么全部是「文件级」断言 ──
// store 的公开方法（getChatMeta / recent）都依赖内存里的 st.messages，
// 而本单元要防的 bug 恰恰是**内存对、磁盘错**：
//   · clearChat 后内存空了，但磁盘上的 2026-10.jsonl 还在 → 重启就复活
//   · 删掉最大 id 后内存 nextLocalId 还对，磁盘没有水位 → 重启 uid 撞车
// 所以这里一律直接读文件 / 读 _meta.json，并且**每次验证都新建 Store 实例**
// （模拟重启）。同进程内验证这些会给出虚假安全感 —— 见施工单 §9 风险 8。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-shard-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const { ChatStore, uidOf, readMetaFile } = await import(pathToFileURL(path.join(ROOT, 'src', 'store.js')).href);

const MSG_DIR = path.join(DATA, 'messages');
const safeKey = (k) => String(k).replace(/[^a-z0-9_]/gi, '_');
const dirOf = (k) => path.join(MSG_DIR, safeKey(k));
const shardPath = (k, ym) => path.join(dirOf(k), `${ym}.jsonl`);
const metaPath = (k) => path.join(dirOf(k), '_meta.json');

const ymOf = (ts) => {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const readShards = (k) => {
  const dir = dirOf(k);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const shardNames = (k) => {
  const dir = dirOf(k);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
};
const restart = () => new ChatStore(0);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// 构造两个稳定落在不同月份的时间：用「上个月 15 号」和「这个月 15 号」
const nowD = new Date();
const THIS_MONTH = new Date(nowD.getFullYear(), nowD.getMonth(), 15, 12, 0, 0).getTime();
const LAST_MONTH = new Date(nowD.getFullYear(), nowD.getMonth() - 1, 15, 12, 0, 0).getTime();
const THIS_YM = ymOf(THIS_MONTH);
const LAST_YM = ymOf(LAST_MONTH);
assert.notEqual(THIS_YM, LAST_YM, '测试前提：两个月必须不同');

// ── 1. 写这个月的消息 → 分片文件存在 ──
{
  const K = 'group:800000001';
  const st = new ChatStore(0);
  st.appendIncoming(K, { mid: 1, ts: THIS_MONTH, senderId: 'u', senderName: 'A', text: '本月' });
  assert.ok(fs.existsSync(shardPath(K, THIS_YM)), `应生成 ${THIS_YM}.jsonl`);
  assert.deepEqual(shardNames(K), [`${THIS_YM}.jsonl`]);
  ok(`分片写入：写 → ${THIS_YM}.jsonl 存在`);
}

// ── 2. 写上个月的消息 → 新分片出现，旧分片还在 ──
{
  const K = 'group:800000002';
  const st = new ChatStore(0);
  st.appendIncoming(K, { mid: 1, ts: THIS_MONTH, senderId: 'u', senderName: 'A', text: '本月' });
  st.appendIncoming(K, { mid: 2, ts: LAST_MONTH, senderId: 'u', senderName: 'A', text: '上月' });
  assert.ok(fs.existsSync(shardPath(K, THIS_YM)), '本月分片应还在');
  assert.ok(fs.existsSync(shardPath(K, LAST_YM)), '上月分片应新建');
  assert.equal(readShards(K).length, 2);
  ok(`跨月写入：${LAST_YM}.jsonl 与 ${THIS_YM}.jsonl 并存`);
}

// ── 3. 同月追加 → 行数正确，且是 JSONL 不是数组 ──
{
  const K = 'group:800000003';
  const st = new ChatStore(0);
  for (let i = 0; i < 3; i += 1) {
    st.appendIncoming(K, { mid: i, ts: THIS_MONTH + i * 1000, senderId: 'u', senderName: 'A', text: `m${i}` });
  }
  const text = fs.readFileSync(shardPath(K, THIS_YM), 'utf8');
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 3, '三行');
  // 每行必须是独立 JSON 对象，不是数组元素
  for (const l of lines) {
    const o = JSON.parse(l);
    assert.ok(!Array.isArray(o) && typeof o === 'object' && o !== null);
  }
  assert.ok(!text.trimStart().startsWith('['), 'JSONL 不能是 JSON 数组');
  ok('同月追加 3 条：文件 3 行、每行独立 JSON（不是数组）');
}

// ── 4. 追加不重写文件（前缀字节不变）──
{
  const K = 'group:800000004';
  const st = new ChatStore(0);
  st.appendIncoming(K, { mid: 1, ts: THIS_MONTH, senderId: 'u', senderName: 'A', text: 'first' });
  const p = shardPath(K, THIS_YM);
  const beforeBuf = fs.readFileSync(p);
  const beforeLen = beforeBuf.length;

  st.appendIncoming(K, { mid: 2, ts: THIS_MONTH + 1000, senderId: 'u', senderName: 'A', text: 'second' });
  const afterBuf = fs.readFileSync(p);
  assert.ok(afterBuf.length > beforeLen, '文件应变长');
  assert.ok(afterBuf.subarray(0, beforeLen).equals(beforeBuf),
    '追加必须保留原有字节（重写会让 mtime/inode 变化，也意味着 O(n) 成本回来了）');
  ok('追加不重写：原有字节完全保留，只在末尾增长');
}

// ── 5. ★ _meta.json 的写时机：rewrite 时写；纯 append 靠 maxId 兜底 ──
// ⚠️ 这是**实测驱动的设计**，与施工单伪代码（每次 saveChat 都写）不同：
//    Windows 上 `writeFileSync + rename` 实测 1.26 ms，每次都写会把最热的
//    「新消息」路径从 0.5 ms 拉到 5 ms（实测 appendIncoming 均值 5.0 ms），
//    直接达不到 §6.2 的 < 0.5 ms。
//    正确性不受影响：新条目已经进了 .jsonl，loadChat 用 max(meta, maxId+1) 算水位；
//    唯一需要 meta 的场景是「删掉当前最大 id」（maxId 会下降），而那必然走 rewrite
//    （removeByLocalIds 标 dirty / clearChat·prune·#trim 标 allDirty）。
{
  const K = 'group:800000005';
  const st = new ChatStore(0);
  for (let i = 0; i < 3; i += 1) {
    st.appendIncoming(K, { mid: i, ts: THIS_MONTH + i, senderId: 'u', senderName: 'A', text: `m${i}` });
  }
  // 纯 append：meta 可以不存在，但重启后水位必须由 maxId+1 兜住
  const b1 = restart();
  assert.equal(b1.getChatMeta(K).total, 3);
  const e1 = b1.appendIncoming(K, { mid: 'x', ts: THIS_MONTH + 10, senderId: 'u', senderName: 'A', text: 'x' });
  assert.equal(e1.id, 4, '纯 append 后重启，id 必须接着 4（maxId+1 兜底）');

  // 触发一次 rewrite（标已读）→ 这时必须写 meta
  assert.equal(b1.markEntryRead(K, e1.id), true);
  const meta1 = Number(readMetaFile(K).nextLocalId) || 0;
  assert.ok(meta1 >= 5, `rewrite 后 _meta.json 必须存在且 nextLocalId ≥5，实际 ${meta1}`);

  // 再 append + rewrite：水位单调不减
  const e2 = b1.appendIncoming(K, { mid: 'y', ts: THIS_MONTH + 11, senderId: 'u', senderName: 'A', text: 'y' });
  b1.markEntryRead(K, e2.id);
  const meta2 = Number(readMetaFile(K).nextLocalId) || 0;
  assert.ok(meta2 >= meta1, `nextLocalId 必须单调不减：${meta1} → ${meta2}`);
  ok(`★ _meta.json 写时机：纯 append 靠 maxId 兜底（新 id=${e1.id}），rewrite 时写入（${meta1} → ${meta2} 单调不减）`);
}

// ── 6. 读回：合并两个月并按 ts 排序 ──
{
  const K = 'group:800000006';
  const st = new ChatStore(0);
  // 故意乱序写入
  st.appendIncoming(K, { mid: 1, ts: THIS_MONTH, senderId: 'u', senderName: 'A', text: '本月' });
  st.appendIncoming(K, { mid: 2, ts: LAST_MONTH, senderId: 'u', senderName: 'A', text: '上月' });
  const boot = restart();
  const msgs = boot.recent(K, { limit: 10 });
  assert.equal(msgs.length, 2);
  assert.ok(msgs[0].ts <= msgs[1].ts, '读回必须按 ts 升序（跨月边界也要正确）');
  assert.equal(msgs[0].text, '上月');
  ok('loadChat：合并两个月并按 ts 排序');
}

// ── 7. 同 ts 两条按 id 排序（稳定）──
{
  const K = 'group:800000007';
  const st = new ChatStore(0);
  const ts = THIS_MONTH;
  st.appendIncoming(K, { mid: 1, ts, senderId: 'u', senderName: 'A', text: 'A' });   // id=1
  st.appendIncoming(K, { mid: 2, ts, senderId: 'u', senderName: 'A', text: 'B' });   // id=2
  const boot = restart();
  const msgs = boot.recent(K, { limit: 10 });
  assert.deepEqual(msgs.map((m) => m.id), [1, 2], '同 ts 必须按 id（= 写入序）稳定排序');
  ok('同 ts 的两条按 id 排序（等价于写入序）');
}

// ── 8. 坏行被跳过并计入 badRows ──
{
  const K = 'group:800000008';
  fs.mkdirSync(dirOf(K), { recursive: true });
  const good1 = { id: 1, ts: THIS_MONTH, text: 'good1' };
  const good2 = { id: 2, ts: THIS_MONTH + 1000, text: 'good2' };
  fs.writeFileSync(shardPath(K, THIS_YM),
    `${JSON.stringify(good1)}\n{"id": 99, "ts":  broken\n${JSON.stringify(good2)}\n`, 'utf8');
  const boot = restart();
  const msgs = boot.recent(K, { limit: 10 });
  assert.equal(msgs.length, 2, '坏行必须被跳过，其余行仍可读');
  assert.deepEqual(msgs.map((m) => m.id), [1, 2]);
  const badRows = Number(readMetaFile(K).badRows) || 0;
  assert.ok(badRows >= 1, `_meta.json 的 badRows 应 ≥1，实际 ${badRows}`);
  ok(`坏行跳过：读到 2 条好数据，badRows=${badRows}`);
}

// ── 9. ★ ts 非法的条目不丢弃，归 0000-00（读写对称）──
{
  const K = 'group:800000009';
  fs.mkdirSync(dirOf(K), { recursive: true });
  // 直接写进 0000-00.jsonl，模拟「写进去就不能读回来」的回归
  const weird = { id: 1, ts: 'not-a-number', text: '没有时间戳' };
  const normal = { id: 2, ts: THIS_MONTH, text: '正常' };
  fs.writeFileSync(shardPath(K, '0000-00'), `${JSON.stringify(weird)}\n`, 'utf8');
  fs.writeFileSync(shardPath(K, THIS_YM), `${JSON.stringify(normal)}\n`, 'utf8');

  const boot = restart();
  const msgs = boot.recent(K, { limit: 10 });
  assert.equal(msgs.length, 2, `★ ts 非法的条目不能被丢弃（否则写进去读不出来，下次 rewrite 还会覆盖掉）。实际读到 ${msgs.length} 条`);
  assert.ok(msgs.some((m) => m.text === '没有时间戳'), '非法 ts 那条必须读得回来');
  ok('★ ts 非法不丢弃：归 0000-00 且能读回来（读写对称）');
}

// ── 10. nextLocalId 来自 _meta.json，不是 max+1 ──
{
  const K = 'group:800000010';
  fs.mkdirSync(dirOf(K), { recursive: true });
  // 只有 id=1,2 的数据，但水位被抬到 100（模拟"删过最大 id"或手工拷入）
  fs.writeFileSync(shardPath(K, THIS_YM),
    `${JSON.stringify({ id: 1, ts: THIS_MONTH, text: 'a' })}\n${JSON.stringify({ id: 2, ts: THIS_MONTH + 1, text: 'b' })}\n`, 'utf8');
  fs.writeFileSync(metaPath(K), JSON.stringify({ schema: 1, nextLocalId: 100 }), 'utf8');

  const boot = restart();
  const fresh = boot.appendIncoming(K, { mid: 'n', ts: THIS_MONTH + 2, senderId: 'u', senderName: 'A', text: 'new' });
  assert.equal(fresh.id, 100, `新 id 必须取 _meta.json 的 100，而不是 max+1=3（实际 ${fresh.id}）`);
  ok('nextLocalId 来自 _meta.json（不是 max+1）：实测拿到 100');
}

// ── 11. markEntryRead 只重写该条所在的月 ──
{
  const K = 'group:800000011';
  const st = new ChatStore(0);
  st.appendIncoming(K, { mid: 1, ts: LAST_MONTH, senderId: 'u', senderName: 'A', text: '上月' });
  const cur = st.appendIncoming(K, { mid: 2, ts: THIS_MONTH, senderId: 'u', senderName: 'A', text: '本月' });
  await sleep(15);
  const lastMtime = fs.statSync(shardPath(K, LAST_YM)).mtimeMs;
  const thisMtime = fs.statSync(shardPath(K, THIS_YM)).mtimeMs;

  assert.equal(st.markEntryRead(K, cur.id), true);
  await sleep(15);
  const lastMtime2 = fs.statSync(shardPath(K, LAST_YM)).mtimeMs;
  const thisMtime2 = fs.statSync(shardPath(K, THIS_YM)).mtimeMs;
  // 两条缺一不可：只验「另一月没变」的话，markDirty 变成空函数也会通过
  // （两月都不变 → 另一月确实没变），测试就成了摆设。
  assert.ok(thisMtime2 > thisMtime, '该条所在的月必须被重写（否则改动没落盘）');
  assert.equal(lastMtime2, lastMtime, '另一月不该被重写（只改了本月那条）');
  ok('markEntryRead：只重写该条所在月，另一月 mtime 不变');
}

// ── 12. removeByLocalIds 删跨月两条 → 两个月都重写 ──
{
  const K = 'group:800000012';
  const st = new ChatStore(0);
  const a = st.appendIncoming(K, { mid: 1, ts: LAST_MONTH, senderId: 'u', senderName: 'A', text: '上月' });
  st.appendIncoming(K, { mid: 2, ts: LAST_MONTH + 1, senderId: 'u', senderName: 'A', text: '上月2' });
  const c = st.appendIncoming(K, { mid: 3, ts: THIS_MONTH, senderId: 'u', senderName: 'A', text: '本月' });
  st.appendIncoming(K, { mid: 4, ts: THIS_MONTH + 1, senderId: 'u', senderName: 'A', text: '本月2' });
  await sleep(15);
  const m0 = fs.statSync(shardPath(K, LAST_YM)).mtimeMs;
  const m1 = fs.statSync(shardPath(K, THIS_YM)).mtimeMs;

  assert.equal(st.removeByLocalIds(K, [a.id, c.id]), 2);
  await sleep(15);
  assert.ok(fs.statSync(shardPath(K, LAST_YM)).mtimeMs > m0, '上月文件应被重写');
  assert.ok(fs.statSync(shardPath(K, THIS_YM)).mtimeMs > m1, '本月文件应被重写');
  const left = readShards(K).map((m) => m.text).sort();
  assert.deepEqual(left, ['上月2', '本月2']);
  ok('removeByLocalIds 跨月删两条：两个月都被重写，其余内容正确');
}

// ── 13. ★★ 某月被删空 → .jsonl 文件被删除（不是留空文件）──
{
  const K = 'group:800000013';
  const st = new ChatStore(0);
  const oldOne = st.appendIncoming(K, { mid: 1, ts: LAST_MONTH, senderId: 'u', senderName: 'A', text: '上个月唯一一条' });
  st.appendIncoming(K, { mid: 2, ts: THIS_MONTH, senderId: 'u', senderName: 'A', text: '本月' });
  assert.ok(fs.existsSync(shardPath(K, LAST_YM)), '前提：上月分片存在');

  st.removeByLocalIds(K, [oldOne.id]);
  assert.ok(!fs.existsSync(shardPath(K, LAST_YM)),
    `★★ 被删空的月份文件必须真的消失（${LAST_YM}.jsonl 还在 = clearChat/prune 会静默失效）`);
  assert.ok(fs.existsSync(shardPath(K, THIS_YM)), '本月分片不受影响');
  ok('★★ 某月被删空：该 .jsonl 真的被删除（不是留个空文件）');
}

// ── 14. ★★ clearChat → .jsonl 全删、_meta.json 保留、nextLocalId 不变 ──
{
  const K = 'group:800000014';
  const st = new ChatStore(0);
  st.appendIncoming(K, { mid: 1, ts: LAST_MONTH, senderId: 'u', senderName: 'A', text: '上月' });
  st.appendIncoming(K, { mid: 2, ts: THIS_MONTH, senderId: 'u', senderName: 'A', text: '本月' });
  // 水位从内存 state 取（纯 append 不写 meta；clearChat 会写）
  const water = st.chats.get(K).nextLocalId;
  assert.ok(water >= 3, `前提：水位应 ≥3，实际 ${water}`);

  const removed = st.clearChat(K);
  assert.equal(removed, 2);
  assert.deepEqual(shardNames(K), [], '★★ clearChat 后所有 .jsonl 必须消失');
  assert.ok(fs.existsSync(metaPath(K)), '_meta.json 必须保留（它承载 id 水位）');
  assert.equal(Number(readMetaFile(K).nextLocalId), water, 'nextLocalId 不能被 clearChat 改写');

  // 重启后仍然是空的 —— 这条才咬得住"删了又回来"
  const boot = restart();
  assert.equal(boot.getChatMeta(K).total, 0, '★★ 重启后该群必须仍是 0 条（不是复活）');
  ok(`★★ clearChat：.jsonl 全删、_meta.json 保留、水位 ${water} 不变、重启仍 0 条`);
}

// ── 15. ★ pruneBefore 删掉整个旧月 → 重启后旧月不复活 ──
{
  const K = 'group:800000015';
  // ⚠️ pruneBefore 遍历 listChats()，是**全局**操作 —— 前面用例留下的群也在里面，
  //    不清理的话返回值会把它们的旧消息算进去。这里只留本群的目录。
  for (const name of fs.readdirSync(MSG_DIR)) {
    if (name === safeKey(K)) continue;
    fs.rmSync(path.join(MSG_DIR, name), { recursive: true, force: true });
  }
  const st = new ChatStore(0);
  st.appendIncoming(K, { mid: 1, ts: LAST_MONTH, senderId: 'u', senderName: 'A', text: '旧月' });
  st.appendIncoming(K, { mid: 2, ts: THIS_MONTH, senderId: 'u', senderName: 'A', text: '本月' });

  const cutoff = new Date(nowD.getFullYear(), nowD.getMonth(), 1).getTime();   // 本月 1 号 00:00
  const n = st.pruneBefore(cutoff);
  assert.equal(n, 1, '应删掉上月那条');
  assert.ok(!fs.existsSync(shardPath(K, LAST_YM)), '旧月分片必须被删除');

  const boot = restart();
  const texts = boot.recent(K, { limit: 10 }).map((m) => m.text);
  assert.deepEqual(texts, ['本月'], `★ 重启后旧月数据不能复活（实际读到 ${JSON.stringify(texts)}）`);
  ok('★ pruneBefore 删整月：重启后旧月不复活，只剩本月');
}

// ── 16. 旧扁平 group_1.json 存在、无子目录 → 能读出来 ──
{
  const K = 'group:800000016';
  fs.mkdirSync(MSG_DIR, { recursive: true });
  fs.writeFileSync(path.join(MSG_DIR, `${safeKey(K)}.json`), JSON.stringify({
    chatKey: K,
    nextLocalId: 5,
    messages: [{ id: 1, ts: THIS_MONTH, text: '旧格式' }, { id: 2, ts: THIS_MONTH + 1, text: '旧格式2' }]
  }), 'utf8');
  assert.ok(!fs.existsSync(dirOf(K)), '前提：没有分片目录');

  const boot = restart();
  const msgs = boot.recent(K, { limit: 10 });
  assert.equal(msgs.length, 2, '旧扁平文件必须还能读');
  const fresh = boot.appendIncoming(K, { mid: 'n', ts: THIS_MONTH + 2, senderId: 'u', senderName: 'A', text: '新' });
  assert.equal(fresh.id, 5, 'prune 时 nextLocalId 要沿用旧文件的 5');
  ok('兼容：旧扁平 .json 无子目录时仍能读，且沿用旧 nextLocalId');
}

// ── 17. listChats 同时识别子目录和旧扁平文件 ──
{
  const KNew = 'group:800000017';
  const KOld = 'group:800000018';
  const st = new ChatStore(0);
  st.appendIncoming(KNew, { mid: 1, ts: THIS_MONTH, senderId: 'u', senderName: 'A', text: '新' });
  fs.writeFileSync(path.join(MSG_DIR, `${safeKey(KOld)}.json`), JSON.stringify({
    chatKey: KOld, nextLocalId: 2, messages: [{ id: 1, ts: THIS_MONTH, text: '旧' }]
  }), 'utf8');

  const boot = restart();
  const list = boot.listChats();
  assert.ok(list.includes(KNew), `listChats 必须识别分片目录（实际 ${JSON.stringify(list)}）`);
  assert.ok(list.includes(KOld), 'listChats 必须识别旧扁平文件');
  ok('listChats：分片目录 + 旧扁平文件 两种都认');
}

// ── 18. ★ clearChat 后（空目录在）→ 不回退读旧扁平文件 ──
{
  const K = 'group:800000019';
  // 同时准备：旧扁平文件 + 空的分片目录（模拟"迁移后用户清空了该群"）
  fs.mkdirSync(MSG_DIR, { recursive: true });
  fs.writeFileSync(path.join(MSG_DIR, `${safeKey(K)}.json`), JSON.stringify({
    chatKey: K, nextLocalId: 3, messages: [{ id: 1, ts: THIS_MONTH, text: '沉睡的旧数据' }]
  }), 'utf8');
  fs.mkdirSync(dirOf(K), { recursive: true });
  fs.writeFileSync(metaPath(K), JSON.stringify({ schema: 1, nextLocalId: 3 }), 'utf8');

  const boot = restart();
  const msgs = boot.recent(K, { limit: 10 });
  assert.equal(msgs.length, 0,
    `★ 目录存在但无分片时必须返回空，不能回退读旧扁平文件 —— `
    + '否则 clearChat 之后重启会把已删数据"复活"（实际读到 ' + msgs.length + ' 条）');
  ok('★ clearChat 后空目录存在：不回退读旧扁平文件（不复活）');
}

// ── 19. ★★ 未迁移保护：旧扁平文件还在时，第一次写盘必须把历史带进分片 ──
// 这是施工单没预见的坑，也是本单最危险的一条：
//   代码更新了、但没跑迁移脚本 → 启动读旧 .json（1.4 万条历史）→ 来一条新消息
//   → 写盘创建分片目录、只追加那 1 条 → 下次启动目录已存在，loadChat 只读分片
//   → **1.4 万条历史从视野里消失**。
// 保护措施：loadChat 从旧文件读出的 state 打 FROM_LEGACY 标记，
// saveChat 见到它就强制全量重写，把历史一起写进分片。
{
  const K = 'group:800000020';
  // 造一个"只存在于旧扁平文件"的群：3 条历史，跨两个月
  fs.mkdirSync(MSG_DIR, { recursive: true });
  fs.writeFileSync(path.join(MSG_DIR, `${safeKey(K)}.json`), JSON.stringify({
    chatKey: K,
    nextLocalId: 4,
    messages: [
      { id: 1, ts: LAST_MONTH, text: '历史1' },
      { id: 2, ts: LAST_MONTH + 1000, text: '历史2' },
      { id: 3, ts: THIS_MONTH, text: '历史3' }
    ]
  }), 'utf8');
  assert.ok(!fs.existsSync(dirOf(K)), '前提：还没有分片目录（= 没跑过迁移）');

  const st = restart();                       // loadChat 走旧格式分支
  assert.equal(st.getChatMeta(K).total, 3, '先从旧文件读到 3 条历史');
  st.appendIncoming(K, { mid: 'new', ts: THIS_MONTH + 2000, senderId: 'u', senderName: 'A', text: '新消息' });

  // 关键：历史必须已经进了分片，不能只留 1 条新消息
  const shards = shardNames(K);
  assert.ok(shards.length >= 1, '写盘后分片目录应已创建');
  const onDisk = readShards(K);
  assert.equal(onDisk.length, 4,
    `★★ 第一次写盘必须把 3 条历史 + 1 条新消息一起写进分片（实际只有 ${onDisk.length} 条）—— `
    + '否则重启后目录存在、loadChat 只读分片，历史就"消失"了');

  const boot = restart();
  assert.equal(boot.getChatMeta(K).total, 4, '★★ 重启后必须仍是 4 条（历史不能消失）');
  assert.ok(boot.recent(K, { limit: 10 }).some((m) => m.text === '历史1'), '历史消息必须读得回来');
  ok('★★ 未迁移保护：旧文件还在时首次写盘全量重写，历史不丢（4 条全部落到分片）');
}

// 清理
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── store-shard：${passed} 项通过`);
