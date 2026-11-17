import type { BotStateName } from '../ai/bot';
import type { Vec3 } from '../math/vec3';
import { MECH_ABILITIES, type Actor, type MatchEvent, type MatchState, type ShotTrace } from '../sim/combat';
import { frameOf, type Mech, type MechStateName } from '../sim/mech';
import type { PlayerState } from '../sim/movement';
import { Msg, NAMES, Reader, Writer, nameId } from './protocol';

/**
 * Snapshots: what the server sends each client many times a second.
 *
 *   header      tick, the last command used, the seat's counters, the score
 *   own state   everything the client predicts for its own pilot, at full
 *               precision, so replaying from it lands on the same numbers
 *   world       every pilot and mech, rounded to a few bytes each; the client
 *               draws these between two snapshots
 *   events      what happened since the last snapshot, each with its tick
 */

// ---------------------------------------------------------------- rounding

const TAU = Math.PI * 2;
const clampI16 = (v: number): number => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const packLen = (v: number): number => clampI16(Math.round(v * 100));
const packYaw = (yaw: number): number => Math.round((((yaw % TAU) + TAU) % TAU) * (65536 / TAU)) & 0xffff;
const unpackYaw = (v: number): number => v * (TAU / 65536);
const packPitch = (p: number): number => clampI16(Math.round(p * (32767 / (Math.PI / 2))));
const unpackPitch = (v: number): number => v * (Math.PI / 2 / 32767);
const packUnit = (v: number): number => Math.max(-127, Math.min(127, Math.round(v * 127)));

const MECH_STATES: readonly MechStateName[] = ['none', 'dropping', 'idle', 'boot', 'piloted'];
const BOT_STATES: readonly BotStateName[] = ['patrol', 'notice', 'engage', 'search'];

// ---------------------------------------------------------------- world records

/** Bits of `ActorRec.flags`. */
export const ActorFlag = {
  Alive: 1,
  InMech: 2,
  Grounded: 4,
  Crouched: 8,
  Sliding: 16,
  Wallrun: 32,
  /** The wall is on the pilot's right. */
  WallRight: 64,
  Thrusting: 128,
  Mantle: 256,
  Reloading: 512,
  /** Two bits: a bot's state, as an index into patrol, notice, engage, search. */
  BotStateShift: 10,
} as const;

/** A pilot as others see it. */
export interface ActorRec {
  flags: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  health: number;
  /** Index into `NAMES` of the weapon in hand. */
  weapon: number;
  ads: number;
  /** A marksman bot lining up a shot, 0..1. */
  charge: number;
}

/** Bits of `MechRec.flags`. */
export const MechFlag = { Grounded: 1, Dashing: 2, Shield: 4, Cloaked: 8 } as const;

export interface MechRec {
  /** Index into none, dropping, idle, boot, piloted. The rest is unset for `none`. */
  state: number;
  /** Index into `FRAME_LIST`. */
  frame: number;
  flags: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  health: number;
  stateTime: number;
  dashX: number;
  dashZ: number;
  /** Ground covered since the last footfall, as a fraction of a stride. */
  stride: number;
  landSpeed: number;
  /** What is left of the shield, 0..1 of a full one. */
  shield: number;
}

export interface Snapshot {
  /** Server tick this state belongs to. */
  tick: number;
  /** Sequence number of the last command the server used for this player. */
  ack: number;
  /**
   * Bumped whenever the server put this player's pilot somewhere on its own (a
   * respawn, a seat in a mech, a new match). Commands made before the bump are
   * dropped by the server and must not be replayed by the client.
   */
  epoch: number;
  /** Bumped on every respawn: the view turns to the spawn point's direction. */
  spawns: number;
  score: [number, number];
  over: boolean;
  winner: number;
  /** Commands of this player waiting on the server (for the debug overlay). */
  queued: number;
  /** The own-state block, still packed: `readOwn` unpacks it onto an actor. */
  own: Uint8Array;
  actors: ActorRec[];
  mechs: MechRec[];
  events: { tick: number; e: MatchEvent }[];
  /** Size on the wire. */
  bytes: number;
}

