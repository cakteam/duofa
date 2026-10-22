'use strict';
/**
 * 多发的配置：读程序目录下的 config.json（不进 git，复制 config.example.json 改名即可），缺项用默认值。
 * 环境变量优先于 config.json：DUOFA_CONTENT_DIR、DUOFA_DATA_DIR、PORT。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');

const DEFAULTS = {
  // 内容目录：里面是一个个日期目录（1021 或 2026-10-21），日期目录里每个子文件夹是一条内容。留空 = 用自带的「示例内容」
  contentDir: '',
  // 「数据」页下载的各平台数据存到哪里；留空 = 内容目录下的「数据下载」
  dataDir: '',
  port: 8686,
  channels: {
    hideLocation: true, // 视频号「位置」设为「不显示位置」
    declareOriginal: false, // 视频号自动勾选「声明原创」——只在内容确实是你原创时打开
  },
};

function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function readFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`读取配置失败（${file}）：${e.message}，先用默认值`);
    return {};
  }
}

let cached = null;

/** 合并后的配置；contentDir / dataDir 已展开成绝对路径。 */
function load({ env = process.env, file = path.join(APP_DIR, 'config.json'), fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const raw = readFile(file);
  const contentDir = path.resolve(expandHome(env.DUOFA_CONTENT_DIR || raw.contentDir || '') || path.join(APP_DIR, '示例内容'));
  const dataDir = path.resolve(expandHome(env.DUOFA_DATA_DIR || raw.dataDir || '') || path.join(contentDir, '数据下载'));
  cached = {
    appDir: APP_DIR,
    contentDir,
    dataDir,
    port: Number(env.PORT) || Number(raw.port) || DEFAULTS.port,
    channels: { ...DEFAULTS.channels, ...(raw.channels || {}) },
  };
  return cached;
}

module.exports = { load, DEFAULTS, APP_DIR };
