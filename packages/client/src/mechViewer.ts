import * as THREE from 'three';
import { COMBAT, FRAMES, FRAME_IDS, createMech, frameIndex, type Mech } from '@dropline/shared';
import { MechAvatar } from './render/mechAvatar';
import { createEnvironment, createRenderer } from './render/scene';

/**
 * Dev page (/mechs.html): the three mech frames side by side on a treadmill,
 * put through every state, with the hitbox and the vent drawn over them. Drag
 * to orbit, wheel to zoom. `window.mechs` drives it from the console.
 */

type State = 'drop' | 'standby' | 'start up' | 'stand' | 'walk' | 'run' | 'dash' | 'jump' | 'stomp' | 'ability' | 'wreck';
const STATES: State[] = ['drop', 'standby', 'start up', 'stand', 'walk', 'run', 'dash', 'jump', 'stomp', 'ability', 'wreck'];

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = createRenderer(canvas);
renderer.autoClear = true;
const scene = new THREE.Scene();
const env = createEnvironment(scene);
env.follow(0, 0, 0);
const hemi = scene.children.find((o): o is THREE.HemisphereLight => o instanceof THREE.HemisphereLight)!;
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1200);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#59585a', roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

interface Stand {
  mech: Mech;
  avatar: MechAvatar | null;
  x: number;
  box: THREE.Group;
  /** Distance walked: drives the stride the way the simulation does. */
  walked: number;
}

const opts = { state: 'stand' as State, team: 0, fire: false, hits: false, spin: false, look: 0, night: false, boxes: false, slow: false };

/** The capsule and vent sphere the simulation hits (shared/sim/mech.ts, rayMech). */
function hitbox(id: string): THREE.Group {
  const F = FRAMES[id];
  const mat = new THREE.MeshBasicMaterial({ color: '#ffd23f', wireframe: true, transparent: true, opacity: 0.3, depthTest: false });
  const ventMat = new THREE.MeshBasicMaterial({ color: '#ff5a3c', wireframe: true, transparent: true, opacity: 0.6, depthTest: false });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(F.body.radius, F.body.height - 2 * F.body.radius, 4, 16), mat);
  body.position.y = F.body.height / 2;
  const vent = new THREE.Mesh(new THREE.SphereGeometry(F.vent.radius, 12, 8), ventMat);
  // Behind the mech, which faces -Z.
  vent.position.set(0, F.vent.height, F.vent.back);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), ventMat);
  eye.position.y = F.body.eye;
  g.add(body, vent, eye);
  g.visible = false;
  return g;
}

const stands: Stand[] = FRAME_IDS.map((id, i) => {
  const box = hitbox(id);
  scene.add(box);
  return { mech: createMech(i, 0, frameIndex(id)), avatar: null, x: (i - 1) * 7, box, walked: 0 };
});

function build(): void {
  for (const s of stands) {
    if (s.avatar) {
      scene.remove(s.avatar.root);
      s.avatar.dispose();
    }
    s.mech = createMech(s.mech.id, opts.team, s.mech.frame);
    s.avatar = new MechAvatar(opts.team, true, FRAMES[FRAME_IDS[s.mech.frame]], false);
    scene.add(s.avatar.root);
  }
  setState(opts.state);
}

let clock = 0;

// --- Panel -------------------------------------------------------------------

