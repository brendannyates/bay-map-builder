// Bay Map Builder core: geometry, doors, automatic placement, snapping, editing, checks, import/export.
//   node tests/core.test.js
// Plain Node + assert, no packages. Made-up rooms only; a bay map never holds patient data.
const assert = require('assert'), BM = require('../core.js'), { bpCheck, BP_DEFAULT } = require('../render.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const near = (a, b, e = 0.05, msg = '') => assert(Math.abs(a - b) <= e, `${msg} ${a} ≈ ${b}`);
const nearP = (p, q, e = 0.05, msg = '') => { near(p[0], q[0], e, msg + ' x'); near(p[1], q[1], e, msg + ' y'); };
const box = (c, w, h) => ({ x0: c[0] - w / 2, y0: c[1] - h / 2, x1: c[0] + w / 2, y1: c[1] + h / 2 });
const hitBox = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
// A room 0..w × 0..h drawn clockwise, so doors swing in by default.
const room = (w = 400, h = 300) => { const m = BM.newModel('Test'); const [wall] = BM.newRoom(m, 0, 0, w, h, 'Room A'); return { m, wall }; };
const bay = (m, x, y, o = {}) => BM.add(m, { id: '', k: 'bay', no: 'no' in o ? o.no : BM.nextBayNo(m), x, y, r: o.r || 58, a: o.a || 0, side: o.side || 'auto', tag: o.tag || null, chair: o.chair || null, table: o.table || null });
// Does any wall polyline pass through box b (b inflated by the wall's half thickness)?
const crossesWall = (m, b) => BM.wallLines(m).some(w => w.pts.some((p, i) => i > 0 && segInBox(w.pts[i - 1], p, { x0: b.x0 - w.th / 2, y0: b.y0 - w.th / 2, x1: b.x1 + w.th / 2, y1: b.y1 + w.th / 2 })));
function segInBox(p, q, b){ for (let k = 0; k <= 40; k++){ const x = p[0] + (q[0] - p[0]) * k / 40, y = p[1] + (q[1] - p[1]) * k / 40; if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) return true; } return false; }

// ---------- segments and arcs ----------
t('straight segments are L; curved ones are true arcs through both ends with the given sagitta', () => {
  assert.strictEqual(BM.segPath([0, 0], [100, 0], 0), 'L100 0');
  assert.strictEqual(BM.segPath([0, 0], [100, 0], 20), 'A72.5 72.5 0 0 0 100 0');   // r = (c²/4 + s²) / 2s
  for (const s of [20, -20, 50, 80, -80]){
    const d = 'M0 0' + BM.segPath([0, 0], [100, 0], s), pl = BM.flattenPath(d)[0];
    nearP(pl[pl.length - 1], [100, 0], 0.01, 'ends at b');
    const far = pl.reduce((a, p) => Math.abs(p[1]) > Math.abs(a[1]) ? p : a);
    near(far[1], s, 0.5, `bulge for s=${s}`); near(far[0], 50, 6, 'bulge at the middle');
  }
  assert(/A\S+ \S+ 0 1 0/.test(BM.segPath([0, 0], [100, 0], 80)), 'more than a half circle uses the large-arc flag');
  const A = BM.arcOf([0, 0], [0, 100], 30); nearP(A.at(0.5), BM.segMid([0, 0], [0, 100], 30), 1e-6, 'arcOf and segMid agree');
  near(BM.bendAt([10, 10], [110, 60], BM.segMid([10, 10], [110, 60], 17)), 17, 0.05, 'bendAt inverts segMid');
  assert.strictEqual(BM.bendAt([0, 0], [100, 0], [50, 2]), 0, 'tiny bends snap straight');
});
t('lineD draws whole lines; closed straight shapes end with Z', () => {
  assert.strictEqual(BM.lineD([[0, 0], [100, 0], [100, 80], [0, 80]], [0, 0, 0, 0], true), 'M0 0L100 0L100 80L0 80Z');
  assert(/^M0 0L100 0A/.test(BM.lineD([[0, 0], [100, 0], [100, 80]], [0, 10], false)));
});
t('parsePath reads relative, H/V, S and arc commands; movePath shifts every point', () => {
  const c = BM.parsePath('m10 10h20v5l-5 5c1 1 2 2 3 3s4 4 5 5a5 5 0 0 1 10 0z');
  assert.deepStrictEqual(c.map(x => x.c).join(''), 'MLLLCCAZ');
  assert.deepStrictEqual(c[1].p, [30, 10]); assert.deepStrictEqual(c[2].p, [30, 15]); assert.deepStrictEqual(c[3].p, [25, 20]);
  assert.deepStrictEqual(c[5].p1, [29, 24], 'S reflects the last control point');
  assert.strictEqual(BM.movePath('M22 50H800V372', 6, 9), 'M28 59L806 59L806 381');
  assert.strictEqual(BM.movePath(BP_DEFAULT.doors[0].d, 0, 0), 'M376 372L376 324A48 48 0 0 0 328 372');
});

