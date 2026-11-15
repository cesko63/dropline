import * as THREE from 'three';
import type { Vec3 } from '@dropline/shared';

const TRACERS = 64;
const SPARKS = 256;
const DECALS = 96;
/** Tracer streaks fly at this speed, meters a second, and are this long. */
const TRACER_SPEED = 260;
const TRACER_LENGTH = 10;

const Z = new THREE.Vector3(0, 0, 1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const scale = new THREE.Vector3();
const col = new THREE.Color();

interface Tracer {
  from: THREE.Vector3;
  dir: THREE.Vector3;
  dist: number;
  /** Distance the head of the streak has covered; -1 when unused. */
  head: number;
  color: THREE.Color;
  width: number;
}

interface Spark {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  total: number;
  color: THREE.Color;
}

/**
 * Combat effects, all pooled and each drawn as one instanced mesh: tracers,
 * sparks, impact marks and the flash of light from a shot. Nothing is created
 * during play.
 */
export class Effects {
  private readonly tracerMesh: THREE.InstancedMesh;
  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly decalMesh: THREE.InstancedMesh;
  private readonly tracers: Tracer[] = [];
  private readonly sparks: Spark[] = [];
  private readonly lights: THREE.PointLight[] = [];
  private nextTracer = 0;
  private nextSpark = 0;
  private nextDecal = 0;
  private nextLight = 0;

  constructor(scene: THREE.Scene) {
    const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false };
    this.tracerMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(additive), TRACERS);
    this.sparkMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(additive), SPARKS);
    this.decalMesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.1, 10),
      new THREE.MeshBasicMaterial({ color: '#0a0c0f', transparent: true, opacity: 0.72, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      DECALS,
    );
    for (const mesh of [this.tracerMesh, this.sparkMesh, this.decalMesh]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, HIDDEN);
      scene.add(mesh);
    }
    for (let i = 0; i < TRACERS; i++) {
      this.tracers.push({ from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, head: -1, color: new THREE.Color(), width: 0.03 });
      this.tracerMesh.setColorAt(i, col.set(0));
    }
    for (let i = 0; i < SPARKS; i++) {
      this.sparks.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, total: 1, color: new THREE.Color() });
      this.sparkMesh.setColorAt(i, col.set(0));
    }
    // The lights stay in the scene at zero strength, so firing never recompiles shaders.
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight('#ffc27a', 0, 16, 2);
      this.lights.push(light);
      scene.add(light);
    }
  }

  /** A streak from the muzzle to where the round stopped. */
  tracer(from: THREE.Vector3, to: Vec3, color: string, width = 0.035): void {
    const t = this.tracers[this.nextTracer++ % TRACERS];
    t.from.copy(from);
    t.dir.set(to.x - from.x, to.y - from.y, to.z - from.z);
    t.dist = t.dir.length();
    if (t.dist < 1.5) {
      t.head = -1;
      return;
    }
    t.dir.divideScalar(t.dist);
    t.head = 0;
    t.color.set(color);
    t.width = width;
  }

  /** Sparks thrown off a surface (along `normal`) or out of a hit pilot (all around). */
  burst(pos: Vec3, normal: Vec3 | null, count: number, color: string, speed = 5): void {
    for (let i = 0; i < count; i++) {
      const s = this.sparks[this.nextSpark++ % SPARKS];
      s.pos.set(pos.x, pos.y, pos.z);
      s.vel.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      if (normal) s.vel.add(v.set(normal.x, normal.y, normal.z).multiplyScalar(1.2)).normalize();
      s.vel.multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      s.total = s.life = 0.18 + Math.random() * 0.28;
      s.color.set(color);
    }
  }

  /** A scorch mark on the surface that was hit. */
  decal(pos: Vec3, normal: Vec3): void {
    v.set(normal.x, normal.y, normal.z);
    q.setFromUnitVectors(Z, v);
    const size = 0.7 + Math.random() * 0.7;
    m4.compose(v.multiplyScalar(0.012).add(pos as THREE.Vector3Like), q, scale.set(size, size, 1));
    this.decalMesh.setMatrixAt(this.nextDecal++ % DECALS, m4);
    this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  /** Light the surroundings for a few frames. */
  flash(pos: THREE.Vector3, strength: number): void {
    const light = this.lights[this.nextLight++ % this.lights.length];
    light.position.copy(pos);
    light.intensity = strength;
  }

  /** Remove every mark and effect (new match). */
  clear(): void {
    for (const t of this.tracers) t.head = -1;
    for (const s of this.sparks) s.life = 0;
    for (let i = 0; i < DECALS; i++) this.decalMesh.setMatrixAt(i, HIDDEN);
    this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    for (let i = 0; i < TRACERS; i++) {
      const t = this.tracers[i];
      if (t.head < 0) continue;
      t.head += TRACER_SPEED * dt;
      const front = Math.min(t.dist, t.head);
      const back = Math.max(0, t.head - TRACER_LENGTH);
      if (back >= t.dist) {
        t.head = -1;
        this.tracerMesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      v.copy(t.from).addScaledVector(t.dir, (front + back) / 2);
      q.setFromUnitVectors(Z, t.dir);
      m4.compose(v, q, scale.set(t.width, t.width, front - back));
      this.tracerMesh.setMatrixAt(i, m4);
      this.tracerMesh.setColorAt(i, t.color);
    }
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    this.tracerMesh.instanceColor!.needsUpdate = true;

    for (let i = 0; i < SPARKS; i++) {
      const s = this.sparks[i];
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        this.sparkMesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      s.vel.y -= 12 * dt;
      s.pos.addScaledVector(s.vel, dt);
      const fade = s.life / s.total;
      // Stretched along the direction of travel, so each spark reads as a streak.
      q.setFromUnitVectors(Z, v.copy(s.vel).normalize());
      m4.compose(s.pos, q, scale.set(0.022, 0.022, 0.05 + s.vel.length() * 0.018));
      this.sparkMesh.setMatrixAt(i, m4);
      this.sparkMesh.setColorAt(i, col.copy(s.color).multiplyScalar(fade));
    }
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    this.sparkMesh.instanceColor!.needsUpdate = true;

    for (const light of this.lights) light.intensity *= Math.exp(-dt * 38);
  }
}
