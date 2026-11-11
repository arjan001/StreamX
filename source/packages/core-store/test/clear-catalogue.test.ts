/**
 * Deleting a subscription has to delete what it built.
 *
 * Three reports from the owner turned out to be one defect seen from three
 * sides: switching account showed the previous one's channels, removing an
 * account left its library on screen, and a restart brought the removed
 * account's rows back. The catalogue is DERIVED state that outlived its source —
 * the provider list changed and nothing threw the build away.
 *
 * `saveCatalogue` keeps one generation back as a rollback slot, so "clear" that
 * only moves the pointer is not clear at all: the next `loadCatalogue` finds the
 * previous generation and the deleted account is back. That is what these assert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND, buildColumns, clearCatalogue, loadCatalogue, memoryStore, saveCatalogue,
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

test('a cleared catalogue reads back as nothing at all', async () => {
  const store = memoryStore();
  await saveCatalogue(store, build(1, ['Alpha', 'Beta']));
  assert.ok(await loadCatalogue(store), 'precondition: there is one to clear');

  await clearCatalogue(store);
  assert.equal(await loadCatalogue(store), null);
});

test('the rollback slot goes too — otherwise the deleted account comes back', async () => {
  const store = memoryStore();
  /* Two builds, so the store holds a current generation AND the one kept behind
     it. Clearing only the current one would leave the previous build loadable,
     which is exactly "I removed it and it is still there after a restart". */
  await saveCatalogue(store, build(1, ['Alpha', 'Beta']));
  await saveCatalogue(store, build(2, ['Alpha', 'Beta', 'Gamma']));

  await clearCatalogue(store);

  assert.equal(await loadCatalogue(store), null);
  const left = (await store.keys()).filter((k) => k.startsWith('catalogue.'));
  assert.deepEqual(left, [], `nothing of any generation survives, found ${left.join(', ')}`);
});

test('clearing a store that holds nothing is not an error', async () => {
  /* Runs on every account switch, including the first one ever made. */
  const store = memoryStore();
  await clearCatalogue(store);
  assert.equal(await loadCatalogue(store), null);
});

test('other things in the same store are left alone', async () => {
  /* One IndexedDB database holds the catalogue, the raw payloads and the guide.
     A clear that took the payloads with it would turn every account switch into
     a fresh 159MB download from a line with one connection. */
  const store = memoryStore();
  await store.put('payloads.panel.2', { live: [] });
  await store.put('epg.channel.44', { programmes: [] });
  await saveCatalogue(store, build(1, ['Alpha']));

  await clearCatalogue(store);

  assert.deepEqual(await store.get('payloads.panel.2'), { live: [] });
  assert.deepEqual(await store.get('epg.channel.44'), { programmes: [] });
});
