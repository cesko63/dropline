import * as THREE from 'three';
import { lenH, type PlayerState, type Vec3 } from '@dropline/shared';

const ARMOR = new THREE.MeshStandardMaterial({ color: '#2c323b', roughness: 0.55, metalness: 0.45 });
const PLATE = new THREE.MeshStandardMaterial({ color: '#c2581f', roughness: 0.5, metalness: 0.3 });
const VISOR = new THREE.MeshStandardMaterial({ color: '#0b1a22', emissive: '#58d6ff', emissiveIntensity: 2.2 });
const FLAME = new THREE.MeshBasicMaterial({
  color: '#ffb066',
  transparent: true,
  opacity: 0.85,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

function part(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

/** A limb that swings from its top end. */
function limb(w: number, len: number, d: number, x: number, y: number): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, 0);
  pivot.add(part(w, len, d, ARMOR, 0, -len / 2, 0));
  return pivot;
}

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/**
 * Placeholder pilot built from boxes with procedural animation. It stands in
 * until real rigged models exist; the model faces -Z like the camera.
 */
export class Avatar {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly upper = new THREE.Group();
  private readonly legL = limb(0.18, 0.9, 0.2, -0.14, 0.9);
  private readonly legR = limb(0.18, 0.9, 0.2, 0.14, 0.9);
  private readonly armL = limb(0.13, 0.62, 0.14, -0.34, 1.5);
  private readonly armR = limb(0.13, 0.62, 0.14, 0.34, 1.5);
  private readonly flames: THREE.Mesh[] = [];
  private phase = 0;
  private heading = 0;

  constructor() {
    this.upper.add(
      part(0.52, 0.62, 0.3, ARMOR, 0, 1.22, 0),
      part(0.56, 0.2, 0.34, PLATE, 0, 1.46, 0),
      part(0.26, 0.28, 0.28, ARMOR, 0, 1.7, 0),
      part(0.22, 0.08, 0.03, VISOR, 0, 1.72, -0.15),
      part(0.34, 0.4, 0.16, ARMOR, 0, 1.28, 0.22),
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
  }

  update(dt: number, s: PlayerState, pos: Vec3, visible: boolean): void {
    this.root.visible = visible;
    if (!visible) return;
    this.root.position.set(pos.x, pos.y, pos.z);

    const speed = lenH(s.vel);
    // Face where the camera looks, except when momentum decides (wallrun, slide).
    let facing = s.yaw;
    if ((s.wallrun.active || s.sliding) && speed > 1) facing = Math.atan2(-s.vel.x, -s.vel.z);
    const turn = Math.atan2(Math.sin(facing - this.heading), Math.cos(facing - this.heading));
    this.heading += turn * (1 - Math.exp(-18 * dt));
    this.root.rotation.y = this.heading;

    const running = s.grounded && !s.sliding;
    const stride = running ? Math.min(1, speed / 8) : 0;
    this.phase += speed * dt * 1.5;
    const swing = Math.sin(this.phase) * 0.9 * stride;

    let legL = swing;
    let legR = -swing;
    let armL = -swing * 0.8;
    let armR = swing * 0.8;
    let lean = 0;
    let pitch = running ? -0.12 * stride : 0;
    let drop = 0;

    if (s.sliding) {
      pitch = 0.95;
      drop = -0.55;
      legL = -1.15;
      legR = -0.85;
      armL = armR = 0.5;
    } else if (s.wallrun.active) {
      lean = s.wallrun.side * 0.32;
      const fast = Math.sin(this.phase * 1.2) * 0.9;
      legL = fast;
      legR = -fast;
      armL = -fast * 0.6;
      armR = fast * 0.6;
    } else if (s.mantle.active) {
      armL = armR = -2.6;
      legL = -0.5;
      legR = 0.2;
    } else if (!s.grounded) {
      legL = -0.55;
      legR = 0.25;
      armL = armR = s.thrusting ? -0.25 : -0.7;
    } else if (s.crouched) {
      drop = -0.42;
      legL = -1.0 + swing * 0.4;
      legR = -1.0 - swing * 0.4;
      pitch = 0.25;
    }

    this.legL.rotation.x = damp(this.legL.rotation.x, legL, 20, dt);
    this.legR.rotation.x = damp(this.legR.rotation.x, legR, 20, dt);
    this.armL.rotation.x = damp(this.armL.rotation.x, armL, 20, dt);
    this.armR.rotation.x = damp(this.armR.rotation.x, armR, 20, dt);
    this.body.rotation.z = damp(this.body.rotation.z, lean, 12, dt);
    this.body.rotation.x = damp(this.body.rotation.x, pitch, 12, dt);
    this.body.position.y = damp(this.body.position.y, drop, 16, dt);

    for (const flame of this.flames) {
      flame.visible = s.thrusting;
      flame.scale.y = 0.8 + Math.random() * 0.6;
    }
  }
}
