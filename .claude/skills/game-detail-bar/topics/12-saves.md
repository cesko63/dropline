# 12. Saves and respect for the player

Part of the [game-detail-bar](../SKILL.md) core rules.

- Save the run, day or level in progress so a reload resumes it. Make payouts exactly once (flags, so a reload cannot
  pay twice).
- **Save plain data, never live objects:** each system writes its own part of one versioned object (`{ version: 3,
  ... }`) of numbers, strings, lists and ids, and loading rebuilds the objects from it.
- **Every save has a version, and old versions migrate:** one small function per version step (2 to 3, 3 to 4), run
  in order on load. Keep a sample save from every released version and load each one in `verify.js`.
- **A broken save never loses progress:** write the new save before replacing the old one (a temporary file renamed
  over it, or two alternating slots in browser storage) and keep the previous one as a backup. On load, if the save
  does not parse or fails its checks, load the backup and tell the player; never crash and never silently start a
  new game.
- **Check what loads:** types, ranges, and ids of content that no longer exists (dropped or replaced with something
  fair). Players edit saves.
- **Storage can fail:** in a browser, `localStorage` throws in some private modes and when full, and can be cleared by
  the browser; on desktop and phones, write into the platform's user data folder (Godot `user://`, Unity
  `Application.persistentDataPath`). Catch every failure, keep playing, and show a small notice that progress is not
  being saved.
- **When to save:** at checkpoints, right after rewards and purchases, when the player pauses or quits, and when the
  game goes to the background (in a browser, `visibilitychange` and `pagehide`; on phones, the app pause event). An
  autosave runs at most every few seconds, never every frame, and shows a small saving icon.
- **Long games get slots,** each showing where the player is, time played and when it was saved.
- **Settings are stored apart from progress,** so erasing or losing a save keeps them.
- **An error never freezes the game or costs the save.**
  - Catch what escapes: in a browser, `window.onerror` and `unhandledrejection`; in Unity,
    `Application.logMessageReceived` for exceptions; in Godot, a script error aborts only the function it happened
    in and the game runs on, so watch the error output in tests and guard the code that must finish (saving, scene
    changes).
  - Show a friendly card in the game's own style with "try again" and "back to menu", never a frozen frame, a blank
    screen or a raw stack trace. A failed download or load gets the same card with a retry.
  - Never write a save from a state that just failed; the last good save stays (saves happen before risky moments
    such as a scene change).
  - Log the details for a bug report (message, stack, game version, scene, seed, recent actions) and offer a "copy
    details" button on the card.
  - Test it: throw an error on purpose in an update, in a scene change and while loading (behind the QA flag), and
    check that the card shows, the game recovers and the save is intact.
- Erasing progress needs a second confirm and keeps the settings.
- A failure costs a bounded, recoverable amount and offers a continue from the last checkpoint.
