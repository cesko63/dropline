import { beforeAll, describe, expect, it } from 'vitest';
import gym from '../../../data/maps/gym.json';
import {
  BOTS,
  BOT_ROLES,
  COMBAT,
  Link,
  CollisionWorld,
  TICK_DT,
  WEAPONS,
  canSee,
  createMatch,
  damageFalloff,
  emptyInput,
  PATH_STRIDE,
  findPath,
  isWalkable,
  rayPilot,
  spreadDeg,
  stepMatch,
  v3,
  walkableLine,
  weaponOf,
  type Actor,
  type InputCmd,
  type MapData,
  type MatchEvent,
  type MatchState,
} from '../src';

const map = gym as MapData;
let world: CollisionWorld;

beforeAll(async () => {
  world = await CollisionWorld.create(map);
});

/** A match with one human (actor 0) and one enemy bot (actor 1) that is switched off. */
function duel(seed = 1): { m: MatchState; me: Actor; foe: Actor } {
  const m = createMatch(map, world, { seed, teamSize: 1 });
  const [me, foe] = m.actors;
  foe.brain = null;
  place(me, 0, 50, 0);
  place(foe, 0, 40, Math.PI);
  me.protect = foe.protect = 0;
  return { m, me, foe };
}

/** Put an actor on open floor south of the duct, where nothing blocks the view. */
function place(a: Actor, x: number, z: number, yaw: number): void {
  a.p.pos.x = x;
  a.p.pos.y = 0.02;
  a.p.pos.z = z;
  a.p.yaw = yaw;
  a.p.vel.x = a.p.vel.y = a.p.vel.z = 0;
}

/** Step for `seconds`; actor 0 uses `input`. Returns every event raised. */
function run(m: MatchState, seconds: number, input: (t: number) => Partial<InputCmd> = () => ({})): MatchEvent[] {
  const events: MatchEvent[] = [];
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    const me = m.actors[0];
    stepMatch(m, world, [{ ...emptyInput(), yaw: me.p.yaw, pitch: me.p.pitch, ...input(i * TICK_DT) }], TICK_DT);
    events.push(...m.events);
  }
  return events;
}

const shots = (events: MatchEvent[], actor = 0): number => events.filter((e) => e.type === 'shot' && e.actor === actor).length;

describe('hitscan', () => {
  const feet = v3(0, 0, -10);
  const eye = v3(0, 1.62, 0);
  const at = (x: number, y: number): ReturnType<typeof v3> => {
    const d = v3(x, y - eye.y, -10);
    const l = Math.hypot(d.x, d.y, d.z);
    return v3(d.x / l, d.y / l, d.z / l);
  };

  it('hits the body, the head, and nothing beside or above the pilot', () => {
    const body = rayPilot(eye, at(0, 1.0), feet, 1.8, 100);
    expect(body && !body.head).toBe(true);
    expect(body!.t).toBeGreaterThan(9.5);
    expect(body!.t).toBeLessThan(10);
    expect(rayPilot(eye, at(0, 1.66), feet, 1.8, 100)?.head).toBe(true);
    expect(rayPilot(eye, at(0.6, 1.0), feet, 1.8, 100)).toBeNull();
    expect(rayPilot(eye, at(0, 2.0), feet, 1.8, 100)).toBeNull();
  });

  it('gives a crouched pilot a lower head', () => {
    // Head height while standing is empty air above a crouched pilot.
    expect(rayPilot(eye, at(0, 1.66), feet, 1.0, 100)).toBeNull();
    expect(rayPilot(eye, at(0, 0.86), feet, 1.0, 100)?.head).toBe(true);
  });

  it('stops at the given distance', () => {
    expect(rayPilot(eye, at(0, 1.0), feet, 1.8, 5)).toBeNull();
  });

  it('applies damage falloff between the two distances', () => {
    const w = WEAPONS.carbine;
    expect(damageFalloff(w, w.falloffStart - 1)).toBe(1);
    expect(damageFalloff(w, w.falloffEnd + 1)).toBe(w.falloffMin);
    expect(damageFalloff(w, (w.falloffStart + w.falloffEnd) / 2)).toBeCloseTo((1 + w.falloffMin) / 2, 5);
  });
});

