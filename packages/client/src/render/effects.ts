import * as THREE from 'three';
import type { Vec3 } from '@dropline/shared';

const TRACERS = 64;
const SPARKS = 320;
const DECALS = 96;
const SMOKE = 220;
const ROCKETS = 24;
const FIREBALLS = 8;
const RINGS = 6;
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

interface Puff {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Quaternion;
  life: number;
  total: number;
  size: number;
  shade: number;
}

interface Rocket {
  /** Projectile id from the simulation; -1 when unused. */
  id: number;
  mesh: THREE.Group;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  life: number;
  /** Where it is drawn relative to where it really is: starts at the launcher, shrinks to nothing. */
  offset: THREE.Vector3;
  trail: number;
}

interface Blast {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  total: number;
  radius: number;
}

/**
 * Combat effects, all pooled: tracers, sparks, smoke and impact marks are each
 * one instanced mesh; rockets, fireballs and shock rings are small fixed sets of
 * meshes. Nothing is created during play.
 */
export class Effects {
  private readonly tracerMesh: THREE.InstancedMesh;
  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly decalMesh: THREE.InstancedMesh;
  private readonly smokeMesh: THREE.InstancedMesh;
  private readonly tracers: Tracer[] = [];
  private readonly sparks: Spark[] = [];
  private readonly puffs: Puff[] = [];
  private readonly rockets: Rocket[] = [];
  private readonly fireballs: Blast[] = [];
  private readonly rings: Blast[] = [];
  private readonly lights: THREE.PointLight[] = [];
  private readonly boom: THREE.PointLight;
  private nextTracer = 0;
  private nextSpark = 0;
  private nextDecal = 0;
  private nextLight = 0;
  private nextPuff = 0;
  private nextFireball = 0;
  private nextRing = 0;

