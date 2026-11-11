/**
 * The two container questions, and why they must never be one list again.
 *
 * "on the web version nothing plays anymore now" was one call site asking the
 * APK's question — "would libVLC do this better?" — on a website, where the
 * answer "yes, MKV" means "so refuse it". That took 53,168 films off the web in
 * a single line. These pin the two apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserCannotDemux, webHasNoPathFor } from './nativePlayer.ts';

test('the APK prefers libVLC for MKV and TS — and the web must still try them', () => {
  for (const url of ['http://h/movie/a/b/1.mkv', 'http://h/live/a/b/2.ts']) {
    assert.equal(browserCannotDemux(url), true, 'libVLC is the better engine for these');
    assert.equal(webHasNoPathFor(url), false,
      'Chrome plays H.264/AAC Matroska, and mpegts.js demuxes TS — neither may be refused');
  }
});

test('the containers with no route at all are refused before the first byte', () => {
  for (const ext of ['avi', 'wmv', 'vob', 'flv']) {
    assert.equal(webHasNoPathFor(`http://h/movie/a/b/9.${ext}`), true, ext);
  }
});

test('an ordinary file is nobody’s special case', () => {
  for (const ext of ['mp4', 'm3u8', 'webm', 'mov']) {
    assert.equal(webHasNoPathFor(`http://h/movie/a/b/9.${ext}`), false, ext);
    assert.equal(browserCannotDemux(`http://h/movie/a/b/9.${ext}`), false, ext);
  }
});

test('a URL with no extension is never refused on a guess', () => {
  assert.equal(webHasNoPathFor('http://h/movie/a/b/9'), false);
  assert.equal(webHasNoPathFor('http://h/api/relay?u=whatever'), false);
});

test('a query string after the extension does not hide it', () => {
  assert.equal(webHasNoPathFor('http://h/x/9.avi?token=1'), true);
  assert.equal(browserCannotDemux('http://h/x/9.mkv?token=1'), true);
});
