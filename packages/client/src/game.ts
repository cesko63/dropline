import * as THREE from 'three';
import {
  BOTS,
  COMBAT,
  FRAME_LIST,
  NET,
  PROJECTILES,
  TICK_DT,
  WEAPONS,
  createMatch,
  eyeOf,
  frameOf,
  lerp,
  stepMatch,
  v3,
  weaponOf,
  type Actor,
  type CollisionWorld,
  type InputCmd,
  type MapData,
  type MatchEvent,
  type MatchInfo,
  type MatchState,
  type MechAbility,
  type PlayerState,
  type Vec3,
} from '@dropline/shared';
import { Sfx } from './audio/sfx';
import { CameraRig } from './camera/cameraRig';
import { ACTIONS, codeLabel, type Action } from './input/bindings';
import { Input, PAD_START } from './input/input';
import type { Connection } from './net/connection';
import { Avatar, TEAM_LOOK } from './render/avatar';
import { Effects } from './render/effects';
import { buildMapMeshes } from './render/mapMesh';
import { ALLY_ZONE, ENEMY_ZONE, MechAvatar } from './render/mechAvatar';
import { createEnvironment, createRenderer, type Environment } from './render/scene';
import { Viewmodel } from './render/viewmodel';
import { verticalFov, type Settings, type SettingsStore } from './settings/settings';
import { Hud } from './ui/hud';

/** Longest frame the simulation will try to catch up on, seconds. */
const MAX_FRAME = 0.1;
/** Seconds a pilot keeps the arm raised after firing. */
const RAISE_HOLD = 1.6;
const OWN_TRACER = '#ffe2b0';
const IMPACT_SPARK = '#ffcf8a';
const CRIT_SPARK = '#ffd23f';
const UP = v3(0, 1, 0);
/** Ids for rockets drawn from prediction, well clear of the server's own. */
const LOCAL_ROCKETS = 1_000_000;

/**
 * Where an event comes from. Offline everything is `sim`. Online the player's
 * own pilot is `predicted` (shown the moment the key goes down) and the rest
 * is the `server`'s word, a little later.
 */
type EventSource = 'sim' | 'predicted' | 'server';

/** What a kill is credited to in the feed: a weapon, a rocket, or the mech itself. */
function killLabel(weapon: string): string {
  if (weapon in WEAPONS) return WEAPONS[weapon].short;
  if (weapon in PROJECTILES) return PROJECTILES[weapon].name;
  if (weapon === 'crush') return 'MECH DROP';
  if (weapon === 'ram') return 'RAMMED';
  if (weapon === 'stomp') return 'STOMPED';
  return 'FELL';
}

export interface GameOptions {
  seed: number;
  /** Debug view: bot states over their heads. */
  qa: boolean;
  /** Mech meter everyone starts with, 0..1 (`?meter=1` to try the mech at once). */
  startMeter: number;
  /** Open the connection details as soon as a server is joined (`?net=1`). */
  netDebug: boolean;
  settings: SettingsStore;
}

/** How far the aim slowdown reaches around an enemy's chest, meters, and how far away it still works. */
const ASSIST_RADIUS = 0.9;
const ASSIST_RANGE = 70;

