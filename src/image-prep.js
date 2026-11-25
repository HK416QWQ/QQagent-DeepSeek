// 图片准备：把任意下载到的图片字节，变成"可以安全发给模型"的一个或多个图片部件。
//
// 阶段 B（已批准）：在阶段 A 的嗅探/字节/几何守卫之上，把"长宽比或缩放后短边不足"
// 从 drop 改成**沿长边切片**（planImageTiles + ffmpeg crop），最多 maxTiles 块。
// 真的切不动（短边仍 < minUsefulWidth）才 drop，原因 too_narrow_after_resize。
// 阶段 A 的 0/0b/1/2/3b/6/7 步原样保留：切片不绕过 4MB 字节闸与转码链。
//
// 缩放**不复用 compressImage()**：它的返回条件是"输出更小才用输出"，传 maxBytes:1
// 也拿不到缩放结果。这里自己 spawn ffmpeg，只要退出码 0 且输出非空就无条件使用输出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { detectImageType } from './image-type.js';
import { ensureFf } from './image-compress.js';

export const IMAGE_LIMITS = Object.freeze({
  maxSide: 1568,              // 与现有 compressImage 默认值一致
  maxPixels: 4_000_000,       // 单图总像素上限
  maxDecodePixels: 80_000_000,// 超过则不解码，直接省略，防解码炸弹
  maxAspect: 6,               // 长边/短边超过 6 视为长图/全景图
  minUsefulWidth: 640,        // 低于此宽度不再缩，直接省略
  maxInputBytes: 4 * 1024 * 1024,  // 与现有 compressImage 的 maxBytes 对齐：几何合规但字节超限也要转码
  maxTotalMediaBytes: 8 * 1024 * 1024,
  jpegQuality: 4,             // 普通缩放 → resizeToJpeg 的 quality
  // ── 阶段 B 引入（只扩展同一个 IMAGE_LIMITS，不另立 TILE_LIMITS）──
  maxTiles: 8,                // 单张图最多切几块
  tileOverlap: 64,            // 相邻块的期望重叠像素（最后一块可能更大）
  tileQuality: 3              // 切片重新编码的 -q:v
});

function runFfmpegCapture(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch {
      return finish(null);
    }
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(err || null); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => { clearTimeout(timer); finish(err || null); });
  });
}

