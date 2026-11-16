// Generates data/maps/spire-nine.json. Run: pnpm map:spire-nine
//
// SPIRE NINE: the street level of the city's ninth tower, left half-built on
// the night of the Zero Protocol. The Corps holds the south end (z > 0), Z.E.R.O
// the north (z < 0). The layout is mirrored across z = 0, so both teams play
// the same ground; only the dressing differs (human concrete, blue conduits /
// machine black, crimson lights).
//
// Three lanes run north-south:
//   west    the Rail: an elevated line (deck 8 m) over a street mechs can use,
//           broken in two places, with the station in the middle
//   centre  the Avenue: the mech street, with the fallen crane jib across it
//   east    the Spire: the tower's open floors (0, 4.5, 9 m), pilots only,
//           scaffolding on its east face and a construction yard behind
// Cross streets at |z| 31..41 join the lanes; the spawn yards sit behind
// the Line, a 15 m blast wall at |z| 57 with screened openings.
//
// Rules this layout keeps (tests in packages/shared/tests/maps.test.ts):
//   - pilot doors are 2 m wide (a mech is 2.8 m), so buildings are pilot ground
//   - floors are 4 m apart in houses, 4.5 m in the tower
//   - no ramp steeper than 34 degrees (walkable is 45)
//   - on the ground, no view longer than the bots can see (75 m)
//   - from anywhere, no view into the other team's spawn yard

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const boxes = [];
const backdrop = [];
const ids = new Set();
const r3 = (v) => Math.round(v * 1000) / 1000;
const DEG = 180 / Math.PI;

function put(list, id, pos, size, mat, rot) {
  if (ids.has(id)) throw new Error(`duplicate box id ${id}`);
  ids.add(id);
  const b = { id, pos: pos.map(r3), size: size.map(r3), mat };
  if (rot && rot.some((a) => Math.abs(a) > 1e-9)) b.rot = rot.map(r3);
  list.push(b);
}

/** Axis-aligned box from two corners (any order). */
function aabb(list, id, x0, y0, z0, x1, y1, z1, mat) {
  put(list, id, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)], mat);
}
const solid = (id, x0, y0, z0, x1, y1, z1, mat) => aabb(boxes, id, x0, y0, z0, x1, y1, z1, mat);
const scenery = (id, x0, y0, z0, x1, y1, z1, mat) => aabb(backdrop, id, x0, y0, z0, x1, y1, z1, mat);

/**
 * A box laid from point a to point b: `w` wide (sideways, level) and `t`
 * thick. With `surface`, a..b is the top face (ramps); otherwise the centre line.
 */
function beam(list, id, a, b, w, t, mat, surface = false) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d);
  const u = d.map((v) => v / len);
  const c = Math.asin(u[1]);
  const yaw = Math.atan2(-u[2], u[0]);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  if (surface) {
    const n = [-Math.sin(c) * Math.cos(yaw), Math.cos(c), Math.sin(c) * Math.sin(yaw)];
    for (let i = 0; i < 3; i++) mid[i] -= (n[i] * t) / 2;
  }
  put(list, id, mid, [len, t, w], mat, [0, yaw * DEG, c * DEG]);
}

/** A walkable ramp whose top face runs from a to b, overlapping 0.3 m at both ends. */
function ramp(id, a, b, w, mat) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d);
  const slope = Math.asin(Math.abs(d[1]) / len) * DEG;
  if (slope > 34) throw new Error(`ramp ${id} is ${slope.toFixed(1)} degrees`);
  const e = d.map((v) => (v / len) * 0.3);
  beam(boxes, id, [a[0] - e[0], a[1] - e[1], a[2] - e[2]], [b[0] + e[0], b[1] + e[1], b[2] + e[2]], w, 0.4, mat, true);
}

/**
 * A wall with holes. `axis` is the direction it runs ('x' or 'z'); it spans
 * s0..s1 along it, sits between f0..f1 across it, and rises y0..y1. Openings
 * are { a, b, lo, hi }: from a to b along the wall, from lo to hi in height.
 */
function wall(id, axis, f0, f1, s0, s1, y0, y1, openings, mat) {
  [s0, s1] = [Math.min(s0, s1), Math.max(s0, s1)];
  const ops = openings.map((o) => ({ a: Math.min(o.a, o.b), b: Math.max(o.a, o.b), lo: o.lo, hi: o.hi }));
  const cuts = [...new Set([s0, s1, ...ops.flatMap((o) => [o.a, o.b]).filter((v) => v > s0 && v < s1)])].sort((p, q) => p - q);
  let k = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const c0 = cuts[i], c1 = cuts[i + 1];
    let spans = [[y0, y1]];
    for (const o of ops) {
      if (o.a > c0 + 1e-6 || o.b < c1 - 1e-6) continue;
      spans = spans.flatMap(([lo, hi]) => {
        const out = [];
        if (o.lo > lo) out.push([lo, Math.min(hi, o.lo)]);
        if (o.hi < hi) out.push([Math.max(lo, o.hi), hi]);
        return out.filter(([p, q]) => q - p > 0.05);
      });
    }
    for (const [lo, hi] of spans) {
      if (axis === 'x') solid(`${id}-${k++}`, c0, lo, f0, c1, hi, f1, mat);
      else solid(`${id}-${k++}`, f0, lo, c0, f1, hi, c1, mat);
    }
  }
}

