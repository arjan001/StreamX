/**
 * Links must survive a re-ingest.
 *
 * `item.id` is a per-generation bigserial: the generation live when this was
 * written started at 404,353 where its predecessor ended at 317,343. Every link
 * built from an `id` therefore died at the next refresh — a bookmark, a shared
 * URL, the `?ch=` in a reopened tab, a Continue card. These tests pin the
 * replacement: `<kind>.<provider id>`, which the provider keeps stable.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { linkId, type Item } from './api.ts';

const row = (over: Partial<Item> = {}): Item => ({
  id: 404353, ref: '1.2116347', kind: 1, categoryId: null, streamId: 2116347,
  name: 'FR| TF1 HD', logo: null, ext: null, tvgId: null,
  archive: false, archiveDays: 0, rating: null, year: null, direct: false,
  ...over,
});

test('a link uses the stable ref, never the row id', () => {
  assert.equal(linkId(row()), '1.2116347');
});

test('the kind is part of the ref, because stream_id repeats across kinds', () => {
  // A channel and a film really do share provider ids on this catalogue, so a
  // ref without the kind would resolve to whichever the query found first.
  assert.notEqual(linkId(row({ kind: 1, ref: '1.900' })), linkId(row({ kind: 2, ref: '2.900' })));
});

test('an entry with no provider id falls back to the row id', () => {
  // Opaque third-party entries have no stream_id, and the on-device catalogue's
  // ids are its own. For both, the row id is the only name there is.
  assert.equal(linkId(row({ ref: null, id: 77 })), '77');
});

test('a row id is stringified, so it is still a usable path segment', () => {
  assert.equal(typeof linkId(row({ ref: null })), 'string');
});

/**
 * The player's per-stream key.
 *
 * Two decisions are "once per stream" and both go global if the key does not
 * distinguish them: the escalation to the compatible transport, which then only
 * ever works for the first channel of a session, and the learned-engine list,
 * which after one entry claims every stream needs libVLC.
 *
 * It has been wrong twice, in opposite directions. Behind the relay every URL was
 * `/api/relay?s=…`, so the last two path segments were the literal string
 * `api/relay` for the whole catalogue — one key for everything. With the relay
 * gone the same rule takes `<password>/<id>.ext` from a provider URL, which is
 * unique per stream and writes the subscription's password into `kv`.
 *
 * So it keys on the kind and the final segment, which is unique per stream and
 * contains nothing secret.
 */
import { streamKey } from './nativePlayer.ts';

test('two streams do not collapse to the same key', () => {
  const a = streamKey('http://panel/live/user/pass/2116347.m3u8');
  const b = streamKey('http://panel/live/user/pass/2116348.m3u8');
  assert.notEqual(a, b);
});

test('the same stream keys consistently, across hosts and credentials', () => {
  // A failover to another mirror, or a password change, is the same channel.
  assert.equal(
    streamKey('http://panel-a/live/user/pass/2116347.m3u8'),
    streamKey('https://panel-b/live/other/secret/2116347.m3u8'),
  );
});

test('a key never carries the subscription', () => {
  /*
   * Invented credentials, not real ones.
   *
   * This test was written with a LIVE username and password pasted into it,
   * which is how a working subscription ends up in a public git history — the
   * file is a test, nobody reads it twice, and the strings look like the random
   * hex a panel issues because that is exactly what they were. The assertion
   * works identically against values that were never valid anywhere.
   */
  const user = 'aaaaaaaaaa';
  const pass = 'bbbbbbbbbbbb';
  const key = streamKey(`https://panel/live/${user}/${pass}/2116347.m3u8`);
  assert.equal(key, 'live/2116347.m3u8');
  assert.ok(!key.includes(pass), key);
  assert.ok(!key.includes(user), key);
});

test('a playlist entry has no kind segment, so its host is the stable part', () => {
  assert.equal(streamKey('https://broadcaster.example/hls/x/index.m3u8'),
    'broadcaster.example/index.m3u8');
});
