---
name: game-detail-bar
description: The attention-to-detail bar for building any game in any genre - presentation and camera, feedback on every player action, sound and music, animation, content that never repeats, characters and options that each play differently, scoring and balance, testing, art direction, UI and HUD layout that never spills out of its frames, UI motion, accessibility, teaching the player, input and rebinding, mobile, simulation timing, seeded randomness and physics, saves and error recovery, performance and working method. Genre guides for 3D scenes (three.js, first-person view), server-authoritative multiplayer (prediction, reconciliation, lag compensation) and action combat with AI enemies add rules on top. Use when pitching, specifying, building, reviewing or reporting on any game or game feature.
---

# Game detail bar

This skill is a quality bar for any game, in any genre. Each rule in it is something an AI left out of a game and a
person had to ask for. Example numbers are in [reference.md](reference.md).

**The core rule:** a feature is not done when it works. It is done when it *looks, sounds, moves, reads and balances*
like a finished game. Build all of that in the same turn, not as "polish later".

The rules that apply to every game live in the topic files listed below; read the ones the task touches. Rules that
only make sense for one kind of game live in the genre guides. Neither the topics nor the guides name or point into any particular game: examples describe a kind of
thing ("a heavy enemy", "a fishing loop"), never a specific title.

**Any engine.** The rules say *what* a finished game does and hold in a browser, Godot, Unity or anything else. Where
the *how* differs, a rule says so: "in a browser" for web games (canvas, WebGL, the DOM), and the engine's own name
(Godot, Unity) for its equivalent. Use the one that matches the game.

## How to use this skill

1. **Pick the genre guides that fit** (table below) and read them too. A game can use several: an online co-op
   roguelite with fighting reads action combat, roguelite runs and real-time multiplayer.
2. **Pitching or speccing:** read every topic file and the guides that fit, and write the answers into the spec:
   camera plan, feedback per action, SFX list, animation list, what makes each character, option, opponent and area
   different, a scoring and balance model, a UI layout plan for phone and desktop, and a test plan.
3. **Building:** read the topic files the feature touches (table below) before writing it. Every new action,
   character, opponent, item, area or menu ships with its own camera, feedback, SFX, animation, HUD, layout check and
   tests, in the same turn.
4. **Before reporting done:** go through the checklist at the bottom and the checklist of every guide you used. In
   the summary, say which SFX are new and which are reused, which checks ran (with their numbers), and what is still
   a stand-in.

## Genre guides

| Guide | Read it when the game has |
| --- | --- |
| [genres/action-combat.md](genres/action-combat.md) | Hit feel, readable enemy attacks, AI enemies and how they think |
| [genres/multiplayer-realtime.md](genres/multiplayer-realtime.md) | Netcode: server authority, prediction and reconciliation, lag compensation, snapshots, testing with lag |
| [genres/3d-scenes.md](genres/3d-scenes.md) | A 3D world of any genre: models, animation, lighting, shadows and 3D performance |

The upstream repository has more guides (platformer, roguelite, sim, open world, voxel) that this project left out;
see [SOURCE.md](SOURCE.md).

## Topics (the core rules)

Each file is one section of the core rules. Read a topic before building or reviewing anything it covers; the
checklist below names what each one must deliver.

| # | Topic | Read it when the work touches |
| --- | --- | --- |
| 1 | [Presentation and camera](topics/01-camera.md) | The camera: follow, look-ahead, shake, kick, zoom, framing |
| 2 | [Feedback on every player action](topics/02-feedback.md) | Any player action: response time, hit feedback, warnings |
| 3 | [Sound and music](topics/03-sound-music.md) | SFX, ambience, music, mixing, voice limits |
| 4 | [Animation](topics/04-animation.md) | Poses, frames, cycles, idle motion |
| 5 | [Content that never repeats](topics/05-content-variety.md) | New weapons, abilities, characters, enemies, items, maps or modes |
| 6 | [Scoring, economy and balance](topics/06-scoring-balance.md) | Score, rewards, progression, balance numbers, bot simulations |
| 7 | [Testing and verification](topics/07-testing.md) | Test plans, deterministic checks, balance bots, automated walks, QA hooks |
| 8 | [Art direction](topics/08-art-direction.md) | Style, contrast, atmosphere, key art, loading art, frame names used in code |
| 9 | [UI and HUD](topics/09-ui-hud.md) | HUD, menus, panels, UI motion, accessibility, teaching the player |
| 10 | [Input, mobile and screens](topics/10-input-mobile.md) | Controls, rebinding, gamepad, touch, fullscreen, screen sizes |
| 11 | [Simulation timing and physics](topics/11-timing-physics.md) | The game loop, fixed step, physics, collision, randomness |
| 12 | [Saves and respect for the player](topics/12-saves.md) | Saves, settings, errors and recovery, loading failures |
| 13 | [Performance](topics/13-performance.md) | Frame time, loading, profiling, budgets |
| 14 | [Working method](topics/14-working-method.md) | Any report or handover: measuring, screenshots, pitching options, debugging a user's bug report |

