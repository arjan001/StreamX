import { BRAND } from '../brand.ts';
/**
 * What this device can actually decode, and what to say when it cannot.
 *
 * The problem this solves: every playback failure looked the same. "The browser
 * cannot demux or decode this stream" is true and useless — it does not say which
 * codec, whether the device could ever play it, or whether switching transport
 * would help. On a TV box or an older phone the answer is usually one specific
 * missing decoder, and that is a fact worth stating.
 *
 * Three sources of truth, deliberately, because they disagree:
 *
 * - `MediaSource.isTypeSupported()` is the oldest and the least honest. It
 *   answers from a static list, and on TVs it is known to claim codecs the
 *   hardware does not have.
 * - `navigator.mediaCapabilities.decodingInfo()` consults the real decoder set
 *   and also reports whether playback would be smooth and power-efficient.
 * - WebCodecs `VideoDecoder/AudioDecoder.isConfigSupported()` asks the platform
 *   decoder directly and is the closest thing to a decode attempt available
 *   without a sample file to feed it.
 *
 * Where they agree, the answer is solid. Where they disagree, that disagreement
 * IS the finding, and it is shown rather than hidden — a codec that MediaSource
 * claims and WebCodecs denies is exactly the case that produces a black screen
 * with no error.
 */

export type Verdict = 'yes' | 'no' | 'likely' | 'unlikely' | 'unknown';

export interface CodecSpec {
  id: string;
  label: string;
  kind: 'video' | 'audio';
  /** Full MSE mime, including the container the app would actually use. */
  mime: string;
  /** WebCodecs config codec string, when the two spellings differ. */
  webCodec?: string;
  /**
   * A second container spelling to try when the first is refused.
   *
   * Some codecs are supported by a browser only outside MP4 — MP3 is the case
   * here: `audio/mpeg` is universal while `audio/mp4; codecs="mp4a.6B"` is not.
   * Reporting "no" from the stricter spelling alone is how MP3 came to be listed
   * as doubtful on devices that have played it for twenty years.
   */
  altMime?: string;
  /** Why this one is on the list at all. */
  note: string;
}

/**
 * The codecs this catalogue actually contains, in the order they matter.
 *
 * Not a survey of the format landscape: H.264/AAC is the overwhelming majority
 * of the provider's streams, HEVC appears on its 4K feeds, and AC-3/E-AC-3/MP2
 * are the audio codecs that European broadcast channels carry and that browsers
 * most often lack — which makes them the reason a channel plays with no sound.
 */
