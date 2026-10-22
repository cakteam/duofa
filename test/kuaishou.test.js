'use strict';
// 快手填表（lib/kuaishou.js）里不碰真实页面的部分：描述 + 话题的拼法（上限 4）、定时时间格式。
// 真实页面的选择器与流程是 2026-10-14 在 cp.kuaishou.com 逐步实测的（见 lib/kuaishou.js 文件头）。
const test = require('node:test');
const assert = require('node:assert');
const { composeDescription, fmtWhen, MAX_TAGS, UPLOAD_URL } = require('../lib/kuaishou');

test('话题上限 4：去重、去掉前导 #、超出的丢掉并告诉是哪些', () => {
  assert.strictEqual(MAX_TAGS, 4);
  const r = composeDescription('一段简介。', ['科技资讯', '#每日科普', '科技资讯', '韦布望远镜', '系外行星', '熔岩行星']);
  assert.strictEqual(r.text, '一段简介。 #科技资讯 #每日科普 #韦布望远镜 #系外行星');
  assert.deepStrictEqual(r.tags, ['科技资讯', '每日科普', '韦布望远镜', '系外行星']);
  assert.deepStrictEqual(r.dropped, ['熔岩行星']);
  assert.deepStrictEqual(composeDescription('x', []).tags, []);
  assert.strictEqual(composeDescription('  简介 ', ['甲']).text, '简介 #甲');
  assert.strictEqual(composeDescription('', ['甲']).text, ' #甲');
});

test('定时时间按 antd 日期时间框的格式 YYYY-MM-DD HH:mm:00（本地时间）', () => {
  assert.strictEqual(fmtWhen(new Date(2026, 9, 15, 8, 30)), '2026-10-15 08:30:00');
  assert.strictEqual(fmtWhen(new Date(2026, 0, 2, 21, 5, 59)), '2026-01-02 21:05:00');
  assert.match(UPLOAD_URL, /^https:\/\/cp\.kuaishou\.com\/article\/publish\/video$/);
});
