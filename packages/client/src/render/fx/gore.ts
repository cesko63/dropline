import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '@dropline/shared';
import { BONES, type BoneName, type Skeleton } from '../pilot/rig';
import { suitKit } from '../pilot/suits';
import { ParticleLayer, emitTemplate, rand, scatter, type Emit } from './particles';
import { floorBelow, type Surfaces } from './surfaces';
import { dropAtlas, stainAtlas } from './textures';

const DROPS = 1200;
/** Torn-apart pilots each side can have in the world at once; one more reuses the oldest. */
const BODIES = 2;
/** Seconds a piece lies where it came to rest, and how long it takes to sink away. */
const PIECE_REST = 10;
const PIECE_FADE = 1;
/** Pools that can be spreading at once. */
const SPREADS = 24;
/** Pools one torn-apart body leaves where its pieces land, beside the one under it. */
const POOLS_PER_BODY = 4;

/** Tiles of the drop atlas. */
const DROP = 0;
const CLUSTER = 1;
const MIST = 2;
const CLOT = 3;

/**
 * What runs out of a pilot, by team. The Corps bleed: dark red, wet. A Z.E.R.O
 * frame runs on a dark crude: near black, with an oily sheen where it lies.
 * `drop` and `mist` are linear colours for the particles (lit by the sky like
 * smoke); `stain` is what it leaves on the world.
 */
export const FLUIDS = [
  { drop: new THREE.Color(0.3, 0.012, 0.01), mist: new THREE.Color(0.2, 0.014, 0.012), stain: '#4a0505', roughness: 0.3, metalness: 0 },
  { drop: new THREE.Color(0.024, 0.016, 0.009), mist: new THREE.Color(0.035, 0.028, 0.022), stain: '#140d06', roughness: 0.06, metalness: 0.25 },
];

/** The stains a wound leaves, with how many of each fluid the world keeps (the oldest goes first). */
const STAINS = {
  splat: { tile: 0, count: 64 },
  pool: { tile: 1, count: 24 },
  spray: { tile: 2, count: 64 },
  drops: { tile: 3, count: 64 },
} as const;
type StainKind = keyof typeof STAINS;

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const v = new THREE.Vector3();
const v2 = new THREE.Vector3();
const n3 = new THREE.Vector3();
const cr = new THREE.Vector3();
/** Where the last cast met the map. */
const at = new THREE.Vector3();
const scale = new THREE.Vector3();
const ray = { o: { x: 0, y: 0, z: 0 }, d: { x: 0, y: 0, z: 0 } };
const e: Emit = emitTemplate();

/** A pool slowly spreading to its full size. */
interface Spread {
  mesh: THREE.InstancedMesh | null;
  index: number;
  pos: THREE.Vector3;
  rot: THREE.Quaternion;
  size: number;
  /** Seconds since it started; negative while it waits. */
  t: number;
  time: number;
}

/** One torn-apart pilot's set of pieces, reused. */
interface Body {
  team: number;
  pieces: Piece[];
  /** Pools its pieces have left so far. */
  pools: number;
}

interface Piece {
  obj: THREE.Object3D;
  owner: Body;
  /** The pilot's bone it was, or null for a loose lump or part. */
  bone: BoneName | null;
  /** Middle of the piece in its own space: it tumbles round this. */
  center: THREE.Vector3;
  /** Half its smallest width at scale 1: how close it lies to what it meets. */
  radius: number;
  /** A loose piece's size range and whether it is a lump (null for a limb: drawn as it was). */
  loose: Extra | null;
  scale: THREE.Vector3;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Quaternion;
  axis: THREE.Vector3;
  spin: number;
  /** Seconds since thrown; < 0 when unused. */
  age: number;
  /** Seconds it has lain still; -1 while it still moves. */
  rest: number;
  /** Seconds it still bleeds. */
  bleed: number;
  /** Meters flown since its last drop. */
  trail: number;
  /** It has already left a splat where it struck. */
  struck: boolean;
}

/** Loose parts of a torn-apart pilot beyond their limbs: geometry and material, built once. */
interface Extra {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  /** How many go flying, and the size range they are drawn at. */
  count: number;
  size: [number, number];
  /** A lump of flesh: squashed out of shape, each one its own. */
  lump?: boolean;
}

