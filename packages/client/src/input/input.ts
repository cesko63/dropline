import type { InputCmd } from '@dropline/shared';

/**
 * Bindings by KeyboardEvent.code, or `Mouse0`..`Mouse4` for mouse buttons.
 * Ctrl is avoided: Ctrl+W closes the tab.
 */
export const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['KeyC'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  fire: ['Mouse0'],
  ads: ['Mouse2'],
  reload: ['KeyR'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  weapon4: ['Digit4'],
  use: ['KeyE'],
  call: ['KeyF'],
  nextWeapon: ['KeyQ'],
  toggleView: ['KeyV'],
  respawn: ['KeyK'],
  mute: ['KeyM'],
  confirm: ['Enter'],
};

const PITCH_LIMIT = Math.PI / 2 - 0.02;

export class Input {
  yaw = 0;
  pitch = 0;
  /** Radians per pixel of mouse travel. */
  sensitivity = 0.0022;
  /** Multiplies the sensitivity; lowered while zoomed in so aiming stays steady. */
  sensScale = 1;
  /** Loadout slot the player wants, or -1 for no change. */
  weapon = -1;
  private wheel = 0;
  locked = false;
  /** Mouse travel since the last `takeMouseDelta`, for viewmodel sway. */
  private dx = 0;
  private dy = 0;
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  /** Scripted input for automated checks; replaces the keyboard when set. */
  override: Partial<InputCmd> | null = null;
  onLockChange: (locked: boolean) => void = () => {};
  /** Called when the browser refuses to capture the mouse. */
  onLockError: () => void = () => {};

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.locked) return;
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const k = this.sensitivity * this.sensScale;
      this.yaw -= e.movementX * k;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * k));
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.pressed.add(`Mouse${e.button}`);
      this.down.add(`Mouse${e.button}`);
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
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) this.down.clear();
      this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.onLockError());
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

  private held(action: keyof typeof BINDINGS): boolean {
    return BINDINGS[action].some((code) => this.down.has(code));
  }

  /** True once per key press. */
  consume(action: keyof typeof BINDINGS): boolean {
    let hit = false;
    for (const code of BINDINGS[action]) hit = this.pressed.delete(code) || hit;
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

  sample(): InputCmd {
    const cmd: InputCmd = {
      moveX: (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0),
      moveZ: (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0),
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.held('jump'),
      crouch: this.held('crouch'),
      sprint: this.held('sprint'),
      fire: this.held('fire'),
      ads: this.held('ads'),
      reload: this.held('reload'),
      use: this.held('use'),
      call: this.held('call'),
      weapon: this.weapon,
    };
    if (this.override) {
      Object.assign(cmd, this.override);
      this.yaw = cmd.yaw;
      this.pitch = cmd.pitch;
    }
    return cmd;
  }
}
