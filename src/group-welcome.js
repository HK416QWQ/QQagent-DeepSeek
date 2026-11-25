// 群入群欢迎：3 秒合并 → 守卫 → at 前 5 人 → 三条中性模板随机一条 → 交给 SendQueue
// → 成功后 best-effort 追加一个固定收藏表情（失败不影响欢迎与防重）。
//
// 刻意**不** import config.js / store.js / sender.js：
//   · 白名单、禁言、暂停全部由 app.js 以函数注入，模块自己不读全局配置；
//   · 防重状态由 app.js 用 initialSeen / persistSeen 注入，模块自己不碰文件；
//   · 好处是单测可以静态 import 它，不会提前锁死 DATA_DIR。
// 唯一允许的依赖是 node:crypto（算防重键）。
import { createHash } from 'node:crypto';

export const WELCOME_DEBOUNCE_MS = 3000;       // 首个事件起算，不从最后一个事件重置
export const WELCOME_MAX_ATS = 5;              // 一条最多 at 5 人
export const WELCOME_USER_TTL_MS = 3 * 60 * 1000;  // 同一群同一 QQ 3 分钟内不重复欢迎（仅成功发送后记）
// 固定收藏表情“探头 可爱”；只查本地库，缺失时跳过，不为欢迎触发网络同步。
export const WELCOME_STICKER_ID = '00000000_0_0_0_00000000000000000000000000000000_0_0';
export const WELCOME_SEEN_MAX = 2000;          // 持久化防重表的全局硬上限
export const WELCOME_SEEN_KEY_HEX_LEN = 32;    // SHA-256 截断到 128 位 = 32 个十六进制字符

// 群号 / QQ 号统一口径：正整数。不能写 Number(x) <= 0 —— 那会放过 '0456'、'0123'、'1e3'。
const POSITIVE_INT_RE = /^[1-9]\d*$/;

export const WELCOME_VARIANTS = [
  {
    id: 1,
    short: '欢迎加入～我是鲸鲸，一只可爱的鲸鱼娘。有问题可以随时问我呀～',
    many: (n) => `欢迎${n}位新朋友加入～我是鲸鲸，一只可爱的鲸鱼娘。有问题可以随时问我呀～`
  },
  {
    id: 2,
    short: '新朋友来啦～我是鲸鲸，平时在群里摸鱼。最讨厌别人叫我大肥鱼。有问题随时来问我哦～',
    many: (n) => `有${n}位新朋友来啦～我是鲸鲸，平时在群里摸鱼。最讨厌别人叫我大肥鱼。有问题随时来问我哦～`
  },
  {
    id: 3,
    short: '欢迎欢迎～我是鲸鲸，偶尔慢半拍。最喜欢吃白饭。有问题可以随时问我呀～',
    many: (n) => `欢迎${n}位新朋友加入～我是鲸鲸，偶尔慢半拍。最喜欢吃白饭。有问题可以随时问我呀～`
  }
];

/** 等概率三选一；纯随机，不记录上次、不做连续重复规避。 */
export function pickVariantIndex(random = Math.random) {
  const r = Number(random());
  const i = Number.isFinite(r) ? Math.floor(r * WELCOME_VARIANTS.length) : 0;
  return Math.max(0, Math.min(WELCOME_VARIANTS.length - 1, i));
}

/** 防重键：SHA-256("群:QQ") 的十六进制，截断到 128 位（32 个字符）。群/QQ 都是纯数字，冒号无歧义。 */
export function seenKey(groupId, userId) {
  return createHash('sha256')
    .update(`${groupId}:${userId}`, 'utf8')
    .digest('hex')
    .slice(0, WELCOME_SEEN_KEY_HEX_LEN);
}

export function isSeenKey(value) {
  return typeof value === 'string'
    && value.length === WELCOME_SEEN_KEY_HEX_LEN
    && /^[0-9a-f]+$/.test(value);
}

/**
 * 原地清理。先删非法/过期项，再把超过 max 的最旧项删掉。
 * 返回值只用于日志和测试，不参与判定。
 */
