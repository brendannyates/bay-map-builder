// Bay Map Builder core: the editable model, geometry, automatic placement, checks and export. No DOM, so the page and the
// Node tests run the same code. Browser: load render.js first, then this file (global BM). Node: require('./core.js').
// Units are drawing units, 16 to the foot like the ESK map. Angles are degrees clockwise; a chair's back points at (sin a, −cos a).
// Edit helpers (add, moveItems, remove, …) change the model they are given; geometry, layout, check and export never do.
(function (root){
'use strict';
const R = typeof module !== 'undefined' && module.exports ? require('./render.js') : { BP_SCHEMA, BP_MAX, BP_DEFAULT, bpCheck };

const UNIT = 16, GRID = 8, PAD = 24, WALL = 8, THIN = 4.5, CW = 52, CH = 60, SNAP = 10;
const SIZES = { S: 50, M: 58, L: 66 };
const FURN = { counter: { w: 96, h: 32, rx: 3 }, desk: { w: 80, h: 40, rx: 3 }, sink: { w: 40, h: 32, rx: 9 }, cabinet: { w: 48, h: 24, rx: 2 } };
const NAMES = { wall: 'Wall', door: 'Door', window: 'Window', curtain: 'Curtain', bay: 'Bay', chair: 'Chair', table: 'Side table', counter: 'Counter',
  desk: 'Desk', sink: 'Sink', cabinet: 'Cabinet', label: 'Label', path: 'Shape from the old map' };
const PREFIX = { wall: 'w', door: 'd', window: 'n', curtain: 'c', bay: 'b', chair: 'h', table: 't', counter: 'k', desk: 'e', sink: 's', cabinet: 'q', label: 'l', path: 'p' };
const BAY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,7}$/;

// ---------- small math ----------
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI, hyp = Math.hypot;
const dist = (a, b) => hyp(a[0] - b[0], a[1] - b[1]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd = n => { const v = Math.round(n * 10) / 10; return v === 0 ? 0 : v; };   // 0.1 steps, never −0
const fmt = n => String(rnd(n)), P = p => `${fmt(p[0])} ${fmt(p[1])}`;
const clone = x => JSON.parse(JSON.stringify(x));
const normA = a => { const v = ((a % 360) + 540) % 360 - 180; return v === -180 ? 180 : v; };
const back = a => [Math.sin(rad(a)), -Math.cos(rad(a))];          // where the chair back points
const pright = a => [-Math.cos(rad(a)), -Math.sin(rad(a))];       // the patient's right hand when seated
const rot = (p, c, d) => { const s = Math.sin(rad(d)), k = Math.cos(rad(d)), x = p[0] - c[0], y = p[1] - c[1]; return [c[0] + x * k - y * s, c[1] + x * s + y * k]; };
const cross = (u, v) => u[0] * v[1] - u[1] * v[0];
const str = (s, n) => typeof s === 'string' ? s.slice(0, n) : '';

// Point to segment distance, and the fraction along it of the nearest point.
function segNear(p, a, b){
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, 0, 1) : 0, q = [a[0] + dx * t, a[1] + dy * t];
  return { d: dist(p, q), t, q };
}
// Which side of a polyline p is on (+1 = the right of travel on screen, −1 = the left), judged at its nearest segment.
function sideOf(p, pts){
  let best = null; for (let i = 1; i < pts.length; i++){ const r = segNear(p, pts[i - 1], pts[i]); if (!best || r.d < best.d) best = { d: r.d, a: pts[i - 1], b: pts[i] }; }
  return best && cross([best.b[0] - best.a[0], best.b[1] - best.a[1]], [p[0] - best.a[0], p[1] - best.a[1]]) >= 0 ? 1 : -1;
}
const distPoly = (p, pts) => { let d = Infinity; for (let i = 1; i < pts.length; i++) d = Math.min(d, segNear(p, pts[i - 1], pts[i]).d); return pts.length === 1 ? dist(p, pts[0]) : d; };
// Do segments pq and rs cross (touching counts)?
function segX(p, q, r, s){
  const o = (a, b, c) => Math.sign(cross([b[0] - a[0], b[1] - a[1]], [c[0] - a[0], c[1] - a[1]]));
  const on = (a, b, c) => Math.min(a[0], b[0]) <= c[0] + 1e-9 && c[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) <= c[1] + 1e-9 && c[1] <= Math.max(a[1], b[1]) + 1e-9;
  const o1 = o(p, q, r), o2 = o(p, q, s), o3 = o(r, s, p), o4 = o(r, s, q);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(p, q, r)) || (o2 === 0 && on(p, q, s)) || (o3 === 0 && on(r, s, p)) || (o4 === 0 && on(r, s, q));
}
// Does segment pq touch box b (Liang–Barsky clip)?
function segBox(p, q, b){
  let t0 = 0, t1 = 1; const dx = q[0] - p[0], dy = q[1] - p[1];
  for (const [pp, qq] of [[-dx, p[0] - b.x0], [dx, b.x1 - p[0]], [-dy, p[1] - b.y0], [dy, b.y1 - p[1]]]){
    if (pp === 0){ if (qq < 0) return false; continue; }
    const r = qq / pp; if (pp < 0){ if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}
const polyBox = (pts, b) => { for (let i = 1; i < pts.length; i++) if (segBox(pts[i - 1], pts[i], b)) return true; return pts.length === 1 && inBox(pts[0], b); };
// Is p inside the polygon pts (even-odd)?
const inPoly = (p, pts) => { let k = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++){ const a = pts[i], b = pts[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) k = !k; } return k; };
const bbox = pts => { const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; for (const p of pts) grow(b, p[0], p[1]); return b; };
const grow = (b, x, y, r = 0) => { b.x0 = Math.min(b.x0, x - r); b.y0 = Math.min(b.y0, y - r); b.x1 = Math.max(b.x1, x + r); b.y1 = Math.max(b.y1, y + r); return b; };
const join = (b, c) => { if (c && isFinite(c.x0)) { grow(b, c.x0, c.y0); grow(b, c.x1, c.y1); } return b; };
const inflate = (b, r) => ({ x0: b.x0 - r, y0: b.y0 - r, x1: b.x1 + r, y1: b.y1 + r });
const inBox = (p, b) => p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1;
const boxHit = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
const interArea = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const boxDist = (p, b) => hyp(Math.max(b.x0 - p[0], 0, p[0] - b.x1), Math.max(b.y0 - p[1], 0, p[1] - b.y1));
const cbox = (x, y, w, h) => ({ x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 });

// Shapes for overlap tests: circle {t:'c',x,y,r} or rotated rectangle {t:'r',x,y,w,h,a} (centre, size, degrees).
const rrect = (x, y, w, h, a) => ({ t: 'r', x, y, w, h, a: a || 0 });
const corners = s => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => rot([s.x + i * s.w / 2, s.y + j * s.h / 2], [s.x, s.y], s.a));
const shapeBox = s => s.t === 'c' ? cbox(s.x, s.y, 2 * s.r, 2 * s.r) : bbox(corners(s));
function inShape(s, x, y, pad = 0){
  if (s.t === 'c') return hyp(x - s.x, y - s.y) <= s.r + pad;
  const [lx, ly] = rot([x, y], [s.x, s.y], -s.a); return Math.abs(lx - s.x) <= s.w / 2 + pad && Math.abs(ly - s.y) <= s.h / 2 + pad;
}
function shapeDist(s, p){
  if (s.t === 'c') return Math.max(0, dist(p, [s.x, s.y]) - s.r);
  const [lx, ly] = rot(p, [s.x, s.y], -s.a); return hyp(Math.max(Math.abs(lx - s.x) - s.w / 2, 0), Math.max(Math.abs(ly - s.y) - s.h / 2, 0));
}
// Share of box b covered by shape s, sampled on a 12 × 5 grid (good enough to rank tag spots).
function cover(b, s){
  if (!boxHit(b, shapeBox(s))) return 0;
  let n = 0; for (let i = 0; i < 12; i++) for (let j = 0; j < 5; j++) if (inShape(s, b.x0 + (i + .5) * (b.x1 - b.x0) / 12, b.y0 + (j + .5) * (b.y1 - b.y0) / 5)) n++;
  return n / 60;
}
// Does a segment (wall piece) cut through a rotated rectangle, allowing pad for the wall's thickness?
function segShape(p, q, s, pad){
  if (s.t === 'c') return segNear([s.x, s.y], p, q).d < s.r + pad;
  const c = [s.x, s.y], lp = rot(p, c, -s.a), lq = rot(q, c, -s.a);
  return segBox(lp, lq, { x0: s.x - s.w / 2 - pad, y0: s.y - s.h / 2 - pad, x1: s.x + s.w / 2 + pad, y1: s.y + s.h / 2 + pad });
}

// ---------- segments and arcs ----------
// One wall or curtain segment a→b bent by sagitta s. s > 0 bulges toward n = (−dy, dx) (the right of travel on screen); 0 = straight.
function arcOf(a, b, s){
  const dx = b[0] - a[0], dy = b[1] - a[1], c = hyp(dx, dy);
  if (!s || c < 1e-9) return null;
  const nx = -dy / c, ny = dx / c, as = Math.abs(s), r = (c * c / 4 + s * s) / (2 * as), k = s - Math.sign(s) * r;
  const cx = (a[0] + b[0]) / 2 + nx * k, cy = (a[1] + b[1]) / 2 + ny * k, big = as > c / 2;
  const th = 2 * Math.asin(Math.min(1, c / (2 * r))), sweep = (big ? 2 * Math.PI - th : th) * (s > 0 ? -1 : 1), a0 = Math.atan2(a[1] - cy, a[0] - cx);
  return { cx, cy, r, a0, sweep, big, len: r * Math.abs(sweep), at: u => [cx + r * Math.cos(a0 + sweep * u), cy + r * Math.sin(a0 + sweep * u)] };
}
// SVG path piece for one segment (no M): L for straight, a true circular arc (A) through both ends for curved.
function segPath(a, b, s){
  const A = arcOf(a, b, s);
  return A ? `A${fmt(A.r)} ${fmt(A.r)} 0 ${A.big ? 1 : 0} ${s > 0 ? 0 : 1} ${P(b)}` : `L${P(b)}`;
}
// Where the bend handle sits for a segment (the arc's middle), and the sagitta that puts the arc through point p.
const segMid = (a, b, s) => { const c = dist(a, b) || 1; return [(a[0] + b[0]) / 2 - (b[1] - a[1]) / c * (s || 0), (a[1] + b[1]) / 2 + (b[0] - a[0]) / c * (s || 0)]; };
function bendAt(a, b, p){
  const c = dist(a, b); if (c < 1) return 0;
  const s = (p[0] - (a[0] + b[0]) / 2) * -(b[1] - a[1]) / c + (p[1] - (a[1] + b[1]) / 2) * (b[0] - a[0]) / c;
  return Math.abs(s) < 3 ? 0 : rnd(clamp(s, -c, c));
}
// Segments of a wall or curtain item: [{i, a, b, s, len, arc}], including the closing one for closed walls.
function segsOf(it){
  const p = it.pts || [], n = p.length, out = [], m = it.closed && n > 2 ? n : n - 1;
  for (let i = 0; i < m; i++){ const a = p[i], b = p[(i + 1) % n], s = +(it.bend && it.bend[i]) || 0, arc = arcOf(a, b, s);
    out.push({ i, a, b, s, arc, len: arc ? arc.len : dist(a, b) }); }
  return out;
}
const segPts = g => { if (!g.arc) return [g.a, g.b]; const n = Math.max(2, Math.ceil(Math.abs(deg(g.arc.sweep)) / 8)); return Array.from({ length: n + 1 }, (_, k) => k === 0 ? g.a : k === n ? g.b : g.arc.at(k / n)); };
function polyOf(it){ const S = segsOf(it); if (!S.length) return (it.pts || []).slice(0, 1); const out = [S[0].a]; for (const g of S) out.push(...segPts(g).slice(1)); return out; }
// Path data for a whole line item (curtain track, or a wall with no openings).
function lineD(pts, bend, closed){
  if (!pts || pts.length < 2) return '';
  const S = segsOf({ pts, bend, closed }); let d = `M${P(pts[0])}`;
  S.forEach((g, k) => { d += closed && k === S.length - 1 && !g.s ? 'Z' : segPath(g.a, g.b, g.s); });
  return closed && S[S.length - 1].s ? d + 'Z' : d;
}

// ---------- SVG path data (imported shapes) ----------
// Parse path data into absolute commands: M, L, C, Q, A, Z (H/V become L; S/T become C/Q).
function parsePath(d){
  const tok = String(d || '').match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const N = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }, out = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lc = null, lq = null;
  const isNum = t => t != null && !/^[a-z]$/i.test(t);
  while (i < tok.length){
    if (!isNum(tok[i])){ cmd = tok[i++]; } else if (!cmd || cmd === 'Z' || cmd === 'z') break;
    const C = cmd.toUpperCase(), rel = cmd !== C, need = N[C];
    if (C === 'Z'){ out.push({ c: 'Z' }); x = sx; y = sy; lc = lq = null; continue; }
    if (!tok.slice(i, i + need).every(isNum) || i + need > tok.length) break;
    const v = tok.slice(i, i + need).map(Number); i += need;
    const ox = rel ? x : 0, oy = rel ? y : 0, pt = (k) => [v[k] + ox, v[k + 1] + oy];
    if (C === 'M'){ x = v[0] + ox; y = v[1] + oy; sx = x; sy = y; out.push({ c: 'M', p: [x, y] }); cmd = rel ? 'l' : 'L'; lc = lq = null; continue; }
    if (C === 'L' || C === 'H' || C === 'V'){ const p = C === 'L' ? pt(0) : C === 'H' ? [v[0] + ox, y] : [x, v[0] + oy]; out.push({ c: 'L', p }); [x, y] = p; lc = lq = null; continue; }
    if (C === 'C' || C === 'S'){ const p1 = C === 'C' ? pt(0) : lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y], p2 = C === 'C' ? pt(2) : pt(0), p = C === 'C' ? pt(4) : pt(2);
      out.push({ c: 'C', p1, p2, p }); lc = p2; lq = null; [x, y] = p; continue; }
    if (C === 'Q' || C === 'T'){ const p1 = C === 'Q' ? pt(0) : lq ? [2 * x - lq[0], 2 * y - lq[1]] : [x, y], p = C === 'Q' ? pt(2) : pt(0);
      out.push({ c: 'Q', p1, p }); lq = p1; lc = null; [x, y] = p; continue; }
    if (C === 'A'){ const p = [v[5] + ox, v[6] + oy]; out.push({ c: 'A', rx: Math.abs(v[0]), ry: Math.abs(v[1]), rot: v[2], large: v[3] ? 1 : 0, sweep: v[4] ? 1 : 0, p }); [x, y] = p; lc = lq = null; }
  }
  return out;
}
const pathStr = cmds => cmds.map(c => c.c === 'Z' ? 'Z' : c.c === 'C' ? `C${P(c.p1)} ${P(c.p2)} ${P(c.p)}` : c.c === 'Q' ? `Q${P(c.p1)} ${P(c.p)}`
  : c.c === 'A' ? `A${fmt(c.rx)} ${fmt(c.ry)} ${fmt(c.rot)} ${c.large} ${c.sweep} ${P(c.p)}` : `${c.c}${P(c.p)}`).join('');
