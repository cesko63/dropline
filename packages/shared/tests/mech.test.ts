import { beforeAll, describe, expect, it } from 'vitest';
import gym from '../../../data/maps/gym.json';
import {
  BOT_ROLES,
  COMBAT,
  CollisionWorld,
  FRAMES,
  FRAME_LIST,
  PROJECTILES,
  TICK_DT,
  WEAPONS,
  canSee,
  createMatch,
  emptyInput,
  enterMech,
  frameIndex,
  frameOf,
  resetMech,
  stepMatch,
  v3,
  type Actor,
  type InputCmd,
  type MapData,
  type MatchEvent,
  type MatchState,
  type CloakAbility,
  type DashMove,
  type LeapMove,
  type Mech,
  type SalvoAbility,
  type ShieldAbility,
  type StompMove,
} from '../src';

const map = gym as MapData;
const R = COMBAT.mech;
/** The default frame, which every mech here is unless a test says otherwise. */
const MECH = FRAMES.halberd;
const DASH = MECH.mobility as DashMove;
const SALVO = MECH.ability as SalvoAbility;
const B = MECH.body;
let world: CollisionWorld;

beforeAll(async () => {
  world = await CollisionWorld.create(map);
});

type Script = (t: number) => Partial<InputCmd>;
const still: Script = () => ({});

/** Put a pilot on the open floor in the south-east, where nothing blocks the view or the sky. */
function place(a: Actor, x: number, z: number, yaw: number): void {
  a.p.pos.x = x;
  a.p.pos.y = 0.02;
  a.p.pos.z = z;
  a.p.yaw = yaw;
  a.p.pitch = 0;
  a.p.vel.x = a.p.vel.y = a.p.vel.z = 0;
}

/** One human (actor 0) and one enemy (actor 1) that does nothing unless scripted. */
function duel(seed = 1): { m: MatchState; me: Actor; foe: Actor; mine: Mech; theirs: Mech } {
  const m = createMatch(map, world, { seed, teamSize: 1 });
  const [me, foe] = m.actors;
  foe.brain = null;
  place(me, 44, 58, 0);
  place(foe, 44, 20, Math.PI);
  me.protect = foe.protect = 0;
  return { m, me, foe, mine: m.mechs[0], theirs: m.mechs[1] };
}

/** Step for `seconds`. Actor 0 uses `input`, actor 1 (when it has no brain) uses `other`. */
function run(m: MatchState, seconds: number, input: Script = still, other: Script = still): MatchEvent[] {
  const events: MatchEvent[] = [];
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    const cmds = m.actors.slice(0, 2).map((a, n) => ({ ...emptyInput(), yaw: a.p.yaw, pitch: a.p.pitch, ...(n === 0 ? input : other)(i * TICK_DT) }));
    stepMatch(m, world, cmds, TICK_DT);
    events.push(...m.events);
  }
  return events;
}

const dashes = (events: MatchEvent[]): MatchEvent[] => events.filter((e) => e.type === 'mechAbility' && e.what === 'dash');

const of = <T extends MatchEvent['type']>(events: MatchEvent[], type: T): Extract<MatchEvent, { type: T }>[] =>
  events.filter((e): e is Extract<MatchEvent, { type: T }> => e.type === type);

/** Stand a mech of a frame at a place without the call-in: empty, or with its owner already at the controls. */
function stage(m: MatchState, a: Actor, x: number, z: number, yaw: number, piloted: boolean, frame = 0): Mech {
  const k = m.mechs[a.id];
  resetMech(k, v3(x, 0.02, z), yaw, frame);
  k.state = 'idle';
  if (piloted) {
    a.p.yaw = yaw;
    a.p.pitch = 0;
    enterMech(m, a, k);
    k.state = 'piloted';
    m.events.length = 0;
  }
  return k;
}

/** Pitch that points the pilot's eye at a height `y`, `dist` meters ahead. */
const lookAt = (y: number, dist: number, eye = 1.62): number => Math.atan2(y - eye, dist);

describe('mech meter and call-in', () => {
  it('fills over time and from damage dealt, and announces itself once', () => {
    const { m, me, foe } = duel();
    run(m, 11);
    expect(me.meter).toBeCloseTo(11 / R.meter.passiveTime, 3);
    // One carbine round into the enemy standing 10 m ahead.
    place(foe, 44, 48, Math.PI);
    const before = me.meter;
    run(m, 0.4, () => ({ ads: true, pitch: lookAt(1.0, 10) }));
    const hit = of(run(m, 0.05, () => ({ ads: true, fire: true, pitch: lookAt(1.0, 10) })), 'damage');
    expect(hit.length).toBe(1);
    expect(me.meter - before).toBeCloseTo(0.45 / R.meter.passiveTime + hit[0].amount * R.meter.perDamage, 3);

    me.meter = 0.999;
    const events = run(m, 2, () => ({ yaw: Math.PI }));
    expect(of(events, 'meterReady')).toEqual([{ type: 'meterReady', actor: 0 }]);
    expect(me.meter).toBe(1);
  });

  it('refuses a call without a full meter', () => {
    const { m, me, mine } = duel();
    me.meter = 0.6;
    const events = run(m, 0.1, () => ({ call: true, pitch: lookAt(0, 20) }));
    expect(of(events, 'callDenied')).toEqual([{ type: 'callDenied', actor: 0, reason: 'meter' }]);
    expect(mine.state).toBe('none');
    expect(me.meter).toBeGreaterThan(0.6);
  });

  it('lands where the pilot looks, exactly when the telegraph says', () => {
    const { m, me, mine } = duel();
    me.meter = 1;
    const call = of(run(m, 0.05, () => ({ call: true, pitch: lookAt(0, 20) })), 'mechCall');
    expect(call.length).toBe(1);
    expect(call[0].duration).toBe(R.drop.time);
    expect(call[0].pos.x).toBeCloseTo(44, 1);
    expect(call[0].pos.z).toBeCloseTo(38, 0);
    expect(mine.state).toBe('dropping');
    expect(me.meter).toBe(0);
    // Holding the key does not call again, and the meter stays empty while a mech is out.
    const during = run(m, R.drop.time - 0.15, () => ({ call: true }));
    expect(of(during, 'mechCall').length + of(during, 'callDenied').length).toBe(0);
    expect(mine.state).toBe('dropping');
    const landed = of(run(m, 0.15), 'mechLand');
    expect(landed.length).toBe(1);
    expect(mine.state).toBe('idle');
    expect(mine.health).toBe(MECH.health);
    run(m, 5);
    expect(me.meter).toBe(0);
  });

  it('picks a free spot nearby when the pilot looks at the sky or at a place with a roof', () => {
    const sky = duel();
    sky.me.meter = 1;
    run(sky.m, 0.05, () => ({ call: true, pitch: 1.2 }));
    expect(sky.mine.state).toBe('dropping');
    const d = Math.hypot(sky.mine.pos.x - 44, sky.mine.pos.z - 58);
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThan(20);

    // Looking into the duct: its floor is in range, but there is a roof over it.
    const roof = duel();
    place(roof.me, 0, 40, 0);
    roof.me.meter = 1;
    run(roof.m, 0.05, () => ({ call: true, pitch: lookAt(0, 14) }));
    const k = roof.mine;
    expect(k.state).toBe('dropping');
    expect(Math.abs(k.pos.x) < 3 && k.pos.z > 22 && k.pos.z < 30).toBe(false);
    expect(world.overlapsCapsule(k.pos, B.height, B.radius)).toBe(false);
    expect(world.castRay(v3(k.pos.x, k.pos.y + B.height, k.pos.z), v3(0, 1, 0), 40)).toBeNull();
  });

  it('crushes enemies in the landing zone and spares allies', () => {
    const m = createMatch(map, world, { seed: 2, teamSize: 2 });
    for (const a of m.actors) {
      a.brain = null;
      a.protect = 0;
    }
    const [me, ally, under, clear] = m.actors;
    place(me, 44, 58, 0);
    place(ally, 44.8, 38, 0);
    place(under, 43, 38.5, Math.PI);
    place(clear, 44, 26, Math.PI);
    me.meter = 1;
    run(m, 0.05, () => ({ call: true, pitch: lookAt(0, 20) }));
    const events = run(m, R.drop.time + 0.1);
    expect(of(events, 'kill')).toEqual([{ type: 'kill', victim: under.id, attacker: me.id, weapon: 'crush', head: false }]);
    expect(ally.health).toBe(COMBAT.health);
    expect(clear.health).toBe(COMBAT.health);
    expect(m.score).toEqual([1, 0]);
  });
});

