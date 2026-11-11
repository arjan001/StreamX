import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StalkerClient, linkFrom, normaliseChannel, normaliseEpgList, normaliseGenres, stripCmdPrefix } from '../src/index.ts';
import { FAKE_MAC, withPortal } from './helpers.ts';

test('live: categories, channels, logos, archive and ids', async () => {
  await withPortal({}, {}, async (c, p) => {
    const live = await c.liveCatalogue();
    assert.deepEqual(live.categories.map((x) => x.name), ['News', 'Movies', 'Adult']);
    assert.equal(live.rows.length, 10);
    const r = live.rows[0]!;
    assert.equal(r.kind, 1);
    assert.equal(r.streamId, 101);
    assert.equal(r.remoteId, '101');
    assert.equal(r.number, 1);
    assert.equal(r.tvgId, 'ch101.example');
    assert.equal(r.tvArchive, true);
    assert.equal(r.tvArchiveDuration, 2); // 48 h -> 2 days
    assert.equal(r.logo, 'http://img.example.com/101.png');
    assert.equal(live.rows[1]!.logo, `${p.url}/misc/logos/320/102.png`);
    assert.equal(live.rows[1]!.tvArchive, false);
  });
});

test('censored channel and censored genre both mark rows adult', async () => {
  await withPortal({}, {}, async (c) => {
    const { rows } = await c.liveCatalogue();
    const adult = rows.filter((r) => r.isAdult).map((r) => r.streamId);
    assert.deepEqual(adult, [104, 109, 110]); // 104 flagged itself, 109/110 sit in the censored genre
  });
});

test('adult name heuristic catches a portal that forgets censored', () => {
  const g = normaliseGenres([{ id: '9', title: 'XXX Night', censored: 0 }, { id: '8', title: 'Sports' }]);
  assert.deepEqual([...g.adultIds], ['9']);
});

test('get_all_channels empty -> falls back to paginated get_ordered_list', async () => {
  await withPortal({ allChannels: false, pageSize: 3 }, {}, async (c, p) => {
    const live = await c.liveCatalogue();
    assert.equal(live.rows.length, 10);
    assert.equal(live.truncated, false);
    const pages = p.log.filter((l) => l.query['type'] === 'itv' && l.query['action'] === 'get_ordered_list');
    assert.ok(pages.length >= 4);
    assert.deepEqual(pages.slice(0, 4).map((l) => l.query['p']), ['1', '2', '3', '4']);
  });
});

test('maxPages caps the walk and reports truncation', async () => {
  await withPortal({ allChannels: false, pageSize: 3 }, { maxPages: 2 }, async (c) => {
    const live = await c.liveCatalogue();
    assert.equal(live.rows.length, 6);
    assert.equal(live.truncated, true);
  });
});

test('401 mid-session re-handshakes once and retries', async () => {
  await withPortal({}, {}, async (c, p) => {
    await c.liveCategories();
    const first = c.session!.token;
    p.revokeTokens();
    const cats = await c.liveCategories();
    assert.equal(cats.length, 3);
    assert.notEqual(c.session!.token, first);
  });
});

test('a second auth failure is not retried forever', async () => {
  let calls = 0;
  const c = new StalkerClient({
    portalUrl: 'http://portal.example.com',
    device: { mac: FAKE_MAC },
    fetch: async (url) => {
      calls++;
      if (url.includes('action=handshake')) return { status: 200, text: async () => '{"js":{"token":"t"}}' };
      if (url.includes('action=get_profile')) return { status: 200, text: async () => '{"js":{"id":"1"}}' };
      return { status: 200, text: async () => 'Authorization failed.' };
    },
  });
  await assert.rejects(c.liveCategories(), { code: 'auth' });
  assert.ok(calls < 10);
});

test('login portals: do_auth is sent and a wrong password fails', async () => {
  const login = { username: 'user', password: 'pw' };
  await withPortal({ login }, { login }, async (c, p) => {
    const live = await c.liveCatalogue();
    assert.equal(live.rows.length, 10);
    assert.ok(p.log.some((l) => l.query['action'] === 'do_auth' && l.query['login'] === 'user'));
  });
  await withPortal({ login }, { login: { username: 'user', password: 'bad' } }, async (c) => {
    await assert.rejects(c.connect(), { code: 'auth' });
  });
});

