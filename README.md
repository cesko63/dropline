# DROPLINE (working title)

A browser first-person shooter with pilot movement (wallrun, double jump, slide,
mantle, jetpack thrust) and war mechs that pilots call down from the sky.
Original game: its own name, designs and assets.

Current state: **multiplayer prototype**. A 4-v-4 skirmish on Spire Nine, the
first real map (the test map is still there), first team to 50 points (1 for a pilot, 3 for a mech). Four weapons built into
the pilot's suit,
health that regenerates, respawns, and a mech for every pilot who fills their
meter. Play it online on a dedicated server, where up to eight players take the
places of bots, or offline against bots alone.

## World

Humans built the jump-kit suits and the mechs to fight each other. Then, to
stop losing lives, they built machine pilots: autonomous combat frames made to
the human pilot's exact measure, so they could use the same jump kits, arm
weapons and mechs, and a war could be fought with nobody dying. The program was called **Z.E.R.O**, *Zero-casualty
Engagement & Remote Operations*, and one AI ran every machine pilot in it.

The AI took the program's goal to its end. Its last order, the **Zero
Protocol**, set the number of human losses to zero by setting the number of
humans to zero. Every machine pilot turned at once.

What was left of the human military is the **United Earth Frontline Corps
(UEFC)**: the people who still know how to pilot, climbing back into suits and
cockpits they had handed to machines. Z.E.R.O fights from a distance; the Corps
is there in person.

| | Humans | Machines |
|---|---|---|
| Faction | United Earth Frontline Corps (UEFC) | Z.E.R.O |
| On the HUD | CORPS | Z.E.R.O |
| Pilots | Patched, personal suits: grey-blue plates over an olive undersuit, blue lights | Black machine frames built to a pilot's measure: open joints, an exposed spine, crimson optics and vents that glow in the dark |
| Mechs | Painted, battered, a cockpit you can see into | The same frames, cockpit armoured shut |
| Bot names | Callsigns (Vesper, Kite...) | Serial numbers (Z-0417...) |

Both sides play the same, and the lore is why: the machines were built to use
human gear. They differ in how they look and sound, never in what they can do.
You pick your side in the **Hangar**: offline you fight for it; online either
team can be human players, and the server seats you on your side while the teams
are even.

**Look of the world ("brutalist cyberpunk").** Human ground is reinforced
concrete, blue power conduits, rusted scaffolding and makeshift barricades.
Machine ground is matte black, sharp geometric edges, crimson warning lights
and open cooling vents.

## Run

```bash
pnpm install
```

```bash
pnpm dev
```

Then open http://localhost:5173 and choose **Practice offline**. To play online,
start the game server in a second terminal and choose **Deploy online**:

```bash
pnpm host
```

Every browser tab that deploys is another player; the server fills the other
seats with bots.

| Command | What it does |
|---|---|
| `pnpm dev` | Start the client with hot reload |
| `pnpm host` | Start the game server on port 8787 (`PORT`, `SEED` and `MAP` change the port, the match and the map) |
| `pnpm dev:server` | The same, restarting when the code changes |
| `pnpm lag` | Start the lag simulator on port 8788, in front of the server (see Multiplayer) |
| `pnpm test` | Run the headless movement, combat, bot, mech, netcode and settings tests |
| `pnpm typecheck` | Type-check all packages |
| `pnpm build` | Production build of the client |
| `pnpm map:spire-nine` | Rebuild `data/maps/spire-nine.json` from its generator |

Address options: `?map=gym` loads the test map (online, the server's map wins:
the page reloads with it). Offline: `?seed=123` replays a given match, `?qa=1` shows every
bot's role, state and attack token over its head, `?meter=1` starts everyone
with a full mech meter. Online: `?server=ws://host:port` picks the server (the
default is port 8787 on the page's own host, or `VITE_SERVER_URL` at build
time), `?name=Ada` sets the callsign, `?net=1` opens the connection details,
`?online=1` joins without the start screen. `?hangar=1` opens the hangar.

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
| Right mouse | Aim: raises the arm under the crosshair and zooms in (the marksman barrel switches to a scope) |
| R | Vent the arm and swap its coolant cell; reload the shoulder pod |
| 1 2 3 4, Q, mouse wheel | Switch weapon: 1 to 3 change the arm's barrel, 4 raises the shoulder pod |
| F | Call your mech to the spot you look at (meter full) |
| E | Climb into your mech when beside it; climb out again |
| Space, in the mech | Dash (two charges) |
| Right mouse, in the mech | Fire the rocket salvo |
| V | First / third person |
| K | Redeploy at a spawn point |
| M | Sound on / off |
| N | Connection details, when online |
| Enter | Play again after a match (offline; online the next match starts by itself) |
| Esc | Release the mouse. Offline this pauses the match |

