/**
 * The binding table: every named action, what it is called on screen, and the
 * keys, mouse buttons and pad buttons that trigger it. Gameplay asks only about
 * actions; rebinding, the pad and every key prompt read this one table.
 *
 * Codes: `KeyboardEvent.code` for keys (physical positions, so WASD works on any
 * layout), `Mouse0`..`Mouse4` for mouse buttons, `Pad0`..`Pad16` for buttons of a
 * pad in the browser's standard layout. Ctrl is avoided: Ctrl+W closes the tab.
 */

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'crouch'
  | 'sprint'
  | 'fire'
  | 'ads'
  | 'reload'
  | 'weapon1'
  | 'weapon2'
  | 'weapon3'
  | 'weapon4'
  | 'nextWeapon'
  | 'use'
  | 'call'
  | 'nextFrame'
  | 'toggleView'
  | 'respawn'
  | 'mute'
  | 'netDebug'
  | 'confirm';

export interface ActionInfo {
  /** Shown in the settings list. */
  label: string;
  /** Section of the settings list. */
  group: 'Move' | 'Fight' | 'Mech and match' | 'Other';
  /** Keyboard and mouse: up to two. */
  keys: string[];
  /** Pad buttons: up to one. Movement is on the left stick and has none. */
  pad: string[];
  /** Not offered for rebinding (Enter to play again is a menu key). */
  fixed?: boolean;
}

export const ACTIONS: Record<Action, ActionInfo> = {
  forward: { label: 'Forward', group: 'Move', keys: ['KeyW', 'ArrowUp'], pad: [] },
  back: { label: 'Back', group: 'Move', keys: ['KeyS', 'ArrowDown'], pad: [] },
  left: { label: 'Left', group: 'Move', keys: ['KeyA', 'ArrowLeft'], pad: [] },
  right: { label: 'Right', group: 'Move', keys: ['KeyD', 'ArrowRight'], pad: [] },
  jump: { label: 'Jump · double jump · thrust · mech move', group: 'Move', keys: ['Space'], pad: ['Pad0'] },
  crouch: { label: 'Crouch · slide', group: 'Move', keys: ['KeyC'], pad: ['Pad1'] },
  sprint: { label: 'Sprint', group: 'Move', keys: ['ShiftLeft', 'ShiftRight'], pad: ['Pad10'] },
  fire: { label: 'Fire', group: 'Fight', keys: ['Mouse0'], pad: ['Pad7'] },
  ads: { label: 'Aim · mech ability', group: 'Fight', keys: ['Mouse2'], pad: ['Pad6'] },
  reload: { label: 'Vent · reload', group: 'Fight', keys: ['KeyR'], pad: ['Pad2'] },
  weapon1: { label: 'Carbine barrel', group: 'Fight', keys: ['Digit1'], pad: [] },
  weapon2: { label: 'Scattergun barrel', group: 'Fight', keys: ['Digit2'], pad: [] },
  weapon3: { label: 'Marksman barrel', group: 'Fight', keys: ['Digit3'], pad: [] },
  weapon4: { label: 'Shoulder launcher', group: 'Fight', keys: ['Digit4'], pad: ['Pad5'] },
  nextWeapon: { label: 'Next weapon', group: 'Fight', keys: ['KeyQ'], pad: ['Pad3'] },
  use: { label: 'Embark · climb out', group: 'Mech and match', keys: ['KeyE'], pad: ['Pad4'] },
  call: { label: 'Call mech', group: 'Mech and match', keys: ['KeyF'], pad: ['Pad12'] },
  nextFrame: { label: 'Change mech frame', group: 'Mech and match', keys: ['KeyT'], pad: ['Pad15'] },
  respawn: { label: 'Redeploy', group: 'Mech and match', keys: ['KeyK'], pad: ['Pad13'] },
  toggleView: { label: 'First / third person', group: 'Other', keys: ['KeyV'], pad: ['Pad14'] },
  mute: { label: 'Sound on / off', group: 'Other', keys: ['KeyM'], pad: [] },
  netDebug: { label: 'Connection details', group: 'Other', keys: ['KeyN'], pad: ['Pad8'] },
  confirm: { label: 'Play again', group: 'Other', keys: ['Enter'], pad: ['Pad0'], fixed: true },
};

export const ACTION_NAMES = Object.keys(ACTIONS) as Action[];
export const KEY_SLOTS = 2;

