import type { InputCmd } from '../input';
import { addScaled, clamp, copyV, cross, dot, forwardFromYaw, lenH, lerp, rightFromYaw, v3, type Vec3 } from '../math/vec3';
import { TUNING as T } from './tuning';
import type { CastHit, CollisionWorld } from './world';

/**
 * Pilot movement. `stepPlayer` advances one fixed tick and depends only on the
 * state, the input and the static world, so the server can run it as the
 * authority and the client can replay it for prediction.
 */

/** Gap kept between the capsule and any surface so casts never start touching. */
export const SKIN = 0.012;
const MAX_BUMPS = 4;
export const GROUND_PROBE = 0.06;
const UP = v3(0, 1, 0);
const DOWN = v3(0, -1, 0);

/** Bit flags set in `PlayerState.events` for the tick they happened in. */
export const MoveEvent = {
  Jump: 1,
  DoubleJump: 2,
  Land: 4,
  WallrunStart: 8,
  WallJump: 16,
  SlideStart: 32,
  MantleStart: 64,
} as const;

/** What collision needs from anything that moves through the map: a pilot or a mech. */
export interface Body {
  /** Feet position. */
  pos: Vec3;
  vel: Vec3;
  groundNormal: Vec3;
}

export interface PlayerState {
  /** Feet position. */
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;

  grounded: boolean;
  groundNormal: Vec3;
  timeSinceGround: number;
  canCoyote: boolean;
  /** Downward speed during the last airborne tick; read on landing. */
  fallSpeed: number;
  landSpeed: number;

  crouched: boolean;
  sliding: boolean;
  /** Slide energy, 0..1. Limits one slide's length; full again the moment it ends. */
  slideFuel: number;
  /** False after a slide until crouch is released: every slide needs its own press. */
  slideReady: boolean;
  /** Seconds spent in the current slide. */
  slideTime: number;

  jumpHeld: boolean;
  /** How long jump has been held continuously while airborne. */
  jumpHoldTime: number;
  jumpBuffer: number;
  airJumpsUsed: number;

  /** Jetpack fuel, 0..1. */
  fuel: number;
  fuelDelay: number;
  thrusting: boolean;

  wallrun: {
    active: boolean;
    /** Horizontal unit normal pointing from the wall to the player. */
    normal: Vec3;
    /** +1 when the wall is on the player's right, -1 when on the left. */
    side: number;
    time: number;
    collider: number;
    awayTime: number;
  };
  /** Wall of the latest wallrun; cleared on landing. Returning to it continues a chain. */
  lastWall: number;
  /** Feet height where the current chain on `lastWall` began. */
  wallChainY: number;
  wallCooldown: number;

  mantle: {
    active: boolean;
    from: Vec3;
    to: Vec3;
    t: number;
    dur: number;
    exitSpeed: number;
  };

  events: number;
}

export function createPlayerState(pos: Vec3, yaw = 0): PlayerState {
  return {
    pos: { ...pos },
    vel: v3(),
    yaw,
    pitch: 0,
    grounded: false,
    groundNormal: v3(0, 1, 0),
    timeSinceGround: 1,
    canCoyote: false,
    fallSpeed: 0,
    landSpeed: 0,
    crouched: false,
    sliding: false,
    slideFuel: 1,
    slideReady: true,
    slideTime: 0,
    jumpHeld: false,
    jumpHoldTime: 0,
    jumpBuffer: 0,
    airJumpsUsed: 0,
    fuel: 1,
    fuelDelay: 0,
    thrusting: false,
    wallrun: { active: false, normal: v3(1, 0, 0), side: 1, time: 0, collider: -1, awayTime: 0 },
    lastWall: -1,
    wallChainY: 0,
    wallCooldown: 0,
    mantle: { active: false, from: v3(), to: v3(), t: 0, dur: 0, exitSpeed: 0 },
    events: 0,
  };
}

export const playerHeight = (s: PlayerState): number => (s.crouched ? T.player.crouchHeight : T.player.standHeight);

export const eyeHeight = (s: PlayerState): number => (s.crouched ? T.player.eyeCrouch : T.player.eyeStand);

interface Wish {
  x: number;
  z: number;
  /** 0..1 */
  mag: number;
}

