// 〔印象 / 知识 / 摘要：三个顶层独立页〕——M9 拆分第 14 段
//
// ── 为什么是三个独立页 ───────────────────────────────────────────────────
// 旧版是「记忆库」一页 + 内部子页签，三页共用同一套列表/详情容器。
// 共用容器意味着迟到响应可能写进用户当前看的另一页，
// 而「写错页」在结构上无法用代码纪律根治。现在每页有自己的 section、自己的
// aside.list-pane + div.detail-pane，容器物理隔离。
//
// ── 三条红线 ─────────────────────────────────────────────────────────────
//   1. 不许白屏：骨架写死在 index.html，三个 loadXxxPage() 不得 async/await，
//      网络一律「只发起、不等待」，结果用 .then() 回来更新。
//      **允许下拉晚 3 秒，不接受首屏白屏。**
//   2. 不许假数据：加载中 `读取中…` / 确认空 / 请求失败三态不得互相冒充。
//      知识页后端恒为空，空是正确状态（只渲染后端 note，不硬造卡片）。
//   3. 不许绕过：写操作只走既有三个接口（PATCH / void / DELETE），
//      彻底删除必须两段式 + confirm='DELETE'。
//
// ── 跳原文 ───────────────────────────────────────────────────────────────
// 消息行同时有 data-midrow=m.id 与 data-mid=m.mid；定位只能用 data-mid。
// 找不到行与请求异常两条分支都用 showNoticeModal 如实提示 —— 旧版把错误写进
// 一个当时不可见的页面，用户永远看不到（缺陷 D3）。
'use strict';

// 三个页面各有自己的状态。没有共享的 tab 字段，没有「当前子页」这个概念。
const MEM_UI = {
  impression: {
    people: [],                    // 当前展示（已被 q 过滤）
    basePeople: [],                // 后端按 chat 过滤后的完整结果
    contentHitIds: new Set(),      // 后端按内容命中的 userId
    chatOptions: [],               // 见过的群全集，只增不减（后端按群过滤 people）
    chat: '',                      // 群筛选，空 = 全部
    q: '',                         // 搜索词
    selectedUserId: '',
    person: null,                  // { userId, entries, profile, counts }
    personLoading: false,
    peopleLoaded: false,           // 首次列表请求是否已落地（区分「读取中」与「确认无人」）
    showAll: false,
    mode: 'graph',                 // 'list' | 'graph'，首次进页显示星图；内存态，不落 localStorage
    graph: null,                   // { people, impressions, total }（全量，不带 chat）
    graphView: { yaw: 0.42, pitch: -0.24, zoom: 1, rot: null },
    graphLoading: false,
    graphError: '',
    graphSeq: 0,
    pendingEntryId: '',            // 点击印象后等待详情滚动到的 entryId
    graphSelectedKey: '',          // 'user:<uid>' | 'imp:<entryId>' | ''
    detailUserId: '',              // 右栏当前详情归属，可与 selectedUserId 不同
    editing: '',                   // 正在编辑的 entryId
    purgeArm: '',                  // 二次确认待确认的 entryId
    deletionCount: 0,
    identity: Object.create(null), // chatKey -> { at, byUid: Map, failed }
    error: '',                     // 本页错误（错误/提示一律页内）
    chatsError: '',                // /api/chats 失败（与 error 分开，便于只修下拉）
    peopleSeq: 0,
    detailSeq: 0,
    identitySeq: 0,
    deletionSeq: 0,
    qTimer: null
  },
  knowledge: { data: null, loading: false, seq: 0, error: '' },
  summaries: {
    chat: '', ym: '',
    data: null, loading: false, seq: 0,
    cache: Object.create(null),
    error: '', chatsError: ''
  }
};

// 身份缓存 TTL：成功 10 分钟、失败 2 分钟；并发上限 3。
// 刷新页面/清内存只是重拉，不落 localStorage（避免过期与隐私扩散）。
const MEM_IDENTITY_TTL_OK = 10 * 60 * 1000;
const MEM_IDENTITY_TTL_FAIL = 2 * 60 * 1000;
const MEM_IDENTITY_CONCURRENCY = 3;

// 3D 星图模块级句柄（不是 MEM_UI 状态，不参与测试快照）
let impressionGraphScene = null;        // buildImpressionGraphScene 的结果
let impressionGraphCanvas = null;
let impressionGraphHoverKey = '';
let impressionGraphLastHoverKey = '';
let impressionGraphRaf = 0;
let impressionGraphLastTs = 0;
let impressionGraphDragging = null;
let impressionGraphSuppressClick = false;
let impressionGraphResizeObserver = null;
let impressionGraphReducedMotion = false;
let impressionGraphSprites = null;      // 预烘焙贴图缓存
let impressionGraphProjection = null;   // 最近一帧投影（命中测试用）
let impressionGraphBaseSpritesReady = false;
let impressionGraphBaseSpritesPreparing = false;
let impressionGraphSceneSpritesReady = false;
let impressionGraphSceneSpritesPreparing = false;
let impressionGraphScenePreheatToken = 0;
let impressionGraphPendingPeople = null;
let impressionGraphSpritesFailed = false;
let impressionGraphDrawList = [];       // 深度合并绘制复用数组
let impressionGraphDrawRaf = 0;         // 一次性合并绘制句柄
let impressionGraphLastPaint = 0;       // 上次实际绘制时间（60fps 上限）
let impressionGraphCanvasSize = null;   // { w, h } CSS 尺寸缓存（ResizeObserver 维护，避免每帧读布局）
let impressionGraphSizeCacheLive = false; // 无 ResizeObserver 时不缓存，回退为绘制时读取
let impressionGraphZoomSaveTimer = 0;   // 缩放持久化防抖句柄
let impressionGraphZoomSavePending = 0; // 待写盘的目标缩放
let impressionGraphSuppressDblClick = false;
let impressionGraphBackgroundGradient = null;
let impressionGraphBackgroundGradientKey = '';

const impressionGraphReplay = {
  active: false,
  order: [],
  index: 0,
  visibleUsers: new Set(),
  visibleImpressions: new Set(),
  timer: 0,
  total: 0,
  lastCancelReason: '',
  cancelSeq: 0,
  lastStepAt: 0,
  completedAt: 0
};

// ══════════════════════════════════════════════════════════════════════════
// 常量与纯工具
// ══════════════════════════════════════════════════════════════════════════

/** 当前月 YYYY-MM（与后端 ymOf 同格式，也是 input[type=month] 的 value 格式）。 */
function memYmNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** /api/chats 的项同时有 key 与 chatKey，两个都认。 */
function memChatKeyOf(c) {
  return String(c?.chatKey || c?.key || '').trim();
}

/** 群显示名：统一走 formatChatTitle + chatNameOf。 */
function memChatName(key) {
  if (!key) return '全部群';
  return formatChatTitle(key, chatNameOf(key));
}

/** `group:123` → `123`；其它返回空串（私聊/异常 key 不参与成员拉取）。 */
function memGroupId(chatKey) {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  return m ? m[1] : '';
}

/** 会话副标题：群号 / 私聊号。主行已经是这个名字时不重复。 */
function memChatSub(chatKey) {
  const key = String(chatKey || '');
  const name = memChatName(key);
  const gid = memGroupId(key);
  if (gid) return name === `群 ${gid}` ? '' : `群 ${gid}`;
  const pm = /^private:(\d+)$/.exec(key);
  if (pm) return name === `私聊 ${pm[1]}` ? '' : `私聊 ${pm[1]}`;
  return '';
}

