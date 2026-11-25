import assert from 'node:assert/strict';
import { buildStickerContext, findSticker } from '../src/stickers.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

// 25 条：前 3 条用可读 id（固定选取用例引用），其余按使用次数递减。
const entries = [
  { id: 'id-high', desc: '招手', useCount: 100 },
  { id: 'id-second', localNote: '点头', useCount: 95 },
  { id: 'id-third', desc: '鼓掌', useCount: 90 },
  ...Array.from({ length: 22 }, (_, i) => ({
    id: `id-${i + 4}`,
    desc: `第${i + 4}个`,
    useCount: 85 - i
  }))
];

const linesOf = (output) => output.split('\n').filter((line) => line.startsWith('- '));

check('1. 无轮换：同一组 entries 连续调用输出完全一致', () => {
  const a = buildStickerContext(entries, 6);
  const b = buildStickerContext(entries, 6);
  assert.equal(a, b);
});

check('2. 固定选取：按 selectedIds 顺序输出', () => {
  const output = buildStickerContext(entries, 10, { selectedIds: ['id-third', 'id-high'] });
  const lines = linesOf(output);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('id=id-third'), lines[0]);
  assert.ok(lines[1].includes('id=id-high'), lines[1]);
});

check('3. 去重：同一 id 勾两次只输出一行', () => {
  const output = buildStickerContext(entries, 10, { selectedIds: ['id-high', 'id-high'] });
  assert.equal(linesOf(output).length, 1);
});

check('4. 缺失 id：忽略且不自动补位', () => {
  const output = buildStickerContext(entries, 10, { selectedIds: ['nope', 'id-high'] });
  const lines = linesOf(output);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('id=id-high'), lines[0]);
});

check('5. 全部缺失：回退到 useCount 最高的 max 条', () => {
  const output = buildStickerContext(entries, 3, { selectedIds: ['nope'] });
  const lines = linesOf(output);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('id=id-high'), lines[0]);
  assert.ok(lines[1].includes('id=id-second'), lines[1]);
  assert.ok(lines[2].includes('id=id-third'), lines[2]);
});

check('6. 提示词侧截断：选 6 个、max=3 只输出前 3 个', () => {
  const output = buildStickerContext(entries, 3, {
    selectedIds: ['id-5', 'id-second', 'id-9', 'id-high', 'id-7', 'id-third']
  });
  const lines = linesOf(output);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('id=id-5'), lines[0]);
  assert.ok(lines[1].includes('id=id-second'), lines[1]);
  assert.ok(lines[2].includes('id=id-9'), lines[2]);
});

check('7a. id 门槛：max=20 每行带 id', () => {
  const lines = linesOf(buildStickerContext(entries.slice(0, 20), 20));
  assert.equal(lines.length, 20);
  assert.ok(lines.every((line) => line.includes('id=')), '20 条应带 id');
});

check('7b. id 门槛：max=21 不带 id', () => {
  const lines = linesOf(buildStickerContext(entries.slice(0, 21), 21));
  assert.equal(lines.length, 21);
  assert.ok(lines.every((line) => !line.includes('id=')), '21 条不应带 id');
});

check('7c. id 门槛看实际条数：固定 2 条 + max=30 仍带 id', () => {
  const lines = linesOf(buildStickerContext(entries, 30, { selectedIds: ['id-high', 'id-second'] }));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.includes('id=')), '实际 2 条应带 id');
});

check('8. 备注优先级：localNote 覆盖 desc', () => {
  const output = buildStickerContext([
    { id: 'note-1', desc: '旧备注', localNote: '新笔记', useCount: 1 }
  ], 10);
  assert.ok(output.includes('新笔记'), output);
  assert.ok(!output.includes('旧备注'), output);
});

check('9. 笔记截断：行内标签最多 40 字', () => {
  const long = '字'.repeat(50);
  const lines = linesOf(buildStickerContext([{ id: 'long-1', localNote: long, useCount: 1 }], 10));
  assert.ok(lines[0].includes('字'.repeat(40)), '应保留前 40 字');
  assert.ok(!lines[0].includes('字'.repeat(41)), '不应超过 40 字');
});

check('10. 不展示使用次数', () => {
  const lines = linesOf(buildStickerContext(entries, 10));
  assert.ok(lines.every((line) => !/用过|次|常用|高频|偶尔/.test(line)), '条目行不应含使用频次标注');
});