describe('getting in and out', () => {
  it('works only from close by, and the mech answers the controls after its start-up time', () => {
    const { m, me, mine } = duel();
    stage(m, me, 44, 46, 0, false);
    expect(of(run(m, 0.1, () => ({ use: true })), 'embark').length).toBe(0);
    expect(me.inMech).toBe(false);
    run(m, 0.05);

    place(me, 44, 46 + R.embark.range - 0.5, 0);
    const events = run(m, 0.05, () => ({ use: true }));
    expect(of(events, 'embark')).toEqual([{ type: 'embark', actor: 0, duration: R.embark.time }]);
    expect(me.inMech).toBe(true);
    expect(mine.state).toBe('boot');

    // Starting up: it neither walks nor fires yet.
    const boot = run(m, R.embark.time - 0.1, () => ({ moveZ: 1, fire: true }));
    expect(of(boot, 'shot').length).toBe(0);
    expect(mine.pos.z).toBeCloseTo(46, 2);
    const online = run(m, 0.1, () => ({ moveZ: 1 }));
    expect(of(online, 'mechOnline').length).toBe(1);
    expect(mine.state).toBe('piloted');
    run(m, 1, () => ({ moveZ: 1 }));
    expect(mine.pos.z).toBeLessThan(44);
    // The pilot rides along at the mech's position.
    expect(me.p.pos).toEqual(mine.pos);
  });

  it('swaps the pilot to the mech weapons and gives their own back, rounds and all', () => {
    const { m, me, mine } = duel();
    run(m, 0.5, () => ({ fire: true, yaw: Math.PI }));
    const carbineLeft = me.ammo[0];
    expect(carbineLeft).toBeLessThan(WEAPONS.carbine.magSize);
    run(m, 0.2, () => ({ yaw: 0 }));

    stage(m, me, 44, 56, 0, true);
    expect(me.loadout).toEqual(MECH.loadout);
    run(m, 0.5, () => ({ fire: true }));
    const cannonLeft = mine.ammo[0];
    expect(cannonLeft).toBeLessThan(WEAPONS.autocannon.magSize);

    const out = run(m, 0.05, () => ({ use: true }));
    expect(of(out, 'disembark')).toEqual([{ type: 'disembark', actor: 0, eject: false }]);
    expect(me.inMech).toBe(false);
    expect(mine.state).toBe('idle');
    expect(me.loadout).toEqual(COMBAT.playerLoadout);
    expect(me.ammo[0]).toBe(carbineLeft);
    // Out through the top hatch with a hop, and the double jump ready.
    expect(me.p.pos.y).toBeGreaterThan(mine.pos.y + 3);
    expect(me.p.vel.y).toBeGreaterThan(5);
    expect(me.p.airJumpsUsed).toBe(0);
    expect(world.overlapsCapsule(me.p.pos, 1.8)).toBe(false);

    // Back on the ground beside it, and in again: the mech kept its own rounds.
    run(m, 2.5);
    expect(me.p.grounded).toBe(true);
    place(me, 44, 58, 0);
    run(m, 0.05, () => ({ use: true }));
    expect(me.inMech).toBe(true);
    expect(me.ammo[0]).toBe(cannonLeft);
  });

  it('keeps the pilot safe inside while the hull takes the hits', () => {
    const { m, me, foe, theirs } = duel();
    stage(m, foe, 44, 46, Math.PI, true);
    // Carbine into the front of the hull from 12 m.
    const pitch = lookAt(2.4, 10.6);
    run(m, 0.4, () => ({ ads: true, pitch }));
    const events = run(m, 1, () => ({ ads: true, fire: true, pitch }));
    const hits = of(events, 'mechDamage');
    expect(hits.length).toBeGreaterThanOrEqual(10);
    expect(of(events, 'damage').length).toBe(0);
    expect(foe.health).toBe(COMBAT.health);
    for (const h of hits) expect(h.amount).toBeCloseTo(WEAPONS.carbine.armor, 5);
    expect(theirs.health).toBeCloseTo(MECH.health - hits.length * WEAPONS.carbine.armor, 3);
  });
});

