import * as THREE from 'three';
import type { MechFrame } from '@dropline/shared';
import { KitBuilder, block, prism, rod, taper, type BoneMeshes } from '../pilot/rig';

/**
 * The three mech frames, built from parts like the pilot suits (see
 * pilot/rig.ts) on one mech skeleton. Each frame has its own proportions and
 * outline, and each side its own finish: the Corps paint theirs and leave a
 * glass cockpit you can see the pilot through; Z.E.R.O's are matte black with
 * the cockpit armoured shut behind crimson optics.
 *
 * Conventions: 1 unit = 1 metre, facing -Z, +X is the mech's right. Legs hang
 * down their own -Y. The torso's origin is `base` above the feet when standing;
 * the vent and the rocket pod sit where the simulation puts them.
 */

export const MECH_BONES = [
  'hips',
  'torso',
  'hatch',
  'crew',
  'glass',
  'vent',
  'pod',
  'armL',
  'armR',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
] as const;
export type MechBone = (typeof MECH_BONES)[number];
export type MechSkeleton = Record<MechBone, THREE.Object3D>;

type V3 = [number, number, number];
const HALF_PI = Math.PI / 2;
/** The vent's glow: the same hot orange on every frame and side, so the weak point always reads. */
export const VENT_GLOW = '#ff9a2f';
/** Height of the foot block below the ankle. */
export const FOOT = 0.3;

/** The parts of a frame's body that differ. */
export interface MechShape {
  thigh: number;
  shin: number;
  /** Half the distance between the hips. */
  hipX: number;
  /** Thigh and shin thickness. */
  legW: number;
  /** Hull: width, height, depth, and the height of its middle above the torso's origin. */
  torso: [number, number, number, number];
  /** Shoulder joints: out to the side and up from the torso's origin. */
  armX: number;
  armY: number;
  /** Knees that bend backward, like a bird's. */
  reverse: boolean;
  /** Hip and knee angles standing, given for forward knees (reverse knees flip both). */
  stand: [number, number];
}

export const SHAPES: Record<string, MechShape> = {
  halberd: { thigh: 1.1, shin: 1.1, hipX: 0.82, legW: 0.56, torso: [2.2, 1.7, 1.7, 1.15], armX: 1.52, armY: 1.5, reverse: false, stand: [0.28, -0.56] },
  // Squat and wide: short legs set far apart, a deep hull, the arms hung low.
  bastion: { thigh: 0.95, shin: 0.95, hipX: 0.95, legW: 0.68, torso: [2.6, 1.6, 1.9, 1.05], armX: 1.75, armY: 1.25, reverse: false, stand: [0.28, -0.56] },
  // Long, bird-jointed legs, deeply bent, and a small hull carried high.
  lynx: { thigh: 1.2, shin: 1.25, hipX: 0.62, legW: 0.4, torso: [1.6, 1.1, 1.3, 0.8], armX: 1.1, armY: 0.95, reverse: true, stand: [0.5, -1.0] },
};

export const shapeOf = (frame: MechFrame): MechShape => SHAPES[frame.id] ?? SHAPES.halberd;

/** Feet to hip joints for a leg pose. */
export const legReach = (S: MechShape, hip: number, knee: number): number =>
  S.thigh * Math.cos(hip) + S.shin * Math.cos(hip + knee) + FOOT;

/** Torso origin above the feet when standing: what parts placed on the torso are measured from. */
export const torsoBase = (S: MechShape): number => legReach(S, S.stand[0], S.stand[1]) + 0.3;

