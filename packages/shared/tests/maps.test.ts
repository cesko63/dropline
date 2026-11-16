import { beforeAll, describe, expect, it } from 'vitest';
import {
  BOTS,
  CollisionWorld,
  MAPS,
  MECH,
  TUNING,
  buildNav,
  cellOf,
  mapById,
  nearestWalkable,
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

/** True if `x, z` is a cell of the grid's area that holds `areaOf`. */
const sameArea = (nav: NavGrid, x: number, z: number, area: number): boolean => {
  const c = nearestWalkable(nav, x, z, 1);
  return c >= 0 && nav.area[c] === area;
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
      const c = cellOf(nav, s.pos[0], s.pos[2]);
      expect(c, `spawn at ${s.pos} on the bot grid`).toBeGreaterThanOrEqual(0);
      areas.add(nav.area[c]);
    }
    expect([...areas]).toHaveLength(1);
    expect(map.spawns.filter((s) => (s.team ?? 0) === 0).length).toBeGreaterThanOrEqual(4);
    expect(map.spawns.filter((s) => s.team === 1).length).toBeGreaterThanOrEqual(4);
  });

  it('lets a mech walk from one team\'s spawns to the other\'s', () => {
    const nav = buildNav(map, world, MECH.body.radius, MECH.body.height);
    const areaOf = (team: number): number[] =>
      map.spawns
        .filter((s) => (s.team ?? 0) === team)
        .map((s) => nearestWalkable(nav, s.pos[0], s.pos[2], 6))
        .filter((c) => c >= 0)
        .map((c) => nav.area[c]);
    const a = areaOf(0), b = areaOf(1);
    expect(a.length).toBeGreaterThan(0);
    expect(b.some((x) => a.includes(x))).toBe(true);
  });
});

describe('Spire Nine', () => {
  const map = mapById('spire-nine');
  let world: CollisionWorld;
  let pilot: NavGrid;
  let mech: NavGrid;
  let pilotArea = 0;
  let mechArea = 0;
  beforeAll(async () => {
    world = await CollisionWorld.create(map);
    pilot = buildNav(map, world);
    mech = buildNav(map, world, MECH.body.radius, MECH.body.height);
    const s = map.spawns[0].pos;
    pilotArea = pilot.area[cellOf(pilot, s[0], s[2])];
    mechArea = mech.area[nearestWalkable(mech, s[0], s[2], 6)];
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
      [`checkpoint office (${half})`, -27, s * 48],
      [`tower lobby west (${half})`, 26, s * 10],
      [`tower lobby east (${half})`, 46, s * 10],
      [`site hut (${half})`, 56, s * 46],
    );
  }
  it.each(interiors)('keeps mechs out of the %s and lets pilots in', (_name, x, z) => {
    expect(sameArea(pilot, x, z, pilotArea)).toBe(true);
    const c = cellOf(mech, x, z);
    expect(c >= 0 && mech.area[c] === mechArea).toBe(false);
  });

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
    expect(sameArea(mech, x, z, mechArea)).toBe(true);
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
