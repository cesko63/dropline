import { describe, expect, it } from 'vitest';
import { FRAME_LIST, createPlayerState, type Actor, type MatchState, type Mech } from '@dropline/shared';
import { Coach, GAP, LESSONS, REST, SHOW_FOR, deathTipKey, type CoachView } from '../src/ui/coach';

/** The fields the lessons read, on a pilot standing still with a full arm. */
function view(): CoachView {
  const me = {
    p: createPlayerState({ x: 0, y: 0, z: 0 }),
    inMech: false,
    meter: 0,
    weapon: 0,
    loadout: ['carbine', 'scattergun', 'longshot', 'pike'],
    ammo: [28, 8, 6, 2],
    reload: 0,
  } as unknown as Actor;
  const mech = { state: 'none', frame: 0, charges: FRAME_LIST[0].mobility.charges, abilityCooldown: 0, shieldUp: false, cloak: 0 } as unknown as Mech;
  return { m: {} as MatchState, me, mech, moved: 0, prompting: false };
}

/** Step the coach `seconds` at 60 frames a second. */
function run(c: Coach, v: CoachView, seconds: number, active = true): void {
  for (let t = 0; t < seconds; t += 1 / 60) c.update(1 / 60, v, active);
}

describe('coach', () => {
  it('starts with moving, after a short quiet moment', () => {
    const c = new Coach([]);
    const v = view();
    run(c, v, GAP - 0.2);
    expect(c.current).toBeNull();
    run(c, v, 0.5);
    expect(c.current?.id).toBe('move');
  });

  it('takes a line away the moment it is done, remembers it, and moves on to the next', () => {
    const learned: string[] = [];
    const c = new Coach([]);
    c.onLearn = (id) => learned.push(id);
    const v = view();
    run(c, v, 2);
    v.moved = 10;
    run(c, v, 1 / 60);
    expect(c.current).toBeNull();
    expect(learned).toEqual(['move']);
    run(c, v, GAP + 0.1);
    expect(c.current?.id).toBe('jump');
  });

  it('never teaches what the player already did, or what an earlier visit learned', () => {
    const c = new Coach(['move']);
    const v = view();
    v.me.p.airJumpsUsed = 1;
    run(c, v, 3);
    expect(c.current?.id).toBe('thrust');
    expect(c.has('jump')).toBe(true);
  });

  it('rests a basic the player ignores, then brings it back', () => {
    const c = new Coach([]);
    const v = view();
    // When the moving line comes up, frame by frame.
    const ups: number[] = [];
    let was = '';
    for (let t = 0; t < 120; t += 1 / 60) {
      c.update(1 / 60, v, true);
      const id = c.current?.id ?? '';
      if (id === 'move' && was !== 'move') ups.push(t);
      was = id;
    }
    expect(ups.length).toBeGreaterThanOrEqual(2);
    // Up for its time, then resting at least as long, while the other basics take turns.
    expect(ups[1] - ups[0]).toBeGreaterThanOrEqual(SHOW_FOR + REST - 0.1);
  });

  it('puts a moment ahead of the basics: a full meter asks for the mech at once', () => {
    const c = new Coach([]);
    const v = view();
    run(c, v, 2);
    expect(c.current?.id).toBe('move');
    v.me.meter = 1;
    run(c, v, 1 / 60);
    expect(c.current?.id).toBe('call');
    // A moment stays up as long as it lasts, not on a timer.
    run(c, v, SHOW_FOR + 5);
    expect(c.current?.id).toBe('call');
    v.mech.state = 'dropping';
    run(c, v, 1 / 60);
    expect(c.has('call')).toBe(true);
  });

  it('teaches each frame its own move, then its ability, once in the cockpit', () => {
    const c = new Coach([]);
    const v = view();
    v.me.inMech = true;
    v.mech.state = 'piloted';
    v.mech.frame = 1;
    run(c, v, 2);
    expect(c.current?.id).toBe(`mech-move-${FRAME_LIST[1].id}`);
    v.mech.charges = 0;
    run(c, v, GAP + 0.1);
    expect(c.current?.id).toBe(`mech-ability-${FRAME_LIST[1].id}`);
  });

  it('says nothing while dead or paused, and nothing at all with tips off', () => {
    const c = new Coach([]);
    const v = view();
    run(c, v, 5, false);
    expect(c.current).toBeNull();
    c.enabled = false;
    run(c, v, 5);
    expect(c.current).toBeNull();
  });

  it('gives every lesson an id of its own', () => {
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(LESSONS.length);
  });

  it('picks the death tip that fits the kill', () => {
    expect(deathTipKey('', false)).toBe('fall');
    expect(deathTipKey('crush', false)).toBe('crush');
    expect(deathTipKey('autocannon', false)).toBe('mech');
    expect(deathTipKey('salvo', false)).toBe('mech');
    expect(deathTipKey('longshot', true)).toBe('longshot');
    expect(deathTipKey('carbine', true)).toBe('head');
    expect(deathTipKey('carbine', false)).toBe('');
  });
});