const panel = document.getElementById('panel')!;
function button(label: string, pressed: () => boolean, click: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => {
    click();
    refresh();
  });
  (b as HTMLButtonElement & { pressedFn: () => boolean }).pressedFn = pressed;
  panel.append(b);
}
for (const s of STATES) button(s, () => opts.state === s, () => setState(s));
const toggles: [string, keyof typeof opts][] = [
  ['fire', 'fire'],
  ['get hit', 'hits'],
  ['turn', 'spin'],
  ['night', 'night'],
  ['hitbox', 'boxes'],
  ['slow-mo', 'slow'],
];
for (const [label, key] of toggles) button(label, () => opts[key] as boolean, () => ((opts as Record<string, unknown>)[key] = !opts[key]));
const teamSelect = document.createElement('select');
for (const [i, t] of ['Corps paint', 'Z.E.R.O paint'].entries()) teamSelect.add(new Option(t, String(i)));
teamSelect.addEventListener('change', () => {
  opts.team = Number(teamSelect.value);
  build();
});
const lookLabel = document.createElement('label');
lookLabel.textContent = 'look';
const look = document.createElement('input');
look.type = 'range';
look.min = '-0.8';
look.max = '0.8';
look.step = '0.01';
look.value = '0';
look.addEventListener('input', () => (opts.look = Number(look.value)));
lookLabel.append(look);
panel.append(teamSelect, lookLabel);

function refresh(): void {
  for (const b of panel.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String((b as HTMLButtonElement & { pressedFn: () => boolean }).pressedFn()));
  }
  hemi.intensity = opts.night ? 0.25 : 2.4;
  env.sun.intensity = opts.night ? 0.12 : 3.2;
  renderer.toneMappingExposure = opts.night ? 0.8 : 1.05;
  for (const s of stands) s.box.visible = opts.boxes;
}

function setState(st: State): void {
  opts.state = st;
  clock = 0;
  for (const s of stands) {
    const k = s.mech;
    k.state = st === 'wreck' ? 'piloted' : st === 'drop' ? 'dropping' : st === 'standby' ? 'idle' : st === 'start up' ? 'boot' : 'piloted';
    k.stateTime = 0;
    k.grounded = true;
    k.pos.y = 0;
    k.vel.x = k.vel.y = k.vel.z = 0;
    k.shieldUp = false;
    k.cloak = 0;
    k.dashTime = 0;
  }
}

// --- Driving the state ---------------------------------------------------------

/** One fake tick of the chosen state on the treadmill: the feet stay put, the velocity says how fast. */
function drive(s: Stand, dt: number): void {
  const k = s.mech;
  const F = FRAMES[FRAME_IDS[k.frame]];
  const avatar = s.avatar!;
  const st = opts.state;
  k.stateTime += dt;
  // Drop, start-up and wreck loop: run through, hold a beat, start again.
  if (st === 'drop' && k.stateTime > COMBAT.mech.drop.time + 1.5) {
    k.stateTime = 0;
    k.state = 'dropping';
  } else if (st === 'drop' && k.state === 'dropping' && k.stateTime >= COMBAT.mech.drop.time) {
    k.state = 'idle';
    avatar.land(30);
  }
  if (st === 'start up' && k.stateTime > COMBAT.mech.embark.time + 1.2) k.stateTime = 0;
  if (st === 'wreck') {
    if (k.state === 'piloted' && clock > 0.8) {
      k.state = 'none';
      avatar.destroy();
    } else if (k.state === 'none' && clock > 4.4) {
      k.state = 'piloted';
      clock = 0;
    }
  }
  const speed = st === 'walk' ? F.move.walkSpeed : st === 'run' ? F.move.sprintSpeed : 0;
  k.vel.x = 0;
  k.vel.z = -speed;
  k.grounded = true;
  k.pos.y = 0;
  if (speed > 0) {
    // Footfalls where the simulation would put them.
    s.walked += speed * dt;
    if (s.walked >= F.move.strideLength) {
      s.walked -= F.move.strideLength;
      avatar.step();
    }
    k.stride = s.walked;
  }
  // Moves on a loop: the frame's own jump-button move every two seconds.
  const beat = clock % 2;
  const fresh = beat < dt;
  if (st === 'dash') {
    if (F.mobility.kind === 'dash') {
      k.dashTime = beat < F.mobility.time ? F.mobility.time - beat : 0;
      k.dashX = 0;
      k.dashZ = -1;
    }
  }
  if (st === 'jump' || (st === 'dash' && F.mobility.kind === 'leap')) {
    // A leap's arc, or a plain jump for the frames without one.
    const up = 9;
    const t = beat;
    const y = up * t - 13 * t * t;
    k.grounded = y <= 0 && t > 0.1;
    k.vel.y = up - 26 * t;
    k.pos.y = Math.max(0, y);
    if (k.grounded && (s as { air?: boolean }).air) avatar.land(12);
    (s as { air?: boolean }).air = !k.grounded;
  }
  if ((st === 'stomp' || (st === 'dash' && F.mobility.kind === 'stomp')) && fresh) avatar.stomp();
  if (st === 'ability') {
    const A = F.ability;
    if (A.kind === 'shield') {
      k.shieldUp = true;
      k.shield = A.health * (0.4 + 0.6 * Math.abs(Math.cos(clock * 0.4)));
    } else if (A.kind === 'cloak') k.cloak = beat < 1.4 ? 1 : 0;
    else if (fresh) for (let i = 0; i < A.count; i++) setTimeout(() => avatar.podFlash(), i * A.interval * 1000);
  }
  k.yaw = opts.spin ? Math.sin(performance.now() / 1600) * 1.4 : 0;
}

