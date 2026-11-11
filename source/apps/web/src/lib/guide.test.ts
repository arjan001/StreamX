import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY, HOUR, PPM_DEFAULT, PPM_STEPS, archiveFloor, autoPxPerMin, blockGeometry, clockOf,
  dayChips, effectiveArchiveDays, floorTo, guideMaxTs, guideMinTs, hourTicks, isPlayable,
  progress, slotAt, slotState, visibleSlots,
} from './guide.ts';

const at = (h: number, m = 0) => Date.UTC(2026, 7, 20, h, m) / 1000;

test('windows are floored to a step so columns line up across channels', () => {
  assert.equal(floorTo(at(13, 47), 1800), at(13, 30));
  assert.equal(floorTo(at(13, 30), 1800), at(13, 30));
});

test('a block is placed as a percentage of the window', () => {
  const g = blockGeometry({ startTs: at(13), stopTs: at(14) }, at(12), 6 * HOUR);
  assert.deepEqual(g, { leftPct: (1 / 6) * 100, widthPct: (1 / 6) * 100 });
});

test('a programme already running is clamped to the left edge, not dropped', () => {
  const g = blockGeometry({ startTs: at(10), stopTs: at(13) }, at(12), 6 * HOUR);
  assert.equal(g?.leftPct, 0);
  assert.equal(g?.widthPct, (1 / 6) * 100);
});

test('a programme outside the window is dropped, and touching edges do not count', () => {
  assert.equal(blockGeometry({ startTs: at(6), stopTs: at(12) }, at(12), HOUR), null);
  assert.equal(blockGeometry({ startTs: at(13), stopTs: at(14) }, at(12), HOUR), null);
});

test('a missing end time is treated as an hour, not as zero width', () => {
  const g = blockGeometry({ startTs: at(12), stopTs: null }, at(12), 6 * HOUR);
  assert.equal(g?.widthPct, (1 / 6) * 100);
});

/*
 * The 0.4% floor this used to assert is gone, and it was a bug.
 *
 * At a six-hour span 0.4% is about six pixels, and those six pixels came out of
 * the NEXT programme: a block inflated past its own end still starts where its
 * neighbour does, so the floor that existed to keep short programmes visible was
 * a second source of overlap. What it made visible was a sliver too narrow to
 * hold a character anyway. The minimum is a 2px CSS hairline now, which cannot
 * overlap anything, and it lives in the renderer.
 */
test('a one-minute programme takes one minute of the grid and no more', () => {
  const g = blockGeometry({ startTs: at(12), stopTs: at(12, 1) }, at(12), 24 * HOUR);
  assert.equal(g?.widthPct, (1 / (24 * 60)) * 100);
});

/*
 * The overlap in the screenshot: a panel that omits stop times, and every
 * listing drawn an hour wide over the neighbour that started ten minutes later.
 */
test('a missing end time ends where the next programme starts', () => {
  const g = blockGeometry({ startTs: at(12), stopTs: null }, at(12), 6 * HOUR, at(12, 10));
  assert.equal(g?.widthPct, (10 / 360) * 100);
});

test('a missing end time with no neighbour is still capped at an hour', () => {
  // One listing and then a six-hour gap must not draw a six-hour block.
  const far = blockGeometry({ startTs: at(12), stopTs: null }, at(12), 6 * HOUR, at(18));
  assert.equal(far?.widthPct, (1 / 6) * 100);
  const none = blockGeometry({ startTs: at(12), stopTs: null }, at(12), 6 * HOUR, null);
  assert.equal(none?.widthPct, (1 / 6) * 100);
});

test('a real stop time always wins over the neighbour', () => {
  // Overlapping listings are the panel's business to fix, not ours to invent.
  const g = blockGeometry({ startTs: at(12), stopTs: at(13) }, at(12), 6 * HOUR, at(12, 30));
  assert.equal(g?.widthPct, (1 / 6) * 100);
});

/* The property that matters for the whole row: consecutive blocks touch and
   never cross, whatever the panel left out. */
test('neighbouring blocks tile the row instead of stacking on it', () => {
  const starts = [at(12), at(12, 10), at(12, 40), at(13)];
  const geos = starts.map((startTs, i) =>
    blockGeometry({ startTs, stopTs: null }, at(12), 6 * HOUR, starts[i + 1] ?? null));
  for (let i = 0; i + 1 < geos.length; i++) {
    const a = geos[i]!; const b = geos[i + 1]!;
    assert.ok(a.leftPct + a.widthPct <= b.leftPct + 1e-9,
      `block ${i} runs into block ${i + 1}`);
  }
});

