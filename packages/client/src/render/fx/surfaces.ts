import type { Vec3 } from '@dropline/shared';

/** What effects need to know about the map: where a ray meets it. `CollisionWorld` is one. */
export interface Surfaces {
  castRay(origin: Vec3, dir: Vec3, maxDist: number): { dist: number; normal: Vec3 } | null;
}

const ray = { o: { x: 0, y: 0, z: 0 }, d: { x: 0, y: -1, z: 0 } };

/** Height of the first surface below a point, or -1e9 when there is none within 40 m. */
export function floorBelow(surfaces: Surfaces | null, x: number, y: number, z: number): number {
  if (!surfaces) return -1e9;
  ray.o.x = x;
  ray.o.y = y + 0.05;
  ray.o.z = z;
  const hit = surfaces.castRay(ray.o, ray.d, 40);
  return hit ? ray.o.y - hit.dist : -1e9;
}
