import * as THREE from 'three';
import { COMBAT, WEAPONS, createPlayerState, type Actor } from '@dropline/shared';
import { Avatar } from './render/avatar';
import { createEnvironment, createRenderer } from './render/scene';
import { Viewmodel } from './render/viewmodel';

/**
 * Dev page (/suits.html): both pilot suits side by side on a treadmill, put
 * through every movement state, with the hitbox drawn over them. Drag to orbit,
 * wheel to zoom. `window.suits` drives it from the console.
 */

type State =
  | 'idle'
  | 'walk'
  | 'sprint'
  | 'crouch'
  | 'crouch walk'
  | 'slide'
  | 'wallrun L'
  | 'wallrun R'
  | 'jump'
  | 'double jump'
  | 'jetpack'
  | 'mantle'
  | 'death';
const STATES: State[] = ['idle', 'walk', 'sprint', 'crouch', 'crouch walk', 'slide', 'wallrun L', 'wallrun R', 'jump', 'double jump', 'jetpack', 'mantle', 'death'];

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = createRenderer(canvas);
renderer.autoClear = true;
const scene = new THREE.Scene();
const env = createEnvironment(scene);
env.follow(0, 0, 0);
const hemi = scene.children.find((o): o is THREE.HemisphereLight => o instanceof THREE.HemisphereLight)!;
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 800);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: '#59585a', roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const wallMat = new THREE.MeshStandardMaterial({ color: '#4a4c50', roughness: 0.85 });
const walls = [-1, 1].map((x) => {
  const w = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 2.4), wallMat);
  w.position.set(x, 1.75, 0);
  w.receiveShadow = true;
  w.visible = false;
  scene.add(w);
  return w;
});

interface Pilot {
  actor: Actor;
  avatar: Avatar;
  x: number;
  box: THREE.Group;
}

/** The hitbox as the sim uses it (shared/sim/hitscan.ts), for a pilot `height` tall. */
function hitboxShape(height: number, mat: THREE.Material): THREE.Group {
  const H = COMBAT.hitbox;
  const g = new THREE.Group();
  const top = Math.max(H.bodyRadius, height - H.neck - H.bodyRadius);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(H.bodyRadius, top - H.bodyRadius, 4, 12), mat);
  body.position.y = (H.bodyRadius + top) / 2;
  const head = new THREE.Mesh(new THREE.SphereGeometry(H.headRadius, 12, 8), mat);
  head.position.y = height - H.headDrop;
  g.add(body, head);
  return g;
}

/** Standing and crouched hitboxes; the viewer shows the one that fits the state. */
function hitbox(): THREE.Group {
  const mat = new THREE.MeshBasicMaterial({ color: '#ffd23f', wireframe: true, transparent: true, opacity: 0.35, depthTest: false });
  const g = new THREE.Group();
  g.add(hitboxShape(1.8, mat), hitboxShape(1.0, mat));
  g.visible = false;
  return g;
}

const pilots: Pilot[] = [0, 1].map((team, i) => {
  const actor = {
    id: i,
    team,
    p: createPlayerState({ x: 0, y: 0, z: 0 }),
    alive: true,
    loadout: ['carbine', 'scattergun', 'longshot', 'pike'],
    ammo: ['carbine', 'scattergun', 'longshot', 'pike'].map((id) => WEAPONS[id].magSize),
    equip: 0,
    ads: 0,
    weapon: 0,
    punchPitch: 0,
    reload: 0,
  } as unknown as Actor;
  actor.p.grounded = true;
  const avatar = new Avatar(team, false, 2);
  scene.add(avatar.root);
  const box = hitbox();
  scene.add(box);
  return { actor, avatar, x: i === 0 ? -0.9 : 0.9, box };
});

