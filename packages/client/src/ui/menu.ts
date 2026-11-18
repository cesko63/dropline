import { NET } from '@dropline/shared';
import type { Action } from '../input/bindings';
import type { Device } from '../input/input';
import type { Settings } from '../settings/settings';

/**
 * The start screen: pick a callsign, deploy online or practice offline, and
 * once in a match, resume it or leave. It only shows and reports; `main.ts`
 * decides what each choice does.
 */

const NAME_KEY = 'dropline.name';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** The name as the server will accept it: printable, single spaces, at most `NET.nameLength`. */
export function cleanName(raw: string): string {
  return raw
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NET.nameLength);
}

export class Menu {
  onOnline: (name: string) => void = () => {};
  onOffline: () => void = () => {};
  onResume: () => void = () => {};
  onLeave: () => void = () => {};
  onSettings: () => void = () => {};
  onHangar: () => void = () => {};

  private readonly overlay = el('overlay');
  private readonly choose = el('menu');
  private readonly resume = el('resume');
  private readonly name = el<HTMLInputElement>('callsign');
  private readonly online = el<HTMLButtonElement>('play-online');
  private readonly offline = el<HTMLButtonElement>('play-offline');
  private readonly status = el('menu-status');
  private readonly controls = el('controls');
  /** The controls list and its heading, beside the choices. */
  private readonly manual = el('manual');
  private readonly keys = el('menu-keys');
  private readonly settingsBox = el('settings');
  private readonly hangarBox = el('hangar');
  private readonly hangarSummary = el('hangar-summary');
  private readonly start = el<HTMLButtonElement>('start');
  /** Which of the two first screens was up before the settings opened. */
  private before: 'menu' | 'resume' = 'menu';

