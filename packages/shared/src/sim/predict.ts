import { emptyInput, type InputCmd } from '../input';
import { COMBAT, type Actor, type MatchState } from './combat';
import { MechEvent, stepMechBody } from './mech';
import { seat, stepSalvo } from './mechMatch';
import { stepWeapon } from './match';
import { stepPlayer } from './movement';
import type { CollisionWorld } from './world';

const IDLE = emptyInput();

/**
 * One tick of a single pilot, the way `stepMatch` would step it: movement (or
 * the mech it drives), then its weapon. A client runs this on its own pilot the
 * moment a command is made, and again for every unacknowledged command after
 * each correction from the server, so it has to follow `stepMatch` exactly.
 *
 * Only what the player's own command decides is in here. Health, kills, the
 * mech meter, calling a mech and climbing in or out are the server's to decide
 * and arrive in snapshots. Events are pushed to `m.events` as usual.
 */
export function stepOwn(m: MatchState, world: CollisionWorld, a: Actor, cmd: InputCmd, dt: number): void {
  if (!a.alive) return;
  if (cmd.sprint && a.ads > 0.5) cmd = { ...cmd, sprint: false };

  if (!a.inMech) {
    stepPlayer(a.p, cmd, world, dt);
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
  if (k.events & MechEvent.Dash) m.events.push({ type: 'mechDash', mech: k.id });
  if (k.events & MechEvent.Land) m.events.push({ type: 'mechStep', mech: k.id, heavy: true });
  else if (k.events & MechEvent.Step) m.events.push({ type: 'mechStep', mech: k.id, heavy: false });
  seat(a, k);
  if (!driven) return;
  stepWeapon(m, a, { ...cmd, ads: false, weapon: -1 }, world, dt);
  stepSalvo(m, a, k, cmd.ads, world, dt);
}
