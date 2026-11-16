import { createBrain } from '../ai/bot';
import type { InputCmd } from '../input';
import type { MapData } from '../map/types';
import { v3, type Vec3 } from '../math/vec3';
import type { Actor, MatchEvent, MatchState } from '../sim/combat';
import { NET } from '../sim/lagcomp';
import { createMatch } from '../sim/match';
import { MECH, type Mech } from '../sim/mech';
import { stepOwn } from '../sim/predict';
import { TICK_DT, TICK_RATE } from '../sim/tuning';
import type { CollisionWorld } from '../sim/world';
import { NAMES, Writer, encodeInput, quantizeInput, type MatchInfo } from './protocol';
import { ActorFlag, MechFlag, botStateName, decodeSnapshot, mechStateName, readOwn, type ActorRec, type MechRec, type Snapshot } from './snapshot';

/**
 * The client's half of the netcode, with no browser in it, so the same code
 * runs in the game and in headless tests.
 *
 * It keeps a copy of the match (`match`) for the game to draw:
 *
 * - **The player's own pilot is predicted.** Every command is sent to the
 *   server and run through `stepOwn` at once. Each snapshot carries the server's
 *   state for this pilot and the last command it used: the pilot is set back to
 *   that state and the commands after it are replayed. If that lands somewhere
 *   other than where the pilot was drawn, the difference is kept as an offset
 *   on the drawn position and eased away, while the simulated position is
 *   right immediately.
 * - **Everyone else is drawn in the past**, between the two snapshots around
 *   "now minus the delay". The delay starts a little over one snapshot interval
 *   and grows with the jitter that is measured.
 * - **Events wait for their moment**: each is handed out when the picture has
 *   reached the tick it happened in.
 */

const TICK_MS = 1000 / TICK_RATE;
/** A step this long between two snapshots is a respawn or a seat change, not movement. */
const TELEPORT = 4;
/** Unanswered commands kept; beyond two seconds the server is not listening. */
const MAX_PENDING = 120;
/** Corrections smaller than this are rounding, not disagreement. */
const NOTICEABLE = 0.001;

/** Events that are only sound and sparks: not worth playing late. */
const COSMETIC = new Set<MatchEvent['type']>(['shot', 'notice', 'charge', 'mechStep', 'mechDash', 'ram', 'launch', 'explode']);

export interface NetStats {
  /** Round trip in milliseconds, set by whoever owns the connection. */
  ping: number;
  /** How unevenly snapshots arrive, milliseconds (mean deviation). */
  jitter: number;
  /** How far in the past everyone else is drawn, milliseconds. */
  delay: number;
  snapshots: number;
  snapshotBytes: number;
  snapshotBytesMax: number;
  /** Commands sent and not yet answered. */
  pending: number;
  /** This player's commands waiting on the server. */
  queued: number;
  /** Times a snapshot moved the own pilot by more than a millimeter, and by how much the last time (meters). */
  corrections: number;
  lastCorrection: number;
  /** The largest eased correction of any size. Exactly 0 while prediction and server agree. */
  maxCorrection: number;
  /** Corrections too large to ease: the drawn position jumped. */
  snaps: number;
  /** Frames drawn past the newest snapshot. */
  extrapolated: number;
  /** Cosmetic events skipped for being stale. */
  staleEvents: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

export class NetClient {
  /** The match as this client knows it. Rebuilt in place, so references stay valid. */
  readonly match: MatchState;
  /** Actor id of the player's own pilot. */
  me = 0;
  /** True once a snapshot has arrived and there is something to draw. */
  ready = false;
  readonly stats: NetStats = {
    ping: 0,
    jitter: 0,
    delay: NET.interp.baseTicks * TICK_MS,
    snapshots: 0,
    snapshotBytes: 0,
    snapshotBytesMax: 0,
    pending: 0,
    queued: 0,
    corrections: 0,
    lastCorrection: 0,
    maxCorrection: 0,
    snaps: 0,
    extrapolated: 0,
    staleEvents: 0,
  };

