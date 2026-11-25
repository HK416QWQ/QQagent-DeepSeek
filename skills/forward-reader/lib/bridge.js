// 本机协议端（SnowLuma）HTTP 调用。
//
// ── 为什么技能要自己发 HTTP ──
// 技能的工具执行上下文里有 `ctx.onebot`（qzone 技能就是这么发说说的），
// 但**钩子（hook）上下文里没有** —— orchestrator 只往 hook 的 ctx 里放
// { chatKey, kind, chatId, chatName, model, provider, visionEnabled, searchEnabled,
//   proactive, sessionId, triggerEntries, store, memory }。
//
// 而本技能的核心诉求恰恰是"机器人开口之前就自动把转发展开"，那必须在 hook 里干活。
// 所以这里绕一条路：直接向本机协议端发 HTTP 请求（和 ctx.onebot.call 打的是同一个
// 接口 / 同一份 token）。
//
// ── token 从哪来 ──
// data/config.json 里的 snowluma.httpUrl / snowluma.httpAccessToken。
// 技能能读应用数据目录（qzone 技能的 state.js 同样这么做），这是只读、只用于本机
// 请求。设置页里留了手填覆盖项，自动读不到时才需要用户填。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// lib/ → forward-reader/ → skills/ → app/
const APP_ROOT = path.resolve(HERE, '..', '..', '..');

/**
 * 数据目录候选。
 * 运行时进程一般会设置 QQ_AGENT_DATA_DIR（框架 config.js 的 DATA_DIR 就是这么定的），
 * 但便携版/独立脚本不一定有，所以再兜两个推导位置：
 *   app/data                —— 框架默认值（path.join(ROOT, 'data')，ROOT = resources/app）
 *   <安装目录>/data          —— 打包安装版的真实数据目录（ROOT 再上两级）
 * 逐个试，取第一个真的有 snowluma.httpAccessToken 的 config.json。
 */
function dataDirCandidates() {
  return [
    process.env.QQ_AGENT_DATA_DIR || '',
    path.join(APP_ROOT, 'data'),
    path.resolve(APP_ROOT, '..', '..', 'data')
  ].filter(Boolean);
}

/** 找到一个可用的 config.json 里的 snowluma 配置（找不到返回 null）。 */
function readSnowlumaConfig() {
  for (const dir of dataDirCandidates()) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      const s = cfg?.snowluma;
      if (s && (s.httpUrl || s.httpAccessToken)) return s;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

export const DEFAULT_HTTP = 'http://127.0.0.1:3000';

/**
 * 解析出协议端的地址与 token。
 * 优先级：设置页手填 > config.json 里的 snowluma 配置 > 默认地址 + 空 token。
 */
export function resolveEndpoint({ url = '', token = '' } = {}) {
  let httpUrl = String(url ?? '').trim();
  let accessToken = String(token ?? '').trim();
  if (!httpUrl || !accessToken) {
    const s = readSnowlumaConfig();
    if (s) {
      if (!httpUrl) httpUrl = String(s.httpUrl || '');
      if (!accessToken) accessToken = String(s.httpAccessToken || '');
    }
  }
  return {
    httpUrl: (httpUrl || DEFAULT_HTTP).replace(/\/+$/, ''),
    accessToken
  };
}

/**
 * 调一次协议端接口。
 * 失败一律抛 Error（带 retcode / apiMessage 便于上层翻译成人话）。
 *
 * @param {string} action   OneBot 动作名，如 get_forward_msg
 * @param {object} params   动作参数
 * @param {object} opts     { fetchImpl, timeoutMs, url, token }
 */
export async function callOneBot(action, params, { fetchImpl = null, timeoutMs = 8000, url = '', token = '' } = {}) {
  const { httpUrl, accessToken } = resolveEndpoint({ url, token });
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('当前运行环境没有可用的 fetch');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await doFetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
      },
      body: JSON.stringify(params ?? {}),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!json) throw new Error(`协议端（${httpUrl}）返回了非 JSON：HTTP ${res.status} ${String(text).slice(0, 120)}`);
    // OneBot 约定：retcode 0 成功；部分实现用 1 表示"已受理"。status='failed' 一律算失败。
    const retcode = json.retcode;
    const bad = json.status === 'failed' || (retcode != null && retcode !== 0 && retcode !== 1);
    if (bad) {
      const err = new Error(String(json.message || json.wording || `协议端报错 retcode=${retcode}`));
      err.retcode = retcode;
      err.apiMessage = String(json.message || '');
      throw err;
    }
    return json;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`协议端请求超时（${timeoutMs}ms）：${action}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 把网络类报错翻译成中文（给模型/日志看），业务报错交给上层处理。 */
export function humanError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return '连不上本机协议端（QQ Agent 的 QQ 连接可能没就绪），稍后再试。';
  }
  if (/超时|timeout|aborted/i.test(msg)) return '协议端响应超时，晚一点再试。';
  return msg;
}
