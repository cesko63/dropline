import * as THREE from 'three';

/**
 * The effects' textures, painted once at start-up from seeded noise, so every
 * run looks the same and nothing is downloaded. Atlases hold four tiles in a
 * 2 × 2 grid: tile `i` sits at column `i % 2`, row `floor(i / 2)` from the top.
 */

/** A small seeded generator: the textures never change between runs. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise that wraps every `period` cells, summed over octaves (fbm), 0..1. */
function makeNoise(seed: number, period = 16): (x: number, y: number, octaves?: number) => number {
  const rand = rng(seed);
  const grid = new Float32Array(period * period).map(() => rand());
  const at = (x: number, y: number): number => grid[(((y % period) + period) % period) * period + (((x % period) + period) % period)];
  const fade = (t: number): number => t * t * (3 - 2 * t);
  const value = (x: number, y: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return a + (b - a) * fy;
  };
  return (x, y, octaves = 4) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += value(x * 2 ** o, y * 2 ** o) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function canvasTexture(size: number, paint: (data: Uint8ClampedArray) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  paint(img.data);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  // The channels are data (density, light), not colour.
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * Four puffs of smoke. Red is density: lumpy clouds of overlapping blobs, worn
 * ragged by noise, that fade to nothing before the tile's edge. Green is how
 * much light reaches each point from above, found by marching up through the
 * density, so a puff is bright on top and dark underneath. Painted once and shared.
 */
export function smokeAtlas(): THREE.CanvasTexture {
  smoke ??= paintSmoke();
  return smoke;
}
let smoke: THREE.CanvasTexture | null = null;

function paintSmoke(): THREE.CanvasTexture {
  const tile = 128;
  const size = tile * 2;
  const noise = makeNoise(7, 16);
  const rand = rng(11);
  const density = new Float32Array(size * size);
  for (let t = 0; t < 4; t++) {
    const ox = (t % 2) * tile;
    const oy = Math.floor(t / 2) * tile;
    // A cluster of blobs around the middle.
    const blobs: number[][] = [];
    const count = 5 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const r = i === 0 ? 0 : 0.1 + rand() * 0.16;
      blobs.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, 0.16 + rand() * 0.12]);
    }
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const u = (x + 0.5) / tile;
        const v = (y + 0.5) / tile;
        let d = 0;
        for (const [bx, by, br] of blobs) {
          const q = ((u - bx) ** 2 + (v - by) ** 2) / (br * br);
          d += Math.exp(-q * 1.6);
        }
        // Soft-saturate the blobs, then let noise carve billows into them.
        const n = noise(u * 3.2 + t * 3.1, v * 3.2 + t * 1.7, 5);
        d = (1 - Math.exp(-d * 1.2)) * (0.2 + n * 1.25) - 0.12;
        // Nothing may reach the tile's edge, or the quad would show.
        const edge = Math.hypot(u - 0.5, v - 0.5);
        d *= 1 - smoothstep(0.34, 0.5, edge);
        density[(oy + y) * size + ox + x] = Math.min(1, Math.max(0, d));
      }
    }
  }
  return canvasTexture(size, (px) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const d = density[i];
        // Light from the top of the tile, dimmed by the smoke it passes through.
        let shadow = 0;
        const top = Math.floor(y / tile) * tile;
        for (let s = 1; s <= 6; s++) {
          const yy = y - s * 5;
          if (yy < top) break;
          shadow += density[yy * size + x];
        }
        const lit = Math.exp(-shadow * 0.3);
        px[i * 4] = d * 255;
        px[i * 4 + 1] = (0.15 + 0.85 * lit) * 255;
        px[i * 4 + 2] = 0;
        px[i * 4 + 3] = 255;
      }
    }
  });
}

/**
 * Fire, as brightness in red: tiles 0 and 1 are balls of rolling flame for
 * blasts, tile 2 a tongue of flame (noise stretched upward inside a teardrop)
 * for things that burn, tile 3 a soft round glow for flashes, embers and
 * spark heads.
 */
