/**
 * Balance report: plays the real rules headless and prints the numbers that
 * decide whether a weapon, a mech frame or a bot role is too strong.
 *
 *   pnpm balance            weapons with perfect aim, then 24 bot matches on Spire Nine
 *   pnpm balance -- 60      the same with 60 matches
 *
 * 1. Time to kill with perfect aim (recoil pulled down, every shot at the
 *    chest) on the open test map: what each weapon is worth in good hands.
 * 2. Time for each pilot weapon to bring down a standing mech of each frame.
 * 3. Full matches with bots in every seat: which side wins, how long a match
 *    runs, and what earns the kills. Bots hit softer than players by role
 *    (`damageScale` in data/bots.json), so this is the bots' balance, which is
 *    what a player meets offline.
 */
import {
  BOT_ROLES,
  COMBAT,
  CollisionWorld,
  FRAME_LIST,
  TICK_DT,
  WEAPONS,
  createMatch,
  emptyInput,
  enterMech,
  frameOf,
  mapById,
  resetMech,
  stepMatch,
  type Actor,
  type InputCmd,
  type MatchState,
} from '@dropline/shared';

const MATCHES = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 24);
/** Seeds per weapon duel; spread is random, so each distance is an average. */
const DUELS = 12;
const EYE = 1.62;
/** Chest height on a standing pilot, and the middle of a mech's hull. */
const CHEST = 1.15;
const HULL = 3;
/** A match that has not ended by then is called a draw. */
const MAX_MATCH = 20 * 60;

const pct = (n: number, of: number): string => (of ? `${Math.round((n / of) * 100)}%` : '-');
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sec = (s: number): string => (Number.isFinite(s) ? `${s.toFixed(2)} s` : 'never');

