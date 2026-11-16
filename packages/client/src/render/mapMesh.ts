import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { eulerDegToQuat, type MapBox, type MapData } from '@dropline/shared';

/** How the texture of a style is painted. */
type Pattern = 'grid' | 'concrete' | 'asphalt' | 'pavement' | 'steel' | 'glass' | 'machine' | 'light' | 'hazard' | 'wreck' | 'windows' | 'vents';

interface Style {
  pattern: Pattern;
  base: string;
  line: string;
  /** Meters covered by one repeat of the texture. */
  cell: number;
  roughness: number;
  metalness: number;
  /** Glow colour; with `glowMap` only the painted lights glow. */
  emissive?: string;
  emissiveIntensity?: number;
  /** The texture doubles as the glow mask (lit windows, vents). */
  glowMap?: boolean;
  opacity?: number;
  /** Draw the box outlines (on by default). */
  edges?: boolean;
  /** Casts shadows (on by default). */
  shadow?: boolean;
}

/**
 * Map box `mat` key -> look. Unknown keys fall back to `block`. The first five
 * are the test map's grid look; the rest are the "brutalist cyberpunk" kit:
 * human concrete, steel and blue conduits, machine black and crimson.
 */
const STYLES: Record<string, Style> = {
  floor: { pattern: 'grid', base: '#3a424e', line: '#56637a', cell: 2, roughness: 0.92, metalness: 0.05, edges: false, shadow: false },
  wall: { pattern: 'grid', base: '#4a5464', line: '#6c7a92', cell: 2, roughness: 0.85, metalness: 0.1 },
  block: { pattern: 'grid', base: '#687488', line: '#8e9db6', cell: 2, roughness: 0.8, metalness: 0.15 },
  platform: { pattern: 'grid', base: '#2a7296', line: '#7fe0ff', cell: 2, roughness: 0.55, metalness: 0.35 },
  accent: { pattern: 'grid', base: '#cf6226', line: '#ffc79a', cell: 2, roughness: 0.6, metalness: 0.1, emissive: '#2a0d00' },

  asphalt: { pattern: 'asphalt', base: '#383b41', line: '#474a50', cell: 6, roughness: 0.95, metalness: 0, edges: false, shadow: false },
  pavement: { pattern: 'pavement', base: '#5d5e60', line: '#47484b', cell: 2, roughness: 0.9, metalness: 0, edges: false, shadow: false },
  concrete: { pattern: 'concrete', base: '#7a7f85', line: '#5c6167', cell: 4, roughness: 0.92, metalness: 0 },
  'concrete-dark': { pattern: 'concrete', base: '#51565d', line: '#3e434a', cell: 4, roughness: 0.92, metalness: 0 },
  slab: { pattern: 'concrete', base: '#878b90', line: '#696d72', cell: 4, roughness: 0.9, metalness: 0 },
  barrier: { pattern: 'concrete', base: '#a3a19b', line: '#7c7a74', cell: 2, roughness: 0.88, metalness: 0 },
  steel: { pattern: 'steel', base: '#6b4b3a', line: '#3d2c22', cell: 3, roughness: 0.75, metalness: 0.45 },
  girder: { pattern: 'steel', base: '#8a5a2e', line: '#4d321b', cell: 3, roughness: 0.7, metalness: 0.5 },
  glass: { pattern: 'glass', base: '#6fa6c4', line: '#cfeaff', cell: 3, roughness: 0.08, metalness: 0.6, opacity: 0.32, shadow: false },
  wreck: { pattern: 'wreck', base: '#5a524c', line: '#2c2724', cell: 3, roughness: 0.85, metalness: 0.4 },
  hazard: { pattern: 'hazard', base: '#d6a51c', line: '#1b1b1b', cell: 2, roughness: 0.7, metalness: 0.1 },
  machine: { pattern: 'machine', base: '#1d2026', line: '#3a3e46', cell: 4, roughness: 0.7, metalness: 0.35 },
  vents: { pattern: 'vents', base: '#0d0e10', line: '#ff2a3a', cell: 2, roughness: 0.6, metalness: 0.6, emissive: '#ff2a3a', emissiveIntensity: 1.4, glowMap: true },
  conduit: { pattern: 'light', base: '#3ab8ff', line: '#3ab8ff', cell: 4, roughness: 0.4, metalness: 0.2, emissive: '#3ab8ff', emissiveIntensity: 2.2, edges: false, shadow: false },
  crimson: { pattern: 'light', base: '#ff1f30', line: '#ff1f30', cell: 4, roughness: 0.4, metalness: 0.2, emissive: '#ff1428', emissiveIntensity: 1.3, edges: false, shadow: false },
  paint: { pattern: 'light', base: '#d9d6cc', line: '#d9d6cc', cell: 4, roughness: 0.8, metalness: 0, edges: false, shadow: false },
  skyline: { pattern: 'windows', base: '#2c3038', line: '#ffcf8a', cell: 12, roughness: 0.9, metalness: 0.1, emissive: '#ffcf8a', emissiveIntensity: 0.9, glowMap: true, edges: false, shadow: false },
  'skyline-dark': { pattern: 'concrete', base: '#24272c', line: '#1c1e22', cell: 12, roughness: 0.95, metalness: 0, edges: false, shadow: false },
  'skyline-machine': { pattern: 'vents', base: '#0b0c0e', line: '#ff2a3a', cell: 16, roughness: 0.6, metalness: 0.6, emissive: '#ff2a3a', emissiveIntensity: 1.1, glowMap: true, edges: false, shadow: false },
};