/** Builds the bones of one mech, posed at rest. The avatar moves them. */
export function buildMechSkeleton(parent: THREE.Object3D, frame: MechFrame): MechSkeleton {
  const S = shapeOf(frame);
  const base = torsoBase(S);
  const [, , , ty] = S.torso;
  const top = ty + S.torso[1] / 2;
  const A = frame.ability;
  const V = frame.vent;
  const at: Record<MechBone, [MechBone | null, number, number, number]> = {
    hips: [null, 0, base - 0.3, 0],
    torso: ['hips', 0, 0.3, 0],
    hatch: ['torso', 0, top + 0.02, 0.55],
    crew: ['torso', 0, 0, 0],
    glass: ['torso', 0, 0, 0],
    vent: ['torso', 0, V.height - base, V.back - 0.12],
    pod: ['torso', A.kind === 'salvo' ? A.side : 0, A.kind === 'salvo' ? A.height - base : 0, 0.05],
    armL: ['torso', -S.armX, S.armY, 0],
    armR: ['torso', S.armX, S.armY, 0],
    thighL: ['hips', -S.hipX, 0, 0],
    shinL: ['thighL', 0, -S.thigh, 0],
    footL: ['shinL', 0, -S.shin, 0],
    thighR: ['hips', S.hipX, 0, 0],
    shinR: ['thighR', 0, -S.thigh, 0],
    footR: ['shinR', 0, -S.shin, 0],
  };
  const bones = {} as MechSkeleton;
  for (const name of MECH_BONES) {
    const b = new THREE.Object3D();
    b.name = name;
    b.position.set(at[name][1], at[name][2], at[name][3]);
    bones[name] = b;
  }
  for (const name of MECH_BONES) {
    const p = at[name][0];
    (p ? bones[p] : parent).add(bones[name]);
  }
  return bones;
}

// ---------------------------------------------------------------------------
// Finishes

export interface Finish {
  paint: string;
  paint2: string;
  frame: string;
  dark: string;
  /** Cable sleeves and soft covers. */
  cloth: string;
  steel: string;
  /** Hazard and unit stripes. */
  stripe: string;
  light: string;
  glass: string;
  /** How much each plate's shade varies. */
  wear: number;
  /** Corps cockpits are glass with a pilot inside; Z.E.R.O's are armoured shut. */
  open: boolean;
}

export const FINISH: Finish[] = [
  { paint: '#6c7783', paint2: '#56606b', frame: '#30353c', dark: '#1d2126', cloth: '#4d5534', steel: '#8b929c', stripe: '#c9a227', light: '#5fe0ff', glass: '#9fd8ee', wear: 0.09, open: true },
  { paint: '#3a3d45', paint2: '#2b2e35', frame: '#1b1d21', dark: '#0e0f12', cloth: '#25282e', steel: '#6a717b', stripe: '#8c1622', light: '#ff2236', glass: '#000000', wear: 0.025, open: false },
];

/** What the avatar needs to know about a built kit besides its meshes. */
export interface MechKit {
  bones: Partial<Record<MechBone, BoneMeshes>>;
  /** Back thrusters (dash or jump jets), in torso space, and which way the flame points. */
  thrusters: { at: V3; down: boolean }[];
  /** The cannon's muzzle in the right arm's space. */
  muzzle: V3;
  /** Where rockets leave the pod, in the pod's space. */
  podMuzzle: V3;
  roughness: number;
  metalness: number;
  /** A faint cast so a black frame never sinks into shadow. */
  emissive: string;
  light: string;
}

type K = KitBuilder<MechBone>;

/** Rotation that lays a thin plate (its local Z) on a hull face with this outward normal in the side profile. */
const onSlope = (forward: number, up: number): V3 => [Math.atan2(up, forward), 0, 0];

/**
 * The hull: a side profile (x forward, y up) extruded the hull's width. The
 * profile's x is turned to point down -Z.
 */
function hull(k: K, profile: [number, number][], width: number, color: string): void {
  k.add('torso', prism(profile, width, 0.06), color, [0, 0, 0], { rot: [0, HALF_PI, 0] });
}

/** A joint drum along X. */
const drum = (r: number, len: number, sides = 10): THREE.BufferGeometry => rod(r, len, sides).rotateZ(HALF_PI);
/** A rod along Z. */
const tube = (r: number, len: number, sides = 8, r2 = r): THREE.BufferGeometry => rod(r, len, sides, r2).rotateX(HALF_PI);

/**
 * The cockpit on the hull's front face at height `y`, `front` metres forward.
 * Corps: a bezel round a glass pane with the pilot seated behind it. Z.E.R.O:
 * the same bay closed by an armoured shutter with optic slits.
 */