// ---------- walls, doors, windows ----------
t('a closed room with no openings is one closed path', () => {
  const { m, wall } = room(); assert.strictEqual(BM.wallD(m, wall), 'M0 0L400 0L400 300L0 300Z');
});
t('doors and windows cut a gap exactly their width, where they sit', () => {
  const { m, wall } = room();
  BM.add(m, { id: '', k: 'door', wall: wall.id, seg: 0, t: 0.5, w: 48, type: 'swing', flip: false, hinge: 'a' });
  BM.add(m, { id: '', k: 'window', wall: wall.id, seg: 1, t: 0.5, w: 64 });
  const d = BM.wallD(m, wall), pl = BM.flattenPath(d);
  assert.strictEqual(pl.length, 2, 'two runs of wall, one path');
  assert(d.startsWith('M224 0'), 'starts just after the door so corners stay joined: ' + d);
  const onWall = (x, y) => pl.some(L => L.some((p, i) => i > 0 && Math.abs(Math.hypot(x - p[0], y - p[1]) + Math.hypot(x - L[i - 1][0], y - L[i - 1][1]) - Math.hypot(p[0] - L[i - 1][0], p[1] - L[i - 1][1])) < 1e-6));
  for (let x = 177; x <= 223; x += 2) assert(!onWall(x, 0), `no wall in the door gap at ${x}`);
  for (let y = 119; y <= 181; y += 2) assert(!onWall(400, y), `no wall in the window gap at ${y}`);
  assert(onWall(170, 0) && onWall(230, 0) && onWall(400, 110) && onWall(400, 190), 'wall right up to both gaps');
  assert.strictEqual(BM.windowD(m, m.items.find(i => i.k === 'window')), 'M400 118L400 182');
});
t('doors use the ESK symbol: hinge, leaf, quarter swing arc to the far jamb', () => {
  const m = BM.templates().find(x => x.id === 'two-rooms').model, [d1, d2] = m.items.filter(i => i.k === 'door');
  assert.strictEqual(BM.doorD(m, d1), 'M376 372L376 324A48 48 0 0 0 328 372', 'same as the built-in map');
  assert.strictEqual(BM.doorD(m, d2), 'M440 372L440 322A50 50 0 0 1 490 372');
  assert.strictEqual(BM.doorD(m, { ...d1, flip: true }), 'M376 372L376 420A48 48 0 0 1 328 372', 'flip swings to the other side');
  assert.strictEqual(BM.doorD(m, { ...d1, hinge: 'b' }), 'M328 372L328 324A48 48 0 0 1 376 372', 'hinge at the other end');
  assert.strictEqual((BM.doorD(m, { ...d1, type: 'double' }).match(/A24 24/g) || []).length, 2, 'double = two half leaves');
  assert(/^M376 369L328 369L328 363L376 363Z$/.test(BM.doorD(m, { ...d1, type: 'slide' })), 'slide = a panel beside the gap');
  assert.strictEqual(BM.doorD(m, { ...d1, type: 'open' }), '', 'open = just the gap');
});
t('newDoor snaps to the wall under the pointer, swings toward the pointer side, hinges by the nearer wall', () => {
  const m = BM.templates().find(x => x.id === 'two-rooms').model;
  const r = BM.newDoor(m, [300, 365]); assert(r.item, r.err); assert.strictEqual(r.item.flip, false);
  const tip = BM.flattenPath(BM.doorD(m, r.item))[0][1]; assert(tip[1] < 372, 'leaf swings into the room');
  assert.strictEqual(BM.newDoor(m, [300, 380]).item.flip, true, 'from outside it swings out');
  const near418 = BM.newDoor(m, [400, 360]).item; assert(near418, 'fits'); assert.strictEqual(near418.hinge, 'a', 'hinge on the end by the room divider');
  assert(/wall/.test(BM.newDoor(m, [300, 200]).err), 'no wall here');
});
t('doorFit slides a door clear of corners and other doors, and refuses short or curved walls', () => {
  const { m, wall } = room();
  BM.add(m, { id: '', k: 'door', wall: wall.id, seg: 0, t: 0.5, w: 48, type: 'swing', flip: false, hinge: 'a' });
  const f = BM.doorFit(m, wall.id, 0, 0.52, 48); assert(f.ok); assert(Math.abs(f.t * 400 - 200) >= 48, 'moved off the other door');
  near(BM.doorFit(m, wall.id, 0, 0, 48).t * 400, 30, 0.01, 'kept off the corner');
  assert(/short/.test(BM.doorFit(m, wall.id, 0, 0.5, 600).err));
  wall.bend[1] = 40; assert(/straight/.test(BM.doorFit(m, wall.id, 1, 0.5, 48).err));
});
t('a door on a curved segment is refused: no gap, a clear error, and nothing exported for it', () => {
  const { m, wall } = room(); bay(m, 200, 150);
  const door = BM.add(m, { id: '', k: 'door', wall: wall.id, seg: 0, t: 0.5, w: 48, type: 'swing', flip: false, hinge: 'a' });
  wall.bend[0] = -30;
  const d = BM.wallD(m, wall); assert.strictEqual((d.match(/M/g) || []).length, 1, 'wall not cut'); assert(/A/.test(d), 'curved segment drawn as an arc');
  assert.strictEqual(BM.doorD(m, door), '');
  const c = BM.check(m).find(x => x.ids.includes(door.id)); assert(c && c.level === 'error' && /straight walls/.test(c.msg), JSON.stringify(c));
  assert.strictEqual(BM.exportPlan(m).doors.length, 0);
});
t('a door wider than its wall is an error', () => {
  const { m, wall } = room(200, 300); bay(m, 100, 150);
  BM.add(m, { id: '', k: 'door', wall: wall.id, seg: 0, t: 0.5, w: 260, type: 'swing', flip: false, hinge: 'a' });
  assert(BM.check(m).some(x => x.level === 'error' && /wider than its wall/.test(x.msg)));
  assert.strictEqual(BM.canSave(m), false);
});