/** A floor slab (top at yTop) with rectangular holes { x0, x1, z0, z1 }. */
function slab(id, x0, x1, z0, z1, yTop, th, holes, mat) {
  [x0, x1] = [Math.min(x0, x1), Math.max(x0, x1)];
  [z0, z1] = [Math.min(z0, z1), Math.max(z0, z1)];
  const hs = holes.map((h) => ({ x0: Math.min(h.x0, h.x1), x1: Math.max(h.x0, h.x1), z0: Math.min(h.z0, h.z1), z1: Math.max(h.z0, h.z1) }));
  const cuts = [...new Set([x0, x1, ...hs.flatMap((h) => [h.x0, h.x1]).filter((v) => v > x0 && v < x1)])].sort((p, q) => p - q);
  let k = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const c0 = cuts[i], c1 = cuts[i + 1];
    let spans = [[z0, z1]];
    for (const h of hs) {
      if (h.x0 > c0 + 1e-6 || h.x1 < c1 - 1e-6) continue;
      spans = spans.flatMap(([lo, hi]) => {
        const out = [];
        if (h.z0 > lo) out.push([lo, Math.min(hi, h.z0)]);
        if (h.z1 < hi) out.push([Math.max(lo, h.z1), hi]);
        return out.filter(([p, q]) => q - p > 0.05);
      });
    }
    for (const [lo, hi] of spans) solid(`${id}-${k++}`, c0, yTop - th, lo, c1, yTop, hi, mat);
  }
}

// Opening shapes, centred at `at` along the wall.
const door = (at, base = 0) => ({ a: at - 1, b: at + 1, lo: base, hi: base + 2.6 });
const win = (at, base = 0) => ({ a: at - 1.2, b: at + 1.2, lo: base + 1.0, hi: base + 2.6 });

/** Dressing of each half: the Corps' south and Z.E.R.O's north. Geometry never depends on it. */
const THEME = {
  1: { tag: 's', facade: 'concrete', cover: 'barrier', trim: 'conduit', heavy: 'concrete-dark', end: 'concrete', panel: 'steel', skyline: 'skyline' },
  [-1]: { tag: 'n', facade: 'concrete-dark', cover: 'machine', trim: 'crimson', heavy: 'machine', end: 'machine', panel: 'vents', skyline: 'skyline-dark' },
};

/** Light strip laid flat on a face: runs along `axis` at height y, sticking out 0.06 m from the face at `f`, toward `dir`. */
function strip(id, axis, f, dir, s0, s1, y, mat, h = 0.18) {
  const f1 = f + dir * 0.06;
  if (axis === 'x') scenery(id, s0, y - h / 2, f, s1, y + h / 2, f1, mat);
  else scenery(id, f, y - h / 2, s0, f1, y + h / 2, s1, mat);
}

// ---------------------------------------------------------------- ground and edges

// Ground tiles, all with their top at y = 0 (the bot grid reads the ground floor there).
solid('ground-rail', -60, -1, -80, -38, 0, 80, 'asphalt');
solid('ground-west', -38, -1, -80, -16, 0, 80, 'pavement');
solid('ground-avenue', -12, -1, -80, 12, 0, 80, 'asphalt');
solid('ground-walk-w', -16, -1, -80, -12, 0, 80, 'pavement');
solid('ground-walk-e', 12, -1, -80, 16, 0, 80, 'pavement');
solid('ground-site', 16, -1, -80, 60, 0, 80, 'slab');

// Invisible walls keep everyone inside, far above anything reachable.
solid('clip-w', -61, 0, -81, -60, 100, 81, 'clip');
solid('clip-e', 60, 0, -81, 61, 100, 81, 'clip');
solid('clip-s', -61, 0, 80, 61, 100, 81, 'clip');
solid('clip-n', -61, 0, -81, 61, 100, -80, 'clip');

