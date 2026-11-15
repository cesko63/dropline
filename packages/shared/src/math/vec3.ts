export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function copyV(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const lenH = (a: Vec3): number => Math.hypot(a.x, a.z);

export function addScaled(out: Vec3, dir: Vec3, s: number): Vec3 {
  out.x += dir.x * s;
  out.y += dir.y * s;
  out.z += dir.z * s;
  return out;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Horizontal forward for a yaw angle. Yaw 0 looks down -Z; positive yaw turns left. */
export const forwardFromYaw = (yaw: number): Vec3 => v3(-Math.sin(yaw), 0, -Math.cos(yaw));

/** Horizontal right for a yaw angle. */
export const rightFromYaw = (yaw: number): Vec3 => v3(Math.cos(yaw), 0, -Math.sin(yaw));

/** Euler XYZ in degrees to quaternion (same convention as three.js default order). */
export function eulerDegToQuat(rot: readonly number[] | undefined): Quat {
  if (!rot) return { x: 0, y: 0, z: 0, w: 1 };
  const k = Math.PI / 360;
  const c1 = Math.cos(rot[0] * k), s1 = Math.sin(rot[0] * k);
  const c2 = Math.cos(rot[1] * k), s2 = Math.sin(rot[1] * k);
  const c3 = Math.cos(rot[2] * k), s3 = Math.sin(rot[2] * k);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}