function writeActor(w: Writer, a: Actor): void {
  const p = a.p;
  const b = a.brain;
  w.u16(
    (a.alive ? ActorFlag.Alive : 0) |
      (a.inMech ? ActorFlag.InMech : 0) |
      (p.grounded ? ActorFlag.Grounded : 0) |
      (p.crouched ? ActorFlag.Crouched : 0) |
      (p.sliding ? ActorFlag.Sliding : 0) |
      (p.wallrun.active ? ActorFlag.Wallrun : 0) |
      (p.wallrun.side > 0 ? ActorFlag.WallRight : 0) |
      (p.thrusting ? ActorFlag.Thrusting : 0) |
      (p.mantle.active ? ActorFlag.Mantle : 0) |
      (a.reload > 0 ? ActorFlag.Reloading : 0) |
      ((b ? BOT_STATES.indexOf(b.state) : 0) << ActorFlag.BotStateShift),
  );
  w.i16(packLen(p.pos.x));
  w.i16(packLen(p.pos.y));
  w.i16(packLen(p.pos.z));
  w.i16(packLen(p.vel.x));
  w.i16(packLen(p.vel.y));
  w.i16(packLen(p.vel.z));
  w.u16(packYaw(p.yaw));
  w.i16(packPitch(p.pitch));
  w.u8(Math.max(0, Math.min(255, Math.ceil(a.health))));
  w.u8(nameId(a.loadout[a.weapon]));
  w.u8(Math.round(a.ads * 255));
  w.u8(b ? Math.round(Math.max(0, Math.min(1, b.charge)) * 255) : 0);
}

function readActor(r: Reader): ActorRec {
  return {
    flags: r.u16(),
    x: r.i16() / 100,
    y: r.i16() / 100,
    z: r.i16() / 100,
    vx: r.i16() / 100,
    vy: r.i16() / 100,
    vz: r.i16() / 100,
    yaw: unpackYaw(r.u16()),
    pitch: unpackPitch(r.i16()),
    health: r.u8(),
    weapon: r.u8(),
    ads: r.u8() / 255,
    charge: r.u8() / 255,
  };
}

function writeMech(w: Writer, k: Mech): void {
  const state = MECH_STATES.indexOf(k.state);
  w.u8(state);
  if (state === 0) return;
  const F = frameOf(k);
  w.u8(k.frame);
  w.u8((k.grounded ? MechFlag.Grounded : 0) | (k.dashTime > 0 ? MechFlag.Dashing : 0) | (k.shieldUp ? MechFlag.Shield : 0) | (k.cloak > 0 ? MechFlag.Cloaked : 0));
  w.i16(packLen(k.pos.x));
  w.i16(packLen(k.pos.y));
  w.i16(packLen(k.pos.z));
  w.i16(packLen(k.vel.x));
  w.i16(packLen(k.vel.y));
  w.i16(packLen(k.vel.z));
  w.u16(packYaw(k.yaw));
  w.i16(packPitch(k.pitch));
  w.u16(Math.max(0, Math.min(65535, Math.ceil(k.health))));
  w.u16(Math.min(65535, Math.round(k.stateTime * 1000)));
  w.i8(packUnit(k.dashX));
  w.i8(packUnit(k.dashZ));
  w.u8(Math.max(0, Math.min(255, Math.round((k.stride / F.move.strideLength) * 255))));
  w.u8(Math.min(255, Math.round(k.landSpeed * 4)));
  w.u8(F.ability.kind === 'shield' ? Math.round((k.shield / F.ability.health) * 255) : 0);
}

function readMech(r: Reader): MechRec {
  const state = r.u8();
  if (state === 0) {
    return { state, frame: 0, flags: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, health: 0, stateTime: 0, dashX: 0, dashZ: 0, stride: 0, landSpeed: 0, shield: 0 };
  }
  return {
    state,
    frame: r.u8(),
    flags: r.u8(),
    x: r.i16() / 100,
    y: r.i16() / 100,
    z: r.i16() / 100,
    vx: r.i16() / 100,
    vy: r.i16() / 100,
    vz: r.i16() / 100,
    yaw: unpackYaw(r.u16()),
    pitch: unpackPitch(r.i16()),
    health: r.u16(),
    stateTime: r.u16() / 1000,
    dashX: r.i8() / 127,
    dashZ: r.i8() / 127,
    stride: r.u8() / 255,
    landSpeed: r.u8() / 4,
    shield: r.u8() / 255,
  };
}

/** Every pilot and mech, the same bytes for every client. */
export function writeWorld(w: Writer, m: MatchState): void {
  w.u8(m.actors.length);
  for (const a of m.actors) writeActor(w, a);
  for (const k of m.mechs) writeMech(w, k);
}

