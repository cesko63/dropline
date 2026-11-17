import { describe, expect, it } from 'vitest';
import { MECH_IDS } from '@dropline/shared';
import { LOADOUT_KEY, LOADOUT_VERSION, LoadoutStore, defaultLoadout, parseLoadout } from '../src/settings/loadout';
import { SIDES, mechStats } from '../src/ui/hangar';
import { MECHS } from '@dropline/shared';
import type { KeyValue } from '../src/settings/settings';

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

describe('loadout', () => {
  it('starts on the Corps with the first frame', () => {
    expect(defaultLoadout()).toEqual({ side: 0, mech: MECH_IDS[0] });
    expect(new LoadoutStore(new Memory()).value).toEqual(defaultLoadout());
  });

  it('keeps the pick across a reload, as versioned plain data', () => {
    const mem = new Memory();
    new LoadoutStore(mem).set({ side: 1 });
    expect(JSON.parse(mem.data.get(LOADOUT_KEY)!)).toEqual({ v: LOADOUT_VERSION, side: 1, mech: MECH_IDS[0] });
    expect(new LoadoutStore(mem).value.side).toBe(1);
  });

  it('falls back to the defaults for broken data, unknown sides and frames that are gone', () => {
    expect(parseLoadout('{not json')).toEqual(defaultLoadout());
    expect(parseLoadout('null')).toEqual(defaultLoadout());
    expect(parseLoadout('{"side":3,"mech":"warhammer"}')).toEqual(defaultLoadout());
    expect(parseLoadout('{"side":1,"mech":"warhammer"}')).toEqual({ side: 1, mech: MECH_IDS[0] });
  });

  it('holds the pick for the visit when storage is full or blocked', () => {
    const mem = new Memory();
    mem.full = true;
    const store = new LoadoutStore(mem);
    store.set({ side: 1 });
    expect(store.value.side).toBe(1);
    expect(new LoadoutStore(null).value).toEqual(defaultLoadout());
  });

  it('tells listeners only about real changes', () => {
    const store = new LoadoutStore(new Memory());
    const seen: number[] = [];
    store.listen((l) => seen.push(l.side));
    store.set({ side: 0 });
    store.set({ side: 1 });
    store.set({ side: 1 });
    expect(seen).toEqual([1]);
  });

  it('describes both sides and every frame from its data', () => {
    expect(SIDES.map((s) => s.short)).toEqual(['CORPS', 'Z.E.R.O']);
    for (const id of MECH_IDS) {
      const stats = mechStats(MECHS[id]);
      expect(stats.length).toBeGreaterThan(4);
      for (const [, v] of stats) expect(v).not.toMatch(/undefined|NaN/);
    }
  });
});
