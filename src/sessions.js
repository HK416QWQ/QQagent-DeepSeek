// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { ensureTelemetryTotals, addTelemetryDelta } from './telemetry.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
// 用量按天账本（P0-04）。**不要复用 data/usage-days/**：那是用量页的派生聚合，
// 拿来当会话账本会在重试/跨零点时对不上。
const LEDGER_DIR = path.join(DATA_DIR, 'usage-ledger');
// 写账失败队列：存的是“用量快照”，不是 id —— 重试会重置 usage，只存 id 会记错。
const PENDING_FILE = path.join(DATA_DIR, 'usage-pending.json');
const MIRROR_FILE = path.join(DATA_DIR, 'usage-today.json');
const LEDGER_VERSION = 1;
const PENDING_LIMIT = 1000;
// 索引缓存：启动加速的关键。没有它时 #loadIndex 要逐个 readFileSync+JSON.parse
// 全部会话文件（用户实测 2277 个文件 / 178MB 要 25 秒）；有了它启动只读这一个
// ~0.5MB 的单文件（3ms 级）。缓存与磁盘文件的增量校验在后台异步做（见
// reconcileInBackground），所以缓存缺失/过期都只是"首次启动慢"，不会错。
const INDEX_CACHE_FILE = path.join(DATA_DIR, 'session-index-cache.json');
const INDEX_CACHE_VERSION = 1;
// 僵尸候选集不再按“最近 N 天 mtime”扩窗口：候选完全由「磁盘文件 − 缓存条目」
// 推导（运行中/新产生的会话从不进缓存），再补一次“缓存里残留 running/waiting”
// 的防御性重读。启动不再对全部会话文件逐个 stat。
// 变更后写缓存的防抖间隔：写缓存本身也是 ~0.5MB 的同步 IO，不值得每次
// update 都写。掉电最坏情况 = 缓存落后几秒，下次启动靠后台对账/补读修正。
const INDEX_CACHE_WRITE_DEBOUNCE_MS = 5000;

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export class SessionRegistry {
  /**
   * @param {number} keepFiles 保留最近多少个会话记录文件；**0 = 不限制**。
   *   注意：不能用 `x || 300` 兜底 —— 0 是 falsy 会被误当成"未设置"变回 300，
   *   用户想"取消上限"就永远改不掉。也不能 Math.max(20,…) 强制下限。
   */
  constructor(keepFiles = 0) {
    this.keepFiles = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this.current = new Map(); // id -> session object（运行中的在内存里）
    this.#appliedIndex = new Map();   // attemptKey -> dayKey（全部日账本合并，内存态，不落盘）
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    // ★ 顺序写死（改了就会丢数据/双计）：
    //   迁移 → ensureTelemetryTotals() → 同步加载 #appliedIndex → #loadIndex()
    // 原因：#loadIndex() 内部的僵尸回收会立刻结算，它需要 ①账本已迁移
    // ②totals 可读（否则写出只含本次增量的 partial totals）③全局索引已在内存里
    // （否则 23:59 写完账本、会话文件未写、次日用旧 mtime 结算时会双计）。
    this.#migrateUsageTodayToLedger();
    try {
      ensureTelemetryTotals((m) => console.log(m));
    } catch (e) {
      // ensure 失败：禁用本次运行的 telemetry 增量写入，账本照常
      this.#telemetryDisabled = true;
      console.error('[usage] telemetry totals 初始化失败，本次运行不写遥测:', e?.message ?? e);
    }
    this.#loadAppliedIndex();
    this.#loadIndex();
    // 索引就绪后再补两件收尾：先补写失败的账，再补记 P0-01 留下的 accountPending 僵尸
    this.#flushUsagePending();
    this.#scanAccountPending();
  }

  /** 全局 attempt 索引（attemptKey → dayKey）；只用于“这次 attempt 记过没有”。 */
  #appliedIndex;
  /** telemetry 增量是否可用（ensureTelemetryTotals 失败时置 true 禁用）。 */
  #telemetryDisabled = false;
  /** #flushUsagePending 重入保护：flush 内部写账成功不得递归触发 flush。 */
  #flushingPending = false;

  /**
   * 运行时改保留上限（配置里改了 keepSessionFiles 要立即生效）。
   * 原来是"只在构造时读一次"，导致用户在设置页改了这个值后，
   * 要重启才生效 —— 磁盘上的会话文件会一直按旧值（默认 0 = 不限）增长。
   */
  setKeepFiles(keepFiles) {
    const next = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.keepFiles = next;
    if (next > 0) {
      this.index = this.index.slice(0, next);
      this.#pruneFiles();
    }
    this.#scheduleIndexCacheWrite(0);
  }

  /** 按 keepFiles 清理磁盘上的旧会话文件（保留最新 N 个）。 */
  #pruneFiles() {
    if (!(this.keepFiles > 0)) return;
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      // 运行中/等待中的会话文件不在删除范围：UI 还指着它，删了会出现"详情 404"
      const activeIds = new Set(
        [...(this.current?.values?.() ?? [])].map((s) => String(s?.id ?? '')).filter(Boolean)
      );
      for (const f of files.slice(this.keepFiles)) {
        if (activeIds.has(f.replace(/\.json$/, ''))) continue;
        try { fs.rmSync(path.join(SESSIONS_DIR, f), { force: true }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  #loadIndex() {
    const t0 = Date.now();   // 快/慢路径共用的计时起点（必须在 let diskFiles 之前）
    // ── 快路径：读索引缓存（单文件，毫秒级）──
    // 缓存条目 = 磁盘上全部会话的 summary；启动直接用它当 this.index，
    // 后台再异步对账（reconcileInBackground）修正差异（外部删文件/
    // 缓存写坏/版本变更）。任何缓存问题都会在几秒后被真值覆盖。
    let diskFiles = null;
    try {
      diskFiles = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
    } catch { /* 目录还没建 */ }
    if (diskFiles) {
      const cached = this.#readIndexCache();
      if (cached && Array.isArray(cached.entries)) {
        // 候选集完全由「磁盘文件 − 缓存条目」推导：不再全量 stat、不再按最近 3 天二次读。
        const diskSet = new Set(diskFiles);
        // 只保留磁盘上确实存在的条目（外部删了文件/清理脚本跑过）
        this.index = cached.entries.filter((e) => diskSet.has(`${e.id}.json`));
        const cachedEntries = this.index;
        let cachedCount = cachedEntries.length;   // 补 missing 前的条目数（重建分支会置 0）
        const cachedIdSet = new Set(cachedEntries.map((e) => e?.id).filter(Boolean));
        // 磁盘上有、缓存里没有的文件（缓存之后新产生的 / 运行中从未进缓存的）→ 补读
        const missing = diskFiles.filter((f) => !cachedIdSet.has(f.replace(/\.json$/, '')));
        let logMissing = missing.length;          // 快路径日志用缓存缺失数
        let dirty = false;
        let skipped = 0;
        let reclaimed = 0;
        let suspicious = [];                      // 必须在 if/else 之前声明，日志要用
        if (missing.length > 200) {
          // 大量缺失（换数据目录/缓存超老）：直接走慢路径全量读
          this.index = [];
          const r = this.#loadAll(diskFiles);     // 内部 upsert=false
          skipped += r.skipped;
          reclaimed += r.reclaimed;
          dirty = true;                           // 慢路径已经重建索引，必须写缓存
          cachedCount = 0;                        // 缓存已被丢弃，日志 cached=0
          logMissing = diskFiles.length;          // 重建后 missing 是全量磁盘文件数
        } else {
          for (const f of missing) {
            const r = this.#loadOne(f, /* zombieScan */ true, /* upsert */ true);
            if (!r.ok) skipped += 1;              // 坏 JSON / 无 id
            else { dirty = true; if (r.reclaimed) reclaimed += 1; }
          }
          // 防御性重读：缓存里残留的 running/waiting（旧版本写进缓存、又不在任何
          // 窗口内）逐个重读；正常情况该集合为空，成本接近 0。
          suspicious = this.index.filter((e) => e.status === 'running' || e.status === 'waiting');
          for (const e of suspicious) {
            const r = this.#loadOne(`${e.id}.json`, true, true);
            if (!r.ok) {
              skipped += 1;
              // 重读失败：清掉无法重读的旧 running/waiting，避免残留与公式偏小
              this.index = this.index.filter((x) => x.id !== e.id);
              dirty = true;
            } else { dirty = true; if (r.reclaimed) reclaimed += 1; }
          }
          this.#sortIndex();
        }
        // 只有实际改变索引（missing/回收/慢路径）才写缓存；坏文件只计数，不触发写
        if (dirty) this.#writeIndexCache();
        console.log(`[sessions] disk=${diskFiles.length} cached=${cachedCount} missing=${logMissing} suspicious=${suspicious.length} reclaimed=${reclaimed} skipped=${skipped} elapsed=${Date.now() - t0}ms`);
        return;
      }
    }
    // ── 慢路径：无缓存（首次/缓存损坏）── 全量读 + 写缓存
    if (diskFiles) {
      this.index = [];
      const r = this.#loadAll(diskFiles);
      console.log(`[sessions] disk=${diskFiles.length} cached=0 missing=${diskFiles.length} suspicious=0 reclaimed=${r.reclaimed} skipped=${r.skipped} elapsed=${Date.now() - t0}ms`);
    }
    this.#writeIndexCache();
  }

  /** 全量读磁盘文件建索引（慢路径），顺带回收僵尸；返回 {skipped, reclaimed}。 */
  #loadAll(diskFiles) {
    let skipped = 0;
    let reclaimed = 0;
    for (const f of diskFiles) {
      const r = this.#loadOne(f, /* zombieScan */ true, /* upsert */ false);
      if (!r.ok) skipped += 1;
      else if (r.reclaimed) reclaimed += 1;
    }
    this.#sortIndex();
    return { skipped, reclaimed };
  }

  /**
   * 读单个会话文件进索引。zombieScan=true 时顺带做僵尸回收写回；
   * upsert=true 时按 id 替换已有条目（单点重读），false 时直接 push（全量读，O(1)）。
   * @returns {{ok:boolean, reclaimed:boolean}}
   */
  #loadOne(file, zombieScan, upsert = false) {
    let reclaimed = false;   // ★ 必须是本方法第一条语句（在 try 之外）：僵尸分支会置 true
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      if (!data?.id) return { ok: false, reclaimed: false };
      if (zombieScan && (data.status === 'running' || data.status === 'waiting')) {
        // 僵尸会话回收：进程上次退出时正在运行/等待的会话，运行循环已不存在，
        // 状态却停留在 running/waiting —— UI 里既不结束也无法中止（中止按钮
        // 找不到活对象）。这里启动即改判 aborted 并写回文件，让会话页能看到
        // 真实状态。不改内存 current（启动时它是空的，这些会话本来就不在其中）。
        let mt = 0;   // 取不到 mtime 就回退 now（mt=0 必然小于 startedAt）
        try { mt = Math.floor(fs.statSync(path.join(SESSIONS_DIR, file)).mtimeMs); } catch { /* ignore */ }
        const startedAt = Number(data.startedAt) || 0;
        const now = Date.now();
        const prevEnded = Number(data.endedAt) || 0;
        data.status = 'aborted';
        // endedAt 顺序：有效 data.endedAt → 有效 mtime → now（都必须落在 [startedAt, now]）
        data.endedAt = (prevEnded >= startedAt && prevEnded <= now)
          ? prevEnded
          : (mt >= startedAt && mt <= now ? mt : now);
        data.abortedOnBoot = true;   // 标记来源，UI/排障能分清"用户中止"和"重启遗留"
        data.accountPending = true;  // P0-01 留痕；P0-04 补记成功后清 false
        if (!Number.isFinite(Number(data.attemptSeq))) data.attemptSeq = 0;
        reclaimed = true;            // 供 #loadOne 返回值与启动日志计数
        // ★ 先记账、后写回：记账需要 messages（telemetry 的 calls/toolCounts 从这里统计），
        //   而 guard 之后的 endedAt 决定归到哪一天 —— 两者都在写回之前。
        try {
          if (this.#accountSessionUsage(data, data.endedAt)) data.accountPending = false;
        } catch { /* 记账失败：accountPending 保留，pending 队列已在内部处理 */ }
        try { atomicWriteJson(file, data); } catch { /* 写不回就只改内存视图 */ }
      }
      const summary = this.#summary(data);
      if (upsert) {
        const i = this.index.findIndex((e) => e.id === summary.id);
        if (i >= 0) { this.index[i] = summary; return { ok: true, reclaimed }; }
      }
      this.index.push(summary);      // upsert=false 走这里，O(1)
      return { ok: true, reclaimed };
    } catch { return { ok: false, reclaimed: false }; }   // 坏 JSON / 读失败
  }

  #sortIndex() {
    this.index.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  /** 读索引缓存；版本不匹配/损坏返回 null。 */
  #readIndexCache() {
    try {
      const data = JSON.parse(fs.readFileSync(INDEX_CACHE_FILE, 'utf8'));
      if (data?.version === INDEX_CACHE_VERSION && Array.isArray(data.entries)) return data;
    } catch { /* 无缓存/坏缓存 */ }
    return null;
  }

  /** 写索引缓存（写前剔除运行中的：它们还没落成最终态，写进去是过期视图）。 */
  #writeIndexCache() {
    try {
      const currentIds = new Set(this.current.keys());
      const entries = this.index.filter((e) => !currentIds.has(e.id));
      const tmp = `${INDEX_CACHE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: INDEX_CACHE_VERSION, savedAt: Date.now(), entries }), 'utf8');
      fs.renameSync(tmp, INDEX_CACHE_FILE);
    } catch { /* 写缓存失败不影响功能 */ }
  }

  /**
   * 防抖写缓存：索引有变动时调这个，而不是直接 #writeIndexCache ——
   * 运行中的会话每次 update 都会改索引条目，逐次写 0.5MB 同步 IO 太亏。
   * flushIndexCache()（进程退出前）会立刻落盘。
   */
  #scheduleIndexCacheWrite(delay = INDEX_CACHE_WRITE_DEBOUNCE_MS) {
    if (this.#indexCacheTimer) clearTimeout(this.#indexCacheTimer);
    this.#indexCacheTimer = setTimeout(() => {
      this.#indexCacheTimer = null;
      this.#writeIndexCache();
    }, delay);
    this.#indexCacheTimer.unref?.();
  }
  #indexCacheTimer = null;

  /** 立即落盘缓存（stop() 调用；清掉防抖定时器当场写）。 */
  flushIndexCache() {
    if (this.#indexCacheTimer) { clearTimeout(this.#indexCacheTimer); this.#indexCacheTimer = null; }
    this.#writeIndexCache();
  }

  /**
   * 退出结算（P0-05）：把 `current` 里还没收尾的会话全部按 `aborted` 结算掉。
   *
   * **复用 `finish()`**：它做的正是“设终态 + endedAt + 移出 current + 清节流时间戳
   * + 落盘 + 更新索引 + 调度缓存写入”，按 §6.3 改造后还内含 `#accountSessionUsage`。
   * 自己再写一遍等于复制 20 行容易漂移的逻辑（尤其是“先 delete 再记账”的顺序）。
   *
   * - 零消耗的 waiting 也走 `finish(id,'aborted')`：改判 aborted、**保留文件**、
   *   记一次零 token 的 attempt。**不调用 `discard`**（那是 UI 删除链路，会删文件）。
   * - 不传 `Date.now()`：`finish` 内部自己设 `endedAt`，本来就是退出时刻。
   * - 单条异常不阻断退出；账本层已保证 never-throw，这里只兜底磁盘/索引异常。
   * - 幂等：第二次调用时 `current` 已空 → 返回 0。
   *
   * ⚠️ 与 `#flushUsagePending()` 是两件事：那个只按 pending 快照补写账本，
   *    这个是把会话本身结算掉。不要合并、不要互调。
   *
   * @returns {number} 结算条数
   */
  flushPending() {
    if (this._flushing) return 0;
    this._flushing = true;
    try {
      let settled = 0;
      for (const [id] of [...this.current]) {
        try {
          if (this.finish(id, 'aborted')) settled += 1;
        } catch (error) {
          console.error(`[sessions] flushPending ${id} 失败:`, error?.message ?? error);
        }
      }
      console.log(`[sessions] flushPending settled=${settled}`);
      return settled;
    } finally {
      this._flushing = false;
    }
  }

  /**
   * 让某条会话的索引缓存条目失效（重试复用 id 时调用）。
   * 写缓存前会自动剔除 current 里的会话，所以调用方只要先把该 id 放进 current，
   * 这一写就等于删掉它的旧终态条目；崩溃后该 id 会落进 missing 被重读。
   */
  invalidateIndexCacheEntry(id) {
    this.#writeIndexCache();
    console.log(`[sessions] index-cache invalidated for ${id}`);
  }

  /**
   * 后台对账：异步全量重扫磁盘，修正缓存路径可能漏掉的差异
   * （运行中被外部删文件、缓存写入竞态等）。启动毫秒级返回，对账在
   * 事件循环空闲时进行，不阻塞请求。
   * @returns {Promise<void>} 完成时 resolve（供测试等待）
   */
  reconcileInBackground() {
    if (this.#reconcileStarted) return Promise.resolve();
    this.#reconcileStarted = true;
    return new Promise((resolve) => {
      setImmediate(() => {
        try {
          const diskFiles = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
          const known = new Set(this.index.map((e) => `${e.id}.json`));
          let changed = false;
          for (const f of diskFiles) {
            if (known.has(f)) continue;
            // 缓存里没有的新文件（上一进程运行后期产生的）
            this.#loadOne(f, /* zombieScan */ true, /* upsert */ true);
            changed = true;
          }
          // 缓存里有、磁盘上没有的（外部删除）→ 摘掉
          const diskSet = new Set(diskFiles);
          const filtered = this.index.filter((e) => diskSet.has(`${e.id}.json`));
          if (filtered.length !== this.index.length) { this.index = filtered; changed = true; }
          if (changed) {
            this.#sortIndex();
            this.#writeIndexCache();
          }
        } catch { /* 对账失败保持现状 */ }
        resolve();
      });
    });
  }
  #reconcileStarted = false;

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // waiting | running | done | noreply | error | aborted
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      webSearchCount: s.webSearchCount ?? 0,
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      trigger: s.triggerSummary ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0,
      // P0-01：启动回收僵尸时置 true，P0-04 补记成功后清 false。
      // 必须进摘要，否则 P0-04 启动补记得全量扫描 1.6 万个文件。
      accountPending: s.accountPending === true
    };
  }

  create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status,
      waitUntil,
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      model: '',
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 },
      // ── P0-04 幂等基线（只追加字段，不改旧读取方）──
      attemptSeq: 0,                 // create 时为 0；每次重试 +1
      accountedUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 },
      accountedRuns: 0,              // 本 attempt 是否已记过 runs
      accountedWebSearchCount: 0,    // 本 attempt 已写入账本的联网搜索次数基线
      accountPending: false          // 启动回收僵尸时置 true，补记成功后清 false
    };
    this.current.set(session.id, session);
    this.#persist(session);
    this.index.unshift(this.#summary(session));
    if (this.keepFiles > 0) this.index = this.index.slice(0, this.keepFiles);
    this.#scheduleIndexCacheWrite();
    return session;
  }

  get(id) {
    if (this.current.has(id)) {
      const s = this.current.get(id);
      return structuredClone(s);
    }
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 不克隆的读取：**只用于"读出来马上序列化"的热路径**（如 SSE 广播）。
   * 运行中的会话每次 session-update 都要走一次，get() 的 structuredClone
   * 会把整个会话（含每轮 raw 响应）全量复制一遍 —— 纯序列化用不到这份拷贝。
   * ⚠️ 返回的是活对象，调用方绝对不能改它；要改请用 get()。
   */
  peek(id) {
    if (this.current.has(id)) return this.current.get(id);
    try {
      return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
    } catch {
      return null;
    }
  }

  update(id) {
    const s = this.current.get(id);
    if (s) {
      this.#persistThrottled(s);
      const idx = this.index.findIndex((e) => e.id === id);
      if (idx >= 0) this.index[idx] = this.#summary(s);
    }
    return s ?? null;
  }

  /** 设置运行中的活动状态（思考/调用工具）并广播。 */
  setActivity(id, activity) {
    const s = this.current.get(id);
    if (!s) return null;
    s.activity = String(activity ?? '');
    this.update(id);
    return s;
  }

  finish(id, status) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    // 必须先移出 current 再记账：todayUsage() 会把 current 里活会话的 usage
    // 实时叠加到账本上，会话还在 current 时记账会让页面看到“账本 + 实时”双份。
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // 节流时间戳随会话结束清理，防止 map 无限增长
    // ★ 传 s.endedAt 而不是 Date.now()：跨零点那一刻（23:59:59.998 结束、
    //   记账时已过 00:00:00.001）必须归到“结束日”，这是本单的核心修复。
    this.#accountSessionUsage(s, s.endedAt);
    this.#persist(s);                  // 只写文件；记账已从 #persist 里拆出
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = this.#summary(s);
    this.#scheduleIndexCacheWrite();
    // 清理超出保留数的旧文件
    try {
      if (this.keepFiles > 0) {
        const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
        if (files.length > this.keepFiles) {
          for (const f of files.slice(0, files.length - this.keepFiles)) {
            try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
    return s;
  }

  /**
   * 彻底丢弃一个会话：从内存索引移除 + 删掉磁盘文件，**不留"中止"记录**。
   *
   * 用途：档位判定"这次不响应"时，连"等待中"会话都不该出现在会话页
   * （否则用户会看到一堆等半天最后变"中止"的条目，还以为出错了）。
   * 与 finish(id,'aborted') 的区别：finish 是"开始了但没成"，会留下痕迹；
   * 这个是"压根没开始"，干净消失。
   *
   * ⚠️ 只用于从未真正运行过的会话（status='waiting'）。
   *    已经跑过并消耗了 token 的会话要走 finish，别用这个抹掉用量记录。
   */
  discard(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 已运行过的不允许丢弃（会抹掉用量/成本记录，导致对不上账）
    if (s && s.status !== 'waiting') return false;
    this.current.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
    this.#scheduleIndexCacheWrite();
    return this.index.length < before;
  }

  /**
   * 主动删除一条会话记录（含已结束的）。
   * 与 discard 的区别：discard 只允许删"等待中"的（保护用量记录）；
   * remove 是用户主动清理历史，允许删任何状态，但**不删正在运行的**（那会丢账）。
   * @returns {boolean} 是否真的删了
   */
  remove(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 正在运行的会话不能删（usage 还在累加，删了账就乱了）；等待中的可以
    if (s && s.status === 'running') return false;
    this.current.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
    this.#scheduleIndexCacheWrite();
    return this.index.length < before;
  }

  /**
   * 清空全部已结束的会话记录（保留正在运行/等待的）。
   * @returns {number} 删掉了多少条
   */
  clearFinished() {
    const keepIds = new Set();
    for (const [id, s] of this.current) {
      if (s && (s.status === 'running' || s.status === 'waiting')) keepIds.add(id);
    }
    let removed = 0;
    const remaining = [];
    for (const e of this.index) {
      if (keepIds.has(e.id)) { remaining.push(e); continue; }
      removed++;
      try {
        const f = path.join(SESSIONS_DIR, `${e.id}.json`);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
    this.index = remaining;
    this.#scheduleIndexCacheWrite();
    return removed;
  }

  /**
   * 数据保留策略：删除早于 cutoffMs 的已结束会话文件。
   * 运行中/等待中的会话永远保留（UI 还指着它，删了会出现“详情 404”）。
   * @returns {number} 删除的会话文件数
   */
  pruneOlderThan(cutoffMs) {
    if (!(cutoffMs > 0)) return 0;
    const activeIds = new Set(
      [...(this.current?.values?.() ?? [])]
        .filter((s) => s && (s.status === 'running' || s.status === 'waiting'))
        .map((s) => String(s.id))
    );
    let removed = 0;
    const keep = [];
    for (const e of this.index) {
      const ts = Number(e.startedAt) || parseInt(String(e.id || '').split('-')[0], 36) || 0;
      if (activeIds.has(e.id) || !(ts > 0) || ts >= cutoffMs) { keep.push(e); continue; }
      try { fs.rmSync(sessionFile(e.id), { force: true }); } catch { /* ignore */ }
      removed += 1;
    }
    // 索引里没有的孤儿文件（索引缓存损坏/外部拷入）按文件名里的创建时间兜底
    // 只处理"索引里没有"的文件：索引已处理过的不能在这里再删一次；
    // 且 id 必须解析成可信的毫秒时间戳（≥2015 年），避免把非时间戳 id 当成"很旧"删掉。
    const indexed = new Set(this.index.map((e) => String(e.id)));
    try {
      for (const f of fs.readdirSync(SESSIONS_DIR)) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        if (activeIds.has(id) || indexed.has(id)) continue;
        const ts = parseInt(id.split('-')[0], 36);
        if (Number.isFinite(ts) && ts > 1_420_070_400_000 && ts < cutoffMs) {
          try { fs.rmSync(path.join(SESSIONS_DIR, f), { force: true }); removed += 1; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    if (removed) {
      this.index = keep;
      this.#scheduleIndexCacheWrite(0);
    }
    return removed;
  }

  listSummaries(limit = 100) {
    return this.index.slice(0, limit);
  }

  /**
   * 游标分页（P0-02）：让前端首屏只取一页，active 单独返回。
   *
   * - sessions 只含已完成（running/waiting 走 active），避免同一条出现两次；
   * - active 全量返回（数量很少，且首屏必须可见）；
   * - total 含 active，totalFinished = total − active.length 是前端分数分母；
   * - hasMore 按“游标之后还有没有条目”算，不用 sessions.length === limit 猜。
   *
   * @param {{limit?:number, beforeTs?:number|string|null, beforeId?:string|null}} opts
   */
  listPage({ limit = 200, beforeTs = null, beforeId = null } = {}) {
    const rawLimit = limit;
    let n = rawLimit != null ? Number(rawLimit) : 200;
    if (!Number.isFinite(n)) n = 200;
    n = Math.min(1000, Math.max(1, Math.trunc(n)));   // 超过 1000 clamp，小于 1 按 1

    // startedAt 归一化：null/非法一律 0，避免 NaN 比较把排序弄乱
    const tsOf = (e) => Number(e?.startedAt) || 0;
    // ★ 复制后排序：绝不原地改 this.index（update/finish 依赖原数组位置）
    const all = this.index.slice().sort((a, b) => {
      const d = tsOf(b) - tsOf(a);
      if (d) return d;
      const ai = String(a?.id ?? '');
      const bi = String(b?.id ?? '');
      return ai < bi ? 1 : (ai > bi ? -1 : 0);       // 相同 startedAt：id 倒序
    });
    const isActive = (e) => e.status === 'running' || e.status === 'waiting';
    const active = all.filter(isActive);
    const finished = all.filter((e) => !isActive(e));
    const total = all.length;

    let rest = finished;
    // 不要直接 Number(null)：它是 0，会被误当游标；空字符串同理
    const hasBefore = beforeTs != null
      && String(beforeTs).trim() !== ''
      && Number.isFinite(Number(beforeTs));
    if (hasBefore) {
      const bts = Number(beforeTs);
      const bid = beforeId == null || beforeId === '' ? null : String(beforeId);
      rest = finished.filter((e) => {
        const ts = tsOf(e);
        if (ts < bts) return true;
        if (ts > bts) return false;
        return bid == null ? false : String(e.id) < bid;
      });
    }

    const page = rest.slice(0, n);
    const hasMore = rest.length > page.length;
    const last = page[page.length - 1];
    return {
      sessions: page,
      active,
      total,
      totalFinished: finished.length,
      hasMore,
      nextCursor: hasMore && last ? { beforeTs: tsOf(last), beforeId: String(last.id) } : null
    };
  }

  /**
   * 某一天的 token 统计：**读当天账本**，再叠加运行中会话的实时用量。
   *
   * - 叠加只对“今天”生效：查历史日时不得把当前运行中的会话算进去；
   * - 已终态会话在 finish() 里先 `current.delete` 再记账，所以不会“账本 + 实时”双计；
   * - `usage-today.json` 只是给旧代码回滚用的镜像，不再参与这里的读取。
   */
  todayUsage(dayKey) {
    let ledger = null;
    try { ledger = readLedgerStrict(dayKey); } catch { ledger = null; }
    let promptTokens = num(ledger?.promptTokens);
    let completionTokens = num(ledger?.completionTokens);
    let totalTokens = num(ledger?.totalTokens);
    let cachedTokens = num(ledger?.cachedTokens);
    const runs = num(ledger?.runs);
    let webSearchCount = num(ledger?.webSearchCount);
    if (dayKey === localDayKey(Date.now())) {
      for (const s of this.current.values()) {
        const u = s?.usage || {};
        promptTokens += num(u.promptTokens);
        completionTokens += num(u.completionTokens);
        totalTokens += num(u.totalTokens);
        cachedTokens += num(u.cachedTokens);
        webSearchCount += num(s?.webSearchCount);
      }
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs, webSearchCount };
  }

  /**
   * 结算一个 attempt 的用量（P0-04 唯一的公开入口）。
   *
   * `#accountSessionUsage` 是私有方法，`orchestrator.#resetSessionForRetry` 跨类调不到，
   * 所以提供这个一行包装。**必须保持同步**：`retrySession()` 是同步方法，
   * `routes.js` 的 retry 路由直接读返回值，改成 async 会让 `r.ok` 变 undefined。
   * @param {object} s 会话对象（内存活对象或从磁盘读出的副本）
   * @param {number} [dayTs] 归属日的时间戳；默认 `s.endedAt ?? Date.now()`
   */
  settleAttempt(s, dayTs = s?.endedAt ?? Date.now()) {
    return this.#accountSessionUsage(s, dayTs);
  }

  /**
   * 把一个 attempt 的用量写进按天账本（幂等，返回是否已记账）。
   *
   * 幂等键是 `id:attemptSeq` 而不是裸 id：重试会复用同一个 session id，
   * 按 id 判重会把同一天的第二次 attempt 误判为“已记过”。
   *
   * 绝不向上抛：`readLedger` / 写盘异常一律降级为“能入 pending 就入 pending、返回 false”，
   * 否则退出结算会中断、重试接口会 500。
   */
  #accountSessionUsage(s, dayTs) {
    try {
      if (!s || !s.id) return false;
      const usage = s.usage || {};
      const attemptSeq = Number(s.attemptSeq) || 0;
      const attemptKey = `${s.id}:${attemptSeq}`;
      const dayKey = localDayKey(dayTs);
      const searchCount = num(s.webSearchCount);

      // 全局索引优先：覆盖“finish 写了今天账、会话文件没写成、次日 boot 用旧 mtime 结算”
      if (this.#appliedIndex.has(attemptKey)) return true;

      let ledger;
      try {
        ledger = readLedgerStrict(dayKey);
      } catch (e) {
        // 账本读不出来（坏 JSON/权限）：不写、不设基线，按快照入 pending 等下次重试
        console.error(`[usage] 账本读取失败 ${dayKey}: ${e?.message ?? e}`);
        this.#enqueuePending({
          id: s.id, attemptKey, dayTs, usage: snapshotUsage(usage),
          runsDelta: hasConsumption(usage) ? 1 : 0,
          webSearchDelta: searchCount,
          llmCalls: countLlmCalls(s.messages),
          toolCounts: countToolCalls(s.messages)
        });
        return false;
      }
      if (ledger.appliedAttempts.includes(attemptKey)) {   // 索引尚未加载时的兜底
        this.#appliedIndex.set(attemptKey, dayKey);
        return true;
      }

      const llmCalls = countLlmCalls(s.messages);
      const toolCounts = countToolCalls(s.messages);
      const prev = s.accountedUsage;
      let delta;
      let runsDelta;
      let webSearchDelta;

      if (prev == null) {
        // ★ `searchCount > 0` 必须单独判：纯联网搜索、没有任何 token/calls 的会话
        //   （命中了搜索工具但模型调用没计费/被中断）`hasUsage` 返回 false，
        //   会掉进下面的“旧终态只设基线”分支，searchCount 永久丢失。
        //   这类僵尸是真实存在的（2026-11-22 补测发现），不能只按 token 判。
        if (s.abortedOnBoot && (hasUsage(usage) || searchCount > 0)) {
          // 本次 #loadOne 刚回收的僵尸 / accountPending 补记：补记一次
          delta = snapshotUsage(usage);
          runsDelta = hasConsumption(usage) ? 1 : 0;
          webSearchDelta = searchCount;
        } else {
          // 旧终态会话（v1.2 之前）：只设基线，不补记，也不进 pending（没有增量可补）
          ledger.appliedAttempts.push(attemptKey);
          if (!writeLedgerSafe(ledger)) return false;
          this.#appliedIndex.set(attemptKey, dayKey);
          s.accountedUsage = snapshotUsage(usage);
          s.accountedRuns = hasConsumption(usage) ? 1 : 0;
          s.accountedWebSearchCount = searchCount;
          s.accountPending = false;
          return true;
        }
      } else {
        const p = prev;
        delta = {
          promptTokens: nonNeg(num(usage.promptTokens) - num(p.promptTokens)),
          completionTokens: nonNeg(num(usage.completionTokens) - num(p.completionTokens)),
          totalTokens: nonNeg(num(usage.totalTokens) - num(p.totalTokens)),
          cachedTokens: nonNeg(num(usage.cachedTokens) - num(p.cachedTokens)),
          calls: nonNeg(num(usage.calls) - num(p.calls))
        };
        runsDelta = Number(s.accountedRuns) ? 0 : (hasConsumption(usage) ? 1 : 0);
        webSearchDelta = nonNeg(searchCount - num(s.accountedWebSearchCount));
      }

      // 零消耗（calls === 0 && totalTokens === 0）：不计 runs、不加 token，
      // 但 webSearchDelta 仍按差值记，attemptKey 仍要写入 appliedAttempts。
      const zero = (num(usage.calls) === 0 && num(usage.totalTokens) === 0);

      ledger.promptTokens = num(ledger.promptTokens) + (zero ? 0 : delta.promptTokens);
      ledger.completionTokens = num(ledger.completionTokens) + (zero ? 0 : delta.completionTokens);
      ledger.totalTokens = num(ledger.totalTokens) + (zero ? 0 : delta.totalTokens);
      ledger.cachedTokens = num(ledger.cachedTokens) + (zero ? 0 : delta.cachedTokens);
      ledger.runs = num(ledger.runs) + (zero ? 0 : runsDelta);
      ledger.webSearchCount = num(ledger.webSearchCount) + webSearchDelta;
      ledger.llmCalls = num(ledger.llmCalls) + llmCalls;
      if (!ledger.toolCounts || typeof ledger.toolCounts !== 'object') ledger.toolCounts = {};
      for (const [k, v] of Object.entries(toolCounts)) {
        ledger.toolCounts[k] = num(ledger.toolCounts[k]) + v;
      }
      ledger.appliedAttempts.push(attemptKey);

      if (!writeLedgerSafe(ledger)) {
        // 账本没写成：不更新基线、不进全局索引，把快照放进队列等下次补记
        this.#enqueuePending({
          id: s.id, attemptKey, dayTs, usage: snapshotUsage(usage),
          runsDelta: zero ? 0 : runsDelta,
          webSearchDelta, llmCalls, toolCounts
        });
        return false;
      }

      // 账本是权威：先落账，再补三件副作用（任何一个失败都只记日志，不回滚账本）
      this.#pushTelemetry({ calls: llmCalls, usage, toolCounts });
      this.#appliedIndex.set(attemptKey, dayKey);
      mirrorTodayUsage(ledger);
      s.accountedUsage = snapshotUsage(usage);
      s.accountedRuns = hasConsumption(usage) ? 1 : 0;   // 写死当前值，不是 += runsDelta
      s.accountedWebSearchCount = searchCount;
      s.accountPending = false;
      return true;
    } catch (e) {
      console.error('[usage] 记账失败:', e?.message ?? e);
      return false;
    }
  }

  /** telemetry 增量：totals 不可读就跳过本次并记日志（绝不在现场重建）。 */
  #pushTelemetry({ calls, usage, toolCounts }) {
    if (this.#telemetryDisabled) return;
    try {
      const ok = addTelemetryDelta({
        calls,
        promptTokens: num(usage.promptTokens),
        completionTokens: num(usage.completionTokens),
        totalTokens: num(usage.totalTokens),
        toolCounts
      });
      if (!ok) console.warn('[usage] telemetry totals 不可读，本次跳过遥测增量（账本已写）');
    } catch (e) {
      console.error('[usage] telemetry 累加失败:', e?.message ?? e);
    }
  }

  /**
   * 启动迁移：把旧的 `usage-today.json` 转成对应日的账本。
   *
   * 判断依据是 **`usage-today.dayKey` 对应的日账本是否存在**，不是“账本目录是否存在”
   * —— 目录里只有旧日账本时，今天仍然要迁移。
   * 已有同名日账本不覆盖，只记日志跳过。
   */
  #migrateUsageTodayToLedger() {
    try {
      let legacy;
      try { legacy = JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8')); } catch { return; }  // 无旧文件
      const dayKey = String(legacy?.dayKey || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return;
      try {
        if (fs.existsSync(path.join(LEDGER_DIR, `${dayKey}.json`))) {
          console.log(`[usage] 账本已存在，跳过迁移 ${dayKey}`);
          return;
        }
      } catch { /* 目录读不到：按不存在处理，写账时自会建目录 */ }
      const ledger = emptyLedger(dayKey);
      ledger.promptTokens = num(legacy.promptTokens);
      ledger.completionTokens = num(legacy.completionTokens);
      ledger.totalTokens = num(legacy.totalTokens);
      ledger.cachedTokens = num(legacy.cachedTokens);
      ledger.runs = num(legacy.runs);
      ledger.webSearchCount = num(legacy.webSearchCount);
      // 旧文件没有 llmCalls/toolCounts，迁移不补算（补算会把已进账的 attempt 再算一遍）
      ledger.llmCalls = 0;
      ledger.toolCounts = {};
      ledger.appliedAttempts = [];
      ledger.migratedFrom = 'usage-today.json';
      ledger.llmCallsComplete = false;
      writeLedger(ledger);
      console.log(`[usage] 已迁移 usage-today.json(${dayKey}) → usage-ledger/${dayKey}.json`);
    } catch (e) {
      console.error('[usage] 账本迁移失败（不影响启动）:', e?.message ?? e);
    }
  }

  /** 把全部日账本的 appliedAttempts 合并进内存索引（必须在 #loadIndex 之前）。 */
  #loadAppliedIndex() {
    this.#appliedIndex = new Map();
    let files = [];
    try { files = fs.readdirSync(LEDGER_DIR).filter((f) => f.endsWith('.json')); } catch { return; }
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, f), 'utf8'));
        const day = String(d?.day || f.replace(/\.json$/, ''));
        const list = Array.isArray(d?.appliedAttempts) ? d.appliedAttempts : [];
        for (const k of list) if (k) this.#appliedIndex.set(String(k), day);
      } catch (e) {
        console.error(`[usage] 账本读取失败，已跳过 ${f}: ${e?.message ?? e}`);
      }
    }
  }

  /**
   * 补写失败的账（`data/usage-pending.json`）。
   *
   * ⚠️ 与 P0-05 的 `flushPending()` 是**两个东西**：那个是把未 finish 的会话结算掉，
   * 这个只按队列里的用量快照直接写账本。不要合并、不要互相调用。
   *
   * @returns {number} 本次成功补写的条数
   */
  #flushUsagePending() {
    if (this.#flushingPending) return 0;   // flush 内部写账成功不得递归触发 flush
    this.#flushingPending = true;
    try {
      let arr;
      try { arr = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return 0; }
      if (!Array.isArray(arr) || !arr.length) return 0;
      const keep = [];
      let applied = 0;
      for (const item of arr) {
        if (!item || !item.attemptKey) continue;
        let ok = false;
        try {
          ok = this.#writeLedgerItem(item);
        } catch (e) {
          console.error('[usage] pending 补写失败:', e?.message ?? e);
        }
        if (ok) applied += 1;
        else keep.push(item);
      }
      writePendingFile(keep);
      if (applied) console.log(`[usage] pending 补写成功 ${applied} 条，剩余 ${keep.length} 条`);
      return applied;
    } catch (e) {
      console.error('[usage] pending flush 异常:', e?.message ?? e);
      return 0;
    } finally {
      this.#flushingPending = false;
    }
  }

  /**
   * 按快照写一条账（payload 来自 pending 队列，没有会话对象可重算 delta）。
   * 成功返回 true，并补齐 telemetry / 全局索引 / 今天镜像三个副作用。
   */
  #writeLedgerItem(item) {
    const dayKey = localDayKey(item.dayTs);
    if (this.#appliedIndex.has(item.attemptKey)) return true;   // 已记过 → 直接丢弃该项
    const ledger = readLedgerStrict(dayKey);
    if (ledger.appliedAttempts.includes(item.attemptKey)) {
      this.#appliedIndex.set(item.attemptKey, dayKey);
      return true;
    }
    const usage = item.usage || {};
    ledger.promptTokens = num(ledger.promptTokens) + num(usage.promptTokens);
    ledger.completionTokens = num(ledger.completionTokens) + num(usage.completionTokens);
    ledger.totalTokens = num(ledger.totalTokens) + num(usage.totalTokens);
    ledger.cachedTokens = num(ledger.cachedTokens) + num(usage.cachedTokens);
    ledger.runs = num(ledger.runs) + num(item.runsDelta);
    ledger.webSearchCount = num(ledger.webSearchCount) + num(item.webSearchDelta);
    ledger.llmCalls = num(ledger.llmCalls) + num(item.llmCalls);
    if (!ledger.toolCounts || typeof ledger.toolCounts !== 'object') ledger.toolCounts = {};
    for (const [k, v] of Object.entries(item.toolCounts && typeof item.toolCounts === 'object' ? item.toolCounts : {})) {
      ledger.toolCounts[k] = num(ledger.toolCounts[k]) + num(v);
    }
    ledger.appliedAttempts.push(item.attemptKey);
    writeLedger(ledger);   // 失败直接抛，由调用方保留队列项

    // 三副作用：calls/toolCounts 来自快照，不从 usage 重算
    this.#pushTelemetry({ calls: num(item.llmCalls), usage, toolCounts: item.toolCounts || {} });
    this.#appliedIndex.set(item.attemptKey, dayKey);
    mirrorTodayUsage(ledger);   // 内部判断“只写今天”
    return true;
  }

  /** 写账失败时按 attemptKey 去重入队（存用量快照，不存 id）。 */
  #enqueuePending(item) {
    try {
      let arr = [];
      try {
        const d = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
        if (Array.isArray(d)) arr = d;
      } catch { /* 无队列/坏队列：重建 */ }
      if (arr.some((x) => x && x.attemptKey === item.attemptKey)) return;
      arr.push(item);
      if (arr.length > PENDING_LIMIT) {
        // FIFO 淘汰最旧，保留最新 1000 条；淘汰必须告警（最多列 10 个 key）
        const dropped = arr.slice(0, arr.length - PENDING_LIMIT);
        arr = arr.slice(arr.length - PENDING_LIMIT);
        const keys = dropped.slice(0, 10).map((x) => x?.attemptKey).filter(Boolean).join(', ');
        console.warn(`[usage] pending 队列溢出，淘汰 ${dropped.length} 条 attempt：${keys}${dropped.length > 10 ? ' …' : ''}（其中已终态的会话需人工核对）`);
      }
      writePendingFile(arr);
    } catch (e) {
      console.error('[usage] pending 入队失败:', e?.message ?? e);
    }
  }

  /**
   * 补记 P0-01 留下的 `accountPending` 僵尸。
   *
   * 只扫索引里带标记的条目（通常个位数），不遍历 1.6 万个终态文件。
   * 成功后必须同时清三处：会话文件、`this.index` 的 summary、索引缓存 ——
   * 只清文件会让缓存一直为 true，下次启动重复扫描，关机写缓存还可能覆盖回 true。
   */
  #scanAccountPending() {
    const targets = this.index.filter((e) => e.accountPending === true);
    if (!targets.length) return 0;
    let done = 0;
    for (const e of targets) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${e.id}.json`), 'utf8'));
        if (!data?.id) continue;
        if (data.accountPending !== true) {
          // 文件已清、索引仍旧：直接同步索引
          const i = this.index.findIndex((x) => x.id === e.id);
          if (i >= 0) this.index[i] = this.#summary(data);
          done += 1;
          continue;
        }
        if (data.attemptSeq == null) data.attemptSeq = 0;
        if (!this.#accountSessionUsage(data, data.endedAt ?? Date.now())) continue;
        data.accountPending = false;
        try { atomicWriteJson(`${e.id}.json`, data); } catch (err) {
          console.error(`[usage] accountPending 标记写回失败 ${e.id}:`, err?.message ?? err);
        }
        const i = this.index.findIndex((x) => x.id === e.id);
        if (i >= 0) this.index[i] = this.#summary(data);
        done += 1;
      } catch (err) {
        console.error(`[usage] accountPending 补记失败 ${e.id}:`, err?.message ?? err);
      }
    }
    if (done) this.#scheduleIndexCacheWrite(0);
    if (done) console.log(`[usage] accountPending 补记完成 ${done} 条`);
    return done;
  }

  /**
   * 运行中会话的落盘节流：每个会话 2 秒内最多写一次盘。
   *
   * 曾经 update() 每次都 #persist —— activity 翻转（每轮 2 次）、每个工具调用
   * 都会同步 writeFileSync 整个会话 JSON（含提示词与所有消息，越跑越大）。
   * 同步写盘阻塞 event loop，排在后面的 SSE 广播/HTTP 响应全被拖慢。
   *
   * 可靠性：finish() 仍走 #persist 直接落最终态，所以留档完整性不变；
   * 代价是进程崩溃时最多丢 2 秒的运行中进度（索引摘要不受影响，在内存里）。
   */
  #persistThrottled(s) {
    const now = Date.now();
    this._lastPersistAt ||= new Map();
    const last = this._lastPersistAt.get(s.id) || 0;
    if (now - last < 2000) return;
    this._lastPersistAt.set(s.id, now);
    this.#persist(s);
  }

  #persist(s) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const tmp = `${sessionFile(s.id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
      fs.renameSync(tmp, sessionFile(s.id));
      // 记账已从持久化里拆出（见 finish()/#accountSessionUsage）：
      // 再留一份“写文件时顺手记账”的实现，等于留第二个写账本的地方。
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
    }
  }
}

