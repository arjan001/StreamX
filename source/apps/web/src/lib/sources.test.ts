import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { setKVBackend } from './kv.ts';
import { setKeyStore } from './providers/vault.ts';
import {
  activeProvider, allProviders, getProvider, hydrateProviders, providersSettled,
} from './providers/index.ts';
import { addPlaylistSource, addStreamSource, removeSource, sourceTypesOffered, useSource } from './sources.ts';
import { localPlay } from './localRead.ts';
import { blobs, localCatalogue, localStatus } from './localCatalogue.ts';
import { bulkSlots, guideUrlsFor, updateBulkGuide } from './bulkGuide.ts';
import { guideReader, GZIP_UNSUPPORTED } from './guideBody.ts';
import { getSession } from './session.ts';
import { KIND, readText } from '@iptv/core-store';

const store = new Map<string, string>();
const realFetch = globalThis.fetch;

/** A guide whose programmes are around "now", so the stored guide has something current. */
function guideXml(channel: string): string {
  const stamp = (ts: number) => new Date(ts * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const now = Math.floor(Date.now() / 1000);
  return `<?xml version="1.0"?><tv><channel id="${channel}"><display-name>One</display-name></channel>`
    + `<programme start="${stamp(now - 600)} +0000" stop="${stamp(now + 3000)}" channel="${channel}"><title>Evening News</title></programme>`
    + `</tv>`;
}

const PLAYLIST = (header: string) => [
  header,
  '#EXTINF:-1 tvg-id="one.nl" tvg-logo="http://logo.example.com/1.png" group-title="News",One',
  'http://stream.example.com/live/1.m3u8',
  '#EXTINF:-1 group-title="Sport",Two',
  'http://stream.example.com/live/2.m3u8',
].join('\n');

let hits: string[] = [];
function serve(routes: Record<string, () => Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    hits.push(url);
    const route = routes[url];
    return route === undefined ? new Response('no', { status: 404 }) : route();
  }) as typeof fetch;
}

beforeEach(async () => {
  store.clear();
  hits = [];
  setKVBackend({
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  });
  setKeyStore(null);
  await hydrateProviders();
  for (const p of allProviders()) await removeSource(p.id, { keepDoor: true });
  globalThis.fetch = realFetch;
});

test('the source types on offer here (a browser) are the three, with plain labels', () => {
  assert.deepEqual(sourceTypesOffered().map((t) => t.id), ['xtream', 'm3u', 'stream']);
  assert.deepEqual(sourceTypesOffered().map((t) => t.label), ['Xtream server', 'Playlist link (M3U/M3U8)', 'Single stream link']);
});

test('headers a playlist asks for reach the playback target; a channel without any gets none', async () => {
  serve({
    'http://list.example.com/h.m3u': () => new Response([
      '#EXTM3U',
      '#EXTINF:-1 group-title="News",Vlc Opts',
      '#EXTVLCOPT:http-user-agent=Agent/1.0',
      '#EXTVLCOPT:http-referrer=http://site.example.com/',
      'http://stream.example.com/live/a.m3u8',
      '#EXTINF:-1 group-title="News",Pipe Suffix',
      'http://stream.example.com/live/b.m3u8|User-Agent=Pipe/2&Referer=http://pipe.example.com/',
      '#EXTINF:-1 group-title="News",Plain',
      'http://stream.example.com/live/c.m3u8',
    ].join('\n')),
  });
  const res = await addPlaylistSource({ url: 'http://list.example.com/h.m3u' });
  assert.equal(res.ok, true, res.message);
  const cat = localCatalogue()!;
  const byName = (name: string) => [...Array(cat.items.count).keys()].find((r) => readText(cat.items.names, r) === name)!;
  const a = localPlay(byName('Vlc Opts'))!;
  assert.deepEqual(a.headers, { 'User-Agent': 'Agent/1.0', Referer: 'http://site.example.com/' });
  assert.equal(a.url, 'http://stream.example.com/live/a.m3u8', 'the address is clean of its header suffix');
  const b = localPlay(byName('Pipe Suffix'))!;
  assert.deepEqual(b.headers, { 'User-Agent': 'Pipe/2', Referer: 'http://pipe.example.com/' });
  assert.equal(localPlay(byName('Plain'))!.headers, undefined);
  /* A restart keeps them: they come back from storage, not from the parse. */
  const { initLocal } = await import('./localCatalogue.ts');
  await initLocal();
  assert.deepEqual(localPlay(byName('Vlc Opts'))!.headers?.['Referer'], 'http://site.example.com/');
});

