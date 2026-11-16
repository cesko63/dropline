import bots from '../../../../data/bots.json';
import { emptyInput, type InputCmd } from '../input';
import { clamp, forwardFromYaw, lenH, rightFromYaw, v3, type Vec3 } from '../math/vec3';
import { COMBAT, type Actor, type MatchState } from '../sim/combat';
import { eyeOf, heightOf, type Mech } from '../sim/mech';
import { rand, randRange, randSigned } from '../sim/rng';
import { TUNING } from '../sim/tuning';
import { PROJECTILES, WEAPONS } from '../sim/weapons';
import type { CollisionWorld } from '../sim/world';
import { Link, PATH_STRIDE, findPath, randomNavPoint, walkableLine, type NavGrid } from './nav';

/** Bot senses and per-role behaviour. Edit /data/bots.json, not this file. */
export const BOTS = bots;

export interface BotRole {
  weapon: string;
  /** Seconds between spotting a target and reacting to it. */
  reaction: number;
  turnRateDeg: number;
  /** Aim error right after acquiring a target, and what it settles down to. */
  aimErrStartDeg: number;
  aimErrMinDeg: number;
  aimSettle: number;
  /** Extra aim error per m/s of target speed: fast pilots are hard to track. */
  speedErr: number;
  /** Aim point as a fraction of the target's height. */
  aimHeight: number;
  /** The bot backs off inside `minRange` and closes in beyond `maxRange`. */
  minRange: number;
  maxRange: number;
  fireRange: number;
  /** Seconds of fire per burst, and of rest between bursts: [min, max]. */
  burst: number[];
  burstPause: number[];
  /** Over 0: every shot is lined up for this long behind a visible laser. */
  chargeTime: number;
  damageScale: number;
  /** Sprints and slides at the target instead of holding a distance. */
  rush: boolean;
  /** Share of patrols that head for a perch high above the street, to hold it a while. */
  perchChance: number;
}

export const BOT_ROLES = bots.roles as Record<string, BotRole>;

/** How the bot behaves right now: its own role on foot, the `mech` role in a cockpit. */
const roleOf = (a: Actor): BotRole => BOT_ROLES[a.inMech ? 'mech' : a.brain!.role];

/** The grid the bot can move on: a mech needs more room than a pilot. */
const navOf = (m: MatchState, a: Actor): NavGrid => (a.inMech ? m.navMech : m.nav);

const stance = { min: 0, max: 0, fire: 0, rush: false };

/**
 * How a bot stands against its target. On foot against a mech every role does
 * the same: keep well away from it and use the launcher.
 */
function stanceFor(a: Actor, tgt: Actor): typeof stance {
  const role = roleOf(a);
  const armored = tgt.inMech && !a.inMech;
  stance.min = armored ? Math.max(role.minRange, BOTS.mechMinRange) : role.minRange;
  stance.max = armored ? Math.max(role.maxRange, BOTS.mechMaxRange) : role.maxRange;
  stance.fire = armored && a.loadout.includes(BOTS.antiArmor) ? BOTS.antiArmorRange : role.fireRange;
  stance.rush = role.rush && !armored;
  return stance;
}

export type BotStateName = 'patrol' | 'notice' | 'engage' | 'search';

export interface BotBrain {
  role: string;
  state: BotStateName;
  stateTime: number;
  thinkIn: number;

  /** Actor id being hunted, or -1. */
  target: number;
  /** Whether the target was in sight at the last think. */
  visible: boolean;
  /** Seconds the target has been out of sight. */
  unseen: number;
  lastSeen: Vec3;
  /** Holds one of the target's attack tokens: only token holders may fire. */
  token: boolean;
  /** Attacker id set when hit, cleared at the next think. */
  alertFrom: number;

  hasGoal: boolean;
  goalX: number;
  goalY: number;
  goalZ: number;
  /** Waypoints: x, y, z and how to get there (see PATH_STRIDE). */
  path: number[];
  pathI: number;
  repathIn: number;
  /** How the bot gets to the waypoint it is heading for: walking, climbing... */
  link: number;
  /** The patrol goal is a perch; on arrival the bot holds it for `holdFor` seconds, looking toward `holdYaw`. */
  perch: boolean;
  holdFor: number;
  holdYaw: number;