function runFfmpeg(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
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

/** 三态取 ffmpeg：tools 里显式给了 ffmpeg 字段（含 null）就用它；完全没注入才回落 ensureFf()。 */
async function resolveFfmpeg(tools) {
  if (tools && 'ffmpeg' in tools) return tools.ffmpeg || null;
  const ff = await ensureFf();
  return ff?.ffmpeg || null;
}

function tmpName(prefix, ext) {
  return path.join(os.tmpdir(), `qqa_img_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${ext || '.img'}`);
}

/** 解析 JPEG 的 SOF 宽高；排除 C4/C8/CC。 */
function jpegSize(buf) {
  if (buf.length < 4) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    let marker = buf[i + 1];
    while (marker === 0xff && i + 2 < buf.length) { i += 1; marker = buf[i + 1]; }
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (i + 9 >= buf.length) return null;
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * 从 JPEG APP1 段的 Exif TIFF 头里取 Orientation(0x0112)。
 * 只看 IFD0（Orientation 的标准位置）；不是 Exif / 读不到 / 值不在 1..8 → null。
 */
function exifOrientationFromApp1(seg) {
  if (!seg || seg.length < 14) return null;
  // "Exif\0\0"
  if (seg[0] !== 0x45 || seg[1] !== 0x78 || seg[2] !== 0x69 || seg[3] !== 0x66) return null;
  if (seg[4] !== 0 || seg[5] !== 0) return null;
  const tiff = seg.subarray(6);
  if (tiff.length < 8) return null;
  const order = tiff.toString('ascii', 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd0 = u32(4);
  if (ifd0 < 8 || ifd0 + 2 > tiff.length) return null;
  const count = u16(ifd0);
  for (let k = 0; k < count; k++) {
    const e = ifd0 + 2 + k * 12;
    if (e + 12 > tiff.length) return null;
    if (u16(e) !== 0x0112) continue;
    const type = u16(e + 2);
    if (u32(e + 4) < 1) return null;
    let v;
    if (type === 3) v = u16(e + 8);        // SHORT：值内联在 value 字段前 2 字节
    else if (type === 4) v = u32(e + 8);   // LONG：少见，容忍
    else return null;
    return v >= 1 && v <= 8 ? v : null;
  }
  return null;
}

/**
 * JPEG 的 EXIF Orientation。缺失、非法、非 JPEG 一律按 1（正常方向），**不抛错**。
 * 只扫到 SOS/EOI 为止：APP 段全在图像数据之前。
 */
function jpegOrientation(buffer) {
  try {
    if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return 1;
    let i = 2;
    while (i + 4 <= buffer.length) {
      if (buffer[i] !== 0xff) { i += 1; continue; }
      const marker = buffer[i + 1];
      // 无长度字段的标记：SOI / TEM / RSTn
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;   // EOI / SOS 之后不会再有 APP 段
      const len = buffer.readUInt16BE(i + 2);
      if (len < 2 || i + 2 + len > buffer.length) break;
      if (marker === 0xe1) {
        const v = exifOrientationFromApp1(buffer.subarray(i + 4, i + 2 + len));
        if (v) return v;
      }
      i += 2 + len;
    }
    return 1;
  } catch {
    return 1;
  }
}

/**
 * 嗅探图片元数据（mime/ext/尺寸/alpha/animated/recognized/needsTranscode/orientation）。
 * 只由魔数决定，不读 HTTP content-type。
 *
 * orientation 与尺寸的关系：Orientation 5–8 表示存储画面相对显示画面转了 90°，
 * 而 ffmpeg 解码时会自动扶正（autorotate 默认开）。所以 **width/height 一律是显示尺寸**，
 * 存储尺寸另存 storedWidth/storedHeight 供日志用。下游的 assessImage() / planImageTiles()
 * 因此直接拿到给人看的宽高，不会把竖图按横图切。
 * @returns {null | { mime, ext, width, height, storedWidth, storedHeight, orientation,
 *   alpha, animated, recognized, needsTranscode }}
 */
export function sniffImageMeta(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const t = detectImageType(buffer);
  if (!t) return null;
  const out = {
    mime: t.mime, ext: t.ext,
    width: null, height: null,
    storedWidth: null, storedHeight: null,
    orientation: 1,
    alpha: false, animated: false,
    recognized: true, needsTranscode: false
  };
  if (t.mime === 'image/png') {
    if (buffer.length >= 26) {
      out.width = buffer.readUInt32BE(16);
      out.height = buffer.readUInt32BE(20);
      const colorType = buffer[25];
      out.alpha = colorType === 4 || colorType === 6;
    }
    out.animated = buffer.includes(Buffer.from('acTL'));
  } else if (t.mime === 'image/jpeg') {
    const dim = jpegSize(buffer);
    out.orientation = jpegOrientation(buffer);
    if (dim) {
      out.storedWidth = dim.width;
      out.storedHeight = dim.height;
      // 5–8：存储画面相对显示画面转了 90°，交换后才是"人看到的宽高"
      const swap = out.orientation >= 5;
      out.width = swap ? dim.height : dim.width;
      out.height = swap ? dim.width : dim.height;
    }
  } else if (t.mime === 'image/gif') {
    out.width = buffer.readUInt16LE(6);
    out.height = buffer.readUInt16LE(8);
    let frames = 0;
    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === 0x21 && buffer[i + 1] === 0xf9) frames += 1;
    }
    out.animated = frames >= 2;
  } else if (t.mime === 'image/webp') {
    // VP8X 的 24 位 canvas 宽高。VP8/VP8L 读不到时交给 ffmpeg（width/height 留 null）。
    if (buffer.length >= 30 && buffer.toString('ascii', 12, 16) === 'VP8X') {
      const flags = buffer[20];
      out.alpha = (flags & 0x10) !== 0;
      out.animated = (flags & 0x02) !== 0;
      out.width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      out.height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    }
  } else if (t.mime === 'image/bmp') {
    if (buffer.length >= 26) {
      out.width = Math.abs(buffer.readInt32LE(18));
      out.height = Math.abs(buffer.readInt32LE(22));
    }
  } else if (t.mime === 'image/tiff' || t.mime === 'image/heic') {
    out.needsTranscode = true;
  }
  return out;
}

/**
 * 只判几何（尺寸/像素/长宽比），**不判 buffer.length**。
 * reasons 是全量集合，顺序固定 max_side → max_pixels → max_aspect → max_decode_pixels。
 */
export function assessImage({ width, height }, limits = IMAGE_LIMITS) {
  const w = Number(width);
  const h = Number(height);
  const reasons = [];
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, reasons: ['unknown_geometry'] };
  }
  const longSide = Math.max(w, h);
  const shortSide = Math.min(w, h);
  if (longSide > limits.maxSide) reasons.push('max_side');
  if (w * h > limits.maxPixels) reasons.push('max_pixels');
  if (shortSide > 0 && longSide / shortSide > limits.maxAspect) reasons.push('max_aspect');
  if (w * h > limits.maxDecodePixels) reasons.push('max_decode_pixels');
  return { ok: reasons.length === 0, reasons };
}

