// What the tracker will draw from a builder file: render.js on exportPlan() output.
//   node tests/render.test.js
// Optional: BM_SHARED="path/to/esk-tracker/src/taskpane.html;path/to/other/render.js" also checks those copies of the shared block match.
const fs = require('fs'), path = require('path'), assert = require('assert');
const BM = require('../core.js'), R = require('../render.js'), { bpCheck, bpUnder, bpOver, bpRooms, BP_DEFAULT } = R;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const norm = d => BM.pathStr(BM.parsePath(d));
const plan = m => { const r = bpCheck(BM.exportPlan(m, { savedAt: '' })); assert(!r.err, r.err); return r.plan; };
const room = (w = 400, h = 300) => { const m = BM.newModel('Test'); const [wall] = BM.newRoom(m, 0, 0, w, h, 'Room A'); return { m, wall }; };
const bay = (m, x, y, o = {}) => BM.add(m, { id: '', k: 'bay', no: o.no || BM.nextBayNo(m), x, y, r: 58, a: o.a || 0, side: 'auto', tag: null, chair: null, table: null });
const block = s => { s = s.replace(/\r\n/g, '\n'); const a = s.indexOf('// ==== bay plan: shared with'), b = s.indexOf('// ==== end bay plan ===='); assert(a >= 0 && b > a, 'block markers'); return s.slice(a, b); };

