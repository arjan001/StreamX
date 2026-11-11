import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anythingCanScroll, clearsSection, dropDoorways, pickNext, type Layer, type Rect } from './spatialNav.ts';

/** A rect from x, y, width, height, because that is how a layout is described. */
function box(x: number, y: number, w = 100, h = 40): Rect {
  return { left: x, top: y, right: x + w, bottom: y + h };
}

/** The candidate list shape, with the element's name as its reference. */
function cands(entries: Record<string, Rect>) {
  return Object.entries(entries).map(([ref, rect]) => ({ ref, rect }));
}

test('down leaves the row, and lands on the thing directly below', () => {
  const from = box(300, 0);
  const found = pickNext('down', from, cands({
    farLeft: box(0, 60),
    below: box(300, 60),
    farRight: box(600, 60),
  }));
  assert.equal(found, 'below');
});

test('a slightly nearer element off to the side does not win', () => {
  // The case that sets SKEW: a filter chip 10px below and 400px to the left is
  // geometrically closer than the poster 50px straight down. Straight down wins.
  const from = box(400, 0);
  const found = pickNext('down', from, cands({
    aside: box(0, 50, 60, 24),
    straight: box(400, 90),
  }));
  assert.equal(found, 'straight');
});

test('right stays in its row', () => {
  // The end of a poster rail. There IS something down and to the right, and Right
  // must not go there — that is what Down is for.
  const from = box(900, 0);
  const found = pickNext('right', from, cands({
    nextRailFirst: box(0, 200),
    nextRailRight: box(1000, 200),
  }));
  assert.equal(found, null);
});

test('a control alone on its line can still be reached sideways', () => {
  /*
   * Rule 2 was a hard refusal horizontally where its own wording says "prefers
   * not to" vertically, so anything sharing no row with anything could not be
   * reached by LEFT or RIGHT from anywhere, however close. Reported as "the
   * navigation... if nothing is there it wont move to the action around it".
   *
   * A floating corner button is the case: nothing shares its row and nothing
   * shares its column. It is further to the right (gap 100) than it is off the
   * row (miss 20), so it is genuinely that way and the last resort takes it.
   */
  const from = box(0, 0);
  const found = pickNext('right', from, cands({ corner: box(200, 60, 80, 24) }));
  assert.equal(found, 'corner');
});

test('but only when it is more that way than off to one side', () => {
  /* The same last resort must not undo the rail rule above: a candidate whose
     axis gap is smaller than its row miss is below, not beside. */
  const from = box(0, 0);
  assert.equal(pickNext('right', from, cands({ mostlyBelow: box(110, 300, 80, 24) })), null);
});

test('right crosses to a neighbour whose row overlaps at all', () => {
  // A 40px-tall list row beside a 300px-tall player: they share 40px of height,
  // which is enough. Requiring centre alignment here would strand the player.
  const from = box(0, 100, 200, 40);
  const found = pickNext('right', from, cands({ player: box(220, 0, 500, 300) }));
  assert.equal(found, 'player');
});

test('overlapping siblings can still be left', () => {
  // A tile and its caption overlap the tile's own box. "Beyond the midline"
  // rather than "beyond the edge" is what makes Down work in a poster grid.
  const from = box(0, 0, 140, 210);
  const found = pickNext('down', from, cands({
    caption: box(0, 190, 140, 30),
    nextRow: box(0, 230, 140, 210),
  }));
  assert.equal(found, 'caption');
});

test('nothing beyond means nothing happens', () => {
  const from = box(0, 0);
  assert.equal(pickNext('up', from, cands({ below: box(0, 100) })), null);
  assert.equal(pickNext('left', from, cands({ right: box(200, 0) })), null);
});

test('ties break on document order', () => {
  const from = box(100, 0);
  const found = pickNext('down', from, cands({
    first: box(0, 60),
    second: box(200, 60),
  }));
  // Both are 100px off-centre in opposite directions and 20px below: the one the
  // page reads first is the answer.
  assert.equal(found, 'first');
});

test('the whole screen is a candidate, not just what is on it', () => {
  // A rail scrolled halfway has tiles at negative x. They are real targets — the
  // scroller follows the focus — so a left move must find them.
  const from = box(20, 300);
  const found = pickNext('left', from, cands({ offscreen: box(-160, 300) }));
  assert.equal(found, 'offscreen');
});

