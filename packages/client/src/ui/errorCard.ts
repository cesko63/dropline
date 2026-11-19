/**
 * The error card: what went wrong in plain words, with ways out ("try again",
 * "back to menu") and a button that copies the details for a bug report. It
 * builds its own markup so it works even when the game failed to start, and
 * reads the pad itself so it works while the game loop is stopped.
 */

export interface CardAction {
  label: string;
  run: () => void;
  /** Drawn as a secondary button; Esc and the pad's B pick the last one marked `back`. */
  quiet?: boolean;
  back?: boolean;
}

export interface CardInfo {
  /** Small line over the title, e.g. CONNECTION. */
  tag: string;
  title: string;
  text: string;
  actions: CardAction[];
  /** Text for "copy details"; no copy button without it. */
  details?: string;
}

/** Sounds for the card, set once the game's sound exists. */
export const cardSounds = { open: (): void => {}, move: (): void => {}, select: (): void => {} };

let root: HTMLElement | null = null;
let current: CardInfo | null = null;
let padFrame = 0;

export function cardOpen(): boolean {
  return current !== null;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}

export function showCard(info: CardInfo): void {
  current = info;
  if (!root) {
    root = h('div', 'error-card');
    root.setAttribute('role', 'alertdialog');
    root.setAttribute('aria-modal', 'true');
    document.body.append(root);
    root.addEventListener('keydown', onKey);
    root.addEventListener('pointerover', (e) => {
      if ((e.target as HTMLElement).closest('button') && !(e.target as HTMLElement).closest('button')!.contains(e.relatedTarget as Node | null)) cardSounds.move();
    });
  }
  const box = h('div', 'error-box');
  const title = h('h2', '', info.title);
  title.id = 'error-title';
  root.setAttribute('aria-labelledby', title.id);
  const buttons = h('div', 'error-actions');
  for (const a of info.actions) {
    const b = h('button', a.quiet ? 'quiet' : '', a.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      cardSounds.select();
      hideCard();
      a.run();
    });
    buttons.append(b);
  }
  box.append(h('p', 'tag', info.tag), title, h('p', 'error-text', info.text), buttons);
  if (info.details) box.append(copyButton(info.details));
  root.replaceChildren(box);
  root.hidden = false;
  cardSounds.open();
  // Escape from pointer lock so the mouse can reach the buttons.
  if (document.pointerLockElement) document.exitPointerLock();
  buttons.querySelector('button')?.focus();
  // A button already down (the one that was firing) must be let go first.
  held.clear();
  for (const p of navigator.getGamepads?.() ?? []) p?.buttons.forEach((b, i) => b.pressed && held.add(i));
  cancelAnimationFrame(padFrame);
  padFrame = requestAnimationFrame(readPad);
}

export function hideCard(): void {
  current = null;
  if (root) root.hidden = true;
  cancelAnimationFrame(padFrame);
}

/** "Copy details": the report on the clipboard, or selected for copying by hand where that is refused. */
function copyButton(details: string): HTMLElement {
  const wrap = h('div', 'error-copy');
  const b = h('button', 'quiet small', 'Copy details');
  b.type = 'button';
  const said = h('span', '', '');
  said.setAttribute('role', 'status');
  b.addEventListener('click', () => {
    cardSounds.select();
    navigator.clipboard?.writeText(details).then(
      () => (said.textContent = 'Copied. Paste it into your bug report.'),
      () => showText(wrap, details, said),
    ) ?? showText(wrap, details, said);
  });
  wrap.append(b, said);
  return wrap;
}

function showText(wrap: HTMLElement, details: string, said: HTMLElement): void {
  said.textContent = 'Select the text below and copy it.';
  const area = h('textarea', 'error-details');
  area.readOnly = true;
  area.value = details;
  wrap.append(area);
  area.select();
}

/** Arrow keys move between the buttons; Esc picks the way back. */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    back();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    step(1);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    step(-1);
  }
  e.stopPropagation();
}

function back(): void {
  const a = current && [...current.actions].reverse().find((x) => x.back);
  if (!a) return;
  cardSounds.select();
  hideCard();
  a.run();
}

function step(dir: number): void {
  if (!root) return;
  const list = [...root.querySelectorAll<HTMLButtonElement>('button')];
  if (list.length === 0) return;
  const i = list.indexOf(document.activeElement as HTMLButtonElement);
  list[(i + dir + list.length) % list.length].focus();
  cardSounds.move();
}

/** Buttons held last frame, so a press acts once. */
const held = new Set<number>();
const PAD_A = 0;
const PAD_B = 1;
const PAD_UP = 12;
const PAD_DOWN = 13;
const PAD_LEFT = 14;
const PAD_RIGHT = 15;

function readPad(): void {
  if (!current) return;
  padFrame = requestAnimationFrame(readPad);
  const pad = navigator.getGamepads?.().find((p) => p?.connected);
  if (!pad) return;
  const pressed = (i: number): boolean => {
    const down = pad.buttons[i]?.pressed ?? false;
    const was = held.has(i);
    if (down) held.add(i);
    else held.delete(i);
    return down && !was;
  };
  if (pressed(PAD_A)) (document.activeElement as HTMLElement | null)?.click();
  if (pressed(PAD_B)) back();
  if (pressed(PAD_DOWN) || pressed(PAD_RIGHT)) step(1);
  if (pressed(PAD_UP) || pressed(PAD_LEFT)) step(-1);
}