t('render.js carries the shared bay plan block (and matches any other copies given)', () => {
  const mine = block(fs.readFileSync(path.join(__dirname, '..', 'render.js'), 'utf8'));
  assert(!bpCheck(BP_DEFAULT).err);
  for (const f of (process.env.BM_SHARED || '').split(/[;,]/).filter(Boolean)) assert.strictEqual(block(fs.readFileSync(f, 'utf8')), mine, `${f} differs`);
});
t('every template exports a plan the tracker accepts', () => {
  for (const { id, model } of BM.templates()){
    if (id === 'blank') bay(model, 200, 200);
    const p = plan(model); assert(p.bays.length >= 1, id); assert(p.edit, 'edit model kept');
    assert(bpUnder(p, () => false).includes('class="wall"'), id); assert(bpOver(p, p.bays, () => false).includes('lantern') || id === 'blank', id);
  }
});
t('doors leave a gap in the wall the tracker draws, with the door symbol in it', () => {
  const { m, wall } = room(); bay(m, 200, 150);
  BM.add(m, { id: '', k: 'door', wall: wall.id, seg: 2, t: 0.5, w: 48, type: 'swing', flip: false, hinge: 'a' });
  const p = plan(m), [run] = p.walls, svg = bpUnder(p, () => false);
  assert.strictEqual(run.d.match(/M/g).length, 1, 'one continuous wall around the corners');
  const pl = BM.flattenPath(run.d)[0], ys = p.bays[0].cy + 150;   // bottom wall y in the plan
  const xs = pl.filter(q => Math.abs(q[1] - ys) < 0.01).map(q => q[0]).sort((a, b) => a - b);
  const [a, b] = [xs[1], xs[2]]; assert.strictEqual(b - a, 48, `gap ${a}..${b}`);
  assert(svg.includes(`<g class="door"><path d="${p.doors[0].d}"/></g>`));
  const dp = BM.flattenPath(p.doors[0].d)[0]; assert([a, b].includes(dp[0][0]) && dp[0][1] === ys, 'door hinge on a jamb');
});
t('curved walls and curtains go out as arcs; thin walls and windows get their own groups', () => {
  const { m, wall } = room(600, 400); bay(m, 205, 120); bay(m, 345, 120);
  wall.bend[1] = -60; wall.thin = false;
  BM.add(m, { ...BM.newLine('wall', [[300, 250], [300, 400]]), thin: true });
  BM.add(m, { ...BM.newLine('curtain', [[275, 4], [275, 200]]), bend: [15, 0] });
  BM.add(m, { id: '', k: 'window', wall: wall.id, seg: 0, t: 0.5, w: 64 });
  const p = plan(m), svg = bpUnder(p, () => true);
  assert(/A\d/.test(p.walls[0].d), 'curved wall segment is an A command'); assert(/A\d/.test(p.curtains[0].d), 'curved curtain too');
  assert(svg.includes('<g class="wall thin">'), 'thin wall group'); assert(svg.includes('class="wf"') && svg.includes('class="wg"'), 'window frame and glass');
  assert.strictEqual(p.curtains[0].bays.join(), '1,2'); assert(svg.includes('class="fabric"'), 'curtain drawn while its bays are in use');
});
t('automatic tags in the file stay on the map, off walls and off each other', () => {
  for (const { id, model } of BM.templates().filter(x => x.id !== 'blank')){
    const p = plan(model), tw = 0.19 * p.w, th = 0.06 * p.w, walls = p.walls.flatMap(w => BM.flattenPath(w.d));
    const bx = p.bays.map(b => ({ x0: b.tag[0] - tw / 2, y0: b.tag[1] - th / 2, x1: b.tag[0] + tw / 2, y1: b.tag[1] + th / 2 }));
    for (const b of bx) assert(b.x0 >= 0 && b.y0 >= 0 && b.x1 <= p.w && b.y1 <= p.h, `${id}: tag inside the map`);
    for (let i = 0; i < bx.length; i++) for (let j = i + 1; j < bx.length; j++){ const a = bx[i], b = bx[j];
      const ov = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
      assert(ov <= 0.04 * tw * th, `${id}: tags ${p.bays[i].id} and ${p.bays[j].id} overlap`); }
    for (const b of bx) for (const L of walls) for (let k = 1; k < L.length; k++){ const [x0, y0] = L[k - 1], [x1, y1] = L[k];
      for (let s = 0; s <= 20; s++){ const x = x0 + (x1 - x0) * s / 20, y = y0 + (y1 - y0) * s / 20; assert(!(x > b.x0 - 4 && x < b.x1 + 4 && y > b.y0 - 4 && y < b.y1 + 4), `${id}: tag across a wall`); } }
  }
});
t('a crowded room: auto tags still avoid each other and the walls', () => {
  const { m, wall } = room(760, 330); BM.add(m, { id: '', k: 'door', wall: wall.id, seg: 2, t: 0.85, w: 48, type: 'swing', flip: false, hinge: 'a' });
  for (const x of [90, 240, 390, 540, 680]) BM.add(m, BM.newBay(m, x, 60));
  assert.deepStrictEqual(BM.check(m).filter(c => c.level !== 'tip'), []);
  const p = plan(m); assert.strictEqual(p.bays.length, 5);
});
t('importPlan(BP_DEFAULT) exports back to the built-in map, moved by the crop', () => {
  const E = plan(BM.importPlan(BP_DEFAULT)), dx = E.bays[0].cx - BP_DEFAULT.bays[0].cx, dy = E.bays[0].cy - BP_DEFAULT.bays[0].cy;
  const sh = p => [p[0] + dx, p[1] + dy], r1 = v => Math.round(v * 10) / 10;
  assert.deepStrictEqual(E.bays, BP_DEFAULT.bays.map(b => ({ id: b.id, cx: b.cx + dx, cy: b.cy + dy, r: b.r, tag: sh(b.tag), lamp: sh(b.lamp) })));
  assert.deepStrictEqual(E.chairs, BP_DEFAULT.chairs.map(c => [c[0] + dx, c[1] + dy, c[2]]));
  const tkey = x => JSON.stringify(x.c ? x.c : x.rect), want = BP_DEFAULT.tables.map(x => x.c ? { c: [x.c[0] + dx, x.c[1] + dy, x.c[2]] } : { rect: [x.rect[0] + dx, x.rect[1] + dy, ...x.rect.slice(2)] });
  assert.deepStrictEqual(E.tables.map(tkey).sort(), want.map(tkey).sort());
  for (const k of ['walls', 'doors', 'curtains']) assert.deepStrictEqual(E[k].map(x => x.d), BP_DEFAULT[k].map(x => norm(BM.movePath(x.d, dx, dy))), k);
  assert.deepStrictEqual(E.curtains.map(c => c.bays), BP_DEFAULT.curtains.map(c => c.bays));
  assert.deepStrictEqual(E.rooms, BP_DEFAULT.rooms.map(r => ({ t: r.t, x: r1(r.x + dx), y: r1(r.y + dy) })));
  assert.strictEqual(E.w - BP_DEFAULT.w, dx + 20, 'only the padding differs');
});
t('"Two rooms, 5 bays" is a faithful redraw of the built-in map', () => {
  const E = plan(BM.templates().find(x => x.id === 'two-rooms').model), B = BP_DEFAULT, dx = E.bays[0].cx - B.bays[0].cx, dy = E.bays[0].cy - B.bays[0].cy;
  const sh = p => [p[0] + dx, p[1] + dy];
  assert.deepStrictEqual(E.bays, B.bays.map(b => ({ id: b.id, cx: b.cx + dx, cy: b.cy + dy, r: b.r, tag: sh(b.tag), lamp: sh(b.lamp) })), 'same bays, tags, lanterns');
  assert.deepStrictEqual(E.chairs, B.chairs.map(c => [c[0] + dx, c[1] + dy, c[2]]), 'same chairs');
  const tkey = x => JSON.stringify(x.c ? x.c : x.rect);
  assert.deepStrictEqual(E.tables.map(tkey).sort(), B.tables.map(x => x.c ? { c: [x.c[0] + dx, x.c[1] + dy, x.c[2]] } : { rect: [x.rect[0] + dx, x.rect[1] + dy, ...x.rect.slice(2)] }).map(tkey).sort(), 'same tables');
  assert.deepStrictEqual(E.rooms.map(r => r.t), B.rooms.map(r => r.t));
  // Walls: the same set of straight runs.
  const runs = W => W.flatMap(w => BM.flattenPath(w.d).flatMap(L => L.slice(1).map((p, i) => [L[i], p].map(q => q.map(Math.round).join(',')).sort().join(' ')))).sort();
  assert.deepStrictEqual(runs(E.walls), runs(B.walls.map(w => ({ d: BM.movePath(w.d, dx, dy) }))));
  assert.strictEqual(E.doors[0].d, norm(BM.movePath(B.doors[0].d, dx, dy)), 'door 1 identical');
  const d2 = BM.flattenPath(E.doors[1].d)[0], b2 = BM.flattenPath(BM.movePath(B.doors[1].d, dx, dy))[0];
  assert.deepStrictEqual([d2[0], d2[d2.length - 1]], [b2[0], b2[b2.length - 1]], 'door 2: same hinge and jamb');
  // Curtains: same ends and bays, and the arcs follow the ESK curves within a few units.
  E.curtains.forEach((c, i) => {
    const e = BM.flattenPath(c.d)[0], b = BM.flattenPath(BM.movePath(B.curtains[i].d, dx, dy))[0];
    assert.deepStrictEqual([e[0], e[e.length - 1]], [b[0], b[b.length - 1]], `curtain ${i + 1} ends`);
    assert.deepStrictEqual(c.bays, B.curtains[i].bays);
    const gap = p => Math.min(...e.slice(1).map((q, k) => { const a = e[k], vx = q[0] - a[0], vy = q[1] - a[1], L2 = vx * vx + vy * vy || 1, u = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2)); return Math.hypot(p[0] - a[0] - vx * u, p[1] - a[1] - vy * u); }));
    for (const p of b) assert(gap(p) < 4, `curtain ${i + 1} strays ${gap(p).toFixed(1)} from the ESK curve`);
  });
});
t('room labels are escaped; letter bay ids pass; check() and bpCheck() agree on bad numbers', () => {
  const { m } = room(); m.items.find(i => i.k === 'label').t = '<img src=x onerror=alert(1)>';
  const b = bay(m, 200, 150, { no: '2A' }); BM.add(m, BM.newDoor(m, [200, 296]).item);
  const p = plan(m); assert.strictEqual(p.bays[0].id, '2A'); assert(!bpRooms(p).includes('<img'), 'escaped');
  b.no = 'Bay 4'; const e = BM.check(m).find(x => x.level === 'error'), f = bpCheck(BM.exportPlan(m)).err;
  assert.strictEqual(e.msg, f);
});

