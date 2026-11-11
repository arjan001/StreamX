/**
 * The decidable half of "make the sizes consistant".
 *
 * Everything the two lists on Live agree about that can be checked without a
 * browser is checked here, because the half that needs a browser — does the
 * highlight land on the first matching row, does the rail still read as the same
 * component as the list beside it — is expensive to run and useless at telling
 * you WHICH of four rules broke.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  listLabel,
  EPG_BLOCK, ROW_STEP, epgBlock, filterSidebar, hasSecondLine,
  listRows, readBrowseStyle, rowStep, secondLine, standingLabel,
} from './liveRows.ts';

/* ── the pitch, which lives in two languages ───────────────────────────────── */

const CSS = fileURLToPath(new URL('../index.css', import.meta.url));

/**
 * The stylesheet and the virtualiser have to say the same number.
 *
 * This is the bug `docs/11-ui-rewrite.md` §10.4 is about, written down as a test
 * rather than as a warning: the virtualiser positions rows by pixel offset, so a
 * stylesheet that grows a row without telling it leaves every row at the wrong
 * offset and the rows overlap. It has already happened twice in this repo — once
 * with a rem grid gap, once with touch row heights — and both times it looked
 * like a rendering bug rather than a number in two places.
 */
test('--row-step in index.css matches ROW_STEP in the code', () => {
  const css = readFileSync(CSS, 'utf8');
  const declared = new Map<string, number>();
  for (const m of css.matchAll(/--row-step:\s*(\d+)px/g)) {
    declared.set(m[0]!, Number(m[1]));
  }
  const numbers = [...declared.values()];
  assert.ok(numbers.length >= 3, `expected a --row-step per form factor, found ${numbers.length}`);
  for (const want of [ROW_STEP.tv, ROW_STEP.touch, ROW_STEP.desk]) {
    assert.ok(numbers.includes(want), `index.css declares no --row-step: ${want}px`);
  }
});

test('both lists take one pitch from one function', () => {
  assert.equal(rowStep('tv', true), ROW_STEP.tv);
  /* A television is a television whatever it claims about its pointer: several
     TV Chromium builds report a fine pointer, and a 56px row there would put the
     two lists back out of step with each other. */
  assert.equal(rowStep('tv', false), ROW_STEP.tv);
  assert.equal(rowStep('phone', true), ROW_STEP.touch);
  assert.equal(rowStep('tablet', true), ROW_STEP.touch);
  assert.equal(rowStep('desktop', false), ROW_STEP.desk);
});

/* ── the field over the rail ───────────────────────────────────────────────── */

const RAIL = [
  { id: 'UK', label: 'United Kingdom', under: ['SPORTS', 'FREE TO AIR'] },
  { id: 'NL', label: 'Netherlands', under: ['ALGEMEEN'] },
  { id: 'QC', label: 'Québec', under: [] },
  { id: 'SPT', label: 'Sports' },
];

test('an empty query leaves the rail alone', () => {
  assert.deepEqual(filterSidebar(RAIL, '').map((r) => r.id), ['UK', 'NL', 'QC', 'SPT']);
  assert.deepEqual(filterSidebar(RAIL, '   ').map((r) => r.id), ['UK', 'NL', 'QC', 'SPT']);
});

test('a query matches the label, the code, and what is nested under it', () => {
  assert.deepEqual(filterSidebar(RAIL, 'nether').map((r) => r.id), ['NL']);
  /* The code, because a viewer who knows the list says "UK" types UK. */
  assert.deepEqual(filterSidebar(RAIL, 'uk').map((r) => r.id), ['UK']);
  /* The nested package, because otherwise the field only works for somebody who
     already knows which country the thing they want belongs to. Both the country
     carrying a SPORTS package and the Sports rail itself are honest answers. */
  assert.deepEqual(filterSidebar(RAIL, 'sport').map((r) => r.id), ['UK', 'SPT']);
});

test('accents and punctuation are not something to type', () => {
  assert.deepEqual(filterSidebar(RAIL, 'quebec').map((r) => r.id), ['QC']);
  assert.deepEqual(filterSidebar(RAIL, 'Québec').map((r) => r.id), ['QC']);
  assert.deepEqual(filterSidebar(RAIL, 'UNITED kingdom').map((r) => r.id), ['UK']);
});

test('a query nothing matches leaves nothing, rather than everything', () => {
  /* The failure mode worth naming: a filter that falls back to the unfiltered
     list when it matches nothing looks like a field that does not work. */
  assert.deepEqual(filterSidebar(RAIL, 'zzzz'), []);
});

test('the rail is not reordered by searching it', () => {
  assert.deepEqual(filterSidebar(RAIL, 'e').map((r) => r.id), ['UK', 'NL', 'QC']);
});

/* ── groups, or the provider's own list ────────────────────────────────────── */