export const CODECS: CodecSpec[] = [
  { id: 'h264', label: 'H.264', kind: 'video', mime: 'video/mp4; codecs="avc1.640028"',
    webCodec: 'avc1.640028', note: 'Almost every channel and film here.' },
  { id: 'hevc', label: 'HEVC / H.265', kind: 'video', mime: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
    webCodec: 'hvc1.1.6.L93.B0', note: 'The 4K feeds. Usually present on Android, rarely on desktop Chrome.' },
  { id: 'av1', label: 'AV1', kind: 'video', mime: 'video/mp4; codecs="av01.0.04M.08"',
    webCodec: 'av01.0.04M.08', note: 'Not used by this provider yet.' },
  { id: 'vp9', label: 'VP9', kind: 'video', mime: 'video/mp4; codecs="vp09.00.10.08"',
    webCodec: 'vp09.00.10.08', note: 'Not used by this provider.' },
  { id: 'aac', label: 'AAC', kind: 'audio', mime: 'audio/mp4; codecs="mp4a.40.2"',
    webCodec: 'mp4a.40.2', note: 'The default audio track almost everywhere.' },
  { id: 'ac3', label: 'AC-3 (Dolby Digital)', kind: 'audio', mime: 'audio/mp4; codecs="ac-3"',
    webCodec: 'ac-3', note: 'European broadcast channels. Missing here means a channel plays silently.' },
  { id: 'eac3', label: 'E-AC-3 (Dolby Digital+)', kind: 'audio', mime: 'audio/mp4; codecs="ec-3"',
    webCodec: 'ec-3', note: 'Same, and less widely supported than AC-3.' },
  /*
   * MP2 and MP3 both used `mp4a.69` here, which is why they could never disagree
   * and why both came back "disputed": one MSE string was being asked two
   * questions. `mp4a.69` is MPEG-2 Part 3 audio — the family, not the layer — so
   * it is the honest string for Layer II and cannot distinguish Layer III.
   * MP3 has its own registration (`mp4a.6B`, MPEG-1 Layer 3) and is also the one
   * codec here that every browser plays as a bare `audio/mpeg`, which is what
   * `altMime` is for: a second spelling, asked when the first says no.
   */
  { id: 'mp2', label: 'MP2 audio', kind: 'audio', mime: 'audio/mp4; codecs="mp4a.69"',
    webCodec: 'mp4a.69', note: 'Older DVB channels. Effectively never in a browser.' },
  { id: 'mp3', label: 'MP3', kind: 'audio', mime: 'audio/mp4; codecs="mp4a.6B"',
    altMime: 'audio/mpeg', webCodec: 'mp3', note: 'Some radio streams.' },
  { id: 'opus', label: 'Opus', kind: 'audio', mime: 'audio/mp4; codecs="opus"',
    webCodec: 'opus', note: 'Not used by this provider.' },

  /*
   * ── the ones this list did not know about, and why each one is here ────────
   *
   * The list above describes what a BROWSER might manage. That was the whole
   * question while the app was a website. It is the wrong question for an APK
   * carrying libVLC, because `chooseEngine` decides where a stream goes by
   * asking `matchCodec` about what the panel reported — and a codec that is not
   * in this array is not matched, not weighed, and therefore left in the WebView
   * to fail. Silence, not a wrong answer.
   *
   * DTS is the proof, and it is written down three files away: the note on
   * `chooseEngine` says 19.5% of 1,586 episodes carry "AC-3, E-AC-3 or DTS",
   * measured. Two of those three were in this list.
   */
  { id: 'mpeg2', label: 'MPEG-2 video', kind: 'video', mime: 'video/mp4; codecs="mp4v.61"',
    altMime: 'video/mpeg',
    note: 'Standard-definition broadcast feeds. NO browser has ever decoded it — '
      + 'and nearly every television box has it in silicon, which is the exact gap libVLC covers.' },
  { id: 'mpeg4p2', label: 'MPEG-4 Part 2 (DivX/Xvid)', kind: 'video',
    mime: 'video/mp4; codecs="mp4v.20.9"',
    note: 'Older films in AVI and MP4. A browser refuses it; a TV box decodes it.' },
  { id: 'dolbyvision', label: 'Dolby Vision', kind: 'video', mime: 'video/mp4; codecs="dvh1.05.06"',
    note: 'Some 4K feeds. Matched before the AC-3 pattern on purpose — "dolby" alone used to '
      + 'classify this VIDEO codec as Dolby Digital AUDIO.' },
  { id: 'dts', label: 'DTS', kind: 'audio', mime: 'audio/mp4; codecs="dtsc"',
    note: 'Film soundtracks. Measured at part of 19.5% of this catalogue and, until now, '
      + 'not matched at all.' },
  { id: 'truehd', label: 'Dolby TrueHD', kind: 'audio', mime: 'audio/mp4; codecs="mlpa"',
    note: 'Lossless film audio. The device MIME is `audio/vnd.dolby.mlp`, not the obvious one.' },
  { id: 'ac4', label: 'AC-4 (Dolby)', kind: 'audio', mime: 'audio/mp4; codecs="ac-4"',
    note: 'Newer broadcast audio. The one codec here that libVLC 3.x cannot decode either — '
      + 'it needs the VLC 4 line, which is still early-access.' },
  { id: 'flac', label: 'FLAC', kind: 'audio', mime: 'audio/mp4; codecs="fLaC"',
    altMime: 'audio/flac', webCodec: 'flac', note: 'Occasional in Matroska.' },
  { id: 'vorbis', label: 'Vorbis', kind: 'audio', mime: 'audio/webm; codecs="vorbis"',
    webCodec: 'vorbis', note: 'Occasional in Matroska.' },
];

/**
 * What the app's OWN decoder handles, independently of the browser.
 *
 * The Android build embeds libVLC (`org.videolan.android:libvlc-all`, the full
 * build), whose decoding engine is libavcodec — the same library FFmpeg is built
 * on, carrying software decoders for AC-3, E-AC-3, MPEG audio Layers I-III, DTS
 * and HEVC. So on that build these are decoded whatever `MediaCodecList` reports
 * and whatever the WebView admits to, and `chooseEngine` already routes them
 * there: a codec the WebView refuses is handed to the native surface.
 *
 * This is the fact the support panel was missing. It asked three BROWSER APIs and
 * published their answer as the device's — so an Android TV that plays Dolby
 * Digital perfectly well was told, on its own settings screen, that it could not.
 * The browser answers were not wrong; they were answering a different question
 * than the one being asked.
 *
 * Hardware acceleration is a separate axis and is reported separately: MediaCodec
 * having `audio/ac3` means the chip does it, not having it means libavcodec does
 * it on the CPU. For a stereo AC-3 track that difference is not perceptible; for
 * 4K HEVC it very much is, which is why the distinction is kept rather than
 * flattened.
 */
/*
 * ── and the one that is NOT here is the point of the list ──────────────────
 *
 * AC-4 is absent deliberately. libavcodec only gained an AC-4 decoder in FFmpeg
 * 7.1, and `libvlc-all` 3.6.x is built on the VLC 3 line, which predates it — so
 * AC-4 is the single codec in this file that neither the WebView nor the app's
 * own engine can decode. Saying so is the honest answer on a settings screen and
 * the correct one for `chooseEngine`, which would otherwise route an AC-4 track
 * to libVLC and get silence. It needs the VLC 4 line, which is still
 * early-access (`4.0.0-eap*` on Maven), and that is not a dependency to ship a
 * television on. Same for VVC/H.266 and MPEG-H, neither of which is in `CODECS`
 * because neither has appeared in this catalogue.
 */
