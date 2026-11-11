import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KIND } from '@iptv/core-store';
// @ts-ignore -- plain .mjs without types
import { startFakePortal as start, FAKE_MAC } from '../../../../scripts/fake-stalker.mjs';
import { setKVBackend, kv } from './kv.ts';
import { setKeyStore, type KeyStore } from './providers/vault.ts';
import {
  activeProvider, allProviders, hydrateProviders, providersSettled, setStalkerTransport, withStalker,
} from './providers/index.ts';
import { addStalkerSource, removeSource, sourceTypesOffered, SOURCE_TYPES } from './sources.ts';
import { localCatalogue } from './localCatalogue.ts';
import { localItem } from './localRead.ts';
import { resetPlatformCache, stalkerSupportedOn } from './platform.ts';
import { stalkerPlay, stalkerArchivePlay } from './stalkerPlay.ts';
import { fetchChannel, storedSlots } from './localEpg.ts';
import { localPlay } from './localRead.ts';
import { redactSecrets } from './debugLog.ts';
import { StalkerError, type StalkerFetch } from '@iptv/core-stalker';

interface Portal {
  url: string;
  log: { path: string; query: Record<string, string>; headers: Record<string, string> }[];
  revokeTokens(): void;
  close(): Promise<void>;
}
const startPortal = start as (o?: Record<string, unknown>) => Promise<Portal>;

/** A node transport, as the native layer is on a phone: real network, real headers. */
const nodeTransport: StalkerFetch = (url, init) => fetch(url, { headers: init.headers });

const store = new Map<string, string>();
const g = globalThis as { __streamixPlatform?: string };
let portal: Portal;

function memoryKeys(): KeyStore {
  let held: CryptoKey | null = null;
  return { async get() { return held; }, async put(k: CryptoKey) { held = k; } };
}

beforeEach(async () => {
  store.clear();
  setKVBackend({
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  });
  setKeyStore(null);
  await hydrateProviders();
  for (const p of allProviders()) await removeSource(p.id, { keepDoor: true });
  g.__streamixPlatform = 'android';
  resetPlatformCache();
  setStalkerTransport(nodeTransport);
  portal = await startPortal({ pageSize: 4 });
});

afterEach(async () => {
  await portal.close();
  setStalkerTransport(null);
  delete g.__streamixPlatform;
  resetPlatformCache();
});

const add = (extra: Record<string, string> = {}) => addStalkerSource({ portal: portal.url, mac: FAKE_MAC, ...extra });

test('the portal option is offered on Android and iOS and nowhere else', () => {
  for (const [platform, shown] of [
    ['android', true], ['ios', true], ['web', false], ['tizen', false], ['webos', false],
  ] as const) {
    assert.equal(stalkerSupportedOn(platform), shown, platform);
    g.__streamixPlatform = platform;
    resetPlatformCache();
    const ids = sourceTypesOffered().map((t) => t.id);
    assert.equal(ids.includes('stalker'), shown, `${platform}: ${ids.join(',')}`);
  }
  /* The list itself still names it, for the platforms that offer it. */
  assert.ok(SOURCE_TYPES.some((t) => t.id === 'stalker' && t.label === 'Stalker portal'));
});

test('adding a portal on the web is refused, and nothing is saved', async () => {
  g.__streamixPlatform = 'web';
  resetPlatformCache();
  const res = await add();
  assert.equal(res.ok, false);
  assert.equal(allProviders().length, 0);
  assert.equal(portal.log.length, 0, 'not even a request');
});

test('a MAC address that is not one is refused before any request', async () => {
  for (const mac of ['', 'hello', '00:1A:79:00:00', '00:00:00:00:00:00']) {
    const res = await addStalkerSource({ portal: portal.url, mac });
    assert.equal(res.ok, false, mac);
    assert.match(res.message, /MAC/);
  }
  const noUrl = await addStalkerSource({ portal: 'ftp://x', mac: FAKE_MAC });
  assert.equal(noUrl.ok, false);
  assert.equal(portal.log.length, 0);
  assert.equal(allProviders().length, 0);
});

test('a portal becomes a source: the handshake session is kept and the catalogue is in the store', async () => {
  const res = await add({ name: 'Mine' });
  assert.equal(res.ok, true, res.message);
  const p = activeProvider()!;
  assert.equal(p.kind, 'stalker');
  assert.equal(p.name, 'Mine');
  assert.equal(p.mac, FAKE_MAC);
  assert.ok(p.stalkerSession?.token, 'the session is kept to skip the next handshake');
  /* The portal saw the box: a MAC cookie and a set-top-box agent, through the transport. */
  const first = portal.log[0]!;
  assert.match(first.headers['cookie'] ?? '', /mac=00%3A1A%3A79%3A00%3A00%3A01/);
  assert.match(first.headers['user-agent'] ?? '', /MAG200/);

  const cat = localCatalogue()!;
  const names = (kind: number) => [...Array(cat.items.count).keys()].filter((r) => cat.items.kind[r] === kind);
  /* 10 channels: three in the Adult genre and one flagged censored on its own are gone. */
  assert.equal(names(KIND.Live).length, 7);
  assert.equal(names(KIND.Movie).length, 10);
  assert.equal(names(KIND.Series).length, 1);
  const categoryNames = cat.categories.map((c) => c.name);
  assert.ok(!categoryNames.some((n) => /adult/i.test(n)), categoryNames.join(','));
  assert.ok(categoryNames.includes('News') && categoryNames.includes('Films'));
});

