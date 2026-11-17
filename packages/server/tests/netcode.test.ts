import { beforeAll, describe, expect, it } from 'vitest';
import {
  CollisionWorld,
  MECH,
  TUNING,
  resetMech,
  v3,
  INPUT_BYTES,
  Msg,
  NET,
  PROTOCOL_VERSION,
  TICK_DT,
  TICK_RATE,
  WEAPONS,
  Writer,
  createMatch,
  decodeInput,
  decodeSnapshot,
  emptyInput,
  encodeInput,
  encodePing,
  encodeSnapshot,
  eventAudience,
  killActor,
  quantizeInput,
  readOwn,
  stepMatch,
  writeOwn,
  writeWorld,
  type InputCmd,
  type MapData,
  type MatchEvent,
} from '@dropline/shared';
import gym from '../../../data/maps/gym.json';
import { Player, Sim } from './harness';

const map = gym as MapData;
let world: CollisionWorld;

beforeAll(async () => {
  world = await CollisionWorld.create(map);
});

const count = (events: MatchEvent[], type: MatchEvent['type'], actor: number): number =>
  events.filter((e) => e.type === type && 'actor' in e && e.actor === actor).length;

const gap = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Run about, jump, slide and turn: a little of everything movement can do. */
function parkour(t: number): Partial<InputCmd> {
  const leg = Math.floor(t / 2.5) % 4;
  return {
    moveZ: leg === 3 ? -1 : 1,
    moveX: leg === 1 ? 1 : leg === 2 ? -1 : 0,
    sprint: leg !== 3,
    yaw: Math.sin(t * 0.7) * 1.8 + Math.floor(t / 5) * 0.9,
    pitch: Math.sin(t * 1.3) * 0.3,
    jump: t % 1.7 < 0.35,
    crouch: t % 3.1 > 2.6,
  };
}

/** A player who has stopped pressing anything stands where the server says, to the last digit. */
function settle(sim: Sim, ...players: Player[]): void {
  for (const p of players) p.script = () => ({});
  sim.run(1.5);
}

function report(label: string, p: Player): void {
  const s = p.net.stats;
  console.log(
    `[net] ${label}: corrections ${s.corrections} (largest ${s.maxCorrection.toExponential(1)} m), snaps ${s.snaps}, ` +
      `delay ${s.delay.toFixed(0)} ms, jitter ${s.jitter.toFixed(1)} ms, snapshot ${s.snapshotBytes.toFixed(0)} B (max ${s.snapshotBytesMax}), ` +
      `extrapolated ${s.extrapolated}, stale ${s.staleEvents}`,
  );
}

// ---------------------------------------------------------------- wire format

