import { FRAME_LIST, WEAPONS, frameOf, weaponOf, type Actor, type MatchState, type Mech } from '@dropline/shared';

/**
 * The coach: one short line at a time that teaches a move by asking for it,
 * with the key to press. A line leaves the moment the player does the thing and
 * is never shown to them again (the ids are kept with the settings).
 *
 * Two kinds of lesson. Basics (moving, jumping, sliding...) take turns, one
 * after another; one the player ignores rests for a while and comes back.
 * Lessons tied to a moment (the meter is full, the mech is standing by, the
 * arm is nearly empty) jump the queue and stay while the moment lasts.
 *
 * Plain logic with no page in it, so the tests can play it through; the HUD
 * draws whatever `current` is.
 */

/** What a lesson looks at. */
export interface CoachView {
  m: MatchState;
  me: Actor;
  /** The player's own mech. */
  mech: Mech;
  /** Meters the player has walked or run this life. */
  moved: number;
  /** The HUD already shows a prompt where the player stands (climb in). */
  prompting: boolean;
}

export interface Lesson {
  id: string;
  /** Keyboard text, then pad text; `{action}` becomes the bound key. */
  text: [string, string];
  /** Tied to a moment: shown at once, ahead of the basics, for as long as `when` holds. */
  now?: boolean;
  when(v: CoachView): boolean;
  done(v: CoachView): boolean;
}

const onFoot = (v: CoachView): boolean => !v.me.inMech;
const piloting = (v: CoachView): boolean => v.me.inMech && v.mech.state === 'piloted';
const same = (text: string): [string, string] => [text, text];

/** The frame's move and ability, one lesson each per frame. */
function mechLessons(): Lesson[] {
  const out: Lesson[] = [];
  for (const F of FRAME_LIST) {
    const move = F.mobility.kind;
    const moveText: Record<string, string> = {
      dash: '{jump} · DASH',
      stomp: '{jump} · STOMP: CRUSHES PILOTS AROUND YOU',
      leap: '{jump} · LEAP',
    };
    out.push({
      id: `mech-move-${F.id}`,
      text: same(moveText[move]),
      now: true,
      when: (v) => piloting(v) && frameOf(v.mech) === F,
      done: (v) => v.mech.charges < F.mobility.charges - 0.5,
    });
    const ability = F.ability.kind;
    const abilityText: Record<string, string> = {
      salvo: '{ads} · ROCKET SALVO',
      shield: 'HOLD {ads} · RAISE THE SHIELD',
      cloak: '{ads} · CLOAK',
    };
    out.push({
      id: `mech-ability-${F.id}`,
      text: same(abilityText[ability]),
      now: true,
      when: (v) => piloting(v) && frameOf(v.mech) === F,
      done: (v) => v.mech.shieldUp || v.mech.cloak > 0 || (ability === 'salvo' && v.mech.abilityCooldown > 0),
    });
  }
  return out;
}

/** In the order they are taught. */
export const LESSONS: Lesson[] = [
  // Moments.
  {
    id: 'call',
    text: same('{call} · CALL YOUR MECH WHERE YOU LOOK'),
    now: true,
    when: (v) => onFoot(v) && v.me.meter >= 1 && v.mech.state === 'none',
    done: (v) => v.mech.state === 'dropping',
  },
  {
    id: 'embark',
    text: same('YOUR MECH IS STANDING BY · GO TO IT AND PRESS {use}'),
    now: true,
    when: (v) => onFoot(v) && v.mech.state === 'idle' && !v.prompting,
    done: (v) => v.me.inMech,
  },
  ...mechLessons(),
  {
    id: 'reload',
    text: same('{reload} · VENT THE ARM BEFORE IT RUNS DRY'),
    now: true,
    when: (v) => {
      const w = weaponOf(v.me);
      return onFoot(v) && w.mount === 'arm' && v.me.reload <= 0 && v.me.ammo[v.me.weapon] <= w.magSize * 0.25;
    },
    done: (v) => onFoot(v) && v.me.reload > 0,
  },
  // Basics.
  {
    id: 'move',
    text: ['{forward} {left} {back} {right} · MOVE', 'LEFT STICK · MOVE'],
    when: onFoot,
    done: (v) => v.moved >= 8,
  },
  {
    id: 'jump',
    text: same('{jump} · JUMP · AGAIN IN THE AIR TO DOUBLE JUMP'),
    when: onFoot,
    done: (v) => v.me.p.airJumpsUsed > 0,
  },
  {
    id: 'thrust',
    text: same('HOLD {jump} IN THE AIR · JET THRUST'),
    when: onFoot,
    done: (v) => v.me.p.thrusting,
  },
  {
    id: 'slide',
    text: same('{sprint} TO SPRINT · THEN {crouch} TO SLIDE'),
    when: onFoot,
    done: (v) => v.me.p.sliding,
  },
  {
    id: 'wallrun',
    text: same('JUMP AT A WALL · WALLRUN'),
    when: onFoot,
    done: (v) => v.me.p.wallrun.active,
  },
  {
    id: 'barrel',
    text: ['{weapon2} {weapon3} · CHANGE THE ARM’S BARREL', '{nextWeapon} · CHANGE THE ARM’S BARREL'],
    when: onFoot,
    done: (v) => onFoot(v) && v.me.weapon !== 0,
  },
  {
    id: 'pod',
    text: same('{weapon4} · SHOULDER LAUNCHER: HITS MECHS HARD'),
    when: onFoot,
    done: (v) => onFoot(v) && weaponOf(v.me).mount === 'shoulder',
  },
];

