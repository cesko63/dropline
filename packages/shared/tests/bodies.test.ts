import { beforeAll, describe, expect, it } from 'vitest';
import gym from '../../../data/maps/gym.json';
import {
  COMBAT,
  CollisionWorld,
  FRAMES,
  TICK_DT,
  TUNING,
  createMatch,
  emptyInput,
  enterMech,
  resetMech,
  stepMatch,
  v3,
  type Actor,
  type InputCmd,
  type MapData,
  type MatchState,
  type Mech,
} from '../src';

const map = gym as MapData;
const r = TUNING.player.radius;
let world: CollisionWorld;

beforeAll(async () => {
  world = await CollisionWorld.create(map);
});

function place(a: Actor, x: number, z: number, yaw: number): void {
  a.p.pos.x = x;
  a.p.pos.y = 0.02;
  a.p.pos.z = z;
  a.p.yaw = yaw;
  a.p.pitch = 0;
  a.p.vel.x = a.p.vel.y = a.p.vel.z = 0;
}

/** Two pilots on one team (no friendly fire, no shooting), both scripted. */
function pair(): { m: MatchState; a: Actor; b: Actor } {
  const m = createMatch(map, world, { seed: 3, humans: 2, teamSize: 2 });
  for (const x of m.actors) if (x.brain) x.brain = null;
  const [a, b] = m.actors;
  // The two bots of the other team stand far away in a corner.
  place(m.actors[2], 60, -64, 0);
  place(m.actors[3], 62, -64, 0);
  return { m, a, b };
}

type Script = (t: number) => Partial<InputCmd>;
const still: Script = () => ({});

/** Step `seconds`; actors 0 and 1 follow their scripts. `each` runs after every tick. */
function run(m: MatchState, seconds: number, first: Script, second: Script = still, each?: () => void): void {
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
    const t = i * TICK_DT;
    const cmds = [first, second].map((s, n) => ({ ...emptyInput(), yaw: m.actors[n].p.yaw, pitch: m.actors[n].p.pitch, ...s(t) }));
    stepMatch(m, world, cmds, TICK_DT);
    each?.();
  }
}

const flat = (a: Actor, b: { x: number; z: number }): number => Math.hypot(a.p.pos.x - b.x, a.p.pos.z - b.z);

/** An empty mech standing at a place. With `pilot`, that pilot is at its controls. */
function stage(m: MatchState, owner: Actor, x: number, z: number, yaw: number, pilot = false): Mech {
  const k = m.mechs[owner.id];
  resetMech(k, v3(x, 0.02, z), yaw);
  k.state = 'idle';
  if (pilot) {
    owner.p.yaw = yaw;
    enterMech(m, owner, k);
    k.state = 'piloted';
  }
  return k;
}

