// 视频读取：探测视频元信息（时长/分辨率/大小/格式），并按配置决定怎么让模型"看"到画面。
//
// ── 两条路线（互斥，由 config.api.videoMode 决定）──────────────────────
//   native 全模态模型直接读视频：把视频地址作为 video 部分发给模型。
//          由设置页的「视频输入专用模型」声明"我有这种模型"，核心不猜。
//   frames 抽帧：把视频变成若干张图片，任何视觉模型都能用。
//          实现放在 `plugins/video-frames`（capability `video.frames`）——
//          是确定性型插件，不是 LLM 型技能；本模块通过能力名取用，
//          关掉插件就自动退回"只给元信息"。
//
// 为什么不两条一起喂：同一段内容重复计费，而且视频部分和图片部分混在一起
// 多数网关会因格式冲突直接 400。二选一是刻意的设计，不是偷懒。
//
// 探测元信息本身是**尽力而为**的：NapCat/SnowLuma 的视频缓存不一定在，
// ffprobe/ffmpeg 也不一定装了。每一步失败都降级，绝不抛出让模型看到一串技术错误。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getConfig } from './config.js';
import { safeFetchBinaryToFile } from './safe-fetch.js';
import { skillManager } from './skills/manager.js';
import { logger } from './logger.js';

/** 单个视频上限 200MB（下载与预缓存共用）。 */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/**
 * 取文件失败的分类：给模型看的是人话，给测试看的是 code。
 *
 * 为什么用正则匹配文案而不是在 safe-fetch 里加 code：`safeFetchBinaryToFile`
 * 被图片、表情包、卡片多处复用，加字段要动公共模块；文案是它自己写的，
 * 正则够稳，且不打散影响面。
 */
const LOCALIZE_ERROR_RULES = [
  [/文件达到大小上限/, 'too_large'],
  [/download url has expired|HTTP 400/i, 'url_expired'],
  [/HTTP 40[13]/, 'forbidden'],        // 401/403；注意别把 403 判成"过期"
  [/HTTP 5\d\d/, 'server_error'],
  [/下载内容为空|0 字节/, 'empty_file'],
  [/fetch failed|ECONN|ETIMEDOUT|timeout|超时/i, 'network'],  // safe-fetch 抛的是中文「请求超时：host」
  [/无法获取视频文件/, 'no_source'],
];

/**
 * 错误对象/文本 → 原因码。导出供单测直接调。
 * ⚠️ 必须由**最内层**往外匹配：外层是通用的「无法获取视频文件」，
 *    先匹配它会把 cause 里的 too_large / url_expired 全盖成 no_source
 *    —— 而这正是改造前那条「文件 469MB 超过上限，却说直链过期」的错。
 */
export function classifyLocalizeError(err) {
  const chain = [];
  for (let e = err, i = 0; e && i < 5; i++, e = e.cause) chain.push(e);
  for (const e of chain.reverse()) {
    const text = String(e?.message ?? e ?? '');
    for (const [re, code] of LOCALIZE_ERROR_RULES) if (re.test(text)) return code;
  }
  return 'unknown';
}

const LOCALIZE_TEXT = {
  too_large: `视频文件超过 ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB 上限，没有下载`,
  url_expired: 'QQ 直链已过期（约 1 小时失效），且协议端没有本地缓存',
  forbidden: '下载被拒绝（403/401），可能是签名或权限问题',
  server_error: '下载时服务端报错（5xx），可稍后重试',
  empty_file: '下载到的文件是空的',
  network: '下载网络中断',
  no_source: '这条视频没有可用的本地文件或直链',
  unknown: '取不到这条视频的源文件',
};

const FRAME_FAIL_TEXT = {
  timeout: '抽帧超时（>120 秒），视频过长',
  no_frames: 'ffmpeg 没有产出任何画面',
  no_duration: '读不到视频时长（文件可能损坏或未下载完整）',
  no_ffmpeg: '没找到 ffmpeg',
  // "插件没装/被关"与"没找到 ffmpeg"是两条完全不同的排查方向，不能混用一个码
  no_provider: '抽帧能力不可用（插件未启用或已关闭）',
  no_file: '视频文件已被清理',
  exception: '抽帧过程出错',
};

/**
 * 音轨转写的失败码文案（plugins/media-audio 的 code）。
 *
 * 三条铁律：有文本就给文本；成功但空 = "没有人声"（不许出现"失败"字样）；
 * 失败要说失败**并给原因**，不许含糊成"没有声音" —— 模型分不清就会编台词。
 */
const AUDIO_FAIL_TEXT = {
  no_provider: '语音识别插件未启用或未安装',
  disabled: '语音识别已关闭',
  no_ffmpeg: '没有可用的 ffmpeg，取不到音轨',
  no_audio: '没有音轨，或音轨里没有声音',
  no_source: '取不到源文件',
  no_result: '语音识别没有返回结果',
  timeout: '处理超时',
  cooldown: '连续失败后暂时停用',
  skipped_expired: '排队超时已跳过',
  busy_skipped: '当时在忙，已跳过',
  exception: '处理时出错',
};

/** 允许的抽帧模式取值（配置写错时回退 auto）。 */
export const VIDEO_MODES = ['auto', 'native', 'frames', 'off'];

function videoCacheDir() {
  return path.join(DATA_DIR, 'video-cache');
}

