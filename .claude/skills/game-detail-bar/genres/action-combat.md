# Genre guide: action combat

Read this on top of the core rules in [../SKILL.md](../SKILL.md) for any game with real-time fighting: shooting,
melee, enemies that attack. Example numbers are in [../reference.md](../reference.md).

> **This project:** dropline is an online, server-authoritative shooter with AI enemies. Combat feedback is drawn on
> each client; hits, damage and every enemy's decisions happen on the server (see the
> [multiplayer guide](multiplayer-realtime.md)). Upstream sections on the player's ability kit, bosses and style
> scoring were left out; see [../SOURCE.md](../SOURCE.md).

## 1. Hit feel

- **Hit-stop scaled per move and per target** (about 0.02 to 0.16 s), plus a white or tinted flash on the victim,
  knockback and a recoil pose. Small targets get a small shake and stop, heavy ones a big one; particle counts scale
  too. Online, hit-stop is drawn on the shooter's client only and never pauses the server's simulation.
- **Trails and sparks come from the weapon or hand,** taken from the art (a muzzle point, detected blade points), never
  floating beside the model.
- **Lights:** muzzle flashes, blade clashes and explosions light their surroundings; in dark scenes a shot lights its
  whole path.
- **Damage numbers** pop and arc, bigger for critical hits, small and grey for blocked ones.
- **The camera kicks away from the hit direction,** zooms a little on heavy finishers, and rests a little ahead of
  where the player is aiming.
- **Aim help is light:** soft aim assist inside a cone and range, for gamepad; never a lock-on that plays the game
  for the player.

## 2. Reading danger

- **Every attack has a wind-up that reads before it lands:** a glow, a pose and a sound. Pick one color language and
  keep it everywhere (for example yellow = can be parried, red = dodge only).
- **Ground telegraphs:** a lane or ring that tracks the target until about 70% of the wind-up, then locks, with its
  duration equal to the real wind-up.
- **Tells for things off screen or in the dark:** eyes in the dark, dust at the edge, a sound from the side.
- **One telegraph module** used by every enemy in every area, so the language never drifts.
- **Clashes and grabs have a still beat** before any mash prompt, and every grab has an escape (dash or mash).

## 3. Enemies

- **Each enemy has a distinct job and a tell,** not a reskin with more health: a pack that circles and splits, a
  caster that keeps distance and shields an ally until the caster is hit, a ceiling clinger that drops, a long narrow
  lane attacker, a shield bearer that blocks frontal hits until a heavy hit breaks the guard, a grabber that throws
  the player into the others.
- **Give each enemy a hook,** ideally a joke tied to its attacks (a bell-ringer whose head is the bell), not the
  typical skeleton or ghost.
- **Enemies use the space:** they path around obstacles, climb ledges, wait under cover, ambush from doors, stop at
  edges (how they find paths is below).
- **Groups have roles:** a lookout that calls others, a leader that buffs, a support that heals or shields. Killing
  the right one first is a decision.
- **Breakable props** react to hits (shake, crack, break into debris) and are drawn so they read as breakable.
- **Hazards hurt enemies too:** knocking enemies into spikes, traps or fire is a reward (style points, a kill), and
  hazards take a share of max health instead of one-shotting.

### How enemies think

Everything here runs on the server; clients only draw the result.

- **One state machine per enemy, with named states** (idle, patrol, notice, chase, wind-up, attack, recover, hurt,
  dead). Each state has enter, update and exit: enter starts its animation, sound and telegraph; exit cleans up
  (stops looping sounds, removes telegraphs, restores speed). Transitions live in one place. Hurt and death can
  interrupt any state and always run the current state's exit, so nothing is left behind.
- **Notice before chasing.** Enemies perceive through a sight range and cone with line of sight, and hear loud
  actions; on first sight they play a short reaction beat (about 0.3 to 0.5 s, a "!" and a sound) before they chase.
  When they lose the player they search the last seen place for a while, then return.
- **Only a few attack at once.** Hand out a small number of attack tokens (about 2 or 3, fewer on easy): an enemy
  needs one to start a wind-up and returns it after recovering. The rest circle, reposition or wait at range, so a
  crowd stays readable and fair.
- **Movement by steering:** seek and arrive (slowing down near the target instead of overshooting), separation from
  nearby enemies through the spatial grid, and a turn-rate limit so they never jitter or spin.
- **Paths:** A\* on a grid or nav mesh when a few enemies have their own goals; one flow field from the player for
  many enemies chasing the same target. Rebuild when the map changes, spread the work over several frames, and
  re-plan a few times a second rather than every frame.
- **Think slower than they move:** decisions run about 5 to 10 times a second, staggered across enemies; movement and
  animation run every step.
- **Bigger brains only when needed:** when a state machine gets tangled (a heavy unit, a squad with roles), use a
  behaviour tree or utility scores (rate each option by distance, health, cooldowns and what was just used, then pick
  the best with a little randomness and never the same move twice in a row).
- **A debug view behind the QA flag** shows each enemy's state, target, path, sight cone and whether it holds an
  attack token.

## 4. Testing

- **Whole-fight bots that press real inputs:** a skilled bot (dodges tells, picks up heals, steps off hazards), a
  button-masher (never dodges) and one bot per special mode. 6 to 10 seeds each, asserting ranges: a skilled clear
  takes 2 to 5 bot minutes; a masher does not always clear (at most 8 of 10).
- **A soak bot** that mashes every key in every area for minutes, with the player kept alive: 0 page errors and no
  stuck states (a hidden player model, an action that never ends, an enemy frozen in a wind-up).
- **Cancel paths:** dash, get hit or fall out of every action mid-use and check that its cleanup ran (the player
  visible, movement restored, looping sounds stopped).
- **Deterministic checks** for windows, damage tables and enemy state transitions in `verify.js`.

## Checklist

- [ ] Hit-stop, flash, knockback and particles scaled per move and target, drawn client-side; trails from the weapon.
- [ ] Every attack has a readable wind-up in one color language; ground telegraphs lock before landing.
- [ ] Each enemy has a job, a tell and a hook; enemies path around obstacles; hazards hurt enemies.
- [ ] Enemies run named states on the server with enter and exit cleanup; they notice before chasing; attack tokens
      limit how many attack at once; steering with separation; paths re-planned a few times a second; a debug view
      of states.
- [ ] Skilled, masher and soak bots pass; every action survives being cancelled mid-use.
