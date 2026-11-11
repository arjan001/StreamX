import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Data that belongs to one subscription must be keyed by that subscription.
 *
 * Reported three ways on the same afternoon:
 *
 *   "when i switch accounts nothing happens and everything is as old shit"
 *   "also on profile remove or account, it doesnt clear"
 *
 * One cause. `payloads.panel`, the 159MB of rows behind every screen in the app,
 * was stored under one key for every account on the device, and the catalogue
 * built from it carried no record of whose it was. So the provider list could
 * change — switched, deleted, evicted — with nothing on screen changing at all,
 * and a restart read the same blob straight back.
 *
 * Measured before the fix, on the real line: after pressing USE on a different
 * account, rows=24 and the sidebar still read UK| NOW TV, UK| GENERAL, UK| BBCI.
 * After removing the subscription entirely: identical, and `payloads.panel` was
 * still in IndexedDB.
 *
 * These are source guards rather than behaviour tests because the invariant is
 * about every future writer, not about one code path. The behaviour itself is
 * covered by `core-store/test/clear-catalogue.test.ts` and by
 * `scripts/switch-probe.mjs`, which drives the three reports end to end.
 */
const read = async (rel: string): Promise<string> => {
  const { readFileSync } = await import('node:fs');
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
};

test('the panel payload is never stored under a key without an account id', async () => {
  const src = await read('./localCatalogue.ts');

  /* The bare string may survive in exactly one role: the pre-upgrade key, read
     once so a device that already holds 159MB adopts it instead of downloading
     it again. Anything else reintroduces the shared blob. */
  const bare = [...src.matchAll(/['"`]payloads\.panel['"`]/g)];
  const legacyDecl = /const PANEL_KEY_LEGACY = 'payloads\.panel';/.test(src);
  assert.ok(legacyDecl, 'the pre-upgrade key is still named, so upgrades still adopt their copy');
  assert.equal(bare.length, 1,
    `'payloads.panel' should appear once, as PANEL_KEY_LEGACY; found ${bare.length}`);

  assert.match(src, /const panelKey = \(id: number\): string => `payloads\.panel\.\$\{id\}`/,
    'the real key carries the provider id');

  for (const call of src.matchAll(/blobs\(\)\.(put|get)\(([^,)]+)/g)) {
    const key = call[2]!.trim();
    assert.ok(
      !/^['"`]payloads\.panel['"`]$/.test(key),
      `blobs().${call[1]}(${key}) uses the shared key — scope it with panelKey(id)`,
    );
  }
});

test('the built catalogue records which account it was built from', async () => {
  const src = await read('./localCatalogue.ts');
  assert.match(src, /const BUILT_FOR_KEY = 'iptv\.local\.builtFor'/);
  /* Without this the catalogue is unattributable and every reader has to assume
     it is theirs — which is the assumption that was wrong. */
  assert.match(src, /function catalogueIsStale\(\): boolean/);
  assert.ok(
    /kv\.set\(BUILT_FOR_KEY, String\(active\.id\)\)/.test(src),
    'a successful build stamps its owner',
  );
});

test('nothing to build from empties the library instead of keeping the last one', async () => {
  const src = await read('./localCatalogue.ts');
  const branch = src.slice(src.indexOf('if (m3u === null && panel === null) {'));
  const body = branch.slice(0, branch.indexOf('\n  }'));
  assert.ok(body.includes('catalogue = null'), 'the resident copy is dropped');
  assert.ok(body.includes('clearCatalogue'), 'and so is the copy on disk');
  assert.ok(body.includes('kv.remove(BUILT_FOR_KEY)'), 'and its owner stamp');
});

test('a stale catalogue is neither shown on launch nor left up during a refresh', async () => {
  const src = await read('./localCatalogue.ts');

  /* Launch: reading it back is how a removed subscription survived a restart. */
  assert.match(src, /const stored = catalogueIsStale\(\) \? null : await loadCatalogue\(blobs\(\)\)/);

  /* Refresh: a full rebuild is ~40s on this line, and leaving the previous
     account's rows up for those 40s is indistinguishable from a broken switch. */
  const refresh = src.slice(src.indexOf('async function doRefreshLocal'));
  const beforeFetch = refresh.slice(0, refresh.indexOf('return withPanel'));
  assert.ok(beforeFetch.includes('catalogueIsStale()'),
    'the stale check happens BEFORE the download, not after it');
  assert.ok(beforeFetch.includes('clearCatalogue'));
});

test('every way an account leaves the device also drops what it downloaded', async () => {
  assert.match(await read('./localCatalogue.ts'),
    /export async function forgetAccountData\(id: number\): Promise<void>/);

  /* The one caller of removeProvider: the viewer deleting a source, through
     `removeSource`, which the sheet calls. Its rows go with it. */
  const sources = await read('./sources.ts');
  assert.ok(sources.includes('removeProvider('), 'removeSource still removes a provider');
  assert.ok(sources.includes('forgetAccountData('), 'removeSource removes a provider without dropping its catalogue');
  assert.ok((await read('../components/SourcesSheet.tsx')).includes('removeSource('), 'the sheet goes through removeSource');
  /* And the one place that must NOT remove one any more: a panel that stops
     recognising a line keeps the account and says so (ExpiredDialog), so a
     renewal is one press rather than a sign-in from scratch. */
  const check = await read('./accountCheck.ts');
  assert.ok(!check.includes('removeProvider('), 'accountCheck deletes the account instead of flagging it');
  assert.ok(check.includes('setProblem('), 'accountCheck no longer records the problem the dialog shows');
});

test('no browsing screen claims the library is empty while it is being built', async () => {
  /* The two screens that draw a library from the on-device catalogue. Both must
     ask `listPhase`, which is the only thing that knows the difference between
     "this library holds none of these" and "this library is not finished yet".
     A third browsing screen added without it reintroduces the flash. */
  for (const f of ['../routes/Live.tsx', '../components/TitleGrid.tsx']) {
    const src = await read(f);
    assert.ok(src.includes('listPhase('), `${f} decides its empty state by hand`);
    assert.ok(src.includes('useLibraryBuilding()'),
      `${f} reads listPhase without the ingest state, so building is always false`);
  }
});
