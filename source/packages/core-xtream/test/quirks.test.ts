/**
 * Panel-quirk fixtures.
 *
 * Every case here reproduces something a real panel actually did. They exist so
 * a refactor cannot quietly reintroduce a bug that took a live packet capture to
 * find. Sources are noted per test; measurements come from docs/04-measured-panel.md.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  flexInt, flexBool, flexStr, objOrNull, flexStrArray, flexEpoch, decodeMaybeBase64,
} from '../src/coerce.ts';
import { normaliseSeriesInfo, normaliseEpg, normaliseLive, normaliseVod, resolveYear } from '../src/normalise.ts';
import { recognise, buildStreamUrl, resolveLiveExt, normaliseServerUrl, baseUrl, Kind } from '../src/urls.ts';
import { normName, compactName } from '../src/normname.ts';

describe('tolerant coercion', () => {
  test('one response mixes number and string integers (measured)', () => {
    // Observed live: auth + timestamp_now numeric, exp_date + max_connections string.
    assert.equal(flexBool(1), true);
    assert.equal(flexInt(1787048250), 1787048250);
    assert.equal(flexInt('1788430308'), 1788430308);
    assert.equal(flexInt('1'), 1);
  });

  test('empty string and null are absent, not zero', () => {
    assert.equal(flexInt(''), null);
    assert.equal(flexInt(null), null);
    assert.equal(flexStr(''), null);
    // exp_date is null for never-expiring lines; must not become epoch 0.
    assert.equal(flexEpoch(null), null);
    assert.equal(flexEpoch('0'), null);
  });

  test('auth arrives as "1" on some forks', () => {
    assert.equal(flexBool('1'), true);
    assert.equal(flexBool('0'), false);
    assert.equal(flexBool(0), false);
  });

  test('info: [] means absent, not an empty list', () => {
    // get_vod_info.info is an empty ARRAY when metadata is missing.
    assert.equal(objOrNull([]), null);
    assert.deepEqual(objOrNull({ a: 1 }), { a: 1 });
  });

  test('backdrop_path is a string on some forks, array on others', () => {
    assert.deepEqual(flexStrArray('http://h/a.jpg'), ['http://h/a.jpg']);
    assert.deepEqual(flexStrArray(['http://h/a.jpg']), ['http://h/a.jpg']);
    assert.deepEqual(flexStrArray(null), []);
  });
});

describe('EPG base64', () => {
  test('decodes encoded titles', () => {
    assert.equal(decodeMaybeBase64('TW9ybmluZyBOZXdz'), 'Morning News');
  });
  test('passes through titles that were never encoded', () => {
    // Some forks do not encode at all; mangling those is worse than not decoding.
    assert.equal(decodeMaybeBase64('Morning News'), 'Morning News');
    assert.equal(decodeMaybeBase64('Slam'), 'Slam');
  });
  test('passes through accented plain text', () => {
    const s = 'Familles nombreuses : la vie en XXL';
    assert.equal(decodeMaybeBase64(s), s);
  });

  /*
   * The guide is decoded on the DEVICE, so this cannot be `Buffer.from` alone.
   *
   * `Buffer` does not exist in a browser: the reference threw, the catch handed
   * back the raw string, and the whole guide rendered its own base64 —
   * "R2VlbiB1aXR6ZW5kaW5n" across twenty thousand channels. Nothing failed
   * loudly, which is why it shipped. The test removes the global rather than
   * trusting a comment that it is no longer needed.
   */
  test('decodes with no Buffer in scope, which is every browser', () => {
    const held = globalThis.Buffer;
    // @ts-expect-error deleting a global is the whole point of the test
    delete globalThis.Buffer;
    try {
      assert.equal(decodeMaybeBase64('R2VlbiB1aXR6ZW5kaW5n'), 'Geen uitzending');
      assert.equal(decodeMaybeBase64('SGV0IHdlZXI='), 'Het weer');
      // UTF-8 past ASCII, since the decode is bytes and not characters.
      assert.equal(
        decodeMaybeBase64('Tm9zdGFsZ2llOiBTdGEgT3AhIG1ldCBWw6lyb25pcXVl'),
        'Nostalgie: Sta Op! met Véronique',
      );
      // And the pass-through still passes through.
      assert.equal(decodeMaybeBase64('Morning News'), 'Morning News');
    } finally {
      globalThis.Buffer = held;
    }
  });
});

