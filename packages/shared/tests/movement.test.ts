import { beforeAll, describe, expect, it } from 'vitest';
import gym from '../../../data/maps/gym.json';
import {
  CollisionWorld,
  MoveEvent,
  TICK_DT,
  TUNING,
  createPlayerState,
  emptyInput,
  lenH,
  stepPlayer,
  v3,
  type InputCmd,
  type MapData,
  type PlayerState,
} from '../src';

const FACE_NEG_Z = 0;
const FACE_POS_X = -Math.PI / 2;

let world: CollisionWorld;

beforeAll(async () => {
  world = await CollisionWorld.create(gym as MapData);
});

/** Step for `seconds`, building each tick's input from the elapsed time and state. */
function run(s: PlayerState, seconds: number, input: (t: number, s: PlayerState) => Partial<InputCmd>, onTick?: (s: PlayerState) => void): number {
  let events = 0;
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    stepPlayer(s, { ...emptyInput(), yaw: s.yaw, ...input(i * TICK_DT, s) }, world, TICK_DT);
    events |= s.events;
    onTick?.(s);
  }
  return events;
}

/** A player that has settled on open floor near the spawn. */
function spawn(x = 0, z = 46, yaw = FACE_NEG_Z): PlayerState {
  const s = createPlayerState(v3(x, 0.1, z), yaw);
  run(s, 0.3, () => ({}));
  return s;
}

function apex(s: PlayerState, seconds: number, input: (t: number, s: PlayerState) => Partial<InputCmd>): number {
  let top = s.pos.y;
  run(s, seconds, input, (p) => (top = Math.max(top, p.pos.y)));
  return top;
}

describe('ground', () => {
  it('rests on the floor', () => {
    const s = spawn();
    expect(s.grounded).toBe(true);
    expect(s.pos.y).toBeGreaterThan(0);
    expect(s.pos.y).toBeLessThan(0.03);
  });

  it('walks and sprints at the tuned speeds', () => {
    const s = spawn();
    run(s, 1, () => ({ moveZ: 1 }));
    expect(lenH(s.vel)).toBeCloseTo(TUNING.ground.walkSpeed, 0);
    run(s, 1, () => ({ moveZ: 1, sprint: true }));
    expect(lenH(s.vel)).toBeCloseTo(TUNING.ground.sprintSpeed, 0);
    expect(s.vel.z).toBeLessThan(0);
  });

  it('is stopped by a wall', () => {
    const s = spawn(0, 60);
    run(s, 3, () => ({ moveZ: -1, sprint: true }));
    expect(s.pos.z).toBeLessThan(70 - TUNING.player.radius + 0.001);
    expect(s.pos.z).toBeGreaterThan(69.4);
  });

  it('climbs stairs without jumping', () => {
    const s = spawn(12, 34, FACE_POS_X);
    let airTicks = 0;
    run(s, 1.8, () => ({ moveZ: 1 }), (p) => {
      if (!p.grounded) airTicks++;
    });
    expect(s.pos.y).toBeCloseTo(1.8, 1);
    expect(s.pos.x).toBeGreaterThan(18);
    // Stairs are ground: the player must not count as airborne while climbing.
    expect(airTicks).toBeLessThan(6);
  });

  it('walks up a ramp', () => {
    const s = spawn(24, -2);
    run(s, 2.2, () => ({ moveZ: 1, sprint: true }));
    expect(s.pos.y).toBeCloseTo(4, 1);
    expect(s.grounded).toBe(true);
  });
});

