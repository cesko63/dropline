import { BOT_ROLES, botCmd, createBrain } from '../ai/bot';
import { buildNav } from '../ai/nav';
import { emptyInput, type InputCmd } from '../input';
import type { MapData, MapSpawn } from '../map/types';
import { lenH, v3, type Vec3 } from '../math/vec3';
import { COMBAT, type Actor, type MatchState, type ShotTrace } from './combat';
import { rayPilot } from './hitscan';
import { createPlayerState, eyeHeight, playerHeight, stepPlayer } from './movement';
import { createRng, rand, randSigned } from './rng';
import { TUNING } from './tuning';
import { WEAPONS, damageFalloff, type WeaponDef } from './weapons';
import type { CollisionWorld } from './world';

/**
 * A team skirmish: pilots, weapons, damage, respawns and score. `stepMatch`
 * advances everything by one fixed tick from the players' input commands; bots
 * produce their own commands. Like movement, it depends only on its arguments
 * and a seeded generator, so the server can run it as the authority.
 */

const DEG = Math.PI / 180;
const IDLE = emptyInput();

export interface MatchOptions {
  seed: number;
  /** Human players; they take the first actor ids on team 0. Default 1. */
  humans?: number;
  teamSize?: number;
  scoreLimit?: number;
}

export const weaponOf = (a: Actor): WeaponDef => WEAPONS[a.loadout[a.weapon]];

export function createMatch(map: MapData, world: CollisionWorld, opts: MatchOptions): MatchState {
  const teamSize = opts.teamSize ?? COMBAT.teamSize;
  const humans = opts.humans ?? 1;
  const m: MatchState = {
    seed: opts.seed,
    tick: 0,
    time: 0,
    rng: createRng(opts.seed),
    actors: [],
    score: [0, 0],
    scoreLimit: opts.scoreLimit ?? COMBAT.scoreLimit,
    over: false,
    winner: -1,
    events: [],
    spawns: map.spawns,
    nav: buildNav(map, world),
    cmds: [],
  };

  let botName = 0;
  for (let team = 0; team < 2; team++) {
    let botSlot = 0;
    for (let slot = 0; slot < teamSize; slot++) {
      const id = m.actors.length;
      const human = team === 0 && slot < humans;
      const roles = COMBAT.teams[team].bots;
      const role = human ? '' : roles[botSlot++ % roles.length];
      const loadout = human ? [...COMBAT.playerLoadout] : [BOT_ROLES[role].weapon];
      const a: Actor = {
        id,
        name: human ? (humans > 1 ? `Pilot ${slot + 1}` : 'You') : COMBAT.botNames[botName++ % COMBAT.botNames.length],
        team,
        p: createPlayerState(v3()),
        health: 0,
        alive: false,
        respawnIn: 0,
        sinceDamage: 0,
        protect: 0,
        loadout,
        ammo: loadout.map((w) => WEAPONS[w].magSize),
        weapon: 0,
        cooldown: 0,
        reload: 0,
        equip: 0,
        bloom: 0,
        punchPitch: 0,
        punchYaw: 0,
        ads: 0,
        triggerHeld: false,
        fireBuffer: 0,
        lastShotTime: -10,
        damageScale: human ? 1 : BOT_ROLES[role].damageScale,
        kills: 0,
        deaths: 0,
        lastAttacker: -1,
        brain: human ? null : createBrain(role, id),
      };
      m.actors.push(a);
      spawnActor(m, a);
    }
  }
  m.events.length = 0;
  return m;
}

