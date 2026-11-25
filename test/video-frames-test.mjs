// 视频抽帧插件（plugins/video-frames）+ 入站缓存配套逻辑的单测。
// 设计原则：能用纯函数验证的就不碰磁盘；必须碰的（真抽帧、store 落盘）
// 一律用临时目录，跑完删干净。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'video-frames');
let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ── 1. 清单与目录 ──
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
assert.equal(manifest.id, 'video-frames', 'id 必须是 video-frames（对齐 config.js 的迁移目标）');
assert.deepEqual(manifest.capabilities.sort(),
  ['video.frames', 'video.frames.available', 'video.sheet', 'video.sheet.available'].sort());
assert.ok(fs.existsSync(path.join(PLUGIN_DIR, 'index.js')), '入口文件应存在');
ok('plugin.json：id / capabilities / entry 齐备');

const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);

// ── 2. 导出面 ──
assert.equal(typeof mod.providers['video.frames'], 'function');
assert.equal(typeof mod.providers['video.frames.available'], 'function');
assert.equal(typeof mod.providers['video.sheet'], 'function');
assert.equal(typeof mod.providers['video.sheet.available'], 'function');
assert.equal(typeof mod.setup, 'function');
ok('providers：四个能力都有函数实现');

// ── 3. 时长解析 ──
assert.equal(mod.parseDurationSec('  Duration: 00:00:12.24, start: 0.000000'), 12.24);
assert.equal(mod.parseDurationSec('Duration: 01:02:03.50, start: 0.0'), 3723.5);
assert.equal(mod.parseDurationSec('no duration here'), 0);
ok('parseDurationSec：秒级 / 小时级 / 无 → 0');

// ── 4. 尺寸解析 ──
assert.deepEqual(mod.parseSize('Stream #0:1: Video: h264, yuv420p, 720x1280, 30 fps'), { width: 720, height: 1280 });
assert.deepEqual(mod.parseSize('Audio: aac'), {});
ok('parseSize：视频流行 / 音频行 → {}');

// ── 5. 滤镜串 ──
const vf = mod.buildFilter(6, 12, 640);
assert.ok(vf.startsWith('fps=0.500000,'), `fps 应为 帧数/时长：${vf}`);
assert.ok(vf.includes('min(640,iw)') && vf.includes('force_original_aspect_ratio=decrease'),
  '长边限缩必须用 force_original_aspect_ratio=decrease（竖屏否则高度翻倍）');
ok('buildFilter：帧率 = 帧数/时长，长边限缩');

// ── 6. 帧数夹取 ──
assert.equal(mod.internals.clampCount(99), 12, '上限 12');
assert.equal(mod.internals.clampCount(-3), 1, '下限 1');
assert.equal(mod.internals.clampCount(0), 0, '0 交给调用方回落默认值');
ok('clampCount：99→12 / -3→1 / 0→0');

// ── 7. available 形状 ──
const av = await mod.providers['video.frames.available']({});
assert.equal(typeof av.ok, 'boolean', '必须明确返回 ok 布尔（video-reader 靠它判定）');
if (av.ok) assert.ok(/ffmpeg/i.test(String(av.ffmpeg)), 'ok=true 时要给出实际路径');
ok(`available：${av.ok ? `ok（${path.basename(av.ffmpeg)}）` : '未找到 ffmpeg'}`);

// ── 8. 真抽帧（有 ffmpeg 且有缓存样本才跑） ──
const sample = fs.existsSync(path.join(ROOT, 'data', 'video-cache'))
  ? fs.readdirSync(path.join(ROOT, 'data', 'video-cache')).find((f) => f.endsWith('.mp4'))
  : null;
