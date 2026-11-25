// 月级读取 loadChatRange（P1-02，对应施工单 §9.4）。
//
// 核心要防的两件事：
//   ① 为了取一个窗口把该 chat 的所有月份都读进内存（等于没优化）；
//   ② 分片目录存在时又去读 legacy 扁平 .json，把已迁移数据重复计入。
//
// “读了哪些月份”用行为断言：把 ts 落在窗口内、但写进「窗口 ±1 月文件」与
// 「更远月份文件」的消息各放一条 —— 前者必须出现（证明 ±1 月被读），
// 后者必须不出现（证明没有全量读）。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-chatrange-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const { ChatStore } = await import(pathToFileURL(path.join(ROOT, 'src', 'store.js')).href);

const MSG = path.join(DATA, 'messages');
const safeKey = (k) => String(k).replace(/[^a-z0-9_]/gi, '_');
const dirOf = (k) => path.join(MSG, safeKey(k));
const legacyOf = (k) => path.join(MSG, `${safeKey(k)}.json`);

const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h, 0, 0, 0).getTime();
const ym = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

let nextId = 1;
function msg(ts, text, extra = {}) {
  nextId += 1;
  return JSON.stringify({ id: nextId, mid: `m${nextId}`, ts, senderId: 'u1', senderName: '甲', text, self: false, read: true, ...extra });
}
function writeShard(chatKey, ymStr, lines) {
  fs.mkdirSync(dirOf(chatKey), { recursive: true });
  fs.writeFileSync(path.join(dirOf(chatKey), `${ymStr}.jsonl`), lines.map((l) => `${l}\n`).join(''), 'utf8');
}
const snap = (chatKey) => {
  const dir = dirOf(chatKey);
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    const st = fs.statSync(path.join(dir, f));
    out[f] = `${st.size}:${Math.floor(st.mtimeMs)}`;
  }
  return out;
};

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const store = new ChatStore(0);

