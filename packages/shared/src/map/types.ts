/**
 * Engine-neutral map format. Maps live in /data/maps as plain JSON so the same
 * layout can be loaded by the web client, the server, and a later Roblox port.
 */
export interface MapBox {
  id: string;
  /** Box center, meters. */
  pos: number[];
  /** Full extents, meters. */
  size: number[];
  /** Euler XYZ, degrees. */
  rot?: number[];
  /**
   * Surface style key; the client maps it to a material. `clip` is an
   * invisible wall: it collides but is never drawn.
   */
  mat: string;
}

export interface MapSpawn {
  pos: number[];
  yawDeg: number;
  /** Team that spawns here; 0 when missing. */
  team?: number;
}

/** Sky, fog and light of a map. Colours are CSS hex strings. */
export interface MapEnv {
  skyTop: string;
  skyMid: string;
  skyHorizon: string;
  fog: string;
  /** Exponential-squared fog density per meter. */
  fogDensity: number;
  sunColor: string;
  sunIntensity: number;
  /** Direction from the ground toward the sun (any length). */
  sunDir: number[];
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
}

/**
 * A sound the map makes on its own: a loop that plays the whole match, or a
 * one-shot that repeats after a random wait.
 */
export interface MapSound {
  /** A sound from assets/audio/sounds.json. */
  sound: string;
  /** Level at the source. */
  gain: number;
  /**
   * Where it sounds from. A loop is heard from the nearest point, a one-shot
   * from one picked at random each time. Missing: all around the listener.
   */
  at?: number[][];
  /** Metres over which it fades to half (default 9, as for any sound in the world). */
  reach?: number;
  /** Not heard beyond this many metres from its nearest point. */
  range?: number;
  /** A one-shot: seconds to wait between plays, at least and at most. Missing: a loop. */
  every?: [number, number];
  /** Playback rate, picked between these each time (default 1). */
  pitch?: [number, number];
  /** Wind and weather: louder up high, mostly gone under a roof. */
  exposed?: boolean;
}

export interface MapData {
  /** Id of the map, as the server announces it and `?map=` picks it. */
  name: string;
  /** Name shown to players. */
  title?: string;
  spawns: MapSpawn[];
  boxes: MapBox[];
  /**
   * Scenery that is drawn but never collides and is not part of the bot grid:
   * the skyline outside the walls, and trim laid flat on surfaces.
   */
  backdrop?: MapBox[];
  env?: MapEnv;
  /** The map's own sound: wind, the city around it, things that creak and fall. */
  ambience?: MapSound[];
}