const opts = {
  state: 'idle' as State,
  aim: false,
  pitch: 0,
  weapon: 0,
  reload: false,
  fire: false,
  hits: false,
  spin: false,
  night: false,
  boxes: false,
  slow: false,
  /** 'suits': both pilots on the floor; 'arm': a close look at the first-person arm; 'first person': the arm as in play. */
  view: 'suits' as 'suits' | 'arm' | 'first person',
  /** Whose arm the first-person views show. */
  armTeam: 0,
};
let clock = 0;

// --- Panel -------------------------------------------------------------------

const panel = document.getElementById('panel')!;
const stateButtons = new Map<State, HTMLButtonElement>();
function button(label: string, pressed: () => boolean, click: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => {
    click();
    refresh();
  });
  b.dataset.pressed = '';
  (b as HTMLButtonElement & { pressedFn: () => boolean }).pressedFn = pressed;
  panel.append(b);
  return b;
}
for (const s of STATES) stateButtons.set(s, button(s, () => opts.state === s, () => setState(s)));
const toggles: [string, keyof typeof opts][] = [
  ['aim', 'aim'],
  ['reload', 'reload'],
  ['fire', 'fire'],
  ['get hit', 'hits'],
  ['turn', 'spin'],
  ['night', 'night'],
  ['hitbox', 'boxes'],
  ['slow-mo', 'slow'],
];
for (const [label, key] of toggles) button(label, () => opts[key] as boolean, () => ((opts as Record<string, unknown>)[key] = !opts[key]));
const weaponSelect = document.createElement('select');
for (const [i, w] of ['carbine', 'scattergun', 'longshot', 'pike (pod)'].entries()) weaponSelect.add(new Option(w, String(i)));
weaponSelect.addEventListener('change', () => (opts.weapon = Number(weaponSelect.value)));
panel.append(weaponSelect);
const pitchLabel = document.createElement('label');
pitchLabel.textContent = 'look';
const pitch = document.createElement('input');
pitch.type = 'range';
pitch.min = '-1.2';
pitch.max = '1.2';
pitch.step = '0.01';
pitch.value = '0';
pitch.addEventListener('input', () => (opts.pitch = Number(pitch.value)));
pitchLabel.append(pitch);
panel.append(pitchLabel);
const viewSelect = document.createElement('select');
for (const v of ['suits', 'arm', 'first person']) viewSelect.add(new Option(v, v));
viewSelect.addEventListener('change', () => (opts.view = viewSelect.value as typeof opts.view));
const teamSelect = document.createElement('select');
for (const [i, t] of ['Corps arm', 'Z.E.R.O arm'].entries()) teamSelect.add(new Option(t, String(i)));
teamSelect.addEventListener('change', () => (opts.armTeam = Number(teamSelect.value)));
panel.append(viewSelect, teamSelect);

function refresh(): void {
  for (const b of panel.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String((b as HTMLButtonElement & { pressedFn: () => boolean }).pressedFn()));
  }
  hemi.intensity = opts.night ? 0.25 : 2.4;
  env.sun.intensity = opts.night ? 0.12 : 3.2;
  renderer.toneMappingExposure = opts.night ? 0.8 : 1.05;
  for (const p of pilots) p.box.visible = opts.boxes;
  const wall = opts.state === 'wallrun L' || opts.state === 'wallrun R';
  walls[0].visible = walls[1].visible = wall;
}

function setState(s: State): void {
  opts.state = s;
  clock = 0;
  for (const p of pilots) {
    p.actor.alive = true;
    p.actor.p.pos.y = 0;
    p.actor.p.vel.y = 0;
  }
}

// --- Driving the state -----------------------------------------------------------