// The neighbours: solid facades along both long edges, too tall to climb.
for (const s of [1, -1]) {
  const T = THEME[s];
  // West: the old housing blocks behind the rail line.
  solid(`${T.tag}-edge-w1`, -66, 0, s * 2, -60, 22, s * 30, T.facade);
  solid(`${T.tag}-edge-w2`, -66, 0, s * 30, -60, 26, s * 58, T.facade);
  solid(`${T.tag}-edge-w3`, -66, 0, s * 58, -60, 20, s * 80, T.facade);
  // East: hoarding and offices behind the construction site.
  solid(`${T.tag}-edge-e1`, 60, 0, s * 2, 66, 20, s * 31, T.facade);
  solid(`${T.tag}-edge-e2`, 60, 0, s * 31, 66, 24, s * 80, T.facade);
  // The end wall behind the spawn yard.
  solid(`${T.tag}-end`, -66, 0, s * 80, 66, 12, s * 84, T.end);
  for (const [k, x0, x1] of [[1, -60, -20], [2, 20, 60]]) strip(`${T.tag}-end-trim${k}`, 'x', s * 80, -s, x0, x1, 6, T.trim, 0.3);
  strip(`${T.tag}-edge-w-trim`, 'z', -60, 1, s * 4, s * 78, 3.4, T.trim);
  strip(`${T.tag}-edge-e-trim`, 'z', 60, -1, s * 4, s * 78, 3.4, T.trim);
  // Windows punched into the neighbours, as dark recesses (scenery: flat on the wall).
  for (let z = 6; z < 76; z += 8) {
    for (const y of [6, 11, 16]) {
      scenery(`${T.tag}-wwin-${z}-${y}`, -60, y, s * z, -59.96, y + 2, s * (z + 3), 'skyline-dark');
      scenery(`${T.tag}-ewin-${z}-${y}`, 59.96, y, s * z, 60, y + 2, s * (z + 3), 'skyline-dark');
    }
  }
}
// The seam where the two halves meet at z = 0 on the edges.
solid('edge-w0', -66, 0, -2, -60, 22, 2, 'concrete');
solid('edge-e0', 60, 0, -2, 66, 20, 2, 'concrete');

// ---------------------------------------------------------------- the Rail (west lane)

// Station deck in the middle, across the whole lane and joined to the Transit
// Hall roof (both at 8 m). Under it, the concourse: pilot ground that also
// stops the street being one long view.
solid('station-deck', -60, 6.8, -14, -36, 8, 14, 'slab');
// Canopy over the platform: shade, and no mech lands on the station.
solid('station-canopy', -56, 12.5, -9, -40, 12.9, 9, 'steel');
for (const [x, z] of [[-54, -7], [-54, 7], [-42, -7], [-42, 7]]) solid(`station-col-${x}-${z}`, x - 0.4, 8, z - 0.4, x + 0.4, 12.5, z + 0.4, 'girder');
// The signal box splits the platform: no view runs the length of the deck.
solid('station-box', -54, 8, -3, -44, 11.5, 3, 'concrete-dark');
strip('station-box-trim', 'z', -44, 1, -3, 3, 10.6, 'paint', 0.12);
// Concourse walls (its east wall is the Transit Hall's).
for (const s of [1, -1]) {
  const t = THEME[s].tag;
  wall(`concourse-${t}`, 'x', s * 13.5, s * 14, -60, -36, 0, 6.8, [door(-57), door(-51), door(-42)], 'concrete');
  // Ticket barriers inside.
  solid(`concourse-gates-${t}`, -58, 0, s * 3.5, -52, 1.1, s * 4.1, 'steel');
  solid(`concourse-kiosk-${t}`, -46, 0, s * 4, -42, 2.8, s * 8, 'concrete-dark');
}
// Departure boards down the middle of the concourse, with ways between them.
for (const [k, x0, x1] of [[1, -60, -55.5], [2, -52.5, -49.6], [3, -44, -40]]) solid(`concourse-board${k}`, x0, 0, -0.4, x1, 2.8, 0.4, 'concrete-dark');
for (const z of [-10, 0, 10]) solid(`station-pier-${z}`, -49.6, 0, z - 2, -48.4, 6.8, z + 2, 'concrete');

for (const s of [1, -1]) {
  const T = THEME[s];
  const t = T.tag;
  // Deck: a short piece by the station, an 8 m gap where it fell, then the long run to the Line.
  solid(`${t}-deck-a`, -54, 6.8, s * 14, -44, 8, s * 20, 'slab');
  solid(`${t}-deck-b`, -54, 6.8, s * 28, -44, 8, s * 56, 'slab');
  // A carriage fell into the gap and leans from the far deck down to the street.
  beam(boxes, `${t}-carriage`, [-49, 8.0, s * 30], [-49, 0, s * 18], 3.0, 3.4, T.heavy, true);
  // The end of the line: a signal box against the wall.
  solid(`${t}-deck-box`, -54, 8, s * 52, -44, 12.5, s * 56, T.heavy);
  // Parapets, open where the climb and the side stairs reach the deck.
  solid(`${t}-parapet-w1`, -54, 8, s * 28, -53.7, 9, s * 44, 'concrete');
  solid(`${t}-parapet-w2`, -54, 8, s * 50, -53.7, 9, s * 52, 'concrete');
  solid(`${t}-parapet-e1`, -44.3, 8, s * 28, -44, 9, s * 37, 'concrete');
  solid(`${t}-parapet-e2`, -44.3, 8, s * 40.3, -44, 9, s * 52, 'concrete');
  // Piers under the deck.
  for (const z of [17.5, 32, 42, 49]) solid(`${t}-pier-${z}`, -49.6, 0, s * (z - 2), -48.4, 6.8, s * (z + 2), 'concrete');
  // Stairs from the street up to the station end of the deck.
  ramp(`${t}-rail-stair`, [-58.3, 0, s * 31], [-58.3, 8, s * 17], 2.6, 'steel');
  solid(`${t}-rail-landing`, -59.6, 7.6, s * 14, -54, 8, s * 17.3, 'steel');
  // Side stairs from the yard end of the street up to the deck, toward the middle.
  ramp(`${t}-deck-stair`, [-42, 0, s * 54], [-42, 8, s * 40], 2.8, 'steel');
  solid(`${t}-deck-landing`, -44, 7.6, s * 37, -40.6, 8, s * 40.3, 'steel');
  // A container stack to climb onto the deck from the outer street.
  const cont = T.panel === 'vents' ? 'machine' : 'steel';
  solid(`${t}-cont-a`, -59.4, 0, s * 44, -56.8, 2.6, s * 50, cont);
  solid(`${t}-cont-b`, -59.4, 2.6, s * 46, -56.8, 5.2, s * 50, cont);
  strip(`${t}-deck-trim`, 'z', -44, 1, s * 28, s * 52, 7.4, T.trim);
}