describe('wire format', () => {
  it('carries a command unchanged', () => {
    const cmd: InputCmd = { ...emptyInput(), moveX: -1, moveZ: 0.5, yaw: 12.3456789, pitch: -0.7654321, jump: true, sprint: true, fire: true, use: true, redeploy: true, weapon: 2 };
    quantizeInput(cmd);
    const data = encodeInput(new Writer(), 4_000_000_000, 201, 12345.678, cmd);
    expect(data.byteLength).toBe(INPUT_BYTES);
    expect(decodeInput(data)).toEqual({ seq: 4_000_000_000, epoch: 201, viewTick: 12345.678, cmd });
  });

  it('carries which shoulder the player aims over', () => {
    for (const shoulder of [0, 1, -1]) {
      const cmd = quantizeInput({ ...emptyInput(), shoulder });
      expect(decodeInput(encodeInput(new Writer(), 1, 0, 0, cmd))?.cmd.shoulder).toBe(shoulder);
    }
  });

  it('refuses commands no real client would send', () => {
    const w = new Writer();
    const ok = encodeInput(w, 1, 0, 0, emptyInput());
    expect(decodeInput(ok)).not.toBeNull();
    expect(decodeInput(ok.slice(0, INPUT_BYTES - 1))).toBeNull();
    expect(decodeInput(encodeInput(w, 1, 0, 0, { ...emptyInput(), yaw: NaN }))).toBeNull();
    expect(decodeInput(encodeInput(w, 1, 0, 0, { ...emptyInput(), pitch: 2 }))).toBeNull();
    expect(decodeInput(encodeInput(w, 1, 0, Infinity, emptyInput()))).toBeNull();
    expect(decodeInput(encodeInput(w, 1, 0, 0, { ...emptyInput(), weapon: 9 }))).toBeNull();
  });

  it('carries the own pilot to the last digit, on foot, mid-climb and in a mech', () => {
    const m = createMatch(map, world, { seed: 3, humans: 1, startMeter: 1 });
    const copy = createMatch(map, world, { seed: 99, humans: 1 });
    const a = m.actors[0];
    const check = (): void => {
      const w = new Writer();
      writeOwn(w, a, m.mechs[0]);
      readOwn(w.written().slice(), copy.actors[0], copy.mechs[0]);
      const b = copy.actors[0];
      expect(b.p).toEqual(a.p);
      // Everything about the mech except what only the server uses.
      expect({ ...copy.mechs[0], lastAttacker: 0, events: 0 }).toEqual({ ...m.mechs[0], lastAttacker: 0, events: 0 });
      for (const key of ['alive', 'inMech', 'weapon', 'loadout', 'ammo', 'kit', 'cooldown', 'reload', 'equip', 'bloom', 'punchPitch', 'punchYaw', 'ads', 'fireBuffer', 'triggerHeld', 'kills'] as const) {
        expect(b[key], key).toEqual(a[key]);
      }
    };
    a.rng = { s: 123456789 };
    // Running, jumping and firing.
    for (let i = 0; i < 90; i++) stepMatch(m, world, [{ ...emptyInput(), yaw: a.p.yaw, moveZ: 1, sprint: true, jump: i % 30 < 5, fire: i > 40 }], TICK_DT);
    check();
    // Calling the mech, waiting for it and climbing in.
    for (let i = 0; i < 400; i++) {
      stepMatch(m, world, [{ ...emptyInput(), yaw: a.p.yaw, pitch: -0.3, call: i < 5, use: i > 200 && i % 20 < 2 && !a.inMech, moveZ: i > 160 && !a.inMech ? 1 : 0 }], TICK_DT);
    }
    expect(a.inMech).toBe(true);
    for (let i = 0; i < 60; i++) stepMatch(m, world, [{ ...emptyInput(), yaw: a.p.yaw, moveZ: 1, jump: i === 10, fire: true, ads: i > 30 }], TICK_DT);
    check();
  });

  it('carries every kind of event', () => {
    const pos = { x: 1.5, y: -2.25, z: 40.125 };
    const up = { x: 0, y: 1, z: 0 };
    const all: MatchEvent[] = [
      { type: 'shot', actor: 3, weapon: 'scattergun', origin: pos, traces: [{ end: pos, normal: up, victim: -1, mech: -1, head: false }, { end: pos, normal: null, victim: 5, mech: -1, head: true }, { end: pos, normal: null, victim: -1, mech: 6, head: false }] },
      { type: 'damage', victim: 5, attacker: 3, amount: 17.5, head: true, killed: true, pos },
      { type: 'kill', victim: 5, attacker: 3, weapon: 'pike_rocket', head: false },
      { type: 'kill', victim: 5, attacker: -1, weapon: '', head: false },
      { type: 'spawn', actor: 7 },
      { type: 'notice', actor: 4, target: 0 },
      { type: 'charge', actor: 4, target: 0, duration: 1.25 },
      { type: 'meterReady', actor: 0 },
      { type: 'mechCall', actor: 0, pos, duration: 2.5 },
      { type: 'callDenied', actor: 0, reason: 'zone' },
      { type: 'mechLand', mech: 0, pos },
      { type: 'embark', actor: 0, duration: 1 },
      { type: 'mechOnline', actor: 0 },
      { type: 'disembark', actor: 0, eject: true },
      { type: 'mechStep', mech: 2, heavy: true },
      { type: 'mechDash', mech: 2 },
      { type: 'ram', mech: 2, victim: -1, other: 6 },
      { type: 'mechDamage', mech: 6, attacker: 2, amount: 320, crit: true, destroyed: false, pos },
      { type: 'mechDestroyed', mech: 6, attacker: -1, weapon: 'crush', pos },
      { type: 'launch', id: 77, actor: 1, kind: Object.keys(WEAPONS).includes('pike') ? WEAPONS.pike.projectile! : '', pos, dir: up },
      { type: 'explode', id: 77, actor: 1, kind: WEAPONS.pike.projectile!, pos, normal: up },
      { type: 'explode', id: 78, actor: 1, kind: WEAPONS.pike.projectile!, pos, normal: null },
      { type: 'matchEnd', winner: 1 },
    ];
    // Rocket kinds are whatever the data calls them.
    (all[2] as { weapon: string }).weapon = WEAPONS.pike.projectile!;
    const m = createMatch(map, world, { seed: 1, humans: 0 });
    const world8 = new Writer();
    writeWorld(world8, m);
    const data = encodeSnapshot(new Writer(), { tick: 500, ack: 9, epoch: 3, spawns: 2, queued: 1 }, m, m.actors[0], world8.written(), all.map((e, i) => ({ tick: 500 - (i % 3), e })));
    const snap = decodeSnapshot(data);
    expect(snap.events.map((x) => x.e)).toEqual(all);
    expect(snap.events.map((x) => x.tick)).toEqual(all.map((_, i) => 500 - (i % 3)));
    expect([snap.tick, snap.ack, snap.epoch, snap.spawns, snap.queued]).toEqual([500, 9, 3, 2, 1]);
    // What only one player is shown, and what nobody needs sent.
    expect(eventAudience({ type: 'reload', actor: 1 })).toBeLessThan(-1);
    expect(eventAudience({ type: 'callDenied', actor: 4, reason: 'meter' })).toBe(4);
  });

  it('rounds other pilots to within a centimeter and a fraction of a degree', () => {
    const m = createMatch(map, world, { seed: 5, humans: 0 });
    for (let i = 0; i < 300; i++) stepMatch(m, world, [], TICK_DT);
    const w = new Writer();
    writeWorld(w, m);
    const snap = decodeSnapshot(encodeSnapshot(new Writer(), { tick: 1, ack: 0, epoch: 0, spawns: 0, queued: 0 }, m, m.actors[0], w.written(), []));
    for (const a of m.actors) {
      const r = snap.actors[a.id];
      expect(gap(r, a.p.pos)).toBeLessThan(0.01);
      expect(Math.abs(Math.sin(r.yaw - a.p.yaw))).toBeLessThan(0.001);
      expect(Math.abs(r.pitch - a.p.pitch)).toBeLessThan(0.001);
    }
    console.log(`[net] world block for ${m.actors.length} pilots and their mechs: ${w.pos} B; whole snapshot ${snap.bytes} B`);
  });
});

