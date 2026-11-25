// zip 解压防护：声明超大 / 谎报大小 / ZIP64 都必须在解压前被拒绝；正常包照常安装。
// 离线运行，不连网；只有"正常安装"用例写系统临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { validateZipStructure, unzipToModuleDir } from '../src/zip-install.js';

function buildZip(entries) {
  const locals = [];
  const cds = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const isDir = e.name.endsWith('/');
    const payload = isDir ? Buffer.alloc(0) : (e.method === 0 ? e.data : deflateRawSync(e.data));
    const declared = e.declaredSize != null ? e.declaredSize : (isDir ? 0 : e.data.length);
    const method = isDir ? 0 : (e.method === 0 ? 0 : 8);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(0, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(declared, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(0, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(declared, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);

    const local = Buffer.concat([lfh, nameBuf, payload]);
    locals.push(local);
    cds.push(Buffer.concat([cdh, nameBuf]));
    offset += local.length;
  }
  const body = Buffer.concat(locals);
  const cd = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}

// ① 正常单文件
const good = Buffer.from('hello zip');
const one = validateZipStructure(buildZip([{ name: 'a.txt', data: good }]));
assert.equal(one.length, 1);
assert.equal(one[0].data.toString(), 'hello zip');

// ② 正常包（一层根目录 + 子目录）能真正装到临时目录
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-zip-'));
const pkg = buildZip([
  { name: 'demo/' , data: Buffer.alloc(0) },
  { name: 'demo/plugin.json', data: Buffer.from('{"id":"demo"}') },
  { name: 'demo/lib/a.js', data: Buffer.from('export default 1;') }
]);
const dirName = await unzipToModuleDir(pkg, { root: tmpRoot, type: 'plugin', preferId: 'demo' });
assert.equal(dirName, 'demo');
assert.equal(fs.readFileSync(path.join(tmpRoot, 'plugins', 'demo', 'plugin.json'), 'utf8'), '{"id":"demo"}');
assert.ok(fs.existsSync(path.join(tmpRoot, 'plugins', 'demo', 'lib', 'a.js')));
fs.rmSync(tmpRoot, { recursive: true, force: true });

// ③ 声明 40MB：解压前就拒绝
assert.throws(
  () => validateZipStructure(buildZip([{ name: 'bomb.bin', data: Buffer.alloc(64), declaredSize: 40 * 1024 * 1024 }])),
  /32MB/
);

// ④ 谎报 16 字节、实际 2MB：解压中被 maxOutputLength 拦住
assert.throws(
  () => validateZipStructure(buildZip([{ name: 'liar.bin', data: Buffer.alloc(2 * 1024 * 1024), declaredSize: 16 }])),
  Error
);

// ⑤ 可读的 ZIP64 中央目录（uncompressedSize = 0xFFFFFFFF）→ 明确拒绝
assert.throws(
  () => validateZipStructure(buildZip([{ name: 'big.bin', data: Buffer.from('x'), declaredSize: 0xFFFFFFFF }])),
  /ZIP64/
);

console.log('zip-bomb-test OK');
