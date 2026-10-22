'use strict';
/**
 * B站创作中心（member.bilibili.com）自动填入流程。
 * 页面为 React SPA（动态 class），选择器全部走「占位符/文本/控件类型」兜底链。
 * 只填表（含上传、定时发布），不点「立即投稿」（旧版页面叫「提交稿件」）。
 */
const path = require('path');
const fs = require('fs');
const { clickBlankArea, silenceVideos, createTimer } = require('./common');
const { NOOP_UI } = require('./ui-lock');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

/** 找视频上传 input */
async function findVideoInput(page) {
  const selectors = ['input[accept*="video"]', 'input[type="file"]'];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) return el;
    } catch {}
  }
  return null;
}

/** 等上传后的填写表单（标题框）出现；每 30 秒报一次进度。超时返回 false。 */
async function waitForm(page, timeoutMs, log) {
  const title = page.locator('input[placeholder*="标题"]').first();
  const deadline = Date.now() + timeoutMs;
  let lastReport = Date.now();
  while (Date.now() < deadline) {
    if (await title.isVisible().catch(() => false)) return true;
    if (Date.now() - lastReport > 30000) {
      log(`等待填写表单出现…（已等 ${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)} 秒）`);
      lastReport = Date.now();
    }
    await sleep(1000);
  }
  return false;
}

/** 等上传完成（出现“上传完成/100%”或提交按钮可用） */
async function waitUploadDone(page, log, timeoutSec = 2400) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastReport = 0;
  while (Date.now() < deadline) {
    // 上传完成的两种标志
    if ((await page.getByText(/上传完成|上传成功|100%/).count()) > 0) {
      log('视频上传完成');
      return;
    }
    const submit = page.locator('button:has-text("立即投稿"), button:has-text("提交稿件")').first();
    if ((await submit.count()) && (await submit.isEnabled().catch(() => false))) {
      log('表单已就绪（提交按钮可用）');
      return;
    }
    const now = Date.now();
    if (now - lastReport > 30000) {
      log(`视频上传中…（已等 ${Math.round((timeoutSec * 1000 - (deadline - now)) / 1000)} 秒）`);
      lastReport = now;
    }
    await sleep(2000);
  }
  await shot(page, 'bili-upload-timeout');
  throw new Error(`B站上传超过 ${timeoutSec} 秒仍未完成`);
}

/** 填标题（上传后页面会用文件名预填标题，先清空） */
async function fillTitle(page, title, log) {
  const input = page.locator('input[placeholder*="标题"]').first();
  await input.waitFor({ state: 'visible', timeout: 600000 });
  await input.fill('');
  await input.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await input.fill(title);
  log(`已填写标题（${title.length} 字）`);
}

/** 填简介：B站可能是 textarea 也可能是富文本编辑器 */
async function fillDesc(page, desc, log) {
  const ta = page.locator('textarea[placeholder*="简介"], textarea[placeholder*="内容"]').first();
  if (await ta.count()) {
    await ta.fill('');
    await ta.fill(desc);
    log(`已填写简介（textarea，${desc.length} 字）`);
    return;
  }
  const editor = page.locator('div[contenteditable="true"]').first();
  if (await editor.count()) {
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type(desc);
    log(`已填写简介（编辑器，${desc.length} 字）`);
    return;
  }
  await shot(page, 'bili-desc-miss');
  log('⚠️ 未找到简介输入框，跳过（请手动粘贴简介）');
}

/** 逐个添加标签（输入 + 回车） */
async function fillTags(page, tags, log) {
  const input = page
    .locator('input[placeholder*="标签"], input[placeholder*="回车"], input[placeholder*="添加"]')
    .first();
  if (!(await input.count())) {
    await shot(page, 'bili-tags-miss');
    log('⚠️ 未找到标签输入框，跳过标签');
    return;
  }
  await input.click();
  let added = 0;
  for (const tag of tags) {
    await input.fill(tag);
    await sleep(400);
    await page.keyboard.press('Enter');
    await sleep(400);
    added++;
  }
  log(`已添加标签 ${added} 个`);
}

