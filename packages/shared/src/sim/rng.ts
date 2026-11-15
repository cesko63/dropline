/**
 * Seeded random numbers for gameplay (spread, bot decisions, spawns). The whole
 * generator is one integer, so it can be saved, sent over the network and
 * replayed. Effects on the client use `Math.random` instead and never touch this.
 */
export interface Rng {
  s: number;
}

export const createRng = (seed: number): Rng => ({ s: seed >>> 0 });

/** Uniform in [0, 1). mulberry32. */
export function rand(r: Rng): number {
  r.s = (r.s + 0x6d2b79f5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const randRange = (r: Rng, lo: number, hi: number): number => lo + (hi - lo) * rand(r);

/** Uniform in [-1, 1). */
export const randSigned = (r: Rng): number => rand(r) * 2 - 1;
