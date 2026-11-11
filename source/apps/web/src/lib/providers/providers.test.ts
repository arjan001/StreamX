import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from './scheduler.ts';
import { candidates, candidatesBoth, isPanelStreamUrl, nextStreamOrigin, orderHosts, rewriteStreamOrigin } from './hosts.ts';
import { detectKind, redact } from './store.ts';
import { setKVBackend } from '../kv.ts';

/** A `kv` backend that lives in a Map, as the other lib tests use — here just
 * to seed `orderHosts`'s host memo (`iptv.hosts.v2`) deterministically. */
function memoryKV(): { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void; store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  };
}

test('the scheduler serves foreground before work already queued behind it', async () => {
  const s = new Scheduler();
  const order: string[] = [];
  const job = (name: string) => async () => { order.push(name); return name; };
  /* The first job starts immediately — there is nothing to be ahead of. What is
     being asserted is the ORDER of everything queued while it runs. */
  const first = s.submit('a', 'background', job('a'));
  const bg = s.submit('b', 'background', job('b'));
  const vis = s.submit('c', 'visible', job('c'));
  const fg = s.submit('d', 'foreground', job('d'));
  await Promise.all([first, bg, vis, fg]);
  assert.deepEqual(order, ['a', 'd', 'c', 'b']);
});

test('two callers asking for one key cost one request', async () => {
  const s = new Scheduler();
  let runs = 0;
  const run = async () => { runs++; return 'x'; };
  const block = s.submit('hold', 'background', () => new Promise((r) => setTimeout(r, 5)));
  const a = s.submit('same', 'background', run);
  const b = s.submit('same', 'background', run);
  assert.deepEqual(await Promise.all([block, a, b]), [undefined, 'x', 'x']);
  assert.equal(runs, 1, 'the panel counts requests, not callers');
});

test('re-asking at a higher band promotes rather than duplicating', async () => {
  const s = new Scheduler();
  const order: string[] = [];
  const job = (name: string) => async () => { order.push(name); return name; };
  const first = s.submit('hold', 'foreground', job('hold'));
  const low = s.submit('wanted', 'background', job('wanted'));
  const other = s.submit('other', 'visible', job('other'));
  const high = s.submit('wanted', 'foreground', job('wanted'));
  await Promise.all([first, low, other, high]);
  assert.deepEqual(order, ['hold', 'wanted', 'other'], 'promoted, and ran once');
});

test('clearing a band resolves its waiters instead of leaving them hanging', async () => {
  const s = new Scheduler();
  const first = s.submit('hold', 'foreground', () => new Promise((r) => setTimeout(r, 5)));
  const dropped = s.submit('row', 'visible', async () => 'never');
  s.clear('visible');
  // A guide row scrolled out of view is not an error; `null` is "not known yet".
  assert.equal(await dropped, null);
  await first;
});

test('panel hosts are HTTP first; HTTPS is a second pass only', () => {
  assert.deepEqual(candidates('line.example.com'), [
    'http://line.example.com',
  ]);
  assert.deepEqual(candidates('https://vpn.b.com', ['line.a.com'], 'https'), [
    'https://vpn.b.com', 'https://line.a.com',
  ]);
  assert.deepEqual(candidatesBoth('line.example.com'), [
    'http://line.example.com', 'https://line.example.com',
  ]);
  /* Every HTTP host before any HTTPS — a channel failing on a must try b over
     plaintext before a over TLS. */
  assert.deepEqual(candidatesBoth('https://vpn.b.com', ['line.a.com', 'vpn.b.com']), [
    'http://vpn.b.com', 'http://line.a.com',
    'https://vpn.b.com', 'https://line.a.com',
  ]);
});

test('orderHosts never moves the host in use, and hands back the list whole', () => {
  const hosts = ['http://vpn.b.com', 'http://line.a.com', 'https://vpn.b.com', 'https://line.a.com'];
  const out = orderHosts(hosts);
  assert.equal(out[0], 'http://vpn.b.com');
  assert.deepEqual([...out].sort(), [...hosts].sort());
  assert.deepEqual(orderHosts(['http://only.one']), ['http://only.one']);
});