// ---------- bays ----------
t('autoBay: chair toward the back of the rug facing a, table beside it, lantern on the table', () => {
  const { m } = room(600, 400), b = bay(m, 300, 200, { a: 0 }), x = BM.autoBay(m, b);
  nearP(x.chair, [300, 200 - 0.55 * 58], 0.01, 'chair'); assert.strictEqual(x.chair[2], 0);
  assert.strictEqual(x.table.c[2], 23); assert.deepStrictEqual(x.lamp, x.table.c.slice(0, 2));
  near(Math.abs(x.table.c[0] - 300), 26 + 23 + 5, 0.01, 'beside the chair');
  const r = BM.autoBay(m, { ...b, a: 90 }); nearP(r.chair, [300 + 0.55 * 58, 200], 0.01, 'turned chair'); assert.strictEqual(r.chair[2], 90);
  b.side = 'none'; const z = BM.autoBay(m, b); assert.strictEqual(z.table, null); assert.strictEqual(z.lamp, null);
});
t('autoBay: the side table goes where there is more room; left/right are the seated patient’s', () => {
  const { m } = room(600, 400), b = bay(m, 520, 200, { a: 0 });   // right wall close by
  assert(BM.autoBay(m, b).table.c[0] < 520, 'table away from the wall');
  const c = bay(m, 80, 200, { a: 0 }); assert(BM.autoBay(m, c).table.c[0] > 80, 'mirror case');
  const d = bay(m, 300, 200, { a: 0, side: 'right' }); assert(BM.autoBay(m, d).table.c[0] < 300, 'facing down, the patient’s right is the screen’s left');
  d.side = 'left'; assert(BM.autoBay(m, d).table.c[0] > 300);
});
t('autoBay keeps pinned chair, table and tag exactly', () => {
  const { m } = room(600, 400), b = bay(m, 300, 200, { a: 20, chair: [-5, -30], table: [40, -40, 25], tag: [310, 290] }), x = BM.autoBay(m, b);
  assert.deepStrictEqual(x.chair, [295, 170, 20]); assert.deepStrictEqual(x.table, { c: [340, 160, 25] }); assert.deepStrictEqual(x.tag, [310, 290]);
  b.table = [10, 10, 0]; const y = BM.autoBay(m, b); assert.strictEqual(y.table, null); assert.deepStrictEqual(y.lamp, [310, 210], 'r 0 = lantern only');
});
t('newBay: next free number, nudged off the walls, back to the nearest wall (snapped to 15°)', () => {
  const { m } = room(600, 400);
  const b = BM.newBay(m, 30, 200); assert.strictEqual(b.no, '1'); assert(b.x >= 71, 'pushed off the left wall ' + b.x); assert.strictEqual(b.a, -90, 'back to the left wall');
  BM.add(m, b); bay(m, 300, 200, { no: '3' }); assert.strictEqual(BM.newBay(m, 300, 300).no, '2', 'fills the gap in the numbers');
  const c = BM.newBay(m, 590, 390); assert(c.x <= 600 - 71 && c.y <= 400 - 71, 'corner: off both walls'); assert([90, 180].includes(c.a));
  const ch = BM.autoBay(m, c).chair; assert(ch[0] + 30 < 596 && ch[1] + 30 < 396, 'chair back clear of the wall');
  const dm = BM.newModel(); BM.add(dm, BM.newLine('wall', [[0, 0], [400, 300]])); assert.strictEqual(Math.abs(BM.newBay(dm, 300, 100).a % 15), 0);
});
t('newBay keeps out of door swings; check() flags a bay put in one', () => {
  const { m } = room(600, 400), door = BM.add(m, BM.newDoor(m, [300, 396]).item), sw = BM.itemBox(m, door);
  const b = BM.newBay(m, 300, 340), cx = Math.max(sw.x0, Math.min(b.x, sw.x1)), cy = Math.max(sw.y0, Math.min(b.y, sw.y1));
  assert(Math.hypot(b.x - cx, b.y - cy) >= b.r, `rug clear of the swing (${b.x}, ${b.y})`);
  bay(m, 300, 330); const c = BM.check(m).find(x => /in the way of a door/.test(x.msg));
  assert(c && c.level === 'warn' && c.msg === 'Bay 1 is in the way of a door. Move the bay, or swing the door the other way (F).' && c.ids.includes(door.id), JSON.stringify(c));
});
t('tags: kept off walls, inside the map, and in front of the chair when there is room', () => {
  const { m } = room(600, 400), b = bay(m, 520, 200, { a: 90 });   // back to the right wall: patient faces left
  const L = BM.layout(m), tg = L.bays.get(b.id).tag, B = box(tg, ...L.tag);
  assert(!crossesWall(m, B), 'not across a wall'); assert(tg[0] < 520, 'in front (left) of the bay');
  const mb = L.box; assert(B.x0 >= mb.x && B.x1 <= mb.x + mb.w && B.y0 >= mb.y && B.y1 <= mb.y + mb.h, 'inside the map box');
});
t('tags: neighbours never share a spot, and pinned neighbours are respected', () => {
  const { m } = room(700, 360), A = bay(m, 120, 110), B2 = bay(m, 270, 110), C = bay(m, 420, 110), D = bay(m, 570, 110);
  const L = BM.layout(m), bx = [A, B2, C, D].map(b => box(L.bays.get(b.id).tag, ...L.tag));
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) assert(!hitBox(bx[i], bx[j]), `tags ${i + 1} and ${j + 1} overlap`);
  for (const b of bx) assert(!crossesWall(m, b));
  const pin = BM.layout(m).bays.get(A.id).tag;
  B2.tag = [pin[0] + 60, pin[1]]; A.tag = null;   // a pinned tag where bay 1's would go
  const L2 = BM.layout(m), a2 = box(L2.bays.get(A.id).tag, ...L2.tag), b2 = box(B2.tag, ...L2.tag);
  assert(!hitBox(a2, b2), 'bay 1 moved its tag away from the pinned one');
});
t('tags: avoid doors, lanterns and other rugs', () => {
  const { m, wall } = room(500, 400); bay(m, 250, 120, { a: 0 });
  BM.add(m, { id: '', k: 'door', wall: wall.id, seg: 2, t: 0.5, w: 48, type: 'swing', flip: false, hinge: 'a' });
  bay(m, 250, 300, { a: 180 });
  const L = BM.layout(m), [tw, th] = L.tag;
  for (const it of m.items.filter(i => i.k === 'bay')){
    const T = box(L.bays.get(it.id).tag, tw, th);
    for (const o of m.items.filter(i => i.k === 'bay' && i.id !== it.id)){
      const cx = Math.max(T.x0, Math.min(o.x, T.x1)), cy = Math.max(T.y0, Math.min(o.y, T.y1));
      assert(Math.hypot(cx - o.x, cy - o.y) > o.r * 0.7, `bay ${it.no}'s tag covers bay ${o.no}`);
      const lp = L.bays.get(o.id).lamp; assert(!(lp[0] > T.x0 - 6 && lp[0] < T.x1 + 6 && lp[1] > T.y0 - 6 && lp[1] < T.y1 + 6), 'tag over a lantern');
    }
    const door = BM.itemBox(m, m.items.find(i => i.k === 'door')); assert(!hitBox(T, door), 'tag over the door');
  }
});
t('tags: the ESK rooms with everything automatic come out clean', () => {
  const m = BM.templates().find(x => x.id === 'two-rooms').model;
  for (const b of m.items.filter(i => i.k === 'bay')) Object.assign(b, { tag: null, chair: null, table: null, side: 'auto' });
  assert.deepStrictEqual(BM.check(m), []);
  const L = BM.layout(m); for (const [, x] of L.bays) assert(!crossesWall(m, box(x.tag, ...L.tag)));
});
t('autoCurtainBays: rugs within 0.6 r of the track, either side', () => {
  const { m } = room(700, 360), A = bay(m, 120, 110), B2 = bay(m, 270, 110), C = bay(m, 500, 110);
  const c = BM.add(m, BM.newLine('curtain', [[195, 4], [195, 180]]));
  assert.deepStrictEqual(BM.autoCurtainBays(m, c), [A.id, B2.id]);
  assert.deepStrictEqual(BM.layout(m).curtains.get(c.id), [A.id, B2.id]);
  c.bays = [C.id]; assert.deepStrictEqual(BM.layout(m).curtains.get(c.id), [C.id], 'ticked bays win');
  BM.remove(m, [C.id]); assert.deepStrictEqual(c.bays, []);
});

