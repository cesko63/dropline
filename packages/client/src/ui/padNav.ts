import type { Sfx } from '../audio/sfx';
import { PAD_START } from '../input/input';
import type { Pad } from '../input/gamepad';
import type { Hangar } from './hangar';
import type { SettingsScreen } from './settingsScreen';

/**
 * The start screen and the settings on a pad: the D-pad or the left stick moves
 * between controls (held, it repeats), left and right step a slider, A presses,
 * B goes back, LB and RB change the settings or hangar tab, MENU resumes the match.
 * In the hangar the right stick turns the preview (see `Hangar.update`).
 */

const A = 0;
const B = 1;
const LB = 4;
const RB = 5;
const UP = 12;
const DOWN = 13;
const LEFT = 14;
const RIGHT = 15;
/** Seconds before a held direction repeats, and between repeats. */
const DELAY = 0.38;
const REPEAT = 0.11;

type Dir = 'up' | 'down' | 'left' | 'right' | '';

export class PadNav {
  /** MENU on the start screen: resume the match if one is running. */
  onStart: () => void = () => {};
  private held: Dir = '';
  private heldFor = 0;

  constructor(
    private readonly panel: HTMLElement,
    private readonly settings: SettingsScreen,
    private readonly sfx: Sfx,
    private readonly hangar: Hangar,
  ) {}

  /** Once a frame while the start screen is up. */
  update(pad: Pad, dt: number): void {
    if (pad.index < 0) return;
    const p = pad.pressed;
    if (this.settings.listeningPad) {
      for (let i = 0; i < p.length; i++) if (p[i]) this.settings.capturePad(i);
      return;
    }
    if (this.settings.isListening) return;

    if (p[PAD_START]) {
      if (this.settings.isOpen) this.settings.close();
      if (this.hangar.isOpen) this.hangar.close();
      this.onStart();
      return;
    }
    if (this.hangar.isOpen && (p[LB] || p[RB])) this.hangar.nextTab(p[RB] ? 1 : -1);
    if (p[B] && this.hangar.isOpen) this.hangar.close();
    if (this.settings.isOpen && (p[LB] || p[RB])) this.settings.nextTab(p[RB] ? 1 : -1);
    if (p[B] && this.settings.isOpen) this.settings.close();
    if (p[A]) {
      const f = this.focused();
      if (f) {
        f.click();
        if (f instanceof HTMLInputElement && f.type === 'text') f.select();
      } else {
        this.move(1);
      }
    }

    // Directions: D-pad or a firm push of the left stick, with repeat while held.
    let dir: Dir = '';
    if (pad.down[UP] || pad.moveY > 0.6) dir = 'up';
    else if (pad.down[DOWN] || pad.moveY < -0.6) dir = 'down';
    else if (pad.down[LEFT] || pad.moveX < -0.6) dir = 'left';
    else if (pad.down[RIGHT] || pad.moveX > 0.6) dir = 'right';
    let fire = false;
    if (dir !== this.held) {
      this.held = dir;
      this.heldFor = 0;
      fire = dir !== '';
    } else if (dir) {
      this.heldFor += dt;
      if (this.heldFor >= DELAY) {
        this.heldFor -= REPEAT;
        fire = true;
      }
    }
    if (!fire) return;
    const f = this.focused();
    if (f instanceof HTMLInputElement && f.type === 'range' && (dir === 'left' || dir === 'right')) {
      if (dir === 'left') f.stepDown();
      else f.stepUp();
      f.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    this.move(dir === 'up' || dir === 'left' ? -1 : 1);
  }

  /** Focus the first thing to press, so a pad player sees where they are. */
  focusFirst(): void {
    const all = this.targets();
    if (!all.includes(document.activeElement as HTMLElement)) all[0]?.focus();
  }

  private focused(): HTMLElement | null {
    const a = document.activeElement as HTMLElement | null;
    return a && this.panel.contains(a) ? a : null;
  }

  /** Everything on screen that can be pressed or changed, in page order. */
  private targets(): HTMLElement[] {
    return [...this.panel.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter(
      (e) => !(e as HTMLButtonElement).disabled && e.offsetParent !== null,
    );
  }

  private move(step: number): void {
    const all = this.targets();
    if (!all.length) return;
    const i = all.indexOf(this.focused() as HTMLElement);
    const next = all[i < 0 ? 0 : (i + step + all.length) % all.length];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    this.sfx.uiMove();
  }
}