describe('jumping', () => {
  it('reaches the expected single jump height', () => {
    const s = spawn();
    const expected = TUNING.jump.velocity ** 2 / (2 * TUNING.air.gravity);
    const top = apex(s, 1.5, (t) => ({ jump: t < 0.05 }));
    expect(top).toBeGreaterThan(expected - 0.12);
    expect(top).toBeLessThan(expected + 0.12);
    expect(s.grounded).toBe(true);
  });

  it('goes higher with a double jump', () => {
    const s = spawn();
    const top = apex(s, 2.5, (t) => ({ jump: t < 0.05 || (t > 0.35 && t < 0.4) }));
    expect(top).toBeGreaterThan(2.3);
    expect(s.airJumpsUsed).toBe(0);
  });

  it('allows only one air jump', () => {
    const s = spawn();
    let doubles = 0;
    run(s, 1.2, (t) => ({ jump: Math.floor(t / 0.1) % 2 === 0 }), (p) => {
      if (p.events & MoveEvent.DoubleJump) doubles++;
    });
    expect(doubles).toBe(1);
  });
});

describe('jetpack', () => {
  it('lifts the player while jump is held, until the fuel runs out', () => {
    const plain = apex(spawn(), 1.5, (t) => ({ jump: t < 0.05 }));
    const s = spawn();
    let sawThrust = false;
    let airTicks = 0;
    const held = apex(s, 0.01, () => ({}));
    const top = Math.max(
      held,
      (() => {
        let peak = 0;
        run(s, 4, () => ({ jump: true }), (p) => {
          peak = Math.max(peak, p.pos.y);
          sawThrust ||= p.thrusting;
          if (!p.grounded) airTicks++;
        });
        return peak;
      })(),
    );
    expect(sawThrust).toBe(true);
    expect(top).toBeGreaterThan(plain + 1);
    expect(top).toBeLessThan(plain + 4.5);
    expect(airTicks * TICK_DT).toBeGreaterThan(1.6);
  });

  it('catches a fall and turns it into lift', () => {
    const s = createPlayerState(v3(0, 13, 50));
    s.airJumpsUsed = TUNING.jump.airJumps;
    run(s, 0.5, () => ({}));
    expect(s.vel.y).toBeLessThan(-9);
    run(s, 0.6, () => ({ jump: true }));
    expect(s.grounded).toBe(false);
    expect(s.vel.y).toBeGreaterThan(0);
    expect(s.vel.y).toBeLessThanOrEqual(TUNING.jetpack.maxRiseSpeed);
    expect(s.fuel).toBeGreaterThan(0.5);
  });

  it('recharges on the ground', () => {
    const s = spawn();
    run(s, 1.4, () => ({ jump: true }));
    expect(s.fuel).toBeLessThan(0.2);
    run(s, 4, () => ({}));
    expect(s.grounded).toBe(true);
    expect(s.fuel).toBe(1);
  });
});

