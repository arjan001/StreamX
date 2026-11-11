import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setKVBackend, type KVBackend } from '../kv.ts';
import { resolveHost } from './hosts.ts';

/**
 * `resolveHost`'s scheme priority: HTTP first, always.
 *
 * A sticky fast path that took its "known good" host from EITHER scheme would,
 * once the only fresh memo was an HTTPS address, probe that address alone, and
 * every hit would refresh the very memo that gave it the shortcut — nothing
 * would try HTTP again on that device. What is tested here: the shortcut is
 * HTTP-only, the full HTTP pool always gets a sweep before HTTPS is touched at
 * all, and a host that refused earlier is merely reordered within that HTTP
 * sweep, never dropped out of it.
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

/** Matches `hosts.ts`'s private `MEMO_KEY`. */
const MEMO_KEY = 'iptv.hosts.v2';

function seedMemo(
  mem: KVBackend & { store: Map<string, string> },
  entries: Record<string, { ok: boolean; ms: number; at: number }>,
): void {
  mem.store.set(MEMO_KEY, JSON.stringify(entries));
}

type Fetch = typeof globalThis.fetch;

/** Run `body` with `fetch` replaced, and put the real one back either way. */
async function withFetch(stub: Fetch, body: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await body();
  } finally {
    /* In a `finally` so a leaked stub fails the next test to run, not this one. */
    globalThis.fetch = real;
  }
}

interface HostOutcome {
  /** 200 with a parsed `user_info.auth === 1`. */
  ok?: true;
  /** A non-2xx the panel actually answered with (404, 502, 513, ...). */
  status?: number;
  /** No answer at all — timeout, DNS, TLS, connection refused, CORS. */
  unreachable?: true;
}

/**
 * A fetch stub keyed by ORIGIN. Every host hits the same `/player_api.php`
 * path with different credentials in the query, so origin is all that tells
 * two hosts apart. Records every origin asked, in call order, so a test can
 * prove a scheme was never touched — or that one call preceded another.
 */
function hostRouter(table: Record<string, HostOutcome>): Fetch & { calls: string[] } {
  const f = ((url: string | URL) => {
    const origin = new URL(String(url)).origin;
    f.calls.push(origin);
    const outcome = table[origin];
    if (outcome === undefined || outcome.unreachable === true) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (outcome.status !== undefined) {
      return Promise.resolve({
        ok: false,
        status: outcome.status,
        text: () => Promise.resolve('<html>not json</html>'),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        user_info: {
          auth: '1', status: 'Active', active_cons: '0', max_connections: '1',
        },
        server_info: { url: new URL(origin).hostname, timezone: 'UTC' },
      })),
    } as unknown as Response);
  }) as unknown as Fetch & { calls: string[] };
  f.calls = [];
  return f;
}

/** The index of the last HTTP call and the first HTTPS call, to assert order. */
function schemeSplit(calls: string[]): { lastHttp: number; firstHttps: number } {
  let lastHttp = -1;
  let firstHttps = Infinity;
  calls.forEach((o, i) => {
    if (o.startsWith('http://')) lastHttp = Math.max(lastHttp, i);
    if (o.startsWith('https://')) firstHttps = Math.min(firstHttps, i);
  });
  return { lastHttp, firstHttps };
}

test('a remembered-good HTTPS host does not short-circuit past an untried HTTP host', async () => {
  const mem = memoryKV();
  setKVBackend(mem);
  /* The shape of a device that authenticated over HTTPS once, an hour ago,
     and has not been asked to sign in since. */
  seedMemo(mem, { 'https://vpn-a.test': { ok: true, ms: 90, at: Date.now() } });
  const f = hostRouter({
    'http://vpn-a.test': { ok: true },
    'https://vpn-a.test': { ok: true },
  });
  await withFetch(f, async () => {
    const { chosen, tried } = await resolveHost('vpn-a.test', 'user', 'pass');
    assert.equal(chosen?.host, 'http://vpn-a.test');
    assert.equal(chosen?.secure, false);
    assert.ok(
      !f.calls.some((o) => o.startsWith('https://')),
      `HTTPS must not be touched while an untried HTTP host exists: ${f.calls.join(', ')}`,
    );
    assert.ok(tried.every((t) => !t.secure), 'nothing over TLS should have been probed');
  });
});

test('HTTPS is chosen only once every HTTP host has failed, remembered HTTPS host first', async () => {
  const mem = memoryKV();
  setKVBackend(mem);
  seedMemo(mem, { 'https://vpn-a.test': { ok: true, ms: 90, at: Date.now() } });
  const f = hostRouter({
    'http://vpn-a.test': { status: 404 },
    'http://vpn-b.test': { unreachable: true },
    'https://vpn-a.test': { ok: true },
    'https://vpn-b.test': { ok: true },
  });
  await withFetch(f, async () => {
    const { chosen, tried } = await resolveHost('vpn-a.test', 'user', 'pass', ['vpn-b.test']);
    assert.equal(chosen?.host, 'https://vpn-a.test');
    assert.equal(chosen?.secure, true);
    /* Both HTTP hosts were actually asked, not skipped past, before HTTPS won. */
    assert.ok(tried.some((t) => t.host === 'http://vpn-a.test'));
    assert.ok(tried.some((t) => t.host === 'http://vpn-b.test'));
    const { lastHttp, firstHttps } = schemeSplit(f.calls);
    assert.ok(
      lastHttp >= 0 && firstHttps < Infinity && lastHttp < firstHttps,
      `every HTTP call must precede every HTTPS call: ${f.calls.join(', ')}`,
    );
  });
});

