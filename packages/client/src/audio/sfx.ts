import type { Vec3 } from '@dropline/shared';
import { SoundBank, type SoundName } from './bank';
import type { Surface } from './surfaces';

/**
 * Sound effects. Pilots and mechs (movement, weapons, impacts, abilities, the
 * call-in, hurt, death and wrecks), the menus, the HUD and its alerts all play
 * recorded takes from the sound bank, a random take each time with a little
 * pitch jitter.
 */

const MAX_VOICES = 48;
/** Voices kept back for the player's own sounds, so a crowded fight never drowns out their own actions. */
const OWN_VOICES = 12;

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

/** A lighter frame's feet land higher and quicker, a heavier one's lower. */
const STRIDE_PITCH: Record<string, number> = { lynx: 1.2, halberd: 1, bastion: 0.82 };

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

  /** Focus moved to another control, a button hovered, or a slider stepped. */
  uiMove(): void {
    if (!this.allow('uiMove', 0.03)) return;
    const d = this.ui(0.35);
    if (d) this.play(d, 'ui-move', 0.6);
  }

  /** A button pressed, a switch flipped. */
  uiSelect(): void {
    const d = this.ui(0.5);
    if (d) this.play(d, 'ui-select', 0.8);
  }

  /** Back out of a screen, or a binding cancelled. */
  uiBack(): void {
    const d = this.ui(0.5);
    if (d) this.play(d, 'ui-back', 0.8);
  }

  /** A screen opens over the menu (settings, hangar): a press and a rising sweep. */
  uiOpen(): void {
    const d = this.ui(0.5);
    if (!d) return;
    this.play(d, 'ui-select', 0.7);
    this.play(d, 'ui-open', 0.45, 0.03);
  }

  /** That screen closes again: a falling sweep under the back click. */
  uiClose(): void {
    const d = this.ui(0.5);
    if (!d) return;
    this.play(d, 'ui-back', 0.7);
    this.play(d, 'ui-close', 0.4, 0.02);
  }

  /** Waiting for a key to bind. */
  uiListen(): void {
    const d = this.ui(0.45);
    if (d) this.play(d, 'ui-listen', 0.7);
  }

  /** A side or a mech frame picked in the hangar: a servo whir that locks with a clunk. */
  uiEquip(): void {
    const d = this.ui(0.6);
    if (!d) return;
    this.play(d, 'servo-up', 0.35, 0, 1.1);
    this.play(d, 'lock-heavy', 0.8, 0.12);
    this.play(d, 'ui-select', 0.4, 0.12);
  }

  /** The mech in the hangar preview touches down: a deep, short thud. */
  uiThud(): void {
    if (!this.allow('uiThud', 0.3)) return;
    const d = this.ui(0.7);
    if (!d) return;
    this.play(d, 'land-heavy', 0.8, 0, 0.7);
    this.play(d, 'blast-low', 0.35, 0, 1.3);
  }

  /** A key bound; `swapped` when another action gave it up, which sounds lower. */
  uiBound(swapped: boolean): void {
    const d = this.ui(0.5);
    if (d) this.play(d, 'ui-confirm', 0.7, 0, swapped ? 0.8 : 1);
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
    if (!ctx || !this.master || this.voices >= MAX_VOICES + (pos ? 0 : OWN_VOICES)) return null;
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
   * A looping sound played once for `duration` seconds, swelling in while its
   * pitch glides from `rate0` to `rate1`.
   */
  private sweep(dest: AudioNode, name: SoundName, gain: number, duration: number, rate0: number, rate1: number): void {
    const buffer = this.bank.pick(name);
    const ctx = this.ctx;
    if (!buffer || !ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    [src.loopStart, src.loopEnd] = this.bank.loopRange(name);
    src.playbackRate.setValueAtTime(rate0, t);
    src.playbackRate.exponentialRampToValueAtTime(rate1, t + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + duration * 0.9);
    env.gain.linearRampToValueAtTime(0, t + duration);
    src.connect(env).connect(dest);
    this.voices++;
    src.onended = () => this.voices--;
    src.start(t, src.loopStart);
    src.stop(t + duration + 0.02);
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
   * A gunshot. `pos` null is the player's own weapon. Close up the dry crack,
   * far off the take with the room in it, and the heavy ones with a low thump
   * under the crack. A mech's cannons are rifles and shotguns pitched far down
   * under a boom, and the rail a heavy electric discharge over a rifle's crack.
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
      this.play(b, far ? 'autocannon-far' : 'autocannon', 0.85, 0, 0.72);
      if (!far) this.play(b, 'gun-body', 0.7, 0, 0.6);
    } else if (weapon === 'breaker') {
      // Flak: a deep, hollow cough as the shell leaves the tube.
      if (far) this.play(b, 'scattergun-far', 0.5, 0, 0.6);
      else this.play(b, 'breaker', 0.7, 0, 0.62);
      this.play(b, 'breaker-boom', 0.9);
    } else if (weapon === 'lance') {
      // Rail: the coils discharging, and the slug's crack.
      this.play(b, 'lance', 0.85);
      this.play(b, far ? 'longshot-far' : 'longshot', 0.6, 0, 0.8);
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

  /** The player's round landing on an enemy: a crisp tick, with a ping on the head. */
  hit(head: boolean): void {
    if (!this.allow('hit', 0.03)) return;
    const b = this.bus(null, 0.7);
    if (!b) return;
    this.play(b, 'hit-tick', 0.8);
    if (head) this.play(b, 'hit-head', 0.5, 0.01);
  }

  /** The player's shot finished someone: a heavier tick on a metal thunk, and a low ping. */
  kill(): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.play(b, 'hit-tick', 0.9, 0, 0.8);
    this.play(b, 'lock-light', 0.5, 0.01, 0.9);
    this.play(b, 'hit-head', 0.45, 0.04, 0.6);
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

  /** The mech's cannon drops its empty belt box. */
  reloadOut(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.play(b, 'belt-out', 0.6);
    this.play(b, 'mech-servo', 0.2, 0.05, 0.8);
  }

  /** A fresh belt box locks in and the feed cycles. */
  reloadIn(): void {
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.play(b, 'belt-in', 0.7);
    this.play(b, 'lock-heavy', 0.6, 0.08, 0.8);
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
   * on its hinge; a mech's cannon swings up and locks.
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
      this.play(b, 'mech-servo', 0.35);
      this.play(b, 'lock-heavy', 0.6, 0.25, 0.8);
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
    this.play(b, 'flak', 0.9);
    this.play(b, 'blast-body', 0.3, 0, 1.2);
  }

  /** The mech frame for the next call changed: a switch, higher for each frame in the list. */
  frameSelect(index: number): void {
    const b = this.bus(null, 0.7);
    if (!b) return;
    this.play(b, 'ui-select', 0.7);
    this.play(b, 'ui-move', 0.5, 0.05, Math.pow(1.12, index));
  }

  /** Jump jets: a long roar under the burst of air as they light. */
  leap(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 3 : 0.8);
    if (!b) return;
    this.play(b, 'mech-leap', 0.9);
    this.play(b, 'jet-ignite', 0.6, 0, 0.7);
  }

  /** The stomp: a ground-shaking thump, plating ringing, and concrete falling back. */
  stomp(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 5 : 1);
    if (!b) return;
    this.play(b, 'mech-step', 1, 0, 0.7);
    this.play(b, 'blast-low', 0.9);
    this.play(b, 'slam', 0.6, 0, 0.7);
    this.play(b, 'debris', 0.6, 0.12);
  }

  /** The shield coming up (a field ringing out over the emitters' servos) or going down. */
  shield(pos: Vec3 | null, up: boolean): void {
    if (!this.allow(`shield-${pos ? 'far' : 'own'}`, 0.1)) return;
    const b = this.bus(pos, pos ? 2 : 0.7);
    if (!b) return;
    if (up) {
      this.play(b, 'shield-up', 0.6);
      this.play(b, 'mech-servo', 0.25, 0, 1.2);
    } else {
      this.play(b, 'shield-down', 0.5, 0, 0.8);
    }
  }

  /** Fire stopped by a shield: a bright electric zap. (Its breaking is `shieldBreak`.) */
  shieldHit(pos: Vec3 | null, broken: boolean): void {
    if (!broken && !this.allow(`shieldHit-${pos ? 'far' : 'own'}`, 0.05)) return;
    const b = this.bus(pos, pos ? 1.6 : 0.5);
    if (b) this.play(b, 'shield-hit', 0.55, 0, 0.9 + Math.random() * 0.2);
  }

  /** The shield gives out: a glassy shatter and the generator winding down. */
  shieldBreak(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 3 : 0.9);
    if (!b) return;
    this.play(b, 'shield-break', 0.8);
    this.play(b, 'shield-down', 0.45, 0, 0.6);
    this.play(b, 'power-down', 0.4, 0.05, 1.4);
  }

  /** The cloak: a soft rising rush going under, a quick shimmer coming back out. */
  cloak(pos: Vec3 | null, on: boolean): void {
    const b = this.bus(pos, pos ? 2.2 : 0.7);
    if (b) this.play(b, on ? 'cloak-on' : 'cloak-off', on ? 0.5 : 0.6);
  }

  /** The mech meter is full: a rising run of chimes. */
  meterReady(): void {
    const b = this.bus(null, 0.8);
    if (b) this.play(b, 'streak-ready', 0.6);
  }

  /** The call went out: a squelch of radio and a confirming tone. */
  mechCall(): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.play(b, 'radio', 0.4);
    this.play(b, 'ui-confirm', 0.5, 0.1);
    this.play(b, 'radio', 0.3, 0.36);
  }

  /** The call (or another mech action) was refused. */
  denied(): void {
    if (!this.allow('denied', 0.25)) return;
    const b = this.bus(null, 0.7);
    if (b) this.play(b, 'ui-error', 0.7);
  }

  /** A mech falling from the sky: a roar that deepens and swells for exactly as long as the fall. */
  dropWhistle(pos: Vec3, duration: number, hostile: boolean): void {
    const b = this.bus(pos, hostile ? 5 : 3.5);
    if (b) this.sweep(b, 'drop-fall', 0.7, duration, 1.5, 0.75);
  }

  /** It lands. The loudest thing in the match. */
  mechLand(pos: Vec3): void {
    const b = this.bus(pos, 6);
    if (!b) return;
    this.play(b, 'blast-low', 1);
    this.play(b, 'blast-body', 0.8, 0, 0.8);
    this.play(b, 'mech-step', 1, 0, 0.6);
    this.play(b, 'slam', 0.7, 0.02, 0.7);
    this.play(b, 'debris', 0.7, 0.15);
  }

  /** Climbing in: the hatch closes and seals, and the reactor starts to spool. */
  embark(): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.play(b, 'hatch-close', 0.5);
    this.play(b, 'lock-heavy', 0.7, 0.45, 0.8);
    this.play(b, 'vent-hiss', 0.3, 0.5);
    this.play(b, 'power-up', 0.4, 0.1, 1.45);
  }

  /** Start-up finished: the controls go live. */
  mechOnline(): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.play(b, 'click', 0.6);
    this.play(b, 'lock-light', 0.5, 0.05);
    this.play(b, 'mech-servo', 0.3, 0.1);
  }

  /** Out through the hatch; thrown clear on a rocket seat when the mech is lost. */
  disembark(eject: boolean): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.play(b, 'hatch-open', 0.5);
    this.play(b, 'vent-hiss', 0.35, 0.05);
    if (!eject) return;
    this.play(b, 'rocket-launch', 0.9);
    this.play(b, 'jet-ignite', 0.7, 0.03);
    this.play(b, 'rocket-motor', 0.4, 0.05);
    this.play(b, 'power-down', 0.3);
  }

  /**
   * A mech's footfall: the foot, the leg servo a moment after, and plating
   * ringing on a heavy landing. `pos` null is the player's own; `frame` sets
   * how heavy it sounds.
   */
  mechStep(pos: Vec3 | null, heavy: boolean, frame: string): void {
    if (!this.allow(`step-${pos ? 'far' : 'own'}`, 0.12)) return;
    const b = this.bus(pos, (pos ? 3 : 0.6) * (heavy ? 1.6 : 1));
    if (!b) return;
    const rate = STRIDE_PITCH[frame] ?? 1;
    this.play(b, 'mech-step', heavy ? 1 : 0.75, 0, rate * (heavy ? 0.85 : 1));
    if (heavy) this.play(b, 'slam', 0.4, 0, 0.7 * rate);
    if (this.hears(pos, 25)) this.play(b, 'mech-servo', 0.18, 0.08, rate);
  }

  /** A mech's dash thrusters. */
  mechDash(pos: Vec3 | null): void {
    const b = this.bus(pos, pos ? 3 : 0.8);
    if (!b) return;
    this.play(b, 'mech-thrust', 0.9);
    this.play(b, 'jet-ignite', 0.6, 0, 0.8);
  }

  /** A dash that ran into something: metal on metal, or metal on a pilot. */
  ram(pos: Vec3): void {
    const b = this.bus(pos, 3.5);
    if (!b) return;
    this.play(b, 'slam', 1);
    this.play(b, 'lock-heavy', 0.7, 0.02, 0.7);
    this.play(b, 'blast-body', 0.4, 0, 1.3);
  }

  /** The player's fire striking a mech: a clank off its plating, with a bright ring for the vent. */
  armorHit(crit: boolean): void {
    if (!this.allow('armor', 0.035)) return;
    const b = this.bus(null, 0.7);
    if (!b) return;
    this.play(b, 'armor-hit', 0.6, 0, 1 + Math.random() * 0.2);
    if (crit) this.play(b, 'impact-metal', 0.5, 0, 1.6);
  }

  /** The player's own mech taking a hit, heard from inside: the hull booming around them. */
  hullHit(amount: number): void {
    if (!this.allow('hull', 0.06)) return;
    const b = this.bus(null, Math.min(1.1, 0.5 + amount / 300));
    if (!b) return;
    this.play(b, 'hull-hit', 0.8, 0, 0.7);
    this.play(b, 'lock-heavy', 0.4, 0, 0.6);
  }

  /** Hull nearly gone: two falling beeps, repeated by the caller while it lasts. */
  hullAlarm(): void {
    if (!this.allow('alarm', 1.1)) return;
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.play(b, 'alarm', 0.4);
    this.play(b, 'alarm', 0.4, 0.2, 0.75);
  }

  /** Standing where an enemy mech is about to land: a fast, bright beep. */
  zoneWarn(): void {
    if (!this.allow('zone', 0.3)) return;
    const b = this.bus(null, 0.7);
    if (b) this.play(b, 'zone-beep', 0.5);
  }

  /** A mech blowing apart, and pieces of it coming down. */
  mechDestroyed(pos: Vec3): void {
    const b = this.bus(pos, 6);
    if (!b) return;
    this.play(b, 'blast', 0.9);
    this.play(b, 'blast-body', 0.9, 0, 0.8);
    this.play(b, 'blast-low', 1, 0, 0.8);
    this.play(b, 'debris', 0.5, 0.2);
    this.play(b, 'wreck-debris', 0.6, 0.3);
    this.play(b, 'wreck-debris', 0.4, 0.7, 0.85);
  }

  /** Something in a burning wreck cooking off: a muffled pop and a short crackle. */
  cookOff(pos: Vec3): void {
    if (!this.allow('cookoff', 0.15)) return;
    const b = this.bus(pos, 2);
    if (!b) return;
    this.play(b, 'cookoff', 0.7, 0, 0.9 + Math.random() * 0.2);
    this.play(b, 'blast-body', 0.3, 0, 1.4);
  }

  /** Deployed (or redeployed): a rising sweep. */
  spawn(): void {
    const b = this.bus(null, 0.5);
    if (b) this.play(b, 'deploy', 0.5);
  }

  /** The match is decided: a rising tone over a low boom for a win, a falling one for a loss. */
  matchEnd(won: boolean): void {
    const b = this.bus(null, 0.8);
    if (!b) return;
    this.play(b, 'blast-low', 0.5, 0, 0.8);
    this.play(b, won ? 'match-win' : 'match-lose', 0.6, 0.05);
  }

  /** News about the match on the HUD (the lead changed, a side is near the score limit). */
  callout(): void {
    if (!this.allow('callout', 0.5)) return;
    const b = this.bus(null, 0.6);
    if (!b) return;
    this.play(b, 'radio', 0.25);
    this.play(b, 'callout', 0.6, 0.06);
  }

  /** The line to the server dropped: a burst of static; or it came back. */
  link(up: boolean): void {
    const d = this.ui(0.5);
    if (!d) return;
    if (up) {
      this.play(d, 'ui-confirm', 0.6);
      return;
    }
    for (const at of [0, 0.05, 0.13]) this.play(d, 'glitch', 0.5, at);
    this.play(d, 'ui-error', 0.4, 0.15);
  }
}
