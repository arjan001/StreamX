/**
 * The back-and-forth of a truncated name, as numbers — and the Map bookkeeping
 * that stops a virtualised list from leaking the row it just threw away.
 *
 * `installMarquee`'s actual listeners need a browser and stay untested here.
 * `marqueePlan` does not: it is where a wrong sign would send an Arabic name
 * the wrong way or a zero distance would animate a name that fits. Neither
 * does `sweep` — it only ever asks a row `.isConnected` and calls
 * `.querySelector` on it, both of which a plain object can answer without a
 * real DOM, so the fakes below stand in for the element `rows` is keyed by.
 */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { HOLD_MS, SPEED_PX_S, marqueePlan, rows, sweep, type Running } from './marquee.ts';

test('a name that fits does not move', () => {
  assert.equal(marqueePlan(0, false), null);
  assert.equal(marqueePlan(1, false), null);
  assert.equal(marqueePlan(-20, false), null);
  assert.equal(marqueePlan(Number.NaN, false), null);
});

test('a left-to-right name slides left to show its end, holds, and comes back', () => {
  const plan = marqueePlan(72, false);
  assert.ok(plan !== null);
  const travel = Math.round((72 / SPEED_PX_S) * 1000);
  assert.equal(plan.duration, 2 * HOLD_MS + 2 * travel);
  assert.deepEqual(plan.keyframes.map((k) => k.transform), [
    'translateX(0px)', 'translateX(0px)', 'translateX(-72px)', 'translateX(-72px)', 'translateX(0px)',
  ]);
});

test('a right-to-left name travels the other way', () => {
  /* It starts at the RIGHT edge and is cut off on the left, so its end is
     revealed by moving it right. */
  const plan = marqueePlan(40, true);
  assert.ok(plan !== null);
  assert.equal(plan.keyframes[2]!.transform, 'translateX(40px)');
  assert.equal(plan.keyframes[3]!.transform, 'translateX(40px)');
});

test('the holds and the travel are where the offsets say', () => {
  const plan = marqueePlan(100, false, 50, 1000);
  assert.ok(plan !== null);
  /* 1000 hold + 2000 travel + 1000 hold + 2000 back = 6000 */
  assert.equal(plan.duration, 6000);
  assert.deepEqual(plan.keyframes.map((k) => k.offset), [0, 0.1667, 0.5, 0.6667, 1]);
  /* Offsets rise, which is the one rule the Web Animations API enforces by
     throwing. */
  for (let i = 1; i < plan.keyframes.length; i++) {
    assert.ok(plan.keyframes[i]!.offset >= plan.keyframes[i - 1]!.offset);
  }
});

/* ── the Map a virtualised list would otherwise leak into ──────────────────── */

/**
 * `sweep` (via `stop`) only ever reads `.isConnected` and calls
 * `.querySelector` on a row — the second one only to look for the text it
 * would put back, which a row with nothing "found" skips. A plain object
 * answers both without needing a real element.
 */
function fakeRow(connected: boolean): HTMLElement {
  return { isConnected: connected, querySelector: () => null } as unknown as HTMLElement;
}

function fakeState(over: Partial<Running> = {}): Running {
  return { timer: 0, anim: null, focus: false, hover: false, ...over };
}

beforeEach(() => {
  rows.clear();
});

test('sweep drops a row the document no longer has, and cancels its animation', () => {
  let cancelled = false;
  const gone = fakeRow(false);
  rows.set(gone, fakeState({ anim: { cancel: () => { cancelled = true; } } as unknown as Animation }));

  sweep();

  assert.equal(rows.has(gone), false);
  assert.equal(cancelled, true);
});

test('sweep leaves a row that is still in the document alone', () => {
  let cancelled = false;
  const here = fakeRow(true);
  const state = fakeState({ anim: { cancel: () => { cancelled = true; } } as unknown as Animation });
  rows.set(here, state);

  sweep();

  assert.equal(rows.has(here), true);
  assert.equal(rows.get(here), state);
  assert.equal(cancelled, false);
});

test('sweep clears a still-pending re-arm timer on a row that is gone', () => {
  /* `stop` calls `window.clearTimeout`, which does not exist in a plain Node
     process — the module otherwise only ever runs in a browser. A minimal
     stand-in is enough to see that the call happens, without pulling in a
     real timer or a DOM. */
  const cleared: unknown[] = [];
  const before = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { clearTimeout: (id: unknown) => cleared.push(id) };
  try {
    const gone = fakeRow(false);
    rows.set(gone, fakeState({ timer: 4321 }));

    sweep();

    assert.deepEqual(cleared, [4321]);
    assert.equal(rows.has(gone), false);
  } finally {
    (globalThis as { window?: unknown }).window = before;
  }
});

test('sweep removes only the disconnected rows out of a mixed Map', () => {
  const here = fakeRow(true);
  rows.set(here, fakeState());
  rows.set(fakeRow(false), fakeState());
  rows.set(fakeRow(false), fakeState());

  sweep();

  assert.deepEqual([...rows.keys()], [here]);
});
