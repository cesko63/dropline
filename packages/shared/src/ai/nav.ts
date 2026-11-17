import bots from '../../../../data/bots.json';
import type { MapData } from '../map/types';
import { v3 } from '../math/vec3';
import { MECH_ENVELOPE } from '../sim/mech';
import type { Rng } from '../sim/rng';
import { rand } from '../sim/rng';
import { TUNING } from '../sim/tuning';
import type { CollisionWorld } from '../sim/world';

/**
 * Where bots can go, on every floor of the map. The map is cut into 1 m cells;
 * each cell holds one node per surface a body can stand on there (street, deck,
 * roof...), and links join nodes to their neighbours. Bots plan on it with A*
 * and then move with the same code as players, so the links only have to say
 * what a player could do with the same keys.
 */
export interface NavGrid {
  minX: number;
  minZ: number;
  /** Cell size, meters. */
  cell: number;
  w: number;
  h: number;
  /** Nodes of cell c are cellStart[c] .. cellStart[c + 1] - 1, lowest first. */
  cellStart: Int32Array;
  nodeCell: Int32Array;
  /** Height of the surface at the cell's centre. */
  nodeY: Float32Array;
  /** Links of node k are linkStart[k] .. linkStart[k + 1] - 1. */
  linkStart: Int32Array;
  linkTo: Int32Array;
  linkKind: Uint8Array;
  /** Meters walked, plus a price for the time a climb or a leap takes. */
  linkCost: Float32Array;
  /** Group of nodes joined by links in either direction (0: none). Paths exist only inside one. */
  area: Int32Array;
  /** 1 for nodes reachable from the spawns. */
  reach: Uint8Array;
  /** The nodes reachable from the spawns, for picking destinations. */
  open: Int32Array;
  /** Of those, the ones high above the street: perches. */
  high: Int32Array;
  // A* scratch, reused between searches.
  g: Float32Array;
  f: Float32Array;
  from: Int32Array;
  fromKind: Uint8Array;
  stamp: Uint32Array;
  closed: Uint32Array;
  search: number;
  heap: Int32Array;
}

/** How a body gets from one node to the next. */
export const Link = {
  /** Walking, up and down ramps and steps. */
  Walk: 0,
  /** Jump at a wall and hold jump: the jetpack lifts, the mantle pulls the body over the top. */
  Climb: 1,
  /** Step off an edge onto the floor below. */
  Drop: 2,
  /** Run, jump across a gap and hold jump to carry over it. */
  Leap: 3,
} as const;
export type LinkKind = (typeof Link)[keyof typeof Link];

/** The body a grid is built for. */
export interface NavBody {
  radius: number;
  height: number;
  stepHeight: number;
  /** Can jump, so can climb walls and leap gaps. */
  jumps: boolean;
}

export const PILOT_BODY: NavBody = { radius: TUNING.player.radius, height: TUNING.player.standHeight, stepHeight: TUNING.player.stepHeight, jumps: true };
export const MECH_BODY: NavBody = { ...MECH_ENVELOPE, jumps: false };

/** Reach of the links. Edit /data/bots.json, not this file. */
const NAV = bots.nav;
const CELL = 1;
/** Support is checked this far from the cell's centre, so thin wall tops are not floors. */
const SUPPORT = 0.25;
const DOWN = v3(0, -1, 0);
const cache = new WeakMap<CollisionWorld, Map<string, NavGrid>>();

const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NZ = [0, 0, 1, -1, 1, -1, 1, -1];

