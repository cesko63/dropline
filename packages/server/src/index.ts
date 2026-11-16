import { createServer } from 'node:http';
import { CollisionWorld, NET, PROTOCOL_VERSION, TICK_RATE, type MapData } from '@dropline/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import gym from '../../../data/maps/gym.json';
import { Room, type Conn } from './rooms/room';

/**
 * The game server: one room, reached over WebSocket on `/ws` (any path works),
 * with a plain `/health` page beside it. Everything about the game is in
 * `rooms/room.ts`; this file only carries bytes and keeps time.
 *
 *   PORT   port to listen on (default: `port` in /data/net.json)
 *   SEED   seed of the first match (default: the clock)
 */

const TICK_MS = 1000 / TICK_RATE;

/** How long the shortest sleep really takes here, in milliseconds (the median of a few tries). */
async function timerGrain(): Promise<number> {
  const took: number[] = [];
  for (let i = 0; i < 9; i++) {
    const from = performance.now();
    await new Promise((done) => setTimeout(done, 1));
    took.push(performance.now() - from);
  }
  return took.sort((a, b) => a - b)[4];
}

async function main(): Promise<void> {
  const map = gym as MapData;
  const world = await CollisionWorld.create(map);
  const port = Number(process.env.PORT) || NET.port;
  const seed = Number(process.env.SEED) || (Date.now() & 0x7fffffff);
  const log = (line: string): void => console.log(`[server] ${line}`);
  const room = new Room(world, map, { seed, log });

  // How evenly the ticks actually run, for /health.
  const timing = { late: 0, worst: 0, tickCost: 0, tickCostMax: 0 };

  const http = createServer((req, res) => {
    // Anyone may read the health page, from any origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, map: map.name, tickRate: TICK_RATE, clients: room.clients.size, ...room.stats, timing }, null, 2));
      return;
    }
    res.statusCode = 404;
    res.end('dropline game server: connect with the game client\n');
  });

  const wss = new WebSocketServer({ server: http, maxPayload: NET.input.maxMessageBytes, perMessageDeflate: false });
  wss.on('connection', (ws: WebSocket) => {
    // Commands and snapshots are small and frequent: send each at once.
    (ws as unknown as { _socket?: { setNoDelay(on: boolean): void } })._socket?.setNoDelay(true);
    ws.binaryType = 'arraybuffer';
    const conn: Conn = {
      send: (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
      close: () => ws.close(),
      get buffered() {
        return ws.bufferedAmount;
      },
    };
    const client = room.connect(conn);
    ws.on('message', (data, isBinary) => {
      if (isBinary) room.receive(client, data as ArrayBuffer);
      else room.receive(client, Buffer.from(data as ArrayBuffer).toString('utf8'));
    });
    ws.on('close', () => room.disconnect(client));
    ws.on('error', () => room.disconnect(client));
  });

  // The clock. A timer cannot be trusted to the millisecond (on Windows it wakes
  // only about every 16), so the loop sleeps while a whole timer step still fits
  // before the next tick and spins the rest. A stall is caught up a few ticks at
  // a time; a long one is written off rather than replayed in a burst.
  const grain = await timerGrain();
  let next = performance.now() + TICK_MS;
  const loop = (): void => {
    let now = performance.now();
    let ran = 0;
    while (now >= next && ran < 4) {
      const lateBy = now - next;
      if (lateBy > 4) timing.late++;
      timing.worst = Math.max(timing.worst, lateBy);
      room.step();
      const cost = performance.now() - now;
      timing.tickCost += (cost - timing.tickCost) * 0.01;
      timing.tickCostMax = Math.max(timing.tickCostMax, cost);
      next += TICK_MS;
      ran++;
      now = performance.now();
    }
    if (now - next > 250) next = now + TICK_MS;
    if (next - now > grain + 0.3) setTimeout(loop, 1);
    else setImmediate(loop);
  };

  http.listen(port, () => {
    log(`map "${map.name}", ${TICK_RATE} ticks and ${TICK_RATE / NET.snapshotEvery} snapshots a second, protocol ${PROTOCOL_VERSION}, seed ${seed}`);
    log(`listening on ws://localhost:${port}  (health: http://localhost:${port}/health), timers step ${grain.toFixed(1)} ms`);
    loop();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
