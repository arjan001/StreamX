/**
 * Arrow keys that move focus, which is the whole of D-pad navigation.
 *
 * This app had none. Every control was reachable by Tab and by a cursor, and on a
 * television neither of those exists: the report was "I can't go down with arrows,
 * keeps in top menu", and it was exactly right. Chromium ships a spatial-navigation
 * implementation but it is behind a flag nobody's TV turns on, so arrow keys did
 * what they do on any web page — scrolled the document and left focus where it was.
 * Nothing was broken; nothing had ever been built.
 *
 * It also explains the OTHER report, the one that looked like a firmware bug. OK
 * "not clicking" on a TCL Google TV, so a mouse-cursor accessibility service was
 * installed to work around it: DPAD_CENTER activates THE FOCUSED ELEMENT, and when
 * nothing has focus there is nothing for it to activate. A pointer was being used
 * to substitute for focus that did not exist. With focus real, OK is a click again
 * and the cursor service can be uninstalled — which is what "should work without
 * mouse" was asking for.
 *
 * Two halves, deliberately:
 *
 *   `pickNext` is pure geometry over rectangles. Every rule worth arguing about
 *   lives there — whether Right may leave the row, how much misalignment is
 *   forgivable, what "beyond" means when two elements overlap — and it is tested
 *   with rectangles rather than with a browser, because the cases that matter are
 *   layouts nobody can reproduce by hand on a laptop.
 *
 *   The rest reads the DOM: which elements are candidates, which container the
 *   move is confined to, and where focus should land when a screen opens.
 */

export type Dir = 'up' | 'down' | 'left' | 'right';

/** Viewport coordinates, the shape `getBoundingClientRect` already gives. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Candidate<T> {
  ref: T;
  rect: Rect;
}

const HORIZONTAL = new Set<Dir>(['left', 'right']);

/**
 * How much a misaligned candidate is punished, per pixel of misalignment.
 *
 * 4 rather than 1: on a TV the right answer is nearly always the thing directly
 * below, even when something closer sits off to the side. A rail of posters and a
 * row of filter chips below it are the case that sets this number — with a low
 * weight, Down from poster 6 lands on chip 1 because chip 1 is a few pixels
 * nearer vertically, which reads as the focus jumping sideways for no reason.
 */
const SKEW = 4;

function centre(r: Rect): { x: number; y: number } {
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}

/** Overlap of two 1-D spans, negative when they are apart (by that much). */
function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.min(a2, b2) - Math.max(a1, b1);
}

/**
 * The element an arrow press should move to, or null to stay put.
 *
 * The rules, in the order they matter:
 *
 * 1. A candidate must START beyond the origin's midline in the direction of
 *    travel. Midline rather than edge because a tile and its caption overlap, and
 *    a row of different-height cards would otherwise be unable to move at all.
 * 2. A horizontal move may not leave the row: Right from the last poster in a rail
 *    must do nothing, not dive into the rail below and to the right. A VERTICAL
 *    move may leave its column — that is the point of Down — but it strongly
 *    prefers not to: anything overlapping the origin's own column wins outright,
 *    and something off to the side is taken only when the column below is empty.
 *    SKEW alone was not enough for this. It is a per-pixel fine, so a candidate far
 *    enough down could still out-price one directly below, and the symptom was a
 *    press of DOWN leaping from a header icon on the right of the screen to a
 *    channel row 570px away on the left — "sometimes navigation jumps from one
 *    area to another".
 * 3. Distance is measured along the axis of travel, plus misalignment × SKEW.
 * 4. Ties break on document order, so two equally-good answers resolve the way the
 *    page reads.
 */
export function pickNext<T>(dir: Dir, from: Rect, cands: Candidate<T>[]): T | null {
  const horizontal = HORIZONTAL.has(dir);
  const mid = centre(from);
  let best: T | null = null;
  let bestScore = Infinity;
  /* Vertical only: the best candidate that does NOT share the origin's column,
     used when nothing in the column will have it. */
  let aside: T | null = null;
  let asideScore = Infinity;
  /*
   * Horizontal only: the best candidate that does NOT share the origin's row.
   *
   * The mirror of `aside`, and it was missing — which made rule 2 a hard refusal
   * sideways where rule 2's own wording says "prefers not to" vertically. So a
   * control alone on its line could not be reached by LEFT or RIGHT from
   * anywhere, however close it was, and the press simply did nothing.
   *
   * Reported as "the navigation i think should always check nearest area to
   * them... if nothing is there it wont move to the action around it", with a
   * reproduction attached: "i cannot select debug mode bcs of it". The DEBUG
   * button is `fixed` in the bottom-right corner (see components/DebugPanel),
   * so nothing shares its row and nothing shares its column — under the old
   * rules it was unreachable by any arrow, from anywhere.
   *
   * Still a LAST resort, which is what keeps rule 2's real purpose intact:
   * anything in the row wins outright, so RIGHT along a rail of posters still
   * walks the rail and never leaves it while there is more rail to walk.
   */
  let loose: T | null = null;
  let looseScore = Infinity;

  for (const c of cands) {
    const r = c.rect;
    // 1. beyond the midline
    const beyond =
      dir === 'down' ? r.top >= mid.y
        : dir === 'up' ? r.bottom <= mid.y
          : dir === 'right' ? r.left >= mid.x
            : r.right <= mid.x;
    if (!beyond) continue;

    const cross = horizontal
      ? overlap(from.top, from.bottom, r.top, r.bottom)
      : overlap(from.left, from.right, r.left, r.right);

    const gap = dir === 'down' ? r.top - from.bottom
      : dir === 'up' ? from.top - r.bottom
        : dir === 'right' ? r.left - from.right
          : from.left - r.right;

    // 3. along the axis, plus what it costs to be off to one side
    const skew = cross > 0 ? 0 : -cross;
    const score = Math.max(0, gap) + skew * SKEW;

    /* 2. Out of the line of travel is a last resort, not a cheaper option — in
       BOTH axes now. See `loose` above for why horizontal used to refuse
       outright instead. */
    if (cross <= 0) {
      if (horizontal) {
        /*
         * And only if it is genuinely THAT WAY.
         *
         * Measured on the rail case this rule exists to protect (and pinned in
         * `spatialNav.test.ts`): the origin is a 100x40 poster at x=900, and the
         * first tile of the next rail sits at (1000, 200). Pressing RIGHT, its
         * gap along x is 0 while it misses the row by 160px — it is not to the
         * right of anything, it is below it, and RIGHT must not go there because
         * that is what DOWN is for.
         *
         * So the last resort asks the honest question: is this further along the
         * axis I pressed than it is off to one side? A control sitting beside a
         * row it does not overlap passes; the rail below does not.
         */
        if (Math.max(0, gap) >= skew) {
          if (score < looseScore) { looseScore = score; loose = c.ref; }
        }
      } else if (score < asideScore) {
        asideScore = score;
        aside = c.ref;
      }
      continue;
    }

    if (score < bestScore) {
      bestScore = score;
      best = c.ref;
    }
  }
  return best ?? aside ?? loose;
}

/* ── the DOM half ─────────────────────────────────────────────────────────── */

/**
 * What counts as somewhere focus can go.
 *
 * `[tabindex="-1"]` is excluded on purpose: it means "focusable by script, not by
 * navigation", which is what a scroll container or a dialog body is.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[data-nav-item]',
].join(',');

/* ── one press, one measurement ───────────────────────────────────────────── */

