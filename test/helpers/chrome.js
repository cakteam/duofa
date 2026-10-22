'use strict';
// 本机有没有装 Google Chrome（需要真浏览器的用例没有 Chrome 就跳过）。Mac / Windows / Linux 的常见安装位置。
const fs = require('fs');
const path = require('path');

const candidates = {
  darwin: ['/Applications/Google Chrome.app'],
  win32: [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  linux: ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'],
}[process.platform] || [];

module.exports = { HAVE_CHROME: candidates.some((p) => fs.existsSync(p)) };
