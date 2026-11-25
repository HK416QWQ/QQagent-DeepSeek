// L1 收敛 · profile.js 纯函数测试。
// 覆盖 §4.6 的 15 条验收用例。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-mem2-profile-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const P = await import('../src/mem2/paths.js');
const M = await import('../src/mem2/store.js');
const PR = await import('../src/mem2/profile.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

let caseNo = 0;
function freshRoot() {
  caseNo += 1;
  P.setMem2Root(path.join(DATA, `case-${caseNo}`));
  return P.mem2Dir();
}

const UID = '9900000001';
const K = 'group:999900001';
const T0 = new Date(2026, 10, 14, 10, 0, 0).getTime();
const DAY = 86400000;

function mkEntry(i, { content = `印象${i}`, groups = ['说话风格'], pinned = false, status = 'active', createdAt = T0 + i * 1000, updatedAt = T0 + i * 1000 } = {}) {
  return M.makeL1Entry({
    entryId: `l1_${UID}_${i}`,
    chatKey: K, userId: UID,
    sourceBatch: { chatKey: K, userId: UID, startTs: T0, endTs: T0 + DAY, msgCount: 10 },
    content, groups, status, pinnedByUser: pinned, createdAt, updatedAt
  });
}

// ── #1 正常 8 行 → 2/2/2/2，sourceEntryIds 映射正确 ──
{
  const entries = Array.from({ length: 8 }, (_, i) => mkEntry(i + 1));
  const output = [
    '说话风格｜1,2｜他说话喜欢用短句，经常分条发送，语气词很多，情绪外露明显',
    '说话风格｜3,4｜他爱玩梗和复制粘贴，表情符号用得多，偶尔刷屏连发',
    '关系态度｜5,6｜对熟人称呼随意玩笑尺度大，主动搭话追问，热心帮忙',
    '关系态度｜7,8｜对圈外人评价姿态高，贬词习惯明显，有刻板印象',
    '性格特质｜1,3｜嘴硬但情绪恢复快，自嘲方式多，被怼时会反击',
    '性格特质｜2,4｜底线明确反感项多，自我约束有分寸，最在意面子',
    '兴趣身份｜5,7｜长期投入某款手游，熟悉黑话渊源，替其说话抱维护立场',
    '兴趣身份｜6,8｜有创作产出身份，偏好某类同人，公开发布存档，涉猎广'
  ].join('\n');
  const { slots, stats } = PR.parseProfileOutput(output, entries);
  assert.equal(slots.length, 8, '#1 应产出 8 条');
  assert.deepEqual(slots.map((s) => s.dim), ['说话风格', '说话风格', '关系态度', '关系态度', '性格特质', '性格特质', '兴趣身份', '兴趣身份']);
  assert.deepEqual(slots[0].sourceEntryIds, ['l1_9900000001_1', 'l1_9900000001_2']);
  assert.equal(stats.badDim, 0);
  assert.equal(stats.overflow, 0);
  ok('#1 正常 8 行 → 2/2/2/2，sourceEntryIds 映射正确');
}

// ── #2 某维度 3 行 → 留前 2，overflow=1 ──
{
  const entries = Array.from({ length: 6 }, (_, i) => mkEntry(i + 1));
  const output = [
    '说话风格｜1｜第一条风格内容够长够长够长够长够长够长够长够长',
    '说话风格｜2｜第二条风格内容够长够长够长够长够长够长够长够长',
    '说话风格｜3｜第三条风格内容够长够长够长够长够长够长够长够长',
    '关系态度｜4｜关系态度内容够长够长够长够长够长够长够长够长够长'
  ].join('\n');
  const { slots, stats } = PR.parseProfileOutput(output, entries);
  assert.equal(slots.filter((s) => s.dim === '说话风格').length, 2, '#2 风格只留 2 条');
  assert.equal(stats.overflow, 1, '#2 overflow=1');
  ok('#2 某维度 3 行 → 留前 2，overflow=1');
}

// ── #3 某维度 0 行 → 不借名额 ──
{
  const entries = Array.from({ length: 4 }, (_, i) => mkEntry(i + 1));
  const output = [
    '说话风格｜1｜风格内容够长够长够长够长够长够长够长够长够长够长',
    '说话风格｜2｜风格内容二够长够长够长够长够长够长够长够长够长够长',
    '关系态度｜3｜关系内容够长够长够长够长够长够长够长够长够长够长'
  ].join('\n');
  const { slots } = PR.parseProfileOutput(output, entries);
  assert.equal(slots.filter((s) => s.dim === '性格特质').length, 0, '#3 性格特质 0 条');
  assert.equal(slots.filter((s) => s.dim === '兴趣身份').length, 0, '#3 兴趣身份 0 条');
  assert.equal(slots.length, 3, '#3 总共 3 条，不补');
  ok('#3 某维度 0 行 → 不借名额');
}

// ── #4 未知维度/越界序号 → 丢行/丢序号并计数 ──
{
  const entries = Array.from({ length: 3 }, (_, i) => mkEntry(i + 1));
  const output = [
    '未知维度｜1｜这条应该被丢弃因为维度不对啊啊啊啊啊啊啊啊',
    '说话风格｜99｜序号越界但正文保留因为至少有一个有效来源才行',
    '说话风格｜1,99｜混合序号只保留有效的那个啊啊啊啊啊啊啊啊啊啊'
  ].join('\n');
  const { slots, stats } = PR.parseProfileOutput(output, entries);
  assert.equal(stats.badDim, 1, '#4 未知维度计 badDim');
  assert.equal(stats.badRefs, 2, '#4 越界序号计 badRefs（99 出现两次）');
  assert.equal(stats.noRef, 1, '#4 全越界整行丢弃计 noRef');
  assert.equal(slots.length, 1, '#4 只留最后一条（有有效序号 1）');
  ok('#4 未知维度/越界序号 → 丢行/丢序号并计数');
}

// ── #5 重复正文 → 只留一条 ──
{
  const entries = Array.from({ length: 4 }, (_, i) => mkEntry(i + 1));
  const dup = '完全相同的正文内容够长够长够长够长够长够长够长够长';
  const output = [
    `说话风格｜1｜${dup}`,
    `说话风格｜2｜${dup}`,
    '关系态度｜3｜不同的正文内容够长够长够长够长够长够长够长够长够长'
  ].join('\n');
  const { slots, stats } = PR.parseProfileOutput(output, entries);
  assert.equal(stats.duplicates, 1, '#5 重复计 duplicates');
  assert.equal(slots.length, 2, '#5 只留 2 条');
  ok('#5 重复正文 → 只留一条');
}

// ── #6 字数：目标带 27–50；<27 或 >50 计 violation；>60 截到 60 ──
{
  const entries = Array.from({ length: 5 }, (_, i) => mkEntry(i + 1));
  const c24 = '一'.repeat(24);
  const c38 = '一'.repeat(38);
  const c54 = '一'.repeat(54);
  const c58 = '一'.repeat(58);
  const c80 = '一'.repeat(80);
  const output = [
    `说话风格｜1｜${c24}`,
    `说话风格｜2｜${c38}`,
    `关系态度｜3｜${c54}`,
    `关系态度｜4｜${c58}`,
    `性格特质｜5｜${c80}`
  ].join('\n');
  const { slots, stats } = PR.parseProfileOutput(output, entries);
  // 24(<27) + 54(>50) + 58(>50) + 80(>50 与 >60 各计一次) = 5
  assert.equal(stats.lengthViolations, 5, '#6 24(<27)/54(>50)/58(>50)/80(>50 且 >60) 共 5 次');
  assert.equal(stats.truncated, 1, '#6 80 字截断计 truncated');
  assert.equal(slots[4].chars, 60, '#6 截断后 60 字（59+…）');
  // 口径必须与模板一致：PROFILE_CHARS_MIN / MAX 就是模板里写的 27–50
  assert.equal(PR.PROFILE_CHARS_MIN, 27, '#6 模板下限 27 与解析器同源');
  assert.equal(PR.PROFILE_CHARS_MAX, 50, '#6 模板上限 50 与解析器同源');
  assert.ok(PR.PROFILE_PROMPT.includes('27–50'), '#6 模板正文写的也是 27–50（三套口径收敛成一套）');
  ok('#6 字数：目标带 27–50（模板/解析器同源）；<27 或 >50 计 violation；>60 截到 60');
}

// ── #7 digest：内容不变 clean；改 content dirty；改 pinned content dirty；钉住/取消 dirty；只 bump updatedAt clean ──
{
  freshRoot();
  const e1 = mkEntry(1, { content: '原始内容' });
  const e2 = mkEntry(2, { content: '第二条', pinned: true });
  M.appendPerson(e1);
  M.appendPerson(e2);

  const active1 = M.activePerson(UID);
  const d1 = PR.computeDigest(active1);

  // 只 bump updatedAt（内容不变）→ 仍 clean
  M.setPersonStatus(UID, e1.entryId, 'active', { nowTs: T0 + 99999 });
  const active2 = M.activePerson(UID);
  const d2 = PR.computeDigest(active2);
  assert.equal(d1, d2, '#7 只 bump updatedAt → digest 不变（clean）');

  // 改 content → dirty
  const e1b = M.makeL1Entry({ ...e1, content: '改了内容', updatedAt: T0 + 100000 });
  M.appendPerson(e1b);
  const d3 = PR.computeDigest(M.activePerson(UID));
  assert.notEqual(d1, d3, '#7 改 content → dirty');

  // 钉住/取消 → dirty
  const e2b = M.makeL1Entry({ ...e2, pinnedByUser: false, updatedAt: T0 + 100001 });
  M.appendPerson(e2b);
  const d4 = PR.computeDigest(M.activePerson(UID));
  assert.notEqual(d3, d4, '#7 取消钉住 → dirty');

  ok('#7 digest：updatedAt 不影响；content/pinned 变化 → dirty');
}

// ── #8 pinned 进入输入（只读块）、不作为来源序号；conflicted 不进入 ──
{
  const entries = [
    mkEntry(1, { content: '普通条目' }),
    mkEntry(2, { content: '钉住条目', pinned: true }),
    mkEntry(3, { content: '冲突条目', status: 'conflicted' })
  ];
  const { text, inputEntries } = PR.buildProfileInput(entries);
  assert.ok(text.includes('【钉住条目（只读，不得作为来源）】'), '#8 pinned 只读块存在');
  assert.ok(text.includes('钉住条目'), '#8 pinned 内容在输入里');
  assert.ok(!text.includes('冲突条目'), '#8 conflicted 不进入输入');
  assert.equal(inputEntries.length, 1, '#8 只有非 pinned 的 active 进序号列表');
  assert.equal(inputEntries[0].entryId, 'l1_9900000001_1');
  ok('#8 pinned 进入输入只读块、不作为来源；conflicted 不进入');
}

// ── #9 active 为空 → 写空 profile、0 次调用 ──
{
  freshRoot();
  const empty = PR.emptyProfile(UID);
  assert.equal(empty.slots.length, 0, '#9 空画像 slots=[]');
  assert.equal(empty.stats.calls, 0, '#9 0 次调用');
  assert.equal(empty.stats.active, 0);
  PR.writeProfile(UID, empty);
  const read = PR.readProfile(UID);
  assert.deepEqual(read.slots, [], '#9 读写对称');
  ok('#9 active 为空 → 写空 profile、0 次调用');
}

// ── #10 配额不足 → 旧 profile 不变（由调用方控制，这里只验 readProfile 容错）──
{
  freshRoot();
  assert.equal(PR.readProfile('nonexist'), null, '#10 无文件返回 null');
  fs.mkdirSync(path.dirname(P.profileFile('bad')), { recursive: true });
  fs.writeFileSync(P.profileFile('bad'), '{ broken', 'utf8');
  assert.equal(PR.readProfile('bad'), null, '#10 坏文件返回 null');
  ok('#10 配额不足/坏文件 → readProfile 返回 null，不抛');
}

// ── #11 同一人一轮只调用 1 次（由 sweepPeople 控制，这里验 profileToExisting 结构）──
{
  const entries = [mkEntry(1), mkEntry(2, { pinned: true })];
  const profile = { slots: [{ dim: '说话风格', content: '槽位内容', sourceEntryIds: ['l1_9900000001_1'], chars: 4 }] };
  const existing = PR.profileToExisting(profile, entries);
  assert.equal(existing.length, 2, '#11 1 槽 + 1 pinned = 2 项');
  assert.equal(existing[0].index, 1);
  assert.equal(existing[0].readOnly, false);
  assert.equal(existing[1].index, 2);
  assert.equal(existing[1].readOnly, true, '#11 pinned 标 readOnly');
  ok('#11 profileToExisting：槽位 1..M + pinned M+1..N（readOnly）');
}

// ── #12 来源全无效的行 → 整行丢弃、noRef=1 ──
{
  const entries = [mkEntry(1)];
  const output = '说话风格｜99,100｜这条所有序号都越界应该被整行丢弃啊啊啊啊';
  const { slots, stats } = PR.parseProfileOutput(output, entries);
  assert.equal(slots.length, 0, '#12 无有效来源 → 0 槽');
  assert.equal(stats.noRef, 1, '#12 noRef=1');
  ok('#12 来源全无效 → 整行丢弃、noRef=1，不产生空 sourceEntryIds 槽');
}

// ── #13 输入 210 条 → 只用 200 条 ──
{
  const entries = Array.from({ length: 210 }, (_, i) => mkEntry(i + 1));
  const { inputTotal, inputUsed, truncated } = PR.buildProfileInput(entries);
  assert.equal(inputTotal, 210, '#13 inputTotal=210');
  assert.equal(inputUsed, 200, '#13 inputUsed=200');
  assert.equal(truncated, true, '#13 truncated=true');
  ok('#13 输入 210 条 → 只用 200 条，inputTotal/inputUsed 正确');
}

// ── #14 队列：无 profile 排最前；非 QQ 文件不排队；active=0 排最后 ──
{
  freshRoot();
  // 15 个真人（纯数字 uid），其中 3 人有 profile（builtAt 不同），12 人无
  for (let i = 1; i <= 15; i++) {
    const uid = String(100000000 + i);
    const e = M.makeL1Entry({
      entryId: `l1_${uid}_1`, chatKey: K, userId: uid,
      sourceBatch: { chatKey: K, userId: uid, startTs: T0, endTs: T0 + DAY, msgCount: 10 },
      content: `印象${i}`, groups: ['说话风格']
    });
    M.appendPerson(e);
    if (i <= 3) {
      PR.writeProfile(uid, { v: 1, uid, builtAt: T0 + i * DAY, sourceDigest: PR.computeDigest([e]), slots: [], stats: {} });
    }
  }
  // 测试残留：非 QQ 号的 people 文件（u1.jsonl 就是这样混进真实目录的）
  const odd = M.makeL1Entry({
    entryId: 'l1_u1_1', chatKey: K, userId: 'u1',
    sourceBatch: { chatKey: K, userId: 'u1', startTs: T0, endTs: T0 + DAY, msgCount: 10 },
    content: '印象条目N 很长很长', groups: ['性格特质']
  });
  M.appendPerson(odd);
  // active=0 的真人（只有一条 superseded）：要清空画像，但不该占前排名额
  const emptyUid = '100000099';
  M.appendPerson(M.makeL1Entry({
    entryId: `l1_${emptyUid}_1`, chatKey: K, userId: emptyUid,
    sourceBatch: { chatKey: K, userId: emptyUid, startTs: T0, endTs: T0 + DAY, msgCount: 10 },
    content: '已被覆盖', groups: ['性格特质'], status: 'superseded'
  }));

  const queue = PR.buildProfileQueue();
  // 无 profile 的 12 人脏（builtAt=0）；有 profile 的 3 人 digest 匹配**但 slots 空** →
  // 缺维读时现算 = 脏（旧语义只看 stats.missingDims，这 3 人会被永久跳过）；active=0 的 1 人脏
  assert.equal(queue.length, 16, '#14 12 个无画像 + 3 个 digest 匹配但无槽 + 1 个 active=0');
  assert.equal(queue.filter((q) => q.reason === 'missing-dims').length, 3,
    '★ digest 匹配但该维有材料却没槽 → 判 missing-dims（不依赖 stats 字段）');
  assert.ok(!queue.some((q) => q.uid === 'u1'), '★ 非 QQ 号不排队（否则会给测试残留建画像、把覆盖指标做假）');
  assert.equal(queue.skippedNonQq, 1, '★ 跳过的非 QQ 文件要计数');
  assert.equal(queue[queue.length - 1].uid, emptyUid, '★ active=0 排最后（只写空画像，不占前 12 个名额）');
  assert.equal(queue.slice(0, PR.PROFILE_MAX_PER_TICK).length, 12, '#14 每轮最多 12 人');
  assert.ok(queue.slice(0, 12).every((q) => q.activeCount > 0), '★ 前 12 个名额全是真要压缩的人');

  // 覆盖口径：只数 QQ 号；u1 不算人数，但要点出来
  const cov = PR.profileCoverage();
  assert.equal(cov.total, 16, '15 个真人 + active=0 的 1 人（不含 u1）');
  assert.equal(cov.withProfile, 3, '3 份画像');
  assert.equal(cov.withActive, 15, '15 人有 active');
  assert.equal(cov.skippedNonQq, 1, '★ 非 QQ 文件单独计数');

  assert.equal(PR.isQqUid('9900000001'), true);
  assert.equal(PR.isQqUid('u1'), false);
  assert.equal(PR.isQqUid('group:1'), false);
  ok('#14 队列：无画像排最前、非 QQ 不排队、active=0 排最后；覆盖只数 QQ 号并单独计数');
}

// ── #15 解析统计：badDim 不混入 overflow ──
{
  const entries = [mkEntry(1)];
  const output = [
    '坏维度｜1｜这条维度不对应该计 badDim 啊啊啊啊啊啊啊啊啊啊',
    '另一个坏维度｜1｜这条也计 badDim 啊啊啊啊啊啊啊啊啊啊啊啊',
    '说话风格｜1｜正常条够长够长够长够长够长够长够长够长够长够长',
    '说话风格｜1｜第二条够长够长够长够长够长够长够长够长够长够长',
    '说话风格｜1｜第三条溢出够长够长够长够长够长够长够长够长够长'
  ].join('\n');
  const { stats } = PR.parseProfileOutput(output, entries);
  assert.equal(stats.badDim, 2, '#15 badDim=2');
  assert.equal(stats.overflow, 1, '#15 overflow=1（第三条风格）');
  assert.notEqual(stats.badDim, stats.overflow, '#15 两者分开计');
  ok('#15 解析统计：badDim 与 overflow 分开计数');
}

// ── 兜底确定性：同一输入两次输出逐字节相同 ──
{
  const entries = [
    mkEntry(1, { groups: ['说话风格'], createdAt: T0, updatedAt: T0 }),
    mkEntry(2, { groups: ['说话风格'], createdAt: T0 + 1000, updatedAt: T0 + 1000 }),
    mkEntry(3, { groups: ['兴趣身份'], createdAt: T0, updatedAt: T0 + 5000 }),
    mkEntry(4, { groups: ['兴趣身份'], createdAt: T0, updatedAt: T0 + 3000 }),
    mkEntry(5, { groups: ['关系态度'], createdAt: T0, updatedAt: T0 }),
    mkEntry(6, { groups: ['性格特质'], createdAt: T0, updatedAt: T0 })
  ];
  const r1 = PR.fallbackItems(entries);
  const r2 = PR.fallbackItems(entries);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), '兜底两次输出逐字节相同');
  // 兴趣按 updatedAt 降序：entry3(5000) 在 entry4(3000) 前
  const interest = r1.filter((s) => s.dim === '兴趣身份');
  assert.equal(interest[0].sourceEntryIds[0], 'l1_9900000001_3', '兴趣 updatedAt 降序');
  ok('兜底确定性：同一输入两次输出逐字节相同；兴趣按 updatedAt 降序');
}