/** 在一组 locator 里找第一个可见的 */
async function firstVisible(locator) {
  for (const el of await locator.all()) {
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 封面制作弹窗是否还开着 */
async function coverDialogOpen(page) {
  for (const el of await page.locator('.bcc-dialog').all()) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const txt = (await el.textContent().catch(() => '')) || '';
    if (txt.includes('封面制作')) return true;
  }
  return false;
}

/** 关掉封面制作弹窗（点右上角 ×，必要时确认“放弃编辑”），避免挡住后面的定时区块 */
async function closeCoverDialog(page, log) {
  try {
    if (!(await coverDialogOpen(page))) return;
    const closeBtn = page.locator('.cover-editor-head-close').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ timeout: 5000 }).catch(() => {});
      await sleep(1200);
      // 「放弃封面编辑」确认弹窗：点主按钮（确定）
      const ok = page.locator('.bcc-dialog__footer .bcc-button--primary').first();
      if (await ok.isVisible().catch(() => false)) {
        await ok.click({ timeout: 5000 }).catch(() => {});
        await sleep(1000);
      }
    }
    if (await coverDialogOpen(page)) {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(800);
      const ok2 = page.locator('.bcc-dialog__footer .bcc-button--primary').first();
      if (await ok2.isVisible().catch(() => false)) {
        await ok2.click({ timeout: 5000 }).catch(() => {});
        await sleep(800);
      }
    }
    if (await coverDialogOpen(page)) log('⚠️ 封面弹窗未能自动关闭，请手动关闭后再设定时');
  } catch {}
}

/** 上传封面：点「添加封面」→ 封面制作弹窗 → 图片 input 设置 → 点「完成」（可能再有「确定」二次确认） */
async function setCover(page, coverPath, log) {
  try {
    // 入口：cover-empty 里的「添加封面」（旧版文字「上传封面」兜底）
    let entry = await firstVisible(page.locator('.add-text'));
    if (entry) {
      await entry.click();
    } else {
      const old = page.getByText('上传封面', { exact: false }).first();
      if (!(await old.count()) || !(await old.isVisible().catch(() => false))) {
        log('⚠️ 未找到封面上传入口，跳过封面');
        return false;
      }
      await old.click();
    }

    // 弹窗里的图片 input（隐藏的 file input，attached 即可设置）
    const imgInput = page.locator('input[accept*="image"]').first();
    try {
      await imgInput.waitFor({ state: 'attached', timeout: 12000 });
    } catch {
      await shot(page, 'bili-cover-dialog-miss');
      log('⚠️ 封面弹窗未打开或未找到上传框，跳过封面');
      await closeCoverDialog(page, log);
      return false;
    }
    await sleep(800);
    await imgInput.setInputFiles(coverPath);
    await sleep(4000); // 等图片上载并进入编辑画布

    // 确认按钮：封面编辑器底部是 div（div.button.submit「完成」），不是 <button>
    let submitted = false;
    for (let attempt = 0; attempt < 2 && !submitted; attempt++) {
      const done = await firstVisible(page.locator('.cover-editor-button .button.submit'));
      if (done) {
        await done.click({ timeout: 8000 }).catch(() => {});
        await sleep(1800);
        // 新版封面编辑器：只改了 4:3 时会问「检测到个人空间封面（16:9）未修改…是否同步」，挡住「完成」（2026-10-22 Windows 实测）。
        // 选「确认同步」：两个比例用同一张封面，正是我们要的；同步后再点一次「完成」
        const sync = page.getByText('确认同步', { exact: true }).first();
        if (await sync.isVisible().catch(() => false)) {
          await sync.click({ timeout: 5000 }).catch(() => {});
          log('封面：已选「确认同步」，16:9 与 4:3 用同一张封面');
          await sleep(1500);
          if (await coverDialogOpen(page)) {
            const again = await firstVisible(page.locator('.cover-editor-button .button.submit'));
            if (again) { await again.click({ timeout: 8000 }).catch(() => {}); await sleep(1800); }
          }
        }
        // 可能出现「确定」二次确认（bcc-dialog__footer 主按钮）
        const ok = page.locator('.bcc-dialog__footer .bcc-button--primary').first();
        if (await ok.isVisible().catch(() => false)) {
          await ok.click({ timeout: 5000 }).catch(() => {});
          await sleep(1200);
        }
        submitted = !(await coverDialogOpen(page));
      } else {
        break;
      }
    }

    if (!submitted) {
      await shot(page, 'bili-cover-confirm-miss');
      log('⚠️ 封面未能提交（未找到「完成」按钮或点击无效），将关闭弹窗跳过封面');
      await closeCoverDialog(page, log);
      return false;
    }

    const empty = await page.locator('.cover-empty').first().isVisible().catch(() => false);
    if (empty) {
      await shot(page, 'bili-cover-verify');
      log('⚠️ 封面已提交但表单仍显示未设置，请人工检查封面');
      return false;
    }
    log(`✅ 已上传封面：${path.basename(coverPath)}`);
    return true;
  } catch (e) {
    await shot(page, 'bili-cover-fail');
    log(`⚠️ 封面上传失败（${e.message.split('\n')[0]}），可发布前手动设置`);
    await closeCoverDialog(page, log);
    return false;
  }
}

