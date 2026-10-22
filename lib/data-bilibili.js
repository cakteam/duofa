'use strict';
/**
 * B站创作中心（member.bilibili.com）数据抓取（V2.0，纯接口重放版）。
 * 数据中心 /platform/data-up/video 的 SPA 内容区经常不挂载（侧栏在、主区空白），
 * 但接口重放完全可靠（2026-10-07 实测，全部 GET，须带 period/tab 等原样参数）：
 *   - 账号总览 /x/web/data/v2/overview/stat/num?period=0&tab=0&…（播放/访客/净增粉丝/点赞…含上期）
 *   - 播放趋势 /x/web/data/v2/overview/stat/graph?period=0&s_locale=zh_CN&type=play&…（逐日增量）
 *   - 稿件数据 /x/web/data/archive/index?pn&ps=20&scene=archive_compare&order=0（每条 BV/播放/点赞/评论/完播率）
 *   - 粉丝分析：仅在页面渲染出来时点「粉丝分析」标签页嗅探 /fans/ 接口（可选增强，失败不影响主数据）
 */
const { attachCapture, findCapture, inPageFetch, sampleOf, needLoginError, sleep, shot } = require('./data-capture');

const DC_URL = 'https://member.bilibili.com/platform/data-up/video';
const BILI_DEVICE = encodeURIComponent('{"platform":"web","device":"pc","spmid":"333.1058","mobi_app":"web_cn"}');
const BILI_LOCALE = encodeURIComponent('{"c_locale":{"language":"zh-Hans"},"always_translate":true}');
const STAT_NUM_URL = `https://member.bilibili.com/x/web/data/v2/overview/stat/num?period=0&tab=0&x-bili-locale-json=${BILI_LOCALE}&x-bili-device-req-json=${BILI_DEVICE}&tmid=&t=`;
const STAT_GRAPH_URL = `https://member.bilibili.com/x/web/data/v2/overview/stat/graph?period=0&s_locale=zh_CN&type=play&x-bili-locale-json=${encodeURIComponent('{"c_locale":{"language":"zh","script":"Hans"},"always_translate":false}')}&x-bili-device-req-json=${BILI_DEVICE}&t=`;
const ARCHIVE_URL = 'https://member.bilibili.com/x/web/data/archive/index?pn=1&ps=20&scene=archive_compare&order=0';
// 稿件管理列表（含审核中/定时/已发布全部稿件，带 stat 播放互动数）——数据中心 archive/index 只给部分稿件时用它补全
const ARCHIVES_URL = 'https://member.bilibili.com/x/web/archives?status=is_pubing%2Cpubed%2Cnot_pubed&pn=1&ps=10&coop=1&interactive=1';

