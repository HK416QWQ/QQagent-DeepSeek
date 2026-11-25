// 稳定 id（uid）规则 + nextLocalId 水位的单测。
//
// ── 为什么这个文件存在 ──
// uid 由 `chatKey + '#' + id` 派生、**不落盘**（落盘等于同一事实存两份，不一致时
// 无法判断哪份对）。代价是规则必须永久冻结 —— 一旦改了，所有已入库的记忆条目、
// 索引门牌、UI 编辑留痕全部失效。所以这里把规则钉成断言。
//
// ── 为什么每条持久化断言都要「新建实例」──
// 施工单 §7.1 的坑三：`st.nextLocalId` 在内存里还在，同一个进程内再写一条，
// 无论实现对不对都会通过 —— 那是虚假安全感。**必须模拟重启**（new ChatStore）。
// 下面带 ★ 的几条全是这个原因。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-uid-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const { ChatStore, uidOf, readMetaFile } = await import(pathToFileURL(path.join(ROOT, 'src', 'store.js')).href);
const MSG_DIR = path.join(DATA, 'messages');

const safeKey = (chatKey) => String(chatKey).replace(/[^a-z0-9_]/gi, '_');
const chatDir = (chatKey) => path.join(MSG_DIR, safeKey(chatKey));

/** 读该群所有分片合并（文件级验证，不走 store 的实现） */
function readShards(chatKey) {
  const dir = chatDir(chatKey);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

/** ★ 模拟重启：全新实例，只从磁盘恢复 */
const restart = () => new ChatStore(0);

const KEY = 'group:700000001';
const DAY = 86400000;

// ── 1. 规则本身 ──
assert.equal(uidOf('group:1', 1), 'group:1#1', '规则必须是 chatKey + # + id');
assert.equal(uidOf('private:42', 7), 'private:42#7', '私聊同样适用');
ok('uidOf：group:1#1 / private:42#7');

// ── 2. 不同 chatKey 的 id=1 不冲突 ──
assert.notEqual(uidOf('group:1', 1), uidOf('group:2', 1), 'chatKey 必须参与，否则跨群撞车');
assert.notEqual(uidOf('group:1', 1), uidOf('private:1', 1));
ok('不同 chatKey 的 id=1 互不冲突（跨群唯一性）');

// ── 3. 幂等 ──
assert.equal(uidOf(KEY, 99), uidOf(KEY, 99), '同一输入必须永远同一输出');
ok('同 (chatKey,id) 稳定：调用两次结果相同');

// ── 4. 不含空格 / 换行 / 逗号 ──
assert.ok(!/[\s,\n\r]/.test(uidOf('group:1', 1)), `uid 不能含分隔符：${uidOf('group:1', 1)}`);
assert.ok(!/[\s,\n\r]/.test(uidOf(KEY, 12345)));
ok('uid 不含空格 / 换行 / 逗号（能安全塞进 CSV 与日志）');

// ── 5. 删除不重排：删 id=3 后 id=4 的 uid 不变 ──
{
  const K = 'group:700000005';   // 每个用例独立 chatKey —— 复用同一个会被前面的数据污染
  const st = new ChatStore(0);
  const a = st.appendIncoming(K, { mid: 1, ts: Date.now(), senderId: 'u', senderName: 'A', text: '一' });
  st.appendIncoming(K, { mid: 2, ts: Date.now(), senderId: 'u', senderName: 'A', text: '二' });
  const c = st.appendIncoming(K, { mid: 3, ts: Date.now(), senderId: 'u', senderName: 'A', text: '三' });
  const d = st.appendIncoming(K, { mid: 4, ts: Date.now(), senderId: 'u', senderName: 'A', text: '四' });
  const beforeUid = uidOf(K, d.id);
  assert.equal(st.removeByLocalIds(K, [c.id]), 1);
  const after = restart();
  const four = after.findByLocalId(K, d.id);
  assert.ok(four, 'id=4 必须还在');
  assert.equal(uidOf(K, four.id), beforeUid, '删中间一条不能改变后面条目的 uid');
  assert.equal(a.id, 1);
  ok('删掉 id=3 后，id=4 的 uid 不变（删除不重排）');
}

// ── 6. ★ clearChat 后重启，新 id 接着旧水位 ──
{
  const K = 'group:700000006';
  const st = new ChatStore(0);
  st.appendIncoming(K, { mid: 'c1', ts: Date.now(), senderId: 'u', senderName: 'A', text: 'x' });
  st.appendIncoming(K, { mid: 'c2', ts: Date.now(), senderId: 'u', senderName: 'A', text: 'y' });
  // 水位从内存 state 取：纯 append 不写 _meta.json（见 store-shard 第 5 条的说明），
  // clearChat 才会写。这里要验的是「清空之后水位还在」，所以先拿内存值。
  // 注意 st.chats 是 ChatStore 的公开 Map（state 本身不可直接访问）。
  const watermark = st.chats.get(K).nextLocalId;
  assert.ok(watermark >= 3, `clearChat 前水位应 ≥3，实际 ${watermark}`);
  const removed = st.clearChat(K);
  assert.equal(removed, 2);
  // clearChat 必须把水位落进 _meta.json —— 否则重启就回落到 maxId+1=1
  assert.equal(Number(readMetaFile(K).nextLocalId), watermark,
    `clearChat 必须把水位 ${watermark} 写进 _meta.json`);

  // ★ 关键：新实例（模拟重启）。同进程内测不出这个 bug。
  const boot = restart();
  assert.equal(boot.getChatMeta(K).total, 0, '重启后该群应为 0 条');
  const fresh = boot.appendIncoming(K, { mid: 'c3', ts: Date.now(), senderId: 'u', senderName: 'A', text: 'z' });
  assert.ok(fresh.id >= watermark,
    `★ clearChat 后重启，新 id 必须接着旧水位（水位 ${watermark}，实际 ${fresh.id}）—— `
    + '否则 id 从 1 重来 → uid 撞车 → 记忆门牌指向别的消息');
  ok(`★ clearChat 后【重启】再写：新 id=${fresh.id} 接着水位 ${watermark}（未回落到 1）`);
}

// ── 7. ★ 删掉最大 id 后重启，新消息 id 不复用（专杀 max+1 方案）──
{
  const K = 'group:700000007';
  const st = new ChatStore(0);
  for (let i = 0; i < 3; i += 1) {
    st.appendIncoming(K, { mid: `m${i}`, ts: Date.now() + i, senderId: 'u', senderName: 'A', text: `t${i}` });
  }
  const all = readShards(K);
  const maxId = Math.max(...all.map((m) => m.id));
  assert.equal(st.removeByLocalIds(K, [maxId]), 1, '删掉当前最大 id 那条');

  const boot = restart();
  const fresh = boot.appendIncoming(K, { mid: 'after', ts: Date.now() + 100, senderId: 'u', senderName: 'A', text: 'after' });
  assert.ok(fresh.id > maxId,
    `★ 删掉最大 id=${maxId} 后重启，新消息不能复用该 id（实际拿到 ${fresh.id}）。`
    + ' 这条专杀「nextLocalId = max(id)+1」方案：它会把刚删掉的 id 再发一次 → uid 撞车');
  ok(`★ 删掉最大 id=${maxId} 后重启，新 id=${fresh.id} 不复用`);
}

// ── 8. pruneBefore 删老消息后，剩余 uid 不变 ──
{
  const K = 'group:700000008';
  const st = new ChatStore(0);
  const now = Date.now();
  st.appendIncoming(K, { mid: 'p1', ts: now - 300 * DAY, senderId: 'u', senderName: 'A', text: 'old' });
  const keep = st.appendIncoming(K, { mid: 'p2', ts: now, senderId: 'u', senderName: 'A', text: 'new' });
  const beforeUid = uidOf(K, keep.id);
  const n = st.pruneBefore(now - 100 * DAY);
  assert.equal(n, 1, '应删掉 200 天前那条');
  const boot = restart();
  const left = boot.findByLocalId(K, keep.id);
  assert.ok(left, '新消息必须留下');
  assert.equal(uidOf(K, left.id), beforeUid, 'prune 之后剩余条目的 uid 不能变');
  ok('pruneBefore 删老消息后，剩余消息的 uid 不变');
}

// ── 9. ★ _meta.json 被手工删掉后重启：回落到 max+1，不崩不撞 ──
{
  const K = 'group:700000009';
  const st = new ChatStore(0);
  const a1 = st.appendIncoming(K, { mid: 'x1', ts: Date.now(), senderId: 'u', senderName: 'A', text: 'a' });
  st.appendIncoming(K, { mid: 'x2', ts: Date.now(), senderId: 'u', senderName: 'A', text: 'b' });
  // 纯 append 不写 _meta.json，先制造一次 rewrite 让它真的存在
  st.markEntryRead(K, a1.id);
  const before = readShards(K);
  const maxId = Math.max(...before.map((m) => m.id));

  const metaPath = path.join(chatDir(K), '_meta.json');
  assert.ok(fs.existsSync(metaPath), '_meta.json 应已生成（触发过 rewrite）');
  fs.rmSync(metaPath, { force: true });

  const boot = restart();
  const fresh = boot.appendIncoming(K, { mid: 'x3', ts: Date.now(), senderId: 'u', senderName: 'A', text: 'c' });
  assert.ok(fresh.id > maxId,
    `_meta.json 丢了也必须回落到 max+1（maxId=${maxId}，实际 ${fresh.id}），不能撞已有 id`);
  assert.equal(boot.getChatMeta(K).total, 3, '原有 2 条 + 新 1 条');
  ok(`★ _meta.json 被删后重启：nextLocalId 回落到 max+1（新 id=${fresh.id}），不崩不撞`);
}

// ── 10. ★ 源码断言：两个常量必须叫这个 ──
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'store.js'), 'utf8');
  assert.ok(/const UID_SEP = '#';/.test(src), "store.js 里必须有 `const UID_SEP = '#';`");
  assert.ok(/const META_FILE = '_meta\.json';/.test(src), "store.js 里必须有 `const META_FILE = '_meta.json';`");
  ok("★ 源码断言：UID_SEP === '#'、META_FILE === '_meta.json'");
}