/**
 * 定时发布（2026-10 版页面结构）：
 *  1) 主表单「定时发布」区块是一个开关（.time-switch-wrp .switch-container）；
 *  2) 打开后渲染 .time-picker：日期默认当天（.date-picker-date .date-show），
 *     时间需点开 .date-picker-timer .date-show，在弹层里点选小时（00-23）与分钟（00-55，5 分钟一档）；
 *  3) B站限制：距当前 ≥5 分钟、≤15 天；已过档位为禁用态（time-select-disabled）。
 */
/** 目标时间对齐：分钟按 5 分钟档就近取整；距当前不足 6 分钟则顺延到下一个可用档。返回 { hh, mm, target, wantTime, wantDate }。 */
function alignSchedule(when, log = () => {}) {
  let hh = when.getHours();
  let mm = when.getMinutes();
  if (mm % 5 !== 0) {
    const down = mm - (mm % 5);
    mm = mm - down >= 3 ? down + 5 : down;
    if (mm === 60) {
      mm = 0;
      hh = (hh + 1) % 24;
    }
    log(`B站定时分钟按 5 分钟档取整 → ${pad2(hh)}:${pad2(mm)}`);
  }
  let target = new Date(when.getFullYear(), when.getMonth(), when.getDate(), hh, mm, 0, 0);
  if (target.getTime() - Date.now() < 6 * 60 * 1000) {
    target = new Date(Math.ceil((Date.now() + 6 * 60 * 1000) / (5 * 60 * 1000)) * 5 * 60 * 1000);
    hh = target.getHours();
    mm = target.getMinutes();
    log(`定时时间距当前不足 5 分钟，已顺延 → ${pad2(hh)}:${pad2(mm)}`);
  }
  return { hh, mm, target, wantTime: `${pad2(hh)}:${pad2(mm)}`, wantDate: `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}` };
}

/** B站定时现在是不是已经设成想要的：「定时发布」开关打开、日期与时间都是目标值。读不到就当没设。 */
async function scheduleStill(page, when) {
  try {
    const { wantTime, wantDate } = alignSchedule(when);
    const sw = await firstVisible(page.locator('.time-switch-wrp .switch-container'));
    if (!sw || !(((await sw.getAttribute('class').catch(() => '')) || '').includes('active'))) return false;
    const gotTime = ((await page.locator('.date-picker-timer .date-show').first().textContent().catch(() => '')) || '').trim();
    const gotDate = ((await page.locator('.date-picker-date .date-show').first().textContent().catch(() => '')) || '').trim();
    return gotTime === wantTime && gotDate === wantDate;
  } catch {
    return false;
  }
}

