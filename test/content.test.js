'use strict';
// 内容目录格式（docs/内容格式.md）：日期目录名的两种写法、建议发布时间的几种写法、B站文案新旧格式、看板的「发布内容」。
// 运行：node --test test/content.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanDateFolder, deriveFields, inferDateFromFolderName, listDateFolders } = require('../lib/parse');
const { listPublished } = require('../lib/published');

const EXAMPLE = path.join(__dirname, '..', '示例内容');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-content-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function item(root, rel, txt, files = ['成片.mp4']) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  if (txt != null) fs.writeFileSync(path.join(dir, rel.includes('B站') ? 'B站发布文案.txt' : '发布文案.txt'), txt);
  return dir;
}

const local = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

test('日期目录名：MMDD、YYYY-MM-DD、YYYYMMDD 都认', () => {
  assert.deepStrictEqual(inferDateFromFolderName('1101'), { month: 11, day: 1 });
  assert.deepStrictEqual(inferDateFromFolderName('2026-11-01'), { year: 2026, month: 11, day: 1 });
  assert.deepStrictEqual(inferDateFromFolderName('20261101'), { year: 2026, month: 11, day: 1 });
  assert.deepStrictEqual(inferDateFromFolderName('1101-2-标题'), { month: 11, day: 1 });
});

test('自带的示例内容：两条常规 + 一条 B站，字段和定时都解析出来', () => {
  const topics = scanDateFolder(path.join(EXAMPLE, '1101'));
  assert.deepStrictEqual(topics.map((t) => [t.kind || 'std', t.name]), [
    ['std', '1101-1-猫为什么爱踩奶'],
    ['std', '1101-2-一分钟看懂潮汐'],
    ['bili', 'B站'],
  ]);
  const [a, b, bili] = topics;
  assert.ok(a.video.endsWith('成片.mp4'));
  assert.strictEqual(local(a.scheduledAt).slice(5), '11-01 08:30');
  assert.strictEqual(local(b.scheduledAt).slice(5), '11-01 12:15', '只写时刻时用目录日期');
  assert.strictEqual(local(bili.scheduledAt).slice(5), '11-01 18:00');
  const fa = deriveFields(a);
  assert.strictEqual(fa.channelsShortTitle, '猫为什么爱踩奶');
  assert.strictEqual(fa.douyinTitle, '猫为什么爱踩奶？答案藏在小时候');
  assert.deepStrictEqual(fa.tags, ['猫', '萌宠', '冷知识']);
  assert.ok(!fa.douyinDesc.includes('#'), '正文里的 #话题 不重复进描述');
  assert.ok(fa.channelsCover.endsWith('3x4封面.png'));
  assert.strictEqual(deriveFields(b).douyinCoverLandscape, '', '没有 4x3 封面时横封面留空');
  const fb = deriveFields(bili);
  assert.strictEqual(fb.biliTitle, '示例：本周冷知识合集（猫踩奶 + 潮汐）');
  assert.ok(fb.biliCover.endsWith('B站封面.png'));
});

test('建议发布时间写成 YYYY-MM-DD HH:MM 也行；没有文案只有成片也算一条', (t) => {
  const root = tmp(t);
  item(root, '2026-11-02/1102-1-甲', '【标题】\n甲\n\n【建议发布时间】\n2026-11-03 07:05\n');
  item(root, '2026-11-02/1102-2-乙', null);
  item(root, '2026-11-02/素材', null);
  const topics = scanDateFolder(path.join(root, '2026-11-02'));
  assert.deepStrictEqual(topics.map((x) => x.name), ['1102-1-甲', '1102-2-乙'], '「素材」文件夹不是内容');
  assert.strictEqual(local(topics[0].scheduledAt), '2026-11-03 07:05');
  assert.strictEqual(topics[1].scheduledAt, null);
});

test('文案是 Windows 记事本存的：带 BOM、CRLF 换行、或 GBK（ANSI）编码，都能读', (t) => {
  const root = tmp(t);
  const a = item(root, '1104/1104-1-甲', null);
  fs.writeFileSync(path.join(a, '发布文案.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('【标题】\r\n甲标题\r\n【正文】\r\n正文 #话题\r\n')]));
  const b = item(root, '1104/1104-2-乙', null);
  // 「【标题】\r\n你好」的 GBK 编码
  fs.writeFileSync(path.join(b, '发布文案.txt'), Buffer.from([0xa1, 0xbe, 0xb1, 0xea, 0xcc, 0xe2, 0xa1, 0xbf, 0x0d, 0x0a, 0xc4, 0xe3, 0xba, 0xc3]));
  const [ta, tb] = scanDateFolder(path.join(root, '1104'));
  assert.deepStrictEqual(ta.titleLines, ['甲标题']);
  assert.deepStrictEqual(ta.tags, ['话题']);
  assert.deepStrictEqual(tb.titleLines, ['你好']);
});

test('B站旧版文案格式（候选 1 + 标签系统）照样能读', (t) => {
  const root = tmp(t);
  item(root, '1103/B站', '标题候选：\n候选 1（推荐）：\n旧格式标题\n\n【视频简介】\n=====\n简介正文\n=====\n🏷️【标签系统】\n#甲 #乙\n建议公开时间：12:00\n', ['B站.mp4']);
  const [bili] = scanDateFolder(path.join(root, '1103'));
  assert.strictEqual(bili.kind, 'bili');
  assert.deepStrictEqual(bili.titleLines, ['旧格式标题']);
  assert.deepStrictEqual(bili.tags, ['甲', '乙']);
});

test('看板「发布内容」：扫描内容目录，只列有成片且日期不晚于今天的常规条目；B站标题按日期给出', (t) => {
  const root = tmp(t);
  item(root, '2026-11-01/1101-1-甲', '【标题】\n甲标题\n【标红钩子词】：甲\n【建议发布时间】\n08:30\n');
  item(root, '2026-11-01/1101-2-乙', '【标题】\n乙标题\n', []);
  item(root, '2026-11-01/B站', '【标题】\nB站标题\n', ['B站.mp4']);
  item(root, '2026-11-09/1109-1-丙', '【标题】\n丙标题\n');
  item(root, '数据下载/2026-11-02', null, []);
  assert.deepStrictEqual(listDateFolders(root), ['2026-11-09', '2026-11-01']);
  const p = listPublished(root, { now: new Date(2026, 10, 5, 12, 0) });
  assert.strictEqual(p.available, true);
  assert.deepStrictEqual(p.rows.map((r) => [r.itemId, r.pubDate, r.plannedTime, r.title, r.hookWord]), [['1101-1-甲', '2026-11-01', '08:30', '甲标题', '甲']]);
  assert.deepStrictEqual([p.total, p.last7], [1, 1]);
  assert.deepStrictEqual(p.biliEpisodes, { '2026-11-01': 'B站标题' });
  assert.strictEqual(listPublished(path.join(root, 'nope')).available, false);
});