describe('weapons', () => {
  it('fires the carbine at its rate of fire', () => {
    const { m } = duel();
    m.actors[0].p.yaw = Math.PI; // face away so nothing dies
    const n = shots(run(m, 2, () => ({ fire: true, yaw: Math.PI })));
    // 660 rpm is 11 a second; the first shot is immediate.
    expect(n).toBeGreaterThanOrEqual(22);
    expect(n).toBeLessThanOrEqual(23);
  });

  it('empties the magazine, reloads on its own, then fires again', () => {
    const { m, me } = duel();
    const def = WEAPONS.carbine;
    const empty = (def.magSize * 60) / def.rpm;
    const events = run(m, empty + 0.2, () => ({ fire: true, yaw: Math.PI }));
    expect(shots(events)).toBe(def.magSize);
    expect(events.some((e) => e.type === 'reload')).toBe(true);
    expect(me.reload).toBeGreaterThan(0);
    const later = run(m, def.reloadTime + 0.2, () => ({ fire: true, yaw: Math.PI }));
    expect(later.some((e) => e.type === 'reloaded')).toBe(true);
    expect(shots(later)).toBeGreaterThan(0);
    expect(me.ammo[0]).toBeLessThan(def.magSize);
  });

  it('needs a press per shot on a semi-automatic weapon', () => {
    const { m, me } = duel();
    run(m, 0.1, () => ({ weapon: 2, yaw: Math.PI }));
    run(m, WEAPONS.longshot.equipTime + 0.1, () => ({ yaw: Math.PI }));
    expect(weaponOf(me).id).toBe('longshot');
    expect(shots(run(m, 2, () => ({ fire: true, yaw: Math.PI })))).toBe(1);
    run(m, 0.1, () => ({ yaw: Math.PI }));
    expect(shots(run(m, 1, () => ({ fire: true, yaw: Math.PI })))).toBe(1);
  });

  it('cannot fire while drawing a weapon', () => {
    const { m } = duel();
    const events = run(m, WEAPONS.scattergun.equipTime - 0.05, () => ({ weapon: 1, fire: true, yaw: Math.PI }));
    expect(events.some((e) => e.type === 'equip')).toBe(true);
    expect(shots(events)).toBe(0);
  });

  it('fires one ray per pellet', () => {
    const { m } = duel();
    run(m, WEAPONS.scattergun.equipTime + 0.1, () => ({ weapon: 1, yaw: Math.PI }));
    const shot = run(m, 0.1, () => ({ fire: true, yaw: Math.PI })).find((e) => e.type === 'shot');
    expect(shot && shot.type === 'shot' && shot.traces.length).toBe(WEAPONS.scattergun.pellets);
  });

  it('spreads more when firing, moving and in the air, and less when aimed', () => {
    const { m, me } = duel();
    run(m, 0.2);
    const hip = spreadDeg(me);
    expect(hip).toBeCloseTo(WEAPONS.carbine.spread.hipDeg, 5);
    run(m, 0.5, () => ({ ads: true }));
    expect(me.ads).toBe(1);
    expect(spreadDeg(me)).toBeCloseTo(WEAPONS.carbine.spread.adsDeg, 5);
    run(m, 0.5);
    run(m, 0.3, () => ({ fire: true, yaw: Math.PI }));
    expect(spreadDeg(me)).toBeGreaterThan(hip + 0.5);
    run(m, 1.5, () => ({ yaw: Math.PI }));
    expect(spreadDeg(me)).toBeCloseTo(hip, 5);
    run(m, 1, () => ({ moveZ: 1, sprint: true, yaw: Math.PI }));
    expect(spreadDeg(me)).toBeGreaterThan(hip + 0.4);
  });

  it('kicks the view up when firing and lets it settle back', () => {
    const { m, me } = duel();
    run(m, 0.5, () => ({ fire: true, yaw: Math.PI }));
    expect(me.punchPitch).toBeGreaterThan(0.01);
    run(m, 2, () => ({ yaw: Math.PI }));
    expect(me.punchPitch).toBeLessThan(0.001);
  });
});

