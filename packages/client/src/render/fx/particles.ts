import * as THREE from 'three';

/**
 * What one particle does over its life. Effects fill one of these and hand it
 * to `ParticleLayer.emit`; the layer copies it, so the same object is reused
 * for every spawn and nothing is allocated during play.
 */
export interface Emit {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds it lives, after `delay` seconds of waiting unseen. */
  life: number;
  delay: number;
  /** Width in meters at birth and at death; it eases from one to the other, fast at first. */
  size0: number;
  size1: number;
  /** Colour at birth and at death, linear RGB. */
  r0: number;
  g0: number;
  b0: number;
  r1: number;
  g1: number;
  b1: number;
  /** Peak opacity, and the share of its life spent fading in. */
  alpha: number;
  fadeIn: number;
  /** Speed lost per second (exponential), metres per second² of pull (negative rises), and how much the wind carries it. */
  drag: number;
  gravity: number;
  wind: number;
  /** Turning, radians per second; an upright one starts unturned and stays so. */
  spin: number;
  upright: boolean;
  /** Atlas tile; -1 picks one of the four at random. */
  tile: number;
  /** Seconds of travel drawn as a streak behind it (sparks), 0 for a round sprite. */
  stretch: number;
  /** Height of the floor under it, and how much speed a bounce keeps (0 stops dead, -1 means no floor). */
  floor: number;
  bounce: number;
  /**
   * Keeps the sprite's middle this share of its current width in front of the
   * surface it came off (0 for none): the plane through a point at distance
   * `planeD` along the normal (`planeX`, `planeY`, `planeZ`). Smoke and dust then
   * roll along a floor or wall as they swell instead of being cut off by it.
   */
  hover: number;
  planeX: number;
  planeY: number;
  planeZ: number;
  planeD: number;
}

export function emitTemplate(): Emit {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, delay: 0, size0: 1, size1: 1,
    r0: 1, g0: 1, b0: 1, r1: 1, g1: 1, b1: 1, alpha: 1, fadeIn: 0.1,
    drag: 0, gravity: 0, wind: 0, spin: 0, upright: false, tile: -1, stretch: 0, floor: 0, bounce: -1, hover: 0, planeX: 0, planeY: 1, planeZ: 0, planeD: -1e9,
  };
}

/** Per-particle numbers, in one flat array: STRIDE floats each. */
const STRIDE = 33;
const enum F {
  X, Y, Z, VX, VY, VZ, AGE, LIFE, S0, S1, R0, G0, B0, R1, G1, B1, ALPHA, FADE, DRAG, GRAV, WIND, ROT, SPIN, TILE, STRETCH, FLOOR, BOUNCE,
  HOVER, PX, PY, PZ, PD, DEPTH,
}

export interface LayerOptions {
  capacity: number;
  map: THREE.Texture;
  /** Additive light (fire, sparks, glows) or blended matter (smoke, dust, steam). */
  additive: boolean;
  /** Draw back to front: needed for blended matter, pointless for light. */
  sorted: boolean;
  /** Distance from the eye over which a sprite fades out, so a puff never fills the view. */
  nearFade: [number, number];
}