/**
 * Measure each element once per press, not five times.
 *
 * A single arrow press does not ask the DOM one question. `move` searches the
 * nearest container, then the next one out, then the document; finding nothing it
 * runs that whole walk a second time with the doorways put back. Every one of
 * those passes calls `itemsIn`, and `itemsIn` measures every focusable thing in
 * its scope — so the same poster is measured by the grid's pass, again by the
 * page's pass, and again by both doorway passes. Each of those measurements has
 * to give the same answer, because nothing between them has moved anything.
 *
 * Measured on /movies at 960x540 with the CPU throttled four times, which is
 * roughly a television: **1,569 calls to `getBoundingClientRect` per press** for
 * 318 focusable elements — 22ms — plus 3,250 calls to `closest`. Four fifths of
 * that is the same question asked again. With one pass it is 218 rects, 2.6ms
 * and 419 walks, and press-to-paint on that grid went from 80ms to 30ms, which
 * is the same ground the Live screen was already on.
 *
 * So a pass is opened around a SEARCH and closed before anything acts on the
 * answer. That boundary is the whole safety argument, and it is the reason this
 * cannot put the highlight in the wrong place: a search is pure reading — no
 * focus moves, no scroller is touched, no class is set — so a remembered
 * rectangle and a fresh one are the same rectangle by construction. The moment
 * focus lands, `focusOn` pulls the keyline and every rectangle on the screen
 * changes; that happens after the pass has been thrown away.
 *
 * Nothing is remembered BETWEEN presses, deliberately, and it is worth writing
 * down why since it looks like the obvious next step: the keyline scrolls the
 * list under the highlight on EVERY move, so a rectangle kept from the last press
 * is wrong by exactly the distance the list travelled, and focus would drift a
 * row in the direction of travel. Surviving a scroll is a different feature with
 * a different risk; this one has none.
 */
interface Pass {
  rects: Map<Element, DOMRect>;
  seen: Map<Element, boolean>;
  raw: Map<ParentNode, { el: HTMLElement; rect: DOMRect }[]>;
  kept: Map<ParentNode, { el: HTMLElement; rect: DOMRect }[]>;
  section: Map<Element, HTMLElement | null>;
  /** Whether the page holds any `[inert]` or `[data-nav-skip]` at all. */
  marks: { inert: boolean; skip: boolean } | null;
}

let pass: Pass | null = null;

/**
 * Run one search with one measurement per element.
 *
 * Re-entrant: `move` can reach `focusFirst`, and an inner search then shares the
 * outer pass rather than opening a second one. The previous value is RESTORED
 * rather than cleared on the way out, so neither nesting nor an exception can
 * leave a stale pass open for the next press to read from.
 */
function survey<T>(read: () => T): T {
  const outer = pass;
  if (outer === null) {
    pass = {
      rects: new Map(), seen: new Map(), raw: new Map(),
      kept: new Map(), section: new Map(), marks: null,
    };
  }
  try {
    return read();
  } finally {
    pass = outer;
  }
}

/** A rectangle, measured at most once per pass. Outside a pass, always fresh. */
function rectOf(el: Element): DOMRect {
  const p = pass;
  if (p === null) return el.getBoundingClientRect();
  const got = p.rects.get(el);
  if (got !== undefined) return got;
  const rect = el.getBoundingClientRect();
  p.rects.set(el, rect);
  return rect;
}

/**
 * `closest(CONTAINERS)`, remembered per pass.
 *
 * `sectionRect` asks this of every candidate on every escalating press, and the
 * answer is an ancestor walk — the largest single share of those 3,250 `closest`
 * calls.
 */
function closestContainer(el: Element | null): HTMLElement | null {
  if (el === null) return null;
  const p = pass;
  if (p === null) return el.closest<HTMLElement>(CONTAINERS);
  const got = p.section.get(el);
  if (got !== undefined) return got;
  const found = el.closest<HTMLElement>(CONTAINERS);
  p.section.set(el, found);
  return found;
}

/**
 * Is there anything on this page that needs an ancestor walk to rule out?
 *
 * `[inert]` and `[data-nav-skip]` are rare and usually absent entirely, and
 * `visible` was walking every candidate's ancestors to discover that, once per
 * candidate per pass. One query answers it for every candidate at once — the same
 * trick `itemsIn` already used for `inert` alone, moved somewhere both can use it.
 */
function marksOn(doc: Document): { inert: boolean; skip: boolean } {
  const p = pass;
  if (p !== null && p.marks !== null) return p.marks;
  const marks = {
    inert: doc.querySelector('[inert]') !== null,
    skip: doc.querySelector('[data-nav-skip]') !== null,
  };
  if (p !== null) p.marks = marks;
  return marks;
}

/**
 * Is this somewhere focus can go? Asked once per element per pass.
 *
 * The verdict is style, not geometry, and the four passes of a single press ask
 * it of the same elements — `getComputedStyle` and `checkVisibility` each time.
 */
function visible(el: HTMLElement, rect: DOMRect, fading = false): boolean {
  /* `fading` is one declared entry point asked once; it never wants a cache, and
     sharing a key with the ordinary verdict would let one answer the other. */
  if (fading) return visibleNow(el, rect, true);
  const p = pass;
  if (p === null) return visibleNow(el, rect, false);
  const got = p.seen.get(el);
  if (got !== undefined) return got;
  const verdict = visibleNow(el, rect, false);
  p.seen.set(el, verdict);
  return verdict;
}

function visibleNow(el: HTMLElement, rect: DOMRect, fading: boolean): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  /*
   * `tabindex="-1"` means "focusable by script, not by navigation" — and this is
   * navigation. `FOCUSABLE` says it excludes them and only half does: the
   * `[tabindex]` clause is filtered, but a `<button tabindex="-1">` still matches
   * `button:not([disabled])`, so every one of them was a candidate.
   *
   * The case that found it: the player's centre cluster — five transport buttons
   * over the picture, given `tabIndex -1` on a remote on purpose, because a focus
   * stop in the middle of a picture is not where a D-pad should walk. Measured on
   * the series screen, one press of RIGHT out of the episode list landed on the
   * cluster's Previous rather than on the control bar's play/pause, so the two
   * ways into the player disagreed about where its door was.
   */
  if (el.getAttribute('tabindex') === '-1') return false;
  /* Two of these three are ancestor walks for markers that are usually nowhere on
     the page at all; `marksOn` asks that once and lets every candidate skip them.
     `aria-hidden` has no such shortcut — decorative icons carry it all over the
     app — so it stays a walk, paid once per element per press. */
  const marks = marksOn(el.ownerDocument);
  if (marks.inert && (el.hasAttribute('inert') || el.closest('[inert]') !== null)) return false;
  if (el.closest('[aria-hidden="true"]') !== null) return false;
  if (marks.skip && el.closest('[data-nav-skip]') !== null) return false;

  const st = getComputedStyle(el);
  // `visibility` and `opacity:0` hide a control while leaving it in the layout —
  // a reveal-on-hover button is the case, and focusing an invisible thing is how
  // a D-pad ends up somewhere with no focus ring at all.
  if (st.visibility === 'hidden' || st.display === 'none') return false;
  /*
    `fading` is the exception, and it exists for exactly one caller — the DECLARED
    entry point in `focusFirst`. See the comment there; the rule is that a screen
    which has said where to start is not overruled by its own entrance animation.
  */
  if (!fading && st.opacity === '0') return false;

  /*
    The ANCESTOR case, which is the one that bites.

    Opacity does not inherit, so a control inside a faded-out container reports
    `opacity: 1` and looked perfectly focusable. The player's control bar hides
    itself exactly that way — `opacity-0 pointer-events-none` on the bar, nothing
    on the buttons — so a D-pad could put its focus ring on an invisible play
    button, and OK would press it. That is the same symptom as focus disappearing
    and a different cause.

    `pointer-events` DOES inherit, so one read of the element's own computed value
    answers for every ancestor, and it states the right rule anyway: something a
    cursor cannot click is not somewhere a remote should land.

    `checkVisibility` closes the remaining gap (a faded ancestor that still takes
    pointer events) in a single native call. Chromium 105+, so it is absent on
    exactly the old TV WebViews this app cares about — hence the line above rather
    than instead of it.
  */
  if (st.pointerEvents === 'none') return false;
  const check = (el as unknown as {
    checkVisibility?: (o: { opacityProperty: boolean; visibilityProperty: boolean }) => boolean;
  }).checkVisibility;
  /* `opacityProperty` is the only test `fading` drops. `visibilityProperty` still
     runs, and `checkVisibility` still answers for `display:none` and
     `content-visibility:hidden` anywhere up the tree, so a genuinely hidden
     subtree is still refused — and `pointer-events` above already refused the
     deliberately-faded kind. */
  if (typeof check === 'function'
    && !check.call(el, { opacityProperty: !fading, visibilityProperty: true })) return false;
  return true;
}