// ── #17 fillMissingDims：只补「有材料但没槽」的维；确定性；题材词照补（只统计、不拦截） ──
{
  const entries = [
    mkEntry(1, { groups: ['说话风格'], content: '说话短', updatedAt: T0 + 10 }),
    mkEntry(2, { groups: ['兴趣身份'], content: '长期玩某款手游，熟悉版本黑话', updatedAt: T0 + 9 }),
    mkEntry(3, { groups: ['兴趣身份'], content: `${'很长的兴趣描述'.repeat(8)}`, updatedAt: T0 + 8 }),
    mkEntry(4, { groups: ['性格特质'], content: '反感凌辱恶堕类的题材', updatedAt: T0 + 7 })
  ];
  const slots = [{ dim: '说话风格', content: '说话短促爱抢话', sourceEntryIds: ['x'], chars: 8 }];
  const a = PR.fillMissingDims(slots, entries);
  const b = PR.fillMissingDims(slots, entries);
  assert.equal(JSON.stringify(a), JSON.stringify(b), '#17 同一输入两次补位逐字节相同');
  assert.deepEqual(a.filledDims.sort(), ['性格特质', '兴趣身份'].sort(), '#17 题材词也照补（只统计、不拦截）');
  const int = a.slots.filter((s) => s.dim === '兴趣身份');
  assert.equal(int.length, 2);
  assert.deepEqual(int.map((s) => s.sourceEntryIds[0]), ['l1_9900000001_2', 'l1_9900000001_3'], '#17 updatedAt 降序');
  assert.ok(int.every((s) => s.chars <= 50 && s.filled === true), '#17 内容裁到 50 字并标 filled');
  assert.ok(int[1].content.endsWith('…'), '#17 超长补位可见截断');
  const trait = a.slots.filter((s) => s.dim === '性格特质');
  assert.equal(trait.length, 1, '#17 命中题材词的条目照样补进画像');
  assert.equal(trait[0].content, '反感凌辱恶堕类的题材', '#17 内容原样，不脱敏、不丢弃');
  assert.deepEqual(PR.missingDimsOf(a.slots, entries), [], '#17 补完不再缺维');
  ok('#17 空维补位：只补有材料的维、确定性、题材词照补、超长裁 50');
}

