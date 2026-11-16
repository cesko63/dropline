import {
  Msg,
  NetClient,
  PROTOCOL_VERSION,
  TICK_DT,
  createRng,
  emptyInput,
  rand,
  type CollisionWorld,
  type InputCmd,
  type MapData,
  type MatchEvent,
  type Rng,
  type ServerMessage,
} from '@dropline/shared';
import { Room, type Client, type Conn } from '../src/rooms/room';

/**
 * A network in a box: the real room, real client cores, and between them links
 * that hold every message back by a delay plus jitter and keep the order, like
 * the lag proxy does with real sockets. Time is a number that the test moves
 * forward a millisecond at a time, so every run is the same.
 */

export const TICK_MS = TICK_DT * 1000;

type Data = ArrayBuffer | string;

/** One direction of a connection. */
class Link {
  private last = 0;
  private readonly queue: { at: number; data: Data }[] = [];
  sent = 0;
  constructor(
    private readonly sim: Sim,
    private readonly deliver: (data: Data) => void,
  ) {}

  send(data: Data): void {
    const { delay, jitter } = this.sim.lag;
    const at = Math.max(this.last, this.sim.now + delay + (rand(this.sim.rng) * 2 - 1) * jitter);
    this.last = at;
    this.sent++;
    this.queue.push({ at, data });
  }

  pump(): void {
    while (this.queue.length && this.queue[0].at <= this.sim.now) this.deliver(this.queue.shift()!.data);
  }
}

export interface PlayerOptions {
  name?: string;
  token?: string;
  version?: number;
  /** Frames a second this client draws at. */
  fps?: number;
}

/** A player: a client core, a scripted pair of hands, and a connection to the room. */
export class Player {
  readonly net: NetClient;
  private hands: (t: number, self: Player) => Partial<InputCmd> = () => ({});
  /** While true the client draws no frames and sends nothing, like a hidden tab. */
  hidden = false;
  /** Draw no frames until this time (milliseconds), then make up for it: a hitch. */
  frozenUntil = 0;
  /** Seconds the command clock ran slow to let the server catch up. */
  dilated = 0;
  connected = false;
  welcome: Extract<ServerMessage, { t: 'welcome' }> | null = null;
  rejected: Extract<ServerMessage, { t: 'reject' }> | null = null;
  rounds = 0;
  /** Events of the own pilot shown at once, and events the server reported. */
  readonly predicted: MatchEvent[] = [];
  readonly events: MatchEvent[] = [];
  yaw = 0;
  pitch = 0;
  ticks = 0;
  closedByServer = false;

  private up!: Link;
  private down!: Link;
  private client!: Client;
  private readonly frameMs: number;
  private nextFrame = 0;
  private lastFrame = 0;
  private acc = 0;

  constructor(
    private readonly sim: Sim,
    private readonly opts: PlayerOptions = {},
  ) {
    this.frameMs = 1000 / (opts.fps ?? 60);
    this.net = new NetClient(sim.world, sim.map, (data) => this.connected && this.up.send(data));
  }

  /** What the player holds down, asked once per tick. `t` is seconds since the script was set. */
  set script(hands: (t: number, self: Player) => Partial<InputCmd>) {
    this.hands = hands;
    this.ticks = 0;
  }

  get me() {
    return this.net.own;
  }

  /** The server's copy of this player's pilot. */
  get truth() {
    return this.sim.room.match.actors[this.net.me];
  }

  connect(token = this.opts.token): this {
    const room = this.sim.room;
    this.down = new Link(this.sim, (data) => this.onMessage(data));
    const conn: Conn = {
      send: (data) => this.connected && this.down.send(data),
      close: () => {
        this.connected = false;
        this.closedByServer = true;
      },
      buffered: 0,
    };
    this.client = room.connect(conn);
    this.up = new Link(this.sim, (data) => this.connected && room.receive(this.client, data));
    this.connected = true;
    this.closedByServer = false;
    this.nextFrame = this.lastFrame = this.sim.now;
    this.up.send(JSON.stringify({ t: 'hello', v: this.opts.version ?? PROTOCOL_VERSION, name: this.opts.name ?? 'Tester', token }));
    return this;
  }

