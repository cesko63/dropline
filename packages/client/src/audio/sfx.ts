import type { Vec3 } from '@dropline/shared';
import { SoundBank, type SoundName } from './bank';
import { Music } from './music';
import type { Surface } from './surfaces';

/**
 * Sound effects. Pilots (movement, weapons, impacts, hurt and death) play
 * recorded takes from the sound bank, a random take each time with a little
 * pitch jitter. Everything else is still a synthesized STAND-IN built from
 * filtered noise and short tones, until its recordings replace it (mechs, then
 * menus and HUD); callers will not change.
 */

const MAX_VOICES = 48;

/** A sound that plays for as long as `hold` is called every frame. */
interface Loop {
  src: AudioBufferSourceNode;
  out: GainNode;
  muffle: BiquadFilterNode;
  pan: StereoPannerNode;
  held: boolean;
}

/** Beyond this, a remote shot is heard as its distant take, with the room in it. */
const FAR_SHOT = 18;

interface BurstOpts {
  dur: number;
  type: BiquadFilterType;
  /** Filter frequency at the start and at the end. */
  f0: number;
  f1?: number;
  q?: number;
  gain: number;
  /** Seconds from now. */
  at?: number;
}

interface ToneOpts {
  type: OscillatorType;
  f0: number;
  f1?: number;
  dur: number;
  gain: number;
  at?: number;
  /** Fade in over the whole length instead of decaying (for rising whines). */
  swell?: boolean;
}

export class Sfx {
  muted = false;
  /** 0..1, from the settings. */
  volume = 0.8;
  /** Plays through the master volume, past the match's pause. */
  readonly music = new Music();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Everything of the match goes through here, so a pause silences it while menu sounds still play. */
  private game: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly bank = new SoundBank();
  private readonly loops = new Map<string, Loop>();
  private readonly spotOut = { level: 0, muffle: 20000, pan: 0 };
  private voices = 0;
  private readonly last = new Map<string, number>();
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private lyaw = 0;

  /** Browsers only start audio from a click or key press; call this from one. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = this.level();
      const game = ctx.createGain();
      game.connect(master);
      this.game = game;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 8;
      master.connect(limiter).connect(ctx.destination);
      const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.ctx = ctx;
      this.master = master;
      this.noise = noise;
      this.bank.load(ctx);
      this.music.attach(ctx, master);
    } catch {
      // No audio device or a blocked context: the game runs silent.
    }
  }

  /**
   * The match falls silent while it is paused (menu sounds go on); everything
   * stops while the tab is hidden.
   */
  setPaused(paused: boolean, hidden: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (hidden && ctx.state === 'running') void ctx.suspend();
    else if (!hidden && ctx.state === 'suspended') void ctx.resume();
    const want = paused ? 0 : 1;
    if (this.game && this.game.gain.value !== want) this.game.gain.setTargetAtTime(want, ctx.currentTime, 0.03);
  }