describe('series info', () => {
  test('seasons:[] with populated episodes (measured on 4 of 5 sampled series)', () => {
    const d = normaliseSeriesInfo({
      seasons: [],
      episodes: {
        '1': [{ id: '778901', episode_num: 1, title: 'Ep1', container_extension: 'mkv', season: 1 }],
        '2': [{ id: '778902', episode_num: 1, title: 'Ep1 S2', container_extension: 'mkv', season: 2 }],
      },
    });
    assert.deepEqual(d.seasons, [1, 2], 'must enumerate from episodes keys, not seasons');
    assert.equal(d.episodes.length, 2);
  });

  test('populated seasons with episodes:{} — the inverse case, also measured', () => {
    const d = normaliseSeriesInfo({
      seasons: [{ season_number: 1 }, { season_number: 2 }],
      episodes: {},
    });
    assert.deepEqual(d.seasons, []);
    assert.equal(d.episodes.length, 0, 'must not invent episodes from the seasons field');
  });

  test('episodes may itself be []', () => {
    const d = normaliseSeriesInfo({ seasons: [], episodes: [] });
    assert.deepEqual(d.seasons, []);
    assert.equal(d.episodes.length, 0);
  });

  test('season keys sort NUMERICALLY, not lexicographically', () => {
    const episodes: Record<string, unknown[]> = {};
    for (const n of [1, 2, 3, 10, 11, 20, 22]) {
      episodes[String(n)] = [{ id: `${n}01`, episode_num: 1, title: `S${n}`, season: n }];
    }
    const d = normaliseSeriesInfo({ seasons: [], episodes });
    assert.deepEqual(d.seasons, [1, 2, 3, 10, 11, 20, 22], '"10" must not sort before "2"');
  });

  test('episode id is a string in the payload and becomes the URL id', () => {
    const d = normaliseSeriesInfo({
      episodes: { '1': [{ id: '778901', episode_num: 1, title: 'E', container_extension: 'mkv' }] },
    });
    assert.equal(d.episodes[0]!.episodeId, 778901);
    assert.equal(d.episodes[0]!.ext, 'mkv');
  });

  /*
    The panel's own ffprobe, which it publishes per episode and which nothing read.

    Measured 2026-09-07 against the live line: `get_series_info` carried a video
    codec for 26 of 26 sampled episodes, where `get_vod_info` managed 17 of 25 for
    films. The shape below is copied verbatim from one of them — 4K The Witcher
    S01E01, HEVC Main 10 in an MKV with E-AC-3 — because that title is exactly the
    "I hear music but no video" report, and the field that would have predicted it
    was sitting in the payload the whole time.
  */
  test('the panel publishes the codecs and they are carried, not dropped', () => {
    const d = normaliseSeriesInfo({
      episodes: {
        '1': [{
          id: '2095590', episode_num: 1, title: 'Le début de la fin',
          container_extension: 'mkv', season: 1,
          info: {
            video: { index: 4, codec_name: 'hevc', profile: '2', width: 3840, pix_fmt: 'yuv420p10le' },
            audio: { index: 1, codec_name: 'eac3', channels: 6 },
          },
        }],
      },
    });
    assert.equal(d.episodes[0]!.videoCodec, 'hevc');
    assert.equal(d.episodes[0]!.audioCodec, 'eac3');
  });

  test('a panel that probed nothing sends [] and that is an unknown, not a codec', () => {
    /* `objOrNull` is the guard: an array has no `codec_name`, and reading one off
       it would put `undefined` where the engine choice expects a codec name. */
    const d = normaliseSeriesInfo({
      episodes: {
        '1': [
          { id: '1', episode_num: 1, title: 'A', info: { video: [], audio: [] } },
          { id: '2', episode_num: 2, title: 'B', info: {} },
          { id: '3', episode_num: 3, title: 'C' },
        ],
      },
    });
    for (const e of d.episodes) {
      assert.equal(e.videoCodec, null, `episode ${e.episodeId} video`);
      assert.equal(e.audioCodec, null, `episode ${e.episodeId} audio`);
    }
  });

  test('half a report is still worth having', () => {
    /* An episode with audio probed and video not is not a reason to discard the
       audio codec — AC-3 alone is enough to route a file to the native engine. */
    const d = normaliseSeriesInfo({
      episodes: {
        '1': [{ id: '9', episode_num: 1, title: 'A', info: { video: [], audio: { codec_name: 'ac3' } } }],
      },
    });
    assert.equal(d.episodes[0]!.videoCodec, null);
    assert.equal(d.episodes[0]!.audioCodec, 'ac3');
  });
});

describe('epg listings', () => {
  test('uses timestamps, decodes base64, sorts by start', () => {
    const rows = normaliseEpg({
      epg_listings: [
        { id: '2', title: 'U2xhbQ==', start_timestamp: '200', stop_timestamp: '300', has_archive: 1 },
        { id: '1', title: 'TW9ybmluZyBOZXdz', start_timestamp: '100', stop_timestamp: '200', has_archive: '0' },
      ],
    });
    assert.equal(rows[0]!.title, 'Morning News', 'must sort ascending by startTs');
    assert.equal(rows[1]!.title, 'Slam');
    assert.equal(rows[1]!.hasArchive, true);
    assert.equal(rows[0]!.hasArchive, false);
  });
});

