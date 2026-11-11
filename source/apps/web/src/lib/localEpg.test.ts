import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseEpg, XtreamHttpError, type EpgEntry } from '@iptv/core-xtream';
import {
  forgetHostRest,
  hostIsCorsBlocked,
  hostIsResting,
  isCorsShapedFailure,
  isTransientPanelFailure,
  noteCorsFailure,
  noteHostAnswered,
  noteTransientFailure,
  toSlots,
  withoutEmptyAsks,
  hostHasNoGuide, noteNoGuide, noteGuideAnswered, forgetNoGuide,
} from './localEpg.ts';

/* ── isCorsShapedFailure ──────────────────────────────────────────────────
   The shapes `fetchChannel` can actually see out of `client.epgTable()` /
   `client.shortEpg()`, and the rule for telling them apart. See the doc
   comment on `isCorsShapedFailure` in localEpg.ts for the measured evidence
   (panel.example.com answering `get_simple_data_table` with the wrong ACAO
   regardless of Origin, while every other EPG action on the same door is
   fine). */

test('a rejected fetch (TypeError, no status) is CORS-shaped', () => {
  // Chromium's wording for the browser-level rejection a CORS block produces.
  assert.equal(isCorsShapedFailure(new TypeError('Failed to fetch')), true);
  // Firefox's and Safari/WebKit's own wording for the identical rejection.
  assert.equal(
    isCorsShapedFailure(new TypeError('NetworkError when attempting to fetch resource.')),
    true,
  );
  assert.equal(isCorsShapedFailure(new TypeError('Load failed')), true);
});

test('an HTTP status error is never CORS-shaped, whatever the status', () => {
  // `XtreamHttpError` is what `fetchJson` throws for a real answer from the
  // panel — auth, flood protection, a dead backend. "Never fall back on an
  // HTTP error" means none of these may trip isCorsShapedFailure.
  for (const status of [401, 403, 456, 500, 502]) {
    const err = new XtreamHttpError(`epg_table: HTTP ${status} from /player_api.php`, status);
    assert.equal(isCorsShapedFailure(err), false, `status ${status} must not read as CORS`);
  }
});

test('a 200 that was not JSON is never CORS-shaped', () => {
  // fetchJson wraps "200 but not JSON" in the same XtreamHttpError as a bad
  // status (some providers disable an endpoint and return an HTML page).
  const err = new XtreamHttpError('epg_table: expected JSON, got <html>...', 200);
  assert.equal(isCorsShapedFailure(err), false);
});

test('our own timeout abort is never CORS-shaped', () => {
  // fetchJson aborts via AbortController with no reason, which rejects with a
  // DOMException named AbortError — never a TypeError.
  const abort = new DOMException('The operation was aborted.', 'AbortError');
  assert.equal(isCorsShapedFailure(abort), false);
  // Defence in depth: even an actual TypeError wearing that name must not
  // pass — the AbortError exclusion is a requirement, not inferred from the
  // TypeError check alone (see the doc comment).
  const disguised = new TypeError('aborted');
  Object.defineProperty(disguised, 'name', { value: 'AbortError' });
  assert.equal(isCorsShapedFailure(disguised), false);
});

test('anything that is not a TypeError is not CORS-shaped, even with the right words', () => {
  assert.equal(isCorsShapedFailure(new Error('Failed to fetch')), false); // wrong TYPE
  assert.equal(isCorsShapedFailure('Failed to fetch'), false);
  assert.equal(isCorsShapedFailure(null), false);
  assert.equal(isCorsShapedFailure(undefined), false);
});

/* ── per-host memory ──────────────────────────────────────────────────────
   `fetchChannel` calls `noteCorsFailure` only once a failure has already
   passed `isCorsShapedFailure`, and consults `hostIsCorsBlocked` before ever
   calling `epgTable` again. Every host name below is unique to its test:
   this Map is module-level state that outlives any one test in this file. */

