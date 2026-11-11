/**
 * Artwork for things that have none.
 *
 * Some lines give a whole group of channels the SAME logo URL — one picon, 174
 * times. Rendering it as a grid produces 174 identical squares,
 * which is worse than no artwork at all: it looks like a loading bug and it makes
 * every tile indistinguishable at a glance.
 *
 * So the artwork has to be ours, and the only honest source for it is the name.
 * A deterministic hash of the name picks a hue, and the initials sit on it. Two
 * properties matter and both are tested:
 *
 *   - **stable** — the same name is the same colour on every device and after
 *     every re-ingest, so people learn "the green one" the way they learn a
 *     channel number.
 *   - **spread** — adjacent names must not land on adjacent hues, or a list sorted
 *     alphabetically becomes a gradient and nothing stands out. The hash is
 *     avalanching for that reason; a simple sum of char codes is not.
 *
 * Also useful where items point at picon hosts that never answer: each of those
 * is a tile that renders as initials on a flat panel.
 */

/**
 * FNV-1a, 32-bit.
 *
 * Chosen for the avalanche: "CHANNEL 1" and "CHANNEL 2" have to
 * come out far apart, and any additive hash puts them next to each other.
 */
export function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Up to two initials, from the words that carry meaning.
 *
 * Digits are dropped — "BRIGHTLY 1" and "BRIGHTLY 2" are one brand and should
 * read as one — and a single word gives its first two letters rather than one,
 * because a lone letter in a large tile looks like a placeholder.
 */
export function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && !/^\d+$/.test(w));
  if (words.length === 0) return '··';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export interface Monogram {
  initials: string;
  /** A CSS gradient for the tile background. */
  background: string;
  /** Text colour with enough contrast against that background. */
  colour: string;
  hue: number;
}

/**
 * The tile.
 *
 * Two stops rather than a flat fill: a flat colour behind large initials reads as
 * a missing image, and a gradient reads as a designed placeholder. The second hue
 * is offset by a fixed 40° so the pair always stays within one family instead of
 * occasionally landing on a clash.
 */
export function monogram(name: string): Monogram {
  const h = hashName(name);
  const hue = h % 360;
  /* Saturation and lightness are kept in a narrow band on purpose. The full range
     produces tiles that shout at each other in a grid, and pale ones that cannot
     carry white text. */
  const sat = 42 + (h >>> 9) % 18;
  const light = 26 + (h >>> 17) % 12;
  return {
    initials: initialsOf(name),
    background: `linear-gradient(135deg, hsl(${hue} ${sat}% ${light}%), hsl(${(hue + 40) % 360} ${sat}% ${Math.max(12, light - 10)}%))`,
    colour: `hsl(${hue} 30% 88%)`,
    hue,
  };
}