test('down prefers the column it is in, and only leaves it when empty', () => {
  /* The report: DOWN on a header icon at the right of the screen jumped 570px to
     a channel row on the left, because SKEW is a per-pixel fine rather than a
     rule and a far-enough candidate can still out-price one directly below. */
  const from = box(806, 20, 40, 40);
  const withColumn = pickNext('down', from, cands({
    farLeftRow: box(234, 70, 360, 52),
    inColumn: box(600, 300, 340, 200),
  }));
  assert.equal(withColumn, 'inColumn');

  /* Nothing in the column: leaving it is still allowed, or the press is dead. */
  const empty = pickNext('down', from, cands({ farLeftRow: box(234, 70, 360, 52) }));
  assert.equal(empty, 'farLeftRow');
});

/* ── doorways ──────────────────────────────────────────────────────────────
   A tree of plain objects stands in for the DOM: `dropDoorways` cares about
   containment, and containment is all these carry. */
interface Node_ { name: string; parent: Node_ | null }
const node = (name: string, parent: Node_ | null = null): Node_ => ({ name, parent });
const items = (...ns: Node_[]) => ns.map((el) => ({ el, rect: box(0, 0) }));

test('a focusable window is dropped while its buttons are reachable', () => {
  // The hero carousel: the <section> owns Left and Right for changing slide, so
  // it is focusable — and it encloses PLAY and DETAILS, so by every geometric
  // measure it was at least as good a target as the buttons inside it. "It
  // selects windows a lot instead of the item properly".
  const hero = node('hero');
  const play = node('play', hero);
  const details = node('details', hero);
  const left = dropDoorways(items(hero, play, details), (n) => n.parent, null);
  assert.deepEqual(left.map((i) => i.el.name), ['play', 'details']);
});

test('and offered again once nothing inside it is reachable', () => {
  // The player shell with its chrome asleep: the controls are opacity-0 and
  // pointer-events-none, so `visible()` never put them in the list. The shell IS
  // the only thing there, and landing on it is what wakes the controls.
  const shell = node('shell');
  const row = node('channel');
  const left = dropDoorways(items(shell, row), (n) => n.parent, null);
  assert.deepEqual(left.map((i) => i.el.name), ['shell', 'channel']);
});

test('nesting two deep drops both windows, not just the inner one', () => {
  const page = node('page');
  const panel = node('panel', page);
  const btn = node('button', panel);
  const left = dropDoorways(items(page, panel, btn), (n) => n.parent, null);
  assert.deepEqual(left.map((i) => i.el.name), ['button']);
});

test('the scope itself is never mistaken for a doorway inside it', () => {
  // `itemsIn` passes the scope as the stop: a scope that is itself focusable
  // must not delete every candidate it contains.
  const scope = node('scope');
  const a = node('a', scope);
  const bb = node('b', scope);
  const left = dropDoorways(items(a, bb), (n) => n.parent, scope);
  assert.deepEqual(left.map((i) => i.el.name), ['a', 'b']);
});

/* ── leaving a section ─────────────────────────────────────────────────────
   The measured bug: on Live, DOWN from the last country in the rail moved 224px
   RIGHT into the channel list, and UP from the first channel moved 224px LEFT
   back into the rail. "I go to one menu and it jumps to another area." */

test('down out of a column may not land in the column beside it', () => {
  // The rail and the list both run the full height of the screen. Down out of
  // the rail has to mean below the rail, and there is nothing below it.
  const rail = box(10, 69, 224, 467);
  const list = box(234, 113, 358, 423);
  assert.equal(clearsSection('down', rail, list), false);
});

test('up out of a list may not land in the rail standing beside it', () => {
  // The rail's FIRST row sits above the list's first row, so by its own
  // rectangle it looks like a fair target for UP. Judged by its section — which
  // runs the whole height — it is not.
  const list = box(234, 113, 358, 423);
  const rail = box(10, 69, 224, 467);
  assert.equal(clearsSection('up', list, rail), false);
});

test('but up still reaches the header, which really is above', () => {
  // The header is stacked over the page rather than standing beside it, so this
  // is the one escalation that must survive — otherwise the top of a list is a
  // dead end and the tabs are unreachable from it.
  const list = box(234, 113, 358, 423);
  const header = box(0, 0, 960, 69);
  assert.equal(clearsSection('up', list, header), true);
});