/**
 * Containers, and how hard their walls are.
 *
 * This is the part that was wrong, and it was wrong in a way worth writing down.
 * I had exactly two levels — the page, then the document — and applied the
 * "contained" marker to four components. The app has fourteen overlays. So a
 * settings panel, a filter dropdown, a profile sheet, the player's own subtitle
 * panel: press Down enough times in any of them and focus walked out onto the
 * page behind, which is precisely what was reported.
 *
 * The two established implementations both model this the same way, and neither
 * of them treats it as a per-component decision:
 *
 *   * `js-spatial-navigation` gives every SECTION a `restrict` of `self-only`
 *     (a modal: focus cannot leave), `self-first` (prefer inside, then look
 *     outside) or `none`.
 *   * Norigin recurses up the parent tree looking for a sibling, and stops when a
 *     parent declares `isFocusBoundary`.
 *
 * So the model here is theirs, expressed over the DOM rather than a registry —
 * which is the one deliberate difference, because the registry is what cannot be
 * told about a virtualised row that mounted a frame ago:
 *
 *   `data-nav-contain`  a boundary. Focus cannot leave. Every overlay.
 *   `data-nav-scope`    a section. Prefer inside, then escalate. The page, the player.
 *
 * Escalation walks the ancestor chain, nearest container first, and stops dead at
 * the first boundary. Nesting therefore composes: a soft section inside a sheet is
 * searched first, the sheet second, and the page behind it never.
 */
const CONTAINERS = '[data-nav-contain],[data-nav-scope]';

function isBoundary(el: HTMLElement): boolean {
  return el.hasAttribute('data-nav-contain');
}

/**
 * The overlay on top, if there is one.
 *
 * Last in the DOM wins: later means painted on top, and the topmost overlay is
 * the one being used. It is consulted before anything else because an overlay can
 * be open while focus is still outside it — the press that opened it left focus on
 * the button, or a re-render dropped it — and in that state the correct answer to
 * any arrow key is "get into the overlay", not "move around the page underneath".
 */
function topBoundary(): HTMLElement | null {
  // The registry is testable without a browser, and `dispatch` asks this on every
  // press — so the question has an answer with no DOM: nothing is open.
  if (typeof document === 'undefined') return null;
  const all = document.querySelectorAll<HTMLElement>('[data-nav-contain]');
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i]!;
    const r = rectOf(el);
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/** Is an overlay on screen? The legend and the key registry both need to know. */
export function boundaryOpen(): boolean {
  return topBoundary() !== null;
}

/** The containers enclosing an element, nearest first. */
function chainOf(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  let node = closestContainer(el);
  while (node !== null) {
    out.push(node);
    if (isBoundary(node)) break;
    node = closestContainer(node.parentElement);
  }
  return out;
}

/**
 * Everything focus could go to in `scope` — minus the doorways.
 *
 * ── why a focusable container must not be a candidate ──
 *
 * Several surfaces are focusable AND full of focusable things: the featured
 * carousel (it owns Left and Right for changing slide), the player shell (landing
 * on it wakes the controls), the player column on Live (it is how RIGHT out of
 * the channel list reaches the picture). Each one's rectangle ENCLOSES the
 * buttons inside it, so by every geometric measure the container is at least as
 * good a target as its own contents — and being first in DOM order it kept
 * winning. Reported as "sometimes it selects the player window instead of the
 * buttons and actions, and the same for the home hero section — it selects
 * windows a lot instead of the item properly".
 *
 * A container like that is a DOORWAY: somewhere to arrive when there is nothing
 * better inside, never a destination while there is. So a candidate that contains
 * another candidate is dropped — and the "another candidate" test is the one that
 * makes this safe, because it is about what is REACHABLE, not what exists. The
 * player's controls fade to `opacity-0 pointer-events-none` when the chrome
 * sleeps; `visible()` rejects them, the shell contains no candidate, and the
 * shell is offered again. Which is exactly right: with the controls asleep, the
 * shell IS the only thing there.
 *
 * Walking each candidate's ancestors rather than comparing every pair keeps this
 * O(n · depth) instead of O(n²) — this runs on every arrow press, on a list that
 * can hold a couple of hundred rows, on a box that has none to spare.
 */
function itemsIn(scope: ParentNode, keepDoorways = false): { el: HTMLElement; rect: DOMRect }[] {
  const p = pass;
  let raw = p?.raw.get(scope);
  if (raw === undefined) {
    raw = sweep(scope);
    p?.raw.set(scope, raw);
  }
  if (keepDoorways) return raw;
  /* The doorway walk is the SAME candidates with some of them removed, so the
     second pass of a press — the one that puts the doorways back — is a filter
     over a list that has already been measured, not another sweep of the DOM. */
  let kept = p?.kept.get(scope);
  if (kept === undefined) {
    kept = dropDoorways(raw, (el) => el.parentElement, scope instanceof HTMLElement ? scope : null);
    p?.kept.set(scope, kept);
  }
  return kept;
}

/** Every candidate in `scope`, measured. The part that actually touches the DOM. */
function sweep(scope: ParentNode): { el: HTMLElement; rect: DOMRect }[] {
  const out: { el: HTMLElement; rect: DOMRect }[] = [];
  const marks = marksOn(scope instanceof Element ? scope.ownerDocument : document);
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE))) {
    /* The attribute tests first: they are free, and a candidate they reject
       never needs its rectangle measured. */
    if (el.getAttribute('tabindex') === '-1') continue;
    if (marks.inert && (el.hasAttribute('inert') || el.closest('[inert]') !== null)) continue;
    const rect = rectOf(el);
    if (visible(el, rect)) out.push({ el, rect });
  }
  return out;
}

/**
 * Drop every candidate that contains another candidate. See `itemsIn`.
 *
 * Separated from the DOM so it can be tested against a tree of plain objects —
 * the rule is about containment, not about elements.
 */
export function dropDoorways<T, R>(
  items: readonly { el: T; rect: R }[],
  parentOf: (el: T) => T | null,
  stop: T | null,
): { el: T; rect: R }[] {
  if (items.length < 2) return [...items];
  const here = new Set(items.map((c) => c.el));
  const doorways = new Set<T>();
  for (const c of items) {
    let p = parentOf(c.el);
    while (p !== null && p !== stop) {
      if (here.has(p)) doorways.add(p);
      p = parentOf(p);
    }
  }
  return doorways.size === 0 ? [...items] : items.filter((c) => !doorways.has(c.el));
}

/**
 * Where focus was last time we were in this group.
 *
 * Only consulted for containers marked `data-nav-memory`, and only when arriving
 * from outside — a sidebar you left on "Netherlands" should still be on
 * "Netherlands" when you come back, while a poster rail should not second-guess
 * the geometry. Held as a live element reference rather than an index because the
 * lists here are virtualised and an index means nothing after a scroll.
 *
 * ── it cannot leak across a route, and that was measured ──
 *
 * The key is the group NAME and nothing else, so two screens DO share one entry:
 * `/movies` and `/series` are the same `Grid` and both mark their poster grid
 * `titles`. That looks like the cause of "when you open a movie it goes back to
 * the suggestions" and is not, for three reasons, each of them checked against
 * the running app rather than reasoned about:
 *
 *   * `memory` is read in exactly one place — `land`, which only `move` and
 *     `moveWithin` reach. Arriving on a screen goes through `focusFirst`, which
 *     never consults it. Memory cannot place arrival focus at all.
 *   * The element is the key's value, so a page that has gone takes its entry
 *     with it: `<main key={pathname}>` remounts on every route change (measured:
 *     26 focusables stamped on one film's page, 0 of them still connected on the
 *     next), and `kept.isConnected` then refuses it.
 *   * A rail is not a group. "MORE LIKE THIS" carries `data-nav-scope` and no
 *     `data-nav-group`, so `remember` never files a poster from it.
 *
 * The real cause was `focusFirst` skipping a mid-fade entry point; see there.
 */
const memory = new Map<string, HTMLElement>();

function groupOf(el: HTMLElement): { name: string; remembers: boolean } | null {
  const g = el.closest<HTMLElement>('[data-nav-group]');
  if (!g) return null;
  return { name: g.dataset['navGroup'] ?? '', remembers: g.hasAttribute('data-nav-memory') };
}

function remember(el: HTMLElement): void {
  const g = groupOf(el);
  if (g && g.remembers) memory.set(g.name, el);
}

