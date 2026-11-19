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
import { cardOpen, cardSounds, showCard } from './ui/errorCard';
import { messageOf, note, report, where } from './util/report';

/** The card for a server that could not be joined or was lost; `retry` true when trying again may help. */
const WHY: Record<Exclude<CloseReason, 'left'>, { title: string; text: string; retry: boolean }> = {
  unreachable: { title: 'No server answered', text: 'The game server did not answer. It may be down or restarting: try again in a moment, or practice offline against bots.', retry: true },
  lost: { title: 'Connection lost', text: 'The line to the server dropped and did not come back. Try again to rejoin the match, or practice offline.', retry: true },
  version: { title: 'A new version is out', text: 'The server runs a newer version of the game than this page. Reload to get it; your settings are kept.', retry: false },
  full: { title: 'The server is full', text: 'All 8 seats are taken by pilots. Try again in a moment, or practice offline.', retry: true },
  bad: { title: 'The server said no', text: 'The server turned the connection down. Try again, and if it keeps happening, copy the details into a bug report.', retry: true },
};

/** True where the browser can draw WebGL 2, which the game needs. */
function webglWorks(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

/** The game could not start: say why in plain words, with a way to try again. */
function failedToStart(err: unknown): void {
  console.error(err);
  note(messageOf(err));
  const gl = webglWorks();
  showCard({
    tag: 'Could not start',
    title: gl ? 'The game failed to load' : '3D graphics are off',
    text: gl
      ? 'Part of the game did not load. Check your connection and try again; your settings are kept.'
      : 'This browser could not start WebGL, which the game draws with. Turn on hardware acceleration in the browser settings, update the graphics driver, or try Chrome, Edge or Firefox.',
    actions: [{ label: 'Try again', run: () => location.reload() }],
    details: report('failed to start', err),
  });
}

/** Errors that escape everything: before the game exists they mean it failed to start. */
let escaped: (err: unknown) => void = failedToStart;

/** Refusals the browser gives for permissions (pointer lock, fullscreen, sound): not the game failing. */
function browserRefusal(err: unknown): boolean {
  return err instanceof DOMException && ['NotAllowedError', 'AbortError', 'SecurityError', 'NotSupportedError'].includes(err.name);
}

window.addEventListener('error', (e) => {
  // Scripts from elsewhere (browser extensions) are not the game's.
  if (e.filename && !e.filename.startsWith(location.origin)) return;
  escaped(e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  if (!browserRefusal(e.reason)) escaped(e.reason);
});

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
  // `?server=ws://host:port` picks the server; `?perf=1` shows frame time and draw calls; `?online=1` joins it straight
  // away without the start screen (automated checks); `?name=` sets the
  // callsign; `?net=1` opens the connection details; `?hangar=1` opens the hangar.
  // `?fail=boot`, `frame` or `async` throws on purpose, to check the error cards.
  const params = new URLSearchParams(location.search);
  const fail = params.get('fail');
  if (fail === 'boot') throw new Error('the game failed to start on purpose (?fail=boot)');
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
    failFrame: fail === 'frame',
    perf: params.has('perf'),
  });
  where.map = map.name;
  where.seed = seed;
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
    // An error card reads the pad itself.
    if (cardOpen()) return;
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

  cardSounds.open = () => game.sfx.uiError();
  cardSounds.move = () => game.sfx.uiMove();
  cardSounds.select = () => game.sfx.uiSelect();
  // Leave the match for the start screen; if even that fails, start the page over.
  const toMenu = (): void => {
    try {
      game.recover();
      if (conn) {
        conn.close();
      } else {
        game.newMatch();
        menu.showChoices();
      }
    } catch {
      location.reload();
    }
  };
  // Something threw while playing: stop, say so, and offer to carry on or start over.
  const crashed = (err: unknown): void => {
    console.error(err);
    note(messageOf(err));
    if (cardOpen()) return;
    game.pause();
    where.online = game.online;
    where.matchTime = game.match.time.toFixed(1);
    showCard({
      tag: 'Something went wrong',
      title: 'The game hit an error',
      text: 'It stopped where it was. Continue to carry on, or go back to the menu for a fresh match. Your settings and hangar picks are kept.',
      actions: [
        {
          label: 'Continue',
          run: () => {
            game.recover();
            if (menu.canResume) game.resume();
          },
        },
        { label: 'Back to menu', quiet: true, back: true, run: toMenu },
      ],
      details: report('error in play', err),
    });
  };
  game.onCrash = crashed;
  escaped = crashed;
  game.onContextLost = () =>
    showCard({
      tag: 'Graphics',
      title: 'The picture was lost',
      text: 'The graphics card dropped the game\u2019s picture: a driver update, the computer waking from sleep, or too much else running at once. Reload to get it back; your settings are kept.',
      actions: [{ label: 'Reload', run: () => location.reload() }],
      details: report('WebGL context lost'),
    });
  // Sound and music that failed to download: the game plays on, and says so.
  let sounds = 0;
  let tracks = 0;
  const silent = (): void => {
    const what = [sounds && `${sounds} sound${sounds === 1 ? '' : 's'}`, tracks && `${tracks} music track${tracks === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
    menu.setNote(`${what} could not be downloaded, so the game is quieter than it should be. Reload to try again.`);
  };
  game.sfx.bank.onFail = () => {
    sounds++;
    silent();
  };
  game.sfx.music.onFail = () => {
    tracks++;
    silent();
  };

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
      menu.showChoices();
      if (!reason || reason === 'left') return;
      const why = WHY[reason];
      note(`connection closed: ${reason}`);
      showCard({
        tag: 'Connection',
        title: why.title,
        text: why.text,
        actions: [
          why.retry ? { label: 'Try again', run: () => join(name) } : { label: 'Reload', run: () => location.reload() },
          { label: 'Practice offline', quiet: true, run: () => menu.onOffline() },
          { label: 'Back', quiet: true, back: true, run: () => {} },
        ],
        details: report(`connection closed (${reason}) · ${url}`),
      });
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
  // Browsers start sound only from a click or key: the first one anywhere brings in the menu theme.
  const unlock = (): void => game.sfx.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  game.start();
  // After the start screen is up: one-time costs paid now rather than in the first fight.
  setTimeout(() => game.warmUp(), 0);
  if (fail === 'async') setTimeout(() => Promise.reject(new Error('an error escaped on purpose (?fail=async)')), 4000);
  if (auto) join(menu.callsign());
  else if (params.has('hangar')) menu.onHangar();
  // Handle for the browser console and automated checks during development.
  if (import.meta.env.DEV) (window as unknown as { dropline: Game }).dropline = game;
}

boot().catch(failedToStart);