/** One fake tick of the chosen state on the treadmill: the feet stay put, the velocity says how fast. */
function drive(p: Pilot, dt: number): void {
  const a = p.actor;
  const s = a.p;
  const st = opts.state;
  s.crouched = st === 'crouch' || st === 'crouch walk' || st === 'slide';
  s.sliding = st === 'slide';
  s.thrusting = st === 'jetpack';
  s.wallrun.active = st === 'wallrun L' || st === 'wallrun R';
  s.wallrun.side = st === 'wallrun L' ? -1 : 1;
  s.mantle.active = st === 'mantle' && clock % 1.4 < 0.35;
  const speed =
    st === 'walk' ? 5.5 : st === 'sprint' ? 9 : st === 'crouch walk' ? 2.8 : st === 'slide' ? 11 : s.wallrun.active ? 11.5 : st === 'jetpack' ? 4 : 0;
  // Running "forward" along -Z; the body turns to match when momentum decides facing.
  s.vel.x = 0;
  s.vel.z = -speed;
  if (st === 'jump' || st === 'double jump') {
    // Jump, (jump again at the top), fall, land, stand a beat, repeat.
    if (s.grounded) {
      if (clock > 0.7) {
        s.grounded = false;
        s.vel.y = 7;
        clock = 0;
        (s as { dbl?: boolean }).dbl = false;
      }
    } else {
      s.vel.y -= 20 * dt;
      if (st === 'double jump' && !(s as { dbl?: boolean }).dbl && s.vel.y < 0.5) {
        s.vel.y = 7.4;
        (s as { dbl?: boolean }).dbl = true;
      }
      s.pos.y += s.vel.y * dt;
      if (s.pos.y <= 0) {
        s.pos.y = 0;
        s.vel.y = 0;
        s.grounded = true;
        clock = 0;
      }
    }
  } else {
    s.grounded = !s.wallrun.active && st !== 'jetpack' && !s.mantle.active;
    s.vel.y = st === 'jetpack' ? 1 : 0;
    s.pos.y = s.wallrun.active ? 0.8 : st === 'jetpack' ? 1.2 : st === 'mantle' ? 0.2 : 0;
  }
  if (st === 'death' && a.alive && clock > 0.8) a.alive = false;
  if (st === 'death' && !a.alive && clock > 3.6) {
    a.alive = true;
    clock = 0;
  }
  s.yaw = opts.spin ? Math.sin(performance.now() / 1400) * 1.6 : 0;
  s.pitch = opts.pitch;
  // Changing weapons takes the weapon's own time, as in play.
  if (a.weapon !== opts.weapon) {
    a.weapon = opts.weapon;
    a.equip = WEAPONS[a.loadout[a.weapon]].equipTime;
  }
  a.equip = Math.max(0, a.equip - dt);
  // Reloading runs its full time, refills, and starts again after a beat.
  const def = WEAPONS[a.loadout[a.weapon]];
  if (opts.reload) {
    if (a.reload > 0) {
      a.reload -= dt;
      if (a.reload <= 0) a.ammo[a.weapon] = def.magSize;
    } else if (a.reload > -0.6) a.reload -= dt;
    else a.reload = def.reloadTime;
  } else a.reload = 0;
  a.punchPitch *= Math.exp(-12 * dt);
}

let lastShot = 0;
let lastHit = 0;
let yaw = 0.5;
let tilt = 0.18;
let dist = 5.2;
let last = performance.now();
const vm = new Viewmodel();
const armCam = new THREE.PerspectiveCamera(40, 1, 0.01, 10);
let armDist = 0.6;

