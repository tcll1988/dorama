/*
 * ================================================================
 *  app.js — 页面程序（一般不需要改）
 * ================================================================
 *  读取三个数据文件，生成页面：
 *    config.js            页面文字、语速、配色   ← 平时改这个
 *    course-data.js       课文和单词（由 tools/build-course.py 生成）
 *    reading-alignment.js 逐字高亮用的时间数据
 *
 *  本文件分为 7 段，按顺序阅读即可：
 *    1. 工具函数          2. 设置的保存与读取     3. 网址（路由）
 *    4. 页面模板（HTML）   5. 画面渲染             6. 音频播放
 *    7. 按钮事件与启动
 *
 *  不使用任何外部库；直接双击 index.html 或放到网站上都能运行。
 * ================================================================
 */
(() => {
  'use strict';

  const course = window.DRAMA_COURSE;
  const config = window.DRAMA_CONFIG;
  const T = config.text;
  const VIEWS = ['reading', 'words'];          // 页面上的标签页，顺序即显示顺序
  const STORAGE_KEY = 'drama-preferences';


  /* ============================================================
   * 1. 工具函数
   * ============================================================ */

  const $  = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // 把文字放进 HTML 前先转义，防止特殊符号破坏页面
  const escape = value => String(value ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const pad = n => String(n).padStart(2, '0');

  // 把 config.js 里的 {n}、{title} 等占位符换成实际内容
  const fill = (template, values = {}) =>
    String(template).replace(/\{(\w+)\}/g, (all, key) => (key in values ? values[key] : all));

  // 线条图标（SVG 路径）
  const ICONS = {
    book:   'M3 4h6a4 4 0 0 1 3 1 4 4 0 0 1 3-1h6v15h-6a4 4 0 0 0-3 1 4 4 0 0 0-3-1H3V4Zm9 1v15',
    words:  'M4 4h16v16H4zM8 9h8M8 13h5M8 17h3',
    arrow:  'M4 12h15m-6-6 6 6-6 6',
    play:   'm8 5 11 7-11 7V5Z',
    pause:  'M8 5v14M16 5v14',
    sound:  'M11 5 6 9H3v6h3l5 4V5Zm4 3a7 7 0 0 1 0 8m3-11a11 11 0 0 1 0 14',
    repeat: 'M4 9a8 8 0 0 1 13-4l3 3m0-5v5h-5M20 15a8 8 0 0 1-13 4l-3-3m0 5v-5h5',
    close:  'm6 6 12 12M6 18 18 6',
    bulb:   'M8 16a7 7 0 1 1 8 0v3H8v-3Zm1 6h6'
  };
  const TAB_ICONS = { reading: 'book', words: 'words' };
  const icon = name =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ICONS.book}"/></svg>`;

  const speedLabel = value => (config.speeds.find(s => s.value === value) || { label: value + '×' }).label;


  /* ============================================================
   * 2. 设置的保存与读取（ピンイン・日本語訳・スピード）
   *    保存在浏览器的 localStorage 里；无法保存时照常使用。
   * ============================================================ */

  const prefs = { py: true, jp: true, speed: config.defaultSpeed };
  let canSave = true;

  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return;
      for (const key of ['py', 'jp']) {
        if (typeof saved[key] === 'boolean') prefs[key] = saved[key];
      }
      if (config.speeds.some(s => s.value === saved.speed)) prefs.speed = saved.speed;
    } catch {
      canSave = false;
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      if (canSave) notify(T.msgCannotSave);
      canSave = false;
    }
  }


  /* ============================================================
   * 3. 网址（路由）
   *    #lesson/3/reading → 第3课 本文      #lesson/3/words → 第3课 単語
   *    已删除的页面（教材・発音、文法、練習、発音・声調）的旧链接
   *    会跳到同一课的本文页。
   * ============================================================ */

  const url = (id, view = 'reading') => `#lesson/${id}/${view}`;

  function resolveHash(hash) {
    const value = String(hash || '');
    const removed = value.match(/^#lesson\/(\d+)\/(homework|grammar|practice|pronunciation)(?:\/.*)?$/);
    if (removed) return { id: Number(removed[1]), view: 'reading', redirectedFrom: removed[2] };
    const parts = value.match(/^#lesson\/(\d+)\/(reading|words)(?:\/.*)?$/);
    if (!parts) return { id: 1, view: 'reading' };
    return { id: Number(parts[1]), view: parts[2] };
  }

  // 页面会播放的所有音频路径（测试脚本用它检查文件是否齐全）
  function playablePaths(lessons) {
    const paths = [];
    for (const lesson of lessons) {
      for (const view of VIEWS) {
        for (const line of lesson[view] || []) if (line.audio) paths.push(line.audio);
      }
    }
    return paths;
  }


  /* ============================================================
   * 4. 页面模板 —— 每个函数返回一段 HTML
   * ============================================================ */

  let lesson;   // 当前课
  let view;     // 当前标签页：'reading' 或 'words'

  // 左侧课程列表
  function sidebarHtml() {
    const links = course.map(l => `
      <a class="lesson-link ${l.id === lesson.id ? 'active' : ''}" href="${url(l.id)}" ${l.id === lesson.id ? 'aria-current="page"' : ''}>
        <span class="lesson-number">${pad(l.id)}</span>
        <span>
          <span class="lesson-name" lang="zh-Hans">${escape(l.title)}</span>
          <span class="lesson-jp">${escape(l.japanese)}</span>
        </span>
      </a>`).join('');
    return `
      <a class="brand" href="${url(1)}">
        <span class="brand-mark" lang="zh-Hans">${escape(T.brandMark)}</span>
        <span>
          <span class="brand-name">${escape(T.brandName)}</span>
          <span class="brand-sub">${escape(T.siteTitle)}</span>
        </span>
      </a>
      <div class="course-label"><span>${escape(T.lessonList)}</span><span>${escape(fill(T.lessonCount, { total: course.length }))}</span></div>
      <nav class="lesson-nav" aria-label="${escape(T.lessonList)}">${links}</nav>
      <div class="sidebar-bottom"><b aria-hidden="true">●</b> ${escape(T.sidebarNote)}</div>`;
  }

  // 顶栏
  function topbarHtml() {
    return `
      <button class="icon-button menu" id="menu" data-action="menu" aria-expanded="false" aria-controls="sidebar" aria-label="${escape(T.openMenu)}">
        <span class="menu-icon" aria-hidden="true"></span>
      </button>
      <div class="crumb"><span class="crumb-site">${escape(T.siteTitle)}</span><span class="crumb-sep" aria-hidden="true">/</span><span id="crumb-lesson"></span></div>
      <button class="help-button" data-action="help" aria-label="${escape(T.help)}"><span class="help-mark" aria-hidden="true">?</span><span class="help-label">${escape(T.help)}</span></button>`;
  }

  // 课标题
  function headingHtml() {
    return `
      <section class="lesson-heading">
        <div>
          <div class="eyebrow">LESSON ${pad(lesson.id)}<span class="tag">${escape(T.levelTag)}</span></div>
          <div class="title-line">
            <h1 lang="zh-Hans">${escape(lesson.title)}</h1>
            <span class="title-jp">${escape(lesson.japanese)}</span>
          </div>
          <p class="lesson-caption">${escape(T.caption)}</p>
        </div>
        <div class="lesson-index" aria-hidden="true">${pad(lesson.id)}<span> / ${course.length}</span></div>
      </section>`;
  }

  // 标签栏（本文 / 単語）
  function tabsHtml() {
    const tabs = VIEWS.map(v => `
      <a class="tab ${v === view ? 'active' : ''}" href="${url(lesson.id, v)}" ${v === view ? 'aria-current="page"' : ''}>
        ${icon(TAB_ICONS[v])}${escape(T.tabs[v])}<small>${lesson[v].length}</small>
      </a>`).join('');
    return `<nav class="tabs" aria-label="学習メニュー">${tabs}</nav>`;
  }

  // 显示设置栏：ピンイン / 日本語訳 / スピード
  // 三项都用同一种「分段按钮」，外观和用法一致。
  // 每个按钮带 data-action="set-pref"、data-pref（设置名）、data-value（值）。
  function settingHtml(key, title, options) {
    const buttons = options.map(o => `
      <button type="button" class="seg-option" data-action="set-pref" data-pref="${key}" data-value="${o.value}"
        aria-pressed="${prefs[key] === o.value}">${escape(o.label)}</button>`).join('');
    return `
      <div class="setting" role="group" aria-label="${escape(title)}">
        <span class="setting-title">${escape(title)}</span>
        <div class="seg">${buttons}</div>
      </div>`;
  }

  function toolbarHtml() {
    const showHide = [{ value: true, label: T.show }, { value: false, label: T.hide }];
    return `
      <div class="display-tools">
        ${settingHtml('py', T.pinyin, showHide)}
        ${settingHtml('jp', T.japanese, showHide)}
        ${settingHtml('speed', T.speed, config.speeds)}
      </div>`;
  }

  // 汉字上方逐字标拼音（有时间数据的句子）
  function alignedTextHtml(line) {
    const alignment = window.DRAMA_ALIGNMENT?.[line.id];
    if (!alignment) {
      return `<p class="cn" lang="zh-Hans">${escape(line.ch)}</p>${line.py ? `<p class="py" lang="zh-Latn">${escape(line.py)}</p>` : ''}`;
    }
    const words = alignment.words.map((word, i) => word.punctuation
      ? `<span class="reading-punctuation">${escape(word.text)}</span>`
      : `<span class="reading-word" data-word="${i}">${word.chars.map(pair =>
          `<ruby><span class="hanzi">${escape(pair.ch)}</span><rt lang="zh-Latn">${escape(pair.py)}</rt></ruby>`).join('')}</span>`);
    return `<p class="cn ruby-line" lang="zh-Hans">${words.join('')}</p>`;
  }

  // 一句会话 / 一个单词
  function lineHtml(line, i) {
    const student = config.studentSpeakers.some(name => (line.speaker || '').includes(name));
    const speaker = line.speaker
      ? `<span class="speaker ${student ? 'speaker-student' : 'speaker-partner'}">${escape(line.speaker)}</span>` : '';
    return `
      <article class="sentence" data-segment="${i}">
        <span class="sentence-num">${pad(i + 1)}</span>
        <div>${speaker}${alignedTextHtml(line)}${line.jp ? `<p class="jp">${escape(line.jp)}</p>` : ''}</div>
        <button type="button" class="icon-button line-play" data-action="play-line" data-index="${i}"
          aria-label="${escape(fill(T.playLine, { n: i + 1, title: line.ch }))}" ${line.audio ? '' : 'disabled'}>${icon('play')}</button>
        ${line.audio ? '' : `<small class="missing-audio">${escape(T.noAudio)}</small>`}
      </article>`;
  }

  // 本文页下方的电视剧介绍
  function cultureHtml() {
    if (!lesson.drama?.length) return '';
    return `
      <details class="culture-card">
        <summary>${escape(T.cultureTitle)}</summary>
        ${lesson.drama.map(p => `<p>${escape(p)}</p>`).join('')}
        <small>${escape(T.cultureNote)}</small>
      </details>`;
  }

  // 右栏：全文播放 + 学习提示
  function railHtml() {
    const t = T[view];
    return `
      <aside class="rail" aria-label="学習のサポート">
        <section class="panel audio-card">
          <div class="eyebrow">LISTEN &amp; READ</div>
          <h3>${escape(T.listenTitle)}</h3>
          <p>${escape(T.listenBody)}</p>
          <button type="button" class="primary wide" data-action="play-all">${icon('play')}${escape(t.playAll)}</button>
        </section>
        <section class="panel guide-card">
          <h3>${icon('bulb')}${escape(T.hintTitle)}</h3>
          <ol class="guide-list">${T.hints.map((h, i) => `<li><span class="step-badge">${i + 1}</span>${escape(h)}</li>`).join('')}</ol>
          <p class="tip"><b>${escape(t.tipTitle)}</b><br>${escape(t.tipBody)}</p>
        </section>
      </aside>`;
  }

  // 本文页 / 单词页 的主体
  function studyHtml() {
    const t = T[view];
    const isWords = view === 'words';
    const nextView = isWords ? 'reading' : 'words';
    return `
      <div class="study-layout">
        <section class="panel">
          <div class="panel-title">
            <div><h2>${escape(t.heading)}</h2><p>${escape(t.intro)}</p></div>
            <span class="count-label">${escape(fill(t.count, { n: lesson[view].length }))}</span>
          </div>
          ${toolbarHtml()}
          <div class="segments ${isWords ? 'word-grid' : ''}">${lesson[view].map(lineHtml).join('')}</div>
          ${isWords ? '' : cultureHtml()}
          <div class="next-step">
            <p>${escape(t.nextText)}</p>
            <a class="secondary" href="${url(lesson.id, nextView)}">${escape(t.nextLink)} ${icon('arrow')}</a>
          </div>
        </section>
        ${railHtml()}
      </div>`;
  }

  // 页面底部：上一课 / 下一课
  function bottomNavHtml() {
    const prev = lesson.id > 1
      ? `<a class="text-link" href="${url(lesson.id - 1)}">${escape(fill(T.prevLesson, { n: lesson.id - 1 }))}</a>`
      : `<span class="text-link">${escape(fill(T.allLessons, { total: course.length }))}</span>`;
    const next = lesson.id < course.length
      ? `<a class="text-link" href="${url(lesson.id + 1)}">${escape(fill(T.nextLesson, { n: lesson.id + 1 }))}</a>` : '';
    return `<div class="bottom-nav">${prev}${next}</div>`;
  }

  // 「使い方」对话框的内容
  function helpHtml() {
    return `
      <div class="dialog-head">
        <h2 id="help-title">${escape(T.helpTitle)}</h2>
        <button type="button" class="icon-button" data-action="help-close" aria-label="${escape(T.closeDialog)}">${icon('close')}</button>
      </div>
      <ol class="help-steps">${T.helpSteps.map(s => `<li><b>${escape(s.title)}</b><p>${escape(s.body)}</p></li>`).join('')}</ol>
      <p class="local-note">${escape(T.helpNote)}</p>
      <button type="button" class="primary" data-action="help-close">${escape(T.helpClose)}</button>`;
  }

  // 底部播放条
  function playerHtml() {
    const item = player.queue[player.index];
    const mode = player.continuous ? T.playModeAll : T.playModeOne;
    const last = player.index >= player.queue.length - 1;
    return `
      <button type="button" class="icon-button play-main" data-action="player-toggle" aria-label="${escape(player.playing ? T.pause : T.play)}">${icon(player.playing ? 'pause' : 'play')}</button>
      <div class="player-label">
        <b lang="zh-Hans">${escape(item.ch)}</b>
        <small>${escape(mode)} · ${player.index + 1} / ${player.queue.length}</small>
        ${window.DRAMA_ALIGNMENT?.[item.id] ? '<span id="word-position" class="word-position"></span>' : ''}
      </div>
      <button type="button" class="speed-cycle" data-action="speed-cycle" aria-label="${escape(fill(T.changeSpeed, { speed: speedLabel(prefs.speed) }))}">${escape(speedLabel(prefs.speed))}</button>
      <button type="button" class="icon-button repeat" data-action="player-repeat" aria-label="${escape(T.repeat)}">${icon('repeat')}</button>
      <button type="button" class="icon-button" data-action="player-next" aria-label="${escape(T.next)}" ${last ? 'disabled' : ''}>${icon('arrow')}</button>
      <button type="button" class="icon-button" data-action="player-close" aria-label="${escape(T.close)}">${icon('close')}</button>`;
  }


  /* ============================================================
   * 5. 画面渲染
   * ============================================================ */

  function applyColors() {
    const map = {
      main: '--blue', mainDark: '--blue-dark', mainPale: '--pale', text: '--navy',
      muted: '--muted', line: '--line', page: '--bg', highlight: '--highlight'
    };
    for (const [key, cssVar] of Object.entries(map)) {
      if (config.colors?.[key]) document.documentElement.style.setProperty(cssVar, config.colors[key]);
    }
  }

  function applyPrefs() {
    document.body.classList.toggle('hide-py', !prefs.py);
    document.body.classList.toggle('hide-jp', !prefs.jp);
  }

  function render({ keepScroll = false } = {}) {
    stopAudio();
    const resolved = resolveHash(location.hash);
    if (resolved.redirectedFrom) history.replaceState(null, '', url(resolved.id));
    lesson = course.find(l => l.id === resolved.id) || course[0];
    view = resolved.view;

    document.title = `${fill(T.lessonName, { n: lesson.id })} ${lesson.title} · ${T.brandName}`;
    $('#sidebar').innerHTML = sidebarHtml();
    $('#crumb-lesson').textContent = fill(T.lessonName, { n: lesson.id });
    $('#main').innerHTML = headingHtml() + tabsHtml() + studyHtml() + bottomNavHtml();

    applyPrefs();
    setMenu(false);
    if (!keepScroll) window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // 手机・平板上的课程列表（侧栏）开关
  function setMenu(open) {
    $('#sidebar').classList.toggle('open', open);
    $('#veil').hidden = !open;
    document.body.classList.toggle('menu-open', open);
    const button = $('#menu');
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? T.closeMenu : T.openMenu);
    if (open) $('.lesson-link.active')?.focus();
  }

  // 屏幕下方的短提示
  let toastTimer;
  function notify(message) {
    const box = $('#status');
    if (!box) return;
    clearTimeout(toastTimer);
    box.textContent = message;
    toastTimer = setTimeout(() => { box.textContent = ''; }, 3000);
  }

  // 改变一项显示设置（ピンイン・日本語訳・スピード），并同步所有按钮
  function setPref(key, value) {
    if (key === 'speed') {
      if (!config.speeds.some(s => s.value === value)) return;
      if (audio) audio.playbackRate = value;
    } else if (key !== 'py' && key !== 'jp') {
      return;
    }
    prefs[key] = value;
    savePrefs();
    applyPrefs();
    $$(`[data-action="set-pref"][data-pref="${key}"]`).forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.value === String(value))));
    if (key === 'speed' && player.queue.length) updatePlayer();
  }


  /* ============================================================
   * 6. 音频播放
   *    同一时间只有一个音频；播放时逐字高亮，并显示底部播放条。
   * ============================================================ */

  let audio;
  const player = { queue: [], index: 0, continuous: false, playing: false, session: 0 };
  let followFrame = null;
  let currentWord = null;

  function clearWord() {
    if (currentWord) {
      currentWord.classList.remove('current-word');
      currentWord.removeAttribute('aria-current');
      currentWord = null;
    }
    const label = $('#word-position');
    if (label) label.textContent = '';
  }

  function cancelFollow() {
    if (followFrame !== null) {
      window.cancelAnimationFrame?.(followFrame);
      followFrame = null;
    }
  }

  // 根据播放时间找到正在读的词并高亮
  function syncWord() {
    const alignment = window.DRAMA_ALIGNMENT?.[player.queue[player.index]?.id];
    if (!alignment) { clearWord(); return; }
    const time = audio.currentTime;
    const wordIndex = alignment.words.findIndex(w => !w.punctuation && time >= w.start && time < w.end);
    const row = $(`.sentence[data-segment="${player.index}"]`);
    const target = wordIndex < 0 || !row ? null : $(`[data-word="${wordIndex}"]`, row);
    if (target !== currentWord) {
      clearWord();
      currentWord = target;
      if (target) {
        target.classList.add('current-word');
        target.setAttribute('aria-current', 'true');
        // 正在读的词离开屏幕时才滚动（顶栏、播放条的高度要留出来）
        const rect = target.getBoundingClientRect();
        const bar = $('#player').getBoundingClientRect().height || 0;
        if (rect.height > 0 && (rect.top < 85 || rect.bottom > window.innerHeight - bar - 40)) {
          target.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
      }
    }
    const label = $('#word-position');
    if (label) label.textContent = wordIndex >= 0 ? fill(T.nowSpeaking, { word: alignment.words[wordIndex].text }) : '';
  }

  function startFollow() {
    cancelFollow();
    syncWord();
    if (!window.requestAnimationFrame) return;
    const tick = () => {
      syncWord();
      followFrame = player.playing ? window.requestAnimationFrame(tick) : null;
    };
    followFrame = window.requestAnimationFrame(tick);
  }

  function stopAudio() {
    if (!audio) return;
    player.session++;
    cancelFollow();
    clearWord();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    player.queue = [];
    player.playing = false;
    $('#player').hidden = true;
    document.body.classList.remove('has-player');
    $$('.is-playing').forEach(el => el.classList.remove('is-playing'));
    $$('.line-play').forEach(b => { b.innerHTML = icon('play'); });
  }

  // items: 句子数组   start: 从第几句开始   all: 是否连续播放
  async function play(items, start, all) {
    player.session++;
    const session = player.session;
    cancelFollow();
    clearWord();
    audio.pause();
    player.queue = items;
    player.index = start;
    player.continuous = all;
    if (all) while (player.index < items.length && !items[player.index].audio) player.index++;
    const item = items[player.index];
    if (!item?.audio) { notify(T.msgNoAudio); stopAudio(); return; }
    audio.src = item.audio;
    audio.playbackRate = prefs.speed;
    player.playing = true;
    updatePlayer();
    startFollow();
    try {
      await audio.play();
    } catch {
      if (session !== player.session) return;
      player.playing = false;
      cancelFollow();
      clearWord();
      updatePlayer();
      notify(T.msgPlayFailed);
    }
  }

  async function togglePause() {
    if (player.playing) {
      audio.pause();
      player.playing = false;
      cancelFollow();
      updatePlayer();
      return;
    }
    const session = player.session;
    try {
      await audio.play();
      if (session !== player.session) return;
      player.playing = true;
      updatePlayer();
      startFollow();
    } catch {
      notify(T.msgPlayFailed);
    }
  }

  function updatePlayer() {
    if (!player.queue.length) return;
    const box = $('#player');
    box.hidden = false;
    document.body.classList.add('has-player');
    box.innerHTML = playerHtml();
    $$('.sentence').forEach((row, i) => {
      const active = i === player.index;
      row.classList.toggle('is-playing', active);
      const button = $('.line-play', row);
      if (button) button.innerHTML = icon(active && player.playing ? 'sound' : 'play');
    });
    syncWord();
  }

  function onAudioEnded() {
    cancelFollow();
    clearWord();
    const more = player.queue.slice(player.index + 1).some(x => x.audio);
    if (player.continuous && more) {
      play(player.queue, player.index + 1, true);
    } else {
      player.playing = false;
      updatePlayer();
    }
  }


  /* ============================================================
   * 7. 按钮事件与启动
   *    所有按钮都带 data-action="…"，在这里统一处理。
   * ============================================================ */

  let lastFocus = null;

  const actions = {
    'menu':           () => setMenu(!$('#sidebar').classList.contains('open')),
    'veil':           () => { setMenu(false); $('#menu').focus(); },
    'help':           () => { lastFocus = document.activeElement; $('#help-dialog').showModal(); },
    'help-close':     () => $('#help-dialog').close(),
    'set-pref':       button => {
      const raw = button.dataset.value;
      setPref(button.dataset.pref, raw === 'true' ? true : raw === 'false' ? false : Number(raw));
    },
    'speed-cycle':    () => {
      const i = config.speeds.findIndex(s => s.value === prefs.speed);
      const nextSpeed = config.speeds[(i + 1) % config.speeds.length].value;
      setPref('speed', nextSpeed);
      notify(fill(T.msgSpeed, { speed: speedLabel(nextSpeed) }));
    },
    'play-line':      button => play(lesson[view], Number(button.dataset.index), false),
    'play-all':       () => play(lesson[view], 0, true),
    'player-toggle':  () => togglePause(),
    'player-repeat':  () => play(player.queue, player.index, false),
    'player-next':    () => play(player.queue, player.index + 1, player.continuous),
    'player-close':   () => stopAudio()
  };

  function boot() {
    if (typeof document === 'undefined' || !document.querySelector?.('#main')) return;  // 测试环境里不启动

    loadPrefs();
    applyColors();
    $('#topbar').innerHTML = topbarHtml();
    $('#help-dialog').innerHTML = helpHtml();
    $('.skip').textContent = T.skipLink;
    $('#veil').setAttribute('aria-label', T.closeMenu);
    $('#veil').dataset.action = 'veil';
    $('#footer').innerHTML = `<span>${escape(T.brandName)} <span class="footer-dot">·</span> ${escape(T.siteTitle)}</span><span>${escape(T.footerNote)}</span>`;

    audio = new Audio();
    audio.preload = 'metadata';
    audio.addEventListener('timeupdate', () => { if (player.queue.length) syncWord(); });
    audio.addEventListener('seeked', () => { if (player.queue.length) syncWord(); });
    audio.addEventListener('ended', onAudioEnded);
    audio.addEventListener('error', () => {
      if (!player.queue.length) return;
      player.playing = false;
      cancelFollow();
      updatePlayer();
      clearWord();
      notify(T.msgLoadFailed);
    });

    // 点击：按 data-action 分发
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-action]');
      if (!button || button.disabled) return;
      const handler = actions[button.dataset.action];
      if (handler) { event.preventDefault(); handler(button); }
    });
    // 「本文へスキップ」
    $('.skip').addEventListener('click', event => {
      event.preventDefault();
      $('#main').focus({ preventScroll: true });
      $('#main').scrollIntoView({ block: 'start' });
    });
    $('#help-dialog').addEventListener('close', () => lastFocus?.focus());
    // 点对话框外的灰色区域也能关闭
    $('#help-dialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && $('#sidebar').classList.contains('open')) { setMenu(false); $('#menu').focus(); }
    });
    // 侧栏里点了课程后自动收起（同一课时不会触发 hashchange）
    $('#sidebar').addEventListener('click', event => { if (event.target.closest('.lesson-link')) setMenu(false); });
    window.addEventListener('pagehide', () => stopAudio());
    window.addEventListener('hashchange', () => { render(); $('#main').focus({ preventScroll: true }); });

    render();
  }

  // 给测试脚本用的接口
  window.DRAMA = { tabs: VIEWS.map(v => T.tabs[v]), resolveHash, playablePaths, speeds: config.speeds.map(s => s.value) };
  boot();
})();
