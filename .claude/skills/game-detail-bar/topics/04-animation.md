# 4. Animation

Part of the [game-detail-bar](../SKILL.md) core rules.

- **Several frames per main action** (anticipation, the action, follow-through), not one pose. A chain of three
  different actions gets three different animations.
- **Timing windows match the art:** an action takes effect on the frame where it visibly happens.
- **Every state needs a pose:** idle *breathing*, moving, acting, hurt or failing, celebrating, and a resting end
  state that stays (a knocked-out body, a toppled piece). Single-pose actions settle back to idle after a short
  recovery instead of freezing.
- **Motion by body type, not one wiggle for all:** a fish swings its tail, an eel ripples, a shell barely flexes,
  a heavy thing moves less and later. Movement amplitude scales with size.
- **Idle life in the world:** characters breathe and fidget, props bob, light drifts, background things pass.
- **Turning is smooth:** no instant flips, and a threshold so a character does not turn twice in a fraction of a
  second.
- **Physics where it belongs:** a carried weight swings, a charge draws back before it drives.
- **Draw order:** a held object goes under the holding hand and over the far hand; ground markers and shadows draw
  under characters.
- **Painted frames must agree with each other:** a detail that flips sides between frames of a cycle (a hat tip, a
  scarf end, a charm) flickers in motion. Check every cycle for it and regenerate or drop those frames.
- **Smooth comes from consistent frames, not more frames:** frames generated one at a time drift in proportions,
  outline, face and limb length, and large painted sprites show every drift as jitter. Lay each cycle out side by
  side on its foot anchor (and play it in a loop) before using it; regenerate any frame whose silhouette or size
  jumps from its neighbours. About 8 to 12 frames a second is enough when the frames agree, the position moves
  every display frame, and every state change (land, get up, turn, dash) has its own in-between frames instead of a
  snap.
