import {
  Msg,
  NET,
  PING_BYTES,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  TICK_DT,
  TICK_RATE,
  TO_ALL,
  TO_NONE,
  Writer,
  createHistory,
  createMatch,
  decodeInput,
  emptyInput,
  encodeSnapshot,
  eventAudience,
  seatBot,
  seatHuman,
  stepMatch,
  writeWorld,
  type ClientHello,
  type CollisionWorld,
  type InputCmd,
  type InputMsg,
  type MapData,
  type MatchEvent,
  type MatchInfo,
  type MatchState,
  type ServerMessage,
} from '@dropline/shared';

/**
 * One match and everyone in it. The room owns the only real copy of the game:
 * it steps `stepMatch` at the fixed tick with each player's next command, and
 * tells every client what it sees. It knows nothing about sockets; whatever
 * carries the bytes hands them in through `connect`, `receive` and `disconnect`,
 * which is also how the tests drive it.
 */

/** What the room needs from a connection. */
export interface Conn {
  send(data: ArrayBuffer | string): void;
  close(): void;
  /** Bytes handed to `send` that have not left yet. */
  readonly buffered: number;
}

/** Bytes waiting on a connection beyond which snapshots are held back. */
const BACKLOG = 256 * 1024;
/** Events held back for a client that is not keeping up, before it is dropped. */
const MAX_HELD_EVENTS = 4000;
/** Malformed messages a client may send before it is dropped. */
const MAX_BAD = 8;
/** Seconds in a row over the message rate before a client is dropped. */
const MAX_FLOOD_SECONDS = 3;

export class Client {
  seat: Seat | null = null;
  /** Ticks left to say hello. */
  helloIn = NET.helloTimeout * TICK_RATE;
  /** Messages in the current second, and seconds in a row over the limit. */
  messages = 0;
  floods = 0;
  bad = 0;
  closed = false;
  constructor(readonly conn: Conn) {}
}

interface Seat {
  /** Actor id. */
  id: number;
  /** What the place goes back to when its player leaves. */
  role: string;
  botName: string;

  /** Whoever plays here now. A seat with a token and no client is being held for a dropped player. */
  client: Client | null;
  token: string;
  name: string;
  /** Ticks the seat is still held for its dropped player. */
  holdFor: number;

  queue: InputMsg[];
  /** Sequence number of the last command used, and of the last one received. */
  ack: number;
  lastSeq: number;
  /** See `Snapshot.epoch` and `Snapshot.spawns`. */
  epoch: number;
  spawns: number;
  /** Ticks in a row without a command. */
  stall: number;
  /** True from the moment the server moved the pilot itself until the first command made after that arrives. */
  fresh: boolean;
  /** Fewest commands waiting at any tick of the current window. */
  minQueue: number;
  windowLeft: number;
  /** What happened since this client's last snapshot. */
  events: { tick: number; e: MatchEvent }[];
}

export interface RoomStats {
  tick: number;
  round: number;
  humans: number;
  score: number[];
  snapshots: number;
  snapshotBytes: number;
  snapshotBytesMax: number;
  /** Commands thrown away because too many were waiting. */
  droppedInputs: number;
  /** Ticks a pilot was held because its command was late. */
  stalledTicks: number;
  /** Ticks a connected pilot stood idle because the wait for its command ran out. */
  starvedTicks: number;
  /** Shots traced against the past, and how far back on average and at most (milliseconds). */
  rewinds: number;
  rewindMs: number;
  rewindMsMax: number;
}

export interface RoomOptions {
  seed?: number;
  log?: (line: string) => void;
}

const sanitizeName = (raw: unknown): string =>
  String(typeof raw === 'string' ? raw : '')
    // Letters, digits and a little punctuation: nothing that could pass for markup or hide.
    .replace(/[^\p{L}\p{N} _\-.]/gu, '')
    .trim()
    .slice(0, NET.nameLength);

const newToken = (): string => Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')).join('');

