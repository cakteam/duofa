'use strict';
// 短标题（16 字、不在句中截断）、视频号话题收尾、填表账本。
const test = require('node:test');
const assert = require('node:assert');
const { deriveFields } = require('../lib/parse');

test('视频号短标题：两行合起来 ≤16 字就整条用，不再只取第一行', () => {
  assert.strictEqual(deriveFields({ titleLines: ['困扰数学界30年', '书生S2破解猜想'], tags: [] }).channelsShortTitle, '困扰数学界30年书生S2破解猜想');
  assert.strictEqual(deriveFields({ titleLines: ['信号飞行超百亿年', '最远快速射电暴'], tags: [] }).channelsShortTitle, '信号飞行超百亿年最远快速射电暴');
});

test('视频号短标题：超过 16 字取整行（不在句中截断）；文案里单写的【视频号短标题】优先', () => {
  const long = deriveFields({ titleLines: ['一二三四五六七八九', '甲乙丙丁戊己庚辛'], tags: [] }).channelsShortTitle;
  assert.strictEqual(long, '甲乙丙丁戊己庚辛');
  assert.strictEqual(deriveFields({ titleLines: ['困扰数学界30年', '书生S2破解猜想'], shortTitle: 'AI首破数学30年难题', tags: [] }).channelsShortTitle, 'AI首破数学30年难题');
  assert.strictEqual(deriveFields({ titleLines: ['短'], tags: [] }).channelsShortTitle.length >= 6, true);
});

test('填表账本：同一条目×平台后一次覆盖前一次，落盘后能读回', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  try {
    const file = path.join(dir, 'sub', 'ledger.json');
    const a = require('../lib/fill-ledger').create({ file });
    a.note({ dir: '/x/1', platform: 'bili', scheduled: false });
    a.note({ dir: '/x/1', platform: 'bili', scheduled: true, scheduledAt: '2026-10-16T00:30:00.000Z' });
    a.note({ dir: '/x/1', platform: 'douyin' });
    a.note({ platform: 'douyin' });                                  // 缺 dir：忽略
    const b = require('../lib/fill-ledger').create({ file });
    assert.strictEqual(b.list().length, 2);
    assert.strictEqual(b.list().find((r) => r.platform === 'bili').scheduled, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
