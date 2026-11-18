import * as THREE from 'three';
import type { PlayerState } from '@dropline/shared';
import { BONES, HIP_HEIGHT, SHIN_LEN, THIGH_LEN, type BoneName, type Skeleton } from './rig';

/** What the animation reads each frame. Everything comes from synced state, so remote pilots move the same. */
export interface AnimInput {
  s: PlayerState;
  alive: boolean;
  /** Horizontal speed, m/s. */
  speed: number;
  /** Horizontal velocity against the body's heading, m/s: ahead and to the right. */
  fwd: number;
  side: number;
  /** Signed turn rate of the body this frame, rad/s. */
  turnRate: number;
  /** View yaw less the body's heading, radians; the head and chest turn toward it. */
  lookYaw: number;
  /** View pitch with recoil, radians; up is positive. */
  aimPitch: number;
  /** 0..1, the weapon arm raised to aim. */
  raise: number;
  /** The shoulder pod is the weapon in use: the arm stays down. */
  shoulder: boolean;
  /** 0..1, how far the pod is swung up. */
  podUp: number;
  /** Swapping the coolant cell: the forearm comes up across the chest. */
  venting: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);
/** An angle brought into -π..π. */
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
/** Leg length from hip to ankle with the thigh swung `a` forward and the knee bent `b`. */
const reach = (a: number, b: number): number => THIGH_LEN * Math.cos(a) + SHIN_LEN * Math.cos(a - b);
const REST_REACH = THIGH_LEN + SHIN_LEN;

/**
 * Drives the pilot skeleton from movement state. Each frame builds a target
 * pose for the state (stand, run, crouch, slide, wallrun, air, jet, mantle,
 * land, die) and every bone eases toward it, which cross-fades states in about
 * a tenth of a second. Grounded poses lower the hips until the longer leg
 * touches the ground, so feet stay on the floor in every stance, and the run
 * cycle advances with distance travelled, so feet do not slide.
 */
export class PilotAnimator {
  private readonly target = {} as Record<BoneName, THREE.Vector3>;
  private hipsY = 0;
  private hipsZ = 0;
  private phase = 0;
  private gait = 0;
  private time = Math.random() * 10;
  private land = 0;
  private flip = 0;
  private flinch = 0;
  private kick = 0;
  private jet = 0;
  private mantleT = 0;
  private wasGrounded = true;
  private wasMantling = false;
  private lastVy = 0;
  private deadT = -1;
  /** Way of travel against the heading, as a smoothed unit vector (ahead, right). */
  private dirF = 1;
  private dirS = 0;
  /** Smoothed acceleration against the heading, m/s². */
  private accF = 0;
  private accS = 0;
  private lastFwd = 0;
  private lastSide = 0;
  /** Pod angle in chest space, for the avatar to read. */
  podPitch = 1.15;

  constructor(
    private readonly bones: Skeleton,
    /** The group that holds the hips: it leans and rolls the whole body about the feet. */
    private readonly body: THREE.Object3D,
  ) {
    for (const b of BONES) this.target[b] = new THREE.Vector3();
  }

  /** A hit: the chest and head snap back. */
  hit(): void {
    this.flinch = 1;
  }

  /** A shot: the weapon arm kicks up. */
  shot(): void {
    this.kick = 1;
  }

