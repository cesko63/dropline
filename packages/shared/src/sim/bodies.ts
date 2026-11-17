import { v3 } from '../math/vec3';
import { COMBAT, type Actor, type MatchState } from './combat';
import { frameOf, mechActive, type Mech } from './mech';
import { SKIN, playerHeight, type PlayerState } from './movement';
import { TUNING } from './tuning';
import type { CollisionWorld } from './world';

/**
 * Pilots are solid: they do not pass through each other or through a mech.
 *
 * Runs right after a pilot has moved. Walking into a body stops the part of the
 * motion that heads into it; what overlap is left is pushed out at a limited
 * speed, swept through the map so nobody is shoved into a wall. Two pilots share
 * the push between them; a mech does not give way at all. A pilot climbing out
 * of the hatch passes through the top of their own mech.
 *
 * Bodies are upright cylinders here: a pilot cannot stand on another pilot's
 * head or on a mech, and slides off to the side instead.
 *
 * **Online, a player bumps into what they see.** A client predicts its own pilot
 * against the others where it draws them, a little in the past. The server
 * pushes that player against the same moment (their view tick, rebuilt the way
 * the client drew it: `rewindBodies` in `lagcomp.ts`) instead of where the
 * others are by now, so the two agree and pushing past someone costs no correction. Bots, and everyone offline, are pushed
 * against where things stand now.
 */

const B = COMBAT.bodies;

/** Values per body in a `Bodies` table. */
const STRIDE = 5;

/**
 * Where every body stands, as `pushApart` sees them. Per pilot: x, y, z,
 * height, present (alive and on foot); then per mech: x, y, z, yaw, active.
 */
export type Bodies = Float64Array;

export const createBodies = (actors: number): Bodies => new Float64Array(actors * 2 * STRIDE);

/** Fill `out` with where everyone stands right now. */
export function liveBodies(m: MatchState, out: Bodies): Bodies {
  let i = 0;
  for (const a of m.actors) {
    out[i++] = a.p.pos.x;
    out[i++] = a.p.pos.y;
    out[i++] = a.p.pos.z;
    out[i++] = playerHeight(a.p);
    out[i++] = a.alive && !a.inMech ? 1 : 0;
  }
  for (const k of m.mechs) {
    out[i++] = k.pos.x;
    out[i++] = k.pos.y;
    out[i++] = k.pos.z;
    out[i++] = k.yaw;
    out[i++] = mechActive(k) ? 1 : 0;
  }
  return out;
}

const push = v3();
const dir = v3();

/** Take away the part of `vel` that heads into a body lying in direction -n. */
function block(p: PlayerState, nx: number, nz: number): void {
  const into = -(p.vel.x * nx + p.vel.z * nz);
  if (into <= 0) return;
  p.vel.x += nx * into;
  p.vel.z += nz * into;
}

/**
 * Move pilot `a` out of the bodies in `bodies` (which may include `a` itself; it
 * is skipped). `mechs` gives each mech's frame, and so its size.
 */
export function pushApart(a: Actor, bodies: Bodies, mechs: readonly Mech[], world: CollisionWorld, dt: number): void {
  const p = a.p;
  // A mantle follows its own path over the ledge; it is pushed again once it lands.
  if (p.mantle.active) return;
  const n = bodies.length / (2 * STRIDE);
  const r = TUNING.player.radius;
  const h = playerHeight(p);
  let ax = 0;
  let az = 0;

  for (let id = 0; id < n; id++) {
    const i = id * STRIDE;
    if (id === a.id || bodies[i + 4] !== 1) continue;
    const oy = bodies[i + 1];
    if (oy >= p.pos.y + h || p.pos.y >= oy + bodies[i + 3]) continue;
    const dx = p.pos.x - bodies[i];
    const dz = p.pos.z - bodies[i + 2];
    const d = Math.hypot(dx, dz);
    if (d >= r * 2) continue;
    // Standing exactly on the same spot: the higher id steps aside to +x, so both agree.
    const nx = d > 1e-4 ? dx / d : a.id > id ? 1 : -1;
    const nz = d > 1e-4 ? dz / d : 0;
    block(p, nx, nz);
    ax += nx * (r * 2 - d) * B.pilotShare;
    az += nz * (r * 2 - d) * B.pilotShare;
  }
  let len = Math.hypot(ax, az);
  let limit = B.pilotPushSpeed * dt;
  if (len > limit) {
    ax *= limit / len;
    az *= limit / len;
  }
  push.x = ax;
  push.z = az;

  ax = az = 0;
  for (let id = 0; id < n; id++) {
    const i = (n + id) * STRIDE;
    if (bodies[i + 4] !== 1) continue;
    const ky = bodies[i + 1];
    const body = frameOf(mechs[id]).body;
    const reach = r + body.radius;
    // The hatch is open to its own pilot: they climb out through the top.
    const top = ky + body.height - (id === a.id ? B.hatch : 0);
    if (p.pos.y >= top || ky >= p.pos.y + h) continue;
    const dx = p.pos.x - bodies[i];
    const dz = p.pos.z - bodies[i + 2];
    const d = Math.hypot(dx, dz);
    if (d >= reach) continue;
    // Right under its center: step out the way the mech faces.
    const nx = d > 1e-4 ? dx / d : -Math.sin(bodies[i + 3]);
    const nz = d > 1e-4 ? dz / d : -Math.cos(bodies[i + 3]);
    block(p, nx, nz);
    ax += nx * (reach - d);
    az += nz * (reach - d);
  }
  len = Math.hypot(ax, az);
  limit = B.mechPushSpeed * dt;
  if (len > limit) {
    ax *= limit / len;
    az *= limit / len;
  }
  push.x += ax;
  push.z += az;

  len = Math.hypot(push.x, push.z);
  if (len < 1e-5) return;
  dir.x = push.x / len;
  dir.y = 0;
  dir.z = push.z / len;
  // Never through the map: stop short of whatever is in the way.
  const hit = world.castCapsule(p.pos, h, dir, len + SKIN, r);
  const go = hit ? Math.max(0, hit.dist - SKIN) : len;
  p.pos.x += dir.x * go;
  p.pos.z += dir.z * go;
}