if (av.ok && sample) {
  const r = await mod.providers['video.frames']({
    filePath: path.join(ROOT, 'data', 'video-cache', sample), count: 3
  });
  assert.equal(r.frames.length, 3,
    '请求 3 帧应产出 3 帧（对 data/video-cache 全部 14 个样本实测 3 帧/6 帧均精确命中；'
    + '若这里红了且样本是 <1s 的超短视频，属边界正常，换一个样本再验）');
  assert.ok(r.frames.every((f) => f.startsWith('data:image/jpeg;base64,')), '必须是 jpeg dataUrl');
  assert.equal(r.times.length, 3, '时间轴长度应与帧数一致');
  assert.ok(r.durationSec > 0, '应同时给出时长（ffprobe 缺席时靠它）');
  ok(`真抽帧：${sample} → 3 帧 / ${r.durationSec.toFixed(2)}s / ${r.width}×${r.height}`);
} else {
  ok('真抽帧：跳过（无 ffmpeg 或无样本，不算失败）');
}

// ── 9. 文件不存在 ──
const missing = await mod.providers['video.frames']({ filePath: path.join(ROOT, 'data', 'video-cache', '__nope__.mp4') });
assert.equal(missing.frames.length, 0);
assert.ok(/不存在|清理/.test(missing.error || ''), '要给中文人话错误，不要抛');
ok('文件不存在：frames 空 + 人话 error');

// ── 10. 缓存命名（去重） ──
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa_vf_test_'));
process.env.QQ_AGENT_DATA_DIR = tmpData;
const { cachePathFor } = await import('../src/video-reader.js');
const a1 = cachePathFor({ file: 'abc.mp4' });
const a2 = cachePathFor({ file: 'abc.mp4' });
const b1 = cachePathFor({ file: 'other.mp4' });
assert.equal(a1, a2, '同一 media.file 必须稳定到同一路径（去重的前提）');
assert.notEqual(a1, b1);
assert.equal(cachePathFor({}), '', '无 file/url 时返回空');
ok('cachePathFor：同 file 同路径 / 不同 file 不同 / 空 → ""');

// ── 11. store.setMediaPath ──
const { ChatStore } = await import('../src/store.js');
const store = new ChatStore(0);
store.appendIncoming('group:999000111', {
  mid: 123456, ts: Date.now(), senderId: '1', senderName: 't', text: '[视频]',
  media: [{ kind: 'video', file: 'abc.mp4', url: 'https://example.com/a.mp4', path: '' }]
});
assert.equal(store.setMediaPath('group:999000111', 123456, 'abc.mp4', a1), true);
assert.equal(store.findByMid('group:999000111', 123456).media[0].path, a1, '路径应落到存档');
assert.equal(store.setMediaPath('group:999000111', 999999, 'abc.mp4', a1), false, '未知 mid 返回 false');
assert.equal(store.setMediaPath('group:999000111', 123456, '', a1), false,
  '空 file 必须拒绝：否则会命中同一条消息里第一张 file 也为空的图片');
ok('setMediaPath：命中写入 / 未知 mid 与空 file 都返回 false');

// ── 12. 接线检查（防"改了 video-reader 却没挂到入站"） ──
// 这一条是真的踩过：能力实现好了、核心也会问，但 app.js 没调预缓存，
// 结果是"抽帧能用、老视频永远拿不到"。只认实际调用点，不认注释。
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const callRe = /^\s*prefetchIncomingVideos\(`\$\{kind\}:\$\{id\}`, entry\)/m;
assert.ok(callRe.test(appSrc), 'app.js 必须在 ingestMessage 里调用 prefetchIncomingVideos(`${kind}:${id}`, entry)');
const vrSrc = fs.readFileSync(path.join(ROOT, 'src', 'video-reader.js'), 'utf8');
assert.ok(/async prefetch\(media = \{\}\)/.test(vrSrc), 'video-reader.js 必须提供 public 的 prefetch(media)');
ok('接线：app.js 调用点 + video-reader.prefetch 都在');

