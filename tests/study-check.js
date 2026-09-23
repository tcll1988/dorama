// Loads the scripts index.html loads and checks the shipped course.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPage(root) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  if (/<script\b[^>]*type\s*=\s*["']module["']/i.test(html)) {
    throw new Error('index.html uses an ES module script');
  }
  const sources = [...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi)].map(match => match[1].split('?')[0]);
  if (sources.some(src => src.includes('grammar-audio.js'))) {
    throw new Error('index.html still loads a separate grammar audio table');
  }
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const src of sources) {
    const code = fs.readFileSync(path.join(root, src), 'utf8');
    if (/\brequire\s*\(/.test(code) || /\bmodule\.exports\b/.test(code)) {
      throw new Error(src + ' uses Node module or require');
    }
    vm.runInContext(code, sandbox, { filename: src });
  }
  if (!sandbox.DRAMA_COURSE || !sandbox.DRAMA || typeof sandbox.DRAMA.resolveHash !== 'function') {
    throw new Error('scripts did not install the course');
  }
  return { sandbox, sources };
}

function fileOk(root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(rel) || path.isAbsolute(rel)) {
    return false;
  }
  const file = path.join(root, rel);
  return fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0;
}

function check(root) {
  const failures = [];
  const note = message => failures.push(message);
  let loaded;
  try {
    loaded = loadPage(root);
  } catch (error) {
    return ['load failed: ' + error.message];
  }
  const { sandbox, sources } = loaded;
  const course = sandbox.DRAMA_COURSE;
  const api = sandbox.DRAMA;
  if (!Array.isArray(course) || course.length !== 14) note('expected 14 lessons');
  if (course[0] && course[0].reading[0].ch !== '你好！') note('lesson 1 first line is ' + (course[0] && course[0].reading[0].ch));
  if (JSON.stringify(api.tabs) !== JSON.stringify(['本文', '単語'])) note('tabs ' + JSON.stringify(api.tabs));
  // Removed pages redirect to the same lesson's 本文.
  for (const [hash, id] of [['#lesson/8/homework', 8], ['#lesson/3/homework/2', 3], ['#lesson/1/grammar', 1], ['#lesson/5/practice', 5], ['#lesson/6/practice/2', 6], ['#lesson/9/practice/3/4', 9], ['#lesson/2/pronunciation', 2]]) {
    const hit = api.resolveHash(hash);
    if (!hit || hit.id !== id || hit.view !== 'reading' || !hit.redirectedFrom) note('redirect ' + hash + ' ' + JSON.stringify(hit));
  }
  const words = api.resolveHash('#lesson/4/words');
  if (!words || words.id !== 4 || words.view !== 'words') note('words route ' + JSON.stringify(words));
  const app0 = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  for (const gone of ["'grammar'", "'practice'", '文法を確認する', '練習する', 'この課の練習', 'start_drama_practice']) {
    if (app0.includes(gone)) note('app.js still contains ' + gone);
  }
  const html0 = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  if (html0.includes('grammar.css') || html0.includes('練習')) note('index.html still mentions grammar/practice');

  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'v4-inventory.json'), 'utf8'));
  let readings = 0, wordCount = 0, grammar = 0, exercises = 0;
  course.forEach((lesson, index) => {
    const want = inventory.lessons[index];
    readings += lesson.reading.length;
    wordCount += lesson.words.length;
    grammar += lesson.grammar.length;
    exercises += lesson.exercises.length;
    if (!want || want.id !== lesson.id) note('lesson order ' + lesson.id);
    if (want && JSON.stringify(lesson.reading.map(line => line.ch)) !== JSON.stringify(want.reading)) note('dialogue changed in lesson ' + lesson.id);
    if (want && JSON.stringify(lesson.words.map(word => word.ch)) !== JSON.stringify(want.words)) note('headwords changed in lesson ' + lesson.id);
    if (want && JSON.stringify(lesson.exercises.map(q => q.prompts || [])) !== JSON.stringify(want.prompts)) note('prompts changed in lesson ' + lesson.id);
    if (want && JSON.stringify(lesson.exercises.map(q => q.answer)) !== JSON.stringify(want.answers)) note('answers changed in lesson ' + lesson.id);
    lesson.grammar.forEach((section, sectionIndex) => {
      const expected = want && want.grammar[sectionIndex];
      if (expected && section.html.replace(/ data-audio="[^"]*"/g, '') !== expected.html) note('grammar text changed in lesson ' + lesson.id + ' section ' + sectionIndex);
      if (expected && section.title !== expected.title) note('grammar title changed in lesson ' + lesson.id);
    });
  });
  if (readings !== 64) note('readings ' + readings);
  if (wordCount !== 114) note('words ' + wordCount);
  if (grammar !== 25) note('grammar sections ' + grammar);
  if (exercises !== 464) note('exercises ' + exercises);

  const paths = api.playablePaths(course);
  if (!paths.length) note('no playable audio');
  const bad = [...new Set(paths.filter(rel => !fileOk(root, rel)))];
  if (bad.length) note('missing audio ' + bad.slice(0, 8).join(', '));
  if (course[0] && !fileOk(root, course[0].reading[0].audio)) note('lesson 1 first audio missing');

  const lesson14 = course.find(lesson => lesson.id === 14);
  const happyLine = lesson14 && lesson14.reading.find(line => line.ch.includes('天天开心'));
  const happyWord = lesson14 && lesson14.words.find(word => word.ch === '天天开心');
  // 2026-09-23 起本文・単語使用 textbook-audio 音频包，天天开心 也有录音了
  if (!happyLine || !happyLine.audio) note('天天开心 reading audio missing');
  if (!happyWord || !happyWord.audio) note('天天开心 word audio missing');
  // 每句本文・单词都要有逐字高亮时间，且不超出录音长度
  const alignment = sandbox.DRAMA_ALIGNMENT || {};
  for (const lesson of course) for (const kind of ['reading', 'words']) for (const item of lesson[kind]) {
    const entry = alignment[item.id];
    if (!entry) { note('no alignment ' + item.id); continue; }
    if (!item.audio) continue;
    const timed = entry.words.filter(w => !w.punctuation);
    const imported = item.audio.startsWith('audio/lesson');   // import-audio.py 换过的录音一定有时间
    if (!imported && timed.every(w => w.start === undefined)) continue;
    if (timed.some(w => !(w.start >= 0 && w.end > w.start && w.end <= entry.duration + 0.01))) note('bad alignment times ' + item.id);
  }
  const config = sandbox.DRAMA_CONFIG;
  if (!config || !config.text || config.text.noAudio !== '教材音声なし') note('missing no-audio label in config.js');
  // 语速档位：来自 config.js，默认值必须在档位里
  if (!config || !Array.isArray(config.speeds) || config.speeds.length < 2) note('config.speeds needs at least two options');
  else {
    if (!config.speeds.some(s => s.value === config.defaultSpeed)) note('defaultSpeed is not one of speeds');
    if (config.speeds.some(s => !(s.value > 0 && s.value <= 2) || !s.label)) note('bad speed option ' + JSON.stringify(config.speeds));
    if (JSON.stringify(api.speeds) !== JSON.stringify(config.speeds.map(s => s.value))) note('app speeds ' + JSON.stringify(api.speeds));
  }
  // config.js 里每个 {占位符} 都要保留，否则页面会显示原样文字
  const placeholders = { lessonCount: ['total'], lessonName: ['n'], prevLesson: ['n'], nextLesson: ['n'], playLine: ['n', 'title'], nowSpeaking: ['word'], msgSpeed: ['speed'] };
  for (const [key, names] of Object.entries(placeholders)) {
    for (const name of names) if (!String(config && config.text[key]).includes('{' + name + '}')) note('config.text.' + key + ' lost {' + name + '}');
  }
  for (const view of ['reading', 'words']) if (!config || !config.text[view] || !config.text[view].count.includes('{n}')) note('config.text.' + view + '.count lost {n}');
  if (!sources.includes('config.js') || sources.indexOf('config.js') > sources.indexOf('app.js')) note('config.js must load before app.js');
  if (!sources.includes('course-data.js') || !sources.includes('app.js')) note('page scripts ' + sources.join(','));
  return failures;
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const failures = check(root);
  if (failures.length) {
    failures.forEach(message => console.log('FAIL ' + message));
    console.log('FAIL ' + failures.length);
    process.exit(1);
  }
  console.log('PASS ' + root);
}

module.exports = { loadPage, check };

if (require.main === module) main();
