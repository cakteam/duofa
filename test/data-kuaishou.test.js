'use strict';
// 快手数据：作品列表/趋势/作品分析的整理；看板里按定时发布的那一刻匹配内容。
// 运行：node --test test/data-kuaishou.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normListItem, normOverview, mergeAnalysis, analysisList, sinceMs, workLink, KUAISHOU_SINCE } = require('../lib/data-kuaishou');
const { attachSnapshotPerf } = require('../lib/match');

const at = (s) => new Date(s.replace(' ', 'T') + ':00').getTime();
const item = (o) => ({ publishId: 0, workId: '3xabc', title: '10月13日，某某事件 #科技资讯', playCount: 12, likeCount: 3, commentCount: 1, uploadTime: at('2026-10-15 08:30'), durationSecond: 15, publishStatus: 4, ...o });

test('默认不设起始日（全部作品都记）；设了 KUAISHOU_SINCE 时更早的作品不记', () => {
  assert.strictEqual(KUAISHOU_SINCE, '1970-01-01');
  assert.ok(at('2020-01-01 08:00') >= sinceMs());
  assert.ok(at('2026-09-30 20:00') < sinceMs('2026-10-15'));
  assert.ok(at('2026-10-15 08:30') >= sinceMs('2026-10-15'));
});

test('作品列表条目：播放/点赞/评论/发布时间/链接；待发布（定时没到）不算', () => {
  const now = at('2026-10-15 09:00');
  const w = normListItem(item({}), now);
  assert.deepStrictEqual([w.id, w.play, w.like, w.comment, w.share, w.completion, w.publishTime], ['3xabc', 12, 3, 1, null, null, '2026-10-15 08:30']);
  assert.strictEqual(w.link, workLink('3xabc'));
  assert.strictEqual(w.link, 'https://www.kuaishou.com/short-video/3xabc');
  assert.strictEqual(normListItem(item({ publishStatus: 1, workId: null, publishId: 3672752346, uploadTime: at('2026-10-15 21:00') }), now), null, '待发布不记');
  assert.ok(normListItem(item({ publishStatus: 1, workId: null, publishId: 99, uploadTime: at('2026-10-15 08:30') }), now), '定时已到点的要记');
});

test('趋势只留起始日之后，日期转成 YYYY-MM-DD', () => {
  const trend = (name, vals) => ({ name, endDayCount: vals[vals.length - 1][1], trendData: vals.map(([d, c]) => ({ date: d, count: c })) });
  const o = normOverview([trend('播放量', [['20261013', 5], ['20261015', 40], ['20261016', 60]]), trend('点赞量', [['20261015', 2]])], '2026-10-15');
  assert.deepStrictEqual(o.rows, [{ 日期: '2026-10-15', 播放量: 40, 点赞量: 2 }, { 日期: '2026-10-16', 播放量: 60 }]);
  assert.strictEqual(o.latest['播放量'], 60);
});

test('作品分析页的分享/完播按作品 ID 补上；百分数转 0~1', () => {
  const works = [{ id: '3xabc', share: null, completion: null }, { id: '3xdef', share: null, completion: null }];
  assert.strictEqual(mergeAnalysis(works, [{ workId: '3xabc', shareCount: 4, completeRatio: 31.5 }, { photoId: 'nope', shareCount: 9 }]), 1);
  assert.deepStrictEqual([works[0].share, works[0].completion, works[1].share], [4, 0.315, null]);
});

test('作品分析接口的列表：直接是数组、包一层对象、没有，都能取到（不再报 list.slice is not a function）', () => {
  assert.deepStrictEqual(analysisList({ photoList: [1, 2] }), [1, 2]);
  assert.deepStrictEqual(analysisList({ list: { total: 2, items: [3] } }), [3]);
  assert.deepStrictEqual(analysisList({ list: { total: 0 } }), []);
  assert.deepStrictEqual(analysisList(null), []);
});

function snaps(works) {
  return new Map([['2026-10-16', { kuaishou: { works: works.map((w) => ({ ...w, date: undefined })), fetchedAt: '2026-10-16T02:00:00.000Z' } }]]);
}
const published = () => ({
  available: true,
  rows: [
    { itemId: '1015-1-甲', pubDate: '2026-10-15', plannedTime: '08:30', slotType: '', title: '短标题甲', hookWord: '甲甲', platforms: {} },
    { itemId: '1015-2-乙', pubDate: '2026-10-15', plannedTime: '12:15', slotType: '', title: '短标题乙', hookWord: '乙乙', platforms: {} },
  ],
});

test('快手按定时发布的时刻匹配（描述里没有短标题）', () => {
  const ws = [
    { id: 'k1', title: '一大段简介，和短标题毫无相似 #话题', publishTime: '2026-10-15 12:15', play: 50, like: 5, comment: 1 },
    { id: 'k2', title: '另一段简介 #话题', publishTime: '2026-10-15 08:30', play: 80, like: 7, comment: 2 },
  ];
  const p = attachSnapshotPerf(published(), snaps(ws));
  const [a, b] = p.rows;
  assert.strictEqual(a.platforms.kuaishou.views, 80);
  assert.strictEqual(b.platforms.kuaishou.views, 50);
  assert.strictEqual(a.platforms.kuaishou.source, 'snapshot');
  assert.strictEqual(p.matchStats.kuaishou, 2);
});

test('时刻对不上时，作品描述里带钩子词也能配上', () => {
  const ws = [{ id: 'k9', title: '描述里提到乙乙这个词 #话题', publishTime: '2026-10-15 13:40', play: 9, like: 0, comment: 0 }];
  const p = attachSnapshotPerf(published(), snaps(ws));
  assert.strictEqual(p.rows[1].platforms.kuaishou.views, 9);
  assert.strictEqual(p.rows[0].platforms.kuaishou, undefined);
});

test('看板：快手播放增量按相邻两天快照差分，粉丝数取 raw.profile.fansCnt', (t) => {
  const { buildDashboard } = require('../lib/dashboard');
  const save = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-ksdash-'));
  t.after(() => fs.rmSync(save, { recursive: true, force: true }));
  const snap = (day, plays) => {
    fs.mkdirSync(path.join(save, day), { recursive: true });
    fs.writeFileSync(path.join(save, day, '快手_原始数据.json'), JSON.stringify({
      fetchedAt: `${day}T02:00:00.000Z`, overview: [], trend: [], raw: { profile: { fansCnt: 330 } },
      works: plays.map((p, i) => ({ id: `k${i}`, title: `作品${i}`, publishTime: `${day} 08:30`, play: p, like: 1, comment: 0 })),
    }));
  };
  snap('2026-10-16', [100, 50]);
  snap('2026-10-17', [160, 90]);
  const d = buildDashboard(save, { fresh: true });
  assert.deepStrictEqual(d.playGain.kuaishou, [null, 100]);
  assert.strictEqual(d.metrics.fansKuaishou, 330);
  assert.ok(d.freshness.some((f) => f.platform === '快手' && f.lastDay === '2026-10-17'));
});
