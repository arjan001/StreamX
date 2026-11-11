/**
 * The tallies beside rows and chips — off unless somebody turns them on.
 *
 * Asked for in two steps, and the second one is the whole design: first "if 0
 * don't show", then "I said don't show numbers AT ALL — in settings add a
 * setting I can enable and disable, by default disabled".
 *
 * ── why off is the right default ──
 *
 * A tally next to a label is not data, it is an INVITATION: it says how much is
 * behind this row so you can decide whether to press it. That is worth something
 * on a desk, where the number is a glance away and the pointer is already
 * hovering. On a television it is a second column of grey digits down a rail
 * you read from three metres away, competing with the words for the only thing
 * that matters there — which row is highlighted. Every screen in this app has
 * a heading that already says how much is in it.
 *
 * So the numbers stay available and stop being the default. Somebody curating a
 * library — deciding which of 79 countries to keep, which packages are worth
 * downloading — genuinely needs them, and that person can turn them on in
 * Settings → Appearance. Everyone else gets the rail without them.
 *
 * ── how it is wired ──
 *
 * `useTally` returns a formatter rather than a boolean, so a call site reads
 * `{count(n)}` and cannot forget to check the setting. It hangs off `usePrefs`,
 * which is already a subscription, so flipping the switch re-renders every
 * screen holding one — no module-level flag to go stale, and no CSS rule that
 * hides a number the DOM still contains.
 *
 * Zero prints nothing even when counts are ON: "Favourites 0" invites you into
 * an empty room, and absence reads as "nothing here" perfectly well.
 */
import { useCallback } from 'react';
import { usePrefs } from './prefs.ts';

/**
 * Format a count, or nothing at all.
 *
 * Separate from the hook so the rule is testable without React: zero, nothing,
 * and anything that is not a positive finite number all print as absence.
 */
export function formatTally(n: number | null | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n.toLocaleString();
}

/**
 * The formatter for a component that prints counts.
 *
 * Returns null for every number while the setting is off, so a call site needs
 * no condition of its own — `{count(n)}` renders nothing, `` `${count(n) ?? ''}` ``
 * interpolates nothing, and a `hint` prop receives nothing.
 */
export function useTally(): (n: number | null | undefined) => string | null {
  const [prefs] = usePrefs();
  const on = prefs.showCounts;
  return useCallback((n: number | null | undefined) => (on ? formatTally(n) : null), [on]);
}