describe('damage and respawn', () => {
  it('kills a standing enemy in six carbine body shots', () => {
    const { m, me, foe } = duel();
    // Aim at the belly from 10 m, aimed down sights so every round lands and
    // the recoil climb stays below the head.
    const pitch = Math.atan2(0.7 - 1.62, 10);
    run(m, 0.4, () => ({ ads: true, pitch }));
    const events = run(m, 1.5, () => ({ ads: true, fire: true, pitch }));
    const kill = events.findIndex((e) => e.type === 'kill');
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(shots(events.slice(0, kill + 1))).toBe(Math.ceil(COMBAT.health / WEAPONS.carbine.damage));
    expect(foe.alive).toBe(false);
    expect(me.kills).toBe(1);
    expect(m.score).toEqual([1, 0]);
  });

  it('deals more for a headshot', () => {
    const { m, foe } = duel();
    const pitch = Math.atan2(1.66 - 1.62, 10);
    run(m, 0.4, () => ({ ads: true, pitch }));
    const events = run(m, 0.05, () => ({ ads: true, fire: true, pitch }));
    const dmg = events.find((e) => e.type === 'damage');
    expect(dmg && dmg.type === 'damage' && dmg.head).toBe(true);
    expect(foe.health).toBeCloseTo(COMBAT.health - WEAPONS.carbine.damage * WEAPONS.carbine.headMult, 4);
  });

  it('does not shoot through walls', () => {
    const { m, me, foe } = duel();
    // The tower stands between these two points.
    place(me, 0, 4, 0);
    place(foe, 0, -24, Math.PI);
    run(m, 1, () => ({ fire: true }));
    expect(foe.health).toBe(COMBAT.health);
  });

  it('ignores damage during spawn protection', () => {
    const { m, foe } = duel();
    foe.protect = 5;
    run(m, 1, () => ({ ads: true, fire: true, pitch: Math.atan2(1.1 - 1.62, 10) }));
    expect(foe.health).toBe(COMBAT.health);
  });

  it('regenerates health after a delay', () => {
    const { m, foe } = duel();
    const pitch = Math.atan2(1.1 - 1.62, 10);
    run(m, 0.4, () => ({ ads: true, pitch }));
    run(m, 0.05, () => ({ ads: true, fire: true, pitch }));
    const hurt = foe.health;
    expect(hurt).toBeLessThan(COMBAT.health);
    run(m, COMBAT.regenDelay - 0.5, () => ({ yaw: Math.PI }));
    expect(foe.health).toBe(hurt);
    run(m, 4, () => ({ yaw: Math.PI }));
    expect(foe.health).toBe(COMBAT.health);
  });

  it('respawns the dead at their own side with full health and ammo', () => {
    const { m, foe } = duel();
    const pitch = Math.atan2(1.1 - 1.62, 10);
    run(m, 0.4, () => ({ ads: true, pitch }));
    run(m, 1.5, () => ({ ads: true, fire: true, pitch }));
    expect(foe.alive).toBe(false);
    const events = run(m, COMBAT.respawnTime + 0.1, () => ({ yaw: Math.PI }));
    expect(events.some((e) => e.type === 'spawn' && e.actor === foe.id)).toBe(true);
    expect(foe.alive).toBe(true);
    expect(foe.health).toBe(COMBAT.health);
    expect(foe.p.pos.z).toBeLessThan(-40);
    expect(foe.protect).toBeGreaterThan(0);
  });

  it('ends the match at the score limit', () => {
    const m = createMatch(map, world, { seed: 3, teamSize: 1, scoreLimit: 1 });
    const [me, foe] = m.actors;
    foe.brain = null;
    place(me, 0, 50, 0);
    place(foe, 0, 40, Math.PI);
    foe.protect = 0;
    const pitch = Math.atan2(1.1 - 1.62, 10);
    run(m, 0.4, () => ({ ads: true, pitch }));
    const events = run(m, 2, () => ({ ads: true, fire: true, pitch }));
    expect(events.filter((e) => e.type === 'matchEnd')).toEqual([{ type: 'matchEnd', winner: 0 }]);
    expect(m.over).toBe(true);
    const tick = m.tick;
    run(m, 0.5);
    expect(m.tick).toBe(tick);
  });
});