test('progress is null off air and a fraction on air', () => {
  const slot = { startTs: at(12), stopTs: at(13) };
  assert.equal(progress(slot, at(11, 59)), null);
  assert.equal(progress(slot, at(13)), null);
  assert.equal(progress(slot, at(12, 30)), 0.5);
});

test('slotState splits past, live and future at the right boundaries', () => {
  const slot = { startTs: at(12), stopTs: at(13) };
  assert.equal(slotState(slot, at(11, 59)), 'future');
  assert.equal(slotState(slot, at(12)), 'live');
  assert.equal(slotState(slot, at(12, 59)), 'live');
  assert.equal(slotState(slot, at(13)), 'past');
});

test('slotAt finds the programme covering an instant', () => {
  const slots = [
    { title: 'a', description: null, startTs: at(12), stopTs: at(13) },
    { title: 'b', description: null, startTs: at(13), stopTs: at(14) },
  ];
  assert.equal(slotAt(slots, at(13, 5))?.title, 'b');
  assert.equal(slotAt(slots, at(15)), null);
});

test('catch-up needs a finished programme, a channel archive, AND the window', () => {
  const now = at(20);
  const ch = { archive: true, archiveDays: 3 };
  // finished today
  assert.equal(isPlayable({ startTs: at(12), stopTs: at(13), hasArchive: true }, ch, now), true);
  // still on air
  assert.equal(isPlayable({ startTs: at(19), stopTs: at(21), hasArchive: true }, ch, now), false);
  // channel keeps nothing
  assert.equal(isPlayable({ startTs: at(12), stopTs: at(13) }, { archive: false, archiveDays: 0 }, now), false);
  // older than the retention window, measured from the START
  assert.equal(isPlayable({ startTs: now - 4 * DAY, stopTs: now - 4 * DAY + HOUR }, ch, now), false);
  assert.equal(isPlayable({ startTs: now - 2 * DAY, stopTs: now - 2 * DAY + HOUR }, ch, now), true);
});

test('a channel reporting archive with 0 days still gets one day, not zero', () => {
  const now = at(20);
  assert.equal(isPlayable({ startTs: now - 6 * HOUR, stopTs: now - 5 * HOUR }, { archive: true, archiveDays: 0 }, now), true);
});

test('day chips are bounded in both directions and named at the near end', () => {
  const chips = dayChips(Date.UTC(2026, 7, 20, 15), { back: 2, forward: 1 });
  assert.deepEqual(chips.map((c) => c.offset), [-2, -1, 0, 1]);
  assert.equal(chips.find((c) => c.offset === 0)?.label, 'Today');
  assert.equal(chips.find((c) => c.offset === -1)?.label, 'Yesterday');
  assert.equal(chips.find((c) => c.offset === 1)?.label, 'Tomorrow');
  // A channel with no archive gets today and forward only.
  assert.deepEqual(dayChips(Date.now(), { back: 0, forward: 0 }).map((c) => c.offset), [0]);
});

test('hour ticks start at the first whole hour inside the window', () => {
  const ticks = hourTicks(at(12, 30), 3 * HOUR);
  assert.deepEqual(ticks.map((t) => t.ts), [at(13), at(14), at(15)]);
  assert.equal(ticks[0]!.leftPct, (0.5 / 3) * 100);
});

test('clockOf renders a wall clock', () => {
  assert.match(clockOf(at(12, 5)), /\d{1,2}[:.]\d{2}/);
});

/*
 * The scale used to be the constant 4px/min whatever the listings looked like:
 * comfortable on half-hour programmes, a column of clipped single letters on a
 * channel running five-minute segments.
 */
test('the zoom follows the typical programme, not a constant', () => {
  const mins = (...m: number[]) => m.map((x) => x * 60);
  // Half-hour programmes are already about right.
  assert.equal(autoPxPerMin(mins(30, 30, 30)), 4);
  // Five-minute segments zoom in so a block can hold a title.
  assert.ok(autoPxPerMin(mins(5, 5, 5)) > 4);
  // Feature-length blocks zoom out so more of the evening fits.
  assert.ok(autoPxPerMin(mins(120, 120, 120)) < 4);
});

test('the median decides, so one strange row cannot set the scale', () => {
  const normal = [30, 30, 30, 30, 30].map((m) => m * 60);
  const withOutliers = [1, 30, 30, 30, 480].map((m) => m * 60);
  assert.equal(autoPxPerMin(withOutliers), autoPxPerMin(normal));
});

test('the answer is always one of the steps, and inside the clamp', () => {
  for (const m of [0.5, 1, 5, 12, 26, 45, 90, 240, 600]) {
    const ppm = autoPxPerMin([m * 60]);
    assert.ok((PPM_STEPS as readonly number[]).includes(ppm), `${m}min -> ${ppm}`);
    assert.ok(ppm >= PPM_STEPS[0] && ppm <= PPM_STEPS[PPM_STEPS.length - 1]!);
  }
});

