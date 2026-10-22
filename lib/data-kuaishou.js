'use strict';
/**
 * 快手创作者中心（cp.kuaishou.com）数据抓取（V9.3）。
 * 2026-10-15 实测：
 *   - 接口全部带 __NS_sig3 签名，页面外重放返回 500002「请稍后重试」，所以只能嗅探页面自己发出的请求；
 *   - 作品管理页 /article/manage/video?status=1：POST /rest/cp/works/v2/video/pc/photo/list
 *     每条 {publishId, workId, title(=作品描述), playCount, likeCount, commentCount, uploadTime(发布时刻 ms), durationSecond, publishStatus…}，
 *     翻页要滚动列表让页面自己发下一页；没有分享数和完播率
 *   - 数据中心 /statistics/works：POST /rest/cp/creator/analysis/pc/author/overview（近 7 天逐日：播放/点赞/净增粉丝/完播率/评论/分享/作品量，次日 12 点更新）
 *   - 个人信息 POST /rest/cp/creator/pc/home/infoV2：fansCnt / likeCnt（作品管理页也会发）
 *   - 作品分析 /statistics/article：POST /rest/cp/creator/analysis/pc/photo/list（只列公开作品；账号里还没有公开作品时拿不到结构，
 *     所以分享数/完播率按常见字段名尽量取，取到什么用什么，原始样本写进 raw 里，第一批真数据出来后再对照字段）
 *
 * 可用环境变量 KUAISHOU_SINCE=YYYY-MM-DD 只记录某天起发布的作品（账号里更早的内容不想进快照/看板时用），默认全部记录。
 */
const { waitCapture, findCapture, parseJsonSafe, needLoginError, sleep, shot } = require('./data-capture');

const KUAISHOU_SINCE = process.env.KUAISHOU_SINCE || '1970-01-01';
const MANAGE_URL = 'https://cp.kuaishou.com/article/manage/video?status=1';
const OVERVIEW_URL = 'https://cp.kuaishou.com/statistics/works';
const ANALYSIS_URL = 'https://cp.kuaishou.com/statistics/article';

/**
 * 嗅探页面自己发出的 JSON 接口。不用 data-capture 的 attachCapture：它在响应回调里不等 resp.text()，
 * 快手这边拿到的响应内容全是空的（2026-10-15 实测）；这里在回调里直接 await 取回内容，取到了才记录。
 */
function attachKsCapture(page) {
  const captures = [];
  page.on('response', async (resp) => {
    try {
      const req = resp.request();
      const rt = req.resourceType();
      if ((rt !== 'xhr' && rt !== 'fetch') || !/cp\.kuaishou\.com\/rest/.test(resp.url())) return;
      const body = await resp.text();
      captures.push({ url: resp.url(), method: req.method(), status: resp.status(), postData: req.postData(), body });
    } catch {}
  });
  return captures;
}

function num(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pick(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = num(obj[k]);
    if (v !== null) return v;
  }
  return null;
}

function p2(n) { return String(n).padStart(2, '0'); }

function fmtDateTime(ms) {
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 'YYYY-MM-DD' → 当天 00:00（本地时间）的毫秒数 */
function sinceMs(since = KUAISHOU_SINCE) {
  return new Date(`${since}T00:00:00`).getTime();
}

function workLink(workId) {
  return workId ? `https://www.kuaishou.com/short-video/${workId}` : '';
}

/** 作品管理页列表条目 → 归一化作品；定时还没到点的（待发布）返回 null */
function normListItem(it, now = Date.now()) {
  if (!it || typeof it !== 'object') return null;
  const t = num(it.uploadTime);
  if (!t) return null;
  if (Number(it.publishStatus) === 1 && t > now) return null; // 待发布
  const id = String(it.workId || it.publishId || '');
  if (!id) return null;
  return {
    id,
    title: String(it.title || '').trim() || '(无标题)',
    publishTime: fmtDateTime(t),
    play: num(it.playCount),
    like: num(it.likeCount),
    comment: num(it.commentCount),
    share: null,
    favorite: null,
    coin: null,
    danmaku: null,
    completion: null,
    bounce: null,
    link: workLink(it.workId),
    extra: { 视频时长秒: num(it.durationSecond), 状态: it.publishStatus === 4 ? '已发布' : `状态${it.publishStatus}` },
  };
}

/** 数据中心「核心数据趋势」→ { rows:[{日期,播放量,…}], latest:{指标:最近一天值} }；只留 since 之后的日期 */
function normOverview(basicData, since = KUAISHOU_SINCE) {
  const byDate = new Map();
  const latest = {};
  for (const b of basicData || []) {
    if (!b || !b.name) continue;
    latest[b.name] = num(b.endDayCount);
    for (const o of b.trendData || []) {
      const m = String(o.date || '').match(/^(\d{4})(\d{2})(\d{2})$/);
      if (!m) continue;
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      if (date < since) continue;
      if (!byDate.has(date)) byDate.set(date, {});
      byDate.get(date)[b.name] = num(o.count);
    }
  }
  const rows = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([日期, vals]) => ({ 日期, ...vals }));
  return { rows, latest };
}

