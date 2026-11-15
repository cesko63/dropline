# 9. UI and HUD

Part of the [game-detail-bar](../SKILL.md) core rules.

### 9a. Look

- **Painted UI kit and bundled fonts, never system fonts or plain rect bars.** 9-slice panels, themed frames, icons
  at native sizes, fonts bundled with the game with their license (woff2 in a browser).
- **A HUD that lives:** counters that roll up and bump, a time dial that pulses near the end, a recoverable-damage
  segment on bars, segmented meters, rank badges with their own colors, progress shown as a track with an icon
  instead of a number.
- **Diegetic where possible:** a chalkboard goal in the world, a poster that gets stamped, speech bubbles with a
  patience fuse.
- **Gauges grow out of the thing they measure** (a struggle bar out of the creature, a charge ring around the hand),
  show tick marks, glow in the zone, flash in danger, and shake when the player is losing.
- **Explain before the player commits:** standing at a shop item or a reward shows what it does, what it costs and
  what it replaces.
- **Prompts follow the bindings:** keycaps and tips show the bound key or pad button and switch when a pad is used.
  On touch, no keyboard keys anywhere: prompts drop their keycap and any key-based text ("press K again") gets touch
  wording ("tap the spell button again").
  A full key strip on title and pause screens; keep the bottom edge clear in play.
- **Cards and toasts never block play:** a big card closes on the first press without firing an action; small toasts
  let input through; queued reveals wait their turn and pause their timers in menus.
- **Pause menu:** resume, separate music and SFX sliders (stored apart from the save), key bindings (rebind, swap on
  conflict, reset), how to play, fullscreen, and quit or reset with a confirm where "keep playing" is the default.

### 9b. Layout that never spills out of its frame

UI that leaks over its frame, overlaps other UI or hides under frame art is the most common thing a person has to
point out. Build these in from the start and prove them with screenshots.

- **One content-rect helper for every framed panel.** It takes the panel rectangle and the frame art's border width
  (measured from the art, scaled with the UI) and returns the safe inner rectangle. Titles, text, grids and buttons
  are laid out inside it, never at the frame edge and never on the rim. Footer buttons sit at a fixed offset inside
  the bottom border.
- **Framed panels resize without smearing their art.** Corners and every ornament along an edge (a gem, a crest, a
  spike) keep their size; only the plain parts between them grow, patterned edges repeat instead of stretching, and
  the center fills. Decoration can sit anywhere on the frame. A panel smaller than its corners scales down evenly
  instead of overlapping them. UI that never resizes (a title frame) can be one fixed image; ornaments that animate
  are separate sprites placed on the frame.
- **Bar fills draw inside the frame's window, on top.** If the frame art has a solid middle, a fill drawn under it
  is invisible (a bar that "looks empty" is usually this). Measure the inner window of the frame art once and fill
  that rectangle, or cut the window out of the art. Check each bar at 0%, 50% and 100%.
- **All text fits its box.** Wrap to the box width; if it still does not fit, shrink toward a minimum readable size
  (about 11 px on phones), then cut with an ellipsis; never let it run past a border or under an icon row. Lay out
  from the longest real string in every language the game ships.
- **Layouts are computed from the content count.** Card rows, grids and lists get their size from how many items
  there are and the screen width; adding a seventh character or a tenth item must not push anything off a panel.
  Below a readable size, switch to more rows or paging instead of shrinking further. Re-check every screen whose
  content count changed.
- **Reserved HUD regions.** Give each kind of HUD element its own region (health top-left, map top-right, banners
  and boss or objective bars top-center, prompts near the player, key strip at the bottom) so they never stack; a
  banner moves other top-center elements aside while it shows.
- **HUD state has an owner and a lifetime.** Every element is cleared by the event that ends it (an area change, the
  end of a run, closing a menu). A bar or prompt that outlives its owner ends up floating over the next screen.
- **Phones get their own layout,** not the desktop one scaled down: bigger touch targets, fewer columns, safe areas
  for notches.
- **Prove it:** headless screenshots of every screen and state at desktop and phone sizes, before and after the
  change, checked for anything crossing a border, overlapping, clipped or too small to read. Report what was checked.

### 9c. Motion (every element moves, with intent)

A static HUD that only changes numbers reads as unfinished. Every HUD element has an enter, a change, an idle and an
exit motion, and each motion pairs with its sound ([section 3](03-sound-music.md)).

- **Bars:** a lost chunk flashes, holds about 0.3 s, then drains (a "ghost" segment); heals fill with a glow at the
  leading edge; low values pulse; a full meter breathes and pops once when it fills; segmented meters fill segment by
  segment with a tick.
- **Numbers:** they pop in with an overshoot, arc up and fade; size and color differ by kind (critical, blocked,
  heal, miss); several fan out instead of overlapping; always outlined or shadowed for readability.
