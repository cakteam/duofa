'use strict';
/**
 * 本地服务的访问防护。
 *
 * 多发只监听 127.0.0.1，但浏览器里任何网页都能向 127.0.0.1 发请求（跨站请求、DNS rebinding），
 * 而这里的端点能读本机文件、操作已登录的平台后台，所以：
 *   1. guard()      对全部 /api 请求校验 Host、Origin、Sec-Fetch-Site（同源页面不受影响）。
 *   2. makeSafePath() 路径白名单（带分隔符边界），只放行内容目录、数据目录等。
 */
const path = require('path');

function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/** 对 /api 全部请求：Host 必须是本机、Origin（如有）必须同源、Sec-Fetch-Site 不能是跨站。 */
function guard(port) {
  const hosts = allowedHosts(port);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return function (req, res, next) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!hosts.has(host)) return res.status(403).json({ error: '拒绝：Host 不是本机地址' });
    const origin = req.headers.origin;
    if (origin && !origins.has(String(origin).toLowerCase())) return res.status(403).json({ error: '拒绝：跨站请求' });
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return res.status(403).json({ error: '拒绝：跨站请求' });
    next();
  };
}

/** 路径白名单：允许的根目录之内（含自身），边界按路径分隔符判断。 */
function makeSafePath(roots) {
  const resolved = roots.filter(Boolean).map((r) => path.resolve(r));
  return function safePath(p) {
    if (!p || typeof p !== 'string') return null;
    const r = path.resolve(p);
    for (const root of resolved) {
      if (r === root || r.startsWith(root + path.sep)) return r;
    }
    return null;
  };
}

module.exports = { guard, makeSafePath, allowedHosts };