interface TickCtx {
  jumpPressed: boolean;
}

export function stepPlayer(s: PlayerState, cmd: InputCmd, w: CollisionWorld, dt: number): void {
  s.events = 0;
  s.yaw = cmd.yaw;
  s.pitch = cmd.pitch;

  const ctx: TickCtx = { jumpPressed: cmd.jump && !s.jumpHeld };
  s.jumpHeld = cmd.jump;
  s.jumpBuffer = ctx.jumpPressed ? T.jump.bufferTime : Math.max(0, s.jumpBuffer - dt);
  s.wallCooldown = Math.max(0, s.wallCooldown - dt);
  if (!s.sliding) s.slideFuel = 1;
  if (!cmd.crouch) s.slideReady = true;
  s.thrusting = false;

  if (s.mantle.active) {
    stepMantle(s, dt);
    return;
  }

  updateCrouch(s, cmd, w);
  const wish = wishDir(cmd);

  if (s.wallrun.active && wallrunMove(s, cmd, wish, ctx, w, dt)) return;

  categorizeGround(s, w);
  if (s.events & MoveEvent.Land) applyLandingDrag(s, cmd);
  if (s.grounded && s.jumpBuffer > 0) {
    doJump(s);
    ctx.jumpPressed = false;
  }
  if (s.grounded) groundMove(s, cmd, wish, w, dt);
  else airMove(s, cmd, wish, ctx, w, dt);
}

// ---------------------------------------------------------------- helpers

function wishDir(cmd: InputCmd): Wish {
  const mx = clamp(cmd.moveX, -1, 1);
  const mz = clamp(cmd.moveZ, -1, 1);
  const f = forwardFromYaw(cmd.yaw);
  const r = rightFromYaw(cmd.yaw);
  let x = f.x * mz + r.x * mx;
  let z = f.z * mz + r.z * mx;
  const mag = Math.hypot(x, z);
  if (mag < 1e-4) return { x: 0, z: 0, mag: 0 };
  x /= mag;
  z /= mag;
  return { x, z, mag: Math.min(1, mag) };
}

function accelerate(vel: Vec3, wish: Wish, wishSpeed: number, accel: number, dt: number): void {
  const current = vel.x * wish.x + vel.z * wish.z;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const gain = Math.min(add, accel * dt * wishSpeed);
  vel.x += gain * wish.x;
  vel.z += gain * wish.z;
}

function applyFriction(vel: Vec3, friction: number, dt: number): void {
  const speed = lenH(vel);
  if (speed < 0.01) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const drop = Math.max(speed, T.ground.stopSpeed) * friction * dt;
  const k = Math.max(0, speed - drop) / speed;
  vel.x *= k;
  vel.z *= k;
}

function scaleHorizontal(vel: Vec3, from: number, to: number): void {
  if (from < 1e-5) return;
  const k = to / from;
  vel.x *= k;
  vel.z *= k;
}

function rechargeFuel(s: PlayerState, dt: number): void {
  s.fuelDelay = Math.max(0, s.fuelDelay - dt);
  if (s.fuelDelay <= 0) s.fuel = Math.min(1, s.fuel + dt / T.jetpack.rechargeTime);
}

/**
 * Every slide needs its own crouch press. The press may come in the air shortly
 * before landing, but crouch held over from the previous slide does not count,
 * so slide-hopping takes a press per hop rather than a held key.
 */
const canStartSlide = (s: PlayerState, cmd: InputCmd, speed: number): boolean =>
  !s.sliding && s.slideReady && cmd.crouch && speed >= T.slide.minSpeed;

/**
 * Touching down sheds part of any speed above a sprint, unless the landing goes
 * straight into a slide. Plain bunny hops therefore bleed extra speed away;
 * keeping it through a landing takes a slide.
 */
function applyLandingDrag(s: PlayerState, cmd: InputCmd): void {
  const speed = lenH(s.vel);
  const base = T.ground.sprintSpeed;
  if (speed <= base) return;
  if (s.jumpBuffer <= 0 && canStartSlide(s, cmd, speed)) return;
  scaleHorizontal(s.vel, speed, base + (speed - base) * T.ground.landingKeep);
}

