import { emptyInput, type InputCmd } from '../input';
import { PROJECTILES, WEAPON_LIST } from '../sim/weapons';

/**
 * The wire format, shared by server and client. Anything sent many times a
 * second (commands, snapshots) is binary with a fixed layout; rare messages
 * (joining, the roster) are JSON. Change a layout only together with
 * `PROTOCOL_VERSION`.
 */

export const PROTOCOL_VERSION = 1;
/** Versions the server still talks to. Keep the previous one in here while a new build rolls out. */
export const SUPPORTED_VERSIONS: readonly number[] = [1];

/** First byte of every binary message. */
export const Msg = {
  /** Client to server: one tick's command. */
  Input: 1,
  /** Server to client: the world, this player's own state and what happened. */
  Snapshot: 2,
  /** Client to server, echoed back unchanged: measures the round trip. */
  Ping: 3,
  Pong: 4,
  /** Client to server, one byte: leaving on purpose, the seat need not be held. */
  Leave: 5,
} as const;

// ---------------------------------------------------------------- JSON messages

export interface SeatInfo {
  name: string;
  team: number;
  /** The bot's role, or null for a human. */
  bot: string | null;
}

export interface MatchInfo {
  /** Counts up with every new match on this server. */
  round: number;
  scoreLimit: number;
  seats: SeatInfo[];
}

export type ClientHello = { t: 'hello'; v: number; name: string; token?: string };

export type ServerMessage =
  /** `you` is the actor id this player controls; `token` gets the same seat back after a dropped connection. */
  | { t: 'welcome'; v: number; you: number; token: string; resumed: boolean; map: string; match: MatchInfo }
  /** Someone joined or left: the seats changed, the match goes on. */
  | { t: 'roster'; match: MatchInfo }
  /** A new match began: everything from the last one is void. */
  | { t: 'match'; match: MatchInfo }
  /** `v` is the newest version the server speaks. */
  | { t: 'reject'; reason: 'version' | 'full' | 'bad'; v: number };

// ---------------------------------------------------------------- bytes