/* A grid that re-scales while you read it is worse than one slightly too tight,
   so the median has to move a long way to change the answer. */
test('a small change in the listings does not move the zoom', () => {
  const base = autoPxPerMin([30 * 60, 30 * 60, 30 * 60]);
  assert.equal(autoPxPerMin([28 * 60, 30 * 60, 32 * 60]), base);
  assert.equal(autoPxPerMin([30 * 60, 30 * 60, 30 * 60, 31 * 60]), base);
});

test('nothing to measure falls back to the old constant rather than to zero', () => {
  assert.equal(autoPxPerMin([]), PPM_DEFAULT);
  assert.equal(autoPxPerMin([0, -1, Number.NaN]), PPM_DEFAULT);
});

/*
 * The window-bounding arithmetic behind the guide's LEFT/RIGHT edge travel:
 * how far back a page of channels may open, how far forward, and which slots a
 * single row is allowed to draw. `isPlayable` answers "can THIS programme be
 * replayed"; these answer "how much of the grid is worth drawing at all", which
 * is a stricter question — see `effectiveArchiveDays`.
 */

test('a no-archive channel is zero days deep even if it reports a count', () => {
  // Reporting matters only once `archive` itself is true.
  assert.equal(effectiveArchiveDays({ archive: false, archiveDays: 5 }), 0);
  assert.equal(effectiveArchiveDays({ archive: true, archiveDays: 0 }), 0);
  assert.equal(effectiveArchiveDays({ archive: true, archiveDays: 3 }), 3);
});

test('a channel with no archive has a floor of now; one with N days has a floor N days back', () => {
  const now = at(20);
  assert.equal(archiveFloor({ archive: false, archiveDays: 0 }, now), now);
  assert.equal(archiveFloor({ archive: true, archiveDays: 0 }, now), now);
  assert.equal(archiveFloor({ archive: true, archiveDays: 3 }, now), now - 3 * DAY);
});

test('the window cannot open earlier than the deepest archive on screen, or before now with none', () => {
  const now = at(20);
  assert.equal(guideMinTs([], now), now);
  assert.equal(
    guideMinTs([{ archive: false, archiveDays: 0 }, { archive: true, archiveDays: 0 }], now),
    now,
  );
  assert.equal(
    guideMinTs(
      [{ archive: true, archiveDays: 1 }, { archive: true, archiveDays: 7 }, { archive: false, archiveDays: 3 }],
      now,
    ),
    now - 7 * DAY,
  );
});

test('the future cap is always more than a day and at most two days ahead of now', () => {
  for (const h of [0, 6, 12, 18, 23]) {
    const now = at(h, 15);
    const cap = guideMaxTs(now);
    assert.ok(cap > now + DAY - 1, `hour ${h}: cap is not even a day out`);
    assert.ok(cap <= now + 2 * DAY, `hour ${h}: cap is more than two days out`);
  }
});

test('the future cap sits exactly two local days past midnight, not from "now"', () => {
  const now = at(13, 30);
  const midnight = new Date(now * 1000);
  midnight.setHours(0, 0, 0, 0);
  assert.equal(guideMaxTs(now), Math.floor(midnight.getTime() / 1000) + 2 * DAY);
});

test('a no-archive channel shows nothing before now; an archived one shows back to its own floor', () => {
  const now = at(20);
  const past2days = { startTs: now - 2 * DAY, stopTs: now - 2 * DAY + HOUR };
  const past1hour = { startTs: now - HOUR, stopTs: now - 30 * 60 };
  const future = { startTs: now + HOUR, stopTs: now + 2 * HOUR };
  const slots = [past2days, past1hour, future];
  // No catch-up: every finished programme is gone, live/future are untouched.
  assert.deepEqual(visibleSlots(slots, { archive: false, archiveDays: 0 }, now), [future]);
  // One day of retention reaches the hour-old programme but not the two-day-old one.
  assert.deepEqual(visibleSlots(slots, { archive: true, archiveDays: 1 }, now), [past1hour, future]);
  // Three days reaches both.
  assert.deepEqual(visibleSlots(slots, { archive: true, archiveDays: 3 }, now), [past2days, past1hour, future]);
});

test('visibleSlots never touches the live slot straddling now', () => {
  const now = at(20);
  const live = { startTs: now - 30 * 60, stopTs: now + 30 * 60 };
  assert.deepEqual(visibleSlots([live], { archive: false, archiveDays: 0 }, now), [live]);
});