function updateCrouch(s: PlayerState, cmd: InputCmd, w: CollisionWorld): void {
  const want = cmd.crouch || s.sliding;
  if (want) s.crouched = true;
  else if (s.crouched && !w.overlapsCapsule(s.pos, T.player.standHeight)) s.crouched = false;
}

/**
 * Normal of the surface under a downward capsule hit. On a box edge the contact
 * normal is tilted by the capsule's round bottom, so a short ray just inside the
 * edge reads the face itself. Without this, stairs and ledge rims count as steep.
 */
function surfaceNormal(w: CollisionWorld, hit: CastHit): Vec3 {
  const n = hit.normal;
  const hl = Math.hypot(n.x, n.z);
  if (n.y > 0.999 || hl < 1e-4) return n;
  const origin = v3(hit.point.x - (n.x / hl) * 0.03, hit.point.y + 0.06, hit.point.z - (n.z / hl) * 0.03);
  const face = w.castRay(origin, DOWN, 0.15);
  return face && face.dist > 1e-4 ? face.normal : n;
}

/** Walkable ground within `maxDist` below a capsule, with its true surface normal. */
export function findGroundAt(pos: Vec3, radius: number, height: number, w: CollisionWorld, maxDist: number): CastHit | null {
  const hit = w.castCapsule(pos, height, DOWN, maxDist, radius);
  if (!hit) return null;
  hit.normal = surfaceNormal(w, hit);
  return hit.normal.y >= T.player.minGroundNormalY ? hit : null;
}

const findGround = (s: PlayerState, w: CollisionWorld, maxDist: number): CastHit | null =>
  findGroundAt(s.pos, T.player.radius, playerHeight(s), w, maxDist);

function categorizeGround(s: PlayerState, w: CollisionWorld): void {
  const hit = findGround(s, w, GROUND_PROBE);
  const onGround = hit !== null && dot(s.vel, hit.normal) <= 0.5;
  if (onGround) {
    if (!s.grounded) {
      s.events |= MoveEvent.Land;
      s.landSpeed = s.fallSpeed;
    }
    s.grounded = true;
    s.fallSpeed = 0;
    copyV(s.groundNormal, hit.normal);
  } else {
    s.grounded = false;
  }
}

function doJump(s: PlayerState): void {
  s.vel.y = T.jump.velocity;
  s.grounded = false;
  s.canCoyote = false;
  s.sliding = false;
  s.jumpBuffer = 0;
  s.jumpHoldTime = 0;
  s.timeSinceGround = 0;
  s.events |= MoveEvent.Jump;
}

// ---------------------------------------------------------------- ground

function groundMove(s: PlayerState, cmd: InputCmd, wish: Wish, w: CollisionWorld, dt: number): void {
  const S = T.slide;
  const vel = s.vel;
  s.timeSinceGround = 0;
  s.canCoyote = true;
  s.airJumpsUsed = 0;
  s.lastWall = -1;
  s.jumpHoldTime = 0;
  rechargeFuel(s, dt);

  const speed = lenH(vel);
  if (canStartSlide(s, cmd, speed)) {
    s.sliding = true;
    s.crouched = true;
    s.slideTime = 0;
    s.events |= MoveEvent.SlideStart;
    s.slideReady = false;
    scaleHorizontal(vel, speed, Math.max(speed, Math.min(speed + S.boost, S.maxBoostedSpeed)));
  } else if (s.sliding && (!cmd.crouch || speed < S.endSpeed || s.slideFuel <= 0)) {
    s.sliding = false;
  }

  const n = s.groundNormal;
  if (s.sliding) {
    s.slideTime += dt;
    s.slideFuel = Math.max(0, s.slideFuel - dt / S.duration);
    // Drag grows the longer the slide lasts: fast at first, then it dies away.
    const now = lenH(vel);
    scaleHorizontal(vel, now, Math.max(0, now - (S.decel + S.decelRamp * s.slideTime) * dt));
    // Gravity along the slope: sliding downhill speeds up, uphill slows down.
    vel.x += T.air.gravity * n.x * n.y * S.slopeFactor * dt;
    vel.z += T.air.gravity * n.z * n.y * S.slopeFactor * dt;
    if (wish.mag > 0) {
      // Input may bend the slide but never adds speed to it.
      const before = lenH(vel);
      accelerate(vel, wish, before, S.steerAccel, dt);
      const after = lenH(vel);
      if (after > before) scaleHorizontal(vel, after, before);
    }
  } else {
    applyFriction(vel, T.ground.friction, dt);
    const max = s.crouched ? T.ground.crouchSpeed : cmd.sprint && cmd.moveZ > 0 ? T.ground.sprintSpeed : T.ground.walkSpeed;
    if (wish.mag > 0) accelerate(vel, wish, max * wish.mag, T.ground.accel, dt);
  }

  // Keep the velocity in the ground plane so slopes neither launch nor stall the player.
  vel.y = -(vel.x * n.x + vel.z * n.z) / n.y;

  moveWithSteps(s, w, dt, true);

  // Stay glued to the ground over steps and down slopes; otherwise start falling.
  const down = findGround(s, w, T.player.stepHeight);
  if (down) {
    s.pos.y -= Math.max(0, down.dist - SKIN);
    copyV(s.groundNormal, down.normal);
    // Drop any upward speed picked up from rolling over a step edge; left in,
    // the next tick would read it as leaving the ground.
    vel.y = -(vel.x * down.normal.x + vel.z * down.normal.z) / down.normal.y;
  } else {
    s.grounded = false;
  }
}

