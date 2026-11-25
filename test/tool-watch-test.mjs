// 检索工具关闭提醒（启动自检）的单测。
//
// ── 为什么钉这几条 ──
// 「禁搜对照实验」要手动关掉 search_messages + get_recent_messages，关完忘了恢复，
// 线上就长期缺两个检索工具，而且**不报任何错**——模型只是突然答不出「以前说过的
// 某事」。这个自检是唯一的兜底信号，所以它有两个必须永远成立的性质：
//   1. **不能漏报**：两个工具被关时必须能在启动日志里看到。
//   2. **不能误报**：read_forward 现网就是关着的、而且是故意的（内置工具，功能已由
//      skill 侧承接）。一旦把它算进判定集，每次重启都 WARN，用户几天就麻木了，
//      真出事时反而看不见 —— 告警的价值全在"稀有"。
// 第 2 条比第 1 条更容易被后续维护者破坏（"顺手把能查历史的工具都加上"），
// 所以下面有一半断言是专门盯它的。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { disabledRetrievalTools, RETRIEVAL_TOOL_IDS } = await import('../src/tool-registry.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ── 1. 判定集严格等于两个检索工具 ──
{
  assert.deepEqual([...RETRIEVAL_TOOL_IDS], ['search_messages', 'get_recent_messages'],
    '★ 判定集必须严格等于这两个，一个不多一个不少');
  assert.ok(!RETRIEVAL_TOOL_IDS.includes('read_forward'),
    '★ read_forward 不能进判定集：它现网就是关着的且是故意的，算进来会每次重启都 WARN');
  ok('判定集 = {search_messages, get_recent_messages}，不含 read_forward');
}

// ── 2. ★ 现网形态（只有 read_forward:false）不许告警 ──
{
  assert.deepEqual(disabledRetrievalTools({ overrides: { read_forward: false } }), [],
    '★ 只有 read_forward 关着时必须返回空数组 —— 否则每次重启都会 WARN');
  ok('★ 现网配置（仅 read_forward:false）→ 不告警');
}

// ── 3. 单个被关 → 列出来（S3 验收 2）──
{
  assert.deepEqual(disabledRetrievalTools({ overrides: { search_messages: false } }), ['search_messages']);
  assert.deepEqual(disabledRetrievalTools({ overrides: { get_recent_messages: false } }), ['get_recent_messages']);
  ok('单个被关时准确列出该工具');
}

// ── 4. 两个都关 → 都列出（S3 验收 3）──
{
  assert.deepEqual(disabledRetrievalTools({ overrides: { search_messages: false, get_recent_messages: false } }),
    ['search_messages', 'get_recent_messages'], '两个都关时必须都列出，顺序按判定集固定');
  ok('两个都关 → 两个都列出，顺序固定');
}

// ── 5. 只有显式 false 才算关 ──
{
  assert.deepEqual(disabledRetrievalTools({ overrides: { search_messages: true } }), [], 'true = 开着');
  assert.deepEqual(disabledRetrievalTools({ overrides: {} }), [], '不在 overrides 里 = 按默认（开）');
  // undefined 不能被当成 false：`!== false` 与 `=== false` 的差别就这一处，
  // 写成 `!overrides[id]` 会把「没配置」误判成「被关」。
  assert.deepEqual(disabledRetrievalTools({ overrides: undefined }), [], 'overrides 缺失 = 都不算关');
  assert.deepEqual(disabledRetrievalTools({}), [], 'toolsCfg 为空 = 都不算关');
  assert.deepEqual(disabledRetrievalTools(), [], '不传参数也不能抛');
  assert.deepEqual(disabledRetrievalTools({ overrides: { search_messages: 'false' } }), [],
    '字符串 "false" 不算关（配置只会写布尔，字符串说明有人在手改文件）');
  ok('只有显式 === false 才算关（true / 缺省 / 字符串都不算）');
}

// ── 6. ★ 接线上真的接到了 start()，且用的是 logger.warn ──
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  assert.match(src, /import \{[^}]*disabledRetrievalTools[^}]*\} from '\.\/tool-registry\.js'/,
    '★ app.js 必须真的引入 disabledRetrievalTools');
  assert.match(src, /disabledRetrievalTools\(getConfig\(\)\.tools\)/,
    '★ 必须用实时配置 getConfig().tools 判定（不能读 createApp 时的快照 —— 那是启动前的值）');
  assert.match(src, /logger\.warn\('tools',\s*`检索工具已被关闭/,
    '★ 必须走 logger.warn 落到日志页签（console.log 不进日志页，用户看不到）');
  // 只提醒，不自动改配置。只扫自检那一段，不要全文匹配 —— 全文里别处的
  // updateConfig 调用会把断言带偏（那是设置页保存路径，与自检无关）。
  const at = src.indexOf('启动自检：检索类工具');
  assert.ok(at > 0, '找不到自检块');
  const block = src.slice(at, at + 1500);
  assert.ok(!block.includes('updateConfig('),
    '★ 自检只许提醒，不许自动恢复（可能有人是有意关的）');
  ok('★ 接线：start() 里用 getConfig().tools 判定 + logger.warn 落日志，且不自动恢复');
}

// ── 7. 实网配置快照（只报告，不断言）──
// 刻意不加 assert：禁搜实验期间这两个工具本来就是关着的，断言会让整个 npm test
// 在实验中途变红 —— 那是预期状态，不是缺陷。这里只把状态打出来，方便测前测后对照。
{
  const cfgPath = path.join(ROOT, 'data', 'config.json');
  let line = '实网 config.json 读不到，跳过';
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const off = disabledRetrievalTools(cfg.tools);
      line = off.length
        ? `实网当前处于禁搜态（${off.join(', ')}）—— 实验做完记得恢复`
        : '实网两个检索工具均可用（无实验残留）';
    } catch { line = '实网 config.json 解析失败，跳过'; }
  }
  console.log(`  · ${line}`);
  ok('实网配置快照已打印（不断言，避免实验期间误报）');
}

console.log(`  ── tool-watch：${passed} 项通过`);
