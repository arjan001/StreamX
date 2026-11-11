import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointCandidates, hasMagPrefix, isValidMac, makeDevice, normaliseMac, parsePortalUrl, sha1Hex, StalkerError } from '../src/index.ts';
import { withPortal } from './helpers.ts';

test('portal URL forms reduce to the same origin and prefix', () => {
  for (const u of [
    'http://portal.example.com:8080',
    'portal.example.com:8080',
    'http://portal.example.com:8080/c/',
    'http://portal.example.com:8080/portal.php',
    'http://portal.example.com:8080/c/portal.php',
  ]) {
    const p = parsePortalUrl(u);
    assert.equal(p.origin, 'http://portal.example.com:8080', u);
    assert.equal(p.prefix, '', u);
  }
  const sp = parsePortalUrl('https://portal.example.com/stalker_portal/c/');
  assert.equal(sp.stalkerPortal, true);
  assert.equal(sp.referer, 'https://portal.example.com/stalker_portal/c/');
  const api = parsePortalUrl('http://portal.example.com/stalker_portal/server/load.php');
  assert.equal(api.explicitEndpoint, 'http://portal.example.com/stalker_portal/server/load.php');
  assert.equal(api.prefix, '');
  assert.equal(endpointCandidates(api)[0], api.explicitEndpoint);
  assert.deepEqual(endpointCandidates(parsePortalUrl('http://portal.example.com')), [
    'http://portal.example.com/portal.php',
    'http://portal.example.com/server/load.php',
    'http://portal.example.com/stalker_portal/server/load.php',
    'http://portal.example.com/c/portal.php',
    'http://portal.example.com/stalker_portal/c/portal.php',
  ]);
});

test('bad portal URLs are rejected', () => {
  assert.throws(() => parsePortalUrl('ftp://portal.example.com'), { code: 'bad_url' });
  assert.throws(() => parsePortalUrl('http://'), { code: 'bad_url' });
});

test('MAC validation and normalisation', () => {
  assert.equal(normaliseMac('00:1a:79:00:00:01'), '00:1A:79:00:00:01');
  assert.equal(normaliseMac('00-1A-79-00-00-01'), '00:1A:79:00:00:01');
  assert.equal(normaliseMac(' 001a79000001 '), '00:1A:79:00:00:01');
  for (const bad of ['', '00:1A:79:00:00', '00:1A:79:00:00:0G', '00:00:00:00:00:00', 'FF:FF:FF:FF:FF:FF']) {
    assert.equal(isValidMac(bad), false, bad);
  }
  assert.throws(() => normaliseMac('nope'), (e: unknown) => e instanceof StalkerError && e.code === 'bad_mac');
  assert.equal(hasMagPrefix('00:1A:79:00:00:01'), true);
  assert.equal(hasMagPrefix('10:27:BE:00:00:01'), false);
});

test('device identity: given values win, blanks are derived deterministically', () => {
  const a = makeDevice({ mac: '00:1A:79:00:00:01' });
  const b = makeDevice({ mac: '001a79000001' });
  assert.deepEqual(a, b);
  assert.equal(a.serial.length, 13);
  assert.equal(a.deviceId.length, 64);
  const c = makeDevice({ mac: '00:1A:79:00:00:01', serial: 'SN1', deviceId: 'D1', signature: 'S' });
  assert.equal(c.serial, 'SN1');
  assert.equal(c.deviceId, 'D1');
  assert.equal(c.signature, 'S');
  assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
});

test('endpoint discovery finds the path the portal answers on and remembers it', async () => {
  await withPortal({ endpoint: '/stalker_portal/server/load.php' }, {}, async (c, p) => {
    await c.connect();
    assert.equal(c.session?.endpoint, `${p.url}/stalker_portal/server/load.php`);
    const handshakes = p.log.filter((l) => l.query['action'] === 'handshake');
    assert.ok(handshakes.length >= 3, 'wrong candidates were probed first');
    const before = p.log.length;
    await c.liveCategories();
    assert.ok(p.log.slice(before).every((l) => l.path === '/stalker_portal/server/load.php'));
  });
});

test('no endpoint answering gives no_endpoint', async () => {
  await withPortal({ endpoint: '/somewhere/else.php' }, {}, async (c) => {
    await assert.rejects(c.connect(), { code: 'no_endpoint' });
  });
});

test('every request carries the box headers and cookie; token after handshake', async () => {
  await withPortal({}, { timezone: 'Europe/London' }, async (c, p) => {
    await c.liveCategories();
    const hs = p.log[0]!;
    assert.match(hs.headers['user-agent']!, /MAG200 stbapp/);
    assert.equal(hs.headers['x-user-agent'], 'Model: MAG250; Link: WiFi');
    assert.equal(hs.headers['referer'], `${p.url}/c/`);
    assert.equal(hs.headers['cookie'], 'mac=00%3A1A%3A79%3A00%3A00%3A01; stb_lang=en; timezone=Europe/London');
    assert.equal(hs.headers['authorization'], undefined);
    const last = p.log.at(-1)!;
    assert.match(last.headers['authorization']!, /^Bearer T/);
    const prof = p.log.find((l) => l.query['action'] === 'get_profile')!;
    for (const k of ['hd', 'ver', 'num_banks', 'sn', 'stb_type', 'image_version', 'device_id', 'device_id2', 'signature', 'auth_second_step', 'hw_version', 'not_valid_token', 'metrics', 'hw_version_2', 'timestamp', 'api_signature', 'prehash']) {
      assert.ok(k in prof.query, k);
    }
    assert.equal(prof.query['stb_type'], 'MAG250');
  });
});

test('wrong MAC gives an auth error, not a hang or endpoint error', async () => {
  await withPortal({}, { device: { mac: '00:1A:79:00:00:02' } }, async (c) => {
    await assert.rejects(c.connect(), { code: 'auth' });
  });
});

test('injected transport is used instead of global fetch', async () => {
  const seen: string[] = [];
  const { StalkerClient } = await import('../src/index.ts');
  const c = new StalkerClient({
    portalUrl: 'http://portal.example.com',
    device: { mac: '00:1A:79:00:00:01' },
    fetch: async (url) => {
      seen.push(url);
      return { status: 200, text: async () => JSON.stringify({ js: { token: 'abc' } }) };
    },
  });
  await c.connect();
  assert.ok(seen[0]!.startsWith('http://portal.example.com/portal.php?type=stb&action=handshake&token=&JsHttpRequest=1-xml'));
  assert.equal(c.session?.token, 'abc');
});
