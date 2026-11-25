// 语音识别插件（plugins/media-audio）的单测。
//
// 设计原则：**不装模型也必须全绿**（CI / 新机器上 tools/sherpa 可能是空的）。
// 只有第 11 项是"有模型才跑"的真机抽样，没模型时打一行"跳过"。
//
// ⚠️ 第 8/9 项靠 QQ_AGENT_ASR 指向不存在的路径来造"没装"的场景。两个前提：
//   ① exeCandidates() 读 env 是**独占覆盖**（`if (env) return [env]`），
//      否则模型装好后循环会继续找到真实路径，这两条反而变红；
//   ② env 在第一次调用 available() 之前设好 —— 它有 60 秒结论缓存。
//      所以第 8/9 项用**查询串导入一个全新模块实例**（`?case=noenv`），
//      既不受主实例的缓存影响，也不会污染第 11 项。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = pathToFileURL(path.join(ROOT, 'plugins', 'media-audio', 'index.js')).href;

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ── 清单 ──
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'media-audio', 'plugin.json'), 'utf8'));
assert.equal(manifest.id, 'media-audio');
assert.deepEqual(manifest.capabilities.sort(), ['media.transcribe', 'media.transcribe.available'].sort());
assert.ok(manifest.settings && manifest.settings.enabled === true, 'settings 里要有 enabled 默认值');
assert.ok(manifest.configSchema && manifest.configSchema.enabled, 'configSchema 决定设置页有没有开关');
ok('plugin.json：id / capabilities / settings / configSchema 齐备');

const mod = await import(ENTRY);

// ── 1. 真实 stdout 样本（第 0 步实测抓下来的原文）──
const REAL_STDOUT = '{"lang": "<|zh|>", "emotion": "<|NEUTRAL|>", "event": "<|Speech|>", '
  + '"text": "开饭时间早上9点至下午5点。", "timestamps": [0.72, 0.96, 1.26], '
  + '"durations": [], "tokens":["开", "饭"], "ys_log_probs": [], "words": []}\r\n';
const p1 = mod.parseAsrOutput(REAL_STDOUT);
assert.equal(p1.text, '开饭时间早上9点至下午5点。');
assert.equal(p1.lang, 'zh');
assert.equal(p1.emotion, 'NEUTRAL');
assert.equal(p1.event, 'Speech');
ok('parseAsrOutput：真实 stdout（单行纯 JSON、无 0: 前缀）→ text/lang/emotion/event');

// ── 2. 空串 ──
const p2 = mod.parseAsrOutput('');
assert.deepEqual(p2, { text: '', lang: '', emotion: '', event: '' });
assert.deepEqual(mod.parseAsrOutput(undefined), { text: '', lang: '', emotion: '', event: '' });
ok('parseAsrOutput：空串 / undefined → 全空，不抛');

// ── 3. 混入噪声行 ──
const p3 = mod.parseAsrOutput([
  'recognizer created in 1.104 s',
  'Started',
  '{"lang": "<|en|>", "text": "hello"}',
  'not json {broken',
  '',
].join('\n'));
assert.equal(p3.text, 'hello', '只认能解析的 JSON 行');
assert.equal(p3.lang, 'en');
ok('parseAsrOutput：跳过非 JSON / 坏 JSON 行，不抛错');

// ── 4. stripTag ──
assert.equal(mod.stripTag('<|zh|>'), 'zh');
assert.equal(mod.stripTag('<|NEUTRAL|>'), 'NEUTRAL');
assert.equal(mod.stripTag(''), '');
assert.equal(mod.stripTag(null), '');
ok('stripTag：<|zh|> → zh，空值不抛');

// ── 5/6. parseDurationSec ──
assert.equal(mod.parseDurationSec('  Duration: 00:03:12.34, start: 0.0'), 192.34);
assert.equal(mod.parseDurationSec('Duration: 01:00:00.00'), 3600);
assert.equal(mod.parseDurationSec('no duration'), 0);
ok('parseDurationSec：192.34 / 3600 / 无 → 0');

