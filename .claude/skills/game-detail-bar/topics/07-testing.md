# 7. Testing and verification

Part of the [game-detail-bar](../SKILL.md) core rules.

- **A `verify.js` with deterministic checks** for every rule: timing windows, odds tables, payouts exactly once,
  save migration, fairness rules. It grows with each feature (100 to 150 checks for a full game).
- **Bots play the real game** (skilled, average, careless), over several seeds, asserting ranges, not single values,
  with a comment explaining each bound. The genre guides say which bots fit.
- **An automated walk through every menu and mode** at 1280×720, 1366×768, 1920×1080 and a phone landscape such as
  844×390, with 0 errors, and screenshots of each screen. Cover failure paths too: missing or corrupt art, an audio
  timeout, retry, an error thrown mid-play ([section 12](12-saves.md)).
  - In a browser: Playwright with `headless: true`, never a visible window.
  - Godot: run scenes and tests from the command line with `godot --headless` (a test framework such as GUT or
    GdUnit4), and capture screenshots from the viewport in a windowed run at each size.
  - Unity: Test Runner play-mode tests, run from the command line with `-batchmode -runTests -testPlatform
    PlayMode`, and screenshots from a play-mode test at each resolution.
- **Profile on a phone before handing over** ([section 13](13-performance.md)).
- **QA hooks behind `?qa=1` or typed cheats** (invincible, jump to a level, spawn a given thing), documented and
  gated before release.