// Move/rotate every point of a path (drot turns arc ellipses with it).
function mapPath(d, fn, drot = 0){
  return pathStr(parsePath(d).map(c => { const o = { ...c }; for (const k of ['p1', 'p2', 'p']) if (o[k]) o[k] = fn(o[k]); if (o.c === 'A') o.rot = normA(o.rot + drot); return o; }));
}
const movePath = (d, dx, dy) => mapPath(d, p => [p[0] + dx, p[1] + dy]);
// Points along an SVG arc command from p0 (SVG spec F.6.5, endpoint to centre form).
function arcCmdPts(p0, A){
  let { rx, ry } = A; const [x1, y1] = p0, [x2, y2] = A.p, phi = rad(A.rot || 0);
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return [A.p];
  const cp = Math.cos(phi), sp = Math.sin(phi), dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  const lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry); if (lam > 1){ rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den)); if (A.large === A.sweep) co = -co;
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx, cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry); let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!A.sweep && dt > 0) dt -= 2 * Math.PI; else if (A.sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(2, Math.ceil(Math.abs(deg(dt)) / 8)), out = [];
  for (let k = 1; k <= n; k++){ const t = t1 + dt * k / n, ex = rx * Math.cos(t), ey = ry * Math.sin(t); out.push(k === n ? [x2, y2] : [cp * ex - sp * ey + cx, sp * ex + cp * ey + cy]); }
  return out;
}
// Path data → polylines (one per subpath), curves flattened.
function flattenPath(d){
  const out = []; let cur = null, start = null, at = [0, 0];
  for (const c of parsePath(d)){
    if (c.c === 'M'){ cur = [c.p]; out.push(cur); start = at = c.p; continue; }
    if (!cur){ cur = [at]; out.push(cur); }
    if (c.c === 'Z'){ if (start) cur.push(start); at = start; cur = null; continue; }
    if (c.c === 'L') cur.push(c.p);
    else if (c.c === 'C') for (let k = 1; k <= 12; k++){ const t = k / 12, u = 1 - t; cur.push([0, 1].map(j => u * u * u * at[j] + 3 * u * u * t * c.p1[j] + 3 * u * t * t * c.p2[j] + t * t * t * c.p[j])); }
    else if (c.c === 'Q') for (let k = 1; k <= 8; k++){ const t = k / 8, u = 1 - t; cur.push([0, 1].map(j => u * u * at[j] + 2 * u * t * c.p1[j] + t * t * c.p[j])); }
    else if (c.c === 'A') cur.push(...arcCmdPts(at, c));
    at = c.p;
  }
  return out.filter(pl => pl.length);
}
const pathVerts = d => parsePath(d).filter(c => c.p).map(c => c.p);

// ---------- the model ----------
// A fresh, empty model.
const newModel = (name = '', clinic = '') => ({ v: 1, name, clinic, unit: UNIT, grid: GRID, items: [] });
const byId = (m, id) => m.items.find(i => i.id === id) || null;
// Next free id for a kind: w1, w2… (deterministic, so tests and undo snapshots stay stable).
function nextId(m, k){
  const pre = PREFIX[k] || 'x', re = new RegExp(`^${pre}(\\d+)$`); let n = 0;
  for (const it of m.items){ const r = re.exec(it.id || ''); if (r) n = Math.max(n, +r[1]); }
  return pre + (n + 1);
}
// Smallest whole bay number not used yet.
function nextBayNo(m){
  const used = new Set(m.items.filter(i => i.k === 'bay').map(b => String(b.no ?? '').trim().toLowerCase()));
  let n = 1; while (used.has(String(n))) n++; return String(n);
}
// Add an item (gives it an id when it has none or a taken one) and return it. A new bay joins any hand-picked curtain list
// whose track runs past it (so deleting and re-placing a bay keeps its curtains), and a new door moves a room name out of
// its swing. link:false skips both (pasting, where copies land on top of the originals for a moment).
function add(m, it, link = true){
  if (!it.id || byId(m, it.id)) it.id = nextId(m, it.k);
  m.items.push(it);
  if (link && it.k === 'bay') for (const c of m.items) if (Array.isArray(c.bays) && !c.bays.includes(it.id) && autoCurtainBays(m, c).includes(it.id)) c.bays.push(it.id);
  if (link && it.k === 'door') clearLabels(m, it);
  return it;
}

// Check a stored model and copy just the fields the builder knows. Returns null when it can't be trusted (importPlan then falls back).
function cleanModel(x){
  if (!x || typeof x !== 'object' || x.v !== 1 || !Array.isArray(x.items) || x.items.length > 3000) return null;
  const num = n => typeof n === 'number' && isFinite(n) && Math.abs(n) <= 1e5, pt = p => Array.isArray(p) && p.length === 2 && p.every(num);
  const pts = a => Array.isArray(a) && a.length >= 1 && a.length <= 500 && a.every(pt), nums = (a, n) => Array.isArray(a) && a.length === n && a.every(num);
  const out = { v: 1, name: str(x.name, 60), clinic: str(x.clinic, 20), unit: num(x.unit) && x.unit > 0 ? x.unit : UNIT, grid: num(x.grid) && x.grid > 0 ? x.grid : GRID, items: [] }, seen = new Set();
  for (const it of x.items){
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id || it.id.length > 24 || seen.has(it.id)) return null;
    seen.add(it.id); const k = it.k, id = it.id; let c = null;
    const bend = (a, n) => Array.from({ length: n }, (_, i) => Array.isArray(a) && num(a[i]) ? a[i] : 0);
    if (k === 'wall' && pts(it.pts)) c = { id, k, pts: clone(it.pts), bend: bend(it.bend, it.pts.length), closed: !!it.closed, thin: !!it.thin };
    else if ((k === 'door' || k === 'window') && typeof it.wall === 'string' && Number.isInteger(it.seg) && num(it.t) && num(it.w) && it.w > 0){
      c = { id, k, wall: it.wall, seg: it.seg, t: it.t, w: it.w };
      if (k === 'door') Object.assign(c, { type: ['swing', 'double', 'slide', 'open'].includes(it.type) ? it.type : 'swing', flip: !!it.flip, hinge: it.hinge === 'b' ? 'b' : 'a' });
    } else if (k === 'curtain' && pts(it.pts)) c = { id, k, pts: clone(it.pts), bend: bend(it.bend, it.pts.length), bays: Array.isArray(it.bays) ? it.bays.filter(s => typeof s === 'string') : null, rev: !!it.rev };
    else if (k === 'bay' && num(it.x) && num(it.y) && num(it.r) && it.r > 0) c = { id, k, no: str(String(it.no ?? ''), 20), x: it.x, y: it.y, r: it.r, a: num(it.a) ? it.a : 0,
      side: ['left', 'right', 'none', 'auto'].includes(it.side) ? it.side : 'auto', tag: pt(it.tag) ? [...it.tag] : null, chair: pt(it.chair) ? [...it.chair] : null, table: nums(it.table, 3) ? [...it.table] : null };
    else if (k === 'chair' && num(it.x) && num(it.y)) c = { id, k, x: it.x, y: it.y, a: num(it.a) ? it.a : 0 };
    else if (k === 'table' && num(it.x) && num(it.y) && num(it.s) && it.s > 0) c = { id, k, shape: it.shape === 'square' ? 'square' : 'round', x: it.x, y: it.y, s: it.s, a: num(it.a) ? it.a : 0 };
    else if (FURN[k] && num(it.x) && num(it.y) && num(it.w) && num(it.h) && it.w > 0 && it.h > 0) c = { id, k, x: it.x, y: it.y, w: it.w, h: it.h, a: num(it.a) ? it.a : 0 };
    else if (k === 'label' && num(it.x) && num(it.y)) c = { id, k, t: str(String(it.t ?? ''), 40), x: it.x, y: it.y, small: !!it.small };
    else if (k === 'path' && ['wall', 'door', 'window', 'curtain'].includes(it.layer) && typeof it.d === 'string' && it.d.length <= 20000 && /^\s*[Mm][MLHVCSQTAZmlhvcsqtaz0-9eE.,\s+-]*$/.test(it.d)){
      c = { id, k, layer: it.layer, d: it.d }; if (it.layer === 'wall' && it.thin) c.thin = true; if (it.layer === 'curtain') c.bays = Array.isArray(it.bays) ? it.bays.filter(s => typeof s === 'string') : null;
    }
    if (!c) return null;
    out.items.push(c);
  }
  return out;
}