function gear(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.05, 0.05, 0.02, 12)];
  for (let i = 0; i < 9; i++) {
    const tooth = new THREE.BoxGeometry(0.02, 0.02, 0.016);
    tooth.translate(0.057, 0, 0);
    tooth.rotateY((i / 9) * Math.PI * 2);
    parts.push(tooth);
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
}

function piston(): THREE.BufferGeometry {
  const barrel = new THREE.CylinderGeometry(0.022, 0.022, 0.12, 8);
  const rod = new THREE.CylinderGeometry(0.01, 0.01, 0.12, 6);
  rod.translate(0, 0.1, 0);
  return mergeGeometries([barrel.toNonIndexed(), rod.toNonIndexed()])!;
}

/** The Corps tear into flesh and bone; a Z.E.R.O frame into gears, nuts, pistons, cables and plate. */
function extras(team: number): Extra[] {
  const flat = { flatShading: true };
  if (team === 0) {
    return [
      { geo: new THREE.DodecahedronGeometry(1, 0), mat: new THREE.MeshStandardMaterial({ color: '#4e0b08', roughness: 0.35, ...flat }), count: 10, size: [0.05, 0.12], lump: true },
      { geo: new THREE.DodecahedronGeometry(1, 0), mat: new THREE.MeshStandardMaterial({ color: '#6a2a22', roughness: 0.5, ...flat }), count: 4, size: [0.04, 0.08], lump: true },
      { geo: new THREE.CylinderGeometry(0.012, 0.008, 0.16, 5), mat: new THREE.MeshStandardMaterial({ color: '#d6ccb4', roughness: 0.6, ...flat }), count: 3, size: [0.8, 1.3] },
    ];
  }
  const steel = new THREE.MeshStandardMaterial({ color: '#5e6268', roughness: 0.3, metalness: 0.85, ...flat });
  const brass = new THREE.MeshStandardMaterial({ color: '#6b5532', roughness: 0.4, metalness: 0.9, ...flat });
  const black = new THREE.MeshStandardMaterial({ color: '#121316', roughness: 0.55, metalness: 0.5, ...flat });
  return [
    { geo: gear(), mat: brass, count: 3, size: [1, 1.8] },
    { geo: gear(), mat: steel, count: 3, size: [0.7, 1.3] },
    { geo: new THREE.CylinderGeometry(0.02, 0.02, 0.016, 6), mat: steel, count: 5, size: [0.7, 1.4] },
    { geo: piston(), mat: steel, count: 3, size: [1, 1.5] },
    { geo: new THREE.CylinderGeometry(0.008, 0.008, 0.32, 5), mat: black, count: 3, size: [0.7, 1.2] },
    { geo: new THREE.BoxGeometry(0.15, 0.012, 0.09), mat: black, count: 3, size: [0.6, 1.2] },
  ];
}

/**
 * Blood and what it comes out of. The Corps bleed red; Z.E.R.O frames leak a
 * dark crude and come apart in machine parts. Drops and mist are one pooled
 * sprite batch, lit by the sky; stains (sprays on walls, drops and pools on the
 * floor) are wet decals; a pilot torn apart by a heavy weapon becomes their own
 * limbs (the suit's parts, from where each bone was) and loose lumps or parts,
 * which tumble, bleed as they fly, splat where they strike and come to rest.
 */
export class Gore {
  private readonly layer: ParticleLayer;
  /** By fluid, then kind. */
  private readonly stains: Record<StainKind, { mesh: THREE.InstancedMesh; next: number }>[] = [];
  private readonly spreads: Spread[] = [];
  private readonly bodies: Body[][] = [[], []];
  private readonly nextBody = [0, 0];
  private nextSpread = 0;

