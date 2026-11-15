# DROPLINE (working title)

A browser first-person shooter with pilot movement (wallrun, double jump, slide,
mantle, jetpack thrust) and, later, callable war mechs. Original game: its own
name, designs and assets.

Current state: **gunplay prototype**. A 4-v-4 skirmish against bots on the test
map: one player and three allied bots against four enemy bots, first team to 30
eliminations. Three weapons, health that regenerates, respawns. Offline only; no
mechs or networking yet.

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
| `pnpm test` | Run the headless movement, combat and bot tests |
| `pnpm typecheck` | Type-check all packages |
| `pnpm build` | Production build of the client |
| `pnpm dev:server` | Play a bots-only match headless in Node and print the score |

Address options: `?seed=123` replays a given match, `?qa=1` shows every bot's
role, state and attack token over its head.

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
| 1 2 3, Q, mouse wheel | Switch weapon |
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

Shooting works while sprinting, sliding, wallrunning and in the air, at a small
cost in spread. Recoil kicks the view and settles back on its own.

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
  combat.json           Health, respawn, score limit, hitboxes, teams
  bots.json             Bot senses and per-role behaviour
  weapons/*.json        One file per weapon
  maps/gym.json         Test map: boxes and team spawn points
  mechs/                (later)
assets/               Models (GLB), textures, audio
packages/
  shared/             Simulation that runs on both client and server
    src/sim/movement.ts   Pilot movement, one fixed tick at a time
    src/sim/match.ts      Weapons, damage, respawns, score: one tick of a match
    src/sim/hitscan.ts    Ray against a pilot's head and body
    src/sim/rng.ts        Seeded random numbers for everything gameplay
    src/sim/world.ts      Collision queries against the map
    src/ai/nav.ts         Walkable grid and A* paths
    src/ai/bot.ts         Bot senses, states, aim and movement
    src/net/              (later) protocol
    tests/                Headless movement, combat and bot tests
  client/             Browser game (Three.js, Vite)
    src/game.ts           Fixed-tick loop, events to effects, frame rendering
    src/input/            Keyboard, mouse, pointer lock, bindings
    src/camera/           First / third person camera, recoil, zoom
    src/render/           Scene, map, pilots, first-person weapons, effects
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
- **Models:** pilots and weapons are built from boxes with procedural animation.
- **Pilots do not collide with each other**, only with the map.
- **Bots stay on the ground floor.** They jump and slide but do not plan routes
  over ledges or walls.
- No settings screen, gamepad or touch controls yet.

## Roadmap

1. Movement prototype (done)
2. Gunplay and offline bots (this)
3. Mech: call-in, embark, mech combat
4. Multiplayer: dedicated server, prediction, lag compensation
5. Content and polish
6. Deployment
