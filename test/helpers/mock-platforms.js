'use strict';
// 假的视频号助手 / 抖音创作者中心 / B站创作中心：用 Playwright 的网络拦截把真实域名下的请求换成本地页面，
// 让 lib/channels.js、douyin.js、bilibili.js 的真实代码在 headless Chrome 里完整跑一遍，不碰真实平台。
// 页面结构照 2026-10-10 在真实页面上实测到的样子写（不是平台真实页面，但保留了踩过的坑，防止改回去）：
//   · 视频号：几十个隐藏的 div.weui-desktop-dialog；「编辑封面」弹窗里嵌着隐藏的「裁剪封面图」弹窗，它的主按钮「确定」排在可见的「确认」前面；
//     封面缩略图上盖着遮罩层（vertical-mask-layer），遮罩没消失时点封面没反应；遮罩消失的时间不固定；点「确认」后弹窗约 1.5 秒自己关、缩略图换图；
//     定时是两个单选「不定时 / 定时」；上传期间就能设定时。
// 行为可调：上传多久 / 表单多久出来 / 上传完成时是否重置表单（含定时）/ 遮罩何时消失 / 裁剪框形态 / 页面是否一直在轮询（等不到 networkidle）
//   / 上传完成后预览视频是否自动带声音播放，页面自己是否还会反复尝试播放。
// 页面里的 window.__mockState() 返回当前表单状态与各动作的时间戳，测试用它核对。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 1 秒、8kHz 单声道的方波音（<video> 能播放音频文件，用来验证“预览视频自动播放有声音”）。 */
function makeWav() {
  const rate = 8000, n = rate;
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = (Math.floor(i / 9) % 2) ? 160 : 96;
  return buf;
}
const WAV = makeWav();
// 1x1 PNG（封面缩略图用）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const BASE_CSS = `
body{font:14px sans-serif;margin:20px;min-height:1400px}
.hidden{display:none!important}
.row{margin:10px 0}
button{padding:4px 10px}
.weui-desktop-btn_disabled{opacity:.5}
.weui-desktop-dialog{position:fixed;left:240px;top:90px;width:520px;min-height:120px;background:#fff;border:2px solid #555;padding:16px;z-index:50}
.weui-desktop-dialog .weui-desktop-dialog{z-index:60;left:60px;top:60px}
.input-editor,.zone-container{border:1px solid #888;min-height:60px;width:420px;padding:4px}
.dropdown{border:1px solid #aaa;width:200px;background:#fff}
.location-item{padding:4px;cursor:pointer}
.position-display{cursor:pointer;border-bottom:1px dotted #666;display:inline-block}
.vertical-cover-wrap,.horizontal-cover-wrap{position:relative;border:1px dashed #666;width:150px;height:100px;cursor:pointer;display:inline-block;margin-right:12px;vertical-align:top}
.vertical-cover-wrap img{width:150px;height:70px;display:block}
.vertical-mask-layer{position:absolute;left:0;top:0;width:150px;height:70px;background:rgba(0,0,0,.35);z-index:5}
.weui-desktop-picker__panel{border:1px solid #aaa;width:290px;padding:6px;background:#fff;position:absolute;z-index:40}
table.weui-desktop-picker__table td a{display:inline-block;width:30px;height:20px;cursor:pointer}
a.disabled{color:#bbb;cursor:default}
.time-picker-panel-select-wrp{display:inline-block;vertical-align:top;border:1px solid #aaa;margin:2px;max-height:120px;overflow:auto}
.time-picker-panel-select-item{padding:1px 8px;cursor:pointer}
.switch-container{display:inline-block;width:40px;height:20px;background:#ccc;border-radius:10px;cursor:pointer}
.switch-container-active{background:#0a0}
.date-show{display:inline-block;border:1px solid #888;padding:2px 8px;cursor:pointer}
`;

// ---------------------------------------------------------------------------------------------------------- 视频号助手
const CHANNELS_JS = `
(function(){
  var C = window.__MOCK, $ = function(s){ return document.querySelector(s); };
  var T = window.__T = {}, now = function(){ return Math.round(performance.now()); };
  function show(el,on){ el.classList.toggle('hidden', !on); }
  function route(){ var post = /post\\/create$/.test(location.pathname); show($('#home'), !post); show($('#post'), post); }
  $('#goPost').onclick = function(){ history.pushState({}, '', '/platform/post/create'); route(); };
  window.addEventListener('popstate', route); route();
  if (C.busy) setInterval(function(){ fetch('/__poll').catch(function(){}); }, 100);   // 页面一直在轮询：永远等不到 networkidle

  var V = $('#preview'), playCalls = 0, playing = 0;
  V.addEventListener('playing', function(){ playing++; });
  function tryPlay(){ playCalls++; V.muted = false; var p = V.play(); if (p && p.catch) p.catch(function(){}); }

  $('#videoFile').addEventListener('change', function(){
    T.uploadStart = now(); show($('#uploadStatus'), true);
    setTimeout(function(){ show($('#form'), true); T.formShown = now(); }, C.formDelayMs);
    setTimeout(finish, C.uploadMs);
    // 封面缩略图上的遮罩：平台自己的后处理期间一直在；消失的时间不固定（C.maskClearMs = 上传开始后多久）
    setTimeout(function(){ show($('#coverMask'), false); T.maskGone = now(); }, C.maskClearMs);
  });
  function finish(){
    T.uploadDone = now();
    var b = $('#publishBtn'); b.disabled = false; b.classList.remove('weui-desktop-btn_disabled');
    $('#uploadStatus').textContent = '上传完成';
    V.src = '/__mock/tone.wav'; tryPlay();
    var n = 0, h = setInterval(function(){ tryPlay(); if (++n > C.autoplayRetries) clearInterval(h); }, 300);
    if (C.resetOnDone) setTimeout(function(){
      $('#shortTitle').value = ''; $('#editor').innerHTML = (C.resetOnDone === 'junk') ? '页面自动生成的描述' : '';
      $('.position-display').textContent = '显示位置'; $('#orig').checked = false;
      $('#notSched').checked = true; $('#schedDate').value = ''; $('#schedTime').value = ''; show($('#schedDate'), false); show($('#schedTime'), false);
      T.reset = now();
    }, 50);
  }

  $('#shortTitle').addEventListener('input', function(){ T.titleAt = T.titleAt || now(); T.titleFills = (T.titleFills||0) + 1; });
  $('#editor').addEventListener('input', function(){ T.descAt = T.descAt || now(); });

  $('.position-display').onclick = function(){ show($('#posDrop'), true); };
  document.querySelectorAll('.location-item').forEach(function(el){
    el.onclick = function(){ $('.position-display').textContent = el.querySelector('.name').textContent; show($('#posDrop'), false); T.locAt = T.locAt || now(); };
  });

  $('#orig').addEventListener('change', function(){ if (this.checked) show($('#origDlg'), true); T.origAt = T.origAt || now(); });
  $('#origAgree').addEventListener('change', function(){ var ok = $('#origOk'); ok.disabled = !this.checked; ok.classList.toggle('weui-desktop-btn_disabled', !this.checked); });
  $('#origOk').onclick = function(){ show($('#origDlg'), false); };

  // —— 封面：点缩略图（遮罩还在时点不动：遮罩吞掉点击）——
  $('#coverMask').addEventListener('click', function(e){ e.stopPropagation(); T.maskedClicks = (T.maskedClicks || 0) + 1; });
  $('.vertical-cover-wrap').addEventListener('click', function(){ T.coverOpened = now(); show($('#coverDlg'), true); });
  $('#coverFile').addEventListener('change', function(){
    T.coverPicked = now();
    var im = $('#coverPreview'); im.src = '/__mock/cover-pick.png'; show(im, true);
  });
  function coverApply(){
    show($('#cropDlg'), false); show($('#coverDlg'), false);
    $('#coverThumb').src = '/__mock/cover-1.png?' + now(); T.coverDone = now();
  }
  $('#coverOk').onclick = function(){
    T.coverConfirm = now();
    if (C.crop === 'dialog') show($('#cropDlg'), true);      // 比例不合时才有的裁剪框（嵌在弹窗里的那个）
    else setTimeout(coverApply, 1500);                        // 实测：点确认后弹窗约 1.5–2 秒自己关，缩略图换图
  };
  $('#cropOk').onclick = coverApply;

  // —— 定时：两个单选「不定时 / 定时」；上传期间就能设 ——
  var view = new Date(); view.setDate(1);
  function renderPicker(){
    $('#pickLabel').textContent = view.getFullYear() + '年' + (view.getMonth() + 1) + '月';
    var body = $('#pickBody'); body.innerHTML = '';
    var first = new Date(view.getFullYear(), view.getMonth(), 1).getDay(), days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate(), tr;
    var t0 = new Date(); t0.setHours(0, 0, 0, 0);
    for (var i = 0; i < 42; i++) {
      if (i % 7 === 0) { tr = document.createElement('tr'); body.appendChild(tr); }
      var td = document.createElement('td'), a = document.createElement('a'), d = i - first + 1;
      if (d < 1 || d > days) a.className = 'disabled';
      else {
        a.textContent = String(d);
        if (new Date(view.getFullYear(), view.getMonth(), d) < t0) a.className = 'disabled';
        else a.onclick = (function(dd){ return function(){
          var m = view.getMonth() + 1;
          $('#schedDate').value = view.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd + ' 00:00';
          T.dateAt = now(); show($('#picker'), false);
        }; })(d);
      }
      td.appendChild(a); tr.appendChild(td);
    }
  }
  $('#schedRadio').addEventListener('change', function(){
    if (C.noSchedule) { this.checked = false; $('#notSched').checked = true; return; }
    show($('#schedDate'), true); show($('#schedTime'), true); T.schedOn = now();
  });
  $('#notSched').addEventListener('change', function(){ show($('#schedDate'), false); show($('#schedTime'), false); });
  $('#schedDate').addEventListener('click', function(){ renderPicker(); show($('#picker'), true); });
  $('#pickNext').onclick = function(){ view.setMonth(view.getMonth() + 1); renderPicker(); };
  $('#schedTime').addEventListener('keydown', function(e){
    if (e.key === 'Enter') {
      T.timeAt = now();
      var d = $('#schedDate').value.split(' ')[0]; if (d) $('#schedDate').value = d + ' ' + this.value;
    }
  });

  window.__mockState = function(){
    return {
      T: T, title: $('#shortTitle').value, desc: $('#editor').innerText, loc: $('.position-display').textContent, orig: $('#orig').checked,
      sched: { on: $('#schedRadio').checked, date: $('#schedDate').value, time: $('#schedTime').value },
      uploadDone: !!T.uploadDone, coverDone: !!T.coverDone, coverSrc: $('#coverThumb').getAttribute('src'),
      video: { paused: V.paused, muted: V.muted, playing: playing, playCalls: playCalls },
    };
  };
})();`;

function hiddenDialogs(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<div class="weui-desktop-dialog hidden"><div class="weui-desktop-dialog__hd"><h3 class="weui-desktop-dialog__title">无关弹窗${i}</h3></div><div class="weui-desktop-dialog__ft"><button class="weui-desktop-btn weui-desktop-btn_primary">我知道了</button></div></div>`;
  return s;
}

function channelsApp(cfg) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>视频号助手(mock)</title><style>${BASE_CSS}</style></head><body>
<div id="home" class="hidden"><button class="weui-desktop-btn weui-desktop-btn_primary" id="goPost">发表视频</button></div>
<div id="post" class="hidden">
  <input type="file" id="videoFile" accept="video/*">
  <div id="uploadStatus" class="hidden">上传中…</div>
  <div id="form" class="hidden">
    <div class="row"><div>封面预览</div>
      <div class="vertical-cover-wrap img-popover-wrap"><div class="vertical-img-wrap"><img id="coverThumb" class="vertical-img-size cover-img-vertical" src="/__mock/cover-0.png"><div class="edit-btn edit-btn-zIndex">编辑</div></div>
        <div class="vertical-mask-layer" id="coverMask"></div>
        <div class="tips-wrap"><div class="cover-tips">个人主页和分享卡片(3:4)</div></div></div></div>
    <div class="row"><div>短标题</div><div><span><input type="text" id="shortTitle" placeholder="填写短标题有机会获得更多流量"></span></div></div>
    <div class="row"><div class="input-editor" id="editor" contenteditable="true"></div></div>
    <div class="row"><div class="label">位置</div>
      <div class="post-position-wrap"><div class="position-display">显示位置</div>
        <div class="dropdown hidden" id="posDrop"><div class="location-item"><span class="name">不显示位置</span></div><div class="location-item"><span class="name">北京市</span></div></div></div></div>
    <div class="row"><span>声明原创</span> <span class="declare-original-checkbox"><label class="ant-checkbox-wrapper" style="display:inline-block;width:18px;height:18px"><input type="checkbox" id="orig"></label></span></div>
    <div class="row"><span>定时发表</span>
      <label class="weui-desktop-form__check-label"><input type="radio" class="weui-desktop-form__radio" name="pub" value="0" id="notSched" checked><i class="weui-desktop-icon-radio"></i> <span class="weui-desktop-form__check-content">不定时</span></label>
      <label class="weui-desktop-form__check-label" id="schedLabel"><input type="radio" class="weui-desktop-form__radio" name="pub" value="1" id="schedRadio"><i class="weui-desktop-icon-radio"></i> <span class="weui-desktop-form__check-content">定时</span></label>
      <input class="hidden" id="schedDate" placeholder="请选择发表时间"> <input class="hidden" id="schedTime" placeholder="请选择时间"></div>
  </div>
  <div class="form-btns"><button class="weui-desktop-btn weui-desktop-btn_primary weui-desktop-btn_disabled" id="publishBtn" disabled>发表</button></div>
  <video id="preview" loop playsinline style="width:240px;height:100px"></video>
</div>
<div class="weui-desktop-picker__panel hidden" id="picker">
  <button class="weui-desktop-btn__icon__left">&lt;</button> <span class="weui-desktop-picker__panel__label" id="pickLabel"></span> <button class="weui-desktop-btn__icon__right" id="pickNext">&gt;</button>
  <table class="weui-desktop-picker__table"><tbody id="pickBody"></tbody></table>
</div>
${hiddenDialogs(12)}
<div class="weui-desktop-dialog hidden" id="origDlg"><div class="weui-desktop-dialog__hd"><h3 class="weui-desktop-dialog__title">原创权益</h3></div><label><input type="checkbox" id="origAgree"> 我已阅读并同意</label>
  <div class="weui-desktop-dialog__ft"><button class="weui-desktop-btn weui-desktop-btn_primary weui-desktop-btn_disabled" id="origOk" disabled>声明原创</button></div></div>
<div class="weui-desktop-dialog hidden" id="coverDlg" style="width:560px">
  <div class="weui-desktop-dialog__hd"><h3 class="weui-desktop-dialog__title" id="coverTitle">编辑封面</h3></div>
  <div class="weui-desktop-dialog__bd">
    <div class="single-cover-uploader-wrap"><input type="file" id="coverFile" accept="image/jpeg,image/jpg,image/png" style="display:none"><div class="wrap"><div class="text-wrap">上传封面</div></div><img class="img-wrap hidden" id="coverPreview" width="40" height="40"></div>
    <div class="weui-desktop-dialog hidden" id="cropDlg">
      <div class="weui-desktop-dialog__hd"><h3 class="weui-desktop-dialog__title">裁剪封面图</h3></div>
      <div class="weui-desktop-dialog__ft"><div class="finder-dialog-footer"><div class="weui-desktop-btn_wrp cancel"><button type="button" class="weui-desktop-btn weui-desktop-btn_default weui-desktop-btn_mini">取消</button></div><div class="weui-desktop-btn_wrp"><button type="button" class="weui-desktop-btn weui-desktop-btn_primary weui-desktop-btn_mini" id="cropOk">确定</button></div></div></div>
    </div>
  </div>
  <div class="weui-desktop-dialog__ft"><div class="finder-dialog-footer"><div class="weui-desktop-btn_wrp cancel"><button type="button" class="weui-desktop-btn weui-desktop-btn_default weui-desktop-btn_mini">取消</button></div><div class="weui-desktop-btn_wrp"><button type="button" class="weui-desktop-btn weui-desktop-btn_primary weui-desktop-btn_mini" id="coverOk">确认</button></div></div></div>
</div>
<script>window.__MOCK=${JSON.stringify(cfg)};${CHANNELS_JS}</script></body></html>`;
}

// ---------------------------------------------------------------------------------------------------------- 抖音
const DOUYIN_JS = `
(function(){
  var C = window.__MOCK, $ = function(s){ return document.querySelector(s); };
  var T = window.__T = {}, now = function(){ return Math.round(performance.now()); };
  function show(el,on){ el.classList.toggle('hidden', !on); }
  if (C.busy) setInterval(function(){ fetch('/__poll').catch(function(){}); }, 100);
  var V = $('#preview'), playCalls = 0, playing = 0;
  V.addEventListener('playing', function(){ playing++; });
  function tryPlay(){ playCalls++; V.muted = false; var p = V.play(); if (p && p.catch) p.catch(function(){}); }
  function renderForm(){ show($('#formWrap'), true); T.formShown = now(); }
  $('.upload-btn-input').addEventListener('change', function(){
    T.uploadStart = now(); history.pushState({}, '', '/creator-micro/content/post/video'); show($('#up'), false); show($('#pub'), true);
    if (!C.formAfterUpload) setTimeout(renderForm, C.formDelayMs);
    setTimeout(function(){
      T.uploadDone = now(); $('#prog').textContent = '上传完成';
      var card = document.createElement('div'); card.className = 'long-card-x'; card.innerHTML = '<div>重新上传</div>'; $('#pub').appendChild(card);
      if (C.formAfterUpload) renderForm();
      V.src = '/__mock/tone.wav'; tryPlay();
      var n = 0, h = setInterval(function(){ tryPlay(); if (++n > C.autoplayRetries) clearInterval(h); }, 300);
      if (C.resetOnDone) setTimeout(function(){ $('#dt').value = ''; show($('#dt'), false); T.reset = now(); }, 50);   // 页面把定时重置了
    }, C.uploadMs);
  });
  $('#title').addEventListener('input', function(){ T.titleAt = T.titleAt || now(); });
  $('#editor').addEventListener('input', function(){ T.descAt = T.descAt || now(); });
  $('#rSched').addEventListener('click', function(){ show($('#dt'), true); T.schedOn = now(); });
  $('#dt').addEventListener('keydown', function(e){ if (e.key === 'Enter') { T.dtAt = T.dtAt || now(); T.dtFills = (T.dtFills || 0) + 1; } });
  if (C.loginDelayMs) {   // 要求登录/验证：地址跳到登录页、没有上传入口，过一会儿（人扫完码）才出现
    history.replaceState({}, '', '/passport/login');
    var inp = $('.upload-btn-input'); inp.remove();
    setTimeout(function(){ history.replaceState({}, '', '/creator-micro/content/upload'); $('.container-a').appendChild(inp); T.loggedIn = now(); }, C.loginDelayMs);
  }
  window.__mockState = function(){
    return { T: T, title: $('#title').value, desc: $('#editor').innerText, sched: { date: $('#dt').value }, uploadDone: !!T.uploadDone,
      video: { paused: V.paused, muted: V.muted, playing: playing, playCalls: playCalls } };
  };
})();`;

function douyinApp(cfg) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>抖音创作者中心(mock)</title><style>${BASE_CSS}</style></head><body>
<div id="up"><div class="container-a"><input class="upload-btn-input" type="file" accept="video/*"></div></div>
<div id="pub" class="hidden">
  <div id="formWrap" class="hidden">
    <div class="row"><input id="title" style="width:420px" placeholder="填写作品标题，为作品获得更多流量"></div>
    <div class="row"><div class="zone-container" id="editor" contenteditable="true"></div></div>
    <div class="row"><div class="radio-x" id="rNow" style="display:inline-block">立即发布</div> <div class="radio-x" id="rSched" style="display:inline-block;cursor:pointer">定时发布</div>
      <input class="semi-input hidden" id="dt" placeholder="日期和时间"></div>
  </div>
  <div class="progress-div"><div id="prog">上传中…</div></div>
  <video id="preview" loop playsinline style="width:240px;height:100px"></video>
</div>
<script>window.__MOCK=${JSON.stringify(cfg)};${DOUYIN_JS}</script></body></html>`;
}

// ---------------------------------------------------------------------------------------------------------- B站
const BILI_JS = `
(function(){
  var C = window.__MOCK, $ = function(s){ return document.querySelector(s); };
  var T = window.__T = {}, now = function(){ return Math.round(performance.now()); };
  function show(el,on){ el.classList.toggle('hidden', !on); }
  if (C.busy) setInterval(function(){ fetch('/__poll').catch(function(){}); }, 100);
  var V = $('#preview'), playCalls = 0, playing = 0, tags = [];
  V.addEventListener('playing', function(){ playing++; });
  function tryPlay(){ playCalls++; V.muted = false; var p = V.play(); if (p && p.catch) p.catch(function(){}); }
  $('#videoFile').addEventListener('change', function(){
    T.uploadStart = now();
    setTimeout(function(){ show($('#form'), true); $('#title').value = '成片'; T.formShown = now(); }, C.formDelayMs);   // 页面会用文件名预填标题
    setTimeout(function(){
      T.uploadDone = now(); $('#status').textContent = '上传完成'; var b = $('#submit'); b.disabled = false;
      V.src = '/__mock/tone.wav'; tryPlay();
      var n = 0, h = setInterval(function(){ tryPlay(); if (++n > C.autoplayRetries) clearInterval(h); }, 300);
      if (C.resetOnDone) setTimeout(function(){ $('#swc').classList.remove('switch-container-active'); show($('#dDate'), false); show($('#dTime'), false); T.reset = now(); }, 50);   // 页面把定时重置了
    }, C.uploadMs);
  });
  $('#title').addEventListener('input', function(){ T.titleAt = T.titleAt || now(); });
  $('#desc').addEventListener('input', function(){ T.descAt = T.descAt || now(); });
  $('#tag').addEventListener('keydown', function(e){
    if (e.key === 'Enter' && this.value) { tags.push(this.value); this.value = ''; var s = document.createElement('span'); s.className = 'tagchip'; s.textContent = tags[tags.length - 1]; $('#tags').appendChild(s); T.tagAt = T.tagAt || now(); }
  });
  // —— 定时：开关 + 日期 + 时间面板（小时列含 23、分钟列含 55）——
  var hh = '12', mm = '00';
  var hc = $('#hCol'), mc = $('#mCol');
  for (var i = 0; i < 24; i++) { var it = document.createElement('div'); it.className = 'time-picker-panel-select-item'; it.textContent = (i < 10 ? '0' : '') + i; it.onclick = (function(t){ return function(){ hh = t; }; })(it.textContent); hc.appendChild(it); }
  for (var j = 0; j < 60; j += 5) { var im = document.createElement('div'); im.className = 'time-picker-panel-select-item'; im.textContent = (j < 10 ? '0' : '') + j; im.onclick = (function(t){ return function(){ mm = t; $('#tShow').textContent = hh + ':' + mm; T.timeAt = now(); }; })(im.textContent); mc.appendChild(im); }
  $('#swc').addEventListener('click', function(){
    var on = this.classList.toggle('switch-container-active');
    show($('#dDate'), on); show($('#dTime'), on); if (on) T.schedOn = now();
  });
  $('#tShow').addEventListener('click', function(e){ e.stopPropagation(); show($('#tPanel'), true); });
  $('#tPanel').addEventListener('click', function(e){ e.stopPropagation(); });
  document.addEventListener('click', function(){ show($('#tPanel'), false); });
  window.__mockState = function(){
    return { T: T, title: $('#title').value, desc: $('#desc').value, tags: tags.slice(), uploadDone: !!T.uploadDone,
      sched: { on: $('#swc').classList.contains('switch-container-active'), date: $('#dShow').textContent.trim(), time: $('#tShow').textContent.trim() },
      video: { paused: V.paused, muted: V.muted, playing: playing, playCalls: playCalls } };
  };
})();`;

function biliApp(cfg) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>B站创作中心(mock)</title><style>${BASE_CSS}</style></head><body>
<div id="up"><input type="file" id="videoFile" accept="video/*"></div>
<div id="form" class="hidden">
  <div class="row"><input id="title" style="width:420px" placeholder="请输入稿件标题"></div>
  <div class="row"><textarea id="desc" style="width:420px;height:60px" placeholder="请输入简介"></textarea></div>
  <div class="row"><input id="tag" placeholder="按回车键Enter创建标签"><div id="tags"></div></div>
  <div class="row"><span>定时发布</span> <span class="time-switch-wrp"><span class="switch-container" id="swc"></span></span>
    <span class="date-picker-date hidden" id="dDate"><span class="date-show" id="dShow">${cfg.defaultDate}</span></span>
    <span class="date-picker-timer hidden" id="dTime"><span class="date-show" id="tShow">12:00</span></span>
    <div class="time-picker-panel hidden" id="tPanel"><div class="time-picker-panel-select-wrp" id="hCol"></div><div class="time-picker-panel-select-wrp" id="mCol"></div></div></div>
  <div class="row"><span id="status">上传中…</span></div>
  <div class="row"><button id="submit" disabled>提交稿件</button></div>
</div>
<video id="preview" loop playsinline style="width:240px;height:100px"></video>
<script>window.__MOCK=${JSON.stringify(cfg)};${BILI_JS}</script></body></html>`;
}

const tomorrow = () => { const d = new Date(Date.now() + 86400e3); const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

const DEFAULTS = () => ({
  channels: { uploadMs: 4000, formDelayMs: 700, resetOnDone: false, maskClearMs: 5200, crop: 'none', busy: true, autoplayRetries: 6, noSchedule: false },
  douyin: { uploadMs: 4000, formDelayMs: 700, formAfterUpload: false, resetOnDone: false, busy: true, autoplayRetries: 6 },
  bili: { uploadMs: 4000, formDelayMs: 700, resetOnDone: false, defaultDate: tomorrow(), busy: true, autoplayRetries: 6 },
});

/** 在 context 上装好三个平台的假页面。overrides = { channels: {...}, douyin: {...}, bili: {...} } 覆盖默认行为。 */
async function installMocks(ctx, overrides = {}) {
  const d = DEFAULTS();
  const cfg = {
    channels: { ...d.channels, ...(overrides.channels || {}) },
    douyin: { ...d.douyin, ...(overrides.douyin || {}) },
    bili: { ...d.bili, ...(overrides.bili || {}) },
  };
  const serve = (host, app, c) => ctx.route(`https://${host}/**`, async (route) => {
    const u = new URL(route.request().url());
    try {
      if (u.pathname === '/__poll') { await sleep(120); return await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }); }
      if (u.pathname === '/__mock/tone.wav') return await route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV });
      if (/^\/__mock\/.*\.png$/.test(u.pathname)) return await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      return await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: app(c) });
    } catch { /* 页面/上下文已经关了 */ }
  });
  await serve('channels.weixin.qq.com', channelsApp, cfg.channels);
  await serve('creator.douyin.com', douyinApp, cfg.douyin);
  await serve('member.bilibili.com', biliApp, cfg.bili);
  return { cfg, state: (page) => page.evaluate(() => window.__mockState()) };
}

module.exports = { installMocks, DEFAULTS, tomorrow };
