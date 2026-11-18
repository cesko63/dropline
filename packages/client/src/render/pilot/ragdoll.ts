import * as THREE from 'three';
import { COMBAT, RAPIER, TUNING, eulerDegToQuat, type MapBox, type Vec3 } from '@dropline/shared';
import type { BoneName, Skeleton } from './rig';

/**
 * Dead pilots as physics ragdolls. A body is eleven rigid pieces on the pilot
 * skeleton, joined at the hips, waist, neck, shoulders, elbows and knees, each
 * joint held inside a human range. The muscles keep a little hold for a moment
 * after death (the legs give first, the neck and spine last), then the body is
 * dead weight: it keeps the speed it died with, takes the blow that killed it,
 * and tumbles, slides and comes to rest against the map. A pilot killed in the
 * air leaves a jet pack nobody is flying: it fires in bursts for a few seconds
 * and throws the body around before it dies.
 *
 * Client-side only: every player sees their own ragdolls, which is fine for
 * something that only decorates.
 */

type V3 = [number, number, number];

type Shape = { box: V3; at: V3 } | { capsule: [number, number]; at: V3 } | { ball: number; at: V3 };

interface Piece {
  bone: BoneName;
  parent: BoneName | null;
  /** kg */
  mass: number;
  /** In the bone's own space; limbs hang down their -Y. */
  shapes: Shape[];
  /** `hinge` bends about the bone's X only (knees, elbows). */
  joint: 'ball' | 'hinge';
  /** Angle range per axis (X, Y, Z) against the parent piece, radians, in the skeleton's conventions. */
  lo: V3;
  hi: V3;
  /** Seconds the muscles keep some hold after death. */
  tone: number;
  /** Joint friction: how fast the joint's own spin dies. */
  damp: number;
  /** The bone between the parent piece and this one (the chest): its own turn shifts the range. */
  via?: BoneName;
  group: number;
}

// Collision groups: the map, the trunk, the arms, the legs. Arms pass through
// their own trunk (a hand across the chest must not shove it), legs hit everything.
const WORLD = 1;
const TRUNK = 2;
const ARM = 4;
const LEG = 8;
const FILTER: Record<number, number> = {
  [WORLD]: 0xffff,
  [TRUNK]: WORLD | TRUNK | LEG,
  [ARM]: WORLD | ARM | LEG,
  [LEG]: WORLD | TRUNK | ARM | LEG,
};
const groups = (member: number): number => (member << 16) | FILTER[member];

const arm = (side: 1 | -1, gun: boolean): Piece[] => [
  {
    bone: side < 0 ? 'upperArmL' : 'upperArmR',
    parent: 'spine',
    via: 'chest',
    mass: 2.5,
    shapes: [{ capsule: [0.1, 0.055], at: [0, -0.15, 0] }],
    joint: 'ball',
    // Back and forward, twist, and out to the side (out is -Z on the left, +Z on the right).
    lo: [-1.2, -1, side < 0 ? -2.4 : -0.25],
    hi: [2.8, 1, side < 0 ? 0.25 : 2.4],
    tone: 0.25,
    damp: 2.5,
    group: ARM,
  },
  {
    bone: side < 0 ? 'foreArmL' : 'foreArmR',
    parent: side < 0 ? 'upperArmL' : 'upperArmR',
    // The arm gun's housing makes the right forearm the heavier.
    mass: gun ? 3.2 : 2,
    shapes: [{ capsule: [0.12, 0.05], at: [0, -0.17, 0] }],
    joint: 'hinge',
    lo: [0, 0, 0],
    hi: [2.5, 0, 0],
    tone: 0.2,
    damp: 1.5,
    group: ARM,
  },
];