function cockpit(k: K, C: Finish, y: number, front: number, w: number, h: number): void {
  const d = 0.42;
  const z = -front - d / 2;
  k.sym('torso', block(0.14, h + 0.16, d), C.paint2, [w / 2 + 0.07, y, z])
    .add('torso', block(w + 0.3, 0.16, d + 0.08), C.paint2, [0, y + h / 2 + 0.08, z - 0.02])
    .add('torso', block(w + 0.3, 0.14, d), C.paint2, [0, y - h / 2 - 0.07, z]);
  if (C.open) {
    k.add('torso', block(w, h, 0.03), C.dark, [0, y, -front - 0.01])
      .add('torso', block(w * 0.8, 0.04, 0.12), C.light, [0, y - h / 2 + 0.03, z - 0.04], { glow: true })
      .add('crew', block(w * 0.4, h * 0.8, 0.08), C.dark, [0, y - 0.04, -front - 0.07])
      .add('crew', block(0.34, 0.3, 0.2), C.cloth, [0, y - 0.1, -front - 0.2])
      .add('crew', block(0.2, 0.22, 0.21, 0.04), '#707a84', [0, y + 0.14, -front - 0.2])
      .add('crew', block(0.15, 0.035, 0.02), C.light, [0, y + 0.15, -front - 0.31], { glow: true })
      .add('glass', block(w, h, 0.03), C.glass, [0, y, -front - d + 0.03]);
  } else {
    k.add('torso', block(w + 0.02, h + 0.02, 0.14), C.paint, [0, y, -front - d + 0.08])
      .add('torso', block(w * 0.7, 0.05, 0.02), C.light, [0, y + h * 0.15, -front - d], { glow: true })
      .sym('torso', block(w * 0.22, 0.035, 0.02), C.light, [w * 0.2, y - h * 0.12, -front - d], { glow: true, rot: [0, 0, 0.35] })
      .add('torso', block(w * 0.9, 0.04, 0.03), C.frame, [0, y - h * 0.32, -front - d + 0.005]);
  }
}

/** The vent on the back: a glowing core behind slats, in a housing. The core is the hit zone's tell. */
function vent(k: K, C: Finish, r: number): void {
  k.add('vent', block(r * 1.3, r * 1.15, 0.08), VENT_GLOW, [0, 0, 0.02], { glow: true })
    .add('vent', block(r * 1.55, r * 1.5, 0.4), C.frame, [0, 0, -0.2]);
  for (let i = -2; i <= 2; i++) k.add('vent', block(r * 1.4, 0.05, 0.08, 0.01), C.dark, [0, i * r * 0.22, 0.09]);
}

/** A normal leg: armoured thigh, a knee drum under a cap, a shin guard with a piston behind, a flat foot. */
function leg(k: K, S: MechShape, C: Finish, toes: number): void {
  const w = S.legW;
  const L = S.thigh;
  const L2 = S.shin;
  k.pair('thighL', block(w * 0.8, L, w), C.frame, [0, -L / 2, 0])
    .pair('thighL', block(w + 0.08, L * 0.72, w * 0.95, 0.05), C.paint, [0, -L * 0.42, -0.04])
    .pair('thighL', prism(taper(w * 0.45, w * 0.8, L * 0.6), 0.08), C.paint2, [0, -L * 0.42, -w * 0.52])
    .pair('thighL', block(0.05, L * 0.4, w * 0.5), C.stripe, [-(w / 2 + 0.05), -L * 0.35, -0.05])
    .pair('thighL', rod(0.06, L * 0.8), C.steel, [0, -L * 0.5, w * 0.55])
    .pair('thighL', block(0.03, 0.22, 0.05), C.light, [-(w / 2 + 0.07), -L * 0.6, -w * 0.2], { glow: true })
    .pair('shinL', drum(w * 0.4, w + 0.12), C.dark, [0, 0, 0])
    .pair('shinL', block(w * 0.9, 0.4, 0.2, 0.05), C.paint, [0, 0.02, -w * 0.62], { rot: [-0.3, 0, 0] })
    .pair('shinL', block(w * 0.6, L2, w * 0.7), C.frame, [0, -L2 / 2, 0.05])
    .pair('shinL', prism(taper(w * 0.95, w * 0.7, L2 * 0.82), 0.16), C.paint, [0, -L2 * 0.5, -w * 0.42])
    .pair('shinL', block(w * 0.75, L2 * 0.45, w * 0.5), C.paint2, [0, -L2 * 0.32, w * 0.35])
    .pair('shinL', rod(0.055, L2 * 0.7), C.steel, [0, -L2 * 0.58, w * 0.6])
    .pair('shinL', drum(w * 0.32, w * 0.9), C.dark, [0, -L2, 0]);
  // The foot: a slab with a toe plate and a heel, and a hazard stripe on the toe.
  const fw = w + 0.24;
  k.pair('footL', block(fw, FOOT, 1.3, 0.05), C.dark, [0, -FOOT / 2, -0.18])
    .pair('footL', block(fw + 0.06, 0.16, 0.45, 0.04), C.paint, [0, -0.07, -0.7], { rot: [0.12, 0, 0] })
    .pair('footL', block(fw * 0.5, 0.03, 0.12), C.stripe, [0, 0.02, -0.76], { rot: [0.12, 0, 0] })
    .pair('footL', block(w * 0.7, 0.22, 0.35), C.paint2, [0, -0.13, 0.5])
    .pair('footL', block(0.08, 0.34, 0.55), C.paint2, [-(w / 2 + 0.08), -0.06, -0.05]);
  // Separate toes splay forward of the slab on the heavy frame.
  for (let i = 0; i < toes; i++) {
    const x = (i - (toes - 1) / 2) * (fw / toes);
    k.pair('footL', block(fw / toes - 0.04, 0.18, 0.35, 0.03), C.frame, [x, -FOOT + 0.09, -0.95], { rot: [0, x * 0.25, 0] });
  }
}