/**
 * Codecs the app's own engine cannot decode either — stated, not left implied.
 *
 * A codec absent from `NATIVE_DECODES` reads as "no" on the settings screen and
 * routes to the WebView, and those are the right answers; what was missing was
 * any way to tell "we decided this is out of reach" from "somebody forgot to
 * decide". The test below requires every codec in `CODECS` to be in exactly one
 * of the two sets, so adding a codec without answering the question fails the
 * build rather than shipping a silent no.
 */
export const NATIVE_LACKS = new Set(['ac4']);

export const NATIVE_DECODES = new Set([
  'h264', 'hevc', 'av1', 'vp9', 'aac', 'ac3', 'eac3', 'mp2', 'mp3', 'opus',
  /* Added with the codecs themselves. Every one is a libavcodec software
     decoder that has been there for years — MPEG-2 and MPEG-4 Part 2 since
     before libavcodec was called that, DTS, TrueHD, FLAC and Vorbis likewise —
     so on the APK these play whatever the box has in silicon. Dolby Vision is
     here because its base layer is HEVC, which libavcodec decodes; the dynamic
     metadata is what a non-Dolby display drops, and that is a picture that looks
     flat rather than a stream that fails. */
  'mpeg2', 'mpeg4p2', 'dolbyvision', 'dts', 'truehd', 'flac', 'vorbis',
]);

/** How a codec is decoded once the native engine is in play. */
export type NativeSupport = 'hardware' | 'software' | 'no';

export interface CodecResult {
  id: string;
  label: string;
  kind: 'video' | 'audio';
  note: string;
  /** `MediaSource.isTypeSupported`. */
  mse: boolean | null;
  /** `decodingInfo().supported`, plus whether it would be smooth. */
  mediaCaps: { supported: boolean; smooth: boolean; efficient: boolean } | null;
  /** WebCodecs `isConfigSupported`. */
  webCodecs: boolean | null;
  /**
   * The app's own decoder. `null` on the web, where there is not one.
   *
   * `hardware` means the platform lists a decoder for it, `software` means
   * libavcodec will do it on the CPU — both of which mean it plays.
   */
  native: NativeSupport | null;
  /** What the BROWSER alone would manage. Kept so the panel can still show it. */
  browserVerdict: Verdict;
  verdict: Verdict;
  /** True when the three sources do not agree — the interesting case. */
  disputed: boolean;
}

export interface CapabilityReport {
  /** Epoch ms, so a stale report can be refreshed rather than trusted forever. */
  at: number;
  /** Whether the app is carrying its own decoder on this device. */
  native: { available: boolean };
  /** Which APIs were available to ask. */
  sources: { mse: boolean; mediaCaps: boolean; webCodecs: boolean };
  /** Media Source Extensions at all — without it neither transport works. */
  mse: boolean;
  /** Native HLS, which is how Safari and some TVs play m3u8 without hls.js. */
  nativeHls: boolean;
  /** MPEG-TS accepted directly by MSE. Almost never true; mpegts.js remuxes. */
  tsInMse: boolean;
  codecs: CodecResult[];
}

/**
 * Fold three answers into one.
 *
 * WebCodecs is trusted over MediaSource because it asks the platform decoder,
 * and a `false` from it against a `true` from MediaSource is the black-screen
 * case. Nothing is ever reported as a flat `yes` on one source alone: `likely`
 * and `unlikely` exist precisely so the UI can say "probably" and be right.
 */
export function verdictOf(
  r: Pick<CodecResult, 'mse' | 'mediaCaps' | 'webCodecs'>,
  native: NativeSupport | null = null,
): Verdict {
  /*
   * A decoder the app is carrying settles the question.
   *
   * This is not optimism: `chooseEngine` in `nativePlayer.ts` sends exactly these
   * streams to the native surface, and `PlayerCore.escalate()` sends anything
   * that fails to decode there as well. Reporting the WebView's "no" for a codec
   * the app then plays without difficulty is a report about a component rather
   * than about the product.
   */
  if (native === 'hardware' || native === 'software') return 'yes';
  if (native === 'no') return 'no';
  return browserVerdictOf(r);
}

/** What the browser alone would manage — the original three-source fold. */
export function browserVerdictOf(r: Pick<CodecResult, 'mse' | 'mediaCaps' | 'webCodecs'>): Verdict {
  const votes = [
    r.mse,
    r.mediaCaps === null ? null : r.mediaCaps.supported,
    r.webCodecs,
  ].filter((v): v is boolean => v !== null);
  if (votes.length === 0) return 'unknown';
  const yes = votes.filter(Boolean).length;
  if (yes === votes.length) return votes.length >= 2 ? 'yes' : 'likely';
  if (yes === 0) return votes.length >= 2 ? 'no' : 'unlikely';
  // Split decision: the platform decoder wins, because it is the one that has to
  // do the work.
  if (r.webCodecs === false) return 'unlikely';
  if (r.webCodecs === true) return 'likely';
  return r.mediaCaps?.supported ? 'likely' : 'unlikely';
}