const leg = (side: 1 | -1): Piece[] => [
  {
    bone: side < 0 ? 'thighL' : 'thighR',
    parent: 'hips',
    mass: 9,
    shapes: [{ capsule: [0.13, 0.075], at: [0, -0.21, 0] }],
    joint: 'ball',
    lo: [-0.5, -0.6, side < 0 ? -0.9 : -0.2],
    hi: [2.2, 0.6, side < 0 ? 0.2 : 0.9],
    tone: 0.15,
    damp: 3,
    group: LEG,
  },
  {
    bone: side < 0 ? 'shinL' : 'shinR',
    parent: side < 0 ? 'thighL' : 'thighR',
    mass: 4.5,
    shapes: [
      { capsule: [0.13, 0.06], at: [0, -0.2, 0] },
      // The boot, out in front of the ankle.
      { box: [0.05, 0.035, 0.1], at: [0, -0.43, -0.05] },
    ],
    joint: 'hinge',
    lo: [-2.8, 0, 0],
    hi: [0, 0, 0],
    tone: 0.12,
    damp: 2,
    group: LEG,
  },
];

/** Parents before children, so a pass in this order always finds the parent placed. */
const PIECES: Piece[] = [
  { bone: 'hips', parent: null, mass: 12, shapes: [{ box: [0.15, 0.1, 0.11], at: [0, 0, 0] }], joint: 'ball', lo: [0, 0, 0], hi: [0, 0, 0], tone: 0, damp: 0, group: TRUNK },
  {
    bone: 'spine',
    parent: 'hips',
    mass: 28,
    // The jet pack rides on the back, so the box sits a little behind the spine.
    shapes: [{ box: [0.16, 0.2, 0.13], at: [0, 0.25, 0.02] }],
    joint: 'ball',
    // Bends forward (negative X) further than back.
    lo: [-0.9, -0.5, -0.35],
    hi: [0.35, 0.5, 0.35],
    tone: 0.5,
    damp: 6,
    group: TRUNK,
  },
  {
    bone: 'neck',
    parent: 'spine',
    via: 'chest',
    mass: 5,
    shapes: [{ ball: 0.12, at: [0, 0.17, -0.01] }],
    joint: 'ball',
    lo: [-0.8, -1, -0.45],
    hi: [0.6, 1, 0.45],
    tone: 0.4,
    damp: 5,
    group: TRUNK,
  },
  ...arm(-1, false),
  ...arm(1, true),
  ...leg(-1),
  ...leg(1),
];
const TOTAL_MASS = PIECES.reduce((m, p) => m + p.mass, 0);
const SPINE = PIECES.findIndex((p) => p.bone === 'spine');
/** Bones with no piece of their own that relax once the body is dead weight. */
const LOOSE: BoneName[] = ['head', 'handL', 'handR', 'footL', 'footR'];

/** Muscle hold, as a spring toward the pose the pilot died in: angular acceleration per radian. */
const TONE = 45;
const STEP = 1 / 120;
/** At most this many steps a frame; a long stall drops time rather than spiralling. */
const MAX_STEPS = 6;
/** Bodies lie this long, then sink away. */
const LIE = 15;
const SINK = 2.5;
const MAX_CORPSES = 10;
/** Where the runaway jet pushes from, in the spine piece's space: between the shoulder blades, at the back. */
const JET_AT = new THREE.Vector3(0, 0.3, 0.16);
const MAX_JET_SPEED = 16;

/** Everything a dead pilot leaves to the ragdoll (see Avatar.corpse). */
export interface CorpseParts {
  /** A copy of the pilot's body to lie there; the ragdoll places it in the world. */
  body: THREE.Object3D;
  /** The copy's bones. */
  bones: Skeleton;
  /** World transforms of the living pilot's bones at the moment of death. */
  pose: Record<BoneName, THREE.Matrix4>;
  /** How fast each bone was moving then, m/s. */
  vel: Record<BoneName, THREE.Vector3>;
  /** The jet pack's flames on the copy. */
  flames: THREE.Object3D[];
  /** The copy's own suit lights, which die with it. */
  lights: THREE.MeshBasicMaterial;
  halo: THREE.SpriteMaterial;
  haloOpacity: number;
  /** Lights that flicker as they go (a Z.E.R.O frame). */
  flicker: boolean;
  team: number;
  /** Things made for the copy alone, freed with it. */
  owned: { dispose(): void }[];
}

/** The blow that killed: where it struck, the way it flew (unit), and how hard (N·s). */
export interface Blow {
  at: Vec3;
  dir: Vec3;
  power: number;
}

