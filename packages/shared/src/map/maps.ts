import gym from '../../../../data/maps/gym.json';
import spireNine from '../../../../data/maps/spire-nine.json';
import type { MapData } from './types';

/**
 * Every map the game ships, by id. The gym is the test map; Spire Nine is the
 * first real one and the default.
 */
export const MAPS: Record<string, MapData> = {
  [spireNine.name]: spireNine as MapData,
  [gym.name]: gym as MapData,
};

export const DEFAULT_MAP = spireNine.name;

/** The map with this id, or the default map when the id is unknown or missing. */
export function mapById(id: string | null | undefined): MapData {
  return (id && MAPS[id]) || MAPS[DEFAULT_MAP];
}
