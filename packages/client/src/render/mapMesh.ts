import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { eulerDegToQuat, type MapData } from '@dropline/shared';

/** One grid cell covers this many meters. */
const CELL = 2;

interface Style {
  base: string;
  line: string;
  roughness: number;
  metalness: number;
  emissive?: string;
}

/** Map box `mat` key -> look. Unknown keys fall back to `block`. */
const STYLES: Record<string, Style> = {
  floor: { base: '#3a424e', line: '#56637a', roughness: 0.92, metalness: 0.05 },
  wall: { base: '#4a5464', line: '#6c7a92', roughness: 0.85, metalness: 0.1 },
  block: { base: '#687488', line: '#8e9db6', roughness: 0.8, metalness: 0.15 },
  platform: { base: '#2a7296', line: '#7fe0ff', roughness: 0.55, metalness: 0.35 },
  accent: { base: '#cf6226', line: '#ffc79a', roughness: 0.6, metalness: 0.1, emissive: '#2a0d00' },
};

function gridTexture(style: Style, anisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = style.base;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = style.line;
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
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

/** Scale box UVs so the grid keeps its real-world size on every face. */
function scaleUvs(geo: THREE.BoxGeometry, sx: number, sy: number, sz: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z, four vertices each.
  const dims: [number, number][] = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let face = 0; face < 6; face++) {
    for (let v = 0; v < 4; v++) {
      const i = face * 4 + v;
      uv.setXY(i, (uv.getX(i) * dims[face][0]) / CELL, (uv.getY(i) * dims[face][1]) / CELL);
    }
  }
}

/** Build the visible level: one merged mesh per surface style plus edge lines. */
export function buildMapMeshes(map: MapData, renderer: THREE.WebGLRenderer): THREE.Group {
  const group = new THREE.Group();
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const byStyle = new Map<string, THREE.BufferGeometry[]>();
  const edgePositions: number[] = [];
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);

  for (const box of map.boxes) {
    const [sx, sy, sz] = box.size;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    scaleUvs(geo, sx, sy, sz);
    const r = eulerDegToQuat(box.rot);
    m.compose(new THREE.Vector3(box.pos[0], box.pos[1], box.pos[2]), q.set(r.x, r.y, r.z, r.w), one);
    geo.applyMatrix4(m);

    const key = box.mat in STYLES ? box.mat : 'block';
    if (!byStyle.has(key)) byStyle.set(key, []);
    byStyle.get(key)!.push(geo);

    if (key !== 'floor') {
      const edges = new THREE.EdgesGeometry(geo);
      edgePositions.push(...(edges.getAttribute('position').array as Float32Array));
      edges.dispose();
    }
  }

  for (const [key, geos] of byStyle) {
    const style = STYLES[key];
    const mesh = new THREE.Mesh(
      mergeGeometries(geos),
      new THREE.MeshStandardMaterial({
        map: gridTexture(style, anisotropy),
        roughness: style.roughness,
        metalness: style.metalness,
        emissive: new THREE.Color(style.emissive ?? '#000000'),
      }),
    );
    mesh.castShadow = key !== 'floor';
    mesh.receiveShadow = true;
    group.add(mesh);
    for (const g of geos) g.dispose();
  }

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
  group.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: '#cfe6ff', transparent: true, opacity: 0.22 })));

  return group;
}