/** 作品分析页列表条目里的分享/完播（字段名未经真数据验证，按常见名取） */
const SHARE_KEYS = ['shareCount', 'shareCnt', 'forwardCount', 'share'];
const COMPLETE_KEYS = ['completeRatio', 'completeRate', 'completionRate', 'finishRatio', 'playFinishRatio'];
const ID_KEYS = ['workId', 'photoIdStr', 'photoId', 'publishId', 'id'];

/** 作品分析接口的作品数组：data.photoList / data.list 可能直接是数组，也可能再包一层对象（2026-10-21 实测 data.list 不是数组） */
function analysisList(data) {
  if (!data || typeof data !== 'object') return [];
  for (const v of [data.photoList, data.list, data.data]) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const inner = Object.values(v).find(Array.isArray);
      if (inner) return inner;
    }
  }
  return [];
}

function mergeAnalysis(works, items) {
  let merged = 0;
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    const ids = ID_KEYS.map((k) => (it[k] === undefined || it[k] === null ? '' : String(it[k]))).filter(Boolean);
    const w = works.find((x) => ids.includes(x.id));
    if (!w) continue;
    const share = pick(it, SHARE_KEYS);
    let completion = pick(it, COMPLETE_KEYS);
    if (completion !== null && completion > 1) completion = completion / 100; // 百分数 → 0~1
    if (share !== null) w.share = share;
    if (completion !== null) w.completion = completion;
    if (share !== null || completion !== null) merged++;
  }
  return merged;
}

async function scrollList(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight > el.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
    }
    window.scrollTo(0, document.body.scrollHeight);
  }).catch(() => {});
  await page.mouse.wheel(0, 5000).catch(() => {});
}

function listItemsOf(captures, from = 0) {
  const out = [];
  let more = false;
  for (const c of captures.slice(from)) {
    if (!/photo\/list/.test(c.url) || !/works\/v2\/video/.test(c.url) || !c.body) continue;
    try {
      const j = parseJsonSafe(c.body);
      if (j && j.result === 1 && j.data && Array.isArray(j.data.list)) {
        out.push(...j.data.list);
        more = !!(j.data.nextCursor && Number(j.data.nextCursor) > 0 && j.data.list.length);
      }
    } catch {}
  }
  return { items: out, more };
}

