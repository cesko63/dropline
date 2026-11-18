import { CollisionWorld, FRAMES, NET, mapById } from '@dropline/shared';
import { Game } from './game';
import { readLayout } from './input/bindings';
import { Connection, type CloseReason } from './net/connection';
import { LoadoutStore } from './settings/loadout';
import { SettingsStore, browserStorage } from './settings/settings';
import { Hangar, SIDES } from './ui/hangar';
import { Menu } from './ui/menu';
import { PadNav } from './ui/padNav';
import { SettingsScreen } from './ui/settingsScreen';

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
  // `?map=gym` picks the map (online, the server's map wins); `?seed=123`
  // replays a given offline match; `?qa=1` shows what every bot is thinking;
  // `?meter=1` starts everyone with a full mech meter (offline).
  // `?server=ws://host:port` picks the server; `?online=1` joins it straight
  // away without the start screen (automated checks); `?name=` sets the
  // callsign; `?net=1` opens the connection details; `?hangar=1` opens the hangar.
  const params = new URLSearchParams(location.search);
  const map = mapById(params.get('map'));
  const world = await CollisionWorld.create(map);
  const seed = Number(params.get('seed')) || (Date.now() & 0x7fffffff);
  const settings = new SettingsStore(browserStorage());
  const loadout = new LoadoutStore(browserStorage());
  const game = new Game(document.getElementById('view') as HTMLCanvasElement, world, map, {
    seed,
    qa: params.has('qa'),
    startMeter: Math.max(0, Math.min(1, Number(params.get('meter')) || 0)),
    netDebug: params.has('net'),
    settings,
    loadout,
  });
  // Offline you play the side picked in the hangar; the match behind the start screen follows it.
  game.side = loadout.value.side;
  if (game.side !== 0) game.newMatch();
  const menu = new Menu(params.get('name') ?? '');
  const screen = new SettingsScreen(document.getElementById('settings')!, settings, game.sfx);
  const hangar = new Hangar(document.getElementById('hangar')!, loadout, game.sfx);
  const nav = new PadNav(document.querySelector('#overlay .panel') as HTMLElement, screen, game.sfx, hangar);
  const summary = (): void => menu.setLoadout(`${SIDES[loadout.value.side].short} · ${FRAMES[loadout.value.mech].short}`);
  summary();
  loadout.listen((l) => {
    summary();
    // Only reachable before a match, so the waiting offline match can be swapped for one on the new side.
    if (l.side !== game.side && !game.online) {
      game.side = l.side;
      game.newMatch();
    }
  });

  // The controls list and the resume button name the keys of the device in use.
  const controls = (): void => menu.renderControls((a) => game.keyOf(a), game.input.device, settings.value);
  game.onKeysChange = controls;
  settings.listen(controls);
  void readLayout().then(() => game.onKeysChange());

  // Every button on the start screens ticks as the pointer reaches it.
  document.getElementById('overlay')!.addEventListener('pointerover', (e) => {
    const button = (e.target as HTMLElement).closest('button');
    if (button && !button.disabled && !button.contains(e.relatedTarget as Node | null)) game.sfx.uiMove();
  });

  menu.onSettings = () => {
    game.sfx.unlock();
    game.sfx.uiOpen();
    menu.showSettings();
    screen.open();
  };
  screen.onClose = () => menu.hideSettings();
  menu.onHangar = () => {
    game.sfx.unlock();
    game.sfx.uiOpen();
    menu.showHangar();
    hangar.open();
  };
  hangar.onClose = () => menu.hideHangar();
  game.onMenuFrame = (dt) => {
    nav.update(game.input.pad, dt);
    hangar.setDevice(game.input.device);
    hangar.update(game.input.pad, dt);
  };
  // Paused on a pad: put the focus on the screen so the D-pad has somewhere to start.
  game.onPlayingChange = (playing) => {
    if (!playing && game.input.device === 'pad') nav.focusFirst();
  };
  nav.onStart = () => {
    if (menu.canResume) game.resume();
  };
  const url = serverUrl(params);
  const auto = params.has('online');
  let conn: Connection | null = null;

  const join = (name: string): void => {
    if (conn) return;
    game.sfx.unlock();
    game.sfx.uiSelect();
    menu.showConnecting(url.replace(/^wss?:\/\//, ''));
    const c = new Connection(url, name, world, map, loadout.value.side);
    conn = c;
    // The server plays another map: load it and join again.
    c.onOtherMap = (id) => {
      const next = new URLSearchParams(location.search);
      next.set('map', id);
      next.set('online', '1');
      next.set('name', name);
      location.search = next.toString();
    };
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
    game.sfx.unlock();
    game.sfx.uiSelect();
    menu.showPlaying();
    game.resume();
  };
  menu.onResume = () => game.resume();
  menu.onLeave = () => {
    game.sfx.uiBack();
    if (conn) {
      conn.close();
    } else {
      game.newMatch();
      menu.showChoices();
    }
  };
  game.start();
  if (auto) join(menu.callsign());
  else if (params.has('hangar')) menu.onHangar();
  // Handle for the browser console and automated checks during development.
  if (import.meta.env.DEV) (window as unknown as { dropline: Game }).dropline = game;
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:0;margin:0;padding:24px;background:#200;color:#fbb">${String(err)}</pre>`);
});
