import { PROTOCOL_VERSION } from '@dropline/shared';

/**
 * The text behind "copy details": what failed and where the game was, for a
 * bug report. Plain lines a player can paste anywhere.
 */

/** Where the game was when it failed; `main.ts` fills this in as it learns more. */
export const where: Record<string, string | number | boolean> = {};

/** The last few things the game logged as going wrong, oldest first. */
const recent: string[] = [];
const RECENT = 8;

export function note(line: string): void {
  recent.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (recent.length > RECENT) recent.shift();
}

/** An error's message, whatever was thrown. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function report(what: string, err?: unknown): string {
  const lines = [
    `DROPLINE bug report · ${what}`,
    `time      ${new Date().toISOString()}`,
    `build     ${import.meta.env.MODE} · protocol ${PROTOCOL_VERSION}`,
    `page      ${location.pathname}${location.search}`,
    `browser   ${navigator.userAgent}`,
  ];
  for (const [k, v] of Object.entries(where)) lines.push(`${k.padEnd(9)} ${v}`);
  if (err !== undefined) {
    lines.push('', messageOf(err));
    if (err instanceof Error && err.stack) lines.push(err.stack);
  }
  if (recent.length) lines.push('', 'recent', ...recent);
  return lines.join('\n');
}