test('a playlist link becomes a playlist source with groups and logos, and is active', async () => {
  serve({ 'http://list.example.com/a.m3u': () => new Response(PLAYLIST('#EXTM3U')) });
  const res = await addPlaylistSource({ url: 'http://list.example.com/a.m3u', name: 'Mine' });
  assert.equal(res.ok, true, res.message);
  const p = activeProvider();
  assert.equal(p?.kind, 'm3u');
  assert.equal(p?.name, 'Mine');
  assert.ok(getSession() !== null, 'having a source counts as being set up');
  const cat = localCatalogue()!;
  assert.equal(cat.items.count, 2);
  assert.deepEqual(cat.categories.map((c) => c.name).sort(), ['News', 'Sport']);
  const live = [...Array(cat.items.count).keys()].filter((r) => cat.items.kind[r] === KIND.Live);
  assert.equal(live.length, 2);
  assert.equal(readText(cat.items.logos, live[0]!) === '' ? 'none' : 'logo', 'logo');
});

test('a playlist that is not a playlist is refused and leaves nothing behind', async () => {
  serve({ 'http://list.example.com/page.html': () => new Response('<html>log in</html>') });
  const res = await addPlaylistSource({ url: 'http://list.example.com/page.html' });
  assert.equal(res.ok, false);
  assert.match(res.message, /No channels were found/);
  assert.equal(allProviders().length, 0);
  const bad = await addPlaylistSource({ url: 'ftp://nope' });
  assert.equal(bad.ok, false);
  assert.equal(allProviders().length, 0);
});

test('a playlist with a guide link keeps it; the link beats the playlist header', async () => {
  serve({
    'http://list.example.com/b.m3u': () => new Response(PLAYLIST('#EXTM3U url-tvg="http://guide.example.com/header.xml"')),
  });
  const res = await addPlaylistSource({ url: 'http://list.example.com/b.m3u', epgUrl: 'http://guide.example.com/mine.xml' });
  assert.equal(res.ok, true, res.message);
  const p = activeProvider()!;
  assert.equal(p.epgUrl, 'http://guide.example.com/mine.xml');
  assert.deepEqual(guideUrlsFor(p), ['http://guide.example.com/mine.xml', 'http://guide.example.com/header.xml']);
});

test('a playlist header (url-tvg) is used when no guide link is given, and a gzip guide is read', async () => {
  serve({
    'http://list.example.com/c.m3u': () => new Response(PLAYLIST('#EXTM3U x-tvg-url="http://guide.example.com/g.xml.gz"')),
    /* A plain download that is merely named .gz: no Content-Encoding, so only the bytes say so. */
    'http://guide.example.com/g.xml.gz': () => new Response(gzipSync(guideXml('one.nl')), { headers: { 'content-type': 'application/gzip' } }),
  });
  const res = await addPlaylistSource({ url: 'http://list.example.com/c.m3u' });
  assert.equal(res.ok, true, res.message);
  const p = activeProvider()!;
  assert.equal(p.epgUrl, undefined);
  assert.deepEqual(p.headerGuideUrls, ['http://guide.example.com/g.xml.gz']);
  await updateBulkGuide();
  const slots = await bulkSlots('one.nl', 'One');
  assert.equal(slots?.[0]?.title, 'Evening News');
  assert.ok(hits.includes('http://guide.example.com/g.xml.gz'));
});

test('a plain .xml guide link works too, and the second header link is the fallback', async () => {
  serve({
    'http://list.example.com/d.m3u': () => new Response(PLAYLIST('#EXTM3U url-tvg="http://guide.example.com/dead.xml,http://guide.example.com/ok.xml"')),
    'http://guide.example.com/ok.xml': () => new Response(guideXml('one.nl')),
  });
  await addPlaylistSource({ url: 'http://list.example.com/d.m3u' });
  await updateBulkGuide();
  assert.equal((await bulkSlots('one.nl'))?.[0]?.title, 'Evening News');
});

