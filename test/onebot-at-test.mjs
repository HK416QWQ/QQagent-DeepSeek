// 发送层 at 段构造单测（P0-02）。
//
// 不连网络：直接把 OneBotClient.call 换成记录器，只验证段数组长什么样。
// 覆盖：
//   · 多人 at 的顺序、at 在文本段之前、正文里不出现 [CQ:at
//   · 旧单 at 参数 atUserId 继续可用
//   · 新 atUserIds 与旧 atUserId 同时存在时合并去重
//   · all / 0 / 前导零 / 小数 / 负数 / 非数字 一律拒绝（QQ 号没有 0，前导零、1.5、-1 只可能是拼错的字符串）
//   · 复制调用方数组，不就地修改
import assert from 'node:assert/strict';
import { createChecker } from './_harness.mjs';
import { OneBotClient } from '../src/onebot.js';

const checker = createChecker('onebot at 段');
const client = new OneBotClient({ httpUrl: 'http://127.0.0.1:1' });
let captured = null;
// 替换掉 HTTP 调用：拿到 (action, params) 就返回一个假的 message_id
client.call = async (action, params) => {
  captured = { action, params };
  return { message_id: 1 };
};

const segs = () => captured?.params?.message ?? [];
const atQqs = () => segs().filter((s) => s.type === 'at').map((s) => s.data.qq);
const textOf = () => segs().filter((s) => s.type === 'text').map((s) => s.data.text).join('');

await checker.check('多人 at：顺序正确、at 在文本段之前、正文不含 CQ 码', async () => {
  await client.sendText('group', 456, '欢迎新成员加入本群，有问题随时问～', { atUserIds: ['111', '222'] });
  assert.equal(captured.action, 'send_group_msg');
  assert.equal(captured.params.group_id, 456);
  assert.deepEqual(segs().slice(0, 2), [
    { type: 'at', data: { qq: '111' } },
    { type: 'at', data: { qq: '222' } }
  ]);
  assert.equal(segs()[2].type, 'text', 'at 段必须在文本段之前');
  assert.match(segs()[2].data.text, /欢迎新成员/);
  assert.ok(!textOf().includes('[CQ:at'), '正文里不得出现 [CQ:at，否则会被 escapeCqText 转成普通文字');
});

await checker.check('旧单 at 参数 atUserId 继续可用', async () => {
  await client.sendText('group', 456, '旧参数', { atUserId: '333' });
  assert.deepEqual(segs()[0], { type: 'at', data: { qq: '333' } });
  assert.equal(segs()[1].type, 'text');
});

await checker.check('新旧参数同时存在：合并去重，保持出现顺序', async () => {
  await client.sendText('group', 456, '合并去重', { atUserId: '111', atUserIds: ['111', '222', '222'] });
  assert.deepEqual(atQqs(), ['111', '222']);
});

await checker.check('复制调用方数组：不就地修改', async () => {
  const arr = ['111', '111', '222'];
  await client.sendText('group', 456, '不改入参', { atUserIds: arr });
  assert.deepEqual(arr, ['111', '111', '222'], '调用方数组必须保持原样');
  assert.deepEqual(atQqs(), ['111', '222'], '发送侧仍要去重');
});

await checker.check('非法 at 目标：all / 0 / 前导零 / 小数 / 负数 / 非数字 全部拒绝', async () => {
  // '1.5' / '-1' / '1e3' 都是"看起来像数字"的写法；旧正则 ^\d+$ 本来就会拒绝它们，
  // 这里钉的是 Number()/parseFloat 回退；0 / 0123 才用于钉住旧正则回退。
  for (const bad of ['all', '0', '0123', '1e3', 'abc', '1.5', '-1', '']) {
    if (bad === '') {
      // 空串是"没传"，按跳过处理，不抛错
      await client.sendText('group', 456, '空串不算 at', { atUserIds: [''] });
      assert.deepEqual(atQqs(), []);
      continue;
    }
    await assert.rejects(
      () => client.sendText('group', 456, 'x', { atUserIds: [bad] }),
      /正整数 QQ 号|不能为 all/,
      `atUserIds=${JSON.stringify(bad)} 应被拒绝`
    );
  }
  // 数组里混一个非法值，整条都失败（不做"丢掉坏的继续发"）
  await assert.rejects(
    () => client.sendText('group', 456, 'x', { atUserIds: ['111', 'all'] }),
    /正整数 QQ 号|不能为 all/
  );
});

await checker.check('replyToMessageId 仍然生效（防回归）', async () => {
  await client.sendText('group', 456, '引用', { replyToMessageId: 9001, atUserIds: ['111'] });
  assert.deepEqual(segs(), [
    { type: 'reply', data: { id: '9001' } },
    { type: 'at', data: { qq: '111' } },
    { type: 'text', data: { text: '引用' } }
  ]);
  await assert.rejects(() => client.sendText('group', 456, 'x', { replyToMessageId: '0' }), /非零整数/);
});

checker.finish();