// ---------- doors and windows ----------
const isOpening = o => o.k === 'door' || o.k === 'window';
// The straight wall segment an opening sits on, or why it can't sit there.
function openingSeg(m, o){
  const w = byId(m, o.wall); if (!w || w.k !== 'wall') return { err: 'This door or window isn’t on a wall any more.' };
  const g = segsOf(w)[o.seg]; if (!g) return { err: 'This door or window isn’t on a wall any more.' };
  if (g.s) return { err: 'Doors and windows only go on straight walls. Straighten the wall (double-click its middle handle) or move it.', g, w };
  const e = (w.thin ? THIN : WALL) / 2 + 2, c = o.t * g.len, what = o.k === 'door' ? 'door' : 'window';
  if (o.w > g.len - 2 * e) return { err: `This ${what} is wider than its wall.`, g, w };
  if (c - o.w / 2 < e - 0.5 || c + o.w / 2 > g.len - e + 0.5) return { err: `This ${what} runs past the end of its wall. Slide it along the wall.`, g, w };
  return { g, w };
}
// Gap ends of an opening, the unit vector along its wall and the normal its door swings toward.
function openingGeo(m, o){
  const S = openingSeg(m, o); if (S.err) return null;
  const { g } = S, u = [(g.b[0] - g.a[0]) / g.len, (g.b[1] - g.a[1]) / g.len], c = clamp(o.t, 0, 1) * g.len;
  const at = d => [g.a[0] + u[0] * d, g.a[1] + u[1] * d], f = o.flip ? -1 : 1;
  return { g, u, n: [-u[1] * f, u[0] * f], g0: at(c - o.w / 2), g1: at(c + o.w / 2), c };
}
// Door symbol in the ESK style: hinge → leaf tip, then the swing arc back to the far jamb. Open doors are just a gap ('').
function doorD(m, door){
  const G = openingGeo(m, door); if (!G) return '';
  const { n, g0, g1 } = G, w = door.w, add = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];
  const leaf = (h, j, r) => { const tip = add(h, n, r); return `M${P(h)}L${P(tip)}A${fmt(r)} ${fmt(r)} 0 0 ${cross([tip[0] - h[0], tip[1] - h[1]], [j[0] - h[0], j[1] - h[1]]) > 0 ? 1 : 0} ${P(j)}`; };
  if (door.type === 'open') return '';
  if (door.type === 'slide') return `M${P(add(g0, n, 3))}L${P(add(g1, n, 3))}L${P(add(g1, n, 9))}L${P(add(g0, n, 9))}Z`;
  if (door.type === 'double'){ const mid = [(g0[0] + g1[0]) / 2, (g0[1] + g1[1]) / 2]; return leaf(g0, mid, w / 2) + leaf(g1, mid, w / 2); }
  return door.hinge === 'b' ? leaf(g1, g0, w) : leaf(g0, g1, w);
}
// A window is drawn along its gap (render.js gives it the frame and glass lines).
function windowD(m, win){ const G = openingGeo(m, win); return G ? `M${P(G.g0)}L${P(G.g1)}` : ''; }
// Wall path with gaps cut where its doors and windows sit. Curved segments are never cut (they refuse openings).
function wallD(m, w){
  const S = segsOf(w); if (!S.length) return '';
  const pieces = [], pt = (g, u) => [g.a[0] + (g.b[0] - g.a[0]) * u / g.len, g.a[1] + (g.b[1] - g.a[1]) * u / g.len];
  let cut = false;
  for (const g of S){
    const cuts = g.s ? [] : m.items.filter(o => isOpening(o) && o.wall === w.id && o.seg === g.i && !openingSeg(m, o).err)
      .map(o => { const c = clamp(o.t, 0, 1) * g.len; return [clamp(c - o.w / 2, 0, g.len), clamp(c + o.w / 2, 0, g.len)]; }).sort((a, b) => a[0] - b[0]);
    if (cuts.length) cut = true;
    let at = 0;
    for (const [c0, c1] of cuts){ if (c0 > at + 0.01) pieces.push({ g, u0: at, u1: c0 }); at = Math.max(at, c1); }
    if (at < g.len - 0.01) pieces.push({ g, u0: at, u1: g.len });
  }
  for (const p of pieces){ p.s = p.g.s ? p.g.a : pt(p.g, p.u0); p.e = p.g.s ? p.g.b : pt(p.g, p.u1); }
  let list = pieces;
  // A cut closed wall starts just after a gap, so every run is drawn in one stroke and corners stay joined.
  if (w.closed && cut){ const k = list.findIndex((p, i) => dist(list[(i + list.length - 1) % list.length].e, p.s) > 0.01); if (k > 0) list = [...list.slice(k), ...list.slice(0, k)]; }
  let d = '', pen = null;
  list.forEach((p, k) => {
    const { s, e } = p;
    if (!pen || dist(pen, s) > 0.01) d += `M${P(s)}`;
    d += w.closed && !cut && k === list.length - 1 && !p.g.s ? 'Z' : p.g.s ? segPath(p.g.a, p.g.b, p.g.s) : `L${P(e)}`;
    pen = e;
  });
  return w.closed && !cut && S[S.length - 1].s ? d + 'Z' : d;
}
// Nearest model wall segment to p within tol: {wall, seg, t, d, curved, side (+1 = the side a door swings to unflipped)}.
function wallAt(m, p, tol = 16){
  let best = null;
  for (const w of m.items) if (w.k === 'wall') for (const g of segsOf(w)){
    let d, t;
    if (g.arc){ const pts = segPts(g); d = distPoly(p, pts); t = 0.5; }
    else { const r = segNear(p, g.a, g.b); d = r.d; t = r.t; }
    if (d <= tol && (!best || d < best.d)){
      const side = cross([g.b[0] - g.a[0], g.b[1] - g.a[1]], [p[0] - g.a[0], p[1] - g.a[1]]) >= 0 ? 1 : -1;
      best = { wall: w.id, seg: g.i, t, d, curved: !!g.s, side, len: g.len };
    }
  }
  return best;
}
// Where other walls cross or end on a straight segment: [{s (distance along it), th}]. A wall ending a stroke-width short still counts.
function crossings(m, wallId, g){
  const u = [(g.b[0] - g.a[0]) / g.len, (g.b[1] - g.a[1]) / g.len], out = [];
  for (const x of wallLines(m)) if (x.id !== wallId) for (let i = 1; i < x.pts.length; i++){
    const p = x.pts[i - 1], q = x.pts[i], v = [q[0] - p[0], q[1] - p[1]], lv = hyp(v[0], v[1]), den = cross(u, v); if (lv < 1e-9 || Math.abs(den) / lv < 0.05) continue;
    const ap = [p[0] - g.a[0], p[1] - g.a[1]], s = cross(ap, v) / den, k = cross(ap, u) / den, slack = (x.th / 2 + 1) / lv;
    if (k >= -slack && k <= 1 + slack && s >= 0 && s <= g.len) out.push({ s, th: x.th });
  }
  return out;
}
// Slide an opening along its segment so it fits between the corners, any other door or window there, and any wall that
// meets it (a door straddling a T-junction would open into two rooms at once).
function doorFit(m, wallId, seg, t, w, skip){
  const W = byId(m, wallId); if (!W || W.k !== 'wall') return { err: 'Point at a wall.' };
  const g = segsOf(W)[seg]; if (!g) return { err: 'Point at a wall.' };
  if (g.s) return { err: 'Doors and windows only go on straight walls. Straighten this wall first.' };
  const e = (W.thin ? THIN : WALL) / 2 + 2, half = w / 2;
  if (w > g.len - 2 * e) return { err: 'This wall is too short for that width.' };
  const others = m.items.filter(o => isOpening(o) && o.id !== skip && o.wall === wallId && o.seg === seg).map(o => [o.t * g.len - o.w / 2 - 2, o.t * g.len + o.w / 2 + 2])
    .concat(crossings(m, wallId, g).map(x => [x.s - x.th / 2 - 2, x.s + x.th / 2 + 2]));
  const ok = c => c - half >= e - 1e-6 && c + half <= g.len - e + 1e-6 && others.every(([a, b]) => c + half <= a || c - half >= b);
  const want = clamp(t * g.len, e + half, g.len - e - half);
  const cand = [want, ...others.flatMap(([a, b]) => [a - half, b + half])].filter(ok).sort((x, y) => Math.abs(x - want) - Math.abs(y - want));
  return cand.length ? { ok: true, t: cand[0] / g.len } : { err: 'There’s no room for it here. Something else is already on this wall.' };
}
// Hinge on the end nearer a crossing wall or corner, so the door folds back against it (what builders do).
function hingeFor(m, wallId, seg, t, w){
  const W = byId(m, wallId), g = W && segsOf(W)[seg]; if (!g || g.s) return 'a';
  const c = t * g.len;
  let dA = c - w / 2, dB = g.len - c - w / 2;
  for (const { s } of crossings(m, wallId, g)) if (s < c) dA = Math.min(dA, c - w / 2 - s); else dB = Math.min(dB, s - c - w / 2);
  return dA <= dB ? 'a' : 'b';
}
// Which way a door clicked right on its wall swings (true = the unflipped side): into the room the wall goes round (a room
// drawn next to another one is an open wall of three sides, so it counts as closed back to its start), else toward the side
// with more bays, else the pointer's side. Which half of the stroke the pointer is over shouldn't decide it.
function swingIn(m, W, seg, t, side){
  const g = segsOf(W)[seg], u = [(g.b[0] - g.a[0]) / g.len, (g.b[1] - g.a[1]) / g.len], c = [g.a[0] + u[0] * t * g.len, g.a[1] + u[1] * t * g.len], pl = polyOf(W);
  const area = Math.abs(pl.reduce((s, p, i) => s + cross(p, pl[(i + 1) % pl.length]), 0)) / 2;
  if (W.pts.length > 2 && area > 64 * 64) return inPoly([c[0] - u[1] * 6, c[1] + u[0] * 6], pl);
  let k = 0; for (const b of m.items) if (b.k === 'bay' && dist([b.x, b.y], c) < 480) k += Math.sign(cross(u, [b.x - c[0], b.y - c[1]]));
  return k ? k > 0 : side >= 0;
}
// A door (or window) for the wall under p, or {err} in plain words. Not added: call add(m, item).
// The pointer picks the swing side only when it is clearly off the wall's stroke.
function newDoor(m, p, o = {}){
  const k = o.k === 'window' ? 'window' : 'door', hit = wallAt(m, p, o.tol ?? 16);
  if (!hit) return { err: `Point at a wall to place the ${k}.` };
  if (hit.curved) return { err: 'Doors and windows only go on straight walls. Straighten this wall first.' };
  const w = o.w ?? (k === 'door' ? 3 * UNIT : 4 * UNIT), fit = doorFit(m, hit.wall, hit.seg, hit.t, w, o.skip);
  if (fit.err) return fit;
  const it = { id: '', k, wall: hit.wall, seg: hit.seg, t: fit.t, w }, W = byId(m, hit.wall);
  if (k === 'door') Object.assign(it, { type: o.type || 'swing', flip: hit.d > (W.thin ? THIN : WALL) / 2 + 4 ? hit.side < 0 : !swingIn(m, W, hit.seg, fit.t, hit.side),
    hinge: hingeFor(m, hit.wall, hit.seg, fit.t, w) });
  return { item: it };
}

// ---------- scene: everything the placement and checks avoid ----------
// Wall centre lines from wall items and imported wall shapes: [{id, pts, th}].
function wallLines(m){
  const out = [];
  for (const it of m.items){
    if (it.k === 'wall') out.push({ id: it.id, pts: polyOf(it), th: it.thin ? THIN : WALL });
    else if (it.k === 'path' && it.layer === 'wall') for (const pl of flattenPath(it.d)) out.push({ id: it.id, pts: pl, th: it.thin ? THIN : WALL });
  }
  return out;
}
const labelBox = l => cbox(l.x, l.y, Math.max(24, String(l.t || '').length * (l.small ? 7 : 8.4) + 8), l.small ? 16 : 20);
function furnShape(it){
  if (it.k === 'chair') return rrect(it.x, it.y, CW, CH, it.a);
  if (it.k === 'table') return it.shape === 'square' ? rrect(it.x, it.y, it.s, it.s, it.a) : { t: 'c', x: it.x, y: it.y, r: it.s / 2 };
  return rrect(it.x, it.y, it.w, it.h, it.a);
}
function scene(m){
  const S = { walls: wallLines(m), curts: [], doors: [], wins: [], furn: [], labels: [], rugs: [] };
  for (const it of m.items){
    if (it.k === 'curtain') S.curts.push({ id: it.id, pts: polyOf(it) });
    else if (it.k === 'door' || it.k === 'window'){ const d = it.k === 'door' ? doorD(m, it) || windowD(m, it) : windowD(m, it); if (d) S[it.k === 'door' ? 'doors' : 'wins'].push({ id: it.id, box: inflate(bbox(flattenPath(d).flat()), 2) }); }
    else if (it.k === 'path'){ const L = flattenPath(it.d);
      if (it.layer === 'curtain') for (const pl of L) S.curts.push({ id: it.id, pts: pl });
      else if (it.layer === 'door' || it.layer === 'window') S[it.layer === 'door' ? 'doors' : 'wins'].push({ id: it.id, box: inflate(bbox(L.flat()), 2) }); }
    else if (it.k === 'chair' || it.k === 'table' || FURN[it.k]) S.furn.push({ id: it.id, s: furnShape(it) });
    else if (it.k === 'label' && String(it.t || '').trim()) S.labels.push({ id: it.id, box: labelBox(it) });
    else if (it.k === 'bay') S.rugs.push({ id: it.id, x: it.x, y: it.y, r: it.r });
  }
  return S;
}
// Free space around a spot of radius rr: distance to the nearest wall, curtain, door, furniture, label or other rug (capped).
function room(S, p, rr, bayId){
  let c = 200;
  for (const w of S.walls){ const v = distPoly(p, w.pts) - w.th / 2 - rr; c = Math.min(c, v < 0 ? 3 * v : v); }   // never into a wall
  for (const x of S.curts) c = Math.min(c, distPoly(p, x.pts) - rr - 1);
  for (const x of [...S.doors, ...S.wins, ...S.labels]) c = Math.min(c, boxDist(p, x.box) - rr);
  for (const x of S.furn) c = Math.min(c, shapeDist(x.s, p) - rr);
  for (const r of S.rugs) if (r.id !== bayId) c = Math.min(c, dist(p, [r.x, r.y]) - r.r - rr);
  return c;
}

