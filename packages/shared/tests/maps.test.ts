import { beforeAll, describe, expect, it } from 'vitest';
import {
  BOTS,
  CollisionWorld,
  Link,
  MAPS,
  MECH_BODY,
  TICK_DT,
  TUNING,
  buildNav,
  createMatch,
  isWalkable,
  mapById,
  nearestNode,
  nodeX,
  nodeZ,
  stepMatch,
  v3,
  type MapData,
  type NavGrid,
} from '../src';

const EYE = TUNING.player.eyeStand;
const DOWN = v3(0, -1, 0);

/** Every spot a standing pilot fits on a surface, sampled every `step` meters, from the ground up to `top`. */
function standingSpots(world: CollisionWorld, map: MapData, step: number, top: number): { x: number; y: number; z: number }[] {
  // Inside the invisible walls.
  let minX = -Infinity, maxX = Infinity, minZ = -Infinity, maxZ = Infinity;
  for (const b of map.boxes) {
    if (b.mat !== 'clip') continue;
    const [x0, x1, z0, z1] = [b.pos[0] - b.size[0] / 2, b.pos[0] + b.size[0] / 2, b.pos[2] - b.size[2] / 2, b.pos[2] + b.size[2] / 2];
    if (b.size[0] < b.size[2]) {
      if (x1 <= 0) minX = Math.max(minX, x1);
      else maxX = Math.min(maxX, x0);
    } else if (z1 <= 0) minZ = Math.max(minZ, z1);
    else maxZ = Math.min(maxZ, z0);
  }
  const out: { x: number; y: number; z: number }[] = [];
  const feet = v3();
  const probe = v3();
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let z = minZ + step / 2; z < maxZ; z += step) {
      let lastY = -Infinity;
      for (let y = 0; y <= top; y += 0.25) {
        probe.x = x;
        probe.y = y + 0.3;
        probe.z = z;
        const hit = world.castRay(probe, DOWN, 0.6);
        if (!hit || hit.dist === 0 || hit.normal.y < 0.7) continue;
        const ground = probe.y - hit.dist;
        if (ground - lastY < 0.5) continue;
        feet.x = x;
        feet.y = ground + 0.05;
        feet.z = z;
        if (world.overlapsCapsule(feet, TUNING.player.standHeight)) continue;
        lastY = ground;
        out.push({ x, y: ground, z });
      }
    }
  }
  return out;
}

/** True if the floor at x, y, z belongs to the grid's group of nodes `area`. */
const sameArea = (nav: NavGrid, x: number, y: number, z: number, area: number): boolean => {
  const k = nearestNode(nav, x, y, z, 1);
  return k >= 0 && nav.area[k] === area;
};

