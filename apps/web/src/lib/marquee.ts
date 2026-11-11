/**
 * A truncated name slides to show its end while you are on its row.
 *
 * Asked for with the density pass, once the rows lost their padding and the long
 * names still did not fit: "and when on it i mean it should animate back and
 * forth". A television cannot hover to read a tooltip, and a raw category name
 * like `DE| PRIME ᴿᴬᵂ ⁶⁰ᶠᵖˢ` or a channel called "SKY SPORTS PREMIER LEAGUE UHD"
 * is exactly the text that is cut off in the part that tells two rows apart.
 *
 * ONE implementation for every row that wants it, installed once: a row marks its
 * title's text with `data-marquee` inside the truncating `.pick-title`, and the
 * listeners here — on the document, delegated — do the rest. No per-row state,
 * no per-row listener, nothing for a virtualised list to mount a hundred times.
 *
 * ── the three traps, which decide the markup ──
 *
 *   - `transform` does not apply to a non-replaced INLINE element, so the text
 *     cannot slide while it is an ordinary inline span;
 *   - but an overflowing INLINE-BLOCK kills `text-overflow: ellipsis` on its
 *     parent, so it cannot be an inline-block at rest either;
 *   - so it is inline at rest (the ellipsis works), and only while it runs is it
 *     an inline-block inside a parent switched to `text-overflow: clip`. Both are
 *     inline styles put on and taken off here; the stylesheet never knows.
 *
 * And the costs, because this runs on a set-top box: `transform` only, through
 * the Web Animations API (Chrome 36+, so every WebView this app ships to), which
 * the compositor runs without a layout or a paint per frame. The row does not
 * change size — the text moves inside a box that stays exactly where it was.
 *
 * It waits `REST_MS` before starting, so walking a list at speed does not strobe
 * every row it passes; it pauses at each end; it stops and puts the text back
 * the moment focus or the pointer leaves; it does nothing for a name that fits,
 * and nothing at all under `prefers-reduced-motion`.
 */

/** How long the highlight has to rest on a row before its name starts to move. */
export const REST_MS = 400;
/** Travel speed, in CSS px per second — slow enough to read at three metres. */
export const SPEED_PX_S = 36;
/** Hold at each end, so the start and the end are both actually readable. */
export const HOLD_MS = 1200;

export interface MarqueePlan {
  keyframes: { transform: string; offset: number }[];
  duration: number;
}

/**
 * The whole back-and-forth as one looping animation, or null when the text fits.
 *
 * Pure and exported for its test. `distance` is how far the text overflows its
 * box; `rtl` flips the travel, because a right-to-left name starts at the RIGHT
 * edge and is cut off on the left, so revealing its end means moving it right.
 */
export function marqueePlan(
  distance: number,
  rtl: boolean,
  speed: number = SPEED_PX_S,
  hold: number = HOLD_MS,
): MarqueePlan | null {
  if (!(distance > 1) || !(speed > 0)) return null;
  const travel = Math.round((distance / speed) * 1000);
  const duration = hold + travel + hold + travel;
  const end = `translateX(${rtl ? distance : -distance}px)`;
  const at = (ms: number) => Math.round((ms / duration) * 10_000) / 10_000;
  return {
    duration,
    keyframes: [
      { transform: 'translateX(0px)', offset: 0 },
      { transform: 'translateX(0px)', offset: at(hold) },
      { transform: end, offset: at(hold + travel) },
      { transform: end, offset: at(hold + travel + hold) },
      { transform: 'translateX(0px)', offset: 1 },
    ],
  };
}

/** Exported only so the test can build one; nothing else needs the shape. */
export interface Running {
  timer: number;
  anim: Animation | null;
  focus: boolean;
  hover: boolean;
}

/**
 * Every row the highlight has ever touched, for as long as it is still in the
 * document. That "as long as" is not automatic — see `sweep`, below, which is
 * what makes it true rather than merely intended.
 *
 * Exported for the test only, the same way `lib/localRead.ts` exports
 * `titleCodec` "for the tests, and for a debug panel" — nothing else outside
 * this module has a reason to read or write it, since `arm`/`disarm` are the
 * only correct way to change what it holds.
 */
export const rows = new Map<HTMLElement, Running>();
let installed = false;

function rowOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>('.pick-row');
  return row !== null && row.querySelector('[data-marquee]') !== null ? row : null;
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function run(row: HTMLElement, state: Running): void {
  state.timer = 0;
  if (reducedMotion()) return;
  const inner = row.querySelector<HTMLElement>('[data-marquee]');
  const box = inner?.parentElement ?? null;
  if (inner === null || box === null || typeof inner.animate !== 'function') return;
  if (box.scrollWidth - box.clientWidth <= 1) return;
  box.style.textOverflow = 'clip';
  inner.style.display = 'inline-block';
  /* Measured as an inline-block, which is the box that actually moves. */
  const distance = inner.getBoundingClientRect().width - box.clientWidth;
  const plan = marqueePlan(distance, getComputedStyle(box).direction === 'rtl');
  if (plan === null) {
    reset(inner, box);
    return;
  }
  state.anim = inner.animate(plan.keyframes, {
    duration: plan.duration,
    iterations: Infinity,
    easing: 'linear',
  });
}

