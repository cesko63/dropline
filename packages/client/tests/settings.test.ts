import { describe, expect, it } from 'vitest';
import { ACTION_NAMES, bind, defaultKeys, defaultPad, mergeTable, unbind } from '../src/input/bindings';
import { deadzoned } from '../src/input/gamepad';
import {
  BACKUP_KEY,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  SettingsStore,
  defaultSettings,
  parseSettings,
  verticalFov,
  type KeyValue,
} from '../src/settings/settings';

/** Browser storage stand-in; `full` makes every write throw, like a full or blocked store. */
class Memory implements KeyValue {
  data = new Map<string, string>();
  full = false;
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.full) throw new Error('QuotaExceededError');
    this.data.set(k, v);
  }
}

describe('settings', () => {
  it('starts from the defaults and keeps what was changed across a reload', () => {
    const mem = new Memory();
    const a = new SettingsStore(mem);
    expect(a.value).toEqual(defaultSettings());
    a.set({ mouseSens: 1.7, fov: 100, aimMode: 'toggle' });
    const b = new SettingsStore(mem);
    expect(b.value.mouseSens).toBe(1.7);
    expect(b.value.fov).toBe(100);
    expect(b.value.aimMode).toBe('toggle');
    expect(b.notice).toBe('');
  });

  it('migrates a version 0 object (no version field) and fills in what it lacks', () => {
    const s = parseSettings(JSON.stringify({ muted: true, mouseSens: 2 }));
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.muted).toBe(true);
    expect(s.mouseSens).toBe(2);
    expect(s.keys).toEqual(defaultKeys());
    expect(s.pad).toEqual(defaultPad());
  });

  it('keeps every stored value in range and of the right type: players edit these', () => {
    const s = parseSettings(
      JSON.stringify({ version: 1, mouseSens: 99, fov: -5, volume: 'loud', invertY: 'yes', aimMode: 'sometimes', deadzone: null, keys: { jump: ['KeyJ', 42, 'Nonsense'], fire: 'Mouse0' } }),
    );
    const d = defaultSettings();
    expect(s.mouseSens).toBe(4);
    expect(s.fov).toBe(80);
    expect(s.volume).toBe(d.volume);
    expect(s.invertY).toBe(false);
    expect(s.aimMode).toBe('hold');
    expect(s.deadzone).toBe(d.deadzone);
    expect(s.keys.jump).toEqual(['KeyJ']);
    expect(s.keys.fire).toEqual(d.keys.fire);
  });

  it('refuses settings from a newer version instead of guessing at them', () => {
    expect(() => parseSettings(JSON.stringify({ version: SETTINGS_VERSION + 1 }))).toThrow();
  });

  it('falls back to the last good copy when the stored one is broken, and says so', () => {
    const mem = new Memory();
    const a = new SettingsStore(mem);
    a.set({ fov: 95 });
    a.set({ fov: 105 });
    // The backup is the copy before the last save.
    expect(JSON.parse(mem.getItem(BACKUP_KEY)!).fov).toBe(95);
    mem.setItem(SETTINGS_KEY, '{"fov": 1');
    const b = new SettingsStore(mem);
    expect(b.notice).toBe('restored');
    expect(b.value.fov).toBe(95);
    // The broken copy is kept for a bug report, and the next save does not make it the backup.
    expect(mem.getItem(`${SETTINGS_KEY}.broken`)).toBe('{"fov": 1');
    b.set({ fov: 99 });
    expect(JSON.parse(mem.getItem(BACKUP_KEY)!).fov).toBe(95);
  });

  it('resets and says so when both copies are broken', () => {
    const mem = new Memory();
    mem.setItem(SETTINGS_KEY, 'not json');
    mem.setItem(BACKUP_KEY, '[]');
    const s = new SettingsStore(mem);
    expect(s.notice).toBe('reset');
    expect(s.value).toEqual(defaultSettings());
  });

  it('keeps playing when storage refuses to save, and tells the player', () => {
    const mem = new Memory();
    mem.full = true;
    const s = new SettingsStore(mem);
    s.set({ volume: 0.3 });
    expect(s.value.volume).toBe(0.3);
    expect(s.notice).toBe('unsaved');
    expect(new SettingsStore(null).notice).toBe('unsaved');
  });

  it('measures the field of view across 16:9, as most shooters print it', () => {
    // The camera's old fixed 80° vertical is about 112° across.
    expect(verticalFov(112.4)).toBeCloseTo(80, 0);
    expect(verticalFov(90)).toBeCloseTo(58.7, 1);
  });
});

