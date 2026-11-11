import {
  mdiBasketball, mdiBike, mdiBilliards, mdiBoxingGlove, mdiBullseyeArrow, mdiCricket,
  mdiFootball, mdiGolf, mdiHockeySticks, mdiHorseHuman, mdiRacingHelmet, mdiRugby,
  mdiRun, mdiSoccer, mdiTennis, mdiWhistle,
} from '@mdi/js';

/**
 * One icon per sport — real glyphs, never emoji.
 *
 * "you are not to use uni icons, you must use proper icons" — a channel row read
 * from three metres needs a shape, not a font glyph whose weight and colour vary
 * by platform. Material Design Icons (`@mdi/js`) ships plain path data, so this
 * is a `viewBox="0 0 24 24"` `<path>` sized and coloured entirely by the caller's
 * className, same as every `lucide-react` icon already used across the app.
 */
const PATHS: Record<string, string> = {
  football: mdiSoccer,
  rugby: mdiRugby,
  tennis: mdiTennis,
  cricket: mdiCricket,
  motorsport: mdiRacingHelmet,
  boxing: mdiBoxingGlove,
  darts: mdiBullseyeArrow,
  golf: mdiGolf,
  horseracing: mdiHorseHuman,
  snooker: mdiBilliards,
  basketball: mdiBasketball,
  athletics: mdiRun,
  cycling: mdiBike,
  icehockey: mdiHockeySticks,
  nfl: mdiFootball,
  /* Sport that is none of the fifteen — the referee's whistle, not a ball. */
  othersport: mdiWhistle,
};

export function SportIcon({ sport, className }: { sport: string; className?: string }) {
  const d = PATHS[sport];
  if (d === undefined) return null;
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path d={d} fill="currentColor" />
    </svg>
  );
}