describe('slide', () => {
  it('starts from a sprint, boosts, and decays into a crouch', () => {
    const s = spawn();
    run(s, 1, () => ({ moveZ: 1, sprint: true }));
    const events = run(s, 0.1, () => ({ moveZ: 1, sprint: true, crouch: true }));
    expect(events & MoveEvent.SlideStart).toBeTruthy();
    expect(s.sliding).toBe(true);
    expect(lenH(s.vel)).toBeGreaterThan(TUNING.ground.sprintSpeed + 1);
    run(s, 4, () => ({ crouch: true }));
    expect(s.sliding).toBe(false);
    expect(s.crouched).toBe(true);
  });

  it('runs out even while forward is held', () => {
    const s = spawn(50, 56);
    run(s, 1, () => ({ moveZ: 1, sprint: true }));
    let slideTicks = 0;
    let peak = 0;
    run(s, 4, () => ({ moveZ: 1, sprint: true, crouch: true }), (p) => {
      if (p.sliding) slideTicks++;
      peak = Math.max(peak, lenH(p.vel));
    });
    expect(peak).toBeLessThanOrEqual(TUNING.slide.maxBoostedSpeed + 0.01);
    expect(slideTicks * TICK_DT).toBeGreaterThan(0.8);
    expect(slideTicks * TICK_DT).toBeLessThanOrEqual(TUNING.slide.duration + 0.05);
    expect(s.sliding).toBe(false);
    expect(lenH(s.vel)).toBeCloseTo(TUNING.ground.crouchSpeed, 0);
  });

  it('refills the moment a slide ends, ready for the next one', () => {
    const s = spawn(50, 56);
    run(s, 1, () => ({ moveZ: 1, sprint: true }));
    run(s, 0.4, () => ({ moveZ: 1, sprint: true, crouch: true }));
    expect(s.sliding).toBe(true);
    expect(s.slideFuel).toBeLessThan(0.8);

    // Let go, run on for a moment, slide again: full energy and a full kick.
    run(s, 0.3, () => ({ moveZ: 1, sprint: true }));
    expect(s.slideFuel).toBe(1);
    const before = lenH(s.vel);
    const events = run(s, 0.05, () => ({ moveZ: 1, sprint: true, crouch: true }));
    expect(events & MoveEvent.SlideStart).toBeTruthy();
    expect(lenH(s.vel)).toBeGreaterThan(before + TUNING.slide.boost - 0.5);
  });

  it('does not restart while crouch stays held', () => {
    // Down the ramp gravity keeps the speed up, so only the energy can end the slide.
    const s = createPlayerState(v3(24, 4.1, -25.5), Math.PI);
    run(s, 0.3, () => ({}));
    run(s, 0.7, () => ({ moveZ: 1, sprint: true }));
    let starts = 0;
    run(s, 2.5, () => ({ moveZ: 1, sprint: true, crouch: true }), (p) => {
      if (p.events & MoveEvent.SlideStart) starts++;
    });
    expect(starts).toBe(1);
    expect(s.sliding).toBe(false);
    expect(s.pos.y).toBeLessThan(0.1);
  });

  it('does not start from a walk', () => {
    const s = spawn(50, 56);
    run(s, 1, () => ({ moveZ: 1 }));
    run(s, 0.2, () => ({ moveZ: 1, crouch: true }));
    expect(s.sliding).toBe(false);
    expect(s.crouched).toBe(true);
  });

  it('cannot enter the duct standing but can crouched', () => {
    const standing = spawn(0, 36);
    run(standing, 3, () => ({ moveZ: 1 }));
    expect(standing.pos.z).toBeGreaterThan(30);

    const crouched = spawn(0, 36);
    run(crouched, 7, () => ({ moveZ: 1, crouch: true }));
    expect(crouched.pos.z).toBeLessThan(21);
    // Under the roof the player must stay crouched even after letting go.
    const inside = spawn(0, 36);
    run(inside, 3.2, () => ({ moveZ: 1, crouch: true }));
    run(inside, 0.2, () => ({}));
    expect(inside.pos.z).toBeLessThan(30);
    expect(inside.pos.z).toBeGreaterThan(22);
    expect(inside.crouched).toBe(true);
  });
});

describe('mantle', () => {
  it('pulls up onto a 2 m block when jumping at it', () => {
    const s = spawn(21, 28);
    const events = run(s, 2, (_t, p) => ({ moveZ: p.pos.z > 24.8 ? 1 : 0, jump: p.pos.z < 26.4 && p.pos.y < 0.5 && p.grounded }));
    expect(events & MoveEvent.MantleStart).toBeTruthy();
    expect(s.pos.y).toBeCloseTo(2, 1);
    expect(s.pos.z).toBeLessThan(25.5);
  });
});

