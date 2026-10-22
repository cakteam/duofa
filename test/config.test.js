'use strict';
// 配置：没有 config.json 时用默认值（自带示例内容、端口 8686、视频号不自动声明原创）；环境变量优先于文件。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../lib/config');

test('没有 config.json：默认值', () => {
  const c = config.load({ fresh: true, env: {}, file: '/nonexistent/config.json' });
  assert.strictEqual(c.contentDir, path.join(config.APP_DIR, '示例内容'));
  assert.strictEqual(c.dataDir, path.join(c.contentDir, '数据下载'));
  assert.strictEqual(c.port, 8686);
  assert.deepStrictEqual(c.channels, { hideLocation: true, declareOriginal: false });
});

test('config.json 的值生效，~/ 展开；环境变量优先', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ contentDir: '~/视频', port: 9000, channels: { declareOriginal: true } }));
  const c = config.load({ fresh: true, env: {}, file });
  assert.strictEqual(c.contentDir, path.join(os.homedir(), '视频'));
  assert.strictEqual(c.port, 9000);
  assert.deepStrictEqual(c.channels, { hideLocation: true, declareOriginal: true });
  const e = config.load({ fresh: true, env: { DUOFA_CONTENT_DIR: dir, DUOFA_DATA_DIR: '/tmp/x', PORT: '9100' }, file });
  assert.deepStrictEqual([e.contentDir, e.dataDir, e.port], [dir, path.resolve('/tmp/x'), 9100]);
  config.load({ fresh: true }); // 还原成真实配置，免得影响同一进程里的其他用例
});
