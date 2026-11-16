import net from '../../../../data/net.json';
import { v3, type Vec3 } from '../math/vec3';
import type { MatchState } from './combat';
import { mechActive } from './mech';
import { playerHeight } from './movement';
import { TICK_RATE } from './tuning';

/** Networking numbers shared by server and client. Edit /data/net.json, not this file. */
export const NET = net;

/**
 * Lag compensation. A player sees everyone else a little in the past: the
 * snapshot took time to arrive and is then drawn behind by the interpolation
 * delay. So when their shot reaches the server, the targets have moved on. The
 * server keeps where everyone stood for the last second and traces each
 * player's shot against the moment that player was looking at.
 *
 * Nothing is moved to do this: `rewindView` hands back the old positions and
 * the shot is traced against those instead of the live ones.
 */

/** Values stored per pilot and per mech in one frame. */
const STRIDE = 5;

export interface LagHistory {
  /** Frames kept. */
  size: number;
  actors: number;
  /** Tick each slot holds, or -1. */
  ticks: Int32Array;
  /**
   * Per frame: every pilot as x, y, z, height, visible; then every mech as
   * x, y, z, yaw, active.
   */
  data: Float64Array;
  /**
   * The ticks snapshots go out on: those where `(tick + snapOffset) % snapEvery`
   * is 0. Set by the server; clients only ever see the world on these ticks.
   */
  snapEvery: number;
  snapOffset: number;
}

export function createHistory(actors: number, seconds = NET.historySeconds): LagHistory {
  const size = Math.ceil(seconds * TICK_RATE) + 2;
  return { size, actors, ticks: new Int32Array(size).fill(-1), data: new Float64Array(size * actors * 2 * STRIDE), snapEvery: 1, snapOffset: 0 };
}

/** Rounded to the centimeter, as snapshots carry positions to clients. */
const cm = (v: number): number => Math.round(v * 100) / 100;

/**
 * Store where everyone stands after the tick that just ran, rounded the way
 * snapshots round it, so the past the server rebuilds is the one clients drew.
 */
export function recordHistory(m: MatchState, h: LagHistory): void {
  const slot = m.tick % h.size;
  h.ticks[slot] = m.tick;
  let i = slot * h.actors * 2 * STRIDE;
  for (const a of m.actors) {
    h.data[i++] = cm(a.p.pos.x);
    h.data[i++] = cm(a.p.pos.y);
    h.data[i++] = cm(a.p.pos.z);
    h.data[i++] = playerHeight(a.p);
    h.data[i++] = a.alive && !a.inMech ? 1 : 0;
  }
  for (const k of m.mechs) {
    h.data[i++] = cm(k.pos.x);
    h.data[i++] = cm(k.pos.y);
    h.data[i++] = cm(k.pos.z);
    h.data[i++] = k.yaw;
    h.data[i++] = mechActive(k) ? 1 : 0;
  }
}

export interface RewindView {
  /** The tick that was rebuilt, after clamping to what is allowed and what is kept. */
  tick: number;
  /** Per pilot: where it stood, or null when it could not be seen then (dead, or inside a mech). */
  actors: ({ pos: Vec3; height: number } | null)[];
  /** Per mech: where it stood, or null when it was not in the world. */
  mechs: ({ pos: Vec3; yaw: number } | null)[];
}

const view: RewindView = { tick: 0, actors: [], mechs: [] };
const actorStore: { pos: Vec3; height: number }[] = [];
const mechStore: { pos: Vec3; yaw: number }[] = [];

/** A step this long between two frames is a respawn or a seat change, not movement. */
const TELEPORT = 4;

/** Slot of a frame for `tick`, or -1 when it is no longer (or not yet) kept. */
const frameOf = (h: LagHistory, tick: number): number => {
  if (tick < 0) return -1;
  const slot = tick % h.size;
  return h.ticks[slot] === tick ? slot : -1;
};

/**
 * Where everyone stood at `viewTick` (fractional, between two stored frames),
 * for a shot fired during tick `now`. The rewind is capped: a player lagging
 * further behind than `NET.rewindCap` has to lead their shots. Returns a shared
 * object, or null when nothing that old is kept.
 */