async function setScheduleTime(page, when, log) {
  try {
    // 防御：若有封面编辑器等全屏弹窗残留，先关闭，避免挡住定时区块
    await closeCoverDialog(page, log);

    // —— 目标时间对齐 ——
    const { hh, mm, target, wantTime, wantDate } = alignSchedule(when, log);

    // —— 1. 打开「定时发布」开关（主表单里可见的那个；激活后 class 含 active） ——
    const sw = await firstVisible(page.locator('.time-switch-wrp .switch-container'));
    if (!sw) {
      await shot(page, 'bili-schedule-switch-miss');
      log('⚠️ 未找到「定时发布」开关，请手动设置时间');
      return false;
    }
    let cls = (await sw.getAttribute('class').catch(() => '')) || '';
    if (!cls.includes('active')) {
      await sw.click(); // 已经打开的就不再点（再点会把它关掉）
      await sleep(1200);
      cls = (await sw.getAttribute('class').catch(() => '')) || '';
    }
    if (!cls.includes('active')) {
      await sw.click();
      await sleep(1200);
      cls = (await sw.getAttribute('class').catch(() => '')) || '';
      if (!cls.includes('active')) {
        await shot(page, 'bili-schedule-switch-fail');
        log('⚠️ 「定时发布」开关未能打开，请手动设置时间');
        return false;
      }
    }
    log('已打开「定时发布」开关');

    // —— 2. 等时间选择器渲染 ——
    const timerShow = page.locator('.date-picker-timer .date-show').first();
    try {
      await timerShow.waitFor({ state: 'visible', timeout: 8000 });
    } catch {
      await shot(page, 'bili-schedule-input-miss');
      log('⚠️ 开关已打开但时间选择器未出现，请手动设置时间');
      return false;
    }

    // —— 3. 日期：默认为当天，目标不是当天时尝试点日历 ——
    const dateShow = page.locator('.date-picker-date .date-show').first();
    let curDate = ((await dateShow.textContent().catch(() => '')) || '').trim();
    if (curDate !== wantDate) {
      const ok = await tryPickScheduleDate(page, target, log);
      if (!ok) log(`⚠️ 定时日期当前为 ${curDate}，需手动改为 ${wantDate}（时间将正常填写）`);
      curDate = ((await dateShow.textContent().catch(() => '')) || '').trim();
    }

    // —— 4. 选时间：点开面板 → 点小时 → 点分钟 ——
    await timerShow.click();
    await sleep(900);
    await pickScheduleHourMinute(page, hh, mm, log);
    // 点旁边空白处收起时间面板（点外部即确认选择）；点不到再按 Esc 兜底
    await sleep(400);
    if (await timePanelVisible(page)) {
      if (await clickBlankArea(page)) {
        await sleep(700);
      }
      if (await timePanelVisible(page)) {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(400);
      }
      if (await timePanelVisible(page)) {
        log('⚠️ 时间面板未能自动收起，请手动点击一下空白处');
      }
    }

    // —— 5. 读回校验 ——
    await sleep(600);
    const gotTime = ((await timerShow.textContent().catch(() => '')) || '').trim();
    const gotDate = ((await dateShow.textContent().catch(() => '')) || '').trim();
    if (gotTime === wantTime && gotDate === wantDate) {
      log(`✅ 定时发布已设置：${gotDate} ${gotTime}`);
      return true;
    }
    await shot(page, 'bili-schedule-verify-fail');
    log(`⚠️ 定时时间校验不一致（页面显示 ${gotDate} ${gotTime}，目标 ${wantDate} ${wantTime}），请人工检查`);
    return gotTime === wantTime; // 时间对了也算基本成功，仅日期需人工
  } catch (e) {
    await shot(page, 'bili-schedule-fail');
    log(`⚠️ 定时发布填写失败（${e.message.split('\n')[0]}），保持默认，请手动调整`);
    return false;
  }
}

