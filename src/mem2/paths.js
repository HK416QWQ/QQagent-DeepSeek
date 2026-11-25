// mem2 的路径与 schema.json 读写（第 1 期第 1 步）。
//
// 目录结构（施工单 §2.1）：
//   data/mem2/
//   ├── schema.json                # { schemaVersion, createdAt, lastScanTs: {chatKey: ts} }
//   ├── usage.jsonl                # 记忆任务独立记账 + 熔断留痕（append-only）
//   ├── quota.json                 # 当日配额计数（落盘，防重启绕过）
//   └── <chatKey>/
//       ├── coverage.jsonl
//       ├── candidates.jsonl               # 第 2 期：候选池（每群一份）
//       ├── l1/<userId>.jsonl              # 第 2 期：人物画像（每人一份，append-only）
//       └── l4/<YYYY-MM>.jsonl
//   跨群索引单独一份：mem2/cross_group_index.jsonl（供跨群检索/回填共用）
//
// 三条落地约定（都来自施工单，不是自选）：
//   1. **两个 store 不要混**：`src/store.js` 是消息存档（983 行，本期只加一个只读
//      方法）；本文件所在目录是**记忆产物**读写，别去碰前者。
//   2. **jsonl 只 append**：原地重写整月文件有损坏风险（分片施工单的硬红线）。
//      需要「改」状态时追加一行，读时取同主键的最后一行。
//   3. **schema.json 用 tmp + rename**：它是水位，写坏了等于丢进度；而这个文件
//      很小（每群一个数字），全量重写完全可接受。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

export const SCHEMA_VERSION = 1;

// 默认落在 data/mem2；`setMem2Root()` 只给测试注入临时目录用。
let mem2Root = path.join(DATA_DIR, 'mem2');

/** 仅供测试：把 mem2 根目录指到临时目录。生产代码不要调。 */
export function setMem2Root(dir) { mem2Root = String(dir); }
export function mem2Dir() { return mem2Root; }

const pad2 = (n) => String(n).padStart(2, '0');

/** 分片名用**本地时间**的 YYYY-MM —— 与 data/messages 的月度分片同口径。 */
export function ymOf(ts) {
  const d = new Date(Number(ts) || 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** chatKey → 目录名：group:123 → group_123（与 data/messages 的分片目录同规则）。 */
export function safeKey(chatKey) {
  return String(chatKey ?? '').replace(/[^a-z0-9_]/gi, '_');
}

/** 目录名 → chatKey：group_123 → group:123。只换第一个下划线，群号里的数字不受影响。 */
export function chatKeyFromDir(name) {
  const s = String(name ?? '');
  const i = s.indexOf('_');
  if (i <= 0) return '';
  return `${s.slice(0, i)}:${s.slice(i + 1)}`;
}

export function chatDir(chatKey) { return path.join(mem2Root, safeKey(chatKey)); }
export function coverageFile(chatKey) { return path.join(chatDir(chatKey), 'coverage.jsonl'); }
export function l4File(chatKey, ym) { return path.join(chatDir(chatKey), 'l4', `${ym}.jsonl`); }

// ── 第 2 期：L1 / 候选池 / 跨群索引 ────────────────────────────────────────
/** L1 目录（每人一份 jsonl）。 */
export function l1Dir(chatKey) { return path.join(chatDir(chatKey), 'l1'); }

/**
 * 某人的 L1 文件。
 * 文件名只留 [a-z0-9_]：QQ 号是纯数字，但测试/未来可能传 'u1'、'qq:123' 这类，
 * 冒号在 Windows 上是非法字符，必须过滤。
 */
/**
 * 某人的 L1 文件（**旧：按群存**）。
 * @deprecated 2026-11-15：L1 已改成按人存（`personFile`），一个人一份跨群画像。
 *   本函数保留**仅供迁移脚本读历史数据**，不要再用于写入 —— 写它就会造出第二个写入口。
 */
export function l1File(chatKey, userId) {
  const u = safeKey(userId) || 'unknown';
  return path.join(l1Dir(chatKey), `${u}.jsonl`);
}

/** 按人存的画像根目录（跨群合并后一人一份）。 */
export function peopleDir() { return path.join(mem2Root, 'people'); }

/**
 * 某人的画像文件。**不再带 chatKey** —— 一个 QQ 一份，跨群。
 * 落地路径：`mem2/people/<uid>.jsonl`。
 * 这样「在 A 群说的、在 B 群也成立」的稳定特质只需要提炼一次。
 */
export function personFile(userId) {
  const u = safeKey(userId) || 'unknown';
  return path.join(peopleDir(), `${u}.jsonl`);
}

/** 候选池：每群一份（`fromUserId`/`msgId` 都是群内的，跨群合并没有意义）。 */
export function candidatesFile(chatKey) { return path.join(chatDir(chatKey), 'candidates.jsonl'); }

/**
 * 跨群索引：全局一份，放 mem2 根下。
 * 只存 {qq, groups[], nicknames{}}，**不存关注点** —— 关注点现读各群 L1，
 * 存一份就成了第二份数据，违反「单层单写入口」。
 */
export function crossGroupIndexFile() { return path.join(mem2Root, 'cross_group_index.jsonl'); }

export function usageFile() { return path.join(mem2Root, 'usage.jsonl'); }
export function quotaFile() { return path.join(mem2Root, 'quota.json'); }
export function schemaFile() { return path.join(mem2Root, 'schema.json'); }

/**
 * 回填 run 状态文件（第 5 期）：`mem2/backfill/<runId>.json`。
 *
 * 一份 run 文件同时承担三件事，所以必须是同一个文件而不是三个：
 *   ① 断点续跑（已完成会话清单）② 每日/累计计数（道 4 的 500 次与 20 元）
 *   ③ 每会话尝试次数（最多 2 次，防失败自我放大）
 * 拆开就会出现「计数说跑了 200、断点清单说 120」这种对不上的状态。
 */
/**
 * 物理删除审计文件（5b ①）。append-only：任何一次「彻底删除」都先把被删的
 * 全部版本行原样记进来，再重写 people 文件。**删了也留痕**——append-only 原则，
 * 哪怕是对「删除」这个动作本身。
 */
export function deletionsFile() { return path.join(mem2Root, 'deletions.jsonl'); }

/**
 * L1 日扫锚点状态文件（六期 P1-2）。
 * 持久化 nextRegularAt / retries，让重启不丢调度进度。
 */
export function l1StateFile() { return path.join(mem2Root, 'l1-state.json'); }

/**
 * L1 收敛：派生画像视图（每人一份 JSON，原子写）。
 * 它只是视图：不改变任何 L1 条目的 status，不参与水位，不代表第二份真相。
 */
export function profileFile(userId) {
  const u = safeKey(userId) || 'unknown';
  return path.join(peopleDir(), `${u}.profile.json`);
}

/** L1 收敛：扫描游标（SKIP/空输出推进，全局一份）。 */
export function l1ScanFile() { return path.join(mem2Root, 'l1-scan.json'); }

/** L1 收敛：解析溢出审计（append-only，永不注入）。 */
export function l1OverflowFile() { return path.join(mem2Root, 'l1-overflow.jsonl'); }

export function backfillDir() { return path.join(mem2Root, 'backfill'); }
export function backfillFile(runId) {
  const id = String(runId || '').trim().replace(/[^a-z0-9_.-]/gi, '_');
  if (!id) throw new Error('backfillFile: runId 必填');
  return path.join(backfillDir(), `${id}.json`);
}
/** 跨 run 的累计计数（道 4 的余量按它算，不是按单个 run）。 */
export function totalsFile() { return path.join(backfillDir(), '_totals.json'); }

/** 建出某群的 l1/l4 目录（幂等）。coverage / 候选池与根目录由 append 自己建。 */
export function ensureChatDirs(chatKey) {
  const d = chatDir(chatKey);
  fs.mkdirSync(path.join(d, 'l4'), { recursive: true });
  fs.mkdirSync(path.join(d, 'l1'), { recursive: true });
  return d;
}

/** append 一行 jsonl（自动建目录）。返回值无意义 —— 失败会抛，调用方决定怎么处理。 */
export function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
}

/** 读整个 jsonl。坏行直接跳过（半行写入 / 手工编辑都会产生），不抛。 */
export function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 坏行跳过：一条坏行不该让整月读不出来 */ }
  }
  return out;
}

