import * as THREE from 'three';
import { COMBAT, WEAPONS, clamp, frameOf, lenH, type Actor, type Mech } from '@dropline/shared';
import { spring, stepSpring } from '../util/spring';
import { ArmGun, GUN_FINISH } from './armGun';
import { Cockpit } from './mech/cockpit';
import { block, rod } from './pilot/rig';

/** Where the suit's arm sits at the hip, raised to aim, and lowered while the shoulder pod is in use. */
const ARM_REST = new THREE.Vector3(0.2, -0.2, -0.56);
const ARM_AIM = new THREE.Vector3(0.1, -0.14, -0.52);
const ARM_STOWED = new THREE.Vector3(0.3, -0.43, -0.46);
/** Height of the firing barrel's axis on the arm: along the top of the housing, where the player can see it. */
const BARREL_Y = 0.05;
/** Where the barrel's collar sits, against the hinge plate at the front of the housing. */
const GUN_Z = -0.183;
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

/**
 * The arm's finish per team. The weapon is the same gear on both (the machines
 * were built to use it) in the team's gun finish (GUN_FINISH, shared with the
 * pilots seen in third person); the Corps wear it over an olive sleeve and a
 * glove, Z.E.R.O on a black frame. No lights: heat shows as the metal itself
 * does, dark when cold, a dull red as it warms and orange at its hottest.
 */