test('a host is not blocked until its second recorded failure', () => {
  const host = 'trip.example.invalid';
  assert.equal(hostIsCorsBlocked(host), false, 'never asked about yet');
  noteCorsFailure(host);
  assert.equal(hostIsCorsBlocked(host), false, 'one failure must not trip it');
  noteCorsFailure(host);
  assert.equal(hostIsCorsBlocked(host), true, 'two failures trips it');
});

test('once blocked, a host stays blocked through further failures', () => {
  const host = 'stays-blocked.example.invalid';
  noteCorsFailure(host);
  noteCorsFailure(host);
  noteCorsFailure(host); // a third channel's failure, after the host already tripped
  assert.equal(hostIsCorsBlocked(host), true);
});

test('one host tripping never blocks a different host', () => {
  const blocked = 'blocked.example.invalid';
  const clean = 'clean.example.invalid';
  noteCorsFailure(blocked);
  noteCorsFailure(blocked);
  assert.equal(hostIsCorsBlocked(blocked), true);
  assert.equal(hostIsCorsBlocked(clean), false);
});

/* ── the short-EPG -> stored-listing conversion ───────────────────────────
   Rows shaped like the reference panel's actual get_short_epg reply,
   measured live against panel.example.com: it carries start_timestamp /
   stop_timestamp exactly like the full table, but the reply for the SAME
   channel carries no now_playing or has_archive key at all. */

function rawShortEpgRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1', epg_id: '1', title: 'TW9ybmluZyBOZXdz', lang: '',
    start: '2026-09-14 09:00:00', end: '2026-09-14 09:30:00',
    description: '', channel_id: '1',
    start_timestamp: '1789024800', stop_timestamp: '1789026600',
    stream_id: '2022589',
    ...overrides,
  };
}

test('a short-EPG reply becomes slots with the fields the guide reads', () => {
  const rows = normaliseEpg({ epg_listings: [rawShortEpgRow()] });
  const slots = toSlots(rows, true);
  assert.equal(slots.length, 1);
  assert.equal(slots[0]!.title, 'Morning News', 'base64 title decoded, same as the full table');
  assert.equal(slots[0]!.startTs, 1789024800);
  assert.equal(slots[0]!.stopTs, 1789026600);
});

test('upcomingOnly forces hasArchive off even if a fork sends has_archive on short EPG', () => {
  // The reference panel never sends this key on get_short_epg (measured),
  // but the fallback must not trust it even on a fork that does — a several-
  // programme forward window is never the panel's authoritative per-
  // programme archive signal, and DetailSheet.tsx / localRead.ts read
  // Slot.hasArchive on upcoming slots with no past/future check of their own.
  const rows = normaliseEpg({ epg_listings: [rawShortEpgRow({ has_archive: 1 })] });
  assert.equal(rows[0]!.hasArchive, true, 'sanity: normaliseEpg itself reads the field honestly');
  const slots = toSlots(rows, true);
  assert.equal(slots[0]!.hasArchive, false, 'the fallback path forces it off regardless');
});

test('without upcomingOnly (the full-table path), hasArchive passes through unchanged', () => {
  const rows = normaliseEpg({ epg_listings: [rawShortEpgRow({ has_archive: 1 })] });
  const slots = toSlots(rows, false);
  assert.equal(slots[0]!.hasArchive, true, 'the ordinary path is untouched by this fallback');
});

function entry(overrides: Partial<EpgEntry> & { startTs: number | null }): EpgEntry {
  return {
    title: null, description: null, stopTs: null, nowPlaying: false, hasArchive: false,
    ...overrides,
  };
}

test('a row with no start time is dropped, not stored with a fake start', () => {
  const rows = [entry({ startTs: null, title: 'No start' })];
  assert.equal(toSlots(rows, true).length, 0);
});

test('toSlots sorts by start time regardless of input order', () => {
  const rows = [
    entry({ startTs: 200, stopTs: 300, title: 'Second' }),
    entry({ startTs: 100, stopTs: 200, title: 'First' }),
  ];
  const slots = toSlots(rows, true);
  assert.equal(slots[0]!.title, 'First');
  assert.equal(slots[1]!.title, 'Second');
});