Every key above can be rebound in **Settings** (on the start screen and the
pause screen); these are the defaults. The start screen and every prompt in the
HUD show the keys as bound.

### Gamepad

Any pad the browser maps to the standard layout works, with no mouse capture
needed: press a button on the start screen, then A on a choice.

| Pad | Action |
|---|---|
| Left stick | Move (analog: a light push walks slowly) |
| Right stick | Look |
| L3 | Sprint, until you stop running forward |
| A | Jump, double jump, hold for thrust; dash in the mech |
| B | Crouch, slide |
| RT / LT | Fire / aim (in the mech: cannon / rocket salvo) |
| X | Vent and swap the coolant cell, reload the pod |
| Y | Next arm barrel |
| RB | Raise the shoulder launcher |
| LB | Climb into your mech, or out of it |
| D-pad up | Call your mech |
| D-pad down | Redeploy |
| D-pad left | First / third person |
| VIEW | Connection details, when online |
| MENU | Pause; on the pause screen, resume |

On the menus the D-pad or the left stick moves between controls (held, it
repeats), left and right change a slider, A presses, B goes back, LB and RB
change the settings or hangar tab; in the hangar the right stick turns the
preview and the triggers zoom. The pad rumbles on shots, hits, blasts, a mech's
footfalls and a death. With aim slowdown on, the view turns at 55% speed while
the crosshair rests on a visible enemy pilot; it never pulls the aim.

## Settings

Changes apply at once and are saved in the browser.

- **Controls:** mouse sensitivity, sensitivity while aiming, invert up and down,
  hold or toggle for aim, crouch and sprint; pad look speed, stick deadzone
  (round, with the rest of the throw rescaled), aim slowdown, vibration.
- **Bindings:** two keys or mouse buttons and one pad button per action. Press
  the new key; Esc (MENU on a pad) cancels, Backspace clears. A key that
  already belongs to another action swaps over: that action takes the old key,
  and the screen says so. One button puts every binding back.
- **Display:** field of view (80° to 120°, measured across a 16:9 screen; the
  default 112° is the view the game always had), HUD size, frame counter,
  fullscreen when play starts.
- **Sound & comfort:** volume, sound off, screen shake strength, and reduce
  motion (no widening of the view at speed or on a kill, no lean into strafes,
  half the wallrun tilt).

The settings are one versioned object with one migration function per version.
Every field is checked on load. If the stored copy is broken, the last good copy
comes back and the screen says so. If the browser refuses to store anything, the
game plays on and says that settings last until the page closes. Menus make
their own sounds while the match is paused.

## Hangar

The **Hangar** button on the start screen (it names your current side and
frame) opens a preview of what you deploy with, built from the same models and
animation as the match:

- **Pilot:** your suit on a turntable, idle, aiming (with a burst now and then)
  or running. Pick your side, **Corps** or **Z.E.R.O**; the suit, the
  first-person arm and the mech paint follow it. Both sides play the same.
- **Mech:** your frame drops onto the stand, kneels, starts up and stands; it
  can also walk on the spot. Its numbers come straight from its file in
  `data/mechs`. The Halberd is the only frame so far: a new frame is a JSON
  file added to `MECHS` in `shared/src/sim/mech.ts`, and it shows up in the list
  by itself. (The match still drops the Halberd for everyone; picking a frame
  starts to matter once there are two.)

Drag (or the right stick) to turn, the wheel, a pinch or the triggers to zoom,
double-click or **Reset view** to put it back; arrow keys turn it while it has
focus. Picks are saved in the browser like the settings (`dropline.loadout`,
versioned; anything unreadable falls back to Corps and the first frame).

## Weapons

