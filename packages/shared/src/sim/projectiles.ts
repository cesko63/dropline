import { v3, type Vec3 } from '../math/vec3';
import type { Actor, MatchState } from './combat';
import { raySphere, rayUprightCapsule } from './hitscan';
import { behindShield, distToMech, frameOf, mechActive, rayMech, rayShield, type Mech } from './mech';
import { playerHeight } from './movement';
import { damageActor, damageMech, damageShield } from './rules';
import { PROJECTILES } from './weapons';
import type { CollisionWorld } from './world';

/**
 * Rockets: shots that take time to arrive and burst on what they meet. A pilot
 * can see one coming and get out of the way; a mech mostly cannot, which is
 * what makes them the answer to armor.
 */

export interface Projectile {
  id: number;
  /** Actor id of whoever fired it. */
  owner: number;
  team: number;
  kind: string;
  pos: Vec3;
  /** Unit direction of flight. */
  dir: Vec3;
  life: number;
  /** The shooter's damage scale when it was fired. */
  scale: number;
}

export function spawnProjectile(m: MatchState, a: Actor, kind: string, origin: Vec3, dir: Vec3): void {
  if (m.predict) {
    // A client only draws its own rocket leaving, under a negative id of its own;
    // the real one flies on the server and is matched to it when it is announced.
    m.events.push({ type: 'launch', id: -1 - m.nextProjectile++, actor: a.id, kind, pos: { ...origin }, dir: { ...dir } });
    return;
  }
  const id = m.nextProjectile++;
  m.projectiles.push({ id, owner: a.id, team: a.team, kind, pos: { ...origin }, dir: { ...dir }, life: PROJECTILES[kind].life, scale: a.damageScale });
  m.events.push({ type: 'launch', id, actor: a.id, kind, pos: { ...origin }, dir: { ...dir } });
}

const from = v3();
const to = v3();

/**
 * A rocket bursts at `point`. `struck` is the mech it hit, if any: on its hull,
 * or on its raised shield (`shield`), which then takes the whole of it.
 */
function explode(m: MatchState, world: CollisionWorld, p: Projectile, point: Vec3, normal: Vec3 | null, struck: Mech | null, crit: boolean, shield: boolean): void {
  const def = PROJECTILES[p.kind];
  const owner = m.actors[p.owner];
  m.events.push({ type: 'explode', id: p.id, actor: p.owner, kind: p.kind, pos: point, normal });

  if (struck && shield) damageShield(m, struck, owner, def.armor * p.scale, point);
  else if (struck) damageMech(m, struck, owner, def.armor * (crit ? frameOf(struck).vent.mult : 1) * p.scale, crit, point, p.kind);
  for (const k of m.mechs) {
    if (k === struck || k.team === p.team || !mechActive(k)) continue;
    const d = distToMech(k, point.x, point.y, point.z);
    if (d >= def.radius) continue;
    const amount = def.armor * def.splashArmor * (1 - d / def.radius) * p.scale;
    // A blast out in front of a raised shield is the shield's to take.
    if (behindShield(k, point.x, point.z)) damageShield(m, k, owner, amount, point);
    else damageMech(m, k, owner, amount, false, point, p.kind);
  }

  // Blast on pilots, stopped by walls. The check starts a little back from the
  // surface so the wall that was hit does not block its own blast.
  from.x = point.x - p.dir.x * 0.15;
  from.y = point.y - p.dir.y * 0.15;
  from.z = point.z - p.dir.z * 0.15;
  for (const o of m.actors) {
    if (o.team === p.team || !o.alive || o.inMech) continue;
    to.x = o.p.pos.x - from.x;
    to.y = o.p.pos.y + playerHeight(o.p) * 0.55 - from.y;
    to.z = o.p.pos.z - from.z;
    const d = Math.hypot(to.x, to.y, to.z);
    if (d >= def.radius) continue;
    if (d > 0.3) {
      to.x /= d;
      to.y /= d;
      to.z /= d;
      const wall = world.castRay(from, to, d);
      if (wall && wall.dist < d - 0.1) continue;
      if (shielded(m, o.team, from, to, d)) continue;
    }
    damageActor(m, o, owner, def.damage * (1 - 0.75 * (d / def.radius)) * p.scale, false, { ...point }, p.kind);
  }
}

/** True when a raised shield of team `team` stands between a blast and a pilot of that team. */
function shielded(m: MatchState, team: number, o: Vec3, d: Vec3, dist: number): boolean {
  for (const k of m.mechs) {
    if (k.team === team && k.shieldUp && rayShield(o, d, k, k, dist) >= 0) return true;
  }
  return false;
}

/** Fly every rocket forward one tick and burst the ones that meet something. */
export function stepProjectiles(m: MatchState, world: CollisionWorld, dt: number): void {
  for (let i = 0; i < m.projectiles.length; i++) {
    const p = m.projectiles[i];
    const def = PROJECTILES[p.kind];
    const step = def.speed * dt;
    const wall = world.castRay(p.pos, p.dir, step);
    let t = wall ? wall.dist : step;
    let normal = wall ? wall.normal : null;
    let met = wall !== null;
    let struck: Mech | null = null;
    let crit = false;
    let shield = false;

    for (const o of m.actors) {
      if (o.team === p.team || !o.alive || o.inMech) continue;
      const cx = o.p.pos.x;
      const cy = o.p.pos.y + playerHeight(o.p) * 0.55;
      const cz = o.p.pos.z;
      const r = def.fuse + 0.45;
      // Already inside the fuse distance counts as contact at once.
      const inside = Math.hypot(p.pos.x - cx, p.pos.y - cy, p.pos.z - cz) < r;
      const tt = inside ? 0 : raySphere(p.pos, p.dir, cx, cy, cz, r);
      if (tt < 0 || tt >= t) continue;
      t = tt;
      normal = null;
      met = true;
    }
    for (const k of m.mechs) {
      if (k.team === p.team || !mechActive(k)) continue;
      const ts = rayShield(p.pos, p.dir, k, k, t);
      const h = rayMech(p.pos, p.dir, k, frameOf(k), ts >= 0 ? ts : t);
      if (h) {
        t = h.t;
        crit = h.head;
        shield = false;
      } else if (ts >= 0) {
        t = ts;
        crit = false;
        shield = true;
      } else {
        continue;
      }
      struck = k;
      normal = null;
      met = true;
    }
    // Flak bursts beside a mech it would otherwise fly past; the blast does the rest.
    if (def.mechFuse && !struck) {
      for (const k of m.mechs) {
        if (k.team === p.team || !mechActive(k)) continue;
        const B = frameOf(k).body;
        if (rayMech(p.pos, p.dir, k, frameOf(k), Infinity)) continue;
        const r = B.radius + def.mechFuse;
        const tt = rayUprightCapsule(p.pos, p.dir, k.pos.x, k.pos.z, k.pos.y + B.radius, k.pos.y + B.height - B.radius, r);
        if (tt < 0 || tt >= t) continue;
        t = tt;
        normal = null;
        met = true;
      }
    }

    p.life -= dt;
    p.pos.x += p.dir.x * t;
    p.pos.y += p.dir.y * t;
    p.pos.z += p.dir.z * t;
    if (!met && p.life > 0) continue;
    m.projectiles.splice(i--, 1);
    explode(m, world, p, { ...p.pos }, normal, struck, crit, shield);
    if (m.over) return;
  }
}
