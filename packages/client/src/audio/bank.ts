import manifest from '../../../../assets/audio/sounds.json';

/**
 * The recorded sounds (assets/audio, built by `pnpm audio`). Each sound has one
 * or more takes; `pick` returns one at random, never the same take twice in a
 * row. Files load and decode in the background once audio is unlocked; until a
 * sound has decoded, `pick` returns null and the sound is skipped.
 */

export type SoundName = keyof typeof manifest;

interface Entry {
  count: number;
  /** Loop length in seconds, for a sound that loops. */
  loop?: number;
  /** Seconds of wrap-around padding on each side of a loop. */
  pad?: number;
}

const urls = import.meta.glob('../../../../assets/audio/*.mp3', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const urlOf = (file: string): string | undefined => urls[`../../../../assets/audio/${file}`];

export class SoundBank {
  private readonly takes = new Map<SoundName, AudioBuffer[]>();
  private readonly lastTake = new Map<SoundName, number>();
  private loading = false;

  /** Fetches and decodes every take. Safe to call more than once. */
  load(ctx: AudioContext): void {
    if (this.loading) return;
    this.loading = true;
    for (const [name, entry] of Object.entries(manifest) as [SoundName, Entry][]) {
      const list: AudioBuffer[] = [];
      this.takes.set(name, list);
      for (let i = 1; i <= entry.count; i++) {
        const url = urlOf(`${name}-${i}.mp3`);
        if (!url) {
          console.warn(`sound ${name}-${i}.mp3 is listed but missing; run pnpm audio`);
          continue;
        }
        fetch(url)
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.arrayBuffer();
          })
          .then((data) => ctx.decodeAudioData(data))
          .then((buffer) => list.push(buffer))
          .catch((err: unknown) => console.warn(`sound ${name}-${i} failed to load:`, err));
      }
    }
  }

  /** A random take of `name`, or null while none has loaded. */
  pick(name: SoundName): AudioBuffer | null {
    const list = this.takes.get(name);
    if (!list || list.length === 0) return null;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === this.lastTake.get(name)) i = (i + 1) % list.length;
    this.lastTake.set(name, i);
    return list[i];
  }

  /** Where a looping sound's seamless part starts and ends, in seconds. */
  loopRange(name: SoundName): [number, number] {
    const entry = manifest[name] as Entry;
    const pad = entry.pad ?? 0;
    return [pad, pad + (entry.loop ?? 0)];
  }
}
