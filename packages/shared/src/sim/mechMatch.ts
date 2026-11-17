import { isWalkable } from '../ai/nav';
import { emptyInput, type InputCmd } from '../input';
import { v3, type Vec3 } from '../math/vec3';
import { COMBAT, type Actor, type MatchState } from './combat';
import { FRAME_LIST, MechEvent, distToMech, eyeOf, frameOf, mechActive, resetMech, stepMechBody, type Mech, type MechFrame, type SalvoAbility, type StompMove } from './mech';
import { playerHeight } from './movement';
import { spawnProjectile } from './projectiles';
import { randSigned } from './rng';
import type { Rng } from './rng';
import { addMeter, damageActor, damageMech, destroyMech, enterMech, leaveMech } from './rules';
import { TUNING } from './tuning';
import { PROJECTILES } from './weapons';
import type { CollisionWorld } from './world';

/**
 * The mech's part of a match tick: charging the meter, calling a mech down,
 * the drop and its landing, getting in and out, driving it, and what each
 * frame does with the jump and aim buttons: the dash that rams, the stomp, the
 * rocket salvo, the shield and the cloak.
 */

const R = COMBAT.mech;
const DEG = Math.PI / 180;
const IDLE = emptyInput();
const UP = v3(0, 1, 0);
const DOWN = v3(0, -1, 0);
/** Fallback landing spots around the caller: distances, then bearings off the view. */
const RING_DIST = [9, 13, 6.5, 18];
const RING_TURN = [0, 0.785, -0.785, 1.571, -1.571, 2.356, -2.356, 3.1416];

const probe = v3();
const eye = v3();
const dir = v3();
const spot = v3();

/** True, with `out` set to the ground point, if a mech of frame `F` can come down at (x, z) near height y. */
function dropSpotOk(m: MatchState, world: CollisionWorld, F: MechFrame, x: number, y: number, z: number, out: Vec3): boolean {
  const B = F.body;
  probe.x = x;
  probe.y = y + 1.5;
  probe.z = z;
  const ground = world.castRay(probe, DOWN, 5);
  if (!ground || ground.normal.y < TUNING.player.minGroundNormalY) return false;
  out.x = x;
  out.y = probe.y - ground.dist + 0.02;
  out.z = z;
  if (world.overlapsCapsule(out, B.height, B.radius)) return false;
  // It comes from above: the sky over the spot has to be open.
  probe.y = out.y + B.height;
  if (world.castRay(probe, UP, R.drop.clearHeight)) return false;
  for (const k of m.mechs) {
    if (k.state !== 'none' && Math.hypot(k.pos.x - x, k.pos.z - z) < B.radius + frameOf(k).body.radius + 0.6) return false;
  }
  return true;
}

/**
 * Where a called mech of frame `F` lands: the ground the pilot is looking at,
 * when that is within range and the mech fits there; otherwise the nearest free
 * spot around the pilot. Bots always use the second, and only take spots they
 * can walk the mech away from. Returns a shared vector, or null when nothing fits.
 */
