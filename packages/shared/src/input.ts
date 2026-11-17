/** One tick of player intent. This is what gets sent to the server later. */
export interface InputCmd {
  /** Strafe, -1 (left) .. 1 (right). */
  moveX: number;
  /** Forward, -1 (back) .. 1 (forward). */
  moveZ: number;
  /** Radians. 0 looks down -Z, positive turns left. */
  yaw: number;
  /** Radians. Positive looks up. */
  pitch: number;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  /** Trigger held. */
  fire: boolean;
  /** Aim down sights held. */
  ads: boolean;
  reload: boolean;
  /** Loadout slot to switch to, or -1 to keep the current weapon. */
  weapon: number;
  /** Get into or out of the mech. Acts once per press. */
  use: boolean;
  /** Call the mech down. Acts once per press. */
  call: boolean;
  /** Give up the current position and start again at a spawn point. Acts once per press. */
  redeploy: boolean;
  /** The mech frame a call brings down, as an index into `FRAME_LIST`. */
  frame: number;
}

/*
 * In a mech the same command drives the machine: `jump` is the frame's move
 * (dash, leap or stomp) and `ads` its ability (rocket salvo, shield or cloak);
 * `crouch` and `weapon` do nothing.
 */

export const emptyInput = (): InputCmd => ({
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  crouch: false,
  sprint: false,
  fire: false,
  ads: false,
  reload: false,
  weapon: -1,
  use: false,
  call: false,
  redeploy: false,
  frame: 0,
});