test('orderHosts never lets a fresher HTTPS memo outrank an untried HTTP host', () => {
  /*
   * HTTP first, always. `vpn.b.com`'s HTTPS address has a fresh "authenticated
   * moments ago" memo, the shape of a base playback just adopted;
   * `line.a.com`'s HTTP address has never been tried at all. Putting every
   * fresh-memo address — of EITHER scheme — at the front of the list behind
   * the head would let the just-adopted HTTPS address outrank an HTTP host
   * nobody had even asked yet. Scheme must win that comparison, always.
   */
  const mem = memoryKV();
  setKVBackend(mem);
  mem.store.set('iptv.hosts.v2', JSON.stringify({
    'https://vpn.b.com': { ok: true, ms: 80, at: Date.now() },
  }));
  const hosts = ['http://vpn.b.com', 'http://line.a.com', 'https://vpn.b.com', 'https://line.a.com'];
  const out = orderHosts(hosts);
  assert.deepEqual(out, [
    'http://vpn.b.com', 'http://line.a.com', 'https://vpn.b.com', 'https://line.a.com',
  ]);
  assert.ok(
    out.indexOf('http://line.a.com') < out.indexOf('https://vpn.b.com'),
    `an untried HTTP host must precede a remembered-good HTTPS one: ${out.join(', ')}`,
  );
});

test('orderHosts keeps a refused-today HTTP host ahead of every HTTPS address', () => {
  /* A refusal reorders WITHIN its own scheme — to the back of the HTTP group —
     and must never drop a host into, or behind, HTTPS. */
  const mem = memoryKV();
  setKVBackend(mem);
  mem.store.set('iptv.hosts.v2', JSON.stringify({
    'http://line.a.com': { ok: false, ms: 40, at: Date.now() },
    'https://vpn.b.com': { ok: true, ms: 80, at: Date.now() },
  }));
  const hosts = [
    'http://vpn.b.com', 'http://line.a.com', 'http://other.c.com',
    'https://vpn.b.com', 'https://line.a.com', 'https://other.c.com',
  ];
  const out = orderHosts(hosts);
  assert.deepEqual(out, [
    'http://vpn.b.com', 'http://other.c.com', 'http://line.a.com',
    'https://vpn.b.com', 'https://line.a.com', 'https://other.c.com',
  ]);
});

test('a stream URL can move to another host without changing the path', () => {
  const url = 'http://panel.example.com/live/u/p/42.m3u8';
  assert.equal(
    rewriteStreamOrigin(url, 'http://backup.example.com'),
    'http://backup.example.com/live/u/p/42.m3u8',
  );
  assert.equal(
    rewriteStreamOrigin(url, 'https://backup.example.com'),
    'https://backup.example.com/live/u/p/42.m3u8',
  );
  assert.equal(isPanelStreamUrl(url), true);
  assert.equal(isPanelStreamUrl('https://broadcaster.example/hls/app.m3u8'), false);
});

test('the next host is the first origin that has not already been tried', () => {
  const bases = [
    'http://panel.example.com',
    'https://backup.example.com',
    'http://third.example.com',
  ];
  assert.equal(
    nextStreamOrigin('http://panel.example.com/live/u/p/1.m3u8', bases, new Set()),
    'https://backup.example.com',
  );
  assert.equal(
    nextStreamOrigin(
      'http://edge.example.com/live/play/token',
      bases,
      new Set(['http://panel.example.com']),
    ),
    'https://backup.example.com',
  );
  assert.equal(
    nextStreamOrigin(
      'http://third.example.com/live/u/p/1.m3u8',
      bases,
      new Set(['http://panel.example.com', 'https://backup.example.com', 'http://third.example.com']),
    ),
    null,
  );
});

test('a reseller M3U link is a playlist even though it came from a panel', () => {
  assert.equal(detectKind('http://x.com/get.php?username=a&password=b&type=m3u_plus'), 'm3u');
  assert.equal(detectKind('http://x.com/player_api.php'), 'xtream');
  assert.equal(detectKind('https://example.com/list.m3u8'), 'm3u');
  assert.equal(detectKind('line.example.com'), 'xtream');
});

test('nothing that identifies a subscription survives redaction', () => {
  const url = 'http://line.example.com/get.php?username=alice01&password=secret01&type=m3u';
  const out = redact(url);
  assert.ok(!out.includes('alice01'), out);
  assert.ok(!out.includes('secret01'), out);
  assert.equal(redact('http://user:secret@host/x'), 'http://<redacted>@host/x');
});
