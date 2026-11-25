// 会话切分（第 1 期第 2 步）—— 纯函数：不调 LLM、不读盘、不写盘。
//
// 切分规则（施工单 §3.1.1）：
//   · 相邻两条间隔 > 30min → 前一段成为一个 conv，后一条开启新 conv
//   · 6h 兜底：某 conv 从开始算已满 6h 仍未因间隔关闭（群里 24 小时不断）→ 强制关闭
//   · 只有「已关闭」的 conv 才往下走；尾巴上还活着的那个留在 open 里，下轮再看
//
// 为什么单独一个文件、为什么必须纯：这一段的边界条件（29/31 分钟、跨零点、6h）
// 最容易写出 off-by-one，而它又是后面所有步骤的输入。纯函数才能把边界钉死在单测里，
// 不用起进程、不用等 10 分钟、不用真发消息。

/** 静默多久算「这段聊完了」。 */
export const GAP_MS = 30 * 60 * 1000;
/** 连续不断的群：从 conv 开始算满这么久就强制关（否则永远不产出）。 */
export const HARD_CLOSE_MS = 6 * 60 * 60 * 1000;
/** T2 判 short 的阈值（原始条数，含 self、不含不可见）。 */
export const SHORT_MSG_COUNT = 10;
/** T3 判 short 的阈值（群友可见条数）。**两个判据必须都保留**，见文件末尾说明。 */
export const SHORT_HUMAN_COUNT = 10;

const tsOf = (m) => Number(m?.ts) || 0;

/**
 * 把一串消息切成 conv。
 *
 * @param {Array} messages 按 ts 升序（store.rangeByTs 保证）。含 self（机器人发言
 *        要作为对话背景进摘要，见施工单 §3.2.0），不含不可见（由调用方先过滤）。
 * @param {{nowTs?:number, gapMs?:number, hardCloseMs?:number}} opts
 * @returns {{closed:Array<{startTs:number,endTs:number,messages:Array,msgCount:number,humanMsgCount:number}>,
 *            open:({startTs:number,endTs:number,messages:Array,msgCount:number,humanMsgCount:number}|null)}}
 */
export function splitConvs(messages, { nowTs = Date.now(), gapMs = GAP_MS, hardCloseMs = HARD_CLOSE_MS } = {}) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => Number.isFinite(tsOf(m)))
    .slice()
    .sort((a, b) => tsOf(a) - tsOf(b));

  const all = [];
  let cur = null;
  for (const m of list) {
    const ts = tsOf(m);
    if (!cur || ts - cur.endTs > gapMs) {
      if (cur) all.push(cur);
      cur = { startTs: ts, endTs: ts, messages: [m] };
    } else {
      cur.messages.push(m);
      cur.endTs = ts;
    }
  }
  if (cur) all.push(cur);

  // 每个 conv 带两个计数：
  //   msgCount     = 全部（含 self）→ T2 的 short 判据
  //   humanMsgCount= 只数群友      → T3 的 short 判据（v1.2 新增，口径不同不能混用）
  for (const c of all) {
    c.msgCount = c.messages.length;
    c.humanMsgCount = c.messages.reduce((n, m) => n + (m?.self ? 0 : 1), 0);
  }

  const closed = [];
  let open = null;
  for (let i = 0; i < all.length; i += 1) {
    const c = all[i];
    const isLast = i === all.length - 1;
    const idle = nowTs - c.endTs;
    const isClosed = idle >= gapMs || (nowTs - c.startTs >= hardCloseMs && idle > 0);
    // 除了「尾巴上还活着的那个」，其余一律算关闭：中间段必然已静默超过 gap
    // （否则后面的消息会被并进这一段）。写成 `!isLast || isClosed` 而不是
    // 「逐个判 isClosed」，是为了让「只有最后一个可能是 open」这件事在代码里看得见 ——
    // 否则时间戳异常（时钟回拨/未来消息）时会出现两个 open，前一个被悄悄丢掉。
    if (!isLast || isClosed) closed.push(c); else open = c;
  }
  return { closed, open };
}

// ── 为什么 T2 / T3 要用两个不同的 short 判据 ──────────────────────────────
// T2 判的是「**原始条数**」（含 self）：这么短的会话连排队都不值得，直接终态 short。
// T3 判的是「**群友可见条数**」：一段 100 条里 95 条是机器人说的、群友只说了 5 句，
// 可摘要的内容只有那 5 句；用总条数判会拿 95 条噪音去生成一段没有群友内容的摘要。
// 两者一定不一致，所以 T3 开头必须再判一次 —— 两个判据都保留，不是重复。

/** T2 的判定：直接终态 short，还是进 pending 排队。纯函数，便于钉死阈值。 */
export function t2State(conv, { shortCount = SHORT_MSG_COUNT } = {}) {
  return (Number(conv?.msgCount) || 0) < shortCount ? 'short' : 'pending';
}

/** T3 的判定：进到 T3 之后再看一次群友条数，不够就不调 LLM。 */
export function t3Blocked(conv, { shortHumanCount = SHORT_HUMAN_COUNT } = {}) {
  return (Number(conv?.humanMsgCount) || 0) < shortHumanCount;
}
