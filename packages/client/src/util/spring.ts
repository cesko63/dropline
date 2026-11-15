/** A value on a damped spring that rests at zero: recoil, camera dips and jolts. */
export interface Spring {
  x: number;
  v: number;
}

export const spring = (): Spring => ({ x: 0, v: 0 });

/**
 * Advance a spring by `dt` seconds. The step is cut into slices of at most 4 ms,
 * so a slow frame cannot make it overshoot and blow up, and the motion is the
 * same at any frame rate.
 */
export function stepSpring(s: Spring, stiffness: number, damping: number, dt: number): void {
  const steps = Math.max(1, Math.ceil(dt / 0.004));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.v += (-s.x * stiffness - s.v * damping) * h;
    s.x += s.v * h;
  }
}