// ---------- snapping ----------
t('snap: vertices first, then angle lock, wall lines, alignment, grid', () => {
  const { m } = room(400, 300);
  assert.deepStrictEqual(BM.snap(m, [396, 6]), { p: [400, 0], guides: [{ k: 'point', p: [400, 0] }] });
  const w = BM.snap(m, [150, 296], { grid: 8 }); assert.deepStrictEqual(w.p, [150, 300]); assert.strictEqual(w.guides[0].k, 'line');
  const e = BM.newModel(); BM.add(e, BM.newLine('wall', [[200, 100], [260, 100]]));
  const a = BM.snap(e, [100, 7], { from: [0, 0], walls: false, ends: false }); assert.deepStrictEqual(a.p, [100, 0]); assert.strictEqual(a.guides[0].deg, 0);
  const d = BM.snap(e, [100, 96], { from: [0, 0] }); assert.deepStrictEqual(d.p, [98, 98], 'locks to 45° (no wall nearby)'); assert.deepStrictEqual(BM.snap(e, [100, 30], { from: [0, 0], walls: false }).p, [100.8, 27], 'and to 15°');
  const al = BM.snap(e, [150, 104], { grid: 8 }); assert.deepStrictEqual(al.p, [152, 100], 'lines up with a vertex on y, grid on x'); assert(al.guides.some(g => g.k === 'align'));
  assert.deepStrictEqual(BM.snap(e, [13, 21], { grid: 8 }).p, [16, 24]);
  const x = BM.snap(m, [200, 297], { from: [200, 150] }); assert.deepStrictEqual(x.p, [200, 300], 'angle ray meets the wall');
  assert.deepStrictEqual(BM.snap(m, [396, 6], { ends: false, walls: false, align: false, grid: 0 }).p, [396, 6]);
});

