import { describe, expect, it } from 'vitest';
import { createPlayerState, mapById, v3, type CollisionWorld, type MapSound, type PlayerState, type Vec3 } from '@dropline/shared';
import manifest from '../../../assets/audio/sounds.json';
import { Ambience } from '../src/audio/ambience';
import music from '../../../assets/music/music.json';
import { PilotFoley } from '../src/audio/pilotFoley';
import type { Sfx } from '../src/audio/sfx';
import type { SurfaceSounds } from '../src/audio/surfaces';

/** Records which sounds the foley asks for, and whether the listener is in earshot. */
function fakeSfx(inRange = true) {
  const calls: string[] = [];
  const log =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(name === 'land' ? `land ${(args[1] as number).toFixed(2)}` : name === 'hold' ? `hold ${args[1] as string}` : name);
    };
  const sfx = {
    hears: () => inRange,
    land: log('land'),
    jump: log('jump'),
    step: log('step'),
    wallGrab: log('wallGrab'),
    mantle: log('mantle'),
    slideStart: log('slideStart'),
    jetIgnite: log('jetIgnite'),
    hold: log('hold'),
  };
  return { sfx: sfx as unknown as Sfx, calls };
}

const surfaces = { underfoot: () => 'hard' } as unknown as SurfaceSounds;

function airborne(vy: number): PlayerState {
  const s = createPlayerState(v3(0, 2, 0));
  s.grounded = false;
  s.vel.y = vy;
  return s;
}

describe('pilot foley', () => {
  it('lands with the weight of the fall, though the touchdown tick has already stopped it', () => {
    const { sfx, calls } = fakeSfx();
    const foley = new PilotFoley(sfx, surfaces, 0);
    for (const vy of [-4, -8, -12]) foley.update(airborne(vy), null, false);
    // The sim zeroes the fall a tick before it says the pilot is grounded.
    foley.update(airborne(0), null, false);
    const down = createPlayerState(v3(0, 0, 0));
    down.grounded = true;
    foley.update(down, null, false);
    expect(calls).toEqual(['land 0.71']);
  });

  it('makes no landing of a step down', () => {
    const { sfx, calls } = fakeSfx();
    const foley = new PilotFoley(sfx, surfaces, 0);
    foley.update(airborne(-1.5), null, false);
    const down = createPlayerState(v3(0, 0, 0));
    down.grounded = true;
    foley.update(down, null, false);
    expect(calls).toEqual([]);
  });

  it('lights the jet pack once and holds its roar while it burns', () => {
    const { sfx, calls } = fakeSfx();
    const foley = new PilotFoley(sfx, surfaces, 3);
    const s = airborne(1);
    s.thrusting = true;
    foley.update(s, null, false);
    foley.update(s, null, false);
    expect(calls).toEqual(['jetIgnite', 'hold jet', 'hold jet']);
  });

  it('is silent out of earshot, and does not replay what it missed on coming back', () => {
    const far = fakeSfx(false);
    const foley = new PilotFoley(far.sfx, surfaces, 0);
    foley.update(airborne(-12), v3(100, 0, 0), true);
    const down = createPlayerState(v3(0, 0, 0));
    down.grounded = true;
    foley.update(down, v3(100, 0, 0), true);
    expect(far.calls).toEqual([]);
  });
});

describe('sound files', () => {
  it('every take the manifest lists is built', () => {
    const built = import.meta.glob('../../../assets/audio/*.mp3');
    const missing: string[] = [];
    for (const [name, { count }] of Object.entries(manifest)) {
      for (let i = 1; i <= count; i++) if (!built[`../../../assets/audio/${name}-${i}.mp3`]) missing.push(`${name}-${i}.mp3`);
    }
    expect(missing).toEqual([]);
  });
});

describe('music files', () => {
  it('every track the music manifest lists is built, and every loop runs forward', () => {
    const built = import.meta.glob('../../../assets/music/*.mp3');
    for (const [track, entry] of Object.entries(music) as [string, { loop?: [number, number] }][]) {
      expect(built[`../../../assets/music/${track}.mp3`], track).toBeDefined();
      if (entry.loop) expect(entry.loop[1] - entry.loop[0], track).toBeGreaterThan(10);
    }
  });
});

