import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODECS, CODES, NATIVE_DECODES, NATIVE_LACKS, browserVerdictOf, decoderRefusal, diagnose, isDisputed,
  matchCodec, missingCodecs, probeCapabilities, verdictOf,
  type CapabilityReport, playableExt,
} from './codecs.ts';

const report = (over: Partial<CapabilityReport> = {}): CapabilityReport => ({
  at: 0,
  native: { available: false },
  sources: { mse: true, mediaCaps: true, webCodecs: true },
  mse: true,
  nativeHls: false,
  tsInMse: false,
  codecs: [],
  ...over,
});

const codec = (id: string, v: 'yes' | 'no' | 'likely' | 'unlikely' | 'unknown', disputed = false) => ({
  id, label: id.toUpperCase(), kind: 'audio' as const, note: '',
  mse: null, mediaCaps: null, webCodecs: null, native: null, browserVerdict: v,
  verdict: v, disputed,
});

test('agreement gives a firm answer; a single source only gives a leaning', () => {
  assert.equal(verdictOf({ mse: true, mediaCaps: { supported: true, smooth: true, efficient: true }, webCodecs: true }), 'yes');
  assert.equal(verdictOf({ mse: false, mediaCaps: { supported: false, smooth: false, efficient: false }, webCodecs: false }), 'no');
  assert.equal(verdictOf({ mse: true, mediaCaps: null, webCodecs: null }), 'likely');
  assert.equal(verdictOf({ mse: false, mediaCaps: null, webCodecs: null }), 'unlikely');
  assert.equal(verdictOf({ mse: null, mediaCaps: null, webCodecs: null }), 'unknown');
});

test('the platform decoder outvotes the browser, because it does the work', () => {
  // The black-screen case: MediaSource claims it, WebCodecs denies it.
  assert.equal(verdictOf({ mse: true, mediaCaps: { supported: true, smooth: true, efficient: true }, webCodecs: false }), 'unlikely');
  assert.equal(verdictOf({ mse: false, mediaCaps: { supported: false, smooth: false, efficient: false }, webCodecs: true }), 'likely');
});

test('disagreement is detected, and needs at least two opinions to exist', () => {
  assert.equal(isDisputed({ mse: true, mediaCaps: null, webCodecs: false }), true);
  assert.equal(isDisputed({ mse: true, mediaCaps: null, webCodecs: null }), false);
  assert.equal(isDisputed({ mse: true, mediaCaps: { supported: true, smooth: false, efficient: false }, webCodecs: true }), false);
});

test('E-AC-3 is matched before AC-3, since one contains the other', () => {
  assert.equal(matchCodec('ec-3')?.id, 'eac3');
  assert.equal(matchCodec('E-AC-3 5.1')?.id, 'eac3');
  assert.equal(matchCodec('Dolby Digital Plus')?.id, 'eac3');
  assert.equal(matchCodec('ac-3')?.id, 'ac3');
  assert.equal(matchCodec('AC3')?.id, 'ac3');
});

test('codec strings from the wild map to the right entry', () => {
  assert.equal(matchCodec('avc1.640028')?.id, 'h264');
  assert.equal(matchCodec('H.264 High')?.id, 'h264');
  assert.equal(matchCodec('hvc1.1.6.L120.90')?.id, 'hevc');
  assert.equal(matchCodec('HEVC')?.id, 'hevc');
  assert.equal(matchCodec('mp4a.40.2')?.id, 'aac');
  assert.equal(matchCodec('mp4a.69')?.id, 'mp2');
  assert.equal(matchCodec(null), null);
  assert.equal(matchCodec('something else'), null);
});

test('a missing decoder is named, and that beats every generic code', () => {
  const d = diagnose('MediaSource error: unsupported codec', {
    codec: 'ec-3',
    report: report({ codecs: [codec('eac3', 'no')] }),
  });
  assert.equal(d.code, CODES.NO_AUDIO_DECODER.code);
  // The label comes from the real codec table, not from the report row, so the
  // message is the same wherever the verdict came from.
  assert.match(d.title, /E-AC-3/);
  assert.ok(d.action);
});

test('a disputed decoder gets its own code rather than being called missing', () => {
  const d = diagnose('black screen', {
    codec: 'hvc1.1.6.L93.B0',
    report: report({ codecs: [{ ...codec('hevc', 'likely', true), kind: 'video' }] }),
  });
  assert.equal(d.code, CODES.DISPUTED_DECODER.code);
});