  constructor(scene: THREE.Scene) {
    const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false };
    this.tracerMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(additive), TRACERS);
    this.sparkMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(additive), SPARKS);
    this.decalMesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.1, 10),
      new THREE.MeshBasicMaterial({ color: '#0a0c0f', transparent: true, opacity: 0.72, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      DECALS,
    );
    this.smokeMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.5, 0),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.38, depthWrite: false }),
      SMOKE,
    );
    for (const mesh of [this.tracerMesh, this.sparkMesh, this.decalMesh, this.smokeMesh]) {
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
    for (let i = 0; i < SMOKE; i++) {
      this.puffs.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Quaternion(), life: 0, total: 1, size: 1, shade: 0.5 });
      this.smokeMesh.setColorAt(i, col.set(0));
    }

    // Rockets: a dark body with a bright tail.
    const bodyGeo = new THREE.BoxGeometry(0.16, 0.16, 0.8);
    const tailGeo = new THREE.ConeGeometry(0.16, 1.1, 8);
    // The flame trails behind: the model flies toward -Z.
    tailGeo.rotateX(Math.PI / 2);
    tailGeo.translate(0, 0, 0.9);
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#2a2f37', roughness: 0.5, metalness: 0.4, emissive: '#ff7a2f', emissiveIntensity: 0.6 });
    const tailMat = new THREE.MeshBasicMaterial({ color: '#ffc27a', ...additive });
    for (let i = 0; i < ROCKETS; i++) {
      const mesh = new THREE.Group();
      mesh.add(new THREE.Mesh(bodyGeo, bodyMat), new THREE.Mesh(tailGeo, tailMat));
      mesh.visible = false;
      scene.add(mesh);
      this.rockets.push({ id: -1, mesh, pos: new THREE.Vector3(), dir: new THREE.Vector3(), speed: 0, life: 0, offset: new THREE.Vector3(), trail: 0 });
    }

    const ballGeo = new THREE.IcosahedronGeometry(1, 2);
    for (let i = 0; i < FIREBALLS; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: '#ffb066', ...additive });
      const mesh = new THREE.Mesh(ballGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.fireballs.push({ mesh, mat, life: 0, total: 1, radius: 1 });
    }
    const ringGeo = new THREE.RingGeometry(0.82, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < RINGS; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: '#ffe2b0', side: THREE.DoubleSide, ...additive });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, mat, life: 0, total: 1, radius: 1 });
    }

    // The lights stay in the scene at zero strength, so firing never recompiles shaders.
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight('#ffc27a', 0, 16, 2);
      this.lights.push(light);
      scene.add(light);
    }
    this.boom = new THREE.PointLight('#ffb070', 0, 48, 2);
    scene.add(this.boom);
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
  decal(pos: Vec3, normal: Vec3, size = 1): void {
    v.set(normal.x, normal.y, normal.z);
    q.setFromUnitVectors(Z, v);
    const s = size * (0.7 + Math.random() * 0.7);
    m4.compose(v.multiplyScalar(0.012).add(pos as THREE.Vector3Like), q, scale.set(s, s, 1));
    this.decalMesh.setMatrixAt(this.nextDecal++ % DECALS, m4);
    this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  /** Light the surroundings for a few frames. */
  flash(pos: THREE.Vector3, strength: number): void {
    const light = this.lights[this.nextLight++ % this.lights.length];
    light.position.copy(pos);
    light.intensity = strength;
  }

  /**
   * Puffs of smoke or dust around a point. They drift with `drift` (plus a little
   * scatter), swell to `size` meters and thin out over `life` seconds.
   */
  smoke(pos: Vec3, count: number, spread: number, size: number, life: number, drift: Vec3 | null = null, shade = 0.42): void {
    for (let i = 0; i < count; i++) {
      const p = this.puffs[this.nextPuff++ % SMOKE];
      p.pos.set(pos.x + (Math.random() * 2 - 1) * spread, pos.y + (Math.random() * 2 - 1) * spread * 0.5, pos.z + (Math.random() * 2 - 1) * spread);
      p.vel.set(Math.random() - 0.5, 0.4 + Math.random() * 0.8, Math.random() - 0.5);
      if (drift) p.vel.set(p.vel.x * 0.6 + drift.x, p.vel.y * 0.4 + drift.y, p.vel.z * 0.6 + drift.z);
      p.rot.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      p.total = p.life = life * (0.7 + Math.random() * 0.6);
      p.size = size * (0.7 + Math.random() * 0.6);
      p.shade = shade * (0.8 + Math.random() * 0.4);
    }
  }

  /** A ball of fire that swells to `radius` and is gone in `time` seconds. */
  fireball(pos: Vec3, radius: number, time = 0.38, color = '#ffb066'): void {
    const b = this.fireballs[this.nextFireball++ % FIREBALLS];
    b.mesh.position.set(pos.x, pos.y, pos.z);
    b.mat.color.set(color);
    b.total = b.life = time;
    b.radius = radius;
    b.mesh.visible = true;
  }

  /** A flat ring racing outward along the ground to `radius`. */
  ring(pos: Vec3, radius: number, color: string, time = 0.5): void {
    const b = this.rings[this.nextRing++ % RINGS];
    b.mesh.position.set(pos.x, pos.y + 0.08, pos.z);
    b.mat.color.set(color);
    b.total = b.life = time;
    b.radius = radius;
    b.mesh.visible = true;
  }

  /**
   * A blast: fire, sparks, smoke and light, and a scorch on the surface it
   * went off against. `radius` is the simulation's blast radius.
   */
  explosion(pos: Vec3, normal: Vec3 | null, radius: number): void {
    this.fireball(pos, radius * 0.55, 0.36);
    this.fireball(pos, radius * 0.28, 0.2, '#fff2cf');
    this.burst(pos, normal, 26, '#ffcf8a', 15);
    this.smoke(pos, 9, radius * 0.25, radius * 0.5, 1.5);
    this.boom.position.set(pos.x, pos.y, pos.z);
    if (normal) this.boom.position.addScaledVector(v.set(normal.x, normal.y, normal.z), 0.6);
    this.boom.intensity = 60;
    if (normal) {
      this.decal(pos, normal, 9);
      if (normal.y > 0.7) this.ring(pos, radius, '#ffe2b0', 0.42);
    }
  }

  /**
   * Show a rocket in flight. It is flown here from the launch data, frame by
   * frame, and removed by `endRocket` when the simulation says it burst.
   * `seenFrom` is where the viewer sees it leave (a muzzle), when that differs
   * from where it really starts.
   */
  rocket(id: number, from: Vec3, dir: Vec3, speed: number, life: number, seenFrom: THREE.Vector3 | null): void {
    let r = this.rockets.find((x) => x.id < 0);
    if (!r) r = this.rockets[0];
    r.id = id;
    r.pos.set(from.x, from.y, from.z);
    r.dir.set(dir.x, dir.y, dir.z);
    r.speed = speed;
    r.life = life;
    // The exhaust starts a few meters out, so a launch does not fog the shooter's own view.
    r.trail = -4;
    if (seenFrom) r.offset.copy(seenFrom).sub(r.pos);
    else r.offset.set(0, 0, 0);
    r.mesh.position.copy(r.pos).add(r.offset);
    r.mesh.lookAt(v.copy(r.mesh.position).sub(r.dir));
    r.mesh.visible = true;
  }

  endRocket(id: number): void {
    const r = this.rockets.find((x) => x.id === id);
    if (!r) return;
    r.id = -1;
    r.mesh.visible = false;
  }

  /** Remove every mark and effect (new match). */
  clear(): void {
    for (const t of this.tracers) t.head = -1;
    for (const s of this.sparks) s.life = 0;
    for (const p of this.puffs) p.life = 0;
    for (const r of this.rockets) {
      r.id = -1;
      r.mesh.visible = false;
    }
    for (const b of [...this.fireballs, ...this.rings]) {
      b.life = 0;
      b.mesh.visible = false;
    }
    for (let i = 0; i < DECALS; i++) this.decalMesh.setMatrixAt(i, HIDDEN);
    for (let i = 0; i < SPARKS; i++) this.sparkMesh.setMatrixAt(i, HIDDEN);
    for (let i = 0; i < SMOKE; i++) this.smokeMesh.setMatrixAt(i, HIDDEN);
    this.decalMesh.instanceMatrix.needsUpdate = true;
    this.boom.intensity = 0;
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

    for (const r of this.rockets) {
      if (r.id < 0) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.id = -1;
        r.mesh.visible = false;
        continue;
      }
      r.pos.addScaledVector(r.dir, r.speed * dt);
      r.offset.multiplyScalar(Math.exp(-dt * 9));
      r.mesh.position.copy(r.pos).add(r.offset);
      // A puff of exhaust every meter and a half.
      r.trail += r.speed * dt;
      while (r.trail > 1.5) {
        r.trail -= 1.5;
        v.copy(r.mesh.position).addScaledVector(r.dir, -0.9 - r.trail);
        this.smoke(v, 1, 0.05, 0.42, 0.7, null, 0.6);
      }
    }

    for (let i = 0; i < SMOKE; i++) {
      const p = this.puffs[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.smokeMesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      p.vel.multiplyScalar(Math.exp(-dt * 1.6));
      p.pos.addScaledVector(p.vel, dt);
      // Swell quickly, then thin away to nothing.
      const age = 1 - p.life / p.total;
      const size = p.size * (age < 0.25 ? 0.35 + (age / 0.25) * 0.65 : 1 - ((age - 0.25) / 0.75) ** 2);
      m4.compose(p.pos, p.rot, scale.setScalar(Math.max(0.001, size)));
      this.smokeMesh.setMatrixAt(i, m4);
      this.smokeMesh.setColorAt(i, col.setScalar(p.shade * (1 - age * 0.35)));
    }
    this.smokeMesh.instanceMatrix.needsUpdate = true;
    this.smokeMesh.instanceColor!.needsUpdate = true;

    for (const b of this.fireballs) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const age = 1 - Math.max(0, b.life) / b.total;
      b.mesh.visible = b.life > 0;
      b.mesh.scale.setScalar(b.radius * (0.25 + 0.75 * (1 - (1 - age) ** 3)));
      b.mat.opacity = (1 - age) ** 1.5;
    }
    for (const b of this.rings) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const age = 1 - Math.max(0, b.life) / b.total;
      b.mesh.visible = b.life > 0;
      b.mesh.scale.setScalar(Math.max(0.01, b.radius * (1 - (1 - age) ** 2)));
      b.mat.opacity = 1 - age;
    }

    for (const light of this.lights) light.intensity *= Math.exp(-dt * 38);
    this.boom.intensity *= Math.exp(-dt * 9);
  }
}
