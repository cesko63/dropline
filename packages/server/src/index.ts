import { CollisionWorld, TICK_DT, TICK_RATE, createMatch, stepMatch, type MapData } from '@dropline/shared';
import gym from '../../../data/maps/gym.json';

/**
 * Placeholder for the authoritative game server (phase 4). For now it only
 * proves that the shared simulation runs headless in Node: it loads the map,
 * plays a bots-only match for a minute of game time and prints the result.
 * Pass a seed as the first argument to replay a given match.
 */
async function main(): Promise<void> {
  const map = gym as MapData;
  const world = await CollisionWorld.create(map);
  const seed = Number(process.argv[2]) || 1;
  const match = createMatch(map, world, { seed, humans: 0, scoreLimit: 9999 });

  const seconds = 60;
  const started = performance.now();
  for (let tick = 0; tick < seconds * TICK_RATE; tick++) stepMatch(match, world, [], TICK_DT);
  const took = performance.now() - started;

  console.log(`[server] map "${map.name}": ${map.boxes.length} boxes, tick rate ${TICK_RATE} Hz, seed ${seed}`);
  console.log(`[server] ${seconds}s bots-only match in ${took.toFixed(0)} ms: score ${match.score[0]} - ${match.score[1]}`);
  for (const a of match.actors) {
    console.log(`[server]   team ${a.team}  ${a.name.padEnd(8)} ${(a.brain?.role ?? 'human').padEnd(9)} ${a.kills} kills, ${a.deaths} deaths`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