// ---------------------------------------------------------------- west row (houses)

// Transit Hall: two floors, joined to the station deck by its roof.
{
  const x0 = -36, x1 = -18, z0 = -12, z1 = 12, t = 0.5;
  wall('hall-w', 'z', x0, x0 + t, z0, z1, 0, 8, [door(-7), door(7), win(-3, 4), win(3, 4)], 'concrete');
  wall('hall-e', 'z', x1 - t, x1, z0, z1, 0, 8, [door(0), win(-5), win(5), win(-8, 4), win(-3, 4), win(3, 4), win(8, 4)], 'concrete');
  for (const s of [1, -1]) {
    const T = THEME[s];
    wall(`hall-${T.tag}`, 'x', s * (z1 - t), s * z1, x0, x1, 0, 8, [door(-22), win(-31), win(-26, 4)], 'concrete');
    // Stairs to the upper floor, one per half, against the end walls.
    ramp(`hall-stair-${T.tag}`, [-33, 0, s * 9.8], [-26, 4, s * 9.8], 2.2, 'steel');
    strip(`hall-trim-${T.tag}`, 'z', x1, 1, s * 1.8, s * 11.5, 3.3, T.trim);
  }
  // Ticket counter and an information pillar in the middle of the hall.
  solid('hall-counter', -24, 0, -1, -19.5, 1.9, 1, 'concrete-dark');
  solid('hall-pillar', -32, 0, -1, -30, 3.6, 1, 'concrete');
  slab('hall-floor2', x0 + t, x1 - t, z0 + t, z1 - t, 4.0, 0.4, [
    { x0: -31, x1: -23, z0: -3, z1: 3 },
    { x0: -30, x1: -25.4, z0: 8.5, z1: 11.5 },
    { x0: -30, x1: -25.4, z0: -11.5, z1: -8.5 },
  ], 'slab');
  slab('hall-roof', x0, x1, z0, z1, 8.0, 0.4, [], 'slab');
  // A stair house on the roof.
  solid('hall-roofhouse', -30, 8, -2.5, -22, 11, 2.5, 'concrete-dark');
}

for (const s of [1, -1]) {
  const T = THEME[s];
  const t = T.tag;
  // Apartment block between the alley and the cross street: two floors.
  {
    const x0 = -36, x1 = -18, za = 14.4, zb = 31, w = 0.5;
    wall(`${t}-apt-w`, 'z', x0, x0 + w, s * za, s * zb, 0, 8, [door(s * 22), win(s * 18, 4), win(s * 27, 4)], T.facade);
    wall(`${t}-apt-e`, 'z', x1 - w, x1, s * za, s * zb, 0, 8, [door(s * 18), win(s * 26), win(s * 18, 4), win(s * 22.5, 4), win(s * 27, 4)], T.facade);
    wall(`${t}-apt-in`, 'x', s * za, s * (za + w), x0, x1, 0, 8, [door(-20)], T.facade);
    wall(`${t}-apt-out`, 'x', s * (zb - w), s * zb, x0, x1, 0, 8, [door(-23), win(-31, 4), win(-23, 4)], T.facade);
    ramp(`${t}-apt-stair`, [-34, 0, s * 29.2], [-27, 4, s * 29.2], 2.2, 'steel');
    slab(`${t}-apt-floor2`, x0 + w, x1 - w, s * (za + w), s * (zb - w), 4.0, 0.4, [{ x0: -31, x1: -26.4, z0: s * 27.9, z1: s * 30.5 }], 'slab');
    slab(`${t}-apt-roof`, x0, x1, s * za, s * zb, 8.0, 0.4, [], 'slab');
    solid(`${t}-apt-tank`, -26, 8, s * 20, -22, 10.5, s * 24, 'steel');
    strip(`${t}-apt-trim`, 'z', x1, 1, s * 15, s * 30.5, 3.3, T.trim);
  }
  // Checkpoint office against the Line: one floor, a roof you can climb onto.
  {
    const x0 = -36, x1 = -18, za = 41, zb = 56.5, w = 0.5;
    wall(`${t}-office-w`, 'z', x0, x0 + w, s * za, s * zb, 0, 4.5, [door(s * 46), win(s * 51)], T.facade);
    wall(`${t}-office-e`, 'z', x1 - w, x1, s * za, s * zb, 0, 4.5, [door(s * 44), win(s * 48.5), win(s * 53)], T.facade);
    wall(`${t}-office-in`, 'x', s * za, s * (za + w), x0, x1, 0, 4.5, [door(-31), door(-25)], T.facade);
    solid(`${t}-office-desk`, -30, 0, s * 47, -24, 1.1, s * 48.2, 'concrete');
    slab(`${t}-office-roof`, x0, x1, s * za, s * zb, 4.5, 0.4, [], 'slab');
    solid(`${t}-office-crate`, -18, 0, s * 50, -16.6, 1.4, s * 51.4, T.cover);
    strip(`${t}-office-trim`, 'x', s * za, -s, -35, -19, 3.6, T.trim);
  }
}

