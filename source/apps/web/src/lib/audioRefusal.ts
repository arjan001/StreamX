/**
 * A live channel whose PICTURE the engine accepted and whose SOUND it refused.
 *
 * Kept pure — no element, no engine, no clock — so the rule can be tested with
 * the numbers it was chosen from. `PlayerCore` gathers the inputs and acts on
 * the verdict; see `checkSound` there.
 *
 * ── what was measured (2026-09-15, Chromium 151 through the dev server) ────
 *
 * `DE| SKY BUNDESLIGA 1 HD` (stream 411425), the channel #178 found with ffprobe,
 * opened on the low-latency transport with mpegts.js 1.8.2:
 *
 *   PMT          pid 256 stream_type 0x1B (H.264), pid 257 stream_type 0x81
 *                (AC-3) — the panel's own ffmpeg mux, so AC-3 is announced the
 *                ATSC way and mpegts.js recognises it. `PES_PRIVATE_DATA_
 *                DESCRIPTOR` never fired; it only exists for stream_type 0x06.
 *   1,476 ms     addSourceBuffer('video/mp4;codecs=avc1.4d401f') — accepted
 *   1,482 ms     addSourceBuffer('audio/mp4;codecs=ac-3') — NotSupportedError
 *   1,483 ms     Events.ERROR('MediaError', 'MediaMSEError', {code: 9, msg:
 *                "Failed to execute 'addSourceBuffer' on 'MediaSource': The
 *                type provided ('audio/mp4;codecs=ac-3') is unsupported."})
 *   1,484 ms     MEDIA_INFO {hasAudio: true, audioCodec: 'ac-3', 48000 Hz,
 *                6 channels, hasVideo: true, videoCodec: 'avc1.4d401f', 1280x720}
 *   15 s later   totalVideoFrames 20 → 370, webkitVideoDecodedByteCount
 *                0.30 → 4.89 MB, webkitAudioDecodedByteCount 0 throughout,
 *                readyState 4, the playhead moving: a picture with no sound.
 *
 * A second run gave the same order a millisecond apart (1,620 / 1,621 ms). The
 * comparison channel, `BE| NPO 1 ᴿᴬᵂ` (H.264 + ADTS AAC, stream_type 0x0F): both
 * SourceBuffers accepted (686 / 696 ms), MEDIA_INFO `mp4a.40.2` 2ch, NO error,
 * and the audio counter at 8,048 bytes after 0.35s of media, 188,013 after 15s.
 *
 * ── the rule, and the signals it does not use ────────────────────────────────
 *
 * Declared versus accepted. The stream DECLARES an audio track and a video
 * track (MEDIA_INFO); the engine REFUSED a SourceBuffer for the audio one and
 * not for the video one (the MSE error names the type it refused). Both halves
 * are statements, not inferences, and neither exists for a channel that simply
 * has no audio: no audio track means no audio SourceBuffer is ever asked for,
 * so nothing is refused — and AAC or MP3, which this engine plays, is never
 * refused either. There is nothing here for silence to trigger.
 *
 * Rejected, each for a measured reason:
 *
 * - `webkitAudioDecodedByteCount === 0`. That IS silence as a signal: it is
 *   also 0 for a channel with no audio track, and for the first moments of every
 *   channel. It counts what reached the decoder, not what came out — muting the
 *   AAC channel at 10s did not slow it (116,164 → 188,013 bytes). So it is used
 *   in one direction only: audio bytes arriving VETO the verdict.
 * - PMT stream types. Reachable only through mpegts.js's process-wide verbose
 *   logger ("Parsed first PMT: {…}"), i.e. by switching on every log line the
 *   demuxer has and parsing prose. MEDIA_INFO carries the same fact as data.
 * - hls.js. On the compatible transport the same channel's manifest declares no
 *   CODECS at all; hls.js asked `isTypeSupported('audio/mp4; codecs="ac-3"')`,
 *   got false, built a video-only buffer and raised NO error of any kind — 20s
 *   of frames, zero audio bytes, phase `playing`. There is nothing to detect,
 *   which is why the answer on the web must never be "drop to HLS": that is the
 *   step that turned a loud refusal into the silent one #178 recorded.
 */
import { NATIVE_DECODES, matchCodec, type CodecSpec } from './codecs.ts';
import { BRAND } from '../brand.ts';

/** What the demuxer said the stream carries — mpegts.js's MEDIA_INFO. */
export interface DeclaredMedia {
  hasAudio: boolean | null;
  audioCodec: string | null;
  hasVideo: boolean | null;
  videoCodec: string | null;
}

export interface SoundCheck {
  /** MEDIA_INFO, or null while it has not arrived. */
  declared: DeclaredMedia | null;
  /** SourceBuffer types this engine refused, oldest first — see `refusedSourceBufferType`. */
  refused: readonly string[];
  /** Frames the element has decoded (`totalVideoFrames`). */
  videoFrames: number;
  /** `webkitAudioDecodedByteCount`, or null where the counter does not exist. */
  audioBytes: number | null;
  /** Milliseconds since the first audio refusal. */
  sinceRefusalMs: number;
}

