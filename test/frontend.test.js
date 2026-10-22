'use strict';
// 界面（public/index.html 里的内联脚本，没有构建步骤）的语法检查，以及几条不能回退的约定。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('index.html 的内联脚本都能通过语法检查', () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 1);
  for (const code of blocks) assert.doesNotThrow(() => new vm.Script(code), SyntaxError);
});

test('页面只用到本服务提供的接口，不引用外部脚本', () => {
  assert.ok(!/\/api\/wf\//.test(html), '没有工作台接口');
  for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) assert.ok(m[1].startsWith('/'), m[1]);
});
