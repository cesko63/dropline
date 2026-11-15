# 10. Input, mobile and screens

Part of the [game-detail-bar](../SKILL.md) core rules.

- **Keyboard first, and every hold action on a key.** Many people play on a laptop touchpad: nothing may need a held
  mouse button, and click is an alternative, never the only way. Controller support (rumble on big events; in a
  browser, the Gamepad API).
- **Game code reads actions, never raw keys.** A binding table maps keys, mouse buttons, pad buttons and touch buttons
  to named actions (move, jump, attack, interact, pause), and gameplay asks only about actions. Rebinding, pads,
  touch and the key prompts in 9a all work from that one table.
- **Press, hold and release are different questions.** A press fires once, on the frame the button goes down, and
  never repeats while held unless the action is meant to repeat; a hold is read every step; a release ends charges.
  Record presses as they arrive and hand them to the next game step, so a tap shorter than one step is never lost and
  never counted twice (this matters with the fixed step in [section 11](11-timing-physics.md)).
- **Every key and button rebindable:** press the new key to bind it, Escape cancels, a key already in use offers to
  swap, one button resets to defaults, mouse and pad buttons rebind too, and the bindings are saved by action name
  with the settings. Bind physical keys (in a browser, `KeyboardEvent.code`) so the same positions work on any
  keyboard layout, and show the player's own key label in prompts (`navigator.keyboard.getLayoutMap()` where the
  browser has it).
- **Analog and diagonal movement:** sticks get a circular deadzone (about 0.15 to 0.2) with the rest of the range
  rescaled to start from zero, so slow movement is smooth; keyboard diagonals are normalized so they are not faster
  than straight lines.
- **Nothing stays stuck:** when the window loses focus or the app goes to the background, every held input is
  released (the key-up never arrives) and the game pauses.
- **Phones:** a thumb stick or pads plus buttons on the other side, each finger tracked on its own; buttons that
  change role in context; touch slop on small buttons; swipeable pages.
- **Touch buttons carry the state the desktop bar showed** (cooldown sweep, charges, meter rings, a recast glow), and
  the desktop slot bar hides: it duplicates the buttons and sits under a thumb. Context buttons (use, talk, open)
  appear and glow only when something is in reach. An on-screen pause button, with the other corner HUD stepping
  aside for it. Any physical key switches to keyboard mode and any touch switches back.
- **The game owns the screen:** fullscreen and the game's orientation (landscape, or portrait if that is its shape),
  notch safe areas respected, and a Fullscreen On/Off setting. A native or engine build sets these in its export or
  player settings. In a browser, the first tap enters fullscreen and locks the orientation where allowed;
  fullscreen comes back on the next tap after the player swipes out (on by default for phones); the setting hides
  where the browser has no element fullscreen; and the wrong orientation shows a "turn your phone" card and pauses
  (an online host keeps running for its guests).
- **The scene fills every aspect ratio** (16:10, ultrawide, tall phones) with no bars or empty edges.