// ---------------------------------------------------------------- air

function airMove(s: PlayerState, cmd: InputCmd, wish: Wish, ctx: TickCtx, w: CollisionWorld, dt: number): void {
  const vel = s.vel;
  const J = T.jetpack;
  s.timeSinceGround += dt;
  s.sliding = false;

  if (s.jumpBuffer > 0 && s.canCoyote && s.timeSinceGround <= T.jump.coyoteTime) {
    doJump(s);
  } else if (ctx.jumpPressed && s.airJumpsUsed < T.jump.airJumps) {
    s.airJumpsUsed++;
    s.jumpBuffer = 0;
    s.jumpHoldTime = 0;
    s.canCoyote = false;
    vel.y = Math.max(vel.y, T.jump.doubleVelocity);
    if (wish.mag > 0.1) {
      // Let the second jump change direction, at some cost in speed.
      const target = Math.max(lenH(vel), T.ground.walkSpeed);
      vel.x = lerp(vel.x, wish.x * target, T.jump.doubleRedirect);
      vel.z = lerp(vel.z, wish.z * target, T.jump.doubleRedirect);
    }
    s.events |= MoveEvent.DoubleJump;
  }

  s.jumpHoldTime = cmd.jump ? s.jumpHoldTime + dt : 0;

  vel.y -= T.air.gravity * dt;

  // Jetpack: holding jump in the air burns fuel for a gentle lift.
  if (cmd.jump && s.jumpHoldTime >= J.holdDelay && s.fuel > 0) {
    s.thrusting = true;
    s.fuel = Math.max(0, s.fuel - dt / J.duration);
    s.fuelDelay = J.rechargeDelay;
    // Extra power while falling, so it catches a drop and turns it into lift
    // instead of only softening the landing.
    const power = vel.y < 0 ? J.thrust * J.fallBrakeScale : J.thrust;
    if (vel.y < J.maxRiseSpeed) vel.y = Math.min(J.maxRiseSpeed, vel.y + power * dt);
  }

  if (wish.mag > 0) {
    const wishSpeed = (cmd.sprint ? T.ground.sprintSpeed : T.ground.walkSpeed) * wish.mag;
    const before = lenH(vel);
    accelerate(vel, wish, wishSpeed, T.air.accel * (s.thrusting ? J.airAccelBonus : 1), dt);
    // Air control can build up to run speed and steer beyond it, but turning in
    // the air must not add speed on top (no free gains from air strafing).
    const after = lenH(vel);
    const limit = Math.max(before, wishSpeed);
    if (after > limit) scaleHorizontal(vel, after, limit);
  }

  if (tryMantle(s, cmd, w)) return;
  tryStartWallrun(s, wish, w);

  const hs = lenH(vel);
  if (hs > T.air.maxSpeed) scaleHorizontal(vel, hs, T.air.maxSpeed);
  if (vel.y < -T.air.maxFallSpeed) vel.y = -T.air.maxFallSpeed;
  s.fallSpeed = Math.max(0, -vel.y);

  if (s.wallrun.active) slideMove(s, w, dt, false);
  else moveWithSteps(s, w, dt, false);
}

