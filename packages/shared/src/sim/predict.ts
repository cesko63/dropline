import { emptyInput, type InputCmd } from '../input';
import { createBodies, liveBodies, pushApart, type Bodies } from './bodies';
import { COMBAT, type Actor, type MatchState } from './combat';
import { stepMechBody } from './mech';
import { pushBodyEvents, seat } from './mechMatch';
import { stepMechWeapons, stepWeapon } from './match';
import { stepPlayer } from './movement';
import type { CollisionWorld } from './world';

const IDLE = emptyInput();
let scratch: Bodies = createBodies(0);

/**
 * One tick of a single pilot, the way `stepMatch` would step it: movement (or
 * the mech it drives), then its weapon. A client runs this on its own pilot the
 * moment a command is made, and again for every unacknowledged command after
 * each correction from the server, so it has to follow `stepMatch` exactly.
 *
 * Only what the player's own command decides is in here. Health, kills, the
 * mech meter, calling a mech and climbing in or out are the server's to decide
 * and arrive in snapshots. Events are pushed to `m.events` as usual.
 *
 * `bodies` is where the others stood when the command was made (see
 * `bodies.ts`); left out, they are taken from where `m` has them now.
 */
export function stepOwn(m: MatchState, world: CollisionWorld, a: Actor, cmd: InputCmd, dt: number, bodies?: Bodies): void {
  if (!a.alive) return;
  if (cmd.sprint && a.ads > 0.5) cmd = { ...cmd, sprint: false };

  if (!a.inMech) {
    stepPlayer(a.p, cmd, world, dt);
    // Pushed by the others as this client sees them, which is a little in the past.
    if (!bodies) {
      if (scratch.length !== m.actors.length * 10) scratch = createBodies(m.actors.length);
      bodies = liveBodies(m, scratch);
    }
    pushApart(a, bodies, m.mechs, world, dt);
    stepWeapon(m, a, cmd, world, dt);
    return;
  }

  const k = m.mechs[a.id];
  k.stateTime += dt;
  if (k.state === 'boot' && k.stateTime >= COMBAT.mech.embark.time) {
    k.state = 'piloted';
    k.stateTime = 0;
  }
  const driven = k.state === 'piloted';
  if (k.state === 'boot') {
    k.yaw = cmd.yaw;
    k.pitch = cmd.pitch;
  }
  stepMechBody(k, driven ? cmd : IDLE, world, dt, driven, m.mechs);
  pushBodyEvents(m, k);
  seat(a, k);
  if (driven) stepMechWeapons(m, a, k, cmd, world, dt);
}