export function buildNav(map: MapData, world: CollisionWorld, body: NavBody = PILOT_BODY): NavGrid {
  let grids = cache.get(world);
  if (!grids) cache.set(world, (grids = new Map()));
  const key = `${body.radius}/${body.height}/${body.stepHeight}/${body.jumps}`;
  const cached = grids.get(key);
  if (cached) return cached;

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = 0;
  for (const b of map.boxes) {
    minX = Math.min(minX, b.pos[0] - b.size[0] / 2);
    maxX = Math.max(maxX, b.pos[0] + b.size[0] / 2);
    minZ = Math.min(minZ, b.pos[2] - b.size[2] / 2);
    maxZ = Math.max(maxZ, b.pos[2] + b.size[2] / 2);
    top = Math.max(top, b.pos[1] + Math.hypot(b.size[0], b.size[1], b.size[2]) / 2);
  }
  top += 1;
  minX = Math.floor(minX);
  minZ = Math.floor(minZ);
  const w = Math.ceil((maxX - minX) / CELL);
  const h = Math.ceil((maxZ - minZ) / CELL);
  const n = w * h;
  const cx = (i: number): number => minX + (i + 0.5) * CELL;
  const cz = (j: number): number => minZ + (j + 0.5) * CELL;

  // ---- Nodes: every surface in a cell where the body stands, with the slope there.
  const ys: number[] = [];
  const slopeX: number[] = [];
  const slopeZ: number[] = [];
  const cellOfNode: number[] = [];
  const cellStart = new Int32Array(n + 1);
  const feet = v3();
  const probe = v3();
  // Two opposite corners catch a top too narrow either way.
  const supported = (x: number, y: number, z: number): boolean => {
    for (let k = 4; k < 8; k += 3) {
      probe.x = x + NX[k] * SUPPORT;
      probe.y = y + 0.3;
      probe.z = z + NZ[k] * SUPPORT;
      const d = world.rayDistance(probe, DOWN, 0.6);
      if (d <= 0) return false;
    }
    return true;
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const c = j * w + i;
      cellStart[c] = ys.length;
      const x = cx(i), z = cz(j);
      let last = -Infinity;
      const surfaces = world.surfacesBelow(x, z, top, top + 5);
      for (let s = surfaces.length - 1; s >= 0; s--) {
        const { y, normal } = surfaces[s];
        if (normal.y < TUNING.player.minGroundNormalY || y - last < 0.1) continue;
        // The body steps over small bumps (where a ramp meets a landing), and on
        // a slope its round bottom needs a little lift to clear the surface.
        feet.x = x;
        feet.y = y + body.stepHeight + body.radius * (1 / normal.y - 1);
        feet.z = z;
        if (world.overlapsCapsule(feet, body.height - body.stepHeight, body.radius) || !supported(x, y, z)) continue;
        last = y;
        ys.push(y);
        slopeX.push(-normal.x / normal.y);
        slopeZ.push(-normal.z / normal.y);
        cellOfNode.push(c);
      }
    }
  }
  cellStart[n] = ys.length;
  const count = ys.length;
  const nodeY = Float32Array.from(ys);
  const nodeCell = Int32Array.from(cellOfNode);

  // ---- Links.
  const step = body.stepHeight + 0.05;
  /** Can a body walk from node a to node b one cell over (dx, dz)? */
  const walkable = (a: number, b: number, dx: number, dz: number): boolean => {
    const dy = nodeY[b] - nodeY[a];
    // Along a ramp the height changes with the slope; a step may only add a step's height.
    if (Math.abs(dy - (slopeX[a] * dx + slopeZ[a] * dz)) <= step) return true;
    if (Math.abs(dy - (slopeX[b] * dx + slopeZ[b] * dz)) <= step) return true;
    if (Math.abs(dy) > step * 2) return false;
    // Stairs: two steps between the cell centres are fine.
    probe.x = cx(nodeCell[a] % w) + dx / 2;
    probe.y = Math.max(nodeY[a], nodeY[b]) + 0.5;
    probe.z = cz(Math.floor(nodeCell[a] / w)) + dz / 2;
    const dist = world.rayDistance(probe, DOWN, Math.abs(dy) + 1);
    if (dist <= 0) return false;
    const mid = probe.y - dist;
    return Math.abs(mid - nodeY[a]) <= step && Math.abs(nodeY[b] - mid) <= step;
  };
  /** A node in cell c that node a can walk to, or -1. */
  const walkInto = (a: number, c: number, dx: number, dz: number): number => {
    for (let b = cellStart[c]; b < cellStart[c + 1]; b++) if (walkable(a, b, dx, dz)) return b;
    return -1;
  };
  const clear = (x: number, y: number, z: number, height: number, room = 0): boolean => {
    feet.x = x;
    feet.y = y + 0.05;
    feet.z = z;
    return !world.overlapsCapsule(feet, height, body.radius + room);
  };
  /**
   * A falling body drifts a little, so it needs room to come down in: on the
   * sides and ahead, not back toward the edge it stepped off (direction k).
   */
  const ROOM = 0.25;
  const fallClear = (x: number, y: number, z: number, height: number, k: number): boolean =>
    clear(x + NX[k] * ROOM, y, z + NZ[k] * ROOM, height, ROOM);

  /** A wall face right in front of a body standing at x, y, z, facing neighbour direction k (not a door). */
  const dir = v3();
  const wallAhead = (x: number, y: number, z: number, k: number): boolean => {
    feet.x = x;
    feet.y = y + body.stepHeight + 0.02;
    feet.z = z;
    dir.x = NX[k];
    dir.z = NZ[k];
    const hit = world.castCapsule(feet, body.height - body.stepHeight, dir, 1, body.radius);
    return hit !== null && Math.abs(hit.normal.y) < 0.3;
  };

  const linkStart = new Int32Array(count + 1);
  const to: number[] = [];
  const kinds: number[] = [];
  const costs: number[] = [];
  const add = (b: number, kind: LinkKind, cost: number): void => {
    to.push(b);
    kinds.push(kind);
    costs.push(cost);
  };
  for (let a = 0; a < count; a++) {
    linkStart[a] = to.length;
    const c = nodeCell[a];
    const ci = c % w, cj = Math.floor(c / w);
    const ya = nodeY[a];
    for (let k = 0; k < 8; k++) {
      const ni = ci + NX[k], nj = cj + NZ[k];
      if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      const nc = nj * w + ni;
      const diag = k >= 4;
      for (let b = cellStart[nc]; b < cellStart[nc + 1]; b++) {
        const dy = nodeY[b] - ya;
        if (walkable(a, b, NX[k], NZ[k])) {
          // A diagonal step needs both cells beside it open on the same floor.
          if (diag && (walkInto(a, cj * w + ni, NX[k], 0) < 0 || walkInto(a, nj * w + ci, 0, NZ[k]) < 0)) continue;
          add(b, Link.Walk, diag ? Math.SQRT2 : 1);
        } else if (diag) {
          continue;
        } else if (dy < 0 && -dy <= NAV.dropMax) {
          // The whole fall, from standing at a's height down to b, must be open.
          if (fallClear(cx(ni), nodeY[b], cz(nj), -dy + body.height, k)) add(b, Link.Drop, 1 + -dy * 0.4);
        } else if (dy > 0 && body.jumps && dy <= NAV.climbMax) {
          addClimb(a, ci, cj, k, b);
        }
      }
      // The wall's top edge may run through the next cell, leaving it no floor at
      // all: the top starts one cell further on.
      if (!diag && body.jumps && cellStart[nc] === cellStart[nc + 1]) {
        const fi = ni + NX[k], fj = nj + NZ[k];
        if (fi < 0 || fj < 0 || fi >= w || fj >= h) continue;
        const fc = fj * w + fi;
        for (let b = cellStart[fc]; b < cellStart[fc + 1]; b++) {
          const dy = nodeY[b] - ya;
          if (dy > step && dy <= NAV.climbMax && clear(cx(ni), nodeY[b], cz(nj), TUNING.player.crouchHeight)) addClimb(a, ci, cj, k, b);
        }
      }
    }
    if (body.jumps) addLeaps(a, ci, cj);
  }
  linkStart[count] = to.length;

  /** A wall to climb in direction k: straight up it from a, then over the edge crouched onto b. */
  function addClimb(a: number, ci: number, cj: number, k: number, b: number): void {
    const dy = nodeY[b] - nodeY[a];
    if (clear(cx(ci), nodeY[a], cz(cj), dy + TUNING.player.crouchHeight) && wallAhead(cx(ci), nodeY[a], cz(cj), k)) add(b, Link.Climb, 3 + dy * 2);
  }

  /** Gaps a running jump clears: from an edge, over cells with nothing to stand on, to a floor not much higher. */
  function addLeaps(a: number, ci: number, cj: number): void {
    const ya = nodeY[a];
    for (let k = 0; k < 4; k++) {
      // A run-up: the floor goes on behind.
      const bi = ci - NX[k], bj = cj - NZ[k];
      if (bi < 0 || bj < 0 || bi >= w || bj >= h || walkInto(a, bj * w + bi, -NX[k], -NZ[k]) < 0) continue;
      for (let d = 1; d <= NAV.leapCells; d++) {
        const ni = ci + NX[k] * d, nj = cj + NZ[k] * d;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) break;
        const nc = nj * w + ni;
        let land = -1, blocked = false;
        for (let b = cellStart[nc]; b < cellStart[nc + 1]; b++) {
          const yb = nodeY[b];
          if (yb > ya + NAV.leapRise) blocked = true;
          else if (yb > ya - NAV.leapDrop) land = b;
        }
        if (d > 1 && land >= 0 && !blocked) {
          const yb = nodeY[land];
          // The way down onto the landing must be open too.
          if (fallClear(cx(ni), yb, cz(nj), Math.max(0, ya + 0.3 - yb) + body.height, k)) {
            // Just past the edge and lower down, stepping off is enough.
            if (d === 2 && yb < ya - body.stepHeight) add(land, Link.Drop, 2 + (ya - yb) * 0.4);
            else add(land, Link.Leap, d + 3);
          }
          break;
        }
        // Something to stand on right beside a: no gap here. Something in the way: no jump over it.
        if (land >= 0 || blocked || !clear(cx(ni), ya + 0.3, cz(nj), body.height)) break;
      }
    }
  }

  // ---- Areas: nodes joined by links in either direction (union-find).
  const parent = new Int32Array(count);
  for (let k = 0; k < count; k++) parent[k] = k;
  const root = (k: number): number => {
    while (parent[k] !== k) k = parent[k] = parent[parent[k]];
    return k;
  };
  for (let a = 0; a < count; a++) {
    for (let l = linkStart[a]; l < linkStart[a + 1]; l++) parent[root(a)] = root(to[l]);
  }
  const area = new Int32Array(count);
  const ids = new Map<number, number>();
  for (let k = 0; k < count; k++) {
    const r = root(k);
    let id = ids.get(r);
    if (id === undefined) ids.set(r, (id = ids.size + 1));
    area[k] = id;
  }

  const nav: NavGrid = {
    minX, minZ, cell: CELL, w, h,
    cellStart, nodeCell, nodeY,
    linkStart,
    linkTo: Int32Array.from(to),
    linkKind: Uint8Array.from(kinds),
    linkCost: Float32Array.from(costs),
    area,
    reach: new Uint8Array(count),
    open: new Int32Array(0),
    high: new Int32Array(0),
    g: new Float32Array(count),
    f: new Float32Array(count),
    from: new Int32Array(count),
    fromKind: new Uint8Array(count),
    stamp: new Uint32Array(count),
    closed: new Uint32Array(count),
    search: 0,
    heap: new Int32Array(Math.max(16, to.length + count)),
  };

  // ---- Destinations: everything reachable from the spawns, following the links' direction.
  const seen = nav.reach;
  const queue: number[] = [];
  for (const s of map.spawns) {
    const k = nearestNode(nav, s.pos[0], s.pos[1], s.pos[2], 6);
    if (k >= 0 && !seen[k]) (seen[k] = 1), queue.push(k);
  }
  for (let q = 0; q < queue.length; q++) {
    const a = queue[q];
    for (let l = linkStart[a]; l < linkStart[a + 1]; l++) {
      const b = nav.linkTo[l];
      if (!seen[b]) (seen[b] = 1), queue.push(b);
    }
  }
  nav.open = Int32Array.from(queue).sort();
  nav.high = nav.open.filter((k) => nodeY[k] >= NAV.perchHeight);
  grids.set(key, nav);
  return nav;
}