describe('stream urls', () => {
  test('recognises the LEGACY no-prefix live form (the only form this panel emits)', () => {
    const r = recognise('http://host:80/userpart/passpart/2116347');
    assert.equal(r.kind, Kind.Live);
    assert.equal(r.streamId, 2116347);
  });

  test('recognises prefixed live, movie and flat series paths', () => {
    assert.equal(recognise('http://h:80/live/u/p/40521.ts').kind, Kind.Live);
    assert.equal(recognise('http://h:80/movie/u/p/91234.mkv').kind, Kind.Movie);
    const ep = recognise('http://h:80/series/u/p/778901.mkv');
    assert.equal(ep.kind, Kind.Episode);
    assert.equal(ep.streamId, 778901, 'series path is flat and keyed on the episode id');
  });

  test('third-party URLs stay opaque and keep their url', () => {
    const r = recognise('https://cdn.example.com/quran/001.mp3');
    assert.equal(r.kind, Kind.Opaque);
    assert.equal(r.url, 'https://cdn.example.com/quran/001.mp3');
  });

  test('credentials are percent-encoded in path segments', () => {
    const base = normaliseServerUrl('http://h:80');
    const url = buildStreamUrl(base, { username: 'a@b+c', password: 'p%1' },
      { kind: Kind.Movie, streamId: 5, ext: 'mp4' });
    assert.equal(url, 'http://h/movie/a%40b%2Bc/p%251/5.mp4');
  });

  test('allowed_output_formats gates the container; auto prefers m3u8', () => {
    assert.equal(resolveLiveExt(['m3u8', 'ts', 'rtmp']), 'm3u8');
    assert.equal(resolveLiveExt(['ts']), 'ts');
    assert.equal(resolveLiveExt(['ts'], 'm3u8'), 'ts', 'a disallowed request is clamped');
  });

  test('default port is elided so URLs match what the panel emits', () => {
    assert.equal(baseUrl(normaliseServerUrl('http://h:80/get.php?x=1')), 'http://h');
  });
});

describe('name normalisation', () => {
  test('strips market prefixes and quality noise', () => {
    assert.equal(normName('FR| TF1 HD'), 'tf1');
    assert.equal(normName('UK: BBC One FHD'), 'bbc one');
    assert.equal(normName('Canal+ Sport 4K'), 'canal sport');
  });
  test('never normalises a name out of existence', () => {
    assert.equal(normName('HD'), 'hd');
  });
  test('compact key survives apostrophes so "greys anatomy" matches', () => {
    // The bug this fixes: normName gives "grey s anatomy", which a user typing
    // "greys anatomy" never matches.
    assert.ok(compactName("EN - Grey's Anatomy (2005)").includes(compactName('greys anatomy')));
  });
});

describe('item normalisation', () => {
  test('live: tv_archive gates catch-up, direct_source is preserved', () => {
    const it = normaliseLive({
      stream_id: 40521, name: 'TF1', stream_type: 'live', epg_channel_id: 'TF1.fr',
      tv_archive: 1, tv_archive_duration: 3, direct_source: 'http://x/y.ts', added: '1594118475',
    })!;
    assert.equal(it.tvArchive, true);
    assert.equal(it.tvArchiveDuration, 3);
    assert.equal(it.directSource, 'http://x/y.ts');
    assert.equal(it.tvgId, 'TF1.fr');
  });
  test('live: empty epg_channel_id becomes null (98.3% of measured entries)', () => {
    const it = normaliseLive({ stream_id: 1, name: 'X', epg_channel_id: '' })!;
    assert.equal(it.tvgId, null);
  });
  test('vod: container_extension is required to build a URL', () => {
    const it = normaliseVod({ stream_id: 9, name: 'M', container_extension: 'mkv' })!;
    assert.equal(it.ext, 'mkv');
  });
  test('rows without an id or name are dropped, not half-inserted', () => {
    assert.equal(normaliseLive({ name: 'no id' }), null);
    assert.equal(normaliseVod({ stream_id: 1 }), null);
  });
});

describe('year resolution', () => {
  test('falls back to the title when the year field is empty', () => {
    // Measured: 0 of 50,343 movies populate `year`; 47,498 carry it in the name.
    assert.equal(resolveYear('', 'EN - Water For Elephants (2011)'), '2011');
    assert.equal(resolveYear(null, 'EN - Cleopatra (1963)'), '1963');
  });
  test('prefers the field when it is present and sane', () => {
    assert.equal(resolveYear('1999', 'Some Title (2011)'), '1999');
  });
  test('ignores junk and titles with no year', () => {
    assert.equal(resolveYear('n/a', 'No Year Here'), null);
    assert.equal(resolveYear(null, 'Channel (HD)'), null);
  });
});
