import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArchiveUrl, normaliseServerUrl } from '@iptv/core-xtream';
import { setKVBackend, type KVBackend } from './kv.ts';
import {
  buildLocalArchiveTarget, cachedArchiveFamily, gateArchiveRequest, probeArchiveFamily,
  rememberArchiveFamily,
} from './localArchive.ts';

/**
 * Catch-up, built on the device.
 *
 * What is tested here is everything that does not need a browser or a panel:
 * the gate applied before a URL is ever built, the target
 * shape handed to the player, the per-provider family memo, and the CHOICES
 * `probeArchiveFamily` makes when a fetch is stubbed. The URL shapes themselves
 * (`buildArchiveUrl`, `archiveStamp`, `archiveMinutes`) are already covered in
 * `packages/core-xtream/test/urls.test.ts` and `providers/playback.test.ts`;
 * this file cross-checks against them rather than re-asserting their strings.
 *
 * `localArchivePlay` — the orchestrator that reads the local catalogue and the
 * active provider — has no test here, on purpose and by precedent: nothing in
 * `localRead.ts` that touches `localCatalogue()` does either (there is no
 * `localRead.test.ts`), because that state has no seam to inject in a unit
 * test. See the header of `localArchive.ts` for what was measured on a panel.
 */

/** A `kv` backend that lives in a Map, as the other lib tests use. */
function memoryKV(): KVBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  };
}

type Fetch = typeof globalThis.fetch;