  aimYaw: number;
  aimPitch: number;
  /** Current aim error and the error it is drifting toward, degrees. */
  errYaw: number;
  errPitch: number;
  errToYaw: number;
  errToPitch: number;
  errScale: number;

  burst: number;
  pause: number;
  /** 0..1 progress of lining up a charged shot. */
  charge: number;

  strafe: number;
  strafeIn: number;
  jumpFor: number;
  crouchFor: number;
  slideIn: number;
  hopIn: number;

  wantMove: boolean;
  stuck: number;
  lastX: number;
  lastZ: number;
}

const DEG = Math.PI / 180;

export function createBrain(role: string, id: number): BotBrain {
  return {
    role,
    state: 'patrol',
    stateTime: 0,
    // Spread the bots' thinking over different ticks.
    thinkIn: ((id % 6) / 6) * BOTS.thinkInterval,
    target: -1,
    visible: false,
    unseen: 0,
    lastSeen: v3(),
    token: false,
    alertFrom: -1,
    hasGoal: false,
    goalX: 0,
    goalY: 0,
    goalZ: 0,
    path: [],
    pathI: 0,
    repathIn: 0,
    link: Link.Walk,
    perch: false,
    holdFor: 0,
    holdYaw: 0,
    aimYaw: 0,
    aimPitch: 0,
    errYaw: 0,
    errPitch: 0,
    errToYaw: 0,
    errToPitch: 0,
    errScale: 0,
    burst: 0,
    pause: 0,
    charge: 0,
    strafe: id % 2 ? 1 : -1,
    strafeIn: 0,
    jumpFor: 0,
    crouchFor: 0,
    slideIn: 0,
    hopIn: 2,
    wantMove: false,
    stuck: 0,
    lastX: 0,
    lastZ: 0,
  };
}

const angDiff = (a: number, b: number): number => Math.atan2(Math.sin(a - b), Math.cos(a - b));

const distH = (a: Actor, b: Actor): number => Math.hypot(a.p.pos.x - b.p.pos.x, a.p.pos.z - b.p.pos.z);

const eye = v3();
const dir = v3();

/**
 * Sight: range, a view cone and a clear line to the chest. `aware` skips the
 * cone, for a target the bot is already fighting.
 */
export function canSee(world: CollisionWorld, a: Actor, e: Actor, aware: boolean): boolean {
  eye.x = a.p.pos.x;
  eye.y = a.p.pos.y + eyeOf(a);
  eye.z = a.p.pos.z;
  const dx = e.p.pos.x - eye.x;
  const dy = e.p.pos.y + heightOf(e) * 0.7 - eye.y;
  const dz = e.p.pos.z - eye.z;
  const d = Math.hypot(dx, dy, dz);
  if (d > BOTS.sightRange) return false;
  if (d < 0.5) return true;
  if (!aware && d > BOTS.closeRange) {
    const f = forwardFromYaw(a.p.yaw);
    const h = Math.hypot(dx, dz) || 1;
    if ((f.x * dx + f.z * dz) / h < Math.cos((BOTS.fovDeg / 2) * DEG)) return false;
  }
  dir.x = dx / d;
  dir.y = dy / d;
  dir.z = dz / d;
  const hit = world.castRay(eye, dir, d);
  return !hit || hit.dist > d - 0.1;
}

/** How many living bots hold an attack token on this target. */
function tokensOn(m: MatchState, target: number): number {
  let n = 0;
  for (const o of m.actors) if (o.alive && o.brain?.token && o.brain.target === target) n++;
  return n;
}

function setGoal(m: MatchState, a: Actor, x: number, y: number, z: number): boolean {
  const b = a.brain!;
  const pos = a.p.pos;
  b.goalX = x;
  b.goalY = y;
  b.goalZ = z;
  b.hasGoal = findPath(navOf(m, a), pos.x, pos.y, pos.z, x, y, z, b.path);
  b.pathI = b.path.length > PATH_STRIDE ? 1 : 0;
  b.link = Link.Walk;
  return b.hasGoal;
}