// ---------------------------------------------------------------- wallrun

function nearestWall(s: PlayerState, w: CollisionWorld, dirs: Vec3[], reach: number) {
  const origin = v3(s.pos.x, s.pos.y + playerHeight(s) * 0.55, s.pos.z);
  let best = null;
  for (const d of dirs) {
    const hit = w.castRay(origin, d, reach);
    if (hit && Math.abs(hit.normal.y) < 0.3 && (!best || hit.dist < best.dist)) best = hit;
  }
  return best;
}

function tryStartWallrun(s: PlayerState, wish: Wish, w: CollisionWorld): boolean {
  const W = T.wallrun;
  const vel = s.vel;
  if (s.wallCooldown > 0 || wish.mag < 0.1) return false;

  const hs = lenH(vel);
  const base = hs > 1 ? v3(vel.x / hs, 0, vel.z / hs) : forwardFromYaw(s.yaw);
  const left = v3(base.z, 0, -base.x);
  const right = v3(-base.z, 0, base.x);
  const k = Math.SQRT1_2;
  const dirs = [
    left,
    right,
    v3((base.x + left.x) * k, 0, (base.z + left.z) * k),
    v3((base.x + right.x) * k, 0, (base.z + right.z) * k),
    base,
  ];
  const reach = T.player.radius + W.probeDistance;
  const hit = nearestWall(s, w, dirs, reach);
  if (!hit) return false;

  const nl = Math.hypot(hit.normal.x, hit.normal.z);
  const n = v3(hit.normal.x / nl, 0, hit.normal.z / nl);
  const into = v3(-n.x, 0, -n.z);

  // The wall has to reach head height, and the player has to be clear of the floor.
  const head = v3(s.pos.x, s.pos.y + playerHeight(s) * 0.92, s.pos.z);
  if (!w.castRay(head, into, reach + 0.3)) return false;
  if (w.castRay(v3(s.pos.x, s.pos.y + 0.05, s.pos.z), DOWN, W.minHeight)) return false;

  const vn = vel.x * n.x + vel.z * n.z;
  if (vn > 1) return false;
  if (wish.x * n.x + wish.z * n.z > 0.7) return false;

  // Direction of travel along the wall: from momentum, or from the view if hitting head-on.
  let tx = vel.x - n.x * vn;
  let tz = vel.z - n.z * vn;
  let tl = Math.hypot(tx, tz);
  if (tl < 1) {
    const f = forwardFromYaw(s.yaw);
    const fn = f.x * n.x + f.z * n.z;
    tx = f.x - n.x * fn;
    tz = f.z - n.z * fn;
    tl = Math.hypot(tx, tz);
    if (tl < 0.35) return false;
  }
  tx /= tl;
  tz /= tl;

  const speed = Math.max(vel.x * tx + vel.z * tz, hs * 0.85);
  if (speed < W.minSpeed) return false;

  const wr = s.wallrun;
  wr.active = true;
  wr.time = 0;
  wr.awayTime = 0;
  wr.collider = hit.collider;
  copyV(wr.normal, n);
  wr.side = n.x * -tz + n.z * tx < 0 ? 1 : -1;
  vel.x = tx * speed;
  vel.z = tz * speed;
  // The same wall can be used again and again. Only the first touch of a chain
  // gives lift and restores the double jump, so hopping on and off one wall
  // keeps a run going sideways without turning it into a ladder.
  const chained = hit.collider === s.lastWall;
  vel.y = clamp(vel.y, -1.5, 2.5) + (chained ? 0 : W.entryLift);
  if (!chained) {
    s.wallChainY = s.pos.y;
    s.airJumpsUsed = 0;
  }
  s.lastWall = hit.collider;
  s.thrusting = false;
  s.events |= MoveEvent.WallrunStart;
  return true;
}

/** `dropped`: the run gave out (time, crouch, steering away) rather than ending in a jump. */
function endWallrun(s: PlayerState, dropped: boolean): void {
  s.wallrun.active = false;
  // A longer pause after dropping stops the wall from grabbing the player straight back.
  s.wallCooldown = dropped ? T.wallrun.dropCooldown : T.wallrun.cooldown;
  s.canCoyote = false;
}