export function isDisputed(r: Pick<CodecResult, 'mse' | 'mediaCaps' | 'webCodecs'>): boolean {
  const votes = [
    r.mse,
    r.mediaCaps === null ? null : r.mediaCaps.supported,
    r.webCodecs,
  ].filter((v): v is boolean => v !== null);
  return votes.length > 1 && new Set(votes).size > 1;
}

/* ── the probe ────────────────────────────────────────────────────────────── */

interface Win {
  MediaSource?: { isTypeSupported(t: string): boolean };
  VideoDecoder?: { isConfigSupported(c: { codec: string }): Promise<{ supported?: boolean }> };
  AudioDecoder?: { isConfigSupported(c: { codec: string; sampleRate: number; numberOfChannels: number }): Promise<{ supported?: boolean }> };
  navigator?: {
    mediaCapabilities?: {
      decodingInfo(c: unknown): Promise<{ supported: boolean; smooth: boolean; powerEfficient: boolean }>;
    };
  };
  document?: { createElement(tag: string): { canPlayType(t: string): string } };
}

/**
 * What the caller knows about the app's own decoder.
 *
 * Passed in rather than imported so this module stays pure and testable: it has
 * no business knowing about Capacitor plugins, and the tests have no way to
 * provide one.
 */
export interface NativeAnswer {
  /** Is a native engine present at all? False on the web build. */
  available: boolean;
  /** Codec ids the PLATFORM lists a decoder for — i.e. hardware accelerated. */
  hardware: Set<string>;
}

export async function probeCapabilities(
  win: Win = globalThis as unknown as Win,
  native: NativeAnswer | null = null,
): Promise<CapabilityReport> {
  const MS = win.MediaSource;
  const mc = win.navigator?.mediaCapabilities;
  const hasWebCodecs = typeof win.VideoDecoder?.isConfigSupported === 'function';

  const video = win.document?.createElement('video');
  const nativeHls = video
    ? video.canPlayType('application/vnd.apple.mpegurl') !== ''
    : false;

  const codecs: CodecResult[] = [];
  for (const spec of CODECS) {
    /* The stricter container spelling first, then the permissive one. A codec is
       only refused when BOTH are — see `altMime`. */
    const mse = MS
      ? MS.isTypeSupported(spec.mime)
        || (spec.altMime !== undefined && MS.isTypeSupported(spec.altMime))
      : null;

    let mediaCaps: CodecResult['mediaCaps'] = null;
    if (mc) {
      try {
        const info = await mc.decodingInfo(
          spec.kind === 'video'
            ? {
                type: 'media-source',
                video: { contentType: spec.mime, width: 1920, height: 1080, bitrate: 6_000_000, framerate: 25 },
              }
            : {
                type: 'media-source',
                audio: { contentType: spec.mime, channels: '2', bitrate: 192_000, samplerate: 48_000 },
              },
        );
        mediaCaps = { supported: info.supported, smooth: info.smooth, efficient: info.powerEfficient };
      } catch {
        /* An unparseable content type throws rather than answering false. */
      }
    }

    let webCodecs: boolean | null = null;
    if (hasWebCodecs && spec.webCodec) {
      try {
        const res = spec.kind === 'video'
          ? await win.VideoDecoder!.isConfigSupported({ codec: spec.webCodec })
          : await win.AudioDecoder!.isConfigSupported({
              codec: spec.webCodec, sampleRate: 48_000, numberOfChannels: 2,
            });
        webCodecs = res.supported === true;
      } catch {
        // A codec string the platform cannot even parse is a "no", not an unknown.
        webCodecs = false;
      }
    }

    /* An element's own opinion, for the codecs a browser plays outside MSE. MP3
       through `<audio>` is the case that matters: universally supported, and
       invisible to every MSE-shaped question. */
    if (mse !== true && spec.altMime !== undefined && video) {
      const can = video.canPlayType(spec.altMime);
      if (can === 'probably' || can === 'maybe') mediaCaps = mediaCaps ?? {
        supported: true, smooth: true, efficient: true,
      };
    }

    const partial = { mse, mediaCaps, webCodecs };
    /*
     * `available` without a hardware entry is `software`, not `no`: libVLC falls
     * back to libavcodec, which is the entire reason it is shipped. `no` is
     * reserved for a codec that engine genuinely does not carry.
     */
    const nativeSupport: NativeSupport | null = native === null || !native.available
      ? null
      : native.hardware.has(spec.id)
        ? 'hardware'
        : NATIVE_DECODES.has(spec.id)
          ? 'software'
          : 'no';

    codecs.push({
      id: spec.id, label: spec.label, kind: spec.kind, note: spec.note,
      ...partial,
      native: nativeSupport,
      browserVerdict: browserVerdictOf(partial),
      verdict: verdictOf(partial, nativeSupport),
      /* A dispute among the browser APIs stops being interesting once the app is
         carrying its own decoder — it no longer predicts anything the viewer will
         experience. */
      disputed: nativeSupport === null && isDisputed(partial),
    });
  }

  return {
    at: Date.now(),
    native: { available: native?.available ?? false },
    sources: { mse: Boolean(MS), mediaCaps: Boolean(mc), webCodecs: hasWebCodecs },
    mse: Boolean(MS),
    nativeHls,
    tsInMse: MS ? MS.isTypeSupported('video/mp2t; codecs="avc1.42E01E,mp4a.40.2"') : false,
    codecs,
  };
}