describe('navigation', () => {
  it('finds a walkable path between the two sides of the map', () => {
    const m = createMatch(map, world, { seed: 1, humans: 0 });
    const path: number[] = [];
    expect(findPath(m.nav, 0, 0, 46, 0, 0, -62, path)).toBe(true);
    expect(path.length).toBeGreaterThanOrEqual(PATH_STRIDE * 3);
    const S = PATH_STRIDE;
    for (let i = 0; i + S < path.length; i += S) {
      expect(path[i + S + 3]).toBe(Link.Walk);
      expect(walkableLine(m.nav, path[i], path[i + 1], path[i + 2], path[i + S], path[i + S + 1], path[i + S + 2])).toBe(true);
    }
    // The tower sits on the straight line, so the path has to go around it.
    let length = 0;
    for (let i = 0; i + S < path.length; i += S) length += Math.hypot(path[i + S] - path[i], path[i + S + 2] - path[i + 2]);
    expect(length).toBeGreaterThan(108);
    expect(length).toBeLessThan(125);
  });

  it('marks solid boxes as blocked and open floor as free, on every floor', () => {
    const m = createMatch(map, world, { seed: 1, humans: 0 });
    expect(isWalkable(m.nav, 0, 0, -12)).toBe(false);
    expect(isWalkable(m.nav, 0, 0, 50)).toBe(true);
    expect(isWalkable(m.nav, 200, 0, 0)).toBe(false);
    // The deck on its pillar: free on top, blocked underneath.
    expect(isWalkable(m.nav, 24, 4, -22)).toBe(true);
    expect(isWalkable(m.nav, 24, 0, -22)).toBe(false);
  });

  it('plans up ramps, up walls and down from ledges', () => {
    const m = createMatch(map, world, { seed: 1, humans: 0 });
    const path: number[] = [];
    const kinds = (): number[] => path.filter((_, i) => i % PATH_STRIDE === 3);
    // Up onto a mantle block is a climb; the tallest one is out of reach.
    expect(findPath(m.nav, 10, 0, 24, 26, 3.2, 24, path)).toBe(true);
    expect(kinds()).toContain(Link.Climb);
    expect(path[path.length - 3]).toBeCloseTo(3.2, 1);
    expect(isWalkable(m.nav, 32, 5.5, 24)).toBe(false);
    // The ramp walks up to its deck, and a way down from it is a drop.
    expect(findPath(m.nav, 24, 0, 0, 24, 4, -22, path)).toBe(true);
    expect(kinds().every((k) => k === Link.Walk)).toBe(true);
    expect(findPath(m.nav, 24, 4, -22, 24, 0, -32, path)).toBe(true);
    expect(kinds()).toContain(Link.Drop);
  });
});

