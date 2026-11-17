import * as THREE from 'three';
import { GUN_FINISH } from '../armGun';
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
 * and uneven and cut to hard angles, over an olive undersuit that shows at the
 * waist and joints; a heavy brow over a slanted visor; a twin-thruster jet pack
 * on the back; blue lights.
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

  // Chest: a breastplate that comes to a point over the belly, the suit's core
  // light, and collar plates raised either side of the neck.
  const breast: [number, number][] = [
    [-0.23, 0.14],
    [0.23, 0.14],
    [0.21, -0.03],
    [0.06, -0.13],
    [-0.06, -0.13],
    [-0.21, -0.03],
  ];
  k.add('chest', block(0.38, 0.3, 0.26), under, [0, 0.1, 0])
    .add('chest', prism(breast, 0.09), plate, [0, 0.13, -0.12])
    .sym('chest', block(0.13, 0.03, 0.03), plate2, [0.09, 0.03, -0.16], { rot: [0, 0, 0.42] })
    .add('chest', prism(hexagon(0.06), 0.02), dark, [0, 0.13, -0.163])
    .add('chest', prism(hexagon(0.042), 0.02, 0.004), glow, [0, 0.13, -0.172], { glow: true })
    .add('chest', block(0.28, 0.06, 0.25), dark, [0, 0.27, 0])
    .add('chest', block(0.42, 0.3, 0.06), plate2, [0, 0.12, 0.13])
    .sym('chest', block(0.14, 0.06, 0.26), plate, [0.15, 0.27, 0])
    .sym('chest', block(0.06, 0.1, 0.2), plate2, [0.165, 0.32, 0.01], { rot: [0, 0, -0.3] });
  jetPack(k, plate, plate2, dark, glow);

  k.add('neck', rod(0.065, 0.14), under, [0, 0.03, 0]);

  // Helmet: a shell under a heavy brow that shades the visor, two eye slits
  // slanted down to a V, a pointed jaw guard with breather slots, a raised crest.
  const jaw: [number, number][] = [
    [-0.11, 0.055],
    [0.11, 0.055],
    [0.095, -0.02],
    [0.0, -0.08],
    [-0.095, -0.02],
  ];
  const crest: [number, number][] = [
    [0.13, -0.02],
    [-0.13, -0.02],
    [-0.15, 0.03],
    [0.06, 0.035],
  ];
  const earFin: [number, number][] = [
    [0.04, 0.03],
    [-0.06, 0.02],
    [-0.14, 0.07],
    [-0.08, -0.03],
    [0.04, -0.03],
  ];
  k.add('head', block(0.25, 0.26, 0.28, 0.05), plate, [0, 0.08, 0.01])
    .add('head', prism(crest, 0.06, 0.012), plate2, [0, 0.215, 0.01], { rot: [0, HALF_PI, 0] })
    .add('head', prism(jaw, 0.07), plate2, [0, 0.01, -0.115])
    .sym('head', block(0.035, 0.012, 0.01, 0.002), dark, [0.045, -0.005, -0.152], { rot: [0, 0, 0.5] })
    .add('head', block(0.24, 0.06, 0.05), rubber, [0, 0.1, -0.12])
    .sym('head', block(0.095, 0.022, 0.012, 0.004), glow, [0.052, 0.098, -0.148], { glow: true, rot: [0, 0, 0.22] })
    .add('head', block(0.28, 0.045, 0.11), plate2, [0, 0.148, -0.105], { rot: [-0.32, 0, 0] })
    .sym('head', prism(earFin, 0.02, 0.005), plate2, [0.132, 0.09, 0.02], { rot: [0, HALF_PI, 0] })
    .add('head', block(0.2, 0.14, 0.04), plate2, [0, 0.06, 0.15]);

  // Arms: undersuit sleeves, a big pauldron, a bracer on the free arm.
  k.pair('upperArmL', rod(0.06, 0.3), under, [0, -0.15, 0])
    .pair('upperArmL', block(0.17, 0.13, 0.23, 0.035), plate, [-0.03, 0, 0], { rot: [0, 0, -0.3] })
    .pair('upperArmL', block(0.026, 0.07, 0.21, 0.008), plate2, [-0.07, 0.085, 0], { rot: [0, 0, -0.3] })
    .pair('upperArmL', block(0.15, 0.05, 0.2), plate2, [-0.06, -0.08, 0], { rot: [0, 0, -0.35] })
    .pair('upperArmL', block(0.1, 0.14, 0.12), plate, [-0.01, -0.17, 0])
    .pair('foreArmL', rod(0.055, 0.12, 10), dark, [0, 0, 0], { rot: [0, 0, HALF_PI] })
    .add('foreArmL', block(0.12, 0.2, 0.13), plate, [0, -0.13, 0])
    .add('foreArmL', block(0.02, 0.08, 0.02), under2, [-0.06, -0.12, -0.04])
    .pair('handL', block(0.085, 0.1, 0.06), under, [0, -0.05, 0])
    .pair('handL', block(0.08, 0.07, 0.055), rubber, [0, -0.13, -0.005])
    .pair('handL', block(0.07, 0.05, 0.02), plate2, [0, -0.07, -0.035]);
  weaponArm(k, 0);

  // Legs: olive under thigh plates, big knee pads and shin guards; the calf
  // thrusters glow blue at the back.
  k.pair('thighL', rod(0.085, 0.4, 10, 0.095), under, [0, -0.2, 0])
    .pair('thighL', block(0.16, 0.27, 0.07), plate, [0, -0.2, -0.07])
    .pair('thighL', block(0.05, 0.24, 0.17), plate2, [-0.08, -0.2, 0])
    .pair('shinL', rod(0.06, 0.14, 10), under2, [0, 0, 0], { rot: [0, 0, HALF_PI] })
    .pair('shinL', prism([[-0.07, 0.07], [0.07, 0.07], [0.075, -0.02], [0, -0.1], [-0.075, -0.02]], 0.08), plate, [0, 0, -0.085])
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
    thrusters: NOZZLES,
    halos: [
      { bone: 'head', at: [0, 0.1, -0.16], size: 0.22 },
      { bone: 'chest', at: [0, 0.13, -0.18], size: 0.16 },
      { bone: 'chest', at: packAt([0, 0.085, 0.31]), size: 0.18 },
      ...NOZZLES.map(([x, y, z]) => ({ bone: 'chest' as const, at: [x, y + 0.012, z] as V3, size: 0.13 })),
    ],
    colors: { gun: dark, accent: plate, glow },
    roughness: 0.62,
    metalness: 0.35,
  });
}

