import * as THREE from 'three';
import { COMBAT, MECH, clamp, type Mech, type Vec3 } from '@dropline/shared';
import { spring, stepSpring } from '../util/spring';
import { TEAM_LOOK } from './avatar';

const THIGH = 1.1;
const SHIN = 1.1;
const FOOT = 0.3;
/** Height the machine starts its fall from, meters above the landing spot. */
const DROP_HEIGHT = 170;
/** Seconds a wreck stays before it is cleared away. */
const WRECK_TIME = 3.2;

/** Leg poses as [hip, knee] angles: standing, kneeling for its pilot, tucked for the fall. */
const STAND: [number, number] = [0.28, -0.56];
const KNEEL: [number, number] = [1.15, -2.1];
const TUCK: [number, number] = [0.8, -1.5];

const WHITE = new THREE.Color('#ffffff');
const CRIT = new THREE.Color('#ffd23f');
const BLACK = new THREE.Color('#000000');
const SOOT = new THREE.Color('#0d0e10');
export const ALLY_ZONE = '#58d6ff';
export const ENEMY_ZONE = '#ff3b2f';
export const VENT_GLOW = '#ff9a2f';

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));
const smooth = (u: number): number => u * u * (3 - 2 * u);

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  foot: THREE.Group;
}

/**
 * Placeholder mech built from boxes with procedural animation, like the pilot
 * avatars: it stands in until a rigged model exists. It also draws its own
 * landing zone while it falls. The model faces -Z and stands 5.2 m tall.
 */
export class MechAvatar {
  readonly root = new THREE.Group();
  private readonly rig = new THREE.Group();
  private readonly hips = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly hatch = new THREE.Group();
  private readonly legL: Leg;
  private readonly legR: Leg;
  private readonly muzzle = new THREE.Object3D();
  private readonly pod = new THREE.Object3D();
  private readonly vent: THREE.Mesh;
  private readonly muzzleFlash: THREE.Mesh;
  private readonly flames: THREE.Mesh[] = [];
  private readonly retros: THREE.Mesh[] = [];
  private readonly zone = new THREE.Group();
  private readonly zoneFill: THREE.Mesh;
  private readonly zoneBeam: THREE.Mesh;
  private readonly armor: THREE.MeshStandardMaterial;
  private readonly plate: THREE.MeshStandardMaterial;
  private readonly glass: THREE.MeshStandardMaterial;
  private readonly ventMat: THREE.MeshStandardMaterial;
  private readonly podMat: THREE.MeshStandardMaterial;
  private readonly armorBase: THREE.Color;
  private readonly plateBase: THREE.Color;
  private readonly dip = spring();
  private foot = 0;
  private gait = 0;
  private legYaw = 0;
  private hit = 0;
  private hitCrit = false;
  private shot = 0;
  private podGlow = 0;
  private wreck = -1;
  private time = 0;
  private lastState = 'none';
  private readonly pose = [STAND[0], STAND[1], STAND[0], STAND[1]];

