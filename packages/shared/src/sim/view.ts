import type { Vec3 } from '../math/vec3';
import type { CollisionWorld } from './world';

/**
 * The third-person view, as far as the simulation needs to know it. The
 * camera sits on a boom behind a point over one shoulder and looks along the
 * view; a player who plays that way shoots from that same point, so the
 * crosshair in the middle of the screen is exactly where the shots go. How far
 * back the camera sits is the client's business: it never moves the line.
 */
export const VIEW = {
  pilot: {
    /** Meters to the side of the eye, toward the chosen shoulder. */
    side: 0.74,
    /** Meters above the eye. */
    lift: 0.3,
  },
  mech: {
    side: 2.4,
    lift: 1.2,
  },
  /** Kept this far short of a wall between the eye and the shoulder point. */
  wallGap: 0.22,
} as const;

const dir = { x: 0, y: 0, z: 0 };

/**
 * Where the line of sight starts: the eye itself when `shoulder` is 0 (first
 * person), else the point over the right (1) or left (-1) shoulder, pulled in
 * short of anything solid between it and the eye. Writes into `out`.
 */
export function viewOrigin(
  eye: Vec3,
  yaw: number,
  shoulder: number,
  mech: boolean,
  world: CollisionWorld,
  out: Vec3,
): Vec3 {
  out.x = eye.x;
  out.y = eye.y;
  out.z = eye.z;
  if (shoulder === 0) return out;
  const g = mech ? VIEW.mech : VIEW.pilot;
  const side = Math.sign(shoulder) * g.side;
  // Right of the view is (cos yaw, 0, -sin yaw).
  dir.x = Math.cos(yaw) * side;
  dir.y = g.lift;
  dir.z = -Math.sin(yaw) * side;
  const length = Math.hypot(dir.x, dir.y, dir.z);
  dir.x /= length;
  dir.y /= length;
  dir.z /= length;
  const hit = world.castRay(eye, dir, length + VIEW.wallGap);
  const d = hit ? Math.max(0, hit.dist - VIEW.wallGap) : length;
  out.x += dir.x * d;
  out.y += dir.y * d;
  out.z += dir.z * d;
  return out;
}