describe('bindings', () => {
  it('puts a new key in a slot', () => {
    const t = defaultKeys();
    expect(bind(t, 'jump', 1, 'KeyJ').swapped).toBeNull();
    expect(t.jump).toEqual(['Space', 'KeyJ']);
  });

  it('swaps when the key belongs to another action: nothing is left without the old key', () => {
    const t = defaultKeys();
    // R is reload; give it to jump's first slot.
    const r = bind(t, 'jump', 0, 'KeyR');
    expect(r.swapped).toBe('reload');
    expect(t.jump).toEqual(['KeyR']);
    expect(t.reload).toEqual(['Space']);
    // No code is bound twice anywhere.
    const all = ACTION_NAMES.flatMap((a) => t[a]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('takes a key away from the other action when the slot was empty', () => {
    const t = defaultKeys();
    const r = bind(t, 'jump', 1, 'KeyR');
    expect(r.swapped).toBe('reload');
    expect(t.jump).toEqual(['Space', 'KeyR']);
    expect(t.reload).toEqual([]);
  });

  it('moves a key between the two slots of one action', () => {
    const t = defaultKeys();
    bind(t, 'forward', 0, 'ArrowUp');
    expect(t.forward).toEqual(['ArrowUp', 'KeyW']);
  });

  it('never takes a fixed menu key (A to play again stays on A)', () => {
    const t = defaultPad();
    bind(t, 'reload', 0, 'Pad0');
    expect(t.confirm).toEqual(['Pad0']);
    expect(t.reload).toEqual(['Pad0']);
    expect(t.jump).toEqual(['Pad2']);
  });

  it('clears a slot', () => {
    const t = defaultKeys();
    unbind(t, 'sprint', 1);
    expect(t.sprint).toEqual(['ShiftLeft']);
  });

  it('gives actions added after a table was saved their defaults', () => {
    const saved = { jump: ['KeyJ'] };
    const t = mergeTable(saved, defaultKeys(), 2);
    expect(t.jump).toEqual(['KeyJ']);
    expect(t.call).toEqual(['KeyF']);
  });

  it('ships defaults with no button doing two things', () => {
    for (const t of [defaultKeys(), defaultPad()]) {
      const all = ACTION_NAMES.filter((a) => a !== 'confirm').flatMap((a) => t[a]);
      expect(new Set(all).size).toBe(all.length);
    }
  });
});

describe('pad stick', () => {
  it('ignores the deadzone and starts the rest of the throw from zero', () => {
    expect(deadzoned(0.1, 0.05, 0.15).mag).toBe(0);
    const just = deadzoned(0.16, 0, 0.15);
    expect(just.mag).toBeGreaterThan(0);
    expect(just.mag).toBeLessThan(0.02);
    expect(deadzoned(1, 0, 0.15).mag).toBeCloseTo(1);
  });

  it('uses a round deadzone, so a diagonal push is no faster than a straight one', () => {
    const diag = deadzoned(0.9, 0.9, 0.15);
    expect(diag.mag).toBe(1);
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(1);
    // Half a push the same either way.
    const a = deadzoned(0.5, 0, 0.15).mag;
    const b = deadzoned(0.5 / Math.SQRT2, 0.5 / Math.SQRT2, 0.15).mag;
    expect(a).toBeCloseTo(b);
  });
});