// ---------- bays ----------
// Chair, side table and lantern for a bay. Chair sits toward the back of the rug, its back toward a; the table goes beside it
// on the side with more room when side is auto (sliding a little forward or back if both sides are tight). When nothing fits,
// a smaller table tucked in against the chair is tried, so bays 9 ft apart keep their tables off the curtain between them.
function bayParts(S, b){
  const a = +b.a || 0, bk = back(a), pr = pright(a);
  const ch = b.chair ? [b.x + b.chair[0], b.y + b.chair[1]] : [b.x + bk[0] * 0.55 * b.r, b.y + bk[1] * 0.55 * b.r];
  let table = null, lamp = null;
  if (b.table){ const [dx, dy, tr] = b.table; lamp = [b.x + dx, b.y + dy]; if (tr > 0) table = { c: [lamp[0], lamp[1], tr] }; }
  else if (b.side !== 'none'){
    const ks = b.side === 'left' ? [-1] : b.side === 'right' ? [1] : [1, -1];
    const pick = (tr, gap) => { const off = CW / 2 + tr + gap; let best = null;
      for (const k of ks) for (const al of [6, 18, -6]){ const p = [ch[0] + pr[0] * off * k - bk[0] * al, ch[1] + pr[1] * off * k - bk[1] * al], sc = Math.min(room(S, p, tr, b.id), 24) - (al === 6 ? 0 : 3);
        if (!best || sc > best.sc + 0.5) best = { p, sc, tr }; }
      return best; };
    let best = pick(clamp(Math.round(b.r * 0.4), 22, 26), 5);
    if (best.sc < 0){ const t = pick(18, 2); if (t.sc > best.sc) best = t; }
    table = { c: [best.p[0], best.p[1], best.tr] }; lamp = best.p;
  }
  return { chair: [ch[0], ch[1], a], table, lamp };
}
const chairShape = c => rrect(c[0], c[1], CW, CH, c[2]);
// Share of a chair [x, y, a] inside box b, sampled on a 6 × 6 grid.
function chairCover(b, c){
  let n = 0; for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) if (inBox(rot([c[0] + ((i + .5) / 6 - .5) * CW, c[1] + ((j + .5) / 6 - .5) * CH], [c[0], c[1]], c[2]), b)) n++;
  return n / 36;
}
// How far a rug's centre must sit from the wall behind its chair (the chair's depth) and from any other wall.
const backGap = r => Math.max(r + 6, 0.55 * r + CH / 2 + 10), sideGap = r => r + 6;
// The angle that turns a chair's back to a wall, snapped to 15° (so the patient faces into the room). Every wall within half a
// rug of the nearest counts, so a few units don't decide it: one the chair already clears wins, then the one the nearest bay
// backs onto (a row stays in line, end bays too), then the one about a chair's depth away, on a longer wall. o = {r, skip (this bay's id)}.
function faceWall(m, x, y, S = null, o = {}){
  const W = (S || scene(m)).walls, r = o.r || SIZES.M, ang = q => normA(Math.round(deg(Math.atan2(q[0] - x, -(q[1] - y))) / 15) * 15), all = [];
  for (const w of W) for (let i = 1; i < w.pts.length; i++){ const s = segNear([x, y], w.pts[i - 1], w.pts[i]); all.push({ d: s.d, q: s.q, th: w.th, len: dist(w.pts[i - 1], w.pts[i]) }); }
  if (!all.length) return 0;
  const d0 = Math.min(...all.map(c => c.d)); if (d0 < 1e-6) return 0;
  const by = new Map();
  for (const c of all) if (c.d <= d0 + 0.5 * r){ const a = ang(c.q), was = by.get(a); if (!was || c.len > was.len) by.set(a, { ...c, a, d: Math.min(c.d, was ? was.d : Infinity) }); }
  let C = [...by.values()];
  if (C.length > 1){ const ok = C.filter(c => c.d >= backGap(r) + c.th / 2 - 6); if (ok.length) C = ok; }
  if (C.length > 1){
    const nb = m.items.filter(b => b.k === 'bay' && b.id !== o.skip && dist([b.x, b.y], [x, y]) < 5 * r).sort((p, q) => dist([p.x, p.y], [x, y]) - dist([q.x, q.y], [x, y]))[0];
    const same = nb && C.find(c => c.a === normA(Math.round((nb.a || 0) / 15) * 15)); if (same) return same.a;
  }
  const score = c => Math.abs(c.d - backGap(r)) - 0.02 * Math.min(c.len, 1000);   // about a chair's depth away, on a long wall
  return C.sort((p, q) => score(p) - score(q))[0].a;
}
// Keep a rug (and the chair at its back) clear of walls: push the centre out of any wall closer than the rug needs. Only the
// wall behind the chair needs the chair's depth. Door swings are kept clear too, so a bay dropped by a door doesn't block it.
// The push never takes a rug into another one: it stops where they would touch.
function nudgeBay(m, b, S = null){
  S = S || scene(m);
  const bk = back(+b.a || 0), p0 = [b.x, b.y];
  let p = [b.x, b.y];
  for (let k = 0; k < 8; k++){
    let moved = false;
    for (const w of S.walls) for (let i = 1; i < w.pts.length; i++){ const r = segNear(p, w.pts[i - 1], w.pts[i]); if (r.d <= 1e-6) continue;
      const behind = ((r.q[0] - p[0]) * bk[0] + (r.q[1] - p[1]) * bk[1]) / r.d >= Math.SQRT1_2, want = (behind ? backGap(b.r) : sideGap(b.r)) + w.th / 2 - 4;
      if (r.d < want){ p = [r.q[0] + (p[0] - r.q[0]) / r.d * want, r.q[1] + (p[1] - r.q[1]) / r.d * want]; moved = true; } }
    for (const d of S.doors){ const z = d.box, q = [clamp(p[0], z.x0, z.x1), clamp(p[1], z.y0, z.y1)], dd = dist(p, q), want = b.r + 8;
      if (dd >= want) continue;
      const v = dd > 1e-6 ? [(p[0] - q[0]) / dd, (p[1] - q[1]) / dd] : (() => { const c = [(z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2], L = dist(p, c) || 1; return [(p[0] - c[0]) / L, (p[1] - c[1]) / L]; })();
      p = [q[0] + v[0] * want, q[1] + v[1] * want]; moved = true; }
    if (!moved) break;
  }
  const gap = q => Math.min(Infinity, ...S.rugs.filter(o => o.id !== b.id).map(o => dist(q, [o.x, o.y]) - o.r - b.r)), at = t => [p0[0] + (p[0] - p0[0]) * t, p0[1] + (p[1] - p0[1]) * t];
  const g0 = gap(p0);
  if (gap(p) < Math.min(0, g0)){ let t = 1; while (t > 0 && gap(at(t)) < Math.min(0, g0)) t = Math.max(0, t - 0.05); p = at(t); }
  b.x = rnd(p[0]); b.y = rnd(p[1]); return b;
}
// A complete bay at (x, y): next free number, medium rug, its back turned to a wall, then nudged off the walls. Turning first
// means only the wall behind the chair pushes it out by the chair's depth. Not added: call add(m, bay).
function newBay(m, x, y, o = {}){
  const S = scene(m), b = { id: '', k: 'bay', no: o.no || nextBayNo(m), x, y, r: o.r || SIZES.M, a: 0, side: 'auto', tag: null, chair: null, table: null };
  b.a = o.a ?? faceWall(m, x, y, S, { r: b.r }); nudgeBay(m, b, S); return b;
}

// ---------- tags ----------
// The tracker's bay tag in px when the map is drawn D px wide, worked out from ESK's .btag CSS: fonts and padding grow with the
// map but stop at fixed px sizes. Text is a typical tag ("4 Patient B" over "Vitals due 10:20"). At 560 px or less the tag is
// one line (dot, then the name, cut off at 19% of the map). Checked against tags measured in Edge: about 127 × 48 px at
// 900 px wide, 57 × 17 px in the side pane.
function tagPx(D){
  const n = clamp(0.02 * D, 10, 14), s = clamp(0.0175 * D, 9, 12.5), py = clamp(0.008 * D, 2, 7), px = clamp(0.014 * D, 5, 11), name = 10.4 * 0.52 * n;
  if (D <= 560) return [Math.min(0.19 * D, 11 + name + 2 * px), 1.2 * n + 2 * py];
  return [Math.min(0.28 * D, Math.max(name, 16 * 0.465 * s + 12) + 2 * px), 1.2 * n + 2 + 1.2 * s + 2 * py];
}
// The map widths the builder plans for. Tags are placed and checked at 760 px (ESK Bays, and a narrow full-screen map); wider
// maps draw them smaller for the map, so they can't collide there. The Excel side pane (300 px) is checked too, and PANE_W is
// how much its size counts when placing tags: some, so tags stagger there, but less than the main view.
const TAG_D = 760, PANE_D = 300, PANE_W = 0.2;
// Tag size in drawing units for a map w units wide drawn D px wide.
const tagSize = (w, D = TAG_D) => tagPx(D).map(v => v * w / D);
// Centre distance along unit u at which a hw × hh half-size box is gap away from a circle of radius r (gap < 0 = overlaps).
function boxOut(u, r, hw, hh, gap){
  const want = r + gap, near = d => hyp(Math.max(Math.abs(u[0] * d) - hw, 0), Math.max(Math.abs(u[1] * d) - hh, 0));
  let lo = 0, hi = r + hw + hh + Math.max(gap, 0) + 10;
  for (let k = 0; k < 32; k++){ const mid = (lo + hi) / 2; if (near(mid) < want) lo = mid; else hi = mid; }
  return hi;
}
// How bad a tag spot is: off the map, across walls, over other tags, rugs, lanterns, chairs, tables, doors and room names;
// then a mild pull toward the front of the chair and a slight overlap of the rug edge, like the ESK drawing.
// The part that depends on other tags is redone each time (it runs most, so it does plain sums); the rest once per spot.
// Two same-size boxes dx, dy apart overlap by (w − dx)(h − dy).
function tagCost(X, i, c){
  if (c.sc == null) c.sc = tagStatic(X, i, c);
  const { tw, th, pw, ph } = X, mw = Math.max(tw, pw), mh = Math.max(th, ph); let k = c.sc;
  for (const j of X.near[i].bays){ const t = X.tags[j]; if (j === i || !t) continue;
    const dx = Math.abs(c.x - t[0]), dy = Math.abs(c.y - t[1]); if (dx >= mw || dy >= mh) continue;
    if (dx < tw && dy < th) k += 400 + 800 * (tw - dx) * (th - dy) / (tw * th);
    if (dx < pw && dy < ph){ const fp = (pw - dx) * (ph - dy) / (pw * ph); if (fp > 0.04) k += PANE_W * (400 + 800 * fp); } }
  return k;
}
function tagStatic(X, i, c){
  const { B, box, tw, th } = X, S = X.near[i], me = B[i], b = cbox(c.x, c.y, tw, th), area = tw * th;
  let k = 0;
  const over = Math.max(box.x0 - b.x0, b.x1 - box.x1, box.y0 - b.y0, b.y1 - box.y1, 0);   // a little past the padding just grows the map
  if (over > 0) k += over * 6 + (over > PAD ? 1500 : 0);
  for (const w of S.walls){ if (polyBox(w.pts, inflate(b, w.th / 2 + 1))) k += 1000;
    for (let j = 1; j < w.pts.length; j++) if (segX([me.b.x, me.b.y], [c.x, c.y], w.pts[j - 1], w.pts[j])){ k += 1000; break; } }
  for (const j of S.bays){
    const o = B[j];
    if (j !== i){
      const f = cover(b, { t: 'c', x: o.b.x, y: o.b.y, r: o.b.r }); if (f > 0) k += 150 + 400 * f;
      const fc = cover(b, chairShape(o.p.chair)); if (fc > 0) k += 100 + 300 * fc;
      if (o.p.table){ const ft = cover(b, { t: 'c', x: o.p.table.c[0], y: o.p.table.c[1], r: o.p.table.c[2] }); if (ft > 0) k += 60 + 200 * ft; }
    } else {
      k += 80 * cover(b, chairShape(o.p.chair)); const oc = chairCover(b, o.p.chair); if (oc > 0.08) k += 150 + 300 * oc;   // its own chair hidden
      if (o.p.table) k += 60 * cover(b, { t: 'c', x: o.p.table.c[0], y: o.p.table.c[1], r: o.p.table.c[2] });
    }
    if (o.p.lamp && boxDist(o.p.lamp, b) < 9) k += j === i ? 300 : 400;
  }
  for (const f of S.furn){ const v = cover(b, f.s); if (v > 0) k += 60 + 200 * v; }
  // The same tag drawn in the Excel side pane is larger for the map: keep that clear of walls and other rugs too, when it costs little.
  const bp = cbox(c.x, c.y, X.pw, X.ph);
  for (const w of S.walls) if (polyBox(w.pts, inflate(bp, w.th / 2))){ k += PANE_W * 1000; break; }
  for (const j of S.bays) if (j !== i){ const o = B[j], f = cover(bp, { t: 'c', x: o.b.x, y: o.b.y, r: o.b.r }); if (f > 0.05) k += PANE_W * (150 + 400 * f); }
  for (const d of S.doors){ const v = interArea(b, d.box) / area; if (v > 0) k += 100 + 250 * v; }
  for (const l of S.labels){ const v = interArea(b, l.box) / area; if (v > 0) k += 150 + 300 * v; }
  // A curtain between the rug and its tag makes the tag read as the next bay's; one splitting the tag down the middle nearly as much.
  for (const x of S.curts){
    if (polyBox(x.pts, b)){ k += 12; let n = 0; for (let ii = 0; ii < 6; ii++) for (let jj = 0; jj < 3; jj++) if (sideOf([b.x0 + (ii + .5) * tw / 6, b.y0 + (jj + .5) * th / 3], x.pts) > 0) n++;
      if (Math.min(n, 18 - n) > 4.5) k += 40; }
    for (let j = 1; j < x.pts.length; j++) if (segX([me.b.x, me.b.y], [c.x, c.y], x.pts[j - 1], x.pts[j])){ k += 300; break; }
  }
  const fr = back(me.b.a || 0), da = Math.abs(normA(deg(Math.atan2(c.u[1], c.u[0])) - deg(Math.atan2(-fr[1], -fr[0]))));
  return k + da * 0.12 + Math.abs(c.o - 0.3 * th) * 0.35 + (c.u[1] < -0.2 ? 2 : 0);
}
// Candidate tag centres around a rug: 24 directions × 5 depths (over the rug's edge, touching it, or standing off so neighbours can stagger).
function tagSpots(b, tw, th){
  const out = [];
  for (let k = 0; k < 24; k++){ const ang = rad(k * 15), u = [Math.cos(ang), Math.sin(ang)];
    for (const o of [0.3, 0.6, 0, -0.35, -1.15].map(f => f * th)){ const d = boxOut(u, b.r, tw / 2, th / 2, -o); out.push({ x: b.x + u[0] * d, y: b.y + u[1] * d, o, u }); } }
  return out;
}

// What a tag around bay b could touch: walls, doors, furniture, labels, curtains and bays within reach (keeps big maps quick).
function nearOf(X, b){
  const { S, B } = X, tw = Math.max(X.tw, X.pw), th = Math.max(X.th, X.ph), reach = b.r + tw + th + 8, z = cbox(b.x, b.y, 2 * reach, 2 * reach);
  return { walls: S.walls.filter(w => boxHit(z, inflate(bbox(w.pts), w.th))), curts: S.curts.filter(x => boxHit(z, bbox(x.pts))),
    doors: S.doors.filter(d => boxHit(z, d.box)), labels: S.labels.filter(l => boxHit(z, l.box)), furn: S.furn.filter(f => boxHit(z, shapeBox(f.s))),
    bays: B.map((o, j) => j).filter(j => dist([B[j].b.x, B[j].b.y], [b.x, b.y]) < reach + B[j].b.r + tw + th + CH) };
}
// Place every unpinned tag: greedy in a few different orders, each polished by passes where one tag moves at a time with the
// others fixed; keep the order with the lowest total cost. Deterministic, and quick for the 5–40 bays a clinic has.
function placeTags(X){
  const { B, tw, th } = X, pinned = X.tags.slice(), free = B.map((o, i) => o.b.tag ? -1 : i).filter(i => i >= 0);
  if (!free.length) return;
  X.near = B.map(o => nearOf(X, o.b));
  const spots = B.map(o => tagSpots(o.b, tw, th)), crowd = i => B.filter(o => dist([o.b.x, o.b.y], [B[i].b.x, B[i].b.y]) < 3 * (o.b.r + B[i].b.r)).length;
  const orders = (free.length > 16 ? [] : [free, [...free].reverse()]).concat([ [...free].sort((a, b) => crowd(b) - crowd(a) || a - b),
    [...free].sort((a, b) => B[a].b.y - B[b].b.y || B[a].b.x - B[b].b.x), [...free].sort((a, b) => B[a].b.x - B[b].b.x || B[a].b.y - B[b].b.y)]);
  let best = null;
  for (const order of orders){
    X.tags = pinned.slice(); const pick = new Map();
    for (let pass = 0; pass < 4; pass++){
      let changed = false;
      for (const i of order){
        let top = null; for (const c of spots[i]){ const v = tagCost(X, i, c); if (!top || v < top.v - 1e-9) top = { v, c }; }
        const was = X.tags[i]; if (!was || dist(was, [top.c.x, top.c.y]) > 1e-6){ X.tags[i] = [top.c.x, top.c.y]; pick.set(i, top.c); changed = true; }
      }
      if (!changed) break;
    }
    pairUp(X, free, spots, pick);
    const total = free.reduce((t, i) => t + tagCost(X, i, pick.get(i)), 0);
    if (!best || total < best.total - 1e-6) best = { total, tags: X.tags.slice() };
  }
  X.tags = best.tags;
}
// Two tags in each other's way: try the best few spots of both together (one move at a time can't swap them).
function pairUp(X, free, spots, pick){
  const top = new Map(free.map(i => [i, [...spots[i]].sort((a, b) => tagCost({ ...X, tags: [] }, i, a) - tagCost({ ...X, tags: [] }, i, b)).slice(0, 10)]));
  for (let round = 0; round < 2; round++) for (const i of free) for (const j of X.near[i].bays){
    if (j <= i || !pick.has(j) || tagCost(X, i, pick.get(i)) + tagCost(X, j, pick.get(j)) < 100) continue;
    let best = { v: tagCost(X, i, pick.get(i)) + tagCost(X, j, pick.get(j)), a: pick.get(i), b: pick.get(j) };
    for (const a of top.get(i)) for (const b of top.get(j)){
      X.tags[i] = [a.x, a.y]; X.tags[j] = [b.x, b.y]; const v = tagCost(X, i, a) + tagCost(X, j, b);
      if (v < best.v - 1e-6) best = { v, a, b };
    }
    X.tags[i] = [best.a.x, best.a.y]; X.tags[j] = [best.b.x, best.b.y]; pick.set(i, best.a); pick.set(j, best.b);
  }
}

// ---------- layout ----------
// The last few results, keyed by the model's JSON: the page asks for the same model many times per frame, and check()
// asks for a cleaned copy too.
const memo = [];
// Everything automatic, resolved: chair, table, lantern and tag per bay, curtain bay links, and the map box.
// Returns {box:{x,y,w,h}, tag:[w,h], bays: Map(bay id → {chair:[x,y,a], table, lamp, tag}), curtains: Map(curtain id → [bay ids])}.
function layout(m){
  const key = JSON.stringify(m), got = memo.find(x => x.key === key); if (got) return got.val;
  const S = scene(m), bays = m.items.filter(i => i.k === 'bay');
  // Bays are fitted one at a time (pinned tables first), each seeing the chairs and tables already placed, so two neighbours
  // don't both put their table in the gap between them.
  const F = { ...S, furn: [...S.furn] }, B = bays.map(b => ({ b, p: null }));
  for (const i of bays.map((b, i) => i).sort((i, j) => (bays[j].table ? 1 : 0) - (bays[i].table ? 1 : 0) || i - j)){
    const p = B[i].p = bayParts(F, bays[i]);
    F.furn.push({ id: bays[i].id, s: chairShape(p.chair) }); if (p.table) F.furn.push({ id: bays[i].id, s: { t: 'c', x: p.table.c[0], y: p.table.c[1], r: p.table.c[2] } });
  }
  const bb = contentBox(m, S, B), box = { x0: bb.x0 - PAD, y0: bb.y0 - PAD, x1: bb.x1 + PAD, y1: bb.y1 + PAD };
  const [tw, th] = tagSize(box.x1 - box.x0), [pw, ph] = tagSize(box.x1 - box.x0, PANE_D), X = { S, B, box, tw, th, pw, ph, tags: B.map(o => o.b.tag ? [...o.b.tag] : null) };
  placeTags(X);
  for (const t of X.tags) if (t) join(box, inflate(cbox(t[0], t[1], tw, th), 4));
  const out = { box: { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 }, tag: [tw, th], bays: new Map(), curtains: new Map() };
  B.forEach((o, i) => out.bays.set(o.b.id, { ...o.p, tag: X.tags[i] }));
  for (const c of m.items) if (c.k === 'curtain' || (c.k === 'path' && c.layer === 'curtain')) out.curtains.set(c.id, c.bays ? c.bays.filter(id => bays.some(b => b.id === id)) : autoCurtainBays(m, c, S));
  memo.unshift({ key, val: out }); if (memo.length > 4) memo.pop();
  return out;
}
// Bounds of everything drawn (tags excluded; they are fitted inside afterwards).
function contentBox(m, S, B){
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const w of S.walls) for (const p of w.pts) grow(b, p[0], p[1], w.th / 2);
  for (const x of S.curts) for (const p of x.pts) grow(b, p[0], p[1], 3);
  for (const x of [...S.doors, ...S.wins, ...S.labels]) join(b, x.box);
  for (const f of S.furn) join(b, shapeBox(f.s));
  for (const o of B){ grow(b, o.b.x, o.b.y, o.b.r); join(b, shapeBox(chairShape(o.p.chair))); if (o.p.table) grow(b, o.p.table.c[0], o.p.table.c[1], o.p.table.c[2]); if (o.p.lamp) grow(b, o.p.lamp[0], o.p.lamp[1], 8); }
  return isFinite(b.x0) ? b : { x0: 0, y0: 0, x1: 100, y1: 60 };
}
// Resolved parts for one bay as given (an edited copy replaces the stored one; a new bay need not be in the model yet,
// which is what the placement preview wants).
function autoBay(m, bay){
  const id = bay.id || '__new', b = { ...bay, id };
  return layout({ ...m, items: byId(m, id) ? m.items.map(i => i.id === id ? b : i) : [...m.items, b] }).bays.get(id);
}
// The nearest bay on each side of a track (within 2.2 r, and alongside it rather than past its ends): {1: bay, -1: bay}.
function besideOf(m, pl){
  const out = {}, D = {}; let W = null;
  for (const b of m.items) if (b.k === 'bay'){
    let best = null; for (let i = 1; i < pl.length; i++){ const r = segNear([b.x, b.y], pl[i - 1], pl[i]); if (!best || r.d < best.d) best = { ...r, i }; }
    if (!best || best.d > 2.2 * b.r || (best.i === 1 && best.t <= 0) || (best.i === pl.length - 1 && best.t >= 1)) continue;
    const q = [best.q[0] + (b.x - best.q[0]) * 2 / (best.d || 1), best.q[1] + (b.y - best.q[1]) * 2 / (best.d || 1)];
    if ((W = W || wallLines(m)).some(w => w.pts.some((p, k) => k > 0 && segX([b.x, b.y], q, w.pts[k - 1], p)))) continue;   // not through a wall
    const s = sideOf([b.x, b.y], pl); if (!out[s] || best.d < D[s]){ out[s] = b; D[s] = best.d; }
  }
  return out;
}
// Bays a curtain screens: any rug that comes within 0.6 r of its track, and the nearest bay on each side of it, so a curtain
// drawn between two neighbours screens both even when it isn't quite in the middle.
function autoCurtainBays(m, c, S = null){
  const L = c.k === 'path' ? flattenPath(c.d) : [polyOf(c)], ids = new Set();
  for (const pl of L){ for (const b of m.items) if (b.k === 'bay' && distPoly([b.x, b.y], pl) <= 1.6 * b.r) ids.add(b.id);
    if (pl.length > 1){ const s = besideOf(m, pl); for (const k of [1, -1]) if (s[k]) ids.add(s[k].id); } }
  return m.items.filter(b => b.k === 'bay' && ids.has(b.id)).map(b => b.id);
}

