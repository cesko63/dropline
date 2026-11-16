import * as THREE from 'three';
import { COMBAT, MECH, WEAPONS, clamp, lenH, type Actor, type Mech } from '@dropline/shared';
import { spring, stepSpring } from '../util/spring';

/** Where the suit's arm sits at the hip, raised to aim, and lowered while the shoulder pod is in use. */
const ARM_REST = new THREE.Vector3(0.2, -0.2, -0.56);
const ARM_AIM = new THREE.Vector3(0.1, -0.14, -0.52);
const ARM_STOWED = new THREE.Vector3(0.3, -0.43, -0.46);
/** Height of the barrels' axis on the arm: along the top of the housing, where the player can see them. */
const BARREL_Y = 0.05;
/** The arm is turned a little toward the middle of the view, so its length shows. */
const ARM_YAW = 0.1;
/** Where the coolant cell sits in its port on top of the housing. */
const CELL_SEAT = new THREE.Vector3(-0.03, 0.094, 0.05);
/** The mech's cannon arm, seen from the cockpit. */
const CANNON_REST = new THREE.Vector3(0.5, -0.37, -0.8);
/** The shoulder pod: swung up beside the head, pulled in to aim, and folded away behind the shoulder. */
const POD_UP = new THREE.Vector3(0.5, 0.27, -0.75);
const POD_AIM = new THREE.Vector3(0.41, 0.245, -0.78);
const POD_AWAY = new THREE.Vector3(0.66, 0.56, -0.3);

/** Reload, as a share of its time: the spent cell leaves, the housing vents, a fresh cell seats. */
const CELL_OUT = 0.14;
const VENT_END = 0.6;
const CELL_IN = 0.85;

const COOL = new THREE.Color('#58d6ff');
const WARM = new THREE.Color('#ff9a3c');
const HOT = new THREE.Color('#ff3b1f');

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** One barrel the arm can extend. Built along -Z from the collar; `ext` 0 is fully drawn in. */
interface Barrel {
  group: THREE.Group;
  length: number;
  ext: number;
  /** Kick per shot: backwards (meters) and muzzle climb (radians). */
  kickBack: number;
  kickUp: number;
}

/** Something thrown clear of the weapon: a mech's spent casing, a pilot's spent coolant cell. */
interface Debris {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

interface Puff {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vel: THREE.Vector3;
  life: number;
  span: number;
}

const tmp = new THREE.Vector3();

/**
 * What the player sees of their own body (box stand-ins): on foot the suit's
 * right arm with its built-in weapon and the launcher pod on the shoulder, in a
 * mech the cannon arm and the cockpit.
 *
 * The arm has one housing and three barrels. Switching weapons draws one barrel
 * in and extends another; there is no magazine, so a reload throws out the
 * spent coolant cell, vents the housing and seats a fresh cell.
 *
 * Drawn in its own scene after the world with the depth buffer cleared, so it
 * never pokes through walls and keeps its own field of view while the world
 * camera zooms.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  /** Carries the arm on foot and the cannon in a mech. */
  private readonly rig = new THREE.Group();
  private readonly arm = new THREE.Group();
  private readonly collar = new THREE.Group();
  private readonly barrels: Record<string, Barrel> = {};
  private readonly armMuzzle = new THREE.Object3D();
  private readonly cell = new THREE.Group();
  /** Where steam leaves the housing. */
  private readonly vents = new THREE.Object3D();
  /** One material for everything on the arm that shows heat: the strip, the slats and the cell. */
  private readonly heatMat: THREE.MeshStandardMaterial;
  private barrelId = '';
  private heat = 0;
  private pulse = 0;
  private cellOut = false;
  private steamT = 0;

  private readonly pod = new THREE.Group();
  private readonly podMuzzles: THREE.Object3D[] = [];
  private readonly tubeMats: THREE.MeshStandardMaterial[] = [];
  private tube = 0;
  /** 0 with the pod folded away, 1 with it up and the arm lowered. */
  private deploy = 0;

  private readonly cannon = new THREE.Group();
  private readonly cannonMuzzle = new THREE.Object3D();
  private readonly cannonPort = new THREE.Object3D();

