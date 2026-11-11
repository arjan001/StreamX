/**
 * The spelling dictionary, built once and never on a keystroke.
 *
 * `core-store`'s `buildWordIndex` collects every distinct word in the catalogue
 * so that a mistyped one can be corrected against the vocabulary this
 * subscription actually contains, rather than against a static English word list
 * that has never heard of "Tolonews" or "Cranston". Measured on this provider's
 * 266,141-row catalogue on the development box: 517ms, producing 115,732 words
 * from the `norm` and `cast` columns.
 *
 * Half a second is not a keystroke's worth of time — and on a cheap television
 * box, which runs single-threaded JavaScript roughly three to five times slower
 * than that box, it is one and a half to two and a half seconds. So the rule
 * this file exists to enforce is: NOTHING ever waits for this that could have
 * answered without it.
 *
 * ── the three states, and what each one does ──
 *
 * idle      nobody has opened search yet. No index, no cost.
 * building  `warmSearchIndex` was called — by the search screen mounting — and
 *           the build is queued behind the browser's idle callback. Exact
 *           search answers every keystroke in the meantime, because it needs no
 *           dictionary at all.
 * ready     corrections are available.
 *
 * The warm starts when the search route mounts, which on a remote is several
 * seconds before anybody has pressed their way to a third letter: an on-screen
 * keyboard is three or four D-pad presses per character. By the time a query is
 * long enough to be worth correcting, this is almost always already ready.
 *
 * ── why it is not persisted with the columns ──
 *
 * It is derived from two columns that are already on the device, so storing it
 * would trade a rebuildable 1.5MB for a second artefact that can go stale, a
 * second thing to version, and a second reason `loadCatalogue` can return null.
 * A generation change simply throws it away and the next search rebuilds it.
 */
import { buildWordIndexSteps, type WordIndex } from '@iptv/core-store';
import { localCatalogue } from './localCatalogue.ts';

let generation: number | null = null;
let index: WordIndex | null = null;
let building: Promise<WordIndex | null> | null = null;

/**
 * Run something when the browser is not busy, with a deadline.
 *
 * `requestIdleCallback` is not in every engine this app ships to — it is absent
 * on older WebViews and on Safari — so the fallback is a plain timeout. The
 * timeout on the idle request matters more than the idle part: without it, a
 * screen that never goes idle (a rail animating, a video decoding) would never
 * build the dictionary at all, and the feature would silently be off on exactly
 * the devices that need the warm-up most.
 */
function whenIdle(fn: () => void, timeout = 2_000): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(fn, { timeout });
  else setTimeout(fn, 0);
}

/*
 * How long a slice of the build may wait for an idle moment before it is run
 * anyway.
 *
 * Short, and much shorter than the 2s that starts the build. Each slice is
 * bounded work now, so forcing one through on a busy screen costs a frame
 * rather than the whole build — while a long deadline would let a device that
 * is never quite idle take twenty seconds to finish a dictionary it used to
 * finish in one go. The point was never to build it later; it was to stop
 * building it all inside one keystroke.
 */
const SLICE_DEADLINE_MS = 200;

/**
 * Start building, or do nothing because it is already built or under way.
 *
 * Safe to call on every mount and every render — it is idempotent, and the
 * generation check is what makes it correct rather than merely cheap: a
 * re-ingest replaces the columns the dictionary was derived from, and an index
 * built against the previous generation would correct words out of a catalogue
 * that no longer exists.
 */
export function warmSearchIndex(): void {
  void ensureSearchIndex();
}

/**
 * The dictionary, waiting for the build if one is under way.
 *
 * Callers must only await this once they know they need it — see `localSearch`,
 * which runs the exact pass first and only reaches for this when that pass came
 * back too thin to be an answer. Awaiting it up front would put the whole build
 * in front of the first search of every session.
 *
 * Returns null when there is no local catalogue to index. That is not a failure:
 * the server-backed path has its own search, and a device mid-download has
 * nothing to correct against yet.
 */
export function ensureSearchIndex(): Promise<WordIndex | null> {
  const cat = localCatalogue();
  if (cat === null) return Promise.resolve(null);
  if (index !== null && generation === cat.generation) return Promise.resolve(index);
  if (building !== null && generation === cat.generation) return building;

  generation = cat.generation;
  index = null;
  building = new Promise<WordIndex | null>((resolve) => {
    whenIdle(() => {
      /* Re-read rather than closing over `cat`: an ingest can land between the
         idle request and the callback, and indexing the catalogue that was
         current when somebody opened the search screen is how a dictionary ends
         up describing rows that are gone. */
      const now = localCatalogue();
      if (now === null || now.generation !== generation) {
        building = null;
        resolve(null);
        return;
      }
      /*
       * Driven a slice at a time, giving the thread back between them.
       *
       * It used to be one `buildWordIndex(now)` call here, and the comment on
       * that function said the cost "is never spent on a keystroke". It was:
       * the idle request carries `timeout: 2000`, and somebody who presses
       * SEARCH is typing well inside two seconds, so the deadline fired while
       * they typed and a plain function had nowhere to stop. `search-probe`
       * measured one keystroke at 4302ms against a 20ms median and has been
       * printing SEARCH SLOW ever since.
       *
       * A generator has somewhere to stop. Each resume does a bounded slice and
       * returns the thread; `whenIdle` schedules the next one, so the build now
       * fills the gaps BETWEEN keystrokes instead of sitting in the middle of
       * one. The total work is identical and the finished index is byte for byte
       * the same — `buildWordIndex` is this same generator, drained in a loop.
       */
      const steps = buildWordIndexSteps(now);
      /*
       * The generation this build is FOR, captured once.
       *
       * Spreading the work over many callbacks opens a window the single call
       * did not have: an ingest can land halfway through, `ensureSearchIndex`
       * starts a second build for the new generation, and this one then wakes up
       * and assigns its finished-but-stale index over the top — and, worse,
       * clears `building`, so the newer build's promise is the one that goes
       * missing. Checking on every resume means a superseded build stops at the
       * next slice instead of racing the one that replaced it.
       */
      const mine = generation;
      const pump = (): void => {
        if (generation !== mine) { resolve(null); return; }
        try {
          const step = steps.next();
          if (step.done !== true) {
            /* One slice per callback. The generator has already bounded how much
               work that was; this only decides when the next one runs. */
            whenIdle(pump, SLICE_DEADLINE_MS);
            return;
          }
          index = step.value;
        } catch {
          /* A device short of memory is a device that should still be able to
             search. Losing corrections is the correct thing to lose. */
          index = null;
        }
        building = null;
        resolve(index);
      };
      pump();
    });
  });
  return building;
}

/** Whether corrections are available right now, without waiting for anything. */
export function searchIndexReady(): boolean {
  const cat = localCatalogue();
  return index !== null && cat !== null && generation === cat.generation;
}

/** Drop the dictionary. For the tests, and for a catalogue that has gone away. */
export function resetSearchIndex(): void {
  generation = null;
  index = null;
  building = null;
}