/** 原子写 JSON（tmp + rename）。 */
export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 读 schema.json；缺失/损坏都返回骨架（不抛 —— 首次运行就是"缺失"这一种）。
 *
 * ★ 必须**透传未知字段**（`switchTs` / `backfillRunId`，第 5 期）：
 *   本函数原来是白名单重建（只返回 schemaVersion / createdAt / lastScanTs），
 *   而 `setLastScanTs` 是「读 → 改 → 整体写回」——于是写进去的 `switchTs`
 *   在读的那一刻就没了，下一个 tick 落盘后文件里也没有。
 *   这些字段必须原样透传：backfill 展示与 UI 读取都依赖 `switchTs`。
 *   （与第 2 期 updateConfig 深合并抹键同族；实测见 5 期单 §2.6）
 */
export function readSchema() {
  try {
    const j = JSON.parse(fs.readFileSync(schemaFile(), 'utf8'));
    if (j && typeof j === 'object') {
      return {
        ...j,                                 // ★ 透传未知字段，别白名单重建
        schemaVersion: Number(j.schemaVersion) || SCHEMA_VERSION,
        createdAt: Number(j.createdAt) || 0,
        lastScanTs: (j.lastScanTs && typeof j.lastScanTs === 'object') ? { ...j.lastScanTs } : {}
      };
    }
  } catch { /* 缺失或坏 */ }
  return { schemaVersion: SCHEMA_VERSION, createdAt: 0, lastScanTs: {} };
}

/** 建出 schema.json（幂等）。已存在则原样返回，不覆盖 createdAt / 水位。 */
export function initSchema() {
  const cur = readSchema();
  if (cur.createdAt) return cur;
  const next = { schemaVersion: SCHEMA_VERSION, createdAt: Date.now(), lastScanTs: cur.lastScanTs };
  writeJsonAtomic(schemaFile(), next);
  return next;
}

/** 某群的扫描水位；没扫过返回 0（0 表示"还没有水位"，由 bootstrapFromTs 决定起点）。 */
export function getLastScanTs(chatKey) {
  return Number(readSchema().lastScanTs?.[chatKey]) || 0;
}

/** 推进水位。返回落盘后的值。 */
export function setLastScanTs(chatKey, ts) {
  const s = readSchema();
  if (!s.createdAt) s.createdAt = Date.now();
  const v = Math.round(Number(ts) || 0);
  s.lastScanTs = { ...s.lastScanTs, [chatKey]: v };
  writeJsonAtomic(schemaFile(), s);
  return v;
}

/** 列出 mem2 下所有群目录对应的 chatKey（跳过散文件）。 */
export function listChatKeys() {
  let ents = [];
  try { ents = fs.readdirSync(mem2Root, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((e) => e.isDirectory())
    .map((e) => chatKeyFromDir(e.name))
    .filter(Boolean);
}
