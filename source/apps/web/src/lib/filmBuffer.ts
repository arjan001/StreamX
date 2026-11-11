/**
 * What is held, and what that means for the next press — the arithmetic only.
 *
 * Kept apart from the player because these are decisions that need no browser:
 * whether a jump can be served from what is already buffered, and how far ahead
 * the film is already fetched.
 */

export interface Span { start: number; end: number }

/** `TimeRanges` as data. The same shape a test can write by hand. */
export function spansOf(b: { length: number; start(i: number): number; end(i: number): number } | null): Span[] {
  if (b === null) return [];
  const out: Span[] = [];
  for (let i = 0; i < b.length; i++) out.push({ start: b.start(i), end: b.end(i) });
  return out;
}

/**
 * A little forgiveness at the edges.
 *
 * A fragment boundary is where it is, not where the arithmetic would like it,
 * and a seek to a second that lands a few frames outside a held range would
 * otherwise cost a whole new pass — a new ffmpeg, a new connection, seconds of
 * black — to fetch something the browser is already holding.
 */
const EDGE_S = 0.6;

/** Seconds of continuous video after `t`, in whatever holds `t`. 0 if nothing does. */
export function aheadOf(spans: readonly Span[], t: number): number {
  for (const s of spans) {
    if (t >= s.start - EDGE_S && t < s.end) return s.end - t;
  }
  return 0;
}

/**
 * Can this jump be served out of memory?
 *
 * The question the whole design turns on. "Why can't it hold which parts are
 * downloaded like other players" — it can, and this is where that becomes
 * visible: true here means a jump costs nothing at all, no request, no ffmpeg,
 * no wait. `need` is how much must be there before that is a promise worth
 * making; landing on a quarter of a second of video and then stalling is worse
 * than a clean reload.
 */
export function holds(spans: readonly Span[], t: number, need = 2): boolean {
  return aheadOf(spans, t) >= need;
}