/**
 * 缓存路径：按 media.file（QQ 侧的文件名）哈希，同一视频只有一份。
 * 返回 '' 表示这条媒体没有可用的定位信息。
 *
 * 改名前是 `v_<时间戳>_<随机>.mp4`：同一个视频下 4 次就存 4 份
 * （实测 3,476,803 B × 4 = 13.9MB）。哈希命名让预缓存、按需下载、重试
 * 都命中同一份；代价是"同一 dest 可能被并发写"（见 #fetchToCache）。
 */
export function cachePathFor(media = {}) {
  const seed = String(media?.file || media?.url || '').trim();
  if (!seed) return '';
  const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
  return path.join(videoCacheDir(), `v_${hash}.mp4`);
}

/**
 * 决定这次视频走哪条路。**纯函数**，方便测试与在 UI 里预览判定结果。
 *
 * @param {object} o
 *   mode       config.api.videoMode
 *   videoModel config.api.videoModel（非空 = 用户声明有全模态模型）
 *   framesOk   抽帧能力是否可用
 *   hasUrl     视频是否有可用的 http(s) 地址（native 需要）
 * @returns {{ route: 'native'|'frames'|'meta', reason: string }}
 */
export function resolveVideoRoute({ mode = 'auto', videoModel = '', framesOk = false, hasUrl = false } = {}) {
  const m = VIDEO_MODES.includes(String(mode)) ? String(mode) : 'auto';
  const omni = Boolean(String(videoModel || '').trim());

  if (m === 'off') return { route: 'meta', reason: 'videoMode=off：只读元信息，不喂画面' };

  if (m === 'native') {
    return hasUrl
      ? { route: 'native', reason: 'videoMode=native：按原生视频输入发送' }
      : { route: 'meta', reason: 'videoMode=native，但这条视频没有可用的 http(s) 地址' };
  }

  if (m === 'frames') {
    return framesOk
      ? { route: 'frames', reason: 'videoMode=frames：抽帧成图片' }
      : { route: 'meta', reason: 'videoMode=frames，但抽帧不可用（未找到 ffmpeg 或插件已关闭）' };
  }

  // auto：配了全模态模型就原生，否则抽帧，都不行只给元信息
  if (omni && hasUrl) return { route: 'native', reason: 'auto：已配置视频专用模型，按原生视频输入发送' };
  if (framesOk) return { route: 'frames', reason: 'auto：未配置视频专用模型，改用抽帧' };
  return { route: 'meta', reason: 'auto：既没有视频专用模型，抽帧也不可用，只读元信息' };
}

/** 调外部命令并收集 stdout（带超时）。 */
function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => { clearTimeout(timer); finish(out || null); });
  });
}