export type SoundVerdict =
  /** Nothing about the sound to act on. */
  | { kind: 'fine' }
  /** Audio refused, the declaration not in yet — ask again. */
  | { kind: 'wait' }
  /** The picture plays and the sound cannot: escalate, or keep the picture and say so. */
  | { kind: 'soundless'; codec: string; spec: CodecSpec | null }
  /** Refused, and there is no picture to keep either — the ordinary refusal. */
  | { kind: 'unplayable' };

/**
 * How long a refusal waits for MEDIA_INFO before deciding without it.
 *
 * Measured at ONE millisecond, twice. MEDIA_INFO can only be later than that
 * when the MediaSource opened after the first init segments arrived, and then it
 * is earlier rather than later — so this is a backstop for a demuxer that never
 * declares anything (an audio-only stream, whose MEDIA_INFO mpegts.js 1.8.2 does
 * not fire at all), and a stream in that state is not playing anyway.
 */
export const DECLARE_GRACE_MS = 2_000;

/**
 * The SourceBuffer type an MSE refusal names, or null.
 *
 * mpegts.js forwards `addSourceBuffer`'s exception as `info.msg`, and Blink's
 * sentence quotes the type — "The type provided ('audio/mp4;codecs=ac-3') is
 * unsupported." — in every Chromium this app ships in. Only that sentence is
 * read: a full MediaSource, a removed buffer or an append failure is a different
 * exception with no type in it, and a browser whose wording does not quote the
 * type falls through to the ordinary refusal exactly as it did before.
 */
export function refusedSourceBufferType(msg: string): string | null {
  const m = /type provided \('([^']+)'\) is unsupported/i.exec(msg);
  const type = m?.[1]?.trim() ?? '';
  return /^(audio|video)\//i.test(type) ? type : null;
}

const isAudio = (type: string) => /^audio\//i.test(type.trim());
const isVideo = (type: string) => /^video\//i.test(type.trim());

/** `audio/mp4;codecs=ac-3` → `ac-3`; `audio/mpeg` → `mpeg`. */
function codecOfType(type: string): string {
  const named = /codecs\s*=\s*"?([^";,]+)/i.exec(type)?.[1];
  return (named ?? type.split('/')[1] ?? type).trim();
}

export function judgeSound(c: SoundCheck): SoundVerdict {
  const audio = c.refused.find(isAudio);
  if (audio === undefined) return { kind: 'fine' };
  /* Both halves refused is not a sound problem. The video refusal arrives first
     and has its own branch; this only makes sure the answer agrees with it. */
  if (c.refused.some(isVideo)) return { kind: 'unplayable' };
  /* The veto. Audio arriving at the decoder means something is playing it,
     whatever was refused on the way. */
  if ((c.audioBytes ?? 0) > 0) return { kind: 'fine' };

  const d = c.declared;
  if (d === null) {
    if (c.sinceRefusalMs < DECLARE_GRACE_MS) return { kind: 'wait' };
    /* Never declared: decide on what the element proves. Frames mean there is a
       picture to keep; no frames mean nothing plays at all. */
    if (c.videoFrames <= 0) return { kind: 'unplayable' };
    const codec = codecOfType(audio);
    return { kind: 'soundless', codec, spec: matchCodec(codec) };
  }
  /* A stream that says it has no sound is not missing any. */
  if (d.hasAudio !== true) return { kind: 'fine' };
  /* Audio refused and no picture declared: nothing left to play. */
  if (d.hasVideo !== true) return { kind: 'unplayable' };
  const codec = (d.audioCodec ?? '').trim() || codecOfType(audio);
  return { kind: 'soundless', codec, spec: matchCodec(codec) ?? matchCodec(codecOfType(audio)) };
}

/**
 * The sentence over the picture.
 *
 * `web` is a browser, where the honest pointer is the TV app — but only for a
 * codec the app's own engine carries: AC-4 is in neither (`NATIVE_LACKS`), and
 * sending someone to install an app that plays it silently too would be worse
 * than saying nothing. `app` is the wrapper whose native engine was unavailable
 * or already spent on this channel, where "get the app" would be absurd.
 */
export function noSoundMessage(
  codec: string, spec: CodecSpec | null, where: 'web' | 'app',
): string {
  const name = spec?.label ?? codec.toUpperCase();
  if (where === 'app') {
    return `No sound: this channel's audio is ${name}, which couldn't be played on this device.`;
  }
  const appPlays = spec !== null && NATIVE_DECODES.has(spec.id);
  return `No sound: this channel's audio is ${name}, which this browser can't play.`
    + (appPlays ? ` The ${BRAND.name} TV app plays it.` : '');
}