let lastShot = 0;
let lastHit = 0;
let yaw = 0.6;
let tilt = 0.22;
let dist = 26;
/** The x the camera orbits: 0 for all three, or one frame's stand. */
let focus = 0;
let last = performance.now();
let manual = false;
const tmp = new THREE.Vector3();

function frame(now: number): void {
  // A frame's timestamp can fall before the last hand-stepped one; never run time backwards.
  let dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (opts.slow) dt *= 0.25;
  clock += dt;
  const shoot = opts.fire && clock - lastShot > 0.35;
  if (shoot) lastShot = clock;
  if (lastShot > clock) lastShot = 0;
  const hurt = opts.hits && clock - lastHit > 0.8;
  if (hurt) lastHit = clock;
  if (lastHit > clock) lastHit = 0;

  for (const s of stands) {
    drive(s, dt);
    const k = s.mech;
    const avatar = s.avatar!;
    if (shoot && k.state === 'piloted') avatar.fireFlash();
    if (hurt && k.state === 'piloted') avatar.flash(Math.random() < 0.3);
    const pos = { x: s.x, y: k.pos.y, z: 0 };
    avatar.update(dt, k, pos, k.yaw, opts.look, true);
    s.box.position.set(pos.x, pos.y, pos.z);
    s.box.rotation.y = k.yaw;
  }

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const target = tmp.set(focus, 2.6, 0);
  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(tilt) * dist,
    target.y + Math.sin(tilt) * dist,
    target.z + Math.cos(yaw) * Math.cos(tilt) * dist,
  );
  camera.lookAt(target);
  renderer.render(scene, camera);
  if (!manual) requestAnimationFrame(frame);
}

let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= e.movementX * 0.008;
  tilt = Math.max(-0.1, Math.min(1.3, tilt + e.movementY * 0.006));
});
canvas.addEventListener('wheel', (e) => (dist = Math.max(4, Math.min(60, dist * (1 + Math.sign(e.deltaY) * 0.1)))));

build();
refresh();
requestAnimationFrame(frame);

// Console hooks for checking poses without the mouse.
(window as unknown as { mechs: unknown }).mechs = {
  opts,
  setState: (s: State) => {
    setState(s);
    refresh();
  },
  setTeam: (t: number) => {
    opts.team = t;
    teamSelect.value = String(t);
    build();
  },
  refresh,
  view(y: number, t: number, d: number, x = 0) {
    yaw = y;
    tilt = t;
    dist = d;
    focus = x;
  },
  /** Stop the frame loop and step it by hand: `mechs.step(1/60, 30)`. */
  step(dt: number, n = 1) {
    manual = true;
    for (let i = 0; i < n; i++) {
      last = performance.now() - dt * 1000;
      frame(performance.now());
    }
  },
  stands,
};
