import * as THREE from 'three';
import { WEAPONS } from '@dropline/shared';
import { block, rod } from './pilot/rig';

/**
 * The weapon on a pilot's right forearm: one barrel that the housing's ammo
 * printer reshapes for each weapon. The same model is drawn in first person
 * (full detail) and on every pilot in third person (`lite`, without the
 * smallest parts), so what a player holds and what everyone else sees match.
 *
 * It is field gear, not a toy: gunmetal, worn plate and bare steel, no lights.
 * Everything that changes is machinery you can watch work.
 *
 * Built along -Z from the front of the housing, +Y on top, -X the side that
 * faces the player in first person. The caller places and scales `root`.
 *
 * Changing weapons runs in three steps over the new weapon's equip time: the
 * barrel in use draws in and its side parts fold away (COLLAPSE); the breech's
 * steel iris shuts and the bolt lever racks back while the printer makes the
 * next barrel (PRINT); the iris opens and the new barrel runs out piece by
 * piece, overshooting a little before it slams home (DEPLOY).
 *
 * Each form reads from its silhouette:
 * - scattergun: short and fat, heat-shield bands, four steel prongs round the
 *   mouth, a slotted heat shield on top, a magazine tube and pump underneath
 * - carbine: a shroud drilled with cooling holes, a ported muzzle brake, a
 *   toothed top rail and a ribbed feed box at the side
 * - longshot: three telescoping sections with locking collars, stabiliser rails
 *   on struts along both sides, a scope with a dark glass lens, a baffled brake
 */

/** Shares of a weapon change: the old barrel draws in, the printer makes the new one, it runs out. */
const COLLAPSE = 0.3;
const PRINT = 0.25;
/** Length of the breech collar every barrel prints from. */
const COLLAR = 0.04;
const HALF_PI = Math.PI / 2;

/**
 * The weapon's finish per team, shared by both views and the suit's housing:
 * the Corps' gunmetal and olive-grey plate, Z.E.R.O's graphite and black.
 */
export const GUN_FINISH = [
  { plate: '#4e5450', gun: '#2a2d30', dark: '#16181a', steel: '#85898d' },
  { plate: '#2b2e33', gun: '#1a1b1e', dark: '#0b0c0e', steel: '#5d6269' },
];

export interface ArmGunLook {
  gun: THREE.Material;
  plate: THREE.Material;
  dark: THREE.Material;
  steel: THREE.Material;
}

type V3 = [number, number, number];
interface Pose {
  p: V3;
  r: V3;
  s: V3;
}
/** A piece that moves from where it is stowed to where it is deployed over its own share of the deploy. */
interface Part {
  obj: THREE.Object3D;
  from: Pose;
  to: Pose;
  t0: number;
  t1: number;
}

class Form {
  readonly root = new THREE.Group();
  readonly parts: Part[] = [];
  progress = 0;
  /** Its own motion over its pose each frame; `kick` is 1 on a shot, falling to 0. */
  animate: (kick: number) => void = () => {};
  constructor(
    /** Muzzle distance along -Z with the barrel all the way out. */
    readonly reach: number,
    /** Kick per shot in first person: backwards (metres) and muzzle climb (radians). */
    readonly kickBack: number,
    readonly kickUp: number,
  ) {
    this.root.visible = false;
  }
}

/** Runs past the end and settles back, so a part slams into place. */
const backOut = (u: number): number => {
  const c = 1.9;
  const v = u - 1;
  return 1 + (c + 1) * v * v * v + c * v * v;
};
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => t * t * (3 - 2 * t);

export class ArmGun {
  readonly root = new THREE.Group();
  /** Where shots leave the barrel in use (at the breech while there is none). */
  readonly muzzle = new THREE.Object3D();
  /** 0..1 while the printer makes a barrel: the arm's own printer parts can follow it. */
  printing = 0;
  /** True for the one update in which a barrel locked. */
  justLocked = false;
  kickBack = 0;
  kickUp = 0;