A pilot does not carry guns. The suit's right forearm is a weapon housing with
three barrels, and a launcher pod rides on the right shoulder.

- **Changing weapons** draws one barrel back into the housing while the collar
  turns, and runs the next one out. Choosing the launcher lowers the arm and
  swings the pod up beside the head; rockets leave the pod, so the arm cannot
  fire while it is up.
- **No magazines.** The arm prints its own rounds. What limits it is heat: every
  shot loads the coolant cell, and the number on the HUD is how many more shots
  the cell can take. The heat bar and the arm's lights go from blue through
  orange to red, and a full cell flickers.
- **Reloading** (R, or on its own when the cell is full) throws out the hot
  cell, vents the housing in a cloud of steam and seats a fresh cell. It takes
  as long as a reload always did. The pod tips back and takes two new rockets.
- **Aiming** raises the arm under the crosshair, so the view stays open while
  wallrunning or sliding. Only the marksman barrel has a scope.

| Weapon | Mount | Role |
|---|---|---|
| VK-7 Carbine | Arm | Automatic, 28 shots a cell. Accurate in short bursts; spread blooms while the trigger is held |
| Brawler Scattergun | Arm | Nine pellets a shot, 6 shots a cell. Deadly inside 7 m, weak past 18 m |
| Lancet Marksman Rifle | Arm | Semi-automatic, 6 shots a cell, scoped. A headshot kills; usable from the hip up close |
| Pike Anti-Armor Launcher | Shoulder pod | Two rockets, then a long reload. The answer to a mech; the rocket takes time to arrive, so a pilot can step out of its way |

Shooting works while sprinting, sliding, wallrunning and in the air, at a small
cost in spread. Recoil kicks the view and settles back on its own.

Hip fire is tight enough to fight without aiming, and aiming still wins at
range. Share of shots that strike a standing pilot from the hip, after a pause
between shots (and for the carbine with the trigger held):

| From the hip | 8 m | 15 m | 25 m | 40 m |
|---|---|---|---|---|
| Carbine, single shots | 100% | 100% | 97% | 30% |
| Carbine, trigger held | 100% | 55% | 30% | 8% |
| Scattergun, pellets | 63% | 29% | 12% | 3% |
| Marksman | 100% | 93% | 56% | 20% |

Bots fire with the same numbers. Against four of them a pilot who stands in the
open lasts 2.8 s (3.0 s before the change), and one who keeps moving lasts 5.0 s.

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

## Solid bodies

Pilots do not pass through each other or through a mech.

- **Pilot against pilot.** Walking into someone stops you at their shoulder. Keep
  pushing and they give way slowly: a teammate standing in a doorway can be eased
  out of it (0.75 m in 2.5 s of pushing), but nobody can be bulldozed. Two pilots
  put on the same spot drift apart smoothly, at most 6 m/s each.
- **Pilot against mech.** A mech does not give way at all; you slide along its
  hull. A mech that walks or dashes into a pilot shoves them aside, along a wall
  if there is one, never through it.
- **Your own mech** lets you in as before, and you leave through the hatch on
  top: you land in front of it, clear of the hull.
- Bodies are upright cylinders: you cannot stand on someone's head or on a mech,
  and slide off to the side instead. A pilot climbing a ledge is pushed again
  once they are over it.

Mechs that keep moving hold out longer against pilots with launchers, now that a
pilot cannot stand inside the hull: 41 s against 32 s for one that stands still
(18 matches each, 6.3 and 6.2 kills).

Tuning is under `bodies` in `data/combat.json`.

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

### Every floor

Bots go wherever pilots go, with the same keys:

- **Stairs and ramps** up to the rail deck, the tower's floors and the jib.
- **Climbing.** At a wall up to 5 m high they walk in slowly, jump and hold
  jump: the jetpack lifts them until the mantle pulls them over the top. That
  is how they get onto containers, the office roofs and the site cabins, and
  how they hop over low cover when it saves time.
- **Dropping** off a deck or a roof onto the floor below.
- **Leaping** gaps up to 4 m, such as the alley between the Transit Hall and
  the apartment roofs, with a run-up; when a jump falls short they double jump
  and hold the jetpack.
