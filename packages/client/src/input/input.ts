import type { InputCmd } from '@dropline/shared';
import type { Settings } from '../settings/settings';
import { ACTIONS, type Action } from './bindings';
import { Pad } from './gamepad';

const PITCH_LIMIT = Math.PI / 2 - 0.02;
/** Radians per pixel of mouse travel at sensitivity 1. */
const MOUSE_BASE = 0.0022;
/** Right-stick turn rate at full throw and sensitivity 1, radians per second (about 185°/s). */
const PAD_YAW = 3.2;
/** Up and down turn slower than left and right. */
const PAD_PITCH = 0.62;
/** How much of the turn rate is left while the crosshair rests on an enemy (pad, aim slowdown on). */
const SLOWDOWN = 0.55;
/** Start (MENU) on a pad: pause and resume. */
export const PAD_START = 9;

export type Device = 'kbm' | 'pad';

/**
 * Everything the player presses, as actions. Keys and mouse buttons arrive as
 * events while the game has the mouse; the pad is read once a frame. A press
 * shorter than one simulation tick still counts: it is kept until the next tick
 * has seen it.
 */
export class Input {
  yaw = 0;
  pitch = 0;
  /** Multiplies the look speed; set below 1 while zoomed in so aiming stays steady. */
  sensScale = 1;
  /** 0..1: how firmly the crosshair rests on an enemy, for the pad's aim slowdown. Set by the game. */
  assist = 0;
  /** Loadout slot the player wants, or -1 for no change. */
  weapon = -1;
  locked = false;
  /** Playing with the pad, without the mouse captured. */
  private padPlaying = false;
  /** The device last used, for which prompts to show. */
  device: Device = 'kbm';
  readonly pad = new Pad();
  /** Scripted input for automated checks; replaces the keyboard when set. */
  override: Partial<InputCmd> | null = null;
  /** The game is (or stops being) under the player's control. */
  onPlayingChange: (playing: boolean) => void = () => {};
  onDeviceChange: (device: Device) => void = () => {};
  /** Called when the browser refuses to capture the mouse. */
  onLockError: () => void = () => {};

  private wheel = 0;
  /** Mouse travel since the last `takeMouseDelta`, for viewmodel sway. */
  private dx = 0;
  private dy = 0;
  /** Codes held right now: keys, mouse buttons, pad buttons. */
  private readonly down = new Set<string>();
  /** Codes pressed since the frame's one-press actions last looked (`consume`). */
  private readonly pressed = new Set<string>();
  /** Codes pressed since the last simulation tick, so a quick tap is never lost. */
  private readonly fresh = new Set<string>();
  // Toggle states for the actions the player set to toggle (and the pad's sprint).
  private aimOn = false;
  private crouchOn = false;
  private sprintOn = false;
  /** Pad look as yaw and pitch per second, from the last `update`. */
  private lookYawRate = 0;
  private lookPitchRate = 0;

