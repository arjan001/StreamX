import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionRefused, emptyStreamHint, nativeAskVerdict, refusalVerdict, refusedByBrowser,
  serverVerdict, tsRefusal,
} from './playerCore.ts';
import { CODES, diagnose } from './codecs.ts';

const err = (over: Record<string, unknown> = {}) => ({
  details: 'manifestLoadError',
  url: 'https://stream.starmenajo.com/hls/app/live/ts:fhd.m3u8',
  response: { code: 0 },
  ...over,
});

/* Status 0 is XHR saying it has nothing to report: the response exists, the page
   is not allowed to see it. Both real cases this week were CORS — one server
   sending no Access-Control-Allow-Origin, one sending it twice. */
test('a response the browser would not hand over names the host', () => {
  assert.equal(refusedByBrowser(err(), 0), 'stream.starmenajo.com');
});

test('a server that actually answered is left to the existing retry', () => {
  assert.equal(refusedByBrowser(err({ response: { code: 404 } }), 0), null);
  assert.equal(refusedByBrowser(err({ response: { code: 403 } }), 0), null);
  assert.equal(refusedByBrowser(err({ response: { code: 502 } }), 0), null);
});

/* A stream that has been running and drops is an ordinary blip, and reconnecting
   is exactly right for it. This is only for the case where nothing ever worked. */
test('only the first attempt — a reconnect is not a diagnosis', () => {
  assert.equal(refusedByBrowser(err(), 1), null);
  assert.equal(refusedByBrowser(err(), 4), null);
});

test('a mid-stream fragment failure is not this, whatever its status', () => {
  assert.equal(refusedByBrowser(err({ details: 'fragLoadError' }), 0), null);
  assert.equal(refusedByBrowser(err({ details: 'levelLoadError' }), 0), null);
  // A timeout DID leave the browser; it just never came back.
  assert.equal(refusedByBrowser(err({ details: 'manifestLoadTimeOut' }), 0), null);
});

test('a missing or unparseable url still produces a diagnosis, not a crash', () => {
  assert.equal(refusedByBrowser(err({ url: undefined }), 0), 'that server');
  assert.equal(refusedByBrowser(err({ url: 'not a url' }), 0), 'not a url');
});

test('a malformed error object is not a blocked stream', () => {
  assert.equal(refusedByBrowser({}, 0), null);
  assert.equal(refusedByBrowser({ details: 'manifestLoadError' }, 0), null);
});

/*
 * The half that was actually wrong on screen.
 *
 * Before this, a blocked stream retried five times and then reported "the stream
 * dropped repeatedly... the channel is probably offline, or the single allowed
 * connection is still held by a previous session" — two claims, both false, and
 * both of which send someone off to wait and try again.
 */
test('blocked outranks every codec verdict, because none of them was reached', () => {
  const d = diagnose('manifestLoadError', {
    blocked: { host: 'lsfb.avap.jilintv.cn' },
    // A device that genuinely cannot decode HEVC. Irrelevant here: no byte of
    // this stream ever arrived to be decoded.
    codec: 'hevc',
    report: {
      at: 0,
      native: { available: false },
      sources: { mse: true, mediaCaps: true, webCodecs: true },
      mse: true,
      nativeHls: false,
      tsInMse: false,
      codecs: [{
        id: 'hevc', label: 'HEVC', kind: 'video' as const, note: '',
        mse: false, mediaCaps: null, webCodecs: null, native: null,
        browserVerdict: 'no' as const, verdict: 'no' as const, disputed: false,
      }],
    },
  });
  assert.equal(d.code, CODES.BLOCKED.code);
  assert.match(d.action ?? '', /lsfb\.avap\.jilintv\.cn/);
});

test('without the flag, nothing changes about any other diagnosis', () => {
  assert.equal(diagnose('manifestLoadError').code, CODES.UNKNOWN.code);
  assert.equal(diagnose('404 not found').code, CODES.UNREACHABLE.code);
});

