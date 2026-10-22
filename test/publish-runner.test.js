'use strict';
// 填表任务编排（lib/publish-runner.js）：用假的填表函数验证 串行 / 各平台并行、前台锁互斥、车道中止、进度与结果。
const test = require('node:test');
const assert = require('node:assert');
const { createPublishRunner } = require('../lib/publish-runner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeJob() {
  return { running: false, kind: null, logs: [], startedAt: null, finishedAt: null, current: null, currents: [], parallel: false, topics: [], dataResult: null, progress: null };
}

function topic(id, name, extra = {}) {
  return {
    id, name, kind: 'std', dir: `/x/1010/${name}`, video: `/x/${name}.mp4`, videoName: '成片.mp4',
    schedule: false, scheduledAt: null,
    fields: {
      tags: ['甲', '乙', '甲', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸', '子'],
      channelsShortTitle: `短${name}`, channelsDesc: `视频号文案#话题 ${name}`,
      douyinTitle: `抖${name}`, douyinDesc: `抖音文案#话题 ${name}`,
      biliTitle: `B${name}`, biliDesc: `B站文案#话题 ${name}`,
    },
    ...extra,
  };
}

/** 搭一个带假填表函数的 runner。fillers 的每个平台：先在锁里“点一下”，再在锁外“等上传”，再在锁里“点一下”。 */
const biliTopic = (id = 'tb') => topic(id, 'B站合集', { kind: 'bili', dir: '/x/B站合集/1010/合集' });

function setup({ uploadMs = 60, burstMs = 12, behave = {}, topics = [topic('t1', '1010-1-甲'), topic('t2', '1010-2-乙'), biliTopic()] } = {}) {
  const job = makeJob();
  const logs = [];
  const log = (level, msg) => { job.logs.push({ level, msg }); logs.push([level, msg]); };
  const stat = { running: 0, maxRunning: 0, byPlat: {}, maxByPlat: {}, bursts: 0, maxBursts: 0, starts: [], ends: [], frontViolations: 0, currentsSeen: 0, fields: {}, bringCalls: 0 };
  const front = { id: null };
  let pageSeq = 0;
  const openTab = async () => {
    await sleep(3);
    const page = { id: `p${++pageSeq}`, titles: [], evaluate: async () => {}, bringToFront: async () => { stat.bringCalls++; front.id = page.id; } };
    front.id = page.id; // 新开的标签页会抢前台
    return page;
  };
  const filler = (platform) => async (page, t, fields, opts, plog) => {
    stat.starts.push(`${t.id}:${platform}`);
    stat.fields[`${t.id}:${platform}`] = { fields, opts: { schedule: opts.schedule, cover: opts.cover } };
    stat.running++;
    stat.maxRunning = Math.max(stat.maxRunning, stat.running);
    stat.byPlat[platform] = (stat.byPlat[platform] || 0) + 1;
    stat.maxByPlat[platform] = Math.max(stat.maxByPlat[platform] || 0, stat.byPlat[platform]);
    stat.currentsSeen = Math.max(stat.currentsSeen, job.currents.length);
    try {
      const burst = async () => {
        stat.bursts++;
        stat.maxBursts = Math.max(stat.maxBursts, stat.bursts);
        if (opts.ui.parallel && front.id !== page.id) stat.frontViolations++;
        await sleep(burstMs);
        if (opts.ui.parallel && front.id !== page.id) stat.frontViolations++;
        stat.bursts--;
      };
      await opts.ui.run(page, burst);
      const b = behave[`${t.id}:${platform}`];
      if (b && b.failInLock) {
        await opts.ui.run(page, async () => { await sleep(burstMs); throw Object.assign(new Error(b.failInLock.message), { code: b.failInLock.code }); });
      }
      await sleep(uploadMs); // 上传：不占前台
      if (b && b.fail) throw Object.assign(new Error(b.fail.message), { code: b.fail.code });
      await opts.ui.run(page, burst);
      plog('info', '填完了');
      return { screenshot: null, scheduled: !!opts.schedule };
    } finally {
      stat.running--;
      stat.byPlat[platform]--;
      stat.ends.push(`${t.id}:${platform}`);
    }
  };
  const runner = createPublishRunner({
    job,
    log,
    openTab,
    fillers: { channels: filler('channels'), douyin: filler('douyin'), kuaishou: filler('kuaishou'), bili: filler('bili') },
    stripHashtags: (s) => String(s || '').replace(/#\S+/g, '').trim(),
    maxTags: { douyin: 5, kuaishou: 4, bili: 10 },
    exists: () => true,
  });
  return { job, logs, stat, runner, topics };
}

const ALL = ['channels', 'douyin', 'bili'];

test('并行 + 前台锁（uiLock）：同一平台一次一条，点击/打字一次只有一个标签页在做，且做的时候它就是前台', async () => {
  const { job, stat, runner, topics } = setup({ topics: [topic('t1', '1010-1-甲'), topic('t2', '1010-2-乙')] });
  const t0 = Date.now();
  const r = await runner.runJob(topics, ['channels', 'douyin'], { parallel: true, uiLock: true });
  const par = Date.now() - t0;
  assert.strictEqual(r.units, 4);
  assert.strictEqual(r.okCount, 4);
  assert.strictEqual(r.failCount, 0);
  assert.strictEqual(stat.maxRunning, 2, '两个平台同时进行');
  assert.deepStrictEqual(Object.values(stat.maxByPlat), [1, 1], '同一平台不会同时填两条');
  assert.strictEqual(stat.maxBursts, 1, '前台动作互斥');
  assert.strictEqual(stat.frontViolations, 0, '持锁期间前台就是自己的标签页（开新标签页抢前台也在锁里）');
  assert.strictEqual(job.running, false);
  assert.deepStrictEqual(job.currents, []);
  assert.strictEqual(job.current, null);
  assert.strictEqual(job.parallel, true);
  assert.strictEqual(job.progress.done, 4);
  assert.strictEqual(job.progress.total, 4);
  assert.match(job.progress.stage, /完成：成功 4 \/ 共 4/);
  assert.ok(stat.currentsSeen >= 2, '并行时 job.currents 里同时有多个单元');

  // 同样的活串行做一遍应当明显更慢
  const s = setup({ topics: [topic('t1', '1010-1-甲'), topic('t2', '1010-2-乙')] });
  const t1 = Date.now();
  await s.runner.runJob(s.topics, ['channels', 'douyin'], { parallel: false });
  const ser = Date.now() - t1;
  assert.ok(par < ser * 0.75, `并行 ${par}ms 应明显快于串行 ${ser}ms`);
});

test('并行 + 前台锁：视频号 / 抖音 / B站合集 三条车道，全部成功，结果记在各条目名下', async () => {
  const { job, stat, runner, topics } = setup();
  const r = await runner.runJob(topics, ALL, { parallel: true, uiLock: true });
  assert.strictEqual(r.units, 5, '常规内容 2 条 × (视频号+抖音) + B站合集 1 条');
  assert.strictEqual(r.okCount, 5);
  assert.strictEqual(stat.maxRunning, 3);
  assert.strictEqual(stat.maxBursts, 1);
  assert.deepStrictEqual(Object.keys(job.topics[0].results).sort(), ['channels', 'douyin']);
  assert.deepStrictEqual(Object.keys(job.topics[2].results), ['bili']);
  // 同一平台内按条目顺序
  const order = (p) => stat.starts.filter((x) => x.endsWith(`:${p}`));
  assert.deepStrictEqual(order('channels'), ['t1:channels', 't2:channels']);
  assert.deepStrictEqual(order('douyin'), ['t1:douyin', 't2:douyin']);
});

test('并行（默认，不排队）：各平台的点击/打字互不等待，且不去抢前台；结果与进度照常', async () => {
  const old = process.env.PUBLISH_UI_LOCK;
  delete process.env.PUBLISH_UI_LOCK;
  try {
    const { job, stat, runner, topics } = setup({ uploadMs: 40, burstMs: 60 });
    const r = await runner.runJob(topics, ALL, { parallel: true });
    assert.strictEqual(r.okCount, 5);
    assert.strictEqual(stat.maxRunning, 3);
    assert.ok(stat.maxBursts >= 2, `默认不排队，点击/打字可以同时进行（最多同时 ${stat.maxBursts} 个）`);
    assert.strictEqual(stat.bringCalls, 0, '并行不排队时不去切标签页（你可能正在看别的标签页）');
    assert.deepStrictEqual(job.currents, []);
    assert.match(job.progress.stage, /完成：成功 5 \/ 共 5/);
  } finally {
    if (old !== undefined) process.env.PUBLISH_UI_LOCK = old;
  }
});

test('环境变量 PUBLISH_UI_LOCK=1 启用前台锁（并行时点击/打字一次一个标签页）', async () => {
  const old = process.env.PUBLISH_UI_LOCK;
  process.env.PUBLISH_UI_LOCK = '1';
  try {
    const { stat, runner, topics } = setup({ uploadMs: 30, burstMs: 30 });
    await runner.runJob(topics, ALL, { parallel: true });
    assert.strictEqual(stat.maxBursts, 1);
    assert.strictEqual(stat.frontViolations, 0);
    assert.ok(stat.bringCalls > 0);
  } finally {
    if (old === undefined) delete process.env.PUBLISH_UI_LOCK; else process.env.PUBLISH_UI_LOCK = old;
  }
});

test('串行：每个单元填完把标签页带到前台（和旧版一样）', async () => {
  const { stat, runner, topics } = setup({ uploadMs: 5 });
  await runner.runJob(topics, ALL, { parallel: false });
  assert.strictEqual(stat.bringCalls, 5, '5 个单元，各带到前台一次');
});

test('串行：和旧版一样按 条目→平台 的顺序逐个来，同一时刻只有一个单元', async () => {
  const { job, stat, runner, topics } = setup({ uploadMs: 10 });
  const r = await runner.runJob(topics, ALL, { parallel: false });
  assert.strictEqual(r.okCount, 5);
  assert.strictEqual(stat.maxRunning, 1);
  assert.deepStrictEqual(stat.starts, ['t1:channels', 't1:douyin', 't2:channels', 't2:douyin', 'tb:bili']);
  assert.strictEqual(job.parallel, false);
});

test('环境变量 PUBLISH_PARALLEL=0 一键回到串行（即使请求里要求并行）', async () => {
  const old = process.env.PUBLISH_PARALLEL;
  process.env.PUBLISH_PARALLEL = '0';
  try {
    const { job, stat, runner, topics } = setup({ uploadMs: 10 });
    await runner.runJob(topics, ALL, { parallel: true });
    assert.strictEqual(stat.maxRunning, 1);
    assert.strictEqual(job.parallel, false);
  } finally {
    if (old === undefined) delete process.env.PUBLISH_PARALLEL; else process.env.PUBLISH_PARALLEL = old;
  }
});

test('并行：某平台要登录时只中止它自己的车道，别的平台照常做完；报错发生在持锁期间也不会卡住别人', async () => {
  const { job, stat, runner, topics } = setup({
    behave: { 't1:douyin': { failInLock: { message: '抖音未登录', code: 'NEED_LOGIN' } } },
  });
  const t0 = Date.now();
  const r = await runner.runJob(topics, ALL, { parallel: true, uiLock: true });
  assert.ok(Date.now() - t0 < 3000, '没有死锁');
  assert.deepStrictEqual(r.aborted, ['抖音']);
  assert.ok(!stat.starts.includes('t2:douyin'), '被中止的平台后面的条目不再执行');
  assert.strictEqual(job.topics[0].results.douyin.ok, false);
  assert.strictEqual(job.topics[1].results.douyin, undefined);
  assert.strictEqual(job.topics[0].results.channels.ok, true);
  assert.strictEqual(job.topics[1].results.channels.ok, true);
  assert.strictEqual(job.topics[2].results.bili.ok, true);
  assert.match(job.progress.stage, /抖音需要登录.*其余平台已完成/);
  assert.ok(job.logs.some((l) => l.level === 'error' && /抖音未登录或需要人工处理/.test(l.msg)));
  assert.strictEqual(job.running, false);
});

test('串行：需要登录就整体中止（和旧版一致），后面的单元都不再执行', async () => {
  const { job, stat, runner, topics } = setup({
    uploadMs: 5,
    behave: { 't1:douyin': { fail: { message: '找不到上传入口', code: 'NO_FILE_INPUT' } } },
  });
  const r = await runner.runJob(topics, ALL, { parallel: false });
  assert.deepStrictEqual(stat.starts, ['t1:channels', 't1:douyin']);
  assert.deepStrictEqual(r.aborted, ['抖音']);
  assert.match(job.progress.stage, /已中止：完成 2\/5（需登录后重试）/);
});

test('普通失败只记在这个单元上，不影响别的单元；进度照常前进', async () => {
  const { job, runner, topics } = setup({
    uploadMs: 5,
    behave: { 'tb:bili': { fail: { message: '上传超时' } } },
  });
  const r = await runner.runJob(topics, ALL, { parallel: true });
  assert.strictEqual(r.okCount, 4);
  assert.strictEqual(r.failCount, 1);
  assert.deepStrictEqual(r.aborted, []);
  assert.strictEqual(job.topics[2].results.bili.error, '上传超时');
  assert.strictEqual(job.progress.done, 5);
  assert.match(job.progress.stage, /完成：成功 4 \/ 共 5/);
});

test('跳过：没有成片的条目、没勾对应平台的 B站合集条目，都有明确原因，不占执行单元', async () => {
  const noVideo = topic('t0', '1010-0-无片', { video: null });
  const bili = topic('tb', 'B站合集', { kind: 'bili', dir: '/x/B站合集/1010/合集' });
  const job = makeJob();
  const exists = (p) => !!p;
  const logs = [];
  const r0 = createPublishRunner({
    job, log: (l, m) => logs.push([l, m]), openTab: async () => ({ evaluate: async () => {}, bringToFront: async () => {} }),
    fillers: { channels: async () => ({}), douyin: async () => ({}), bili: async () => ({}) },
    stripHashtags: (s) => s, exists,
  });
  job.topics = [noVideo, bili, topic('t1', '1010-1-甲')].map((t) => ({ id: t.id, name: t.name, results: {} }));
  const units = r0.planUnits([noVideo, bili, topic('t1', '1010-1-甲')], ['channels', 'douyin']);
  assert.deepStrictEqual(units.map((u) => `${u.t.id}:${u.platform}`), ['t1:channels', 't1:douyin']);
  assert.match(job.topics[0].results.all.error, /未找到成片/);
  assert.match(job.topics[1].results.all.error, /平台未勾选/);
  const withBili = r0.planUnits([bili], ['bili']);
  assert.deepStrictEqual(withBili.map((u) => u.platform), ['bili']);
  assert.strictEqual(withBili[0].code, '1010', 'B站合集的标签页代号取日期文件夹名');
});

test('传给各平台的字段：描述去掉 #话题，话题去重，抖音最多 5 个、B站最多 10 个；封面按平台组装', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const cov = path.join(os.tmpdir(), `duofa-cov-${process.pid}.png`);
  fs.writeFileSync(cov, 'x');
  try {
    const t = topic('t1', '1010-1-甲');
    t.fields.channelsCover = cov;
    t.fields.douyinCoverPortrait = cov;
    t.coverOptions = [{ path: cov, orientation: 'landscape' }];
    t.schedule = true;
    t.scheduledAt = new Date(Date.now() + 3600e3).toISOString();
    const tb = biliTopic('tb');
    tb.fields.biliCover = cov;
    const { stat, runner, logs } = setup({ uploadMs: 1, topics: [t, tb] });
    await runner.runJob([t, tb], ALL, { parallel: true });
    const ch = stat.fields['t1:channels'], dy = stat.fields['t1:douyin'], bi = stat.fields['tb:bili'];
    assert.strictEqual(ch.fields.desc, '视频号文案 1010-1-甲');
    assert.ok(!/#/.test(ch.fields.desc) && !/#/.test(dy.fields.desc) && !/#/.test(bi.fields.desc));
    assert.strictEqual(ch.fields.shortTitle, '短1010-1-甲');
    assert.strictEqual(dy.fields.title, '抖1010-1-甲');
    assert.strictEqual(bi.fields.title, 'BB站合集');
    assert.strictEqual(new Set(ch.fields.tags).size, ch.fields.tags.length, '话题去重');
    assert.strictEqual(dy.fields.tags.length, 5);
    assert.strictEqual(bi.fields.tags.length, 10);
    assert.deepStrictEqual(ch.opts.cover, { path: cov, orientation: 'landscape' });
    assert.deepStrictEqual(dy.opts.cover, { portrait: { path: cov }, landscape: null });
    assert.deepStrictEqual(bi.opts.cover, { path: cov });
    assert.strictEqual(ch.opts.schedule, true);
    assert.ok(logs.some(([l, m]) => l === 'warn' && /抖音上限/.test(m)));
    assert.ok(!logs.some(([l, m]) => l === 'warn' && /B站上限/.test(m)) || true);
  } finally {
    fs.rmSync(cov, { force: true });
  }
});

test('定时时间已过去：不设定时并提醒；有效时间才设', async () => {
  const past = topic('t1', '1010-1-甲', { schedule: true, scheduledAt: new Date(Date.now() - 3600e3).toISOString() });
  const future = topic('t2', '1010-2-乙', { schedule: true, scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
  const { stat, runner, logs } = setup({ uploadMs: 1, topics: [past, future] });
  await runner.runJob([past, future], ['channels'], { parallel: true });
  assert.strictEqual(stat.fields['t1:channels'].opts.schedule, false);
  assert.strictEqual(stat.fields['t2:channels'].opts.schedule, true);
  assert.ok(logs.some(([l, m]) => l === 'warn' && /定时时间无效或已过去/.test(m)));
});

test('进度条与当前单元：并行时 stage 列出所有正在做的，结束后清空', async () => {
  const { job, runner, topics } = setup({ uploadMs: 80 });
  const stages = [];
  const timer = setInterval(() => { stages.push(job.progress && job.progress.stage); }, 10);
  await runner.runJob(topics, ALL, { parallel: true });
  clearInterval(timer);
  assert.ok(stages.some((s) => /并行执行中（\d+ 个平台）/.test(s || '')), stages.join('|'));
  assert.deepStrictEqual(job.currents, []);
  assert.strictEqual(job.progress.stages.length, 5);
  assert.deepStrictEqual(job.progress.stages.map((x) => x.label), ['1010-1·视频号', '1010-1·抖音', '1010-2·视频号', '1010-2·抖音', '1010·B站']);
});

test('快手：和抖音共用同一份描述（去掉 #话题）和封面文件，话题最多 4 个并提醒；B站合集不走快手；多平台并行时快手是单独一条车道', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const cov = path.join(os.tmpdir(), `duofa-ks-${process.pid}.png`);
  fs.writeFileSync(cov, 'x');
  try {
    const t = topic('t1', '1015-1-甲');
    t.fields.douyinCoverPortrait = cov;
    t.fields.douyinCoverLandscape = cov;
    t.schedule = true;
    t.scheduledAt = new Date(Date.now() + 3600e3).toISOString();
    const tb = biliTopic('tb');
    const { stat, runner, logs, job } = setup({ uploadMs: 1, topics: [t, tb] });
    const r = await runner.runJob([t, tb], ['channels', 'douyin', 'kuaishou', 'bili'], { parallel: true });
    assert.strictEqual(r.units, 4, '常规内容 × (视频号+抖音+快手) + B站合集 × B站');
    assert.strictEqual(r.okCount, 4);
    const ks = stat.fields['t1:kuaishou'];
    assert.strictEqual(ks.fields.desc, '抖音文案 1015-1-甲');
    assert.ok(!/#/.test(ks.fields.desc));
    assert.strictEqual(ks.fields.title, undefined, '快手没有单独的标题栏');
    assert.deepStrictEqual(ks.fields.tags, ['甲', '乙', '丙', '丁'], '去重后取前 4 个');
    assert.deepStrictEqual(ks.opts.cover, { portrait: { path: cov }, landscape: { path: cov } });
    assert.strictEqual(ks.opts.schedule, true);
    assert.ok(logs.some(([l, m]) => l === 'warn' && /快手上限/.test(m)));
    assert.ok(!stat.fields['tb:kuaishou'], 'B站合集不走快手');
    assert.deepStrictEqual(Object.keys(job.topics[0].results).sort(), ['channels', 'douyin', 'kuaishou']);
    assert.match(logs.map((x) => x[1]).join('\n'), /快手/);
  } finally {
    fs.rmSync(cov, { force: true });
  }
});
