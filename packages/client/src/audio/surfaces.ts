import type { CollisionWorld, MapData, PlayerState, Vec3 } from '@dropline/shared';

/** What a surface sounds like underfoot or under fire. */
export type Surface = 'hard' | 'metal';

const METAL = new Set(['steel', 'girder', 'machine', 'wreck']);

/** Finds which kind of surface a point or a pilot's feet are on, from the map's box materials. */
export class SurfaceSounds {
  private readonly mats = new Map<string, string>();
  private readonly origin = { x: 0, y: 0, z: 0 };
  private readonly dir = { x: 0, y: -1, z: 0 };

  constructor(
    map: MapData,
    private readonly world: CollisionWorld,
  ) {
    for (const box of map.boxes) this.mats.set(box.id, box.mat);
  }

  private ofCollider(handle: number): Surface {
    const id = this.world.boxIds.get(handle);
    return id !== undefined && METAL.has(this.mats.get(id) ?? '') ? 'metal' : 'hard';
  }

  /** What a pilot stands on, or the wall it runs along. */
  underfoot(s: PlayerState): Surface {
    if (s.wallrun.active) return this.ofCollider(s.wallrun.collider);
    this.origin.x = s.pos.x;
    this.origin.y = s.pos.y + 0.2;
    this.origin.z = s.pos.z;
    this.dir.x = 0;
    this.dir.y = -1;
    this.dir.z = 0;
    const hit = this.world.castRay(this.origin, this.dir, 0.6);
    return hit ? this.ofCollider(hit.collider) : 'hard';
  }

  /** The surface a round struck at `pos`, facing `normal`. */
  struck(pos: Vec3, normal: Vec3): Surface {
    this.origin.x = pos.x + normal.x * 0.05;
    this.origin.y = pos.y + normal.y * 0.05;
    this.origin.z = pos.z + normal.z * 0.05;
    this.dir.x = -normal.x;
    this.dir.y = -normal.y;
    this.dir.z = -normal.z;
    const hit = this.world.castRay(this.origin, this.dir, 0.2);
    return hit ? this.ofCollider(hit.collider) : 'hard';
  }
}