test('gzip bodies are unpacked whatever the address says, and plain ones pass through', async () => {
  const read = async (res: Response) => {
    const r = await guideReader(res);
    const parts: Uint8Array[] = [];
    for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); }
    return Buffer.concat(parts).toString('utf8');
  };
  assert.equal(await read(new Response(gzipSync('<tv></tv>'))), '<tv></tv>');
  assert.equal(await read(new Response('<tv></tv>')), '<tv></tv>');
  assert.equal(await read(new Response('')), '');
  const original = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
  (globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined;
  try {
    await assert.rejects(guideReader(new Response(gzipSync('<tv></tv>'))), new RegExp(GZIP_UNSUPPORTED.slice(0, 30)));
  } finally { (globalThis as { DecompressionStream?: unknown }).DecompressionStream = original; }
});

test('a single stream link is one channel that plays the link directly', async () => {
  const res = await addStreamSource({ url: 'http://stream.example.com/live/main.m3u8', name: 'Main' });
  assert.equal(res.ok, true, res.message);
  assert.equal(activeProvider()?.kind, 'stream');
  const cat = localCatalogue()!;
  assert.equal(cat.items.count, 1);
  assert.equal(readText(cat.items.names, 0), 'Main');
  const held = await blobs().get(`payloads.m3u.${activeProvider()!.id}`) as { live: { direct_source: string }[] };
  assert.equal(held.live[0]?.direct_source, 'http://stream.example.com/live/main.m3u8');
  /* No guide to keep for one stream. */
  assert.deepEqual(guideUrlsFor(activeProvider()!), []);
  assert.equal((await addStreamSource({ url: 'rtsp://x' })).ok, false);
});

test('several sources: one active, switch between them, remove clears what was kept', async () => {
  serve({ 'http://list.example.com/e.m3u?user=u&pass=secretvalue': () => new Response(PLAYLIST('#EXTM3U')) });
  await addPlaylistSource({ url: 'http://list.example.com/e.m3u?user=u&pass=secretvalue' });
  const playlist = activeProvider()!;
  const firstGeneration = localCatalogue()!.generation;
  await addStreamSource({ url: 'http://stream.example.com/one.m3u8' });
  assert.ok(localCatalogue()!.generation > firstGeneration, 'a second source is a new generation, or caches keyed on it serve the first one\'s rows');
  const stream = activeProvider()!;
  assert.deepEqual(allProviders().map((p) => p.kind), ['m3u', 'stream']);
  assert.equal(stream.name, 'one', 'named from the stream, not its type');
  assert.equal(playlist.name, 'list.example.com', 'named from the host, never the query');
  assert.equal(localCatalogue()!.items.count, 1);

  await useSource(playlist.id);
  assert.equal(activeProvider()?.id, playlist.id);
  assert.equal(localCatalogue()!.items.count, 2, 'switching rebuilds from what is held, no new download');
  assert.equal(hits.filter((h) => h.startsWith('http://list.example.com/e.m3u')).length, 1);

  await removeSource(playlist.id);
  assert.equal(getProvider(playlist.id), null);
  assert.equal(await blobs().get(`payloads.m3u.${playlist.id}`) ?? null, null, 'its cached channels are gone');
  assert.ok(!JSON.stringify([...store.entries()]).includes('secretvalue'), 'its link is gone from storage');
  /* The one in use was removed: the other takes over. */
  assert.equal(activeProvider()?.id, stream.id);
  assert.equal(localCatalogue()!.items.count, 1);

  await removeSource(stream.id, { keepDoor: true });
  assert.equal(allProviders().length, 0);
  assert.equal(getSession(), null);
  assert.equal(localStatus().state === 'error', false);
});

test('provider storage survives a restart with the secrets sealed', async () => {
  setKeyStore({ get: async () => keyHolder.key, put: async (k) => { keyHolder.key = k; } });
  await hydrateProviders();
  serve({ 'http://list.example.com/f.m3u?token=abc123': () => new Response(PLAYLIST('#EXTM3U')) });
  await addPlaylistSource({ url: 'http://list.example.com/f.m3u?token=abc123' });
  await providersSettled();
  assert.ok(!JSON.stringify([...store.entries()]).includes('abc123'));
  await hydrateProviders();
  assert.equal(activeProvider()?.url, 'http://list.example.com/f.m3u?token=abc123');
});
const keyHolder: { key: CryptoKey | null } = { key: null };
