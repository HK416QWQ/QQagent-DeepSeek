// SnowLuma 控制台登录（B 方案）：主进程用已保存的密码换 token。
//
// 为什么不让渲染层去填表（A 方案）：SnowLuma 的登录页是 React 受控组件，
// 填表要凑齐"等挂载 → 找输入框 → 骗过 onChange → 找提交按钮 → 点"五个软环节，
// 任何一个都会随 WebUI 升级失效，而且密码明文必须进页面。这里只依赖两件事：
//   ① `POST /api/login` 的契约    ② 前端把 token 存在 localStorage 的 `snowluma_token`
// 拿不到 token 时能给出确定的错误码（401/429/needsTotp/连不上），不做任何 DOM 操作。
//
// 本文件不 import electron —— 纯逻辑，供 main.js 调用，也供单测直接跑（注入 fetch / now）。

export const SNOWLUMA_BASE = 'http://127.0.0.1:5099';

// 服务端限流是「5 次 / 15 分钟，按 IP」。客户端必须自己先踩刹车：
// 自动登录每切一次页签就试一次的话，几次就能把用户锁死 15 分钟（连手动登录都进不去）。
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

/** 从「登录尝试过多，请 732 秒后重试」里抠出秒数；抠不到返回 0。 */
function parseWaitSec(message) {
  const m = /(\d+)\s*秒/.exec(String(message ?? ''));
  return m ? Number(m[1]) : 0;
}

/**
 * 把 /api/login 的响应翻译成统一的错误码。纯函数，单测直接覆盖。
 * code: ok | bad-password | needs-totp | locked | bad-request | error
 */
export function classifyLogin({ status, body } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (status === 200 && b.success === true) {
    return {
      ok: true,
      token: String(b.token ?? ''),
      mustChangePassword: b.mustChangePassword === true
    };
  }
  // needsTotp 可能挂在 200 或 401 上，先判它（服务端在密码正确时才会这么回）
  if (b.needsTotp === true) {
    return { ok: false, code: 'needs-totp', message: '该控制台已开启两步验证，需手动输入验证码' };
  }
  if (status === 401) return { ok: false, code: 'bad-password', message: String(b.message || '密码错误') };
  if (status === 429) {
    const waitSec = parseWaitSec(b.message);
    return { ok: false, code: 'locked', waitSec, message: String(b.message || '登录尝试过多') };
  }
  if (status === 415) return { ok: false, code: 'bad-request', message: '请求格式被服务端拒绝（客户端 bug）' };
  return { ok: false, code: 'error', message: String(b.message || `登录失败（HTTP ${status}）`) };
}

/**
 * 造一个带冷却的登录器。
 * @param {{fetchImpl?:Function, baseUrl?:string, now?:()=>number, timeoutMs?:number, cooldownMs?:number}} opt
 */
export function createSnowlumaAuth(opt = {}) {
  const {
    fetchImpl = globalThis.fetch,
    baseUrl = SNOWLUMA_BASE,
    now = Date.now,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS
  } = opt;

  let blockedUntil = 0;   // 冷却截止时间戳；0 = 没在冷却

  const cooldownLeft = () => Math.max(0, blockedUntil - now());

  return {
    /** 剩余冷却毫秒（给 UI 显示倒计时用） */
    cooldownLeft,
    /** 用户手动改完密码后解除冷却（force 之外的另一种解开方式） */
    reset() { blockedUntil = 0; },

    /**
     * 用密码换 token。
     * @param {string} password
     * @param {{force?:boolean}} o force=true 表示用户手动触发，绕过冷却
     */
    async login(password, { force = false } = {}) {
      const pwd = String(password ?? '');
      if (!pwd) return { ok: false, code: 'no-credential', message: '还没有保存密码' };

      const left = cooldownLeft();
      if (!force && left > 0) {
        const waitSec = Math.ceil(left / 1000);
        return { ok: false, code: 'cooldown', waitSec, message: `尝试过多，请 ${waitSec} 秒后重试` };
      }

      let res;
      const ac = new AbortController();
      const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, timeoutMs);
      try {
        res = await fetchImpl(`${baseUrl}/api/login`, {
          method: 'POST',
          // 服务端对非 application/json 直接 415（registerLoginRequestSecurity 的硬校验）
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: pwd }),
          signal: ac.signal
        });
      } catch {
        // 连不上 ≠ 密码错：不落冷却，否则 SnowLuma 没启动期间切几次页签就把自己锁了
        return { ok: false, code: 'offline', message: '连不上 SnowLuma（可能还没启动）' };
      } finally {
        clearTimeout(timer);
      }

      let body = null;
      try { body = await res.json(); } catch { body = null; }

      const out = classifyLogin({ status: res.status, body });
      if (out.ok) { blockedUntil = 0; return out; }

      if (out.code === 'bad-password') blockedUntil = now() + cooldownMs;
      else if (out.code === 'locked') blockedUntil = now() + (out.waitSec > 0 ? out.waitSec * 1000 : cooldownMs);
      return out;
    }
  };
}
