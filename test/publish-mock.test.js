'use strict';
// 真实的三个平台填表代码（lib/channels.js、douyin.js、bilibili.js）在 headless Chrome 里对着“假平台页面”完整跑一遍。
// 假页面见 test/helpers/mock-platforms.js：用网络拦截代替真实域名，不碰真实平台；页面结构照 2026-10-10 在真实页面上实测到的样子写
// （隐藏的嵌套裁剪弹窗与它的「确定」按钮排在可见「确认」前面、封面缩略图上的遮罩、上传期间就能设定时…），
// 验证的是流程逻辑：上传期间先填（含定时）、页面重置表单后补填、封面等遮罩消失再点且只点可见的「确认」、预览视频暂停、定时失败有界、三平台并行互不串台。
// 运行：node --test test/publish-mock.test.js（需要本机装有 Google Chrome）
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chromium } = require('playwright-core');
const { installMocks, tomorrow } = require('./helpers/mock-platforms');
const { fillChannels } = require('../lib/channels');
const { fillDouyin } = require('../lib/douyin');
const { fillBilibili } = require('../lib/bilibili');
const { UiLock, createUi, PARALLEL_UI } = require('../lib/ui-lock');
const { createPublishRunner } = require('../lib/publish-runner');

const { HAVE_CHROME } = require('./helpers/chrome');
// CI 上机器慢：场景少并发、耗时上限放宽（K 倍）；本机照旧
const ON_CI = !!process.env.CI;
const CONCURRENCY = ON_CI ? 2 : Infinity;
const K = ON_CI ? 2 : 1;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duofa-mock-'));
// 这里的用例要覆盖视频号「声明原创」这一步：用一份临时配置把它打开（默认是关的）
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ channels: { declareOriginal: true } }));
require('../lib/config').load({ fresh: true, file: path.join(tmp, 'config.json') });
const video = path.join(tmp, '成片.mp4');
const cover = path.join(tmp, 'cover.png');
fs.writeFileSync(video, 'not really a video');
fs.writeFileSync(cover, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p2 = (n) => String(n).padStart(2, '0');
const when = new Date(Date.now() + 25 * 86400e3);
when.setHours(12, 15, 0, 0);
const WANT_DATE = `${when.getFullYear()}-${p2(when.getMonth() + 1)}-${p2(when.getDate())}`;
const WANT_TIME = '12:15';
// B站的日历不在假页面里实现：假页面默认显示“明天”，定时就用明天 12:15
const whenBili = new Date(`${tomorrow()}T12:15:00`);

const CH_FIELDS = { shortTitle: '断网断星仍能飞武大自研时空大脑', desc: '武大团队发布新一代导航系统。', tags: ['无人机', '导航'] };
const DY_FIELDS = { title: '断网断星仍能飞', desc: '武大团队发布新一代导航系统。', tags: ['无人机', '导航'] };
const BILI_FIELDS = { title: 'B站合集标题', desc: 'B站简介文字。', tags: ['科普', '航天'] };

let browser;

/** 每个场景一个独立的浏览器上下文 + 一套假页面；run(page, log) 里调用真实的填表函数。 */
async function scenario(plat, over, run) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const mocks = await installMocks(ctx, { [plat]: over });
  const page = await ctx.newPage();
  page.screenshot = async () => Buffer.alloc(0); // 不往 logs/ 里写截图
  const logs = [];
  const t0 = Date.now();
  const log = (m) => logs.push([(Date.now() - t0) / 1000, String(m)]);
  let error = null, res = null;
  try { res = await run(page, log); } catch (e) { error = e; }
  const state = await mocks.state(page).catch(() => null);
  await sleep(3800); // 收尾的盯守是 3 秒：之后静音状态应已恢复
  const late = await mocks.state(page).catch(() => null);
  await ctx.close().catch(() => {});
  return { logs, res, error, state, late, secs: (Date.now() - t0) / 1000, text: logs.map(([, m]) => m).join('\n') };
}

