'use strict';
/**
 * 多发 本地服务：127.0.0.1:8686（config.json 的 port 可改）
 *  - 扫描内容目录里的日期目录与条目文件夹
 *  - 管理（启动/连接）独立 Chrome
 *  - 执行填表任务：视频号 / 抖音 / 快手 / B站（只填表，不点发布）
 *  - 下载各平台后台数据、看板、日历
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const browserMgr = require('./lib/browser');
const { listDateFolders, scanDateFolder, deriveFields, stripHashtags, inferDateFromFolderName, yearOf } = require('./lib/parse');
const calendarPub = require('./lib/calendar-pub');
const { fillChannels, setLocationNone, declareOriginal } = require('./lib/channels');
const { fillDouyin } = require('./lib/douyin');
const { fillKuaishou, MAX_TAGS: KUAISHOU_MAX_TAGS } = require('./lib/kuaishou');
const { fillBilibili } = require('./lib/bilibili');
const { createPublishRunner } = require('./lib/publish-runner');
const debug = require('./lib/debug');
const { fetchChannelsData } = require('./lib/data-channels');
const { fetchDouyinData } = require('./lib/data-douyin');
const { fetchBilibiliData } = require('./lib/data-bilibili');
const { fetchKuaishouData } = require('./lib/data-kuaishou');
const { exportXlsx } = require('./lib/export-xlsx');
const { buildDashboard, invalidate: invalidateDashboard } = require('./lib/dashboard');
const security = require('./lib/security');
const osShell = require('./lib/os-shell');
const lifecycleModule = require('./lib/lifecycle');
const term = require('./lib/term');
const channelsFix = { setLocationNone, declareOriginal };

// 抖音发布表单最多 5 个话题；B站标签上限 10 个
const DOUYIN_MAX_TAGS = 5;
const BILI_MAX_TAGS = 10;

const cfg = require('./lib/config').load();
const PORT = cfg.port;
const ROOT = cfg.contentDir; // 内容目录：里面是一个个日期目录
const DATA_SAVE_ROOT = cfg.dataDir; // 「数据」页下载的默认保存位置
// 本机运行状态（填表账本等），不进 git；DUOFA_STATE_DIR 可换位置（测试用）
const STATE_DIR = process.env.DUOFA_STATE_DIR ? path.resolve(process.env.DUOFA_STATE_DIR) : path.join(__dirname, '.duofa');
const VERSION = require('./package.json').version;
const app = express();
const fillLedger = require('./lib/fill-ledger').create({ file: path.join(STATE_DIR, 'fill-ledger.json') });
app.use(express.json({ limit: '2mb' }));
app.use('/api', security.guard(PORT)); // 校验 Host / Origin / Sec-Fetch-Site：挡掉跨站请求与 DNS rebinding
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res.type('html').send(html.replace(/(<div class="brand">[\s\S]*?<small>)[^<]*(<\/small>)/, `$1v${VERSION} · 本地版$2`));
});
app.use(express.static(path.join(__dirname, 'public')));
// Chart.js（看板图表用）：直接托管 npm 包内已构建的 UMD 文件，本地离线可用
app.use('/vendor/chartjs', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));

// ---------- 工具 ----------
// 路径白名单：内容目录、数据保存目录、程序目录（带路径分隔符边界）。需要额外目录时用环境变量 DUOFA_EXTRA_ROOTS（冒号分隔）。
const resolveSafe = security.makeSafePath([ROOT, DATA_SAVE_ROOT, __dirname, ...(process.env.DUOFA_EXTRA_ROOTS || '').split(path.delimiter).filter(Boolean)]);

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

// ---------- 任务状态 ----------
const job = {
  running: false,
  kind: null, // 'publish' | 'data'
  logs: [],
  startedAt: null,
  finishedAt: null,
  current: null, // {topicId, platform}（并行时是 currents 的第一个，兼容旧前端）
  currents: [], // 正在执行的单元（并行填写时有多个）
  parallel: false, // 本次填表是否各平台同时进行
  topics: [], // 发布任务的执行计划与结果
  dataResult: null, // 数据下载任务的结果 {saveDir, dayDir, platforms, files}
  progress: null, // V4.0.1 进度条：{total, done, stage, stages:[{label}]}
};

// 任务日志按日期落盘：logs/任务日志-YYYY-MM-DD.log（以前只打在终端，关掉就没了；平台出问题时靠它回看）。只留最近 30 天。
const LOG_DIR = path.join(__dirname, 'logs');
let logDirReady = false;
function persistLog(entry) {
  try {
    if (!logDirReady) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logDirReady = true;
      for (const f of fs.readdirSync(LOG_DIR)) {
        const m = f.match(/^任务日志-(\d{4}-\d{2}-\d{2})\.log$/);
        if (m && Date.now() - new Date(m[1]).getTime() > 30 * 86400e3) fs.rmSync(path.join(LOG_DIR, f), { force: true });
      }
    }
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    fs.appendFileSync(path.join(LOG_DIR, `任务日志-${day}.log`), `[${day} ${entry.t}] ${entry.level} ${entry.msg}\n`);
  } catch (_) { /* 写日志失败不影响任务 */ }
}