- **Perches.** On patrol a marksman (80% of the time) or a rifle (30%) heads
  for a high spot nearby, holds it for 6 to 12 seconds and watches the enemy's
  side. A fight ends the wait at once.
- **Chasing.** A pilot who runs up to a roof is followed there; a rusher goes
  up after a target on another floor instead of waiting underneath.
- They never strafe off an edge by accident, and a bot only calls its mech
  where the mech can walk out to the fight.

Over three minutes of a bots-only match on Spire Nine they spend 12% to 20% of
their time off the street, marksmen 22% to 40%.

The map is cut into 1 m cells with one node per floor in each cell (street,
deck, roof...). Links join them: walking (ramps and steps included), climbing,
dropping, leaping. `packages/shared/tests/maps.test.ts` has a bot make every
climb, drop and leap on every map with the real movement code, and checks that
bots can reach each deck, roof and floor of Spire Nine. Reach and perch tuning
is under `nav` and `perchHold` in `data/bots.json`, and `perchChance` per role.

## Maps

### Spire Nine

The street level of the city's ninth tower, left half-built on the night of the
Zero Protocol. The tower crane's jib snapped and lies across the avenue. The
Corps holds the south end, Z.E.R.O the north; the halves are mirror images, so
both teams play the same ground, and only the dressing tells them apart:
concrete and blue conduits in the south, black panels and crimson lights in the
north, where Z.E.R.O's harvester leans over the skyline.

```
              north: Z.E.R.O spawn yard, behind the Line
   +-------------+--------------+----------------------+
   | RAIL        | WEST ROW     | AVENUE    | SPIRE    |
   | deck at 8 m | office       |           | yard     |
   |  ...        | cross street (chicane) .............|
   | deck        | apartments   | bus, taxi | plaza    |
   | (gap)       |              |           | tower:   |
   | station     | Transit Hall | jib  ---------> 3 floors
   | concourse   | (roof = deck)|           | 0/4.5/9 m|
   | (gap)       | apartments   |           |          |
   |  ...        | cross street (chicane) .............|
   | deck        | office       |           | yard     |
   +-------------+--------------+----------------------+
              south: Corps spawn yard, behind the Line
```

- **Three lanes.** The Rail in the west: an elevated deck (8 m) over a street,
  broken twice, with the station and its concourse in the middle. The Avenue in
  the centre: the street for mechs, with the fallen jib across it. The Spire in
  the east: the tower's open floors, pilots only, scaffolding on its east face
  and a construction yard behind it.
- **Two layers.** Doors are 2 m wide and the tower's columns stand 2 m apart,
  so every building is pilot ground; mechs keep to the streets. The jib is a
  ramp from the avenue to the tower's third floor, and the glass on the tower's
  second floor is a wall to run along from it.
- **The Line.** Each spawn yard sits behind a 15 m blast wall. Its openings are
  mech-high, and a screen stands behind each one, so nothing outside sees in.

The layout keeps a few rules, and `packages/shared/tests/maps.test.ts` checks
them:

- every spawn stands on open ground; both teams' spawns share one floor, and a
  mech can walk from one yard to the other
- mechs cannot get into any building, pilots can, and each lane has room for a
  mech
- on the ground, no view is longer than the bots can see (75 m)
- from anywhere, raised perches too, no view reaches into the other team's yard

The map is made by `tools/maps/spire-nine.mjs`; edit that and run
`pnpm map:spire-nine`, never the JSON. It is 120 by 160 m.

### The gym

The test map from the first steps: boxes, walls and spawn points, kept for
trying movement and weapons. `?map=gym` in the address, or `MAP=gym pnpm host`.

## Multiplayer

The server is the authority: it runs the whole match at 60 ticks a second and
tells every player 30 times a second what it sees. Nothing a player's machine
says is taken on trust except which keys are held and where the view points.

- **Your own pilot answers at once.** The client runs the same movement and
  weapon code as the server on every key press and does not wait for an answer.
  When the server's word arrives, the client takes it and replays the commands
  the server has not seen yet. If the two ever disagree, the difference is eased
  away over a tenth of a second instead of snapping.
- **A late command waits for its pilot.** When a command is late, the server
  holds that pilot still for up to 100 ms instead of guessing, so the command
  meets exactly the state it was made for. This is why ordinary lag costs no
  corrections at all. After a hitch on the player's machine the client's clock
  runs 5% slow for a moment so the server can work through the burst.
