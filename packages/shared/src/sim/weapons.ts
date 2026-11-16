import autocannon from '../../../../data/weapons/autocannon.json';
import carbine from '../../../../data/weapons/carbine.json';
import longshot from '../../../../data/weapons/longshot.json';
import pike from '../../../../data/weapons/pike.json';
import projectiles from '../../../../data/projectiles.json';
import scattergun from '../../../../data/weapons/scattergun.json';

/** One weapon's numbers. Edit the files in /data/weapons, not this one. */
export interface WeaponDef {
  id: string;
  name: string;
  /** Short label for the HUD and kill feed. */
  short: string;
  /** `auto` fires while the trigger is held; `semi` needs a press per shot. */
  fireMode: 'auto' | 'semi';
  rpm: number;
  /** Rays per shot. */
  pellets: number;
  /** Damage per ray before falloff and multipliers. */
  damage: number;
  /** Damage per ray to a mech's hull instead. Small arms barely scratch one. */
  armor: number;
  /** Set on launchers: each shot is a rocket of this kind (see /data/projectiles.json) instead of a ray. */
  projectile?: string;
  headMult: number;
  /** Damage scales from 1 at `falloffStart` meters down to `falloffMin` at `falloffEnd`. */
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  range: number;
  magSize: number;
  reloadTime: number;
  equipTime: number;
  spread: {
    hipDeg: number;
    adsDeg: number;
    /** Added per shot, up to `bloomMaxDeg`; shrinks by `bloomRecover` degrees a second. */
    bloomDeg: number;
    bloomMaxDeg: number;
    bloomRecover: number;
    /** Added at full sprint speed, scaled down below it. */
    moveDeg: number;
    airDeg: number;
  };
  recoil: {
    /** View kick per shot. It decays back by `recover` per second (exponential). */
    pitchDeg: number;
    yawDeg: number;
    recover: number;
  };
  /** Field of view multiplier when fully aimed. */
  adsZoom: number;
  /** Fully aimed, the view goes through a scope instead of over the sights. */
  scope: boolean;
  adsTime: number;
}

export const WEAPON_LIST = [carbine, scattergun, longshot, pike, autocannon] as unknown as WeaponDef[];

export const WEAPONS: Record<string, WeaponDef> = Object.fromEntries(WEAPON_LIST.map((w) => [w.id, w]));

/** One kind of rocket. Edit /data/projectiles.json, not this file. */
export interface ProjectileDef {
  /** Label for the kill feed. */
  name: string;
  /** Meters a second, in a straight line. */
  speed: number;
  /** Seconds of flight before it bursts on its own. */
  life: number;
  /** Blast radius, meters. */
  radius: number;
  /** Damage to a pilot at the center of the blast; a quarter of it is left at the edge. */
  damage: number;
  /** Damage to the mech it strikes. */
  armor: number;
  /** Share of `armor` dealt to other mechs caught at the center of the blast. */
  splashArmor: number;
  /** It bursts when it passes this close to a pilot, so a near miss still counts. */
  fuse: number;
}

export const PROJECTILES = projectiles as Record<string, ProjectileDef>;

/** Damage multiplier at a distance in meters. */
export function damageFalloff(def: WeaponDef, dist: number): number {
  if (dist <= def.falloffStart) return 1;
  if (dist >= def.falloffEnd) return def.falloffMin;
  const k = (dist - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return 1 + (def.falloffMin - 1) * k;
}