// ── #18 scanSensitive：只统计用的确定性子串扫描（拦截函数已删除） ──
{
  // 归一化：空白/零宽/间隔号不影响命中
  assert.deepEqual(PR.scanSensitive('凌 辱'), ['凌辱'], '#18 归一化：空格拆分也命中');
  assert.deepEqual(PR.scanSensitive('恶\u200b堕'), ['恶堕'], '#18 归一化：零宽字符也命中');
  assert.deepEqual(PR.scanSensitive('聊到强 奸'), ['强奸'], '#18 归一化 + 新增词表');
  assert.deepEqual(PR.scanSensitive('普普通通的一句话'), [], '#18 干净文本零命中');
  assert.deepEqual(PR.scanSensitive('爱聊同人本子，对纯爱向有明确偏好'), [], '#18 本子 不是敏感词');
  // 拦截路径已全部删除：只保留计数
  assert.equal(typeof PR.maskSensitive, 'undefined', '#18 maskSensitive 已删除（不再脱敏）');
  assert.equal(typeof PR.fillDroppedDims, 'undefined', '#18 fillDroppedDims 已删除（不再丢槽补位）');
  assert.equal(typeof PR.sanitizeSlots, 'undefined', '#18 sanitizeSlots 已删除（读侧不设准入门）');
  assert.equal(typeof PR.inferDroppedDims, 'undefined', '#18 inferDroppedDims 已删除');
  // 只删整条/删除子句的旧常量也一并消失
  assert.equal(PR.PROFILE_MASK_TEXT, undefined, '#18 占位词常量已删除');
  assert.equal(PR.PROFILE_DROPPED_FILL, undefined, '#18 丢槽补位上限已删除');
  ok('#18 scanSensitive 只做计数；脱敏/丢槽/准入三类拦截函数已移除');
}