/**
 * How far into the scroller a focused item is held, as a fraction of its height.
 *
 * Android TV's own default, and the number every ten-foot interface converges on.
 * The point is that the highlight STAYS PUT and the content moves under it, which
 * is the difference between reading a list and chasing one.
 */
const KEYLINE = 0.3;

/**
 * What to bring into view for this element: the picture it is in, or itself.
 *
 * A control inside the player keylines the PICTURE. The stage is one object the
 * viewer is already looking at, and the stage is also `overflow: hidden` with a
 * control bar that hangs a few pixels past its bottom edge — which makes it
 * scrollable to `scrollIntoView` and to nobody else. Revealing a button inside
 * it scrolls the picture's own insides, a few pixels per press, until the BACK
 * button at the top of it has gone.
 */
function inView(el: HTMLElement): HTMLElement {
  const stage = el.closest<HTMLElement>('.stage');
  return stage !== null && stage !== el ? stage : el;
}

/** One ancestor, as the question below needs to see it. */
export interface Layer {
  position: string;
  overflowY: string;
  overflowX: string;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
}

/** A box a viewer could actually scroll, as opposed to one that merely clips. */
function scrolls(l: Layer): boolean {
  const y = (l.overflowY === 'auto' || l.overflowY === 'scroll')
    && l.scrollHeight > l.clientHeight + 4;
  const x = (l.overflowX === 'auto' || l.overflowX === 'scroll')
    && l.scrollWidth > l.clientWidth + 4;
  return y || x;
}

/**
 * Is there anything that could actually scroll to bring this into view?
 *
 * ── the bug this replaces, and the bug that replacing it fixed ──
 *
 * The first version of this asked a blunter question — "is this inside a fixed
 * box?" — and refused to scroll if it was. That was written for a real fault:
 * in full screen the stage IS fixed, it is `overflow: hidden`, and its control
 * bar hangs a few pixels past its bottom edge, so `scrollHeight` exceeds
 * `clientHeight` and `scrollIntoView` scrolled a clipped box as happily as a
 * scrolling one. Every press bought a few more pixels until BACK had gone.
 *
 * But "fixed" and "nothing can scroll this" are not the same statement, and
 * reading one as the other broke every dropdown in the app:
 *
 *     when trying to change locale i canoot it doesn under it
 *
 * `Popover` portals to the body and is `position: fixed`, and `Select` gives it
 * `max-h-[min(20rem,60vh)] overflow-y-auto`. So the language list is a genuine
 * scroller that happens to be fixed. Focus moved down it correctly — and the
 * list never scrolled, so the highlight walked off the bottom edge and the
 * viewer saw a menu stuck on its first entry.
 *
 * So the question is the honest one: walking outward, is there a box that
 * genuinely scrolls? Scrollability is checked BEFORE fixedness on each layer,
 * because the fixed box is very often the scroller itself. A `fixed` ancestor
 * that does NOT scroll ends the walk — nothing behind it can move the element,
 * which is the full-screen stage exactly. Reaching the top without one means
 * the document itself is the scroller, which is the whole rest of the app.
 */
export function anythingCanScroll(chain: readonly Layer[]): boolean {
  for (const l of chain) {
    if (scrolls(l)) return true;
    if (l.position === 'fixed') return false;
  }
  return true;
}

/** The ancestor chain of `el`, measured. */
/**
 * `anythingCanScroll`, asked of the real DOM without measuring what it does
 * not need.
 *
 * ── the bug this shape exists for ──
 *
 *     i cannot move channel up/down anymore or left/right
 *
 * The first version built the WHOLE ancestor chain first — `getComputedStyle`
 * plus `scrollHeight`, `clientHeight`, `scrollWidth` and `clientWidth` on every
 * element between the focused row and the document — and only then looked at
 * it. Reading `scrollHeight` forces a synchronous layout. On a television, with
 * twenty-odd ancestors under a long channel list, that is twenty forced
 * reflows for every single press of the D-pad, and the remote stops answering.
 *
 * Same rule, evaluated lazily:
 *
 *   * it STOPS at the first element that can scroll, or the first fixed one —
 *     everything above that could never change the answer;
 *   * it only touches LAYOUT where the computed overflow says scrolling is
 *     possible at all, which is a handful of elements in this app rather than
 *     all of them. `overflow: visible` cannot scroll however much it holds, so
 *     its scrollHeight is not worth a reflow to learn.
 *
 * `anythingCanScroll` stays as the tested statement of the rule; this is the
 * same two questions in the same order, asked one element at a time.
 */
function reachable(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n !== null; n = n.parentElement) {
    const st = getComputedStyle(n);
    const mayY = st.overflowY === 'auto' || st.overflowY === 'scroll';
    const mayX = st.overflowX === 'auto' || st.overflowX === 'scroll';
    if (mayY || mayX) {
      const layer: Layer = {
        position: st.position,
        overflowY: st.overflowY,
        overflowX: st.overflowX,
        scrollHeight: mayY ? n.scrollHeight : 0,
        clientHeight: mayY ? n.clientHeight : 0,
        scrollWidth: mayX ? n.scrollWidth : 0,
        clientWidth: mayX ? n.clientWidth : 0,
      };
      /* One layer, and `anythingCanScroll` answers for exactly it: true when it
         scrolls, false when it is fixed and does not, and otherwise it falls
         off the end as "keep looking" — which is what continuing does. */
      if (scrolls(layer)) return true;
    }
    /* A fixed box that cannot scroll ends the walk: nothing behind it moves
       what is inside it. The full-screen stage, exactly. */
    if (st.position === 'fixed') return false;
  }
  return true;
}

/**
 * Focus an element and bring it into view the way a television does.
 *
 * `scrollIntoView({ block: 'nearest' })` scrolls the minimum distance to make the
 * element flush against whichever edge is closer. On a mouse that is polite. On a
 * D-pad it is the thing that makes this feel like a web page: the highlight walks
 * to the bottom of the list, sticks there, and then the whole view jerks up by one
 * row per press — and when you turn around it sticks to the top and jerks the
 * other way. Two different behaviours for the same key, decided by which half of
 * the list you happen to be in.
 *
 * A keyline is the fix. The focused row is held 30% of the way down its scroller
 * and the list slides beneath it, so a press moves the CONTENT rather than the
 * cursor, and the eye never has to find the highlight again. Near the ends there
 * is nothing left to slide, so it stops naturally — which is right, because the
 * top of a list should look like the top of a list.
 *
 * Kept instant. Smooth scrolling animates over several hundred milliseconds and a
 * remote sends presses faster than that; the animations queue and the list drifts
 * on after your thumb has stopped. Every TV platform that offers both defaults to
 * this for exactly that reason.
 */