// ---------- snapping ----------
// Snap a pointer: to a vertex or end (within tol), else lock the angle from `from` to 15° steps, then onto a wall line, else line up
// with another vertex (align:false skips it), else the grid. Returns {p, guides:[{k:'point',p}|{k:'angle',from,deg}|{k:'line',a,b}|{k:'align',a,b}]}.
function snap(m, p, o = {}){
  const tol = o.tol ?? SNAP, skip = new Set(o.skip || []), guides = [], g = o.grid === true ? m.grid || GRID : +o.grid || 0;
  const verts = [...(o.extra || [])];
  for (const it of m.items) if (!skip.has(it.id)){
    if ((it.k === 'wall' || it.k === 'curtain') && it.pts) verts.push(...it.pts);
    else if (it.k === 'path') verts.push(...pathVerts(it.d));
  }
  if (o.ends !== false){
    let best = null, bd = tol; for (const v of verts){ const d = dist(v, p); if (d <= bd){ bd = d; best = v; } }
    if (best) return { p: [best[0], best[1]], guides: [{ k: 'point', p: [best[0], best[1]] }] };
  }
  let q = [p[0], p[1]], lock = null, sx = false, sy = false;
  if (o.from && o.angle !== false && dist(o.from, p) > 1){
    const a = Math.round(deg(Math.atan2(p[1] - o.from[1], p[0] - o.from[0])) / 15) * 15, u = [Math.cos(rad(a)), Math.sin(rad(a))];
    const t = Math.max(0, (p[0] - o.from[0]) * u[0] + (p[1] - o.from[1]) * u[1]); q = [o.from[0] + u[0] * t, o.from[1] + u[1] * t];
    lock = { u, t }; guides.push({ k: 'angle', from: [...o.from], deg: normA(a) });
  }
  if (o.walls !== false){
    let best = null;
    for (const w of wallLines(m)) if (!skip.has(w.id)) for (let i = 1; i < w.pts.length; i++){
      const a = w.pts[i - 1], b = w.pts[i], r = segNear(q, a, b); if (r.d > tol || (best && r.d >= best.d)) continue;
      let at = r.q;
      if (lock){ const v = [b[0] - a[0], b[1] - a[1]], den = cross(lock.u, v); if (Math.abs(den) < 1e-9) continue;
        const ap = [a[0] - o.from[0], a[1] - o.from[1]], t = cross(ap, v) / den, k = cross(ap, lock.u) / den;
        if (k < 0 || k > 1 || t < 0) continue; at = [o.from[0] + lock.u[0] * t, o.from[1] + lock.u[1] * t]; if (dist(at, q) > tol * 1.5) continue; }
      best = { d: r.d, at, a, b };
    }
    if (best){ guides.push({ k: 'line', a: [...best.a], b: [...best.b] }); return { p: [rnd(best.at[0]), rnd(best.at[1])], guides }; }
  }
  if (!lock && o.align !== false){
    const at = tol * 0.6; let bx = null, by = null;
    for (const v of verts){ if (Math.abs(v[0] - q[0]) <= at && (!bx || Math.abs(v[0] - q[0]) < Math.abs(bx[0] - q[0]))) bx = v;
      if (Math.abs(v[1] - q[1]) <= at && (!by || Math.abs(v[1] - q[1]) < Math.abs(by[1] - q[1]))) by = v; }
    if (bx){ q[0] = bx[0]; sx = true; } if (by){ q[1] = by[1]; sy = true; }
    if (bx) guides.push({ k: 'align', a: [...bx], b: [...q] }); if (by) guides.push({ k: 'align', a: [...by], b: [...q] });
    if (g){ if (!sx) q[0] = Math.round(q[0] / g) * g; if (!sy) q[1] = Math.round(q[1] / g) * g; }
  } else if (!lock && g){ q = [Math.round(q[0] / g) * g, Math.round(q[1] / g) * g]; } else if (g){ const t = Math.round(lock.t / g) * g; q = [o.from[0] + lock.u[0] * t, o.from[1] + lock.u[1] * t]; }
  return { p: [rnd(q[0]), rnd(q[1])], guides };
}

// ---------- making things ----------
// The parts of a→b that no straight wall already runs along (so rooms drawn side by side share one wall, and a door
// between them cuts the only wall there). Returns [[from, to], …] in order.
function uncovered(m, a, b){
  const L = dist(a, b), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], cov = [];
  for (const w of wallLines(m)) for (let i = 1; i < w.pts.length; i++){
    const p = w.pts[i - 1], q = w.pts[i], v = [q[0] - p[0], q[1] - p[1]], lv = hyp(v[0], v[1]);
    if (lv < 1 || Math.abs(cross(u, v)) / lv > 0.02 || Math.abs(cross(u, [p[0] - a[0], p[1] - a[1]])) > 1.5) continue;
    const t0 = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1], t1 = (q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1];
    const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1)); if (hi - lo > 1) cov.push([lo, hi]);
  }
  cov.sort((x, y) => x[0] - y[0]); const out = []; let at = 0;
  for (const [lo, hi] of cov){ if (lo > at + 1) out.push([at, lo]); at = Math.max(at, hi); }
  if (at < L - 1) out.push([at, L]);
  const pt = t => [rnd(a[0] + u[0] * t), rnd(a[1] + u[1] * t)];
  return out.map(([s, e]) => [s < 1e-9 ? a : pt(s), e > L - 1e-9 ? b : pt(e)]);
}
// A rectangular room (clockwise, so doors swing inward by default) plus its name. Sides that an existing wall already covers
// are left out, so the room may come out as one or more open walls. Adds them; returns [wall, label, …more walls], or null
// if the box is too small or all its walls are already there.
function newRoom(m, x0, y0, x1, y1, name){
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  if (bx - ax < 32 || by - ay < 32) return null;
  const S = scene(m), cx = (ax + bx) / 2, above = [cx, ay - 24];
  const roomy = S.walls.every(w => distPoly(above, w.pts) > 28) && S.labels.every(l => boxDist(above, l.box) > 12);
  const n = m.items.filter(i => i.k === 'label').length + 1, C = [[ax, ay], [bx, ay], [bx, by], [ax, by]];
  const parts = C.map((p, i) => uncovered(m, p, C[(i + 1) % 4])), whole = parts.every((P, i) => P.length === 1 && P[0][0] === C[i] && P[0][1] === C[(i + 1) % 4]);
  let lines = [];
  if (whole) lines = [C];
  else {
    for (const [s, e] of parts.flat()){ const L = lines[lines.length - 1]; if (L && dist(L[L.length - 1], s) < 0.01) L.push(e); else lines.push([s, e]); }
    if (lines.length > 1 && dist(lines[lines.length - 1].slice(-1)[0], lines[0][0]) < 0.01) lines[0] = [...lines.pop(), ...lines[0].slice(1)];
  }
  if (!lines.length) return null;
  const walls = lines.map(pts => add(m, { id: '', k: 'wall', pts: pts.map(p => [p[0], p[1]]), bend: pts.map(() => 0), closed: whole, thin: false }));
  // The name goes above the room; when another room is there it goes inside, in the middle of a shallow room such as a hallway.
  const label = add(m, { id: '', k: 'label', t: name || `Room ${n}`, x: cx, y: roomy ? ay - 24 : by - ay < 8 * UNIT ? (ay + by) / 2 : ay + 24, small: false });
  return [walls[0], label, ...walls.slice(1)];
}
// Slide any room name a new door swings over to the nearest clear spot (along the room first), so it stays readable.
function clearLabels(m, door){
  const d = doorD(m, door) || windowD(m, door); if (!d) return;
  const z = inflate(bbox(flattenPath(d).flat()), 2), S = scene(m), cand = [];
  for (let k = 1; k <= 20; k++) cand.push([k * 8, 0], [-k * 8, 0]);
  for (let k = 1; k <= 3; k++) cand.push([0, k * 8], [0, -k * 8]);
  cand.sort((a, b) => hyp(a[0], a[1]) - hyp(b[0], b[1]));
  for (const l of m.items) if (l.k === 'label' && boxHit(labelBox(l), z)){
    const free = (x, y) => { const b = labelBox({ ...l, x, y });
      return !S.doors.some(o => boxHit(b, o.box)) && !S.walls.some(w => polyBox(w.pts, inflate(b, w.th / 2 + 2))) && !S.labels.some(o => o.id !== l.id && boxHit(b, o.box)); };
    const f = cand.find(([dx, dy]) => free(l.x + dx, l.y + dy)); if (f){ l.x += f[0]; l.y += f[1]; }
  }
}
// A wall or curtain from points (straight segments). Not added. Given the model, a curtain drawn from its open end toward a
// wall is turned round (rev), so it still bunches against the wall.
function newLine(k, pts, closed = false, m = null){
  if (k !== 'curtain') return { id: '', k: 'wall', pts: clone(pts), bend: pts.map(() => 0), closed: !!closed && pts.length > 2, thin: false };
  const on = p => !!m && wallLines(m).some(w => distPoly(p, w.pts) <= w.th / 2 + 2);
  return { id: '', k, pts: clone(pts), bend: pts.map(() => 0), bays: null, rev: pts.length > 1 && !on(pts[0]) && on(pts[pts.length - 1]) };
}
// Push a counter, sink, cabinet or desk flat against the wall it was dropped near.
function hugWall(m, it){
  const S = scene(m); let best = null;
  for (const w of S.walls) for (let i = 1; i < w.pts.length; i++){ const r = segNear([it.x, it.y], w.pts[i - 1], w.pts[i]); if (!best || r.d < best.d) best = { ...r, a: w.pts[i - 1], b: w.pts[i], th: w.th }; }
  if (!best || best.d > it.h * 1.5 + 16 || best.d < 1e-6) return it;
  const ang = deg(Math.atan2(best.b[1] - best.a[1], best.b[0] - best.a[0])), off = best.th / 2 + it.h / 2 + 1;
  it.a = normA(Math.round(((ang % 180) + 270) % 180 - 90));
  it.x = rnd(best.q[0] + (it.x - best.q[0]) / best.d * off); it.y = rnd(best.q[1] + (it.y - best.q[1]) / best.d * off);
  return it;
}
// Any single-spot item with sensible sizes (chair, table, counter, desk, sink, cabinet, label, bay). Not added.
function newItem(m, k, x, y, o = {}){
  if (k === 'bay') return newBay(m, x, y, o);
  if (k === 'chair') return { id: '', k, x, y, a: o.a ?? faceWall(m, x, y) };
  if (k === 'table') return { id: '', k, shape: o.shape || 'round', x, y, s: o.s || 44, a: 0 };
  if (k === 'label') return { id: '', k, t: o.t ?? 'Room', x, y, small: !!o.small };
  if (FURN[k]) return hugWall(m, { id: '', k, x, y, w: o.w || FURN[k].w, h: o.h || FURN[k].h, a: o.a || 0 });
  return null;
}