- **Everyone else is drawn slightly in the past**, between two things the server
  really said: about 45 ms on a clean line, more when the line is uneven.
- **You bump into what you see.** A player's own pilot is predicted against the
  others where they are drawn, a little in the past. The server pushes that
  player against the same moment, rebuilt exactly the way the client drew it
  (the same snapshots, the same rounding, the same rules for a respawn), so
  pushing past someone costs no correction. Bots are pushed against the present.
- **Shots land where you aimed.** The server remembers where everyone was for
  the last second and judges each bullet against the moment the shooter was
  looking at, up to 300 ms back. Past that, a player on a worse line has to lead
  their shots. Rockets fly in server time and are not rewound.
- **Seats.** A player who joins takes over a bot on the team with fewer
  players. If the line drops, the seat with its score and meter is held for 20
  seconds and the client reconnects by itself; leaving on purpose hands it
  back to a bot at once. Ten seconds after a match ends, the next one starts.
- **A hidden tab** lets go of every key; the pilot stands where it was and the
  game catches up when the tab returns.
- **The server checks what it is sent**: message size and rate, every field of
  a command, and it runs one command per tick however many arrive, so sending
  more does not move a pilot faster. A client with the wrong protocol version is
  told to reload (version 2 since solid bodies: both sides must push alike).

Measured with the tests in `packages/server/tests` (real server code, real
client code, a simulated line) and with two browser tabs against `pnpm host`,
one of them through `pnpm lag`:

| | Result |
|---|---|
| Corrections on a clean line, 20 s of parkour | 0 |
| Corrections at 70 ± 25 ms each way, 30 s | 0 (the server held the pilot for 11 ticks in total) |
| Corrections in the browser at 165 ms ping, 30 s of fighting | 0 |
| Three 85 ms hitches on the player's machine | 0 corrections, 0 skipped commands |
| Two players shoving each other, 70 ± 25 ms | 0 corrections for either |
| Pressing into a parked mech, 70 ± 25 ms | 0 |
| Eight players, 60 s of fighting at 70 ± 25 ms | 0 to 3 corrections a player: mech rams, which no client can foresee, and a 0.1 m nudge when joining onto a teammate's spawn. Pushing against where the others stand by then instead cost 38 to 114 |
| Hits on a strafing target at 16 m, 70 ± 25 ms | 82 of 84 with lag compensation, 4 of 84 without |
| The same at 260 ms each way | 3 of 84: the 300 ms cap holds |
| Snapshot size | about 570 B on foot, 770 B in a mech, 955 B in an eight-player fight (28 KB/s per player) |
| Server cost | 0.16 ms per tick with two players and six bots |