/** Codes per action for one kind of device. */
export type BindTable = Record<Action, string[]>;

export function defaultKeys(): BindTable {
  return Object.fromEntries(ACTION_NAMES.map((a) => [a, [...ACTIONS[a].keys]])) as BindTable;
}

export function defaultPad(): BindTable {
  return Object.fromEntries(ACTION_NAMES.map((a) => [a, [...ACTIONS[a].pad]])) as BindTable;
}

/**
 * A saved table made whole again: actions it does not know get their defaults
 * (they were added after it was saved), codes it should not hold are dropped.
 */
export function mergeTable(saved: unknown, defaults: BindTable, slots: number): BindTable {
  const out = { ...defaults };
  if (!saved || typeof saved !== 'object') return out;
  for (const a of ACTION_NAMES) {
    if (ACTIONS[a].fixed) continue;
    const v = (saved as Record<string, unknown>)[a];
    if (!Array.isArray(v)) continue;
    out[a] = v.filter((c): c is string => typeof c === 'string' && /^(Key|Digit|Arrow|Shift|Alt|Space|Tab|Backquote|Minus|Equal|Bracket|Backslash|Semicolon|Quote|Comma|Period|Slash|Caps|Numpad|F\d|Mouse\d|Pad\d|Insert|Home|End|Page|Delete|Backspace)/.test(c)).slice(0, slots);
  }
  return out;
}

export interface BindResult {
  /** The action that held `code` before and was given this slot's old code instead, if any. */
  swapped: Action | null;
}

/**
 * Put `code` into `action`'s slot `slot` of `table`. If another action already
 * uses it, the two trade: that action gets whatever this slot held before (or
 * loses the code if the slot was empty). Fixed actions are never touched.
 */
export function bind(table: BindTable, action: Action, slot: number, code: string): BindResult {
  const old = table[action][slot] ?? '';
  let swapped: Action | null = null;
  for (const other of ACTION_NAMES) {
    if (ACTIONS[other].fixed) continue;
    const i = table[other].indexOf(code);
    if (i < 0 || (other === action && i === slot)) continue;
    if (other !== action) swapped = other;
    if (old) table[other][i] = old;
    else table[other].splice(i, 1);
  }
  const list = table[action];
  if (slot < list.length) list[slot] = code;
  else list.push(code);
  return { swapped };
}

/** Empty one slot. */
export function unbind(table: BindTable, action: Action, slot: number): void {
  table[action].splice(slot, 1);
}

// ---------------------------------------------------------------- labels

const NAMED: Record<string, string> = {
  Space: 'SPACE',
  ShiftLeft: 'SHIFT',
  ShiftRight: 'R-SHIFT',
  AltLeft: 'ALT',
  AltRight: 'R-ALT',
  Tab: 'TAB',
  CapsLock: 'CAPS',
  Enter: 'ENTER',
  Backspace: 'BACKSPACE',
  Delete: 'DEL',
  Insert: 'INS',
  Home: 'HOME',
  End: 'END',
  PageUp: 'PG UP',
  PageDown: 'PG DN',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Mouse0: 'LEFT MOUSE',
  Mouse1: 'MIDDLE MOUSE',
  Mouse2: 'RIGHT MOUSE',
  Mouse3: 'MOUSE 4',
  Mouse4: 'MOUSE 5',
};

/** Pad buttons in the standard layout, named as on most pads. */
export const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'VIEW', 'MENU', 'L3', 'R3', 'D-PAD ↑', 'D-PAD ↓', 'D-PAD ←', 'D-PAD →', 'HOME'];

/** What the player's own keyboard prints on a key, where the browser tells us (filled in at start). */
const layout = new Map<string, string>();

/** Ask the browser for the keyboard's own key caps (Chrome and Edge only); harmless elsewhere. */
export async function readLayout(): Promise<void> {
  const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
  try {
    const map = await kb?.getLayoutMap?.();
    map?.forEach((v, k) => layout.set(k, v.toUpperCase()));
  } catch {
    // Not allowed here (an iframe, for one): the US names below stand in.
  }
}

/** The name of one code as the player should read it. */
export function codeLabel(code: string): string {
  if (code.startsWith('Pad')) return PAD_NAMES[Number(code.slice(3))] ?? code;
  if (layout.has(code)) return layout.get(code)!;
  if (NAMED[code]) return NAMED[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  return code.toUpperCase();
}
