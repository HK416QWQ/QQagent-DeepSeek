// 视频抽帧（video-frames）
//
// ── 这个插件解决什么 ──
// read_video 有三条路线（native / frames / meta，见 src/video-reader.js 的
// resolveVideoRoute）。frames 路线要求核心先问「现在有人能把视频抽成图片吗」——
// 问的就是本插件的 video.frames.available。此前没有模块实现这两个能力，
// 于是永远 false，视频永远只能读到时长和分辨率。
//
// ── 为什么是 plugins/ 而不是 skills/ ──
// 抽帧是确定性工作：给文件就出帧，不需要模型判断。按 skills/manifest.js 的
// DIR_KIND 约定放 plugins/，由核心按**能力名**取用；放进 skills/ 只会注册
// 一张工具表给模型，能力仍然没人提供（loader 会专门告警）。
//
// ── 为什么不用 ffprobe ──
// 打包只带了 ffmpeg.exe（tools/ffmpeg/ 下实测没有 ffprobe.exe）。时长从
// `ffmpeg -i` 的 stderr 解析（Duration: 00:00:12.24），不必为个数字多带 40MB。
//
// ── 为什么两条路，不是一条 ──
// fps 滤镜（全片解码一次）在短视频上最快：同一视频 6 帧，逐帧 0.94s、fps 0.74s；
// 而且它是真正等距的，-ss 是"就近关键帧"定位。但它的成本随时长线性增长 ——
// 30 分钟 HEVC 实测 63 秒、1 小时直接撞 120 秒超时出 0 帧。
// 所以超过 60 秒改走逐帧 seek（输入侧 -ss，成本与时长无关，1 小时 1.4 秒）。
// 阈值 60 秒是保守的：30 秒样本上 seek 698ms、fps 1396ms，从 30 秒起 seek 就不慢。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件位于 <app>/plugins/video-frames/index.js → 上两级是应用根目录
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULTS = { frames: 6, maxWidth: 640, quality: 4 };
const MAX_COUNT = 12;
const PROBE_TIMEOUT_MS = 15000;
const EXTRACT_TIMEOUT_MS = 120000;
const AVAILABLE_TTL_MS = 60000;

/** 超过这个时长就不再全片解码，改逐帧 seek（实测 1 小时 HEVC：seek 1.4s vs 全解码 120s 超时）。 */
const SEEK_MIN_DURATION_SEC = 60;
const SEEK_TIMEOUT_MS = 15000;      // 单帧 seek 上限
// 一轮抽帧的总预算兜底。注意：**测试要覆盖"少帧"分支时会用环境变量把它压到 0**，
// 所以真正的取值放在 extract() 里、调用时读，不能在这里模块加载期读死。
const SEEK_TOTAL_BUDGET_MS = 60000;

// ── 分镜图（video.sheet）──
//
// 为什么要有它：均匀抽帧抽到的是「动手之前」和「躺平之后」，模型会把「被打晕」
// 解释成「饿晕」，而且逻辑自洽。动作瞬态只有 0.2 秒，等间隔采样在原理上就打不中。
//
// 为什么是 20 格：12 格实测答错方向（漏了「掀被坐起」这个前因帧，看不出谁打谁），
// 20 格才同时含 12.27 掀被 / 13.07 挥枕 / 13.27 倒地。这是量出来的下限，不是拍的。
const SHEET_CELLS = 20;
const SHEET_CELLS_MIN = 6;
const SHEET_CELLS_MAX = 28;
/** 只对短视频扫描：全片解码成本随时长线性增长，且格数摊薄后覆盖反而变差。 */
const SHEET_MAX_DURATION_SEC = 60;
/** 扫描上限。17.6s/1280×576 实测 0.5s，给 40 倍余量。 */
const SCAN_TIMEOUT_MS = 20000;
/** 一轮分镜图总预算（扫描+20 次 seek+拼图）。45s 竖屏实测 2.9s。 */
const SHEET_TOTAL_BUDGET_MS = 20000;
/** ⚠️ 必须**满格**才拼图，不能只看一个固定的下限。
 *  tile 会把不足的格子填成**纯黑**：实测 2026-11-08 用本单自己的参数喂 8 帧进 4×5 ——
 *  产物 1335×1058、退出码 0、照算 860 tokens，但第 3/4/5 行 YAVG = 0（纯黑）。
 *  模型看到会答"视频后半段是黑屏"，正是本单要避免的「看起来成功但结果是坏的」。
 *  所以下限不是 8，是 `layout.cols * layout.rows`，不满就整张作废、退回均匀抽帧。
 *  （v1.0 用的 `SHEET_MIN_CELLS = 8` 已删除：它把 8~19 格这个区间当成了正常。） */
