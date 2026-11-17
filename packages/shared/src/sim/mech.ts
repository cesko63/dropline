import bastion from '../../../../data/mechs/bastion.json';
import halberd from '../../../../data/mechs/halberd.json';
import lynx from '../../../../data/mechs/lynx.json';
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

/** A dash in the direction of travel that rams whatever it runs into. */
export interface DashMove {
  kind: 'dash';
  charges: number;
  rechargeTime: number;
  speed: number;
  time: number;
  ramRadius: number;
  ramDamage: number;
  ramArmor: number;
  ramKnock: number;
}

/** Jump jets: a hop up and in the direction of travel. */
export interface LeapMove {
  kind: 'leap';
  charges: number;
  rechargeTime: number;
  /** Speed straight up and along the ground at take-off, m/s. */
  up: number;
  forward: number;
}

/** A blow to the ground that hurts and throws off everyone close by. */
export interface StompMove {
  kind: 'stomp';
  charges: number;
  rechargeTime: number;
  radius: number;
  /** Damage to a pilot at the mech's feet; half of it is left at the edge. */
  damage: number;
  /** Damage to an enemy mech inside the radius. */
  armor: number;
  /** Speed a pilot is thrown away and up with. */
  knock: number;
  lift: number;
}

/** Rockets from the shoulder pod, one after another, toward the point the pilot looks at. */
export interface SalvoAbility {
  kind: 'salvo';
  projectile: string;
  count: number;
  interval: number;
  cooldown: number;
  spreadDeg: number;
  /** The pod's offset from the middle of the body: to the right (negative is left) and up. */
  side: number;
  height: number;
}

/**
 * A wall of energy held up in front of the mech. It stops enemy fire aimed at
 * the mech and at anyone behind it, until its own pool runs out. The cannon
 * cannot fire through it and the mech walks slowly while it is up.
 */
export interface ShieldAbility {
  kind: 'shield';
  /** The pool that hits drain, and what it drains by per second while up. */
  health: number;
  drain: number;
  /** Refills this much per second once it has been down and unhit for `regenDelay` seconds. */
  regen: number;
  regenDelay: number;
  /** Seconds before it can go up again after being broken. */
  brokenTime: number;
  /** Top speed while up, as a share of walking speed. */
  slow: number;
  /** The wall: distance in front of the mech's middle, width and height. */
  forward: number;
  width: number;
  height: number;
}

/** Active camouflage: hard to see, and invisible to bots past `revealRange`. Firing ends it. */
export interface CloakAbility {
  kind: 'cloak';
  time: number;
  cooldown: number;
  revealRange: number;
}

/**
 * One mech frame's numbers: hull, body, movement, the jump button's move, the
 * aim button's ability, the weapon, and the bot role that drives it. Edit the
 * files in /data/mechs, not this one.
 */
export interface MechFrame {
  id: string;
  name: string;
  short: string;
  /** One line about how it plays, for the HUD. */
  blurb: string;
  health: number;
  body: { radius: number; height: number; eye: number; stepHeight: number };
  move: {
    walkSpeed: number;
    sprintSpeed: number;
    accel: number;
    /** Steering in the air, as `accel` is on the ground. Only a frame that leaves the ground needs it. */
    airAccel: number;
    friction: number;
    stopSpeed: number;
    gravity: number;
    maxFallSpeed: number;
    strideLength: number;
  };
  mobility: DashMove | LeapMove | StompMove;
  vent: { back: number; height: number; radius: number; mult: number };
  loadout: string[];
  ability: SalvoAbility | ShieldAbility | CloakAbility;
  botRole: string;
}

/** Every frame, in the order the frame choice cycles through. A mech stores its index. */
export const FRAME_LIST = [halberd, bastion, lynx] as unknown as MechFrame[];

export const FRAMES: Record<string, MechFrame> = Object.fromEntries(FRAME_LIST.map((f) => [f.id, f]));

/** Index of a frame by id, or 0 (the Halberd) for an unknown one. */
export const frameIndex = (id: string): number => Math.max(0, FRAME_LIST.findIndex((f) => f.id === id));

/** A mech's frame. */
export const frameOf = (k: { frame: number }): MechFrame => FRAME_LIST[k.frame] ?? FRAME_LIST[0];

/** The room the largest frame needs: what map checks and the mech nav grid are made for. */
export const MECH_ENVELOPE = {
  radius: Math.max(...FRAME_LIST.map((f) => f.body.radius)),
  height: Math.max(...FRAME_LIST.map((f) => f.body.height)),
  stepHeight: Math.min(...FRAME_LIST.map((f) => f.body.stepHeight)),
};

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
  Leap: 8,
  Stomp: 16,
} as const;