/* What the panel sent, in the order it sent it — including the shapes a real
   line has: pipes with and without spaces, a name the provider wrote in Arabic,
   and a category with nothing in it. */
const CATEGORIES = [
  { id: 11, name: 'NL | CATEGORY | MOVIE', count: 120 },
  { id: 12, name: 'UK| SKY SPORTS', count: 73 },
  { id: 13, name: 'EMPTY | NOTHING', count: 0 },
  { id: 14, name: 'AR | مسلسلات أجنبيه', count: 40 },
  { id: 15, name: 'Malta', count: 12 },
];

test('the list is the provider\'s categories, named exactly as the panel names them', () => {
  /* "in list mode, no need to filter the names at all, i mean if country is
     nl | category | movie just show it like that". No friendly path, no case
     change, no pipe tidying — the label IS the name. */
  assert.deepEqual(listRows(CATEGORIES, ''), [
    { id: 11, ref: '', label: 'NL | CATEGORY | MOVIE', count: 120, hidden: false, placed: false },
    { id: 12, ref: '', label: 'UK| SKY SPORTS', count: 73, hidden: false, placed: false },
    { id: 14, ref: '', label: 'AR | مسلسلات أجنبيه', count: 40, hidden: false, placed: false },
    { id: 15, ref: '', label: 'Malta', count: 12, hidden: false, placed: false },
  ]);
});

test('the list keeps the order it was given', () => {
  /* The provider's order, or the viewer's own once `useCategories` has applied
     one. Sorting by size here would undo "drag these to the top". */
  const reversed = [...CATEGORIES].reverse();
  assert.deepEqual(listRows(reversed, '').map((r) => r.id), [15, 14, 12, 11]);
});

test('a category with nothing in it is not a destination', () => {
  assert.equal(listRows(CATEGORIES, '').some((r) => r.id === 13), false);
  assert.equal(listRows([{ id: 1, name: 'X', count: Number.NaN }], '').length, 0);
});

test('the field over the list matches the raw name', () => {
  assert.deepEqual(listRows(CATEGORIES, 'sky sports').map((r) => r.id), [12]);
  assert.deepEqual(listRows(CATEGORIES, 'nl | movie').map((r) => r.id), []);
  assert.deepEqual(listRows(CATEGORIES, 'nl | category').map((r) => r.id), [11]);
  assert.deepEqual(listRows(CATEGORIES, 'MALTA').map((r) => r.id), [15]);
  /* Only the name: the id is a per-generation number nobody types. */
  assert.deepEqual(listRows(CATEGORIES, '12').map((r) => r.id), []);
  /* A query nothing matches leaves nothing, rather than everything. */
  assert.deepEqual(listRows(CATEGORIES, 'zzzz'), []);
});

/* ── list mode, grouped by market rank ─────────────────────────────────────── */

/* Modelled on the photo that prompted this: a LIST-mode rail reading US|
   PARAMOUNT+ PPV, NL| ODIDO VERMAAK, NL| RADIO LIVE, US| ENTERTAINMENT, ...
   UK| NOW TV, US| TUBI — every country cut into every other one. Counts are
   deliberately NOT in arrival order within a market (US: 50, 900, 200), so a
   test that passed by accident because "arrived last" and "biggest" happened
   to agree would not catch a version of this that quietly sorted by size. */
const MIXED = [
  { id: 1, name: 'US| PARAMOUNT+ PPV', count: 50, path: ['US', 'PARAMOUNT+ PPV'] },
  { id: 2, name: 'NL| ODIDO VERMAAK', count: 40, path: ['NL', 'ODIDO VERMAAK'] },
  { id: 3, name: 'NL| RADIO LIVE', count: 30, path: ['NL', 'RADIO LIVE'] },
  { id: 4, name: 'US| ENTERTAINMENT', count: 900, path: ['US', 'ENTERTAINMENT'] },
  { id: 5, name: 'UK| NOW TV', count: 20, path: ['UK', 'NOW TV'] },
  { id: 6, name: 'US| TUBI', count: 200, path: ['US', 'TUBI'] },
];

test('list rows are grouped by their market\'s rank: UK, then the owner\'s Europe, then the rest', () => {
  /* NL is one of the owner's own defaults (`lib/marketOrder.ts`) and outranks
     the US block even though the three US rows carry 1,150 channels between
     them against NL's 70 — market rank, not category size, decides the group. */
  assert.deepEqual(listRows(MIXED, '').map((r) => r.id), [5, 2, 3, 1, 4, 6]);
});

