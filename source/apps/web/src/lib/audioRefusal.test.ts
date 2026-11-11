import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECLARE_GRACE_MS, judgeSound, noSoundMessage, refusedSourceBufferType,
  type DeclaredMedia, type SoundCheck,
} from './audioRefusal.ts';
import { matchCodec } from './codecs.ts';

/* The sentence mpegts.js forwarded as `info.msg`, verbatim, from
   `DE| SKY BUNDESLIGA 1 HD` in Chromium 151 (2026-09-15). */
const AC3_REFUSAL = "Failed to execute 'addSourceBuffer' on 'MediaSource': The type provided "
  + "('audio/mp4;codecs=ac-3') is unsupported.";

/* MEDIA_INFO from the same run, 1ms after the refusal. */
const SKY: DeclaredMedia = {
  hasAudio: true, audioCodec: 'ac-3', hasVideo: true, videoCodec: 'avc1.4d401f',
};
/* And from `BE| NPO 1 ᴿᴬᵂ`, which played with sound. */
const NPO: DeclaredMedia = {
  hasAudio: true, audioCodec: 'mp4a.40.2', hasVideo: true, videoCodec: 'avc1.64002a',
};

const check = (over: Partial<SoundCheck>): SoundCheck => ({
  declared: null, refused: [], videoFrames: 0, audioBytes: 0, sinceRefusalMs: 0, ...over,
});

test('the type is read out of the refusal sentence, and only out of that sentence', () => {
  assert.equal(refusedSourceBufferType(AC3_REFUSAL), 'audio/mp4;codecs=ac-3');
  assert.equal(
    refusedSourceBufferType("Failed to execute 'addSourceBuffer' on 'MediaSource': The type "
      + "provided ('video/mp4;codecs=hvc1.1.6.L93.B0') is unsupported."),
    'video/mp4;codecs=hvc1.1.6.L93.B0',
  );
  /* Other MSE exceptions carry no type, and are not codec refusals at all. */
  assert.equal(refusedSourceBufferType("Failed to execute 'addSourceBuffer' on 'MediaSource': "
    + 'This MediaSource has reached the limit of SourceBuffer objects it can handle.'), null);
  assert.equal(refusedSourceBufferType("Failed to execute 'appendBuffer' on 'SourceBuffer': "
    + 'This SourceBuffer has been removed from the parent media source.'), null);
  /* A browser whose wording quotes no type keeps the ordinary refusal path. */
  assert.equal(refusedSourceBufferType('MediaSource.addSourceBuffer: Type not supported in MediaSource'), null);
  assert.equal(refusedSourceBufferType(''), null);
});

test('the measured AC-3 channel: refused, then declared a millisecond later — soundless', () => {
  const refused = ['audio/mp4;codecs=ac-3'];
  /* At the ERROR: MEDIA_INFO is not in yet, so nothing is decided. */
  assert.deepEqual(judgeSound(check({ refused, sinceRefusalMs: 1 })), { kind: 'wait' });
  /* At MEDIA_INFO: the stream declares AC-3 and a picture, the engine refused the AC-3. */
  const verdict = judgeSound(check({ refused, declared: SKY, sinceRefusalMs: 1 }));
  assert.equal(verdict.kind, 'soundless');
  assert.equal(verdict.kind === 'soundless' && verdict.codec, 'ac-3');
  assert.equal(verdict.kind === 'soundless' && verdict.spec?.id, 'ac3');
  /* And 15 seconds on, with the counters the element really showed. */
  assert.equal(
    judgeSound(check({ refused, declared: SKY, videoFrames: 370, audioBytes: 0, sinceRefusalMs: 15_000 })).kind,
    'soundless',
  );
});

test('the measured AAC channel is never touched: nothing was refused', () => {
  assert.deepEqual(judgeSound(check({ declared: NPO, videoFrames: 17, audioBytes: 8_048 })), { kind: 'fine' });
  assert.deepEqual(judgeSound(check({ declared: NPO, videoFrames: 767, audioBytes: 188_013 })), { kind: 'fine' });
});