/** Returns true while the wallrun continues and has moved the player this tick. */
function wallrunMove(s: PlayerState, cmd: InputCmd, wish: Wish, ctx: TickCtx, w: CollisionWorld, dt: number): boolean {
  const W = T.wallrun;
  const wr = s.wallrun;
  const vel = s.vel;
  const n = wr.normal;
  wr.time += dt;
  rechargeFuel(s, dt);

  let vn = vel.x * n.x + vel.z * n.z;
  let tx = vel.x - n.x * vn;
  let tz = vel.z - n.z * vn;
  let speed = Math.hypot(tx, tz);

  if (ctx.jumpPressed) {
    const k = speed > 1e-3 ? 1 : 0;
    // Steering decides the leap: away from the wall is a full jump across, into
    // the wall is a short hop that lands back on it and keeps the run going.
    const f = forwardFromYaw(s.yaw);
    const aim = wish.mag > 0.1 ? wish.x * n.x + wish.z * n.z : f.x * n.x + f.z * n.z;
    const push = lerp(W.hopPush, W.jumpPush, clamp((aim + 0.2) / 0.7, 0, 1));
    vel.x = tx * k + n.x * push;
    vel.z = tz * k + n.z * push;
    // Well above where this chain started, leaps off the same wall lose height.
    vel.y = s.pos.y > s.wallChainY + W.chainRise ? W.jumpUp * W.chainJumpScale : W.jumpUp;
    endWallrun(s, false);
    s.jumpHoldTime = 0;
    s.jumpBuffer = 0;
    s.events |= MoveEvent.WallJump;
    ctx.jumpPressed = false;
    return false;
  }

  const reach = T.player.radius + W.probeDistance + 0.15;
  const hit = nearestWall(s, w, [v3(-n.x, 0, -n.z)], reach);
  if (!hit || wr.time > W.maxTime || cmd.crouch || speed < 1e-3) {
    endWallrun(s, hit !== null);
    return false;
  }
  if (findGround(s, w, GROUND_PROBE)) {
    endWallrun(s, false);
    return false;
  }

  // Follow the wall surface, keeping the direction of travel.
  const nl = Math.hypot(hit.normal.x, hit.normal.z);
  n.x = hit.normal.x / nl;
  n.z = hit.normal.z / nl;
  wr.collider = hit.collider;
  s.lastWall = hit.collider;
  vn = vel.x * n.x + vel.z * n.z;
  tx = vel.x - n.x * vn;
  tz = vel.z - n.z * vn;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl;
  tz /= tl;

  const along = (wish.x * tx + wish.z * tz) * wish.mag;
  const away = (wish.x * n.x + wish.z * n.z) * wish.mag;
  wr.awayTime = away > 0.6 ? wr.awayTime + dt : 0;
  if (wr.awayTime > 0.12) {
    vel.x += n.x * 2;
    vel.z += n.z * 2;
    endWallrun(s, true);
    return false;
  }

  if (along > 0.1) speed = speed < W.speed ? Math.min(W.speed, speed + W.accel * dt) : Math.max(W.speed, speed - dt);
  else if (along < -0.1) speed -= W.brake * dt;
  else speed -= 3 * dt;
  if (speed < W.minSpeed * 0.6) {
    endWallrun(s, true);
    return false;
  }

  // Height holds at first and then gives way, so a run cannot last forever.
  const k = wr.time / W.maxTime;
  if (vel.y > 0) vel.y *= Math.exp(-W.verticalDamp * dt);
  vel.y -= W.gravity * k * k * dt;

  vel.x = tx * speed - n.x;
  vel.z = tz * speed - n.z;
  slideMove(s, w, dt, false);
  return true;
}

// ---------------------------------------------------------------- mantle

