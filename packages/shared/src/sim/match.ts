import { BOTS, BOT_ROLES, botCmd, createBrain } from '../ai/bot';
import { createBodies, liveBodies, pushApart, type Bodies } from './bodies';
import { buildNav } from '../ai/nav';
import { emptyInput, type InputCmd } from '../input';
import type { MapData, MapSpawn } from '../map/types';
import { lenH, v3 } from '../math/vec3';
import { COMBAT, type Actor, type MatchState, type ShotTrace } from './combat';
import { rayPilot } from './hitscan';
import { recordHistory, rewindBodies, rewindView } from './lagcomp';
import { MECH, createMech, eyeOf, mechActive, rayMech, type Mech } from './mech';
import { stepMechs, stepSalvo } from './mechMatch';
import { createPlayerState, playerHeight, stepPlayer } from './movement';
import { spawnProjectile, stepProjectiles } from './projectiles';
import { createRng, rand, randSigned, type Rng } from './rng';
import { damageActor, damageMech, killActor } from './rules';
import { TUNING } from './tuning';
import { WEAPONS, damageFalloff, type WeaponDef } from './weapons';
import type { CollisionWorld } from './world';

/**
 * A team skirmish: pilots, mechs, weapons, damage, respawns and score.
 * `stepMatch` advances everything by one fixed tick from the players' input
 * commands; bots produce their own commands. Like movement, it depends only on
 * its arguments and a seeded generator, so the server can run it as the authority.
 */

const DEG = Math.PI / 180;
const IDLE = emptyInput();

export interface MatchOptions {
  seed: number;
  /** Human players; they take the first actor ids on team 0. Default 1. */
  humans?: number;
  teamSize?: number;
  scoreLimit?: number;
  /** Mech meter everyone starts with, 0..1. Default 0. */
  startMeter?: number;
}

/** Scratch table of where bodies stand, for `pushApart`. Grown to the largest match seen. */
let scratch: Bodies = createBodies(0);

/**
 * What pilot `a` bumps into this tick: a networked player the moment they were
 * looking at (see `bodies.ts`), anyone else where things stand now.
 */
function bodiesFor(m: MatchState, a: Actor): Bodies {
  if (scratch.length !== m.actors.length * 10) scratch = createBodies(m.actors.length);
  if (m.history && a.viewTick >= 0 && !a.brain && rewindBodies(m.history, m.tick, a.viewTick, scratch)) return scratch;
  return liveBodies(m, scratch);
}

