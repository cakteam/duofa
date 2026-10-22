'use strict';
// 服务进程级的发布测试：真的起 `node server.js`，通过 POST /api/publish 发起“填表”，用 /api/state 观察进度。
// 浏览器换成装着假平台页面的 headless Chrome（test/helpers/preload-mock-browser.js），其余全是真实代码。
// 验证：请求里的 parallel 开关生效；并行时 /api/state 里同时有多个“正在填写”的单元；串行时同一时刻只有一个；结果与进度正确。
// 运行：node --test test/publish-server.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const { HAVE_CHROME } = require('./helpers/chrome');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function startServer(mocks) {
  const port = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-pub-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-pub-data-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-pub-profile-'));
  const env = {
    ...process.env, PORT: String(port), DUOFA_CONTENT_DIR: root, DUOFA_STATE_DIR: data, CHROME_PROFILE_DIR: profile,
    NO_OPEN: '1', AUTO_BROWSER: '0', DUOFA_TTY: '', DUOFA_AUTO_QUIT: '0',
    NODE_OPTIONS: `--require ${path.join(__dirname, 'helpers', 'preload-mock-browser.js')}`,
    DUOFA_TEST_MOCKS: JSON.stringify(mocks),
  };
  delete env.PUBLISH_PARALLEL;
  const child = spawn(process.execPath, ['server.js'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(`${base}/api/state`)).ok) break; } catch { /* 还没起来 */ }
    if (Date.now() - t0 > 30000) throw new Error(`服务没起来\n${out}`);
    await sleep(100);
  }
  const post = async (body) => {
    const res = await fetch(`${base}/api/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const state = async () => (await (await fetch(`${base}/api/state`)).json()).job;
  /** 轮询直到任务结束，顺便记下同时在做的单元数、stage 文本。 */
  const watch = async (timeoutMs = 120000) => {
    const seen = { maxCurrents: 0, maxCurrentField: 0, parallelFlags: new Set(), stages: new Set(), platformsTogether: new Set() };
    const t = Date.now();
    for (;;) {
      const j = await state();
      seen.maxCurrents = Math.max(seen.maxCurrents, (j.currents || []).length);
      if (j.current) seen.maxCurrentField = Math.max(seen.maxCurrentField, 1);
      if (j.running) {
        seen.parallelFlags.add(j.parallel);
        if (j.progress) seen.stages.add(j.progress.stage);
        if ((j.currents || []).length > 1) seen.platformsTogether.add(j.currents.map((c) => c.platform).sort().join('+'));
      }
      if (!j.running && j.finishedAt) return { job: j, seen };
      if (Date.now() - t > timeoutMs) throw new Error(`任务没在 ${timeoutMs}ms 内结束\n${out}`);
      await sleep(80);
    }
  };
  const cleanup = async () => {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { execFileSync('pkill', ['-f', `user-data-dir=${profile}`], { stdio: 'ignore' }); } catch { /* 没有残留 */ }
    await sleep(500); // 等 Chrome 进程真的退干净，否则它还在往档案目录里写文件，删不掉
    for (const d of [root, data, profile]) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* 临时目录，删不掉也不影响测试结论 */ }
    }
  };
  return { post, state, watch, cleanup, out: () => out };
}

function payload(parallel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-pub-media-'));
  const video = path.join(dir, '成片.mp4');
  fs.writeFileSync(video, 'x');
  const std = {
    id: 't1', kind: 'std', name: '1010-1-测试', dir: path.join(dir, '1010', '1010-1-测试'), video, videoName: '成片.mp4',
    schedule: false, scheduledAt: null, coverOptions: [],
    fields: { tags: ['无人机', '导航'], channelsShortTitle: '断网断星仍能飞', channelsDesc: '视频号描述#话题', douyinTitle: '抖音标题', douyinDesc: '抖音描述#话题' },
  };
  const bili = {
    id: 'tb', kind: 'bili', name: 'B站合集', dir: path.join(dir, 'B站合集', '1010', '合集'), video, videoName: '成片.mp4',
    schedule: false, scheduledAt: null, coverOptions: [],
    fields: { tags: ['科普'], biliTitle: 'B站标题', biliDesc: 'B站简介' },
  };
  return { body: { topics: [std, bili], platforms: ['channels', 'douyin', 'bili'], ...(parallel === undefined ? {} : { parallel }) }, dir };
}

test('POST /api/publish：默认各平台同时填写 —— /api/state 里同时有多个正在填写的单元，全部成功；parallel:false 则一次一个', { skip: !HAVE_CHROME && '没有安装 Google Chrome', timeout: 240000 }, async () => {
  const s = await startServer({ channels: { uploadMs: 3500 }, douyin: { uploadMs: 3500 }, bili: { uploadMs: 3500 } });
  const media = [];
  try {
    // 参数校验仍然在
    assert.strictEqual((await s.post({})).status, 400);
    assert.strictEqual((await s.post({ topics: [{ id: 'x' }], platforms: ['douyin'] })).status, 400);

    // ① 默认（不带 parallel）= 并行
    const p1 = payload();
    media.push(p1.dir);
    const r1 = await s.post(p1.body);
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.json));
    const dup = await s.post(p1.body);
    assert.strictEqual(dup.status, 409, '已有任务在执行时再提交会被拒绝（原有行为）');
    const a = await s.watch();
    assert.strictEqual(a.job.parallel, true);
    assert.ok(a.seen.maxCurrents >= 2, `并行时应同时有多个单元，实际最多 ${a.seen.maxCurrents}`);
    assert.ok(a.seen.maxCurrentField >= 1, '兼容旧前端的 job.current 仍然有值');
    assert.ok([...a.seen.stages].some((x) => /并行执行中/.test(x)), [...a.seen.stages].join(' | '));
    const res = Object.fromEntries(a.job.topics.map((t) => [t.id, Object.keys(t.results).sort()]));
    assert.deepStrictEqual(res, { t1: ['channels', 'douyin'], tb: ['bili'] });
    for (const t of a.job.topics) for (const [p, r] of Object.entries(t.results)) assert.strictEqual(r.ok, true, `${t.id}/${p}：${r.error}`);
    assert.strictEqual(a.job.progress.done, 3);
    assert.match(a.job.progress.stage, /完成：成功 3 \/ 共 3/);
    assert.deepStrictEqual(a.job.currents, []);
    const logs = a.job.logs.map((l) => l.msg).join('\n');
    assert.match(logs, /各平台同时填写/);
    assert.match(logs, /用时 \d+ 分 \d+ 秒/);

    // ② parallel:false = 串行（和旧版一样）
    const p2 = payload(false);
    media.push(p2.dir);
    const r2 = await s.post(p2.body);
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
    const b = await s.watch();
    assert.strictEqual(b.job.parallel, false);
    assert.ok(b.seen.maxCurrents <= 1, `串行时同一时刻只有一个单元，实际最多 ${b.seen.maxCurrents}`);
    for (const t of b.job.topics) for (const [p, r] of Object.entries(t.results)) assert.strictEqual(r.ok, true, `${t.id}/${p}：${r.error}`);
    assert.match(b.job.logs.map((l) => l.msg).join('\n'), /逐个串行/);
  } finally {
    await s.cleanup();
    for (const d of media) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (_) { /* Windows 上浏览器可能还占着，留给系统清理 */ } };
  }
});