const chOpts = (extra = {}) => ({ schedule: true, when, cover: { path: cover, orientation: 'portrait' }, ui: createUi(new UiLock()), ...extra });
const runCh = (over, extra) => scenario('channels', over, (page, log) => fillChannels(page, { id: 't1', videoName: '成片.mp4', video }, CH_FIELDS, chOpts(extra), log));
const runDy = (over, extra) => scenario('douyin', over, (page, log) => fillDouyin(page, { id: 't1', videoName: '成片.mp4', video }, DY_FIELDS, { schedule: true, when, cover: null, ui: PARALLEL_UI, ...extra }, log));
const runBili = (over, extra) => scenario('bili', over, (page, log) => fillBilibili(page, { id: 'tb', videoName: '成片.mp4', video }, BILI_FIELDS, { schedule: true, when: whenBili, cover: null, ui: PARALLEL_UI, ...extra }, log));
const lap = (r, name) => { const m = r.text.match(new RegExp(`${name} ([0-9.]+)s`)); return m ? Number(m[1]) : null; };

/** 三个平台一起跑：真实的 runner + 真实的三个填表函数 + 同一个浏览器上下文里的三个假平台。 */
async function pipeline(parallel, uiLock = false) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const mocks = await installMocks(ctx, {
    channels: { uploadMs: 6000, maskClearMs: 7000 },
    douyin: { uploadMs: 6000 },
    bili: { uploadMs: 6000 },
  });
  const pages = [];
  const job = { running: false, kind: null, logs: [], startedAt: null, finishedAt: null, current: null, currents: [], parallel: false, topics: [], dataResult: null, progress: null };
  const spans = {};
  const timed = (name, fn) => async (page, t, f, o, l) => {
    const s = Date.now();
    try { return await fn(page, t, f, o, l); } finally { spans[name] = [s, Date.now()]; }
  };
  const runner = createPublishRunner({
    job,
    log: (level, msg) => job.logs.push({ level, msg }),
    openTab: async () => {
      const page = await ctx.newPage();
      page.screenshot = async () => Buffer.alloc(0);
      pages.push(page);
      return page;
    },
    fillers: { channels: timed('channels', fillChannels), douyin: timed('douyin', fillDouyin), bili: timed('bili', fillBilibili) },
    stripHashtags: (s) => String(s || '').replace(/#\S+/g, '').trim(),
    maxTags: { douyin: 5, bili: 10 },
  });
  const std = {
    id: 't1', kind: 'std', name: '1010-1-测试', dir: path.join(tmp, '1010', '1010-1-测试'), video, videoName: '成片.mp4',
    schedule: true, scheduledAt: when.toISOString(), coverOptions: [{ path: cover, orientation: 'portrait' }],
    fields: {
      tags: ['无人机', '导航'], channelsShortTitle: CH_FIELDS.shortTitle, channelsDesc: CH_FIELDS.desc, channelsCover: cover,
      douyinTitle: DY_FIELDS.title, douyinDesc: DY_FIELDS.desc,
    },
  };
  const bili = {
    id: 'tb', kind: 'bili', name: 'B站合集', dir: path.join(tmp, 'B站合集', '1010', '合集'), video, videoName: '成片.mp4',
    schedule: true, scheduledAt: whenBili.toISOString(), coverOptions: [],
    fields: { tags: ['科普', '航天'], biliTitle: BILI_FIELDS.title, biliDesc: BILI_FIELDS.desc },
  };
  const t0 = Date.now();
  const result = await runner.runJob([std, bili], ['channels', 'douyin', 'bili'], { parallel, uiLock });
  const wall = (Date.now() - t0) / 1000;
  const states = {};
  for (const p of pages) {
    const host = new URL(p.url()).host;
    states[host] = await mocks.state(p).catch(() => null);
  }
  await ctx.close().catch(() => {});
  const sum = Object.values(spans).reduce((a, [s, e]) => a + (e - s) / 1000, 0);
  return { result, job, wall, sum, spans, states };
}