const point = { x: 0, y: 0, z: 0 };

/**
 * Patrols mostly push toward the enemy's side of the map, sometimes wander.
 * Some roles like to climb to a perch and hold it for a while.
 */
function pickPatrolGoal(m: MatchState, a: Actor): void {
  const b = a.brain!;
  const nav = navOf(m, a);
  b.perch = false;
  if (rand(m.rng) < roleOf(a).perchChance && nearbyPerch(m, a, nav) && setGoal(m, a, point.x, point.y, point.z)) {
    b.perch = true;
    return;
  }
  if (rand(m.rng) < 0.6) {
    const theirs = m.spawns.filter((s) => (s.team ?? 0) !== a.team);
    if (theirs.length > 0) {
      const s = theirs[Math.floor(rand(m.rng) * theirs.length)];
      if (setGoal(m, a, s.pos[0] + randSigned(m.rng) * 8, s.pos[1], s.pos[2] + randSigned(m.rng) * 8)) return;
    }
  }
  if (randomNavPoint(nav, m.rng, point)) setGoal(m, a, point.x, point.y, point.z);
}

/** A perch not far off: the closest of a few picked at random, written to `point`. */
function nearbyPerch(m: MatchState, a: Actor, nav: NavGrid): boolean {
  let bestX = 0, bestY = 0, bestZ = 0, bestD = Infinity;
  for (let k = 0; k < 6 && randomNavPoint(nav, m.rng, point, nav.high); k++) {
    const d = Math.hypot(point.x - a.p.pos.x, point.z - a.p.pos.z);
    if (d < bestD) (bestD = d), (bestX = point.x), (bestY = point.y), (bestZ = point.z);
  }
  point.x = bestX;
  point.y = bestY;
  point.z = bestZ;
  return bestD < Infinity;
}

/** Arrived on a perch: stay a while, looking toward the enemy's side. */
function holdPerch(m: MatchState, a: Actor): void {
  const b = a.brain!;
  let x = 0, z = 0, k = 0;
  for (const s of m.spawns) {
    if ((s.team ?? 0) === a.team) continue;
    x += s.pos[0];
    z += s.pos[2];
    k++;
  }
  b.perch = false;
  b.holdFor = randRange(m.rng, BOTS.perchHold[0], BOTS.perchHold[1]);
  b.holdYaw = k > 0 ? Math.atan2(-(x / k - a.p.pos.x), -(z / k - a.p.pos.z)) : a.p.yaw;
}

/** The only place bot states change. Runs the old state's exit, then the new state's enter. */
function enter(m: MatchState, a: Actor, next: BotStateName): void {
  const b = a.brain!;
  if (b.state === 'engage') {
    b.token = false;
    b.charge = 0;
    b.burst = 0;
  }
  b.state = next;
  b.stateTime = 0;
  b.holdFor = 0;
  b.perch = false;
  switch (next) {
    case 'patrol':
      b.target = -1;
      b.visible = false;
      b.hasGoal = false;
      break;
    case 'notice':
      m.events.push({ type: 'notice', actor: a.id, target: b.target });
      break;
    case 'engage':
      b.errScale = roleOf(a).aimErrStartDeg;
      b.unseen = 0;
      b.pause = 0;
      b.repathIn = 0;
      break;
    case 'search':
      b.visible = false;
      setGoal(m, a, b.lastSeen.x, b.lastSeen.y, b.lastSeen.z);
      break;
  }
}

function markSeen(b: BotBrain, e: Actor): void {
  b.lastSeen.x = e.p.pos.x;
  b.lastSeen.y = e.p.pos.y;
  b.lastSeen.z = e.p.pos.z;
  b.unseen = 0;
}