export function findDropPoint(m: MatchState, world: CollisionWorld, a: Actor, F: MechFrame = FRAME_LIST[0]): Vec3 | null {
  const p = a.p;
  if (!a.brain) {
    const cp = Math.cos(p.pitch);
    dir.x = -Math.sin(p.yaw) * cp;
    dir.y = Math.sin(p.pitch);
    dir.z = -Math.cos(p.yaw) * cp;
    eye.x = p.pos.x;
    eye.y = p.pos.y + eyeOf(m, a);
    eye.z = p.pos.z;
    const hit = world.castRay(eye, dir, R.drop.maxRange * 1.5);
    if (hit) {
      let x = hit.point.x;
      let z = hit.point.z;
      // Looking at a wall: land in front of it instead.
      if (hit.normal.y < TUNING.player.minGroundNormalY) {
        const back = F.body.radius + 0.5;
        const nl = Math.hypot(hit.normal.x, hit.normal.z) || 1;
        x += (hit.normal.x / nl) * back;
        z += (hit.normal.z / nl) * back;
      }
      const flat = Math.hypot(x - p.pos.x, z - p.pos.z);
      if (flat <= R.drop.maxRange && dropSpotOk(m, world, F, x, hit.normal.y < 0.7 ? p.pos.y : hit.point.y, z, spot)) return spot;
    }
  }
  for (const dist of RING_DIST) {
    for (const turn of RING_TURN) {
      const yaw = p.yaw + turn;
      const x = p.pos.x - Math.sin(yaw) * dist;
      const z = p.pos.z - Math.cos(yaw) * dist;
      if (!dropSpotOk(m, world, F, x, p.pos.y, z, spot)) continue;
      // A bot's mech has to be able to walk out to the fight: not stuck on a roof.
      if (!a.brain || isWalkable(m.navMech, spot.x, spot.y, spot.z)) return spot;
    }
  }
  return null;
}

/** Spend a full meter on a mech of the chosen frame. It lands after the drop time, where the telegraph shows. */
function tryCall(m: MatchState, world: CollisionWorld, a: Actor, frame: number): void {
  const k = m.mechs[a.id];
  if (k.state !== 'none') return;
  if (a.meter < 1) {
    m.events.push({ type: 'callDenied', actor: a.id, reason: 'meter' });
    return;
  }
  const F = FRAME_LIST[frame] ?? FRAME_LIST[0];
  const at = findDropPoint(m, world, a, F);
  if (!at) {
    m.events.push({ type: 'callDenied', actor: a.id, reason: 'zone' });
    return;
  }
  a.meter = 0;
  resetMech(k, at, a.p.yaw, FRAME_LIST.indexOf(F));
  k.state = 'dropping';
  m.events.push({ type: 'mechCall', actor: a.id, frame: k.frame, pos: { ...k.pos }, duration: R.drop.time });
}

/** The mech arrives. Enemies still standing in the zone are crushed. */
function land(m: MatchState, k: Mech): void {
  const D = R.drop;
  const owner = m.actors[k.id];
  k.state = 'idle';
  k.stateTime = 0;
  m.events.push({ type: 'mechLand', mech: k.id, pos: { ...k.pos } });
  const B = frameOf(k).body;
  for (const o of m.actors) {
    if (o.team === k.team || !o.alive || o.inMech) continue;
    const dy = o.p.pos.y - k.pos.y;
    if (dy < -playerHeight(o.p) || dy > B.height) continue;
    if (Math.hypot(o.p.pos.x - k.pos.x, o.p.pos.z - k.pos.z) > D.crushRadius) continue;
    damageActor(m, o, owner, D.crushDamage, false, { ...o.p.pos }, 'crush');
  }
  for (const o of m.mechs) {
    if (o.team === k.team || !mechActive(o)) continue;
    if (distToMech(o, k.pos.x, k.pos.y + B.radius, k.pos.z) > D.crushRadius) continue;
    damageMech(m, o, owner, D.crushArmor, false, { ...o.pos }, 'crush');
  }
}

/** Close enough to climb in: beside the mech, or on top of it. */
function inReach(a: Actor, k: Mech): boolean {
  const dy = a.p.pos.y - k.pos.y;
  return dy > -2 && dy < frameOf(k).body.height + 1.5 && Math.hypot(a.p.pos.x - k.pos.x, a.p.pos.z - k.pos.z) <= R.embark.range;
}