// ---------- editing ----------
// Move items by dx, dy. Doors and windows ride on their wall; pinned tags ride with their bay.
function moveItems(m, ids, dx, dy){
  const set = new Set(ids);
  for (const it of m.items) if (set.has(it.id)) shift(it, dx, dy);
  return m;
}
// One item moved in place (shared by moving, pasting and the export crop).
function shift(it, dx, dy){
  if (it.pts) it.pts = it.pts.map(p => [p[0] + dx, p[1] + dy]);
  else if (it.k === 'path') it.d = movePath(it.d, dx, dy);
  else if (it.x != null){ it.x += dx; it.y += dy; if (it.k === 'bay' && it.tag) it.tag = [it.tag[0] + dx, it.tag[1] + dy]; }
}
const moveModel = (m, dx, dy) => { const c = clone(m); for (const it of c.items) shift(it, dx, dy); return c; };
// Turn items by d degrees about a point (default: the middle of the selection). A single bay turns in place.
function rotateItems(m, ids, d, about){
  const sel = m.items.filter(i => ids.includes(i.id)); if (!sel.length) return m;
  const L = layout(m), bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; for (const it of sel) join(bb, itemBox(m, it, L));
  const c = about || [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2], one = sel.length === 1 && sel[0].x != null && !about;
  for (const it of sel){
    if (it.pts) it.pts = it.pts.map(p => rot(p, c, d));
    else if (it.k === 'path') it.d = mapPath(it.d, p => rot(p, c, d), d);
    else if (it.x != null){
      const q = one ? [it.x, it.y] : rot([it.x, it.y], c, d), dx = q[0] - it.x, dy = q[1] - it.y; it.x = q[0]; it.y = q[1];
      if ('a' in it) it.a = normA((it.a || 0) + d);
      if (it.k === 'bay'){ if (it.tag) it.tag = [it.tag[0] + dx, it.tag[1] + dy];
        if (it.chair) it.chair = rot(it.chair, [0, 0], d); if (it.table){ const v = rot(it.table, [0, 0], d); it.table = [v[0], v[1], it.table[2]]; } }
    }
  }
  return m;
}
// Delete items; walls take their doors and windows with them, and bays drop out of curtain lists.
function remove(m, ids){
  const gone = new Set(ids);
  for (const it of m.items) if (isOpening(it) && gone.has(it.wall)) gone.add(it.id);
  m.items = m.items.filter(it => !gone.has(it.id));
  // A hand-picked curtain list that loses its last bay goes back to automatic rather than screening nothing.
  for (const c of m.items) if (c.bays){ const b = c.bays.filter(id => !gone.has(id)); if (b.length < c.bays.length) c.bays = b.length ? b : null; }
  return m;
}
// Paste copies of items, offset by dx, dy. Returns the new ids. Bays get fresh numbers if theirs are taken; doors come along
// only with their wall; curtain links follow copied bays (else the curtain goes back to automatic).
function paste(m, items, dx = 16, dy = 16){
  const map = new Map(), out = [], src = clone(items).filter(it => !isOpening(it) || items.some(w => w.id === it.wall));
  for (const it of src.filter(i => !isOpening(i))){ const old = it.id; it.id = '';
    if (it.k === 'bay'){ const no = String(it.no ?? '').trim().toLowerCase(); if (!no || m.items.some(b => b.k === 'bay' && String(b.no).trim().toLowerCase() === no)) it.no = nextBayNo(m); }
    shift(it, dx, dy); add(m, it, false); map.set(old, it.id); out.push(it.id); }
  for (const it of src.filter(isOpening)){ it.id = ''; it.wall = map.get(it.wall); add(m, it, false); out.push(it.id); }
  for (const id of out){ const c = byId(m, id); if (c.bays){ const b = c.bays.map(x => map.get(x)).filter(Boolean); c.bays = b.length ? b : null; } }
  return out;
}
const dup = (m, ids, dx = 16, dy = 16) => paste(m, m.items.filter(i => ids.includes(i.id) || (isOpening(i) && ids.includes(i.wall))), dx, dy);
// Doors on a wall, where they sit in the drawing, so they can be put back after its points change.
const openingsAt = (m, w) => m.items.filter(o => isOpening(o) && o.wall === w.id).map(o => { const G = openingGeo(m, o); return { o, p: G ? [(G.g0[0] + G.g1[0]) / 2, (G.g0[1] + G.g1[1]) / 2] : null }; });
// Put each door back on whichever straight segment now runs through where it was; drop any that no longer fit.
function reattach(m, w, before){
  const S = segsOf(w), drop = [];
  for (const { o, p } of before){
    if (!p) continue;
    let best = null; for (const g of S) if (!g.s){ const r = segNear(p, g.a, g.b); if (r.d < 2 && (!best || r.d < best.d)) best = { g, r }; }
    const fit = best && doorFit(m, w.id, best.g.i, best.r.t, o.w, o.id);
    if (fit && fit.ok){ o.seg = best.g.i; o.t = fit.t; } else drop.push(o.id);
  }
  if (drop.length) remove(m, drop);
  return drop;
}
// Add a corner to a wall or curtain on segment seg at p (a curved segment keeps its curve on both halves).
function insertVertex(m, id, seg, p){
  const w = byId(m, id); if (!w || !w.pts) return m;
  const g = segsOf(w)[seg]; if (!g) return m;
  const before = w.k === 'wall' ? openingsAt(m, w) : [];
  let q = p, s1 = 0, s2 = 0;
  if (g.arc){ const A = g.arc, ang = Math.atan2(p[1] - A.cy, p[0] - A.cx); const T = 2 * Math.PI; let d = ang - A.a0;
    d = A.sweep > 0 ? ((d % T) + T) % T : -((((-d) % T) + T) % T); const u = clamp(d / A.sweep, 0.05, 0.95);
    q = A.at(u); const h = (f) => Math.sign(g.s) * A.r * (1 - Math.cos(Math.abs(A.sweep) * f / 2)); s1 = rnd(h(u)); s2 = rnd(h(1 - u)); }
  w.pts.splice(seg + 1, 0, [rnd(q[0]), rnd(q[1])]); w.bend = w.bend || w.pts.map(() => 0); w.bend.splice(seg, 1, s1, s2);
  while (w.bend.length > w.pts.length) w.bend.pop();
  if (w.k === 'wall') reattach(m, w, before);
  return m;
}
// Remove a corner. A wall or curtain left with too few points is deleted.
function removeVertex(m, id, i){
  const w = byId(m, id); if (!w || !w.pts) return m;
  if (w.pts.length <= (w.closed ? 3 : 2)) return remove(m, [id]);
  const before = w.k === 'wall' ? openingsAt(m, w) : [];
  const old = new Map(segsOf(w).map(g => [`${g.a}|${g.b}`, g.s]));
  w.pts.splice(i, 1); w.bend = w.pts.map(() => 0);
  for (const g of segsOf(w)) w.bend[g.i] = old.get(`${g.a}|${g.b}`) || 0;
  if (w.closed && w.pts.length < 3) w.closed = false;
  if (w.k === 'wall') reattach(m, w, before);
  return m;
}
// Move one corner. Doors on the two segments that meet there keep their share of the segment's length, then slide back
// inside it if it got shorter (a door that still can't fit is left for the checklist to flag).
function moveVertex(m, id, i, p){
  const w = byId(m, id); if (!w || !w.pts || !w.pts[i]) return m;
  w.pts[i] = [p[0], p[1]];
  if (w.k !== 'wall') return m;
  const n = segsOf(w).length, segs = new Set([i - 1, i].map(s => w.closed && w.pts.length > 2 ? (s + n) % n : s).filter(s => s >= 0 && s < n));
  for (const o of m.items) if (isOpening(o) && o.wall === w.id && segs.has(o.seg)){ const f = doorFit(m, w.id, o.seg, o.t, o.w, o.id); if (f.ok) o.t = f.t; }
  return m;
}

// ---------- hit testing ----------
// Which segment of a wall or curtain is nearest p (curves included): {seg, d, q} or null. The page uses it to add corners.
function nearSeg(it, p){
  let best = null;
  for (const g of segsOf(it)){ const pts = segPts(g);
    for (let i = 1; i < pts.length; i++){ const r = segNear(p, pts[i - 1], pts[i]); if (!best || r.d < best.d) best = { seg: g.i, d: r.d, q: r.q }; } }
  return best;
}
// Bounding box of an item in drawing units (bays include their chair and table).
function itemBox(m, it, L = null){
  if (it.k === 'wall' || it.k === 'curtain') return inflate(bbox(polyOf(it)), it.k === 'wall' ? (it.thin ? THIN : WALL) / 2 : 3);
  if (isOpening(it)){ const d = it.k === 'door' ? doorD(m, it) || windowD(m, it) : windowD(m, it); return d ? inflate(bbox(flattenPath(d).flat()), 2) : { x0: 0, y0: 0, x1: 0, y1: 0 }; }
  if (it.k === 'path') return inflate(bbox(flattenPath(it.d).flat()), it.layer === 'wall' ? 4 : 2);
  if (it.k === 'label') return labelBox(it);
  if (it.k === 'bay'){ const b = cbox(it.x, it.y, 2 * it.r, 2 * it.r), p = (L || layout(m)).bays.get(it.id); if (p){ join(b, shapeBox(chairShape(p.chair))); if (p.table) join(b, cbox(p.table.c[0], p.table.c[1], 2 * p.table.c[2], 2 * p.table.c[2])); } return b; }
  return shapeBox(furnShape(it));
}
// Topmost item under p (labels, doors and furniture first; walls last), or null.
function hit(m, p, tol = 6){
  const L = layout(m), rank = { label: 0, door: 1, window: 1, chair: 2, table: 2, counter: 3, desk: 3, sink: 3, cabinet: 3, bay: 4, curtain: 5, wall: 6, path: 7 };
  const near = it => {
    if (it.k === 'label') return inBox(p, inflate(labelBox(it), tol));
    if (isOpening(it)){ const d = (it.k === 'door' ? doorD(m, it) : '') + windowD(m, it); return !!d && (flattenPath(d).some(pl => distPoly(p, pl) <= tol + 5) || inBox(p, itemBox(m, it, L))); }   // the gap in the wall counts, so a door can be grabbed where it cuts the wall
    if (it.k === 'bay'){ const x = L.bays.get(it.id); return dist(p, [it.x, it.y]) <= it.r + tol || (x && (inShape(chairShape(x.chair), p[0], p[1], tol) || (x.table && dist(p, x.table.c) <= x.table.c[2] + tol))); }
    if (it.k === 'wall') return distPoly(p, polyOf(it)) <= (it.thin ? THIN : WALL) / 2 + tol;
    if (it.k === 'curtain') return distPoly(p, polyOf(it)) <= tol + 2;
    if (it.k === 'path') return flattenPath(it.d).some(pl => distPoly(p, pl) <= tol + (it.layer === 'wall' ? 4 : 2));
    return inShape(furnShape(it), p[0], p[1], tol);
  };
  let best = null;
  m.items.forEach((it, i) => { if (rank[it.k] == null || !near(it)) return; const r = rank[it.k] * 1e5 - i; if (!best || r < best.r) best = { r, id: it.id }; });
  return best ? best.id : null;
}
// Items wholly inside a marquee box {x0,y0,x1,y1} (doors and windows are picked through their wall).
function marquee(m, b){ const L = layout(m); return m.items.filter(it => !isOpening(it)).filter(it => { const x = itemBox(m, it, L); return x.x0 >= b.x0 && x.y0 >= b.y0 && x.x1 <= b.x1 && x.y1 <= b.y1; }).map(i => i.id); }
// Plain name for an item, for the inspector and the checklist.
function itemName(m, it){
  if (!it) return '';
  if (it.k === 'bay') return `Bay ${String(it.no ?? '').trim() || '(no number)'}`;
  if (it.k === 'label') return `Label “${it.t}”`;
  if (it.k === 'path') return { wall: 'Wall from the old map', door: 'Door from the old map', window: 'Window from the old map', curtain: 'Curtain from the old map' }[it.layer];
  return NAMES[it.k] || it.k;
}

