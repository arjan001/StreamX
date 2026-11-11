import { monogram } from '../lib/monogram';

/**
 * A tile for something with no artwork of its own.
 *
 * Used where we KNOW the provider's image is worthless rather than merely
 * missing: where 174 channels share one picon, drawing it
 * would be 174 identical squares — the generated tile is the better picture, not
 * the consolation prize.
 *
 * `Poster` now draws the same monogram when an image is missing or dead, which
 * this comment used to say it deliberately did not. What changed is the
 * measurement: the picon host behind 14,688 of the paid logos does not answer at
 * all from here, so "merely missing" describes most of a channel list, and a wall
 * of grey two-letter squares reads as a broken app rather than as a pending one.
 * This component stays because it is the tile WITHOUT an image element — no
 * request, no error, no state — which is what a grid of known-worthless artwork
 * wants.
 *
 * See `lib/monogram.ts` for why the colour is a hash and why it avalanches.
 */
export function MonogramTile({
  name,
  className,
  shape = 'box',
  size = 'md',
}: {
  name: string;
  className?: string;
  /** `round` for a person or a studio avatar; `box` for a channel tile. */
  shape?: 'box' | 'round';
  size?: 'sm' | 'md' | 'lg';
}) {
  const m = monogram(name);
  const text = size === 'sm' ? 'text-[length:var(--t-2xs)]' : size === 'lg' ? 'text-lg' : 'text-[length:var(--t-sm)]';
  return (
    <span
      aria-hidden
      /* `no-round` on the box variant is not a style opinion — it is how the
         corner-shape retrofit is told this element has already decided. The round
         variant uses `pill`, which the same layer defines. */
      className={`grid shrink-0 select-none place-items-center overflow-hidden font-mono
        ${shape === 'round' ? 'pill' : 'art'} ${text} ${className ?? ''}`}
      style={{ background: m.background, color: m.colour }}
    >
      {m.initials}
    </span>
  );
}
