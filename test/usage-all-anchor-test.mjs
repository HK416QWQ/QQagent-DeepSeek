// 「全部」锚点 + 价格指纹：离线运行，只用临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY = 86400000;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-usage-all-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  api: { baseUrl: '', apiKey: '', model: 'test-model', priceInputPerM: 1, priceOutputPerM: 2, priceCachedPerM: 0 },
  server: { port: 3401 }
}));

const dayKeyOf = (ms) => {
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const sessionsDir = path.join(dataDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const oldTs = Date.now() - 200 * DAY;
const oldKey = dayKeyOf(oldTs);
const oldId = `${oldTs.toString(36)}-anchor1`;
fs.writeFileSync(path.join(sessionsDir, `${oldId}.json`), JSON.stringify({
  id: oldId, chatKey: 'group:10086', startedAt: oldTs, endedAt: oldTs + 60000,
  status: 'done', model: 'test-model', vendor: 'testvendor',
  usage: { promptTokens: 1234, completionTokens: 600, totalTokens: 1834, cachedTokens: 0, calls: 1 },
  messages: [{ raw: { created: Math.floor(oldTs / 1000), model: 'test-model', usage: { prompt_tokens: 1234, completion_tokens: 600 } } }],
  sent: []
}));
fs.writeFileSync(path.join(sessionsDir, 's-old1.json'), JSON.stringify({ id: 's-old1', messages: [] }));

const { __testUsageDaily } = await import('../src/app.js');
const T = __testUsageDaily();
const { setRemotePrices } = await import('../src/model-prices.js');

// ① 空 usage-days：起点必须来自会话文件，而不是"近 29 天"
const keysB = T.completedDayKeys(0);
assert.ok(keysB.includes(oldKey), `空 usage-days 时应从最早会话起算，实际起点 ${keysB[0]}`);
assert.ok(keysB.length < 400, `不能从 1970 枚举（实际 ${keysB.length} 天）`);

// ② 快照晚于最早会话：仍然要覆盖到最早会话
const recentKey = dayKeyOf(Date.now() - 3 * DAY);
fs.mkdirSync(path.join(dataDir, 'usage-days'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'usage-days', `${recentKey}.json`), JSON.stringify({
  version: 1, day: recentKey, priceStamp: T.usagePriceStamp(), savedAt: Date.now(),
  aggregates: { totals: { runs: 1, cost: 0.1, promptTokens: 10, completionTokens: 5, cachedTokens: 0, totalTokens: 15 },
                searchCount: 0, chats: [], models: [], hours: [] }
}));
const keysA = T.completedDayKeys(0);
assert.ok(keysA.includes(oldKey), `快照晚于最早会话时仍应包含 ${oldKey}，实际起点 ${keysA[0]}`);

// ③ 首次构建：缺失的历史日必须回算并落盘
const r1 = await T.buildUsageStatsWithSnapshots({ range: 'all' });
assert.ok(r1.recomputedDays >= 1, `首次应回算历史日，实际 ${r1.recomputedDays}`);
const stats = r1.stats;
console.log('day sample:', JSON.stringify(stats.days.find((d) => d.day === oldKey)).slice(0, 300));
const oldDay = stats.days.find((d) => d.day === oldKey);
assert.ok(oldDay, `days 里应有 ${oldKey}`);

const dayFile = path.join(dataDir, 'usage-days', `${oldKey}.json`);
assert.ok(fs.existsSync(dayFile), '历史日快照应已生成');
const snap = JSON.parse(fs.readFileSync(dayFile, 'utf8'));
assert.ok(snap.priceStamp, '日快照应带价格指纹');

// ④ 同价表再算一次：不应重算
const r2 = await T.buildUsageStatsWithSnapshots({ range: 'all' });
assert.equal(r2.recomputedDays, 0, `价格未变不应重算，实际 ${r2.recomputedDays}`);

// ⑤ 远程价表变化 → 指纹变化 → 必须重算
setRemotePrices({ 'test-model': { in: 9, out: 9, cached: 0 } });
const r3 = await T.buildUsageStatsWithSnapshots({ range: 'all' });
assert.ok(r3.recomputedDays >= 1, `远程价表变化应重算，实际 ${r3.recomputedDays}`);

// ⑥ 同一份远程表重复注入 → 不再重算
setRemotePrices({ 'test-model': { in: 9, out: 9, cached: 0 } });
const r4 = await T.buildUsageStatsWithSnapshots({ range: 'all' });
assert.equal(r4.recomputedDays, 0, `价表未变不应重算，实际 ${r4.recomputedDays}`);

// ⑦ 手工改某一天的指纹 → 只重算那一天
const snap2 = JSON.parse(fs.readFileSync(dayFile, 'utf8'));
snap2.priceStamp = 'stale';
fs.writeFileSync(dayFile, JSON.stringify(snap2));
const r5 = await T.buildUsageStatsWithSnapshots({ range: 'all' });
assert.equal(r5.recomputedDays, 1, `只应重算被改的那一天，实际 ${r5.recomputedDays}`);

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('usage-all-anchor-test OK');
