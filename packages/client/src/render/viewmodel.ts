import * as THREE from 'three';
import { COMBAT, MECH, WEAPONS, clamp, lenH, type Actor, type Mech } from '@dropline/shared';
import { spring, stepSpring } from '../util/spring';

const REST = new THREE.Vector3(0.2, -0.19, -0.52);

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

interface Model {
  group: THREE.Group;
  /** Muzzle and ejection port, in the model's own space. */
  muzzle: THREE.Object3D;
  port: THREE.Object3D;
  /** Where the weapon sits when aimed: sights on the screen center. */
  aim: THREE.Vector3;
  /** Where it sits at the hip. */
  rest: THREE.Vector3;
  /** Kick per shot: backwards (meters) and muzzle climb (radians). */
  kickBack: number;
  kickUp: number;
  /** Throws a spent casing with each shot. */
  casing: boolean;
}

interface Casing {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

/**
 * First-person weapons and the mech's cockpit (box stand-ins). Drawn in their own scene after the
 * world with the depth buffer cleared, so they never poke through walls and
 * keep their own field of view while the world camera zooms.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  private readonly rig = new THREE.Group();
  private readonly models: Record<string, Model> = {};
  private current: Model | null = null;
  private currentId = '';
  private readonly flash: THREE.Mesh;
  private readonly flashLight = new THREE.PointLight('#ffc27a', 0, 3, 2);
  private readonly casings: Casing[] = [];
  private nextCasing = 0;
  private bob = 0;
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
    const metal = new THREE.MeshStandardMaterial({ color: '#565f6d', roughness: 0.5, metalness: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: '#2b3038', roughness: 0.7, metalness: 0.15 });
    const glow = new THREE.MeshStandardMaterial({ color: '#30140a', emissive: '#ff7a2f', emissiveIntensity: 1.3 });
    const lens = new THREE.MeshStandardMaterial({ color: '#06121a', emissive: '#58d6ff', emissiveIntensity: 0.35 });
    const glove = new THREE.MeshStandardMaterial({ color: '#3a3f47', roughness: 0.9 });
    const sleeve = new THREE.MeshStandardMaterial({ color: '#2c323b', roughness: 0.7, metalness: 0.2 });

    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, 0);
      return mesh;
    };
    /** Both hands, each with a forearm that runs back out of view toward the shoulder. */
    const arms = (gripZ: number, foreZ: number): THREE.Mesh[] => [
      box(0.08, 0.08, 0.2, glove, 0, -0.15, gripZ, 0, 0),
      box(0.07, 0.07, 0.36, sleeve, 0.035, -0.25, gripZ + 0.25, 0.5, 0.15),
      box(0.08, 0.07, 0.12, glove, -0.02, -0.08, foreZ, 0, 0),
      box(0.07, 0.07, 0.44, sleeve, -0.12, -0.19, foreZ + 0.2, 0.45, -0.55),
    ];
    const model = (
      id: string,
      parts: THREE.Mesh[],
      muzzleZ: number,
      aimY: number,
      kickBack: number,
      kickUp: number,
      casing = true,
      rest: THREE.Vector3 | null = null,
    ): void => {
      const group = new THREE.Group();
      group.add(...parts);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.02, muzzleZ);
      const port = new THREE.Object3D();
      port.position.set(0.04, 0.05, -0.04);
      group.add(muzzle, port);
      group.scale.setScalar(0.8);
      group.visible = false;
      this.rig.add(group);
      // A weapon with its own resting place (the mech's arm) is not brought to the eye.
      const aim = rest ? rest.clone() : new THREE.Vector3(0, aimY, -0.4);
      this.models[id] = { group, muzzle, port, aim, rest: rest ?? REST, kickBack, kickUp, casing };
    };

    model(
      'carbine',
      [
        box(0.07, 0.11, 0.44, metal, 0, 0, 0),
        box(0.04, 0.04, 0.26, dark, 0, 0.02, -0.33),
        box(0.05, 0.035, 0.2, dark, 0, 0.075, -0.02),
        box(0.012, 0.03, 0.02, glow, 0, 0.105, -0.1),
        box(0.055, 0.16, 0.08, dark, 0, -0.13, -0.02),
        box(0.05, 0.13, 0.07, dark, 0, -0.1, 0.15),
        box(0.074, 0.008, 0.22, glow, 0, 0.03, -0.04),
        ...arms(0.2, -0.2),
      ],
      -0.47,
      -0.094,
      0.035,
      0.05,
    );
    model(
      'scattergun',
      [
        box(0.085, 0.1, 0.36, metal, 0, 0, 0.02),
        box(0.06, 0.06, 0.42, dark, 0, 0.02, -0.36),
        box(0.075, 0.055, 0.2, glove, 0, -0.04, -0.3),
        box(0.02, 0.02, 0.02, glow, 0, 0.065, -0.5),
        box(0.055, 0.13, 0.07, dark, 0, -0.1, 0.16),
        box(0.07, 0.09, 0.16, dark, 0, -0.01, 0.28),
        box(0.088, 0.008, 0.18, glow, 0, 0.035, 0.02),
        ...arms(0.2, -0.3),
      ],
      -0.58,
      -0.06,
      0.085,
      0.16,
    );
    model(
      'longshot',
      [
        box(0.06, 0.1, 0.5, metal, 0, 0, 0),
        box(0.03, 0.03, 0.5, dark, 0, 0.02, -0.48),
        box(0.045, 0.045, 0.07, dark, 0, 0.02, -0.74),
        box(0.055, 0.055, 0.24, dark, 0, 0.095, 0),
        box(0.045, 0.045, 0.012, lens, 0, 0.095, 0.122),
        box(0.02, 0.03, 0.05, dark, 0, 0.06, 0.06),
        box(0.02, 0.03, 0.05, dark, 0, 0.06, -0.07),
        box(0.05, 0.14, 0.07, dark, 0, -0.11, 0.14),
        box(0.06, 0.09, 0.22, dark, 0, -0.01, 0.34),
        box(0.064, 0.008, 0.3, glow, 0, 0.03, -0.04),
        ...arms(0.2, -0.24),
      ],
      -0.78,
      -0.094,
      0.07,
      0.11,
    );

    // The launcher rides on the shoulder: a fat tube with a blast cone behind.
    model(
      'pike',
      [
        box(0.1, 0.1, 0.78, dark, 0, 0.02, -0.05),
        box(0.135, 0.135, 0.14, metal, 0, 0.02, -0.46),
        box(0.12, 0.12, 0.1, metal, 0, 0.02, 0.37),
        box(0.03, 0.02, 0.3, dark, 0, 0.08, -0.1),
        box(0.014, 0.05, 0.02, glow, 0, 0.105, -0.22),
        box(0.104, 0.022, 0.1, glow, 0, 0.02, -0.3),
        box(0.05, 0.13, 0.07, dark, 0, -0.1, 0.02),
        ...arms(0.1, -0.25),
      ],
      -0.56,
      -0.105,
      0.11,
      0.2,
      false,
    );
    // The mech's cannon: its right arm, seen from the cockpit.
    model(
      'autocannon',
      [
        box(0.22, 0.22, 0.62, dark, 0, 0, 0.12),
        box(0.02, 0.012, 0.14, glow, 0, 0.078, -0.3),
        box(0.075, 0.075, 0.72, metal, 0, 0.035, -0.52),
        box(0.05, 0.05, 0.56, dark, 0, -0.06, -0.44),
        box(0.11, 0.11, 0.09, dark, 0, 0.035, -0.9),
        box(0.17, 0.17, 0.8, sleeve, 0.1, -0.12, 0.7, 0.2, -0.25),
      ],
      -0.96,
      0,
      0.05,
      0.018,
      true,
      new THREE.Vector3(0.5, -0.37, -0.8),
    );

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
    this.rig.add(this.flash, this.flashLight);

    const brass = new THREE.MeshStandardMaterial({ color: '#c9a04a', roughness: 0.35, metalness: 0.8 });
    const casingGeo = new THREE.BoxGeometry(0.006, 0.006, 0.016);
    for (let i = 0; i < 10; i++) {
      const mesh = new THREE.Mesh(casingGeo, brass);
      mesh.visible = false;
      this.scene.add(mesh);
      this.casings.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 });
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

  /** Kick, flash and a spent casing for one shot. */
  fire(): void {
    const m = this.current;
    if (!m) return;
    this.back.v += m.kickBack * 60;
    this.climb.v += m.kickUp * 60;
    this.flashT = 1;
    if (!m.casing) return;
    const c = this.casings[this.nextCasing++ % this.casings.length];
    m.port.getWorldPosition(c.mesh.position);
    c.vel.set(0.9 + Math.random() * 0.5, 0.9 + Math.random() * 0.5, 0.15 - Math.random() * 0.3);
    c.spin.set(Math.random() * 30, Math.random() * 30, Math.random() * 30);
    c.life = 0.55;
    c.mesh.visible = true;
  }

  /**
   * Where the muzzle appears in the world as seen through `worldCamera`, so
   * tracers leave the barrel even though the weapon is drawn with another lens.
   */
  muzzleWorld(worldCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    if (!this.current) return worldCamera.getWorldPosition(out);
    this.current.muzzle.getWorldPosition(out);
    const depth = out.length();
    out.project(this.camera).unproject(worldCamera);
    const eye = worldCamera.position;
    out.sub(eye).normalize().multiplyScalar(depth).add(eye);
    return out;
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
    if (id !== this.currentId) {
      if (this.current) this.current.group.visible = false;
      this.current = this.models[id] ?? this.models.carbine;
      this.current.group.visible = true;
      this.currentId = id;
    }
    const model = this.current!;
    const def = WEAPONS[id];

    const speed = lenH(s.vel);
    const calm = 1 - 0.85 * a.ads;
    const moving = (s.grounded && !s.sliding ? Math.min(1, speed / (mech ? 4 : 8)) : 0) * calm;
    // A mech's slow, heavy step, in time with its stride.
    this.bob = mech ? (mech.stride / MECH.move.strideLength) * Math.PI : this.bob + speed * dt * 1.35;

    // The weapon trails behind fast mouse turns and settles back.
    this.swayX = damp(this.swayX, clamp(-mouseDx * 0.0018, -0.07, 0.07) * calm, 10, dt);
    this.swayY = damp(this.swayY, clamp(mouseDy * 0.0018, -0.07, 0.07) * calm, 10, dt);

    // Recoil on springs: snaps back and up, then returns.
    stepSpring(this.back, 420, 30, dt);
    stepSpring(this.climb, 380, 26, dt);

    const k = a.ads * a.ads * (3 - 2 * a.ads);
    const rest = model.rest;
    let x = rest.x + (model.aim.x - rest.x) * k + Math.sin(this.bob) * 0.012 * moving + this.swayX;
    let y = rest.y + (model.aim.y - rest.y) * k - Math.abs(Math.cos(this.bob)) * 0.014 * moving + this.swayY;
    const z = rest.z + (model.aim.z - rest.z) * k + this.back.x;
    if (mech) y += clamp(this.rattle.x, -0.05, 0.03) - 0.35 * (1 - this.seated);
    let roll = 0;
    const turn = this.swayX * 2;
    let tip = -this.swayY * 2 + this.climb.x;

    if (!s.grounded && !s.wallrun.active) y += clamp(-s.vel.y * 0.004, -0.04, 0.05) * calm;
    if (s.wallrun.active) roll = s.wallrun.side * 0.3 * calm;
    if (s.sliding) {
      roll = 0.4 * calm;
      y -= 0.03 * calm;
      x -= 0.05 * calm;
    }
    if (s.mantle.active) {
      y -= 0.22;
      tip -= 0.5;
    }
    // Reload: the weapon dips and rolls toward the off hand, then comes back up.
    if (a.reload > 0) {
      const dip = Math.sin(Math.PI * clamp(1 - a.reload / def.reloadTime, 0, 1));
      // A mech's arm only lowers while its loader cycles; a pilot rolls the weapon to the off hand.
      y -= (mech ? 0.2 : 0.13) * dip;
      roll += (mech ? 0.12 : 0.75) * dip;
      tip += (mech ? -0.25 : 0.35) * dip;
    }
    // Draw: rises into view from below.
    if (a.equip > 0) {
      const e = a.equip / def.equipTime;
      y -= 0.32 * e * e;
      tip -= 0.9 * e;
    }

    const p = this.rig.position;
    p.set(damp(p.x, x, 22, dt), damp(p.y, y, 22, dt), z);
    const r = this.rig.rotation;
    r.set(damp(r.x, tip, 18, dt), damp(r.y, turn, 14, dt), damp(r.z, roll, 10, dt));

    this.flashT = Math.max(0, this.flashT - dt * 18);
    this.flash.visible = this.flashT > 0;
    this.flashLight.intensity = this.flashT * 1.6;
    if (this.flashT > 0) {
      this.flash.position.copy(model.muzzle.position).multiplyScalar(0.8);
      this.flashLight.position.copy(this.flash.position);
      this.flash.scale.set(0.7 + Math.random() * 0.7, 0.7 + Math.random() * 0.7, 1.4 + Math.random());
      this.flash.rotation.z = Math.random() * 6.28;
      (this.flash.material as THREE.MeshBasicMaterial).opacity = this.flashT;
    }

    for (const c of this.casings) {
      if (c.life <= 0) continue;
      c.life -= dt;
      c.vel.y -= 7 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      if (c.life <= 0) c.mesh.visible = false;
    }
  }
}