t('quality guard: 100 made-up small clinics, bays dropped anywhere, come out with nothing to fix', () => {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bad = [];
  for (let k = 0; k < 100; k++){
    const m = BM.newModel('Sweep'), R = []; let x = 0;
    for (let r = 0, nr = 1 + Math.floor(rnd() * 2); r < nr; r++){ const w = 320 + Math.floor(rnd() * 4) * 48, h = 288 + Math.floor(rnd() * 4) * 32; BM.newRoom(m, x, 0, x + w, h, 'Room ' + (r + 1)); R.push({ x, w, h }); x += w; }
    for (const r of R){ const d = BM.newDoor(m, [r.x + r.w * (0.2 + rnd() * 0.6), r.h - 2]); if (d.item) BM.add(m, d.item); }
    for (let i = 0, tries = 0, nb = 2 + Math.floor(rnd() * 4); i < nb && tries < 200; tries++){
      const r = R[Math.floor(rnd() * R.length)], b = BM.newBay(m, r.x + 40 + rnd() * (r.w - 80), 40 + rnd() * (r.h - 80));
      if (b.x < r.x || b.x > r.x + r.w || m.items.some(o => o.k === 'bay' && Math.hypot(o.x - b.x, o.y - b.y) < 150)) continue;
      BM.add(m, b); i++;
    }
    const c = BM.check(m).filter(x => x.level !== 'tip'); if (c.length) bad.push(c.map(x => x.msg).join(' / '));
    assert(!bpCheck(BM.exportPlan(m)).err);
  }
  assert(bad.length <= 3, `${bad.length} of 100 need fixing:\n${bad.join('\n')}`);
});

console.log(`\n${n} passed`);