export function pruneSeen(map, now = Date.now(), ttlMs = WELCOME_USER_TTL_MS, max = WELCOME_SEEN_MAX) {
  let expired = 0;
  let invalid = 0;
  let evicted = 0;
  for (const [key, ts] of map) {
    if (!isSeenKey(key) || !Number.isFinite(ts) || ts <= 0) {
      map.delete(key);
      invalid += 1;
    } else if (now - ts >= ttlMs) {
      map.delete(key);
      expired += 1;
    }
  }
  if (map.size > max) {
    const oldest = [...map.entries()].sort((a, b) => a[1] - b[1]);
    const remove = map.size - max;
    for (let i = 0; i < remove; i += 1) {
      map.delete(oldest[i][0]);
    }
    evicted = remove;
  }
  return { expired, invalid, evicted, size: map.size };
}

/** 1 人用短句；2 人及以上用带总人数的句子。正文不含昵称、不含 QQ 号。 */
export function buildWelcomeText(total, variantIndex = 0) {
  const n = Number(total) || 0;
  const v = WELCOME_VARIANTS[variantIndex] || WELCOME_VARIANTS[0];
  return n <= 1 ? v.short : v.many(n);
}

export class GroupWelcome {
  constructor({
    sender,
    onebot,
    stickers = null, // 可选：StickerManager；欢迎后追加固定表情，失败只记日志
    isAllowed,     // (groupId: string) => boolean
    isMuted,       // (chatKey: string) => Promise<boolean>
    isPaused,      // () => boolean，弱暂停
    log = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    random = Math.random,      // 返回 [0,1) 的随机源，测试注入固定序列
    initialSeen = new Map(),   // Map<seenKey, ts>，由 app 从 welcome-seen.json 加载
    persistSeen = null         // (Map<seenKey, ts>) => void，同步写盘；失败自行 throw
  } = {}) {
    // 注入依赖必须全部存成实例字段：类方法里裸写 setTimer / random 会 ReferenceError
    // 或静默退回全局实现（单测注入失效，属于最难发现的假绿）。
    this.sender = sender;
    this.onebot = onebot;
    this.stickers = stickers;
    this.isAllowed = typeof isAllowed === 'function' ? isAllowed : () => false;
    this.isMuted = typeof isMuted === 'function' ? isMuted : async () => false;
    this.isPaused = typeof isPaused === 'function' ? isPaused : () => false;
    this.log = typeof log === 'function' ? log : () => {};
    this.now = typeof now === 'function' ? now : Date.now;
    this.setTimer = typeof setTimer === 'function' ? setTimer : setTimeout;
    this.clearTimer = typeof clearTimer === 'function' ? clearTimer : clearTimeout;
    this.random = typeof random === 'function' ? random : Math.random;
    this.persistSeen = typeof persistSeen === 'function' ? persistSeen : null;

    this.stopped = false;
    this.buffers = new Map();     // Map<groupId, { users: Map<userId,true>, timer }>
    this.inFlight = new Set();    // 明文 `${groupId}:${userId}`，只在进程内、发送窗口内存在

    let seed = initialSeen;
    if (!(seed instanceof Map)) {
      this.log('[welcome] 初始防重表无效，按空表启动');
      seed = new Map();
    }
    // 先克隆再清理：调用方传进来的 Map 必须保持原样
    this.recentlyWelcomed = new Map(seed);
    const pruned = pruneSeen(this.recentlyWelcomed, this.now(), WELCOME_USER_TTL_MS, WELCOME_SEEN_MAX);
    if (pruned.invalid || pruned.expired || pruned.evicted) {
      this.log(`[welcome] 初始防重表已清理 invalid=${pruned.invalid} expired=${pruned.expired} evicted=${pruned.evicted} size=${pruned.size}`);
    }
  }