describe('mech movement', () => {
  it('walks and sprints at its own speeds and is stopped by walls', () => {
    const { m, me, mine } = duel();
    stage(m, me, 44, 40, 0, true);
    run(m, 2, () => ({ moveZ: 1 }));
    expect(Math.hypot(mine.vel.x, mine.vel.z)).toBeCloseTo(MECH.move.walkSpeed, 1);
    run(m, 2, () => ({ moveZ: 1, sprint: true }));
    expect(Math.hypot(mine.vel.x, mine.vel.z)).toBeCloseTo(MECH.move.sprintSpeed, 1);
    expect(mine.grounded).toBe(true);
    // Jumping is not something it does: the key is its dash, and it stays on the ground.
    expect(mine.pos.y).toBeLessThan(0.1);

    // Sprint into the south wall, whose face is at z = 70.
    run(m, 10, () => ({ moveZ: 1, sprint: true, yaw: Math.PI }));
    expect(mine.pos.z).toBeGreaterThan(70 - B.radius - 0.1);
    expect(mine.pos.z).toBeLessThanOrEqual(70 - B.radius);
    expect(world.overlapsCapsule(mine.pos, B.height, B.radius)).toBe(false);
  });

  it('does not fit through the duct that a crouched pilot gets into', () => {
    const { m, me, mine } = duel();
    stage(m, me, 0, 38, 0, true);
    run(m, 4, () => ({ moveZ: 1 }));
    // The duct mouth is at z = 30.
    expect(mine.pos.z).toBeGreaterThan(30 + B.radius - 0.05);
    const pilot = duel();
    place(pilot.me, 0, 38, 0);
    run(pilot.m, 5, () => ({ moveZ: 1, crouch: true }));
    expect(pilot.me.p.pos.z).toBeLessThan(28);
  });

  it('dashes where it is steered, spends a charge each time and earns it back', () => {
    const { m, me, mine } = duel();
    stage(m, me, 44, 40, 0, true);
    const first = run(m, DASH.time + 0.3, (t) => ({ jump: t < 0.05 }));
    expect(dashes(first).length).toBe(1);
    // Standing still it goes where it faces: north, by more than a second of walking.
    const reach = 40 - mine.pos.z;
    expect(reach).toBeGreaterThan(5.5);
    expect(reach).toBeLessThan(9);
    expect(Math.abs(mine.pos.x - 44)).toBeLessThan(0.01);
    expect(mine.charges).toBeLessThan(DASH.charges - 0.8);

    // The second charge goes sideways with the stick; then there is none left.
    const x0 = mine.pos.x;
    const second = run(m, DASH.time + 0.3, (t) => ({ jump: t < 0.05, moveX: 1 }));
    expect(dashes(second).length).toBe(1);
    expect(mine.pos.x - x0).toBeGreaterThan(5.5);
    const none = run(m, 0.5, (t) => ({ jump: t < 0.05 }));
    expect(dashes(none).length).toBe(0);
    // Holding the key does not dash again by itself once a charge is back.
    const held = run(m, DASH.rechargeTime, () => ({ jump: true }));
    expect(dashes(held).length).toBe(0);
    const again = run(m, 0.3, (t) => ({ jump: t >= 0.1 && t < 0.15 }));
    expect(dashes(again).length).toBe(1);
  });

  it('rams a pilot in its path once per dash and throws them aside', () => {
    const { m, me, foe } = duel();
    stage(m, me, 44, 40, 0, true);
    place(foe, 44, 35.5, Math.PI);
    const events = run(m, DASH.time + 0.1, (t) => ({ jump: t < 0.05 }));
    expect(of(events, 'ram')).toEqual([{ type: 'ram', mech: 0, victim: foe.id, other: -1 }]);
    expect(foe.health).toBe(COMBAT.health - DASH.ramDamage);
    expect(foe.p.pos.y).toBeGreaterThan(0.5);
    expect(foe.p.vel.z).toBeLessThan(-3);
  });
});

describe('mech combat', () => {
  it('is hurt far more by the launcher than by small arms, and a rocket takes time to arrive', () => {
    const { m, me, foe, theirs } = duel();
    stage(m, foe, 44, 28, Math.PI, true);
    run(m, 0.1, () => ({ weapon: 3 }));
    run(m, WEAPONS.pike.equipTime + 0.4, () => ({ ads: true, pitch: lookAt(2.4, 28.6) }));
    expect(me.loadout[me.weapon]).toBe('pike');
    const fired = run(m, 0.05, () => ({ ads: true, fire: true, pitch: lookAt(2.4, 28.6) }));
    expect(of(fired, 'launch').length).toBe(1);
    expect(of(fired, 'mechDamage').length).toBe(0);
    expect(m.projectiles.length).toBe(1);
    // 28.6 m at the rocket's speed.
    const flight = 28.6 / PROJECTILES.pike.speed;
    const early = run(m, flight - 0.1, () => ({ ads: true, pitch: lookAt(2.4, 28.6) }));
    expect(of(early, 'explode').length).toBe(0);
    const late = run(m, 0.2, () => ({ ads: true, pitch: lookAt(2.4, 28.6) }));
    expect(of(late, 'explode').length).toBe(1);
    const hit = of(late, 'mechDamage');
    expect(hit.length).toBe(1);
    expect(hit[0].amount).toBe(PROJECTILES.pike.armor);
    expect(hit[0].crit).toBe(false);
    expect(theirs.health).toBe(MECH.health - PROJECTILES.pike.armor);
    expect(m.projectiles.length).toBe(0);
    expect(PROJECTILES.pike.armor).toBeGreaterThan(WEAPONS.carbine.armor * 50);
  });

  it('takes extra damage in the rear vent, and only from behind', () => {
    const { m, me, foe, theirs } = duel();
    // Facing north, away from the shooter: the vent points at them.
    stage(m, foe, 44, 46, 0, true);
    const pitch = lookAt(MECH.vent.height, 12 - MECH.vent.back - MECH.vent.radius);
    run(m, 0.4, () => ({ ads: true, pitch }));
    const back = of(run(m, 0.05, () => ({ ads: true, fire: true, pitch })), 'mechDamage');
    expect(back.length).toBe(1);
    expect(back[0].crit).toBe(true);
    expect(back[0].amount).toBeCloseTo(WEAPONS.carbine.armor * MECH.vent.mult, 5);

    // Same shot at its front.
    theirs.yaw = Math.PI;
    run(m, 0.5, () => ({ ads: true, pitch }));
    const front = of(run(m, 0.05, () => ({ ads: true, fire: true, pitch }), () => ({ yaw: Math.PI })), 'mechDamage');
    expect(front.length).toBe(1);
    expect(front[0].crit).toBe(false);
    expect(front[0].amount).toBeCloseTo(WEAPONS.carbine.armor, 5);
  });

  it('launches its salvo one rocket after another at what the pilot looks at, then waits out the cooldown', () => {
    const { m, me, foe } = duel();
    stage(m, me, 44, 50, 0, true);
    place(foe, -40, -40, 0);
    // Look at the floor 30 m ahead.
    const pitch = lookAt(0, 30, B.eye);
    const S = SALVO;
    const events = run(m, 3, () => ({ ads: true, pitch }));
    const launches = of(events, 'launch');
    expect(launches.length).toBe(S.count);
    for (const l of launches) expect(l.kind).toBe(S.projectile);
    const blasts = of(events, 'explode');
    expect(blasts.length).toBe(S.count);
    for (const b of blasts) {
      expect(Math.hypot(b.pos.x - 44, b.pos.z - 20)).toBeLessThan(3);
      expect(b.pos.y).toBeLessThan(0.1);
    }
    // Still held: nothing more until the cooldown is over.
    expect(of(run(m, S.cooldown - 3.2, () => ({ ads: true, pitch })), 'launch').length).toBe(0);
    expect(of(run(m, 1.5, () => ({ ads: true, pitch })), 'launch').length).toBe(S.count);
    // The cannon keeps its hip spread: the aim button never zooms a mech.
    expect(me.ads).toBe(0);
  });

  it('lets a wall shield a pilot from a blast that would hurt them in the open', () => {
    // The low cover wall at x 7.5..12.5, z 7.5..8.5, hit on its south face.
    const blast = (foeX: number, foeZ: number): number => {
      const { m, me, foe } = duel();
      place(me, 10, 20, 0);
      place(foe, foeX, foeZ, 0);
      const pitch = lookAt(0.7, 11.5);
      run(m, 0.1, () => ({ weapon: 3 }));
      run(m, WEAPONS.pike.equipTime + 0.4, () => ({ ads: true, pitch }));
      const events = run(m, 0.6, (t) => ({ ads: true, fire: t < 0.05, pitch }));
      expect(of(events, 'explode').length).toBe(1);
      return COMBAT.health - foe.health;
    };
    expect(blast(10, 6.9)).toBe(0);
    const open = blast(11.5, 9.3);
    expect(open).toBeGreaterThan(30);
    expect(open).toBeLessThan(PROJECTILES.pike.damage);
  });

  it('throws its pilot clear when destroyed, scores for the attacker and empties the meter', () => {
    const { m, me, foe, theirs } = duel();
    const kit = [...foe.loadout];
    stage(m, foe, 44, 46, Math.PI, true);
    theirs.health = 8;
    foe.meter = 0;
    const pitch = lookAt(2.4, 10.6);
    run(m, 0.4, () => ({ ads: true, pitch }));
    const events = run(m, 0.4, () => ({ ads: true, fire: true, pitch }));
    expect(of(events, 'mechDestroyed').length).toBe(1);
    expect(of(events, 'mechDestroyed')[0].attacker).toBe(me.id);
    expect(of(events, 'disembark')).toEqual([{ type: 'disembark', actor: foe.id, eject: true }]);
    expect(theirs.state).toBe('none');
    expect(foe.alive).toBe(true);
    expect(foe.inMech).toBe(false);
    expect(foe.health).toBe(COMBAT.health);
    expect(foe.loadout).toEqual(kit);
    expect(foe.p.pos.y).toBeGreaterThan(3);
    expect(foe.p.vel.y).toBeGreaterThan(R.embark.ejectUp - 8);
    expect(me.mechKills).toBe(1);
    expect(m.score).toEqual([R.destroyScore, 0]);
    // A new meter starts from nothing.
    expect(foe.meter).toBeLessThan(0.01);
    // The thrown pilot comes down alive.
    run(m, 4, () => ({ yaw: Math.PI }));
    expect(foe.alive).toBe(true);
    expect(foe.p.grounded).toBe(true);
  });
});