// ---------------------------------------------------------------- the Avenue

// The tower crane's jib fell across the avenue onto a truck cab: a ramp for
// pilots from the street to the tower's third floor, a wall for mechs except
// around its tip.
beam(boxes, 'jib', [-7, 0.8, 0], [24, 10.6, 0], 1.6, 1.6, 'girder');
solid('jib-counterweight', 9, 0, -2.5, 14, 2.2, 2.5, 'concrete-dark');
solid('jib-cab', -2.5, 0, -3, 4, 2.6, 3, 'wreck');

for (const s of [1, -1]) {
  const T = THEME[s];
  const t = T.tag;
  solid(`${t}-bus`, -12, 0, s * 18, -9, 3.2, s * 30, 'wreck');
  solid(`${t}-taxi`, -10, 0, s * 13, -7, 2.2, s * 17, 'wreck');
  solid(`${t}-newsstand`, -18, 0, s * 8, -12, 2.4, s * 11, T.heavy);
  solid(`${t}-hook`, 4, 0, s * 6, 9, 2.4, s * 9, 'girder');
  solid(`${t}-blastwall`, 2, 0, s * 25.5, 8, 3, s * 26.5, T.cover);
  solid(`${t}-car`, 0, 0, s * 30, 2, 1.5, s * 34.5, 'wreck');
  solid(`${t}-car2`, 9, 0, s * 40, 11, 1.5, s * 44.5, 'wreck');
  for (const x of [-10.5, -4.5, 4.5, 10.5]) solid(`${t}-jersey${x}`, x - 1.5, 0, s * 48, x + 1.5, 1.1, s * 48.8, T.cover);
  solid(`${t}-planter`, 13.5, 0, s * 12, 15.5, 0.9, s * 16, 'concrete');
  // Cross street chicane: staggered walls, so no view runs its whole width.
  solid(`${t}-cross-a`, -16, 0, s * 31, -14, 3, s * 36, T.cover);
  solid(`${t}-cross-b`, -26, 0, s * 36, -24, 3, s * 41, T.cover);
  solid(`${t}-cross-c`, 14, 0, s * 36, 16, 3, s * 41, T.cover);
  solid(`${t}-cross-d`, 30, 0, s * 31, 32, 3, s * 36, T.cover);
  // Lane paint.
  for (let z = 4; z < 56; z += 8) scenery(`${t}-dash-${z}`, -0.15, 0, s * z, 0.15, 0.02, s * (z + 4), 'paint');
  scenery(`${t}-edge-l`, -11.8, 0, s * 2, -11.6, 0.02, s * 56, 'paint');
  scenery(`${t}-edge-r`, 11.6, 0, s * 2, 11.8, 0.02, s * 56, 'paint');
}

// ---------------------------------------------------------------- the Spire (east lane)