- **Turns, states and phases:** banners swipe in and out ("Your turn", "Round 2", "Perfect!") with a hold of about
  0.8 s and never block input longer; phase changes get a short screen-wide moment.
- **Buttons and menus:** hover lifts, press sinks, disabled shakes with the denied sound, selected glows; a focus ring
  glides between buttons; panels open with a scale-and-fade overshoot and close faster than they open; lists stagger
  in (30 to 50 ms apart); tabs slide their underline and cross-fade content.
- **Status icons** pop in, tick, blink in their last second and burst when removed; stacks show a count that bumps.
- **Rewards:** count-ups speed up then land with a pop; items fly from where they were won to the inventory; rarity
  reveals build longer and brighter at each tier.
- **Screen transitions:** wipes, fades or an iris between screens, never a hard cut; the HUD slides in at the start
  of play and out at the end.
- **Timing:** UI motion lasts 150 to 300 ms (reveals may run longer); ease-out to enter, ease-in to leave, a small
  overshoot on pops; UI runs on real time so it keeps moving during freezes and slow motion; the HUD never shakes with
  the camera; respect a reduced-motion setting.
- **Verify it:** screenshots or frame strips mid-motion, checking that no animation overlaps, clips off screen or
  hides the action at phone sizes.

### 9d. Accessibility

Players with low vision, colour blindness, motion sickness, photosensitivity, hearing loss or limited hand use are a
large share of any audience. These settings cost little when built in from the start.

- **Never colour alone.** Every meaning carried by colour (a telegraph, a team, rarity, a status, a correct or wrong
  answer) also has a shape, an icon, a pattern or a word. Check the main screens under the three common colour-vision
  deficiencies (protanopia, deuteranopia, tritanopia): in a browser, the DevTools protocol does this headlessly with
  `Emulation.setEmulatedVisionDeficiency`; in an engine, run the test screenshots through a colour-blindness
  simulation (an image tool, or a full-screen filter shader behind the QA flag).
- **Readable text:** at least 4.5:1 contrast against what is behind it (a plate or outline over a busy scene), a text
  size setting with at least three steps that the layout rules in 9b survive, and no text that disappears before it
  can be read: dialogue and tips advance on a press, or stay long enough.
- **Motion and flashes:** a screen shake slider (0 to 100%), a reduced flashes option, and a reduced motion option
  that tones down camera kicks, zoom punches and UI overshoot (in a browser, default it from
  `prefers-reduced-motion`). Never more than three full-screen flashes in one second.
- **Sound has a picture:** subtitles for all speech, with the speaker's name, and captions or an on-screen cue for
  sounds that carry information (danger behind the player, a timer about to end, an enemy off screen).
- **Hands:** every hold action can be switched to a toggle, every control is rebindable ([section 10](10-input-mobile.md)), nothing needs
  fast repeated mashing without an option to hold instead, and touch targets are at least about 44 px.
- **An assist option** in games with hard timing (slower game speed, more health, wider windows, or skipping a
  section), offered plainly without shaming the player. Assisted results keep their own records, like a harder mode.
- **Settings are reachable before play** (on the title screen as well as in pause), stored with the other settings
  apart from the save, and shown as a preview while changing them.

### 9e. Teaching the player (the first minutes)

Most players who leave do it in the first minutes, usually because they did not understand what to do or why they
failed. Teaching is part of the game, built with it, not a manual added at the end.

- **Playing within seconds:** one or two presses from the title to control, no account or settings screens first,
  and any story intro short and skippable.
- **Teach by doing, one thing at a time.** Each new verb first appears where it is the only thing needed and failing
  costs nothing, then is asked for under light pressure, then combined with what the player already knows
  (introduce, test, twist). Never teach two new things in the same moment.
- **Prompts in the world, not text walls:** one short line next to where it matters, showing the bound key or the
  touch button (9a). A prompt disappears when the player has done the thing, not after a timer, and comes back if
  the player seems stuck (no progress for a while).
- **The first failures are gentle and explain themselves:** early mistakes cost little, a retry is instant, and the
  fail screen names the cause with one tip that fits it ("the red ring means dodge, not block").
- **New things are taught when they are first met,** later in the game too: a first-time card or a short coach
  moment for a new enemy type, item or mechanic, not everything at the start.
- **Once per player, always replayable:** tutorials and first-time cards are remembered with the settings, skippable
  for returning players, and a how-to-play page with pictures sits in the pause menu.
- **Prove it:** a run from a fresh profile (cleared storage or save folder) reaches real control in seconds and
  shows every first-time prompt exactly once; then watch one person who has never seen the game play it without
  help, and note every place they stop, guess or fail without knowing why.