describe('真实填表代码 × 假平台页面（headless Chrome）', { skip: !HAVE_CHROME && '没有安装 Google Chrome', timeout: 900000 }, () => {
  const R = {};
  before(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    // 各场景用各自独立的浏览器上下文
    const jobs = {
      chBase: () => runCh({ uploadMs: 14000, maskClearMs: 15500 }),            // 上传比填表久；遮罩在上传完成后 1.5 秒才消失
      chMaskEarly: () => runCh({ uploadMs: 12000, maskClearMs: 9000 }),        // 遮罩在上传完成前就消失了：上传完成就能点
      chMaskLate: () => runCh({ uploadMs: 5000, maskClearMs: 20000 }),         // 平台处理很久（上传完成后 15 秒遮罩才消失）：要等，不能乱点（间隔留足：整套并发跑、机器忙时填表会变慢，间隔太小遮罩会在“等”之前就消失）
      chMaskNever: () => runCh({ uploadMs: 4000, maskClearMs: 999999 }, { coverWaitMs: 3000 }), // 遮罩一直不消失：有界放弃并明说，其它项不受影响
      chReset: () => runCh({ uploadMs: 9000, maskClearMs: 9500, resetOnDone: true }), // 上传完成时页面把表单（含定时）全重置了：核对出来并补填
      chJunk: () => runCh({ uploadMs: 9000, maskClearMs: 9500, resetOnDone: 'junk' }),   // 页面往描述里塞了自己生成的内容：先清掉再重填
      chLate: () => runCh({ formDelayMs: 9000, uploadMs: 4000, maskClearMs: 9500 }),     // 表单比上传还晚出现
      chMid: () => runCh({ formDelayMs: 4000, uploadMs: 12000, maskClearMs: 12500 }),    // 表单中途出现：一出来就填
      chCrop: () => runCh({ crop: 'dialog', uploadMs: 5000, maskClearMs: 5500 }),        // 点确认后弹出（嵌套的）裁剪框：要点它可见的「确定」
      chNoSched: () => runCh({ noSchedule: true, uploadMs: 3000, maskClearMs: 3500 }),   // 页面上选不上定时：有界、明说没设上
      dyBase: () => runDy({ uploadMs: 8000 }),
      dyReset: () => runDy({ uploadMs: 8000, resetOnDone: true }),             // 上传完成时页面把定时重置了：核对出来并重新设
      dyLate: () => runDy({ formAfterUpload: true, uploadMs: 5000 }),
      dyLogin: () => runDy({ loginDelayMs: 5000, uploadMs: 3000 }),            // 抖音要求登录/验证：一直等到人处理完，不报错
      biliBase: () => runBili({ uploadMs: 8000 }),
      biliReset: () => runBili({ uploadMs: 8000, resetOnDone: true }),
      par: () => pipeline(true),
      parLock: () => pipeline(true, true),
      ser: () => pipeline(false),
    };
    // 本机所有场景同时跑；CI（GitHub Actions 的机器慢）一次跑 2 个，免得互相抢 CPU 把“早于上传完成”这类时序挤乱
    const queue = Object.entries(jobs);
    const worker = async () => { for (let next; (next = queue.shift());) R[next[0]] = await next[1](); };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  });
  after(async () => {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const okForm = (r, label) => {
    assert.strictEqual(r.error, null, `${label}：${r.error && r.error.message}\n${r.text}`);
    const s = r.state;
    assert.strictEqual(s.title, CH_FIELDS.shortTitle, `${label} 短标题`);
    assert.ok(s.desc.includes('武大团队发布新一代导航系统。'), `${label} 描述：${s.desc}`);
    assert.ok(s.desc.includes('#无人机') && s.desc.includes('#导航'), `${label} 话题：${s.desc}`);
    assert.strictEqual(s.loc, '不显示位置', `${label} 位置`);
    assert.strictEqual(s.orig, true, `${label} 声明原创`);
  };
  const okSched = (r, label) => {
    assert.strictEqual(r.res.scheduled, true, `${label} scheduled`);
    assert.strictEqual(r.state.sched.on, true, `${label} 选了「定时」`);
    assert.ok(r.state.sched.date.includes(WANT_DATE), `${label} 日期：${r.state.sched.date}`);
    assert.strictEqual(r.state.sched.time, WANT_TIME, `${label} 时间`);
  };
  const okCover = (r, label) => {
    assert.strictEqual(r.state.coverDone, true, `${label} 封面弹窗已关`);
    assert.ok(/cover-1\.png/.test(r.state.coverSrc), `${label} 封面缩略图换成了新图：${r.state.coverSrc}`);
    assert.match(r.text, /✅ 已上传3:4 竖版封面/);
  };
  const silenced = (r, label) => {
    assert.ok(r.state.video.playing >= 1, `${label}：预览视频本来就会自动带声音播放（前提）`);
    assert.strictEqual(r.state.video.paused, true, `${label}：视频已暂停`);
    assert.strictEqual(r.state.video.muted, true, `${label}：盯守期间是静音的`);
    assert.strictEqual(r.late.video.paused, true, `${label}：盯守结束后仍是暂停的`);
    assert.strictEqual(r.late.video.muted, false, `${label}：盯守结束后恢复成原来的有声状态，你手动点播放是有声音的`);
  };

  it('视频号：标题 / 描述 / 定时 / 位置 / 原创 在上传的同时就填好了（早于“上传完成”），不需要等上传完才开始', () => {
    const r = R.chBase;
    okForm(r, 'chBase');
    okSched(r, 'chBase');
    const T = r.state.T;
    for (const k of ['titleAt', 'descAt', 'locAt', 'origAt', 'schedOn', 'timeAt']) assert.ok(T[k] < T.uploadDone, `${k}=${T[k]} 应早于 uploadDone=${T.uploadDone}`);
    assert.strictEqual(T.titleFills, 1, '没有被重置，所以不会重填');
    assert.match(r.text, /上传中填表（5\/5 项）/);
  });

  it('视频号：点「发表视频」之后不再等网络空闲（页面一直在轮询，旧版白等 5–20 秒）', () => {
    const open = lap(R.chBase, '打开并开始上传');
    assert.ok(open !== null && open < 8 * K, `打开并开始上传用了 ${open} 秒`);
  });

  it('视频号：上传完成后预览视频被暂停（盯守期间静音，结束后恢复有声），页面自己反复尝试自动播放也压得住', () => {
    silenced(R.chBase, 'chBase');
    assert.ok(R.chBase.state.video.playCalls >= 3, '页面确实多次尝试播放过');
  });

  it('视频号：封面 —— 点的是可见的「确认」（不是隐藏的裁剪弹窗里排在前面的「确定」），弹窗关闭、缩略图换成了新图', () => {
    const r = R.chBase;
    okCover(r, 'chBase');
    assert.strictEqual(r.state.T.coverConfirm > 0, true, '点了「确认」');
    assert.ok(!/裁剪确认/.test(r.text), '没有裁剪框：不该去点隐藏的那个');
    const c = lap(r, '封面');
    assert.ok(c !== null && c < 12 * K, `封面一步用了 ${c} 秒`);
  });

  it('视频号：封面遮罩还在时一次都不去点（遮罩吞点击）——等它消失再点；遮罩早就消失则上传完成就点', () => {
    for (const k of ['chBase', 'chMaskEarly', 'chMaskLate']) {
      const r = R[k];
      assert.strictEqual(r.error, null, `${k}：${r.error && r.error.message}\n${r.text}`);
      okCover(r, k);
      assert.strictEqual(r.state.T.maskedClicks || 0, 0, `${k} 没有点到遮罩上`);
    }
    assert.match(R.chMaskLate.text, /平台还在处理视频，封面暂时点不了/);
    assert.match(R.chMaskLate.text, /平台处理完了，封面可以点了/);
    assert.ok(!/平台还在处理视频/.test(R.chMaskEarly.text), '遮罩早就没了就不必等');
    assert.ok(R.chMaskLate.state.T.coverOpened > R.chMaskLate.state.T.maskGone, '封面是在遮罩消失之后才点开的');
  });

  it('视频号：遮罩一直不消失 → 有界放弃（可配置的等待上限），明说“没设置封面”，其余内容（含定时）不受影响', () => {
    const r = R.chMaskNever;
    okForm(r, 'chMaskNever');
    okSched(r, 'chMaskNever');
    assert.match(r.text, /封面一直处于“处理中”（3 秒），没能设置封面/);
    assert.strictEqual(r.state.coverDone, false);
    assert.ok(r.secs < 25 * K, `${r.secs}s`);
  });

  it('视频号：点确认后弹出裁剪框（嵌套在封面弹窗里）→ 点它可见的「确定」，封面照样设上', () => {
    const r = R.chCrop;
    okForm(r, 'chCrop');
    okCover(r, 'chCrop');
    assert.match(r.text, /裁剪确认：clicked/);
  });

  it('视频号：定时 —— 在上传期间就设好（早于上传完成），日期和时间都对', () => {
    const r = R.chBase;
    okSched(r, 'chBase');
    assert.ok(r.state.T.timeAt < r.state.T.uploadDone - 3000, `定时在上传完成前 ${((r.state.T.uploadDone - r.state.T.timeAt) / 1000).toFixed(1)} 秒就设好了`);
  });

  it('视频号：上传完成时页面把表单（含定时）重置了 → 核对发现并全部补填，最终内容完整', () => {
    const r = R.chReset;
    okForm(r, 'chReset');
    okSched(r, 'chReset');
    okCover(r, 'chReset');
    assert.match(r.text, /短标题不在了（页面重置了表单）/);
    assert.match(r.text, /描述\/话题不完整（页面重置了表单）/);
    assert.match(r.text, /定时设置不在了（页面重置了表单）/);
    assert.strictEqual(r.state.T.titleFills, 2);
  });

  it('视频号：页面在上传完成时往描述里塞了自己生成的内容 → 先清掉再重填，不会叠在后面', () => {
    const r = R.chJunk;
    okForm(r, 'chJunk');
    assert.ok(!r.state.desc.includes('页面自动生成的描述'), r.state.desc);
    assert.match(r.text, /描述\/话题不完整（页面重置了表单）/);
  });

  it('视频号：表单比上传完成还晚出现 → 等它出来再补填（等待不抛错），最终内容完整', () => {
    const r = R.chLate;
    okForm(r, 'chLate');
    okSched(r, 'chLate');
    assert.match(r.text, /上传完成时表单还没出来，稍后补填/);
  });

  it('视频号：表单在上传中途出现 → 一出来就填，仍然早于上传完成', () => {
    const r = R.chMid;
    okForm(r, 'chMid');
    okSched(r, 'chMid');
    const T = r.state.T;
    assert.ok(T.titleAt > T.formShown - 50 && T.titleAt < T.uploadDone, `titleAt=${T.titleAt} formShown=${T.formShown} uploadDone=${T.uploadDone}`);
    assert.match(r.text, /上传中填表（5\/5 项）/);
  });

  it('视频号：页面上选不上定时 → 上传期间静默试一次、上传完成后再试，仍不行就明说“没能选上、保持不定时”，其余内容不受影响', () => {
    const r = R.chNoSched;
    okForm(r, 'chNoSched');
    assert.strictEqual(r.res.scheduled, false);
    assert.match(r.text, /没能选上「定时发表」，页面保持“不定时”/);
    assert.strictEqual(r.state.sched.on, false);
    assert.strictEqual((r.text.match(/没能选上「定时发表」/g) || []).length, 1, '上传期间的试探是静默的，只在最后明说一次');
    okCover(r, 'chNoSched');
  });

  it('抖音：标题/描述/话题之后立刻设定时（早于上传完成），完成后静音暂停预览', () => {
    const r = R.dyBase;
    assert.strictEqual(r.error, null, r.error && r.error.message);
    assert.strictEqual(r.state.title, DY_FIELDS.title);
    assert.ok(r.state.desc.includes(DY_FIELDS.desc) && r.state.desc.includes('#无人机') && r.state.desc.includes('#导航'), r.state.desc);
    assert.ok(r.state.T.titleAt < r.state.T.uploadDone, '标题在上传完成之前就填了');
    assert.ok(r.state.T.dtAt < r.state.T.uploadDone - 2000, '定时在上传完成之前就设好了');
    assert.strictEqual(r.state.sched.date, `${WANT_DATE} ${WANT_TIME}`);
    assert.strictEqual(r.res.scheduled, true);
    assert.ok(!/定时设置不在了/.test(r.text), '没被重置就不会重设');
    silenced(r, 'dyBase');
  });

  it('抖音：上传完成时页面把定时重置了 → 核对发现并重新设，最终定时正确', () => {
    const r = R.dyReset;
    assert.strictEqual(r.error, null, r.error && r.error.message);
    assert.match(r.text, /上传完成后定时设置不在了（页面重置了表单）/);
    assert.strictEqual(r.state.sched.date, `${WANT_DATE} ${WANT_TIME}`);
    assert.strictEqual(r.state.T.dtFills, 2, '设了两次');
    assert.strictEqual(r.res.scheduled, true);
  });

  it('抖音：表单要等上传完成才出现 —— 等它出来再填，不抛错', () => {
    const r = R.dyLate;
    assert.strictEqual(r.error, null, r.error && r.error.message);
    assert.strictEqual(r.state.title, DY_FIELDS.title);
    assert.strictEqual(r.state.sched.date, `${WANT_DATE} ${WANT_TIME}`);
    assert.strictEqual(r.res.scheduled, true);
    silenced(r, 'dyLate');
  });

  it('抖音：要求登录/验证 —— 提示用户在窗口里处理并一直等，处理完后接着填，不报错', () => {
    const r = R.dyLogin;
    assert.strictEqual(r.error, null, r.error && r.error.message);
    assert.match(r.text, /抖音要求登录\/验证/);
    assert.ok(r.state.T.loggedIn > 0, '假页面里确实经历了“先要求登录，后出现上传入口”');
    assert.strictEqual(r.state.title, DY_FIELDS.title);
    assert.ok(r.secs > 5, `等到登录处理完才继续：${r.secs}s`);
  });

  it('B站：先清掉页面按文件名预填的标题，标题之后立刻设定时（早于上传完成），再填简介/标签；上传完成后静音暂停预览', () => {
    const r = R.biliBase;
    assert.strictEqual(r.error, null, r.error && r.error.message);
    assert.strictEqual(r.state.title, BILI_FIELDS.title);
    assert.strictEqual(r.state.desc, BILI_FIELDS.desc);
    assert.deepStrictEqual(r.state.tags, BILI_FIELDS.tags);
    assert.deepStrictEqual([r.state.sched.on, r.state.sched.date, r.state.sched.time], [true, tomorrow(), '12:15']);
    assert.strictEqual(r.res.scheduled, true);
    assert.ok(r.state.T.timeAt < r.state.T.uploadDone, '定时在上传完成之前就设好了');
    assert.ok(r.state.T.schedOn < r.state.T.descAt, '定时排在简介之前');
    assert.ok(!/定时设置不在了/.test(r.text));
    silenced(r, 'biliBase');
  });

  it('B站：上传完成时页面把定时重置了 → 核对发现并重新设；已经打开的开关不会被再点一下关掉', () => {
    const r = R.biliReset;
    assert.strictEqual(r.error, null, r.error && r.error.message);
    assert.match(r.text, /上传完成后定时设置不在了（页面重置了表单）/);
    assert.deepStrictEqual([r.state.sched.on, r.state.sched.date, r.state.sched.time], [true, tomorrow(), '12:15']);
    assert.strictEqual(r.res.scheduled, true);
  });

  it('三平台一起跑（真实 runner + 真实填表函数，默认不排队）：各自填对自己的内容（含定时），没有串台；三个预览视频都已暂停', () => {
    const { result, job, states } = R.par;
    assert.strictEqual(result.okCount, 3, JSON.stringify(job.logs.filter((l) => l.level === 'error')));
    assert.strictEqual(result.failCount, 0);
    assert.strictEqual(job.running, false);
    const ch = states['channels.weixin.qq.com'], dy = states['creator.douyin.com'], bi = states['member.bilibili.com'];
    assert.strictEqual(ch.title, CH_FIELDS.shortTitle);
    assert.strictEqual(ch.loc, '不显示位置');
    assert.strictEqual(ch.orig, true);
    assert.strictEqual(ch.coverDone, true);
    assert.ok(ch.sched.date.includes(WANT_DATE) && ch.sched.time === WANT_TIME);
    assert.strictEqual(dy.title, DY_FIELDS.title);
    assert.strictEqual(dy.sched.date, `${WANT_DATE} ${WANT_TIME}`);
    assert.strictEqual(bi.title, BILI_FIELDS.title);
    assert.deepStrictEqual(bi.tags, BILI_FIELDS.tags);
    assert.deepStrictEqual([bi.sched.on, bi.sched.date, bi.sched.time], [true, tomorrow(), '12:15']);
    for (const [name, s] of Object.entries(states)) {
      assert.ok(s.video.playing >= 1, `${name} 预览视频本来会自动播放（前提）`);
      assert.strictEqual(s.video.paused, true, `${name} 视频已暂停`);
    }
  });

  it('三平台一起跑：开前台锁（PUBLISH_UI_LOCK=1 的做法）同样全部成功、内容正确', () => {
    const { result, job, states } = R.parLock;
    assert.strictEqual(result.okCount, 3, JSON.stringify(job.logs.filter((l) => l.level === 'error')));
    const ch = states['channels.weixin.qq.com'], dy = states['creator.douyin.com'], bi = states['member.bilibili.com'];
    assert.strictEqual(ch.coverDone, true);
    assert.ok(ch.sched.date.includes(WANT_DATE) && ch.sched.time === WANT_TIME);
    assert.strictEqual(dy.sched.date, `${WANT_DATE} ${WANT_TIME}`);
    assert.deepStrictEqual([bi.sched.on, bi.sched.date, bi.sched.time], [true, tomorrow(), '12:15']);
  });

  it('三平台一起跑：确实是同时进行的 —— 总耗时明显短于三个平台各自耗时之和；串行对照则基本等于之和', () => {
    const par = R.par, ser = R.ser;
    assert.strictEqual(ser.result.okCount, 3, JSON.stringify(ser.job.logs.filter((l) => l.level === 'error')));
    assert.ok(par.wall < par.sum * 0.8, `并行：总 ${par.wall.toFixed(1)}s，各平台之和 ${par.sum.toFixed(1)}s`);
    assert.ok(ser.wall > ser.sum * 0.95, `串行：总 ${ser.wall.toFixed(1)}s，各平台之和 ${ser.sum.toFixed(1)}s`);
    assert.ok(par.wall < ser.wall * 0.8, `并行 ${par.wall.toFixed(1)}s 应明显快于串行 ${ser.wall.toFixed(1)}s`);
    // 视频号和抖音的执行区间有重叠
    const [a, b] = [par.spans.channels, par.spans.douyin];
    assert.ok(Math.min(a[1], b[1]) > Math.max(a[0], b[0]), '视频号与抖音的执行区间有重叠');
    console.log(`  ⏱ 三平台（假页面，上传各 6 秒）：并行 ${par.wall.toFixed(1)} 秒；开前台锁 ${R.parLock.wall.toFixed(1)} 秒；串行 ${ser.wall.toFixed(1)} 秒；各平台耗时之和 ${par.sum.toFixed(1)} 秒`);
  });
});
