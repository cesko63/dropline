import * as THREE from 'three';
import type { Vec3 } from '@dropline/shared';
import { ParticleLayer, emitTemplate, rand, scatter, type Emit } from './fx/particles';
import { Gore } from './fx/gore';
import { floorBelow, type Surfaces } from './fx/surfaces';
import { fireAtlas, markAtlas, smokeAtlas } from './fx/textures';
import { FINISH } from './mech/kit';
import type { Skeleton } from './pilot/rig';
import type { Environment } from './scene';

const TRACERS = 64;
const SMOKE = 900;
const FIRE = 600;
const SPARKS = 700;
const DEBRIS = 80;
const ROCKETS = 24;
const RINGS = 6;
/** Tracer streaks fly at this speed, meters a second, and are this long. */
const TRACER_SPEED = 260;
const TRACER_LENGTH = 10;
/** The one breeze every plume leans with, meters a second. */
const WIND_X = 0.75;
const WIND_Z = 0.3;
/** Seconds a piece of debris lies where it came to rest, and how long it takes to sink away. */
const DEBRIS_REST = 8;
const DEBRIS_FADE = 0.8;
/** Glow tile of the fire atlas: flashes, embers and spark heads. */
const GLOW = 3;

/** The marks a surface can take, with how many of each the world keeps (the oldest goes first). */
const MARKS = {
  bullet: { tile: 0, count: 120, color: '#0b0c0e', opacity: 0.85 },
  crater: { tile: 2, count: 48, color: '#0c0c0d', opacity: 0.9 },
  scorch: { tile: 1, count: 24, color: '#0d0b0a', opacity: 0.92 },
  scuff: { tile: 3, count: 32, color: '#2e2a26', opacity: 0.55 },
} as const;
export type MarkKind = keyof typeof MARKS;

export type { Surfaces };

/** Colours of the hot things, in linear light; values over 1 burn white through the tone mapping. */
const HOT = {
  /** Fire, from its white-yellow heart to the dull red it dies in. */
  fireCore: new THREE.Color(1.5, 0.66, 0.17),
  fireEdge: new THREE.Color(0.75, 0.13, 0.02),
  flash: new THREE.Color(1.7, 1.25, 0.7),
  spark: new THREE.Color(5, 3.2, 1.3),
  sparkCool: new THREE.Color(1.6, 0.35, 0.05),
  ember: new THREE.Color(3.2, 1.1, 0.25),
};

const Z = new THREE.Vector3(0, 0, 1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const v = new THREE.Vector3();
const n3 = new THREE.Vector3();
const scale = new THREE.Vector3();
const col = new THREE.Color();
const col2 = new THREE.Color();
const ray = { o: { x: 0, y: 0, z: 0 }, d: { x: 0, y: 0, z: 0 } };
const e: Emit = emitTemplate();

function setColors(c0: THREE.Color, c1: THREE.Color): void {
  e.r0 = c0.r;
  e.g0 = c0.g;
  e.b0 = c0.b;
  e.r1 = c1.r;
  e.g1 = c1.g;
  e.b1 = c1.b;
}

/** Reset the shared emit record to a plain, still, round particle. */
function reset(): Emit {
  e.vx = e.vy = e.vz = 0;
  e.delay = 0;
  e.fadeIn = 0.1;
  e.drag = e.gravity = e.wind = e.spin = e.stretch = 0;
  e.tile = -1;
  e.bounce = -1;
  e.hover = 0;
  e.upright = false;
  e.alpha = 1;
  return e;
}

interface Tracer {
  from: THREE.Vector3;
  dir: THREE.Vector3;
  dist: number;
  /** Distance the head of the streak has covered; -1 when unused. */
  head: number;
  color: THREE.Color;
  width: number;
}

interface Chunk {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Quaternion;
  axis: THREE.Vector3;
  spin: number;
  size: THREE.Vector3;
  /** Seconds since thrown; < 0 when unused. */
  age: number;
  /** Seconds it has lain still; -1 while it still moves. */
  rest: number;
  /** Seconds it still trails smoke and glows (a burning piece of a mech). */
  hot: number;
  /** Meters flown since its last puff of smoke. */
  trail: number;
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
  glow: number;
  /** A flak shell: drawn small, with no smoke trail. */
  small: boolean;
}

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  total: number;
  radius: number;
}

/**
 * Combat effects, all pooled so nothing is created during play. Smoke, dust and
 * steam are soft lit sprites drawn back to front; fire, flashes, embers and
 * sparks are additive sprites; debris is lit chunks that tumble, bounce and
 * come to rest; marks are textured decals. Each of those is one draw call.
 * Tracers, rockets and shock rings are small fixed sets beside them.
 *
 * The named effects (`impact`, `explosion`, `mechDeath`, `wreckBurn` ...) are
 * what the game and the /effects.html page call, so both show the same thing.
 */
