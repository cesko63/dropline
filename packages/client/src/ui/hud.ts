import * as THREE from 'three';
import { COMBAT, MECH, TUNING, WEAPONS, lenH, spreadDeg, weaponOf, type Actor, type MatchState, type NetStats, type Vec3 } from '@dropline/shared';
import type { Action } from '../input/bindings';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const DEG = Math.PI / 180;
const HURT_WEDGES = 4;
const DAMAGE_NUMBERS = 8;
const FEED_LINES = 5;
/** Damage numbers on a mech are kept apart from those on its pilot by this offset. */
const MECH_KEY = 100;
/** Seconds an enemy mech's hull stays shown after the player hurt it. */
const REVEAL_TIME = 4;

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
  /** The button or key the player presses for an action, on the device they are using. */
  keyOf: (a: Action, fallback?: boolean) => string = () => '';
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
  private readonly weaponState = new Text(el('weapon-state'));
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
  private readonly root = el('hud');
  private readonly vitalsLabel = new Text(el('vitals-label'));
  private readonly meterBox = el('mech');
  private readonly meter = el('meter');
  private readonly meterLabel = new Text(el('mech-label'));
  private readonly meterValue = new Text(el('mech-value'));
  private readonly dash = el('dash');
  private readonly dashPips = [el('dash-1'), el('dash-2')];
  private readonly salvo = el('salvo');
  private readonly salvoValue = new Text(el('salvo-value'));
  private readonly marker = el('mech-marker');
  private readonly markerText = new Text(el('mech-marker-text'));
  private readonly prompt = el('prompt');
  private readonly promptText = new Text(el('prompt'));
  private readonly warn = el('warn');
  private readonly net = el('net');
  private readonly netText = new Text(el('net-text'));
  private readonly netDebug = el('net-debug');
  private readonly link = el('link');
  private readonly linkText = new Text(el('link-text'));
  private readonly endHint = new Text(el('end-hint'));
  /** The end hint as given, with `{action}` names still in it (see `fill`). */
  private endHintRaw = '';
  private netDebugIn = 0;
  private wasLinked = true;
  private readonly mechTags: HTMLElement[] = [];
  private readonly mechTagText: Text[] = [];
  private reveal: number[] = [];
  private lastMeterKind = '';
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
    for (const tag of this.mechTags) tag.remove();
    this.mechTags.length = this.mechTagText.length = 0;
    for (const k of m.mechs) {
      const tag = document.createElement('span');
      tag.className = k.team === me.team ? 'tag mech' : 'tag mech enemy';
      tag.style.opacity = '0';
      this.labels.append(tag);
      this.mechTags.push(tag);
      this.mechTagText.push(new Text(tag));
    }
    this.reveal = m.mechs.map(() => 0);
    this.warn.classList.remove('on');
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
    const mech = m.mechs[me.id];
    const inMech = me.inMech;
    if (!me.alive) [label, kind] = ['DOWN', 'special'];
    else if (inMech && mech.state === 'boot') [label, kind] = ['START-UP', 'special'];
    else if (inMech && mech.dashTime > 0) [label, kind] = ['DASH', 'special'];
    else if (inMech) [label, kind] = [MECH.short, 'air'];
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
    this.viewMode.set(
      thirdPerson
        ? `THIRD PERSON · ${this.keyOf('toggleView')} · SHOULDER · ${this.keyOf('swapShoulder')}`
        : `FIRST PERSON · ${this.keyOf('toggleView')}`,
    );

    // Health (the mech's hull while in one) and the red edge of the screen: steady
    // when hurt badly, a pulse on each hit.
    this.root.classList.toggle('in-mech', inMech);
    const points = inMech ? mech.health : me.health;
    const hp = Math.max(0, points) / (inMech ? MECH.health : COMBAT.health);
    this.health.style.transform = `scaleX(${hp.toFixed(3)})`;
    this.healthValue.set(String(Math.ceil(Math.max(0, points))));
    this.vitalsLabel.set(inMech ? 'HULL' : 'HEALTH');
    this.vitals.classList.toggle('low', hp < (inMech ? 0.25 : 0.35));
    this.hurt = Math.max(0, this.hurt - dt * 2.2);
    const low = me.alive ? Math.max(0, (inMech ? 0.3 : 0.55) - hp) * (inMech ? 1.6 : 1.1) : 0.5;
    this.vignette.style.opacity = Math.min(0.9, low + this.hurt).toFixed(3);

    // Weapon panel.
    const def = weaponOf(me);
    this.weaponName.set(def.name);
    this.ammo.set(String(me.ammo[me.weapon]));
    this.ammoMag.set(String(def.magSize));
    const left = me.ammo[me.weapon];
    this.weapon.classList.toggle('empty', left === 0);
    // A pilot's arm makes its own rounds: the count is the shots its coolant cell
    // can still take, and the bar is the heat in it, which drains while it vents.
    // The shoulder pod and a mech's cannon are loaded, so their bar fills instead.
    const arm = def.mount === 'arm';
    const reloading = me.reload > 0;
    const heat = 1 - left / def.magSize;
    const fill = arm ? heat * (reloading ? me.reload / def.reloadTime : 1) : reloading ? 1 - me.reload / def.reloadTime : 0;
    this.reload.style.transform = `scaleX(${fill.toFixed(3)})`;
    this.weaponState.set(arm ? (reloading ? 'VENTING' : left === 0 ? 'OVERHEATED' : 'HEAT') : reloading ? 'LOADING' : 'READY');
    this.weapon.classList.toggle('venting', arm && reloading);
    this.weapon.classList.toggle('hot', arm && !reloading && heat >= 0.75);
    const slotKey = `${me.loadout.join()}:${me.weapon}`;
    if (slotKey !== this.lastSlots) {
      this.lastSlots = slotKey;
      this.slots.replaceChildren(
        ...me.loadout.map((id, i) => {
          const span = document.createElement('span');
          const key = this.keyOf(`weapon${i + 1}` as Action, false);
          span.textContent = key ? `${key} ${WEAPONS[id].short}` : WEAPONS[id].short;
          if (i === me.weapon) span.className = 'on';
          return span;
        }),
      );
    }

    this.updateMech(m, me);

    // The crosshair opens with the real spread. Aimed, the arm is raised under it
    // and the lines close in to the aimed spread; only the scope replaces them.
    this.crosshair.classList.toggle('mech', inMech);
    const gap = Math.round(4 + (Math.tan(spreadDeg(me) * DEG) / Math.tan((camera.fov / 2) * DEG)) * (window.innerHeight / 2));
    if (gap !== this.lastGap) {
      this.lastGap = gap;
      this.crosshair.style.setProperty('--gap', `${gap}px`);
    }
    this.crosshair.classList.toggle('aimed', me.ads > 0.6);
    // Over the shoulder the shots leave along the camera's line, so the same crosshair holds.
    this.crosshair.classList.toggle('off', !me.alive || scoped);
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

  /** The mech meter, the cockpit's dash and rocket readouts, and the prompts around them. */
  private updateMech(m: MatchState, me: Actor): void {
    const k = m.mechs[me.id];
    const R = COMBAT.mech;
    const dist = Math.hypot(k.pos.x - me.p.pos.x, k.pos.z - me.p.pos.z);

    let kind = 'charging';
    let fill = me.meter;
    if (k.state === 'dropping') {
      kind = 'inbound';
      fill = k.stateTime / R.drop.time;
      this.meterLabel.set('MECH INBOUND');
      this.meterValue.set(Math.max(0, R.drop.time - k.stateTime).toFixed(1));
    } else if (k.state === 'idle') {
      kind = 'waiting';
      fill = k.health / MECH.health;
      this.meterLabel.set(`${MECH.short} STANDING BY`);
      this.meterValue.set(`${Math.round(dist)} M`);
    } else if (me.meter >= 1) {
      kind = 'ready';
      this.meterLabel.set('MECH READY');
      this.meterValue.set(`PRESS ${this.keyOf('call')}`);
    } else {
      this.meterLabel.set('MECH');
      this.meterValue.set(`${Math.floor(me.meter * 100)}%`);
    }
    this.meter.style.transform = `scaleX(${Math.max(0, Math.min(1, fill)).toFixed(3)})`;
    if (kind !== this.lastMeterKind) this.meterBox.dataset.kind = this.lastMeterKind = kind;

    // Cockpit: dash charges and the rocket salvo.
    if (me.inMech) {
      const D = MECH.dash;
      this.dash.style.transform = `scaleX(${(k.dashCharges / D.charges).toFixed(3)})`;
      this.dashPips.forEach((pip, i) => pip.classList.toggle('on', k.dashCharges >= i + 1));
      const left = k.salvoCooldown;
      this.salvo.style.transform = `scaleX(${(1 - left / MECH.salvo.cooldown).toFixed(3)})`;
      this.salvo.classList.toggle('ready', left <= 0);
      this.salvoValue.set(left <= 0 ? 'READY' : left.toFixed(1));
    }

    // "E" when the pilot stands where they can climb in.
    const dy = me.p.pos.y - k.pos.y;
    const canBoard = k.state === 'idle' && me.alive && !me.inMech && dist <= R.embark.range && dy > -2 && dy < MECH.body.height + 1.5;
    this.promptText.set(canBoard ? `${this.keyOf('use')} · EMBARK` : '');
    this.prompt.classList.toggle('on', canBoard && !m.over);

    // Standing where an enemy mech is about to land.
    let danger = false;
    if (me.alive && !me.inMech) {
      for (const o of m.mechs) {
        if (o.team === me.team || o.state !== 'dropping') continue;
        if (Math.hypot(o.pos.x - me.p.pos.x, o.pos.z - me.p.pos.z) < R.drop.crushRadius + 1) danger = true;
      }
    }
    this.inDropZone = danger;
    this.warn.classList.toggle('on', danger && !m.over);
  }

  /** True while the player stands in an enemy mech's landing zone. */
  inDropZone = false;

  /** The player hurt this mech: show its hull for a while. */
  revealMech(id: number): void {
    this.reveal[id] = REVEAL_TIME;
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
      if (a === me || !a.alive || a.inMech || (!ally && !this.debug)) {
        tag.style.opacity = '0';
        continue;
      }
      const b = a.brain;
      this.tagText[a.id].set(this.debug && b ? `${a.name} · ${b.role} · ${b.state}${b.token ? ' · T' : ''}` : a.name);
      const d = Math.hypot(a.p.pos.x - me.p.pos.x, a.p.pos.z - me.p.pos.z);
      place(tag, a.p.pos.x, a.p.pos.y + 2.5, a.p.pos.z, this.debug ? 1 : Math.max(0, Math.min(0.9, (70 - d) / 20)));
    }

    // Mechs: allies always, enemies while the player is fighting them.
    for (const k of m.mechs) {
      const tag = this.mechTags[k.id];
      if (!tag) continue;
      this.reveal[k.id] = Math.max(0, this.reveal[k.id] - dt);
      const ally = k.team === me.team;
      const standing = k.state === 'idle' || k.state === 'boot' || k.state === 'piloted';
      if (!standing || k.id === me.id || (!ally && !this.debug && this.reveal[k.id] <= 0)) {
        tag.style.opacity = '0';
        continue;
      }
      const hull = Math.max(1, Math.round((k.health / MECH.health) * 100));
      const owner = m.actors[k.id];
      this.mechTagText[k.id].set(`${owner.name} · ${MECH.short} ${hull}%`);
      const d = Math.hypot(k.pos.x - me.p.pos.x, k.pos.z - me.p.pos.z);
      const fade = ally ? Math.max(0, Math.min(0.9, (90 - d) / 20)) : Math.min(1, this.reveal[k.id] * 2);
      // Staggered in height by slot, so the tags of mechs standing together do not sit on each other.
      place(tag, k.pos.x, k.pos.y + MECH.body.height + (k.state === 'idle' ? 0.4 : 1.4) + (k.id % 4) * 0.55, k.pos.z, this.debug ? 1 : fade);
    }

    // The player's own mech, while they are not in it: a marker that stays on
    // screen, sliding to the edge when the mech is out of view.
    const mine = m.mechs[me.id];
    if ((mine.state === 'dropping' || mine.state === 'idle') && !m.over) {
      v.set(mine.pos.x, mine.pos.y + MECH.body.height + 1.2, mine.pos.z).project(camera);
      const behind = v.z > 1;
      let sx = behind ? -v.x : v.x;
      let sy = behind ? -v.y : v.y;
      if (behind) {
        const l = Math.hypot(sx, sy) || 1;
        sx = (sx / l) * 2;
        sy = (sy / l) * 2;
      }
      const over = Math.max(Math.abs(sx) / 0.9, Math.abs(sy) / 0.78, 1);
      sx /= over;
      sy /= over;
      this.marker.classList.toggle('edge', over > 1);
      this.marker.classList.toggle('inbound', mine.state === 'dropping');
      const dist = Math.hypot(mine.pos.x - me.p.pos.x, mine.pos.z - me.p.pos.z);
      this.markerText.set(mine.state === 'dropping' ? Math.max(0, COMBAT.mech.drop.time - mine.stateTime).toFixed(1) : `${Math.round(dist)} M`);
      this.marker.style.opacity = '1';
      this.marker.style.transform = `translate(${((sx * 0.5 + 0.5) * w).toFixed(1)}px, ${((0.5 - sy * 0.5) * h).toFixed(1)}px) translate(-50%, -100%)`;
    } else {
      this.marker.style.opacity = '0';
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

  /** The player's round landed: on a pilot, or (`armor`) on a mech's hull. */
  hitmarker(head: boolean, kill: boolean, armor = false): void {
    this.hitmark.className = `${head ? 'head' : ''} ${kill ? 'kill' : ''} ${armor ? 'armor' : ''}`;
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

  /**
   * Damage dealt, floating up from where it landed. Pellets of one blast add up.
   * `armor` marks damage to a mech's hull (`victim` is then the mech's id).
   */
  damageNumber(victim: number, pos: Vec3, amount: number, head: boolean, armor = false): void {
    const key = armor ? victim + MECH_KEY : victim;
    let n = this.numbers.find((x) => x.life > 0.45 && x.victim === key);
    if (!n) {
      n = this.numbers[this.nextNumber++ % this.numbers.length];
      n.amount = 0;
      n.victim = key;
      n.pos.set(pos.x, pos.y + 0.25, pos.z);
      n.el.className = armor ? 'dmg armor' : 'dmg';
    }
    n.amount += amount;
    n.life = 0.7;
    if (head) n.el.className = armor ? 'dmg armor head' : 'dmg head';
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

  /** A line in the kill feed. `victimNote` follows the victim's name ("· HALBERD" for a mech). */
  addKill(killer: Actor | null, victim: Actor, how: string, me: Actor, victimNote = ''): void {
    const line = document.createElement('div');
    const name = (a: Actor, note = ''): HTMLSpanElement => {
      const span = document.createElement('span');
      span.className = a.team === me.team ? 'ally' : 'enemy';
      span.textContent = a.name + note;
      return span;
    };
    const mid = document.createElement('span');
    mid.className = 'how';
    mid.textContent = how;
    if (killer) line.append(name(killer));
    line.append(mid, name(victim, victimNote));
    if (killer === me || victim === me) line.className = 'mine';
    this.pushFeed(line);
  }

  /** News that is not a kill, in the same feed: a player joined or left. */
  addNote(name: string, what: string, ally: boolean): void {
    const line = document.createElement('div');
    line.className = 'note';
    const who = document.createElement('span');
    who.className = ally ? 'ally' : 'enemy';
    who.textContent = name;
    const tail = document.createElement('span');
    tail.className = 'how';
    tail.textContent = what;
    line.append(who, tail);
    this.pushFeed(line);
  }

  private pushFeed(line: HTMLElement): void {
    this.feedBox.append(line);
    line.animate([{ opacity: 0, transform: 'translateX(16px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'ease-out' });
    this.feed.push({ el: line, life: 5 });
    if (this.feed.length > FEED_LINES) this.feed.shift()!.el.remove();
  }

  /**
   * A short line under the crosshair: the player's own kills, and news about
   * their mech. `kind` colours the emphasised part: '' (red), 'good' or 'warn'.
   */
  showBanner(text: string, name: string, kind = ''): void {
    this.banner.className = kind;
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
    el('end-stats').textContent = `${me.kills} eliminations · ${me.mechKills} mechs destroyed · ${me.deaths} deaths`;
    this.warn.classList.remove('on');
    this.prompt.classList.remove('on');
    this.end.classList.toggle('lost', !won);
    this.end.classList.add('on');
  }

  /** The line under the result: how the next match starts. */
  /** The line under the end-of-match card; `{confirm}` and the like name keys. */
  setEndHint(text: string): void {
    this.endHintRaw = text;
    this.endHint.set(this.fill(text));
  }

  /** Show or hide everything that only means something on a server. */
  setOnline(online: boolean): void {
    this.net.hidden = !online;
    if (online) return;
    this.netDebug.hidden = true;
    this.link.classList.remove('on');
    this.wasLinked = true;
  }

  /** The connection details panel (N). */
  toggleNet(): void {
    if (this.net.hidden) return;
    this.netDebug.hidden = !this.netDebug.hidden;
    this.netDebugIn = 0;
  }

  showNetDebug(): void {
    this.netDebug.hidden = false;
  }

  /**
   * The ping readout, the notice while the line is down, and the details panel.
   * `status` is the connection's; `left` the seconds it will keep trying.
   */
  updateNet(dt: number, st: NetStats, status: string, left: number): void {
    const linked = status === 'online';
    const kind = !linked || st.ping > 180 ? 'bad' : st.ping > 90 ? 'slow' : 'good';
    if (this.net.dataset.kind !== kind) this.net.dataset.kind = kind;
    this.netText.set(linked ? `PING ${Math.round(st.ping)} MS` : 'NO LINK');
    if (linked !== this.wasLinked) {
      this.wasLinked = linked;
      this.link.classList.toggle('on', !linked);
    }
    if (!linked) this.linkText.set(`CONNECTION LOST · RECONNECTING ${Math.ceil(left)}`);

    if (this.netDebug.hidden) return;
    this.netDebugIn -= dt;
    if (this.netDebugIn > 0) return;
    this.netDebugIn = 0.25;
    this.netDebug.textContent = [
      `ping        ${st.ping.toFixed(0)} ms`,
      `jitter      ${st.jitter.toFixed(1)} ms`,
      `drawn late  ${st.delay.toFixed(0)} ms`,
      `snapshot    ${st.snapshotBytes.toFixed(0)} B  (max ${st.snapshotBytesMax})`,
      `unanswered  ${st.pending} commands, ${st.queued} waiting on server`,
      `corrections ${st.corrections}  last ${(st.lastCorrection * 100).toFixed(1)} cm  snaps ${st.snaps}`,
      `past newest ${st.extrapolated} frames`,
      `stale       ${st.staleEvents} events skipped`,
    ].join('\n');
  }

  setMuted(muted: boolean): void {
    el('muted').hidden = !muted;
  }

  /** Replace `{action}` in a hint with that action's key or button. */
  fill(text: string): string {
    return text.replace(/\{(\w+)\}/g, (_, a: string) => this.keyOf(a as Action));
  }

  /**
   * The keys changed (rebound, or the player picked up the pad or put it down):
   * every printed key in the HUD follows.
   */
  refreshKeys(): void {
    for (const node of document.querySelectorAll<HTMLElement>('[data-key]')) node.textContent = this.keyOf(node.dataset.key as Action);
    this.lastSlots = '';
    this.endHint.set(this.fill(this.endHintRaw));
  }

  /** The frame counter and the size of the HUD panels, from the settings. */
  setDisplay(showFps: boolean, scale: number): void {
    this.fps.hidden = !showFps;
    this.root.style.setProperty('--hud-scale', scale.toFixed(2));
  }

  showOverlay(show: boolean): void {
    this.overlay.classList.toggle('hidden', !show);
  }

  /** Tell the player why clicking did nothing. */
  showLockError(): void {
    el('lock-error').hidden = false;
  }
}