export class Room {
  match!: MatchState;
  /** Counts every tick the room has run. Snapshots and view times are in these. */
  tick = 0;
  round = 0;
  readonly seats: Seat[] = [];
  readonly clients = new Set<Client>();
  readonly stats: RoomStats = {
    tick: 0,
    round: 0,
    humans: 0,
    score: [0, 0],
    snapshots: 0,
    snapshotBytes: 0,
    snapshotBytesMax: 0,
    droppedInputs: 0,
    stalledTicks: 0,
    starvedTicks: 0,
    rewinds: 0,
    rewindMs: 0,
    rewindMsMax: 0,
  };

  private seed: number;
  /** Room tick minus match tick: a new match starts its own count at zero. */
  private tickBase = 0;
  private restartIn = 0;
  private readonly cmds: (InputCmd | null | undefined)[] = [];
  private readonly idle = emptyInput();
  /** Events raised between ticks (someone took or left a seat), sent with the next one. */
  private readonly carry: MatchEvent[] = [];
  private readonly worldWriter = new Writer(1024);
  private readonly writer = new Writer(4096);
  private readonly log: (line: string) => void;

  constructor(
    private readonly world: CollisionWorld,
    private readonly map: MapData,
    options: RoomOptions = {},
  ) {
    this.seed = options.seed ?? 1;
    this.log = options.log ?? (() => {});
    this.newMatch();
  }

  // ---------------------------------------------------------------- matches and seats

  private info(): MatchInfo {
    return {
      round: this.round,
      scoreLimit: this.match.scoreLimit,
      seats: this.match.actors.map((a) => ({ name: a.name, team: a.team, bot: a.brain ? a.brain.role : null })),
    };
  }

  private broadcast(msg: ServerMessage, except: Client | null = null): void {
    const text = JSON.stringify(msg);
    for (const c of this.clients) if (c.seat && c !== except) c.conn.send(text);
  }

  /** The server moved this pilot itself: commands made before now no longer apply. */
  private bump(seat: Seat, respawn: boolean): void {
    seat.epoch = (seat.epoch + 1) & 255;
    if (respawn) seat.spawns = (seat.spawns + 1) & 255;
    seat.queue.length = 0;
    seat.stall = 0;
    seat.fresh = true;
  }

  private newMatch(): void {
    this.round++;
    const m = createMatch(this.map, this.world, { seed: this.seed++, humans: 0 });
    m.history = createHistory(m.actors.length);
    this.match = m;
    this.tickBase = this.tick;
    // Snapshots leave on room ticks that are a multiple of `snapshotEvery`.
    m.history.snapEvery = NET.snapshotEvery;
    m.history.snapOffset = this.tickBase;
    this.restartIn = 0;
    this.carry.length = 0;
    for (const a of m.actors) {
      const old = this.seats[a.id];
      const seat: Seat = old ?? {
        id: a.id,
        role: '',
        botName: '',
        client: null,
        token: '',
        name: '',
        holdFor: 0,
        queue: [],
        ack: 0,
        lastSeq: 0,
        epoch: 0,
        spawns: 0,
        stall: 0,
        fresh: false,
        minQueue: Infinity,
        windowLeft: NET.input.trimWindow,
        events: [],
      };
      this.seats[a.id] = seat;
      seat.role = a.brain!.role;
      seat.botName = a.name;
      seat.events.length = 0;
      seat.ack = seat.lastSeq = 0;
      if (seat.token) {
        seatHuman(m, a, seat.name);
        this.bump(seat, true);
      }
    }
    m.events.length = 0;
    if (this.round > 1) {
      this.log(`match ${this.round} starts`);
      this.broadcast({ t: 'match', match: this.info() });
    }
  }

  private humansOn(team: number): number {
    let n = 0;
    for (const s of this.seats) if (s.token && this.match.actors[s.id].team === team) n++;
    return n;
  }