function table(head: string[], rows: (string | number)[][]): void {
  const cells = [head, ...rows.map((r) => r.map(String))];
  const width = head.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  for (const [n, r] of cells.entries()) {
    console.log(r.map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  '));
    if (n === 0) console.log(width.map((w) => '-'.repeat(w)).join('  '));
  }
  console.log();
}

// ---------------------------------------------------------------- duels

const gym = mapById('gym');
const gymWorld = await CollisionWorld.create(gym);

/** Shooter (actor 0) and a target `dist` m down an open lane along the east wall of the test map. */
function lane(seed: number, dist: number): { m: MatchState; me: Actor; foe: Actor } {
  const m = createMatch(gym, gymWorld, { seed, teamSize: 1 });
  const [me, foe] = m.actors;
  foe.brain = null;
  for (const [a, z, yaw] of [[me, 62, 0], [foe, 62 - dist, Math.PI]] as [Actor, number, number][]) {
    a.p.pos.x = 66;
    a.p.pos.y = 0.02;
    a.p.pos.z = z;
    a.p.yaw = yaw;
    a.p.vel.x = a.p.vel.y = a.p.vel.z = 0;
  }
  me.protect = foe.protect = 0;
  return { m, me, foe };
}

/**
 * Seconds from the first shot until `done`, firing weapon slot `slot` at
 * height `aimY`, aimed (`ads`) or from the hip; semi-automatic weapons are
 * clicked as fast as they allow. Infinity if it takes more than 15 s.
 */
function timeToKill(m: MatchState, me: Actor, slot: number, dist: number, aimY: number, ads: boolean, done: () => boolean): number {
  const auto = WEAPONS[me.loadout[slot]].fireMode === 'auto';
  const pitch = Math.atan2(aimY - EYE, dist);
  const step = (fire: boolean): void => {
    // A good player pulls the recoil back down and across.
    const cmd: InputCmd = { ...emptyInput(), yaw: -me.punchYaw, pitch: pitch - me.punchPitch, ads, fire, weapon: slot };
    stepMatch(m, gymWorld, [cmd, null], TICK_DT);
  };
  for (let t = 0; t < 1.2; t += TICK_DT) step(false);
  let first = -1;
  for (let i = 0; i < 15 / TICK_DT; i++) {
    step(auto || i % 2 === 0);
    if (first < 0 && m.events.some((e) => e.type === 'shot')) first = i;
    if (done()) return (i - first + 1) * TICK_DT;
  }
  return Infinity;
}

const PILOT_ARMS = COMBAT.playerLoadout;
const DISTANCES = [5, 10, 20, 35, 60];

console.log(`\n1. Time to kill a standing pilot with perfect aim (${COMBAT.health} health), mean of ${DUELS}\n`);
for (const ads of [true, false]) {
  table(
    [ads ? 'Aimed' : 'From the hip', ...DISTANCES.map((d) => `${d} m`)],
    PILOT_ARMS.map((id, slot) => [
      WEAPONS[id].short,
      ...DISTANCES.map((d) => {
        const times: number[] = [];
        for (let s = 1; s <= DUELS; s++) {
          const { m, me, foe } = lane(s, d);
          times.push(timeToKill(m, me, slot, d, CHEST, ads, () => !foe.alive));
        }
        const hit = times.filter(Number.isFinite);
        return hit.length < times.length / 2 ? 'never' : sec(avg(hit));
      }),
    ]),
  );
}

console.log('2. Time for a pilot to bring down a standing mech at 25 m, aimed at the hull (reloads included)\n');
table(
  ['', ...FRAME_LIST.map((F) => `${F.short} (${F.health})`)],
  PILOT_ARMS.map((id, slot) => [
    WEAPONS[id].short,
    ...FRAME_LIST.map((_, frame) => {
      const { m, me, foe } = lane(1, 25);
      const k = m.mechs[foe.id];
      resetMech(k, { x: 66, y: 0.02, z: 37 }, Math.PI, frame);
      k.state = 'idle';
      enterMech(m, foe, k);
      k.state = 'piloted';
      return sec(timeToKill(m, me, slot, 25, HULL, true, () => k.state === 'none' || k.health <= 0));
    }),
  ]),
);

// ---------------------------------------------------------------- matches

const spire = mapById('spire-nine');
const world = await CollisionWorld.create(spire);

interface Tally {
  wins: number[];
  draws: number;
  lengths: number[];
  /** Points for a pilot killed, by what killed them. */
  killsBy: Map<string, number>;
  /** Kills and deaths of each bot role on foot. */
  role: Map<string, { kills: number; deaths: number }>;
  /** Per frame: mechs brought online, pilots killed from it, how long each lasted, what destroyed it. */
  frame: Map<string, { online: number; kills: number; mechs: number; lives: number[]; destroyedBy: Map<string, number> }>;
  pilotKills: number;
  mechKills: number;
}

const tally: Tally = { wins: [0, 0], draws: 0, lengths: [], killsBy: new Map(), role: new Map(), frame: new Map(), pilotKills: 0, mechKills: 0 };
const bump = <K>(map: Map<K, number>, k: K, n = 1): void => void map.set(k, (map.get(k) ?? 0) + n);
const roleOf = (a: Actor): string => a.brain?.role ?? 'human';
const frameStats = (id: string): NonNullable<ReturnType<Tally['frame']['get']>> => {
  let f = tally.frame.get(id);
  if (!f) tally.frame.set(id, (f = { online: 0, kills: 0, mechs: 0, lives: [], destroyedBy: new Map() }));
  return f;
};

const started = Date.now();
for (let seed = 1; seed <= MATCHES; seed++) {
  const m = createMatch(spire, world, { seed, humans: 0 });
  const onlineAt = new Map<number, number>();
  const cmds = m.actors.map(() => null);
  while (!m.over && m.time < MAX_MATCH) {
    stepMatch(m, world, cmds, TICK_DT);
    for (const e of m.events) {
      if (e.type === 'kill') {
        const killer = e.attacker >= 0 ? m.actors[e.attacker] : null;
        const victim = m.actors[e.victim];
        const inMech = killer?.inMech ?? false;
        bump(tally.killsBy, killer ? (inMech ? `${frameOf(m.mechs[killer.id]).short} (mech)` : e.weapon) : 'fall');
        if (inMech) frameStats(frameOf(m.mechs[killer!.id]).id).kills++;
        else if (killer) {
          const r = tally.role.get(roleOf(killer)) ?? { kills: 0, deaths: 0 };
          r.kills++;
          tally.role.set(roleOf(killer), r);
        }
        const v = tally.role.get(roleOf(victim)) ?? { kills: 0, deaths: 0 };
        v.deaths++;
        tally.role.set(roleOf(victim), v);
        tally.pilotKills++;
      } else if (e.type === 'mechOnline') {
        frameStats(frameOf(m.mechs[e.actor]).id).online++;
        onlineAt.set(e.actor, m.time);
      } else if (e.type === 'mechDestroyed') {
        const f = frameStats(frameOf(m.mechs[e.mech]).id);
        const at = onlineAt.get(e.mech);
        if (at !== undefined) f.lives.push(m.time - at);
        onlineAt.delete(e.mech);
        const killer = e.attacker >= 0 ? m.actors[e.attacker] : null;
        bump(f.destroyedBy, killer ? (killer.inMech ? 'mech' : e.weapon) : 'fall');
        if (killer?.inMech) frameStats(frameOf(m.mechs[killer.id]).id).mechs++;
        tally.mechKills++;
      }
    }
  }
  if (m.over) tally.wins[m.winner]++;
  else tally.draws++;
  tally.lengths.push(m.time);
  if (process.stdout.isTTY) process.stdout.write(`\r3. Playing bot matches on Spire Nine: ${seed} of ${MATCHES}`);
}
if (MATCHES === 0) process.exit(0);
console.log(`\r3. ${MATCHES} bot matches on Spire Nine (${((Date.now() - started) / 1000).toFixed(0)} s)\n`);

const played = MATCHES - tally.draws;
const lengths = [...tally.lengths].sort((a, b) => a - b);
table(
  ['Matches', 'Corps wins', 'Z.E.R.O wins', 'Unfinished', 'Length, median', 'Shortest', 'Longest'],
  [[MATCHES, pct(tally.wins[0], played), pct(tally.wins[1], played), tally.draws, `${(lengths[lengths.length >> 1] / 60).toFixed(1)} min`, `${(lengths[0] / 60).toFixed(1)} min`, `${(lengths[lengths.length - 1] / 60).toFixed(1)} min`]],
);

const kills = tally.pilotKills;
table(
  ['Pilots killed by', 'Kills', 'Share'],
  [...tally.killsBy].sort((a, b) => b[1] - a[1]).map(([k, n]) => [WEAPONS[k]?.short ?? k.toUpperCase(), n, pct(n, kills)]),
);

table(
  ['Bot role on foot', 'Weapon', 'Kills', 'Deaths', 'K/D'],
  [...tally.role].map(([r, s]) => [r, WEAPONS[BOT_ROLES[r]?.weapon]?.short ?? '', s.kills, s.deaths, (s.kills / Math.max(1, s.deaths)).toFixed(2)]),
);

table(
  ['Mech frame', 'Online', 'Per match', 'Pilots killed', 'Mechs destroyed', 'Points', 'Lifetime', 'Destroyed by'],
  FRAME_LIST.map((F) => {
    const f = frameStats(F.id);
    const n = Math.max(1, f.online);
    const by = [...f.destroyedBy].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${WEAPONS[k]?.short ?? k} ${c}`).join(', ');
    // Kills and points are per mech brought online.
    const points = (f.kills + f.mechs * COMBAT.mech.destroyScore) / n;
    return [F.short, f.online, (f.online / MATCHES).toFixed(1), (f.kills / n).toFixed(2), (f.mechs / n).toFixed(2), points.toFixed(2), `${avg(f.lives).toFixed(0)} s`, by || '-'];
  }),
);

const points = kills + tally.mechKills * COMBAT.mech.destroyScore;
console.log(`Points from pilots killed ${pct(kills, points)}, from mechs destroyed ${pct(tally.mechKills * COMBAT.mech.destroyScore, points)}.\n`);