function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── 用量账本的小工具（P0-04）──────────────────────────────────────────────
const num = (x) => Number(x) || 0;
const nonNeg = (x) => (x > 0 ? x : 0);

/** 用量快照：只取这 5 个字段，避免把会话上的临时属性写进账本/队列。 */
function snapshotUsage(u) {
  const x = u || {};
  return {
    promptTokens: num(x.promptTokens),
    completionTokens: num(x.completionTokens),
    totalTokens: num(x.totalTokens),
    cachedTokens: num(x.cachedTokens),
    calls: num(x.calls)
  };
}

/** 有 token 用量（僵尸补记的判定）。 */
function hasUsage(u) {
  const x = u || {};
  return num(x.totalTokens) > 0 || num(x.promptTokens) > 0 || num(x.completionTokens) > 0 || num(x.calls) > 0;
}

/** 有消耗（`runs` 只在它为 true 时 +1）。 */
function hasConsumption(u) {
  const x = u || {};
  return num(x.calls) > 0 || num(x.totalTokens) > 0;
}

/** LLM 调用次数（与用量页同口径：带 token 用量的 raw 条目数）。 */
function countLlmCalls(messages) {
  let n = 0;
  for (const m of (messages || [])) {
    const ru = m?.raw?.usage || {};
    if (num(ru.prompt_tokens) + num(ru.completion_tokens) > 0) n += 1;
  }
  return n;
}