/**
 * A bird-jointed leg: the thigh angles back from the hip, the knee points
 * behind, the long shin comes forward to a foot of two splayed toes and a
 * rear spur.
 */
function birdLeg(k: K, S: MechShape, C: Finish): void {
  const w = S.legW;
  const L = S.thigh;
  const L2 = S.shin;
  k.pair('thighL', block(w * 0.75, L, w * 0.9), C.frame, [0, -L / 2, 0])
    .pair('thighL', block(w + 0.06, L * 0.7, w * 0.8, 0.04), C.paint, [0, -L * 0.4, -0.06])
    .pair('thighL', block(0.04, L * 0.4, w * 0.4), C.stripe, [-(w / 2 + 0.04), -L * 0.38, -0.05])
    .pair('thighL', rod(0.05, L * 0.75), C.steel, [0, -L * 0.5, w * 0.55])
    .pair('thighL', block(0.03, 0.2, 0.04), C.light, [-(w / 2 + 0.06), -L * 0.6, -w * 0.1], { glow: true })
    .pair('shinL', drum(w * 0.42, w + 0.1), C.dark, [0, 0, 0])
    // The knee points back: its cap sits behind.
    .pair('shinL', block(w * 0.85, 0.36, 0.18, 0.04), C.paint, [0, 0.05, w * 0.6], { rot: [0.35, 0, 0] })
    .pair('shinL', block(w * 0.55, L2, w * 0.6), C.frame, [0, -L2 / 2, 0])
    .pair('shinL', prism(taper(w * 0.6, w * 0.85, L2 * 0.8), 0.12), C.paint, [0, -L2 * 0.5, -w * 0.36])
    .pair('shinL', rod(0.05, L2 * 0.7), C.steel, [0, -L2 * 0.5, w * 0.42])
    .pair('shinL', drum(w * 0.3, w * 0.85), C.dark, [0, -L2, 0]);
  k.pair('footL', block(w + 0.04, 0.2, 0.45, 0.04), C.dark, [0, -0.12, 0])
    .pair('footL', block(0.17, 0.18, 0.7, 0.04), C.frame, [-0.12, -FOOT + 0.09, -0.42], { rot: [0, 0.22, 0] })
    .pair('footL', block(0.17, 0.18, 0.7, 0.04), C.frame, [0.12, -FOOT + 0.09, -0.42], { rot: [0, -0.22, 0] })
    .pair('footL', block(0.2, 0.06, 0.3, 0.02), C.paint, [-0.15, -FOOT + 0.2, -0.55], { rot: [0, 0.22, 0] })
    .pair('footL', block(0.2, 0.06, 0.3, 0.02), C.paint, [0.15, -FOOT + 0.2, -0.55], { rot: [0, -0.22, 0] })
    .pair('footL', block(0.12, 0.15, 0.5, 0.03), C.frame, [0, -FOOT + 0.08, 0.38]);
}

