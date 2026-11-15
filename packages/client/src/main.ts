import { CollisionWorld, type MapData } from '@dropline/shared';
import gym from '../../../data/maps/gym.json';
import { Game } from './game';

async function boot(): Promise<void> {
  const map = gym as MapData;
  const world = await CollisionWorld.create(map);
  const game = new Game(document.getElementById('view') as HTMLCanvasElement, world, map);
  game.start();
  // Handle for the browser console and automated checks during development.
  if (import.meta.env.DEV) (window as unknown as { dropline: Game }).dropline = game;
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:0;margin:0;padding:24px;background:#200;color:#fbb">${String(err)}</pre>`);
});
