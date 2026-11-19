import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import type { Vec3 } from '@dropline/shared';
import { FLUIDS } from '../fx/gore';
import { stainAtlas } from '../fx/textures';

/** Stains one pilot can wear at once; the oldest goes first. */
const MAX_WOUNDS = 12;
/**
 * At most this many new stains per pilot in `BURST_MS`: a scattergun's pellets
 * land together, and projecting a stain for each would hitch the frame.
 */
const BURST = 2;
const BURST_MS = 100;
/** Tiles of the stain atlas: a splat where the round went in, drops thrown round it. */
const SPLAT = 0;
const DROPS = 3;

/** Wound materials by fluid (0 blood, 1 crude), then tile. Built on first use, shared by every pilot. */
const materials: Record<number, THREE.MeshStandardMaterial>[] = [{}, {}];

function material(fluid: number, tile: number): THREE.MeshStandardMaterial {
  const F = FLUIDS[fluid];
  return (materials[fluid][tile] ??= (() => {
    // The decal's own 0..1 UVs, mapped onto this tile of the atlas.
    const map = stainAtlas().clone();
    map.repeat.set(0.5, 0.5);
    map.offset.set((tile % 2) * 0.5, (1 - Math.floor(tile / 2)) * 0.5);
    map.needsUpdate = true;
    return new THREE.MeshStandardMaterial({
      color: F.stain,
      roughness: F.roughness,
      metalness: F.metalness,
      alphaMap: map,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
  })());
}

const raycaster = new THREE.Raycaster();
const projector = new THREE.Object3D();
const origin = new THREE.Vector3();
const way = new THREE.Vector3();
const normal = new THREE.Vector3();
const box = new THREE.Vector3();
const inverse = new THREE.Matrix4();

/**
 * Blood (or crude) a pilot wears where they were hit: decals projected onto
 * the suit part the round struck, carried with it as it moves, until respawn.
 */
export class Wounds {
  private readonly worn: THREE.Mesh[] = [];
  private burstStart = -Infinity;
  private burstCount = 0;

  constructor(
    /** The suit's parts, one per bone, that a stain can land on. */
    private readonly parts: THREE.Mesh[],
    private readonly fluid: number,
  ) {}

  /** A round struck at `at` flying along `dir` (unit); `damage` sets how big the stain is. Parts' world matrices must be current. */
  add(at: Vec3, dir: Vec3, damage: number): void {
    const now = performance.now();
    if (now - this.burstStart > BURST_MS) {
      this.burstStart = now;
      this.burstCount = 0;
    }
    if (this.burstCount >= BURST) return;
    this.burstCount++;
    way.set(dir.x, dir.y, dir.z);
    origin.set(at.x, at.y, at.z).addScaledVector(way, -0.6);
    raycaster.set(origin, way);
    raycaster.far = 1.2;
    const hit = raycaster.intersectObjects(this.parts, false)[0];
    // It struck the hitbox but missed the suit itself (a graze past a limb).
    if (!hit?.face) return;
    const part = hit.object as THREE.Mesh;
    normal.copy(hit.face.normal).transformDirection(part.matrixWorld);
    const size = 0.12 + 0.12 * Math.min(1, damage / 50);
    this.stamp(part, hit.point, SPLAT, size);
    if (Math.random() < 0.6) this.stamp(part, hit.point, DROPS, size * 2.2);
  }

  /** Project one stain of `tile` onto `part` at `point`, facing out along `normal`. */
  private stamp(part: THREE.Mesh, point: THREE.Vector3, tile: number, size: number): void {
    projector.position.copy(point);
    projector.lookAt(origin.copy(point).add(normal));
    projector.rotateZ(Math.random() * Math.PI * 2);
    const geo = new DecalGeometry(part, point, projector.rotation, box.set(size, size, 0.12));
    if (!geo.getAttribute('position').count) {
      geo.dispose();
      return;
    }
    // Built in world space; kept in the part's own space so it moves with the limb.
    geo.applyMatrix4(inverse.copy(part.matrixWorld).invert());
    const mesh = new THREE.Mesh(geo, material(this.fluid, tile));
    part.add(mesh);
    this.worn.push(mesh);
    if (this.worn.length > MAX_WOUNDS) this.remove(this.worn.shift()!);
  }

  private remove(mesh: THREE.Mesh): void {
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }

  /** Clean the suit (a respawn). */
  clear(): void {
    for (const mesh of this.worn) this.remove(mesh);
    this.worn.length = 0;
  }
}
