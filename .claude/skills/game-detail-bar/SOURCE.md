# Source

Vendored from [Xyloforge/claude-game-skills](https://github.com/Xyloforge/claude-game-skills) (MIT, see
[LICENSE](LICENSE)), skill `skills/game-detail-bar`, pinned at commit
`6ee94d9f1d503af5c55d4953efcfa0e55aa3eb06` (2026-11-05). Copied 2026-11-15.

This is a local copy on purpose: the upstream plugin tracks `main`, so installing it would pull later changes into
sessions unreviewed. To update, diff the upstream folder against this one and bring changes over by hand.

## What was kept

- `SKILL.md` (core rules), `reference.md` (example numbers)
- `genres/3d-scenes.md`, `genres/multiplayer-realtime.md`, `genres/action-combat.md`

## What was left out or changed

- Genre guides not relevant to this game: `platformer-side-view`, `roguelite-runs`, `sim-economy`, `open-world`,
  `voxel-worlds`. Their rows were removed from the genre table, and the links to them from `3d-scenes.md`.
- `scripts/phone_perf.mjs`, and the line in `SKILL.md` section 13 that called it.
- The 2D-canvas and Godot/Unity slow-pattern tables in section 13, replaced by a pointer to `3d-scenes.md` section 8.
- References to the upstream `game-asset-pipeline` skill (section 3 and 8). That skill was not taken: it targets 2D
  sprite sheets, assumes macOS paths, and its Pixabay downloader gets around the site's bot protection.
- The frontmatter description now names only the three guides kept here.
- `genres/multiplayer-realtime.md` was adapted to this project's server-authoritative model. Upstream section 2
  (each device owns its character) and section 5 (co-op design) were removed. A new section 2 on prediction,
  reconciliation and lag compensation was written for this project and is not upstream text. Host and guest wording
  became server and client in the remaining sections, and the checklist was rewritten to match.
- `genres/action-combat.md` keeps hit feel, reading danger, enemies with "How enemies think", and testing, with notes
  that hit-stop is client-side and enemy AI runs on the server. Upstream sections 3 (the player's kit), 5 (bosses)
  and 6 (style scoring and difficulty) were removed; restore section 5 from upstream if the game gets boss fights.
- `reference.md`: a note above the online co-op numbers says they come from a different netcode model.
- `SKILL.md` was split so it loads small: sections 1-14 moved word for word into `topics/NN-*.md`, and `SKILL.md`
  now holds the intro, how to use it, the genre guides, a topic table and the done checklist. Links were adjusted
  for the new paths, and "section N" mentions became links to the topic file. To compare with upstream, concatenate
  the topic files in order.