export function fireAtlas(): THREE.CanvasTexture {
  const tile = 128;
  const size = tile * 2;
  const noise = makeNoise(23, 16);
  return canvasTexture(size, (px) => {
    for (let t = 0; t < 4; t++) {
      const ox = (t % 2) * tile;
      const oy = Math.floor(t / 2) * tile;
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const u = (x + 0.5) / tile - 0.5;
          // 0 at the bottom of the tile, 1 at the top.
          const h = 1 - (y + 0.5) / tile;
          let b: number;
          const r = Math.hypot(u, h - 0.5) * 2;
          if (t === 3) {
            b = Math.exp(-r * r * 5) * (1 - smoothstep(0.75, 1, r));
          } else if (t < 2) {
            // A ball of rolling flame: turbulent, brightest inside, soft at the rim.
            const n = noise(u * 5 + t * 5.3, h * 5 + t * 2.1, 5);
            b = Math.max(0, (1 - smoothstep(0.1, 0.95, r)) * (0.35 + n * 1.3) - 0.2) * 1.4;
          } else {
            // Wide and round low down, narrowing to a lick at the top that wavers side to side.
            const sway = (noise(h * 2.5 + 7, 3.3, 3) - 0.5) * 0.35 * h;
            const width = 0.36 * (1 - smoothstep(0.15, 0.95, h) * 0.8) * (h < 0.2 ? 0.6 + h * 2 : 1);
            const shape = 1 - smoothstep(width * 0.3, width, Math.abs(u - sway));
            const n = noise((u + t * 0.37) * 6, h * 3 + t * 2.3, 4);
            const body = shape * smoothstep(0.02, 0.2, h) * (1 - smoothstep(0.5, 0.97, h));
            b = Math.max(0, body * (0.55 + n * 0.9) - 0.18 * h);
            b *= 1 - smoothstep(0.9, 1, r);
          }
          const i = ((oy + y) * size + ox + x) * 4;
          px[i] = Math.min(1, b) * 255;
          px[i + 1] = px[i + 2] = 0;
          px[i + 3] = 255;
        }
      }
    }
  });
}

/**
 * Marks left on a surface, as coverage in every colour channel (an alpha map,
 * so each kind of mark takes its own tint): tile 0 a bullet hole with
 * a chipped rim, tile 1 a blast scorch with streaks thrown out from the middle,
 * tile 2 a smaller pockmark, tile 3 a scuff of dust for a heavy footfall.
 */
export function markAtlas(): THREE.CanvasTexture {
  const tile = 128;
  const size = tile * 2;
  const noise = makeNoise(41, 16);
  const rand = rng(43);
  const rays = Array.from({ length: 16 }, () => [rand() * Math.PI * 2, 0.3 + rand() * 0.6, 0.06 + rand() * 0.1]);
  return canvasTexture(size, (px) => {
    for (let t = 0; t < 4; t++) {
      const ox = (t % 2) * tile;
      const oy = Math.floor(t / 2) * tile;
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const u = (x + 0.5) / tile - 0.5;
          const v = (y + 0.5) / tile - 0.5;
          const r = Math.hypot(u, v) * 2;
          const n = noise(u * 9 + t * 4, v * 9, 4);
          let a: number;
          if (t === 0 || t === 2) {
            const hole = t === 0 ? 0.16 : 0.24;
            const rim = r + (n - 0.5) * 0.35;
            a = rim < hole ? 1 : Math.max(0, 0.75 * (1 - smoothstep(hole, 0.85, rim)) * (0.5 + n));
          } else if (t === 1) {
            const ang = Math.atan2(v, u);
            let streak = 0;
            for (const [ra, len, w] of rays) {
              // Angle between this point and the ray, the short way round.
              let d = (((ang - ra) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
              d = Math.min(d, Math.PI * 2 - d);
              streak = Math.max(streak, (1 - smoothstep(0, w, d)) * (1 - smoothstep(len * 0.6, len, r)));
            }
            const core = 1 - smoothstep(0.1, 0.62, r + (n - 0.5) * 0.3);
            a = Math.min(1, core * 0.95 + streak * 0.35 * (0.3 + n)) * (1 - smoothstep(0.8, 1, r));
          } else {
            a = (1 - smoothstep(0.2, 0.95, r + (n - 0.5) * 0.5)) * (0.3 + n * 0.5);
          }
          const i = ((oy + y) * size + ox + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = Math.min(1, Math.max(0, a)) * 255;
          px[i + 3] = 255;
        }
      }
    }
  });
}

/** A round drop at (cx, cy), radius r, with an anti-aliased edge `soft` wide: 1 inside, 0 outside. */
function disc(u: number, v: number, cx: number, cy: number, r: number, soft = 0.02): number {
  return 1 - smoothstep(r - soft, r + soft, Math.hypot(u - cx, v - cy));
}

/**
 * What flies out of a wounded pilot (blood, or a machine's oil), for the gore
 * layer. Red is density, green the light from above, as in the smoke atlas:
 * tile 0 a single round drop (also drawn stretched into a streak), tile 1 a
 * cluster of drops, tile 2 a soft cloud of mist, tile 3 a ragged clot.
 */
export function dropAtlas(): THREE.CanvasTexture {
  const tile = 64;
  const size = tile * 2;
  const noise = makeNoise(61, 16);
  const rand = rng(67);
  const cluster = Array.from({ length: 6 }, (_, i) => [rand() * 0.5 - 0.25, rand() * 0.5 - 0.25, i === 0 ? 0.2 : 0.06 + rand() * 0.08]);
  return canvasTexture(size, (px) => {
    for (let t = 0; t < 4; t++) {
      const ox = (t % 2) * tile;
      const oy = Math.floor(t / 2) * tile;
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const u = (x + 0.5) / tile - 0.5;
          const v = (y + 0.5) / tile - 0.5;
          const r = Math.hypot(u, v) * 2;
          const n = noise(u * 6 + t * 3, v * 6 + t * 5, 4);
          let d: number;
          if (t === 0) d = disc(u, v, 0, 0, 0.36, 0.06);
          else if (t === 1) d = Math.max(...cluster.map(([cx, cy, cr]) => disc(u, v, cx, cy, cr, 0.03)));
          else if (t === 2) d = (1 - smoothstep(0.1, 0.95, r)) * (0.25 + n * 0.9) * 0.8;
          else d = 1 - smoothstep(0.45, 0.6, r + (n - 0.5) * 0.6);
          // Lit from the top, with a wet highlight up and to the left on the solid drops.
          const top = 0.35 + 0.65 * smoothstep(0.4, -0.4, v);
          const shine = t === 2 ? 0 : disc(u, v, -0.1, -0.12, 0.08, 0.05) * 0.6;
          const i = ((oy + y) * size + ox + x) * 4;
          px[i] = Math.min(1, Math.max(0, d)) * 255;
          px[i + 1] = Math.min(1, t === 2 ? 0.6 + 0.4 * top : top + shine) * 255;
          px[i + 2] = 0;
          px[i + 3] = 255;
        }
      }
    }
  });
}