describe('bots and mechs', () => {
  it('a bot with a full meter calls its mech, climbs in and opens fire with it', () => {
    const m = createMatch(map, world, { seed: 5, teamSize: 1, startMeter: 1 });
    const [me, bot] = m.actors;
    me.meter = 0;
    me.health = 1e9;
    place(me, 44, 58, 0);
    place(bot, 44, -30, Math.PI);
    const seen: MatchEvent[] = [];
    let aboard = -1;
    let online = -1;
    for (let i = 0; i < 60 * 40 && online < 0; i++) {
      stepMatch(m, world, [emptyInput()], TICK_DT);
      seen.push(...m.events);
      if (aboard < 0 && bot.inMech) aboard = m.time;
      if (m.mechs[bot.id].state === 'piloted') online = m.time;
    }
    expect(of(seen, 'mechCall').length).toBe(1);
    expect(of(seen, 'mechCall')[0].actor).toBe(bot.id);
    // The call goes out at once and the bot is inside soon after the landing.
    expect(aboard).toBeGreaterThan(R.drop.time);
    expect(aboard).toBeLessThan(R.drop.time + 12);
    expect(online - aboard).toBeCloseTo(R.embark.time, 1);

    // Put the player in front of it.
    const k = m.mechs[bot.id];
    place(me, k.pos.x, k.pos.z + 22, 0);
    const fight: MatchEvent[] = [];
    for (let i = 0; i < 60 * 8; i++) {
      me.sinceDamage = 0;
      stepMatch(m, world, [{ ...emptyInput(), yaw: 0 }], TICK_DT);
      fight.push(...m.events);
    }
    expect(of(fight, 'shot').some((e) => e.actor === bot.id && e.weapon === 'autocannon')).toBe(true);
    expect(of(fight, 'launch').some((e) => e.actor === bot.id && e.kind === SALVO.projectile)).toBe(true);
    expect(of(fight, 'damage').some((e) => e.victim === me.id)).toBe(true);
  });

  it('bots on foot bring out the launcher against a mech and put it away afterwards', () => {
    const m = createMatch(map, world, { seed: 6, teamSize: 1 });
    const [me, bot] = m.actors;
    stage(m, me, 44, 56, 0, true);
    place(bot, 44, 26, Math.PI);
    m.mechs[me.id].health = 1e9;
    bot.health = 1e9;
    const events: MatchEvent[] = [];
    for (let i = 0; i < 60 * 8; i++) {
      stepMatch(m, world, [{ ...emptyInput(), yaw: 0 }], TICK_DT);
      events.push(...m.events);
    }
    expect(bot.loadout[bot.weapon]).toBe('pike');
    expect(of(events, 'launch').filter((e) => e.actor === bot.id && e.kind === 'pike').length).toBeGreaterThanOrEqual(2);
    expect(of(events, 'mechDamage').length).toBeGreaterThan(0);
    // It keeps its distance from the machine.
    expect(Math.hypot(bot.p.pos.x - m.mechs[me.id].pos.x, bot.p.pos.z - m.mechs[me.id].pos.z)).toBeGreaterThan(12);
  });
});

/**
 * A stand-in for a player who aims well: turns to the nearest enemy, holds the
 * trigger and the salvo button, and (when `moving`) strafes with a dash every
 * three seconds.
 */
