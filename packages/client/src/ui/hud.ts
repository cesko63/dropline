import * as THREE from 'three';
import { COMBAT, TUNING, WEAPONS, lenH, spreadDeg, weaponOf, type Actor, type MatchState, type Vec3 } from '@dropline/shared';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const DEG = Math.PI / 180;
const HURT_WEDGES = 4;
const DAMAGE_NUMBERS = 8;
const FEED_LINES = 5;

interface HurtWedge {
  el: HTMLElement;
  /** World position of the shooter; the wedge keeps pointing at it as the view turns. */
  x: number;
  z: number;
  life: number;
}

interface DamageNumber {
  el: HTMLElement;
  victim: number;
  pos: THREE.Vector3;
  amount: number;
  life: number;
}

interface FeedLine {
  el: HTMLElement;
  life: number;
}

/** Writes text only when it changed, so the DOM is not touched every frame. */
class Text {
  private last = '';
  constructor(private readonly node: HTMLElement) {}
  set(value: string): void {
    if (value === this.last) return;
    this.node.textContent = this.last = value;
  }
}

const v = new THREE.Vector3();

export class Hud {
  /** Show every bot's state over its head (the `?qa=1` debug view). */
  debug = false;
  private readonly state = el('state');
  private readonly fps = el('fps');
  private readonly speed = new Text(el('speed-value'));
  private readonly fuel = el('fuel');
  private readonly slideFuel = el('slide-fuel');
  private readonly airJump = el('air-jump');
  private readonly viewMode = new Text(el('view-mode'));
  private readonly overlay = el('overlay');
  private readonly crosshair = el('crosshair');
  private readonly hitmark = el('hitmarker');
  private readonly scope = el('scope');
  private readonly vignette = el('vignette');
  private readonly vitals = el('vitals');
  private readonly health = el('health');
  private readonly healthValue = new Text(el('health-value'));
  private readonly weapon = el('weapon');
  private readonly weaponName = new Text(el('weapon-name'));
  private readonly ammo = new Text(el('ammo'));
  private readonly ammoMag = new Text(el('ammo-mag'));
  private readonly reload = el('reload');
  private readonly slots = el('slots');
  private readonly scoreAlly = new Text(el('score-ally'));
  private readonly scoreEnemy = new Text(el('score-enemy'));
  private readonly barAlly = el('bar-ally');
  private readonly barEnemy = el('bar-enemy');
  private readonly feedBox = el('feed');
  private readonly banner = el('banner');
  private readonly death = el('death');
  private readonly deathWait = new Text(el('death-wait'));
  private readonly end = el('end');
  private readonly labels = el('labels');
  private readonly wedges: HurtWedge[] = [];
  private readonly numbers: DamageNumber[] = [];
  private readonly tags: HTMLElement[] = [];
  private readonly tagText: Text[] = [];
  private readonly feed: FeedLine[] = [];
  private frames = 0;
  private fpsTime = 0;
  private lastState = '';
  private lastSlots = '';
  private lastGap = -1;
  private hurt = 0;
  private nextNumber = 0;

  constructor() {
    const wedgeBox = el('hurt-dirs');
    for (let i = 0; i < HURT_WEDGES; i++) {
      const node = document.createElement('i');
      wedgeBox.append(node);
      this.wedges.push({ el: node, x: 0, z: 0, life: 0 });
    }
    for (let i = 0; i < DAMAGE_NUMBERS; i++) {
      const node = document.createElement('span');
      node.className = 'dmg';
      node.style.opacity = '0';
      this.labels.append(node);
      this.numbers.push({ el: node, victim: -1, pos: new THREE.Vector3(), amount: 0, life: 0 });
    }
  }

  /** Clear everything that belongs to one match. */
  reset(m: MatchState, me: Actor): void {
    for (const line of this.feed) line.el.remove();
    this.feed.length = 0;
    for (const w of this.wedges) w.life = 0;
    for (const n of this.numbers) n.life = 0;
    for (const tag of this.tags) tag.remove();
    this.tags.length = this.tagText.length = 0;
    for (const a of m.actors) {
      const tag = document.createElement('span');
      tag.className = a.team === me.team ? 'tag' : 'tag enemy';
      tag.style.opacity = '0';
      this.labels.append(tag);
      this.tags.push(tag);
      this.tagText.push(new Text(tag));
    }
    this.hurt = 0;
    this.death.classList.remove('on');
    this.end.classList.remove('on');
    el('team-ally').textContent = COMBAT.teams[me.team].name;
    el('team-enemy').textContent = COMBAT.teams[1 - me.team].name;
    el('score-limit').textContent = String(m.scoreLimit);
  }