function num(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** B站完播率 full_play_ratio 是万分比（3268 = 32.68%），统一成 0~1 小数，与视频号/抖音口径一致 */
function ratio(v) {
  const n = num(v);
  if (n === null) return null;
  return n > 1 ? n / 10000 : n;
}

function fmtDate(unixSec) {
  if (!unixSec) return '';
  return new Date(unixSec * 1000).toLocaleDateString('zh-CN');
}

/** archive/index 条目 → 归一化作品 */
function normWork(it) {
  if (!it) return null;
  const rs = it.real_stat || {};
  const st = it.stat || {};
  return {
    id: it.bvid || String(it.aid || ''),
    title: it.title || '(无标题)',
    publishTime: it.pubtime ? new Date(it.pubtime * 1000).toLocaleString('zh-CN', { hour12: false }) : fmtDate(it.ctime),
    play: num(rs.play) ?? num(st.play),
    like: num(rs.likes) ?? num(st.likes),
    comment: num(rs.reply) ?? num(st.reply),
    share: null,
    favorite: null,
    coin: null,
    danmaku: null,
    completion: ratio(rs.full_play_ratio) ?? ratio(st.full_play_ratio),
    bounce: null,
    link: it.bvid ? `https://www.bilibili.com/video/${it.bvid}` : '',
    extra: { 时长秒: num(it.duration) },
  };
}

/** 稿件管理 arc_audits 条目 → 归一化作品（没有完播率） */
function normArchive(a) {
  const arc = (a && (a.Archive || a.archive)) || null;
  if (!arc) return null;
  const st = a.stat || a.Stat || {};
  const ts = arc.ptime || arc.pubtime || arc.ctime;
  return {
    id: arc.bvid || String(arc.aid || ''),
    title: arc.title || '(无标题)',
    publishTime: ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '',
    play: num(st.view),
    like: num(st.like),
    comment: num(st.reply),
    share: num(st.share),
    favorite: num(st.favorite),
    coin: num(st.coin),
    danmaku: num(st.danmaku),
    completion: null,
    bounce: null,
    link: arc.bvid ? `https://www.bilibili.com/video/${arc.bvid}` : '',
    extra: { 时长秒: num(arc.duration), 状态: arc.state_desc || (arc.state !== undefined ? `state=${arc.state}` : '') },
  };
}

/** 通用：从粉丝接口捕获里尝试提取按日序列 */
function extractFansRows(captures) {
  const rows = new Map();
  for (const c of captures) {
    if (!c.body || !/\/fans\//.test(c.url)) continue;
    let j;
    try {
      j = JSON.parse(c.body);
    } catch {
      continue;
    }
    const data = j && j.data;
    if (!data || typeof data !== 'object') continue;
    const series = data.tendency || data.trend || data.list || (Array.isArray(data) ? data : null);
    if (!Array.isArray(series)) continue;
    for (const o of series) {
      const date = o.date_key ? fmtDate(o.date_key) : o.date || o.dat;
      if (!date) continue;
      if (!rows.has(date)) rows.set(date, {});
      const slot = rows.get(date);
      for (const [k, v] of Object.entries(o)) {
        if (['date_key', 'date', 'dat'].includes(k)) continue;
        const n = num(v);
        if (n !== null) slot[k] = n;
      }
    }
  }
  return [...rows.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([日期, vals]) => ({ 日期, ...vals }));
}

async function fetchBilibiliData(page, log = () => {}) {
  log('打开B站创作中心…');
  await page.goto(DC_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(2500);
  if (!page.url().includes('member.bilibili.com')) {
    await shot(page, 'data-bili-need-login');
    throw needLoginError('B站');
  }

  // —— 账号总览（重放） ——
  const overview = [];
  let overviewRaw = null;
  try {
    const j = await inPageFetch(page, STAT_NUM_URL + Date.now(), { method: 'GET' });
    if (j.code !== 0) throw new Error(`code=${j.code}`);
    overviewRaw = j.data;
    const labels = { play: '播放量', visitor: '空间访客', fan: '净增粉丝', like: '点赞', fav: '收藏', coin: '投币', dm: '弹幕', comment: '评论', share: '分享', elec: '充电' };
    const d = j.data || {};
    for (const [key, label] of Object.entries(labels)) {
      if (d[key] === undefined) continue;
      overview.push({ 指标: label, 值: num(d[key]), 备注: d[key + '_last'] !== undefined ? `上期 ${num(d[key + '_last'])}` : '' });
    }
    if (d.log_date) overview.push({ 指标: '统计截止', 值: String(d.log_date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'), 备注: '' });
    log(`账号总览：${overview.length} 项`);
  } catch (e) {
    log(`账号总览获取失败（不影响其他数据）：${e.message}`);
  }

  // —— 播放趋势（重放） ——
  let followers = [];
  let graphRaw = null;
  try {
    const j = await inPageFetch(page, STAT_GRAPH_URL + Date.now(), { method: 'GET' });
    if (j.code !== 0) throw new Error(`code=${j.code}`);
    graphRaw = j.data;
    const ten = (j.data && j.data.data_tendency && j.data.data_tendency.play) || (j.data && j.data.tendency) || [];
    for (const o of ten) {
      followers.push({ 日期: fmtDate(o.date_key), 播放增量: num(o.total_inc), 粉丝播放增量: num(o.sub_total_inc) });
    }
    log(`播放趋势：${followers.length} 天`);
  } catch (e) {
    log(`播放趋势获取失败（不影响其他数据）：${e.message}`);
  }

  // —— 稿件数据（重放分页）：数据中心 archive/index 给完播率；稿件管理 archives 给全量稿件与互动数 ——
  const works = [];
  const samples = {};
  for (let pn = 1; pn <= 25; pn++) {
    let j;
    try {
      j = await inPageFetch(page, ARCHIVE_URL.replace('pn=1', `pn=${pn}`), { method: 'GET' });
    } catch (e) {
      log(`稿件数据第 ${pn} 页失败：${e.message}`);
      break;
    }
    if (j.code !== 0) {
      log(`稿件数据第 ${pn} 页错误：code=${j.code}`);
      break;
    }
    if (pn === 1) samples.archiveIndex = sampleOf(j.data, 'list', 2);
    const list = (j.data && j.data.list) || [];
    for (const it of list) {
      const w = normWork(it);
      if (w) works.push(w);
    }
    const total = j.data && (j.data.total ?? (j.data.page && j.data.page.total));
    log(`稿件数据第 ${pn} 页：+${list.length}（累计 ${works.length}${total !== undefined ? ` / 接口总数 ${total}` : ''}）`);
    if (!list.length || (total !== undefined ? works.length >= total : list.length < 20)) break;
    await sleep(700);
  }

  // 稿件管理列表补全：数据中心没收录的稿件（新发/定时/审核中）补进来，已有的补上分享/投币/收藏/弹幕
  try {
    const byId = new Map(works.map((w) => [w.id, w]));
    let added = 0;
    let seen = 0;
    for (let pn = 1; pn <= 30; pn++) {
      const j = await inPageFetch(page, ARCHIVES_URL.replace('pn=1', `pn=${pn}`), { method: 'GET' });
      if (j.code !== 0) throw new Error(`code=${j.code}`);
      if (pn === 1) samples.archives = sampleOf(j.data, 'arc_audits', 2);
      const list = (j.data && j.data.arc_audits) || [];
      for (const a of list) {
        const w = normArchive(a);
        if (!w || !w.id) continue;
        seen++;
        const old = byId.get(w.id);
        if (old) {
          for (const k of ['share', 'favorite', 'coin', 'danmaku']) if (old[k] === null) old[k] = w[k];
          if (old.play === null) old.play = w.play;
          if (w.extra.状态) old.extra.状态 = w.extra.状态;
        } else {
          works.push(w);
          byId.set(w.id, w);
          added++;
        }
      }
      const count = j.data && j.data.page && j.data.page.count;
      if (!list.length || (count !== undefined ? seen >= count : list.length < 10)) break;
      await sleep(700);
    }
    log(`稿件管理列表：共 ${seen} 条，补入数据中心未收录的 ${added} 条`);
  } catch (e) {
    log(`稿件管理列表获取失败（不影响已获取的稿件数据）：${e.message.split('\n')[0]}`);
  }
  works.sort((a, b) => new Date(b.publishTime) - new Date(a.publishTime));

  // —— 粉丝分析（可选：页面渲染出来才点；纯嗅探） ——
  let fansRawCaptures = [];
  try {
    const rendered = await page.evaluate(() => !!(document.body && document.body.innerText.includes('粉丝分析'))).catch(() => false);
    if (rendered) {
      const captures = attachCapture(page);
      await page.locator('text=粉丝分析').first().click({ timeout: 8000 });
      await sleep(9000);
      fansRawCaptures = captures.filter((c) => /\/fans\//.test(c.url) && c.body);
      const extra = extractFansRows(fansRawCaptures);
      if (extra.length) {
        const map = new Map(followers.map((r) => [r.日期, r]));
        for (const r of extra) {
          map.set(r.日期, { ...(map.get(r.日期) || { 日期: r.日期 }), ...r });
        }
        followers = [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([, r]) => r);
        log(`粉丝分析：+${extra.length} 天数据`);
      }
    } else {
      log('页面内容区未渲染，跳过粉丝分析标签页（总览里已含净增粉丝）');
    }
  } catch (e) {
    log(`粉丝分析获取失败（不影响其他数据）：${e.message.split('\n')[0]}`);
  }

  // 粉丝总数（看板「粉丝增长」用）：创作中心首页统计，同源接口；拿不到不影响其他数据
  let profile = null;
  try {
    const j = await inPageFetch(page, 'https://member.bilibili.com/x/web/index/stat?t=' + Date.now(), { method: 'GET' });
    const fo = j && j.code === 0 && j.data ? num(j.data.follower) : null;
    if (fo !== null) { profile = { follower: fo }; log(`粉丝总数：${fo}`); } else log(`粉丝总数没取到（code=${j && j.code}）`);
  } catch (e) {
    log(`粉丝总数获取失败（不影响其他数据）：${e.message.split('\n')[0]}`);
  }

  log(`B站数据完成：稿件 ${works.length} 条，总览 ${overview.length} 项，趋势 ${followers.length} 天`);
  return {
    works,
    overview,
    followers,
    raw: { profile, overview: overviewRaw, graph: graphRaw, samples, fansCaptures: fansRawCaptures.map((c) => ({ url: c.url, body: (c.body || '').slice(0, 20000) })) },
  };
}

module.exports = { fetchBilibiliData };
