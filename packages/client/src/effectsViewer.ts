import * as THREE from 'three';
import { FRAMES, createMech, frameIndex, type Mech, type Vec3 } from '@dropline/shared';
import { Effects, type Surfaces } from './render/effects';
import { MechAvatar } from './render/mechAvatar';
import { createEnvironment, createRenderer } from './render/scene';

/**
 * Dev page (/effects.html): every combat effect on its own, against a floor
 * and a wall, in the game's light. Pick one to play it, `loop` to repeat it.
 * Drag to orbit, wheel to zoom. The corner shows what is alive and what a
 * frame of effects costs. `window.effects` drives it from the console.
 */

type Shot = 'rifle hits' | 'cannon hits' | 'rocket: floor' | 'rocket: wall' | 'rocket: air' | 'flak' | 'pilot down' | 'steam' | 'footfalls' | 'thrust' | 'mech drop' | 'stomp' | 'damaged mech' | 'mech destroyed';
const SHOTS: Shot[] = ['rifle hits', 'cannon hits', 'rocket: floor', 'rocket: wall', 'rocket: air', 'flak', 'pilot down', 'steam', 'footfalls', 'thrust', 'mech drop', 'stomp', 'damaged mech', 'mech destroyed'];
/** Seconds before a looping effect plays again; the wreck burns out in full first. */
const LOOP = 2.5;
const WRECK_LOOP = 17.5;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = createRenderer(canvas);
renderer.autoClear = true;
const scene = new THREE.Scene();
const env = createEnvironment(scene);
env.follow(0, 0, 0);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1200);

/** The stage: a floor and a wall behind it, as boxes the effects can hit. */
const BOXES: { min: Vec3; max: Vec3 }[] = [
  { min: { x: -40, y: -1, z: -40 }, max: { x: 40, y: 0, z: 40 } },
  { min: { x: -12, y: 0, z: -9 }, max: { x: 12, y: 7, z: -8 } },
];
const concrete = new THREE.MeshStandardMaterial({ color: '#6b6966', roughness: 0.92 });
for (const b of BOXES) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z), concrete);
  mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  scene.add(mesh);
}

/** Rays against the stage's boxes (slab test), standing in for the map's collision world. */
const surfaces: Surfaces = {
  castRay(o, d, maxDist) {
    let best: { dist: number; normal: Vec3 } | null = null;
    for (const b of BOXES) {
      let near = -Infinity;
      let far = Infinity;
      let axis = 0;
      let sign = 0;
      const keys = ['x', 'y', 'z'] as const;
      let miss = false;
      for (let i = 0; i < 3; i++) {
        const k = keys[i];
        if (Math.abs(d[k]) < 1e-9) {
          if (o[k] < b.min[k] || o[k] > b.max[k]) miss = true;
          continue;
        }
        let t0 = (b.min[k] - o[k]) / d[k];
        let t1 = (b.max[k] - o[k]) / d[k];
        let s = -1;
        if (t0 > t1) {
          [t0, t1] = [t1, t0];
          s = 1;
        }
        if (t0 > near) {
          near = t0;
          axis = i;
          sign = s;
        }
        far = Math.min(far, t1);
      }
      if (miss || near > far || far < 0) continue;
      // Starting inside a box counts as a hit at once, as the collision world does.
      const t = Math.max(0, near);
      if (t > maxDist || (best && best.dist <= t)) continue;
      best = { dist: t, normal: { x: axis === 0 ? sign : 0, y: axis === 1 ? sign : 0, z: axis === 2 ? sign : 0 } };
    }
    return best;
  },
};

const fx = new Effects(scene, env, surfaces);
const opts = { shot: 'rocket: floor' as Shot, loop: true, night: false, slow: false, team: 0 };

// A mech for the hull smoke and the wreck, standing on the floor in front of the wall.
let mech: Mech = createMech(0, 0, frameIndex('halberd'));
let avatar: MechAvatar | null = null;
const burn = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
function buildMech(): void {
  if (avatar) {
    scene.remove(avatar.root);
    avatar.dispose();
  }
  mech = createMech(0, opts.team, frameIndex('halberd'));
  mech.state = 'piloted';
  mech.grounded = true;
  avatar = new MechAvatar(opts.team, true, FRAMES.halberd, false);
  scene.add(avatar.root);
}

let clock = 0;
let since = 0;
/** The mech is on stage for this effect. */
let mechShot = false;

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const UP = v(0, 1, 0);
const muzzle = new THREE.Vector3();
const target = new THREE.Vector3(0, 2, -3);

