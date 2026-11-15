import RAPIER from '@dimforge/rapier3d-compat';
import type { MapData } from '../map/types';
import { eulerDegToQuat, type Vec3 } from '../math/vec3';
import { TUNING } from './tuning';

export interface CastHit {
  /** Distance travelled before the hit, meters. */
  dist: number;
  /** Surface normal of what was hit, world space. */
  normal: Vec3;
  /** Handle of the collider that was hit. */
  collider: number;
  /** World-space contact point on the surface that was hit. */
  point: Vec3;
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
/** Overlap tests use a slightly smaller capsule so resting contact does not count. */
const OVERLAP_SHRINK = 0.006;

let rapierReady: Promise<void> | null = null;

/**
 * Static collision world built from map data. Only answers queries (casts and
 * overlaps); nothing is simulated here. Runs unchanged in the browser and Node.
 */
export class CollisionWorld {
  private readonly world: RAPIER.World;
  private readonly castShapes = new Map<number, RAPIER.Capsule>();
  private readonly overlapShapes = new Map<number, RAPIER.Capsule>();
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly center = { x: 0, y: 0, z: 0 };
  /** Collider handle -> map box id. */
  readonly boxIds = new Map<number, string>();

  private constructor(map: MapData) {
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    for (const box of map.boxes) {
      const desc = RAPIER.ColliderDesc.cuboid(box.size[0] / 2, box.size[1] / 2, box.size[2] / 2)
        .setTranslation(box.pos[0], box.pos[1], box.pos[2])
        .setRotation(eulerDegToQuat(box.rot));
      const collider = this.world.createCollider(desc);
      this.boxIds.set(collider.handle, box.id);
    }
    // One step builds the acceleration structure the queries use.
    this.world.step();
  }

  static async create(map: MapData): Promise<CollisionWorld> {
    rapierReady ??= RAPIER.init();
    await rapierReady;
    return new CollisionWorld(map);
  }

  private capsule(cache: Map<number, RAPIER.Capsule>, height: number, shrink: number): RAPIER.Capsule {
    let shape = cache.get(height);
    if (!shape) {
      const r = TUNING.player.radius - shrink;
      shape = new RAPIER.Capsule(Math.max(0.001, height / 2 - TUNING.player.radius), r);
      cache.set(height, shape);
    }
    return shape;
  }

  /** Sweep the player capsule (given by feet position and height) along a unit direction. */
  castCapsule(feet: Vec3, height: number, dir: Vec3, maxDist: number): CastHit | null {
    const c = this.center;
    c.x = feet.x;
    c.y = feet.y + height / 2;
    c.z = feet.z;
    const hit = this.world.castShape(c, IDENTITY, dir, this.capsule(this.castShapes, height, 0), 0, maxDist, false);
    if (!hit) return null;
    const n = hit.normal1;
    const p = hit.witness1;
    return {
      dist: hit.time_of_impact,
      normal: { x: n.x, y: n.y, z: n.z },
      collider: hit.collider.handle,
      point: { x: p.x, y: p.y, z: p.z },
    };
  }

  castRay(origin: Vec3, dir: Vec3, maxDist: number): CastHit | null {
    this.ray.origin.x = origin.x;
    this.ray.origin.y = origin.y;
    this.ray.origin.z = origin.z;
    this.ray.dir.x = dir.x;
    this.ray.dir.y = dir.y;
    this.ray.dir.z = dir.z;
    const hit = this.world.castRayAndGetNormal(this.ray, maxDist, true);
    if (!hit) return null;
    const n = hit.normal;
    const t = hit.timeOfImpact;
    return {
      dist: t,
      normal: { x: n.x, y: n.y, z: n.z },
      collider: hit.collider.handle,
      point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t },
    };
  }

  /** True if a player capsule standing at `feet` would intersect the map. */
  overlapsCapsule(feet: Vec3, height: number): boolean {
    const c = this.center;
    c.x = feet.x;
    c.y = feet.y + height / 2;
    c.z = feet.z;
    const shape = this.capsule(this.overlapShapes, height, OVERLAP_SHRINK);
    return this.world.intersectionWithShape(c, IDENTITY, shape) !== null;
  }
}
