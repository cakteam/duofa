'use strict';
/**
 * 抖音创作者中心（creator.douyin.com）数据抓取（V2.0）。
 * 2026-10 实测接口：
 *   - 作品表现 POST /janus/douyin/creator/data/item_analysis/item_performance
 *     载荷 {start_date, end_date, genres, primary_verticals, metric_type}，一次可覆盖约 90 天，
 *     metric_type=1 为播放类指标；2/3 等为互动类（实测返回什么就合并什么）
 *   - 作品列表 GET /web/api/creator/item/list?min_cursor&max_cursor&count&order_by=2（标题/发布时间）
 *   - 账号总览 GET /aweme/janus/creator/data/overview/all/（各指标当前值 + 按日趋势）
 * 页面打开时嗅探 item_performance 原始载荷，其余用页面上下文 fetch 重放。
 */
const { attachCapture, waitCapture, gotoUntilCapture, inPageFetch, parseJsonSafe, sampleOf, needLoginError, sleep, shot } = require('./data-capture');

const DC_URL = 'https://creator.douyin.com/creator-micro/data-center/content';
const OVERVIEW_ALL_URL = 'https://creator.douyin.com/aweme/janus/creator/data/overview/all/';
const ITEM_LIST_URL = 'https://creator.douyin.com/web/api/creator/item/list';
const ITEM_PERF_URL = 'https://creator.douyin.com/janus/douyin/creator/data/item_analysis/item_performance';

const DEFAULT_VERTICALS = ['科技', '游戏', '摄影摄像', '医疗健康', '电视剧', '艺术', '汽车', '美食', '剧情', '随拍', '社会时政', '科普', '二次元', '财经', '法律'];
const OVERVIEW_LABELS = {
  fans: '粉丝数',
  follower: '粉丝数',
  like: '累计点赞',
  comment: '累计评论',
  share: '累计分享',
  play: '累计播放',
  view: '累计播放',
  cancel_fans: '取关数',
  account_search: '搜索数',
  collect: '收藏',
  homepage_view: '主页访问',
};

function num(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function firstLine(s) {
  return String(s || '').split('\n')[0].trim();
}

/** 依次取第一个有值的字段（互动类指标在不同 metric_type / 接口里字段名不一） */
function pick(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = num(obj[k]);
    if (v !== null) return v;
  }
  return null;
}
const LIKE_KEYS = ['like_count', 'digg_count', 'like', 'digg', 'like_cnt', 'digg_cnt'];
const COMMENT_KEYS = ['comment_count', 'comment', 'comment_cnt'];
const SHARE_KEYS = ['share_count', 'share', 'share_cnt', 'forward_count'];
const COLLECT_KEYS = ['collect_count', 'favorite_count', 'collect', 'collect_cnt'];
const PLAY_KEYS = ['play_count', 'play', 'view_count', 'vv'];

/** 作品列表条目里的互动数（statistics/statistic 块，表现接口缺字段时兜底） */
function listStats(meta) {
  return (meta && (meta.statistics || meta.statistic || meta.stats)) || null;
}

function normPerfItem(it) {
  return {
    id: String(it.item_id || ''),
    title: firstLine(it.title),
    publishTime: it.publish_time || '',
    play: pick(it, PLAY_KEYS),
    like: pick(it, LIKE_KEYS),
    comment: pick(it, COMMENT_KEYS),
    share: pick(it, SHARE_KEYS),
    favorite: pick(it, COLLECT_KEYS),
    coin: null,
    danmaku: null,
    completion: null, // 完播率取自作品管理页；数据中心只有 5 秒完播率（见 extra）
    bounce: num(it.bounce_rate_2s),
    link: it.item_id ? `https://www.douyin.com/video/${it.item_id}` : '',
    extra: { 条均播放时长秒: num(it.average_play_duration), '5秒完播率': num(it.completion_rate_5s) },
  };
}

const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage';

/** 「4.2万」「1,077」「30.68%」「-」→ 数字（百分比转 0~1） */
function parseShown(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/,/g, '').trim();
  let m = t.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (m) return Number((Number(m[1]) / 100).toFixed(6));
  m = t.match(/^(-?\d+(?:\.\d+)?)\s*(万|w|亿)?$/i);
  if (!m) return null;
  const mul = m[2] === '亿' ? 1e8 : m[2] ? 1e4 : 1;
  return Math.round(Number(m[1]) * mul);
}