export interface Mech {
  /** Same as the owner's actor id: every pilot has one mech slot. */
  id: number;
  team: number;
  /** Index into `FRAME_LIST`, chosen when it is called. */
  frame: number;
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

  /** Uses of the jump button's move (dash, leap or stomp) available; the fraction is the next one recharging. */
  charges: number;
  /** Seconds left of the current dash, 0 when not dashing. */
  dashTime: number;
  dashX: number;
  dashZ: number;
  jumpHeld: boolean;
  /** Who the current dash has already hit, as bits: actor ids, and mech ids shifted by 16. */
  rammed: number;

  /** Seconds until the ability (salvo, shield, cloak) can be used again. */
  abilityCooldown: number;
  /** Rockets still to leave in the current salvo, and seconds until the next one. */
  salvoLeft: number;
  salvoNext: number;
  /** What the shield can still take, whether it is up, and seconds since it was last up or hit. */
  shield: number;
  shieldUp: boolean;
  shieldRest: number;
  /** Seconds of cloak left, 0 when visible. */
  cloak: number;

  /** Ground covered since the last footfall, meters. */
  stride: number;
  events: number;
  /** Actor id that last damaged it, or -1. */
  lastAttacker: number;
}

export function createMech(id: number, team: number, frame = 0): Mech {
  const F = FRAME_LIST[frame] ?? FRAME_LIST[0];
  const A = F.ability;
  return {
    id,
    team,
    frame,
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
    ammo: F.loadout.map((w) => WEAPONS[w].magSize),
    charges: F.mobility.charges,
    dashTime: 0,
    dashX: 0,
    dashZ: 0,
    jumpHeld: false,
    rammed: 0,
    abilityCooldown: 0,
    salvoLeft: 0,
    salvoNext: 0,
    shield: A.kind === 'shield' ? A.health : 0,
    shieldUp: false,
    shieldRest: 0,
    cloak: 0,
    stride: 0,
    events: 0,
    lastAttacker: -1,
  };
}

/** A fresh machine of a frame at a place: full hull, full magazines, everything ready. */
export function resetMech(k: Mech, pos: Vec3, yaw: number, frame = 0): void {
  Object.assign(k, createMech(k.id, k.team, frame));
  copyV(k.pos, pos);
  k.yaw = yaw;
  k.health = frameOf(k).health;
}

/** In the world and able to be hit, pushed and shot at. */
export const mechActive = (k: Mech): boolean => k.state === 'idle' || k.state === 'boot' || k.state === 'piloted';

/** Eye height above the feet: the pilot's own, or the cockpit's while in a mech. */
export const eyeOf = (m: { mechs: Mech[] }, a: Actor): number => (a.inMech ? frameOf(m.mechs[a.id]).body.eye : eyeHeight(a.p));

/** Height of what stands at the actor's position: the pilot, or the mech around them. */
export const heightOf = (m: { mechs: Mech[] }, a: Actor): number => (a.inMech ? frameOf(m.mechs[a.id]).body.height : playerHeight(a.p));

// ---------------------------------------------------------------- hitbox

const hit: ActorHit = { t: 0, head: false };

/**
 * Ray against a mech of frame `F`: one tall capsule, plus the reactor vent that
 * sticks out of its back. A hit on the vent (`head` in the result) does extra
 * damage, so the way to beat a mech is to get behind it. Returns a shared object.
 */