/** Appends to a growing buffer. Little endian throughout. */
export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  private u8v: Uint8Array;
  pos = 0;

  constructor(size = 2048) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
    this.u8v = new Uint8Array(this.buf);
  }

  private need(n: number): void {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.u8v);
    this.buf = next;
    this.view = new DataView(next);
    this.u8v = new Uint8Array(next);
  }

  reset(): this {
    this.pos = 0;
    return this;
  }

  u8(v: number): void {
    this.need(1);
    this.view.setUint8(this.pos++, v);
  }
  i8(v: number): void {
    this.need(1);
    this.view.setInt8(this.pos++, v);
  }
  u16(v: number): void {
    this.need(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }
  i16(v: number): void {
    this.need(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }
  u32(v: number): void {
    this.need(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }
  i32(v: number): void {
    this.need(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }
  f32(v: number): void {
    this.need(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }
  f64(v: number): void {
    this.need(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  bytes(src: Uint8Array): void {
    this.need(src.length);
    this.u8v.set(src, this.pos);
    this.pos += src.length;
  }
  /** Overwrite two bytes written earlier (a count that is only known afterwards). */
  patchU16(at: number, v: number): void {
    this.view.setUint16(at, v, true);
  }

  /** What has been written, as a view on the working buffer (valid until the next write). */
  written(): Uint8Array {
    return this.u8v.subarray(0, this.pos);
  }
  /** What has been written, as a buffer of its own. */
  finish(): ArrayBuffer {
    return this.buf.slice(0, this.pos);
  }
}

/** Reads what `Writer` wrote. Reading past the end throws a RangeError. */
export class Reader {
  private readonly view: DataView;
  pos = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.view = data instanceof Uint8Array ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
  }

  get left(): number {
    return this.view.byteLength - this.pos;
  }
  u8(): number {
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
}

// ---------------------------------------------------------------- names

/**
 * Weapon ids, rocket kinds and the other causes of death, sent as one byte.
 * Appending is safe; reordering needs a protocol version bump.
 */
export const NAMES: readonly string[] = ['', ...WEAPON_LIST.map((w) => w.id), ...Object.keys(PROJECTILES), 'crush', 'ram'];
const NAME_INDEX = new Map(NAMES.map((n, i) => [n, i]));
export const nameId = (name: string): number => NAME_INDEX.get(name) ?? 0;

// ---------------------------------------------------------------- commands

/** Bits of the button field in a command. */
const Btn = {
  Jump: 1,
  Crouch: 2,
  Sprint: 4,
  Fire: 8,
  Ads: 16,
  Reload: 32,
  Use: 64,
  Call: 128,
  Redeploy: 256,
} as const;

/** One command as the server receives it. */
export interface InputMsg {
  /** Counts up by one per command. The server reports the last one it used. */
  seq: number;
  /** The seat's reset counter the command was made under (see `Snapshot.epoch`). */
  epoch: number;
  /** The server tick the player was looking at, fractional. */
  viewTick: number;
  cmd: InputCmd;
}

/** type, seq, epoch, viewTick, buttons, moveX, moveZ, weapon, yaw, pitch. */
export const INPUT_BYTES = 1 + 4 + 1 + 8 + 2 + 1 + 1 + 1 + 8 + 8;

const PITCH_LIMIT = Math.PI / 2;

/**
 * Round a command to what survives the wire. The client predicts with the
 * rounded command, so both sides step the very same numbers.
 */
export function quantizeInput(cmd: InputCmd): InputCmd {
  cmd.moveX = Math.round(Math.max(-1, Math.min(1, cmd.moveX)) * 127) / 127;
  cmd.moveZ = Math.round(Math.max(-1, Math.min(1, cmd.moveZ)) * 127) / 127;
  cmd.weapon = cmd.weapon >= 0 && cmd.weapon < 8 ? Math.floor(cmd.weapon) : -1;
  return cmd;
}

export function encodeInput(w: Writer, seq: number, epoch: number, viewTick: number, cmd: InputCmd): ArrayBuffer {
  w.reset();
  w.u8(Msg.Input);
  w.u32(seq);
  w.u8(epoch);
  w.f64(viewTick);
  w.u16(
    (cmd.jump ? Btn.Jump : 0) |
      (cmd.crouch ? Btn.Crouch : 0) |
      (cmd.sprint ? Btn.Sprint : 0) |
      (cmd.fire ? Btn.Fire : 0) |
      (cmd.ads ? Btn.Ads : 0) |
      (cmd.reload ? Btn.Reload : 0) |
      (cmd.use ? Btn.Use : 0) |
      (cmd.call ? Btn.Call : 0) |
      (cmd.redeploy ? Btn.Redeploy : 0),
  );
  w.i8(Math.round(cmd.moveX * 127));
  w.i8(Math.round(cmd.moveZ * 127));
  w.i8(cmd.weapon);
  w.f64(cmd.yaw);
  w.f64(cmd.pitch);
  return w.finish();
}

/**
 * Read a command, or null when it is not one a real client could have sent:
 * the wrong size, numbers that are not finite, a view pitched past straight up.
 */
export function decodeInput(data: ArrayBuffer | Uint8Array): InputMsg | null {
  if (data.byteLength !== INPUT_BYTES) return null;
  const r = new Reader(data);
  if (r.u8() !== Msg.Input) return null;
  const seq = r.u32();
  const epoch = r.u8();
  const viewTick = r.f64();
  const b = r.u16();
  const moveX = r.i8();
  const moveZ = r.i8();
  const weapon = r.i8();
  const yaw = r.f64();
  const pitch = r.f64();
  if (!Number.isFinite(viewTick) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
  if (Math.abs(pitch) > PITCH_LIMIT || Math.abs(yaw) > 1e6) return null;
  if (moveX < -127 || moveZ < -127 || weapon < -1 || weapon > 7) return null;
  const cmd = emptyInput();
  cmd.moveX = moveX / 127;
  cmd.moveZ = moveZ / 127;
  cmd.yaw = yaw;
  cmd.pitch = pitch;
  cmd.jump = (b & Btn.Jump) !== 0;
  cmd.crouch = (b & Btn.Crouch) !== 0;
  cmd.sprint = (b & Btn.Sprint) !== 0;
  cmd.fire = (b & Btn.Fire) !== 0;
  cmd.ads = (b & Btn.Ads) !== 0;
  cmd.reload = (b & Btn.Reload) !== 0;
  cmd.use = (b & Btn.Use) !== 0;
  cmd.call = (b & Btn.Call) !== 0;
  cmd.redeploy = (b & Btn.Redeploy) !== 0;
  cmd.weapon = weapon;
  return { seq, epoch, viewTick, cmd };
}

/** type, the sender's clock in milliseconds. */
export const PING_BYTES = 1 + 8;

export function encodePing(w: Writer, type: number, time: number): ArrayBuffer {
  w.reset();
  w.u8(type);
  w.f64(time);
  return w.finish();
}