// ── 7. clampInt ──
assert.equal(mod.clampInt(99, 4, 1, 16), 16, '超上限截断');
assert.equal(mod.clampInt(-5, 4, 1, 16), 1, '低于下限抬升');
assert.equal(mod.clampInt('abc', 4, 1, 16), 4, 'NaN 回落默认');
assert.equal(mod.clampInt('6', 4, 1, 16), 6, '字符串数字要认');
ok('clampInt：截断 / 抬升 / NaN 回落 / 字符串数字');

// ── 10. enqueue 串行（放在 8/9 之前跑，不和模块实例缓存纠缠）──
{
  let active = 0;
  let maxActive = 0;
  const order = [];
  const job = (id, ms) => mod.internals.enqueue(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start${id}`);
    await new Promise((r) => setTimeout(r, ms));
    active -= 1;
    order.push(`end${id}`);
  });
  await Promise.all([job(1, 60), job(2, 20), job(3, 10)]);
  assert.equal(maxActive, 1, `同一时刻只能跑一份推理（实测最大并发 ${maxActive}）`);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3'], '排队必须保持先来后到');

  // 抛错的 job 不能把队列带死
  let reached = false;
  await mod.internals.enqueue(async () => { throw new Error('boom'); }).catch(() => {});
  await mod.internals.enqueue(async () => { reached = true; });
  assert.equal(reached, true, 'job 抛错后队列仍能继续');
  ok('enqueue：最大并发 1 / 先来后到 / 抛错不带死队列');
}

// ── 11. 真机抽样（有模型才跑）──
const av = mod.available();
assert.equal(typeof av.then, 'undefined', 'available() 必须同步返回（返回 Promise 会被当成可用）');
const wav = path.join(ROOT, 'tools', 'sherpa', 'sense-voice', 'test_wavs', 'zh.wav');
if (av.ok && fs.existsSync(wav)) {
  const r = await mod.transcribe({ filePath: wav, kind: 'video' });
  assert.equal(r.ok, true, `真机识别应成功：${JSON.stringify(r)}`);
  assert.ok(String(r.text).length > 0, '应识别出文本');
  assert.equal(r.lang, 'zh', `语种应是 zh（实际 ${r.lang}）`);
  assert.equal(r.music, null, '不做音乐识别（本单底线 1）');
  ok(`真机抽样：${path.basename(wav)} → "${r.text}" / ${r.tookMs}ms`);

  // 「放弃排队」必须在队列外生效：
  // 队列被占住时，语音该在 voiceStartWaitMs 内直接返回 busy_skipped，
  // 而不是等前一条跑完才回话（v1.2 的写法就是这样，实测把入库卡了 25 秒）。
  {
    mod.setup({ config: () => ({ voiceStartWaitMs: 1000 }) });
    const hold = mod.internals.enqueue(() => new Promise((res) => setTimeout(res, 3000)));
    const t0 = Date.now();
    const busy = await mod.transcribe({ filePath: wav, kind: 'voice' });
    const ms = Date.now() - t0;
    await hold;
    mod.setup({ config: () => ({}) });
    assert.equal(busy.ok, false);
    assert.equal(busy.code, 'busy_skipped', `队列被占时应是 busy_skipped，实际 ${busy.code}`);
    assert.ok(ms < 2000, `必须在等待上限内回话（实测 ${ms}ms，上限 1000ms；若接近 3000ms 说明在等前一条跑完）`);
    ok(`排队放弃：队列被占 3s、voiceStartWaitMs=1000 → ${ms}ms 返回 busy_skipped`);
  }
} else {
  ok(`真机抽样：跳过（${av.ok ? '无测试音频' : av.reason}），不算失败`);
}

// ── 8/9. "没装"的两个分支（全新模块实例 + env 独占覆盖）──
{
  const savedAsr = process.env.QQ_AGENT_ASR;
  const savedModel = process.env.QQ_AGENT_ASR_MODEL;
  process.env.QQ_AGENT_ASR = path.join(ROOT, 'tools', '__nonexistent__', 'asr.exe');
  process.env.QQ_AGENT_ASR_MODEL = path.join(ROOT, 'tools', '__nonexistent__', 'model');
  let fresh;
  try {
    fresh = await import(`${ENTRY}?case=noenv`);
    const bad = fresh.available();
    assert.equal(bad.ok, false, 'env 指向不存在时应判不可用');
    assert.ok(/未找到/.test(String(bad.reason)), `reason 要说人话：${bad.reason}`);
    ok('available()：exe 不存在 → ok:false + 「未找到…」');

    // 不抛异常是硬要求：这条链路在入库热路径上，抛了会打断消息写入
    const r = await fresh.transcribe({});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no_provider');
    assert.equal(r.text, '');
    ok('transcribe()：无模型时 ok:false / code=no_provider，不抛异常');
  } finally {
    if (savedAsr === undefined) delete process.env.QQ_AGENT_ASR; else process.env.QQ_AGENT_ASR = savedAsr;
    if (savedModel === undefined) delete process.env.QQ_AGENT_ASR_MODEL; else process.env.QQ_AGENT_ASR_MODEL = savedModel;
  }
}

// ── 14. parseAsrSegments：真实格式（无行首编号）按序返回 ──
console.log('分段兜底');
{
  // ⚠️ 这里必须是**实测的真实格式**：一次传多个 wav 时每行都是纯 JSON，
  // 行首没有 `0: ` 前缀。用带前缀的假数据会让"编号解析"看起来是主路径，
  // 而线上走的是"行数等于文件数 → 按顺序映射"那条分支。
  const real = [
    '{"lang": "<|ja|>", "event": "<|Speech|>", "text": "おちんちん！"}',
    '{"lang": "<|en|>", "event": "<|Speech|>", "text": "Seek!"}',
  ].join('\r\n');
  const segs = mod.parseAsrSegments(real);
  assert.equal(segs.length, 2, '两个 wav 的输出应解析成两段');
  assert.deepEqual(segs.map((s) => s.text), ['おちんちん！', 'Seek!'], '顺序必须与传入一致');
  assert.deepEqual(segs.map((s) => s.idx), [-1, -1], '真实格式没有行首编号 → idx 应为 -1');
  assert.equal(segs[1].lang, 'en', 'stripTag 应去掉 <| |>');
  // 兼容性兜底：万一以后版本加上编号也要能认出来（不是主路径）
  assert.deepEqual(
    mod.parseAsrSegments('0: {"text":"a"}\n1: {"text":"b"}').map((s) => s.idx), [0, 1],
    '带编号时 idx 要认出来'
  );
  ok('parseAsrSegments：真实格式（无编号）按序分段 + 编号兼容');
}

// ── 15. parseAsrSegments：坏行/空串不抛 ──
{
  assert.deepEqual(mod.parseAsrSegments(''), [], '空串 → 空数组');
  assert.deepEqual(mod.parseAsrSegments(undefined), [], 'undefined → 空数组');
  const mixed = 'not json\n{"text":"好"}\n{bad\n';
  assert.equal(mod.parseAsrSegments(mixed).length, 1, '只保留可解析的行');
  ok('parseAsrSegments：坏行跳过、不抛');
}

// ── 16. 分段参数 ──
assert.equal(mod.internals.SEG_SEC, 3, '段长必须 3 秒：1.5 秒实测会凑词（The./嗯。）');
assert.equal(mod.internals.SEG_MIN_SEC, 2.5, '末段下限 2.5 秒：实测正常段 2.946~3.074');
assert.equal(mod.internals.SEG_MIN_HIT, 2, '至少 2 段有内容才采纳');
assert.equal(mod.internals.SEG_MIN_UNIQ, 2, '且至少 2 种不同文本才采纳');
ok('分段参数：3 秒 / 2.5 秒 / 2 段 / 2 种文本');

// ── 17. 准入门槛（本单的安全阀，用 43 个真实样本的实测数据回放）──
{
  const A = mod.acceptSegments;
  const H = (texts) => texts.map((t) => ({ text: t }));
  // 正例：目标视频整段识别出 1 个实义字，分段 5 种文本
  assert.equal(A(H(['おちんちんちんちん', 'おちんちん', 'じんじんじんじん', 'Deep', 'Seek']), 'お！'), true,
    '目标视频（整段有实义字 + 5 种文本）必须采纳');
  // 实测会误采纳的 4 例，必须全挡住。它们共同点：整段只有标点、没有实义字。
  assert.equal(A(H(['The', 'あ']), '。'), false, '整段只有标点 → 不信分段（The. あ。）');
  assert.equal(A(H(['Yeah', '大じだ', 'Yeah', 'Yeah', '分りました']), '.'), false,
    '整段只有一个句号 → 不信分段（Yeah 大じだ…）');
  assert.equal(A(H(['The', '每当母亲我唱来', '多你', '朝着一不', '天你不管我苍']), '.'), false,
    '整段没有实义字 → 哪怕分段凑出长句也不信');
  // 段文本去重 ≥2 种这条也要锁
  assert.equal(A(H(['The', 'The', 'The', 'The', 'The']), '我'), false, 'The×5 是噪声（同词重复）');
  assert.equal(A(H(['그', '그', '그']), '我'), false, '그×3 是噪声');
  // 段数 / 空
  assert.equal(A(H(['我']), '我'), false, '单段不采纳');
  assert.equal(A([], '我'), false, '空不采纳');
  ok('acceptSegments：整段无实义字的 4 个误采纳 + 同词重复全部挡住，正例通过');
}

// ── 18. splitWav：末段不足 2.5 秒被丢弃、start 累计 ──
{
  const ff = await mod.internals.resolveFfmpeg();
  if (!ff) {
    ok('splitWav：本机没有 ffmpeg，跳过（不算失败）');
  } else {
    const src = path.join(os.tmpdir(), `qqa_t_${Date.now()}.wav`);
    await new Promise((r) => {
      const p = spawn(ff, ['-hide_banner', '-y', '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=7', '-ar', '16000', '-ac', '1', src]);
      p.on('close', r);
    });
    const { files, dir } = await mod.internals.splitWav(ff, src, { segSec: 3, maxSegs: 8 });
    assert.equal(files.length, 2, '7 秒 → 2 段（1 秒的尾巴应被丢弃）');
    assert.deepEqual(files.map((f) => f.start), [0, 3], 'start 按有效段累计，不能按文件名下标');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(src, { force: true });
    ok('splitWav：末段丢弃、start 累计正确');
  }
}

// ── 19. 端到端：整段吞掉人声的视频，分段后应听到内容 ──
{
  const v = path.join(ROOT, 'data', 'video-cache', 'v_e2e5b3d79417faf3.mp4');
  if (!av.ok || !fs.existsSync(v)) {
    ok('端到端分段：无模型或取证视频已被清理，跳过（不算失败；重发一条有人说话的视频再跑）');
  } else {
    const r = await mod.transcribe({ filePath: v, kind: 'video' });
    assert.equal(r.ok, true, '应正常返回');
    if (!r.segmented) {
      // 不能无条件放过。正例的整段结果是「お！」（1 个实义字）——「明明没内容却
      // 没走分段」正是触发条件写错的表现（施工单原文的 `!p.text` 在 43 个真实
      // 样本里命中 0 个，等于那段代码永不执行）。只有整段真出了成句内容才允许跳过。
      const body = String(r.text || '').replace(/[\s\p{P}]/gu, '');
      assert.ok(body.length > 1,
        `整段只有 ${body.length} 个实义字（${JSON.stringify(r.text)}）却没走分段 —— 触发条件失效`);
      ok(`端到端分段：整段已能出成句文本（${String(r.text).slice(0, 20)}），未复现，跳过（不算失败）`);
    } else {
      assert.ok(r.segments.length >= 2, '至少 2 段');
      assert.ok(r.segments.every((s) => typeof s.start === 'number'), '每段都要带 start');
      assert.equal(r.segments[0].start, 0, '第一段从 0 秒起');
      assert.ok(/deep|seek/i.test(r.text), `应听到 Deep / Seek（实际 ${r.text}）`);
      ok(`端到端分段：${r.segments.length} 段 / ${r.tookMs}ms → ${r.text.slice(0, 46)}`);
    }
  }
}

// ── 20. 端到端反例：无人声视频不许被分段"听"出内容 ──
{
  const v = path.join(ROOT, 'data', 'video-cache', 'v_9461330d0ae1e351.mp4');
  if (!av.ok || !fs.existsSync(v)) {
    ok('端到端反例：无人声样本已被清理，跳过（不算失败；第 17 项已锁住同一逻辑）');
  } else {
    const r = await mod.transcribe({ filePath: v, kind: 'video' });
    assert.equal(r.ok, true, '无人声也应正常返回');
    assert.notEqual(r.segmented, true, `无人声视频不允许采纳分段（实际吐了 ${JSON.stringify(r.text)}）`);
    assert.equal(String(r.text || '').replace(/[\s\p{P}]/gu, ''), '', '无人声不该有实义文本');
    ok('端到端反例：无人声样本不采纳分段（不编台词）');
  }
}

// ── 21. 接线：分段分支必须真接在 #audioLine 里、acceptSegments 必须真被调用 ──
// 端到端用例在"未复现"时会记跳过，所以"整块被删掉"这种情况它抓不住。
// 这一项是结构断言（与第 12 项零网络同一思路），锁的是接线本身。
{
  const vr = fs.readFileSync(path.join(ROOT, 'src', 'video-reader.js'), 'utf8');
  const at = vr.indexOf('音轨分段转写');
  assert.ok(at > 0, '#audioLine 必须有分段文案分支，否则模型只能看到一句"没人声"');
  const segFlag = vr.lastIndexOf('audio.segmented', at);
  assert.ok(segFlag > 0, '分段文案要用 audio.segmented 判定');
  const noSpeech = vr.indexOf('if (noSpeech || !body)', at);
  assert.ok(noSpeech > at, '分段分支必须排在 noSpeech 判断**之前**，否则分段结果会被"没人声"截走');

  const plug = fs.readFileSync(path.join(ROOT, 'plugins', 'media-audio', 'index.js'), 'utf8');
  assert.ok(/if \(acceptSegments\(hits, p\.text\)\)/.test(plug),
    'acceptSegments 必须真的在 transcribe 里被调用（写了没接等于没做）');
  ok('接线：分段文案在 noSpeech 之前 / acceptSegments 已接入');
}

// ── 22. 文案分流：分段结果必须渲染出时间轴，其余三种不受影响 ──
{
  const { formatAudioLine: F } = await import('../src/video-reader.js');
  const segNote = F({
    ok: true, lang: 'ja', text: 'おちんちん！ Deep. Seek!', truncated: true, segmented: true,
    segments: [
      { start: 0, end: 3, text: 'おちんちん！' },
      { start: 9, end: 12, text: 'Deep.' },
      { start: 12, end: 15, text: 'Seek!' },
    ],
  });
  assert.ok(/音轨分段转写/.test(segNote), '分段结果要走分段文案');
  assert.ok(/\[第0~3秒\]/.test(segNote), '每段必须带时间轴，否则模型不知道哪句在前');
  assert.ok(/只处理了前段/.test(segNote), 'truncated 要说清没听完');
  assert.ok(/可能听错/.test(segNote), '要提醒个别段是误识');

  const plain = F({ ok: true, lang: 'zh', text: '开饭时间早上9点至下午5点。', truncated: false });
  assert.ok(/音轨转写/.test(plain), '普通结果走老文案');
  assert.ok(!/分段/.test(plain), '普通结果不能出现"分段"字样');

  const quiet = F({ ok: true, lang: 'en', text: '.', truncated: false });
  assert.ok(/没有检测到人声/.test(quiet), '无人声文案不变');

  assert.equal(F({ ok: false, code: 'no_provider', silent: true }), '', 'silent 必须返回空串，上层沿用旧句');
  ok('formatAudioLine：分段 / 普通 / 无人声 / silent 四种分流正确');
}

// ── 12. 零网络（底线 3）──
{
  const src = fs.readFileSync(path.join(ROOT, 'plugins', 'media-audio', 'index.js'), 'utf8');
  const codeOnly = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/\bfetch\s*\(/.test(codeOnly), '插件里不得出现 fetch');
  assert.ok(!/require\(['"]node:https?['"]\)|from ['"]node:https?['"]/.test(codeOnly), '不得引入 http/https 模块');
  ok('零网络：代码里没有 fetch / http(s) 模块');
}

console.log(`  ── media-audio：${passed} 项通过`);
