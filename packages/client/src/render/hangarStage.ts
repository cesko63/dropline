import * as THREE from 'three';
import { COMBAT, MECHS, MECH_IDS, WEAPONS, createMech, createPlayerState, type Actor, type Mech, type MechDef } from '@dropline/shared';
import type { Pad } from '../input/gamepad';
import { Avatar, TEAM_LOOK } from './avatar';
import { MechAvatar } from './mechAvatar';

/**
 * The hangar's 3D preview: the player's own suit, or their mech, on a lit
 * turntable. It uses the same models and animation as the match, so what turns
 * here is exactly what the others will see. Drag (or the right stick) turns it,
 * the wheel, a pinch or the triggers zoom, a double click puts the view back.
 */

export type StageView = 'pilot' | 'mech';
export type PilotPose = 'idle' | 'aim' | 'run';
export type MechPose = 'standby' | 'stand' | 'walk';

interface Framing {
  target: THREE.Vector3;
  dist: number;
  /** Half the size of the shadow area, meters. */
  shadow: number;
  ring: number;
}

const FRAMING: Record<StageView, Framing> = {
  pilot: { target: new THREE.Vector3(0, 0.92, 0), dist: 4.3, shadow: 2.5, ring: 0.75 },
  mech: { target: new THREE.Vector3(0, 2.55, 0), dist: 15, shadow: 6, ring: 2.6 },
};

