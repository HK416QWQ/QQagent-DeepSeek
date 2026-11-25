#!/usr/bin/env node
// 消息存档迁移：data/messages/<safe>.json  →  data/messages/<safe>/<YYYY-MM>.jsonl
//
// ── 必须在应用停止时运行 ──
// 应用还在跑的话：迁移期间新消息会写进旧文件 → 迁移完这些消息就丢了；
// 而且条数守恒校验会失败。脚本开头会检查旧文件的 mtime，60 秒内被改过就拒绝。
//
// ── 用法 ──
//   node scripts/migrate-messages-shard.mjs --dry-run          只统计，不写任何东西
//   node scripts/migrate-messages-shard.mjs --dry-run --snapshot   额外存 recent(80) 快照
//   node scripts/migrate-messages-shard.mjs                    正式迁移
//   node scripts/migrate-messages-shard.mjs --force            忽略 mtime 检查
//   node scripts/migrate-messages-shard.mjs --verify baseline.json   与 baseline 逐项比对
//
// ── 迁移后能回退 ──
// 原文件一律 rename 到 data/messages/_legacy/，不删除。回退 = 把 _legacy 里的
// 文件搬回来 + 删掉分片目录（见施工单 §5）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(process.cwd(), 'data');
const MSG_DIR = path.join(DATA_DIR, 'messages');
const LEGACY_DIR = path.join(MSG_DIR, '_legacy');
// baseline 不放在 data/messages/ 里。
//
// 为什么不放那儿：messages/ 的语义是「一个会话 = 一个子目录或一个 legacy 文件」，
// 塞一个非会话文件进去会破坏这个约定。现在各处的正则（store.js 的 listChats、
// 本脚本的 LEGACY_RE）都碰不到它，所以**当下不会出错**；但只要以后有人写
// 「遍历 messages/ 下所有文件」的功能（备份、统计、UI 文件浏览），它就会
// 被当成一个叫 baseline 的会话。
//
// 放 data/migration/ 下：同属 data（会被 .gitignore 一起忽略），但不在
// messages/ 里，两套扫描永远不交叉。
const MIGRATION_DIR = path.join(DATA_DIR, 'migration');
const BASELINE_DEFAULT = path.join(MIGRATION_DIR, 'baseline.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : '';
};

const DRY = has('--dry-run');
const FORCE = has('--force');
const SNAPSHOT = has('--snapshot');
const VERIFY = has('--verify');

const META_FILE = '_meta.json';
const SHARD_RE = /^\d{4}-\d{2}\.jsonl$/;
const LEGACY_RE = /^((?:group|private)_\d+)\.json$/;

/**
 * 条目所属月份（本地时区）。
 * ⚠️ 必须与 src/store.js 的 ymOf 完全一致 —— 不一致的话「ts 落月 === 文件名月」
 *    这条校验会立刻失败（不会静默），但仍要保持同源。
 *    ts 非法 → '0000-00'，不丢弃。
 */
function ymOf(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '0000-00';
  const d = new Date(n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const uidOf = (chatKey, id) => `${chatKey}#${id}`;
const safeKey = (k) => String(k).replace(/[^a-z0-9_]/gi, '_');
const chatKeyOf = (safe) => {
  const i = safe.indexOf('_');
  return `${safe.slice(0, i)}:${safe.slice(i + 1)}`;
};

function listLegacy() {
  try {
    return fs.readdirSync(MSG_DIR).filter((f) => LEGACY_RE.test(f)).sort();
  } catch { return []; }
}

/** 读一个旧格式文件；解析失败返回 null（调用方跳过并报错） */
function readLegacy(file) {
  const p = path.join(MSG_DIR, file);
  let text = fs.readFileSync(p, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.messages)) return null;
  return { parsed, bytes: fs.statSync(p).size, mtimeMs: fs.statSync(p).mtimeMs };
}

/** 读分片目录里所有 .jsonl 的条目（合并） */
function readShards(safe) {
  const dir = path.join(MSG_DIR, safe);
  if (!fs.existsSync(dir)) return null;
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => SHARD_RE.test(x)).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      out.push(JSON.parse(line));      // 校验场景：解析失败就该炸，不要静默跳过
    }
  }
  return out;
}