  setVolume(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.02);
  }

  private level(): number {
    return this.muted ? 0 : 0.6 * this.volume;
  }

  // ---------------------------------------------------------------- menus

  /** Straight to the master, past the match's pause. */
  private ui(gain: number): AudioNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.master) return null;
    const out = ctx.createGain();
    out.gain.value = gain;
    out.connect(this.master);
    return out;
  }

  /** Focus moved to another control, or a slider stepped. */
  uiMove(): void {
    if (!this.allow('uiMove', 0.03)) return;
    const d = this.ui(0.5);
    if (d) this.tone(d, { type: 'triangle', f0: 1650, dur: 0.035, gain: 0.08 });
  }

  /** A button pressed, a switch flipped. */
  uiSelect(): void {
    const d = this.ui(0.6);
    if (!d) return;
    this.tone(d, { type: 'triangle', f0: 880, f1: 1320, dur: 0.07, gain: 0.12 });
    this.burst(d, { dur: 0.03, type: 'highpass', f0: 4000, gain: 0.05 });
  }

  /** Back out of a screen, or a binding cancelled. */
  uiBack(): void {
    const d = this.ui(0.6);
    if (d) this.tone(d, { type: 'triangle', f0: 990, f1: 620, dur: 0.08, gain: 0.11 });
  }

  /** Waiting for a key to bind. */
  uiListen(): void {
    const d = this.ui(0.5);
    if (!d) return;
    this.tone(d, { type: 'sine', f0: 660, dur: 0.06, gain: 0.1 });
    this.tone(d, { type: 'sine', f0: 660, dur: 0.06, gain: 0.1, at: 0.09 });
  }

  /** A side or a mech frame picked in the hangar: a servo whir that locks with a clunk. */
  uiEquip(): void {
    const d = this.ui(0.7);
    if (!d) return;
    this.tone(d, { type: 'sawtooth', f0: 180, f1: 420, dur: 0.12, gain: 0.05 });
    this.burst(d, { dur: 0.12, type: 'bandpass', f0: 900, f1: 2600, q: 2, gain: 0.06 });
    this.tone(d, { type: 'square', f0: 110, f1: 70, dur: 0.07, gain: 0.09, at: 0.12 });
    this.burst(d, { dur: 0.05, type: 'lowpass', f0: 1400, gain: 0.14, at: 0.12 });
  }

  /** The mech in the hangar preview touches down: a deep, short thud. */
  uiThud(): void {
    if (!this.allow('uiThud', 0.3)) return;
    const d = this.ui(0.8);
    if (!d) return;
    this.tone(d, { type: 'sine', f0: 90, f1: 38, dur: 0.35, gain: 0.3 });
    this.burst(d, { dur: 0.25, type: 'lowpass', f0: 600, f1: 120, gain: 0.25 });
    this.burst(d, { dur: 0.4, type: 'bandpass', f0: 2400, f1: 900, q: 0.6, gain: 0.03, at: 0.03 });
  }

  /** A key bound; `swapped` when another action gave it up. */
  uiBound(swapped: boolean): void {
    const d = this.ui(0.6);
    if (!d) return;
    this.tone(d, { type: 'triangle', f0: 740, dur: 0.06, gain: 0.12 });
    this.tone(d, { type: 'triangle', f0: swapped ? 830 : 1110, dur: 0.09, gain: 0.12, at: 0.06 });
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.lx = x;
    this.ly = y;
    this.lz = z;
    this.lyaw = yaw;
  }

  /** False when this sound played too recently; keeps rapid events from stacking up. */
  private allow(key: string, minGap: number): boolean {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    if (now - (this.last.get(key) ?? -1) < minGap) return false;
    this.last.set(key, now);
    return true;
  }

  /**
   * Where a sound's parts connect: straight to the master for the player's own
   * sounds, or through distance fade, muffling and left/right pan for a place in
   * the world. Null when it would be inaudible.
   */
  private bus(pos: Vec3 | null, gain = 1): AudioNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.voices >= MAX_VOICES) return null;
    const out = ctx.createGain();
    if (!pos) {
      out.gain.value = gain;
      out.connect(this.game!);
      return out;
    }
    const spot = this.spot(pos, gain);
    if (spot.level < 0.012) return null;
    out.gain.value = spot.level;
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = spot.muffle;
    const pan = ctx.createStereoPanner();
    pan.pan.value = spot.pan;
    out.connect(muffle).connect(pan).connect(this.game!);
    return out;
  }

  /** Level, muffling and pan for a sound at `pos` (null: the player's own). The object is reused. */
  private spot(pos: Vec3 | null, gain: number): { level: number; muffle: number; pan: number } {
    const spot = this.spotOut;
    if (!pos) {
      spot.level = gain;
      spot.muffle = 20000;
      spot.pan = 0;
      return spot;
    }
    const dx = pos.x - this.lx;
    const dy = pos.y - this.ly;
    const dz = pos.z - this.lz;
    const d = Math.hypot(dx, dy, dz);
    const flat = Math.hypot(dx, dz) || 1;
    spot.level = gain / (1 + d / 9);
    spot.muffle = 16000 / (1 + d / 18);
    spot.pan = Math.max(-1, Math.min(1, ((dx * Math.cos(this.lyaw) - dz * Math.sin(this.lyaw)) / flat) * 0.85));
    return spot;
  }

  private distance(pos: Vec3): number {
    return Math.hypot(pos.x - this.lx, pos.y - this.ly, pos.z - this.lz);
  }

  /** The player's own sound (`pos` null), or one within `range` metres of the listener. */
  hears(pos: Vec3 | null, range: number): boolean {
    return pos === null || this.distance(pos) <= range;
  }

  /** One take of a recorded sound into `dest`, `at` seconds from now, pitch jittered by ±5%. */
  private play(dest: AudioNode, name: SoundName, gain: number, at = 0, rate = 1): void {
    const buffer = this.bank.pick(name);
    const ctx = this.ctx;
    if (!buffer || !ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate * (0.95 + Math.random() * 0.1);
    const env = ctx.createGain();
    env.gain.value = gain;
    src.connect(env).connect(dest);
    this.voices++;
    src.onended = () => this.voices--;
    src.start(ctx.currentTime + at);
  }

  /**
   * Keeps a looping sound going (a jet pack, a slide) for as long as this is
   * called every frame, following `pos`; `endFrame` fades out those that were not.
   */
  hold(key: string, name: SoundName, pos: Vec3 | null, gain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.game) return;
    const spot = this.spot(pos, gain);
    let loop = this.loops.get(key);
    if (!loop) {
      const buffer = this.bank.pick(name);
      if (!buffer) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      [src.loopStart, src.loopEnd] = this.bank.loopRange(name);
      const out = ctx.createGain();
      out.gain.value = 0;
      const muffle = ctx.createBiquadFilter();
      muffle.type = 'lowpass';
      muffle.frequency.value = spot.muffle;
      const pan = ctx.createStereoPanner();
      pan.pan.value = spot.pan;
      src.connect(out).connect(muffle).connect(pan).connect(this.game);
      // Start somewhere in the loop, so two pilots' jets never phase together.
      src.start(ctx.currentTime, src.loopStart + Math.random() * (src.loopEnd - src.loopStart));
      loop = { src, out, muffle, pan, held: true };
      this.loops.set(key, loop);
    }
    loop.held = true;
    // Eased, so a loop swells in and follows a moving pilot without zipper noise.
    const t = ctx.currentTime;
    loop.out.gain.setTargetAtTime(spot.level, t, 0.04);
    loop.muffle.frequency.setTargetAtTime(spot.muffle, t, 0.04);
    loop.pan.pan.setTargetAtTime(spot.pan, t, 0.04);
  }

  /** Call once a frame after every `hold`: loops nobody held this frame fade out and stop. */
  endFrame(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [key, loop] of this.loops) {
      if (loop.held) {
        loop.held = false;
        continue;
      }
      loop.out.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      loop.src.stop(ctx.currentTime + 0.3);
      this.loops.delete(key);
    }
  }

  private burst(dest: AudioNode, o: BurstOpts): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.Q.value = o.q ?? 0.8;
    filter.frequency.setValueAtTime(o.f0, t);
    if (o.f1) filter.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(o.gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + o.dur);
    src.connect(filter).connect(env).connect(dest);
    this.voices++;
    src.onended = () => this.voices--;
    src.start(t, Math.random() * 1.5);
    src.stop(t + o.dur + 0.02);
  }

  private tone(dest: AudioNode, o: ToneOpts): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.at ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type;
    const jitter = 0.97 + Math.random() * 0.06;
    osc.frequency.setValueAtTime(o.f0 * jitter, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1 * jitter, t + o.dur);
    const env = ctx.createGain();
    if (o.swell) {
      env.gain.setValueAtTime(0.001, t);
      env.gain.exponentialRampToValueAtTime(o.gain, t + o.dur * 0.9);
      env.gain.linearRampToValueAtTime(0, t + o.dur);
    } else {
      env.gain.setValueAtTime(o.gain, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + o.dur);
    }
    osc.connect(env).connect(dest);
    this.voices++;
    osc.onended = () => this.voices--;
    osc.start(t);
    osc.stop(t + o.dur + 0.02);
  }

  /**
   * A gunshot. `pos` null is the player's own weapon. A pilot's guns are
   * recorded: close up the dry crack, far off the take with the room in it,
   * and the heavy ones with a low thump under the crack.
   */
  fire(weapon: string, pos: Vec3 | null): void {
    if (!this.allow(`fire-${weapon}-${pos ? 'far' : 'own'}`, 0.03)) return;
    const b = this.bus(pos, pos ? 1.5 : 0.8);
    if (!b) return;
    const far = pos !== null && this.distance(pos) > FAR_SHOT;
    if (weapon === 'carbine') {
      this.play(b, far ? 'carbine-far' : 'carbine', far ? 0.8 : 0.6);
    } else if (weapon === 'scattergun') {
      this.play(b, far ? 'scattergun-far' : 'scattergun', 0.9);
      if (!far) this.play(b, 'gun-body', 0.55, 0, 0.8);
    } else if (weapon === 'longshot') {
      this.play(b, far ? 'longshot-far' : 'longshot', 0.95);
      if (!far) this.play(b, 'gun-body', 0.6);
    } else if (weapon === 'autocannon') {
      // Slower and far heavier than a carbine: a thump under every round.
      this.burst(b, { type: 'bandpass', f0: 1200, dur: 0.08, gain: 0.7 });
      this.burst(b, { type: 'lowpass', f0: 520, f1: 120, dur: 0.22, gain: 0.8 });
      this.tone(b, { type: 'sine', f0: 92, f1: 36, dur: 0.2, gain: 0.95 });
    } else if (weapon === 'breaker') {
      // Flak: a deep, hollow cough as the shell leaves the tube.
      this.burst(b, { type: 'lowpass', f0: 900, f1: 140, dur: 0.3, gain: 0.9 });
      this.tone(b, { type: 'sine', f0: 70, f1: 30, dur: 0.28, gain: 1 });
      this.burst(b, { type: 'bandpass', f0: 420, q: 3, dur: 0.12, gain: 0.4 });
    } else if (weapon === 'lance') {
      // Rail: a capacitor's snap, the slug's crack, and a ringing tail as the coils cool.
      this.burst(b, { type: 'highpass', f0: 5200, dur: 0.05, gain: 0.8 });
      this.tone(b, { type: 'sawtooth', f0: 1800, f1: 220, dur: 0.22, gain: 0.18 });
      this.burst(b, { type: 'lowpass', f0: 2600, f1: 160, dur: 0.6, gain: 0.7 });
      this.tone(b, { type: 'sine', f0: 3100, f1: 2900, dur: 0.5, gain: 0.05, at: 0.05 });
    } else if (weapon === 'pike') {
      this.rocket(b);
    }
  }

  /** A round striking the map: a chip off concrete, or a ping off steel. */
  impact(pos: Vec3, surface: Surface): void {
    if (!this.allow('impact', 0.045)) return;
    const b = this.bus(pos, 0.9);
    if (b) this.play(b, surface === 'metal' ? 'impact-metal' : 'impact-hard', 0.45, 0, 1 + Math.random() * 0.3);
  }

  /** The player's round landing on an enemy. */
  hit(head: boolean): void {
    if (!this.allow('hit', 0.03)) return;
    const b = this.bus(null, 0.7);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 2400, q: 5, dur: 0.04, gain: 0.7 });
    if (head) {
      this.tone(b, { type: 'triangle', f0: 3100, dur: 0.1, gain: 0.2 });
      this.tone(b, { type: 'triangle', f0: 4650, dur: 0.08, gain: 0.11 });
    }
  }

  kill(): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.burst(b, { type: 'lowpass', f0: 900, dur: 0.12, gain: 0.5 });
    this.tone(b, { type: 'triangle', f0: 1560, dur: 0.18, gain: 0.2, at: 0.03 });
    this.tone(b, { type: 'triangle', f0: 2340, dur: 0.24, gain: 0.13, at: 0.09 });
  }

  /** The player taking damage: a blow on the armour, and a grunt when it hurts (not on every graze). */
  hurt(amount: number): void {
    if (!this.allow('hurt', 0.07)) return;
    const b = this.bus(null, 0.9);
    if (!b) return;
    this.play(b, 'hurt', Math.min(0.9, 0.4 + amount / 60));
    if (amount >= 20 && this.allow('voice', 1.2)) this.play(b, 'voice-pain', 0.5, 0.04);
  }

  death(): void {
    const b = this.bus(null, 0.9);
    if (!b) return;
    this.play(b, 'land-heavy', 0.8);
    this.play(b, 'voice-death', 0.7, 0.03);
  }

  /** Another pilot dying where the player can hear it. */
  deathCry(pos: Vec3): void {
    if (!this.allow('cry', 0.3)) return;
    const b = this.bus(pos, 1.4);
    if (b) this.play(b, 'voice-death', 0.6);
  }

  /**
   * A pilot's arm weapon is out of cooling: the spent cell is thrown out with a
   * clunk and the housing vents for about a second.
   */
  ventOut(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.play(b, 'clunk', 0.7);
    this.play(b, 'vent-hiss', 0.5, 0.06);
  }

  /** The fresh cell slides home and locks; the weapon hums back up. */
  cellIn(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.play(b, 'slide-in', 0.5);
    this.play(b, 'click', 0.7, 0.06);
    this.play(b, 'servo-up', 0.12, 0.05);
  }

  /** The shoulder pod tips back and takes two rockets, one after the other, within `duration`. */
  podLoad(duration: number): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.play(b, 'swing', 0.35, 0, 1.2);
    for (const share of [0.45, 0.8]) {
      this.play(b, 'slide-in', 0.4, duration * share - 0.12);
      this.play(b, 'lock-heavy', 0.6, duration * share);
    }
  }

  /** The pod is level again and armed. */
  podReady(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.play(b, 'click', 0.6);
    this.play(b, 'lock-light', 0.4, 0.04);
  }

  /** Magazine out (the mech's cannon). */
  reloadOut(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 1300, q: 3, dur: 0.035, gain: 0.5 });
    this.burst(b, { type: 'bandpass', f0: 700, q: 2, dur: 0.06, gain: 0.35, at: 0.09 });
  }

  /** Magazine in and bolt forward (the mech's cannon). */
  reloadIn(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 1700, q: 4, dur: 0.03, gain: 0.55 });
    this.burst(b, { type: 'bandpass', f0: 2600, q: 5, dur: 0.03, gain: 0.45, at: 0.07 });
  }

  /** Trigger pulled with nothing to fire. `overheat`: a pilot's arm with a full cell, which refuses with a buzz. */
  dry(overheat = false): void {
    const b = this.bus(null, 0.5);
    if (!b) return;
    this.play(b, 'dry-click', 0.7);
    if (overheat) this.play(b, 'servo-down', 0.25, 0.02, 0.8);
  }

  /**
   * Changing weapons, in time with what the player sees (render/armGun). The
   * arm's barrel draws in on a falling servo, the printer whirs as it makes the
   * next one, and each barrel locks with its own sound: the scattergun with two
   * heavy clacks and a thump, the carbine with a run of crisp clicks, the
   * longshot with a rising charge and a deep clank. The shoulder pod swings up
   * on its hinge; a mech readies its cannon.
   */
  equip(mount: 'arm' | 'shoulder' | 'cannon', weapon = '', duration = 0.4): void {
    const b = this.bus(null, 0.5);
    if (!b) return;
    if (mount === 'arm') {
      const d = Math.max(0.25, duration);
      const printAt = d * 0.3;
      const lockAt = d;
      this.play(b, 'servo-down', 0.2);
      this.play(b, 'lock-light', 0.35, printAt - 0.02);
      this.play(b, 'printer', 0.3, printAt);
      if (weapon === 'scattergun') {
        this.play(b, 'lock-heavy', 0.6, lockAt - 0.07);
        this.play(b, 'lock-heavy', 0.75, lockAt, 0.85);
      } else if (weapon === 'longshot') {
        this.play(b, 'servo-up', 0.18, d * 0.55, 0.8);
        this.play(b, 'lock-heavy', 0.8, lockAt, 0.75);
      } else {
        for (const at of [lockAt - 0.06, lockAt - 0.03, lockAt]) this.play(b, 'click', 0.45, at, 1.2);
      }
    } else if (mount === 'shoulder') {
      this.play(b, 'swing', 0.45);
      this.play(b, 'lock-heavy', 0.6, 0.3);
    } else {
      this.burst(b, { type: 'bandpass', f0: 500, f1: 1900, q: 1.5, dur: 0.15, gain: 0.4 });
    }
  }

  // ---------------------------------------------------------------- pilot movement
  // `pos` null is the player's own pilot. Remote pilots are mixed louder than
  // the distance fade alone would leave them: hearing an enemy coming is a
  // big part of the game.

  /**
   * A footfall: the boot on the surface, and close up the suit's gear and the
   * grit of a sprint; `weight` (0..1) grows with speed.
   */
  step(pos: Vec3 | null, surface: Surface, weight: number): void {
    const b = this.bus(pos, pos ? 1.6 : 0.5);
    if (!b) return;
    this.play(b, surface === 'metal' ? 'step-metal' : 'step-hard', 0.35 + 0.4 * weight);
    if (!this.hears(pos, 10)) return;
    this.play(b, 'step-gear', 0.15 + 0.2 * weight);
    if (surface === 'hard' && weight > 0.7) this.play(b, 'step-grit', 0.12);
  }

  /** A push off the ground or off a wall. */
  jump(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 1.6 : 0.5);
    if (!b) return;
    this.play(b, 'jump', 0.35);
    this.play(b, 'step-gear', 0.35);
  }

  /** Back on the ground; `impact` (0..1) is how hard, from the speed of the fall. */
  land(pos: Vec3 | null, impact: number, surface: Surface): void {
    const b = this.bus(pos, pos ? 1.8 : 0.6);
    if (!b) return;
    this.play(b, 'land', 0.3 + 0.5 * impact);
    this.play(b, surface === 'metal' ? 'step-metal' : 'step-hard', 0.6);
    this.play(b, 'step-gear', 0.4);
    if (impact > 0.5) this.play(b, 'land-heavy', impact * 0.6);
  }

  /** Feet onto a wall to run along it. */
  wallGrab(pos: Vec3 | null, surface: Surface): void {
    const b = this.bus(pos, pos ? 1.6 : 0.5);
    if (!b) return;
    this.play(b, surface === 'metal' ? 'step-metal' : 'step-hard', 0.6, 0, 1.1);
    this.play(b, 'step-gear', 0.35);
  }

  /** Hands on a ledge, hauling up. */
  mantle(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 1.6 : 0.5);
    if (!b) return;
    this.play(b, 'lock-light', 0.3, 0, 0.8);
    this.play(b, 'step-gear', 0.45, 0.08);
  }

  /** Dropping into a slide: grit spraying. The scrape itself is held while it lasts. */
  slideStart(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 1.6 : 0.5);
    if (b) this.play(b, 'slide-start', 0.45);
  }

  /** A jet pack lighting: a burst of air before the roar, which is held while it burns. */
  jetIgnite(pos: Vec3 | null): void {
    if (!this.allow(`jet-${pos ? 'far' : 'own'}`, 0.08)) return;
    const b = this.bus(pos, pos ? 2 : 0.6);
    if (b) this.play(b, 'jet-ignite', 0.45);
  }

  /** An enemy bot spotting the player. */
  notice(pos: Vec3): void {
    if (!this.allow('notice', 0.15)) return;
    const b = this.bus(pos, 1.6);
    if (!b) return;
    this.tone(b, { type: 'triangle', f0: 1100, dur: 0.06, gain: 0.3 });
    this.tone(b, { type: 'triangle', f0: 1480, dur: 0.09, gain: 0.3, at: 0.07 });
  }

  /** A marksman lining up a shot: a whine that rises for exactly as long as the wind-up. */
  charge(pos: Vec3, duration: number, atMe: boolean): void {
    const b = this.bus(pos, atMe ? 2.2 : 1);
    if (b) this.tone(b, { type: 'sawtooth', f0: 260, f1: 1500, dur: duration, gain: 0.16, swell: true });
  }

  /** A rocket leaving its tube: a thump, then the motor catching. */
  private rocket(b: AudioNode): void {
    this.play(b, 'rocket-launch', 0.9);
    this.play(b, 'rocket-motor', 0.5, 0.03);
  }

  /** One rocket of a mech's salvo. `pos` null is the player's own mech. */
  launch(pos: Vec3 | null): void {
    if (!this.allow(`launch-${pos ? 'far' : 'own'}`, 0.05)) return;
    const b = this.bus(pos, pos ? 1.8 : 0.7);
    if (b) this.rocket(b);
  }

  /** A rocket bursting. Far ones are a dull thud; near ones crack first. */
  explosion(pos: Vec3, big = false): void {
    if (!this.allow('explosion', 0.04)) return;
    const b = this.bus(pos, big ? 5 : 3.2);
    if (!b) return;
    // The crack fades with distance faster than the rumble does.
    const near = Math.max(0, 1 - this.distance(pos) / 60);
    this.play(b, 'blast', 0.35 + 0.5 * near);
    this.play(b, 'blast-body', 0.7, 0, big ? 0.8 : 1);
    this.play(b, 'blast-low', big ? 1 : 0.8, 0, big ? 0.85 : 1);
  }

  /** A flak shell bursting: a sharp crack with little body, far smaller than a rocket. */
  flakBurst(pos: Vec3): void {
    if (!this.allow('flak', 0.04)) return;
    const b = this.bus(pos, 2.2);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 3400, dur: 0.04, gain: 0.8 });
    this.burst(b, { type: 'lowpass', f0: 2200, f1: 260, dur: 0.3, gain: 0.7 });
    this.tone(b, { type: 'sine', f0: 140, f1: 50, dur: 0.18, gain: 0.5 });
  }

  /** The mech frame for the next call changed: a short rising chirp, higher for each frame in the list. */
  frameSelect(index: number): void {
    const b = this.bus(null, 0.7);
    if (!b) return;
    const f = 520 * Math.pow(1.26, index);
    this.tone(b, { type: 'square', f0: f, dur: 0.05, gain: 0.1 });
    this.tone(b, { type: 'square', f0: f * 1.5, dur: 0.08, gain: 0.1, at: 0.06 });
  }

  /** Jump jets: a roar that climbs, under a hiss. */
  leap(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 3 : 0.8);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 600, f1: 2400, q: 0.7, dur: 0.6, gain: 0.8 });
    this.tone(b, { type: 'sawtooth', f0: 90, f1: 180, dur: 0.5, gain: 0.12 });
    this.burst(b, { type: 'highpass', f0: 3000, dur: 0.35, gain: 0.25 });
  }

  /** The stomp: a ground-shaking thump and the crack of concrete. */
  stomp(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 5 : 1);
    if (!b) return;
    this.tone(b, { type: 'sine', f0: 58, f1: 22, dur: 0.7, gain: 1 });
    this.burst(b, { type: 'lowpass', f0: 1200, f1: 70, dur: 0.6, gain: 1 });
    this.burst(b, { type: 'bandpass', f0: 2600, q: 1.5, dur: 0.18, gain: 0.45, at: 0.03 });
    // Grit falling back.
    this.burst(b, { type: 'highpass', f0: 4200, dur: 0.5, gain: 0.12, at: 0.15 });
  }

  /** The shield coming up (a rising hum) or going down (falling). */
  shield(pos: Vec3 | null, up: boolean): void {
    if (!this.allow(`shield-${pos ? 'far' : 'own'}`, 0.1)) return;
    const b = this.bus(pos, pos ? 2 : 0.7);
    if (!b) return;
    this.tone(b, { type: 'sawtooth', f0: up ? 110 : 330, f1: up ? 330 : 90, dur: 0.25, gain: 0.12 });
    this.tone(b, { type: 'sine', f0: up ? 440 : 880, f1: up ? 880 : 300, dur: 0.22, gain: 0.15 });
    this.burst(b, { type: 'bandpass', f0: up ? 1500 : 3000, f1: up ? 3000 : 1200, q: 3, dur: 0.2, gain: 0.15 });
  }

  /** Fire stopped by a shield: a bright electric zap; a heavier crack when it was the last of it. */
  shieldHit(pos: Vec3 | null, broken: boolean): void {
    if (!broken && !this.allow(`shieldHit-${pos ? 'far' : 'own'}`, 0.05)) return;
    const b = this.bus(pos, pos ? 1.6 : 0.5);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 3800, q: 4, dur: 0.06, gain: 0.6 });
    this.tone(b, { type: 'square', f0: 1300 + Math.random() * 300, f1: 600, dur: 0.06, gain: 0.06 });
  }

  /** The shield gives out: a glassy shatter and the generator winding down. */
  shieldBreak(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 3 : 0.9);
    if (!b) return;
    this.burst(b, { type: 'highpass', f0: 2800, dur: 0.5, gain: 0.7 });
    this.burst(b, { type: 'bandpass', f0: 4500, f1: 1500, q: 2, dur: 0.4, gain: 0.4 });
    this.tone(b, { type: 'sawtooth', f0: 400, f1: 50, dur: 0.8, gain: 0.15 });
  }

  /** The cloak: a soft rushing fade going under, a shimmering ping coming back out. */
  cloak(pos: Vec3 | null, on: boolean): void {
    const b = this.bus(pos, pos ? 2.2 : 0.7);
    if (!b) return;
    if (on) {
      this.burst(b, { type: 'bandpass', f0: 3000, f1: 400, q: 1.2, dur: 0.6, gain: 0.35 });
      this.tone(b, { type: 'sine', f0: 1200, f1: 300, dur: 0.6, gain: 0.08 });
    } else {
      this.burst(b, { type: 'bandpass', f0: 400, f1: 3200, q: 1.2, dur: 0.35, gain: 0.35 });
      this.tone(b, { type: 'triangle', f0: 1400, f1: 2100, dur: 0.18, gain: 0.1 });
    }
  }

  /** The mech meter is full. */
  meterReady(): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    [523, 784, 1047].forEach((f, i) => this.tone(b, { type: 'triangle', f0: f, dur: 0.22, gain: 0.22, at: i * 0.09 }));
    this.burst(b, { type: 'bandpass', f0: 300, f1: 1800, q: 2, dur: 0.3, gain: 0.25 });
  }

  /** The call went out: a radio blip and a confirming tone. */
  mechCall(): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 2200, q: 6, dur: 0.05, gain: 0.5 });
    this.tone(b, { type: 'square', f0: 660, dur: 0.07, gain: 0.12, at: 0.06 });
    this.tone(b, { type: 'square', f0: 990, dur: 0.12, gain: 0.12, at: 0.15 });
  }

  /** The call (or another mech action) was refused. */
  denied(): void {
    if (!this.allow('denied', 0.25)) return;
    const b = this.bus(null, 0.7);
    if (!b) return;
    this.tone(b, { type: 'square', f0: 160, dur: 0.09, gain: 0.2 });
    this.tone(b, { type: 'square', f0: 120, dur: 0.14, gain: 0.2, at: 0.11 });
  }

  /** A mech falling from the sky: a whistle that drops for exactly as long as the fall. */
  dropWhistle(pos: Vec3, duration: number, hostile: boolean): void {
    const b = this.bus(pos, hostile ? 5 : 3.5);
    if (!b) return;
    this.tone(b, { type: 'sawtooth', f0: 2400, f1: 320, dur: duration, gain: 0.14, swell: true });
    this.burst(b, { type: 'bandpass', f0: 3000, f1: 500, q: 1.5, dur: duration, gain: 0.22 });
  }

  /** It lands. The loudest thing in the match. */
  mechLand(pos: Vec3): void {
    const b = this.bus(pos, 6);
    if (!b) return;
    this.tone(b, { type: 'sine', f0: 70, f1: 22, dur: 1.1, gain: 1 });
    this.burst(b, { type: 'lowpass', f0: 1400, f1: 70, dur: 1.2, gain: 1 });
    this.burst(b, { type: 'bandpass', f0: 900, q: 6, dur: 0.12, gain: 0.6 });
    this.tone(b, { type: 'triangle', f0: 310, f1: 180, dur: 0.5, gain: 0.25, at: 0.03 });
  }

  /** Climbing in: the hatch servo and the seal. */
  embark(): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.tone(b, { type: 'sawtooth', f0: 110, f1: 260, dur: 0.4, gain: 0.12 });
    this.burst(b, { type: 'bandpass', f0: 700, q: 3, dur: 0.07, gain: 0.6, at: 0.42 });
    this.burst(b, { type: 'highpass', f0: 3800, dur: 0.3, gain: 0.2, at: 0.45 });
  }

  /** Start-up finished: the reactor spools and the controls go live. */
  mechOnline(): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.tone(b, { type: 'sawtooth', f0: 70, f1: 210, dur: 0.5, gain: 0.16, swell: true });
    this.tone(b, { type: 'triangle', f0: 880, dur: 0.1, gain: 0.2, at: 0.4 });
    this.tone(b, { type: 'triangle', f0: 1320, dur: 0.18, gain: 0.2, at: 0.5 });
  }

  /** Out through the hatch; thrown clear with a bang when the mech is lost. */
  disembark(eject: boolean): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.burst(b, { type: 'highpass', f0: 3200, dur: 0.25, gain: 0.3 });
    this.burst(b, { type: 'bandpass', f0: 600, q: 3, dur: 0.06, gain: 0.5 });
    if (!eject) return;
    this.tone(b, { type: 'sine', f0: 160, f1: 50, dur: 0.25, gain: 0.8 });
    this.burst(b, { type: 'bandpass', f0: 400, f1: 3200, q: 1.2, dur: 0.7, gain: 0.5, at: 0.04 });
  }

  /** A mech's footfall. `pos` null is the player's own. */
  mechStep(pos: Vec3 | null, heavy: boolean): void {
    if (!this.allow(`step-${pos ? 'far' : 'own'}`, 0.12)) return;
    const b = this.bus(pos, (pos ? 3 : 0.6) * (heavy ? 1.6 : 1));
    if (!b) return;
    this.tone(b, { type: 'sine', f0: heavy ? 60 : 74, f1: 30, dur: heavy ? 0.5 : 0.24, gain: 0.9 });
    this.burst(b, { type: 'lowpass', f0: 700, f1: 120, dur: heavy ? 0.5 : 0.2, gain: 0.6 });
    // The leg servo, a moment after the foot is down.
    this.tone(b, { type: 'sawtooth', f0: 180, f1: 120, dur: 0.16, gain: 0.04, at: 0.1 });
  }

  /** A mech's dash thrusters. */
  mechDash(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 3 : 0.8);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 2400, f1: 420, q: 0.8, dur: 0.45, gain: 0.8 });
    this.tone(b, { type: 'sawtooth', f0: 220, f1: 70, dur: 0.4, gain: 0.14 });
  }

  /** A dash that ran into something: metal on metal, or metal on a pilot. */
  ram(pos: Vec3): void {
    const b = this.bus(pos, 3.5);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 520, q: 5, dur: 0.16, gain: 0.9 });
    this.tone(b, { type: 'sine', f0: 110, f1: 40, dur: 0.25, gain: 0.9 });
    this.burst(b, { type: 'highpass', f0: 2800, dur: 0.08, gain: 0.3 });
  }

  /** The player's fire striking a mech: a clank, with a bright ring for the vent. */
  armorHit(crit: boolean): void {
    if (!this.allow('armor', 0.035)) return;
    const b = this.bus(null, 0.7);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 1150, q: 9, dur: 0.07, gain: 0.8 });
    this.tone(b, { type: 'triangle', f0: 640, dur: 0.06, gain: 0.14 });
    if (crit) {
      this.tone(b, { type: 'triangle', f0: 2100, dur: 0.14, gain: 0.2 });
      this.tone(b, { type: 'triangle', f0: 3150, dur: 0.1, gain: 0.12 });
    }
  }

  /** The player's own mech taking a hit, heard from inside. */
  hullHit(amount: number): void {
    if (!this.allow('hull', 0.06)) return;
    const b = this.bus(null, Math.min(1.1, 0.5 + amount / 300));
    if (!b) return;
    this.tone(b, { type: 'sine', f0: 130, f1: 60, dur: 0.2, gain: 0.7 });
    this.burst(b, { type: 'bandpass', f0: 380, q: 6, dur: 0.14, gain: 0.7 });
  }

  /** Hull nearly gone: two notes, repeated by the caller while it lasts. */
  hullAlarm(): void {
    if (!this.allow('alarm', 1.1)) return;
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.tone(b, { type: 'square', f0: 740, dur: 0.12, gain: 0.1 });
    this.tone(b, { type: 'square', f0: 554, dur: 0.16, gain: 0.1, at: 0.16 });
  }

  /** Standing where an enemy mech is about to land. */
  zoneWarn(): void {
    if (!this.allow('zone', 0.3)) return;
    const b = this.bus(null, 0.7);
    if (b) this.tone(b, { type: 'square', f0: 1240, dur: 0.09, gain: 0.14 });
  }

  /** A mech blowing apart. */
  mechDestroyed(pos: Vec3): void {
    const b = this.bus(pos, 6);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 2200, dur: 0.07, gain: 0.9 });
    this.burst(b, { type: 'lowpass', f0: 2200, f1: 60, dur: 1.8, gain: 1 });
    this.tone(b, { type: 'sine', f0: 84, f1: 20, dur: 1.3, gain: 1 });
    // Bits of it coming down.
    for (let i = 0; i < 4; i++) this.burst(b, { type: 'bandpass', f0: 700 + i * 350, q: 5, dur: 0.07, gain: 0.3, at: 0.35 + i * 0.17 });
  }

  /** Something in a burning wreck cooking off: a muffled pop and a short crackle. */
  cookOff(pos: Vec3): void {
    if (!this.allow('cookoff', 0.15)) return;
    const b = this.bus(pos, 2);
    if (!b) return;
    this.burst(b, { type: 'lowpass', f0: 1400, f1: 120, dur: 0.35, gain: 0.8 });
    this.tone(b, { type: 'sine', f0: 120, f1: 45, dur: 0.22, gain: 0.6 });
    for (let i = 0; i < 3; i++) this.burst(b, { type: 'bandpass', f0: 1800 + i * 900, q: 4, dur: 0.04, gain: 0.25, at: 0.08 + i * 0.07 + Math.random() * 0.04 });
  }

  spawn(): void {
    const b = this.bus(null, 0.5);
    if (b) this.burst(b, { type: 'bandpass', f0: 300, f1: 2600, q: 2, dur: 0.38, gain: 0.4 });
  }
}