test('no Media Source at all is reported as such, not as a codec problem', () => {
  const d = diagnose('MPEG-TS demuxing unsupported', { report: report({ mse: false }) });
  assert.equal(d.code, CODES.NO_MSE.code);
});

test('the transport suggestion is the one the viewer is NOT on', () => {
  assert.match(diagnose('codec not supported', { transport: 'mpegts' }).action!, /Compatible/);
  assert.match(diagnose('codec not supported', { transport: 'hls' }).action!, /Low latency/);
});

test('the known non-codec failures each get their own code', () => {
  assert.equal(diagnose('UnrecoverableEarlyEof').code, CODES.TS_ENDED.code);
  assert.equal(diagnose('403 Forbidden').code, CODES.UNREACHABLE.code);
  assert.equal(diagnose('max connections reached').code, CODES.PANEL_BUSY.code);
  assert.equal(diagnose('something nobody predicted').code, CODES.UNKNOWN.code);
});

test('missingCodecs lists the definite ones before the doubtful ones', () => {
  const r = report({ codecs: [codec('a', 'unlikely'), codec('b', 'no'), codec('c', 'yes')] });
  assert.deepEqual(missingCodecs(r).map((c) => c.id), ['b', 'a']);
  assert.deepEqual(missingCodecs(null), []);
});

test('the probe survives a platform that offers none of the three APIs', async () => {
  const r = await probeCapabilities({});
  assert.equal(r.mse, false);
  assert.equal(r.nativeHls, false);
  assert.equal(r.codecs.length, CODECS.length);
  for (const c of r.codecs) assert.equal(c.verdict, 'unknown');
});

test('the probe reads all three sources when they exist', async () => {
  const asked: string[] = [];
  const r = await probeCapabilities({
    MediaSource: { isTypeSupported: (t) => { asked.push(`mse:${t}`); return !t.includes('ec-3'); } },
    VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
    AudioDecoder: { isConfigSupported: async (c) => ({ supported: c.codec !== 'ec-3' }) },
    navigator: {
      mediaCapabilities: {
        decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: false }),
      },
    },
    document: { createElement: () => ({ canPlayType: (t) => (t.includes('mpegurl') ? 'maybe' : '') }) },
  });
  assert.deepEqual(r.sources, { mse: true, mediaCaps: true, webCodecs: true });
  assert.equal(r.nativeHls, true);
  assert.ok(asked.length >= CODECS.length);
  const eac3 = r.codecs.find((c) => c.id === 'eac3')!;
  // MediaSource says no, WebCodecs says no, mediaCapabilities says yes.
  assert.equal(eac3.disputed, true);
  assert.equal(eac3.verdict, 'unlikely');
  assert.equal(r.codecs.find((c) => c.id === 'aac')!.verdict, 'yes');
});

test('a codec string the platform cannot parse counts as unsupported, not unknown', async () => {
  const r = await probeCapabilities({
    MediaSource: { isTypeSupported: () => true },
    VideoDecoder: { isConfigSupported: async () => { throw new TypeError('bad codec'); } },
    AudioDecoder: { isConfigSupported: async () => { throw new TypeError('bad codec'); } },
  });
  /*
   * Only the codecs that were ASKED. WebCodecs has no registered string for
   * MPEG-2 video, DTS, TrueHD, AC-4 or Dolby Vision, so those carry no
   * `webCodec` and the probe never puts a question to the platform about them —
   * which has to stay `null`, "not asked", rather than becoming a "no" this file
   * invented. Making one up to satisfy a loop would be the probe agreeing with
   * itself.
   */
  const byId = new Map(r.codecs.map((c) => [c.id, c]));
  for (const spec of CODECS) {
    const got = byId.get(spec.id)!;
    assert.equal(got.webCodecs, spec.webCodec === undefined ? null : false, spec.id);
  }
});

/* ── the decoder the app is carrying ─────────────────────────────────────────
   Reported as: "even on TV and phone natively loaded it says no for some codecs".
   It did, and the browser answers behind it were correct — they were answers
   about the WebView, published as answers about the device. */

/** What Chromium actually reports for Dolby Digital: a flat, unanimous no. */
const CHROMIUM_SAYS_NO = {
  mse: false,
  mediaCaps: { supported: false, smooth: false, efficient: false },
  webCodecs: false,
};