function tryMantle(s: PlayerState, cmd: InputCmd, w: CollisionWorld): boolean {
  const M = T.mantle;
  if (cmd.moveZ <= 0.1 || s.vel.y < -14) return false;

  const f = forwardFromYaw(s.yaw);
  const h = playerHeight(s);
  const wall = w.castCapsule(s.pos, h, f, M.forwardProbe);
  if (!wall || Math.abs(wall.normal.y) > 0.3 || dot(f, wall.normal) > -0.6) return false;

  // Look for a walkable top just behind the wall face, within reach of the hands.
  const fwd = wall.dist + T.player.radius + 0.2;
  const origin = v3(s.pos.x + f.x * fwd, s.pos.y + M.maxHeight + 0.05, s.pos.z + f.z * fwd);
  const ledge = w.castRay(origin, DOWN, M.maxHeight - M.minHeight + 0.05);
  if (!ledge || ledge.dist < 0.02 || ledge.normal.y < T.player.minGroundNormalY) return false;

  const target = v3(origin.x, origin.y - ledge.dist + SKIN * 2, origin.z);
  let crouch = s.crouched;
  if (w.overlapsCapsule(target, T.player.standHeight)) {
    if (w.overlapsCapsule(target, T.player.crouchHeight)) return false;
    crouch = true;
  }
  // The way straight up has to be clear as well.
  if (w.overlapsCapsule(v3(s.pos.x, target.y, s.pos.z), T.player.crouchHeight)) return false;

  const rise = target.y - s.pos.y;
  const m = s.mantle;
  m.active = true;
  m.t = 0;
  m.dur = clamp(M.baseTime + M.timePerMeter * rise, 0.2, 0.5);
  m.exitSpeed = clamp(lenH(s.vel) * 0.7, 3, T.ground.sprintSpeed);
  copyV(m.from, s.pos);
  copyV(m.to, target);
  s.crouched = crouch;
  s.vel.x = s.vel.y = s.vel.z = 0;
  s.thrusting = false;
  s.events |= MoveEvent.MantleStart;
  return true;
}

function stepMantle(s: PlayerState, dt: number): void {
  const m = s.mantle;
  m.t += dt;
  const k = Math.min(1, m.t / m.dur);
  // Up first, then forward over the edge.
  const up = Math.min(1, k / 0.7);
  const ky = 1 - (1 - up) * (1 - up);
  const fw = clamp((k - 0.4) / 0.6, 0, 1);
  const kh = fw * fw * (3 - 2 * fw);
  s.pos.x = lerp(m.from.x, m.to.x, kh);
  s.pos.y = lerp(m.from.y, m.to.y, ky);
  s.pos.z = lerp(m.from.z, m.to.z, kh);
  if (k < 1) return;

  m.active = false;
  copyV(s.pos, m.to);
  const dx = m.to.x - m.from.x;
  const dz = m.to.z - m.from.z;
  const dl = Math.hypot(dx, dz) || 1;
  s.vel.x = (dx / dl) * m.exitSpeed;
  s.vel.y = 0;
  s.vel.z = (dz / dl) * m.exitSpeed;
  s.airJumpsUsed = 0;
  s.fallSpeed = 0;
  s.grounded = true;
}

// ---------------------------------------------------------------- collision

function clipVelocity(v: Vec3, n: Vec3, out: Vec3): void {
  const backoff = dot(v, n) * 1.001;
  out.x = v.x - n.x * backoff;
  out.y = v.y - n.y * backoff;
  out.z = v.z - n.z * backoff;
}

const slideMove = (s: PlayerState, w: CollisionWorld, dt: number, onGround: boolean): boolean =>
  slideBody(s, T.player.radius, playerHeight(s), w, dt, onGround);

const moveWithSteps = (s: PlayerState, w: CollisionWorld, dt: number, wasGrounded: boolean): void =>
  stepBody(s, T.player.radius, playerHeight(s), T.player.stepHeight, w, dt, wasGrounded);

/**
 * Move a capsule by velocity * dt, sliding along whatever is hit (after Quake 3).
 * Returns true if a wall-like surface got in the way.
 */