/** A basic the player ignores rests after this long on screen, then comes back after `REST`. */
export const SHOW_FOR = 15;
export const REST = 45;
/** Quiet time after spawning and between two basics, so they never pile up. */
export const GAP = 1.5;

/** Why the player died, as a death-card tip. */
export const DEATH_TIPS: Record<string, string> = {
  crush: 'MECH INCOMING ON THE HUD MEANS ONE IS LANDING ON YOU · MOVE',
  stomp: 'KEEP YOUR DISTANCE FROM ENEMY MECHS · THEY STOMP AND RAM PILOTS UP CLOSE',
  ram: 'KEEP YOUR DISTANCE FROM ENEMY MECHS · THEY STOMP AND RAM PILOTS UP CLOSE',
  mech: 'AN ENEMY MECH? {weapon4} SHOULDER LAUNCHER, OR CALL YOUR OWN',
  longshot: 'A RED LASER IS A MARKSMAN LINING UP ON YOU · BREAK LINE OF SIGHT',
  head: 'KEEP MOVING · SLIDES AND WALLRUNS MAKE YOU HARD TO HIT',
  fall: 'DOUBLE JUMP AND HOLD {jump} TO THRUST BACK TO A LEDGE',
};

/** The death tip that fits a kill: its key in `DEATH_TIPS`. */
export function deathTipKey(weapon: string, head: boolean): string {
  if (weapon === '') return 'fall';
  if (weapon in DEATH_TIPS) return weapon;
  const mount = WEAPONS[weapon]?.mount;
  // Mech guns and the salvo carry no pilot mount.
  if (mount !== 'arm' && mount !== 'shoulder') return 'mech';
  return head ? 'head' : '';
}

export class Coach {
  /** The lesson on screen, or null. */
  current: Lesson | null = null;
  /** Off in the settings: nothing shows. */
  enabled = true;
  /** A lesson was done for the first time: store its id. */
  onLearn: (id: string) => void = () => {};
  private readonly learned: Set<string>;
  /** Seconds the current lesson has been up. */
  private shown = 0;
  /** Seconds until a basic may show (after a spawn, between two). */
  private wait = GAP;
  /** When each resting basic may come back. */
  private readonly resting = new Map<string, number>();
  private clock = 0;

  constructor(learned: readonly string[]) {
    this.learned = new Set(learned);
  }

  /** The tips were turned back on from scratch. */
  forget(): void {
    this.learned.clear();
    this.resting.clear();
  }

  has(id: string): boolean {
    return this.learned.has(id);
  }

  /** Mark a tip as seen without it being a lesson (the death card's). */
  learn(id: string): void {
    if (this.learned.has(id)) return;
    this.learned.add(id);
    this.onLearn(id);
  }

  /** The player respawned: a moment to look around before the next line. */
  respawned(): void {
    this.wait = Math.max(this.wait, GAP);
  }

  /** Once a frame while playing. `active` is false while dead, paused or after the match. */
  update(dt: number, v: CoachView, active: boolean): void {
    this.clock += dt;
    // Done counts even while the line is not up: whoever wallruns first needs no lesson for it.
    for (const l of LESSONS) {
      if (active && !this.learned.has(l.id) && l.done(v)) this.learn(l.id);
    }
    if (!this.enabled || !active) {
      this.current = null;
      return;
    }
    const cur = this.current;
    if (cur) {
      this.shown += dt;
      if (this.learned.has(cur.id)) return this.drop(GAP);
      if (!cur.when(v)) return this.drop(0);
      if (!cur.now && this.shown >= SHOW_FOR) {
        this.resting.set(cur.id, this.clock + REST);
        return this.drop(GAP);
      }
      // A moment takes over from a basic at once.
      const moment = cur.now ? undefined : LESSONS.find((l) => l.now && this.open(l, v));
      if (moment) this.pick(moment);
      return;
    }
    this.wait -= dt;
    if (this.wait > 0) return;
    // Moments come first in the list.
    const next = LESSONS.find((l) => this.open(l, v) && (l.now || (this.resting.get(l.id) ?? 0) <= this.clock));
    if (next) this.pick(next);
  }

  private open(l: Lesson, v: CoachView): boolean {
    return !this.learned.has(l.id) && l.when(v);
  }

  private pick(l: Lesson): void {
    this.current = l;
    this.shown = 0;
  }

  private drop(wait: number): void {
    this.current = null;
    this.wait = wait;
  }
}