/** Centre of a Z.E.R.O thruster pod on the back, under the right fin, in chest space. */
const NOZZLE_POD: V3 = [0.125, -0.05, 0.2];

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
    .sym('hips', block(0.04, 0.16, 0.18), plate2, [0.19, -0.06, 0], { rot: [0, 0, 0.2] })
    // The waist above it: a frame core up into the spine, a belt round it with
    // a steel clasp, and plates front and back, so there is no gap to see through.
    .add('hips', block(0.22, 0.12, 0.15, 0.02), frame, [0, 0.08, 0])
    .add('hips', block(0.29, 0.045, 0.19, 0.01), plate2, [0, 0.07, 0])
    .add('hips', block(0.05, 0.035, 0.012, 0.004), steel, [0, 0.07, -0.1])
    .sym('hips', block(0.09, 0.05, 0.04, 0.008), plate, [0.075, 0.075, -0.095], { rot: [0, 0.2, 0] })
    .add('hips', block(0.22, 0.05, 0.04, 0.008), plate, [0, 0.075, 0.095]);

  // Waist: open. A steel spine, cables and three thin plates, lit at the sides.
  k.add('spine', block(0.22, 0.2, 0.16), frame, [0, 0.1, 0])
    .add('spine', rod(0.045, 0.22, 8), steel, [0, 0.1, 0.06])
    .add('spine', block(0.22, 0.05, 0.05), plate, [0, -0.025, -0.095])
    .add('spine', block(0.24, 0.05, 0.05), plate, [0, 0.03, -0.1])
    .add('spine', block(0.25, 0.05, 0.05), plate, [0, 0.09, -0.105])
    .add('spine', block(0.26, 0.05, 0.05), plate, [0, 0.15, -0.11])
    .sym('spine', block(0.012, 0.16, 0.02, 0.003), glow, [0.125, 0.1, -0.075], { glow: true })
    .sym('spine', rod(0.015, 0.22, 6), steel, [0.1, 0.1, 0.07]);
  // Behind, segmented plates either side of the exposed spine, so the waist is not hollow.
  for (const y of [0.04, 0.1, 0.16]) k.sym('spine', block(0.07, 0.05, 0.04, 0.008), plate, [0.075, y, 0.09], { rot: [0, -0.2, 0] });

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
    .sym('chest', prism(fin, 0.06), plate, [0.13, 0.1, 0.17], { rot: [0.15, 0.25, 0] })
    .sym('chest', prism(finGlow, 0.012, 0.003), glow, [0.135, 0.1, 0.205], { glow: true, rot: [0.15, 0.25, 0] })
    .add('chest', block(0.3, 0.06, 0.05, 0.01), frame, [0, -0.04, 0.15]);
  // Low on the back between the fins: an armoured reactor housing with a lit
  // slit, and a thruster pod under each fin where the jets leave, braced to it.
  const housing: [number, number][] = [
    [-0.1, 0.07],
    [0.1, 0.07],
    [0.085, -0.09],
    [0.035, -0.14],
    [-0.035, -0.14],
    [-0.085, -0.09],
  ];
  k.add('chest', prism(housing, 0.07), plate2, [0, 0.0, 0.17])
    .add('chest', block(0.016, 0.13, 0.012, 0.003), glow, [0, -0.015, 0.208], { glow: true })
    .sym('chest', block(0.05, 0.012, 0.012, 0.003), steel, [0.045, 0.04, 0.208], { rot: [0, 0, -0.35] })
    .sym('chest', block(0.04, 0.012, 0.012, 0.003), steel, [0.04, -0.06, 0.208], { rot: [0, 0, 0.5] })
    .sym('chest', prism(taper(0.06, 0.09, 0.15), 0.08), plate, NOZZLE_POD, { rot: [0.12, 0, 0] })
    .sym('chest', block(0.008, 0.08, 0.01, 0.002), glow, [NOZZLE_POD[0] + 0.035, NOZZLE_POD[1], NOZZLE_POD[2] + 0.02], { glow: true })
    .sym('chest', rod(0.032, 0.05, 8, 0.046), frame, [NOZZLE_POD[0], NOZZLE_POD[1] - 0.1, NOZZLE_POD[2] + 0.01])
    .sym('chest', rod(0.03, 0.006, 8), glow, [NOZZLE_POD[0], NOZZLE_POD[1] - 0.124, NOZZLE_POD[2] + 0.01], { glow: true })
    .sym('chest', rod(0.012, 0.08, 6), frame, [0.075, -0.05, 0.185], { rot: [0, 0, HALF_PI] });
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
  weaponArm(k, 1);

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
      [-NOZZLE_POD[0], NOZZLE_POD[1] - 0.127, NOZZLE_POD[2] + 0.01],
      [NOZZLE_POD[0], NOZZLE_POD[1] - 0.127, NOZZLE_POD[2] + 0.01],
    ],
    halos: [
      { bone: 'head', at: [0, 0.105, -0.16], size: 0.34 },
      { bone: 'chest', at: [0, 0.13, -0.18], size: 0.3 },
      { bone: 'chest', at: [0, -0.015, 0.22], size: 0.32 },
    ],
    colors: { gun: frame, accent: plate2, glow },
    roughness: 0.32,
    metalness: 0.62,
  });
}