export const mechStateName = (i: number): MechStateName => MECH_STATES[i] ?? 'none';
export const botStateName = (flags: number): BotStateName => BOT_STATES[(flags >> ActorFlag.BotStateShift) & 3];

// ---------------------------------------------------------------- own state

/**
 * Writes and reads through the same calls: every method takes the current value
 * and returns the value to keep, which is the same one when writing and the
 * one from the wire when reading. One function then describes the layout for
 * both directions and they cannot drift apart.
 */
interface Io {
  readonly reading: boolean;
  u8(v: number): number;
  i8(v: number): number;
  u16(v: number): number;
  i32(v: number): number;
  u32(v: number): number;
  f32(v: number): number;
  f64(v: number): number;
}

const writeIo = (w: Writer): Io => ({
  reading: false,
  u8: (v) => (w.u8(v), v),
  i8: (v) => (w.i8(v), v),
  u16: (v) => (w.u16(v), v),
  i32: (v) => (w.i32(v), v),
  u32: (v) => (w.u32(v), v),
  f32: (v) => (w.f32(v), v),
  f64: (v) => (w.f64(v), v),
});

const readIo = (r: Reader): Io => ({
  reading: true,
  u8: () => r.u8(),
  i8: () => r.i8(),
  u16: () => r.u16(),
  i32: () => r.i32(),
  u32: () => r.u32(),
  f32: () => r.f32(),
  f64: () => r.f64(),
});

function syncVec(io: Io, v: Vec3): void {
  v.x = io.f64(v.x);
  v.y = io.f64(v.y);
  v.z = io.f64(v.z);
}

function syncNames(io: Io, names: string[], ammo: number[]): void {
  const n = io.u8(names.length);
  names.length = ammo.length = n;
  for (let i = 0; i < n; i++) {
    names[i] = NAMES[io.u8(nameId(names[i] ?? ''))] ?? '';
    ammo[i] = io.u16(ammo[i] ?? 0);
  }
}

function syncPlayer(io: Io, p: PlayerState): void {
  const wr = p.wallrun;
  const mt = p.mantle;
  const bits = io.u16(
    (p.grounded ? 1 : 0) |
      (p.canCoyote ? 2 : 0) |
      (p.crouched ? 4 : 0) |
      (p.sliding ? 8 : 0) |
      (p.slideReady ? 16 : 0) |
      (p.jumpHeld ? 32 : 0) |
      (p.thrusting ? 64 : 0) |
      (wr.active ? 128 : 0) |
      (mt.active ? 256 : 0) |
      (wr.side > 0 ? 512 : 0),
  );
  p.grounded = (bits & 1) !== 0;
  p.canCoyote = (bits & 2) !== 0;
  p.crouched = (bits & 4) !== 0;
  p.sliding = (bits & 8) !== 0;
  p.slideReady = (bits & 16) !== 0;
  p.jumpHeld = (bits & 32) !== 0;
  p.thrusting = (bits & 64) !== 0;
  wr.active = (bits & 128) !== 0;
  mt.active = (bits & 256) !== 0;
  wr.side = bits & 512 ? 1 : -1;

  syncVec(io, p.pos);
  syncVec(io, p.vel);
  p.yaw = io.f64(p.yaw);
  p.pitch = io.f64(p.pitch);
  syncVec(io, p.groundNormal);
  p.timeSinceGround = io.f64(p.timeSinceGround);
  p.fallSpeed = io.f64(p.fallSpeed);
  p.landSpeed = io.f64(p.landSpeed);
  p.slideFuel = io.f64(p.slideFuel);
  p.slideTime = io.f64(p.slideTime);
  p.jumpHoldTime = io.f64(p.jumpHoldTime);
  p.jumpBuffer = io.f64(p.jumpBuffer);
  p.airJumpsUsed = io.u8(p.airJumpsUsed);
  p.fuel = io.f64(p.fuel);
  p.fuelDelay = io.f64(p.fuelDelay);
  syncVec(io, wr.normal);
  wr.time = io.f64(wr.time);
  wr.collider = io.f64(wr.collider);
  wr.awayTime = io.f64(wr.awayTime);
  p.lastWall = io.f64(p.lastWall);
  p.wallChainY = io.f64(p.wallChainY);
  p.wallCooldown = io.f64(p.wallCooldown);
  // A climb in progress is the only time these matter.
  if (mt.active) {
    syncVec(io, mt.from);
    syncVec(io, mt.to);
    mt.t = io.f64(mt.t);
    mt.dur = io.f64(mt.dur);
    mt.exitSpeed = io.f64(mt.exitSpeed);
  }
  p.events = io.u8(p.events);
}

