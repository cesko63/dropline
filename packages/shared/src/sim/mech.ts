import halberd from '../../../../data/mechs/halberd.json';
import type { InputCmd } from '../input';
import { clamp, copyV, dot, lenH, v3, type Vec3 } from '../math/vec3';
import type { Actor } from './combat';
import { raySphere, rayUprightCapsule, type ActorHit } from './hitscan';
import { GROUND_PROBE, SKIN, eyeHeight, findGroundAt, playerHeight, stepBody } from './movement';
import { WEAPONS } from './weapons';
import type { CollisionWorld } from './world';

/**
 * The war mech: a slow, tall machine a pilot calls down and climbs into. This
 * file holds the machine itself (its body, how it moves, where it can be hit).
 * What happens to it in a match (the drop, getting in and out, its weapons)
 * lives in `mechMatch.ts` and `rules.ts`.
 */

/** The frame's numbers. Edit /data/mechs/halberd.json, not this file. */
export const MECH = halberd;

/**
 * - `none`: the pilot has no mech out.
 * - `dropping`: called and on its way; it lands at `pos`.
 * - `idle`: standing empty, waiting for its pilot.
 * - `boot`: the pilot is inside and it is starting up.
 * - `piloted`: under the pilot's control.
 */
export type MechStateName = 'none' | 'dropping' | 'idle' | 'boot' | 'piloted';

/** Bit flags set in `Mech.events` for the tick they happened in. */
export const MechEvent = {
  Step: 1,
  Land: 2,
  Dash: 4,
} as const;

export interface Mech {
  /** Same as the owner's actor id: every pilot has one mech slot. */
  id: number;
  team: number;
  state: MechStateName;
  /** Seconds in the current state. */
  stateTime: number;

  /** Feet position. */
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  groundNormal: Vec3;
  fallSpeed: number;
  landSpeed: number;

  health: number;
  /** Rounds left in each of the mech's weapons. They stay with the mech when the pilot gets out. */
  ammo: number[];

  /** Dashes available; the fraction is the next one recharging. */
  dashCharges: number;
  /** Seconds left of the current dash, 0 when not dashing. */
  dashTime: number;
  dashX: number;
  dashZ: number;
  dashHeld: boolean;
  /** Who the current dash has already hit, as bits: actor ids, and mech ids shifted by 16. */
  rammed: number;

  /** Seconds until the rocket salvo is ready again. */
  salvoCooldown: number;
  /** Rockets still to leave in the current salvo, and seconds until the next one. */
  salvoLeft: number;
  salvoNext: number;

  /** Ground covered since the last footfall, meters. */
  stride: number;
  events: number;
  /** Actor id that last damaged it, or -1. */
  lastAttacker: number;
}

export function createMech(id: number, team: number): Mech {
  return {
    id,
    team,
    state: 'none',
    stateTime: 0,
    pos: v3(),
    vel: v3(),
    yaw: 0,
    pitch: 0,
    grounded: true,
    groundNormal: v3(0, 1, 0),
    fallSpeed: 0,
    landSpeed: 0,
    health: 0,
    ammo: MECH.loadout.map((w) => WEAPONS[w].magSize),
    dashCharges: MECH.dash.charges,
    dashTime: 0,
    dashX: 0,
    dashZ: 0,
    dashHeld: false,
    rammed: 0,
    salvoCooldown: 0,
    salvoLeft: 0,
    salvoNext: 0,
    stride: 0,
    events: 0,
    lastAttacker: -1,
  };
}

/** A fresh machine at a place: full hull, full magazines, everything ready. */
export function resetMech(k: Mech, pos: Vec3, yaw: number): void {
  const id = k.id;
  const team = k.team;
  Object.assign(k, createMech(id, team));
  copyV(k.pos, pos);
  k.yaw = yaw;
  k.health = MECH.health;
}

/** In the world and able to be hit, pushed and shot at. */
export const mechActive = (k: Mech): boolean => k.state === 'idle' || k.state === 'boot' || k.state === 'piloted';

/** Eye height above the feet: the pilot's own, or the cockpit's while in a mech. */
export const eyeOf = (a: Actor): number => (a.inMech ? MECH.body.eye : eyeHeight(a.p));

/** Height of what stands at the actor's position: the pilot, or the mech around them. */
export const heightOf = (a: Actor): number => (a.inMech ? MECH.body.height : playerHeight(a.p));

// ---------------------------------------------------------------- hitbox

const hit: ActorHit = { t: 0, head: false };

/**
 * Ray against a mech: one tall capsule, plus the reactor vent that sticks out of
 * its back. A hit on the vent (`head` in the result) does extra damage, so the
 * way to beat a mech is to get behind it. Returns a shared object.
 */
export function rayMech(o: Vec3, d: Vec3, k: { pos: Vec3; yaw: number }, maxT: number): ActorHit | null {
  const B = MECH.body;
  const V = MECH.vent;
  const tBody = rayUprightCapsule(o, d, k.pos.x, k.pos.z, k.pos.y + B.radius, k.pos.y + B.height - B.radius, B.radius);
  // Forward is (-sin yaw, -cos yaw), so the back is the opposite.
  const tVent = raySphere(o, d, k.pos.x + Math.sin(k.yaw) * V.back, k.pos.y + V.height, k.pos.z + Math.cos(k.yaw) * V.back, V.radius);
  const crit = tVent >= 0 && (tBody < 0 || tVent <= tBody + 0.05);
  const t = crit ? tVent : tBody;
  if (t < 0 || t > maxT) return null;
  hit.t = t;
  hit.head = crit;
  return hit;
}

