'use strict';
/**
 * 数据看板聚合（V3.0）。
 * 数据源（均只读）：
 *   1. 数据下载/YYYY-MM-DD/平台_原始数据.json —— 「数据」页每次下载的快照（works/overview/trend/raw）
 *   2. 内容目录 —— 发布内容（lib/published.js 扫描），各平台播放由 lib/match.js 从快照匹配补齐
 * 口径说明：
 *   - 「每日播放增量」：视频号直接用快照 overview 的「昨日新增播放」；抖音/B站用相邻两日快照
 *     works 累计播放之和的差分（首日无差分不画点）
 *   - 「粉丝总数」：视频号 = trend 序列最后值；抖音 = raw.overviewAll 里 fans 块 current_count
 * 结果缓存 5 秒（?fresh=1 可绕过），避免前端轮询反复解析 JSON。
 */
const fs = require('fs');
const path = require('path');
const { listPublished } = require('./published');
const { attachSnapshotPerf } = require('./match');

const PLATFORM_FILES = { channels: '视频号_原始数据.json', douyin: '抖音_原始数据.json', kuaishou: '快手_原始数据.json', bili: 'B站_原始数据.json' };
const PLATFORM_LABEL = { channels: '视频号', douyin: '抖音', kuaishou: '快手', bili: 'B站' };
const CACHE_TTL = 5000;

const cache = { at: 0, data: null };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 读单个平台某天的快照 JSON，容错返回 null */
function readSnapshot(saveRoot, day, platform) {
  const file = path.join(saveRoot, day, PLATFORM_FILES[platform]);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const works = Array.isArray(j.works) ? j.works : [];
    // 旧快照的 B站完播率是万分比原值（3268 = 32.68%），统一成 0~1 小数
    if (platform === 'bili') {
      for (const w of works) if (typeof w.completion === 'number' && w.completion > 1) w.completion = w.completion / 10000;
    }
    const overviewRows = Array.isArray(j.overview) ? j.overview : [];
    const trendRows = Array.isArray(j.trend) ? j.trend : [];
    const overviewRow = (name) => overviewRows.find((r) => r && r.指标 === name);
    let playsSum = 0;
    let likesSum = 0;
    let commentsSum = 0;
    for (const w of works) {
      playsSum += num(w.play) || 0;
      likesSum += num(w.like) || 0;
      commentsSum += num(w.comment) || 0;
    }
    // 昨日新增播放（视频号 overview 直供）
    const yPlayRow = overviewRow('昨日新增播放');
    const yesterdayPlay = yPlayRow ? num(yPlayRow.值) : null;
    // 粉丝总数：视频号取 trend 末值；抖音取 raw.overviewAll.data.fans.current_count
    let fansTotal = null;
    if (platform === 'channels' && trendRows.length && trendRows[trendRows.length - 1].粉丝总数 != null) {
      fansTotal = num(trendRows[trendRows.length - 1].粉丝总数);
    } else if (platform === 'kuaishou') {
      const prof = j.raw && j.raw.profile;
      if (prof && prof.fansCnt !== undefined) fansTotal = num(prof.fansCnt);
      if (fansTotal === null) {
        const fanRow = overviewRow('粉丝数');
        if (fanRow) fansTotal = num(fanRow.值);
      }
    } else if (platform === 'bili') {
      const prof = j.raw && j.raw.profile;
      if (prof && prof.follower !== undefined && prof.follower !== null) fansTotal = num(prof.follower);
    } else if (platform === 'douyin') {
      const fansBlock = j.raw && j.raw.overviewAll && j.raw.overviewAll.data && j.raw.overviewAll.data.fans;
      if (fansBlock && fansBlock.current_count !== undefined) fansTotal = num(fansBlock.current_count);
      if (fansTotal === null) {
        const fanRow = overviewRow('粉丝数');
        if (fanRow) fansTotal = num(fanRow.值);
      }
    }
    return { works, trendRows, playsSum, likesSum, commentsSum, yesterdayPlay, fansTotal, fetchedAt: j.fetchedAt || null };
  } catch {
    return null;
  }
}

/** 读 saveRoot 下全部日期目录的快照：Map(day -> {platform: snap})，day 升序 */
function loadSnapshots(saveRoot) {
  const days = [];
  try {
    days.push(
      ...fs
        .readdirSync(saveRoot)
        .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
        .sort()
    );
  } catch {}
  const platforms = Object.keys(PLATFORM_FILES);

  // 按日快照
  const snaps = new Map(); // day -> {platform: snap}
  for (const day of days) {
    for (const pk of platforms) {
      const snap = readSnapshot(saveRoot, day, pk);
      if (snap) {
        if (!snaps.has(day)) snaps.set(day, {});
        snaps.get(day)[pk] = snap;
      }
    }
  }
  return snaps;
}

