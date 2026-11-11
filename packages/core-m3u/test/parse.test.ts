/**
 * Playlist parser fixtures. Each case is a shape found in real playlists.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u, parseHeader, splitPipeHeaders, parseDrm, type M3uEntry } from '../src/parse.ts';

async function* lines(text: string) {
  for (const l of text.split('\n')) yield l;
}
async function collect(text: string) {
  const out: M3uEntry[] = [];
  let header: unknown = null;
  for await (const it of parseM3u(lines(text))) {
    if ('header' in it) header = it.header;
    else out.push(it);
  }
  return { header, entries: out };
}

describe('header', () => {
  test('url-tvg accepts a comma-separated LIST', () => {
    const h = parseHeader('#EXTM3U url-tvg="http://a/x.xml,http://b/y.xml.gz" tvg-shift="-1"');
    assert.deepEqual(h.epgUrls, ['http://a/x.xml', 'http://b/y.xml.gz']);
    assert.equal(h.tvgShift, -1);
  });
  test('x-tvg-url is accepted as an alias (used by iptv-org)', () => {
    const h = parseHeader('#EXTM3U x-tvg-url="https://example/guide.xml.gz"');
    assert.deepEqual(h.epgUrls, ['https://example/guide.xml.gz']);
  });
});

describe('entries', () => {
  test('parses m3u_plus attributes and the legacy URL form together', async () => {
    const { entries } = await collect(
      `#EXTM3U
#EXTINF:-1 tvg-id="TF1.fr" tvg-name="TF1" tvg-logo="http://h/l.png" group-title="FR| HD",FR| TF1 HD
http://host:80/user/pass/2116347`,
    );
    assert.equal(entries.length, 1);
    const e = entries[0]!;
    assert.equal(e.tvgId, 'TF1.fr');
    assert.equal(e.name, 'FR| TF1 HD');
    assert.deepEqual(e.groups, ['FR| HD']);
    assert.equal(e.url, 'http://host:80/user/pass/2116347');
  });

  test('attribute names are case-insensitive and underscore aliases fold', async () => {
    const { entries } = await collect(
      `#EXTINF:-1 tvg-ID="a.b" TVG-LOGO="http://h/x.png" group_title="G",Name
http://h/s`,
    );
    assert.equal(entries[0]!.tvgId, 'a.b');
    assert.equal(entries[0]!.tvgLogo, 'http://h/x.png');
    assert.deepEqual(entries[0]!.groups, ['G']);
  });

  test('group-title is a semicolon-separated list (Kodi semantics)', async () => {
    const { entries } = await collect(`#EXTINF:-1 group-title="News;UK;HD",X\nhttp://h/s`);
    assert.deepEqual(entries[0]!.groups, ['News', 'UK', 'HD']);
  });

  test('#EXTGRP is a BEGIN directive: it sticks to following entries', async () => {
    const { entries } = await collect(
      `#EXTGRP:Sports
#EXTINF:-1,A
http://h/a
#EXTINF:-1,B
http://h/b`,
    );
    assert.deepEqual(entries[0]!.groups, ['Sports']);
    assert.deepEqual(entries[1]!.groups, ['Sports'], 'must persist until changed');
  });

  test('archive depth takes the first non-blank of catchup-days/timeshift/tvg-rec', async () => {
    const a = await collect(`#EXTINF:-1 catchup-days="7",X\nhttp://h/s`);
    assert.equal(a.entries[0]!.catchupDays, 7);
    const b = await collect(`#EXTINF:-1 timeshift="5",X\nhttp://h/s`);
    assert.equal(b.entries[0]!.catchupDays, 5);
    const c = await collect(`#EXTINF:-1 tvg-rec="3",X\nhttp://h/s`);
    assert.equal(c.entries[0]!.catchupDays, 3);
  });

  test('#EXTVLCOPT becomes headers and beats the pipe suffix', async () => {
    const { entries } = await collect(
      `#EXTINF:-1,X
#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Windows NT 10.0)
#EXTVLCOPT:http-referrer=https://ref.example/
http://h/s|User-Agent=Overridden`,
    );
    const e = entries[0]!;
    assert.equal(e.headers['User-Agent'], 'Mozilla/5.0 (Windows NT 10.0)');
    assert.equal(e.headers['Referer'], 'https://ref.example/');
    assert.equal(e.url, 'http://h/s', 'pipe suffix is stripped from the URL');
  });

  test('#EXTHTTP supplies arbitrary headers', async () => {
    const { entries } = await collect(
      `#EXTINF:-1,X
#EXTHTTP:{"User-Agent":"UA","X-Token":"abc"}
http://h/s`,
    );
    assert.equal(entries[0]!.headers['X-Token'], 'abc');
  });

  test('malformed #EXTHTTP does not abort the playlist', async () => {
    const { entries } = await collect(`#EXTINF:-1,X\n#EXTHTTP:{not json\nhttp://h/s`);
    assert.equal(entries.length, 1);
  });

  test('radio="true" is flagged', async () => {
    const { entries } = await collect(`#EXTINF:-1 radio="true",R\nhttp://h/s`);
    assert.equal(entries[0]!.radio, true);
  });

  test('an #EXTINF with no URL line is dropped, not emitted half-built', async () => {
    const { entries } = await collect(`#EXTINF:-1,Truncated`);
    assert.equal(entries.length, 0);
  });

  test('a stray URL with no #EXTINF is ignored', async () => {
    const { entries } = await collect(`http://h/orphan\n#EXTINF:-1,Real\nhttp://h/real`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.name, 'Real');
  });

  test('commas inside the channel name survive', async () => {
    const { entries } = await collect(`#EXTINF:-1 tvg-id="x",Movie, The Sequel\nhttp://h/s`);
    assert.equal(entries[0]!.name, 'Movie, The Sequel');
  });
});

describe('pipe headers', () => {
  test('splits multiple headers and drops the ! prefix', () => {
    const r = splitPipeHeaders('http://h/s|User-Agent=UA&!X-Odd=1');
    assert.equal(r.url, 'http://h/s');
    assert.equal(r.headers['User-Agent'], 'UA');
    assert.equal(r.headers['X-Odd'], '1');
  });
});

describe('KODIPROP drm', () => {
  test('extracts ClearKey kid:key pairs', () => {
    const props = new Map([
      ['inputstream.adaptive.license_type', 'org.w3.clearkey'],
      ['inputstream.adaptive.license_key', '000102030405060708090a0b0c0d0e0f:00112233445566778899aabbccddeeff'],
    ]);
    const drm = parseDrm(props)!;
    assert.equal(drm.supported, true);
    assert.equal(drm.clearKeys!['000102030405060708090a0b0c0d0e0f'], '00112233445566778899aabbccddeeff');
  });

  test('drm_legacy form is understood', () => {
    const drm = parseDrm(new Map([
      ['inputstream.adaptive.drm_legacy', 'org.w3.clearkey|000102030405060708090a0b0c0d0e0f:00112233445566778899aabbccddeeff'],
    ]))!;
    assert.equal(drm.supported, true);
  });

  test('a Widevine license server is reported unsupported rather than silently failing', () => {
    const drm = parseDrm(new Map([
      ['inputstream.adaptive.license_type', 'com.widevine.alpha'],
      ['inputstream.adaptive.license_key', 'https://lic.example/req'],
    ]))!;
    assert.equal(drm.supported, false);
    assert.equal(drm.licenseType, 'com.widevine.alpha');
  });

  test('no DRM props yields null so ordinary channels are untouched', () => {
    assert.equal(parseDrm(new Map()), null);
  });
});