// ---------- export / import ----------
// The render.js plan for a model, in the model's own coordinates (the page draws this; exportPlan crops and stamps it).
function planOf(m, L = layout(m)){
  const bays = m.items.filter(i => i.k === 'bay'), no = new Map(bays.map(b => [b.id, String(b.no ?? '').trim()])), rp = p => p && [rnd(p[0]), rnd(p[1])];
  const plan = { schema: R.BP_SCHEMA, v: 1, name: m.name || '', clinic: m.clinic || '', savedAt: '', savedBy: '', w: rnd(L.box.w), h: rnd(L.box.h),
    bays: [], curtains: [], walls: [], doors: [], windows: [], tables: [], chairs: [], rooms: [] };
  for (const b of bays){ const x = L.bays.get(b.id);
    plan.bays.push({ id: no.get(b.id), cx: rnd(b.x), cy: rnd(b.y), r: rnd(b.r), tag: rp(x.tag), lamp: rp(x.lamp) });
    if (x.table) plan.tables.push({ c: [rnd(x.table.c[0]), rnd(x.table.c[1]), rnd(x.table.c[2])] });
    plan.chairs.push([rnd(x.chair[0]), rnd(x.chair[1]), rnd(normA(x.chair[2]))]); }
  for (const it of m.items){
    const ids = () => (L.curtains.get(it.id) || []).map(id => no.get(id)).filter(Boolean);
    if (it.k === 'wall'){ const d = wallD(m, it); if (d) plan.walls.push(it.thin ? { d, thin: true } : { d }); }
    else if (it.k === 'door'){ const d = doorD(m, it); if (d) plan.doors.push({ d }); }
    else if (it.k === 'window'){ const d = windowD(m, it); if (d) plan.windows.push({ d }); }
    else if (it.k === 'curtain' && it.pts.length > 1){ const pts = it.rev ? [...it.pts].reverse() : it.pts, bend = it.rev ? [...it.bend.slice(0, it.pts.length - 1)].reverse().map(s => -s) : it.bend;
      plan.curtains.push({ d: lineD(pts, bend, false), bays: ids() }); }
    else if (it.k === 'path'){ const d = pathStr(parsePath(it.d));
      if (it.layer === 'curtain') plan.curtains.push({ d, bays: ids() }); else if (it.layer === 'wall') plan.walls.push(it.thin ? { d, thin: true } : { d }); else plan[it.layer + 's'].push({ d }); }
    else if (it.k === 'chair') plan.chairs.push([rnd(it.x), rnd(it.y), rnd(normA(it.a || 0))]);
    else if (it.k === 'table'){ if (it.shape === 'square') plan.tables.push(rect(it.x, it.y, it.s, it.s, 8, it.a)); else plan.tables.push({ c: [rnd(it.x), rnd(it.y), rnd(it.s / 2)] }); }
    else if (FURN[it.k]) plan.tables.push(rect(it.x, it.y, it.w, it.h, it.k === 'sink' ? Math.min(it.w, it.h) * 0.3 : FURN[it.k].rx, it.a));
    else if (it.k === 'label' && String(it.t || '').trim()) plan.rooms.push(it.small ? { t: String(it.t).trim(), x: rnd(it.x), y: rnd(it.y), small: true } : { t: String(it.t).trim(), x: rnd(it.x), y: rnd(it.y) });
  }
  return plan;
}
const rect = (x, y, w, h, rx, a) => { const o = { rect: [rnd(x - w / 2), rnd(y - h / 2), rnd(w), rnd(h), rnd(rx)] }; if (a && rnd(normA(a))) o.a = rnd(normA(a)); return o; };
// The file the tracker reads: cropped to the drawing plus padding (moved so the box starts at 0,0), rounded, stamped, with the
// edit model (moved the same way) so the map reopens exactly. The crop moves by whole grid steps, so a reopened map's walls
// stay on the grid that new things snap to. o = {savedAt, savedBy}.
function exportPlan(model, o = {}){
  const m = cleanModel(model) || clone(model), L = layout(m), g = m.grid || GRID;
  let x0 = Math.floor(L.box.x / g) * g, y0 = Math.floor(L.box.y / g) * g, W = Math.ceil(L.box.x + L.box.w) - x0, H = Math.ceil(L.box.y + L.box.h) - y0;
  if (W < 100){ const s = Math.ceil((100 - W) / 2 / g) * g; x0 -= s; W = Math.max(100, W + s); }
  if (H < 60){ const s = Math.ceil((60 - H) / 2 / g) * g; y0 -= s; H = Math.max(60, H + s); }
  const mt = moveModel(m, -x0, -y0), Lt = { box: { x: 0, y: 0, w: W, h: H }, tag: L.tag, curtains: L.curtains, bays: new Map() };
  const sp = p => p && [p[0] - x0, p[1] - y0];
  for (const [id, x] of L.bays) Lt.bays.set(id, { chair: [x.chair[0] - x0, x.chair[1] - y0, x.chair[2]], table: x.table && { c: [x.table.c[0] - x0, x.table.c[1] - y0, x.table.c[2]] }, lamp: sp(x.lamp), tag: sp(x.tag) });
  const plan = planOf(mt, Lt);
  return { ...plan, w: W, h: H, savedAt: o.savedAt ?? new Date().toISOString(), savedBy: str(o.savedBy || '', 80), edit: mt };
}
// A model from a plan file: its own edit model when present and sound, else its drawing turned into movable shapes and bays
// (so the built-in map or any map from the tracker can be edited). Chairs and tables found on a rug are pinned to that bay.
function importPlan(plan){
  const e = plan && cleanModel(plan.edit); if (e) return e;
  const ok = R.bpCheck(plan); if (ok.err) return null;
  const p = ok.plan, m = newModel(p.name, p.clinic), chairs = p.chairs.map(c => ({ c, used: false })), tables = p.tables.map(t => ({ t, used: false })), idOf = new Map();
  for (const b of p.bays){
    const it = { id: '', k: 'bay', no: b.id, x: b.cx, y: b.cy, r: b.r, a: 0, side: 'auto', tag: [...b.tag], chair: null, table: null };
    const ch = chairs.filter(x => !x.used && dist(x.c, [b.cx, b.cy]) <= b.r).sort((x, y) => dist(x.c, [b.cx, b.cy]) - dist(y.c, [b.cx, b.cy]))[0];
    if (ch){ ch.used = true; it.a = ch.c[2]; it.chair = [ch.c[0] - b.cx, ch.c[1] - b.cy]; }
    if (b.lamp){ const tb = tables.find(x => !x.used && x.t.c && dist(x.t.c, b.lamp) < 2);
      if (tb) tb.used = true; it.table = [b.lamp[0] - b.cx, b.lamp[1] - b.cy, tb ? tb.t.c[2] : 0];
      const v = [b.lamp[0] - (ch ? ch.c[0] : b.cx), b.lamp[1] - (ch ? ch.c[1] : b.cy)], pr = pright(it.a); it.side = v[0] * pr[0] + v[1] * pr[1] >= 0 ? 'right' : 'left';
    } else it.side = 'none';
    add(m, it); idOf.set(b.id.toLowerCase(), it.id);
  }
  for (const w of p.walls) add(m, w.thin ? { id: '', k: 'path', layer: 'wall', d: w.d, thin: true } : { id: '', k: 'path', layer: 'wall', d: w.d });
  for (const d of p.doors) add(m, { id: '', k: 'path', layer: 'door', d: d.d });
  for (const d of p.windows) add(m, { id: '', k: 'path', layer: 'window', d: d.d });
  for (const c of p.curtains) add(m, { id: '', k: 'path', layer: 'curtain', d: c.d, bays: c.bays.map(b => idOf.get(b.toLowerCase())).filter(Boolean) });
  for (const { t, used } of tables) if (!used){
    if (t.c) add(m, { id: '', k: 'table', shape: 'round', x: t.c[0], y: t.c[1], s: 2 * t.c[2], a: 0 });
    else { const [x, y, w, h] = t.rect, cx = x + w / 2, cy = y + h / 2;
      add(m, Math.abs(w - h) < 1 && w <= 64 ? { id: '', k: 'table', shape: 'square', x: cx, y: cy, s: w, a: t.a || 0 } : { id: '', k: 'counter', x: cx, y: cy, w, h, a: t.a || 0 }); } }
  for (const { c, used } of chairs) if (!used) add(m, { id: '', k: 'chair', x: c[0], y: c[1], a: c[2] });
  for (const r of p.rooms) add(m, { id: '', k: 'label', t: r.t, x: r.x, y: r.y, small: !!r.small });
  return m;
}