  /** The line goes dead, as the server sees it. */
  disconnect(): void {
    this.connected = false;
    this.sim.room.disconnect(this.client);
  }

  /** Send bytes of the test's own making. */
  raw(data: Data): void {
    this.up.send(data);
  }

  private onMessage(data: Data): void {
    if (typeof data === 'string') {
      const msg = JSON.parse(data) as ServerMessage;
      if (msg.t === 'welcome') {
        this.welcome = msg;
        this.net.start(msg.you, msg.match);
      } else if (msg.t === 'roster') {
        this.net.setRoster(msg.match);
      } else if (msg.t === 'match') {
        this.rounds++;
        this.net.start(this.net.me, msg.match);
      } else {
        this.rejected = msg;
      }
      return;
    }
    if (new Uint8Array(data, 0, 1)[0] === Msg.Snapshot) this.net.onSnapshot(data, this.sim.now);
  }

  pump(): void {
    if (!this.connected) return;
    this.up.pump();
    this.down.pump();
    const now = this.sim.now;
    if (this.hidden) {
      this.nextFrame = this.lastFrame = now;
      return;
    }
    if (now < this.nextFrame || now < this.frozenUntil) return;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.nextFrame = Math.max(this.nextFrame + this.frameMs, now);
    if (!this.net.ready) return;

    if (this.net.takeViewReset()) {
      this.yaw = this.me.p.yaw;
      this.pitch = 0;
    }
    this.acc += dt * this.net.timeScale;
    if (this.net.timeScale < 1) this.dilated += dt;
    while (this.acc >= TICK_DT) {
      this.acc -= TICK_DT;
      const cmd: InputCmd = { ...emptyInput(), yaw: this.yaw, pitch: this.pitch, ...this.hands(this.ticks * TICK_DT, this) };
      this.yaw = cmd.yaw;
      this.pitch = cmd.pitch;
      this.ticks++;
      for (const e of this.net.command(cmd)) this.predicted.push(e);
    }
    for (const e of this.net.advance(now, dt)) this.events.push(e);
  }
}

export class Sim {
  now = 0;
  readonly rng: Rng;
  readonly room: Room;
  readonly players: Player[] = [];
  lag = { delay: 0, jitter: 0 };
  readonly log: string[] = [];
  private nextTick = 0;

  constructor(
    readonly world: CollisionWorld,
    readonly map: MapData,
    seed = 1,
  ) {
    this.rng = createRng(seed * 7919);
    this.room = new Room(world, map, { seed, log: (line) => this.log.push(line) });
  }

  join(opts: PlayerOptions = {}): Player {
    const p = new Player(this, opts);
    this.players.push(p);
    return p.connect();
  }

  /** Let `seconds` pass. */
  run(seconds: number): void {
    const until = this.now + seconds * 1000;
    while (this.now < until) {
      this.now += 1;
      for (const p of this.players) p.pump();
      if (this.now >= this.nextTick) {
        this.room.step();
        this.nextTick += TICK_MS;
      }
    }
  }

  /**
   * Take every bot out of play and stand it in a far corner, so a test has the
   * floor to itself. (A pilot with no brain and no player just stands.)
   */
  clearBots(): void {
    const m = this.room.match;
    for (const a of m.actors) {
      if (!a.brain) continue;
      a.brain = null;
      a.p.pos.x = (a.team === 0 ? -60 : 60) + a.id;
      a.p.pos.y = 0.02;
      a.p.pos.z = a.team === 0 ? 64 : -64;
      a.p.vel.x = a.p.vel.y = a.p.vel.z = 0;
    }
  }

  /** Put a player's pilot on open floor, as the server sees it. */
  place(p: Player, x: number, z: number, yaw: number): void {
    const a = p.truth;
    a.p.pos.x = x;
    a.p.pos.y = 0.02;
    a.p.pos.z = z;
    a.p.vel.x = a.p.vel.y = a.p.vel.z = 0;
    a.p.yaw = yaw;
    a.protect = 0;
    p.yaw = yaw;
    p.pitch = 0;
  }
}
