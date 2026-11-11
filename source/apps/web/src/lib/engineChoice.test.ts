import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseEngine } from './nativePlayer.ts';
import type { CapabilityReport, CodecResult, Verdict } from './codecs.ts';

/**
 * Which engine plays a stream, and the one distinction that decides it.
 *
 * `chooseEngine` had no test at all, which is exactly how it survived a change
 * that quietly broke it. Making the support panel honest meant `verdict` stopped
 * meaning "the browser can decode this" and started meaning "this APP can play
 * this" — and on a build carrying libVLC that is `yes` for AC-3 precisely BECAUSE
 * this function routes AC-3 to libVLC. Reading it here is circular: the report
 * says yes, the stream stays in the WebView, the WebView fails, and `escalate()`
 * reaches the native engine anyway — one visible failure and one reload later
 * than it should have. These tests pin the narrow question this function asks.
 */

function row(id: string, browserVerdict: Verdict, over: Partial<CodecResult> = {}): CodecResult {
  return {
    id, label: id, kind: 'audio', note: '',
    mse: null, mediaCaps: null, webCodecs: null,
    native: null,
    browserVerdict,
    verdict: browserVerdict,
    disputed: false,
    ...over,
  };
}

function report(codecs: CodecResult[], nativeAvailable = false): CapabilityReport {
  return {
    at: 0,
    native: { available: nativeAvailable },
    sources: { mse: true, mediaCaps: true, webCodecs: true },
    mse: true, nativeHls: false, tsInMse: false,
    codecs,
  };
}

const HLS = { container: 'hls', url: 'https://example.test/live/1.m3u8' };

test('no native engine is always the WebView, whatever the report says', () => {
  const r = report([row('ac3', 'no')]);
  assert.equal(chooseEngine({ ...HLS, native: false, codec: 'ac3', report: r }), 'webview');
});

test('a codec the WEBVIEW cannot decode goes native', () => {
  const r = report([row('ac3', 'no')], true);
  assert.equal(chooseEngine({ ...HLS, native: true, codec: 'ac3', report: r }), 'native');
});

test('the app being able to play it does not keep it in the WebView', () => {
  /*
   * The regression, exactly. The browser still cannot decode AC-3; the report now
   * says the app can, because this function sends it to libVLC. If this line
   * reads the app-level verdict, AC-3 stays in the WebView and only reaches the
   * native engine after failing to decode.
   */
  const r = report([row('ac3', 'no', { native: 'software', verdict: 'yes' })], true);
  assert.equal(chooseEngine({ ...HLS, native: true, codec: 'ac3', report: r }), 'native');
});

test('the same holds when the device has a hardware decoder for it', () => {
  const r = report([row('eac3', 'no', { native: 'hardware', verdict: 'yes' })], true);
  assert.equal(chooseEngine({ ...HLS, native: true, codec: 'eac3', report: r }), 'native');
});

test('a codec the WebView handles perfectly well stays in the WebView', () => {
  // Where the page can composite over the picture, it should — that is the whole
  // reason this is a choice rather than "always native".
  const r = report([row('aac', 'yes', { native: 'hardware', verdict: 'yes' })], true);
  assert.equal(chooseEngine({ ...HLS, native: true, codec: 'aac', report: r }), 'webview');
});

test('a disputed browser answer still goes native', () => {
  // A codec MediaSource claims and WebCodecs denies is the black-screen case.
  const r = report([row('mp2', 'likely', { disputed: true })], true);
  assert.equal(chooseEngine({ ...HLS, native: true, codec: 'mp2', report: r }), 'native');
});

test('containers no browser can demux go native regardless of codec', () => {
  for (const ext of ['mkv', 'avi', 'wmv', 'flv', 'vob']) {
    assert.equal(
      chooseEngine({ native: true, container: null, url: `https://example.test/movie/9.${ext}` }),
      'native',
      ext,
    );
  }
  /*
   * MPEG-TS included, and this assertion is the reverse of what it used to be.
   *
   * It used to pin `.ts` to the WebView because mpegts.js "usually works". The
   * owner's own debug log says otherwise on the hardware this is for: every live
   * channel on the line is a raw `.ts`, mpegts.js reported "Playback seems stuck
   * at 0" within a second of every one of them, and the app went black and then
   * away at about ten seconds. libVLC is in the APK to demux MPEG-TS.
   */
  assert.equal(
    chooseEngine({ native: true, container: null, url: 'https://example.test/live/9.ts' }),
    'native',
  );
});

test('an unknown codec is left in the WebView rather than guessed at', () => {
  const r = report([row('ac3', 'no')], true);
  assert.equal(chooseEngine({ ...HLS, native: true, codec: null, report: r }), 'webview');
  assert.equal(chooseEngine({ ...HLS, native: true, codec: 'ac3', report: null }), 'webview');
});

/**
 * A file has two codecs and the browser only has to be missing one of them.
 *
 * `matchCodec` tests video patterns before audio ones and returns the FIRST
 * match, so `"h264,eac3"` used to resolve to H.264 — the codec every WebView says
 * yes to — and the E-AC-3 next to it was never asked about. The stream stayed in
 * the WebView and played a picture with no sound, which raises no error and so
 * reaches no escalation.
 *
 * Measured across 1,586 episodes of the live panel (`scripts/series-probe.mjs`,
 * 2026-09-07): 19.5% carry AC-3, E-AC-3 or DTS audio, and 67 of them are an
 * `.mp4` — a container the extension rule lets through — carrying AC-3.
 */
test('a good video codec does not excuse an audio codec the WebView lacks', () => {
  const r = report([row('h264', 'yes'), row('eac3', 'no')], true);
  assert.equal(
    chooseEngine({ ...HLS, native: true, codec: 'h264,eac3', report: r }),
    'native',
  );
});

test('the separators panels actually use are all understood', () => {
  const r = report([row('h264', 'yes'), row('ac3', 'no')], true);
  for (const spelling of ['h264,ac3', 'h264, ac3', 'h264 ac3', 'h264+ac3', 'h264/ac3', 'h264|ac3']) {
    assert.equal(
      chooseEngine({ ...HLS, native: true, codec: spelling, report: r }),
      'native',
      spelling,
    );
  }
});

test('two codecs the WebView handles keep the stream in the WebView', () => {
  // The reverse has to hold too, or this is just "always native" with extra steps.
  const r = report([row('h264', 'yes'), row('aac', 'yes')], true);
  assert.equal(
    chooseEngine({ ...HLS, native: true, codec: 'h264,aac', report: r }),
    'webview',
  );
});

test('a codec string of nothing but noise is still an unknown, not a refusal', () => {
  const r = report([row('ac3', 'no')], true);
  assert.equal(chooseEngine({ ...HLS, native: true, codec: ',,  ,', report: r }), 'webview');
});