describe('bots', () => {
  /** One bot (actor 1) against the human (actor 0), who stands still. */
  function withBot(role: string, seed = 5): { m: MatchState; me: Actor; bot: Actor } {
    const m = createMatch(map, world, { seed, teamSize: 1 });
    const [me, bot] = m.actors;
    bot.brain!.role = role;
    bot.loadout = [BOT_ROLES[role].weapon];
    bot.ammo = [WEAPONS[bot.loadout[0]].magSize];
    bot.damageScale = BOT_ROLES[role].damageScale;
    me.protect = bot.protect = 0;
    return { m, me, bot };
  }

  it('sees ahead but not behind or through walls', () => {
    const { me, bot } = withBot('rifle');
    place(me, 0, 50, 0);
    place(bot, 0, 36, Math.PI);
    expect(canSee(world, bot, me, false)).toBe(true);
    bot.p.yaw = 0;
    expect(canSee(world, bot, me, false)).toBe(false);
    expect(canSee(world, bot, me, true)).toBe(true);
    place(bot, 0, -24, Math.PI);
    place(me, 0, 4, 0);
    expect(canSee(world, bot, me, true)).toBe(false);
  });

  it('notices, waits out its reaction time, then engages and hurts a target that stands still', () => {
    const { m, me, bot } = withBot('rifle');
    place(me, 0, 50, 0);
    place(bot, 0, 34, Math.PI);
    const events: MatchEvent[] = [];
    let noticeAt = -1;
    let engageAt = -1;
    for (let i = 0; i < 240 && me.alive; i++) {
      stepMatch(m, world, [{ ...emptyInput(), yaw: 0 }], TICK_DT);
      events.push(...m.events);
      if (noticeAt < 0 && bot.brain!.state === 'notice') noticeAt = m.time;
      if (engageAt < 0 && bot.brain!.state === 'engage') engageAt = m.time;
    }
    expect(events.some((e) => e.type === 'notice' && e.actor === bot.id && e.target === me.id)).toBe(true);
    expect(noticeAt).toBeGreaterThan(0);
    expect(engageAt - noticeAt).toBeGreaterThanOrEqual(BOT_ROLES.rifle.reaction - TICK_DT);
    expect(engageAt - noticeAt).toBeLessThan(BOT_ROLES.rifle.reaction + BOTS.thinkInterval + TICK_DT * 2);
    expect(me.health).toBeLessThan(COMBAT.health);
  });

  it('gives up the hunt when the target is gone, and patrols again', () => {
    const { m, me, bot } = withBot('rifle');
    place(me, 0, 50, 0);
    place(bot, 0, 34, Math.PI);
    run(m, 0.6);
    expect(bot.brain!.state).not.toBe('patrol');
    // Move the target to the far side of the tower.
    place(me, 0, -30, 0);
    me.health = COMBAT.health;
    let searched = false;
    for (let i = 0; i < 60 * 12 && bot.brain!.state !== 'patrol'; i++) {
      place(me, 60, -60, 0);
      stepMatch(m, world, [emptyInput()], TICK_DT);
      searched ||= bot.brain!.state === 'search';
    }
    expect(searched).toBe(true);
    expect(bot.brain!.state).toBe('patrol');
    expect(bot.brain!.token).toBe(false);
  });

  it('shows a marksman lining up its shot for the full charge time before it fires', () => {
    const { m, me, bot } = withBot('marksman');
    place(me, 0, 60, 0);
    place(bot, 0, 34, Math.PI);
    me.health = 1e6;
    let chargeAt = -1;
    let shotAt = -1;
    for (let i = 0; i < 60 * 6 && shotAt < 0; i++) {
      stepMatch(m, world, [{ ...emptyInput(), yaw: 0 }], TICK_DT);
      for (const e of m.events) {
        if (e.type === 'charge' && chargeAt < 0) chargeAt = m.time;
        if (e.type === 'shot' && e.actor === bot.id) shotAt = m.time;
      }
    }
    expect(chargeAt).toBeGreaterThan(0);
    expect(shotAt - chargeAt).toBeGreaterThanOrEqual(BOT_ROLES.marksman.chargeTime - TICK_DT * 2);
    expect(shotAt - chargeAt).toBeLessThan(BOT_ROLES.marksman.chargeTime + 0.1);
  });

  it('goes up the ramp after a target standing on the deck above', () => {
    const { m, me, bot } = withBot('rusher');
    me.health = Infinity;
    place(me, 24, -24, 0);
    me.p.pos.y = 4.02;
    place(bot, 24, 6, 0);
    let t = 0;
    for (; t < 10 && bot.p.pos.y < 3.5; t += TICK_DT) stepMatch(m, world, [{ ...emptyInput(), yaw: 0 }], TICK_DT);
    expect(bot.brain!.target).toBe(me.id);
    expect(bot.p.pos.y).toBeGreaterThan(3.5);
  });

  it('lets at most the allowed number of bots fire on one target', () => {
    const m = createMatch(map, world, { seed: 9 });
    const me = m.actors[0];
    for (const a of m.actors) if (a.brain && a.team === 0) a.brain = null;
    me.health = 1e9;
    const foes = m.actors.filter((a) => a.team === 1);
    place(me, 30, 50, 0);
    foes.forEach((f, i) => place(f, 20 + i * 6, 30, Math.PI));
    let most = 0;
    for (let i = 0; i < 60 * 5; i++) {
      me.sinceDamage = 0;
      stepMatch(m, world, [{ ...emptyInput(), yaw: 0 }], TICK_DT);
      most = Math.max(most, foes.filter((f) => f.brain!.token && f.brain!.target === me.id).length);
    }
    expect(most).toBe(BOTS.tokensPerTarget);
  });
});