// ---------------------------------------------------------------- prediction

describe('prediction and reconciliation', () => {
  it('needs no correction at all on a perfect line', () => {
    const sim = new Sim(world, map);
    const p = sim.join();
    sim.run(0.5);
    sim.clearBots();
    p.script = parkour;
    sim.run(20);
    expect(p.net.stats.corrections).toBe(0);
    expect(p.net.stats.maxCorrection).toBe(0);
    expect(p.net.stats.snaps).toBe(0);
    expect(Math.hypot(p.me.p.pos.x - 0, p.me.p.pos.z - 46)).toBeGreaterThan(3);
    settle(sim, p);
    expect(gap(p.me.p.pos, p.truth.p.pos)).toBe(0);
    report('perfect line, 20 s of movement', p);
  });

  it('needs none with 70 +/- 25 ms of lag either, because a late command waits for its pilot', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 70, jitter: 25 };
    const p = sim.join();
    sim.run(1);
    sim.clearBots();
    p.script = parkour;
    sim.run(30);
    const s = p.net.stats;
    report('70 +/- 25 ms, 30 s of movement', p);
    console.log(`[net]   server: held ${sim.room.stats.stalledTicks} ticks for late commands, skipped ${sim.room.stats.droppedInputs} commands`);
    // A skipped command (the queue running long) is the only thing that may disagree.
    expect(s.corrections).toBeLessThanOrEqual(sim.room.stats.droppedInputs);
    expect(s.maxCorrection).toBeLessThan(0.3);
    expect(s.snaps).toBe(0);
    settle(sim, p);
    expect(gap(p.me.p.pos, p.truth.p.pos)).toBe(0);
  });

  it('answers the same tick the key goes down, whatever the lag', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 70, jitter: 25 };
    const p = sim.join();
    sim.run(1);
    sim.clearBots();
    sim.place(p, 0, 50, 0);
    sim.run(1);
    const from = { ...p.me.p.pos };
    p.script = () => ({ moveZ: 1 });
    // One frame at 60 a second.
    sim.run(0.017);
    expect(gap(p.me.p.pos, from)).toBeGreaterThan(0);
    // The server has not even heard of it yet.
    expect(Math.hypot(p.truth.p.vel.x, p.truth.p.vel.z)).toBe(0);
  });

  it('predicts its own shots: same count, same rounds left, same spread', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 70, jitter: 25 };
    const p = sim.join();
    sim.run(1);
    sim.clearBots();
    sim.place(p, 0, 50, 0);
    sim.run(0.5);
    // Bursts, a reload, a switch to the scattergun and back.
    p.script = (t) => ({ fire: t % 1 < 0.6, moveX: Math.sin(t) > 0 ? 1 : -1, weapon: t > 6 && t < 8 ? 1 : t >= 8 ? 0 : -1, reload: t > 4 && t < 4.1 });
    sim.run(10);
    settle(sim, p);
    const id = p.net.me;
    const mine = count(p.predicted, 'shot', id);
    const real = count(p.events, 'shot', id);
    expect(mine).toBeGreaterThan(40);
    expect(mine).toBe(real);
    expect(p.me.ammo).toEqual(p.truth.ammo);
    expect(p.me.weapon).toBe(p.truth.weapon);
    // The predicted tracers end where the server's did: both drew the same random numbers.
    const ends = (events: MatchEvent[]) => events.flatMap((e) => (e.type === 'shot' && e.actor === id ? e.traces.map((t) => t.end) : []));
    const a = ends(p.predicted);
    const b = ends(p.events);
    expect(a.length).toBe(b.length);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, gap(a[i], b[i]));
    expect(worst).toBeLessThan(0.001);
    // Reloads and switches were shown from prediction and never sent.
    expect(count(p.predicted, 'reload', id)).toBeGreaterThan(0);
    expect(count(p.predicted, 'equip', id)).toBe(2);
    expect(count(p.events, 'reload', id) + count(p.events, 'equip', id)).toBe(0);
    console.log(`[net] ${mine} shots predicted, ${real} confirmed, tracer ends within ${worst.toExponential(1)} m`);
  });

  it('drives a mech with prediction: called, boarded, dashed and fired', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 70, jitter: 25 };
    const p = sim.join();
    sim.run(1);
    sim.clearBots();
    sim.place(p, 0, 50, 0);
    p.truth.meter = 1;
    p.script = (t, self) => ({
      pitch: -0.25,
      call: t < 0.3,
      moveZ: t > 3 && !self.me.inMech ? 1 : 0,
      use: !self.me.inMech && t > 3 && t % 0.5 < 0.1,
    });
    sim.run(7);
    expect(p.truth.inMech).toBe(true);
    expect(p.me.inMech).toBe(true);
    expect(sim.room.match.mechs[p.net.me].state).toBe('piloted');
    const before = { ...p.net.stats };
    p.script = (t) => ({ moveZ: 1, moveX: Math.sin(t * 2) > 0 ? 1 : -1, sprint: true, yaw: Math.sin(t) * 0.8, jump: t % 2 < 0.1, fire: true, ads: t % 3 < 0.2 });
    sim.run(10);
    settle(sim, p);
    const mech = sim.room.match.mechs[p.net.me];
    expect(gap(p.net.match.mechs[p.net.me].pos, mech.pos)).toBe(0);
    expect(p.net.match.mechs[p.net.me].ammo).toEqual(mech.ammo);
    expect(count(p.predicted, 'launch', p.net.me)).toBe(count(p.events, 'launch', p.net.me));
    expect(count(p.predicted, 'launch', p.net.me)).toBeGreaterThanOrEqual(4);
    expect(p.net.stats.snaps).toBe(before.snaps);
    report('in the mech, 10 s', p);
    // Out again through the hatch.
    p.script = (t) => ({ use: t < 0.1 });
    sim.run(1.5);
    settle(sim, p);
    expect(p.me.inMech).toBe(false);
    expect(gap(p.me.p.pos, p.truth.p.pos)).toBe(0);
  });
});

