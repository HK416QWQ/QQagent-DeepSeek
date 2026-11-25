// SnowLuma 自动登录（B 方案）的纯逻辑测试：错误码映射 + 冷却。
//
// 为什么单独测这个文件：这条链路上最贵的错误不是"登录失败"，而是**把服务端限流打满**
// （5 次 / 15 分钟，按 IP）。一旦冷却算错，用户会在 15 分钟里连手动登录都进不去。
// 这里用注入的 fetch/now 把四种失败与冷却全钉住，不联网、不依赖 Electron。
import assert from 'node:assert/strict';
import { createSnowlumaAuth, classifyLogin } from '../src/snowluma-auth.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const resp = (status, body) => ({ status, json: async () => body });

/** 造一个按脚本返回的 fetch，并记录调用次数与最后一次请求参数。 */
function mkFetch(...answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  fn.calls = calls;
  return fn;
}

// ── classifyLogin：纯映射 ──
check('1. 200 + success → ok，带 token 与 mustChangePassword', () => {
  const r = classifyLogin({ status: 200, body: { success: true, token: 'abc', mustChangePassword: true } });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'abc');
  assert.equal(r.mustChangePassword, true);
});

check('2. 401 → bad-password（不是笼统的 error）', () => {
  const r = classifyLogin({ status: 401, body: { success: false, message: '密码错误' } });
  assert.equal(r.code, 'bad-password');
});

check('3. needsTotp → needs-totp（挂在 200 上也认得出来）', () => {
  const r = classifyLogin({ status: 200, body: { success: false, needsTotp: true } });
  assert.equal(r.code, 'needs-totp');
});

check('4. 429 → locked 且从中文消息里抠出秒数', () => {
  const r = classifyLogin({ status: 429, body: { success: false, message: '登录尝试过多，请 732 秒后重试' } });
  assert.equal(r.code, 'locked');
  assert.equal(r.waitSec, 732);
});

check('5. 415 → bad-request（客户端忘了 content-type 的锅，要能一眼看出来）', () => {
  assert.equal(classifyLogin({ status: 415, body: null }).code, 'bad-request');
});

// ── login：请求契约 ──
await checkAsync('6. 请求必须是 POST /api/login + application/json + {password}', async () => {
  const f = mkFetch(resp(200, { success: true, token: 'tk' }));
  const auth = createSnowlumaAuth({ fetchImpl: f });
  const r = await auth.login('p@ss word');
  assert.equal(r.ok, true);
  assert.equal(r.token, 'tk');
  const call = f.calls[0];
  assert.match(call.url, /\/api\/login$/);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(call.init.body), { password: 'p@ss word' }, '密码原样送出（不能 trim）');
});

await checkAsync('7. 连不上 → offline，且**不**落冷却（否则服务没启动时切几次页签就自锁）', async () => {
  const f = mkFetch(new Error('ECONNREFUSED'));
  const auth = createSnowlumaAuth({ fetchImpl: f });
  const a = await auth.login('x');
  const b = await auth.login('x');
  assert.equal(a.code, 'offline');
  assert.equal(b.code, 'offline', '第二次应该照常尝试，不该被冷却拦住');
  assert.equal(f.calls.length, 2);
});

await checkAsync('8. 密码错一次 → 进入冷却，第二次**根本不发请求**', async () => {
  let t = 1_000_000;
  const f = mkFetch(resp(401, { success: false, message: '密码错误' }));
  const auth = createSnowlumaAuth({ fetchImpl: f, now: () => t });
  assert.equal((await auth.login('x')).code, 'bad-password');
  const second = await auth.login('x');
  assert.equal(second.code, 'cooldown');
  assert.ok(second.waitSec >= 590 && second.waitSec <= 600, `waitSec 应在 600 秒附近，实际 ${second.waitSec}`);
  assert.equal(f.calls.length, 1, '冷却期内不该再打服务端');
});

await checkAsync('9. 冷却到期后恢复尝试；force 可立即绕过', async () => {
  let t = 0;
  const f = mkFetch(resp(401, { success: false, message: '密码错误' }));
  const auth = createSnowlumaAuth({ fetchImpl: f, now: () => t, cooldownMs: 60_000 });
  await auth.login('x');
  t += 60_000;                       // 刚好到期
  await auth.login('x');
  assert.equal(f.calls.length, 2, '到期应重新尝试');
  await auth.login('x', { force: true });   // 又失败 → 冷却中，但 force 放行
  assert.equal(f.calls.length, 3, 'force 必须绕开冷却（用户手动点「保存并登录」）');
});

await checkAsync('10. 登录成功后解除冷却', async () => {
  let t = 0;
  let ok = false;
  const f = async () => (ok ? resp(200, { success: true, token: 'tk' }) : resp(401, { success: false, message: '密码错误' }));
  const auth = createSnowlumaAuth({ fetchImpl: f, now: () => t, cooldownMs: 60_000 });
  await auth.login('x');             // 失败 → 冷却
  ok = true;
  const r = await auth.login('x', { force: true });
  assert.equal(r.ok, true);
  assert.equal(auth.cooldownLeft(), 0, '成功必须清掉冷却');
});

await checkAsync('11. 429 的冷却按服务端给的秒数走（不是固定 10 分钟）', async () => {
  let t = 0;
  const f = mkFetch(resp(429, { success: false, message: '登录尝试过多，请 30 秒后重试' }));
  const auth = createSnowlumaAuth({ fetchImpl: f, now: () => t, cooldownMs: 600_000 });
  await auth.login('x');
  assert.equal(Math.round(auth.cooldownLeft() / 1000), 30);
});

await checkAsync('12. 没密码 → no-credential，且一个请求都不发', async () => {
  const f = mkFetch(resp(200, { success: true, token: 'tk' }));
  const auth = createSnowlumaAuth({ fetchImpl: f });
  assert.equal((await auth.login('')).code, 'no-credential');
  assert.equal(f.calls.length, 0);
});

console.log(`\nSnowLuma 自动登录：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