  private readonly forms = new Map<string, Form>();
  private shown: Form | null = null;
  /** The weapon the gun is changing to; null before the first update. */
  private target: string | null = null;
  private phase: 'idle' | 'collapse' | 'print' | 'deploy' = 'idle';
  /** Seconds the whole change takes: the equip time of the weapon it changes to. */
  private span = 0.4;
  private printT = 0;
  private kick = 0;

  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly glass: THREE.MeshStandardMaterial;
  /** The breech's iris blades, and how open it is (1 open). */
  private readonly iris: THREE.Object3D[] = [];
  private irisOpen = 1;
  /** The bolt lever on the breech: it racks back while a barrel prints, and with every shot. */
  private readonly bolt: THREE.Object3D;

  constructor(
    private readonly look: ArmGunLook,
    /** Third person: leave out the smallest parts. */
    private readonly lite = false,
  ) {
    this.glass = new THREE.MeshStandardMaterial({ color: '#0d1316', roughness: 0.08, metalness: 0.9 });
    this.bolt = this.buildBreech();
    this.forms.set('scattergun', this.scattergun());
    this.forms.set('carbine', this.carbine());
    this.forms.set('longshot', this.longshot());
    for (const f of this.forms.values()) this.root.add(f.root);
    this.muzzle.position.z = -COLLAR;
    this.root.add(this.muzzle);
  }

  /** A shot: the form's own reaction (prongs snap open, the brake jumps, the bolt cycles). */
  fire(): void {
    this.kick = 1;
  }

  /**
   * `id` is the weapon in use; anything without a barrel (the shoulder pod)
   * draws the barrel in and shuts the breech. The first call shows the weapon
   * without a change.
   */
  update(dt: number, id: string): void {
    const want = this.forms.get(id) ?? null;
    this.justLocked = false;
    if (this.target === null) {
      this.target = id;
      this.snap(want);
    } else if (id !== this.target) {
      this.target = id;
      this.span = Math.max(0.25, WEAPONS[id]?.equipTime ?? 0.4);
      if (this.shown && this.shown === want) this.phase = 'deploy';
      else if (this.shown) this.phase = 'collapse';
      else this.phase = want ? 'print' : 'idle';
      this.printT = 0;
    }

    if (this.phase === 'collapse' && this.shown) {
      this.shown.progress -= dt / (COLLAPSE * this.span);
      if (this.shown.progress <= 0) {
        this.shown.progress = 0;
        this.pose(this.shown);
        this.shown.root.visible = false;
        this.shown = null;
        this.phase = want ? 'print' : 'idle';
        this.printT = 0;
      }
    } else if (this.phase === 'print') {
      this.printT += dt / (PRINT * this.span);
      if (this.printT >= 1) {
        this.shown = want;
        if (want) want.root.visible = true;
        this.phase = want ? 'deploy' : 'idle';
      }
    } else if (this.phase === 'deploy' && this.shown) {
      this.shown.progress += dt / ((1 - COLLAPSE - PRINT) * this.span);
      if (this.shown.progress >= 1) {
        this.shown.progress = 1;
        this.phase = 'idle';
        this.justLocked = true;
      }
    }
    const p = clamp01(this.printT);
    this.printing = this.phase === 'print' ? Math.sin(Math.PI * p) : 0;

    // The iris shuts as the last of a barrel draws in, stays shut while the
    // printer works, and opens again just before the next one runs out.
    let open = this.shown ? 1 : 0;
    if (this.phase === 'collapse' && this.shown) open = clamp01(this.shown.progress / 0.25);
    else if (this.phase === 'print') open = p < 0.6 ? 0 : (p - 0.6) / 0.4;
    this.irisOpen = open;
    this.poseIris();

    const f = this.shown;
    if (f) {
      this.pose(f);
      if (f.progress >= 1) {
        this.kickBack = f.kickBack;
        this.kickUp = f.kickUp;
      }
    }
    this.muzzle.position.z = -(f ? mix(COLLAR, f.reach, clamp01(f.progress)) : COLLAR);

    this.kick = Math.max(0, this.kick - dt * 9);
    this.bolt.position.z = -0.012 + 0.032 * (this.phase === 'print' ? Math.sin(Math.PI * p) : 0) + 0.022 * this.kick;
    if (f) f.animate(this.kick);
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    this.glass.dispose();
  }

  // --- Changing --------------------------------------------------------------

