import combat from '../../../../data/combat.json';
import type { BotBrain } from '../ai/bot';
import type { NavGrid } from '../ai/nav';
import type { InputCmd } from '../input';
import type { MapSpawn } from '../map/types';
import type { Vec3 } from '../math/vec3';
import type { LagHistory } from './lagcomp';
import type { Mech } from './mech';
import type { PlayerState } from './movement';
import type { Projectile } from './projectiles';
import type { Rng } from './rng';

/** Health, respawn, match and mech rules. Edit /data/combat.json, not this file. */
export const COMBAT = combat;

/** A pilot's weapons, set aside while the pilot sits in a mech. */
export interface Kit {
  loadout: string[];
  ammo: number[];
  weapon: number;
}

/** A pilot in a match: a human or a bot. Both are driven by an `InputCmd` per tick. */
export interface Actor {
  id: number;
  name: string;
  team: number;
  p: PlayerState;

  health: number;
  alive: boolean;
  /** Seconds until respawn while dead. */
  respawnIn: number;
  /** Seconds since damage was last taken; health regenerates after a delay. */
  sinceDamage: number;
  /** Seconds of spawn protection left. Ends early when the pilot fires. */
  protect: number;

  /** Weapon ids carried, and the rounds left in each. */
  loadout: string[];
  ammo: number[];
  /** Index into `loadout`. */
  weapon: number;
  /** Seconds until the next shot is allowed. */
  cooldown: number;
  /** Seconds left on the current reload, 0 when not reloading. */
  reload: number;
  /** Seconds left on drawing the weapon. */
  equip: number;
  /** Extra spread from recent shots, degrees. */
  bloom: number;
  /** Recoil offset added to the view and to every shot, radians. */
  punchPitch: number;
  punchYaw: number;
  /** 0 at the hip, 1 fully aimed down sights. */
  ads: number;
  triggerHeld: boolean;
  /** A semi-auto press is remembered this long so an early click still fires. */
  fireBuffer: number;
  /** Match time of the last shot, for bots that hear gunfire. */
  lastShotTime: number;
  /** Damage dealt is multiplied by this (bots hit softer than their weapon's numbers). */
  damageScale: number;

  /** Charge toward calling a mech, 0..1. Fills over time and from damage dealt. */
  meter: number;
  /**
   * True while sitting in the mech (`MatchState.mechs[id]`). The pilot cannot be
   * hurt, `p` follows the mech, and `loadout` and `ammo` are the mech's.
   */
  inMech: boolean;
  /** The pilot's own weapons while `inMech`, else null. */
  kit: Kit | null;
  useHeld: boolean;
  callHeld: boolean;
  redeployHeld: boolean;

  /**
   * The pilot's own generator for spread and recoil, or null to draw from the
   * match's. A networked human has one, so the client can predict its own shots
   * and land on the same numbers as the server.
   */
  rng: Rng | null;
  /**
   * The match tick this pilot's player was looking at when the command was made
   * (others are drawn a little in the past), or -1. Shots are traced against
   * where the targets stood then; see `lagcomp.ts`.
   */
  viewTick: number;
  /** No command arrived for this tick: the pilot is held still until one does. */
  stalled: boolean;

  kills: number;
  deaths: number;
  /** Enemy mechs destroyed. */
  mechKills: number;
  /** Actor id that last dealt damage, or -1. */
  lastAttacker: number;

  /** Present on bots. */
  brain: BotBrain | null;
}

export interface ShotTrace {
  /** Where the ray stopped. */
  end: Vec3;
  /** Surface normal when it stopped on the map, else null. */
  normal: Vec3 | null;
  /** Actor id that was hit, or -1. */
  victim: number;
  /** Mech id that was hit, or -1. */
  mech: number;
  /** A headshot, or on a mech a hit on the rear vent. */
  head: boolean;
}

/** Things that happened during one tick. The client turns them into effects and sound. */
export type MatchEvent =
  | { type: 'shot'; actor: number; weapon: string; origin: Vec3; traces: ShotTrace[] }
  | { type: 'damage'; victim: number; attacker: number; amount: number; head: boolean; killed: boolean; pos: Vec3 }
  /** `weapon` is a weapon id, a projectile kind, 'crush' (a mech landing) or 'ram' (a mech's dash). */
  | { type: 'kill'; victim: number; attacker: number; weapon: string; head: boolean }
  | { type: 'spawn'; actor: number }
  | { type: 'reload'; actor: number }
  | { type: 'reloaded'; actor: number }
  | { type: 'dry'; actor: number }
  | { type: 'equip'; actor: number }
  /** A bot spotted `target` and is about to react. */
  | { type: 'notice'; actor: number; target: number }
  /** A marksman bot started lining up a shot on `target`. */
  | { type: 'charge'; actor: number; target: number; duration: number }
  /** The mech meter filled: the pilot may call a mech. */
  | { type: 'meterReady'; actor: number }
  /** A mech is on its way and lands at `pos` after `duration` seconds. */
  | { type: 'mechCall'; actor: number; pos: Vec3; duration: number }
  /** A call that did nothing: the meter is not full, or no place to land was found. */
  | { type: 'callDenied'; actor: number; reason: 'meter' | 'zone' }
  | { type: 'mechLand'; mech: number; pos: Vec3 }
  /** The pilot climbed in; the mech starts up for `duration` seconds. */
  | { type: 'embark'; actor: number; duration: number }
  | { type: 'mechOnline'; actor: number }
  /** The pilot left the mech: climbed out, or was thrown clear when it blew up (`eject`). */
  | { type: 'disembark'; actor: number; eject: boolean }
  /** A footfall. `heavy` when the mech came down from a height. */
  | { type: 'mechStep'; mech: number; heavy: boolean }
  | { type: 'mechDash'; mech: number }
  /** A dash that ran into a pilot (`victim`) or a mech (`other`); the unused one is -1. */
  | { type: 'ram'; mech: number; victim: number; other: number }
  | { type: 'mechDamage'; mech: number; attacker: number; amount: number; crit: boolean; destroyed: boolean; pos: Vec3 }
  | { type: 'mechDestroyed'; mech: number; attacker: number; weapon: string; pos: Vec3 }
  /** A rocket left its launcher. */
  | { type: 'launch'; id: number; actor: number; kind: string; pos: Vec3; dir: Vec3 }
  | { type: 'explode'; id: number; actor: number; kind: string; pos: Vec3; normal: Vec3 | null }
  | { type: 'matchEnd'; winner: number };

export interface MatchState {
  seed: number;
  tick: number;
  time: number;
  rng: Rng;
  actors: Actor[];
  /** One slot per actor, same index: the mech that pilot has called, if any. */
  mechs: Mech[];
  /** Rockets in flight. */
  projectiles: Projectile[];
  nextProjectile: number;
  /** Points per team: one per pilot killed, more for a mech destroyed. */
  score: number[];
  scoreLimit: number;
  over: boolean;
  winner: number;
  /** Events of the latest tick only. */
  events: MatchEvent[];
  spawns: MapSpawn[];
  nav: NavGrid;
  /** Where a mech fits: the same floor for a wider and taller body. */
  navMech: NavGrid;
  /** The command each actor used in the latest tick (scratch). */
  cmds: (InputCmd | null)[];
  /** Where everyone stood over the last second, for lag compensation. Null when nobody needs it (offline). */
  history: LagHistory | null;
  /**
   * True on a client's copy of the match: only the player's own pilot is stepped
   * there (`stepOwn`), and nothing it does hurts anyone. Damage comes from the server.
   */
  predict: boolean;
}
