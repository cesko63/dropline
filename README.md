# DROPLINE (working title)

A browser first-person shooter with pilot movement (wallrun, double jump, slide,
mantle, jetpack thrust) and, later, callable war mechs. Original game: its own
name, designs and assets.

Current state: **movement prototype**. One pilot on a test map, first and third
person, no weapons, bots, mechs or networking yet.

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
| `pnpm test` | Run the headless movement tests |
| `pnpm typecheck` | Type-check all packages |
| `pnpm build` | Production build of the client |
| `pnpm dev:server` | Run the server stub (proves the simulation runs in Node) |

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
| V | First / third person |
| R | Respawn |

## Layout

```
data/                 Engine-neutral game data (plain JSON)
  movement.json         All movement tuning values
  maps/gym.json         Test map: boxes with position, size, rotation, style
  weapons/, mechs/      (later)
assets/               Models (GLB), textures, audio
packages/
  shared/             Simulation that runs on both client and server
    src/sim/movement.ts   Pilot movement, one fixed tick at a time
    src/sim/world.ts      Collision queries against the map
    src/net/, src/ai/     (later) protocol, bots
    tests/                Headless movement tests
  client/             Browser game (Three.js, Vite)
    src/game.ts           Fixed-tick loop and frame rendering
    src/input/            Keyboard, mouse, pointer lock, key bindings
    src/camera/           First / third person camera
    src/render/           Scene, map meshes, avatar, weapon viewmodel
    src/ui/               HUD
  server/             Authoritative server (stub for now)
```

## Design rules

- **Movement lives in `shared`.** `stepPlayer(state, input, world, dt)` depends on
  nothing else, so the server can be the authority and the client can predict.
- **Tuning and maps live in `data/` as JSON**, in meters with Y up. This keeps a
  later port to another engine (for example Roblox) cheap. Change how movement
  feels in `data/movement.json`; the dev server reloads on save.
- **The simulation runs at a fixed 60 Hz**; rendering interpolates between ticks.

## Roadmap

1. Movement prototype (this)
2. Gunplay and offline bots
3. Mech: call-in, embark, mech combat
4. Multiplayer: dedicated server, prediction, lag compensation
5. Content and polish
6. Deployment