export class Effects {
  private readonly gore: Gore;
  private readonly smokeLayer: ParticleLayer;
  private readonly fireLayer: ParticleLayer;
  private readonly sparkLayer: ParticleLayer;
  private readonly tracerMesh: THREE.InstancedMesh;
  private readonly debrisMesh: THREE.InstancedMesh;
  private readonly marks: Record<MarkKind, { mesh: THREE.InstancedMesh; next: number }>;
  private readonly tracers: Tracer[] = [];
  private readonly chunks: Chunk[] = [];
  private readonly rockets: Rocket[] = [];
  private readonly rings: Ring[] = [];
  private readonly lights: THREE.PointLight[] = [];
  private readonly boom: THREE.PointLight;
  /** Lights the brightest burning wreck of the frame, flickering. */
  private readonly fireLight: THREE.PointLight;
  private fireHeat = 0;
  private readonly lit = new THREE.Color();
  private readonly shade = new THREE.Color();
  private nextTracer = 0;
  private nextChunk = 0;
  private nextLight = 0;
  private nextRing = 0;
  private time = 0;

  constructor(
    scene: THREE.Scene,
    private readonly env: Environment,
    private readonly surfaces: Surfaces | null,
  ) {
    const smoke = smokeAtlas();
    const fire = fireAtlas();
    this.smokeLayer = new ParticleLayer({ capacity: SMOKE, map: smoke, additive: false, sorted: true, nearFade: [0.3, 2.2] });
    this.fireLayer = new ParticleLayer({ capacity: FIRE, map: fire, additive: true, sorted: false, nearFade: [0.2, 1.2] });
    this.sparkLayer = new ParticleLayer({ capacity: SPARKS, map: fire, additive: true, sorted: false, nearFade: [0.1, 0.5] });
    scene.add(this.smokeLayer.mesh, this.fireLayer.mesh, this.sparkLayer.mesh);
    this.gore = new Gore(scene, surfaces, (p) => this.sparkShower(p, null, 3, 3, HOT.spark, HOT.sparkCool, 0.025));

    const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false };
    this.tracerMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(additive), TRACERS);
    // Debris: rough lumps, each stretched to its own shape, lit like the map.
    const lump = new THREE.DodecahedronGeometry(0.5, 0);
    this.debrisMesh = new THREE.InstancedMesh(lump, new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.35, flatShading: true }), DEBRIS);
    this.debrisMesh.castShadow = false;

    const atlas = markAtlas();
    const marks = {} as Record<MarkKind, { mesh: THREE.InstancedMesh; next: number }>;
    for (const kind of Object.keys(MARKS) as MarkKind[]) {
      const M = MARKS[kind];
      const geo = new THREE.PlaneGeometry(1, 1);
      // This kind's tile of the atlas.
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + (M.tile % 2)) * 0.5, (uv.getY(i) + 1 - Math.floor(M.tile / 2)) * 0.5);
      const mat = new THREE.MeshBasicMaterial({
        color: M.color,
        alphaMap: atlas,
        transparent: true,
        opacity: M.opacity,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      marks[kind] = { mesh: new THREE.InstancedMesh(geo, mat, M.count), next: 0 };
    }
    this.marks = marks;

    for (const mesh of [this.tracerMesh, this.debrisMesh, ...Object.values(marks).map((m) => m.mesh)]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, HIDDEN);
      scene.add(mesh);
    }
    for (let i = 0; i < TRACERS; i++) {
      this.tracers.push({ from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, head: -1, color: new THREE.Color(), width: 0.03 });
      this.tracerMesh.setColorAt(i, col.set(0));
    }
    for (let i = 0; i < DEBRIS; i++) {
      this.chunks.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Quaternion(), axis: new THREE.Vector3(), spin: 0, size: new THREE.Vector3(), age: -1, rest: -1, hot: 0, trail: 0 });
      this.debrisMesh.setColorAt(i, col.set(0));
    }

    // Rockets: a dark body with a bright tail.
    const bodyGeo = new THREE.BoxGeometry(0.16, 0.16, 0.8);
    const tailGeo = new THREE.ConeGeometry(0.12, 0.7, 8);
    // The flame trails behind: the model flies toward -Z.
    tailGeo.rotateX(Math.PI / 2);
    tailGeo.translate(0, 0, 0.75);
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#2a2f37', roughness: 0.5, metalness: 0.4, emissive: '#ff7a2f', emissiveIntensity: 0.6 });
    const tailMat = new THREE.MeshBasicMaterial({ color: '#ffc27a', ...additive });
    for (let i = 0; i < ROCKETS; i++) {
      const mesh = new THREE.Group();
      mesh.add(new THREE.Mesh(bodyGeo, bodyMat), new THREE.Mesh(tailGeo, tailMat));
      mesh.visible = false;
      scene.add(mesh);
      this.rockets.push({ id: -1, mesh, pos: new THREE.Vector3(), dir: new THREE.Vector3(), speed: 0, life: 0, offset: new THREE.Vector3(), trail: 0, glow: 0, small: false });
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
    this.fireLight = new THREE.PointLight('#ff8a3a', 0, 26, 2);
    scene.add(this.boom, this.fireLight);
  }

  /** Particles alive in each layer and debris in the world: the page's performance readout. */
  get counts(): { smoke: number; fire: number; sparks: number; debris: number; drops: number; pieces: number } {
    return { smoke: this.smokeLayer.live, fire: this.fireLayer.live, sparks: this.sparkLayer.live, debris: this.chunks.filter((c) => c.age >= 0).length, ...this.gore.counts };
  }

  // --- Building blocks ----------------------------------------------------------

  private floorBelow(x: number, y: number, z: number): number {
    return floorBelow(this.surfaces, x, y, z);
  }

  /**
   * Keep what is emitted next in front of the surface it came off: the one
   * `normal` names, or else the floor below. `hover` is how far, in widths.
   */
  private surfaceBehind(pos: Vec3, normal: Vec3 | null, hover: number): void {
    e.hover = hover;
    if (normal) {
      e.planeX = normal.x;
      e.planeY = normal.y;
      e.planeZ = normal.z;
      e.planeD = pos.x * normal.x + pos.y * normal.y + pos.z * normal.z;
    } else {
      e.planeX = e.planeZ = 0;
      e.planeY = 1;
      e.planeD = this.floorBelow(pos.x, pos.y + 0.3, pos.z);
    }
  }

  /** Hot sparks that streak out of `pos`, fall, bounce on the floor and cool from white to red. */
  private sparkShower(pos: Vec3, normal: Vec3 | null, count: number, speed: number, hot: THREE.Color, cool: THREE.Color, size = 0.035): void {
    const floor = this.floorBelow(pos.x, pos.y + (normal ? normal.y * 0.1 : 0), pos.z);
    reset();
    setColors(hot, cool);
    e.tile = GLOW;
    e.gravity = 13;
    e.drag = 1.1;
    e.stretch = 0.028;
    e.floor = floor;
    e.bounce = 0.35;
    e.fadeIn = 0.001;
    for (let i = 0; i < count; i++) {
      scatter(v, normal, 0.8).multiplyScalar(speed * rand(0.35, 1.2));
      e.x = pos.x;
      e.y = pos.y;
      e.z = pos.z;
      e.vx = v.x;
      e.vy = v.y;
      e.vz = v.z;
      e.life = rand(0.25, 0.75);
      e.size0 = size * rand(0.8, 1.4);
      e.size1 = e.size0 * 0.6;
      this.sparkLayer.emit(e);
    }
  }

  /**
   * Billows of smoke or dust. They leave `pos` (spread over `spread` meters)
   * moving outward at up to `speed`, swell from `size` to `size * grow`, drift
   * with the wind and thin out over `life` seconds. `shade` is how pale it is.
   */
  private billow(
    pos: Vec3, count: number, spread: number, speed: number, size: number, grow: number, life: number,
    shade: THREE.Color, opts: { rise?: number; delay?: number; alpha?: number; normal?: Vec3 | null; flat?: boolean; wind?: number } = {},
  ): void {
    if (count <= 0) return;
    reset();
    this.surfaceBehind(pos, opts.normal ?? null, 0.4);
    e.drag = 2.2;
    e.gravity = -(opts.rise ?? 0.4);
    e.wind = opts.wind ?? 1;
    e.spin = 0.35;
    e.fadeIn = 0.12;
    for (let i = 0; i < count; i++) {
      scatter(v, opts.normal ?? null, opts.normal ? 0.6 : 0);
      if (opts.flat) v.y = Math.abs(v.y) * 0.15;
      e.x = pos.x + v.x * spread * Math.random();
      e.y = pos.y + v.y * spread * Math.random();
      e.z = pos.z + v.z * spread * Math.random();
      const s = speed * rand(0.4, 1);
      e.vx = v.x * s;
      e.vy = v.y * s;
      e.vz = v.z * s;
      e.life = life * rand(0.7, 1.3);
      e.delay = (opts.delay ?? 0) * rand(0.6, 1.4);
      e.size0 = size * rand(0.7, 1.3);
      e.size1 = e.size0 * grow;
      e.alpha = (opts.alpha ?? 0.75) * rand(0.8, 1);
      const k = rand(0.85, 1.15);
      e.r0 = e.r1 = shade.r * k;
      e.g0 = e.g1 = shade.g * k;
      e.b0 = e.b1 = shade.b * k;
      this.smokeLayer.emit(e);
    }
  }

  /**
   * Fire that bursts out of `pos`, rises and burns from yellow down to red:
   * rolling balls of flame for a blast, or upright `tongues` for something burning.
   */
  private flames(pos: Vec3, count: number, spread: number, speed: number, size: number, life: number, opts: { normal?: Vec3 | null; delay?: number; rise?: number; tongues?: boolean } = {}): void {
    if (count <= 0) return;
    reset();
    this.surfaceBehind(pos, opts.normal ?? null, 0.35);
    setColors(HOT.fireCore, HOT.fireEdge);
    e.drag = 4;
    e.gravity = -(opts.rise ?? 3);
    e.wind = 0.3;
    e.spin = 1.2;
    e.fadeIn = 0.05;
    e.upright = opts.tongues ?? false;
    for (let i = 0; i < count; i++) {
      scatter(v, opts.normal ?? null, opts.normal ? 0.5 : 0);
      e.x = pos.x + v.x * spread * Math.random();
      e.y = pos.y + v.y * spread * Math.random();
      e.z = pos.z + v.z * spread * Math.random();
      const s = speed * rand(0.3, 1);
      e.vx = v.x * s;
      e.vy = v.y * s;
      e.vz = v.z * s;
      // Burning things mix tongues with rolling balls of flame, so no fire is all cones.
      e.tile = opts.tongues && Math.random() < 0.6 ? 2 : Math.floor(Math.random() * 2);
      e.life = life * rand(0.7, 1.3);
      e.delay = (opts.delay ?? 0) * Math.random();
      e.size0 = size * rand(0.7, 1.2);
      e.size1 = e.size0 * (opts.tongues ? rand(0.5, 0.8) : rand(1.1, 1.6));
      e.alpha = rand(0.4, 0.7);
      this.fireLayer.emit(e);
    }
  }

  /** A single bright glow that is gone in a blink: the heart of a blast or a muzzle. */
  private glow(pos: Vec3, size: number, life: number, color: THREE.Color = HOT.flash): void {
    reset();
    setColors(color, color);
    e.tile = GLOW;
    e.x = pos.x;
    e.y = pos.y;
    e.z = pos.z;
    e.life = life;
    e.size0 = size * 0.6;
    e.size1 = size;
    e.fadeIn = 0.001;
    this.fireLayer.emit(e);
  }

  /** Glowing motes that ride a fire's heat up and wink out. */
  private embers(pos: Vec3, count: number, spread: number, lift: number): void {
    reset();
    setColors(HOT.ember, HOT.fireEdge);
    e.tile = GLOW;
    e.drag = 0.8;
    e.gravity = -lift;
    e.wind = 1.4;
    e.fadeIn = 0.2;
    for (let i = 0; i < count; i++) {
      e.x = pos.x + rand(-spread, spread);
      e.y = pos.y + rand(-spread, spread) * 0.5;
      e.z = pos.z + rand(-spread, spread);
      e.vx = rand(-1, 1);
      e.vy = rand(0.5, 2.5);
      e.vz = rand(-1, 1);
      e.life = rand(1.2, 2.6);
      e.size0 = e.size1 = rand(0.04, 0.09);
      this.sparkLayer.emit(e);
    }
  }

  /** Lumps thrown out of `pos`: they tumble, bounce off what they meet and come to rest. `hot` ones smoke as they fly. */
  private debris(pos: Vec3, normal: Vec3 | null, count: number, speed: number, size: number, color: THREE.Color, hot = 0): void {
    for (let i = 0; i < count; i++) {
      const index = this.nextChunk++ % DEBRIS;
      const c = this.chunks[index];
      scatter(c.vel, normal, normal ? 0.9 : 0.4).multiplyScalar(speed * rand(0.4, 1));
      if (!normal) c.vel.y = Math.abs(c.vel.y) + speed * 0.3;
      c.pos.set(pos.x, pos.y, pos.z);
      if (normal) c.pos.addScaledVector(n3.set(normal.x, normal.y, normal.z), size);
      c.rot.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      c.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      c.spin = rand(6, 16);
      const s = size * rand(0.5, 1.4);
      c.size.set(s * rand(0.6, 1.6), s * rand(0.3, 0.8), s * rand(0.6, 1.4));
      c.age = 0;
      c.rest = -1;
      c.hot = hot * rand(0.6, 1.2);
      c.trail = 0;
      this.debrisMesh.setColorAt(index, col.copy(color).multiplyScalar(rand(0.7, 1.1)));
    }
    this.debrisMesh.instanceColor!.needsUpdate = true;
  }

  // --- Named effects ------------------------------------------------------------

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

  /** Sparks in one colour, all round: a pilot struck, or fire meeting a shield. */
  burst(pos: Vec3, normal: Vec3 | null, count: number, color: string, speed = 5): void {
    col.set(color).multiplyScalar(3);
    col2.set(color).multiplyScalar(0.6);
    this.sparkShower(pos, normal, count, speed, col, col2, 0.03);
  }

  /** A round striking the map: sparks off the surface, a puff of grit and a mark. `heavy` is a mech's cannon. */
  impact(pos: Vec3, normal: Vec3, heavy: boolean): void {
    this.sparkShower(pos, normal, heavy ? 10 : 4, heavy ? 7 : 4.5, HOT.spark, HOT.sparkCool);
    col.setRGB(0.5, 0.47, 0.43);
    this.billow(pos, heavy ? 4 : 1, 0.05, heavy ? 2.4 : 1.5, heavy ? 0.4 : 0.18, heavy ? 4 : 3.2, heavy ? 1.1 : 0.7, col, { normal, alpha: heavy ? 0.6 : 0.45, rise: 0.2 });
    if (heavy) {
      this.glow(v.set(normal.x, normal.y, normal.z).multiplyScalar(0.25).add(pos as THREE.Vector3Like), 0.9, 0.06);
      col.setRGB(0.32, 0.31, 0.3);
      this.debris(pos, normal, 2, 5, 0.06, col);
    }
    this.mark(heavy ? 'crater' : 'bullet', pos, normal, heavy ? 1.2 : 0.3);
  }

  /** A mark on the surface that was hit, turned at random so no two look alike. */
  mark(kind: MarkKind, pos: Vec3, normal: Vec3, size: number): void {
    const M = this.marks[kind];
    v.set(normal.x, normal.y, normal.z);
    q.setFromUnitVectors(Z, v);
    q2.setFromAxisAngle(Z, Math.random() * Math.PI * 2);
    q.multiply(q2);
    const s = size * rand(0.8, 1.2);
    m4.compose(v.multiplyScalar(0.012).add(pos as THREE.Vector3Like), q, scale.set(s, s, 1));
    M.mesh.setMatrixAt(M.next++ % M.mesh.count, m4);
    M.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Light the surroundings for a few frames. */
  flash(pos: THREE.Vector3, strength: number): void {
    const light = this.lights[this.nextLight++ % this.lights.length];
    light.position.copy(pos);
    light.intensity = strength;
  }

  /** A puff of cannon smoke at a mech's muzzle. */
  muzzleSmoke(pos: Vec3, heavy: boolean): void {
    col.setRGB(0.62, 0.6, 0.58);
    this.billow(pos, heavy ? 3 : 1, 0.1, 1.5, heavy ? 0.4 : 0.3, 3.5, heavy ? 1.4 : 0.9, col, { alpha: 0.4, rise: 0.3 });
  }

  /** Steam let out of a hot vent: white, fast to swell, quick to rise and gone in a moment. */
  steam(pos: Vec3, count: number, size = 0.3): void {
    col.setRGB(1, 1, 1);
    this.billow(pos, count, size * 0.3, 1.2, size * 0.5, 4, 0.75, col, { rise: 1.8, alpha: 0.55, wind: 0.6 });
  }

  /**
   * A pilot struck at `pos` by something flying along `dir` (unit): blood from
   * the Corps, dark crude and a few sparks from a Z.E.R.O frame. `damage` is
   * how hard it hit.
   */
  wound(pos: Vec3, dir: Vec3, team: number, damage: number, head: boolean): void {
    this.gore.wound(pos, dir, team, damage, head);
    if (team === 1) this.burst(pos, dir, head ? 8 : 3, '#ff2a3c', 4);
  }

  /**
   * A pilot going down at `chest`, falling toward `back`: a last burst of what
   * they bleed and a pool spreading under them. A Z.E.R.O frame's lights die
   * in sparks and a wisp of smoke.
   */
  downed(chest: Vec3, back: Vec3, team: number): void {
    this.gore.down(chest, back, team);
    if (team !== 1) return;
    this.burst(chest, null, 18, '#ff2a3c', 6);
    col.setRGB(0.12, 0.12, 0.13);
    this.billow(chest, 4, 0.3, 1, 0.4, 3, 1.6, col, { alpha: 0.5 });
  }

  /**
   * A pilot torn apart by a heavy weapon (a mech's guns, a rocket, a mech's
   * weight): `bones` is the body as it stood, `push` (unit) the way the blow
   * came. The Corps go in a red burst of limbs and flesh; a Z.E.R.O frame
   * bursts into its own plates, gears and pistons in a spray of crude, sparks
   * and a crimson flash as its core goes.
   */
  gib(bones: Skeleton, team: number, push: Vec3): void {
    this.gore.gib(bones, team, push);
    if (team !== 1) return;
    const core = bones.chest.getWorldPosition(new THREE.Vector3());
    this.glow(core, 1.8, 0.09, col.set('#ff2a3c').multiplyScalar(2));
    this.sparkShower(core, null, 40, 10, HOT.spark, HOT.sparkCool, 0.03);
    col.setRGB(0.07, 0.07, 0.075);
    this.billow(core, 6, 0.3, 2, 0.5, 3, 1.8, col, { alpha: 0.6, rise: 0.6 });
  }

  /** Dust kicked up from the ground: it rolls outward and settles. `reach` is how far it spreads. */
  dust(pos: Vec3, count: number, reach: number, size: number): void {
    col.setRGB(0.5, 0.46, 0.41);
    this.billow({ x: pos.x, y: pos.y + size * 0.4, z: pos.z }, count, size * 0.5, reach * 2.2, size * 1.2, 3.2, 1.8, col, { flat: true, rise: 0.15, alpha: 0.38 });
  }

  /** Thruster wash: the burn of a dash or a leap, and the dust it throws off the ground. */
  thrust(pos: Vec3, strength: number): void {
    this.flames(pos, Math.round(3 * strength), 0.3, 3, 0.5, 0.18, { rise: 0 });
    this.dust(pos, Math.round(4 * strength), 1.4, 1);
  }

  /**
   * A blast where a rocket or shell burst. `radius` is the simulation's blast
   * radius; the fire fills about half of it, the dust ring reaches its edge.
   * A rocket is a fireball that rolls up into dark smoke, throws grit and leaves
   * a scorch; a flak shell is a hard white crack and a puff of black.
   */
  explosion(pos: Vec3, normal: Vec3 | null, radius: number, flak = false): void {
    const R = radius;
    const ground = normal !== null && normal.y > 0.7;
    this.glow(pos, R * (flak ? 1 : 1.5), flak ? 0.07 : 0.1);
    this.boom.position.set(pos.x, pos.y, pos.z);
    if (normal) this.boom.position.addScaledVector(v.set(normal.x, normal.y, normal.z), 0.6);
    this.boom.intensity = flak ? 35 : 70;
    if (flak) {
      this.flames(pos, 6, R * 0.12, 6, R * 0.32, 0.22, { normal });
      this.sparkShower(pos, normal, 30, 20, HOT.spark, HOT.sparkCool, 0.03);
      col.setRGB(0.07, 0.07, 0.075);
      this.billow(pos, 9, R * 0.15, 4, R * 0.25, 2.6, 2.2, col, { normal, alpha: 0.85, delay: 0.03, rise: 0.2 });
    } else {
      this.flames(pos, 16, R * 0.15, 7, R * 0.42, 0.45, { normal });
      this.flames(pos, 6, R * 0.1, 3, R * 0.3, 0.6, { normal, delay: 0.1, rise: 5 });
      this.sparkShower(pos, normal, 34, 16, HOT.spark, HOT.sparkCool);
      col.setRGB(0.16, 0.15, 0.14);
      this.billow(pos, 12, R * 0.2, 3.5, R * 0.32, 3, 3.2, col, { normal, alpha: 0.8, delay: 0.12, rise: 0.9 });
      this.embers(pos, 8, R * 0.2, 1);
    }
    if (normal) {
      col.setRGB(0.3, 0.29, 0.28);
      this.debris(pos, normal, flak ? 3 : 7, flak ? 7 : 10, flak ? 0.08 : 0.13, col);
      this.mark('scorch', pos, normal, R * (flak ? 1.2 : 1.8));
    }
    if (ground) this.dust(pos, flak ? 6 : 12, R * 0.9, R * 0.3);
  }

  /** A mech coming down from the sky: dust rolls out, grit flies, the ground is scarred, and its zone ring flashes out. */
  mechLand(pos: Vec3, radius: number, zone: string): void {
    this.ring(pos, radius, zone, 0.55);
    this.dust(pos, 22, radius, 1.4);
    this.sparkShower(pos, { x: 0, y: 1, z: 0 }, 30, 12, HOT.spark, HOT.sparkCool);
    col.setRGB(0.32, 0.31, 0.3);
    this.debris(pos, { x: 0, y: 1, z: 0 }, 8, 8, 0.18, col);
    this.mark('scorch', pos, { x: 0, y: 1, z: 0 }, radius * 2.2);
    this.mark('scuff', pos, { x: 0, y: 1, z: 0 }, radius * 3.2);
  }

  /** A footfall: a heavy one scuffs the ground. */
  footfall(pos: Vec3, heavy: boolean): void {
    this.dust(pos, heavy ? 7 : 2, heavy ? 1.6 : 0.8, heavy ? 1.1 : 0.7);
    if (heavy) this.mark('scuff', pos, { x: 0, y: 1, z: 0 }, 3);
  }

  /** The stomp: a shockwave in its side's colour out to its reach, a ring of dust and a cracked footprint. */
  stomp(pos: Vec3, radius: number, zone: string): void {
    this.ring(pos, radius, zone, 0.45);
    this.ring(pos, radius * 0.6, '#ffe2b0', 0.3);
    this.dust(pos, 18, radius * 0.8, 1.3);
    col.setRGB(0.32, 0.31, 0.3);
    this.debris(pos, { x: 0, y: 1, z: 0 }, 5, 6, 0.12, col);
    this.mark('crater', pos, { x: 0, y: 1, z: 0 }, 4.5);
  }

  /**
   * A mech blowing apart at `pos` (its feet): the core goes up in a fireball
   * that keeps feeding itself for a moment, burning pieces of hull fly out
   * trailing smoke, a shockwave runs along the ground and a black column rises.
   * The wreck it leaves burns on through `wreckBurn`.
   */
  mechDeath(pos: Vec3, team: number): void {
    const core = { x: pos.x, y: pos.y + 2.8, z: pos.z };
    const up = { x: 0, y: 1, z: 0 };
    this.glow(core, 16, 0.14);
    this.boom.position.set(core.x, core.y, core.z);
    this.boom.intensity = 140;
    this.flames(core, 16, 1.6, 10, 2.6, 0.6);
    // The second, rolling burst as the reactor goes, and a pillar of fire above it.
    this.flames(core, 12, 2, 6, 3, 0.8, { delay: 0.25 });
    this.flames({ x: core.x, y: core.y + 1.5, z: core.z }, 8, 1, 4, 2.4, 0.9, { delay: 0.2, rise: 9, normal: up });
    this.sparkShower(core, null, 80, 22, HOT.spark, HOT.sparkCool, 0.045);
    col.setRGB(0.09, 0.085, 0.08);
    this.billow(core, 24, 2, 4, 2.2, 2.6, 5, col, { delay: 0.35, rise: 1.4, alpha: 0.85 });
    this.billow({ x: core.x, y: core.y + 2, z: core.z }, 10, 1, 2, 2.5, 2.2, 6, col, { delay: 0.8, rise: 2.5, alpha: 0.8 });
    this.embers(core, 24, 1.5, 1.5);
    // Scorched plates of its own paint, half of them burning as they fly.
    col2.set(FINISH[team].paint).multiplyScalar(0.55);
    this.debris(core, null, 7, 14, 0.5, col2, 2);
    this.debris(core, null, 7, 12, 0.4, col2);
    col.setRGB(0.3, 0.29, 0.28);
    this.debris(pos, up, 6, 8, 0.15, col);
    this.ring(pos, 10, '#ffb066', 0.6);
    this.dust(pos, 24, 9, 1.8);
    this.mark('scorch', pos, up, 16);
  }

  /**
   * Smoke from a failing hull at its vent. Past half its hull a mech trails
   * grey smoke; past three quarters it pours black smoke, licks of fire and
   * the odd spark. `damage` is the share of the hull lost.
   */
  hullSmoke(pos: Vec3, damage: number, dt: number): void {
    if (damage < 0.5) return;
    const bad = damage >= 0.75;
    const puffs = Math.floor((bad ? 10 : 4) * dt + Math.random());
    col.setRGB(bad ? 0.09 : 0.34, bad ? 0.085 : 0.33, bad ? 0.08 : 0.32);
    this.billow(pos, puffs, 0.2, 0.8, bad ? 0.7 : 0.5, bad ? 5 : 4, bad ? 3 : 2, col, { rise: 2.2, alpha: bad ? 0.8 : 0.5 });
    if (!bad) return;
    this.flames(pos, Math.floor(8 * dt + Math.random()), 0.15, 0.8, 0.6, 0.35, { rise: 4, tongues: true });
    if (Math.random() < dt * 1.2) this.sparkShower(pos, null, 8, 5, HOT.spark, HOT.sparkCool);
  }

  /**
   * A destroyed mech burning out. `points` are where its fires sit (the first
   * `count` of them), `heat` 1 while it is fully ablaze and falling to 0 as it
   * dies down to smouldering. Returns where something in it cooked off this
   * frame (a pop of fire and sparks), so the game can play the bang, else null.
   */
  wreckBurn(points: THREE.Vector3[], count: number, heat: number, dt: number): THREE.Vector3 | null {
    if (heat <= 0) return null;
    const flaming = Math.max(0, (heat - 0.25) / 0.75);
    for (let i = 0; i < count; i++) {
      const p = points[i];
      const big = i === 0 ? 1.4 : 1;
      if (flaming > 0) {
        this.flames(p, Math.floor(22 * flaming * big * dt + Math.random()), 0.4, 0.8, (0.9 + 1.1 * flaming) * big, 0.7, { rise: 5, tongues: true });
      }
      // A thick black column while it burns, thinning to grey wisps as it smoulders.
      const k = 0.08 + (1 - heat) * 0.3;
      col.setRGB(k, k * 0.96, k * 0.92);
      this.billow(p, Math.floor((2 + 5 * heat) * big * dt + Math.random()), 0.3, 0.6, 0.9 * big, 4.5, 6, col, { rise: 2.2, alpha: 0.5 + 0.35 * heat, delay: 0.1 });
      if (flaming > 0 && Math.random() < 6 * flaming * dt) this.embers(p, 1, 0.5, 1.6);
    }
    if (flaming > 0 && count > 0) {
      const p = points[0];
      const flicker = 0.75 + 0.25 * Math.sin(this.time * 23) * Math.sin(this.time * 7.3);
      const strength = 12 * flaming * flicker;
      if (strength > this.fireHeat) {
        this.fireHeat = strength;
        this.fireLight.position.set(p.x, p.y + 1.2, p.z);
      }
    }
    // Ammunition and fuel going up in the heat.
    if (heat > 0.6 && Math.random() < dt * 0.7 * heat) {
      const p = points[Math.floor(Math.random() * count)];
      this.glow(p, 3, 0.08);
      this.flames(p, 6, 0.3, 5, 0.8, 0.35);
      this.sparkShower(p, null, 24, 12, HOT.spark, HOT.sparkCool);
      this.boom.position.copy(p);
      this.boom.intensity = Math.max(this.boom.intensity, 25);
      return p;
    }
    return null;
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
   * A rocket in flight. It is flown here from the launch data, frame by frame,
   * and removed by `endRocket` when the simulation says it burst. `seenFrom` is
   * where the viewer sees it leave (a muzzle), when that differs from where it
   * really starts. `small` is a flak shell: a third the size, and no smoke trail.
   */
  rocket(id: number, from: Vec3, dir: Vec3, speed: number, life: number, seenFrom: THREE.Vector3 | null, small = false): void {
    let r = this.rockets.find((x) => x.id < 0);
    if (!r) r = this.rockets[0];
    r.id = id;
    r.pos.set(from.x, from.y, from.z);
    r.dir.set(dir.x, dir.y, dir.z);
    r.speed = speed;
    r.life = life;
    r.small = small;
    r.mesh.scale.setScalar(small ? 0.35 : 1);
    // The exhaust starts a few meters out, so a launch does not fog the shooter's own view.
    r.trail = -4;
    r.glow = 0;
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
    this.smokeLayer.clear();
    this.fireLayer.clear();
    this.sparkLayer.clear();
    this.gore.clear();
    for (const c of this.chunks) c.age = -1;
    for (const r of this.rockets) {
      r.id = -1;
      r.mesh.visible = false;
    }
    for (const b of this.rings) {
      b.life = 0;
      b.mesh.visible = false;
    }
    for (const mesh of [this.debrisMesh, ...Object.values(this.marks).map((m) => m.mesh)]) {
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, HIDDEN);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.boom.intensity = 0;
    this.fireLight.intensity = 0;
  }

  // --- Each frame ---------------------------------------------------------------

  /** Move everything on by `dt`; `camera` is the view it is drawn for (smoke is sorted for it). */
  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    this.updateLight();
    this.updateTracers(dt);
    this.updateRockets(dt);
    this.updateDebris(dt);
    this.smokeLayer.update(dt, camera, WIND_X, WIND_Z);
    this.fireLayer.update(dt, camera, WIND_X, WIND_Z);
    this.sparkLayer.update(dt, camera, WIND_X, WIND_Z);
    this.gore.update(dt, camera, WIND_X, WIND_Z);

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
    // Burning wrecks claim the fire light again each frame; with none it goes out.
    this.fireLight.intensity = this.fireHeat;
    this.fireHeat = 0;
  }

  /** Smoke is lit by the map's own sky and sun: bright on top, the ground's bounce underneath. */
  private updateLight(): void {
    const { hemi, sun } = this.env;
    this.lit.copy(hemi.color).multiplyScalar(hemi.intensity).add(col.copy(sun.color).multiplyScalar(sun.intensity * 0.8)).multiplyScalar(1 / Math.PI);
    this.shade.copy(hemi.groundColor).add(hemi.color).multiplyScalar((hemi.intensity * 0.5) / Math.PI);
    this.smokeLayer.setLight(this.lit, this.shade);
    this.gore.setLight(this.lit, this.shade);
  }

  private updateTracers(dt: number): void {
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
  }

  private updateRockets(dt: number): void {
    for (const r of this.rockets) {
      if (r.id < 0) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.id = -1;
        r.mesh.visible = false;
        continue;
      }
      const step = r.speed * dt;
      r.pos.addScaledVector(r.dir, step);
      r.offset.multiplyScalar(Math.exp(-dt * 9));
      r.mesh.position.copy(r.pos).add(r.offset);
      // A glow at the motor every half meter, so the flame reads at any frame rate.
      r.glow += step;
      while (r.glow > (r.small ? 1.2 : 0.5)) {
        r.glow -= r.small ? 1.2 : 0.5;
        v.copy(r.mesh.position).addScaledVector(r.dir, (r.small ? -0.3 : -0.9) - r.glow);
        reset();
        e.tile = GLOW;
        setColors(HOT.spark, HOT.fireEdge);
        e.x = v.x;
        e.y = v.y;
        e.z = v.z;
        e.life = r.small ? 0.07 : 0.12;
        e.size0 = r.small ? 0.25 : 0.7;
        e.size1 = 0.1;
        e.fadeIn = 0.001;
        this.fireLayer.emit(e);
      }
      // Exhaust smoke every meter and a quarter, which hangs in the air behind it.
      if (r.small) continue;
      r.trail += step;
      while (r.trail > 1.25) {
        r.trail -= 1.25;
        v.copy(r.mesh.position).addScaledVector(r.dir, -1 - r.trail);
        col.setRGB(0.7, 0.69, 0.67);
        this.billow(v, 1, 0.05, 0.4, 0.35, 4, 2, col, { alpha: 0.5, rise: 0.25, wind: 0.8 });
      }
    }
  }

  /** Debris flies, tumbles, glances off what it meets (cast each frame, so it never passes through a wall) and settles. */
  private updateDebris(dt: number): void {
    const mesh = this.debrisMesh;
    let touched = false;
    for (let i = 0; i < DEBRIS; i++) {
      const c = this.chunks[i];
      if (c.age < 0) continue;
      touched = true;
      c.age += dt;
      if (c.rest >= 0) {
        c.rest += dt;
        if (c.rest > DEBRIS_REST + DEBRIS_FADE) {
          c.age = -1;
          mesh.setMatrixAt(i, HIDDEN);
          continue;
        }
      } else {
        c.vel.y -= 18 * dt;
        const speed = c.vel.length();
        const step = speed * dt;
        let hit: { dist: number; normal: Vec3 } | null = null;
        if (this.surfaces && step > 1e-4) {
          ray.o.x = c.pos.x;
          ray.o.y = c.pos.y;
          ray.o.z = c.pos.z;
          ray.d.x = c.vel.x / speed;
          ray.d.y = c.vel.y / speed;
          ray.d.z = c.vel.z / speed;
          hit = this.surfaces.castRay(ray.o, ray.d, step + 0.05);
        }
        if (hit) {
          const n = hit.normal;
          c.pos.addScaledVector(c.vel, Math.max(0, hit.dist - 0.03) / speed);
          // Glance off: lose most of the speed into the surface and some along it.
          const into = c.vel.x * n.x + c.vel.y * n.y + c.vel.z * n.z;
          c.vel.x = (c.vel.x - 1.4 * into * n.x) * 0.55;
          c.vel.y = (c.vel.y - 1.4 * into * n.y) * 0.55;
          c.vel.z = (c.vel.z - 1.4 * into * n.z) * 0.55;
          c.spin *= 0.6;
          if (n.y > 0.6 && c.vel.length() < 1.6) {
            c.rest = 0;
            c.vel.set(0, 0, 0);
          }
        } else {
          c.pos.addScaledVector(c.vel, dt);
          // Nothing to land on in reach (or no map): it falls away out of sight.
          if (c.pos.y < -60) c.rest = DEBRIS_REST;
        }
        q.setFromAxisAngle(c.axis, c.spin * dt);
        c.rot.premultiply(q);
      }
      // A burning piece trails smoke while it flies (a puff every 0.7 m, so the
      // trail is one ribbon at any speed) and burns a moment longer where it lands.
      if (c.hot > 0) {
        c.hot -= dt;
        c.trail += c.rest < 0 ? c.vel.length() * dt : dt * 2;
        if (c.trail > 0.7) {
          c.trail = 0;
          col.setRGB(0.1, 0.095, 0.09);
          this.billow(c.pos, 1, 0.05, 0.3, 0.6, 3.5, 1.6, col, { alpha: 0.45, rise: 1 });
        }
        if (Math.random() < 20 * dt) this.flames(c.pos, 1, 0.05, 0.5, 0.7 * Math.min(1, c.hot), 0.25, { rise: 2 });
      }
      const sink = c.rest > DEBRIS_REST ? 1 - (c.rest - DEBRIS_REST) / DEBRIS_FADE : 1;
      m4.compose(c.pos, c.rot, scale.copy(c.size).multiplyScalar(Math.max(0.001, sink)));
      mesh.setMatrixAt(i, m4);
    }
    if (touched) mesh.instanceMatrix.needsUpdate = true;
  }
}
