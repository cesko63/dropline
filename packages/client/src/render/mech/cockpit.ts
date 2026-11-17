import * as THREE from 'three';
import { COMBAT, clamp, type Mech, type MechFrame } from '@dropline/shared';
import { KitBuilder, block, rod, type BoneMeshes } from '../pilot/rig';
import { FINISH, mechKit, type Finish } from './kit';

/**
 * The cockpit from inside, drawn in the first-person pass: the frame round the
 * window, the dashboard with its readouts, the pilot's hands on the sticks, and
 * the mech's own cannon arm out to the right. Each frame has its own window,
 * matching the cockpit seen from outside: the Halberd's wide chest window, the
 * Bastion's narrow bunker slit, the Lynx's bubble canopy. A Corps cockpit looks
 * out through scratched glass; a Z.E.R.O cockpit is armoured shut, so its
 * pilot sees a camera feed.
 *
 * Space: the viewmodel camera at the origin looking down -Z, the window about
 * 0.6 m ahead. The readouts sit low between the HUD's corners, never under them.
 */

type Bone = 'shell' | 'pillarL' | 'pillarR' | 'stickL' | 'stickR' | 'trigger' | 'screens' | 'warn';

/** Where the window plane sits. */
const Z = -0.6;
/** The readout screens' face on the dash. */
const SCREEN_Z = Z + 0.024;
/** The glass (or the feed) just beyond the window frame. */
const VIEW_Z = Z - 0.04;
/** The cannon arm is the mech's own arm, scaled down into the viewmodel's space. */
const ARM_SCALE = 0.36;

interface Layout {
  /** Height of the bar over the window, or null for a canopy with struts instead. */
  roof: number | null;
  roofH: number;
  /** Height of the dashboard's top edge at the window. */
  dash: number;
  /** How far inside the view's edges the pillars stand, and how thick and leaning they are. */
  inset: number;
  pillarW: number;
  lean: number;
  /** Where the cannon arm's shoulder sits, relative to where the viewmodel rig holds it. */
  arm: [number, number, number];
}

const LAYOUTS: Record<string, Layout> = {
  halberd: { roof: 0.3, roofH: 0.08, dash: -0.29, inset: 0.035, pillarW: 0.05, lean: 0.1, arm: [0.06, -0.03, 0.3] },
  // A bunker slit: a heavy brow low over the view, thick pillars set in.
  bastion: { roof: 0.22, roofH: 0.15, dash: -0.25, inset: 0.1, pillarW: 0.12, lean: 0.04, arm: [0.02, 0.09, 0.5] },
  // A bubble canopy: thin struts arching overhead, a low dash, the widest view.
  lynx: { roof: null, roofH: 0, dash: -0.31, inset: 0.0, pillarW: 0.03, lean: 0.25, arm: [0.06, -0.03, 0.3] },
};

/** Recoil per cannon: how far the arm is thrown back and up, and whether it throws a casing. */
const KICK: Record<string, { back: number; up: number; casing: boolean }> = {
  autocannon: { back: 0.05, up: 0.018, casing: true },
  breaker: { back: 0.09, up: 0.04, casing: true },
  lance: { back: 0.13, up: 0.05, casing: false },
};

/** Gloves on the sticks: the Corps' olive, Z.E.R.O's black frame. */
const GLOVE = ['#3a4029', '#1b1d21'];

const WARN = new THREE.Color('#ff3b2f');
const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/**
 * A light that comes on as start-up passes `at`: it stutters for a moment,
 * then holds. `online` runs 0..1 through the start-up.
 */
function stutter(online: number, at: number, t: number): number {
  if (online <= at) return 0;
  const u = (online - at) / 0.15;
  if (u >= 1) return 1;
  return Math.sin(t * 53 + at * 17) > 0.4 - u ? 0.5 + u * 0.5 : 0.1;
}

