import { describe, expect, it } from 'vitest';
import { createPlayerState, v3, type PlayerState } from '@dropline/shared';
import manifest from '../../../assets/audio/sounds.json';
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