test('create_link strips the ffmpeg/ffrt prefix and is resolved per call', async () => {
  await withPortal({}, {}, async (c, p) => {
    const { rows } = await c.liveCatalogue();
    const a = await c.resolveLiveUrl(rows[0]!);
    const b = await c.resolveLiveUrl(rows[0]!);
    assert.match(a, /^http:\/\/stream\.example\.com\/live\/101\?token=\d+$/);
    assert.notEqual(a, b);
    const link = p.log.filter((l) => l.query['action'] === 'create_link').at(-1)!;
    assert.equal(link.query['cmd'], 'ffrt http://localhost/ch/101');
    assert.equal(link.query['forced_storage'], 'undefined');
    assert.equal(link.query['download'], '0');
    assert.equal(link.query['disable_ad'], '0');
    assert.equal(link.query['series'], '');
  });
});

test('stripCmdPrefix and linkFrom', () => {
  assert.equal(stripCmdPrefix('ffmpeg http://a/b'), 'http://a/b');
  assert.equal(stripCmdPrefix('ffrt3 http://a/b'), 'http://a/b');
  assert.equal(stripCmdPrefix('http://a/b'), 'http://a/b');
  assert.equal(linkFrom({ cmd: 'ffmpeg http://a/b' }), 'http://a/b');
  assert.throws(() => linkFrom({ cmd: '' }), { code: 'no_link' });
  assert.throws(() => linkFrom({ cmd: 'ffmpeg /relative' }), { code: 'no_link' });
  assert.throws(() => linkFrom([]), { code: 'no_link' });
});

test('VOD: categories, paged movies, mapping, playback link', async () => {
  await withPortal({ pageSize: 2 }, {}, async (c, p) => {
    const cats = await c.vodCategories();
    assert.deepEqual(cats.map((x) => x.name), ['Films', 'Kids']);
    const { rows, total } = await c.vodList('1');
    assert.equal(rows.length, 5);
    assert.equal(total, 5);
    const m = rows[0]!;
    assert.equal(m.kind, 2);
    assert.equal(m.streamId, 2001);
    assert.equal(m.categoryRemoteId, '1');
    assert.equal(m.rating, 7.5);
    assert.equal(m.year, '2010');
    assert.equal(m.durationSecs, 95 * 60);
    assert.equal(m.logo, `${p.url}/screenshots/2001.jpg`);
    assert.equal(typeof m.added, 'number');
    assert.match(await c.resolveVodUrl(m), /vod\/2001\.mp4$/);
  });
});

test('series: seasons and episodes', async () => {
  await withPortal({}, {}, async (c) => {
    const cats = await c.seriesCategories();
    assert.equal(cats.length, 1);
    const list = await c.seriesList('1');
    assert.equal(list.rows.length, 1);
    const s = list.rows[0]!;
    assert.equal(s.seriesId, 500);
    assert.equal(s.remoteId, '500');
    const d = await c.seriesDetail(s.remoteId);
    assert.deepEqual(d.seasons, [1, 2]);
    assert.equal(d.episodes.length, 5);
    assert.deepEqual(d.episodes.map((e) => `${e.seasonNumber}x${e.episodeNumber}`), ['1x1', '1x2', '1x3', '2x1', '2x2']);
    const url = await c.resolveVodUrl(d.episodes[1]!, d.episodes[1]!.seriesParam);
    assert.match(url, /\?e=2$/);
    assert.equal(new Set(d.episodes.map((e) => e.episodeId)).size, 5);
  });
});

test('missing modules degrade to empty results', async () => {
  await withPortal({ vod: false, series: false }, {}, async (c) => {
    assert.deepEqual(await c.vodCategories(), []);
    assert.deepEqual((await c.vodList('1')).rows, []);
    assert.deepEqual(await c.seriesCategories(), []);
    assert.deepEqual((await c.seriesList('1')).rows, []);
    assert.deepEqual((await c.seriesDetail('500')).episodes, []);
  });
});

