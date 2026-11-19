import manifest from '../../../../assets/music/music.json';

/**
 * The music (assets/music, built by `pnpm audio`). One track plays at a time;
 * asking for another fades the old one out under it. A looped track plays its
 * intro once, then loops the span the build matched. Tracks load in the
 * background once audio is unlocked, the menu theme first; a track asked for
 * before it has loaded starts when it arrives, if it is still wanted.
 */

export type Track = keyof typeof manifest;

interface Entry {
  /** Loop span in seconds; absent for a track that plays once. */
  loop?: [number, number];
}

const urls = import.meta.glob('../../../../assets/music/*.mp3', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** Level of the music under everything else, before the music volume setting. */
const BASE = 0.45;
/** Level while a menu is up over a match. */
const DUCKED = 0.3;

interface Playing {
  track: Track;
  src: AudioBufferSourceNode;
  gain: GainNode;
}

export class Music {
  /** A track failed to download: the game plays on without it. */
  onFail: (track: string) => void = () => {};
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private duck: GainNode | null = null;
  private volume = 0.7;
  private ducked = false;
  private readonly buffers = new Map<Track, AudioBuffer>();
  private playing: Playing | null = null;
  /** The track last asked for: what should be playing, or null for silence. */
  private wanted: Track | null = null;

  /** Called once the audio context exists; `dest` is the master bus. */
  attach(ctx: AudioContext, dest: AudioNode): void {
    this.ctx = ctx;
    this.duck = ctx.createGain();
    this.duck.gain.value = this.ducked ? DUCKED : 1;
    this.out = ctx.createGain();
    this.out.gain.value = BASE * this.volume;
    this.duck.connect(this.out).connect(dest);
    void this.loadAll(ctx);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(BASE * volume, this.ctx.currentTime, 0.05);
  }

  /** Lower the music while a menu is up over a match; it plays on underneath. */
  setDucked(ducked: boolean): void {
    if (ducked === this.ducked) return;
    this.ducked = ducked;
    if (this.duck && this.ctx) this.duck.gain.setTargetAtTime(ducked ? DUCKED : 1, this.ctx.currentTime, 0.15);
  }

  /** Play `track` unless it is already the one asked for. */
  play(track: Track): void {
    if (this.wanted === track) return;
    this.wanted = track;
    this.start(track);
  }

  /** Fade whatever plays out to silence. */
  stop(): void {
    this.wanted = null;
    this.fadeOut();
  }

  private start(track: Track): void {
    const ctx = this.ctx;
    const buffer = this.buffers.get(track);
    if (!ctx || !this.duck || !buffer) return;
    this.fadeOut();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const loop = (manifest[track] as Entry).loop;
    if (loop) {
      src.loop = true;
      [src.loopStart, src.loopEnd] = loop;
    }
    const gain = ctx.createGain();
    // A short ramp only: a theme starts on its first hit.
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.02);
    src.connect(gain).connect(this.duck);
    const playing: Playing = { track, src, gain };
    // A track that played to its end leaves silence; one faded out for another is already forgotten.
    src.onended = () => {
      if (this.playing !== playing) return;
      this.playing = null;
      if (this.wanted === track) this.wanted = null;
    };
    src.start();
    this.playing = playing;
  }

  private fadeOut(): void {
    const old = this.playing;
    const ctx = this.ctx;
    if (!old || !ctx) return;
    this.playing = null;
    old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    old.src.stop(ctx.currentTime + 2.5);
  }

  /** The menu theme first, so it can start as soon as possible; then the rest in turn. */
  private async loadAll(ctx: AudioContext): Promise<void> {
    const order = (Object.keys(manifest) as Track[]).sort((a, b) => Number(b === 'menu') - Number(a === 'menu'));
    for (const track of order) {
      const url = urls[`../../../../assets/music/${track}.mp3`];
      if (!url) {
        console.warn(`music ${track}.mp3 is listed but missing; run pnpm audio`);
        continue;
      }
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.buffers.set(track, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch (err) {
        console.warn(`music ${track} failed to load:`, err);
        this.onFail(track);
        continue;
      }
      if (this.wanted === track && this.playing?.track !== track) this.start(track);
    }
  }
}
