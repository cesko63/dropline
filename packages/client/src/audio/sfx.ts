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
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
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
      master.gain.value = this.muted ? 0 : 0.5;
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

  /** Silence everything while the game is paused or the tab is hidden. */
  setPaused(paused: boolean): void {
    if (!this.ctx) return;
    if (paused && this.ctx.state === 'running') void this.ctx.suspend();
    else if (!paused && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.02);
    return this.muted;
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
      out.connect(this.master);
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
    out.connect(muffle).connect(pan).connect(this.master);
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

  /** Magazine out. */
  reloadOut(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 1300, q: 3, dur: 0.035, gain: 0.5 });
    this.burst(b, { type: 'bandpass', f0: 700, q: 2, dur: 0.06, gain: 0.35, at: 0.09 });
  }

  /** Magazine in and bolt forward. */
  reloadIn(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.burst(b, { type: 'bandpass', f0: 1700, q: 4, dur: 0.03, gain: 0.55 });
    this.burst(b, { type: 'bandpass', f0: 2600, q: 5, dur: 0.03, gain: 0.45, at: 0.07 });
  }

  /** Trigger pulled on an empty magazine. */
  dry(): void {
    const b = this.bus(null, 0.5);
    if (b) this.burst(b, { type: 'bandpass', f0: 4000, q: 4, dur: 0.02, gain: 0.5 });
  }

  equip(): void {
    const b = this.bus(null, 0.5);
    if (b) this.burst(b, { type: 'bandpass', f0: 500, f1: 1900, q: 1.5, dur: 0.15, gain: 0.4 });
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