/** Hip block and the two hip drums. */
function pelvis(k: K, S: MechShape, C: Finish): void {
  const w = S.hipX * 2;
  k.add('hips', block(w - 0.3, 0.5, 0.95), C.frame, [0, 0.05, 0])
    .sym('hips', drum(S.legW * 0.48, 0.36), C.dark, [S.hipX - 0.1, 0, 0])
    .add('hips', block(w * 0.4, 0.45, 0.12, 0.04), C.paint2, [0, -0.02, -0.5], { rot: [0.2, 0, 0] })
    .sym('hips', block(0.1, 0.55, 0.75, 0.04), C.paint2, [S.hipX + S.legW / 2 + 0.06, 0.05, 0], { rot: [0, 0, 0.12] });
}

/** A rocket pod of four tubes; the tube mouths light up as rockets leave. */
function rocketPod(k: K, C: Finish): void {
  k.add('pod', block(0.95, 0.62, 1.2, 0.06), C.paint, [0, 0, 0])
    .add('pod', block(0.4, 0.4, 0.6), C.frame, [0.25, -0.4, 0.1])
    .add('pod', block(0.99, 0.08, 0.3), C.stripe, [0, 0.2, 0.3]);
  for (const [x, y] of [[-0.2, 0.13], [0.2, 0.13], [-0.2, -0.13], [0.2, -0.13]]) {
    k.add('pod', tube(0.1, 0.06, 8), C.dark, [x, y, -0.61]).add('pod', tube(0.07, 0.02, 8), C.light, [x, y, -0.645], { glow: true });
  }
}

