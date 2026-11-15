# 2. Feedback on every player action

Part of the [game-detail-bar](../SKILL.md) core rules.

- **Every action answers at once in sight, sound and motion**, scaled by its weight: a light tap and a heavy blow,
  a small catch and a huge one, a 3-match and a 6-match each get their own shake, freeze, particle count and sound.
  Never one flat value for everything.
- **Response time is part of the feel.** Measure the time from a key press to the first visible change (a headless
  browser test that presses a key and polls the state). Locally it should be one or two frames; anything a player
  can feel (over about 50 ms) needs fixing. Online games: see the multiplayer guide.
- **Effects are tied to the art.** Trails follow the detected edge of the moving part, smoke leaves the actual
  muzzle, sparks come from the contact point. An effect that floats off the sprite reads as cheap.
- **Particles obey the world:** debris lands and stops, sparks bounce, liquids fade instead of popping, splashes
  only where something meets water, and only when visible.
- **A change of state recolors everything at once:** a power-up, element or upgrade changes trails, flashes, sparks
  and UI accents together.
- **Light:** flashes, impacts and magic briefly light their surroundings; in dark scenes they are the light.
- **Consequences read before they land:** a warning whose length matches the real timing, the same warning language
  everywhere in the game, and the warning code in one place so every source of danger uses it.
- **Input buffer:** a press a little early (about 0.15 s) still counts, exactly once, and a final press never skips
  the ending or reward screen.