export class Game {
  readonly input: Input;
  readonly rig = new CameraRig();
  readonly sfx = new Sfx();
  match!: MatchState;
  /** Automated checks set this and call `frame` themselves, to step the game at will. */
  manual = false;
  /** The player took control or let go of it (paused, opened the menu). */
  onPlayingChange: (playing: boolean) => void = () => {};
  /** Once a frame while the player is not in control: the start screen reads the pad here. */
  onMenuFrame: (dt: number) => void = () => {};
  /** The player switched between keyboard and pad, or rebound something: printed keys must follow. */
  onKeysChange: () => void = () => {};
  private readonly settings: SettingsStore;
  /** Screen shake is scaled by this (the comfort setting). */
  private shakeScale = 1;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly env: Environment;
  private readonly fx: Effects;
  private readonly viewmodel = new Viewmodel();
  private readonly hud = new Hud();
  private avatars: Avatar[] = [];
  private mechAvatars: MechAvatar[] = [];
  private prev: Vec3[] = [];
  private drawn: Vec3[] = [];
  private mechPrev: Vec3[] = [];
  private mechDrawn: Vec3[] = [];
  private raise: number[] = [];
  private readonly cmds: InputCmd[] = [];
  /** The line to the server while playing online, else null. */
  private conn: Connection | null = null;
  /** Actor id of the player's own pilot. */
  private meId = 0;
  /** Rockets fired from prediction that the server has not announced yet, oldest first. */
  private readonly ownRockets: number[] = [];
  /** Server rocket id to the id it is drawn under, for those that were predicted. */
  private readonly rocketAlias = new Map<number, number>();
  private nextRocket = LOCAL_ROCKETS;
  /** When the match ended (milliseconds), for the countdown to the next one online. */
  private endedAt = 0;
  private accumulator = 0;
  private lastTime = 0;
  private pendingEvents = 0;
  private seed: number;
  private readonly startMeter: number;
  private netDebug: boolean;
  /** Seconds since damaged mechs last trailed smoke. */
  private smokeT = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly eye = v3();
  private readonly aim = v3();
  private readonly at = v3();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly world: CollisionWorld,
    private readonly map: MapData,
    options: GameOptions,
  ) {
    this.renderer = createRenderer(canvas);
    this.env = createEnvironment(this.scene, map.env);
    this.scene.add(buildMapMeshes(map, this.renderer));
    this.fx = new Effects(this.scene);
    this.hud.debug = options.qa;
    this.seed = options.seed;
    this.startMeter = options.startMeter;
    this.netDebug = options.netDebug;

    this.settings = options.settings;
    this.input = new Input(canvas, this.settings.value);
    this.input.onPlayingChange = (playing) => {
      this.hud.showOverlay(!playing);
      if (!playing) this.input.resetToggles();
      this.onPlayingChange(playing);
    };
    this.input.onDeviceChange = (device) => {
      document.body.classList.toggle('pad', device === 'pad');
      this.keysChanged();
    };
    this.input.onLockError = () => this.hud.showLockError();
    this.hud.keyOf = (a, fallback) => this.keyOf(a, fallback);
    document.addEventListener('visibilitychange', () => this.sfx.setPaused(this.paused, document.hidden));
    this.settings.listen((s) => this.apply(s));

    this.newMatch();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** The local player. */
  get me(): Actor {
    return this.match.actors[this.meId];
  }

  /** True while the match being played is the server's. */
  get online(): boolean {
    return this.conn !== null;
  }

  /**
   * Hand control to the player and start the sound. On a pad it starts at once;
   * with a mouse it has to come from a click or a key press, which the browser
   * needs to capture the mouse (and to go fullscreen, if that is set).
   */
  resume(): void {
    this.sfx.unlock();
    if (this.input.device === 'pad') {
      this.input.setPadPlaying(true);
      return;
    }
    if (this.settings.value.fullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
    void this.input.lock();
  }

  /** Let go of the controls: the start screen comes up (offline the match waits). */
  pause(): void {
    this.input.setPadPlaying(false);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /**
   * The button or key for an action on the device in use: the pad's while one is
   * used, else the keyboard's. An action with no pad button shows its key, unless
   * `fallback` is false.
   */
  keyOf(a: Action, fallback = true): string {
    const fixed = ACTIONS[a].fixed;
    const s = this.settings.value;
    const keys = fixed ? ACTIONS[a].keys : s.keys[a];
    const pad = fixed ? ACTIONS[a].pad : s.pad[a];
    const code = this.input.device === 'pad' ? (pad[0] ?? (fallback ? keys[0] : undefined)) : keys[0];
    return code ? codeLabel(code) : '';
  }

  private keysChanged(): void {
    this.hud.refreshKeys();
    this.onKeysChange();
  }

  /** Settings changed (or were just loaded): everything they reach follows at once. */
  private apply(s: Settings): void {
    this.input.setSettings(s);
    this.rig.baseFov = verticalFov(s.fov);
    this.rig.calm = s.reduceMotion;
    this.shakeScale = s.shake;
    this.sfx.setVolume(s.volume, s.muted);
    this.hud.setMuted(s.muted);
    this.hud.setDisplay(s.showFps, s.hudScale);
    this.keysChanged();
  }

  /** Shake the view by the comfort setting, and the pad by the same amount. */
  private shake(amount: number): void {
    if (amount <= 0) return;
    this.rig.shake(amount * this.shakeScale);
    this.input.rumble(amount, amount * 0.6, 120 + 260 * amount);
  }

  get state(): PlayerState {
    return this.me.p;
  }

  /**
   * Offline the match stands still while the start screen is up. Online nothing
   * pauses it: the menu is only on this player's screen and their pilot stays
   * in the world.
   */
  get paused(): boolean {
    return !this.conn && !this.input.playing && !this.input.override;
  }

  /** Start a fresh offline match; each one gets the next seed, so no two play out the same. */
  newMatch(): void {
    this.conn = null;
    this.show(createMatch(this.map, this.world, { seed: this.seed++, startMeter: this.startMeter }), 0);
  }

  /**
   * Play the server's match: `conn` has been welcomed and holds this client's
   * copy of it. Called again when the next match starts or after a reconnect.
   */
  goOnline(conn: Connection): void {
    this.conn = conn;
    this.show(conn.net.match, conn.net.me);
    this.hud.setEndHint('');
    if (this.netDebug) this.hud.showNetDebug();
    this.netDebug = false;
  }

  /** Someone joined or left: say so in the feed. */
  rosterChanged(before: MatchInfo, now: MatchInfo): void {
    now.seats.forEach((seat, i) => {
      const was = before.seats[i];
      if (!was || i === this.meId) return;
      const ally = seat.team === this.me.team;
      if (was.bot && !seat.bot) this.hud.addNote(seat.name, 'JOINED', ally);
      else if (!was.bot && seat.bot) this.hud.addNote(was.name, 'LEFT', ally);
    });
  }

  /** Put a match on screen: models for everyone in it, a clean HUD, the view on the player's pilot. */
  private show(match: MatchState, meId: number): void {
    for (const avatar of this.avatars) {
      this.scene.remove(avatar.root, avatar.laser);
      avatar.dispose();
    }
    for (const avatar of this.mechAvatars) {
      this.scene.remove(avatar.root);
      avatar.dispose();
    }
    this.match = match;
    this.meId = meId;
    this.cmds.length = 0;
    this.ownRockets.length = 0;
    this.rocketAlias.clear();
    this.hud.setEndHint('{confirm} · PLAY AGAIN');
    this.hud.setOnline(this.conn !== null);
    const me = this.me;
    this.viewmodel.setTeam(me.team);
    this.avatars = this.match.actors.map((a) => new Avatar(a.team, a.team === me.team && a !== me, a.id));
    for (const avatar of this.avatars) this.scene.add(avatar.root, avatar.laser);
    this.mechAvatars = this.match.mechs.map((k) => new MechAvatar(k.team, k.team === me.team, frameOf(k)));
    for (const avatar of this.mechAvatars) this.scene.add(avatar.root);
    this.prev = this.match.actors.map((a) => ({ ...a.p.pos }));
    this.drawn = this.match.actors.map((a) => ({ ...a.p.pos }));
    this.mechPrev = this.match.mechs.map((k) => ({ ...k.pos }));
    this.mechDrawn = this.match.mechs.map((k) => ({ ...k.pos }));
    this.raise = this.match.actors.map(() => 0);
    this.fx.clear();
    this.hud.reset(this.match, me);
    this.input.yaw = me.p.yaw;
    this.input.pitch = 0;
    this.input.weapon = -1;
    this.input.resetToggles();
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
    if (input.consume('mute')) this.settings.set({ muted: !this.settings.value.muted });
    if (input.consume('netDebug')) this.hud.toggleNet();
    if (input.consume('nextFrame')) this.nextFrame();
    // Online the server starts the next match by itself.
    if (this.match.over && !this.conn && input.consume('confirm')) this.newMatch();
    const keys = [input.consume('weapon1'), input.consume('weapon2'), input.consume('weapon3'), input.consume('weapon4')];
    const step = (input.consume('nextWeapon') ? 1 : 0) + input.takeWheel();
    // The mech has one weapon; the pilot's choice waits for them outside.
    if (me.inMech) return;
    const slots = me.loadout.length;
    const wanted = input.weapon >= 0 ? input.weapon : me.weapon;
    keys.forEach((pressed, slot) => {
      if (pressed && slot < slots) input.weapon = slot;
    });
    if (step !== 0) input.weapon = (((wanted + Math.sign(step)) % slots) + slots) % slots;
  }

  /**
   * Pick the next mech frame for the next call. Any time on foot; once a mech is
   * on its way or standing by, the choice waits for the next one.
   */
  private nextFrame(): void {
    const k = this.match.mechs[this.meId];
    if (this.me.inMech || k.state === 'dropping' || k.state === 'idle') {
      this.sfx.denied();
      return;
    }
    const at = FRAME_LIST.findIndex((f) => f.id === this.settings.value.mechFrame);
    const F = FRAME_LIST[(at + 1) % FRAME_LIST.length];
    this.settings.set({ mechFrame: F.id });
    this.sfx.frameSelect(FRAME_LIST.indexOf(F));
    // The class only ("HEAVY"): the whole line would not fit a small screen.
    this.hud.showBanner(`${F.short} · `, F.blurb.split(':')[0].toUpperCase(), 'good');
  }

  /** Advance the simulation in fixed ticks, then draw one interpolated frame. */
  frame(dt: number): void {
    this.input.update(dt);
    // MENU on the pad pauses; the start screen's own navigation resumes.
    if (this.input.playing && this.input.pad.pressed[PAD_START]) this.pause();
    else if (!this.input.playing) this.onMenuFrame(dt);
    this.handleKeys();
    const m = this.match;
    const me = this.me;
    const paused = this.paused;
    this.sfx.setPaused(paused, document.hidden);

    let cmd = this.input.sample(false);
    const conn = this.conn;
    if (conn) {
      cmd = this.frameOnline(conn, dt, cmd);
    } else if (!paused) {
      this.accumulator += dt;
      while (this.accumulator >= TICK_DT) {
        for (const a of m.actors) {
          const p = this.prev[a.id];
          p.x = a.p.pos.x;
          p.y = a.p.pos.y;
          p.z = a.p.pos.z;
        }
        for (const k of m.mechs) {
          const p = this.mechPrev[k.id];
          p.x = k.pos.x;
          p.y = k.pos.y;
          p.z = k.pos.z;
        }
        cmd = this.input.sample();
        this.cmds[me.id] = cmd;
        stepMatch(m, this.world, this.cmds, TICK_DT);
        this.pendingEvents |= me.p.events;
        this.accumulator -= TICK_DT;
        for (const e of m.events) this.onEvent(e, 'sim');
      }
    }

    const alpha = this.accumulator / TICK_DT;
    if (conn) {
      // Everyone else already stands where they are to be drawn (between two
      // snapshots); only the player's own pilot moves in ticks.
      for (const a of m.actors) {
        if (a === me) conn.net.ownDrawn(alpha, this.drawn[a.id]);
        else Object.assign(this.drawn[a.id], a.p.pos);
      }
      for (const k of m.mechs) Object.assign(this.mechDrawn[k.id], k.id === me.id && me.inMech ? this.drawn[me.id] : k.pos);
    } else {
      for (const a of m.actors) {
        const from = this.prev[a.id];
        const to = a.p.pos;
        const p = this.drawn[a.id];
        p.x = lerp(from.x, to.x, alpha);
        p.y = lerp(from.y, to.y, alpha);
        p.z = lerp(from.z, to.z, alpha);
      }
      for (const k of m.mechs) {
        const from = this.mechPrev[k.id];
        const p = this.mechDrawn[k.id];
        p.x = lerp(from.x, k.pos.x, alpha);
        p.y = lerp(from.y, k.pos.y, alpha);
        p.z = lerp(from.z, k.pos.z, alpha);
      }
    }

    // The view follows the mouse every frame rather than waiting for the next tick.
    const s = me.p;
    const p = this.drawn[me.id];
    s.yaw = this.input.yaw;
    s.pitch = this.input.pitch;
    const def = weaponOf(me);
    const zoom = 1 + (def.adsZoom - 1) * me.ads;
    this.input.sensScale = zoom;
    this.input.assist = this.input.device === 'pad' && this.settings.value.aimSlowdown && me.alive ? this.aimAssist(me) : 0;
    const rig = this.rig;
    rig.punchPitch = me.alive ? me.punchPitch : 0;
    rig.punchYaw = me.alive ? me.punchYaw : 0;
    rig.zoom = zoom;
    rig.forceThird = !me.alive;
    rig.mech = me.inMech ? frameOf(m.mechs[me.id]) : null;
    rig.update(dt, s, p, cmd.moveX, this.pendingEvents, this.world);
    this.pendingEvents = 0;
    const cam = rig.camera;
    this.sfx.setListener(cam.position.x, cam.position.y, cam.position.z, s.yaw);

    for (const a of m.actors) {
      const avatar = this.avatars[a.id];
      const b = a.brain;
      const shouldered = a.ads > 0.2 || m.time - a.lastShotTime < RAISE_HOLD || (b !== null && (b.state === 'engage' || b.state === 'notice'));
      this.raise[a.id] += ((shouldered ? 1 : 0) - this.raise[a.id]) * (1 - Math.exp(-14 * dt));
      // A pilot in a mech is out of sight inside it.
      avatar.update(dt, a, this.drawn[a.id], (a !== me || rig.outside) && !a.inMech, this.raise[a.id]);
      // A marksman's laser runs from its muzzle along its view to whatever it meets.
      if (b && b.charge > 0 && a.alive && !a.inMech) avatar.setLaser(b.charge, b.charge >= BOTS.chargeLock, this.aimPoint(a));
      else avatar.setLaser(0, false, null);
    }

    this.smokeT += dt;
    const puff = this.smokeT > 0.11;
    if (puff) this.smokeT = 0;
    for (const k of m.mechs) {
      let avatar = this.mechAvatars[k.id];
      // A new call may bring a different frame: build its model.
      if (k.state !== 'none' && avatar.frame !== frameOf(k)) {
        this.scene.remove(avatar.root);
        avatar.dispose();
        avatar = this.mechAvatars[k.id] = new MechAvatar(k.team, k.team === me.team, frameOf(k));
        this.scene.add(avatar.root);
      }
      const mine = k.id === me.id && me.inMech;
      // The player's own mech turns with the mouse, like their view.
      avatar.update(dt, k, this.mechDrawn[k.id], mine ? s.yaw : k.yaw, mine ? s.pitch : k.pitch, !mine || rig.outside);
      if (!puff || k.state === 'none' || k.state === 'dropping') continue;
      // Thruster wash under a dash, and smoke from a hull that is nearly gone.
      if (k.dashTime > 0 && (!mine || rig.outside)) {
        const at = this.at;
        at.x = k.pos.x;
        at.y = k.pos.y + 0.4;
        at.z = k.pos.z;
        this.fx.smoke(at, 2, 0.9, 1.3, 0.6, null, 0.55);
      }
      // A cloaked mech leaves no smoke for the enemy to follow.
      if (k.health < frameOf(k).health * 0.25 && (k.cloak <= 0 || k.team === me.team)) this.fx.smoke(avatar.ventWorld(this.tmp), 1, 0.3, 1.1, 1.3, null, 0.16);
    }
    const own = m.mechs[me.id];
    if (me.inMech && own.health < frameOf(own).health * 0.25 && !paused) this.sfx.hullAlarm();
    this.hud.setFrame(this.settings.value.mechFrame);

    const mouse = this.input.takeMouseDelta();
    this.viewmodel.update(dt, me, mouse.dx, mouse.dy, me.inMech ? m.mechs[me.id] : null);
    this.fx.update(dt);
    this.env.follow(p.x, p.y, p.z);
    // Fully aimed, a scoped weapon swaps its model for the scope view.
    const scoped = def.scope && me.ads > 0.9 && me.alive && !rig.outside;
    this.hud.update(dt, m, me, rig.outside, scoped, cam, s.yaw);
    if (conn) {
      this.hud.updateNet(dt, conn.net.stats, conn.status, conn.secondsLeft);
      if (m.over) this.hud.setEndHint(`NEXT MATCH IN ${Math.max(0, Math.ceil(NET.restartSeconds - (performance.now() - this.endedAt) / 1000))}`);
    }
    if (this.hud.inDropZone && !paused) this.sfx.zoneWarn();

    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    if (!rig.outside && !scoped) {
      this.renderer.clearDepth();
      this.renderer.render(this.viewmodel.scene, this.viewmodel.camera);
    }
  }

  /**
   * The online half of a frame: send this frame's commands and act on them at
   * once, then let the client core move everyone else and hand out what the
   * server says happened.
   */
  private frameOnline(conn: Connection, dt: number, cmd: InputCmd): InputCmd {
    const net = conn.net;
    if (!net.ready) return cmd;
    const me = this.me;
    // A respawn: the view turns to where the pilot was put down.
    if (net.takeViewReset()) {
      this.input.yaw = me.p.yaw;
      this.input.pitch = 0;
    }
    // While the line is down nothing is predicted: there is nobody to confirm it.
    if (conn.status === 'online') {
      this.accumulator += dt * net.timeScale;
      while (this.accumulator >= TICK_DT) {
        cmd = this.input.sample();
        const shown = net.command(cmd);
        this.pendingEvents |= me.p.events;
        this.accumulator -= TICK_DT;
        for (const e of shown) this.onEvent(e, 'predicted');
      }
    }
    for (const e of net.advance(performance.now(), dt)) this.onEvent(e, 'server');
    return cmd;
  }

  /**
   * 0..1: how close the crosshair is to an enemy pilot's chest, with a clear
   * line to them, for the pad's aim slowdown. It only slows the turn; it never
   * pulls the view.
   */
  private aimAssist(me: Actor): number {
    const s = me.p;
    const cp = Math.cos(s.pitch);
    const fx = -Math.sin(s.yaw) * cp;
    const fy = Math.sin(s.pitch);
    const fz = -Math.cos(s.yaw) * cp;
    const eye = this.eye;
    eye.x = s.pos.x;
    eye.y = s.pos.y + eyeOf(this.match, me);
    eye.z = s.pos.z;
    let best = 0;
    for (const a of this.match.actors) {
      if (a.team === me.team || !a.alive || a.inMech) continue;
      const p = this.drawn[a.id];
      const dx = p.x - eye.x;
      const dy = p.y + 1.1 - eye.y;
      const dz = p.z - eye.z;
      const along = dx * fx + dy * fy + dz * fz;
      if (along <= 1 || along > ASSIST_RANGE) continue;
      const off = Math.hypot(dx - fx * along, dy - fy * along, dz - fz * along);
      const k = 1 - off / ASSIST_RADIUS;
      if (k <= best) continue;
      const dist = Math.hypot(dx, dy, dz);
      const dir = this.aim;
      dir.x = dx / dist;
      dir.y = dy / dist;
      dir.z = dz / dist;
      const wall = this.world.castRay(eye, dir, dist);
      if (wall && wall.dist < dist - 0.5) continue;
      best = k;
    }
    return best;
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
    eye.y = s.pos.y + eyeOf(this.match, a);
    eye.z = s.pos.z;
    const hit = this.world.castRay(eye, dir, 150);
    const d = hit ? hit.dist : 150;
    dir.x = eye.x + dir.x * d;
    dir.y = eye.y + dir.y * d;
    dir.z = eye.z + dir.z * d;
    return dir;
  }

  /** The actor is somewhere else all at once (a spawn, a seat in a mech): no gliding there. */
  private snap(a: Actor): void {
    Object.assign(this.prev[a.id], a.p.pos);
    Object.assign(this.drawn[a.id], a.p.pos);
  }

  private onSpawn(a: Actor): void {
    this.snap(a);
    if (a !== this.me) return;
    // Online the view was already turned when the server's word arrived (`frameOnline`).
    if (!this.conn) {
      this.input.yaw = a.p.yaw;
      this.input.pitch = 0;
    }
    this.hud.hideDeath();
    this.input.resetToggles();
    this.sfx.spawn();
  }

  /** 1 beside the player's view, falling to 0 at `range` meters. */
  private near(pos: Vec3, range: number): number {
    const cam = this.rig.camera.position;
    return Math.max(0, 1 - Math.hypot(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z) / range);
  }

  /** Sparks off a raised shield, in its team's light; the wall itself flares there. */
  private shieldSpark(mech: number, pos: Vec3, count: number): void {
    const k = this.match.mechs[mech];
    this.fx.burst(pos, null, count, TEAM_LOOK[k.team].visor, 6);
    this.mechAvatars[mech].shieldHit();
    if (mech === this.meId && this.me.inMech) this.viewmodel.shieldHit();
  }

  /** A mech used its frame's move or ability. The player's own is shown from prediction, not again from the server. */
  private onMechAbility(id: number, what: MechAbility, source: EventSource): void {
    const m = this.match;
    const me = this.me;
    const k = m.mechs[id];
    const avatar = this.mechAvatars[id];
    const mine = id === me.id && me.inMech;
    if (mine && source === 'server') return;
    const outside = !mine || this.rig.outside;
    const at = mine ? null : k.pos;
    // Enemies hear a cloaked mech's shield and moves, never the cloak itself going on.
    switch (what) {
      case 'dash':
        this.sfx.mechDash(at);
        if (outside) this.fx.smoke(k.pos, 6, 1, 1.4, 0.7, null, 0.55);
        if (mine) {
          this.rig.kick(6);
          this.viewmodel.thud(0.8);
          this.input.rumble(0.5, 0.4, 200);
        }
        break;
      case 'leap':
        this.sfx.leap(at);
        if (outside) this.fx.smoke(k.pos, 10, 1.4, 1.5, 0.8, null, 0.55);
        if (mine) {
          this.rig.kick(4);
          this.viewmodel.thud(0.6);
          this.input.rumble(0.4, 0.5, 220);
        }
        break;
      case 'stomp': {
        const S = frameOf(k).mobility;
        const radius = S.kind === 'stomp' ? S.radius : 8;
        avatar.stomp();
        this.sfx.stomp(at);
        // The shockwave runs out along the ground as far as it reaches.
        this.fx.ring(k.pos, radius, k.team === me.team ? ALLY_ZONE : ENEMY_ZONE, 0.45);
        this.fx.ring(k.pos, radius * 0.6, '#ffe2b0', 0.3);
        this.fx.smoke(k.pos, 16, radius * 0.35, 1.6, 0.9, null, 0.5);
        this.fx.decal(k.pos, UP, 6);
        if (mine) {
          this.rig.thud(3);
          this.viewmodel.thud(1.4);
          this.input.rumble(0.9, 0.5, 260);
        } else {
          this.shake(this.near(k.pos, 22) * 0.6);
        }
        break;
      }
      case 'shieldUp':
      case 'shieldDown':
        this.sfx.shield(at, what === 'shieldUp');
        if (mine) this.input.rumble(0.1, 0.25, 90);
        break;
      case 'shieldBreak':
        this.sfx.shieldBreak(at);
        this.fx.burst({ x: k.pos.x, y: k.pos.y + 2.5, z: k.pos.z }, null, 30, TEAM_LOOK[k.team].visor, 9);
        if (mine) {
          this.hud.showBanner('SHIELD ', 'BROKEN', 'warn');
          this.input.rumble(0.6, 0.6, 240);
        }
        break;
      case 'cloakOn':
      case 'cloakOff':
        // Going under is only heard by its own side; coming out is heard by everyone near.
        if (what === 'cloakOn' && !mine && k.team !== me.team) break;
        this.sfx.cloak(at, what === 'cloakOn');
        if (mine) this.input.rumble(0.15, 0.3, 120);
        break;
    }
  }

  /** Turn what happened in the simulation into effects, sound and HUD feedback. */
  private onEvent(e: MatchEvent, source: EventSource): void {
    const m = this.match;
    const me = this.me;
    switch (e.type) {
      case 'shot': {
        const a = m.actors[e.actor];
        const mine = a === me;
        a.lastShotTime = m.time;
        if (mine && source === 'server') {
          // The shot itself was shown when the trigger was pulled. What the server
          // adds is whether it struck anyone: sparks in the victim's colours.
          for (const t of e.traces) {
            if (t.victim >= 0) this.fx.burst(t.end, null, t.head ? 10 : 5, TEAM_LOOK[m.actors[t.victim].team].visor, 5);
          }
          break;
        }
        const firstPerson = mine && !this.rig.outside;
        const body = a.inMech ? this.mechAvatars[a.id] : this.avatars[a.id];
        const muzzle = firstPerson ? this.viewmodel.muzzleWorld(this.rig.camera, this.tmp) : body.muzzleWorld(this.tmp);
        const color = mine ? OWN_TRACER : TEAM_LOOK[a.team].tracer;
        // A cannon round is drawn thicker than a rifle's, a rail slug thicker still.
        const width = (firstPerson ? 0.02 : 0.04) * (a.inMech ? 2.2 : 1) * (e.weapon === 'lance' ? 2 : 1);
        let struck: Vec3 | null = null;
        for (const t of e.traces) {
          this.fx.tracer(muzzle, t.end, color, width);
          if (t.normal) {
            this.fx.burst(t.end, t.normal, a.inMech ? 7 : 4, IMPACT_SPARK, a.inMech ? 6 : 4);
            this.fx.decal(t.end, t.normal, a.inMech ? 1.8 : 1);
            struck = t.end;
          } else if (t.victim >= 0 && source !== 'predicted') {
            // Sparks in the victim's colours, more of them for a headshot.
            this.fx.burst(t.end, null, t.head ? 10 : 5, TEAM_LOOK[m.actors[t.victim].team].visor, 5);
          } else if (t.shield) {
            this.shieldSpark(t.mech, t.end, 6);
          } else if (t.mech >= 0) {
            struck = t.end;
          }
        }
        this.fx.flash(muzzle, (mine ? 2.5 : 4) * (a.inMech ? 2 : 1));
        body.fireFlash();
        if (mine) {
          this.viewmodel.fire();
          if (source !== 'server') this.input.rumble(a.inMech ? 0.35 : 0, a.inMech ? 0.3 : (WEAPONS[e.weapon]?.pellets ?? 1) > 1 ? 0.45 : 0.18, a.inMech ? 70 : 45);
        }
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
          this.input.rumble(Math.min(1, 0.25 + e.amount / 60), 0.5, 140);
          this.sfx.hurt();
        }
        break;
      }
      case 'kill': {
        const victim = m.actors[e.victim];
        const killer = e.attacker >= 0 ? m.actors[e.attacker] : null;
        const how = killer ? `${killLabel(e.weapon)}${e.head ? ' · HEAD' : ''}` : 'FELL';
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
          this.hud.showDeath(killer ? `${killer.name} · ${killLabel(e.weapon)}` : 'THE FALL');
          this.input.resetToggles();
          this.input.rumble(0.9, 0.7, 380);
          this.sfx.death();
        }
        break;
      }
      case 'spawn':
        this.onSpawn(m.actors[e.actor]);
        break;
      case 'reload': {
        // A pilot's weapons make their own rounds; what runs out is the coolant
        // cell (or the pod's two rockets). The mech's cannon still loads a belt.
        const a = m.actors[e.actor];
        const mount = weaponOf(a).mount;
        if (a === me) {
          if (mount === 'arm') this.sfx.ventOut();
          else if (mount === 'shoulder') this.sfx.podLoad(weaponOf(a).reloadTime);
          else this.sfx.reloadOut();
        }
        // Seen from outside, the arm lets off a puff of steam.
        if (mount === 'arm' && (a !== me || this.rig.outside) && a.alive && !a.inMech) {
          const at = this.avatars[a.id].ventWorld(this.tmp);
          this.fx.smoke(at, 3, 0.08, 0.32, 0.6, UP, 0.8);
        }
        break;
      }
      case 'reloaded':
        if (e.actor !== me.id) break;
        if (weaponOf(me).mount === 'arm') this.sfx.cellIn();
        else if (weaponOf(me).mount === 'shoulder') this.sfx.podReady();
        else this.sfx.reloadIn();
        break;
      case 'dry':
        if (e.actor === me.id) this.sfx.dry(weaponOf(me).mount === 'arm');
        break;
      case 'equip':
        if (e.actor === me.id) this.sfx.equip(weaponOf(me).mount ?? 'cannon');
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

      case 'meterReady':
        if (e.actor !== me.id) break;
        this.hud.showBanner('MECH READY · ', `PRESS ${this.keyOf('call')}`, 'good');
        this.sfx.meterReady();
        break;
      case 'mechCall': {
        const a = m.actors[e.actor];
        // The machine falls straight down onto this spot: nothing to glide from.
        Object.assign(this.mechPrev[a.id], e.pos);
        Object.assign(this.mechDrawn[a.id], e.pos);
        this.sfx.dropWhistle(e.pos, e.duration, a.team !== me.team);
        if (a === me) {
          this.sfx.mechCall();
          this.hud.showBanner(`${FRAME_LIST[e.frame].short} `, 'INBOUND', 'good');
        }
        break;
      }
      case 'callDenied':
        if (e.actor !== me.id) break;
        this.sfx.denied();
        if (e.reason === 'meter') this.hud.showBanner('MECH NOT READY · ', `${Math.floor(me.meter * 100)}%`, 'warn');
        else this.hud.showBanner('NO ROOM TO LAND ', 'HERE', 'warn');
        break;
      case 'mechLand': {
        const k = m.mechs[e.mech];
        const zone = k.team === me.team ? ALLY_ZONE : ENEMY_ZONE;
        this.mechAvatars[k.id].land(40);
        this.fx.ring(e.pos, COMBAT.mech.drop.crushRadius * 1.7, zone, 0.55);
        this.fx.smoke(e.pos, 18, 2.6, 1.7, 1.5, null, 0.5);
        this.fx.burst(e.pos, UP, 34, IMPACT_SPARK, 13);
        this.fx.decal(e.pos, UP, 16);
        this.sfx.mechLand(e.pos);
        this.shake(this.near(e.pos, 45) * 0.95);
        break;
      }
      case 'embark': {
        const a = m.actors[e.actor];
        this.snap(a);
        if (a !== me) break;
        this.rig.carry();
        this.input.resetToggles();
        this.input.rumble(0.4, 0.3, 160);
        this.sfx.embark();
        break;
      }
      case 'mechOnline':
        if (e.actor !== me.id) break;
        this.sfx.mechOnline();
        this.hud.showBanner(`${frameOf(m.mechs[me.id]).short} `, 'ONLINE', 'good');
        break;
      case 'disembark': {
        const a = m.actors[e.actor];
        this.snap(a);
        if (a !== me) break;
        this.rig.carry();
        this.input.resetToggles();
        this.sfx.disembark(e.eject);
        if (e.eject) {
          this.hud.showBanner('MECH LOST · ', 'EJECTED', 'warn');
          this.shake(0.8);
        }
        break;
      }
      case 'mechStep': {
        const k = m.mechs[e.mech];
        const avatar = this.mechAvatars[k.id];
        const mine = k.id === me.id && me.inMech;
        // The player's own footfalls come from prediction, in step with what they see.
        if (mine && source === 'server') break;
        if (e.heavy) avatar.land(k.landSpeed);
        else avatar.step();
        this.sfx.mechStep(mine ? null : k.pos, e.heavy);
        // Dust at the feet, except under the player's own cockpit where it would only fog the view.
        if (!mine || this.rig.outside) this.fx.smoke(k.pos, e.heavy ? 9 : 2, 0.9, e.heavy ? 1.7 : 0.9, 0.7, null, 0.5);
        if (mine) {
          this.rig.thud(e.heavy ? 2.6 : 0.8);
          this.viewmodel.thud(e.heavy ? 1.3 : 0.45);
          this.input.rumble(e.heavy ? 0.7 : 0.25, 0.1, e.heavy ? 220 : 90);
        } else {
          // A mech walking nearby is felt before it is seen.
          this.shake(this.near(k.pos, 20) * (e.heavy ? 0.5 : 0.2));
        }
        break;
      }
      case 'mechAbility':
        this.onMechAbility(e.mech, e.what, source);
        break;
      case 'shieldHit': {
        const k = m.mechs[e.mech];
        this.shieldSpark(k.id, e.pos, Math.min(20, 4 + e.amount / 20));
        if (e.attacker === me.id) {
          this.hud.hitmarker(false, false, true);
          this.sfx.shieldHit(e.pos, e.broken);
        } else if (k.id === me.id && me.inMech) {
          this.sfx.shieldHit(null, e.broken);
          this.viewmodel.thud(Math.min(0.6, e.amount / 400));
          this.input.rumble(0.15, 0.2, 80);
        } else {
          this.sfx.shieldHit(e.pos, e.broken);
        }
        break;
      }
      case 'ram': {
        const where = e.victim >= 0 ? m.actors[e.victim].p.pos : m.mechs[e.other].pos;
        const at = this.at;
        at.x = where.x;
        at.y = where.y + (e.victim >= 0 ? 1 : 3);
        at.z = where.z;
        this.sfx.ram(at);
        this.fx.burst(at, null, 20, IMPACT_SPARK, 10);
        if (e.mech === me.id || e.other === me.id) {
          this.shake(0.45);
          this.viewmodel.thud(1.2);
        }
        break;
      }
      case 'mechDamage': {
        const k = m.mechs[e.mech];
        this.mechAvatars[k.id].flash(e.crit);
        this.fx.burst(e.pos, null, e.crit ? 12 : 4, e.crit ? CRIT_SPARK : IMPACT_SPARK, e.crit ? 8 : 5);
        if (e.attacker === me.id) {
          this.hud.hitmarker(e.crit, e.destroyed, true);
          this.hud.damageNumber(k.id, e.pos, e.amount, e.crit, true);
          this.hud.revealMech(k.id);
          this.sfx.armorHit(e.crit);
        }
        // The player's own hull, felt from the seat. (When this hit destroyed it they are already out.)
        if (k.id === me.id && (me.inMech || e.destroyed)) {
          const from = m.actors[e.attacker].p.pos;
          this.hud.damageFrom(from.x, from.z, e.amount / 8);
          const dx = from.x - me.p.pos.x;
          const dz = from.z - me.p.pos.z;
          const side = Math.sign(dx * Math.cos(me.p.yaw) - dz * Math.sin(me.p.yaw)) || 1;
          this.rig.jolt(side, Math.min(1, 0.12 + e.amount / 400));
          this.viewmodel.thud(Math.min(1.5, e.amount / 160));
          this.input.rumble(Math.min(1, 0.2 + e.amount / 300), 0.3, 150);
          this.sfx.hullHit(e.amount);
        }
        break;
      }
      case 'mechDestroyed': {
        const owner = m.actors[e.mech];
        const killer = e.attacker >= 0 ? m.actors[e.attacker] : null;
        this.mechAvatars[e.mech].destroy();
        const core = this.at;
        core.x = e.pos.x;
        core.y = e.pos.y + 2.8;
        core.z = e.pos.z;
        this.fx.explosion(core, null, 8);
        this.fx.fireball({ x: core.x, y: core.y + 1.6, z: core.z }, 3.4, 0.6);
        this.fx.burst(core, null, 60, IMPACT_SPARK, 19);
        this.fx.smoke(core, 22, 1.6, 2.8, 2.8, null, 0.2);
        this.fx.ring(e.pos, 10, '#ffb066', 0.6);
        this.fx.decal(e.pos, UP, 20);
        this.sfx.mechDestroyed(e.pos);
        this.shake(this.near(e.pos, 55));
        if (killer) this.hud.addKill(killer, owner, killLabel(e.weapon), me, ` · ${frameOf(m.mechs[e.mech]).short}`);
        if (killer === me) {
          this.hud.showBanner('MECH DESTROYED ', owner.name);
          this.rig.kick(6);
          this.sfx.kill();
        }
        break;
      }
      case 'launch': {
        const a = m.actors[e.actor];
        const def = PROJECTILES[e.kind];
        const mine = a === me;
        const salvo = a.inMech && !def.mechFuse;
        let id = e.id;
        if (mine && source === 'predicted') {
          // Drawn at once under an id of its own, until the server announces the real one.
          id = this.nextRocket++;
          this.ownRockets.push(id);
        } else if (mine && source === 'server' && this.ownRockets.length) {
          // The rocket already in the air is this one: remember it for when it bursts.
          this.rocketAlias.set(e.id, this.ownRockets.shift()!);
          break;
        }
        // It leaves the pod it was fired from: the mech's, or the one on the
        // pilot's shoulder (the player's own is drawn by the viewmodel).
        let from: THREE.Vector3 | null = null;
        if (salvo) {
          if (!mine || this.rig.outside) from = this.mechAvatars[a.id].podWorld(this.tmp);
        } else if (mine && !this.rig.outside) {
          from = this.viewmodel.muzzleWorld(this.rig.camera, this.tmp);
        } else {
          from = (a.inMech ? this.mechAvatars[a.id] : this.avatars[a.id]).muzzleWorld(this.tmp);
        }
        this.fx.rocket(id, e.pos, e.dir, def.speed, def.life + 0.2, from, def.mechFuse !== undefined);
        if (salvo) {
          this.mechAvatars[a.id].podFlash();
          this.sfx.launch(mine ? null : e.pos);
          if (mine) {
            this.viewmodel.thud(0.35);
            this.input.rumble(0.45, 0.35, 160);
          }
        }
        break;
      }
      case 'explode': {
        const def = PROJECTILES[e.kind];
        this.fx.endRocket(this.rocketAlias.get(e.id) ?? e.id);
        this.rocketAlias.delete(e.id);
        this.fx.explosion(e.pos, e.normal, def.radius);
        // A flak burst is a crack, not a rocket's boom.
        if (def.mechFuse) this.sfx.flakBurst(e.pos);
        else this.sfx.explosion(e.pos);
        this.shake(this.near(e.pos, 24) * (def.mechFuse ? 0.25 : 0.6));
        break;
      }

      case 'matchEnd':
        this.endedAt = performance.now();
        this.hud.showEnd(e.winner === me.team, m, me);
        this.sfx.matchEnd(e.winner === me.team);
        break;
    }
  }
}
