import * as THREE from 'three';
import {
  BOTS,
  TICK_DT,
  WEAPONS,
  createMatch,
  eyeHeight,
  lerp,
  spawnActor,
  stepMatch,
  v3,
  weaponOf,
  type Actor,
  type CollisionWorld,
  type InputCmd,
  type MapData,
  type MatchEvent,
  type MatchState,
  type PlayerState,
  type Vec3,
} from '@dropline/shared';
import { Sfx } from './audio/sfx';
import { CameraRig } from './camera/cameraRig';
import { Input } from './input/input';
import { Avatar, TEAM_LOOK } from './render/avatar';
import { Effects } from './render/effects';
import { buildMapMeshes } from './render/mapMesh';
import { createEnvironment, createRenderer, type Environment } from './render/scene';
import { Viewmodel } from './render/viewmodel';
import { Hud } from './ui/hud';

/** Longest frame the simulation will try to catch up on, seconds. */
const MAX_FRAME = 0.1;
/** Seconds a pilot keeps the weapon shouldered after firing. */
const RAISE_HOLD = 1.6;
const OWN_TRACER = '#ffe2b0';
const IMPACT_SPARK = '#ffcf8a';

export interface GameOptions {
  seed: number;
  /** Debug view: bot states over their heads. */
  qa: boolean;
}

