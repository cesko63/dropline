import { BOT_ROLES } from '../ai/bot';
import { type Vec3 } from '../math/vec3';
import { COMBAT, type Actor, type MatchState } from './combat';
import { MECH, type Mech } from './mech';
import { createPlayerState } from './movement';
import { WEAPONS } from './weapons';

/**
 * What changes hands in a match: damage, kills, score, the mech meter, and a
 * pilot getting into and out of a mech. Weapons, rockets, rams and landings all
 * end up here, so every source of damage follows the same rules.
 */

const R = COMBAT.mech;

export function addScore(m: MatchState, team: number, points: number): void {
  m.score[team] += points;
  if (m.score[team] >= m.scoreLimit && !m.over) {
    m.over = true;
    m.winner = team;
    m.events.push({ type: 'matchEnd', winner: team });
  }
}

/** Charge an actor's mech meter. It only fills while the pilot has no mech out. */
export function addMeter(m: MatchState, a: Actor, amount: number): void {
  if (a.meter >= 1 || m.mechs[a.id].state !== 'none') return;
  a.meter = Math.min(1, a.meter + amount);
  if (a.meter >= 1) m.events.push({ type: 'meterReady', actor: a.id });
}

export function killActor(m: MatchState, victim: Actor, attacker: Actor | null, weapon: string, head: boolean): void {
  victim.alive = false;
  victim.health = 0;
  victim.respawnIn = COMBAT.respawnTime;
  victim.deaths++;
  victim.reload = 0;
  victim.ads = 0;
  m.events.push({ type: 'kill', victim: victim.id, attacker: attacker ? attacker.id : -1, weapon, head });
  if (!attacker) return;
  attacker.kills++;
  addMeter(m, attacker, R.meter.perKill);
  addScore(m, attacker.team, 1);
}

export function damageActor(m: MatchState, victim: Actor, attacker: Actor, amount: number, head: boolean, pos: Vec3, weapon: string): void {
  // A pilot inside a mech cannot be reached; the hull takes the hits.
  if (!victim.alive || victim.inMech || victim.protect > 0 || amount <= 0) return;
  addMeter(m, attacker, Math.min(amount, victim.health) * R.meter.perDamage);
  victim.health -= amount;
  victim.sinceDamage = 0;
  victim.lastAttacker = attacker.id;
  if (victim.brain) victim.brain.alertFrom = attacker.id;
  const killed = victim.health <= 0;
  m.events.push({ type: 'damage', victim: victim.id, attacker: attacker.id, amount, head, killed, pos });
  if (killed) killActor(m, victim, attacker, weapon, head);
}

/** `attacker` is null when nobody did it (the mech fell out of the world). */
export function destroyMech(m: MatchState, k: Mech, attacker: Actor | null, weapon: string): void {
  const owner = m.actors[k.id];
  const pos = { ...k.pos };
  // The pilot is thrown clear and fights on.
  if (owner.inMech) leaveMech(m, owner, k, true);
  k.state = 'none';
  k.health = 0;
  k.salvoLeft = 0;
  owner.meter = 0;
  m.events.push({ type: 'mechDestroyed', mech: k.id, attacker: attacker ? attacker.id : -1, weapon, pos });
  if (!attacker) return;
  attacker.mechKills++;
  addScore(m, attacker.team, R.destroyScore);
}

export function damageMech(m: MatchState, k: Mech, attacker: Actor, amount: number, crit: boolean, pos: Vec3, weapon: string): void {
  if (k.state === 'none' || k.state === 'dropping' || amount <= 0) return;
  addMeter(m, attacker, Math.min(amount, k.health) * R.meter.perArmor);
  k.health -= amount;
  k.lastAttacker = attacker.id;
  const owner = m.actors[k.id];
  if (owner.inMech && owner.brain) owner.brain.alertFrom = attacker.id;
  const destroyed = k.health <= 0;
  m.events.push({ type: 'mechDamage', mech: k.id, attacker: attacker.id, amount, crit, destroyed, pos });
  if (destroyed) destroyMech(m, k, attacker, weapon);
}

function resetWeaponState(a: Actor): void {
  a.cooldown = a.reload = a.equip = a.bloom = a.punchPitch = a.punchYaw = a.ads = a.fireBuffer = 0;
  a.triggerHeld = false;
}

/** The pilot climbs in. The mech starts up for a moment before it answers the controls. */
export function enterMech(m: MatchState, a: Actor, k: Mech): void {
  a.inMech = true;
  a.kit = { loadout: a.loadout, ammo: a.ammo, weapon: a.weapon };
  a.loadout = [...MECH.loadout];
  a.ammo = k.ammo;
  a.weapon = 0;
  resetWeaponState(a);
  const pitch = a.p.pitch;
  a.p = createPlayerState(k.pos, a.p.yaw);
  a.p.pitch = pitch;
  a.p.grounded = k.grounded;
  if (a.brain) {
    a.damageScale = BOT_ROLES.mech.damageScale;
    // Plans made on foot do not fit the machine: start over.
    a.brain.hasGoal = false;
    a.brain.charge = 0;
    a.brain.burst = 0;
    a.brain.hopIn = 2;
  }
  k.state = 'boot';
  k.stateTime = 0;
  k.vel.x = k.vel.z = 0;
  m.events.push({ type: 'embark', actor: a.id, duration: R.embark.time });
}

/**
 * The pilot leaves through the top hatch with a hop, or is thrown high into the
 * air when the mech is destroyed around them (`eject`). Either way they come out
 * airborne with their own weapons and a fresh double jump.
 */
export function leaveMech(m: MatchState, a: Actor, k: Mech, eject: boolean): void {
  const E = R.embark;
  const kit = a.kit!;
  a.inMech = false;
  a.kit = null;
  a.loadout = kit.loadout;
  a.ammo = kit.ammo;
  a.weapon = kit.weapon;
  resetWeaponState(a);
  a.equip = WEAPONS[a.loadout[a.weapon]].equipTime;
  if (a.brain) {
    a.damageScale = BOT_ROLES[a.brain.role].damageScale;
    a.brain.hasGoal = false;
  }

  // Just under the top of the mech's own body, which is known to be clear of the map.
  const yaw = k.yaw;
  const top = { x: k.pos.x, y: k.pos.y + MECH.body.height - 1.9, z: k.pos.z };
  a.p = createPlayerState(top, yaw);
  a.p.pitch = eject ? 0 : k.pitch;
  a.p.vel.x = eject ? 0 : -Math.sin(yaw) * E.exitForward;
  a.p.vel.y = eject ? E.ejectUp : E.exitUp;
  a.p.vel.z = eject ? 0 : -Math.cos(yaw) * E.exitForward;
  a.protect = Math.max(a.protect, eject ? E.ejectProtect : E.exitProtect);

  if (!eject) {
    k.state = 'idle';
    k.stateTime = 0;
  }
  k.salvoLeft = 0;
  k.dashHeld = false;
  m.events.push({ type: 'disembark', actor: a.id, eject });
}