check('11. 空数组 / null / 无效条目返回空串', () => {
  assert.equal(buildStickerContext([]), '');
  assert.equal(buildStickerContext(null), '');
  assert.equal(buildStickerContext([null, {}, { id: '' }]), '');
});

check('12. 总数不超过 max 时全部列出', () => {
  const lines = linesOf(buildStickerContext(entries.slice(0, 3), 10));
  assert.equal(lines.length, 3);
});

check('13. 固定顺序稳定：变更只影响对应位置', () => {
  const first = buildStickerContext(entries, 10, { selectedIds: ['id-7', 'id-second'] });
  const again = buildStickerContext(entries, 10, { selectedIds: ['id-7', 'id-second'] });
  assert.equal(first, again);
  const changed = linesOf(buildStickerContext(entries, 10, { selectedIds: ['id-7', 'id-4'] }));
  assert.equal(changed.length, 2);
  assert.ok(changed[0].includes('id=id-7'), changed[0]);
  assert.ok(changed[1].includes('id=id-4'), changed[1]);
});

// ── 短 id：提示词只印 md5 唯一前缀，发送时按前缀解析 ────────────────────
const fullId = (md5) => `00000000_0_0_0_${md5}_0_0`;
const md5Entries = [
  { id: fullId('6E962E399C06B421FEE8B28FF23E3471'), md5: '6E962E399C06B421FEE8B28FF23E3471', localNote: '吃瓜', useCount: 2 },
  { id: fullId('8B5CCD1C869B0CFDE741070C117A2D94'), md5: '8B5CCD1C869B0CFDE741070C117A2D94', localNote: '得意', useCount: 1 }
];

check('14. 有 md5 时提示词只印 8 位短 id，不出现 51 位完整 id', () => {
  const lines = linesOf(buildStickerContext(md5Entries, 10));
  assert.ok(lines[0].includes('id=6e962e39'), lines[0]);
  assert.ok(lines[1].includes('id=8b5ccd1c'), lines[1]);
  assert.ok(lines.every((line) => !line.includes(fullId('6E962E399C06B421FEE8B28FF23E3471'))), '不应出现完整 id');
  assert.ok(lines.every((line) => !line.includes(fullId('8B5CCD1C869B0CFDE741070C117A2D94'))), '不应出现完整 id');
});

check('15. 前 8 位撞车时自动加长到唯一前缀；歧义前缀解析返回 null', () => {
  const c1 = `ABCDEF12A${'0'.repeat(23)}`;
  const c2 = `ABCDEF12B${'0'.repeat(23)}`;
  const collision = [
    { id: fullId(c1), md5: c1, localNote: '甲', useCount: 2 },
    { id: fullId(c2), md5: c2, localNote: '乙', useCount: 1 }
  ];
  const lines = linesOf(buildStickerContext(collision, 10));
  assert.ok(lines[0].includes('id=abcdef12a'), lines[0]);
  assert.ok(lines[1].includes('id=abcdef12b'), lines[1]);
  assert.equal(findSticker(collision, 'abcdef12'), null, '8 位有歧义时不能猜');
  assert.equal(findSticker(collision, 'ABCDEF12A'), collision[0], '加长后的前缀应命中');
});

check('16. md5 缺失时回退完整 id，旧条目行为不变', () => {
  const lines = linesOf(buildStickerContext([{ id: 'legacy_long_id', desc: '旧条目' }], 10));
  assert.ok(lines[0].includes('id=legacy_long_id'), lines[0]);
});

check('17. findSticker 支持短 id 前缀（不区分大小写），完整 id 仍精确命中', () => {
  assert.equal(findSticker(md5Entries, '6e962e39'), md5Entries[0]);
  assert.equal(findSticker(md5Entries, '6E962E39'), md5Entries[0]);
  assert.equal(findSticker(md5Entries, fullId('6E962E399C06B421FEE8B28FF23E3471')), md5Entries[0]);
  assert.equal(findSticker(md5Entries, 'ffffffff'), null);
});

check('18. md5 完全重复时两条都回退完整 id，避免短 id 串台', () => {
  const same = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
  const dup = [
    { id: 'dup_1', md5: same, localNote: '甲' },
    { id: 'dup_2', md5: same, localNote: '乙' }
  ];
  const lines = linesOf(buildStickerContext(dup, 10));
  assert.ok(lines[0].includes('id=dup_1'), lines[0]);
  assert.ok(lines[1].includes('id=dup_2'), lines[1]);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