/** 工具调用明细：按消息里的 toolCall 逐个点名一次（与用量页同一口径）。 */
function countToolCalls(messages) {
  const out = {};
  for (const m of (messages || [])) {
    const name = m?.toolCall?.name;
    if (name) out[String(name)] = (out[String(name)] || 0) + 1;
  }
  return out;
}

function emptyLedger(dayKey) {
  return {
    version: LEDGER_VERSION,
    day: dayKey,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    runs: 0,
    webSearchCount: 0,
    llmCalls: 0,
    toolCounts: {},
    appliedAttempts: []
  };
}

/**
 * 读某个日账本。
 * - 文件不存在 → 返回空账本（首次写账）；
 * - 文件存在但读/解析失败 → **抛出**，由调用方降级成 pending；
 *   绝不能在这里静默返回空账本 —— 那会用一份新账覆盖掉坏文件里的历史数据。
 */
function readLedgerStrict(dayKey) {
  let txt;
  try {
    txt = fs.readFileSync(path.join(LEDGER_DIR, `${dayKey}.json`), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return emptyLedger(dayKey);
    throw e;
  }
  const d = JSON.parse(txt);
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('账本结构非法');
  // ★ 就地补齐缺失字段并原样保留未知字段：按 schema 重建对象会把
  //   migratedFrom / llmCallsComplete 之类的元字段写丢。
  if (!d.day) d.day = dayKey;
  if (!Number.isFinite(Number(d.version))) d.version = LEDGER_VERSION;
  if (!Array.isArray(d.appliedAttempts)) d.appliedAttempts = [];
  if (!d.toolCounts || typeof d.toolCounts !== 'object') d.toolCounts = {};
  return d;
}

/** 同步 read-modify-write 落盘（临时文件 + rename）。失败抛给调用方。 */
function writeLedger(ledger) {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  const f = path.join(LEDGER_DIR, `${ledger.day}.json`);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger), 'utf8');
  fs.renameSync(tmp, f);
}