type V3 = [number, number, number];

/**
 * The Corps jet pack is drawn full size below and then shrunk by PACK_SCALE
 * towards PACK_ROOT, the middle of where it meets the back plate, so it stays
 * mounted flush however small it is.
 */
const PACK_SCALE = 0.78;
const PACK_ROOT: V3 = [0, 0.1, 0.155];
/** Where a point of the full-size pack ends up on the suit. */
const packAt = ([x, y, z]: V3): V3 => [
  PACK_ROOT[0] + (x - PACK_ROOT[0]) * PACK_SCALE,
  PACK_ROOT[1] + (y - PACK_ROOT[1]) * PACK_SCALE,
  PACK_ROOT[2] + (z - PACK_ROOT[2]) * PACK_SCALE,
];
/** A part of the pack at the pack's scale. */
const packPart = (geo: THREE.BufferGeometry): THREE.BufferGeometry => geo.scale(PACK_SCALE, PACK_SCALE, PACK_SCALE);

/** Splay of the Corps jet pack's thrusters, radians outward at the bottom. */
const SPLAY = 0.12;
/** Centre of the right thruster on the full-size pack. */
const NACELLE: V3 = [0.14, 0.03, 0.3];
/** A point `d` metres down the right thruster's axis from its centre. */
const alongNacelle = (d: number): V3 => [NACELLE[0] + Math.sin(SPLAY) * d, NACELLE[1] - Math.cos(SPLAY) * d, NACELLE[2]];
/** The nozzle mouths, where the jet flames leave the pack: left, right. */
const NOZZLES: V3[] = (() => {
  const [x, y, z] = packAt(alongNacelle(0.255));
  return [
    [-x, y, z],
    [x, y, z],
  ];
})();

