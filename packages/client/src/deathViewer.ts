import * as THREE from 'three';
import { CollisionWorld, WEAPONS, createPlayerState, type Actor, type MapBox, type MapData } from '@dropline/shared';
import { Avatar } from './render/avatar';
import { Effects } from './render/effects';
import { Ragdolls } from './render/pilot/ragdoll';
import { createEnvironment, createRenderer } from './render/scene';

/**
 * Dev page (/deaths.html): a pilot killed in each way it can die in one
 * piece, to watch the ragdoll take over: standing, running, sliding, in the
 * air (the jet pack runs away with the body), off a ledge. Drag to orbit,
 * wheel to zoom; the camera follows the pilot and then the body.
 * `window.deaths` drives it from the console.
 */

type Death =
  | 'shot in the chest'
  | 'headshot'
  | 'shot in the back'
  | 'scattergun point blank'
  | 'sprinting'
  | 'strafing'
  | 'sliding'
  | 'jumping'
  | 'jetpack'
  | 'wallrun'
  | 'on a ledge';
const DEATHS: Death[] = ['shot in the chest', 'headshot', 'shot in the back', 'scattergun point blank', 'sprinting', 'strafing', 'sliding', 'jumping', 'jetpack', 'wallrun', 'on a ledge'];

const BOXES: MapBox[] = [
  { id: 'floor', pos: [0, -0.5, 0], size: [80, 1, 80], mat: 'concrete' },
  { id: 'wall', pos: [-6, 3, -4], size: [0.6, 6, 24], mat: 'concrete' },
  { id: 'ledge', pos: [8, 1.5, 0], size: [4, 3, 6], mat: 'concrete' },
  { id: 'crate', pos: [2.5, 0.5, -9], size: [1.6, 1, 1.6], mat: 'concrete' },
];
const MAP = { name: 'deaths', spawns: [], boxes: BOXES } as MapData;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = createRenderer(canvas);
renderer.autoClear = true;
const scene = new THREE.Scene();
const env = createEnvironment(scene);
env.follow(0, 0, 0);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 600);
const concrete = new THREE.MeshStandardMaterial({ color: '#6b6966', roughness: 0.92 });
for (const b of BOXES) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]), concrete);
  mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
}

const world = await CollisionWorld.create(MAP);
const fx = new Effects(scene, env, world);
const ragdolls = new Ragdolls(scene, BOXES, {
  settled: (at, team) => fx.bleedOut(at, team),
  jet: (at, dir, burst) => fx.runawayJet(at, dir, burst),
  jetOut: (at) => fx.jetOut(at),
});

const opts = { death: 'shot in the chest' as Death, team: 0, slow: false, loop: true };
let avatar: Avatar;
let actor: Actor;
let clock = 0;
let killed = false;
const KILL_AT = 0.9;
const LOOP = 6;