/** Run `body` with `fetch` replaced, and put the real one back either way. */
async function withFetch(stub: Fetch, body: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

const fakeResponse = (status: number, contentType: string | null): Response => ({
  ok: status < 400,
  status,
  headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
  body: { cancel: () => Promise.resolve() },
}) as unknown as Response;

/** Every request gets the same answer. Counts how many were made. */
function always(status: number, contentType: string | null): Fetch & { calls: number } {
  const f = (() => {
    f.calls += 1;
    return Promise.resolve(fakeResponse(status, contentType));
  }) as unknown as Fetch & { calls: number };
  f.calls = 0;
  return f;
}

/**
 * Answers differently for the two URL families, told apart the same way a real
 * panel's routing does: `path` puts `/timeshift/` right after the host, `query`
 * puts `timeshift.php` behind `/streaming/` with no bare `/timeshift/` segment.
 */
function byFamily(
  answers: { query?: [number, string | null]; path?: [number, string | null] },
): Fetch & { calls: number } {
  const f = ((url: string) => {
    f.calls += 1;
    const which = /\/timeshift\//.test(String(url)) ? 'path' : 'query';
    const a = answers[which];
    return Promise.resolve(a === undefined ? fakeResponse(404, 'text/html') : fakeResponse(a[0], a[1]));
  }) as unknown as Fetch & { calls: number };
  f.calls = 0;
  return f;
}

const base = normaliseServerUrl('http://panel.example:8080');
const cred = { username: 'u@ser', password: 'p%ss' };
/* 30 minutes of programme; archiveMinutes adds its 2-minute boundary tail -> 32. */
const win = { startTs: 1_756_000_000, stopTs: 1_756_001_800 };

/* ── gateArchiveRequest ───────────────────────────────────────────────────── */

test('start/stop must be finite epoch seconds with stop after start', () => {
  const row = { archive: true, archiveDays: 3 };
  const now = 2_000_000_000;
  assert.equal(gateArchiveRequest(row, NaN, now, now), 'start and stop are required epoch seconds');
  assert.equal(gateArchiveRequest(row, now, NaN, now), 'start and stop are required epoch seconds');
  assert.equal(gateArchiveRequest(row, now, now, now), 'start and stop are required epoch seconds');
  assert.equal(gateArchiveRequest(row, now, now - 1, now), 'start and stop are required epoch seconds');
});

test('a channel with no archive is refused even for an otherwise valid window', () => {
  const now = 2_000_000_000;
  assert.equal(
    gateArchiveRequest({ archive: false, archiveDays: 7 }, now - 3600, now - 3000, now),
    'this channel keeps no archive',
  );
});

test('a programme that has not aired yet is refused', () => {
  const now = 2_000_000_000;
  assert.equal(
    gateArchiveRequest({ archive: true, archiveDays: 7 }, now + 60, now + 120, now),
    'that programme has not aired yet',
  );
});

test("a programme outside the channel's own retention is refused, by name", () => {
  const now = 2_000_000_000;
  const start = now - 8 * 86_400; // 8 days back, channel keeps 7
  assert.equal(
    gateArchiveRequest({ archive: true, archiveDays: 7 }, start, start + 1800, now),
    'outside the archive window — this channel keeps 7 day(s)',
  );
});

test('archiveDays of zero still allows the last day, not nothing', () => {
  /* `(row.archiveDays > 0 ? row.archiveDays : 1) * 86_400`. A panel that has not
     reported a depth yet is not the same as a channel with no catch-up at all. */
  const now = 2_000_000_000;
  const withinADay = now - 12 * 3600;
  assert.equal(gateArchiveRequest({ archive: true, archiveDays: 0 }, withinADay, withinADay + 1800, now), null);
  const overADay = now - 25 * 3600;
  assert.equal(
    gateArchiveRequest({ archive: true, archiveDays: 0 }, overADay, overADay + 1800, now),
    'outside the archive window — this channel keeps 0 day(s)',
  );
});

test('the retention boundary itself is still inside the window', () => {
  const now = 2_000_000_000;
  const depth = 2 * 86_400;
  assert.equal(
    gateArchiveRequest({ archive: true, archiveDays: 2 }, now - depth, now - depth + 1800, now), null,
  );
  assert.equal(
    gateArchiveRequest({ archive: true, archiveDays: 2 }, now - depth - 1, now - depth + 1799, now),
    'outside the archive window — this channel keeps 2 day(s)',
  );
});

test('a well-formed, in-window request is waved through', () => {
  const now = 2_000_000_000;
  assert.equal(gateArchiveRequest({ archive: true, archiveDays: 3 }, now - 3600, now - 3000, now), null);
});

/* ── buildLocalArchiveTarget ──────────────────────────────────────────────── */

test('the target url is exactly what core-xtream builds for that family', () => {
  const target = buildLocalArchiveTarget(base, cred, 99, win, 'query');
  assert.equal(target.url, buildArchiveUrl(base, cred, 99, win, 'query'));
  const pathTarget = buildLocalArchiveTarget(base, cred, 99, win, 'path');
  assert.equal(pathTarget.url, buildArchiveUrl(base, cred, 99, win, 'path'));
});

test('the target shape is what the player expects from a recording, not a live stream', () => {
  const target = buildLocalArchiveTarget(base, cred, 99, win, 'query');
  assert.equal(target.container, 'mpegts');
  assert.equal(target.direct, true);
  assert.equal(target.isLive, false);
  assert.equal(target.minutes, 32);
});

test('the note starts with "archive" so Catchup.tsx shows it with diagnostics off', () => {
  /* Catchup.tsx: `note !== null && (showDiagnostics() || note.startsWith('archive'))`.
     A note that does not start with the word is invisible on a phone or the TV
     app, which is the audience that most needs to know it is watching a
     recording, not live. */
  const target = buildLocalArchiveTarget(base, cred, 99, win, 'path');
  assert.equal(target.notes.length, 1);
  assert.match(target.notes[0]!, /^archive:/);
  assert.match(target.notes[0]!, /32 min/);
  assert.match(target.notes[0]!, /path/);
});

/* ── cachedArchiveFamily / rememberArchiveFamily ──────────────────────────── */

test('a family survives a round trip, kept separately per provider', () => {
  setKVBackend(memoryKV());
  assert.equal(cachedArchiveFamily(1), null);
  rememberArchiveFamily(1, 'query');
  assert.equal(cachedArchiveFamily(1), 'query');
  /* A second subscription (a viewer with two providers) gets its own slot,
     because the family is a trait of the PANEL SOFTWARE, not of this device. */
  assert.equal(cachedArchiveFamily(2), null);
  rememberArchiveFamily(2, 'path');
  assert.equal(cachedArchiveFamily(1), 'query');
  assert.equal(cachedArchiveFamily(2), 'path');
});

test('rubbish in storage is not a family', () => {
  const mem = memoryKV();
  setKVBackend(mem);
  for (const junk of ['', 'QUERY', 'both', '{"family":"query"}', 'null', 'query ']) {
    mem.store.set('iptv.archive.family.v1.1', junk);
    assert.equal(cachedArchiveFamily(1), null, junk);
  }
});

/* ── probeArchiveFamily ────────────────────────────────────────────────────── */

test('the first family that answers with video wins, without spending a second request', async () => {
  const f = always(206, 'video/mp2t');
  await withFetch(f, async () => {
    assert.equal(await probeArchiveFamily(base, cred, 99, win), 'query');
  });
  assert.equal(f.calls, 1);
});

test('a query endpoint that answers HTML falls back to the path family', async () => {
  const f = byFamily({ query: [200, 'text/html'], path: [206, 'video/mp2t'] });
  await withFetch(f, async () => {
    assert.equal(await probeArchiveFamily(base, cred, 99, win), 'path');
  });
  assert.equal(f.calls, 2);
});

test('a query endpoint that answers JSON (an error body) also falls back', async () => {
  const f = byFamily({ query: [200, 'application/json'], path: [206, 'video/mp2t'] });
  await withFetch(f, async () => {
    assert.equal(await probeArchiveFamily(base, cred, 99, win), 'path');
  });
});

test('neither family answering media is a clean null, not a throw', async () => {
  const f = always(404, 'text/html');
  await withFetch(f, async () => {
    assert.equal(await probeArchiveFamily(base, cred, 99, win), null);
  });
  assert.equal(f.calls, 2);
});

test('a rejected fetch (offline, aborted, DNS) fails that family rather than throwing', async () => {
  const f = (() => Promise.reject(new Error('offline'))) as unknown as Fetch;
  await withFetch(f, async () => {
    assert.equal(await probeArchiveFamily(base, cred, 99, win), null);
  });
});

test('the probe asks only for a small ranged slice, never the whole recording', async () => {
  const seen: string[] = [];
  const f = ((_url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    seen.push(headers?.['Range'] ?? '(none)');
    return Promise.resolve(fakeResponse(206, 'video/mp2t'));
  }) as unknown as Fetch;
  await withFetch(f, async () => {
    await probeArchiveFamily(base, cred, 99, win);
  });
  assert.deepEqual(seen, ['bytes=0-1023']);
});