export function rayMech(o: Vec3, d: Vec3, k: { pos: Vec3; yaw: number }, F: MechFrame, maxT: number): ActorHit | null {
  const B = F.body;
  const V = F.vent;
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

/**
 * Ray against the front face of a raised shield (`k` placed as `at`, which may
 * be where it stood in the past). Only rays coming at it from the front are
 * stopped. Returns the distance, or -1 for a miss.
 */
export function rayShield(o: Vec3, d: Vec3, k: Mech, at: { pos: Vec3; yaw: number }, maxT: number): number {
  const S = frameOf(k).ability;
  if (S.kind !== 'shield' || !k.shieldUp) return -1;
  const nx = -Math.sin(at.yaw);
  const nz = -Math.cos(at.yaw);
  const into = d.x * nx + d.z * nz;
  if (into >= -1e-6) return -1;
  const cx = at.pos.x + nx * S.forward;
  const cz = at.pos.z + nz * S.forward;
  const t = ((cx - o.x) * nx + (cz - o.z) * nz) / into;
  if (t < 0 || t > maxT) return -1;
  const px = o.x + d.x * t - cx;
  const py = o.y + d.y * t - at.pos.y;
  const pz = o.z + d.z * t - cz;
  // Along the wall: the right is (cos yaw, -sin yaw).
  if (Math.abs(px * -nz + pz * nx) > S.width / 2 || py < -0.3 || py > S.height) return -1;
  return t;
}

/** True when a point is in front of a raised shield's face, where a blast is the shield's to take. */
export function behindShield(k: Mech, x: number, z: number): boolean {
  const S = frameOf(k).ability;
  if (S.kind !== 'shield' || !k.shieldUp) return false;
  const nx = -Math.sin(k.yaw);
  const nz = -Math.cos(k.yaw);
  return (x - k.pos.x) * nx + (z - k.pos.z) * nz > S.forward - 0.3;
}

/** Distance from a point to the mech's surface (0 inside it). */
export function distToMech(k: Mech, x: number, y: number, z: number): number {
  const B = frameOf(k).body;
  const cy = clamp(y, k.pos.y + B.radius, k.pos.y + B.height - B.radius);
  return Math.max(0, Math.hypot(x - k.pos.x, y - cy, z - k.pos.z) - B.radius);
}

// ---------------------------------------------------------------- movement

/**
 * Advance a mech's body by one tick. It walks, sprints and falls like a heavy
 * pilot and cannot jump; `cmd.jump` spends a charge on its frame's move instead:
 * a dash in the direction of travel, a leap on jump jets, or a stomp (whose blow
 * `mechMatch.ts` deals). With `driven` false the command is ignored and the
 * machine just stands (or keeps falling).
 */
export function stepMechBody(k: Mech, cmd: InputCmd, w: CollisionWorld, dt: number, driven: boolean, others: readonly Mech[]): void {
  const F = frameOf(k);
  const B = F.body;
  const M = F.move;
  const J = F.mobility;
  const vel = k.vel;
  k.events = 0;
  if (driven) {
    k.yaw = cmd.yaw;
    k.pitch = cmd.pitch;
  }
  const jumpPressed = driven && cmd.jump && !k.jumpHeld;
  k.jumpHeld = driven && cmd.jump;
  k.charges = Math.min(J.charges, k.charges + dt / J.rechargeTime);

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

  if (jumpPressed && k.charges >= 1 && k.dashTime <= 0 && k.grounded) {
    k.charges -= 1;
    // Standing still, a dash or a leap goes where the mech faces.
    const gx = mag > 0 ? wx : -sin;
    const gz = mag > 0 ? wz : -cos;
    if (J.kind === 'dash') {
      k.dashTime = J.time;
      k.dashX = gx;
      k.dashZ = gz;
      k.rammed = 0;
      k.events |= MechEvent.Dash;
    } else if (J.kind === 'leap') {
      // Running already, it keeps the speed it had if that is more.
      const along = Math.max(J.forward, vel.x * gx + vel.z * gz);
      vel.x = gx * along;
      vel.z = gz * along;
      vel.y = J.up;
      k.grounded = false;
      k.events |= MechEvent.Leap;
    } else {
      k.events |= MechEvent.Stomp;
    }
  }

  // The shield is heavy to carry: a walk at best.
  const A = F.ability;
  const shielded = A.kind === 'shield' && k.shieldUp;
  if (k.dashTime > 0 && J.kind === 'dash') {
    k.dashTime = Math.max(0, k.dashTime - dt);
    // Full speed for most of the dash, easing down to a run over the last third.
    const speed = M.sprintSpeed + (J.speed - M.sprintSpeed) * Math.min(1, (k.dashTime / J.time) * 3);
    vel.x = k.dashX * speed;
    vel.z = k.dashZ * speed;
  } else if (!k.grounded && mag > 0 && M.airAccel > 0) {
    // Jump jets steer a little in the air.
    const wishSpeed = M.sprintSpeed * mag;
    const add = wishSpeed - (vel.x * wx + vel.z * wz);
    if (add > 0) {
      const gain = Math.min(add, M.airAccel * dt * wishSpeed);
      vel.x += gain * wx;
      vel.z += gain * wz;
    }
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
      const top = shielded ? M.walkSpeed * A.slow : cmd.sprint && cmd.moveZ > 0 ? M.sprintSpeed : M.walkSpeed;
      const wishSpeed = top * mag;
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
    const reach = B.radius + frameOf(o).body.radius;
    if (d >= reach || d < 1e-3) continue;
    const nx = ax / d;
    const nz = az / d;
    const into = -(vel.x * nx + vel.z * nz);
    if (into > 0) {
      vel.x += nx * into;
      vel.z += nz * into;
    }
    const push = (reach - d) * 4;
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