/** 扫描门槛。故意压低：先全收候选人，再用底噪过滤。
 *  固定阈值 0.02 会漏掉「低变化但有关键动作」的视频（番剧关键帧只有 0.125）。 */
const SCENE_THRESHOLD = 0.005;

/** 三种布局。ty = 画面高度 + 4，字号按格宽挑，都验过不溢出标签带。 */
const SHEET_LAYOUTS = {
  landscape: { cw: 330, ch: 186, band: 22, cols: 4, rows: 5, font: 17, tx: 6, ty: 190 },
  portrait:  { cw: 186, ch: 330, band: 22, cols: 5, rows: 4, font: 14, tx: 4, ty: 334 },
  square:    { cw: 248, ch: 248, band: 22, cols: 5, rows: 4, font: 15, tx: 6, ty: 252 },
};

/** drawtext 必须显式给字体：不传时 ffmpeg 会自己挑一个（本机挑到 mingliub.ttc），
 *  换机器可能直接 "Cannot find a valid font"。取不到就退化成无标签分镜图。 */
const FONT_CANDIDATES = process.platform === 'win32'
  ? ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf']
  : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
     '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
     '/System/Library/Fonts/Helvetica.ttc'];

let cfgOf = () => ({});

/** 跑一条命令，收集 stdout/stderr。超时/启动失败/非零退出都返回结果，不抛。 */
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish({ code, out, err }); });
  });
}

