'use strict';
/**
 * 数据抓取共享 helper（V2.0 数据下载）。
 * 两条取数路线：
 *   1) XHR 嗅探：attachCapture(page) 记录页面自己发出的 JSON 响应，等数据接口命中后取回；
 *   2) 页面内重放：inPageFetch(page, url, opts) 在页面上下文里用 fetch 重放平台接口
 *      （同一 origin 自动带登录 cookie，无跨域/签名问题）。
 * 登录检测沿用填表模块的 NEED_LOGIN 错误码约定。
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 失败现场截图（与各填表模块的 shot() 同款） */
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

/**
 * 挂上响应监听器，返回 captures 数组（引用，实时追加）。
 * 只记录 JSON 响应：{url, method, status, postData, body(字符串)}
 */
function attachCapture(page) {
  const captures = [];
  page.on('response', (resp) => {
    try {
      const req = resp.request();
      const rt = req.resourceType();
      if (rt !== 'xhr' && rt !== 'fetch') return;
      const ct = resp.headers()['content-type'] || '';
      if (!/json/i.test(ct)) return;
      const rec = {
        url: resp.url(),
        method: req.method(),
        status: resp.status(),
        postData: null,
        body: null,
      };
      captures.push(rec);
      req
        .postData()
        .then((d) => { rec.postData = d; })
        .catch(() => {});
      resp
        .text()
        .then((t) => { rec.body = t; })
        .catch(() => {});
    } catch {}
  });
  return captures;
}

/** 取回第一个 URL 命中 pattern 且 body 可解析为 JSON 的捕获（含请求载荷，供重放取参） */
function findCapture(captures, pattern, { minLen = 0 } = {}) {
  for (let i = captures.length - 1; i >= 0; i--) {
    const c = captures[i];
    if (!c.body) continue;
    if (!c.url.includes(pattern)) continue;
    if (c.body.length < minLen) continue;
    try {
      return { url: c.url, json: JSON.parse(c.body), raw: c.body, postData: c.postData };
    } catch {}
  }
  return null;
}

/** 等待某个接口出现（轮询 captures），超时返回 null */
async function waitCapture(captures, pattern, timeoutMs = 30000, { minLen = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = findCapture(captures, pattern, { minLen });
    if (hit) return hit;
    await sleep(500);
  }
  return null;
}

/**
 * 等待页面发出的接口，未命中则 reload 重试（调用方负责先 goto 和登录检测）。
 * 第 1 轮只等待（页面刚加载），第 2+ 轮 reload 后再等；attempts 次内未命中返回 null。
 */
async function gotoUntilCapture(page, captures, url, patterns, { attempts = 3, waitMs = 12000, settleMs = 2500 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    if (i > 1) {
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      } catch {}
    }
    await sleep(settleMs);
    for (const p of patterns) {
      const hit = await waitCapture(captures, p, waitMs, { minLen: 100 });
      if (hit) return { pattern: p, hit };
    }
  }
  return null;
}

/**
 * 在页面上下文里 fetch 平台接口（带登录 cookie）。
 * opts: {method, body(对象自动 JSON), timeoutMs}
 * 返回解析后的 JSON；非 2xx 或解析失败抛错。
 */
async function inPageFetch(page, url, opts = {}) {
  const { method = 'GET', body = null, timeoutMs = 30000 } = opts;
  const payload = body && typeof body === 'object' ? JSON.stringify(body) : body;
  const result = await page.evaluate(
    ({ url, method, payload, timeoutMs }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      return fetch(url, {
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        body: payload,
        credentials: 'include',
        signal: ctrl.signal,
      })
        .then(async (r) => ({ status: r.status, text: await r.text() }))
        .finally(() => clearTimeout(timer));
    },
    { url, method, payload, timeoutMs }
  );
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`接口 ${url.split('?')[0]} 返回 ${result.status}`);
  }
  try {
    return parseJsonSafe(result.text);
  } catch {
    throw new Error(`接口 ${url.split('?')[0]} 返回非 JSON`);
  }
}

/**
 * JSON.parse 的大整数安全版：16 位以上的整数（抖音 item_id 等 19 位 ID）先转成字符串再解析，
 * 否则超过 2^53 会丢精度（7693609080341925381 → 7693609080341925000，作品链接随之失效）。
 * 正则同时匹配「整段字符串」和「大整数」，字符串原样跳过，只给字符串外的大整数加引号；
 * 万一替换后解析失败就退回原样解析。
 */
function parseJsonSafe(text) {
  const quoted = text.replace(/"(?:[^"\\]|\\.)*"|(?<![\d.eE+-])-?\d{16,}(?![\d.eE])/g, (m) => (m[0] === '"' ? m : `"${m}"`));
  if (quoted !== text) {
    try {
      return JSON.parse(quoted);
    } catch {}
  }
  return JSON.parse(text);
}

/** 平台未登录统一错误（server.js 现有提示逻辑按 err.code 识别） */
function needLoginError(platformLabel, detail) {
  const err = new Error(`${platformLabel}未登录或登录已过期${detail ? '：' + detail : ''}，请点「打开登录页」重新扫码`);
  err.code = 'NEED_LOGIN';
  return err;
}

/** 接口返回结构样本（写进原始数据 JSON 的 raw 里，接口改版时对照字段用）：顶层字段 + 前 n 条列表项 */
function sampleOf(j, listKey, n = 2) {
  if (!j || typeof j !== 'object') return j;
  const top = {};
  for (const [k, v] of Object.entries(j)) {
    if (k === listKey) continue;
    top[k] = v && typeof v === 'object' ? (Array.isArray(v) ? `[数组 ${v.length}]` : v) : v;
  }
  const list = j[listKey];
  return { ...top, [listKey]: Array.isArray(list) ? list.slice(0, n) : list };
}

module.exports = { sleep, shot, attachCapture, findCapture, waitCapture, gotoUntilCapture, inPageFetch, parseJsonSafe, sampleOf, needLoginError, LOG_DIR };
