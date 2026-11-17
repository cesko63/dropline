import * as THREE from 'three';
import { COMBAT, clamp, frameOf, type Mech, type MechFrame, type Vec3 } from '@dropline/shared';
import { spring, stepSpring } from '../util/spring';
import { TEAM_LOOK } from './avatar';

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

/** How much of a cloaked mech still shows: to its own side, and to the enemy (more while it moves). */
const CLOAK_ALLY = 0.3;
const CLOAK_ENEMY = 0.05;
const CLOAK_MOVING = 0.012;

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));
const smooth = (u: number): number => u * u * (3 - 2 * u);

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  foot: THREE.Group;
}

/**
 * The parts of a frame's body that differ: leg lengths and stance, the torso's
 * block, and where the arms hang. Everything else is built from these and from
 * the frame's numbers (vent, rocket pod, shield).
 */
interface Shape {
  thigh: number;
  shin: number;
  /** Half the distance between the hips. */
  hipX: number;
  /** Thigh and shin thickness. */
  legW: number;
  /** Torso block: width, height, depth, and the height of its middle above the torso's origin. */
  torso: [number, number, number, number];
  /** Shoulder joints: out to the side and up from the torso's origin. */
  armX: number;
  armY: number;
}

const SHAPES: Record<string, Shape> = {
  halberd: { thigh: 1.1, shin: 1.1, hipX: 0.82, legW: 0.56, torso: [2.2, 1.7, 1.7, 1.15], armX: 1.52, armY: 1.5 },
  // Squat and wide: short legs set far apart, a deep hull, the arms hung low.
  bastion: { thigh: 0.95, shin: 0.95, hipX: 0.95, legW: 0.68, torso: [2.6, 1.6, 1.9, 1.05], armX: 1.75, armY: 1.25 },
  // Long-legged and narrow, the hull small and high.
  lynx: { thigh: 1.2, shin: 1.25, hipX: 0.62, legW: 0.4, torso: [1.6, 1.1, 1.3, 0.8], armX: 1.1, armY: 0.95 },
};

/**
 * Placeholder mech built from boxes with procedural animation, like the pilot
 * avatars: it stands in until a rigged model exists. One is built per frame
 * (see `SHAPES`), so the three read apart by their outline alone: the Halberd
 * with its shoulder pod, the Bastion low and broad behind a shield slab, the
 * Lynx tall and thin with jump-jet packs. It also draws its own landing zone
 * while it falls, the Bastion's shield wall, and the Lynx's cloak. The model
 * faces -Z.
 */
export class MechAvatar {
  readonly root = new THREE.Group();
  readonly frame: MechFrame;
  private readonly shape: Shape;
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
  /** Thrusters: on the back for a dash or a leap. */
  private readonly flames: THREE.Mesh[] = [];
  private readonly retros: THREE.Mesh[] = [];
  private readonly zone = new THREE.Group();
  private readonly zoneFill: THREE.Mesh;
  private readonly zoneBeam: THREE.Mesh;
  private readonly armor: THREE.MeshStandardMaterial;
  private readonly plate: THREE.MeshStandardMaterial;
  private readonly dark: THREE.MeshStandardMaterial;
  private readonly glass: THREE.MeshStandardMaterial;
  private readonly ventMat: THREE.MeshStandardMaterial;
  private readonly podMat: THREE.MeshStandardMaterial;
  private readonly armorBase: THREE.Color;
  private readonly plateBase: THREE.Color;
  /** The Bastion's shield wall, turned with the torso; null on other frames. */
  private readonly shieldWall: THREE.Group | null = null;
  private readonly shieldMat: THREE.MeshBasicMaterial | null = null;
  private readonly dip = spring();
  private foot = 0;
  private gait = 0;
  private legYaw = 0;
  private hit = 0;
  private hitCrit = false;
  private shot = 0;
  private podGlow = 0;
  private shieldShow = 0;
  private shieldFlash = 0;
  /** 1 fully seen, down to the cloak's level while cloaked; `fading` while below 1. */
  private seen = 1;
  private fading = false;
  /** The solid parts, which cast shadows unless cloaked. */
  private readonly casters: THREE.Mesh[] = [];
  private cloaked = false;
  private wreck = -1;
  private time = 0;
  private lastState = 'none';
  private readonly ally: boolean;
  private readonly pose = [STAND[0], STAND[1], STAND[0], STAND[1]];
  /** Torso origin above the feet when standing: what the parts placed in body coordinates are measured from. */
  private readonly base: number;