  constructor(
    scene: THREE.Scene,
    private readonly surfaces: Surfaces | null,
    /** Sparks off a torn machine part. */
    private readonly spark: (pos: Vec3) => void,
  ) {
    this.layer = new ParticleLayer({ capacity: DROPS, map: dropAtlas(), additive: false, sorted: true, nearFade: [0.15, 0.6] });
    scene.add(this.layer.mesh);

    const atlas = stainAtlas();
    for (const fluid of FLUIDS) {
      const set = {} as Record<StainKind, { mesh: THREE.InstancedMesh; next: number }>;
      const mat = new THREE.MeshStandardMaterial({
        color: fluid.stain,
        roughness: fluid.roughness,
        metalness: fluid.metalness,
        alphaMap: atlas,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      for (const kind of Object.keys(STAINS) as StainKind[]) {
        const S = STAINS[kind];
        const geo = new THREE.PlaneGeometry(1, 1);
        // This kind's tile of the atlas.
        const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + (S.tile % 2)) * 0.5, (uv.getY(i) + 1 - Math.floor(S.tile / 2)) * 0.5);
        const mesh = new THREE.InstancedMesh(geo, mat, S.count);
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        for (let i = 0; i < S.count; i++) mesh.setMatrixAt(i, HIDDEN);
        scene.add(mesh);
        set[kind] = { mesh, next: 0 };
      }
      this.stains.push(set);
    }
    for (let i = 0; i < SPREADS; i++) this.spreads.push({ mesh: null, index: 0, pos: new THREE.Vector3(), rot: new THREE.Quaternion(), size: 1, t: 0, time: 1 });

    for (const team of [0, 1]) {
      const loose = extras(team);
      for (let b = 0; b < BODIES; b++) {
        const body = this.buildBody(team, loose);
        for (const p of body.pieces) scene.add(p.obj);
        this.bodies[team].push(body);
      }
    }
  }

