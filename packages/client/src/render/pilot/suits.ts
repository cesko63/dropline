import { KitBuilder, block, prism, rod, taper, type Kit } from './rig';

/**
 * The two pilot suits, built from parts on the shared skeleton (see rig.ts).
 * Both keep to the same outline (shoulders, helmet, limbs), so neither is
 * smaller or harder to see than the hitbox it stands for.
 *
 * Positions are in each bone's own space; `pair` places a part on the left
 * bone and its mirror image on the right one.
 */

const HALF_PI = Math.PI / 2;
const hexagon = (r: number): [number, number][] =>
  Array.from({ length: 6 }, (_, i) => [Math.cos((i * Math.PI) / 3 + Math.PI / 6) * r, Math.sin((i * Math.PI) / 3 + Math.PI / 6) * r]);

/**
 * United Earth Frontline Corps: a soldier in a suit. Grey-blue plates, chipped
 * and uneven, over an olive undersuit that shows at the waist and joints; a
 * jet pack on the back; blue lights.
 */
function corps(): Kit {
  const plate = '#707a84';
  const plate2 = '#5a636d';
  const under = '#525a37';
  const under2 = '#41482c';
  const dark = '#262a30';
  const rubber = '#1b1e22';
  const glow = '#5fe0ff';
  const k = new KitBuilder(0.07);

  // Pelvis and belt.
  k.add('hips', block(0.32, 0.18, 0.24), under, [0, -0.03, 0])
    .add('hips', block(0.4, 0.07, 0.29), dark, [0, 0.05, 0])
    .add('hips', block(0.08, 0.06, 0.02), plate2, [0, 0.05, -0.15])
    .sym('hips', block(0.07, 0.08, 0.06), under2, [0.15, 0.01, -0.13])
    .sym('hips', block(0.08, 0.09, 0.06), under2, [0.09, 0.01, 0.15])
    .add('hips', prism(taper(0.14, 0.07, 0.15), 0.04), plate, [0, -0.06, -0.13])
    .add('hips', block(0.28, 0.13, 0.04), plate, [0, -0.03, 0.13])
    .sym('hips', block(0.05, 0.17, 0.2), plate2, [0.2, -0.06, 0], { rot: [0, 0, 0.18] });

  // Belly: undersuit with two plates.
  k.add('spine', block(0.3, 0.24, 0.22), under, [0, 0.09, 0])
    .add('spine', block(0.22, 0.07, 0.05), plate, [0, 0.04, -0.11])
    .add('spine', block(0.24, 0.07, 0.05), plate, [0, 0.12, -0.115])
    .sym('spine', block(0.03, 0.16, 0.14), under2, [0.15, 0.09, 0]);

  // Chest: a heavy breastplate with the suit's core light, and the jet pack.
  k.add('chest', block(0.38, 0.3, 0.26), under, [0, 0.1, 0])
    .add('chest', prism(taper(0.46, 0.32, 0.28), 0.09), plate, [0, 0.13, -0.12])
    .add('chest', block(0.3, 0.04, 0.03), plate2, [0, 0.0, -0.15])
    .add('chest', prism(hexagon(0.06), 0.02), dark, [0, 0.13, -0.163])
    .add('chest', prism(hexagon(0.042), 0.02, 0.004), glow, [0, 0.13, -0.172], { glow: true })
    .add('chest', block(0.28, 0.06, 0.25), dark, [0, 0.27, 0])
    .add('chest', block(0.42, 0.3, 0.06), plate2, [0, 0.12, 0.13])
    .sym('chest', block(0.14, 0.06, 0.26), plate, [0.15, 0.27, 0])
    .add('chest', block(0.34, 0.36, 0.14), plate, [0, 0.08, 0.23])
    .add('chest', block(0.3, 0.06, 0.12), plate2, [0, 0.27, 0.22])
    .sym('chest', block(0.075, 0.075, 0.012, 0.004), glow, [0.075, 0.17, 0.305], { glow: true })
    .sym('chest', block(0.075, 0.095, 0.012, 0.004), glow, [0.075, -0.01, 0.305], { glow: true })
    .add('chest', block(0.05, 0.012, 0.012, 0.002), glow, [0, 0.11, 0.305], { glow: true })
    .add('chest', block(0.05, 0.012, 0.012, 0.002), glow, [0, 0.085, 0.305], { glow: true })
    .add('chest', block(0.05, 0.012, 0.012, 0.002), glow, [0, 0.06, 0.305], { glow: true })
    .sym('chest', rod(0.05, 0.09, 8, 0.035), dark, [0.1, -0.13, 0.23]);

  k.add('neck', rod(0.065, 0.14), under, [0, 0.03, 0]);

  // Helmet: rounded shell, a dark visor band with a blue slit, a jaw guard.
  k.add('head', block(0.25, 0.26, 0.28, 0.06), plate, [0, 0.08, 0.01])
    .add('head', block(0.07, 0.04, 0.22), plate2, [0, 0.215, 0.01])
    .add('head', prism(taper(0.22, 0.14, 0.11), 0.06), plate2, [0, 0.0, -0.115])
    .add('head', block(0.23, 0.065, 0.05), rubber, [0, 0.1, -0.12])
    .add('head', prism(taper(0.2, 0.17, 0.034), 0.012, 0.003), glow, [0, 0.1, -0.148], { glow: true })
    .sym('head', rod(0.055, 0.03, 10), plate2, [0.13, 0.07, 0.01], { rot: [0, 0, HALF_PI] })
    .add('head', block(0.2, 0.14, 0.04), plate2, [0, 0.06, 0.15]);

  // Arms: undersuit sleeves, a big pauldron, a bracer on the free arm.
  k.pair('upperArmL', rod(0.06, 0.3), under, [0, -0.15, 0])
    .pair('upperArmL', block(0.17, 0.13, 0.23, 0.035), plate, [-0.03, 0, 0], { rot: [0, 0, -0.3] })
    .pair('upperArmL', block(0.15, 0.05, 0.2), plate2, [-0.06, -0.08, 0], { rot: [0, 0, -0.35] })
    .pair('upperArmL', block(0.1, 0.14, 0.12), plate, [-0.01, -0.17, 0])
    .pair('foreArmL', rod(0.055, 0.12, 10), dark, [0, 0, 0], { rot: [0, 0, HALF_PI] })
    .add('foreArmL', block(0.12, 0.2, 0.13), plate, [0, -0.13, 0])
    .add('foreArmL', block(0.02, 0.08, 0.02), under2, [-0.06, -0.12, -0.04])
    .pair('handL', block(0.085, 0.1, 0.06), under, [0, -0.05, 0])
    .pair('handL', block(0.08, 0.07, 0.055), rubber, [0, -0.13, -0.005])
    .pair('handL', block(0.07, 0.05, 0.02), plate2, [0, -0.07, -0.035]);
  weaponArm(k, dark, plate, glow);

  // Legs: olive under thigh plates, big knee pads and shin guards; the calf
  // thrusters glow blue at the back.
  k.pair('thighL', rod(0.085, 0.4, 10, 0.095), under, [0, -0.2, 0])
    .pair('thighL', block(0.16, 0.27, 0.07), plate, [0, -0.2, -0.07])
    .pair('thighL', block(0.05, 0.24, 0.17), plate2, [-0.08, -0.2, 0])
    .pair('shinL', rod(0.06, 0.14, 10), under2, [0, 0, 0], { rot: [0, 0, HALF_PI] })
    .pair('shinL', block(0.14, 0.14, 0.07), plate, [0, 0, -0.08])
    .pair('shinL', block(0.15, 0.3, 0.17, 0.03), plate, [0, -0.21, -0.01])
    .pair('shinL', block(0.07, 0.1, 0.04), dark, [0, -0.15, 0.075])
    .pair('shinL', block(0.04, 0.06, 0.008, 0.002), glow, [0, -0.15, 0.098], { glow: true })
    .pair('shinL', block(0.008, 0.08, 0.03, 0.002), glow, [-0.079, -0.21, 0.045], { glow: true })
    .pair('footL', rod(0.05, 0.1), dark, [0, 0.02, 0], { rot: [0, 0, HALF_PI] })
    .pair('footL', block(0.13, 0.09, 0.25), plate2, [0, -0.015, -0.05])
    .pair('footL', block(0.12, 0.05, 0.07), plate, [0, 0.005, -0.14])
    .pair('footL', block(0.14, 0.03, 0.27, 0.008), rubber, [0, -0.05, -0.05]);

  pod(k, dark, plate, plate2, glow);

  return k.build({
    thrusters: [
      [-0.1, -0.2, 0.23],
      [0.1, -0.2, 0.23],
    ],
    halos: [
      { bone: 'head', at: [0, 0.1, -0.16], size: 0.22 },
      { bone: 'chest', at: [0, 0.13, -0.18], size: 0.16 },
      { bone: 'chest', at: [0, 0.08, 0.32], size: 0.3 },
    ],
    colors: { gun: dark, accent: plate, glow },
    roughness: 0.62,
    metalness: 0.35,
  });
}

