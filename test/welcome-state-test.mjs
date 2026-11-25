// welcome-seen.json 读写单测（P0-04a，6 组）。
//
// 只在 mkdtempSync 临时目录里操作，绝不指向真实 data/welcome-seen.json。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';
import { WELCOME_SEEN_MAX, WELCOME_USER_TTL_MS, seenKey } from '../src/group-welcome.js';
import { WELCOME_SEEN_VERSION, loadWelcomeSeen, saveWelcomeSeen } from '../src/welcome-state.js';

const checker = createChecker('welcome-seen 文件');
const NOW = 1_700_000_000_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-state-'));
let seq = 0;
const tmpFile = () => path.join(dir, `case-${seq += 1}.json`);

try {
  // ── 1. 文件不存在 ───────────────────────────────────────────────────────
  await checker.check('1 文件不存在：返回空 Map，不抛错', async () => {
    const file = path.join(dir, 'not-there.json');
    const map = loadWelcomeSeen(file, { now: NOW });
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
    assert.ok(!fs.existsSync(file), '加载不应创建文件');
  });

  // ── 2. 保存/加载往返 ────────────────────────────────────────────────────
  await checker.check('2 往返：Map 一致、文件只有哈希键、不修改调用方 Map', async () => {
    const file = tmpFile();
    const newer = seenKey('456', '123');
    const older = seenKey('456', '124');
    const map = new Map([[older, NOW - 2000], [newer, NOW - 1000]]);
    const before = [...map.entries()];

    saveWelcomeSeen(file, map, { now: NOW });
    assert.deepEqual([...map.entries()], before, '保存不得修改调用方 Map（条目和顺序都要保持）');

    const loaded = loadWelcomeSeen(file, { now: NOW });
    assert.equal(loaded.size, 2);
    assert.equal(loaded.get(newer), NOW - 1000);
    assert.equal(loaded.get(older), NOW - 2000);

    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('"version":1'), '文件必须带 version:1');
    assert.ok(!text.includes('456:123'), '文件不得出现明文 群:QQ');
    assert.ok(!text.includes('"456"'), '文件不得出现群号');
    const parsed = JSON.parse(text);
    assert.equal(parsed.version, WELCOME_SEEN_VERSION);
    assert.equal(parsed.updatedAt, NOW);
    assert.equal(parsed.entries.length, 2);
    for (const [key] of parsed.entries) assert.match(key, /^[0-9a-f]{32}$/);
    // 按 ts 升序写
    assert.ok(parsed.entries[0][1] <= parsed.entries[1][1], 'entries 必须按时间升序');
  });

  // ── 3. 过期清理 ─────────────────────────────────────────────────────────
  await checker.check('3 过期清理：加载时丢掉 ttl 之前的记录', async () => {
    const file = tmpFile();
    const expired = seenKey('456', '201');
    const alive = seenKey('456', '202');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      updatedAt: NOW,
      entries: [
        [expired, NOW - WELCOME_USER_TTL_MS - 1],
        [alive, NOW - 1000]
      ]
    }), 'utf8');
    const loaded = loadWelcomeSeen(file, { now: NOW });
    assert.equal(loaded.size, 1);
    assert.ok(!loaded.has(expired));
    assert.ok(loaded.has(alive));
  });

  // ── 4. 2000 硬上限 ──────────────────────────────────────────────────────
  await checker.check('4 硬上限：2001 条保存后只剩 2000，淘汰最旧、保留最新', async () => {
    const file = tmpFile();
    const map = new Map();
    const keys = [];
    for (let i = 0; i < WELCOME_SEEN_MAX + 1; i += 1) {
      const key = seenKey('456', String(10000 + i));
      keys.push(key);
      // 全部未过期，时间递增（越大越新）
      map.set(key, NOW - 100000 + i);
    }
    saveWelcomeSeen(file, map, { now: NOW });
    const loaded = loadWelcomeSeen(file, { now: NOW });
    assert.equal(loaded.size, WELCOME_SEEN_MAX, '最终必须恰好 2000 条');
    assert.ok(!loaded.has(keys[0]), '最旧的一条应被淘汰');
    assert.ok(loaded.has(keys[keys.length - 1]), '最新的一条必须保留');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.entries.length, WELCOME_SEEN_MAX);
  });

  // ── 5. 非法条目过滤 ─────────────────────────────────────────────────────
  await checker.check('5 非法条目：短 key/非十六进制/坏 ts 丢弃，重复 key 保留较新', async () => {
    const file = tmpFile();
    const k1 = seenKey('456', '301');
    const k2 = seenKey('456', '302');
    const k3 = seenKey('456', '303');
    const k4 = seenKey('456', '304');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      updatedAt: NOW,
      entries: [
        ['abc', NOW - 1000],                              // 太短
        ['z'.repeat(32), NOW - 1000],                     // 非十六进制
        [k1, String(NOW)],                                // ts 是字符串
        [k2, 0],                                          // ts 必须 > 0
        [k3, -5],                                         // ts 负数
        [k4, NOW - 2000],                                 // 重复 key：旧
        [k4, NOW - 500],                                  // 重复 key：新
        ['only-one-item'],                                // 结构不对
        null                                              // 非数组
      ]
    }), 'utf8');
    const loaded = loadWelcomeSeen(file, { now: NOW });
    assert.equal(loaded.size, 1, '只应保留 k4');
    assert.equal(loaded.get(k4), NOW - 500, '重复 key 保留较大（较新）的 ts');
  });

  // ── 6. 损坏文件抛错 ─────────────────────────────────────────────────────
  await checker.check('6 坏文件必须抛错（不静默变空表），错误信息不含文件内容', async () => {
    const bad = [
      { name: '坏 JSON', text: '{"version":1,' },
      { name: 'version=2', text: JSON.stringify({ version: 2, entries: [] }) },
      { name: 'entries 是对象', text: JSON.stringify({ version: 1, entries: {} }) },
      { name: '顶层是数组', text: JSON.stringify([]) }
    ];
    for (const c of bad) {
      const file = tmpFile();
      fs.writeFileSync(file, c.text, 'utf8');
      let error = null;
      try { loadWelcomeSeen(file, { now: NOW }); } catch (e) { error = e; }
      assert.ok(error, `${c.name} 应抛错`);
      assert.match(String(error.message), /格式无效/, `${c.name} 的错误应说明格式无效`);
      assert.ok(!String(error.message).includes('456:123'), '错误信息不得泄露明文键');
      assert.ok(!String(error.message).includes('entries":'), '错误信息不得回显文件内容');
    }
  });
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  checker.finish();
}