/**
 * Stains a wound leaves on the world, as coverage in every channel (an alpha
 * map): tile 0 a splat (a blot thrown round with drops), tile 1 a pool, tile 2
 * a spray fanning out along +U from its left edge (laid along the shot), tile 3
 * scattered drops.
 */
export function stainAtlas(): THREE.CanvasTexture {
  stains ??= paintStains();
  return stains;
}
let stains: THREE.CanvasTexture | null = null;

function paintStains(): THREE.CanvasTexture {
  const tile = 128;
  const size = tile * 2;
  const noise = makeNoise(71, 16);
  const rand = rng(73);
  // Drops of each tile: centre, radius, and how far each is drawn out along the spray.
  const splat = Array.from({ length: 22 }, () => {
    const a = rand() * Math.PI * 2;
    const r = 0.22 + rand() * 0.24;
    return [Math.cos(a) * r, Math.sin(a) * r, 0.008 + rand() * 0.025];
  });
  const spray = Array.from({ length: 46 }, () => {
    const along = rand() ** 0.7;
    const across = (rand() - 0.5) * (0.06 + along * 0.55);
    return [-0.42 + along * 0.88, across, (0.03 - along * 0.022) * (0.5 + rand())];
  });
  const drops = Array.from({ length: 14 }, () => [(rand() - 0.5) * 0.8, (rand() - 0.5) * 0.8, 0.015 + rand() * 0.05]);
  return canvasTexture(size, (px) => {
    for (let t = 0; t < 4; t++) {
      const ox = (t % 2) * tile;
      const oy = Math.floor(t / 2) * tile;
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const u = (x + 0.5) / tile - 0.5;
          const v = (y + 0.5) / tile - 0.5;
          const r = Math.hypot(u, v);
          const ang = Math.atan2(v, u);
          const n = noise(u * 8 + t * 4, v * 8 + t * 2, 4);
          let a = 0;
          if (t === 0) {
            const blot = 1 - smoothstep(0.17, 0.2, r + (n - 0.5) * 0.12 - 0.03 * Math.sin(ang * 7));
            a = Math.max(blot, ...splat.map(([cx, cy, cr]) => disc(u, v, cx, cy, cr, 0.006)));
          } else if (t === 1) {
            const lobes = 0.33 + 0.05 * Math.sin(ang * 3 + 1) + 0.03 * Math.sin(ang * 5 + 2) + (n - 0.5) * 0.08;
            a = (1 - smoothstep(lobes - 0.015, lobes + 0.015, r)) * (0.85 + 0.15 * n);
          } else if (t === 2) {
            // Each drop is drawn out along the spray, 2.5 times as long as it is wide.
            for (const [cx, cy, cr] of spray) a = Math.max(a, disc((u - cx) / 2.5 + cx, v, cx, cy, cr, 0.006));
            a = Math.max(a, 1 - smoothstep(0.06, 0.08, Math.hypot((u + 0.38) * 0.7, v) + (n - 0.5) * 0.05));
          } else {
            for (const [cx, cy, cr] of drops) a = Math.max(a, disc(u, v, cx, cy, cr * (0.8 + n * 0.4), 0.006));
          }
          // Nothing may reach the tile's edge.
          a *= 1 - smoothstep(0.46, 0.5, Math.max(Math.abs(u), Math.abs(v)));
          const i = ((oy + y) * size + ox + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = Math.min(1, Math.max(0, a)) * 255;
          px[i + 3] = 255;
        }
      }
    }
  });
}
