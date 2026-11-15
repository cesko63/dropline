# 3. Sound and music

Part of the [game-detail-bar](../SKILL.md) core rules.

- **UI and HUD count too:** button hover and press, a denied click, panels opening and closing, tabs, sliders, coin
  gain and count-up ticks, purchases, star pops, rank up, records, toasts, timer warnings, title cards, loading done.
  Each gets its own sound *and* its own animation, built together.
- **Every new action, opponent action, UI action and prop ships with its own fitting recorded SFX in the same turn.**
  No synth beeps, and no placeholder mix of unrelated samples. Reuse only when it truly fits (a whoosh for a whoosh).
  Prefer real recordings and avoid items marked AI-generated.
- **Document each sound** in `AUDIO.md` (title, author, ID, original bytes, runtime bytes) and the processing: trim
  silence below -50 dBFS, cap the length with a fade, mono 44.1 kHz, normalise per sound, MP3 64 kb/s.
- **Variation:** layer samples per event, pick one of 2 or 3 at random, and add slight pitch jitter so repeats never
  sound the same.
- **Mix discipline:** a global voice limit and a per-sound rate limit; voices and cries only on big events; quieter
  mixes for frequent sounds.
- **Ambience beds** per area or time of day (fire crackle, wind, sea, crowd murmur, crickets), with one-shots spaced
  out.
- **Music:**
  - Loop a section the song itself repeats, never through its outro (find it by matching spectral windows: play the
    intro once, then jump back by the section length).
  - Duck the music for pause, menus and cinematics, and resume from the same position.
  - Pause all audio when the game goes to the background (a hidden browser tab, a minimized window, a paused phone
    app), unless the game must keep running there, as an online host does.
- **Big entrances:** the biggest moment of an area (a boss, a finale, a final round) gets silence first, a scene
  built from sound, then its theme cutting in from its first bar on the title card. After a retry, the theme starts
  at once.
- **Sound must never block the game from starting.** In a browser, audio only starts after a user gesture: unlock it
  on the first tap or key with a silent buffer, and resume the audio context on return (iOS Safari suspends it).
- Music prompts for a generator give the vibe, the bpm and what the track is for, and ask for an instrumental,
  seamless loop. They never list instruments.
