/**
 * The three rules that make automatic reporting safe to switch on.
 *
 * Off until an operator says otherwise; a few at a time rather than one request
 * per failure; and never a loop — the fetch wrapper records failed requests as
 * errors, so a flush that fails must not become the next thing to report.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_QUEUE, RESEND_MS, errorReportsEnabled, flush, flushBody, fold, noteError, queued,
  reportable, setErrorReportsEnabled, signature,
} from './errorReports.ts';

const entry = (text: string, tag = 'player', t = 1_000) =>
  ({ id: 1, t, level: 'error' as const, tag, text });

/* Every test leaves reporting off: that also clears the queue and, with it, the
   three-minute timer that would otherwise hold the test process open. */
afterEach(() => { setErrorReportsEnabled(false); });

test('nothing is queued until an operator turns it on', () => {
  noteError(entry('native: decoder refused'));
  assert.equal(errorReportsEnabled(), false);
  assert.equal(queued().length, 0);

  setErrorReportsEnabled(true);
  noteError(entry('native: decoder refused'));
  assert.equal(queued().length, 1);
});

test('switching it off throws away what was waiting', () => {
  /* Consent withdrawn is consent withdrawn for the queue too, not just for the
     next error. */
  setErrorReportsEnabled(true);
  noteError(entry('native: decoder refused'));
  setErrorReportsEnabled(false);
  assert.equal(queued().length, 0);
});

test('our own reporting endpoint is never reported', () => {
  /* The loop this prevents: a flush fails, the fetch wrapper records the
     failure as an error, the error is queued, the next flush fails. */
  assert.equal(reportable({ tag: 'fetch', text: 'TypeError /api/log/batch (12ms)' }), false);
  assert.equal(reportable({ tag: 'fetch', text: '500 h/api/log (12ms)' }), false);
  assert.equal(reportable({ tag: 'player', text: 'gave up' }), true);
  assert.equal(reportable({ tag: 'player', text: '   ' }), false);
});

test('a loop costs one line with a count on it, not four hundred lines', () => {
  let q = fold([], { tag: 'player', text: 'hls networkError', level: 'error', t: 10 });
  for (let i = 0; i < 399; i += 1) {
    q = fold(q, { tag: 'player', text: 'hls networkError', level: 'error', t: 20 + i });
  }
  assert.equal(q.length, 1);
  assert.equal(q[0]!.count, 400);
  /* The first occurrence is what dates the episode; later ones do not move it. */
  assert.equal(q[0]!.firstAt, 10);
});

test('two different failures stay two lines', () => {
  let q = fold([], { tag: 'player', text: 'hls networkError', level: 'error', t: 10 });
  q = fold(q, { tag: 'native', text: 'decoder refused', level: 'error', t: 11 });
  assert.deepEqual(q.map((x) => x.tag), ['player', 'native']);
});

test('the same text from a different part of the app is not the same error', () => {
  let q = fold([], { tag: 'player', text: 'gave up', level: 'error', t: 1 });
  q = fold(q, { tag: 'fetch', text: 'gave up', level: 'error', t: 2 });
  assert.equal(q.length, 2);
});