/** Decisions, a few times a second: what the bot sees and which state follows from it. */
function think(m: MatchState, a: Actor, world: CollisionWorld): void {
  const b = a.brain!;
  const role = roleOf(a);
  const T = BOTS.thinkInterval;
  const pos = a.p.pos;

  const moved = Math.hypot(pos.x - b.lastX, pos.z - b.lastZ);
  b.lastX = pos.x;
  b.lastZ = pos.z;
  b.stuck = b.wantMove && moved < 0.1 ? b.stuck + T : Math.max(0, b.stuck - T * 2);
  if (b.stuck > 0.5 && b.jumpFor < -0.6) b.jumpFor = 0.12;
  // Fell off the way (a missed leap, a shove off a deck): plan again from down here.
  if (b.hasGoal && b.pathI > 0 && !a.inMech && a.p.grounded) {
    const o = b.pathI * PATH_STRIDE;
    if (pos.y < Math.min(b.path[o + 1], b.path[o + 1 - PATH_STRIDE]) - 1.5) setGoal(m, a, b.goalX, b.goalY, b.goalZ);
  }

  let tgt: Actor | null = b.target >= 0 ? m.actors[b.target] : null;
  if (tgt && !tgt.alive) tgt = null;
  const sees = tgt !== null && canSee(world, a, tgt, b.state !== 'patrol');
  // Prefer the current target; another enemy takes over only when clearly closer.
  let best = sees ? tgt : null;
  let bestD = sees ? distH(a, tgt!) * 0.7 : Infinity;
  for (const e of m.actors) {
    if (e.team === a.team || !e.alive || e === tgt) continue;
    const d = distH(a, e);
    if (d >= bestD || !canSee(world, a, e, false)) continue;
    best = e;
    bestD = d;
  }
  const alert = b.alertFrom >= 0 ? m.actors[b.alertFrom] : null;
  b.alertFrom = -1;

  switch (b.state) {
    case 'patrol':
    case 'search': {
      if (best) {
        b.target = best.id;
        markSeen(b, best);
        enter(m, a, 'notice');
        break;
      }
      // Being shot, or hearing gunfire nearby, sends the bot to look.
      let source = alert && alert.alive ? alert : null;
      if (!source && b.state === 'patrol') {
        for (const e of m.actors) {
          if (e.team === a.team || !e.alive || m.time - e.lastShotTime > 0.3) continue;
          if (distH(a, e) < BOTS.hearRange) source = e;
        }
      }
      if (source) {
        b.target = source.id;
        markSeen(b, source);
        enter(m, a, 'search');
        break;
      }
      // Its own mech standing empty comes before any patrol: go and get in.
      const mine = m.mechs[a.id];
      if (!a.inMech && mine.state === 'idle') {
        if (!b.hasGoal || Math.hypot(b.goalX - mine.pos.x, b.goalZ - mine.pos.z) > 1 || b.stuck > 1.5) setGoal(m, a, mine.pos.x, mine.pos.y, mine.pos.z);
        break;
      }
      if (b.holdFor > 0) break;
      const there = Math.hypot(pos.x - b.goalX, pos.z - b.goalZ) < 2.5 && Math.abs(pos.y - b.goalY) < 1.5;
      const arrived = !b.hasGoal || there;
      if (b.state === 'search') {
        if (arrived || b.stateTime > BOTS.searchTime) enter(m, a, 'patrol');
        else if (b.stuck > 1.5) setGoal(m, a, b.goalX, b.goalY, b.goalZ);
      } else if (there && b.perch) {
        holdPerch(m, a);
      } else if (arrived || b.stuck > 4) {
        pickPatrolGoal(m, a);
        b.stuck = 0;
      } else if (b.stuck > 1.5) {
        setGoal(m, a, b.goalX, b.goalY, b.goalZ);
      }
      break;
    }
    case 'notice':
      if (!tgt) {
        enter(m, a, 'patrol');
        break;
      }
      if (sees) markSeen(b, tgt);
      b.visible = sees;
      if (b.stateTime >= role.reaction) enter(m, a, 'engage');
      break;
    case 'engage': {
      if (best && best !== tgt) {
        // Switching targets drops the token and starts the aim from scratch.
        b.target = best.id;
        b.token = false;
        b.charge = 0;
        b.errScale = role.aimErrStartDeg;
        tgt = best;
      }
      if (!tgt) {
        enter(m, a, 'patrol');
        break;
      }
      b.visible = best === tgt;
      if (b.visible) markSeen(b, tgt);
      else {
        b.unseen += T;
        if (b.unseen > BOTS.loseSightTime) {
          enter(m, a, 'search');
          break;
        }
      }
      // A token is only worth holding by a bot that can use it right now.
      if (!b.visible || a.reload > 0 || distH(a, tgt) > stanceFor(a, tgt).fire) b.token = false;
      else if (!b.token && tokensOn(m, tgt.id) < BOTS.tokensPerTarget) b.token = true;

      // Only speed across the line of sight makes a target hard to track;
      // running straight at the bot does not.
      const v = tgt.p.vel;
      const lx = tgt.p.pos.x - pos.x;
      const ly = tgt.p.pos.y - pos.y;
      const lz = tgt.p.pos.z - pos.z;
      const ll = Math.hypot(lx, ly, lz) || 1;
      const toward = (v.x * lx + v.y * ly + v.z * lz) / ll;
      const across = Math.sqrt(Math.max(0, v.x * v.x + v.y * v.y + v.z * v.z - toward * toward));
      const scale = b.errScale * (1 + role.speedErr * across);
      b.errToYaw = randSigned(m.rng) * scale;
      b.errToPitch = randSigned(m.rng) * scale * 0.6;
      break;
    }
  }
}