export class Game {
  readonly input: Input;
  readonly rig = new CameraRig();
  readonly sfx = new Sfx();
  match!: MatchState;
  /** Automated checks set this and call `frame` themselves, to step the game at will. */
  manual = false;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly env: Environment;
  private readonly fx: Effects;
  private readonly viewmodel = new Viewmodel();
  private readonly hud = new Hud();
  private avatars: Avatar[] = [];
  private prev: Vec3[] = [];
  private drawn: Vec3[] = [];
  private raise: number[] = [];
  private readonly cmds: InputCmd[] = [];
  private accumulator = 0;
  private lastTime = 0;
  private pendingEvents = 0;
  private seed: number;
  private readonly tmp = new THREE.Vector3();
  private readonly eye = v3();
  private readonly aim = v3();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly world: CollisionWorld,
    private readonly map: MapData,
    options: GameOptions,
  ) {
    this.renderer = createRenderer(canvas);
    this.env = createEnvironment(this.scene);
    this.scene.add(buildMapMeshes(map, this.renderer));
    this.fx = new Effects(this.scene);
    this.hud.debug = options.qa;
    this.seed = options.seed;

    this.input = new Input(canvas);
    this.input.onLockChange = (locked) => this.hud.showOverlay(!locked);
    this.input.onLockError = () => this.hud.showLockError();
    this.hud.onStart(() => {
      this.sfx.unlock();
      void this.input.lock();
    });
    document.addEventListener('visibilitychange', () => this.sfx.setPaused(document.hidden || this.paused));

    this.newMatch();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** The local player. */
  get me(): Actor {
    return this.match.actors[0];
  }

  get state(): PlayerState {
    return this.me.p;
  }

  /** The match stands still while the start screen is up. */
  get paused(): boolean {
    return !this.input.locked && !this.input.override;
  }

  /** Start a fresh match; each one gets the next seed, so no two play out the same. */
  newMatch(): void {
    for (const avatar of this.avatars) {
      this.scene.remove(avatar.root, avatar.laser);
      avatar.dispose();
    }
    this.match = createMatch(this.map, this.world, { seed: this.seed++ });
    const me = this.me;
    this.avatars = this.match.actors.map((a) => new Avatar(a.team, a.team === me.team && a !== me));
    for (const avatar of this.avatars) this.scene.add(avatar.root, avatar.laser);
    this.prev = this.match.actors.map((a) => ({ ...a.p.pos }));
    this.drawn = this.match.actors.map((a) => ({ ...a.p.pos }));
    this.raise = this.match.actors.map(() => 0);
    this.fx.clear();
    this.hud.reset(this.match, me);
    this.input.yaw = me.p.yaw;
    this.input.pitch = 0;
    this.input.weapon = -1;
    this.accumulator = 0;
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / h);
    this.viewmodel.resize(w / h);
  }

  start(): void {
    this.lastTime = performance.now();
    const loop = (now: number): void => {
      if (!this.manual) this.frame(Math.min(MAX_FRAME, (now - this.lastTime) / 1000));
      this.lastTime = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** One-press actions that are not part of the simulation's input. */
  private handleKeys(): void {
    const input = this.input;
    const me = this.me;
    if (input.consume('toggleView')) this.rig.thirdPerson = !this.rig.thirdPerson;
    if (input.consume('mute')) this.hud.setMuted(this.sfx.toggleMute());
    if (this.match.over && input.consume('confirm')) this.newMatch();
    if (input.consume('respawn') && me.alive && !this.match.over) {
      spawnActor(this.match, me);
      this.onSpawn(me);
    }
    const slots = me.loadout.length;
    const wanted = input.weapon >= 0 ? input.weapon : me.weapon;
    if (input.consume('weapon1')) input.weapon = 0;
    if (input.consume('weapon2')) input.weapon = 1;
    if (input.consume('weapon3')) input.weapon = 2;
    const step = (input.consume('nextWeapon') ? 1 : 0) + input.takeWheel();
    if (step !== 0) input.weapon = (((wanted + Math.sign(step)) % slots) + slots) % slots;
  }

  /** Advance the simulation in fixed ticks, then draw one interpolated frame. */
  frame(dt: number): void {
    this.handleKeys();
    const m = this.match;
    const me = this.me;
    const paused = this.paused;
    this.sfx.setPaused(paused || document.hidden);

    let cmd = this.input.sample();
    if (!paused) {
      this.accumulator += dt;
      while (this.accumulator >= TICK_DT) {
        for (const a of m.actors) {
          const p = this.prev[a.id];
          p.x = a.p.pos.x;
          p.y = a.p.pos.y;
          p.z = a.p.pos.z;
        }
        cmd = this.input.sample();
        this.cmds[me.id] = cmd;
        stepMatch(m, this.world, this.cmds, TICK_DT);
        this.pendingEvents |= me.p.events;
        this.accumulator -= TICK_DT;
        for (const e of m.events) this.onEvent(e);
      }
    }

    const alpha = this.accumulator / TICK_DT;
    for (const a of m.actors) {
      const from = this.prev[a.id];
      const to = a.p.pos;
      const p = this.drawn[a.id];
      p.x = lerp(from.x, to.x, alpha);
      p.y = lerp(from.y, to.y, alpha);
      p.z = lerp(from.z, to.z, alpha);
    }

    // The view follows the mouse every frame rather than waiting for the next tick.
    const s = me.p;
    const p = this.drawn[me.id];
    s.yaw = this.input.yaw;
    s.pitch = this.input.pitch;
    const def = weaponOf(me);
    const zoom = 1 + (def.adsZoom - 1) * me.ads;
    this.input.sensScale = zoom;
    const rig = this.rig;
    rig.punchPitch = me.alive ? me.punchPitch : 0;
    rig.punchYaw = me.alive ? me.punchYaw : 0;
    rig.zoom = zoom;
    rig.forceThird = !me.alive;
    rig.update(dt, s, p, cmd.moveX, this.pendingEvents, this.world);
    this.pendingEvents = 0;
    const cam = rig.camera;
    this.sfx.setListener(cam.position.x, cam.position.y, cam.position.z, s.yaw);

    for (const a of m.actors) {
      const avatar = this.avatars[a.id];
      const b = a.brain;
      const shouldered = a.ads > 0.2 || m.time - a.lastShotTime < RAISE_HOLD || (b !== null && (b.state === 'engage' || b.state === 'notice'));
      this.raise[a.id] += ((shouldered ? 1 : 0) - this.raise[a.id]) * (1 - Math.exp(-14 * dt));
      avatar.update(dt, a, this.drawn[a.id], a !== me || rig.outside, this.raise[a.id]);
      // A marksman's laser runs from its muzzle along its view to whatever it meets.
      if (b && b.charge > 0 && a.alive) avatar.setLaser(b.charge, b.charge >= BOTS.chargeLock, this.aimPoint(a));
      else avatar.setLaser(0, false, null);
    }

    const mouse = this.input.takeMouseDelta();
    this.viewmodel.update(dt, me, mouse.dx, mouse.dy);
    this.fx.update(dt);
    this.env.follow(p.x, p.y, p.z);
    // Fully aimed, a scoped weapon swaps its model for the scope view.
    const scoped = def.scope && me.ads > 0.9 && me.alive && !rig.outside;
    this.hud.update(dt, m, me, rig.outside, scoped, cam, s.yaw);

    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    if (!rig.outside && !scoped) {
      this.renderer.clearDepth();
      this.renderer.render(this.viewmodel.scene, this.viewmodel.camera);
    }
  }

  /** Where a pilot's line of sight ends: the first surface, or far away. */
  private aimPoint(a: Actor): Vec3 {
    const s = a.p;
    const cp = Math.cos(s.pitch);
    const dir = this.aim;
    dir.x = -Math.sin(s.yaw) * cp;
    dir.y = Math.sin(s.pitch);
    dir.z = -Math.cos(s.yaw) * cp;
    const eye = this.eye;
    eye.x = s.pos.x;
    eye.y = s.pos.y + eyeHeight(s);
    eye.z = s.pos.z;
    const hit = this.world.castRay(eye, dir, 150);
    const d = hit ? hit.dist : 150;
    dir.x = eye.x + dir.x * d;
    dir.y = eye.y + dir.y * d;
    dir.z = eye.z + dir.z * d;
    return dir;
  }

  private onSpawn(a: Actor): void {
    const pos = a.p.pos;
    Object.assign(this.prev[a.id], pos);
    Object.assign(this.drawn[a.id], pos);
    if (a !== this.me) return;
    this.input.yaw = a.p.yaw;
    this.input.pitch = 0;
    this.hud.hideDeath();
    this.sfx.spawn();
  }

  /** Turn what happened in the simulation into effects, sound and HUD feedback. */
  private onEvent(e: MatchEvent): void {
    const m = this.match;
    const me = this.me;
    switch (e.type) {
      case 'shot': {
        const a = m.actors[e.actor];
        const mine = a === me;
        const firstPerson = mine && !this.rig.outside;
        const muzzle = firstPerson ? this.viewmodel.muzzleWorld(this.rig.camera, this.tmp) : this.avatars[a.id].muzzleWorld(this.tmp);
        const color = mine ? OWN_TRACER : TEAM_LOOK[a.team].tracer;
        let struck: Vec3 | null = null;
        for (const t of e.traces) {
          this.fx.tracer(muzzle, t.end, color, firstPerson ? 0.02 : 0.04);
          if (t.normal) {
            this.fx.burst(t.end, t.normal, 4, IMPACT_SPARK, 4);
            this.fx.decal(t.end, t.normal);
            struck = t.end;
          } else if (t.victim >= 0) {
            // Sparks in the victim's colours, more of them for a headshot.
            this.fx.burst(t.end, null, t.head ? 10 : 5, TEAM_LOOK[m.actors[t.victim].team].visor, 5);
          }
        }
        this.fx.flash(muzzle, mine ? 2.5 : 4);
        this.avatars[a.id].fireFlash();
        if (mine) this.viewmodel.fire();
        this.sfx.fire(e.weapon, mine ? null : a.p.pos);
        if (struck) this.sfx.impact(struck);
        break;
      }
      case 'damage': {
        this.avatars[e.victim].flash();
        if (e.attacker === me.id) {
          this.hud.hitmarker(e.head, e.killed);
          this.hud.damageNumber(e.victim, e.pos, e.amount, e.head);
          this.sfx.hit(e.head);
        }
        if (e.victim === me.id) {
          const from = m.actors[e.attacker].p.pos;
          this.hud.damageFrom(from.x, from.z, e.amount);
          // Knock the view away from the side the shot came from.
          const dx = from.x - me.p.pos.x;
          const dz = from.z - me.p.pos.z;
          const side = Math.sign(dx * Math.cos(me.p.yaw) - dz * Math.sin(me.p.yaw)) || 1;
          this.rig.jolt(side, Math.min(1, 0.25 + e.amount / 50));
          this.sfx.hurt();
        }
        break;
      }
      case 'kill': {
        const victim = m.actors[e.victim];
        const killer = e.attacker >= 0 ? m.actors[e.attacker] : null;
        const how = killer ? `${WEAPONS[e.weapon].short}${e.head ? ' · HEAD' : ''}` : 'FELL';
        this.hud.addKill(killer, victim, how, me);
        const chest = this.eye;
        chest.x = victim.p.pos.x;
        chest.y = victim.p.pos.y + 1.1;
        chest.z = victim.p.pos.z;
        this.fx.burst(chest, null, 22, TEAM_LOOK[victim.team].visor, 7);
        if (killer === me) {
          this.hud.showBanner('ELIMINATED ', victim.name);
          this.rig.kick(3);
          this.sfx.kill();
        }
        if (victim === me) {
          this.hud.showDeath(killer ? `${killer.name} · ${WEAPONS[e.weapon].short}` : 'THE FALL');
          this.sfx.death();
        }
        break;
      }
      case 'spawn':
        this.onSpawn(m.actors[e.actor]);
        break;
      case 'reload':
        if (e.actor === me.id) this.sfx.reloadOut();
        break;
      case 'reloaded':
        if (e.actor === me.id) this.sfx.reloadIn();
        break;
      case 'dry':
        if (e.actor === me.id) this.sfx.dry();
        break;
      case 'equip':
        if (e.actor === me.id) this.sfx.equip();
        break;
      case 'notice': {
        const a = m.actors[e.actor];
        if (a.team === me.team) break;
        this.avatars[a.id].notice();
        if (e.target === me.id) this.sfx.notice(a.p.pos);
        break;
      }
      case 'charge': {
        const a = m.actors[e.actor];
        if (a.team !== me.team) this.sfx.charge(a.p.pos, e.duration, e.target === me.id);
        break;
      }
      case 'matchEnd':
        this.hud.showEnd(e.winner === me.team, m, me);
        this.sfx.matchEnd(e.winner === me.team);
        break;
    }
  }
}