test('a codec the app carries its own decoder for is a yes, however loudly the browser refuses', () => {
  assert.equal(browserVerdictOf(CHROMIUM_SAYS_NO), 'no', 'the browser answer is unchanged');
  // AC-3 and E-AC-3 are the whole complaint. libVLC decodes both in software.
  assert.equal(verdictOf(CHROMIUM_SAYS_NO, 'software'), 'yes');
  assert.equal(verdictOf(CHROMIUM_SAYS_NO, 'hardware'), 'yes');
});

test('no native engine means the browser still has the last word', () => {
  assert.equal(verdictOf(CHROMIUM_SAYS_NO, null), 'no');
  assert.equal(verdictOf(CHROMIUM_SAYS_NO), 'no', 'and the argument is optional');
});

test('a native engine that genuinely lacks a codec is not talked into having it', () => {
  assert.equal(verdictOf({ mse: true, mediaCaps: null, webCodecs: true }, 'no'), 'no');
});

test('every codec on the list is one libavcodec decodes, or is marked as not', () => {
  // The claim under NATIVE_DECODES is specific: libvlc-all bundles libavcodec,
  // and it carries software decoders for all but one of these. If a codec is ever
  // added to CODECS without deciding this, it silently reports "no" on the APK —
  // so every codec must appear in exactly one of the two sets. EXACTLY one:
  // membership of both would be a contradiction, membership of neither is the
  // forgotten case this test exists to catch.
  for (const spec of CODECS) {
    const decodes = NATIVE_DECODES.has(spec.id);
    const lacks = NATIVE_LACKS.has(spec.id);
    assert.equal(decodes !== lacks, true, `${spec.id} has no native verdict`);
  }
});

test('AC-4 is the one the app cannot decode either, and says so', () => {
  // libavcodec only gained an AC-4 decoder in FFmpeg 7.1; libvlc-all 3.6.x is
  // built on the VLC 3 line, which predates it. Routing AC-4 to libVLC would
  // produce silence, so the honest answer is a refusal.
  assert.equal(NATIVE_DECODES.has('ac4'), false);
  assert.equal(NATIVE_LACKS.has('ac4'), true);
});

test('MP2 and MP3 are no longer asked the same question', () => {
  // Both used `mp4a.69`, so one string was answering for two codecs and neither
  // could ever disagree with the other — which is why both read "disputed".
  const mp2 = CODECS.find((c) => c.id === 'mp2');
  const mp3 = CODECS.find((c) => c.id === 'mp3');
  assert.ok(mp2 && mp3);
  assert.notEqual(mp2.mime, mp3.mime);
  // MP3 is the one codec here every browser plays outside MP4, and the strict
  // spelling alone was reporting it as doubtful on devices that have played it
  // for twenty years.
  assert.equal(mp3.altMime, 'audio/mpeg');
});

test('a dispute stops being reported once the app is doing the decoding', () => {
  // A disagreement among browser APIs predicts a black screen — but only when the
  // browser is what plays it. With libVLC behind it, it predicts nothing.
  const split = { mse: true, mediaCaps: null, webCodecs: false };
  assert.equal(isDisputed(split), true);
  assert.equal(verdictOf(split, 'software'), 'yes');
});

test('every mpegts.js refusal is recognised as one, not as a dropped connection', () => {
  /*
   * The four names mpegts.js actually emits. Only ONE of them contains the
   * substring "codec", and the old test for a refusal was `/codec|mime|MediaSource/`
   * — so three of the four were treated as "the stream stopped, try again",
   * which on a device carrying libVLC is a red box in front of a channel that
   * would have played.
   */
  for (const detail of ['MediaMSEError', 'MediaFormatError', 'MediaFormatUnsupported',
    'MediaCodecUnsupported']) {
    assert.equal(decoderRefusal(detail), true, detail);
  }
});

test('the AC-3 channel from the living-room log escalates instead of erroring', () => {
  // Verbatim from the debug panel on the box: MSE has no AC-3 decoder, libVLC does.
  const msg = "Failed to execute 'addSourceBuffer' on 'MediaSource': "
    + "The type provided ('audio/mp4;codecs=ac-3') is unsupported.";
  assert.equal(decoderRefusal('MediaMSEError', msg), true);
});