/* ── the panel refusing a CONNECTION, which is not a broken stream ───────── */

test('the Xtream flood statuses are recognised, and 404 is not one of them', () => {
  /*
    Reported as a wall of `…/777860.m3u8: 456`, the same channel three times over.
    456 is in nobody's HTTP registry; on these panels it means "you already have
    as many streams open as you are allowed", alongside 509/511/513.
  */
  for (const code of [456, 509, 511, 513]) {
    assert.equal(
      connectionRefused({ details: 'manifestLoadError', response: { code } }),
      code,
    );
  }
  /* A real answer about a real stream. 404 means the channel is gone and the
     existing backoff is right for it. */
  assert.equal(connectionRefused({ details: 'manifestLoadError', response: { code: 404 } }), null);
  assert.equal(connectionRefused({ details: 'manifestLoadError', response: { code: 0 } }), null);
});

test('a refusal is only read off a LOAD failure', () => {
  /* A buffer or codec failure carries no HTTP status worth reading, and treating
     one as a connection limit would tell a viewer to wait for a slot that is not
     the problem. */
  assert.equal(connectionRefused({ details: 'bufferAppendError', response: { code: 456 } }), null);
  assert.equal(connectionRefused({ details: 'manifestLoadError' }), null);
  assert.equal(connectionRefused({}), null);
});

test('it does not depend on the attempt count, unlike a browser refusal', () => {
  /*
    `refusedByBrowser` only fires on the first attempt, because a stream that
    played and then stumbled deserves a retry. This is the opposite case: on a
    one-connection line each retry OPENS a session and the panel holds a finished
    one for 30-120s, so retrying is what keeps the slot busy. It must report on
    the fifth attempt exactly as on the first.
  */
  assert.equal(connectionRefused({ details: 'fragLoadError', response: { code: 456 } }), 456);
  assert.equal(connectionRefused({ details: 'levelLoadError', response: { code: 509 } }), 509);
});

/* ── one door refusing, versus every door refusing ────────────────────────── */

test('one refusal explains the slot; two name the account', () => {
  /*
    "When 456 comes from all mirrors, tell them they are blocked or something,
    because now it's not enough." The slot sentence is right about ONE server and
    actively misleading after several: it sends somebody off to wait two minutes
    for a slot that is never going to open.
  */
  const one = refusalVerdict(1, 1, 456);
  assert.match(one.message, /one stream at a time/i);
  assert.match(one.hint, /two minutes/i);

  const all = refusalVerdict(3, 1, 456);
  assert.match(all.message, /every server refused this account/i);
  assert.match(all.message, /456/);
  /* Names how many, so the claim is checkable rather than asserted. */
  assert.match(all.hint, /3 different servers/);
  /* And does NOT send them off to wait for a slot. */
  assert.doesNotMatch(all.hint, /two minutes/i);
});

test('the account verdict does not depend on the connection allowance', () => {
  /*
    A line allowing four connections that is refused by four separate hosts is
    just as blocked as a one-connection line. `maxConnections` only shapes the
    single-door wording, where it is the likely explanation.
  */
  assert.match(refusalVerdict(2, 4, 456).message, /every server/i);
  assert.match(refusalVerdict(2, null, 509).message, /every server/i);
  assert.match(refusalVerdict(1, 4, 456).message, /refused another connection/i);
});

test('the code that was actually seen is the code that is reported', () => {
  /* 509 and 511 reach here too, and quoting 456 at somebody whose log says 511
     is how a support conversation goes wrong. */
  assert.match(refusalVerdict(2, 1, 511).message, /511/);
  assert.match(refusalVerdict(2, 1, 511).hint, /511 is what these panels send/);
});

/* ── what the server said, for the engine that cannot say ─────────────────────
   A progressive `<video>` reports four numbers and nothing else, so every one of
   these arrives at the player as MEDIA_ERR_SRC_NOT_SUPPORTED. Measured in
   Chromium 2026-09-07: a 200/text/html/0-byte answer gives
   "DEMUXER_ERROR_COULD_NOT_OPEN", a 400 with a video Content-Type gives
   "Format error", and a 456 gives "Format error" — the same code and a decoder's
   vocabulary for three failures that have nothing to do with a decoder. */

