# 1. Presentation and camera

Part of the [game-detail-bar](../SKILL.md) core rules.

These apply to any view: a board, a map, a side view, top-down or 3D.

- **Never lock the camera to its target.** Ease toward a target by `1 - exp(-6 * dt)` of the gap each frame (about
  0.1 at 60 fps; a fixed 0.1 per frame would ease faster on a 144 Hz screen, see [section 11](11-timing-physics.md)), with **look-ahead** in
  the direction of movement or attention. Look further while moving fast, less while the player is busy with
  something precise.
- **The camera reacts to events; the HUD never shakes.**
  - *Trauma shake:* squared trauma that decays every frame; the biggest event wins (`max`, not `+`).
  - *Directional kick:* a small push away from where the event came from, clamped.
  - *Spring jolt:* holds through any freeze, then snaps back with a slight overshoot.
  - *Zoom punch:* a quick scale or FOV change on the biggest moments (a heavy impact, a big catch, a combo clearing
    the board, a landing).
  - *Lean-in:* zoom in a little during a focused moment (a duel, a tense reel, a final move).
- **Portrait or narrow screens get their own framing** (distance, FOV, zoom), not the landscape one squeezed.
- **Scenery between the camera and the focus fades out** (walls, roofs, banners in 2.5D or 3D).
- **Off-screen things that matter get an edge arrow:** the objective, a teammate, a rare find.
- **Slow motion and zoom are rewards:** a perfect move, a final blow, a rare catch, the last piece falling into
  place. Keep them short and earned.
- **Cutscenes:** letterbox bars, the subject framed and clear of the bars at any zoom, and every cutscene skippable
  after it has been seen once.
