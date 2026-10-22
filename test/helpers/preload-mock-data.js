'use strict';
// 测试专用：NODE_OPTIONS=--require 预加载进真正的服务进程，把「数据」下载的浏览器和三个平台抓取函数换成假的，
// 返回 DUOFA_TEST_DATA（JSON：{ channels:{works,overview,followers}, douyin:{…}, bili:{…} }）里的数据——
// 服务的其余部分（/api/data/download、写快照、汇总表、写回数据库）原样运行，不开浏览器、不碰真实平台。
const browser = require('../../lib/browser');
const data = JSON.parse(process.env.DUOFA_TEST_DATA || '{}');
browser.ensureBrowser = async () => ({});
browser.openTab = async () => ({ close: async () => {}, screenshot: async () => Buffer.alloc(0) });
browser.getStatus = () => ({ connected: true });
const fake = (pk) => async () => {
  if (!data[pk]) throw new Error('（测试）这个平台没有假数据');
  return { works: [], overview: [], followers: [], raw: {}, ...data[pk] };
};
require('../../lib/data-channels').fetchChannelsData = fake('channels');
require('../../lib/data-douyin').fetchDouyinData = fake('douyin');
require('../../lib/data-bilibili').fetchBilibiliData = fake('bili');