// ---------- making and editing ----------
t('newRoom: clockwise walls, label above when there is space, inside when another room is above', () => {
  const m = BM.newModel(), [w, l] = BM.newRoom(m, 100, 100, 400, 300);
  assert.deepStrictEqual(w.pts, [[100, 100], [400, 100], [400, 300], [100, 300]]); assert.strictEqual(l.y, 76); assert.strictEqual(l.t, 'Room 1');
  const [, l2] = BM.newRoom(m, 100, 300, 400, 500, 'Office'); assert.strictEqual(l2.y, 324); assert.strictEqual(l2.t, 'Office');
  assert.strictEqual(BM.newRoom(m, 0, 0, 10, 10), null);
});
t('newRoom: rooms drawn side by side share one wall, so a door between them cuts the only wall there', () => {
  const m = BM.newModel(), [a] = BM.newRoom(m, 0, 0, 400, 300, 'A'), [b, , extra] = BM.newRoom(m, 400, 0, 720, 300, 'B');
  assert.deepStrictEqual(b.pts, [[400, 0], [720, 0], [720, 300], [400, 300]], 'a U: top, right, bottom; the shared side is left out');
  assert.strictEqual(b.closed, false); assert.strictEqual(extra, undefined);
  const d = BM.newDoor(m, [400, 150]); assert.strictEqual(d.item.wall, a.id); BM.add(m, d.item);
  assert.strictEqual(BM.wallD(m, a), 'M400 174L400 300L0 300L0 0L400 0L400 126', 'the door cuts the shared wall');
  const [c] = BM.newRoom(m, 720, 100, 960, 500, 'C');   // taller than B: only the part beside B is shared
  assert.deepStrictEqual(c.pts, [[720, 100], [960, 100], [960, 500], [720, 500], [720, 300]], 'drawn down to where B’s wall starts');
  assert.strictEqual(BM.newRoom(m, 0, 0, 400, 300), null, 'every side already drawn');
});
t('counters, sinks and cabinets dropped by a wall sit flat against it', () => {
  const { m } = room(400, 300), k = BM.newItem(m, 'counter', 200, 270);
  assert.deepStrictEqual([k.x, k.y, k.a], [200, 300 - 4 - 16 - 1, 0]);
  const s = BM.newItem(m, 'sink', 25, 150); assert.strictEqual(Math.abs(s.a), 90); assert.strictEqual(s.x, 4 + 16 + 1);
  const f = BM.newItem(m, 'cabinet', 200, 150); assert.deepStrictEqual([f.x, f.y], [200, 150], 'mid-room stays put');
});
t('moveItems carries pinned tags; rotateItems turns a bay in place and turns its pins', () => {
  const { m } = room(600, 400), b = bay(m, 300, 200, { tag: [300, 280], chair: [0, -30], table: [50, 0, 24] });
  BM.moveItems(m, [b.id], 10, -5); assert.deepStrictEqual([b.x, b.y, b.tag], [310, 195, [310, 275]]);
  BM.rotateItems(m, [b.id], 90); assert.deepStrictEqual([b.x, b.y, b.a], [310, 195, 90]);
  nearP(b.chair, [30, 0], 1e-9, 'chair pin'); nearP(b.table, [0, 50], 1e-9, 'table pin'); assert.deepStrictEqual(b.tag, [310, 275]);
  const w = m.items.find(i => i.k === 'wall'); BM.rotateItems(m, [w.id], 90, [0, 0]); nearP(w.pts[1], [0, 600], 1e-9, 'walls turn about the point');
});
t('remove: walls take their doors; bays leave curtain lists', () => {
  const { m, wall } = room(), b = bay(m, 200, 150), d = BM.add(m, BM.newDoor(m, [200, 296]).item);
  const c = BM.add(m, { ...BM.newLine('curtain', [[260, 4], [260, 150]]), bays: [b.id] });
  BM.remove(m, [wall.id]); assert(!BM.byId(m, d.id)); BM.remove(m, [b.id]); assert.deepStrictEqual(c.bays, []);
});
t('dup and paste: fresh ids and bay numbers, doors follow their wall, curtain links follow copied bays', () => {
  const { m, wall } = room(), b = bay(m, 200, 150); BM.add(m, BM.newDoor(m, [200, 296]).item);
  const c = BM.add(m, { ...BM.newLine('curtain', [[270, 4], [270, 150]]), bays: [b.id] });
  const ids = BM.dup(m, [wall.id, b.id, c.id], 500, 0), copies = ids.map(id => BM.byId(m, id));
  assert.strictEqual(copies.length, 4); assert.strictEqual(new Set(m.items.map(i => i.id)).size, m.items.length);
  const nb = copies.find(i => i.k === 'bay'), nw = copies.find(i => i.k === 'wall'), nd = copies.find(i => i.k === 'door'), nc = copies.find(i => i.k === 'curtain');
  assert.strictEqual(nb.no, '2'); assert.strictEqual(nd.wall, nw.id); assert.deepStrictEqual(nc.bays, [nb.id]); assert.strictEqual(nw.pts[0][0], 500);
  const lone = BM.paste(m, [m.items.find(i => i.k === 'door')]); assert.deepStrictEqual(lone, [], 'a door alone has no wall to go on');
});
t('insertVertex and removeVertex keep doors where they are; splitting an arc keeps the curve', () => {
  const { m, wall } = room(400, 300), d = BM.add(m, { id: '', k: 'door', wall: wall.id, seg: 0, t: 0.75, w: 48, type: 'swing', flip: false, hinge: 'a' });
  const at = () => BM.flattenPath(BM.doorD(m, d))[0][0];
  const before = at(); BM.insertVertex(m, wall.id, 0, [100, 0]);
  assert.strictEqual(wall.pts.length, 5); assert.strictEqual(d.seg, 1); nearP(at(), before, 1e-6, 'door stays put');
  BM.removeVertex(m, wall.id, 1); assert.strictEqual(wall.pts.length, 4); assert.strictEqual(d.seg, 0); nearP(at(), before, 1e-6, 'and after removing');
  const c = BM.add(m, { ...BM.newLine('curtain', [[0, 100], [200, 100]]), bend: [40, 0] }), A = BM.arcOf([0, 100], [200, 100], 40);
  BM.insertVertex(m, c.id, 0, [100, 150]); assert.strictEqual(c.pts.length, 3);
  nearP(c.pts[1], A.at(0.5), 0.1, 'new corner on the arc');
  for (const [i, u] of [[0, 0.25], [1, 0.75]]) nearP(BM.segMid(c.pts[i], c.pts[i + 1], c.bend[i]), A.at(u), 0.6, 'halves follow the old arc');
  BM.removeVertex(m, c.id, 0); BM.removeVertex(m, c.id, 0); assert(!BM.byId(m, c.id), 'a one-point curtain is deleted');
});
t('hit, itemBox and marquee', () => {
  const { m, wall } = room(), b = bay(m, 200, 150), d = BM.add(m, BM.newDoor(m, [100, 296]).item), lb = m.items.find(i => i.k === 'label');
  assert.strictEqual(BM.hit(m, [200, 150]), b.id); assert.strictEqual(BM.hit(m, [200, 2]), wall.id); assert.strictEqual(BM.hit(m, [100, 290]), d.id);
  assert.strictEqual(BM.hit(m, [lb.x, lb.y]), lb.id); assert.strictEqual(BM.hit(m, [330, 60]), null);
  const bx = BM.itemBox(m, b); assert(bx.x0 <= 142 && bx.x1 >= 258);
  assert.deepStrictEqual(BM.marquee(m, { x0: 100, y0: 60, x1: 300, y1: 260 }), [b.id]);
  assert.strictEqual(BM.itemName(m, b), 'Bay 1'); assert.strictEqual(BM.itemName(m, d), 'Door');
});
t('history: undo and redo snapshots, skipping repeats', () => {
  const h = BM.history(3), m = BM.newModel(); h.reset(m);
  for (let i = 0; i < 5; i++){ m.name = 'v' + i; assert(h.push(m)); } assert(!h.push(m), 'same state twice');
  assert.strictEqual(h.undo().name, 'v3'); assert.strictEqual(h.undo().name, 'v2'); assert.strictEqual(h.undo().name, 'v1'); assert.strictEqual(h.undo(), null, 'kept 3');
  assert.strictEqual(h.redo().name, 'v2'); assert(h.canRedo()); m.name = 'x'; h.push(m); assert(!h.canRedo());
});
t('feet and inches', () => {
  assert.strictEqual(BM.fmtFt(48), '3 ft'); assert.strictEqual(BM.fmtFt(56), '3 ft 6 in'); assert.strictEqual(BM.fmtFt(8), '6 in');
  for (const [s, u] of [['3', 48], ['3.5', 56], ['3 ft 6 in', 56], ['3\' 6"', 56], ['3ft6', 56], ['6 in', 8], ['3 feet', 48]]) assert.strictEqual(BM.parseFt(s), u, s);
  assert.strictEqual(BM.parseFt('three'), null); assert.strictEqual(BM.parseFt(''), null);
});

