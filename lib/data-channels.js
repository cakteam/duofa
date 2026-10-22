'use strict';
/**
 * 视频号助手（channels.weixin.qq.com）数据抓取（V2.0，纯接口重放版）。
 * 后台为 SPA，内容区渲染不稳定，但接口重放 100% 可靠（2026-10-07 实测）：
 *   - 作品列表 POST /micro/content/cgi-bin/mmfinderassistant-bin/post/post_list
 *     载荷 {pageSize, currentPage, userpageType:11, ...}，totalCount + continueFlag 翻页
 *   - 粉丝趋势 POST /cgi-bin/mmfinderassistant-bin/statistic/fans_trend
 *     载荷 {startTs, endTs(秒), interval:3}，30 天窗口返回逐日 30 点
 *   - 昨日数据 POST /cgi-bin/mmfinderassistant-bin/statistic/new_post_total_data
 *     startTs/endTs 必须按 0 点对齐（跨到今天会报 300800）；数值数组 [前日, 昨日]
 *   - 账号信息 POST /cgi-bin/mmfinderassistant-bin/auth/auth_data（userAttr.nickname）
 * _log_finder_id 从页面 cookie/localStorage 正则提取；全部接口在页面上下文 fetch 重放（带登录态）。
 */
const { inPageFetch, needLoginError, sleep, shot } = require('./data-capture');

const HOME_URL = 'https://channels.weixin.qq.com/platform';
const DAY = 86400;