/* ── the negative codes ───────────────────────────────────────────────────── */

/**
 * A stable code for every way playback can fail.
 *
 * The point is that a code is searchable and a sentence is not: "STX-322" in a
 * message is something a user can quote and something support can look up, where
 * "the browser cannot decode this stream" is where the conversation stops. The
 * numbers are grouped by cause, and nothing is ever reused.
 */
export const CODES = {
  UNREACHABLE: { code: `${BRAND.code}-101`, title: 'The stream did not answer' },
  PANEL_BUSY: { code: `${BRAND.code}-102`, title: 'The line is already in use' },
  TS_ENDED: { code: `${BRAND.code}-103`, title: 'The stream ended unexpectedly' },
  /*
   * The request never left the browser, so there is no server answer to read.
   *
   * Distinct from -101 on purpose, and the distinction is the whole point of
   * adding it: -101 says the stream did not answer, which sends someone off to
   * check whether the channel is up. This one says the browser refused to hand
   * the answer over — the stream may be perfectly healthy and playing for
   * everybody watching it through something that is not a web page.
   */
  BLOCKED: { code: `${BRAND.code}-104`, title: 'The browser blocked this stream' },
  NO_MSE: { code: `${BRAND.code}-201`, title: 'This browser has no Media Source support' },
  NO_DEMUX: { code: `${BRAND.code}-202`, title: 'This container cannot be demuxed here' },
  NO_VIDEO_DECODER: { code: `${BRAND.code}-301`, title: 'No video decoder for this stream' },
  NO_AUDIO_DECODER: { code: `${BRAND.code}-302`, title: 'No audio decoder for this stream' },
  DISPUTED_DECODER: { code: `${BRAND.code}-303`, title: 'This device reports a decoder it may not have' },
  /*
   * The device says it has no network. Above every other verdict below it for
   * the same reason `BLOCKED` is: nothing reached a decoder, so nothing about
   * decoders is worth saying.
   */
  OFFLINE: { code: `${BRAND.code}-105`, title: 'This device is not online' },
  /** Bytes arrived, a picture was on screen, and then it stopped after a jump. */
  AFTER_JUMP: { code: `${BRAND.code}-106`, title: 'The film stopped after a jump' },
  /** It had been playing, and the stream ended without an engine complaint. */
  STOPPED: { code: `${BRAND.code}-107`, title: 'The stream stopped partway' },
  /** Nothing at all arrived, on every door tried. */
  NO_BYTES: { code: `${BRAND.code}-108`, title: 'Nothing arrived from the server' },
  UNKNOWN: { code: `${BRAND.code}-999`, title: 'Playback failed' },
} as const;

export interface Diagnosis {
  code: string;
  title: string;
  /** What to do about it, in one sentence, or null when there is nothing to do. */
  action: string | null;
  /** The codec blamed, when one could be identified. */
  codec: string | null;
}

/** Which of the probed codecs a stream's reported codec string refers to. */
export function matchCodec(reported: string | null): CodecSpec | null {
  if (!reported) return null;
  const s = reported.toLowerCase();
  if (/hevc|h\.?265|hvc1|hev1/.test(s)) return CODECS.find((c) => c.id === 'hevc') ?? null;
  if (/av01|av1/.test(s)) return CODECS.find((c) => c.id === 'av1') ?? null;
  if (/vp0?9/.test(s)) return CODECS.find((c) => c.id === 'vp9') ?? null;
  if (/avc1|h\.?264/.test(s)) return CODECS.find((c) => c.id === 'h264') ?? null;
  /*
   * Dolby Vision before ANY audio pattern, because the AC-3 line below matches a
   * bare `dolby` — so a Dolby Vision stream used to be read as Dolby Digital and
   * weighed as audio. Video is also tested before MPEG-2 AUDIO for the mirror of
   * the same reason: `mp2v` and `mpeg2video` are video, and the audio pattern
   * contains a bare `mp2` that would swallow the first of them.
   */
  if (/dolby-?vision|dvh[e1]|dvav/.test(s)) return CODECS.find((c) => c.id === 'dolbyvision') ?? null;
  if (/mpeg-?2\s*video|mp2v|mpgv|h\.?262/.test(s)) return CODECS.find((c) => c.id === 'mpeg2') ?? null;
  if (/divx|xvid|mp4v|mpeg-?4\s*(part\s*2|visual)/.test(s)) return CODECS.find((c) => c.id === 'mpeg4p2') ?? null;
  // Audio: check E-AC-3 first — "ac-3" is a substring of "e-ac-3".
  // `e-ac-3` is the spelling panels actually use, and it contains `ac-3` — so the
  // leading `e` has to be part of the pattern, not assumed away.
  if (/ec-?3|e-?ac-?3|dd\+|digital\s*plus/.test(s)) return CODECS.find((c) => c.id === 'eac3') ?? null;
  /* Both before AC-3, and both for the same reason as Dolby Vision above: each
     one's usual spelling contains the word this catalogue's panels use for AC-3. */
  if (/true-?hd|mlp/.test(s)) return CODECS.find((c) => c.id === 'truehd') ?? null;
  if (/ac-?4/.test(s)) return CODECS.find((c) => c.id === 'ac4') ?? null;
  if (/ac-?3|dolby/.test(s)) return CODECS.find((c) => c.id === 'ac3') ?? null;
  if (/dts|dca/.test(s)) return CODECS.find((c) => c.id === 'dts') ?? null;
  if (/mp4a\.69|mp4a\.6b|mp2|mpeg-?1.*layer|layer\s*ii/.test(s)) return CODECS.find((c) => c.id === 'mp2') ?? null;
  if (/mp3|layer\s*iii/.test(s)) return CODECS.find((c) => c.id === 'mp3') ?? null;
  if (/opus/.test(s)) return CODECS.find((c) => c.id === 'opus') ?? null;
  if (/flac/.test(s)) return CODECS.find((c) => c.id === 'flac') ?? null;
  if (/vorbis/.test(s)) return CODECS.find((c) => c.id === 'vorbis') ?? null;
  if (/aac|mp4a/.test(s)) return CODECS.find((c) => c.id === 'aac') ?? null;
  return null;
}