  private snap(want: Form | null): void {
    for (const f of this.forms.values()) {
      f.progress = f === want ? 1 : 0;
      f.root.visible = f === want;
      this.pose(f);
    }
    this.shown = want;
    this.phase = 'idle';
    this.irisOpen = want ? 1 : 0;
    this.poseIris();
    if (want) {
      this.kickBack = want.kickBack;
      this.kickUp = want.kickUp;
    }
  }

  private pose(f: Form): void {
    for (const part of f.parts) {
      const u = clamp01((f.progress - part.t0) / (part.t1 - part.t0));
      const e = backOut(u);
      const o = part.obj;
      const { from: a, to: b } = part;
      o.position.set(mix(a.p[0], b.p[0], e), mix(a.p[1], b.p[1], e), mix(a.p[2], b.p[2], e));
      o.rotation.set(mix(a.r[0], b.r[0], e), mix(a.r[1], b.r[1], e), mix(a.r[2], b.r[2], e));
      o.scale.set(Math.max(0.001, mix(a.s[0], b.s[0], e)), Math.max(0.001, mix(a.s[1], b.s[1], e)), Math.max(0.001, mix(a.s[2], b.s[2], e)));
      o.visible = u > 0.001;
    }
  }

  /** Iris blades slide in and turn to close over the bore, like a camera's. */
  private poseIris(): void {
    const e = smooth(this.irisOpen);
    for (const blade of this.iris) {
      const leaf = blade.children[0];
      leaf.position.y = mix(0.012, 0.031, e);
      leaf.rotation.z = mix(0.75, 0, e);
    }
  }

