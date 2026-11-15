import type { MapData } from '../map/types';
import { v3 } from '../math/vec3';
import type { Rng } from '../sim/rng';
import { rand } from '../sim/rng';
import { TUNING } from '../sim/tuning';
import type { CollisionWorld } from '../sim/world';

/**
 * Walkable grid of the map's ground floor, built once from the collision world.
 * Bots plan on it with A* and then walk with the same movement code as players,
 * so the grid only has to say where a standing pilot fits.
 */
export interface NavGrid {
  minX: number;
  minZ: number;
  /** Cell size, meters. */
  cell: number;
  w: number;
  h: number;
  /** 1 where a standing pilot fits on the floor. */
  walk: Uint8Array;
  /** Connected area id per cell (0 = not walkable). Paths exist only inside one area. */
  area: Uint16Array;
  /** Cells of the largest area, for picking random destinations. */
  open: Int32Array;
  // A* scratch, reused between searches.
  g: Float32Array;
  f: Float32Array;
  from: Int32Array;
  stamp: Uint32Array;
  closed: Uint32Array;
  search: number;
  heap: Int32Array;
}

const CELL = 1;
const DOWN = v3(0, -1, 0);
const cache = new WeakMap<CollisionWorld, NavGrid>();

export function buildNav(map: MapData, world: CollisionWorld): NavGrid {
  const cached = cache.get(world);
  if (cached) return cached;

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const b of map.boxes) {
    minX = Math.min(minX, b.pos[0] - b.size[0] / 2);
    maxX = Math.max(maxX, b.pos[0] + b.size[0] / 2);
    minZ = Math.min(minZ, b.pos[2] - b.size[2] / 2);
    maxZ = Math.max(maxZ, b.pos[2] + b.size[2] / 2);
  }
  minX = Math.floor(minX);
  minZ = Math.floor(minZ);
  const w = Math.ceil((maxX - minX) / CELL);
  const h = Math.ceil((maxZ - minZ) / CELL);
  const n = w * h;
  const walk = new Uint8Array(n);
  const feet = v3();
  const probe = v3();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      feet.x = probe.x = minX + (i + 0.5) * CELL;
      feet.z = probe.z = minZ + (j + 0.5) * CELL;
      feet.y = 0.05;
      probe.y = 0.6;
      if (world.overlapsCapsule(feet, TUNING.player.standHeight)) continue;
      if (!world.castRay(probe, DOWN, 1.2)) continue;
      walk[j * w + i] = 1;
    }
  }

  // Label connected areas with a flood fill and remember the largest.
  const area = new Uint16Array(n);
  const queue = new Int32Array(n);
  let areas = 0, bestArea = 0, bestSize = 0;
  for (let start = 0; start < n; start++) {
    if (!walk[start] || area[start]) continue;
    const id = ++areas;
    let head = 0, tail = 0;
    queue[tail++] = start;
    area[start] = id;
    while (head < tail) {
      const c = queue[head++];
      const ci = c % w;
      if (ci > 0 && walk[c - 1] && !area[c - 1]) (area[c - 1] = id), (queue[tail++] = c - 1);
      if (ci < w - 1 && walk[c + 1] && !area[c + 1]) (area[c + 1] = id), (queue[tail++] = c + 1);
      if (c >= w && walk[c - w] && !area[c - w]) (area[c - w] = id), (queue[tail++] = c - w);
      if (c < n - w && walk[c + w] && !area[c + w]) (area[c + w] = id), (queue[tail++] = c + w);
    }
    if (tail > bestSize) {
      bestSize = tail;
      bestArea = id;
    }
  }
  const open = new Int32Array(bestSize);
  for (let c = 0, k = 0; c < n; c++) if (area[c] === bestArea) open[k++] = c;

  const nav: NavGrid = {
    minX, minZ, cell: CELL, w, h, walk, area, open,
    g: new Float32Array(n),
    f: new Float32Array(n),
    from: new Int32Array(n),
    stamp: new Uint32Array(n),
    closed: new Uint32Array(n),
    search: 0,
    heap: new Int32Array(n * 2),
  };
  cache.set(world, nav);
  return nav;
}

export const cellOf = (nav: NavGrid, x: number, z: number): number => {
  const i = Math.floor((x - nav.minX) / nav.cell);
  const j = Math.floor((z - nav.minZ) / nav.cell);
  return i < 0 || j < 0 || i >= nav.w || j >= nav.h ? -1 : j * nav.w + i;
};

export const cellX = (nav: NavGrid, c: number): number => nav.minX + ((c % nav.w) + 0.5) * nav.cell;
export const cellZ = (nav: NavGrid, c: number): number => nav.minZ + (Math.floor(c / nav.w) + 0.5) * nav.cell;

export function isWalkable(nav: NavGrid, x: number, z: number): boolean {
  const c = cellOf(nav, x, z);
  return c >= 0 && nav.walk[c] === 1;
}