/**
 * Turn a failure into something specific.
 *
 * Reads the engine's message, the codec the engine managed to report before it
 * gave up, and the capability report — in that order of specificity. A named
 * missing decoder is the most useful thing this can say, so it is tried first,
 * and the generic codes are the fallback rather than the default.
 */
export function diagnose(
  message: string,
  opts: {
    codec?: string | null;
    report?: CapabilityReport | null;
    transport?: 'mpegts' | 'hls' | 'native' | null;
    /** Set by the player when the browser refused the request outright. */
    blocked?: { host: string } | null;
    /**
     * What was true when it gave up — see `FailureFacts` in `playerCore`.
     *
     * Typed structurally rather than imported so this module stays free of the
     * player: `codecs.ts` is loaded by the settings screen and by the pre-play
     * warning, neither of which should pull in an engine.
     */
    facts?: {
      /* The TRANSPORT — `hls`, `mpegts`, `file`. Never a filename extension;
         printing it as one is what produced "a .file file" on a film. */
      container: string | null;
      /* The real extension from the address, or null. Use this when speaking
         to a viewer about what the file is. */
      ext?: string | null;
      /* A live channel rather than a film. Most advice differs between them,
         and "switch this channel to the Low latency transport" shown over a
         film is advice a viewer cannot act on. */
      live?: boolean;
      bytes: boolean;
      played: boolean;
      afterSeek: boolean;
      nativeEngine: boolean;
      online: boolean;
      doorsTried: number;
      doorsRefused: number;
    } | null;
  } = {},
): Diagnosis {
  const m = message.toLowerCase();
  const spec = matchCodec(opts.codec ?? null);
  const found = spec ? opts.report?.codecs.find((c) => c.id === spec.id) ?? null : null;

  /*
   * First, because nothing below it can be true.
   *
   * A request the browser refused never reached a decoder, so every codec
   * verdict underneath is about a stream this device has not seen a single byte
   * of. Reporting one would be a confident answer to a question that was never
   * asked — and the answer people acted on was worse than that: this used to
   * fall through to "the stream dropped repeatedly... the channel is probably
   * offline, or the single allowed connection is still held", which sends
   * someone to wait a minute and try again for a condition that will still be
   * there tomorrow.
   */
  if (opts.blocked) {
    return {
      code: CODES.BLOCKED.code,
      title: CODES.BLOCKED.title,
      action: `${opts.blocked.host} does not allow a web page to read its stream, `
        + 'so the browser stopped the request before the player saw it. Nothing on '
        + 'this device can change that: the permission has to come from that server. '
        + 'The Android app fetches its own media and is not bound by this rule.',
      codec: null,
    };
  }

  /*
   * Then: was there a network at all?
   *
   * `navigator.onLine` false is the one thing a device states about itself with
   * certainty, and it explains every symptom underneath — no bytes, no decode,
   * every door failing at once. Saying "the channel may be offline" to somebody
   * whose wifi dropped sends them to the wrong place entirely.
   */
  if (opts.facts?.online === false) {
    return {
      code: CODES.OFFLINE.code,
      title: CODES.OFFLINE.title,
      action: 'This device has lost its internet connection. Nothing can play until it is back \u2014 '
        + 'check the wifi or the network cable, then press RETRY.',
      codec: null,
    };
  }

  if (found && (found.verdict === 'no' || found.verdict === 'unlikely')) {
    const c = spec!.kind === 'video' ? CODES.NO_VIDEO_DECODER : CODES.NO_AUDIO_DECODER;
    return {
      code: c.code,
      title: `${c.title}: ${spec!.label}`,
      action: spec!.kind === 'audio'
        ? 'Try another audio track, or the Compatible transport — some panels offer an AAC feed of the same channel.'
        : 'Try the Compatible transport, or a lower-quality feed of the same channel.',
      codec: spec!.label,
    };
  }
  if (found?.disputed) {
    return {
      code: CODES.DISPUTED_DECODER.code,
      title: `${CODES.DISPUTED_DECODER.title}: ${spec!.label}`,
      action: 'The platform decoder disagrees with the browser. Switching transport sometimes works around it.',
      codec: spec!.label,
    };
  }
  if (opts.report && !opts.report.mse) {
    /*
     * "Neither transport can work without it" was not true on the one browser
     * that reaches this most.
     *
     * Safari on an iPhone has no Media Source and never will — and it plays HLS
     * itself, in the element, which is how every iPhone on earth watches live
     * video. The panel serves these channels as HLS (measured:
     * `application/x-mpegurl`, a real `#EXTM3U` playlist), `playerCore` has had
     * a native-HLS fallback for as long as it has had hls.js, and
     * `pickTransport` now asks for that form when there is no MSE. So on a
     * browser with native HLS this sentence sent somebody away from a stream
     * that works.
     *
     * Kept for the browser where it IS true — no MSE and no native HLS is
     * genuinely a dead end — and only there.
     */
    if (opts.report.nativeHls) {
      return {
        code: CODES.NO_MSE.code,
        title: CODES.NO_MSE.title,
        action: 'This browser plays HLS itself, so live channels work on the Compatible '
          + 'transport \u2014 which it now asks for. Films need the app: a browser without '
          + 'Media Source cannot play the containers this provider serves them in.',
        codec: null,
      };
    }
    return { code: CODES.NO_MSE.code, title: CODES.NO_MSE.title, action: 'Neither transport can work without it. Use the app build instead of this browser.', codec: null };
  }
  if (/codec|mime|mediasource|demux/.test(m)) {
    /*
     * Transport advice is LIVE advice, and it was being given over films.
     *
     * Photographed on `/movie/…`: "This container cannot be demuxed here —
     * switch this channel to the Low latency (raw TS) transport." A film has no
     * transport setting, there is no channel, and the viewer is left looking
     * for a control that does not exist. A film that cannot be demuxed here is
     * a container this browser will not open, which is a different sentence
     * with a different answer.
     */
    const live = opts.facts?.live !== false && opts.transport !== null
      && (opts.transport === 'mpegts' || opts.transport === 'hls');
    if (opts.facts?.live === false || (opts.facts !== undefined && opts.facts !== null && !opts.facts.live)) {
      return {
        code: CODES.NO_DEMUX.code,
        title: CODES.NO_DEMUX.title,
        action: 'This browser will not open the container this film is in. The app on a TV '
          + 'box opens it with its own player — the same film usually works there.',
        codec: spec?.label ?? null,
      };
    }
    return {
      code: CODES.NO_DEMUX.code,
      title: CODES.NO_DEMUX.title,
      action: live && opts.transport === 'mpegts'
        ? 'Switch this channel to the Compatible (HLS) transport.'
        : 'Switch this channel to the Low latency (raw TS) transport.',
      codec: spec?.label ?? null,
    };
  }
  if (/earlyeof|stream stopped|networkerror|exception/.test(m)) {
    return { code: CODES.TS_ENDED.code, title: CODES.TS_ENDED.title, action: 'Usually the panel cutting a long connection. Retrying reconnects.', codec: null };
  }
  if (/busy|max.*connection|limit/.test(m)) {
    return { code: CODES.PANEL_BUSY.code, title: CODES.PANEL_BUSY.title, action: 'This account allows one stream at a time, and panels keep counting a session for 30-120 seconds after it ends.', codec: null };
  }
  if (/404|403|not found|forbidden|unreachable|timeout|refused/.test(m)) {
    return { code: CODES.UNREACHABLE.code, title: CODES.UNREACHABLE.title, action: 'The channel may be offline, or the panel may have moved it.', codec: null };
  }
  /*
   * Nothing above recognised it \u2014 so say what was true instead of what it was.
   *
   * This is the branch the photograph came from: "Playback failed", a RETRY
   * button, and not one word about why. Every case below is built from facts the
   * player already had and threw away, and each one sends somebody somewhere
   * different: a jump that broke it is worth pressing RETRY for, a stream that
   * never delivered a byte is not.
   */
  const f = opts.facts ?? null;
  if (f !== null) {
    if (f.afterSeek && f.played) {
      return {
        code: CODES.AFTER_JUMP.code,
        title: CODES.AFTER_JUMP.title,
        action: 'It was playing until the jump, so the film and the connection are both fine. '
          + 'Moving inside a film asks the server for a different part of the file, and this '
          + 'source allows one connection at a time \u2014 if the old one has not been let go '
          + 'yet, the new one is refused. RETRY starts it again from where you jumped to.',
        codec: null,
      };
    }
    if (f.doorsRefused > 0) {
      return {
        code: CODES.PANEL_BUSY.code,
        title: CODES.PANEL_BUSY.title,
        action: `${f.doorsRefused === 1 ? 'A server' : `${f.doorsRefused} servers`} refused the account `
          + 'rather than the stream. This source allows one at a time, and a panel goes on '
          + 'counting a session for up to two minutes after it ends \u2014 so another device watching, '
          + 'or your own last channel, can hold the slot. Wait a minute, then RETRY.',
        codec: null,
      };
    }
    if (!f.bytes) {
      return {
        code: CODES.NO_BYTES.code,
        title: CODES.NO_BYTES.title,
        action: f.doorsTried > 0
          ? `Not one byte arrived, on ${f.doorsTried} server${f.doorsTried === 1 ? '' : 's'} tried. `
            + `That is the server or the connection, not this ${f.live ? 'channel' : 'film'}: another `
            + `${f.live ? 'channel' : 'title'} from the same section will fail the same way if it is the connection, `
            + 'and play if it is this one.'
          : `Not one byte of this stream arrived. That is the server or the connection rather than `
            + `this ${f.live ? 'channel' : 'film'} \u2014 try another ${f.live ? 'channel' : 'title'} to tell which.`,
        codec: null,
      };
    }
    if (f.played) {
      return {
        code: CODES.STOPPED.code,
        title: CODES.STOPPED.title,
        action: 'It was playing and the stream ended without saying why, which is usually the panel '
          + 'cutting a long connection or the internet dropping for a moment. RETRY continues it.',
        codec: null,
      };
    }
    /* Bytes arrived and nothing ever painted: the data is there and this engine
       could not make a picture of it. On a device with libVLC that has already
       been tried (`escalate`), so the honest sentence names the container. */
    return {
      code: CODES.UNKNOWN.code,
      title: CODES.UNKNOWN.title,
      action: f.nativeEngine
        ? `${f.live ? 'The channel' : 'The film'} arrived but neither player on this box could show it`
          + `${f.ext ? ` (a .${f.ext} file)` : ''}. `
          + `That points at ${f.live ? 'the channel' : 'the film'} itself \u2014 another `
          + `${f.live ? 'channel' : 'title'} will show whether it is this one or the box.`
        : `${f.live ? 'The channel' : 'The film'} arrived but this screen could not show it`
          + `${f.ext ? ` (a .${f.ext} file)` : ''}. `
          + 'A TV box running the app plays formats a browser cannot \u2014 the same '
          + `${f.live ? 'channel' : 'film'} usually works there.`,
      codec: spec?.label ?? null,
    };
  }
  return { code: CODES.UNKNOWN.code, title: CODES.UNKNOWN.title, action: null, codec: spec?.label ?? null };
}

