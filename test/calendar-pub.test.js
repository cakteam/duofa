'use strict';
// 日历按填表账本上色：账本里的「条目目录 × 平台」记录按目录归好，平台名换成中文。
// 运行：node --test test/calendar-pub.test.js
const test = require('node:test');
const assert = require('node:assert');
const { indexLedger, latestByPlatform, STD_PLATFORMS, BILI_PLATFORMS } = require('../lib/calendar-pub');

test('按条目目录归好每个平台的填表记录；设了定时的记 scheduled，没设的记 filled', () => {
  const m = indexLedger([
    { dir: '/c/1101/1101-1-甲', platform: 'channels', scheduled: true, scheduledAt: '2026-11-01T00:30:00.000Z', at: '2026-10-31T10:00:00.000Z' },
    { dir: '/c/1101/1101-1-甲', platform: 'douyin', scheduled: false, scheduledAt: null, at: '2026-10-31T10:01:00.000Z' },
    { dir: '/c/1101/B站', platform: 'bili', scheduled: true, scheduledAt: '2026-11-01T10:00:00.000Z', at: '2026-10-31T10:02:00.000Z' },
  ]);
  assert.deepStrictEqual(m.get('/c/1101/1101-1-甲').map((p) => `${p.platform}:${p.state}:${p.at}`), ['视频号:scheduled:2026-11-01T00:30:00.000Z', '抖音:filled:2026-10-31T10:01:00.000Z']);
  assert.deepStrictEqual(m.get('/c/1101/B站').map((p) => p.platform), ['B站']);
});

test('空账本、坏记录、不认识的平台：都跳过，不抛错', () => {
  assert.strictEqual(indexLedger(null).size, 0);
  assert.strictEqual(indexLedger([null, {}, { dir: '/x' }, { dir: '/x', platform: 'tiktok' }]).size, 0);
});

test('同一平台只取最后一条；预期平台列表', () => {
  const r = latestByPlatform([{ platform: '视频号', state: 'filled' }, { platform: '抖音', state: 'filled' }, { platform: '视频号', state: 'scheduled' }]);
  assert.deepStrictEqual(r.map((p) => `${p.platform}:${p.state}`), ['视频号:scheduled', '抖音:filled']);
  assert.deepStrictEqual(STD_PLATFORMS, ['视频号', '抖音', '快手']);
  assert.deepStrictEqual(BILI_PLATFORMS, ['B站']);
});