function focusOn(el: HTMLElement, arrival = false): void {
  remember(el);
  el.focus({ preventScroll: true });
  /*
   * Arriving is not moving, and only moving wants the keyline.
   *
   * The keyline exists so a highlight walking down a list stands still while the
   * rows slide under it. On ARRIVAL there is no previous position to preserve —
   * nothing has moved yet — so pulling the first control 30% down its scroller
   * does not hold anything still, it just scrolls the page away from its own
   * top. Reported as "on movie or anything open, it starts from middle instead
   * of top", and it was every screen whose entry point sits inside a scroller:
   * the film page opens on PLAY, PLAY is in the hero, and the hero was dragged
   * up until the title was off the screen.
   *
   * `nearest` is the arrival rule: bring it into view if it is out of view, and
   * otherwise move nothing at all. The top of a page then looks like the top of
   * a page, which is the same principle the keyline's own comment claims for the
   * top of a list.
   */
  if (arrival) {
    /*
     * The same two rules as the keyline below, because this is the branch that
     * was actually running when the fault was measured: landing on the control
     * bar is an ARRIVAL, and it brought the button into view rather than the
     * picture — twenty-four pixels into the stage's own clipped overflow, with
     * BACK pushed from 0px to -16px.
     */
    const aim = inView(el);
    if (reachable(aim)) aim.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  keyline(el);
}

/**
 * Slide each scrollable ancestor so `el` sits on the keyline.
 *
 * Unconditionally, not only when the item has gone off the edge. That was the
 * first attempt and it is worth recording why it was wrong: correcting only at
 * the edges means the highlight walks freely down the middle of the list and then
 * lurches back to the keyline when it runs out of room — measured, it wandered
 * over 208 pixels of screen. Pulling on every move is what makes the highlight
 * stand still.
 *
 * The ends look after themselves: `scrollTop` clamps at 0 and at its maximum, so
 * the first rows sit above the keyline and the last rows below it, exactly as
 * they should — the top of a list has to look like the top of a list.
 */
function keyline(el: HTMLElement): void {
  /*
   * A control inside the picture keylines the PICTURE, not itself.
   *
   * The player's control bar sits at the bottom of the stage, so holding one of
   * its buttons 30% down the page pushes the picture off the top of the screen —
   * and on a film page what comes into view instead is the DETAILS panel below
   * it. Measured on /movie/2.2129873 at 1440x900: pressing PLAY revealed the
   * stage correctly (`scrollTop` 0 at t+0ms), and 675ms later `focusPlayerChrome`
   * landed on play/pause and the same scroller jumped to 398 with the video's top
   * edge at -345. Reported as "when i click on the player on the web, why does it
   * scroll me... i mean on click goes down to info", and it happened again on
   * every press that moved along the bar.
   *
   * The keyline is right for a list, where the highlight should stand still while
   * the rows move under it. It is wrong inside a picture, which is one object the
   * viewer is already looking at. So the stage takes the keyline — and because a
   * stage is usually taller than the keyline allows, the existing "align to the
   * top instead" rule below then means it is brought fully into view and left
   * alone, which is what it should have been doing all along.
   */
  const aim = inView(el);
  /*
   * A fixed box does not move when you scroll what is behind it.
   *
   * Which makes scrolling an ancestor to "bring it into view" not merely
   * useless but harmful: the distance never closes, so the same correction is
   * applied on every press and the page walks away underneath a picture that
   * has not moved at all. In fullscreen the stage IS fixed and IS the whole
   * viewport, so there is nothing to bring into view and everything to lose —
   * reported as "when its full screen, the buttons when navigated, scrolls a
   * bit and screen goes down, then back button disapesrs".
   *
   * So the walk stops at the first fixed thing between the target and the
   * document. Below it, scrolling still works and still should: a fixed pane
   * with a list inside it keylines that list normally.
   */
  let fixed = getComputedStyle(aim).position === 'fixed';
  let node = aim.parentElement;
  while (node !== null && !fixed) {
    const st = getComputedStyle(node);
    /* `fixed = true` and not merely `break`: an element INSIDE a fixed box does
       not move when the document scrolls either, so the last line's
       `scrollIntoView` would be the same useless, repeating correction. Setting
       only the flag for the aim itself left that half of the fault in place —
       the control bar is fixed, its buttons are not. */
    if (st.position === 'fixed') { fixed = true; break; }
    const scrollsY = (st.overflowY === 'auto' || st.overflowY === 'scroll')
      && node.scrollHeight > node.clientHeight + 4;
    const scrollsX = (st.overflowX === 'auto' || st.overflowX === 'scroll')
      && node.scrollWidth > node.clientWidth + 4;
    if (scrollsY || scrollsX) {
      /* Re-read: scrolling an inner container has already moved the element. */
      const box = aim.getBoundingClientRect();
      const view = node.getBoundingClientRect();
      if (scrollsY) {
        /* An item taller than the keyline allows is aligned to the top instead —
           a 300px hero pulled to 30% of a 400px pane would hang off the bottom. */
        const room = box.height > view.height * (1 - KEYLINE) ? 0 : view.height * KEYLINE;
        node.scrollTop += box.top - (view.top + room);
      }
      if (scrollsX) {
        const room = box.width > view.width * (1 - KEYLINE) ? 0 : view.width * KEYLINE;
        node.scrollLeft += box.left - (view.left + room);
      }
    }
    if (isBoundary(node)) break;
    node = node.parentElement;
  }
  /*
   * Whatever the keyline could not reach — a sticky header, a pane the walk
   * stopped short of — is still the browser's job, and `nearest` now has almost
   * nothing left to do. It moves nothing when the thing is already visible.
   *
   * On `aim` and not on `el`, which is the decision made at the top of this
   * function and then contradicted four lines from the end. "A control inside
   * the picture keylines the PICTURE, not itself" — and then the control was
   * the thing brought into view, which is not the same thing at all:
   *
   *     when its full screen, the buttons when navigated, scrolls a bit and
   *     screen goes down, then back button disapesrs
   *
   * Measured at 1440x900 on a playing film: BACK sat at the top of the picture
   * at 0px, and twelve presses along the control bar put it at -16px with a
   * scroller 24px down. The scroller was the STAGE. It is `overflow: hidden`,
   * so no viewer can scroll it and nothing looks scrollable — but its control
   * bar hangs a few pixels past its bottom edge, which makes `scrollHeight`
   * exceed `clientHeight`, and `scrollIntoView` scrolls a clipped box as
   * happily as a scrolling one. Every press bought another few pixels.
   *
   * Revealing the picture instead cannot do that: the stage is not inside
   * itself. Where there is no picture in the chain `aim` IS `el`, which is the
   * whole rest of the app, unchanged.
   *
   * Not when the thing is fixed, for the reason above: the document would
   * scroll and the element would stay exactly where it was.
   */
  if (reachable(aim)) aim.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * Scroll the nearest scrollable ancestor, when focus itself cannot move.
 *
 * The half of "nowhere to go" that was missing. A page can hold far more than it
 * holds CONTROLS — the download page is 1155px tall with six focusable things,
 * all of them in the top 460px — so once focus reached the last button, DOWN had
 * no candidate, `move` returned false, and nothing else scrolled either: the
 * remaining 600px of install instructions were unreachable. Measured exactly
 * that way, twenty-five presses of DOWN and `scrollTop` still 0. Reported as
 * "the download page is not scrollable".
 *
 * Vertical only. Sideways there is no equivalent expectation, and a horizontal
 * strip already scrolls itself when focus moves along it.
 *
 * The walk stops at a `data-nav-contain` boundary for the same reason focus does:
 * a press inside a sheet must not scroll the page behind it.
 */
function scrollFallback(from: HTMLElement | null, dir: Dir): boolean {
  if (dir !== 'up' && dir !== 'down') return false;
  let node: HTMLElement | null = from;
  while (node !== null) {
    const style = getComputedStyle(node);
    const scrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll')
      && node.scrollHeight > node.clientHeight + 4;
    if (scrollable) {
      const before = node.scrollTop;
      /* Most of a screenful, the way Page Down behaves — enough to feel like
         progress, short of losing your place. */
      const step = Math.max(120, Math.round(node.clientHeight * 0.7));
      node.scrollTop = dir === 'down' ? before + step : before - step;
      if (node.scrollTop !== before) return true;
    }
    if (isBoundary(node)) return false;
    node = node.parentElement;
  }
  return false;
}

/**
 * Move focus one step. Returns false when there is nowhere to go AND nothing
 * scrolled, so the caller can let the key do whatever it would have done.
 */
export function move(dir: Dir): boolean {
  const active = document.activeElement as HTMLElement | null;

  // An overlay is open and focus is not in it: the only correct move is inwards.
  const top = topBoundary();
  if (top !== null && (active === null || !top.contains(active))) return focusFirst(top);

  if (active === null || active === document.body) return focusFirst();

  /* A column moves by counting, not by measuring — see `columnStep`. */
  if (dir === 'up' || dir === 'down') {
    const next = columnStep(active, dir);
    if (next !== null) return land(next, active, dir);
  }

  const from = active.getBoundingClientRect();
  /*
    Sideways off the player's picture surface means OUT of the player.

    The surface is a doorway — focusable, and holding the control bar — and focus
    rests on it once the controls fade. Its buttons sit inside its rectangle, so
    by geometry Play/Pause is "to the left" of the surface's centre, and LEFT
    dived into the bar instead of leaving: measured on /live, two presses to get
    back to the list, every time the controls had faded. Up, Down and OK still
    step into the bar (the player's own doorway rule); LEFT and RIGHT leave.
  */
  const sideways = HORIZONTAL.has(dir) && active.classList.contains('stage');
  /*
    `leaving` is the section this press has already escalated out of, and it is
    what stops a move falling sideways into the column next door. Null on the
    first pass — a move INSIDE a section is unrestricted.
  */
  /*
    Two passes, and the second one is what makes a sparse pane reachable.

    A DOORWAY — a focusable surface that is full of focusable things — is normally
    dropped, because while there is something inside it the container is never
    what you meant. But "inside it" and "reachable from here" are different
    questions, and answering only the first one produced a dead key that is half
    of "I cannot navigate anywhere any more".

    Measured on /live: focus on a channel row at y=101, the player pane beside it
    at x=518 holding exactly one control — RETRY, at y=237. The pane itself is a
    legitimate target level with the row, but it was dropped for containing RETRY;
    RETRY is then refused by the row rule, correctly, because it is 136px below
    the row and a sideways press is level by construction. Nothing left. RIGHT
    did nothing, and the picture could not be reached from the list at all.

    The same shape occurs whenever a pane's controls are clustered away from the
    press — a control bar along the bottom of the player, a footer in a sheet.

    So doorways are a FALLBACK rather than an exclusion: search without them
    first, so a reachable control always beats the surface holding it, and only if
    that finds nothing offer the surfaces themselves. Landing on the player shell
    wakes its chrome and hands focus to the first control, which is the behaviour
    the doorway existed for.

    An ancestor of the element with focus is never offered: that is not a move.
  */
  const look = (
    where: ParentNode, leaving: HTMLElement | null, keepDoorways: boolean,
  ): HTMLElement | null => {
    let cands = itemsIn(where, keepDoorways)
      .filter((c) => c.el !== active && !c.el.contains(active)
        && !(sideways && c.el !== active && active.contains(c.el)));
    if (leaving !== null) {
      const gone = rectOf(leaving);
      cands = cands.filter((c) => clearsSection(dir, gone, sectionRect(c.el, leaving)));
    }
    return pickNext(dir, from, cands.map((c) => ({ ref: c.el, rect: c.rect })));
  };

  /*
    Nearest container outwards, stopping at the first boundary — Norigin's
    recursion, and the reason a press inside a sheet can never reach the page.
  */
  const walk = (keepDoorways: boolean): HTMLElement | null | false => {
    let leaving: HTMLElement | null = null;
    for (const container of chainOf(active)) {
      const found = look(container, leaving, keepDoorways);
      if (found !== null) return found;
      /* A boundary ends the search — and ends it for BOTH passes. */
      if (isBoundary(container)) return false;
      leaving = container;
    }
    return look(document, leaving, keepDoorways);
  };

  /*
    The whole search runs inside ONE pass over the DOM, and landing happens
    outside it. See `survey`: a search only reads, so measuring an element once
    and reusing that measurement across the walks cannot change the answer —
    while `focusOn` pulls the keyline, which moves every rectangle on the screen,
    so nothing measured before it may outlive it.
  */
  const found = survey((): HTMLElement | null => {
    const first = walk(false);
    if (first !== null && first !== false) return first;
    /*
    Nothing reachable — so now offer the doorways this walk refused.

    A doorway is a focusable surface full of focusable things: the player shell,
    the featured carousel, the player column on Live. `itemsIn` drops them,
    because while there is something inside one the container is never what you
    meant — that rule is what stopped "it selects the player window instead of the
    buttons". But "inside it" and "reachable from here" are different questions,
    and answering only the first left a sparse pane with no way in.

    Measured on /live: focus on a channel row at y=101, the player beside it at
    x=518 holding exactly one control — RETRY, at y=237. The pane is a legitimate
    target level with the row and was dropped for containing RETRY; RETRY is then
    refused by the row rule, correctly, since a sideways press is level by
    construction and RETRY is 136px below. Nothing left, RIGHT did nothing, and
    the picture could not be reached from the list at all. The same shape occurs
    for any pane whose controls cluster away from the press — a control bar along
    the bottom of the player, a footer in a sheet.

    Running it as a SECOND WHOLE WALK rather than per container is what keeps the
    original rule intact: a real control anywhere the first walk could reach still
    beats every doorway, and a doorway is only ever a last resort before giving up.
  */
    if (first === null) {
      const door = walk(true);
      if (door !== null && door !== false) return door;
    }
    return null;
  });
  if (found !== null) return land(found, active, dir);
  /* No control that way — but there may still be PAGE that way. */
  return scrollFallback(active, dir);
}

/**
 * Up and down in a plain column: the next row, found by counting.
 *
 * Measured on the TV emulator, six presses in the country rail: 3,600 forced
 * style-and-layout checks, about 600 a press. The general search measures
 * every candidate on the page, the rail's two hundred rows among them — and a
 * rail row under `content-visibility: auto` that is off screen has to be LAID
 * OUT to be measured, which is the very work that property exists to skip.
 * All of it to learn what the markup already says: in a list of rows, the row
 * below is the next one.
 *
 * So a container marked `data-nav-column` (the side rails, the channel list)
 * answers up and down from document order: the next `.pick-row` whose own
 * control can take focus. Headings, hidden rows and disabled rows are passed
 * over. Only from a row's own control — anywhere else in a row, and at either
 * end of the column, it returns null and the geometric search decides, which
 * is what carries UP from the first row to the search box and the header.
 */
function columnStep(active: HTMLElement, dir: 'up' | 'down'): HTMLElement | null {
  const column = active.closest<HTMLElement>('[data-nav-column]');
  if (column === null) return null;
  const row = active.closest<HTMLElement>('.pick-row');
  if (row === null || !column.contains(row) || rowControl(row) !== active) return null;
  const rows = Array.from(column.querySelectorAll<HTMLElement>('.pick-row'));
  const at = rows.indexOf(row);
  if (at < 0) return null;
  const step = dir === 'down' ? 1 : -1;
  for (let i = at + step; i >= 0 && i < rows.length; i += step) {
    const next = rowControl(rows[i]!);
    if (next === null || next.getAttribute('tabindex') === '-1') continue;
    if ((next as HTMLButtonElement).disabled === true) continue;
    if (next.closest('[data-nav-skip],[inert]') !== null) continue;
    /* Not rendered at all (a collapsed group, `hidden`). One element, not six
       hundred — and a row skipped by `content-visibility` still has boxes. */
    if (next.getClientRects().length === 0) continue;
    return next;
  }
  return null;
}

/** A row's own control: the row itself when it is one, else the first inside it. */
function rowControl(row: HTMLElement): HTMLElement | null {
  return row.matches(FOCUSABLE) ? row : row.querySelector<HTMLElement>(FOCUSABLE);
}

/**
 * The box a candidate belongs to, for the purpose of "have we left the section".
 *
 * A candidate is judged by its SECTION, not by itself. That is the whole trick:
 * the first row of the country rail sits above the channel list's first row, so
 * by its own rectangle it is a legitimate target for UP — but the rail as a whole
 * runs the full height of the screen beside the list, and a section that stands
 * beside you is never what UP means.
 */
function sectionRect(el: HTMLElement, notThis: HTMLElement): DOMRect {
  let sec = closestContainer(el);
  /* Skip the section being left: a candidate inside it was already considered. */
  while (sec !== null && sec === notThis) {
    sec = closestContainer(sec.parentElement);
  }
  return rectOf(sec ?? el);
}

/**
 * Move focus one step, but only within one container.
 *
 * The escape hatch for a two-column screen. `move` deliberately escalates
 * outwards when a container has nothing in the pressed direction — that is what
 * makes Down at the end of a rail carry on to the next one — and on a settings
 * screen with a section list beside an open section, escalating is exactly the
 * wrong answer: Down at the bottom of the pane jumps into the middle of the
 * sidebar, which is the "it suddenly goes from one menu to another" complaint.
 *
 * So a screen that owns two columns asks for a move inside the column that has
 * focus, and decides for itself what "nowhere to go" means — usually nothing at
 * all sideways, and a hand-off to the other column on the axis that joins them.
 * Returns false when the container has nothing in that direction.
 */
export function moveWithin(dir: Dir, scope: HTMLElement): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active === null || !scope.contains(active)) return false;
  const from = active.getBoundingClientRect();
  const found = survey(() => {
    const cands = itemsIn(scope).filter((c) => c.el !== active);
    return pickNext(dir, from, cands.map((c) => ({ ref: c.el, rect: c.rect })));
  });
  return found === null ? false : land(found, active, dir);
}