/** A dash that runs into enemies hurts them and throws pilots aside. Once per dash each. */
function ram(m: MatchState, k: Mech): void {
  const F = frameOf(k);
  const D = F.mobility;
  if (D.kind !== 'dash') return;
  const owner = m.actors[k.id];
  for (const o of m.actors) {
    if (o.team === k.team || !o.alive || o.inMech || k.rammed & (1 << o.id)) continue;
    const dy = o.p.pos.y - k.pos.y;
    if (dy < -playerHeight(o.p) || dy > F.body.height) continue;
    if (Math.hypot(o.p.pos.x - k.pos.x, o.p.pos.z - k.pos.z) > D.ramRadius) continue;
    k.rammed |= 1 << o.id;
    o.p.vel.x += k.dashX * D.ramKnock;
    o.p.vel.y = Math.max(o.p.vel.y, D.ramKnock * 0.6);
    o.p.vel.z += k.dashZ * D.ramKnock;
    o.p.grounded = false;
    m.events.push({ type: 'ram', mech: k.id, victim: o.id, other: -1 });
    damageActor(m, o, owner, D.ramDamage, false, { x: o.p.pos.x, y: o.p.pos.y + 1, z: o.p.pos.z }, 'ram');
  }
  for (const o of m.mechs) {
    if (o.team === k.team || !mechActive(o) || k.rammed & (1 << (16 + o.id))) continue;
    if (Math.abs(o.pos.y - k.pos.y) > F.body.height) continue;
    if (Math.hypot(o.pos.x - k.pos.x, o.pos.z - k.pos.z) > F.body.radius + frameOf(o).body.radius + 0.3) continue;
    k.rammed |= 1 << (16 + o.id);
    m.events.push({ type: 'ram', mech: k.id, victim: -1, other: o.id });
    damageMech(m, o, owner, D.ramArmor, false, { x: o.pos.x, y: o.pos.y + 3, z: o.pos.z }, 'ram');
  }
}

/**
 * The stomp lands: enemy pilots close by are hurt and thrown away and up, enemy
 * mechs take a blow. Walls stop it, as they stop a blast.
 */
function stomp(m: MatchState, world: CollisionWorld, k: Mech, S: StompMove): void {
  const owner = m.actors[k.id];
  const B = frameOf(k).body;
  for (const o of m.actors) {
    if (o.team === k.team || !o.alive || o.inMech) continue;
    const dy = o.p.pos.y - k.pos.y;
    if (dy < -2 || dy > B.height) continue;
    const dx = o.p.pos.x - k.pos.x;
    const dz = o.p.pos.z - k.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > S.radius) continue;
    probe.x = k.pos.x;
    probe.y = k.pos.y + 1;
    probe.z = k.pos.z;
    dir.x = dx;
    dir.y = o.p.pos.y + 1 - probe.y;
    dir.z = dz;
    const l = Math.hypot(dir.x, dir.y, dir.z);
    if (l > 0.3) {
      dir.x /= l;
      dir.y /= l;
      dir.z /= l;
      const wall = world.castRay(probe, dir, l);
      if (wall && wall.dist < l - 0.2) continue;
    }
    const nx = d > 0.05 ? dx / d : -Math.sin(k.yaw);
    const nz = d > 0.05 ? dz / d : -Math.cos(k.yaw);
    o.p.vel.x = nx * S.knock;
    o.p.vel.z = nz * S.knock;
    o.p.vel.y = Math.max(o.p.vel.y, S.lift);
    o.p.grounded = false;
    damageActor(m, o, owner, S.damage * (1 - 0.5 * (d / S.radius)) * owner.damageScale, false, { x: o.p.pos.x, y: o.p.pos.y + 1, z: o.p.pos.z }, 'stomp');
  }
  for (const o of m.mechs) {
    if (o.team === k.team || !mechActive(o)) continue;
    if (Math.abs(o.pos.y - k.pos.y) > B.height) continue;
    if (Math.hypot(o.pos.x - k.pos.x, o.pos.z - k.pos.z) > S.radius) continue;
    damageMech(m, o, owner, S.armor * owner.damageScale, false, { x: o.pos.x, y: o.pos.y + 1, z: o.pos.z }, 'stomp');
  }
}