test('a panel that answered success with an empty page is a dead title', () => {
  /* The exact shape measured on this line: two of 26 sampled episodes answered
     `200 text/html` with zero bytes, from the panel itself, with no redirect,
     reproducibly and on every door that serves this account. */
  assert.equal(serverVerdict(200, 'text/html; charset=UTF-8', false), 'gone');
  assert.equal(serverVerdict(200, 'text/html', true), 'gone');
});

test('a media Content-Type with no bytes behind it is still nothing', () => {
  assert.equal(serverVerdict(200, 'video/mp4', false), 'gone');
  assert.equal(serverVerdict(206, 'video/x-matroska', false), 'gone');
});

test('real bytes with a media type mean the decoder really did refuse them', () => {
  /* The ONLY verdict that should spend the stream's single escalation. */
  assert.equal(serverVerdict(200, 'video/mp4', true), 'media');
  assert.equal(serverVerdict(206, 'video/x-matroska', true), 'media');
  assert.equal(serverVerdict(206, 'video/mp2t', true), 'media');
  assert.equal(serverVerdict(206, 'audio/mpeg', true), 'media');
  /* Some doors serve `.mkv` as a byte stream rather than naming it. */
  assert.equal(serverVerdict(206, 'application/octet-stream', true), 'media');
});

test('the flood replies are a busy line, not a broken title', () => {
  for (const code of [456, 509, 511, 513]) {
    assert.equal(serverVerdict(code, 'text/html', false), 'busy', String(code));
  }
});

test('551 is the panel having nothing under that name, and waiting will not help', () => {
  /*
    Measured by asking a real `.mkv` episode for `.mp4`, and by asking for it with
    no extension at all: both answer 551 where the right extension answers 302 and
    then 206. Calling that "busy" would send someone off to wait two minutes for a
    slot, which is the mistake `refusalVerdict` was written to stop making.
  */
  assert.equal(serverVerdict(551, 'text/html', false), 'gone');
});

test('a content edge refusing is an error worth quoting, not a codec', () => {
  /* Five of 26 sampled episodes: the panel 302s to a content IP and that IP
     answers 400 with the right media Content-Type and no body. Identical with a
     bounded Range, with `bytes=0-`, and with no Range at all — so it is the file,
     not the request. */
  assert.equal(serverVerdict(400, 'video/x-matroska', false), 'error');
  assert.equal(serverVerdict(403, 'text/html', false), 'error');
  assert.equal(serverVerdict(404, 'text/html', false), 'error');
  assert.equal(serverVerdict(502, 'text/html', false), 'error');
});

test('a Content-Type is read as a type, not as a string to match on', () => {
  assert.equal(serverVerdict(206, 'VIDEO/MP4; charset=binary', true), 'media');
  assert.equal(serverVerdict(206, '  video/mp4  ', true), 'media');
  assert.equal(serverVerdict(206, null, true), 'gone');
  assert.equal(serverVerdict(206, '', true), 'gone');
});

/* ── the mpegts.js (raw TS) path reading the SAME flood codes ─────────────── */

test('the mpegts.js HttpStatusCodeInvalid detail carries the flood codes too', () => {
  /*
    mpegts.js does not shape its error like hls.js's `{response: {code}}` — read
    `node_modules/mpegts.js/src/io/fetch-stream-loader.js`: any non-2xx response
    calls `onError('HttpStatusCodeInvalid', {code: res.status, msg:
    res.statusText})`. Confirmed against the installed 1.8.2 source, because the
    README says nothing about the shape of that third callback argument.
  */
  for (const code of [456, 509, 511, 513]) {
    assert.equal(tsRefusal('HttpStatusCodeInvalid', { code }), code);
  }
});