/**
 * 作品管理页（内容管理）的逐条数据（2026-10-09 起用）：
 * 数据中心 item_performance 三种 metric_type 都只给播放类字段，点赞/评论/分享/收藏/完播率/吸粉量
 * 只在作品管理页有；该页的列表请求 page.on('response') 抓不到，所以直接读页面：
 * 每张作品卡读「标题 / 发布时间 / 播放 点赞 评论 分享 收藏 完播率 2秒跳出率 吸粉量」，滚动加载到底。
 * 返回 { rows:[{title, time, play, like, comment, share, favorite, completion, bounce, fans}], sample }
 */
async function fetchWorkStats(page, log) {
  // 顺带记录该页所有接口请求（排查用，下次若能直接用接口就不必读页面）
  const seen = [];
  const onResp = (resp) => {
    try {
      const url = resp.url();
      if (!/douyin\.com/.test(url) || seen.length >= 80) return;
      const rt = resp.request().resourceType();
      if (rt === 'image' || rt === 'stylesheet' || rt === 'font' || rt === 'media' || rt === 'script') return;
      seen.push({ url: url.split('?')[0], type: rt, ct: (resp.headers()['content-type'] || '').slice(0, 40), status: resp.status() });
    } catch {}
  };
  page.on('response', onResp);
  try {
    await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (e) {
    page.off('response', onResp);
    log(`作品管理页打开失败：${e.message.split('\n')[0]}`);
    return { rows: [], sample: { requests: seen } };
  }

  const readCards = () =>
    page.evaluate(() => {
      const DATE = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/;
      const LABELS = ['播放', '点赞', '评论', '分享', '收藏', '完播率', '2秒跳出率', '吸粉量'];
      const cards = new Set();
      for (const el of document.querySelectorAll('body *')) {
        if (el.childElementCount || (el.textContent || '').trim() !== '点赞') continue;
        let c = el;
        for (let k = 0; k < 12 && c; k++) {
          c = c.parentElement;
          if (c && DATE.test(c.innerText || '')) break;
        }
        if (c) cards.add(c);
      }
      const out = [];
      for (const c of cards) {
        const lines = (c.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const val = (lab) => {
          const i = lines.indexOf(lab);
          return i >= 0 && i + 1 < lines.length && !LABELS.includes(lines[i + 1]) ? lines[i + 1] : null;
        };
        const di = lines.findIndex((l) => DATE.test(l));
        const dm = di >= 0 ? lines[di].match(DATE) : null;
        const title = lines.slice(0, Math.max(di, 0)).filter((l) => l !== '置顶' && !/^\d{1,2}:\d{2}$/.test(l)).sort((a, b) => b.length - a.length)[0] || '';
        const p = (n) => String(n).padStart(2, '0');
        out.push({
          title,
          time: dm ? `${dm[1]}-${p(dm[2])}-${p(dm[3])} ${p(dm[4])}:${dm[5]}` : '',
          status: lines.find((l) => /^(已发布|审核中|未通过|定时发布|仅自己可见|私密)/.test(l)) || '',
          play: val('播放'), like: val('点赞'), comment: val('评论'), share: val('分享'), favorite: val('收藏'),
          completion: val('完播率'), bounce: val('2秒跳出率'), fans: val('吸粉量'),
        });
      }
      return out;
    });

  // 等首屏卡片
  let rows = [];
  for (let t = 0; t < 30 && !rows.length; t++) {
    await sleep(700);
    rows = await readCards().catch(() => []);
  }
  if (!rows.length) {
    page.off('response', onResp);
    await shot(page, 'data-douyin-manage');
    log('作品管理页没有读到作品卡片，点赞/评论本次缺失（截图 logs/data-douyin-manage.png）');
    return { rows: [], sample: { pageUrl: page.url(), requests: seen } };
  }

  // 滚动加载到底（连续 4 次没有新卡片就停；最多约 70 秒）
  const total = await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/作品\s*[（(](\d+)[)）]/);
    return m ? Number(m[1]) : null;
  }).catch(() => null);
  const byKey = new Map();
  const absorb = (list) => { for (const r of list) byKey.set(r.time + '|' + r.title.slice(0, 20), r); };
  absorb(rows);
  let idle = 0;
  for (let s = 0; s < 60 && idle < 4 && !(total && byKey.size >= total); s++) {
    const before = byKey.size;
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('body *')) {
        if (el.scrollHeight > el.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
      }
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await page.mouse.wheel(0, 5000).catch(() => {});
    await sleep(1100);
    absorb(await readCards().catch(() => []));
    idle = byKey.size > before ? 0 : idle + 1;
  }
  page.off('response', onResp);

  const parsed = [...byKey.values()].map((r) => ({
    ...r,
    play: parseShown(r.play), like: parseShown(r.like), comment: parseShown(r.comment), share: parseShown(r.share),
    favorite: parseShown(r.favorite), completion: parseShown(r.completion), bounce: parseShown(r.bounce), fans: parseShown(r.fans),
  }));
  log(`作品管理页：读到 ${parsed.length}${total ? '/' + total : ''} 条作品的点赞/评论/完播率/吸粉量`);
  return { rows: parsed, sample: { total, requests: seen, first: parsed.slice(0, 2) } };
}