function halberd(k: K, S: MechShape, C: Finish, F: MechFrame): MechKit {
  const [tw, , , ty] = S.torso;
  const top = 2.0;
  pelvis(k, S, C);
  leg(k, S, C, 0);
  // A chest that juts forward over the waist, a flat back.
  hull(k, [[-0.85, 0.3], [0.55, 0.3], [0.95, 0.72], [0.95, 1.6], [0.65, top], [-0.65, top], [-0.85, 1.78]], tw, C.paint);
  k.add('torso', block(tw * 0.6, 0.5, 1.0), C.frame, [0, 0.15, 0])
    .add('torso', block(tw * 0.82, 0.35, 0.08, 0.03), C.paint2, [0, 0.5, -0.78], { rot: onSlope(0.42, -0.4) })
    .sym('torso', block(0.06, 0.9, 1.2), C.paint2, [tw / 2 + 0.02, ty, 0])
    .sym('torso', block(0.07, 0.12, 0.7), C.stripe, [tw / 2 + 0.06, ty + 0.25, -0.1])
    // Power pack high on the back, the antenna mast beside the hatch.
    .add('torso', block(tw * 0.7, 0.8, 0.38, 0.05), C.frame, [0, 1.45, 1.0])
    .add('torso', rod(0.035, 0.9), C.dark, [tw * 0.39, top + 0.45, 0.55])
    .add('torso', block(0.06, 0.06, 0.06), C.light, [tw * 0.39, top + 0.92, 0.55], { glow: true });
  cockpit(k, C, 1.42, 0.95, 1.14, 0.62);
  vent(k, C, F.vent.radius);
  // The hatch sits right of centre, clear of the rocket pod on the left shoulder.
  k.add('hatch', block(0.8, 0.14, 1.1, 0.04), C.paint2, [0.15, 0.07, -0.55]).add('hatch', block(0.36, 0.06, 0.1), C.dark, [0.15, 0.16, -0.95]);
  // Dash thrusters either side of the pack.
  const thrusters: MechKit['thrusters'] = [];
  for (const x of [-0.75, 0.75]) {
    k.add('torso', tube(0.2, 0.3, 10, 0.26), C.dark, [x, 1.3, 1.3]);
    thrusters.push({ at: [x, 1.3, 1.55], down: false });
  }

  // Right arm: the autocannon, a shrouded barrel over a feed, an ammo drum outboard.
  k.add('armR', drum(0.3, 0.3), C.dark, [-0.2, 0, 0])
    .add('armR', block(0.85, 0.55, 0.95, 0.08), C.paint, [0.05, 0.22, 0])
    .add('armR', block(0.89, 0.08, 0.3), C.stripe, [0.05, 0.3, 0.25])
    .add('armR', block(0.6, 0.72, 1.6, 0.05), C.paint2, [0, -0.2, -0.35])
    .add('armR', tube(0.2, 1.0, 8), C.frame, [0, -0.1, -1.4])
    .add('armR', tube(0.12, 1.7), C.dark, [0, -0.1, -1.7])
    .add('armR', block(0.34, 0.34, 0.24, 0.04), C.dark, [0, -0.1, -2.5])
    .add('armR', tube(0.08, 1.3), C.dark, [0, -0.38, -1.5])
    .add('armR', drum(0.3, 0.32, 12), C.steel, [0.45, -0.3, 0.05])
    .add('armR', block(0.14, 0.14, 0.6), C.frame, [0.38, -0.3, -0.4]);
  for (const z of [-1.1, -1.3, -1.5, -1.7]) k.add('armR', block(0.3, 0.03, 0.06), C.dark, [0, 0.11, z]);
  // Left arm: a heavy fist.
  k.add('armL', drum(0.3, 0.3), C.dark, [0.2, 0, 0])
    .add('armL', block(0.85, 0.55, 0.95, 0.08), C.paint, [-0.05, 0.22, 0])
    .add('armL', block(0.52, 1.25, 0.56, 0.05), C.paint2, [0, -0.72, 0])
    .add('armL', drum(0.24, 0.6), C.dark, [0, -1.3, 0])
    .add('armL', block(0.62, 0.5, 0.66, 0.06), C.frame, [0, -1.58, -0.04])
    .add('armL', block(0.66, 0.22, 0.3, 0.04), C.paint, [0, -1.5, -0.3]);
  for (const x of [-0.2, 0, 0.2]) k.add('armL', block(0.16, 0.3, 0.18, 0.03), C.dark, [x, -1.88, -0.14]);
  rocketPod(k, C);
  return finish(k, C, thrusters, [0, -0.1, -2.66]);
}