test('the queue is capped, and it keeps the first errors rather than the last', () => {
  /* What started an episode is the diagnosis; that it is still going is what the
     counts on those lines already say. */
  let q: ReturnType<typeof fold> = [];
  /* Distinct WORDS, not distinct numbers: lines that differ only by a number
     are one problem now — see `signature`. */
  const word = (i: number) => `failure ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
  for (let i = 0; i < MAX_QUEUE + 20; i += 1) {
    q = fold(q, { tag: 'player', text: word(i), level: 'error', t: i });
  }
  assert.equal(q.length, MAX_QUEUE);
  assert.equal(q[0]!.text, word(0));
});

test('what is sent carries the count and the age, not the device clock', () => {
  /* A television with the wrong date must not file its errors in the wrong week,
     so the age travels and this box does the stamping. */
  const body = flushBody(
    [{ tag: 'native', text: 'decoder refused', level: 'error', count: 3, firstAt: 1_000 }],
    126_000,
  );
  const [row] = body.entries as { tag: string; count: number; ago: number }[];
  assert.equal(row!.tag, 'native');
  assert.equal(row!.count, 3);
  assert.equal(row!.ago, 125);
  assert.ok(typeof body.device['Build'] === 'string', 'the build is always in the header');
});

test('a flush empties the queue and says whether it landed', async () => {
  const calls: { url: string; entries: unknown[] }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), entries: JSON.parse(init.body).entries });
    return { ok: true } as Response;
  }) as typeof fetch;
  try {
    setErrorReportsEnabled(true);
    noteError(entry('native: decoder refused'));
    noteError(entry('native: decoder refused'));
    noteError(entry('hls networkError'));
    assert.equal(await flush(), true);
    assert.equal(queued().length, 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/api\/log\/batch$/);
    assert.equal(calls[0]!.entries.length, 2, 'the repeat was folded');
  } finally {
    globalThis.fetch = original;
  }
});

test('a flush that cannot be sent is dropped, never re-queued', async () => {
  /* Re-queuing looks kinder and is not: the next flush fails the same way and
     the queue grows until diagnostics are the biggest thing in memory. */
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  try {
    setErrorReportsEnabled(true);
    noteError(entry('native: decoder refused'));
    assert.equal(await flush(), false);
    assert.equal(queued().length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('an empty queue sends nothing at all', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return { ok: true } as Response; }) as typeof fetch;
  try {
    setErrorReportsEnabled(true);
    assert.equal(await flush(), false);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

/* ── what is worth sending, and how often ─────────────────────────────────────
 * "make sure to send all of them to the server. Only the important logs, not
 * the logs that try other servers ... if there is multiple errors then send it
 * once". Measured before this: 30 hours of televisions sent twelve lines, all of
 * them door probes and free-channel CORS failures, and not one seek failure,
 * frozen picture or black screen. */

test('a failed request is never sent: whoever it broke says so in its own words', () => {
  assert.equal(reportable({ tag: 'fetch', level: 'error',
    text: 'TypeError: Failed to fetch vpn.example/player_api.php?username=<r> (370ms)' }), false);
  assert.equal(reportable({ tag: 'fetch', level: 'warn', text: '429 h/logo.png (80ms)' }), false);
});

test('the player trying another server is a step, not a finding', () => {
  for (const text of ['try door → http://vpn.example', 'door refused: 456',
    'retry over plain http', 'server says 404 text/html without bytes → refusedDoor']) {
    assert.equal(reportable({ tag: 'player', level: 'warn', text }), false, text);
  }
});

test('the moments a viewer notices are sent even though they are warnings', () => {
  for (const text of ['3s of sound with a frozen picture',
    'the decoder stopped — trying again in software',
    'seek to 1500s broke the native stream — reopening there',
    'escalate → native: MEDIA_ERR_DECODE']) {
    assert.equal(reportable({ tag: 'player', level: 'warn', text }), true, text);
  }
  assert.equal(reportable({ tag: 'exit', level: 'warn', text: 'dialog closed on a repeat' }), false);
  assert.equal(reportable({ tag: 'catalogue', level: 'error', text: 'the library could not be built — x' }), true);
});

test('the same problem with different numbers is one line with a count', () => {
  let q = fold([], { tag: 'player', text: 'stall on 1906058 after 12s (370ms)', level: 'warn', t: 1 });
  q = fold(q, { tag: 'player', text: 'stall on 2006009 after 40s (12ms)', level: 'warn', t: 2 });
  q = fold(q, { tag: 'player', text: 'stall on 55 after 3s', level: 'warn', t: 3 });
  assert.equal(q.length, 1);
  assert.equal(q[0]!.count, 3);
  assert.equal(signature('player', 'x?u=secret&p=1 y'), signature('player', 'x?u=other y'));
});

test('a device reports a problem once in half an hour, not every flush', async () => {
  setErrorReportsEnabled(true);
  const sent: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const now = Date.now();
    noteError({ id: 1, t: now, level: 'error', tag: 'player', text: 'gave up on 12' });
    assert.equal(await flush(), true);
    noteError({ id: 2, t: now + 1000, level: 'error', tag: 'player', text: 'gave up on 13' });
    assert.equal(queued().length, 0, 'the same problem, a second later: not queued again');
    noteError({ id: 3, t: now + RESEND_MS + 1000, level: 'error', tag: 'player', text: 'gave up on 14' });
    assert.equal(queued().length, 1, 'half an hour on, it is news again');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a slow press is reported — the remote taking seconds is something the viewer saw', () => {
  assert.equal(reportable({ tag: 'perf', level: 'warn', text: 'a press took 3.2 s on /sports — page busy 7.1 s of the last 10 s' }), true);
});