function newPilot(): void {
  if (avatar) {
    scene.remove(avatar.root);
    avatar.dispose();
  }
  actor = {
    id: 0,
    team: opts.team,
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
  avatar = new Avatar(opts.team, false, 3);
  scene.add(avatar.root);
}

/** Where the pilot starts and how it moves for each death. */
function start(): void {
  ragdolls.clear();
  fx.clear();
  newPilot();
  clock = 0;
  killed = false;
  const s = actor.p;
  s.grounded = true;
  const d = opts.death;
  const at = d === 'on a ledge' ? [9.5, 3, 0] : d === 'wallrun' ? [-5.3, 1.2, 8] : d === 'sprinting' || d === 'sliding' ? [0, 0, 9] : [0, 0, 0];
  s.pos.x = at[0];
  s.pos.y = at[1];
  s.pos.z = at[2];
  // Facing the shooter, who stands off at -Z, except where noted.
  s.yaw = d === 'shot in the back' ? Math.PI : d === 'on a ledge' ? Math.PI / 2 : 0;
}

function drive(dt: number): void {
  const s = actor.p;
  const d = opts.death;
  s.vel.x = s.vel.z = 0;
  s.sliding = d === 'sliding' && clock > 0.4;
  s.crouched = s.sliding;
  s.wallrun.active = d === 'wallrun';
  s.wallrun.side = -1;
  s.thrusting = d === 'jetpack';
  if (d === 'sprinting') s.vel.z = -9;
  if (d === 'sliding') s.vel.z = s.sliding ? -11 : -9;
  if (d === 'strafing') s.vel.x = 5.5 * Math.sign(Math.sin(clock * 1.6) || 1);
  if (d === 'wallrun') {
    s.vel.z = -11;
    s.grounded = false;
  }
  if (d === 'jetpack') {
    s.grounded = false;
    s.vel.y = clock < 0.4 ? 6 : 1.5;
    s.vel.z = -3;
  }
  if (d === 'jumping') {
    if (s.grounded && clock > 0.2) {
      s.grounded = false;
      s.vel.y = 8;
    }
    s.vel.z = -6;
  }
  if (!s.grounded && d !== 'jetpack' && d !== 'wallrun') s.vel.y -= 20 * dt;
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;
  if (d === 'jumping' && s.pos.y < 0) {
    s.pos.y = 0;
    s.grounded = true;
  }
  if (s.sliding || d === 'sprinting' || d === 'sliding') s.yaw = 0;
}

function kill(): void {
  const s = actor.p;
  const d = opts.death;
  const chest = new THREE.Vector3(s.pos.x, s.pos.y + 1.25, s.pos.z);
  const at = d === 'headshot' ? chest.clone().setY(s.pos.y + 1.66) : chest;
  const shooter = new THREE.Vector3(0, 1.5, -14);
  if (d === 'on a ledge') shooter.set(0, 3, 0);
  const dir = at.clone().sub(shooter).normalize();
  const damage = d === 'scattergun point blank' ? 80 : d === 'headshot' ? 60 : 28;
  avatar.update(0, actor, s.pos, true, 0);
  fx.wound(at, dir, opts.team, damage, d === 'headshot');
  avatar.wound(at, dir, damage);
  actor.alive = false;
  fx.downed(chest, avatar.fallDir(new THREE.Vector3()), opts.team, false);
  ragdolls.spawn(0, avatar.corpse(opts.team, s.vel), { at, dir, power: Math.min(45, 12 + damage * 0.5) }, !s.grounded);
}

const target = new THREE.Vector3(0, 1, 0);
let yaw = 0.9;
let tilt = 0.25;
let dist = 5;
let last = performance.now();
let manual = false;
const hips = new THREE.Vector3();

function frame(now: number): void {
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (opts.slow) dt *= 0.25;
  clock += dt;
  if (!killed) {
    drive(dt);
    if (clock >= KILL_AT) {
      kill();
      killed = true;
    }
  }
  avatar.update(dt, actor, actor.p.pos, true, 0);
  ragdolls.update(dt);
  fx.update(dt, camera);
  if (opts.loop && clock > LOOP) start();

  const follow = killed ? ragdolls.hipsOf(0, hips) : hips.set(actor.p.pos.x, actor.p.pos.y + 1, actor.p.pos.z);
  if (follow) target.lerp(follow, 1 - Math.exp(-6 * dt));
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  camera.position.set(target.x + Math.sin(yaw) * Math.cos(tilt) * dist, target.y + Math.sin(tilt) * dist, target.z + Math.cos(yaw) * Math.cos(tilt) * dist);
  camera.lookAt(target);
  env.follow(target.x, target.y, target.z);
  renderer.render(scene, camera);
  if (!manual) requestAnimationFrame(frame);
}

const panel = document.getElementById('panel')!;
const buttons: [HTMLButtonElement, () => boolean][] = [];
function button(label: string, pressed: () => boolean, click: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => {
    click();
    for (const [x, p] of buttons) x.setAttribute('aria-pressed', String(p()));
  });
  panel.append(b);
  buttons.push([b, pressed]);
}
for (const d of DEATHS) button(d, () => opts.death === d, () => play(d));
button('loop', () => opts.loop, () => (opts.loop = !opts.loop));
button('slow-mo', () => opts.slow, () => (opts.slow = !opts.slow));
button('Z.E.R.O', () => opts.team === 1, () => {
  opts.team = 1 - opts.team;
  start();
});
for (const [x, p] of buttons) x.setAttribute('aria-pressed', String(p()));

function play(d: Death): void {
  opts.death = d;
  start();
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
  tilt = Math.max(-0.1, Math.min(1.4, tilt + e.movementY * 0.006));
});
canvas.addEventListener('wheel', (e) => (dist = Math.max(2, Math.min(30, dist * (1 + Math.sign(e.deltaY) * 0.1)))));

start();
requestAnimationFrame(frame);

(window as unknown as { deaths: unknown }).deaths = {
  opts,
  play,
  view(y: number, t: number, d: number) {
    yaw = y;
    tilt = t;
    dist = d;
  },
  /** Stop the frame loop and step it by hand: `deaths.step(1/60, 30)`. */
  step(dt: number, n = 1) {
    manual = true;
    for (let i = 0; i < n; i++) {
      last = performance.now() - dt * 1000;
      frame(performance.now());
    }
  },
  /** Where the body's hips are now, or null. */
  hips: () => ragdolls.hipsOf(0, new THREE.Vector3())?.toArray() ?? null,
};
