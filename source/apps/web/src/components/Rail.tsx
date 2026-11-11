import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useShape } from '../lib/formFactor';
import { railVisibleCount, tileCapPx, tileRem } from '../lib/home';
import { joinAutoSlide } from '../lib/autoSlide';

/**
 * Render children only once the section is near the viewport.
 *
 * The home page is ten rails, and each one owns its own query. Mounting them all
 * at once means ten requests in the same tick — which is fine against Postgres
 * and not fine as a habit: the same page against the client-side store later, or
 * against a panel-backed endpoint, would stall on the first paint. So a rail
 * below the fold costs nothing until it is nearly on screen.
 *
 * `rootMargin` is generous on purpose: the data should be in flight before the
 * rail is visible, not after, or scrolling reveals a row of skeletons.
 */
export function Lazy({
  children,
  minHeight,
  anchor,
}: {
  children: React.ReactNode;
  /** Reserved while unmounted, so the scrollbar does not jump as rails wake up. */
  minHeight: string;
  /**
   * Stamped on the placeholder itself, as `data-rail-to`, so it can be found
   * before it has anything in it.
   *
   * The one caller that needs this is `Showcase`: a package rail deep enough
   * that BACK needs it scrolled into view has nothing else to select — this
   * div is on screen, reserving `minHeight`, long before the gate below lets
   * its content mount, and scrolling THIS into view is what wakes that gate.
   * See the "returning to a package rail" note in `lib/home.ts`.
   */
  anchor?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  /* The height the rail had when it was put away, so the page does not move. */
  const kept = useRef<number | null>(null);

  /*
   * Mounted when near, and — this is the half that was missing — put away again
   * when far.
   *
   * "the app crashes or hangs when scrolling … it renders all?" It did, here.
   * Measured on the TV emulator, sixty presses of DOWN through the showcase:
   * 633 elements became 6,543 and 37 images became 537, and the main thread was
   * blocked for 80.6 seconds out of 35 — every rail ever scrolled past stayed
   * mounted with its 24 posters, and every press walked all of them. Movies,
   * Series and Live, which virtualise, stayed flat over the same run.
   *
   * So a rail more than a couple of screens away gives its content back and
   * keeps only its measured height. Its query stays in React Query's cache, so
   * coming back is a render, not a request. Never while focus is inside it.
   *
   * The observers watch the SCROLLER, not the viewport: the rails scroll inside
   * `[data-hero-scroll]`, and against the viewport every rail outside that box
   * is clipped to "not visible" whatever the margin says — rails a pixel off
   * screen would unmount and remount on every press.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // No IntersectionObserver (old webview) means show everything rather than
    // silently rendering an empty page.
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return undefined;
    }
    const root = el.closest<HTMLElement>('[data-hero-scroll]');
    const near = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setShown(true); },
      { root, rootMargin: '600px 0px' },
    );
    const far = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last === undefined || last.isIntersecting) return;
        if (el.contains(document.activeElement)) return;
        kept.current = el.offsetHeight > 0 ? el.offsetHeight : kept.current;
        setShown(false);
      },
      { root, rootMargin: '1600px 0px' },
    );
    near.observe(el);
    far.observe(el);
    return () => { near.disconnect(); far.disconnect(); };
  }, []);

  const reserve = kept.current !== null ? `${kept.current}px` : minHeight;
  return (
    <div ref={ref} data-rail-to={anchor} style={shown ? undefined : { minHeight: reserve }}>
      {shown ? children : null}
    </div>
  );
}

/* ── the entrance cadence ─────────────────────────────────────────────────── */

/** One step between shelves, and the most steps any one shelf will ever wait. */
const STEP_MS = 40;
const MAX_STEPS = 4;

/** When the shelf that mounted last will have finished taking its turn. */
let queuedUntil = 0;

/**
 * How long this shelf waits before easing in, so the page assembles rather than
 * flashing — measured from the shelf that mounted before it, not from an index.
 *
 * An index is what a stack of rows normally staggers by — `.stagger > *` and
 * `.step > *` in index.css both do — and it cannot work here, because the home
 * page decides what to draw as it goes. `Lazy` holds everything below the fold
 * back until it is nearly on screen, a taste rail renders nothing at all on a
 * cold profile, and a package rail whose query comes back empty returns `null`.
 * Numbered from the markup, the first shelf a viewer with no history and no
 * favourites actually sees is the fifth one — so the page would sit still for
 * 160ms and then start moving, which is the opposite of the point.
 *
 * A clock has no such gap. Whatever mounts next is the next step, five shelves
 * landing in one tick step in over 160ms, and a shelf that mounts alone —
 * scrolled into view a minute later — finds the queue empty and starts
 * immediately. The cap is what keeps a page of a hundred rails from promising a
 * four-second cascade: nothing waits longer than 160ms, so the last shelf of a
 * burst is done at 380ms, inside the window where a viewer is still reaching for
 * the remote. Measured on the television build: delays of 0, 39.2 and 78.6ms
 * across a burst of three, and 0 for a shelf scrolled to on its own.
 */
function enterDelay(): number {
  const now = performance.now();
  const wait = Math.min(Math.max(queuedUntil - now, 0), STEP_MS * MAX_STEPS);
  queuedUntil = now + wait + STEP_MS;
  return wait;
}

/**
 * Fallback tile width in rem — prefer measured px inside a `Rail`.
 *
 * Capped on a television, where the rem fallback alone painted a 256px poster
 * on a 960px screen. See `tileCapPx`; the division puts the cap back into rem
 * so callers that multiply by the root keep working.
 */
export function useTileRem(): number {
  const { ff, height } = useShape();
  const cap = tileCapPx(ff, height);
  const rem = tileRem(ff);
  return cap === Infinity ? rem : Math.min(rem, cap / 16);
}

const RailTilePx = createContext(0);

/** Measured poster width so ~5 fill the visible strip (3 on phone). */
export function useRailTilePx(): number {
  const measured = useContext(RailTilePx);
  const { ff, height } = useShape();
  const fallback = tileRem(ff) * 16;
  return Math.min(measured > 0 ? measured : fallback, tileCapPx(ff, height));
}

/* ── returning to the rail you left from ─────────────────────────────────── */

/**
 * BACK from a category page lands focus on the rail its own header opened,
 * rather than at the top of a fresh Home.
 *
 * `Chrome` remounts the whole route on any pathname change (`<main
 * key={pathname}>`), so Home after BACK starts exactly like a first visit — no
 * scroll position, no shown-rail count, and no focus memory: `land`'s group
 * memory in `lib/spatialNav.ts` only survives a move WITHIN one mount, and this
 * rail's own `<section>` carries no `data-nav-group` regardless. `focusFirst`
 * would otherwise land on the hero, the first focusable thing in reading order,
 * the same place a brand new visit lands.
 *
 * So the header link leaves its own address behind on the way out, keyed on
 * nothing but that address — every rail already carries a unique one (`to`),
 * so no second id is needed. The rail whose address matches on the way back
 * claims `data-nav-first` and the match is read once, at mount, and forgotten,
 * so an ordinary later visit to Home does not keep landing here.
 */
const LAST_RAIL_KEY = 'iptv.lastRailTo.v1';

/**
 * A read-only peek at the same memory, for `Showcase` (routes/Home.tsx).
 *
 * A package rail deep enough that it has not mounted yet cannot claim
 * `data-nav-first` on its own — see the "returning to a package rail" note
 * in `lib/home.ts` — so Home needs to know what BACK is trying to reach
 * before any `Rail` has had the chance to read it itself. Reading is safe to
 * share: only `rememberRailTo` (on click) and `forgetLastRailTo` (below, on
 * the one `Rail` that actually matches) ever write this key, so Home peeking
 * at it cannot race, duplicate or pre-empt the clearing every shallow rail
 * already relied on before this existed.
 */
export function readLastRailTo(): string | null {
  try { return sessionStorage.getItem(LAST_RAIL_KEY); } catch { return null; }
}
function rememberRailTo(to: string): void {
  try { sessionStorage.setItem(LAST_RAIL_KEY, to); } catch { /* private mode: BACK just opens the hero */ }
}
function forgetLastRailTo(): void {
  try { sessionStorage.removeItem(LAST_RAIL_KEY); } catch { /* nothing to undo */ }
}

/**
 * A titled horizontal strip.
 *
 * Tile width is measured so five posters fill the row on desktop/TV (three on a
 * phone) — not a fixed rem that left a blank band on the right.
 */
export function Rail({
  title,
  to,
  toLabel = 'See all',
  note,
  loading,
  enter,
  skeletons = 8,
  skeletonAspect = 'aspect-[2/3]',
  children,
}: {
  title: string;
  to?: string;
  toLabel?: string;
  note?: string;
  loading?: boolean;
  /**
   * Ease this shelf in when it mounts, in turn with the others (`enterDelay`).
   *
   * Opt-in rather than the default, because a shelf is not always an arrival: the
   * two on a film's page sit under a hero that has already animated, and a screen
   * whose entry point (`data-nav-first`) is inside a rail must not be handed a
   * shelf that is still on its way in. The showcase is the page built out of
   * nothing but shelves, and it is the page that was reported as motionless.
   */
  enter?: boolean;
  skeletons?: number;
  skeletonAspect?: string;
  children?: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const { ff, height: viewportH } = useShape();
  const visible = railVisibleCount(ff);
  const [tilePx, setTilePx] = useState(0);
  const [reach, setReach] = useState({ left: false, right: false });
  const held = useRef(false);
  /* Claimed once, at mount, and kept: a re-render when the query lands must not
     book this shelf a second turn behind whatever has mounted since. */
  const [delay] = useState(() => (enter ? enterDelay() : 0));
  /* Read once, at mount — see the note on `LAST_RAIL_KEY` above. A pure read:
     the matching rail clears the flag itself, in an effect below, once mount
     has actually happened for every rail in this pass. */
  const [cameFromHere] = useState(() => to !== undefined && readLastRailTo() === to);
  useEffect(() => { if (cameFromHere) forgetLastRailTo(); }, [cameFromHere]);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const gap = Number.parseFloat(getComputedStyle(el).columnGap || getComputedStyle(el).gap) || 12;
    const next = Math.floor((el.clientWidth - gap * (visible - 1)) / visible);
    if (next > 0) setTilePx(next);
    const max = el.scrollWidth - el.clientWidth;
    setReach({ left: el.scrollLeft > 4, right: el.scrollLeft < max - 4 });
  }, [visible]);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [measure, children]);

  /* Measured for width, capped by the screen — a rail that fits five across can
     still be too tall to leave anything under it. See `tileCapPx`. */
  const slot = Math.min(tilePx > 0 ? tilePx : tileRem(ff) * 16, tileCapPx(ff, viewportH));

  const nudge = useCallback((dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth - slot, slot), behavior: 'smooth' });
  }, [slot]);

  useEffect(() => {
    if (loading) return;
    const el = scroller.current;
    if (!el) return;
    let seen = false;
    let leave: (() => void) | null = null;
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(
      (entries) => {
        const on = entries.some((e) => e.isIntersecting);
        if (on && !seen) {
          seen = true;
          leave = joinAutoSlide({
            held: () => held.current,
            advance: () => {
              const node = scroller.current;
              if (!node) return false;
              const max = node.scrollWidth - node.clientWidth;
              if (max < 8) return false;
              if (node.scrollLeft >= max - 4) {
                node.scrollTo({ left: 0, behavior: 'smooth' });
                return true;
              }
              nudge(1);
              return true;
            },
          });
        } else if (!on && seen) {
          seen = false;
          leave?.();
          leave = null;
        }
      },
      { rootMargin: '0px' },
    );
    io?.observe(el);
    return () => {
      io?.disconnect();
      leave?.();
    };
  }, [loading, nudge]);

  return (
    <RailTilePx.Provider value={slot}>
      <section
        data-nav-scope
        className={`group/rail relative px-3 py-3 sm:px-6${enter ? ' anim-shelf' : ''}`}
        style={enter ? { animationDelay: `${delay}ms` } : undefined}
        onPointerEnter={() => { held.current = true; }}
        onPointerLeave={() => { held.current = false; }}
        onFocusCapture={() => { held.current = true; }}
        onBlurCapture={() => { held.current = false; }}
      >
        {/*
          Title and "See all" as ONE element, not two.

          The heading used to be plain text beside a small link at the far
          right — reachable, if at all, only by a press that landed exactly
          under it. A rail spans most of the screen's width, so UP from a tile
          on the left half of it had nothing above to find. Spanning the link
          across the whole row, title included, means UP from ANY tile in the
          strip overlaps it — see `pickNext` in `lib/spatialNav.ts` on why
          horizontal overlap is what a vertical press matches on — and OK opens
          the same page a click always did.

          Only when there IS a destination: a rail with no `to` — "Continue
          watching" is the one on this page, and rightly, since a mixed list of
          films and series has no single category to send "See all" to — stays
          exactly the plain heading it always was.
        */}
        {to ? (
          <Link
            to={to}
            onClick={() => rememberRailTo(to)}
            {...(cameFromHere ? { 'data-nav-first': true } : {})}
            /* `-mx-1.5`/`px-1.5` net to zero for the title and the chevron —
               same left edge as the posters below, same right edge as before
               — and give the focus ring (inset 2px on a television) room that
               is not the first letter of the title. Reported as "PERSIAN
               SERIES" reading as "ERSIAN SERIES" under a focused ring. */
            className="tap group/hdr -mx-1.5 mb-2 flex items-baseline gap-3 px-1.5"
          >
            <h2 className="font-mono text-[length:var(--t-xs)] tracking-widest text-ink-2
                           transition-colors group-hover/hdr:text-ink group-focus-visible/hdr:text-focus">
              {title.toUpperCase()}
            </h2>
            {note && <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">{note}</span>}
            <span className="flex-1" />
            <span className="flex items-center gap-1 font-mono text-[length:var(--t-2xs)] text-ink-3
                             transition-colors group-hover/hdr:text-tally group-focus-visible/hdr:text-focus">
              {toLabel} <ChevronRight className="h-3 w-3" />
            </span>
          </Link>
        ) : (
          <div className="mb-2 flex items-baseline gap-3">
            <h2 className="font-mono text-[length:var(--t-xs)] tracking-widest text-ink-2">{title.toUpperCase()}</h2>
            {note && <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">{note}</span>}
          </div>
        )}

        <div className="relative">
          <div
            ref={scroller}
            onScroll={measure}
            className="rail step flex gap-2 overflow-x-auto sm:gap-3"
          >
            {loading
              ? Array.from({ length: skeletons }, (_, i) => (
                  <div key={i} className="shrink-0" style={{ width: slot }}>
                    <div className={`skeleton ${skeletonAspect} w-full`} />
                    <div className="skeleton mt-1.5 h-3 w-4/5" />
                  </div>
                ))
              : children}
          </div>

          {!loading && (
            <>
              <RailArrow side="left" onClick={() => nudge(-1)} enabled={reach.left} />
              <RailArrow side="right" onClick={() => nudge(1)} enabled={reach.right} />
            </>
          )}
        </div>
      </section>
    </RailTilePx.Provider>
  );
}

function RailArrow({
  side, onClick, enabled,
}: {
  side: 'left' | 'right';
  onClick: () => void;
  enabled: boolean;
}) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      aria-label={side === 'left' ? 'Scroll left' : 'Scroll right'}
      className={`pill absolute top-1/2 z-20 grid h-9 w-9 -translate-y-1/2 place-items-center border
                  border-rule bg-ground/95 text-ink-2 shadow-lg transition-opacity
                  hover:border-tally hover:text-tally disabled:pointer-events-none disabled:opacity-0
                  ${side === 'left' ? 'left-0 sm:left-1' : 'right-0 sm:right-1'}`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

/** Fixed-width slot in a rail — width fills ~5 across the strip. */
export function Tile({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  const tile = useRailTilePx();
  return (
    <div className="shrink-0" style={{ width: wide ? tile * 1.8 : tile }}>
      {children}
    </div>
  );
}