/**
 * The Corps jet pack: a wedge-shaped core that narrows to the waist, two
 * armoured thrusters splayed out under it with lit nozzles, and a chevron of
 * light on the back.
 */
function jetPack(k: KitBuilder, plate: string, plate2: string, dark: string, glow: string): void {
  const rot: V3 = [0, 0, SPLAY];
  const add = (geo: THREE.BufferGeometry, color: string, at: V3, opts: { rot?: V3; glow?: boolean } = {}) =>
    k.add('chest', packPart(geo), color, packAt(at), opts);
  const sym = (geo: THREE.BufferGeometry, color: string, at: V3, opts: { rot?: V3; glow?: boolean } = {}) =>
    k.sym('chest', packPart(geo), color, packAt(at), opts);

  // Core: a wedge, an armoured cowl over the top, a recessed panel with the chevron.
  add(prism(taper(0.32, 0.15, 0.4), 0.13), plate2, [0, 0.09, 0.22]);
  add(prism(taper(0.36, 0.26, 0.1), 0.17), plate, [0, 0.26, 0.24], { rot: [0.22, 0, 0] });
  add(prism(taper(0.2, 0.06, 0.24), 0.02), dark, [0, 0.07, 0.29]);
  sym(block(0.11, 0.016, 0.012, 0.004), glow, [0.045, 0.12, 0.3], { glow: true, rot: [0, 0, 0.55] });
  sym(block(0.08, 0.014, 0.012, 0.004), glow, [0.032, 0.05, 0.3], { glow: true, rot: [0, 0, 0.55] });
  add(block(0.3, 0.05, 0.1), dark, [0, 0.17, 0.27]);
  add(block(0.24, 0.04, 0.08), dark, [0, -0.06, 0.27]);

  // Thrusters: an octagonal can tapering up, two armour bands, a nozzle bell
  // with a lit throat, an intake slit on the outside.
  const slit = alongNacelle(0);
  sym(rod(0.065, 0.34, 8, 0.048), plate, NACELLE, { rot });
  sym(block(0.15, 0.035, 0.15), plate2, alongNacelle(-0.1), { rot });
  sym(block(0.155, 0.03, 0.155), plate2, alongNacelle(0.11), { rot });
  sym(rod(0.078, 0.08, 8, 0.058), dark, alongNacelle(0.21), { rot });
  sym(rod(0.056, 0.01, 8), glow, alongNacelle(0.248), { glow: true, rot });
  sym(block(0.01, 0.1, 0.025, 0.003), glow, [slit[0] + 0.066, slit[1], slit[2]], { glow: true, rot });
}

/** Copper of the printer's feed coils, the same on both suits. */
const COIL = '#8a6236';

/**
 * The weapon housing round the right forearm (it hangs down -Y; its top, the
 * barrel side, faces -Z), in the team's gun finish (GUN_FINISH) and built like
 * the first-person arm: a heavy block with armour on its outer side, the ammo
 * printer behind a window on its inner side with its feed coils, a cooling
 * chamber of fins over a heat sink on top, the coolant cell behind it, the
 * hinge plate at the front and recoil pistons underneath. No lights. The
 * barrel itself is the avatar's (render/armGun), on its breech at the front.
 */