function syncMech(io: Io, k: Mech): void {
  const state = io.u8(MECH_STATES.indexOf(k.state));
  k.state = MECH_STATES[state] ?? 'none';
  if (state === 0) return;
  k.frame = io.u8(k.frame);
  const bits = io.u8((k.grounded ? 1 : 0) | (k.jumpHeld ? 2 : 0) | (k.shieldUp ? 4 : 0));
  k.grounded = (bits & 1) !== 0;
  k.jumpHeld = (bits & 2) !== 0;
  k.shieldUp = (bits & 4) !== 0;
  k.stateTime = io.f64(k.stateTime);
  syncVec(io, k.pos);
  syncVec(io, k.vel);
  k.yaw = io.f64(k.yaw);
  k.pitch = io.f64(k.pitch);
  syncVec(io, k.groundNormal);
  k.fallSpeed = io.f64(k.fallSpeed);
  k.landSpeed = io.f64(k.landSpeed);
  k.health = io.f64(k.health);
  const n = io.u8(k.ammo.length);
  k.ammo.length = n;
  for (let i = 0; i < n; i++) k.ammo[i] = io.u16(k.ammo[i] ?? 0);
  k.charges = io.f64(k.charges);
  k.dashTime = io.f64(k.dashTime);
  k.dashX = io.f64(k.dashX);
  k.dashZ = io.f64(k.dashZ);
  k.rammed = io.i32(k.rammed);
  k.abilityCooldown = io.f64(k.abilityCooldown);
  k.salvoLeft = io.u8(k.salvoLeft);
  k.salvoNext = io.f64(k.salvoNext);
  k.shield = io.f64(k.shield);
  k.shieldRest = io.f64(k.shieldRest);
  k.cloak = io.f64(k.cloak);
  k.stride = io.f64(k.stride);
}

/**
 * A player's own pilot and mech in full: what `stepOwn` reads and changes, plus
 * what only this player is shown (health, the meter, the tally).
 */
function syncOwn(io: Io, a: Actor, k: Mech): void {
  const bits = io.u8((a.alive ? 1 : 0) | (a.inMech ? 2 : 0) | (a.triggerHeld ? 4 : 0) | (a.kit ? 8 : 0));
  a.alive = (bits & 1) !== 0;
  a.inMech = (bits & 2) !== 0;
  a.triggerHeld = (bits & 4) !== 0;
  const hasKit = (bits & 8) !== 0;

  // The mech first: in a cockpit the pilot's rounds are the mech's own.
  syncMech(io, k);
  if (io.reading) {
    if (a.inMech) a.ammo = k.ammo;
    else if (a.ammo === k.ammo) a.ammo = [];
    if (!hasKit) a.kit = null;
    else a.kit ??= { loadout: [], ammo: [], weapon: 0 };
  }

  a.health = io.f32(a.health);
  a.respawnIn = io.f32(a.respawnIn);
  a.protect = io.f32(a.protect);
  a.sinceDamage = io.f32(a.sinceDamage);
  a.meter = io.f32(a.meter);
  a.kills = io.u16(a.kills);
  a.deaths = io.u16(a.deaths);
  a.mechKills = io.u16(a.mechKills);

  a.weapon = io.u8(a.weapon);
  syncNames(io, a.loadout, a.ammo);
  if (a.kit) {
    a.kit.weapon = io.u8(a.kit.weapon);
    syncNames(io, a.kit.loadout, a.kit.ammo);
  }
  a.cooldown = io.f64(a.cooldown);
  a.reload = io.f64(a.reload);
  a.equip = io.f64(a.equip);
  a.bloom = io.f64(a.bloom);
  a.punchPitch = io.f64(a.punchPitch);
  a.punchYaw = io.f64(a.punchYaw);
  a.ads = io.f64(a.ads);
  a.fireBuffer = io.f64(a.fireBuffer);
  const rng = io.u32(a.rng ? a.rng.s : 0);
  if (a.rng) a.rng.s = rng;
  else if (io.reading) a.rng = { s: rng };

  syncPlayer(io, a.p);
}

export const writeOwn = (w: Writer, a: Actor, k: Mech): void => syncOwn(writeIo(w), a, k);
export const readOwn = (data: Uint8Array, a: Actor, k: Mech): void => syncOwn(readIo(new Reader(data)), a, k);