function dropPlan(reasons, dropReason) {
  return { mode: 'drop', width: 0, height: 0, tiles: [], reasons, dropReason };
}

/**
 * 按 §5.1 的 scale/cover 公式规划切片；4c（aspect ≤ maxAspect 但短边不足）与 5（aspect 超限）共用。
 * 注意 scale 的括号位置是硬约束：`cover / longSide` 必须在 min 的第二个参数里，
 * 写成 `min(1, cover) / longSide` 会把整张图缩成 1/longSide。
 */
function planTiles(longSide, w, h, vertical, reasons, limits) {
  const step = limits.maxSide - limits.tileOverlap;
  const cover = (limits.maxTiles - 1) * step + limits.maxSide;
  const scale = Math.min(1, cover / longSide);
  let sw = Math.max(1, Math.round(w * scale));
  let sh = Math.max(1, Math.round(h * scale));

  // 取整可能让缩放后的长边比 cover 多 1px，从而多出一块；夹回 cover 内（5d）。
  const longScaledRaw = vertical ? sh : sw;
  if (longScaledRaw > cover) {
    const k = cover / longScaledRaw;
    sw = Math.max(1, Math.floor(sw * k));
    sh = Math.max(1, Math.floor(sh * k));
  }

  const longScaled = vertical ? sh : sw;
  const shortScaled = vertical ? sw : sh;

  // 已经缩到 maxSide 以内、短边还不足：切片不会让短边变长，直接省略。
  if (longScaled <= limits.maxSide) return dropPlan(reasons, 'too_narrow_after_resize');
  if (shortScaled < limits.minUsefulWidth) return dropPlan(reasons, 'too_narrow_after_resize');

  const count = Math.ceil((longScaled - limits.maxSide) / step) + 1;
  if (count > limits.maxTiles) return dropPlan(reasons, 'too_many_tiles');

  const tiles = [];
  for (let i = 0; i < count; i++) {
    // 位置钉死：最后一块从 longScaled - maxSide 截，保证覆盖到末尾（重叠可能 > tileOverlap）
    const pos = Math.min(i * step, longScaled - limits.maxSide);
    tiles.push(vertical
      ? { x: 0, y: pos, w: shortScaled, h: limits.maxSide }
      : { x: pos, y: 0, w: limits.maxSide, h: shortScaled });
  }

  // 每块都必须几何合规；任一不满足整张图 drop，不发半套。
  for (const t of tiles) {
    if (t.x < 0 || t.y < 0 || t.x + t.w > sw || t.y + t.h > sh) return dropPlan(reasons, 'tile_failed');
    if (Math.max(t.w, t.h) > limits.maxSide) return dropPlan(reasons, 'tile_failed');
    if (t.w * t.h > limits.maxPixels) return dropPlan(reasons, 'tile_failed');
    if (Math.max(t.w, t.h) / Math.min(t.w, t.h) > limits.maxAspect) return dropPlan(reasons, 'tile_failed');
  }
  return { mode: 'tile', width: sw, height: sh, tiles, reasons, dropReason: null };
}