  update(dt: number, m: MatchState, me: Actor, thirdPerson: boolean, scoped: boolean, camera: THREE.PerspectiveCamera, viewYaw: number): void {
    const s = me.p;
    this.speed.set(lenH(s.vel).toFixed(1));

    let label = 'GROUND';
    let kind = 'ground';
    if (!me.alive) [label, kind] = ['DOWN', 'special'];
    else if (s.mantle.active) [label, kind] = ['MANTLE', 'special'];
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
    this.viewMode.set(thirdPerson ? 'THIRD PERSON · V' : 'FIRST PERSON · V');

    // Health and the red edge of the screen: steady when hurt badly, a pulse on each hit.
    const hp = Math.max(0, me.health) / COMBAT.health;
    this.health.style.transform = `scaleX(${hp.toFixed(3)})`;
    this.healthValue.set(String(Math.ceil(Math.max(0, me.health))));
    this.vitals.classList.toggle('low', hp < 0.35);
    this.hurt = Math.max(0, this.hurt - dt * 2.2);
    const low = me.alive ? Math.max(0, 0.55 - hp) * 1.1 : 0.5;
    this.vignette.style.opacity = Math.min(0.9, low + this.hurt).toFixed(3);

    // Weapon panel.
    const def = weaponOf(me);
    this.weaponName.set(def.name);
    this.ammo.set(String(me.ammo[me.weapon]));
    this.ammoMag.set(String(def.magSize));
    this.weapon.classList.toggle('empty', me.ammo[me.weapon] === 0);
    const progress = me.reload > 0 ? 1 - me.reload / def.reloadTime : 0;
    this.reload.style.transform = `scaleX(${progress.toFixed(3)})`;
    const slotKey = `${me.loadout.join()}:${me.weapon}`;
    if (slotKey !== this.lastSlots) {
      this.lastSlots = slotKey;
      this.slots.replaceChildren(
        ...me.loadout.map((id, i) => {
          const span = document.createElement('span');
          span.textContent = `${i + 1} ${WEAPONS[id].short}`;
          if (i === me.weapon) span.className = 'on';
          return span;
        }),
      );
    }

    // The crosshair opens with the real spread, and gives way to the sights when aimed.
    const gap = Math.round(4 + (Math.tan(spreadDeg(me) * DEG) / Math.tan((camera.fov / 2) * DEG)) * (window.innerHeight / 2));
    if (gap !== this.lastGap) {
      this.lastGap = gap;
      this.crosshair.style.setProperty('--gap', `${gap}px`);
    }
    this.crosshair.classList.toggle('aimed', me.ads > 0.6);
    this.crosshair.classList.toggle('off', !me.alive || thirdPerson || scoped);
    this.scope.classList.toggle('on', scoped);

    // Score.
    this.scoreAlly.set(String(m.score[me.team]));
    this.scoreEnemy.set(String(m.score[1 - me.team]));
    this.barAlly.style.transform = `scaleX(${Math.min(1, m.score[me.team] / m.scoreLimit).toFixed(3)})`;
    this.barEnemy.style.transform = `scaleX(${Math.min(1, m.score[1 - me.team] / m.scoreLimit).toFixed(3)})`;

    if (!me.alive && !m.over) this.deathWait.set(Math.max(0, me.respawnIn).toFixed(1));

    for (const w of this.wedges) {
      if (w.life <= 0) continue;
      w.life -= dt;
      // Angle of the shooter clockwise from straight ahead.
      const bearing = Math.atan2(w.x - s.pos.x, -(w.z - s.pos.z)) + viewYaw;
      w.el.style.transform = `rotate(${bearing.toFixed(3)}rad)`;
      w.el.style.opacity = Math.max(0, Math.min(1, w.life * 1.6)).toFixed(2);
    }

    for (let i = this.feed.length - 1; i >= 0; i--) {
      const line = this.feed[i];
      line.life -= dt;
      if (line.life <= 0) {
        line.el.remove();
        this.feed.splice(i, 1);
      } else if (line.life < 0.5) {
        line.el.style.opacity = (line.life * 2).toFixed(2);
      }
    }

    this.project(dt, m, me, camera);

    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps.textContent = `${Math.round(this.frames / this.fpsTime)} fps`;
      this.frames = 0;
      this.fpsTime = 0;
    }
  }

  /** Place the labels that are pinned to the world: names over pilots and damage numbers. */
  private project(dt: number, m: MatchState, me: Actor, camera: THREE.PerspectiveCamera): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const place = (node: HTMLElement, x: number, y: number, z: number, opacity: number): void => {
      v.set(x, y, z).project(camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) {
        node.style.opacity = '0';
        return;
      }
      node.style.opacity = opacity.toFixed(2);
      node.style.transform = `translate(${((v.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((0.5 - v.y * 0.5) * h).toFixed(1)}px) translate(-50%, -50%)`;
    };

    for (const a of m.actors) {
      const tag = this.tags[a.id];
      if (!tag) continue;
      const ally = a.team === me.team;
      if (a === me || !a.alive || (!ally && !this.debug)) {
        tag.style.opacity = '0';
        continue;
      }
      const b = a.brain;
      this.tagText[a.id].set(this.debug && b ? `${a.name} · ${b.role} · ${b.state}${b.token ? ' · T' : ''}` : a.name);
      const d = Math.hypot(a.p.pos.x - me.p.pos.x, a.p.pos.z - me.p.pos.z);
      place(tag, a.p.pos.x, a.p.pos.y + 2.5, a.p.pos.z, this.debug ? 1 : Math.max(0, Math.min(0.9, (70 - d) / 20)));
    }

    for (const n of this.numbers) {
      if (n.life <= 0) continue;
      n.life -= dt;
      if (n.life <= 0) {
        n.el.style.opacity = '0';
        continue;
      }
      n.pos.y += dt * 0.9;
      place(n.el, n.pos.x, n.pos.y, n.pos.z, Math.min(1, n.life * 2.5));
    }
  }

  /** The player's round landed. */
  hitmarker(head: boolean, kill: boolean): void {
    this.hitmark.className = `${head ? 'head' : ''} ${kill ? 'kill' : ''}`;
    const size = kill ? 1.5 : head ? 1.25 : 1;
    this.hitmark.animate(
      [
        { opacity: 1, transform: `scale(${size * 1.35})` },
        { opacity: 1, transform: `scale(${size})`, offset: 0.3 },
        { opacity: 0, transform: `scale(${size * 0.9})` },
      ],
      { duration: kill ? 420 : 200, easing: 'ease-out' },
    );
  }

  /** Damage dealt, floating up from where it landed. Pellets of one blast add up. */
  damageNumber(victim: number, pos: Vec3, amount: number, head: boolean): void {
    let n = this.numbers.find((x) => x.life > 0.45 && x.victim === victim);
    if (!n) {
      n = this.numbers[this.nextNumber++ % this.numbers.length];
      n.amount = 0;
      n.victim = victim;
      n.pos.set(pos.x, pos.y + 0.25, pos.z);
      n.el.className = 'dmg';
    }
    n.amount += amount;
    n.life = 0.7;
    if (head) n.el.className = 'dmg head';
    n.el.textContent = String(Math.round(n.amount));
  }

  /** The player was hit from this place. */
  damageFrom(x: number, z: number, amount: number): void {
    let w = this.wedges[0];
    for (const o of this.wedges) if (o.life < w.life) w = o;
    w.x = x;
    w.z = z;
    w.life = 1.2;
    this.hurt = Math.min(0.7, this.hurt + 0.15 + amount / 120);
  }

  addKill(killer: Actor | null, victim: Actor, how: string, me: Actor): void {
    const line = document.createElement('div');
    const name = (a: Actor): HTMLSpanElement => {
      const span = document.createElement('span');
      span.className = a.team === me.team ? 'ally' : 'enemy';
      span.textContent = a.name;
      return span;
    };
    const mid = document.createElement('span');
    mid.className = 'how';
    mid.textContent = how;
    if (killer) line.append(name(killer));
    line.append(mid, name(victim));
    if (killer === me || victim === me) line.className = 'mine';
    this.feedBox.append(line);
    line.animate([{ opacity: 0, transform: 'translateX(16px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'ease-out' });
    this.feed.push({ el: line, life: 5 });
    if (this.feed.length > FEED_LINES) this.feed.shift()!.el.remove();
  }

  /** A short line under the crosshair, for the player's own kills. */
  showBanner(text: string, name: string): void {
    this.banner.replaceChildren(text, Object.assign(document.createElement('b'), { textContent: name }));
    this.banner.animate(
      [
        { opacity: 0, transform: 'translateX(-50%) translateY(8px)' },
        { opacity: 1, transform: 'translateX(-50%)', offset: 0.12 },
        { opacity: 1, transform: 'translateX(-50%)', offset: 0.75 },
        { opacity: 0, transform: 'translateX(-50%) translateY(-6px)' },
      ],
      { duration: 1500, easing: 'ease-out' },
    );
  }

  showDeath(by: string): void {
    el('death-by').textContent = by;
    this.death.classList.add('on');
  }

  hideDeath(): void {
    this.death.classList.remove('on');
  }

  showEnd(won: boolean, m: MatchState, me: Actor): void {
    this.death.classList.remove('on');
    el('end-title').textContent = won ? 'VICTORY' : 'DEFEAT';
    el('end-score').textContent = `${COMBAT.teams[me.team].name} ${m.score[me.team]} · ${m.score[1 - me.team]} ${COMBAT.teams[1 - me.team].name}`;
    el('end-stats').textContent = `${me.kills} eliminations · ${me.deaths} deaths`;
    this.end.classList.toggle('lost', !won);
    this.end.classList.add('on');
  }

  setMuted(muted: boolean): void {
    el('muted').hidden = !muted;
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
