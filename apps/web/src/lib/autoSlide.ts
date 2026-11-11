/**
 * One rail moves at a time.
 *
 * Ten rails each running their own timer would drift into sync and then all
 * shuffle together, which looks like the page glitching rather than like a shelf
 * being browsed. So there is one conductor: it keeps a register of the rails
 * currently on screen and, every few seconds, nudges exactly one of them.
 *
 * Deliberately not random-per-tick either. A uniform pick revisits the same rail
 * twice in a row often enough to notice, so the conductor shuffles the register
 * and walks it — every rail gets a turn before any rail gets a second one, which
 * is what "randomly, not all at once" actually looks like in practice.
 *
 * Stops completely when the tab is hidden, when the pointer is over a rail, or
 * when `prefers-reduced-motion` is set. Nothing here loops for decoration: the
 * point is to show that a strip continues past its right edge, which a static
 * page cannot say.
 */

export interface SlideTarget {
  /** Advance by one screenful. Returns false when it has nothing left to do. */
  advance: () => boolean;
  /** True while the pointer is in THIS rail, or focus is inside it. */
  held?: () => boolean;
}

const members = new Map<number, SlideTarget>();
let order: number[] = [];
let cursor = 0;
let timer: number | null = null;
let paused = false;
let nextId = 1;

/**
 * Milliseconds between nudges, across the whole page rather than per rail.
 *
 * This was 5200, which was effectively "never". One rail moves per tick and a
 * home page carries ten, so any given strip advanced once every 52 seconds —
 * long enough that the honest description of the feature was that it did not
 * exist. At 2600ms with three or four rails on screen at a time, each visible
 * strip moves every eight to ten seconds: noticeable, and still slow enough to
 * read past.
 */
const EVERY_MS = 2600;

function reduced(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Fisher-Yates over the ids currently registered. */
function reshuffle(): void {
  order = [...members.keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  cursor = 0;
}

function tick(): void {
  if (paused || members.size === 0) return;
  if (cursor >= order.length) reshuffle();
  // Walk until something actually moves. Two reasons a turn gets passed on: a
  // rail already at its end, and a rail the pointer is currently inside. The
  // second is why this loop exists rather than a single pick — skipping the held
  // rail must not cost the whole page its turn, which is exactly the bug that
  // made the feature invisible.
  for (let tries = 0; tries < order.length; tries++) {
    const id = order[cursor++];
    if (cursor >= order.length) reshuffle();
    const target = id === undefined ? undefined : members.get(id);
    if (!target) continue;
    if (target.held?.()) continue;
    if (target.advance()) return;
  }
}

function ensureTimer(): void {
  if (timer !== null || typeof window === 'undefined') return;
  if (reduced()) return;
  timer = window.setInterval(tick, EVERY_MS);
}

function stopTimer(): void {
  if (timer === null || typeof window === 'undefined') return;
  window.clearInterval(timer);
  timer = null;
}

/** Register a rail while it is on screen. Returns the unregister function. */
export function joinAutoSlide(target: SlideTarget): () => void {
  const id = nextId++;
  members.set(id, target);
  reshuffle();
  ensureTimer();
  return () => {
    members.delete(id);
    reshuffle();
    if (members.size === 0) stopTimer();
  };
}

/**
 * Hold the whole conductor. Reserved for page-wide reasons only.
 *
 * It used to be called on pointer-enter of any rail, which is why the user's
 * report was "there are no auto slides": a home page is mostly rails, so a
 * cursor resting anywhere in the content stopped every strip on the page
 * indefinitely. Reading one strip is a reason to hold THAT strip — which is what
 * `SlideTarget.held` is for — not a reason to freeze the page.
 *
 * Still page-wide for: a hidden tab, and a drag in progress.
 */
export function holdAutoSlide(value: boolean): void {
  paused = value;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    paused = document.visibilityState === 'hidden';
  });
}
