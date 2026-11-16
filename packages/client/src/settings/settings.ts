import { KEY_SLOTS, defaultKeys, defaultPad, mergeTable, type BindTable } from '../input/bindings';

/**
 * The player's settings: plain data, versioned, kept apart from everything else
 * in browser storage. Loading checks every field (players edit these), fills in
 * what a newer version added, and falls back to the last good copy when the
 * stored one is broken. Storage that fails is reported, never fatal.
 */

export const SETTINGS_VERSION = 1;
export const SETTINGS_KEY = 'dropline.settings';
export const BACKUP_KEY = 'dropline.settings.backup';

export type Hold = 'hold' | 'toggle';

export interface Settings {
  version: number;
  // Controls
  /** Mouse look, as a multiple of the base 0.0022 rad per pixel. */
  mouseSens: number;
  /** Look speed while aiming, as a multiple of what the zoom alone would give. */
  aimSens: number;
  invertY: boolean;
  aimMode: Hold;
  crouchMode: Hold;
  sprintMode: Hold;
  /** Right-stick look, as a multiple of the base turn rate. */
  padSens: number;
  /** Stick deadzone, 0..1 of the throw. */
  deadzone: number;
  /** Look slows down while the crosshair is on an enemy pilot (pad only). */
  aimSlowdown: boolean;
  vibration: boolean;
  // Display
  /** Field of view in degrees, measured across a 16:9 screen (see `verticalFov`). */
  fov: number;
  showFps: boolean;
  /** Size of the corner panels of the HUD. */
  hudScale: number;
  /** Go fullscreen when play starts. */
  fullscreen: boolean;
  // Sound
  volume: number;
  muted: boolean;
  // Comfort
  /** Screen shake, 0..1 of full. */
  shake: number;
  /** No widening of the view at speed or on kills, no camera roll. */
  reduceMotion: boolean;
  // Bindings
  keys: BindTable;
  pad: BindTable;
}

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    mouseSens: 1,
    aimSens: 1,
    invertY: false,
    aimMode: 'hold',
    crouchMode: 'hold',
    sprintMode: 'hold',
    padSens: 1,
    deadzone: 0.15,
    aimSlowdown: true,
    vibration: true,
    fov: 112,
    showFps: true,
    hudScale: 1,
    fullscreen: false,
    volume: 0.8,
    muted: false,
    shake: 1,
    reduceMotion: false,
    keys: defaultKeys(),
    pad: defaultPad(),
  };
}

/** The camera's vertical field of view for a setting measured across 16:9. */
export function verticalFov(horizontal: number): number {
  const rad = (horizontal * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(rad / 2) * (9 / 16)) * 180) / Math.PI;
}

/** Allowed range and step of every number, also used by the settings screen. */
export const RANGES = {
  mouseSens: { min: 0.1, max: 4, step: 0.05 },
  aimSens: { min: 0.3, max: 1.5, step: 0.05 },
  padSens: { min: 0.3, max: 3, step: 0.05 },
  deadzone: { min: 0.05, max: 0.4, step: 0.01 },
  fov: { min: 80, max: 120, step: 1 },
  hudScale: { min: 0.75, max: 1.4, step: 0.05 },
  volume: { min: 0, max: 1, step: 0.05 },
  shake: { min: 0, max: 1, step: 0.05 },
} as const;

/**
 * One function per version step, run in order on load: `MIGRATIONS[n]` turns a
 * version n object into version n + 1. Version 0 is the bare `dropline.*` keys
 * the game stored before settings existed (only the mute state, never saved).
 */
export const MIGRATIONS: Record<number, (s: Record<string, unknown>) => Record<string, unknown>> = {
  0: (s) => ({ ...s, version: 1 }),
};

