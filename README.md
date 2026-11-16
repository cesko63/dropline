# DROPLINE (working title)

A browser first-person shooter with pilot movement (wallrun, double jump, slide,
mantle, jetpack thrust) and war mechs that pilots call down from the sky.
Original game: its own name, designs and assets.

Current state: **mech prototype**. A 4-v-4 skirmish against bots on the test
map: one player and three allied bots against four enemy bots, first team to 50
points (1 for a pilot, 3 for a mech). Four pilot weapons, health that
regenerates, respawns, and a mech for every pilot who fills their meter. Offline
only; no networking yet.

## Run

```bash
pnpm install
```

```bash
pnpm dev
```

Then open http://localhost:5173 and click to capture the mouse.

| Command | What it does |
|---|---|
| `pnpm dev` | Start the client with hot reload |
| `pnpm test` | Run the headless movement, combat, bot and mech tests |
| `pnpm typecheck` | Type-check all packages |
| `pnpm build` | Production build of the client |
| `pnpm dev:server` | Play a bots-only match headless in Node and print the score |

Address options: `?seed=123` replays a given match, `?qa=1` shows every bot's
role, state and attack token over its head, `?meter=1` starts everyone with a
full mech meter.

## Controls

| Input | Action |
|---|---|
| W A S D | Move |
| Shift | Sprint |
| Space | Jump; press again in the air to double jump |
| Hold Space in the air | Jetpack thrust (burns the THRUST bar) |
| C | Crouch; slide when pressed while sprinting (one press per slide) |
| Jump at a wall | Wallrun. Space leaps off: steer away to cross, steer into the wall to hop back onto it |
| Forward at a ledge | Mantle up |
| Left mouse | Fire |
| Right mouse | Aim down sights (the marksman rifle switches to a scope) |
| R | Reload |
| 1 2 3 4, Q, mouse wheel | Switch weapon |
| F | Call your mech to the spot you look at (meter full) |
| E | Climb into your mech when beside it; climb out again |
| Space, in the mech | Dash (two charges) |
| Right mouse, in the mech | Fire the rocket salvo |
| V | First / third person |
| K | Redeploy at a spawn point |
| M | Sound on / off |
| Enter | Play again after a match |
| Esc | Pause and release the mouse |

## Weapons

| Weapon | Role |
|---|---|
| VK-7 Carbine | Automatic, 28 rounds. Accurate in short bursts; spread blooms while the trigger is held |
| Brawler Scattergun | Nine pellets a shot, 6 shells. Deadly inside 7 m, weak past 18 m |
| Lancet Marksman Rifle | Semi-automatic, 6 rounds, scoped. A headshot kills; wild from the hip |
| Pike Anti-Armor Launcher | Two rockets, then a long reload. The answer to a mech; the rocket takes time to arrive, so a pilot can step out of its way |

Shooting works while sprinting, sliding, wallrunning and in the air, at a small
cost in spread. Recoil kicks the view and settles back on its own.

## The mech

Every pilot has a meter that fills on its own in about two minutes, and faster
with damage dealt and eliminations. When it is full, **F** calls a Halberd.

- **The drop.** It lands 2.4 seconds later where you were looking (within 45 m,
  under open sky), or beside you if that spot will not do. A ring on the ground
  shows where: blue for a friendly mech, red for an enemy one. An enemy pilot
  still inside the ring when it lands is crushed.
- **Getting in.** It kneels and waits. Walk up, press **E**, and one second later
  it is yours. **E** again and you leave through the top hatch with your own
  weapons; the mech waits where you left it.
- **Driving.** 2600 hull that does not repair itself. It is slow, cannot jump or
  crouch, and does not fit under low cover. **Space** is a dash in the direction
  you are moving: two charges, each back after 4.5 seconds, and it rams whatever
  it runs into.
- **Weapons.** Left mouse is the HX-40 autocannon. Right mouse fires four rockets
  from the shoulder pod at the point you look at, then needs 9 seconds.
- **Bringing one down.** Small arms barely scratch the hull. The Pike takes about
  eight rockets from the front, or five into the glowing vent on its back, which
  takes 1.6 times the damage from everything. A mech that dashes and strafes makes
  rockets miss.
- **Losing it.** The pilot is thrown clear, alive and high in the air, the enemy
  team scores 3, and the meter starts again from empty.