const vertexShader = /* glsl */ `
  attribute vec4 iPos;
  attribute vec4 iAxis;
  attribute vec4 iColor;
  attribute float iTile;
  uniform vec2 nearFade;
  varying vec2 vUv;
  varying vec4 vColor;
  #include <fog_pars_vertex>
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(iPos.xyz, 1.0);
    float size = iPos.w;
    vec2 corner = position.xy;
    vec2 ax = (modelViewMatrix * vec4(iAxis.xyz, 0.0)).xy;
    float len = length(ax);
    vec2 offs;
    if (len > 1e-4) {
      // A streak: long along its motion on screen, its head at the particle.
      vec2 d = ax / len;
      vec2 n = vec2(-d.y, d.x);
      offs = d * (corner.y * (size + len) - len * 0.5) + n * corner.x * size;
    } else {
      float c = cos(iAxis.w);
      float s = sin(iAxis.w);
      offs = mat2(c, s, -s, c) * corner * size;
    }
    // Pulled toward the eye by a third of its size, so it does not cut a hard
    // line into the floor or wall it sits against.
    float depth = -mvPosition.z;
    float pull = min(size * 0.35, max(0.0, depth - nearFade.x));
    mvPosition.xyz += normalize(-mvPosition.xyz) * pull;
    mvPosition.xy += offs;
    vUv = (uv + vec2(mod(iTile, 2.0), 1.0 - floor(iTile / 2.0))) * 0.5;
    vColor = iColor;
    vColor.a *= smoothstep(nearFade.x, nearFade.y, depth);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 litColor;
  uniform vec3 shadeColor;
  varying vec2 vUv;
  varying vec4 vColor;
  #include <fog_pars_fragment>
  void main() {
    vec4 t = texture2D(map, vUv);
    #ifdef ADDITIVE
      // Added as it is (the alpha of 1 keeps the blend from scaling it twice).
      gl_FragColor = vec4(vColor.rgb * (t.r * vColor.a), 1.0);
    #else
      float a = t.r * vColor.a;
      if (a < 0.004) discard;
      gl_FragColor = vec4(vColor.rgb * mix(shadeColor, litColor, t.g), a);
    #endif
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogF = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      #ifdef ADDITIVE
        gl_FragColor.rgb *= 1.0 - fogF;
      #else
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogF);
      #endif
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const view = new THREE.Vector3();

/**
 * One kind of camera-facing sprite (all the smoke, all the fire): a fixed pool
 * simulated on the CPU and drawn as a single instanced quad batch. When the
 * pool is full the oldest particle makes room.
 */
export class ParticleLayer {
  readonly mesh: THREE.Mesh;
  private readonly data: Float32Array;
  private readonly capacity: number;
  private readonly sorted: boolean;
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly axis: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly tile: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  /** Indices of the live particles, sorted far to near when the layer sorts. */
  private readonly order: number[] = [];
  private next = 0;
  /** Particles alive (or waiting on their delay) after the last update. */
  live = 0;

  constructor(o: LayerOptions) {
    this.capacity = o.capacity;
    this.sorted = o.sorted;
    this.data = new Float32Array(o.capacity * STRIDE);
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = (this.geometry = new THREE.InstancedBufferGeometry());
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    const attr = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(o.capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    g.setAttribute('iPos', (this.pos = attr(4)));
    g.setAttribute('iAxis', (this.axis = attr(4)));
    g.setAttribute('iColor', (this.color = attr(4)));
    g.setAttribute('iTile', (this.tile = attr(1)));
    g.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { litColor: { value: new THREE.Color(1, 1, 1) }, shadeColor: { value: new THREE.Color(0.4, 0.4, 0.4) }, nearFade: { value: new THREE.Vector2() } },
      ]),
      vertexShader,
      fragmentShader,
      defines: o.additive ? { ADDITIVE: '' } : {},
      transparent: true,
      depthWrite: false,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.material.uniforms.map = { value: o.map };
    this.material.uniforms.nearFade.value.set(o.nearFade[0], o.nearFade[1]);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    // Light draws after blended matter, so fire glows through its own smoke.
    this.mesh.renderOrder = o.additive ? 2 : 1;
  }

  /** How blended matter is lit: the colour of its sunlit tops and of its shaded undersides. */
  setLight(lit: THREE.Color, shade: THREE.Color): void {
    this.material.uniforms.litColor.value.copy(lit);
    this.material.uniforms.shadeColor.value.copy(shade);
  }

  emit(e: Emit): void {
    const d = this.data;
    const o = (this.next++ % this.capacity) * STRIDE;
    d[o + F.X] = e.x;
    d[o + F.Y] = e.y;
    d[o + F.Z] = e.z;
    d[o + F.VX] = e.vx;
    d[o + F.VY] = e.vy;
    d[o + F.VZ] = e.vz;
    d[o + F.AGE] = -e.delay;
    d[o + F.LIFE] = Math.max(0.01, e.life);
    d[o + F.S0] = e.size0;
    d[o + F.S1] = e.size1;
    d[o + F.R0] = e.r0;
    d[o + F.G0] = e.g0;
    d[o + F.B0] = e.b0;
    d[o + F.R1] = e.r1;
    d[o + F.G1] = e.g1;
    d[o + F.B1] = e.b1;
    d[o + F.ALPHA] = e.alpha;
    d[o + F.FADE] = Math.max(0.001, e.fadeIn);
    d[o + F.DRAG] = e.drag;
    d[o + F.GRAV] = e.gravity;
    d[o + F.WIND] = e.wind;
    d[o + F.ROT] = e.upright ? 0 : Math.random() * Math.PI * 2;
    d[o + F.SPIN] = e.upright ? 0 : e.spin * (Math.random() < 0.5 ? -1 : 1);
    d[o + F.TILE] = e.tile < 0 ? Math.floor(Math.random() * 4) : e.tile;
    d[o + F.STRETCH] = e.stretch;
    d[o + F.FLOOR] = e.floor;
    d[o + F.BOUNCE] = e.bounce;
    d[o + F.HOVER] = e.hover;
    d[o + F.PX] = e.planeX;
    d[o + F.PY] = e.planeY;
    d[o + F.PZ] = e.planeZ;
    d[o + F.PD] = e.planeD;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.data[i * STRIDE + F.LIFE] = 0;
    this.geometry.instanceCount = 0;
    this.live = 0;
  }

  /** Move everything on by `dt`, then write what is visible for `camera` into the batch. */
  update(dt: number, camera: THREE.Camera, windX: number, windZ: number): void {
    const d = this.data;
    const order = this.order;
    order.length = 0;
    const m = camera.matrixWorldInverse;
    let waiting = 0;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * STRIDE;
      const life = d[o + F.LIFE];
      if (life <= 0) continue;
      const age = (d[o + F.AGE] += dt);
      if (age >= life) {
        d[o + F.LIFE] = 0;
        continue;
      }
      if (age < 0) {
        waiting++;
        continue;
      }
      const keep = Math.exp(-d[o + F.DRAG] * dt);
      d[o + F.VX] *= keep;
      d[o + F.VZ] *= keep;
      d[o + F.VY] = d[o + F.VY] * keep - d[o + F.GRAV] * dt;
      const w = d[o + F.WIND];
      d[o + F.X] += (d[o + F.VX] + windX * w) * dt;
      d[o + F.Y] += d[o + F.VY] * dt;
      d[o + F.Z] += (d[o + F.VZ] + windZ * w) * dt;
      d[o + F.ROT] += d[o + F.SPIN] * dt;
      // Sparks and embers bounce on the floor they fell toward, losing most of their speed.
      const bounce = d[o + F.BOUNCE];
      if (bounce >= 0 && d[o + F.Y] < d[o + F.FLOOR] && d[o + F.VY] < 0) {
        d[o + F.Y] = d[o + F.FLOOR];
        d[o + F.VY] *= -bounce;
        d[o + F.VX] *= 0.55;
        d[o + F.VZ] *= 0.55;
      }
      const hover = d[o + F.HOVER];
      if (hover > 0) {
        const t = age / life;
        const size = d[o + F.S0] + (d[o + F.S1] - d[o + F.S0]) * (1 - (1 - t) * (1 - t));
        const nx = d[o + F.PX];
        const ny = d[o + F.PY];
        const nz = d[o + F.PZ];
        const short = d[o + F.PD] + size * hover - (d[o + F.X] * nx + d[o + F.Y] * ny + d[o + F.Z] * nz);
        if (short > 0) {
          d[o + F.X] += nx * short;
          d[o + F.Y] += ny * short;
          d[o + F.Z] += nz * short;
        }
      }
      if (this.sorted) {
        view.set(d[o + F.X], d[o + F.Y], d[o + F.Z]).applyMatrix4(m);
        d[o + F.DEPTH] = view.z;
      }
      order.push(i);
    }
    // Most negative view z is furthest away: draw those first.
    if (this.sorted) order.sort((a, b) => d[a * STRIDE + F.DEPTH] - d[b * STRIDE + F.DEPTH]);

    const P = this.pos.array as Float32Array;
    const A = this.axis.array as Float32Array;
    const C = this.color.array as Float32Array;
    const T = this.tile.array as Float32Array;
    for (let n = 0; n < order.length; n++) {
      const o = order[n] * STRIDE;
      const t = d[o + F.AGE] / d[o + F.LIFE];
      const ease = 1 - (1 - t) * (1 - t);
      const fade = Math.min(1, t / d[o + F.FADE]) * (1 - t * t);
      P[n * 4] = d[o + F.X];
      P[n * 4 + 1] = d[o + F.Y];
      P[n * 4 + 2] = d[o + F.Z];
      P[n * 4 + 3] = d[o + F.S0] + (d[o + F.S1] - d[o + F.S0]) * ease;
      const st = d[o + F.STRETCH];
      A[n * 4] = d[o + F.VX] * st;
      A[n * 4 + 1] = d[o + F.VY] * st;
      A[n * 4 + 2] = d[o + F.VZ] * st;
      A[n * 4 + 3] = d[o + F.ROT];
      C[n * 4] = d[o + F.R0] + (d[o + F.R1] - d[o + F.R0]) * t;
      C[n * 4 + 1] = d[o + F.G0] + (d[o + F.G1] - d[o + F.G0]) * t;
      C[n * 4 + 2] = d[o + F.B0] + (d[o + F.B1] - d[o + F.B0]) * t;
      C[n * 4 + 3] = d[o + F.ALPHA] * fade;
      T[n] = d[o + F.TILE];
    }
    const count = order.length;
    this.geometry.instanceCount = count;
    this.live = count + waiting;
    if (count === 0) return;
    for (const a of [this.pos, this.axis, this.color, this.tile]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, count * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