function readMeta(safe) {
  try {
    return JSON.parse(fs.readFileSync(path.join(MSG_DIR, safe, META_FILE), 'utf8')) || {};
  } catch { return {}; }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 按 ts + id 排序后取最后 N 条的指纹（复刻 store.recent 的排序口径） */
function recentFingerprint(entries, n = 80) {
  const sorted = [...entries].sort(
    (a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0) || Number(a.id) - Number(b.id)
  );
  const tail = sorted.slice(-n);
  return tail.map((m) => `${m.id}|${Number(m.ts) || 0}|${String(m.text ?? '')}`);
}

// ── 采集 baseline ────────────────────────────────────────────────────────
function collectBaseline() {
  const groups = [];
  let total = 0;
  const months = {};
  const uids = [];

  for (const file of listLegacy()) {
    const safe = file.replace(/\.json$/, '');
    const chatKey = chatKeyOf(safe);
    const r = readLegacy(file);
    if (!r) { groups.push({ file, safe, chatKey, error: '解析失败（JSON 坏了）' }); continue; }
    const msgs = r.parsed.messages;
    const maxId = msgs.reduce((a, m) => Math.max(a, Number(m?.id) || 0), 0);
    const nextLocalId = Math.max(Number(r.parsed.nextLocalId) || 0, maxId + 1, 1);
    for (const m of msgs) {
      total += 1;
      const ym = ymOf(m.ts);
      months[ym] = (months[ym] || 0) + 1;
      uids.push(uidOf(chatKey, m.id));
    }
    groups.push({
      file, safe, chatKey,
      count: msgs.length,
      bytes: r.bytes,
      mtimeMs: r.mtimeMs,
      maxId,
      nextLocalId: Number(r.parsed.nextLocalId) || 0,   // 原始值，迁移要原样搬
      snapshot: SNAPSHOT ? recentFingerprint(msgs) : undefined,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    dataDir: DATA_DIR,
    total,
    groupCount: groups.length,
    months,
    uidCount: uids.length,
    uidUnique: new Set(uids).size,
    uidHash: sha(uids.slice().sort().join('\n')),
    groups,
  };
}

function printBaseline(b) {
  console.log(`数据目录：${b.dataDir}`);
  console.log(`总条数：${b.total}    群数：${b.groupCount}    uid 唯一：${b.uidUnique}/${b.uidCount}`);
  console.log(`uid 全集 sha256：${b.uidHash}`);
  console.log(`月度分布：${JSON.stringify(b.months)}`);
  console.log('');
  console.log('每群：');
  for (const g of b.groups) {
    if (g.error) { console.log(`  ${g.file.padEnd(26)} ✗ ${g.error}`); continue; }
    // ⚠️ 原文件的 nextLocalId 正常应 = maxId+1。小于等于 maxId 说明那份存档
    //    本身水位就落后（存在 id 撞车风险）。仍然照原值搬（无损），但要说出来。
    const lag = Number(g.nextLocalId) <= Number(g.maxId) ? '  ⚠️ 水位落后于 maxId' : '';
    console.log(`  ${g.file.padEnd(26)} 条=${String(g.count).padStart(6)}`
      + `  maxId=${String(g.maxId).padStart(6)}`
      + `  nextLocalId=${String(g.nextLocalId).padStart(6)}`
      + `  ${(g.bytes / 1048576).toFixed(2)}MB${lag}`);
  }
}

// ── 迁移一群 ─────────────────────────────────────────────────────────────
function migrateOne(g) {
  const r = readLegacy(g.file);
  if (!r) throw new Error('解析失败');
  const msgs = r.parsed.messages;
  const dir = path.join(MSG_DIR, g.safe);

  // 幂等：目录已存在且非空 → 拒绝（除非 --force，会先挪走）
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    if (!FORCE) throw new Error(`目标目录已存在且非空：${dir}（要覆盖请加 --force）`);
    const aside = `${dir}.bak-${Date.now().toString(36)}`;
    fs.renameSync(dir, aside);
    console.log(`    现有目录已挪到 ${path.basename(aside)}`);
  }
  fs.mkdirSync(dir, { recursive: true });

  // 按本地月分组（ts 非法归 0000-00）
  const byMonth = new Map();
  for (const m of msgs) {
    const ym = ymOf(m.ts);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(m);
  }
  for (const [ym, arr] of byMonth) {
    fs.writeFileSync(
      path.join(dir, `${ym}.jsonl`),
      arr.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8'
    );
  }
  // ★ 必须搬原文件的 nextLocalId，不能从 max(id)+1 推：
  //   删过最大 id 时 max+1 会把那个 id 再发一次 → uid 撞车。
  fs.writeFileSync(
    path.join(dir, META_FILE),
    JSON.stringify({
      schema: 1,
      nextLocalId: Math.max(Number(r.parsed.nextLocalId) || 0, 1),
      badRows: 0,
      updatedAt: Date.now(),
    }),
    'utf8'
  );

  // ── 四条守恒校验（不通过就整群回滚，不删原文件）──
  const back = readShards(g.safe) || [];
  if (back.length !== msgs.length) {
    throw new Error(`条数不守恒：原 ${msgs.length} → 新 ${back.length}`);
  }
  const uids = back.map((m) => uidOf(g.chatKey, m.id));
  if (new Set(uids).size !== uids.length) {
    throw new Error(`uid 有重复：${uids.length} 条里只有 ${new Set(uids).size} 个唯一`);
  }
  // 逐条校验 ts 落月 === 文件名月（读文件时按文件名分组，这里反查）
  for (const f of fs.readdirSync(dir).filter((x) => SHARD_RE.test(x))) {
    const ym = f.slice(0, 7);
    if (ym === '0000-00') continue;
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const m = JSON.parse(line);
      if (ymOf(m.ts) !== ym) {
        throw new Error(`月份错位：${f} 里有条目的 ts 属于 ${ymOf(m.ts)}`);
      }
    }
  }
  const meta = readMeta(g.safe);
  if (Number(meta.nextLocalId) !== Number(g.nextLocalId)) {
    throw new Error(`nextLocalId 没搬对：原 ${g.nextLocalId} → 新 ${meta.nextLocalId}`);
  }

  return { months: [...byMonth.keys()].sort(), count: back.length };
}

function rollbackDir(safe) {
  const dir = path.join(MSG_DIR, safe);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── main ─────────────────────────────────────────────────────────────────
function main() {
  fs.mkdirSync(MSG_DIR, { recursive: true });

  // --verify：与 baseline 比对
  if (VERIFY) {
    const file = valOf('--verify') || BASELINE_DEFAULT;
    if (!fs.existsSync(file)) { console.error(`找不到 baseline：${file}`); process.exit(1); }
    const base = JSON.parse(fs.readFileSync(file, 'utf8'));

    let total = 0;
    const months = {};
    const uids = [];
    const problems = [];
    for (const g of base.groups) {
      if (g.error) continue;
      const shards = readShards(g.safe);
      if (!shards) { problems.push(`${g.safe}: 分片目录不存在`); continue; }
      if (shards.length !== g.count) problems.push(`${g.safe}: 条数 ${shards.length} ≠ baseline ${g.count}`);
      for (const m of shards) {
        total += 1;
        const ym = ymOf(m.ts);
        months[ym] = (months[ym] || 0) + 1;
        uids.push(uidOf(g.chatKey, m.id));
      }
      const meta = readMeta(g.safe);
      if (Number(meta.nextLocalId) !== Number(g.nextLocalId)) {
        problems.push(`${g.safe}: nextLocalId ${meta.nextLocalId} ≠ baseline ${g.nextLocalId}`);
      }
      if (g.snapshot) {
        const now = recentFingerprint(shards);
        const diff = now.filter((x, i) => x !== g.snapshot[i]).length
          + Math.abs(now.length - g.snapshot.length);
        if (diff > 0) problems.push(`${g.safe}: recent(80) 快照有 ${diff} 行差异`);
      }
    }

    console.log(`总数：新 ${total}  vs  baseline ${base.total}`);
    console.log(`uid 唯一：${new Set(uids).size}/${uids.length}（baseline ${base.uidUnique}/${base.uidCount}）`);
    console.log(`uid 全集 sha256：新 ${sha(uids.slice().sort().join('\n'))}`);
    console.log(`                baseline ${base.uidHash}`);
    console.log(`月度分布：新 ${JSON.stringify(months)}  baseline ${JSON.stringify(base.months)}`);

    const okAll = total === base.total
      && new Set(uids).size === uids.length
      && sha(uids.slice().sort().join('\n')) === base.uidHash
      && JSON.stringify(months) === JSON.stringify(base.months)
      && problems.length === 0;

    if (problems.length) { console.log('\n问题：'); for (const p of problems) console.log('  ✗ ' + p); }
    console.log(okAll ? '\n✅ 全部一致' : '\n❌ 有差异');
    process.exit(okAll ? 0 : 1);
  }

  const base = collectBaseline();
  printBaseline(base);

  if (DRY) {
    const out = BASELINE_DEFAULT;
    fs.mkdirSync(MIGRATION_DIR, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(base, null, 1), 'utf8');
    console.log(`\n[dry-run] 未写入任何分片。baseline 已存：${out}`);
    console.log('[dry-run] 迁移后用 --verify 与该文件逐项比对。');
    return;
  }

  // 应用是否还在跑：旧文件 60 秒内被改过就拒绝
  if (!FORCE) {
    const fresh = base.groups.filter((g) => !g.error && Date.now() - g.mtimeMs < 60_000);
    if (fresh.length) {
      console.error('\n❌ 以下存档在 60 秒内被修改过，应用很可能还在运行：');
      for (const g of fresh) console.error(`   ${g.file}（${Math.round((Date.now() - g.mtimeMs) / 1000)} 秒前）`);
      console.error('   请先完全退出 QQ Agent 再迁移。确认无风险可加 --force。');
      process.exit(2);
    }
  }

  if (!base.groups.length) { console.log('\n没有需要迁移的旧文件。'); return; }

  fs.mkdirSync(LEGACY_DIR, { recursive: true });
  const started = Date.now();
  const done = [];
  for (const g of base.groups) {
    if (g.error) { console.log(`  ✗ ${g.file}：${g.error}（跳过，原文件未动）`); continue; }
    process.stdout.write(`  迁移 ${g.file} … `);
    try {
      const res = migrateOne(g);
      // 校验通过才把原文件挪走（不删）
      fs.renameSync(path.join(MSG_DIR, g.file), path.join(LEGACY_DIR, g.file));
      console.log(`✓ ${res.count} 条 → ${res.months.join(' + ')}`);
      done.push({ ...g, months: res.months });
    } catch (e) {
      rollbackDir(g.safe);
      console.log(`✗ 失败：${e.message}（已回滚，原文件未动）`);
    }
  }

  console.log('');
  console.log(`完成 ${done.length}/${base.groups.length} 群，耗时 ${Date.now() - started}ms`);
  console.log(`原文件已挪到 ${LEGACY_DIR}（保留 7 天后再手动删）`);
  const totalDone = done.reduce((a, g) => a + g.count, 0);
  console.log(`迁移条数合计：${totalDone}（baseline ${base.total}）`);
  if (totalDone !== base.total) {
    console.log('⚠️ 与 baseline 不一致 —— 请用 --verify 逐项核对');
  }
  console.log('\n下一步：node scripts/migrate-messages-shard.mjs --verify');
}

main();
