import { CollisionWorld, NET, type MapData } from '@dropline/shared';
import gym from '../../../data/maps/gym.json';
import { Game } from './game';
import { Connection, type CloseReason } from './net/connection';
import { Menu } from './ui/menu';

/** What to tell the player when the server could not be joined or was lost. */
const WHY: Record<CloseReason, string> = {
  unreachable: 'No server answered. Try again in a moment, or practice offline.',
  lost: 'The connection to the server was lost.',
  version: 'This page is out of date. Reload it to get the current version.',
  full: 'The server is full: all 8 seats are taken by pilots.',
  bad: 'The server turned the connection down.',
  left: '',
};

/** `?server=` wins, then the build's `VITE_SERVER_URL`, then the page's own host on the default port. */
function serverUrl(params: URLSearchParams): string {
  const given = params.get('server') ?? (import.meta.env.VITE_SERVER_URL as string | undefined);
  if (given) return given;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${NET.port}`;
}

async function boot(): Promise<void> {
  const map = gym as MapData;
  const world = await CollisionWorld.create(map);
  // `?seed=123` replays a given offline match; `?qa=1` shows what every bot is
  // thinking; `?meter=1` starts everyone with a full mech meter (offline).
  // `?server=ws://host:port` picks the server; `?online=1` joins it straight
  // away without the start screen (automated checks); `?name=` sets the
  // callsign; `?net=1` opens the connection details.
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed')) || (Date.now() & 0x7fffffff);
  const game = new Game(document.getElementById('view') as HTMLCanvasElement, world, map, {
    seed,
    qa: params.has('qa'),
    startMeter: Math.max(0, Math.min(1, Number(params.get('meter')) || 0)),
    netDebug: params.has('net'),
  });
  const menu = new Menu(params.get('name') ?? '');
  const url = serverUrl(params);
  const auto = params.has('online');
  let conn: Connection | null = null;

  const join = (name: string): void => {
    if (conn) return;
    menu.showConnecting(url.replace(/^wss?:\/\//, ''));
    const c = new Connection(url, name, world, map);
    conn = c;
    c.onWelcome = () => {
      const first = !game.online;
      game.goOnline(c);
      if (!first) return;
      menu.showPlaying();
      // The click that asked to deploy is recent enough for the browser to
      // hand over the mouse; if it is not, the screen stays up with "resume".
      if (auto) menu.hide();
      else game.resume();
    };
    c.onMatch = () => game.goOnline(c);
    c.onRoster = (before, now) => game.rosterChanged(before, now);
    c.onStatus = (status, reason) => {
      if (status !== 'closed' || conn !== c) return;
      conn = null;
      if (document.pointerLockElement) document.exitPointerLock();
      game.newMatch();
      menu.showChoices(reason ? WHY[reason] : '');
    };
  };

  menu.onOnline = join;
  menu.onOffline = () => {
    menu.showPlaying();
    game.resume();
  };
  menu.onResume = () => game.resume();
  menu.onLeave = () => {
    if (conn) {
      conn.close();
    } else {
      game.newMatch();
      menu.showChoices();
    }
  };
  game.start();
  if (auto) join(menu.callsign());
  // Handle for the browser console and automated checks during development.
  if (import.meta.env.DEV) (window as unknown as { dropline: Game }).dropline = game;
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:0;margin:0;padding:24px;background:#200;color:#fbb">${String(err)}</pre>`);
});