export const cellOf = (nav: NavGrid, x: number, z: number): number => {
  const i = Math.floor((x - nav.minX) / nav.cell);
  const j = Math.floor((z - nav.minZ) / nav.cell);
  return i < 0 || j < 0 || i >= nav.w || j >= nav.h ? -1 : j * nav.w + i;
};

export const nodeX = (nav: NavGrid, k: number): number => nav.minX + ((nav.nodeCell[k] % nav.w) + 0.5) * nav.cell;
export const nodeZ = (nav: NavGrid, k: number): number => nav.minZ + (Math.floor(nav.nodeCell[k] / nav.w) + 0.5) * nav.cell;

/** True if a body standing about `y` high at x, z is on the grid, somewhere it can get to from the spawns. */
export function isWalkable(nav: NavGrid, x: number, y: number, z: number): boolean {
  const c = cellOf(nav, x, z);
  if (c < 0) return false;
  for (let k = nav.cellStart[c]; k < nav.cellStart[c + 1]; k++) if (nav.reach[k] && Math.abs(nav.nodeY[k] - y) <= 1) return true;
  return false;
}

/**
 * The node for a body at x, y, z, searching outward in rings; -1 if none is near.
 * A floor at or below the feet is preferred to one above the head, and the
 * floor straight below to one off to the side, so a pilot in mid-air belongs
 * to the floor they will land on.
 */