/** Cosmetic randomness for textures: the same every load, apart from gameplay randomness. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function speckle(g: CanvasRenderingContext2D, size: number, rnd: () => number, count: number, color: string, alpha: number, r: number): void {
  g.fillStyle = color;
  for (let i = 0; i < count; i++) {
    g.globalAlpha = alpha * (0.4 + rnd() * 0.6);
    g.fillRect(rnd() * size, rnd() * size, r * (0.5 + rnd()), r * (0.5 + rnd()));
  }
  g.globalAlpha = 1;
}

function paint(style: Style, key: string): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  let seed = 7;
  for (const ch of key) seed = Math.imul(seed, 31) + ch.charCodeAt(0);
  const rnd = lcg(seed);
  g.fillStyle = style.base;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = style.line;

  switch (style.pattern) {
    case 'grid':
      // Faint half-cell lines, then a firmer cell border.
      g.globalAlpha = 0.28;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(size / 2, 0);
      g.lineTo(size / 2, size);
      g.moveTo(0, size / 2);
      g.lineTo(size, size / 2);
      g.stroke();
      g.globalAlpha = 0.85;
      g.lineWidth = 4;
      g.strokeRect(0, 0, size, size);
      break;
    case 'concrete':
      // Poured panels: blotches, a seam on the border and form-tie holes.
      speckle(g, size, rnd, 900, '#000', 0.08, 3);
      speckle(g, size, rnd, 500, '#fff', 0.05, 3);
      g.globalAlpha = 0.7;
      g.lineWidth = 3;
      g.strokeRect(0, 0, size, size);
      g.fillStyle = style.line;
      for (const x of [0.25, 0.75]) for (const y of [0.25, 0.75]) {
        g.beginPath();
        g.arc(x * size, y * size, 4, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      break;
    case 'asphalt':
      speckle(g, size, rnd, 2500, '#000', 0.25, 2);
      speckle(g, size, rnd, 1200, '#8a8a8a', 0.12, 2);
      // A few cracks.
      g.globalAlpha = 0.5;
      g.lineWidth = 1.5;
      for (let c = 0; c < 3; c++) {
        let x = rnd() * size, y = rnd() * size;
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 6; k++) g.lineTo((x += (rnd() - 0.5) * 50), (y += (rnd() - 0.5) * 50));
        g.stroke();
      }
      g.globalAlpha = 1;
      break;
    case 'pavement':
      speckle(g, size, rnd, 800, '#000', 0.12, 2);
      g.globalAlpha = 0.8;
      g.lineWidth = 3;
      g.strokeRect(0, 0, size, size);
      g.beginPath();
      g.moveTo(size / 2, 0);
      g.lineTo(size / 2, size);
      g.moveTo(0, size / 2);
      g.lineTo(size, size / 2);
      g.stroke();
      g.globalAlpha = 1;
      break;
    case 'steel':
      // Rust streaks running down, bolted plate edges.
      for (let i = 0; i < 70; i++) {
        g.globalAlpha = 0.1 + rnd() * 0.25;
        g.fillStyle = rnd() < 0.5 ? style.line : '#a8693a';
        g.fillRect(rnd() * size, rnd() * size * 0.5, 2 + rnd() * 5, 30 + rnd() * 140);
      }
      g.globalAlpha = 0.9;
      g.lineWidth = 4;
      g.strokeRect(0, 0, size, size);
      g.globalAlpha = 1;
      break;
    case 'glass':
      // Mullions on the border, a light streak across.
      g.globalAlpha = 0.9;
      g.lineWidth = 8;
      g.strokeRect(0, 0, size, size);
      g.globalAlpha = 0.25;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(size * 0.2, size);
      g.lineTo(size * 0.45, size);
      g.lineTo(size * 0.85, 0);
      g.lineTo(size * 0.6, 0);
      g.fill();
      g.globalAlpha = 1;
      break;
    case 'machine':
      // Matte black panels with thin bevels and a diagonal cut.
      speckle(g, size, rnd, 400, '#fff', 0.03, 2);
      g.globalAlpha = 0.9;
      g.lineWidth = 2;
      g.strokeRect(4, 4, size - 8, size - 8);
      g.beginPath();
      g.moveTo(0, size * 0.7);
      g.lineTo(size * 0.3, size);
      g.moveTo(size * 0.6, 0);
      g.lineTo(size, size * 0.4);
      g.stroke();
      g.globalAlpha = 1;
      break;
    case 'vents': {
      // Black louvres with a crimson glow between them; the glow map is this same picture.
      g.fillStyle = '#000';
      g.fillRect(0, 0, size, size);
      for (let y = 18; y < size; y += 32) {
        g.fillStyle = style.line;
        g.globalAlpha = 0.55 + rnd() * 0.45;
        g.fillRect(24, y, size - 48, 6);
      }
      g.globalAlpha = 1;
      break;
    }
    case 'light':
      g.globalAlpha = 0.35;
      g.fillStyle = '#ffffff';
      g.fillRect(0, size * 0.4, size, size * 0.2);
      g.globalAlpha = 1;
      break;
    case 'hazard':
      g.fillStyle = style.line;
      for (let x = -size; x < size * 2; x += 64) {
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x + 32, 0);
        g.lineTo(x + 32 - size, size);
        g.lineTo(x - size, size);
        g.fill();
      }
      break;
    case 'wreck':
      // Burnt paint: soot over a scorched base.
      speckle(g, size, rnd, 600, '#000', 0.35, 6);
      speckle(g, size, rnd, 200, '#7a3a1a', 0.25, 5);
      g.globalAlpha = 0.8;
      g.lineWidth = 3;
      g.strokeRect(0, 0, size, size);
      g.globalAlpha = 1;
      break;
    case 'windows': {
      // A dark facade; a share of the windows lit. Black stays dark in the glow map.
      g.fillStyle = '#000';
      g.fillRect(0, 0, size, size);
      const n = 8;
      const step = size / n;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const lit = rnd() < 0.22;
        g.fillStyle = lit ? style.line : '#14161a';
        g.globalAlpha = lit ? 0.5 + rnd() * 0.5 : 1;
        g.fillRect(i * step + 5, j * step + 7, step - 10, step - 14);
      }
      g.globalAlpha = 1;
      break;
    }
  }
  return canvas;
}

function texture(canvas: HTMLCanvasElement, anisotropy: number, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

/** Scale box UVs so the texture keeps its real-world size on every face. */
function scaleUvs(geo: THREE.BoxGeometry, sx: number, sy: number, sz: number, cell: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z, four vertices each.
  const dims: [number, number][] = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let face = 0; face < 6; face++) {
    for (let v = 0; v < 4; v++) {
      const i = face * 4 + v;
      uv.setXY(i, (uv.getX(i) * dims[face][0]) / cell, (uv.getY(i) * dims[face][1]) / cell);
    }
  }
}

