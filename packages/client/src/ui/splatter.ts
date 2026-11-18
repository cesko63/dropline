/**
 * Splatter thrown across the player's view when they are hit: Corps blood, or
 * the crude a Z.E.R.O frame runs on. Each is a blot thrown round with drops,
 * a few runs dripping down from it, and a wet highlight, painted once.
 */
const LOOK = [
  { fill: 'rgba(118, 6, 4, 0.92)', dark: 'rgba(60, 2, 2, 0.9)', shine: 'rgba(255, 140, 130, 0.22)' },
  { fill: 'rgba(14, 11, 8, 0.94)', dark: 'rgba(4, 3, 2, 0.95)', shine: 'rgba(170, 160, 150, 0.3)' },
];
/** Splats painted per side, so hits do not all look alike. */
export const SPLAT_VARIANTS = 3;

const cache: string[][] = [[], []];

/** The images (data URLs) for a side: 0 the Corps, 1 Z.E.R.O. */
export function splatImages(team: number): string[] {
  const side = team === 1 ? 1 : 0;
  if (!cache[side].length) for (let i = 0; i < SPLAT_VARIANTS; i++) cache[side].push(paint(LOOK[side]));
  return cache[side];
}

function paint(look: (typeof LOOK)[number]): string {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const mid = size / 2;
  const rand = (a: number, b: number): number => a + Math.random() * (b - a);
  const blob = (x: number, y: number, r: number): void => {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  // The blot: overlapping rounds, darker at the heart.
  g.fillStyle = look.fill;
  for (let i = 0; i < 14; i++) blob(mid + rand(-26, 26), mid + rand(-22, 22), rand(14, 30));
  g.fillStyle = look.dark;
  for (let i = 0; i < 5; i++) blob(mid + rand(-14, 14), mid + rand(-12, 12), rand(8, 16));
  // Drops thrown out round it, smaller the further they flew.
  g.fillStyle = look.fill;
  for (let i = 0; i < 26; i++) {
    const a = rand(0, Math.PI * 2);
    const d = rand(48, 118);
    blob(mid + Math.cos(a) * d, mid + Math.sin(a) * d, rand(2, 9) * (1 - d / 160));
  }
  // Runs dripping down from the blot, each ending in a bead.
  g.strokeStyle = look.fill;
  g.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const x = mid + rand(-28, 28);
    const len = rand(30, 100);
    g.lineWidth = rand(4, 8);
    g.beginPath();
    g.moveTo(x, mid);
    g.lineTo(x + rand(-4, 4), mid + len);
    g.stroke();
    blob(x, mid + len, g.lineWidth * 0.8);
  }
  // A wet highlight on the upper left of the blot.
  g.fillStyle = look.shine;
  blob(mid - 12, mid - 10, 7);
  blob(mid - 4, mid - 16, 3);
  return c.toDataURL();
}
