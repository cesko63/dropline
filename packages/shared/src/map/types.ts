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
  /** Surface style key; the client maps it to a material. */
  mat: string;
}

export interface MapSpawn {
  pos: number[];
  yawDeg: number;
}

export interface MapData {
  name: string;
  spawns: MapSpawn[];
  boxes: MapBox[];
}
