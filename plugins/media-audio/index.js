// 语音识别（media-audio）
//
// ── 这个插件解决什么 ──
// 语音消息入库时只留 `[语音]` 两个字，视频音轨被 ffmpeg 主动排除 —— 模型手里
// 从来没有声音内容，只能靠猜。本插件提供 `media.transcribe` 能力：
// 给一段音频，返回文本；核心的 onebot.js 与 video-reader.js 按能力名取用。
//
// ── 为什么是 plugins/ 而不是 skills/ ──
// 识别是确定性工作（给音频出文本），不需要模型判断，也不需要模型知道它存在。
// 按 skills/manifest.js 的 DIR_KIND 约定放 plugins/，由核心按能力名调用。
//
// ── 为什么是 sherpa-onnx 而不是 whisper ──
// whisper small 在普通 CPU 上接近 1x 实时（60 秒音频要跑 30–60 秒），而入库是
// 串行 await，这会把整条消息卡半分钟。SenseVoice 非自回归，实测 RTF 0.06–0.10
// （60 秒 3.7s、180 秒 17.8s，4 线程），还能顺带给语种。
//
// ── 二进制为什么是 shared 版 ──
// 施工方案原本选的是单文件 `sherpa-onnx-non-streaming-asr-x64.exe`，
// 实测那是 **PE GUI 子系统**（Subsystem=2）：spawn 出去 60 秒不写一个字节，
// 管道、重定向都拿不到输出，退出码也不稳定。同一个 release 里的
// `sherpa-onnx-v2.0.1-win-x64-shared-MT-Release.tar.bz2` 带的
// `sherpa-onnx-offline.exe` 是 console 子系统，参数完全一致、行为正常，
// 所以用它 + 三个 DLL（onnxruntime / providers_shared / c-api），同放 tools/sherpa/。
//
// ── 三个刻意的设计 ──
//   · available() 必须同步：调用方用 `r === false` 判定，返回 Promise 会被
//     当成"可用"（tools-skill-audit 有硬断言）。
//   · 同一时刻只跑一份推理：多份并发会让每一条都超时，表现为"全都失败"。
//   · 「没人声」和「识别失败」必须分开：前者 ok:true+空文本，后者 ok:false+原因。
//     把超时说成静音，会让模型以为看过一段安静的视频。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// plugins/media-audio → 项目根。不能用 path.dirname(DATA_DIR)：测试里设了
// QQ_AGENT_DATA_DIR 之后那个根是临时目录（视频抽帧插件踩过）。
const APP_ROOT = path.resolve(HERE, '..', '..');

const WAV_RATE = 16000;          // SenseVoice 只吃 16k
const WAV_BYTES_PER_SEC = 32000; // 16k × 单声道 × 16bit / 8

const EXE_NAMES = process.platform === 'win32'
  ? ['sherpa-onnx-offline.exe', 'sherpa-onnx-non-streaming-asr-x64.exe']
  : ['sherpa-onnx-offline', 'sherpa-onnx-non-streaming-asr'];

const MODEL_FILES = ['model.int8.onnx', 'tokens.txt'];

// 与 plugin.json 的 settings 保持一致：清单里的默认值主要给 UI 展示，
// 运行期以这里为准（用户没改过配置时 getSkillConfig 也回默认值，这里是第二道保险）。
const DEFAULTS = {
  enabled: true,
  maxThreads: 4,
  voiceMaxSec: 60,
  videoMaxSec: 180,
  voiceBudgetMs: 8000,
  videoBudgetMs: 25000,
  useItn: true,
  voiceStartWaitMs: 8000,   // 语音最多排队等多久
  queueDeadlineMs: 60000,   // 语音绝对时限（兜底，正常由 startWait 先生效）
};

export function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ── 配置与二进制探测 ──────────────────────────────────────────────────────

let cfgOf = () => ({});

/** 配置读取必须永不抛：插件被停用/重载期间 api.config() 可能失效。 */
function safeCfg() {
  try { return cfgOf() || {}; } catch { return {}; }
}

function exeCandidates() {
  // ⚠️ env 是**独占覆盖**，不是"再加一个候选"。写成前置候选的话，循环会继续
  //    找到 tools/sherpa 里的真实 exe，于是"模型装好之后"反而测不出"没装"的分支。
  const env = String(process.env.QQ_AGENT_ASR || '').trim();
  if (env) return [env];
  return EXE_NAMES.map((n) => path.join(APP_ROOT, 'tools', 'sherpa', n));
}