function weaponArm(k: KitBuilder, team: 0 | 1): void {
  const { gun, plate, dark, steel } = GUN_FINISH[team];
  k.add('foreArmR', block(0.16, 0.24, 0.15, 0.022), gun, [0, -0.14, -0.005])
    .add('foreArmR', block(0.02, 0.2, 0.12, 0.006), plate, [0.086, -0.14, 0.0])
    .add('foreArmR', block(0.016, 0.008, 0.1, 0.002), steel, [0.097, -0.07, -0.01]);
  for (const y of [-0.08, -0.2]) k.add('foreArmR', rod(0.006, 0.006, 6), steel, [0.097, y, 0.04], { rot: [0, 0, Math.PI / 2] });
  // The printer window: a frame and three feed coils across it.
  k.add('foreArmR', block(0.02, 0.18, 0.11, 0.005), dark, [-0.081, -0.15, 0.0]);
  for (const y of [-0.1, -0.15, -0.2]) k.add('foreArmR', block(0.014, 0.014, 0.08, 0.003), COIL, [-0.091, y, 0.0]);
  // Cooling chamber on top: four fins over a heat sink, in a cage.
  k.add('foreArmR', block(0.12, 0.17, 0.012, 0.003), dark, [0, -0.15, -0.086])
    .sym('foreArmR', block(0.012, 0.18, 0.04, 0.003), gun, [0.062, -0.15, -0.1]);
  for (const y of [-0.085, -0.125, -0.165, -0.205]) k.add('foreArmR', block(0.11, 0.012, 0.036, 0.003), plate, [0, y, -0.108]);
  // The coolant cell behind the chamber, toward the elbow, clamped by a steel band.
  k.add('foreArmR', block(0.06, 0.05, 0.036, 0.006), plate, [-0.03, -0.035, -0.098])
    .add('foreArmR', block(0.064, 0.01, 0.04, 0.002), steel, [-0.03, -0.035, -0.098])
    // Hinge plate at the front, and recoil pistons underneath.
    .add('foreArmR', block(0.16, 0.022, 0.14, 0.005), dark, [0, -0.262, 0.0])
    .sym('foreArmR', rod(0.012, 0.14, 8), steel, [0.05, -0.2, 0.08]);
}

/** The launcher pod's two tubes: half their spacing, radius and length. */
const TUBE_X = 0.045;
const TUBE_R = 0.038;
const TUBE_LEN = 0.26;
/** Where rockets leave the pod, in the pod's space: between the two tube mouths. */
export const POD_MUZZLE: V3 = [0, 0, -TUBE_LEN / 2 - 0.02];

/**
 * The launcher pod: a pair of round tubes for the two-rocket salvo, a spine
 * along the top, a clamp band and a short mount arm. It folds back over the
 * shoulder. The tube mouths glow.
 */
function pod(k: KitBuilder, body: string, top: string, mount: string, glow: string): void {
  const along: V3 = [HALF_PI, 0, 0];
  const front = -TUBE_LEN / 2;
  k.sym('pod', rod(TUBE_R, TUBE_LEN, 8), body, [TUBE_X, 0, 0], { rot: along })
    .sym('pod', rod(TUBE_R + 0.008, 0.035, 8), mount, [TUBE_X, 0, front + 0.015], { rot: along })
    .sym('pod', rod(TUBE_R - 0.012, 0.006, 8), glow, [TUBE_X, 0, front - 0.004], { glow: true, rot: along })
    .sym('pod', rod(TUBE_R - 0.006, 0.02, 8), mount, [TUBE_X, 0, -front + 0.008], { rot: along })
    .add('pod', block(0.06, 0.04, 0.2), top, [0, 0.035, 0.0])
    .add('pod', block(0.18, 0.09, 0.04), top, [0, 0, 0.055])
    .add('pod', block(0.05, 0.15, 0.05), mount, [0, -0.1, 0.06]);
}

const kits: Kit[] = [];

/** The suit a team wears: 0 the Corps, 1 Z.E.R.O. Built on first use and shared. */
export function suitKit(team: number): Kit {
  const t = team === 1 ? 1 : 0;
  return (kits[t] ??= t === 1 ? zero() : corps());
}
