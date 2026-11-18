import * as THREE from 'three';
import { COMBAT, clamp, frameOf, type Mech, type MechFrame, type Vec3 } from '@dropline/shared';
import { spring, stepSpring } from '../util/spring';
import { TEAM_LOOK } from './avatar';
import { FOOT, buildMechSkeleton, legReach, mechKit, shapeOf, type MechBone, type MechShape, type MechSkeleton } from './mech/kit';

/** Height the machine starts its fall from, meters above the landing spot. */
const DROP_HEIGHT = 170;
/** Seconds a wreck stays before it is cleared away: ablaze, then dying down, then sinking away. */
const WRECK_TIME = 16;
const WRECK_BLAZE = 7;
const WRECK_SINK = 1.2;

/** Leg poses as [hip, knee] angles: kneeling for its pilot, tucked for the fall. Reverse knees flip both. */
const KNEEL: [number, number] = [1.15, -2.1];
const TUCK: [number, number] = [0.8, -1.5];

const WHITE = new THREE.Color('#ffffff');
const CRIT = new THREE.Color('#ffd23f');
/** What the paint is multiplied by once the wreck has burnt out. */
const SOOT = new THREE.Color('#1c1d20');
export const ALLY_ZONE = '#58d6ff';
export const ENEMY_ZONE = '#ff3b2f';

/** How much of a cloaked mech still shows: to its own side, and to the enemy (more while it moves). */
const CLOAK_ALLY = 0.3;
const CLOAK_ENEMY = 0.05;
const CLOAK_MOVING = 0.012;
/** The cockpit glass's own opacity. */
const GLASS = 0.32;

/** How hard each cannon throws the arm back, and how much of that reaches the hull. */
const RECOIL: Record<string, { arm: number; hull: number }> = {
  autocannon: { arm: 2.2, hull: 0.25 },
  breaker: { arm: 5, hull: 0.9 },
  lance: { arm: 7, hull: 1.6 },
};
/** How heavily each frame comes down on a foot. */
const TREAD: Record<string, number> = { halberd: 1.6, bastion: 2.4, lynx: 0.9 };

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));
const smooth = (u: number): number => u * u * (3 - 2 * u);

/**
 * A mech: its frame's model (render/mech/kit.ts) on the mech skeleton, animated
 * from the simulation's state. Each frame reads apart by its outline: the
 * Halberd with its shoulder pod, the Bastion low and broad behind a shield
 * slab with stacks on its back, the Lynx tall on bird legs with a fin and
 * jump-jet packs. It also draws its own landing zone while it falls, the
 * Bastion's shield wall, and the Lynx's cloak. The model faces -Z.
 */
export class MechAvatar {
  readonly root = new THREE.Group();
  readonly frame: MechFrame;
  private readonly shape: MechShape;
  /** +1 for knees that bend forward, -1 for the Lynx's bird legs. */
  private readonly bend: number;
  private readonly rig = new THREE.Group();
  private readonly bones: MechSkeleton;
  private readonly armRest = new THREE.Vector3();
  private readonly muzzle = new THREE.Object3D();
  private readonly pod = new THREE.Object3D();
  private readonly muzzleFlash: THREE.Mesh;
  /** Thrusters: on the back for a dash or a leap. */
  private readonly flames: THREE.Mesh[] = [];
  private readonly retros: THREE.Mesh[] = [];
  private readonly zone = new THREE.Group();
  private readonly zoneFill: THREE.Mesh;
  private readonly zoneBeam: THREE.Mesh;
  private readonly body: THREE.MeshStandardMaterial;
  private readonly lights: THREE.MeshBasicMaterial;
  private readonly glass: THREE.MeshStandardMaterial;
  private readonly ventMat: THREE.MeshBasicMaterial;
  private readonly podMat: THREE.MeshBasicMaterial;
  private readonly baseEmissive: THREE.Color;
  /** The Bastion's shield wall, turned with the torso; null on other frames. */
  private readonly shieldWall: THREE.Group | null = null;
  private readonly shieldMat: THREE.MeshBasicMaterial | null = null;
  private readonly recoil: { arm: number; hull: number };
  private readonly tread: number;
  private readonly dip = spring();
  /** The cannon arm thrown back by a shot, and the hull rocked by a shot or a hit. */
  private readonly kick = spring();
  private readonly jolt = spring();
  /** Arms flung out by the stomp. */
  private readonly flare = spring();
  private foot = 0;
  private gait = 0;
  private legYaw = 0;
  /** Hull and cannon pitch before recoil and jolts are added on top. */
  private torsoPitch = 0;
  private armPitch = 0;
  private hit = 0;
  private hitCrit = false;
  private shot = 0;
  private podGlow = 0;
  /** The cockpit's lights and optics: dark while it waits empty, on once it starts up. */
  private power = 0;
  private shieldShow = 0;
  private shieldFlash = 0;
  /** 1 fully seen, down to the cloak's level while cloaked; `fading` while below 1. */
  private seen = 1;
  private fading = false;
  /** The solid parts, which cast shadows unless cloaked. */
  private readonly casters: THREE.Mesh[] = [];
  /** Geometry this avatar made itself; the kit's is shared and stays. */
  private readonly owned: (THREE.Material | THREE.BufferGeometry)[] = [];
  private cloaked = false;
  private wreck = -1;
  private time = 0;
  private lastState = 'none';
  private readonly ally: boolean;
  /** Current hip and knee angles, left then right. */
  private readonly pose = [0, 0, 0, 0];

