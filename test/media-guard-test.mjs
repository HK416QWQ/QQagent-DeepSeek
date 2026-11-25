// 阶段 A：media-guard 纯函数测试（400 索引解析、错误分类、部件替换、全部摘除）。
import assert from 'node:assert';
import {
  MEDIA_REPAIR_MAX,
  classifyMediaError,
  parseRejectedContentIndex,
  replaceMediaPartWithPlaceholder,
  replaceAllMediaWithPlaceholders
} from '../src/media-guard.js';

let passed = 0;
function ok(name) { passed += 1; console.log(`  ✓ ${name}`); }

// 1. parseRejectedContentIndex
assert.deepEqual(
  parseRejectedContentIndex('.messages[6].content[1]: You have uploaded an unsupported image'),
  { messageIndex: 6, contentIndex: 1 }
);
assert.deepEqual(parseRejectedContentIndex('messages[4].content[2]'), { messageIndex: 4, contentIndex: 2 });
assert.equal(parseRejectedContentIndex('no index here'), null);
ok('parseRejectedContentIndex：有索引/无索引');

const msgsWithImage = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
];
const msgsNoImage = [{ role: 'user', content: 'pure text' }];

// 2. classifyMediaError
const v400 = classifyMediaError(
  { httpStatus: 400, message: '模型 API HTTP 400：.messages[6].content[1]: You have uploaded an unsupported image' },
  msgsWithImage
);
assert.ok(v400 && v400.hit, '400 + unsupported image 应有 hit');
assert.deepEqual(v400.hit, { messageIndex: 6, contentIndex: 1 });
assert.equal(v400.dropAll, false);

// 长响应：索引在 600 字符之后，message 被截断到 500（仍含图片关键词、但索引丢失），bodyExcerpt 4000 仍能解析
const longText = `unsupported image ${'x'.repeat(600)} .messages[6].content[1]`;
const vLong = classifyMediaError(
  { httpStatus: 400, message: longText.slice(0, 500), bodyExcerpt: longText },
  msgsWithImage
);
assert.deepEqual(vLong.hit, { messageIndex: 6, contentIndex: 1 }, 'bodyExcerpt 应被优先读取');

// 只给 message（截断）时不得抛错，允许降级为无 hit 的可修复
const vTruncated = classifyMediaError({ httpStatus: 400, message: longText.slice(0, 500) }, msgsWithImage);
assert.ok(vTruncated && vTruncated.hit === null, '截断 message 应降级为无 hit 但不抛错');

assert.equal(classifyMediaError({ httpStatus: 400, message: '模型 API HTTP 400：invalid API key' }, msgsWithImage), null);
assert.equal(classifyMediaError({ httpStatus: 500, message: 'unsupported image' }, msgsWithImage), null);

const vDropAll = classifyMediaError({ httpStatus: 400, message: 'image input is not supported for this model' }, msgsWithImage);
assert.equal(vDropAll.dropAll, true, '模型级拒绝应 dropAll');
assert.equal(vDropAll.hit, null, 'dropAll 不应被通用 image...not supported 抢成 hit');

assert.equal(classifyMediaError({ httpStatus: 413, message: 'payload too large' }, msgsNoImage), null);
assert.ok(classifyMediaError({ httpStatus: 413, message: 'payload too large' }, msgsWithImage), '413 + 有图片应可修复');
ok('classifyMediaError：400/413/422、长响应、普通 400、dropAll');

// 3. replaceMediaPartWithPlaceholder
{
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'x' } }] }];
  const r = replaceMediaPartWithPlaceholder(messages, { messageIndex: 0, contentIndex: 1 }, 'reason');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { messageIndex: 0, contentIndex: 1, kind: 'image' });
  assert.equal(messages[0].content.length, 2, '替换不改变数组长度');
  assert.equal(messages[0].content[1].type, 'text', '被点名部件替换为 text');
  assert.ok(messages[0].content[0].text.includes('本消息中的图片被上游拒绝'), '第一个 text 追加说明');
  assert.ok(!messages[0].content[0].text.includes('第 2 张'), '不得写“第 2 张”');
}
assert.deepEqual(replaceMediaPartWithPlaceholder([{ role: 'user', content: [] }], { messageIndex: 0, contentIndex: 5 }, 'r'), [], '非法索引返回 []');
assert.deepEqual(replaceMediaPartWithPlaceholder([{ role: 'user', content: [{ type: 'text', text: 'a' }] }], { messageIndex: 0, contentIndex: 0 }, 'r'), [], '非媒体部件返回 []');
ok('replaceMediaPartWithPlaceholder：替换/追加/非法索引');

// 4. replaceAllMediaWithPlaceholders
{
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: '1' } }, { type: 'video_url', video_url: { url: '2' } }] },
    { role: 'tool', content: 'tool result' }
  ];
  const r = replaceAllMediaWithPlaceholders(messages, 'reason');
  assert.equal(r.length, 2, 'image_url + video_url 都被替换');
  assert.deepEqual(r.map((x) => x.kind).sort(), ['image', 'video']);
  assert.equal(messages[0].content, 'sys', 'system 不改');
  assert.equal(messages[2].content, 'tool result', 'tool 不改');
  assert.equal(messages[1].content.filter((p) => p.type === 'text').length, 3, 'text + 两个占位');
  assert.ok(messages[1].content[0].text.includes('本消息中的图片被上游拒绝'));
}
ok('replaceAllMediaWithPlaceholders：image/video、system/tool 不动');

assert.equal(MEDIA_REPAIR_MAX, 2);
ok('MEDIA_REPAIR_MAX = 2');

console.log(`\nmedia-guard-test：${passed} 组通过 ✅`);
process.exit(0);