/** Closest walkable cell to a point, searching outward in rings; -1 if none is near. */
export function nearestWalkable(nav: NavGrid, x: number, z: number, maxRing = 8): number {
  const ci = Math.floor((x - nav.minX) / nav.cell);
  const cj = Math.floor((z - nav.minZ) / nav.cell);
  for (let ring = 0; ring <= maxRing; ring++) {
    let best = -1, bestD = Infinity;
    for (let j = cj - ring; j <= cj + ring; j++) {
      if (j < 0 || j >= nav.h) continue;
      for (let i = ci - ring; i <= ci + ring; i++) {
        if (i < 0 || i >= nav.w) continue;
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
        const c = j * nav.w + i;
        if (!nav.walk[c]) continue;
        const d = (cellX(nav, c) - x) ** 2 + (cellZ(nav, c) - z) ** 2;
        if (d < bestD) (bestD = d), (best = c);
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** True if a straight walk between two points stays on walkable cells. */
export function walkableLine(nav: NavGrid, x0: number, z0: number, x1: number, z1: number): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.3));
  // Check a strip as wide as the pilot, so smoothed paths do not clip corners.
  const len = Math.hypot(dx, dz) || 1;
  const sx = (-dz / len) * 0.35;
  const sz = (dx / len) * 0.35;
  for (let k = 0; k <= steps; k++) {
    const x = x0 + (dx * k) / steps;
    const z = z0 + (dz * k) / steps;
    if (!isWalkable(nav, x, z) || !isWalkable(nav, x + sx, z + sz) || !isWalkable(nav, x - sx, z - sz)) return false;
  }
  return true;
}

/** A random point in the map's main walkable area, written to `out`. */
export function randomNavPoint(nav: NavGrid, rng: Rng, out: { x: number; z: number }): void {
  const c = nav.open[Math.floor(rand(rng) * nav.open.length)];
  out.x = cellX(nav, c);
  out.z = cellZ(nav, c);
}

const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NZ = [0, 0, 1, -1, 1, -1, 1, -1];
const raw: number[] = [];

/**
 * Shortest path on the grid (A*, 8 directions, no cutting corners), then pulled
 * tight. Appends world-space waypoints as x, z pairs to `out` and returns true,
 * or returns false when there is no way through.
 */
export function findPath(nav: NavGrid, sx: number, sz: number, gx: number, gz: number, out: number[]): boolean {
  out.length = 0;
  const start = nearestWalkable(nav, sx, sz);
  const goal = nearestWalkable(nav, gx, gz);
  if (start < 0 || goal < 0 || nav.area[start] !== nav.area[goal]) return false;
  const { w, h, g, f, from, stamp, closed, heap, walk } = nav;
  const id = ++nav.search;
  const gi = goal % w;
  const gj = Math.floor(goal / w);

  let size = 0;
  const push = (c: number): void => {
    let i = size++;
    heap[i] = c;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (f[heap[parent]] <= f[c]) break;
      heap[i] = heap[parent];
      i = parent;
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
    const ci = c % w;
    const cj = Math.floor(c / w);
    for (let k = 0; k < 8; k++) {
      const ni = ci + NX[k];
      const nj = cj + NZ[k];
      if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      const nc = nj * w + ni;
      if (!walk[nc] || closed[nc] === id) continue;
      // A diagonal step needs both cells beside it free.
      if (k >= 4 && (!walk[cj * w + ni] || !walk[nj * w + ci])) continue;
      const cost = g[c] + (k >= 4 ? Math.SQRT2 : 1);
      if (stamp[nc] === id && cost >= g[nc]) continue;
      const di = Math.abs(ni - gi);
      const dj = Math.abs(nj - gj);
      g[nc] = cost;
      f[nc] = cost + Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj);
      from[nc] = c;
      stamp[nc] = id;
      // The heap may hold an older, worse entry for this cell; it is skipped when popped.
      if (size < heap.length) push(nc);
    }
  }
  if (!found) return false;

  raw.length = 0;
  for (let c = goal; c >= 0; c = from[c]) raw.push(cellZ(nav, c), cellX(nav, c));
  raw.reverse();
  // The real start and goal replace the first and last cell centers when they are walkable.
  if (isWalkable(nav, sx, sz)) (raw[0] = sx), (raw[1] = sz);
  if (isWalkable(nav, gx, gz)) (raw[raw.length - 2] = gx), (raw[raw.length - 1] = gz);

  // String pulling: from each kept point, jump to the farthest point in plain sight.
  const count = raw.length / 2;
  let i = 0;
  out.push(raw[0], raw[1]);
  while (i < count - 1) {
    let j = Math.min(count - 1, i + 40);
    while (j > i + 1 && !walkableLine(nav, raw[i * 2], raw[i * 2 + 1], raw[j * 2], raw[j * 2 + 1])) j--;
    out.push(raw[j * 2], raw[j * 2 + 1]);
    i = j;
  }
  return true;
}