/** The glass's wear (Corps) or the camera feed's lines (Z.E.R.O), drawn once per side. */
function overlayTexture(open: boolean, light: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  if (open) {
    // Scratches and a few chips, brightest at the edges where the glass is worst.
    let seed = 7;
    const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    for (let i = 0; i < 22; i++) {
      const x = rand() < 0.5 ? rand() * 70 : 442 + rand() * 70;
      const y = rand() * 256;
      g.lineWidth = 0.5 + rand() * 0.6;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (rand() - 0.5) * 50, y + (rand() - 0.5) * 30);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.6)';
    for (let i = 0; i < 12; i++) g.fillRect(rand() * 512, rand() < 0.5 ? rand() * 40 : 216 + rand() * 40, 2, 2);
    const edge = g.createLinearGradient(0, 0, 0, 256);
    edge.addColorStop(0, 'rgba(255,255,255,0.18)');
    edge.addColorStop(0.15, 'rgba(255,255,255,0)');
    edge.addColorStop(0.85, 'rgba(255,255,255,0)');
    edge.addColorStop(1, 'rgba(255,255,255,0.22)');
    g.fillStyle = edge;
    g.fillRect(0, 0, 512, 256);
  } else {
    // Scan lines across the feed and brackets in its corners.
    g.fillStyle = light;
    for (let y = 0; y < 256; y += 4) {
      g.globalAlpha = 0.18;
      g.fillRect(0, y, 512, 1);
    }
    g.globalAlpha = 1;
    g.strokeStyle = light;
    g.lineWidth = 3;
    for (const [x, y, dx, dy] of [[8, 8, 1, 1], [504, 8, -1, 1], [8, 248, 1, -1], [504, 248, -1, -1]]) {
      g.beginPath();
      g.moveTo(x + dx * 40, y);
      g.lineTo(x, y);
      g.lineTo(x, y + dy * 24);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Builds one frame's cockpit parts, in a side's finish. */
function build(L: Layout, C: Finish, team: number): Partial<Record<Bone, BoneMeshes>> {
  const k = new KitBuilder<Bone>(C.wear * 0.5);
  // The dashboard: its face, its top running back toward the pilot, a trim along the edge, and a light strip each side.
  k.add('shell', block(2.8, 0.3, 0.05), C.frame, [0, L.dash - 0.15, Z])
    .add('shell', block(2.8, 0.03, 0.3), C.paint2, [0, L.dash, Z + 0.15])
    .add('shell', block(2.8, 0.015, 0.02), C.steel, [0, L.dash + 0.008, Z - 0.005])
    .sym('shell', block(0.34, 0.012, 0.02), '#ffffff', [0.46, L.dash - 0.02, Z - 0.03], { glow: true })
    .sym('shell', block(0.06, 0.012, 0.02), C.stripe, [0.68, L.dash - 0.02, Z - 0.03]);
  if (L.roof !== null) {
    k.add('shell', block(2.8, L.roofH, 0.12), C.frame, [0, L.roof, Z])
      .add('shell', block(2.8, 0.3, 0.05), C.frame, [0, L.roof + L.roofH / 2 + 0.15, Z + 0.02])
      .add('shell', block(2.8, 0.012, 0.02), C.steel, [0, L.roof - L.roofH / 2 + 0.004, Z - 0.06])
      // The warning strip under the brow, dark until the hull fails.
      .add('warn', block(0.26, 0.01, 0.02), WARN.getStyle(), [0, L.roof - L.roofH / 2 - 0.008, Z - 0.05], { glow: true });
    if (L.roofH > 0.1) for (const x of [-0.5, -0.25, 0.25, 0.5]) k.add('shell', block(0.02, 0.02, 0.01), C.steel, [x, L.roof, Z - 0.065]);
  } else {
    // Canopy struts: one arching up each side and a spine down the middle overhead.
    const arc = (t: number): [number, number] => [0.62 - 0.4 * t * t, -0.05 + 0.42 * Math.sin(t * Math.PI * 0.5)];
    for (let i = 0; i < 6; i++) {
      const [x0, y0] = arc(i / 6);
      const [x1, y1] = arc((i + 1) / 6);
      const len = Math.hypot(x1 - x0, y1 - y0);
      k.sym('shell', block(len + 0.01, 0.028, 0.03), C.frame, [(x0 + x1) / 2, (y0 + y1) / 2, Z], { rot: [0, 0, Math.atan2(y1 - y0, x1 - x0)] });
    }
    k.add('warn', block(0.26, 0.01, 0.02), WARN.getStyle(), [0, L.dash + 0.012, Z - 0.02], { glow: true });
  }
  // Pillars, placed by `resize` just inside the view's edges. A canopy has its struts instead.
  if (L.roof !== null) k.pair('pillarL', block(L.pillarW, 1.2, 0.06), C.frame, [0, 0, 0])
      .pair('pillarL', block(0.012, 1.1, 0.02), C.steel, [L.pillarW / 2, 0, -0.03]);
  if (L.pillarW > 0.08) k.pair('pillarL', block(L.pillarW * 0.6, 0.2, 0.03), C.stripe, [0, -0.15, -0.035]);

  // Two readouts on the dash, between the HUD's corners: hull and charges on the left, the ability lamp on the right.
  // Each is a bezel with the screen set in front of it; the readouts lie on the screen (SCREEN_Z).
  for (const x of [-0.18, 0.18]) {
    k.add('shell', block(0.14, 0.07, 0.02), C.frame, [x, L.dash + 0.03, Z + 0.01], { rot: [-0.35, 0, 0] })
      .add('screens', block(0.12, 0.05, 0.004), C.dark, [x, L.dash + 0.03, SCREEN_Z - 0.003], { glow: true, rot: [-0.35, 0, 0] });
  }

  // The pilot's hands on the sticks, just showing in the bottom corners, outside the readouts.
  const glove = GLOVE[team === 1 ? 1 : 0];
  for (const side of ['stickL', 'stickR'] as const) {
    k.add(side, rod(0.012, 0.2), C.steel, [0, 0.1, 0])
      .add(side, block(0.04, 0.09, 0.045, 0.01), C.dark, [0, 0.22, 0])
      .add(side, block(0.065, 0.06, 0.06, 0.012), glove, [0, 0.21, 0.005])
      .add(side, block(0.06, 0.018, 0.03, 0.006), glove, [0, 0.2, -0.03])
      .add(side, block(0.02, 0.03, 0.025, 0.005), glove, [side === 'stickL' ? 0.03 : -0.03, 0.255, 0]);
    if (team === 1) k.add(side, block(0.04, 0.008, 0.008), '#ffffff', [0, 0.235, -0.032], { glow: true });
  }
  k.add('trigger', block(0.02, 0.012, 0.03, 0.004), glove, [0, 0, -0.012]);
  return k.merged();
}

/** One frame's cockpit in one side's finish. Built once per frame and side and kept for the session. */
export class Cockpit {
  /** The cabin, drawn in the viewmodel scene. */
  readonly root = new THREE.Group();
  /** The cannon arm, carried by the viewmodel rig so it sways and recoils with the view. */
  readonly cannon = new THREE.Group();
  readonly muzzle = new THREE.Object3D();
  /** Where spent casings leave the cannon. */
  readonly port = new THREE.Object3D();
  readonly kick: { back: number; up: number; casing: boolean };
  private readonly frame: MechFrame;
  private readonly layout: Layout;
  private readonly bones = {} as Record<Bone, THREE.Object3D>;
  private readonly lights: THREE.MeshBasicMaterial;
  private readonly screens: THREE.MeshBasicMaterial;
  private readonly warn: THREE.MeshBasicMaterial;
  private readonly overlay: THREE.MeshBasicMaterial;
  private readonly overlayBase: number;
  /** The glass or feed overlay, sized by `resize` to fill the view. */
  private readonly view: THREE.Mesh;
  private readonly hull: THREE.Mesh;
  private readonly hullMat: THREE.MeshBasicMaterial;
  private readonly pips: THREE.Mesh[] = [];
  private readonly pipMat: THREE.MeshBasicMaterial;
  private readonly pipDim: THREE.MeshBasicMaterial;
  private readonly lamp: THREE.MeshBasicMaterial;
  private readonly lightColor: THREE.Color;
  private squeeze = 0;
  private time = 0;

  constructor(frame: MechFrame, team: number) {
    const t = team === 1 ? 1 : 0;
    const C = FINISH[t];
    this.frame = frame;
    this.layout = LAYOUTS[frame.id] ?? LAYOUTS.halberd;
    this.kick = KICK[frame.loadout[0]] ?? KICK.autocannon;
    this.lightColor = new THREE.Color(C.light);

    const body = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.7, metalness: 0.3 });
    this.lights = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.screens = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.warn = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

    for (const name of ['shell', 'pillarL', 'pillarR', 'stickL', 'stickR', 'trigger', 'screens', 'warn'] as Bone[]) this.bones[name] = new THREE.Object3D();
    const B = this.bones;
    this.root.add(B.shell, B.pillarL, B.pillarR, B.stickL, B.stickR, B.screens, B.warn);
    B.stickL.position.set(-0.3, -0.44, -0.42);
    B.stickR.position.set(0.3, -0.44, -0.42);
    B.stickR.add(B.trigger);
    B.trigger.position.set(0, 0.2, -0.04);
    const glowMat: Partial<Record<Bone, THREE.Material>> = { screens: this.screens, warn: this.warn };
    const parts = build(this.layout, C, t);
    for (const name of Object.keys(parts) as Bone[]) {
      const p = parts[name]!;
      if (p.body) B[name].add(new THREE.Mesh(p.body, body));
      if (p.glow) B[name].add(new THREE.Mesh(p.glow, glowMat[name] ?? this.lights));
    }

    // Readouts: the hull as a bar that shortens, the move's charges as pips, the ability as a lamp.
    const L = this.layout;
    // They lie on the tilted screen face: `dy` runs up the screen, not straight up.
    const face = new THREE.Group();
    face.position.set(0, L.dash + 0.03, SCREEN_Z + 0.002);
    face.rotation.x = -0.35;
    this.root.add(face);
    const readout = (w: number, h: number, mat: THREE.Material, x: number, dy: number): THREE.Mesh => {
      const geo = new THREE.PlaneGeometry(w, h);
      geo.translate(w / 2, 0, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, dy, 0);
      face.add(mesh);
      return mesh;
    };
    this.hullMat = new THREE.MeshBasicMaterial({ color: C.light, toneMapped: false });
    this.pipMat = new THREE.MeshBasicMaterial({ color: C.light, toneMapped: false });
    this.pipDim = new THREE.MeshBasicMaterial({ color: this.lightColor.clone().multiplyScalar(0.18), toneMapped: false });
    this.lamp = new THREE.MeshBasicMaterial({ color: C.light, toneMapped: false });
    this.hull = readout(0.1, 0.012, this.hullMat, -0.23, 0.009);
    for (let i = 0; i < frame.mobility.charges; i++) this.pips.push(readout(0.02, 0.01, this.pipDim, -0.23 + i * 0.026, -0.01));
    readout(0.03, 0.026, this.lamp, 0.165, 0);

    // The view out: scratched glass for the Corps, a camera feed for Z.E.R.O.
    const tex = overlayTexture(C.open, C.light);
    this.overlayBase = C.open ? 0.22 : 0.3;
    this.overlay = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: this.overlayBase, depthWrite: false, blending: C.open ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false });
    const plane = new THREE.PlaneGeometry(1, 1);
    this.view = new THREE.Mesh(plane, this.overlay);
    this.view.position.set(0, 0, VIEW_Z);
    this.view.renderOrder = -1;
    this.root.add(this.view);

    // The cannon arm: the frame's own arm, in its finish, from the same model the world sees.
    const kit = mechKit(frame, t);
    const arm = kit.bones.armR;
    const armBody = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.4 });
    const armGlow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const shoulder = new THREE.Group();
    shoulder.position.set(...this.layout.arm);
    shoulder.scale.setScalar(ARM_SCALE);
    if (arm?.body) shoulder.add(new THREE.Mesh(arm.body, armBody));
    if (arm?.glow) shoulder.add(new THREE.Mesh(arm.glow, armGlow));
    this.muzzle.position.set(...kit.muzzle);
    this.port.position.set(0.25, 0.2, -0.5);
    shoulder.add(this.muzzle, this.port);
    this.cannon.add(shoulder);
  }

  /** Stand the pillars just inside the view's edges at the window, whatever the window's shape. */
  resize(fov: number, aspect: number): void {
    const half = Math.tan((fov / 2) * (Math.PI / 180));
    const edge = half * -Z * aspect;
    this.view.scale.set(2 * half * -VIEW_Z * aspect, 2 * half * -VIEW_Z, 1);
    const L = this.layout;
    const x = edge - L.inset - L.pillarW / 2;
    this.bones.pillarL.position.set(-x, 0, Z);
    this.bones.pillarR.position.set(x, 0, Z);
    this.bones.pillarL.rotation.z = -L.lean;
    this.bones.pillarR.rotation.z = L.lean;
  }

  /** The trigger hand squeezes. */
  fire(): void {
    this.squeeze = 1;
  }

  /**
   * `seated` rises 0..1 as the pilot sits down, `rattle` is the cabin's shake,
   * `swayX`/`swayY` how far the view lags the mouse (the left stick follows it).
   */
  update(dt: number, mech: Mech | null, seated: number, rattle: number, swayX: number, swayY: number): void {
    this.time += dt;
    const B = this.bones;
    this.root.position.y = -0.5 * (1 - seated) + clamp(rattle, -0.05, 0.03);
    this.root.rotation.z = clamp(rattle, -0.05, 0.05) * 0.2;
    if (!mech) return;

    // Start-up brings the cabin on in order: the dash lights, the readouts, then the view.
    const online = mech.state === 'boot' ? clamp(mech.stateTime / COMBAT.mech.embark.time, 0, 1) : 1;
    const failing = mech.health < this.frame.health * 0.25;
    const pulse = 0.6 + 0.4 * Math.sin(this.time * 12);
    // The cabin's lights are white in the model: their colour is the side's, or red while the hull fails.
    this.lights.color.copy(failing ? WARN : this.lightColor).multiplyScalar(stutter(online, 0.05, this.time) * (failing ? pulse : 1));
    const screens = stutter(online, 0.35, this.time);
    this.screens.color.setScalar(screens);
    const readouts = online > 0.65 ? 1 : 0;
    this.warn.color.setScalar(failing && Math.sin(this.time * 9) > 0 ? 1.4 : 0.06);
    this.overlay.opacity = this.overlayBase * stutter(online, 0.5, this.time);

    const health = clamp(mech.health / this.frame.health, 0, 1);
    this.hull.visible = readouts > 0;
    this.hull.scale.x = Math.max(0.01, health);
    this.hullMat.color.copy(failing ? WARN : this.lightColor);
    for (let i = 0; i < this.pips.length; i++) {
      this.pips[i].visible = readouts > 0;
      this.pips[i].material = mech.charges >= i + 1 ? this.pipMat : this.pipDim;
    }
    // The lamp: lit when the ability is ready, bright while it runs, dim while it recharges.
    const running = mech.shieldUp || mech.cloak > 0 || mech.salvoLeft > 0;
    this.lamp.color.copy(this.lightColor).multiplyScalar(readouts * (running ? 2 : mech.abilityCooldown > 0 ? 0.15 : 1));

    // Hands: the left stick follows the view, both lean forward with speed, the right squeezes on each shot.
    const speed = Math.min(1, Math.hypot(mech.vel.x, mech.vel.z) / this.frame.move.walkSpeed);
    B.stickL.rotation.x = damp(B.stickL.rotation.x, -0.15 * speed - swayY * 3, 14, dt);
    B.stickL.rotation.z = damp(B.stickL.rotation.z, -swayX * 4, 14, dt);
    B.stickR.rotation.x = damp(B.stickR.rotation.x, -0.15 * speed, 14, dt);
    this.squeeze = Math.max(0, this.squeeze - dt * 8);
    B.trigger.rotation.x = 0.6 * this.squeeze;
  }
}