function bastion(k: K, S: MechShape, C: Finish, F: MechFrame): MechKit {
  const [tw, , td] = S.torso;
  const top = 1.85;
  pelvis(k, S, C);
  leg(k, S, C, 3);
  // Stomp rams: a piston down the front of each shin.
  k.pair('shinL', rod(0.09, S.shin * 0.75), C.steel, [-(S.legW * 0.32), -S.shin * 0.45, -S.legW * 0.62])
    .pair('shinL', block(0.2, 0.2, 0.2), C.frame, [-(S.legW * 0.32), -S.shin * 0.08, -S.legW * 0.62]);
  // A hunched hull with a heavy glacis.
  hull(k, [[-0.95, 0.25], [0.7, 0.25], [1.05, 0.6], [1.05, 1.25], [0.75, 1.7], [0.2, top + 0.05], [-0.6, top + 0.05], [-0.95, 1.6]], tw, C.paint);
  k.add('torso', block(tw * 0.6, 0.5, 1.1), C.frame, [0, 0.12, 0])
    .add('torso', block(tw * 0.86, 0.42, 0.12, 0.04), C.paint2, [0, 0.43, -0.9], { rot: onSlope(0.35, -0.35) })
    .add('torso', block(tw * 0.92, 0.3, 0.55, 0.06), C.paint2, [0, top + 0.08, -0.15])
    .sym('torso', block(0.95, 0.35, 1.5, 0.06), C.paint, [tw / 2 + 0.05, top + 0.05, 0])
    .sym('torso', block(0.99, 0.08, 0.3), C.stripe, [tw / 2 + 0.05, top + 0.1, -0.55])
    .add('torso', block(tw * 0.75, 0.65, 0.4, 0.05), C.frame, [0, 1.5, td / 2 + 0.15])
    // Two exhaust stacks up the back: the Bastion's tell from behind.
    .sym('torso', rod(0.15, 1.1, 10), C.dark, [0.75, top + 0.2, td / 2 + 0.05])
    .sym('torso', rod(0.18, 0.12, 10), C.frame, [0.75, top + 0.76, td / 2 + 0.05]);
  cockpit(k, C, 1.25, 1.05, 1.1, 0.5);
  vent(k, C, F.vent.radius);
  k.add('hatch', block(1.1, 0.14, 1.1, 0.04), C.paint2, [0, 0.07, -0.55]);

  // Right arm: the Breaker, a short fat tube over a shell drum.
  k.add('armR', drum(0.34, 0.3), C.dark, [-0.25, 0, 0])
    .add('armR', block(0.95, 0.7, 0.85, 0.08), C.paint, [0.05, 0.15, 0])
    .add('armR', block(0.8, 0.85, 1.4, 0.06), C.paint2, [0, -0.22, -0.3])
    .add('armR', tube(0.3, 1.2, 10), C.dark, [0, -0.12, -1.3])
    .add('armR', tube(0.38, 0.28, 10), C.frame, [0, -0.12, -1.95])
    .add('armR', tube(0.22, 0.04, 10), C.dark, [0, -0.12, -2.1])
    .add('armR', drum(0.3, 0.6, 12), C.steel, [0, -0.78, -0.6])
    .add('armR', block(0.99, 0.08, 0.3), C.stripe, [0.05, 0.3, 0.3]);
  // Left arm: the shield emitter, a slab the wall unfolds from.
  k.add('armL', drum(0.34, 0.3), C.dark, [0.25, 0, 0])
    .add('armL', block(0.95, 0.7, 0.85, 0.08), C.paint, [-0.05, 0.15, 0])
    .add('armL', block(0.5, 1.6, 0.7, 0.05), C.paint2, [-0.05, -0.75, -0.1])
    .add('armL', block(0.22, 2.1, 1.6, 0.06), C.paint, [-0.3, -0.8, -0.35])
    .add('armL', block(0.06, 1.7, 0.08), C.stripe, [-0.42, -0.8, -1.12])
    .add('armL', block(0.04, 1.5, 1.1), C.light, [-0.43, -0.8, -0.35], { glow: true })
    .add('armL', block(0.08, 1.7, 1.25), C.frame, [-0.4, -0.8, -0.35]);
  return finish(k, C, [], [0, -0.12, -2.1]);
}