  /** The muzzle the current weapon fires from. */
  private muzzle: THREE.Object3D = this.armMuzzle;
  private kickBack = 0;
  private kickUp = 0;
  private mode: 'arm' | 'pod' | 'cannon' = 'arm';

  private readonly flash: THREE.Mesh;
  private readonly flashLight = new THREE.PointLight('#ffc27a', 0, 3, 2);
  private readonly casings: Debris[] = [];
  private nextCasing = 0;
  private readonly spentCell: Debris;
  private readonly spentMat: THREE.MeshStandardMaterial;
  private readonly puffs: Puff[] = [];
  private nextPuff = 0;
  private bob = 0;
  private idle = 0;
  private swayX = 0;
  private swayY = 0;
  private readonly back = spring();
  private readonly climb = spring();
  private flashT = 0;
  /** The mech's cockpit: a frame around the view, lit when the machine is running. */
  private readonly cockpit = new THREE.Group();
  private readonly pillars: THREE.Mesh[] = [];
  private readonly panelGlow: THREE.MeshStandardMaterial;
  private readonly rattle = spring();
  private seated = 0;

  constructor() {
    const metal = new THREE.MeshStandardMaterial({ color: '#6b7584', roughness: 0.5, metalness: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: '#343a45', roughness: 0.7, metalness: 0.15 });
    const bore = new THREE.MeshStandardMaterial({ color: '#0c0e12', roughness: 0.9 });
    const glow = new THREE.MeshStandardMaterial({ color: '#30140a', emissive: '#ff7a2f', emissiveIntensity: 1.3 });
    const lens = new THREE.MeshStandardMaterial({ color: '#06121a', emissive: '#58d6ff', emissiveIntensity: 0.9 });
    const glove = new THREE.MeshStandardMaterial({ color: '#3a3f47', roughness: 0.9 });
    const sleeve = new THREE.MeshStandardMaterial({ color: '#3a414c', roughness: 0.7, metalness: 0.2 });
    const plate = new THREE.MeshStandardMaterial({ color: '#7d8795', roughness: 0.45, metalness: 0.35 });
    this.heatMat = new THREE.MeshStandardMaterial({ color: '#0a1820', emissive: COOL, emissiveIntensity: 0.8 });

    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, 0);
      return mesh;
    };

    // --- The suit's right arm. Its origin is the wrist; the forearm runs back and
    // down out of view toward the elbow, so it reads as the player's own arm.
    this.arm.add(
      box(0.088, 0.088, 0.62, sleeve, 0.045, -0.085, 0.37, 0.17, 0.12),
      box(0.1, 0.026, 0.3, dark, 0.035, -0.022, 0.3, 0.17, 0.12),
      // The weapon housing, built around the wrist.
      box(0.13, 0.115, 0.3, metal, 0, 0.02, -0.02),
      box(0.05, 0.022, 0.22, dark, 0.03, 0.086, -0.03),
      // The fist under the barrel, with a guard over the knuckles.
      box(0.085, 0.075, 0.11, glove, -0.005, -0.08, -0.16),
      box(0.092, 0.03, 0.06, plate, -0.005, -0.058, -0.2),
      // Heat strip along the top edge and three slats on the side that faces the player.
      box(0.016, 0.012, 0.2, this.heatMat, 0.05, 0.1, -0.04),
      box(0.006, 0.055, 0.028, this.heatMat, -0.067, 0.02, -0.11),
      box(0.006, 0.055, 0.028, this.heatMat, -0.067, 0.02, -0.06),
      box(0.006, 0.055, 0.028, this.heatMat, -0.067, 0.02, -0.01),
    );
    this.vents.position.set(-0.08, 0.04, -0.06);
    // The coolant cell sits in a port on the top of the housing, toward the player.
    // A canister with a window that shows the heat inside.
    this.cell.position.copy(CELL_SEAT);
    this.cell.add(box(0.046, 0.04, 0.13, plate, 0, 0, 0), box(0.02, 0.006, 0.1, this.heatMat, 0, 0.021, 0));
    this.arm.add(this.vents, this.cell);

    // The collar the barrels pass through. It turns while they change over.
    this.collar.position.set(0, BARREL_Y, -0.185);
    this.collar.add(
      box(0.1, 0.1, 0.036, dark, 0, 0, 0),
      box(0.125, 0.026, 0.03, plate, 0, 0, 0),
      box(0.026, 0.125, 0.03, plate, 0, 0, 0),
    );
    this.arm.add(this.collar);

    const barrel = (id: string, length: number, kickBack: number, kickUp: number, parts: THREE.Mesh[]): void => {
      const group = new THREE.Group();
      group.position.set(0, BARREL_Y, -0.2);
      group.add(...parts);
      group.visible = false;
      this.arm.add(group);
      this.barrels[id] = { group, length, ext: 0, kickBack, kickUp };
    };
    // Carbine: one barrel in a short shroud.
    barrel('carbine', 0.34, 0.035, 0.05, [
      box(0.062, 0.07, 0.2, metal, 0, 0, -0.1),
      box(0.03, 0.03, 0.34, dark, 0, 0.004, -0.17),
      box(0.066, 0.008, 0.14, glow, 0, 0.037, -0.1),
    ]);
    // Scattergun: a wide, short block with three bores.
    barrel('scattergun', 0.2, 0.085, 0.16, [
      box(0.15, 0.075, 0.18, dark, 0, 0, -0.09),
      box(0.16, 0.012, 0.05, metal, 0, 0.044, -0.15),
      box(0.16, 0.012, 0.05, metal, 0, -0.044, -0.15),
      box(0.032, 0.032, 0.02, bore, -0.046, 0, -0.176),
      box(0.032, 0.032, 0.02, bore, 0, 0, -0.176),
      box(0.032, 0.032, 0.02, bore, 0.046, 0, -0.176),
      box(0.1, 0.008, 0.08, glow, 0, 0.039, -0.07),
    ]);
    // Marksman: two long rails with a lit core between them.
    barrel('longshot', 0.62, 0.07, 0.11, [
      box(0.018, 0.062, 0.6, dark, -0.026, 0, -0.3),
      box(0.018, 0.062, 0.6, dark, 0.026, 0, -0.3),
      box(0.012, 0.012, 0.56, lens, 0, 0, -0.3),
      box(0.076, 0.072, 0.04, metal, 0, 0, -0.6),
      box(0.076, 0.072, 0.03, metal, 0, 0, -0.3),
    ]);
    this.arm.add(this.armMuzzle);
    this.arm.scale.setScalar(0.78);
    this.arm.visible = false;
    this.rig.add(this.arm);

    // --- The launcher pod on the right shoulder: two tubes, on an arm that leads
    // back and down to the shoulder it is hinged on.
    this.pod.add(
      box(0.21, 0.15, 0.4, metal, 0, 0, 0),
      box(0.22, 0.03, 0.26, plate, 0, 0.08, 0.02),
      box(0.215, 0.03, 0.3, dark, 0, -0.065, 0),
      box(0.085, 0.085, 0.06, dark, -0.052, 0, -0.215),
      box(0.085, 0.085, 0.06, dark, 0.052, 0, -0.215),
      box(0.07, 0.07, 0.56, sleeve, 0.09, -0.19, 0.36, 0.55, 0.22),
    );
    [-0.052, 0.052].forEach((x, i) => {
      const mat = new THREE.MeshStandardMaterial({ color: '#1a0d06', emissive: '#ffb347', emissiveIntensity: 1.4 });
      const muzzle = new THREE.Object3D();
      muzzle.position.set(x, 0, -0.27);
      // Each tube's mouth glows while it holds a rocket, and so does its light on
      // the side of the pod that faces the player, who sees the pod from behind.
      this.pod.add(box(0.055, 0.055, 0.012, mat, x, 0, -0.247), box(0.012, 0.045, 0.09, mat, -0.108, 0.01, 0.06 - i * 0.13), muzzle);
      this.tubeMats.push(mat);
      this.podMuzzles.push(muzzle);
    });
    this.pod.scale.setScalar(0.54);
    this.pod.visible = false;
    this.scene.add(this.pod);

    // --- The mech's cannon: its right arm, seen from the cockpit.
    this.cannon.add(
      box(0.22, 0.22, 0.62, dark, 0, 0, 0.12),
      box(0.02, 0.012, 0.14, glow, 0, 0.078, -0.3),
      box(0.075, 0.075, 0.72, metal, 0, 0.035, -0.52),
      box(0.05, 0.05, 0.56, dark, 0, -0.06, -0.44),
      box(0.11, 0.11, 0.09, dark, 0, 0.035, -0.9),
      box(0.17, 0.17, 0.8, sleeve, 0.1, -0.12, 0.7, 0.2, -0.25),
    );
    this.cannonMuzzle.position.set(0, 0.02, -0.96);
    this.cannonPort.position.set(0.04, 0.05, -0.04);
    this.cannon.add(this.cannonMuzzle, this.cannonPort);
    this.cannon.scale.setScalar(0.8);
    this.cannon.visible = false;
    this.rig.add(this.cannon);

    // Cockpit frame: a dashboard below, a bar above and a pillar at each side.
    const frame = new THREE.MeshStandardMaterial({ color: '#1b1f26', roughness: 0.8, metalness: 0.3 });
    this.panelGlow = new THREE.MeshStandardMaterial({ color: '#0a1820', emissive: '#58d6ff', emissiveIntensity: 0 });
    this.cockpit.add(
      box(2.6, 0.2, 0.3, frame, 0, -0.42, -0.62, -0.5),
      box(2.6, 0.08, 0.12, frame, 0, 0.345, -0.6),
      box(0.5, 0.012, 0.03, this.panelGlow, -0.42, -0.325, -0.6),
      box(0.5, 0.012, 0.03, this.panelGlow, 0.42, -0.325, -0.6),
      box(0.05, 0.03, 0.03, glow, 0, -0.325, -0.6),
    );
    for (const side of [-1, 1]) {
      const pillar = box(0.045, 1.1, 0.05, frame, side, 0, -0.6);
      pillar.rotation.z = side * 0.1;
      this.pillars.push(pillar);
      this.cockpit.add(pillar);
    }
    this.cockpit.visible = false;
    this.scene.add(this.cockpit);

    this.flash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.035, 0),
      new THREE.MeshBasicMaterial({ color: '#ffe0a8', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.flash.visible = false;
    this.scene.add(this.flash, this.flashLight);

    const brass = new THREE.MeshStandardMaterial({ color: '#c9a04a', roughness: 0.35, metalness: 0.8 });
    const casingGeo = new THREE.BoxGeometry(0.006, 0.006, 0.016);
    for (let i = 0; i < 10; i++) {
      const mesh = new THREE.Mesh(casingGeo, brass);
      mesh.visible = false;
      this.scene.add(mesh);
      this.casings.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 });
    }
    // The spent cell glows as it is thrown out and goes dark as it falls.
    this.spentMat = new THREE.MeshStandardMaterial({ color: '#1a0d06', emissive: HOT, emissiveIntensity: 2 });
    const spent = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.031, 0.1), this.spentMat);
    spent.visible = false;
    this.scene.add(spent);
    this.spentCell = { mesh: spent, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 };

    const puffGeo = new THREE.IcosahedronGeometry(0.02, 0);
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: '#d5e8f2', transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(puffGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.puffs.push({ mesh, mat, vel: new THREE.Vector3(), life: 0, span: 1 });
    }

    this.scene.add(this.rig);
    // Matches the world's light rig: cool sky fill, warm sun from the same side.
    this.scene.add(new THREE.HemisphereLight('#bcd6ff', '#40342c', 1.6));
    const key = new THREE.DirectionalLight('#ffd0a0', 2.4);
    key.position.set(-1, 2, 1);
    this.scene.add(key);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // The pillars stand just inside the left and right edges, whatever the window's shape.
    const edge = Math.tan((this.camera.fov / 2) * (Math.PI / 180)) * 0.6 * aspect;
    this.pillars[0].position.x = -edge + 0.035;
    this.pillars[1].position.x = edge - 0.035;
  }

  /** Shake the cockpit: a footfall, a hit on the hull. */
  thud(amount: number): void {
    this.rattle.v -= amount;
  }

  /** Kick and flash for one shot; a mech's cannon also throws a casing, a hot arm lets off steam. */
  fire(): void {
    this.back.v += this.kickBack * 60;
    this.climb.v += this.kickUp * 60;
    this.flashT = 1;
    this.pulse = 1;
    if (this.mode === 'pod') {
      // The two tubes take turns.
      this.muzzle = this.podMuzzles[this.tube];
      this.tube = 1 - this.tube;
      return;
    }
    if (this.mode === 'arm') {
      if (this.heat > 0.55) this.steam(1);
      return;
    }
    const c = this.casings[this.nextCasing++ % this.casings.length];
    this.cannonPort.getWorldPosition(c.mesh.position);
    c.vel.set(0.9 + Math.random() * 0.5, 0.9 + Math.random() * 0.5, 0.15 - Math.random() * 0.3);
    c.spin.set(Math.random() * 30, Math.random() * 30, Math.random() * 30);
    c.life = 0.55;
    c.mesh.visible = true;
  }

  /**
   * Where the muzzle appears in the world as seen through `worldCamera`, so
   * tracers and rockets leave the barrel or the pod even though they are drawn
   * with another lens.
   */
  muzzleWorld(worldCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    this.muzzle.getWorldPosition(out);
    const depth = out.length();
    out.project(this.camera).unproject(worldCamera);
    const eye = worldCamera.position;
    out.sub(eye).normalize().multiplyScalar(depth).add(eye);
    return out;
  }

  /** Let steam out of the housing's vents. */
  private steam(count: number): void {
    for (let i = 0; i < count; i++) {
      const p = this.puffs[this.nextPuff++ % this.puffs.length];
      this.vents.getWorldPosition(p.mesh.position);
      p.mesh.position.x += (Math.random() - 0.5) * 0.03;
      p.mesh.position.z += (Math.random() - 0.5) * 0.1;
      p.vel.set(-0.1 - Math.random() * 0.14, 0.12 + Math.random() * 0.16, (Math.random() - 0.5) * 0.08);
      p.span = p.life = 0.4 + Math.random() * 0.3;
      p.mesh.visible = true;
    }
  }

  /** `mech` is the machine the pilot sits in, or null on foot. */
  update(dt: number, a: Actor, mouseDx: number, mouseDy: number, mech: Mech | null): void {
    const s = a.p;

    // The cockpit rises around the pilot as they sit down, and lights up as it starts.
    this.seated = damp(this.seated, mech ? 1 : 0, 10, dt);
    this.cockpit.visible = this.seated > 0.02;
    stepSpring(this.rattle, 150, 13, dt);
    if (this.cockpit.visible) {
      const online = mech && mech.state === 'boot' ? clamp(mech.stateTime / COMBAT.mech.embark.time, 0, 1) : mech ? 1 : 0;
      this.panelGlow.emissiveIntensity = online * (mech && mech.health < MECH.health * 0.25 ? 0.6 + 0.6 * Math.sin(performance.now() * 0.012) : 1.2);
      this.panelGlow.emissive.set(mech && mech.health < MECH.health * 0.25 ? '#ff5a3c' : '#58d6ff');
      this.cockpit.position.y = -0.5 * (1 - this.seated) + clamp(this.rattle.x, -0.05, 0.03);
      this.cockpit.rotation.z = clamp(this.rattle.x, -0.05, 0.05) * 0.2;
    }

    const id = a.loadout[a.weapon];
    const def = WEAPONS[id];
    const shoulder = !mech && def.mount === 'shoulder';
    const mode = mech ? 'cannon' : shoulder ? 'pod' : 'arm';
    if (mode !== this.mode) {
      this.mode = mode;
      this.back.x = this.back.v = this.climb.x = this.climb.v = 0;
      if (mode === 'pod') this.muzzle = this.podMuzzles[this.tube];
    }
    this.arm.visible = !mech;
    this.cannon.visible = mech !== null;
    if (mode === 'cannon') {
      this.muzzle = this.cannonMuzzle;
      this.kickBack = 0.05;
      this.kickUp = 0.018;
    } else if (mode === 'pod') {
      this.kickBack = 0.11;
      this.kickUp = 0.2;
    } else {
      this.muzzle = this.armMuzzle;
      if (id in this.barrels) this.barrelId = id;
      const b = this.barrels[this.barrelId];
      this.kickBack = b ? b.kickBack : 0;
      this.kickUp = b ? b.kickUp : 0;
    }

    const speed = lenH(s.vel);
    const calm = 1 - 0.85 * a.ads;
    const moving = (s.grounded && !s.sliding ? Math.min(1, speed / (mech ? 4 : 8)) : 0) * calm;
    // A mech's slow, heavy step, in time with its stride.
    this.bob = mech ? (mech.stride / MECH.move.strideLength) * Math.PI : this.bob + speed * dt * 1.35;
    this.idle += dt;

    // The weapon trails behind fast mouse turns and settles back.
    this.swayX = damp(this.swayX, clamp(-mouseDx * 0.0018, -0.07, 0.07) * calm, 10, dt);
    this.swayY = damp(this.swayY, clamp(mouseDy * 0.0018, -0.07, 0.07) * calm, 10, dt);

    // Recoil on springs: snaps back and up, then returns.
    stepSpring(this.back, 420, 30, dt);
    stepSpring(this.climb, 380, 26, dt);

    const k = smooth(a.ads);
    // How far through the reload, 0..1; -1 when not reloading.
    const reloading = a.reload > 0 ? clamp(1 - a.reload / def.reloadTime, 0, 1) : -1;
    // How far through the change of weapons, 1 at its start falling to 0.
    const changing = a.equip > 0 ? clamp(a.equip / def.equipTime, 0, 1) : 0;

    // The pod swings up over the shoulder while the arm lowers, and the other way round.
    this.deploy = damp(this.deploy, shoulder ? 1 : 0, 3.6 / Math.max(0.2, def.equipTime), dt);
    const up = smooth(clamp(this.deploy, 0, 1));

    let x: number;
    let y: number;
    let z: number;
    if (mech) {
      x = CANNON_REST.x;
      y = CANNON_REST.y;
      z = CANNON_REST.z;
    } else {
      // Raised to aim only while the arm is the weapon in use.
      const raise = k * (1 - up);
      x = ARM_REST.x + (ARM_AIM.x - ARM_REST.x) * raise;
      y = ARM_REST.y + (ARM_AIM.y - ARM_REST.y) * raise;
      z = ARM_REST.z + (ARM_AIM.z - ARM_REST.z) * raise;
      x += (ARM_STOWED.x - ARM_REST.x) * up;
      y += (ARM_STOWED.y - ARM_REST.y) * up;
      z += (ARM_STOWED.z - ARM_REST.z) * up;
    }
    x += Math.sin(this.bob) * 0.012 * moving + this.swayX;
    y += -Math.abs(Math.cos(this.bob)) * 0.014 * moving + this.swayY + Math.sin(this.idle * 1.7) * 0.0025 * calm;
    if (mode !== 'pod') z += this.back.x;
    if (mech) y += clamp(this.rattle.x, -0.05, 0.03) - 0.35 * (1 - this.seated);
    let roll = mech ? 0 : -0.1 * k * (1 - up);
    const turn = this.swayX * 2 + (mech ? 0 : ARM_YAW * (1 - 0.5 * k));
    let tip = -this.swayY * 2 + (mode !== 'pod' ? this.climb.x : 0) - 0.3 * (mech ? 0 : up);

    if (!s.grounded && !s.wallrun.active) y += clamp(-s.vel.y * 0.004, -0.04, 0.05) * calm;
    if (s.wallrun.active) roll += s.wallrun.side * 0.3 * calm;
    if (s.sliding) {
      roll += 0.4 * calm;
      y -= 0.03 * calm;
      x -= 0.05 * calm;
    }
    if (s.mantle.active) {
      y -= 0.22;
      tip -= 0.5;
    }
    if (reloading >= 0 && mech) {
      // A mech's arm only lowers while its loader cycles.
      const dip = Math.sin(Math.PI * reloading);
      y -= 0.2 * dip;
      roll += 0.12 * dip;
      tip -= 0.25 * dip;
    } else if (reloading >= 0 && mode === 'arm') {
      // The arm turns its cell port toward the player and holds there until the fresh cell is in.
      const show = smooth(clamp(reloading / 0.1, 0, 1)) * smooth(clamp((1 - reloading) / 0.1, 0, 1));
      y += 0.035 * show;
      x -= 0.045 * show;
      roll += 0.5 * show;
      tip += 0.16 * show;
    }
    // Changing barrels: a short dip while the collar turns. A mech's cannon rises into view instead.
    if (changing > 0) {
      if (mech) {
        y -= 0.32 * changing * changing;
        tip -= 0.9 * changing;
      } else {
        y -= 0.03 * Math.sin(Math.PI * changing);
      }
    }

    const p = this.rig.position;
    p.set(damp(p.x, x, 22, dt), damp(p.y, y, 22, dt), z);
    const r = this.rig.rotation;
    r.set(damp(r.x, tip, 18, dt), damp(r.y, turn, 14, dt), damp(r.z, roll, 10, dt));

    if (!mech) this.updateArm(dt, a, mode === 'arm', reloading, changing);
    this.updatePod(dt, a, shoulder, up, k, reloading, calm);

    this.flashT = Math.max(0, this.flashT - dt * 18);
    this.flash.visible = this.flashT > 0;
    this.flashLight.intensity = this.flashT * 1.6;
    if (this.flashT > 0) {
      this.muzzle.getWorldPosition(this.flash.position);
      this.flashLight.position.copy(this.flash.position);
      this.flash.scale.set(0.7 + Math.random() * 0.7, 0.7 + Math.random() * 0.7, 1.4 + Math.random());
      if (mode === 'pod') this.flash.scale.multiplyScalar(1.8);
      this.flash.rotation.z = Math.random() * 6.28;
      (this.flash.material as THREE.MeshBasicMaterial).opacity = this.flashT;
    }

    for (const c of this.casings) this.fall(c, dt);
    const spent = this.spentCell;
    if (spent.life > 0) {
      this.fall(spent, dt);
      this.spentMat.emissiveIntensity = 2 * clamp(spent.life / 0.7, 0, 1);
    }
    for (const puff of this.puffs) {
      if (puff.life <= 0) continue;
      puff.life -= dt;
      puff.mesh.position.addScaledVector(puff.vel, dt);
      const age = 1 - puff.life / puff.span;
      puff.mesh.scale.setScalar(0.8 + age * 2.6);
      puff.mat.opacity = 0.34 * (1 - age);
      if (puff.life <= 0) puff.mesh.visible = false;
    }
  }

  /** The barrels, the collar, the heat it shows and the coolant cell. */
  private updateArm(dt: number, a: Actor, active: boolean, reloading: number, changing: number): void {
    const def = WEAPONS[a.loadout[a.weapon]];
    // One barrel draws in over the first half of the change, the next comes out over the second.
    for (const id in this.barrels) {
      const b = this.barrels[id];
      const out = active && id === this.barrelId && changing <= 0.5;
      b.ext = damp(b.ext, out ? 1 : 0, 6.5 / Math.max(0.2, def.equipTime), dt);
      b.group.visible = b.ext > 0.03;
      b.group.scale.z = Math.max(0.03, b.ext);
    }
    const current = this.barrels[this.barrelId];
    this.armMuzzle.position.set(0, BARREL_Y, -0.2 - (current ? current.length * current.ext : 0));
    this.collar.rotation.z = changing * Math.PI * 0.5 + (reloading >= CELL_IN ? (1 - smooth(clamp((reloading - CELL_IN) / 0.1, 0, 1))) * 0.35 : 0);

    // Heat: every shot fills the cell, so the rounds left are how much it can still take.
    const filled = active ? 1 - a.ammo[a.weapon] / def.magSize : 0;
    const cooled = reloading < 0 ? 1 : clamp(1 - (reloading - CELL_OUT) / (VENT_END - CELL_OUT), 0, 1);
    this.heat = damp(this.heat, filled * cooled, 10, dt);
    this.pulse = Math.max(0, this.pulse - dt * 9);
    const h = this.heat;
    if (h < 0.5) this.heatMat.emissive.copy(COOL).lerp(WARM, h * 2);
    else this.heatMat.emissive.copy(WARM).lerp(HOT, h * 2 - 1);
    // A full cell flickers, so "about to vent" reads without looking at the count.
    const flicker = h > 0.85 ? 0.5 * Math.sin(this.idle * 26) : 0;
    this.heatMat.emissiveIntensity = 0.7 + 1.5 * h + 0.7 * this.pulse + flicker;

    // The cell: thrown out hot, the port stands open while the housing vents, a fresh one slides in.
    const cell = this.cell;
    if (reloading < 0 || !active) {
      this.cellOut = false;
      cell.visible = true;
      cell.position.copy(CELL_SEAT);
      return;
    }
    if (reloading < CELL_OUT) {
      // It rises out of its port first.
      cell.visible = true;
      cell.position.copy(CELL_SEAT);
      cell.position.y += 0.03 * smooth(reloading / CELL_OUT);
      return;
    }
    if (!this.cellOut) {
      this.cellOut = true;
      const spent = this.spentCell;
      cell.getWorldPosition(spent.mesh.position);
      spent.vel.set(-0.55 - Math.random() * 0.2, 1.25 + Math.random() * 0.2, 0.1);
      spent.spin.set(7 + Math.random() * 5, 3, 9 + Math.random() * 5);
      spent.life = 0.9;
      spent.mesh.visible = true;
      this.spentMat.emissive.copy(this.heatMat.emissive);
      this.steam(5);
    }
    if (reloading < VENT_END) {
      cell.visible = false;
      // Steam thins out as the housing cools.
      this.steamT += dt * (1.2 - (reloading - CELL_OUT) / (VENT_END - CELL_OUT));
      if (this.steamT > 0.05) {
        this.steamT = 0;
        this.steam(1);
      }
      return;
    }
    const seat = smooth(clamp((reloading - VENT_END) / (CELL_IN - VENT_END), 0, 1));
    cell.visible = true;
    cell.position.set(CELL_SEAT.x, CELL_SEAT.y + 0.02 * (1 - seat), CELL_SEAT.z + 0.2 * (1 - seat));
  }

  /** The shoulder pod: up beside the head when it is the weapon, folded away otherwise. */
  private updatePod(dt: number, a: Actor, active: boolean, up: number, aim: number, reloading: number, calm: number): void {
    const pod = this.pod;
    pod.visible = up > 0.02;
    if (!pod.visible) return;
    const p = pod.position;
    p.copy(POD_AWAY).lerp(tmp.copy(POD_UP).lerp(POD_AIM, aim), up);
    p.x += this.swayX * 0.6;
    p.y += this.swayY * 0.6 + Math.sin(this.idle * 1.7 + 1) * 0.002 * calm;
    let tip = 1.0 * (1 - up) - this.swayY;
    let roll = -0.5 * (1 - up);
    if (active) {
      p.z += this.back.x;
      tip += this.climb.x * 0.6;
    }
    let loaded = active ? a.ammo[a.weapon] : 2;
    if (active && reloading >= 0) {
      // It tips back to take two new rockets from the suit, one tube at a time.
      const lift = smooth(clamp(reloading / 0.15, 0, 1)) * smooth(clamp((1 - reloading) / 0.12, 0, 1));
      tip += 0.42 * lift;
      p.y += 0.03 * lift;
      roll += 0.12 * lift;
      loaded = (reloading > 0.45 ? 1 : 0) + (reloading > 0.8 ? 1 : 0);
    }
    // Turned a little toward the middle of the view, so its side and its lights show.
    pod.rotation.set(tip, this.swayX * 1.4 + 0.16, roll);
    // A lit tube holds a rocket. The next to fire is the one `fire` will use.
    for (let i = 0; i < 2; i++) {
      const full = loaded >= 2 || (loaded === 1 && i === this.tube);
      this.tubeMats[i].emissiveIntensity = damp(this.tubeMats[i].emissiveIntensity, full ? 1.5 : 0.04, 14, dt);
    }
  }

  private fall(c: Debris, dt: number): void {
    if (c.life <= 0) return;
    c.life -= dt;
    c.vel.y -= 7 * dt;
    c.mesh.position.addScaledVector(c.vel, dt);
    c.mesh.rotation.x += c.spin.x * dt;
    c.mesh.rotation.y += c.spin.y * dt;
    c.mesh.rotation.z += c.spin.z * dt;
    if (c.life <= 0) c.mesh.visible = false;
  }
}