  /** `ally` is from the local player's point of view: it picks the landing zone's colour. */
  constructor(team: number, ally: boolean) {
    const look = TEAM_LOOK[team];
    this.armor = new THREE.MeshStandardMaterial({ color: '#4a525f', roughness: 0.6, metalness: 0.4 });
    this.plate = new THREE.MeshStandardMaterial({ color: look.plate, roughness: 0.5, metalness: 0.35 });
    this.armorBase = this.armor.color.clone();
    this.plateBase = this.plate.color.clone();
    this.glass = new THREE.MeshStandardMaterial({ color: '#0b1a22', emissive: look.visor, emissiveIntensity: 2.2, roughness: 0.2 });
    this.ventMat = new THREE.MeshStandardMaterial({ color: '#2a1206', emissive: VENT_GLOW, emissiveIntensity: 1.1 });
    this.podMat = new THREE.MeshStandardMaterial({ color: '#15181d', emissive: '#ffb066', emissiveIntensity: 0 });
    const dark = new THREE.MeshStandardMaterial({ color: '#191c22', roughness: 0.7, metalness: 0.4 });

    const part = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      return mesh;
    };
    const flameMat = new THREE.MeshBasicMaterial({ color: '#ffb066', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    const flame = (r: number, len: number, x: number, y: number, z: number, rx: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(r, len, 8), flameMat);
      mesh.position.set(x, y, z);
      mesh.rotation.x = rx;
      mesh.visible = false;
      return mesh;
    };

    const leg = (x: number): Leg => {
      const hip = new THREE.Group();
      hip.position.set(x, 0, 0);
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      const foot = new THREE.Group();
      foot.position.y = -SHIN;
      hip.add(part(0.56, THIGH + 0.2, 0.7, this.armor, 0, -THIGH / 2, 0), part(0.62, 0.5, 0.2, this.plate, 0, -THIGH * 0.45, -0.4), knee);
      knee.add(part(0.46, SHIN + 0.1, 0.56, this.armor, 0, -SHIN / 2, 0), part(0.6, 0.36, 0.7, dark, 0, 0, 0), foot);
      foot.add(part(0.8, FOOT, 1.3, dark, 0, -FOOT / 2, -0.18), part(0.84, 0.14, 0.4, this.plate, 0, -0.06, -0.68));
      const retro = flame(0.22, 2.6, 0, -FOOT - 1.3, 0, Math.PI);
      this.retros.push(retro);
      foot.add(retro);
      return { hip, knee, foot };
    };
    this.legL = leg(-0.82);
    this.legR = leg(0.82);
    this.hips.add(part(1.5, 0.55, 1.05, dark, 0, 0.05, 0), this.legL.hip, this.legR.hip, this.torso);

    // Torso: hull, team-coloured chest and shoulders, cockpit glass in front, the vent behind.
    this.torso.position.y = 0.3;
    this.vent = part(0.95, 0.75, 0.62, this.ventMat, 0, MECH.vent.height - 2.71, MECH.vent.back - 0.12);
    this.hatch.position.set(0, 2.02, 0.55);
    this.hatch.add(part(1.1, 0.14, 1.1, this.plate, 0, 0.07, -0.55));
    this.torso.add(
      part(2.2, 1.7, 1.7, this.armor, 0, 1.15, 0),
      part(2.34, 0.5, 1.8, this.plate, 0, 0.62, 0),
      part(1.5, 0.46, 0.5, dark, 0, 0.2, 0),
      part(1.25, 0.58, 0.12, this.glass, 0, 1.6, -0.87),
      part(1.45, 0.1, 0.16, dark, 0, 1.94, -0.88),
      part(1.5, 1.0, 0.2, dark, 0, 0.75, 0.86),
      this.vent,
      part(0.12, 0.6, 0.12, dark, 0.85, 2.3, 0.55),
      this.hatch,
      this.armR,
      this.armL,
    );
    // Rocket pod on the left shoulder, where the simulation launches the salvo from.
    const podBox = part(0.95, 0.62, 1.2, this.armor, MECH.salvo.side - 0.1, MECH.salvo.height - 2.71, 0.05);
    for (const [px, py] of [[-0.2, 0.13], [0.2, 0.13], [-0.2, -0.13], [0.2, -0.13]]) podBox.add(part(0.26, 0.2, 0.06, this.podMat, px, py, -0.61));
    this.pod.position.set(0, 0, -0.7);
    podBox.add(this.pod);
    this.torso.add(podBox);

    // Right arm: the autocannon. It pitches with the pilot's view.
    this.armR.position.set(1.52, 1.5, 0);
    this.armR.add(
      part(0.7, 0.62, 0.62, this.plate, 0, 0.12, 0),
      part(0.6, 0.72, 1.6, this.armor, 0, -0.18, -0.35),
      part(0.24, 0.24, 1.7, dark, 0, -0.1, -1.7),
      part(0.16, 0.16, 1.3, dark, 0, -0.36, -1.5),
      part(0.34, 0.34, 0.24, dark, 0, -0.1, -2.5),
    );
    this.muzzle.position.set(0, -0.1, -2.66);
    this.muzzleFlash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.5, 0),
      new THREE.MeshBasicMaterial({ color: '#ffd9a0', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.muzzleFlash.position.copy(this.muzzle.position);
    this.muzzleFlash.visible = false;
    this.armR.add(this.muzzle, this.muzzleFlash);

    // Left arm: a heavy fist that swings as it walks.
    this.armL.position.set(-1.52, 1.5, 0);
    this.armL.add(part(0.7, 0.62, 0.62, this.plate, 0, 0.12, 0), part(0.52, 1.3, 0.56, this.armor, 0, -0.75, 0), part(0.62, 0.5, 0.66, dark, 0, -1.55, -0.04));

    for (const x of [-0.6, 0.6]) {
      const jet = flame(0.26, 1.9, x, 0.5, 1.6, -Math.PI / 2);
      this.flames.push(jet);
      this.torso.add(jet);
    }

    this.rig.add(this.hips);
    if (ally) {
      const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.55, 4), new THREE.MeshBasicMaterial({ color: look.visor }));
      chevron.rotation.x = Math.PI;
      chevron.position.y = MECH.body.height + 0.9;
      this.rig.add(chevron);
    }

