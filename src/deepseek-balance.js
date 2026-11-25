// DeepSeek 账户余额：官方 GET /user/balance。
// 只在主进程请求；Key 不出后端，接口只返回金额与状态。
import crypto from 'node:crypto';
import { getConfig } from './config.js';
import { resolveApiKey } from './llm.js';
import { logger } from './logger.js';

const SUCCESS_TTL_MS = 60_000;   // 成功结果缓存：页面加载/非强制查询用
const ERROR_TTL_MS = 15_000;     // 失败短缓存：避免连点或页面重开时放大故障
const MIN_FORCE_MS = 5_000;      // 强制刷新最小间隔：按钮连点保护
const TIMEOUT_MS = 8_000;        // 官方接口正常 < 1 秒；8 秒足够，超时不留悬挂请求
const OFFICIAL_HOST = 'api.deepseek.com';

function keyFingerprint(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

/**
 * 从当前配置解析余额端点。
 * 支持 api.provider（用该提供商的 baseURL）与 api.baseUrl；
 * 只接受 https + 官方域名，其余返回 { ok:false, reason:'unsupported' }。
 */
export function resolveBalanceEndpoint(cfg) {
  let base = String(cfg?.api?.baseUrl || '').trim();
  const pid = String(cfg?.api?.provider || '').trim();
  if (pid) {
    const p = (cfg?.providers || []).find((x) => x.id === pid);
    if (p?.baseURL) base = String(p.baseURL).trim();
  }
  if (!base) return { ok: false, reason: 'unsupported' };
  let u;
  try { u = new URL(base); } catch { return { ok: false, reason: 'unsupported' }; }
  // 端口只接受默认 443（URL 会把显式 :443 规范化成空串）。
  // 官方域名配了其它端口多半是自建代理，余额这类账户接口不跟过去。
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== OFFICIAL_HOST || u.port !== '') {
    return { ok: false, reason: 'unsupported' };
  }
  const key = resolveApiKey(cfg);
  if (!key) return { ok: false, reason: 'no-key' };
  return { ok: true, url: `${u.origin}/user/balance`, key };
}

/** 金额字段：只认有限数字或非空数字字符串；null/''/缺失都算无效（Number(null) 是 0，会显示成 ¥0.00）。 */
function parseAmount(v, fallback = NaN) {
  const n = typeof v === 'number' ? v
    : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : fallback;
}

/** 规范化官方返回；没有可用条目返回 null。 */
export function parseBalancePayload(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.balance_infos)) return null;
  const infos = data.balance_infos.map((b) => ({
    currency: String(b?.currency || '').toUpperCase() || 'CNY',
    total: parseAmount(b?.total_balance),
    granted: parseAmount(b?.granted_balance, 0),
    toppedUp: parseAmount(b?.topped_up_balance, 0)
  })).filter((b) => b.currency && Number.isFinite(b.total));
  if (!infos.length) return null;
  const primary = infos.find((b) => b.currency === 'CNY') || infos[0];
  return { available: data.is_available !== false, infos, primary };
}

/**
 * 可注入依赖的余额服务（单测用；生产用下面的单例）。
 * get({ force }) 返回：
 *   { ok:true, at, available, currency, total, granted, toppedUp, infos }
 *   { ok:false, at, reason }   reason ∈ no-key | unsupported | auth | http | timeout | network | bad-response | empty
 * 任何返回值都不含 Key / baseUrl。
 */
export function createBalanceService({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  getCfg = () => getConfig(),
  log = (...args) => logger.warn('balance', ...args)
} = {}) {
  let cache = { at: 0, keyId: '', payload: null };
  let pending = null;   // { keyId, promise }

  const fail = (reason, at) => ({ ok: false, reason, at });

  async function run(ep, keyId) {
    const at = now();
    let res;
    try {
      res = await fetchImpl(ep.url, {
        method: 'GET',
        headers: { authorization: `Bearer ${ep.key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (e) {
      const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network';
      log(`请求失败：${reason}`);
      return fail(reason, at);
    }
    if (!res.ok) {
      const reason = res.status === 401 || res.status === 403 ? 'auth' : 'http';
      log(`HTTP ${res.status}`);
      return fail(reason, at);
    }
    let data;
    try { data = await res.json(); } catch { return fail('bad-response', at); }
    const parsed = parseBalancePayload(data);
    if (!parsed) {
      // 空列表不是坏结构：账户能查通、但没有币种条目，前端提示"暂无"而不是报错。
      // 注意：它仍是 ok:false，会沿用 15 秒失败缓存（成功是 60 秒）；充值后被动刷新最多滞后 15 秒。
      if (Array.isArray(data?.balance_infos) && data.balance_infos.length === 0) {
        return { ok: false, reason: 'empty', at, available: data.is_available !== false };
      }
      return fail('bad-response', at);
    }
    return {
      ok: true,
      at,
      available: parsed.available,
      currency: parsed.primary.currency,
      total: parsed.primary.total,
      granted: parsed.primary.granted,
      toppedUp: parsed.primary.toppedUp,
      infos: parsed.infos
    };
  }

  async function get({ force = false } = {}) {
    const ep = resolveBalanceEndpoint(getCfg());
    if (!ep.ok) return fail(ep.reason, now());
    const keyId = keyFingerprint(ep.key);
    // Key/providers 变化后，旧缓存立即作废（设置页换 Key 不必等 60 秒）
    if (cache.keyId !== keyId) cache = { at: 0, keyId, payload: null };
    const t = now();
    const ttl = cache.payload?.ok ? SUCCESS_TTL_MS : ERROR_TTL_MS;
    if (!force && cache.at && t - cache.at < ttl) return cache.payload;
    if (force && cache.at && t - cache.at < MIN_FORCE_MS) {
      return { ...cache.payload, throttled: true };
    }
    if (pending && pending.keyId === keyId) return pending.promise;

    const promise = run(ep, keyId)
      .then((payload) => {
        // 请求期间配置可能已换 Key：不把旧 Key 的结果写进新缓存
        if (cache.keyId !== keyId) return payload;
        cache = { at: now(), keyId, payload };
        return payload;
      })
      .catch((e) => {
        log(`内部错误：${e?.message ?? e}`);
        return fail('network', now());
      })
      .finally(() => {
        if (pending?.promise === promise) pending = null;
      });
    pending = { keyId, promise };
    return promise;
  }

  return { get, reset: () => { cache = { at: 0, keyId: '', payload: null }; pending = null; } };
}

const service = createBalanceService();

export function getDeepSeekBalance(opts) {
  return service.get(opts);
}
