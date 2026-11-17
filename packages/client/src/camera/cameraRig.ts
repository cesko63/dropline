import * as THREE from 'three';
import { spring, stepSpring } from '../util/spring';
import { MoveEvent, TUNING, clamp, eyeHeight, lenH, v3, viewOrigin, type CollisionWorld, type MechFrame, type PlayerState, type Vec3 } from '@dropline/shared';

const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

const DEG = Math.PI / 180;

/**
 * Length of the third-person boom behind the shoulder point, meters. Only the
 * length is free: the camera always sits on the line of sight through that
 * point, so moving it in and out never moves where the crosshair aims.
 */
const BOOM = {
  pilot: { hip: 2.75, aimed: 1.35, rush: 0.55 },
  mech: { hip: 8.2, aimed: 5.4, rush: 1.2 },
  /** Kept this far in front of whatever is behind the camera. */
  wallGap: 0.3,
  /** Shorter than this and the camera would sit inside the pilot: it is hidden instead. */
  hideOwnBelow: 0.55,
} as const;

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
  /** Third person looks over this shoulder: 1 right, -1 left. */
  shoulder = 1;
  /** Fully aimed with a scope: the view goes in to the scope even in third person. */
  scopeIn = false;
  /** 0..1 how far the weapon is aimed; the boom closes in with it. */
  aim = 0;
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
  /** Boom length the camera wants (aim and speed), and the length it has room for. */
  private boomWant: number = BOOM.pilot.hip;
  private boom: number = BOOM.pilot.hip;
  private wasOutside = false;
  private wasShoulder = 1;
  private readonly fwd = v3();
  private readonly eyeAt = v3();
  private readonly origin = v3();

  /** True when the camera is outside the pilot this frame. */
  get outside(): boolean {
    return (this.thirdPerson && !this.scopeIn) || this.forceThird;
  }

  /**
   * The view the player aims through, for `InputCmd.shoulder`: the shoulder
   * while playing in third person, 0 in first person or through a scope.
   */
  get aimShoulder(): number {
    return this.thirdPerson && !this.scopeIn ? this.shoulder : 0;
  }

  /** The camera is far enough behind the pilot to show the pilot's own body. */
  get showsSelf(): boolean {
    return this.outside && this.boom > BOOM.hideOwnBelow;
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
    // Into the scope and back out, first to third person, one shoulder to the
    // other: the camera glides there rather than cutting.
    const outside = this.outside;
    if (outside !== this.wasOutside || (outside && this.shoulder !== this.wasShoulder)) this.carry();
    this.wasOutside = outside;
    this.wasShoulder = this.shoulder;
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
    const pitch = s.pitch + this.punchPitch + joltPitch + shakePitch;
    const yaw = s.yaw + this.punchYaw + shakeYaw;
    cam.rotation.set(pitch, yaw, this.roll + joltRoll + shakeRoll, 'YXZ');
    const eyeY = this.smoothY + this.eye + this.dip.x;

    if (!outside) {
      cam.position.set(pos.x, eyeY, pos.z);
    } else {
      // Over the shoulder: the camera sits on the line of sight through the
      // shoulder point, the same point the shots leave from, so the middle of
      // the screen is where they go. Aiming draws it in close; speed lets it
      // trail a little further back.
      const B = mech ? BOOM.mech : BOOM.pilot;
      const eye = this.eyeAt;
      eye.x = pos.x;
      eye.y = eyeY;
      eye.z = pos.z;
      const origin = viewOrigin(eye, s.yaw, this.shoulder, mech !== null, world, this.origin);
      const top = mech ? mech.move.sprintSpeed : TUNING.ground.sprintSpeed;
      const speed = this.calm ? 0 : clamp((lenH(s.vel) - top * 0.6) / (top * 0.8), 0, 1);
      const want = B.hip + (B.aimed - B.hip) * this.aim + B.rush * speed * (1 - this.aim);
      this.boomWant = this.carrying ? want : damp(this.boomWant, want, 7, dt);

      const cp = Math.cos(pitch);
      const back = this.fwd;
      back.x = Math.sin(yaw) * cp;
      back.y = -Math.sin(pitch);
      back.z = Math.cos(yaw) * cp;
      const hit = world.castRay(origin, back, this.boomWant + BOOM.wallGap);
      const room = hit ? Math.max(0, hit.dist - BOOM.wallGap) : this.boomWant;
      // In at once when something comes between, back out at an easy pace.
      this.boom = room < this.boom || this.carrying ? room : damp(this.boom, room, 6, dt);
      cam.position.set(origin.x + back.x * this.boom, origin.y + back.y * this.boom, origin.z + back.z * this.boom);
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