/* ── withoutEmptyAsks ──────────────────────────────────────────────────────
   The selection logic behind `clearEmptyAsksOnce`'s one-time purge (see its
   doc comment in localEpg.ts): every device that hit the pre-fallback CORS
   failure stored a `listings: 0` coverage entry via `fetchChannel`'s catch
   block, and `isFresh` (core-store) then leaves an entry like that alone for
   six hours, same as an honestly-empty channel. This is the pure rule for
   telling the two apart, tested here as plain objects so it never has to
   touch `blobs()` or `kv`. */

function coverageEntry(overrides: Partial<{
  streamId: number; listings: number; until: number | null;
  fetchedAt: number | null; lastReadAt: number;
}> = {}): {
  streamId: number; listings: number; until: number | null;
  fetchedAt: number | null; lastReadAt: number;
} {
  return {
    streamId: 1, listings: 0, until: null,
    fetchedAt: 1_789_000_000, lastReadAt: 1_789_000_000_000,
    ...overrides,
  };
}

test('withoutEmptyAsks drops an entry that recorded an ask with nothing back', () => {
  const idx = { '1': coverageEntry({ streamId: 1, listings: 0 }) };
  assert.deepEqual(withoutEmptyAsks(idx), {});
});

test('withoutEmptyAsks keeps an entry that has listings', () => {
  const covered = coverageEntry({ streamId: 2, listings: 12, until: 1_789_100_000 });
  const idx = { '2': covered };
  assert.deepEqual(withoutEmptyAsks(idx), { '2': covered });
});

test('withoutEmptyAsks drops only the empty-ask entries out of a mix, never a covered one', () => {
  const idx = {
    '1': coverageEntry({ streamId: 1, listings: 0 }),
    '2': coverageEntry({ streamId: 2, listings: 12, until: 1_789_100_000 }),
    '3': coverageEntry({ streamId: 3, listings: 0 }),
  };
  assert.deepEqual(withoutEmptyAsks(idx), { '2': idx['2'] });
});

test('withoutEmptyAsks does not mutate its input', () => {
  const idx = {
    '1': coverageEntry({ streamId: 1, listings: 0 }),
    '2': coverageEntry({ streamId: 2, listings: 12, until: 1_789_100_000 }),
  };
  const before = structuredClone(idx);
  withoutEmptyAsks(idx);
  assert.deepEqual(idx, before);
});