// ---------- checklist ----------
// Problems a practice lead should fix before saving, in plain words: {level:'error'|'warn'|'tip', msg, ids}. Errors block saving.
function check(m){
  const out = [], put = (level, msg, ids = []) => out.push({ level, msg, ids });
  const bays = m.items.filter(i => i.k === 'bay'), name = b => `bay ${String(b.no ?? '').trim()}`, Name = b => `Bay ${String(b.no ?? '').trim()}`;
  if (!bays.length) put('error', 'Add at least one bay. Pick Bay (B) and click inside a room.');
  const seen = new Map();
  for (const b of bays){ const no = String(b.no ?? '').trim();
    if (!no){ put('error', 'A bay has no number. Select it and type its number on the right.', [b.id]); continue; }
    if (!BAY_RE.test(no) || /^bay/i.test(no)){ put('error', `Bay number “${no}” can’t be used. Use up to 8 letters or digits, like 4 or 2A.`, [b.id]); continue; }
    const k = no.toLowerCase(); seen.set(k, [...(seen.get(k) || []), b]); }
  for (const L of seen.values()) if (L.length > 1) put('error', `${L.length === 2 ? 'Two' : L.length} bays are numbered ${String(L[0].no).trim()}. Give each bay its own number.`, L.map(b => b.id));
  const S = scene(m), hasWalls = S.walls.length > 0;
  if (!hasWalls) put('warn', 'No walls yet. Use Room (R) to draw each room, or Wall (W) for odd shapes.');
  else if (!m.items.some(i => i.k === 'door' || (i.k === 'path' && i.layer === 'door'))) put('warn', 'There’s no door yet. Pick Door (D) and click on a wall.');
  for (const o of m.items.filter(isOpening)){ const r = openingSeg(m, o); if (r.err) put('error', r.err, [o.id]); }
  const ops = m.items.filter(o => isOpening(o) && !openingSeg(m, o).err);
  for (let i = 0; i < ops.length; i++) for (let j = i + 1; j < ops.length; j++){ const a = ops[i], b = ops[j];
    if (a.wall === b.wall && a.seg === b.seg){ const L = openingSeg(m, a).g.len; if (Math.abs(a.t - b.t) * L < (a.w + b.w) / 2) put('warn', 'Two doors or windows overlap on the same wall. Slide one along the wall.', [a.id, b.id]); } }
  // A door gap or swing that meets any other wall (one that ends in the doorway, or a curved neighbour the leaf passes through).
  const segLines = pl => pl.slice(1).map((p, i) => [pl[i], p]);
  for (const o of ops){
    const G = openingGeo(m, o), W = byId(m, o.wall), mine = [[G.g0, G.g1], ...(o.k === 'door' ? flattenPath(doorD(m, o)).flatMap(segLines) : [])];
    const other = [...S.walls.filter(w => w.id !== o.wall).flatMap(w => segLines(w.pts)), ...segsOf(W).filter(g => g.i !== o.seg).flatMap(g => segLines(segPts(g)))];
    if (mine.some(([p, q]) => other.some(([r, s]) => segX(p, q, r, s))))
      put('warn', o.k === 'door' ? 'This door runs into a wall. Swing it the other way (F) or slide it along the wall.' : 'This window runs into another wall. Slide it along the wall.', [o.id]);
  }
  for (const l of S.labels){ const d = S.doors.find(d => interArea(inflate(d.box, -2), l.box) > 0);
    if (d) put('warn', `The name “${String(byId(m, l.id).t).trim()}” is under a door. Drag it clear of the door.`, [l.id, d.id]); }
  const L = layout(m), [tw, th] = L.tag, tb = b => { const t = L.bays.get(b.id).tag; return cbox(t[0], t[1], tw, th); };
  for (let i = 0; i < bays.length; i++) for (let j = i + 1; j < bays.length; j++){ const a = bays[i], b = bays[j];
    if (dist([a.x, a.y], [b.x, b.y]) < a.r + b.r - 2) put('warn', `${Name(a)} and ${name(b)} overlap. Move them apart or pick a smaller rug.`, [a.id, b.id]);
    const xa = L.bays.get(a.id), xb = L.bays.get(b.id);
    if (xa.table && xb.table && dist(xa.table.c, xb.table.c) < xa.table.c[2] + xb.table.c[2] - 1) put('warn', `${Name(a)}’s side table runs into ${name(b)}’s. Put one table on the other side.`, [a.id, b.id]);
    else for (const [p, q, xp, xq] of [[a, b, xa, xb], [b, a, xb, xa]]) if (xp.table && shapeDist(chairShape(xq.chair), xp.table.c) < xp.table.c[2] - 1){
      put('warn', `${Name(p)}’s side table runs into ${name(q)}’s chair. Put the table on the other side, or move the bays apart.`, [p.id, q.id]); break; } }
  for (const b of bays){ const x = L.bays.get(b.id);
    if (x.table && S.curts.some(c => distPoly(x.table.c, c.pts) < x.table.c[2] - 1)) put('warn', `${Name(b)}’s side table sits on a curtain. Set its side table to None, or move the curtain.`, [b.id]);
    if (S.walls.some(w => distPoly([b.x, b.y], w.pts) < b.r + w.th / 2 - 1)) put('warn', `${Name(b)} sits on a wall. Drag it into the room.`, [b.id]);
    else if (S.walls.some(w => w.pts.some((p, k) => k > 0 && segShape(w.pts[k - 1], p, chairShape(x.chair), w.th / 2)))) put('warn', `${Name(b)}’s chair goes through a wall. Turn the chair or move the bay away from the wall.`, [b.id]);
    if (x.table && S.walls.some(w => distPoly(x.table.c, w.pts) < x.table.c[2] + w.th / 2 - 1)) put('warn', `${Name(b)}’s side table goes through a wall. Put the table on the other side.`, [b.id]);
    const swing = S.doors.find(d => { const z = inflate(d.box, -4); return boxDist([b.x, b.y], z) < b.r - 2 || (x.table && boxDist(x.table.c, z) < x.table.c[2]) || cover(z, chairShape(x.chair)) > 0; });
    if (swing) put('warn', `${Name(b)} is in the way of a door. Move the bay, or swing the door the other way (F).`, [b.id, swing.id]);
    if (b.r < 44) put('warn', `${Name(b)}’s rug is smaller than the recliner. Use size M or larger.`, [b.id]);
    else if (b.r > 100) put('tip', `${Name(b)}’s rug is very large. Size L is usually enough.`, [b.id]); }
  // Label problems at one tag size: labels overlapping, a label over another bay's rug, a label across a wall.
  const tagHits = (tw, th) => { const out = [], box = b => { const t = L.bays.get(b.id).tag; return cbox(t[0], t[1], tw, th); };
    for (let i = 0; i < bays.length; i++){ const a = bays[i], A = box(a);
      for (let j = 0; j < bays.length; j++){ if (j === i) continue; const b = bays[j];
        if (j > i && interArea(A, box(b)) > 0.04 * tw * th) out.push({ k: 'tags', a, b });
        let n = 0; for (let k = 0; k < 24; k++) if (inBox([b.x + Math.cos(k * Math.PI / 12) * b.r * 0.8, b.y + Math.sin(k * Math.PI / 12) * b.r * 0.8], A)) n++;
        if (n >= 3 && cover(A, { t: 'c', x: b.x, y: b.y, r: b.r }) > 0.05) out.push({ k: 'rug', a, b }); }
      if (S.walls.some(w => polyBox(w.pts, inflate(A, w.th / 2)))) out.push({ k: 'wall', a }); }
    return out; };
  const key = x => `${x.k}|${x.a.id}|${x.b ? x.b.id : ''}`, main = tagHits(tw, th), crowd = [];
  for (const x of main){
    if (x.k === 'wall') put('warn', `${Name(x.a)}’s label sits across a wall. Drag it into the room, or choose Reset to automatic.`, [x.a.id]);
    else crowd.push(['warn', x.k === 'tags' ? `The labels for ${name(x.a)} and ${name(x.b)} overlap. Drag one, or choose Reset to automatic.` : `${Name(x.a)}’s label covers ${name(x.b)}. Drag the label, or choose Reset to automatic.`, [x.a.id, x.b.id]]); }
  for (const b of bays){ const x = L.bays.get(b.id), A = tb(b);
    if (x.lamp && boxDist(x.lamp, A) < 3) crowd.push(['warn', `${Name(b)}’s label covers its lantern, so staff can’t see it light up. Drag the label, or choose Reset to automatic.`, [b.id]]);
    else if (chairCover(A, x.chair) > 0.1) crowd.push(['warn', `${Name(b)}’s label covers its own chair. Drag the label, or choose Reset to automatic.`, [b.id]]);
    if (S.curts.some(c => c.pts.some((p, k) => k > 0 && segX([b.x, b.y], x.tag, c.pts[k - 1], p)))) crowd.push(['warn', `${Name(b)}’s label is on the other side of a curtain, so it reads as the next bay’s. Drag it back, or choose Reset to automatic.`, [b.id]]); }
  if (crowd.length > 3) put('warn', 'Bay labels crowd each other. In the tracker the labels stay the same size while the map shrinks to fit, so a wide map gets crowded. Leave out rooms and hallways with no bays, or move bays further apart.', [...new Set(crowd.flatMap(x => x[2]))]);
  else for (const x of crowd) put(...x);
  // The Excel side pane draws the map about 300 px wide, where labels are larger for the map's size. Problems that only show there.
  const seenK = new Set(main.map(key)), [pw, ph] = tagSize(L.box.w, PANE_D), pane = tagHits(pw, ph).filter(x => !seenK.has(key(x)));
  if (pane.length > 3) put('warn', `In the Excel side pane the map is drawn small, so ${pane.length} bay labels run into each other, other bays or walls there. Move bays further apart, or leave out rooms with no bays. Preview › Task pane shows it.`, [...new Set(pane.flatMap(x => [x.a.id, ...(x.b ? [x.b.id] : [])]))]);
  else for (const x of pane){ const reset = x.a.tag || (x.k === 'tags' && x.b.tag) ? ', or choose Reset to automatic' : '';
    put('warn', `In the Excel side pane, ${x.k === 'tags' ? `the labels for ${name(x.a)} and ${name(x.b)} overlap. Drag one apart` : x.k === 'rug' ? `${name(x.a)}’s label covers ${name(x.b)}. Drag the label clear of it`
      : `${name(x.a)}’s label sits across a wall. Drag it into the room`}${reset}. Preview › Task pane shows it.`, [x.a.id, ...(x.b ? [x.b.id] : [])]); }
  for (const c of m.items) if ((c.k === 'curtain' || (c.k === 'path' && c.layer === 'curtain')) && !(L.curtains.get(c.id) || []).length)
    put('warn', 'This curtain doesn’t screen any bay. Move it next to a bay, or tick its bays on the right.', [c.id]);
  for (const c of m.items) if (Array.isArray(c.bays) && (c.k === 'curtain' || (c.k === 'path' && c.layer === 'curtain'))){
    const got = L.curtains.get(c.id) || [], pls = c.k === 'path' ? flattenPath(c.d) : [polyOf(c)];
    for (const pl of pls){ const s = besideOf(m, pl); if (!s[1] || !s[-1] || got.includes(s[1].id) === got.includes(s[-1].id)) continue;
      const [y, n] = got.includes(s[1].id) ? [s[1], s[-1]] : [s[-1], s[1]];
      put('tip', `This curtain sits between ${name(y)} and ${name(n)} but only screens ${name(y)}. Tick ${name(n)} on the right if it should close for both.`, [c.id]); break; } }
  if (hasWalls){ const wb = inflate(bbox(S.walls.flatMap(w => w.pts)), 3 * UNIT);
    for (const it of m.items){ if (it.k === 'wall' || isOpening(it) || (it.k === 'path' && it.layer === 'wall')) continue; const x = itemBox(m, it, L);
      if (!inBox([(x.x0 + x.x1) / 2, (x.y0 + x.y1) / 2], wb)) put('warn', `${itemName(m, it)} is far outside the walls. Drag it in or delete it.`, [it.id]); } }
  const counts = { bays: bays.length, walls: S.walls.length, curtains: m.items.filter(i => i.k === 'curtain' || (i.k === 'path' && i.layer === 'curtain')).length,
    doors: m.items.filter(i => i.k === 'door' || (i.k === 'path' && i.layer === 'door')).length, windows: m.items.filter(i => i.k === 'window' || (i.k === 'path' && i.layer === 'window')).length,
    tables: bays.filter(b => L.bays.get(b.id).table).length + m.items.filter(i => i.k === 'table' || FURN[i.k]).length, chairs: bays.length + m.items.filter(i => i.k === 'chair').length,
    rooms: m.items.filter(i => i.k === 'label').length };
  for (const k in R.BP_MAX) if (counts[k] > R.BP_MAX[k]) put('error', `The map has more than ${R.BP_MAX[k]} ${k}. Remove some.`);
  if (hasWalls && !m.items.some(i => i.k === 'label' && String(i.t || '').trim())) put('tip', 'Name each room with Label (L) so staff know which room is which.');
  if (!out.some(x => x.level === 'error')){ const r = R.bpCheck(exportPlan(m, { savedAt: '' })); if (r.err) put('error', r.err); }
  const lv = { error: 0, warn: 1, tip: 2 };
  return out.sort((a, b) => lv[a.level] - lv[b.level]);
}
const canSave = m => !check(m).some(x => x.level === 'error');

// ---------- templates ----------
// Starting points. "Two rooms, 5 bays" is the built-in ESK map redrawn with real walls, doors and curtains (chairs, tables and tags
// pinned where the ESK drawing has them), so saving it unchanged looks like the map the tracker shows today.
function eskRooms(){
  const m = newModel('ESK rooms'), wall = add(m, { id: '', k: 'wall', pts: [[22, 50], [800, 50], [800, 372], [22, 372]], bend: [0, 0, 0, 0], closed: true, thin: false });
  add(m, { id: '', k: 'wall', pts: [[418, 50], [418, 372]], bend: [0, 0], closed: false, thin: false });
  add(m, { id: '', k: 'door', wall: wall.id, seg: 2, t: 448 / 778, w: 48, type: 'swing', flip: false, hinge: 'a' });
  add(m, { id: '', k: 'door', wall: wall.id, seg: 2, t: 335 / 778, w: 50, type: 'swing', flip: false, hinge: 'b' });
  const B = [[1, 118, 298, 58, -80, [-44, 2], [-46, -45, 24], [176, 300]], [2, 118, 128, 60, -40, [-22, -20], [32, -44, 26], [158, 180]],
    [3, 345, 150, 55, 35, [13, -28], [-23, -62, 26], [332, 206]], [4, 500, 140, 58, -35, [-28, -32], [27, -50, 22], [572, 170]], [5, 695, 150, 58, 30, [27, -24], [-40, -60, 27], [684, 230]]]
    .map(([no, x, y, r, a, chair, table, tag]) => { const v = [table[0] - chair[0], table[1] - chair[1]], pr = pright(a);
      return add(m, { id: '', k: 'bay', no: String(no), x, y, r, a, side: v[0] * pr[0] + v[1] * pr[1] >= 0 ? 'right' : 'left', tag, chair, table }); });
  const curtain = (pts, bend, bays) => add(m, { id: '', k: 'curtain', pts, bend: [...bend, 0], bays: bays.map(n => B[n - 1].id), rev: false });
  curtain([[30, 207], [158, 207], [226, 292], [226, 364]], [0, -24.6, 0], [1, 2]);
  curtain([[204, 54], [268, 232], [316, 241], [410, 241]], [12, 3.4, 0], [2, 3]);
  curtain([[600, 54], [600, 262], [608, 364]], [0, -2.3], [4, 5]);
  curtain([[424, 244], [554, 208]], [11.7], [4]);
  for (const [x, y, s] of [[62, 162, 44], [450, 185, 50], [770, 272, 40]]) add(m, { id: '', k: 'table', shape: 'round', x, y, s, a: 0 });
  add(m, { id: '', k: 'table', shape: 'square', x: 272, y: 100, s: 40, a: 0 });
  add(m, { id: '', k: 'label', t: 'ESK Room 1', x: 219.776, y: 25.872, small: false });
  add(m, { id: '', k: 'label', t: 'ESK Room 2', x: 611.656, y: 25.872, small: false });
  return m;
}
// One room with four bays along the back wall, curtains between them, a counter and a door: everything else automatic.
function oneRoom(){
  const m = newModel('Treatment room'), [wall] = newRoom(m, 0, 0, 704, 400, 'Treatment room');
  add(m, { id: '', k: 'door', wall: wall.id, seg: 2, t: 104 / 704, w: 48, type: 'swing', flip: false, hinge: hingeFor(m, wall.id, 2, 104 / 704, 48) });
  for (const x of [100, 268, 436, 604]) add(m, { id: '', k: 'bay', no: nextBayNo(m), x, y: 84, r: SIZES.M, a: 0, side: 'auto', tag: null, chair: null, table: null });
  for (const x of [184, 352, 520]) add(m, { id: '', k: 'curtain', pts: [[x, 4], [x, 176]], bend: [0, 0], bays: null, rev: false });
  add(m, { id: '', k: 'counter', x: 120, y: 377, w: 96, h: 32, a: 0 });
  return m;
}
function templates(){
  return [
    { id: 'blank', name: 'Blank', desc: 'An empty page. Start with Room (R).', model: newModel('New bay map') },
    { id: 'one-room', name: 'One room, 4 bays', desc: 'A treatment room with four bays along the back wall and curtains between them.', model: oneRoom() },
    { id: 'two-rooms', name: 'Two rooms, 5 bays', desc: 'The ESK layout the tracker shows today, drawn with walls, doors and curtains you can change.', model: eskRooms() },
    { id: 'esk', name: 'Current ESK map (built-in)', desc: 'The built-in map exactly as it is. Its walls and curtains move as one piece and can’t be reshaped.', model: importPlan(R.BP_DEFAULT) },
  ];
}

// ---------- undo, units ----------
// Undo/redo as JSON snapshots. push() after every change (identical snapshots are skipped).
function history(max = 200){
  let past = [], future = [], cur = null;
  return {
    reset(m){ past = []; future = []; cur = JSON.stringify(m); },
    push(m){ const s = JSON.stringify(m); if (s === cur) return false; if (cur != null) past.push(cur); if (past.length > max) past.shift(); cur = s; future = []; return true; },
    undo(){ if (!past.length) return null; future.push(cur); cur = past.pop(); return JSON.parse(cur); },
    redo(){ if (!future.length) return null; past.push(cur); cur = future.pop(); return JSON.parse(cur); },
    canUndo: () => past.length > 0, canRedo: () => future.length > 0,
  };
}
// Drawing units → "12 ft 6 in" (nearest inch).
function fmtFt(u, unit = UNIT){
  const inch = Math.round(Math.abs(u) / unit * 12), ft = Math.floor(inch / 12), i = inch % 12;
  return ft && i ? `${ft} ft ${i} in` : ft ? `${ft} ft` : `${i} in`;
}
// "12", "12.5", "12 ft 6 in", "12' 6\"", "6 in" → drawing units, or null.
function parseFt(s, unit = UNIT){
  const t = String(s ?? '').trim().toLowerCase().replace(/feet|foot/g, 'ft').replace(/inches|inch/g, 'in').replace(/[′’']/g, ' ft ').replace(/[″"”]/g, ' in ').replace(/\s+/g, ' ').trim();
  let r = /^(\d+(?:\.\d+)?)\s*in$/.exec(t); if (r) return rnd(+r[1] / 12 * unit);
  r = /^(\d+(?:\.\d+)?)\s*(?:ft)?\s*(?:(\d+(?:\.\d+)?)\s*(?:in)?)?$/.exec(t);
  return r ? rnd((+r[1] + (r[2] ? +r[2] / 12 : 0)) * unit) : null;
}

const BM = { UNIT, GRID, PAD, WALL, THIN, SIZES, FURN, NAMES, BAY_RE,
  arcOf, segPath, segMid, bendAt, segsOf, polyOf, lineD, parsePath, pathStr, mapPath, movePath, flattenPath,
  newModel, cleanModel, nextId, nextBayNo, add, byId,
  doorD, windowD, wallD, wallAt, doorFit, hingeFor, newDoor, openingSeg,
  wallLines, faceWall, nudgeBay, newBay, autoBay, autoCurtainBays, tagPx, tagSize, TAG_D, PANE_D, layout, snap,
  newRoom, newLine, newItem, hugWall, moveItems, moveModel, rotateItems, remove, paste, dup, insertVertex, removeVertex, moveVertex,
  itemBox, nearSeg, hit, marquee, itemName, planOf, exportPlan, importPlan, check, canSave, templates, history, fmtFt, parseFt, normA };
if (typeof module !== 'undefined' && module.exports) module.exports = BM; else root.BM = BM;
})(typeof globalThis !== 'undefined' ? globalThis : this);
