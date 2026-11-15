import movement from '../../../../data/movement.json';

/** Movement tuning. Edit /data/movement.json, not this file. */
export const TUNING = movement;

/** Fixed simulation rate. Client and server must agree on this. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