describe('whole matches, bots only', () => {
  function play(seed: number, seconds: number): MatchState {
    const m = createMatch(map, world, { seed, humans: 0, scoreLimit: 9999 });
    for (let i = 0; i < seconds * 60; i++) stepMatch(m, world, [], TICK_DT);
    return m;
  }

  it('replays exactly from the same seed, and differently from another', () => {
    const a = play(42, 60);
    const b = play(42, 60);
    const c = play(43, 60);
    const digest = (m: MatchState): string => JSON.stringify(m.actors.map((x) => [x.p.pos, x.health, x.kills, x.deaths, x.ammo]));
    expect(digest(a)).toBe(digest(b));
    expect(digest(a)).not.toBe(digest(c));
  });

  it('keeps fighting for minutes with no stuck bot and a balanced score', () => {
    const minutes = 3;
    const totals = [0, 0];
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const m = createMatch(map, world, { seed, humans: 0, scoreLimit: 9999 });
      const still = m.actors.map(() => 0);
      const from = m.actors.map((a) => ({ x: a.p.pos.x, z: a.p.pos.z }));
      let worstStill = 0;
      for (let i = 0; i < minutes * 3600; i++) {
        stepMatch(m, world, [], TICK_DT);
        for (const a of m.actors) {
          const f = from[a.id];
          if (!a.alive || Math.hypot(a.p.pos.x - f.x, a.p.pos.z - f.z) > 3) {
            f.x = a.p.pos.x;
            f.z = a.p.pos.z;
            still[a.id] = 0;
          } else {
            still[a.id] += TICK_DT;
            worstStill = Math.max(worstStill, still[a.id]);
          }
          expect(Number.isFinite(a.p.pos.x + a.p.pos.y + a.p.pos.z + a.health)).toBe(true);
        }
      }
      // Pilot kills only: the score also counts three points for every mech brought down.
      const kills = m.actors.reduce((s, a) => s + a.kills, 0);
      // A fight should break out every few seconds: between 5 and 25 kills a minute for 8 bots.
      expect(kills).toBeGreaterThan(5 * minutes);
      expect(kills).toBeLessThan(25 * minutes);
      // Both sides score; nobody is farmed at their spawn.
      expect(Math.min(m.score[0], m.score[1])).toBeGreaterThan((m.score[0] + m.score[1]) * 0.2);
      // A living bot never stays inside a 3 m circle for long (marksmen hold a spot the longest).
      expect(worstStill).toBeLessThan(25);
      // Every bot gets into fights.
      for (const a of m.actors) expect(a.kills + a.deaths).toBeGreaterThan(0);
      totals[0] += m.score[0];
      totals[1] += m.score[1];
    }
    // Over all seeds the mirrored teams come out close to even.
    const share = totals[0] / (totals[0] + totals[1]);
    expect(share).toBeGreaterThan(0.38);
    expect(share).toBeLessThan(0.62);
  }, 120_000);

  it('bots press on a pilot who stands still, and a moving pilot lasts longer', () => {
    const survive = (moving: boolean): number => {
      let total = 0;
      for (const seed of [21, 22, 23, 24, 25, 26]) {
        const m = createMatch(map, world, { seed });
        const me = m.actors[0];
        for (const a of m.actors) if (a.brain && a.team === 0) a.brain = null;
        const foes = m.actors.filter((a) => a.team === 1);
        // Open floor in the south-east, 20 m apart, everyone facing each other.
        place(me, 40, 58, 0);
        foes.forEach((f, i) => place(f, 31 + i * 6, 38, Math.PI));
        me.protect = 0;
        let t = 0;
        while (me.alive && t < 40) {
          // Strafing sprint in a wide circle with a jump every second.
          const cmd = { ...emptyInput(), yaw: moving ? t * 1.2 : 0, moveZ: moving ? 1 : 0, sprint: moving, jump: moving && t % 1 < 0.1 };
          stepMatch(m, world, [cmd], TICK_DT);
          t += TICK_DT;
        }
        total += t;
      }
      return total / 6;
    };
    const still = survive(false);
    const moving = survive(true);
    // Standing in the open against four bots is lost quickly, but not instantly.
    // (Measured: 2.9 s.)
    expect(still).toBeGreaterThan(1.2);
    expect(still).toBeLessThan(6);
    // Movement is the defence, even with no cover and without shooting back:
    // sprinting across their view should buy clearly more time (measured: 1.7x).
    expect(moving).toBeGreaterThan(still * 1.4);
  });
});
