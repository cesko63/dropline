import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * The pilot skeleton both factions share. Every suit is built on these bones
 * and these proportions, so a Corps pilot and a Z.E.R.O frame fill the same
 * space as the hitbox (a 0.33 m capsule to the shoulders, a 0.19 m head sphere
 * centred 1.65 m up) and are hit the same way.
 *
 * Conventions: 1 unit = 1 metre, the root at the feet, facing -Z, +X is the
 * pilot's right. Limbs hang down their own -Y; a positive X rotation swings a
 * limb forward, a negative one bends a knee back. A positive X rotation of the
 * spine, chest or head tips it back (the head looks up).
 */
export const BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'upperArmL',
  'foreArmL',
  'handL',
  'upperArmR',
  'foreArmR',
  'handR',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
  'pod',
] as const;
export type BoneName = (typeof BONES)[number];

/** Parent and rest offset of each bone. */
const LAYOUT: Record<BoneName, [BoneName | null, number, number, number]> = {
  hips: [null, 0, 0.92, 0],
  spine: ['hips', 0, 0.1, 0],
  chest: ['spine', 0, 0.2, 0],
  neck: ['chest', 0, 0.26, 0],
  head: ['neck', 0, 0.1, 0],
  upperArmL: ['chest', -0.24, 0.22, 0],
  foreArmL: ['upperArmL', 0, -0.3, 0],
  handL: ['foreArmL', 0, -0.27, 0],
  upperArmR: ['chest', 0.24, 0.22, 0],
  foreArmR: ['upperArmR', 0, -0.3, 0],
  handR: ['foreArmR', 0, -0.27, 0],
  thighL: ['hips', -0.11, -0.04, 0],
  shinL: ['thighL', 0, -0.42, 0],
  footL: ['shinL', 0, -0.4, 0],
  thighR: ['hips', 0.11, -0.04, 0],
  shinR: ['thighR', 0, -0.42, 0],
  footR: ['shinR', 0, -0.4, 0],
  // The launcher pod's hinge, above the right shoulder.
  pod: ['chest', 0.28, 0.46, 0.1],
};

export const THIGH_LEN = 0.42;
export const SHIN_LEN = 0.4;
/** Hip joint height above the feet at rest: hips 0.92, less the 0.04 to the thigh. */
export const HIP_HEIGHT = 0.88;

export type Skeleton = Record<BoneName, THREE.Object3D>;

export function buildSkeleton(parent: THREE.Object3D): Skeleton {
  const bones = {} as Skeleton;
  for (const name of BONES) {
    const b = new THREE.Object3D();
    b.name = name;
    const [, x, y, z] = LAYOUT[name];
    b.position.set(x, y, z);
    bones[name] = b;
  }
  for (const name of BONES) {
    const p = LAYOUT[name][0];
    (p ? bones[p] : parent).add(bones[name]);
  }
  return bones;
}

// ---------------------------------------------------------------------------
// Shapes. Every part is hard-surface: chamfered blocks and extruded profiles,
// flat shaded, so the armour reads as plates rather than skin.

type V3 = [number, number, number];

export interface PartOpts {
  /** Euler rotation, radians. */
  rot?: V3;
  /** Edge chamfer in metres; defaults to a fifth of the thinnest side, at most 2 cm. */
  bevel?: number;
}

/** A closed polygon in XY extruded `depth` along Z, centred on the origin, with chamfered edges. */
export function prism(points: [number, number][], depth: number, bevel = 0.01): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const b = Math.min(bevel, depth * 0.45);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, depth - 2 * b),
    bevelEnabled: b > 0.0005,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geo.translate(0, 0, -(depth - 2 * b) / 2);
  return geo;
}

/** A block with chamfered edges and corners. */
export function block(w: number, h: number, d: number, bevel?: number): THREE.BufferGeometry {
  const c = Math.min(bevel ?? Math.min(0.02, Math.min(w, h, d) / 5), w / 2.2, h / 2.2, d / 2.2);
  if (c < 0.002) return new THREE.BoxGeometry(w, h, d);
  // The outline is inset by the chamfer, which the bevel then grows back out.
  const x = w / 2 - c;
  const y = h / 2 - c;
  const k = Math.min(c * 0.8, x * 0.9, y * 0.9);
  return prism(
    [
      [-x + k, -y],
      [x - k, -y],
      [x, -y + k],
      [x, y - k],
      [x - k, y],
      [-x + k, y],
      [-x, y - k],
      [-x, -y + k],
    ],
    d,
    c,
  );
}

/** A cylinder along Y. */
export function rod(r: number, len: number, sides = 8, r2 = r): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r2, r, len, sides);
}

/** A trapezoid outline: `top` and `bottom` widths over `h`, for plates that taper. */
export const taper = (top: number, bottom: number, h: number, shift = 0): [number, number][] => [
  [-bottom / 2, -h / 2],
  [bottom / 2, -h / 2],
  [top / 2 + shift, h / 2],
  [-top / 2 + shift, h / 2],
];

// ---------------------------------------------------------------------------
// Kits: one suit's parts, merged into one body mesh and one light mesh per
// bone, built once per faction and shared by every pilot wearing it.