{
  const x0 = 22, x1 = 50, z0 = -20, z1 = 20;
  // Columns every 3 m: 2 m gaps let pilots through and keep mechs out.
  const cols = [];
  for (let z = -19.5; z <= 19.5; z += 3) cols.push([x0, z], [x1, z]);
  for (let x = 25.5; x <= 46.5; x += 3) cols.push([x, z0], [x, z1]);
  for (const [x, z] of cols) {
    solid(`col-${x}-${z}`, x - 0.5, 0, z - 0.5, x + 0.5, 13.5, z + 0.5, 'concrete');
    scenery(`col-up-${x}-${z}`, x - 0.5, 13.5, z - 0.5, x + 0.5, 96, z + 0.5, 'concrete');
  }
  // Floors: 4.5 m and 9 m. The third floor is open to the sky on its east side.
  const stair1 = (s) => ({ x0: 33, x1: 40, z0: s * 5.3, z1: s * 8.7 });
  const stair2 = (s) => ({ x0: 32, x1: 38.5, z0: s * 10.3, z1: s * 13.7 });
  slab('spire-l2', x0 - 0.5, x1 + 0.5, z0 - 0.5, z1 + 0.5, 4.5, 0.5, [stair1(1), stair1(-1)], 'slab');
  slab('spire-l3', x0 - 0.5, x1 + 0.5, z0 - 0.5, z1 + 0.5, 9.0, 0.5, [stair2(1), stair2(-1), { x0: 42, x1: 50.5, z0: -10, z1: 10 }], 'slab');
  // The core: lift shafts and stairs, solid concrete all the way up.
  solid('spire-core', 30, 0, -4, 41, 30, 4, 'concrete-dark');
  scenery('spire-core-up', 30, 30, -4, 41, 104, 4, 'concrete-dark');
  for (const s of [1, -1]) {
    const T = THEME[s];
    const t = T.tag;
    ramp(`${t}-spire-stair1`, [28, 0, s * 7], [40, 4.5, s * 7], 3, 'steel');
    ramp(`${t}-spire-stair2`, [44, 4.5, s * 12], [32, 9.0, s * 12], 3, 'steel');
    // Glass curtain wall on the second floor, facing the avenue: a wallrun from the jib.
    solid(`${t}-spire-glass`, 21.2, 4.5, s * 4, 21.5, 9.0, s * 19.5, 'glass');
    // Lobby: the reception wall and the half-built lift lobby break the long views.
    solid(`${t}-lobby-wall`, 22.5, 0, s * 14, 30.5, 3, s * 14.4, T.facade);
    solid(`${t}-lobby-wall2`, 40.5, 0, s * 15, 49.5, 3, s * 15.4, T.facade);
    solid(`${t}-lobby-desk`, 41, 0, s * 5, 45, 1.1, s * 6.2, 'concrete');
    // Second floor: stud walls nobody finished.
    solid(`${t}-l2-studs`, 22.5, 4.5, s * 16, 33, 8.5, s * 16.3, 'steel');
    solid(`${t}-l2-studs2`, 36, 4.5, s * 15, 49.5, 8.5, s * 15.3, 'steel');
    solid(`${t}-l2-crates`, 44, 4.5, s * 2, 46, 5.7, s * 4, T.cover);
    // Third floor: site cabins, staggered so there is a way between them.
    solid(`${t}-l3-cabin1`, 22.5, 9, s * 13, 31, 11.8, s * 15.5, T.heavy);
    solid(`${t}-l3-cabin2`, 31, 9, s * 17, 38, 11.8, s * 19.5, T.heavy);
    solid(`${t}-l3-cabin3`, 38, 9, s * 13, 49.5, 11.8, s * 15.5, T.heavy);
    solid(`${t}-l3-pallet`, 26, 9, s * 4, 28.4, 10.2, s * 8, 'girder');
    // Scaffolding on the east face, with stairs down into the yard.
    ramp(`${t}-scaffold-stair`, [51.25, 0, s * 26], [51.25, 4.5, s * 18], 2.1, 'steel');
    strip(`${t}-spire-trim`, 'x', s * 20.5, s, 23, 49, 4.1, T.trim);
    // Site hoarding on the walk beside the tower.
    solid(`${t}-hoarding`, 17, 0, s * 8, 21, 2.5, s * 10, T.cover);
  }
  solid('scaffold-l2', 50.5, 4.3, -18, 52.5, 4.5, 18, 'steel');
  solid('scaffold-l3', 50.5, 8.8, -18, 52.5, 9.0, 18, 'steel');
  for (let z = -18; z <= 18; z += 6) solid(`scaffold-pole-${z}`, 52.3, 0, z - 0.1, 52.5, 10.2, z + 0.1, 'steel');
  // The crane's base, left standing in the yard: the yard ends at it.
  solid('crane-base', 52.5, 0, -2, 60, 3.2, 2, 'girder');
}

