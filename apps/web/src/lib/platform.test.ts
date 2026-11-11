import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveLiveExt } from '@iptv/core-xtream';
import {
  IOS_CANNOT_PLAY, iosCannotOpenFile, liveCaptionsPossible, liveFormatFor, pickWebEngine,
  platformOf, streamixPluginsPossible, type EngineFacts, type Platform,
} from './platform.ts';
import { pickTransport } from './playerCore.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

test('platform detection: Capacitor wins, then the user agent', () => {
  assert.equal(platformOf({ capacitor: 'ios' }), 'ios');
  assert.equal(platformOf({ capacitor: 'android', userAgent: 'Android 14' }), 'android');
  assert.equal(platformOf({ userAgent: IPHONE }), 'ios');
  assert.equal(platformOf({ userAgent: IPAD_DESKTOP, touchPoints: 5 }), 'ios');
  assert.equal(platformOf({ userAgent: IPAD_DESKTOP, touchPoints: 0 }), 'web');
  assert.equal(platformOf({ userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit/537.36' }), 'tizen');
  assert.equal(platformOf({ userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/79' }), 'webos');
  assert.equal(platformOf({ capacitor: 'web', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130' }), 'web');
  assert.equal(platformOf({}), 'web');
});

const base = (over: Partial<EngineFacts>): EngineFacts => ({
  platform: 'web', container: 'hls', nativeHls: false, hlsJs: false, mpegts: false, ...over,
});

test('HLS: iOS plays it natively, every other platform keeps hls.js first', () => {
  assert.equal(pickWebEngine(base({ platform: 'ios', nativeHls: true, hlsJs: true })), 'native-hls');
  assert.equal(pickWebEngine(base({ platform: 'ios', nativeHls: false, hlsJs: true })), 'hlsjs');
  assert.equal(pickWebEngine(base({ platform: 'ios' })), 'unsupported');
  for (const platform of ['android', 'tizen', 'webos', 'web'] as Platform[]) {
    assert.equal(pickWebEngine(base({ platform, nativeHls: true, hlsJs: true })), 'hlsjs', platform);
    assert.equal(pickWebEngine(base({ platform, nativeHls: true, hlsJs: false })), 'native-hls', platform);
    assert.equal(pickWebEngine(base({ platform })), 'unsupported', platform);
  }
});

test('MPEG-TS needs mpegts.js, and says unsupported where MediaSource is missing', () => {
  assert.equal(pickWebEngine(base({ platform: 'ios', container: 'mpegts', mpegts: false })), 'unsupported');
  assert.equal(pickWebEngine(base({ platform: 'web', container: 'mpegts', mpegts: true })), 'mpegts');
  assert.equal(pickWebEngine(base({ platform: 'tizen', container: 'mpegts', mpegts: true })), 'mpegts');
  assert.equal(pickWebEngine(base({ platform: 'webos', container: 'mpegts', mpegts: false })), 'unsupported');
});

test('files always go to the element', () => {
  for (const platform of ['ios', 'android', 'tizen', 'webos', 'web'] as Platform[]) {
    assert.equal(pickWebEngine(base({ platform, container: 'file' })), 'file');
  }
});

test('iOS asks a panel for HLS whatever was requested; other platforms keep the request', () => {
  assert.equal(liveFormatFor('ios', 'ts'), 'm3u8');
  assert.equal(liveFormatFor('ios', undefined), 'm3u8');
  assert.equal(liveFormatFor('android', 'ts'), 'ts');
  assert.equal(liveFormatFor('web', undefined), 'auto');
  assert.equal(liveFormatFor('tizen', 'm3u8'), 'm3u8');
  assert.equal(liveFormatFor('webos', undefined), 'auto');
});

test('the iOS live extension, end to end through resolveLiveExt', () => {
  const ext = (allowed: string[] | null, requested: 'ts' | 'm3u8' | undefined, p: Platform) =>
    resolveLiveExt(allowed, liveFormatFor(p, requested));
  assert.equal(ext(['m3u8', 'ts'], 'ts', 'ios'), 'm3u8');
  assert.equal(ext(null, 'ts', 'ios'), 'm3u8');
  /* An account that only offers .ts is not lied about: it gets .ts, and the
     player then says plainly that iOS cannot open it. */
  assert.equal(ext(['ts'], 'ts', 'ios'), 'ts');
  /* Other platforms unchanged. */
  assert.equal(ext(['m3u8', 'ts'], 'ts', 'android'), 'ts');
  assert.equal(ext(['m3u8', 'ts'], undefined, 'android'), 'm3u8');
  assert.equal(ext(['ts'], undefined, 'web'), 'ts');
});

test('live transport: iOS is always the HLS one, even with MediaSource and a pin', () => {
  assert.equal(pickTransport('auto', 1, [], true, true), 'compatible');
  assert.equal(pickTransport('lowLatency', 1, [], true, true), 'compatible');
  assert.equal(pickTransport('auto', 1, [], true, false), 'lowLatency');
  assert.equal(pickTransport('auto', 1, [], false, false), 'compatible');
});

test('live captions are offered everywhere but iOS', () => {
  assert.equal(liveCaptionsPossible('ios'), false);
  for (const p of ['android', 'tizen', 'webos', 'web'] as Platform[]) assert.equal(liveCaptionsPossible(p), true);
});

test('formats iOS cannot open as a film are named; MP4 and friends are not', () => {
  for (const f of ['mkv', 'avi', 'wmv', 'flv', 'm2ts', 'mpg']) {
    assert.equal(iosCannotOpenFile(`https://stream.example.com/movie/u/p/1.${f}`), true, f);
  }
  assert.equal(iosCannotOpenFile('https://stream.example.com/movie/u/p/1.MKV?token=1'), true);
  for (const f of ['mp4', 'm4v', 'mov', 'm3u8']) {
    assert.equal(iosCannotOpenFile(`https://stream.example.com/movie/u/p/1.${f}`), false, f);
  }
  assert.match(IOS_CANNOT_PLAY.container.message, /iPhone or iPad/);
  assert.match(IOS_CANNOT_PLAY.mpegts.message, /iPhone or iPad/);
});

/* ── plugin guards ─────────────────────────────────────────────────────────
   Every Capacitor plugin the web layer registers is Android Java. On iOS a
   registered proxy can only reject, so each registration must sit behind the
   platform check. Pinned on the source, like `nativeFixes.test.ts`, because the
   guard is a line in three files and the next plugin is the one that forgets. */

test('the Streamix plugins are Android-only: no registration without the guard', () => {
  assert.equal(streamixPluginsPossible('ios'), false);
  for (const p of ['android', 'tizen', 'webos', 'web'] as Platform[]) {
    assert.equal(streamixPluginsPossible(p), true, p);
  }
  const files = ['nativePlayer.ts', 'deviceInfo.ts', 'nativeListen.ts'];
  for (const f of files) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    const reg = src.indexOf('registerPlugin<');
    const guard = src.indexOf('nativePluginsPossible()');
    assert.ok(reg > 0 && guard > 0, `${f}: registration and guard both present`);
    assert.ok(guard < reg, `${f}: the platform guard runs before registerPlugin`);
  }
});

test('no other file registers a Capacitor plugin', () => {
  const allowed = new Set(['nativePlayer.ts', 'deviceInfo.ts', 'nativeListen.ts']);
  const dir = new URL('./', import.meta.url);
  for (const f of readdirSyncTs(dir)) {
    if (allowed.has(f) || f.endsWith('.test.ts') || f === 'unthenable.ts') continue;
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/registerPlugin\s*[<(]/.test(src), `${f} registers a plugin outside the guarded set`);
  }
});

import { readdirSync } from 'node:fs';
function readdirSyncTs(dir: URL): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.ts'));
}