/**
 * Having left a section, a move may only land BEYOND it.
 *
 * ── the bug this is ──
 *
 * Measured on the Live screen: from the last country in the rail, one press of
 * DOWN moved 224 pixels to the RIGHT into the channel list; from the first
 * channel, one press of UP moved 224 pixels LEFT into the rail. Reported as "I
 * go to one menu and it jumps to another area I'm not in — nothing is separated
 * properly", and it is the same fault in both directions.
 *
 * The cause is that escalation was unrestricted. `move` searches the nearest
 * section, then the next one out, and so on — which is right, and is what
 * carries DOWN from the end of one poster rail to the rail beneath it. But the
 * wider search had no memory of what it had just left, so a vertical press that
 * ran out of room at the bottom of a column was free to satisfy itself with the
 * nearest thing anywhere, and the nearest thing is almost always the column
 * standing next to you.
 *
 * ── the rule ──
 *
 * Once a press has escalated out of a section, the thing it lands on must be
 * past that section's edge in the direction of travel. Down out of a column must
 * land below the column, not beside it. That single sentence separates every
 * screen in the app without a table of exceptions, and it keeps the behaviour
 * that made escalation worth having: rails are STACKED, so the next rail down is
 * genuinely below this one and is still reached.
 *
 * The slack is for the seam. Two sections that share a border report edges a
 * fraction of a pixel apart after scaling, and a rule that says "strictly
 * greater" turns that fraction into a dead key.
 */
