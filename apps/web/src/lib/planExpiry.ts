/**
 * How far off a plan's expiry is, and how loudly that should be said.
 *
 * Asked for directly: "expiry date AND days-until-expiry (highlight expired and
 * expiring-soon)." The admin screen already showed the date (`until 2026-09-20`);
 * what it did not do is say how many days that is, or make the ones about to
 * lapse look any different from the ones that lapsed months ago.
 *
 * A pure module on purpose: no fetch, no React, nothing that needs a server to
 * exercise — the only input is a timestamp and "now".
 */

/**
 * Whole days between now and an ISO expiry — negative once it is in the past.
 *
 * `null` for anything that is not a usable date, INCLUDING no date at all: a
 * free viewer has no expiry and "0 days" would say something false about them.
 * Rounded rather than floored so "in 6 days and 23 hours" reads as 7, not 6 —
 * the number an operator would say out loud.
 */
export function daysUntilExpiry(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round((t - now) / 86_400_000);
}

export type ExpiryTone = 'expired' | 'soon' | 'ok' | 'none';

/**
 * How urgently an expiry should read, from the number `daysUntilExpiry` gave.
 *
 * `soon` at seven days because that is the aggregate the overview counts by —
 * an operator who filters the roster on "expiring soon" and a badge that lights
 * up under a different threshold would be two screens disagreeing about the
 * same word.
 */
export function expiryTone(days: number | null): ExpiryTone {
  if (days === null) return 'none';
  if (days < 0) return 'expired';
  if (days <= 7) return 'soon';
  return 'ok';
}

/**
 * "expired 3d ago" / "in 6d" / "today" — the phrase, not just the number.
 *
 * Kept separate from `daysUntilExpiry` so a caller that only wants the number
 * (to sum, to sort, to threshold) is not forced through a string first.
 */
export function expiryPhrase(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'today';
  if (days < 0) return `expired ${-days}d ago`;
  return `in ${days}d`;
}