describe('wallrun', () => {
  function startRun(): PlayerState {
    const s = spawn(-10.9, 46);
    run(s, 0.55, () => ({ moveZ: 1, sprint: true }));
    run(s, 0.05, () => ({ moveZ: 1, sprint: true, jump: true }));
    return s;
  }

  it('attaches to a wall, holds height, then drops off', () => {
    const s = startRun();
    let ticks = 0;
    let started = false;
    let minY = Infinity;
    run(s, 1.2, () => ({ moveZ: 1, sprint: true }), (p) => {
      started ||= (p.events & MoveEvent.WallrunStart) !== 0;
      if (p.wallrun.active) {
        ticks++;
        minY = Math.min(minY, p.pos.y);
      }
    });
    expect(started).toBe(true);
    expect(s.wallrun.side).toBe(-1);
    expect(ticks * TICK_DT).toBeGreaterThan(0.9);
    expect(minY).toBeGreaterThan(0.6);
    expect(lenH(s.vel)).toBeGreaterThan(TUNING.ground.sprintSpeed);
    run(s, 2, () => ({ moveZ: 1, sprint: true }));
    expect(s.wallrun.active).toBe(false);
  });

  it('wall jumps away from the wall and restores the double jump', () => {
    const s = startRun();
    run(s, 0.6, () => ({ moveZ: 1, sprint: true }));
    expect(s.wallrun.active).toBe(true);
    // Steering away from the wall (it is on the left) makes it a full leap across.
    const events = run(s, 0.05, () => ({ moveZ: 1, moveX: 1, sprint: true, jump: true }));
    expect(events & MoveEvent.WallJump).toBeTruthy();
    expect(s.wallrun.active).toBe(false);
    expect(s.vel.x).toBeGreaterThan(4);
    expect(s.vel.y).toBeGreaterThan(4);
    expect(s.airJumpsUsed).toBe(0);
  });
});

describe('momentum', () => {
  /** Hop on every landing for `seconds`; returns the speed at the end. */
  function hop(s: PlayerState, seconds: number, crouch: boolean): number {
    let groundTicks = 0;
    run(s, seconds, (_t, p) => {
      groundTicks = p.grounded ? groundTicks + 1 : 0;
      // Curve gently so the run stays on open floor.
      return { moveZ: 1, sprint: true, crouch, jump: p.grounded && groundTicks >= (crouch ? 2 : 0), yaw: p.yaw + 0.012 };
    });
    return lenH(s.vel);
  }

  function launch(): PlayerState {
    const s = spawn(45, 50);
    run(s, 1, () => ({ moveZ: 1, sprint: true }));
    run(s, 0.1, () => ({ moveZ: 1, sprint: true, crouch: true }));
    expect(lenH(s.vel)).toBeGreaterThan(TUNING.ground.sprintSpeed + 2);
    return s;
  }

  it('bleeds off above-sprint speed when bunny hopping', () => {
    const s = launch();
    expect(hop(s, 4, false)).toBeLessThan(TUNING.ground.sprintSpeed + 1);
  });

  /** Hop for `seconds`, jumping two ticks after each landing. Returns slide count and top speed. */
  function slideHop(s: PlayerState, seconds: number, crouch: (p: PlayerState) => boolean): { slides: number; top: number } {
    let top = 0;
    let slides = 0;
    let groundTicks = 0;
    run(s, seconds, (_t, p) => {
      groundTicks = p.grounded ? groundTicks + 1 : 0;
      return { moveZ: 1, sprint: true, crouch: crouch(p), jump: p.grounded && groundTicks >= 2, yaw: p.yaw + 0.012 };
    }, (p) => {
      top = Math.max(top, lenH(p.vel));
      if (p.events & MoveEvent.SlideStart) slides++;
    });
    return { slides, top };
  }

  it('chains slide-hops when crouch is pressed again for each one', () => {
    const s = launch();
    // Let go while rising, press again on the way down.
    const { slides, top } = slideHop(s, 8, (p) => p.grounded || p.vel.y < 0);
    expect(slides).toBeGreaterThan(5);
    expect(top).toBeLessThanOrEqual(TUNING.slide.maxBoostedSpeed + 0.01);
    expect(lenH(s.vel)).toBeGreaterThan(TUNING.ground.sprintSpeed + 2);
  });

  it('does not slide again while crouch is simply held through the hops', () => {
    const s = launch();
    const { slides } = slideHop(s, 5, () => true);
    expect(slides).toBe(0);
    expect(lenH(s.vel)).toBeLessThan(TUNING.ground.sprintSpeed + 1);
  });
});

describe('speed limit', () => {
  it('caps horizontal speed in the air', () => {
    const s = createPlayerState(v3(0, 8, 50));
    s.vel.z = -40;
    run(s, 0.1, () => ({}));
    expect(lenH(s.vel)).toBeLessThanOrEqual(TUNING.air.maxSpeed + 0.01);
  });
});