  /**
   * A free place on the team with fewer players, or null when every place has a
   * player. With the teams even, the player's preferred side goes first.
   */
  private freeSeat(prefer = -1): Seat | null {
    const a = this.humansOn(0);
    const b = this.humansOn(1);
    const first = a === b && (prefer === 0 || prefer === 1) ? prefer : a <= b ? 0 : 1;
    for (const team of [first, 1 - first]) {
      for (const s of this.seats) if (!s.token && this.match.actors[s.id].team === team) return s;
    }
    return null;
  }

  private humans(): number {
    let n = 0;
    for (const s of this.seats) if (s.token) n++;
    return n;
  }

  private release(seat: Seat): void {
    const m = this.match;
    this.log(`${seat.name} left; ${seat.botName} takes seat ${seat.id}`);
    seat.token = '';
    seat.name = '';
    seat.client = null;
    seat.queue.length = 0;
    seat.events.length = 0;
    if (!m.over) {
      seatBot(m, m.actors[seat.id], seat.role, seat.botName);
    } else {
      // The match is over and nothing moves: only the name changes hands.
      m.actors[seat.id].name = seat.botName;
    }
    this.broadcast({ t: 'roster', match: this.info() });
  }

  // ---------------------------------------------------------------- connections

  connect(conn: Conn): Client {
    const client = new Client(conn);
    this.clients.add(client);
    return client;
  }

  private drop(client: Client, why: string): void {
    if (client.closed) return;
    this.log(`dropping a client: ${why}`);
    client.conn.close();
    this.disconnect(client);
  }

  /** The connection is gone. The seat is held for a while in case the player comes back. */
  disconnect(client: Client): void {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    const seat = client.seat;
    if (!seat || seat.client !== client) return;
    seat.client = null;
    seat.holdFor = NET.graceSeconds * TICK_RATE;
    seat.queue.length = 0;
    this.log(`${seat.name} lost the connection; seat ${seat.id} held for ${NET.graceSeconds}s`);
  }

  private reject(client: Client, reason: 'version' | 'full' | 'bad'): void {
    const msg: ServerMessage = { t: 'reject', reason, v: PROTOCOL_VERSION };
    client.conn.send(JSON.stringify(msg));
    this.drop(client, `rejected (${reason})`);
  }

  private hello(client: Client, msg: ClientHello): void {
    if (!SUPPORTED_VERSIONS.includes(msg.v)) return this.reject(client, 'version');
    const m = this.match;
    const token = typeof msg.token === 'string' ? msg.token : '';
    let seat = token ? this.seats.find((s) => s.token === token) : undefined;
    const resumed = seat !== undefined;
    if (seat) {
      // The same player on a new connection; an old one still open is replaced.
      if (seat.client) this.drop(seat.client, 'replaced by a new connection');
      seat.holdFor = 0;
    } else {
      seat = this.freeSeat(msg.side === 1 ? 1 : msg.side === 0 ? 0 : -1) ?? undefined;
      if (!seat) return this.reject(client, 'full');
      seat.token = newToken();
      seat.name = sanitizeName(msg.name) || `Pilot ${seat.id + 1}`;
      if (!m.over) {
        seatHuman(m, m.actors[seat.id], seat.name);
      } else {
        m.actors[seat.id].name = seat.name;
      }
    }
    seat.client = client;
    seat.ack = seat.lastSeq = 0;
    seat.events.length = 0;
    this.bump(seat, true);
    client.seat = seat;
    const welcome: ServerMessage = { t: 'welcome', v: PROTOCOL_VERSION, you: seat.id, token: seat.token, resumed, map: this.map.name, match: this.info() };
    client.conn.send(JSON.stringify(welcome));
    this.broadcast({ t: 'roster', match: this.info() }, client);
    this.log(`${seat.name} ${resumed ? 'is back in' : 'joined'} seat ${seat.id} (team ${m.actors[seat.id].team}); ${this.humans()} players`);
  }