/**
 * Z.E.R.O: an autonomous frame built to a pilot's measure. Matte black plates
 * on an open machine skeleton, an exposed spine, pistons in the calves, and
 * crimson optics and vents that stay bright in the dark. Its plates fill the
 * same outline as the Corps suit.
 */
function zero(): Kit {
  const plate = '#1f2228';
  const plate2 = '#2e323b';
  const frame = '#101114';
  const steel = '#4c525c';
  const glow = '#ff2236';
  const k = new KitBuilder(0.04);

  // Pelvis: a frame block under a V-shaped guard.
  k.add('hips', block(0.26, 0.12, 0.18), frame, [0, -0.02, 0])
    .sym('hips', rod(0.06, 0.06, 10), steel, [0.12, -0.04, 0], { rot: [0, 0, HALF_PI] })
    .add('hips', prism([[-0.15, 0.05], [0.15, 0.05], [0.05, -0.1], [-0.05, -0.1]], 0.05), plate, [0, -0.02, -0.11])
    .add('hips', block(0.03, 0.03, 0.01, 0.002), glow, [0, 0.0, -0.142], { glow: true })
    .add('hips', block(0.26, 0.1, 0.04), plate, [0, -0.01, 0.11])
    .sym('hips', block(0.04, 0.16, 0.18), plate2, [0.19, -0.06, 0], { rot: [0, 0, 0.2] });

  // Waist: open. A steel spine, cables and three thin plates, lit at the sides.
  k.add('spine', block(0.22, 0.2, 0.16), frame, [0, 0.1, 0])
    .add('spine', rod(0.045, 0.22, 8), steel, [0, 0.1, 0.06])
    .add('spine', block(0.24, 0.05, 0.05), plate, [0, 0.03, -0.1])
    .add('spine', block(0.25, 0.05, 0.05), plate, [0, 0.09, -0.105])
    .add('spine', block(0.26, 0.05, 0.05), plate, [0, 0.15, -0.11])
    .sym('spine', block(0.012, 0.16, 0.02, 0.003), glow, [0.125, 0.1, -0.075], { glow: true })
    .sym('spine', rod(0.015, 0.22, 6), steel, [0.1, 0.1, 0.07]);

  // Chest: angular plates over the frame, crimson vent slits, and on the back
  // the bare spine between two fins that glow from inside.
  const pecs: [number, number][] = [
    [-0.23, 0.14],
    [0.23, 0.14],
    [0.2, -0.02],
    [0.08, -0.13],
    [-0.08, -0.13],
    [-0.2, -0.02],
  ];
  const fin: [number, number][] = [
    [-0.07, 0.17],
    [0.06, 0.12],
    [0.07, -0.12],
    [0.0, -0.21],
    [-0.06, -0.1],
  ];
  const finGlow: [number, number][] = [
    [-0.035, 0.1],
    [0.035, 0.07],
    [0.035, -0.08],
    [0.0, -0.13],
  ];
  k.add('chest', block(0.34, 0.28, 0.24), frame, [0, 0.1, 0])
    .add('chest', prism(pecs, 0.09), plate, [0, 0.13, -0.115])
    .add('chest', block(0.05, 0.2, 0.04), plate2, [0, 0.11, -0.165])
    .sym('chest', block(0.085, 0.016, 0.012, 0.003), glow, [0.12, 0.2, -0.165], { glow: true, rot: [0, 0, 0.22] })
    .sym('chest', block(0.075, 0.014, 0.012, 0.003), glow, [0.115, 0.06, -0.16], { glow: true, rot: [0, 0, 0.3] })
    .sym('chest', block(0.06, 0.014, 0.012, 0.003), glow, [0.11, 0.025, -0.155], { glow: true, rot: [0, 0, 0.3] })
    .sym('chest', block(0.12, 0.06, 0.22), plate2, [0.11, 0.27, 0], { rot: [0, 0, 0.25] })
    .sym('chest', block(0.14, 0.06, 0.26), plate, [0.16, 0.25, 0])
    .add('chest', block(0.07, 0.12, 0.03, 0.006), glow, [0, 0.0, 0.135], { glow: true })
    .sym('chest', prism(fin, 0.06), plate, [0.13, 0.1, 0.17], { rot: [0.15, 0.25, 0] })
    .sym('chest', prism(finGlow, 0.012, 0.003), glow, [0.135, 0.1, 0.205], { glow: true, rot: [0.15, 0.25, 0] })
    .sym('chest', rod(0.04, 0.07, 8, 0.03), frame, [0.12, -0.1, 0.2]);
  for (let i = 0; i < 5; i++) k.add('chest', block(0.08, 0.035, 0.05, 0.008), steel, [0, 0.26 - i * 0.055, 0.135]);

  k.add('neck', rod(0.035, 0.16), steel, [0, 0.03, 0])
    .sym('neck', rod(0.012, 0.13, 5), frame, [0.04, 0.03, 0.02]);

  // Head: narrow and sharp, with slit eyes, a forehead slit and one at the back.
  k.add('head', block(0.2, 0.2, 0.25, 0.045), plate, [0, 0.1, 0.015])
    .add('head', prism(taper(0.2, 0.08, 0.16), 0.06), plate2, [0, 0.04, -0.105])
    .add('head', block(0.21, 0.035, 0.06), plate, [0, 0.135, -0.11])
    .sym('head', block(0.062, 0.02, 0.012, 0.004), glow, [0.045, 0.105, -0.142], { glow: true, rot: [0, 0, 0.28] })
    .add('head', block(0.05, 0.014, 0.012, 0.003), glow, [0, 0.18, -0.115], { glow: true })
    .add('head', block(0.04, 0.05, 0.2), plate2, [0, 0.215, 0.02])
    .sym('head', rod(0.05, 0.025, 10), steel, [0.11, 0.08, 0.02], { rot: [0, 0, HALF_PI] })
    .add('head', block(0.04, 0.012, 0.012, 0.003), glow, [0, 0.17, 0.143], { glow: true });

  // Arms: a steel bone with a piston, under the same pauldron and plates.
  k.pair('upperArmL', rod(0.04, 0.3), steel, [0, -0.15, 0])
    .pair('upperArmL', rod(0.018, 0.2, 6), frame, [0.03, -0.15, 0.04])
    .pair('upperArmL', block(0.17, 0.13, 0.23, 0.03), plate, [-0.03, 0, 0], { rot: [0, 0, -0.3] })
    .pair('upperArmL', block(0.08, 0.012, 0.01, 0.002), glow, [-0.07, -0.025, -0.117], { glow: true, rot: [0, 0, -0.3] })
    .pair('upperArmL', block(0.15, 0.05, 0.2), plate2, [-0.06, -0.08, 0], { rot: [0, 0, -0.35] })
    .pair('upperArmL', block(0.09, 0.14, 0.1), plate, [-0.015, -0.17, -0.01])
    .pair('foreArmL', rod(0.045, 0.1, 10), steel, [0, 0, 0], { rot: [0, 0, HALF_PI] })
    .add('foreArmL', block(0.1, 0.2, 0.11), plate, [0, -0.13, -0.01])
    .add('foreArmL', rod(0.015, 0.2, 6), steel, [0.03, -0.13, 0.05])
    .add('foreArmL', block(0.01, 0.12, 0.01, 0.002), glow, [-0.052, -0.13, -0.04], { glow: true })
    .pair('handL', block(0.07, 0.08, 0.045), plate2, [0, -0.04, 0])
    .pair('handL', block(0.015, 0.07, 0.02, 0.004), steel, [-0.04, -0.07, -0.03], { rot: [0, 0, -0.4] });
  for (const x of [-0.03, -0.01, 0.01, 0.03]) k.pair('handL', block(0.014, 0.09, 0.02, 0.004), steel, [x, -0.12, -0.005]);
  weaponArm(k, frame, plate2, glow);

  // Legs: steel bones and pistons behind black thigh and shin plates; claw feet.
  k.pair('thighL', rod(0.05, 0.4), steel, [0, -0.2, 0])
    .pair('thighL', block(0.16, 0.3, 0.08, 0.03), plate, [0, -0.2, -0.06])
    .pair('thighL', block(0.05, 0.24, 0.15), plate2, [-0.075, -0.2, 0])
    .pair('thighL', block(0.008, 0.12, 0.012, 0.002), glow, [-0.101, -0.22, -0.04], { glow: true })
    .pair('thighL', rod(0.018, 0.3, 6), frame, [0.05, -0.2, 0.05])
    .pair('shinL', rod(0.055, 0.13, 10), steel, [0, 0, 0], { rot: [0, 0, HALF_PI] })
    .pair('shinL', prism(taper(0.13, 0.08, 0.15), 0.07), plate, [0, 0, -0.08])
    .pair('shinL', block(0.14, 0.28, 0.12, 0.03), plate, [0, -0.21, -0.04])
    .pair('shinL', block(0.014, 0.15, 0.012, 0.003), glow, [0, -0.2, -0.104], { glow: true })
    .pair('shinL', rod(0.022, 0.32, 8), steel, [0, -0.2, 0.07])
    .pair('shinL', rod(0.035, 0.12, 8), frame, [0, -0.1, 0.07])
    .pair('footL', rod(0.045, 0.1), steel, [0, 0.02, 0], { rot: [0, 0, HALF_PI] })
    .pair('footL', block(0.12, 0.08, 0.22), plate, [0, -0.02, -0.04])
    .pair('footL', block(0.05, 0.05, 0.09), plate2, [-0.032, -0.035, -0.17])
    .pair('footL', block(0.05, 0.05, 0.09), plate2, [0.032, -0.035, -0.17])
    .pair('footL', block(0.04, 0.05, 0.06), steel, [0, -0.035, 0.08])
    .pair('footL', block(0.13, 0.025, 0.26, 0.008), frame, [0, -0.055, -0.05]);

  pod(k, plate, plate2, frame, glow);

  return k.build({
    thrusters: [
      [-0.12, -0.16, 0.2],
      [0.12, -0.16, 0.2],
    ],
    halos: [
      { bone: 'head', at: [0, 0.105, -0.16], size: 0.34 },
      { bone: 'chest', at: [0, 0.13, -0.18], size: 0.3 },
      { bone: 'chest', at: [0, 0.05, 0.2], size: 0.42 },
    ],
    colors: { gun: frame, accent: plate2, glow },
    roughness: 0.32,
    metalness: 0.62,
  });
}

