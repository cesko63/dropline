import { TUNING, lenH, type PlayerState } from '@dropline/shared';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class Hud {
  private readonly state = el('state');
  private readonly fps = el('fps');
  private readonly speed = el('speed-value');
  private readonly fuel = el('fuel');
  private readonly slideFuel = el('slide-fuel');
  private readonly airJump = el('air-jump');
  private readonly viewMode = el('view-mode');
  private readonly overlay = el('overlay');
  private frames = 0;
  private fpsTime = 0;
  private lastSpeed = '';
  private lastState = '';

  update(dt: number, s: PlayerState, thirdPerson: boolean): void {
    const speed = lenH(s.vel).toFixed(1);
    if (speed !== this.lastSpeed) this.speed.textContent = this.lastSpeed = speed;

    let label = 'GROUND';
    let kind = 'ground';
    if (s.mantle.active) [label, kind] = ['MANTLE', 'special'];
    else if (s.wallrun.active) [label, kind] = ['WALLRUN', 'special'];
    else if (s.sliding) [label, kind] = ['SLIDE', 'special'];
    else if (s.thrusting) [label, kind] = ['THRUST', 'special'];
    else if (!s.grounded) [label, kind] = ['AIR', 'air'];
    else if (s.crouched) label = 'CROUCH';
    if (label !== this.lastState) {
      this.state.textContent = this.lastState = label;
      this.state.dataset.kind = kind;
    }

    this.fuel.style.transform = `scaleX(${s.fuel.toFixed(3)})`;
    this.fuel.classList.toggle('burning', s.thrusting);
    this.slideFuel.style.transform = `scaleX(${s.slideFuel.toFixed(3)})`;
    this.slideFuel.classList.toggle('burning', s.sliding);
    this.airJump.classList.toggle('on', s.airJumpsUsed < TUNING.jump.airJumps);
    this.viewMode.textContent = thirdPerson ? 'THIRD PERSON · V' : 'FIRST PERSON · V';

    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps.textContent = `${Math.round(this.frames / this.fpsTime)} fps`;
      this.frames = 0;
      this.fpsTime = 0;
    }
  }

  showOverlay(show: boolean): void {
    this.overlay.classList.toggle('hidden', !show);
  }

  /** Tell the player why clicking did nothing. */
  showLockError(): void {
    el('lock-error').hidden = false;
  }

  onStart(handler: () => void): void {
    this.overlay.addEventListener('click', handler);
  }
}