test('a second launch reuses the session instead of handshaking again', async () => {
  await add();
  const handshakes = () => portal.log.filter((l) => l.query['action'] === 'handshake').length;
  assert.equal(handshakes(), 1);
  await withStalker((c) => c.shortEpg('101', 1));
  assert.equal(handshakes(), 1, 'one client, one handshake');
  /* A fresh process: the client is gone, the stored session is not. */
  setStalkerTransport(nodeTransport);
  await withStalker((c) => c.shortEpg('101', 1));
  assert.equal(handshakes(), 1, 'the stored session was restored');
});

test('every identity field is sealed at rest, and none is in the plain list', async () => {
  setKeyStore(memoryKeys());
  await hydrateProviders();
  const res = await add({
    serial: 'SERIAL-0001', deviceId: 'DEVICE-ID-AAA', deviceId2: 'DEVICE-ID-BBB', signature: 'SIGNATURE-ZZZ',
  });
  assert.equal(res.ok, true, res.message);
  await providersSettled();
  const list = kv.get('iptv.providers.v1')!;
  for (const secret of [FAKE_MAC, 'SERIAL-0001', 'DEVICE-ID-AAA', 'DEVICE-ID-BBB', 'SIGNATURE-ZZZ']) {
    assert.ok(!list.includes(secret), `${secret} is readable in the stored list`);
  }
  assert.ok(!list.includes(activeProvider()!.stalkerSession!.token), 'the session token is sealed too');
  assert.ok(list.includes('"sealed":true'));
  /* And they come back after a restart. */
  await hydrateProviders();
  const back = activeProvider()!;
  assert.equal(back.mac, FAKE_MAC);
  assert.equal(back.serial, 'SERIAL-0001');
  assert.equal(back.signature, 'SIGNATURE-ZZZ');
});

