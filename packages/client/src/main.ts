import { CollisionWorld, type MapData } from '@dropline/shared';
import gym from '../../../data/maps/gym.json';
import { Game } from './game';

async function boot(): Promise<void> {
  const map = gym as MapData;
  const world = await CollisionWorld.create(map);
  // `?seed=123` replays a given match; `?qa=1` shows what every bot is thinking;
  // `?meter=1` starts everyone with a full mech meter.
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed')) || (Date.now() & 0x7fffffff);
  const game = new Game(document.getElementById('view') as HTMLCanvasElement, world, map, {
    seed,
    qa: params.has('qa'),
    startMeter: Math.max(0, Math.min(1, Number(params.get('meter')) || 0)),
  });
  game.start();
  // Handle for the browser console and automated checks during development.
  if (import.meta.env.DEV) (window as unknown as { dropline: Game }).dropline = game;
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:0;margin:0;padding:24px;background:#200;color:#fbb">${String(err)}</pre>`);
});