/**
 * The weapon housing round the right forearm, the same on both suits but for its
 * finish: cooling fins along the top, and the barrel drum at the wrist with the
 * two barrels not in use showing as stubs (the one in use is the avatar's).
 */
function weaponArm(k: KitBuilder, gun: string, accent: string, glow: string): void {
  k.add('foreArmR', block(0.17, 0.24, 0.18, 0.025), gun, [0, -0.14, -0.02])
    .add('foreArmR', block(0.18, 0.04, 0.19), accent, [0, -0.03, -0.02])
    .add('foreArmR', block(0.012, 0.13, 0.01, 0.002), glow, [0.05, -0.15, -0.115], { glow: true })
    .add('foreArmR', block(0.016, 0.08, 0.012, 0.003), glow, [-0.087, -0.15, -0.02], { glow: true });
  for (const y of [-0.08, -0.12, -0.16, -0.2]) k.add('foreArmR', block(0.09, 0.012, 0.035, 0.003), accent, [0, y, -0.125]);
  // The drum's axis runs along the forearm, its top barrel on the barrel line (z -0.075).
  k.add('foreArmR', rod(0.07, 0.06, 10), gun, [0, -0.25, -0.03]);
  for (const a of [Math.PI / 2 + (Math.PI * 2) / 3, Math.PI / 2 + (Math.PI * 4) / 3])
    k.add('foreArmR', rod(0.02, 0.06, 8), accent, [Math.cos(a) * 0.045, -0.3, -0.03 - Math.sin(a) * 0.045]);
}

/** The launcher pod: four tubes in a block on a mount arm. It folds back over the shoulder. */
function pod(k: KitBuilder, body: string, top: string, mount: string, glow: string): void {
  k.add('pod', block(0.2, 0.17, 0.34, 0.025), body, [0, 0, 0])
    .add('pod', block(0.21, 0.04, 0.22), top, [0, 0.095, 0.02])
    .add('pod', block(0.07, 0.2, 0.07), mount, [0, -0.12, 0.08]);
  for (const x of [-0.048, 0.048])
    for (const y of [-0.042, 0.042]) k.add('pod', block(0.06, 0.055, 0.01, 0.003), glow, [x, y, -0.172], { glow: true });
}

const kits: Kit[] = [];

/** The suit a team wears: 0 the Corps, 1 Z.E.R.O. Built on first use and shared. */
export function suitKit(team: number): Kit {
  const t = team === 1 ? 1 : 0;
  return (kits[t] ??= t === 1 ? zero() : corps());
}