// ── 11. L1 收敛 §6.4：atIds 落盘（过滤 all/空值、上限 20）+ reply.mid 重载仍在 ──
{
  const K = 'group:700000011';
  const st = new ChatStore(0);
  const ids = Array.from({ length: 25 }, (_, i) => String(1000 + i));
  const e1 = st.appendIncoming(K, {
    mid: 'a1', ts: Date.now(), senderId: 'u', senderName: 'A', text: '@了一堆人',
    atIds: [...ids, 'all', '', null],
    reply: { mid: 'r-9', senderId: '888' },
    atNames: ['@甲', '@乙']
  });
  assert.deepEqual(e1.atIds, ids.slice(0, 20), '★ atIds 只留数字 QQ、排除 all/空值、上限 20');
  assert.deepEqual(e1.reply, { mid: 'r-9', senderId: '888' }, 'reply 原样落盘（mid + senderId）');

  const boot = restart();
  const back = boot.findByLocalId(K, e1.id);
  assert.deepEqual(back.atIds, ids.slice(0, 20), '★ 重启后 atIds 还在');
  assert.deepEqual(back.reply, { mid: 'r-9', senderId: '888' }, '★ 重启后 reply.mid 还在（老消息按 mid 找发送者）');

  // 老消息完全没有这两个字段 → 读侧拿到 [] / null，不抛
  const e2 = st.appendIncoming(K, { mid: 'a2', ts: Date.now(), senderId: 'u', senderName: 'A', text: '老格式' });
  assert.deepEqual(e2.atIds, [], '缺省 atIds = []');
  assert.equal(e2.reply, null, '缺省 reply = null');
  ok('§6.4 atIds/reply：过滤 all/空值、上限 20、重启仍在，老消息缺省不抛');
}

// 清理
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── store-uid：${passed} 项通过`);
