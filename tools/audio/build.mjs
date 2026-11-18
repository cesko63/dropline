// Builds the game's sound files from CC0 recordings. Run: pnpm audio
//
// tools/audio/sounds.json lists the packs (all CC0, from OpenGameArt) and, for
// each sound the game plays, the recordings it is cut from: [pack, file in it,
// start, length] (a one-shot's take can be shorter or longer than the rest). A sound can have
// several takes; the game picks one at random each time. This script downloads
// the packs into tools/audio/.cache (not committed), cuts each take, and writes:
//   assets/audio/<sound>-<n>.mp3   the takes (mono, 44.1 kHz, 64 kb/s MP3)
//   assets/audio/sounds.json       how many takes each sound has, and loop lengths
//   AUDIO.md                       where every file came from, and its size
//
// Processing per take: cut from `start` (seconds) for at most `length`, drop
// silence below -50 dBFS at the front, fade the end out, normalise the peak to
// -1 dBFS. A loop instead has its end cross-faded into its start, so it repeats
// without a seam, and carries PAD seconds of its own wrap on each side: the
// game loops the middle, so the gap an MP3 decoder may add at either end never
// plays. Needs ffmpeg, curl, unzip, and 7z (or python3 with py7zr).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE = join(ROOT, 'tools/audio/.cache');
const OUT = join(ROOT, 'assets/audio');
const BASE_URL = 'https://opengameart.org/sites/default/files/';
const RATE = 44100;
const PAD = 0.05;
const CROSSFADE = 0.25;
const SILENCE = 10 ** (-50 / 20);
const PEAK = 10 ** (-1 / 20);

const spec = JSON.parse(readFileSync(join(ROOT, 'tools/audio/sounds.json'), 'utf8'));

