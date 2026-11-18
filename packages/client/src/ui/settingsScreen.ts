import type { Sfx } from '../audio/sfx';
import { ACTIONS, ACTION_NAMES, KEY_SLOTS, bind, codeLabel, defaultKeys, defaultPad, unbind, type Action, type BindTable } from '../input/bindings';
import { PAD_START } from '../input/input';
import { NOTICE_TEXT, RANGES, defaultSettings, type Hold, type Settings, type SettingsStore } from '../settings/settings';

/**
 * The settings screen inside the start panel. Every change applies and saves at
 * once; there is nothing to confirm. Bindings are changed by pressing the new
 * key, mouse button or pad button; Escape (or MENU on a pad) cancels.
 */

type Tab = 'controls' | 'bindings' | 'display' | 'sound';
const TABS: [Tab, string][] = [
  ['controls', 'Controls'],
  ['bindings', 'Bindings'],
  ['display', 'Display'],
  ['sound', 'Sound & comfort'],
];

type NumKey = keyof typeof RANGES;
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type HoldKey = 'aimMode' | 'crouchMode' | 'sprintMode';

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const FORMAT: Record<NumKey, (v: number) => string> = {
  mouseSens: (v) => v.toFixed(2),
  aimSens: (v) => v.toFixed(2),
  padSens: (v) => v.toFixed(2),
  deadzone: pct,
  fov: (v) => `${Math.round(v)}°`,
  hudScale: pct,
  volume: pct,
  shake: pct,
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** Which binding slot is waiting for a press. */
interface Listening {
  action: Action;
  /** 0..KEY_SLOTS-1 for keys and mouse, -1 for the pad. */
  slot: number;
  button: HTMLButtonElement;
}

export class SettingsScreen {
  onClose: () => void = () => {};
  private tab: Tab = 'controls';
  private listening: Listening | null = null;
  private readonly body = h('div', 'set-body');
  private readonly notice = h('p', 'set-notice');
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly status = h('p', 'set-status');
  private resetArmed = false;
  private statusTimer = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: SettingsStore,
    private readonly sfx: Sfx,
  ) {
    const head = h('div', 'set-head');
    head.append(h('h2', '', 'Settings'), this.notice);
    const tabs = h('div', 'set-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of TABS) {
      const b = h('button', 'set-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.show(id, true));
      this.tabButtons.set(id, b);
      tabs.append(b);
    }
    const foot = h('div', 'set-foot');
    const reset = h('button', 'quiet small', 'Reset everything');
    reset.type = 'button';
    reset.addEventListener('click', () => this.resetAll(reset));
    reset.addEventListener('blur', () => {
      this.resetArmed = false;
      reset.textContent = 'Reset everything';
    });
    const back = h('button', 'small', 'Back');
    back.type = 'button';
    back.id = 'settings-back';
    back.addEventListener('click', () => this.close());
    foot.append(reset, back);
    root.append(head, tabs, this.body, this.status, foot);

    // Keys and mouse buttons for a slot waiting to be bound, and Escape to leave.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.isOpen) return;
        if (this.listening) {
          e.preventDefault();
          e.stopPropagation();
          if (e.code === 'Escape') this.stopListening(true);
          else if (this.listening.slot >= 0 && (e.code === 'Backspace' || e.code === 'Delete')) this.clearSlot();
          else if (this.listening.slot >= 0) this.capture(e.code);
          return;
        }
        if (e.code === 'Escape') {
          e.preventDefault();
          this.close();
        }
      },
      true,
    );
    window.addEventListener(
      'mousedown',
      (e) => {
        const l = this.listening;
        if (!l || l.slot < 0) return;
        // Clicking the slot again (or anywhere) with the left button binds it; that is what was pressed.
        e.preventDefault();
        e.stopPropagation();
        this.capture(`Mouse${e.button}`);
      },
      true,
    );
    window.addEventListener('contextmenu', (e) => {
      if (this.listening) e.preventDefault();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** A pad slot is waiting: pad buttons bind instead of moving around the screen. */
  get listeningPad(): boolean {
    return this.listening?.slot === -1;
  }

  /** Any slot is waiting for a press. */
  get isListening(): boolean {
    return this.listening !== null;
  }

  open(): void {
    this.root.hidden = false;
    this.show(this.tab, false);
    this.notice.textContent = NOTICE_TEXT[this.store.notice];
    this.notice.hidden = this.store.notice === '';
    this.tabButtons.get(this.tab)?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.stopListening(false);
    this.root.hidden = true;
    this.sfx.uiClose();
    this.onClose();
  }

  /** LB / RB on a pad. */
  nextTab(dir: number): void {
    const i = TABS.findIndex(([id]) => id === this.tab);
    const next = TABS[(i + dir + TABS.length) % TABS.length][0];
    this.show(next, true);
    this.tabButtons.get(next)?.focus();
  }

  /** A pad button while a pad slot is waiting. MENU cancels. */
  capturePad(button: number): void {
    if (!this.listening || this.listening.slot !== -1) return;
    if (button === PAD_START) this.stopListening(true);
    else this.capture(`Pad${button}`);
  }

  // ---------------------------------------------------------------- tabs

  private show(tab: Tab, sound: boolean): void {
    this.stopListening(false);
    this.tab = tab;
    for (const [id, b] of this.tabButtons) {
      b.classList.toggle('on', id === tab);
      b.setAttribute('aria-selected', String(id === tab));
    }
    if (sound) this.sfx.uiSelect();
    const rows: HTMLElement[] = [];
    if (tab === 'controls') {
      rows.push(
        this.section('Mouse'),
        this.slider('mouseSens', 'Look sensitivity'),
        this.slider('aimSens', 'Sensitivity while aiming', 'On top of the slowdown that comes with the zoom.'),
        this.toggle('invertY', 'Invert up and down'),
        this.section('Hold or toggle'),
        this.choice('aimMode', 'Aim'),
        this.choice('crouchMode', 'Crouch'),
        this.choice('sprintMode', 'Sprint', 'On a pad, a click of the left stick sprints until you stop running forward.'),
        this.section('Pad'),
        this.slider('padSens', 'Look speed'),
        this.slider('deadzone', 'Stick deadzone', 'Raise it if the view drifts with the stick let go.'),
        this.toggle('aimSlowdown', 'Aim slowdown', 'The view turns slower while the crosshair rests on an enemy pilot.'),
        this.toggle('vibration', 'Vibration'),
      );
    } else if (tab === 'bindings') {
      rows.push(...this.bindingRows());
    } else if (tab === 'display') {
      rows.push(
        this.slider('fov', 'Field of view', 'Measured across a 16:9 screen.'),
        this.slider('hudScale', 'HUD size'),
        this.toggle('showFps', 'Frame counter'),
        this.toggle('fullscreen', 'Fullscreen while playing', 'Goes fullscreen when you click to play. Esc twice leaves it.'),
      );
    } else {
      rows.push(
        this.slider('volume', 'Volume'),
        this.toggle('muted', 'Sound off'),
        this.section('Comfort'),
        this.slider('shake', 'Screen shake', 'Blasts, landings and mech footfalls.'),
        this.toggle('reduceMotion', 'Reduce motion', 'No widening of the view at speed or on a kill, no lean into strafes.'),
      );
    }
    this.body.replaceChildren(...rows);
  }

  private section(title: string): HTMLElement {
    return h('h3', 'set-section', title);
  }

  private row(label: string, help: string, control: HTMLElement, id: string): HTMLElement {
    const row = h('div', 'set-row');
    const text = h('div', 'set-label');
    const l = h('label', '', label);
    l.htmlFor = id;
    text.append(l);
    if (help) text.append(h('small', '', help));
    row.append(text, control);
    return row;
  }

  private slider(key: NumKey, label: string, help = ''): HTMLElement {
    const r = RANGES[key];
    const wrap = h('div', 'set-slider');
    const input = h('input');
    input.type = 'range';
    input.id = `set-${key}`;
    input.min = String(r.min);
    input.max = String(r.max);
    input.step = String(r.step);
    input.value = String(this.store.value[key]);
    const out = h('output', '', FORMAT[key](this.store.value[key]));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = FORMAT[key](v);
      this.store.set({ [key]: v } as Partial<Settings>);
      this.sfx.uiMove();
    });
    wrap.append(input, out);
    return this.row(label, help, wrap, input.id);
  }

  private toggle(key: BoolKey, label: string, help = ''): HTMLElement {
    const b = h('button', 'set-switch');
    b.type = 'button';
    b.id = `set-${key}`;
    b.setAttribute('role', 'switch');
    const paint = (): void => {
      const on = this.store.value[key];
      b.setAttribute('aria-checked', String(on));
      b.textContent = on ? 'On' : 'Off';
    };
    paint();
    b.addEventListener('click', () => {
      this.store.set({ [key]: !this.store.value[key] } as Partial<Settings>);
      paint();
      this.sfx.uiSelect();
    });
    return this.row(label, help, b, b.id);
  }

  private choice(key: HoldKey, label: string, help = ''): HTMLElement {
    const wrap = h('div', 'set-choice');
    const buttons: HTMLButtonElement[] = [];
    for (const mode of ['hold', 'toggle'] as Hold[]) {
      const b = h('button', '', mode === 'hold' ? 'Hold' : 'Toggle');
      b.type = 'button';
      if (mode === 'hold') b.id = `set-${key}`;
      b.addEventListener('click', () => {
        this.store.set({ [key]: mode } as Partial<Settings>);
        for (const x of buttons) x.classList.toggle('on', x === b);
        this.sfx.uiSelect();
      });
      b.classList.toggle('on', this.store.value[key] === mode);
      buttons.push(b);
      wrap.append(b);
    }
    return this.row(label, help, wrap, `set-${key}`);
  }

  // ---------------------------------------------------------------- bindings

  private bindingRows(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const head = h('div', 'bind-row bind-head');
    head.append(h('span', '', 'Action'), h('span', '', 'Key'), h('span', '', 'Second key'), h('span', '', 'Pad'));
    out.push(head);
    let group = '';
    for (const a of ACTION_NAMES) {
      const info = ACTIONS[a];
      if (info.fixed) continue;
      if (info.group !== group) {
        group = info.group;
        out.push(this.section(group));
      }
      const row = h('div', 'bind-row');
      row.append(h('span', 'bind-name', info.label));
      for (let slot = 0; slot < KEY_SLOTS; slot++) row.append(this.slotButton(a, slot));
      row.append(this.slotButton(a, -1));
      out.push(row);
    }
    const note = h('p', 'set-help', 'The left stick moves and the right stick looks. Backspace clears a key slot.');
    const reset = h('button', 'quiet small', 'Reset bindings');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.store.set({ keys: defaultKeys(), pad: defaultPad() });
      this.say('Bindings are back to the defaults.');
      this.sfx.uiSelect();
      this.show('bindings', false);
      reset.focus();
    });
    const foot = h('div', 'bind-foot');
    foot.append(note, reset);
    out.push(foot);
    return out;
  }

  private table(slot: number): BindTable {
    return slot < 0 ? this.store.value.pad : this.store.value.keys;
  }

  private slotButton(action: Action, slot: number): HTMLButtonElement {
    const b = h('button', 'bind-slot');
    b.type = 'button';
    b.dataset.action = action;
    b.dataset.slot = String(slot);
    // Movement is on the left stick.
    const padless = slot < 0 && ['forward', 'back', 'left', 'right'].includes(action);
    if (padless) {
      b.disabled = true;
      b.textContent = 'STICK';
      return b;
    }
    this.paintSlot(b, action, slot);
    b.addEventListener('click', (e) => {
      if (this.listening) return;
      e.stopPropagation();
      this.listen(action, slot, b);
    });
    return b;
  }

  private paintSlot(b: HTMLButtonElement, action: Action, slot: number): void {
    const code = this.table(slot)[action][Math.max(0, slot)];
    b.textContent = code ? codeLabel(code) : '—';
    b.classList.toggle('empty', !code);
    b.classList.remove('listening');
  }

  private listen(action: Action, slot: number, button: HTMLButtonElement): void {
    // The click that opened the slot must not bind it: wait for the next press.
    setTimeout(() => {
      this.listening = { action, slot, button };
      button.classList.add('listening');
      button.textContent = slot < 0 ? 'PRESS A PAD BUTTON' : 'PRESS A KEY';
      this.say(slot < 0 ? 'Press a pad button. MENU cancels.' : 'Press a key or mouse button. Esc cancels, Backspace clears.');
      this.sfx.uiListen();
    }, 0);
  }

  private capture(code: string): void {
    const l = this.listening;
    if (!l) return;
    const { swapped } = bind(this.table(l.slot), l.action, Math.max(0, l.slot), code);
    this.listening = null;
    this.store.changed();
    this.sfx.uiBound(swapped !== null);
    this.say(swapped ? `${codeLabel(code)} moved here from “${ACTIONS[swapped].label}”, which takes the old one.` : '');
    this.redrawSlots();
    l.button.focus();
  }

  private clearSlot(): void {
    const l = this.listening;
    if (!l) return;
    unbind(this.table(l.slot), l.action, l.slot);
    this.listening = null;
    this.store.changed();
    this.sfx.uiBack();
    this.say('');
    this.redrawSlots();
    l.button.focus();
  }

  private stopListening(sound: boolean): void {
    const l = this.listening;
    if (!l) return;
    this.listening = null;
    this.paintSlot(l.button, l.action, l.slot);
    this.say('');
    if (sound) this.sfx.uiBack();
  }

  private redrawSlots(): void {
    for (const b of this.body.querySelectorAll<HTMLButtonElement>('.bind-slot:not(:disabled)')) {
      this.paintSlot(b, b.dataset.action as Action, Number(b.dataset.slot));
    }
  }

  // ---------------------------------------------------------------- the rest

  private resetAll(button: HTMLButtonElement): void {
    if (!this.resetArmed) {
      this.resetArmed = true;
      button.textContent = 'Press again to reset';
      this.sfx.uiListen();
      return;
    }
    this.resetArmed = false;
    button.textContent = 'Reset everything';
    const d = defaultSettings();
    this.store.set({ ...d });
    this.say('Every setting is back to its default.');
    this.sfx.uiSelect();
    this.show(this.tab, false);
  }

  private say(text: string): void {
    this.status.textContent = text;
    this.status.classList.toggle('on', text !== '');
    clearTimeout(this.statusTimer);
    if (text && !this.listening) this.statusTimer = window.setTimeout(() => this.say(''), 5000);
  }
}