describe('wallrun on one wall, repeatedly', () => {
  /** On the long west wall (on the player's left), heading -Z, just attached. */
  function onWestWall(): PlayerState {
    const s = spawn(-69.3, 64);
    run(s, 0.55, () => ({ moveZ: 1, sprint: true }));
    run(s, 0.05, () => ({ moveZ: 1, sprint: true, jump: true }));
    run(s, 0.3, () => ({ moveZ: 1, moveX: -1, sprint: true }));
    expect(s.wallrun.active).toBe(true);
    return s;
  }

  /** Hold into the wall and hop off every `every` seconds of wallrun. */
  function hopAlong(s: PlayerState, seconds: number, every: number, extra?: (p: PlayerState) => void) {
    let attaches = 0;
    let maxY = 0;
    run(s, seconds, (_t, p) => ({ moveZ: 1, moveX: -1, sprint: true, jump: p.wallrun.active && p.wallrun.time >= every }), (p) => {
      if (p.events & MoveEvent.WallrunStart) attaches++;
      maxY = Math.max(maxY, p.pos.y);
      extra?.(p);
    });
    return { attaches, maxY };
  }

  it('lands back on the same wall after each hop, for as long as the wall lasts', () => {
    const s = onWestWall();
    let grounded = false;
    const { attaches } = hopAlong(s, 8, 0.4, (p) => (grounded ||= p.grounded));
    expect(attaches).toBeGreaterThanOrEqual(8);
    expect(grounded).toBe(false);
    expect(lenH(s.vel)).toBeGreaterThan(TUNING.ground.sprintSpeed);
  });

  it('does not turn one wall into a ladder', () => {
    const s = onWestWall();
    const startY = s.wallChainY;
    const { maxY } = hopAlong(s, 9, 0.15);
    expect(maxY).toBeLessThan(startY + TUNING.wallrun.chainRise + 2.5);
  });

  it('restores the double jump only on the first touch', () => {
    const s = onWestWall();
    expect(s.airJumpsUsed).toBe(0);
    // Hop off, spend the double jump in the air, come back to the same wall.
    run(s, 0.05, () => ({ moveZ: 1, moveX: -1, sprint: true, jump: true }));
    run(s, 0.1, () => ({ moveZ: 1, moveX: -1, sprint: true }));
    run(s, 0.05, () => ({ moveZ: 1, moveX: -1, sprint: true, jump: true }));
    expect(s.airJumpsUsed).toBe(1);
    run(s, 1, () => ({ moveZ: 1, moveX: -1, sprint: true }));
    expect(s.wallrun.active).toBe(true);
    expect(s.airJumpsUsed).toBe(1);
  });

  it('hops short when steering into the wall and leaps far when steering away', () => {
    const near = onWestWall();
    run(near, 0.05, () => ({ moveZ: 1, moveX: -1, sprint: true, jump: true }));
    const far = onWestWall();
    run(far, 0.05, () => ({ moveZ: 1, moveX: 1, sprint: true, jump: true }));
    expect(near.vel.x).toBeLessThan(2);
    expect(far.vel.x).toBeGreaterThan(4);
  });
});

describe('simulation', () => {
  it('is deterministic for identical inputs', () => {
    const script = (t: number): Partial<InputCmd> => ({
      moveZ: 1,
      moveX: Math.sin(t * 3) > 0 ? 1 : -1,
      sprint: true,
      jump: Math.floor(t * 4) % 3 === 0,
      crouch: Math.floor(t * 2) % 5 === 0,
      yaw: Math.sin(t) * 2,
    });
    const a = spawn();
    const b = spawn();
    run(a, 12, script);
    run(b, 12, script);
    expect(a.pos).toEqual(b.pos);
    expect(a.vel).toEqual(b.vel);
    expect(Number.isFinite(a.pos.x + a.pos.y + a.pos.z)).toBe(true);
    expect(a.pos.y).toBeGreaterThan(-0.1);
  });
});
