import { CollisionWorld, TICK_DT, TICK_RATE, createPlayerState, emptyInput, lenH, stepPlayer, v3, type MapData } from '@dropline/shared';
import gym from '../../../data/maps/gym.json';

/**
 * Placeholder for the authoritative game server (phase 4). For now it only
 * proves that the shared simulation runs headless in Node: it loads the map,
 * drives one scripted player for a few seconds and prints where it ended up.
 */
async function main(): Promise<void> {
  const map = gym as MapData;
  const world = await CollisionWorld.create(map);
  const spawn = map.spawns[0];
  const player = createPlayerState(v3(spawn.pos[0], spawn.pos[1], spawn.pos[2]));

  const seconds = 3;
  for (let tick = 0; tick < seconds * TICK_RATE; tick++) {
    const t = tick * TICK_DT;
    stepPlayer(player, { ...emptyInput(), moveZ: 1, sprint: true, jump: t > 1 && t < 1.1 }, world, TICK_DT);
  }

  const { x, y, z } = player.pos;
  console.log(`[server] map "${map.name}": ${map.boxes.length} boxes, tick rate ${TICK_RATE} Hz`);
  console.log(`[server] scripted player after ${seconds}s: pos (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}), speed ${lenH(player.vel).toFixed(2)} m/s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