  private readonly writer = new Writer(64);
  private seq = 0;
  private epoch = -1;
  private spawns = -1;
  private viewReset = false;
  private readonly pending: { seq: number; cmd: InputCmd }[] = [];
  private readonly snaps: Snapshot[] = [];
  private readonly events: { tick: number; e: MatchEvent }[] = [];

  /** Server tick minus local time in ticks, smoothed. */
  private offset = 0;
  private hasClock = false;
  private jitter = 0;
  private delay = NET.interp.baseTicks;
  /** The server tick being drawn. */
  private render = 0;
  private resync = false;
  /** What is sent with commands: the tick the player was looking at. */
  private viewTick = -1;
  /** The fewest commands the server had waiting over the snapshots counted so far. */
  private queuedMin = Infinity;
  private queuedSeen = 0;

  /**
   * How fast this player's command clock should run, 1 or a little under.
   * After a hitch the commands arrive in a burst and the server is left with
   * a few it has no tick for. Making the next ones slightly slower lets it
   * work through them; otherwise it would have to skip one, and a skipped
   * command is a correction. Multiply the frame time by this before turning
   * it into commands.
   */
  timeScale = 1;

  /** The own pilot one tick ago, for drawing between ticks. */
  private readonly prev = v3();
  /** Drawn position minus simulated position: what is left of past corrections. */
  private readonly error = v3();

  constructor(
    private readonly world: CollisionWorld,
    map: MapData,
    private readonly send: (data: ArrayBuffer) => void,
  ) {
    this.match = createMatch(map, world, { seed: 0, humans: 0 });
    this.match.predict = true;
  }

  get own(): Actor {
    return this.match.actors[this.me];
  }

  /** Server tick currently drawn (fractional). */
  get renderTick(): number {
    return this.render;
  }

  /** Begin (or begin again, after a new match): forget everything about the last one. */
  start(you: number, info: MatchInfo): void {
    this.me = you;
    this.ready = false;
    this.seq = 0;
    this.epoch = -1;
    this.spawns = -1;
    this.pending.length = 0;
    this.snaps.length = 0;
    this.events.length = 0;
    this.hasClock = false;
    this.viewTick = -1;
    this.queuedMin = Infinity;
    this.queuedSeen = 0;
    this.timeScale = 1;
    this.error.x = this.error.y = this.error.z = 0;
    const m = this.match;
    m.over = false;
    m.winner = -1;
    m.score[0] = m.score[1] = 0;
    for (const k of m.mechs) k.state = 'none';
    this.setRoster(info);
  }

  /** Who sits where: names, and which pilots are bots. */
  setRoster(info: MatchInfo): void {
    const m = this.match;
    m.scoreLimit = info.scoreLimit;
    info.seats.forEach((seat, i) => {
      const a = m.actors[i];
      if (!a) return;
      a.name = seat.name;
      if (!seat.bot) a.brain = null;
      else if (!a.brain || a.brain.role !== seat.bot) a.brain = createBrain(seat.bot, i);
    });
  }

  /** True once after each respawn: the view should turn to where the pilot now faces. */
  takeViewReset(): boolean {
    const reset = this.viewReset;
    this.viewReset = false;
    return reset;
  }

  // ---------------------------------------------------------------- snapshots