  /**
   * `ally` is from the local player's point of view: it picks the landing zone's
   * colour and, unless `marker` says otherwise, puts the ally chevron overhead.
   */
  constructor(team: number, ally: boolean, frame: MechFrame, marker = ally) {
    this.frame = frame;
    this.ally = ally;
    const S = (this.shape = shapeOf(frame));
    this.bend = S.reverse ? -1 : 1;
    this.recoil = RECOIL[frame.loadout[0]] ?? RECOIL.autocannon;
    this.tread = TREAD[frame.id] ?? TREAD.halberd;
    const look = TEAM_LOOK[team];
    const kit = mechKit(frame, team);
    this.baseEmissive = new THREE.Color(kit.emissive);
    this.body = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: kit.roughness, metalness: kit.metalness, emissive: this.baseEmissive.clone() });
    this.lights = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.ventMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.podMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.glass = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: GLASS, roughness: 0.05, metalness: 0.6, depthWrite: false });
    this.owned.push(this.body, this.lights, this.ventMat, this.podMat, this.glass);

    this.bones = buildMechSkeleton(this.rig, frame);
    const glowMat: Partial<Record<MechBone, THREE.Material>> = { vent: this.ventMat, pod: this.podMat };
    for (const name of Object.keys(kit.bones) as MechBone[]) {
      const parts = kit.bones[name]!;
      if (parts.body) {
        const mesh = new THREE.Mesh(parts.body, name === 'glass' ? this.glass : this.body);
        if (name !== 'glass') {
          mesh.castShadow = true;
          this.casters.push(mesh);
        }
        this.bones[name].add(mesh);
      }
      if (parts.glow) this.bones[name].add(new THREE.Mesh(parts.glow, glowMat[name] ?? this.lights));
    }
    this.armRest.copy(this.bones.armR.position);

    const flameMat = new THREE.MeshBasicMaterial({ color: '#ffb066', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    this.owned.push(flameMat);
    /** A flame `len` long pointing from the nozzle at `at` down `dir` (+Z behind, -Y below). */
    const flame = (parent: THREE.Object3D, r: number, len: number, at: [number, number, number], down: boolean): THREE.Mesh => {
      const geo = new THREE.ConeGeometry(r, len, 8);
      // The cone's tip is its +Y: turn it to point away from the nozzle, its base at the nozzle.
      geo.translate(0, len / 2, 0);
      geo.rotateX(down ? Math.PI : Math.PI / 2);
      this.owned.push(geo);
      const mesh = new THREE.Mesh(geo, flameMat);
      mesh.position.set(at[0], at[1], at[2]);
      mesh.visible = false;
      parent.add(mesh);
      return mesh;
    };
    for (const t of kit.thrusters) this.flames.push(flame(this.bones.torso, 0.24, 1.9, t.at, t.down));
    for (const foot of [this.bones.footL, this.bones.footR]) this.retros.push(flame(foot, 0.22, 2.6, [0, -FOOT, 0], true));

    this.muzzle.position.set(...kit.muzzle);
    const flashGeo = new THREE.OctahedronGeometry(0.5, 0);
    const flashMat = new THREE.MeshBasicMaterial({ color: '#ffd9a0', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.owned.push(flashGeo, flashMat);
    this.muzzleFlash = new THREE.Mesh(flashGeo, flashMat);
    this.muzzleFlash.position.copy(this.muzzle.position);
    this.muzzleFlash.visible = false;
    this.bones.armR.add(this.muzzle, this.muzzleFlash);
    this.pod.position.set(...kit.podMuzzle);
    this.bones.pod.add(this.pod);

    const A = frame.ability;
    if (A.kind === 'shield') {
      // The wall: a sheet of light, bowed a little, with a brighter rim.
      const mat = new THREE.MeshBasicMaterial({ color: look.visor, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const geo = new THREE.PlaneGeometry(A.width, A.height, 12, 6);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, (pos.getX(i) / (A.width / 2)) ** 2 * 0.45);
      geo.computeVertexNormals();
      const sheet = new THREE.Mesh(geo, mat);
      sheet.position.set(0, A.height / 2, -A.forward);
      const rimGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(A.width, A.height));
      const rimMat = new THREE.LineBasicMaterial({ color: look.visor, transparent: true, opacity: 0.8 });
      const rim = new THREE.LineSegments(rimGeo, rimMat);
      rim.position.copy(sheet.position);
      const wall = new THREE.Group();
      wall.add(sheet, rim);
      wall.visible = false;
      this.shieldWall = wall;
      this.shieldMat = mat;
      this.owned.push(mat, geo, rimGeo, rimMat);
      this.root.add(wall);
    }

    if (marker) {
      const chevGeo = new THREE.ConeGeometry(0.3, 0.55, 4);
      const chevMat = new THREE.MeshBasicMaterial({ color: look.visor });
      this.owned.push(chevGeo, chevMat);
      const chevron = new THREE.Mesh(chevGeo, chevMat);
      chevron.rotation.x = Math.PI;
      chevron.position.y = frame.body.height + 0.9;
      this.rig.add(chevron);
    }

    // Landing zone: a ring as wide as the crush radius, a disc that fills it as the
    // mech comes down, and a beam up to the falling machine.
    const R = COMBAT.mech.drop.crushRadius;
    const zoneMat = (opacity: number, additive: boolean): THREE.MeshBasicMaterial => {
      const mat = new THREE.MeshBasicMaterial({
        color: ally ? ALLY_ZONE : ENEMY_ZONE,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        polygonOffset: true,
        polygonOffsetFactor: -3,
      });
      this.owned.push(mat);
      return mat;
    };
    const ringGeo = new THREE.RingGeometry(R - 0.28, R, 56);
    const fillGeo = new THREE.CircleGeometry(R - 0.28, 56);
    const beamGeo = new THREE.CylinderGeometry(0.3, 0.3, 1, 10, 1, true);
    this.owned.push(ringGeo, fillGeo, beamGeo);
    const ring = new THREE.Mesh(ringGeo, zoneMat(0.95, false));
    this.zoneFill = new THREE.Mesh(fillGeo, zoneMat(0.3, false));
    ring.rotation.x = this.zoneFill.rotation.x = -Math.PI / 2;
    ring.position.y = 0.07;
    this.zoneFill.position.y = 0.06;
    this.zoneBeam = new THREE.Mesh(beamGeo, zoneMat(0.4, true));
    this.zone.add(ring, this.zoneFill, this.zoneBeam);
    this.zone.visible = false;

    this.root.add(this.rig, this.zone);
    this.root.visible = false;
  }

  /** A footfall: the other leg leads from here, and the hull settles onto it. */
  step(): void {
    this.foot ^= 1;
    this.dip.v -= this.tread;
  }

  /** The machine hits the ground: the legs give. */
  land(speed: number): void {
    this.dip.v -= Math.min(30, speed) * 0.5;
  }

  /** The stomp: the whole machine drops onto its legs and throws its arms out. */
  stomp(): void {
    this.dip.v -= 14;
    this.flare.v += 9;
  }

  /** Flash when hit: white, or yellow for a hit on the vent. The hull rocks back. */
  flash(crit: boolean): void {
    this.hit = 1;
    this.hitCrit = crit;
    this.jolt.v += crit ? 1.4 : 0.7;
  }

  /** Fire stopped by the shield lights it up. */
  shieldHit(): void {
    this.shieldFlash = 1;
  }

  /** A shot: the flash, and the cannon arm thrown back by the frame's weapon. */
  fireFlash(): void {
    this.shot = 1;
    this.kick.v += this.recoil.arm;
    this.jolt.v += this.recoil.hull;
  }

  /** The rocket pod lights up as a rocket leaves. */
  podFlash(): void {
    this.podGlow = 1;
  }

  /** Destroyed: what is left burns out where it stood, then is cleared away. */
  destroy(): void {
    this.wreck = 0;
  }

  /** How hard the wreck still burns: 1 ablaze, falling to 0 as it smoulders out; 0 with no wreck. */
  get wreckHeat(): number {
    if (this.wreck < 0) return 0;
    const out = WRECK_TIME - WRECK_SINK;
    return Math.max(0, Math.min(1, 1 - (this.wreck - WRECK_BLAZE) / (out - WRECK_BLAZE)));
  }

  /** Where the wreck's fires sit, in the world: the vent first (it burns hardest), then the hatch and the left shoulder. */
  burnPoints(out: THREE.Vector3[]): number {
    const b = this.bones;
    b.vent.getWorldPosition(out[0]);
    b.hatch.getWorldPosition(out[1]);
    b.armL.getWorldPosition(out[2]);
    return 3;
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  podWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.pod.getWorldPosition(out);
  }

  ventWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.bones.vent.getWorldPosition(out);
  }

  /** Pose one leg from a [hip, knee] pose given for forward knees; returns its reach. */
  private setLeg(side: 'L' | 'R', hip: number, knee: number): number {
    const b = this.bones;
    b[`thigh${side}` as const].rotation.x = hip;
    b[`shin${side}` as const].rotation.x = knee;
    b[`foot${side}` as const].rotation.x = -(hip + knee);
    return legReach(this.shape, hip, knee);
  }

  /** Every material on the body: what the cloak fades. */
  private bodyMaterials(): THREE.Material[] {
    return [this.body, this.lights, this.ventMat, this.podMat];
  }

  /** Fade the body for the cloak. Materials switch to blending only while they need it. */
  private setSeen(seen: number): void {
    const fading = seen < 0.999;
    const mats = this.bodyMaterials();
    for (const mat of mats) mat.opacity = seen;
    this.glass.opacity = GLASS * seen;
    if (fading === this.fading) return;
    this.fading = fading;
    for (const mat of mats) {
      mat.transparent = fading;
      mat.depthWrite = !fading;
      mat.needsUpdate = true;
    }
    // A ghost casts no shadow to give it away.
    for (const mesh of this.casters) mesh.castShadow = !fading;
  }

  /** The cockpit's lights: off, on, or anything between. */
  private setPower(level: number): void {
    this.power = level;
    this.lights.color.setScalar(level);
  }

  /**
   * `pos`, `yaw` and `pitch` are the drawn (interpolated) values; `show` hides the
   * model for the pilot looking out of it while everything keeps animating.
   */
  update(dt: number, k: Mech, pos: Vec3, yaw: number, pitch: number, show: boolean): void {
    this.time += dt;
    const b = this.bones;
    const s = this.bend;
    if (k.state === 'none') {
      this.updateWreck(dt);
      return;
    }

    if (this.lastState === 'none') {
      // A fresh machine: clean paint, standing data.
      this.wreck = -1;
      this.body.color.copy(WHITE);
      this.rig.scale.setScalar(1);
      this.pose[0] = this.pose[2] = s * TUCK[0];
      this.pose[1] = this.pose[3] = s * TUCK[1];
      this.dip.x = this.dip.v = 0;
      this.kick.x = this.kick.v = this.jolt.x = this.jolt.v = this.flare.x = this.flare.v = 0;
      this.legYaw = yaw;
      b.torso.rotation.set(0, 0, 0);
      this.torsoPitch = this.armPitch = 0;
      this.body.emissive.copy(this.baseEmissive);
      this.hit = 0;
    }
    this.lastState = k.state;
    const F = frameOf(k);

    this.root.visible = true;
    this.root.position.set(pos.x, pos.y, pos.z);
    const dropping = k.state === 'dropping';
    const T = COMBAT.mech.drop.time;
    const fall = dropping ? clamp(k.stateTime / T, 0, 1) : 1;
    // It accelerates all the way down and arrives exactly when the zone closes.
    const height = dropping ? DROP_HEIGHT * (1 - fall * fall) : 0;
    this.rig.position.y = height;
    this.rig.visible = show;

    this.zone.visible = dropping;
    if (dropping) {
      this.zoneFill.scale.setScalar(Math.max(0.001, fall));
      this.zoneBeam.scale.y = Math.max(0.01, height);
      this.zoneBeam.position.y = height / 2;
      (this.zoneBeam.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.2 * Math.sin(this.time * 22);
    }

    // The legs trail the torso when it turns, so it turns like a machine.
    const piloted = k.state === 'piloted';
    const turn = Math.atan2(Math.sin(yaw - this.legYaw), Math.cos(yaw - this.legYaw));
    this.legYaw += turn * (1 - Math.exp(-(piloted ? 5 : 12) * dt));
    this.root.rotation.y = this.legYaw;
    b.torso.rotation.y = yaw - this.legYaw;

    // Pose: tucked while falling, kneeling while empty, rising as it starts up.
    let hipL: number;
    let kneeL: number;
    let hipR: number;
    let kneeR: number;
    let bow = 0;
    let open = 0;
    let power = 1;
    const stride = F.move.strideLength;
    const stand = this.shape.stand;
    const phase = (this.foot + k.stride / stride) * Math.PI;
    if (dropping) {
      hipL = hipR = s * TUCK[0];
      kneeL = kneeR = s * TUCK[1];
      power = 0.3;
    } else if (k.state === 'idle' || k.state === 'boot') {
      const t = k.state === 'boot' ? clamp(k.stateTime / COMBAT.mech.embark.time, 0, 1) : 0;
      const up = smooth(t);
      hipL = s * (KNEEL[0] + (stand[0] - KNEEL[0]) * up);
      kneeL = s * (KNEEL[1] + (stand[1] - KNEEL[1]) * up);
      hipR = hipL * (1 - 0.25 * (1 - up));
      kneeR = kneeL * (1 - 0.2 * (1 - up));
      bow = -0.3 * (1 - up);
      open = 1 - up;
      // Waiting, the lights idle low; starting up, they stutter on before they hold.
      power = k.state === 'idle' ? 0.12 : t < 0.55 ? (Math.sin(this.time * 47) > 0.2 - t ? 0.25 + t : 0.08) : 0.6 + 0.4 * smooth((t - 0.55) / 0.45);
    } else {
      const speed = Math.hypot(k.vel.x, k.vel.z);
      this.gait = damp(this.gait, k.grounded ? Math.min(1, speed / F.move.walkSpeed) : 0, 8, dt);
      const swing = Math.cos(phase) * 0.48 * this.gait;
      const lift = Math.sin(phase) * 0.75 * this.gait;
      hipL = swing + s * (stand[0] + Math.max(0, -lift) * 0.3);
      kneeL = s * (stand[1] - Math.max(0, -lift));
      hipR = -swing + s * (stand[0] + Math.max(0, lift) * 0.3);
      kneeR = s * (stand[1] - Math.max(0, lift));
      if (!k.grounded) {
        // In the air: knees drawn up while it rises, reaching for the ground as it falls.
        const rising = k.vel.y > 0;
        hipL = hipR = s * (rising ? 0.75 : 0.45);
        kneeL = kneeR = s * (rising ? -1.3 : -0.8);
      }
    }
    const rate = dropping ? 30 : 14;
    this.pose[0] = damp(this.pose[0], hipL, rate, dt);
    this.pose[1] = damp(this.pose[1], kneeL, rate, dt);
    this.pose[2] = damp(this.pose[2], hipR, rate, dt);
    this.pose[3] = damp(this.pose[3], kneeR, rate, dt);
    stepSpring(this.dip, 120, 14, dt);
    stepSpring(this.kick, 260, 18, dt);
    stepSpring(this.jolt, 140, 12, dt);
    stepSpring(this.flare, 60, 9, dt);
    this.dip.x = clamp(this.dip.x, -0.9, 0.25);
    const reach = Math.max(this.setLeg('L', this.pose[0], this.pose[1]), this.setLeg('R', this.pose[2], this.pose[3]));
    // A standing machine idles: the hull rises and settles on its hydraulics.
    const still = piloted ? 1 - this.gait : 0;
    const breathe = Math.sin(this.time * 1.7) * 0.03 * still;
    b.hips.position.y = reach + this.dip.x + breathe;

    // Lean into a dash, and sway with each step.
    let leanX = 0;
    let leanZ = 0;
    const dashing = k.dashTime > 0;
    if (dashing) {
      const sin = Math.sin(this.legYaw);
      const cos = Math.cos(this.legYaw);
      const forward = -(k.dashX * sin + k.dashZ * cos);
      const side = k.dashX * cos - k.dashZ * sin;
      leanX = -forward * 0.3;
      leanZ = -side * 0.3;
    } else if (piloted) {
      leanZ = Math.sin(phase) * 0.035 * this.gait;
    }
    b.hips.rotation.x = damp(b.hips.rotation.x, leanX, 12, dt);
    b.hips.rotation.z = damp(b.hips.rotation.z, leanZ, 12, dt);

    // The hull follows the pilot's view a little, and rocks back from a heavy shot or a hit.
    const torsoPitch = piloted ? clamp(pitch * 0.3, -0.3, 0.3) : bow;
    this.torsoPitch = damp(this.torsoPitch, torsoPitch, 12, dt);
    b.torso.rotation.x = this.torsoPitch + clamp(this.jolt.x, -1, 1) * 0.04;
    b.torso.rotation.z = Math.sin(phase) * 0.02 * this.gait;
    const kick = clamp(this.kick.x, -0.2, 0.6);
    this.armPitch = damp(this.armPitch, piloted ? pitch - this.torsoPitch : -0.5, 16, dt);
    b.armR.rotation.x = this.armPitch + kick * 0.04;
    b.armR.position.z = this.armRest.z + kick * 0.12;
    // The Bastion's shield arm comes up in front while the wall is up.
    const guard = k.shieldUp ? -1.1 : 0;
    const armSwing = piloted ? Math.cos(phase) * 0.3 * this.gait : 0;
    b.armL.rotation.x = damp(b.armL.rotation.x, piloted ? armSwing + 0.1 + guard : -0.15, 12, dt);
    const flare = clamp(this.flare.x, 0, 1) * 0.5;
    b.armL.rotation.z = -flare;
    b.armR.rotation.z = flare;
    b.hatch.rotation.x = damp(b.hatch.rotation.x, open * 1.15, 9, dt);
    b.crew.visible = piloted || k.state === 'boot';
    this.setPower(dropping || k.state !== 'piloted' ? power : damp(this.power, 1, 6, dt));
    // The vent breathes, so the weak point catches the eye from behind.
    this.ventMat.color.setScalar(1.05 + Math.sin(this.time * 5) * 0.3);

    // Back thrusters: through a dash, and while jump jets carry it upward.
    const thrust = dashing || (F.mobility.kind === 'leap' && !k.grounded && k.vel.y > 0);
    for (const f of this.flames) {
      f.visible = thrust;
      f.scale.y = 0.7 + Math.random() * 0.7;
    }
    for (const f of this.retros) {
      f.visible = dropping;
      f.scale.y = 0.7 + Math.random() * 0.6;
    }

    this.shot = Math.max(0, this.shot - dt * 16);
    this.muzzleFlash.visible = this.shot > 0;
    if (this.shot > 0) {
      this.muzzleFlash.scale.setScalar(0.6 + this.shot * 0.9);
      this.muzzleFlash.rotation.z = Math.random() * 6.28;
      (this.muzzleFlash.material as THREE.MeshBasicMaterial).opacity = this.shot;
    }
    this.podGlow = Math.max(0, this.podGlow - dt * 5);
    this.podMat.color.setScalar(0.15 + this.podGlow * 2.5);

    if (this.hit > 0) {
      this.hit = Math.max(0, this.hit - dt * 8);
      this.body.emissive.lerpColors(this.baseEmissive, this.hitCrit ? CRIT : WHITE, this.hit * 0.7);
    }

    this.updateShield(dt, k, show);
    this.updateCloak(dt, k);
  }

  /** What is left after it is destroyed slumps, blackens and burns out, then sinks away. */
  private updateWreck(dt: number): void {
    const b = this.bones;
    this.zone.visible = false;
    if (this.shieldWall) this.shieldWall.visible = false;
    this.lastState = 'none';
    if (this.seen < 1) this.setSeen((this.seen = 1));
    if (this.wreck < 0 || this.wreck > WRECK_TIME) {
      this.root.visible = false;
      this.wreck = -1;
      return;
    }
    this.wreck += dt;
    const u = Math.min(1, this.wreck / 0.7);
    const s = this.bend;
    this.root.visible = true;
    this.rig.visible = true;
    b.torso.rotation.x = damp(b.torso.rotation.x, -0.55, 5, dt);
    b.torso.rotation.z = damp(b.torso.rotation.z, 0.18, 3, dt);
    b.armR.rotation.x = damp(b.armR.rotation.x, -1.2, 5, dt);
    b.armL.rotation.x = damp(b.armL.rotation.x, -0.4, 4, dt);
    this.pose[0] = damp(this.pose[0], s * KNEEL[0], 5, dt);
    this.pose[1] = damp(this.pose[1], s * KNEEL[1], 5, dt);
    this.pose[2] = damp(this.pose[2], s * KNEEL[0] * 0.8, 4, dt);
    this.pose[3] = damp(this.pose[3], s * KNEEL[1] * 0.8, 4, dt);
    b.hips.position.y = Math.max(this.setLeg('L', this.pose[0], this.pose[1]), this.setLeg('R', this.pose[2], this.pose[3]));
    this.body.color.lerpColors(WHITE, SOOT, u);
    // Hot metal glows a dull red under the soot while it burns.
    const glow = this.wreckHeat * (0.8 + 0.2 * Math.sin(this.time * 9) * Math.sin(this.time * 2.3));
    this.body.emissive.setRGB(0.07 * glow, 0.01 * glow, 0);
    this.setPower(0);
    b.crew.visible = false;
    this.ventMat.color.setScalar(1.6 * Math.max(1 - u, this.wreckHeat * 0.6) * (0.5 + Math.random() * 0.5));
    this.podMat.color.setScalar(0);
    this.muzzleFlash.visible = false;
    for (const f of this.flames) f.visible = false;
    for (const f of this.retros) f.visible = false;
    const gone = Math.max(0, (this.wreck - (WRECK_TIME - WRECK_SINK)) / WRECK_SINK);
    this.rig.scale.setScalar(1 - gone * gone);
    this.rig.position.y = -gone * 1.5;
  }

  /** The wall unfolds upward when raised and folds away when lowered; it dims as it wears down and flares where it is hit. */
  private updateShield(dt: number, k: Mech, show: boolean): void {
    const wall = this.shieldWall;
    const A = this.frame.ability;
    if (!wall || !this.shieldMat || A.kind !== 'shield') return;
    this.shieldShow = damp(this.shieldShow, k.shieldUp ? 1 : 0, k.shieldUp ? 14 : 9, dt);
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 5);
    wall.visible = show && this.shieldShow > 0.02;
    if (!wall.visible) return;
    wall.rotation.y = this.bones.torso.rotation.y;
    wall.scale.set(1, Math.max(0.02, smooth(this.shieldShow)), 1);
    const left = k.shield / A.health;
    // Nearly spent, it flickers: a warning to whoever stands behind it.
    const flicker = left < 0.25 ? 0.5 + 0.5 * Math.sin(this.time * 40) : 1;
    this.shieldMat.opacity = (0.12 + 0.16 * left + 0.4 * this.shieldFlash) * flicker * this.shieldShow;
  }

  /** The cloak fades the body: almost gone to the enemy, a ghost to its own side. Moving gives it away a little. */
  private updateCloak(dt: number, k: Mech): void {
    const on = k.cloak > 0 && k.state === 'piloted';
    const speed = Math.hypot(k.vel.x, k.vel.z);
    const target = on ? (this.ally ? CLOAK_ALLY : CLOAK_ENEMY + speed * CLOAK_MOVING) : 1;
    // A hit makes it flicker into view for a moment.
    const seen = Math.min(1, damp(this.seen, target, on === this.cloaked ? 10 : 6, dt) + (on ? this.hit * 0.4 : 0));
    this.cloaked = on;
    if (Math.abs(seen - this.seen) < 1e-4 && seen === 1) return;
    this.seen = seen;
    this.setSeen(seen);
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
  }
}