export function slideBody(s: Body, radius: number, h: number, w: CollisionWorld, dt: number, onGround: boolean): boolean {
  const pos = s.pos;
  const vel = s.vel;
  const minY = T.player.minGroundNormalY;
  const primal = { ...vel };
  const planes: Vec3[] = [];
  if (onGround) planes.push({ ...s.groundNormal });
  const startSpeed = Math.hypot(vel.x, vel.y, vel.z);
  if (startSpeed > 1e-5) planes.push(v3(vel.x / startSpeed, vel.y / startSpeed, vel.z / startSpeed));

  let timeLeft = dt;
  let blocked = false;
  const clipped = v3();

  for (let bump = 0; bump < MAX_BUMPS && timeLeft > 1e-6; bump++) {
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (speed < 1e-5) break;
    const dir = v3(vel.x / speed, vel.y / speed, vel.z / speed);
    const dist = speed * timeLeft;
    const hit = w.castCapsule(pos, h, dir, dist + SKIN * 4, radius);
    if (!hit) {
      addScaled(pos, dir, dist);
      break;
    }

    const n = hit.normal;
    let cos = -dot(dir, n);
    if (cos <= 0) {
      // Started inside something: treat it as a head-on stop.
      n.x = -dir.x;
      n.y = -dir.y;
      n.z = -dir.z;
      cos = 1;
    }
    // Stop short so the gap to the surface stays about SKIN, whatever the angle.
    const allowed = hit.dist - SKIN / Math.max(cos, 0.05);
    if (allowed >= dist) {
      addScaled(pos, dir, dist);
      break;
    }
    const travel = Math.max(0, allowed);
    addScaled(pos, dir, travel);
    timeLeft -= travel / speed;
    if (n.y < minY && n.y > -0.5) blocked = true;
    planes.push(n);

    // Find a velocity that does not push into any plane touched so far.
    let i = 0;
    for (; i < planes.length; i++) {
      if (dot(vel, planes[i]) >= 0) continue;
      clipVelocity(vel, planes[i], clipped);
      let stuck = false;
      for (let j = 0; j < planes.length && !stuck; j++) {
        if (j === i || dot(clipped, planes[j]) >= 0) continue;
        clipVelocity(clipped, planes[j], clipped);
        if (dot(clipped, planes[i]) >= 0) continue;
        // Two planes form a crease: slide along it.
        const crease = cross(planes[i], planes[j]);
        const cl = Math.hypot(crease.x, crease.y, crease.z);
        if (cl < 1e-6) {
          stuck = true;
          break;
        }
        const d = dot(crease, vel) / (cl * cl);
        clipped.x = crease.x * d;
        clipped.y = crease.y * d;
        clipped.z = crease.z * d;
        for (let k = 0; k < planes.length; k++) {
          if (k !== i && k !== j && dot(clipped, planes[k]) < 0) stuck = true;
        }
      }
      if (stuck) {
        vel.x = vel.y = vel.z = 0;
        return blocked;
      }
      copyV(vel, clipped);
      break;
    }
    // Never bounce back against the direction the move started in.
    if (dot(vel, primal) <= 0) {
      vel.x = vel.y = vel.z = 0;
      break;
    }
  }
  return blocked;
}

/** slideBody plus stepping up onto low ledges such as stairs. */
export function stepBody(s: Body, radius: number, h: number, stepHeight: number, w: CollisionWorld, dt: number, wasGrounded: boolean): void {
  const startPos = { ...s.pos };
  const startVel = { ...s.vel };
  const blocked = slideBody(s, radius, h, w, dt, wasGrounded);
  if (!blocked) return;
  if (!wasGrounded && startVel.y > 0.01) return;

  const flatPos = { ...s.pos };
  const flatVel = { ...s.vel };

  copyV(s.pos, startPos);
  copyV(s.vel, startVel);
  s.vel.y = 0;
  const up = w.castCapsule(s.pos, h, UP, stepHeight, radius);
  const upDist = up ? Math.max(0, up.dist - SKIN) : stepHeight;
  let stepped = false;
  if (upDist > 0.02) {
    s.pos.y += upDist;
    slideBody(s, radius, h, w, dt, false);
    const down = findGroundAt(s.pos, radius, h, w, upDist + SKIN);
    if (down) {
      s.pos.y -= Math.max(0, down.dist - SKIN);
      const flat = (flatPos.x - startPos.x) ** 2 + (flatPos.z - startPos.z) ** 2;
      const step = (s.pos.x - startPos.x) ** 2 + (s.pos.z - startPos.z) ** 2;
      stepped = step > flat + 1e-6 && s.pos.y > startPos.y + 0.01;
    }
  }
  if (stepped) {
    s.vel.y = 0;
  } else {
    copyV(s.pos, flatPos);
    copyV(s.vel, flatVel);
  }
}