export function nearestNode(nav: NavGrid, x: number, y: number, z: number, maxRing = 8): number {
  const ci = Math.floor((x - nav.minX) / nav.cell);
  const cj = Math.floor((z - nav.minZ) / nav.cell);
  let best = -1, bestScore = Infinity;
  for (let ring = 0; ring <= maxRing; ring++) {
    const near = Math.max(0, ring - 1) * nav.cell;
    if (near * near >= bestScore) break;
    for (let j = cj - ring; j <= cj + ring; j++) {
      if (j < 0 || j >= nav.h) continue;
      for (let i = ci - ring; i <= ci + ring; i++) {
        if (i < 0 || i >= nav.w || Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
        const c = j * nav.w + i;
        for (let k = nav.cellStart[c]; k < nav.cellStart[c + 1]; k++) {
          const dy = y - nav.nodeY[k];
          const score = (nodeX(nav, k) - x) ** 2 + (nodeZ(nav, k) - z) ** 2 + (dy >= -0.6 ? dy * dy * 0.05 : 25 + dy * dy);
          if (score < bestScore) (bestScore = score), (best = k);
        }
      }
    }
  }
  return best;
}

/** The node in cell c that node k walks to (k itself if it is in c), or -1. */
function walkTo(nav: NavGrid, k: number, c: number): number {
  if (c < 0) return -1;
  if (nav.nodeCell[k] === c) return k;
  for (let l = nav.linkStart[k]; l < nav.linkStart[k + 1]; l++) {
    if (nav.linkKind[l] === Link.Walk && nav.nodeCell[nav.linkTo[l]] === c) return nav.linkTo[l];
  }
  return -1;
}

/** True if a body standing at x0, y0, z0 can walk straight to the floor at x1, y1, z1. */
export function walkableLine(nav: NavGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  let k = nearestNode(nav, x0, y0, z0, 1);
  if (k < 0) return false;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / 0.3));
  // Check a strip as wide as the pilot, so smoothed paths do not clip corners.
  const sx = (-dz / (len || 1)) * 0.35;
  const sz = (dx / (len || 1)) * 0.35;
  for (let s = 0; s <= steps; s++) {
    const x = x0 + (dx * s) / steps;
    const z = z0 + (dz * s) / steps;
    k = walkTo(nav, k, cellOf(nav, x, z));
    if (k < 0 || walkTo(nav, k, cellOf(nav, x + sx, z + sz)) < 0 || walkTo(nav, k, cellOf(nav, x - sx, z - sz)) < 0) return false;
  }
  // The same spot on another floor is not a walk away.
  return Math.abs(nav.nodeY[k] - y1) < 1;
}

