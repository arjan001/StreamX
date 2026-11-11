import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseEngine, isFilmUrl } from './nativePlayer.ts';

/**
 * Three native defects found on 2026-09-28 by driving the TV emulator against a
 * fake panel that allows one connection, with a clock burned into the film.
 */

/** The directory holding the Android plugin sources, whatever the package is called. */
async function pluginDir(): Promise<URL> {
  const { readdirSync, existsSync } = await import('node:fs');
  const base = new URL('../../../mobile/android/app/src/main/java/', import.meta.url);
  const walk = (rel: string): string | null => {
    const here = new URL(rel, base);
    if (existsSync(new URL('StreamixPlayerPlugin.java', here))) return rel;
    for (const e of readdirSync(here, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const hit = walk(`${rel}${e.name}/`);
      if (hit !== null) return hit;
    }
    return null;
  };
  const found = walk('');
  assert.ok(found !== null, 'the plugin sources are where this test expects them');
  return new URL(found, base);
}

test('every whole-number argument the page sends reaches the native side', async () => {
  /*
   * "cannot go backwards and forwards — it just starts from the beginning".
   *
   * Capacitor 7.6.9's `PluginCall.getLong` returns the value only when org.json
   * stored a Long, and org.json stores anything that fits in 32 bits as an
   * Integer. So every seek arrived as 0 — libVLC's own log: "seek request to
   * i_pos = 0" for a seek to 5:00 — and so did every resume position. A source guard, because the failure is a call
   * that compiles, runs and quietly reads zero.
   */
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = await pluginDir();
  const java = readdirSync(dir).filter((f) => f.endsWith('.java'));
  assert.ok(java.length > 3, 'the plugin sources are where this test expects them');
  for (const f of java) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/\bcall\.getLong\(/.test(src), `${f} reads a number with call.getLong — use PluginArgs.longOf`);
  }
  const player = readFileSync(new URL('StreamixPlayerPlugin.java', dir), 'utf8');
  assert.match(player, /PluginArgs\.longOf\(call, "timeMs"/);
  assert.match(player, /PluginArgs\.longOf\(call, "startAtMs"/);
});

test('films and episodes open in libVLC on a device that has it', () => {
  /*
   * The WebView went first for an MP4 carrying H.264 and AAC. A real
   * customer's MediaTek TV and the emulator both had it refuse ordinary films
   * outright, the fallback's one-byte probe then took the line's only
   * connection from libVLC, and a `<video>` seek on a one-connection line is
   * refused anyway. libVLC decodes in hardware with a software fallback and
   * plays through the device's own relay, which waits for the slot.
   */
  const film = (url: string, codec: string | null = 'h264,aac') =>
    chooseEngine({ native: true, container: 'mp4', url, codec, report: null });
  assert.equal(film('http://h/movie/u/p/1752155.mp4'), 'native');
  assert.equal(film('http://h/series/u/p/99.mp4'), 'native');
  assert.equal(film('http://h/movie/u/p/1.mkv', null), 'native');
  assert.equal(isFilmUrl('http://h/live/u/p/1.m3u8'), false);
  /* The website has no libVLC: nothing changes there. */
  assert.equal(chooseEngine({ native: false, container: 'mp4', url: 'http://h/movie/u/p/1.mp4', report: null }), 'webview');
});

test('libVLC plays single files through the device relay, never through our server', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = await pluginDir();
  const player = readFileSync(new URL('StreamixPlayerPlugin.java', dir), 'utf8');
  assert.match(player, /OneConnectionRelay\.eligible\(url\)/);
  assert.match(player, /relay\(\)\.wrap\(url, userAgent, headerMap\(headers\)\)/);
  assert.match(player, /if \(relay != null\) relay\.release\(\);/, 'stopping lets go of the line at once');
  const relay = readFileSync(new URL('OneConnectionRelay.java', dir), 'utf8');
  assert.match(relay, /InetAddress\.getByName\("127\.0\.0\.1"\)/, 'loopback only — never an open proxy');
});

test('the operator can switch the device relay off, and it is on until they do', async () => {
  const { applyOperatorConfig, deviceRelayAllowed, readOperatorFlags } = await import('./operatorFlags.ts');
  assert.equal(readOperatorFlags(null).deviceRelayOff, false);
  applyOperatorConfig({});
  assert.equal(deviceRelayAllowed(), true, 'no config yet, or none saved: relay on');
  applyOperatorConfig({ deviceRelayOff: true });
  assert.equal(deviceRelayAllowed(), false);
  applyOperatorConfig({ deviceRelayOff: false });
  assert.equal(deviceRelayAllowed(), true);
  const { readFileSync } = await import('node:fs');
  const bridge = readFileSync(new URL('./nativeBridge.ts', import.meta.url), 'utf8');
  assert.match(bridge, /deviceRelayAllowed\(\) \? \{\} : \{ relay: false \}/, 'and the player is told');
});

test('a slow film start never falls back to the WebView, and waits long enough for the slot', async () => {
  /*
   * Cold launch on the TV emulator, reopening the last film: libVLC was silent
   * while the relay waited for the panel to free the slot, the 25s silence
   * window ran out, and the film was retried in the WebView — which refuses
   * these films on this device class — so "opening" sat for over a minute.
   */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./playerCore.ts', import.meta.url), 'utf8');
  assert.match(src, /const NATIVE_FILM_WAIT_MS = 40_000;/);
  const stalled = src.slice(src.indexOf('private nativeStalled('));
  const filmBranch = stalled.indexOf('if (!spec.live && isFilmUrl(spec.target.url))');
  const toWebView = stalled.indexOf('this.skipNativeOnce = true;');
  assert.ok(filmBranch > 0 && toWebView > 0 && filmBranch < toWebView,
    'films are answered before the WebView fallback is reached');
  assert.equal((src.match(/this\.nativeStalled\(mine, forced\), NATIVE_WAIT_MS\)/g) ?? []).length, 0,
    'every silence timer asks nativeWaitMs, so films get the longer window');
});