  /** A snapshot arrived at local time `now` (milliseconds). */
  onSnapshot(data: ArrayBuffer, now: number): void {
    const snap = decodeSnapshot(data);
    const last = this.snaps[this.snaps.length - 1];
    if (last && snap.tick <= last.tick) return;

    const st = this.stats;
    st.snapshots++;
    st.snapshotBytes += (snap.bytes - st.snapshotBytes) / Math.min(st.snapshots, 60);
    st.snapshotBytesMax = Math.max(st.snapshotBytesMax, snap.bytes);
    st.queued = snap.queued;
    this.queuedMin = Math.min(this.queuedMin, snap.queued);
    if (++this.queuedSeen >= NET.input.dilateWindow) {
      // Never fewer than the target waiting: more than the server needs.
      this.timeScale = this.queuedMin >= NET.input.queueTarget ? 1 - NET.input.dilate : 1;
      this.queuedMin = Infinity;
      this.queuedSeen = 0;
    }

    // The clock: where the server's ticks sit against local time.
    const sample = snap.tick - now / TICK_MS;
    if (!this.hasClock || Math.abs(sample - this.offset) > TICK_RATE / 2) {
      // The first snapshot, or a long silence (a hidden tab, a stall): start over.
      this.offset = sample;
      this.hasClock = true;
      this.resync = true;
    } else {
      const d = sample - this.offset;
      this.offset += d * 0.05;
      this.jitter += (Math.abs(d) - this.jitter) * 0.1;
    }
    st.jitter = this.jitter * TICK_MS;

    this.snaps.push(snap);
    if (this.snaps.length > 64) this.snaps.shift();
    for (const ev of snap.events) this.events.push(ev);
    this.reconcile(snap);
    this.ready = true;
  }

  /** Set the own pilot to the server's word and replay what the server has not seen yet. */
  private reconcile(snap: Snapshot): void {
    const m = this.match;
    const a = this.own;
    const k = m.mechs[a.id];
    const pending = this.pending;
    let hard = !this.ready;
    if (snap.epoch !== this.epoch) {
      // The server put the pilot somewhere itself: nothing made before that applies.
      this.epoch = snap.epoch;
      pending.length = 0;
      hard = true;
    } else {
      let done = 0;
      while (done < pending.length && pending[done].seq <= snap.ack) done++;
      if (done) pending.splice(0, done);
    }
    if (snap.spawns !== this.spawns) {
      this.spawns = snap.spawns;
      this.viewReset = true;
    }

    const bx = a.p.pos.x;
    const by = a.p.pos.y;
    const bz = a.p.pos.z;
    const wasInMech = a.inMech;
    const wasAlive = a.alive;
    readOwn(snap.own, a, k);

    const prev = this.prev;
    prev.x = a.p.pos.x;
    prev.y = a.p.pos.y;
    prev.z = a.p.pos.z;
    for (let i = 0; i < pending.length; i++) {
      if (i === pending.length - 1) {
        prev.x = a.p.pos.x;
        prev.y = a.p.pos.y;
        prev.z = a.p.pos.z;
      }
      m.events.length = 0;
      stepOwn(m, this.world, a, pending[i].cmd, TICK_DT);
    }
    m.events.length = 0;

    const dx = a.p.pos.x - bx;
    const dy = a.p.pos.y - by;
    const dz = a.p.pos.z - bz;
    const dist = Math.hypot(dx, dy, dz);
    const st = this.stats;
    const e = this.error;
    if (hard || wasInMech !== a.inMech || wasAlive !== a.alive || dist > NET.correction.snapDistance) {
      if (!hard && dist > NET.correction.snapDistance) st.snaps++;
      e.x = e.y = e.z = 0;
      return;
    }
    // Keep the drawn position where it was; `advance` eases the difference away.
    e.x -= dx;
    e.y -= dy;
    e.z -= dz;
    st.maxCorrection = Math.max(st.maxCorrection, dist);
    if (dist > NOTICEABLE) {
      st.corrections++;
      st.lastCorrection = dist;
    }
  }

  // ---------------------------------------------------------------- the own pilot

  /**
   * One fixed tick of the player's own input: send it, and act on it at once.
   * Returns what the pilot did (a shot, a reload), to be shown without waiting
   * for the server. The command is rounded in place to what was sent.
   */
  command(cmd: InputCmd): MatchEvent[] {
    if (!this.ready) return [];
    const m = this.match;
    const a = this.own;
    quantizeInput(cmd);
    const seq = ++this.seq;
    this.send(encodeInput(this.writer, seq, this.epoch, this.viewTick, cmd));
    this.pending.push({ seq, cmd });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.stats.pending = this.pending.length;

    this.prev.x = a.p.pos.x;
    this.prev.y = a.p.pos.y;
    this.prev.z = a.p.pos.z;
    m.events.length = 0;
    stepOwn(m, this.world, a, cmd, TICK_DT);
    const out = m.events.slice();
    m.events.length = 0;
    return out;
  }

