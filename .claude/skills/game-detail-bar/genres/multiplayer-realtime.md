# Genre guide: real-time multiplayer

Read this on top of the core rules in [../SKILL.md](../SKILL.md) for any game where two or more players share one live
game over a network. It is about how the game is split between devices and how to test it. Example numbers are in
[../reference.md](../reference.md).

> **This project:** dropline is **server-authoritative with client-side prediction**. A dedicated server
> (`packages/server`) runs the world, including every AI enemy; clients send inputs and draw what the server sends.
> Movement code lives in `packages/shared/src/sim` so client and server step it the same way. Section 2 is written for
> this model (a project addition, not upstream text); the device-owned model upstream describes does not apply here.

## 1. Pick the model on purpose

| Model | How it works | Feels like | Use it for |
| --- | --- | --- | --- |
| Host streams a picture | One device runs everything and sends what it draws; others send buttons | Every action a guest takes waits a full round trip (150-300 ms online) | A quick prototype only |
| Each player owns their own character | Each device runs its own character at once; one host owns the shared world | Your own actions are instant; others and enemies are slightly in the past | Co-op and casual versus games ("friend games") |
| **Server-authoritative state with prediction** (this project) | A server runs the world; clients predict their own movement and correct | Instant movement, corrections on disagreement | Competitive games, anything with strangers |
| Lockstep or rollback | Every device runs the same simulation from the same inputs | Exact; rollback hides delay | Fighting games, strategy games with many units |

The common first mistake is the picture stream: it is quick to build, but a guest's own character answers a round trip
late, and predicting movement alone is not enough, because attacks and abilities still lag. Decide the model before
building the game, because every ability's code has to respect it.

## 2. Server-authoritative with prediction, in detail

**Who owns what:**
- **The server owns everything that matters:** every position, health, hits and kills, AI enemies, pickups, timers,
  the score and the match state. Its fixed-step simulation is the only truth.
- **A client sends inputs, never results:** each input carries a sequence number and the client tick it was made on
  (buttons held, look angles, which weapon fired). It never sends a position, a hit or a damage number.
- **The simulation runs at a fixed tick** on the server (core [section 11](../topics/11-timing-physics.md)), and
  snapshots go out at a lower rate (for example 60 Hz simulation, 20 to 30 Hz snapshots).

**Your own character answers at once:**
- The client runs each input through the same shared movement step the moment it is made, and keeps every input the
  server has not yet acknowledged.
- **Reconciliation:** each snapshot carries the server's state for this player and the last input sequence it
  processed. The client resets its character to that state, drops the acknowledged inputs and replays the rest. When
  the replayed result differs from what was on screen, the difference is eased out of the drawn position over about
  100 ms; the simulated position takes the corrected value at once. Large errors and teleports snap.
- **Predict only what the player's own input decides:** movement, jumps, wall runs, slides, weapon animation, recoil,
  muzzle flash, tracers and the fire sound. Damage, kills, hit markers and kill feed come from the server's
  confirmation, so they are never shown and then taken back.
- **Respawns, teleports and match resets** bump a counter the client echoes in its inputs; the server drops inputs
  from before the bump, and the client never replays across one.

**Hitting other players and AI enemies (lag compensation):**
- Everyone else on the client's screen is drawn in the past, by the interpolation delay (section 3). When a shot
  arrives, the server **rewinds** other players' and AI enemies' hitboxes to the moment the shooter saw, traces the shot
  there, then restores them. It keeps about one second of hitbox history per tick for this.
- **Cap the rewind** (about 200 ms plus the interpolation delay); a client lagging beyond it has to lead its shots.
- Slow projectiles are simulated on the server from the fire time; the client shows its own predicted projectile at
  once and swaps to the server's when it appears.

**AI enemies** run only on the server and reach clients in snapshots, drawn with the same interpolation as remote
players. Give each a stable network id at creation. Their decisions follow the action-combat guide's "How enemies
think".

## 3. Showing the world smoothly

- **Interpolate between snapshots:** draw the world a little behind the newest snapshot, sliding every object between
  the two around "now minus the delay".
- **An adaptive buffer:** start around one frame interval plus a little (about 45 ms at 30 snapshots a second), grow
  with measured jitter, and change slowly so playback never jumps.
- **Late snapshots do not freeze:** objects keep moving along their path for a short time (extrapolation, capped).
- **Events are queued, never dropped:** sounds, banners, menus and rewards run in order when their snapshot is shown.
  Only cosmetic events that are already stale (a sound or shake more than about 350 ms old) are skipped.
- **Measure bytes per snapshot** in a busy moment and keep it reasonable (a few KB at 30 a second is fine; tens of KB
  is not).