function gunner(m: MatchState, me: Actor, t: number, eye: number, moving: boolean): InputCmd {
  let best: Actor | null = null;
  let bestD = Infinity;
  for (const o of m.actors) {
    if (o.team === me.team || !o.alive) continue;
    const d = Math.hypot(o.p.pos.x - me.p.pos.x, o.p.pos.z - me.p.pos.z);
    if (d < bestD) (bestD = d), (best = o);
  }
  const cmd = emptyInput();
  cmd.yaw = me.p.yaw;
  if (!best) return cmd;
  cmd.yaw = Math.atan2(-(best.p.pos.x - me.p.pos.x), -(best.p.pos.z - me.p.pos.z));
  cmd.pitch = Math.atan2(best.p.pos.y + (best.inMech ? 2.6 : 1.0) - (me.p.pos.y + eye), bestD);
  cmd.fire = true;
  cmd.ads = bestD > 10;
  if (moving) {
    cmd.moveX = Math.sin(t * 1.3) > 0 ? 1 : -1;
    cmd.jump = t % 3 < 0.05;
  }
  return cmd;
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

describe('mech frames', () => {
  const BASTION = FRAMES.bastion;
  const SHIELD = BASTION.ability as ShieldAbility;
  const STOMP = BASTION.mobility as StompMove;
  const LYNX = FRAMES.lynx;
  const LEAP = LYNX.mobility as LeapMove;
  const CLOAK = LYNX.ability as CloakAbility;
  const bastion = frameIndex('bastion');
  const lynx = frameIndex('lynx');
  const sum = (events: { amount: number }[]): number => events.reduce((t, e) => t + e.amount, 0);
  const speed = (k: Mech): number => Math.hypot(k.vel.x, k.vel.z);

  it('calls down the frame the pilot picked, with its own hull, weapon and size', () => {
    for (const F of FRAME_LIST) {
      const { m, me, mine } = duel();
      me.meter = 1;
      const call = of(run(m, 0.05, () => ({ call: true, frame: frameIndex(F.id), pitch: lookAt(0, 20) })), 'mechCall');
      expect(call[0].frame).toBe(frameIndex(F.id));
      run(m, R.drop.time + 0.1);
      expect(mine.state).toBe('idle');
      expect(frameOf(mine)).toBe(F);
      expect(mine.health).toBe(F.health);
      place(me, mine.pos.x, mine.pos.z + 3, 0);
      run(m, 0.05, () => ({ use: true }));
      expect(me.loadout).toEqual(F.loadout);
      expect(me.inMech).toBe(true);
    }
    // Every frame fits where the map checks and the mech nav grid say a mech fits.
    for (const F of FRAME_LIST) {
      expect(F.body.radius).toBeLessThanOrEqual(B.radius);
      expect(F.body.height).toBeLessThanOrEqual(B.height);
    }
  });

  it('bots call the frame their role is built around', () => {
    const m = createMatch(map, world, { seed: 3, humans: 0, startMeter: 1, scoreLimit: 9999 });
    const calls = new Map<number, number>();
    for (let i = 0; i < 60 * 8; i++) {
      stepMatch(m, world, [], TICK_DT);
      for (const e of m.events) if (e.type === 'mechCall') calls.set(e.actor, e.frame);
    }
    expect(calls.size).toBeGreaterThan(5);
    for (const [id, frame] of calls) expect(FRAME_LIST[frame].id).toBe(BOT_ROLES[m.actors[id].brain!.role].frame);
    expect(new Set(calls.values()).size).toBe(3);
  });

  it('the Bastion holds up a shield that stops fire from the front, and cannot fire through it', () => {
    const { m, me, foe, mine } = duel();
    stage(m, me, 44, 46, 0, true, bastion);
    // The enemy pilot 26 m ahead aims the carbine at the hull.
    const pitch = lookAt(2.4, 26);
    const shoot = (): Partial<InputCmd> => ({ ads: true, fire: true, pitch });
    run(m, 0.3, () => ({ ads: true }), () => ({ ads: true, pitch }));
    expect(mine.shieldUp).toBe(true);
    const front = run(m, 1, () => ({ ads: true, fire: true }), shoot);
    expect(of(front, 'shot').filter((e) => e.actor === me.id).length).toBe(0);
    expect(of(front, 'mechDamage').length).toBe(0);
    const blocked = of(front, 'shieldHit');
    expect(blocked.length).toBeGreaterThan(5);
    expect(mine.health).toBe(BASTION.health);
    expect(mine.shield).toBeLessThan(SHIELD.health - sum(blocked) - SHIELD.drain);
    // Lowered, the hull takes the rounds and the cannon answers.
    const open = run(m, 0.6, () => ({ fire: true }), shoot);
    expect(of(open, 'mechDamage').length).toBeGreaterThan(3);
    expect(of(open, 'shot').filter((e) => e.actor === me.id).length).toBeGreaterThan(0);
    // Facing away, it covers nothing behind it.
    const back = run(m, 1, () => ({ ads: true, yaw: Math.PI }), shoot);
    expect(of(back, 'shieldHit').length).toBe(0);
    expect(of(back, 'mechDamage').length).toBeGreaterThan(5);
    expect(foe.alive).toBe(true);
  });

  it('the shield covers an ally standing behind it, slows the mech to a walk and breaks under fire', () => {
    const m = createMatch(map, world, { seed: 2, teamSize: 2 });
    const [me, ally, foe] = m.actors;
    for (const a of m.actors) a.brain = null;
    const mine = stage(m, me, 44, 46, 0, true, bastion);
    place(ally, 44, 49, 0);
    place(foe, 44, 20, Math.PI);
    place(m.actors[3], 10, 70, 0);
    ally.protect = foe.protect = 0;
    const step = (seconds: number, mine: Partial<InputCmd>, theirs: Partial<InputCmd>): MatchEvent[] => {
      const events: MatchEvent[] = [];
      for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
        const cmds = m.actors.map((a, n) => ({ ...emptyInput(), yaw: a.p.yaw, pitch: a.p.pitch, ...(n === 0 ? mine : n === 2 ? theirs : {}) }));
        stepMatch(m, world, cmds, TICK_DT);
        events.push(...m.events);
      }
      return events;
    };
    // The foe aims at the ally's chest, right through where the shield stands.
    const atAlly = { ads: true, fire: true, pitch: lookAt(1.2, 29) };
    step(0.3, { ads: true }, { ads: true, pitch: atAlly.pitch });
    const covered = step(1, { ads: true }, atAlly);
    expect(of(covered, 'shieldHit').length).toBeGreaterThan(5);
    expect(ally.health).toBe(COMBAT.health);

    // Behind the shield the mech walks, at best.
    step(2, { ads: true, moveZ: 1, sprint: true }, {});
    expect(speed(mine)).toBeCloseTo(BASTION.move.walkSpeed * SHIELD.slow, 1);

    // Poured on, it breaks, and stays down for a while however hard the button is held.
    mine.shield = 40;
    let broke = false;
    for (let t = 0; t < 1 && !broke; t += TICK_DT) {
      broke = step(TICK_DT, { ads: true }, { ads: true, fire: true, pitch: lookAt(2.4, 20) }).some((e) => e.type === 'mechAbility' && e.what === 'shieldBreak');
    }
    expect(broke).toBe(true);
    expect(mine.shieldUp).toBe(false);
    step(SHIELD.brokenTime - 0.1, { ads: true }, {});
    expect(mine.shieldUp).toBe(false);
    step(0.2, { ads: true }, {});
    expect(mine.shieldUp).toBe(true);
  });

  it('the Lynx rail goes straight through a shield', () => {
    const { m, me, foe, mine } = duel();
    stage(m, me, 44, 46, 0, true, bastion);
    stage(m, foe, 44, 20, Math.PI, true, lynx);
    const pitch = lookAt(2.4, 26, LYNX.body.eye);
    run(m, 0.3, () => ({ ads: true }));
    const events = run(m, 2, () => ({ ads: true }), (t) => ({ fire: t % 1.05 < 0.05, pitch }));
    expect(mine.shieldUp).toBe(true);
    expect(of(events, 'shieldHit').length).toBe(0);
    const hits = of(events, 'mechDamage');
    expect(hits.length).toBe(2);
    expect(hits[0].amount).toBeCloseTo(WEAPONS.lance.armor * foe.damageScale, 5);
    expect(mine.health).toBeCloseTo(BASTION.health - sum(hits), 5);
  });

  it('the Bastion stomps: pilots close by are hurt and thrown off, once per charge', () => {
    const { m, me, foe, mine } = duel();
    stage(m, me, 44, 46, 0, true, bastion);
    place(foe, 44, 41, Math.PI);
    const first = run(m, 0.05, () => ({ jump: true }));
    expect(first.filter((e) => e.type === 'mechAbility' && e.what === 'stomp').length).toBe(1);
    const hurt = of(first, 'damage');
    expect(hurt.length).toBe(1);
    expect(hurt[0].amount).toBeCloseTo(STOMP.damage * (1 - 0.5 * (5 / STOMP.radius)), 0);
    // Thrown away from the mech (toward -Z) and up.
    expect(foe.p.vel.z).toBeLessThan(-STOMP.knock * 0.9);
    expect(foe.p.vel.y).toBeGreaterThan(0);
    expect(mine.charges).toBeLessThan(0.1);
    // Held down it does nothing more, and a new press needs the charge back.
    expect(run(m, 1, () => ({ jump: true })).filter((e) => e.type === 'mechAbility').length).toBe(0);
    run(m, 0.1);
    expect(run(m, 0.05, () => ({ jump: true })).filter((e) => e.type === 'mechAbility').length).toBe(0);
    run(m, STOMP.rechargeTime);
    // Out of reach, the next one hurts nobody.
    place(foe, 44, 46 - STOMP.radius - 2, Math.PI);
    const far = run(m, 0.05, () => ({ jump: true }));
    expect(far.filter((e) => e.type === 'mechAbility' && e.what === 'stomp').length).toBe(1);
    expect(of(far, 'damage').length).toBe(0);
  });

  it('the Lynx leaps on its jump jets, two charges at a time', () => {
    const { m, me, mine } = duel();
    stage(m, me, 44, 54, 0, true, lynx);
    const y0 = mine.pos.y;
    const events = run(m, 0.05, () => ({ jump: true, moveZ: 1 }));
    expect(events.filter((e) => e.type === 'mechAbility' && e.what === 'leap').length).toBe(1);
    expect(mine.charges).toBeCloseTo(LEAP.charges - 1, 1);
    let top = y0;
    let t = 0;
    while ((!mine.grounded || t < 0.2) && t < 3) {
      run(m, TICK_DT, () => ({ moveZ: 1 }));
      top = Math.max(top, mine.pos.y);
      t += TICK_DT;
    }
    // Straight up it rises up^2 / 2g; it covers ground the whole way.
    expect(top - y0).toBeCloseTo((LEAP.up * LEAP.up) / (2 * LYNX.move.gravity), 0);
    expect(mine.pos.z).toBeLessThan(54 - LEAP.forward * 0.8);
    expect(mine.grounded).toBe(true);
    // The second charge is there at once; a third is not.
    expect(run(m, 0.05, () => ({ jump: true })).filter((e) => e.type === 'mechAbility').length).toBe(1);
    run(m, 1.5);
    expect(run(m, 0.05, () => ({ jump: true })).filter((e) => e.type === 'mechAbility').length).toBe(0);
  });

  it('the Lynx cloaks: bots lose it past close range, and firing ends it', () => {
    const { m, me, foe, mine } = duel();
    stage(m, me, 44, 58, 0, true, lynx);
    expect(canSee(m, world, foe, me, true)).toBe(true);
    const on = run(m, 0.05, () => ({ ads: true }));
    expect(on.some((e) => e.type === 'mechAbility' && e.what === 'cloakOn')).toBe(true);
    expect(mine.cloak).toBeGreaterThan(CLOAK.time - 0.1);
    expect(canSee(m, world, foe, me, true)).toBe(false);
    place(foe, 44, 58 - CLOAK.revealRange + 2, Math.PI);
    expect(canSee(m, world, foe, me, true)).toBe(true);
    // A shot gives it away, and it needs its cooldown before it works again.
    const off = run(m, 0.05, () => ({ fire: true, ads: true }));
    expect(off.some((e) => e.type === 'mechAbility' && e.what === 'cloakOff')).toBe(true);
    expect(mine.cloak).toBe(0);
    expect(run(m, CLOAK.cooldown - 0.5, () => ({ ads: true })).some((e) => e.type === 'mechAbility' && e.what === 'cloakOn')).toBe(false);
    expect(run(m, 0.6, () => ({ ads: true })).some((e) => e.type === 'mechAbility' && e.what === 'cloakOn')).toBe(true);
    // Left alone it runs out by itself.
    const out = run(m, CLOAK.time + 0.1);
    expect(out.some((e) => e.type === 'mechAbility' && e.what === 'cloakOff')).toBe(true);
  });

  it('Bastion flak bursts beside a pilot or a mech it would fly past', () => {
    const flak = PROJECTILES[WEAPONS.breaker.projectile!];
    const { m, me, foe, theirs } = duel();
    stage(m, me, 44, 46, 0, true, bastion);
    // The pilot stands 1.2 m to the side of where the shells go.
    place(foe, 45.2, 30, Math.PI);
    const pitch = lookAt(1.0, 16, BASTION.body.eye);
    const near = run(m, 0.6, (t) => ({ fire: t < 0.05, pitch }));
    const hurt = of(near, 'damage');
    expect(hurt.length).toBe(1);
    expect(hurt[0].amount).toBeGreaterThan(flak.damage * 0.4);
    expect(hurt[0].amount).toBeLessThan(flak.damage);

    // A mech 1 m clear of the line takes the blast, not a direct hit.
    place(foe, 10, 70, 0);
    stage(m, foe, 44 + FRAMES.halberd.body.radius + 1, 30, Math.PI, true);
    run(m, 1);
    const graze = of(run(m, 0.6, (t) => ({ fire: t < 0.05, pitch: lookAt(2.4, 16, BASTION.body.eye) })), 'mechDamage');
    expect(graze.length).toBe(1);
    expect(graze[0].amount).toBeGreaterThan(0);
    expect(graze[0].amount).toBeLessThan(flak.armor * flak.splashArmor);
    expect(theirs.health).toBeLessThan(FRAMES.halberd.health);
  });
});