/** 时间面板是否可见（遍历检查，避免 first() 命中隐藏的弹窗副本） */
async function timePanelVisible(page) {
  for (const w of await page.locator('.time-picker-panel-select-wrp').all()) {
    if (await w.isVisible().catch(() => false)) return true;
  }
  return false;
}

/** 在时间面板里点选小时与分钟（小时列含 23，分钟列含 55 且为 5 分钟档） */
async function pickScheduleHourMinute(page, hh, mm, log) {
  const wrps = page.locator('.time-picker-panel-select-wrp');
  let hourWrp = null;
  let minWrp = null;
  for (const w of await wrps.all()) {
    if (!(await w.isVisible().catch(() => false))) continue;
    const txt = ((await w.textContent().catch(() => '')) || '').replace(/\s+/g, '');
    if (!hourWrp && txt.includes('23')) hourWrp = w;
    else if (!minWrp && txt.includes('55')) minWrp = w;
  }
  if (!hourWrp || !minWrp) {
    const all = await wrps.all();
    const vis = [];
    for (const w of all) if (await w.isVisible().catch(() => false)) vis.push(w);
    hourWrp = hourWrp || vis[0] || null;
    minWrp = minWrp || vis[1] || null;
  }

  const isEnabled = async (el) => !(((await el.getAttribute('class').catch(() => '')) || '').includes('disabled'));
  const clickItem = async (wrp, want, isMinute) => {
    if (!wrp) return null;
    const items = wrp.locator('.time-picker-panel-select-item');
    const n = await items.count();
    // 先找目标档
    for (let i = 0; i < n; i++) {
      const it = items.nth(i);
      const t = ((await it.textContent().catch(() => '')) || '').trim();
      if (t === pad2(want) || t === String(want)) {
        if (await isEnabled(it)) {
          await it.click();
          return t;
        }
        break; // 目标档被禁用（已过），落到下面的兜底
      }
    }
    // 兜底：取 ≥ 目标 的第一个可用档（分钟场景）
    for (let i = 0; i < n; i++) {
      const it = items.nth(i);
      const t = ((await it.textContent().catch(() => '')) || '').trim();
      if (/^\d{1,2}$/.test(t) && Number(t) >= want && (await isEnabled(it))) {
        await it.click();
        log(`定时${isMinute ? '分钟' : '小时'}档 ${pad2(want)} 不可用，已调整为 ${t}`);
        return t;
      }
    }
    return null;
  };

  const gotH = await clickItem(hourWrp, hh, false);
  if (gotH !== null) await sleep(600);
  // 选完小时后面板可能收起，重新点开
  if (!(await timePanelVisible(page))) {
    await page.locator('.date-picker-timer .date-show').first().click().catch(() => {});
    await sleep(700);
  }
  const gotM = await clickItem(minWrp, mm, true);
  if (gotM === null) log(`⚠️ 未能点选分钟（目标 ${pad2(mm)}），请手动补选`);
  return gotH !== null && gotM !== null;
}

/** 目标日期不是当天时，尝试点开日历选日期（结构未知，尽力而为，失败截图告警） */
async function tryPickScheduleDate(page, target, log) {
  // 2026-10 页面结构：.date-picker-date-wrp 里点 .date-picker-date 弹出 .date-picker-container，
  // 标题 .date-picker-nav-title「2026年10月」，双箭头 svg.next-btn-month 翻下个月（单箭头 next-btn-day 是往后挪一天），可选的日子是 .date-wrp .date-item。
  // 跨月（如 10/21 定 11/1）必须先翻月，原来的写法只会点到当月那个灰掉的「1」（2026-10-21 Windows 实测）
  const ok = await pickDateInCalendar(page, target, log).catch(() => null);
  if (ok !== null) return ok;
  return tryPickScheduleDateLegacy(page, target, log);
}