// ---------------------------------------------------------------- events

const Ev = {
  shot: 1,
  damage: 2,
  kill: 3,
  spawn: 4,
  notice: 5,
  charge: 6,
  meterReady: 7,
  mechCall: 8,
  callDenied: 9,
  mechLand: 10,
  embark: 11,
  mechOnline: 12,
  disembark: 13,
  mechStep: 14,
  mechAbility: 15,
  ram: 16,
  mechDamage: 17,
  mechDestroyed: 18,
  launch: 19,
  explode: 20,
  matchEnd: 21,
  shieldHit: 22,
} as const;

/** Everyone gets this event. */
export const TO_ALL = -1;
/** Nobody does: every client works it out for itself. */
export const TO_NONE = -2;

/**
 * Who an event is sent to: `TO_ALL`, `TO_NONE`, or the one actor it concerns.
 * A reload, an empty click and a weapon switch are only ever shown to the
 * player who did them, and that player predicts them, so they never travel.
 */
export function eventAudience(e: MatchEvent): number {
  switch (e.type) {
    case 'reload':
    case 'reloaded':
    case 'dry':
    case 'equip':
      return TO_NONE;
    case 'meterReady':
    case 'callDenied':
    case 'mechOnline':
      return e.actor;
    default:
      return TO_ALL;
  }
}

function writeV(w: Writer, v: Vec3): void {
  w.f32(v.x);
  w.f32(v.y);
  w.f32(v.z);
}

const readV = (r: Reader): Vec3 => ({ x: r.f32(), y: r.f32(), z: r.f32() });

function writeNormal(w: Writer, n: Vec3): void {
  w.i8(packUnit(n.x));
  w.i8(packUnit(n.y));
  w.i8(packUnit(n.z));
}

