/**
 * The filler rule has to reach the ON-DEVICE catalogue too.
 *
 * `filler.ts` and the server's `is_filler` column have excluded section headings
 * and idle pay-per-view slots since 2026-08-29. `core-store` — the typed-array
 * catalogue a device keeps for itself — never learned the rule, and `localFirst()`
 * prefers that store, so the copy people actually look at went on listing all
 * 1,834 of them. Reported, correctly, as "in channels I STILL see hashes and
 * categories".
 *
 * These tests pin the parity rather than re-testing the rule: the point is that
 * one function decides this for both stores, so the two cannot drift again.
 *
 * Scoped to the LIVE list, which is where providers publish these rows. `series`
 * has no `is_filler` column server-side, so this store deliberately does not
 * filter series either — see the note in `build.ts`.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isFillerName } from '@iptv/core-xtream';
import { buildCatalogue } from '../src/build.ts';
import { getItem } from '../src/index.ts';

/** The three shapes this line actually publishes, plus real channels. */
const HEADINGS = [
  '##### TDT ESPAÑA #####',
  '####### AVATEL #######',
  // A heading carrying a country prefix before its first bar. The rule tests the
  // CLOSING bar for exactly this case.
  'TR| ##### TR DINI KANALLARI #####',
];
const IDLE = [
  'NO EVENT STREAMING NOW - | 8K EXCLUSIVE | ES: SOCCER PPV 130',
  'ES: LALIGA+ PPV 1 - NO EVENT STREAMING -',
  'UK: VOLLEY PPV 7 - NO EVENT STREAMING - 8K EXCLUSIVE',
  'Matchroom Event 3 | No Event Scheduled',
];
/*
 * Real channels, including the ones that make the separator rule non-trivial:
 * `#VAMOS` and `M.ELLAS #V` open with a marker and must survive, which is why the
 * rule requires decoration at BOTH ends.
 *
 * Note the sharp edge deliberately NOT tested here: `isIdleEventName` matches any
 * `\bno event\b`, so a film actually titled "No Event" would be hidden. Checked
 * against all 96,821 titles on this line — every one of the 1,604 matches is a
 * placeholder and none is a real title — so the rule is safe as measured. If a
 * catalogue ever carries such a title, this is the test that should grow a case.
 */
const REAL = ['ES| #VAMOS HD', 'ES| M.ELLAS #V FHD', 'FR| TF1 HD', 'LAT| CDF CHILE'];

test('the on-device build drops every row the rule calls filler', () => {
  const live = [...HEADINGS, ...IDLE, ...REAL].map((name, i) => ({
    stream_id: 100 + i, name, category_id: '1',
  }));
  const cat = buildCatalogue(
    {
      liveCategories: [{ category_id: '1', category_name: 'ES| GENERAL' }],
      vodCategories: [], seriesCategories: [], live, vod: [], series: [],
    },
    { generation: 1, now: 0 },
  );
  // Read through the store's own accessor: names live in a text blob with an
  // offset table, not a plain array.
  const names: string[] = [];
  for (let r = 0; r < cat.items.count; r++) names.push(getItem(cat, r)!.name);

  assert.equal(names.length, REAL.length, `kept ${JSON.stringify(names)}`);
  for (const n of REAL) assert.ok(names.includes(n), `${n} must survive`);
  for (const n of [...HEADINGS, ...IDLE]) assert.ok(!names.includes(n), `${n} must be dropped`);
});

test('the rule itself agrees with what the on-device build did', () => {
  // Parity is the property under test: if these ever disagree, one store shows
  // rows the other hides and every count between them is off.
  for (const n of [...HEADINGS, ...IDLE]) assert.equal(isFillerName(n), true, n);
  for (const n of REAL) assert.equal(isFillerName(n), false, n);
});
