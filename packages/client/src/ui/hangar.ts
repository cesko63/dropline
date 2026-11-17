import { COMBAT, MECHS, MECH_IDS, PROJECTILES, WEAPONS, type MechDef } from '@dropline/shared';
import type { Sfx } from '../audio/sfx';
import type { Pad } from '../input/gamepad';
import type { Device } from '../input/input';
import { HangarStage, type MechPose, type PilotPose, type StageView } from '../render/hangarStage';
import type { LoadoutStore } from '../settings/loadout';

/**
 * The hangar inside the start panel: the player's suit and mech turning on a
 * stand, the side they fight for, and the mech frame they call. Picks apply and
 * save at once, like the settings. The 3D stage is only built the first time
 * the hangar opens, and only draws while it is open.
 */

interface SideInfo {
  name: string;
  short: string;
  tag: string;
  suit: string;
  /** Plate, undersuit or frame, lights: the suit's colours, shown next to their names. */
  colours: [string, string][];
}

/** Both sides play the same; they differ only in how they look and sound (see the README's lore). */
export const SIDES: SideInfo[] = [
  {
    name: 'United Earth Frontline Corps',
    short: COMBAT.teams[0].name,
    tag: 'Humans, there in person',
    suit: 'A patched, personal suit: grey-blue plates over an olive undersuit, a jet pack and steady blue lights.',
    colours: [
      ['#707a84', 'Grey-blue plate'],
      ['#525a37', 'Olive undersuit'],
      ['#5fe0ff', 'Blue lights'],
    ],
  },
  {
    name: 'Z.E.R.O',
    short: COMBAT.teams[1].name,
    tag: 'Machine pilots',
    suit: 'A black frame built to a pilot’s measure: open joints, an exposed spine, and crimson optics that breathe in the dark.',
    colours: [
      ['#1f2228', 'Matte black plate'],
      ['#4c525c', 'Steel frame'],
      ['#ff2236', 'Crimson optics'],
    ],
  },
];

type Tab = StageView;
const TABS: [Tab, string][] = [
  ['pilot', 'Pilot'],
  ['mech', 'Mech'],
];
const PILOT_POSES: [PilotPose, string][] = [
  ['idle', 'Idle'],
  ['aim', 'Aim'],
  ['run', 'Run'],
];
const MECH_POSES: [MechPose, string][] = [
  ['standby', 'Standby'],
  ['stand', 'Stand'],
  ['walk', 'Walk'],
];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function button(cls: string, text = ''): HTMLButtonElement {
  const b = h('button', cls, text);
  b.type = 'button';
  return b;
}

/** The numbers a pilot compares frames by, straight from the frame's data file. */
export function mechStats(def: MechDef): [string, string][] {
  const guns = def.loadout.map((w) => WEAPONS[w]?.name ?? w).join(', ');
  const salvo = PROJECTILES[def.salvo.projectile];
  return [
    ['Hull', `${def.health}`],
    ['Height', `${def.body.height} m`],
    ['Speed', `${def.move.walkSpeed} m/s walk · ${def.move.sprintSpeed} sprint`],
    ['Dash', `${def.dash.charges} charges · ${def.dash.rechargeTime} s each`],
    ['Arm', guns],
    ['Shoulder', `${def.salvo.count}-rocket salvo${salvo?.damage ? ` · ${salvo.damage} each` : ''} · ${def.salvo.cooldown} s`],
    ['Weak point', `Rear vent, ×${def.vent.mult} damage`],
  ];
}

export class Hangar {
  onClose: () => void = () => {};
  private tab: Tab = 'pilot';
  private pilotPose: PilotPose = 'idle';
  private mechPose: MechPose = 'stand';
  private stage: HangarStage | null = null;
  private readonly canvas = h('canvas', 'hg-canvas');
  private readonly hint = h('p', 'hg-hint');
  private readonly poses = h('div', 'hg-poses');
  private readonly side = h('div', 'hg-side');
  private readonly caption = h('p', 'hg-caption');
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private device: Device = 'kbm';