  /** A message from a client. Nothing in it is trusted. */
  receive(client: Client, data: ArrayBuffer | string): void {
    if (client.closed) return;
    if (++client.messages > NET.input.maxPerSecond) return;
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (size > NET.input.maxMessageBytes) return this.drop(client, 'message too large');

    if (typeof data === 'string') {
      // Text is only for the greeting.
      if (client.seat) return this.strike(client);
      let msg: ClientHello;
      try {
        msg = JSON.parse(data) as ClientHello;
      } catch {
        return this.reject(client, 'bad');
      }
      if (!msg || msg.t !== 'hello' || typeof msg.v !== 'number') return this.reject(client, 'bad');
      return this.hello(client, msg);
    }

    const seat = client.seat;
    if (!seat || size < 1) return this.strike(client);
    const type = new Uint8Array(data, 0, 1)[0];
    if (type === Msg.Ping) {
      if (size !== PING_BYTES) return this.strike(client);
      const echo = data.slice(0);
      new Uint8Array(echo)[0] = Msg.Pong;
      client.conn.send(echo);
      return;
    }
    if (type === Msg.Leave) {
      // Gone on purpose: nothing to hold the seat for.
      client.closed = true;
      this.clients.delete(client);
      client.conn.close();
      seat.holdFor = 0;
      this.release(seat);
      return;
    }
    if (type !== Msg.Input) return this.strike(client);
    const input = decodeInput(data);
    if (!input) return this.strike(client);
    // Made before the server last moved this pilot itself, or already seen: not used.
    if (input.epoch !== seat.epoch || input.seq <= seat.lastSeq) return;
    seat.lastSeq = input.seq;
    seat.queue.push(input);
  }

  private strike(client: Client): void {
    if (++client.bad > MAX_BAD) this.drop(client, 'malformed messages');
  }

  // ---------------------------------------------------------------- the tick

  /** The command a seat's pilot uses this tick: its next one, `null` to wait for a late one, or none at all. */
  private nextCommand(seat: Seat): InputCmd | null {
    const I = NET.input;
    const q = seat.queue;
    const a = this.match.actors[seat.id];
    // Far too many waiting (a burst after a stall): skip ahead rather than run behind forever.
    let drop = q.length > I.maxQueue ? q.length - I.queueTarget : 0;
    // A few too many for a whole window (this client's clock runs a little fast): skip one.
    seat.minQueue = Math.min(seat.minQueue, q.length);
    if (--seat.windowLeft <= 0) {
      if (drop === 0 && seat.minQueue > I.queueTarget) drop = 1;
      seat.minQueue = Infinity;
      seat.windowLeft = I.trimWindow;
    }
    if (drop > 0) {
      seat.ack = q[drop - 1].seq;
      q.splice(0, drop);
      this.stats.droppedInputs += drop;
    }

    const next = q.shift();
    if (next) {
      seat.ack = next.seq;
      seat.stall = 0;
      seat.fresh = false;
      a.viewTick = next.viewTick - this.tickBase;
      return next.cmd;
    }
    // Late: hold the pilot for a few ticks so the command meets the state it was made for.
    // After a respawn or a seat change the wait is longer: the player's machine has to
    // hear of it first, and until then the pilot stays exactly where the server put it.
    if (seat.client && seat.stall < (seat.fresh ? I.resetStallTicks : I.stallTicks)) {
      seat.stall++;
      if (a.alive) this.stats.stalledTicks++;
      return null;
    }
    // Still nothing (a hidden tab, a dropped connection): the pilot lets go of every button.
    if (seat.client && a.alive) this.stats.starvedTicks++;
    this.idle.yaw = a.p.yaw;
    this.idle.pitch = a.p.pitch;
    a.viewTick = -1;
    return this.idle;
  }

