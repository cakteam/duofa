'use strict';
/**
 * 填表任务编排：把「条目 × 平台」展开成执行单元，交给各平台的填表函数（只填表，发布永远由人点）。
 *
 * 并行模式（默认）：
 *   - 每个平台一条“车道”，视频号 / 抖音 / B站 三条车道同时进行；同一个平台的多条内容仍按顺序一条一条填
 *     （共用一个登录态，也不让同平台的上传互相抢带宽）。
 *   - 各平台的上传、点击、打字都同时进行（Playwright 驱动的 Chrome 里后台标签页照常渲染、键鼠事件按标签页各自派发，互不干扰）。
 *     需要时可开前台锁（PUBLISH_UI_LOCK=1）：点击/打字一次只让一个标签页做（拿锁 → 切到前台 → 做完放锁）。
 *   - 某个平台要登录 / 找不到上传入口时，只中止这个平台的车道，其余平台继续。
 * 串行模式（opts.parallel === false，或环境变量 PUBLISH_PARALLEL=0）：与旧版完全一致，
 *   按 条目 → 平台 的顺序逐个执行，遇到需要登录就整体中止。
 *
 * 依赖都从外面注入（job 状态对象、日志、开标签页、三个填表函数），方便用假填表函数测并发与锁。
 */
const fs = require('fs');
const path = require('path');
const { UiLock, createUi, NOOP_UI, PARALLEL_UI } = require('./ui-lock');

const LABEL = { channels: '视频号', douyin: '抖音', kuaishou: '快手', bili: 'B站' };
const labelOf = (p) => LABEL[p] || p;