function reset(inner: HTMLElement, box: HTMLElement): void {
  inner.style.display = '';
  box.style.textOverflow = '';
}

function stop(row: HTMLElement): void {
  const state = rows.get(row);
  if (state === undefined) return;
  if (state.timer !== 0) window.clearTimeout(state.timer);
  state.anim?.cancel();
  const inner = row.querySelector<HTMLElement>('[data-marquee]');
  if (inner !== null && inner.parentElement !== null) reset(inner, inner.parentElement);
  rows.delete(row);
}

/**
 * Drop every entry whose row has left the document.
 *
 * `focusout` is how an entry is meant to leave this Map — see `disarm`, below —
 * and it is a thinner guarantee than it looks. Chromium DOES fire `focusout`
 * and `blur` for a focused element that is removed from the document, measured
 * directly rather than assumed, and has for years, so this Map is not in fact
 * leaking today. But Chromium is the only engine that fires them; the HTML spec
 * sides with Firefox and WebKit, which fire nothing; and Chromium has a live
 * intent to deprecate and remove the behaviour, to cut the synchronous side
 * effects of DOM removal.
 *
 * What makes that worth defending against here rather than noting and moving on
 * is which row is at stake. `VirtualList` keys each row by its virtual index
 * and passes no `getItemKey`, so a row scrolling out of the overscanned range
 * is unmounted outright rather than repositioned — and the row under the
 * highlight is exactly the one fast scrolling keeps pushing out of range. So
 * the single row guaranteed to be mid-animation when it disappears would also
 * be the one that stops announcing itself, and each one left behind holds a
 * detached subtree and an `iterations: Infinity` Animation, neither of which
 * can be collected while this Map still points at them.
 *
 * So it does not wait to be told. It runs from `arm`, which fires on every
 * focusin or pointerover this module sees — precisely the activity fast
 * navigation produces — so the Map can never hold more disconnected rows than
 * the highlight has passed over since anything anywhere was last armed.
 * Self-limiting rather than scheduled: no timer to leak in turn, and nothing
 * for a caller to remember.
 */
export function sweep(): void {
  for (const row of rows.keys()) {
    if (!row.isConnected) stop(row);
  }
}

function arm(row: HTMLElement, why: 'focus' | 'hover'): void {
  sweep();
  let state = rows.get(row);
  if (state === undefined) {
    state = { timer: 0, anim: null, focus: false, hover: false };
    rows.set(row, state);
  }
  state[why] = true;
  if (state.timer !== 0 || state.anim !== null) return;
  const armed = state;
  state.timer = window.setTimeout(() => {
    /* A virtualised row's INDEX can be reused for another channel inside the
       wait — a fresher `arm` has already replaced `armed` in the Map, and that
       newer state is not this callback's business, so it is left untouched. */
    if (rows.get(row) !== armed) return;
    /* But if the row is simply gone rather than reused, no later event will
       ever tell this module so (see `sweep`, above) — `run` would then start
       animating a node that is no longer on the page. `sweep` would eventually
       notice, but only once some OTHER row is armed, and there is no reason to
       leave a known-dead entry sitting there until that happens to occur. */
    if (!row.isConnected) { stop(row); return; }
    run(row, armed);
  }, REST_MS);
}

function disarm(row: HTMLElement, why: 'focus' | 'hover'): void {
  const state = rows.get(row);
  if (state === undefined) return;
  state[why] = false;
  if (!state.focus && !state.hover) stop(row);
}

/**
 * Install the listeners, once, whoever asks first. Idempotent, so every screen
 * with such a row can ask on mount without coordinating.
 */
export function installMarquee(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('focusin', (e) => {
    const row = rowOf(e.target);
    if (row !== null) arm(row, 'focus');
  }, true);
  document.addEventListener('focusout', (e) => {
    const row = rowOf(e.target);
    if (row === null) return;
    /* Focus moving between two controls of the SAME row (a nested group's
       button inside its row) is not leaving it. */
    if (e.relatedTarget instanceof Node && row.contains(e.relatedTarget)) return;
    disarm(row, 'focus');
  }, true);
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const row = rowOf(e.target);
    if (row !== null) arm(row, 'hover');
  }, true);
  document.addEventListener('pointerout', (e) => {
    const row = rowOf(e.target);
    if (row === null) return;
    if (e.relatedTarget instanceof Node && row.contains(e.relatedTarget)) return;
    disarm(row, 'hover');
  }, true);
}