  /** Advance the match by one tick and, every few ticks, tell everyone. */
  step(): void {
    this.tick++;
    const m = this.match;

    for (const c of this.clients) {
      if (!c.seat && --c.helloIn <= 0) this.drop(c, 'no greeting');
    }
    if (this.tick % TICK_RATE === 0) {
      for (const c of this.clients) {
        c.floods = c.messages > NET.input.maxPerSecond ? c.floods + 1 : 0;
        c.messages = 0;
        if (c.floods >= MAX_FLOOD_SECONDS) this.drop(c, 'too many messages');
      }
    }

    for (const seat of this.seats) {
      this.cmds[seat.id] = undefined;
      if (!seat.token) continue;
      if (!seat.client && --seat.holdFor <= 0) {
        this.release(seat);
        continue;
      }
      this.cmds[seat.id] = this.nextCommand(seat);
    }

    // Whatever is in the event list now was raised between ticks (someone took
    // or left a seat): it goes out with this tick's.
    if (m.events.length) {
      this.carry.push(...m.events);
      m.events.length = 0;
    }

    if (m.over) {
      // Everyone looks at the result for a while, then a new match starts.
      this.tickBase = this.tick - m.tick;
      if (this.restartIn === 0) this.restartIn = NET.restartSeconds * TICK_RATE;
      else if (--this.restartIn === 0) return this.newMatch();
    } else {
      this.countRewinds();
      stepMatch(m, this.world, this.cmds, TICK_DT);
    }

    const events = this.carry.length ? [...this.carry, ...m.events] : m.events;
    this.carry.length = 0;
    for (const e of events) {
      const to = eventAudience(e);
      if (to === TO_NONE) continue;
      // Wherever the server places a pilot itself, that player's earlier commands are void.
      if (e.type === 'spawn' || e.type === 'embark' || e.type === 'disembark') {
        const seat = this.seats[e.actor];
        if (seat.token) this.bump(seat, e.type === 'spawn');
      }
      for (const seat of this.seats) {
        if (seat.client && (to === TO_ALL || to === seat.id)) seat.events.push({ tick: this.tick, e });
      }
    }
    // Handed out: an empty list is how the next tick tells its own events from ones raised in between.
    m.events.length = 0;

    if (this.tick % NET.snapshotEvery === 0) this.sendSnapshots();
    this.stats.tick = this.tick;
    this.stats.round = this.round;
    this.stats.humans = this.humans();
    this.stats.score = m.score;
  }

  /** For the report: how far back this tick's commands look. */
  private countRewinds(): void {
    const m = this.match;
    const st = this.stats;
    for (const seat of this.seats) {
      const cmd = this.cmds[seat.id];
      const a = m.actors[seat.id];
      if (!cmd || !cmd.fire || a.viewTick < 0 || !a.alive) continue;
      const back = Math.max(0, Math.min(NET.rewindCap * TICK_RATE, m.tick - a.viewTick)) * (1000 / TICK_RATE);
      st.rewinds++;
      st.rewindMs += (back - st.rewindMs) / Math.min(st.rewinds, 500);
      st.rewindMsMax = Math.max(st.rewindMsMax, back);
    }
  }

  private sendSnapshots(): void {
    const m = this.match;
    const st = this.stats;
    this.worldWriter.reset();
    writeWorld(this.worldWriter, m);
    const world = this.worldWriter.written();
    for (const seat of this.seats) {
      const client = seat.client;
      if (!client) continue;
      if (client.conn.buffered > BACKLOG) {
        // Not keeping up: hold the events for the next one rather than pile bytes on.
        if (seat.events.length > MAX_HELD_EVENTS) this.drop(client, 'not keeping up');
        continue;
      }
      const data = encodeSnapshot(
        this.writer,
        { tick: this.tick, ack: seat.ack, epoch: seat.epoch, spawns: seat.spawns, queued: seat.queue.length },
        m,
        m.actors[seat.id],
        world,
        seat.events,
      );
      seat.events.length = 0;
      client.conn.send(data);
      st.snapshots++;
      st.snapshotBytes += (data.byteLength - st.snapshotBytes) / Math.min(st.snapshots, 600);
      st.snapshotBytesMax = Math.max(st.snapshotBytesMax, data.byteLength);
    }
  }
}
