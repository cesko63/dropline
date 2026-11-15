# 13. Performance (no slow patterns, measured on a phone)

Part of the [game-detail-bar](../SKILL.md) core rules.

A game that runs at 60 fps on a desktop can be unplayable on a phone: a desktop graphics card hides costs that a phone
pays in full. Build fast from the start; these are the patterns that make games slow and what to do instead. Most of
them are about *repainting things that did not change* and *paying a high cost per object when there are hundreds of
objects*.

### Slow patterns in any engine
| Slow pattern | Why it hurts | Do instead |
| --- | --- | --- |
| Drawing or updating objects that are off screen | The draw calls and updates still cost, and swarms spawn just off screen | Cull every list (characters, pickups, shots, particles, numbers) against the view plus a margin; far objects update less often |
| Unlimited particles and damage numbers | A big moment spawns thousands; outlined text is expensive | Cap them (a few hundred particles, a few dozen numbers) and drop the oldest |
| Every object checking every other object (collision, separation, targeting) | O(n²): 300 objects is 45,000 pair checks | Spatial grid or hash, rebuilt once a frame; query only nearby cells |
| Allocating objects, arrays or closures per object per frame in hot paths | Garbage-collector pauses show as stutter (JavaScript, C#, GDScript arrays and dictionaries alike) | Reuse arrays and temporary vectors, pool objects that come and go (shots, particles, enemies), inline hot loops |
| Creating and destroying objects all the time | Spawning a node, GameObject or sprite is far more costly than moving one | Pool them: hide and reuse instead of destroy and create |
| Looking things up every frame | Finding nodes or components by name or type in every update is slow | Look them up once and keep the reference |
| One-time work done the first time it is needed (decoding art, building caches or tinted copies, compiling shaders, decoding sounds, loading fonts, filling pools) | The first hit, effect, enemy type, boss or area hitches mid-play, often for 100 ms or more | Do it ahead, behind a loading screen, a menu or a transition, and check the warm-up really did the work: a token warm-up (a tiny draw, a muted play) can look done while the real cost still waits |
| Too much decoded art held at once | A decoded image costs width × height × 4 bytes whatever its file size (a 2048 × 2048 atlas is 16 MB); phone browsers reload or kill the tab at roughly 200 to 300 MB, and phone apps get killed too | Add up the decoded size of every atlas; under about 150 MB load it all up front; above that, load per level or area, prefetch the next one behind play, and release the rest. GPU-compressed textures (see the 3D guide, or the engine's texture import settings) cut it by 4 to 8 times |
| Rendering at the full device resolution | A phone at 3× pixel density draws 9× the pixels of 1× | Cap the render resolution on phones (about 1.5×) and lower it further when frames run slow; keep UI sharp at native resolution |
| Many sounds started per frame | Audio thread overload, crackle and stutter | A voice limit and a per-sound rate limit |

### In three.js (WebGL)
See [genres/3d-scenes.md](../genres/3d-scenes.md) section 8: draw calls first (instancing, merged static
scenery, LODs), a capped pixel ratio, quality presets for post effects, and no per-frame allocations.

### Loading (the first screen shows fast)

- **Menu first, game after.** Only what the title screen or menu needs (its code, UI art, fonts, menu music) loads
  first. The game's code and art load behind the menu while the player reads it, and anything still missing loads
  behind a short loading screen when they press play. A player sees a working menu within a second or two on a
  phone, never a blank screen while the whole game loads. In an engine, keep the first scene small and load the
  rest in the background (Godot `ResourceLoader.load_threaded_request`, Unity asynchronous scene loading or
  Addressables).
- **One packed data file.** All game data (levels, items, enemies, abilities, dialogue, balance numbers) ships as one
  file, not dozens of small ones read at startup: in a browser, one request, compressed by the server, parsed once,
  with a version in its URL so it can be cached for a long time and an update is picked up at once; in an engine,
  resources inside the game package rather than loose files. Art stays in atlases for the same reason.

3D games: read [genres/3d-scenes.md](../genres/3d-scenes.md) (draw calls, shadows, texture compression, shader
warm-up, 3D measurement).

### Measure it (before calling a game or big feature done)
- **Measure on a phone:**
  - In a browser, simulate one: headless Chromium at a phone landscape size (844×390), `deviceScaleFactor: 3`,
    `isMobile: true`, and CPU throttling 4× through the DevTools protocol (`Emulation.setCPUThrottlingRate`). Hold
    the resolution fixed while measuring.
  - In an engine, run a development build on a real low-to-mid phone with the profiler attached (Godot remote
    debugging with the Profiler and Monitors; Unity Profiler attached to a Development Build). A desktop gives no
    reliable phone simulation for native builds.
- **Read frame time, not FPS.** The frame rate is capped at the screen's refresh rate (60, 120 or 144 Hz), so two
  versions that both show "60 FPS" can differ several times over in cost; the cheaper one just idles longer. Compare
  milliseconds of work per frame, the worst frame, draw calls and triangles, and push the load up until the cap
  breaks to find the real headroom.
- **A live readout behind the QA flag:** frame time, worst frame in the last half second, draw calls, triangles or
  sprites, and object counts.
- **Measure the worst case:** the biggest crowd the game can produce, the busiest effect, and every animated menu or
  card screen (they are often slower than play).
- **Find the cost, don't guess:**
  - frame time with each draw layer switched off in turn; the layer whose removal saves the most is the one to fix;
  - draw calls per frame: in a browser, wrap the `CanvasRenderingContext2D.prototype` methods and count `save`,
    `fill`, `drawImage`, `strokeText` and so on (or read `renderer.info` in three.js); in Godot, the draw call
    monitors; in Unity, the Frame Debugger and the Stats panel;
  - a CPU profile to tell game logic from drawing (the DevTools protocol `Profiler` in a browser, the engine
    profiler elsewhere);
  - game-logic milliseconds with 0, 150 and 300 objects.
- **Find stutter, not only slowness:** report the 99th percentile and the worst frame, not just the median; a smooth
  median with one 150 ms frame still feels broken. Time every game function and keep the top few for each frame over
  about 35 ms, so a spike names its cause. Measure from a fresh start and watch every "first" (first hit, first
  status effect, first enemy type, first boss, first new area): one-time costs never show on a warmed-up run.
- **Targets on the phone:** median frame at or near 16.7 ms in the worst case, no frames over 50 ms while moving onto
  new ground or meeting anything for the first time, and game logic under about 2 ms for 300 objects. In a browser,
  fewer than about 500 `save`/`restore` pairs per frame; in an engine, draw calls in the low hundreds at most.
