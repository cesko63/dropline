import {
  Msg,
  NET,
  NetClient,
  PING_BYTES,
  PROTOCOL_VERSION,
  Writer,
  encodePing,
  type ClientHello,
  type CollisionWorld,
  type MapData,
  type MatchInfo,
  type ServerMessage,
} from '@dropline/shared';

/**
 * The browser's line to the game server: a WebSocket around the shared client
 * core (`NetClient`), which does the actual netcode. This file greets the
 * server, measures the ping, and gets the same seat back when the line drops.
 */

export type NetStatus =
  /** Dialling, before the first welcome. */
  | 'connecting'
  | 'online'
  /** The line dropped mid-match; trying to get the seat back. */
  | 'reconnecting'
  /** Given up, or turned away. `Connection.reason` says why. */
  | 'closed';

export type CloseReason = 'unreachable' | 'lost' | 'version' | 'full' | 'bad' | 'left';

const TOKEN_KEY = 'dropline.seat';
const RETRY_MS = 1500;
/** Tries to reach a server that has never answered before giving up. */
const FIRST_TRIES = 2;

export class Connection {
  readonly net: NetClient;
  status: NetStatus = 'connecting';
  reason: CloseReason | null = null;
  /** Seated: `net.match` is ready to be shown. Also called after a reconnect. */
  onWelcome: () => void = () => {};
  /** The next match began. */
  onMatch: () => void = () => {};
  /** Someone joined or left. `before` is the roster as it was. */
  onRoster: (before: MatchInfo, now: MatchInfo) => void = () => {};
  onStatus: (status: NetStatus, reason: CloseReason | null) => void = () => {};

  private ws: WebSocket | null = null;
  private roster: MatchInfo | null = null;
  private token = '';
  private everOnline = false;
  private tries = 0;
  private giveUpAt = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private readonly writer = new Writer(16);

  constructor(
    private readonly url: string,
    private readonly name: string,
    world: CollisionWorld,
    map: MapData,
  ) {
    this.net = new NetClient(world, map, (data) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    });
    try {
      this.token = sessionStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      // No storage (a private window): a dropped line just means a new seat.
    }
    this.open();
  }

  private setStatus(status: NetStatus, reason: CloseReason | null = null): void {
    this.status = status;
    this.reason = reason;
    this.onStatus(status, reason);
  }

  private open(): void {
    this.tries++;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.finish('unreachable');
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const hello: ClientHello = { t: 'hello', v: PROTOCOL_VERSION, name: this.name, token: this.token || undefined };
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      if (typeof ev.data === 'string') this.onText(ev.data);
      else this.onBinary(ev.data as ArrayBuffer);
    };
    ws.onclose = () => {
      if (ws === this.ws) this.onDrop();
    };
  }

  private onText(text: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'welcome':
        this.token = msg.token;
        try {
          sessionStorage.setItem(TOKEN_KEY, msg.token);
        } catch {
          // See above.
        }
        this.everOnline = true;
        this.tries = 0;
        this.roster = msg.match;
        this.net.start(msg.you, msg.match);
        this.setStatus('online');
        this.onWelcome();
        window.clearInterval(this.pingTimer);
        this.pingTimer = window.setInterval(() => this.ping(), 1000);
        this.ping();
        break;
      case 'roster': {
        const before = this.roster ?? msg.match;
        this.roster = msg.match;
        this.net.setRoster(msg.match);
        this.onRoster(before, msg.match);
        break;
      }
      case 'match':
        this.roster = msg.match;
        this.net.start(this.net.me, msg.match);
        this.onMatch();
        break;
      case 'reject':
        this.finish(msg.reason);
        break;
    }
  }

  private onBinary(data: ArrayBuffer): void {
    if (data.byteLength < 1) return;
    const type = new Uint8Array(data, 0, 1)[0];
    try {
      if (type === Msg.Snapshot) {
        this.net.onSnapshot(data, performance.now());
      } else if (type === Msg.Pong && data.byteLength === PING_BYTES) {
        const rtt = performance.now() - new DataView(data).getFloat64(1, true);
        const st = this.net.stats;
        st.ping = st.ping === 0 ? rtt : st.ping + (rtt - st.ping) * 0.25;
      }
    } catch (err) {
      // A message this build cannot read. One bad message must not take the game down.
      console.error('[net] unreadable message', err);
    }
  }

  private ping(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encodePing(this.writer, Msg.Ping, performance.now()));
  }

  /** The socket closed without anyone asking. */
  private onDrop(): void {
    window.clearInterval(this.pingTimer);
    if (this.status === 'closed') return;
    const now = performance.now();
    if (this.status === 'online') {
      // The server holds the seat for a while: keep knocking for that long.
      this.giveUpAt = now + (NET.graceSeconds - 1) * 1000;
      this.setStatus('reconnecting');
    }
    const lost = this.everOnline;
    if (lost ? now >= this.giveUpAt : this.tries >= FIRST_TRIES) {
      this.finish(lost ? 'lost' : 'unreachable');
      return;
    }
    this.retryTimer = window.setTimeout(() => this.open(), RETRY_MS);
  }

  private finish(reason: CloseReason): void {
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close();
    if (reason !== 'lost' && reason !== 'unreachable') {
      // Turned away or left on purpose: the seat is not coming back.
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        // See above.
      }
    }
    this.setStatus('closed', reason);
  }

  /** Leave for good, telling the server so the seat goes back to a bot at once. */
  close(): void {
    if (this.status === 'closed') return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(new Uint8Array([Msg.Leave]));
    this.finish('left');
  }

  /** Seconds it will keep trying to get the seat back, while reconnecting. */
  get secondsLeft(): number {
    return this.status === 'reconnecting' ? Math.max(0, (this.giveUpAt - performance.now()) / 1000) : 0;
  }
}
