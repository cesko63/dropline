/**
 * A pad through the browser's Gamepad API, read once a frame. Only pads in the
 * standard layout are used (the browser maps most pads to it); the first one
 * that reports anything wins.
 */

/** Stick position after a circular deadzone, with the rest of the throw rescaled to start at 0. */
export function deadzoned(x: number, y: number, dead: number): { x: number; y: number; mag: number } {
  const len = Math.hypot(x, y);
  if (len <= dead) return { x: 0, y: 0, mag: 0 };
  const mag = Math.min(1, (len - dead) / (1 - dead));
  return { x: (x / len) * mag, y: (y / len) * mag, mag };
}

/** Triggers and buttons count as pressed past this. */
const PRESS = 0.35;
const BUTTONS = 17;

export class Pad {
  /** Index in `navigator.getGamepads()` of the pad in use, or -1. */
  index = -1;
  /** Left stick after the deadzone: x right, y forward (up on the stick). */
  moveX = 0;
  moveY = 0;
  /** Right stick after the deadzone: x right, y up. */
  lookX = 0;
  lookY = 0;
  readonly down: boolean[] = new Array(BUTTONS).fill(false);
  /** Buttons that went down since the last `poll`. */
  readonly pressed: boolean[] = new Array(BUTTONS).fill(false);
  /** True for a poll in which anything on the pad moved or was pressed. */
  touched = false;
  private actuator: { playEffect?: (type: string, params: object) => Promise<unknown> } | null = null;

  /** Read the pad. `dead` is the stick deadzone, 0..1. */
  poll(dead: number): void {
    this.touched = false;
    this.pressed.fill(false);
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = this.index >= 0 ? (pads[this.index] ?? null) : null;
    if (!pad || !pad.connected) {
      pad = null;
      this.index = -1;
      for (const p of pads) {
        if (p && p.connected && p.mapping === 'standard' && p.buttons.some((b) => b.pressed)) {
          pad = p;
          this.index = p.index;
          break;
        }
      }
    }
    if (!pad) {
      this.release();
      return;
    }
    this.actuator = (pad as unknown as { vibrationActuator?: Pad['actuator'] }).vibrationActuator ?? null;
    const a = pad.axes;
    const m = deadzoned(a[0] ?? 0, a[1] ?? 0, dead);
    const l = deadzoned(a[2] ?? 0, a[3] ?? 0, dead);
    this.moveX = m.x;
    this.moveY = -m.y;
    this.lookX = l.x;
    this.lookY = -l.y;
    if (m.mag > 0 || l.mag > 0) this.touched = true;
    for (let i = 0; i < BUTTONS; i++) {
      const b = pad.buttons[i];
      const now = !!b && (b.pressed || b.value > PRESS);
      if (now && !this.down[i]) {
        this.pressed[i] = true;
        this.touched = true;
      }
      this.down[i] = now;
    }
  }

  /** Let go of everything (the pad was unplugged or the window lost focus). */
  release(): void {
    this.moveX = this.moveY = this.lookX = this.lookY = 0;
    this.down.fill(false);
  }

  /** Rumble: `strong` is the heavy motor, `weak` the light one, both 0..1. */
  rumble(strong: number, weak: number, ms: number): void {
    if (this.index < 0 || !this.actuator?.playEffect) return;
    void this.actuator
      .playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) })
      .catch(() => {});
  }
}