// ── #19 repairProfileSlots：零调用补空维，不删任何槽（含题材词） ──
{
  freshRoot();
  const rows = [
    [1, '性格特质', '嘴硬但情绪恢复快，自嘲方式多', 9],
    [2, '性格特质', '对同人内容有明确底线，反感极端题材', 8],
    [3, '性格特质', '反感凌辱类题材', 10],
    [4, '兴趣身份', '长期投入某款手游，熟悉版本黑话', 7]
  ];
  for (const [i, g, c, u] of rows) {
    M.appendPerson(mkEntry(i, { groups: [g], content: c, updatedAt: T0 + u }));
  }
  const active = M.activePerson(UID);
  PR.writeProfile(UID, {
    v: 1, uid: UID, builtAt: T0, model: 'test',
    sourceDigest: PR.computeDigest(active),
    slots: [
      { dim: '性格特质', content: '嘴硬但情绪恢复快，自嘲方式多', sourceEntryIds: ['l1_9900000001_1'], chars: 12 },
      { dim: '性格特质', content: '对凌辱类题材有明确底线', sourceEntryIds: ['l1_9900000001_3'], chars: 10 },
      { dim: '兴趣身份', content: '长期投入某款手游，熟悉版本黑话', sourceEntryIds: ['l1_9900000001_4'], chars: 15 }
    ],
    stats: { missingDims: [], sensitiveHits: 0, retry: 1 }
  });
  const before = PR.readProfile(UID);
  const r = PR.repairProfileSlots(UID, { activeEntries: active, now: T0 + 100 });
  assert.equal(r.ok, true);
  assert.equal(r.filledDims.length, 0, '#19 没有空维 → 不补（有槽的维不因命中题材词被丢）');
  assert.equal(r.sensitiveHits, 1, '#19 题材词命中只计数');
  const after = PR.readProfile(UID);
  assert.equal(after.sourceDigest, before.sourceDigest, '★ 修复不改 digest（active 没变，不许伪装成新事实）');
  assert.equal(after.builtAt, before.builtAt, '#19 不伪造重建时间');
  assert.equal(after.slots.length, 3, '#19 槽一条不少');
  assert.equal(after.slots[1].content, '对凌辱类题材有明确底线', '#19 命中槽原样保留（只统计、不拦截）');
  assert.equal(after.stats.sensitiveHits, 1, '#19 命中数落 stats 供审计');
  assert.equal(after.stats.retry, 1, '#19 repair 不再改 retry');

  // 缺维场景：只补「整维为空」的维，不把 1 条的维补满 2 条
  PR.writeProfile(UID, {
    v: 1, uid: UID, builtAt: T0, model: 'test', sourceDigest: PR.computeDigest(active),
    slots: [{ dim: '性格特质', content: '嘴硬但情绪恢复快，自嘲方式多', sourceEntryIds: ['l1_9900000001_1'], chars: 12 }],
    stats: { missingDims: ['性格特质', '兴趣身份'], sensitiveHits: 0, retry: 1 }
  });
  const r2 = PR.repairProfileSlots(UID, { activeEntries: active, now: T0 + 200 });
  const fixed = PR.readProfile(UID);
  assert.deepEqual(r2.filledDims, ['兴趣身份'], '#19 只补整维为空的兴趣身份（性格特质已有 1 条，不补满）');
  assert.equal(fixed.slots.length, 2, '#19 1 → 2 槽');
  assert.deepEqual(fixed.stats.missingDims, [], '#19 修完不再缺维');
  assert.ok(fixed.stats.repairedAt > 0, '#19 留 repairedAt 供审计');
  ok('#19 零调用修复：只补空维、不改 digest/builtAt、不删槽、命中只计数');
}

