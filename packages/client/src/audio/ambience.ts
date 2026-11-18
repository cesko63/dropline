import { v3, type CollisionWorld, type MapSound, type Vec3 } from '@dropline/shared';
import manifest from '../../../../assets/audio/sounds.json';
import type { SoundName } from './bank';
import type { Sfx } from './sfx';

/** A roof higher than this over the listener counts as open sky. */
const ROOF = 25;
/** Seconds the ear takes to settle on going in or out from under a roof. */
const SHELTER_EASE = 0.6;
/** No two one-shots of the ambience closer together than this, in seconds. */
const ONE_SHOT_GAP = 2;
const UP = v3(0, 1, 0);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

interface Voice {
  def: MapSound;
  name: SoundName;
  points: Vec3[];
  /** Seconds until a one-shot plays again. */
  wait: number;
}

/**
 * The map's own sound (`MapData.ambience`): loops held the whole match from
 * their nearest point, one-shots after a random wait from a random point,
 * spaced apart. Under a roof the whole ambience dulls and the wind drops; up
 * high the wind picks up.
 */
export class Ambience {
  private readonly voices: Voice[] = [];
  private shelter = 0;
  private sinceShot = ONE_SHOT_GAP;

  constructor(
    private readonly sfx: Sfx,
    private readonly world: CollisionWorld,
    sounds: MapSound[],
    private readonly random: () => number = Math.random,
  ) {
    for (const def of sounds) {
      if (!(def.sound in manifest)) {
        console.warn(`map ambience: no sound "${def.sound}" in assets/audio/sounds.json; skipped`);
        continue;
      }
      const points = (def.at ?? []).map(([x, y, z]) => v3(x, y, z));
      // The first plays somewhere in the first wait, so one-shots do not all start together.
      const wait = def.every ? this.between(0, def.every[1]) : 0;
      this.voices.push({ def, name: def.sound as SoundName, points, wait });
    }
  }

  /** Once a frame, with the listener where the camera is. `dt` is 0 while paused: loops hold, nothing new plays. */
  update(dt: number, listener: Vec3): void {
    const roof = this.world.castRay(listener, UP, ROOF);
    this.shelter += ((roof ? 1 : 0) - this.shelter) * (1 - Math.exp(-dt / SHELTER_EASE));
    this.sfx.setShelter(this.shelter);
    this.sinceShot += dt;

    this.voices.forEach((v, i) => {
      const d = v.def;
      let gain = d.gain;
      if (d.exposed) gain *= (0.5 + 0.5 * clamp01(listener.y / 14)) * (1 - 0.85 * this.shelter);
      const reach = d.reach ?? 9;

      if (!d.every) {
        const at = this.nearest(v.points, listener);
        if (at && d.range !== undefined && dist(at, listener) > d.range) return;
        this.sfx.holdAmbient(`ambience-${i}`, v.name, at, gain, reach);
        return;
      }

      v.wait -= dt;
      if (v.wait > 0 || dt === 0) return;
      if (this.sinceShot < ONE_SHOT_GAP) {
        v.wait = ONE_SHOT_GAP - this.sinceShot;
        return;
      }
      v.wait = this.between(d.every[0], d.every[1]);
      const at = v.points.length ? v.points[Math.floor(this.random() * v.points.length)] : listener;
      if (d.range !== undefined && dist(at, listener) > d.range) return;
      this.sinceShot = 0;
      this.sfx.playAmbient(v.name, at, gain, reach, d.pitch ? this.between(d.pitch[0], d.pitch[1]) : 1);
    });
  }

  private between(lo: number, hi: number): number {
    return lo + (hi - lo) * this.random();
  }

  private nearest(points: Vec3[], to: Vec3): Vec3 | null {
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (const p of points) {
      const d = dist(p, to);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }
}