/** Records what the ambience asks for: held loops by name and gain, one-shots with the time they played. */
function fakeAmbientSfx() {
  const held: { name: string; at: Vec3 | null; gain: number }[] = [];
  const shots: { name: string; at: Vec3; t: number }[] = [];
  let shelter = 0;
  let t = 0;
  const sfx = {
    holdAmbient: (_key: string, name: string, at: Vec3 | null, gain: number) => held.push({ name, at, gain }),
    playAmbient: (name: string, at: Vec3) => shots.push({ name, at, t }),
    setShelter: (amount: number) => (shelter = amount),
  };
  return {
    sfx: sfx as unknown as Sfx,
    held,
    shots,
    shelter: () => shelter,
    tick: (dt: number) => (t += dt),
  };
}

/** A world with a roof over the listener, or open sky. */
const world = (roofed: boolean) => ({ castRay: () => (roofed ? { dist: 3 } : null) }) as unknown as CollisionWorld;

/** A fixed sequence of "random" numbers, repeated. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function run(amb: Ambience, f: ReturnType<typeof fakeAmbientSfx>, seconds: number, at: Vec3, dt = 1 / 60): void {
  for (let s = 0; s < seconds; s += dt) {
    f.tick(dt);
    amb.update(dt, at);
  }
}

describe('ambience', () => {
  it('holds a loop from its nearest point, and not out of range', () => {
    const f = fakeAmbientSfx();
    const sounds: MapSound[] = [{ sound: 'amb-city', gain: 1, range: 50, at: [[100, 0, 0], [0, 0, 40]] }];
    const amb = new Ambience(f.sfx, world(false), sounds);
    amb.update(1 / 60, v3(0, 0, 0));
    expect(f.held.map((h) => h.at)).toEqual([v3(0, 0, 40)]);
    amb.update(1 / 60, v3(0, 0, -20));
    expect(f.held).toHaveLength(1);
  });

  it('spaces each one-shot by its wait, and any two by at least 2 s', () => {
    const f = fakeAmbientSfx();
    const sounds: MapSound[] = [
      { sound: 'amb-creak', gain: 1, every: [3, 5], at: [[0, 0, 0]] },
      { sound: 'amb-debris', gain: 1, every: [3, 5], at: [[0, 0, 0]] },
    ];
    const amb = new Ambience(f.sfx, world(false), sounds, Math.random);
    run(amb, f, 300, v3(0, 0, 0));
    expect(f.shots.length).toBeGreaterThan(60);
    for (const name of ['amb-creak', 'amb-debris']) {
      const times = f.shots.filter((s) => s.name === name).map((s) => s.t);
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(3 - 1e-9);
    }
    for (let i = 1; i < f.shots.length; i++) expect(f.shots[i].t - f.shots[i - 1].t).toBeGreaterThanOrEqual(2 - 1e-9);
  });

  it('plays nothing new while paused', () => {
    const f = fakeAmbientSfx();
    const amb = new Ambience(f.sfx, world(false), [{ sound: 'amb-siren', gain: 1, every: [1, 1], at: [[0, 0, 0]] }], seq(0));
    for (let i = 0; i < 600; i++) amb.update(0, v3(0, 0, 0));
    expect(f.shots).toEqual([]);
  });

  it('drops the wind and dulls the rest under a roof; the wind picks up high', () => {
    const wind: MapSound[] = [{ sound: 'amb-wind', gain: 1, exposed: true }];
    const gainAfter = (roofed: boolean, y: number): { gain: number; shelter: number } => {
      const f = fakeAmbientSfx();
      run(new Ambience(f.sfx, world(roofed), wind), f, 5, v3(0, y, 0));
      return { gain: f.held[f.held.length - 1].gain, shelter: f.shelter() };
    };
    const street = gainAfter(false, 0);
    const indoors = gainAfter(true, 0);
    const high = gainAfter(false, 14);
    expect(street.shelter).toBe(0);
    expect(indoors.shelter).toBeGreaterThan(0.99);
    expect(indoors.gain).toBeLessThan(street.gain * 0.2);
    expect(high.gain).toBeCloseTo(street.gain * 2);
  });

  it('skips a sound that was never built instead of failing', () => {
    const f = fakeAmbientSfx();
    const amb = new Ambience(f.sfx, world(false), [{ sound: 'no-such-sound', gain: 1 }]);
    amb.update(1 / 60, v3(0, 0, 0));
    expect(f.held).toEqual([]);
  });

  it("every sound Spire Nine's ambience names is built", () => {
    const sounds = mapById('spire-nine').ambience ?? [];
    expect(sounds.length).toBeGreaterThan(0);
    expect(sounds.map((s) => s.sound).filter((name) => !(name in manifest))).toEqual([]);
  });
});
