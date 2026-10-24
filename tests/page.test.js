// The page: its script parses, it loads nothing from the web but office.js, and what it copies from ESK Tracker still matches.
//   node tests/page.test.js
//   BM_SHARED=".../esk-tracker/src/taskpane.html" node tests/page.test.js   (also compares the copied CSS and chunking code)
const assert = require('assert'), fs = require('fs'), path = require('path');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8').replace(/\r\n/g, '\n');
const script = (html.match(/<script>\n([\s\S]*?)<\/script>/) || [])[1] || '';
const style = id => (html.match(new RegExp(`<style id="${id}">\\n([\\s\\S]*?)</style>`)) || [])[1] || '';

t('the page script parses', () => { assert(script.length > 1000); new Function(script); });
t('only office.js comes from the web, and only when ESK opens the page as an Office dialog', () => {
  const urls = [...html.matchAll(/https?:\/\/[^\s"'`)]+/g)].map(m => m[0]);
  assert.deepStrictEqual([...new Set(urls)], ['https://appsforoffice.microsoft.com/lib/1/hosted/office.js']);
  assert(!/<script[^>]+src="https?:/.test(html), 'no script tag loads from the web');
  assert(/same = window\.parent !== window && window\.parent\.location\.origin === location\.origin/.test(script), 'framed by the tracker: no office.js');
});
t('scripts load in order: render.js, core.js, then the page', () => {
  const i = html.indexOf('src="render.js"'), j = html.indexOf('src="core.js"'), k = html.indexOf('<script>\n');
  assert(i > 0 && j > i && k > j);
});
t('no patient fields anywhere in the page', () => {
  assert(!/\b(mrn|dob|birth|ssn|patient(Name|Id))\b/i.test(script.replace(/Patient [A-Z]\b/g, '')));
});
t('the files the page names exist', () => {
  for (const f of ['render.js', 'core.js', 'assets/fonts/ibm-plex-sans-latin-400-normal.woff2', 'assets/fonts/ibm-plex-sans-latin-500-normal.woff2', 'assets/fonts/ibm-plex-sans-latin-600-normal.woff2'])
    assert(fs.existsSync(path.join(__dirname, '..', f)), f);
});
t('the tool rail shortcut letters pass AA contrast in light and dark', () => {
  const c = /\.tool kbd\{[^}]*color:var\(--([\w-]+)\)/.exec(html)[1], tok = style('tok'), at = i => tok.slice(i);
  const vars = s => Object.fromEntries([...s.matchAll(/--([\w-]+):(#[0-9A-Fa-f]{6})/g)].map(m => [m[1], m[2]]));
  const light = vars(at(tok.indexOf(':root{'))), dark = vars(at(tok.indexOf(':root[data-theme="dark"]{')));
  const lum = h => { const v = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [name, T] of [['light', light], ['dark', dark]]) for (const bg of ['bg', 'surface', 'surface2'])
    assert(ratio(T[c], T[bg]) >= 4.5, `${name} --${c} on --${bg}: ${ratio(T[c], T[bg]).toFixed(2)}`);
});
t('toasts lay out as one sentence (bold words stay inline)', () => {
  assert(/el\.className = `msg fresh \$\{kind\}`/.test(script)); assert(/\.msg\.fresh\{display:block\}/.test(html));
});
t('a floor-plan picture is shrunk before it is kept; one still too big lasts for this session only', () => {
  const fn = name => new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(script)[0];
  const max = /const TRACE_MAX = ([\d.e]+);/.exec(script)[1], made = [], kept = {}, toasts = [];
  const ctx = { S: { trace: null, traceVer: 0 }, paint(){}, toast: (k, h) => toasts.push(h), LS: { trace: 'bmTrace' },
    store: { set: (k, v) => { kept[k] = JSON.stringify(v); return true; }, del: k => { delete kept[k]; } },
    document: { createElement: () => { const c = { getContext: () => ({ fillRect(){}, drawImage(){} }), toDataURL: (t, q) => `data:${t};` + 'A'.repeat(q > 0.7 ? 1.4e6 : 6e5) }; made.push(c); return c; } } };
  require('vm').runInNewContext(`const TRACE_MAX = ${max};${fn('saveTrace')}${fn('shrinkImage')}
    this.run = () => { const src = shrinkImage({ naturalWidth: 4032, naturalHeight: 3024, src: 'data:image/jpeg;base64,x' });
      S.trace = { src, x: 0, y: 0, w: 1000, h: 750, iw: 4032, ih: 3024, op: 0.5 }; saveTrace(); return src.length; };
    this.big = () => { S.trace.src = 'data:image/jpeg;base64,' + 'B'.repeat(2e6); saveTrace(); saveTrace(); };`, ctx);
  const len = ctx.run();
  assert.deepStrictEqual([made[0].width, made[0].height], [2000, 1500], 'long side 2000 px');
  assert(len <= +max && kept.bmTrace && kept.bmTrace.length < 1.1e6, 'small copy kept');
  ctx.big(); assert(!kept.bmTrace, 'too big: not kept'); assert.strictEqual(toasts.length, 1, 'said once');
});
t('curtains are made with the model, so one drawn toward a wall bunches there', () => assert(/BM\.newLine\(D\.k, pts, closed, S\.m\)/.test(script)));

const esk = process.env.BM_SHARED && fs.readFileSync(process.env.BM_SHARED, 'utf8').replace(/\r\n/g, '\n');
if (esk){
  const lines = new Set(esk.split('\n'));
  t('the tokens, fonts and bay map CSS are line-for-line copies of the tracker', () => {
    for (const id of ['tok', 'base', 'ctl', 'eskMap']) for (const l of style(id).split('\n')) if (l.trim()) assert(lines.has(l), `#${id} line not in the tracker: ${l.slice(0, 90)}`);
    for (const k of ['.bplan .wall{', '.bplan .btag{', '.bkey .bsw[data-k="busy"]{', ':root[data-theme="dark"]{', '.bplan .window .wf{']) assert(style('tok').includes(k) || style('eskMap').includes(k), k);
  });
  t('sendChunks, makeRx and CH match the tracker', () => {
    for (const k of ['const CH = 12000;', 'function sendChunks(', 'function makeRx(']){ const a = script.split('\n').find(l => l.startsWith(k)), b = esk.split('\n').find(l => l.startsWith(k)); assert(a && b && a === b, k); }
  });
}
console.log(`\n${n} passed`);
