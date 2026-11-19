import { describe, expect, it } from 'vitest';
import { AutoResolution, CALM, HOLD, MIN_SCALE, WINDOW } from '../src/render/quality';

/** Feed `seconds` of frames; `frame` gives each one's length at the current scale. */
function run(a: AutoResolution, seconds: number, frame: (scale: number) => number): void {
  for (let t = 0; t < seconds; ) {
    const dt = frame(a.scale);
    a.update(dt);
    t += dt;
  }
}

describe('auto resolution', () => {
  it('stays sharp on a computer that keeps up', () => {
    const a = new AutoResolution();
    run(a, 20, () => 1 / 60);
    expect(a.scale).toBe(1);
  });

  it('draws fewer pixels until a slow computer is smooth, and no fewer', () => {
    const a = new AutoResolution();
    // Frame time grows with the pixels drawn: 30 ms at full size.
    run(a, 20, (s) => 0.004 + 0.026 * s * s);
    expect(a.scale).toBeLessThan(1);
    expect(a.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(0.004 + 0.026 * a.scale * a.scale).toBeLessThan(1 / 48);
  });

  it('undoes a drop that did not help (a browser held to 30 frames a second) and holds off', () => {
    const a = new AutoResolution();
    run(a, WINDOW * 3.5, () => 1 / 30);
    expect(a.scale).toBe(1);
    run(a, HOLD - 5, () => 1 / 30);
    expect(a.scale).toBe(1);
  });

  it('climbs back when the load goes away', () => {
    const a = new AutoResolution();
    run(a, 10, (s) => 0.004 + 0.026 * s * s);
    const low = a.scale;
    run(a, WINDOW * CALM * 12, () => 1 / 60);
    expect(low).toBeLessThan(1);
    expect(a.scale).toBe(1);
  });
});