/** A random destination from `from` (by default anywhere reachable), written to `out`. */
export function randomNavPoint(nav: NavGrid, rng: Rng, out: { x: number; y: number; z: number }, from = nav.open): boolean {
  if (from.length === 0) return false;
  const k = from[Math.floor(rand(rng) * from.length)];
  out.x = nodeX(nav, k);
  out.y = nav.nodeY[k];
  out.z = nodeZ(nav, k);
  return true;
}

/** Waypoints are written as x, y, z, link kind: the kind says how to get there from the waypoint before. */
export const PATH_STRIDE = 4;

const rawNodes: number[] = [];
const rawKinds: number[] = [];
const pts: number[] = [];

/**
 * Shortest path over the links (A*), with walking stretches pulled tight.
 * Writes waypoints to `out` (see PATH_STRIDE) and returns true, or returns
 * false when there is no way.
 */
export function findPath(nav: NavGrid, sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, out: number[]): boolean {
  out.length = 0;
  const start = nearestNode(nav, sx, sy, sz);
  const goal = nearestNode(nav, gx, gy, gz);
  if (start < 0 || goal < 0 || nav.area[start] !== nav.area[goal]) return false;
  const { g, f, from, fromKind, stamp, closed, heap, linkStart, linkTo, linkCost, linkKind } = nav;
  const id = ++nav.search;
  const goalX = nodeX(nav, goal);
  const goalZ = nodeZ(nav, goal);

  let size = 0;
  const push = (c: number): void => {
    let i = size++;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (f[heap[up]] <= f[c]) break;
      heap[i] = heap[up];
      i = up;
    }
    heap[i] = c;
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap[--size];
    let i = 0;
    for (;;) {
      let child = i * 2 + 1;
      if (child >= size) break;
      if (child + 1 < size && f[heap[child + 1]] < f[heap[child]]) child++;
      if (f[heap[child]] >= f[last]) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
    return top;
  };

  g[start] = 0;
  f[start] = 0;
  from[start] = -1;
  fromKind[start] = Link.Walk;
  stamp[start] = id;
  push(start);
  let found = false;
  while (size > 0) {
    const c = pop();
    if (closed[c] === id) continue;
    closed[c] = id;
    if (c === goal) {
      found = true;
      break;
    }
    for (let l = linkStart[c]; l < linkStart[c + 1]; l++) {
      const nc = linkTo[l];
      if (closed[nc] === id) continue;
      const cost = g[c] + linkCost[l];
      if (stamp[nc] === id && cost >= g[nc]) continue;
      const di = Math.abs(nodeX(nav, nc) - goalX);
      const dj = Math.abs(nodeZ(nav, nc) - goalZ);
      g[nc] = cost;
      f[nc] = cost + Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj);
      from[nc] = c;
      fromKind[nc] = linkKind[l];
      stamp[nc] = id;
      // The heap may hold an older, worse entry for this node; it is skipped when popped.
      if (size < heap.length) push(nc);
    }
  }
  if (!found) return false;

  rawNodes.length = 0;
  rawKinds.length = 0;
  for (let c = goal; c >= 0; c = from[c]) {
    rawNodes.push(c);
    rawKinds.push(fromKind[c]);
  }
  rawNodes.reverse();
  rawKinds.reverse();
  const count = rawNodes.length;
  pts.length = 0;
  for (const k of rawNodes) pts.push(nodeX(nav, k), nav.nodeY[k], nodeZ(nav, k));
  // The real start and goal replace the first and last cell centres when they are in those cells.
  if (cellOf(nav, sx, sz) === nav.nodeCell[start]) (pts[0] = sx), (pts[2] = sz);
  if (cellOf(nav, gx, gz) === nav.nodeCell[goal]) (pts[count * 3 - 3] = gx), (pts[count * 3 - 1] = gz);

  // Walking stretches are pulled tight: from each kept point, on to the farthest
  // point in plain sight. Climbs, drops and leaps keep both their ends.
  const emit = (i: number): void => {
    out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], rawKinds[i]);
  };
  emit(0);
  let i = 0;
  while (i < count - 1) {
    if (rawKinds[i + 1] !== Link.Walk) {
      emit(++i);
      continue;
    }
    let end = i + 1;
    while (end < count - 1 && end < i + 40 && rawKinds[end + 1] === Link.Walk) end++;
    let j = end;
    while (j > i + 1 && !walkableLine(nav, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2])) j--;
    emit(j);
    i = j;
  }
  return true;
}
