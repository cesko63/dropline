# 11. Simulation timing and physics

Part of the [game-detail-bar](../SKILL.md) core rules.

A game whose logic steps by the frame time plays differently on a 60 Hz phone and a 144 Hz monitor: jumps reach a
different height, fast objects pass through walls, and bots and replays stop being repeatable.

- **Game logic and physics run at a fixed step** (usually 60 a second): each frame adds the real elapsed time to an
  accumulator and runs as many fixed steps as fit. Use the engine's own fixed step where it has one (Godot
  `_physics_process`, Unity `FixedUpdate`); in a browser loop, write the accumulator yourself.
- **Drawing interpolates** between the previous and the current step by the leftover fraction, so motion is smooth on
  any refresh rate and never judders at 90, 120 or 144 Hz.
- **Cap the steps per frame** (about 5) and drop the remaining time after a long stall (returning to a hidden tab, a
  loading hitch), so the game never tries to catch up on seconds of simulation at once.
- **Everything outside the fixed step uses real time:** easing by `1 - exp(-k * dt)` instead of a fixed fraction per
  frame, timers and cooldowns in seconds, never in frames.
- **Hit-stop and slow motion scale the simulation's time,** while UI and menus run on real time (9c).
- **Fast objects never pass through walls.** A small object moving more than about half the thickness of the thinnest
  wall in one step can skip past it. Cap speeds, trace a ray or sweep from the previous to the new position for
  bullets and thrown things, turn on the engine's continuous collision for fast bodies, and keep walls thicker than
  one step of the fastest object.
- **Stable physics:** connected or stacked bodies within about 10:1 of each other's mass, angle limits on every joint
  of a ragdoll or chain, more solver iterations (not a smaller step) when stacks jitter, and resting bodies allowed to
  sleep.
- **Seeded randomness.** Every gameplay choice (spawns, loot, damage rolls, level layout, enemy decisions) draws from
  one seeded generator passed to the code that needs it, never from the global one (`Math.random()` in a browser,
  `UnityEngine.Random` in Unity, the global `randf()` in Godot). Use a small seedable generator in a browser
  (mulberry32 or sfc32), a seeded `RandomNumberGenerator` in Godot, and `System.Random` or
  `Unity.Mathematics.Random` with a seed in Unity.
  - Cosmetic randomness (particles, idle fidgets, sound pitch jitter) uses a separate generator, so changing an
    effect never changes what drops.
  - The run's seed and the generator's current state go into the save, so reloading cannot re-roll a reward.
  - Daily content takes its seed from the date in UTC, so every player gets the same day.
  - The seed shows in the QA overlay and bug reports, and a QA option starts a run from a given seed.
- **Prove it:** run the same inputs at a forced 30, 60 and 144 frames a second and compare the results (jump height,
  distance run, a projectile's path, a bot's score); they match within a small tolerance. The same seed and inputs
  give the same run every time, and bots run faster than real time with the same results.