  /** The suit's own parts, one per bone, in a material that has seen the inside of them, and the loose bits. */
  private buildBody(team: number, loose: Extra[]): Body {
    const kit = suitKit(team);
    const skin = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: kit.roughness,
      metalness: kit.metalness,
      color: team === 0 ? '#b08a84' : '#77736f',
    });
    const dead = new THREE.MeshStandardMaterial({ color: team === 0 ? '#16303c' : '#3a0608', roughness: 0.4, flatShading: true });
    const body: Body = { team, pieces: [], pools: 0 };
    const add = (obj: THREE.Object3D, bone: BoneName | null, geo: THREE.BufferGeometry, loose: Extra | null): void => {
      geo.computeBoundingBox();
      const box = geo.boundingBox!;
      const size = box.getSize(new THREE.Vector3());
      obj.visible = false;
      obj.matrixAutoUpdate = true;
      body.pieces.push({
        obj, owner: body, bone, loose,
        center: box.getCenter(new THREE.Vector3()),
        radius: Math.max(0.01, Math.min(size.x, size.y, size.z) / 2),
        scale: new THREE.Vector3(1, 1, 1),
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Quaternion(), axis: new THREE.Vector3(),
        spin: 0, age: -1, rest: -1, bleed: 0, trail: 0, struck: false,
      });
    };
    for (const name of BONES) {
      const parts = kit.bones[name];
      if (!parts?.body) continue;
      const obj = new THREE.Group();
      const mesh = new THREE.Mesh(parts.body, skin);
      mesh.castShadow = true;
      obj.add(mesh);
      if (parts.glow) obj.add(new THREE.Mesh(parts.glow, dead));
      add(obj, name, parts.body, null);
    }
    for (const x of loose) {
      for (let i = 0; i < x.count; i++) {
        const mesh = new THREE.Mesh(x.geo, x.mat);
        mesh.castShadow = true;
        add(mesh, null, x.geo, x);
      }
    }
    return body;
  }

  /** Drops alive and pieces in the world: the effects page's readout. */
  get counts(): { drops: number; pieces: number } {
    let pieces = 0;
    for (const side of this.bodies) for (const b of side) for (const p of b.pieces) if (p.age >= 0) pieces++;
    return { drops: this.layer.live, pieces };
  }

  setLight(lit: THREE.Color, shade: THREE.Color): void {
    this.layer.setLight(lit, shade);
  }

  // --- Building blocks ----------------------------------------------------------

  private fluid(team: number): number {
    return team === 1 ? 1 : 0;
  }

  /** Drops flung from `pos` along `dir` (or all round), opening into a cone of width `cone`. They fall, and stop dead on the floor. */
  private drops(pos: Vec3, dir: Vec3 | null, fluid: number, count: number, speed: number, cone: number, size: number, tile = DROP): void {
    if (count <= 0) return;
    const c = FLUIDS[fluid].drop;
    e.r0 = e.r1 = c.r;
    e.g0 = e.g1 = c.g;
    e.b0 = e.b1 = c.b;
    e.delay = 0;
    e.fadeIn = 0.001;
    e.drag = 0.5;
    e.gravity = 9.8;
    e.wind = 0;
    e.spin = tile === CLOT ? 6 : 0;
    e.upright = false;
    e.stretch = tile === CLOT ? 0 : 0.022;
    e.floor = floorBelow(this.surfaces, pos.x, pos.y, pos.z);
    e.bounce = 0;
    e.hover = 0;
    e.alpha = 1;
    for (let i = 0; i < count; i++) {
      scatter(v, null, 0);
      if (dir) v.multiplyScalar(cone).add(n3.set(dir.x, dir.y, dir.z)).normalize();
      v.multiplyScalar(speed * rand(0.35, 1.15));
      e.x = pos.x;
      e.y = pos.y;
      e.z = pos.z;
      e.vx = v.x;
      e.vy = v.y;
      e.vz = v.z;
      e.life = rand(0.6, 1.2);
      e.tile = tile === DROP && Math.random() < 0.25 ? CLUSTER : tile;
      e.size0 = size * rand(0.6, 1.4);
      e.size1 = e.size0 * 0.8;
      this.layer.emit(e);
    }
  }

  /** A cloud of fine spray that bursts out of `pos`, hangs a moment and sinks. */
  private mist(pos: Vec3, dir: Vec3 | null, fluid: number, count: number, size: number, life: number): void {
    const c = FLUIDS[fluid].mist;
    e.r0 = e.r1 = c.r;
    e.g0 = e.g1 = c.g;
    e.b0 = e.b1 = c.b;
    e.delay = 0;
    e.fadeIn = 0.04;
    e.drag = 4;
    e.gravity = 0.6;
    e.wind = 0.4;
    e.spin = 0.6;
    e.upright = false;
    e.stretch = 0;
    e.bounce = -1;
    e.hover = 0;
    e.tile = MIST;
    for (let i = 0; i < count; i++) {
      scatter(v, null, 0);
      if (dir) v.multiplyScalar(0.6).add(n3.set(dir.x, dir.y, dir.z));
      v.multiplyScalar(rand(0.8, 2.6));
      e.x = pos.x;
      e.y = pos.y;
      e.z = pos.z;
      e.vx = v.x;
      e.vy = v.y;
      e.vz = v.z;
      e.life = life * rand(0.7, 1.3);
      e.size0 = size * rand(0.4, 0.7);
      e.size1 = size * rand(1.5, 2.2);
      e.alpha = rand(0.3, 0.45);
      this.layer.emit(e);
    }
  }

  /** The burst where a round strikes: a dense puff that blooms out toward the shooter and is gone in a moment. */
  private puff(pos: Vec3, dir: Vec3, fluid: number, count: number, size: number): void {
    const c = FLUIDS[fluid].drop;
    e.r0 = e.r1 = c.r * 1.5;
    e.g0 = e.g1 = c.g * 1.5;
    e.b0 = e.b1 = c.b * 1.5;
    e.delay = 0;
    e.fadeIn = 0.02;
    e.drag = 8;
    e.gravity = 0.4;
    e.wind = 0;
    e.spin = 1;
    e.upright = false;
    e.stretch = 0;
    e.bounce = -1;
    e.hover = 0;
    e.tile = MIST;
    for (let i = 0; i < count; i++) {
      scatter(v, null, 0);
      v.multiplyScalar(0.6).addScaledVector(n3.set(dir.x, dir.y, dir.z), -0.8).multiplyScalar(rand(0.8, 1.6));
      e.x = pos.x;
      e.y = pos.y;
      e.z = pos.z;
      e.vx = v.x;
      e.vy = v.y;
      e.vz = v.z;
      e.life = rand(0.22, 0.35);
      e.size0 = size * rand(0.35, 0.5);
      e.size1 = size * rand(1.6, 2);
      e.alpha = rand(0.75, 0.9);
      this.layer.emit(e);
    }
  }

  /**
   * A stain on the surface at `pos`, facing `normal`. `along` lays a spray out
   * the way it flew; else it is turned at random. A `grow` of more than 0 is a
   * pool that spreads to `size` over that many seconds, after `delay`.
   */
  private stain(kind: StainKind, fluid: number, pos: Vec3, normal: Vec3, size: number, along: Vec3 | null = null, grow = 0, delay = 0): void {
    const S = this.stains[fluid][kind];
    const index = S.next++ % S.mesh.count;
    n3.set(normal.x, normal.y, normal.z);
    q.setFromUnitVectors(Z, n3);
    let angle = Math.random() * Math.PI * 2;
    if (along) {
      // Turn the tile's +U onto the shot's line across the surface.
      v.set(along.x, along.y, along.z).addScaledVector(n3, -(along.x * n3.x + along.y * n3.y + along.z * n3.z));
      if (v.lengthSq() > 1e-4) {
        v2.copy(X).applyQuaternion(q);
        angle = Math.atan2(cr.crossVectors(v2, v).dot(n3), v2.dot(v));
      }
    }
    q.multiply(q2.setFromAxisAngle(Z, angle));
    v.copy(n3).multiplyScalar(0.014).add(pos as THREE.Vector3Like);
    // A slot taken over stops spreading as the pool it was.
    for (const s of this.spreads) if (s.mesh === S.mesh && s.index === index) s.mesh = null;
    if (grow > 0) {
      const s = this.spreads[this.nextSpread++ % SPREADS];
      s.mesh = S.mesh;
      s.index = index;
      s.pos.copy(v);
      s.rot.copy(q);
      s.size = size;
      s.t = -delay;
      s.time = grow;
      S.mesh.setMatrixAt(index, HIDDEN);
    } else {
      const k = size * rand(0.85, 1.15);
      S.mesh.setMatrixAt(index, m4.compose(v, q, scale.set(k, k, 1)));
    }
    S.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Where a ray from `pos` along `dir` meets the map within `reach` (the point is left in `at`); null if it does not. */
  private cast(pos: Vec3, dir: Vec3, reach: number): { dist: number; normal: Vec3 } | null {
    if (!this.surfaces) return null;
    ray.o.x = pos.x;
    ray.o.y = pos.y;
    ray.o.z = pos.z;
    ray.d.x = dir.x;
    ray.d.y = dir.y;
    ray.d.z = dir.z;
    const hit = this.surfaces.castRay(ray.o, ray.d, reach);
    if (hit) at.set(pos.x + dir.x * hit.dist, pos.y + dir.y * hit.dist, pos.z + dir.z * hit.dist);
    return hit;
  }

  /** A pool spreading out on the floor under `pos`, if there is floor close enough below. */
  private poolBelow(pos: Vec3, fluid: number, size: number, grow: number, delay: number): boolean {
    const floor = floorBelow(this.surfaces, pos.x, pos.y, pos.z);
    if (pos.y - floor > 2.6) return false;
    this.stain('pool', fluid, at.set(pos.x, floor, pos.z), UP, size, null, grow, delay);
    return true;
  }

  // --- Named effects ------------------------------------------------------------

  /**
   * A pilot struck at `pos` by something travelling along `dir` (unit). Drops
   * burst out of the far side and a few back toward the shooter, a puff of mist
   * hangs where it struck, and what flies on stains the wall behind and the
   * floor below. `damage` sets how much: a scattergun pellet bleeds a little,
   * a marksman round a lot; a headshot always sprays.
   */
  wound(pos: Vec3, dir: Vec3, team: number, damage: number, head: boolean): void {
    const fluid = this.fluid(team);
    const s = Math.min(1.2, Math.max(0.15, damage / 45)) * (head ? 1.4 : 1);
    this.drops(pos, dir, fluid, Math.round(4 + 14 * s), 3 + 4 * s, 0.45, 0.035);
    // A splash back out of the wound and round the body, on the shooter's side.
    this.drops(pos, { x: -dir.x, y: -dir.y + 0.4, z: -dir.z }, fluid, Math.round(3 + 7 * s), 2.4, 1.1, 0.032);
    this.puff(pos, dir, fluid, head ? 3 : 2, 0.2 + 0.2 * s);
    this.mist(pos, dir, fluid, Math.round(1 + 2 * s) + (head ? 2 : 0), 0.14 + 0.12 * s, 0.45);
    if (s > 0.6) this.drops(pos, dir, fluid, 2, 3, 0.6, 0.05, CLOT);
    // The wall behind takes a spray laid along the shot, wider the further it flew.
    if (Math.random() < 0.25 + s) {
      const hit = this.cast(pos, dir, 3.5);
      if (hit) this.stain('spray', fluid, at, hit.normal, (0.35 + hit.dist * 0.22) * (0.7 + 0.4 * s), dir);
    }
    // And drops land on the floor a little way past them.
    if (Math.random() < 0.2 + 0.6 * s) {
      const k = rand(0.2, 1);
      const x = pos.x + dir.x * k;
      const z = pos.z + dir.z * k;
      const floor = floorBelow(this.surfaces, x, pos.y, z);
      if (pos.y - floor < 2.6) this.stain('drops', fluid, at.set(x, floor, z), UP, rand(0.3, 0.6) * (0.6 + 0.5 * s));
    }
  }

  /** A pilot going down at `chest`: a last burst, and a pool that spreads where the body lies (`back` is the way it falls). */
  down(chest: Vec3, back: Vec3, team: number): void {
    const fluid = this.fluid(team);
    this.drops(chest, UP, fluid, 14, 3, 1.2, 0.04);
    this.mist(chest, null, fluid, 3, 0.3, 0.6);
    this.poolBelow(v.set(chest.x + back.x * 0.9, chest.y, chest.z + back.z * 0.9), fluid, rand(1.2, 1.6), 3.5, 0.6);
  }

  /**
   * A pilot torn apart by a heavy weapon: every limb of `bones` (the body as it
   * stood) flies apart from the hips, pushed along `push` (unit), with loose
   * lumps or machine parts, in a burst of drops and mist. What flies stains
   * everything round, and a pool spreads where they stood.
   */
  gib(bones: Skeleton, team: number, push: Vec3, power = 1): void {
    const fluid = this.fluid(team);
    const side = team === 1 ? 1 : 0;
    const body = this.bodies[side][this.nextBody[side]++ % BODIES];
    body.pools = 0;
    const center = bones.hips.getWorldPosition(new THREE.Vector3());
    const pushY = Math.max(0, push.y);
    for (const p of body.pieces) {
      if (p.bone) {
        bones[p.bone].matrixWorld.decompose(v, p.rot, scale);
        p.scale.set(1, 1, 1);
        p.pos.copy(p.center).applyQuaternion(p.rot).add(v);
      } else {
        const x = p.loose!;
        p.rot.random();
        const k = rand(x.size[0], x.size[1]);
        if (x.lump) p.scale.set(k * rand(0.7, 1.4), k * rand(0.5, 1), k * rand(0.7, 1.4));
        else p.scale.setScalar(k);
        p.pos.set(center.x + rand(-0.2, 0.2), center.y + rand(-0.3, 0.6), center.z + rand(-0.2, 0.2));
      }
      v.copy(p.pos).sub(center);
      if (v.lengthSq() < 1e-4) scatter(v, null, 0);
      v.normalize();
      p.vel.copy(v).multiplyScalar(rand(2.5, 6.5) * power);
      p.vel.x += push.x * rand(3, 8) * power;
      p.vel.y += pushY * rand(3, 8) * power + rand(2, 5) * power;
      p.vel.z += push.z * rand(3, 8) * power;
      p.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      p.spin = rand(4, 14);
      p.age = 0;
      p.rest = -1;
      p.bleed = p.bone ? rand(1.5, 3) : team === 1 ? rand(0.3, 0.8) : rand(0.8, 1.8);
      p.trail = 0;
      p.struck = false;
      p.obj.visible = true;
      this.place(p, 1);
    }
    // The burst itself, and what it throws on everything round.
    this.drops(center, null, fluid, 70, 7, 1, 0.045);
    this.drops(center, push, fluid, 30, 9, 0.5, 0.04);
    this.drops(center, null, fluid, 12, 6, 1, 0.06, CLOT);
    this.mist(center, null, fluid, team === 1 ? 8 : 12, 0.55, 0.9);
    for (let i = 0; i < 12; i++) {
      scatter(n3, push, 0.5);
      if (i < 4) n3.y = -Math.abs(n3.y) - 0.3;
      n3.normalize();
      const d = { x: n3.x, y: n3.y, z: n3.z };
      const hit = this.cast(center, d, 6);
      if (hit) this.stain(hit.normal.y > 0.6 ? 'splat' : 'spray', fluid, at, hit.normal, 0.5 + hit.dist * 0.25, d);
    }
    this.poolBelow(center, fluid, rand(1.6, 2.1), 2.5, 0.2);
  }

  /** Remove every drop, stain and piece (new match). */
  clear(): void {
    this.layer.clear();
    for (const set of this.stains) {
      for (const S of Object.values(set)) {
        for (let i = 0; i < S.mesh.count; i++) S.mesh.setMatrixAt(i, HIDDEN);
        S.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    for (const s of this.spreads) s.mesh = null;
    for (const side of this.bodies) {
      for (const b of side) {
        for (const p of b.pieces) {
          p.age = -1;
          p.obj.visible = false;
        }
      }
    }
  }

  // --- Each frame ---------------------------------------------------------------

  update(dt: number, camera: THREE.Camera, windX: number, windZ: number): void {
    this.layer.update(dt, camera, windX, windZ);
    for (const s of this.spreads) {
      if (!s.mesh) continue;
      s.t += dt;
      if (s.t < 0) continue;
      const k = Math.min(1, s.t / s.time);
      // Fast at first, then slowly reaching its edge.
      const size = s.size * Math.max(0.05, Math.sqrt(k));
      s.mesh.setMatrixAt(s.index, m4.compose(s.pos, s.rot, scale.set(size, size, 1)));
      s.mesh.instanceMatrix.needsUpdate = true;
      if (k >= 1) s.mesh = null;
    }
    for (const side of this.bodies) for (const b of side) for (const p of b.pieces) if (p.age >= 0) this.updatePiece(p, dt);
  }

  /** Draw a piece where it is, `sink` (0..1) of its size. */
  private place(p: Piece, sink: number): void {
    p.obj.quaternion.copy(p.rot);
    p.obj.scale.copy(p.scale).multiplyScalar(Math.max(0.001, sink));
    p.obj.position.copy(p.center).multiply(p.obj.scale).applyQuaternion(p.rot).negate().add(p.pos);
  }

  /** A piece flies, tumbles and glances off what it meets (cast each frame, so it never passes through a wall), bleeding, and settles. */
  private updatePiece(p: Piece, dt: number): void {
    const fluid = this.fluid(p.owner.team);
    p.age += dt;
    const r = p.radius * Math.min(p.scale.x, p.scale.y, p.scale.z);
    if (p.rest >= 0) {
      p.rest += dt;
      if (p.rest > PIECE_REST + PIECE_FADE) {
        p.age = -1;
        p.obj.visible = false;
        return;
      }
    } else {
      p.vel.y -= 16 * dt;
      const speed = p.vel.length();
      const step = speed * dt;
      const hit = step > 1e-4 ? this.cast(p.pos, { x: p.vel.x / speed, y: p.vel.y / speed, z: p.vel.z / speed }, step + r) : null;
      if (hit) {
        const n = hit.normal;
        p.pos.addScaledVector(p.vel, Math.max(0, hit.dist - r) / speed);
        // A wet piece leaves a splat where it first strikes hard.
        if (!p.struck && p.bleed > 0 && speed > 4) {
          p.struck = true;
          this.stain('splat', fluid, at, n, rand(0.35, 0.65));
        }
        const into = p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z;
        p.vel.x = (p.vel.x - 1.5 * into * n.x) * 0.45;
        p.vel.y = (p.vel.y - 1.5 * into * n.y) * 0.45;
        p.vel.z = (p.vel.z - 1.5 * into * n.z) * 0.45;
        p.spin *= 0.55;
        if (n.y > 0.6 && p.vel.length() < 1.4) {
          p.rest = 0;
          p.vel.set(0, 0, 0);
          // Some of them go on bleeding where they lie.
          if (p.bleed > 0.5 && p.owner.pools < POOLS_PER_BODY && Math.random() < 0.6) {
            p.owner.pools++;
            this.stain('pool', fluid, at, n, rand(0.4, 0.8), null, 2.5, 0);
          }
        }
      } else {
        p.pos.addScaledVector(p.vel, dt);
        // Nothing to land on in reach (or no map): it falls away out of sight.
        if (p.pos.y < -60) p.rest = PIECE_REST;
      }
      q.setFromAxisAngle(p.axis, p.spin * dt);
      p.rot.premultiply(q);
      // A drop every quarter meter while it bleeds, so the trail is one line at any speed.
      if (p.bleed > 0) {
        p.trail += speed * dt;
        if (p.trail > 0.25) {
          p.trail = 0;
          this.drops(p.pos, null, fluid, 1, 0.6, 1, 0.035);
        }
      }
      // A torn machine part spits sparks for a moment.
      if (p.owner.team === 1 && p.age < 0.8 && Math.random() < 3 * dt) this.spark(p.pos);
    }
    p.bleed -= dt;
    this.place(p, p.rest > PIECE_REST ? 1 - (p.rest - PIECE_REST) / PIECE_FADE : 1);
  }
}