export interface CorpseHooks {
  /** A body has come to rest; `at` is its hips. */
  settled(at: THREE.Vector3, team: number): void;
  /** A runaway jet is burning at `at`, its exhaust along `dir` (unit); `burst` on the first frame of each burst. */
  jet(at: THREE.Vector3, dir: THREE.Vector3, burst: boolean): void;
  /** A runaway jet has burned out at `at`. */
  jetOut(at: THREE.Vector3): void;
}

interface Jet {
  left: number;
  burst: number;
  on: boolean;
  power: number;
  /** Set when a burst starts, cleared once the hooks have heard of it. */
  fresh: boolean;
  /** The nozzle swivels loose: a slow wander of the thrust line. */
  wobble: number;
  /** Seconds to the next puff of exhaust drawn. */
  puff: number;
}

interface Corpse {
  id: number;
  parts: CorpseParts;
  bodies: RAPIER.RigidBody[];
  joints: (RAPIER.ImpulseJoint | null)[];
  /** The pose at death, per joint and axis, as the joint measures it. */
  targets: V3[];
  age: number;
  still: number;
  settled: boolean;
  jet: Jet | null;
  /** Taken out of the physics: sinking away. */
  sinking: boolean;
}

/** The joint set's own calls, which also reach the angular axes of a ball joint. */
interface RawJoints {
  jointSetLimits(handle: number, axis: number, min: number, max: number): void;
  jointConfigureMotor(handle: number, axis: number, targetPos: number, targetVel: number, stiffness: number, damping: number): void;
}
const raw = (j: RAPIER.ImpulseJoint): RawJoints => (j as unknown as { rawSet: RawJoints }).rawSet;
const ANG = [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ];

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** A joint's angle on each axis, as Rapier measures it: twice the asin of the relative rotation's parts. */
const angles = (q: THREE.Quaternion): V3 => {
  const s = q.w < 0 ? -1 : 1;
  return [2 * Math.asin(clamp(q.x * s, -1, 1)), 2 * Math.asin(clamp(q.y * s, -1, 1)), 2 * Math.asin(clamp(q.z * s, -1, 1))];
};

const ONE = new THREE.Vector3(1, 1, 1);
const IDENTITY = new THREE.Quaternion();
const m4 = new THREE.Matrix4();
const inv = new THREE.Matrix4();
const pos = new THREE.Vector3();
const rot = new THREE.Quaternion();
const rot2 = new THREE.Quaternion();
const scl = new THREE.Vector3();
const v = new THREE.Vector3();
const w = new THREE.Vector3();

export class Ragdolls {
  private readonly world: RAPIER.World;
  private readonly corpses: Corpse[] = [];
  private acc = 0;

  /** The engine must be loaded first (`physicsReady`); `boxes` are the map's solid boxes. */
  constructor(
    private readonly scene: THREE.Object3D,
    boxes: readonly MapBox[],
    private readonly hooks: CorpseHooks,
  ) {
    this.world = new RAPIER.World({ x: 0, y: -TUNING.air.gravity, z: 0 });
    this.world.timestep = STEP;
    // Long joint chains need more passes than the default to hold together.
    this.world.numSolverIterations = 8;
    for (const box of boxes) {
      const desc = RAPIER.ColliderDesc.cuboid(box.size[0] / 2, box.size[1] / 2, box.size[2] / 2)
        .setTranslation(box.pos[0], box.pos[1], box.pos[2])
        .setRotation(eulerDegToQuat(box.rot))
        .setFriction(0.6)
        .setCollisionGroups(groups(WORLD));
      this.world.createCollider(desc);
    }
  }