function lynx(k: K, S: MechShape, C: Finish, F: MechFrame): MechKit {
  const [tw, , td, ty] = S.torso;
  const top = 1.35;
  pelvis(k, S, C);
  birdLeg(k, S, C);
  // A small hull with a pointed nose.
  hull(k, [[-0.65, 0.3], [0.4, 0.25], [1.05, 0.7], [0.9, 1.0], [0.4, top], [-0.55, top], [-0.65, 1.1]], tw, C.paint);
  k.add('torso', block(tw * 0.55, 0.45, 0.8), C.frame, [0, 0.12, 0])
    .sym('torso', block(0.05, 0.08, 0.7), C.stripe, [tw / 2 + 0.03, ty + 0.2, -0.1])
    // The fin on top, its tell from far off.
    .add('torso', prism([[-0.5, 0], [0.4, 0], [-0.35, 0.75]], 0.08), C.paint2, [0, top, 0.55], { rot: [0, HALF_PI, 0] });
  // The canopy rides on the nose: glass over the pilot for the Corps, an armoured dome with one optic for Z.E.R.O.
  const cz = -0.2;
  const cy = top + 0.12;
  if (C.open) {
    k.add('torso', block(0.72, 0.06, 0.86), C.paint2, [0, top + 0.02, cz])
      .add('crew', block(0.3, 0.22, 0.2), C.cloth, [0, cy - 0.04, cz + 0.05])
      .add('crew', block(0.19, 0.2, 0.2, 0.04), '#707a84', [0, cy + 0.14, cz + 0.02])
      .add('crew', block(0.14, 0.03, 0.02), C.light, [0, cy + 0.15, cz - 0.09], { glow: true })
      .add('glass', block(0.66, 0.5, 0.76, 0.08), C.glass, [0, cy + 0.05, cz]);
  } else {
    k.add('torso', block(0.68, 0.38, 0.8, 0.1), C.paint, [0, cy + 0.03, cz])
      .add('torso', block(0.5, 0.05, 0.02), C.light, [0, cy + 0.06, cz - 0.41], { glow: true });
  }
  vent(k, C, F.vent.radius);
  k.add('hatch', block(0.8, 0.1, 0.8, 0.03), C.paint2, [0, 0.05, -0.4]);
  // Jump-jet packs on the back, where the leap's flames come out.
  const thrusters: MechKit['thrusters'] = [];
  for (const x of [-0.58, 0.58]) {
    k.add('torso', block(0.34, 1.25, 0.5, 0.05), C.frame, [x, ty + 0.35, td / 2 + 0.2])
      .add('torso', block(0.38, 0.2, 0.54, 0.04), C.paint, [x, ty + 0.95, td / 2 + 0.2])
      .add('torso', rod(0.18, 0.2, 10, 0.14), C.dark, [x, ty - 0.35, td / 2 + 0.2]);
    thrusters.push({ at: [x, ty - 0.75, td / 2 + 0.2], down: true });
  }

  // Right arm: the Lance, two long rails with coils between them.
  k.add('armR', drum(0.22, 0.25), C.dark, [-0.15, 0, 0])
    .add('armR', block(0.45, 0.42, 0.55, 0.05), C.paint, [0, 0.1, 0])
    .add('armR', block(0.38, 0.5, 1.1, 0.04), C.paint2, [0, -0.12, -0.25])
    .add('armR', block(0.1, 0.18, 2.6, 0.02), C.dark, [-0.1, -0.05, -1.75])
    .add('armR', block(0.1, 0.18, 2.6, 0.02), C.dark, [0.1, -0.05, -1.75])
    .add('armR', block(0.3, 0.06, 0.4), C.frame, [0, -0.17, -0.9])
    .add('armR', block(0.3, 0.06, 0.25), C.frame, [0, -0.17, -2.9]);
  for (const z of [-1.1, -1.7, -2.3, -2.9]) k.add('armR', block(0.12, 0.05, 0.08), C.light, [0, -0.05, z], { glow: true });
  // Left arm: slim, ending in a sensor block.
  k.add('armL', drum(0.22, 0.25), C.dark, [0.15, 0, 0])
    .add('armL', block(0.45, 0.42, 0.55, 0.05), C.paint, [0, 0.1, 0])
    .add('armL', block(0.3, 1.1, 0.34, 0.04), C.paint2, [0, -0.6, 0])
    .add('armL', block(0.4, 0.34, 0.44, 0.05), C.frame, [0, -1.25, -0.04])
    .add('armL', block(0.2, 0.05, 0.02), C.light, [0, -1.22, -0.27], { glow: true });
  return finish(k, C, thrusters, [0, -0.05, -3.1]);
}

function finish(k: K, C: Finish, thrusters: MechKit['thrusters'], muzzle: V3): MechKit {
  return {
    bones: k.merged(),
    thrusters,
    muzzle,
    podMuzzle: [0, 0, -0.7],
    roughness: C.open ? 0.62 : 0.5,
    metalness: C.open ? 0.35 : 0.5,
    emissive: C.open ? '#000000' : '#2a0307',
    light: C.light,
  };
}

const BUILDERS: Record<string, (k: K, S: MechShape, C: Finish, F: MechFrame) => MechKit> = { halberd, bastion, lynx };
const kits = new Map<string, MechKit>();

/** A frame's model in a side's finish (0 the Corps, 1 Z.E.R.O). Built on first use and shared. */
export function mechKit(frame: MechFrame, team: number): MechKit {
  const t = team === 1 ? 1 : 0;
  const key = `${frame.id}:${t}`;
  let kit = kits.get(key);
  if (!kit) {
    const C = FINISH[t];
    kit = (BUILDERS[frame.id] ?? halberd)(new KitBuilder<MechBone>(C.wear), shapeOf(frame), C, frame);
    kits.set(key, kit);
  }
  return kit;
}