function createPublishRunner({
  job,
  log,
  openTab,
  fillers,
  stripHashtags,
  maxTags = { douyin: 5, kuaishou: 4, bili: 10 },
  exists = fs.existsSync,
  now = () => Date.now(),
  ledger = null,
}) {
  /** 展开执行单元（保持旧版的 条目 → 平台 顺序），同时打出“跳过”的日志。 */
  function planUnits(topics, platforms) {
    const units = [];
    topics.forEach((t, ti) => {
      const rec = job.topics[ti];
      if (!t.video || !exists(t.video)) {
        rec.results['all'] = { ok: false, error: '未找到成片视频文件' };
        log('error', `【${t.name}】未找到成片视频，跳过该条`);
        return;
      }
      // 平台过滤：B站合集内容只在勾选了B站时才填；常规内容不走B站
      const want = t.kind === 'bili' ? (platforms.includes('bili') ? ['bili'] : []) : platforms.filter((p) => p !== 'bili');
      if (!want.length) {
        rec.results['all'] = { ok: false, error: '该条内容对应的平台未勾选，已跳过' };
        log('warn', `【${t.name}】对应的平台未勾选，跳过`);
        return;
      }
      const when = t.scheduledAt ? new Date(t.scheduledAt) : null;
      const schedule = !!t.schedule && !!when && when.getTime() > now();
      if (t.schedule && (!when || when.getTime() <= now())) {
        log('warn', `【${t.name}】定时时间无效或已过去，将不设置定时（保持立即发表，由你手动决定）`);
      }
      // 标签页标题标记（填完自动改名，便于人工辨认标签页）
      const dateFolder = path.basename(path.dirname(t.dir || ''));
      const code = t.kind === 'bili' ? dateFolder : (String(t.name || '').match(/^\d{4}-\d+/) || [String(t.name || '').slice(0, 6)])[0];
      const timeStr = schedule && when ? `·定时${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}` : '';
      for (const platform of want) units.push({ t, rec, platform, label: labelOf(platform), schedule, when, code, timeStr });
    });
    return units;
  }

  function buildFields(platform, t, plog) {
    // 描述里不带 #话题（话题单独添加，避免重复超限）；话题去重
    const tags = [...new Set(t.fields.tags || [])];
    if (platform === 'channels') {
      return { shortTitle: t.fields.channelsShortTitle, desc: stripHashtags(t.fields.channelsDesc), tags };
    }
    if (platform === 'bili') {
      const biliTags = tags.slice(0, maxTags.bili);
      if (tags.length > maxTags.bili) plog('warn', `话题超过 ${maxTags.bili} 个（B站上限），只用前 ${maxTags.bili} 个`);
      return { title: t.fields.biliTitle, desc: stripHashtags(t.fields.biliDesc), tags: biliTags };
    }
    if (platform === 'kuaishou') {
      // 快手：和抖音用同一份描述（简介 + 话题写在同一个“作品描述”里，没有单独标题）；话题最多 4 个，超了发布时会报错
      const ksTags = tags.slice(0, maxTags.kuaishou);
      if (tags.length > maxTags.kuaishou) plog('warn', `话题超过 ${maxTags.kuaishou} 个（快手上限），只用前 ${maxTags.kuaishou} 个：${ksTags.join(' ')}`);
      return { desc: stripHashtags(t.fields.douyinDesc), tags: ksTags };
    }
    const dyTags = tags.slice(0, maxTags.douyin);
    if (tags.length > maxTags.douyin) plog('warn', `话题超过 ${maxTags.douyin} 个（抖音上限），只用前 ${maxTags.douyin} 个：${dyTags.join(' ')}`);
    return { title: t.fields.douyinTitle, desc: stripHashtags(t.fields.douyinDesc), tags: dyTags };
  }

  // 封面：视频号单张；抖音两张（竖 3:4 + 横 4:3）；快手一张（竖 3:4 优先）；B站单张
  function buildCover(platform, t) {
    const f = t.fields;
    if (platform === 'channels' && f.channelsCover && exists(f.channelsCover)) {
      const opt = (t.coverOptions || []).find((c) => c.path === f.channelsCover);
      return { path: f.channelsCover, orientation: opt ? opt.orientation : 'portrait' };
    }
    if (platform === 'douyin' || platform === 'kuaishou') {            // 快手只有一张封面（填表时优先用竖封面 3:4），封面文件和抖音共用
      const portrait = f.douyinCoverPortrait && exists(f.douyinCoverPortrait) ? { path: f.douyinCoverPortrait } : null;
      const landscape = f.douyinCoverLandscape && exists(f.douyinCoverLandscape) ? { path: f.douyinCoverLandscape } : null;
      return portrait || landscape ? { portrait, landscape } : null;
    }
    if (platform === 'bili' && f.biliCover && exists(f.biliCover)) return { path: f.biliCover };
    return null;
  }

  function refreshCurrent() {
    job.current = job.currents[0] || null;
    if (!job.progress) return;
    const cs = job.currents;
    if (!cs.length) return;
    job.progress.stage = cs.length === 1
      ? `【${cs[0].name}·${labelOf(cs[0].platform)}】执行中`
      : `并行执行中（${cs.length} 个平台）：${cs.map((c) => `【${c.name}·${labelOf(c.platform)}】`).join('')}`;
  }

  function bump() {
    if (job.progress) job.progress.done = Math.min(job.progress.done + 1, job.progress.total);
  }

  /** 执行一个单元。返回 {abort}：需要登录 / 找不到上传入口时为 true。 */
  async function runUnit(u, ui) {
    const { t, rec, platform, label, schedule, when, code, timeStr } = u;
    const cur = { topicId: t.id, platform, name: t.name };
    job.currents.push(cur);
    refreshCurrent();
    const plog = (a, b) => {
      // 兼容单参数日志（log('消息')）与双参数日志（log('info', '消息')）两种调用
      const level = b === undefined ? 'info' : a;
      const text = b === undefined ? a : b;
      log(level, `【${t.name}·${label}】${text}`);
    };
    try {
      plog('info', '—— 开始 ——');
      // 开新标签页会抢前台：并行时放在锁里做，免得打断别的平台正在进行的点击/打字
      const page = await ui.run(null, () => openTab(null, (m) => plog('info', m)));
      const fields = buildFields(platform, t, plog);
      const cover = buildCover(platform, t);
      const result = await fillers[platform](page, t, fields, { schedule, when, cover, ui }, plog);
      // 标签页改名：如「抖音·0929-1·定时08:30·待发布」。串行时和旧版一样把刚填好的标签页带到前台；
      // 并行时不去抢前台（你可能正在看别的标签页）——除非开了前台锁，那时 ui.run 自己会切到这个标签页
      await ui.run(page, async () => {
        await page.evaluate((title) => { document.title = title; }, `${label}·${code}${timeStr}·待发布`).catch(() => {});
        if (!ui.parallel) await page.bringToFront().catch(() => {});
      });
      rec.results[platform] = { ok: true, scheduled: result.scheduled, screenshot: result.screenshot };
      if (ledger && t.dir) ledger.note({ dir: t.dir, kind: t.kind || 'std', platform, scheduled: !!(result.scheduled && rec.scheduledAt), scheduledAt: rec.scheduledAt || null, at: new Date(now()).toISOString() });
      bump();
      return { abort: false };
    } catch (e) {
      rec.results[platform] = { ok: false, error: e.message };
      bump();
      plog('error', `失败：${e.message}`);
      if (e.code === 'NEED_LOGIN' || e.code === 'NO_FILE_INPUT') {
        log('error', `>>> ${label}未登录或需要人工处理：请点「打开登录页」登录后重新执行任务`);
        return { abort: true, label, name: t.name };
      }
      return { abort: false };
    } finally {
      ui.leave(); // 无论成败都把前台锁交出去，别让别的平台一直等
      const i = job.currents.indexOf(cur);
      if (i >= 0) job.currents.splice(i, 1);
      refreshCurrent();
    }
  }

  async function runJob(topics, platforms, opts = {}) {
    const parallel = opts.parallel !== false && process.env.PUBLISH_PARALLEL !== '0';
    // 并行时默认不排队（PARALLEL_UI）；PUBLISH_UI_LOCK=1 或 opts.uiLock 才启用“一次一个标签页做点击/打字 + 切到前台”的前台锁
    const uiLock = opts.uiLock !== undefined ? !!opts.uiLock : process.env.PUBLISH_UI_LOCK === '1';
    job.running = true;
    job.kind = 'publish';
    job.dataResult = null;
    job.startedAt = new Date(now()).toISOString();
    job.finishedAt = null;
    job.current = null;
    job.currents = [];
    job.parallel = parallel;
    // dir/kind/scheduledAt：填完之后“一键标记已排期”要据此对回批次里的哪一条、什么时间（V8.0）
    job.topics = topics.map((t) => ({ id: t.id, name: t.name, dir: t.dir || null, kind: t.kind || 'std', scheduledAt: t.schedule ? t.scheduledAt || null : null, results: {} }));
    log('info', `========== 任务开始：${topics.length} 条内容 × 平台 [${platforms.join(', ')}]${parallel ? '（各平台同时填写，同一平台按顺序）' : '（逐个串行）'} ==========`);

    const units = planUnits(topics, platforms);
    // 进度条：「条目 × 平台」执行单元清单
    job.progress = {
      total: units.length,
      done: 0,
      stage: units.length ? '准备中' : '无可执行单元（未找到成片）',
      stages: units.map((u) => ({ label: `${u.code}·${u.label}` })),
    };

    const aborted = []; // 因“需要登录”而中止的平台车道
    const t0 = now();
    try {
      if (!parallel) {
        for (const u of units) {
          const r = await runUnit(u, NOOP_UI);
          if (r.abort) {
            aborted.push(r);
            job.progress.stage = `已中止于【${r.name}·${r.label}】（需登录）`;
            break;
          }
        }
      } else {
        const lock = uiLock ? new UiLock() : null;
        const lanes = new Map();
        for (const u of units) {
          if (!lanes.has(u.platform)) lanes.set(u.platform, []);
          lanes.get(u.platform).push(u);
        }
        await Promise.all([...lanes.values()].map(async (laneUnits) => {
          for (const u of laneUnits) {
            const r = await runUnit(u, lock ? createUi(lock) : PARALLEL_UI);
            if (r.abort) { aborted.push(r); break; } // 只中止这个平台，别的平台照常往下走
          }
        }));
      }
    } finally {
      job.current = null;
      job.currents = [];
      job.running = false;
      job.finishedAt = new Date(now()).toISOString();
    }

    // 汇总
    let okCount = 0, failCount = 0;
    for (const r of job.topics) {
      for (const p of Object.values(r.results)) {
        if (p.ok) okCount++;
        else failCount++;
      }
    }
    const secs = Math.round((now() - t0) / 1000);
    log('info', `========== 任务结束：成功 ${okCount} 项，失败 ${failCount} 项，用时 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒 ==========`);
    log('info', '请到 Chrome 里逐个标签页检查内容（标签页已自动改名），确认无误后手动点击「发表」。');
    if (job.progress) {
      if (!aborted.length) {
        job.progress.done = job.progress.total;
        job.progress.stage = `完成：成功 ${okCount} / 共 ${units.length}`;
      } else if (!parallel) {
        job.progress.stage = `已中止：完成 ${job.progress.done}/${job.progress.total}（需登录后重试）`;
      } else {
        const names = [...new Set(aborted.map((a) => a.label))].join('、');
        job.progress.stage = `${names}需要登录，该平台已中止；其余平台已完成：成功 ${okCount} / 共 ${units.length}`;
      }
    }
    return { okCount, failCount, aborted: aborted.map((a) => a.label), units: units.length };
  }

  return { runJob, planUnits, buildFields, buildCover };
}

module.exports = { createPublishRunner };
