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
| `pnpm test` | Run the headless movement, combat, bot, mech, netcode, settings and sound tests |
| `pnpm typecheck` | Type-check all packages |
| `pnpm build` | Production build of the client |
| `pnpm balance` | Play the rules headless and print the balance report: time to kill per weapon and range, time to down each mech, and 24 bot matches on Spire Nine (`pnpm balance -- 60` for 60) |
| `pnpm map:spire-nine` | Rebuild `data/maps/spire-nine.json` from its generator |
| `pnpm audio` | Rebuild `assets/audio`, `assets/music` and `AUDIO.md` from the CC0 recordings and music listed in `tools/audio/sounds.json` (needs ffmpeg) |

Address options: `?map=gym` loads the test map (online, the server's map wins:
the page reloads with it). Offline: `?seed=123` replays a given match, `?qa=1` shows every
bot's role, state and attack token over its head, `?meter=1` starts everyone
with a full mech meter. Online: `?server=ws://host:port` picks the server (the
default is port 8787 on the page's own host, or `VITE_SERVER_URL` at build
time), `?name=Ada` sets the callsign, `?net=1` opens the connection details,
`?online=1` joins without the start screen. `?hangar=1` opens the hangar.
`?perf=1` shows frame time, the worst frame, draw calls, triangles and the
resolution in the top left. `?fail=boot`, `?fail=frame` or `?fail=async` throws an error on purpose (at
start-up, three seconds into a match, or outside the game loop) to check the
error cards.

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
| T | Change the mech frame the next call brings: Halberd, Bastion, Lynx (the same pick as in the Hangar) |
| E | Climb into your mech when beside it; climb out again |
| Space, in the mech | The frame's move: dash (Halberd), stomp (Bastion), leap (Lynx) |
| Right mouse, in the mech | The frame's ability: rocket salvo (Halberd), hold up the shield (Bastion), cloak (Lynx) |
| V | First / third person |
| X | Swap shoulder (third person) |
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
| A | Jump, double jump, hold for thrust; the frame's move in the mech |
| B | Crouch, slide |
| RT / LT | Fire / aim (in the mech: cannon / the frame's ability) |
| X | Vent and swap the coolant cell, reload the pod |
| Y | Next arm barrel |
| RB | Raise the shoulder launcher |
| LB | Climb into your mech, or out of it |
| D-pad up | Call your mech |
| R3 | Change the mech frame |
| D-pad down | Redeploy |
| D-pad left | First / third person |
| D-pad right | Swap shoulder (third person) |
| VIEW | Connection details, when online |
| MENU | Pause; on the pause screen, resume |

On the menus the D-pad or the left stick moves between controls (held, it
repeats), left and right change a slider, A presses, B goes back, LB and RB
change the settings or hangar tab; in the hangar the right stick turns the
preview and the triggers zoom. The pad rumbles on shots, hits, blasts, a mech's
footfalls and a death. With aim slowdown on, the view turns at 55% speed while
the crosshair rests on a visible enemy pilot; it never pulls the aim.

## Learning to play

Nobody has to read the controls list first. In play, one short line under the
crosshair asks for one move at a time with its key (or pad button): move,
jump and double jump, jet thrust, slide, wallrun, change the arm's barrel, the
shoulder launcher. A line leaves the moment the move is done, with a tick,
and is never asked for again. One the player ignores steps aside after 15 s
and comes back 45 s later. The moments that matter jump the queue and stay
until they pass: the meter is full (call the mech), the mech is standing by
(go and climb in), the arm is nearly empty (vent it), and the first time in
each frame's cockpit (its move, then its ability). A move done before it is
asked for counts too. Taken down, the death card adds one tip that fits how
(a mech landing on you, a stomp, a marksman's laser, a headshot, a fall), once
per kind.

What a player has learned is kept with the settings, so a returning player
sees none of it. **Settings → Controls → Help** turns the tips off or shows
every one again; the full controls list stays on the start and pause screens.

## When something goes wrong

The game never freezes on a broken frame or shows a raw error. Each failure
gets a card in the game's own style that says what happened in plain words,
with a way out and a **Copy details** button for a bug report (what failed,
the map, seed and page, the browser, the error with its stack, and the last
few things that went wrong before it). Where the browser will not hand over
the clipboard, the details come up selected for copying by hand. The card
works with the mouse, the arrow keys and Esc, or a pad (A, B and the D-pad).

| What happened | The card offers |
|---|---|
| The game failed to load | Try again |
| The browser cannot draw WebGL | What to change, and Try again |
| An error in play (the match stops where it was) | Continue, Back to menu |
| The graphics card dropped the picture | Reload |
| No server answered, the server is full or said no | Try again, Practice offline, Back |
| The connection was lost and did not come back in 20 s | Try again, Practice offline, Back |
| The server runs a newer version | Reload, Practice offline, Back |

None of them touch the settings or the hangar picks. A sound or music track
that fails to download is tried once more; if it fails again the game plays
on without it and the start screen says how many are missing.

## Balance

`pnpm balance` plays the real rules headless: the weapon table (see Weapons), each
pilot weapon against each mech, and then whole matches with bots in all eight
seats on Spire Nine. Bots hit softer than players, by role, so the matches
show the balance a player meets offline. Results of 48 matches:

| | Result |
|---|---|
| Sides | Corps 44%, Z.E.R.O 56% (over the three runs of 24, 48 and 48 matches, Corps 47%: within chance) |
| Match length | 4.9 min median, 4.1 to 5.5 |
| Pilots killed by | Carbine 27%, Scattergun 23%, Halberd 20%, Marksman 10%, Lynx 9%, Bastion 9% |
| Bot roles on foot, kills per death | Scattergun 0.79, Carbine 0.55, Marksman 0.53 |
| Points a mech earns before it is destroyed | Halberd 2.9, Bastion 2.3, Lynx 3.4 (a mech destroyed gives the other side 3) |
| Points | 60% from pilots killed, 40% from mechs destroyed |

What 5.9 changed, and why:

- **The marksman rifle did not win at range.** Its spread from firing only
  shrank once the gun could fire again, so a marksman clicking at its full
  rate fired every shot after the first with three times the spread, and with
  perfect aim the carbine killed faster at every distance (60 m: 1.8 s against
  2.7 s). A semi-automatic now steadies between shots. Bots already paused
  long between shots, so this changes nothing for them.
- **The carbine reached too far:** its damage now falls off from 20 m to 50 m
  (it was 30 to 60), so past about 30 m the marksman is the better choice.
- **Scattergun bots killed twice as much as the others** (kills per death 0.93
  against about 0.5): they hit for 45% of a player's damage instead of 55%.
  A pilot standing in the open against four bots still lasts 2.8 s, and one
  who keeps moving 4.9 s, as before.
- **The Bastion earned the fewest points** (1.9 a call, under two-thirds of
  the others): its flak shell does 92 to pilots instead of 75, so a bot's
  Bastion downs a pilot with two shells instead of three. Its damage to mechs
  is the same, and so are the mech duels.

Still to watch: the Bastion is the weakest frame in full matches, and the
scattergun the strongest bot role; both are within about a fifth of the
others now. How any of this plays between people is untested.

## Performance

Measured on a 60 s offline match with the meter full (every pilot calling
mechs, firing and dying), stepping the game by hand in headless Chromium,
with the picture counted but not timed (the test machine has no graphics
card):

| | Before 5.9 | Now |
|---|---|---|
| Game work per frame, median | 1.2 ms | 1.3 ms |
| 99th percentile | 9 ms | 8 ms |
| Worst frame | 50 to 90 ms (the first body of the match) | 27 ms |
| First frame of play | 40 ms | 11 ms |
| With the processor slowed 4×, median and 99th percentile | | 7 ms and 26 ms |
| Draw calls in a busy view (world, shadows, arms) | 260 to 670 | the same |

What made the hitches, and what was done:

- **First times, now done behind the start screen:** all eight bots plan their
  first route on the same tick (the route finder was still cold), the first
  body's physics (about 30 ms), each mech frame's model the first time it is
  called, and the shaders of the mechs waiting out of sight.
- **A scattergun blast stained the suit once per pellet:** at most two new
  stains per pilot every tenth of a second now (the pellets land together).
- **The start screen** shows at once with "Loading the game …" and its buttons
  greyed out until the game is ready, so nothing looks clickable that is not.

The picture is the cost on an ordinary computer, so it can be turned down:
**Settings → Display → Graphics**. **Auto resolution** watches the time
between frames: slower than 48 a second for a second, and the game draws 15%
fewer pixels a step (down to half); smooth again for three seconds and it
climbs back. A step that did not make frames faster (a browser held to 30
frames a second, or a computer slow for another reason) is undone and not
tried again for 30 s, so the picture never goes soft for nothing.

Still to do: a mech is about 40 draw calls and the first-person arm about 90,
because their parts move on their own. Drawing each as one skinned mesh
would cut most of that. Memory stays level over long matches: script memory
was the same after two minutes of play as after ten seconds.

## Settings

Changes apply at once and are saved in the browser.

- **Controls:** mouse sensitivity, sensitivity while aiming, invert up and down,
  hold or toggle for aim, crouch and sprint; pad look speed, stick deadzone
  (round, with the rest of the throw rescaled), aim slowdown, vibration;
  coaching tips on or off, and a button that shows every tip again.
- **Bindings:** two keys or mouse buttons and one pad button per action. Press
  the new key; Esc (MENU on a pad) cancels, Backspace clears. A key that
  already belongs to another action swaps over: that action takes the old key,
  and the screen says so. One button puts every binding back.
- **Display:** field of view (80° to 120°, measured across a 16:9 screen; the
  default 112° is the view the game always had), HUD size, frame counter,
  fullscreen when play starts; graphics quality (High: sharp shadows and up to
  2× pixels on sharp screens; Medium: softer shadows, up to 1.25×; Low: no
  shadows, 1×) and auto resolution (on by default: see Performance).
- **Sound & comfort:** volume, music volume, sound off, screen shake strength, and reduce
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
  can also walk on the spot. Pick the **Halberd**, **Bastion** or **Lynx**
  (see "Three frames" below); the frame you pick is the one **F** calls in the
  match. Its numbers come straight from its file in `data/mechs`: a new frame
  is a JSON file added to `FRAME_LIST` in `shared/src/sim/mech.ts`, and it shows
  up in the list by itself.

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
cost in spread. Recoil kicks the view and settles back on its own. A
semi-automatic (the marksman, the scattergun, the launcher) steadies between
shots, so it is as accurate at its full rate of fire as when paced; an
automatic's spread grows while the trigger is held and shrinks once it rests.

Time to kill a standing pilot with perfect aim, every shot at the chest and
the recoil pulled back down (from `pnpm balance`). Each weapon owns a range:

| Aimed | 5 m | 10 m | 20 m | 35 m | 60 m |
|---|---|---|---|---|---|
| Carbine | 0.47 s | 0.47 s | 0.47 s | 0.68 s | 1.87 s |
| Scattergun | 0.02 s | 1.2 s | never | never | never |
| Marksman | 0.60 s | 0.60 s | 0.60 s | 0.60 s | 0.60 s |
| Launcher | 0.92 s | 0.98 s | 1.13 s | 1.35 s | 1.70 s |

The arm's barrels barely scratch a mech: only the launcher brings one down,
in about 11 s on its own (four rockets and a reload), which is why a mech is
a team's problem.

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
with damage dealt and eliminations. When it is full, **F** calls a mech of the
frame picked in the Hangar, or with **T** during play (shown on the meter, and
remembered between visits).
The rules below hold for all three frames; the frames differ in the next section.

- **The drop.** It lands 2.4 seconds later where you were looking (within 45 m,
  under open sky), or beside you if that spot will not do. A ring on the ground
  shows where: blue for a friendly mech, red for an enemy one. An enemy pilot
  still inside the ring when it lands is crushed.
- **Getting in.** It kneels and waits. Walk up, press **E**, and one second later
  it is yours. **E** again and you leave through the top hatch with your own
  weapons; the mech waits where you left it.
- **Driving.** A hull that does not repair itself. It is slow, cannot crouch,
  and does not fit under low cover. **Space** is the frame's move, **right
  mouse** its ability, left mouse its cannon.
- **Bringing one down.** Small arms barely scratch the hull. The Pike takes about
  eight rockets from the front of a Halberd, or five into the glowing vent on its
  back, which takes 1.6 times the damage from everything. A mech that keeps
  moving makes rockets miss.
- **Wear shows.** Past half its hull a mech trails grey smoke from its vent;
  past three quarters it pours black smoke and licks of fire.
- **Losing it.** The pilot is thrown clear, alive and high in the air, the enemy
  team scores 3, and the meter starts again from empty. The mech goes up in a
  fireball that flings burning plates; the wreck burns where it fell for about
  7 s, cooking off now and then, smoulders out, and sinks away after 16 s. It is
  only a picture: nothing collides with it.

Bots do all of this too: they call their mech when the meter fills, walk to it,
fight from the cockpit, and on foot they switch to the launcher and keep their
distance when a mech shows up.

### Three frames

| | Halberd | Bastion | Lynx |
|---|---|---|---|
| Role | All-rounder | Heavy: holds ground, covers allies | Light: hits from range, hard to pin down |
| Hull | 2600 | 2680 | 2200 |
| Speed (walk / run) | 5.2 / 7.4 m/s | 4.3 / 6.1 m/s | 6.6 / 9.4 m/s |
| Cannon (left mouse) | HX-40 autocannon: fast, accurate | BK-8 Breaker flak: shells that burst beside pilots and mechs, forgiving aim | LR-2 Lance rail: one heavy slug a second, goes straight through shields |
| Move (Space) | Dash: two charges, rams what it hits | Stomp: hurts and throws off every enemy pilot within 8 m, one charge every 7 s | Leap: jump jets, about 3 m up and 11 m out, two charges |
| Ability (right mouse) | Four rockets at the point you look at, every 9 s | Shield wall while held: stops fire from the front, for the mech and anyone behind it; walk speed only, no firing through it | Cloak for 5 s: nearly invisible, and bots cannot see it beyond 20 m; firing ends it, then 16 s to recharge |

- **Each looks different from far off.** The Halberd has its rocket pod on the
  shoulder and its cockpit in its chest; the Bastion is low and broad, with a
  shield slab on its left arm and two exhaust stacks on its back; the Lynx
  stands on long bird-jointed legs, with a fin on top, its cockpit on the nose
  and jump-jet packs on its back. On every frame the vent glows the same hot
  orange, so the weak point always reads. Corps mechs are painted grey-blue with
  yellow hazard stripes and a glass cockpit with the pilot visible inside;
  Z.E.R.O mechs are matte black, the cockpit armoured shut behind crimson optics.
- **The shield** holds 1400 and drains slowly while up; it refills once it has
  been down for 2 s. Fire that breaks it puts it out of use for 6 s. A blast in
  front of it is the shield's to take, and it flickers when nearly spent. From
  inside, the wall is drawn across the cockpit glass.
- **The cloak** leaves an enemy a faint shimmer that grows when the Lynx moves
  and flickers when it is hit; its name tag and damage smoke are hidden. Its own
  side sees a ghost. The pilot sees a cold glow round the edge of the view.
- **Picking a frame** is any time on foot before the call; once a mech is on its
  way or standing by, the key does nothing until the next one.

Bots call the frame their role is built around: rifles the Halberd, rushers
the Bastion, marksmen the Lynx. A Bastion bot raises its shield while it cannot
shoot back or a launcher is aimed at it (never against a Lance), and stomps
pilots who come close; a Lynx bot leaps to spoil aim and cloaks when its hull
is down to 70%, holding fire until the cloak runs out.

Balance, from `packages/shared/tests/mech.test.ts` (bots in the cockpits, on the
test map):

| | Result |
|---|---|
| Duels, 40 per pairing | Halberd 17 to Bastion 23, Halberd 21 to Lynx 19, Bastion 25 to Lynx 15 |
| One bot mech against four pilots on foot | Halberd 15 s and 2.0 kills, Bastion 15 s and 2.3, Lynx 21 s and 2.4 |

Each frame's numbers are in `data/mechs/*.json`, their bot roles in `data/bots.json`.

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

**What it sounds like.** The halves differ by ear as well as by eye: the
Corps' city still runs in the south (distant traffic, an air-raid siren now
and then), while in the north Z.E.R.O's harvester drones and lets out deep
metal groans. Wind blows over everything and grows stronger up high; under a
roof it drops away and the rest goes dull. Near the fallen jib, the
scaffold and the broken ends of the rail deck, steel creaks and grit trickles
down. A far rumble rolls in from the horizon every so often. Each one-shot
waits its own random time (sirens 35 to 80 s, creaks 10 to 25 s) and no two
come within 2 s of each other. The map file lists every source, where it
sits and how often it plays (`ambience`), and `client/src/audio/ambience.ts`
plays it.

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
  told to reload (version 3 since mech frames: commands carry the frame, and
  snapshots the frame, shield and cloak).

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
  projectiles.json      Rockets and flak: speed, blast, damage to pilots and to mechs
  mechs/*.json          One file per mech frame: hull, body, movement, move, ability, vent, weapon
  maps/spire-nine.json  Spire Nine, the first real map (generated: do not edit by hand)
  maps/gym.json         Test map: boxes and team spawn points
tools/maps/           Map generators (plain Node scripts)
tools/audio/          The sound and music list (sounds.json) and the script that cuts it from CC0 packs
assets/audio/         The game's recorded sounds (generated by pnpm audio: do not edit by hand)
assets/music/         The game's music (generated by pnpm audio: do not edit by hand)
AUDIO.md              Where every sound and track came from, and its size
packages/
  shared/             Simulation that runs on both client and server
    src/sim/movement.ts   Pilot movement, one fixed tick at a time
    src/sim/match.ts      Weapons, respawns, score: one tick of a match
    src/sim/rules.ts      Damage, kills, score, getting in and out of a mech
    src/sim/mech.ts       The mech frames and the machine itself: body, movement, dash, leap, stomp, hitbox, shield
    src/sim/mechMatch.ts  Meter, call-in, landing, ramming, stomp, salvo, shield and cloak
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
    src/render/fx/        Particle sprites and the effects' painted textures
    src/audio/            Sound: the recorded sound bank, effects, pilots' footsteps and movement, map ambience, music
    src/ui/               HUD, coaching lines, error cards, start screen, settings screen, pad menu navigation
    tests/                Settings, bindings, stick, sound, coaching and bug report tests
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

- **Sound:** pilots and mechs are recorded (CC0 packs from OpenGameArt, listed
  in `AUDIO.md`). Pilots: footsteps that follow the legs and change between
  concrete and steel, jumps, landings weighed by the fall, the slide's scrape,
  mantles, the jet pack, the rush of air at speed, the three arm guns (a dry
  crack close up, the take with the room in it far off), the rocket pod,
  explosions, rounds striking concrete or steel, reloads and weapon swaps,
  being hit, and dying. Mechs: footfalls weighed by the frame (the Lynx light
  and quick, the Bastion low), leg servos, the dash and jump jets, the stomp,
  the autocannon, flak cannon and rail cannon, flak bursts, belt reloads, the
  shield coming up, humming, taking fire and shattering, the cloak, the call-in
  (a roar that deepens for exactly as long as the fall, then the landing),
  climbing in and the reactor spooling up, the cockpit's hum and a running
  mech's reactor nearby (a cloaked enemy's is silent), climbing out and
  ejecting, rams, armour and hull hits, a mech blowing apart and its wreck
  cooking off. Every sound has 1 to 7 takes picked at random with a little
  pitch jitter, and the player's own sounds keep voices in reserve so a crowded
  fight never drowns them out. The menus, the HUD and its alerts are recorded
  too: a tick as the pointer or the pad reaches a choice, a switch on a press,
  sweeps as a screen opens and closes, the hit tick (a ping on the head, a
  heavier thunk on a kill), the mech meter's chimes, a radio squelch on the
  call, beeps under a falling mech and a failing hull, a sweep on deploy,
  callouts, static when the line drops and a tone for a win or a loss. Spire
  Nine's ambience is recorded too: wind, distant traffic and sirens, the
  harvester's drone and groans, a far rumble, creaking steel and falling grit.
- **Music** is scored the way modern military shooters score a match, with
  free CC0 tracks (listed in `AUDIO.md`): a dark, slow urban-warfare theme on
  the start screen, hangar and settings; a spawn theme as you drop in, the
  Corps' on heavy stabs and distorted bass, Z.E.R.O's on an industrial
  machine pulse; then no music while the fight goes on, so every shot and
  footstep stays clear; a tense final-moments loop once either side is 10
  points from winning; and a short win or loss at the end. A looped track
  plays its intro once and then loops a span where the music repeats itself
  (found by comparing spectral windows), cross-faded at the seam. The pause
  menu lowers the music without stopping it, a hidden tab silences it, and it
  has its own volume under Sound & comfort.
- **HUD and menus** follow the look of today's military shooters, in a
  condensed type (Barlow Condensed, SIL Open Font License, bundled in
  `assets/fonts`): the score top left, a compass along the top that also marks
  where your mech is, alerts under it (an enemy mech landing on you, a lost
  connection, the lead taken or lost, a side 10 points from winning), the kill
  feed top right, health in four plates bottom left (a lost chunk stays lit,
  then drains), the weapon bottom right with the mech meter as a ring over it,
  and kills under the crosshair with the points they scored. The start screen
  lists its choices down the left over the match, the controls on the right
  and the keys that work along the bottom.
- **Models:** pilots wear real suits built in code (`client/src/render/pilot`):
  the Corps suit and the Z.E.R.O frame share one skeleton and one outline, so
  both match the hitbox, and a pose-driven animator covers every movement state.
  Legs follow the way the pilot travels, not just where they look: a strafe is
  a side-step with the hips turned into it, backing off steps backward, and the
  body leans into speed, into a burst or a stop, and into turns.
  Dead pilots are physics ragdolls (`client/src/render/pilot/ragdoll.ts`):
  eleven jointed pieces held in a human range, with the muscles letting go over
  a moment (legs first, neck last). The body keeps the speed and limb swing it
  died with and takes the blow that killed it, so a sprinter tumbles on, a
  slide skids out, a pilot on a ledge goes over it. Killed in the air, the jet
  pack runs on without its pilot for a few seconds, firing in bursts that throw
  the body around before it dies in a cough of smoke. The pool spreads where
  the body comes to rest, the death camera follows it, and bodies lie 15 s
  before sinking away. Open `/deaths.html` to watch each kind of death.
  The arm gun is one model in first and third person: a single barrel on the
  printing and cooling body that rebuilds itself into a short scattergun, a
  carbine or a telescoping longshot.
  Open `/suits.html` on the dev server to see both suits side by side in every
  state with the hitbox drawn over them, and the arm close up or as in play
  (the view menu).
  The three mech frames are built the same way (`client/src/render/mech`), on
  one mech skeleton, in each side's finish. They kneel with the hatch open while
  they wait, flicker their lights on as they start up, settle onto each
  footfall by their weight, throw the cannon arm back by its recoil (lightly for
  the autocannon, hard for the Lance), rock when hit and fling their arms out on
  the stomp. Open `/mechs.html` to see all three in every state, in either
  finish, with the hitbox and vent drawn over them, or sit in one (the view
  menu).
  Each frame's cockpit matches its window from outside: the Halberd's wide
  chest window, the Bastion's bunker slit under a heavy brow, the Lynx's bubble
  canopy. Corps pilots look out through scratched glass; Z.E.R.O pilots, sealed
  in, see a camera feed with scan lines. The dash carries the hull bar, a pip
  per charge of the move and a lamp for the ability (lit when ready, bright
  while it runs), set low between the HUD's corners. Start-up brings the cabin
  on in order (dash lights, readouts, the view), a failing hull turns the
  lights red and flashes the warning strip, the pilot's hands work the sticks,
  and the cannon out to the right is the mech's own arm, kicking by its weight.
- **Effects** are sprites and textures painted in code at start-up from seeded
  noise (`client/src/render/fx`), so nothing is downloaded. Smoke, dust and
  steam are soft puffs lit by the map's own sky and sun, drift with one breeze
  and settle along the floor or wall they came off; fire, flashes, embers and
  sparks glow on top; sparks bounce on the floor; debris tumbles, glances off
  walls and comes to rest; hits leave bullet holes, craters, scorches and
  scuffs. A rocket is a fireball rolling up into dark smoke, a flak shell a
  white crack and a puff of black, a mech's death a fireball, burning plates
  and a black column. Pilots bleed: the Corps red blood, a Z.E.R.O frame a
  dark crude with a few sparks. A hit bursts in a quick puff where it struck,
  splashes round the body, leaves a stain on the suit that it wears until it
  respawns, sprays out the far side onto the wall behind and drips on the
  floor; a pilot who goes down leaves a spreading pool;
  a hit to the player throws splatter across the edges of their view. A
  pilot's own guns leave a body, but a mech's guns, a rocket or a mech's weight
  tear it apart: the suit's own limbs fly from where they were with lumps of
  flesh (Corps) or gears, nuts, pistons and cables (Z.E.R.O), bleed as they
  tumble, splat where they strike and lie 10 s. Open `/effects.html` to play each one on its own,
  against a floor and a wall, by day or night, with what is alive and what it
  costs in the corner.
- **Balance is tuned on bots.** The numbers come from scripted duels on the
  test map and bot matches on Spire Nine (`pnpm balance`); how the weapons,
  shield, cloak and leap play between people is untested.
- **Bots do not wallrun.** They climb, drop and leap, but never run along a
  wall or chain jumps off one, and they do not cross the 8 m break in the rail
  deck (they take the fallen carriage instead).
- **Maps are built from boxes.** Spire Nine has its layout, light and dressing
  (concrete, steel, glass, blue conduits, black machine panels, crimson lights,
  a lit skyline), but no props, decals or models yet.
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
5. Content and polish (done)
   1. Suit weapons: the arm and the shoulder pod, tighter hip fire (done)
   2. Solid bodies: pilots collide with each other and with mechs (done)
   3. Settings and gamepad (done)
   4. The first real map: Spire Nine (done)
   5. Bots off the ground floor (done)
   6. Two more mech frames (done)
   7. Models and animation
      1. Pilot suits and the arm gun (done)
      2. The three mech frames (done)
      3. The cockpit from inside (done)
      4. Effects: smoke, steam, sparks, blasts and wrecks (done)
   8. Sound and music (done)
      1. Recorded sound and pilots: steps, movement, guns, impacts, hurt (done)
      2. Mechs: steps, jets, cannons, rockets, shields, call-in, wrecks (done)
      3. Menus, HUD and alerts (done)
      4. Ambience for Spire Nine (done)
      5. Music, with its own volume (done)
   9. Closing pass (done)
      1. Teaching: coaching lines in play, death-card tips (done)
      2. Error cards: lost connection, failed load, a crash, each with a way back (done)
      3. Performance: measured frame times, a lighter worst case, a graphics setting (done)
      4. Balance: weapons, mech frames and bots on bot matches (done)
6. Deployment