/** 组装看板数据 */
function buildDashboard(saveRoot, { fresh = false, contentDir } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < CACHE_TTL) return cache.data;
  const platforms = Object.keys(PLATFORM_FILES);
  const snaps = loadSnapshots(saveRoot);

  // —— 每日播放增量序列 ——
  // 视频号用 overview 直供的昨日值；抖音/B站用相邻两日 works 累计播放差分
  const playGain = { dates: [], channels: [], douyin: [], kuaishou: [], bili: [] };
  for (const day of snaps.keys()) {
    const s = snaps.get(day);
    playGain.dates.push(day);
    playGain.channels.push(s.channels ? s.channels.yesterdayPlay : null);
    for (const pk of ['douyin', 'kuaishou', 'bili']) {
      let diff = null;
      if (s[pk]) {
        const prev = [...snaps.keys()].filter((d) => d < day).pop();
        const prevSnap = prev && snaps.get(prev)[pk];
        if (prevSnap) {
          const d = s[pk].playsSum - prevSnap.playsSum;
          if (d >= 0) diff = d;
        }
      }
      playGain[pk].push(diff);
    }
  }

  // —— 粉丝序列（视频号 30 天 + 抖音趋势行里的粉丝数） ——
  const latestFansTrend = { channels: [], douyin: [], kuaishou: [], bili: [] };
  {
    const lastDay = [...snaps.keys()].pop();
    const s = lastDay && snaps.get(lastDay);
    if (s && s.channels) {
      for (const r of s.channels.trendRows) {
        latestFansTrend.channels.push({ date: r.日期, total: num(r.粉丝总数), netAdd: num(r.净增) });
      }
    }
    if (s && s.douyin) {
      // 抖音 trend 行是 {日期, 指标:值...}，粉丝数列若存在就取
      for (const r of s.douyin.trendRows) {
        if (r.粉丝数 !== undefined) latestFansTrend.douyin.push({ date: r.日期, total: num(r.粉丝数) });
      }
    }
  }

  // 快手、B站没有“按日粉丝总数”的趋势接口：用每天快照里记下的粉丝总数连成线（从开始记录那天起）
  latestFansTrend.kuaishou = [];
  latestFansTrend.bili = [];
  for (const [day, snap] of snaps) {
    for (const pk of ['kuaishou', 'bili']) {
      if (snap[pk] && snap[pk].fansTotal != null) latestFansTrend[pk].push({ date: day, total: snap[pk].fansTotal });
    }
  }

  // —— TOP10 作品（最新一天快照） ——
  const topWorks = [];
  {
    const lastDay = [...snaps.keys()].pop();
    const s = lastDay && snaps.get(lastDay);
    if (s) {
      const all = [];
      for (const [pk, snap] of Object.entries(s)) {
        for (const w of snap.works) {
          all.push({
            platform: PLATFORM_LABEL[pk],
            title: w.title,
            publishTime: w.publishTime || '',
            play: num(w.play),
            like: num(w.like),
            comment: num(w.comment),
            completion: num(w.completion),
            link: w.link || '',
          });
        }
      }
      all.sort((a, b) => (b.play || 0) - (a.play || 0));
      topWorks.push(...all.slice(0, 10));
    }
  }

  // —— 指标卡 ——
  const lastDay = [...snaps.keys()].pop();
  const lastSnap = lastDay && snaps.get(lastDay);
  const fansChannels = (lastSnap && lastSnap.channels && lastSnap.channels.fansTotal) || null;
  const fansDouyin = (lastSnap && lastSnap.douyin && lastSnap.douyin.fansTotal) || null;
  const fansKuaishou = (lastSnap && lastSnap.kuaishou && lastSnap.kuaishou.fansTotal) || null;
  const fansBili = (lastSnap && lastSnap.bili && lastSnap.bili.fansTotal) || null;
  let lastDayPlayGain = null;
  if (playGain.dates.length) {
    const i = playGain.dates.length - 1;
    const vals = [playGain.channels[i], playGain.douyin[i], playGain.kuaishou[i], playGain.bili[i]];
    if (vals.some((v) => v !== null)) lastDayPlayGain = vals.reduce((s, v) => s + (v || 0), 0);
  }
  // 发布内容：内容目录里的条目，各平台播放从快照按标题+日期匹配补上
  const published = attachSnapshotPerf(contentDir ? listPublished(contentDir) : { available: false, reason: '未设置内容目录' }, snaps);

  // —— 新鲜度 ——
  const freshness = platforms.map((pk) => {
    const ds = [...snaps.keys()].filter((d) => snaps.get(d)[pk]);
    return { platform: PLATFORM_LABEL[pk], lastDay: ds[ds.length - 1] || null, days: ds.length };
  });

  const data = {
    generatedAt: new Date().toISOString(),
    days: [...snaps.keys()],
    metrics: {
      contentTotal: published.available ? published.total : null,
      contentLast7: published.available ? published.last7 : null,
      fansChannels,
      fansDouyin,
      fansKuaishou,
      fansBili,
      lastDayPlayGain,
      lastDay: lastDay || null,
    },
    playGain,
    fansTrend: latestFansTrend,
    topWorks,
    published,
    freshness,
  };
  cache.at = Date.now();
  cache.data = data;
  return data;
}

module.exports = { buildDashboard, loadSnapshots, readSnapshot, invalidate: () => { cache.data = null; } };
