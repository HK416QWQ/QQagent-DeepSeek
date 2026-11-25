// 运行记录（src/run-history.js）离线测试。
// 一次进程启动一条；计时起点是首次 OneBot 连接成功；重连不新开记录；
// 正常退出 = stopped；崩溃/强杀下次启动按最后心跳结算为 interrupted；只留 200 条。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const readDisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'run-history.json'), 'utf8'));
const diskFile = (dir) => path.join(dir, 'run-history.json');

// 每个场景用独立模块实例（query 破除 ESM 缓存），互不共享内存状态。
let seq = 0;
const freshModule = () => import(`../src/run-history.js?case=${++seq}&t=${Date.now()}`);

console.log('=== 1. 未连接不产生记录 ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-runtime-'));
  const m = await freshModule();
  await check('init 后无当前记录，且不写空文件', () => {
    m.initRunHistory(dir);
    assert.equal(m.getStatusRuntime(1000), null);
    assert.deepEqual(m.getRuntimeSnapshot(50, 1000).runs, []);
    assert.equal(fs.existsSync(diskFile(dir)), false, '未连接不应创建 run-history.json');
  });
}

console.log('\n=== 2. 连接 / 重连 / 正常退出 ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-runtime-'));
  const m = await freshModule();
  const t0 = 1_000_000;
  m.initRunHistory(dir);

  await check('首次连接创建 running 记录并立即落盘', () => {
    assert.equal(m.markRunConnected(t0), true);
    const d = readDisk(dir);
    assert.equal(d.version, 1);
    assert.equal(d.runs.length, 1);
    assert.equal(d.runs[0].startedAt, t0);
    assert.equal(d.runs[0].endedAt, null);
    assert.equal(d.runs[0].status, 'running');
  });

  await check('同进程重连不新开记录、不重置起点', () => {
    assert.equal(m.markRunConnected(t0 + 3000), false);
    const d = readDisk(dir);
    assert.equal(d.runs.length, 1);
    assert.equal(d.runs[0].startedAt, t0);
  });

  await check('getStatusRuntime 返回实时时长，且不落盘', () => {
    const st = m.getStatusRuntime(t0 + 5000);
    assert.ok(st);
    assert.equal(st.id, readDisk(dir).runs[0].id);
    assert.equal(st.startedAt, t0);
    assert.equal(st.durationMs, 5000);
    assert.equal(st.status, 'running');
    // 心跳/lastSeenAt 只在内存推进：读盘仍是首次落盘的 1000
    assert.equal(readDisk(dir).runs[0].lastSeenAt, t0, '/api/status 不应写盘');
  });

  await check('stop 结算为 stopped：时长 = 结束 - 起点', () => {
    assert.equal(m.markRunStopped(t0 + 9000), true);
    const d = readDisk(dir);
    assert.equal(d.runs[0].status, 'stopped');
    assert.equal(d.runs[0].endedAt, t0 + 9000);
    assert.equal(d.runs[0].durationMs, 9000);
    assert.equal(m.getStatusRuntime(t0 + 10000), null);
  });
}

console.log('\n=== 3. 重载后 running 结算为 interrupted ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-runtime-'));
  const t0 = 2_000_000;
  const m = await freshModule();
  m.initRunHistory(dir);
  m.markRunConnected(t0);
  // 模拟心跳把 lastSeenAt 推进到崩溃前 7 秒，然后"进程消失"（不再调用 stop）
  const d = readDisk(dir);
  d.runs[0].lastSeenAt = t0 + 7000;
  fs.writeFileSync(diskFile(dir), JSON.stringify(d));

  const m2 = await freshModule();
  await check('下次启动按 lastSeenAt 结算 interrupted，时长≈最后心跳', () => {
    m2.initRunHistory(dir);
    const r = m2.getRuntimeSnapshot(50, t0 + 999_000).runs[0];
    assert.equal(r.status, 'interrupted');
    assert.equal(r.endedAt, t0 + 7000);
    assert.equal(r.durationMs, 7000);
    assert.equal(m2.getStatusRuntime(t0 + 999_000), null);
    assert.equal(readDisk(dir).runs[0].status, 'interrupted');
  });
}

console.log('\n=== 4. 只保留最近 200 条 ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-runtime-'));
  const m = await freshModule();
  m.initRunHistory(dir);
  const base = 3_000_000;
  for (let i = 0; i < 205; i++) {
    const t = base + i * 1000;
    m.markRunConnected(t);
    m.markRunStopped(t + 500);
  }
  await check('205 条滚动后内存与磁盘都只剩 200 条（最新在前）', () => {
    const snap = m.getRuntimeSnapshot(200, base + 300_000);
    assert.equal(snap.runs.length, 200);
    assert.equal(snap.runs[0].startedAt, base + 204 * 1000);
    assert.equal(snap.runs[199].startedAt, base + 5 * 1000);
    assert.equal(readDisk(dir).runs.length, 200);
  });

  await check('重载后仍为 200 条', async () => {
    const m2 = await freshModule();
    m2.initRunHistory(dir);
    assert.equal(m2.getRuntimeSnapshot(200, base + 400_000).runs.length, 200);
  });

  await check('limit 夹在 1..200', () => {
    assert.equal(m.getRuntimeSnapshot(0, base + 500_000).runs.length, 1);
    assert.equal(m.getRuntimeSnapshot(500, base + 500_000).runs.length, 200);
  });
}

console.log('\n=== 5. 快照结构 ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-runtime-'));
  const m = await freshModule();
  m.initRunHistory(dir);
  m.markRunConnected(4_000_000);
  await check('getRuntimeSnapshot 返回 serverNow/current/runs，running 时长实时计算', () => {
    const snap = m.getRuntimeSnapshot(50, 4_012_345);
    assert.equal(snap.serverNow, 4_012_345);
    assert.equal(snap.current.startedAt, 4_000_000);
    assert.equal(snap.current.durationMs, 12_345);
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.runs[0].durationMs, 12_345);
    assert.equal(snap.runs[0].endedAt, null);
    assert.equal(snap.runs[0].status, 'running');
  });
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / passed ' + pass : 'ALL PASSED ' + pass));
process.exit(fail ? 1 : 0);
