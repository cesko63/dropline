import * as THREE from 'three';

export const SKY = {
  top: new THREE.Color('#081526'),
  mid: new THREE.Color('#2a4f73'),
  horizon: new THREE.Color('#f2a66d'),
  fog: new THREE.Color('#8f8589'),
};

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.autoClear = false;
  return renderer;
}

export interface Environment {
  sun: THREE.DirectionalLight;
  /** Keeps the shadow area and sky centred on the player. */
  follow(x: number, y: number, z: number): void;
}

export function createEnvironment(scene: THREE.Scene): Environment {
  scene.fog = new THREE.FogExp2(SKY.fog, 0.0055);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(500, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: SKY.top },
        mid: { value: SKY.mid },
        horizon: { value: SKY.horizon },
        sunDir: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 mid;
        uniform vec3 horizon;
        uniform vec3 sunDir;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.2, 1.0);
          vec3 col = mix(horizon, mid, smoothstep(-0.02, 0.28, h));
          col = mix(col, top, smoothstep(0.2, 0.85, h));
          float s = max(dot(d, sunDir), 0.0);
          col += vec3(1.0, 0.72, 0.42) * (pow(s, 6.0) * 0.35 + pow(s, 400.0) * 3.0);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  scene.add(new THREE.HemisphereLight('#a9c8ee', '#5a4a40', 2.4));

  const sunOffset = new THREE.Vector3(70, 78, 60);
  const sun = new THREE.DirectionalLight('#ffd9b0', 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -55;
  cam.right = cam.top = 55;
  cam.near = 1;
  cam.far = 320;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  (sky.material as THREE.ShaderMaterial).uniforms.sunDir.value.copy(sunOffset).normalize();

  return {
    sun,
    follow(x, y, z) {
      // Snap to whole meters so shadow edges do not shimmer while moving.
      const sx = Math.round(x);
      const sz = Math.round(z);
      sun.target.position.set(sx, 0, sz);
      sun.position.set(sx + sunOffset.x, sunOffset.y, sz + sunOffset.z);
      sky.position.set(x, y, z);
    },
  };
}