Bots do all of this too: they call their mech when the meter fills, walk to it,
fight from the cockpit, and on foot they switch to the launcher and keep their
distance when a mech shows up.

## Bots

Bots press the same inputs as a player and run on the same movement code. Each
has a role with its own tell:

| Role | What it does | How to read it |
|---|---|---|
| Rifle | Holds 9 to 26 m, strafes, fires in bursts | A "!" and a chirp when it spots you, then a short pause before it shoots |
| Rusher | Sprints and slides in with a scattergun | It runs straight at you; keep your distance |
| Marksman | Stands still and lines up one heavy shot | A yellow laser tracks you while a whine rises; the beam turns red and thick for the last quarter and stops tracking. Change direction then |

They see through a view cone with line of sight, hear gunfire, search where they
last saw you, and only two of them may fire on the same target at once. Speed
across their view is what makes them miss.

## Layout

```
data/                 Engine-neutral game data (plain JSON)
  movement.json         All movement tuning values
  combat.json           Health, respawn, score limit, hitboxes, teams, mech meter and drop
  bots.json             Bot senses and per-role behaviour
  weapons/*.json        One file per weapon
  projectiles.json      Rockets: speed, blast, damage to pilots and to mechs
  mechs/halberd.json    The mech: hull, body, movement, dash, vent, weapons
  maps/gym.json         Test map: boxes and team spawn points
assets/               Models (GLB), textures, audio
packages/
  shared/             Simulation that runs on both client and server
    src/sim/movement.ts   Pilot movement, one fixed tick at a time
    src/sim/match.ts      Weapons, respawns, score: one tick of a match
    src/sim/rules.ts      Damage, kills, score, getting in and out of a mech
    src/sim/mech.ts       The mech itself: body, movement, dash, hitbox
    src/sim/mechMatch.ts  Meter, call-in, landing, ramming, the rocket salvo
    src/sim/projectiles.ts Rockets in flight and their blast
    src/sim/hitscan.ts    Ray against a pilot's head and body
    src/sim/rng.ts        Seeded random numbers for everything gameplay
    src/sim/world.ts      Collision queries against the map
    src/ai/nav.ts         Walkable grid and A* paths
    src/ai/bot.ts         Bot senses, states, aim and movement
    src/net/              (later) protocol
    tests/                Headless movement, combat, bot and mech tests
  client/             Browser game (Three.js, Vite)
    src/game.ts           Fixed-tick loop, events to effects, frame rendering
    src/input/            Keyboard, mouse, pointer lock, bindings
    src/camera/           First / third person camera, recoil, zoom, shake
    src/render/           Scene, map, pilots, mechs, first-person weapons, cockpit, effects
    src/audio/            Sound effects
    src/ui/               HUD
  server/             Authoritative server (stub for now)
```

## Design rules

- **The simulation lives in `shared`.** `stepMatch(match, world, inputs, dt)` and
  `stepPlayer` depend on nothing else, so the server can be the authority and the
  client can predict. The client only turns the events of each tick into effects,
  sound and HUD.
- **Gameplay randomness is seeded.** Spread, bot decisions and spawn choices draw
  from one generator stored in the match, so the same seed and inputs replay the
  same match. Effects use their own randomness.
- **Tuning and maps live in `data/` as JSON**, in meters with Y up. This keeps a
  later port to another engine (for example Roblox) cheap. Change how weapons,
  bots or movement feel there; the dev server reloads on save.
- **The simulation runs at a fixed 60 Hz**; rendering interpolates between ticks.

## Stand-ins

- **Sound:** every effect is synthesized from filtered noise and short tones
  (`client/src/audio/sfx.ts`). They carry timing and feedback until recorded
  audio replaces them.
- **Models:** pilots, mechs, weapons and the cockpit are built from boxes with
  procedural animation. Smoke and blasts are plain shapes.
- **Pilots do not collide with each other**, only with the map. A pilot can also
  walk through a mech; only mechs push each other apart.
- **One mech frame.** Every pilot calls the same Halberd.
- **Bots stay on the ground floor.** They jump and slide but do not plan routes
  over ledges or walls.
- No settings screen, gamepad or touch controls yet.

## Roadmap

1. Movement prototype (done)
2. Gunplay and offline bots (done)
3. Mech: call-in, embark, mech combat (this)
4. Multiplayer: dedicated server, prediction, lag compensation
5. Content and polish
6. Deployment