  constructor(
    private readonly target: HTMLElement,
    private settings: Settings,
  ) {
    // A real click or key on the menus means the keyboard and mouse are back in use
    // (this runs before the click that resumes, so that click captures the mouse).
    document.addEventListener('pointerdown', (e) => {
      if (!this.playing && e.isTrusted && e.pointerType !== 'touch') this.useDevice('kbm');
    }, true);
    window.addEventListener('keydown', (e) => {
      if (!this.playing) {
        if (e.isTrusted) this.useDevice('kbm');
        return;
      }
      if (e.code === 'Escape' && this.padPlaying) {
        this.setPadPlaying(false);
        return;
      }
      this.useDevice('kbm');
      this.press(e.code, e.repeat);
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    // Focus gone: nothing stays held, and a pad game pauses (the mouse is released by the browser).
    window.addEventListener('blur', () => {
      this.setPadPlaying(false);
      this.releaseAll();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      if (e.movementX || e.movementY) this.useDevice('kbm');
      const k = MOUSE_BASE * this.settings.mouseSens * this.lookScale();
      this.yaw -= e.movementX * k;
      this.turnPitch(-e.movementY * k);
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.useDevice('kbm');
      this.press(`Mouse${e.button}`, false);
      e.preventDefault();
    });
    document.addEventListener('mouseup', (e) => this.down.delete(`Mouse${e.button}`));
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener(
      'wheel',
      (e) => {
        if (this.locked) this.wheel += Math.sign(e.deltaY);
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      const was = this.playing;
      this.locked = document.pointerLockElement === this.target;
      if (this.locked) this.padPlaying = false;
      if (!this.locked) this.releaseAll();
      if (this.playing !== was) this.onPlayingChange(this.playing);
    });
    document.addEventListener('pointerlockerror', () => this.onLockError());
  }

  setSettings(s: Settings): void {
    this.settings = s;
  }

  /** The player is in control: the mouse is captured, or they are playing on a pad. */
  get playing(): boolean {
    return this.locked || this.padPlaying;
  }

  /** Start or stop playing on the pad (Start, or A on the start screen). */
  setPadPlaying(on: boolean): void {
    if (on === this.padPlaying) return;
    const was = this.playing;
    this.padPlaying = on;
    if (!on) this.releaseAll();
    if (this.playing !== was) this.onPlayingChange(this.playing);
  }

  /** Ask the browser to capture the mouse. Must be called from a click or key press. */
  async lock(): Promise<void> {
    const request = this.target.requestPointerLock as (options?: object) => Promise<void> | undefined;
    try {
      // Raw mouse input (no OS acceleration) where the browser supports it.
      await request.call(this.target, { unadjustedMovement: true });
    } catch (err) {
      if ((err as DOMException).name !== 'NotSupportedError') return;
      try {
        await request.call(this.target);
      } catch {
        // Reported through the pointerlockerror event below.
      }
    }
  }

  /** Read the pad and turn the view with the right stick. Once a frame, before anything asks for actions. */
  update(dt: number): void {
    const pad = this.pad;
    pad.poll(this.settings.deadzone);
    if (pad.touched) this.useDevice('pad');
    for (let i = 0; i < pad.down.length; i++) {
      const code = `Pad${i}`;
      if (pad.pressed[i] && this.playing) this.press(code, false);
      if (!pad.down[i]) this.down.delete(code);
    }
    this.lookYawRate = this.lookPitchRate = 0;
    if (!this.playing) return;
    // A curve on the throw: fine aim near the middle, a fast turn at the edge.
    const mag = Math.hypot(pad.lookX, pad.lookY);
    if (mag > 0) {
      const curve = Math.pow(mag, 1.8) / mag;
      const slow = this.settings.aimSlowdown ? 1 - (1 - SLOWDOWN) * this.assist : 1;
      const rate = PAD_YAW * this.settings.padSens * this.lookScale() * slow * curve;
      this.lookYawRate = -pad.lookX * rate;
      this.lookPitchRate = pad.lookY * rate * PAD_PITCH;
      this.yaw += this.lookYawRate * dt;
      this.turnPitch(this.lookPitchRate * dt);
      this.dx -= (this.lookYawRate * dt) / MOUSE_BASE;
      this.dy -= (this.lookPitchRate * dt) / MOUSE_BASE;
    }
  }

  /** Make the pad feel a hit, a blast or a shot, when vibration is on and the pad is in use. */
  rumble(strong: number, weak: number, ms: number): void {
    if (this.settings.vibration && this.device === 'pad' && this.padPlaying) this.pad.rumble(strong, weak, ms);
  }

  /** True once per press, for the frame's one-press actions (switch view, mute …). */
  consume(action: Action): boolean {
    let hit = false;
    for (const code of this.codes(action)) hit = this.pressed.delete(code) || hit;
    return hit;
  }

  /** Wheel notches since the last call; positive scrolls down. */
  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  takeMouseDelta(): { dx: number; dy: number } {
    const d = { dx: this.dx, dy: this.dy };
    this.dx = this.dy = 0;
    return d;
  }

  /** Drop the toggled states: after a death, a respawn, getting in or out of a mech. */
  resetToggles(): void {
    this.aimOn = this.crouchOn = this.sprintOn = false;
  }

  /**
   * The command for one simulation tick. `tick` false only looks (the frame's own
   * read, before any tick runs) and keeps quick presses for the tick to come.
   */
  sample(tick = true): InputCmd {
    const s = this.settings;
    const pad = this.pad;
    const padMove = pad.moveX !== 0 || pad.moveY !== 0;
    let moveX = padMove ? pad.moveX : (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    let moveZ = padMove ? pad.moveY : (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0);
    // Keyboard diagonals are no faster than straight lines (the simulation also caps the length at 1).
    const len = Math.hypot(moveX, moveZ);
    if (len > 1) {
      moveX /= len;
      moveZ /= len;
    }

    let aim = this.held('ads');
    let crouch = this.held('crouch');
    let sprint = this.held('sprint');
    if (tick) {
      if (s.aimMode === 'toggle' && this.edge('ads')) this.aimOn = !this.aimOn;
      if (s.crouchMode === 'toggle') {
        if (this.edge('crouch')) this.crouchOn = !this.crouchOn;
        if (this.edge('jump')) this.crouchOn = false;
      }
      // Sprint on the pad is a click on the stick that lasts until the pilot stops running forward.
      const padSprint = this.edgeOn('sprint', true);
      if ((s.sprintMode === 'toggle' && this.edge('sprint')) || padSprint) this.sprintOn = padSprint ? true : !this.sprintOn;
      if (moveZ <= 0.1) this.sprintOn = false;
    }
    if (s.aimMode === 'toggle') aim = this.aimOn;
    if (s.crouchMode === 'toggle') crouch = this.crouchOn;
    if (s.sprintMode === 'toggle' || this.sprintOn) sprint = this.sprintOn || (s.sprintMode === 'hold' && sprint);

    const cmd: InputCmd = {
      moveX,
      moveZ,
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.held('jump'),
      crouch,
      sprint,
      fire: this.held('fire'),
      ads: aim,
      reload: this.held('reload'),
      use: this.held('use'),
      call: this.held('call'),
      redeploy: this.held('respawn'),
      weapon: this.weapon,
    };
    if (tick) this.fresh.clear();
    if (this.override) {
      Object.assign(cmd, this.override);
      this.yaw = cmd.yaw;
      this.pitch = cmd.pitch;
    }
    return cmd;
  }

  // ---------------------------------------------------------------- inside

  private codes(action: Action): string[] {
    const keys = ACTIONS[action].fixed ? ACTIONS[action].keys : this.settings.keys[action];
    const pad = ACTIONS[action].fixed ? ACTIONS[action].pad : this.settings.pad[action];
    return keys.concat(pad);
  }

  private press(code: string, repeat: boolean): void {
    if (!repeat) {
      this.pressed.add(code);
      this.fresh.add(code);
    }
    this.down.add(code);
  }

  /** Held now, or pressed and let go again since the last tick. */
  private held(action: Action): boolean {
    return this.codes(action).some((c) => this.down.has(c) || this.fresh.has(c));
  }

  /** Pressed since the last tick. */
  private edge(action: Action): boolean {
    return this.codes(action).some((c) => this.fresh.has(c));
  }

  /** Pressed since the last tick on the pad (`pad` true) or on the keyboard and mouse. */
  private edgeOn(action: Action, pad: boolean): boolean {
    return this.codes(action).some((c) => c.startsWith('Pad') === pad && this.fresh.has(c));
  }

  private lookScale(): number {
    return this.sensScale < 0.999 ? this.sensScale * this.settings.aimSens : 1;
  }

  private turnPitch(d: number): void {
    const dir = this.settings.invertY ? -1 : 1;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + d * dir));
  }

  private useDevice(d: Device): void {
    if (d === this.device) return;
    this.device = d;
    this.onDeviceChange(d);
  }

  /**
   * The key-up never arrives once focus is gone: let go of everything. The pad
   * keeps what it knows is held, so a button held through a pause does not
   * count as pressed again.
   */
  private releaseAll(): void {
    this.down.clear();
    this.fresh.clear();
    this.resetToggles();
  }
}
