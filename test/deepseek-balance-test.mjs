// DeepSeek 余额：解析 / 端点判定 / 缓存 / 强制刷新 / 错误映射 / 不泄露 Key。
// 全程离线：fetch 由测试注入；临时数据目录只给 logger 兜底。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-balance-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { createBalanceService, parseBalancePayload, resolveBalanceEndpoint } =
  await import('../src/deepseek-balance.js');

const PAYLOAD = {
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '20.00', granted_balance: '0.00', topped_up_balance: '20.00' },
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }
  ]
};

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const baseCfg = () => ({
  api: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test-secret', provider: '' },
  providers: []
});

const okReply = () => ({ ok: true, status: 200, json: async () => PAYLOAD });

const mk = ({ cfg = baseCfg(), reply = okReply, clock = { t: 1_000_000 } } = {}) => {
  const calls = [];
  const svc = createBalanceService({
    fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(); },
    now: () => clock.t,
    getCfg: () => cfg,
    log: () => {}
  });
  return { svc, calls, clock, cfg };
};

await check('解析：优先 CNY，金额转数字', () => {
  const p = parseBalancePayload(PAYLOAD);
  assert.equal(p.primary.currency, 'CNY');
  assert.equal(p.primary.total, 110);
  assert.equal(p.primary.granted, 10);
  assert.equal(p.infos.length, 2);
});

await check('解析：空/坏载荷返回 null', () => {
  assert.equal(parseBalancePayload(null), null);
  assert.equal(parseBalancePayload({ balance_infos: [] }), null);
  assert.equal(parseBalancePayload({ balance_infos: [{ currency: 'CNY' }] }), null);
});

await check('解析：total 为 null / 空串 / 非数字 → 该条无效（不显示 ¥0.00）', () => {
  assert.equal(parseBalancePayload({ balance_infos: [{ currency: 'CNY', total_balance: null }] }), null);
  assert.equal(parseBalancePayload({ balance_infos: [{ currency: 'CNY', total_balance: '' }] }), null);
  assert.equal(parseBalancePayload({ balance_infos: [{ currency: 'CNY', total_balance: 'abc' }] }), null);
  const p = parseBalancePayload({ balance_infos: [{ currency: 'CNY', total_balance: '20.00', granted_balance: null }] });
  assert.equal(p.primary.total, 20);
  assert.equal(p.primary.granted, 0, 'granted 缺省应是 0 而不是 NaN');
});

await check('端点：官方 https 通过，返回官方 /user/balance', () => {
  const ep = resolveBalanceEndpoint(baseCfg());
  assert.equal(ep.ok, true);
  assert.equal(ep.url, 'https://api.deepseek.com/user/balance');
});

await check('端点：中转站 / http / 空 Key → 明确原因', () => {
  const relay = baseCfg(); relay.api.baseUrl = 'https://relay.example.com/v1';
  assert.equal(resolveBalanceEndpoint(relay).reason, 'unsupported');
  const plain = baseCfg(); plain.api.baseUrl = 'http://api.deepseek.com/v1';
  assert.equal(resolveBalanceEndpoint(plain).reason, 'unsupported');
  const noKey = baseCfg(); noKey.api.apiKey = '';
  assert.equal(resolveBalanceEndpoint(noKey).reason, 'no-key');
});

await check('端点：api.provider 的 baseURL 优先', () => {
  const cfg = { api: { baseUrl: '', apiKey: 'sk-x', provider: 'p1' }, providers: [{ id: 'p1', baseURL: 'https://api.deepseek.com' }] };
  const ep = resolveBalanceEndpoint(cfg);
  assert.equal(ep.ok, true);
  assert.equal(ep.url, 'https://api.deepseek.com/user/balance');
});

await check('端点：非 443 端口拒绝，显式 :443 接受', () => {
  const other = baseCfg(); other.api.baseUrl = 'https://api.deepseek.com:8443/v1';
  assert.equal(resolveBalanceEndpoint(other).reason, 'unsupported');
  const dflt = baseCfg(); dflt.api.baseUrl = 'https://api.deepseek.com:443/v1';
  const ep = resolveBalanceEndpoint(dflt);
  assert.equal(ep.ok, true);
  assert.equal(ep.url, 'https://api.deepseek.com/user/balance');
});