test('a login is sent when one is given, and a wrong one fails with words, not a stack', async () => {
  await portal.close();
  portal = await startPortal({ login: { username: 'viewer', password: 'pw-123' } });
  const bad = await add({ username: 'viewer', password: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /portal/i);
  assert.equal(allProviders().length, 0, 'a failed add leaves nothing behind');
  const ok = await add({ username: 'viewer', password: 'pw-123' });
  assert.equal(ok.ok, true, ok.message);
});

test('playback resolves a fresh link every time, and can ask again', async () => {
  await add();
  const live = localItem('1.101');
  assert.ok(live !== null, 'channel 101 is in the catalogue');
  const asks = () => portal.log.filter((l) => l.query['action'] === 'create_link').length;
  assert.equal(localPlay('1.101'), null, 'no link is stored on the row: the device side cannot build one');
  const a = await stalkerPlay('1.101');
  assert.equal(asks(), 1);
  assert.match(a.url, /^http:\/\/stream\.example\.com\/live\/101\?token=/);
  assert.equal(a.container, 'mpegts');
  const b = await stalkerPlay('1.101');
  assert.equal(asks(), 2, 'resolved again for the second play');
  assert.notEqual(a.url, b.url, 'links are per play');
  /* The player's one retry on an open error. */
  const c = await a.reresolve!();
  assert.equal(asks(), 3);
  assert.notEqual(c.url, a.url);
  /* A film resolves through the vod module. */
  const film = await stalkerPlay('2.2001');
  assert.match(film.url, /vod\/2001\.mp4/);
  assert.equal(film.container, 'file');
});

test('an expired session while playing re-handshakes once and the link still comes', async () => {
  await add();
  portal.revokeTokens();
  const t = await stalkerPlay('1.102');
  assert.match(t.url, /live\/102/);
});

test('a link failure surfaces as a message a person can read', async () => {
  await add();
  await assert.rejects(stalkerPlay('1.999999'), /not on the portal/);
  setStalkerTransport(async () => { throw new StalkerError('network', 'socket hang up'); });
  await assert.rejects(stalkerPlay('1.101'), /could not be reached/);
});

test('the guide: short EPG is mapped to the same programme slots as every other source', async () => {
  await add();
  const ok = await fetchChannel(101);
  assert.equal(ok, true);
  const slots = (await storedSlots(101))!;
  assert.ok(slots.length >= 5);
  assert.equal(slots[0]!.title, 'Show 0');
  assert.equal(typeof slots[0]!.startTs, 'number');
  assert.ok(slots[0]!.stopTs! > slots[0]!.startTs);
  assert.ok(slots.every((s) => s.hasArchive === false), 'a forward window never claims catch-up');
});

test('catch-up is attempted only for a channel that keeps an archive', async () => {
  await add();
  const now = Math.floor(Date.now() / 1000);
  const keeps = localItem('1.101')!;
  assert.equal(keeps.archive, true);
  assert.equal(localItem('1.102')!.archive, false);
  const t = await stalkerArchivePlay('1.101', now - 3600, now - 1800);
  assert.match(t!.url, /archive\/1\.m3u8/);
  assert.equal(t!.minutes, 30);
});

test('removing a portal forgets its catalogue and side map', async () => {
  await add();
  const id = activeProvider()!.id;
  await removeSource(id, { keepDoor: true });
  assert.equal(allProviders().length, 0);
  assert.equal(localCatalogue(), null);
  assert.equal(localItem('1.101'), null);
});

test('the client log never carries the box identity or a token', () => {
  const lines = [
    'GET http://p/portal.php?type=stb&action=get_profile&sn=SN123456&device_id=DEVICEID1&device_id2=DEVICEID2&signature=SIGSIG&mac=00:1A:79:AA:BB:CC',
    'cookie: mac=00%3A1A%3A79%3AAA%3ABB%3ACC; stb_lang=en; timezone=UTC',
    'Cookie: mac=00%3A1A%3A79%3AAA%3ABB%3ACC; stb_lang=en',
    'Authorization: Bearer TOKENTOKEN123',
    'sent Bearer TOKENTOKEN456 to portal',
    '{"mac":"00:1A:79:AA:BB:CC","sn":"SN123456","token":"TOKENTOKEN789","serial":"SERIALX"}',
    'relay?u=http%3A%2F%2Fp%2Fportal.php%3Ftoken%3DTOKENTOKEN000%26mac%3D00%3A1A%3A79%3AAA%3ABB%3ACC',
    'box 00:1A:79:AA:BB:CC answered',
  ];
  for (const line of lines) {
    const out = redactSecrets(line);
    for (const secret of ['SN123456', 'DEVICEID1', 'DEVICEID2', 'SIGSIG', 'AA:BB:CC', 'AA%3ABB', 'TOKENTOKEN', 'SERIALX']) {
      assert.ok(!out.includes(secret), `${secret} survived in: ${out}`);
    }
  }
  /* What is not a secret is still readable. */
  assert.match(redactSecrets('GET portal.php?type=itv&action=get_genres'), /type=itv&action=get_genres/);
  assert.match(redactSecrets('Portal rejected the credentials (authorization failed)'), /authorization failed/);
});

test('a series opens through the portal and each episode resolves its own link at play time', async () => {
  const { localSeriesDetail } = await import('./localRead.ts');
  const { stalkerEpisodePlay } = await import('./stalkerPlay.ts');
  await add();
  const detail = (await localSeriesDetail('3.500'))!;
  assert.deepEqual(detail.detail.seasons, [1, 2]);
  assert.equal(detail.detail.episodes.length, 5);
  const ep = detail.detail.episodes[1]!;
  const before = portal.log.filter((l) => l.query['action'] === 'create_link').length;
  const t = await stalkerEpisodePlay(ep.episodeId);
  assert.match(t.url, /\?e=2$/);
  assert.equal(portal.log.filter((l) => l.query['action'] === 'create_link').length, before + 1);
  await assert.rejects(stalkerEpisodePlay(123456789), /Open the series again/);
});

test('the native transport hands back status and text and sends Cookie and User-Agent', async () => {
  /* `CapacitorHttp.request` in the shell; here Capacitor's own fallback, same contract. */
  const { nativeStalkerFetch } = await import('./providers/stalker.ts');
  const res = await nativeStalkerFetch(
    `${portal.url}/portal.php?type=stb&action=handshake&token=&JsHttpRequest=1-xml`,
    { headers: { Cookie: `mac=${encodeURIComponent(FAKE_MAC)}`, 'User-Agent': 'MAG200 transport-test' } },
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /"token"/);
  const seen = portal.log.at(-1)!.headers;
  assert.equal(seen['user-agent'], 'MAG200 transport-test');
  assert.match(seen['cookie'] ?? '', /mac=00%3A1A%3A79/);
  const refused = await nativeStalkerFetch(
    `${portal.url}/portal.php?type=stb&action=handshake`, { headers: { Cookie: 'mac=00%3A00%3A00%3A00%3A00%3A09' } },
  );
  assert.equal(refused.status, 200);
  assert.match(await refused.text(), /Authorization failed/);
});