describe('solid bodies over the network', () => {
  /** Start counting corrections from now. */
  const fresh = (p: Player): void => {
    Object.assign(p.net.stats, { corrections: 0, maxCorrection: 0, snaps: 0 });
  };

  it('walks into an empty mech with no correction: it stands still, so both sides agree', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 70, jitter: 25 };
    const p = sim.join();
    sim.run(1);
    sim.clearBots();
    const m = sim.room.match;
    const k = m.mechs[p.net.me];
    resetMech(k, v3(0, 0.02, 40), 0);
    k.state = 'idle';
    sim.place(p, 0.6, 48, 0);
    sim.run(0.5);
    // Being put there by the test is a correction of its own; count from here.
    fresh(p);
    p.script = (t) => ({ moveZ: 1, sprint: true, moveX: Math.sin(t * 3) * 0.6 });
    sim.run(6);
    report('pressing into an empty mech, 70 +/- 25 ms', p);
    expect(p.net.stats.corrections).toBeLessThanOrEqual(sim.room.stats.droppedInputs);
    expect(Math.hypot(p.truth.p.pos.x - k.pos.x, p.truth.p.pos.z - k.pos.z)).toBeGreaterThan(TUNING.player.radius + MECH.body.radius - 0.15);
    settle(sim, p);
    expect(gap(p.me.p.pos, p.truth.p.pos)).toBe(0);
  });

  it('needs no correction while two players shove each other: each bumps into what they see', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 70, jitter: 25 };
    const a = sim.join({ name: 'A' });
    const b = sim.join({ name: 'B' });
    sim.run(1);
    sim.clearBots();
    sim.place(a, 0, 50, 0);
    sim.place(b, 0, 47, Math.PI);
    sim.run(0.5);
    fresh(a);
    fresh(b);
    // Both lean into each other and sidestep now and then: the worst case for a
    // client, which sees the other one a little in the past. The server pushes
    // each against that same past, so they still agree.
    a.script = (t) => ({ moveZ: 1, moveX: Math.sin(t * 2.3) });
    b.script = (t) => ({ moveZ: 1, moveX: Math.cos(t * 1.7) });
    sim.run(10);
    report('A, two players shoving, 70 +/- 25 ms', a);
    report('B, two players shoving, 70 +/- 25 ms', b);
    const apart = Math.hypot(a.truth.p.pos.x - b.truth.p.pos.x, a.truth.p.pos.z - b.truth.p.pos.z);
    expect(apart).toBeGreaterThan(TUNING.player.radius * 2 - 0.15);
    for (const p of [a, b]) {
      expect(p.net.stats.corrections).toBeLessThanOrEqual(sim.room.stats.droppedInputs);
      expect(p.net.stats.snaps).toBe(0);
    }
    settle(sim, a, b);
    expect(gap(a.me.p.pos, a.truth.p.pos)).toBe(0);
    expect(gap(b.me.p.pos, b.truth.p.pos)).toBe(0);
  });
});

// ---------------------------------------------------------------- lag compensation