async function fetchKuaishouData(page, log = () => {}) {
  const captures = attachKsCapture(page);
  const since = KUAISHOU_SINCE;
  const sinceT = sinceMs(since);
  log(`打开快手作品管理页${since > '1970-01-01' ? `（只记录 ${since} 起发布的作品）` : ''}…`);
  try {
    await page.goto(MANAGE_URL, { waitUntil: 'commit', timeout: 120000 });
  } catch (e) {
    if (!/ERR_ABORTED/.test(e.message)) throw e;
    await sleep(1500);
    await page.goto(MANAGE_URL, { waitUntil: 'commit', timeout: 120000 }).catch(() => {});
  }
  await sleep(3000);
  const bad = () => !page.url().includes('cp.kuaishou.com') || /passport|login/.test(page.url());
  if (bad()) {
    await shot(page, 'data-kuaishou-need-login');
    throw needLoginError('快手');
  }
  const first = await waitCapture(captures, 'works/v2/video/pc/photo/list', 30000, { minLen: 50 });
  if (bad()) {
    await shot(page, 'data-kuaishou-need-login');
    throw needLoginError('快手');
  }
  if (!first) {
    await shot(page, 'data-kuaishou-manage');
    throw new Error('快手作品管理页没有发出作品列表请求（页面结构可能改版，截图 logs/data-kuaishou-manage.png）');
  }

  // —— 作品：滚动到最早一条早于起始日（或没有下一页）为止 ——
  const byId = new Map();
  const absorb = () => {
    const { items, more } = listItemsOf(captures);
    for (const it of items) byId.set(String(it.workId || it.publishId), it);
    return { more, oldest: items.length ? Math.min(...items.map((x) => num(x.uploadTime) || Infinity)) : Infinity };
  };
  let st = absorb();
  for (let s = 0; s < 40 && st.more && st.oldest >= sinceT; s++) {
    const before = byId.size;
    await scrollList(page);
    await sleep(1500);
    st = absorb();
    if (byId.size === before) {
      await sleep(2500);
      st = absorb();
      if (byId.size === before) break;
    }
  }
  const now = Date.now();
  const works = [];
  let skippedOld = 0;
  for (const it of byId.values()) {
    if ((num(it.uploadTime) || 0) < sinceT) { skippedOld++; continue; }
    const w = normListItem(it, now);
    if (w) works.push(w);
  }
  works.sort((a, b) => String(b.publishTime).localeCompare(String(a.publishTime)));
  log(`作品列表：读到 ${byId.size} 条，起始日之前 ${skippedOld} 条不记录，${since} 起已发布 ${works.length} 条`);

  // 账号信息（作品管理页同时发的 infoV2）
  let profile = null;
  const info = findCapture(captures, 'pc/home/infoV2');
  if (info && info.json && info.json.data) profile = info.json.data;

  // —— 作品分析页：分享/完播（只在已经有作品时才去，省一次页面加载） ——
  let analysisSample = null;
  if (works.length) {
    try {
      await page.goto(ANALYSIS_URL, { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
      const hit = await waitCapture(captures, 'analysis/pc/photo/list', 20000, { minLen: 30 });
      if (hit) {
        const list = analysisList(hit.json && hit.json.data);
        analysisSample = { count: list.length, first: list.slice(0, 2), keys: Object.keys((hit.json && hit.json.data) || {}) };
        const n = mergeAnalysis(works, list);
        log(`作品分析页：${list.length} 条，补上分享/完播 ${n} 条`);
      } else {
        log('作品分析页没有返回列表（账号暂无公开作品或次日才更新），分享数/完播率本次留空');
      }
    } catch (e) {
      log(`作品分析页读取失败（不影响播放/点赞/评论）：${e.message.split('\n')[0]}`);
    }
  }

  // —— 账号总览 + 趋势（数据中心） ——
  let overview = [];
  let trend = [];
  let overviewRaw = null;
  try {
    await page.goto(OVERVIEW_URL, { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
    const hit = await waitCapture(captures, 'analysis/pc/author/overview', 25000, { minLen: 50 });
    if (hit && hit.json && hit.json.data) {
      overviewRaw = hit.json.data;
      const n = normOverview(hit.json.data.basicData, since);
      trend = n.rows;
      for (const [name, v] of Object.entries(n.latest)) overview.push({ 指标: `昨日${name}`, 值: v, 备注: hit.json.data.dataUpdateTime ? `数据更新至 ${hit.json.data.dataUpdateTime}` : '' });
      if (!profile) {
        const i2 = findCapture(captures, 'pc/home/infoV2');
        if (i2 && i2.json && i2.json.data) profile = i2.json.data;
      }
    } else {
      log('数据中心没有返回账号趋势，本次只有作品数据');
    }
  } catch (e) {
    log(`账号总览获取失败（不影响作品数据）：${e.message.split('\n')[0]}`);
  }
  if (profile) {
    overview.unshift({ 指标: '粉丝数', 值: num(profile.fansCnt), 备注: '' });
    overview.splice(1, 0, { 指标: '累计获赞', 值: num(profile.likeCnt), 备注: '账号总数，含之前发的内容' });
  }

  log(`快手数据完成：作品 ${works.length} 条，总览 ${overview.length} 项，趋势 ${trend.length} 天`);
  return {
    works,
    overview,
    followers: trend,
    raw: { since, profile, overviewData: overviewRaw, analysisSample, listSample: [...byId.values()].slice(0, 2) },
  };
}

module.exports = { fetchKuaishouData, KUAISHOU_SINCE, normListItem, normOverview, mergeAnalysis, analysisList, sinceMs, workLink };