function run(cmd, args, input) {
  try {
    return execFileSync(cmd, args, { input, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(`${cmd} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

/** Downloads and unpacks a pack once; returns the folder (or file) it lives in. */
function fetchPack(id) {
  const pack = spec.packs[id];
  if (!pack) throw new Error(`sounds.json: no pack "${id}"`);
  const name = decodeURIComponent(pack.file);
  const download = join(CACHE, 'downloads', name);
  if (!existsSync(download)) {
    mkdirSync(dirname(download), { recursive: true });
    console.log(`downloading ${pack.title}`);
    run('curl', ['-fsSL', '--retry', '3', '-o', download, BASE_URL + pack.file]);
  }
  if (!/\.(zip|7z)$/i.test(name)) return download;
  const dir = join(CACHE, id);
  if (existsSync(dir)) return dir;
  mkdirSync(dir, { recursive: true });
  if (name.endsWith('.zip')) run('unzip', ['-q', '-o', download, '-d', dir]);
  else {
    try {
      run('7z', ['x', '-y', `-o${dir}`, download]);
    } catch {
      run('python3', ['-m', 'py7zr', 'x', download, dir]);
    }
  }
  return dir;
}

/** Mono float samples of `seconds` of a file from `start`. */
function decode(file, start, seconds) {
  const raw = run('ffmpeg', ['-v', 'error', '-i', file, '-ss', String(start), '-t', String(seconds), '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-']);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function oneShot(x, length) {
  let first = 0;
  while (first < x.length && Math.abs(x[first]) < SILENCE) first++;
  const y = x.slice(first, first + Math.round(length * RATE));
  if (y.length === 0) throw new Error('nothing above -50 dBFS');
  // A 3 ms fade in keeps a cut mid-wave from clicking; the end fades over 30% (at most 80 ms).
  const fadeIn = Math.min(y.length, Math.round(0.003 * RATE));
  for (let i = 0; i < fadeIn; i++) y[i] *= i / fadeIn;
  const fadeOut = Math.round(Math.min(0.08, (y.length / RATE) * 0.3) * RATE);
  for (let i = 0; i < fadeOut; i++) y[y.length - 1 - i] *= i / fadeOut;
  return y;
}

function loop(x, length) {
  const n = Math.round(length * RATE);
  const xf = Math.round(CROSSFADE * RATE);
  if (x.length < n + xf) throw new Error(`a loop of ${length} s needs ${(n + xf) / RATE} s of source`);
  const body = x.slice(0, n);
  // The head fades in over what follows the cut, so the end runs on into the start.
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    body[i] = x[i] * Math.sin((t * Math.PI) / 2) + x[n + i] * Math.cos((t * Math.PI) / 2);
  }
  const pad = Math.round(PAD * RATE);
  const out = new Float32Array(n + 2 * pad);
  out.set(body.subarray(n - pad), 0);
  out.set(body, pad);
  out.set(body.subarray(0, pad), pad + n);
  return out;
}

function normalise(y) {
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  const gain = PEAK / peak;
  for (let i = 0; i < y.length; i++) y[i] *= gain;
  return y;
}

function encode(samples, file) {
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', '-', '-codec:a', 'libmp3lame', '-b:a', '64k', file], pcm);
}

mkdirSync(OUT, { recursive: true });
const manifest = {};
const rows = [];
const written = new Set();
for (const [sound, def] of Object.entries(spec.sounds)) {
  manifest[sound] = def.loop ? { count: def.from.length, loop: def.length, pad: PAD } : { count: def.from.length };
  def.from.forEach(([packId, inner, start = 0, length = def.length], i) => {
    const where = fetchPack(packId);
    const source = inner ? join(where, inner) : where;
    if (!existsSync(source)) throw new Error(`${sound}: ${source} not found`);
    // The game loops every take of a sound over the same span.
    if (def.loop && length !== def.length) throw new Error(`${sound}: a loop's takes cannot have their own length`);
    const take = decode(source, start, length + (def.loop ? CROSSFADE : 0.5));
    let samples;
    try {
      samples = normalise(def.loop ? loop(take, length) : oneShot(take, length));
    } catch (err) {
      throw new Error(`${sound} take ${i + 1}: ${err.message}`);
    }
    const name = `${sound}-${i + 1}.mp3`;
    encode(samples, join(OUT, name));
    written.add(name);
    const pack = spec.packs[packId];
    rows.push(`| ${name} | ${pack.title} | ${pack.author} | ${inner || decodeURIComponent(pack.file)}${start ? ` @ ${start} s` : ''} | ${statSync(source).size} | ${statSync(join(OUT, name)).size} |`);
  });
}
for (const f of readdirSync(OUT)) if (f.endsWith('.mp3') && !written.has(f)) rmSync(join(OUT, f));
writeFileSync(join(OUT, 'sounds.json'), JSON.stringify(manifest, null, 2) + '\n');

const total = [...written].reduce((sum, f) => sum + statSync(join(OUT, f)).size, 0);
const packs = Object.values(spec.packs).map((p) => `- [${p.title}](${p.page}) by ${p.author}`);
writeFileSync(
  join(ROOT, 'AUDIO.md'),
  `# Audio

Every recorded sound in DROPLINE, where it came from and what it weighs. All
sources are CC0 (public domain) from OpenGameArt. This file is written by
\`pnpm audio\` (tools/audio/build.mjs) from tools/audio/sounds.json; edit those,
not this.

Processing: cut from the source at the given time, silence below -50 dBFS
dropped from the front, the end faded out (loops: end cross-faded into the
start), peak normalised to -1 dBFS, mono 44.1 kHz MP3 at 64 kb/s. Bytes are the
whole source file (original) and the shipped take (runtime).

${written.size} files, ${(total / 1024).toFixed(0)} KB in all.

## Sources

${packs.join('\n')}

## Files

| File | Source | Author | Taken from | Original bytes | Runtime bytes |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`,
);
console.log(`${written.size} files, ${(total / 1024).toFixed(0)} KB`);
