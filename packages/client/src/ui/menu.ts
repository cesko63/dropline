import { NET } from '@dropline/shared';

/**
 * The start screen: pick a callsign, deploy online or practice offline, and
 * once in a match, resume it or leave. It only shows and reports; `main.ts`
 * decides what each choice does.
 */

const NAME_KEY = 'dropline.name';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** The name as the server will accept it: printable, single spaces, at most `NET.nameLength`. */
export function cleanName(raw: string): string {
  return raw
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NET.nameLength);
}

export class Menu {
  onOnline: (name: string) => void = () => {};
  onOffline: () => void = () => {};
  onResume: () => void = () => {};
  onLeave: () => void = () => {};

  private readonly overlay = el('overlay');
  private readonly choose = el('menu');
  private readonly resume = el('resume');
  private readonly name = el<HTMLInputElement>('callsign');
  private readonly online = el<HTMLButtonElement>('play-online');
  private readonly offline = el<HTMLButtonElement>('play-offline');
  private readonly status = el('menu-status');

  constructor(name: string) {
    let stored = '';
    try {
      stored = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      // No storage: the callsign is asked for each visit.
    }
    this.name.value = cleanName(name || stored) || `PILOT ${100 + Math.floor(Math.random() * 900)}`;
    this.name.maxLength = NET.nameLength;

    this.online.addEventListener('click', () => this.onOnline(this.callsign()));
    this.offline.addEventListener('click', () => this.onOffline());
    this.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.online.disabled) this.onOnline(this.callsign());
    });
    el('start').addEventListener('click', () => this.onResume());
    el('leave').addEventListener('click', () => this.onLeave());
  }

  /** The callsign as typed, tidied and remembered for next time. */
  callsign(): string {
    const name = cleanName(this.name.value) || 'PILOT';
    this.name.value = name;
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // See above.
    }
    return name;
  }

  /** Back to the first screen, optionally saying what went wrong. */
  showChoices(error = ''): void {
    this.choose.hidden = false;
    this.resume.hidden = true;
    this.busy(false);
    this.say(error, 'error');
    this.overlay.classList.remove('hidden');
  }

  /** Waiting for the server to answer. */
  showConnecting(where: string): void {
    this.busy(true);
    this.say(`Connecting to ${where} …`, 'info');
  }

  /** A match is running: the screen now only resumes or leaves it. */
  showPlaying(): void {
    this.choose.hidden = true;
    this.resume.hidden = false;
    this.busy(false);
    this.say('', 'info');
  }

  /** Take the screen away without the mouse being captured (automated checks). */
  hide(): void {
    this.overlay.classList.add('hidden');
  }

  private busy(on: boolean): void {
    this.online.disabled = on;
    this.offline.disabled = on;
    this.name.disabled = on;
  }

  private say(text: string, kind: 'info' | 'error'): void {
    this.status.hidden = text === '';
    this.status.textContent = text;
    this.status.dataset.kind = kind;
  }
}