for (const s of [1, -1]) {
  const T = THEME[s];
  const t = T.tag;
  // Tower plaza: piles of steel.
  solid(`${t}-girders1`, 26, 0, s * 24, 34, 1.2, s * 25.4, 'girder');
  solid(`${t}-girders2`, 40, 0, s * 26, 46, 2.4, s * 27.2, 'girder');
  // Site containers: a two-level climbing yard.
  const cont = T.panel === 'vents' ? 'machine' : 'steel';
  solid(`${t}-c1`, 20, 0, s * 44, 32, 2.6, s * 46.6, cont);
  solid(`${t}-c2`, 36, 0, s * 44, 48, 2.6, s * 46.6, cont);
  solid(`${t}-c3`, 24, 2.6, s * 44, 32, 5.2, s * 46.6, cont);
  solid(`${t}-c4`, 20, 0, s * 50, 32, 2.6, s * 52.6, cont);
  solid(`${t}-c5`, 36, 0, s * 50, 48, 2.6, s * 52.6, cont);
  solid(`${t}-c6`, 36, 2.6, s * 50, 44, 5.2, s * 52.6, cont);
  solid(`${t}-generator`, 16, 0, s * 53, 20, 3, s * 56.5, T.heavy);
  solid(`${t}-pallets`, 40, 0, s * 47, 42, 2.4, s * 50, 'girder');
  // Site hut in the yard.
  {
    const x0 = 51, x1 = 60, za = 41, zb = 52, w = 0.4;
    wall(`${t}-hut-w`, 'z', x0, x0 + w, s * za, s * zb, 0, 3.6, [door(s * 46.5)], T.facade);
    wall(`${t}-hut-in`, 'x', s * za, s * (za + w), x0, x1, 0, 3.6, [door(55.5)], T.facade);
    wall(`${t}-hut-out`, 'x', s * (zb - w), s * zb, x0, x1, 0, 3.6, [win(55.5)], T.facade);
    slab(`${t}-hut-roof`, x0, x1, s * za, s * zb, 3.6, 0.3, [], 'steel');
  }
}

// ---------------------------------------------------------------- the Line and the spawn yards

for (const s of [1, -1]) {
  const T = THEME[s];
  const t = T.tag;
  // The Line: a 15 m blast wall in front of each yard. Its openings are
  // mech-high; a screen stands behind each one, so nothing outside sees in.
  wall(`${t}-line`, 'x', s * 56.5, s * 57.5, -60, 60, 0, 15, [
    { a: -56, b: -40, lo: 0, hi: 6.5 },
    { a: -10, b: 10, lo: 0, hi: 6.5 },
    { a: 30, b: 40, lo: 0, hi: 6.5 },
    door(-25),
    door(51),
  ], T.end);
  for (const [k, x0, x1] of [[1, -40, -10], [2, 10, 30], [3, -60, -56], [4, 40, 60]]) strip(`${t}-line-trim${k}`, 'x', s * 56.5, -s, x0, x1, 9, T.trim, 0.35);
  for (const [k, x0, x1] of [[1, -56, -40], [2, -10, 10], [3, 30, 40]]) strip(`${t}-line-gate${k}`, 'x', s * 56.5, -s, x0, x1, 6.8, 'hazard', 0.5);
  // Screens behind the openings, and buttresses on the yard side.
  solid(`${t}-screen-rail`, -58, 0, s * 61.5, -38, 6.5, s * 63, T.end);
  solid(`${t}-screen-avenue`, -13, 0, s * 61.5, 13, 6.5, s * 63, T.end);
  solid(`${t}-screen-east`, 28, 0, s * 61.5, 42, 6.5, s * 63, T.end);
  solid(`${t}-screen-door1`, -28, 0, s * 59.5, -22, 3, s * 60.5, T.cover);
  solid(`${t}-screen-door2`, 48, 0, s * 59.5, 54, 3, s * 60.5, T.cover);
  solid(`${t}-buttress-w`, -20, 0, s * 57.5, -18, 8, s * 61.5, T.end);
  solid(`${t}-buttress-e`, 18, 0, s * 57.5, 20, 8, s * 61.5, T.end);
  // The depot: a spine down the middle of the yard.
  solid(`${t}-depot`, -3, 0, s * 63, 3, 4, s * 80, T.heavy);
  strip(`${t}-depot-trim-w`, 'z', -3, -1, s * 64, s * 79, 3.2, T.trim);
  strip(`${t}-depot-trim-e`, 'z', 3, 1, s * 64, s * 79, 3.2, T.trim);
  // Low cover by the spawns.
  solid(`${t}-yard-b1`, -42, 0, s * 68, -36, 1.2, s * 69, T.cover);
  solid(`${t}-yard-b2`, 36, 0, s * 68, 42, 1.2, s * 69, T.cover);
  // Landing pad markings.
  scenery(`${t}-pad`, 22, 0, s * 70, 32, 0.02, s * 78, 'hazard');
  scenery(`${t}-pad-in`, 23, 0, s * 71, 31, 0.03, s * 77, 'slab');
}

// ---------------------------------------------------------------- spawns

const spawnSpots = [[-50, 72], [-30, 74], [-18, 70], [-9, 75], [9, 75], [18, 70], [36, 74], [52, 72]];
const spawns = [];
for (const [x, z] of spawnSpots) spawns.push({ pos: [x, 0.1, z], yawDeg: 0, team: 0 });
for (const [x, z] of spawnSpots) spawns.push({ pos: [x, 0.1, -z], yawDeg: 180, team: 1 });

// ---------------------------------------------------------------- skyline (scenery only)