describe('mech balance, played by scripts over several seeds', () => {
  it('a mech is worth several pilots against a full team on foot, and moving it is worth more', () => {
    const play = (moving: boolean): { life: number; kills: number } => {
      const lives: number[] = [];
      const kills: number[] = [];
      // Eighteen seeds: with solid bodies one touch changes the rest of a match, so six were too few to tell.
      for (const seed of Array.from({ length: 18 }, (_, n) => 31 + n)) {
        const m = createMatch(map, world, { seed });
        const me = m.actors[0];
        for (const a of m.actors) if (a.brain && a.team === 0) a.brain = null;
        const foes = m.actors.filter((a) => a.team === 1);
        stage(m, me, 40, 58, 0, true);
        foes.forEach((f, i) => place(f, 31 + i * 6, 30, Math.PI));
        let t = 0;
        while (me.inMech && t < 120) {
          stepMatch(m, world, [gunner(m, me, t, B.eye, moving)], TICK_DT);
          t += TICK_DT;
        }
        lives.push(t);
        kills.push(me.kills);
      }
      return { life: mean(lives), kills: mean(kills) };
    };
    const standing = play(false);
    const moving = play(true);
    console.log(`mech vs four pilots: standing ${standing.life.toFixed(0)} s, ${standing.kills.toFixed(1)} kills; moving ${moving.life.toFixed(0)} s, ${moving.kills.toFixed(1)} kills`);
    // Standing in the open against four launchers, the hull lasts about half a
    // minute and takes a handful of pilots with it. (Measured: 32 s, 6.2 kills.)
    expect(standing.life).toBeGreaterThan(15);
    expect(standing.life).toBeLessThan(60);
    expect(standing.kills).toBeGreaterThan(3);
    // Strafing and dashing makes rockets miss: clearly longer, and more kills,
    // but never safe. (Measured: 41 s, 6.3 kills.)
    expect(moving.life).toBeGreaterThan(standing.life * 1.2);
    expect(moving.life).toBeLessThan(110);
    expect(moving.kills).toBeGreaterThan(standing.kills);
  }, 120_000);

  it('a pilot caught in the open by a mech dies fast, and running buys time', () => {
    const survive = (moving: boolean): number => {
      const lives: number[] = [];
      for (const seed of [41, 42, 43, 44, 45, 46]) {
        const m = createMatch(map, world, { seed, teamSize: 1 });
        const [me, bot] = m.actors;
        place(me, 40, 58, 0);
        stage(m, bot, 40, 34, Math.PI, true);
        me.protect = 0;
        let t = 0;
        while (me.alive && t < 60) {
          const cmd = { ...emptyInput(), yaw: moving ? t * 1.2 : 0, moveZ: moving ? 1 : 0, sprint: moving, jump: moving && t % 1 < 0.1 };
          stepMatch(m, world, [cmd], TICK_DT);
          t += TICK_DT;
        }
        lives.push(t);
      }
      return mean(lives);
    };
    const standing = survive(false);
    const moving = survive(true);
    console.log(`pilot vs bot mech: standing ${standing.toFixed(1)} s, moving ${moving.toFixed(1)} s`);
    // The bot needs its reaction time first, so it is never instant. (Measured: 2.0 s.)
    expect(standing).toBeGreaterThan(0.8);
    expect(standing).toBeLessThan(5);
    // (Measured: 7.7 s.)
    expect(moving).toBeGreaterThan(standing * 2);
  });

  it('one pilot with the launcher can bring a mech down, at a price', () => {
    const times: number[] = [];
    let deaths = 0;
    for (const seed of [51, 52, 53, 54, 55, 56]) {
      const m = createMatch(map, world, { seed, teamSize: 1 });
      const [me, bot] = m.actors;
      place(me, 40, 58, 0);
      const k = stage(m, bot, 40, 30, Math.PI, true);
      me.protect = 0;
      let t = 0;
      while (bot.inMech && t < 120) {
        const cmd = gunner(m, me, t, 1.62, true);
        cmd.weapon = 3;
        cmd.sprint = true;
        // The launcher is semi-automatic: tap the trigger.
        cmd.fire = Math.floor(t * 20) % 2 === 0;
        const alive = me.alive;
        stepMatch(m, world, [cmd], TICK_DT);
        if (alive && !me.alive) deaths++;
        t += TICK_DT;
      }
      expect(k.state).toBe('none');
      times.push(t);
    }
    console.log(`launcher pilot vs bot mech: ${mean(times).toFixed(0)} s, ${deaths} deaths over 6 fights`);
    // Seven or eight rockets from the front, with a reload every two.
    // (Measured: 35 s on average, and 7 deaths over the 6 fights.)
    expect(mean(times)).toBeGreaterThan(15);
    expect(mean(times)).toBeLessThan(70);
    expect(deaths).toBeGreaterThanOrEqual(2);
    expect(deaths).toBeLessThan(18);
  });

  it('two bot mechs settle a duel in well under a minute, and it is close', () => {
    const times: number[] = [];
    const left: number[] = [];
    for (const seed of [61, 62, 63, 64, 65, 66]) {
      const m = createMatch(map, world, { seed, teamSize: 1, humans: 0 });
      const [a, b] = m.actors;
      stage(m, a, 40, 58, 0, true);
      stage(m, b, 40, 30, Math.PI, true);
      let t = 0;
      while (a.inMech && b.inMech && t < 120) {
        stepMatch(m, world, [], TICK_DT);
        t += TICK_DT;
      }
      times.push(t);
      left.push(Math.max(m.mechs[0].health, m.mechs[1].health) / MECH.health);
    }
    console.log(`bot mech duel: ${mean(times).toFixed(0)} s, winner keeps ${(mean(left) * 100).toFixed(0)}% hull`);
    // (Measured: 34 s, with the winner keeping 10% of its hull.)
    expect(mean(times)).toBeGreaterThan(12);
    expect(mean(times)).toBeLessThan(55);
    expect(mean(left)).toBeLessThan(0.5);
  });
  it('the three frames are an even match for each other, bot against bot', () => {
    const seeds = Array.from({ length: 40 }, (_, n) => 100 + n);
    for (let i = 0; i < FRAME_LIST.length; i++) {
      for (let j = i + 1; j < FRAME_LIST.length; j++) {
        let first = 0;
        let second = 0;
        for (const seed of seeds) {
          const m = createMatch(map, world, { seed, teamSize: 1, humans: 0 });
          const [a, b] = m.actors;
          // Each side starts from each end of the floor half the time.
          const flip = seed % 2 === 0;
          stage(m, a, 40, flip ? 30 : 58, flip ? Math.PI : 0, true, i);
          stage(m, b, 40, flip ? 58 : 30, flip ? 0 : Math.PI, true, j);
          let t = 0;
          while (a.inMech && b.inMech && t < 120) {
            stepMatch(m, world, [], TICK_DT);
            t += TICK_DT;
          }
          if (a.inMech && !b.inMech) first++;
          else if (b.inMech && !a.inMech) second++;
        }
        console.log(`${FRAME_LIST[i].name} against ${FRAME_LIST[j].name}: ${first} to ${second} over ${seeds.length} duels`);
        // No frame beats another in more than two duels out of three.
        // (Measured: Halberd 17 to Bastion 23, Halberd 21 to Lynx 19, Bastion 24 to Lynx 16.)
        expect(first + second).toBeGreaterThan(seeds.length * 0.9);
        expect(Math.max(first, second)).toBeLessThanOrEqual(seeds.length * 0.65);
      }
    }
  }, 120_000);

  it('every frame is worth taking against a team on foot', () => {
    const lives: number[] = [];
    for (let f = 0; f < FRAME_LIST.length; f++) {
      const life: number[] = [];
      const kills: number[] = [];
      for (const seed of Array.from({ length: 16 }, (_, n) => 300 + n)) {
        const m = createMatch(map, world, { seed, humans: 0 });
        const me = m.actors[0];
        // Its own team sits this one out; the four enemy bots fight on foot.
        for (const a of m.actors) {
          if (a.team !== 0 || a === me) continue;
          a.alive = false;
          a.respawnIn = 1e9;
        }
        const foes = m.actors.filter((a) => a.team === 1);
        stage(m, me, 40, 58, 0, true, f);
        foes.forEach((o, i) => place(o, 31 + i * 6, 30, Math.PI));
        let t = 0;
        while (me.inMech && t < 120) {
          for (const o of foes) o.meter = 0;
          stepMatch(m, world, [], TICK_DT);
          t += TICK_DT;
        }
        life.push(t);
        kills.push(me.kills);
      }
      console.log(`bot ${FRAME_LIST[f].name} against four pilots: ${mean(life).toFixed(0)} s, ${mean(kills).toFixed(1)} kills`);
      // (Measured: Halberd 13 s and 1.8 kills, Bastion 12 s and 1.4, Lynx 18 s and 2.3.)
      expect(mean(life)).toBeGreaterThan(8);
      expect(mean(life)).toBeLessThan(30);
      expect(mean(kills)).toBeGreaterThan(0.8);
      lives.push(mean(life));
    }
    expect(Math.max(...lives) / Math.min(...lives)).toBeLessThan(2);
  }, 60_000);
});

