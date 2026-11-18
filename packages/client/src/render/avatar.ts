import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { WEAPONS, lenH, type Actor, type Vec3 } from '@dropline/shared';
import { ArmGun, GUN_FINISH } from './armGun';
import { PilotAnimator } from './pilot/animate';
import type { CorpseParts } from './pilot/ragdoll';
import { BONES, buildSkeleton, block, type BoneName, type Skeleton } from './pilot/rig';
import { POD_MUZZLE, suitKit } from './pilot/suits';
import { Wounds } from './pilot/wounds';

/** Per-team look. Allies also carry a chevron overhead, so teams never rest on colour alone. */
export const TEAM_LOOK = [
  { plate: '#2f86c6', visor: '#58d6ff', tracer: '#8fe6ff' },
  { plate: '#d2452c', visor: '#ff2a3c', tracer: '#ffb38a' },
];

const FLAME = new THREE.MeshBasicMaterial({
  color: '#ffb066',
  transparent: true,
  opacity: 0.85,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const MUZZLE = new THREE.MeshBasicMaterial({
  color: '#ffd9a0',
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const FLAME_GEO = new THREE.ConeGeometry(0.07, 0.5, 8);
/**
 * Where the barrel's collar sits on the right forearm (which hangs down its own
 * -Y): at the front of the housing, on the barrel line along its top (-Z). The
 * gun is the first-person model (render/armGun) without its smallest parts,
 * turned to run down the forearm and scaled up a little to read at range.
 */
const GUN_AT = new THREE.Vector3(0, -0.265, -0.075);
const GUN_SCALE = 1.2;

/** Each Corps pilot's own shoulder patch: a unit colour. */
const PATCHES = ['#c9a227', '#b5482f', '#d9d4c5', '#4f8a5b', '#8a5fb0', '#3f7fc0', '#d07a2a', '#9aa63a'];

let noticeTexture: THREE.CanvasTexture | null = null;
let haloTexture: THREE.CanvasTexture | null = null;

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

/** A soft round glow, shared by every suit light's halo. */
function haloMap(): THREE.CanvasTexture {
  if (haloTexture) return haloTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  haloTexture = new THREE.CanvasTexture(c);
  haloTexture.colorSpace = THREE.SRGBColorSpace;
  return haloTexture;
}

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

const tmp = new THREE.Vector3();

/**
 * A pilot: the faction's suit on the shared skeleton (render/pilot), animated
 * from movement state. Team 0 wears the Corps suit, team 1 is a Z.E.R.O frame;
 * both have the same proportions, so they match the same hitbox. The model
 * faces -Z like the camera.
 *
 * The suit carries its weapons: a housing on the right forearm that extends
 * one barrel at a time, and a launcher pod on the right shoulder that swings
 * up while it is the weapon in use.
 */
export class Avatar {
  readonly root = new THREE.Group();
  /** Aiming laser of a marksman; lives in world space, so the game adds it to the scene. */
  readonly laser: THREE.Mesh;
  private readonly body = new THREE.Group();
  private readonly bones: Skeleton;
  private readonly anim: PilotAnimator;
  private readonly wounds: Wounds;
  private readonly skin: THREE.MeshStandardMaterial;
  private readonly lights: THREE.MeshBasicMaterial;
  private readonly halo: THREE.SpriteMaterial;
  private readonly haloOpacity: number;
  /** Z.E.R.O lights breathe; Corps lights hold steady. */
  private readonly pulse: number;
  private readonly gun: ArmGun;
  private readonly gunMat: THREE.MeshStandardMaterial;
  private readonly muzzleFlash: THREE.Mesh;
  private readonly podMuzzle = new THREE.Object3D();
  private readonly vent = new THREE.Object3D();
  private readonly flames: THREE.Mesh[] = [];
  private readonly mark: THREE.Sprite;
  private readonly laserMat: THREE.MeshBasicMaterial;
  private readonly owned: (THREE.Material | THREE.BufferGeometry)[] = [];
  private heading = 0;
  private shot = 0;
  private noticed = 0;
  private dead = -1;
  /** Torn apart: nothing is left to lie there. */
  private gibbed = false;
  /** The body went to a ragdoll, which draws it from here on. */
  private ragdolled = false;
  /** Each bone's world position as of the last update, and how fast it was moving. */
  private readonly boneAt = {} as Record<BoneName, THREE.Vector3>;
  private readonly boneVel = {} as Record<BoneName, THREE.Vector3>;
  private tracked = false;
  private weapon = '';
  private shoulder = false;
  private podUp = 0;
  private glowT = Math.random() * 10;
  private lightLevel = 1;

  constructor(team: number, ally: boolean, variant = 0) {
    const look = TEAM_LOOK[team];
    const kit = suitKit(team);
    const machine = team === 1;
    this.bones = buildSkeleton(this.body);
    for (const b of BONES) {
      this.boneAt[b] = new THREE.Vector3();
      this.boneVel[b] = new THREE.Vector3();
    }
    this.anim = new PilotAnimator(this.bones, this.body);
    // Z.E.R.O plates carry a faint crimson cast, so a black frame never sinks into shadow.
    const emissive = new THREE.Color(machine ? '#3a0408' : '#000000').multiplyScalar(machine ? 0.4 : 0);
    this.skin = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: kit.roughness,
      metalness: kit.metalness,
      emissive,
    });
    this.lights = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.haloOpacity = machine ? 0.85 : 0.5;
    this.halo = new THREE.SpriteMaterial({
      map: haloMap(),
      color: kit.colors.glow,
      transparent: true,
      opacity: this.haloOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.pulse = machine ? 0.22 : 0;
    const finish = GUN_FINISH[machine ? 1 : 0];
    this.gunMat = new THREE.MeshStandardMaterial({ color: finish.gun, roughness: 0.5, metalness: 0.55, flatShading: true });
    this.owned.push(this.skin, this.lights, this.halo, this.gunMat);

    const suitParts: THREE.Mesh[] = [];
    for (const name of Object.keys(kit.bones) as BoneName[]) {
      const parts = kit.bones[name]!;
      if (parts.body) {
        const mesh = new THREE.Mesh(parts.body, this.skin);
        mesh.castShadow = true;
        this.bones[name].add(mesh);
        suitParts.push(mesh);
      }
      if (parts.glow) this.bones[name].add(new THREE.Mesh(parts.glow, this.lights));
    }
    this.wounds = new Wounds(suitParts, machine ? 1 : 0);
    for (const h of kit.halos) {
      const sprite = new THREE.Sprite(this.halo);
      sprite.position.set(h.at[0], h.at[1], h.at[2]);
      sprite.scale.setScalar(h.size);
      this.bones[h.bone].add(sprite);
    }
    if (!machine) {
      // A Corps suit is personal: each pilot wears their unit's patch on the left arm.
      const patchMat = new THREE.MeshStandardMaterial({ color: PATCHES[variant % PATCHES.length], roughness: 0.8, flatShading: true });
      const patchGeo = block(0.008, 0.06, 0.07, 0.002);
      const patch = new THREE.Mesh(patchGeo, patchMat);
      patch.position.set(-0.064, -0.16, 0);
      this.bones.upperArmL.add(patch);
      this.owned.push(patchMat, patchGeo);
    }

    // The weapon is part of the right forearm, so raising the arm points it.
    const gunPlate = new THREE.MeshStandardMaterial({ color: finish.plate, roughness: 0.6, metalness: 0.4, flatShading: true });
    const gunDark = new THREE.MeshStandardMaterial({ color: finish.dark, roughness: 0.6, metalness: 0.5, flatShading: true });
    const gunSteel = new THREE.MeshStandardMaterial({ color: finish.steel, roughness: 0.32, metalness: 0.85, flatShading: true });
    this.owned.push(gunPlate, gunDark, gunSteel);
    this.gun = new ArmGun({ gun: this.gunMat, plate: gunPlate, dark: gunDark, steel: gunSteel }, true);
    this.gun.root.position.copy(GUN_AT);
    this.gun.root.rotation.x = -Math.PI / 2;
    this.gun.root.scale.setScalar(GUN_SCALE);
    this.vent.position.set(-0.1, -0.14, -0.02);
    this.bones.foreArmR.add(this.gun.root, this.vent);
    this.podMuzzle.position.set(...POD_MUZZLE);
    this.bones.pod.add(this.podMuzzle);
    this.bones.pod.rotation.x = 1.15;
    this.muzzleFlash = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), MUZZLE.clone());
    this.muzzleFlash.visible = false;
    this.owned.push(this.muzzleFlash.geometry, this.muzzleFlash.material as THREE.Material);

    for (const at of kit.thrusters) {
      const flame = new THREE.Mesh(FLAME_GEO, FLAME);
      flame.rotation.x = Math.PI;
      flame.position.set(at[0], at[1] - 0.25, at[2]);
      flame.visible = false;
      this.flames.push(flame);
      this.bones.chest.add(flame);
    }

    this.root.add(this.body);
    // The flash moves between the barrel and the pod, so it hangs on neither.
    this.root.add(this.muzzleFlash);

    if (ally) {
      const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.2, 4), new THREE.MeshBasicMaterial({ color: look.visor }));
      chevron.rotation.x = Math.PI;
      chevron.position.y = 2.2;
      this.root.add(chevron);
      this.owned.push(chevron.geometry, chevron.material as THREE.Material);
    }
    this.mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: noticeMark(), depthTest: false, transparent: true }));
    this.mark.position.y = 2.45;
    this.mark.visible = false;
    this.root.add(this.mark);
    this.owned.push(this.mark.material);

    this.laserMat = new THREE.MeshBasicMaterial({
      color: '#ffd23f',
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.laser = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.laserMat);
    this.laser.visible = false;
    this.laser.frustumCulled = false;
    this.owned.push(this.laser.geometry, this.laserMat);
  }

  /** A flinch when hit. */
  /** A foot came down this frame. */
  get footfall(): boolean {
    return this.anim.footfall;
  }

  flinch(): void {
    this.anim.hit();
  }

  /** Blood (or crude) on the suit where a round struck at `at`, flying along `dir`. */
  wound(at: Vec3, dir: Vec3, damage: number): void {
    this.root.updateMatrixWorld(true);
    this.wounds.add(at, dir, damage);
  }

  fireFlash(): void {
    this.shot = 1;
    this.anim.shot();
    if (!this.shoulder) this.gun.fire();
  }

  /**
   * The pilot is torn apart: the body is gone at once. Returns the skeleton as
   * it stood this moment, so its parts can fly from where they were.
   */
  gib(): Skeleton {
    this.gibbed = true;
    this.root.visible = false;
    this.root.updateMatrixWorld(true);
    return this.bones;
  }

  /**
   * The pilot dies as a ragdoll: a copy of the body as it stands this moment
   * (wounds and all), with where every bone was and how fast it moved, for
   * the ragdoll to carry on from. This pilot's own model is hidden until it
   * respawns. `vel` stands in for the bones' speed before they have any.
   */
  corpse(team: number, vel: Vec3): CorpseParts {
    this.ragdolled = true;
    this.root.visible = false;
    this.root.updateMatrixWorld(true);
    const lights = this.lights.clone();
    const halo = this.halo.clone();
    const owned: { dispose(): void }[] = [lights, halo];
    const originals: THREE.Object3D[] = [];
    this.body.traverse((o) => originals.push(o));
    const body = this.body.clone(true);
    const copyOf = new Map<THREE.Object3D, THREE.Object3D>();
    let i = 0;
    body.traverse((o) => {
      copyOf.set(originals[i++], o);
      if (o instanceof THREE.Sprite && o.material === this.halo) o.material = halo;
      if (!(o instanceof THREE.Mesh)) return;
      if (o.material === this.lights) o.material = lights;
      // Wounds are cleaned off this pilot at respawn; the body keeps its own.
      if (o.geometry instanceof DecalGeometry) {
        o.geometry = new THREE.BufferGeometry().copy(o.geometry);
        owned.push(o.geometry);
      }
    });
    const bones = {} as Skeleton;
    const pose = {} as Record<BoneName, THREE.Matrix4>;
    const speed = {} as Record<BoneName, THREE.Vector3>;
    for (const b of BONES) {
      bones[b] = copyOf.get(this.bones[b])!;
      pose[b] = this.bones[b].matrixWorld.clone();
      speed[b] = this.tracked ? this.boneVel[b].clone() : new THREE.Vector3(vel.x, vel.y, vel.z);
    }
    return {
      body,
      bones,
      pose,
      vel: speed,
      flames: this.flames.map((f) => copyOf.get(f)!),
      lights,
      halo,
      haloOpacity: this.haloOpacity,
      flicker: this.pulse > 0,
      team,
      owned,
    };
  }

  /** Which way the body falls when it goes down: its back, flat on the ground. */
  fallDir(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** Pop the "!" over the head. */
  notice(): void {
    this.noticed = 0.9;
  }

  /** World position of the muzzle in use (the arm's barrel or the shoulder pod), as of the last update. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return (this.shoulder ? this.podMuzzle : this.gun.muzzle).getWorldPosition(out);
  }

  /** Where the arm's housing lets off steam. */
  ventWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.vent.getWorldPosition(out);
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
   * `raise` (0..1) lifts the arm to point its weapon; `show` hides the model in
   * first person while everything else keeps animating.
   */
  update(dt: number, a: Actor, pos: Vec3, show: boolean, raise: number): void {
    const s = a.p;
    if (a.loadout[a.weapon] !== this.weapon) {
      this.weapon = a.loadout[a.weapon];
      this.shoulder = WEAPONS[this.weapon]?.mount === 'shoulder';
    }
    // The pod swings up or folds away in a moment, not in a frame.
    this.podUp = damp(this.podUp, this.shoulder && a.alive ? 1 : 0, 9, dt);

    this.root.position.set(pos.x, pos.y, pos.z);
    const speed = lenH(s.vel);
    let turnRate = 0;
    if (!a.alive) {
      if (this.dead < 0) this.dead = 0;
      this.dead += dt;
      this.mark.visible = false;
      this.laser.visible = false;
      this.muzzleFlash.visible = false;
      // Lie there, then clear away.
      this.root.visible = this.dead < 2.4 && !this.gibbed && !this.ragdolled;
    } else {
      if (this.dead >= 0) {
        this.dead = -1;
        this.gibbed = false;
        this.ragdolled = false;
        this.tracked = false;
        this.wounds.clear();
        this.heading = s.yaw;
      }
      this.root.visible = show;
      // Face where the pilot looks, except when momentum decides (wallrun, slide).
      let facing = s.yaw;
      if ((s.wallrun.active || s.sliding) && speed > 1 && raise < 0.5) facing = Math.atan2(-s.vel.x, -s.vel.z);
      const turn = Math.atan2(Math.sin(facing - this.heading), Math.cos(facing - this.heading));
      const step = turn * (1 - Math.exp(-18 * dt));
      this.heading += step;
      turnRate = dt > 0 ? step / dt : 0;
      this.root.rotation.y = this.heading;
    }

    this.anim.update(dt, {
      s,
      alive: a.alive,
      speed,
      fwd: -(s.vel.x * Math.sin(this.heading) + s.vel.z * Math.cos(this.heading)),
      side: s.vel.x * Math.cos(this.heading) - s.vel.z * Math.sin(this.heading),
      turnRate,
      lookYaw: Math.atan2(Math.sin(s.yaw - this.heading), Math.cos(s.yaw - this.heading)),
      aimPitch: s.pitch + a.punchPitch,
      raise,
      shoulder: this.shoulder,
      podUp: this.podUp,
      venting: a.reload > 0 && !this.shoulder,
    });
    // The pod tips back to take new rockets.
    const reloadTip = a.reload > 0 && this.shoulder ? 0.45 : 0;
    this.bones.pod.rotation.x = damp(this.bones.pod.rotation.x, this.anim.podPitch + reloadTip * this.podUp, 16, dt);
    this.bones.pod.position.y = 0.46 + 0.08 * this.podUp;

    // Suit lights: Z.E.R.O optics breathe; every light dies with its pilot.
    this.glowT += dt;
    this.lightLevel = damp(this.lightLevel, a.alive ? 1 : 0, a.alive ? 6 : 2.5, dt);
    const level = this.lightLevel * (1 - this.pulse + this.pulse * (0.5 + 0.5 * Math.sin(this.glowT * 2.2)));
    this.lights.color.setScalar(0.08 + 0.92 * level);
    this.halo.opacity = this.haloOpacity * level;
    // The barrel reshapes itself for each weapon, and draws in while the pod is up.
    this.gun.update(dt, this.shoulder ? 'none' : this.weapon);

    for (const flame of this.flames) {
      flame.visible = s.thrusting && a.alive;
      flame.scale.y = 0.8 + Math.random() * 0.6;
    }

    if (a.alive) {
      this.shot = Math.max(0, this.shot - dt * 16);
      this.muzzleFlash.visible = this.shot > 0;
      if (this.shot > 0) {
        this.root.updateMatrixWorld(true);
        this.root.worldToLocal(this.muzzleWorld(this.muzzleFlash.position));
        this.muzzleFlash.scale.setScalar((0.6 + this.shot * 0.9) * (this.shoulder ? 1.5 : 1));
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
      if (dt > 0) this.track(dt);
    }
  }

  /** Note where every bone is, and how fast it got there, for a ragdoll to carry on from. */
  private track(dt: number): void {
    this.root.updateMatrixWorld(true);
    for (const b of BONES) {
      tmp.setFromMatrixPosition(this.bones[b].matrixWorld);
      if (this.tracked) this.boneVel[b].subVectors(tmp, this.boneAt[b]).divideScalar(dt).clampLength(0, 30);
      this.boneAt[b].copy(tmp);
    }
    this.tracked = true;
  }

  dispose(): void {
    // The suit's geometry is shared by every pilot of the team; only this pilot's own things go.
    for (const o of this.owned) o.dispose();
    this.wounds.clear();
    this.gun.dispose();
  }
}