  /**
   * `ally` is from the local player's point of view: it picks the landing zone's
   * colour and, unless `marker` says otherwise, puts the ally chevron overhead.
   */
  constructor(team: number, ally: boolean, frame: MechFrame, marker = ally) {
    this.frame = frame;
    this.ally = ally;
    const S = (this.shape = SHAPES[frame.id] ?? SHAPES.halberd);
    const look = TEAM_LOOK[team];
    this.armor = new THREE.MeshStandardMaterial({ color: '#4a525f', roughness: 0.6, metalness: 0.4 });
    this.plate = new THREE.MeshStandardMaterial({ color: look.plate, roughness: 0.5, metalness: 0.35 });
    this.armorBase = this.armor.color.clone();
    this.plateBase = this.plate.color.clone();
    this.glass = new THREE.MeshStandardMaterial({ color: '#0b1a22', emissive: look.visor, emissiveIntensity: 2.2, roughness: 0.2 });
    this.ventMat = new THREE.MeshStandardMaterial({ color: '#2a1206', emissive: VENT_GLOW, emissiveIntensity: 1.1 });
    this.podMat = new THREE.MeshStandardMaterial({ color: '#15181d', emissive: '#ffb066', emissiveIntensity: 0 });
    const dark = (this.dark = new THREE.MeshStandardMaterial({ color: '#191c22', roughness: 0.7, metalness: 0.4 }));
    const armor = this.armor;
    const plate = this.plate;

    const part = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      this.casters.push(mesh);
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
      knee.position.y = -S.thigh;
      const foot = new THREE.Group();
      foot.position.y = -S.shin;
      const w = S.legW;
      hip.add(part(w, S.thigh + 0.2, w * 1.25, armor, 0, -S.thigh / 2, 0), part(w + 0.06, 0.5, 0.2, plate, 0, -S.thigh * 0.45, -w * 0.72), knee);
      knee.add(part(w * 0.82, S.shin + 0.1, w, armor, 0, -S.shin / 2, 0), part(w + 0.04, 0.36, w * 1.25, dark, 0, 0, 0), foot);
      foot.add(part(w + 0.24, FOOT, 1.3, dark, 0, -FOOT / 2, -0.18), part(w + 0.28, 0.14, 0.4, plate, 0, -0.06, -0.68));
      const retro = flame(0.22, 2.6, 0, -FOOT - 1.3, 0, Math.PI);
      this.retros.push(retro);
      foot.add(retro);
      return { hip, knee, foot };
    };
    this.legL = leg(-S.hipX);
    this.legR = leg(S.hipX);
    this.base = this.legReach(STAND[0], STAND[1]) + 0.3;
    this.hips.add(part(S.hipX * 2 - 0.14, 0.55, 1.05, dark, 0, 0.05, 0), this.legL.hip, this.legR.hip, this.torso);