/** The turn the model rests at: three quarters, its front to the camera. */
const REST_YAW = -0.55;
const REST_TILT = 0.12;
/** Seconds after the last touch before it starts turning by itself, and how fast it turns. */
const IDLE_SPIN_DELAY = 4;
const IDLE_SPIN = 0.32;
/** The last stretch of a real mech drop, so it slams into frame from just above it. */
const DROP_FROM = 0.92;
const STANDBY_BEFORE_BOOT = 0.55;

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/** Concentric rings fading out to the edge: the deck the model stands on. */
function deckTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(256, 256, 0, 256, 256, 256);
  grad.addColorStop(0, 'rgba(70,78,90,1)');
  grad.addColorStop(0.55, 'rgba(44,50,60,0.9)');
  grad.addColorStop(1, 'rgba(20,24,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(233,238,245,0.08)';
  g.lineWidth = 2;
  for (let r = 40; r < 250; r += 40) {
    g.beginPath();
    g.arc(256, 256, r, 0, Math.PI * 2);
    g.stroke();
  }
  // Tick marks round the edge, so the turn reads even on a plain suit.
  g.strokeStyle = 'rgba(233,238,245,0.14)';
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r0 = i % 4 === 0 ? 196 : 206;
    g.beginPath();
    g.moveTo(256 + Math.cos(a) * r0, 256 + Math.sin(a) * r0);
    g.lineTo(256 + Math.cos(a) * 216, 256 + Math.sin(a) * 216);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A stand-in actor the pilot avatar reads its pose from, as the suit viewer does. */
function previewActor(team: number): Actor {
  const loadout = [...COMBAT.playerLoadout];
  const actor = {
    id: 0,
    team,
    p: createPlayerState({ x: 0, y: 0, z: 0 }),
    alive: true,
    loadout,
    ammo: loadout.map((id) => WEAPONS[id].magSize),
    equip: 0,
    ads: 0,
    weapon: 0,
    punchPitch: 0,
    reload: 0,
  } as unknown as Actor;
  actor.p.grounded = true;
  return actor;
}

export class HangarStage {
  /** A mech touched down in the preview (for the thud). */
  onLand: () => void = () => {};
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.05, 400);
  private readonly turntable = new THREE.Group();
  private readonly key: THREE.DirectionalLight;
  private readonly rim: THREE.DirectionalLight;
  private readonly deck: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private avatar: Avatar | null = null;
  private mech: MechAvatar | null = null;
  private readonly actor: Actor;
  private kit: Mech;
  private side = -1;
  private view: StageView = 'pilot';
  private pilotPose: PilotPose = 'idle';
  private mechPose: MechPose = 'stand';
  private landed = false;
  private stride = 0;
  private fireClock = 0;

  // The view: the turntable's angle and spin, the camera's tilt and zoom.
  private yaw = REST_YAW;
  private yawVel = 0;
  private tilt = REST_TILT;
  private zoom = 1;
  private sinceTouch = 0;
  private readonly frame = { target: FRAMING.pilot.target.clone(), dist: FRAMING.pilot.dist };
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private lastMove = 0;
  private def: MechDef = MECHS[MECH_IDS[0]];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene.add(new THREE.HemisphereLight('#b9cbe6', '#2a2622', 1.5));
    this.key = new THREE.DirectionalLight('#ffe6c8', 3.2);
    this.key.position.set(-4, 7, -5);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0005;
    this.key.shadow.normalBias = 0.03;
    this.scene.add(this.key, this.key.target);
    // The rim light is the side's colour, from behind, so the outline reads against the dark.
    this.rim = new THREE.DirectionalLight('#58d6ff', 2.4);
    this.rim.position.set(3, 4, 6);
    this.scene.add(this.rim);
    const fill = new THREE.DirectionalLight('#9fb4d0', 0.6);
    fill.position.set(5, 2, -3);
    this.scene.add(fill);

    this.deck = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshStandardMaterial({ map: deckTexture(), transparent: true, roughness: 0.85, metalness: 0.2, depthWrite: false }),
    );
    this.deck.rotation.x = -Math.PI / 2;
    this.deck.receiveShadow = true;
    this.ringMat = new THREE.MeshBasicMaterial({ color: '#58d6ff', transparent: true, opacity: 0.55, toneMapped: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.004;
    this.turntable.add(this.deck, this.ring);
    this.scene.add(this.turntable);

    this.actor = previewActor(0);
    this.kit = createMech(0, 0);
    this.listen();
  }

  /** Dress the stage in a side's suit and mech paint. */
  setSide(side: number): void {
    if (side === this.side) return;
    this.side = side;
    this.avatar?.dispose();
    this.mech?.dispose();
    if (this.avatar) this.turntable.remove(this.avatar.root);
    if (this.mech) this.turntable.remove(this.mech.root);
    // The pilot wears the first patch, as the player does offline.
    this.avatar = new Avatar(side, false, 0);
    // The ally zone colour while it drops in, but no chevron: it is the player's own.
    this.mech = new MechAvatar(side, true, false);
    this.turntable.add(this.avatar.root, this.mech.root);
    this.actor.team = side;
    this.kit = createMech(0, side);
    const look = TEAM_LOOK[side];
    this.rim.color.set(look.visor);
    this.ringMat.color.set(look.visor);
    this.enterMech();
  }

  setView(view: StageView): void {
    if (view === this.view) return;
    this.view = view;
    if (view === 'mech') this.enterMech();
  }

  setPilotPose(pose: PilotPose): void {
    this.pilotPose = pose;
  }

  setMechPose(pose: MechPose): void {
    if (pose === this.mechPose) return;
    this.mechPose = pose;
    // From kneeling it has to start up again; anything else changes in stride.
    if (this.kit.state === 'idle' && pose !== 'standby') {
      this.kit.state = 'boot';
      this.kit.stateTime = 0;
    }
  }

  /** The chosen frame changed (or was picked again): drop it in once more. */
  setMech(id: string): void {
    this.def = MECHS[id] ?? this.def;
    this.enterMech();
  }

  /** Back to the resting three-quarter view. */
  resetView(): void {
    this.yaw = REST_YAW;
    this.yawVel = 0;
    this.tilt = REST_TILT;
    this.zoom = 1;
    this.sinceTouch = 0;
  }

  /** The right stick turns and tilts, the triggers zoom. */
  padLook(pad: Pad, dt: number): void {
    if (pad.index < 0) return;
    const x = pad.lookX;
    const y = pad.lookY;
    if (Math.abs(x) > 0.01 || Math.abs(y) > 0.01) {
      this.yawVel = x * 2.6;
      this.tilt = THREE.MathUtils.clamp(this.tilt - y * 1.4 * dt, -0.15, 0.95);
      this.sinceTouch = 0;
    }
    const zoomIn = pad.down[7] ? 1 : 0;
    const zoomOut = pad.down[6] ? 1 : 0;
    if (zoomIn || zoomOut) {
      this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp((zoomOut - zoomIn) * 1.2 * dt), 0.55, 1.6);
      this.sinceTouch = 0;
    }
  }

  /** Turn the model by a keyboard step (arrow keys on the focused preview). */
  nudge(dYaw: number, dTilt: number): void {
    this.yaw += dYaw;
    this.yawVel = 0;
    this.tilt = THREE.MathUtils.clamp(this.tilt + dTilt, -0.15, 0.95);
    this.sinceTouch = 0;
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.05);
    this.resize();
    this.sinceTouch += dt;

    // The turn: coast after a flick, then rest, then a slow turn on its own.
    if (!this.pointers.size) {
      this.yaw += this.yawVel * dt;
      this.yawVel *= Math.exp(-3.2 * dt);
      if (this.sinceTouch > IDLE_SPIN_DELAY) this.yawVel = damp(this.yawVel, IDLE_SPIN, 1.5, dt);
    }
    this.turntable.rotation.y = this.yaw;

    // The camera eases between the pilot and the mech framing.
    const f = FRAMING[this.view];
    this.frame.target.lerp(f.target, 1 - Math.exp(-6 * dt));
    this.frame.dist = damp(this.frame.dist, f.dist * this.zoom, 6, dt);
    const t = this.frame.target;
    const d = this.frame.dist;
    this.camera.position.set(t.x, t.y + Math.sin(this.tilt) * d, t.z - Math.cos(this.tilt) * d);
    this.camera.lookAt(t);
    const ring = damp(this.ring.scale.x, f.ring, 6, dt);
    this.ring.scale.setScalar(ring);
    this.deck.scale.setScalar(ring * 2.4);
    const sh = this.key.shadow.camera;
    if (sh.right !== f.shadow) {
      sh.left = sh.bottom = -f.shadow;
      sh.right = sh.top = f.shadow;
      sh.near = 1;
      sh.far = 40;
      sh.updateProjectionMatrix();
    }

    this.drivePilot(dt);
    this.driveMech(dt);
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- models

  private drivePilot(dt: number): void {
    const avatar = this.avatar;
    if (!avatar) return;
    const show = this.view === 'pilot';
    avatar.root.visible = show;
    const s = this.actor.p;
    const pose = this.pilotPose;
    s.vel.x = 0;
    s.vel.z = pose === 'run' ? -9 : 0;
    s.yaw = 0;
    s.pitch = pose === 'aim' ? -0.05 : 0;
    s.grounded = true;
    this.actor.ads = pose === 'aim' ? 1 : 0;
    this.actor.punchPitch *= Math.exp(-12 * dt);
    // While aiming it lets off a short burst now and then, so the muzzle and recoil show.
    if (pose === 'aim' && show) {
      this.fireClock += dt;
      if (this.fireClock > 2.2) {
        const n = Math.floor((this.fireClock - 2.2) / 0.11);
        if (n < 4 && this.fireClock - 2.2 - n * 0.11 < dt) {
          avatar.fireFlash();
          this.actor.punchPitch += 0.03;
        }
        if (this.fireClock > 2.2 + 4 * 0.11) this.fireClock = 0;
      }
    } else this.fireClock = 0;
    avatar.update(dt, this.actor, { x: 0, y: 0, z: 0 }, show, pose === 'aim' ? 1 : 0);
  }

  private enterMech(): void {
    const k = this.kit;
    k.state = 'dropping';
    k.stateTime = COMBAT.mech.drop.time * DROP_FROM;
    k.health = this.def.health;
    k.vel.x = k.vel.z = 0;
    k.stride = 0;
    this.landed = false;
    // Force a fresh machine: the avatar resets its pose when it comes out of `none`.
    this.mech?.update(0, { ...k, state: 'none' }, k.pos, 0, 0, false);
  }

  private driveMech(dt: number): void {
    const mech = this.mech;
    if (!mech) return;
    const show = this.view === 'mech';
    const k = this.kit;
    k.stateTime += dt;
    const def = this.def;
    if (k.state === 'dropping' && k.stateTime >= COMBAT.mech.drop.time) {
      k.state = 'idle';
      k.stateTime = 0;
      mech.land(22);
      if (!this.landed && show) this.onLand();
      this.landed = true;
    } else if (k.state === 'idle' && this.mechPose !== 'standby' && k.stateTime > STANDBY_BEFORE_BOOT) {
      k.state = 'boot';
      k.stateTime = 0;
    } else if (k.state === 'boot' && k.stateTime >= COMBAT.mech.embark.time) {
      k.state = 'piloted';
      k.stateTime = 0;
    } else if (k.state === 'piloted' && this.mechPose === 'standby') {
      k.state = 'idle';
      k.stateTime = STANDBY_BEFORE_BOOT;
    }
    const walking = k.state === 'piloted' && this.mechPose === 'walk';
    const speed = walking ? def.move.walkSpeed : 0;
    k.vel.z = -speed;
    k.grounded = true;
    if (walking) {
      // A treadmill: the feet stay put, the stride counts the ground covered.
      this.stride += speed * dt;
      if (this.stride >= def.move.strideLength) {
        this.stride -= def.move.strideLength;
        mech.step();
      }
    }
    k.stride = this.stride;
    mech.update(dt, k, k.pos, 0, 0, show);
    mech.root.visible = show;
  }

  // ---------------------------------------------------------------- input

  private listen(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.pinch = this.spread();
      this.yawVel = 0;
      this.sinceTouch = 0;
    });
    const up = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      this.pinch = this.spread();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.sinceTouch = 0;
      if (this.pointers.size >= 2) {
        const now = this.spread();
        if (this.pinch > 0 && now > 0) this.zoom = THREE.MathUtils.clamp(this.zoom * (this.pinch / now), 0.55, 1.6);
        this.pinch = now;
        return;
      }
      const turn = dx * 0.009;
      this.yaw += turn;
      // Remember the flick, so letting go mid-swing keeps it turning for a moment.
      const gap = Math.max(1 / 240, (e.timeStamp - this.lastMove) / 1000);
      this.lastMove = e.timeStamp;
      this.yawVel = gap < 0.1 ? THREE.MathUtils.clamp(turn / gap, -12, 12) : 0;
      this.tilt = THREE.MathUtils.clamp(this.tilt + dy * 0.005, -0.15, 0.95);
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = THREE.MathUtils.clamp(this.zoom * (1 + Math.sign(e.deltaY) * 0.08), 0.55, 1.6);
        this.sinceTouch = 0;
      },
      { passive: false },
    );
    c.addEventListener('dblclick', () => this.resetView());
  }

  private spread(): number {
    if (this.pointers.size < 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    const pr = this.renderer.getPixelRatio();
    if (this.canvas.width !== Math.floor(w * pr) || this.canvas.height !== Math.floor(h * pr)) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }
}
