import type { Vec3 } from '@dropline/shared';

/**
 * Sound effects. Every sound here is a synthesized STAND-IN built from filtered
 * noise and short tones, so the game has timing and feedback before recorded
 * audio exists. Replace each method's body with sample playback later; callers
 * will not change.
 */

const MAX_VOICES = 48;

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
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Everything of the match goes through here, so a pause silences it while menu sounds still play. */
  private game: GainNode | null = null;
  private noise: AudioBuffer | null = null;
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
    const dx = pos.x - this.lx;
    const dy = pos.y - this.ly;
    const dz = pos.z - this.lz;
    const d = Math.hypot(dx, dy, dz);
    const level = gain / (1 + d / 9);
    if (level < 0.012) return null;
    out.gain.value = level;
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 16000 / (1 + d / 18);
    const pan = ctx.createStereoPanner();
    const flat = Math.hypot(dx, dz) || 1;
    pan.pan.value = Math.max(-1, Math.min(1, ((dx * Math.cos(this.lyaw) - dz * Math.sin(this.lyaw)) / flat) * 0.85));
    out.connect(muffle).connect(pan).connect(this.game!);
    return out;
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

  /** A gunshot. `pos` null is the player's own weapon. */
  fire(weapon: string, pos: Vec3 | null): void {
    if (!this.allow(`fire-${weapon}-${pos ? 'far' : 'own'}`, 0.03)) return;
    const b = this.bus(pos, pos ? 1.5 : 0.8);
    if (!b) return;
    if (weapon === 'scattergun') {
      this.burst(b, { type: 'lowpass', f0: 2400, f1: 260, dur: 0.34, gain: 0.95 });
      this.burst(b, { type: 'bandpass', f0: 900, dur: 0.1, gain: 0.5 });
      this.tone(b, { type: 'sine', f0: 115, f1: 34, dur: 0.26, gain: 0.8 });
    } else if (weapon === 'autocannon') {
      // Slower and far heavier than a carbine: a thump under every round.
      this.burst(b, { type: 'bandpass', f0: 1200, dur: 0.08, gain: 0.7 });
      this.burst(b, { type: 'lowpass', f0: 520, f1: 120, dur: 0.22, gain: 0.8 });
      this.tone(b, { type: 'sine', f0: 92, f1: 36, dur: 0.2, gain: 0.95 });
    } else if (weapon === 'pike') {
      this.rocket(b);
    } else if (weapon === 'longshot') {
      this.burst(b, { type: 'bandpass', f0: 2800, dur: 0.06, gain: 0.7 });
      this.burst(b, { type: 'lowpass', f0: 1500, f1: 180, dur: 0.55, gain: 0.6 });
      this.tone(b, { type: 'sine', f0: 190, f1: 42, dur: 0.3, gain: 0.7 });
    } else {
      this.burst(b, { type: 'bandpass', f0: 1900, dur: 0.07, gain: 0.55 });
      this.burst(b, { type: 'lowpass', f0: 700, f1: 240, dur: 0.14, gain: 0.5 });
      this.tone(b, { type: 'sine', f0: 150, f1: 55, dur: 0.09, gain: 0.5 });
    }
  }

  /** A round striking the map. */
  impact(pos: Vec3): void {
    if (!this.allow('impact', 0.045)) return;
    const b = this.bus(pos, 0.9);
    if (b) this.burst(b, { type: 'bandpass', f0: 3200, q: 2, dur: 0.045, gain: 0.4 });
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

  /** The player taking damage. */
  hurt(): void {
    if (!this.allow('hurt', 0.07)) return;
    const b = this.bus(null, 0.9);
    if (!b) return;
    this.tone(b, { type: 'sine', f0: 96, f1: 44, dur: 0.16, gain: 0.7 });
    this.burst(b, { type: 'lowpass', f0: 520, dur: 0.1, gain: 0.45 });
  }

  death(): void {
    const b = this.bus(null, 0.9);
    if (!b) return;
    this.tone(b, { type: 'sine', f0: 220, f1: 38, dur: 0.75, gain: 0.5 });
    this.burst(b, { type: 'lowpass', f0: 420, f1: 80, dur: 0.75, gain: 0.4 });
  }

  /**
   * A pilot's arm weapon is out of cooling: the spent cell is thrown out with a
   * clunk and the housing vents for about a second.
   */
  ventOut(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 900, q: 4, dur: 0.05, gain: 0.6 });
    this.tone(b, { type: 'triangle', f0: 520, f1: 210, dur: 0.12, gain: 0.12, at: 0.02 });
    this.burst(b, { type: 'highpass', f0: 5200, f1: 2600, dur: 0.95, gain: 0.3, at: 0.08 });
    this.burst(b, { type: 'bandpass', f0: 2400, f1: 900, q: 1.2, dur: 0.7, gain: 0.16, at: 0.1 });
  }

  /** The fresh cell slides home and locks; the weapon hums back up. */
  cellIn(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 1500, q: 5, dur: 0.035, gain: 0.6 });
    this.burst(b, { type: 'bandpass', f0: 2900, q: 6, dur: 0.03, gain: 0.45, at: 0.06 });
    this.tone(b, { type: 'sine', f0: 380, f1: 920, dur: 0.16, gain: 0.1, at: 0.05 });
  }

  /** The shoulder pod tips back and takes two rockets, one after the other, within `duration`. */
  podLoad(duration: number): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.tone(b, { type: 'sawtooth', f0: 90, f1: 150, dur: 0.3, gain: 0.07 });
    for (const share of [0.45, 0.8]) {
      this.burst(b, { type: 'bandpass', f0: 420, q: 4, dur: 0.09, gain: 0.7, at: duration * share });
      this.tone(b, { type: 'sine', f0: 130, f1: 70, dur: 0.12, gain: 0.4, at: duration * share });
    }
  }

  /** The pod is level again and armed. */
  podReady(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 800, q: 4, dur: 0.05, gain: 0.5 });
    this.tone(b, { type: 'triangle', f0: 990, dur: 0.09, gain: 0.14, at: 0.04 });
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
    this.burst(b, { type: 'bandpass', f0: 4000, q: 4, dur: 0.02, gain: 0.5 });
    if (overheat) this.tone(b, { type: 'square', f0: 210, f1: 150, dur: 0.09, gain: 0.1 });
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
      this.tone(b, { type: 'sawtooth', f0: 480, f1: 170, dur: printAt, gain: 0.04 });
      this.burst(b, { type: 'bandpass', f0: 1800, q: 6, dur: 0.025, gain: 0.45, at: printAt - 0.02 });
      this.burst(b, { type: 'bandpass', f0: 900, f1: 5200, q: 2.5, dur: d * 0.25, gain: 0.22, at: printAt });
      this.tone(b, { type: 'sine', f0: 900, f1: 1900, dur: d * 0.25, gain: 0.025, at: printAt });
      if (weapon === 'scattergun') {
        this.burst(b, { type: 'bandpass', f0: 950, q: 5, dur: 0.045, gain: 0.7, at: lockAt - 0.07 });
        this.burst(b, { type: 'bandpass', f0: 760, q: 5, dur: 0.05, gain: 0.8, at: lockAt });
        this.tone(b, { type: 'sine', f0: 130, f1: 60, dur: 0.13, gain: 0.32, at: lockAt });
      } else if (weapon === 'longshot') {
        this.tone(b, { type: 'sine', f0: 420, f1: 2400, dur: d * 0.45, gain: 0.05, swell: true, at: d * 0.55 });
        this.burst(b, { type: 'bandpass', f0: 680, q: 4, dur: 0.07, gain: 0.8, at: lockAt });
        this.tone(b, { type: 'sine', f0: 95, f1: 48, dur: 0.2, gain: 0.34, at: lockAt });
      } else {
        for (const at of [lockAt - 0.06, lockAt - 0.03, lockAt]) this.burst(b, { type: 'bandpass', f0: 2700, q: 7, dur: 0.02, gain: 0.5, at });
        this.tone(b, { type: 'square', f0: 700, f1: 1500, dur: 0.06, gain: 0.035, at: lockAt - 0.04 });
      }
    } else if (mount === 'shoulder') {
      this.tone(b, { type: 'sawtooth', f0: 120, f1: 210, dur: 0.34, gain: 0.07 });
      this.burst(b, { type: 'bandpass', f0: 520, q: 4, dur: 0.07, gain: 0.7, at: 0.3 });
      this.tone(b, { type: 'sine', f0: 150, f1: 80, dur: 0.1, gain: 0.3, at: 0.3 });
    } else {
      this.burst(b, { type: 'bandpass', f0: 500, f1: 1900, q: 1.5, dur: 0.15, gain: 0.4 });
    }
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
    this.tone(b, { type: 'sine', f0: 140, f1: 48, dur: 0.18, gain: 0.8 });
    this.burst(b, { type: 'bandpass', f0: 500, f1: 2600, q: 0.9, dur: 0.5, gain: 0.6 });
    this.burst(b, { type: 'lowpass', f0: 900, f1: 200, dur: 0.6, gain: 0.35, at: 0.04 });
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
    this.burst(b, { type: 'bandpass', f0: 2600, dur: 0.05, gain: 0.8 });
    this.burst(b, { type: 'lowpass', f0: 1800, f1: 90, dur: big ? 1.3 : 0.7, gain: 1 });
    this.tone(b, { type: 'sine', f0: big ? 78 : 96, f1: 24, dur: big ? 0.9 : 0.5, gain: 1 });
    if (big) this.burst(b, { type: 'bandpass', f0: 420, f1: 140, q: 2, dur: 1.5, gain: 0.5, at: 0.12 });
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

  spawn(): void {
    const b = this.bus(null, 0.5);
    if (b) this.burst(b, { type: 'bandpass', f0: 300, f1: 2600, q: 2, dur: 0.38, gain: 0.4 });
  }

  matchEnd(won: boolean): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    const notes = won ? [660, 880, 1320] : [440, 349, 262];
    notes.forEach((f, i) => this.tone(b, { type: 'triangle', f0: f, dur: 0.45, gain: 0.25, at: i * 0.16 }));
  }
}