describe('lag compensation', () => {
  /** A aims at where it sees B strafing and holds the trigger. Returns the share of rounds that struck B. */
  function duel(lag: { delay: number; jitter: number }, compensate: boolean): { hits: number; shots: number; rewind: number } {
    const sim = new Sim(world, map, 4);
    sim.lag = lag;
    const a = sim.join({ name: 'Shooter' });
    const b = sim.join({ name: 'Runner' });
    sim.run(1);
    sim.clearBots();
    expect(a.truth.team).not.toBe(b.truth.team);
    sim.place(a, 0, 50, 0);
    sim.place(b, 0, 34, Math.PI);
    if (!compensate) sim.room.match.history = null;
    b.script = (t) => ({ yaw: Math.PI, moveX: t % 2.4 < 1.2 ? 1 : -1 });
    a.script = (_t, self) => {
      // Straight at the chest of the runner as it is drawn on this screen, recoil taken out.
      const seen = self.net.match.actors[b.net.me].p.pos;
      const me = self.me;
      const dx = seen.x - me.p.pos.x;
      const dy = seen.y + 1.0 - (me.p.pos.y + 1.62);
      const dz = seen.z - me.p.pos.z;
      return { yaw: Math.atan2(-dx, -dz) - me.punchYaw, pitch: Math.atan2(dy, Math.hypot(dx, dz)) - me.punchPitch, fire: true, ads: true };
    };
    for (let i = 0; i < 48; i++) {
      // The runner cannot be allowed to die: a respawn elsewhere would end the test.
      b.truth.health = 100;
      b.truth.sinceDamage = 0;
      sim.run(0.25);
    }
    let shots = 0;
    let hits = 0;
    for (const e of a.events) {
      if (e.type !== 'shot' || e.actor !== a.net.me) continue;
      shots += e.traces.length;
      hits += e.traces.filter((t) => t.victim === b.net.me).length;
    }
    return { hits, shots, rewind: sim.room.stats.rewindMs };
  }

  it('lands shots where the shooter aimed, at 70 +/- 25 ms', () => {
    const on = duel({ delay: 70, jitter: 25 }, true);
    const off = duel({ delay: 70, jitter: 25 }, false);
    console.log(`[net] strafing target at 16 m, 70 +/- 25 ms: ${on.hits}/${on.shots} hit with lag compensation (rewound ${on.rewind.toFixed(0)} ms on average), ${off.hits}/${off.shots} without`);
    expect(on.shots).toBeGreaterThan(60);
    expect(on.hits / on.shots).toBeGreaterThan(0.9);
    expect(off.hits / off.shots).toBeLessThan(0.5);
  });

  it('stops rewinding at the cap: a worse line has to lead its shots', () => {
    const far = duel({ delay: 260, jitter: 20 }, true);
    console.log(`[net] the same at 260 +/- 20 ms: ${far.hits}/${far.shots} hit`);
    expect(far.hits / far.shots).toBeLessThan(0.6);
  });

  it('cannot be talked into looking further back than the cap', () => {
    const sim = new Sim(world, map);
    const a = sim.join();
    sim.join();
    sim.run(1);
    const w = new Writer();
    // A command that claims to have been looking at the world ten seconds ago.
    a.raw(encodeInput(w, 1_000_000, sim.room.seats[a.net.me].epoch, sim.room.tick - 600, { ...emptyInput(), fire: true }));
    sim.run(0.2);
    expect(sim.room.stats.rewindMsMax).toBeLessThanOrEqual(NET.rewindCap * 1000 + 1e-6);
  });
});

// ---------------------------------------------------------------- seats