/** The team's spawn point farthest from any living enemy and not already occupied. */
function pickSpawn(m: MatchState, a: Actor): MapSpawn {
  let best = m.spawns[0];
  let bestScore = -Infinity;
  for (const s of m.spawns) {
    if ((s.team ?? 0) !== a.team) continue;
    let score = 60;
    for (const o of m.actors) {
      if (o === a || !o.alive) continue;
      const d = Math.hypot(o.p.pos.x - s.pos[0], o.p.pos.z - s.pos[2]);
      if (o.team !== a.team) score = Math.min(score, d);
      else if (d < 2.5) score -= 1000;
    }
    // A small random share keeps respawns from always using the same point.
    score += rand(m.rng) * 6;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/** Put an actor (back) into play at one of its team's spawn points. */
export function spawnActor(m: MatchState, a: Actor): void {
  const s = pickSpawn(m, a);
  a.p = createPlayerState(v3(s.pos[0], s.pos[1], s.pos[2]), s.yawDeg * DEG);
  a.health = COMBAT.health;
  a.alive = true;
  a.respawnIn = 0;
  a.sinceDamage = COMBAT.regenDelay;
  a.protect = COMBAT.spawnProtect;
  for (let i = 0; i < a.loadout.length; i++) a.ammo[i] = WEAPONS[a.loadout[i]].magSize;
  a.cooldown = a.reload = a.equip = a.bloom = a.punchPitch = a.punchYaw = a.ads = a.fireBuffer = 0;
  a.triggerHeld = false;
  a.lastAttacker = -1;
  if (a.brain) a.brain = createBrain(a.brain.role, a.id);
  m.events.push({ type: 'spawn', actor: a.id });
}

function killActor(m: MatchState, victim: Actor, attacker: Actor | null, weapon: string, head: boolean): void {
  victim.alive = false;
  victim.health = 0;
  victim.respawnIn = COMBAT.respawnTime;
  victim.deaths++;
  victim.reload = 0;
  victim.ads = 0;
  m.events.push({ type: 'kill', victim: victim.id, attacker: attacker ? attacker.id : -1, weapon, head });
  if (!attacker) return;
  attacker.kills++;
  m.score[attacker.team]++;
  if (m.score[attacker.team] >= m.scoreLimit && !m.over) {
    m.over = true;
    m.winner = attacker.team;
    m.events.push({ type: 'matchEnd', winner: attacker.team });
  }
}

function damageActor(m: MatchState, victim: Actor, attacker: Actor, amount: number, head: boolean, pos: Vec3, weapon: string): void {
  if (!victim.alive || victim.protect > 0 || amount <= 0) return;
  victim.health -= amount;
  victim.sinceDamage = 0;
  victim.lastAttacker = attacker.id;
  if (victim.brain) victim.brain.alertFrom = attacker.id;
  const killed = victim.health <= 0;
  m.events.push({ type: 'damage', victim: victim.id, attacker: attacker.id, amount, head, killed, pos });
  if (killed) killActor(m, victim, attacker, weapon, head);
}

/** Total spread right now, degrees: stance, bloom from firing, movement and being airborne. */
export function spreadDeg(a: Actor): number {
  const S = weaponOf(a).spread;
  const base = S.hipDeg + (S.adsDeg - S.hipDeg) * a.ads;
  const steady = 1 - 0.5 * a.ads;
  const moving = Math.min(1, lenH(a.p.vel) / TUNING.ground.sprintSpeed) * S.moveDeg;
  const air = a.p.grounded || a.p.wallrun.active ? 0 : S.airDeg;
  // Aiming steadies everything: bloom and the movement penalties shrink with it.
  return base + a.bloom * (1 - 0.6 * a.ads) + (moving + air) * steady;
}

const origin = v3();
const fwd = v3();
const right = v3();
const up = v3();
const dir = v3();

function fireWeapon(m: MatchState, a: Actor, def: WeaponDef, world: CollisionWorld): void {
  const p = a.p;
  const yaw = p.yaw + a.punchYaw;
  const pitch = p.pitch + a.punchPitch;
  const cp = Math.cos(pitch);
  fwd.x = -Math.sin(yaw) * cp;
  fwd.y = Math.sin(pitch);
  fwd.z = -Math.cos(yaw) * cp;
  right.x = Math.cos(yaw);
  right.y = 0;
  right.z = -Math.sin(yaw);
  up.x = right.y * fwd.z - right.z * fwd.y;
  up.y = right.z * fwd.x - right.x * fwd.z;
  up.z = right.x * fwd.y - right.y * fwd.x;
  origin.x = p.pos.x;
  origin.y = p.pos.y + eyeHeight(p);
  origin.z = p.pos.z;

  const cone = Math.tan(spreadDeg(a) * DEG);
  const traces: ShotTrace[] = [];
  // Raised before the damage it causes, so listeners see the shot first.
  m.events.push({ type: 'shot', actor: a.id, weapon: def.id, origin: { ...origin }, traces });
  for (let i = 0; i < def.pellets; i++) {
    // Uniform over the spread disc.
    const ang = rand(m.rng) * Math.PI * 2;
    const rad = Math.sqrt(rand(m.rng)) * cone;
    const sx = Math.cos(ang) * rad;
    const sy = Math.sin(ang) * rad;
    dir.x = fwd.x + right.x * sx + up.x * sy;
    dir.y = fwd.y + right.y * sx + up.y * sy;
    dir.z = fwd.z + right.z * sx + up.z * sy;
    const l = Math.hypot(dir.x, dir.y, dir.z);
    dir.x /= l;
    dir.y /= l;
    dir.z /= l;

    const wall = world.castRay(origin, dir, def.range);
    let t = wall ? wall.dist : def.range;
    let victim: Actor | null = null;
    let head = false;
    for (const o of m.actors) {
      if (o === a || !o.alive || o.team === a.team) continue;
      const hit = rayPilot(origin, dir, o.p.pos, playerHeight(o.p), t);
      if (!hit) continue;
      t = hit.t;
      head = hit.head;
      victim = o;
    }
    const end = v3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
    traces.push({ end, normal: victim || !wall ? null : wall.normal, victim: victim ? victim.id : -1, head: victim !== null && head });
    if (victim) {
      const amount = def.damage * damageFalloff(def, t) * (head ? def.headMult : 1) * a.damageScale;
      damageActor(m, victim, a, amount, head, end, def.id);
    }
  }

  a.ammo[a.weapon]--;
  a.lastShotTime = m.time;
  a.protect = 0;
  a.bloom = Math.min(def.spread.bloomMaxDeg, a.bloom + def.spread.bloomDeg);
  a.punchPitch += def.recoil.pitchDeg * DEG;
  a.punchYaw += randSigned(m.rng) * def.recoil.yawDeg * DEG;
}

function startReload(m: MatchState, a: Actor, def: WeaponDef): void {
  if (a.reload > 0 || a.ammo[a.weapon] >= def.magSize) return;
  a.reload = def.reloadTime;
  m.events.push({ type: 'reload', actor: a.id });
}

function stepWeapon(m: MatchState, a: Actor, cmd: InputCmd, world: CollisionWorld, dt: number): void {
  const pressed = cmd.fire && !a.triggerHeld;
  a.triggerHeld = cmd.fire;
  a.fireBuffer = pressed ? COMBAT.semiBuffer : Math.max(0, a.fireBuffer - dt);

  if (cmd.weapon >= 0 && cmd.weapon < a.loadout.length && cmd.weapon !== a.weapon) {
    a.weapon = cmd.weapon;
    a.equip = weaponOf(a).equipTime;
    a.reload = 0;
    a.bloom = 0;
    a.cooldown = 0;
    a.fireBuffer = 0;
    m.events.push({ type: 'equip', actor: a.id });
  }
  const def = weaponOf(a);

  const decay = Math.exp(-def.recoil.recover * dt);
  a.punchPitch *= decay;
  a.punchYaw *= decay;
  a.cooldown -= dt;

  const busy = a.equip > 0 || a.reload > 0 || a.p.mantle.active;
  const step = dt / def.adsTime;
  a.ads = cmd.ads && !busy ? Math.min(1, a.ads + step) : Math.max(0, a.ads - step);

  if (a.equip > 0) {
    a.equip -= dt;
  } else if (a.reload > 0) {
    a.reload -= dt;
    if (a.reload <= 0) {
      a.reload = 0;
      a.ammo[a.weapon] = def.magSize;
      m.events.push({ type: 'reloaded', actor: a.id });
    }
  } else if (cmd.reload) {
    startReload(m, a, def);
  } else if (!a.p.mantle.active && (def.fireMode === 'auto' ? cmd.fire : a.fireBuffer > 0)) {
    if (a.ammo[a.weapon] <= 0) {
      if (pressed) m.events.push({ type: 'dry', actor: a.id });
      startReload(m, a, def);
    } else if (a.cooldown <= 0) {
      fireWeapon(m, a, def, world);
      // Adding the interval (instead of setting it) carries the leftover time, so
      // the rate of fire is exact even when it does not divide into ticks.
      a.cooldown += 60 / def.rpm;
      a.fireBuffer = 0;
      if (a.ammo[a.weapon] <= 0) startReload(m, a, def);
      return;
    }
  }
  // Reached only on ticks without a shot. Bloom holds during sustained fire and
  // shrinks once the weapon rests, so short bursts stay accurate.
  if (a.cooldown <= 0) {
    a.cooldown = 0;
    a.bloom = Math.max(0, a.bloom - def.spread.bloomRecover * dt);
  }
}

export function stepMatch(m: MatchState, world: CollisionWorld, cmds: readonly (InputCmd | undefined)[], dt: number): void {
  m.events.length = 0;
  if (m.over) return;
  m.tick++;
  m.time += dt;

  // Everyone moves first, then everyone shoots, so no one fires at a stale position.
  for (const a of m.actors) {
    m.cmds[a.id] = null;
    if (!a.alive) {
      a.respawnIn -= dt;
      if (a.respawnIn <= 0) spawnActor(m, a);
      continue;
    }
    let cmd = a.brain ? botCmd(m, a, world, dt) : (cmds[a.id] ?? IDLE);
    // Aiming down sights rules out sprinting.
    if (cmd.sprint && a.ads > 0.5) cmd = { ...cmd, sprint: false };
    stepPlayer(a.p, cmd, world, dt);
    m.cmds[a.id] = cmd;
    if (a.p.pos.y < COMBAT.killY) killActor(m, a, null, '', false);
  }

  for (const a of m.actors) {
    const cmd = m.cmds[a.id];
    if (!cmd || !a.alive) continue;
    stepWeapon(m, a, cmd, world, dt);
    a.protect = Math.max(0, a.protect - dt);
    a.sinceDamage += dt;
    if (a.sinceDamage >= COMBAT.regenDelay && a.health < COMBAT.health) {
      a.health = Math.min(COMBAT.health, a.health + COMBAT.regenRate * dt);
    }
    if (m.over) break;
  }
}