    // Torso: hull, team-coloured chest band, cockpit glass in front, the vent behind.
    const [tw, th, td, ty] = S.torso;
    const V = frame.vent;
    this.torso.position.y = 0.3;
    this.vent = part(V.radius * 1.6, V.radius * 1.25, V.radius * 1.05, this.ventMat, 0, V.height - this.base, V.back - 0.12);
    const top = ty + th / 2;
    this.hatch.position.set(0, top + 0.02, 0.55);
    this.hatch.add(part(1.1, 0.14, 1.1, plate, 0, 0.07, -0.55));
    this.torso.add(
      part(tw, th, td, armor, 0, ty, 0),
      part(tw + 0.14, 0.5, td + 0.1, plate, 0, ty - th / 2 + 0.32, 0),
      part(tw * 0.68, 0.46, 0.5, dark, 0, ty - th / 2 - 0.1, 0),
      part(tw * 0.57, 0.58, 0.12, this.glass, 0, ty + th * 0.26, -td / 2 - 0.02),
      part(tw * 0.66, 0.1, 0.16, dark, 0, ty + th * 0.46, -td / 2 - 0.03),
      part(tw * 0.68, th * 0.6, 0.2, dark, 0, ty - th * 0.24, td / 2 + 0.01),
      this.vent,
      part(0.12, 0.6, 0.12, dark, tw * 0.39, top + 0.3, 0.55),
      this.hatch,
      this.armR,
      this.armL,
    );
    this.armR.position.set(S.armX, S.armY, 0);
    this.armL.position.set(-S.armX, S.armY, 0);

