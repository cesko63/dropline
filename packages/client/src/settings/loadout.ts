import { MECH_IDS } from '@dropline/shared';
import type { KeyValue } from './settings';

/**
 * What the player picked in the hangar: the side they fight for (and so the
 * suit they wear) and the mech frame they call. Saved as plain versioned JSON
 * next to the settings; anything unreadable falls back to the defaults.
 */

export const LOADOUT_KEY = 'dropline.loadout';
export const LOADOUT_VERSION = 1;

export interface Loadout {
  /** 0 the Corps, 1 Z.E.R.O. Offline it is the side you play; online the server takes it while the teams are even. */
  side: number;
  /** An id from `MECHS`. */
  mech: string;
}

export const defaultLoadout = (): Loadout => ({ side: 0, mech: MECH_IDS[0] });

/** A stored loadout made safe: unknown sides and frames that no longer exist go back to the defaults. */
export function parseLoadout(raw: string | null): Loadout {
  const out = defaultLoadout();
  if (!raw) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!data || typeof data !== 'object') return out;
  const d = data as Record<string, unknown>;
  if (d.side === 0 || d.side === 1) out.side = d.side;
  if (typeof d.mech === 'string' && MECH_IDS.includes(d.mech)) out.mech = d.mech;
  return out;
}

export class LoadoutStore {
  private current: Loadout;
  private readonly listeners: ((l: Loadout) => void)[] = [];

  constructor(private readonly storage: KeyValue | null) {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(LOADOUT_KEY) ?? null;
    } catch {
      // Storage blocked: the defaults for this visit.
    }
    this.current = parseLoadout(raw);
  }

  get value(): Readonly<Loadout> {
    return this.current;
  }

  set(change: Partial<Loadout>): void {
    const next = parseLoadout(JSON.stringify({ ...this.current, ...change }));
    if (next.side === this.current.side && next.mech === this.current.mech) return;
    this.current = next;
    try {
      this.storage?.setItem(LOADOUT_KEY, JSON.stringify({ v: LOADOUT_VERSION, ...next }));
    } catch {
      // Full or blocked: the pick holds for this visit.
    }
    for (const fn of this.listeners) fn(next);
  }

  listen(fn: (l: Loadout) => void): void {
    this.listeners.push(fn);
  }
}