/** The generator an actor's shots draw from: its own when it has one, else the match's. */
export const shotRng = (m: MatchState, a: Actor): Rng => a.rng ?? m.rng;

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
    mechs: [],
    projectiles: [],
    nextProjectile: 0,
    score: [0, 0],
    scoreLimit: opts.scoreLimit ?? COMBAT.scoreLimit,
    over: false,
    winner: -1,
    events: [],
    spawns: map.spawns,
    nav: buildNav(map, world),
    navMech: buildNav(map, world, MECH.body.radius, MECH.body.height),
    cmds: [],
    history: null,
    predict: false,
  };

  for (let team = 0; team < 2; team++) {
    let botSlot = 0;
    let botName = 0;
    for (let slot = 0; slot < teamSize; slot++) {
      const id = m.actors.length;
      const human = team === 0 && slot < humans;
      const roles = COMBAT.teams[team].bots;
      const role = human ? '' : roles[botSlot++ % roles.length];
      // Bots carry their role's weapon and a launcher for when a mech shows up.
      const loadout = human ? [...COMBAT.playerLoadout] : [BOT_ROLES[role].weapon, BOTS.antiArmor];
      const a: Actor = {
        id,
        name: human ? (humans > 1 ? `Pilot ${slot + 1}` : 'You') : COMBAT.teams[team].botNames[botName++ % COMBAT.teams[team].botNames.length],
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
        meter: opts.startMeter ?? 0,
        inMech: false,
        kit: null,
        useHeld: false,
        callHeld: false,
        redeployHeld: false,
        rng: null,
        viewTick: -1,
        stalled: false,
        kills: 0,
        deaths: 0,
        mechKills: 0,
        lastAttacker: -1,
        brain: human ? null : createBrain(role, id),
      };
      m.actors.push(a);
      m.mechs.push(createMech(id, team));
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
  if (a.inMech && a.kit) {
    // Redeployed out of the cockpit: the mech stays where it stands.
    a.loadout = a.kit.loadout;
    a.ammo = a.kit.ammo;
    a.weapon = a.kit.weapon;
    a.kit = null;
    a.inMech = false;
    if (a.brain) a.damageScale = BOT_ROLES[a.brain.role].damageScale;
    const k = m.mechs[a.id];
    k.state = 'idle';
    k.stateTime = 0;
  }
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

/** Total spread right now, degrees: stance, bloom from firing, movement and being airborne. */
export function spreadDeg(a: Actor): number {
  const S = weaponOf(a).spread;
  const base = S.hipDeg + (S.adsDeg - S.hipDeg) * a.ads;
  const steady = 1 - 0.5 * a.ads;
  const topSpeed = a.inMech ? MECH.move.sprintSpeed : TUNING.ground.sprintSpeed;
  const moving = Math.min(1, lenH(a.p.vel) / topSpeed) * S.moveDeg;
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
  origin.y = p.pos.y + eyeOf(a);
  origin.z = p.pos.z;

  const cone = Math.tan(spreadDeg(a) * DEG);
  const rng = shotRng(m, a);
  // A networked player aimed at what they saw, which is the past: trace against that.
  const view = m.history && a.viewTick >= 0 ? rewindView(m.history, m.tick, a.viewTick) : null;
  const traces: ShotTrace[] = [];
  // Raised before the damage it causes, so listeners see the shot first.
  m.events.push({ type: 'shot', actor: a.id, weapon: def.id, origin: { ...origin }, traces });
  for (let i = 0; i < def.pellets; i++) {
    // Uniform over the spread disc.
    const ang = rand(rng) * Math.PI * 2;
    const rad = Math.sqrt(rand(rng)) * cone;
    const sx = Math.cos(ang) * rad;
    const sy = Math.sin(ang) * rad;
    dir.x = fwd.x + right.x * sx + up.x * sy;
    dir.y = fwd.y + right.y * sx + up.y * sy;
    dir.z = fwd.z + right.z * sx + up.z * sy;
    const l = Math.hypot(dir.x, dir.y, dir.z);
    dir.x /= l;
    dir.y /= l;
    dir.z /= l;

    // A launcher sends a rocket on its way instead of a ray.
    if (def.projectile) {
      spawnProjectile(m, a, def.projectile, origin, dir);
      continue;
    }

    const wall = world.castRay(origin, dir, def.range);
    let t = wall ? wall.dist : def.range;
    let victim: Actor | null = null;
    let struck: Mech | null = null;
    let head = false;
    for (const o of m.actors) {
      if (o === a || !o.alive || o.inMech || o.team === a.team) continue;
      const was = view ? view.actors[o.id] : null;
      // Not there to be seen at that moment (it has only just respawned): no hit.
      if (view && !was) continue;
      const hit = rayPilot(origin, dir, was ? was.pos : o.p.pos, was ? was.height : playerHeight(o.p), t);
      if (!hit) continue;
      t = hit.t;
      head = hit.head;
      victim = o;
    }
    for (const k of m.mechs) {
      if (k.team === a.team || !mechActive(k)) continue;
      const was = view ? view.mechs[k.id] : k;
      if (!was) continue;
      const hit = rayMech(origin, dir, was, t);
      if (!hit) continue;
      t = hit.t;
      head = hit.head;
      struck = k;
      victim = null;
    }
    const end = v3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
    const hitSomeone = victim !== null || struck !== null;
    traces.push({ end, normal: hitSomeone || !wall ? null : wall.normal, victim: victim ? victim.id : -1, mech: struck ? struck.id : -1, head: hitSomeone && head });
    // On a client the shot is only drawn; whether it hurt anyone is the server's call.
    if (m.predict) continue;
    if (struck) {
      const amount = def.armor * damageFalloff(def, t) * (head ? MECH.vent.mult : 1) * a.damageScale;
      damageMech(m, struck, a, amount, head, end, def.id);
    } else if (victim) {
      const amount = def.damage * damageFalloff(def, t) * (head ? def.headMult : 1) * a.damageScale;
      damageActor(m, victim, a, amount, head, end, def.id);
    }
  }

  a.ammo[a.weapon]--;
  a.lastShotTime = m.time;
  a.protect = 0;
  a.bloom = Math.min(def.spread.bloomMaxDeg, a.bloom + def.spread.bloomDeg);
  a.punchPitch += def.recoil.pitchDeg * DEG;
  a.punchYaw += randSigned(rng) * def.recoil.yawDeg * DEG;
}

function startReload(m: MatchState, a: Actor, def: WeaponDef): void {
  if (a.reload > 0 || a.ammo[a.weapon] >= def.magSize) return;
  a.reload = def.reloadTime;
  m.events.push({ type: 'reload', actor: a.id });
}

/** One tick of an actor's weapon: switching, aiming, reloading and firing. */
export function stepWeapon(m: MatchState, a: Actor, cmd: InputCmd, world: CollisionWorld, dt: number): void {
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

/**
 * Advance the match by one tick. `cmds` holds each human's command by actor id.
 * A missing entry (`undefined`) is a player doing nothing; `null` is a player
 * whose command has not arrived yet (a networked player running late): that
 * pilot is held exactly as it is for the tick, so that when the command does
 * arrive it meets the state the player's own machine predicted from.
 */
export function stepMatch(m: MatchState, world: CollisionWorld, cmds: readonly (InputCmd | null | undefined)[], dt: number): void {
  m.events.length = 0;
  if (m.over) return;
  m.tick++;
  m.time += dt;

  // Everyone moves first, then everyone shoots, so no one fires at a stale position.
  for (const a of m.actors) {
    m.cmds[a.id] = null;
    a.stalled = false;
    if (!a.alive) {
      a.respawnIn -= dt;
      if (a.respawnIn <= 0) spawnActor(m, a);
      continue;
    }
    if (!a.brain && cmds[a.id] === null) {
      a.stalled = true;
      a.p.events = 0;
      continue;
    }
    let cmd = a.brain ? botCmd(m, a, world, dt) : (cmds[a.id] ?? IDLE);
    // Giving up the position for a fresh start at a spawn point. Not from a cockpit: climb out first.
    const redeploy = cmd.redeploy && !a.redeployHeld && !a.inMech;
    a.redeployHeld = cmd.redeploy;
    if (redeploy) {
      spawnActor(m, a);
      continue;
    }
    // Aiming down sights rules out sprinting.
    if (cmd.sprint && a.ads > 0.5) cmd = { ...cmd, sprint: false };
    m.cmds[a.id] = cmd;
    // A pilot in a mech is moved by the mech, below.
    if (a.inMech) continue;
    stepPlayer(a.p, cmd, world, dt);
    pushApart(a, bodiesFor(m, a), world, dt);
    if (a.p.pos.y < COMBAT.killY) killActor(m, a, null, '', false);
  }
  stepMechs(m, world, dt);
  if (m.over) return;

  for (const a of m.actors) {
    const cmd = m.cmds[a.id];
    // A held pilot's weapon waits with it, but its health and protection run on the match's clock.
    if (!a.alive || (!cmd && !a.stalled)) continue;
    if (!cmd) {
      // Nothing to fire with this tick.
    } else if (a.inMech) {
      // In the cockpit the aim button launches rockets, and nothing fires until the mech is up.
      const k = m.mechs[a.id];
      if (k.state === 'piloted') {
        stepWeapon(m, a, { ...cmd, ads: false, weapon: -1 }, world, dt);
        if (a.inMech) stepSalvo(m, a, k, cmd.ads, world, dt);
      }
    } else {
      stepWeapon(m, a, cmd, world, dt);
    }
    a.protect = Math.max(0, a.protect - dt);
    a.sinceDamage += dt;
    if (a.sinceDamage >= COMBAT.regenDelay && a.health < COMBAT.health) {
      a.health = Math.min(COMBAT.health, a.health + COMBAT.regenRate * dt);
    }
    if (m.over) return;
  }
  stepProjectiles(m, world, dt);
  if (m.history) recordHistory(m, m.history);
}

/**
 * A player takes over a bot's place: the pilot starts again at a spawn point
 * with the player's weapons, under the player's name. Its team, its mech meter
 * and any mech it has standing stay as they are.
 */
export function seatHuman(m: MatchState, a: Actor, name: string): void {
  a.brain = null;
  a.name = name;
  a.damageScale = 1;
  // First the fresh start (which also fetches the pilot's kit back from a cockpit), then the new kit.
  spawnActor(m, a);
  a.loadout = [...COMBAT.playerLoadout];
  a.ammo = a.loadout.map((w) => WEAPONS[w].magSize);
  a.weapon = 0;
  a.kills = a.deaths = a.mechKills = 0;
  a.useHeld = a.callHeld = a.redeployHeld = false;
  a.rng = createRng((m.seed ^ Math.imul(a.id + 1, 0x9e3779b1)) >>> 0);
  a.viewTick = -1;
}

/** A player left: a bot of the given role takes the place over, the same way. */
export function seatBot(m: MatchState, a: Actor, role: string, name: string): void {
  a.name = name;
  a.brain = createBrain(role, a.id);
  a.damageScale = BOT_ROLES[role].damageScale;
  spawnActor(m, a);
  a.loadout = [BOT_ROLES[role].weapon, BOTS.antiArmor];
  a.ammo = a.loadout.map((w) => WEAPONS[w].magSize);
  a.weapon = 0;
  a.rng = null;
  a.viewTick = -1;
}