describe('whole matches with mechs, bots only', () => {
  const digest = (m: MatchState): string =>
    JSON.stringify([m.score, m.actors.map((a) => [a.p.pos, a.health, a.meter, a.inMech, a.ammo]), m.mechs.map((k) => [k.state, k.pos, k.health, k.ammo]), m.projectiles]);

  it('replays exactly from the same seed, mechs and rockets included', () => {
    let landings = 0;
    const play = (seed: number): MatchState => {
      landings = 0;
      const m = createMatch(map, world, { seed, humans: 0, scoreLimit: 9999, startMeter: 0.7 });
      for (let i = 0; i < 60 * 90; i++) {
        stepMatch(m, world, [], TICK_DT);
        landings += m.events.filter((e) => e.type === 'mechLand').length;
      }
      return m;
    };
    const a = play(71);
    // Mechs came down during the run, so the replay covers them and their rockets.
    expect(landings).toBeGreaterThan(0);
    expect(digest(a)).toBe(digest(play(71)));
    expect(digest(a)).not.toBe(digest(play(72)));
  });

  it('every bot gets a mech in time, uses it, and none is left standing around', () => {
    const minutes = 4;
    const share: number[] = [];
    const lives: number[] = [];
    const waits: number[] = [];
    let calls = 0;
    let boarded = 0;
    let denied = 0;
    for (const seed of [81, 82, 83, 84, 85, 86]) {
      const m = createMatch(map, world, { seed, humans: 0, scoreLimit: 9999 });
      const landed = new Map<number, number>();
      const aboard = new Map<number, number>();
      let inMech = 0;
      let firstCall = -1;
      for (let i = 0; i < minutes * 3600; i++) {
        stepMatch(m, world, [], TICK_DT);
        for (const a of m.actors) {
          if (!a.inMech) continue;
          inMech += TICK_DT;
          // The pilot rides at the mech's position.
          expect(a.p.pos).toEqual(m.mechs[a.id].pos);
        }
        for (const k of m.mechs) expect(Number.isFinite(k.pos.x + k.pos.y + k.pos.z + k.health)).toBe(true);
        for (const e of m.events) {
          if (e.type === 'mechCall') {
            calls++;
            if (firstCall < 0) firstCall = m.time;
          } else if (e.type === 'callDenied') denied++;
          else if (e.type === 'mechLand') landed.set(e.mech, m.time);
          else if (e.type === 'embark') {
            boarded++;
            aboard.set(e.actor, m.time);
            waits.push(m.time - landed.get(e.actor)!);
          } else if (e.type === 'mechDestroyed' && aboard.has(e.mech)) lives.push(m.time - aboard.get(e.mech)!);
        }
      }
      // The first mech arrives about a minute in: after the opening fights, long before the end.
      expect(firstCall).toBeGreaterThan(30);
      expect(firstCall).toBeLessThan(100);
      share.push(inMech / (minutes * 60 * m.actors.length));
    }
    console.log(`mech matches: ${calls} calls, ${boarded} boarded, ${denied} denied, wait ${mean(waits).toFixed(1)} s, life ${mean(lives).toFixed(1)} s, share ${(mean(share) * 100).toFixed(0)}%`);
    // About two mechs per bot in four minutes, over 6 matches of 8 bots.
    expect(calls).toBeGreaterThan(48);
    expect(calls).toBeLessThan(120);
    // A bot finds a place to land when it asks, and nearly every mech gets its pilot.
    expect(denied).toBeLessThan(calls * 0.2);
    expect(boarded).toBeGreaterThan(calls * 0.85);
    expect(mean(waits)).toBeLessThan(12);
    // A mech is a phase of the match, not the whole of it.
    expect(mean(lives)).toBeGreaterThan(18);
    expect(mean(lives)).toBeLessThan(70);
    expect(mean(share)).toBeGreaterThan(0.1);
    expect(mean(share)).toBeLessThan(0.45);
  }, 180_000);
});