test('silence never triggers it — a channel with no audio track, however long it plays', () => {
  const noAudio: DeclaredMedia = { hasAudio: false, audioCodec: null, hasVideo: true, videoCodec: 'avc1.640028' };
  for (const declared of [null, noAudio]) {
    assert.deepEqual(
      judgeSound(check({ declared, videoFrames: 9_000, audioBytes: 0, sinceRefusalMs: 600_000 })),
      { kind: 'fine' },
    );
    assert.deepEqual(
      judgeSound(check({ declared, videoFrames: 9_000, audioBytes: null, sinceRefusalMs: 600_000 })),
      { kind: 'fine' },
    );
  }
  /* A stream that declares no sound is not missing any, whatever was refused. */
  assert.deepEqual(
    judgeSound(check({ declared: noAudio, refused: ['audio/mp4;codecs=ac-3'], videoFrames: 50 })),
    { kind: 'fine' },
  );
});

test('audio the engine plays (AAC, MP3) is never refused, so never judged', () => {
  for (const audioCodec of ['mp4a.40.2', 'mp3']) {
    const declared = { ...NPO, audioCodec };
    assert.deepEqual(judgeSound(check({ declared, videoFrames: 100, audioBytes: 0, sinceRefusalMs: 60_000 })), { kind: 'fine' });
  }
});

test('audio bytes reaching the decoder veto the verdict', () => {
  assert.deepEqual(
    judgeSound(check({ refused: ['audio/mp4;codecs=ac-3'], declared: SKY, videoFrames: 40, audioBytes: 12_000 })),
    { kind: 'fine' },
  );
});

test('a refused picture is not a sound problem — there is nothing to keep', () => {
  assert.deepEqual(
    judgeSound(check({
      refused: ['video/mp4;codecs=hvc1.1.6.L93.B0', 'audio/mp4;codecs=ac-3'],
      declared: { ...SKY, videoCodec: 'hvc1.1.6.L93.B0' },
    })),
    { kind: 'unplayable' },
  );
  /* A video refusal alone belongs to the video branch, not to this function. */
  assert.deepEqual(judgeSound(check({ refused: ['video/mp4;codecs=hvc1.1.6.L93.B0'], declared: SKY })), { kind: 'fine' });
});

test('refused sound with no picture declared is the ordinary refusal, not a note over nothing', () => {
  const radio: DeclaredMedia = { hasAudio: true, audioCodec: 'ac-3', hasVideo: false, videoCodec: null };
  assert.deepEqual(judgeSound(check({ refused: ['audio/mp4;codecs=ac-3'], declared: radio })), { kind: 'unplayable' });
  assert.deepEqual(
    judgeSound(check({ refused: ['audio/mp4;codecs=ac-3'], declared: { ...radio, hasVideo: null } })),
    { kind: 'unplayable' },
  );
});

test('with no declaration at all, the grace decides on what the element proves', () => {
  const refused = ['audio/mp4;codecs=ec-3'];
  assert.deepEqual(judgeSound(check({ refused, sinceRefusalMs: DECLARE_GRACE_MS - 1, videoFrames: 30 })), { kind: 'wait' });
  const kept = judgeSound(check({ refused, sinceRefusalMs: DECLARE_GRACE_MS, videoFrames: 30 }));
  assert.equal(kept.kind, 'soundless');
  assert.equal(kept.kind === 'soundless' && kept.spec?.id, 'eac3');
  assert.deepEqual(judgeSound(check({ refused, sinceRefusalMs: DECLARE_GRACE_MS, videoFrames: 0 })), { kind: 'unplayable' });
});

test('the note names the codec, and points at the TV app only where the app plays it', () => {
  const web = noSoundMessage('ac-3', matchCodec('ac-3'), 'web');
  assert.match(web, /^No sound: this channel's audio is AC-3 \(Dolby Digital\), which this browser can't play\./);
  assert.match(web, /TV app plays it\.$/);
  /* AC-4 is in NATIVE_LACKS: the app would be silent too, so it is not offered. */
  const ac4 = noSoundMessage('ac-4', matchCodec('ac-4'), 'web');
  assert.match(ac4, /AC-4/);
  assert.doesNotMatch(ac4, /app/);
  /* Inside the app, "get the app" would be absurd. */
  const app = noSoundMessage('ac-3', matchCodec('ac-3'), 'app');
  assert.match(app, /AC-3 \(Dolby Digital\)/);
  assert.doesNotMatch(app, /app|browser/);
  /* An unknown codec is still named rather than dropped. */
  assert.match(noSoundMessage('xyz', null, 'web'), /audio is XYZ,/);
});