describe('seats', () => {
  it('seats players on alternating teams in place of bots, and says who is who', () => {
    const sim = new Sim(world, map);
    const a = sim.join({ name: 'Ada' });
    const b = sim.join({ name: '<b>Bob</b>\u0007 the very long named pilot' });
    const c = sim.join({ name: '' });
    sim.run(0.5);
    expect([a.truth.team, b.truth.team, c.truth.team]).toEqual([0, 1, 0]);
    expect(a.truth.brain).toBeNull();
    expect(a.truth.name).toBe('Ada');
    expect(b.truth.name).toBe('bBobb the very l');
    expect(c.truth.name).toMatch(/^Pilot \d$/);
    expect(a.truth.loadout).toEqual(['carbine', 'scattergun', 'longshot', 'pike']);
    // Everyone's copy of the roster agrees, including the first to arrive.
    for (const p of [a, b, c]) {
      expect(p.net.match.actors.map((x) => x.name)).toEqual(sim.room.match.actors.map((x) => x.name));
      expect(p.net.match.actors.map((x) => x.brain === null)).toEqual(sim.room.match.actors.map((x) => x.brain === null));
    }
    expect(sim.room.stats.humans).toBe(3);
  });

  it('seats a player on the side they picked while the teams are even, and on the short side otherwise', () => {
    const sim = new Sim(world, map);
    const a = sim.join({ name: 'Ada', side: 1 });
    const b = sim.join({ name: 'Bob', side: 1 });
    const c = sim.join({ name: 'Cy', side: 1 });
    const d = sim.join({ name: 'Di', side: 7 });
    sim.run(0.5);
    expect([a.truth.team, b.truth.team, c.truth.team, d.truth.team]).toEqual([1, 0, 1, 0]);
  });

  it('turns away an old build and a ninth player with a reason', () => {
    const sim = new Sim(world, map);
    const old = sim.join({ version: PROTOCOL_VERSION + 1 });
    sim.run(0.2);
    expect(old.rejected).toEqual({ t: 'reject', reason: 'version', v: PROTOCOL_VERSION });
    expect(old.closedByServer).toBe(true);
    const eight = Array.from({ length: 8 }, () => sim.join());
    sim.run(0.3);
    expect(eight.every((p) => p.welcome !== null)).toBe(true);
    const ninth = sim.join();
    sim.run(0.3);
    expect(ninth.rejected?.reason).toBe('full');
    expect(sim.room.match.actors.every((x) => x.brain === null)).toBe(true);
  });

  it('holds a dropped player their seat, score and all, then gives it to a bot', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 30, jitter: 5 };
    const a = sim.join({ name: 'Ada' });
    const b = sim.join({ name: 'Bob' });
    sim.run(1);
    const seat = a.net.me;
    a.truth.kills = 7;
    a.truth.meter = 0.5;
    a.disconnect();
    sim.run(5);
    expect(sim.room.match.actors[seat].name).toBe('Ada');
    expect(sim.room.match.actors[seat].brain).toBeNull();
    // Back in time, with the token from the first welcome.
    a.connect(a.welcome!.token);
    sim.run(1);
    expect(a.welcome!.resumed).toBe(true);
    expect(a.net.me).toBe(seat);
    expect(a.me.kills).toBe(7);
    expect(a.me.meter).toBeGreaterThanOrEqual(0.5);
    a.script = parkour;
    sim.run(3);
    settle(sim, a);
    expect(gap(a.me.p.pos, a.truth.p.pos)).toBe(0);

    // Gone for good this time.
    a.disconnect();
    sim.run(NET.graceSeconds + 1);
    const now = sim.room.match.actors[seat];
    expect(now.brain).not.toBeNull();
    expect(now.name).not.toBe('Ada');
    expect(b.net.match.actors[seat].name).toBe(now.name);
    expect(b.net.match.actors[seat].brain).not.toBeNull();
    // A stale token is a new player.
    a.connect(a.welcome!.token);
    sim.run(1);
    expect(a.welcome!.resumed).toBe(false);
  });

  it('gives the seat to a bot at once when the player says they are leaving', () => {
    const sim = new Sim(world, map);
    const a = sim.join({ name: 'Ada' });
    const b = sim.join({ name: 'Bob' });
    sim.run(1);
    const seat = a.net.me;
    a.raw(new Uint8Array([Msg.Leave]).buffer);
    sim.run(0.5);
    expect(a.closedByServer).toBe(true);
    expect(sim.room.match.actors[seat].brain).not.toBeNull();
    expect(sim.room.match.actors[seat].name).not.toBe('Ada');
    expect(b.net.match.actors[seat].name).toBe(sim.room.match.actors[seat].name);
    // The token went with the seat.
    a.connect(a.welcome!.token);
    sim.run(1);
    expect(a.welcome!.resumed).toBe(false);
  });
});

// ---------------------------------------------------------------- rare paths

