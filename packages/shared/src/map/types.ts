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
}