/** 按当前页面结构选日期；找不到这套结构返回 null（交给旧写法兜底） */
async function pickDateInCalendar(page, target, log) {
  const wrap = await firstVisible(page.locator('.date-picker-date-wrp'));
  if (!wrap) return null;
  await wrap.locator('.date-picker-date').first().click();
  await sleep(800);
  const box = wrap.locator('.date-picker-container').first();
  if (!(await box.isVisible().catch(() => false))) return null;
  const title = box.locator('.date-picker-nav-title').first();
  const want = `${target.getFullYear()}年${target.getMonth() + 1}月`;
  for (let i = 0; i < 3; i++) {
    const t = ((await title.textContent().catch(() => '')) || '').trim();
    if (t === want) break;
    await box.locator('svg.next-btn-month').first().click();
    await sleep(500);
  }
  if (((await title.textContent().catch(() => '')) || '').trim() !== want) {
    await shot(page, 'bili-schedule-date-fail');
    log(`日历翻不到 ${want}`);
    return false;
  }
  const day = String(target.getDate());
  let cell = null;
  for (const el of await box.locator('.date-wrp .date-picker-body-item').all()) {
    if (((await el.textContent().catch(() => '')) || '').trim() !== day) continue;
    const cls = (await el.getAttribute('class').catch(() => '')) || '';
    if (/disabled/.test(cls)) break; // 超出可选范围（早于 5 分钟后或晚于 15 天）
    cell = el;
    break;
  }
  if (!cell) {
    await shot(page, 'bili-schedule-date-fail');
    log(`日历里 ${want}${day}日 不可选（B站只能定 5 分钟到 15 天之内）`);
    return false;
  }
  await cell.click();
  await sleep(800);
  const now = ((await wrap.locator('.date-show').first().textContent().catch(() => '')) || '').trim();
  if (now === `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}`) {
    log(`已选择定时日期：${now}`);
    return true;
  }
  await shot(page, 'bili-schedule-date-fail');
  return false;
}

async function tryPickScheduleDateLegacy(page, target, log) {
  try {
    const dateArea = page.locator('.date-picker-date').first();
    await dateArea.click();
    await sleep(1000);
    const day = String(target.getDate());
    // 日历里的“日”格子：可见叶子元素、文本恰为目标日、不在时间面板/主表单里
    const cands = page.locator('span, td, div, li, p');
    for (const el of await cands.all()) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const cls = (await el.getAttribute('class').catch(() => '')) || '';
      if (cls.includes('time-picker-panel')) continue;
      if (/disabled|prev|next|out/.test(cls)) continue;
      const txt = ((await el.textContent().catch(() => '')) || '').trim();
      if (txt !== day) continue;
      if ((await el.locator('*').count()) > 0) continue; // 只点叶子
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width > 60 || box.height > 40) continue; // 日历格子尺寸
      await el.click();
      await sleep(800);
      const now = ((await page.locator('.date-picker-date .date-show').first().textContent().catch(() => '')) || '').trim();
      if (now === `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}`) {
        log(`已选择定时日期：${now}`);
        return true;
      }
      break;
    }
    await shot(page, 'bili-schedule-date-fail');
    return false;
  } catch {
    await shot(page, 'bili-schedule-date-fail');
    return false;
  }
}

/**
 * 主流程：在给定 page（新标签页）中完成B站填表。
 * fields: {title, desc, tags}; opts: {schedule, when, cover, ui}
 * opts.ui：见 douyin.js——点击/打字用 ui.run 包起来（并行时一次一个标签页），等上传的时间不占前台。
 */