  constructor(name: string) {
    let stored = '';
    try {
      stored = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      // No storage: the callsign is asked for each visit.
    }
    this.name.value = cleanName(name || stored) || `PILOT ${100 + Math.floor(Math.random() * 900)}`;
    this.name.maxLength = NET.nameLength;

    this.online.addEventListener('click', () => this.onOnline(this.callsign()));
    this.offline.addEventListener('click', () => this.onOffline());
    this.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.online.disabled) this.onOnline(this.callsign());
    });
    el('start').addEventListener('click', () => this.onResume());
    el('leave').addEventListener('click', () => this.onLeave());
    el('settings-menu').addEventListener('click', () => this.onSettings());
    el('settings-resume').addEventListener('click', () => this.onSettings());
    el('hangar-menu').addEventListener('click', () => this.onHangar());
  }

  /** True while a match can be resumed from this screen. */
  get canResume(): boolean {
    return this.before === 'resume' || !this.resume.hidden;
  }

  /** The settings take the place of the choices and the controls list. */
  showSettings(): void {
    this.showSub();
  }

  /** The hangar too; it is only reached from the first screen, before a match. */
  showHangar(): void {
    this.showSub();
  }

  /** Back from the hangar to the choices. */
  hideHangar(): void {
    this.hangarBox.hidden = true;
    this.hideSub('hangar-menu');
  }

  /** What the player will deploy with, on the hangar button. */
  setLoadout(text: string): void {
    this.hangarSummary.textContent = text;
  }

  private showSub(): void {
    this.before = this.resume.hidden ? 'menu' : 'resume';
    this.choose.hidden = true;
    this.resume.hidden = true;
    this.manual.hidden = true;
    this.panel().classList.add('wide');
  }

  /** Back from the settings to where the player was. */
  hideSettings(): void {
    this.settingsBox.hidden = true;
    this.hideSub(this.before === 'menu' ? 'settings-menu' : 'settings-resume');
  }

  private hideSub(focus: string): void {
    this.manual.hidden = false;
    this.panel().classList.remove('wide');
    if (this.before === 'menu') this.choose.hidden = false;
    else this.resume.hidden = false;
    el(focus).focus();
  }

  private panel(): HTMLElement {
    return this.overlay.querySelector('.panel') as HTMLElement;
  }

  /**
   * The list of controls under the choices, in the keys the player has bound,
   * or the pad's buttons while they use one.
   */
  renderControls(key: (a: Action) => string, device: Device, s: Settings): void {
    const pad = device === 'pad';
    const k = (a: Action): string => key(a) || '—';
    const hold = (mode: string, a: Action): string => (mode === 'toggle' ? `${k(a)} (toggle)` : k(a));
    const rows: [string, string][] = pad
      ? [
          ['Left stick', 'Move'],
          ['Right stick', 'Look'],
          [hold(s.sprintMode, 'sprint'), 'Sprint until you stop running forward'],
          [k('jump'), 'Jump, again in the air to double jump; hold for jetpack thrust'],
          [hold(s.crouchMode, 'crouch'), 'Crouch, or slide while sprinting'],
          ['Jump at a wall', 'Wallrun. Jump again to leap off'],
          [k('fire'), 'Fire'],
          [hold(s.aimMode, 'ads'), 'Aim: raises the arm and zooms in'],
          [k('reload'), 'Vent the arm and swap its coolant cell; reload the pod'],
          [`${k('nextWeapon')} · ${k('weapon4')}`, 'Next arm barrel · raise the shoulder launcher'],
          [k('call'), 'Call your mech where you look, once the meter is full'],
          [k('use'), 'Climb into your mech, or out of it'],
          ['In the mech', `${k('jump')} dashes, ${k('ads')} fires the rocket salvo`],
          [k('toggleView'), 'First / third person'],
          [k('swapShoulder'), 'Third person: look over the other shoulder'],
          [k('respawn'), 'Redeploy at a spawn point'],
          ['Menu', 'Pause and settings. Offline this pauses the match'],
        ]
      : [
          [[k('forward'), k('left'), k('back'), k('right')].join(' '), 'Move'],
          [hold(s.sprintMode, 'sprint'), 'Sprint'],
          [k('jump'), 'Jump, again in the air to double jump'],
          [`Hold ${k('jump')}`, 'Jetpack thrust while airborne'],
          [hold(s.crouchMode, 'crouch'), 'Crouch, or slide while sprinting'],
          ['Jump at a wall', `Wallrun. ${k('jump')} leaps off: steer away to cross, steer into the wall to hop back on`],
          ['Forward at a ledge', 'Mantle up'],
          [k('fire'), 'Fire'],
          [hold(s.aimMode, 'ads'), 'Aim: raises the arm and zooms in (the marksman barrel has a scope)'],
          [k('reload'), 'Vent the arm and swap its coolant cell; reload the shoulder pod'],
          [`${k('weapon1')} ${k('weapon2')} ${k('weapon3')} ${k('weapon4')} · ${k('nextWeapon')} · Wheel`, 'Arm barrels: carbine, scattergun, marksman. The fourth is the shoulder launcher'],
          [k('call'), 'Call your mech where you look, once the meter is full'],
          [k('use'), 'Climb into your mech, or out of it'],
          ['In the mech', `${k('jump')} dashes, ${k('ads')} fires the rocket salvo`],
          [k('toggleView'), 'First / third person'],
          [k('swapShoulder'), 'Third person: look over the other shoulder'],
          [k('respawn'), 'Redeploy at a spawn point'],
          [k('mute'), 'Sound on / off'],
          [k('netDebug'), 'Connection details, when online'],
          ['Esc', 'Release the mouse. Offline this pauses the match'],
        ];
    this.controls.replaceChildren(
      ...rows.map(([keys, what]) => {
        const div = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = keys;
        const dd = document.createElement('dd');
        dd.textContent = what;
        div.append(dt, dd);
        return div;
      }),
    );
    this.start.textContent = pad ? 'Press A to resume' : 'Click to resume';
    // The strip along the bottom: how to get around these screens on this device.
    const strip: [string, string][] = pad
      ? [['D-pad', 'Move'], ['A', 'Select'], ['B', 'Back'], ['LB RB', 'Tabs'], ['Menu', 'Resume']]
      : [['Click', 'Select'], ['Tab', 'Move'], ['Esc', 'Back']];
    this.keys.replaceChildren(
      ...strip.map(([keys, what]) => {
        const span = document.createElement('span');
        const cap = document.createElement('b');
        cap.textContent = keys;
        span.append(cap, what);
        return span;
      }),
    );
  }

  /** The callsign as typed, tidied and remembered for next time. */
  callsign(): string {
    const name = cleanName(this.name.value) || 'PILOT';
    this.name.value = name;
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // See above.
    }
    return name;
  }

  /** Back to the first screen, optionally saying what went wrong. */
  showChoices(error = ''): void {
    this.before = 'menu';
    this.choose.hidden = this.settingsOpen;
    this.resume.hidden = true;
    this.busy(false);
    this.say(error, 'error');
    this.overlay.classList.remove('hidden');
  }

  /** Waiting for the server to answer. */
  showConnecting(where: string): void {
    this.busy(true);
    this.say(`Connecting to ${where} …`, 'info');
  }

  /** A match is running: the screen now only resumes or leaves it. */
  showPlaying(): void {
    this.before = 'resume';
    this.choose.hidden = true;
    this.resume.hidden = this.settingsOpen;
    this.busy(false);
    this.say('', 'info');
  }

  private get settingsOpen(): boolean {
    return !this.settingsBox.hidden || !this.hangarBox.hidden;
  }

  /** Take the screen away without the mouse being captured (automated checks). */
  hide(): void {
    this.overlay.classList.add('hidden');
  }

  private busy(on: boolean): void {
    this.online.disabled = on;
    this.offline.disabled = on;
    el<HTMLButtonElement>('hangar-menu').disabled = on;
    this.name.disabled = on;
  }

  private say(text: string, kind: 'info' | 'error'): void {
    this.status.hidden = text === '';
    this.status.textContent = text;
    this.status.dataset.kind = kind;
  }
}
