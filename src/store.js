// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"已读信息"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

// 机器人自身发出的"占位符"消息：它们只是发送记录，不是可检索内容。
// 实测 6 个群里 `[表情包…` 有 1,226 条 —— 搜"表情包"时大部分命中是自己的
// 发送记录。只对 m.self 生效（群友发的"[图片]"是真实内容，不能一起删）。
const SELF_PLACEHOLDER_RE = /^\[(表情包|图片|表情|语音|视频|文件|合并转发|转发消息|拍一拍)/;

/** 发送者匹配：QQ 号精确，昵称/备注名走 includes（模型常只记得半个名字）。 */
function matchSender(m, key, notes = {}) {
  const id = String(m.senderId ?? '');
  if (id && id === key) return true;
  const name = String(m.senderName ?? '');
  if (name && name.includes(key)) return true;
  const note = String(notes[id] ?? '');
  return !!note && note.includes(key);
}

/** 检索结果的上下文行（前后各一条），超长截断到 max 字。 */
function contextLine(m, max = 60) {
  if (!m) return undefined;
  const who = m.self ? '我' : String(m.senderName || m.senderId || '未知');
  const text = String(m.text ?? '').replace(/\s+/g, ' ').trim();
  const line = `${who}：${text}`;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 词出现次数（`includes` 口径，用于 tf；重叠出现按非重叠计数）。 */
function countOccurrences(text, word) {
  if (!text || !word) return 0;
  let n = 0;
  let i = text.indexOf(word);
  while (i !== -1) {
    n += 1;
    i = text.indexOf(word, i + word.length);
  }
  return n;
}

// ── 存档路径、稳定 id、写盘模型（2026-11-11 分片改造）────────────────────
//
// 分片前：每群一个 JSON 文件，**每来一条消息就同步全量重写**。最大群 14,918 条 /
// 5.55 MB，单次 saveChat 实测 26.4 ms（stringify 19.4 + 写盘 7.0）。活跃群
// 742 条/天 → 每天 19.6 秒主线程卡死。这不是"优化"，是修一个正在漏的地方。
//
// 分片后：data/messages/<safe>/<YYYY-MM>.jsonl
//   · 新消息走 appendFileSync（实测 0.37 ms）
//   · 只有改已有条目时才重写受影响的那一个月（1 万条约 2 ms）
// 读路径**不变**（仍全量载入合并成 st.messages）：33 个方法依赖全量，懒加载是 P2。
// 所以这次解决的是**写**，不是读 —— 别以为分片是为了省内存。

const UID_SEP = '#';
const META_FILE = '_meta.json';

function safeKey(chatKey) {
  // chatKey 形如 group:123 / private:456
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/** 该群的存档目录 */
function chatDir(chatKey) {
  return path.join(MESSAGES_DIR, safeKey(chatKey));
}

/**
 * 稳定 id —— 规则 `chatKey + '#' + id`，**永久冻结**。
 *
 * 为什么用 (chatKey, id) 而不是 mid：实测 1,428 条 mid 缺失、24,979 条 mid 是
 * 程序合成的负数 —— 那不是身份。id 由 nextLocalId 单调递增、永不复用。
 *
 * 为什么不落盘：它完全由 (chatKey, id) 决定，落盘等于同一事实存两份，
 * 一旦不一致无法判断哪份对。代价是规则不能改 —— 改了所有已入库的记忆条目、
 * 索引门牌、UI 编辑留痕全部失效。`test/store-uid-test.mjs` 把它钉死。
 */
export function uidOf(chatKey, id) {
  return `${chatKey}${UID_SEP}${id}`;
}

/** 旧的扁平文件路径。只被 loadChat 的兼容分支引用，迁移完成后不再写入。 */
function chatFileLegacy(chatKey) {
  return path.join(MESSAGES_DIR, `${safeKey(chatKey)}.json`);
}

/**
 * 条目所属月份（**本地时区**，不是 UTC —— 用户说的「10 月」指本地月）。
 * ts 非法 / 缺失时归 '0000-00' 而不是丢弃：与 pruneBefore「判断不了年龄时
 * 宁可留下」保持对称。原设计用 Number.isFinite(ts) 过滤，会造成
 * 「写进去读不出来，下次 rewrite 还会覆盖掉」的静默丢数据。
 */
function ymOf(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '0000-00';
  const d = new Date(n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` 平移 n 个月（跨年安全） */
function shiftYm(ym, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym));
  if (!m) return ym;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + Number(delta), 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** from..to 覆盖的本地月份（升序）。上限 600 个月，防 from=0 时生成两万个月名。 */
function monthsBetween(from, to) {
  const out = [];
  const d = new Date(Number(from) || 0);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  const end = new Date(Number(to) || 0);
  let guard = 0;
  while ((out.length === 0 || d.getTime() <= end.getTime()) && guard < 600) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() + 1);
    guard += 1;
  }
  return out;
}

/**
 * 磁盘上现有的分片月份。
 *
 * ★ rewrite 时必须并上它：只用内存里 st.messages 的月份的话，刚被删空的月份
 * 不在 st.messages 里 → 「rows.length === 0 → 删文件」那条分支永远走不到 →
 * clearChat / pruneBefore 删完，下次启动整月数据复活。
 * 这一条是本单最值钱的修正（clearChat 之后重启仍是 0 条，靠它）。
 */
function monthsOnDisk(chatKey) {
  try {
    return fs.readdirSync(chatDir(chatKey))
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 7));
  } catch { return []; }
}

// ── 聊天级 meta（P1-01a）────────────────────────────────────────────
// `{total, unread, lastTs, lastText}` —— 聊天列表角标与最后一条预览，
// 和消息级 `_meta.json`（nextLocalId/badRows）完全无关，别混。
//
// 缓存放在 `data/messages` **之外**：写 `data/messages/meta-index.json` 会改变
// 指纹目录自身的 mtime/内容，导致每次 stat 都 miss（自失效）。
const META_INDEX_FILE = path.join(DATA_DIR, 'meta-index.json');
const META_INDEX_VERSION = 1;
const META_FLUSH_DEBOUNCE_MS = 5000;

/** Map<safeKey, {fp, meta}> —— 懒加载，首次访问才读盘 */
let _metaIndex = null;
let _metaIndexDirty = false;
let _metaTimer = null;

/** safeKey(group:123) → group:123 */
function unsafeKey(safe) {
  const i = String(safe).indexOf('_');
  if (i <= 0) return null;
  return `${safe.slice(0, i)}:${safe.slice(i + 1)}`;
}

/** 全量计算一次 meta。口径与 getChatMeta 完全一致（未读只算他人消息）。 */
function chatMetaOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let unread = 0;
  for (const m of list) if (!m.read && !m.self) unread += 1;
  const last = list[list.length - 1] || null;
  return {
    total: list.length,
    unread,
    lastTs: Number(last?.ts) || 0,
    lastText: String(last?.text ?? '')
  };
}

function sameMeta(a, b) {
  return !!a && !!b
    && Number(a.total) === Number(b.total)
    && Number(a.unread) === Number(b.unread)
    && Number(a.lastTs) === Number(b.lastTs)
    && String(a.lastText ?? '') === String(b.lastText ?? '');
}

/**
 * 指纹 = 该 chat **全部**月文件 `name:size:mtimeMs` + legacy 扁平文件 `size:mtimeMs` + version。
 *
 * ★ 不能只取“最新月文件”：`saveChat` 按消息时间 `ymOf(e.ts)` 落月，
 *   补录一条旧消息会写**旧月份**，只看最新月会漏掉这次追加（永久命中过期 meta）。
 * 目录本身参与指纹是为了区分“目录存在但一个月文件都没有”和“目录不存在”。
 */
function metaFingerprint(chatKey) {
  const dir = chatDir(chatKey);
  const parts = [];
  let hasDir = false;
  try { hasDir = fs.statSync(dir).isDirectory(); } catch { /* 未迁移 */ }
  if (hasDir) {
    parts.push('dir');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { /* 读不了按空 */ }
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(dir, f));
        parts.push(`${f}:${st.size}:${Math.floor(st.mtimeMs)}`);
      } catch { /* 正被删除 */ }
    }
  }
  try {
    const st = fs.statSync(chatFileLegacy(chatKey));
    parts.push(`legacy:${st.size}:${Math.floor(st.mtimeMs)}`);
  } catch { /* 已迁移到分片 */ }
  return `v${META_INDEX_VERSION}|${parts.join('|')}`;
}

function loadMetaIndex() {
  if (_metaIndex) return _metaIndex;
  _metaIndex = new Map();
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(META_INDEX_FILE, 'utf8')); } catch { return _metaIndex; }
  if (!raw || Number(raw.version) !== META_INDEX_VERSION || !raw.chats || typeof raw.chats !== 'object') return _metaIndex;
  for (const [safe, v] of Object.entries(raw.chats)) {
    if (!v || typeof v.fp !== 'string' || !v.meta) continue;
    _metaIndex.set(safe, {
      fp: v.fp,
      meta: {
        total: Math.max(0, Number(v.meta.total) || 0),
        unread: Math.max(0, Number(v.meta.unread) || 0),
        lastTs: Number(v.meta.lastTs) || 0,
        lastText: String(v.meta.lastText ?? '')
      }
    });
  }
  return _metaIndex;
}

function scheduleMetaFlush() {
  _metaIndexDirty = true;
  if (_metaTimer) return;
  _metaTimer = setTimeout(() => { _metaTimer = null; flushMetaCache(); }, META_FLUSH_DEBOUNCE_MS);
  _metaTimer.unref?.();
}

/** 记一条（指纹在 loadChat 时才算了，这里直接传入，避免每次 getChatMeta 都 stat 一遍） */
function rememberMeta(chatKey, meta, fp) {
  const safe = safeKey(chatKey);
  const cache = loadMetaIndex();
  const prev = cache.get(safe);
  if (prev && prev.fp === fp && sameMeta(prev.meta, meta)) return;
  cache.set(safe, { fp, meta: { ...meta } });
  scheduleMetaFlush();
}

/**
 * 立刻把 meta 缓存写盘并返回写入条目数。`app.stop()` 必须调一次
 * （5 秒防抖的定时器带 unref，进程退出时不一定还有机会执行）。
 */
export function flushMetaCache() {
  if (_metaTimer) { clearTimeout(_metaTimer); _metaTimer = null; }
  if (!_metaIndex || !_metaIndexDirty) { _metaIndexDirty = false; return 0; }
  _metaIndexDirty = false;
  const chats = {};
  for (const [safe, v] of _metaIndex) chats[safe] = { fp: v.fp, meta: v.meta };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${META_INDEX_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: META_INDEX_VERSION, savedAt: Date.now(), chats }), 'utf8');
    fs.renameSync(tmp, META_INDEX_FILE);
    return _metaIndex.size;
  } catch (error) {
    console.warn('[store] meta 缓存写盘失败:', error?.message ?? error);
    return 0;
  }
}

/**
 * 读缓存并校验指纹：命中才返回 meta。P1-01a 只供测试与 P1-01b 使用，
 * `/api/chats` 仍走 `listChats() + getChatMeta()` 全量（不提前切换）。
 * @returns {{hit:boolean, meta:object|null, stale?:boolean}}
 */
export function peekChatMeta(chatKey) {
  const rec = loadMetaIndex().get(safeKey(chatKey));
  if (!rec) return { hit: false, meta: null };
  if (metaFingerprint(chatKey) !== rec.fp) return { hit: false, meta: null, stale: true };
  return { hit: true, meta: { ...rec.meta } };
}

// ── 写盘元数据（模块级 WeakMap：不进 state，state 理论上会被序列化）──
const META = new WeakMap();

/**
 * state → 最近一次**写盘后**的 meta 指纹（P1-01b）。
 *
 * 增量维护只改内存 meta，指纹要等 saveChat 真正落盘后才推进；
 * 用旧指纹写缓存会让冷启动永远 miss（磁盘已变、缓存指纹没跟上）。
 */
const META_FP = new WeakMap();

/** 内存 meta，缺失时按消息全量补一次（旧内存态/未 seed） */
function metaOfState(st) {
  if (!st.meta) st.meta = chatMetaOf(st.messages);
  return st.meta;
}

function metaOf(st) {
  if (!META.has(st)) META.set(st, { appended: [], dirty: new Set(), allDirty: false });
  return META.get(st);
}

/** 新条目：只进 append 队列（O(1)，不解析文件） */
function markAppended(st, entry) {
  metaOf(st).appended.push(entry);
}

/** 改了已有条目：标它所在的月，flush 时整月重写 */
function markDirty(st, ts) {
  const meta = metaOf(st);
  if (meta.allDirty) return;
  meta.dirty.add(ymOf(ts));
}

/**
 * 这些 state 是从**旧扁平文件**读出来的（还没迁移到分片）。
 *
 * ⚠️ 为什么必须有这个标记（施工单没预见的一个坑）：
 *   假设代码更新了但数据还没跑迁移脚本。启动 → 目录不存在 → loadChat 读旧
 *   .json（1.4 万条历史上线）→ 来了一条新消息 → saveChat 创建分片目录、只追加
 *   那 1 条 → 下次启动 → 目录存在了 → loadChat 只读分片 → **1.4 万条历史消失**。
 *
 *   所以在"旧文件还在"的状态下，第一次 saveChat 必须强制全量重写（把内存里的
 *   全部历史一起写成分片）。代价是这一次写盘约 26ms，之后恢复正常。
 *   手动迁移脚本仍是推荐路径；这条只是防止"忘了迁移"变成数据事故。
 */
const FROM_LEGACY = new WeakSet();

/** 批量 / 无法逐条定位（clear、prune 跨月、#trim）：全量重写 */
function markAllDirty(st) {
  metaOf(st).allDirty = true;
}

/**
 * 已确认存在的目录（运行期没人会去删它）。
 * 每条消息省一次 `mkdirSync(recursive)` —— 实测 0.26 ms，占 append 总开销的 1/3。
 * 若目录真被外部删了，append/rewrite 会抛 ENOENT，调用方清掉缓存重试一次（见 saveChat）。
 */
const DIR_READY = new Set();

function ensureDir(dir, force = false) {
  if (!force && DIR_READY.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  DIR_READY.add(dir);
}

/** 读 `_meta.json`；不存在 / 内容坏了返回 {}（不抛）。导出供测试验水位。 */
export function readMetaFile(chatKey) {
  try {
    return JSON.parse(fs.readFileSync(path.join(chatDir(chatKey), META_FILE), 'utf8')) || {};
  } catch { return {}; }
}

/**
 * 写 `_meta.json`：整个群的 id 水位，写坏就是 uid 全乱 → 必须 tmp + rename。
 *
 * ⚠️ 字段顺序有讲究。施工单伪代码是 `{ schema, badRows, updatedAt, ...prev,
 *    ...patch, nextLocalId }` —— `...prev` 排在 updatedAt 之后，会把刚算好的
 *    时间戳**盖回旧值**（prev 里本来就有 updatedAt）。这里改成 `...prev` 在前、
 *    显式字段在后，updatedAt 才是真的"最后更新时间"。
 *
 * nextLocalId **只增不减**：取 prev / patch / 1 三者的最大值。
 * 不 export：只允许 saveChat 和迁移脚本调，外部直写会绕过单调保护。
 */
function writeMetaFile(chatKey, patch = {}) {
  const dir = chatDir(chatKey);
  ensureDir(dir);
  const prev = readMetaFile(chatKey);
  const next = {
    ...prev,                                             // 保留未知字段（向前兼容）
    schema: 1,
    ...patch,
    badRows: Number(patch.badRows ?? prev.badRows) || 0,
    updatedAt: Date.now(),
    nextLocalId: Math.max(
      Number(prev.nextLocalId) || 0,
      Number(patch.nextLocalId) || 0,
      1
    ),
  };
  const target = path.join(dir, META_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * 读一个群的全部消息：**按月分片全量合并**（读路径本期不改）。
 *
 * 兼容：磁盘上没有分片目录时，回退读旧的扁平 `.json`。
 * ⚠️ 回退判据必须是「**目录不存在**」，不能是「读出来是空数组」。
 *    写成 `if (!messages.length) { 读旧文件 }` 的话，clearChat 之后
 *    （目录在、文件全删 → 空数组）会从旧文件把已删数据**复活**。
 */
function loadChat(chatKey) {
  const dir = chatDir(chatKey);
  const messages = [];
  let maxId = 0;
  let badRows = 0;

  let hasShardDir = false;
  try { hasShardDir = fs.statSync(dir).isDirectory(); } catch { /* 未迁移 */ }

  if (hasShardDir) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); }
    catch { /* 读不了当作空 */ }
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let e = null;
        try { e = JSON.parse(line); } catch { badRows += 1; continue; }   // 半行：跳过并计数
        // 只要求 id 合法（它是 uid 的组成部分）；ts 非法也保留，归 0000-00。
        if (!e || !Number.isFinite(Number(e.id))) { badRows += 1; continue; }
        messages.push(e);
        if (Number(e.id) > maxId) maxId = Number(e.id);
      }
    }
    messages.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0) || Number(a.id) - Number(b.id));

    const meta = readMetaFile(chatKey);
    if (badRows > (Number(meta.badRows) || 0)) {
      try { writeMetaFile(chatKey, { badRows }); } catch { /* 写不了不阻断读 */ }
    }
    // P1-01a：冷加载时算一次聊天级 meta 并种进缓存（`/api/chats` 此时仍全量，不读它）
    const chatMeta = chatMetaOf(messages);
    rememberMeta(chatKey, chatMeta, metaFingerprint(chatKey));
    return {
      chatKey,
      // ★ 两个都取大：meta 可能落后（手工拷了 jsonl 进来），maxId+1 可能撞车（删过最大 id）
      nextLocalId: Math.max(Number(meta.nextLocalId) || 0, maxId + 1, 1),
      messages,
      meta: chatMeta
    };
  }

  // ── 旧格式：扁平 json（只在「目录不存在」时走这里）──
  try {
    let text = fs.readFileSync(chatFileLegacy(chatKey), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.messages)) {
      const maxLegacy = parsed.messages.reduce((a, m) => Math.max(a, Number(m?.id) || 0), 0);
      const state = {
        chatKey,
        nextLocalId: Math.max(Number(parsed.nextLocalId) || 0, maxLegacy + 1, 1),
        messages: parsed.messages
      };
      state.meta = chatMetaOf(state.messages);
      rememberMeta(chatKey, state.meta, metaFingerprint(chatKey));
      // 标记"这份 state 还没迁移"：第一次 saveChat 要全量重写，把历史带进分片
      FROM_LEGACY.add(state);
      return state;
    }
  } catch { /* 新会话 */ }

  return { chatKey, nextLocalId: 1, messages: [], meta: chatMetaOf([]) };
}

/**
 * 双通道落盘。
 *
 * 通道一 append：新消息只追加（`appendFileSync`，实测 0.37 ms）。
 * 通道二 rewrite：改已有条目时只重写受影响的那一个月。
 *
 * 无任何脏标记时**直接返回**，不碰磁盘。现有 13 处调用里 markAllRead /
 * markUnreadInWindow / removeByLocalIds / clearChat 都有"改完发现 n=0"的情况，
 * 这条早退正好省掉它们的冗余写。
 */
function saveChat(state) {
  const meta = metaOf(state);
  const appended = meta.appended.splice(0);
  const dirty = [...meta.dirty];
  meta.dirty.clear();
  let all = meta.allDirty;
  meta.allDirty = false;
  // ★ 未迁移保护：这份 state 来自旧扁平文件 → 这次必须全量重写，
  //   把内存里的全部历史一起写成按月分片。否则历史只留在 .json 里，
  //   而 loadChat 一旦看到分片目录就不再读它 → 历史"消失"。
  if (FROM_LEGACY.has(state)) {
    FROM_LEGACY.delete(state);
    all = true;
  }
  if (!appended.length && !dirty.length && !all) return;

  const dir = chatDir(state.chatKey);
  ensureDir(dir);

  // 1) append 通道：跳过将被整月重写的
  if (appended.length) {
    const byMonth = new Map();
    for (const e of appended) {
      const ym = ymOf(e.ts);
      if (all || dirty.includes(ym)) continue;      // 重写会覆盖，跳过
      if (!byMonth.has(ym)) byMonth.set(ym, []);
      byMonth.get(ym).push(e);
    }
    for (const [ym, arr] of byMonth) {
      const text = arr.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const target = path.join(dir, `${ym}.jsonl`);
      try {
        fs.appendFileSync(target, text, 'utf8');
      } catch (e) {
        // 目录被外部删掉时缓存会骗我们 → 清缓存重来一次。别的错误照抛。
        if (e?.code !== 'ENOENT') throw e;
        DIR_READY.delete(dir);
        ensureDir(dir, true);
        fs.appendFileSync(target, text, 'utf8');
      }
    }
  }

  // 2) rewrite 通道
  // ★ 关键：allDirty 时必须「磁盘现有月 ∪ 内存月」。只用内存月的话，
  //   刚被删空的月份不在 state.messages 里 → 走不到 rows.length===0 分支 →
  //   clearChat / pruneBefore 删完，下次启动整月数据复活。
  const months = all
    ? new Set([...monthsOnDisk(state.chatKey), ...state.messages.map((e) => ymOf(e.ts))])
    : new Set(dirty);
  for (const ym of months) {
    const rows = state.messages.filter((e) => ymOf(e.ts) === ym);
    const target = path.join(dir, `${ym}.jsonl`);
    if (!rows.length) { fs.rmSync(target, { force: true }); continue; }   // 整月被删空 → 删文件
    // rewrite 用 tmp + rename：整体替换，写一半崩溃会毁掉整个月
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, rows.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, target);
  }

  // 3) 同步 id 水位
  //
  // ⚠️ 只在「发生了 rewrite」时写，纯 append 不写 —— 这是实测驱动的偏离
  //    （施工单伪代码是每次 saveChat 都写）。
  //
  //    原因：`writeFileSync + rename` 在 Windows 上实测 1.26 ms，而 append
  //    本身只有 0.47 ms。每次都写会让「新消息」这条最热的路径从 0.5 ms 变成
  //    ~5 ms（实测 appendIncoming 均值 5.0 ms），直接达不到 §6.2 的 < 0.5 ms。
  //
  //    为什么纯 append 可以不写：新条目已经进了 .jsonl，下次 loadChat 用
  //    `max(meta.nextLocalId, maxId + 1)` 算水位，maxId 已经包含它 → 不会撞车。
  //    真正需要 meta 的只有一个场景：**删掉了当前最大的 id**（maxId 会下降，
  //    光靠 max+1 会把那个 id 再发一次）。而删除必然走 rewrite 通道
  //    （removeByLocalIds 标 dirty、clearChat/pruneBefore/#trim 标 allDirty），
  //    所以那时一定会写。
  if (all || dirty.length) {
    writeMetaFile(state.chatKey, { nextLocalId: state.nextLocalId });
  }

  // 4) 写盘后推进 meta 缓存指纹（P1-01b）：缓存里的 meta 与磁盘内容必须同步推进，
  //    否则下次冷启动指纹永远不匹配 → 缓存等于没有。
  //    指纹只看 `*.jsonl`，因此 `_meta.json` 与 `.tmp` 中间文件不会影响它。
  try {
    if (state.meta) {
      const fp = metaFingerprint(state.chatKey);
      META_FP.set(state, fp);
      rememberMeta(state.chatKey, state.meta, fp);
    }
  } catch { /* 缓存异常不影响主流程 */ }
}

export class ChatStore {
  constructor(maxPerChat = 0) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.chats = new Map(); // chatKey -> state
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  /**
   * 数据保留策略：删除单条 ts 早于 cutoffMs 的消息。
   * 保留 nextLocalId 与文件本身，避免 UI 本地序号/引用错位。
   * @returns {number} 删除的消息条数
   */
  pruneBefore(cutoffMs) {
    if (!(cutoffMs > 0)) return 0;
    let removed = 0;
    for (const chatKey of this.listChats()) {
      const st = this.#state(chatKey);
      const before = st.messages.length;
      if (!before) continue;
      // 缺 ts / ts 非法 的消息保留：判断不了年龄时宁可留下，不误删
      st.messages = st.messages.filter((m) => {
        const ts = Number(m?.ts);
        return !Number.isFinite(ts) || ts <= 0 || ts >= cutoffMs;
      });
      const n = before - st.messages.length;
      // 跨月删除，无法逐条定位 → 全量重写。分片后它会自动删掉整月的文件
      // （saveChat 里 rows.length===0 → rmSync），比原来重写一个大文件快得多。
      if (n > 0) { removed += n; this.#refreshMeta(st); markAllDirty(st); saveChat(st); }
    }
    return removed;
  }

  #state(chatKey) {
    if (!this.chats.has(chatKey)) this.chats.set(chatKey, loadChat(chatKey));
    return this.chats.get(chatKey);
  }

  listChats() {
    // 从磁盘还原 chatKey，已加载的直接带上。
    // ⚠️ 分片后**必须同时认子目录和旧扁平文件**：只认 .json 的话 listChats()
    //    会返回空数组 → UI 会话列表全空、pruneBefore 一个都不遍历、getChatMeta
    //    全 404 —— 看起来就像"数据全丢了"。这是本单最容易漏的一处。
    try {
      const entries = fs.readdirSync(MESSAGES_DIR, { withFileTypes: true });
      for (const ent of entries) {
        // 新格式：目录 group_123 / 旧格式：文件 group_123.json
        const m = ent.isDirectory()
          ? /^((?:group|private)_\d+)$/.exec(ent.name)
          : /^((?:group|private)_\d+)\.json$/.exec(ent.name);
        if (!m) continue;
        const safe = m[1];
        const i = safe.indexOf('_');
        if (i <= 0) continue;
        this.#state(`${safe.slice(0, i)}:${safe.slice(i + 1)}`);
      }
    } catch { /* 目录不存在 */ }
    return [...this.chats.keys()];
  }

  /**
   * 只 `readdir` 的 chatKey 枚举（P1-01a）。
   *
   * 明确**不**调用 `#state()`：那样等于把所有 chat 全量读进内存，
   * 正是本单要消掉的成本。返回“磁盘 key ∪ 内存里尚未落盘的 key”——
   * 只返回 `chats.keys()` 会在冷启动时漏掉磁盘上的历史 chat。
   * `_legacy` 是迁移源目录，不是 chat。
   */
  listChatKeys() {
    const keys = new Set();
    try {
      const entries = fs.readdirSync(MESSAGES_DIR, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          if (ent.name === '_legacy') continue;
          const m = /^((?:group|private)_\d+)$/.exec(ent.name);
          const key = m && unsafeKey(m[1]);
          if (key) keys.add(key);
        } else {
          // 旧扁平格式：group_123.json（列表里必须保留，否则迁移前 UI 会话列表为空）
          const m = /^((?:group|private)_\d+)\.json$/.exec(ent.name);
          const key = m && unsafeKey(m[1]);
          if (key) keys.add(key);
        }
      }
    } catch { /* 目录不存在 */ }
    // 刚收到消息、还没落盘的 chat
    for (const key of this.chats.keys()) keys.add(key);
    return [...keys];
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    // P1-01b：直接返回内存 meta —— 所有变更路径已增量维护，这里 O(1)。
    // 旧内存态 / 未 seed（st.meta 缺失）由 metaOfState 兜底算一次并写回，
    // 绝不返回空 meta（施工单 §8.2 第 2 条）。
    const meta = metaOfState(st);
    return { chatKey, total: meta.total, unread: meta.unread, lastTs: meta.lastTs, lastText: meta.lastText };
  }

  /**
   * 列表用 meta（P1-01b `/api/chats` 的读路径）。
   *
   * 顺序：内存 → meta-index 缓存（指纹命中）→ 都 miss 才对**这一个** chat 做 loadChat。
   * 与 `getChatMeta()` 的区别是它不会为了取 meta 把每个 chat 的消息全读进内存。
   */
  chatMetaForList(chatKey) {
    const st = this.chats.get(chatKey);
    if (st) return this.getChatMeta(chatKey);
    const cached = peekChatMeta(chatKey);
    if (cached.hit && cached.meta) {
      const m = cached.meta;
      return { chatKey, total: m.total, unread: m.unread, lastTs: m.lastTs, lastText: m.lastText };
    }
    return this.getChatMeta(chatKey);   // 缓存未命中：只加载这一个
  }

  /**
   * 计数器兜底：按消息全量重算 meta 并同步缓存（P1-01b 的增量维护出错时用）。
   * 对不上时调用方应记一条告警 —— 静默纠偏会让漂移永远发现不了。
   */
  recomputeMeta(chatKey) {
    const st = this.#state(chatKey);
    const meta = chatMetaOf(st.messages);
    st.meta = meta;
    rememberMeta(chatKey, meta, metaFingerprint(chatKey));
    return { chatKey, ...meta };
  }

  /** 追加一条收到的消息（未读）。返回写入的条目。 */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], isPoke = false, atMe = null, atNames = [], atIds = [] }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : [],
      // 拍一拍事件：可作触发批（resolveContextTier 按 1 档响应），但不进【已读信息】
      isPoke: Boolean(isPoke),
      // @ 判定标记（2026-09-26）：atMe 以 @ 段的 QQ 号为准 —— 文本包含匹配
      // 分不清"同名不同人"（群友 @ 的人与机器人重名时被误判为 @机器人）。
      // null = 老存档未标，判定层回落文本匹配。
      atMe: atMe === null || atMe === undefined ? null : Boolean(atMe),
      // 渲染进 text 的 @片段原文（含 @ 前缀）：关键词判定据此剔除，
      // 防"@ 别人的名字里带关键词"误触发。空数组 = 该消息没有 @ 段。
      atNames: (Array.isArray(atNames) ? atNames : []).map((n) => String(n ?? '')).filter(Boolean).slice(0, 20),
      // L1 收敛：@ 段的数字 QQ（排除 all/空值），供在场过滤的 protectedIds 用。
      atIds: (Array.isArray(atIds) ? atIds : []).map((q) => String(q ?? '')).filter((q) => /^\d+$/.test(q)).slice(0, 20)
    };
    st.messages.push(entry);
    const cut = this.#trim(st);
    // 增量 meta：新消息必未读、必是最后一条。若发生了裁剪，整体重算
    // （裁掉的最老消息可能正是某条未读，增量会把它算漏）。
    if (cut) this.#refreshMeta(st);
    else this.#bumpMeta(st, { total: 1, unread: 1, last: entry });
    markAppended(st, entry);        // 新消息走 append 通道，不重写整月
    saveChat(st);
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts, mid = null }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: []
    };
    st.messages.push(entry);
    const cut = this.#trim(st);
    // 自己发的不算未读，只动 total 与预览
    if (cut) this.#refreshMeta(st);
    else this.#bumpMeta(st, { total: 1, unread: 0, last: entry });
    markAppended(st, entry);        // 同上
    saveChat(st);
    return entry;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    // 逐条标脏：只标**真正从 false 翻到 true** 的那些（未读常集中在当月，
    // 但暂停期间攒下的积压可能跨月，必须逐条判，不能只标"当月"）
    let marked = 0;
    for (const m of st.messages) {
      if (!m.read) { m.read = true; markDirty(st, m.ts); if (!m.self) marked += 1; }
    }
    // 增量 meta：按真正置读的条数减（不直接写 0 —— self/未来口径变化时会算错）
    const mm = metaOfState(st);
    mm.unread = Math.max(0, (Number(mm.unread) || 0) - marked);
    saveChat(st);
    return unread;
  }

  /**
   * 只 drain「从某条消息起**之后**」的未读：取走触发批，之前的旧积压单独标已读。
   *
   * 为什么需要它（2026-09-25 触发链路重做的补丁）：磁盘上可能遗留旧进程/
   * 暂停期间攒下的积压未读。它们从未经过 onIncoming 的逐条判定，如果一次
   * 触发的 drain 把它们全部吃进触发批，模型会看到一大坨"未读信息"——用户
   * 看到的就是"积压消息被整批塞进唤醒"。正确语义：
   *   · 触发消息 X 之后的未读 = 本批的聚批对象（X 也在内）；
   *   · X 之前的旧未读 = 触发前就该已读的历史 → 标已读沉入【已读信息】。
   *
   * @param {string} chatKey
   * @param {number} fromTs 批的起点（触发消息的 ts，含）；早于它的未读标已读
   * @returns {{ batch: object[], archived: number }} batch = 触发批，archived = 被归档的旧未读条数
   */
  drainUnreadFrom(chatKey, fromTs) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    const batch = [];
    let archived = 0;
    for (const m of unread) {
      if (m.ts >= fromTs) batch.push(m);
      else { m.read = true; archived++; }   // 触发点之前的旧积压：沉入历史
    }
    // batch 里的也置已读（作为触发批取走）。统一在这里逐条标脏 ——
    // 跨月积压是真实场景，不能只按"当月"标。
    // ⚠️ archived 那批在上面已经置读了，不会出现在下面的 marked 里，
    //    计算未读减量时必须一起算上，否则 unread 会永久残留。
    let marked = 0;
    for (const m of st.messages) {
      if (!m.read) { m.read = true; markDirty(st, m.ts); if (!m.self) marked += 1; }
    }
    // 增量 meta：只减真正被置读的条数（不能直接把 unread 写 0）
    const mm = metaOfState(st);
    mm.unread = Math.max(0, (Number(mm.unread) || 0) - marked - archived);
    saveChat(st);
    return { batch, archived };
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) { m.read = true; n++; markDirty(st, m.ts); }
    }
    if (n) {
      // 增量 meta：n 是本次真正置读的他人消息条数（口径与 unread 一致）
      const mm = metaOfState(st);
      mm.unread = Math.max(0, (Number(mm.unread) || 0) - n);
      saveChat(st);
    }
    return n;
  }

  /**
   * 把**单条**消息标记为已读（不取走）。
   *
   * 逐条触发判定（onIncoming）用：该条不触发会话时当场标已读、沉入历史，
   * 不动其它未读 —— 那些是"倒计时窗口内追加的"或"上一批遗留的"，
   * 各有自己的归宿（前者等 drain，后者等兜底或下一次触发）。
   *
   * @param {string} chatKey
   * @param {number} id 消息条目的本地 id（appendIncoming 返回的 entry.id）
   * @returns {boolean} 是否真的标记了（false = 没找到/本来就是已读）
   */
  markEntryRead(chatKey, id) {
    const st = this.#state(chatKey);
    const m = st.messages.find((x) => x.id === id);
    if (!m || m.read || m.self) return false;
    m.read = true;
    // 增量 meta：只有真正从「他人未读」翻成已读才减 1（self/已读已在上面 return）
    const mm = metaOfState(st);
    mm.unread = Math.max(0, (Number(mm.unread) || 0) - 1);
    markDirty(st, m.ts);
    saveChat(st);
    return true;
  }

  /**
   * 把时间窗内的**已读**消息重新标记为未读（手动重试失败会话用）。
   *
   * 触发批当初被 drainUnread 置了已读；重试时按会话起止时间把它们翻回未读，
   * 唤醒流程就能重新取走它们。窗口向前放宽 5 分钟（容纳防抖聚批期），
   * 向后到会话结束 —— 窗口外的不动，避免误翻后来真正已读的历史。
   * @returns {number} 恢复为未读的条数
   */
  markUnreadInWindow(chatKey, startedAt, endedAt) {
    const st = this.#state(chatKey);
    const winStart = Number(startedAt) - 5 * 60 * 1000;
    const winEnd = Number(endedAt || startedAt) + 1000;
    let n = 0;
    for (const m of st.messages) {
      if (m.self) continue;
      if (m.read && m.ts >= winStart && m.ts <= winEnd) { m.read = false; n++; markDirty(st, m.ts); }
    }
    if (n) {
      // 增量 meta：翻回未读的条数即未读增量
      const mm = metaOfState(st);
      mm.unread = (Number(mm.unread) || 0) + n;
      saveChat(st);
    }
    return n;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /** 查看当前未读消息（不置已读），用于“等待中”会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true, visibleOnly = false } = {}) {
    const st = this.#state(chatKey);
    let all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // visibleOnly（2026-11-04）：get_recent_messages 用。
    // 以前它直接把原始数组给模型，撤回/拍一拍/屏蔽名单的消息也能翻到 ——
    // 提示词里看不到、工具里看得到，等于绕过所有过滤。这里补上同一份谓词。
    // ⚠️ 不改 offset 语义（仍按"展示条数"跳"原始数组"）。
    // 改成"先滤后取"会让可见数不足时的窗口整体前移，提示词内容随之变化。
    if (visibleOnly) {
      const vis = this.visibilityContext(chatKey);
      all = all.filter((m) => this.isVisible(m, chatKey, vis));
    }
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  /**
   * 可见消息总数（与 recent(visibleOnly:true) 同一套谓词）。
   * 供 get_recent_messages 计算"这一页之前还有多少条更早的"。
   * 一次遍历，不复制数组；5400 条量级实测 < 1 ms。
   *
   * ⚠️ 不要用 recent(chatKey,{limit:1e9}).length 代替 —— 那会把整个数组
   * 复制一遍（5400 条 × 对象），只为要一个数字。
   * ⚠️ 以后给可见性加第四条规则时，只需改 isVisible()：本方法与 recent()
   * 都调它，会自动同步；若绕过谓词另写一套过滤，older 会算错。
   */
  countVisible(chatKey) {
    const st = this.#state(chatKey);
    const vis = this.visibilityContext(chatKey);
    let n = 0;
    for (const m of st.messages) if (this.isVisible(m, chatKey, vis)) n += 1;
    return n;
  }

  /**
   * 按 ts 区间取消息（**只读**，第 1 期 L4 摘要的输入口，2026-11-14）。
   *
   * 为什么必须新加一个方法：`recent()` 是从尾部取 N 条，没有区间语义
   * （`limit: 1e9` 会把 5.7 万条数组整个复制一遍）；`search()` 按词；
   * `#corpus()` 是私有的。让 mem2 自己读 jsonl 更糟 —— 绕开内存缓存，
   * 还得重写一遍"谁能看见谁"。
   *
   * ⚠️ **本方法绝不能产生任何写盘**：不调 markDirty / saveChat / #trim，
   *    也不"顺手整理" st.messages。它只读不变量，加了写操作会破坏
   *    「读消息不会改存档」这条基本预期（调用方是每 10 分钟一次的定时任务）。
   *
   * 边界：`[fromTs, toTs]` **两端都含**（调用方要 `>` 语义自己减 1）。
   *
   * @param {string} chatKey
   * @param {{fromTs?:number, toTs?:number, includeSelf?:boolean, visibleOnly?:boolean}} opts
   * @returns {Array} 引用原数组里的元素（不深拷贝 —— 调用方只读）
   */
  rangeByTs(chatKey, { fromTs = 0, toTs = Infinity, includeSelf = true, visibleOnly = true } = {}) {
    const st = this.#state(chatKey);
    const msgs = st.messages;
    if (!msgs.length) return [];
    const from = Number(fromTs) || 0;
    const to = toTs === Infinity ? Infinity : (Number(toTs) || 0);

    // messages 始终按 ts 升序（append 追加 + 分片按时间读）；先定位起点再定位终点，
    // 避免对整月 1.4 万条都走一遍谓词。
    let i = msgs.findIndex((m) => (Number(m.ts) || 0) >= from);
    if (i < 0) return [];
    const out = [];
    const vis = visibleOnly ? this.visibilityContext(chatKey) : null;
    for (; i < msgs.length; i += 1) {
      const m = msgs[i];
      const ts = Number(m.ts) || 0;
      if (ts > to) break;
      if (!includeSelf && m.self) continue;
      if (vis && !this.isVisible(m, chatKey, vis)) continue;
      out.push(m);
    }
    return out;
  }

  /**
   * 月级读取（P1-02）：只读窗口覆盖的月份分片（前后各扩 1 个月）。
   *
   * 与 `rangeByTs` 的分工：那个走 `#state()`（把该 chat **全部**月份读进内存，
   * 供 UI / 已加载 chat 用）；本方法只 `readdir` + 读命中的 `.jsonl`，
   * 不写盘、不改 `nextLocalId`、不往 `this.chats` 里塞。
   *
   * 返回**新数组**（不是原数组引用），调用方只能读。
   *
   * @param {{fromTs?:number, toTs?:number, includeSelf?:boolean, visibleOnly?:boolean, full?:boolean}} opts
   *   `full:true` 才读全部分片；`fromTs` 缺失/0 时按 `toTs - 30min` 兜底
   *   （绝不从 1970 年开始扫全部月份）。
   */
  loadChatRange(chatKey, { fromTs = 0, toTs = Infinity, includeSelf = true, visibleOnly = true, full = false } = {}) {
    const to = toTs === Infinity ? Date.now() : (Number(toTs) || 0);
    let from = Number(fromTs) || 0;
    if (full) {
      from = 0;
    } else {
      if (!(from > 0)) from = to - 30 * 60 * 1000;   // 兜底窗口，不能是 1970
      if (from > to) from = to;
    }

    // 月份集合：窗口覆盖的月份 ±1（防时区边界把跨月消息切掉）
    let wanted = null;
    if (!full) {
      wanted = new Set();
      const base = monthsBetween(from, to);
      for (const ym of base) {
        wanted.add(ym);
        wanted.add(shiftYm(ym, -1));
        wanted.add(shiftYm(ym, 1));
      }
      if (wanted.size > 6) console.warn(`[store] loadChatRange ${chatKey} months=${wanted.size}`);
    }

    const dir = chatDir(chatKey);
    let hasDir = false;
    try { hasDir = fs.statSync(dir).isDirectory(); } catch { /* 未迁移 */ }

    const messages = [];
    if (hasDir) {
      // ★ 分片目录存在就只月份分片，绝不回退 legacy（会把已迁移数据重复计入）
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)); } catch { /* 读不了当空 */ }
      if (wanted) files = files.filter((f) => wanted.has(f.slice(0, 7)));
      files.sort();
      for (const f of files) {
        let text = '';
        try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          if (!line) continue;
          let e = null;
          try { e = JSON.parse(line); } catch { continue; }
          if (!e || !Number.isFinite(Number(e.id))) continue;
          messages.push(e);
        }
      }
    } else {
      // legacy 回退：**只在分片目录不存在时**（与 loadChat 的优先级一致）
      try {
        let text = fs.readFileSync(chatFileLegacy(chatKey), 'utf8');
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.messages)) messages.push(...parsed.messages);
      } catch { /* 没有旧文件 */ }
    }

    messages.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0) || Number(a.id) - Number(b.id));

    const vis = visibleOnly ? this.visibilityContext(chatKey) : null;
    const out = [];
    for (const m of messages) {
      const ts = Number(m.ts) || 0;
      if (ts < from || ts > to) continue;
      if (!includeSelf && m.self) continue;
      if (vis && !this.isVisible(m, chatKey, vis)) continue;
      out.push(m);
    }
    return out;
  }

  // ── 可见性谓词（检索与提示词唯一的过滤实现，2026-11-04）────────────────
  //
  // 只覆盖三条过滤：撤回 / 拍一拍 / 屏蔽名单。
  // 检索侧另有 includeSelf、机器人占位符两步，**不能**并进来 ——
  // buildPastState 排除机器人自己的 `[表情包…]` 会改变提示词内容。
  //
  // 屏蔽名单每次都要从 config 现取（用户随时可能改），所以这里提供
  // visibilityContext() 预构建 Set：一次检索 6,800 条消息时，每条都重建一个
  // 含 300 项的 Set 会白烧十几毫秒（实测 2.1 ms → 0.4 ms）。
  visibilityContext(chatKey) {
    const cfg = getConfig();
    const global = new Set((cfg.globalBlocklist || []).map(String));
    const [kind, id] = String(chatKey || '').split(':');
    const group = kind === 'group' && id ? new Set((cfg.blocklist?.[id] || []).map(String)) : new Set();
    return { global, group };
  }

  isVisible(m, chatKey, vis = null) {
    if (!m || m.recalled || m.isPoke) return false;
    if (m.self) return true;    // 机器人自己的发言不受屏蔽名单影响
    const ctx = vis || this.visibilityContext(chatKey);
    const senderId = String(m.senderId ?? '');
    if (ctx.global.size && ctx.global.has(senderId)) return false;
    if (ctx.group.size && ctx.group.has(senderId)) return false;
    return true;
  }

  /**
   * 检索语料 = 可见消息（撤回/拍一拍/屏蔽已排除）+ 排除机器人占位符。
   * search() 与 wordDf() 共用它，保证 df 与命中集永远同口径。
   */
  #corpus(chatKey, { includeSelf = true, vis = null } = {}) {
    const ctx = vis || this.visibilityContext(chatKey);
    const out = [];
    for (const m of this.#state(chatKey).messages) {
      if (!this.isVisible(m, chatKey, ctx)) continue;
      if (!includeSelf && m.self) continue;
      // 老存档可能缺 text：在入口归一成字符串，后面的 includes 就不必逐条 String()
      if (typeof m.text !== 'string') m.text = String(m.text ?? '');
      // 机器人自己的占位符消息（发送记录）不算可检索内容
      if (m.self && SELF_PLACEHOLDER_RE.test(m.text)) continue;
      out.push(m);
    }
    return out;
  }

  /**
   * 历史检索：时间 / 人 / 关键词三维定位。
   *
   * 不建索引、不落盘、不缓存：单次遍历现算 tf/df。29k 条上 4 个词约 4 ms，
   * 8 个词约 8 ms —— 比"词频表 + 置脏 + TTL"简单且更准（read_forward 展开
   * 会整段改写 text，任何缓存都要额外维护失效）。
   *
   * @returns {{ totalHits:number, words:Array<{word,df}>, messages:Object[] }}
   *          totalHits = **完整命中集**的大小（不受 limit 截断影响）
   */
  search(chatKey, {
    words = [],
    mode = 'all',
    sender = '',
    from = 0,
    to = Infinity,
    limit = 10,
    offset = 0,
    context = 1,
    includeSelf = true
  } = {}) {
    const vis = this.visibilityContext(chatKey);
    const corpus = this.#corpus(chatKey, { includeSelf, vis });
    // 工具入参最多 8 个词（防模型塞长串）。
    const qwords = [...new Set(
      (Array.isArray(words) ? words : [words])
        .map((w) => String(w ?? '').trim())
        .filter(Boolean)
    )].slice(0, 8);

    // 一次遍历：累计 df（语料口径 = 上面的 corpus），N 只数语料条数
    const df = new Map(qwords.map((w) => [w, 0]));
    if (qwords.length) {
      for (const m of corpus) {
        const text = m.text;
        for (let k = 0; k < qwords.length; k += 1) if (text.includes(qwords[k])) df.set(qwords[k], df.get(qwords[k]) + 1);
      }
    }
    const N = corpus.length;
    // idf 只跟 df 有关，先算好数组：命中循环里每条消息再算一次 log 是纯浪费
    const idfList = qwords.map((w) => {
      const d = df.get(w) || 0;
      return Math.log(1 + (N - d + 0.5) / (d + 0.5));
    });

    const senderKey = String(sender ?? '').trim();
    const notes = getConfig().memberNotes || {};
    const now = Date.now();
    const hits = [];
    for (let i = 0; i < corpus.length; i += 1) {
      const m = corpus[i];
      const ts = Number(m.ts) || 0;
      if (ts < from || ts > to) continue;                     // 第 1 步：时间
      if (senderKey && !matchSender(m, senderKey, notes)) continue;   // 第 2 步：发送者
      const text = m.text;
      // tf 同时用于"是否命中"和打分：一次 indexOf 扫描，不再 filter + 再扫一遍
      let score = 0;
      let matched = 0;
      for (let k = 0; k < qwords.length; k += 1) {
        const tf = countOccurrences(text, qwords[k]);
        if (!tf) continue;
        matched += 1;
        score += idfList[k] * (tf / (tf + 1.2));   // tf 饱和，防长文本刷分
      }
      if (qwords.length) {
        if (mode === 'all' ? matched < qwords.length : matched === 0) continue;
      }
      score += 0.5 * Math.exp(-(now - ts) / (3 * 864e5));   // 3 天半衰期
      hits.push({ m, i, score });
    }

    // offset 永远作用于**完整命中集**：超限截断只限制"这次返回几条"，
    // 不能先截断再跳（那样 offset ≥ 5 会恒为空，模型会误判"没有更多了"）。
    hits.sort((a, b) => (b.score - a.score) || ((Number(b.m.ts) || 0) - (Number(a.m.ts) || 0)));
    const start = Math.max(0, Number(offset) || 0);
    const cap = Math.max(1, Number(limit) || 1);
    const page = hits.slice(start, start + cap);

    const withContext = context !== 0 && Number(context) > 0;
    return {
      totalHits: hits.length,
      words: qwords.map((w) => ({ word: w, df: df.get(w) || 0 })),
      messages: page.map(({ m, i }) => {
        const out = {
          id: m.id,
          mid: m.mid ?? null,
          ts: m.ts,
          senderId: m.senderId,
          senderName: m.senderName,
          self: !!m.self,
          text: m.text,
          reply: m.reply || null,
          media: Array.isArray(m.media) ? m.media : []
        };
        if (withContext) {
          // 上下文取自**检索语料**（同一条链过滤），不能回原始数组取 ——
          // 否则被屏蔽/撤回的那些会借 before/after 漏回模型眼前。
          out.before = contextLine(corpus[i - 1]);
          out.after = contextLine(corpus[i + 1]);
        }
        return out;
      })
    };
  }

  /**
   * 只回 df、不打分、不产消息。
   *
   * **现状（2026-11-04）**：静默召回（每轮自动注入历史消息作背景）已整体删除，`src/` 下没有
   * 生产调用方，只剩 `test/search-test.mjs` 的 12b / 21 覆盖它。保留是作为
   * 通用 df 查询工具（要按"稀有度"筛词时直接可用），**不是**因为有工具在用。
   *
   * 契约：入参超 256 时内部 clamp 并标 truncated，**从不抛错**。
   * （这条契约来自它曾跑在 buildUserPrompt 的同步路径上；将来若重新接进
   * 提示词组装，不要把这条降级成 throw。）
   *
   * @returns {{ truncated: boolean, words: Array<{word:string, df:number}> }}
   */
  wordDf(chatKey, words = []) {
    const raw = Array.isArray(words) ? words : (words === null || words === undefined ? [] : [words]);
    const list = raw.map((w) => String(w ?? '').trim()).filter(Boolean);
    const truncated = list.length > 256;
    const picked = [...new Set(truncated ? list.slice(0, 256) : list)];
    const counts = new Map(picked.map((w) => [w, 0]));
    if (!picked.length) return { truncated, words: [] };
    const corpus = this.#corpus(chatKey);
    for (const m of corpus) {
      const text = String(m.text ?? '');
      for (const w of picked) if (text.includes(w)) counts.set(w, counts.get(w) + 1);
    }
    return { truncated, words: picked.map((w) => ({ word: w, df: counts.get(w) })) };
  }


  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  /**
   * 标记一条消息已被用户撤回（按 QQ 消息 id）。
   * 撤回的消息后续不再发给大模型（buildPastState 会过滤 recalled）。
   * @returns {boolean} 是否找到并标记了
   */
  markRecalled(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    m.recalled = true;
    m.read = true;   // 撤回的消息也算"已读"，不再触发回复
    // 撤回不删消息，但未读数要减（它原先可能算未读），最后一条的预览也要重算。
    // 增量只减 1 会漏掉“本来已读”的情况，这里整体重算（撤回是低频操作）。
    this.#refreshMeta(st);
    markDirty(st, m.ts);
    saveChat(st);
    return true;
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * —— 一次展开，以后谁（模型/存档页/金句）都直接读到内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    if (text != null) m.text = String(text);
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const seen = new Set(m.media.map((x) => x && x.url));
      for (const x of appendMedia) {
        if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
      }
    }
    // 命中最后一条时必须让 lastText 跟着变（read_forward 把占位符展开成正文）；
    // total/unread 不变，但统一重算最稳（只有文本变了，两个计数自然一致）。
    this.#refreshMeta(st);
    markDirty(st, m.ts);
    saveChat(st);
    return true;
  }

  /**
   * 回填媒体的本地路径（入站预缓存用）。按 mid + media.file 定位。
   * 为什么不复用 updateByMid：那个只支持 text / appendMedia（按 url 去重），
   * 这里要改的是既有 media 条目的 path 字段。
   * @returns {boolean} 是否更新
   */
  setMediaPath(chatKey, mid, file, localPath) {
    // 空 file 必须直接拒绝：cachePathFor 在 file 为空时会退回用 url 做哈希，
    // 于是 setMediaPath(mid, '', path) 会命中该消息里**第一条 file 也为空**的媒体
    // —— 通常是同一句里那张图片。宁可这次不回填，也不能把图片的 path 写成视频。
    if (!String(file ?? '').trim()) return false;
    const st = this.#state(chatKey);
    const m = st.messages.find((x) => String(x.mid) === String(mid));
    if (!m || !Array.isArray(m.media)) return false;
    const target = m.media.find((x) => x && String(x.file) === String(file));
    if (!target) return false;
    target.path = String(localPath || '');
    markDirty(st, m.ts);
    saveChat(st);
    return true;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /**
   * 删除指定本地 id 的消息（部分清除）。返回删掉的条数。
   * @param {string} chatKey
   * @param {number[]} localIds 本地递增 id 数组
   */
  removeByLocalIds(chatKey, localIds = []) {
    const st = this.#state(chatKey);
    const ids = new Set((Array.isArray(localIds) ? localIds : [localIds]).map(Number));
    if (!ids.size) return 0;
    const before = st.messages.length;
    // ★ 脏标记必须在 filter **之前**收集：filter 之后这些条目就不在数组里了，
    //   没法再知道它们属于哪个月 → 那个月的文件不会被重写 → 删除"不生效"。
    for (const m of st.messages) if (ids.has(m.id)) markDirty(st, m.ts);
    st.messages = st.messages.filter((m) => !ids.has(m.id));
    const removed = before - st.messages.length;
    // 删掉的可能是未读、也可能就是最后一条 → 整体重算（低频操作）
    if (removed) { this.#refreshMeta(st); saveChat(st); }
    return removed;
  }

  /**
   * 清空某会话的全部消息（整体清除）。返回删掉的条数。
   * 会话文件保留（空 messages），下次来消息继续往里写。
   */
  clearChat(chatKey) {
    const st = this.#state(chatKey);
    const removed = st.messages.length;
    if (removed) {
      st.messages = [];
      // 整群清空，无法逐条定位 → 全量重写。
      // ★ 这一步配合 saveChat 里的「磁盘现有月 ∪ 内存月」才会真的删掉所有 .jsonl；
      //   只标内存月的话，删空的月份文件会留下来，重启就把数据读回来了。
      this.#refreshMeta(st);
      markAllDirty(st);
      saveChat(st);
    }
    return removed;
  }

  /**
   * 仅屏蔽（不删除）：把某会话的全部未读标记为已读。
   * 与 markAllRead 相同语义，这里显式命名供"仅屏蔽、不再发送"场景调用。
   * 返回标记的条数。
   */
  muteUnread(chatKey) {
    return this.markAllRead(chatKey);
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  /**
   * 溢出裁剪。返回被裁掉的条数 —— append 之后若真的裁过，
   * 增量 meta 必须整体重算（裁掉的最老消息可能是未读、也可能是 lastTs 的来源）。
   */
  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      const cut = st.messages.length - this.maxPerChat;
      st.messages.splice(0, cut);
      // 裁掉的是最老的，跨月时可能整月消失 → 无法逐条定位，全量重写。
      // 当前 maxMessagesPerChat 默认 0（不限制），这里只是兜底，不做优化。
      markAllDirty(st);
      return cut;
    }
    return 0;
  }

  /** 增量更新（P1-01b）：只有确定语义变化的路径才用它，其余一律 #refreshMeta */
  #bumpMeta(st, { total = 0, unread = 0, last = null } = {}) {
    const m = metaOfState(st);
    m.total = Math.max(0, (Number(m.total) || 0) + total);
    m.unread = Math.max(0, (Number(m.unread) || 0) + unread);
    if (last) {
      m.lastTs = Number(last.ts) || 0;
      m.lastText = String(last.text ?? '');
    }
    st.meta = m;
  }

  /** 低频/无法逐条定位的路径：整体重算 */
  #refreshMeta(st) {
    st.meta = chatMetaOf(st.messages);
    return st.meta;
  }
}