function readNormal(r: Reader): Vec3 {
  const x = r.i8();
  const y = r.i8();
  const z = r.i8();
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

/** Append one event. Only call for events whose audience is not `TO_NONE`. */
export function writeEvent(w: Writer, e: MatchEvent): void {
  switch (e.type) {
    case 'shot':
      w.u8(Ev.shot);
      w.u8(e.actor);
      w.u8(nameId(e.weapon));
      writeV(w, e.origin);
      w.u8(e.traces.length);
      for (const t of e.traces) {
        writeV(w, t.end);
        w.u8((t.normal ? 1 : 0) | (t.head ? 2 : 0) | (t.shield ? 4 : 0));
        w.i8(t.victim);
        w.i8(t.mech);
        if (t.normal) writeNormal(w, t.normal);
      }
      break;
    case 'damage':
      w.u8(Ev.damage);
      w.u8(e.victim);
      w.u8(e.attacker);
      w.f32(e.amount);
      w.u8((e.head ? 1 : 0) | (e.killed ? 2 : 0));
      writeV(w, e.pos);
      break;
    case 'kill':
      w.u8(Ev.kill);
      w.u8(e.victim);
      w.i8(e.attacker);
      w.u8(nameId(e.weapon));
      w.u8(e.head ? 1 : 0);
      break;
    case 'spawn':
      w.u8(Ev.spawn);
      w.u8(e.actor);
      break;
    case 'notice':
      w.u8(Ev.notice);
      w.u8(e.actor);
      w.u8(e.target);
      break;
    case 'charge':
      w.u8(Ev.charge);
      w.u8(e.actor);
      w.u8(e.target);
      w.f32(e.duration);
      break;
    case 'meterReady':
      w.u8(Ev.meterReady);
      w.u8(e.actor);
      break;
    case 'mechCall':
      w.u8(Ev.mechCall);
      w.u8(e.actor);
      w.u8(e.frame);
      writeV(w, e.pos);
      w.f32(e.duration);
      break;
    case 'callDenied':
      w.u8(Ev.callDenied);
      w.u8(e.actor);
      w.u8(e.reason === 'meter' ? 0 : 1);
      break;
    case 'mechLand':
      w.u8(Ev.mechLand);
      w.u8(e.mech);
      writeV(w, e.pos);
      break;
    case 'embark':
      w.u8(Ev.embark);
      w.u8(e.actor);
      w.f32(e.duration);
      break;
    case 'mechOnline':
      w.u8(Ev.mechOnline);
      w.u8(e.actor);
      break;
    case 'disembark':
      w.u8(Ev.disembark);
      w.u8(e.actor);
      w.u8(e.eject ? 1 : 0);
      break;
    case 'mechStep':
      w.u8(Ev.mechStep);
      w.u8(e.mech);
      w.u8(e.heavy ? 1 : 0);
      break;
    case 'mechAbility':
      w.u8(Ev.mechAbility);
      w.u8(e.mech);
      w.u8(MECH_ABILITIES.indexOf(e.what));
      break;
    case 'shieldHit':
      w.u8(Ev.shieldHit);
      w.u8(e.mech);
      w.u8(e.attacker);
      w.f32(e.amount);
      w.u8(e.broken ? 1 : 0);
      writeV(w, e.pos);
      break;
    case 'ram':
      w.u8(Ev.ram);
      w.u8(e.mech);
      w.i8(e.victim);
      w.i8(e.other);
      break;
    case 'mechDamage':
      w.u8(Ev.mechDamage);
      w.u8(e.mech);
      w.u8(e.attacker);
      w.f32(e.amount);
      w.u8((e.crit ? 1 : 0) | (e.destroyed ? 2 : 0));
      writeV(w, e.pos);
      break;
    case 'mechDestroyed':
      w.u8(Ev.mechDestroyed);
      w.u8(e.mech);
      w.i8(e.attacker);
      w.u8(nameId(e.weapon));
      writeV(w, e.pos);
      break;
    case 'launch':
      w.u8(Ev.launch);
      w.i32(e.id);
      w.u8(e.actor);
      w.u8(nameId(e.kind));
      writeV(w, e.pos);
      writeV(w, e.dir);
      break;
    case 'explode':
      w.u8(Ev.explode);
      w.i32(e.id);
      w.u8(e.actor);
      w.u8(nameId(e.kind));
      writeV(w, e.pos);
      w.u8(e.normal ? 1 : 0);
      if (e.normal) writeNormal(w, e.normal);
      break;
    case 'matchEnd':
      w.u8(Ev.matchEnd);
      w.i8(e.winner);
      break;
    default:
      throw new Error(`event "${e.type}" has no wire format`);
  }
}

function readEvent(r: Reader): MatchEvent {
  const type = r.u8();
  switch (type) {
    case Ev.shot: {
      const actor = r.u8();
      const weapon = NAMES[r.u8()] ?? '';
      const origin = readV(r);
      const n = r.u8();
      const traces: ShotTrace[] = [];
      for (let i = 0; i < n; i++) {
        const end = readV(r);
        const bits = r.u8();
        const victim = r.i8();
        const mech = r.i8();
        traces.push({ end, victim, mech, head: (bits & 2) !== 0, shield: (bits & 4) !== 0, normal: bits & 1 ? readNormal(r) : null });
      }
      return { type: 'shot', actor, weapon, origin, traces };
    }
    case Ev.damage: {
      const victim = r.u8();
      const attacker = r.u8();
      const amount = r.f32();
      const bits = r.u8();
      return { type: 'damage', victim, attacker, amount, head: (bits & 1) !== 0, killed: (bits & 2) !== 0, pos: readV(r) };
    }
    case Ev.kill:
      return { type: 'kill', victim: r.u8(), attacker: r.i8(), weapon: NAMES[r.u8()] ?? '', head: r.u8() !== 0 };
    case Ev.spawn:
      return { type: 'spawn', actor: r.u8() };
    case Ev.notice:
      return { type: 'notice', actor: r.u8(), target: r.u8() };
    case Ev.charge:
      return { type: 'charge', actor: r.u8(), target: r.u8(), duration: r.f32() };
    case Ev.meterReady:
      return { type: 'meterReady', actor: r.u8() };
    case Ev.mechCall:
      return { type: 'mechCall', actor: r.u8(), frame: r.u8(), pos: readV(r), duration: r.f32() };
    case Ev.callDenied:
      return { type: 'callDenied', actor: r.u8(), reason: r.u8() === 0 ? 'meter' : 'zone' };
    case Ev.mechLand:
      return { type: 'mechLand', mech: r.u8(), pos: readV(r) };
    case Ev.embark:
      return { type: 'embark', actor: r.u8(), duration: r.f32() };
    case Ev.mechOnline:
      return { type: 'mechOnline', actor: r.u8() };
    case Ev.disembark:
      return { type: 'disembark', actor: r.u8(), eject: r.u8() !== 0 };
    case Ev.mechStep:
      return { type: 'mechStep', mech: r.u8(), heavy: r.u8() !== 0 };
    case Ev.mechAbility: {
      const mech = r.u8();
      const what = MECH_ABILITIES[r.u8()];
      if (!what) throw new Error('unknown mech ability');
      return { type: 'mechAbility', mech, what };
    }
    case Ev.shieldHit:
      return { type: 'shieldHit', mech: r.u8(), attacker: r.u8(), amount: r.f32(), broken: r.u8() !== 0, pos: readV(r) };
    case Ev.ram:
      return { type: 'ram', mech: r.u8(), victim: r.i8(), other: r.i8() };
    case Ev.mechDamage: {
      const mech = r.u8();
      const attacker = r.u8();
      const amount = r.f32();
      const bits = r.u8();
      return { type: 'mechDamage', mech, attacker, amount, crit: (bits & 1) !== 0, destroyed: (bits & 2) !== 0, pos: readV(r) };
    }
    case Ev.mechDestroyed:
      return { type: 'mechDestroyed', mech: r.u8(), attacker: r.i8(), weapon: NAMES[r.u8()] ?? '', pos: readV(r) };
    case Ev.launch:
      return { type: 'launch', id: r.i32(), actor: r.u8(), kind: NAMES[r.u8()] ?? '', pos: readV(r), dir: readV(r) };
    case Ev.explode: {
      const id = r.i32();
      const actor = r.u8();
      const kind = NAMES[r.u8()] ?? '';
      const pos = readV(r);
      return { type: 'explode', id, actor, kind, pos, normal: r.u8() ? readNormal(r) : null };
    }
    case Ev.matchEnd:
      return { type: 'matchEnd', winner: r.i8() };
    default:
      throw new Error(`unknown event type ${type}`);
  }
}

// ---------------------------------------------------------------- the message

export interface SnapshotHeader {
  tick: number;
  ack: number;
  epoch: number;
  spawns: number;
  queued: number;
}

/**
 * Put one client's snapshot together. `world` is the block `writeWorld` made
 * (the same for everyone); `events` are the ones meant for this client, with
 * the server tick each happened in.
 */
export function encodeSnapshot(
  w: Writer,
  head: SnapshotHeader,
  m: MatchState,
  me: Actor,
  world: Uint8Array,
  events: readonly { tick: number; e: MatchEvent }[],
): ArrayBuffer {
  w.reset();
  w.u8(Msg.Snapshot);
  w.u32(head.tick);
  w.u32(head.ack);
  w.u8(head.epoch);
  w.u8(head.spawns);
  w.u8(Math.min(255, head.queued));
  w.u16(Math.min(65535, m.score[0]));
  w.u16(Math.min(65535, m.score[1]));
  w.i8(m.over ? m.winner : -1);

  const sizeAt = w.pos;
  w.u16(0);
  writeOwn(w, me, m.mechs[me.id]);
  w.patchU16(sizeAt, w.pos - sizeAt - 2);

  w.bytes(world);

  w.u16(events.length);
  for (const { tick, e } of events) {
    // How many ticks before this snapshot it happened.
    w.u8(Math.max(0, Math.min(255, head.tick - tick)));
    writeEvent(w, e);
  }
  return w.finish();
}

export function decodeSnapshot(data: ArrayBuffer): Snapshot {
  const r = new Reader(data);
  if (r.u8() !== Msg.Snapshot) throw new Error('not a snapshot');
  const tick = r.u32();
  const ack = r.u32();
  const epoch = r.u8();
  const spawns = r.u8();
  const queued = r.u8();
  const score: [number, number] = [r.u16(), r.u16()];
  const winner = r.i8();

  const ownSize = r.u16();
  const own = new Uint8Array(data, r.pos, ownSize);
  r.pos += ownSize;

  const n = r.u8();
  const actors: ActorRec[] = [];
  const mechs: MechRec[] = [];
  for (let i = 0; i < n; i++) actors.push(readActor(r));
  for (let i = 0; i < n; i++) mechs.push(readMech(r));

  const count = r.u16();
  const events: Snapshot['events'] = [];
  for (let i = 0; i < count; i++) {
    const at = tick - r.u8();
    events.push({ tick: at, e: readEvent(r) });
  }
  return { tick, ack, epoch, spawns, score, over: winner >= 0, winner, queued, own, actors, mechs, events, bytes: data.byteLength };
}
