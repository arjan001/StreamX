import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStreamUrl, normaliseServerUrl, resolveLiveExt, buildArchiveUrl,
} from '@iptv/core-xtream';

/*
 * These are the exact string shapes the app builds on the device. `core-xtream`
 * already covers the builders; what is
 * asserted here is the CHOICES the client makes when calling them — the account's
 * allowed formats, and the live/movie/episode split.
 */
const base = normaliseServerUrl('http://panel.example.com');
const cred = { username: 'u@x', password: 'p%1' };

test('a live channel is asked for in a container the account allows', () => {
  // Measured on the live line: allowed_output_formats is m3u8,ts,rtmp.
  assert.equal(resolveLiveExt(['m3u8', 'ts', 'rtmp'], 'auto'), 'm3u8');
  assert.equal(resolveLiveExt(['m3u8', 'ts', 'rtmp'], 'ts'), 'ts');
  // An account that does not allow what was asked gets what it does allow,
  // rather than a URL the panel will refuse.
  assert.equal(resolveLiveExt(['ts'], 'm3u8'), 'ts');
  // No list at all is not "no formats" — it is a panel that did not say.
  assert.equal(resolveLiveExt(null, 'auto'), 'm3u8');
});

test('credentials are escaped in a path segment', () => {
  const url = buildStreamUrl(base, cred, { kind: 1, streamId: 42, ext: 'm3u8' });
  assert.equal(url, 'http://panel.example.com/live/u%40x/p%251/42.m3u8');
});

test('each kind lands on its own path', () => {
  assert.match(buildStreamUrl(base, cred, { kind: 1, streamId: 7, ext: 'ts' }), /\/live\//);
  assert.match(buildStreamUrl(base, cred, { kind: 2, streamId: 7, ext: 'mp4' }), /\/movie\//);
  assert.match(buildStreamUrl(base, cred, { kind: 3, streamId: 7, ext: 'mkv' }), /\/series\//);
});

test('an opaque playlist entry plays its own url untouched', () => {
  const url = 'http://broadcaster.example/live/stream.m3u8?token=abc';
  assert.equal(buildStreamUrl(base, cred, { kind: 0, streamId: null, url }), url);
});

test('both catch-up families take a start and a duration in MINUTES', () => {
  // 30 minutes of programme plus the 2-minute boundary tail.
  const w = { startTs: 1_756_000_000, stopTs: 1_756_001_800 };
  const q = buildArchiveUrl(base, cred, 99, w, 'query');
  const path = buildArchiveUrl(base, cred, 99, w, 'path');
  assert.match(q, /duration=32(&|$)/);
  assert.match(path, /\/timeshift\/u%40x\/p%251\/32\//);
  // Raw in a query value, escaped in a path segment — panels reject the other way.
  assert.ok(q.includes('password=p%251'), q);
});

