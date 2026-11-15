import * as THREE from 'three';
import { lenH, type Actor, type Vec3 } from '@dropline/shared';

/** Per-team look. Allies also carry a chevron overhead, so teams never rest on colour alone. */
export const TEAM_LOOK = [
  { plate: '#2f86c6', visor: '#58d6ff', tracer: '#8fe6ff' },
  { plate: '#d2452c', visor: '#ff5a3c', tracer: '#ffb38a' },
];

const FLAME = new THREE.MeshBasicMaterial({
  color: '#ffb066',
  transparent: true,
  opacity: 0.85,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const GUN = new THREE.MeshStandardMaterial({ color: '#1c2026', roughness: 0.6, metalness: 0.5 });
const MUZZLE = new THREE.MeshBasicMaterial({
  color: '#ffd9a0',
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const WHITE = new THREE.Color('#ffffff');
const BLACK = new THREE.Color('#000000');

/** Third-person weapon shape per weapon id: length, thickness. */
const GUN_SHAPE: Record<string, [number, number]> = {
  carbine: [0.55, 1],
  scattergun: [0.5, 1.5],
  longshot: [0.9, 0.9],
};

let noticeTexture: THREE.CanvasTexture | null = null;

/** The "!" shown over a bot that has just spotted someone. Drawn once, shared by all. */
function noticeMark(): THREE.CanvasTexture {
  if (noticeTexture) return noticeTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffd23f';
  g.strokeStyle = '#120a05';
  g.lineWidth = 6;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(22, 6);
  g.lineTo(42, 6);
  g.lineTo(37, 40);
  g.lineTo(27, 40);
  g.closePath();
  g.stroke();
  g.fill();
  g.beginPath();
  g.arc(32, 52, 6, 0, Math.PI * 2);
  g.stroke();
  g.fill();
  noticeTexture = new THREE.CanvasTexture(c);
  noticeTexture.colorSpace = THREE.SRGBColorSpace;
  return noticeTexture;
}

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

const tmp = new THREE.Vector3();

/**
 * Placeholder pilot built from boxes with procedural animation. It stands in
 * until real rigged models exist; the model faces -Z like the camera.
 */
export class Avatar {
  readonly root = new THREE.Group();
  /** Aiming laser of a marksman; lives in world space, so the game adds it to the scene. */
  readonly laser: THREE.Mesh;
  private readonly body = new THREE.Group();
  private readonly upper = new THREE.Group();
  private readonly armor: THREE.MeshStandardMaterial;
  private readonly plate: THREE.MeshStandardMaterial;
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly gun = new THREE.Group();
  private readonly muzzle = new THREE.Object3D();
  private readonly muzzleFlash: THREE.Mesh;
  private readonly flames: THREE.Mesh[] = [];
  private readonly mark: THREE.Sprite;
  private readonly laserMat: THREE.MeshBasicMaterial;
  private phase = 0;
  private heading = 0;
  private hit = 0;
  private shot = 0;
  private noticed = 0;
  private dead = -1;
  private weapon = '';

  constructor(team: number, ally: boolean) {
    const look = TEAM_LOOK[team];
    this.armor = new THREE.MeshStandardMaterial({ color: '#2c323b', roughness: 0.55, metalness: 0.45 });
    this.plate = new THREE.MeshStandardMaterial({ color: look.plate, roughness: 0.5, metalness: 0.3 });
    const visor = new THREE.MeshStandardMaterial({ color: '#0b1a22', emissive: look.visor, emissiveIntensity: 2.2 });

    const part = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      return mesh;
    };
    /** A limb that swings from its top end. */
    const limb = (w: number, len: number, d: number, x: number, y: number): THREE.Group => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      pivot.add(part(w, len, d, this.armor, 0, -len / 2, 0));
      return pivot;
    };
    this.legL = limb(0.18, 0.9, 0.2, -0.14, 0.9);
    this.legR = limb(0.18, 0.9, 0.2, 0.14, 0.9);
    this.armL = limb(0.13, 0.62, 0.14, -0.34, 1.5);
    this.armR = limb(0.13, 0.62, 0.14, 0.34, 1.5);

    // The weapon lies along the right arm, so raising the arm points it.
    this.gun.position.set(-0.04, -0.56, 0);
    this.gun.add(part(0.07, 1, 0.12, GUN, 0, -0.3, 0.02), part(0.045, 0.5, 0.045, GUN, 0, -0.95, -0.01));
    this.muzzle.position.set(0, -1.22, -0.01);
    this.muzzleFlash = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), MUZZLE.clone());
    this.muzzleFlash.position.copy(this.muzzle.position);
    this.muzzleFlash.visible = false;
    this.gun.add(this.muzzle, this.muzzleFlash);
    this.armR.add(this.gun);

    this.upper.add(
      part(0.52, 0.62, 0.3, this.armor, 0, 1.22, 0),
      part(0.56, 0.2, 0.34, this.plate, 0, 1.46, 0),
      part(0.26, 0.28, 0.28, this.armor, 0, 1.7, 0),
      part(0.22, 0.08, 0.03, visor, 0, 1.72, -0.15),
      part(0.34, 0.4, 0.16, this.armor, 0, 1.28, 0.22),
      this.armL,
      this.armR,
    );
    for (const x of [-0.1, 0.1]) {
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.5, 8), FLAME);
      flame.rotation.x = Math.PI;
      flame.position.set(x, 0.86, 0.22);
      flame.visible = false;
      this.flames.push(flame);
      this.upper.add(flame);
    }
    this.body.add(this.upper, this.legL, this.legR);
    this.root.add(this.body);

    if (ally) {
      const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.2, 4), new THREE.MeshBasicMaterial({ color: look.visor }));
      chevron.rotation.x = Math.PI;
      chevron.position.y = 2.2;
      this.root.add(chevron);
    }
    this.mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: noticeMark(), depthTest: false, transparent: true }));
    this.mark.position.y = 2.45;
    this.mark.visible = false;
    this.root.add(this.mark);

    this.laserMat = new THREE.MeshBasicMaterial({
      color: '#ffd23f',
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.laser = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.laserMat);
    this.laser.visible = false;
    this.laser.frustumCulled = false;
  }

  /** White flash when hit. */
  flash(): void {
    this.hit = 1;
  }

  fireFlash(): void {
    this.shot = 1;
  }

  /** Pop the "!" over the head. */
  notice(): void {
    this.noticed = 0.9;
  }

  /** World position of the weapon's muzzle, as of the last update. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  /**
   * Show the marksman's aiming laser from the muzzle to `end`. `charge` runs 0..1
   * over the wind-up; once `locked` the beam turns red and thicker and stops tracking.
   */
  setLaser(charge: number, locked: boolean, end: Vec3 | null): void {
    const on = charge > 0 && end !== null && this.dead < 0;
    this.laser.visible = on;
    if (!on) return;
    this.muzzleWorld(tmp);
    const len = Math.hypot(end.x - tmp.x, end.y - tmp.y, end.z - tmp.z);
    const width = locked ? 0.07 : 0.025;
    this.laser.position.set((tmp.x + end.x) / 2, (tmp.y + end.y) / 2, (tmp.z + end.z) / 2);
    this.laser.lookAt(end.x, end.y, end.z);
    this.laser.scale.set(width, width, len);
    this.laserMat.color.set(locked ? '#ff3b2f' : '#ffd23f');
    this.laserMat.opacity = locked ? 0.95 : 0.35 + charge * 0.4;
  }

  /**
   * `raise` (0..1) lifts the weapon to the shoulder; `show` hides the model in
   * first person while everything else keeps animating.
   */
  update(dt: number, a: Actor, pos: Vec3, show: boolean, raise: number): void {
    const s = a.p;
    if (a.loadout[a.weapon] !== this.weapon) {
      this.weapon = a.loadout[a.weapon];
      const [len, thick] = GUN_SHAPE[this.weapon] ?? GUN_SHAPE.carbine;
      this.gun.scale.set(thick, len, thick);
    }

    // Death: fall backwards, lie there, then clear away.
    if (!a.alive) {
      if (this.dead < 0) this.dead = 0;
      this.dead += dt;
      this.mark.visible = false;
      this.laser.visible = false;
      this.muzzleFlash.visible = false;
      for (const flame of this.flames) flame.visible = false;
      this.root.visible = this.dead < 2.4;
      const fall = Math.min(1, this.dead / 0.35);
      this.body.rotation.x = -1.5 * fall * fall;
      this.body.position.y = 0.16 * fall;
      this.legL.rotation.x = damp(this.legL.rotation.x, 0.25, 10, dt);
      this.legR.rotation.x = damp(this.legR.rotation.x, -0.1, 10, dt);
      this.armL.rotation.x = damp(this.armL.rotation.x, -0.6, 10, dt);
      this.armR.rotation.x = damp(this.armR.rotation.x, -0.9, 10, dt);
      this.tint(dt);
      return;
    }
    if (this.dead >= 0) {
      this.dead = -1;
      this.body.rotation.set(0, 0, 0);
      this.body.position.y = 0;
      this.heading = s.yaw;
    }

    this.root.visible = show;
    this.root.position.set(pos.x, pos.y, pos.z);

    const speed = lenH(s.vel);
    // Face where the pilot looks, except when momentum decides (wallrun, slide).
    let facing = s.yaw;
    if ((s.wallrun.active || s.sliding) && speed > 1 && raise < 0.5) facing = Math.atan2(-s.vel.x, -s.vel.z);
    const turn = Math.atan2(Math.sin(facing - this.heading), Math.cos(facing - this.heading));
    this.heading += turn * (1 - Math.exp(-18 * dt));
    this.root.rotation.y = this.heading;

    const running = s.grounded && !s.sliding;
    const stride = running ? Math.min(1, speed / 8) : 0;
    this.phase += speed * dt * 1.5;
    const swing = Math.sin(this.phase) * 0.9 * stride;

    let legL = swing;
    let legR = -swing;
    // Weapon carried low while moving, shouldered (and pitched with the view) to shoot.
    const aimAngle = Math.PI / 2 + s.pitch + a.punchPitch;
    let armR = 0.75 + (aimAngle - 0.75) * raise - swing * 0.15 * (1 - raise);
    let armL = 0.9 + (aimAngle - 0.9) * raise + swing * 0.15 * (1 - raise);
    let lean = 0;
    let pitch = running ? -0.12 * stride : 0;
    let drop = 0;

    if (s.sliding) {
      pitch = 0.95;
      drop = -0.55;
      legL = -1.15;
      legR = -0.85;
      armR -= 0.9;
      armL -= 0.9;
    } else if (s.wallrun.active) {
      lean = s.wallrun.side * 0.32;
      const fast = Math.sin(this.phase * 1.2) * 0.9;
      legL = fast;
      legR = -fast;
    } else if (s.mantle.active) {
      armL = armR = -2.6;
      legL = -0.5;
      legR = 0.2;
    } else if (!s.grounded) {
      legL = -0.55;
      legR = 0.25;
    } else if (s.crouched) {
      drop = -0.42;
      legL = -1.0 + swing * 0.4;
      legR = -1.0 - swing * 0.4;
      pitch = 0.25;
      armR -= 0.25;
      armL -= 0.25;
    }
    // Reloading tips the weapon up toward the off hand.
    if (a.reload > 0) {
      armR = 1.0;
      armL = 1.5;
    }

    this.legL.rotation.x = damp(this.legL.rotation.x, legL, 20, dt);
    this.legR.rotation.x = damp(this.legR.rotation.x, legR, 20, dt);
    this.armL.rotation.x = damp(this.armL.rotation.x, armL, 20, dt);
    this.armR.rotation.x = damp(this.armR.rotation.x, armR, 22, dt);
    // The off hand reaches across to the weapon.
    this.armL.rotation.z = damp(this.armL.rotation.z, s.mantle.active ? 0 : -0.55, 14, dt);
    this.body.rotation.z = damp(this.body.rotation.z, lean, 12, dt);
    this.body.rotation.x = damp(this.body.rotation.x, pitch, 12, dt);
    this.body.position.y = damp(this.body.position.y, drop, 16, dt);

    for (const flame of this.flames) {
      flame.visible = s.thrusting;
      flame.scale.y = 0.8 + Math.random() * 0.6;
    }

    this.shot = Math.max(0, this.shot - dt * 16);
    this.muzzleFlash.visible = this.shot > 0;
    if (this.shot > 0) {
      this.muzzleFlash.scale.setScalar(0.6 + this.shot * 0.9);
      this.muzzleFlash.rotation.y = Math.random() * 6.28;
      (this.muzzleFlash.material as THREE.MeshBasicMaterial).opacity = this.shot;
    }

    this.noticed = Math.max(0, this.noticed - dt);
    this.mark.visible = this.noticed > 0;
    if (this.noticed > 0) {
      // Pop in big, settle, then shrink away.
      const age = 0.9 - this.noticed;
      const pop = age < 0.12 ? 0.5 + (age / 0.12) * 0.9 : 1.4 - Math.min(0.4, (age - 0.12) * 4);
      this.mark.scale.setScalar(0.55 * pop * Math.min(1, this.noticed * 6));
    }
    this.tint(dt);
  }

  private tint(dt: number): void {
    if (this.hit <= 0 && this.armor.emissive.r === 0) return;
    this.hit = Math.max(0, this.hit - dt * 9);
    this.armor.emissive.lerpColors(BLACK, WHITE, this.hit * 0.9);
    this.plate.emissive.copy(this.armor.emissive);
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.laser.geometry.dispose();
    this.laserMat.dispose();
    this.armor.dispose();
    this.plate.dispose();
  }
}