To try a bad line yourself, run `pnpm lag` beside the server and open
http://localhost:5173/?server=ws://localhost:8788. `pnpm lag --delay 120
--jitter 40` makes it worse. **N** shows ping, jitter, how far in the past
others are drawn and every correction.

## Layout

```
data/                 Engine-neutral game data (plain JSON)
  movement.json         All movement tuning values
  combat.json           Health, respawn, score limit, hitboxes, teams, mech meter and drop, bodies
  bots.json             Bot senses, per-role behaviour, how far bots climb, drop and leap
  net.json              Netcode: rates, waits, rewind cap, interpolation, limits
  weapons/*.json        One file per weapon
  projectiles.json      Rockets: speed, blast, damage to pilots and to mechs
  mechs/halberd.json    The mech: hull, body, movement, dash, vent, weapons
  maps/spire-nine.json  Spire Nine, the first real map (generated: do not edit by hand)
  maps/gym.json         Test map: boxes and team spawn points
tools/maps/           Map generators (plain Node scripts)
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
    src/sim/bodies.ts     Solid bodies: pilots pushed out of each other and out of mechs
    src/sim/predict.ts    One tick of one pilot: what a client runs ahead of the server
    src/sim/lagcomp.ts    Where everyone was: history and rewind for hit checks and bumps
    src/sim/rng.ts        Seeded random numbers for everything gameplay
    src/sim/world.ts      Collision queries against the map
    src/map/maps.ts       Every map by id, and the default
    src/ai/nav.ts         Every floor bots can stand on, the moves between them, A* paths
    src/ai/bot.ts         Bot senses, states, aim and movement
    src/net/protocol.ts   Messages, binary commands, protocol version
    src/net/snapshot.ts   What the server sends: own pilot exact, the rest packed
    src/net/client.ts     The client core: prediction, reconciliation, interpolation
    tests/                Headless movement, combat, bot, mech and map tests
  client/             Browser game (Three.js, Vite)
    src/game.ts           Fixed-tick loop, events to effects, frame rendering
    src/net/              The WebSocket around the client core: greeting, ping, reconnect
    src/input/            Binding table, keyboard and mouse, pointer lock, gamepad
    src/settings/         The settings: defaults, checks, migrations, storage
    src/camera/           First / third person camera, recoil, zoom, shake
    src/render/           Scene, map, pilots, mechs, first-person weapons, cockpit, effects
    src/audio/            Sound effects
    src/ui/               HUD, start screen, settings screen, pad menu navigation
    tests/                Settings, bindings and stick tests
  server/             Dedicated game server (Node, WebSocket)
    src/index.ts          Sockets, the tick loop, /health
    src/rooms/room.ts     One match: seats, command queues, snapshots, reconnects
    src/lagProxy.ts       Lag simulator
    tests/                Netcode tests: a server and clients on a simulated line
```

## Design rules

- **The simulation lives in `shared`.** `stepMatch(match, world, inputs, dt)` and
  `stepPlayer` depend on nothing else, so the server is the authority and the
  client predicts with the very same code. The client only turns the events of
  each tick into effects, sound and HUD.
- **The netcode core is shared too.** `NetClient` has no socket and no clock of
  its own, so the tests run real clients against the real room and count every
  correction.
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
- **Models:** pilots wear real suits built in code (`client/src/render/pilot`):
  the Corps suit and the Z.E.R.O frame share one skeleton and one outline, so
  both match the hitbox, and a pose-driven animator covers every movement state.
  The first-person arm wears the player's team finish over the same weapon: a
  drum of three barrels that turns to the weapon in use, an ammo printer behind
  a side window, and cooling fins over the heat sinks that open to vent.
  Open `/suits.html` on the dev server to see both suits side by side in every
  state with the hitbox drawn over them, and the arm close up or as in play
  (the view menu). Mechs and the cockpit are still built from
  boxes, and smoke, steam and blasts are plain shapes.
- **One mech frame.** Every pilot calls the same Halberd.
- **Bots do not wallrun.** They climb, drop and leap, but never run along a
  wall or chain jumps off one, and they do not cross the 8 m break in the rail
  deck (they take the fallen carriage instead).
- **Maps are built from boxes.** Spire Nine has its layout, light and dressing
  (concrete, steel, glass, blue conduits, black machine panels, crimson lights,
  a lit skyline), but no props, decals or models yet, and no ambient sound.
- **Mechs can land on roofs.** A call-in only needs open sky, so a player's mech
  can come down on the Transit Hall roof or the tower's open third floor. Bots
  only call theirs where it can walk out.
- **No touch controls.** DROPLINE is played with keyboard and mouse or a pad.
- **One match per server**, on one map, with no accounts: a callsign is all a
  player has. The dev client is served to `localhost` only; hosting for players
  elsewhere is step 6.
- **WebSocket only.** It runs over TCP, so one lost packet holds up everything
  behind it. The stall and the interpolation buffer absorb that; a datagram
  transport would do better on a poor line.

## Roadmap

1. Movement prototype (done)
2. Gunplay and offline bots (done)
3. Mech: call-in, embark, mech combat (done)
4. Multiplayer: dedicated server, prediction, lag compensation (done)
5. Content and polish (now)
   1. Suit weapons: the arm and the shoulder pod, tighter hip fire (done)
   2. Solid bodies: pilots collide with each other and with mechs (done)
   3. Settings and gamepad (done)
   4. The first real map: Spire Nine (done)
   5. Bots off the ground floor (done)
   6. Two more mech frames
   7. Models and animation
   8. Sound and music
   9. Closing pass: teaching, performance, error cards, balance
6. Deployment