  update(dt: number, inp: AnimInput): void {
    const { s } = inp;
    this.time += dt;
    this.flinch = Math.max(0, this.flinch - dt * 6);
    this.kick = Math.max(0, this.kick - dt * 12);
    for (const b of BONES) this.target[b].set(0, 0, 0);
    const t = this.target;

    if (!inp.alive) {
      this.die(dt);
      return;
    }
    if (this.deadT >= 0) {
      // Back on our feet: a respawn, not a stand-up.
      this.deadT = -1;
      this.body.rotation.set(0, 0, 0);
      this.body.position.set(0, 0, 0);
    }

    // Events read from state changes, so they work for every pilot on screen.
    if (s.grounded && !this.wasGrounded) this.land = Math.max(this.land, clamp(-this.lastVy / 16, 0.15, 1));
    if (!s.grounded && !s.wallrun.active && !s.thrusting && s.vel.y - this.lastVy > 4 && s.vel.y > 2) this.flip = 1;
    if (s.mantle.active && !this.wasMantling) this.mantleT = 0;
    this.wasGrounded = s.grounded;
    this.wasMantling = s.mantle.active;
    this.lastVy = s.vel.y;
    this.land = Math.max(0, this.land - dt * 5);
    this.flip = Math.max(0, this.flip - dt * 2.6);
    this.mantleT += dt;
    this.jet += ((s.thrusting ? 1 : 0) - this.jet) * ease(10, dt);
    if (dt > 0) {
      this.accF += (clamp((inp.fwd - this.lastFwd) / dt, -40, 40) - this.accF) * ease(6, dt);
      this.accS += (clamp((inp.side - this.lastSide) / dt, -40, 40) - this.accS) * ease(6, dt);
    }
    this.lastFwd = inp.fwd;
    this.lastSide = inp.side;
    // The way of travel turns smoothly, and holds while standing so a stop does not snap the legs round.
    if (inp.speed > 0.6) {
      const k = ease(10, dt);
      this.dirF += (inp.fwd / inp.speed - this.dirF) * k;
      this.dirS += (inp.side / inp.speed - this.dirS) * k;
    }
    const travel = Math.atan2(this.dirS, this.dirF);
    // Backing off, the legs step backward; otherwise the hips turn toward the
    // way of travel (the chest stays on the view) and the legs swing along what is left.
    const backward = Math.cos(travel) < -0.26;
    const hipTurn = clamp(wrap(backward ? travel - Math.PI : travel) * 0.6, -0.75, 0.75);
    const legWay = travel - hipTurn;
    const ahead = Math.cos(legWay);
    const across = Math.sin(legWay);

    const breath = Math.sin(this.time * 1.7);
    const running = s.grounded && !s.sliding && !s.mantle.active;
    // Turning on the spot shuffles the feet.
    const gaitSpeed = running ? inp.speed + Math.min(3, Math.abs(inp.turnRate) * 1.2) : s.wallrun.active ? inp.speed : 0;
    this.gait += (clamp(gaitSpeed / 8, 0, 1) - this.gait) * ease(8, dt);
    const g = this.gait;
    const sprint = clamp((inp.speed - 6) / 3, 0, 1);
    // One cycle is two steps; steps lengthen with speed.
    const stepLen = 0.9 + 0.14 * Math.max(inp.speed, 2);
    this.phase += (Math.PI * gaitSpeed * dt) / stepLen;
    const sinL = Math.sin(this.phase);
    const cosL = Math.cos(this.phase);

    let legLa = 0;
    let legLb = 0.06;
    let legRa = 0;
    let legRb = 0.06;
    let footL: number | null = null;
    let footR: number | null = null;
    let spine = 0.015 * breath;
    let chest = 0;
    let armLx = 0.05;
    let armLz = -0.12 - 0.01 * breath;
    let armRx = 0.05;
    let armRz = 0.12 + 0.01 * breath;
    let elbowL = 0.2;
    let elbowR = 0.2;
    let lean = 0;
    let roll = 0;
    let ground = true;
    let drop = 0;
    /** Hips shifted along the body (+Z is back), to keep the head over the hitbox in low poses. */
    let shift = 0;
    let hipsTwist = 0;
    let chestTwist = 0;

    // Stride: thighs swing the way of travel, knees fold on the swing through,
    // arms counter-swing. Sideways the swing is shorter: a side-step, not a lunge.
    const swingA = g * (0.55 + 0.2 * sprint);
    const fold = g * (0.9 + 0.45 * sprint);
    const stride = (sin: number, cos: number): [number, number] => [
      swingA * sin * ahead + 0.08 * g,
      0.06 + g * 0.25 + fold * Math.max(0, cos),
    ];
    /** The thighs' sideways swing (+ is out to the right) for the stride in progress. */
    let sideL = 0;
    let sideR = 0;
    let turnHips = 0;

    if (s.sliding) {
      // Lead leg out in front, the other folded under, leaning back, a hand trailing.
      ground = false;
      drop = -0.52;
      shift = -0.2;
      legLa = 1.3;
      legLb = 0.15;
      legRa = 0.45;
      legRb = 2.25;
      footL = -0.2;
      t.hips.x = 0.1;
      spine = 0.25;
      chest = 0.2;
      armLx = -0.35;
      armLz = -0.7;
      elbowL = 0.15;
      armRx = 0.7;
      armRz = 0.2;
      elbowR = 1.0;
    } else if (s.mantle.active) {
      // Hands plant on the ledge, then push down while a knee comes up and over.
      ground = false;
      const u = clamp(this.mantleT / 0.3, 0, 1);
      armLx = armRx = mix(2.5, 0.35, u);
      elbowL = elbowR = mix(0.7, 0.1, u);
      armLz = -0.15;
      armRz = 0.15;
      legLa = mix(0.6, 1.5, u);
      legLb = mix(0.9, 2.0, u);
      legRa = -0.2;
      legRb = 0.7;
      spine = -0.35;
      drop = mix(0, -0.15, u);
    } else if (s.wallrun.active) {
      // Feet on the wall: the body tips away from it, a fast stride with high
      // knees, and the hand on the wall's side reaches out to it.
      ground = false;
      const side = s.wallrun.side;
      roll = side * 0.34;
      [legLa, legLb] = stride(sinL, cosL);
      [legRa, legRb] = stride(-sinL, -cosL);
      legLb += 0.3;
      legRb += 0.3;
      spine = -0.12;
      armLx = 0.45 * sinL;
      armRx = -0.45 * sinL;
      elbowL = elbowR = 0.9;
      if (side < 0) {
        armLx = 0.35;
        armLz = -1.15;
        elbowL = 0.25;
      } else {
        armRx = 0.35;
        armRz = 1.15;
        elbowR = 0.25;
      }
      t.spine.z = -side * 0.08;
    } else if (!s.grounded) {
      ground = false;
      // Rising: knees drawn up. Falling: legs reach down for the ground, arms out.
      const up = clamp((s.vel.y + 4) / 10, 0, 1);
      legLa = mix(0.35, 0.8, up);
      legLb = mix(0.5, 1.25, up);
      legRa = mix(0.02, 0.15, up);
      legRb = mix(0.25, 0.55, up);
      armLx = armRx = mix(0.15, 0.4, up);
      armLz = mix(-0.6, -0.25, up);
      armRz = mix(0.6, 0.25, up);
      elbowL = elbowR = mix(0.45, 0.8, up);
      spine = mix(0.05, -0.08, up);
      // The jet pack: legs hang together, toes down, arms out for balance.
      const j = this.jet;
      legLa = mix(legLa, 0.14, j);
      legLb = mix(legLb, 0.4, j);
      legRa = mix(legRa, -0.06, j);
      legRb = mix(legRb, 0.22, j);
      footL = mix(legLb - legLa, -0.45, j);
      footR = mix(legRb - legRa, -0.45, j);
      armLx = mix(armLx, -0.2, j);
      armRx = mix(armRx, -0.2, j);
      armLz = mix(armLz, -0.45, j);
      armRz = mix(armRz, 0.45, j);
      spine = mix(spine, 0.1, j);
      // The second jump: a hard tuck.
      const f = Math.sin(Math.min(1, this.flip) * Math.PI) ** 0.7;
      if (f > 0) {
        legLa = mix(legLa, 1.4, f);
        legRa = mix(legRa, 1.3, f);
        legLb = mix(legLb, 2.3, f);
        legRb = mix(legRb, 2.2, f);
        armLx = mix(armLx, 0.7, f);
        armRx = mix(armRx, 0.7, f);
        elbowL = mix(elbowL, 1.6, f);
        elbowR = mix(elbowR, 1.6, f);
        armLz = mix(armLz, 0.1, f);
        armRz = mix(armRz, -0.1, f);
        spine = mix(spine, -0.4, f);
      }
    } else if (s.crouched) {
      // A deep combat crouch, hunched forward with the hips sat back, so the
      // head stays over the crouched hitbox (1 m tall, its head sphere at 0.85 m).
      const [sa, sb] = [0.25 * g * sinL * ahead, 0.3 * g * Math.max(0, cosL)];
      const [ra, rb] = [-0.25 * g * sinL * ahead, 0.3 * g * Math.max(0, -cosL)];
      sideL = 0.2 * g * sinL * across;
      sideR = -0.2 * g * sinL * across;
      turnHips = hipTurn * 0.6 * g;
      lean = -0.008 * inp.fwd;
      roll = -0.008 * inp.side;
      legLa = 1.35 + sa;
      legLb = 2.45 + sb;
      legRa = 1.35 + ra;
      legRb = 2.45 + rb;
      shift = 0.17;
      spine = -0.55;
      chest = -0.4;
      armLx = armRx = 0.35;
      elbowL = elbowR = 0.7;
    } else {
      // Standing, walking, running, sprinting.
      [legLa, legLb] = stride(sinL, cosL);
      [legRa, legRb] = stride(-sinL, -cosL);
      sideL = 0.75 * swingA * sinL * across;
      sideR = -0.75 * swingA * sinL * across;
      turnHips = hipTurn * g;
      // Lean into the run and into a burst of speed, back against a stop, and
      // into a turn the way a runner leans into a bend.
      lean = clamp(-0.012 * inp.fwd - 0.012 * this.accF, -0.26, 0.14);
      roll = clamp(-0.012 * inp.side - 0.012 * this.accS + clamp(inp.turnRate * inp.speed * 0.012, -0.18, 0.18), -0.24, 0.24);
      const idle = 1 - g;
      t.thighL.z = -0.05 * idle;
      t.thighR.z = 0.05 * idle;
      t.footL.z = 0.05 * idle;
      t.footR.z = -0.05 * idle;
      legLa += 0.02 * breath * idle;
      legRa -= 0.02 * breath * idle;
      spine += -0.1 * g - 0.12 * sprint;
      chest += -0.03 * g;
      const armSwing = g * (0.5 + 0.35 * sprint) * (0.45 + 0.55 * Math.abs(ahead));
      armLx = 0.05 - armSwing * sinL;
      armRx = 0.05 + armSwing * sinL;
      elbowL = elbowR = 0.2 + g * (0.45 + 0.6 * sprint);
      armLz = -0.12 - 0.04 * g;
      armRz = 0.12 + 0.04 * g;
      chestTwist = 0.14 * g * sinL;
      hipsTwist = -0.1 * g * sinL;
    }

    // Landing: knees take the weight, then spring back.
    const l = this.land * (s.grounded ? 1 : 0);
    if (l > 0 && !s.sliding) {
      legLa += 0.5 * l;
      legRa += 0.5 * l;
      legLb += 1.1 * l;
      legRb += 1.1 * l;
      spine -= 0.25 * l;
      elbowL += 0.3 * l;
      elbowR += 0.3 * l;
    }

    t.thighL.x = legLa;
    t.thighL.z += sideL;
    t.thighR.z += sideR;
    // The hips turn toward the way of travel; the spine takes the turn back out so the chest stays on the view.
    t.hips.y -= turnHips;
    t.spine.y += turnHips * 0.6;
    chestTwist += turnHips * 0.4;
    t.shinL.x = -legLb;
    t.footL.x = footL ?? clamp(legLb - legLa, -0.7, 1.2) * (running ? 1 - 0.4 * g : 1);
    t.thighR.x = legRa;
    t.shinR.x = -legRb;
    t.footR.x = footR ?? clamp(legRb - legRa, -0.7, 1.2) * (running ? 1 - 0.4 * g : 1);
    // On the ground, the hips sit as low as the longer leg reaches.
    if (ground) drop = Math.max(reach(legLa, legLb) * Math.cos(sideL), reach(legRa, legRb) * Math.cos(sideR)) - REST_REACH;
    t.hips.y += hipsTwist;

    // The head and chest turn toward the view when the body faces elsewhere (a slide, a wallrun).
    const look = clamp(inp.lookYaw, -1.3, 1.3);
    chestTwist += look * 0.4;
    t.spine.x = spine + 0.06 * this.flinch;
    t.chest.x = chest + 0.18 * this.flinch + 0.04 * this.kick;
    t.chest.y = chestTwist;
    t.head.y = look * 0.6;

    // Ease the body first; the arms and head aim against where it ended up.
    const r = ease(18, dt);
    this.hipsY += (drop - this.hipsY) * r;
    this.hipsZ += (shift - this.hipsZ) * r;
    this.bones.hips.position.y = HIP_HEIGHT + 0.04 + this.hipsY;
    this.bones.hips.position.z = this.hipsZ;
    this.body.rotation.x += (lean - this.body.rotation.x) * ease(12, dt);
    this.body.rotation.z += (roll - this.body.rotation.z) * ease(12, dt);
    for (const b of ['hips', 'spine', 'chest', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'] as const) {
      this.bones[b].rotation.x += (t[b].x - this.bones[b].rotation.x) * r;
      this.bones[b].rotation.y += (t[b].y - this.bones[b].rotation.y) * r;
      this.bones[b].rotation.z += (t[b].z - this.bones[b].rotation.z) * r;
    }
    const tilt = this.body.rotation.x + this.bones.hips.rotation.x + this.bones.spine.rotation.x + this.bones.chest.rotation.x;

    // Aiming: the weapon arm points along the view, held straight, and the free
    // hand comes across to brace the housing. The pod keeps the arm down.
    const aim = Math.PI / 2 + inp.aimPitch - tilt;
    const lift = inp.shoulder ? 0 : inp.raise;
    armRx = mix(armRx, aim, lift) + 0.12 * this.kick;
    armRz = mix(armRz, 0, lift);
    elbowR = mix(elbowR, 0, lift);
    armLx = mix(armLx, aim * 0.78, lift);
    armLz = mix(armLz, 0.62, lift);
    elbowL = mix(elbowL, 0.95, lift);
    if (inp.venting) {
      armRx = 0.8;
      armRz = -0.45;
      elbowR = 1.5;
    }
    t.upperArmL.set(armLx, 0, armLz);
    t.foreArmL.x = elbowL;
    t.upperArmR.set(armRx, 0, armRz);
    t.foreArmR.x = elbowR;
    t.handL.x = 0.1;
    t.handR.x = 0;
    t.neck.x = 0;
    // The head levels itself and looks along the view.
    t.head.x = clamp(inp.aimPitch * 0.8 - tilt * 0.85, -0.9, 0.9) + 0.12 * this.flinch;

    const ra = ease(20, dt);
    for (const b of ['upperArmL', 'foreArmL', 'handL', 'upperArmR', 'foreArmR', 'handR', 'neck', 'head'] as const) {
      this.bones[b].rotation.x += (t[b].x - this.bones[b].rotation.x) * ra;
      this.bones[b].rotation.y += (t[b].y - this.bones[b].rotation.y) * ra;
      this.bones[b].rotation.z += (t[b].z - this.bones[b].rotation.z) * ra;
    }

    // The pod follows the view while it is up, and lies folded back otherwise.
    this.podPitch = mix(1.15, inp.aimPitch - tilt, inp.podUp);
  }

  /** Knees go, then the body falls back and lies still; the avatar clears it away. */
  private die(dt: number): void {
    if (this.deadT < 0) this.deadT = 0;
    this.deadT += dt;
    const t = this.target;
    const fall = clamp((this.deadT - 0.08) / 0.5, 0, 1);
    const e = fall * fall;
    this.body.rotation.x = 1.45 * e;
    this.body.rotation.z *= 1 - ease(8, dt);
    this.body.position.y = 0.2 * e;
    t.thighL.x = 0.5;
    t.thighR.x = 0.25;
    t.shinL.x = -0.9;
    t.shinR.x = -0.5;
    t.footL.x = -0.4;
    t.footR.x = -0.3;
    t.upperArmL.set(0.3, 0, -1.2);
    t.upperArmR.set(0.5, 0, 1.0);
    t.foreArmL.x = 0.5;
    t.foreArmR.x = 0.3;
    t.spine.x = -0.2 * (1 - e);
    t.head.x = -0.35;
    t.head.y = 0.4;
    this.hipsY += (-0.25 * (1 - e) - this.hipsY) * ease(10, dt);
    this.bones.hips.position.y = HIP_HEIGHT + 0.04 + this.hipsY * (1 - e);
    this.hipsZ *= 1 - ease(10, dt);
    this.bones.hips.position.z = this.hipsZ;
    const r = ease(10, dt);
    for (const b of BONES) {
      if (b === 'pod') continue;
      this.bones[b].rotation.x += (t[b].x - this.bones[b].rotation.x) * r;
      this.bones[b].rotation.y += (t[b].y - this.bones[b].rotation.y) * r;
      this.bones[b].rotation.z += (t[b].z - this.bones[b].rotation.z) * r;
    }
    this.podPitch = 1.15;
  }
}
