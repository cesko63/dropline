import combat from '../../../../data/combat.json';
import type { BotBrain } from '../ai/bot';
import type { NavGrid } from '../ai/nav';
import type { InputCmd } from '../input';
import type { MapSpawn } from '../map/types';
import type { Vec3 } from '../math/vec3';
import type { PlayerState } from './movement';
import type { Rng } from './rng';

/** Health, respawn and match rules. Edit /data/combat.json, not this file. */
export const COMBAT = combat;

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

  kills: number;
  deaths: number;
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
  head: boolean;
}

/** Things that happened during one tick. The client turns them into effects and sound. */
export type MatchEvent =
  | { type: 'shot'; actor: number; weapon: string; origin: Vec3; traces: ShotTrace[] }
  | { type: 'damage'; victim: number; attacker: number; amount: number; head: boolean; killed: boolean; pos: Vec3 }
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
  | { type: 'matchEnd'; winner: number };

export interface MatchState {
  seed: number;
  tick: number;
  time: number;
  rng: Rng;
  actors: Actor[];
  /** Kills per team. */
  score: number[];
  scoreLimit: number;
  over: boolean;
  winner: number;
  /** Events of the latest tick only. */
  events: MatchEvent[];
  spawns: MapSpawn[];
  nav: NavGrid;
  /** The command each actor used in the latest tick (scratch). */
  cmds: (InputCmd | null)[];
}