async function fetchDouyinData(page, log = () => {}) {
  const captures = attachCapture(page);
  log('打开抖音数据中心…');
  await page.goto(DC_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(3000);
  const url = page.url();
  if (!url.includes('creator.douyin.com') || /login|passport/.test(url)) {
    await shot(page, 'data-douyin-need-login');
    throw needLoginError('抖音');
  }

  // 等页面自己发出作品表现接口（拿载荷模板；页面内容区经常不渲染，拿不到就用默认 90 天窗口，实测等价）
  const found = await gotoUntilCapture(page, captures, DC_URL, ['item_analysis/item_performance'], { attempts: 1, waitMs: 10000 });
  if (!page.url().includes('creator.douyin.com') || /login|passport/.test(page.url())) {
    await shot(page, 'data-douyin-need-login');
    throw needLoginError('抖音');
  }
  const perfHit = found && found.hit;
  let perfTemplate = null;
  if (perfHit && perfHit.postData) {
    try {
      perfTemplate = JSON.parse(perfHit.postData);
    } catch {}
  }
  if (!perfTemplate) {
    // 页面未发出（网络慢等）：用 90 天窗口兜底重放
    const end = new Date();
    const start = new Date(Date.now() - 90 * 86400e3);
    perfTemplate = { start_date: ymd(start), end_date: ymd(end), genres: [1, 2, 3, 4, 5, 8], primary_verticals: DEFAULT_VERTICALS, metric_type: 1 };
    log('未嗅探到作品表现载荷，改用默认 90 天窗口');
  }

  // —— 作品表现（播放类 + 互动类） ——
  // 同名字段后到的覆盖先到的，但空值不覆盖已有值（互动类返回里播放字段可能为空）
  const perfById = new Map();
  const perfSamples = {};
  const metricTypes = [1, 2, 3];
  for (const mt of metricTypes) {
    try {
      const j = await inPageFetch(page, ITEM_PERF_URL, { method: 'POST', body: { ...perfTemplate, metric_type: mt } });
      perfSamples[`metric_type_${mt}`] = sampleOf(j, 'items', 3);
      const items = (j && j.items) || [];
      if (!items.length) continue;
      for (const it of items) {
        const id = String(it.item_id || '');
        if (!id) continue;
        const merged = { ...(perfById.get(id) || {}) };
        for (const [k, v] of Object.entries(it)) {
          if (v !== null && v !== undefined && v !== '') merged[k] = v;
        }
        perfById.set(id, merged);
      }
      const total = j.total ?? j.total_count ?? (j.extra && j.extra.total);
      log(`作品表现 metric_type=${mt}：${items.length} 条${total !== undefined ? `（接口总数 ${total}）` : ''}；字段：${Object.keys(items[0]).join(',')}`);
    } catch (e) {
      if (mt === 1) log(`作品表现(播放)获取失败：${e.message}`);
    }
    await sleep(600);
  }

  // —— 作品列表（标题/发布时间更全；不带签名重放，失败则用 item_performance 的字段兜底） ——
  // 2026-10-09 实测：order_by=2 返回的是最早的 20 条（升序），旧的「按最小 create_time 往前翻」翻不动；
  // 现在优先用接口自己给的游标（max_cursor/min_cursor/cursor）翻页，没有时再按本页时间范围推算方向。
  const listById = new Map();
  let listSample = null;
  try {
    let query = `min_cursor=0&max_cursor=${Date.now()}`;
    const seenQueries = new Set();
    for (let p = 0; p < 40; p++) {
      if (seenQueries.has(query)) break;
      seenQueries.add(query);
      const j = await inPageFetch(page, `${ITEM_LIST_URL}?${query}&count=20&order_by=2`, { method: 'GET' });
      if (!listSample) listSample = sampleOf(j, 'items', 2);
      const items = (j && j.items) || [];
      if (j && j.BaseResp && Number(j.BaseResp.StatusCode) !== 0) {
        throw new Error(j.BaseResp.StatusMessage || '接口拒绝');
      }
      const before = listById.size;
      for (const it of items) listById.set(String(it.id || it.item_id || it.aweme_id || ''), it);
      log(`作品列表第 ${p + 1} 页：+${listById.size - before}（累计 ${listById.size}）`);
      if (!j || !j.has_more || !items.length || listById.size === before) break;
      const times = items.map((it) => Number(it.create_time)).filter(Boolean);
      const ascending = times.length > 1 && times[0] < times[times.length - 1];
      if (j.max_cursor !== undefined && j.min_cursor !== undefined) {
        query = ascending ? `min_cursor=${j.max_cursor}&max_cursor=0` : `min_cursor=0&max_cursor=${j.min_cursor}`;
      } else if (j.cursor !== undefined) {
        query = `cursor=${j.cursor}&min_cursor=0&max_cursor=0`;
      } else if (ascending) {
        query = `min_cursor=${Math.max(...times) * 1000 + 1}&max_cursor=0`;
      } else {
        query = `min_cursor=0&max_cursor=${Math.min(...times) * 1000 - 1}`;
      }
      await sleep(800);
    }
  } catch (e) {
    log(`作品列表重放失败（不影响已获取的表现数据）：${e.message.split('\n')[0]}`);
  }

  // 合并：作品列表给标题/发布时间，表现数据给指标
  const works = [];
  const ids = new Set([...perfById.keys(), ...listById.keys()]);
  for (const id of ids) {
    const perf = perfById.get(id);
    const meta = listById.get(id);
    const base = perf ? normPerfItem(perf) : { id, title: '', publishTime: '', play: null, like: null, comment: null, share: null, favorite: null, coin: null, danmaku: null, completion: null, bounce: null, link: `https://www.douyin.com/video/${id}`, extra: {} };
    if (meta) {
      if (!base.title) base.title = firstLine(meta.description);
      if (!base.publishTime && meta.create_time) {
        base.publishTime = fmtDateTime(Number(meta.create_time) * 1000);
      }
      base.extra.视频时长秒 = meta.video_info ? num(meta.video_info.duration) / 1000 : undefined;
      // 表现接口没给的互动数，用作品列表的 statistics 兜底
      const st = listStats(meta);
      if (base.play === null) base.play = pick(st, PLAY_KEYS) ?? pick(meta, PLAY_KEYS);
      if (base.like === null) base.like = pick(st, LIKE_KEYS) ?? pick(meta, LIKE_KEYS);
      if (base.comment === null) base.comment = pick(st, COMMENT_KEYS) ?? pick(meta, COMMENT_KEYS);
      if (base.share === null) base.share = pick(st, SHARE_KEYS) ?? pick(meta, SHARE_KEYS);
      if (base.favorite === null) base.favorite = pick(st, COLLECT_KEYS) ?? pick(meta, COLLECT_KEYS);
    }
    if (!base.title) base.title = '(无标题)';
    works.push(base);
  }
  // 按发布时间倒序
  works.sort((a, b) => String(b.publishTime).localeCompare(String(a.publishTime)));

  // —— 账号总览 + 按日趋势（overview/all：fans/like/comment/share… 各一块） ——
  let overview = [];
  let trendRows = [];
  let overviewRaw = null;
  try {
    const j = await inPageFetch(page, OVERVIEW_ALL_URL, { method: 'GET' });
    overviewRaw = j && j.data;
    const blocks = (j && j.data) || {};
    overview.push({ 指标: '抖音号', 值: '', 备注: '详见原始JSON' });
    const byDate = new Map();
    for (const [key, block] of Object.entries(blocks)) {
      if (!block || typeof block !== 'object' || block.current_count === undefined) continue;
      const label = OVERVIEW_LABELS[key] || key;
      overview.push({ 指标: label, 值: num(block.current_count), 备注: block.last_period_incr !== undefined ? `上期增减 ${block.last_period_incr}` : '' });
      if (Array.isArray(block.option_list)) {
        for (const o of block.option_list) {
          if (!o || !o.date) continue;
          if (!byDate.has(o.date)) byDate.set(o.date, {});
          byDate.get(o.date)[label] = num(o.count);
        }
      }
    }
    trendRows = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, vals]) => ({ 日期: date, ...vals }));
  } catch (e) {
    log(`账号总览获取失败（不影响作品数据）：${e.message.split('\n')[0]}`);
  }

  // —— 作品管理页补点赞/评论/分享/收藏/完播率/吸粉量（按发布时间 + 标题前缀对上作品） ——
  let workStatsSample = null;
  try {
    const { rows, sample } = await fetchWorkStats(page, log);
    workStatsSample = sample;
    if (rows.length) {
      const key12 = (t) => String(t || '').replace(/[\s…]+/g, '').slice(0, 12);
      const byTime = new Map();
      const byTitle = new Map();
      for (const r of rows) {
        if (!byTime.has(r.time)) byTime.set(r.time, []);
        byTime.get(r.time).push(r);
        byTitle.set(key12(r.title), r);
      }
      const used = new Set();
      for (const w of works) {
        const sameTime = byTime.get(String(w.publishTime).slice(0, 16)) || [];
        const r = (sameTime.length === 1 ? sameTime[0] : sameTime.find((x) => key12(x.title) === key12(w.title))) || byTitle.get(key12(w.title));
        if (!r || used.has(r)) continue;
        used.add(r);
        for (const k of ['like', 'comment', 'share', 'favorite', 'completion']) if (r[k] !== null) w[k] = r[k];
        if (w.play === null) w.play = r.play;
        if (r.fans !== null) w.extra.吸粉量 = r.fans;
        if (r.status) w.extra.状态 = r.status;
      }
      // 作品管理里有、数据中心还没收录的（数据中心 T+1，刚发的还没有）也补进来；播放是页面上的约数
      for (const r of rows) {
        if (used.has(r)) continue;
        works.push({
          id: `作品管理:${r.time}:${key12(r.title)}`, title: r.title || '(无标题)', publishTime: r.time,
          play: r.play, like: r.like, comment: r.comment, share: r.share, favorite: r.favorite,
          coin: null, danmaku: null, completion: r.completion, bounce: r.bounce, link: '',
          extra: { 来源: '作品管理页（播放为页面显示的约数）', 吸粉量: r.fans, 状态: r.status },
        });
      }
      works.sort((a, b) => String(b.publishTime).localeCompare(String(a.publishTime)));
      log(`作品管理页数据已合并：对上 ${used.size} 条，新增数据中心未收录的 ${rows.length - used.size} 条`);
    }
  } catch (e) {
    log(`作品管理页读取失败（不影响播放数据）：${e.message.split('\n')[0]}`);
  }

  const withLike = works.filter((w) => w.like !== null).length;
  log(`抖音数据完成：作品 ${works.length} 条（有点赞数 ${withLike} 条），总览 ${overview.length - 1} 项，趋势 ${trendRows.length} 天`);
  return {
    works,
    overview,
    followers: trendRows,
    raw: { overviewAll: overviewRaw, perfTemplate, perfSamples, listSample, workStatsSample },
  };
}

module.exports = { fetchDouyinData };