/**
 * 长图/全景图切片规划（阶段 B，§5.1）。
 * **只判几何**：入参没有字节，`maxInputBytes` 的 4MB 闸仍由 prepareImage 的第 3/3b 步判，
 * 只按本函数的几何结论直接 pass 会漏掉该闸。
 * `tiles[].x/y/w/h` 一律在缩放后的 width × height 坐标系里，不是原图坐标。
 * @returns {{ mode: 'pass'|'resize'|'tile'|'drop', width: number, height: number,
 *   tiles: Array<{x:number,y:number,w:number,h:number}>, reasons: string[], dropReason: string|null }}
 */
export function planImageTiles({ width, height }, limits = IMAGE_LIMITS) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return dropPlan(['unknown_geometry'], 'unknown_geometry');
  }
  // 1. 解码像素上限（防解码炸弹）
  if (w * h > limits.maxDecodePixels) return dropPlan(['max_decode_pixels'], 'too_many_pixels_to_decode');

  const longSide = Math.max(w, h);
  const shortSide = Math.min(w, h);
  const aspect = longSide / shortSide;
  const a = assessImage({ width: w, height: h }, limits);
  const vertical = h > w;   // 竖图沿高度切，横图沿宽度切

  // 3. 几何全合规 → pass（字节闸由调用方 prepareImage 判）
  if (a.ok) return { mode: 'pass', width: w, height: h, tiles: [], reasons: [], dropReason: null };

  // 4. aspect ≤ maxAspect：先试普通缩放；缩放后短边不足再试切片（4c，救回 4000×800 这类扁图）
  if (aspect <= limits.maxAspect) {
    const scale = Math.min(1, limits.maxSide / longSide, Math.sqrt(limits.maxPixels / (w * h)));
    const rw = Math.max(1, Math.round(w * scale));
    const rh = Math.max(1, Math.round(h * scale));
    if (Math.min(rw, rh) >= limits.minUsefulWidth) {
      return { mode: 'resize', width: rw, height: rh, tiles: [], reasons: a.reasons, dropReason: null };
    }
    return planTiles(longSide, w, h, vertical, a.reasons, limits);
  }

  // 5. aspect > maxAspect → 切片
  return planTiles(longSide, w, h, vertical, a.reasons, limits);
}