// ---------- import / export ----------
t('exportPlan crops to the drawing plus padding, starting at 0,0, rounded, with the edit model moved the same way', () => {
  const m = BM.newModel('Crop', 'TST'); BM.newRoom(m, 100, 100, 500, 400, 'Room'); bay(m, 300.04, 250.06);
  const p = BM.exportPlan(m, { savedAt: '2026-10-24T12:00:00.000Z', savedBy: 'PL' });
  const L = BM.layout(m), x0 = Math.floor(L.box.x), y0 = Math.floor(L.box.y);
  assert.strictEqual(x0, 100 - 4 - 24); assert(p.walls[0].d.startsWith(`M${100 - x0} ${100 - y0}`), p.walls[0].d);
  assert.deepStrictEqual([p.bays[0].cx, p.bays[0].cy], [Math.round((300.04 - x0) * 10) / 10, Math.round((250.06 - y0) * 10) / 10]);
  const eb = p.edit.items.find(i => i.k === 'bay'); near(eb.x, 300.04 - x0, 1e-9); assert.strictEqual(p.w, Math.ceil(L.box.x + L.box.w) - x0);
  assert.strictEqual(p.name, 'Crop'); assert.strictEqual(p.clinic, 'TST'); assert.strictEqual(p.savedBy, 'PL'); assert.strictEqual(p.savedAt, '2026-10-24T12:00:00.000Z');
  assert(!bpCheck(p).err, bpCheck(p).err); assert(!/\.\d\d/.test(JSON.stringify({ ...p, edit: 0, savedAt: 0 })), 'rounded to 0.1');
  const small = BM.newModel(); bay(small, 0, 0); const q = BM.exportPlan(small); assert(q.w >= 100 && q.h >= 60 && !bpCheck(q).err);
});
t('importPlan(exportPlan(m)) gives back the same model, and exporting again is stable', () => {
  for (const { id, model } of BM.templates()){
    if (id === 'blank') continue;
    const p = BM.exportPlan(model, { savedAt: '' }), back = BM.importPlan(p);
    assert.deepStrictEqual(back, BM.cleanModel(p.edit), id);
    assert.deepStrictEqual(BM.exportPlan(back, { savedAt: '' }), p, `${id} re-export`);
  }
});
t('importPlan turns a plan without an edit model into movable shapes and pinned bays', () => {
  const m = BM.importPlan(BP_DEFAULT), k = s => m.items.filter(i => i.k === s || i.layer === s);
  assert.strictEqual(k('bay').length, 5); assert.strictEqual(k('wall').length, 2); assert.strictEqual(k('door').length, 2); assert.strictEqual(k('curtain').length, 4);
  assert.strictEqual(m.items.filter(i => i.k === 'table').length, 4, 'four loose tables (one square)'); assert.strictEqual(k('label').length, 2);
  const b1 = k('bay')[0]; assert.deepStrictEqual([b1.no, b1.a, b1.chair, b1.table, b1.tag], ['1', -80, [-44, 2], [-46, -45, 24], [176, 300]]);
  assert.deepStrictEqual(k('curtain')[0].bays, [k('bay')[0].id, k('bay')[1].id]);
  assert.strictEqual(BM.importPlan({ schema: 'nope' }), null);
  const bad = { ...BP_DEFAULT, edit: { v: 1, items: [{ id: 'x', k: 'rocket' }] } }; assert.strictEqual(BM.importPlan(bad).items.length, m.items.length, 'bad edit model → use the drawing');
});
t('cleanModel drops junk fields and refuses bad numbers or repeated ids', () => {
  const ok = BM.cleanModel({ v: 1, name: 'A', items: [{ id: 'b1', k: 'bay', no: '1', x: 1, y: 2, r: 58, junk: '<script>' }] });
  assert.deepStrictEqual(Object.keys(ok.items[0]).sort(), ['a', 'chair', 'id', 'k', 'no', 'r', 'side', 'table', 'tag', 'x', 'y']);
  assert.strictEqual(BM.cleanModel({ v: 1, items: [{ id: 'b1', k: 'bay', x: NaN, y: 0, r: 58 }] }), null);
  assert.strictEqual(BM.cleanModel({ v: 1, items: [{ id: 'a', k: 'label', x: 0, y: 0 }, { id: 'a', k: 'label', x: 0, y: 0 }] }), null);
  assert.strictEqual(BM.cleanModel({ v: 1, items: [{ id: 'p', k: 'path', layer: 'wall', d: 'M0 0"/><script>' }] }), null);
});