test('a dropped connection is still a dropped connection', () => {
  // These must NOT escalate: reconnecting fixes them, and handing them to libVLC
  // spends a channel change on something that was going to recover by itself.
  for (const detail of ['NetworkException', 'NetworkTimeout', 'NetworkStatusCodeInvalid',
    'NetworkUnrecoverableEarlyEof']) {
    assert.equal(decoderRefusal(detail), false, detail);
  }
});


/* ── the codecs this line actually serves ────────────────────────────────────
   Measured with ffprobe against the owner's own subscription, one stream at a
   time (the account allows one connection): 29 channels sampled across country
   and codec-named categories returned h264 and hevc video, aac, ac3 and mp2
   audio. `AR| WATCHBOX REWAYAT H265` came back HEVC video with MP2 audio —
   neither half of which any browser can decode — and the panel publishes NO
   codec field for a live stream, so nothing can know that before pressing play.
   These tests pin the matching that decides where such a stream is sent. */

test('a panel that says mpeg2video means video, not MPEG audio', () => {
  // `mp2` is a substring the audio pattern matches, and `mp2v` is a video
  // fourcc — so the video test has to come first or MPEG-2 video is read as
  // MPEG-2 audio and weighed against the wrong decoder.
  assert.equal(matchCodec('mpeg2video')?.id, 'mpeg2');
  assert.equal(matchCodec('mp2v')?.id, 'mpeg2');
  assert.equal(matchCodec('mp2')?.id, 'mp2');
});

test('Dolby Vision is not Dolby Digital', () => {
  // The AC-3 pattern matches a bare `dolby`, so without an earlier test this
  // VIDEO codec was classified as AUDIO.
  assert.equal(matchCodec('dolby-vision')?.id, 'dolbyvision');
  assert.equal(matchCodec('dvhe.05.06')?.id, 'dolbyvision');
  assert.equal(matchCodec('dolby digital')?.id, 'ac3');
});

test('TrueHD and AC-4 are matched before AC-3 swallows them', () => {
  assert.equal(matchCodec('truehd')?.id, 'truehd');
  assert.equal(matchCodec('dolby truehd')?.id, 'truehd');
  assert.equal(matchCodec('ac-4')?.id, 'ac4');
});

test('DTS is matched at all — it was measured in this catalogue and was not', () => {
  // The note on `chooseEngine` records 19.5% of 1,586 episodes carrying
  // "AC-3, E-AC-3 or DTS". Two of the three were on the list.
  assert.equal(matchCodec('dts')?.id, 'dts');
  assert.equal(matchCodec('dca')?.id, 'dts');
});

test('the HEVC + MP2 channel routes to the native engine on both halves', () => {
  // `AR| WATCHBOX REWAYAT H265`, measured. Either half alone is enough.
  assert.equal(matchCodec('hevc')?.id, 'hevc');
  assert.equal(matchCodec('mp2')?.id, 'mp2');
});

/*
 * The photograph that added these: "Playback failed", a RETRY button, and not
 * one word about why — on a film that plays, from doors that serve it. Every
 * branch below is built from facts the player already had and used to throw
 * away, and each sends somebody somewhere different.
 */
const facts = (over: Partial<Parameters<typeof diagnose>[1]['facts'] & object> = {}) => ({
  container: 'file', ext: 'mkv', live: false, bytes: true, played: false, afterSeek: false,
  nativeEngine: false, online: true, doorsTried: 0, doorsRefused: 0,
  ...over,
});

test('a device that knows it is offline is told that, not that the channel is down', () => {
  const d = diagnose('', { facts: facts({ online: false, bytes: false }) });
  assert.equal(d.code, CODES.OFFLINE.code);
  assert.match(d.action!, /internet/i);
});

test('offline outranks a codec verdict, because nothing reached a decoder', () => {
  const d = diagnose('', {
    codec: 'hevc',
    report: report({ codecs: [{ ...codec('hevc', 'no'), kind: 'video' as const }] }),
    facts: facts({ online: false }),
  });
  assert.equal(d.code, CODES.OFFLINE.code);
});

test('a film that died right after a jump says so, and says RETRY is worth it', () => {
  const d = diagnose('', { facts: facts({ afterSeek: true, played: true }) });
  assert.equal(d.code, CODES.AFTER_JUMP.code);
  assert.match(d.action!, /one connection at a time/i);
});