export interface BoneMeshes {
  /** Armour, undersuit and frame, coloured per vertex. */
  body?: THREE.BufferGeometry;
  /** The suit's lights, drawn unlit. */
  glow?: THREE.BufferGeometry;
}

export interface Kit {
  bones: Partial<Record<BoneName, BoneMeshes>>;
  /** Where jet flames leave the suit, in chest space. */
  thrusters: V3[];
  /** Glow halos that keep the suit's lights readable at range: bone, position, size. */
  halos: { bone: BoneName; at: V3; size: number }[];
  /** Colours the rig reuses for its own parts (the arm's barrels, the pod). */
  colors: { gun: string; accent: string; glow: string };
  /** Surface of the body material. */
  roughness: number;
  metalness: number;
}

const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpPos = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);
const tmpColor = new THREE.Color();

/** Mirrors a side-specific bone name: `thighL` <-> `thighR`. */
const mirrorBone = (b: BoneName): BoneName =>
  (b.endsWith('L') ? b.slice(0, -1) + 'R' : b.endsWith('R') ? b.slice(0, -1) + 'L' : b) as BoneName;

export class KitBuilder {
  private parts = new Map<BoneName, { body: THREE.BufferGeometry[]; glow: THREE.BufferGeometry[] }>();
  private seed = 1;

  constructor(
    /** How much each plate's shade varies, so a suit looks worn rather than printed. */
    private readonly wear = 0,
  ) {}

  /** Add a part to a bone. `color` is a hex string; glowing parts are drawn unlit. */
  add(bone: BoneName, geo: THREE.BufferGeometry, color: string, at: V3, opts: PartOpts & { glow?: boolean } = {}): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g.clearGroups();
    const r = opts.rot ?? [0, 0, 0];
    tmpQuat.setFromEuler(tmpEuler.set(r[0], r[1], r[2]));
    g.applyMatrix4(tmpMat.compose(tmpPos.set(at[0], at[1], at[2]), tmpQuat, ONE));
    tmpColor.set(color);
    if (!opts.glow && this.wear > 0) tmpColor.multiplyScalar(1 + (this.rand() - 0.5) * 2 * this.wear);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      c[i * 3] = tmpColor.r;
      c[i * 3 + 1] = tmpColor.g;
      c[i * 3 + 2] = tmpColor.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    let list = this.parts.get(bone);
    if (!list) this.parts.set(bone, (list = { body: [], glow: [] }));
    (opts.glow ? list.glow : list.body).push(g);
    return this;
  }

  /**
   * Add a part to a left bone and its mirror image to the right one. Positions
   * and rotations are given for the left side.
   */
  pair(bone: BoneName, geo: THREE.BufferGeometry, color: string, at: V3, opts: PartOpts & { glow?: boolean } = {}): this {
    const r = opts.rot ?? [0, 0, 0];
    const mirrored = geo.clone();
    // Mirroring flips the winding; scale -1 on X and swap the faces back.
    mirrored.scale(-1, 1, 1);
    flipWinding(mirrored);
    this.add(bone, geo, color, at, opts);
    this.add(mirrorBone(bone), mirrored, color, [-at[0], at[1], at[2]], { ...opts, rot: [r[0], -r[1], -r[2]] });
    return this;
  }

  /** Same as `pair` for a part on a centre bone: placed at +x and -x. */
  sym(bone: BoneName, geo: THREE.BufferGeometry, color: string, at: V3, opts: PartOpts & { glow?: boolean } = {}): this {
    const r = opts.rot ?? [0, 0, 0];
    const mirrored = geo.clone();
    mirrored.scale(-1, 1, 1);
    flipWinding(mirrored);
    this.add(bone, geo, color, at, opts);
    this.add(bone, mirrored, color, [-at[0], at[1], at[2]], { ...opts, rot: [r[0], -r[1], -r[2]] });
    return this;
  }

  build(rest: Omit<Kit, 'bones'>): Kit {
    const bones: Kit['bones'] = {};
    for (const [bone, list] of this.parts) {
      const merge = (geos: THREE.BufferGeometry[]): THREE.BufferGeometry | undefined => {
        if (geos.length === 0) return undefined;
        const m = mergeGeometries(geos, false);
        for (const g of geos) g.dispose();
        m.computeVertexNormals();
        m.computeBoundingSphere();
        return m;
      };
      bones[bone] = { body: merge(list.body), glow: merge(list.glow) };
    }
    this.parts.clear();
    return { bones, ...rest };
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }
}

/** Reverse the order of each triangle's corners (geometry must be non-indexed or indexed). */
function flipWinding(g: THREE.BufferGeometry): void {
  if (g.index) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    g.index.needsUpdate = true;
    return;
  }
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    const s = a.itemSize;
    const arr = a.array;
    for (let i = 0; i < a.count; i += 3) {
      for (let k = 0; k < s; k++) {
        const t = arr[(i + 1) * s + k];
        arr[(i + 1) * s + k] = arr[(i + 2) * s + k];
        arr[(i + 2) * s + k] = t;
      }
    }
    a.needsUpdate = true;
  }
}