  constructor(
    private readonly root: HTMLElement,
    private readonly store: LoadoutStore,
    private readonly sfx: Sfx,
  ) {
    const head = h('div', 'set-head');
    head.append(h('h2', '', 'Hangar'));
    const tabs = h('div', 'set-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of TABS) {
      const b = button('set-tab', label);
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.show(id, true));
      this.tabButtons.set(id, b);
      tabs.append(b);
    }

    const view = h('div', 'hg-view');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Preview. Arrow keys turn it.');
    this.canvas.addEventListener('keydown', (e) => {
      const step = 0.2;
      if (e.code === 'ArrowLeft') this.stage?.nudge(-step, 0);
      else if (e.code === 'ArrowRight') this.stage?.nudge(step, 0);
      else if (e.code === 'ArrowUp') this.stage?.nudge(0, -step / 2);
      else if (e.code === 'ArrowDown') this.stage?.nudge(0, step / 2);
      else if (e.code === 'Home') this.stage?.resetView();
      else return;
      e.preventDefault();
    });
    const reset = button('hg-reset', 'Reset view');
    reset.addEventListener('click', () => {
      this.stage?.resetView();
      this.sfx.uiSelect();
    });
    view.append(this.canvas, this.caption, this.poses, reset, this.hint);

    const main = h('div', 'hg-main');
    main.append(view, this.side);

    const foot = h('div', 'set-foot');
    const back = button('small', 'Back');
    back.id = 'hangar-back';
    back.addEventListener('click', () => this.close());
    foot.append(back);
    root.append(head, tabs, main, foot);