  // --- Building ---------------------------------------------------------------

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0]): THREE.Mesh {
    this.geos.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(p[0], p[1], p[2]);
    m.rotation.set(r[0], r[1], r[2]);
    m.castShadow = this.lite;
    return m;
  }

  /** A cylinder along Z. */
  private tube(r: number, len: number, mat: THREE.Material, p: V3 = [0, 0, 0], sides = 8): THREE.Mesh {
    return this.mesh(rod(r, len, sides).rotateX(HALF_PI), mat, p);
  }

  /** A bolt head on a face, pointing along `axis` (0 x, 1 y, 2 z). */
  private boltHead(p: V3, axis: 0 | 1 | 2): THREE.Mesh {
    const r: V3 = axis === 0 ? [0, 0, HALF_PI] : axis === 2 ? [HALF_PI, 0, 0] : [0, 0, 0];
    return this.mesh(rod(0.0045, 0.004, 6), this.look.steel, p, r);
  }

  /** Make `obj` a moving part of `form`: stowed at `from`, deployed at `to`, moving over `t0`..`t1` of the deploy. */
  private part(form: Form, parent: THREE.Object3D, obj: THREE.Object3D, to: Partial<Pose>, from: Partial<Pose>, t0: number, t1: number): THREE.Object3D {
    const full = (q: Partial<Pose>, base?: Pose): Pose => ({
      p: q.p ?? base?.p ?? [obj.position.x, obj.position.y, obj.position.z],
      r: q.r ?? base?.r ?? [0, 0, 0],
      s: q.s ?? base?.s ?? [1, 1, 1],
    });
    const end = full(to);
    form.parts.push({ obj, to: end, from: full(from, end), t0, t1 });
    parent.add(obj);
    return obj;
  }

  /** Something only first person shows. */
  private detail(parent: THREE.Object3D, ...objs: THREE.Object3D[]): void {
    if (!this.lite) parent.add(...objs);
  }

  /**
   * The breech every barrel prints from: an eight-sided block on a mount, a
   * steel locking band, bolts at its corners, the iris over the bore and the
   * bolt lever on the side the player sees. Returns the lever.
   */
  private buildBreech(): THREE.Object3D {
    const L = this.look;
    this.root.add(
      this.tube(0.039, COLLAR, L.gun, [0, 0, -COLLAR / 2], 8),
      this.tube(0.041, 0.009, L.steel, [0, 0, -COLLAR + 0.006], 8),
      this.mesh(block(0.066, 0.046, 0.034, 0.006), L.dark, [0, -0.03, -0.018]),
      this.tube(0.03, 0.004, L.dark, [0, 0, -COLLAR - 0.0005], 10),
    );
    for (const [x, y] of [
      [0.03, 0.03],
      [-0.03, 0.03],
      [0.03, -0.03],
      [-0.03, -0.03],
    ])
      this.detail(this.root, this.boltHead([x, y, -COLLAR - 0.002], 2));
    for (let i = 0; i < 6; i++) {
      const around = new THREE.Group();
      around.rotation.z = (i * Math.PI) / 3;
      around.position.z = -COLLAR - 0.003;
      around.add(this.mesh(block(0.03, 0.012, 0.003, 0.001), i % 2 ? L.steel : L.plate));
      this.iris.push(around);
      this.root.add(around);
    }
    const lever = new THREE.Group();
    lever.add(
      this.mesh(block(0.008, 0.014, 0.034, 0.002), L.steel),
      this.mesh(block(0.016, 0.01, 0.01, 0.002), L.steel, [-0.008, 0, 0.012]),
    );
    lever.position.set(-0.043, 0.004, -0.012);
    this.root.add(lever);
    return lever;
  }

  /** Short and fat: heat-shield bands, four steel prongs round the mouth, a heat shield on top, a magazine tube and pump below. */
  private scattergun(): Form {
    const L = this.look;
    const f = new Form(0.165, 0.085, 0.16);
    const body = this.tube(0.036, 0.09, L.gun, [0, 0, 0], 10);
    for (const z of [-0.028, 0, 0.028]) body.add(this.tube(0.039, 0.009, L.steel, [0, 0, z], 10));
    this.part(f, f.root, body, { p: [0, 0, -0.085] }, { p: [0, 0, -0.025], s: [0.7, 0.7, 0.2] }, 0, 0.45);

    const mouth = this.tube(0.043, 0.024, L.plate, [0, 0, 0], 10);
    mouth.add(this.tube(0.028, 0.004, L.dark, [0, 0, -0.013], 10));
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      this.detail(mouth, this.boltHead([Math.cos(a) * 0.036, Math.sin(a) * 0.036, -0.013], 2));
    }
    this.part(f, f.root, mouth, { p: [0, 0, -0.142] }, { p: [0, 0, -0.065], s: [0.6, 0.6, 0.5] }, 0.2, 0.6);

    const prongs: THREE.Object3D[] = [];
    for (let k = 0; k < 4; k++) {
      const around = new THREE.Group();
      around.rotation.z = Math.PI / 4 + (k * Math.PI) / 2;
      f.root.add(around);
      const pivot = new THREE.Group();
      pivot.add(this.mesh(block(0.026, 0.012, 0.066, 0.003), L.steel, [0, 0, -0.033]));
      pivot.add(this.mesh(block(0.026, 0.016, 0.014, 0.003), L.dark, [0, 0.003, -0.062]));
      this.part(f, around, pivot, { p: [0, 0.03, -0.15], r: [0.26, 0, 0] }, { p: [0, 0.012, -0.07], r: [-0.5, 0, 0], s: [0.4, 0.4, 0.4] }, 0.45, 0.95);
      prongs.push(pivot);
    }

    // A heat shield over the top of the barrel: slotted steel on two risers.
    const shield = this.mesh(block(0.05, 0.01, 0.1, 0.002), L.plate);
    for (const z of [-0.03, -0.01, 0.01, 0.03]) shield.add(this.mesh(block(0.034, 0.012, 0.008, 0.001), L.dark, [0, 0, z]));
    shield.add(this.mesh(block(0.052, 0.016, 0.008, 0.002), L.plate, [0, -0.003, -0.05]));
    for (const z of [-0.035, 0.035]) shield.add(this.mesh(block(0.012, 0.012, 0.012, 0.002), L.steel, [0, -0.01, z]));
    this.part(f, f.root, shield, { p: [0, 0.047, -0.088] }, { p: [0, 0.03, -0.03], s: [0.8, 0.5, 0.3] }, 0.3, 0.8);

    // Under the barrel, the magazine tube with a steel cap, and the pump forend
    // riding on it, ribbed for a grip. It racks back with every shot.
    let pump: THREE.Object3D | null = null;
    if (!this.lite) {
      const mag = this.tube(0.016, 0.11, L.gun, [0, 0, 0], 8);
      mag.add(this.tube(0.018, 0.012, L.steel, [0, 0, -0.056], 8));
      this.part(f, f.root, mag, { p: [0, -0.05, -0.095] }, { p: [0, -0.04, -0.03], s: [0.8, 0.8, 0.2] }, 0.2, 0.65);
      const fore = this.mesh(block(0.05, 0.03, 0.06, 0.006), L.dark);
      for (const z of [-0.018, 0, 0.018]) fore.add(this.mesh(block(0.054, 0.006, 0.008, 0.001), L.gun, [0, -0.013, z]));
      pump = this.part(f, f.root, fore, { p: [0, -0.05, -0.07] }, { p: [0, -0.04, -0.03], s: [0.8, 0.6, 0.4] }, 0.35, 0.85);
    }

    f.animate = (kick) => {
      for (const p of prongs) p.rotation.x += 0.35 * kick;
      if (pump) pump.position.z += 0.022 * kick;
    };
    return f;
  }

  /** Medium: a drilled shroud, a ported brake, a toothed top rail and a ribbed feed box at the side. */
  private carbine(): Form {
    const L = this.look;
    const f = new Form(0.315, 0.035, 0.05);
    const shroud = this.tube(0.026, 0.15, L.gun, [0, 0, 0], 8);
    shroud.add(this.tube(0.029, 0.01, L.steel, [0, 0, 0.068], 8));
    for (const z of [-0.05, -0.025, 0, 0.025, 0.05]) {
      this.detail(
        shroud,
        this.mesh(block(0.011, 0.006, 0.011, 0.001), L.dark, [0, 0.0245, z]),
        this.mesh(block(0.006, 0.011, 0.011, 0.001), L.dark, [-0.0245, 0, z]),
        this.mesh(block(0.006, 0.011, 0.011, 0.001), L.dark, [0.0245, 0, z]),
      );
    }
    this.part(f, f.root, shroud, { p: [0, 0, -0.115] }, { p: [0, 0, -0.045], s: [0.8, 0.8, 0.15] }, 0, 0.45);

    const inner = this.tube(0.014, 0.14, L.dark, [0, 0, 0], 8);
    this.part(f, f.root, inner, { p: [0, 0, -0.24] }, { p: [0, 0, -0.125], s: [1, 1, 0.3] }, 0.2, 0.65);

    const brake = this.mesh(block(0.042, 0.034, 0.048, 0.006), L.gun);
    brake.add(this.mesh(block(0.036, 0.028, 0.006, 0.002), L.steel, [0, 0, -0.025]));
    for (const z of [-0.012, 0.004]) brake.add(this.mesh(block(0.046, 0.012, 0.008, 0.002), L.dark, [0, 0, z]));
    this.part(f, f.root, brake, { p: [0, 0, -0.29] }, { p: [0, 0, -0.165], s: [0.5, 0.5, 0.5] }, 0.4, 0.8);

    const rail = this.mesh(block(0.016, 0.012, 0.17, 0.002), L.steel);
    for (let i = 0; i < 7; i++) this.detail(rail, this.mesh(block(0.02, 0.006, 0.009, 0.001), L.steel, [0, 0.008, 0.072 - i * 0.024]));
    rail.add(this.mesh(block(0.008, 0.016, 0.012, 0.002), L.dark, [0, -0.012, 0.06]), this.mesh(block(0.008, 0.016, 0.012, 0.002), L.dark, [0, -0.012, -0.06]));
    this.part(f, f.root, rail, { p: [0, 0.038, -0.105] }, { p: [0, 0.0, -0.025], s: [1, 0.3, 0.2] }, 0.3, 0.75);

    // The feed box beside the barrel, on the side the player sees.
    const feed = this.mesh(block(0.028, 0.044, 0.062, 0.005), L.plate);
    for (const y of [-0.012, 0, 0.012]) this.detail(feed, this.mesh(block(0.003, 0.004, 0.05, 0.001), L.dark, [-0.0145, y, 0]));
    feed.add(this.mesh(block(0.01, 0.012, 0.014, 0.002), L.steel, [-0.008, -0.026, 0.018]));
    this.part(f, f.root, feed, { p: [-0.048, -0.012, -0.062] }, { p: [-0.02, -0.012, -0.03], s: [0.3, 0.6, 0.6] }, 0.25, 0.7);

    f.animate = (kick) => {
      brake.position.z += 0.006 * kick;
    };
    return f;
  }

  /** Long: three telescoping sections, stabiliser rails on struts, a scope and a baffled brake. */
  private longshot(): Form {
    const L = this.look;
    const f = new Form(0.6, 0.07, 0.11);
    const sections: [number, number, number, number][] = [
      // radius, deployed centre, stowed centre, start of its share
      [0.025, -0.14, -0.055, 0],
      [0.019, -0.315, -0.145, 0.12],
      [0.014, -0.485, -0.305, 0.25],
    ];
    let tip: THREE.Mesh | null = null;
    for (const [r, to, from, t0] of sections) {
      const seg = this.tube(r, 0.2, r < 0.015 ? L.dark : L.gun, [0, 0, 0], 8);
      // A locking collar at its back end, where it seats in the section behind.
      seg.add(this.tube(r + 0.0045, 0.016, L.steel, [0, 0, 0.092], 8));
      this.detail(seg, this.mesh(block(0.004, 0.003, 0.17, 0.001), L.dark, [0, r - 0.0005, -0.01]));
      this.part(f, f.root, seg, { p: [0, 0, to] }, { p: [0, 0, from], s: [r < 0.02 ? 1 : 0.8, r < 0.02 ? 1 : 0.8, 0.25] }, t0, t0 + 0.4);
      tip = seg;
    }
    const brake = this.mesh(block(0.05, 0.044, 0.05, 0.006), L.plate);
    for (const z of [-0.014, 0.004]) brake.add(this.mesh(block(0.054, 0.03, 0.008, 0.002), L.dark, [0, 0, z]));
    brake.add(this.tube(0.012, 0.004, L.dark, [0, 0, -0.026], 8));
    brake.position.z = -0.12;
    tip!.add(brake);
    for (const side of [-1, 1]) {
      const fin = new THREE.Group();
      fin.add(this.mesh(block(0.032, 0.006, 0.05, 0.002), L.steel, [side * 0.016, 0, 0]));
      fin.rotation.z = side * 0.5;
      const hinge = new THREE.Group();
      hinge.add(fin);
      this.part(f, tip!, hinge, { p: [side * 0.012, 0, -0.07] }, { p: [0, 0, -0.07], s: [0.05, 0.05, 0.05] }, 0.7, 1);
    }

    // Stabiliser rails: plate drilled along its length, held off the barrel on two struts.
    for (const side of [-1, 1]) {
      const rail = this.mesh(block(0.008, 0.024, 0.34, 0.002), L.plate);
      for (let i = 0; i < 6; i++) this.detail(rail, this.mesh(block(0.009, 0.01, 0.022, 0.001), L.dark, [0, 0, 0.125 - i * 0.05]));
      for (const z of [0.1, -0.1]) rail.add(this.mesh(rod(0.0035, 0.016, 6), L.steel, [-side * 0.009, 0, z], [0, 0, HALF_PI]));
      this.part(f, f.root, rail, { p: [side * 0.038, -0.006, -0.255] }, { p: [side * 0.03, -0.006, -0.055], s: [1, 0.5, 0.15] }, 0.4, 0.85);
    }

    const scope = new THREE.Group();
    scope.add(
      this.mesh(block(0.03, 0.03, 0.08, 0.006), L.dark),
      this.mesh(block(0.016, 0.03, 0.036, 0.003), L.plate, [0, -0.026, 0]),
      this.tube(0.017, 0.016, L.gun, [0, 0, -0.044], 8),
      this.tube(0.0135, 0.004, this.glass, [0, 0, -0.0525], 8),
      this.tube(0.012, 0.014, L.gun, [0, 0, 0.046], 8),
    );
    for (const z of [-0.022, 0.022]) scope.add(this.tube(0.0175, 0.007, L.steel, [0, 0, z], 8));
    this.detail(scope, this.boltHead([0.009, -0.026, 0.01], 0), this.boltHead([0.009, -0.026, -0.01], 0));
    this.part(f, f.root, scope, { p: [0, 0.068, -0.04] }, { p: [0, 0.02, -0.04], s: [0.4, 0.2, 0.4] }, 0.5, 0.95);

    f.animate = (kick) => {
      tip!.position.z += 0.012 * kick;
    };
    return f;
  }
}
