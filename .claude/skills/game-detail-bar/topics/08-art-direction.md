# 8. Art direction

Part of the [game-detail-bar](../SKILL.md) core rules.

- **One coherent direction per game, never code-drawn stand-ins in the final build.** Tell the user what is still a
  stand-in.
- **Contrast:** a readable, colorful hero or focus against a calmer world; characters readable on any background.
- **Atmosphere layers:** parallax, fog, light shafts, floating particles, a vignette, darkness cut by light, a
  time-of-day grade.
- **Characters and world in one rendering style** (pixel on pixel, painted on painted).
- **Cover and store art is painted key art** with one subject, eye contact, a warm accent against a cool background,
  and no small text. Make it at every size the game is listed at (a web portal tile, an itch.io cover, Steam
  capsules, a phone store icon), recompose rather than crop for very wide or very tall shapes, and check each one at
  the smallest size it is shown (often about 128 px or less).
- **Load smart:** an area's art loads behind a loading screen and is decoded before first draw; later areas load in
  the background once unlocked.
- **Every frame name exists.** A missing frame usually draws nothing and raises no error, so a character blinks out
  on one step of a cycle or vanishes in one pose. Check every frame name used in code and data against the sheets as
  part of the build, and in play log one warning per unknown name instead of failing silently. Never reference a
  frame that has not been drawn yet; reuse an existing one until it is.