  /** Where to draw the own pilot, `alpha` of the way from the last tick to this one. */
  ownDrawn(alpha: number, out: Vec3): Vec3 {
    const p = this.own.p.pos;
    out.x = lerp(this.prev.x, p.x, alpha) + this.error.x;
    out.y = lerp(this.prev.y, p.y, alpha) + this.error.y;
    out.z = lerp(this.prev.z, p.z, alpha) + this.error.z;
    return out;
  }

  // ---------------------------------------------------------------- everyone else

  /**
   * Once per drawn frame, at local time `now` (milliseconds): move everyone
   * else to where they were `delay` ago, and hand out the events whose moment
   * has come, in order.
   */
  advance(now: number, dt: number): MatchEvent[] {
    const out: MatchEvent[] = [];
    const snaps = this.snaps;
    if (!snaps.length) return out;
    const I = NET.interp;
    const st = this.stats;

    // The delay follows the jitter, slowly, so playback never visibly changes speed.
    const target = Math.min(I.maxTicks, I.baseTicks + this.jitter * I.jitterScale);
    this.delay += Math.max(-0.5 * dt, Math.min(2 * dt, target - this.delay));
    st.delay = this.delay * TICK_MS;

    const newest = snaps[snaps.length - 1].tick;
    let render = now / TICK_MS + this.offset - this.delay;
    if (!this.resync) render = Math.max(render, this.render);
    this.resync = false;
    // Past the newest snapshot things keep moving for a moment, then wait.
    const cap = newest + I.extrapolate * TICK_RATE;
    if (render > newest) st.extrapolated++;
    if (render > cap) render = cap;
    this.render = render;
    this.viewTick = Math.min(render, newest);

    let i = snaps.length - 1;
    while (i > 0 && snaps[i].tick > render) i--;
    const s0 = snaps[i];
    const s1 = snaps[i + 1] ?? s0;
    const span = s1.tick - s0.tick;
    const f = span > 0 ? Math.max(0, Math.min(1, (render - s0.tick) / span)) : 0;
    // Seconds past the newest snapshot (0 while there is one ahead).
    const extra = s1 === s0 ? Math.max(0, render - s0.tick) * TICK_DT : 0;
    const since = Math.max(0, render - s0.tick) * TICK_DT;
    if (i > 0) snaps.splice(0, i);

    const m = this.match;
    m.tick = Math.floor(render);
    m.time = render * TICK_DT;
    m.score[0] = s0.score[0];
    m.score[1] = s0.score[1];
    m.over = s0.over;
    m.winner = s0.winner;
    const me = this.own;
    for (const a of m.actors) {
      if (a === me) continue;
      applyActor(a, s0.actors[a.id], s1.actors[a.id], f, extra);
    }
    for (const k of m.mechs) {
      // In the cockpit the player's own mech is predicted with them.
      if (k.id === me.id && me.inMech) continue;
      applyMech(k, s0.mechs[k.id], s1.mechs[k.id], f, extra, since);
    }

    const events = this.events;
    let due = 0;
    while (due < events.length && events[due].tick <= render) {
      const ev = events[due++];
      if (COSMETIC.has(ev.e.type) && (render - ev.tick) * TICK_DT > I.staleEvent) st.staleEvents++;
      else out.push(ev.e);
    }
    if (due) events.splice(0, due);

    // What is left of past corrections fades out.
    const keep = Math.exp((-dt * 3) / NET.correction.easeTime);
    const e = this.error;
    e.x *= keep;
    e.y *= keep;
    e.z *= keep;
    return out;
  }
}

function applyActor(a: Actor, r0: ActorRec | undefined, r1: ActorRec | undefined, f: number, extra: number): void {
  if (!r0 || !r1) return;
  const p = a.p;
  const fl = r0.flags;
  a.alive = (fl & ActorFlag.Alive) !== 0;
  a.inMech = (fl & ActorFlag.InMech) !== 0;
  a.health = r0.health;
  a.reload = fl & ActorFlag.Reloading ? 1 : 0;
  a.punchPitch = a.punchYaw = 0;
  a.weapon = 0;
  a.loadout[0] = NAMES[r0.weapon] || a.loadout[0];
  p.grounded = (fl & ActorFlag.Grounded) !== 0;
  p.crouched = (fl & ActorFlag.Crouched) !== 0;
  p.sliding = (fl & ActorFlag.Sliding) !== 0;
  p.wallrun.active = (fl & ActorFlag.Wallrun) !== 0;
  p.wallrun.side = fl & ActorFlag.WallRight ? 1 : -1;
  p.thrusting = (fl & ActorFlag.Thrusting) !== 0;
  p.mantle.active = (fl & ActorFlag.Mantle) !== 0;
  if (a.brain) a.brain.state = botStateName(fl);

  // Across a death, a respawn or a seat change there is nothing to glide along.
  const same = ((fl ^ r1.flags) & (ActorFlag.Alive | ActorFlag.InMech)) === 0;
  const glide = same && Math.hypot(r1.x - r0.x, r1.y - r0.y, r1.z - r0.z) < TELEPORT;
  const k = glide ? f : 0;
  p.pos.x = lerp(r0.x, r1.x, k) + r0.vx * extra;
  p.pos.y = lerp(r0.y, r1.y, k) + r0.vy * extra;
  p.pos.z = lerp(r0.z, r1.z, k) + r0.vz * extra;
  p.vel.x = lerp(r0.vx, r1.vx, k);
  p.vel.y = lerp(r0.vy, r1.vy, k);
  p.vel.z = lerp(r0.vz, r1.vz, k);
  p.yaw = lerpAngle(r0.yaw, r1.yaw, k);
  p.pitch = lerp(r0.pitch, r1.pitch, k);
  a.ads = lerp(r0.ads, r1.ads, k);
  if (a.brain) a.brain.charge = lerp(r0.charge, r1.charge, k);
}

function applyMech(k: Mech, r0: MechRec | undefined, r1: MechRec | undefined, f: number, extra: number, since: number): void {
  if (!r0 || !r1) return;
  k.state = mechStateName(r0.state);
  if (r0.state === 0) return;
  const glide = r1.state !== 0 && Math.hypot(r1.x - r0.x, r1.y - r0.y, r1.z - r0.z) < TELEPORT;
  const t = glide ? f : 0;
  k.pos.x = lerp(r0.x, r1.x, t) + r0.vx * extra;
  k.pos.y = lerp(r0.y, r1.y, t) + r0.vy * extra;
  k.pos.z = lerp(r0.z, r1.z, t) + r0.vz * extra;
  k.vel.x = lerp(r0.vx, r1.vx, t);
  k.vel.y = lerp(r0.vy, r1.vy, t);
  k.vel.z = lerp(r0.vz, r1.vz, t);
  k.yaw = lerpAngle(r0.yaw, r1.yaw, t);
  k.pitch = lerp(r0.pitch, r1.pitch, t);
  k.health = r0.health;
  // The state's own clock runs on between snapshots (the drop and the start-up are drawn from it).
  k.stateTime = r0.stateTime + since;
  k.grounded = (r0.flags & MechFlag.Grounded) !== 0;
  k.dashTime = r0.flags & MechFlag.Dashing ? 0.1 : 0;
  k.dashX = r0.dashX;
  k.dashZ = r0.dashZ;
  // The stride wraps at every footfall; only glide within one.
  k.stride = (glide && r1.stride >= r0.stride ? lerp(r0.stride, r1.stride, f) : r0.stride) * MECH.move.strideLength;
  k.landSpeed = r0.landSpeed;
}