export function clearsSection(dir: Dir, left: Rect, target: Rect): boolean {
  const SLACK = 4;
  switch (dir) {
    case 'down': return target.top >= left.bottom - SLACK;
    case 'up': return target.bottom <= left.top + SLACK;
    /*
     * Sideways, the section landed in must also stand BESIDE the one left —
     * share some of its height. Measured on /live with nothing playing: RIGHT
     * from the channel list found nothing in the empty player pane and settled
     * for the header's icons, which are to the right only in the sense that
     * they are above-right; LEFT from there then walked the header, and the
     * rail was out of reach ("I cannot go back to the sidebar"). Right means
     * right. The header is still reached by UP, which is the rule above.
     */
    case 'right': return target.left >= left.right - SLACK && besides(left, target);
    default: return target.right <= left.left + SLACK && besides(left, target);
  }
}

/** Do two sections share any height? (With the same seam slack.) */
function besides(a: Rect, b: Rect): boolean {
  return overlap(a.top, a.bottom, b.top, b.bottom) > 4;
}

/**
 * Focus a target, honouring a group that remembers where you were.
 *
 * Channels are the exception on a sideways press. Measured on /live: RIGHT out
 * of the country rail used to land on the first channel every time because
 * `navGroup="channels"` remembered it and beat geometry. A horizontal move into
 * the channel list must stay level — rule 2 in `pickNext` already picked the
 * overlapping row.
 *
 * LEFT back into the country rail is the opposite problem: level geometry lands
 * on Favourites / All countries when the channel under focus is near the top of
 * the list, even though the selected country (Algemeen, Netherlands, …) is
 * mid-rail. That rail remembers; restore it. If memory is empty, the `.is-on`
 * row is the selection the list is already showing.
 */
function land(target: HTMLElement, from: HTMLElement, dir: Dir): boolean {
  /*
   * A row of controls entered from the side starts at its beginning.
   *
   * The player's bar sits under the picture, lower than the channel row RIGHT
   * is pressed from, so by geometry its first button (Play/Pause) is more
   * "below" than "right" and the press settled on whichever button is far
   * enough along to count as right — "Next channel", fourth in the row, which
   * then took four presses of LEFT to get back out of. A container marked
   * `data-nav-entry-first` is entered at its first control instead.
   */
  const entry = HORIZONTAL.has(dir) ? target.closest<HTMLElement>('[data-nav-entry-first]') : null;
  if (entry !== null && !entry.contains(from)) {
    const first = startIn(entry);
    if (first !== null && first !== target) { focusOn(first); return true; }
  }
  /*
   * UP into the tab row lands on the tab you are in. By geometry it lands on
   * whichever tab is nearest above the control pressed from — from the
   * preview's Play button that was Movies, two tabs along, skipping Live TV
   * that the screen belongs to.
   */
  if (dir === 'up') {
    const tabs = target.closest('.app-tabs');
    const current = tabs !== null && !tabs.contains(from) ? tabs.querySelector<HTMLElement>('.is-on') : null;
    if (current !== null && current.isConnected && current.matches(FOCUSABLE)
      && visible(current, current.getBoundingClientRect())) {
      focusOn(current);
      return true;
    }
  }
  const here = groupOf(from);
  const there = groupOf(target);
  const intoChannels = there?.name === 'channels';
  /*
   * LEFT back into the channel list, from the player beside it: the channel
   * that is PLAYING, not whichever row happens to be level with the button
   * focus left from. Measured on /live: LEFT from Play/Pause landed on
   * "24H TVE", four rows under "La 1" that was on screen — back out of the
   * picture meant losing your place. RIGHT from the rail stays level (the
   * rule below), because there the rows beside you are the ones you meant.
   */
  if (intoChannels && dir === 'left' && here?.name !== 'channels') {
    const group = target.closest('[data-nav-group]');
    const playing = group?.querySelector<HTMLElement>('.is-on');
    if (playing && playing.isConnected && playing.matches(FOCUSABLE)
      && visible(playing, playing.getBoundingClientRect())) {
      focusOn(playing);
      return true;
    }
  }
  const restore = there !== null && there.remembers && there.name !== here?.name
    && (!HORIZONTAL.has(dir) || !intoChannels);
  if (restore) {
    const group = target.closest('[data-nav-group]');
    const kept = memory.get(there.name);
    if (kept && kept.isConnected
      && visible(kept, kept.getBoundingClientRect())
      && kept.closest('[data-nav-group]') === group) {
      focusOn(kept);
      return true;
    }
    const on = group?.querySelector<HTMLElement>('.is-on');
    const preferred = on === null || on === undefined
      ? null
      : (on.matches(FOCUSABLE) ? on : on.querySelector<HTMLElement>(FOCUSABLE));
    if (preferred && preferred.isConnected
      && visible(preferred, preferred.getBoundingClientRect())) {
      focusOn(preferred);
      return true;
    }
  }
  focusOn(target);
  return true;
}

/**
 * Put focus somewhere sensible, which a D-pad screen cannot do without.
 *
 * With nothing focused, every arrow press and every OK press does nothing — the
 * app looks frozen. So this runs when a route opens and whenever a key arrives
 * with focus on `<body>`. `data-nav-first` is the opt-in for "start here"; the
 * fallback is the first candidate in reading order, which is the wordmark, and
 * that is a fine place to be lost.
 */
export function focusFirst(scope: ParentNode = topBoundary() ?? document): boolean {
  /* Decided inside one pass, acted on outside it — the rule `move` states, for
     the same reason: `focusOn` scrolls, and nothing measured before a scroll may
     be read after one. */
  const start = survey(() => startIn(scope));
  if (start === null) return false;
  focusOn(start, true);
  return true;
}