  /**
   * 入队。**同步返回**，不 await 网络 —— 否则会阻塞 handleOneBotEvent。
   * 守卫顺序见施工单 §3.6，不要调整：每一步的先后都对应一个已知的误判场景。
   */
  onJoin(event) {
    // 0. 已 stop：每个到达的事件各记一条，便于确认退出后没有残留发送
    if (this.stopped) {
      this.log(`[welcome] skip reason=stopped group=${event?.group_id ?? ''}`);
      return;
    }
    // 1. 非对象 / 非入群事件：直接丢，不记日志（接线层也会挡，这里兜一层）
    if (!event || typeof event !== 'object') return;
    if (event.notice_type !== 'group_increase') return;

    // 2. 群号：正整数
    const groupId = String(event.group_id ?? '');
    if (!POSITIVE_INT_RE.test(groupId)) {
      this.log(`[welcome] skip reason=invalid-group group=${groupId}`);
      return;
    }

    // 3. QQ 号：正整数（user_id=0 是新成员解析失败时的真实取值）
    const userId = String(event.user_id ?? '');
    if (!POSITIVE_INT_RE.test(userId)) {
      this.log(`[welcome] skip reason=invalid-user group=${groupId}`);
      return;
    }

    // 4. selfId 双源：onebot.selfId 在 get_login_info 返回前是空串，
    //    但 SnowLuma 的每个 notice 信封都带 self_id。两者都空才放弃判断。
    const selfId = String(this.onebot?.selfId || event.self_id || '');
    if (!selfId) {
      this.log(`[welcome] skip reason=self-id-empty group=${groupId}`);
      return;
    }
    // 5. 机器人自己进群
    if (userId === selfId) {
      this.log(`[welcome] skip reason=self-join group=${groupId}`);
      return;
    }

    // 6. 白名单（deny 优先 / allow 非空必须命中 / 空列表看 allowAllWhenEmpty）
    if (!this.isAllowed(groupId)) {
      this.log(`[welcome] skip reason=not-allowed group=${groupId}`);
      return;
    }

    // 7. 弱暂停：不新建缓冲区，也不记 TTL —— 解除暂停后同一成员再进群仍可欢迎
    if (this.isPaused()) {
      this.log(`[welcome] skip reason=paused group=${groupId}`);
      return;
    }

    // 8. 10 分钟内已成功欢迎过（哈希键；命中但过期会先删再当未命中）
    if (this.#hasRecentlyWelcomed(groupId, userId)) {
      this.log(`[welcome] skip reason=duplicate group=${groupId}`);
      return;
    }

    // 9. 正在发送：失败释放后允许重试，所以这里只是"暂时挡住"
    const flightKey = `${groupId}:${userId}`;
    if (this.inFlight.has(flightKey)) {
      this.log(`[welcome] skip reason=in-flight group=${groupId}`);
      return;
    }

    // 10. 入缓冲区；定时器只从第一个事件起算，后续事件不重置
    const buf = this.buffers.get(groupId) ?? { users: new Map(), timer: null };
    this.buffers.set(groupId, buf);
    buf.users.set(userId, true);

    if (buf.timer == null) {   // 必须用 == null：fake timer 可能返回 0
      buf.timer = this.setTimer(
        // 回调必须把 promise return 出去：单测手动触发时要能 await 到"真的发完"
        () => this.#flush(groupId).catch((e) => this.log(`[welcome] flush 异常：${e?.message ?? e}`)),
        WELCOME_DEBOUNCE_MS
      );
      buf.timer?.unref?.();    // 不让待发欢迎拖住进程退出（fake timer 返回数字，?. 天然跳过）
    }
  }

  stop() {
    this.stopped = true;
    for (const buf of this.buffers.values()) {
      if (buf.timer != null) this.clearTimer(buf.timer);
    }
    this.buffers.clear();
    this.inFlight.clear();
    // 刻意不清 recentlyWelcomed、不主动保存：
    // 清空会让同进程内的重复事件重新欢迎；主动保存会在关闭路径上多一次可能失败的写盘。
  }

  #hasRecentlyWelcomed(groupId, userId) {
    const key = seenKey(groupId, userId);
    const ts = this.recentlyWelcomed.get(key);
    if (ts == null) return false;
    if (this.now() - ts >= WELCOME_USER_TTL_MS) {
      this.recentlyWelcomed.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 表情是附加项：只查本地已加载的库，不触发同步；任何失败都只记日志。
   * 不放在欢迎文字的同一个 catch 里，避免表情失败被误报成欢迎发送失败。
   */
  async #sendWelcomeSticker(groupId) {
    const stickers = this.stickers;
    if (!stickers) return;
    try {
      if (stickers.enabled === false) {
        this.log(`[welcome] 表情跳过 reason=disabled group=${groupId}`);
        return;
      }
      if (typeof stickers.findCached !== 'function'
        || typeof this.sender?.sendSticker !== 'function') return;

      let sticker = await stickers.findCached(WELCOME_STICKER_ID);
      if (!sticker) {
        this.log(`[welcome] 表情跳过 reason=not-found group=${groupId}`);
        return;
      }
      if (typeof stickers.ensureSendable === 'function') {
        sticker = await stickers.ensureSendable(sticker);
      }
      await this.sender.sendSticker(`group:${groupId}`, sticker);
      this.log(`[welcome] 表情已发送 group=${groupId} id=${sticker.id}`);
    } catch (error) {
      this.log(`[welcome] 表情发送失败 group=${groupId}：${error?.message ?? error}`);
    }
  }