/** 摘要左栏的会话键（群聊 + 私聊 + 旧格式，按 state.chats 去重保序）。 */
function memChatEntries() {
  const seen = new Set();
  const out = [];
  for (const c of state.chats || []) {
    const k = memChatKeyOf(c);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** 需要判「页面是否可见」时用（只影响副作用大的动作，写自己容器不需要判）。 */
function memPageVisible(name) { return state.tab === name; }

/** 会话行（摘要页）。 */
function memChatRow(chatKey, selected) {
  return `
    <div class="chat-item${selected ? ' selected' : ''}" data-chatkey="${esc(chatKey)}">
      <div class="chat-item-title"><span class="session-chat">${esc(memChatName(chatKey))}</span></div>
      <div class="chat-item-sub">${esc(memChatSub(chatKey))}</div>
    </div>`;
}

/** 页面级错误块（只写本页容器）。 */
function memErrorBlock(text) {
  return text ? `<div class="mem2-error">${esc(text)}</div>` : '';
}

// ══════════════════════════════════════════════════════════════════════════
// 会话列表：唯一在途 Promise + 失败可重试
// ══════════════════════════════════════════════════════════════════════════

let chatsP = null;   // 本文件私有：唯一在途的 /api/chats

/**
 * 三个页面共享的会话列表。
 * - 已有数据：立刻 resolve，不发请求；
 * - 无数据：发起一次，并发调用共享同一个 Promise（不会打出两发）；
 * - 失败：清空在途指针并抛出，调用方负责显示错误；下次调用可重试。
 */
function ensureChats() {
  if ((state.chats || []).length) return Promise.resolve(state.chats);
  if (!chatsP) {
    chatsP = api('/api/chats')
      .then((d) => {
        state.chats = d?.chats || [];
        return state.chats;
      })
      .finally(() => { chatsP = null; });
  }
  return chatsP;
}

// ══════════════════════════════════════════════════════════════════════════
// 身份缓存（QQ 昵称 / 群名片）：只走现有 /api/groups/:id/members
// ══════════════════════════════════════════════════════════════════════════

function memIdentityOf(chatKey) {
  const cur = MEM_UI.impression.identity[chatKey];
  if (!cur) return null;
  const ttl = cur.failed ? MEM_IDENTITY_TTL_FAIL : MEM_IDENTITY_TTL_OK;
  if (Date.now() - cur.at > ttl) return null;
  return cur;
}

/** 主群排序（后端 chatStats 已排好，这里只取群聊；旧后端无 chatStats 时退回 chatKeys）。 */
function memMainGroupKeys(p) {
  const stats = Array.isArray(p?.chatStats) ? p.chatStats : [];
  const groups = stats.map((s) => String(s.chatKey || '')).filter((k) => memGroupId(k));
  if (groups.length) return groups;
  return ((p?.chatKeys || [])).filter((k) => memGroupId(k));
}

/**
 * 主昵称：QQ 昵称 > 主群群名片 > `QQ <uid>`。
 * 主行不重复号码：没名字时只显示 `QQ <uid>`。
 */
function memPersonName(p) {
  const uid = String(p?.userId || '');
  const order = memMainGroupKeys(p);
  let qqNick = '';
  for (const k of order) {
    const m = memIdentityOf(k)?.byUid?.get(uid);
    if (m?.nickname) { qqNick = m.nickname; break; }
  }
  const primaryKey = order[0] || '';
  const pm = primaryKey ? memIdentityOf(primaryKey)?.byUid?.get(uid) : null;
  const primaryCard = String(pm?.card || pm?.nickname || '').trim();
  const primaryName = String(qqNick || primaryCard || '').trim();
  return {
    label: primaryName ? `${primaryName}（${uid}）` : `QQ ${uid}`,
    primaryKey,
    groupKeys: order,
    qqNick
  };
}

/** 详情头部取昵称/群的来源：先查当前列表，再查未过滤的完整列表（IM-06 / D1）。 */
function impressionRowOf(userId) {
  const uid = String(userId || '');
  const st = MEM_UI.impression;
  return st.people.find((p) => String(p.userId) === uid)
    || st.basePeople.find((p) => String(p.userId) === uid)
    || null;
}

/**
 * 拉当前人物列表里出现过的群的成员名单（并发 ≤3）。
 * 只拉 `group:<id>`，不遍历全部群；失败静默（回退 `QQ <uid>`），不弹错误、不阻塞列表。
 */
async function loadImpressionIdentity() {
  const st = MEM_UI.impression;
  const pool = (st.basePeople.length ? st.basePeople : st.people);
  const keys = [];
  for (const p of pool) {
    for (const k of p.chatKeys || []) {
      const gid = memGroupId(k);
      if (gid && !memIdentityOf(k) && !keys.includes(k)) keys.push(k);
    }
  }
  if (!keys.length) return;

  const token = ++MEM_UI.impression.identitySeq;
  let cursor = 0;
  const worker = async () => {
    while (cursor < keys.length) {
      const k = keys[cursor++];
      const gid = memGroupId(k);
      try {
        const d = await api(`/api/groups/${encodeURIComponent(gid)}/members`);
        const byUid = new Map();
        for (const m of d.members || []) {
          byUid.set(String(m.userId), { nickname: String(m.nickname || ''), card: String(m.card || '') });
        }
        MEM_UI.impression.identity[k] = { at: Date.now(), byUid, failed: false };
      } catch {
        MEM_UI.impression.identity[k] = { at: Date.now(), byUid: new Map(), failed: true };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MEM_IDENTITY_CONCURRENCY, keys.length) }, worker));
  if (token !== MEM_UI.impression.identitySeq) return;   // 期间又有新列表，丢弃这次重绘

  // roster 回来后用内存里的完整列表重过滤一次（不重复打后端），再统一重绘左栏。
  applyImpressionFilter();
  renderImpressionPeople();
  if (st.mode === 'graph') renderImpressionDetail();             // 昵称晚到时刷新星图标签
  else if (st.person && !st.editing) renderImpressionDetail();   // 补昵称后的详情头才和左栏一致
}

// ══════════════════════════════════════════════════════════════════════════
// 印象页
// ══════════════════════════════════════════════════════════════════════════

/**
 * 见过的群全集（累积在 chatOptions，只往里加）。
 * 后端 `listPeople({chat})` 会按群过滤——切到群 A 后与 A 无共同成员的人不再返回，
 * 若下拉现算并集，B 群会永久消失（IM-03）。
 */
function memChatKeys() {
  const keys = new Set(MEM_UI.impression.chatOptions || []);
  for (const c of state.chats || []) {
    const k = memChatKeyOf(c);
    if (k) keys.add(k);
  }
  // ★ LR-03：必须遍历 basePeople（过滤前的完整结果），不能只读 st.people ——
  //   q 非空时带群但不匹配 q 的人物会被 applyImpressionFilter 过滤掉，群就漏了。
  for (const p of MEM_UI.impression.basePeople || []) for (const k of p.chatKeys || []) keys.add(k);
  MEM_UI.impression.chatOptions = [...keys].sort();
  return MEM_UI.impression.chatOptions;
}

/** 只替换 #impression-chat 的 option，不重建 select（D5：节点保持原样）。 */
function refreshImpressionChatOptions() {
  const sel = document.getElementById('impression-chat');
  if (!sel) return;
  const st = MEM_UI.impression;
  const keys = memChatKeys();
  if (st.chat && !keys.includes(st.chat)) st.chat = '';
  sel.innerHTML = ['<option value="">全部群</option>']
    .concat(keys.map((k) => `<option value="${esc(k)}"${k === st.chat ? ' selected' : ''}>${esc(memChatName(k))}</option>`))
    .join('');
}

/**
 * 首屏：骨架已在 index.html 里，这里只做「先渲染 → 只发起 → chats 回来补下拉」。
 * 不得声明成 async、不得 await 任何网络（S9/S10 锁这条）。
 */
function loadImpressionPage() {
  const st = MEM_UI.impression;
  st.error = '';
  st.chatsError = '';                  // ★ LR-04：进入即清，旧错误不得残留到下一次成功
  preheatImpressionGraphSprites();
  renderImpressionAll();
  if (st.mode === 'graph' && !st.graph) loadImpressionGraphData();
  loadImpressionDeletionCount();     // 装饰性数据不挡首屏
  loadImpressionPeople();
  ensureChats()
    .then(() => {
      st.chatsError = '';             // ★ LR-04：成功即清错
      refreshImpressionChatOptions();
      renderImpressionDetail();       // 清掉可能残留的 chats 错误块，不依赖人物加载时序
    })
    .catch((err) => { onImpressionChatsFailed(err); });
}

function onImpressionChatsFailed(err) {
  const st = MEM_UI.impression;
  st.chatsError = `读取会话列表失败：${err.message}`;
  renderImpressionDetail();
}

function renderImpressionAll() {
  updateImpressionGraphToggle();
  renderImpressionPeople();
  renderImpressionDetail();
}

function renderImpressionPeople() {
  const st = MEM_UI.impression;
  const items = document.getElementById('impression-items');
  const countEl = document.getElementById('impression-count');
  const total = st.people.reduce((n, p) => n + (Number(p.activeCount) || 0), 0);
  if (countEl) countEl.textContent = `${st.people.length} 人 · ${total} 条有效印象`;
  if (!items) return;
  const top = items.scrollTop;          // 只换行、不换容器；滚动位置手动保住
  if (st.people.length) {
    items.innerHTML = st.people.map(impressionPersonRow).join('');
  } else if (st.error) {
    items.innerHTML = memErrorBlock(st.error);
  } else if (!st.peopleLoaded) {
    items.innerHTML = '<div class="empty-hint">读取中…</div>';
  } else if (st.q && st.basePeople.length) {
    items.innerHTML = '<div class="empty-hint">没有匹配的人物</div>';
  } else {
    items.innerHTML = '<div class="empty-hint">还没有任何画像（等 L1 提炼跑一轮）</div>';
  }
  items.scrollTop = top;
}

function impressionPersonRow(p) {
  const st = MEM_UI.impression;
  const info = memPersonName(p);
  const uid = String(p.userId || '');
  let lines = '';
  if (info.groupKeys.length) {
    lines = info.groupKeys.map((k, i) => {
      const gid = memGroupId(k);
      if (!gid) return '';
      const m = memIdentityOf(k)?.byUid?.get(uid);
      const nm = String(m?.card || m?.nickname || info.qqNick || '').trim();
      return `<div class="mem2-person-group${i === 0 ? ' is-main' : ''}">${esc(nm ? `${nm} · 群 ${gid}` : `群 ${gid}`)}</div>`;
    }).join('');
  } else {
    lines = '<div class="mem2-person-group is-main">私聊</div>';
  }
  return `
    <div class="chat-item mem2-person-item${st.selectedUserId === uid ? ' selected' : ''}" data-uid="${esc(uid)}">
      <div class="chat-item-title">
        <span class="session-chat">${esc(info.label)}</span>
        <span class="mem2-person-count" title="有效印象">${Number(p.activeCount) || 0}</span>
      </div>
      ${lines}
    </div>`;
}

function renderImpressionDetail() {
  const st = MEM_UI.impression;
  const body = document.getElementById('impression-body');
  if (!body) return;
  if (st.mode === 'graph') {
    impressionGraphReducedMotion = impressionGraphPrefersReducedMotion();
    renderImpressionGraph();
    return;
  }
  const banner = st.error ? `<div class="mem2-error">${esc(st.error)}</div>` : '';
  if (st.personLoading && !st.person) {
    body.innerHTML = banner + '<div class="empty-hint">读取中…</div>';
    return;
  }
  if (!st.person) {
    const hint = st.selectedUserId ? '已选中，双击查看详情' : '← 选择人物查看印象';
    body.innerHTML = banner + memErrorBlock(st.chatsError) + `<div class="empty-hint">${hint}</div>`;
    return;
  }
  body.innerHTML = banner + impressionPersonDetail(st.person);
  impressionConsumePendingEntryFocus();
}

function impressionPersonDetail(p) {
  const st = MEM_UI.impression;
  const counts = p.counts || {};
  const hidden = st.showAll ? 0 : (counts.superseded || 0);
  const row = impressionRowOf(p.userId);
  const info = memPersonName(row || { userId: p.userId, chatKeys: [] });
  const gid = memGroupId(info.primaryKey);
  const groupLine = gid
    ? ((() => {
      const m = memIdentityOf(info.primaryKey)?.byUid?.get(String(p.userId));
      const nm = String(m?.card || m?.nickname || '').trim();
      return nm ? `${nm} · 群 ${gid}` : `群 ${gid}`;
    })())
    : '私聊';
  return `
    <div class="detail-header">
      <h2>${esc(info.label)}</h2>
      <div class="sub">
        <span>${esc(groupLine)}</span>
        <span>有效 ${counts.active || 0}</span>
        <span>已归并 ${counts.superseded || 0}</span>
        <span>已删 ${counts.void || 0}</span>
        <span>冲突 ${counts.conflicted || 0}</span>
        <button class="btn-ghost mem2-toggle" data-showall="1">${st.showAll ? '只看有效' : '含历史版本'}</button>
      </div>
      ${hidden ? `<div class="muted mem2-hint">还有 ${hidden} 条历史版本未列（已被新版本取代）</div>` : ''}
    </div>
    ${impressionProfileBlock(p.profile)}
    ${(p.entries || []).map(impressionEntryCard).join('') || '<div class="empty-hint">这个人没有条目</div>'}`;
}

// 注入画像（A 方案派生视图）：只读预览，8 条按维度 2/2/2/2。
// 它不是事实来源 —— 事实在下方的有效条目里，这里只回答「模型实际看到的是什么」。
function impressionProfileBlock(profile) {
  if (!profile) return '<div class="muted mem2-hint">还没有注入画像（下一轮 L1 压缩后生成）</div>';
  const slots = Array.isArray(profile.slots) ? profile.slots : [];
  const dims = ['说话风格', '关系态度', '性格特质', '兴趣身份'];
  const rows = dims.map((dim) => {
    const mine = slots.filter((s) => s.dim === dim);
    return `
      <div class="mem2-profile-row">
        <span class="mem2-profile-dim">${esc(dim)}</span>
        <span>${mine.length ? mine.map((s) => esc(s.content)).join('<br>') : '<span class="muted">—</span>'}</span>
      </div>`;
  }).join('');
  return `
    <div class="mem2-profile">
      <div class="mem2-profile-title">注入画像 ${slots.length}/8 条
        <span class="muted">· ${fmtTime(profile.builtAt)}</span>
        ${profile.dirty ? '<span class="mem2-flag" title="有效印象已变化，下一轮会重压">已过期</span>' : ''}
      </div>
      ${slots.length ? rows : '<div class="empty-hint">画像为空（有效印象不足或压缩输出为空）</div>'}
    </div>`;
}

function impressionEntryCard(e) {
  const st = MEM_UI.impression;
  const flags = [
    e.pinnedByUser ? '<span class="mem2-flag pin" title="用户编辑过，去重会绕开它">已编辑</span>' : '',
    e.status === 'void' ? '<span class="mem2-flag void">已删除</span>' : '',
    e.status === 'superseded' ? '<span class="mem2-flag sup">已被取代</span>' : '',
    e.editedFrom ? `<span class="mem2-flag" title="改自 ${esc(e.editedFrom)}">溯源</span>` : ''
  ].join('');
  if (st.editing === e.entryId) {
    return `
      <div class="mem2-card editing">
        <textarea class="mem2-edit" data-edit-for="${esc(e.entryId)}" rows="4">${esc(e.content)}</textarea>
        <div class="mem2-card-foot">
          <button class="btn-primary" data-save="${esc(e.entryId)}">保存</button>
          <button class="btn-ghost" data-cancel="${esc(e.entryId)}">取消</button>
          <span class="muted">保存后原条目会变成「已归并」，新条目带上「已编辑」标记</span>
        </div>
      </div>`;
  }
  return `
    <div class="mem2-card" data-entry="${esc(e.entryId)}">
      <div class="mem2-card-body">${esc(e.content)}</div>
      <div class="mem2-card-foot">
        <span class="muted">${(e.groups || []).join('/')} · ${fmtTime(e.updatedAt || e.createdAt)}</span>
        ${flags}
        <span class="mem2-actions">
          ${e.status === 'void'
            ? `<button class="btn-ghost" data-undo="${esc(e.entryId)}">撤销删除</button>`
            : `<button class="btn-ghost" data-edit="${esc(e.entryId)}">编辑</button>
               <button class="btn-ghost danger" data-void="${esc(e.entryId)}">删除</button>`}
          ${st.purgeArm === e.entryId
            ? `<button class="btn-danger" data-purge2="${esc(e.entryId)}">⚠ 确认彻底删除（不可撤销）</button>`
            : `<button class="btn-ghost danger" data-purge1="${esc(e.entryId)}" title="物理删除全部版本行，留审计">彻底删除</button>`}
          ${impressionJumpButton(e)}
        </span>
      </div>
    </div>`;
}

function impressionJumpButton(e) {
  const mid = (e.sourceMsgIds || [])[0];
  const chat = (e.sourceChatKeys || [])[0] || MEM_UI.impression.chat;
  if (!mid || !chat) return '';
  return `<button class="btn-ghost" data-jump="${esc(chat)}|${esc(mid)}" title="跳到原始消息">原文</button>`;
}

// ══════════════════════════════════════════════════════════════════════════
// 印象记忆星图（3D 星云：Canvas 2D 透视投影，不引第三方库）
// ══════════════════════════════════════════════════════════════════════════

const IMPRESSION_GRAPH_SCALE_KEY = 'qqa-imp-graph-scale';
const IMPRESSION_GRAPH_DEFAULT = { yaw: 0.42, pitch: -0.24, zoom: 1, rot: null };
const IMPRESSION_GRAPH_CENTER = '#070b16';
const IMPRESSION_GRAPH_DEEP = '#02040a';
const IMPRESSION_GRAPH_FOCAL = 3.0;
const IMPRESSION_GRAPH_X_SPREAD = 1.25;
const IMPRESSION_GRAPH_FRAME_MS = 1000 / 60;
const IMPRESSION_GRAPH_ZOOM_SAVE_MS = 200;

function impressionGraphCameraMatrix(yaw, pitch) {
  const cy = Math.cos(Number(yaw) || 0), sy = Math.sin(Number(yaw) || 0);
  const cp = Math.cos(Number(pitch) || 0), sp = Math.sin(Number(pitch) || 0);
  return [
    cy, 0, sy,
    sy * sp, cp, -cy * sp,
    -sy * cp, sp, cy * cp
  ];
}

function impressionGraphRotValid(rot) {
  return Array.isArray(rot) && rot.length === 9 && rot.every((v) => Number.isFinite(v));
}

function impressionGraphMatMul(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

function impressionGraphScreenRotX(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function impressionGraphScreenRotY(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function updateImpressionGraphToggle() {
  const btn = document.getElementById('impression-graph-toggle');
  if (!btn) return;
  const graph = MEM_UI.impression.mode === 'graph';
  btn.textContent = graph ? '列表' : '星图';
  btn.title = graph ? '返回人物列表' : '切换记忆星图';
  btn.setAttribute('aria-pressed', graph ? 'true' : 'false');
  btn.classList.toggle('is-active', graph);
}

function setImpressionMode(mode) {
  const st = MEM_UI.impression;
  const next = mode === 'graph' ? 'graph' : 'list';
  if (st.mode === next) return;
  st.mode = next;
  updateImpressionGraphToggle();
  if (next === 'graph') {
    st.graphView.yaw = IMPRESSION_GRAPH_DEFAULT.yaw;
    st.graphView.pitch = IMPRESSION_GRAPH_DEFAULT.pitch;
    st.graphView.rot = null;
    st.graphView.zoom = impressionGraphReadZoom();
    impressionGraphReducedMotion = impressionGraphPrefersReducedMotion();
    preheatImpressionGraphSprites();
    impressionGraphHoverKey = '';
    impressionGraphLastHoverKey = '';
    if (!st.graph) {
      st.graphLoading = true;
      renderImpressionGraph();
      loadImpressionGraphData();
    } else {
      if (!impressionGraphScene) impressionGraphScene = buildImpressionGraphScene(st.graph);
      renderImpressionGraph();
    }
  } else {
    teardownImpressionGraph();
    renderImpressionDetail();
  }
}

function impressionGraphReadZoom() {
  try {
    const raw = window.localStorage.getItem(IMPRESSION_GRAPH_SCALE_KEY);
    if (raw == null || raw === '') return 1;
    const v = Number(raw);
    if (!Number.isFinite(v)) return 1;
    return Math.min(2.8, Math.max(0.55, v));
  } catch { return 1; }
}

function impressionGraphSaveZoom(zoom) {
  try { window.localStorage.setItem(IMPRESSION_GRAPH_SCALE_KEY, String(zoom)); } catch { /* ignore */ }
}

function impressionGraphCancelZoomSave() {
  if (impressionGraphZoomSaveTimer) {
    clearTimeout(impressionGraphZoomSaveTimer);
    impressionGraphZoomSaveTimer = 0;
  }
  impressionGraphZoomSavePending = 0;
}

function impressionGraphFlushZoomSave() {
  if (impressionGraphZoomSaveTimer) {
    clearTimeout(impressionGraphZoomSaveTimer);
    impressionGraphZoomSaveTimer = 0;
  }
  if (!impressionGraphZoomSavePending) return;
  const zoom = impressionGraphZoomSavePending;
  impressionGraphZoomSavePending = 0;
  impressionGraphSaveZoom(zoom);
}

function impressionGraphQueueZoomSave(zoom) {
  impressionGraphZoomSavePending = zoom;
  if (impressionGraphZoomSaveTimer) return;
  impressionGraphZoomSaveTimer = setTimeout(() => {
    impressionGraphZoomSaveTimer = 0;
    impressionGraphFlushZoomSave();
  }, IMPRESSION_GRAPH_ZOOM_SAVE_MS);
}

function impressionGraphReplayNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function impressionGraphReplayVisible(node) {
  if (!node) return false;
  if (!impressionGraphReplay.active) return true;
  if (node.kind === 'agent') return true;
  if (node.kind === 'user') return impressionGraphReplay.visibleUsers.has(node.key);
  if (node.kind === 'impression') return impressionGraphReplay.visibleImpressions.has(node.key);
  return false;
}

function impressionGraphBuildReplayOrder(scene) {
  const groups = new Map();
  for (const im of Array.isArray(scene?.impressions) ? scene.impressions : []) {
    const uid = String(im.uid || im.userId || '');
    if (!uid) continue;
    if (!groups.has(uid)) {
      groups.set(uid, { uid, userKey: String(im.userKey || `user:${uid}`), firstAt: 0, impressionKeys: [] });
    }
    const g = groups.get(uid);
    g.impressionKeys.push(im.key);
    const at = Number(im.createdAt) || 0;
    if (at > 0 && (g.firstAt === 0 || at < g.firstAt)) g.firstAt = at;
  }
  const order = [...groups.values()];
  order.sort((a, b) => {
    if (a.firstAt !== b.firstAt) {
      if (a.firstAt === 0) return 1;
      if (b.firstAt === 0) return -1;
      return a.firstAt - b.firstAt;
    }
    return a.uid.localeCompare(b.uid);
  });
  return order;
}

function impressionGraphUpdateReplayButton() {
  const btn = document.getElementById('impression-graph-recall');
  if (!btn) return;
  const label = btn.querySelector('.mem2-graph-recall-label');
  if (impressionGraphReplay.active) {
    btn.disabled = true;
    btn.classList.add('is-running');
    if (label) label.textContent = `回顾中 ${impressionGraphReplay.index}/${impressionGraphReplay.total}`;
  } else {
    btn.disabled = false;
    btn.classList.remove('is-running');
    if (label) label.textContent = '回顾';
  }
}

function impressionGraphStartReplay() {
  const st = MEM_UI.impression;
  const replay = impressionGraphReplay;
  if (impressionGraphReplay.active) return;
  if (!st.graph || st.graphLoading || st.mode !== 'graph') return;
  if (!memPageVisible('mem-impression')) return;
  if (!impressionGraphCanvas || !impressionGraphScene) return;
  if (!impressionGraphBaseSpritesReady || !impressionGraphSceneSpritesReady || !impressionGraphSprites) return;
  const order = impressionGraphBuildReplayOrder(impressionGraphScene);
  replay.order = order;
  replay.index = 0;
  replay.total = order.length;
  if (!order.length) {
    impressionGraphUpdateReplayButton();
    return;
  }
  if (replay.timer) {
    clearTimeout(replay.timer);
    replay.timer = 0;
  }
  replay.active = true;
  replay.lastCancelReason = '';
  replay.lastStepAt = 0;
  replay.completedAt = 0;
  replay.visibleUsers.clear();
  replay.visibleImpressions.clear();
  impressionGraphHoverKey = '';
  impressionGraphLastHoverKey = '';
  impressionGraphHideTip(document.getElementById('impression-graph-tip'));
  impressionGraphUpdateReplayButton();
  impressionGraphRequestDraw();
  replay.timer = setTimeout(impressionGraphReplayStep, 250);
}

function impressionGraphReplayStep() {
  const replay = impressionGraphReplay;
  replay.timer = 0;
  if (!replay.active) return;
  if (!memPageVisible('mem-impression') || (typeof document !== 'undefined' && document.hidden)) {
    impressionGraphCancelReplay({ restore: false, reason: 'inactive' });
    return;
  }
  if (MEM_UI.impression.mode !== 'graph' || !impressionGraphCanvas || !impressionGraphScene) {
    impressionGraphCancelReplay({ restore: false, reason: 'render' });
    return;
  }
  const item = replay.order[replay.index];
  if (!item) {
    impressionGraphReplayFinish();
    return;
  }
  replay.index += 1;
  replay.visibleUsers.add(item.userKey);
  for (const key of item.impressionKeys) replay.visibleImpressions.add(key);
  replay.lastStepAt = impressionGraphReplayNow();
  impressionGraphUpdateReplayButton();
  impressionGraphRequestDraw();
  if (replay.index >= replay.total) {
    impressionGraphReplayFinish();
    return;
  }
  replay.timer = setTimeout(impressionGraphReplayStep, 250);
}

function impressionGraphReplayFinish() {
  const replay = impressionGraphReplay;
  if (replay.timer) {
    clearTimeout(replay.timer);
    replay.timer = 0;
  }
  replay.completedAt = impressionGraphReplayNow();
  replay.active = false;
  replay.visibleUsers.clear();
  replay.visibleImpressions.clear();
  impressionGraphUpdateReplayButton();
  impressionGraphRequestDraw();
}

function impressionGraphCancelReplay({ restore = true, reason = 'manual' } = {}) {
  const replay = impressionGraphReplay;
  if (replay.timer) {
    clearTimeout(replay.timer);
    replay.timer = 0;
  }
  const wasActive = replay.active === true;
  replay.active = false;
  replay.visibleUsers.clear();
  replay.visibleImpressions.clear();
  impressionGraphHoverKey = '';
  impressionGraphLastHoverKey = '';
  impressionGraphHideTip(document.getElementById('impression-graph-tip'));
  impressionGraphUpdateReplayButton();
  if (wasActive) {
    replay.lastCancelReason = reason;
    replay.cancelSeq += 1;
  }
  if (!restore) return;
  if (MEM_UI.impression.mode === 'graph' && memPageVisible('mem-impression')
    && impressionGraphCanvas && impressionGraphScene) {
    impressionGraphRequestDraw();
  }
}

function impressionGraphClearZoom() {
  try { window.localStorage.removeItem(IMPRESSION_GRAPH_SCALE_KEY); } catch { /* ignore */ }
}

function impressionGraphPrefersReducedMotion() {
  try {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch { return false; }
}

function impressionGraphHash01(text, salt = 0) {
  const s = String(text ?? '');
  let h = (2166136261 ^ (Number(salt) || 0)) >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 1000000) / 1000000;
}

function impressionGraphSphereDir(i, n) {
  const count = Math.max(1, Number(n) || 1);
  const y = 1 - (2 * (i + 0.5)) / count;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return { x: Math.cos(phi) * r, y, z: Math.sin(phi) * r };
}

function impressionGraphRotateDir(dir, dyaw, dpitch) {
  const cy = Math.cos(dyaw), sy = Math.sin(dyaw);
  const x1 = dir.x * cy + dir.z * sy;
  const z1 = -dir.x * sy + dir.z * cy;
  const cp = Math.cos(dpitch), sp = Math.sin(dpitch);
  return { x: x1, y: dir.y * cp - z1 * sp, z: dir.y * sp + z1 * cp };
}

function impressionGraphUserColor(uid) {
  const hue = 205 + (impressionGraphHash01(String(uid || '') + ':hue', 101) - 0.5) * 36;
  return `hsl(${hue.toFixed(1)} 68% 62%)`;
}

function buildImpressionGraphScene(graph) {
  const rawPeople = Array.isArray(graph?.people) ? graph.people.slice() : [];
  rawPeople.sort((a, b) => (Number(b.activeCount) || 0) - (Number(a.activeCount) || 0)
    || String(a.userId || '').localeCompare(String(b.userId || '')));
  const impByUser = new Map();
  for (const imp of Array.isArray(graph?.impressions) ? graph.impressions : []) {
    const uid = String(imp.userId || '');
    if (!impByUser.has(uid)) impByUser.set(uid, []);
    impByUser.get(uid).push(imp);
  }
  const maxEntry = Math.max(1, ...rawPeople.map((p) => Number(p.activeCount) || 0));
  const users = rawPeople.map((p, i) => {
    const uid = String(p.userId || '');
    const base = impressionGraphSphereDir(i, rawPeople.length);
    const jittered = impressionGraphRotateDir(
      base,
      (impressionGraphHash01(uid + ':jy', 7) - 0.5) * 0.55,
      (impressionGraphHash01(uid + ':jp', 11) - 0.5) * 0.45
    );
    const radius = 0.46 + 0.42 * impressionGraphHash01(uid + ':r', 3);
    const activeCount = Number(p.activeCount) || 0;
    const clusterR = 0.055 + 0.16 * Math.cbrt(activeCount / maxEntry);
    return {
      key: `user:${uid}`,
      kind: 'user',
      uid,
      userId: uid,
      chatKeys: Array.isArray(p.chatKeys) ? p.chatKeys : [],
      chatStats: Array.isArray(p.chatStats) ? p.chatStats : [],
      entryCount: activeCount,
      clusterR,
      color: impressionGraphUserColor(uid),
      x: jittered.x * radius,
      y: jittered.y * radius,
      z: jittered.z * radius,
      breathPhase: impressionGraphHash01(`user:${uid}:b`, 53) * Math.PI * 2,
      breathPeriod: 3 + impressionGraphHash01(`user:${uid}:p`, 59) * 4,
      worldR: 0.04
    };
  });
  const AGENT_R = 0.04;
  for (let iter = 0; iter < 30; iter += 1) {
    for (let i = 0; i < users.length; i += 1) {
      for (let j = i + 1; j < users.length; j += 1) {
        const a = users[i];
        const b = users[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dz = b.z - a.z;
        let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) { dx = 1; dy = 0; dz = 0; d = 1; }
        const minD = a.clusterR + b.clusterR + 0.06;
        if (d >= minD) continue;
        const push = (minD - d) / 2;
        dx /= d; dy /= d; dz /= d;
        a.x -= dx * push; a.y -= dy * push; a.z -= dz * push;
        b.x += dx * push; b.y += dy * push; b.z += dz * push;
      }
    }
    for (const u of users) {
      const d = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z) || 1e-6;
      const minD = AGENT_R + u.clusterR + 0.08;
      if (d < minD) {
        const push = minD - d;
        u.x += (u.x / d) * push;
        u.y += (u.y / d) * push;
        u.z += (u.z / d) * push;
      }
    }
    for (const u of users) {
      const d = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z) || 1e-6;
      const minD = AGENT_R + u.clusterR + 0.08;
      const maxD = Math.max(minD, 0.92 - u.clusterR);
      const target = Math.min(maxD, Math.max(minD, d));
      u.x = (u.x / d) * target;
      u.y = (u.y / d) * target;
      u.z = (u.z / d) * target;
    }
  }
  const impressions = [];
  const edges = [];
  const adjacency = new Map();
  const addAdj = (key, edgeKey) => {
    if (!adjacency.has(key)) adjacency.set(key, []);
    adjacency.get(key).push(edgeKey);
  };
  for (const u of users) {
    const key = `edge:agent:${u.uid}`;
    edges.push({ key, kind: 'agent-user', fromKey: 'agent', toKey: u.key, userKey: u.key });
    addAdj('agent', key);
    addAdj(u.key, key);
  }
  for (const u of users) {
    const list = (impByUser.get(u.uid) || []).slice().sort((a, b) =>
      (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
      || String(a.entryId || '').localeCompare(String(b.entryId || '')));
    const lobeCount = 2 + Math.floor(impressionGraphHash01(u.uid + ':lobes', 5) * 3);
    const lobeDirs = [];
    for (let li = 0; li < lobeCount; li += 1) {
      lobeDirs.push(impressionGraphSphereDir(li * 3 + Math.floor(impressionGraphHash01(u.uid + ':ls', 9) * 7), lobeCount * 3 + 1));
    }
    list.forEach((imp, idx) => {
      const entryId = String(imp.entryId || '');
      const dir = lobeDirs[idx % lobeCount];
      const lobeX = u.x + dir.x * u.clusterR * 0.36;
      const lobeY = u.y + dir.y * u.clusterR * 0.36;
      const lobeZ = u.z + dir.z * u.clusterR * 0.36;
      const uu = Math.cbrt(impressionGraphHash01(entryId + ':u', 13));
      const theta = impressionGraphHash01(entryId + ':theta', 17) * Math.PI * 2;
      const phi = Math.acos(2 * impressionGraphHash01(entryId + ':phi', 19) - 1);
      const ax = 0.7 + 0.6 * impressionGraphHash01(entryId + ':ax', 23);
      const ay = 0.7 + 0.6 * impressionGraphHash01(entryId + ':ay', 29);
      const az = 0.7 + 0.6 * impressionGraphHash01(entryId + ':az', 31);
      let px = lobeX + Math.sin(phi) * Math.cos(theta) * uu * u.clusterR * ax;
      let py = lobeY + Math.cos(phi) * uu * u.clusterR * ay;
      let pz = lobeZ + Math.sin(phi) * Math.sin(theta) * uu * u.clusterR * az;
      px += (impressionGraphHash01(entryId + ':jx', 37) - 0.5) * u.clusterR * 0.18;
      py += (impressionGraphHash01(entryId + ':jy', 41) - 0.5) * u.clusterR * 0.18;
      pz += (impressionGraphHash01(entryId + ':jz', 43) - 0.5) * u.clusterR * 0.18;
      let dx = px - u.x;
      let dy = py - u.y;
      let dz = pz - u.z;
      const dd = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const target = Math.min(u.clusterR * 0.98, Math.max(u.clusterR * 0.18, dd));
      px = u.x + (dx / dd) * target;
      py = u.y + (dy / dd) * target;
      pz = u.z + (dz / dd) * target;
      const node = {
        key: `imp:${entryId}`,
        kind: 'impression',
        entryId,
        userId: u.uid,
        uid: u.uid,
        userKey: u.key,
        x: px, y: py, z: pz,
        worldR: 0.0045,
        preview: String(imp.preview || ''),
        previewTruncated: imp.previewTruncated === true,
        breathPhase: impressionGraphHash01(`imp:${entryId}:b`, 53) * Math.PI * 2,
        breathPeriod: 3 + impressionGraphHash01(`imp:${entryId}:p`, 59) * 4,
        createdAt: Number(imp.createdAt) || 0
      };
      impressions.push(node);
      const edgeKey = `edge:user:${u.uid}:${entryId}`;
      edges.push({ key: edgeKey, kind: 'user-impression', fromKey: u.key, toKey: node.key, userKey: u.key });
      addAdj(u.key, edgeKey);
      addAdj(node.key, edgeKey);
    });
  }
  const agentNode = { key: 'agent', kind: 'agent', x: 0, y: 0, z: 0, worldR: AGENT_R };
  const byKey = new Map([['agent', agentNode]]);
  for (const u of users) byKey.set(u.key, u);
  for (const im of impressions) byKey.set(im.key, im);
  return {
    agent: agentNode,
    users,
    impressions,
    edges,
    adjacency,
    byKey,
    total: Number(graph?.total) || impressions.length,
    peopleByUid: new Map(rawPeople.map((p) => [String(p.userId || ''), p]))
  };
}

function layoutImpressionGraph3D(scene, view, width, height) {
  const w = Math.max(1, Number(width) || 0);
  const h = Math.max(1, Number(height) || 0);
  const cx = w / 2;
  const cy = h / 2;
  const baseScale = Math.min(w, h) * 0.42;
  const yaw = Number(view?.yaw) || 0;
  const pitch = Number(view?.pitch) || 0;
  const zoom = Math.min(2.8, Math.max(0.55, Number(view?.zoom) || 1));
  const rot = impressionGraphRotValid(view?.rot) ? view.rot : impressionGraphCameraMatrix(yaw, pitch);
  const r00 = rot[0], r01 = rot[1], r02 = rot[2];
  const r10 = rot[3], r11 = rot[4], r12 = rot[5];
  const r20 = rot[6], r21 = rot[7], r22 = rot[8];
  const projectInto = (n, minR) => {
    const x = Number(n.x) || 0;
    const y = Number(n.y) || 0;
    const z = Number(n.z) || 0;
    const x1 = r00 * x + r01 * y + r02 * z;
    const y2 = r10 * x + r11 * y + r12 * z;
    const z2 = r20 * x + r21 * y + r22 * z;
    const persp = IMPRESSION_GRAPH_FOCAL / (IMPRESSION_GRAPH_FOCAL + z2);
    const k = baseScale * zoom * persp;
    n.sx = cx + x1 * k * IMPRESSION_GRAPH_X_SPREAD;
    n.sy = cy + y2 * k;
    n.sz = z2;
    n.k = k;
    n.sr = Math.max(minR, (Number(n.worldR) || 0) * k);
  };
  projectInto(scene.agent, 7);
  for (const u of scene.users) projectInto(u, 7);
  for (const im of scene.impressions) projectInto(im, 1.2);
  for (const e of scene.edges) {
    e.a = scene.byKey.get(e.fromKey);
    e.b = scene.byKey.get(e.toKey);
  }
  return { agent: scene.agent, users: scene.users, impressions: scene.impressions, edges: scene.edges, map: scene.byKey, width: w, height: h };
}

function impressionGraphScheduleBatched(fn) {
  if (typeof requestIdleCallback === 'function') return requestIdleCallback(fn, { timeout: 800 });
  return setTimeout(() => fn(null), 0);
}

function impressionGraphRunBatched(tasks, done) {
  let index = 0;
  const step = (deadline) => {
    const t0 = Date.now();
    const hasBudget = () => (deadline && typeof deadline.timeRemaining === 'function'
      ? deadline.timeRemaining() > 2
      : (Date.now() - t0) < 8);
    try {
      while (index < tasks.length && hasBudget()) {
        const task = tasks[index];
        index += 1;
        task();
      }
    } catch {
      impressionGraphSpritesFailed = true;
      index = tasks.length;
    }
    if (index < tasks.length) impressionGraphScheduleBatched(step);
    else done();
  };
  impressionGraphScheduleBatched(step);
}

function ensureImpressionGraphSpriteStore() {
  if (!impressionGraphSprites) {
    impressionGraphSprites = { agentStar: null, stars: new Map(), fogs: new Map() };
  }
  return impressionGraphSprites;
}

function impressionGraphMakeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function impressionGraphPaintGlow(g, size, color) {
  try {
    const c = size / 2;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.22, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  } catch {
    try { g.fillStyle = color; g.fillRect(0, 0, size, size); } catch { /* ignore */ }
  }
}

function impressionGraphTriggerReadyRender() {
  if (!impressionGraphBaseSpritesReady || !impressionGraphSceneSpritesReady) return;
  if (MEM_UI.impression.mode === 'graph' && memPageVisible('mem-impression')) {
    renderImpressionGraph();
    ensureImpressionGraphLoop();
  }
}

function preheatImpressionGraphBaseSprites() {
  if (impressionGraphBaseSpritesReady || impressionGraphBaseSpritesPreparing || impressionGraphSpritesFailed) return;
  impressionGraphBaseSpritesPreparing = true;
  const store = ensureImpressionGraphSpriteStore();
  const tasks = [];
  tasks.push(() => {
    store.agentStar = impressionGraphMakeCanvas(64);
    impressionGraphPaintGlow(store.agentStar.getContext('2d'), 64, 'rgba(255,198,92,0.95)');
  });
  impressionGraphRunBatched(tasks, () => {
    impressionGraphBaseSpritesPreparing = false;
    impressionGraphBaseSpritesReady = true;
    if (impressionGraphPendingPeople) preheatImpressionGraphSceneSprites(impressionGraphPendingPeople);
    else impressionGraphTriggerReadyRender();
  });
}

function preheatImpressionGraphSceneSprites(people) {
  const list = Array.isArray(people) ? people : [];
  impressionGraphPendingPeople = list;
  if (impressionGraphSpritesFailed) return;
  if (!impressionGraphBaseSpritesReady) return;
  const store = ensureImpressionGraphSpriteStore();
  const uids = [...new Set(list.map((p) => String(p.userId || '')).filter(Boolean))];
  const uidSet = new Set(uids);
  const token = ++impressionGraphScenePreheatToken;
  impressionGraphSceneSpritesReady = false;
  const prune = () => {
    for (const k of [...store.stars.keys()]) if (!uidSet.has(k)) store.stars.delete(k);
    for (const k of [...store.fogs.keys()]) if (!uidSet.has(k)) store.fogs.delete(k);
  };
  const missingStars = uids.filter((uid) => !store.stars.has(uid));
  const missingFogs = uids.filter((uid) => !store.fogs.has(uid));
  if (!missingStars.length && !missingFogs.length) {
    prune();
    impressionGraphSceneSpritesReady = true;
    impressionGraphPendingPeople = null;
    impressionGraphTriggerReadyRender();
    return;
  }
  impressionGraphSceneSpritesPreparing = true;
  const tasks = [];
  for (const uid of missingStars) {
    tasks.push(() => {
      if (token !== impressionGraphScenePreheatToken) return;
      const sprite = impressionGraphMakeCanvas(64);
      impressionGraphPaintGlow(sprite.getContext('2d'), 64, impressionGraphUserColor(uid));
      store.stars.set(uid, sprite);
    });
  }
  for (const uid of missingFogs) {
    tasks.push(() => {
      if (token !== impressionGraphScenePreheatToken) return;
      const sprite = impressionGraphMakeCanvas(96);
      impressionGraphPaintGlow(sprite.getContext('2d'), 96, impressionGraphUserColor(uid));
      store.fogs.set(uid, sprite);
    });
  }
  impressionGraphRunBatched(tasks, () => {
    if (token !== impressionGraphScenePreheatToken) return;
    prune();
    impressionGraphSceneSpritesPreparing = false;
    impressionGraphSceneSpritesReady = true;
    impressionGraphPendingPeople = null;
    impressionGraphTriggerReadyRender();
  });
}

function preheatImpressionGraphSprites() {
  if (impressionGraphSpritesFailed) return;
  preheatImpressionGraphBaseSprites();
  const people = MEM_UI.impression.graph?.people;
  if (Array.isArray(people)) preheatImpressionGraphSceneSprites(people);
}

function impressionGraphStarSprite(uid) {
  return impressionGraphSprites?.stars?.get(String(uid)) || null;
}

function impressionGraphFogSprite(uid) {
  return impressionGraphSprites?.fogs?.get(String(uid)) || null;
}

function impressionGraphBreath(node, t) {
  if (impressionGraphReducedMotion) return 1;
  if (!node || impressionGraphHoverKey === node.key) return 1;
  if (node.kind === 'user' && MEM_UI.impression.graphSelectedKey === node.key) return 1;
  const phase = Number(node.breathPhase) || 0;
  const period = Number(node.breathPeriod) || 5;
  return 1 + 0.02 * Math.sin(t * ((Math.PI * 2) / period) + phase);
}

function drawImpressionGraphBackground(ctx, proj) {
  const w = proj.width;
  const h = proj.height;
  const key = `${w}x${h}`;
  if (!impressionGraphBackgroundGradient || impressionGraphBackgroundGradientKey !== key) {
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.hypot(w, h) / 2;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, IMPRESSION_GRAPH_CENTER);
    gradient.addColorStop(0.58, '#050810');
    gradient.addColorStop(1, IMPRESSION_GRAPH_DEEP);
    impressionGraphBackgroundGradient = gradient;
    impressionGraphBackgroundGradientKey = key;
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = impressionGraphBackgroundGradient;
  ctx.fillRect(0, 0, w, h);
}

function drawImpressionGraphLight(ctx, proj) {
  const w = proj.width;
  const h = proj.height;
  const radius = Math.hypot(w, h) * 0.46;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 6);
  ctx.scale(1, 1 / 15);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
  gradient.addColorStop(0, 'rgba(170,198,255,0.10)');
  gradient.addColorStop(0.35, 'rgba(120,150,230,0.05)');
  gradient.addColorStop(1, 'rgba(80,100,180,0)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = gradient;
  ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
  ctx.restore();

  const glowRadius = Math.min(w, h) * 0.11;
  const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, glowRadius);
  glow.addColorStop(0, 'rgba(255,209,102,0.08)');
  glow.addColorStop(0.45, 'rgba(255,190,80,0.035)');
  glow.addColorStop(1, 'rgba(180,130,40,0)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = glow;
  ctx.fillRect(w / 2 - glowRadius, h / 2 - glowRadius, glowRadius * 2, glowRadius * 2);
}

function impressionGraphDrawLine(ctx, a, b, alpha, width) {
  if (!a || !b) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#8fa7ff';
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(b.sx, b.sy);
  ctx.stroke();
}

function drawImpressionGraphEdges(ctx, proj) {
  const hover = impressionGraphHoverKey;
  const last = impressionGraphLastHoverKey;
  const focus = hover || last;
  const map = proj.map;
  const parentKeyOf = (key) => {
    const node = map.get(key);
    return node ? node.userKey : '';
  };
  for (const edge of proj.edges) {
    if (edge.kind !== 'agent-user') continue;
    if (!impressionGraphReplayVisible(edge.b)) continue;
    let alpha = 0.055;
    let width = 0.7;
    if (hover === 'agent') { alpha = 0.65; width = 1.2; }
    else if (hover && hover.startsWith('user:') && edge.toKey === hover) { alpha = 0.65; width = 1.2; }
    else if (hover && hover.startsWith('imp:') && edge.toKey === parentKeyOf(hover)) { alpha = 0.45; width = 1.0; }
    else if (!hover && last && last.startsWith('user:') && edge.toKey === last) { alpha = 0.02; width = 0.6; }
    else if (!hover && last && last.startsWith('imp:') && edge.toKey === parentKeyOf(last)) { alpha = 0.02; width = 0.6; }
    impressionGraphDrawLine(ctx, edge.a, edge.b, alpha, width);
  }
  const drawUserImpressions = (userKey, alpha, width) => {
    if (!impressionGraphReplayVisible(map.get(userKey))) return;
    for (const edge of proj.edges) {
      if (edge.kind === 'user-impression' && edge.userKey === userKey && impressionGraphReplayVisible(edge.b)) {
        impressionGraphDrawLine(ctx, edge.a, edge.b, alpha, width);
      }
    }
  };
  if (hover && hover.startsWith('user:') && impressionGraphReplayVisible(map.get(hover))) {
    drawUserImpressions(hover, 0.5, 1.0);
  } else if (hover && hover.startsWith('imp:')) {
    const edge = proj.edges.find((e) => e.toKey === hover);
    if (edge && impressionGraphReplayVisible(edge.b)) impressionGraphDrawLine(ctx, edge.a, edge.b, 0.7, 1.2);
  } else if (!hover && last && last.startsWith('user:') && impressionGraphReplayVisible(map.get(last))) {
    drawUserImpressions(last, 0.02, 0.6);
  } else if (!hover && last && last.startsWith('imp:')) {
    const edge = proj.edges.find((e) => e.toKey === last);
    if (edge && impressionGraphReplayVisible(edge.b)) impressionGraphDrawLine(ctx, edge.a, edge.b, 0.02, 0.6);
  }
  ctx.globalAlpha = 1;
}

function impressionGraphNodeVisible(proj, node, margin = 60) {
  return node.sx >= -margin && node.sx <= proj.width + margin
    && node.sy >= -margin && node.sy <= proj.height + margin;
}

function drawImpressionGraphNodes(ctx, proj, sprites, t) {
  const hover = impressionGraphHoverKey;
  const hoverUser = hover.startsWith('user:') ? hover : '';
  const hoverImp = hover.startsWith('imp:') ? hover : '';
  const dimOthers = hoverImp ? 0.42 : hoverUser ? 0.35 : 1;
  const selectedKey = String(MEM_UI.impression.graphSelectedKey || '');
  const parentUid = hoverImp ? String(proj.map.get(hoverImp)?.userId || '') : '';
  // 雾光是背景层，先画（不参与节点深度顺序）
  for (const u of proj.users) {
    if (!impressionGraphReplayVisible(u)) continue;
    const fog = impressionGraphFogSprite(u.uid);
    if (!fog) continue;
    const fogW = Math.max(48, u.clusterR * 2 * u.k);
    const alpha = (hoverUser && u.key !== hoverUser ? dimOthers : 1) * 0.16;
    ctx.globalAlpha = Math.max(0.02, alpha);
    ctx.drawImage(fog, u.sx - fogW / 2, u.sy - fogW / 2, fogW, fogW);
  }
  // 用户 / 印象 / Agent 合并按深度从远到近绘制
  impressionGraphDrawList.length = 0;
  for (const u of proj.users) if (impressionGraphReplayVisible(u)) impressionGraphDrawList.push(u);
  for (const im of proj.impressions) if (impressionGraphReplayVisible(im)) impressionGraphDrawList.push(im);
  impressionGraphDrawList.push(proj.agent);
  impressionGraphDrawList.sort((a, b) => b.sz - a.sz);
  for (const node of impressionGraphDrawList) {
    if (!node || !impressionGraphNodeVisible(proj, node)) continue;
    if (node.kind === 'impression') {
      const im = node;
      const related = !hover || (hoverImp && im.key === hoverImp)
        || (hoverUser && im.userKey === hoverUser)
        || (hoverImp && im.userId === parentUid);
      const alpha = Math.max(0.25, 1 - (im.sz + 1) * 0.12) * (related ? 1 : dimOthers);
      const r = im.sr * ((hoverImp === im.key || hoverUser === im.userKey) ? 1.4 : 1) * impressionGraphBreath(im, t);
      const sprite = impressionGraphStarSprite(im.uid);
      if (!sprite) continue;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(sprite, im.sx - r, im.sy - r, 2 * r, 2 * r);
      continue;
    }
    if (node.kind === 'user') {
      const u = node;
      const isHover = hoverUser === u.key;
      const keep = !hover || hover === 'agent' || isHover || (hoverImp && u.uid === parentUid);
      const alpha = keep ? 1 : dimOthers;
      const r = u.sr * (isHover ? 1.12 : 1) * impressionGraphBreath(u, t);
      const sprite = impressionGraphStarSprite(u.uid);
      if (!sprite) continue;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, u.sx - r, u.sy - r, 2 * r, 2 * r);
      continue;
    }
    const agent = node;
    const ar = Math.max(7, agent.sr);
    ctx.globalAlpha = 1;
    ctx.drawImage(sprites.agentStar, agent.sx - ar, agent.sy - ar, ar * 2, ar * 2);
  }
}

function impressionGraphPersonNick(row, uid) {
  const info = memPersonName(row || { userId: uid, chatKeys: [] });
  let nick = String(info.qqNick || '');
  if (!nick) {
    const label = String(info.label || '');
    const suffix = `（${uid}）`;
    nick = label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
  }
  nick = nick.trim();
  if (nick === `QQ ${uid}`) nick = '';
  const chars = Array.from(nick);
  return chars.length > 10 ? `${chars.slice(0, 10).join('')}…` : nick;
}

function impressionGraphFrameGeometry(node) {
  if (!node) return null;
  const half = node.kind === 'agent'
    ? Math.max(12, node.sr + 6)
    : node.kind === 'user' ? Math.max(12, node.sr + 6) : Math.max(7, node.sr + 4);
  return { half, arm: Math.max(4, half * 0.45) };
}

function drawImpressionGraphSelectionFrame(ctx, proj) {
  const key = String(MEM_UI.impression.graphSelectedKey || '');
  if (!key) return;
  const node = proj.map.get(key);
  if (!impressionGraphReplayVisible(node)) return;
  const geo = impressionGraphFrameGeometry(node);
  if (!node || !geo) return;
  const { half, arm } = geo;
  const x = node.sx;
  const y = node.sy;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - half, y - half + arm); ctx.lineTo(x - half, y - half); ctx.lineTo(x - half + arm, y - half);
  ctx.moveTo(x + half - arm, y - half); ctx.lineTo(x + half, y - half); ctx.lineTo(x + half, y - half + arm);
  ctx.moveTo(x + half, y + half - arm); ctx.lineTo(x + half, y + half); ctx.lineTo(x + half - arm, y + half);
  ctx.moveTo(x - half + arm, y + half); ctx.lineTo(x - half, y + half); ctx.lineTo(x - half, y + half - arm);
  ctx.stroke();
  ctx.restore();
}

function drawImpressionGraphLabels(ctx, proj) {
  const st = MEM_UI.impression;
  const hover = impressionGraphHoverKey;
  const selectedKey = String(st.graphSelectedKey || '');
  for (const u of proj.users) {
    if (!impressionGraphReplayVisible(u)) continue;
    if (hover !== u.key && selectedKey !== `user:${u.uid}`) continue;
    const row = impressionGraphScene?.peopleByUid?.get(u.uid);
    const nick = impressionGraphPersonNick(row, u.uid);
    const lines = nick ? [nick, `QQ ${u.uid}`] : [`QQ ${u.uid}`];
    ctx.globalAlpha = 0.95;
    ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      const y = u.sy + u.sr + 8 + i * 13;
      ctx.strokeStyle = 'rgba(5,10,22,.85)';
      ctx.lineWidth = 3;
      ctx.strokeText(line, u.sx, y);
      ctx.fillStyle = '#e6ecff';
      ctx.fillText(line, u.sx, y);
    });
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

function impressionGraphApplyPendingDrag() {
  const drag = impressionGraphDragging;
  if (!drag || !drag.dirty) return;
  drag.dirty = false;
  const st = MEM_UI.impression;
  const dx = drag.clientX - drag.startX;
  const dy = drag.clientY - drag.startY;
  const screenYaw = impressionGraphScreenRotY(-dx * 0.006);
  const screenPitch = impressionGraphScreenRotX(dy * 0.005);
  st.graphView.rot = impressionGraphMatMul(screenPitch, impressionGraphMatMul(screenYaw, drag.rot));
  const yawSign = Math.cos(drag.pitch) < 0 ? -1 : 1;
  const pitchSign = Math.cos(drag.yaw) < 0 ? -1 : 1;
  st.graphView.yaw = drag.yaw - dx * 0.006 * yawSign;
  st.graphView.pitch = drag.pitch + dy * 0.005 * pitchSign;
}

function drawImpressionGraph(now = 0) {
  const st = MEM_UI.impression;
  const canvas = impressionGraphCanvas || document.getElementById('impression-graph-canvas');
  if (!canvas) return;
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch { ctx = null; }
  if (!ctx) return;
  impressionGraphApplyPendingDrag();
  let cssW = 0;
  let cssH = 0;
  const cached = impressionGraphSizeCacheLive ? impressionGraphCanvasSize : null;
  if (cached && cached.w >= 40 && cached.h >= 40) {
    cssW = cached.w;
    cssH = cached.h;
  } else {
    const rect = canvas.getBoundingClientRect();
    cssW = Number(rect?.width) || 0;
    cssH = Number(rect?.height) || 0;
    if (impressionGraphSizeCacheLive && cssW >= 40 && cssH >= 40) impressionGraphCanvasSize = { w: cssW, h: cssH };
  }
  if (cssW < 40 || cssH < 40) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!st.graph) return;
  if (!impressionGraphScene) impressionGraphScene = buildImpressionGraphScene(st.graph);
  const proj = layoutImpressionGraph3D(impressionGraphScene, st.graphView, cssW, cssH);
  impressionGraphProjection = proj;
  if (!impressionGraphBaseSpritesReady || !impressionGraphSceneSpritesReady || !impressionGraphSprites) return;
  const sprites = impressionGraphSprites;
  const clock = now > 0 ? now : (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t = clock / 1000;
  drawImpressionGraphBackground(ctx, proj);
  drawImpressionGraphLight(ctx, proj);
  drawImpressionGraphEdges(ctx, proj);
  drawImpressionGraphNodes(ctx, proj, sprites, t);
  drawImpressionGraphSelectionFrame(ctx, proj);
  drawImpressionGraphLabels(ctx, proj);
}

function impressionGraphHitAt(x, y) {
  const proj = impressionGraphProjection;
  if (!proj || !impressionGraphDrawList.length) return null;
  const selectedKey = String(MEM_UI.impression.graphSelectedKey || '');
  // drawList 已按 sz 从远到近排序；反向遍历即最近优先，与绘制层级一致。
  for (let i = impressionGraphDrawList.length - 1; i >= 0; i -= 1) {
    const node = impressionGraphDrawList[i];
    if (!node || !impressionGraphNodeVisible(proj, node) || !impressionGraphReplayVisible(node)) continue;
    const d = Math.hypot(x - node.sx, y - node.sy);
    const geo = selectedKey === node.key ? impressionGraphFrameGeometry(node) : null;
    const hitR = Math.max(6, node.sr + 3, geo ? Math.hypot(geo.half + geo.arm, geo.half + geo.arm) + 2 : 0);
    if (d <= hitR) return node;
  }
  return null;
}

function impressionGraphShowTip(tip, wrap, node, x, y) {
  const st = MEM_UI.impression;
  if (node.kind === 'agent') {
    const n = Array.isArray(st.graph?.people) ? st.graph.people.length : 0;
    const total = Number(st.graph?.total) || 0;
    tip.textContent = `Agent · ${n} 人 · ${total} 条有效印象`;
  } else if (node.kind === 'user') {
    const row = impressionGraphScene?.peopleByUid?.get(node.uid);
    const nick = impressionGraphPersonNick(row, node.uid);
    const lines = [];
    if (nick) lines.push(nick);
    lines.push(`QQ ${node.uid}`);
    lines.push(`${Number(node.entryCount) || 0} 条有效印象`);
    tip.textContent = lines.join('\n');
  } else if (node.kind === 'impression') {
    tip.textContent = `${node.preview}${node.previewTruncated ? '…' : ''}`;
  } else {
    tip.textContent = '';
  }
  tip.hidden = false;
  const wrapW = wrap.clientWidth || 0;
  const wrapH = wrap.clientHeight || 0;
  const tw = tip.offsetWidth || 0;
  const th = tip.offsetHeight || 0;
  let left = x + 12;
  let top = y + 12;
  if (wrapW && tw) left = Math.min(left, Math.max(0, wrapW - tw - 4));
  if (wrapH && th) top = Math.min(top, Math.max(0, wrapH - th - 4));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function impressionGraphHideTip(tip) {
  if (tip && tip.hidden !== true) tip.hidden = true;
}

function impressionGraphApplyZoom(next) {
  const st = MEM_UI.impression;
  const zoom = Math.min(2.8, Math.max(0.55, Number(next) || 1));
  if (zoom === st.graphView.zoom) return;
  st.graphView.zoom = zoom;
  impressionGraphQueueZoomSave(zoom);
  impressionGraphHideTip(document.getElementById('impression-graph-tip'));
  impressionGraphRequestDraw();
}

function resetImpressionGraphView() {
  const st = MEM_UI.impression;
  st.graphView = { ...IMPRESSION_GRAPH_DEFAULT };
  impressionGraphCancelZoomSave();
  impressionGraphClearZoom();
  impressionGraphHideTip(document.getElementById('impression-graph-tip'));
  drawImpressionGraph();
}

function impressionGraphRequestDraw() {
  if (impressionGraphRaf) return;
  if (impressionGraphDrawRaf) return;
  if (typeof requestAnimationFrame !== 'function') { drawImpressionGraph(); return; }
  impressionGraphDrawRaf = requestAnimationFrame((now) => {
    impressionGraphDrawRaf = 0;
    drawImpressionGraph(now);
  });
}

function impressionGraphUpdatePointer(e) {
  const drag = impressionGraphDragging;
  if (!drag) return false;
  drag.clientX = e.clientX;
  drag.clientY = e.clientY;
  drag.dirty = true;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
    drag.moved = true;
    impressionGraphHoverKey = '';
    impressionGraphLastHoverKey = '';
  }
  impressionGraphRequestDraw();
  return true;
}

function bindImpressionGraphCanvas(canvas, wrap, tip) {
  const localPoint = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const supportsPointerCapture = typeof window.PointerEvent === 'function'
    && typeof canvas.setPointerCapture === 'function';
  const startDrag = (e) => {
    const st = MEM_UI.impression;
    const startRot = impressionGraphRotValid(st.graphView.rot)
      ? st.graphView.rot.slice()
      : impressionGraphCameraMatrix(st.graphView.yaw, st.graphView.pitch);
    impressionGraphDragging = {
      startX: e.clientX,
      startY: e.clientY,
      clientX: e.clientX,
      clientY: e.clientY,
      yaw: Number(st.graphView.yaw) || 0,
      pitch: Number(st.graphView.pitch) || 0,
      rot: startRot,
      pointerId: supportsPointerCapture ? e.pointerId : null,
      moved: false,
      dirty: false
    };
    impressionGraphSuppressClick = false;
    impressionGraphHideTip(tip);
    canvas.classList.add('is-dragging');
  };
  const finishDrag = () => {
    if (!impressionGraphDragging) return;
    impressionGraphApplyPendingDrag();
    const drag = impressionGraphDragging;
    impressionGraphDragging = null;
    canvas.classList.remove('is-dragging');
    if (drag.pointerId != null) {
      try { canvas.releasePointerCapture(drag.pointerId); } catch { /* ignore */ }
    }
    if (drag.moved === true) {
      impressionGraphSuppressClick = true;
      impressionGraphSuppressDblClick = true;
      setTimeout(() => { impressionGraphSuppressDblClick = false; }, 350);
    }
    canvas.style.cursor = 'default';
    impressionGraphRequestDraw();
  };
  if (supportsPointerCapture) {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      startDrag(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (impressionGraphDragging) impressionGraphUpdatePointer(e);
    });
    canvas.addEventListener('pointerup', finishDrag);
    canvas.addEventListener('pointercancel', finishDrag);
    canvas.addEventListener('lostpointercapture', finishDrag);
  } else {
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      startDrag(e);
    });
  }
  canvas.addEventListener('mouseup', finishDrag);
  canvas.addEventListener('mousemove', (e) => {
    if (impressionGraphDragging) {
      if (!supportsPointerCapture) impressionGraphUpdatePointer(e);
      return;
    }
    const pt = localPoint(e);
    const node = impressionGraphHitAt(pt.x, pt.y);
    if (node) {
      impressionGraphHoverKey = node.key;
      impressionGraphLastHoverKey = node.key;
      canvas.style.cursor = 'pointer';
      impressionGraphShowTip(tip, wrap, node, pt.x, pt.y);
    } else {
      impressionGraphHoverKey = '';
      canvas.style.cursor = 'default';
      impressionGraphHideTip(tip);
    }
    impressionGraphRequestDraw();
  });
  canvas.addEventListener('mouseleave', () => {
    if (impressionGraphDragging && supportsPointerCapture) return;
    finishDrag();
    impressionGraphHoverKey = '';
    impressionGraphHideTip(tip);
    canvas.style.cursor = 'default';
    impressionGraphRequestDraw();
  });
  canvas.addEventListener('click', (e) => {
    if (impressionGraphSuppressClick) {
      impressionGraphSuppressClick = false;
      return;
    }
    const pt = localPoint(e);
    const node = impressionGraphHitAt(pt.x, pt.y);
    if (!node) { clearImpressionSelection(); return; }
    selectImpressionGraphNode(node);
  });
  canvas.addEventListener('dblclick', (e) => {
    if (impressionGraphSuppressDblClick) {
      impressionGraphSuppressDblClick = false;
      return;
    }
    const pt = localPoint(e);
    const node = impressionGraphHitAt(pt.x, pt.y);
    if (!node || node.kind === 'agent') return;
    openImpressionGraphNode(node);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const st = MEM_UI.impression;
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    impressionGraphApplyZoom((Number(st.graphView.zoom) || 1) * factor);
  }, { passive: false });
}