try {
  // ══ 1. 窗口 ±1 月：读相邻月、不读更远月 ══
  // 布局：2024-11 / 2024-12 / 2025-01 / 2025-02 / 2025-03
  // 窗口：2025-01-01 ~ 2025-01-31 → 月份集合应 = {2024-12, 2025-01, 2025-02}
  const K = 'group:7001';
  const inWin = at(2025, 1, 15);           // 窗口内
  writeShard(K, '2024-11', [msg(at(2024, 11, 10), '11月')]);
  // ★ 边界补录：ts 在窗口内，但写在 12 月文件里（±1 月必须被读到）
  writeShard(K, '2024-12', [msg(inWin, '12月文件里的窗口内消息'), msg(at(2024, 12, 20), '12月正常')]);
  writeShard(K, '2025-01', [msg(inWin + 1000, '1月'), msg(at(2025, 1, 20), '1月中')]);
  writeShard(K, '2025-02', [msg(at(2025, 2, 5), '2月窗口外')]);
  // ★ 更远月份里也放一条“窗口内 ts”：若被读到说明月份集合算错了
  writeShard(K, '2025-03', [msg(inWin + 2000, '3月文件里的窗口内消息')]);

  await check('1. 窗口 ±1 月：读相邻月、不读更远月', () => {
    const got = store.loadChatRange(K, { fromTs: at(2025, 1, 1, 0), toTs: at(2025, 1, 31, 23) });
    const texts = got.map((m) => m.text);
    assert.ok(texts.includes('1月'), '覆盖月必须读到');
    assert.ok(texts.includes('1月中'), '覆盖月必须读到');
    assert.ok(texts.includes('12月文件里的窗口内消息'), '前 1 月必须被读到（时区/补录边界）');
    assert.equal(texts.includes('3月文件里的窗口内消息'), false, '后 2 月的文件不得被读');
    assert.equal(texts.includes('11月'), false, '窗口外消息必须被过滤');
    assert.equal(texts.includes('2月窗口外'), false, '窗口外消息必须被过滤');
    // 顺序按 ts,id 升序
    const ts = got.map((m) => Number(m.ts));
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b), '结果必须按 ts 升序');
  });

  // ══ 2. 仅一个月 / 无数据 ══
  await check('2. 仅一个月的窗口正常；不存在的 chat 返回空数组', () => {
    const got = store.loadChatRange(K, { fromTs: at(2025, 2, 1, 0), toTs: at(2025, 2, 28, 23) });
    assert.equal(got.length, 1);
    assert.equal(got[0].text, '2月窗口外');
    assert.deepEqual(store.loadChatRange('group:7999', { fromTs: at(2025, 1, 1), toTs: at(2025, 1, 2) }), []);
  });

  // ══ 3. 坏行跳过、好行保留 ══
  await check('3. 坏 JSON 行跳过，好行仍能读到', () => {
    const k = 'group:7003';
    const good = msg(at(2025, 5, 10), '好行');
    fs.mkdirSync(dirOf(k), { recursive: true });
    fs.writeFileSync(path.join(dirOf(k), '2025-05.jsonl'), `{ 坏行\n${good}\n{"noId":true}\n`, 'utf8');
    const got = store.loadChatRange(k, { fromTs: at(2025, 5, 1, 0), toTs: at(2025, 5, 31, 23) });
    assert.equal(got.length, 1);
    assert.equal(got[0].text, '好行');
  });

  // ══ 4. legacy 回退只在分片目录不存在时 ══
  await check('4. legacy 回退：目录不存在才读；目录存在时不混读、不重复计入', () => {
    // 4a 只有扁平 .json
    const kLegacy = 'group:7004';
    fs.mkdirSync(MSG, { recursive: true });
    fs.writeFileSync(legacyOf(kLegacy), JSON.stringify({
      nextLocalId: 10,
      messages: [
        { id: 1, ts: at(2025, 6, 10), senderId: 'u1', senderName: '甲', text: '旧1', self: false, read: true },
        { id: 2, ts: at(2025, 6, 11), senderId: 'u1', senderName: '甲', text: '旧2', self: false, read: true }
      ]
    }), 'utf8');
    const a = store.loadChatRange(kLegacy, { fromTs: at(2025, 6, 1, 0), toTs: at(2025, 6, 30, 23) });
    assert.equal(a.length, 2, '目录不存在时必须回退读扁平 .json');
    assert.equal(a[0].text, '旧1');

    // 4b 目录存在 + legacy 也在：只读分片，不混读
    const kBoth = 'group:7005';
    writeShard(kBoth, '2025-06', [msg(at(2025, 6, 12), '分片里的')]);
    fs.writeFileSync(legacyOf(kBoth), JSON.stringify({
      nextLocalId: 10,
      messages: [
        { id: 1, ts: at(2025, 6, 10), senderId: 'u1', senderName: '甲', text: '旧1', self: false, read: true },
        { id: 2, ts: at(2025, 6, 11), senderId: 'u1', senderName: '甲', text: '旧2', self: false, read: true }
      ]
    }), 'utf8');
    const b = store.loadChatRange(kBoth, { fromTs: at(2025, 6, 1, 0), toTs: at(2025, 6, 30, 23) });
    assert.equal(b.length, 1, '分片目录存在时不得混读 legacy（否则重复计入）');
    assert.equal(b[0].text, '分片里的');
  });

  // ══ 5. fromTs=0 不回 1970 ══
  await check('5. fromTs=0 时按 toTs-30min 兜底，不从 1970 扫全部月份', () => {
    const k = 'group:7006';
    const now = Date.now();
    writeShard(k, ym(now), [
      msg(now - 2 * 60 * 60 * 1000, '两小时前'),
      msg(now - 5 * 60 * 1000, '五分钟前')
    ]);
    writeShard(k, '2020-01', [msg(at(2020, 1, 5), '2020年的')]);
    const got = store.loadChatRange(k, { fromTs: 0, toTs: now });
    const texts = got.map((m) => m.text);
    assert.ok(texts.includes('五分钟前'), '30 分钟内的必须读到');
    assert.equal(texts.includes('两小时前'), false, '超出兜底窗口的必须被过滤');
    assert.equal(texts.includes('2020年的'), false, '绝不能从 1970 读全部月份');
  });

  // ══ 6. 跨年窗口 ══
  await check('6. 跨年窗口（12 月 → 1 月）月份集合正确', () => {
    const k = 'group:7007';
    writeShard(k, '2024-11', [msg(at(2024, 11, 5), '11月')]);
    writeShard(k, '2024-12', [msg(at(2024, 12, 20), '12月')]);
    writeShard(k, '2025-01', [msg(at(2025, 1, 10), '1月')]);
    writeShard(k, '2025-02', [msg(at(2025, 2, 20), '2月')]);
    const got = store.loadChatRange(k, { fromTs: at(2024, 12, 20, 0), toTs: at(2025, 1, 10, 23) });
    assert.deepEqual(got.map((m) => m.text), ['12月', '1月'], '跨年窗口两端都应读到');
  });

  // ══ 7. 与全量 rangeByTs 结果一致 ══
  await check('7. 与全量 rangeByTs 的 id/ts/顺序完全一致', () => {
    const from = at(2024, 12, 1, 0);
    const to = at(2025, 2, 28, 23);
    const ranged = store.loadChatRange(K, { fromTs: from, toTs: to, includeSelf: true, visibleOnly: true });
    const full = store.rangeByTs(K, { fromTs: from, toTs: to, includeSelf: true, visibleOnly: true });
    assert.deepEqual(
      ranged.map((m) => `${m.id}:${m.ts}`),
      full.map((m) => `${m.id}:${m.ts}`),
      '月级读取必须与全量读取同口径（id/ts/顺序）'
    );
  });

  // ══ 8. 过滤口径：includeSelf / visibleOnly ══
  await check('8. includeSelf/visibleOnly 过滤与 rangeByTs 一致', () => {
    const k = 'group:7008';
    const t = at(2025, 3, 10);
    writeShard(k, '2025-03', [
      msg(t, '他人可见'),
      msg(t + 1000, '我的发言', { self: true, read: true }),
      msg(t + 2000, '撤回的', { recalled: true }),
      msg(t + 3000, '拍一拍', { isPoke: true })
    ]);
    const all = store.loadChatRange(k, { fromTs: at(2025, 3, 1, 0), toTs: at(2025, 3, 31, 23), includeSelf: true, visibleOnly: true });
    assert.deepEqual(all.map((m) => m.text), ['他人可见', '我的发言'], 'self 保留、撤回/拍一拍排除');
    const noSelf = store.loadChatRange(k, { fromTs: at(2025, 3, 1, 0), toTs: at(2025, 3, 31, 23), includeSelf: false, visibleOnly: true });
    assert.deepEqual(noSelf.map((m) => m.text), ['他人可见']);
    const raw = store.loadChatRange(k, { fromTs: at(2025, 3, 1, 0), toTs: at(2025, 3, 31, 23), includeSelf: true, visibleOnly: false });
    assert.equal(raw.length, 4, 'visibleOnly:false 时不做可见性过滤');
    // 与 rangeByTs 比对
    const full = store.rangeByTs(k, { fromTs: at(2025, 3, 1, 0), toTs: at(2025, 3, 31, 23), includeSelf: true, visibleOnly: true });
    assert.deepEqual(all.map((m) => m.id), full.map((m) => m.id));
  });

  // ══ 9. 不写盘、不进 chats ══
  await check('9. loadChatRange 不写盘、不把 chat 塞进内存', () => {
    const k = 'group:7009';
    const t = at(2025, 4, 10);
    writeShard(k, '2025-04', [msg(t, '只读')]);
    const before = snap(k);
    const store2 = new ChatStore(0);
    store2.loadChatRange(k, { fromTs: at(2025, 4, 1, 0), toTs: at(2025, 4, 30, 23) });
    const after = snap(k);
    assert.deepEqual(after, before, '文件内容/大小/mtime 都不得变化');
    assert.equal(store2.chats.size, 0, '不得为该 chat 建立内存 state');
  });

  // ══ 10. 月份集合 >6 时打 months=N 日志 ══
  await check('10. 窗口跨 8 个月时打印 months=N 日志', () => {
    const k = 'group:7010';
    for (let i = 1; i <= 8; i += 1) writeShard(k, `2023-${String(i).padStart(2, '0')}`, [msg(at(2023, i, 10), `${i}月`)]);
    const logs = [];
    const orig = console.warn;
    console.warn = (...args) => { logs.push(args.join(' ')); };
    let got;
    try {
      got = store.loadChatRange(k, { fromTs: at(2023, 1, 1, 0), toTs: at(2023, 8, 31, 23) });
    } finally { console.warn = orig; }
    assert.equal(got.length, 8, '不得静默截断：8 个月的数据都要返回');
    assert.ok(logs.some((l) => /months=\d+/.test(l)), `应打印 months=N 日志（实际 ${JSON.stringify(logs)}）`);
  });
  // ══ 11. L4 接线：listChatKeys + loadChatRange，且不再全量 listChats ══
  await check('11. mem2 的 L4 tick 已改用 listChatKeys/loadChatRange', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mem2', 'index.js'), 'utf8');
    assert.ok(/store\.listChatKeys\(\)/.test(src), 'L4 应用 listChatKeys 枚举 chat');
    assert.ok(/store\.loadChatRange/.test(src), 'L4 应用 loadChatRange 读窗口');
    // 只允许 typeof 兜底判断；不得再有直接调用的全量读取
    const calls = src.match(/store\.rangeByTs\(/g) || [];
    assert.deepEqual(calls, [], `不得再直接调用 rangeByTs 全量读取（实际 ${JSON.stringify(calls)}）`);
    assert.equal(src.match(/store\.listChats\(/g)?.length ?? 0, 1, 'listChats 只允许保留在 typeof 兜底分支里');
    // l1.js 明确不改
    const l1 = fs.readFileSync(path.join(ROOT, 'src', 'mem2', 'l1.js'), 'utf8');
    assert.ok(/rangeByTs\??\.?\(/.test(l1), 'L1 的 rangeByTs 不在本单改动范围，应保留原样');
  });
} finally {
  /* 临时目录留给 OS 清理 */
}

console.log(`\n月级读取（P1-02）：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