function modelDirCandidates() {
  const env = String(process.env.QQ_AGENT_ASR_MODEL || '').trim();
  if (env) return [env];
  return [path.join(APP_ROOT, 'tools', 'sherpa', 'sense-voice')];
}

let verdict = null;
let verdictAt = 0;
const VERDICT_TTL_MS = 60_000;

/**
 * 「这条路现在走得通吗」：{ ok, reason }。**同步返回**（坑 1）。
 *
 * 不用 spawnSync 验可执行：available() 每次入库都会被问，spawn 一次几百毫秒太贵。
 * existsSync 已能过滤"没装"这个主要情况；exe 损坏属极少数，由熔断兜住。
 */
export function available() {
  const now = Date.now();
  if (verdict && now - verdictAt < VERDICT_TTL_MS) return verdict;

  let exe = '';
  for (const p of exeCandidates()) {
    try { if (fs.existsSync(p)) { exe = p; break; } } catch { /* ignore */ }
  }
  if (!exe) {
    verdict = { ok: false, reason: '未找到语音识别程序（应放在 tools/sherpa/）' };
    verdictAt = now;
    return verdict;
  }

  let modelDir = '';
  for (const d of modelDirCandidates()) {
    try {
      if (MODEL_FILES.every((f) => fs.existsSync(path.join(d, f)))) { modelDir = d; break; }
    } catch { /* ignore */ }
  }
  if (!modelDir) {
    verdict = { ok: false, reason: '未找到语音识别模型（应放在 tools/sherpa/sense-voice/）' };
    verdictAt = now;
    return verdict;
  }

  verdict = { ok: true, exe, modelDir };
  verdictAt = now;
  return verdict;
}

// ── 进程入口 ──────────────────────────────────────────────────────────────

/**
 * 跑一条命令，收集 stdout/stderr。超时/启动失败/非零退出都返回结果，不抛。
 *
 * ⚠️ timer 必须在 finish 之前声明：在 finish 里引用后声明的 `let timer` 会
 *    TDZ 报错，而 `node --check` 查不出来（只在运行到超时分支时炸）。
 */
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child = null;
    let timer = null;
    let done = false;

    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { child?.kill(); } catch { /* ignore */ }
      resolve(v);
    };

    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      finish({ code: -1, out: '', err: String(e?.message || e), timeout: false });
      return;
    }

    timer = setTimeout(() => finish({ code: -1, out, err, timeout: true }), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ code: -1, out, err: err + String(e?.message || e), timeout: false }));
    child.on('close', (code) => finish({ code, out, err, timeout: false }));
  });
}

// ── ffmpeg 探测（与 video-frames 同一个顺序）──────────────────────────────