// ---------- checklist ----------
t('check: plain-word problems with the items to select', () => {
  const msgs = m => BM.check(m).map(x => `${x.level}: ${x.msg}`);
  assert(msgs(BM.newModel()).some(s => /^error: Add at least one bay/.test(s)));
  const { m, wall } = room(800, 400);
  const a = bay(m, 100, 100, { no: '1' }), b = bay(m, 300, 100, { no: '1' }), c = bay(m, 500, 100, { no: '' }), d = bay(m, 700, 100, { no: 'Bay 4' });
  let M = msgs(m);
  assert(M.includes('error: Two bays are numbered 1. Give each bay its own number.'));
  assert(M.includes('error: A bay has no number. Select it and type its number on the right.'));
  assert(M.includes('error: Bay number “Bay 4” can’t be used. Use up to 8 letters or digits, like 4 or 2A.'));
  assert(M.includes('warn: There’s no door yet. Pick Door (D) and click on a wall.'));
  assert.deepStrictEqual(BM.check(m).find(x => /numbered 1/.test(x.msg)).ids, [a.id, b.id]);
  Object.assign(b, { no: '2' }); Object.assign(c, { no: '3', x: 340, y: 120 }); Object.assign(d, { no: '4A', r: 30 });
  BM.add(m, BM.newDoor(m, [400, 396]).item);
  BM.add(m, BM.newLine('curtain', [[600, 300], [700, 300]]));
  BM.add(m, { id: '', k: 'chair', x: 2000, y: 100, a: 0 });
  M = msgs(m);
  assert(M.includes('warn: Bay 2 and bay 3 overlap. Move them apart or pick a smaller rug.'), M.join('\n'));
  assert(M.includes('warn: Bay 4A’s rug is smaller than the recliner. Use size M or larger.'));
  assert(M.includes('warn: This curtain doesn’t screen any bay. Move it next to a bay, or tick its bays on the right.'));
  assert(M.includes('warn: Chair is far outside the walls. Drag it in or delete it.'));
  assert(!M.some(s => s.startsWith('error')), M.join('\n')); assert(BM.canSave(m));
  const lbl = m.items.find(i => i.k === 'label'); lbl.t = ''; assert(msgs(m).includes('tip: Name each room with Label (L) so staff know which room is which.'));
  wall.pts[0] = [150, 0]; assert(msgs(m).some(s => /sits on a wall/.test(s)), 'a wall through a rug');
});
t('check: labels that cover each other, rugs or walls are flagged (pinned labels can be put badly)', () => {
  const { m } = room(700, 360), a = bay(m, 120, 110), b = bay(m, 270, 110); BM.add(m, BM.newDoor(m, [600, 356]).item);
  a.tag = [270, 110]; let M = BM.check(m).map(x => x.msg);
  assert(M.some(s => s === 'Bay 1’s label covers bay 2. Drag the label, or choose Reset to automatic.'), M.join('\n'));
  b.tag = [275, 115]; M = BM.check(m).map(x => x.msg); assert(M.some(s => /labels for bay 1 and bay 2 overlap/.test(s)));
  a.tag = [0, 110]; b.tag = null; M = BM.check(m).map(x => x.msg); assert(M.some(s => s === 'Bay 1’s label sits across a wall. Drag it into the room, or choose Reset to automatic.'));
});
t('check: more bays than the tracker allows is an error', () => {
  const m = BM.newModel(); for (let i = 0; i < 41; i++) bay(m, (i % 10) * 140, Math.floor(i / 10) * 140);
  assert(BM.check(m).some(x => x.level === 'error' && x.msg === 'The map has more than 40 bays. Remove some.'));
});
t('templates: fresh copies, and every non-blank one is ready to save with nothing to fix', () => {
  const a = BM.templates(), b = BM.templates(); assert.deepStrictEqual(a.map(x => x.id), ['blank', 'one-room', 'two-rooms', 'esk']);
  a[1].model.items.pop(); assert.notStrictEqual(a[1].model.items.length, b[1].model.items.length);
  for (const x of b.slice(1)) assert.deepStrictEqual(BM.check(x.model).filter(c => c.level !== 'tip'), [], x.id);
});

t('loads as plain browser scripts: render.js then core.js gives a working global BM', () => {
  const vm = require('vm'), path = require('path'), fs = require('fs'), ctx = vm.createContext({});
  for (const f of ['render.js', 'core.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  const p = vm.runInContext('BM.exportPlan(BM.templates()[1].model, { savedAt: "" })', ctx);
  assert.strictEqual(p.bays.length, 4); assert(!vm.runInContext('bpCheck', ctx)(p).err);
});

console.log(`\n${n} passed`);