test('a real answer about a real stream is not a flood code, for mpegts either', () => {
  assert.equal(tsRefusal('HttpStatusCodeInvalid', { code: 404 }), null);
  assert.equal(tsRefusal('HttpStatusCodeInvalid', { code: 200 }), null);
});

test('every other mpegts detail carries no HTTP status at all', () => {
  /* EarlyEof, Exception, UnrecoverableEarlyEof are not HTTP answers, and reading
     a status off them would be reading a field that was never sent — this is the
     regex two lines below in `playerCore.ts` that used to catch a 456 by accident
     because it only matched on "NetworkError", never on the status underneath. */
  assert.equal(tsRefusal('EarlyEof', { code: 456 }), null);
  assert.equal(tsRefusal('Exception', { code: 509 }), null);
  assert.equal(tsRefusal('UnrecoverableEarlyEof', { code: 511 }), null);
  assert.equal(tsRefusal('HttpStatusCodeInvalid', undefined), null);
  assert.equal(tsRefusal('HttpStatusCodeInvalid', {}), null);
});

/* ── what askServer's answer means for the NATIVE engine ───────────────────
   Photographed on a customer's TV, Android TV app 1.17.0, a live channel, a
   paid single-connection account: `native: error`, then `fetch 456
   stream.example.com/live/<redacted>/<redacted>/2023189.ts`, then a hint claiming
   the server "accepted the request and then sent nothing" and that "live
   television uses a different server" — false on both counts, since 456 IS a
   refusal and the failing channel WAS live television. `nativeAskVerdict` is
   the classification `nativeRefused` now checks first, before the
   401/403/404/410/451 door codes it already knew. */

test('nativeAskVerdict treats a flood status as busy, not a refused door', () => {
  for (const status of [456, 509, 511, 513]) {
    assert.equal(nativeAskVerdict({ status, type: 'text/html', bytes: false }), 'busy');
  }
});

test('nativeAskVerdict treats no answer, and the door codes, as a refused door', () => {
  assert.equal(nativeAskVerdict(null), 'refusedDoor');
  for (const status of [401, 403, 404, 410, 451]) {
    assert.equal(nativeAskVerdict({ status, type: 'text/html', bytes: false }), 'refusedDoor');
  }
});

test('nativeAskVerdict treats real bytes with a media type as the engines problem', () => {
  assert.equal(nativeAskVerdict({ status: 200, type: 'video/mp4', bytes: true }), 'media');
  assert.equal(
    nativeAskVerdict({ status: 206, type: 'application/octet-stream', bytes: true }),
    'media',
  );
});

test('nativeAskVerdict treats a 2xx with nothing playable as empty, not media', () => {
  assert.equal(nativeAskVerdict({ status: 200, type: 'text/html', bytes: false }), 'empty');
  assert.equal(nativeAskVerdict({ status: 200, type: 'text/html', bytes: true }), 'empty');
  assert.equal(nativeAskVerdict({ status: 200, type: 'application/json', bytes: true }), 'empty');
});

/* ── the one sentence that must never describe the stream that is failing ─── */

test('emptyStreamHint keeps the live-television contrast for a film', () => {
  /* Correct on a film: this device really does play live TV perfectly while one
     title's edge sends nothing, and the contrast IS the diagnosis. */
  assert.match(
    emptyStreamHint('stream.example.com', false),
    /Live television uses a different server/,
  );
});

test('emptyStreamHint drops that sentence for a live channel', () => {
  /* The channel photographed failing this way WAS live television, so the old
     wording asserted the live-vs-VOD contrast against itself. See the report
     above the busy check in `nativeRefused`. */
  const hint = emptyStreamHint('stream.example.com', true);
  assert.doesNotMatch(hint, /Live television uses a different server/);
  assert.match(hint, /accepted the request and then sent nothing/);
});

test('emptyStreamHint still reads as a sentence with no origin to name', () => {
  assert.match(emptyStreamHint('', true), /^The media server accepted the request/);
});