test('EPG: short epg and epg info map to the shared entry shape', async () => {
  await withPortal({}, {}, async (c, p) => {
    const e = await c.shortEpg('101', 3);
    assert.equal(e.length, 3);
    assert.equal(e[0]!.title, 'Show 0');
    assert.equal(e[0]!.description, 'Now showing');
    assert.equal(e[0]!.nowPlaying, true);
    assert.equal(e[0]!.hasArchive, true);
    assert.equal(e[1]!.nowPlaying, false);
    assert.equal(typeof e[0]!.startTs, 'number');
    const q = p.log.filter((l) => l.query['action'] === 'get_short_epg').at(-1)!.query;
    assert.equal(q['ch_id'], '101');
    assert.equal(q['size'], '3');
    const info = await c.epgInfo(6);
    assert.equal(info.get('101')![0]!.title, 'Guide A');
  });
});

test('EPG falls back to the local-time strings when timestamps are missing', () => {
  const e = normaliseEpgList([{ name: 'X', time: '2026-01-01 10:00:00', time_to: '2026-01-01 11:00:00' }, { name: '' }, 5]);
  assert.equal(e.length, 1);
  assert.equal(e[0]!.stopTs! - e[0]!.startTs!, 3600);
});

test('archive link uses the tv_archive module', async () => {
  await withPortal({}, {}, async (c) => {
    assert.equal(await c.resolveArchiveUrl('auto /media/archive/1'), 'http://stream.example.com/archive/1.m3u8');
  });
});

test('coercion: numbers as strings, [] for objects, junk rows dropped', () => {
  const o = { origin: 'http://p.example.com', portalRoot: 'http://p.example.com', adultIds: new Set<string>() };
  const r = normaliseChannel({ id: 7, name: ' A ', number: '3', cmd: 'ffrt http://l/ch/7', censored: '0', tv_archive: '1', archive_duration: '', tv_genre_id: 4 }, o)!;
  assert.equal(r.streamId, 7);
  assert.equal(r.name, 'A');
  assert.equal(r.categoryRemoteId, '4');
  assert.equal(r.tvArchive, true);
  assert.equal(r.isAdult, false);
  assert.equal(normaliseChannel([], o), null);
  assert.equal(normaliseChannel({ id: 'abc', name: 'x', cmd: 'y' }, o), null);
  assert.equal(normaliseChannel({ id: 1, name: '', cmd: 'y' }, o), null);
  assert.deepEqual(normaliseGenres({}).categories, []);
});

test('error bodies: HTML page, empty body, http error, network failure', async () => {
  const mk = (status: number, body: string | Error) =>
    new StalkerClient({
      portalUrl: 'http://portal.example.com/portal.php',
      device: { mac: FAKE_MAC },
      fetch: async () => {
        if (body instanceof Error) throw body;
        return { status, text: async () => body };
      },
    });
  // Every candidate is unusable -> no_endpoint.
  await assert.rejects(mk(200, '<html>oops</html>').connect(), { code: 'no_endpoint' });
  await assert.rejects(mk(200, '').connect(), { code: 'no_endpoint' });
  await assert.rejects(mk(500, 'boom').connect(), { code: 'no_endpoint' });
  await assert.rejects(mk(200, new Error('ECONNREFUSED')).connect(), { code: 'network' });
});

test('abort: a pre-aborted signal and an abort mid-request', async () => {
  const pre = new AbortController();
  pre.abort();
  await withPortal({}, { signal: pre.signal }, async (c) => {
    await assert.rejects(c.connect(), { code: 'aborted' });
  });
  const ctl = new AbortController();
  const c = new StalkerClient({
    portalUrl: 'http://portal.example.com',
    device: { mac: FAKE_MAC },
    signal: ctl.signal,
    fetch: (_url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted by transport')));
        setTimeout(() => ctl.abort(), 5);
      }),
  });
  await assert.rejects(c.connect(), { code: 'aborted' });
});

test('timeout aborts a hung request', async () => {
  const c = new StalkerClient({
    portalUrl: 'http://portal.example.com/portal.php',
    device: { mac: FAKE_MAC },
    timeoutMs: 20,
    fetch: (_u, init) => new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('t')))),
  });
  await assert.rejects(c.connect(), { code: 'network' });
});

test('restored session skips the handshake', async () => {
  await withPortal({}, {}, async (c1, p) => {
    await c1.connect();
    const session = c1.session!;
    const before = p.log.length;
    const c2 = new StalkerClient({ portalUrl: p.url, device: { mac: FAKE_MAC }, session });
    await c2.liveCategories();
    assert.ok(p.log.slice(before).every((l) => l.query['action'] !== 'handshake'));
  });
});