/** Play the chosen effect once, from the start. */
function play(): void {
  since = 0;
  const s = opts.shot;
  mechShot = s === 'damaged mech' || s === 'mech destroyed';
  if (avatar) avatar.root.visible = mechShot;
  if (mechShot) {
    buildMech();
    mech.health = s === 'damaged mech' ? FRAMES.halberd.health * 0.15 : FRAMES.halberd.health;
  }
  switch (s) {
    case 'rifle hits':
    case 'cannon hits': {
      const heavy = s === 'cannon hits';
      for (let i = 0; i < (heavy ? 4 : 7); i++) {
        setTimeout(() => {
          const wall = i % 2 === 0;
          const at = wall ? v(-3 + Math.random() * 6, 0.8 + Math.random() * 3, -8) : v(-3 + Math.random() * 6, 0, -4 + Math.random() * 3);
          fx.tracer(muzzle.set(6, 1.6, 6), at, heavy ? '#ffb38a' : '#ffe2b0', heavy ? 0.09 : 0.04);
          fx.flash(muzzle, 4);
          fx.impact(at, wall ? v(0, 0, 1) : UP, heavy);
        }, i * (heavy ? 160 : 110));
      }
      break;
    }
    case 'rocket: floor':
      fx.explosion(v(0, 0, -3), UP, 3.2);
      break;
    case 'rocket: wall':
      fx.explosion(v(0, 2.2, -8), v(0, 0, 1), 3.2);
      break;
    case 'rocket: air':
      fx.explosion(v(0, 4, -2), null, 3.8);
      break;
    case 'flak':
      fx.explosion(v(-1.5, 3.5, -2), null, 3, true);
      setTimeout(() => fx.explosion(v(1.8, 4.4, -3), null, 3, true), 140);
      break;
    case 'pilot down':
      fx.downed(v(0, 1.1, -2), opts.team === 0 ? '#58d6ff' : '#ff2a3c');
      break;
    case 'steam':
      for (let i = 0; i < 6; i++) setTimeout(() => fx.steam(v(0, 1.3, -2), 4), i * 60);
      break;
    case 'footfalls':
      for (let i = 0; i < 4; i++) setTimeout(() => fx.footfall(v(-3 + i * 2, 0, -2 + (i % 2) * 1.4), i === 3), i * 420);
      break;
    case 'thrust':
      fx.thrust(v(0, 0.4, -2), 2.5);
      break;
    case 'mech drop':
      fx.mechLand(v(0, 0, -2), 3.4 * 1.7, opts.team === 0 ? '#58d6ff' : '#ff3b2f');
      break;
    case 'stomp':
      fx.stomp(v(0, 0, -2), 8, opts.team === 0 ? '#58d6ff' : '#ff3b2f');
      break;
    case 'damaged mech':
    case 'mech destroyed':
      break;
  }
}

function frame(dt: number): void {
  if (opts.slow) dt *= 0.25;
  clock += dt;
  since += dt;
  const s = opts.shot;
  if (opts.loop && since > (s === 'mech destroyed' ? WRECK_LOOP : s === 'damaged mech' ? Infinity : LOOP)) play();

  if (avatar && mechShot) {
    if (s === 'mech destroyed' && mech.state === 'piloted' && since > 0.8) {
      mech.state = 'none';
      avatar.destroy();
      fx.mechDeath(mech.pos, opts.team);
    }
    avatar.update(dt, mech, { x: 0, y: 0, z: -2 }, 0.5, 0, true);
    const heat = avatar.wreckHeat;
    if (mech.state === 'none' && heat > 0) fx.wreckBurn(burn, avatar.burnPoints(burn), heat, dt);
    if (mech.state !== 'none') fx.hullSmoke(avatar.ventWorld(muzzle), 1 - mech.health / FRAMES.halberd.health, dt);
  }

  const t0 = performance.now();
  fx.update(dt, camera);
  const cost = performance.now() - t0;

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  camera.position.set(target.x + Math.sin(yaw) * Math.cos(tilt) * dist, target.y + Math.sin(tilt) * dist, target.z + Math.cos(yaw) * Math.cos(tilt) * dist);
  camera.lookAt(target);
  renderer.render(scene, camera);
  worst = Math.max(worst * 0.995, cost);
  const c = fx.counts;
  stats.textContent = `smoke ${c.smoke}  fire ${c.fire}  sparks ${c.sparks}  debris ${c.debris}\nfx.update ${cost.toFixed(2)} ms (worst ${worst.toFixed(2)})  draw calls ${renderer.info.render.calls}`;
}

// --- Panel and camera -----------------------------------------------------------

const panel = document.getElementById('panel')!;
const stats = document.getElementById('stats')!;
const buttons: [HTMLButtonElement, () => boolean][] = [];
function button(label: string, pressed: () => boolean, click: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => {
    click();
    refresh();
  });
  buttons.push([b, pressed]);
  panel.append(b);
}
for (const s of SHOTS) button(s, () => opts.shot === s, () => choose(s));
button('loop', () => opts.loop, () => (opts.loop = !opts.loop));
button('night', () => opts.night, () => (opts.night = !opts.night));
button('slow-mo', () => opts.slow, () => (opts.slow = !opts.slow));
button('Z.E.R.O', () => opts.team === 1, () => {
  opts.team = 1 - opts.team;
  play();
});

function choose(s: Shot): void {
  opts.shot = s;
  fx.clear();
  play();
}

function refresh(): void {
  for (const [b, pressed] of buttons) b.setAttribute('aria-pressed', String(pressed()));
  env.hemi.intensity = opts.night ? 0.25 : 2.4;
  env.sun.intensity = opts.night ? 0.12 : 3.2;
  renderer.toneMappingExposure = opts.night ? 0.8 : 1.05;
}

let yaw = 0.35;
let tilt = 0.2;
let dist = 13;
let worst = 0;
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

let manual = false;
let last = performance.now();
function loop(now: number): void {
  if (!manual) frame(Math.min(0.05, Math.max(0, (now - last) / 1000)));
  last = now;
  requestAnimationFrame(loop);
}

buildMech();
choose(opts.shot);
refresh();
requestAnimationFrame(loop);

// Console hooks for screenshots and timing without the mouse.
(window as unknown as { effects: unknown }).effects = {
  opts,
  fx,
  choose: (s: Shot) => {
    choose(s);
    refresh();
  },
  refresh,
  view(y: number, t: number, d: number) {
    yaw = y;
    tilt = t;
    dist = d;
  },
  /** Stop the frame loop and step it by hand: `effects.step(1/60, 30)`. */
  step(dt: number, n = 1) {
    manual = true;
    for (let i = 0; i < n; i++) frame(dt);
  },
};