  async #flush(groupId) {
    // ── 同步段（任何 await 之前）：先摘缓冲区、清定时器、占 inFlight ──
    // 顺序不能反：flush 期间新到的同一事件要么被 inFlight 挡，要么新建缓冲区，
    // 绝不能挂回这个已经摘掉的 buf。
    const buf = this.buffers.get(groupId);
    if (!buf) return;
    this.buffers.delete(groupId);
    if (buf.timer != null) this.clearTimer(buf.timer);

    const userIds = [...buf.users.keys()];   // users 是 Map，必须转数组
    if (!userIds.length) return;
    for (const userId of userIds) this.inFlight.add(`${groupId}:${userId}`);

    let variantIndex = 0;   // 必须在 try 外初始化：失败日志要引用它
    try {
      if (this.stopped) { this.log(`[welcome] skip reason=stopped group=${groupId}`); return; }
      if (!this.isAllowed(groupId)) { this.log(`[welcome] skip reason=not-allowed group=${groupId}`); return; }
      if (this.isPaused()) { this.log(`[welcome] skip reason=paused group=${groupId}`); return; }

      // 禁言：fail-open（查询失败按未禁言继续，与 #checkSelfMuted 的口径一致）
      let muted = false;
      try { muted = await this.isMuted(`group:${groupId}`); } catch { muted = false; }
      if (muted) { this.log(`[welcome] skip reason=muted group=${groupId}`); return; }

      // 禁言是 await，期间可能刚好暂停/退出 —— 发送前再查一次
      if (this.stopped) { this.log(`[welcome] skip reason=stopped group=${groupId}`); return; }
      if (this.isPaused()) { this.log(`[welcome] skip reason=paused group=${groupId}`); return; }

      const atUserIds = userIds.slice(0, WELCOME_MAX_ATS);
      variantIndex = pickVariantIndex(this.random);
      const text = buildWelcomeText(userIds.length, variantIndex);
      // 只传 at 段，不查昵称、不拼 QQ 号；正文原样交给 sender 做 CQ 转义
      await this.sender.sendTextBatch(`group:${groupId}`, [text], { dedupe: false, atUserIds });

      this.log(`[welcome] 已发送 group=${groupId} count=${userIds.length} at=${atUserIds.length} variant=${WELCOME_VARIANTS[variantIndex].id}`);

      // 成功后：先更新内存、再落盘。两段各自 try/catch，绝不能向外 throw ——
      // 否则会被下面的 catch 当成"发送失败"，日志和验收都会错。
      try {
        const ts = this.now();
        for (const userId of userIds) this.recentlyWelcomed.set(seenKey(groupId, userId), ts);
        pruneSeen(this.recentlyWelcomed, ts, WELCOME_USER_TTL_MS, WELCOME_SEEN_MAX);
      } catch (error) {
        this.log(`[welcome] 状态更新失败 group=${groupId} count=${userIds.length}：${error?.message ?? error}`);
      }
      if (this.persistSeen) {
        try {
          this.persistSeen(this.recentlyWelcomed);
        } catch (error) {
          // 消息已经发出去了：只记"持久化失败"，不改判定、不重发
          this.log(`[welcome] 状态持久化失败 group=${groupId} count=${userIds.length}：${error?.message ?? error}`);
        }
      }

      // 文字与防重都已成立，最后再追加表情；失败不会回滚上面的记录。
      await this.#sendWelcomeSticker(groupId);
    } catch (error) {
      // 只有"发送/组装整体失败"才走这里：记日志、不重试、不向群里发提示
      this.log(`[welcome] 发送失败 group=${groupId} count=${userIds.length} variant=${WELCOME_VARIANTS[variantIndex].id}：${error?.message ?? error}`);
    } finally {
      // 覆盖所有 return 与异常：否则发送失败后 inFlight 残留，同一成员永远被挡
      for (const userId of userIds) this.inFlight.delete(`${groupId}:${userId}`);
    }
  }
}