describe('solid bodies', () => {
  it('stops a pilot who walks into another and lets them push, but never through', () => {
    const { m, a, b } = pair();
    // a walks north (-z) straight at b, who stands still 4 m ahead.
    place(a, 40, 58, 0);
    place(b, 40, 54, 0);
    let closest = Infinity;
    run(m, 3, () => ({ moveZ: 1 }), still, () => (closest = Math.min(closest, flat(a, b.p.pos))));
    // They meet and stay apart by about two radii: a few centimeters of give at most.
    expect(closest).toBeGreaterThan(r * 2 - 0.12);
    // a never got past b.
    expect(a.p.pos.z).toBeGreaterThan(b.p.pos.z);
    // b was nudged along, far slower than a walks: a pilot can be eased out of a
    // doorway but not bulldozed. (Measured: 0.75 m in the 2.5 s they touched.)
    expect(54 - b.p.pos.z).toBeGreaterThan(0.3);
    expect(54 - b.p.pos.z).toBeLessThan(1.5);
  });

  it('separates two pilots put on the same spot, smoothly and the same way every time', () => {
    const play = (): number[] => {
      const { m, a, b } = pair();
      place(a, 40, 58, 0);
      place(b, 40, 58, 0);
      let biggest = 0;
      let last = 0;
      run(m, 1, still, still, () => {
        const d = flat(a, b.p.pos);
        biggest = Math.max(biggest, d - last);
        last = d;
      });
      // No pop: at most the push speed per tick for each of the two.
      expect(biggest).toBeLessThanOrEqual(COMBAT.bodies.pilotPushSpeed * TICK_DT * 2 + 1e-6);
      expect(flat(a, b.p.pos)).toBeGreaterThan(r * 2 - 0.02);
      return [a.p.pos.x, a.p.pos.z, b.p.pos.x, b.p.pos.z];
    };
    expect(play()).toEqual(play());
  });

  it('lets a pilot fall past another one but not stand on their head', () => {
    const { m, a, b } = pair();
    place(b, 40, 54, 0);
    place(a, 40, 54, 0);
    a.p.pos.y = 2.2;
    a.p.grounded = false;
    run(m, 1.5, still);
    // a slid off to the side and landed on the floor beside b.
    expect(a.p.pos.y).toBeLessThan(0.1);
    expect(flat(a, b.p.pos)).toBeGreaterThan(r * 2 - 0.02);
  });

  it('stops a pilot at the hull of a standing mech, which does not give way', () => {
    const { m, a, b } = pair();
    const k = stage(m, b, 40, 50, 0);
    place(b, 20, 64, 0);
    place(a, 40, 58, 0);
    let closest = Infinity;
    run(m, 3, () => ({ moveZ: 1, sprint: true }), still, () => (closest = Math.min(closest, flat(a, k.pos))));
    expect(closest).toBeGreaterThan(r + FRAMES.halberd.body.radius - 0.15);
    expect(a.p.pos.z).toBeGreaterThan(k.pos.z);
    expect(k.pos.z).toBeCloseTo(50, 5);
  });

  it('slides along the hull instead of sticking to it', () => {
    const { m, a, b } = pair();
    const k = stage(m, b, 40, 50, 0);
    place(b, 20, 64, 0);
    // Aimed a little to the left of the mech's center: the pilot gets round it.
    place(a, 39.3, 58, 0);
    run(m, 3, () => ({ moveZ: 1 }));
    expect(a.p.pos.z).toBeLessThan(k.pos.z - 1);
  });

  it('shoves a pilot aside when a mech walks into them, but not into a wall', () => {
    const { m, a, b } = pair();
    // The pilot stands with their back to the outer east wall (inner face at x = 70).
    place(a, 70 - r - 0.05, 30, 0);
    const k = stage(m, b, 64, 30, -Math.PI / 2, true);
    // The mech walks east into the pilot, pinning them against the wall.
    run(m, 2, still, () => ({ moveZ: 1 }));
    expect(a.p.pos.x).toBeLessThan(70 - r + 0.01);
    // It had to go somewhere: along the wall, not through it.
    expect(k.pos.x).toBeLessThan(70);
  });

  it('lets a pilot climb out through the top of their own mech and land clear of it', () => {
    const { m, a } = pair();
    const k = stage(m, a, 40, 50, 0, true);
    run(m, 0.3, still);
    expect(a.inMech).toBe(true);
    // Press E: out through the hatch, forward and up.
    run(m, 2, (t) => ({ use: t < TICK_DT }));
    expect(a.inMech).toBe(false);
    expect(a.p.grounded).toBe(true);
    // Landed in front of the mech, clear of the hull, without being thrown sideways.
    expect(flat(a, k.pos)).toBeGreaterThan(r + FRAMES.halberd.body.radius - 0.02);
    expect(a.p.pos.z).toBeLessThan(k.pos.z);
    expect(Math.abs(a.p.pos.x - k.pos.x)).toBeLessThan(0.5);
  });

  it('keeps a mech out of reach of nobody: a pilot can still climb into their own', () => {
    const { m, a } = pair();
    const k = stage(m, a, 40, 50, 0);
    place(a, 40, 56, 0);
    // Walk up to it, then press E.
    run(m, 2, () => ({ moveZ: 1 }));
    run(m, 0.5, (t) => ({ use: t < TICK_DT }));
    expect(a.inMech).toBe(true);
    expect(k.state === 'boot' || k.state === 'piloted').toBe(true);
  });
});
