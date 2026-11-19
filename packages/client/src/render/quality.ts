import type { Quality } from '../settings/settings';

/**
 * How much the graphics setting draws, and the automatic resolution that keeps
 * a slow computer smooth by drawing fewer pixels.
 */

export interface QualityPreset {
  /** The most screen pixels per CSS pixel the picture is drawn at. */
  maxPixelRatio: number;
  /** Sun shadow map size in texels, or 0 for no shadows. */
  shadowSize: number;
}

export const QUALITY: Record<Quality, QualityPreset> = {
  high: { maxPixelRatio: 2, shadowSize: 2048 },
  medium: { maxPixelRatio: 1.25, shadowSize: 1024 },
  low: { maxPixelRatio: 1, shadowSize: 0 },
};

/** Seconds of frames averaged before each decision. */
export const WINDOW = 1;
/** Slower than this on average (about 48 fps) and the resolution drops. */
export const SLOW = 1 / 48;
/** Faster than this for `CALM` windows in a row and it climbs back. */
export const FAST = 1 / 57;
export const CALM = 3;
export const DROP = 0.85;
export const RAISE = 1.1;
export const MIN_SCALE = 0.5;
/** A drop that did not make frames at least this much faster is undone and not tried again for `HOLD` seconds. */
export const HELPED = 0.95;
export const HOLD = 30;

/**
 * Watches the time between frames and picks a resolution scale, 1 at full.
 * A drop that does not help (the browser holds frames to 30 a second, or the
 * cost is not in drawing pixels) is undone, so the picture never goes soft for
 * nothing.
 */
export class AutoResolution {
  scale = 1;
  private sum = 0;
  private frames = 0;
  private calm = 0;
  private hold = 0;
  /** Average frame time before the last drop, or 0 when the last change was not a drop. */
  private before = 0;

  /** Feed one frame's length; returns true when `scale` changed. */
  update(dt: number): boolean {
    this.hold = Math.max(0, this.hold - dt);
    this.sum += dt;
    this.frames++;
    if (this.sum < WINDOW) return false;
    const avg = this.sum / this.frames;
    this.sum = 0;
    this.frames = 0;

    if (this.before > 0) {
      const helped = avg < this.before * HELPED;
      this.before = 0;
      if (!helped) {
        this.scale = Math.min(1, this.scale / DROP);
        this.hold = HOLD;
        this.calm = 0;
        return true;
      }
    }
    if (avg > SLOW) {
      this.calm = 0;
      if (this.hold > 0 || this.scale <= MIN_SCALE) return false;
      this.before = avg;
      this.scale = Math.max(MIN_SCALE, this.scale * DROP);
      return true;
    }
    if (avg < FAST && this.scale < 1) {
      if (++this.calm < CALM) return false;
      this.calm = 0;
      this.scale = Math.min(1, this.scale * RAISE);
      return true;
    }
    this.calm = 0;
    return false;
  }

  reset(): void {
    this.scale = 1;
    this.sum = this.frames = this.calm = this.hold = this.before = 0;
  }
}