    this.muzzleFlash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.5, 0),
      new THREE.MeshBasicMaterial({ color: '#ffd9a0', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.muzzleFlash.visible = false;

    // The frame's own arms and gear. The right arm carries the cannon and pitches with the pilot's view.
    if (frame.id === 'bastion') {
      // Breaker: a short, fat flak tube over a shell drum.
      this.armR.add(
        part(0.85, 0.7, 0.75, plate, 0, 0.12, 0),
        part(0.8, 0.85, 1.4, armor, 0, -0.22, -0.3),
        part(0.55, 0.55, 1.2, dark, 0, -0.12, -1.3),
        part(0.7, 0.7, 0.25, dark, 0, -0.12, -1.95),
        part(0.6, 0.45, 0.6, dark, 0, -0.75, -0.6),
      );
      this.muzzle.position.set(0, -0.12, -2.1);
      // Left arm: the shield emitter, a slab the wall unfolds from.
      this.armL.add(part(0.85, 0.7, 0.75, plate, 0, 0.12, 0), part(0.5, 1.6, 0.7, armor, -0.05, -0.75, -0.1), part(0.22, 2.1, 1.6, plate, -0.3, -0.8, -0.35), part(0.08, 1.6, 1.2, this.glass, -0.43, -0.8, -0.35));
      // Heavy shoulder plates over a hunched hull.
      this.torso.add(part(0.95, 0.35, 1.5, plate, tw / 2 + 0.05, top + 0.05, 0), part(0.95, 0.35, 1.5, plate, -tw / 2 - 0.05, top + 0.05, 0));
    } else if (frame.id === 'lynx') {
      // Lance: two long thin rails with glowing coils between them.
      const coil = new THREE.MeshStandardMaterial({ color: '#0b1a22', emissive: look.visor, emissiveIntensity: 1.6 });
      this.armR.add(part(0.45, 0.45, 0.45, plate, 0, 0.1, 0), part(0.38, 0.5, 1.1, armor, 0, -0.12, -0.25), part(0.1, 0.18, 2.6, dark, -0.1, -0.05, -1.75), part(0.1, 0.18, 2.6, dark, 0.1, -0.05, -1.75));
      for (const z of [-1.1, -1.7, -2.3, -2.9]) this.armR.add(part(0.12, 0.05, 0.08, coil, 0, -0.05, z));
      this.muzzle.position.set(0, -0.05, -3.1);
      this.armL.add(part(0.45, 0.45, 0.45, plate, 0, 0.1, 0), part(0.32, 1.1, 0.36, armor, 0, -0.6, 0), part(0.4, 0.34, 0.42, dark, 0, -1.25, -0.04));
      // Jump-jet packs on the back, where the leap's flames come out.
      for (const x of [-0.58, 0.58]) {
        this.torso.add(part(0.34, 1.25, 0.5, dark, x, ty + 0.35, td / 2 + 0.2), part(0.38, 0.2, 0.54, plate, x, ty + 0.95, td / 2 + 0.2));
        const jet = flame(0.22, 1.8, x, ty - 0.75, td / 2 + 0.2, Math.PI);
        this.flames.push(jet);
        this.torso.add(jet);
      }
      // A sensor fin on top, the Lynx's tell from far off.
      this.torso.add(part(0.08, 0.7, 0.9, plate, 0, top + 0.35, 0.1));
    } else {
      // Autocannon, as before.
      this.armR.add(
        part(0.7, 0.62, 0.62, plate, 0, 0.12, 0),
        part(0.6, 0.72, 1.6, armor, 0, -0.18, -0.35),
        part(0.24, 0.24, 1.7, dark, 0, -0.1, -1.7),
        part(0.16, 0.16, 1.3, dark, 0, -0.36, -1.5),
        part(0.34, 0.34, 0.24, dark, 0, -0.1, -2.5),
      );
      this.muzzle.position.set(0, -0.1, -2.66);
      // Left arm: a heavy fist that swings as it walks.
      this.armL.add(part(0.7, 0.62, 0.62, plate, 0, 0.12, 0), part(0.52, 1.3, 0.56, armor, 0, -0.75, 0), part(0.62, 0.5, 0.66, dark, 0, -1.55, -0.04));
    }
    this.muzzleFlash.position.copy(this.muzzle.position);
    this.armR.add(this.muzzle, this.muzzleFlash);

    const A = frame.ability;
    if (A.kind === 'salvo') {
      // Rocket pod on the shoulder, where the simulation launches the salvo from.
      const podBox = part(0.95, 0.62, 1.2, armor, A.side - 0.1, A.height - this.base, 0.05);
      for (const [px, py] of [[-0.2, 0.13], [0.2, 0.13], [-0.2, -0.13], [0.2, -0.13]]) podBox.add(part(0.26, 0.2, 0.06, this.podMat, px, py, -0.61));
      this.pod.position.set(0, 0, -0.7);
      podBox.add(this.pod);
      this.torso.add(podBox);
    }
    if (frame.mobility.kind === 'dash') {
      for (const x of [-0.6, 0.6]) {
        const jet = flame(0.26, 1.9, x, 0.5, 1.6, -Math.PI / 2);
        this.flames.push(jet);
        this.torso.add(jet);
      }
    }

    if (A.kind === 'shield') {
      // The wall: a sheet of light, bowed a little, with a brighter rim.
      const mat = new THREE.MeshBasicMaterial({ color: look.visor, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const geo = new THREE.PlaneGeometry(A.width, A.height, 12, 6);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, (pos.getX(i) / (A.width / 2)) ** 2 * 0.45);
      geo.computeVertexNormals();
      const sheet = new THREE.Mesh(geo, mat);
      sheet.position.set(0, A.height / 2, -A.forward);
      const rim = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(A.width, A.height)), new THREE.LineBasicMaterial({ color: look.visor, transparent: true, opacity: 0.8 }));
      rim.position.copy(sheet.position);
      const wall = new THREE.Group();
      wall.add(sheet, rim);
      wall.visible = false;
      this.shieldWall = wall;
      this.shieldMat = mat;
      this.root.add(wall);
    }

    this.rig.add(this.hips);
    if (marker) {
      const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.55, 4), new THREE.MeshBasicMaterial({ color: look.visor }));
      chevron.rotation.x = Math.PI;
      chevron.position.y = frame.body.height + 0.9;
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

  /** The stomp: the whole machine drops onto its legs. */
  stomp(): void {
    this.dip.v -= 14;
  }

  /** Flash when hit: white, or yellow for a hit on the vent. */
  flash(crit: boolean): void {
    this.hit = 1;
    this.hitCrit = crit;
  }

  /** Fire stopped by the shield lights it up. */
  shieldHit(): void {
    this.shieldFlash = 1;
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

  /** Height of the standing legs for a pose, feet to hips. */
  private legReach(hip: number, knee: number): number {
    return this.shape.thigh * Math.cos(hip) + this.shape.shin * Math.cos(hip + knee) + FOOT;
  }

  private setLeg(leg: Leg, hip: number, knee: number): number {
    leg.hip.rotation.x = hip;
    leg.knee.rotation.x = knee;
    leg.foot.rotation.x = -(hip + knee);
    return this.legReach(hip, knee);
  }

  /** Every material on the body: what the cloak fades. */
  private bodyMaterials(): THREE.Material[] {
    return [this.armor, this.plate, this.dark, this.glass, this.ventMat, this.podMat];
  }

  /** Fade the body for the cloak. Materials switch to blending only while they need it. */
  private setSeen(seen: number): void {
    const fading = seen < 0.999;
    const mats = this.bodyMaterials();
    for (const mat of mats) mat.opacity = seen;
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

  /**
   * `pos`, `yaw` and `pitch` are the drawn (interpolated) values; `show` hides the
   * model for the pilot looking out of it while everything keeps animating.
   */
  update(dt: number, k: Mech, pos: Vec3, yaw: number, pitch: number, show: boolean): void {
    this.time += dt;
    const F = frameOf(k);
    if (k.state === 'none') {
      this.zone.visible = false;
      if (this.shieldWall) this.shieldWall.visible = false;
      this.lastState = 'none';
      if (this.seen < 1) this.setSeen((this.seen = 1));
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
    const stride = F.move.strideLength;
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
      this.gait = damp(this.gait, k.grounded ? Math.min(1, speed / F.move.walkSpeed) : 0, 8, dt);
      const phase = (this.foot + k.stride / stride) * Math.PI;
      const swing = Math.cos(phase) * 0.48 * this.gait;
      const lift = Math.sin(phase) * 0.75 * this.gait;
      hipL = STAND[0] + swing + Math.max(0, -lift) * 0.3;
      kneeL = STAND[1] - Math.max(0, -lift);
      hipR = STAND[0] - swing + Math.max(0, lift) * 0.3;
      kneeR = STAND[1] - Math.max(0, lift);
      if (!k.grounded) {
        // In the air: knees drawn up while it rises, reaching for the ground as it falls.
        const rising = k.vel.y > 0;
        hipL = hipR = rising ? 0.75 : 0.45;
        kneeL = kneeR = rising ? -1.3 : -0.8;
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
      leanZ = Math.sin((this.foot + k.stride / stride) * Math.PI) * 0.035 * this.gait;
    }
    this.hips.rotation.x = damp(this.hips.rotation.x, leanX, 12, dt);
    this.hips.rotation.z = damp(this.hips.rotation.z, leanZ, 12, dt);

    const torsoPitch = piloted ? clamp(pitch * 0.3, -0.3, 0.3) : bow;
    this.torso.rotation.x = damp(this.torso.rotation.x, torsoPitch, 12, dt);
    this.armR.rotation.x = damp(this.armR.rotation.x, piloted ? pitch - this.torso.rotation.x : -0.5, 16, dt);
    // The Bastion's shield arm comes up in front while the wall is up.
    const guard = k.shieldUp ? -1.1 : 0;
    const armSwing = piloted ? Math.cos((this.foot + k.stride / stride) * Math.PI) * 0.3 * this.gait : 0;
    this.armL.rotation.x = damp(this.armL.rotation.x, piloted ? armSwing + 0.1 + guard : -0.15, 12, dt);
    this.hatch.rotation.x = damp(this.hatch.rotation.x, open * 1.15, 9, dt);
    this.glass.emissiveIntensity = damp(this.glass.emissiveIntensity, glow, 8, dt);
    // The vent breathes, so the weak point catches the eye from behind.
    this.ventMat.emissiveIntensity = 1.05 + Math.sin(this.time * 5) * 0.35;

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
    this.podMat.emissiveIntensity = this.podGlow * 4;

    if (this.hit > 0 || this.armor.emissive.r > 0) {
      this.hit = Math.max(0, this.hit - dt * 8);
      this.armor.emissive.lerpColors(BLACK, this.hitCrit ? CRIT : WHITE, this.hit * 0.7);
      this.plate.emissive.copy(this.armor.emissive);
    }

    this.updateShield(dt, k, show);
    this.updateCloak(dt, k);
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
    wall.rotation.y = this.torso.rotation.y;
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
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) mat.dispose();
      }
    });
  }
}