  /**
   * A pilot dies: its body goes limp from the pose and speed it had. `blow` is
   * what killed it; `jet` leaves its jet pack firing on its own (killed in the air).
   */
  spawn(id: number, parts: CorpseParts, blow: Blow | null, jet: boolean): void {
    const body = parts.body;
    body.position.set(0, 0, 0);
    body.quaternion.identity();
    body.scale.set(1, 1, 1);
    this.scene.add(body);

    const lift = this.lift(parts.pose);
    const bodies: RAPIER.RigidBody[] = [];
    const joints: (RAPIER.ImpulseJoint | null)[] = [];
    const targets: V3[] = [];
    for (const piece of PIECES) {
      parts.pose[piece.bone].decompose(pos, rot, scl);
      const vel = parts.vel[piece.bone];
      const rb = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(pos.x, pos.y + lift, pos.z)
          .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
          .setLinvel(vel.x, vel.y, vel.z)
          .setLinearDamping(0.05)
          .setAngularDamping(0.8)
          .setCcdEnabled(true),
      );
      const share = piece.mass / piece.shapes.length;
      for (const s of piece.shapes) {
        const desc =
          'box' in s
            ? RAPIER.ColliderDesc.cuboid(s.box[0], s.box[1], s.box[2])
            : 'capsule' in s
              ? RAPIER.ColliderDesc.capsule(s.capsule[0], s.capsule[1])
              : RAPIER.ColliderDesc.ball(s.ball);
        desc.setTranslation(s.at[0], s.at[1], s.at[2]).setMass(share).setFriction(0.9).setRestitution(0.05).setCollisionGroups(groups(piece.group));
        this.world.createCollider(desc, rb);
      }
      bodies.push(rb);
      if (!piece.parent) {
        joints.push(null);
        targets.push([0, 0, 0]);
        continue;
      }
      const p = PIECES.findIndex((q) => q.bone === piece.parent);
      // The joint sits at this bone's own pivot, written in the parent piece's space.
      inv.copy(parts.pose[piece.parent]).invert();
      v.copy(pos).applyMatrix4(inv);
      parts.pose[piece.parent].decompose(w, rot2, scl);
      const target = angles(rot2.invert().multiply(rot));
      targets.push(target);
      const data =
        piece.joint === 'hinge'
          ? RAPIER.JointData.revolute({ x: v.x, y: v.y, z: v.z }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })
          : RAPIER.JointData.spherical({ x: v.x, y: v.y, z: v.z }, { x: 0, y: 0, z: 0 });
      const joint = this.world.createImpulseJoint(data, bodies[p], rb, true);
      joint.setContactsEnabled(false);
      const r = raw(joint);
      // The chest's own lean and twist at death count as part of the range.
      const off = piece.via ? angles(parts.bones[piece.via].quaternion) : [0, 0, 0];
      for (let k = 0; k < (piece.joint === 'hinge' ? 1 : 3); k++) {
        // Never start outside the range: the joint would snap the limb back into it.
        const lo = Math.min(piece.lo[k] + off[k], target[k] - 0.05);
        const hi = Math.max(piece.hi[k] + off[k], target[k] + 0.05);
        r.jointSetLimits(joint.handle, ANG[k], lo, hi);
      }
      joints.push(joint);
    }

    if (blow) {
      // The round lands on the piece nearest where it struck.
      let best = SPINE;
      let bestD = Infinity;
      for (let i = 0; i < bodies.length; i++) {
        const t = bodies[i].translation();
        const d = (t.x - blow.at.x) ** 2 + (t.y - blow.at.y) ** 2 + (t.z - blow.at.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      bodies[best].applyImpulseAtPoint(
        { x: blow.dir.x * blow.power, y: blow.dir.y * blow.power, z: blow.dir.z * blow.power },
        { x: blow.at.x, y: blow.at.y, z: blow.at.z },
        true,
      );
      // And some of it carries the whole body, so a heavy hit knocks it down rather than only twisting it.
      const carry = (blow.power * 0.35) / TOTAL_MASS;
      for (const rb of bodies) {
        const lv = rb.linvel();
        rb.setLinvel({ x: lv.x + blow.dir.x * carry, y: lv.y + Math.max(0, blow.dir.y) * carry, z: lv.z + blow.dir.z * carry }, true);
      }
    }

    const corpse: Corpse = {
      id,
      parts,
      bodies,
      joints,
      targets,
      age: 0,
      still: 0,
      settled: false,
      jet: jet ? { left: rand(2, 3.4), burst: rand(0.2, 0.45), on: true, power: rand(1.3, 1.9), fresh: true, wobble: Math.random() * 10, puff: 0 } : null,
      sinking: false,
    };
    this.corpses.push(corpse);
    this.tone(corpse);
    this.place(corpse, 0);
    // Too many bodies: the oldest still lying there sinks away early.
    const lying = this.corpses.filter((c) => !c.sinking);
    if (lying.length > MAX_CORPSES) this.sink(lying[0]);
  }

  /** The hips of the newest body actor `id` left, or null if there is none. */
  hipsOf(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      if (c.id === id && !c.sinking) return c.parts.bones.hips.getWorldPosition(out);
    }
    return null;
  }

  update(dt: number): void {
    if (this.corpses.length === 0) return;
    for (const c of this.corpses) if (!c.sinking && c.age < 1) this.tone(c);
    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      for (const c of this.corpses) if (c.jet && !c.sinking) this.burn(c, STEP);
      this.world.step();
    }

    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.age += dt;
      this.fadeLights(c);
      if (c.sinking) {
        // Down through the floor and gone.
        c.parts.body.position.y -= (0.6 / SINK) * dt;
        if (c.age > LIE + SINK) this.remove(i);
        continue;
      }
      this.place(c, dt);
      this.jetFx(c, dt);
      const spine = c.bodies[SPINE];
      const t = spine.translation();
      if (t.y < COMBAT.killY) {
        this.remove(i);
        continue;
      }
      if (!c.settled) {
        const lv = spine.linvel();
        c.still = Math.hypot(lv.x, lv.y, lv.z) < 0.3 && !c.jet ? c.still + dt : 0;
        if (c.still > 0.5) {
          c.settled = true;
          this.hooks.settled(c.parts.bones.hips.getWorldPosition(v), c.parts.team);
        }
      }
      if (c.age > LIE) this.sink(c);
    }
  }

  /** Every body gone at once (a new match). */
  clear(): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) this.remove(i);
  }

  dispose(): void {
    this.clear();
    this.world.free();
  }

  /**
   * How far to raise a body so no part starts inside the floor: a low pose (a
   * slide, a deep crouch) can dip a boot or a knee into it, and the physics
   * would throw the body out.
   */
  private lift(pose: Record<BoneName, THREE.Matrix4>): number {
    let low = Infinity;
    for (const piece of PIECES) {
      const m = pose[piece.bone];
      for (const s of piece.shapes) {
        if ('box' in s) {
          for (let k = 0; k < 8; k++) {
            v.set(s.at[0] + (k & 1 ? 1 : -1) * s.box[0], s.at[1] + (k & 2 ? 1 : -1) * s.box[1], s.at[2] + (k & 4 ? 1 : -1) * s.box[2]).applyMatrix4(m);
            low = Math.min(low, v.y);
          }
        } else {
          const [half, r] = 'capsule' in s ? s.capsule : [0, s.ball];
          for (const end of [-half, half]) low = Math.min(low, v.set(s.at[0], s.at[1] + end, s.at[2]).applyMatrix4(m).y - r);
        }
      }
    }
    const hips = pos.setFromMatrixPosition(pose.hips);
    const ray = new RAPIER.Ray({ x: hips.x, y: hips.y + 0.5, z: hips.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, 3, true, undefined, (0xffff << 16) | WORLD);
    if (!hit) return 0;
    const floor = hips.y + 0.5 - hit.timeOfImpact;
    return Math.min(0.6, Math.max(0, floor + 0.01 - low));
  }

  /** The muscles' hold, fading from the pose at death to nothing; joint friction stays. */
  private tone(c: Corpse): void {
    for (let i = 0; i < PIECES.length; i++) {
      const joint = c.joints[i];
      if (!joint) continue;
      const piece = PIECES[i];
      const left = piece.tone > 0 ? Math.max(0, 1 - c.age / piece.tone) : 0;
      const k = TONE * left * left;
      const r = raw(joint);
      for (let a = 0; a < (piece.joint === 'hinge' ? 1 : 3); a++) r.jointConfigureMotor(joint.handle, ANG[a], c.targets[i][a], 0, k, piece.damp);
    }
  }

  /** One step of a jet pack nobody flies: bursts and stalls, pushing along the spine. */
  private burn(c: Corpse, h: number): void {
    const jet = c.jet!;
    jet.left -= h;
    jet.burst -= h;
    jet.wobble += h;
    if (jet.left <= 0) {
      c.jet = null;
      for (const f of c.parts.flames) f.visible = false;
      this.hooks.jetOut(this.nozzle(c, v));
      return;
    }
    if (jet.burst <= 0) {
      // Mostly it fires; now and then it chokes for a moment.
      jet.on = !jet.on || Math.random() < 0.3;
      jet.burst = jet.on ? rand(0.15, 0.55) : rand(0.05, 0.25);
      jet.power = rand(1.1, 2.1);
      if (jet.on) jet.fresh = true;
    }
    if (!jet.on) return;
    const spine = c.bodies[SPINE];
    const r = spine.rotation();
    rot.set(r.x, r.y, r.z, r.w);
    // Thrust runs up the spine, its line wandering as the loose nozzle swings.
    w.set(Math.sin(jet.wobble * 5.3) * 0.35, 1, Math.sin(jet.wobble * 3.7 + 1) * 0.35 - 0.15).normalize().applyQuaternion(rot);
    const lv = spine.linvel();
    if (lv.x * w.x + lv.y * w.y + lv.z * w.z > MAX_JET_SPEED) return;
    const j = jet.power * TOTAL_MASS * TUNING.air.gravity * h;
    this.nozzle(c, v);
    spine.applyImpulseAtPoint({ x: w.x * j, y: w.y * j, z: w.z * j }, { x: v.x, y: v.y, z: v.z }, true);
  }

  /** World position of the jet nozzle, written to `out`. */
  private nozzle(c: Corpse, out: THREE.Vector3): THREE.Vector3 {
    const t = c.bodies[SPINE].translation();
    const r = c.bodies[SPINE].rotation();
    return out.copy(JET_AT).applyQuaternion(rot.set(r.x, r.y, r.z, r.w)).add(pos.set(t.x, t.y, t.z));
  }

  private jetFx(c: Corpse, dt: number): void {
    const jet = c.jet;
    const on = jet !== null && jet.on;
    for (const f of c.parts.flames) {
      f.visible = on;
      f.scale.y = 0.7 + Math.random() * 0.9;
    }
    if (!on) return;
    // Exhaust at a steady rate whatever the frame rate.
    jet.puff -= dt;
    if (jet.puff > 0 && !jet.fresh) return;
    jet.puff = 1 / 30;
    const r = c.bodies[SPINE].rotation();
    w.set(0, -1, 0).applyQuaternion(rot.set(r.x, r.y, r.z, r.w));
    this.hooks.jet(this.nozzle(c, v), w, jet.fresh);
    jet.fresh = false;
  }

  /** Put the body's bones where its pieces are. */
  private place(c: Corpse, dt: number): void {
    const bones = c.parts.bones;
    for (let i = 0; i < PIECES.length; i++) {
      const bone = bones[PIECES[i].bone];
      const t = c.bodies[i].translation();
      const r = c.bodies[i].rotation();
      const parent = bone.parent!;
      parent.updateWorldMatrix(true, false);
      m4.compose(pos.set(t.x, t.y, t.z), rot.set(r.x, r.y, r.z, r.w), ONE);
      m4.premultiply(inv.copy(parent.matrixWorld).invert());
      m4.decompose(bone.position, bone.quaternion, scl);
    }
    // The head, hands and feet go slack.
    const slack = 1 - Math.exp(-4 * dt);
    for (const b of LOOSE) bones[b].quaternion.slerp(IDENTITY, slack);
  }

  private fadeLights(c: Corpse): void {
    const p = c.parts;
    let level = Math.max(0, 1 - c.age / 1.2);
    if (p.flicker && level > 0 && Math.random() < 0.3) level *= 0.2;
    p.lights.color.setScalar(0.08 + 0.92 * level);
    p.halo.opacity = p.haloOpacity * level;
  }

  /** Out of the physics, to sink through the floor. */
  private sink(c: Corpse): void {
    if (c.sinking) return;
    c.sinking = true;
    c.age = Math.max(c.age, LIE);
    for (const f of c.parts.flames) f.visible = false;
    for (const rb of c.bodies) this.world.removeRigidBody(rb);
    c.bodies.length = 0;
    c.joints.length = 0;
    c.jet = null;
  }

  private remove(i: number): void {
    const c = this.corpses[i];
    if (!c.sinking) for (const rb of c.bodies) this.world.removeRigidBody(rb);
    c.parts.body.removeFromParent();
    for (const o of c.parts.owned) o.dispose();
    this.corpses.splice(i, 1);
  }
}