export function rewindView(h: LagHistory, now: number, viewTick: number): RewindView | null {
  // The newest frame is the previous tick: nobody can have seen later than that.
  const newest = now - 1;
  const t = Math.min(newest, Math.max(newest - NET.rewindCap * TICK_RATE, viewTick));
  const t0 = Math.floor(t);
  let f = t - t0;
  let a = frameOf(h, t0);
  let b = frameOf(h, t0 + 1);
  if (a < 0 && b < 0) return null;
  if (a < 0) a = b;
  if (b < 0 || f === 0) {
    b = a;
    f = 0;
  }
  const per = h.actors * 2 * STRIDE;
  view.tick = t;
  for (let i = 0; i < h.actors * 2; i++) {
    const mech = i >= h.actors;
    const ia = a * per + i * STRIDE;
    const ib = b * per + i * STRIDE;
    const d = h.data;
    const seenA = d[ia + 4] === 1;
    const seenB = d[ib + 4] === 1;
    const jumped = Math.hypot(d[ib] - d[ia], d[ib + 1] - d[ia + 1], d[ib + 2] - d[ia + 2]) > TELEPORT;
    // Between a frame where it was there and one where it was not (or across a
    // respawn), the nearer frame decides.
    let from = ia;
    let k = f;
    if (!seenA || !seenB || jumped) {
      from = f < 0.5 ? ia : ib;
      k = 0;
    }
    const idx = mech ? i - h.actors : i;
    if (d[from + 4] !== 1) {
      if (mech) view.mechs[idx] = null;
      else view.actors[idx] = null;
      continue;
    }
    const x = d[from] + (d[ib] - d[from]) * k;
    const y = d[from + 1] + (d[ib + 1] - d[from + 1]) * k;
    const z = d[from + 2] + (d[ib + 2] - d[from + 2]) * k;
    if (mech) {
      const out = (mechStore[idx] ??= { pos: v3(), yaw: 0 });
      out.pos.x = x;
      out.pos.y = y;
      out.pos.z = z;
      // The yaw only places the vent; the nearer frame is close enough and never wraps.
      out.yaw = d[(k < 0.5 ? from : ib) + 3];
      view.mechs[idx] = out;
    } else {
      const out = (actorStore[idx] ??= { pos: v3(), height: 0 });
      out.pos.x = x;
      out.pos.y = y;
      out.pos.z = z;
      out.height = d[(k < 0.5 ? from : ib) + 3];
      view.actors[idx] = out;
    }
  }
  return view;
}

/**
 * Where everyone stood at `viewTick` exactly as the player's client drew it,
 * into `out` (laid out as `Bodies` in `bodies.ts`). Unlike `rewindView`, which
 * blends neighbouring ticks, this rebuilds the client's own interpolation: from
 * the snapshot at or before the moment to the next one, on the same rounded
 * positions, gliding only where the client glides. So a pilot pushed against it
 * on the server ends up exactly where the client predicted. False when nothing
 * that old is kept.
 */
export function rewindBodies(h: LagHistory, now: number, viewTick: number, out: Float64Array): boolean {
  const newest = now - 1;
  const t = Math.min(newest, Math.max(newest - NET.rewindCap * TICK_RATE, viewTick));
  const every = h.snapEvery;
  const whole = Math.floor(t);
  const t0 = whole - ((((whole + h.snapOffset) % every) + every) % every);
  const a = frameOf(h, t0);
  if (a < 0) return false;
  let b = frameOf(h, t0 + every);
  let f = Math.max(0, Math.min(1, (t - t0) / every));
  if (b < 0) {
    b = a;
    f = 0;
  }
  const per = h.actors * 2 * STRIDE;
  const d = h.data;
  for (let i = 0; i < h.actors * 2; i++) {
    const ia = a * per + i * STRIDE;
    const ib = b * per + i * STRIDE;
    const o = i * STRIDE;
    const here = d[ia + 4] === 1;
    // The client glides only between two frames where the body is there both
    // times and has not jumped (a respawn, a seat change); otherwise it holds the first.
    const glide = here && d[ib + 4] === 1 && Math.hypot(d[ib] - d[ia], d[ib + 1] - d[ia + 1], d[ib + 2] - d[ia + 2]) < TELEPORT;
    const k = glide ? f : 0;
    out[o] = d[ia] + (d[ib] - d[ia]) * k;
    out[o + 1] = d[ia + 1] + (d[ib + 1] - d[ia + 1]) * k;
    out[o + 2] = d[ia + 2] + (d[ib + 2] - d[ia + 2]) * k;
    out[o + 3] = d[ia + 3];
    out[o + 4] = here ? 1 : 0;
  }
  return true;
}