test('and down still carries from one poster rail to the next', () => {
  // The behaviour that made escalation worth having. Rails are STACKED, so the
  // next one down is genuinely below this one.
  const first = box(0, 100, 960, 200);
  const second = box(0, 310, 960, 200);
  assert.equal(clearsSection('down', first, second), true);
});

test('right out of the channel list may not climb into the header', () => {
  // Measured on /live with nothing playing: the player pane had nothing to
  // select, and RIGHT settled for the header's icons, above-right of the list.
  // From there LEFT walked the header and the rail could not be reached.
  const list = box(222, 140, 278, 390);
  const headerIcon = box(784, 10, 32, 32);
  assert.equal(clearsSection('right', list, headerIcon), false);
  // The player pane beside it is still a fair target.
  const stage = box(515, 70, 431, 460);
  assert.equal(clearsSection('right', list, stage), true);
  // And the same the other way: LEFT out of the player lands in the list.
  assert.equal(clearsSection('left', stage, list), true);
});

test('a shared border is not a wall', () => {
  // Two panes that butt against each other report edges a fraction of a pixel
  // apart once the page is scaled. Without slack that fraction is a dead key.
  const left = box(0, 0, 200, 400);
  const right = { left: 199.6, top: 0, right: 600, bottom: 400 };
  assert.equal(clearsSection('right', left, right), true);
});

/**
 * Bringing the focused thing into view — when that is possible at all.
 *
 * Two faults, opposite directions, one rule between them.
 *
 * The first: in full screen the stage is `fixed` and `overflow: hidden`, but
 * its control bar hangs a few pixels past the bottom edge, so `scrollHeight`
 * exceeds `clientHeight` and `scrollIntoView` scrolled a CLIPPED box — a few
 * pixels per press until BACK had gone off the top.
 *
 * The fix for that asked "is this inside a fixed box?" and refused to scroll if
 * it was, which broke every dropdown in the app:
 *
 *     when trying to change locale i canoot it doesn under it
 *
 * `Popover` is portalled to the body and is `position: fixed`; `Select` gives it
 * `overflow-y-auto` and a max height. It is a real scroller that happens to be
 * fixed, so focus walked down the language list while the list stayed put and
 * the highlight disappeared off the bottom.
 */
const layer = (o: Partial<Layer> = {}): Layer => ({
  position: 'static',
  overflowY: 'visible',
  overflowX: 'visible',
  scrollHeight: 100, clientHeight: 100,
  scrollWidth: 100, clientWidth: 100,
  ...o,
});

test('an ordinary element scrolls the page', () => {
  assert.equal(anythingCanScroll([layer(), layer()]), true);
});

test('the full-screen stage clips and does not scroll', () => {
  /* overflow hidden, and it overflows — which is exactly what made
     `scrollIntoView` move it. A viewer cannot scroll it, so neither may we. */
  const stage = layer({ position: 'fixed', overflowY: 'hidden', scrollHeight: 124, clientHeight: 100 });
  assert.equal(anythingCanScroll([layer(), stage]), false);
});

test('a dropdown list inside a fixed popover still scrolls', () => {
  /* The regression this pins. The fixed box IS the scroller, so scrollability
     has to be asked before fixedness on the very same layer. */
  const popover = layer({ position: 'fixed', overflowY: 'auto', scrollHeight: 640, clientHeight: 320 });
  assert.equal(anythingCanScroll([layer(), popover]), true);
});

test('a fixed pane that does not overflow stops the walk', () => {
  const pane = layer({ position: 'fixed', overflowY: 'auto', scrollHeight: 100, clientHeight: 100 });
  assert.equal(anythingCanScroll([layer(), pane]), false,
    'nothing behind a fixed pane can bring its contents into view');
});

test('a scroller below a fixed pane is found before the pane is', () => {
  const list = layer({ overflowY: 'scroll', scrollHeight: 900, clientHeight: 300 });
  const pane = layer({ position: 'fixed' });
  assert.equal(anythingCanScroll([layer(), list, pane]), true);
});

test('a horizontal rail counts too', () => {
  const rail = layer({ overflowX: 'auto', scrollWidth: 2000, clientWidth: 800 });
  assert.equal(anythingCanScroll([layer(), rail, layer({ position: 'fixed' })]), true);
});