/** Where a screen starts. A decision and nothing else — this moves no focus. */
function startIn(scope: ParentNode): HTMLElement | null {
  /* Inside an overlay, only the overlay's own entry point counts. Falling back to
     a document-wide `data-nav-first` here would put focus behind the thing that is
     open — the containment bug in miniature. */
  const first = (scope as Element).querySelector?.<HTMLElement>('[data-nav-first]')
    ?? (scope === document ? document.querySelector<HTMLElement>('[data-nav-first]') : null);
  if (first) {
    const r = rectOf(first);
    /*
      Mid-fade counts as present — and this is the whole of "it opens on the
      suggestions".

      Reported as "it even saves the state in a page where the cursor was last
      time, so when you open a movie or series it goes back to that area like
      suggestions", which reads like the group memory below restoring a position
      across a route change. It is not. Measured, at 15ms, on a cold
      `/movie/2.2038450` and again opening one title from another's rail:

        481ms  navFirst=BUTTON vis=false  own{opacity=1} anims=[]
               faded=[SECTION.no-round anim-fade …{opacity=0}]
               active=A[The Innocents] sec=MORE LIKE THIS
        568ms  navFirst=BUTTON vis=true   active=BUTTON[PLAY]

      The detail hero is `<section class="anim-fade">` and `.anim-fade` is
      `animation: fade-in .22s both` — `both` fills BACKWARDS, so the section
      reports `opacity: 0` from the moment it mounts until the animation actually
      starts ticking, which is why `anims` is empty while it is still invisible.
      PLAY's own opacity is 1 the whole time; it is the ancestor that is faded, so
      `checkVisibility` refused it — and this function then walked on and answered
      the question it falls back to, "what is topmost in reading order". The rail
      underneath has no entrance animation of its own, so during that window
      "MORE LIKE THIS" is the only OPAQUE content in `<main>`, and its first
      poster is the honest answer to the wrong question. There is no memory in
      that path at all: the rail carries no `data-nav-group`, and `memory` is read
      only by `land`, which only an arrow press reaches.

      So a declared entry point is exempted from the opacity test alone. It is a
      DECLARATION — this screen says where a remote starts — and a screen fading
      itself in is not a reason to start somewhere else; it will be opaque within
      220ms either way. Everything else still applies: zero size, `display:none`,
      `visibility:hidden`, `inert`, `aria-hidden`, `data-nav-skip` and
      `pointer-events: none` all still refuse it, and that last one is what keeps
      the deliberately-hidden case out — the player's sleeping control bar is
      `opacity-0 pointer-events-none`, so it is still never landed on.
    */
    if (visible(first, r, true)) return first;
  }
  /*
    The page before the frame.

    With no explicit entry point, the first candidate in reading order is the
    wordmark in the top-left corner — which is a correct answer to "what is
    first" and the wrong place to start watching television. So when the scope is
    the whole document, the page's own content gets asked first, and the header
    is the fallback for a page with nothing focusable in it.
  */
  if (scope === document) {
    const main = document.querySelector('main');
    if (main !== null && main.querySelector(FOCUSABLE) !== null) return startIn(main);
  }
  /*
    Anything but a pane divider.

    The splitters (since removed) were focusable and sat at the left edge of the page, so
    "topmost, then leftmost" chose one every time — the app opened with its focus
    ring on a 4px grey line, which is a correct answer to the wrong question. They
    stay navigable; they are just never where a screen starts.
  */
  const items = itemsIn(scope).filter((i) => i.el.getAttribute('role') !== 'separator');
  if (items.length === 0) return null;
  // Reading order, not DOM order: a header rendered after the main content in the
  // tree is still at the top of the screen.
  items.sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
  /*
    A screen never OPENS on a text field.

    Measured on arrival at /guide and /catchup: both put the highlight straight
    into "find a channel…", because the search box is genuinely the topmost,
    leftmost thing in `main` and that is the honest answer to "what is first". It
    is the wrong place to arrive on a television. A focused input is what raises
    the on-screen keyboard on Android TV, so the screen opens with half of itself
    covered by a keyboard nobody asked for, and the first press of DOWN types
    rather than moves.

    Typing is something you go TO, not somewhere you land. So a field is the
    entry point only when the screen has nothing else at all — a search page is
    allowed to open on its search box. An explicit `data-nav-first` still wins
    over this, because a screen that really does want the caret says so above.
  */
  return (items.find((i) => !typing(i.el)) ?? items[0]!).el;
}

/**
 * Would focusing this raise a keyboard? Inputs, textareas and rich-text hosts.
 *
 * Not `[role=searchbox]` or a button that OPENS a search — only somewhere a
 * character can actually be typed, which is what an IME reacts to.
 */
function typing(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || el.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  const t = (el.getAttribute('type') ?? 'text').toLowerCase();
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file'].includes(t);
}

/** Is focus nowhere in particular? Then a directional key means "start". */
export function focusIsLoose(): boolean {
  const a = document.activeElement;
  return a === null || a === document.body || a === document.documentElement;
}

/* ── Tab, and focus that disappears ───────────────────────────────────────── */

/**
 * Keep Tab inside an overlay too.
 *
 * Neither reference implementation handles Tab, and both are right not to: a
 * television has no Tab key. This app is also a desktop app and gets driven by
 * keyboards, and some Android boxes ship a handset with a keyboard mode — and the
 * browser's own Tab order knows nothing about overlays, so Tab walks straight out
 * of an open panel and onto the page behind it. That is the same escape the arrows
 * had, through a different door.
 *
 * `inert` on everything else is the platform's answer to this and is not used here:
 * WebView support starts at Chromium 102 and the TV boxes this app exists for run
 * far older, so it would work on the devices that need it least.
 */
export function tabWithin(backwards: boolean): boolean {
  const top = topBoundary();
  if (top === null) return false;
  const items = survey(() => itemsIn(top));
  if (items.length === 0) return false;
  const active = document.activeElement as HTMLElement | null;
  const at = active === null ? -1 : items.findIndex((i) => i.el === active);
  // DOM order, not geometry: Tab is a sequence, and inside a form the sequence is
  // the one the markup declares.
  const next = at === -1
    ? (backwards ? items.length - 1 : 0)
    : (at + (backwards ? -1 : 1) + items.length) % items.length;
  focusOn(items[next]!.el);
  return true;
}

/**
 * Put focus back when the thing that had it disappears.
 *
 * The other half of "it suddenly removes the highlighted area", and it is not the
 * same bug as containment. When the focused element is unmounted — a panel closes,
 * a virtualised row is recycled, the player's control bar hides itself on its
 * timer, React replaces a subtree — the browser moves focus to `<body>`. There is
 * then no focus ring anywhere and, on a remote, no way to get one back except
 * pressing a direction and starting over from the top of the screen.
 *
 * Norigin calls this `autoRestoreFocus` and it is one of its central features,
 * which is a good sign it is not an edge case. This is the DOM version: remember
 * the container focus was in, and if focus goes loose because its element is gone,
 * put it back into that container — or into what the container remembers, so
 * closing a sheet returns you to where you were rather than to its first button.
 *
 * Deliberately limited to remote-driven devices. A mouse user losing focus to
 * `<body>` notices nothing, and moving their focus back would scroll the page out
 * from under them.
 */
let hadFocus: HTMLElement | null = null;
let hadContainer: HTMLElement | null = null;
let restoring = 0;
/**
 * What had focus before the newest overlay opened.
 *
 * Closing a dialog must return focus to the control that opened it. That is not a
 * refinement, it is the documented behaviour of a dialog (WAI-ARIA APG), and
 * without it closing the display panel dropped focus at the top of the page —
 * so leaving a menu meant losing your place in whatever you were doing. The
 * generic restore below cannot do this, because by the time the overlay is gone
 * the only thing it knows is that the overlay is gone.
 */
let trigger: HTMLElement | null = null;
let boundaries = 0;

export function watchFocus(isRemote: () => boolean): void {
  if (typeof document === 'undefined') return;

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    hadFocus = el;
    hadContainer = el.closest<HTMLElement>(CONTAINERS);
  });

  const restore = () => {
    restoring = 0;

    /* An overlay opened or closed. Opening: remember what to come back to.
       Closing: go back to it. Counted rather than observed per-node because one
       React commit can remove a backdrop, a panel and its contents at once. */
    const now = document.querySelectorAll('[data-nav-contain]').length;
    if (now > boundaries) {
      const top = topBoundary();
      if (hadFocus !== null && (top === null || !top.contains(hadFocus))) trigger = hadFocus;
    } else if (now < boundaries) {
      boundaries = now;
      if (trigger !== null && trigger.isConnected
        && (focusIsLoose() || hadFocus === null || !hadFocus.isConnected)) {
        const t = trigger;
        trigger = null;
        if (visible(t, t.getBoundingClientRect())) { focusOn(t); return; }
      }
      trigger = null;
    }
    boundaries = now;

    if (!isRemote() || !focusIsLoose()) return;
    if (hadFocus === null || hadFocus.isConnected) return;
    const home = hadContainer !== null && hadContainer.isConnected
      ? hadContainer
      : topBoundary() ?? document;
    focusFirst(home);
  };

  /* One check per frame at most. A route change removes hundreds of nodes, and a
     restore per mutation would queue hundreds of identical ones. */
  const observer = new MutationObserver(() => {
    if (restoring !== 0) return;
    restoring = requestAnimationFrame(restore);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
