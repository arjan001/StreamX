/**
 * Persistence, against a Map rather than IndexedDB.
 *
 * The point of abstracting the store was to make exactly these cases testable
 * under Node: the atomic swap, the rollback slot, and the refusal to load a
 * half-written catalogue. All three are the difference between "the app shows
 * stale data" and "the app shows a working UI with content missing".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND, buildColumns, listItems, loadCatalogue, memoryStore, saveCatalogue,
  type Catalogue, type ItemDraft } from '../src/index.ts';

const draft = (name: string, sortIndex: number): ItemDraft => ({
  kind: KIND.Movie, streamId: sortIndex + 1, categoryId: 1, name, logo: null,
  compactName: name.toLowerCase().replace(/[^a-z0-9]/g, ''), normName: name.toLowerCase(),
  ext: 'mp4', tvgId: null,
  url: null, archive: false, archiveDays: 0, adult: false, direct: false,
  rating: 7, year: '2020', added: 100, sortIndex,
});

const build = (generation: number, names: string[]): Catalogue => ({
  generation,
  builtAt: generation * 1000,
  items: buildColumns(names.map(draft)),
  categories: [{
    id: 1, kind: KIND.Movie, remoteId: 'r1', name: 'EN | A', cleanName: 'A',
    genres: ['drama'], region: 'EN', source: null, path: ['EN', 'A'], itemCount: names.length,
    sortIndex: 0,
  }],
  counts: { live: 0, movies: names.length, series: 0 },
});

test('a catalogue round-trips through the store intact', async () => {
  const store = memoryStore();
  await saveCatalogue(store, build(1, ['Alpha', 'Beta', "Gamma's Edge"]));
  const back = await loadCatalogue(store);
  assert.ok(back);
  assert.equal(back.generation, 1);
  assert.equal(back.items.count, 3);
  const page = listItems(back, { kind: KIND.Movie, sort: 'name' });
  assert.deepEqual(page.rows.map((r) => r.name), ['Alpha', 'Beta', "Gamma's Edge"]);
  assert.equal(back.categories[0]!.path.join('/'), 'EN/A');
});

test('nine-ish records, not one per item', async () => {
  const store = memoryStore();
  await saveCatalogue(store, build(1, Array.from({ length: 500 }, (_, i) => `Film ${i}`)));
  const keys = await store.keys();
  assert.ok(keys.length < 25, `expected a handful of records, got ${keys.length}`);
});

test('the pointer moves last, so a reader never sees a half-written generation', async () => {
  const store = memoryStore();
  await saveCatalogue(store, build(1, ['One']));
  // Simulate a crash during the next build: columns written, pointer not.
  const half = build(2, ['Two', 'Three']);
  await store.put('catalogue.g2.meta', { count: 2, builtAt: 2, counts: half.counts });
  await store.put('catalogue.g2.kind', half.items.kind);
  const back = await loadCatalogue(store);
  assert.equal(back?.generation, 1, 'still the complete generation');
  assert.equal(back?.items.count, 1);
});

test('one generation back is kept as a rollback slot, older ones are dropped', async () => {
  const store = memoryStore();
  await saveCatalogue(store, build(1, ['One']));
  await saveCatalogue(store, build(2, ['Two']));
  await saveCatalogue(store, build(3, ['Three']));
  const keys = await store.keys();
  assert.equal(keys.some((k) => k.startsWith('catalogue.g3.')), true);
  assert.equal(keys.some((k) => k.startsWith('catalogue.g2.')), true, 'rollback slot');
  assert.equal(keys.some((k) => k.startsWith('catalogue.g1.')), false, 'older is pruned');
});

test('a missing column is treated as no catalogue, not as an empty one', async () => {
  const store = memoryStore();
  await saveCatalogue(store, build(1, ['One', 'Two']));
  await store.delete('catalogue.g1.compact');
  assert.equal(await loadCatalogue(store), null);
});

test('a truncated column is refused, because it would misalign every field', async () => {
  const store = memoryStore();
  await saveCatalogue(store, build(1, ['One', 'Two', 'Three']));
  await store.put('catalogue.g1.kind', new Uint8Array(2));
  assert.equal(await loadCatalogue(store), null);
});

test('an empty store is null rather than an error', async () => {
  assert.equal(await loadCatalogue(memoryStore()), null);
});