test('doors that refused the ACCOUNT are named as the line being busy', () => {
  const d = diagnose('', { facts: facts({ doorsRefused: 2, doorsTried: 3 }) });
  assert.equal(d.code, CODES.PANEL_BUSY.code);
  assert.match(d.action!, /2 servers/);
});

test('nothing arriving is reported as the connection, with how many doors were tried', () => {
  const d = diagnose('', { facts: facts({ bytes: false, doorsTried: 4 }) });
  assert.equal(d.code, CODES.NO_BYTES.code);
  assert.match(d.action!, /4 servers/);
});

test('a stream that had been playing is a cut connection, not a broken film', () => {
  const d = diagnose('', { facts: facts({ played: true }) });
  assert.equal(d.code, CODES.STOPPED.code);
});

test('bytes but no picture points at the box on a browser and at the film in the app', () => {
  const web = diagnose('', { facts: facts({ nativeEngine: false }) });
  assert.match(web.action!, /\.mkv/);
  assert.match(web.action!, /TV box/i);
  const app = diagnose('', { facts: facts({ nativeEngine: true }) });
  assert.match(app.action!, /another title/i);
});

test('with no facts at all the old silence is kept rather than a guess invented', () => {
  /* A snapshot from an older build, or an error raised before a stream had a
     shape. Saying something confident here would be saying it about nothing. */
  const d = diagnose('something nobody has seen before');
  assert.equal(d.code, CODES.UNKNOWN.code);
  assert.equal(d.action, null);
});

/*
 * ── saying something true to the viewer ──
 *
 * Both of these were photographed off a real screen. One described a film as
 * "a .file file"; the other told somebody watching a MOVIE to "switch this
 * channel to the Low latency (raw TS) transport", which is a control a film
 * does not have.
 */

test('the extension comes from the address, not from the transport', () => {
  assert.equal(playableExt('http://h/movie/u/p/2131378.mkv'), 'mkv');
  assert.equal(playableExt('http://h/live/u/p/9.ts?token=x'), 'ts');
  assert.equal(playableExt('http://h/live/u/p/9.m3u8#frag'), 'm3u8');
});

test('an address with no meaningful extension says so rather than inventing one', () => {
  /* Our own assembled film is the case that matters: `/api/film/play?...` is
     not a file and must not be described as one. */
  assert.equal(playableExt('http://box/api/film/play?u=http%3A%2F%2Fh%2Fa.mkv&audio=1'), null);
  assert.equal(playableExt('http://h/player_api.php?x=1'), null);
  assert.equal(playableExt('http://h/live/u/p/9'), null);
  assert.equal(playableExt(''), null);
});

test('a film is never told to change its transport', () => {
  const d = diagnose('MEDIA_ERR_SRC_NOT_SUPPORTED: demuxer error', {
    transport: 'native',
    facts: {
      container: 'file', ext: 'mkv', live: false, bytes: true, played: false,
      afterSeek: false, nativeEngine: false, online: true, doorsTried: 0, doorsRefused: 0,
    },
  });
  assert.ok(!/channel|transport|latency/i.test(d.action ?? ''), d.action ?? '');
  assert.match(d.action ?? '', /film/i);
});

test('a live channel still gets the transport advice, which is real there', () => {
  const d = diagnose('demux error', {
    transport: 'mpegts',
    facts: {
      container: 'mpegts', ext: 'ts', live: true, bytes: true, played: false,
      afterSeek: false, nativeEngine: false, online: true, doorsTried: 0, doorsRefused: 0,
    },
  });
  assert.match(d.action ?? '', /transport/i);
});

test('an unshowable film names the real extension, or nothing at all', () => {
  const withExt = diagnose('something odd', {
    facts: {
      container: 'file', ext: 'mkv', live: false, bytes: true, played: false,
      afterSeek: false, nativeEngine: false, online: true, doorsTried: 0, doorsRefused: 0,
    },
  });
  assert.match(withExt.action ?? '', /a \.mkv file/);

  const noExt = diagnose('something odd', {
    facts: {
      container: 'file', ext: null, live: false, bytes: true, played: false,
      afterSeek: false, nativeEngine: false, online: true, doorsTried: 0, doorsRefused: 0,
    },
  });
  assert.ok(!/\.file|\.null|\(a \./.test(noExt.action ?? ''), noExt.action ?? '');
});