/** What the mech's body did this tick, as match events: footfalls and the jump button's move. */
export function pushBodyEvents(m: MatchState, k: Mech): void {
  const ev = k.events;
  if (ev & MechEvent.Dash) m.events.push({ type: 'mechAbility', mech: k.id, what: 'dash' });
  if (ev & MechEvent.Leap) m.events.push({ type: 'mechAbility', mech: k.id, what: 'leap' });
  if (ev & MechEvent.Stomp) m.events.push({ type: 'mechAbility', mech: k.id, what: 'stomp' });
  if (ev & MechEvent.Land) m.events.push({ type: 'mechStep', mech: k.id, heavy: true });
  else if (ev & MechEvent.Step) m.events.push({ type: 'mechStep', mech: k.id, heavy: false });
}

/** The pilot rides along: their position is the mech's. */
export function seat(a: Actor, k: Mech): void {
  const p = a.p;
  p.pos.x = k.pos.x;
  p.pos.y = k.pos.y;
  p.pos.z = k.pos.z;
  p.vel.x = k.vel.x;
  p.vel.y = k.vel.y;
  p.vel.z = k.vel.z;
  p.yaw = k.yaw;
  p.pitch = k.pitch;
  p.grounded = k.grounded;
  p.events = 0;
}

/**
 * Everything mechs do in one tick except their weapons. Runs after pilots on
 * foot have moved, with the tick's commands in `m.cmds`.
 */
export function stepMechs(m: MatchState, world: CollisionWorld, dt: number): void {
  // Calls, and climbing in and out.
  for (const a of m.actors) {
    const cmd = m.cmds[a.id];
    if (!cmd || !a.alive) continue;
    const k = m.mechs[a.id];
    addMeter(m, a, dt / R.meter.passiveTime);
    const callPressed = cmd.call && !a.callHeld;
    const usePressed = cmd.use && !a.useHeld;
    a.callHeld = cmd.call;
    a.useHeld = cmd.use;
    if (callPressed && !a.inMech) tryCall(m, world, a, cmd.frame);
    if (!usePressed) continue;
    if (a.inMech) {
      if (k.state === 'piloted') leaveMech(m, a, k, false);
    } else if (k.state === 'idle' && inReach(a, k)) {
      enterMech(m, a, k);
    }
  }

  for (const k of m.mechs) {
    if (k.state === 'none') continue;
    k.stateTime += dt;
    if (k.state === 'dropping') {
      if (k.stateTime >= R.drop.time) land(m, k);
      continue;
    }
    if (k.state === 'boot' && k.stateTime >= R.embark.time) {
      k.state = 'piloted';
      k.stateTime = 0;
      m.events.push({ type: 'mechOnline', actor: k.id });
    }

    const owner = m.actors[k.id];
    const driven = k.state === 'piloted';
    // Its pilot's command is late: the machine waits with them (see `stepMatch`).
    if (driven && owner.stalled) {
      k.events = 0;
      continue;
    }
    const cmd: InputCmd = (driven && m.cmds[k.id]) || IDLE;
    if (k.state === 'boot') {
      // The view is the pilot's from the moment they sit down, so the mech turns to it.
      const look = m.cmds[k.id];
      if (look) {
        k.yaw = look.yaw;
        k.pitch = look.pitch;
      }
    }
    stepMechBody(k, cmd, world, dt, driven, m.mechs);
    pushBodyEvents(m, k);
    const J = frameOf(k).mobility;
    if (k.events & MechEvent.Stomp && J.kind === 'stomp') stomp(m, world, k, J);
    if (k.dashTime > 0) ram(m, k);
    if (owner.inMech) seat(owner, k);
    if (k.pos.y < COMBAT.killY) destroyMech(m, k, null, '');
    if (m.over) return;
  }
}

/**
 * The aim button of a piloted mech, after its weapon has had its turn: the
 * frame's ability. `fired` says the cannon fired this tick (which ends a cloak).
 */