function ffmpegCandidates() {
  const list = [];
  const env = String(process.env.QQ_AGENT_FFMPEG || '').trim();
  if (env) list.push(env);
  list.push(path.join(APP_ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe'));
  list.push(path.join(APP_ROOT, 'tools', 'ffmpeg', 'ffmpeg'));
  list.push('ffmpeg', 'ffmpeg.exe');
  return list;
}

let cachedFf = '';
let probing = null;
async function resolveFfmpeg() {
  if (cachedFf) return cachedFf;
  if (probing) return probing;
  probing = (async () => {
    for (const cand of ffmpegCandidates()) {
      const r = await run(cand, ['-version'], 5000);
      if (r && r.code === 0) { cachedFf = cand; return cand; }
    }
    return '';
  })();
  try { return await probing; } finally { probing = null; }
}

// ── 取音频 ────────────────────────────────────────────────────────────────

/**
 * 两种输入统一成"磁盘上的一个文件"：
 *   A. 视频音轨 —— 文件已经在本地（video-reader 传 filePath）
 *   B. 语音消息 —— 让协议端 get_record 转成 mp3，不用自己解 silk
 */
async function materializeAudio(input) {
  if (input.filePath) {
    const p = String(input.filePath);
    if (!fs.existsSync(p)) throw Object.assign(new Error('音频文件不存在'), { code: 'no_source' });
    return { src: p, tmp: '' };
  }

  const d = input.record || {};
  const file = String(d.file ?? d.url ?? '');
  if (!file) throw Object.assign(new Error('语音段里没有文件标识'), { code: 'no_source' });
  if (!input.onebot) throw Object.assign(new Error('缺少 OneBot 客户端'), { code: 'no_source' });

  const ret = await input.onebot.call('get_record', { file, out_format: 'mp3' }, 15000);

  // 协议端返回形态不统一：有的给 base64，有的给一个已经转好的文件路径。
  // 只认 base64 会在"返回路径"的实现上静默失败，表现是语音永远 [语音]，
  // 用户只会以为"插件没装"。两种都接。
  const asPath = String(ret?.file || ret?.path || '');
  if (asPath && fs.existsSync(asPath)) return { src: asPath, tmp: '' };

  const b64 = String(ret?.base64 || '');
  if (!b64) {
    // 真机排查靠这一行：这条链路唯一的失败是静默的（只剩 [语音]），
    // 只报"没有返回音频数据"等于什么都没说。把返回结构的字段名带上，
    // 才能判断是形态不同（有别的字段名）还是根本没返回。
    const shape = ret && typeof ret === 'object'
      ? Object.keys(ret).join(',') || '空对象'
      : typeof ret === 'undefined' ? 'undefined' : typeof ret;
    throw Object.assign(
      new Error(asPath
        ? `协议端给了路径但文件不存在：${asPath}`
        : `协议端没有返回音频数据（返回字段：${shape}）`),
      { code: 'no_source' }
    );
  }

  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw Object.assign(new Error('音频数据为空'), { code: 'no_source' });

  const tmp = path.join(os.tmpdir(), `qqa_ptt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.mp3`);
  fs.writeFileSync(tmp, buf);
  return { src: tmp, tmp };
}

export function parseDurationSec(stderr) {
  const m = String(stderr || '').match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 转 16k 单声道 wav（SenseVoice 只吃这个格式），顺手拿源时长。 */
async function toWav16k(ffmpeg, src, maxSec) {
  const out = path.join(os.tmpdir(), `qqa_asr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.wav`);
  const args = ['-hide_banner', '-y'];
  // -t 放在 -i 之前 = 只解码输入的前 N 秒。长视频省的是解码时间，不只是输出变短
  if (maxSec > 0) args.push('-t', String(maxSec));
  args.push('-i', src, '-vn', '-ac', '1', '-ar', String(WAV_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', out);

  const r = await run(ffmpeg, args, 30000);
  if (!fs.existsSync(out)) {
    const e = new Error(r?.err ? String(r.err).trim().slice(-300) : 'ffmpeg 没有产出 wav');
    e.code = 'no_audio';
    throw e;
  }
  const size = fs.statSync(out).size;
  // 空 wav 不止 44 字节：ffmpeg 会带 LIST/fact 等 chunk，实测常见 78~92 字节。
  // 取 1KB 作阈值，避免把 0.02 秒的噪声当成有人声。
  if (size <= 1024) {
    try { fs.unlinkSync(out); } catch { /* ignore */ }
    const e = new Error('音频为空（源文件没有声音，或没有可解码的音轨）');
    e.code = 'no_audio';
    throw e;
  }
  return {
    wav: out,
    seconds: size / WAV_BYTES_PER_SEC,
    srcSeconds: parseDurationSec(r?.err || ''),   // 源文件总时长，判断是否被 -t 截断
  };
}

// ── 分段兜底参数（2026-11-08 本机 43 个真实视频实测得出）─────────────────
//
// 整段喂给 SenseVoice 会整体吞掉稀疏人声：17.47 秒真对话整段 → `お！`（1 个字），
// 同样内容切 3 秒 → 5 段，`Deep` / `Seek` 都在。
//
// 但切段会把静音也"听"出东西：43 个样本里整段无可用文本的有 19 个，
// 单靠「≥2 段有内容」这一条，其中 12 个会凑出假台词
// （`The×5`、`그×3`、甚至"我的孩子我们怎么玩"这种完整句子）。
// 所以真正挡得住的是下面 SEG_REQUIRE_LANG + SEG_MIN_UNIQ 两条，见 transcribe 里的注释。
const SEG_SEC = 3;         // 段长下限。1.5 秒实测会凑词（The./嗯。），不做成配置项
const SEG_MAX = 8;         // 8 × 3 = 24 秒；超出部分不处理，标 truncated
const SEG_MIN_SEC = 2.5;   // 实测段长在 2.80~3.07 波动，17.47 秒的尾段 2.37 秒 → 丢掉
const SEG_MIN_HIT = 2;     // 至少 2 段有内容
const SEG_MIN_UNIQ = 2;    // 且至少 2 种不同文本（`The`×5 这种是噪声，不是对话）

// ── 推理与解析 ────────────────────────────────────────────────────────────

function runAsr(exe, modelDir, wav, { threads, useItn, budgetMs }) {
  return run(exe, [
    `--tokens=${path.join(modelDir, 'tokens.txt')}`,
    `--sense-voice-model=${path.join(modelDir, 'model.int8.onnx')}`,
    `--num-threads=${threads}`,
    `--sense-voice-use-itn=${useItn ? 1 : 0}`,
    '--debug=0',
    wav,
  ], budgetMs);
}

/** 一次加载模型、识别多个 wav。参数与 runAsr 一致，尾巴换成文件列表。 */
function runAsrMany(exe, modelDir, wavs, { threads, useItn, budgetMs }) {
  return run(exe, [
    `--tokens=${path.join(modelDir, 'tokens.txt')}`,
    `--sense-voice-model=${path.join(modelDir, 'model.int8.onnx')}`,
    `--num-threads=${threads}`,
    `--sense-voice-use-itn=${useItn ? 1 : 0}`,
    '--debug=0',
    ...wavs,
  ], budgetMs);
}

/**
 * 把 16k 单声道 wav 切成固定长度的段。
 * 一次 ffmpeg 调用切完（`-f segment`），实测 17.47 秒音频耗时 49ms。
 *
 * @returns {Promise<{files: Array<{path:string, sec:number, start:number}>, dir: string}>}
 *          没有可用段时返回 { files: [], dir: '' }
 */
async function splitWav(ffmpeg, wav, { segSec = SEG_SEC, maxSegs = SEG_MAX } = {}) {
  const dir = path.join(
    os.tmpdir(),
    `qqa_seg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  );
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return { files: [], dir: '' }; }

  // 切超时也接受已经落盘的段：能拿几段是几段，不整体失败
  await run(ffmpeg, [
    '-hide_banner', '-y',
    // -t 在 -i 之前 = 只解码前 N 秒，长视频不白跑（30 分钟的视频只解 24 秒）
    '-t', String(segSec * maxSegs),
    '-i', wav,
    '-f', 'segment', '-segment_time', String(segSec),
    '-reset_timestamps', '1',
    '-c', 'copy',                                   // 不重编码；实测整段 49ms
    path.join(dir, 's_%02d.wav'),
  ], 15000);

  const files = [];
  let acc = 0;
  try {
    const names = fs.readdirSync(dir).filter((n) => /^s_\d+\.wav$/.test(n)).sort();
    for (const name of names) {
      const p = path.join(dir, name);
      const sec = fs.statSync(p).size / WAV_BYTES_PER_SEC;
      if (sec < SEG_MIN_SEC) { try { fs.unlinkSync(p); } catch { /* ignore */ } continue; }
      // 起点用**累计时长**，不用 `files.length * segSec`：中间段万一被删会整体漂。
      // 实测段长在 2.946~3.074 之间交替（PCM 按帧对齐），累计才准。
      files.push({ path: p, sec, start: Math.round(acc) });
      acc += sec;
    }
  } catch { /* ignore */ }

  if (!files.length) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { files: [], dir: '' };
  }
  return { files, dir };
}

export function stripTag(v) {
  return String(v || '').replace(/^<\|/, '').replace(/\|>$/, '').trim();
}

/**
 * 去掉空白与标点，只留"实义字"。
 *
 * 判"这段到底有没有内容"一律用这个口径 —— 实测 sherpa 对纯噪声会返回 `"."`，
 * 对稀疏人声返回 `"お！"`：按 `text` 是否为空判会被这两个骗过去。
 */
export function stripBody(s) {
  return String(s || '').replace(/[\s\p{P}]/gu, '');
}

/**
 * 分段结果是否采纳。**这是本单唯一的安全阀**，抽成纯函数是为了能被单测锁住：
 * 靠真实视频做回归，缓存 72 小时被清之后就没人守了。
 *
 * 两条缺一不可（2026-11-08 本机 43 个真实视频、按线上 videoMaxSec=180 实测）：
 *
 *  ① **整段至少识别出一个实义字**。这是最关键的一条：整段只有 `.` / `。` 时，
 *     说明模型压根没"听到"语音，切段凑出来的全是噪声。实测 4 例误采纳全部命中：
 *       `The. あ。`、`Yeah. 大じだ。 Yeah. Yeah. 分りました.`
 *       `The. 每当母亲我唱来。 多你。 朝着一不。 天你不管我苍。`
 *     而目标视频整段是 `お！`（有 1 个实义字）—— 说明确实有人声、只是被整段吞了。
 *
 *  ② **各段文本去重后 ≥2 种**。同一个词反复出现是噪声不是对话：
 *     挡住 `The×5`、`The×3`、`그×3`、`I×2`。
 *
 * 只留"≥2 段有内容"时，19 个触发样本里 5 个会吐假台词；两条都加后只剩 1 个，
 * 就是目标视频。
 *
 * ⚠️ 曾经用 `lang !== 'nospeech'` 当第二条判据，实测是错的：整段判 nospeech
 * 仍可能吐字（前置单记录过 v_e721ffcfede6 标 nospeech 却出 4 个字），那样会误杀
 * 真正的稀疏人声。判据一律看"有没有实义字"，不看 lang。
 *
 * @param {Array<{text:string}>} hits       已过滤掉空段的命中
 * @param {string} wholeText                整段识别的原始文本
 */
export function acceptSegments(hits, wholeText) {
  if (!Array.isArray(hits) || hits.length < SEG_MIN_HIT) return false;
  if (stripBody(wholeText).length < 1) return false;
  return new Set(hits.map((h) => stripBody(h.text))).size >= SEG_MIN_UNIQ;
}

/**
 * 从 sherpa 的 stdout 里抠出文本与标签。
 *
 * 实测（v2.0.1 shared 版 sherpa-onnx-offline.exe，5.6 秒中文样本）：stdout 就是
 * **一段纯 JSON**，没有 `0: ` 之类的前缀，整段一行，末尾 \r\n：
 *   {"lang": "<|zh|>", "emotion": "<|NEUTRAL|>", "event": "<|Speech|>",
 *    "text": "开饭时间早上9点至下午5点。", "timestamps": [...], "tokens": [...]}
 * 所以按"从每行里截出第一个 { 到最后一个 }"解析即可，前缀有没有都不影响。
 * 多行（一次传多个 wav）时逐行取、文本直接拼接。
 */
export function parseAsrOutput(stdout) {
  const texts = [];
  let lang = '';
  let emotion = '';
  let event = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const s = line.indexOf('{');
    const e = line.lastIndexOf('}');
    if (s < 0 || e <= s) continue;
    let obj = null;
    try { obj = JSON.parse(line.slice(s, e + 1)); } catch { continue; }
    const t = String(obj?.text ?? '').trim();
    if (t) texts.push(t);
    if (!lang && obj?.lang) lang = obj.lang;
    if (!emotion && obj?.emotion) emotion = obj.emotion;
    if (!event && obj?.event) event = obj.event;
  }
  return { text: texts.join('').trim(), lang: stripTag(lang), emotion: stripTag(emotion), event: stripTag(event) };
}

/**
 * 多文件输出按行解析，保留"第几行对应哪一段"的顺序。
 *
 * 不能复用 parseAsrOutput：那个函数把各段文本 join('') 抹平了，拿不到每段独立的时间。
 *
 * ⚠️ 行首编号是**兼容性兜底，不是主路径**。实测本机 v2.0.1 shared 版、
 * 一次传 6 个 wav：输出 6 行，**每行都是纯 JSON，没有 `0: ` 前缀**，
 * 所以 idx 恒为 -1，调用方走"行数等于文件数则按顺序映射"那条分支。
 * 43 个真实样本里"输出行数 ≠ 传入文件数"的有 0 个（静音段也会输出一行，内容为 "."），
 * 所以按顺序映射在当前版本上是可靠的；编号解析只为防将来版本改格式。
 */
export function parseAsrSegments(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const s = line.indexOf('{');
    const e = line.lastIndexOf('}');
    if (s < 0 || e <= s) continue;
    let o = null;
    try { o = JSON.parse(line.slice(s, e + 1)); } catch { continue; }
    const prefix = line.slice(0, s).trim();
    const m = prefix.match(/(\d+)\s*:?\s*$/);
    out.push({
      idx: m ? Number(m[1]) : -1,
      text: String(o?.text ?? '').trim(),
      lang: stripTag(o?.lang),
      event: stripTag(o?.event),
      emotion: stripTag(o?.emotion),
    });
  }
  return out;
}

// ── 队列、截止时刻、熔断 ──────────────────────────────────────────────────

let chain = Promise.resolve();

/** 单飞：同一时刻只跑一份推理。多份并发会让每一条都超时（坑 3）。 */
function enqueue(job) {
  const next = chain.then(() => job(), () => job());
  chain = next.then(() => {}, () => {});
  return next;
}

let failStreak = 0;
let cooldownUntil = 0;
const FAIL_STREAK_LIMIT = 3;
const COOLDOWN_MS = 5 * 60_000;

/**
 * 「预期内的失败」：源文件没有声音、拿不到文件。这类非常常见（录屏、纯音乐、
 * 过期语音），**不能计入连击** —— 否则三个无声视频就把语音识别整体停 5 分钟，
 * 而用户完全看不出是为什么。只有进程异常退出这类才算真故障。
 */
const EXPECTED_CODES = new Set(['no_audio', 'no_source']);

/**
 * 「启动等待上限」：单通道排队，先来后到不变，但**可以放弃排队**。
 * 取值依据是对方的预算：
 *   · 视频等 10 秒 —— 能跨过一条语音（预算 8 秒），跨不过一条视频（25 秒）
 *   · 语音等 8 秒   —— 等于自己的一次预算；排在视频后面时，等满就该放弃
 */
const VIDEO_START_WAIT_MS = 10000;
const VOICE_START_WAIT_MS = 8000;

function fail(code, error) {
  return {
    ok: false, text: '', lang: '', emotion: '', event: '',
    music: null, truncated: false, tookMs: 0, code, error: String(error || '')
  };
}

/**
 * 能力 media.transcribe 的实现。
 *
 * @param {{filePath?: string, record?: object, onebot?: object, kind?: 'video'|'voice'}} input
 * @returns {Promise<{ok: boolean, text: string, lang: string, emotion: string,
 *                    event: string, music: null, truncated: boolean, tookMs: number,
 *                    code: string, error: string}>}
 */
export async function transcribe(input = {}) {
  const cfg = { ...DEFAULTS, ...safeCfg() };
  if (cfg.enabled === false) return fail('disabled', '语音识别已关闭');

  const av = available();
  if (!av.ok) return fail('no_provider', av.reason);

  if (Date.now() < cooldownUntil) return fail('cooldown', '连续失败后暂时停用');

  const isVideo = input.kind === 'video';
  const maxSec = clampInt(isVideo ? cfg.videoMaxSec : cfg.voiceMaxSec, isVideo ? 180 : 60, 5, 1800);
  const budgetMs = clampInt(isVideo ? cfg.videoBudgetMs : cfg.voiceBudgetMs, isVideo ? 25000 : 8000, 2000, 60000);
  // 两条上限：startBy = 排队到"开始跑"为止的容忍；deadline = 绝对死线（仅语音）。
  // 正常配置下 startBy 先生效，deadline 只在把 voiceStartWaitMs 调到 60 秒以上才有意义。
  const now = Date.now();
  const startWait = isVideo ? VIDEO_START_WAIT_MS : clampInt(cfg.voiceStartWaitMs, VOICE_START_WAIT_MS, 1000, 300000);
  const startBy = now + startWait;
  const deadline = isVideo ? 0 : now + clampInt(cfg.queueDeadlineMs, 60000, 5000, 300000);

  // ⚠️ 放弃排队必须在**队列外面**判定。
  //
  // 施工单 v1.2 把 `Date.now() > startBy → busy_skipped` 写在 job 内部，看着对，
  // 实际不成立：enqueue 要等前一个 job 结束才执行这个 job，所以这行判断要等到
  // "前一条跑完"才会被执行。实测（180 秒音轨占着队列、紧接着来一条语音）：
  // 语音等了 **24.95 秒**才拿到 busy_skipped —— 正好是前一条跑完的时刻，
  // 而不变式 11 要求"8 秒内必然开始或放弃"。对入库来说这是硬伤：
  // transcribeVoice 是 await 的，这条语音把整条消息卡了 25 秒。
  //
  // 现在改成：队列里跑真正的活，外面同时挂一个"到点就认输"的定时器，
  // 谁先到用谁；job 真轮到时会看到已经超过 startBy，直接空转返回、不浪费推理。
  const SKIP_BUSY = Symbol('busy_skipped');
  const SKIP_EXPIRED = Symbol('skipped_expired');
  const GO = 'go';
  let giveUpTimer = null;
  let markStarted = null;
  // 「真的开始跑了」的信号：一旦发出，就不再认输（认输只对"还没轮到"有意义）
  const started = new Promise((resolve) => { markStarted = resolve; });

  const job = enqueue(async () => {
    const t0 = Date.now();
    if (Date.now() > startBy) return SKIP_BUSY;      // 轮到已太晚 → 什么都不做
    if (deadline && Date.now() > deadline) return SKIP_EXPIRED;

    // 预算不能超过剩余时间
    const left = deadline ? Math.max(0, deadline - Date.now()) : budgetMs;
    const budget = deadline ? Math.min(budgetMs, left) : budgetMs;
    if (budget < 1000) return SKIP_EXPIRED;

    markStarted(GO);                                  // 从这里往下都是在真干活，外面别再打断

    const ffmpeg = await resolveFfmpeg();
    if (!ffmpeg) return fail('no_ffmpeg', '没有可用的 ffmpeg');

    let a = null;
    let w = null;
    try {
      a = await materializeAudio(input);
      w = await toWav16k(ffmpeg, a.src, maxSec);
      // 声明必须放在分段块**之前**：分段块要拿它算"有没有覆盖全长"，
      // 而 `const` 在同一块内先引用后声明是 TDZ ReferenceError，
      // `node --check` 查不出来，只有真跑到那条分支才炸。
      const srcSec = w.srcSeconds || 0;

      const r = await runAsr(av.exe, av.modelDir, w.wav, {
        threads: clampInt(cfg.maxThreads, 4, 1, 16),
        useItn: cfg.useItn !== false,
        budgetMs: budget,
      });

      if (r?.timeout) {
        const p = parseAsrOutput(r.out);
        // 一个字都没出来就不是"没人声"，是超时：无条件 ok:true 会让上层渲染成
        // 「音轨里没有人声」，等于让模型以为看过一段安静的视频。
        if (!p.text) {
          failStreak += 1;
          if (failStreak >= FAIL_STREAK_LIMIT) cooldownUntil = Date.now() + COOLDOWN_MS;
          return fail('timeout', '处理超时，没来得及识别出内容');
        }
        // 超时但已有部分文本：交出去并标 truncated，别整体丢弃
        failStreak = 0;
        return {
          ok: true, text: p.text, lang: p.lang, emotion: p.emotion, event: p.event,
          music: null, truncated: true, tookMs: Date.now() - t0, code: 'timeout', error: '',
        };
      }

      const p = parseAsrOutput(r?.out || '');

      // ── 分段兜底 ─────────────────────────────────────────────────────
      // 触发口径是"整段没有可用文本"，**不是** `!p.text`：
      // 2026-11-08 本机 43 个真实视频实测，整段 `text` 严格为空的 **0 个** ——
      // 目标视频返回 `お！`（lang=ja），无人声视频返回 `.`。
      // 写成 `!p.text` 等于这段代码永不执行。
      if (r?.code === 0 && stripBody(p.text).length <= 1) {
        // 先算剩余预算：整段已经吃掉 7.9 秒时再给 2 秒，总耗时会顶破 8 秒预算
        const left = budget - (Date.now() - t0);
        if (left >= 1500) {
          const split = await splitWav(ffmpeg, w.wav, { segSec: SEG_SEC, maxSegs: SEG_MAX });
          try {
            if (split.files.length) {
              const sr = await runAsrMany(av.exe, av.modelDir, split.files.map((f) => f.path), {
                threads: clampInt(cfg.maxThreads, 4, 1, 16),
                useItn: cfg.useItn !== false,
                budgetMs: left,
              });
              const parsed = parseAsrSegments(sr?.out || '');

              // 映射到具体段：有编号用编号；没有编号时按顺序，且**行数必须等于文件数**。
              // 实测本机两者恒等（静音段也会输出一行，内容为 "."），所以顺序映射可用；
              // 长度不等说明输出缺行，宁可整轮不采纳，也不能让后面时间戳整体前移。
              const hasIdx = parsed.some((g) => g.idx >= 0);
              let mapped = [];
              if (hasIdx) {
                mapped = parsed
                  .filter((g) => g.idx >= 0)
                  .map((g) => ({ g, f: split.files[g.idx] }))
                  .filter((x) => Boolean(x.f));
              } else if (parsed.length === split.files.length) {
                mapped = parsed.map((g, i) => ({ g, f: split.files[i] }));
              }

              const hits = [];
              for (const { g, f } of mapped) {
                const body = stripBody(g.text);
                if (!body) continue;                     // 空段 / 只有一个标点
                hits.push({ start: f.start, end: f.start + Math.round(f.sec), text: g.text, lang: g.lang });
              }

              if (acceptSegments(hits, p.text)) {
                failStreak = 0;
                const last = split.files[split.files.length - 1];
                const coveredSec = Math.round(last.start + last.sec);
                return {
                  ok: true,
                  text: hits.map((h) => h.text).join(' '),
                  lang: hits[0].lang,
                  emotion: '',
                  event: '',
                  segments: hits,
                  segmented: true,
                  music: null,
                  truncated: srcSec > coveredSec + 0.5,
                  tookMs: Date.now() - t0,
                  code: '',
                  error: '',
                };
              }
              // 不满足准入 → 当作没人声，继续走原来的返回（p.text 本来也没内容）
            }
          } finally {
            if (split.dir) { try { fs.rmSync(split.dir, { recursive: true, force: true }); } catch { /* ignore */ } }
          }
        }
      }

      if (r?.code !== 0 && !p.text) {
        failStreak += 1;
        if (failStreak >= FAIL_STREAK_LIMIT) cooldownUntil = Date.now() + COOLDOWN_MS;
        return fail('exception', String(r?.err || '').trim().slice(-200) || '识别进程异常退出');
      }

      failStreak = 0;
      return {
        ok: true,
        text: p.text,
        lang: p.lang,
        emotion: p.emotion,
        event: p.event,
        music: null,
        truncated: srcSec > maxSec + 0.5,
        tookMs: Date.now() - t0,
        code: '',
        error: '',
      };
    } catch (e) {
      const code = e?.code || 'exception';
      // 没有音频 / 拿不到文件是"预期情况"，不计入连击
      if (!EXPECTED_CODES.has(code)) {
        failStreak += 1;
        if (failStreak >= FAIL_STREAK_LIMIT) cooldownUntil = Date.now() + COOLDOWN_MS;
      }
      return fail(code, e?.message || String(e));
    } finally {
      // 临时文件一律删；mp3 是协议端转出来的、wav 是我们转的，路径可能为 ''
      if (w?.wav) { try { fs.unlinkSync(w.wav); } catch { /* ignore */ } }
      if (a?.tmp) { try { fs.unlinkSync(a.tmp); } catch { /* ignore */ } }
    }
  });

  // 到点就认输：与 job 赛跑。三条道谁先到用谁 ——
  //   started（已开跑）/ giveUp（等太久了）/ job 自己先返回（极端情况）
  const giveUpAt = Math.max(0, startBy - Date.now());
  const giveUp = new Promise((resolve) => {
    giveUpTimer = setTimeout(() => resolve(SKIP_BUSY), giveUpAt);
  });

  let first;
  try {
    first = await Promise.race([started, giveUp, job]);
  } finally {
    if (giveUpTimer) clearTimeout(giveUpTimer);
  }

  // 已经在跑了：老老实实等它跑完，不能因为"超过 startBy"就丢掉正在跑的活
  if (first === GO) return job;

  // 两种"跳过"要分开：忙 = 并发的正常取舍；过期 = 排队太久，排查方向不同
  if (first === SKIP_BUSY) {
    return fail('busy_skipped', isVideo ? '前面在忙，视频音轨本次跳过' : '前面在忙，这条语音本次跳过');
  }
  return fail('skipped_expired', '排队超过限时，已跳过');
}

export const providers = {
  'media.transcribe': (args) => transcribe(args),
  'media.transcribe.available': () => available()
};

export function setup(api) {
  cfgOf = () => {
    try { return api.config() || {}; } catch { return {}; }
  };
}

export const internals = {
  exeCandidates, modelDirCandidates, ffmpegCandidates,
  parseAsrOutput, parseDurationSec, clampInt, run, stripTag, enqueue,
  DEFAULTS,
  // 分段兜底（2026-11-08）
  parseAsrSegments, splitWav, resolveFfmpeg, stripBody, acceptSegments,
  SEG_SEC, SEG_MAX, SEG_MIN_SEC, SEG_MIN_HIT, SEG_MIN_UNIQ,
};