await check('成功：金额/币种正确，响应不含 Key，只请求官方 URL', async () => {
  const { svc, calls } = mk();
  const r = await svc.get();
  assert.equal(r.ok, true);
  assert.equal(r.currency, 'CNY');
  assert.equal(r.total, 110);
  assert.equal(r.granted, 10);
  assert.equal(r.toppedUp, 100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test-secret');
  assert.ok(!JSON.stringify(r).includes('sk-test-secret'), '响应不能包含 Key');
  assert.ok(!JSON.stringify(r).includes('api.deepseek.com'), '响应不能包含 baseUrl');
});

await check('缓存：60 秒内第二次查询不发请求', async () => {
  const { svc, calls } = mk();
  await svc.get();
  await svc.get();
  assert.equal(calls.length, 1);
});

await check('强制刷新：5 秒内被节流，超过后真正重取', async () => {
  const { svc, calls, clock } = mk();
  await svc.get();
  clock.t += 1_000;
  const throttle = await svc.get({ force: true });
  assert.equal(throttle.throttled, true);
  assert.equal(calls.length, 1);
  clock.t += 5_000;
  await svc.get({ force: true });
  assert.equal(calls.length, 2);
});

await check('401 → auth；失败缓存 15 秒后才重试', async () => {
  const { svc, calls, clock } = mk({ reply: () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const r = await svc.get();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'auth');
  clock.t += 10_000;
  await svc.get();
  assert.equal(calls.length, 1);
  clock.t += 6_000;
  await svc.get();
  assert.equal(calls.length, 2);
});

await check('换 Key：缓存立即作废，不等 60 秒', async () => {
  const cfg = baseCfg();
  const { svc, calls } = mk({ cfg });
  await svc.get();
  cfg.api.apiKey = 'sk-other-secret';
  await svc.get();
  assert.equal(calls.length, 2);
});

await check('超时 → timeout；网络异常 → network', async () => {
  const t = mk({ reply: () => { const e = new Error('x'); e.name = 'TimeoutError'; throw e; } });
  assert.equal((await t.svc.get()).reason, 'timeout');
  const n = mk({ reply: () => { throw new Error('ECONNRESET'); } });
  assert.equal((await n.svc.get()).reason, 'network');
});

await check('空币种列表 → empty（不是坏结构，UI 显示暂无）', async () => {
  const { svc } = mk({ reply: () => ({ ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [] }) }) });
  const r = await svc.get();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
  assert.equal(r.available, true);
  const off = mk({ reply: () => ({ ok: true, status: 200, json: async () => ({ is_available: false, balance_infos: [] }) }) });
  const r2 = await off.svc.get();
  assert.equal(r2.reason, 'empty');
  assert.equal(r2.available, false);
});

await check('官方返回坏结构 → bad-response', async () => {
  const { svc } = mk({ reply: () => ({ ok: true, status: 200, json: async () => ({ balance_infos: 'nope' }) }) });
  const r = await svc.get();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-response');
});

await check('不支持/无 Key 时不发任何请求', async () => {
  const relay = baseCfg(); relay.api.baseUrl = 'https://relay.example.com/v1';
  const a = mk({ cfg: relay });
  assert.equal((await a.svc.get()).reason, 'unsupported');
  assert.equal(a.calls.length, 0);
  const noKey = baseCfg(); noKey.api.apiKey = '';
  const b = mk({ cfg: noKey });
  assert.equal((await b.svc.get()).reason, 'no-key');
  assert.equal(b.calls.length, 0);
});

fs.rmSync(dataDir, { recursive: true, force: true });
if (fail) { console.error(`deepseek-balance-test 失败 ${fail} 项`); process.exit(1); }
console.log(`deepseek-balance-test OK（${pass} 项）`);
