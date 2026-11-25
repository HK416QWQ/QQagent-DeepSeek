// image-prep 测试：嗅探、几何判定、切片规划、无 ffmpeg 省略、有 ffmpeg 缩放/转码/切片、临时文件清理。
// 阶段 B 起长图走切片（§5）；无 ffmpeg 时仍必须明确省略，不能原样发送。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { IMAGE_LIMITS, sniffImageMeta, assessImage, planImageTiles, prepareImage } from '../src/image-prep.js';
import { ensureFf } from '../src/image-compress.js';

let passed = 0;
function ok(name) { passed += 1; console.log(`  ✓ ${name}`); }

// ── 构造最小图片头（只够嗅探，不保证 ffmpeg 可解码）──
function pngHeader(w, h, colorType = 6) {
  const b = Buffer.alloc(26);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = colorType;
  return b;
}
function gifHeader(w, h) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function jpegHeader(w, h) {
  const sof = Buffer.alloc(10);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(8, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}
function webpHeader(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b[20] = 0x10; // alpha flag
  const wm = w - 1;
  const hm = h - 1;
  b[24] = wm & 0xff; b[25] = (wm >> 8) & 0xff; b[26] = (wm >> 16) & 0xff;
  b[27] = hm & 0xff; b[28] = (hm >> 8) & 0xff; b[29] = (hm >> 16) & 0xff;
  return b;
}
function bmpHeader(w, h) {
  const b = Buffer.alloc(54);
  b[0] = 0x42; b[1] = 0x4d;
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  return b;
}

/** 在 SOI 后插一个只含 Orientation(0x0112) 的 APP1(Exif) 段；littleEndian 用于验证 II 分支。 */
function withExifOrientation(jpeg, orientation, { littleEndian = false } = {}) {
  const le = littleEndian;
  const tiff = Buffer.alloc(26);
  tiff.write(le ? 'II' : 'MM', 0, 'ascii');
  if (le) {
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    tiff.writeUInt16LE(0, 20);
    tiff.writeUInt32LE(0, 22);
  } else {
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    tiff.writeUInt16BE(0, 20);
    tiff.writeUInt32BE(0, 22);
  }
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.alloc(4 + payload.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1.writeUInt16BE(2 + payload.length, 2);
  payload.copy(app1, 4);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

/** 一个不是 Exif 的 APP1（冒充 XMP），解析器必须跳过它而不是报错。 */
function withForeignApp1(jpeg) {
  const payload = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x/>', 'binary');
  const app1 = Buffer.alloc(4 + payload.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1.writeUInt16BE(2 + payload.length, 2);
  payload.copy(app1, 4);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

// 1. 嗅探：PNG / GIF / JPEG / WebP / BMP 尺寸正确
{
  assert.equal(sniffImageMeta(pngHeader(1254, 1254)).width, 1254);
  assert.equal(sniffImageMeta(pngHeader(1254, 1254)).height, 1254);
  assert.equal(sniffImageMeta(gifHeader(320, 240)).width, 320);
  assert.equal(sniffImageMeta(gifHeader(320, 240)).height, 240);
  assert.equal(sniffImageMeta(jpegHeader(800, 600)).width, 800);
  assert.equal(sniffImageMeta(jpegHeader(800, 600)).height, 600);
  assert.equal(sniffImageMeta(webpHeader(640, 480)).width, 640);
  assert.equal(sniffImageMeta(webpHeader(640, 480)).height, 480);
  assert.equal(sniffImageMeta(bmpHeader(200, 100)).width, 200);
  assert.equal(sniffImageMeta(bmpHeader(200, 100)).height, 100);
  ok('嗅探：PNG/GIF/JPEG/WebP/BMP 尺寸正确');
}

// 1b. EXIF Orientation 解析（R1）：1–8 取值、5–8 用显示尺寸、缺失/非法/非 JPEG 一律 1
{
  for (let o = 1; o <= 8; o++) {
    const m = sniffImageMeta(withExifOrientation(jpegHeader(6000, 800), o));
    assert.equal(m.orientation, o, `Orientation=${o} 应被解析出来`);
    assert.equal(m.storedWidth, 6000, 'storedWidth 是存储轴宽度');
    assert.equal(m.storedHeight, 800, 'storedHeight 是存储轴高度');
    if (o >= 5) {
      assert.equal(m.width, 800, `Orientation=${o} 的显示宽 = 存储高`);
      assert.equal(m.height, 6000, `Orientation=${o} 的显示高 = 存储宽`);
    } else {
      assert.equal(m.width, 6000, `Orientation=${o} 显示宽不变`);
      assert.equal(m.height, 800, `Orientation=${o} 显示高不变`);
    }
  }

  // II（小端）TIFF：同一套 tag，字节序不同也必须读出来
  const le = sniffImageMeta(withExifOrientation(jpegHeader(6000, 800), 6, { littleEndian: true }));
  assert.equal(le.orientation, 6, '小端 TIFF 的 Orientation 也应解析');
  assert.equal(le.width, 800, '小端同样按显示尺寸给宽高');

  // 缺失 → 1
  assert.equal(sniffImageMeta(jpegHeader(6000, 800)).orientation, 1, '没有 APP1 时按 1');
  // 非法值 → 1（不得抛错，也不得当成 5–8 交换）
  for (const bad of [0, 9, 65535]) {
    const m = sniffImageMeta(withExifOrientation(jpegHeader(6000, 800), bad));
    assert.equal(m.orientation, 1, `非法 Orientation=${bad} 按 1`);
    assert.equal(m.width, 6000, `非法 Orientation=${bad} 不得交换宽高`);
  }
  // 非 Exif 的 APP1（XMP）→ 跳过，按 1
  assert.equal(sniffImageMeta(withForeignApp1(jpegHeader(6000, 800))).orientation, 1, '非 Exif APP1 按 1');
  // 非 JPEG → 一律 1
  assert.equal(sniffImageMeta(pngHeader(1254, 1254)).orientation, 1, 'PNG 的 orientation 恒为 1');
  // 截断字节不得抛错
  const trunc = withExifOrientation(jpegHeader(6000, 800), 6).subarray(0, 30);
  assert.doesNotThrow(() => sniffImageMeta(trunc), '截断的 Exif 段不得抛错');

  ok('EXIF Orientation：1–8 正确解析（含小端），5–8 用显示尺寸，缺失/非法/非 Exif/非 JPEG 按 1');
}

// 2. 未知字节：recognized=false，不得回落 image/jpeg
{
  const unknown = Buffer.from('this is definitely not an image');
  assert.equal(sniffImageMeta(unknown), null);
  ok('未知字节：recognized=false，不回落 JPEG');
}

// 3. assessImage：reasons 全量、顺序固定
{
  assert.deepEqual(assessImage({ width: 1254, height: 1254 }).reasons, []);
  assert.deepEqual(assessImage({ width: 2000, height: 1000 }).reasons, ['max_side']);
  assert.deepEqual(assessImage({ width: 1170, height: 13680 }).reasons, ['max_side', 'max_pixels', 'max_aspect']);
  assert.deepEqual(assessImage({ width: 1254, height: 1254 }).ok, true);
  ok('assessImage：全量 reasons + 固定顺序');
}

// 3b. planImageTiles：阶段 B 切片规划（§5.1）
{
  const L = IMAGE_LIMITS;

  // 1170×13680 长图：≤8 块，每块短边 ≥640，按顺序覆盖到末尾
  const p1 = planImageTiles({ width: 1170, height: 13680 });
  assert.equal(p1.mode, 'tile');
  assert.equal(p1.tiles.length, 8, `1170×13680 应切 8 块（实际 ${p1.tiles.length}）`);
  assert.ok(p1.tiles.length <= L.maxTiles);
  for (const t of p1.tiles) {
    assert.ok(t.w <= L.maxSide && t.h <= L.maxSide, `块 ${t.x},${t.y} 长边 ≤${L.maxSide}`);
    assert.ok(Math.min(t.w, t.h) >= L.minUsefulWidth, '每块短边 ≥640');
    assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= p1.width && t.y + t.h <= p1.height, '块不越界');
    assert.ok(Math.max(t.w, t.h) / Math.min(t.w, t.h) <= L.maxAspect, '每块长宽比 ≤ maxAspect');
  }
  assert.equal(p1.tiles[0].y, 0, '第一块从顶上开始');
  assert.equal(p1.tiles.at(-1).y + p1.tiles.at(-1).h, p1.height, '最后一块覆盖到末尾');
  for (let i = 1; i < p1.tiles.length; i++) {
    const overlap = p1.tiles[i - 1].y + p1.tiles[i - 1].h - p1.tiles[i].y;
    assert.ok(overlap >= L.tileOverlap, `相邻块重叠应 ≥64，第 ${i} 块实际 ${overlap}`);
  }

  // 6000×800 全景（aspect=7.5）：横向切片，覆盖完整宽度
  const p2 = planImageTiles({ width: 6000, height: 800 });
  assert.equal(p2.mode, 'tile');
  assert.ok(p2.tiles.length <= L.maxTiles);
  assert.equal(p2.tiles[0].x, 0, '横向从左边开始');
  assert.equal(p2.tiles.at(-1).x + p2.tiles.at(-1).w, p2.width, '横向覆盖完整宽度');
  for (const t of p2.tiles) {
    assert.equal(t.y, 0, '横向切片的 y 恒为 0');
    assert.ok(t.x + t.w <= p2.width, '块不越界');
  }

  // 4000×800（aspect=5 ≤ maxAspect）：走 4c 分支 → 切片，不是 drop
  const p2c = planImageTiles({ width: 4000, height: 800 });
  assert.equal(p2c.mode, 'tile', '4000×800 必须切片（4c），不能判成 too_narrow_after_resize');
  assert.equal(p2c.tiles.length, 3, `4000×800 应切 3 块（实际 ${p2c.tiles.length}）`);
  assert.equal(Math.min(p2c.tiles[0].w, p2c.tiles[0].h), 800, '短边保持 800 可读');

  // 6000×500：短边 500 < 640 → 整图省略，不得切成 1568×500
  const p2b = planImageTiles({ width: 6000, height: 500 });
  assert.equal(p2b.mode, 'drop');
  assert.equal(p2b.dropReason, 'too_narrow_after_resize');

  // 200×20000：缩后短边 121 < 640 → 省略，原因不是 too_many_tiles
  const p4 = planImageTiles({ width: 200, height: 20000 });
  assert.equal(p4.mode, 'drop');
  assert.equal(p4.dropReason, 'too_narrow_after_resize', '不是 too_many_tiles');

  // 普通方图：pass，tiles 必须是空数组（不能用"1 块整图"表示）
  const p3 = planImageTiles({ width: 1254, height: 1254 });
  assert.equal(p3.mode, 'pass');
  assert.deepEqual(p3.tiles, [], 'pass 时 tiles 必须是空数组');

  ok('planImageTiles：长图 8 块 / 横向 4 块 / 4c 扁图 3 块；超窄省略；方图 pass');
}

// 4. 无 ffmpeg 分支（tools 显式注入 null，确定性）
{
  const noFf = { ffmpeg: null };

  const one = pngHeader(1, 1);
  const p1 = await prepareImage(one, { tools: noFf });
  assert.equal(p1.parts.length, 1, '1×1 PNG 应 pass');
  assert.deepEqual(p1.parts[0].buffer, one, '安全小图原字节返回');
  assert.equal(p1.meta.dropped, null);

  // B5：长图本该切片，但没有 ffmpeg → 必须明确省略，不得原样发送
  const longPng = pngHeader(1170, 13680);
  const pLong = await prepareImage(longPng, { tools: noFf });
  assert.equal(pLong.parts.length, 0, '无 ffmpeg 不得原样发送长图');
  assert.equal(pLong.meta.dropped.code, 'ffmpeg_unavailable', '无 ffmpeg 时长图明确省略');

  // A1：2.4MB、极端长宽比（1170×13680，aspect≈11.7）→ 字节在 4MB 预算内，纯几何判定；
  // 阶段 B 无 ffmpeg 时同样只能省略，绝不能原样发出去撞 400。
  const widePng = Buffer.concat([pngHeader(1170, 13680), Buffer.alloc(Math.round(2.4 * 1024 * 1024))]);
  const pWide = await prepareImage(widePng, { tools: noFf });
  assert.equal(pWide.parts.length, 0, '2.4MB 极端长宽比不得发送');
  assert.equal(pWide.meta.dropped.code, 'ffmpeg_unavailable');
  assert.ok(String(pWide.meta.dropped.detail).includes('tiling'), '省略原因说明需要切片但没有 ffmpeg');

  const big = Buffer.concat([pngHeader(3000, 3000), Buffer.alloc(1024 * 1024)]);
  const pBig = await prepareImage(big, { tools: noFf });
  assert.equal(pBig.meta.dropped.code, 'ffmpeg_unavailable', '需要缩放但无 ffmpeg 禁止返回原图');

  const big5 = Buffer.concat([pngHeader(1254, 1254), Buffer.alloc(5 * 1024 * 1024)]);
  const pBig5 = await prepareImage(big5, { tools: noFf });
  assert.equal(pBig5.meta.dropped.code, 'ffmpeg_unavailable', '几何合规但字节超限、无 ffmpeg 只能省略');
  assert.equal(pBig5.parts.length, 0, '不得 pass 原图');

  const pUnk = await prepareImage(Buffer.from('unknown bytes 1234567890'), { tools: noFf });
  assert.equal(pUnk.meta.dropped.code, 'unknown_format');
  assert.equal(pUnk.parts.length, 0);
  ok('无 ffmpeg：小图 pass、长图/超限/未知均明确省略');
}

// 5. 有 ffmpeg 分支（真实 ffmpeg）
{
  const ff = await ensureFf();
  if (!ff.ffmpeg) throw new Error('测试需要 ffmpeg（项目应自带 tools/ffmpeg/ffmpeg.exe）');
  const tools = { ffmpeg: ff.ffmpeg };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-prep-test-'));
  const gen = (name, args) => {
    const out = path.join(tmpDir, name);
    execFileSync(ff.ffmpeg, ['-y', ...args, out], { stdio: 'ignore' });
    return fs.readFileSync(out);
  };
  try {
    // 3000×3000 平色 PNG：几何超限 → 缩放成功，输出 ≤1568
    const flat = gen('flat.png', ['-f', 'lavfi', '-i', 'color=c=red:s=3000x3000', '-frames:v', '1']);
    const pFlat = await prepareImage(flat, { tools });
    assert.equal(pFlat.parts.length, 1);
    assert.equal(pFlat.parts[0].mime, 'image/jpeg');
    assert.ok(pFlat.parts[0].width <= 1568 && pFlat.parts[0].height <= 1568, '缩放后长边 ≤1568');
    // 平色 PNG 转 JPEG 后字节反增，也必须用输出（不是原图）
    assert.notDeepEqual(pFlat.parts[0].buffer, flat, '输出即使更大也必须使用缩放结果');
    assert.ok(pFlat.parts[0].buffer.length > flat.length, '该用例本身就是“输出更大”');

    // 1254×1254、>4MB PNG：几何合规但字节超限 → 转码 JPEG，字节明显变小
    const bigPng = gen('big.png', [
      '-f', 'lavfi', '-i', 'testsrc2=s=1254x1254', '-frames:v', '1',
      '-pred', 'none', '-compression_level', '0'
    ]);
    assert.ok(bigPng.length > IMAGE_LIMITS.maxInputBytes, `构造的 PNG 应 >4MB，实际 ${bigPng.length}`);
    const pBig = await prepareImage(bigPng, { tools });
    assert.equal(pBig.parts.length, 1);
    assert.equal(pBig.parts[0].mime, 'image/jpeg');
    assert.ok(pBig.parts[0].buffer.length < bigPng.length, '转码后字节应明显小于原图');
    assert.ok(pBig.meta.actions.includes('transcode_bytes'), '字节超限应走 maxInputBytes 转码，而不是原样 pass');
    assert.equal(pBig.meta.input.bytes, bigPng.length, 'input.bytes 是原图字节');
    assert.ok(pBig.meta.output.bytes < bigPng.length, 'output.bytes 应小于原图');

    // A2：已知但 needsTranscode 的 TIFF（嗅探认得、上游不收）→ 能转码则转成 JPEG 再发
    const tif = gen('t.tif', ['-f', 'lavfi', '-i', 'color=c=blue:s=800x600', '-frames:v', '1']);
    const pTif = await prepareImage(tif, { tools });
    assert.equal(pTif.parts.length, 1, 'TIFF 应转码后发送，而不是省略');
    assert.equal(pTif.parts[0].mime, 'image/jpeg');
    assert.ok(pTif.meta.actions.includes('transcode'), '走的是类型转码而非字节转码');

    // 阶段 B 集成：1170×13680 长图 → 真切片
    const longPng = gen('long.png', ['-f', 'lavfi', '-i', 'color=c=white:s=1170x13680', '-frames:v', '1']);
    const pLong = await prepareImage(longPng, { tools });
    assert.ok(pLong.parts.length > 1, `长图应切成多块（实际 ${pLong.parts.length}）`);
    assert.ok(pLong.meta.actions.includes('tile'), '走切片动作');
    assert.equal(pLong.meta.output.tiles, pLong.parts.length, 'output.tiles 是块数');
    assert.ok(pLong.meta.output.tiles <= IMAGE_LIMITS.maxTiles, '块数 ≤ maxTiles');
    let sum = 0;
    for (const part of pLong.parts) {
      assert.equal(part.mime, 'image/jpeg', '切片默认 JPEG');
      const m = sniffImageMeta(part.buffer);
      assert.ok(m && m.width && m.height, '每块可被嗅探');
      assert.ok(m.width <= IMAGE_LIMITS.maxSide && m.height <= IMAGE_LIMITS.maxSide, '每块长边不超限');
      assert.ok(Math.min(m.width, m.height) >= IMAGE_LIMITS.minUsefulWidth, '每块短边 ≥640');
      sum += part.buffer.length;
    }
    assert.equal(pLong.meta.output.bytes, sum, 'output.bytes 是所有块之和，不是首块或缩放图');
    assert.ok(sum <= IMAGE_LIMITS.maxTotalMediaBytes, '总字节 ≤ maxTotalMediaBytes');
    assert.deepEqual(pLong.parts.map((p) => p.tileIndex), pLong.parts.map((_, i) => i), 'parts 顺序与 tileIndex 一致');

    // B2c：4000×800（aspect=5）走 4c，真实切 3 块而不是省略
    const pano = gen('pano.png', ['-f', 'lavfi', '-i', 'color=c=green:s=4000x800', '-frames:v', '1']);
    const pPano = await prepareImage(pano, { tools });
    assert.equal(pPano.parts.length, 3, `4000×800 应切 3 块（实际 ${pPano.parts.length}）`);

    // R1 集成：存储 6000×800 + Orientation=6 → 显示 800×6000，必须切成 4 块 800×1568 竖块。
    // 若错按存储轴规划，会切出 4 块 1568×800，把画面拉横 —— 那是静默变形，不是"按存储轴切片"。
    const wideJpeg = gen('wide.jpg', ['-f', 'lavfi', '-i', 'testsrc2=s=6000x800', '-frames:v', '1', '-q:v', '3']);
    const rotJpeg = withExifOrientation(wideJpeg, 6);
    const pRot = await prepareImage(rotJpeg, { tools });
    assert.equal(pRot.meta.input.orientation, 6, 'input.orientation 应为 6');
    assert.equal(pRot.meta.input.width, 800, 'input 宽 = 显示宽');
    assert.equal(pRot.meta.input.height, 6000, 'input 高 = 显示高');
    assert.equal(pRot.meta.input.storedWidth, 6000, 'input.storedWidth 保留存储宽');
    assert.ok(pRot.meta.actions.includes('tile'), 'Orientation=6 的长图应切片');
    assert.equal(pRot.parts.length, 4, `Orientation=6 应切 4 块（实际 ${pRot.parts.length}）`);
    const rotPlan = planImageTiles({ width: 800, height: 6000 });
    assert.equal(rotPlan.tiles.length, 4, '显示尺寸规划 4 块');
    for (let i = 0; i < pRot.parts.length; i++) {
      assert.equal(pRot.parts[i].width, 800, `竖块第 ${i} 块宽 800（不是 1568）`);
      assert.equal(pRot.parts[i].height, 1568, `竖块第 ${i} 块高 1568（不是 800）`);
      assert.equal(pRot.parts[i].width, rotPlan.tiles[i].w, '输出宽与规划一致，无变形');
      assert.equal(pRot.parts[i].height, rotPlan.tiles[i].h, '输出高与规划一致，无变形');
    }

    // 同一张图去掉 Orientation：仍 4 块，但必须是 1568×800 横块（证明 1–4 没被改坏）
    const pFlatWide = await prepareImage(wideJpeg, { tools });
    assert.equal(pFlatWide.meta.input.orientation, 1, '无 EXIF 时 orientation=1');
    assert.equal(pFlatWide.parts.length, 4, `无 Orientation 也应 4 块（实际 ${pFlatWide.parts.length}）`);
    const widePlan = planImageTiles({ width: 6000, height: 800 });
    for (let i = 0; i < pFlatWide.parts.length; i++) {
      assert.equal(pFlatWide.parts[i].width, 1568, `横块第 ${i} 块宽 1568`);
      assert.equal(pFlatWide.parts[i].height, 800, `横块第 ${i} 块高 800`);
      assert.equal(pFlatWide.parts[i].width, widePlan.tiles[i].w, '横块输出宽与规划一致');
    }

    // R6：奇数尺寸回归。1171×13681 缩放后有取整，必须仍按精确尺寸切，不得误报 tile_failed
    const oddPng = gen('odd.png', ['-f', 'lavfi', '-i', 'color=c=white:s=1171x13681', '-frames:v', '1', '-pix_fmt', 'rgb24']);
    const pOdd = await prepareImage(oddPng, { tools });
    const oddPlan = planImageTiles({ width: 1171, height: 13681 });
    assert.equal(pOdd.meta.dropped, null,
      `奇数尺寸不得 drop（实际 ${pOdd.meta.dropped?.code ?? '-'} ${pOdd.meta.dropped?.detail ?? ''}）`);
    assert.equal(pOdd.parts.length, oddPlan.tiles.length, '奇数尺寸块数与规划一致');
    for (let i = 0; i < pOdd.parts.length; i++) {
      assert.equal(pOdd.parts[i].width, oddPlan.tiles[i].w, `奇数尺寸第 ${i} 块宽与规划一致`);
      assert.equal(pOdd.parts[i].height, oddPlan.tiles[i].h, `奇数尺寸第 ${i} 块高与规划一致`);
    }

    ok('有 ffmpeg：3000 缩放 / 1254×1254 5MB 转码（守 3b）/ TIFF 转码 / 长图切片 / 4c 扁图切片');
    ok('Orientation=6：6000×800 显示 800×6000 → 4 块 800×1568 竖块；去 EXIF 仍 4 块 1568×800；奇数尺寸按规划精确切');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 6. 临时文件清理：os.tmpdir() 下没有残留 qqa_img_*
{
  const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('qqa_img_'));
  assert.equal(leftovers.length, 0, `发现残留临时文件：${leftovers.join(', ')}`);
  ok('临时文件清理：无 qqa_img_* 残留');
}

console.log(`\nimage-prep-test：${passed} 组通过 ✅`);
process.exit(0);
