import * as THREE from 'three';
import { clamp, lenH, type PlayerState } from '@dropline/shared';

const REST = new THREE.Vector3(0.2, -0.19, -0.52);

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/**
 * First-person weapon stand-in. Drawn in its own scene after the world with the
 * depth buffer cleared, so it never pokes through walls.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  private readonly rig = new THREE.Group();
  private bob = 0;
  private swayX = 0;
  private swayY = 0;

  constructor() {
    const metal = new THREE.MeshStandardMaterial({ color: '#565f6d', roughness: 0.5, metalness: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: '#2b3038', roughness: 0.7, metalness: 0.15 });
    const glow = new THREE.MeshStandardMaterial({ color: '#30140a', emissive: '#ff7a2f', emissiveIntensity: 1.3 });
    const glove = new THREE.MeshStandardMaterial({ color: '#3a3f47', roughness: 0.9 });

    this.rig.add(
      box(0.07, 0.11, 0.44, metal, 0, 0, 0),
      box(0.04, 0.04, 0.26, dark, 0, 0.02, -0.33),
      box(0.05, 0.035, 0.2, dark, 0, 0.075, -0.02),
      box(0.012, 0.03, 0.02, glow, 0, 0.105, -0.1),
      box(0.055, 0.16, 0.08, dark, 0, -0.13, -0.02),
      box(0.05, 0.13, 0.07, dark, 0, -0.1, 0.15),
      box(0.074, 0.008, 0.22, glow, 0, 0.03, -0.04),
      box(0.08, 0.08, 0.2, glove, 0, -0.15, 0.2),
    );
    this.rig.scale.setScalar(0.8);
    this.scene.add(this.rig);
    this.scene.add(new THREE.HemisphereLight('#bcd6ff', '#40342c', 1.6));
    const key = new THREE.DirectionalLight('#ffd0a0', 2.4);
    key.position.set(-1, 2, 1);
    this.scene.add(key);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, s: PlayerState, mouseDx: number, mouseDy: number): void {
    const speed = lenH(s.vel);
    const moving = s.grounded && !s.sliding ? Math.min(1, speed / 8) : 0;
    this.bob += speed * dt * 1.35;

    // The weapon trails behind fast mouse turns and settles back.
    this.swayX = damp(this.swayX, clamp(-mouseDx * 0.0018, -0.07, 0.07), 10, dt);
    this.swayY = damp(this.swayY, clamp(mouseDy * 0.0018, -0.07, 0.07), 10, dt);

    let x = REST.x + Math.sin(this.bob) * 0.012 * moving + this.swayX;
    let y = REST.y - Math.abs(Math.cos(this.bob)) * 0.014 * moving + this.swayY;
    const z = REST.z;
    let roll = 0;
    let turn = this.swayX * 2;
    let tip = -this.swayY * 2;

    if (!s.grounded && !s.wallrun.active) y += clamp(-s.vel.y * 0.004, -0.04, 0.05);
    if (s.wallrun.active) roll = s.wallrun.side * 0.3;
    if (s.sliding) {
      roll = 0.4;
      y -= 0.03;
      x -= 0.05;
    }
    if (s.mantle.active) {
      y -= 0.22;
      tip -= 0.5;
    }

    const p = this.rig.position;
    p.set(damp(p.x, x, 18, dt), damp(p.y, y, 18, dt), z);
    const r = this.rig.rotation;
    r.set(damp(r.x, tip, 14, dt), damp(r.y, turn, 14, dt), damp(r.z, roll, 10, dt));
  }
}
