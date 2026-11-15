# 14. Working method

Part of the [game-detail-bar](../SKILL.md) core rules.

- **Measure before and after, and report the numbers** (frame times, response time, bytes, pass rates). "It feels
  faster" is not a result.
- **Look at it:** screenshot every changed screen and state at desktop and phone sizes before reporting; a passing
  test does not prove that something looks right.
- **Rule out the environment first** when the user says something broke: an old cached build, a server that is down
  or unreachable, a different URL. Check it directly before changing code, and say what was found.
- **Correct earlier claims plainly.** If a previous explanation or recommendation turns out wrong or only partly
  right, say so in the next report.
- **Pitch before building:** design questions get two or three concrete pitches with a recommendation; brainstorms
  stay out of the codebase until one is picked.
- **Report honestly:** what is done, what was tested and how, what is a stand-in, what was not tested (for example
  "not tried on a real phone" or "not tested against the live server").