/** Distance from a point to the mech's surface (0 inside it). */
export function distToMech(k: Mech, x: number, y: number, z: number): number {
  const B = MECH.body;
  const cy = clamp(y, k.pos.y + B.radius, k.pos.y + B.height - B.radius);
  return Math.max(0, Math.hypot(x - k.pos.x, y - cy, z - k.pos.z) - B.radius);
}

// ---------------------------------------------------------------- movement

/**
 * Advance a mech's body by one tick. It walks, sprints and falls like a heavy
 * pilot, cannot jump, and dashes instead: `cmd.jump` spends a charge on a short
 * burst in the direction of travel. With `driven` false the command is ignored
 * and the machine just stands (or keeps falling).
 */
export function stepMechBody(k: Mech, cmd: InputCmd, w: CollisionWorld, dt: number, driven: boolean, others: readonly Mech[]): void {
  const B = MECH.body;
  const M = MECH.move;
  const D = MECH.dash;
  const vel = k.vel;
  k.events = 0;
  if (driven) {
    k.yaw = cmd.yaw;
    k.pitch = cmd.pitch;
  }
  const dashPressed = driven && cmd.jump && !k.dashHeld;
  k.dashHeld = driven && cmd.jump;
  k.dashCharges = Math.min(D.charges, k.dashCharges + dt / D.rechargeTime);

  const ground = findGroundAt(k.pos, B.radius, B.height, w, GROUND_PROBE);
  if (ground !== null && dot(vel, ground.normal) <= 0.5) {
    if (!k.grounded) {
      k.events |= MechEvent.Land;
      k.landSpeed = k.fallSpeed;
    }
    k.grounded = true;
    k.fallSpeed = 0;
    copyV(k.groundNormal, ground.normal);
  } else {
    k.grounded = false;
  }

  // Where the pilot wants to go, as a unit direction on the ground.
  let wx = 0;
  let wz = 0;
  let mag = 0;
  const sin = Math.sin(k.yaw);
  const cos = Math.cos(k.yaw);
  if (driven) {
    const mx = clamp(cmd.moveX, -1, 1);
    const mz = clamp(cmd.moveZ, -1, 1);
    wx = -sin * mz + cos * mx;
    wz = -cos * mz - sin * mx;
    mag = Math.hypot(wx, wz);
    if (mag > 1e-4) {
      wx /= mag;
      wz /= mag;
      mag = Math.min(1, mag);
    } else {
      mag = 0;
    }
  }

  if (dashPressed && k.dashCharges >= 1 && k.dashTime <= 0 && k.grounded) {
    k.dashCharges -= 1;
    k.dashTime = D.time;
    // Standing still, the dash goes where the mech faces.
    k.dashX = mag > 0 ? wx : -sin;
    k.dashZ = mag > 0 ? wz : -cos;
    k.rammed = 0;
    k.events |= MechEvent.Dash;
  }

  if (k.dashTime > 0) {
    k.dashTime = Math.max(0, k.dashTime - dt);
    // Full speed for most of the dash, easing down to a run over the last third.
    const speed = M.sprintSpeed + (D.speed - M.sprintSpeed) * Math.min(1, (k.dashTime / D.time) * 3);
    vel.x = k.dashX * speed;
    vel.z = k.dashZ * speed;
  } else if (k.grounded) {
    const speed = lenH(vel);
    if (speed < 0.01) {
      vel.x = vel.z = 0;
    } else {
      const keep = Math.max(0, speed - Math.max(speed, M.stopSpeed) * M.friction * dt) / speed;
      vel.x *= keep;
      vel.z *= keep;
    }
    if (mag > 0) {
      const wishSpeed = (cmd.sprint && cmd.moveZ > 0 ? M.sprintSpeed : M.walkSpeed) * mag;
      const add = wishSpeed - (vel.x * wx + vel.z * wz);
      if (add > 0) {
        const gain = Math.min(add, M.accel * dt * wishSpeed);
        vel.x += gain * wx;
        vel.z += gain * wz;
      }
    }
  }

  // Mechs do not walk through each other: cancel the approach and ease them apart.
  for (const o of others) {
    if (o === k || !mechActive(o)) continue;
    if (Math.abs(o.pos.y - k.pos.y) > B.height) continue;
    const ax = k.pos.x - o.pos.x;
    const az = k.pos.z - o.pos.z;
    const d = Math.hypot(ax, az);
    if (d >= B.radius * 2 || d < 1e-3) continue;
    const nx = ax / d;
    const nz = az / d;
    const into = -(vel.x * nx + vel.z * nz);
    if (into > 0) {
      vel.x += nx * into;
      vel.z += nz * into;
    }
    const push = (B.radius * 2 - d) * 4;
    vel.x += nx * push;
    vel.z += nz * push;
  }

  if (k.grounded) {
    // Keep the velocity in the ground plane, as pilots do.
    const n = k.groundNormal;
    vel.y = -(vel.x * n.x + vel.z * n.z) / n.y;
  } else {
    vel.y = Math.max(-M.maxFallSpeed, vel.y - M.gravity * dt);
    k.fallSpeed = Math.max(0, -vel.y);
  }

  const fromX = k.pos.x;
  const fromZ = k.pos.z;
  stepBody(k, B.radius, B.height, B.stepHeight, w, dt, k.grounded);

  if (!k.grounded) return;
  const down = findGroundAt(k.pos, B.radius, B.height, w, B.stepHeight);
  if (!down) {
    k.grounded = false;
    return;
  }
  k.pos.y -= Math.max(0, down.dist - SKIN);
  copyV(k.groundNormal, down.normal);
  vel.y = -(vel.x * down.normal.x + vel.z * down.normal.z) / down.normal.y;

  k.stride += Math.hypot(k.pos.x - fromX, k.pos.z - fromZ);
  if (k.stride >= M.strideLength) {
    k.stride -= M.strideLength;
    k.events |= MechEvent.Step;
  }
}