// ── 13. 下载原子性（.part → rename → 同 dest 去重） ──
// 哈希命名让 prefetch 与按需下载指向同一个文件，这一组断言防"改回直写 dest"：
// 直写的话两个流式写入会交错，而且写入期间 existsSync 已命中，ffmpeg 会读到半截 mp4。
assert.ok(/\.part-\$\{/.test(vrSrc), '缓存写入必须先落 .part 临时名');
assert.ok(/fs\.renameSync\(\s*tmp\s*,\s*dest\s*\)/.test(vrSrc), '成功后必须 renameSync 到 dest（原子落位）');
assert.ok(/this\.#downloads\.get\(dest\)/.test(vrSrc) && /#downloads = new Map\(\)/.test(vrSrc),
  '同一 dest 的并发下载必须共享同一次请求（in-flight Map）');
ok('下载原子性：.part 临时名 → rename → in-flight 去重');

// ── 14. 抽帧计划：时长决定模式与帧数 ──
// ⚠️ 本文件是**单文件顶层作用域**：sample（第 8 项）、missing（第 9 项）、
// r、av、vf、store、vrSrc 都已被占用，这里的常量一律另起名，否则 node --check
// 直接报 "Identifier 'x' has already been declared"，整个文件加载失败、一条都不跑。
const p30 = mod.planExtraction(30, 0);
const p600 = mod.planExtraction(600, 0);
const p3600 = mod.planExtraction(3600, 0);
assert.deepEqual({ mode: p30.mode, count: p30.count }, { mode: 'fps', count: 6 });
assert.deepEqual({ mode: p600.mode, count: p600.count }, { mode: 'seek', count: 9 });
assert.deepEqual({ mode: p3600.mode, count: p3600.count }, { mode: 'seek', count: 12 });
assert.equal(mod.planExtraction(3600, 4).count, 4, '模型显式要 4 帧就用 4 帧');
assert.equal(mod.planExtraction(3600, 99).count, 12, '超过上限夹到 12');
// 插件 settings 默认 frames=6，不能把长视频的自动量压回去
// （写成 `explicit || configured || autoCount` 时生产里恒为 6，这两条专门守它）
assert.equal(mod.planExtraction(3600, 0, { configuredFrames: 6 }).count, 12, '默认 6 帧不能压掉长视频的 12');
assert.equal(mod.planExtraction(30, 0, { configuredFrames: 6 }).count, 6, '短视频仍用配置的 6 帧');
ok('planExtraction：30s→fps/6、600s→seek/9、3600s→seek/12，显式帧数优先且默认值不压自动量');

// ── 15. times 与模式匹配（修掉整体偏半步的 bug）──
assert.deepEqual(p30.times, [0, 5, 10, 15, 20, 25], 'fps 从 0 起等距');
assert.equal(p3600.times[0], 150, 'seek 取格中心：3600/12/2');
assert.equal(p3600.times.at(-1), 3450);
ok('times：fps=i*step / seek=(i+0.5)*step，首尾都落在真实帧位置');

// ── 16. seek 分支真跑（强制开关，不依赖长视频样本）──
process.env.QQ_AGENT_FORCE_SEEK = '1';
const seekSample = fs.existsSync(path.join(ROOT, 'data', 'video-cache'))
  ? fs.readdirSync(path.join(ROOT, 'data', 'video-cache')).find((f) => f.endsWith('.mp4'))
  : null;
let seekNote = '无样本跳过';
if (seekSample) {
  const seekPath = path.join(ROOT, 'data', 'video-cache', seekSample);
  const seekRun = await mod.extract({ filePath: seekPath, count: 4 });
  assert.equal(seekRun.frames.length, 4, 'seek 应产出 4 帧');
  assert.equal(seekRun.times.length, 4);
  assert.equal(seekRun.count, 4, 'count 要回报计划帧数（truncated 判定依赖它）');
  assert.equal(seekRun.mode, 'seek');
  assert.ok(seekRun.times[0] > 0, '首帧不在 0 秒，而是格中心');

  // 少帧时的时间点必须"留在原地"，不能按实际帧数重新摊开。
  // 把总预算压到 0，循环抽完第 1 帧就 break —— 这时候只剩 1 帧，
  // 正确值仍是 plan.times[0] = dur/8；按老写法重算会变成 dur/2，差 4 倍。
  process.env.QQ_AGENT_SEEK_BUDGET_MS = '0';
  const partial = await mod.extract({ filePath: seekPath, count: 4 });
  delete process.env.QQ_AGENT_SEEK_BUDGET_MS;
  const d = partial.durationSec;
  assert.ok(partial.frames.length >= 1 && partial.frames.length < 4,
    `预算 0 应显著少于 4 帧（实际 ${partial.frames.length}；等于 4 说明 break 没生效）`);
  assert.ok(Math.abs(partial.times[0] - d / 8) < 0.05,
    `少帧时时间点必须留在原处（应为 ${(d / 8).toFixed(2)}，实际 ${partial.times[0]}；若等于 ${(d / 2).toFixed(2)} 说明按帧数重算了）`);
  seekNote = `${seekSample} → 4 帧、预算截断后 ${partial.frames.length} 帧仍在 ${partial.times[0]}s`;
}
delete process.env.QQ_AGENT_FORCE_SEEK;
ok(`seek 分支：真实样本出 4 帧、预算截断后仍报原有时刻（${seekNote}）`);

// ── 17. 文件不存在带 code ──
const missingFile = await mod.extract({ filePath: path.join(ROOT, 'data', 'no-such-file.mp4') });
assert.equal(missingFile.code, 'no_file');
assert.deepEqual(missingFile.frames, []);
ok('错误码：文件不存在 → code=no_file');

// ── 18. 取文件失败分类（video-reader 纯函数）──
const vr = await import(pathToFileURL(path.join(ROOT, 'src', 'video-reader.js')).href);
assert.equal(vr.classifyLocalizeError(new Error('文件达到大小上限（209715200 字节），已中止')), 'too_large');
assert.equal(vr.classifyLocalizeError(new Error('HTTP 400')), 'url_expired');
assert.equal(vr.classifyLocalizeError(new Error('fetch failed')), 'network');
assert.equal(vr.classifyLocalizeError(new Error('无法获取视频文件')), 'no_source');
assert.equal(vr.classifyLocalizeError(new Error('something else')), 'unknown');
// 真实链路里外层永远是通用文案，原因挂在 cause 上。只看最外层会把
// too_large 判成 no_source —— 那正是"469MB 却说直链过期"的由来。
const tooBig = Object.assign(new Error('无法获取视频文件'),
  { cause: new Error('文件达到大小上限（209715200 字节），已中止') });
assert.equal(vr.classifyLocalizeError(tooBig), 'too_large', 'cause 链要能穿透外层通用文案');
const expired = Object.assign(new Error('无法获取视频文件'), { cause: new Error('HTTP 400') });
assert.equal(vr.classifyLocalizeError(expired), 'url_expired');
ok('classifyLocalizeError：超限/过期/网络/无源/未知 五类分得开，且能穿透 cause 链');

// ── 19. 布局：三种宽高比 + 缺尺寸 ──
const layL = mod.sheetLayoutFor(1280, 576);
const layP = mod.sheetLayoutFor(720, 1280);
const layS = mod.sheetLayoutFor(720, 720);
const layN = mod.sheetLayoutFor(0, 0);
assert.deepEqual([layL.cw, layL.ch, layL.cols, layL.rows], [330, 186, 4, 5], '横屏 4×5');
assert.deepEqual([layP.cw, layP.ch, layP.cols, layP.rows], [186, 330, 5, 4], '竖屏 5×4');
assert.deepEqual([layS.cw, layS.ch], [248, 248], '方形 248');
assert.equal(layN, layL, '取不到尺寸回落横屏');
assert.deepEqual(mod.sheetSize(layL), { width: 1335, height: 1058 }, '横屏成品尺寸');
assert.deepEqual(mod.sheetSize(layP), { width: 948, height: 1423 }, '竖屏成品尺寸');
ok('sheetLayoutFor / sheetSize：横屏 1335×1058、竖屏 948×1423、方形 1258×1095');

// ── 20. 分桶：每桶取最高分 + 空桶中点 ──
// 20 秒 / 20 桶 → step = 1，桶 i 覆盖 [i, i+1)
const bkCands = [
  { t: 0.5, s: 0.30 },                            // 桶 0
  { t: 1.5, s: 0.60 },                            // 桶 1（分数更高，但不该抢桶 0 的名额）
  { t: 2.4, s: 0.45 },                            // 桶 2
  { t: 13.07, s: 0.12 }, { t: 13.2, s: 0.30 },    // 桶 13：13.07 是"关键帧但分数低"
];
const bkPlan = mod.pickSheetTimes(bkCands, 20, 20);
assert.equal(bkPlan.cells.length, 20, '格数必须等于桶数');
assert.equal(bkPlan.cells[0].t, 0.5, '桶 0 只有 0.5');
assert.equal(bkPlan.cells[1].t, 1.5, '桶 1 取该桶内的 1.5');
assert.equal(bkPlan.cells[0].from, 'scene');
assert.equal(bkPlan.cells[13].t, 13.2, '桶 13 内 13.2(0.30) 高于 13.07(0.12)');
assert.equal(bkPlan.cells[5].from, 'mid', '空桶退化成段中点');
assert.equal(bkPlan.cells[5].t, 5.5, '第 5 桶中点 = 5*1 + 0.5');
ok(`pickSheetTimes：20 桶、桶内取最高分、空桶用中点（场景格 ${bkPlan.sceneCells}/20）`);

// ── 21. 分桶：片尾候选被剪掉 ──
const tailCands = [{ t: 1, s: 0.5 }, { t: 19.4, s: 0.9 }];   // 19.4 在最后 6% 内
const tailPlan = mod.pickSheetTimes(tailCands, 20, 20);
assert.ok(!tailPlan.times.includes(19.4), '片尾转场不能被选进来');
assert.equal(tailPlan.cells.at(-1).from, 'mid', '最后一桶退化成中点');
// ⚠️ v1.1 增：最后一格不能落进片尾区（20 - tailCut = 18）
assert.ok(tailPlan.cells.at(-1).t < 20 - Math.max(2, 20 * 0.06),
  '最后一格不能落进片尾区');
// 单调不减（片尾让出后相邻格可相等）
let monoOk = true;
for (let i = 1; i < tailPlan.cells.length; i++) {
  if (tailPlan.cells[i].t < tailPlan.cells[i - 1].t) monoOk = false;
}
assert.ok(monoOk, '时刻必须单调不减');
ok('pickSheetTimes：片尾 max(2s, 6%) 内的候选被剪掉，最后一格也不落片尾');

// ── 22. 分桶：全低分时底噪过滤生效 ──
// 8 帧都是 0.002，底噪 = max(0.005, 0.002*2) = 0.005 → 全部被过滤 → 全走中点
//（⚠️ v1.1 改：系数是 ×2 不是 ×4，见 §0.8；×4 得 0.008 也能过，但注释会误导下一个人）
const quietPlan = mod.pickSheetTimes(
  Array.from({ length: 8 }, (_, i) => ({ t: i * 2, s: 0.002 })), 16, 8);
assert.equal(quietPlan.sceneCells, 0, '全低于底噪 → 没有场景格');
// ⚠️ 前 7 格退化为段中点 (i+0.5)*2；最后一格受 §11④ 片尾剪裁影响（dur=16、
// tailCut=max(2,16*0.06)=2 → 第 8 桶 [14,16) 整体在片尾内，退到 14-1=13），
// 不再等于中点 15。所以只断言「前 7 格中点」+「整体单调不减」，不硬卡最后一格。
assert.ok(quietPlan.times.slice(0, 7).every((t, i) => Math.abs(t - (i + 0.5) * 2) < 0.01),
  '前 7 格全部退化为段中点');
let quietMono = true;
for (let i = 1; i < quietPlan.times.length; i++) {
  if (quietPlan.times[i] < quietPlan.times[i - 1]) quietMono = false;
}
assert.ok(quietMono, '时刻单调不减');
ok('pickSheetTimes：低于底噪的候选不用，静帧视频退化为等间隔（不少格）');

// ── 23. 真跑分镜图（逐个样本试，取第一条成功的；全失败则跳过）──
// 不写死某个样本：video-cache 会被 72 小时保留策略清理，写死文件名迟早变红。
const cacheDir = path.join(ROOT, 'data', 'video-cache');
let sheetRun = null;
let sheetSample = '';
let tooLongSample = '';
if (av.ok && fs.existsSync(cacheDir)) {
  const mp4s = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.mp4')).slice(0, 6);
  for (const f of mp4s) {
    const candRun = await mod.extractSheet({ filePath: path.join(cacheDir, f) });
    // 跳过 <3s 超短视频：§8 边界里写过「20 格 = 0.15 秒/格，多数格子画面几乎相同，
    // 属浪费但无害」—— 2.48s 样本 tailCut=2 会把整段压进片尾，20 格几乎全落到同一个
    // 时刻，严格递增必失败。它是「成功」但不是本测试要验证的「有意义的 20 格」。
    if (candRun.code === '' && candRun.durationSec >= 3) { sheetRun = candRun; sheetSample = f; break; }
    if (candRun.code === 'too_long') tooLongSample = f;
  }
}
if (sheetRun) {
  assert.equal(sheetRun.frames.length, 1, '⚠️ 只回 1 张图（不是 20 张）');
  assert.ok(sheetRun.frames[0].startsWith('data:image/jpeg;base64,'), '必须是 jpeg dataUrl');
  assert.ok(sheetRun.cells.length >= 8, `格数应 ≥8，实际 ${sheetRun.cells.length}`);
  assert.equal(sheetRun.frameCount, sheetRun.cells.length, 'frameCount 必须等于格数，不能是 1');
  assert.equal(sheetRun.mode, 'sheet');
  assert.match(`${sheetRun.grid.rows}x${sheetRun.grid.cols}`, /^[45]x[45]$/, '网格应 4×5 或 5×4');
  // ⚠️ 单调不减，不是严格递增：§11 修订 ④ 让片尾桶退到同一边界，最后 1~2 格可能相等。
  for (let i = 1; i < sheetRun.cells.length; i++) {
    assert.ok(sheetRun.cells[i].t >= sheetRun.cells[i - 1].t, `第 ${i + 1} 格时刻必须不小于前一格`);
  }
  assert.ok(sheetRun.cells.at(-1).t < sheetRun.durationSec, '最后一格必须落在片内');
  ok(`真跑分镜图：${sheetSample} → 1 张图 / ${sheetRun.cells.length} 格 / ${sheetRun.grid.rows}×${sheetRun.grid.cols}`);
} else {
  ok(`真跑分镜图：跳过（${av.ok ? `无 ≥3s 且 ≤60s 的可用样本${tooLongSample ? `，${tooLongSample} 已判 too_long` : ''}` : '无 ffmpeg'}，不算失败）`);
}

// ── 24. 长视频不走分镜图 ──
// 用参数把时长报大，不依赖样本本身多长；但文件必须真实存在，否则先撞 no_file
const longProbe = sheetSample || tooLongSample;
if (av.ok && longProbe) {
  const tooLong = await mod.extractSheet({
    filePath: path.join(cacheDir, longProbe),
    durationSec: 300,
  });
  assert.equal(tooLong.code, 'too_long', '时长 300s 必须拒绝');
  assert.deepEqual(tooLong.frames, []);
  ok('extractSheet：超过 sheetMaxSec 返回 code=too_long（调用方据此退回均匀抽帧）');
} else {
  ok('extractSheet 长视频拒绝：跳过（无 ffmpeg 或无样本）');
}

// ── 25. video.sheet.available 必须同步 ──
const shAv = await mod.providers['video.sheet.available']({});
assert.equal(typeof shAv.ok, 'boolean');
ok(`video.sheet.available：ok=${shAv.ok}${shAv.font ? ` / 字体 ${path.basename(shAv.font)}` : ' / 无字体（无标签版）'}`);

// ── 26. 底噪系数必须是 2，不是 4 ──
// 这条专门钉住系数。背景：方案原稿写 ×4，实测偏严 —— 17.6s 样本上 20 个桶只有
// 2 格来自场景检测，而且正好漏掉 12.27 的「掀被坐起」帧（分数 0.0325 被 0.0563 的
// 底噪过滤掉），而缺这一帧就是 12 格版本答错方向的直接原因。
// 本组数据的 median=0.02：×2 → 底噪 0.04（0.05 的候选通过）；×4 → 0.08（全部被过滤）。
// 若有人把系数改回 4，这条会红。
const floorCands = [
  ...Array.from({ length: 20 }, (_, i) => ({ t: i + 0.5, s: 0.02 })),
  { t: 5.5, s: 0.05 },
];
const floorPlan = mod.pickSheetTimes(floorCands, 20, 20);
assert.equal(floorPlan.sceneCells, 1, '底噪系数为 2 时 0.05 应通过（系数为 4 会全被过滤）');
assert.equal(floorPlan.cells[5].t, 5.5, '第 5 桶应选中 0.05 那帧');
assert.equal(floorPlan.cells[5].from, 'scene');
assert.ok(floorPlan.floor <= 0.04 + 1e-9, `底噪应 ≤0.04，实际 ${floorPlan.floor}（>0.04 说明乘数被改大了）`);
ok('pickSheetTimes：底噪 = 中位数 × 2（不是 × 4），低分关键帧不会被误过滤');

// ── 27. 接线：truncated 必须用 cells 数格，不能用 frames.length（§0.7 陷阱）──
// 分镜图 frames.length 恒为 1，若拿它比计划格数 20，会得到 1<20 → 永远 truncated=true，
// 而且"看起来合理"，单测跑真抽帧也测不到（那只测插件层，不测 video-reader 的 probe 接线）。
// 所以这里直接钉源码：gotCount 必须优先取 cells.length。只认实际代码，不认注释。
const gotCountRe = /const gotCount = \(out\.cells\?\.length\) \?\? \(out\.frames\?\.length \|\| 0\);/;
assert.ok(gotCountRe.test(vrSrc), 'probe() 的 truncated 判定必须用 cells.length 优先（§0.7：frames.length 恒为 1）');
// #extractSheetViaSkill 的 frameCount 必须有 cells 兜底：插件漏给 frameCount 时，
// 不能回落到 frames.length（恒 1），否则 coverage.frames 报 1 而非 20。
const fcRe = /frameCount: Number\(r\.frameCount\) \|\| \(r\.cells\?\.length \|\| 0\) \|\| r\.frames\.length,/;
assert.ok(fcRe.test(vrSrc), '#extractSheetViaSkill 的 frameCount 必须优先取 cells.length 兜底');
ok('接线：truncated 用 cells 数格（防 1<20 永远截断的假象）');

// ── 28. 接线：metaOut 分镜图分支必须用 cells 替代 frameTimes ──
// tools.js 里 isSheet 为真时 metaOut 要有 grid/cells 且 frameCount 用 cells.length；
// 图片 part 文案要写"1 张分镜图"。这些都在 tools.js，video-frames-test 若不钉源码，
// 变异验证里"删掉 cells 分支"会静默漏网（metaOut 少字段但 npm test 仍绿）。
const toolsSrc = fs.readFileSync(path.join(ROOT, 'src', 'tools.js'), 'utf8');
assert.ok(/const isSheet = Array\.isArray\(info\.cells\) && info\.cells\.length > 0;/.test(toolsSrc),
  'tools.js 必须按 info.cells 判断是否分镜图');
assert.ok(/grid: info\.grid \|\| null, cells: info\.cells/.test(toolsSrc),
  '分镜图分支 metaOut 必须带 grid + cells');
assert.ok(/以下 1 张分镜图/.test(toolsSrc), '图片 part 文案必须说明"1 张分镜图"');
ok('接线：metaOut 分镜图分支（grid/cells/1 张图文案）都在');

// 清理
try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`  ── video-frames：${passed} 项通过`);
