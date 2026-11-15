import type { Vec3 } from '../math/vec3';
import { COMBAT } from './combat';

/** Distance along a unit ray to a sphere, or -1. Rays that start inside miss. */
export function raySphere(o: Vec3, d: Vec3, cx: number, cy: number, cz: number, r: number): number {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

/** Distance along a unit ray to an upright capsule whose axis runs from y0 to y1, or -1. */
export function rayUprightCapsule(o: Vec3, d: Vec3, cx: number, cz: number, y0: number, y1: number, r: number): number {
  let best = -1;
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-9) {
    const b = ox * d.x + oz * d.z;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const y = o.y + d.y * t;
      if (t >= 0 && y >= y0 && y <= y1) best = t;
    }
  }
  for (const cy of [y0, y1]) {
    const t = raySphere(o, d, cx, cy, cz, r);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

export interface ActorHit {
  t: number;
  head: boolean;
}

const hit: ActorHit = { t: 0, head: false };

/**
 * Ray against a pilot's hitboxes: a head sphere on top of a body capsule that
 * ends at the neck. `feet` and `height` are the same values movement uses, so a
 * crouched or sliding pilot is a smaller target. Returns a shared object.
 */
export function rayPilot(o: Vec3, d: Vec3, feet: Vec3, height: number, maxT: number): ActorHit | null {
  const H = COMBAT.hitbox;
  const tHead = raySphere(o, d, feet.x, feet.y + height - H.headDrop, feet.z, H.headRadius);
  const top = Math.max(feet.y + H.bodyRadius, feet.y + height - H.neck - H.bodyRadius);
  const tBody = rayUprightCapsule(o, d, feet.x, feet.z, feet.y + H.bodyRadius, top, H.bodyRadius);
  // The head wins when the ray reaches it first, or grazes the shoulders on the way to it.
  const head = tHead >= 0 && (tBody < 0 || tHead <= tBody + 0.12);
  const t = head ? tHead : tBody;
  if (t < 0 || t > maxT) return null;
  hit.t = t;
  hit.head = head;
  return hit;
}
