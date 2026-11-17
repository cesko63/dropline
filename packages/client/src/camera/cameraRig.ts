import * as THREE from 'three';
import { spring, stepSpring } from '../util/spring';
import { MoveEvent, TUNING, clamp, eyeHeight, lenH, v3, type CollisionWorld, type MechFrame, type PlayerState, type Vec3 } from '@dropline/shared';

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

const DEG = Math.PI / 180;

/** First and third person camera with the motion cues that sell speed and weight. */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(80, 1, 0.05, 1200);
  baseFov = 80;
  thirdPerson = false;
  /** Recoil offset added to the view, radians. Set each frame from the weapon state. */
  punchPitch = 0;
  punchYaw = 0;
  /** Field of view multiplier from aiming down sights (1 = none). */
  zoom = 1;
  /** Third person regardless of the toggle: used while dead. */
  forceThird = false;
  /** The view is this mech frame's cockpit: higher, steadier, with a longer boom outside. Null on foot. */
  mech: MechFrame | null = null;
  /** Reduce motion: no widening at speed or on kills, no lean into strafes, half the wallrun tilt. */
  calm = false;
  private readonly joltRoll = spring();
  private readonly joltPitch = spring();
  private fovKick = 0;
  private eye = TUNING.player.eyeStand;
  private roll = 0;
  private fov = 80;
  private readonly dip = spring();
  private smoothY: number | null = null;
  /** Screen shake, 0..1. It decays on its own. */
  private trauma = 0;
  private shakeT = 0;
  /** Where the camera was when the view changed bodies, and how much of that is left. */
  private readonly carryFrom = new THREE.Vector3();
  private readonly carryOffset = new THREE.Vector3();
  private carrying = false;

  /** True when the camera is outside the pilot this frame. */
  get outside(): boolean {
    return this.thirdPerson || this.forceThird;
  }

  /** Knock the view when the pilot is hit; `side` is -1 (from the left) .. 1 (from the right). */
  jolt(side: number, strength: number): void {
    this.joltRoll.v += side * strength * 0.9;
    this.joltPitch.v += strength * 0.5;
  }

  /** A brief widening of the view, for kills. */
  kick(amount: number): void {
    if (this.calm) return;
    this.fovKick = Math.max(this.fovKick, amount);
  }

  /** Shake the view: blasts, a mech landing, heavy footfalls. `amount` 0..1, added up. */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Drop the view by a push on the landing spring: a mech's own footfall. */
  thud(amount: number): void {
    this.dip.v -= amount;
  }

  /**
   * The view is about to move to another body (into the cockpit, or out of it):
   * glide there from where the camera is now instead of cutting.
   */
  carry(): void {
    this.carryFrom.copy(this.camera.position);
    this.carrying = true;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** `events` are the MoveEvent flags raised since the previous frame. */
  update(dt: number, s: PlayerState, pos: Vec3, moveX: number, events: number, world: CollisionWorld): void {
    const mech = this.mech;
    const eyeTarget = mech ? mech.body.eye : eyeHeight(s);
    this.eye = this.carrying ? eyeTarget : damp(this.eye, eyeTarget, 14, dt);

    // Smooth out the small vertical pops from stairs; follow exactly in the air.
    if (this.smoothY === null || !s.grounded || s.mantle.active || this.carrying) this.smoothY = pos.y;
    else this.smoothY = clamp(damp(this.smoothY, pos.y, mech ? 18 : 30, dt), pos.y - 0.45, pos.y + 0.45);

    // Landing dip on a damped spring.
    if (events & MoveEvent.Land && s.landSpeed > 4) this.dip.v -= Math.min(s.landSpeed, 22) * 0.085;
    stepSpring(this.dip, mech ? 120 : 190, mech ? 16 : 22, dt);
    this.dip.x = clamp(this.dip.x, -0.35, 0.1);

    // Lean away from the wall while wallrunning, and slightly into strafes.
    let rollTarget = this.calm ? 0 : -moveX * (mech ? 0.5 : 1.3) * DEG;
    if (s.wallrun.active) rollTarget = s.wallrun.side * TUNING.wallrun.cameraRollDeg * DEG * (this.calm ? 0.5 : 1);
    else if (s.sliding) rollTarget = -3 * DEG;
    this.roll = damp(this.roll, rollTarget, 9, dt);

    // Hit jolt on damped springs.
    stepSpring(this.joltRoll, 260, 20, dt);
    stepSpring(this.joltPitch, 260, 20, dt);
    const joltRoll = clamp(this.joltRoll.x, -0.12, 0.12);
    const joltPitch = clamp(this.joltPitch.x, -0.08, 0.08);
    this.fovKick = damp(this.fovKick, 0, 7, dt);

    // Shake: the square of the trauma, on a few sines that never line up.
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    this.shakeT += dt;
    const shake = this.trauma * this.trauma;
    const t = this.shakeT;
    const shakePitch = shake * 0.03 * (Math.sin(t * 61) + Math.sin(t * 37.3));
    const shakeYaw = shake * 0.025 * (Math.sin(t * 53.7) + Math.sin(t * 29.1));
    const shakeRoll = shake * 0.035 * (Math.sin(t * 47.9) + Math.sin(t * 33.7));

    // Widen the view once the player is moving faster than a plain sprint.
    const top = mech ? mech.move.sprintSpeed : TUNING.ground.sprintSpeed;
    const rush = this.calm ? 0 : clamp((lenH(s.vel) - top) / 9, 0, 1) * 12;
    this.fov = damp(this.fov, this.baseFov + rush, 6, dt);
    const fov = (this.fov + this.fovKick) * this.zoom;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    const cam = this.camera;
    cam.rotation.set(s.pitch + this.punchPitch + joltPitch + shakePitch, s.yaw + this.punchYaw + shakeYaw, this.roll + joltRoll + shakeRoll, 'YXZ');
    const eyeY = this.smoothY + this.eye + this.dip.x;

    if (!this.outside) {
      cam.position.set(pos.x, eyeY, pos.z);
    } else {
      // Over-the-shoulder boom, pulled in when the level is in the way.
      const back = mech ? 9.5 : 3.8;
      const side = mech ? 2.6 : 0.75;
      const cp = Math.cos(s.pitch);
      const fx = -Math.sin(s.yaw) * cp;
      const fy = Math.sin(s.pitch);
      const fz = -Math.cos(s.yaw) * cp;
      const rx = Math.cos(s.yaw);
      const rz = -Math.sin(s.yaw);
      const pivot = v3(pos.x, eyeY + (mech ? 1.3 : 0.25), pos.z);
      const dir = v3(-fx * back + rx * side, -fy * back, -fz * back + rz * side);
      const length = Math.hypot(dir.x, dir.y, dir.z);
      dir.x /= length;
      dir.y /= length;
      dir.z /= length;
      const hit = world.castRay(pivot, dir, length + 0.3);
      const dist = hit ? Math.max(0.35, hit.dist - 0.3) : length;
      cam.position.set(pivot.x + dir.x * dist, pivot.y + dir.y * dist, pivot.z + dir.z * dist);
    }

    // Gliding between bodies: start from the old place and close the gap fast.
    if (this.carrying) {
      this.carrying = false;
      this.carryOffset.copy(this.carryFrom).sub(cam.position);
      // A respawn across the map is a cut, not a glide.
      if (this.carryOffset.lengthSq() > 144) this.carryOffset.set(0, 0, 0);
    }
    if (this.carryOffset.lengthSq() > 1e-6) {
      this.carryOffset.multiplyScalar(Math.exp(-dt * 8));
      cam.position.add(this.carryOffset);
    }
  }
}