// ── ffmpeg 查找：环境变量 → 项目内 tools/ffmpeg → 系统 PATH ──
// 与 src/image-compress.js 同一顺序，避免"装了 ffmpeg 但没进 PATH"这类假故障。
function candidates() {
  const list = [];
  const env = String(process.env.QQ_AGENT_FFMPEG || '').trim();
  if (env) list.push(env);
  list.push(path.join(APP_ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe'));
  list.push(path.join(APP_ROOT, 'tools', 'ffmpeg', 'ffmpeg'));
  list.push('ffmpeg', 'ffmpeg.exe');
  return list;
}

let cachedFf = '';
let missAt = 0;
let probing = null;

async function resolveFfmpeg() {
  if (cachedFf) return cachedFf;
  // 并发去重（预演踩到的坑）：加载期会有一次"探一下能不能用"的探测在飞，
  // 若此时第二个调用直接拿到"没找到"并缓存，60 秒内所有抽帧都会被判死。
  if (probing) return probing;
  if (missAt && Date.now() - missAt < AVAILABLE_TTL_MS) return '';
  probing = (async () => {
    for (const cand of candidates()) {
      const r = await run(cand, ['-version'], 5000);
      if (r && r.code === 0) { cachedFf = cand; return cand; }
    }
    missAt = Date.now();      // 只缓存"探测完成后的失败"，不缓存"正在探测"
    return '';
  })();
  try {
    return await probing;
  } finally {
    probing = null;
  }
}

let syncVerdict = null;
let syncAt = 0;

/**
 * 同步版本的候选过滤：只交出**盘上真实存在**的 ffmpeg。
 *
 * available() 必须同步（见下），只能用 spawnSync。若把 candidates() 的 5 个
 * 候选逐个 spawnSync 且 timeout 都是 5 秒，遇到一个挂住的坏文件会把主线程
 * 卡 25 秒。先 existsSync 过一遍，最多只剩 1–2 个真要 spawn 的。
 *
 * 裸命令名（ffmpeg / ffmpeg.exe）没法 existsSync，改扫 PATH 目录，同样不 spawn。
 */
function existingCandidates() {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  const pathDirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const cand of candidates()) {
    if (cand === 'ffmpeg' || cand === 'ffmpeg.exe') {
      for (const d of pathDirs) {
        const p = path.join(d, cand);
        try { if (fs.existsSync(p)) push(p); } catch { /* ignore */ }
      }
      continue;
    }
    try { if (fs.existsSync(cand)) push(cand); } catch { /* ignore */ }
  }
  return out;
}

/**
 * 给核心的「这条路现在走得通吗」：{ok, reason}。
 *
 * ⚠️ **必须同步返回**：tools-skill-audit 有一条硬约束 —— available() 若返回
 * Promise，调用方（界面/自检）会把它当真值，显示"可用"而实际不可用。
 * 所以这里用 spawnSync 探测（首次约 50ms，之后 60 秒内走缓存），
 * 异步的 resolveFfmpeg() 留给真正抽帧的路径用。
 *
 * 探的只是 existingCandidates() 筛出来的真实文件，一个都没有时直接判否、
 * 不 spawn —— 这样「没装 ffmpeg」是零成本路径，而不是五次 5 秒超时。
 */
export function available() {
  if (syncVerdict && Date.now() - syncAt < AVAILABLE_TTL_MS) return syncVerdict;
  for (const cand of existingCandidates()) {
    let r = null;
    try {
      r = spawnSync(cand, ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    } catch { r = null; }
    if (r && r.status === 0) {
      cachedFf = cand;                       // 顺手给异步路径省一次探测
      syncVerdict = { ok: true, ffmpeg: cand };
      syncAt = Date.now();
      return syncVerdict;
    }
  }
  syncVerdict = { ok: false, reason: '未找到 ffmpeg（放在 tools/ffmpeg/ 或设置 QQ_AGENT_FFMPEG）' };
  syncAt = Date.now();
  return syncVerdict;
}

/** 从 `ffmpeg -i` 的 stderr 取时长（秒）。取不到返回 0。 */
export function parseDurationSec(stderr) {
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(String(stderr || ''));
  if (!m) return 0;
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(sec) ? sec : 0;
}

/** 从 stderr 取第一个视频流的宽高。取不到返回 {}。 */
export function parseSize(stderr) {
  const m = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(String(stderr || ''));
  if (!m) return {};
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 长边限缩表达式：竖屏 720×1280 如果只限宽会得到 640×1138（token 翻倍），
 * force_original_aspect_ratio=decrease 会同时压住长边。
 * 抽帧的两条路（fps 滤镜 / 单帧 seek）共用同一份，避免两处参数漂移。
 */
function scaleExpr(maxWidth) {
  return `scale='min(${maxWidth},iw)':'min(${maxWidth},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

/** 组装 -vf：均匀 fps + 长边缩到 maxWidth。 */
export function buildFilter(count, durationSec, maxWidth = DEFAULTS.maxWidth) {
  const n = clampCount(count);
  const d = Number(durationSec) > 0 ? Number(durationSec) : 0;
  const fps = (n / d).toFixed(6);
  return `fps=${fps},${scaleExpr(maxWidth)}`;
}

function clampCount(v) {
  const n = Math.floor(Number(v) || 0);
  if (!n) return 0;
  return Math.min(MAX_COUNT, Math.max(1, n));
}

/** 夹取整数，非法值回落默认。 */
function clampInt(v, dflt, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** 中位数。候选分数用它估「压缩噪点底噪」。 */
function median(nums) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

let fontCache;
/** 同步找字体（available() 也走它，所以不能是 async）。找不到返回 ''。 */
function resolveFont() {
  if (fontCache !== undefined) return fontCache;
  fontCache = '';
  for (const p of FONT_CANDIDATES) {
    try { if (fs.existsSync(p)) { fontCache = p; break; } } catch { /* ignore */ }
  }
  return fontCache;
}

/** drawtext 选项值转义：反斜杠统一成 /，冒号必须转义（Windows 盘符）。 */
function drawtextFont(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** 按时长决定看多少帧：短的看细节，长的保覆盖（上限仍是 MAX_COUNT=12）。 */
export function autoCount(durationSec) {
  const d = Number(durationSec) || 0;
  if (d <= 60) return 6;
  if (d <= 600) return 9;
  return MAX_COUNT;
}

/**
 * 全片扫一遍，收「画面变化」候选。
 *
 * ⚠️ 三个必须守住的点：
 *  1. 不能传 -loglevel error —— metadata=print 是 info 级、写 stderr，
 *     压掉日志会变成「退出码 0 + 零候选」，分桶全退化成中点。
 *  2. 不打 -t 截断 —— 要的就是全片候选，片尾由 pickSheetTimes 剪。
 *  3. 解析顺序是 pts_time 在前、lavfi.scene_score 在后，必须成对读。
 *
 * @returns {Promise<Array<{t:number,s:number}>|null>} null = 失败/超时（调用方退回均匀抽帧）
 */
async function scanScene(ff, file, timeoutMs = SCAN_TIMEOUT_MS) {
  const r = await run(ff, [
    '-hide_banner', '-nostdin',
    '-i', file,
    '-vf', `select='gt(scene,${SCENE_THRESHOLD})',metadata=print`,
    '-vsync', 'vfr',                    // 本机 ffmpeg 2022-10-30 版；新版可换 -fps_mode vfr
    '-f', 'null', '-'
  ], timeoutMs);
  if (!r || r.code !== 0) return null;
  const cands = [];
  let cur = null;
  for (const line of String(r.err || '').split(/\r?\n/)) {
    const mt = /pts_time:([0-9.]+)/.exec(line);
    if (mt) { cur = { t: Number(mt[1]) }; continue; }
    const ms = /scene_score=([0-9.]+)/.exec(line);
    if (ms && cur) { cur.s = Number(ms[1]); cands.push(cur); cur = null; }
  }
  return cands;
}

/**
 * 分桶选时刻（纯函数）。
 *
 * 为什么分桶而不是全局 top-N：实测番剧 top6 里有 5 个挤在 0.41 秒内，全是同一瞬间。
 * 分桶天然分散，且不需要任何跨视频可比的绝对阈值（番剧 0.125 是关键帧，
 * 游戏 0.526 是片尾黑屏，拿一个阈值卡两者必然错一个）。
 *
 * @param {{t:number,s:number}[]} cands
 * @param {number} durationSec
 * @param {number} count 目标格数
 * @returns {{times:number[], cells:{n:number,t:number,from:string}[], floor:number, sceneCells:number}}
 */
export function pickSheetTimes(cands, durationSec, count = SHEET_CELLS) {
  const dur = Number(durationSec) || 0;
  const n = clampInt(count, SHEET_CELLS, SHEET_CELLS_MIN, SHEET_CELLS_MAX);
  if (!dur) return { times: [], cells: [], floor: 0, sceneCells: 0 };

  const list = (Array.isArray(cands) ? cands : [])
    .filter((c) => Number.isFinite(c?.t) && Number.isFinite(c?.s));

  // 底噪 = 候选中位数 × 2，夹在 [扫描门槛, 0.08]。
  //
  // ⚠️ 系数是 2，不是 4。方案原稿写了 4（借自参考项目的幻灯片场景），实测偏严：
  //    17.6s 样本 median=0.0141 → 底噪 0.0563，226 个候选只剩 4 个通过，
  //    20 个桶里只有 2 格来自场景检测，其余全退回中点 —— 等于退化成「0.88 秒均匀采样」，
  //    而且正好漏掉 12.27 的「掀被坐起」帧（它只有 0.0325），而缺这一帧就是
  //    12 格版本答错方向（"左边扔枕头"）的原因。
  //    改成 ×2（底噪 0.0282）后 14/20 格来自场景检测，12.27 / 13.07 / 13.27 三帧全中，
  //    选帧结果与之前实测答对的那一组几乎逐点一致。
  const floor = Math.min(0.08, Math.max(SCENE_THRESHOLD, median(list.map((c) => c.s)) * 2));
  // 剪掉片尾：转场/淡出/黑屏在那儿分数最高（实测真人口播 top5 全在最后 4 秒），
  // 但它对理解内容没有价值，宁可让最后一桶退化成中点。
  const tailCut = Math.max(2, dur * 0.06);
  const usable = list.filter((c) => c.t < dur - tailCut && c.s >= floor);

  const step = dur / n;
  const cells = [];
  let sceneCells = 0;
  for (let i = 0; i < n; i++) {
    // 桶上界封顶到 dur - tailCut：片尾那段（转场/淡出/黑屏/控制中心）对理解
    // 内容没价值，宁可把最后几个桶让出去。实测 17.6s 样本原第 20 格 = 17.16s，
    // 落在手机控制中心「正在录屏」上。
    // ⚠️ 代价：tailCut 会让最后 1~2 个桶整体落在片尾内（lo ≥ boundary），此时
    // 它们退化成同一个 fixed 值（boundary - step/2），相邻格可能相等——
    // 这是"片尾确实没有内容"的正确反映，不变式 3 据此放宽为"单调不减"。
    const lo = i * step;
    const hi = Math.min((i + 1) * step, dur - tailCut);
    let best = null;
    for (const c of usable) {
      if (c.t >= lo && c.t < hi && (!best || c.s > best.s)) best = c;
    }
    if (best) sceneCells += 1;
    let t;
    if (best) {
      t = best.t;
    } else if (hi > lo) {
      t = (lo + hi) / 2;                 // 空桶取段中点，等同现状
    } else {
      // 整桶在片尾内：固定退到片尾边界前半步，但不低于前一格（保单调不减）
      t = Math.max(dur - tailCut - step / 2, cells.length ? cells[cells.length - 1].t : 0);
    }
    cells.push({ n: i + 1, t: Number(t.toFixed(2)), from: best ? 'scene' : 'mid' });
  }
  return { times: cells.map((c) => c.t), cells, floor: Number(floor.toFixed(4)), sceneCells };
}

/** 按源宽高比选布局（纯函数）。取不到尺寸按横屏（最常见的群聊视频）。 */
export function sheetLayoutFor(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return SHEET_LAYOUTS.landscape;
  const r = w / h;
  if (r > 1.1) return SHEET_LAYOUTS.landscape;
  if (r < 0.9) return SHEET_LAYOUTS.portrait;
  return SHEET_LAYOUTS.square;
}

/** 成品尺寸（纯函数，给测试和 note 用）。 */
export function sheetSize(layout) {
  const L = layout || SHEET_LAYOUTS.landscape;
  return {
    width: L.cols * L.cw + (L.cols - 1) * 3 + 6,
    height: L.rows * (L.ch + L.band) + (L.rows - 1) * 3 + 6,
  };
}

/**
 * 抽帧计划（纯函数）：走哪条路、抽几帧、每帧在什么时间点。
 * - 优先级：模型显式要的帧数 > 插件配置 frames > 按时长自动
 * - ≤60s 走 fps 滤镜（一次解码，最快）；更长走 seek（逐帧定位，与时长无关）
 * - times：fps 实际从 t=0 起等距出帧 → i*step；seek 取格中心 → (i+0.5)*step
 */
export function planExtraction(durationSec, requested = 0, opts = {}) {
  const dur = Number(durationSec) > 0 ? Number(durationSec) : 0;
  const explicit = clampCount(requested);
  const configured = clampCount(opts.configuredFrames) || 0;
  // ⚠️ 不能写 `explicit || configured || autoCount(dur)`：
  //    插件 settings 里 frames 默认就是 6，configured 恒真 → autoCount 永远不触发，
  //    1 小时视频还是 6 帧。取两者较大值：短的听用户设置，长的至少给按时长算的覆盖量。
  //    代价是"用户调小不生效"（30s 填 2 帧仍给 6）—— 设置项语义是"最多看几帧"，
  //    抽太少反而答不上来，6 帧只有 ~1200 token，这个取舍是刻意的。
  const count = Math.max(1, Math.min(MAX_COUNT, explicit || Math.max(configured, autoCount(dur))));
  const mode = opts.forceSeek || dur > SEEK_MIN_DURATION_SEC ? 'seek' : 'fps';
  const step = dur / count;
  const times = Array.from({ length: count }, (_, i) =>
    Number(((mode === 'seek' ? (i + 0.5) : i) * step).toFixed(2)));
  return { mode, count, step: Number(step.toFixed(3)), times };
}

/**
 * 抽格 + 拼图。返回的 `cells` 是**按成功顺序重新编号**后的列表。
 *
 * ⚠️ 为什么必须重编号：image2 序列有空洞时只读第一帧，而且退出码是 0
 * （实测 4 格挖掉 02 → frame=1，产物照样生成）。不重编号就会得到
 * 「一张只有 1 格的分镜图」且被当成成功。
 */
async function buildSheet(ff, file, cells, layout, { quality = DEFAULTS.quality, budgetMs = SHEET_TOTAL_BUDGET_MS } = {}) {
  const startedAt = Date.now();
  const font = resolveFont();
  const fontArg = font ? `fontfile='${drawtextFont(font)}'` : '';
  const H = layout.ch + layout.band;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa_sheet_'));
  let lastErr = '';
  try {
    const cellDir = path.join(dir, 'cells');
    fs.mkdirSync(cellDir, { recursive: true });
    const keptTimes = [];
    const fullCells = layout.cols * layout.rows;   // 必须满格，见 SHEET 常量处的实测说明

    for (const c of cells) {
      if (Date.now() - startedAt > budgetMs) break;
      // 预算不够抽满剩下的格，就立刻放弃 —— 别等超时了才发现差 2 格，
      // 那样 20 次 seek 全白跑，上层还要重跑一遍均匀抽帧。
      // 单格耗时用已抽到的平均值估，一格都没抽时不判断（perCell 无意义）。
      if (keptTimes.length) {
        const perCell = (Date.now() - startedAt) / keptTimes.length;
        const remain = cells.length - keptTimes.length;
        if (keptTimes.length + Math.floor((budgetMs - (Date.now() - startedAt)) / perCell) < fullCells) {
          lastErr = `预算不足：按每格 ${Math.round(perCell)}ms 估，抽不满 ${fullCells} 格`;
          break;
        }
      }
      const n = keptTimes.length + 1;
      const raw = path.join(dir, `raw_${String(c.n).padStart(2, '0')}.jpg`);
      const final = path.join(cellDir, `c_${String(n).padStart(2, '0')}.jpg`);
      const vf = [
        // force_divisible_by=2 留着：当前布局不加也能过（pad 输出 330×208 是偶数），
        // 但 band 一改就会退化成奇数直出、那时才真失败。见 §0.1。
        `scale=${layout.cw}:${layout.ch}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        // 画面贴顶，底部留 band 高的黑条写标签，不遮挡任何画面内容
        `pad=${layout.cw}:${H}:(ow-iw)/2:0:black`,
        fontArg
          ? `drawtext=${fontArg}:text='#${n}  ${c.t}s':x=${layout.tx}:y=${layout.ty}:fontsize=${layout.font}:fontcolor=white`
          : '',
      ].filter(Boolean).join(',');

      // -ss 在 -i 之前是输入侧定位（实测精度 ±7ms，成本与视频时长无关）
      const r = await run(ff, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-ss', String(c.t), '-i', file, '-frames:v', '1', '-map', '0:v:0',
        '-vf', vf, '-q:v', String(quality), raw
      ], SEEK_TIMEOUT_MS);

      let size = 0;
      try { size = fs.statSync(raw).size; } catch { size = 0; }
      if (r && r.code === 0 && size > 0) {
        fs.renameSync(raw, final);                       // 按成功顺序落成 01..N，序列无洞
        keptTimes.push(c.t);
      } else {
        try { fs.unlinkSync(raw); } catch { /* ignore */ }
        const line = String(r?.err || '').trim().split('\n').filter(Boolean).pop();
        if (line) lastErr = line;
      }
    }

    // 不满格就整张作废：拼出来的图会把缺的格子填成纯黑（实测 8 帧 → 后 12 格 YAVG=0），
    // 模型会据此判断"视频后半段是黑屏"。宁可不给分镜图，也不能给一张会撒谎的。
    if (keptTimes.length < fullCells) {
      return {
        sheet: '',
        cells: keptTimes.map((t, i) => ({ n: i + 1, t })),
        code: 'sheet_incomplete',
        error: `只抽到 ${keptTimes.length}/${fullCells} 格${lastErr ? `：${lastErr.slice(0, 120)}` : ''}`,
      };
    }

    const sheetFile = path.join(dir, 'sheet.jpg');
    const tile = await run(ff, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-framerate', '1', '-i', path.join(cellDir, 'c_%02d.jpg'),
      '-frames:v', '1',
      '-vf', `tile=${layout.cols}x${layout.rows}:padding=3:margin=3`,
      '-q:v', String(quality), sheetFile
    ], SEEK_TIMEOUT_MS);

    let sheetBytes = 0;
    try { sheetBytes = fs.statSync(sheetFile).size; } catch { sheetBytes = 0; }
    if (!tile || tile.code !== 0 || !sheetBytes) {
      const line = String(tile?.err || '').trim().split('\n').filter(Boolean).pop();
      return { sheet: '', cells: [], code: 'sheet_failed', error: `拼图失败${line ? `：${line.slice(0, 120)}` : ''}` };
    }

    return {
      sheet: `data:image/jpeg;base64,${fs.readFileSync(sheetFile).toString('base64')}`,
      cells: keptTimes.map((t, i) => ({ n: i + 1, t })),
      cols: layout.cols,
      rows: layout.rows,
      bytes: sheetBytes,
      code: '',
    };
  } finally {
    // base64 已在内存里，磁盘再留一份只会越积越多
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * 能力 video.frames 的实现。
 *
 * 两条路（由 planExtraction 决定）：
 *   fps  全片解码一次，滤镜均匀出帧 —— 短视频最快（12s 样本 345ms）
 *   seek 逐帧 -ss 定位，成本与时长无关 —— 长视频唯一可行（1 小时 HEVC 1.4s）
 *
 * @param {{filePath: string, count?: number, durationSec?: number}} args
 * @returns {Promise<{frames: string[], times: number[], durationSec?: number,
 *                    width?: number, height?: number, count?: number, mode?: string,
 *                    code?: string, error?: string}>}
 */
export async function extract({ filePath, count = 0, durationSec = 0 } = {}) {
  const file = String(filePath || '');
  if (!file || !fs.existsSync(file)) {
    return { frames: [], times: [], code: 'no_file', error: '视频文件不存在或已被清理' };
  }

  const cfg = { ...DEFAULTS, ...(cfgOf() || {}) };

  const ff = await resolveFfmpeg();
  if (!ff) return { frames: [], times: [], code: 'no_ffmpeg', error: '未找到 ffmpeg，无法抽帧' };

  // 1. 先探一次（-i 不带输出 = 打印信息后退出），拿时长和分辨率
  const probe = await run(ff, ['-hide_banner', '-i', file], PROBE_TIMEOUT_MS);
  if (!probe) return { frames: [], times: [], code: 'probe_timeout', error: 'ffmpeg 读取视频超时' };
  const dur = Number(durationSec) > 0 ? Number(durationSec) : parseDurationSec(probe.err);
  const size = parseSize(probe.err);
  if (!dur) {
    return { frames: [], times: [], code: 'no_duration', error: '读不到视频时长（文件可能损坏或未下载完整）', ...size };
  }
  // 计划必须等 dur 出来才能算：模式（fps/seek）、帧数、时间点全依赖它
  const plan = planExtraction(dur, count, {
    configuredFrames: cfg.frames,
    forceSeek: process.env.QQ_AGENT_FORCE_SEEK === '1',   // 测试用：强制走 seek 分支
  });

  // 2. 按计划抽帧，落到临时目录
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa_frames_'));
    const startedAt = Date.now();     // seek 分支的总预算起点
    let lastRun = null;               // ⚠️ 必须函数级：收尾要读它的 stderr，写进 if 块会 ReferenceError
    if (plan.mode === 'fps') {
      lastRun = await run(ff, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', file,
        // 明确取第一个**视频**流：不少手机视频的 0:0 是音频轨（本项目缓存里就有
        // 两个这样的样本），容器顺序异常时默认选择会抽到空
        '-map', '0:v:0',
        '-vf', buildFilter(plan.count, dur, cfg.maxWidth),
        '-q:v', String(cfg.quality),
        path.join(dir, 'f_%03d.jpg')
      ], EXTRACT_TIMEOUT_MS);
      if (!lastRun) {
        return {
          frames: [], times: [], durationSec: dur, ...size, count: plan.count, mode: plan.mode,
          code: 'timeout', error: '抽帧超时（视频可能过大）'
        };
      }
    } else {
      // 逐帧 seek：-ss 放在 -i 前是输入侧定位，实测精度 ±7ms，成本与视频时长无关。
      // 时间点直接用 plan.times[i]：plan.step 已 toFixed(3)，与 times 用的未舍入 step
      // 最多差 1ms，没必要让"实际 seek 点"和"回报时间"变成两套数。
      // 预算在这里读环境变量（不是模块加载期）：测试把它压到 0 才能验"少帧"分支。
      // ⚠️ '0' 必须真的当 0 —— 写成 `Number(x) || 60000` 会让它被当成缺省值
      const budgetMs = process.env.QQ_AGENT_SEEK_BUDGET_MS != null
        ? Math.max(0, Number(process.env.QQ_AGENT_SEEK_BUDGET_MS) || 0)
        : SEEK_TOTAL_BUDGET_MS;
      for (let i = 0; i < plan.count; i++) {
        const t = plan.times[i];
        const one = path.join(dir, `f_${String(i).padStart(3, '0')}.jpg`);
        const one2 = await run(ff, [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-map', '0:v:0',
          '-vf', scaleExpr(cfg.maxWidth), '-q:v', String(cfg.quality), one
        ], SEEK_TIMEOUT_MS);
        if (one2) lastRun = one2;          // 留住最后一次 stderr，no_frames 时才有话可说
        // 单帧失败不中断整轮：长视频尾部偶有坏帧，能拿几张是几张
        if (Date.now() - startedAt > budgetMs) break;
      }
    }

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      // 0 字节 = 单帧 seek 被 kill 的残骸；留着会 base64 成空串，给模型一个坏 image part
      .filter((f) => { try { return fs.statSync(path.join(dir, f)).size > 0; } catch { return false; } })
      .sort();
    if (!files.length) {
      const tail = String(lastRun?.err || '').trim().split('\n').slice(-2).join(' / ').slice(0, 200);
      return {
        frames: [], times: [], durationSec: dur, ...size, count: plan.count, mode: plan.mode,
        code: 'no_frames', error: `抽帧没有产出画面${tail ? `：${tail}` : ''}`
      };
    }
    const frames = files.map((f) => `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`);
    // 时间点按**文件名里的计划下标**回查，不要按"实际帧数"重算。
    // 少帧有两种来源：中间某帧坏掉、总预算 60s 提前 break。两种情况下帧都还留在
    // 它们原本的取样点上，重算会把这些帧摊到全长 —— 1 小时样本退到 8 帧时，
    // 实际 150…2250 会被报成 225…3375，比原来那个"整体偏半步"错得更远。
    // ⚠️ 只有 seek 分支的文件名是计划下标（f_000 对应 plan.times[0]）。fps 分支的
    //    f_001… 是 ffmpeg 的输出序号（从 001 起自增），拿它查 plan.times 会整体错一格，
    //    第 0 秒那帧被报成第 step 秒。所以 fps 走位置兜底，不用文件名。
    const times = files.map((f, i) => {
      if (plan.mode === 'seek') {
        const idx = Number((/f_(\d+)\.jpg$/.exec(f) || [])[1]);
        if (Number.isFinite(idx) && plan.times[idx] != null) return plan.times[idx];
      } else if (plan.times[i] != null) {
        // fps：文件名从 001 连续自增（没有空洞），所以**位置 i 就是计划下标**。
        // 少出几帧时也取原位置（0/2.04/4.08…）；按实际帧数重算会把它们摊到全长，
        // 和 seek 那条已经修掉的是同一个错，只是概率更低。
        return plan.times[i];
      }
      // 最后兜底（仍分模式）：fps 从 t=0 起算，seek 取格中心
      return Number((((plan.mode === 'seek' ? i + 0.5 : i) * (dur / Math.max(1, files.length)))).toFixed(2));
    });
    return { frames, times, durationSec: dur, ...size, count: plan.count, mode: plan.mode, code: '' };
  } catch (error) {
    return {
      frames: [], times: [], count: plan?.count || 0,
      code: 'exception', error: `抽帧失败：${error?.message ?? error}`
    };
  } finally {
    // 临时帧一律删：base64 已在内存里，磁盘再留一份只会越积越多
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

/**
 * 能力 video.sheet 的实现。
 *
 * 返回结构与 video.frames 保持"能对接"：
 *   frames  : **1 个元素**（一张分镜图 dataUrl）—— 上层按图片数用，这里就是 1 张
 *   frameCount / cells.length : 真实格数（⚠️ 不是 frames.length）
 *   count   : 计划格数，供 truncated 判定
 *   mode    : 'sheet'
 *
 * 失败一律返回 code，不抛：调用方据此退回均匀抽帧。
 */
export async function extractSheet({ filePath, durationSec = 0, width = 0, height = 0, cells = 0 } = {}) {
  const file = String(filePath || '');
  if (!file || !fs.existsSync(file)) {
    return { frames: [], times: [], code: 'no_file', error: '视频文件不存在或已被清理' };
  }

  const cfg = { ...DEFAULTS, ...(cfgOf() || {}) };
  const ff = await resolveFfmpeg();
  if (!ff) return { frames: [], times: [], code: 'no_ffmpeg', error: '未找到 ffmpeg，无法抽帧' };

  const probe = await run(ff, ['-hide_banner', '-i', file], PROBE_TIMEOUT_MS);
  if (!probe) return { frames: [], times: [], code: 'probe_timeout', error: 'ffmpeg 读取视频超时' };
  const dur = Number(durationSec) > 0 ? Number(durationSec) : parseDurationSec(probe.err);
  const size = parseSize(probe.err);
  const w = Number(width) || size.width || 0;
  const h = Number(height) || size.height || 0;
  if (!dur) {
    return { frames: [], times: [], code: 'no_duration', error: '读不到视频时长（文件可能损坏或未下载完整）', ...size };
  }

  const maxSec = clampInt(cfg.sheetMaxSec, SHEET_MAX_DURATION_SEC, 10, 600);
  if (dur > maxSec) {
    // 长视频不扫描：20 格摊到 3 分钟是 9 秒/格，又回到"跳过高潮"；
    // 而且全片解码成本随时长线性增长。交给调用方走原来的均匀 seek。
    return {
      frames: [], times: [], durationSec: dur, ...size, code: 'too_long',
      error: `视频 ${Math.round(dur)} 秒超过分镜图上限 ${maxSec} 秒`
    };
  }

  const cands = await scanScene(ff, file);
  if (!cands) {
    return { frames: [], times: [], durationSec: dur, ...size, code: 'scan_failed', error: '场景扫描失败或超时' };
  }

  const plan = pickSheetTimes(cands, dur, clampInt(cfg.sheetCells, SHEET_CELLS, SHEET_CELLS_MIN, SHEET_CELLS_MAX));
  const layout = sheetLayoutFor(w, h);
  const built = await buildSheet(ff, file, plan.cells, layout, { quality: cfg.quality });
  if (!built.sheet) {
    return {
      frames: [], times: [], durationSec: dur, ...size,
      code: built.code || 'sheet_failed', error: built.error || '分镜图生成失败'
    };
  }

  return {
    frames: [built.sheet],
    times: built.cells.map((c) => c.t),
    cells: built.cells,
    grid: { cols: built.cols, rows: built.rows },
    frameCount: built.cells.length,
    count: plan.cells.length,
    mode: 'sheet',
    durationSec: dur,
    width: w,
    height: h,
    sceneCells: plan.sceneCells,
    floor: plan.floor,
    bytes: built.bytes,
    code: '',
  };
}

/** 分镜图这条路现在走不走得通。**必须同步**（同 available() 的理由）。 */
export function sheetAvailable() {
  const r = available();
  if (r && r.ok) return { ok: true, ffmpeg: r.ffmpeg, font: resolveFont() || '' };
  return r;
}

export const providers = {
  'video.frames': (args) => extract(args),
  'video.frames.available': () => available(),
  'video.sheet': (args) => extractSheet(args),
  'video.sheet.available': () => sheetAvailable(),
};

/** setup 由加载器调用：拿 api.config 读本插件设置项。 */
export function setup(api) {
  cfgOf = () => {
    try { return api.config() || {}; } catch { return {}; }
  };
}

// 供测试直接调用内部实现（不影响注册面）
export const internals = {
  candidates, resolveFfmpeg, clampCount, DEFAULTS, MAX_COUNT, planExtraction, autoCount,
  pickSheetTimes, sheetLayoutFor, sheetSize, resolveFont, clampInt, median, SHEET_LAYOUTS,
};