- **Send frequent messages as binary, not JSON.** Snapshots, inputs and positions go out many times a second; JSON
  repeats every field name in every message and costs parse time on each one. Pack them into an `ArrayBuffer` with a
  fixed layout (a message-type byte, then numbers as small integers or floats: a position as 16-bit values per axis
  in world units, an angle as one or two bytes, ids as small integers) and set the socket's `binaryType` to
  `"arraybuffer"`. Rare messages (joining, chat, end of match) can stay JSON. Keep the layout in one shared file used
  by both sides, and change it only with a protocol version bump.

## 4. Feedback goes to the right player

- **Personal feedback goes only to its player:** their screen shake, their HUD bumps, their menus (loadout, settings),
  their denied sounds. World events (an explosion, a door slamming) go to everyone.
- **No echoes:** a sound a player's own character made (predicted locally) plays on their device at once; when the
  server relays it to the others, it marks who made it, and that player skips it.
- **A player's freeze-frames never freeze the world:** hit-stop and slow motion are drawn on that one client only.
- **Nothing pauses the match:** menus open only on the player's own device, and their character stays in the world.

## 5. Plumbing

- **Version the protocol** and keep the server accepting the previous version, so old builds keep working while the
  new one rolls out; a mismatch shows a clear "update the game" message.
- **The server checks every message:** size limits, a message-rate limit, and only the right senders for each message
  type. It also rejects impossible inputs (fire faster than the weapon allows, look deltas or input rates out of
  range) and never trusts a client's clock beyond the rewind cap.
- **Reconnection:** a dropped player gets a grace period (about 20 s) to come back to the same seat.
- **A hidden tab stops sending inputs.** In a browser, animation frames stop in hidden tabs; the server treats missing
  inputs as "no buttons held" after a few ticks instead of repeating the last one, and the client resyncs from the
  next snapshot when it comes back.
- **Host the server near the players** (for example Singapore for South-East Asia) and keep WebSocket support enabled
  on any reverse proxy in front of it.

## 6. Testing

- **A dedicated server and two or more clients on one machine** (headless browsers), every mode and map played, 0
  errors in every instance.
- **A lag simulator:** a small TCP proxy between the game and the server that delays every chunk by a base plus
  jitter in each direction (for example 70 ± 25 ms), keeping order. Run every multiplayer test through it as well.
- **A phone-speed client:** CPU throttling 4× on a client's page while measuring.
- **Measure, don't guess:**
  - key press to own character moving on screen (target: one to three frames, under about 50 ms, with lag on);
  - how often and how far reconciliation corrects the own character (near zero when nothing disagrees);
  - shots at a strafing target with lag on land where the shooter aimed (lag compensation works);
  - snapshot bytes and the interpolation delay and jitter under lag;
  - frame times on a client during a busy fight.
- **Cover the rare paths:** dying and respawning, a teleport mid-move, a map change mid-action, a client's tab
  hidden, a client reconnecting, packet bursts after a stall.

## 7. Troubleshooting

- **"CORS request did not succeed", status `(null)`:** the browser never got an answer, so the server was down,
  restarting or unreachable. Check the server directly (a health endpoint and the matchmaking call with the game's
  origin) before changing code.
- **WebSocket upgrade returns 404 or 400:** the reverse proxy is not passing the upgrade; turn on its WebSocket
  support.
- **Measure the route:** time a few connections to the server from where the players are (the first one includes DNS
  and TLS setup); find the server's region from its IP.

## 8. Improving further

- **UDP-style transport** (WebRTC data channels, or a platform relay) for larger or competitive games: one lost
  WebSocket packet holds up everything behind it.
- **Delta snapshots:** compact snapshots with deltas from the last acknowledged one.
- **Interest management:** send each player only what is near them.
- **A debug overlay** with ping, jitter, buffer delay, snapshot size, reconciliation corrections and dropped events.
- **A soak test with the maximum number of players** for several minutes.

## Checklist

- [ ] The model was chosen on purpose and written in the spec; each player's own actions answer within a few frames.
- [ ] Clients send sequenced inputs only; the server owns positions, health, hits, AI enemies and the score.
- [ ] Own movement is predicted with the shared sim and reconciled by replaying unacknowledged inputs; corrections
      ease out on screen; respawns and teleports bump a counter.
- [ ] Damage, kills and hit markers come from the server; shots are lag-compensated with a capped rewind.
- [ ] Interpolation with an adaptive buffer; late snapshots extrapolate; events never dropped.
- [ ] Frequent messages (snapshots, inputs) are binary with one shared layout; bytes per snapshot reported.
- [ ] Personal feedback goes to its player only; no echoes; nothing pauses the match.
- [ ] Protocol versioned; server checks size, rate, senders and impossible inputs; reconnection; hidden tabs handled.
- [ ] Tested with a dedicated server, two or more clients, a lag simulator and a throttled client, with the numbers
      reported.
