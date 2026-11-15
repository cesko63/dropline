import * as THREE from 'three';
import { TICK_DT, createPlayerState, lerp, stepPlayer, v3, type CollisionWorld, type MapData, type PlayerState } from '@dropline/shared';
import { CameraRig } from './camera/cameraRig';
import { Input } from './input/input';
import { Avatar } from './render/avatar';
import { buildMapMeshes } from './render/mapMesh';
import { createEnvironment, createRenderer, type Environment } from './render/scene';
import { Viewmodel } from './render/viewmodel';
import { Hud } from './ui/hud';

/** Falling below this height puts the player back at the spawn. */
const KILL_Y = -30;
/** Longest frame the simulation will try to catch up on, seconds. */
const MAX_FRAME = 0.1;

export class Game {
  readonly input: Input;
  readonly rig = new CameraRig();
  state: PlayerState;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly env: Environment;
  private readonly avatar = new Avatar();
  private readonly viewmodel = new Viewmodel();
  private readonly hud = new Hud();
  private readonly prev = v3();
  private readonly renderPos = v3();
  private accumulator = 0;
  private lastTime = 0;
  private pendingEvents = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly world: CollisionWorld,
    private readonly map: MapData,
  ) {
    this.renderer = createRenderer(canvas);
    this.env = createEnvironment(this.scene);
    this.scene.add(buildMapMeshes(map, this.renderer), this.avatar.root);

    this.input = new Input(canvas);
    this.input.onLockChange = (locked) => this.hud.showOverlay(!locked);
    this.input.onLockError = () => this.hud.showLockError();
    this.hud.onStart(() => void this.input.lock());

    this.state = this.spawn();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private spawn(): PlayerState {
    const sp = this.map.spawns[0];
    const yaw = (sp.yawDeg * Math.PI) / 180;
    const state = createPlayerState(v3(sp.pos[0], sp.pos[1], sp.pos[2]), yaw);
    this.input.yaw = yaw;
    this.input.pitch = 0;
    this.prev.x = state.pos.x;
    this.prev.y = state.pos.y;
    this.prev.z = state.pos.z;
    return state;
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / h);
    this.viewmodel.resize(w / h);
  }

  start(): void {
    this.lastTime = performance.now();
    const loop = (now: number): void => {
      this.frame(Math.min(MAX_FRAME, (now - this.lastTime) / 1000));
      this.lastTime = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** Advance the simulation in fixed ticks, then draw one interpolated frame. */
  frame(dt: number): void {
    if (this.input.consume('toggleView')) this.rig.thirdPerson = !this.rig.thirdPerson;
    if (this.input.consume('respawn')) this.state = this.spawn();

    this.accumulator += dt;
    let cmd = this.input.sample();
    while (this.accumulator >= TICK_DT) {
      this.prev.x = this.state.pos.x;
      this.prev.y = this.state.pos.y;
      this.prev.z = this.state.pos.z;
      cmd = this.input.sample();
      stepPlayer(this.state, cmd, this.world, TICK_DT);
      this.pendingEvents |= this.state.events;
      this.accumulator -= TICK_DT;
      if (this.state.pos.y < KILL_Y) this.state = this.spawn();
    }

    const s = this.state;
    const alpha = this.accumulator / TICK_DT;
    const p = this.renderPos;
    p.x = lerp(this.prev.x, s.pos.x, alpha);
    p.y = lerp(this.prev.y, s.pos.y, alpha);
    p.z = lerp(this.prev.z, s.pos.z, alpha);

    // The view follows the mouse every frame rather than waiting for the next tick.
    s.yaw = this.input.yaw;
    s.pitch = this.input.pitch;

    this.rig.update(dt, s, p, cmd.moveX, this.pendingEvents, this.world);
    this.pendingEvents = 0;
    this.avatar.update(dt, s, p, this.rig.thirdPerson);
    const mouse = this.input.takeMouseDelta();
    this.viewmodel.update(dt, s, mouse.dx, mouse.dy);
    this.env.follow(p.x, p.y, p.z);
    this.hud.update(dt, s, this.rig.thirdPerson);

    this.renderer.clear();
    this.renderer.render(this.scene, this.rig.camera);
    if (!this.rig.thirdPerson) {
      this.renderer.clearDepth();
      this.renderer.render(this.viewmodel.scene, this.viewmodel.camera);
    }
  }
}
