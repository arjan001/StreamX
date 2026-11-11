/**
 * "Tell me once this is on screen" — one IntersectionObserver for every picture.
 *
 * Every picture tile (`Art` in components/Poster.tsx) asked twice — once for
 * its turn at the network, once to start its slow-host deadline — and each ask
 * was an IntersectionObserver of its own. The browser computes every observer
 * separately after every scroll and every layout, so a channel list with
 * twenty-five logos mounted was fifty observers re-evaluated on each D-pad
 * press: 128 ms over six presses in a trace on the TV emulator, the largest
 * cost left in the frame after the list stopped re-rendering its rows.
 *
 * One observer with many targets costs one pass. Both uses fire once and are
 * finished, so that is the whole API: a callback, called the first time the
 * element intersects, and a cancel.
 */

let io: IntersectionObserver | null = null;
const waiting = new Map<Element, Set<() => void>>();

function observer(): IntersectionObserver | null {
  if (io !== null) return io;
  if (typeof IntersectionObserver === 'undefined') return null;
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const calls = waiting.get(e.target);
      if (calls === undefined) continue;
      waiting.delete(e.target);
      io?.unobserve(e.target);
      for (const call of calls) call();
    }
  });
  return io;
}

/**
 * Call `fn` once, the first time `el` is on screen. Returns the cancel.
 *
 * Where there is no IntersectionObserver at all, "on screen" is not knowable
 * and `fn` runs at once — the behaviour every caller had before it asked.
 */
export function whenOnScreen(el: Element, fn: () => void): () => void {
  const o = observer();
  if (o === null) { fn(); return () => {}; }
  let calls = waiting.get(el);
  if (calls === undefined) {
    calls = new Set();
    waiting.set(el, calls);
    o.observe(el);
  }
  /* Its own identity, so the same function passed twice is two asks. */
  const mine = (): void => fn();
  calls.add(mine);
  return () => {
    const now = waiting.get(el);
    if (now === undefined) return;
    now.delete(mine);
    if (now.size === 0) { waiting.delete(el); o.unobserve(el); }
  };
}

/** For tests: how many elements are being watched. */
export function watchedCount(): number {
  return waiting.size;
}
