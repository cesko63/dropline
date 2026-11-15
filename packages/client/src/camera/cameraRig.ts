import * as THREE from 'three';
import { MoveEvent, TUNING, clamp, eyeHeight, lenH, v3, type CollisionWorld, type PlayerState, type Vec3 } from '@dropline/shared';

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

const DEG = Math.PI / 180;

/** First and third person camera with the motion cues that sell speed. */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(80, 1, 0.05, 1200);
  baseFov = 80;
  thirdPerson = false;
  private eye = TUNING.player.eyeStand;
  private roll = 0;
  private fov = 80;
  private dip = 0;
  private dipVel = 0;
  private smoothY: number | null = null;

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** `events` are the MoveEvent flags raised since the previous frame. */
  update(dt: number, s: PlayerState, pos: Vec3, moveX: number, events: number, world: CollisionWorld): void {
    this.eye = damp(this.eye, eyeHeight(s), 14, dt);

    // Smooth out the small vertical pops from stairs; follow exactly in the air.
    if (this.smoothY === null || !s.grounded || s.mantle.active) this.smoothY = pos.y;
    else this.smoothY = clamp(damp(this.smoothY, pos.y, 30, dt), pos.y - 0.45, pos.y + 0.45);

    // Landing dip on a damped spring.
    if (events & MoveEvent.Land && s.landSpeed > 4) this.dipVel -= Math.min(s.landSpeed, 22) * 0.085;
    this.dipVel += (-this.dip * 190 - this.dipVel * 22) * dt;
    this.dip = clamp(this.dip + this.dipVel * dt, -0.35, 0.1);

    // Lean away from the wall while wallrunning, and slightly into strafes.
    let rollTarget = -moveX * 1.3 * DEG;
    if (s.wallrun.active) rollTarget = s.wallrun.side * TUNING.wallrun.cameraRollDeg * DEG;
    else if (s.sliding) rollTarget = -3 * DEG;
    this.roll = damp(this.roll, rollTarget, 9, dt);

    // Widen the view once the player is moving faster than a plain sprint.
    const fovTarget = this.baseFov + clamp((lenH(s.vel) - TUNING.ground.sprintSpeed) / 9, 0, 1) * 12;
    this.fov = damp(this.fov, fovTarget, 6, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    const cam = this.camera;
    cam.rotation.set(s.pitch, s.yaw, this.roll, 'YXZ');
    const eyeY = this.smoothY + this.eye + this.dip;

    if (!this.thirdPerson) {
      cam.position.set(pos.x, eyeY, pos.z);
      return;
    }

    // Over-the-shoulder boom, pulled in when the level is in the way.
    const cp = Math.cos(s.pitch);
    const fx = -Math.sin(s.yaw) * cp;
    const fy = Math.sin(s.pitch);
    const fz = -Math.cos(s.yaw) * cp;
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const pivot = v3(pos.x, eyeY + 0.25, pos.z);
    const dir = v3(-fx * 3.8 + rx * 0.75, -fy * 3.8, -fz * 3.8 + rz * 0.75);
    const length = Math.hypot(dir.x, dir.y, dir.z);
    dir.x /= length;
    dir.y /= length;
    dir.z /= length;
    const hit = world.castRay(pivot, dir, length + 0.3);
    const dist = hit ? Math.max(0.35, hit.dist - 0.3) : length;
    cam.position.set(pivot.x + dir.x * dist, pivot.y + dir.y * dist, pivot.z + dir.z * dist);
  }
}
