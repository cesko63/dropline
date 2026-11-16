import { beforeAll, describe, expect, it } from 'vitest';
import gym from '../../../data/maps/gym.json';
import {
  COMBAT,
  CollisionWorld,
  MECH,
  PROJECTILES,
  TICK_DT,
  WEAPONS,
  createMatch,
  emptyInput,
  enterMech,
  resetMech,
  stepMatch,
  v3,
  type Actor,
  type InputCmd,
  type MapData,
  type MatchEvent,
  type MatchState,
  type Mech,
} from '../src';

const map = gym as MapData;
const R = COMBAT.mech;
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

const of = <T extends MatchEvent['type']>(events: MatchEvent[], type: T): Extract<MatchEvent, { type: T }>[] =>
  events.filter((e): e is Extract<MatchEvent, { type: T }> => e.type === type);

/** Stand a mech at a place without the call-in: empty, or with its owner already at the controls. */
function stage(m: MatchState, a: Actor, x: number, z: number, yaw: number, piloted: boolean): Mech {
  const k = m.mechs[a.id];
  resetMech(k, v3(x, 0.02, z), yaw);
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
    const first = run(m, MECH.dash.time + 0.3, (t) => ({ jump: t < 0.05 }));
    expect(of(first, 'mechDash').length).toBe(1);
    // Standing still it goes where it faces: north, by more than a second of walking.
    const reach = 40 - mine.pos.z;
    expect(reach).toBeGreaterThan(5.5);
    expect(reach).toBeLessThan(9);
    expect(Math.abs(mine.pos.x - 44)).toBeLessThan(0.01);
    expect(mine.dashCharges).toBeLessThan(MECH.dash.charges - 0.8);

    // The second charge goes sideways with the stick; then there is none left.
    const x0 = mine.pos.x;
    const second = run(m, MECH.dash.time + 0.3, (t) => ({ jump: t < 0.05, moveX: 1 }));
    expect(of(second, 'mechDash').length).toBe(1);
    expect(mine.pos.x - x0).toBeGreaterThan(5.5);
    const none = run(m, 0.5, (t) => ({ jump: t < 0.05 }));
    expect(of(none, 'mechDash').length).toBe(0);
    // Holding the key does not dash again by itself once a charge is back.
    const held = run(m, MECH.dash.rechargeTime, () => ({ jump: true }));
    expect(of(held, 'mechDash').length).toBe(0);
    const again = run(m, 0.3, (t) => ({ jump: t >= 0.1 && t < 0.15 }));
    expect(of(again, 'mechDash').length).toBe(1);
  });

  it('rams a pilot in its path once per dash and throws them aside', () => {
    const { m, me, foe } = duel();
    stage(m, me, 44, 40, 0, true);
    place(foe, 44, 35.5, Math.PI);
    const events = run(m, MECH.dash.time + 0.1, (t) => ({ jump: t < 0.05 }));
    expect(of(events, 'ram')).toEqual([{ type: 'ram', mech: 0, victim: foe.id, other: -1 }]);
    expect(foe.health).toBe(COMBAT.health - MECH.dash.ramDamage);
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
    const S = MECH.salvo;
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
    expect(of(fight, 'launch').some((e) => e.actor === bot.id && e.kind === MECH.salvo.projectile)).toBe(true);
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

describe('mech balance, played by scripts over several seeds', () => {
  it('a mech is worth several pilots against a full team on foot, and moving it is worth more', () => {
    const play = (moving: boolean): { life: number; kills: number } => {
      const lives: number[] = [];
      const kills: number[] = [];
      for (const seed of [31, 32, 33, 34, 35, 36]) {
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
    // minute and takes a handful of pilots with it. (Measured: 30 s, 5.7 kills.)
    expect(standing.life).toBeGreaterThan(15);
    expect(standing.life).toBeLessThan(60);
    expect(standing.kills).toBeGreaterThan(3);
    // Strafing and dashing makes rockets miss: clearly longer, and more kills,
    // but never safe. (Measured: 52 s, 7.8 kills.)
    expect(moving.life).toBeGreaterThan(standing.life * 1.25);
    expect(moving.life).toBeLessThan(110);
    expect(moving.kills).toBeGreaterThan(standing.kills);
  });

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
});

describe('whole matches with mechs, bots only', () => {
  const digest = (m: MatchState): string =>
    JSON.stringify([m.score, m.actors.map((a) => [a.p.pos, a.health, a.meter, a.inMech, a.ammo]), m.mechs.map((k) => [k.state, k.pos, k.health, k.ammo]), m.projectiles]);

  it('replays exactly from the same seed, mechs and rockets included', () => {
    const play = (seed: number): MatchState => {
      const m = createMatch(map, world, { seed, humans: 0, scoreLimit: 9999, startMeter: 0.7 });
      for (let i = 0; i < 60 * 90; i++) stepMatch(m, world, [], TICK_DT);
      return m;
    };
    const a = play(71);
    expect(a.mechs.some((k) => k.state !== 'none')).toBe(true);
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