function frame(now: number): void {
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (opts.slow) dt *= 0.25;
  clock += dt;
  const shoot = opts.fire && clock - lastShot > 0.18;
  if (shoot) lastShot = clock;
  if (lastShot > clock) lastShot = 0;
  const hurt = opts.hits && clock - lastHit > 0.9;
  if (hurt) lastHit = clock;
  if (lastHit > clock) lastHit = 0;

  for (const p of pilots) {
    drive(p, dt);
    const s = p.actor.p;
    const pos = { x: p.x, y: s.pos.y, z: 0 };
    if (shoot) {
      const a = p.actor;
      a.ammo[a.weapon] = a.ammo[a.weapon] > 1 ? a.ammo[a.weapon] - 1 : WEAPONS[a.loadout[a.weapon]].magSize;
      p.avatar.fireFlash();
      p.actor.punchPitch += 0.03;
    }
    if (hurt) p.avatar.flinch();
    // In first person the viewer is that pilot, so their own body is hidden, as in play.
    const own = opts.view === 'first person' && p === pilots[opts.armTeam];
    p.avatar.update(dt, p.actor, pos, !own, opts.aim || opts.fire || opts.weapon === 3 ? 1 : 0);
    p.box.position.set(pos.x, pos.y, pos.z);
    p.box.children[0].visible = !s.crouched;
    p.box.children[1].visible = s.crouched;
  }
  if (opts.state === 'wallrun L' || opts.state === 'wallrun R') {
    const side = opts.state === 'wallrun L' ? -1 : 1;
    walls[0].position.x = pilots[0].x + side * 0.6;
    walls[1].position.x = pilots[1].x + side * 0.6;
  }

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    vm.resize(w / h);
    armCam.aspect = w / h;
    armCam.updateProjectionMatrix();
  }
  if (opts.view !== 'suits') {
    const a = pilots[opts.armTeam].actor;
    // The reload reads its progress as negative while waiting, which the arm must not see.
    const reload = a.reload;
    a.reload = Math.max(0, reload);
    vm.setTeam(opts.armTeam);
    vm.update(dt, a, 0, 0, null);
    a.reload = reload;
    if (shoot) vm.fire();
  }
  if (opts.view === 'arm') {
    // Orbit the arm where it hangs in the first-person scene.
    const at = new THREE.Vector3(0.16, -0.17, -0.62);
    armCam.position.set(
      at.x + Math.sin(yaw) * Math.cos(tilt) * armDist,
      at.y + Math.sin(tilt) * armDist,
      at.z + Math.cos(yaw) * Math.cos(tilt) * armDist,
    );
    armCam.lookAt(at);
    renderer.setClearColor('#2a323c');
    renderer.render(vm.scene, armCam);
    if (!manual) requestAnimationFrame(frame);
    return;
  }
  if (opts.view === 'first person') {
    const p = pilots[opts.armTeam];
    camera.position.set(p.x, p.actor.p.pos.y + 1.62, 0);
    camera.rotation.set(opts.pitch, 0, 0);
    renderer.render(scene, camera);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(vm.scene, vm.camera);
    renderer.autoClear = true;
    if (!manual) requestAnimationFrame(frame);
    return;
  }
  const target = new THREE.Vector3(0, 1.0, 0);
  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(tilt) * dist,
    target.y + Math.sin(tilt) * dist,
    target.z + Math.cos(yaw) * Math.cos(tilt) * dist,
  );
  camera.lookAt(target);
  renderer.render(scene, camera);
  if (!manual) requestAnimationFrame(frame);
}

let manual = false;
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= e.movementX * 0.008;
  tilt = Math.max(-0.2, Math.min(1.3, tilt + e.movementY * 0.006));
});
canvas.addEventListener('wheel', (e) => {
  if (opts.view === 'arm') armDist = Math.max(0.2, Math.min(2, armDist * (1 + Math.sign(e.deltaY) * 0.1)));
  else dist = Math.max(1.5, Math.min(14, dist * (1 + Math.sign(e.deltaY) * 0.1)));
});

refresh();
requestAnimationFrame(frame);

// Console hooks for checking poses without the mouse.
(window as unknown as { suits: unknown }).suits = {
  opts,
  setState: (s: State) => {
    setState(s);
    refresh();
  },
  refresh,
  view(y: number, t: number, d: number) {
    yaw = y;
    tilt = t;
    dist = d;
  },
  /** Stop the frame loop and step it by hand: `suits.step(1/60, 30)`. */
  step(dt: number, n = 1) {
    manual = true;
    for (let i = 0; i < n; i++) {
      last = performance.now() - dt * 1000;
      frame(performance.now());
    }
  },
  pilots,
};