export function stepAbility(m: MatchState, a: Actor, k: Mech, ads: boolean, fired: boolean, world: CollisionWorld, dt: number): void {
  const A = frameOf(k).ability;
  k.abilityCooldown = Math.max(0, k.abilityCooldown - dt);
  if (A.kind === 'salvo') {
    stepSalvo(m, a, k, A, ads, world, dt);
  } else if (A.kind === 'shield') {
    // Held up while the button is, as long as there is shield left; it rests to refill.
    const up = ads && k.abilityCooldown <= 0 && k.shield > 0;
    if (up !== k.shieldUp) {
      k.shieldUp = up;
      k.shieldRest = 0;
      m.events.push({ type: 'mechAbility', mech: k.id, what: up ? 'shieldUp' : 'shieldDown' });
    }
    k.shieldRest += dt;
    if (up) {
      k.shield -= A.drain * dt;
      if (k.shield <= 0) {
        k.shield = 0;
        k.shieldUp = false;
        k.abilityCooldown = A.brokenTime;
        m.events.push({ type: 'mechAbility', mech: k.id, what: 'shieldBreak' });
      }
    } else if (k.shieldRest >= A.regenDelay) {
      k.shield = Math.min(A.health, k.shield + A.regen * dt);
    }
  } else if (k.cloak > 0) {
    k.cloak = fired ? 0 : Math.max(0, k.cloak - dt);
    if (k.cloak <= 0) {
      k.abilityCooldown = A.cooldown;
      m.events.push({ type: 'mechAbility', mech: k.id, what: 'cloakOff' });
    }
  } else if (ads && k.abilityCooldown <= 0) {
    k.cloak = A.time;
    m.events.push({ type: 'mechAbility', mech: k.id, what: 'cloakOn' });
  }
}

/**
 * The rocket salvo: the aim button starts it when it is ready, then the rockets
 * leave one after another toward the point the pilot looks at.
 */
function stepSalvo(m: MatchState, a: Actor, k: Mech, S: SalvoAbility, fire: boolean, world: CollisionWorld, dt: number): void {
  if (fire && k.abilityCooldown <= 0 && k.salvoLeft === 0) {
    k.salvoLeft = S.count;
    k.salvoNext = 0;
    k.abilityCooldown = S.cooldown;
  }
  if (k.salvoLeft === 0) return;
  k.salvoNext -= dt;
  while (k.salvoLeft > 0 && k.salvoNext <= 0) {
    k.salvoLeft--;
    k.salvoNext += S.interval;

    // Aim point: what the cockpit's line of sight meets.
    const cp = Math.cos(k.pitch);
    const sin = Math.sin(k.yaw);
    const cos = Math.cos(k.yaw);
    dir.x = -sin * cp;
    dir.y = Math.sin(k.pitch);
    dir.z = -cos * cp;
    eye.x = k.pos.x;
    eye.y = k.pos.y + frameOf(k).body.eye;
    eye.z = k.pos.z;
    const rng: Rng = a.rng ?? m.rng;
    const hit = world.castRay(eye, dir, PROJECTILES[S.projectile].speed * PROJECTILES[S.projectile].life);
    const reach = Math.max(8, hit ? hit.dist : 90);
    // The pod sits on the left shoulder, inside the body so it never starts in a wall.
    probe.x = k.pos.x + cos * S.side;
    probe.y = k.pos.y + S.height;
    probe.z = k.pos.z - sin * S.side;
    const spread = Math.tan(S.spreadDeg * DEG);
    dir.x = eye.x + dir.x * reach - probe.x;
    dir.y = eye.y + dir.y * reach - probe.y;
    dir.z = eye.z + dir.z * reach - probe.z;
    let l = Math.hypot(dir.x, dir.y, dir.z);
    dir.x = dir.x / l + randSigned(rng) * spread;
    dir.y = dir.y / l + randSigned(rng) * spread;
    dir.z = dir.z / l + randSigned(rng) * spread;
    l = Math.hypot(dir.x, dir.y, dir.z);
    dir.x /= l;
    dir.y /= l;
    dir.z /= l;
    spawnProjectile(m, a, S.projectile, probe, dir);
  }
}
