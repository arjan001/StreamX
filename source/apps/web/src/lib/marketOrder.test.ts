import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEuropean, marketSort, moveMarket } from './marketOrder.ts';

const m = (id: string, count: number) => ({ id, count });

test('Europe comes before bigger non-European markets', () => {
  /* The case that prompted this: by count alone, the American and Arabic
     bundles are first and a viewer in Belgium scrolls past thousands of rows to
     reach their own country. */
  const rows = [m('US', 4000), m('AR', 3000), m('BE', 200), m('NL', 400)];
  assert.deepEqual(marketSort(rows).map((x) => x.id), ['NL', 'BE', 'US', 'AR']);
});

test('within Europe, and within the rest, size still decides', () => {
  const rows = [m('BE', 200), m('NL', 400), m('BR', 900), m('US', 4000)];
  assert.deepEqual(marketSort(rows).map((x) => x.id), ['NL', 'BE', 'US', 'BR']);
});

test('the free-list namespace lands beside its own country', () => {
  assert.ok(isEuropean('NLF'), 'the Dutch free list is Dutch');
  assert.ok(!isEuropean('BRF'), 'the Brazilian free list is not European');
  const rows = [m('US', 4000), m('NLF', 120)];
  assert.deepEqual(marketSort(rows).map((x) => x.id), ['NLF', 'US']);
});

test("the provider's meaning of a reused code wins", () => {
  /* `IS` is Israel to this provider and Iceland to ISO; `BH` is Bosnia here and
     Bahrain to ISO. Both are read the provider's way, because the ids come from
     the provider. */
  assert.ok(!isEuropean('IS'));
  assert.ok(isEuropean('BH'));
});

test('what the viewer moved beats everything, in their sequence', () => {
  const rows = [m('US', 4000), m('NL', 400), m('BE', 200), m('TR', 900)];
  const order = ['TR', 'US'];
  assert.deepEqual(marketSort(rows, order).map((x) => x.id), ['TR', 'US', 'NL', 'BE']);
});

test('an order naming a market that no longer exists is harmless', () => {
  const rows = [m('NL', 400), m('BE', 200)];
  assert.deepEqual(marketSort(rows, ['GONE', 'BE']).map((x) => x.id), ['BE', 'NL']);
});

/* ── the fuller ranking: UK, the owner's Europe, the rest of Europe, every
   other country, then everything that is not a country ──────────────────── */

test('the United Kingdom is first, ahead of the owner\'s other defaults and any size', () => {
  /* Reported against a photo of 1.19.1's list mode: "show UK then others UK
     and other Europe countries after it". UKF and GB (10 and 3 channels) still
     lead ES and US at 5,000 and 9,000. */
  const rows = [m('US', 9000), m('ES', 5000), m('UKF', 10), m('GB', 3)];
  assert.deepEqual(marketSort(rows).map((x) => x.id), ['UKF', 'GB', 'ES', 'US']);
});

test("the owner's European defaults keep the owner's own order, not size", () => {
  /* Spain, Netherlands, Belgium, Italy, in that order regardless of channel
     count — "in the owner's own order" is the request, not a coincidence of
     which one this catalogue happens to carry the most of. DE (Germany, not
     one of the four) outsizes all of them and still lands after every one. */
  const rows = [m('IT', 50), m('BE', 5000), m('NL', 40), m('ES', 30), m('DE', 9999)];
  assert.deepEqual(marketSort(rows).map((x) => x.id), ['ES', 'NL', 'BE', 'IT', 'DE']);
});

test('the rest of Europe, once the owner\'s four are placed, is still by size', () => {
  const rows = [m('NL', 100), m('DE', 200), m('FR', 900), m('PL', 50)];
  assert.deepEqual(marketSort(rows).map((x) => x.id), ['NL', 'FR', 'DE', 'PL']);
});

test('every other country is by size, and the US is just one of them', () => {
  /* No special case for the US: it sorts on channel count beside Brazil,
     Turkey and Canada like any other non-European country. */
  const rows = [m('US', 4000), m('BR', 900), m('TR', 200), m('CA', 5000)];
  assert.deepEqual(marketSort(rows).map((x) => x.id), ['CA', 'US', 'BR', 'TR']);
});

test('non-country markets rank after every country, whatever their size', () => {
  /* EN (language), ASIA (region) and MU (topic) all dwarf BR, and none of them
     is a country — rule 5 puts all three after it regardless. */
  const rows = [m('EN', 20000), m('ASIA', 8000), m('MU', 500), m('BR', 30)];
  assert.deepEqual(marketSort(rows).map((x) => x.id), ['BR', 'EN', 'ASIA', 'MU']);
});

test("the viewer's own order still wins, even over the United Kingdom", () => {
  /* Rule 1 is unconditional: an id the viewer placed outranks everything
     below it, including rule 2's own United Kingdom. */
  const rows = [m('UK', 9000), m('MU', 10), m('US', 500)];
  assert.deepEqual(marketSort(rows, ['MU']).map((x) => x.id), ['MU', 'UK', 'US']);
});

test('moving up swaps with the row above it, as seen', () => {
  const shown = [{ id: 'NL' }, { id: 'BE' }, { id: 'FR' }, { id: 'US' }];
  assert.deepEqual(moveMarket(shown, 'FR', -1), ['NL', 'FR', 'BE']);
});

test('moving down swaps with the row below it', () => {
  const shown = [{ id: 'NL' }, { id: 'BE' }, { id: 'FR' }];
  assert.deepEqual(moveMarket(shown, 'NL', 1), ['BE', 'NL']);
});

test('the ends are walls, not wraps', () => {
  const shown = [{ id: 'NL' }, { id: 'BE' }];
  assert.deepEqual(moveMarket(shown, 'NL', -1), ['NL', 'BE']);
  assert.deepEqual(moveMarket(shown, 'BE', 1), ['NL', 'BE']);
});

test('a move is applied to what is on screen, then read back the same way', () => {
  /* The property that matters: sorting by the order a move produced puts the
     moved row where the viewer saw it go. */
  const rows = [m('US', 4000), m('NL', 400), m('BE', 200)];
  const shown = marketSort(rows);
  const order = moveMarket(shown, 'US', -1);
  assert.deepEqual(marketSort(rows, order).map((x) => x.id), ['NL', 'US', 'BE']);
});