## Done checklist (go through it before saying "done")

- [ ] Camera eases and reacts (shake, kick, jolt, zoom); the HUD stays still; portrait has its own framing.
- [ ] Every action answers at once with sight, sound and motion scaled to its weight; response time measured;
      effects anchored to the art; warnings match real timings.
- [ ] Every new action has its own recorded SFX (list new vs reused), with variation and a voice limit; ambience and
      music loop cleanly; music ducks and pauses.
- [ ] Every state has a pose; main actions have several frames; cycles have no side-flipping details; the world
      idles; every frame name used in code and data exists in the art.
- [ ] Every option, character, opponent and item has its own verb, job or rule and a hook; each area changes the
      rules; stand-ins are listed.
- [ ] Scoring rewards skill; a bot simulation supports the balance numbers; nothing takes earned progress.
- [ ] `verify.js` and bot runs pass; an automated walk at desktop and phone sizes shows 0 errors.
- [ ] UI: painted kit and bundled fonts; every panel uses the content rect; no text past a border; bars fill inside
      their frames; layouts survive the content count; HUD regions never stack; stale HUD clears; screenshots at
      desktop and phone sizes checked.
- [ ] Every HUD and UI element animates on enter, change, idle and exit, each with its own sound.
- [ ] Accessibility: nothing carried by colour alone (checked under colour-blind simulation); text contrast and size
      setting; shake, flash and motion settings; subtitles and cues for important sounds; hold-to-toggle; an assist
      option where timing is hard; settings reachable from the title screen.
- [ ] Teaching: control within seconds of the title; one new thing at a time, taught by doing; prompts leave when
      done and return when stuck; fail screens name the cause; first-time cards once per player; checked from a
      fresh profile and by watching one new player.
- [ ] Touch, pad and rebindable keys, nothing needs a held mouse button; gameplay reads actions from one binding
      table; presses fire once; rebinding swaps conflicts and resets; deadzone and normalized diagonals; inputs
      release on focus loss; no keyboard keys shown on touch; touch buttons show cooldowns and charges; on-screen
      pause; fullscreen (re-entered, with a setting) and rotate card; safe areas; fills every aspect ratio.
- [ ] Logic and physics on a fixed step with interpolated drawing; results match at 30, 60 and 144 fps; fast objects
      cannot pass through walls; gameplay randomness comes from a seeded generator kept apart from cosmetic
      randomness, saved with the run, so the same seed and inputs replay the same run.
- [ ] Saves are versioned plain data with migrations tested from every old version, a backup on a broken save, a
      notice when storage fails, and saves on checkpoints, rewards, pause and going to the background.
- [ ] Errors: a thrown error, a failed load and a broken scene change each show a friendly card with retry and
      leave the save intact (tested on purpose).
- [ ] Performance measured on a phone ([section 13](topics/13-performance.md); simulated in a browser, a real device for engine builds): the
      worst case and every animated menu hold 60 fps or close, the worst frame from a fresh start is reported, and
      none of the slow patterns are in the code.
- [ ] The menu shows before the game code and art finish loading; game data ships as one packed file.
- [ ] `SPEC.md`, `ART.md` and `AUDIO.md` updated with the real numbers.
- [ ] The checklist of every genre guide used.