test('within one market, categories keep the order they arrived in', () => {
  /* US| TUBI (id 6) has more channels than US| PARAMOUNT+ PPV (id 1) and still
     comes after it, because it arrived after it. Grouping moves which MARKET a
     row sits under; it never reorders that row's neighbours inside it — which
     is also where the viewer's own package order lands, once `useCategories`
     has applied `Prefs.catOrder` upstream, exactly as list mode always kept. */
  const us = listRows(MIXED, '').map((r) => r.id).filter((id) => id === 1 || id === 4 || id === 6);
  assert.deepEqual(us, [1, 4, 6]);
});

test('a category with no market sorts after every one that has one', () => {
  const rows = [...MIXED, { id: 7, name: 'STANDALONE PACKAGE', count: 15 }];
  assert.deepEqual(listRows(rows, '').map((r) => r.id), [5, 2, 3, 1, 4, 6, 7]);
});

test("the viewer's own market order still decides the groups", () => {
  /* `Prefs.marketOrder`, threaded through as `order` — moving US to the top
     overrides the rank `listRows` would otherwise give it, the same rule 1
     `lib/marketOrder.ts` applies everywhere else. */
  assert.deepEqual(listRows(MIXED, '', ['US']).map((r) => r.id), [1, 4, 6, 5, 2, 3]);
});

const SEARCHABLE = [
  { id: 1, name: 'US| SPORT ONE', count: 50, path: ['US', 'SPORT ONE'] },
  { id: 2, name: 'NL| ALGEMEEN', count: 40, path: ['NL', 'ALGEMEEN'] },
  { id: 3, name: 'UK| SPORT HD', count: 900, path: ['UK', 'SPORT HD'] },
  { id: 4, name: 'US| SPORT TWO', count: 900, path: ['US', 'SPORT TWO'] },
];

test('the sidebar search keeps filtering within this order, not a fresh one', () => {
  const unfiltered = listRows(SEARCHABLE, '').map((r) => r.id);
  assert.deepEqual(unfiltered, [3, 2, 1, 4]);
  /* "NL| ALGEMEEN" (id 2) is the only row "sport" does not match — the other
     three keep exactly the relative order they had above, UK still ahead of
     both US rows despite an equal channel count. */
  assert.deepEqual(listRows(SEARCHABLE, 'sport').map((r) => r.id), [3, 1, 4]);
});

test('the browse style defaults to the plain list', () => {
  /* The migration of a saved `groups`
     is prefs' business (`adoptedBrowseStyle`); this is the reader. */
  for (const raw of [undefined, null, '', 'tree', 'flat', true, 1, {}]) {
    assert.equal(readBrowseStyle(raw), 'list', JSON.stringify(raw));
  }
  assert.equal(readBrowseStyle('groups'), 'groups');
  assert.equal(readBrowseStyle('list'), 'list');
});

/**
 * The heading over the channel list and the sidebar's own standing row read
 * this off the same function now, so they cannot say two different things —
 * see the comment on `standingLabel`. List mode is the one that used to drift:
 * the sidebar said "All channels" while `Live.tsx`'s heading, a literal that
 * never read `browseStyle`, still said "All countries" underneath it.
 */
test('the standing row and the heading over the list agree, in every shape', () => {
  assert.equal(standingLabel(true, true), 'All channels');
  assert.equal(standingLabel(false, true), 'All countries');
  assert.equal(standingLabel(true, false), 'All titles');
  assert.equal(standingLabel(false, false), 'All groups');
});

/* ── the line under a channel name ─────────────────────────────────────────── */

test('a channel with listings says what is on now', () => {
  const line = secondLine({ now: 'The Six O’Clock News', archive: false, archiveDays: 0 });
  assert.deepEqual(line, { now: 'The Six O’Clock News', catchUpDays: null });
  assert.equal(hasSecondLine(line), true);
});

test('a channel with an archive says CATCH-UP and how far back', () => {
  const line = secondLine({ now: null, archive: true, archiveDays: 3 });
  assert.deepEqual(line, { now: null, catchUpDays: 3 });
  assert.equal(hasSecondLine(line), true);
});

test('a channel with both says both', () => {
  const line = secondLine({ now: 'Match of the Day', archive: true, archiveDays: 7 });
  assert.deepEqual(line, { now: 'Match of the Day', catchUpDays: 7 });
});

test('a channel with neither has no second line at all', () => {
  const line = secondLine({ now: null, archive: false, archiveDays: 0 });
  assert.deepEqual(line, { now: null, catchUpDays: null });
  assert.equal(hasSecondLine(line), false);
  /* And the same for the shapes a cold device actually produces: no guide read
     yet, and a title the panel sent as an empty string. */
  assert.equal(hasSecondLine(secondLine({ archive: false, archiveDays: 0 })), false);
  assert.equal(hasSecondLine(secondLine({ now: '   ', archive: false, archiveDays: 0 })), false);
});