// Spire Nine above the playable floors: slabs up to 85 m (some bays left open),
// glass on the lower half, then bare columns, the core and the crane.
for (let y = 13.5, k = 0; y <= 85; y += 4.5, k++) {
  const open = k % 3 === 2 ? 8 : 0;
  scenery(`spire-floor-${k}`, 21.5, y - 0.5, -20.5, 50.5 - open, y, 20.5, 'slab');
}
for (const s of [1, -1]) {
  scenery(`spire-glass-up-${s}`, 21.3, 13.5, s * 4, 21.5, 58, s * 19.5, 'glass');
  scenery(`spire-glass-side-${s}`, 22, 13.5, s * 20.5, 42, 49, s * 20.7, 'glass');
}
scenery('spire-beam-top', 21.5, 95, -20.5, 50.5, 96, -19.5, 'girder');
scenery('spire-beam-top2', 21.5, 95, 19.5, 50.5, 96, 20.5, 'girder');
// The crane on top of the core: mast, counter-jib and the stump where the jib snapped.
scenery('crane-mast', 34.5, 104, -1.5, 37.5, 130, 1.5, 'girder');
scenery('crane-counterjib', 37.5, 126, -1, 62, 128, 1, 'girder');
scenery('crane-weight', 56, 121, -2, 62, 126, 2, 'concrete-dark');
beam(backdrop, 'crane-stump', [34.5, 127, 0], [20, 122, 0], 1.6, 1.6, 'girder');
scenery('crane-light', 35.5, 130, -0.5, 36.5, 131, 0.5, 'crimson');

// The city around: towers fading into the haze.
{
  let seed = 9;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const tower = (id, x, z, w, d, h, mat) => scenery(id, x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, mat);
  let k = 0;
  // West and east blocks.
  for (const side of [-1, 1]) {
    for (let z = -150; z <= 150; z += 26) {
      const x = side * (90 + rnd() * 70);
      const h = 40 + rnd() * 90;
      tower(`city-${k++}`, x, z + rnd() * 10, 18 + rnd() * 14, 18 + rnd() * 14, h, z > 0 ? 'skyline' : 'skyline-dark');
    }
  }
  // South: the Corps' city, lit.
  for (let x = -160; x <= 160; x += 24) tower(`city-${k++}`, x + rnd() * 8, 120 + rnd() * 60, 20 + rnd() * 10, 20 + rnd() * 10, 50 + rnd() * 110, 'skyline');
  // North: Z.E.R.O's harvester has stripped this side of the city to stumps.
  for (let x = -160; x <= 160; x += 30) tower(`city-${k++}`, x + rnd() * 8, -130 - rnd() * 50, 20 + rnd() * 10, 20 + rnd() * 10, 15 + rnd() * 45, 'skyline-dark');
}
// The harvester: a black wedge leaning over the north skyline, vents glowing.
beam(backdrop, 'harvester-spine', [-40, 20, -170], [40, 110, -150], 34, 26, 'machine');
beam(backdrop, 'harvester-arm1', [-70, 0, -140], [-30, 90, -160], 10, 10, 'machine');
beam(backdrop, 'harvester-arm2', [70, 0, -140], [30, 95, -165], 10, 10, 'machine');
beam(backdrop, 'harvester-arm3', [0, 0, -120], [10, 70, -150], 8, 8, 'machine');
scenery('harvester-vents', -24, 40, -152, 24, 64, -150, 'skyline-machine');
scenery('harvester-vents2', -60, 10, -128, -20, 22, -126, 'skyline-machine');
scenery('harvester-vents3', 20, 6, -112, 52, 16, -110, 'skyline-machine');
// A tower it is eating: black spikes driven into it.
scenery('eaten-tower', -100, 0, -120, -76, 70, -100, 'skyline-dark');
beam(backdrop, 'spike1', [-60, 0, -95], [-88, 60, -110], 4, 4, 'machine');
beam(backdrop, 'spike2', [-120, 10, -90], [-90, 50, -108], 4, 4, 'machine');
// The Corps' line in the south: floodlit blast walls on the horizon.
scenery('corps-wall', -140, 0, 96, 140, 14, 100, 'concrete');
scenery('corps-wall-light', -140, 12, 95.9, 140, 12.4, 96, 'conduit');

const map = {
  name: 'spire-nine',
  title: 'Spire Nine',
  units: 'meters, Y up. pos = box center, size = full extents, rot = euler XYZ degrees. Generated by tools/maps/spire-nine.mjs: edit that, not this file.',
  env: {
    skyTop: '#0a0f1e',
    skyMid: '#2a3552',
    skyHorizon: '#c26a46',
    fog: '#5a5662',
    fogDensity: 0.0038,
    sunColor: '#ffcaa0',
    sunIntensity: 2.5,
    sunDir: [-70, 42, 30],
    hemiSky: '#9db3d8',
    hemiGround: '#363436',
    hemiIntensity: 3.1,
  },
  spawns,
  boxes,
  backdrop,
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/maps/spire-nine.json');
writeFileSync(out, JSON.stringify(map, null, 1) + '\n');
console.log(`spire-nine: ${boxes.length} solid boxes, ${backdrop.length} scenery boxes, ${spawns.length} spawns -> ${out}`);
