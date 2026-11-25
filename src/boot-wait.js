// 启动期端口等待（2026-11-11 从 src/app.js 抽出来的纯函数）
//
// ── 为什么单独成文件 ──
// 原来这段是 app.js 里一个内联 for 循环：固定 1 秒一次、20 次上限、超时**完全静默**。
// 实测每次冷启动都超时，日志里一个字都没有 —— 用户只看到"连不上"，排查时无从下手。
// 抽成纯函数之后可以被单测锁住（注入假时钟），也才能把"等多久/探了几次"写进日志。
//
// ── 为什么前 1 秒密集探测 ──
// SnowLuma 进程刚起时端口通常几百毫秒内就监听。固定 1 秒一次的话，最坏要多等近 1 秒。
// 前 1 秒用 150ms 跑几次，之后退避回 1 秒 —— 既快又不会长时间高频占用。
//
// ── 为什么预算提到 60 秒 ──
// 这段已经在后台跑（start() 早在它之前就 return 了），不占任何人的等待时间。
// 预算给足可以把"靠 2 秒端口轮询兜底"的概率降下来（那条路要等 WS 3001 才生效）。
//
// ⚠️ 超时**不抛异常**。端口没起来不是错误，是一条需要被记录的事实。

/** 默认睡眠：timer 必须 unref，否则一个 60 秒的后台等待会拖住进程退出。 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * 反复探测某个端口直到就绪、超时，或调用方要求中止。
 *
 * @param {() => (boolean|Promise<boolean>)} isOpen 探测函数：true = 就绪。
 *        抛异常一律当作 false（端口探测失败和"端口没开"对调用方是一回事）。
 * @param {object} [opts]
 * @param {number} [opts.budgetMs=60000]  总预算；<=0 时立即返回失败、一次都不探测
 * @param {number} [opts.fastUntilMs=1000] 这个时刻之前用短间隔
 * @param {number} [opts.fastDelayMs=150]  短间隔
 * @param {number} [opts.slowDelayMs=1000] 之后的间隔
 * @param {(ms:number)=>Promise<void>} [opts.sleep] 睡眠实现（测试注入假时钟）
 * @param {()=>number} [opts.now] 时间源（测试注入，否则 elapsedMs 会被假 sleep 骗）
 * @param {()=>boolean} [opts.shouldStop] 返回 true 时提前放弃（退出竞态守卫用）
 * @returns {Promise<{ok:boolean, elapsedMs:number, attempts:number, aborted?:boolean}>}
 */
export async function waitForPort(isOpen, {
  budgetMs = 60_000,
  fastUntilMs = 1_000,
  fastDelayMs = 150,
  slowDelayMs = 1_000,
  sleep = defaultSleep,
  now = () => Date.now(),
  shouldStop = null,
} = {}) {
  if (typeof isOpen !== 'function') {
    return { ok: false, elapsedMs: 0, attempts: 0 };
  }
  const budget = Math.max(0, Number(budgetMs) || 0);
  // budget=0 是"不要等"的显式表达：连第一次探测都不做，直接判失败。
  // （测试要覆盖"零预算"分支，也要保证它不会白跑一次探测。）
  if (!budget) return { ok: false, elapsedMs: 0, attempts: 0 };

  const started = now();
  let attempts = 0;

  for (;;) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      return { ok: false, elapsedMs: now() - started, attempts, aborted: true };
    }

    attempts += 1;
    let open = false;
    try {
      open = await isOpen();
    } catch {
      // 探测本身抛了（DNS/句柄异常等）：当作"还没开"，继续等。
      // 这里绝不能外抛 —— 端口问题不该打断后台启动流程。
      open = false;
    }
    if (open === true) {
      return { ok: true, elapsedMs: now() - started, attempts };
    }

    const elapsed = now() - started;
    if (elapsed >= budget) {
      return { ok: false, elapsedMs: elapsed, attempts };
    }

    const delay = elapsed < fastUntilMs ? fastDelayMs : slowDelayMs;
    // 别睡过预算：最后一次只睡剩余量，保证 elapsedMs 不越过 budget 太多
    const remain = budget - elapsed;
    await sleep(Math.max(1, Math.min(delay, remain)));
  }
}

export const internals = { defaultSleep };