/**
 * Codecs this device is unlikely to play, worst first.
 *
 * Used to warn BEFORE pressing play on a title whose codec is already known, and
 * to fill the support panel in settings.
 */
/**
 * The filename extension of a media address, when it plausibly has one.
 *
 * Exists because a message once described a film as "a .file file": the value
 * it printed was the TRANSPORT (`hls` / `mpegts` / `file`), not an extension.
 * This reads the address instead, and answers null rather than guessing —
 * nothing assembled by our own server has a meaningful extension, and a query
 * string must never be mistaken for one.
 */
export function playableExt(url: string): string | null {
  const path = url.split('?')[0]?.split('#')[0] ?? '';
  const last = path.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = last.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(ext) && !/^(php|html?|json)$/.test(ext) ? ext : null;
}

export function missingCodecs(report: CapabilityReport | null): CodecResult[] {
  if (!report) return [];
  return report.codecs
    .filter((c) => c.verdict === 'no' || c.verdict === 'unlikely' || c.disputed)
    .sort((a, b) => Number(b.verdict === 'no') - Number(a.verdict === 'no'));
}

/**
 * Did the demuxer refuse the stream, or did the connection merely drop?
 *
 * The distinction decides everything that follows: a dropped connection is
 * reconnected, a refusal is handed to libVLC, and getting it backwards means
 * either a red box where a retry would have worked or an infinite retry of
 * something that will never decode.
 *
 * It used to be `/codec|mime|MediaSource/` against the detail string alone, and
 * that missed the most common refusal there is. mpegts.js names its failures
 * `MediaMSEError`, `MediaFormatError`, `MediaFormatUnsupported` and
 * `MediaCodecUnsupported` — of those four, only the last one contains the
 * substring "codec". So an AC-3 channel (`addSourceBuffer` rejects
 * `audio/mp4;codecs=ac-3`, because AC-3 in MSE is a licensed decoder Chromium
 * does not carry) reported `MediaMSEError`, matched nothing, and was shown as
 * "the raw TS stream stopped… the channel may be offline" — on a box whose
 * libVLC decodes AC-3 without blinking. Reported from the living room exactly
 * that way, in the debug log, on a channel that plays elsewhere.
 *
 * Matches the names AND the sentence mpegts.js puts in `info.msg`, which is
 * where the actual mime type appears.
 */
export function decoderRefusal(detail: string, msg = ''): boolean {
  return /codec|mime|MSE|MediaSource|Unsupported|FormatError|addSourceBuffer/i
    .test(`${detail} ${msg}`);
}