async function probeWithFfmpeg(buffer, ffmpeg) {
  if (!ffmpeg) return null;
  const ext = detectImageType(buffer)?.ext || '.img';
  const tmp = tmpName('probe', ext);
  try {
    fs.writeFileSync(tmp, buffer);
    const err = await runFfmpegCapture(ffmpeg, ['-hide_banner', '-i', tmp, '-f', 'null', '-'], 20000);
    if (!err) return null;
    const m = /(\d{1,5})x(\d{1,5})/.exec(err);
    if (!m) return null;
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * 用 ffmpeg 等比缩放到长边 ≤ maxDim，并固定输出 JPEG。
 * 只要退出码 0 且输出非空就**无条件使用输出**，不比字节大小。
 * @returns {Promise<{buffer: Buffer, width: number|null, height: number|null} | null>}
 */
async function resizeToJpeg(buffer, { maxDim, quality, ffmpeg }) {
  if (!ffmpeg) return null;
  const inExt = detectImageType(buffer)?.ext || '.img';
  const tmpIn = tmpName('in', inExt);
  const tmpOut = tmpName('out', '.jpg');
  try {
    fs.writeFileSync(tmpIn, buffer);
    const ok = await runFfmpeg(ffmpeg, [
      '-y', '-i', tmpIn,
      '-vf', `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', String(quality),
      tmpOut
    ], 30000);
    if (!ok || !fs.existsSync(tmpOut)) return null;
    const out = fs.readFileSync(tmpOut);
    if (!out.length) return null;
    const meta = sniffImageMeta(out);
    return { buffer: out, width: meta?.width ?? null, height: meta?.height ?? null };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

const TILE_TOTAL_BUDGET_MS = 60000;    // 整张图切片总预算（按累计耗时判，不是"每块 25s"就算有总闸）
const TILE_SINGLE_TIMEOUT_MS = 25000;  // 单次 ffmpeg 上限

/**
 * 精确缩放到 width×height（切片前那一步）。
 * 只要退出码 0 且输出非空就**无条件使用输出**——这里不能复用 compressImage 的"变小才用"。
 */
async function scaleToJpeg(buffer, { width, height, quality, ffmpeg }) {
  if (!ffmpeg) return null;
  const inExt = detectImageType(buffer)?.ext || '.img';
  const tmpIn = tmpName('in', inExt);
  const tmpOut = tmpName('scaled', '.jpg');
  try {
    fs.writeFileSync(tmpIn, buffer);
    const ok = await runFfmpeg(ffmpeg, [
      '-y', '-i', tmpIn,
      '-vf', `scale=${width}:${height}`,
      '-q:v', String(quality),
      tmpOut
    ], 30000);
    if (!ok || !fs.existsSync(tmpOut)) return null;
    const out = fs.readFileSync(tmpOut);
    if (!out.length) return null;
    const meta = sniffImageMeta(out);
    if (!meta || !meta.width || !meta.height) return null;
    return { buffer: out, width: meta.width, height: meta.height };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

/**
 * 按 plan 落地切片：先缩放到 plan.width×plan.height，再逐块 crop（串行）。
 * 缩放后必须校验输出尺寸 == plan 尺寸：不等说明 ffmpeg 缩放参数/取整出问题，
 * 此时继续 crop 会切错位（甚至把画面拉伸），所以直接判失败。
 * 任一块失败 / 超总预算 → 返回 null 或 { fail }（上层 drop('tile_failed')），**不发半套**。
 * 临时文件统一在 finally 删除。
 */
async function tileImage(buffer, plan, { ffmpeg, limits }) {
  const startedAt = Date.now();
  const temps = [];
  const mkTmp = (prefix, ext) => { const p = tmpName(prefix, ext); temps.push(p); return p; };
  try {
    const scaled = await scaleToJpeg(buffer, {
      width: plan.width, height: plan.height, quality: limits.tileQuality, ffmpeg
    });
    if (!scaled) return { fail: 'scale failed' };
    if (scaled.width !== plan.width || scaled.height !== plan.height) {
      return { fail: `scale_mismatch expected=${plan.width}x${plan.height} actual=${scaled.width}x${scaled.height}` };
    }
    const scaledPath = mkTmp('scaled', '.jpg');
    fs.writeFileSync(scaledPath, scaled.buffer);

    const parts = [];
    for (let i = 0; i < plan.tiles.length; i++) {
      const remain = TILE_TOTAL_BUDGET_MS - (Date.now() - startedAt);
      if (remain <= 0) return null;   // 到 60s 立即中止，已生成的块随之清理
      const t = plan.tiles[i];
      const outPath = mkTmp('tile', '.jpg');
      const ok = await runFfmpeg(ffmpeg, [
        '-y', '-i', scaledPath,
        '-vf', `crop=${t.w}:${t.h}:${t.x}:${t.y}`,
        '-q:v', String(limits.tileQuality),
        outPath
      ], Math.min(TILE_SINGLE_TIMEOUT_MS, remain));
      if (!ok) return null;
      const buf = fs.readFileSync(outPath);
      if (!buf.length) return null;
      const m = sniffImageMeta(buf);
      if (!m || !m.width || !m.height) return null;
      const longSide = Math.max(m.width, m.height);
      const shortSide = Math.min(m.width, m.height);
      if (longSide > limits.maxSide || m.width * m.height > limits.maxPixels ||
          longSide / shortSide > limits.maxAspect) return null;
      parts.push({
        buffer: buf, mime: 'image/jpeg', width: m.width, height: m.height,
        tileIndex: i, tileCount: plan.tiles.length
      });
    }
    // parts 顺序即 tileIndex 顺序；少于 2 块说明规划与实现不一致，按失败处理
    if (parts.length !== plan.tiles.length || parts.length < 2) return null;
    return { parts, width: scaled.width, height: scaled.height };
  } catch {
    return null;
  } finally {
    for (const p of temps) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
}

function buildInput(buffer, meta) {
  return {
    bytes: buffer.length,
    mime: meta?.mime ?? null,
    width: meta?.width ?? null,
    height: meta?.height ?? null,
    // 显示尺寸之外的原始信息：orientation 供日志/排查，stored* 是存储轴尺寸（仅 JPEG 有）
    orientation: meta?.orientation ?? 1,
    storedWidth: meta?.storedWidth ?? null,
    storedHeight: meta?.storedHeight ?? null,
    recognized: !!meta?.recognized,
    animated: !!meta?.animated,
    alpha: !!meta?.alpha
  };
}

function passResult(buffer, meta, input, actions) {
  return {
    parts: [{ buffer, mime: meta.mime, width: meta.width, height: meta.height, tileIndex: 0, tileCount: 1 }],
    meta: {
      input,
      output: { bytes: buffer.length, mime: meta.mime, width: meta.width, height: meta.height, tiles: 0 },
      actions: [...actions, 'pass'],
      dropped: null
    }
  };
}

/**
 * 把下载到的图片字节变成可安全发送的部件；失败一律 parts=[] + meta.dropped，不抛守卫类错误。
 * @returns {Promise<{ parts: Array, meta: object }>}
 */
export async function prepareImage(buffer, { contentType = '', limits = IMAGE_LIMITS, tools = null } = {}) {
  const inputMeta = sniffImageMeta(buffer);
  const input = buildInput(buffer, inputMeta);
  const actions = [];
  const drop = (code, detail = '') => ({
    parts: [],
    meta: { input, output: null, actions, dropped: { code, detail } }
  });

  // 0. 未知格式：不得回落 image/jpeg，也不得送进 compressImage。
  if (!inputMeta || !inputMeta.recognized) {
    return drop('unknown_format', contentType ? `contentType=${contentType}` : '');
  }

  let working = buffer;
  let meta = inputMeta;
  let transcodes = 0;

  // 0b. TIFF/HEIC：先用 ffmpeg 转 JPEG，再重新嗅探并重判。
  if (meta.needsTranscode) {
    const ffmpeg = await resolveFfmpeg(tools);
    if (!ffmpeg) return drop('ffmpeg_unavailable', 'needs transcode but no ffmpeg');
    actions.push('transcode');
    const out = await resizeToJpeg(working, { maxDim: limits.maxSide, quality: limits.jpegQuality, ffmpeg });
    if (!out) return drop('prepare_failed', 'transcode failed');
    working = out.buffer;
    meta = sniffImageMeta(working);
    transcodes += 1;
    if (!meta || !meta.recognized) return drop('prepare_failed', 'transcoded bytes unrecognized');
  }

  for (;;) {
    // 1. 尺寸仍未知：先尝试 ffmpeg 探测；已知格式且 ≤512KB 按安全小图放行；否则 unknown_geometry。
    if (!Number.isFinite(meta.width) || !Number.isFinite(meta.height) || meta.width <= 0 || meta.height <= 0) {
      const ffmpeg = await resolveFfmpeg(tools);
      const probed = await probeWithFfmpeg(working, ffmpeg);
      if (probed) {
        // ffmpeg -i 报的是**存储**（coded）尺寸；5–8 要换成显示尺寸，否则下游会把竖图当横图。
        const swap = (meta.orientation || 1) >= 5;
        meta = {
          ...meta,
          storedWidth: swap ? probed.width : (meta.storedWidth ?? probed.width),
          storedHeight: swap ? probed.height : (meta.storedHeight ?? probed.height),
          width: swap ? probed.height : probed.width,
          height: swap ? probed.width : probed.height
        };
      } else if (working.length <= 512 * 1024) {
        actions.push('pass_small');
        return {
          parts: [{ buffer: working, mime: meta.mime, width: null, height: null, tileIndex: 0, tileCount: 1 }],
          meta: {
            input,
            output: { bytes: working.length, mime: meta.mime, width: null, height: null, tiles: 0 },
            actions,
            dropped: null
          }
        };
      } else {
        return drop('unknown_geometry');
      }
    }

    const w = meta.width;
    const h = meta.height;

    // 2. 解码像素上限（防解码炸弹）
    if (w * h > limits.maxDecodePixels) return drop('too_many_pixels_to_decode');

    const a = assessImage({ width: w, height: h }, limits);
    const withinBytes = working.length <= limits.maxInputBytes;

    // 3. 几何合规 + 字节合规 → 原样 pass
    if (a.ok && withinBytes) {
      return passResult(working, meta, input, actions);
    }

    // 3b. 几何合规、但字节超 maxInputBytes → 必须转码（最多再转一次）
    if (a.ok && !withinBytes) {
      if (transcodes >= 2) return drop('prepare_failed', 'still over maxInputBytes after transcode');
      const ffmpeg = await resolveFfmpeg(tools);
      if (!ffmpeg) return drop('ffmpeg_unavailable', 'over maxInputBytes but no ffmpeg');
      actions.push('transcode_bytes');
      const out = await resizeToJpeg(working, {
        maxDim: Math.min(limits.maxSide, Math.max(w, h)),
        quality: limits.jpegQuality,
        ffmpeg
      });
      if (!out) return drop('prepare_failed', 'transcode for maxInputBytes failed');
      working = out.buffer;
      meta = sniffImageMeta(working);
      transcodes += 1;
      if (!meta || !meta.recognized) return drop('prepare_failed', 'transcoded bytes unrecognized');
      continue;
    }

    // 4 / 5. 几何超限：先规划（resize / tile / drop）。阶段 B 起长图不再一律省略。
    const plan = planImageTiles({ width: w, height: h }, limits);
    if (plan.mode === 'drop') {
      const detail = plan.dropReason === 'too_narrow_after_resize'
        ? `${w}x${h}`
        : (plan.dropReason === 'tile_failed'
          ? `tiles=${plan.tiles.length} invalid`
          : (plan.dropReason === 'too_many_tiles'
            ? `tiles=${plan.tiles.length}`
            : `aspect=${(Math.max(w, h) / Math.min(w, h)).toFixed(2)}`));
      return drop(plan.dropReason, detail);
    }

    const ffmpeg = await resolveFfmpeg(tools);
    if (!ffmpeg) {
      return drop('ffmpeg_unavailable', plan.mode === 'tile' ? 'needs tiling but no ffmpeg' : 'needs resize but no ffmpeg');
    }

    if (plan.mode === 'tile') {
      const tiled = await tileImage(working, plan, { ffmpeg, limits });
      // fail 里带 expected/actual，直接落进 dropped.detail，便于定位缩放取整问题
      if (!tiled || tiled.fail) return drop('tile_failed', tiled?.fail || `planned ${plan.tiles.length} tiles`);
      actions.push('tile');
      const bytes = tiled.parts.reduce((n, p) => n + p.buffer.length, 0);
      return {
        parts: tiled.parts,
        meta: {
          input,
          // tiles 是**块数**（不是矩形数组）；bytes 是所有块的字节和，不是缩放图或首块
          output: { bytes, mime: 'image/jpeg', width: tiled.width, height: tiled.height, tiles: tiled.parts.length },
          actions,
          dropped: null
        }
      };
    }

    // plan.mode === 'resize'：只有长边/像素超限、短边仍可读
    const out = await resizeToJpeg(working, { maxDim: limits.maxSide, quality: limits.jpegQuality, ffmpeg });
    if (!out) return drop('prepare_failed', 'resize failed');
    const outMeta = sniffImageMeta(out.buffer);
    const ow = outMeta?.width ?? out.width;
    const oh = outMeta?.height ?? out.height;
    if (ow && oh && Math.min(ow, oh) < limits.minUsefulWidth) {
      return drop('too_narrow_after_resize', `${ow}x${oh}`);
    }
    actions.push('resize');
    return {
      parts: [{ buffer: out.buffer, mime: 'image/jpeg', width: ow, height: oh, tileIndex: 0, tileCount: 1 }],
      meta: {
        input,
        output: { bytes: out.buffer.length, mime: 'image/jpeg', width: ow, height: oh, tiles: 0 },
        actions,
        dropped: null
      }
    };
  }
}