const num = (v: unknown, r: { min: number; max: number }, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const hold = (v: unknown, d: Hold): Hold => (v === 'hold' || v === 'toggle' ? v : d);

/** Migrate and check one stored object. Throws when it is not a settings object at all. */
export function parseSettings(raw: string): Settings {
  let s = JSON.parse(raw) as Record<string, unknown>;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('not an object');
  let v = typeof s.version === 'number' ? s.version : 0;
  if (v > SETTINGS_VERSION) throw new Error(`settings version ${v} is newer than this game`);
  while (v < SETTINGS_VERSION) {
    s = MIGRATIONS[v](s);
    v++;
  }
  const d = defaultSettings();
  return {
    version: SETTINGS_VERSION,
    mouseSens: num(s.mouseSens, RANGES.mouseSens, d.mouseSens),
    aimSens: num(s.aimSens, RANGES.aimSens, d.aimSens),
    invertY: bool(s.invertY, d.invertY),
    aimMode: hold(s.aimMode, d.aimMode),
    crouchMode: hold(s.crouchMode, d.crouchMode),
    sprintMode: hold(s.sprintMode, d.sprintMode),
    padSens: num(s.padSens, RANGES.padSens, d.padSens),
    deadzone: num(s.deadzone, RANGES.deadzone, d.deadzone),
    aimSlowdown: bool(s.aimSlowdown, d.aimSlowdown),
    vibration: bool(s.vibration, d.vibration),
    fov: num(s.fov, RANGES.fov, d.fov),
    showFps: bool(s.showFps, d.showFps),
    hudScale: num(s.hudScale, RANGES.hudScale, d.hudScale),
    fullscreen: bool(s.fullscreen, d.fullscreen),
    volume: num(s.volume, RANGES.volume, d.volume),
    muted: bool(s.muted, d.muted),
    shake: num(s.shake, RANGES.shake, d.shake),
    reduceMotion: bool(s.reduceMotion, d.reduceMotion),
    keys: mergeTable(s.keys, d.keys, KEY_SLOTS),
    pad: mergeTable(s.pad, d.pad, 1),
  };
}

/** What `localStorage` offers; tests pass a stand-in. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Notice = '' | 'unsaved' | 'restored' | 'reset';

export const NOTICE_TEXT: Record<Notice, string> = {
  '': '',
  unsaved: 'This browser does not let the game store anything: settings last until the page is closed.',
  restored: 'The stored settings were damaged; the last good copy is back.',
  reset: 'The stored settings were damaged and have been reset.',
};

/** Holds the live settings, saves them, and tells whoever listens when they change. */
export class SettingsStore {
  value: Settings;
  /** Anything the player should be told about storage, shown on the settings screen. */
  notice: Notice = '';
  private readonly listeners: ((s: Settings) => void)[] = [];
  /** The stored text the settings last loaded from or saved as: the next save's backup. */
  private lastGood: string | null = null;

  constructor(private readonly storage: KeyValue | null) {
    this.value = this.load();
  }

  private load(): Settings {
    let main: string | null = null;
    let backup: string | null = null;
    try {
      if (!this.storage) throw new Error('no storage');
      main = this.storage.getItem(SETTINGS_KEY);
      backup = this.storage.getItem(BACKUP_KEY);
    } catch {
      this.notice = 'unsaved';
      return defaultSettings();
    }
    if (main === null) return defaultSettings();
    try {
      const s = parseSettings(main);
      this.lastGood = main;
      return s;
    } catch {
      // Keep the broken copy for a bug report, then try the last good one.
      try {
        this.storage!.setItem(`${SETTINGS_KEY}.broken`, main);
      } catch {
        // Nothing more to do.
      }
    }
    if (backup !== null) {
      try {
        const s = parseSettings(backup);
        this.lastGood = backup;
        this.notice = 'restored';
        return s;
      } catch {
        // Fall through to the defaults.
      }
    }
    this.notice = 'reset';
    return defaultSettings();
  }

  /** Change some settings, save, and tell the listeners. */
  set(patch: Partial<Settings>): void {
    Object.assign(this.value, patch);
    this.changed();
  }

  /** The bindings or other nested data were edited in place: save and tell the listeners. */
  changed(): void {
    this.save();
    for (const f of this.listeners) f(this.value);
  }

  /** Called now and on every change. */
  listen(f: (s: Settings) => void): void {
    this.listeners.push(f);
    f(this.value);
  }

  private save(): void {
    if (!this.storage) return;
    try {
      // The last good copy becomes the backup before the new one is written.
      if (this.lastGood !== null) this.storage.setItem(BACKUP_KEY, this.lastGood);
      const text = JSON.stringify(this.value);
      this.storage.setItem(SETTINGS_KEY, text);
      this.lastGood = text;
      if (this.notice === 'unsaved') this.notice = '';
    } catch {
      this.notice = 'unsaved';
    }
  }
}

/** `localStorage`, or null where touching it throws (some private modes, blocked site data). */
export function browserStorage(): KeyValue | null {
  try {
    const s = window.localStorage;
    s.getItem(SETTINGS_KEY);
    return s;
  } catch {
    return null;
  }
}