function log(level, msg) {
  const entry = { t: ts(), level, msg };
  job.logs.push(entry);
  if (job.logs.length > 800) job.logs.splice(0, job.logs.length - 800);
  console.log(`[${entry.t}] ${level} ${msg}`);
  persistLog(entry);
}

// ---------- API ----------
app.get('/api/state', (req, res) => {
  res.json({
    root: ROOT,
    dataSaveRoot: DATA_SAVE_ROOT,
    fileManager: osShell.FILE_MANAGER,
    browser: browserMgr.getStatus(),
    // 近 48 小时填过的「条目目录 × 平台」（左侧列表据此显示“已填好”，不会因为后来又跑了别的任务而变回“待填入”）
    filled: fillLedger.list().filter((e) => Date.now() - new Date(e.at).getTime() < 48 * 3600e3).map((e) => ({ dir: e.dir, platform: e.platform })),
    job: {
      running: job.running,
      kind: job.kind,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      current: job.current,
      currents: job.currents,
      parallel: job.parallel,
      topics: job.topics,
      dataResult: job.dataResult,
      progress: job.progress,
      logs: job.logs.slice(-200),
    },
  });
});

app.get('/api/dates', (req, res) => {
  const root = resolveSafe(req.query.root) || ROOT;
  try {
    const dates = listDateFolders(root);
    res.json({ root, dates });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// V5.1 发布日历：某个月份的全部内容条目（含定时时间与档期原文）
app.get('/api/calendar', (req, res) => {
  const month = String(req.query.month || ''); // YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month 参数格式应为 YYYY-MM' });
  try {
    const items = [];
    const ledger = calendarPub.indexLedger(fillLedger.list());
    for (const dateDir of listDateFolders(ROOT)) {
      const dir = path.join(ROOT, dateDir);
      const md = inferDateFromFolderName(dateDir);
      if (!md) continue;
      const year = yearOf(md);
      if (`${year}-${String(md.month).padStart(2, '0')}` !== month) continue;
      for (const t of scanDateFolder(dir)) {
        const scheduled = t.scheduledAt ? new Date(t.scheduledAt) : null;
        const p2 = (n) => String(n).padStart(2, '0');
        items.push({
          dateDir,
          dir: t.dir,
          id: t.id,
          name: t.name,
          kind: t.kind || 'std',
          hasVideo: !!t.video,
          // 填表记录（填表账本）：日历状态点按它上色；expected 是这一条预期要发的平台（日历每个平台画一个小点）
          publications: calendarPub.latestByPlatform(ledger.get(t.dir) || []),
          expectedPlatforms: t.kind === 'bili' ? calendarPub.BILI_PLATFORMS : calendarPub.STD_PLATFORMS,
          scheduledAt: t.scheduledAt || null,
          // 日历落位日期：有定时用定时日，否则归目录日期
          date: scheduled
            ? `${scheduled.getFullYear()}-${p2(scheduled.getMonth() + 1)}-${p2(scheduled.getDate())}`
            : `${year}-${p2(md.month)}-${p2(md.day)}`,
          timeText: scheduled ? `${p2(scheduled.getHours())}:${p2(scheduled.getMinutes())}` : '',
          scheduled: !!scheduled,
          // 档期原文：std 为「10月7日 08:15（…档…）」整行；bili 为 {hh,mm}，统一转成可读文本
          suggestRaw:
            typeof t.suggestTimeRaw === 'string'
              ? t.suggestTimeRaw
              : t.suggestTimeRaw && typeof t.suggestTimeRaw === 'object'
                ? `建议公开 ${String(t.suggestTimeRaw.hh).padStart(2, '0')}:${String(t.suggestTimeRaw.mm).padStart(2, '0')}`
                : '',
          highlight: t.highlight || '',
        });
      }
    }
    res.json({ month, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/topics', (req, res) => {
  const raw = req.query.date || '';
  // 允许传日期目录名（如 0928）或绝对路径
  const target = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
  const dir = resolveSafe(target);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(400).json({ error: '目录不存在或不在允许范围内' });
  }
  try {
    const topics = scanDateFolder(dir).map((t) => ({
      ...t,
      fields: deriveFields(t),
    }));
    res.json({ dir, topics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 本地文件（封面缩略图等）
app.get('/api/file', (req, res) => {
  const p = resolveSafe(req.query.path);
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
    return res.status(404).end();
  }
  const ext = path.extname(p).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  if (!types[ext]) return res.status(403).end();
  res.setHeader('Content-Type', types[ext]);
  fs.createReadStream(p).pipe(res);
});

// 启动/连接独立 Chrome；login=true 时顺带打开各平台的登录页
app.post('/api/browser/open', async (req, res) => {
  try {
    await browserMgr.ensureBrowser((m) => log('info', m));
    if (req.body && req.body.login) {
      const pages = await browserMgr.openLoginTabs((m) => log('info', m));
      log('info', '已打开各平台登录页，请在独立 Chrome 窗口中分别扫码登录（登录一次即可，之后长期有效）');
      return res.json({ ok: true, loginPages: pages });
    }
    res.json({ ok: true });
  } catch (e) {
    log('error', `浏览器启动失败：${e.message.split('\n')[0]}`);
    res.status(500).json({ error: e.message.split('\n')[0] });
  }
});

app.post('/api/browser/close', async (req, res) => {
  await browserMgr.disconnect();
  log('info', '已关闭自动化 Chrome（不影响你日常使用的 Chrome）');
  res.json({ ok: true });
});

// ---------- 填表任务（单条 or 批量；发布由用户手动完成） ----------
// 编排（串行 / 各平台并行、前台锁、车道中止）在 lib/publish-runner.js，这里只接线。
const publishRunner = createPublishRunner({
  job,
  log,
  openTab: (url, l) => browserMgr.openTab(url, l),
  fillers: { channels: fillChannels, douyin: fillDouyin, kuaishou: fillKuaishou, bili: fillBilibili },
  stripHashtags,
  maxTags: { douyin: DOUYIN_MAX_TAGS, kuaishou: KUAISHOU_MAX_TAGS, bili: BILI_MAX_TAGS },
  ledger: fillLedger,
});
const runJob = (topics, platforms, opts) => publishRunner.runJob(topics, platforms, opts);

app.post('/api/publish', async (req, res) => {
  if (job.running) return res.status(409).json({ error: '已有任务在执行中，请等待完成' });
  const body = req.body || {};
  // 兼容两种入参：{topic} 单条 / {topics:[...]} 批量
  const topics = Array.isArray(body.topics) && body.topics.length ? body.topics : body.topic ? [body.topic] : null;
  const { platforms } = body;
  if (!topics) return res.status(400).json({ error: '未选择任何内容' });
  for (const t of topics) {
    if (!t.fields || !t.video) return res.status(400).json({ error: `内容数据不完整（缺少成片或字段）：${t.name || t.id}` });
  }
  if (!Array.isArray(platforms) || !platforms.length) {
    return res.status(400).json({ error: '未选择平台' });
  }
  try {
    await browserMgr.ensureBrowser((m) => log('info', m));
  } catch (e) {
    return res.status(500).json({ error: `浏览器未就绪：${e.message}` });
  }
  res.json({ ok: true });
  runJob(topics, platforms, { parallel: body.parallel !== false }).catch((e) => {
    log('error', `任务异常终止：${e.message}`);
    job.running = false;
    job.finishedAt = new Date().toISOString();
  });
});

// ---------- V2.0 数据下载（视频号/抖音/B站 → Excel + 原始JSON 落盘） ----------
function platformLabel(pk) {
  return pk === 'channels' ? '视频号' : pk === 'bili' ? 'B站' : pk === 'kuaishou' ? '快手' : '抖音';
}

function dayLabelNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function runDataJob(platforms, saveDir) {
  job.running = true;
  job.kind = 'data';
  job.dataResult = null;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.current = null;
  job.currents = [];
  job.topics = [];

  const day = dayLabelNow();
  const dayDir = path.join(saveDir, day);
  fs.mkdirSync(dayDir, { recursive: true });
  const dataByPk = {};
  const results = {};
  log('info', `========== 数据下载开始：平台 [${platforms.map(platformLabel).join(', ')}] → ${dayDir} ==========`);

  // 进度条：每个平台一段 + 汇总 Excel 一段
  job.progress = {
    total: platforms.length + 1,
    done: 0,
    stage: '准备中',
    stages: [...platforms.map((p) => ({ label: platformLabel(p) })), { label: '汇总 Excel' }],
  };

  for (const pk of platforms) {
    const label = platformLabel(pk);
    job.current = { topicId: '__data__', platform: pk };
    const plog = (a, b) => {
      const level = b === undefined ? 'info' : a;
      const text = b === undefined ? a : b;
      log(level, `【${label}】${text}`);
    };
    try {
      const page = await browserMgr.openTab(null, (m) => plog('info', m));
      const fn = { channels: fetchChannelsData, douyin: fetchDouyinData, kuaishou: fetchKuaishouData, bili: fetchBilibiliData }[pk];
      const data = await fn(page, (m) => plog('info', m));
      await page.close().catch(() => {});
      dataByPk[pk] = data;
      const rawFile = path.join(dayDir, `${label}_原始数据.json`);
      fs.writeFileSync(
        rawFile,
        JSON.stringify({ fetchedAt: new Date().toISOString(), works: data.works, overview: data.overview, trend: data.followers, raw: data.raw }, null, 2)
      );
      results[pk] = { ok: true, works: (data.works || []).length, overview: (data.overview || []).length, trend: (data.followers || []).length, rawFile };
      plog('info', `完成：作品 ${results[pk].works} 条，原始数据 ${path.basename(rawFile)}`);
    } catch (e) {
      results[pk] = { ok: false, error: e.message };
      plog('error', `失败：${e.message}`);
      if (e.code === 'NEED_LOGIN') {
        log('error', `>>> ${label}未登录，本平台已跳过；其他平台继续。可点「打开登录页」登录后重新下载`);
      }
    }
    if (job.progress) {
      job.progress.done = Math.min(job.progress.done + 1, job.progress.total);
      job.progress.stage = `【${label}】${results[pk] && results[pk].ok ? '完成' : '失败跳过'}`;
    }
  }

  // 汇总 Excel（至少一个平台成功才生成）
  const files = [];
  if (Object.keys(dataByPk).length) {
    try {
      const xlsxFile = path.join(dayDir, `各平台数据表_${day}.xlsx`);
      await exportXlsx(dataByPk, xlsxFile);
      files.push(xlsxFile);
      log('info', `汇总表已生成：${xlsxFile}`);
    } catch (e) {
      log('error', `汇总 Excel 生成失败：${e.message}`);
    }
  }
  for (const pk of Object.keys(results)) {
    if (results[pk].ok) files.push(results[pk].rawFile);
  }

  job.current = null;
  job.running = false;
  job.finishedAt = new Date().toISOString();
  job.dataResult = { saveDir, dayDir, platforms: results, files };

  const okCount = Object.values(results).filter((r) => r.ok).length;
  if (okCount) invalidateDashboard();
  log('info', `========== 数据下载结束：${okCount}/${platforms.length} 个平台成功，共 ${files.length} 个文件 ==========`);
  if (okCount) log('info', `文件保存在 ${dayDir}，可在数据页点「在${osShell.FILE_MANAGER}中显示」查看。`);
  if (job.progress) {
    job.progress.done = job.progress.total;
    job.progress.stage = `完成：${okCount}/${platforms.length} 个平台成功，共 ${files.length} 个文件`;
  }
}

app.post('/api/data/download', async (req, res) => {
  if (job.running) return res.status(409).json({ error: '已有任务在执行中，请等待完成' });
  const body = req.body || {};
  const platforms = Array.isArray(body.platforms) ? body.platforms.filter((p) => ['channels', 'douyin', 'kuaishou', 'bili'].includes(p)) : [];
  if (!platforms.length) return res.status(400).json({ error: '未选择平台' });
  const saveDir = resolveSafe(body.saveDir || DATA_SAVE_ROOT);
  if (!saveDir) return res.status(400).json({ error: '保存位置不在允许的目录范围内' });
  try {
    await browserMgr.ensureBrowser((m) => log('info', m));
  } catch (e) {
    return res.status(500).json({ error: `浏览器未就绪：${e.message}` });
  }
  res.json({ ok: true });
  runDataJob(platforms, saveDir).catch((e) => {
    log('error', `数据下载异常终止：${e.message}`);
    job.running = false;
    job.finishedAt = new Date().toISOString();
  });
});

// 数据历史：扫描保存根目录下的「YYYY-MM-DD」文件夹
app.get('/api/data/history', (req, res) => {
  const root = resolveSafe(req.query.dir || DATA_SAVE_ROOT);
  if (!root) return res.status(400).json({ error: '保存位置不在允许的目录范围内' });
  const days = [];
  try {
    const names = fs
      .readdirSync(root)
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
      .sort()
      .reverse()
      .slice(0, 14);
    for (const name of names) {
      const dir = path.join(root, name);
      const files = fs
        .readdirSync(dir)
        .filter((f) => /\.(xlsx|json)$/i.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, path: path.join(dir, f), size: st.size };
        });
      days.push({ day: name, dir, files });
    }
  } catch (e) {
    return res.json({ root, days: [], note: e.message });
  }
  res.json({ root, days });
});

// 在 Finder / 资源管理器中显示数据文件/文件夹
app.get('/api/data/reveal', (req, res) => {
  const p = resolveSafe(req.query.path);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: '路径不存在' });
  osShell.reveal(p, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ---------- 数据看板（下载快照聚合 + 内容目录） ----------
app.get('/api/dashboard', (req, res) => {
  try {
    res.json(buildDashboard(DATA_SAVE_ROOT, { fresh: req.query.fresh === '1', contentDir: ROOT }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 诊断：打开视频号发布表单并导出「位置/原创/声明」相关 DOM 结构（诊断标签页用完即关，不发布）
// body: { video, test?: true } —— test=true 时会顺带实测「不显示位置」「声明原创」两个修复函数
app.post('/api/debug/dump', async (req, res) => {
  if (job.running) return res.status(409).json({ error: '任务执行中' });
  const video = resolveSafe((req.body || {}).video);
  if (!video || !fs.existsSync(video)) return res.status(400).json({ error: '成片路径无效' });
  const test = !!(req.body && req.body.test);
  try {
    const page = await browserMgr.openTab(null, (m) => log('info', `[dump] ${m}`));
    await debug.openForm(page, video, (m) => log('info', `[dump] ${m}`));
    const file = await debug.dumpCandidates(page);
    log('info', `[dump] DOM 结构已导出：${file}`);
    if (test) {
      for (const fr of page.frames()) {
        const c1 = await fr.locator("div.label:text-is('位置')").count().catch(() => -1);
        const c2 = await fr.locator('span:text-is("声明原创")').count().catch(() => -1);
        log('info', `[dump-test] frame …${fr.url().slice(-40)} → 位置:${c1} 原创:${c2}`);
      }
      const r1 = await channelsFix.setLocationNone(page, (m) => log('info', `[dump-test] ${m}`));
      const r2 = await channelsFix.declareOriginal(page, (m) => log('info', `[dump-test] ${m}`));
      log('info', `[dump-test] 位置=${r1 ? '成功' : '跳过/失败'} 原创=${r2 ? '成功' : '跳过/失败'}`);
      await page.screenshot({ path: path.join(__dirname, 'logs', 'after-fix-test.png'), fullPage: true }).catch(() => {});
    }
    await page.close().catch(() => {});
    res.json({ ok: true, file });
  } catch (e) {
    log('error', `[dump] 失败：${e.message.split('\n')[0]}`);
    res.status(500).json({ error: e.message.split('\n')[0] });
  }
});

// 诊断：打开B站投稿页并导出表单 DOM 结构（诊断标签页用完即关，不提交）
app.post('/api/debug/dump-bili', async (req, res) => {
  if (job.running) return res.status(409).json({ error: '任务执行中' });
  const video = resolveSafe((req.body || {}).video);
  const doUpload = !!video && fs.existsSync(video);
  try {
    const page = await browserMgr.openTab('https://member.bilibili.com/platform/upload/video/frame', (m) => log('info', `[dump-bili] ${m}`));
    await new Promise((r) => setTimeout(r, 5000));
    if (!page.url().includes('member.bilibili.com')) {
      await page.close().catch(() => {});
      return res.status(400).json({ error: 'B站未登录（页面跳到了登录页）' });
    }
    if (doUpload) {
      const fi = page.locator('input[type="file"]').first();
      await fi.waitFor({ state: 'attached', timeout: 30000 }).catch(() => {});
      if (await fi.count()) {
        log('info', `[dump-bili] 上传 ${path.basename(video)} 以渲染完整表单…`);
        await fi.setInputFiles(video).catch((e) => log('warn', `[dump-bili] 上传失败：${e.message.split('\n')[0]}`));
        // 等表单出现（标题输入框可见），最多 12 分钟
        await page
          .locator('input[placeholder*="标题"]')
          .first()
          .waitFor({ state: 'visible', timeout: 720000 })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    // —— 增强 dump：定向抓定时发布/封面区块完整 HTML + 全部输入控件 ——
    const dump = await page
      .evaluate(() => {
        const vis = (el) => !!(el.offsetWidth || el.offsetHeight);
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        };
        const out = { url: location.href };
        // 定时发布区块（主表单与弹窗里各有一份 .time-container）
        out.timeContainers = [...document.querySelectorAll('.time-container')].map((el, i) => ({
          i,
          inDialog: !!el.closest('.bcc-dialog'),
          visible: vis(el),
          rect: rect(el),
          html: el.outerHTML.slice(0, 9000),
        }));
        // 封面区块：从「添加封面」向上找容器
        const addText = document.querySelector('.add-text');
        if (addText) {
          let el = addText;
          for (let k = 0; k < 6 && el.parentElement; k++) el = el.parentElement;
          out.coverSection = { html: el.outerHTML.slice(0, 9000) };
        }
        // 全部 input/textarea（含属性与当前值）
        out.inputs = [...document.querySelectorAll('input, textarea')].map((el) => ({
          tag: el.tagName,
          type: el.type || '',
          placeholder: el.placeholder || '',
          cls: String(el.className).slice(0, 120),
          accept: el.accept || '',
          readOnly: !!el.readOnly,
          visible: vis(el),
          rect: rect(el),
          value: String(el.value || '').slice(0, 40),
        }));
        // 弹窗结构
        out.dialogs = [...document.querySelectorAll('.bcc-dialog')].map((el) => ({
          visible: vis(el),
          html: el.outerHTML.slice(0, 3000),
        }));
        // 开关/单选/复选类控件
        out.switches = [...document.querySelectorAll('[class*="switch" i], [class*="radio" i], [class*="checkbox" i], [role="switch"]')].map((el) => ({
          tag: el.tagName,
          cls: String(el.className).slice(0, 120),
          text: (el.textContent || '').trim().slice(0, 40),
          visible: vis(el),
          html: el.outerHTML.slice(0, 600),
        }));
        return out;
      })
      .catch((e) => ({ error: e.message }));
    // —— 封面实测：开弹窗 → 真实上传封面 → 抓确认按钮与弹窗结构（分阶段，setInputFiles 须在 Node 侧） ——
    const probe = {};
    const coverFile = resolveSafe((req.body || {}).cover);
    try {
      await page.evaluate(() => {
        const vis = (el) => !!(el.offsetWidth || el.offsetHeight);
        const addText = [...document.querySelectorAll('.add-text')].find(vis);
        if (addText) addText.click();
      });
      await new Promise((r) => setTimeout(r, 2500));
      if (coverFile && fs.existsSync(coverFile)) {
        const imgInput = page.locator('input[accept*="image"]').first();
        if (await imgInput.count()) {
          log('info', `[dump-bili] 上传封面 ${path.basename(coverFile)} …`);
          await imgInput.setInputFiles(coverFile).catch((e) => {
            probe.uploadErr = e.message.split('\n')[0];
          });
          await new Promise((r) => setTimeout(r, 4000));
        } else {
          probe.uploadErr = '未找到图片 input';
        }
      }
      probe.coverState = await page
        .evaluate(() => {
          const vis = (el) => !!(el.offsetWidth || el.offsetHeight);
          const dlg = [...document.querySelectorAll('.bcc-dialog')].find(
            (n) => vis(n) && (n.textContent || '').includes('封面制作')
          );
          if (!dlg) return { dialogOpen: false };
          const leaves = [];
          for (const n of dlg.querySelectorAll('*')) {
            if (!vis(n)) continue;
            const txt = (n.textContent || '').trim();
            if (!txt || txt.length > 8) continue;
            if (n.querySelectorAll('*').length > 0) continue;
            const r = n.getBoundingClientRect();
            leaves.push({
              tag: n.tagName,
              cls: String(n.className).slice(0, 100),
              text: txt,
              rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            });
            if (leaves.length > 150) break;
          }
          const html = dlg.outerHTML;
          return { dialogOpen: true, leaves, htmlTail: html.slice(-7000), htmlLen: html.length };
        })
        .catch((e) => ({ error: e.message }));
    } catch (e) {
      probe.error = e.message;
    }
    dump.coverProbe = probe;
    const file = path.join(__dirname, 'logs', `dom-dump-bili2-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(dump, null, 2));
    await page.screenshot({ path: file.replace('.json', '.png'), fullPage: true }).catch(() => {});
    log('info', `[dump-bili] 增强 DOM 结构已导出：${file}`);
    await page.close().catch(() => {});
    res.json({ ok: true, file });
  } catch (e) {
    log('error', `[dump-bili] 失败：${e.message.split('\n')[0]}`);
    res.status(500).json({ error: e.message.split('\n')[0] });
  }
});

// ---------- 启动 ----------
const UI_URL = `http://127.0.0.1:${PORT}/${process.env.UI_HASH ? `#${process.env.UI_HASH}` : ''}`;
// 界面开在哪：默认就开在“独立 Chrome”里（发布/抓数据的页面是同一个窗口里的新标签页，不再多一个浏览器）；
// UI_BROWSER=default 或 AUTO_BROWSER=0 时开在系统默认浏览器里。
const UI_IN_CHROME = process.env.UI_BROWSER !== 'default' && process.env.AUTO_BROWSER !== '0';

// 退出按钮与“浏览器窗口关了就自动退出”（DUOFA_AUTO_QUIT=1 才启用，只有启动脚本会设）
const lifecycle = lifecycleModule.create({ browser: browserMgr, isPublishing: () => job.running, log });
browserMgr.onPagesChange(lifecycle.onPages);
app.get('/api/app/status', (req, res) => res.json(lifecycle.status()));
app.post('/api/app/quit', (req, res) => {
  const r = lifecycle.quit({ force: !!(req.body && req.body.force === true) });
  if (r.ok) return res.json(r);
  return res.status(409).json({ error: '还有事情没处理完，需要确认后才能退出', busy: r.busy });
});

/** 把界面带到用户眼前：独立 Chrome 里已经开着就切过去，没开就开；Chrome 起不来时退回系统默认浏览器。返回 'chrome' | 'default'。 */
async function showUi() {
  if (UI_IN_CHROME) {
    try {
      await browserMgr.openUi(UI_URL, (m) => log('info', m));
      return 'chrome';
    } catch (e) {
      // 打开界面的过程中用户把 Chrome 关了：这是有意的，不要再去开系统浏览器
      if (/has been closed/i.test(e.message)) {
        log('info', '独立 Chrome 在打开界面时被关闭了');
        return 'closed';
      }
      log('error', `独立 Chrome 打开界面失败：${e.message.split('\n')[0]}（改用系统默认浏览器）`);
    }
  }
  osShell.openUrl(UI_URL);
  return 'default';
}

// 启动脚本在“服务已经在运行”时调用：切到已有的界面窗口，不用再起一个（仍受 Host/Origin 校验）。
app.post('/api/app/open-ui', async (req, res) => {
  try {
    res.json({ ok: true, mode: await showUi() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`多发已启动： http://127.0.0.1:${PORT}`);
  log('info', `多发已启动，内容目录：${ROOT}`);
  if (!fs.existsSync(ROOT)) log('warn', `内容目录不存在：${ROOT}（在 config.json 里设置 contentDir，见 README）`);
  if (process.env.NO_OPEN !== '1') {
    showUi().then((mode) => {
      // 界面已经在浏览器里了：把启动用的终端窗口最小化收起来（退出时再关掉它）
      if (mode === 'chrome' && process.env.DUOFA_MINIMIZE_TERMINAL !== '0') term.minimizeWindow(process.env.DUOFA_TTY);
    });
  } else if (process.env.AUTO_BROWSER !== '0') {
    // 不开界面但要保证独立 Chrome 在（保持原有行为）
    browserMgr.ensureBrowser((m) => log('info', m)).catch((e) => log('error', `独立 Chrome 自动打开失败：${e.message.split('\n')[0]}（可点界面上的「打开浏览器」重试）`));
  }
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // 已有多发在运行（比如重复双击启动器）：让它把界面窗口带到前面就行，然后把这个多余的终端窗口也关掉
    console.log(`多发已在运行，切到它的界面 ${UI_URL}`);
    const finish = (ok) => {
      if (!ok) osShell.openUrl(UI_URL);
      term.closeWindow(process.env.DUOFA_TTY);
      process.exit(0);
    };
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/app/open-ui', method: 'POST', timeout: 8000 }, (r) => {
      r.resume();
      r.on('end', () => finish(r.statusCode === 200));
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.end();
    return;
  }
  console.error('服务错误:', e);
});
