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
