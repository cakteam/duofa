'use strict';
/**
 * 内容目录里的条目（lib/published.js）↔ 每日下载快照作品（数据下载/日期/平台_原始数据.json）匹配。
 * 两边没有共用 ID，只能靠「标题 + 发布日期」对：
 *   - 标题：去空格标点后前缀包含直接算命中；否则取「公共前缀占比」与「二字组重合率」较大者，
 *     作品标题里出现钩子词再加分（视频号短标题常被改写，如「德国搜索弃用欧洲模型」↔「德国搜索弃用欧模 全面转向中国AI」）
 *   - 日期：作品日期在文章发布日 ±1 天内（视频号定时作品的时间是点「发表」的时间，常在前一晚）
 *   - 全局按分数从高到低一对一分配，同一作品不会被两篇文章认领
 * 只读：看板展示时现算。
 */

const { KUAISHOU_SINCE } = require('./data-kuaishou');

const MATCH_MIN = 0.5;
// 第二轮：第一轮剩下的文章与作品，在 ±1 天内用更低门槛再配一次（短标题改写较多的情况）
const MATCH_MIN_LEFTOVER = 0.3;

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
}

function workDate(publishTime) {
  const m = String(publishTime || '').match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

function dayDiff(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00') - Date.parse(b + 'T00:00:00')) / 86400e3);
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 标题相似度 0~1 */
function titleScore(articleTitle, hookWord, workTitle) {
  const A = norm(articleTitle);
  const full = norm(workTitle);
  const W = full.slice(0, A.length + 6);
  if (!A || !W) return 0;
  if (W.startsWith(A) || (W.length >= 6 && A.startsWith(W))) return 1;
  let pre = 0;
  while (pre < A.length && pre < W.length && A[pre] === W[pre]) pre++;
  const preRatio = pre / Math.min(A.length, W.length);
  const ba = bigrams(A);
  const bw = bigrams(W);
  let inter = 0;
  for (const g of ba) if (bw.has(g)) inter++;
  let s = Math.max(preRatio, inter / Math.max(1, ba.size));
  const hook = norm(hookWord);
  if (hook && full.includes(hook)) s += 0.25;
  // 钩子词只出现一部分（「BEST装置」↔「BEST进入攻坚阶段」）：其中 3 位以上的英文/数字片段命中也加分
  else if (hook && (hook.match(/[a-z0-9]{3,}/g) || []).some((t) => full.includes(t))) s += 0.15;
  return Math.min(s, 1);
}

/** 抖音旧快照里的 19 位 ID 曾丢精度（末几位变 0），去重时只比前 15 位 */
function workKey(pk, id, w) {
  const s = String(id || '') || `${w.publishTime}|${String(w.title).slice(0, 12)}`;
  return pk === 'douyin' && /^\d{17,}$/.test(s) ? s.slice(0, 15) : s;
}

/**
 * 汇总所有快照为「每平台作品最新一版」索引。
 * snaps: Map(day -> {platform: {works, fetchedAt}})，day 升序；后出现的覆盖先出现的。
 */
function buildWorksIndex(snaps) {
  const index = { channels: new Map(), douyin: new Map(), kuaishou: new Map(), bili: new Map() };
  const latest = {};
  for (const [day, byPk] of snaps) {
    for (const [pk, snap] of Object.entries(byPk)) {
      if (!index[pk]) continue;
      let minDate = null;
      for (const w of snap.works || []) {
        const date = workDate(w.publishTime);
        if (!date) continue;
        if (!minDate || date < minDate) minDate = date;
        index[pk].set(workKey(pk, w.id, w), { ...w, date, asOf: day });
      }
      latest[pk] = { day, fetchedAt: snap.fetchedAt || null, minDate };
    }
  }
  // 旧快照里有、最新快照覆盖的日期范围内却没有的作品 = 已删除（如定时后删掉重发，ID 会变），不参与匹配；
  // 早于最新快照覆盖范围的旧作品保留（抖音表现接口只给最近 200 条，更早的只能用旧快照）
  const works = {};
  for (const [pk, m] of Object.entries(index)) {
    const lt = latest[pk];
    works[pk] = [...m.values()].filter((w) => !lt || w.asOf === lt.day || (lt.minDate && w.date < lt.minDate));
  }
  return { works, latest };
}

/** 文章计划发布时刻（slot_type「早通勤(08:30)」或 planned_time「10月9日 08:30（…）」里的时间） */
function scheduledAt(row) {
  const m = String(row.slotType || '').match(/(\d{1,2}):(\d{2})/) || String(row.plannedTime || '').match(/(\d{1,2}):(\d{2})/);
  const hh = m ? m[1].padStart(2, '0') : '00';
  const mm = m ? m[2] : '00';
  return new Date(`${row.pubDate}T${hh}:${mm}:00`);
}

function perfOf(w) {
  return {
    id: w.id || null,
    publishTime: w.publishTime || '',
    views: w.play,
    likes: w.like,
    comments: w.comment,
    shares: w.share,
    favorites: w.favorite ?? null,
    coins: w.coin ?? null,
    danmaku: w.danmaku ?? null,
    completion: w.completion,
    link: w.link || '',
    workTitle: w.title,
    approx: /作品管理页/.test((w.extra && w.extra.来源) || ''), // 抖音当天新发：播放是页面显示的约数（如 1.1万）
    asOf: w.asOf,
    source: 'snapshot',
  };
}

/**
 * 快手只有一个「作品描述」框（我们的整段简介），没有短标题可比；改按定时发布的那一刻匹配：
 * 作品发布时间与文章档期（08:30/12:15…）相差 10 分钟内 = 1；否则作品描述里带钩子词给 0.6，其余不配。
 */
function kuaishouScore(r, w) {
  const at = scheduledAt(r).getTime();
  const wt = Date.parse(`${String(w.publishTime).replace(' ', 'T')}:00`);
  if (Number.isFinite(wt) && Math.abs(wt - at) <= 10 * 60e3) return 1;
  const hook = norm(r.hookWord);
  return hook && norm(w.title).includes(hook) ? 0.6 : 0;
}

/** 一个平台：文章 ↔ 作品 一对一分配（score 默认按标题相似度） */
function assign(rows, works, score = (r, w) => titleScore(r.title, r.hookWord, w.title)) {
  const pairs = [];
  rows.forEach((r, ri) => {
    for (let wi = 0; wi < works.length; wi++) {
      const w = works[wi];
      const dd = dayDiff(w.date, r.pubDate);
      if (dd < -1 || dd > 1) continue;
      const s = score(r, w);
      if (s >= MATCH_MIN_LEFTOVER) pairs.push({ ri, wi, s: s - Math.abs(dd) * 0.01 });
    }
  });
  pairs.sort((a, b) => b.s - a.s);
  const usedR = new Set();
  const usedW = new Set();
  const out = new Map();
  for (const min of [MATCH_MIN, MATCH_MIN_LEFTOVER]) {
    for (const p of pairs) {
      if (p.s < min - 0.02 || usedR.has(p.ri) || usedW.has(p.wi)) continue;
      usedR.add(p.ri);
      usedW.add(p.wi);
      out.set(p.ri, works[p.wi]);
    }
  }
  return out;
}

/**
 * 给 published.rows 补上快照里的各平台表现（就地修改并返回 published）。
 *   row.platforms.wechat / douyin / kuaishou：快照匹配到的作品表现
 *   row.platforms.*.pending：最新快照抓取时这条还没到发布时间（定时作品此时播放为 0 或还没出现）
 *   row.biliDay：当天 B站条目的表现（按当天 B站条目标题匹配，同一天的内容共享）
 */
function attachSnapshotPerf(published, snaps) {
  if (!published || !published.available) return published;
  const { works, latest } = buildWorksIndex(snaps);
  const rows = published.rows;
  const plat = [['channels', 'wechat'], ['douyin', 'douyin'], ['kuaishou', 'kuaishou']];

  for (const [pk, dbKey] of plat) {
    // 快手从 KUAISHOU_SINCE 起才有这个账号上的内容，之前的文章不参与（也不显示“未发”）
    const inScope = pk === 'kuaishou' ? (r) => r.pubDate >= KUAISHOU_SINCE : () => true;
    const idx = rows.map((r, i) => i).filter((i) => inScope(rows[i]));
    const sub = assign(idx.map((i) => rows[i]), works[pk] || [], pk === 'kuaishou' ? kuaishouScore : undefined);
    const matched = new Map([...sub.entries()].map(([k, w]) => [idx[k], w]));
    const fetched = latest[pk] && latest[pk].fetchedAt ? new Date(latest[pk].fetchedAt) : null;
    rows.forEach((r, i) => {
      r.platforms = r.platforms || {};
      if (!inScope(r)) return;
      const w = matched.get(i);
      const at = scheduledAt(r);
      const notYet = fetched && fetched < at;
      // 抖音作品表现是 T+1：发布后一天半内抓的快照里可能还没有这条
      const lag = pk !== 'kuaishou' && !w && fetched && fetched - at < 36 * 3600e3;
      if (w && !(notYet && !w.play)) {
        r.platforms[dbKey] = perfOf(w);
      } else if (notYet) {
        r.platforms[dbKey] = { ...(r.platforms[dbKey] || {}), pending: true };
      } else if (lag && !r.platforms[dbKey]) {
        r.platforms[dbKey] = { lag: true };
      } else if (r.platforms[dbKey]) {
        r.platforms[dbKey].source = 'db';
      }
    });
  }

  // B站：按日期找当天的 B站作品（有当天 B站条目标题时取最像的那条）
  const biliWorks = works.bili || [];
  const biliFetched = latest.bili && latest.bili.fetchedAt ? new Date(latest.bili.fetchedAt) : null;
  const byDate = new Map();
  for (const r of rows) {
    if (byDate.has(r.pubDate)) continue;
    const epTitle = (published.biliEpisodes || {})[r.pubDate] || '';
    const sameDay = biliWorks.filter((w) => w.date === r.pubDate);
    let best = null;
    let bestScore = -1;
    if (epTitle) {
      for (const w of sameDay) {
        const s = titleScore(epTitle, '', w.title);
        if (s > bestScore) { best = w; bestScore = s; }
      }
    }
    if (best && bestScore >= 0.3) byDate.set(r.pubDate, perfOf(best));
    else if (biliFetched && biliFetched < new Date(`${r.pubDate}T12:00:00`)) byDate.set(r.pubDate, { pending: true });
    else byDate.set(r.pubDate, null);
  }
  for (const r of rows) r.biliDay = byDate.get(r.pubDate) || null;

  published.kuaishouSince = KUAISHOU_SINCE;
  published.asOf = Object.fromEntries(Object.entries(latest).map(([pk, v]) => [pk, v.day]));
  published.matchStats = Object.fromEntries(
    ['wechat', 'douyin', 'kuaishou'].map((k) => [k, rows.filter((r) => r.platforms[k] && r.platforms[k].source === 'snapshot').length])
  );
  return published;
}

module.exports = { attachSnapshotPerf, titleScore, buildWorksIndex, norm };