describe('rare paths', () => {
  it('dies, waits and respawns facing the spawn point, without replaying the old life', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 70, jitter: 25 };
    const p = sim.join();
    sim.run(1);
    sim.clearBots();
    p.script = (t) => ({ ...parkour(t), fire: true });
    sim.run(3);
    const epoch = sim.room.seats[p.net.me].epoch;
    killActor(sim.room.match, p.truth, null, '', false);
    sim.run(0.5);
    expect(p.me.alive).toBe(false);
    expect(p.events.some((e) => e.type === 'kill' && e.victim === p.net.me)).toBe(true);
    const shotsWhileDead = count(p.predicted, 'shot', p.net.me);
    sim.run(1);
    expect(count(p.predicted, 'shot', p.net.me)).toBe(shotsWhileDead);
    sim.run(3);
    expect(p.me.alive).toBe(true);
    expect(sim.room.seats[p.net.me].epoch).not.toBe(epoch);
    // The server waited at the spawn point for this client's first command: nothing to correct.
    expect(p.net.stats.snaps).toBe(0);
    expect(p.net.stats.corrections).toBe(0);
    settle(sim, p);
    expect(gap(p.me.p.pos, p.truth.p.pos)).toBe(0);
    report('death and respawn', p);
  });

  it('redeploys on the server, not on the client', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 50, jitter: 10 };
    const p = sim.join();
    sim.run(1);
    sim.clearBots();
    sim.place(p, 20, 20, 1);
    sim.run(0.5);
    const spawns = sim.room.seats[p.net.me].spawns;
    p.script = (t) => ({ redeploy: t < 0.2 });
    sim.run(1);
    expect(sim.room.seats[p.net.me].spawns).toBe((spawns + 1) & 255);
    expect(map.spawns.some((s) => Math.hypot(s.pos[0] - p.truth.p.pos.x, s.pos[2] - p.truth.p.pos.z) < 0.5)).toBe(true);
    settle(sim, p);
    expect(gap(p.me.p.pos, p.truth.p.pos)).toBe(0);
    // The view was turned to the spawn's direction.
    expect(p.yaw).toBe(p.truth.p.yaw);
  });

  it('lets go of the buttons when a tab is hidden, and picks up again when it returns', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 70, jitter: 25 };
    const p = sim.join();
    sim.run(1);
    sim.clearBots();
    sim.place(p, 0, 50, 0);
    p.script = () => ({ moveZ: 1, sprint: true, fire: true });
    sim.run(1.5);
    p.hidden = true;
    sim.run(0.5);
    // Not still sprinting and firing on the last command forever.
    const speedSoonAfter = Math.hypot(p.truth.p.vel.x, p.truth.p.vel.z);
    sim.run(2);
    expect(speedSoonAfter).toBeLessThan(9);
    expect(Math.hypot(p.truth.p.vel.x, p.truth.p.vel.z)).toBe(0);
    const stood = { ...p.truth.p.pos };
    sim.run(2);
    expect(gap(stood, p.truth.p.pos)).toBe(0);
    p.hidden = false;
    p.script = parkour;
    sim.run(5);
    settle(sim, p);
    expect(gap(p.me.p.pos, p.truth.p.pos)).toBe(0);
    report('hidden for 4.5 s and back', p);
  });

  it('rides out a hitch on the player\'s machine without skipping a command', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 20, jitter: 3 };
    const p = sim.join();
    sim.run(1);
    sim.clearBots();
    p.script = parkour;
    sim.run(2);
    // Five frames go missing, three times over; each time their commands then arrive together.
    for (let i = 0; i < 3; i++) {
      p.frozenUntil = sim.now + 85;
      sim.run(4);
    }
    console.log(`[net] three 85 ms hitches: held ${sim.room.stats.stalledTicks} ticks, skipped ${sim.room.stats.droppedInputs} commands, clock slowed for ${p.dilated.toFixed(2)} s`);
    expect(sim.room.stats.stalledTicks).toBeGreaterThanOrEqual(9);
    expect(p.dilated).toBeGreaterThan(0);
    expect(sim.room.stats.droppedInputs).toBe(0);
    expect(p.net.stats.corrections).toBe(0);
    // And the server is not left sitting on a pile of old commands.
    expect(sim.room.seats[p.net.me].queue.length).toBeLessThanOrEqual(NET.input.queueTarget);
    expect(p.net.timeScale).toBe(1);
    settle(sim, p);
    expect(gap(p.me.p.pos, p.truth.p.pos)).toBe(0);
    report('three 85 ms hitches', p);
  });

  it('recovers from a burst of commands after a stall', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 40, jitter: 10 };
    const p = sim.join();
    sim.run(1);
    sim.clearBots();
    p.script = parkour;
    sim.run(2);
    // The line freezes for 400 ms, then everything arrives at once.
    sim.lag = { delay: 440, jitter: 0 };
    sim.run(0.05);
    sim.lag = { delay: 40, jitter: 10 };
    sim.run(5);
    expect(sim.room.stats.droppedInputs).toBeGreaterThan(0);
    expect(sim.room.seats[p.net.me].queue.length).toBeLessThanOrEqual(NET.input.maxQueue);
    settle(sim, p);
    expect(gap(p.me.p.pos, p.truth.p.pos)).toBe(0);
    report('a 400 ms freeze', p);
  });

  it('starts the next match by itself and takes everyone along', () => {
    const sim = new Sim(world, map);
    sim.lag = { delay: 50, jitter: 10 };
    const a = sim.join();
    const b = sim.join();
    sim.run(1);
    const m = sim.room.match;
    m.score[0] = m.scoreLimit - 1;
    a.truth.kills = 3;
    const victim = m.actors.find((x) => x.team === 1)!;
    killActor(m, victim, a.truth, 'carbine', false);
    expect(m.over).toBe(true);
    sim.run(1);
    expect(a.events.some((e) => e.type === 'matchEnd' && e.winner === 0)).toBe(true);
    expect(a.net.match.over).toBe(true);
    expect(b.net.match.winner).toBe(0);
    sim.run(NET.restartSeconds + 1);
    expect(sim.room.round).toBe(2);
    expect(sim.room.match).not.toBe(m);
    for (const p of [a, b]) {
      expect(p.rounds).toBe(1);
      expect(p.net.match.over).toBe(false);
      expect(p.net.match.score).toEqual([0, 0]);
      expect(p.truth.brain).toBeNull();
      expect(p.me.kills).toBe(0);
    }
    a.script = parkour;
    sim.run(3);
    settle(sim, a);
    expect(gap(a.me.p.pos, a.truth.p.pos)).toBe(0);
  });
});

// ---------------------------------------------------------------- abuse