/** 调外部命令，只看退出码（带超时）。转码这类"不关心 stdout"的命令用它。 */
function runExitOk(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

/** 探测 ffprobe / ffmpeg 是否可用（缓存结果；都没找到时 60 秒后允许重探）。 */
let _ffprobePath = null;
let _ffmpegPath = null;
let _ffChecked = false;
let _ffCheckedAt = 0;
const FF_RETRY_MS = 60000;

/**
 * 项目根：用**模块相对**推，不用 path.dirname(DATA_DIR)。
 * DATA_DIR 可被 QQ_AGENT_DATA_DIR 指到任意目录（测试就这么干），那时 dirname
 * 算出来的"根"根本不是项目根，tools/ffmpeg 必然找不到。
 */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 先查项目内 tools/ffmpeg，再查 PATH —— 与插件里的 candidates() 同顺序。 */
function localBinNames(base) {
  return [
    path.join(APP_ROOT, 'tools', 'ffmpeg', `${base}.exe`),
    path.join(APP_ROOT, 'tools', 'ffmpeg', base),
    base, `${base}.exe`
  ];
}

async function ensureFf() {
  // 任一找到就长期缓存；都没找到（用户可能随后安装）60 秒后重探，免重启
  if (_ffChecked && (_ffprobePath || _ffmpegPath)) return { ffprobe: _ffprobePath, ffmpeg: _ffmpegPath };
  if (_ffChecked && Date.now() - _ffCheckedAt < FF_RETRY_MS) return { ffprobe: _ffprobePath, ffmpeg: _ffmpegPath };
  _ffChecked = true;
  _ffCheckedAt = Date.now();
  // 打包只带 ffmpeg.exe（tools/ffmpeg/ 实测没有 ffprobe.exe），所以这里的顺序是
  // 项目内 → PATH；本机两个都补了也一样：找不到就落到 PATH，保持原状不会更差。
  for (const cand of localBinNames('ffprobe')) {
    if (await run(cand, ['-version'], 5000)) { _ffprobePath = cand; break; }
  }
  for (const cand of localBinNames('ffmpeg')) {
    if (await run(cand, ['-version'], 5000)) { _ffmpegPath = cand; break; }
  }
  return { ffprobe: _ffprobePath, ffmpeg: _ffmpegPath };
}

export class VideoReader {
  constructor(onebot) {
    this.onebot = onebot;
  }

  /** 抽帧能力是否可用（插件生效 + ffmpeg 存在）。 */
  async framesAvailable() {
    // 统一问 video-frames 能力"这条路现在走得通吗"。
    // 不要在这里再探测一遍 ffmpeg —— 插件里已有一份判断，两份实现迟早不一致
    // （例如插件支持自定义 ffmpeg 路径，这里却不知道，于是界面说不可用、实际能用）。
    const providers = skillManager.getCapabilityProviders('video.frames.available', {});
    if (!providers.length) return false;   // 插件被关或没装 → 这条路不通
    for (const p of providers) {
      try {
        const r = await p.fn({});
        if (r?.ok === false) return false;
        if (r?.ok === true) return true;
      } catch { /* 探测异常按不可用处理 */ }
    }
    return false;
  }

  /** 当前配置下这条视频会走哪条路（UI 展示 / 排障用）。 */
  async describeRoute(media = {}) {
    const cfg = getConfig();
    const framesOk = await this.framesAvailable();
    const hasUrl = /^https?:\/\//i.test(String(media?.url || ''));
    return resolveVideoRoute({
      mode: cfg.api?.videoMode,
      videoModel: cfg.api?.videoModel,
      framesOk,
      hasUrl
    });
  }

  /**
   * 探测一个视频媒体（{ file, url, path }）的元信息，并按配置取回画面。
   *
   * @returns {Promise<{durationSec?, width?, height?, sizeBytes?, format?,
   *                    route: 'native'|'frames'|'meta', routeReason: string,
   *                    frames?: string[], frameTimes?: number[],
   *                    coverage?: {frames:number, stepSec:number, coveredSec:number, mode:string},
   *                    failure?: {code:string, message:string}, truncated?: boolean,
   *                    audio?: {ok:boolean, text?:string, lang?:string, truncated?:boolean,
   *                             tookMs?:number, code?:string, error?:string, silent?:boolean},
   *                    nativeUrl?: string, note: string}>}
   */
  async probe(media, { count = 0 } = {}) {
    const cfg = getConfig();
    const out = { note: '', route: 'meta', routeReason: '' };
    let planCount = 0;                 // 插件回报的"计划帧数"，给 truncated 用
    let localizeError = null;          // 留着给 classifyLocalizeError，别只留一个 null

    // 1. 拿到视频文件（本地缓存优先，其次下载 url）
    const filePath = await this.#localize(media).catch((e) => { localizeError = e; return null; });
    const hasFile = Boolean(filePath && fs.existsSync(filePath));

    if (hasFile) {
      try {
        out.sizeBytes = fs.statSync(filePath).size;
      } catch { /* ignore */ }
      // 2. ffprobe 读元信息
      const { ffprobe } = await ensureFf();
      if (ffprobe) {
        const meta = await this.#ffprobe(ffprobe, filePath);
        Object.assign(out, meta);
      }
    }

    // 3. 决定路线（元信息拿到之后再决定，因为 native 需要 url、frames 需要文件）
    const framesOk = hasFile && await this.framesAvailable();
    const hasUrl = /^https?:\/\//i.test(String(media?.url || ''));
    const routeInfo = resolveVideoRoute({
      mode: cfg.api?.videoMode,
      videoModel: cfg.api?.videoModel,
      framesOk,
      hasUrl
    });
    out.route = routeInfo.route;
    out.routeReason = routeInfo.reason;

    // 文件都没拿到时，别把原因说成"抽帧不可用" —— 02:04 那场就是被这句话
    // 带偏的。按分类器给出具体原因：太大、过期、403、网络，处置方式各不相同。
    if (!hasFile && routeInfo.route === 'meta') {
      const code = classifyLocalizeError(localizeError);
      // message 取最内层原因：外层那句「无法获取视频文件」对排障没有信息量
      const rawMessage = localizeError?.cause?.message || localizeError?.message || '';
      out.failure = { code, message: String(rawMessage).slice(0, 200) };
      out.routeReason = LOCALIZE_TEXT[code] || LOCALIZE_TEXT.unknown;
    }

    // 4. 按路线取画面
    if (routeInfo.route === 'native') {
      // 用户定稿规则 5（2026-09-19）：视频输入开启时，所有视频转码成
      // 最高 480p/24fps 的 mp4 再发给模型 —— 原始视频可能是 1080p/60fps 的
      // 几十 MB 文件，直接喂会把 token 预算炸穿（甚至被网关拒收）。
      // 转码失败（没 ffmpeg / 超时 / 产出异常）回退原 URL，不阻塞看视频。
      if (cfg.api?.video === true) {
        const transcoded = hasFile ? await this.#transcodeToMax480(filePath).catch(() => null) : null;
        if (transcoded) {
          out.nativeUrl = transcoded;
          out.routeReason += '；已转码 ≤480p/24fps';
        } else {
          out.nativeUrl = String(media.url);
        }
      } else {
        out.nativeUrl = String(media.url);
      }
    } else if (routeInfo.route === 'frames') {
      // 先试分镜图：1 张图覆盖 20 个时刻，既比 6 张独立图准、又便宜一半。
      // 失败（太长 / 扫描失败 / 格数不足 / 拼图失败）静默退回下面的均匀抽帧。
      let r = await this.#extractSheetViaSkill(filePath, {
        durationSec: out.durationSec, width: out.width, height: out.height,
      });
      if (r) {
        out.sheet = true;
      } else {
        r = await this.#extractViaSkill(filePath, { count, durationSec: out.durationSec });
        if (r && r.frames?.length) out.sheetFallback = true;
      }
      if (!out.durationSec && r.durationSec) out.durationSec = r.durationSec;
      if (!out.width && r.width) { out.width = r.width; out.height = r.height; }
      if (r.frames.length) {
        out.frames = r.frames;
        out.frameTimes = r.times;
        // 分镜图才有 cells/grid；均匀抽帧保持原样，不动它的字段
        const cellCount = Number(r.frameCount) || r.frames.length;
        if (Array.isArray(r.cells) && r.cells.length) {
          out.cells = r.cells;
          out.grid = r.grid || null;
        }
        const ts = Array.isArray(r.times) ? r.times : [];
        const t0 = ts[0] ?? 0;
        const tN = ts.length ? ts[ts.length - 1] : 0;
        const rawStep = ts.length > 1 ? (tN - t0) / (ts.length - 1) : (out.durationSec || 0);
        out.coverage = {
          // ⚠️ 是格数不是图数：分镜图 frames.length=1、cells.length=20
          frames: cellCount,
          // 分镜图的步长往往 <1 秒（0.88），四舍五入成整数会把"约每 1 秒"说成假的
          stepSec: r.mode === 'sheet' ? Number(rawStep.toFixed(2)) : Math.round(rawStep),
          coveredSec: Math.round(tN),
          mode: r.mode || '',
        };
        planCount = Number(r.count) || 0;
      } else {
        // 抽帧失败不当错误抛：退回元信息，并在 note 里说清
        out.route = 'meta';
        out.failure = { code: r.code || 'unknown', message: String(r.error || '').slice(0, 200) };
        out.routeReason = `${routeInfo.reason}；但抽帧未成功：${FRAME_FAIL_TEXT[r.code] || r.error || '未知原因'}`;
      }
    }

    // 5. 音轨转写（独立于画面路线：这次不喂画面，声音也该转）
    if (hasFile) {
      const audio = await this.#transcribeAudio(filePath);
      if (audio) out.audio = audio;
    }

    // truncated = 模型没拿到它该拿到的全部内容；配置明确不看画面（off）不算
    // ⚠️ 比的是**插件回报的计划帧数**，不是模型嘴上说的 count：
    //    模型不传 count 时那个值是 0，判定会永远为 false。
    // ⚠️ 分镜图的 frames 只有 1 张图，格数在 cells 里。拿 frames.length 比计划格数
    //    会得到 1 < 20 → 永远 truncated=true（而且看起来"很合理"，很难发现）。
    const gotCount = (out.cells?.length) ?? (out.frames?.length || 0);
    out.truncated = Boolean(out.failure)
      || (out.route === 'frames' && planCount > 0 && gotCount < planCount);

    out.note = this.#buildNote(out, { hasFile });
    return out;
  }

  /**
   * 通过 media.transcribe 能力转写音轨；能力不在（插件被关 / 没装）时返回带
   * `silent` 的标记，让上层沿用旧文案，而不是每条视频都多一句"音轨没有转写"。
   */
  async #transcribeAudio(filePath) {
    // 先问"这条路现在通吗" —— 与 framesAvailable() 同一形态。
    // 这不只是省一次入队：tools-skill-audit 会检查每个能力都有真实取用方，
    // media.transcribe.available 若没人调用就会被判成孤儿能力，npm test 直接红。
    const ready = skillManager.getCapabilityProviders('media.transcribe.available', {});
    if (!ready.length) return { ok: false, code: 'no_provider', silent: true };
    try {
      const st = await ready[0].fn({});
      if (st && st.ok === false) return { ok: false, code: 'no_provider', silent: true };
    } catch {
      // 探测本身抛了（极少见）就按"不可用"直接返回，别继续往下真转写
      return { ok: false, code: 'no_provider', silent: true };
    }

    const providers = skillManager.getCapabilityProviders('media.transcribe', {});
    if (!providers.length) return { ok: false, code: 'no_provider', silent: true };

    try {
      // 时长上限只由插件自己的配置决定，核心不传（两个来源必然打架）
      const r = await providers[0].fn({ filePath, kind: 'video' });
      if (!r) return { ok: false, code: 'no_result', silent: false };
      if (r.ok) {
        const text = String(r.text || '');
        const lang = String(r.lang || '');
        const event = String(r.event || '');
        // ── 音轨观测（2026-11-08）──────────────────────────────────────────
        // lang / event 是"这句到底有没有人说话"唯一的原始依据，但它们只在内存里
        // 过一遍、拼成一句话就散了：想复核"这条视频 event 到底给了什么"只能把
        // 视频重跑一遍。这两个值又恰恰是最容易误判的地方（对白叠配乐会被判成
        // BGM），所以先留一份可查的记录，观察一轮再决定要不要动判定逻辑。
        // 只记结构化字段、不记原文：原文该进对话，日志里再存一份只会撑大文件。
        try {
          logger.info('video', '音轨转写', {
            lang,
            event,
            chars: text.replace(/[\s\p{P}]/gu, '').length,
            truncated: Boolean(r.truncated),
            tookMs: Number(r.tookMs) || 0
          });
        } catch { /* 记日志失败不能连累转写结果 */ }
        return {
          ok: true,
          text,
          lang,
          // 音频事件（Speech / BGM / Applause / Laughter…）。⚠️ 它说的是"主导事件"，
          // 不是"有没有人声"：对白叠配乐时会被判成 BGM。只能当参考，不能拿来否决文本。
          event,
          truncated: Boolean(r.truncated),
          tookMs: Number(r.tookMs) || 0,
          // 分段兜底（2026-11-08）：整段吞掉稀疏人声时插件会改切 3 秒段重识别，
          // 这时 text 是各段拼接，时间轴要一起交上去，否则下游只能给一坨没有顺序的句子。
          segmented: r.segmented === true,
          segments: Array.isArray(r.segments) ? r.segments : [],
        };
      }
      return { ok: false, code: String(r.code || ''), error: String(r.error || '') };
    } catch (e) {
      return { ok: false, code: 'exception', error: e?.message || String(e) };
    }
  }

  /**
   * 音轨那一句文案。空串 = "本插件没参与"，由调用方决定说什么（没装时沿用旧文案）。
   * 三种结果必须能分开：有文本 / 成功但没人声 / 失败。
   */
  #audioLine(audio) {
    // 实现在模块级：纯函数抽出去才能被单测锁住四种文案的分流。
    // 端到端用例依赖 data/video-cache，72 小时清掉后就没守卫了。
    return formatAudioLine(audio);
  }

  /** 说明文案：让模型知道它拿到的是什么形式的内容。 */
  #buildNote(out, { hasFile }) {
    if (!hasFile) {
      // 复用分类结果，避免两处说法不一致（routeReason 已由 classifyLocalizeError 给出）
      return `取不到这条视频的源文件（${out.routeReason || '原因不明'}），只能告诉你它带了视频。`;
    }
    const bits = [];
    if (out.durationSec) bits.push(`时长 ${out.durationSec.toFixed(1)} 秒`);
    if (out.width && out.height) bits.push(`${out.width}×${out.height}`);
    if (out.sizeBytes) bits.push(`${(out.sizeBytes / 1024 / 1024).toFixed(1)}MB`);
    const head = bits.length ? `视频信息：${bits.join('，')}。` : '已获取视频文件，但读不到详细元信息（未安装 ffprobe）。';

    if (out.route === 'native') {
      return `${head}画面已作为**视频**发给多模态模型（原生视频输入）。`;
    }
    if (out.route === 'frames' && out.frames?.length) {
      const audioNote = this.#audioLine(out.audio);

      // ── 分镜图：1 张图里含 N 格 ──
      if (out.cells?.length) {
        return head + this.#sheetNote(out, audioNote);
      }

      // ── 均匀抽帧（原逻辑，一字不动）──
      const cov = out.coverage;
      const cover = cov?.stepSec
        ? `约每 ${cov.stepSec} 秒一张，覆盖到第 ${cov.coveredSec} 秒`
        : '';
      const head1 = `${head}已抽取 ${out.frames.length} 张画面截图${cover ? `（${cover}）` : ''}。`;
      // 插件没参与时**必须逐字回到接入前那句话**（分号而不是句号）：
      // 不变式要求"没装时文案与今天一字不差"，回滚声明也靠它。
      if (!audioNote) {
        return head1
          + '注意：这是截图不是连续视频，帧与帧之间的过程看不到；'
          + '也没有读取音频，视频里的人声、旁白、背景音乐不在其中。';
      }
      return `${head1}注意：这是截图不是连续视频，帧与帧之间的过程看不到。${audioNote}`;
    }
    if (out.route === 'meta') {
      const why = out.routeReason || '当前配置不喂画面';
      // 兜底必须是空串：插件没装时这句一加，文案就与接入前不一致了，回滚也不彻底
      const audioNote = this.#audioLine(out.audio);
      return `${head}本次不提供画面（${why}）。${audioNote}`;
    }
    return head;
  }

  /**
   * 分镜图的说明文案。
   *
   * 三个必须写进去的东西：
   *  1. 有几格、网格几行几列、从哪个方向读 —— 否则模型不知道 #15 在哪
   *  2. 「格与格之间的过程看不到」—— 它是采样，不是连续视频
   *  3. **明确禁止读画面文字** —— 格子只有 330px，实测会把空画面读成
   *     「前方高能」「压力拉满」这类常见弹幕词，编得非常像真的。宁可让它说看不清。
   */
  #sheetNote(out, audioNote) {
    const g = out.grid;
    const n = out.cells.length;
    const gridText = g ? `，${g.rows} 行 × ${g.cols} 列共 ${n} 格` : `，共 ${n} 格`;
    const tail = audioNote || '也没有读取音频，视频里的人声、旁白、背景音乐不在其中。';
    return `已按画面变化抽取${gridText}，拼成一张分镜图，`
      + '从左上到右下按时间先后排列，每格下方标着「#序号 秒数」。'
      + '注意：这是采样不是连续视频，格与格之间的过程看不到；'
      + '格子较小，画面上的文字（弹幕、字幕、标牌）不要求读出，'
      + '看不清就说看不清，不要根据常识猜测或补全文字内容。'
      + tail;
  }

  /** 通过 video.frames 能力抽帧；能力不在（插件被关）时返回空。 */
  async #extractViaSkill(filePath, { count = 0, durationSec = 0 } = {}) {
    const providers = skillManager.getCapabilityProviders('video.frames', {});
    // 这条分支正常走不到（route=frames 的前提就是能力存在），但一旦触发，
    // 说成 no_ffmpeg 会让模型/用户去查 ffmpeg，而真实原因是插件被关。
    if (!providers.length) return { frames: [], times: [], error: '视频抽帧插件未启用', code: 'no_provider' };
    for (const p of providers) {
      try {
        const r = await p.fn({ filePath, count: count || undefined, durationSec });
        if (r && Array.isArray(r.frames) && r.frames.length) {
          return {
            frames: r.frames, times: r.times || [], durationSec: r.durationSec,
            width: r.width, height: r.height, mode: r.mode || '', count: r.count || 0, code: ''
          };
        }
        if (r?.error) return { frames: [], times: [], error: r.error, code: r.code || '' };
      } catch (error) {
        return { frames: [], times: [], error: error?.message ?? String(error), code: 'exception' };
      }
    }
    return { frames: [], times: [], error: '抽帧没有产出画面', code: 'no_frames' };
  }

  /**
   * 通过 video.sheet 能力取一张分镜图。
   * 拿不到（插件没装 / 视频太长 / 扫描失败 / 格数不足）一律返回 null，
   * 由调用方退回均匀抽帧 —— 分镜图是加分项，不能让它失败导致整条视频看不到画面。
   */
  async #extractSheetViaSkill(filePath, { durationSec = 0, width = 0, height = 0 } = {}) {
    // 先问"这条路通不通"。与 framesAvailable 同构：tools-skill-audit 会检查
    // 每个能力都有真实取用方，video.sheet.available 没人调就是孤儿能力，npm test 直接红。
    const ready = skillManager.getCapabilityProviders('video.sheet.available', {});
    if (!ready.length) return null;
    for (const p of ready) {
      try {
        const st = await p.fn({});
        if (st && st.ok === false) return null;
      } catch { /* 探测异常不阻断，继续尝试真取图 */ }
    }
    const providers = skillManager.getCapabilityProviders('video.sheet', {});
    if (!providers.length) return null;
    try {
      const r = await providers[0].fn({ filePath, durationSec, width, height });
      if (!r || !Array.isArray(r.frames) || !r.frames.length) return null;
      return {
        frames: r.frames,                                   // 1 张图
        times: r.times || [],
        cells: r.cells || [],
        grid: r.grid || null,
        // ⚠️ 真实格数。frames.length 恒为 1，拿它当格数会让 truncated 永远为真
        frameCount: Number(r.frameCount) || (r.cells?.length || 0) || r.frames.length,
        count: Number(r.count) || (r.cells?.length || 0),
        durationSec: r.durationSec,
        width: r.width,
        height: r.height,
        mode: 'sheet',
        code: '',
      };
    } catch {
      return null;
    }
  }

  /**
   * 转码到模型友好规格：最长边 ≤480px、24fps、H.264+yuv420p、faststart。
   * 返回 data:video/mp4;base64 URL；失败返回 null（调用方回退原 URL）。
   * 与 gif-to-video 的转换互不复用：那边处理的是 GIF 的帧采样防炸弹，
   * 这边处理的是常规视频的降规格，参数与护栏各不相同。
   */
  async #transcodeToMax480(filePath) {
    const { ffmpeg } = await ensureFf();
    if (!ffmpeg) return null;
    const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpOut = path.join(os.tmpdir(), `qqa_vt_${stamp}.mp4`);
    try {
      // 产物大小护栏：≤480p/24fps 的短视频通常 <10MB；20MB 上限给长视频留余地，
      // 超过说明源异常长，喂模型不划算（元信息里有时长，模型自己判断要不要看）。
      const okRun = await runExitOk(ffmpeg, [
        '-y',
        '-i', filePath,
        // force_divisible_by=2：yuv420p/libx264 只吃偶数宽高，奇数尺寸源（部分
        // 手机竖拍视频）会直接 "Error while opening encoder" 转码失败（见 gif-to-video 同款注释）
        '-vf', "scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24",
        '-an',                       // 聊天视频的画面理解不需要音轨
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-fs', '20M',
        tmpOut
      ], 120000);
      if (!okRun || !fs.existsSync(tmpOut)) return null;
      const out = fs.readFileSync(tmpOut);
      if (!out.length || out.length > 20 * 1024 * 1024) return null;
      return `data:video/mp4;base64,${out.toString('base64')}`;
    } catch {
      return null;
    } finally {
      try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
    }
  }

  /** 把视频落地为本地文件路径（本地 path → 预缓存 → OneBot 缓存 → 下载 url）。 */
  async #localize(media) {
    this.#lastFetchError = null;             // 每轮从干净状态开始，别拿到上一条视频的旧错
    // 路径 0：消息里直接给了本地 path
    if (media.path && fs.existsSync(String(media.path))) return String(media.path);
    // 路径 0.5：入站预缓存命中（同一视频只有一份）
    const cached = cachePathFor(media);
    if (cached && fs.existsSync(cached)) return cached;
    // 路径 1：OneBot get_video / get_file 拿缓存
    if (media.file) {
      for (const action of ['get_video', 'get_file', 'get_image']) {
        try {
          const ret = await this.onebot.call(action, { file: String(media.file) });
          const p = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
          if (p) return p;
          if (ret?.url) {
            const dl = await this.#download(String(ret.url), 30000, cached || '');
            if (dl) return dl;
          }
        } catch { /* 尝试下一个 action */ }
      }
    }
    // 路径 2：直接下载 url
    if (media.url) {
      const dl = await this.#download(String(media.url), 30000, cached || '');
      if (dl) return dl;
    }
    const err = new Error('无法获取视频文件');
    // 把最内层原因挂上来：只有它才能区分"太大"和"过期"
    if (this.#lastFetchError) err.cause = this.#lastFetchError;
    throw err;
  }

  /**
   * 同一 dest 的下载去重：入站预缓存与按需下载会同时要同一个文件。
   * key = 目标路径，value = 在飞的 Promise<string>。
   */
  #downloads = new Map();

  /**
   * 最近一次取文件失败的真实异常（给 #localize 挂 cause 用）。
   *
   * 为什么需要它：`#fetchToCache` 原来 `catch { return '' }` 把异常吃干净，
   * 到 probe() 时只剩 #localize 统一抛的「无法获取视频文件」，分类器只能判 no_source
   * —— 「文件 469MB 超过 200MB 上限」就这样被说成「直链过期/协议端不支持」。
   *
   * 并发两条视频时后者可能覆盖前者（概率低、后果只是文案串号）；
   * `#localize` 每轮开头会清空，且一次失败后重新下载会重写，不会读到上一条的旧错。
   */
  #lastFetchError = null;

  /**
   * 下载到指定缓存路径，同一路径并发只跑一次；先写 .part 再 rename。
   *
   * 为什么必须这么写（v1.1 补，v1 漏了）：
   *   ① 缓存名改成按 media.file 哈希后，prefetch（入站）与 #localize（按需）
   *      会指向**同一个 dest**。两个流式写入交错 → mp4 损坏。
   *   ② 更隐蔽的是：写入期间 dest 就已经存在，另一侧 existsSync 命中后
   *      把半截文件交给 ffmpeg，只会报"读不到时长" —— 完全看不出是缓存问题。
   *   rename 在同一分区是原子的：dest 要么不存在，要么是完整文件。
   */
  async #fetchToCache(url, dest, timeoutMs = 60000) {
    if (!dest) return '';
    const running = this.#downloads.get(dest);
    if (running) return running;                 // 并发调用共享同一次下载
    const job = (async () => {
      const tmp = `${dest}.part-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      try {
        fs.mkdirSync(videoCacheDir(), { recursive: true });
        await safeFetchBinaryToFile(String(url), tmp, MAX_VIDEO_BYTES, { timeoutMs });
        // 0 字节也算失败：prefetch 用 size>0 判断"已有完整文件"，
        // 放个空文件进去会让后续每次都跳过下载、又永远读不到画面
        if (!fs.statSync(tmp).size) throw new Error('下载得到 0 字节');
        fs.renameSync(tmp, dest);                // 原子落位
        return dest;
      } catch (error) {
        // ← 超限 / HTTP 400 / 网络中断的区别全在这个对象上，别丢
        this.#lastFetchError = error;
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        return '';
      } finally {
        this.#downloads.delete(dest);
      }
    })();
    this.#downloads.set(dest, job);
    return job;
  }

  /**
   * 老接口保留：没有 hash 可用时退回随机名（行为同改前），内部同样走 .part + rename。
   * 超限/截断语义与旧实现一致：safeFetchBinaryToFile 在累计字节到达 maxBytes
   * 时删掉半截文件并抛错（残缺的 mp4 没法抽帧，不能让 ffprobe 报误导性元信息），
   * 这里接住异常返回 null，让上层按"拿不到文件"降级。
   */
  async #download(url, timeoutMs = 30000, dest = '') {
    const target = dest || path.join(videoCacheDir(),
      `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.mp4`);
    return (await this.#fetchToCache(url, target, timeoutMs)) || null;
  }

  /**
   * 入站预缓存：QQ 直链（rkey）约 1 小时后失效，等模型想起来再下就来不及。
   * 消息刚到时（url 还新鲜）先把文件落到 video-cache。
   * 失败不抛，返回 '' 由调用方忽略；与按需下载同 dest 时共享同一次请求。
   */
  async prefetch(media = {}) {
    if (String(media?.kind || 'video') !== 'video') return '';
    const dest = cachePathFor(media);
    if (!dest) return '';
    try {
      const st = fs.existsSync(dest) ? fs.statSync(dest) : null;
      if (st && st.size > 0) return dest;        // 已有完整文件，直接用
    } catch { /* ignore */ }
    const url = String(media?.url || '');
    if (!/^https?:\/\//i.test(url)) return '';   // 无直链（只能等协议端给文件）
    const got = await this.#download(url, 60000, dest);
    if (got) this.#pruneCacheIfBloated();
    return got || '';
  }

  /**
   * 缓存目录软上限（默认 1GB）：超了按 mtime 删最旧的。
   * 不清的话，180 天保留期 × 每天几十个视频会把磁盘吃到几十 GB。
   * 刚写入的文件 mtime 最新，不会被自己删掉。
   */
  #pruneCacheIfBloated(maxBytes = 1024 * 1024 * 1024) {
    try {
      const dir = videoCacheDir();
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).map((f) => {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        return { p, size: st.size, m: st.mtimeMs };
      });
      let total = files.reduce((a, x) => a + x.size, 0);
      if (total <= maxBytes) return;
      files.sort((a, b) => a.m - b.m);
      for (const f of files) {
        if (total <= maxBytes * 0.9) break;
        try { fs.rmSync(f.p, { force: true }); total -= f.size; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  async #ffprobe(ffprobe, filePath) {
    const out = {};
    const txt = await run(ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
    ], 15000);
    if (!txt) return out;
    try {
      const j = JSON.parse(txt);
      const vstream = (j.streams || []).find((s) => s.codec_type === 'video');
      if (vstream) {
        if (vstream.width) out.width = Number(vstream.width);
        if (vstream.height) out.height = Number(vstream.height);
      }
      if (j.format) {
        if (j.format.duration) out.durationSec = Number(j.format.duration);
        if (j.format.format_name) out.format = String(j.format.format_name);
        if (j.format.size) out.sizeBytes = Number(j.format.size);
      }
    } catch { /* 解析失败就返回空 */ }
    return out;
  }
}

/**
 * 音轨那一句文案（从 #audioLine 抽出来的纯函数）。
 *
 * 空串 = "本插件没参与"，由调用方决定说什么（没装时沿用旧文案）。
 * 四种结果必须能分开：有文本 / 成功但没人声 / 失败 / 没参与。
 * 分段兜底的结果走单独一支：带时间轴 + 明说"个别段可能听错"。
 */
export function formatAudioLine(audio) {
    if (!audio || audio.silent) return '';
    if (!audio.ok) {
      return `音轨转写失败（${AUDIO_FAIL_TEXT[audio.code] || audio.error || '原因不明'}）。`;
    }
    const t = String(audio.text || '').trim();
    const cut = audio.truncated ? '（只处理了前段，后面的没听）' : '';

    // ── 判据的选择（2026-11-08 用 22 条真实视频实测得出）────────────────────
    // event 不可用：它是"主导音频事件"，对白叠配乐时会被判成 BGM。
    //   实测 v_4e13（讲手机的纯人声）→ BGM、v_1c23（韩剧对白）→ BGM、
    //   v_74e6（番剧对白）→ BGM；而 lang=nospeech 的 4 条里 event 分别给出
    //   Event_UNK / Speech_Noise / Speech / Laughter，互相矛盾。
    // lang 可用，但 nospeech **不是**"文本必空"的保证：43 条整段实测里有 1 条
    //   （v_e721ffcfede6）标了 nospeech 仍吐出 4 字「Pりプり」。所以下面取"或"：
    //   文本去标点后为空就判无人声，nospeech 只是给这道判断加密，不单独成立。
    //   反过来，lang 是具体语种也不代表有人说话 —— v_9461330 标 en、文本只有一个点。
    // 所以：人声有无看 lang，event 只当"背景可能吵"的事实说明，不做定性。
    const lang = String(audio.lang || '').replace(/[<>|]/g, '').trim().toLowerCase();
    const noSpeech = lang === 'nospeech';
    const body = t.replace(/[\s\p{P}]/gu, '');

    // 分段识别（整段无可用文本后的兜底）：给时间戳 + 明说"可能不准"，
    // 让模型自己判断哪段是真台词（实测前 3 段「おちんちん」是误识，第 4/5 段
    // 「Deep.」「Seek!」才是对的）。这条必须在 noSpeech 判断**之前**：
    // 分段结果的 lang 取第一段，可能仍是 ja/en，但文本是真有内容的。
    if (audio.segmented && Array.isArray(audio.segments) && audio.segments.length) {
      const parts = audio.segments
        .map((s) => `[第${s.start}~${s.end}秒] ${s.text}`)
        .join('　');
      const notes = [];
      if (audio.truncated) notes.push('只处理了前段，后面的没听');
      notes.push('整段识别失败后改为每 3 秒一段，个别段可能听错');
      notes.push('外语请先理解再按用户的语言回答');
      return `音轨分段转写：${parts}\n（${notes.join('。')}。）`;
    }

    if (noSpeech || !body) {
      // ⚠️ 这句里不要出现任何具体的声音名词（纯音乐 / 环境音 / 静音）。
      // 实测 2026-11-08：写成"（可能是纯音乐、环境音或静音）"时，模型 2/2 都把它
      // 当词库捡走，答成"只能听到游戏的环境音和背景音乐"——它根本没听过那段音频。
      // 改成只下禁止、不给名词后 2/2 都答"没有检测到人声，听不到说了什么"。
      return '音轨里没有检测到人声。不要推测里面说了什么，也不要猜测那是什么声音。';
    }
    // 幻觉兜底：模型对纯音乐偶尔会硬凑出一两个字（实测 9 秒 BGM 凑出「我」）。
    // 丢掉它只是退回 [语音]，代价远小于让模型拿着一个假字去联想。
    // 同样不给声音类型留词：这句只说"辨认不出"，不说"那是什么"。
    if (body.length <= 1) {
      return '音轨里只有零星的、无法辨认的声音，没有可用的语句。不要猜测那是什么声音。';
    }

    const LANG_NAME = { zh: '中文', en: '英文', ja: '日语', ko: '韩语', yue: '粤语' };
    const langName = LANG_NAME[lang] || '';
    const ev = String(audio.event || '').toLowerCase();
    const noisy = /bgm|music|sing/.test(ev);

    // 只给判断依据，不下结论：文字通顺与否，模型自己读得出来。
    // 标点不复用句末句号（ASR 输出常自带，否则会出现「。。」）。
    const notes = [];
    if (langName && lang !== 'zh') notes.push('ASR 原文未翻译，请先理解再按用户的语言回答');
    if (noisy) notes.push('背景有音乐时识别会有偏差：连贯成句的是说话内容，支离破碎、大段重复的多半是歌词');

    const head = langName ? `（${langName}）` : '';
    const tail = notes.length ? `\n（${notes.join('。')}。）` : '';
    return `音轨转写${cut}${head}：${t}${tail}`;
}