const move = { x: 0, z: 0 };

/** Direction to the next waypoint, or null once the path is done. */
function follow(a: Actor): { x: number; z: number } | null {
  const b = a.brain!;
  if (!b.hasGoal) return null;
  const n = b.path.length / PATH_STRIDE;
  const pos = a.p.pos;
  // A mech turns wide, so it counts a waypoint as reached from further off.
  const reach = a.inMech ? 1.2 : 0;
  while (b.pathI < n) {
    const o = b.pathI * PATH_STRIDE;
    const dx = b.path[o] - pos.x;
    const dz = b.path[o + 2] - pos.z;
    const d = Math.hypot(dx, dz);
    // A climb, drop or leap starts from its waypoint itself, lined up with it.
    const next = b.pathI === n - 1 ? -1 : b.path[o + PATH_STRIDE + 3];
    const near = next < 0 ? 0.6 : next === Link.Walk ? 1.1 : 0.45;
    // Reached on its own floor: up on top after a climb, down below after a drop.
    const kind = b.path[o + 3];
    const dy = pos.y - b.path[o + 1];
    if (d < near + reach && dy > (kind === Link.Climb ? -0.5 : -1.2) && dy < (kind === Link.Drop ? 0.5 : 1.2)) {
      b.pathI++;
      continue;
    }
    b.link = kind;
    move.x = d > 0.05 ? dx / d : 0;
    move.z = d > 0.05 ? dz / d : 0;
    return move;
  }
  b.hasGoal = false;
  b.link = Link.Walk;
  return null;
}

/**
 * The jump button on a climb or a leap. On the ground it presses (again, after a
 * failed try). Up a wall it holds for the jetpack until the feet are over the
 * top; the mantle pulls the body over. No double jump there: its push into the
 * wall would start a wallrun. Over a gap a running jump at walking pace is
 * enough; only when it falls short does the bot double jump and hold the
 * jetpack to carry the rest of the way.
 */
function jumpButton(a: Actor, link: number, x: number, y: number, z: number): boolean {
  const p = a.p;
  if (p.grounded) return !p.jumpHeld;
  // Hold only, never a fresh press in the air: that would be a double jump over the top.
  if (link === Link.Climb) return p.jumpHeld && p.pos.y < y + 0.1;
  const dx = x - p.pos.x;
  const dz = z - p.pos.z;
  const short = p.vel.y < 0 && p.pos.y < y + 0.3 && Math.hypot(dx, dz) >= 1.2 && p.vel.x * dx + p.vel.z * dz > 0;
  return short && !(p.airJumpsUsed === 0 && p.jumpHeld);
}