async function fillBilibili(page, topic, fields, opts, log) {
  const ui = opts.ui || NOOP_UI;
  const T = createTimer();
  log('打开B站创作中心上传页…');
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);

  if (!page.url().includes('member.bilibili.com')) {
    await shot(page, 'bili-need-login');
    const err = new Error('B站未登录：请在打开的 Chrome 窗口中登录B站后重试');
    err.code = 'NEED_LOGIN';
    throw err;
  }

  log('寻找上传入口…');
  let input = await findVideoInput(page);
  for (let i = 0; i < 60 && !input; i++) input = await findVideoInput(page), await sleep(1000);
  if (!input) {
    await shot(page, 'bili-no-file-input');
    const err = new Error('未找到B站上传入口（可能未登录或页面改版），截图见 logs/bili-no-file-input.png');
    err.code = 'NO_FILE_INPUT';
    throw err;
  }

  // 等上传按钮真正可见再传：页面还在初始化时塞文件会被丢掉（多平台同时填、电脑忙时常见）
  await page.getByText('上传视频', { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await sleep(1000);
  log(`开始上传成片：${topic.videoName}（大文件需要等待）`);
  await input.setInputFiles(topic.video);
  // 锁外等表单出来：正常几秒就出现。偶尔页面卡住（实测一次等了 10 分钟也没出来，单独重试立刻就好），
  // 所以 90 秒还没出来就截图、刷新页面重新上传一次，再不行就报错并留截图
  if (!(await waitForm(page, 90000, log))) {
    await shot(page, 'bili-form-missing-1');
    log('⚠️ 上传后 90 秒还没出现填写表单，刷新页面重新上传一次（截图 logs/bili-form-missing-1.png）');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(3000);
    input = await findVideoInput(page);
    for (let i = 0; i < 30 && !input; i++) input = await findVideoInput(page), await sleep(1000);
    if (input) await input.setInputFiles(topic.video);
    if (!input || !(await waitForm(page, 600000, log))) {
      await shot(page, 'bili-form-missing');
      throw new Error('B站上传后一直没有出现填写表单（截图见 logs/bili-form-missing.png），请到这个标签页看看是不是有弹窗挡着，或稍后重试');
    }
  }
  T.lap('打开并开始上传');

  const when = opts.schedule && opts.when ? opts.when : null;
  let scheduled = false;
  await ui.run(page, async () => {
    await fillTitle(page, fields.title, log);
    T.lap('填标题');
    // 定时放在标题之后、其余慢项（简介/标签/封面）之前：用户检查表单时它得已经设好了
    if (when) {
      scheduled = await setScheduleTime(page, when, log);
      T.lap('定时');
    }
    await fillDesc(page, fields.desc, log);
    await fillTags(page, fields.tags || [], log);
    T.lap('填简介/标签');
    if (opts.cover && fs.existsSync(opts.cover.path)) {
      await setCover(page, opts.cover.path, log);
      T.lap('封面');
    }
  });

  await waitUploadDone(page, log);
  T.lap('等上传完成');
  const vids = await silenceVideos(page, 40000);
  if (vids) log(`已暂停预览视频（${vids} 个）`);

  // 核对：上传完成时页面可能把定时重置了；之前没设成的这里再设一次
  if (when && !(scheduled && (await scheduleStill(page, when)))) {
    if (scheduled) log('ⓘ 上传完成后定时设置不在了（页面重置了表单），重新设置');
    scheduled = await ui.run(page, () => setScheduleTime(page, when, log));
    T.lap('补设定时');
  }

  await silenceVideos(page, 3000);
  const s = await shot(page, `bili-done-${topic.id}-${Date.now()}`);
  log('💡 请确认分区后手动点击「立即投稿」');
  log(scheduled ? '✅ B站填写完成（已设定时），请人工检查后点击「立即投稿」' : '✅ B站填写完成，请人工检查后点击「立即投稿」');
  log(`⏱ 用时 ${T.total().toFixed(0)} 秒：${T.summary()}`);
  return { screenshot: s, scheduled };
}

module.exports = { fillBilibili, setScheduleTime, scheduleStill, setCover, waitUploadDone };