    // Landing zone: a ring as wide as the crush radius, a disc that fills it as the
    // mech comes down, and a beam up to the falling machine.
    const R = COMBAT.mech.drop.crushRadius;
    const zoneMat = (opacity: number, additive: boolean): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
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
    const ring = new THREE.Mesh(new THREE.RingGeometry(R - 0.28, R, 56), zoneMat(0.95, false));
    this.zoneFill = new THREE.Mesh(new THREE.CircleGeometry(R - 0.28, 56), zoneMat(0.3, false));
    ring.rotation.x = this.zoneFill.rotation.x = -Math.PI / 2;
    ring.position.y = 0.07;
    this.zoneFill.position.y = 0.06;
    this.zoneBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1, 10, 1, true), zoneMat(0.4, true));
    this.zone.add(ring, this.zoneFill, this.zoneBeam);
    this.zone.visible = false;

    this.root.add(this.rig, this.zone);
    this.root.visible = false;
  }

  /** A footfall: the other leg leads from here. */
  step(): void {
    this.foot ^= 1;
  }

  /** The machine hits the ground: the legs give. */
  land(speed: number): void {
    this.dip.v -= Math.min(30, speed) * 0.5;
  }

  /** Flash when hit: white, or yellow for a hit on the vent. */
  flash(crit: boolean): void {
    this.hit = 1;
    this.hitCrit = crit;
  }

  fireFlash(): void {
    this.shot = 1;
  }

  /** The rocket pod lights up as a rocket leaves. */
  podFlash(): void {
    this.podGlow = 1;
  }

  /** Destroyed: what is left burns out where it stood, then is cleared away. */
  destroy(): void {
    this.wreck = 0;
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  podWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.pod.getWorldPosition(out);
  }

  ventWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.vent.getWorldPosition(out);
  }

  /** Top of the machine as drawn, for labels. */
  get top(): number {
    return this.rig.position.y + this.hips.position.y + 3.1;
  }

  private setLeg(leg: Leg, hip: number, knee: number): number {
    leg.hip.rotation.x = hip;
    leg.knee.rotation.x = knee;
    leg.foot.rotation.x = -(hip + knee);
    return THIGH * Math.cos(hip) + SHIN * Math.cos(hip + knee) + FOOT;
  }

  /**
   * `pos`, `yaw` and `pitch` are the drawn (interpolated) values; `show` hides the
   * model for the pilot looking out of it while everything keeps animating.
   */
  update(dt: number, k: Mech, pos: Vec3, yaw: number, pitch: number, show: boolean): void {
    this.time += dt;
    if (k.state === 'none') {
      this.zone.visible = false;
      this.lastState = 'none';
      if (this.wreck < 0 || this.wreck > WRECK_TIME) {
        this.root.visible = false;
        this.wreck = -1;
        return;
      }
      // The wreck slumps forward and blackens.
      this.wreck += dt;
      const u = Math.min(1, this.wreck / 0.7);
      this.root.visible = true;
      this.rig.visible = true;
      this.torso.rotation.x = damp(this.torso.rotation.x, -0.55, 5, dt);
      this.armR.rotation.x = damp(this.armR.rotation.x, -1.2, 5, dt);
      this.pose[0] = damp(this.pose[0], KNEEL[0], 5, dt);
      this.pose[1] = damp(this.pose[1], KNEEL[1], 5, dt);
      this.pose[2] = damp(this.pose[2], KNEEL[0] * 0.8, 4, dt);
      this.pose[3] = damp(this.pose[3], KNEEL[1] * 0.8, 4, dt);
      this.hips.position.y = Math.max(this.setLeg(this.legL, this.pose[0], this.pose[1]), this.setLeg(this.legR, this.pose[2], this.pose[3]));
      this.armor.color.lerpColors(this.armorBase, SOOT, u);
      this.plate.color.lerpColors(this.plateBase, SOOT, u * 0.85);
      this.armor.emissive.copy(BLACK);
      this.plate.emissive.copy(BLACK);
      this.glass.emissiveIntensity = 0;
      this.ventMat.emissiveIntensity = 1.6 * (1 - u) * (0.5 + Math.random() * 0.5);
      this.muzzleFlash.visible = false;
      for (const f of this.flames) f.visible = false;
      for (const f of this.retros) f.visible = false;
      // Sink away at the end.
      const gone = Math.max(0, (this.wreck - (WRECK_TIME - 0.8)) / 0.8);
      this.rig.scale.setScalar(1 - gone * gone);
      return;
    }

    if (this.lastState === 'none') {
      // A fresh machine: clean paint, standing data.
      this.wreck = -1;
      this.armor.color.copy(this.armorBase);
      this.plate.color.copy(this.plateBase);
      this.rig.scale.setScalar(1);
      this.pose[0] = this.pose[2] = TUCK[0];
      this.pose[1] = this.pose[3] = TUCK[1];
      this.dip.x = this.dip.v = 0;
      this.legYaw = yaw;
      this.torso.rotation.set(0, 0, 0);
      this.hit = 0;
    }
    this.lastState = k.state;

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
    this.torso.rotation.y = yaw - this.legYaw;

    // Pose: tucked while falling, kneeling while empty, rising as it starts up.
    let hipL: number;
    let kneeL: number;
    let hipR: number;
    let kneeR: number;
    let bow = 0;
    let open = 0;
    let glow = 2.4;
    if (dropping) {
      [hipL, kneeL] = TUCK;
      [hipR, kneeR] = TUCK;
      glow = 0.4;
    } else if (k.state === 'idle' || k.state === 'boot') {
      const up = k.state === 'boot' ? smooth(clamp(k.stateTime / COMBAT.mech.embark.time, 0, 1)) : 0;
      hipL = KNEEL[0] + (STAND[0] - KNEEL[0]) * up;
      kneeL = KNEEL[1] + (STAND[1] - KNEEL[1]) * up;
      hipR = hipL * (1 - 0.25 * (1 - up));
      kneeR = kneeL * (1 - 0.2 * (1 - up));
      bow = -0.3 * (1 - up);
      open = 1 - up;
      glow = 0.35 + 2.05 * up;
    } else {
      const speed = Math.hypot(k.vel.x, k.vel.z);
      this.gait = damp(this.gait, k.grounded ? Math.min(1, speed / MECH.move.walkSpeed) : 0, 8, dt);
      const phase = (this.foot + k.stride / MECH.move.strideLength) * Math.PI;
      const swing = Math.cos(phase) * 0.48 * this.gait;
      const lift = Math.sin(phase) * 0.75 * this.gait;
      hipL = STAND[0] + swing + Math.max(0, -lift) * 0.3;
      kneeL = STAND[1] - Math.max(0, -lift);
      hipR = STAND[0] - swing + Math.max(0, lift) * 0.3;
      kneeR = STAND[1] - Math.max(0, lift);
      if (!k.grounded) {
        hipL = hipR = 0.5;
        kneeL = kneeR = -0.9;
      }
    }
    const rate = dropping ? 30 : 14;
    this.pose[0] = damp(this.pose[0], hipL, rate, dt);
    this.pose[1] = damp(this.pose[1], kneeL, rate, dt);
    this.pose[2] = damp(this.pose[2], hipR, rate, dt);
    this.pose[3] = damp(this.pose[3], kneeR, rate, dt);
    stepSpring(this.dip, 120, 14, dt);
    this.dip.x = clamp(this.dip.x, -0.9, 0.25);
    const reach = Math.max(this.setLeg(this.legL, this.pose[0], this.pose[1]), this.setLeg(this.legR, this.pose[2], this.pose[3]));
    this.hips.position.y = reach + this.dip.x;

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
      leanZ = Math.sin((this.foot + k.stride / MECH.move.strideLength) * Math.PI) * 0.035 * this.gait;
    }
    this.hips.rotation.x = damp(this.hips.rotation.x, leanX, 12, dt);
    this.hips.rotation.z = damp(this.hips.rotation.z, leanZ, 12, dt);

    const torsoPitch = piloted ? clamp(pitch * 0.3, -0.3, 0.3) : bow;
    this.torso.rotation.x = damp(this.torso.rotation.x, torsoPitch, 12, dt);
    this.armR.rotation.x = damp(this.armR.rotation.x, piloted ? pitch - this.torso.rotation.x : -0.5, 16, dt);
    const armSwing = piloted ? Math.cos((this.foot + k.stride / MECH.move.strideLength) * Math.PI) * 0.3 * this.gait : 0;
    this.armL.rotation.x = damp(this.armL.rotation.x, piloted ? armSwing + 0.1 : -0.15, 12, dt);
    this.hatch.rotation.x = damp(this.hatch.rotation.x, open * 1.15, 9, dt);
    this.glass.emissiveIntensity = damp(this.glass.emissiveIntensity, glow, 8, dt);
    // The vent breathes, so the weak point catches the eye from behind.
    this.ventMat.emissiveIntensity = 1.05 + Math.sin(this.time * 5) * 0.35;

    for (const f of this.flames) {
      f.visible = dashing;
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
    this.podMat.emissiveIntensity = this.podGlow * 4;

    if (this.hit > 0 || this.armor.emissive.r > 0) {
      this.hit = Math.max(0, this.hit - dt * 8);
      this.armor.emissive.lerpColors(BLACK, this.hitCrit ? CRIT : WHITE, this.hit * 0.7);
      this.plate.emissive.copy(this.armor.emissive);
    }
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const mat of [this.armor, this.plate, this.glass, this.ventMat, this.podMat]) mat.dispose();
  }
}
