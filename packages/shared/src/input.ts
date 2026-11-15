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
}

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
});