test('an HTTP host that refused earlier is still swept on HTTP before HTTPS is ever touched', async () => {
  const mem = memoryKV();
  setKVBackend(mem);
  /* Refused a moment ago — well inside the day-long skip window. */
  seedMemo(mem, { 'http://vpn-a.test': { ok: false, ms: 50, at: Date.now() } });
  const f = hostRouter({ 'http://vpn-a.test': { ok: true } });
  await withFetch(f, async () => {
    const { chosen } = await resolveHost('vpn-a.test', 'user', 'pass');
    assert.equal(
      chosen?.host, 'http://vpn-a.test',
      'a same-day refusal must not be the reason an HTTP host is skipped entirely',
    );
    assert.ok(
      !f.calls.some((o) => o.startsWith('https://')),
      `recovering a refused HTTP host must not fall through to HTTPS: ${f.calls.join(', ')}`,
    );
  });
});

test('a host that refused today is reordered behind a peer HTTP host, not dropped from the sweep', async () => {
  const mem = memoryKV();
  setKVBackend(mem);
  seedMemo(mem, { 'http://vpn-a.test': { ok: false, ms: 50, at: Date.now() } });
  const f = hostRouter({
    'http://vpn-a.test': { ok: true },
    'http://vpn-b.test': { ok: true },
  });
  await withFetch(f, async () => {
    const { chosen, tried } = await resolveHost('vpn-a.test', 'user', 'pass', ['vpn-b.test']);
    /* The untried host wins the race... */
    assert.equal(chosen?.host, 'http://vpn-b.test');
    /* ...but the refused one was still IN this HTTP sweep, not excluded from it. */
    assert.ok(
      tried.some((t) => t.host === 'http://vpn-a.test'),
      `the refused host must still have been probed: ${tried.map((t) => t.host).join(', ')}`,
    );
  });
});

test('a refused HTTPS host is reordered behind a peer in the fallback, not dropped from it', async () => {
  /* Belt and braces on the fallback itself: once every HTTP host has failed,
     HTTPS gets the same "reorder, do not drop" treatment HTTP got above. */
  const mem = memoryKV();
  setKVBackend(mem);
  seedMemo(mem, { 'https://vpn-a.test': { ok: false, ms: 50, at: Date.now() } });
  const f = hostRouter({
    'http://vpn-a.test': { unreachable: true },
    'http://vpn-b.test': { unreachable: true },
    'https://vpn-a.test': { ok: true },
    'https://vpn-b.test': { ok: true },
  });
  await withFetch(f, async () => {
    const { chosen, tried } = await resolveHost('vpn-a.test', 'user', 'pass', ['vpn-b.test']);
    /* Neither HTTP host answers, so HTTPS is reached; the untried HTTPS host
       wins over the one that refused earlier... */
    assert.equal(chosen?.host, 'https://vpn-b.test');
    /* ...but the refused one was still probed, not excluded from the fallback. */
    assert.ok(
      tried.some((t) => t.host === 'https://vpn-a.test'),
      `the refused HTTPS host must still have been probed: ${tried.map((t) => t.host).join(', ')}`,
    );
  });
});

/**
 * A sign-in that reaches none of the given hosts ends there, having asked
 * nothing else. `hostRouter` parses every URL it is handed as an absolute
 * origin, so a relative call would throw inside the stub and fail this test on
 * its own.
 */
test('every host unreachable ends the sign-in, having asked only those hosts', async () => {
  const mem = memoryKV();
  setKVBackend(mem);
  const f = hostRouter({});
  await withFetch(f, async () => {
    const { chosen, tried } = await resolveHost('vpn-a.test', 'user', 'pass', ['vpn-b.test']);
    assert.equal(chosen, null);
    assert.ok(tried.length > 0 && tried.every((t) => t.verdict === 'unreachable'));
    assert.ok(
      f.calls.every((c) => c === 'http://vpn-a.test' || c === 'http://vpn-b.test'
        || c === 'https://vpn-a.test' || c === 'https://vpn-b.test'),
      `only the hosts themselves may be asked: ${f.calls.join(', ')}`,
    );
  });
});

test('the host that let this account in last is asked alone, even when the memo is stale', async () => {
  /* Three hours ago: past the sticky hour. */
  const mem = memoryKV();
  setKVBackend(mem);
  seedMemo(mem, { 'http://vpn-a.test': { ok: true, ms: 80, at: Date.now() - 3 * 3600_000 } });
  const f = hostRouter({ 'http://vpn-a.test': { ok: true } });
  await withFetch(f, async () => {
    const { chosen } = await resolveHost('vpn-a.test', 'user', 'pass', ['vpn-b.test', 'vpn-c.test']);
    assert.equal(chosen?.host, 'http://vpn-a.test');
    assert.deepEqual(f.calls, ['http://vpn-a.test'], `only the account's own host: ${f.calls.join(', ')}`);
  });
});

test('and when that host fails, the others are still swept', async () => {
  const mem = memoryKV();
  setKVBackend(mem);
  seedMemo(mem, { 'http://vpn-a.test': { ok: true, ms: 80, at: Date.now() - 3 * 3600_000 } });
  const f = hostRouter({ 'http://vpn-a.test': { status: 404 }, 'http://vpn-b.test': { ok: true } });
  await withFetch(f, async () => {
    const { chosen } = await resolveHost('vpn-a.test', 'user', 'pass', ['vpn-b.test']);
    assert.equal(chosen?.host, 'http://vpn-b.test');
  });
});