    window.addEventListener(
      'keydown',
      (e) => {
        if (this.isOpen && e.code === 'Escape') {
          e.preventDefault();
          this.close();
        }
      },
      true,
    );
    store.listen(() => this.render());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    if (!this.stage) {
      this.stage = new HangarStage(this.canvas);
      this.stage.onLand = () => this.sfx.uiThud();
    }
    this.stage.setSide(this.store.value.side);
    this.stage.setMech(this.store.value.mech);
    this.stage.resetView();
    this.show(this.tab, false);
    this.tabButtons.get(this.tab)?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.sfx.uiBack();
    this.onClose();
  }

  /** LB / RB on a pad. */
  nextTab(dir: number): void {
    const i = TABS.findIndex(([id]) => id === this.tab);
    const next = TABS[(i + dir + TABS.length) % TABS.length][0];
    this.show(next, true);
    this.tabButtons.get(next)?.focus();
  }

  /** The device in use decides which controls the hint names. */
  setDevice(device: Device): void {
    if (device === this.device) return;
    this.device = device;
    this.renderHint();
  }

  /** Once a frame while the start screen is up. */
  update(pad: Pad, dt: number): void {
    if (!this.isOpen || !this.stage) return;
    this.stage.padLook(pad, dt);
    this.stage.update(dt);
  }

  // ---------------------------------------------------------------- drawing

  private show(tab: Tab, sound: boolean): void {
    this.tab = tab;
    for (const [id, b] of this.tabButtons) {
      b.classList.toggle('on', id === tab);
      b.setAttribute('aria-selected', String(id === tab));
    }
    this.stage?.setView(tab);
    if (sound) this.sfx.uiSelect();
    this.render();
  }

  private render(): void {
    const l = this.store.value;
    const side = SIDES[l.side];
    this.stage?.setSide(l.side);
    this.root.dataset.side = String(l.side);

    // Pose chips for what is on the stand.
    const poses: [string, string][] = this.tab === 'pilot' ? PILOT_POSES : MECH_POSES;
    const current = this.tab === 'pilot' ? this.pilotPose : this.mechPose;
    this.poses.replaceChildren(
      ...poses.map(([id, label]) => {
        const b = button('hg-chip', label);
        b.setAttribute('aria-pressed', String(id === current));
        b.addEventListener('click', () => {
          if (this.tab === 'pilot') {
            this.pilotPose = id as PilotPose;
            this.stage?.setPilotPose(this.pilotPose);
          } else {
            this.mechPose = id as MechPose;
            this.stage?.setMechPose(this.mechPose);
          }
          this.sfx.uiSelect();
          this.render();
          (this.poses.querySelector(`[data-pose="${id}"]`) as HTMLElement | null)?.focus();
        });
        b.dataset.pose = id;
        return b;
      }),
    );
    const mech = MECHS[l.mech];
    this.caption.textContent = this.tab === 'pilot' ? `${side.short} · PILOT SUIT` : `${side.short} · ${mech.name.toUpperCase()}`;
    this.renderHint();

    if (this.tab === 'pilot') this.renderPilot(l.side);
    else this.renderMech(l.mech, l.side);
  }

  private renderHint(): void {
    const pad = this.device === 'pad';
    this.hint.textContent = pad
      ? 'Right stick turns · LT / RT zoom · LB / RB switch tab · B back'
      : 'Drag to turn · wheel or pinch to zoom · double-click to reset';
  }

  private renderPilot(chosen: number): void {
    const group = h('div', 'hg-options');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Side');
    SIDES.forEach((s, i) => {
      const card = button('hg-card');
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(i === chosen));
      card.dataset.side = String(i);
      const top = h('span', 'hg-card-top');
      top.append(h('span', 'hg-card-name', s.short), h('span', 'hg-badge', i === chosen ? 'Selected' : ''));
      const swatches = h('span', 'hg-swatches');
      for (const [c, name] of s.colours) {
        const sw = h('i');
        sw.style.background = c;
        sw.title = name;
        swatches.append(sw);
      }
      card.append(top, h('span', 'hg-card-tag', s.tag), swatches);
      card.addEventListener('click', () => {
        if (i !== this.store.value.side) {
          this.store.set({ side: i });
          this.sfx.uiEquip();
        } else this.sfx.uiSelect();
        (this.side.querySelector(`[data-side="${i}"]`) as HTMLElement | null)?.focus();
      });
      group.append(card);
    });

    const s = SIDES[chosen];
    const about = h('div', 'hg-about');
    about.append(h('h3', '', s.name), h('p', '', s.suit));
    const list = h('ul', 'hg-colours');
    for (const [c, name] of s.colours) {
      const li = h('li');
      const sw = h('i');
      sw.style.background = c;
      li.append(sw, document.createTextNode(name));
      list.append(li);
    }
    about.append(list);
    const note = h(
      'p',
      'hg-note',
      'Both sides play the same. Offline you fight for this side; online the server seats you on it while the teams are even, and otherwise on the side that is short.',
    );
    this.side.replaceChildren(h('p', 'hg-label', 'Side'), group, about, note);
  }

  private renderMech(chosen: string, side: number): void {
    const group = h('div', 'hg-options');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Mech frame');
    for (const id of MECH_IDS) {
      const def = MECHS[id];
      const card = button('hg-card');
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(id === chosen));
      card.dataset.mech = id;
      const top = h('span', 'hg-card-top');
      top.append(h('span', 'hg-card-name', def.short), h('span', 'hg-badge', id === chosen ? 'Selected' : ''));
      card.append(top, h('span', 'hg-card-tag', `${def.health} hull · ${def.move.sprintSpeed} m/s · ${def.dash.charges} dashes`));
      card.addEventListener('click', () => {
        if (id !== this.store.value.mech) {
          this.store.set({ mech: id });
          this.stage?.setMech(id);
          this.sfx.uiEquip();
        } else {
          // Picking it again drops it in once more.
          this.stage?.setMech(id);
          this.sfx.uiSelect();
        }
        (this.side.querySelector(`[data-mech="${id}"]`) as HTMLElement | null)?.focus();
      });
      group.append(card);
    }

    const def = MECHS[chosen];
    const about = h('div', 'hg-about');
    about.append(h('h3', '', def.name));
    const dl = h('dl', 'hg-stats');
    for (const [k, v] of mechStats(def)) {
      const row = h('div');
      row.append(h('dt', '', k), h('dd', '', v));
      dl.append(row);
    }
    about.append(dl);
    const more =
      MECH_IDS.length > 1 ? '' : ' It is the only frame so far; new frames join this list as they are built.';
    const note = h('p', 'hg-note', `The paint follows your side (${SIDES[side].short}).${more}`);
    this.side.replaceChildren(h('p', 'hg-label', 'Frame'), group, about, note);
  }
}