const POST_LIST_URL = 'https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list';
const FANS_TREND_URL = 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/statistic/fans_trend';
const DAILY_TOTAL_URL = 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/statistic/new_post_total_data';
const AUTH_DATA_URL = 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data';
const SHOP_INFO_URL = 'https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/shop/get_finder_ec_info_for_opening_page';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function localMidnight(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 从页面 cookie/localStorage 提取 _log_finder_id（v2_…@finder 格式） */
async function extractFinderId(page) {
  try {
    const raw = await page.evaluate(() => {
      let ls = '';
      for (let i = 0; i < localStorage.length; i++) ls += localStorage.getItem(localStorage.key(i));
      return document.cookie + ls;
    });
    const m = String(raw).match(/v2_0[0-9a-f]+@finder/);
    return m ? m[0] : '';
  } catch {
    return '';
  }
}

function basePayload(finderId) {
  return {
    timestamp: String(Date.now()),
    _log_finder_uin: '',
    _log_finder_id: finderId,
    rawKeyBuff: '',
    pluginSessionId: null,
    scene: 7,
    reqScene: 7,
  };
}

/** post_list 条目 → 归一化作品 */
function normWork(it) {
  if (!it) return null;
  const desc = it.desc || {};
  // shortTitle 实测是数组：[{shortTitle:"…"}]
  const st = desc.shortTitle;
  const shortTitle = Array.isArray(st)
    ? String((st[0] && (st[0].shortTitle || st[0].title)) || '')
    : typeof st === 'string'
      ? st
      : '';
  const description = typeof desc.description === 'string' ? desc.description : '';
  return {
    id: it.objectId || '',
    title: shortTitle || description.split('\n')[0] || '(无标题)',
    publishTime: it.createTime ? new Date(it.createTime * 1000).toLocaleString('zh-CN', { hour12: false }) : '',
    play: num(it.readCount),
    like: num(it.likeCount),
    comment: num(it.commentCount),
    share: num(it.forwardCount),
    favorite: num(it.favCount),
    coin: null,
    danmaku: null,
    completion: num(it.fullPlayRate),
    bounce: null,
    link: '',
    extra: {
      昨日播放: num(it.yesterdayReadCount),
      平均播放时长秒: it.avgPlayTimeSec,
      关注转化: num(it.followCount),
    },
  };
}

async function fetchChannelsData(page, log = () => {}) {
  log('打开视频号助手首页…');
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(2000);
  if (!page.url().includes('/platform')) {
    await shot(page, 'data-channels-need-login');
    throw needLoginError('视频号');
  }

  const finderId = await extractFinderId(page);
  log(finderId ? '已取到账号标识，开始重放数据接口' : '未取到账号标识（部分接口可能失败），继续');

  // —— 作品列表：分页拉全量 ——
  const works = [];
  let totalCount = null;
  const PAGE_SIZE = 20;
  for (let p = 1; p <= 40; p++) {
    const j = await inPageFetch(page, POST_LIST_URL, {
      method: 'POST',
      body: { pageSize: PAGE_SIZE, currentPage: p, userpageType: 11, stickyOrder: false, ...basePayload(finderId) },
    });
    if (j.errCode !== 0) throw new Error(`作品列表接口错误 errCode=${j.errCode}`);
    const list = (j.data && j.data.list) || [];
    if (totalCount === null && j.data) totalCount = num(j.data.totalCount);
    for (const it of list) {
      const w = normWork(it);
      if (w) works.push(w);
    }
    log(`作品列表第 ${p} 页：+${list.length}（累计 ${works.length}${totalCount ? '/' + totalCount : ''}）`);
    if (!j.data || !j.data.continueFlag || list.length < PAGE_SIZE) break;
    await sleep(800);
  }

  // —— 粉丝趋势（近 30 天逐日） ——
  let followers = [];
  let fansRaw = null;
  try {
    const endTs = Math.floor(localMidnight(Date.now()) / 1000); // 今日 0 点（不含今天）
    const startTs = endTs - 29 * DAY;
    const j = await inPageFetch(page, FANS_TREND_URL, {
      method: 'POST',
      body: { startTs: String(startTs), endTs: String(endTs), interval: 3, ...basePayload(finderId) },
    });
    if (j.errCode !== 0) throw new Error(`errCode=${j.errCode}`);
    fansRaw = j.data;
    const d = j.data || {};
    const n = Math.min(d.add?.length || 0, d.total?.length || 0);
    for (let i = 0; i < n; i++) {
      followers.push({
        日期: fmtDate((startTs + i * DAY) * 1000),
        新增关注: num(d.add?.[i]),
        取关: num(d.reduce?.[i]),
        净增: num(d.netAdd?.[i]),
        粉丝总数: num(d.total?.[i]),
      });
    }
    log(`粉丝趋势：${followers.length} 天（最新总数 ${followers.length ? followers[followers.length - 1].粉丝总数 : '—'}）`);
  } catch (e) {
    log(`粉丝趋势获取失败（不影响其他数据）：${e.message}`);
  }

  // —— 昨日数据（按流量来源；数值数组 [前日, 昨日]） ——
  let overview = [];
  let dailyRaw = null;
  try {
    const dayStart = Math.floor(localMidnight(Date.now()) / 1000);
    const body = { startTs: String(dayStart - DAY), endTs: String(dayStart), interval: 3, ...basePayload(finderId) };
    let j = await inPageFetch(page, DAILY_TOTAL_URL, { method: 'POST', body }).catch(() => null);
    if (!j || j.errCode !== 0) {
      await sleep(1500);
      j = await inPageFetch(page, DAILY_TOTAL_URL, { method: 'POST', body }); // 偶发 300800：重试一次
    }
    if (!j || j.errCode !== 0) throw new Error(`errCode=${j ? j.errCode : '无响应'}`);
    dailyRaw = j.data;
    const tabs = (j.data && j.data.dataByTabtype) || [];
    const sum = (key, idx) => tabs.reduce((s, t) => s + (Number(t.data?.[key]?.[idx]) || 0), 0);

    // 账号昵称：优先视频号名（shop 接口 windowName），兜底微信昵称
    let nickname = '';
    try {
      const s = await inPageFetch(page, SHOP_INFO_URL, { method: 'POST', body: basePayload(finderId) });
      nickname = (s.data && (s.data.windowName || (s.data.ecFinder && s.data.ecFinder.nickname))) || '';
    } catch {}
    if (!nickname) {
      try {
        const a = await inPageFetch(page, AUTH_DATA_URL, { method: 'POST', body: basePayload(finderId) });
        nickname = (a.data && a.data.userAttr && a.data.userAttr.nickname) || '';
      } catch {}
    }

    overview = [
      { 指标: '账号', 值: nickname || '(未取到)', 备注: '' },
      { 指标: '作品总数', 值: totalCount ?? works.length, 备注: '' },
      { 指标: '粉丝总数', 值: followers.length ? followers[followers.length - 1].粉丝总数 : null, 备注: '粉丝趋势序列最后值' },
      { 指标: '昨日新增播放', 值: sum('browse', 1), 备注: `前日 ${sum('browse', 0)}` },
      { 指标: '昨日新增点赞', 值: sum('like', 1), 备注: `前日 ${sum('like', 0)}` },
      { 指标: '昨日新增评论', 值: sum('comment', 1), 备注: `前日 ${sum('comment', 0)}` },
      { 指标: '昨日新增转发', 值: sum('forward', 1), 备注: `前日 ${sum('forward', 0)}` },
      { 指标: '昨日新增收藏', 值: sum('fav', 1), 备注: `前日 ${sum('fav', 0)}` },
      { 指标: '昨日新增关注', 值: sum('follow', 1), 备注: `前日 ${sum('follow', 0)}` },
    ];
  } catch (e) {
    log(`昨日数据获取失败（不影响其他数据）：${e.message}`);
    overview = [
      { 指标: '作品总数', 值: totalCount ?? works.length, 备注: '' },
    ];
  }

  log(`视频号数据完成：作品 ${works.length} 条，粉丝趋势 ${followers.length} 天`);
  return {
    works,
    overview,
    followers,
    raw: { fansTrend: fansRaw, dailyTotal: dailyRaw, totalCount },
  };
}

module.exports = { fetchChannelsData };