test('an archive with a zero-day window is not offered', () => {
  /* The panel flags these, and the chip this replaced printed them as "0d" —
     a badge for a destination with nothing behind it. `NowNext` already refuses
     them under the picture; the list has to agree or the two disagree about the
     same channel. */
  assert.deepEqual(secondLine({ now: null, archive: true, archiveDays: 0 }), {
    now: null, catchUpDays: null,
  });
});

/* ── reading the stored guide ──────────────────────────────────────────────── */

test('a scroll inside one block does not re-key the guide read', () => {
  assert.deepEqual(epgBlock(0, 9), { from: 0, to: EPG_BLOCK - 1 });
  assert.deepEqual(epgBlock(3, 12), { from: 0, to: EPG_BLOCK - 1 });
  assert.deepEqual(epgBlock(39, 39), { from: 0, to: EPG_BLOCK - 1 });
});

test('a window straddling two blocks covers both', () => {
  assert.deepEqual(epgBlock(38, 41), { from: 0, to: 2 * EPG_BLOCK - 1 });
  assert.deepEqual(epgBlock(41, 60), { from: EPG_BLOCK, to: 2 * EPG_BLOCK - 1 });
});

test('a nonsense window is still a window', () => {
  /* The virtualiser reports -1/-1 before it has measured anything. */
  assert.deepEqual(epgBlock(-1, -1), { from: 0, to: EPG_BLOCK - 1 });
  assert.deepEqual(epgBlock(12, 4), { from: 0, to: EPG_BLOCK - 1 });
});

test('a hidden row goes to the bottom of the same list, not out of it', () => {
  /* "can u not say hide from this list and put in bottom in like hidden list,
     they find settings to complicated … as 100 users a day explaining". So a
     hidden category is still a row — last, and flagged so the rail can dim it
     and offer it back. */
  const withRefs = CATEGORIES.map((c) => ({ ...c, ref: `1.${c.id}` }));
  const rows = listRows(withRefs, '', [], 'live', { hidden: new Set(['1.12']) });
  assert.deepEqual(rows.map((r) => r.id), [11, 14, 15, 12]);
  assert.equal(rows[rows.length - 1]?.hidden, true);
  assert.equal(rows.filter((r) => r.hidden).length, 1);
});

test('a row the viewer placed is never re-ranked by its market', () => {
  /* Market rank is the default for a list nobody has arranged. Once somebody
     carries a row somewhere — "they can move it anywhere" — the arrangement on
     screen is the truth, and a repaint must not put it back under its country. */
  const withRefs = CATEGORIES.map((c) => ({ ...c, ref: `1.${c.id}` }));
  /* Malta has no market at all and would sort last; placed, it leads. */
  const malta = withRefs.find((c) => c.id === 15)!;
  const moved = [malta, ...withRefs.filter((c) => c.id !== 15)];
  const rows = listRows(moved, '', [], 'live', { placed: new Set(['1.15']) });
  assert.equal(rows[0]?.id, 15);
  assert.equal(rows[0]?.placed, true);
});

test('the field over the rail finds a package by what is INSIDE it', () => {
  /* "it should check both channals as well as categories, and then show those
     categorites with that keyword as well as those categories that its children
     has it" — typing a channel name used to empty the column. */
  const rows = listRows(CATEGORIES, 'discovery', [], 'live', {}, new Set([15]));
  assert.deepEqual(rows.map((r) => r.id), [15]);
  /* And a name match and a child match are the same row once, not twice. */
  const both = listRows(CATEGORIES, 'malta', [], 'live', {}, new Set([15]));
  assert.deepEqual(both.map((r) => r.id), [15]);
});

test('a child match cannot resurrect a category with nothing in it', () => {
  assert.deepEqual(listRows(CATEGORIES, 'zzz', [], 'live', {}, new Set([13])), []);
});

test('the tree keeps a country whose channels match', () => {
  const rows = [
    { id: 'UK', label: 'United Kingdom', under: ['SPORTS'] },
    { id: 'NL', label: 'Netherlands', under: ['ALGEMEEN'] },
  ];
  assert.deepEqual(filterSidebar(rows, 'discovery').map((r) => r.id), []);
  assert.deepEqual(
    filterSidebar(rows, 'discovery', new Set(['NL'])).map((r) => r.id),
    ['NL'],
  );
});

test('a list row keeps its market and every field, set in ordinary case without tier marks', () => {
  assert.deepEqual(listLabel('UK| MC VIDEO ᴴᴰ'), { market: 'UK', name: 'MC Video' });
  assert.deepEqual(listLabel('NL | CATEGORY | MOVIE'), { market: 'NL', name: 'Category · Movie' });
  assert.deepEqual(listLabel('ES| M+ LIGA DE CAMPEONES VIP'), { market: 'ES', name: 'M+ Liga de Campeones VIP' });
  assert.deepEqual(listLabel('Sports'), { market: null, name: 'Sports' });
});