test('withoutEmptyAsks is idempotent: a second pass changes nothing further', () => {
  const idx = {
    '1': coverageEntry({ streamId: 1, listings: 0 }),
    '2': coverageEntry({ streamId: 2, listings: 12, until: 1_789_100_000 }),
  };
  const once = withoutEmptyAsks(idx);
  const twice = withoutEmptyAsks(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(twice, { '2': idx['2'] });
});

/* ── a panel that cannot answer, told apart from one that has nothing ───── */

test('a server error and flood protection are "not now", not "nothing"', () => {
  for (const status of [500, 502, 503, 429, 456, 509, 511, 513]) {
    assert.equal(isTransientPanelFailure({ name: 'XtreamHttpError', status }), true, String(status));
  }
  /* Our own timeout: we never heard, so we know nothing either. */
  assert.equal(isTransientPanelFailure(Object.assign(new Error('x'), { name: 'AbortError' })), true);
});

test('and an answer stays an answer, whatever it says', () => {
  /* These the panel DID answer — an expired subscription must not be read as
     "try again later" and leave the guide asking for ever. */
  for (const status of [401, 403, 404, 200, 400]) {
    assert.equal(isTransientPanelFailure({ name: 'XtreamHttpError', status }), false, String(status));
  }
  assert.equal(isTransientPanelFailure(new TypeError('Failed to fetch')), false);
  assert.equal(isTransientPanelFailure(null), false);
  assert.equal(isTransientPanelFailure(undefined), false);
});

test('one failure is a fluke; two rest the host', () => {
  forgetHostRest();
  const t = 1_000_000;
  noteTransientFailure('panel.example', t);
  assert.equal(hostIsResting('panel.example', t), false, 'rested after a single failure');
  noteTransientFailure('panel.example', t);
  assert.equal(hostIsResting('panel.example', t), true);
  /* A minute later it is asked again rather than written off. */
  assert.equal(hostIsResting('panel.example', t + 61_000), false);
});

test('a host that keeps failing is left alone for longer, up to half an hour', () => {
  forgetHostRest();
  const t = 1_000_000;
  for (let i = 0; i < 2; i += 1) noteTransientFailure('slow.example', t);
  assert.equal(hostIsResting('slow.example', t + 61_000), false, 'first rest was not a minute');
  for (let i = 0; i < 8; i += 1) noteTransientFailure('slow.example', t);
  assert.equal(hostIsResting('slow.example', t + 29 * 60_000), true);
  assert.equal(hostIsResting('slow.example', t + 31 * 60_000), false, 'rested past the cap');
});

test('a host that answers starts again with a clean sheet', () => {
  forgetHostRest();
  const t = 1_000_000;
  noteTransientFailure('back.example', t);
  noteTransientFailure('back.example', t);
  assert.equal(hostIsResting('back.example', t), true);
  noteHostAnswered('back.example');
  assert.equal(hostIsResting('back.example', t), false);
  /* And its next failure is a first failure, not a third. */
  noteTransientFailure('back.example', t);
  assert.equal(hostIsResting('back.example', t), false);
});

test('one failing host does not rest another', () => {
  forgetHostRest();
  const t = 1_000_000;
  noteTransientFailure('a.example', t);
  noteTransientFailure('a.example', t);
  assert.equal(hostIsResting('a.example', t), true);
  assert.equal(hostIsResting('b.example', t), false);
});

/**
 * A door that authenticates, serves the catalogue, serves streams — and has no
 * guide at all.
 *
 *     List loading slower / it keep loading forever / it also gives milions of
 *     errors
 *
 * `panel.example.com`, measured 2026-09-24 with the live line: `get_short_epg`
 * answers 404 from nginx and `get_simple_data_table` answers 520, on both
 * schemes, neither carrying an `access-control-allow-origin`. In a WebView
 * that is not a status — it is an opaque rejection — and `fetchJson` retries
 * it five times with backoff to four seconds. The EPG scheduler runs one job
 * at a time, so a screen of channels jammed the single lane for minutes and
 * flooded the account into refusing playback on another device entirely.
 */
test('a door that cannot answer for a guide is asked twice, not once per channel', () => {
  forgetNoGuide();
  const host = 'panel.example.com';
  assert.equal(hostHasNoGuide(host), false, 'nothing known yet');
  noteNoGuide(host);
  assert.equal(hostHasNoGuide(host), false, 'one channel proves nothing');
  noteNoGuide(host);
  assert.equal(hostHasNoGuide(host), true, 'two in a row is the door, not the channel');
  /* And a different door is unaffected — the memo is per host, because that is
     what the evidence is about. */
  assert.equal(hostHasNoGuide('stream.example.com'), false, 'a different door');
});

test('one real answer clears the count', () => {
  forgetNoGuide();
  const host = 'edge.example.com';
  noteNoGuide(host);
  noteGuideAnswered(host);
  noteNoGuide(host);
  assert.equal(hostHasNoGuide(host), false, 'the run was broken by an answer');
});

test('a device with no network is not a door with no guide', () => {
  forgetNoGuide();
  const host = 'panel.example.com';
  const nav = globalThis.navigator as { onLine?: boolean } | undefined;
  const had = nav !== undefined && 'onLine' in nav ? nav.onLine : undefined;
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: false }, configurable: true,
  });
  try {
    /* Offline, every fetch is a TypeError — the same shape as the opaque
       rejection this memo reads. Counting those would blank the guide for the
       rest of the session over a tunnel. */
    noteNoGuide(host);
    noteNoGuide(host);
    noteNoGuide(host);
    assert.equal(hostHasNoGuide(host), false, 'nothing was learned while offline');
  } finally {
    if (had === undefined) {
      Reflect.deleteProperty(globalThis, 'navigator');
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: had }, configurable: true,
      });
    }
  }
});