const HEAT = { cool: '#000000', warm: '#6e1a06', hot: '#ff6a14' };
/** The mech shield's light, in the team's colour: Corps blue, Z.E.R.O crimson. */
const SHIELD_LIGHT = ['#58d6ff', '#ff2236'];
const ARM_LOOK = [
  { ...GUN_FINISH[0], sleeve: '#4a5034', glove: '#3a4029' },
  { ...GUN_FINISH[1], sleeve: '#33373e', glove: '#24272d' },
];
const HALF_PI = Math.PI / 2;

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));
const smooth = (t: number): number => t * t * (3 - 2 * t);

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
 * What the player sees of their own body: on foot the suit's right arm with its
 * built-in weapon and the launcher pod on the shoulder, in a mech the cannon arm
 * and the cockpit. The arm and pod wear the player's team finish (`setTeam`).
 *
 * The arm is a heavy housing with one barrel (render/armGun), which its ammo
 * printer reshapes for each weapon: switching draws the barrel in, prints the
 * next one and runs it out. There is no magazine: an ammo printer behind a side window makes
 * the rounds, the heat they leave shows on the heat sinks under the cooling
 * fins, and a reload throws out the spent coolant cell, opens the fins to vent
 * the housing and seats a fresh cell.
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
  /** The barrel; it slides back on its pistons when it fires. The same model pilots carry in third person. */
  private readonly gun: ArmGun;
  private recoil = 0;

  /** The ammo printer's coils, seen through the window on the side facing the player. */
  private readonly coils = new THREE.Group();
  private coilSpin = 0;
  /** The cooling fins over the heat sinks; they open while the housing vents. */
  private readonly fins: THREE.Object3D[] = [];
  private readonly pistonRods: THREE.Object3D[] = [];
  /** Each team's hand: a gloved fist or a machine's bare fingers. */
  private readonly hands: THREE.Group[] = [];
  private readonly sleevePiston = new THREE.Group();
  private readonly look = {
    plate: new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.4, flatShading: true }),
    gun: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.6, flatShading: true }),
    dark: new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.5, flatShading: true }),
    sleeve: new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.1, flatShading: true }),
    glove: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.05, flatShading: true }),
    steel: new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.85, flatShading: true }),
  };
  private readonly cool = new THREE.Color();
  private readonly warm = new THREE.Color();
  private readonly hot = new THREE.Color();
  private team = -1;
  private readonly cell = new THREE.Group();
  /** Where steam leaves the housing. */
  private readonly vents = new THREE.Object3D();
  /** One material for everything on the arm that shows heat: the strip, the slats and the cell. */
  private readonly heatMat: THREE.MeshStandardMaterial;
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

  /** Holds the cockpit's cannon arm on the rig, so it sways and recoils with the view. */
  private readonly cannon = new THREE.Group();
  /** The shield wall in front of the cockpit glass, and how brightly a hit lights it. */
  private readonly shield: THREE.Mesh;
  private readonly shieldMat: THREE.MeshBasicMaterial;
  private shieldFlash = 0;

  /** The muzzle the current weapon fires from. */
  private muzzle: THREE.Object3D;
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
  /** The mech's cockpit, one per frame and side, built when first sat in; the one in use or last used. */
  private readonly cockpits = new Map<string, Cockpit>();
  private cockpit: Cockpit | null = null;
  private aspect = 1;
  private readonly rattle = spring();
  private seated = 0;

  constructor() {
    this.heatMat = new THREE.MeshStandardMaterial({ color: '#1c1e20', roughness: 0.6, metalness: 0.6, emissiveIntensity: 0.8 });

    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, 0);
      return mesh;
    };

    // --- The suit's right arm. Its origin is the wrist; the forearm runs back and
    // down out of view toward the elbow, so it reads as the player's own arm.
    const L = this.look;
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      return mesh;
    };
    /** A cylinder lying along the arm (Z). */
    const tube = (r: number, len: number, mat: THREE.Material, x: number, y: number, z: number, sides = 10): THREE.Mesh =>
      part(rod(r, len, sides), mat, x, y, z, HALF_PI);

    // The sleeve: the suit's forearm, an armoured bracer over it.
    this.arm.add(
      part(block(0.09, 0.088, 0.62, 0.02), L.sleeve, 0.045, -0.085, 0.37, 0.17, 0.12),
      part(block(0.112, 0.04, 0.34, 0.012), L.plate, 0.04, -0.035, 0.3, 0.17, 0.12),
      part(block(0.05, 0.012, 0.2, 0.004), L.dark, 0.04, -0.012, 0.27, 0.17, 0.12),
    );
    // A machine's forearm shows its piston.
    this.sleevePiston.add(
      part(rod(0.011, 0.3, 8), L.steel, -0.02, -0.12, 0.34, HALF_PI + 0.17),
      part(rod(0.018, 0.12, 8), L.dark, -0.02, -0.11, 0.24, HALF_PI + 0.17),
    );
    this.sleevePiston.rotation.y = 0.12;
    this.arm.add(this.sleevePiston);

    // The housing round the wrist: a heavy block with armour on its outer side.
    this.arm.add(
      part(block(0.13, 0.11, 0.32, 0.014), L.gun, 0, 0, -0.01),
      part(block(0.02, 0.092, 0.27, 0.006), L.plate, 0.072, 0.004, -0.005),
      part(block(0.02, 0.092, 0.13, 0.006), L.plate, -0.072, 0.004, 0.085),
      part(block(0.02, 0.012, 0.12, 0.003), L.steel, 0.083, 0.03, -0.02),
      // Hinge plate and knuckles where the drum is carried.
      part(block(0.13, 0.11, 0.022, 0.006), L.dark, 0, 0, -0.172),
      part(rod(0.013, 0.03, 8), L.steel, 0.05, -0.05, -0.172, 0, 0, HALF_PI),
      part(rod(0.013, 0.03, 8), L.steel, -0.05, -0.05, -0.172, 0, 0, HALF_PI),
    );

    // The ammo printer, behind a window on the side the player sees: a lit core
    // that fabricates rounds, with feed coils turning round it.
    this.arm.add(
      part(block(0.024, 0.014, 0.18, 0.004), L.dark, -0.07, 0.045, -0.075),
      part(block(0.024, 0.014, 0.18, 0.004), L.dark, -0.07, -0.037, -0.075),
      part(block(0.024, 0.09, 0.012, 0.003), L.dark, -0.07, 0.004, -0.163),
      part(block(0.006, 0.05, 0.15, 0.002), this.heatMat, -0.05, 0.004, -0.075),
    );
    this.coils.position.set(-0.06, 0.004, -0.075);
    const coilMat = new THREE.MeshStandardMaterial({ color: '#b5814a', roughness: 0.3, metalness: 0.9, flatShading: true });
    this.coils.add(tube(0.006, 0.16, L.steel, 0, 0, 0, 6));
    for (const z of [-0.06, -0.025, 0.01, 0.045]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.0045, 5, 10), coilMat);
      ring.position.z = z;
      this.coils.add(ring);
    }
    this.coils.add(part(block(0.004, 0.03, 0.12, 0.001), L.steel, 0, 0.02, -0.005));
    this.arm.add(this.coils);

    // The cooling chamber on top: heat-sink pads under a row of fins in a cage.
    this.arm.add(
      part(block(0.1, 0.01, 0.15, 0.003), L.dark, 0, 0.06, -0.095),
      part(block(0.008, 0.036, 0.15, 0.002), L.gun, 0.05, 0.076, -0.095),
      part(block(0.008, 0.036, 0.15, 0.002), L.gun, -0.05, 0.076, -0.095),
    );
    for (const z of [-0.14, -0.1, -0.06]) this.arm.add(part(block(0.074, 0.006, 0.028, 0.002), this.heatMat, 0, 0.068, z));
    for (const z of [-0.16, -0.12, -0.08, -0.04]) {
      const fin = new THREE.Group();
      fin.position.set(0, 0.07, z);
      fin.add(part(block(0.088, 0.03, 0.006, 0.002), L.plate, 0, 0.016, 0));
      this.fins.push(fin);
      this.arm.add(fin);
    }
    this.vents.position.set(0, 0.1, -0.1);
    // The coolant cell sits in a port behind the chamber, toward the player.
    // A canister with a window that shows the heat inside.
    this.arm.add(part(block(0.064, 0.012, 0.15, 0.003), L.dark, -0.03, 0.062, 0.05));
    this.cell.position.copy(CELL_SEAT);
    this.cell.add(part(block(0.046, 0.04, 0.13, 0.008), L.plate, 0, 0, 0), part(block(0.02, 0.006, 0.1, 0.002), this.heatMat, 0, 0.021, 0));
    this.arm.add(this.vents, this.cell);

    // The fist under the drum: the Corps' gloved hand, or a machine's bare fingers.
    const glove = new THREE.Group();
    glove.add(
      part(block(0.085, 0.075, 0.11, 0.015), L.glove, -0.005, -0.08, -0.15),
      part(block(0.092, 0.03, 0.06, 0.008), L.plate, -0.005, -0.058, -0.19),
    );
    const claw = new THREE.Group();
    claw.add(part(block(0.08, 0.05, 0.08, 0.01), L.plate, -0.005, -0.07, -0.13));
    for (const x of [-0.035, -0.012, 0.011, 0.034]) claw.add(part(block(0.016, 0.06, 0.022, 0.004), L.steel, x, -0.1, -0.18, 0.5));
    this.hands.push(glove, claw);
    this.arm.add(glove, claw);

    // Recoil pistons along the underside, from the housing to the drum.
    for (const x of [-0.045, 0.045]) {
      this.arm.add(tube(0.011, 0.08, L.dark, x, -0.06, -0.12, 8));
      const rodPart = tube(0.0065, 0.07, L.steel, x, -0.06, -0.175, 6);
      this.pistonRods.push(rodPart);
      this.arm.add(rodPart);
    }

    // The barrel, on its collar at the front of the housing, along the top.
    this.gun = new ArmGun({ gun: L.gun, plate: L.plate, dark: L.dark, steel: L.steel });
    this.gun.root.position.set(0, BARREL_Y, GUN_Z);
    this.arm.add(this.gun.root);
    this.muzzle = this.gun.muzzle;
    this.arm.scale.setScalar(0.78);
    this.arm.visible = false;
    this.rig.add(this.arm);

    // --- The launcher pod on the right shoulder: two round tubes clamped
    // together, on an arm that leads back and down to the shoulder it is hinged on.
    this.pod.add(
      tube(0.042, 0.4, L.gun, -0.048, 0, 0, 8),
      tube(0.042, 0.4, L.gun, 0.048, 0, 0, 8),
      tube(0.05, 0.05, L.dark, -0.048, 0, -0.185, 8),
      tube(0.05, 0.05, L.dark, 0.048, 0, -0.185, 8),
      box(0.065, 0.045, 0.3, L.plate, 0, 0.042, 0.02),
      box(0.2, 0.1, 0.05, L.dark, 0, 0, 0.08),
      box(0.06, 0.06, 0.56, L.sleeve, 0.09, -0.19, 0.36, 0.55, 0.22),
    );
    [-0.048, 0.048].forEach((x, i) => {
      const mat = new THREE.MeshStandardMaterial({ color: '#1a0d06', emissive: '#ffb347', emissiveIntensity: 1.4 });
      const muzzle = new THREE.Object3D();
      muzzle.position.set(x, 0, -0.23);
      // Each tube's mouth glows while it holds a rocket, and so does its light on
      // the side of the pod that faces the player, who sees the pod from behind.
      this.pod.add(tube(0.03, 0.01, mat, x, 0, -0.212, 8), box(0.012, 0.04, 0.09, mat, -0.097, 0, 0.06 - i * 0.13), muzzle);
      this.tubeMats.push(mat);
      this.podMuzzles.push(muzzle);
    });
    this.pod.scale.setScalar(0.54);
    this.pod.visible = false;
    this.scene.add(this.pod);

    // --- The mech's cannon arm comes with the cockpit (render/mech/cockpit.ts).
    this.cannon.visible = false;
    this.rig.add(this.cannon);

    // The shield, seen through the glass: a wall of light across the view.
    this.shieldMat = new THREE.MeshBasicMaterial({ color: '#58d6ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.shield = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.2, 1, 1), this.shieldMat);
    this.shield.position.set(0, 0.05, -1.4);
    // Its edge, so the pilot sees where cover ends.
    this.shield.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(3.3, 2.1)), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35 })));
    this.shield.visible = false;
    this.scene.add(this.shield);

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
    this.spentMat = new THREE.MeshStandardMaterial({ color: '#1a0d06', emissiveIntensity: 2 });
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
    this.setTeam(0);
  }

  /** Wear the team's finish: the Corps' olive sleeve and blue lights, or Z.E.R.O's black frame and crimson ones. */
  setTeam(team: number): void {
    const t = team === 1 ? 1 : 0;
    if (t === this.team) return;
    this.team = t;
    const look = ARM_LOOK[t];
    const L = this.look;
    L.plate.color.set(look.plate);
    L.gun.color.set(look.gun);
    L.dark.color.set(look.dark);
    L.sleeve.color.set(look.sleeve);
    L.glove.color.set(look.glove);
    L.steel.color.set(look.steel);
    this.cool.set(HEAT.cool);
    this.warm.set(HEAT.warm);
    this.hot.set(HEAT.hot);
    this.shieldMat.color.set(SHIELD_LIGHT[t]);
    this.heatMat.emissive.copy(this.cool);
    this.spentMat.emissive.copy(this.hot);
    this.hands[0].visible = t === 0;
    this.hands[1].visible = t === 1;
    this.sleevePiston.visible = t === 1;
  }

  resize(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.cockpit?.resize(this.camera.fov, aspect);
  }

  /** Sit in this mech's cockpit: its frame's, in its side's finish. */
  private useCockpit(mech: Mech): void {
    const frame = frameOf(mech);
    const key = `${frame.id}:${mech.team}`;
    let next = this.cockpits.get(key);
    if (!next) {
      next = new Cockpit(frame, mech.team);
      this.cockpits.set(key, next);
    }
    if (next === this.cockpit) return;
    if (this.cockpit) {
      this.scene.remove(this.cockpit.root);
      this.cannon.remove(this.cockpit.cannon);
    }
    this.cockpit = next;
    this.scene.add(next.root);
    this.cannon.add(next.cannon);
    next.resize(this.camera.fov, this.aspect);
  }

  /** Shake the cockpit: a footfall, a hit on the hull. */
  thud(amount: number): void {
    this.rattle.v -= amount;
  }

  /** Fire stopped by the player's own shield lights it up. */
  shieldHit(): void {
    this.shieldFlash = 1;
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
      this.recoil = 1;
      this.gun.fire();
      if (this.heat > 0.55) this.steam(1);
      return;
    }
    const cockpit = this.cockpit;
    if (!cockpit) return;
    cockpit.fire();
    if (!cockpit.kick.casing) return;
    const c = this.casings[this.nextCasing++ % this.casings.length];
    cockpit.port.getWorldPosition(c.mesh.position);
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
      p.vel.set(-0.06 - Math.random() * 0.1, 0.16 + Math.random() * 0.16, (Math.random() - 0.5) * 0.08);
      p.span = p.life = 0.4 + Math.random() * 0.3;
      p.mesh.visible = true;
    }
  }

  /** `mech` is the machine the pilot sits in, or null on foot. */
  update(dt: number, a: Actor, mouseDx: number, mouseDy: number, mech: Mech | null): void {
    const s = a.p;

    // The cockpit rises around the pilot as they sit down, and lights up as it starts.
    if (mech) this.useCockpit(mech);
    this.seated = damp(this.seated, mech ? 1 : 0, 10, dt);
    stepSpring(this.rattle, 150, 13, dt);
    if (this.cockpit) {
      this.cockpit.root.visible = this.seated > 0.02;
      this.cockpit.update(dt, mech, this.seated, this.rattle.x, this.swayX, this.swayY);
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
    // The shield shimmers while it is up, brighter for a moment where it is hit, and fades as it wears down.
    const A = mech ? frameOf(mech).ability : null;
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 5);
    this.shield.visible = mech !== null && mech.shieldUp && A?.kind === 'shield';
    if (this.shield.visible && A?.kind === 'shield') {
      const left = mech!.shield / A.health;
      this.shieldMat.opacity = 0.1 + 0.12 * left + 0.03 * Math.sin(performance.now() * 0.009) + 0.3 * this.shieldFlash;
    }
    if (mode === 'cannon' && this.cockpit) {
      this.muzzle = this.cockpit.muzzle;
      this.kickBack = this.cockpit.kick.back;
      this.kickUp = this.cockpit.kick.up;
    } else if (mode === 'pod') {
      this.kickBack = 0.11;
      this.kickUp = 0.2;
    } else {
      this.muzzle = this.gun.muzzle;
      this.kickBack = this.gun.kickBack;
      this.kickUp = this.gun.kickUp;
    }

    const speed = lenH(s.vel);
    const calm = 1 - 0.85 * a.ads;
    const moving = (s.grounded && !s.sliding ? Math.min(1, speed / (mech ? 4 : 8)) : 0) * calm;
    // A mech's slow, heavy step, in time with its stride.
    this.bob = mech ? (mech.stride / frameOf(mech).move.strideLength) * Math.PI : this.bob + speed * dt * 1.35;
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
    // Changing barrels: a short dip while the printer reshapes it. A mech's cannon rises into view instead.
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

    if (!mech) this.updateArm(dt, a, mode === 'arm', reloading);
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

  /** The barrel, the printer, the heat it shows, the fins and the coolant cell. */
  private updateArm(dt: number, a: Actor, active: boolean, reloading: number): void {
    const def = WEAPONS[a.loadout[a.weapon]];
    // The barrel draws in while the shoulder pod is the weapon.
    this.gun.update(dt, active ? a.loadout[a.weapon] : 'none');
    // A barrel locking in knocks the arm, a short shove back and a dip, and the breech blows off steam.
    if (this.gun.justLocked) {
      this.back.v += 0.7;
      this.climb.v -= 0.6;
      this.steam(3);
    }
    // A shot slides the barrel back on its pistons.
    this.recoil = Math.max(0, this.recoil - dt * 14);
    const slide = 0.016 * this.recoil * this.recoil;
    this.gun.root.position.z = GUN_Z + slide;
    for (const r of this.pistonRods) r.position.z = -0.175 + slide;
    // The printer's coils turn slowly, and fast while it makes rounds: after a
    // shot, through a reload, and fastest while it prints a new barrel.
    this.coilSpin = damp(this.coilSpin, 1.5 + 30 * this.pulse + (reloading >= 0 ? 14 : 0) + 60 * this.gun.printing, 6, dt);
    this.coils.rotation.z += this.coilSpin * dt;

    // Heat: every shot fills the cell, so the rounds left are how much it can still take.
    const filled = active ? 1 - a.ammo[a.weapon] / def.magSize : 0;
    const cooled = reloading < 0 ? 1 : clamp(1 - (reloading - CELL_OUT) / (VENT_END - CELL_OUT), 0, 1);
    this.heat = damp(this.heat, filled * cooled, 10, dt);
    this.pulse = Math.max(0, this.pulse - dt * 9);
    const h = this.heat;
    if (h < 0.5) this.heatMat.emissive.copy(this.cool).lerp(this.warm, h * 2);
    else this.heatMat.emissive.copy(this.warm).lerp(this.hot, h * 2 - 1);
    // The fins over the heat sinks open while the housing vents.
    const venting = reloading >= CELL_OUT && reloading < CELL_IN ? 1 : 0;
    for (let i = 0; i < this.fins.length; i++) {
      const fin = this.fins[i];
      fin.rotation.x = damp(fin.rotation.x, venting * (0.75 - i * 0.08), 12 - i, dt);
    }
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