/** Walk to the bot's own empty mech, re-planning as it goes. */
function goToMech(m: MatchState, a: Actor, k: Mech, dt: number): { x: number; z: number } | null {
  const b = a.brain!;
  b.repathIn -= dt;
  if (b.repathIn <= 0 || !b.hasGoal) {
    b.repathIn = 0.5;
    setGoal(m, a, k.pos.x, k.pos.y, k.pos.z);
  }
  return follow(a);
}

/** Movement while fighting: hold the role's distance, strafe, or rush. */
function engageMove(m: MatchState, a: Actor, tgt: Actor, dist: number, dt: number): { x: number; z: number } | null {
  const b = a.brain!;
  const role = stanceFor(a, tgt);
  const pos = a.p.pos;
  b.strafeIn -= dt;
  if (b.strafeIn <= 0) {
    b.strafe = -b.strafe;
    b.strafeIn = randRange(m.rng, 0.5, 1.4);
  }
  // A marksman stands still while lining up a shot.
  if (b.charge > 0) return null;

  // Out of sight, out of range, or for a rusher on another floor: go after it.
  if (!b.visible || dist > role.max || (role.rush && Math.abs(tgt.p.pos.y - pos.y) > 2)) {
    b.repathIn -= dt;
    if (b.repathIn <= 0 || !b.hasGoal) {
      b.repathIn = 0.5;
      setGoal(m, a, b.lastSeen.x, b.lastSeen.y, b.lastSeen.z);
    }
    return follow(a);
  }
  b.link = Link.Walk;

  const tx = (tgt.p.pos.x - pos.x) / (dist || 1);
  const tz = (tgt.p.pos.z - pos.z) / (dist || 1);
  const along = dist < role.min ? -0.9 : role.rush && dist > 3 ? 0.5 : 0.1;
  const ahead = a.inMech ? 2.6 : 1.3;
  for (let attempt = 0; attempt < 2; attempt++) {
    const x = -tz * b.strafe + tx * along;
    const z = tx * b.strafe + tz * along;
    const l = Math.hypot(x, z) || 1;
    // Strafe only where the floor goes on: nobody steps off a deck by accident.
    if (walkableLine(navOf(m, a), pos.x, pos.y, pos.z, pos.x + (x / l) * ahead, pos.y, pos.z + (z / l) * ahead)) {
      move.x = x / l;
      move.z = z / l;
      return move;
    }
    b.strafe = -b.strafe;
  }
  return null;
}

