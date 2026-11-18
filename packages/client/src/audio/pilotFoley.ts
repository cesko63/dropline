import type { PlayerState, Vec3 } from '@dropline/shared';
import type { Sfx } from './sfx';
import type { Surface, SurfaceSounds } from './surfaces';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Pilots farther off than this make no sound moving: across the map it would only crowd out gunfire. */
const HEARD_WITHIN = 35;

/**
 * One pilot's movement, heard: footsteps in time with the legs, jumps,
 * landings that weigh what the fall did, the slide's scrape, mantles and the
 * jet pack. Everything is read from synced state, so remote pilots sound the
 * same as the player's own.
 */
export class PilotFoley {
  private grounded = true;
  private sliding = false;
  private thrusting = false;
  private mantling = false;
  private wallrun = false;
  private lastVy = 0;
  /** The fastest fall since leaving the ground, m/s. The tick that touches down has already stopped it. */
  private fall = 0;

  constructor(
    private readonly sfx: Sfx,
    private readonly surfaces: SurfaceSounds,
    /** Keys this pilot's looping sounds apart from everyone else's. */
    private readonly id: number,
  ) {}

  /**
   * `pos` is null for the player's own pilot (heard from inside the helmet).
   * `footfall` comes from the animation.
   */
  update(s: PlayerState, pos: Vec3 | null, footfall: boolean): void {
    if (this.sfx.hears(pos, HEARD_WITHIN)) this.sound(s, pos, footfall);
    this.grounded = s.grounded;
    this.sliding = s.sliding;
    this.thrusting = s.thrusting;
    this.mantling = s.mantle.active;
    this.wallrun = s.wallrun.active;
    this.lastVy = s.vel.y;
    this.fall = s.grounded ? 0 : Math.max(this.fall, -s.vel.y);
  }

  private sound(s: PlayerState, pos: Vec3 | null, footfall: boolean): void {
    const sfx = this.sfx;
    const surface = (): Surface => this.surfaces.underfoot(s);
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const weight = clamp01(speed / 9);

    if (s.grounded && !this.grounded && this.fall > 2) sfx.land(pos, clamp01((this.fall - 2) / 14), surface());
    // A jump is a sudden kick upward that the jet pack did not make: off the ground or off a wall.
    if (!s.thrusting && s.vel.y - this.lastVy > 3 && s.vel.y > 2) sfx.jump(pos);
    if (footfall) sfx.step(pos, surface(), s.wallrun.active ? 1 : weight);
    if (s.wallrun.active && !this.wallrun) sfx.wallGrab(pos, surface());
    if (s.mantle.active && !this.mantling) sfx.mantle(pos);
    if (s.sliding && !this.sliding) sfx.slideStart(pos);
    if (s.thrusting && !this.thrusting) sfx.jetIgnite(pos);

    if (s.sliding) sfx.hold(`slide-${this.id}`, 'slide', pos, 0.15 + 0.35 * weight);
    if (s.thrusting) sfx.hold(`jet-${this.id}`, 'jet', pos, 0.45);
    // The rush of air past the helmet, only for the player's own pilot at speed.
    if (!pos && speed > 8) sfx.hold('rush', 'rush', null, clamp01((speed - 8) / 10) * 0.5);
  }
}