describe.each(Object.keys(MAPS))('map %s', (id) => {
  const map = MAPS[id];
  let world: CollisionWorld;
  beforeAll(async () => {
    world = await CollisionWorld.create(map);
  });

  it('has unique box ids', () => {
    const ids = [...map.boxes, ...(map.backdrop ?? [])].map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('puts every spawn on open ground, both teams on one connected floor', () => {
    const nav = buildNav(map, world);
    const areas = new Set<number>();
    for (const s of map.spawns) {
      const feet = v3(s.pos[0], s.pos[1], s.pos[2]);
      expect(world.overlapsCapsule(feet, TUNING.player.standHeight), `spawn at ${s.pos}`).toBe(false);
      const ground = world.castRay(v3(s.pos[0], s.pos[1] + 0.5, s.pos[2]), DOWN, 1.2);
      expect(ground, `ground under spawn at ${s.pos}`).not.toBeNull();
      const k = nearestNode(nav, s.pos[0], s.pos[1], s.pos[2], 0);
      expect(k, `spawn at ${s.pos} on the bot grid`).toBeGreaterThanOrEqual(0);
      areas.add(nav.area[k]);
    }
    expect([...areas]).toHaveLength(1);
    expect(map.spawns.filter((s) => (s.team ?? 0) === 0).length).toBeGreaterThanOrEqual(4);
    expect(map.spawns.filter((s) => s.team === 1).length).toBeGreaterThanOrEqual(4);
  });

  it('lets a mech walk from one team\'s spawns to the other\'s', () => {
    const nav = buildNav(map, world, MECH_BODY);
    const areaOf = (team: number): number[] =>
      map.spawns
        .filter((s) => (s.team ?? 0) === team)
        .map((s) => nearestNode(nav, s.pos[0], s.pos[1], s.pos[2], 6))
        .filter((k) => k >= 0)
        .map((k) => nav.area[k]);
    const a = areaOf(0), b = areaOf(1);
    expect(a.length).toBeGreaterThan(0);
    expect(b.some((x) => a.includes(x))).toBe(true);
  });

  // The grid's climbs, drops and leaps are only worth something if a bot can
  // really make them with the movement code: one bot tries every one of them.
  it('lets a bot make every climb, drop and leap on the bot grid', () => {
    const nav = buildNav(map, world);
    const m = createMatch(map, world, { seed: 1, teamSize: 1, humans: 0 });
    const [bot, other] = m.actors;
    other.alive = false;
    other.respawnIn = Infinity;
    const p = bot.p;
    const b = bot.brain!;
    const fails: string[] = [];
    let tried = 0;
    for (let a = 0; a < nav.nodeY.length; a++) {
      for (let l = nav.linkStart[a]; l < nav.linkStart[a + 1]; l++) {
        const kind = nav.linkKind[l];
        if (kind === Link.Walk) continue;
        tried++;
        const to = nav.linkTo[l];
        const [ax, ay, az] = [nodeX(nav, a), nav.nodeY[a], nodeZ(nav, a)];
        const [bx, by, bz] = [nodeX(nav, to), nav.nodeY[to], nodeZ(nav, to)];
        // The bot comes walking in from a little behind the start, where there is room.
        const d = Math.hypot(bx - ax, bz - az);
        const back = v3(ax - ((bx - ax) / d) * 0.6, ay + 0.02, az - ((bz - az) / d) * 0.6);
        Object.assign(p.pos, world.overlapsCapsule(back, TUNING.player.standHeight) ? v3(ax, ay + 0.02, az) : back);
        Object.assign(p.vel, v3());
        Object.assign(p, { yaw: Math.atan2(ax - bx, az - bz), fuel: 1, grounded: true, jumpHeld: false, airJumpsUsed: 0 });
        p.mantle.active = p.wallrun.active = false;
        Object.assign(bot, { health: Infinity, meter: 0 });
        b.path = [p.pos.x, ay, p.pos.z, Link.Walk, ax, ay, az, Link.Walk, bx, by, bz, kind];
        Object.assign(b, { state: 'patrol', pathI: 1, hasGoal: true, goalX: bx, goalY: by, goalZ: bz, thinkIn: Infinity });
        // Landed on the far floor: a leap or a drop may carry a little past its node.
        let ok = false;
        for (let t = 0; t < 4 && !ok; t += TICK_DT) {
          stepMatch(m, world, [], TICK_DT);
          ok = p.grounded && Math.abs(p.pos.y - by) < 0.6 && Math.hypot(p.pos.x - bx, p.pos.z - bz) < (kind === Link.Climb ? 1.2 : 2.5);
        }
        if (!ok) fails.push(`${['', 'climb', 'drop', 'leap'][kind]} (${ax}, ${ay.toFixed(1)}, ${az}) to (${bx}, ${by.toFixed(1)}, ${bz})`);
      }
    }
    expect(tried).toBeGreaterThan(100);
    expect(fails, fails.join('\n')).toEqual([]);
  }, 60_000);
});

describe('Spire Nine', () => {
  const map = mapById('spire-nine');
  let world: CollisionWorld;
  let pilot: NavGrid;
  let mech: NavGrid;
  let mechArea = 0;
  beforeAll(async () => {
    world = await CollisionWorld.create(map);
    pilot = buildNav(map, world);
    mech = buildNav(map, world, MECH_BODY);
    const s = map.spawns[0].pos;
    mechArea = mech.area[nearestNode(mech, s[0], s[1], s[2], 6)];
  });

  it('is the default map', () => {
    expect(mapById(undefined).name).toBe('spire-nine');
    expect(mapById('nope').name).toBe('spire-nine');
    expect(mapById('gym').name).toBe('gym');
  });

  // Buildings are pilot ground: pilots walk in from the street, mechs cannot.
  const interiors: [string, number, number][] = [];
  for (const s of [1, -1]) {
    const half = s > 0 ? 'south' : 'north';
    interiors.push(
      [`transit hall (${half})`, -27, s * 6],
      [`apartment block (${half})`, -27, s * 22],
      [`checkpoint office (${half})`, -27, s * 50],
      [`tower lobby west (${half})`, 26, s * 10],
      [`tower lobby east (${half})`, 46, s * 10],
      [`site hut (${half})`, 56, s * 46],
    );
  }
  it.each(interiors)('keeps mechs out of the %s and lets pilots in', (_name, x, z) => {
    expect(isWalkable(pilot, x, 0, z)).toBe(true);
    expect(isWalkable(mech, x, 0, z)).toBe(false);
  });

  // Bots go everywhere pilots go: up the stairs, ramps and the jib, up walls
  // and across the alley. Each spot is a floor a bot can plan a way to from
  // its spawn.
  const upper: [string, number, number, number][] = [];
  for (const s of [1, -1]) {
    const half = s > 0 ? 'south' : 'north';
    upper.push(
      [`rail deck by the station (${half})`, -49, 8, s * 17],
      [`rail deck by the Line (${half})`, -49, 8, s * 40],
      [`apartment upper floor (${half})`, -27, 4, s * 22],
      [`apartment roof (${half})`, -27, 8, s * 22],
      [`checkpoint office roof (${half})`, -27, 4.5, s * 48],
      [`tower second floor (${half})`, 26, 4.5, s * 10],
      [`tower third floor (${half})`, 26, 9, s * 10],
      [`site cabin roof (${half})`, 26, 11.8, s * 14],
      [`scaffolding (${half})`, 51.5, 4.5, s * 10],
      [`stacked container (${half})`, 28, 5.2, s * 45],
    );
  }
  upper.push(['station deck', -48, 8, 6], ['transit hall roof', -27, 8, 6], ['transit hall upper floor', -27, 4, 6], ['fallen jib', 10, 6.5, 0.5]);
  it.each(upper)('lets bots up to the %s', (_name, x, y, z) => {
    const k = nearestNode(pilot, x, y, z, 1);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(Math.abs(pilot.nodeY[k] - y)).toBeLessThan(0.6);
    expect(pilot.reach[k]).toBe(1);
  });

  it('sends bots off the ground floor in a match: marksmen most of all, to hold perches', () => {
    const m = createMatch(map, world, { seed: 7, humans: 0, scoreLimit: 9999 });
    const time: Record<string, { up: number; all: number }> = {};
    let holds = 0;
    for (let i = 0; i < 3 * 3600; i++) {
      stepMatch(m, world, [], TICK_DT);
      for (const a of m.actors) {
        if (!a.alive || a.inMech) continue;
        const t = (time[a.brain!.role] ??= { up: 0, all: 0 });
        t.all++;
        if (a.p.pos.y > 2) t.up++;
        if (a.brain!.holdFor > 0) holds++;
      }
    }
    const share = (role: string): number => time[role].up / time[role].all;
    const all = Object.values(time).reduce((s, t) => s + t.up, 0) / Object.values(time).reduce((s, t) => s + t.all, 0);
    // Measured on three other seeds: 12 to 20% of their time over all roles, marksmen 22 to 40%.
    expect(all).toBeGreaterThan(0.06);
    expect(share('marksman')).toBeGreaterThan(all);
    expect(holds).toBeGreaterThan(0);
  }, 60_000);

  // Each lane has room for a mech, end to end.
  const mechLanes: [string, number, number][] = [];
  for (const s of [1, -1]) {
    const half = s > 0 ? 'south' : 'north';
    mechLanes.push(
      [`avenue (${half})`, 0, s * 20],
      [`rail street under the deck (${half})`, -52, s * 40],
      [`construction yard (${half})`, 56, s * 10],
      [`cross street (${half})`, -40, s * 36],
    );
  }
  mechLanes.push(['avenue at the fallen jib', -12, 0]);
  it.each(mechLanes)('lets mechs through the %s', (_name, x, z) => {
    expect(sameArea(mech, x, 0, z, mechArea)).toBe(true);
  });

  // On the ground no view is longer than the bots can see. From anywhere,
  // raised perches too, no view reaches into the other team's spawn yard
  // (past the screens behind the Line, |z| > 61.5); a perch may look over the
  // lanes, that is what it is for.
  it('has no long views on the ground and none into the other spawn yard', () => {
    const limit = BOTS.sightRange;
    const yard = 61.6;
    const spots = standingSpots(world, map, 2, 14);
    const dirs: [string, ReturnType<typeof v3>][] = [['+x', v3(1, 0, 0)], ['-x', v3(-1, 0, 0)], ['+z', v3(0, 0, 1)], ['-z', v3(0, 0, -1)]];
    const eye = v3();
    // Grouped by direction and 10 m square, so a failure reads as a short list of places.
    const groups = new Map<string, { n: number; worst: number; at: string }>();
    for (const p of spots) {
      eye.x = p.x;
      eye.y = p.y + EYE;
      eye.z = p.z;
      const ground = p.y < 0.5;
      for (const [name, d] of dirs) {
        const hit = world.castRay(eye, d, 400);
        const dist = hit ? hit.dist : 400;
        const endZ = p.z + d.z * dist;
        const intoYard = d.z !== 0 && Math.sign(endZ) !== Math.sign(p.z || d.z) && Math.abs(endZ) > yard;
        const tooLong = ground && dist > limit;
        if (!intoYard && !tooLong) continue;
        const key = `${name} from x ${Math.floor(p.x / 10) * 10}, z ${Math.floor(p.z / 10) * 10}${ground ? '' : ' (raised)'}${intoYard ? ' into the yard' : ''}`;
        const g = groups.get(key) ?? { n: 0, worst: 0, at: '' };
        g.n++;
        if (dist > g.worst) {
          g.worst = dist;
          g.at = `(${p.x.toFixed(0)}, ${p.y.toFixed(1)}, ${p.z.toFixed(0)})`;
        }
        groups.set(key, g);
      }
    }
    expect(spots.length).toBeGreaterThan(2000);
    const lines = [...groups].sort((a, b) => b[1].worst - a[1].worst).map(([k, g]) => `${k}: ${g.n} spots, worst ${g.worst.toFixed(0)} m at ${g.at}`);
    expect(lines, `${lines.length} places with long views:\n${lines.join('\n')}`).toEqual([]);
  });
});