/** writeLedger 的不抛版本。 */
function writeLedgerSafe(ledger) {
  try { writeLedger(ledger); return true; } catch (e) {
    console.error(`[usage] 账本写入失败 ${ledger?.day ?? '?'}:`, e?.message ?? e);
    return false;
  }
}

function writePendingFile(arr) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${PENDING_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arr), 'utf8');
    fs.renameSync(tmp, PENDING_FILE);
  } catch (e) {
    console.error('[usage] pending 队列写入失败:', e?.message ?? e);
  }
}

/**
 * `usage-today.json` 兼容镜像：**只写今天**，内容是刚写入账本的全量字段快照
 * （不是本次 delta）。旧日补记/跨零点收尾一律跳过，否则会把昨天的数字写进今天。
 */
function mirrorTodayUsage(ledger) {
  try {
    const dayKey = ledger?.day;
    if (!dayKey || dayKey !== localDayKey(Date.now())) return;
    const snap = {
      dayKey,
      promptTokens: num(ledger.promptTokens),
      completionTokens: num(ledger.completionTokens),
      totalTokens: num(ledger.totalTokens),
      cachedTokens: num(ledger.cachedTokens),
      runs: num(ledger.runs),
      webSearchCount: num(ledger.webSearchCount)
    };
    const tmp = `${MIRROR_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap), 'utf8');
    fs.renameSync(tmp, MIRROR_FILE);
  } catch (e) {
    console.error('[usage] usage-today 镜像写入失败:', e?.message ?? e);
  }
}

/**
 * 原子写一个会话文件：先写同目录 tmp，再 rename 覆盖。
 * 不用 writeFileSync 直接覆盖——写到一半崩溃会留下半截 JSON，
 * 下次启动会被当成坏文件跳过（会话直接从列表消失）。
 */
function atomicWriteJson(file, data) {
  const full = path.join(SESSIONS_DIR, file);
  const tmp = `${full}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, full);
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}