// ── #20 repairProfileSlots：不重算/不改写 masked 槽；只补空维；幂等 ──
{
  freshRoot();
  const rows = [
    [1, '性格特质', '对同人内容有明确底线，反感凌辱、恶堕、精神摧毁类情节，自认道德感高', 9],
    [2, '兴趣身份', '爱聊同人本子，对纯爱向有明确偏好', 8],
    [3, '说话风格', '句子极短，爱用口头禅收尾，情绪直接外露', 7],
    [4, '性格特质', '嘴硬但情绪恢复快，自嘲方式多', 6]
  ];
  for (const [i, g, c, u] of rows) {
    M.appendPerson(mkEntry(i, { groups: [g], content: c, updatedAt: T0 + u }));
  }
  const active = M.activePerson(UID);
  PR.writeProfile(UID, {
    v: 1, uid: UID, builtAt: T0, model: 'test', sourceDigest: PR.computeDigest(active),
    slots: [
      { dim: '说话风格', content: '句子极短，爱用口头禅收尾，情绪直接外露', sourceEntryIds: ['l1_9900000001_3'], chars: 22 },
      // 旧版脱敏产物：只统计、不拦截后不再修复它，原样保留
      { dim: '性格特质', content: '对同人内容有明确底线，反感凌辱、精神摧毁类情节，自认道德感高', sourceEntryIds: ['l1_9900000001_1'], chars: 34, masked: true },
      { dim: '兴趣身份', content: '爱聊同人某类题材，对纯爱向有明确偏好', sourceEntryIds: ['l1_9900000001_2'], chars: 20, masked: true },
      { dim: '性格特质', content: '嘴硬但情绪恢复快，自嘲方式多', sourceEntryIds: ['l1_9900000001_4'], chars: 14 }
    ],
    stats: { missingDims: [], sensitiveHits: 1, retry: 0, covered: 4, active: 4, filledDims: [] }
  });
  const before = PR.readProfile(UID);
  const r = PR.repairProfileSlots(UID, { activeEntries: active, now: T0 + 100 });
  const after = PR.readProfile(UID);
  assert.deepEqual(after.slots, before.slots, '#20 masked 槽原样保留：不重算、不还原、不删');
  assert.ok(after.slots.some((s) => s.content.includes('凌辱')), '#20 题材词照常留在槽里');
  assert.equal(after.stats.sensitiveHits, 1, '#20 命中计数按槽位实况重算');
  assert.equal(r.changed, false, '#20 无空维且统计一致 → changed=false');
  // 幂等：再跑一次什么都不改
  const r2 = PR.repairProfileSlots(UID, { activeEntries: active, now: T0 + 200 });
  assert.equal(r2.changed, false, '#20 幂等：第二次 changed=false');
  ok('#20 存量 masked 槽原样保留；命中只计数；repair 幂等');
}

// 清理
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\nmem2-profile: ${passed} 项通过`);