function ensureImpressionGraphObserver(wrap) {
  if (impressionGraphResizeObserver) {
    impressionGraphResizeObserver.disconnect();
    impressionGraphResizeObserver = null;
  }
  if (typeof ResizeObserver !== 'function') {
    impressionGraphSizeCacheLive = false;
    impressionGraphCanvasSize = null;
    return;
  }
  impressionGraphResizeObserver = new ResizeObserver((entries) => {
    const box = entries && entries[0] && entries[0].contentRect;
    const w = Number(box?.width) || 0;
    const h = Number(box?.height) || 0;
    impressionGraphCanvasSize = w >= 40 && h >= 40 ? { w, h } : null;
    drawImpressionGraph();
  });
  impressionGraphSizeCacheLive = true;
  impressionGraphResizeObserver.observe(wrap);
}

function stopImpressionGraphLoop() {
  if (impressionGraphRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(impressionGraphRaf);
  impressionGraphRaf = 0;
}

function ensureImpressionGraphLoop() {
  if (impressionGraphRaf) return;
  if (impressionGraphReducedMotion) return;
  if (typeof requestAnimationFrame !== 'function') return;
  if (MEM_UI.impression.mode !== 'graph') return;
  if (!memPageVisible('mem-impression')) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (!impressionGraphCanvas) return;
  impressionGraphLastTs = 0;
  impressionGraphLastPaint = 0;
  impressionGraphRaf = requestAnimationFrame(impressionGraphTick);
}

function impressionGraphTick(now) {
  impressionGraphRaf = 0;
  const st = MEM_UI.impression;
  if (st.mode !== 'graph' || !memPageVisible('mem-impression')) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (!impressionGraphCanvas) return;
  if (now - impressionGraphLastPaint < IMPRESSION_GRAPH_FRAME_MS - 1) {
    impressionGraphRaf = requestAnimationFrame(impressionGraphTick);
    return;
  }
  if (!impressionGraphHoverKey && !impressionGraphDragging) {
    const step = 0.012 * dtSeconds(now);
    if (impressionGraphRotValid(st.graphView.rot)) {
      st.graphView.rot = impressionGraphMatMul(impressionGraphScreenRotY(step), st.graphView.rot);
    }
    st.graphView.yaw += step;
  }
  drawImpressionGraph(now);
  impressionGraphLastPaint = now;
  impressionGraphRaf = requestAnimationFrame(impressionGraphTick);
}

function dtSeconds(now) {
  const dt = impressionGraphLastTs ? Math.min(0.1, (now - impressionGraphLastTs) / 1000) : 0;
  impressionGraphLastTs = now;
  return dt;
}

function teardownImpressionGraph() {
  impressionGraphCancelReplay({ restore: false, reason: 'teardown' });
  impressionGraphFlushZoomSave();
  stopImpressionGraphLoop();
  if (impressionGraphResizeObserver) {
    impressionGraphResizeObserver.disconnect();
    impressionGraphResizeObserver = null;
  }
  impressionGraphCanvas = null;
  impressionGraphScene = null;
  impressionGraphProjection = null;
  impressionGraphHoverKey = '';
  impressionGraphLastHoverKey = '';
  impressionGraphDragging = null;
  impressionGraphSuppressClick = false;
  impressionGraphSuppressDblClick = false;
  if (impressionGraphDrawRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(impressionGraphDrawRaf);
  impressionGraphDrawRaf = 0;
  impressionGraphLastPaint = 0;
  impressionGraphCanvasSize = null;
  impressionGraphSizeCacheLive = false;
  impressionGraphBackgroundGradient = null;
  impressionGraphBackgroundGradientKey = '';
  MEM_UI.impression.pendingEntryId = '';
  const tip = document.getElementById('impression-graph-tip');
  impressionGraphHideTip(tip);
}

function loadImpressionGraphData({ force = false } = {}) {
  const st = MEM_UI.impression;
  if (force && impressionGraphReplay.active) {
    impressionGraphCancelReplay({ restore: true, reason: 'refresh' });
  }
  if (st.graph && !force) {
    if (!impressionGraphScene) impressionGraphScene = buildImpressionGraphScene(st.graph);
    return;
  }
  const token = ++st.graphSeq;
  st.graphLoading = true;
  st.graphError = '';
  renderImpressionGraph();
  api('/api/mem2/graph')
    .then((data) => {
      if (token !== st.graphSeq) return;
      st.graph = data;
      if (impressionGraphReplay.active) impressionGraphCancelReplay({ restore: false, reason: 'scene' });
      impressionGraphScene = buildImpressionGraphScene(data);
      impressionGraphHoverKey = '';
      impressionGraphLastHoverKey = '';
      st.graphError = '';
      validateImpressionSelectionAgainstGraph();
      preheatImpressionGraphSceneSprites(data.people);
    })
    .catch((error) => {
      if (token !== st.graphSeq) return;
      st.graphError = `读取星图数据失败：${error.message}`;
    })
    .finally(() => {
      if (token !== st.graphSeq) return;
      st.graphLoading = false;
      renderImpressionGraph();
    });
}

function impressionGraphHeadHtml(n, m) {
  return `
    <div class="mem2-graph-head">
      <span class="mem2-graph-title">记忆星图</span>
      <span class="mem2-graph-summary">${n} 人 · ${m} 条有效印象</span>
      <span class="muted">全量显示，不受群筛选/搜索影响</span>
      <span class="mem2-graph-legend">
        <span class="mem2-graph-dot agent"></span>Agent
        <span class="mem2-graph-dot user"></span>人物
        <span class="mem2-graph-dot imp"></span>印象
      </span>
    </div>`;
}

function renderImpressionGraph() {
  if (!memPageVisible('mem-impression')) return;
  if (MEM_UI.impression.mode !== 'graph') return;
  const st = MEM_UI.impression;
  const body = document.getElementById('impression-body');
  if (!body) return;
  const errBlocks = [st.graphError, st.error, st.chatsError].filter(Boolean).map((m) => memErrorBlock(m)).join('');
  if (errBlocks && impressionGraphReplay.active) {
    impressionGraphCancelReplay({ restore: false, reason: 'error' });
  }
  const graph = st.graph;
  if (!graph) {
    if (impressionGraphReplay.active) impressionGraphCancelReplay({ restore: false, reason: 'render' });
    teardownImpressionGraph();
    if (st.graphLoading) {
      body.innerHTML = errBlocks + impressionGraphHeadHtml(0, 0) + '<div class="empty-hint">读取中…</div>';
    } else if (errBlocks) {
      body.innerHTML = errBlocks + '<div class="empty-hint">星图数据不可用，可切回列表查看人物。</div>';
    } else {
      body.innerHTML = '<div class="empty-hint">当前没有有效印象（等 L1 提炼跑一轮）</div>';
    }
    return;
  }
  const n = Array.isArray(graph.people) ? graph.people.length : 0;
  const total = Number(graph.total) || 0;
  if (!total) {
    if (impressionGraphReplay.active) impressionGraphCancelReplay({ restore: false, reason: 'render' });
    teardownImpressionGraph();
    body.innerHTML = errBlocks + '<div class="empty-hint">当前没有有效印象（等 L1 提炼跑一轮）</div>';
    return;
  }
  if (impressionGraphSpritesFailed) {
    if (impressionGraphReplay.active) impressionGraphCancelReplay({ restore: false, reason: 'render' });
    teardownImpressionGraph();
    body.innerHTML = errBlocks + memErrorBlock('星图贴图初始化失败，请刷新页面或切回列表。');
    return;
  }
  if (!impressionGraphBaseSpritesReady || !impressionGraphSceneSpritesReady) {
    if (impressionGraphReplay.active) impressionGraphCancelReplay({ restore: false, reason: 'render' });
    preheatImpressionGraphSprites();
    teardownImpressionGraph();
    body.innerHTML = errBlocks + impressionGraphHeadHtml(n, total) + '<div class="empty-hint">准备中…</div>';
    return;
  }
  if (!impressionGraphScene) impressionGraphScene = buildImpressionGraphScene(graph);
  if (!errBlocks
    && body.querySelector('#impression-graph-canvas')
    && !body.querySelector('.mem2-error')) {
    const canvas = body.querySelector('#impression-graph-canvas');
    const summary = body.querySelector('.mem2-graph-summary');
    if (summary) summary.textContent = `${n} 人 · ${total} 条有效印象`;
    canvas.setAttribute('aria-label', `记忆星图：${n} 人，共 ${total} 条有效印象`);
    drawImpressionGraph();
    ensureImpressionGraphLoop();
    return;
  }
  if (impressionGraphReplay.active) impressionGraphCancelReplay({ restore: false, reason: 'render' });
  teardownImpressionGraph();
  body.innerHTML = errBlocks + impressionGraphHeadHtml(n, total) + `
    <div class="mem2-graph-wrap" id="impression-graph-wrap">
      <canvas id="impression-graph-canvas" class="mem2-graph-canvas"
              role="img" aria-label="记忆星图：${n} 人，共 ${total} 条有效印象"></canvas>
      <div class="mem2-graph-tip" id="impression-graph-tip" hidden></div>
      <div class="mem2-graph-controls">
        <button class="mem2-graph-btn" id="impression-graph-zoom-out" aria-label="缩小星图" title="缩小">−</button>
        <button class="mem2-graph-btn" id="impression-graph-reset" aria-label="重置星图视角" title="重置">⟲</button>
        <button class="mem2-graph-btn" id="impression-graph-zoom-in" aria-label="放大星图" title="放大">＋</button>
      </div>
      <button id="impression-graph-recall" class="mem2-graph-recall" type="button"
              aria-label="回顾星图加载过程">
        <span class="mem2-graph-recall-spinner" aria-hidden="true"></span>
        <span class="mem2-graph-recall-label" aria-live="polite">回顾</span>
      </button>
      <div class="mem2-graph-hint">拖拽旋转 · 滚轮缩放 · 悬停查看</div>
    </div>`;
  const canvas = body.querySelector('#impression-graph-canvas');
  const wrap = body.querySelector('#impression-graph-wrap');
  const tip = body.querySelector('#impression-graph-tip');
  if (!canvas || !wrap || !tip) {
    if (impressionGraphReplay.active) impressionGraphCancelReplay({ restore: false, reason: 'render' });
    teardownImpressionGraph();
    return;
  }
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch { ctx = null; }
  if (!ctx) {
    body.innerHTML = errBlocks + '<div class="mem2-graph-fallback">当前环境不支持 Canvas 绘制，请切回列表查看人物。</div>';
    if (impressionGraphReplay.active) impressionGraphCancelReplay({ restore: false, reason: 'render' });
    teardownImpressionGraph();
    return;
  }
  impressionGraphCanvas = canvas;
  bindImpressionGraphCanvas(canvas, wrap, tip);
  ensureImpressionGraphObserver(wrap);
  drawImpressionGraph();
  ensureImpressionGraphLoop();
}

function impressionConsumePendingEntryFocus() {
  const st = MEM_UI.impression;
  const entryId = st.pendingEntryId;
  if (!entryId) return;
  st.pendingEntryId = '';
  let card = null;
  try {
    card = document.querySelector(`#impression-body [data-entry="${CSS.escape(String(entryId))}"]`);
  } catch { card = null; }
  if (!card) return;
  try { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
  card.classList.add('is-graph-focus');
  setTimeout(() => card.classList.remove('is-graph-focus'), 1500);
}

// ── 印象页数据加载（令牌：成功 / 失败 / finally 三处校验）────────────────

async function loadImpressionPeople() {
  const st = MEM_UI.impression;
  const q = String(st.q || '').trim();
  const token = ++MEM_UI.impression.peopleSeq;
  try {
    // ① 始终先拉当前群筛选下的完整人物列表
    const base = await api(`/api/mem2/people?chat=${encodeURIComponent(st.chat)}`);
    if (token !== MEM_UI.impression.peopleSeq) return;
    st.basePeople = base.people || [];

    // ② q 非空时再拉一次内容命中 id（身份昵称命中在前端算）
    let hitIds = new Set();
    if (q) {
      const d2 = await api(`/api/mem2/people?chat=${encodeURIComponent(st.chat)}&q=${encodeURIComponent(q)}`);
      if (token !== MEM_UI.impression.peopleSeq) return;
      hitIds = new Set((d2.people || []).map((p) => p.userId));
    }
    st.contentHitIds = hitIds;
    st.peopleLoaded = true;
    st.error = '';
  } catch (error) {
    if (token !== MEM_UI.impression.peopleSeq) return;
    st.error = `读取人物列表失败：${error.message}`;
  } finally {
    if (token === MEM_UI.impression.peopleSeq) {
      applyImpressionFilter();
      validateImpressionSelectionAgainstGraph();
      renderImpressionPeople();
      renderImpressionDetail();
      refreshImpressionChatOptions();   // ★ LR-03：人物落地后补一次群下拉（只增不减）
      loadImpressionIdentity();          // 异步补昵称；回来后自己重绘左栏
    }
  }
}

/** 内容命中 ∪ 身份命中（QQ号 / QQ昵称 / 群名片 / 群名）。roster 未到也能先按 QQ号 命中。 */
function applyImpressionFilter() {
  const st = MEM_UI.impression;
  const q = String(st.q || '').trim().toLowerCase();
  if (!q) { st.people = st.basePeople.slice(); return; }
  st.people = st.basePeople.filter((p) => {
    if (st.contentHitIds.has(p.userId)) return true;
    if (String(p.userId).toLowerCase().includes(q)) return true;
    for (const k of p.chatKeys || []) {
      const m = memIdentityOf(k)?.byUid?.get(String(p.userId));
      if (m) {
        if (String(m.nickname || '').toLowerCase().includes(q)) return true;
        if (String(m.card || '').toLowerCase().includes(q)) return true;
      }
      const cn = String(chatNameOf(k) || '').toLowerCase();
      if (cn && cn.includes(q)) return true;
    }
    return false;
  });
}

function impressionSyncListSelection(uid) {
  const id = String(uid || '');
  for (const row of document.querySelectorAll('#impression-items [data-uid]')) {
    row.classList.toggle('selected', id !== '' && row.dataset.uid === id);
  }
}

function selectImpressionPersonOnly(uid) {
  const st = MEM_UI.impression;
  const id = String(uid || '').trim();
  if (!id) return;
  st.selectedUserId = id;
  st.graphSelectedKey = `user:${id}`;
  impressionSyncListSelection(id);
  if (st.mode === 'graph') impressionGraphRequestDraw();
  else if (!st.person && !st.personLoading) renderImpressionDetail();
}

function selectImpressionGraphNode(node) {
  const st = MEM_UI.impression;
  if (!node) return;
  if (node.kind === 'agent') {
    st.graphSelectedKey = 'agent';
    impressionGraphRequestDraw();
    return;
  }
  if (node.kind === 'user') { selectImpressionPersonOnly(node.uid); return; }
  if (node.kind !== 'impression') return;
  st.selectedUserId = String(node.userId || '');
  st.graphSelectedKey = node.key;
  impressionSyncListSelection(st.selectedUserId);
  impressionGraphRequestDraw();
}

function clearImpressionSelection() {
  const st = MEM_UI.impression;
  st.selectedUserId = '';
  st.graphSelectedKey = '';
  st.detailUserId = '';
  st.person = null;
  st.personLoading = false;
  st.pendingEntryId = '';
  st.editing = '';
  st.purgeArm = '';
  st.error = '';
  ++st.detailSeq;
  impressionSyncListSelection('');
  if (st.mode === 'graph') impressionGraphRequestDraw();
  else renderImpressionDetail();
}

function openImpressionGraphNode(node) {
  const st = MEM_UI.impression;
  if (!node || node.kind === 'agent') return;
  if (node.kind === 'user') {
    setImpressionMode('list');
    st.graphSelectedKey = `user:${node.uid}`;
    loadImpressionDetail(node.uid, { select: true });
    return;
  }
  if (node.kind !== 'impression') return;
  const entryId = String(node.entryId || '');
  const parentUid = String(node.userId || '');
  setImpressionMode('list');
  st.pendingEntryId = entryId;
  st.graphSelectedKey = `imp:${entryId}`;
  loadImpressionDetail(parentUid, { select: true });
}

function openImpressionPersonFromList(uid) {
  const st = MEM_UI.impression;
  const id = String(uid || '').trim();
  if (!id) return;
  if (st.mode === 'graph') setImpressionMode('list');
  st.graphSelectedKey = `user:${id}`;
  loadImpressionDetail(id, { select: true });
}

function validateImpressionSelectionAgainstGraph() {
  const st = MEM_UI.impression;
  const graph = st.graph;
  if (!graph) return;
  const uids = new Set((graph.people || []).map((p) => String(p.userId)));
  const entries = new Set((graph.impressions || []).map((i) => String(i.entryId)));
  if (st.selectedUserId && !uids.has(String(st.selectedUserId))) {
    st.selectedUserId = '';
    st.graphSelectedKey = '';
    impressionSyncListSelection('');
  } else if (st.graphSelectedKey.startsWith('imp:') && !entries.has(st.graphSelectedKey.slice(4))) {
    st.graphSelectedKey = '';
  }
  if (st.detailUserId && !uids.has(String(st.detailUserId))) {
    st.detailUserId = '';
    st.person = null;
    st.personLoading = false;
    st.pendingEntryId = '';
    ++st.detailSeq;
  }
}

function loadImpressionDetail(uid, { select = false } = {}) {
  const st = MEM_UI.impression;
  const id = String(uid || '').trim();
  if (!id) return;
  const token = ++MEM_UI.impression.detailSeq;
  st.detailUserId = id;
  st.person = null;
  st.personLoading = true;
  if (select) {
    st.selectedUserId = id;
    st.editing = '';
    st.purgeArm = '';
  }
  renderImpressionDetail();
  api(`/api/mem2/people/${encodeURIComponent(id)}?all=${st.showAll ? 1 : 0}`)
    .then((d) => {
      if (token !== MEM_UI.impression.detailSeq) return;
      st.person = d;
      st.error = '';
    })
    .catch((error) => {
      if (token !== MEM_UI.impression.detailSeq) return;
      const msg = String(error?.message || error);
      st.error = `读取 ${id} 的画像失败：${msg}`;
      st.pendingEntryId = '';
      if (/404|没有这个人|找不到/.test(msg)) {
        st.detailUserId = '';
        st.person = null;
      }
    })
    .finally(() => {
      if (token !== MEM_UI.impression.detailSeq) return;
      st.personLoading = false;
      renderImpressionDetail();
    });
}

/** 删除审计（全局计数，不随选中人物变化）。失败静默保留旧值。 */
function loadImpressionDeletionCount() {
  const st = MEM_UI.impression;
  const token = ++MEM_UI.impression.deletionSeq;
  api('/api/mem2/deletions')
    .then((d) => {
      if (token !== MEM_UI.impression.deletionSeq) return;
      st.deletionCount = Number(d?.count) || 0;
    })
    .catch(() => { /* 静默保留旧值 */ })
    .finally(() => {
      if (token !== MEM_UI.impression.deletionSeq) return;
      renderImpressionDeletionCount();
    });
}

function renderImpressionDeletionCount() {
  const el = document.getElementById('impression-deletion-count');
  if (!el) return;
  const n = Number(MEM_UI.impression.deletionCount) || 0;
  el.hidden = !n;
  el.textContent = n ? `删除审计 ${n} 条` : '';
}

/** IM-19：刷新只重画内容，不重建骨架、不清群筛选与搜索词。 */
function refreshImpressionPage() {
  const st = MEM_UI.impression;
  st.error = '';
  st.chatsError = '';                  // ★ LR-04：刷新开始即清错
  st.editing = '';
  st.purgeArm = '';
  updateImpressionGraphToggle();
  if (st.mode === 'graph') loadImpressionGraphData({ force: true });
  loadImpressionPeople();
  loadImpressionDeletionCount();
  ensureChats()
    .then(() => {
      st.chatsError = '';
      refreshImpressionChatOptions();
      renderImpressionDetail();
    })
    .catch((err) => { onImpressionChatsFailed(err); });   // ★ LR-04：刷新失败也要显示，不静默
  if (st.detailUserId && (st.person || st.personLoading)) loadImpressionDetail(st.detailUserId, { select: false });
}

async function saveImpressionEntry(entryId, button) {
  const st = MEM_UI.impression;
  const ta = document.querySelector(`[data-edit-for="${CSS.escape(String(entryId))}"]`);
  const content = String(ta?.value || '').trim();
  if (!content) {
    st.error = '内容不能为空';
    renderImpressionDetail();
    return;
  }
  if (button) button.disabled = true;
  try {
    // 只送 content —— 多送一个字段后端就 400（那是契约，不是意外）
    await api(`/api/mem2/entries/${encodeURIComponent(entryId)}`, {
      method: 'PATCH', body: JSON.stringify({ content })
    });
    st.editing = '';
    st.error = '';
    if (st.detailUserId) loadImpressionDetail(st.detailUserId, { select: false });
  } catch (error) {
    st.error = `保存失败：${error.message}`;
    if (button) button.disabled = false;
    renderImpressionDetail();
  }
}

async function setImpressionEntryStatus(entryId, undo) {
  const st = MEM_UI.impression;
  try {
    await api(`/api/mem2/entries/${encodeURIComponent(entryId)}/void`, {
      method: 'POST', body: JSON.stringify(undo ? { undo: true } : {})
    });
    st.error = '';
    if (st.detailUserId) loadImpressionDetail(st.detailUserId, { select: false });
  } catch (error) {
    st.error = `${undo ? '撤销' : '删除'}失败：${error.message}`;
    renderImpressionDetail();
  }
}

async function purgeImpressionEntry(entryId, button) {
  const st = MEM_UI.impression;
  if (button) button.disabled = true;
  try {
    await api(`/api/mem2/entries/${encodeURIComponent(entryId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'DELETE', reason: '用户在记忆库彻底删除' })
    });
    st.purgeArm = '';
    st.error = '';
    if (st.detailUserId) loadImpressionDetail(st.detailUserId, { select: false });   // 删完刷新，条目消失
    loadImpressionDeletionCount();             // 顶栏审计数立即刷新（不等下次进入）
  } catch (error) {
    st.error = `彻底删除失败：${error.message}`;
    if (button) button.disabled = false;
    renderImpressionDetail();
  }
}

/**
 * 跳到存档页并高亮那一条。
 * 两条失败分支都弹模态：此时用户已在存档页，写回印象页的 error 永远看不到（D3）。
 */
function jumpToSource(chatKey, mid) {
  if (!chatKey || !mid) {
    showNoticeModal('跳原文', '缺少来源会话或消息 id，无法定位原文。');
    return;
  }
  try { switchTab('chats'); } catch { /* ignore */ }
  selectChat(chatKey)
    .then(async () => {
      // switchTab('chats') 会顺带触发 loadChats()，它回调里又发一次消息请求并顶掉
      // selectChat 这次请求的序号 —— selectChat 先 resolve，但表格要等后一次回包才落地。
      // 所以不能查一次就判"找不到"，给行几秒钟落地的窗口。
      const sel = `#chat-detail tr[data-mid="${CSS.escape(String(mid))}"]`;
      let row = document.querySelector(sel);
      for (let i = 0; i < 30 && !row; i++) {
        await new Promise((r) => setTimeout(r, 100));
        row = document.querySelector(sel);
      }
      if (!row) {
        showNoticeModal('跳原文', `原始消息 ${mid} 不在当前已加载的消息范围内（可能被保留策略清理，或不在首屏）。`);
        return;
      }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('mem2-hit');
      setTimeout(() => row.classList.remove('mem2-hit'), 2400);
    })
    .catch((error) => {
      showNoticeModal('跳原文', `跳转失败：${error.message}`);
    });
}

// ══════════════════════════════════════════════════════════════════════════
// 摘要页
// ══════════════════════════════════════════════════════════════════════════

function ensureSummariesChat() {
  const st = MEM_UI.summaries;
  const list = memChatEntries();
  if (!st.chat || !list.includes(st.chat)) {
    st.chat = list[0] || '';
    st.data = null;
    st.error = '';
    st.loading = false;
    ++st.seq;
  }
  return st.chat;
}

function loadSummariesPage() {
  const st = MEM_UI.summaries;
  st.error = '';
  st.chatsError = '';
  if (!(state.chats || []).length) st.loading = true;
  renderSummariesChrome();
  renderSummariesList();
  renderSummariesBody();
  ensureChats()
    .then(() => {
      st.chatsError = '';
      st.loading = false;
      ensureSummariesChat();
      renderSummariesList();
      if (!st.chat) { st.data = null; renderSummariesBody(); return; }
      if (st.data) { renderSummariesBody(); return; }
      loadSummariesTable();
    })
    .catch((err) => {
      st.loading = false;
      st.chatsError = `读取会话列表失败：${err.message}`;
      // ★ LR-05：摘要页同构修复。
      st.chat = '';
      st.data = null;
      st.error = '';
      ++st.seq;
      renderSummariesList();
      renderSummariesBody();
    });
}

function renderSummariesChrome() {
  const el = document.getElementById('summaries-month');
  if (el) el.value = MEM_UI.summaries.ym || memYmNow();
}

function renderSummariesList() {
  const st = MEM_UI.summaries;
  const items = document.getElementById('summaries-items');
  const countEl = document.getElementById('summaries-count');
  const list = memChatEntries();
  if (countEl) countEl.textContent = `摘要 · ${list.length} 个会话`;
  if (!items) return;
  const top = items.scrollTop;
  if (list.length) items.innerHTML = list.map((k) => memChatRow(k, k === st.chat)).join('');
  else if (st.chatsError) items.innerHTML = memErrorBlock(st.chatsError);
  else if (st.loading) items.innerHTML = '<div class="empty-hint">读取中…</div>';
  else items.innerHTML = '<div class="empty-hint">还没有任何会话数据</div>';
  items.scrollTop = top;
}

/** 右栏头部：会话名 + 副信息（月份选择器是静态工具条，不在这里重建）。 */
function memTableHeader(chatKey) {
  const sub = memChatSub(chatKey);
  return `<div class="detail-header">
      <h2>${esc(memChatName(chatKey))}</h2>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
    </div>`;
}

function renderSummariesBody() {
  const st = MEM_UI.summaries;
  const body = document.getElementById('summaries-body');
  if (!body) return;
  if (!st.chat) {
    body.innerHTML = st.chatsError
      ? memErrorBlock(st.chatsError)
      : (st.loading
        ? '<div class="empty-hint">读取中…</div>'
        : '<div class="empty-hint">还没有任何会话数据</div>');
    return;
  }
  const head = memTableHeader(st.chat);
  if (st.loading) { body.innerHTML = head + '<div class="empty-hint">读取中…</div>'; return; }
  if (st.error && !st.data) { body.innerHTML = head + memErrorBlock(st.error); return; }
  if (!st.data) { body.innerHTML = head + '<div class="empty-hint">读取中…</div>'; return; }
  body.innerHTML = head + memL4Table(st.data);
}

function loadSummariesTable() {
  const st = MEM_UI.summaries;
  const chat = st.chat;
  // ★ LR-01：令牌在最前递增，缓存命中/无 chat 早退都不能让旧在途响应复活。
  const token = ++MEM_UI.summaries.seq;
  if (!chat) {
    st.data = null;
    st.loading = false;
    renderSummariesBody();
    return;
  }
  const ym = st.ym || memYmNow();
  const ck = `${chat}|${ym}`;
  if (st.cache[ck]) {
    st.data = st.cache[ck];
    st.loading = false;
    st.error = '';
    renderSummariesBody();
    return;
  }
  st.loading = true;
  st.error = '';
  st.data = null;
  renderSummariesBody();
  api(`/api/mem2/l4?chat=${encodeURIComponent(chat)}&ym=${encodeURIComponent(ym)}`)
    .then((d) => {
      if (token !== MEM_UI.summaries.seq) return;
      st.cache[ck] = d;
      st.data = d;
      st.error = '';
    })
    .catch((error) => {
      if (token !== MEM_UI.summaries.seq) return;
      st.error = `读取摘要失败：${error.message}`;
    })
    .finally(() => {
      if (token !== MEM_UI.summaries.seq) return;
      st.loading = false;
      renderSummariesBody();
    });
}

// ══════════════════════════════════════════════════════════════════════════
// 知识页
// ══════════════════════════════════════════════════════════════════════════

function loadKnowledgePage() {
  const st = MEM_UI.knowledge;
  st.error = '';
  renderKnowledgeAll();
  if (!st.data) loadKnowledge();     // KN-07：已有数据直接渲染，不重复请求
}

function renderKnowledgeAll() {
  renderKnowledgeList();
  renderKnowledgeBody();
}

function renderKnowledgeList() {
  const st = MEM_UI.knowledge;
  const items = document.getElementById('knowledge-items');
  if (!items) return;
  const n = Array.isArray(st.data?.entries) ? st.data.entries.length : 0;
  items.innerHTML = `
    <div class="chat-item selected">
      <div class="chat-item-title"><span class="session-chat">L3 知识</span></div>
      <div class="chat-item-sub">${n} 条 · 来源：搜索 + 纠正</div>
    </div>`;
}

function renderKnowledgeBody() {
  const st = MEM_UI.knowledge;
  const body = document.getElementById('knowledge-body');
  if (!body) return;
  const head = '<div class="detail-header"><h2>L3 知识</h2><div class="sub"><span>来源：搜索 + 纠正</span></div></div>';
  if (st.error) { body.innerHTML = head + memErrorBlock(st.error); return; }
  if (st.loading || !st.data) { body.innerHTML = head + '<div class="empty-hint">读取中…</div>'; return; }
  const entries = Array.isArray(st.data.entries) ? st.data.entries : [];
  if (!entries.length) {
    body.innerHTML = head + `<div class="mem2-note">${esc(st.data.note || '知识库目前是空的 —— 这是正确的状态，不是故障。')}</div>`;
    return;
  }
  body.innerHTML = head + entries.map((e) => `
    <div class="mem2-card">
      <div class="mem2-card-body">${esc(e.content || e.entryId || '')}</div>
      <div class="mem2-card-foot">
        <span class="muted">${esc([e.domain, e.term].filter(Boolean).join(' · '))}</span>
      </div>
    </div>`).join('');
}

function loadKnowledge() {
  const st = MEM_UI.knowledge;
  const token = ++MEM_UI.knowledge.seq;
  st.loading = true;
  st.error = '';
  renderKnowledgeAll();
  api('/api/mem2/knowledge')
    .then((d) => {
      if (token !== MEM_UI.knowledge.seq) return;
      st.data = d;
      st.error = '';
    })
    .catch((error) => {
      if (token !== MEM_UI.knowledge.seq) return;
      st.error = `读取知识失败：${error.message}`;
    })
    .finally(() => {
      if (token !== MEM_UI.knowledge.seq) return;
      st.loading = false;
      renderKnowledgeAll();
    });
}

// ══════════════════════════════════════════════════════════════════════════
// 表格渲染
// ══════════════════════════════════════════════════════════════════════════

function memL4Table(d) {
  // 临时修复：L4 是追加写，回填旧会话会排在实时会话之后，显示层按会话起点倒序。
  const list = [...(d.summaries || [])].sort((a, b) =>
    (Number(b?.convStartTs) || 0) - (Number(a?.convStartTs) || 0));
  const rows = list.map((r) => `
    <tr><td>${fmtTime(r.convStartTs)}</td><td>${esc(r.summary || '')}</td>
      <td class="num">${r.sparse ? 'sparse' : ''}</td></tr>`).join('');
  return `<div class="mem2-table-head">${esc(d.ym)} · ${Number(d.count) || 0} 条摘要</div>
    <table class="mem2-table"><thead><tr><th>会话起点</th><th>摘要</th><th>稀疏</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="empty-hint">这个月没有摘要</td></tr>'}</tbody></table>`;
}

function refreshSummariesPage() {
  const st = MEM_UI.summaries;
  st.cache = Object.create(null);
  st.data = null;
  st.error = '';
  st.chatsError = '';
  renderSummariesList();
  if (st.chat) { loadSummariesTable(); return; }
  ensureChats()
    .then(() => {
      st.chatsError = '';
      st.loading = false;
      ensureSummariesChat();
      renderSummariesList();
      if (st.chat) loadSummariesTable(); else renderSummariesBody();
    })
    .catch((err) => {
      st.loading = false;
      st.chatsError = `读取会话列表失败：${err.message}`;
      renderSummariesList();
      renderSummariesBody();
    });
}

// ══════════════════════════════════════════════════════════════════════════
// 事件委托：三个页面根各绑一次（骨架静态常驻，绑一次就够）
// ══════════════════════════════════════════════════════════════════════════

let memPagesBound = false;

function bindMemPagesOnce() {
  if (memPagesBound) return;

  const imp = document.getElementById('view-mem-impression');
  const kn = document.getElementById('view-mem-knowledge');
  const sm = document.getElementById('view-mem-summaries');

  if (imp) {
    imp.addEventListener('change', (e) => {
      if (e.target.id !== 'impression-chat') return;
      MEM_UI.impression.chat = e.target.value || '';
      loadImpressionPeople();
    });

    imp.addEventListener('input', (e) => {
      if (e.target.id !== 'impression-q') return;
      const st = MEM_UI.impression;
      clearTimeout(st.qTimer);
      const value = e.target.value || '';
      // 防抖：人物列表可能上百人，每敲一个字都打一次接口没必要
      st.qTimer = setTimeout(() => { st.q = value; loadImpressionPeople(); }, 250);
    });

    imp.addEventListener('click', (e) => {
      const st = MEM_UI.impression;
      if (e.target.closest('#impression-refresh')) { refreshImpressionPage(); return; }
      if (e.target.closest('#impression-graph-toggle')) {
        setImpressionMode(st.mode === 'graph' ? 'list' : 'graph');
        return;
      }
      if (e.target.closest('#impression-graph-zoom-out')) {
        impressionGraphApplyZoom((Number(st.graphView.zoom) || 1) * 0.85);
        return;
      }
      if (e.target.closest('#impression-graph-zoom-in')) {
        impressionGraphApplyZoom((Number(st.graphView.zoom) || 1) * 1.18);
        return;
      }
      if (e.target.closest('#impression-graph-reset')) {
        resetImpressionGraphView();
        return;
      }
      if (e.target.closest('#impression-graph-recall')) {
        impressionGraphStartReplay();
        return;
      }

      const personEl = e.target.closest('[data-uid]');
      if (personEl) {
        selectImpressionPersonOnly(personEl.dataset.uid);
        return;
      }

      if (e.target.closest('[data-showall]')) {
        st.showAll = !st.showAll;
        if (st.detailUserId) loadImpressionDetail(st.detailUserId, { select: false });
        return;
      }
      const editBtn = e.target.closest('[data-edit]');
      if (editBtn) { st.editing = editBtn.dataset.edit; renderImpressionDetail(); return; }
      const cancelBtn = e.target.closest('[data-cancel]');
      if (cancelBtn) { st.editing = ''; renderImpressionDetail(); return; }
      const saveBtn = e.target.closest('[data-save]');
      if (saveBtn) { saveImpressionEntry(saveBtn.dataset.save, saveBtn); return; }
      const voidBtn = e.target.closest('[data-void]');
      if (voidBtn) { setImpressionEntryStatus(voidBtn.dataset.void, false); return; }
      const undoBtn = e.target.closest('[data-undo]');
      if (undoBtn) { setImpressionEntryStatus(undoBtn.dataset.undo, true); return; }
      const purge1 = e.target.closest('[data-purge1]');
      if (purge1) { st.purgeArm = purge1.dataset.purge1; renderImpressionDetail(); return; }
      const purge2 = e.target.closest('[data-purge2]');
      if (purge2) { purgeImpressionEntry(purge2.dataset.purge2, purge2); return; }
      const jump = e.target.closest('[data-jump]');
      if (jump) {
        const parts = String(jump.dataset.jump || '').split('|');
        jumpToSource(parts[0], parts.slice(1).join('|'));
        return;
      }
      if (e.target.closest('#impression-list')
        && !e.target.closest('.list-head, .list-filter, .list-resizer, #impression-items .chat-item')) {
        clearImpressionSelection();
      }
    });

    imp.addEventListener('dblclick', (e) => {
      const personEl = e.target.closest('[data-uid]');
      if (!personEl) return;
      openImpressionPersonFromList(personEl.dataset.uid);
    });
  }

  if (kn) {
    kn.addEventListener('click', (e) => {
      if (e.target.closest('#knowledge-refresh')) loadKnowledge();
    });
  }

  if (sm) {
    sm.addEventListener('change', (e) => {
      if (e.target.id !== 'summaries-month') return;
      const st = MEM_UI.summaries;
      st.ym = e.target.value || '';
      for (const k of Object.keys(st.cache)) if (k.startsWith(`${st.chat}|`)) delete st.cache[k];
      st.data = null;
      loadSummariesTable();
    });
    sm.addEventListener('click', (e) => {
      if (e.target.closest('#summaries-refresh')) { refreshSummariesPage(); return; }
      const row = e.target.closest('[data-chatkey]');
      if (!row) return;
      const st = MEM_UI.summaries;
      const key = row.dataset.chatkey;
      if (st.chat === key) return;
      st.chat = key;
      st.data = null;
      st.error = '';
      renderSummariesList();
      renderSummariesBody();
      loadSummariesTable();
    });
  }

  memPagesBound = true;
  preheatImpressionGraphSprites();
  document.addEventListener('visibilitychange', () => {
    const st = MEM_UI.impression;
    if (document.hidden) {
      impressionGraphCancelReplay({ restore: false, reason: 'hidden' });
      impressionGraphFlushZoomSave();
      stopImpressionGraphLoop();
    } else if (st.mode === 'graph' && memPageVisible('mem-impression')) {
      ensureImpressionGraphLoop();
      impressionGraphRequestDraw();
    }
  });
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('blur', () => impressionGraphFlushZoomSave());
  }
}

bindMemPagesOnce();