/** One tick of a bot: think when due, then steer, aim and work the trigger. */
export function botCmd(m: MatchState, a: Actor, world: CollisionWorld, dt: number): InputCmd {
  const b = a.brain!;
  const role = roleOf(a);
  const p = a.p;
  const pos = p.pos;
  const mine = m.mechs[a.id];
  /** Distance to the bot's own empty mech, or -1 when there is none to walk to. */
  const toMech = !a.inMech && mine.state === 'idle' ? Math.hypot(mine.pos.x - pos.x, mine.pos.z - pos.z) : -1;
  b.stateTime += dt;
  b.thinkIn -= dt;
  b.jumpFor -= dt;
  b.crouchFor -= dt;
  b.slideIn -= dt;
  b.holdFor -= dt;
  if (b.thinkIn <= 0) {
    think(m, a, world);
    b.thinkIn += BOTS.thinkInterval;
  }

  const cmd = emptyInput();
  const tgt = b.target >= 0 && m.actors[b.target].alive ? m.actors[b.target] : null;
  let wantYaw = p.yaw;
  let wantPitch = 0;
  let go: { x: number; z: number } | null = null;
  let sprint = false;
  let fire = false;
  let ads = false;

  if (tgt && (b.state === 'engage' || b.state === 'notice')) {
    const from = b.visible ? tgt.p.pos : b.lastSeen;
    // A charged shot is aimed where the target will be when it goes off, if the
    // target keeps its course: changing direction during the lock dodges it.
    let lead = b.visible && b.charge > 0 ? (1 - BOTS.chargeLock) * role.chargeTime : 0;
    // A rocket is aimed ahead of the target by its time of flight. A mech is too
    // slow to walk out from under it; a dash or a change of direction does it.
    const rocket = WEAPONS[a.loadout[a.weapon]].projectile;
    if (rocket && b.visible) lead += Math.hypot(from.x - pos.x, from.z - pos.z) / PROJECTILES[rocket].speed;
    const dx = from.x + tgt.p.vel.x * lead - pos.x;
    const how = stanceFor(a, tgt);
    const dy = from.y + heightOf(tgt) * (tgt.inMech ? BOTS.mechAimHeight : role.aimHeight) - (pos.y + eyeOf(a));
    const dz = from.z + tgt.p.vel.z * lead - pos.z;
    const dist = Math.hypot(dx, dz);
    // In the last part of a charged shot the aim stops tracking, so moving dodges it.
    if (b.charge < BOTS.chargeLock) {
      b.aimYaw = Math.atan2(-dx, -dz);
      b.aimPitch = Math.atan2(dy, dist);
    }
    const k = 1 - Math.exp(-6 * dt);
    b.errYaw += (b.errToYaw - b.errYaw) * k;
    b.errPitch += (b.errToPitch - b.errPitch) * k;
    const settleTo = b.visible ? role.aimErrMinDeg : role.aimErrStartDeg;
    b.errScale += (settleTo - b.errScale) * (1 - Math.exp(-dt / role.aimSettle));
    wantYaw = b.aimYaw + b.errYaw * DEG;
    wantPitch = b.aimPitch + b.errPitch * DEG;

    if (b.state === 'engage') {
      // Everyone but the rusher shoulders the weapon to shoot at range. In a
      // mech the same button launches the rocket salvo whenever it is ready.
      ads = a.inMech ? b.visible && b.token && dist > 12 : !how.rush && b.visible && dist > 6;
      // An empty mech of its own nearby is worth more than the firefight.
      const fetch = toMech >= 0 && toMech < 45;
      go = fetch ? goToMech(m, a, mine, dt) : engageMove(m, a, tgt, dist, dt);
      sprint = fetch || (how.rush && (!b.visible || dist > how.max));
      if (a.inMech && b.visible) {
        // A dash to the side now and then spoils the aim of whoever shoots back.
        b.hopIn -= dt;
        if (b.hopIn <= 0) {
          b.jumpFor = 0.1;
          b.hopIn = randRange(m.rng, 3, 6);
        }
      }
      if (how.rush && b.visible) {
        // Close the last stretch with a slide, and hop now and then to throw off aim.
        const speed = lenH(p.vel);
        if (b.slideIn <= 0 && dist > 7 && dist < 16 && p.grounded && speed >= TUNING.slide.minSpeed) {
          b.crouchFor = 0.7;
          b.slideIn = 3.5;
        }
        b.hopIn -= dt;
        if (b.hopIn <= 0 && p.grounded && dist < 12) {
          b.jumpFor = 0.1;
          b.hopIn = randRange(m.rng, 1.8, 3.5);
        }
      }

      const ready = b.visible && b.token && a.reload <= 0 && a.equip <= 0 && Math.hypot(dist, dy) <= how.fire;
      const off = Math.hypot(angDiff(wantYaw, p.yaw), wantPitch - p.pitch);
      if (!ready) {
        b.charge = Math.max(0, b.charge - dt * 3);
      } else if (b.pause > 0) {
        b.pause -= dt;
      } else if (role.chargeTime > 0) {
        if (off < 5 * DEG || b.charge >= BOTS.chargeLock) {
          if (b.charge === 0) m.events.push({ type: 'charge', actor: a.id, target: tgt.id, duration: role.chargeTime });
          b.charge += dt / role.chargeTime;
          if (b.charge >= 1) {
            fire = true;
            b.charge = 0;
            b.pause = randRange(m.rng, role.burstPause[0], role.burstPause[1]);
          }
        } else {
          b.charge = Math.max(0, b.charge - dt * 2);
        }
      } else {
        if (b.burst <= 0) b.burst = randRange(m.rng, role.burst[0], role.burst[1]);
        if (off < 3.5 * DEG) {
          fire = true;
          b.burst -= dt;
          if (b.burst <= 0) b.pause = randRange(m.rng, role.burstPause[0], role.burstPause[1]);
        }
      }
    }
  } else {
    go = follow(a);
    if (go) {
      wantYaw = Math.atan2(-go.x, -go.z);
      const left = Math.hypot(pos.x - b.goalX, pos.z - b.goalZ);
      sprint = left > 5;
    } else if (b.holdFor > 0) {
      // Holding a perch: watch the enemy's side, turning the view slowly across it.
      wantYaw = b.holdYaw + Math.sin(b.stateTime * 0.5) * 0.7;
    } else if (b.state === 'search') {
      // Arrived where the target was last seen: sweep the view around.
      wantYaw = p.yaw + b.strafe * 1.6 * dt;
    }
  }

  // Climbing a wall, dropping off an edge or leaping a gap: face the way, and
  // work the jump button.
  let jump = b.jumpFor > 0;
  const parkour = go !== null && b.hasGoal && !a.inMech && b.link !== Link.Walk;
  if (parkour) {
    wantYaw = Math.atan2(-go!.x, -go!.z);
    wantPitch = 0;
    const o = b.pathI * PATH_STRIDE;
    const left = Math.hypot(b.path[o] - pos.x, b.path[o + 2] - pos.z);
    const leg = Math.hypot(b.path[o] - b.path[o - PATH_STRIDE], b.path[o + 2] - b.path[o - PATH_STRIDE + 2]);
    // A climb starts at the foot of the wall, a leap just short of the edge.
    const takeoff = b.link === Link.Climb ? left < leg + 0.1 : left < leg - 0.2;
    if (b.link !== Link.Drop && (takeoff || !p.grounded)) jump = jumpButton(a, b.link, b.path[o], b.path[o + 1], b.path[o + 2]);
    sprint = false;
    fire = false;
  }

  const maxTurn = role.turnRateDeg * DEG * dt;
  cmd.yaw = p.yaw + clamp(angDiff(wantYaw, p.yaw), -maxTurn, maxTurn);
  cmd.pitch = p.pitch + clamp(wantPitch - p.pitch, -maxTurn, maxTurn);

  b.wantMove = go !== null;
  if (go) {
    let x = go.x;
    let z = go.z;
    // Keep a little room between teammates so they do not walk as one.
    for (const o of m.actors) {
      if (parkour || o === a || !o.alive || o.team !== a.team) continue;
      const ox = pos.x - o.p.pos.x;
      const oz = pos.z - o.p.pos.z;
      const d = Math.hypot(ox, oz);
      if (d > 1.6 || d < 1e-3) continue;
      const push = (1 - d / 1.6) * 0.9;
      x += (ox / d) * push;
      z += (oz / d) * push;
    }
    const l = Math.hypot(x, z) || 1;
    const f = forwardFromYaw(cmd.yaw);
    const r = rightFromYaw(cmd.yaw);
    // Up to a wall or off an edge slowly, so the body does not sail past where it is going.
    const pace = parkour && b.link !== Link.Leap ? 0.45 : 1;
    cmd.moveZ = ((x * f.x + z * f.z) / l) * pace;
    cmd.moveX = ((x * r.x + z * r.z) / l) * pace;
    cmd.sprint = sprint && cmd.moveZ > 0.7;
  }
  cmd.jump = jump;
  cmd.crouch = b.crouchFor > 0;
  cmd.ads = ads;
  if (!a.inMech) {
    // Buttons are pressed for one tick at a time, so each press counts once.
    const press = (m.tick + a.id * 7) % 30 === 0;
    cmd.call = press && a.meter >= 1 && mine.state === 'none';
    cmd.use = press && toMech >= 0 && toMech < COMBAT.mech.embark.range - 0.5;
    // The launcher comes out against a mech and goes away again afterwards.
    const fighting = tgt !== null && tgt.inMech && (b.state === 'engage' || b.state === 'notice');
    const launcher = a.loadout.indexOf(BOTS.antiArmor);
    cmd.weapon = fighting && launcher >= 0 ? launcher : 0;
  }
  // Semi-automatic weapons need the trigger released between shots.
  cmd.fire = fire && (WEAPONS[a.loadout[a.weapon]].fireMode === 'auto' || !a.triggerHeld);
  return cmd;
}