function material(key: string, style: Style, anisotropy: number): THREE.MeshStandardMaterial {
  const canvas = paint(style, key);
  const mat = new THREE.MeshStandardMaterial({
    map: texture(canvas, anisotropy, true),
    roughness: style.roughness,
    metalness: style.metalness,
    emissive: new THREE.Color(style.emissive ?? '#000000'),
    emissiveIntensity: style.emissiveIntensity ?? 1,
  });
  if (style.glowMap) mat.emissiveMap = texture(canvas, anisotropy, true);
  else if (style.pattern === 'light') mat.color.set('#ffffff');
  if (style.opacity !== undefined) {
    mat.transparent = true;
    mat.opacity = style.opacity;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
  }
  return mat;
}

/**
 * Build the visible level: one merged mesh per surface style plus edge lines.
 * Solid boxes cast and catch shadows; backdrop boxes (scenery and flat trim)
 * only catch them. `clip` boxes are never drawn.
 */
export function buildMapMeshes(map: MapData, renderer: THREE.WebGLRenderer): THREE.Group {
  const group = new THREE.Group();
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const byStyle = new Map<string, THREE.BufferGeometry[]>();
  const edgePositions: number[] = [];
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);

  const add = (box: MapBox, backdrop: boolean): void => {
    if (box.mat === 'clip') return;
    const key = box.mat in STYLES ? box.mat : 'block';
    const style = STYLES[key];
    const [sx, sy, sz] = box.size;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    scaleUvs(geo, sx, sy, sz, style.cell);
    const r = eulerDegToQuat(box.rot);
    m.compose(new THREE.Vector3(box.pos[0], box.pos[1], box.pos[2]), q.set(r.x, r.y, r.z, r.w), one);
    geo.applyMatrix4(m);

    const bucket = backdrop ? `${key}|bg` : key;
    if (!byStyle.has(bucket)) byStyle.set(bucket, []);
    byStyle.get(bucket)!.push(geo);

    if (style.edges !== false && !backdrop) {
      const edges = new THREE.EdgesGeometry(geo);
      edgePositions.push(...(edges.getAttribute('position').array as Float32Array));
      edges.dispose();
    }
  };
  for (const box of map.boxes) add(box, false);
  for (const box of map.backdrop ?? []) add(box, true);

  const materials = new Map<string, THREE.MeshStandardMaterial>();
  for (const [bucket, geos] of byStyle) {
    const [key, bg] = bucket.split('|');
    const style = STYLES[key];
    let mat = materials.get(key);
    if (!mat) materials.set(key, (mat = material(key, style, anisotropy)));
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.castShadow = !bg && style.shadow !== false;
    mesh.receiveShadow = true;
    // See-through surfaces draw after the solid ones.
    if (style.opacity !== undefined) mesh.renderOrder = 1;
    group.add(mesh);
    for (const g of geos) g.dispose();
  }

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
  // The test map keeps its bright outlines; real maps get a faint edge that only helps read shapes.
  const opacity = map.env ? 0.1 : 0.22;
  group.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: '#cfe6ff', transparent: true, opacity })));

  return group;
}
