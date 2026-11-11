import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadM3uCatalogue, streamPayloads } from './m3uCatalogue.ts';

const PLAYLIST = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="one.nl" tvg-logo="http://logo.example.com/1.png" group-title="News",One HD (1080p)',
  'http://stream.example.com/live/1.m3u8',
  '#EXTINF:-1 group-title="News",One HD duplicate',
  'http://stream.example.com/live/1.m3u8',
  '#EXTINF:-1 group-title="Sport",Two',
  'http://stream.example.com/live/2.m3u8',
  '#EXTINF:-1 group-title="XXX Adult",Night',
  'http://stream.example.com/live/3.m3u8',
  '#EXTINF:-1 group-title="Movies",Erotic Tales',
  'http://stream.example.com/live/4.m3u8',
].join('\n');

async function withPlaylist<T>(body: string, status: number, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('a playlist becomes live channels, deduplicated on the stream URL', async () => {
  const res = await withPlaylist(PLAYLIST, 200, () => loadM3uCatalogue('http://panel.example.com/list.m3u'));
  const urls = (res.payloads.live as { direct_source: string }[]).map((r) => r.direct_source);
  assert.deepEqual(urls, ['http://stream.example.com/live/1.m3u8', 'http://stream.example.com/live/2.m3u8']);
  assert.equal(res.entries, 2);
  assert.deepEqual(res.payloads.vod, []);
  assert.deepEqual(res.payloads.series, []);
});

test('adult entries are dropped, not flagged', async () => {
  const res = await withPlaylist(PLAYLIST, 200, () => loadM3uCatalogue('http://panel.example.com/list.m3u'));
  const names = (res.payloads.live as { name: string }[]).map((r) => r.name);
  assert.ok(!names.some((n) => /night|erotic/i.test(n)), names.join(', '));
  assert.ok((res.payloads.live as { is_adult: number }[]).every((r) => r.is_adult === 0));
});

test('categories are namespaced so they cannot collide with a panel\'s', async () => {
  const res = await withPlaylist(PLAYLIST, 200, () => loadM3uCatalogue('http://panel.example.com/list.m3u'));
  const ids = (res.payloads.liveCategories as { category_id: string }[]).map((c) => c.category_id).sort();
  assert.deepEqual(ids, ['m3u:News', 'm3u:Sport']);
});

test('the EPG address is handed back as given, and null when there is none', async () => {
  const withEpg = await withPlaylist(PLAYLIST, 200, () => loadM3uCatalogue(
    'http://panel.example.com/list.m3u', { epgUrl: 'http://panel.example.com/guide.xml' },
  ));
  assert.equal(withEpg.epgUrl, 'http://panel.example.com/guide.xml');
  const without = await withPlaylist(PLAYLIST, 200, () => loadM3uCatalogue('http://panel.example.com/list.m3u'));
  assert.equal(without.epgUrl, null);
});

test('a playlist that cannot be fetched is an error, not an empty library', async () => {
  await assert.rejects(
    withPlaylist('nope', 404, () => loadM3uCatalogue('http://panel.example.com/list.m3u')),
    /404/,
  );
});

test('the playlist header names its guide, one or several', async () => {
  const one = await withPlaylist('#EXTM3U url-tvg="http://guide.example.com/a.xml"\n#EXTINF:-1,One\nhttp://s.example.com/1.m3u8',
    200, () => loadM3uCatalogue('http://panel.example.com/list.m3u'));
  assert.deepEqual(one.headerGuideUrls, ['http://guide.example.com/a.xml']);
  const many = await withPlaylist('#EXTM3U url-tvg="http://guide.example.com/a.xml.gz,http://guide.example.com/b.xml"\n#EXTINF:-1,One\nhttp://s.example.com/1.m3u8',
    200, () => loadM3uCatalogue('http://panel.example.com/list.m3u'));
  assert.deepEqual(many.headerGuideUrls, ['http://guide.example.com/a.xml.gz', 'http://guide.example.com/b.xml']);
  const none = await withPlaylist(PLAYLIST, 200, () => loadM3uCatalogue('http://panel.example.com/list.m3u'));
  assert.deepEqual(none.headerGuideUrls, []);
});

test('a link that returns no channels at all is an error, not an empty library', async () => {
  await assert.rejects(
    withPlaylist('<html>sign in</html>', 200, () => loadM3uCatalogue('http://panel.example.com/page')),
    /No channels were found/,
  );
});

test('logos come from the playlist only; a channel without one has none', async () => {
  const res = await withPlaylist(PLAYLIST, 200, () => loadM3uCatalogue('http://panel.example.com/list.m3u'));
  const icons = (res.payloads.live as { stream_icon: string | null }[]).map((r) => r.stream_icon);
  assert.deepEqual(icons, ['http://logo.example.com/1.png', null]);
});

test('a single stream is one live channel that plays its own address', () => {
  const p = streamPayloads('http://stream.example.com/a.m3u8', '  Main  ');
  assert.equal(p.live.length, 1);
  const row = p.live[0] as { name: string; direct_source: string };
  assert.equal(row.name, 'Main');
  assert.equal(row.direct_source, 'http://stream.example.com/a.m3u8');
  assert.equal((streamPayloads('http://s.example.com/x', '').live[0] as { name: string }).name, 'Stream');
});
