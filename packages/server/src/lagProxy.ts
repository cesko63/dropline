import { createConnection, createServer, type Socket } from 'node:net';

/**
 * A lag simulator for testing: a TCP proxy that sits between the game and the
 * server and holds every chunk back by a base delay plus jitter, in each
 * direction, keeping the order. Point the client at it with `?server=`:
 *
 *   pnpm lag                               70 +/- 25 ms each way, 8788 -> 8787
 *   pnpm lag --delay 120 --jitter 40       a worse line
 *   http://localhost:5173/?server=ws://localhost:8788
 */

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

const listen = arg('listen', 8788);
const target = arg('target', 8787);
const delay = arg('delay', 70);
const jitter = arg('jitter', 25);

/**
 * Forward `from` to `to`, late. Chunks wait in one queue and leave from its
 * front, so the order is the order they came in, as on a real TCP line. (One
 * timer per chunk does not give that: timers of different lengths that fall
 * due together may fire in any order.) The pump runs as often as the system's
 * timers allow, a few milliseconds to 16 on Windows, which adds to the delay.
 */
function pipeLate(from: Socket, to: Socket): void {
  const queue: { due: number; chunk: Buffer | null }[] = [];
  let last = 0;
  const pump = setInterval(() => {
    const now = performance.now();
    while (queue.length && queue[0].due <= now) {
      const { chunk } = queue.shift()!;
      if (chunk === null) {
        clearInterval(pump);
        to.destroy();
      } else if (!to.destroyed) {
        to.write(chunk);
      }
    }
  }, 1);
  const push = (chunk: Buffer | null): void => {
    const due = Math.max(last, performance.now() + delay + (Math.random() * 2 - 1) * jitter);
    last = due;
    queue.push({ due, chunk });
  };
  from.on('data', (chunk: Buffer) => push(chunk));
  // The end of the stream takes its place in the queue like everything else.
  from.on('close', () => push(null));
  from.on('error', () => {
    clearInterval(pump);
    to.destroy();
  });
}

createServer((client) => {
  const server = createConnection({ port: target, host: '127.0.0.1' });
  client.setNoDelay(true);
  server.setNoDelay(true);
  pipeLate(client, server);
  pipeLate(server, client);
}).listen(listen, () => {
  console.log(`[lag] localhost:${listen} -> localhost:${target}, ${delay} +/- ${jitter} ms each way`);
});