describe('a client that misbehaves', () => {
  it('is dropped for garbage, oversized messages and silence', () => {
    const sim = new Sim(world, map);
    const noisy = sim.join();
    const big = sim.join();
    sim.run(0.3);
    for (let i = 0; i < 12; i++) noisy.raw(new Uint8Array([Msg.Input, 1, 2, 3]).buffer);
    big.raw(new ArrayBuffer(NET.input.maxMessageBytes + 1));
    sim.run(0.3);
    expect(noisy.closedByServer).toBe(true);
    expect(big.closedByServer).toBe(true);

    // Connects and never says hello.
    const mute = new Player(sim);
    let closed = false;
    sim.room.connect({ send: () => {}, close: () => (closed = true), buffered: 0 });
    sim.run(NET.helloTimeout + 0.5);
    expect(closed).toBe(true);
    expect(mute.welcome).toBeNull();
  });

  it('cannot move faster by sending more commands', () => {
    const sim = new Sim(world, map);
    const fair = sim.join();
    const cheat = sim.join();
    sim.run(0.5);
    sim.clearBots();
    sim.place(fair, -10, 50, 0);
    sim.place(cheat, 10, 50, 0);
    sim.run(0.5);
    const run: Partial<InputCmd> = { moveZ: 1, sprint: true };
    fair.script = () => run;
    cheat.script = () => run;
    // The cheat sends every command three times over with fresh sequence numbers.
    const w = new Writer();
    let seq = 500_000;
    const flood = (): void => {
      for (let i = 0; i < 2; i++) cheat.raw(encodeInput(w, seq++, sim.room.seats[cheat.net.me].epoch, -1, { ...emptyInput(), ...run }));
    };
    for (let i = 0; i < 3 * TICK_RATE; i++) {
      flood();
      sim.run(TICK_DT);
    }
    const far = (p: Player, x: number): number => Math.hypot(p.truth.p.pos.x - x, p.truth.p.pos.z - 50);
    expect(far(cheat, 10)).toBeLessThan(far(fair, -10) * 1.05);
  });

  it('answers a ping and ignores one of the wrong size', () => {
    const sim = new Sim(world, map);
    const p = sim.join();
    sim.run(0.3);
    const got: ArrayBuffer[] = [];
    const client = sim.room.connect({ send: (d) => typeof d !== 'string' && got.push(d), close: () => {}, buffered: 0 });
    sim.room.receive(client, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'Pinger' }));
    sim.room.receive(client, encodePing(new Writer(), Msg.Ping, 1234.5));
    const pong = got.find((d) => new Uint8Array(d)[0] === Msg.Pong)!;
    expect(new DataView(pong).getFloat64(1, true)).toBe(1234.5);
    expect(p.welcome).not.toBeNull();
  });
});

// ---------------------------------------------------------------- a full server

describe('a full server', () => {
  it('runs eight players and their fights for a minute within budget', () => {
    const sim = new Sim(world, map, 9);
    sim.lag = { delay: 70, jitter: 25 };
    const players = Array.from({ length: 8 }, (_, i) => sim.join({ name: `P${i}`, fps: i === 7 ? 30 : 60 }));
    sim.run(1);
    for (const p of players) p.truth.meter = 0.9;
    // Everyone runs at the middle, firing, and calls a mech when they can.
    for (const p of players) {
      const phase = p.net.me * 1.3;
      p.script = (t, self) => {
        const me = self.me.p.pos;
        const yaw = Math.atan2(me.x, me.z) + Math.sin(t * 0.5 + phase) * 0.6;
        return { yaw, pitch: -0.05, moveZ: 1, moveX: Math.sin(t + phase) > 0 ? 1 : -1, sprint: t % 4 < 3, jump: (t + phase) % 2 < 0.2, fire: t % 1.5 < 1, call: t % 5 < 0.2, use: t % 1 < 0.1, weapon: Math.floor(t / 8 + phase) % 4 };
      };
    }
    const started = performance.now();
    sim.run(60);
    const took = performance.now() - started;
    const st = sim.room.stats;
    const kills = players.reduce((n, p) => n + p.truth.kills, 0);
    console.log(
      `[net] 8 players, 60 s, 70 +/- 25 ms: snapshot ${st.snapshotBytes.toFixed(0)} B on average, ${st.snapshotBytesMax} B at most (${((st.snapshotBytes * TICK_RATE) / NET.snapshotEvery / 1024).toFixed(1)} KB/s per player); ` +
        `${kills} kills, score ${st.score.join('-')}; held ${st.stalledTicks} ticks, skipped ${st.droppedInputs} commands; ` +
        `rewound ${st.rewindMs.toFixed(0)} ms on average, ${st.rewindMsMax.toFixed(0)} at most; ${took.toFixed(0)} ms of CPU for server and 8 clients`,
    );
    for (const p of players) report(`  ${p.truth.name}`, p);
    expect(st.snapshotBytes).toBeLessThan(1500);
    expect(st.snapshotBytesMax).toBeLessThan(6000);
    expect(kills).toBeGreaterThan(0);
    for (const p of players) {
      expect(p.closedByServer).toBe(false);
      expect(p.net.stats.staleEvents).toBe(0);
      // Fights push pilots around (rams, knockback), so corrections happen; they stay small and eased.
      expect(p.net.stats.snaps).toBeLessThanOrEqual(2);
      // Bumping into the others costs none: each player is pushed on the server by
      // the others as their client drew them. What is left is rams and the moment
      // of joining. (Measured: 0 to 3 a player in this minute; 38 to 114 when the
      // server pushed against where the others stood by then.)
      expect(p.net.stats.corrections).toBeLessThanOrEqual(8);
    }
    settle(sim, ...players);
    // Whoever has come to rest stands where the server says. (Someone may still be falling from a respawn.)
    const still = (q: Player): boolean => q.me.alive && q.truth.alive && Math.hypot(q.me.p.vel.x, q.me.p.vel.y, q.me.p.vel.z) === 0;
    expect(players.filter(still).length).toBeGreaterThanOrEqual(6);
    for (const p of players) if (still(p)) expect(gap(p.me.p.pos, p.truth.p.pos)).toBe(0);
  }, 120_000);
});
