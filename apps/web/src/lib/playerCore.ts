/**
 * Playback controller.
 *
 * Owns exactly one media element for the whole app, because the provider account
 * allows a single concurrent connection: a second surface would mean a second
 * socket and both would fail. Teardown always runs BEFORE the next load, never
 * after, and it aborts in-flight segment requests so the panel stops counting the
 * old session.
 *
 * Exposes tracks, levels, buffer, subtitles and stats so the UI can be a real
 * player rather than the browser's default control strip.
 */
import type HlsType from 'hls.js';
import type { Level, MediaPlaylist } from 'hls.js';
import type mpegtsType from 'mpegts.js';
import { kv } from './kv.ts';
import { cueBottomPercent, liftDefaultCue } from './cueBox.ts';
import { decoderRefusal, playableExt,
} from './codecs.ts';
import {
  DECLARE_GRACE_MS, judgeSound, noSoundMessage, refusedSourceBufferType, type DeclaredMedia,
} from './audioRefusal.ts';
import { freshWatch, judgeFrozen, type FreezeWatch } from './pictureFreeze.ts';
import { apiUrl } from './api.ts';
import { FreshLink } from './freshLink.ts';
import { tryNative, type NativeHandle } from './nativeBridge.ts';
import {
  forgetNeedsNative, hasNativeEngine, rememberNeedsNative,
  rememberWantsBrowser, streamKey, wantsBrowser, webHasNoPathFor,
  isFilmUrl,
} from './nativePlayer.ts';
import { isDisableTrack, nameTracks } from './trackLabels.ts';
import type { Span } from './filmBuffer.ts';
import { spansOf } from './filmBuffer.ts';
import {
  NEEDS_DEVICE_HINT, audioChoices, subtitleChoices, type FilmTrack,
} from './filmTracks.ts';
import { dlog, shortUrl } from './debugLog.ts';
import { logInfo, logError } from './sentry.ts';
import { fetchesItsOwnMedia, isNativeShell } from './direct.ts';
import { nativeWhy } from './nativeWhy.ts';
import { oneConnectionLine } from './oneConnection.ts';
import { DeviceFilm, deviceFilmPossible, type DeviceTrack } from './deviceFilm.ts';
import { DevicePreview } from './devicePreview.ts';
import { liveReserveS, resolveBufferProfile } from './liveBuffer.ts';
import { getPrefs } from './prefs.ts';
import { IOS_CANNOT_PLAY, currentPlatform, iosCannotOpenFile, isIos, pickWebEngine } from './platform.ts';
/* Only for `maxConnections`, so the refusal can say "one" rather than "some". */
import {
  adoptStreamBase, isPanelStreamUrl, nextStreamOrigin, rewriteStreamOrigin,
  streamBases, subscription,
} from './providers/index.ts';

export type { BufferMode, BufferProfile, BufferChoice } from './liveBuffer.ts';
export {
  BUFFER_PROFILES, BUFFER_CUSTOM_MIN, BUFFER_CUSTOM_MAX,
  getBufferMode, setBufferMode, getGlobalBufferChoice, setGlobalBufferChoice,
  getChannelBufferChoice, setChannelBufferChoice, resolveBufferProfile,
  profileFromChoice, customBufferProfile, clampBufferSeconds,
} from './liveBuffer.ts';

/**
 * Engines are loaded on demand.
 *
 * hls.js and mpegts.js together are ~700KB of the bundle, and a session uses at
 * most one of them. Importing them lazily keeps first paint fast, which matters
 * because the catalogue UI is usable before anything is playing.
 */
let HlsMod: typeof HlsType | null = null;
let TsMod: typeof mpegtsType | null = null;

async function loadHls(): Promise<typeof HlsType> {
  HlsMod ??= (await import('hls.js')).default;
  return HlsMod;
}
async function loadTs(): Promise<typeof mpegtsType> {
  TsMod ??= (await import('mpegts.js')).default;
  return TsMod;
}

/** Pull the demuxers into memory before the first channel press. */
export function warmPlaybackEngines(): void {
  void loadHls();
  void loadTs();
}

export type Phase = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface TrackOption {
  id: number;
  label: string;
  lang?: string | undefined;
  active: boolean;
}

/** A subtitle file we loaded ourselves, from OpenSubtitles or from disk. */
export interface ExternalSub {
  id: number;
  label: string;
  lang: string;
  active: boolean;
  /** Provider or file identity; the same file is not attached twice. */
  key: string | null;
}

/**
 * The state of the world at the moment playback gave up.
 *
 * Collected in `patch`, in one place, because there are twenty ways into the
 * error phase and a fact gathered at nineteen of them is a fact that is missing
 * exactly where the unfamiliar failure happens.
 */
export interface FailureFacts {
  /**
   * The TRANSPORT being used — `hls`, `mpegts` or `file`.
   *
   * Not a filename extension, which is what it was mistaken for: a film played
   * as a progressive download is `file`, and a message that wrote it out as one
   * told a viewer their film was "a .file file". See `ext` for the real thing.
   */
  container: string | null;
  /**
   * The actual extension from the address, when it has one — `mkv`, `mp4`, `ts`.
   *
   * Only for saying something true to a viewer. Null on any address that does
   * not end in a plausible extension.
   */
  ext: string | null;
  /** A live channel rather than a film, which changes what advice is sensible. */
  live: boolean;
  /** Did any media byte ever arrive for this stream? */
  bytes: boolean;
  /** Had it drawn a frame before it stopped? */
  played: boolean;
  /** Did the viewer jump within the last few seconds? */
  afterSeek: boolean;
  /** Is there a native engine on this device at all (the APK)? */
  nativeEngine: boolean;
  /** Was the device online when it failed? */
  online: boolean;
  /** Doors that failed on this stream before it gave up. */
  doorsTried: number;
  /** Of those, doors that refused the ACCOUNT rather than the stream. */
  doorsRefused: number;
}

export interface PlayerSnapshot {
  phase: Phase;
  label: string;
  /**
   * Which stream this is, across reloads of it.
   *
   * `loadId` changes on every load, including every retry of the same stream,
   * so anything that budgets retries per stream must not key on it. The screen's
   * automatic retry did, and reset its budget on each of its own retries: one
   * failure became a retry every 0.7 seconds for as long as the screen stayed
   * open — 114 opens in about two and a half minutes on the TV emulator.
   */
  streamKey: string;
  /** Bumps on every teardown/load so captions can drop the previous stream. */
  loadId: number;
  /** Live streams have no meaningful duration. */
  live: boolean;
  currentTime: number;
  duration: number;
  /** Newest buffered media time (end of the hold). */
  buffered: number;
  /** Oldest buffered media time still held — live delay scrubber lower bound. */
  bufferStart: number;
  /**
   * EVERY stretch of the film held in memory, not just the one around the
   * playhead.
   *
   * There is more than one only where the page owns the buffer — a film this
   * page takes apart itself (`deviceFilm.ts`) — and a piece drawn here starts
   * at once, from memory, with nothing fetched. Empty everywhere else, where
   * `bufferStart`/`buffered` already say everything there is to say.
   */
  heldSpans: { start: number; end: number }[];
  /**
   * The frame at a second of the film, made on the device.
   *
   *     and why no thumbnails?
   *
   * A function rather than an address, because there is no address: the frame
   * does not exist until this page decodes it, and what comes back is a `blob:`
   * URL for a PNG this page made. It answers null for a second it cannot get a
   * picture of, and never throws — see `devicePreview.ts`.
   */
  frameAt: ((t: number) => Promise<string | null>) | null;
  volume: number;
  muted: boolean;
  /** 0 = auto. */
  levels: TrackOption[];
  audioTracks: TrackOption[];
  subtitleTracks: TrackOption[];
  externalSubs: ExternalSub[];
  /**
   * The container's chapters, as reported by the engine playing it.
   *
   * Always empty on the web path: no browser exposes a Matroska chapter list to
   * a page, and this panel publishes none of its own. Never synthesised from the
   * runtime — see lib/chapters.ts for why that was removed.
   */
  chapters: { startS: number; label?: string }[];
  subtitleOffset: number;
  aspect: AspectMode;
  /** The engine actually in use, not what was requested. */
  transport: 'mpegts' | 'hls' | 'native' | null;
  /**
   * Is the picture an Android SURFACE behind the page, rather than the `<video>`
   * element inside it?
   *
   * A separate flag because `transport: 'native'` cannot answer that question:
   * it is set in two places for two different pictures — by the libVLC plugin
   * (which draws on a real surface behind a transparent WebView) and by
   * progressive playback through the `<video>` element (`"playing via <video>"`),
   * which is the WebView's own picture. Same word, opposite requirement.
   *
   * The consequence was visible and had nothing to do with codecs: the page
   * punches a transparent hole where the surface is, so anything the page paints
   * cannot hide the film. Keyed on `transport` it punched that hole for
   * progressive playback too — where there is no surface behind, only the page —
   * so the film's letterbox bars showed the details page THROUGH the picture.
   * Caught by opening a film in the harness at TV geometry: the MGM lion, with
   * the cast list of the film readable through the black bars.
   *
   * Set exactly where the plugin handle is stored and cleared, so it cannot
   * disagree with reality, and it is in the snapshot rather than a getter so the
   * effect that opens and closes the hole actually re-runs when it changes.
   */
  surface: boolean;
  /** Effective playback rate, including any live catch-up in progress. */
  rate: number;
  /** Speed the user chose for on-demand playback. */
  userRate: number;
  chaseLiveEdge: boolean;
  /** Automatic reconnect in progress: attempt number, 0 when idle. */
  recovering: number;
  stats: {
    resolution: string | null;
    bitrateKbps: number | null;
    droppedFrames: number;
    latencyS: number | null;
    /** Seconds between the playhead and the newest buffered frame. */
    lagS: number | null;
    stalls: number;
    codec: string | null;
  };
  /**
   * `blocked` means the browser refused the request rather than a server
   * answering it — see `refusedByBrowser`. Carried as a field rather than baked
   * into `message` because `diagnose` has to branch on it, and matching our own
   * English prose is not a contract.
   */
  error: {
    message: string;
    hint?: string | undefined;
    blocked?: { host: string } | undefined;
    /**
     * What the player tried before it gave up, oldest first — "load hls …",
     * "hls networkError/manifestLoadError http 0", "escalate → native", "native:
     * nothing after 15s". Drawn under the error so a failure on a television
     * explains itself without a console. See `PlayerCore.note`.
     */
    trail?: string[] | undefined;
    /**
     * What was TRUE when it gave up, as opposed to what the engine said.
     *
     * An engine message is written for whoever wrote the engine: "MEDIA_ERR_
     * SRC_NOT_SUPPORTED", or nothing at all. `diagnose` turns it into a sentence,
     * and for years the sentence for anything it did not recognise was "Playback
     * failed" with no second line — photographed off a television and sent in
     * with the fair question of why. These are the facts the player has at that
     * moment and never wrote down: whether a single byte ever arrived, whether
     * it had been playing, whether the viewer had just jumped, how many doors it
     * had already burned. They are enough to say something true in every case.
     */
    facts?: FailureFacts | undefined;
  } | null;
  /**
   * Something true about a stream that IS playing, said without stopping it.
   *
   * Not `error`, on purpose: an error replaces the picture with a box, and the
   * one case this carries is a picture worth keeping — a live channel whose
   * video this engine plays and whose audio it refused, with nowhere else to
   * send it. See `checkSound`. Reset with the rest of the snapshot by every
   * teardown and every load, so it can never describe the channel before.
   */
  /**
   * True when trying again cannot help, so nothing should.
   *
   * Retrying is right for a line that was busy for a moment and wrong for a
   * file nothing here can open: asking again does not make a browser learn a
   * codec, and on a subscription allowing ONE stream every attempt is another
   * connection the panel refuses — which is what was photographed, a
   * column of `302` then `206` at three hundred bytes, over and over, under
   * the word "Reconnecting".
   */
  permanent: boolean;
  notice:
    | { kind: 'noSound'; codec: string; message: string }
    | null;
}

export type AspectMode = 'contain' | 'cover' | 'fill' | '16:9' | '4:3';

/**
 * How much live video to keep behind the playhead for the delay scrubber.
 *
 * Forward buffer is the viewer's buffer profile; this is the other direction —
 * enough to pick seconds or a few minutes behind live without the SourceBuffer
 * deleting what they just scrubbed into.
 */
export const LIVE_BACK_BUFFER_S = 180;

/** Contiguous hold that contains (or is nearest) the playhead. */
export function liveHoldWindow(v: HTMLMediaElement): { start: number; end: number } | null {
  const b = v.buffered;
  if (b.length === 0) return null;
  const t = v.currentTime;
  for (let i = b.length - 1; i >= 0; i--) {
    const start = b.start(i);
    const end = b.end(i);
    if (t >= start - 0.5 && t <= end + 0.5) return { start, end };
  }
  const i = b.length - 1;
  return { start: b.start(i), end: b.end(i) };
}

/**
 * Which transport to use for live.
 *
 * `lowLatency` streams raw MPEG-TS and demuxes it in the page: ~1-3s behind live.
 * `compatible` uses HLS, which on this provider means 10s segments and therefore
 * 30-60s of structural delay no setting can remove.
 *
 * TS is only usable because every request now goes through our own origin — the
 * panel answers CORS preflight with 502, and mpegts.js needs Range requests,
 * which would have required one. Same-origin needs no preflight.
 */
/**
 * How a live channel is fetched.
 *
 * `auto` is the default and the only one most people should ever see. The other
 * two were the whole control before, sitting in a bar above the picture as two
 * equal choices with no way to tell which one a channel wanted — a question no
 * viewer can answer, because the answer is a property of the stream and of the
 * device's decoders.
 *
 * What `auto` does: start on the low-latency path, because 1-3s behind live beats
 * 30s, and drop this channel to the compatible one when the raw feed cannot be
 * demuxed or decoded here. That decision is remembered per stream, so a channel
 * that needs HLS gets it immediately next time. See `resolveLiveMode`.
 */
export type LiveMode = 'auto' | 'lowLatency' | 'compatible';

/** What `auto` actually resolves to for one stream. */
export type LiveTransport = 'lowLatency' | 'compatible';

/*
 * Live buffer profiles live in `liveBuffer.ts`. Note what is NOT configured
 * there: `liveBufferLatencyChasing`. That option keeps you near the live edge by
 * SEEKING forward — visible skipping and inflated dropped-frame counts. It is
 * hard-off on every profile; staying near the edge is done by speeding up
 * slightly instead (see `driveEdgeChase`), which shows every frame.
 */

/**
 * How long libVLC may stay SILENT before the player gives up on it.
 *
 * Measured against the clock that matters: this is reset by every buffering,
 * time and length event, so it only expires when the engine has said nothing at
 * all. 25s rather than 15 because a 4K MKV opening over a slow line is quiet for
 * a while before its first event, and killing that is worse than waiting.
 */
const NATIVE_WAIT_MS = 25_000;
/** A film's patience, which has to cover the device relay's slot wait — see `nativeWaitMs`. */
const NATIVE_FILM_WAIT_MS = 40_000;

/**
 * How long a door may say NOTHING before the next one is tried.
 *
 * This account answers on seven hostnames and they are not equally alive.
 * `tryOtherLine` has always walked them — but only from an error, and a door
 * that hangs produces no error: the request sits pending until Cloudflare gives
 * up on its own origin and answers 522, which was photographed at about
 * twenty seconds, with the note "when they take longer like this, try next and
 * so on, bcs they are not always this slow".
 *
 * Nine seconds, and only when NOTHING has arrived — see `openStalled`, which
 * checks the element for a buffered byte first. A stream that is merely slow is
 * left alone, because hopping doors on a stream that was two seconds from
 * playing would trade a wait for a failure. And if there is no other door, this
 * does nothing at all and the ordinary error path still owns the outcome.
 */
/**
 * How recently bytes must have arrived for a door to count as answering.
 *
 * `progress` fires at least every 350ms while the browser is fetching media
 * data, so anything inside a couple of seconds means the transfer is alive.
 * Generous rather than tight on purpose: the connections this protects are the
 * slow ones, and the cost of waiting too long is a few seconds, while the cost
 * of hopping is a fresh session against an account that may only allow one.
 */
const BYTES_FRESH_MS = 4_000;

/**
 * How long after a seek a failure is still the seek's fault.
 *
 * A ranged request that the server mishandles fails quickly; this is wide
 * enough to cover a slow one and far too short to blame a seek for a failure
 * minutes later.
 */
const SEEK_BLAME_MS = 12_000;

/**
 * How long a burst of seeks is left to settle before the engine is asked once.
 *
 * Reported as "it still crashes once I move forward or backwards like a few
 * times". Every press of forward or back used to be its own seek, and for a film
 * being fetched over HTTP every seek is a fresh ranged request: five quick
 * presses were five requests against an account that allows ONE connection, each
 * abandoning the last, and on libVLC five `setTime` calls racing the stop and
 * reload the seek recovery then issued. That is the crash.
 *
 * The playhead the viewer SEES moves on every press — only the engine waits. A
 * television remote's forward button is pressed in bursts, and nobody wants the
 * picture from the four positions they skipped past on the way.
 */
const SEEK_SETTLE_MS = 350;

/**
 * Seconds libVLC actually holds ahead of the playhead on a film.
 *
 * It exposes no downloaded-range of the file, only how full its network cache
 * is, and that cache is set per film to `VOD_CACHING_MS` = 1000 in
 * StreamixPlayerPlugin.java. So this is not a guess dressed as a measurement: it
 * is the size of the only buffer the engine has. Keep the two in step.
 */
const NATIVE_VOD_AHEAD_S = 1;

/**
 * Where a press of forward or back should land.
 *
 * From the target of a seek still waiting to be issued, when there is one —
 * otherwise from the playhead. Measuring from the playhead during a burst is
 * what made four presses of +10s land ten seconds on: each one read a position
 * that the previous press had not reached yet. Clamped to the film, because a
 * burst from near the end must stop at the end rather than seek past it.
 */
export function nudgeTarget(
  pending: number | null,
  playhead: number,
  by: number,
  duration: number,
): number {
  const from = pending ?? playhead;
  const to = Math.max(0, from + by);
  return duration > 0 ? Math.min(to, duration) : to;
}

/**
 * How far along a film the bar may honestly draw as downloaded.
 *
 * This reported the film's whole length for anything libVLC held, so the bar
 * showed a completely downloaded film from the first second — "it shows like the
 * whole movie is downloaded". The engine only ever holds its cache, so that is
 * what is drawn: the playhead plus `NATIVE_VOD_AHEAD_S`, never past the end.
 */
/**
 * Whether two stats reports say the same thing, as a viewer would read them.
 *
 * The lag and the latency are floats that move by milliseconds every tick; the
 * stream tab shows them to a tenth and the LIVE pill turns at twelve seconds,
 * so half a second is the grain that matters. Everything else must match.
 */
export function sameStats(a: PlayerSnapshot['stats'], b: PlayerSnapshot['stats']): boolean {
  const near = (x: number | null, y: number | null) =>
    x === y || (x !== null && y !== null && Math.abs(x - y) < 0.5);
  return a.resolution === b.resolution && a.bitrateKbps === b.bitrateKbps
    && a.droppedFrames === b.droppedFrames && a.stalls === b.stalls && a.codec === b.codec
    && near(a.lagS, b.lagS) && near(a.latencyS, b.latencyS);
}

export function nativeBufferedEnd(playhead: number, duration: number): number {
  const end = playhead + NATIVE_VOD_AHEAD_S;
  return duration > 0 ? Math.min(end, duration) : end;
}

/**
 * Did the viewer's seek break this, rather than the stream being finished?
 *
 * Reported as: "when the quality is high or something, and i try to change
 * position it suddenly goes away and shows failed." A big file makes it likelier
 * because more of it lies outside what has been downloaded, so more seeks turn
 * into a ranged request — and a panel that mishandles one (answers 200 with the
 * whole file, or closes the connection) errors the element outright.
 *
 * Everything that could have rescued it was switched off by then. The recovery
 * paths in `progressiveFailed` are all guarded on `!everPlayed`, deliberately,
 * so that a film which has been playing does not go hunting for another door on
 * a one-connection account. Correct — and it left the commonest failure of all
 * with nothing between it and an error message, on a film that was working a
 * second ago and whose door is fine.
 *
 * So the answer is not another door, it is the same door and the same file,
 * reopened at the position the viewer asked for. Once per stream, because a
 * seek that cannot work must not become a loop.
 */
export function seekBroke(
  everPlayed: boolean,
  lastSeekAt: number,
  now: number,
  alreadyRecovered: boolean,
): boolean {
  if (!everPlayed || alreadyRecovered) return false;
  if (lastSeekAt === 0) return false;
  return now - lastSeekAt < SEEK_BLAME_MS;
}

/**
 * How long to keep waiting for a native seek to show up in the engine's own
 * time reports before believing them again.
 *
 * Long enough for libVLC to open a new read position on a slow line and find
 * its keyframe; short enough that a seek the engine silently declined leaves
 * the bar wrong for a moment rather than for good.
 */
const NATIVE_SEEK_WAIT_MS = 6_000;

/** A native seek that has been drawn but not yet seen in the engine's clock. */
export interface NativeSeek {
  /** Where the viewer asked to go. */
  to: number;
  /** Where the playhead was when they asked — the value to stop believing. */
  from: number;
  /** When the engine was last asked. The give-up clock. */
  at: number;
}

/**
 * Should this time report from the native engine be believed?
 *
 * ── the bug this exists for ──
 *
 *     the progressbar doesnt move on tv it gets back where it is
 *     movies series "forward not working"
 *
 * The surface belongs to libVLC, so the `<video>` element reads zero and
 * `nativeTime` — fed from the engine's `time` events — is the only clock the
 * bar has. Two things then collide:
 *
 *   * a seek is DRAWN at once, because a bar that does not move under the
 *     viewer's thumb feels broken, and
 *   * the engine is not ASKED for `SEEK_SETTLE_MS`, so that a drag costs one
 *     seek rather than thirty.
 *
 * In between, and for as long as the seek takes to land afterwards, libVLC
 * goes on reporting the position it is actually at — the OLD one — roughly
 * four times a second. Every one of those used to be written straight over
 * `nativeTime`, so the bar sprang back to where it started within a quarter of
 * a second. Worse, the next press was measured from the position that had
 * snapped back, so presses could not accumulate and seeking forward looked
 * like it did nothing at all.
 *
 * The engine has no "seeking" or "seeked" event to wait for — the plugin emits
 * `time`, `length`, `buffering`, `playing`, `paused`, `ended` and `error`, and
 * nothing else — so the rule has to be inferred from the numbers themselves.
 *
 * ── the rule ──
 *
 * Believe a report once it is nearer to where the viewer asked to go than to
 * where they left. That is true the moment the engine genuinely moves, it is
 * never true of a stale pre-seek report, and it needs no tolerance constant
 * tuned against keyframe spacing — a seek that lands four seconds short of the
 * target is still unmistakably at the target END of the journey.
 *
 * `from` is the position at the START of a burst, not the previous press's
 * target: during a drag the latch keeps its original `from`, so the twentieth
 * frame of a drag is still measured against where the drag began.
 *
 * And it gives up. A seek the engine declines outright would otherwise freeze
 * the bar on a number that is never going to become true, which is a worse lie
 * than the one this fixes.
 */
export function believeNativeTime(
  reported: number,
  seek: NativeSeek | null,
  now: number,
  waitMs: number = NATIVE_SEEK_WAIT_MS,
): boolean {
  if (seek === null) return true;
  if (now - seek.at >= waitMs) return true;
  return Math.abs(reported - seek.to) <= Math.abs(reported - seek.from);
}

/**
 * Is the door on the other end of this stream answering?
 *
 * Split out of the player so the rule can be tested without a media element,
 * because it is a rule that has been wrong twice and is expensive to get wrong:
 * every "no" is a hop to another door, and on an account that allows one
 * connection a hop is a fresh session against it.
 *
 * `readyState >= 2` means metadata arrived and `buffered.length > 0` means
 * there is a timeline with data on it. Both describe data the element can PLAY,
 * and both are blind to data merely ARRIVING — which is the case people hit. A
 * progressive MP4 with its index at the end of the file downloads megabytes
 * with both of them at zero, because there is no timeline to buffer against
 * until that index turns up. So a film downloading perfectly well read as "this
 * door said nothing".
 *
 * Reported with a network trace: one film pulled from four doors in turn, more
 * than one transfer abandoned mid-download at several megabytes, nothing ever
 * played. Worst on a slow connection, where the download is simply slower than
 * the watchdog. "if its downloading dont change to another server."
 *
 * `lastByteAt` is when the element last fired `progress` — the browser saying
 * bytes came in, whether or not any of them can be decoded yet.
 */
export function doorIsAnswering(
  readyState: number,
  bufferedLength: number,
  lastByteAt: number,
  now: number,
): boolean {
  if (readyState >= 2 || bufferedLength > 0) return true;
  /* 0 means nothing has arrived since this stream opened — not "long ago". */
  if (lastByteAt === 0) return false;
  return now - lastByteAt < BYTES_FRESH_MS;
}

const OPEN_WAIT_MS = 9_000;

/**
 * The pause before trying another door, when another door is genuinely the answer.
 *
 * Zero was the old value and zero is a stampede: four doors opened inside a
 * second look like a scraper to a panel that allows one connection, and the
 * debug log shows `player_api.php` going from 60ms to 38 SECONDS immediately
 * after one. Long enough that the line's previous session is released and the
 * panel sees a viewer retrying; short enough that a real failover is still over
 * before someone reaches for the remote.
 */
const DOOR_GAP_MS = 1_200;

/**
 * And how long a door that IS answering may go on saying nothing playable.
 *
 * Measured from the first check rather than from the load, so it is 20 seconds
 * in total. Long on purpose: a 4K film opening over a home line is quiet for a
 * while, and taking that away would be the "changing servers way too quick"
 * complaint in a different costume. What it catches is the file that will never
 * start — see `openStalled`.
 */
const OPEN_SECOND_MS = 11_000;
/**
 * And how long a LIVE channel gets before the same second look.
 *
 * Longer than a film's, because a channel fills a buffer before it shows
 * anything and this must never fire on a slow line that was about to succeed.
 * 9s + 16s = 25s with bytes still arriving and not one frame decoded, which is
 * past any buffering this app asks for.
 */
const LIVE_SECOND_MS = 16_000;

/**
 * How much audio may play with no picture before that counts as a failure.
 *
 * Measured in MEDIA time, not wall clock, so a stall — where nothing is decoded
 * because nothing has arrived — cannot trip it. Four seconds of sound with the
 * frame counter still on zero is not a slow start; it is a video track the
 * decoder dropped.
 *
 * ── why this exists ─────────────────────────────────────────────────────────
 *
 * Reported from a real box: "now I hear music but no video in movies". Every
 * escalation path in this file hangs off an ERROR — `video.error`, hls.js's
 * MEDIA_ERROR, mpegts.js refusing a source buffer — and this failure raises
 * none of them. The element reports success and plays, because the audio track
 * decodes perfectly; there is simply no picture.
 *
 * Measured against the panel (`scripts/codec-probe.mjs`, 2026-09-06): 7 of 8
 * sampled `.mp4` films from the 4K shelf carry HEVC video (hvc1/hev1) with AAC
 * audio in an MP4 container. An MP4 with AAC is a container Chromium demuxes
 * happily, so it plays the sound and drops the video track it has no decoder
 * for. `.mp4` is not a hostile extension, so the container rule in
 * `chooseEngine` lets every one of them through.
 *
 * ── the second half of that sentence was true and is not any more ───────────
 *
 * It used to end "and this panel publishes no codec at all — `get_vod_info`
 * returns `video: []` and `audio: []` for exactly these titles". Re-measured
 * 2026-09-07 (`scripts/series-probe.mjs`): `get_vod_info` publishes a codec for
 * 17 of 25 sampled films, and `get_series_info` for 26 of 26 sampled episodes.
 * So the panel does publish one, most of the time, and `chooseEngine` now reads
 * it — see `PlaybackTarget.codec`.
 *
 * That narrows this watchdog's job without removing it, and the remainder is
 * exactly the 8 films in 25 the panel says nothing about, every live channel
 * (a panel publishes no codec for one, ever), and every free playlist entry,
 * which has no panel behind it to ask. For all of those the only place the truth
 * is available is here, at runtime, from the frame counter.
 */
const BLIND_MEDIA_S = 4;
/**
 * Advancing media time with a frame counter that has not moved = frozen.
 *
 * Three seconds rather than one: a stream whose keyframes are far apart, or a
 * decoder recovering from a corrupt packet, can genuinely produce nothing for
 * over a second, and throwing away a working connection on a one-connection
 * account is worse than a second of stutter. Measured against the clock the
 * PICTURE is spending, so a stall costs none of it.
 */
const FROZEN_MEDIA_S = 3;

/** See `mayOpen`: at most this many opens of one stream per window. */
export const MAX_OPENS = 10;
/** A load still `loading` after this long is given up on — see `load`. */
const LOAD_GIVE_UP_MS = 45_000;
export const OPEN_WINDOW_MS = 120_000;

/**
 * May this stream be opened again? The rule behind `mayOpen`, pure.
 *
 * Counts opens of the SAME stream inside a sliding window. A different stream
 * starts its own count — zapping is not a loop — and an open that is refused
 * is not counted, so the window drains while the viewer waits.
 */
export function admitOpen(
  prev: { key: string; at: readonly number[] }, key: string, now: number,
  max = MAX_OPENS, windowMs = OPEN_WINDOW_MS,
): { ok: boolean; count: number; state: { key: string; at: number[] } } {
  const recent = prev.key === key ? prev.at.filter((t) => now - t < windowMs) : [];
  if (recent.length >= max) return { ok: false, count: recent.length, state: { key, at: recent } };
  return { ok: true, count: recent.length + 1, state: { key, at: [...recent, now] } };
}

/**
 * How long to wait for the server to explain a `<video>` failure.
 *
 * Short on purpose. This runs after playback has already failed, so it is time
 * added to a failure the viewer is already watching, and the alternative to an
 * answer is the behaviour that shipped before it — an escalation to libVLC. Six
 * seconds is comfortably above the measured round trip to every door this
 * account uses (12ms-900ms) and below the point where a viewer would rather have
 * a wrong error than no error. See `progressiveFailed`.
 */
const SERVER_ASK_MS = 6_000;

const EMPTY: PlayerSnapshot = {
  phase: 'idle', label: '', streamKey: '', loadId: 0, live: false, currentTime: 0, duration: 0, buffered: 0,
  heldSpans: [], frameAt: null,
  bufferStart: 0,
  volume: 1, muted: false, levels: [], audioTracks: [], subtitleTracks: [],
  externalSubs: [], subtitleOffset: 0, chapters: [],
  aspect: 'contain', transport: null, surface: false, rate: 1, userRate: 1,
  chaseLiveEdge: false, recovering: 0,
  stats: {
    resolution: null, bitrateKbps: null, droppedFrames: 0,
    latencyS: null, lagS: null, stalls: 0, codec: null,
  },
  error: null,
  notice: null, permanent: false,
};

type Listener = (s: PlayerSnapshot) => void;

function levelLabel(l: Level): string {
  if (l.height) return `${l.height}p${l.bitrate ? ` · ${Math.round(l.bitrate / 1000)}k` : ''}`;
  return l.bitrate ? `${Math.round(l.bitrate / 1000)} kbps` : 'unknown';
}

/**
 * What `load` is handed. `headers` and `reresolve` ride along on a target and are
 * kept by every reload path, because those spread the target they were given.
 */
export interface LoadTarget {
  url: string;
  container: string;
  codec?: string | null;
  /** Request headers the stream asked for; only the native engine can send them. */
  headers?: Record<string, string>;
  /** A fresh link from the source (a portal's links expire). */
  reresolve?: () => Promise<LoadTarget>;
}

export class PlayerCore {
  private hls: HlsType | null = null;
  private ts: mpegtsType.Player | null = null;
  /**
   * This demuxer refused the stream, so ignore anything else it says.
   *
   * Reset by `teardown()`, which every load runs first, so it can never carry
   * a refusal from one channel into the next.
   */
  private tsRefused = false;
  private video: HTMLVideoElement | null = null;
  private listeners = new Set<Listener>();
  private snap: PlayerSnapshot = { ...EMPTY, chaseLiveEdge: getChaseLiveEdge() };
  private epoch = 0;
  private pumpTimer = 0;
  private stalls = 0;
  private subSeq = 0;
  /**
   * Extra seconds to sit behind the live edge, requested by other subsystems.
   *
   * Live captions want a little slack: transcription reads the audio that is
   * playing, and running right at the edge leaves nothing to absorb a hiccup. The
   * user's own words — "you can add a buffer for a couple of seconds as long as
   * it's accurate" — so this widens the catch-up target rather than reloading the
   * stream with a bigger stash, which would interrupt playback.
   */
  private lagSlack = 0;
  /** What is playing, so a dropped feed can be re-opened without the UI's help. */
  /**
   * What the app ASKED for, verbatim.
   *
   * `last` holds what is actually playing, which is the right answer for every
   * question the player asks itself. This is what "open this again,
   * differently" re-issues — which is what changing the engine for one channel
   * is.
   */
  /** The stream a portal link was already asked for again; one fresh link per open. */
  private readonly freshLink = new FreshLink();

  private asked: {
    url: string;
    container: string;
    codec: string | null;
    label: string;
    live: boolean;
    key: string;
    headers?: Record<string, string>;
    reresolve?: () => Promise<{ url: string; container: string; codec?: string | null }>;
  } | null = null;

  private last: {
    target: LoadTarget;
    label: string;
    live: boolean;
    /**
     * The stable identity of this stream, for the two decisions that are "once
     * per stream": the escalation guard and the learned-engine list.
     *
     * A catalogue ref when the caller passed one, which stays the same across
     * subscriptions; otherwise `streamKey` of the URL.
     */
    key: string;
  } | null = null;
  /** Length stated by the caller for a container that cannot state its own. */
  private assumedDuration = 0;
  /**
   * The native engine, while it owns the picture.
   *
   * Non-null only on Android, only for streams the WebView cannot decode, and
   * only after the plugin has answered a call — see `lib/nativePlayer.ts`. While
   * it is set, every transport control routes to it and the `<video>` element is
   * left empty, because the frames are on a surface behind the page.
   */
  private nativeOwned: NativeHandle | null = null;
  /**
   * Set for exactly one `load()`, by `escalate()`.
   *
   * The WebView has already failed to decode the current stream when this is
   * true, so the engine choice is skipped and libVLC gets it.
   */
  private forceNative = false;
  /** One escalation per stream. A loop between two engines is worse than an error. */
  private escalated = '';
  /**
   * Ask the route to re-open the current channel on the compatible transport.
   *
   * The core cannot do this itself: the route builds the URL with a `ts` or
   * `m3u8` extension, and asking for the other one is the route's call. So the
   * core decides WHEN — it is the only thing that sees the demuxer fail — and the
   * route decides HOW.
   */
  onNeedCompatible: ((reason: string) => boolean) | null = null;
  private attempts = 0;
  private recoverTimer = 0;
  private steadySince = 0;
  /** Origins already tried for the current stream, so a 404 walks the pool once. */
  private failedOrigins = new Set<string>();
  /**
   * Doors that answered with a flood status, as opposed to failing some other way.
   *
   * Kept apart from `failedOrigins` because the two answer different questions.
   * "Which doors have I tried" decides where to go next; "which doors REFUSED
   * THIS ACCOUNT" decides what to tell somebody once there is nowhere left.
   */
  private refusedOrigins = new Set<string>();
  /** A door being TRIED. Committed by `markSteady` only once it has played. */
  private pendingBase: string | null = null;
  private lineKey = '';
  /** True once this stream actually painted. A first-load miss is not a blip. */
  private everPlayed = false;
  /**
   * The story of the current stream, one line per decision, for the error box
   * and the debug log. Reset when a different stream is opened.
   */
  private trail: string[] = [];
  /** Fires if libVLC accepted a stream and then said nothing. See `nativeStalled`. */
  private nativeWatch = 0;
  /** Fires if a door never answered at all. See `openStalled`. */
  private openWatch = 0;
  /**
   * When media bytes last actually ARRIVED, as `Date.now()`. 0 = not since this
   * stream opened. Read by `doorAnswering`, and the reason it can be trusted.
   */
  private lastByteAt = 0;
  /**
   * Where the viewer last asked the playhead to go, and when — for `seekBroke`.
   * `seekTo` is in seconds; `lastSeekAt` is 0 when nothing has been sought.
   */
  private seekTo = 0;
  private lastSeekAt = 0;
  /* A native seek drawn on the bar but not yet visible in the engine's own
     clock. Null whenever the bar and the engine agree. See `believeNativeTime`. */
  private nativeSeek: NativeSeek | null = null;
  /** One reopen per stream for a seek that killed it. See `seekBroke`. */
  private seekRecovered = false;
  /** A seek waiting for its burst to settle, in seconds; null when none is. */
  private pendingSeek: number | null = null;
  /** The film being taken apart by this page — see `deviceFilm.ts`. */
  private deviceFilm: DeviceFilm | null = null;

  /** The seek bar's own frames, from the same film — see `devicePreview.ts`. */
  private devicePreview: DevicePreview | null = null;
  /** Where the current load was asked to begin — see `resumePoint`. */
  private startedAt = 0;
  /** See `LOAD_GIVE_UP_MS`. */
  private loadWatch = 0;
  /** The epoch whose load last delivered — so the watchdog never fires on one that started. */
  private playedEpoch = -1;
  /**
   * Where the viewer is in the film, kept apart from the snapshot.
   *
   * "When they do anything it just starts from the beginning", "if you pause a
   * show and then try to restart it goes back to the beginning". Eight of the
   * recovery paths in this file reload the stream — a door that stopped
   * answering, a rewritten URL, a stall, a decoder that froze
   * and is retried in software — and every one of them called `load` without a
   * start position. On a channel that is harmless. On a film it is the whole
   * report: any hiccup the player recovers from sends the viewer to 0:00, and a
   * pause long enough for the panel to drop an idle connection is exactly such
   * a hiccup.
   *
   * It cannot be read from the snapshot at the moment of the reload, because by
   * then `teardown` has run and the playhead reads zero. So it is recorded as
   * playback happens — every reliable position, and every seek the viewer asked
   * for — and keyed to the stream, so it never follows the viewer into the
   * next film.
   */
  private filmAt: { key: string; at: number } = { key: '', at: 0 };
  private seekTimer = 0;
  /**
   * Skip the native engine for exactly one `load()`.
   *
   * Set by `nativeStalled` when libVLC was chosen up front — a learned stream, or
   * the engine preference — and produced no picture. The WebView gets one turn,
   * which on an emulator that cannot run the native libraries is the only turn
   * that ever draws anything.
   */
  private skipNativeOnce = false;
  /**
   * Decode the NEXT native load in software, once.
   *
   * Set by `nativeRefused` when the engine failed on a stream the server was
   * demonstrably serving as video. Cleared by `load` the way `forceNative` and
   * `skipNativeOnce` are, so it can never leak into the stream after it.
   */
  private softwareOnce = false;
  /** Has this load already been retried in software? Stops a loop of two. */
  private triedSoftware = false;
  /**
   * Media time at which the picture went missing, or 0 when there is one.
   *
   * Read by `watchPicture`. Media time rather than wall clock on purpose: only
   * playback that is actually ADVANCING counts against the deadline, so a stall
   * or a slow line can never be mistaken for a missing video decoder.
   */
  private blindFrom = 0;
  /** Said once. A stream with no picture must not fill the log with the fact. */
  private blindReported = false;
  /**
   * The picture that STOPS, which is a different failure from the one that never
   * starts.
   *
   * "some videos just play for a few 2nd and then goes black and only audio
   * comes" — and `watchPicture` could not see it, because its whole test was
   * "have any frames arrived", which for these streams is yes. What goes wrong
   * is that frames stop arriving while everything else carries on: the clock
   * advances, the sound plays, no error is raised by anybody.
   *
   * So both engines are watched the same way — the last frame count, and the
   * media time at which it last CHANGED. A count standing still while the clock
   * moves is the freeze itself rather than an inference from it.
   */
  private frames: FreezeWatch = freshWatch();
  /** Acted on once per load, so a frozen picture cannot start a retry loop. */
  private freezeHandled = false;
  /**
   * Does the stream the engine opened actually contain video?
   *
   * `null` until an engine says. Only the demuxers can answer — mpegts.js
   * publishes `hasVideo` in MEDIA_INFO and hls.js publishes a `videoCodec` per
   * level — and the answer matters because this catalogue carries radio
   * channels, which are audio with no picture BY DESIGN. Escalating one of those
   * to libVLC would pin a working radio station to the native surface for ever.
   */
  private hasVideoTrack: boolean | null = null;
  /**
   * The sound half of the current TS stream, as `checkSound` weighs it.
   *
   * `declared` is what MEDIA_INFO said the stream carries; `refusedTypes` every
   * SourceBuffer type the engine refused on this load; `soundRefusal` the first
   * AUDIO refusal, kept whole because the ordinary refusal path may still need
   * it; `soundWatch` the one re-check if MEDIA_INFO is late. `soundJudged` makes
   * the verdict once per load — a repeated refusal must not escalate twice or
   * stack notes. `soundless` means the picture was kept without its sound, which
   * `drainRefusedAudio` has to clean up after. All of it reset by `teardown()`.
   */
  private declared: DeclaredMedia | null = null;
  private refusedTypes: string[] = [];
  private soundRefusal: { type: string; text: string; why: string; at: number } | null = null;
  private soundWatch = 0;
  private soundJudged = false;
  private soundless = false;

  private note(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.trail.push(text);
    if (this.trail.length > 14) this.trail.shift();
    dlog[level]('player', text);
  }
  /** Rendered cue elements are owned by the element, so tracks are tracked here. */
  private subEls = new Map<number, HTMLTrackElement>();
  /** Original cue times, so the offset control stays lossless across changes. */
  private cueBase = new WeakMap<TextTrackCue, { start: number; end: number }>();
  /** Default-positioned cues we lifted above the control bar. */
  private liftedCues = new WeakSet<VTTCue>();
  private cueRo: ResizeObserver | null = null;
  /**
   * How to unhook the element we are attached to.
   *
   * `attach` used to add its listeners anonymously and never remove them, which
   * made re-attaching the same element accumulate duplicate handlers and made
   * releasing a replaced element impossible.
   */
  private videoOff: (() => void) | null = null;

  attach(video: HTMLVideoElement): void {
    if (this.video === video) return;
    /**
     * Releasing the OUTGOING element is the whole reason this is not just an
     * assignment.
     *
     * A remount hands us a new element while the old one is still decoding, still
     * holding an MSE source buffer, and still audible. Pointing `this.video` at
     * the new one orphaned it: every control from then on acted on the new
     * element, so the picture the viewer was looking at could not be paused,
     * seeked or stopped by anything in the UI. That is the "it keeps playing and
     * I cannot stop it" report.
     */
    if (this.video) {
      const prev = this.video;
      this.teardown();
      this.videoOff?.();
      this.videoOff = null;
      try {
        prev.pause();
        prev.removeAttribute('src');
        prev.load();
      } catch {
        /* a detached element can throw; it is going away regardless */
      }
    }
    this.video = video;
    video.volume = this.snap.volume;
    video.muted = this.snap.muted;

    const sync = () => this.patch({});
    const onVolume = () => this.patch({ volume: video.volume, muted: video.muted });
    const onPause = () => {
      if (this.snap.phase === 'playing') this.patch({ phase: 'paused' });
    };
    const onPlay = () => {
      if (this.snap.phase === 'paused') this.patch({ phase: 'playing' });
    };
    // A stall is the honest symptom of too little buffer; counting them is what
    // makes "raise the buffer profile" an informed suggestion rather than a guess.
    const onWaiting = () => {
      this.stalls++;
      this.patch({ stats: { ...this.snap.stats, stalls: this.stalls } });
    };
    /*
      `progress` is the only honest "bytes arrived" this element gives us.
      
      It fires while the browser is fetching media data, whether or not any of
      it can be decoded yet — which is exactly the case `doorAnswering` was
      getting wrong. Recorded here rather than inferred later, because by the
      time the stall watchdog looks there is nothing left to ask.
    */
    const onProgress = () => { this.lastByteAt = Date.now(); sync(); };
    video.addEventListener('timeupdate', sync);
    video.addEventListener('progress', onProgress);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('pause', onPause);
    video.addEventListener('play', onPlay);
    video.addEventListener('waiting', onWaiting);
    this.videoOff = () => {
      video.removeEventListener('timeupdate', sync);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('waiting', onWaiting);
    };
    this.pump();
    this.watchTextTracks(video);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  get state(): PlayerSnapshot {
    return this.snap;
  }

  get element(): HTMLVideoElement | null {
    return this.video;
  }

  /**
   * Ask libVLC what is inside the film \u2014 and keep asking until it knows.
   *
   * This ran ONCE, the moment `load()` resolved, and that is the moment libVLC
   * has accepted a URL and not yet read a byte of the file: the answer is an
   * empty list or the video track alone. Nothing ever asked again, so a film
   * carrying a Dutch dub and three subtitle tracks showed neither menu for the
   * whole two hours. Measured on this catalogue with ffprobe: of eight films
   * sampled across the library, three carried a second audio track and embedded
   * subtitles \u2014 French, Spanish and German dubs beside the English original.
   *
   * So it asks on open (cheap, and right for a file already parsed), then again
   * once there is a picture, then twice more while the engine finishes reading
   * the container. Later answers replace earlier ones, an answer that arrives
   * for a stream that has since been replaced is dropped on the `epoch` check,
   * and a list that shrinks to nothing is ignored rather than allowed to empty a
   * menu the viewer is looking at.
   */
  private readNativeTracks(native: NativeHandle, mine: number, delayMs = 0): void {
    const ask = (): void => {
      if (this.epoch !== mine || this.nativeOwned === null) return;
      void native.tracks().then((t) => {
        if (this.epoch !== mine) return;
        const audio = nameTracks(t.audio);
        const subs = nameTracks(t.subtitles).filter((x) => !isDisableTrack(x.id, x.label));
        /* A file libVLC has not finished reading answers with fewer tracks than
           the last answer did. Keeping the richer list costs nothing and stops
           the menu flickering shut under somebody's hand. */
        if (audio.length < this.snap.audioTracks.length
          && subs.length < this.snap.subtitleTracks.length) return;
        const selectedAudio = t.audioSelected ?? audio[0]?.id ?? -1;
        const selectedSub = t.subtitleSelected ?? -1;
        this.patch({
          audioTracks: audio.map((a) => ({ id: a.id, label: a.name, active: a.id === selectedAudio })),
          subtitleTracks: subs.map((x) => ({ id: x.id, label: x.name, active: x.id === selectedSub })),
          chapters: t.chapters ?? this.snap.chapters,
        });
      }).catch(() => { /* an engine with no track list is still an engine */ });
    };
    if (delayMs === 0) { ask(); return; }
    window.setTimeout(ask, delayMs);
  }

  /** Everything true about this attempt that an engine message does not say. */
  private facts(): FailureFacts {
    const v = this.video;
    return {
      container: this.last?.target.container?.toLowerCase() ?? null,
      ext: playableExt(this.last?.target.url ?? ''),
      live: this.snap.live,
      bytes: this.lastByteAt > 0 || (v?.buffered.length ?? 0) > 0,
      played: this.everPlayed,
      afterSeek: this.lastSeekAt > 0 && Date.now() - this.lastSeekAt < SEEK_BLAME_MS,
      nativeEngine: hasNativeEngine(),
      /* `navigator.onLine` is false ONLY when the device knows it has no network
         — it is famously optimistic in the other direction, so this is read as
         proof of being offline and never as proof of being online. */
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
      doorsTried: this.failedOrigins.size,
      doorsRefused: this.refusedOrigins.size,
    };
  }

  private patch(p: Partial<PlayerSnapshot>): void {
    /* Every error leaves with the trail that led to it, and lands in the debug
       log — one place, so no error path can forget to say why. */
    if (p.phase === 'error' && p.error) {
      const error = { ...p.error, trail: this.trail.slice(), facts: this.facts() };
      p = { ...p, error };
      dlog.error('player', `${error.message}${error.hint ? ` — ${error.hint}` : ''}`);
    }
    const v = this.video;
    const derived: Partial<PlayerSnapshot> = this.nativeOwned
      ? {
          // The element is empty while a surface owns the picture, so its
          // currentTime is 0 and would read as "stuck at the start".
          currentTime: this.nativeTime,
          duration: this.assumedDuration,
          /* A film draws only what libVLC holds — see `nativeBufferedEnd`. Live
             keeps the old value: its delay bar reads `buffered` as a window and
             libVLC cannot offer one, so nothing there may start drawing. */
          buffered: this.snap.live
            ? this.assumedDuration
            : nativeBufferedEnd(this.nativeTime, this.assumedDuration),
          bufferStart: 0,
        }
      : v
      ? (() => {
          const win = liveHoldWindow(v);
          return {
            /*
              Where the playhead is, in the film.

              `pendingSeek` is the target of a burst still settling, so every
              press visibly moves the bar even though no engine has been asked
              yet.
            */
            currentTime: this.pendingSeek ?? v.currentTime,
            /* The element's own duration wins when it has one; the caller's
               stated length is the fallback, not an override. */
            duration: Number.isFinite(v.duration) ? v.duration : this.assumedDuration,
            buffered: win?.end ?? 0,
            bufferStart: win?.start ?? 0,
            /* Every piece held, for the bar to draw — and there is more than one
               only where this page is taking the film apart itself. */
            heldSpans: this.deviceFilm !== null ? spansOf(v.buffered) : [],
          };
        })()
      : {};
    this.snap = { ...this.snap, ...derived, ...p };
    /* Any load that reaches `playing` has delivered, whichever path got it
       there — `markSteady` alone misses a recovery reload of a stream that had
       already played once. See the watchdog armed in `load`. */
    if (this.snap.phase === 'playing') this.playedEpoch = this.epoch;
    this.noteFilmPosition();
    for (const fn of this.listeners) fn(this.snap);
  }

  /**
   * The last line of defence against a retry loop: no stream is opened more
   * than `MAX_OPENS` times in `OPEN_WINDOW_MS`, whoever is asking.
   *
   * Every loop found so far had its own local budget, and each budget was
   * sound on its own terms — and still the TV emulator logged 114 failed opens
   * of one film in about two and a half minutes, because the budgets reset each
   * other: the screen's retry counted per load while every retry was a new
   * load. A cap that
   * counts opens of the same stream, whichever path asks, does not care which
   * loop is at fault. On a one-connection subscription that matters more than
   * anything else here: a flood of opens is what gets the whole account locked
   * out (456), and staying locked out is what the flood then guarantees.
   *
   * Ten, because the honest ladder for a film that will not start — the
   * WebView, libVLC, libVLC in software, the other doors, plain http — is about
   * eight. Stopping is `permanent`, so the screen's own retry stands down too;
   * the viewer's Retry works again once the window has moved on.
   */
  private opens: { key: string; at: number[] } = { key: '', at: [] };

  private mayOpen(key: string, label: string, live: boolean): boolean {
    const verdict = admitOpen(this.opens, key, Date.now());
    if (!verdict.ok) {
      this.note(`stopped: ${verdict.count} opens of this stream in ${OPEN_WINDOW_MS / 1000}s`, 'error');
      /* `load` armed the open watchdog before it got here; left running it
         would fire, try a door, and ask to open the very stream just stopped. */
      window.clearTimeout(this.openWatch);
      window.clearTimeout(this.recoverTimer);
      this.patch({
        phase: 'error', label, live, streamKey: key, recovering: 0, permanent: true,
        error: {
          message: 'This kept failing to open, so the app stopped trying',
          hint: 'Trying again and again can lock a one-connection account out '
              + 'for several minutes. Wait a minute, then press Retry — or pick '
              + 'something else and come back to it.',
        },
      });
      return false;
    }
    this.opens = verdict.state;
    return true;
  }

  /** Remember the playhead while it is trustworthy — see `filmAt`. */
  private noteFilmPosition(): void {
    const key = this.last?.key;
    if (key === undefined || this.snap.live) return;
    const { phase, currentTime } = this.snap;
    /* Only a playhead that is really playing or really paused. `loading` and
       `error` read zero during a teardown, and zero is the one value that must
       never overwrite a real position. */
    if ((phase === 'playing' || phase === 'paused') && currentTime > 0) {
      this.filmAt = { key, at: currentTime };
    }
  }

  /**
   * Where a reload of THIS stream should begin.
   *
   * The last position that was really playing, or where this load was asked to
   * start if it never got that far (a resumed episode that stalled while
   * opening). Zero for a channel, and zero for a different stream.
   */
  private resumePoint(key: string, live: boolean): number {
    if (live) return 0;
    if (this.filmAt.key === key && this.filmAt.at > 0) return this.filmAt.at;
    return this.last?.key === key ? this.startedAt : 0;
  }

  /**
   * Stats need a steady tick; media events alone are too sparse.
   *
   * A timer, not a frame loop. This was `requestAnimationFrame` — a callback on
   * every frame, sixty a second, to do something every five hundred
   * milliseconds — and nothing ever cancelled it, so after the first thing was
   * played the page asked for a frame on every vsync for the rest of its life.
   * On a television that keeps the whole graphics pipeline awake beside the
   * picture it is meant to be protecting.
   *
   * And a report only when something in it moved. On the libVLC path the
   * `<video>` element is empty — no size, no level, no dropped frames — so the
   * same stats were published twice a second, and every one re-rendered the
   * player and the screen around it.
   */
  private pump(): void {
    window.clearInterval(this.pumpTimer);
    let lastRate = 0;
    this.pumpTimer = window.setInterval(() => {
      const t = performance.now();
      const v = this.video;
      const hls = this.hls;
      if (!v || (this.snap.phase !== 'playing' && this.snap.phase !== 'paused')) return;
      const lag = this.liveLag();
      if (t - lastRate > 900) {
        lastRate = t;
        this.driveEdgeChase(lag);
      }
      const lvl = hls && hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : undefined;
      const q = v.getVideoPlaybackQuality?.();
      if (this.soundless) this.drainRefusedAudio();
      /* Before the stats, because a stream with no picture should not be
         described for another half second before anything is done about it. */
      this.watchPicture(v, q);
      const stats: PlayerSnapshot['stats'] = {
        resolution: v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : null,
        bitrateKbps: lvl?.bitrate ? Math.round(lvl.bitrate / 1000) : null,
        droppedFrames: q ? q.droppedVideoFrames : 0,
        latencyS: hls?.latency && Number.isFinite(hls.latency) ? hls.latency : null,
        lagS: lag,
        stalls: this.stalls,
        codec: lvl?.videoCodec ?? lvl?.codecSet ?? null,
      };
      if (v.playbackRate === this.snap.rate && sameStats(stats, this.snap.stats)) return;
      this.patch({ rate: v.playbackRate, stats });
    }, 500);
  }

  /**
   * Sound, but no picture — the failure that raises no error.
   *
   * Every other escalation in this file is triggered by something going wrong
   * loudly: `video.error`, hls.js's MEDIA_ERROR, mpegts.js refusing to add a
   * source buffer. A video track the platform silently drops raises none of
   * those. The element fires `loadedmetadata`, fires `playing`, advances
   * `currentTime` and produces audio — and the screen stays black. There is no
   * event for it, which is why an `onError`-based fallback could never have
   * fired, and why the report from the living room was "now I hear music but no
   * video in movies" rather than an error code.
   *
   * The evidence is the frame counter. `totalVideoFrames` counts frames the
   * decoder produced, so zero of them against advancing media time is the fact
   * itself rather than an inference from it. `videoWidth` is the fallback for a
   * WebView old enough to lack `getVideoPlaybackQuality`.
   *
   * ── the three guards, and what each one is for ───────────────────────────
   *
   * A native engine, or nothing to do. libVLC decodes HEVC, and this is only
   * worth acting on where there is somewhere to send the stream. On the web
   * there is not: HLS and raw TS reach the same decoders, so the only honest
   * outcome would be an error box over playing audio, and a viewer who can hear
   * the film is better served by the sound than by a red box.
   *
   * A stream that is SUPPOSED to have a picture. On demand always is — a film
   * with no video track is not a thing this catalogue contains. Live is not:
   * there are radio channels, and escalating one of those would pin a working
   * station to the native surface for ever. So live needs positive evidence
   * from the demuxer, which `hasVideoTrack` carries.
   *
   * Advancing media time. The deadline is spent in `currentTime`, so a stall
   * spends none of it.
   */
  private watchPicture(v: HTMLVideoElement, q: VideoPlaybackQuality | undefined): void {
    /* The surface owns the picture and the element is deliberately empty — every
       reading below would be zero and every one of them would be a lie. */
    if (this.nativeOwned !== null) return;
    if (this.snap.phase !== 'playing' || v.paused) { this.blindFrom = 0; return; }
    if (this.snap.live && this.hasVideoTrack !== true) return;

    const frames = q === undefined ? (v.videoWidth > 0 ? 1 : 0) : q.totalVideoFrames;
    if (frames > 0) {
      this.blindFrom = 0;
      /*
       * A picture that STARTED and then stopped — see `frames`/`watchFrozen`.
       *
       * Deliberately BEFORE the `hasNativeEngine()` gate below, and that is the
       * whole point of moving it. The never-starts case only has somewhere to go
       * when libVLC exists, so it declines to speak where it cannot act. The
       * STOPS case is different: it is the one seen on a
       * television — ten or fifteen seconds of picture, then black with the
       * sound still playing — and a customer's own debug report from
       * an Android 14 set reads `Native engine: none — WebView only`, so on the
       * devices where this is happening the gate was switching the watchdog off
       * entirely. There is still something to do without libVLC: a live channel
       * can be re-opened over HLS (`escalate`), and failing that, saying so
       * beats a black rectangle playing music.
       *
       * Only with a real counter: the `videoWidth` fallback answers 1 for ever
       * and could never tell a frozen decoder from a working one.
       */
      if (q !== undefined) this.watchFrozen(frames, v.currentTime);
      return;
    }

    /* The never-starts case, which needs somewhere to send the stream. */
    if (this.blindReported || !hasNativeEngine()) return;

    const t = v.currentTime;
    if (this.blindFrom === 0 || t < this.blindFrom) { this.blindFrom = t; return; }
    if (t - this.blindFrom < BLIND_MEDIA_S) return;

    this.blindReported = true;
    this.blindFrom = 0;
    const reason = `${BLIND_MEDIA_S}s of audio with no decoded frame — no video decoder here`;
    this.note(reason, 'warn');
    if (this.escalate(reason)) return;
    /* Nothing left to hand it to: this stream has already used its one
       escalation, which means libVLC has had it too. Say what is wrong rather
       than leaving a black rectangle playing music. */
    this.patch({
      phase: 'error',
      error: {
        message: 'this stream plays sound but produces no picture',
        hint: 'The audio decoded and the video did not — normally HEVC (H.265) video, '
            + 'which many devices refuse. Nothing here has a decoder for it.',
      },
    });
  }

  /**
   * The picture stopped while everything else kept going.
   *
   * Both engines end up here, with whatever each one can count — the WebView's
   * `totalVideoFrames`, libVLC's `displayedPictures` — and one rule over both:
   * a counter that has not moved for `FROZEN_MEDIA_S` of ADVANCING media time is
   * a decoder that has stopped. Nothing else reports this. libVLC stays
   * `Playing`, the element stays `playing`, the clock advances and the audio
   * comes out; the only thing missing is the picture, which is exactly what was
   * reported from the sofa: "some videos just play for a few 2nd and then goes
   * black and only audio comes".
   *
   * What to do about it, in order:
   *
   *   software has not been tried   the usual suspect is MediaCodec choking on a
   *                                 profile it advertised and cannot sustain, so
   *                                 the same stream is reopened on the CPU. This
   *                                 is the same ladder `nativeRefused` climbs for
   *                                 a stream that fails loudly.
   *   a WebView picture, natively   hand it to libVLC, which is what `escalate`
   *     playable                    is for.
   *   nothing left                  say so, rather than leaving a black
   *                                 rectangle playing music.
   *
   * Once per load either way (`freezeHandled`): a retry loop on a line with one
   * connection is worse than the freeze.
   */
  private watchFrozen(count: number, mediaTime: number): void {
    if (this.freezeHandled) return;
    const { verdict, next } = judgeFrozen(this.frames, count, mediaTime, FROZEN_MEDIA_S);
    this.frames = next;
    if (verdict !== 'frozen') return;

    this.freezeHandled = true;
    const reason = `${FROZEN_MEDIA_S}s of sound with a frozen picture`;
    this.note(reason, 'warn');

    const spec = this.last;
    /*
     * The ladder, and the order of it is the whole safety of this watchdog.
     *
     * It used to force SOFTWARE decoding first, whatever engine had frozen —
     * which on a WebView freeze hauled a stream onto libVLC with
     * `avcodec-hw=none`, and a television cannot sustain 1080p on its CPU. So
     * the retry all but guaranteed a second freeze, and the second freeze is
     * what paints the black card. The rung that fits the failure now goes first:
     *
     *   the WebView froze    hand it to libVLC with its hardware decoder, which
     *                        is what `escalate` is for and what this box is for.
     *   libVLC froze         now software is the honest next thing to try.
     *   both have failed     stop, and say so. Deliberately a STOP: an error
     *                        card over a stream still making sound is the
     *                        incoherent state this was meant to remove, not
     *                        another way of reaching it.
     */
    if (this.nativeOwned === null && this.escalate(reason)) return;

    if (spec !== null && this.nativeOwned !== null && !this.triedSoftware && hasNativeEngine()) {
      this.triedSoftware = true;
      this.softwareOnce = true;
      this.forceNative = true;
      this.note('the decoder stopped — trying again in software', 'warn');
      this.teardown();
      this.patch({ phase: 'loading', recovering: 0, error: null });
      const again = this.epoch;
      this.recoverTimer = window.setTimeout(() => {
        if (this.epoch !== again) return;
        void this.load(spec.target, spec.label,
          { live: spec.live, key: spec.key, startAt: this.resumePoint(spec.key, spec.live) });
      }, 250);
      return;
    }

    this.teardown();
    this.patch({
      phase: 'error',
      error: {
        message: 'the picture stopped and the sound carried on',
        hint: 'The video decoder gave up part-way through — usually a stream this '
            + 'box can start but not sustain. Another quality, or another device, '
            + 'will normally play it.',
      },
    });
  }

  /**
   * A picture this engine plays, with sound it refused. Decide what to do.
   *
   * The rule itself is `judgeSound` in lib/audioRefusal.ts, pure and tested, with
   * the measurement it was chosen from. This gathers its inputs — MEDIA_INFO,
   * the refused SourceBuffer types, the element's counters — and acts:
   *
   *   soundless, native engine here   `escalate`, once, exactly as a refused
   *                                   picture is: teardown before libVLC opens
   *                                   the line's one connection, and the channel
   *                                   learned for libVLC only once it plays.
   *   soundless, nowhere to send it   keep the picture and say why there is no
   *                                   sound, in `notice` — not in `error`, which
   *                                   would cover a picture that is playing. And
   *                                   never `onNeedCompatible`: HLS loses the same
   *                                   track silently, thirty seconds behind live.
   *   unplayable                      no picture to keep: the ordinary refusal.
   *   wait                            MEDIA_INFO is not in yet — one re-check.
   *
   * Returns what it did, so the late re-check can tell whether a stream that
   * never announced itself is now playing.
   */
  private checkSound(mine: number): 'fine' | 'wait' | 'escalated' | 'kept' | 'refused' {
    if (this.epoch !== mine || this.tsRefused) return 'fine';
    const refusal = this.soundRefusal;
    if (refusal === null || this.soundJudged) return 'fine';
    const v = this.video;
    const q = v?.getVideoPlaybackQuality?.();
    const counted = (v as (HTMLVideoElement & { webkitAudioDecodedByteCount?: unknown }) | null)
      ?.webkitAudioDecodedByteCount;
    const verdict = judgeSound({
      declared: this.declared,
      refused: this.refusedTypes,
      videoFrames: q !== undefined ? q.totalVideoFrames : (v !== null && v.videoWidth > 0 ? 1 : 0),
      audioBytes: typeof counted === 'number' ? counted : null,
      sinceRefusalMs: performance.now() - refusal.at,
    });
    if (verdict.kind === 'fine') return 'fine';
    if (verdict.kind === 'wait') {
      if (this.soundWatch === 0) {
        const left = Math.max(0, DECLARE_GRACE_MS - (performance.now() - refusal.at));
        this.soundWatch = window.setTimeout(() => {
          this.soundWatch = 0;
          if (this.checkSound(mine) !== 'kept' || this.epoch !== mine) return;
          /* Kept on the frame counter alone — MEDIA_INFO never came, so nothing
             else is going to say this stream is playing. */
          if (this.snap.phase === 'loading') {
            this.note('playing via mpegts (no media info)');
            this.markSteady();
            this.patch({ phase: 'playing', transport: 'mpegts', recovering: 0 });
          }
        }, left + 50);
      }
      return 'wait';
    }
    this.soundJudged = true;
    window.clearTimeout(this.soundWatch);
    this.soundWatch = 0;
    if (verdict.kind === 'unplayable') {
      this.tsUndecodable(refusal.type, refusal.text, refusal.why);
      return 'refused';
    }
    const name = verdict.spec?.label ?? verdict.codec;
    const reason = `${name} audio refused by the browser engine — the picture plays without sound`;
    if (hasNativeEngine() && this.escalate(reason)) return 'escalated';
    this.soundless = true;
    this.note(`kept without sound: ${name} — nothing else here can play it`, 'warn');
    this.patch({
      notice: {
        kind: 'noSound',
        codec: verdict.codec,
        message: noSoundMessage(verdict.codec, verdict.spec, isNativeShell() ? 'app' : 'web'),
      },
    });
    return 'kept';
  }

  /**
   * The demuxer's decoder refused the stream: escalate, or say so.
   *
   * Lifted out of the mpegts.js ERROR handler unchanged, because `checkSound`
   * ends here too when a refused sound track turns out to have no picture
   * beside it.
   */
  private tsUndecodable(type: string, text: string, why: string): void {
    /* A codec or MIME complaint from the demuxer is the exact case libVLC is
       carried for. Escalate before showing anything: the error text below is
       a dead end on a device that has the decoder in MediaCodec. */
    if (this.escalate(`${type}: ${text}${why === '' ? '' : ` — ${why}`}`)) return;
    /* Nothing else is coming from this demuxer. Say so, and make sure a late
       MEDIA_INFO cannot paint "playing" over it — see `tsRefused`. */
    this.tsRefused = true;
    this.patch({
      phase: 'error',
      error: {
        message: `${type}: ${text}`,
        hint: `The browser cannot decode this stream${why === '' ? '' : ` (${why})`}. `
          + 'Switch this channel to the Compatible (HLS) transport in the player settings.',
      },
    });
  }

  /**
   * Throw away the audio mpegts.js can never play, while the picture plays on.
   *
   * mpegts.js keeps each remuxed segment in `_pendingSegments[type]` until that
   * type has a SourceBuffer to append to — and a refused type never gets one, so
   * nothing drains it. Measured on the AC-3 channel: 30 segments / 1,016 KB
   * queued 2.3s in, 35 / 1,525 KB at 11.3s, following the 5.1 stream at about
   * 56 KB a second — some 200 MB an hour of sound nobody can hear, held in the
   * page of a television. mpegts.js offers no way to drop a track, so this
   * reaches into its internals, defensively: if the shape is not there (another
   * version), nothing happens and the picture is unaffected.
   */
  private drainRefusedAudio(): void {
    try {
      const pending = (this.ts as unknown as {
        _player_engine?: { _mse_controller?: { _pendingSegments?: { audio?: unknown } } };
      } | null)?._player_engine?._mse_controller?._pendingSegments?.audio;
      if (Array.isArray(pending) && pending.length > 0) pending.splice(0, pending.length);
    } catch {
      /* internals moved — leave them alone */
    }
  }

  /** Seconds between the playhead and the newest frame we hold. */
  private liveLag(): number | null {
    const v = this.video;
    if (!v || !this.snap.live) return null;
    const win = liveHoldWindow(v);
    if (!win) return null;
    const lag = win.end - v.currentTime;
    return Number.isFinite(lag) && lag >= 0 ? lag : null;
  }

  /**
   * Close a live gap by playing slightly faster.
   *
   * The alternative — jumping the playhead forward — is what "keeping up with
   * live" used to mean here, and it is why the picture skipped and the dropped
   * frame counter climbed. A 4-8% speed-up is inaudible, shows every frame, and
   * settles back to 1.0x as soon as the gap is closed.
   *
   * On the HLS path hls.js does the same thing internally via
   * `maxLiveSyncPlaybackRate`, so this only drives the MPEG-TS path.
   */
  private driveEdgeChase(lag: number | null): void {
    const v = this.video;
    if (!v) return;
    if (!this.snap.live || this.snap.transport !== 'mpegts') {
      // On-demand playback honours the speed the user picked, nothing else.
      const want = this.snap.live ? 1 : this.snap.userRate;
      if (Math.abs(v.playbackRate - want) > 0.001) v.playbackRate = want;
      return;
    }
    const prof = resolveBufferProfile(this.last?.key);
    if (!this.snap.chaseLiveEdge || prof.maxRate <= 1 || lag === null || v.paused) {
      if (v.playbackRate !== 1) v.playbackRate = 1;
      return;
    }
    const excess = lag - (prof.targetLag + this.lagSlack);
    if (excess <= 0.25) {
      // Hysteresis: settle only once genuinely at target, so the rate does not
      // oscillate audibly around the threshold.
      if (v.playbackRate !== 1) v.playbackRate = 1;
      return;
    }
    // Ramp with the size of the gap: a 1s gap barely nudges, a 10s gap uses the
    // full allowance and still closes gently.
    const rate = Math.min(prof.maxRate, 1 + excess / 25);
    if (Math.abs(v.playbackRate - rate) > 0.004) v.playbackRate = rate;
  }

  /**
   * Hand a stream the WebView could not decode to the native engine.
   *
   * This is the piece that was missing, and it is why the APK behaved exactly
   * like the website: libVLC was only ever chosen from what was known BEFORE
   * pressing play — a hostile file extension, or a codec string the capability
   * report had already condemned. A live channel publishes no codec, so the
   * answer was always the WebView, and the WebView's decoder gaps are the whole
   * reason libVLC is in the APK.
   *
   * Returns false when there is nothing to escalate to, so the caller shows its
   * own error instead of a spinner that never resolves.
   */
  private escalate(reason: string): boolean {
    const last = this.last;
    if (!last) return false;
    if (!hasNativeEngine()) {
      /*
       * No native engine — the web build, or an APK without the plugin. There is
       * still one thing left to try on a live channel: the same stream over HLS,
       * which is remuxed by the panel rather than demuxed here, and therefore the
       * one path that survives a container the browser will not parse. That is
       * what `auto` is: this decision, made once per channel and remembered.
       */
      if (last.live && this.onNeedCompatible !== null) {
        const key = last.key;
        if (this.escalated === key) { this.note('escalation already used for this stream', 'warn'); return false; }
        /**
         * Only claim the escalation if the route actually took it.
         *
         * The handler declines when the transport is pinned to an explicit
         * choice, or when it has no current channel. Returning true regardless
         * told the caller "handled" and it returned without setting an error —
         * leaving the phase on `loading` with nothing on its way. That is the
         * spinner that never resolves.
         */
        this.escalated = key;
        this.note(`escalate → compatible transport: ${reason}`, 'warn');
        this.patch({ phase: 'loading', recovering: 0, error: null });
        if (this.onNeedCompatible(reason)) return true;
        this.escalated = '';
        return false;
      }
      return false;
    }
    const key = last.key;
    if (this.escalated === key) { this.note('escalation already used for this stream', 'warn'); return false; }
    this.escalated = key;
    this.forceNative = true;
    this.note(`escalate → native: ${reason}`, 'warn');
    // Keep the position and the known length across the switch: escalating in the
    // middle of a recording must not send the viewer back to its start. Read
    // from `filmAt`, not the snapshot: an escalation mid-stall happens while
    // the phase is `loading`, and that used to mean "start again from zero".
    const startAt = this.resumePoint(last.key, last.live);
    this.patch({ phase: 'loading', recovering: 0, error: null });
    void this.load(last.target, last.label, {
      live: last.live,
      key: last.key,
      startAt,
      ...(this.assumedDuration > 0 ? { durationS: this.assumedDuration } : {}),
    }).catch(() => {
      this.patch({ phase: 'error', error: { message: reason, hint: 'The native engine could not be started.' } });
    });
    return true;
  }

  /**
   * Run one teardown step, and never let it take the rest of teardown with it.
   *
   * This is the whole lesson of the "old stream keeps playing" bug. The four
   * mpegts.js calls below used to share a single try/catch, so a throw from
   * `pause()` — which it does when the element was already detached, or when the
   * player is still mid-load — skipped `unload`, `detachMediaElement` and
   * `destroy`. The handle was then set to null anyway, which left a player that
   * was still feeding the source buffer and still holding the panel's one allowed
   * connection, with nothing left in the app able to reach it.
   */
  private step(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[player] teardown step "${what}" threw; continuing`, err);
    }
  }

  teardown(): void {
    this.epoch++;
    /* A burst still settling belongs to the stream going away. The epoch check
       in `commitSeek` already makes it a no-op; clearing it as well keeps the
       next stream's playhead from showing the old film's target for 350ms. */
    window.clearTimeout(this.seekTimer);
    this.pendingSeek = null;
    if (this.nativeOwned) {
      const owned = this.nativeOwned;
      // Cleared first: a stop() that rejects must not leave the handle installed,
      // and nothing may route a control at an engine we have given up on.
      this.nativeOwned = null;
      this.nativeTime = 0;
      this.nativeSeek = null;
      /* And it must close again: a hole left open is a transparent window in
         the middle of the app. */
      this.patch({ surface: false });
      this.step('native stop', () => {
        void owned.stop().catch(() => { /* already gone */ });
      });
    }
    window.clearTimeout(this.recoverTimer);
    window.clearTimeout(this.nativeWatch);
    window.clearTimeout(this.openWatch);
    if (this.hls) {
      const hls = this.hls;
      this.hls = null;
      // destroy() aborts in-flight segment requests, which is what lets the
      // panel release the single allowed connection.
      this.step('hls destroy', () => hls.destroy());
    }
    this.tsRefused = false;
    if (this.ts) {
      const ts = this.ts;
      this.ts = null;
      // Order matters: unload() closes the long-lived TS request, and without it
      // the panel keeps counting the session against max_connections. Each call
      // is isolated so a throw in an earlier one cannot skip a later one.
      this.step('ts pause', () => ts.pause());
      this.step('ts unload', () => ts.unload());
      this.step('ts detach', () => ts.detachMediaElement());
      this.step('ts destroy', () => ts.destroy());
    }
    this.step('clear subs', () => this.clearExternalSubs());
    /* The film's buffer belongs to the film. Closing it drops the fetch — which
       is what releases the panel's one allowed connection — and lets go of the
       Media Source, which is a few hundred megabytes if it is not let go of. */
    if (this.deviceFilm !== null) {
      const film = this.deviceFilm;
      this.deviceFilm = null;
      film.close();
    }
    if (this.devicePreview !== null) {
      const preview = this.devicePreview;
      this.devicePreview = null;
      preview.close();
    }
    this.snap = { ...this.snap, heldSpans: [], frameAt: null };
    const v = this.video;
    if (v) {
      // Each isolated: whatever throws, the element must still end up silent.
      this.step('pause', () => v.pause());
      this.step('reset rate', () => { v.playbackRate = 1; });
      this.step('drop src', () => v.removeAttribute('src'));
      this.step('reload', () => v.load());
    }
    this.stalls = 0;
    /* The picture watchdog belongs to the stream that is going away. Not
       resetting `blindReported` would mean the next stream is never checked, and
       not resetting `hasVideoTrack` would carry one channel's answer onto the
       next one — which for a radio station following a television channel is
       exactly the wrong way round. */
    this.blindFrom = 0;
    this.blindReported = false;
    this.hasVideoTrack = null;
    /* And the sound: one channel's refused AC-3 says nothing about the next. */
    window.clearTimeout(this.soundWatch);
    this.soundWatch = 0;
    this.declared = null;
    this.refusedTypes = [];
    this.soundRefusal = null;
    this.soundJudged = false;
    this.soundless = false;
    /* A door that was being tried belongs to the stream being torn down; it must
       not be adopted by whatever plays next. */
    this.pendingBase = null;
    this.snap = {
      ...EMPTY,
      volume: this.snap.volume, muted: this.snap.muted, aspect: this.snap.aspect,
      userRate: this.snap.userRate, chaseLiveEdge: this.snap.chaseLiveEdge,
      recovering: this.snap.recovering,
      loadId: this.epoch,
    };
    for (const fn of this.listeners) fn(this.snap);
  }

  /**
   * Report a failure that happened OUTSIDE the engine.
   *
   * Resolving a stream takes two API calls before there is anything to hand an
   * engine, and when one of those fails the core never hears about it. Without a
   * way to say so, the route's only options were an unhandled rejection or a
   * spinner — which is how "it just does nothing" happened. Teardown first,
   * because whatever was playing before is no longer what the UI is describing.
   */
  /** A failure that will still be a failure in twenty seconds. */
  private failFinal(message: string, hint: string): void {
    this.patch({ phase: 'error', recovering: 0, permanent: true, error: { message, hint } });
  }

  fail(message: string, hint: string): void {
    this.teardown();
    this.last = null;
    this.attempts = 0;
    this.patch({ phase: 'error', recovering: 0, permanent: false, error: { message, hint } });
  }

  /**
   * "We are opening this" — said before there is a URL to open.
   *
   * Resolving a stream is two API calls to the panel, and until this existed the
   * player sat in `idle` for the whole round trip with a routes-facing placeholder
   * on screen reading "select something to play". The viewer had just pressed PLAY
   * on a specific film; being told to select something is both wrong and rude, and
   * on a slow panel it was the first second of every single playback.
   *
   * So the route announces the title first and the phase is `loading` from the
   * frame the player mounts. A `load()` or a `fail()` replaces it; nothing else
   * can, because `teardown()` is what precedes this call rather than following it.
   */
  opening(label: string, live = false): void {
    /* Teardown already ran; drop `last` so a stale recover cannot resurrect the
       previous channel while variants/play resolve for this one. */
    this.last = null;
    this.trail = [];
    this.note(`opening ${label}`);
    this.patch({ phase: 'loading', label, live, error: null, recovering: 0 });
  }

  /**
   * Should this page take the film apart itself?
   *
   * Two reasons, and the second is the one that surprises people. A container
   * no browser demuxes, or sound none decodes. And a line that allows ONE stream, whatever the file is: there
   * the `<video>` element cannot be given the URL at all, because it opens a
   * new connection for every seek while the last one is still being let go of,
   * and the panel answers 509.
   *
   * Never for live — a channel is one continuous read that is never seeked,
   * which is the case the element is good at — and never where a native engine
   * owns the picture, since libVLC has been demuxing all of this on the device
   * since long before this existed.
   */
  private wantsDeviceFilm(target: { url: string; container: string }, live: boolean): boolean {
    if (live || this.nativeOwned !== null || hasNativeEngine()) return false;
    if (!deviceFilmPossible()) return false;
    return webHasNoPathFor(target.url) || oneConnectionLine()
      /*
       * And every Matroska. Chrome does open one on its own — but the element
       * then shows the FIRST soundtrack and none of the subtitles, and cannot be
       * asked for another: `audioTracks` is behind a flag and in-band Matroska
       * text tracks are never exposed. "This is a dual language film but I don't
       * see any language changers". Taken apart here, both are in the menus
       * (see `onTracks`), and an AC-3 or DTS soundtrack plays instead of being
       * silence. An MP4 still goes to the element, which reads it best.
       */
      || /\.mkv(?:\?|$)/i.test(target.url);
  }

  async load(
    /* `codec` is what the PANEL said is inside this file, when it said anything —
       `chooseEngine` reads it to send an `.mp4` carrying HEVC or AC-3 straight to
       libVLC instead of letting the WebView find out by playing half of it. Never
       measured from the stream itself; see `PlaybackTarget` in lib/api.ts. */
    target: LoadTarget,
    label: string,
    opts?: {
      live?: boolean;
      startAt?: number;
      /**
       * Known length, for a stream that cannot declare one.
       *
       * MPEG-TS has no duration field, so a catch-up recording arrives over MSE
       * with `video.duration === Infinity` — which leaves the seek bar with
       * nothing to scale against even though the recording is a known 52 minutes
       * long. The archive endpoint knows exactly how many minutes it asked the
       * panel for, so it says so.
       */
      durationS?: number;
      /**
       * Stable identity for this stream — pass `linkId(item)`.
       *
       * Used for the escalation guard and the learned-engine list, both of which
       * are per-stream decisions. Omitting it falls back to a key derived from the
       * URL, which only distinguishes streams within a session.
       */
      key?: string;
    },
  ): Promise<void> {
    const v = this.video;
    if (!v) return;
    logInfo('Playback started', { label, live: opts?.live ?? target.container === 'hls', key: opts?.key ?? 'unknown' });
    /*
     * Channel open already called `teardown()` so the panel releases the previous
     * connection while the next URL is resolved. Running it again here reset the
     * media element (`video.load()`) and wiped the "opening…" phase — a visible
     * hitch on every zap. Only tear down when something is still armed.
     *
     * Progressive `<video>` counts as armed too: `escalate()` from the picture
     * watchdog (sound, no frames) fires while the element is still playing, and
     * without this the mp4 keeps the panel's only connection — and keeps making
     * sound — under the native surface that is about to open the same URL.
     */
    if (
      this.hls !== null
      || this.ts !== null
      || this.nativeOwned !== null
      || (this.video !== null && this.video.currentSrc !== '')
    ) {
      this.teardown();
    } else {
      window.clearTimeout(this.recoverTimer);
    }
    // The API returns same-origin RELATIVE urls. hls.js resolves those itself, but
    // mpegts.js parses the string as an absolute URL and throws a bare
    // "NetworkError: Exception" if it is not one. Resolve up front for both.
    //
    // Through apiUrl(), because in a wrapped build the document's origin is
    // file:// or capacitor://localhost and resolving against it would point the
    // engine at a stream path that nothing serves.
    /*
     * Ask the native engine first, on the platforms and streams where it is the
     * only thing that can play at all.
     *
     * Strictly additive: `tryNative` resolves to null for the web build, for an
     * APK without the plugin, and for anything the WebView handles — and it
     * swallows its own failures, so the WebView path below is still the answer to
     * everything it declines. That is deliberate. A native engine that cannot be
     * debugged from here must not be able to take the whole app's playback down.
     */
    const known = apiUrl(target.url);
    const absolute =
      /^[a-z][a-z0-9+.-]*:/i.test(known) || typeof location === 'undefined'
        ? known
        : new URL(known, location.href).toString();
    target = { ...target, url: absolute };
    const mine = ++this.epoch;
    /* Armed for every load and disarmed by the first byte (`markSteady`), so a
       door that never answers is abandoned rather than waited out. See
       `openStalled` — it declines to act unless there is somewhere to go. */
    window.clearTimeout(this.openWatch);
    this.openWatch = window.setTimeout(() => this.openStalled(mine), OPEN_WAIT_MS);
    const live = opts?.live ?? target.container === 'hls';
    const startAt = !live && opts?.startAt && opts.startAt > 0 ? opts.startAt : 0;
    /* A film that never opened has a playhead of zero and a resume position
       that is not — see `resumePoint`. */
    this.startedAt = startAt;
    this.assumedDuration = !live && opts?.durationS && opts?.durationS > 0 ? opts.durationS : 0;
    // A different stream is a fresh start; a retry of the same one keeps its budget.
    const key = opts?.key ?? streamKey(target.url);
    if (!this.mayOpen(key, label, live)) return;
    if (this.epoch !== mine) return;
    if (this.lineKey !== key) {
      this.failedOrigins.clear();
      this.refusedOrigins.clear();
      this.lineKey = key;
      this.everPlayed = false;
      this.attempts = 0;
      /* A new stream, a new story — keeping only the "opening" line said just before. */
      this.trail = this.trail.filter((t) => t.startsWith('opening ')).slice(-1);
    } else if (this.last?.target.url !== target.url) {
      this.attempts = 0;
    }
    try { this.failedOrigins.add(new URL(target.url).origin); } catch { /* relative */ }
    /*
     * A file no browser can open: say so now, not after eight megabytes.
     *
     * Photographed from a movie playing on the web: thirty-seven
     * requests, 8.2 MB transferred in ranged chunks, and then "Playback failed"
     * with a RETRY button. Where the container really is hopeless, every one of
     * those bytes is spent discovering something the extension said before the
     * first one.
     *
     * `webHasNoPathFor`, NOT `browserCannotDemux` — and the difference between
     * those two is a website that works and one that does not. The first version
     * of this asked the second question, which is the APK's "prefer libVLC for
     * this" list and includes MKV and TS: most of the catalogue, all of it
     * playable on the web. "on the web version nothing plays anymore now." The
     * list that belongs here is only the containers with no route at all.
     *
     * Only where there is nothing else to try. In the APK this never runs:
     * `chooseEngine` sends these to libVLC, which is what it is for, and the
     * platform is checked rather than `hasNativeEngine()` so a plugin probe that
     * has not answered yet cannot make the app refuse a file it can play.
     */
    if (
      (import.meta.env?.VITE_PLATFORM as string | undefined) !== 'capacitor'
      && webHasNoPathFor(target.url)
    ) {
      const ext = (/\.([a-z0-9]{2,4})(?:\?|$)/i.exec(target.url)?.[1] ?? '').toUpperCase();
      this.note(`${ext || 'this container'} cannot be played by a browser`, 'warn');
      this.patch({
        phase: 'error',
        label,
        live,
        error: {
          message: `A browser cannot play ${ext === '' ? 'this file' : `an ${ext} file`}`,
          hint: 'Matroska, AVI and friends have no demuxer in any browser. '
              + 'The television app plays these '
              + 'with its built-in engine; open the title there, or ask the '
              + 'provider for an MP4 version.',
        },
      });
      return;
    }

    /*
     * iPhone and iPad: a container WebKit has no demuxer for is refused up front
     * and in plain words, rather than as a decoder error a second later.
     *
     * There is no libVLC on iOS (the plugin is Android Java) and the device-side
     * remuxer is not shipped in a packaged build — its 21MB of WebAssembly is
     * dropped on purpose — so for MKV, AVI and the like there is no road at all.
     * MP4, M4V and MOV go to the element, which is what iOS plays best.
     */
    if (isIos() && !live && iosCannotOpenFile(target.url)) {
      this.note('this container cannot be opened by iOS', 'warn');
      this.patch({ phase: 'error', label, live, error: { ...IOS_CANNOT_PLAY.container } });
      return;
    }

    /* Verbatim, so `reopen()` can re-issue what was actually asked for. */
    this.asked = {
      url: target.url, container: target.container, codec: target.codec ?? null,
      label, live, key,
      ...(target.headers === undefined ? {} : { headers: target.headers }),
      ...(target.reresolve === undefined ? {} : { reresolve: target.reresolve }),
    };
    this.last = { target, label, live, key };
    this.patch({ phase: 'loading', label, live, error: null, notice: null, loadId: mine, streamKey: key });
    /*
     * The last word on a spinner: nothing stays "opening" for ever.
     *
     * Seen once on the TV emulator, on the first launch after an update: the
     * app reopened the last film and sat on "opening Wicked" for over a minute,
     * with no request for the film ever reaching the panel and no error raised —
     * so nothing was reported and the viewer had no way out but BACK. Three
     * further cold launches could not reproduce it, which is exactly why this
     * does not try to guess the path: whatever left the phase on `loading`, 45
     * seconds of it becomes an error with a Retry, and the error reaches the
     * server like any other.
     */
    window.clearTimeout(this.loadWatch);
    this.loadWatch = window.setTimeout(() => {
      /* Only a load that never delivered a thing: a film that started and is
         merely rebuffering at the 45-second mark is not stuck. */
      if (this.epoch !== mine || this.playedEpoch === mine || this.snap.phase !== 'loading') return;
      this.note(`still opening after ${LOAD_GIVE_UP_MS / 1000}s — giving up so the viewer can retry`, 'error');
      this.teardown();
      this.patch({
        phase: 'error', recovering: 0, permanent: false,
        error: {
          message: 'This is taking too long to open',
          hint: 'Nothing arrived from the stream. Press Retry; if it keeps happening, try another channel or title.',
        },
      });
    }, LOAD_GIVE_UP_MS);

    /* A fresh picture to watch. Not reset by a seek — `watchFrozen` handles a
       clock that moves backwards itself — only by opening something. */
    this.frames = freshWatch();
    this.freezeHandled = false;
    /* A new stream has had nothing arrive yet. Without this the door we just
       left would vouch for the one we are opening, which is the opposite of
       what this measurement is for. */
    this.lastByteAt = 0;
    this.lastSeekAt = 0;
    this.nativeSeek = null;
    this.seekRecovered = false;

    const forced = this.forceNative;
    this.forceNative = false;
    /* The retry's one-shot flag, OR the viewer's standing choice. Someone who
       has set Decoder to Software in Settings has already learned this about
       their own box and should not have to watch the hardware attempt fail once
       per title — see `Prefs.decoder`. */
    const software = this.softwareOnce || getPrefs().decoder === 'software';
    this.softwareOnce = false;
    /* A load that is NOT the software retry is a fresh attempt at something —
       a new title, or the viewer pressing RETRY — and both deserve the whole
       ladder again. The retry itself must not clear the flag it just set, or
       hardware and software would alternate for ever. */
    if (!software) this.triedSoftware = false;
    const skipNative = this.skipNativeOnce;
    this.skipNativeOnce = false;
    this.note(`load ${target.container} ${shortUrl(target.url)}${forced ? ' · forced native' : skipNative ? ' · webview only' : ''}`);
    let lastNativeState = '';
    /* One re-ask per stream — see the `playing` branch below. */
    let askedTracks = false;
    let learnedHere = false;
    const native = skipNative ? null : await tryNative(target, {
      label, live, startAtMs: startAt * 1000, force: forced, key: this.last.key,
      ...(software ? { software: true } : {}),
      onEvent: (e) => {
        if (this.epoch !== mine) return;
        /*
         * Any word from the engine restarts the silence clock.
         *
         * The watchdog exists for an engine that has gone SILENT, not for one
         * that is working. It used to be a plain timer from `load()`, so it killed
         * a 4K MKV that was still fetching — the log read "native: buffering" and
         * then "native: nothing after 15s" back to back, which is a working
         * download being called a hang. Buffering, time and length all prove the
         * engine is alive, so each one pushes the deadline out; only true silence
         * reaches `nativeStalled`. Cleared for good once a frame is on screen.
         */
        window.clearTimeout(this.nativeWatch);
        this.nativeWatch = window.setTimeout(() => this.nativeStalled(mine, forced), this.nativeWaitMs());
        if (e.state === 'time') {
          const reported = (e.timeMs ?? 0) / 1000;
          /* A report from before the seek landed says where the engine still
             is, which is no longer where the bar says the viewer is going. */
          if (!believeNativeTime(reported, this.nativeSeek, Date.now())) return;
          this.nativeSeek = null;
          this.nativeTime = reported;
          /*
           * libVLC's own picture counter, which rides along once a second.
           *
           * The surface belongs to the native engine, so every reading the
           * `<video>` element could offer is zero — `watchPicture` says so and
           * bails out. This is the only window onto "is a picture still being
           * produced", and it is the failure that matters most: it plays,
           * and then it is black with sound.
           */
          const shown = e.displayedPictures ?? e.decodedVideo;
          if (shown !== undefined && this.snap.phase === 'playing') {
            this.watchFrozen(shown, this.nativeTime);
          }
          this.patch({});
          return;
        }
        if (e.state === 'length') {
          this.assumedDuration = (e.lengthMs ?? 0) / 1000 || this.assumedDuration;
          this.patch({});
          return;
        }
        if (e.state !== lastNativeState) {
          lastNativeState = e.state;
          this.note(
            e.state === 'error' ? `native: error — ${nativeWhy(e)}` : `native: ${e.state}`,
            e.state === 'error' ? 'error' : 'info',
          );
        }
        if (e.state === 'error') {
          window.clearTimeout(this.nativeWatch);
          void this.nativeRefused(target.url, mine);
          return;
        }
        if (e.state === 'playing' || e.state === 'paused') {
          /* A picture, finally — the watchdog stands down, and only now is the
             lesson worth remembering: `load()` resolving proved nothing, which is
             how streams libVLC never actually played got pinned to it. */
          window.clearTimeout(this.nativeWatch);
          if (forced && !learnedHere) {
            learnedHere = true;
            rememberNeedsNative(this.last?.key ?? streamKey(target.url));
          }
          if (e.state === 'playing' && !this.everPlayed) this.markSteady();
          /*
             And NOW ask what is inside it.

             A picture means libVLC has read the container, which is the first
             moment its track list is worth anything — the ask at open time
             happens before it has read a byte. Twice more after that, because a
             large MKV finishes attaching its subtitle tracks a second or two
             into playback; `readNativeTracks` keeps the richer answer. Once per
             stream, hence the flag: the `playing` state arrives again after
             every pause. */
          /* `this.nativeOwned`, not the `native` this closure was written beside:
             the handler is handed to `tryNative` before its result exists, so
             that binding is still null-typed here. The owned handle is the same
             object and is the one the rest of the class drives. */
          const owned = this.nativeOwned;
          if (e.state === 'playing' && !askedTracks && owned !== null) {
            askedTracks = true;
            this.readNativeTracks(owned, mine, 600);
            this.readNativeTracks(owned, mine, 2500);
            this.readNativeTracks(owned, mine, 6000);
          }
        }
        this.patch({
          phase: e.state === 'playing' ? 'playing'
            : e.state === 'paused' ? 'paused'
            : e.state === 'ended' ? 'idle'
            /*
             * Anything else means "loading" ONLY before a frame has arrived.
             *
             * libVLC reports `Buffering` continuously — including at 100% while a
             * film plays perfectly well — and this mapped every one of those back
             * to `loading`, which put the full "opening <title>" overlay and its
             * spinner on top of a picture that was already playing. Photographed
             * on a television: the film visible behind the spinner,
             * "opening Dust Bunny" still on screen. Reported as "it keeps loading
             * even when its playing".
             *
             * After `everPlayed` the phase is left exactly as it is, so a genuine
             * mid-film rebuffer no longer claims the stream is still opening. The
             * real stall paths are untouched: `nativeStalled` still watches for
             * silence and `error` is handled above.
             */
            : this.everPlayed ? this.snap.phase
            : 'loading',
          transport: 'native',
          live,
        });
      },
    });
    if (native) {
      if (this.epoch !== mine) {
        void native.stop();
        return;
      }
      this.nativeOwned = native;
      /* The page may now open the hole — see `surface` on the snapshot. */
      this.patch({ surface: true });
      /*
        Ask what is inside it.
        Deliberately after the handle is stored and never awaited before it: a
        plugin that is slow or refuses to answer must not delay the picture.
      */
      this.readNativeTracks(native, mine);
      /*
       * `load()` resolved, which means libVLC accepted the URL — not that it
       * will ever draw a frame. This used to mark the stream steady and learn it
       * as native right here, so a stream libVLC silently failed on was pinned to
       * libVLC for good, and the spinner it produced read "opening …" for ever.
       * Both now wait for the `playing` event; this waits for it too, and acts if
       * it never comes.
       */
      window.clearTimeout(this.nativeWatch);
      this.nativeWatch = window.setTimeout(() => this.nativeStalled(mine, forced), this.nativeWaitMs());
      return;
    }
    if (forced) {
      /* libVLC was the last resort and it declined too — the plugin is absent, or
         the stream really is off the air. Say the second thing, because the first
         is not something a viewer can act on. */
      this.patch({
        phase: 'error',
        error: {
          message: 'nothing here can decode this stream',
          hint: 'Both the browser engine and the native player refused it. The stream '
              + 'is most likely offline; if it plays elsewhere, report the channel.',
        },
      });
      return;
    }

    const isTs = target.container === 'mpegts' || /\.ts(\?|$)/i.test(target.url);
    const isHls = target.container === 'hls' || /\.m3u8(\?|$)/i.test(target.url);

    if (isTs) {
      const mpegts = await loadTs();
      if (this.epoch !== mine) return; // a newer load started while importing
      if (pickWebEngine({
        platform: currentPlatform(), container: 'mpegts',
        nativeHls: false, hlsJs: false, mpegts: mpegts.isSupported(),
      }) === 'unsupported') {
        if (this.escalate('MPEG-TS demuxing unsupported')) return;
        if (isIos()) {
          /* No MediaSource on this iPhone, and no libVLC to hand it to. */
          this.note('MPEG-TS cannot be demuxed here (no Media Source)', 'warn');
          this.patch({ phase: 'error', error: { ...IOS_CANNOT_PLAY.mpegts } });
          return;
        }
        this.patch({
          phase: 'error',
          error: {
            message: 'MPEG-TS demuxing unsupported',
            hint: 'This browser lacks the Media Source support the low-latency path needs. Switch to the Compatible (HLS) transport.',
          },
        });
        return;
      }
      const prof = resolveBufferProfile(this.last?.key);
      const p = mpegts.createPlayer(
        /*
         * `isLive` is the stream's nature, not a constant.
         *
         * It was hardcoded true, which is right for a channel and wrong for a
         * catch-up recording: with it set, the engine treats the feed as endless
         * and the media element never gets a seekable duration, so a recording
         * cannot be scrubbed — which is most of what a recording is for.
         */
        { type: 'mpegts', isLive: live, url: target.url, cors: true },
        {
          enableWorker: true,
          // Hard off, on every profile: this is the seek-forward behaviour that
          // produced the visible skipping. Catch-up is done by playback rate
          // only when the viewer asked for it.
          liveBufferLatencyChasing: false,
          liveBufferLatencyChasingOnPaused: false,
          // Keep fetching the live edge while the playhead sits behind it — the
          // delay scrubber is useless if download stops once you leave LIVE.
          lazyLoad: false,
          stashInitialSize: prof.stashInitialSize,
          autoCleanupSourceBuffer: true,
          /* ~3 minutes of hold so the delay bar can go back in minutes, not 15s. */
          autoCleanupMaxBackwardDuration: LIVE_BACK_BUFFER_S,
          /*
           * How far back the cleanup cuts, and why it is not half.
           *
           * mpegts.js trims to the MIN whenever the held backward duration passes
           * the MAX, so these two numbers are not a target and a limit — they are
           * the two ends of what you can actually rewind, and it spends most of
           * its time near the min. At half, a bar that had just offered three
           * minutes offered ninety seconds a moment later, which is exactly the
           * report: "When the video is playing I should be able to go backwards
           * ... it only works halfway."
           *
           * At 0.85 the reachable window stays between 2:33 and 3:00 instead of
           * between 1:30 and 3:00. It costs more frequent cleanup calls on a
           * buffer that is already being walked, and no more memory at all —
           * the MAX is what bounds that, and it has not moved.
           */
          autoCleanupMinBackwardDuration: Math.round(LIVE_BACK_BUFFER_S * 0.85),
        },
      );
      this.ts = p;
      p.on(mpegts.Events.ERROR, (
        type: string, detail: string, info?: { code?: unknown; msg?: string },
      ) => {
        if (this.epoch !== mine) return;
        const text = String(detail);
        /* mpegts.js names the failure in `detail` and explains it in `info.msg`.
           The names are terse — `MediaMSEError` — and the sentence underneath is
           the one that says WHICH codec was refused, which is the whole diagnosis
           on an AC-3 channel. Keep both: one to match on, one to read. */
        const why = typeof info?.msg === 'string' && info.msg !== '' ? info.msg : '';
        this.note(`mpegts ${type}: ${text}${why === '' ? '' : ` — ${why}`}`, 'warn');
        /*
         * The panel refusing the ACCOUNT, not the stream stumbling.
         *
         * mpegts.js's HTTP status does not travel in `type` or `detail` — read
         * `node_modules/mpegts.js/src/io/fetch-stream-loader.js`: any non-2xx
         * response calls `onError(LoaderErrors.HTTP_STATUS_CODE_INVALID, {code:
         * res.status, msg: res.statusText})`, which reaches this callback as
         * `type === 'NetworkError'`, `detail === 'HttpStatusCodeInvalid'`, and the
         * status sitting in `info.code` — undocumented; the README says nothing
         * about the third argument. The regex just below matches "NetworkError"
         * whatever the status was, so a flood reply used to walk straight past it,
         * hop doors with no delay, and then ESCALATE TO NATIVE — opening yet
         * another connection to a line that had just said it was full. Photographed
         * on a customer's TV, Android TV app 1.17.0, a live channel, an active paid
         * account whose panel allows exactly one connection:
         *
         *   native  forced: the WebView already refused this stream
         *   native  load() accepted — waiting for the first frame
         *   player  native: buffering
         *   player  native: error — nothing arrived at all — the stream never delivered a byte
         *   fetch   456 stream.example.com/live/<redacted>/<redacted>/2023189.ts (130ms)
         *
         * `tsRefusal` reads the same 456/509/511/513 codes `serverVerdict` and
         * `connectionRefused` already know, off the shape mpegts.js actually uses.
         * Handled exactly like the hls.js branch below: record the door, hop to
         * another one, and only name the account once every door has refused —
         * never `escalate()` or `recover()` for it.
         */
        const flood = tsRefusal(detail, info);
        if (flood !== null) {
          try { this.refusedOrigins.add(new URL(target.url).origin); } catch { /* keep going */ }
          this.note(`door refused: ${flood}`, 'warn');
          if (this.tryOtherLine(target.url, 400)) return;
          this.attempts = 0;
          this.patch({
            phase: 'error',
            recovering: 0,
            error: refusalVerdict(
              this.refusedOrigins.size,
              subscription()?.maxConnections ?? null,
              flood,
            ),
          });
          return;
        }
        /*
         * The SOUND refused, and only the sound.
         *
         * `decoderRefusal` below reads any MSE complaint as "this engine cannot
         * play the stream", which is true of a refused VIDEO buffer and false of a
         * refused AUDIO one: mpegts.js made the video buffer first and goes on
         * filling it, so the element plays a picture with no sound. Measured on
         * `DE| SKY BUNDESLIGA 1 HD` (the whole run is in lib/audioRefusal.ts):
         * video buffer accepted at 1,476ms, `audio/mp4;codecs=ac-3` refused at
         * 1,482ms, this callback at 1,483ms, MEDIA_INFO at 1,484ms — then 370
         * decoded frames and 0 decoded audio bytes in the next 15 seconds.
         *
         * Taken as a whole-stream refusal it went wrong both ways it could. With
         * no native engine, `auto` dropped the channel to HLS, where hls.js
         * discards the same AC-3 track without raising any event at all —
         * measured: a video-only buffer, 20 seconds of frames, no error — which is
         * exactly the silent picture #178 recorded, now thirty seconds behind live
         * and remembered for that channel for good. With the transport pinned, it
         * put an error box over a picture that was playing. So the refusal is
         * recorded, and weighed against what the stream DECLARES, which is the
         * very next event; `checkSound` decides.
         */
        const refusedType = refusedSourceBufferType(why);
        if (refusedType !== null) this.refusedTypes.push(refusedType);
        if (refusedType !== null && /^audio\//i.test(refusedType) && !this.tsRefused) {
          this.note(`audio refused by this engine: ${refusedType}`, 'warn');
          this.soundRefusal ??= { type, text, why, at: performance.now() };
          this.checkSound(mine);
          return;
        }
        /**
         * A raw TS feed ending mid-session is normal, not exceptional.
         *
         * Panels cut long-lived TS connections, and upstream hiccups surface as
         * `UnrecoverableEarlyEof` — "unrecoverable" describes that demuxer
         * instance, not the channel. Surrendering to a red error box for something
         * a reconnect fixes is what made this feel like it randomly breaks.
         */
        const refused = decoderRefusal(text, why);
        if (/EarlyEof|Exception|NetworkError|UnrecoverableEarlyEof/i.test(`${type}${text}`)
            && !refused) {
          if (!this.everPlayed && this.tryOtherLine(target.url, 0)) return;
          /* Never got a byte, and there is an engine here that is not a browser:
             a raw TS feed the WebView cannot fetch (CORS, TLS) is one libVLC
             usually can. Only before first paint — a feed that played and then
             dropped is a reconnect, not a refusal. */
          if (!this.everPlayed && hasNativeEngine() && this.escalate(`${type}: ${text}`)) return;
          this.recover(`${type}: ${text}`);
          return;
        }
        if (refused) {
          this.tsUndecodable(type, text, why);
          return;
        }
        this.patch({
          phase: 'error',
          error: {
            message: `${type}: ${text}`,
            hint: 'The raw TS stream stopped. Try the Compatible (HLS) transport, or the channel may be offline.',
          },
        });
      });
      p.on(mpegts.Events.MEDIA_INFO, (info?: {
        hasVideo?: boolean; videoCodec?: string; hasAudio?: boolean; audioCodec?: string;
      }) => {
        if (this.epoch !== mine) return;
        /* The one place a live stream says whether it carries a picture at all.
           Radio channels do not, and the picture watchdog must know the
           difference before it starts counting. */
        if (info !== undefined) {
          this.hasVideoTrack = info.hasVideo === true
            || (typeof info.videoCodec === 'string' && info.videoCodec !== '');
          /* And what it says about its sound — the other half of `checkSound`. */
          this.declared = {
            hasAudio: typeof info.hasAudio === 'boolean' ? info.hasAudio : null,
            audioCodec: typeof info.audioCodec === 'string' ? info.audioCodec : null,
            hasVideo: typeof info.hasVideo === 'boolean' ? info.hasVideo : null,
            videoCodec: typeof info.videoCodec === 'string' ? info.videoCodec : null,
          };
        }
        /*
         * A refused demuxer still announces its media info.
         *
         * Measured on an AC-3 channel: `addSourceBuffer('audio/mp4;codecs=ac-3')`
         * threw, the error arrived — and 83ms later MEDIA_INFO fired and patched
         * the phase back to `playing`. The viewer got a player that claimed to be
         * playing with nothing on it and no error to read. Track info is not
         * evidence of playback.
         *
         * That example is now the one refusal that does NOT land here: a refused
         * AUDIO buffer beside an accepted video one is a picture that plays
         * (measured 2026-09-15, 370 frames in 15s), and it is weighed by
         * `checkSound` instead of being declared dead. `tsRefused` still holds
         * for a refused picture, and for sound refused with no picture beside it.
         */
        if (this.tsRefused) { this.note('media info after a refused buffer — ignored', 'warn'); return; }
        /* A refused sound track was waiting for exactly this. If the verdict
           hands the channel to libVLC, `escalate` has already torn this stream
           down and the epoch has moved; if there is no picture either, the
           ordinary refusal has run. In both cases this stream is not "playing";
           in the third — kept without sound — it is, and carries on below. */
        if (this.soundRefusal !== null) {
          this.checkSound(mine);
          if (this.epoch !== mine || this.tsRefused) return;
        }
        this.note('playing via mpegts');
        this.markSteady();
        this.patch({ phase: 'playing', live, transport: 'mpegts', recovering: 0 });
      });
      p.attachMediaElement(v);
      p.load();
      const reserve = live ? liveReserveS(prof) : 0;
      if (reserve > 0) this.holdForReserve(v, () => p.play(), reserve, mine);
      else void p.play()?.catch(() => {});
      return;
    }

    if (isHls) {
      /* iOS: the platform's own HLS player, no hls.js. Decided before the
         library is even imported — it is ~500KB the iPhone never needs. */
      if (isIos() && pickWebEngine({
        platform: 'ios', container: 'hls', hlsJs: false,
        nativeHls: v.canPlayType('application/vnd.apple.mpegurl') !== '',
        mpegts: false,
      }) === 'native-hls') {
        this.playNativeHls(v, target.url, live, startAt, mine, label);
        return;
      }
      const Hls = await loadHls();
      if (this.epoch !== mine) return;
      if (!Hls.isSupported()) {
        // Safari plays HLS natively; fall through to the media-element path.
        v.src = target.url;
        void v.play().catch(() => {});
        this.patch({ phase: 'playing' });
        return;
      }
      /*
       * How far ahead to fetch, and how much to keep behind.
       *
       * These four numbers ARE the bandwidth policy on this path, and they follow
       * the viewer's buffer setting rather than being fixed, because the trade is
       * genuinely theirs to make: Minimal fetches 12 seconds ahead and stalls
       * sooner on a bad line, Smooth fetches 40 and rides it out.
       *
       * `backBufferLength` on live is the delay scrubber's range — minutes of
       * held video, not the 12s VOD default that made "go back" a no-op.
       */
      const hlsProf = resolveBufferProfile(this.last?.key);
      const chase = this.snap.chaseLiveEdge;
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        /* One segment behind live, unless the viewer asked to sit further back
           — and a long buffer is only real on live if playback sits that far
           back: the forward buffer cannot outrun a stream that arrives at the
           rate it plays. hls.js refuses the two forms together, hence either. */
        ...(live && hlsProf.targetLag >= 10
          ? { liveSyncDuration: hlsProf.targetLag }
          : { liveSyncDurationCount: 1 }),
        maxBufferLength: hlsProf.maxBufferS,
        maxMaxBufferLength: hlsProf.maxMaxBufferS,
        maxBufferSize: hlsProf.maxBufferBytes,
        backBufferLength: live ? LIVE_BACK_BUFFER_S : 12,
        // Only when chase is on. Default is off: the delay bar is how you move
        // toward live, not an automatic speed-up that steals the choice.
        maxLiveSyncPlaybackRate: chase ? 1.08 : 1,
        /* Prefetch the live edge while the first fragment demuxes. */
        startFragPrefetch: true,
        fragLoadingMaxRetry: 2,
        manifestLoadingMaxRetry: 2,
      });
      this.hls = hls;

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (this.epoch !== mine) return;
        if (!data.fatal) return;
        {
          const rc = (data as { response?: { code?: number } }).response?.code;
          const at = String((data as { url?: unknown }).url ?? target.url);
          this.note(`hls ${data.type}/${data.details}${rc !== undefined ? ` http ${rc}` : ''} ${shortUrl(at)}`, 'warn');
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.destroy();
          if (this.hls === hls) this.hls = null;
          /*
           * Refused before it started: say so now, do not spend 20 seconds
           * pretending otherwise.
           *
           * `recover()` backs off 0.7s, 1.4s, 2.8s, 5.6s, 8s and then reports
           * "the stream dropped repeatedly... the channel is probably offline,
           * or the single allowed connection is still held by a previous
           * session". For a stream the browser will not fetch, all five of those
           * requests fail identically and the sentence at the end is false in
           * both of its halves. Retrying is for streams that answered once.
           */
          /*
             Checked BEFORE `refusedByBrowser` and before `recover`, because it is
             the one network failure where trying again is actively harmful. See
             `connectionRefused`.
          */
          const failedUrl = String((data as { url?: unknown }).url ?? target.url);
          const refused = connectionRefused(data);
          if (refused !== null) {
            /* Which MACHINE said it, before hopping — the count is the diagnosis. */
            try { this.refusedOrigins.add(new URL(failedUrl).origin); } catch { /* keep going */ }
            this.note(`door refused: ${refused}`, 'warn');
            if (this.tryOtherLine(failedUrl, 400)) return;
            this.attempts = 0;
            const verdict = refusalVerdict(
              this.refusedOrigins.size,
              subscription()?.maxConnections ?? null,
              refused,
            );
            this.patch({ phase: 'error', recovering: 0, error: verdict });
            return;
          }
          if (!this.everPlayed && this.tryOtherLine(failedUrl, 0)) return;
          if (!this.everPlayed && this.tryPlainHttp(failedUrl, 0)) return;
          const host = refusedByBrowser(data, this.attempts);
          if (host !== null) {
            /*
             * The WebView said no; libVLC has not been asked.
             *
             * A request the browser refused — CORS, a certificate, a redirect it
             * will not follow — is precisely what the native engine is carried
             * for: it is not a web page and none of those rules apply to it.
             * `jmp2.uk` alone is 15% of the free list and pins CORS to pluto.tv;
             * on the APK those channels went straight to a red box saying "the
             * Android app often can", while sitting inside the Android app.
             */
            if (hasNativeEngine() && this.escalate(`${data.details}: refused by the browser (${host})`)) {
              hls.destroy();
              if (this.hls === hls) this.hls = null;
              return;
            }
            this.attempts = 0;
            this.patch({
              phase: 'error',
              recovering: 0,
              error: {
                message: `${data.details}: the request to ${host} never left this browser`,
                hint: browserBlockHint(failedUrl),
                blocked: { host },
              },
            });
            return;
          }
          this.recover(String(data.details));
          return;
        }
        /* MEDIA_ERROR from hls.js means the browser refused the buffer it was
           appended — a decoder gap, not a network fault. Same escalation. */
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.escalate(String(data.details))) {
          hls.destroy();
          if (this.hls === hls) this.hls = null;
          return;
        }
        this.patch({
          phase: 'error',
          error: { message: `${data.details}`, hint: hintFor(data.details) },
        });
        hls.destroy();
        if (this.hls === hls) this.hls = null;
      });

      const refreshTracks = () => {
        if (this.epoch !== mine) return;
        this.patch({
          levels: [
            { id: -1, label: 'Auto', active: hls.autoLevelEnabled },
            ...hls.levels.map((l, i) => ({
              id: i,
              label: levelLabel(l),
              active: !hls.autoLevelEnabled && hls.currentLevel === i,
            })),
          ],
          audioTracks: hls.audioTracks.map((t, i) => ({
            id: i,
            label: t.name || t.lang || `Audio ${i + 1}`,
            lang: t.lang,
            active: hls.audioTrack === i,
          })),
          subtitleTracks: [
            { id: -1, label: 'Off', active: hls.subtitleTrack === -1 },
            ...hls.subtitleTracks.map((t: MediaPlaylist, i: number) => ({
              id: i,
              label: t.name || t.lang || `Subtitle ${i + 1}`,
              lang: t.lang,
              active: hls.subtitleTrack === i,
            })),
          ],
        });
      };

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (this.epoch !== mine) return;
        /* Same question as on the TS path, asked of the manifest: a level that
           declares a video codec, or a resolution, carries a picture. A panel
           that declares neither leaves this `null` and the watchdog stays out of
           it on live — the safe direction to be wrong in. */
        this.hasVideoTrack = hls.levels.some(
          (l) => (l.videoCodec ?? '') !== '' || (l.height ?? 0) > 0,
        );
        refreshTracks();
        void v.play().catch(() => {});
        this.note(`playing via hls · ${hls.levels.length} level(s)`);
        this.markSteady();
        this.patch({ phase: 'playing', transport: 'hls', recovering: 0 });
        this.seekWhenReady(v, startAt, mine);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, refreshTracks);
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, refreshTracks);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, refreshTracks);

      hls.loadSource(target.url);
      hls.attachMedia(v);
      return;
    }

    if (this.wantsDeviceFilm(target, live)) {
      /*
       * Taken apart HERE, by the page, out of ranged reads it issues itself.
       *
       * Two things make a film need this, and only one of them is about the
       * file. A container no browser demuxes — Matroska — or sound no browser
       * decodes; and a subscription allowing ONE stream, where handing the file
       * to the element is fatal whatever is inside it, because the element
       * opens a fresh connection per seek and the panel refuses it: `509`, then
       * `ERR_CONTENT_LENGTH_MISMATCH`.
       *
       * See `deviceFilm.ts` — including what it measured before it was built.
       */
      const film = new DeviceFilm({
        url: target.url,
        note: (text, level) => this.note(text, level),
        /* The watchdog's own rule — "if its downloading dont change to another
           server" — applied to the path where the PAGE downloads rather than
           the element. Without it `doorIsAnswering` saw nothing, walked the
           doors, and the viewer was told nothing arrived while megabytes did. */
        onBytes: () => { if (this.epoch === mine) this.lastByteAt = Date.now(); },
        /*
         * A door that refused is left AT ONCE, not in nine seconds.
         *
         * `openStalled` is a timer for a door that says nothing. A 403, a 400
         * from the content edge or a 521 is a door saying no, and waiting out
         * the timer on each of them is how one press came to walk four doors
         * and spend most of a minute — "takes forever to load one after
         * millions of failures". The watchdog stays exactly as it is for the
         * case it was written for.
         */
        onRefused: (status) => {
          if (this.epoch !== mine) return;
          this.note(`that door refused the film (${status}) — trying the next one`, 'warn');
          window.clearTimeout(this.openWatch);
          if (this.tryOtherLine(target.url, 0)) return;
          this.failFinal('No server would serve this film',
            'Every address for this source refused this title. Another title '
            + 'will tell you which it is: if it plays, this one is missing from the servers '
            + 'rather than your line being blocked.');
        },
        onRanges: () => { if (this.epoch === mine) this.patch({}); },
        onDuration: (seconds) => {
          if (this.epoch !== mine || seconds <= 0) return;
          this.assumedDuration = seconds;
          this.patch({ duration: seconds });
        },
        /*
         * The film's own soundtracks and subtitles, into the same AUDIO and
         * SUBTITLES menus every other path fills.
         *
         * "this is a dual language film but I don't see any language changers":
         * the remuxer has always known both — it names every audio stream and
         * hands out every text subtitle line as it reads — and this used to
         * count the subtitle tracks into the log and drop the rest.
         */
        onTracks: (t) => {
          if (this.epoch !== mine) return;
          const asFilm = (kind: 'audio' | 'subtitle') => (x: DeviceTrack): FilmTrack => ({
            index: x.index, kind, lang: x.language === '' ? null : x.language,
            title: x.title === '' ? null : x.title, codec: '', isDefault: false, textual: true,
          });
          const film = [...t.audio.map(asFilm('audio')), ...t.subtitles.map(asFilm('subtitle'))];
          this.patch({
            audioTracks: audioChoices(film, t.audioIndex),
            subtitleTracks: subtitleChoices(film, t.subtitleIndex),
          });
        },
        onImpossible: (why) => {
          if (this.epoch !== mine) return;
          /* The honest end of the road: a picture no browser decodes, which
             cannot be rescued in a page at any sane cost. Named rather than
             blamed on a codec — see `NEEDS_DEVICE_HINT`. */
          this.note(`cannot be taken apart here: ${why}`, 'warn');
          this.failFinal('This film needs the TV app', NEEDS_DEVICE_HINT);
        },
      });
      this.deviceFilm = film;
      void film.open(v, startAt).then((ok) => {
        /*
         * The frames wait for the film, and borrow what it already asked.
         *
         * `film.bytes` is the length the film's own HEAD found, so the seek bar
         * costs the panel nothing to set up. Started after the film is open
         * rather than beside it, because a thumbnailer opening at the same
         * moment would be the second reader this whole design exists to avoid
         * — and `filmLine.ts` would make it wait anyway.
         */
        if (!ok || this.epoch !== mine || this.deviceFilm !== film) return;
        const preview = new DevicePreview(target.url, film.bytes);
        this.devicePreview = preview;
        this.patch({ frameAt: (t: number) => preview.frameAt(t) });
      });
    } else {
      // Progressive file (movies/episodes) or native HLS in Safari.
      v.src = target.url;
    }
    v.addEventListener(
      'error',
      () => {
        if (this.epoch !== mine) return;
        void this.progressiveFailed(v.error?.code ?? null, v.error?.message ?? '', target.url, mine);
      },
      { once: true },
    );
    v.addEventListener(
      'loadedmetadata',
      () => {
        if (this.epoch !== mine) return;
        this.note('playing via <video>');
        this.patch({ live: false, phase: 'playing', transport: 'native' });
        if (this.snap.userRate !== 1) v.playbackRate = this.snap.userRate;
        this.seekWhenReady(v, startAt, mine);
      },
      { once: true },
    );
    void v.play().catch(() => {});
  }

  /**
   * HLS through the element itself — iOS, where the platform plays it.
   *
   * No hls.js: AVFoundation reads the playlist, picks the rendition and keeps
   * the live edge. What is left for the page is the same three jobs the file
   * path has — the error listener (so a refused stream gets the door walk and
   * the plain-words verdict), the first-frame handoff, and the resume position.
   */
  private playNativeHls(
    v: HTMLVideoElement, url: string, live: boolean, startAt: number, mine: number, label: string,
  ): void {
    v.src = url;
    v.addEventListener('error', () => {
      if (this.epoch !== mine) return;
      void this.progressiveFailed(v.error?.code ?? null, v.error?.message ?? '', url, mine);
    }, { once: true });
    v.addEventListener('loadedmetadata', () => {
      if (this.epoch !== mine) return;
      this.note(`playing via native HLS${live ? ' (live)' : ''} · ${label}`);
      this.markSteady();
      this.patch({ live, phase: 'playing', transport: 'native', recovering: 0 });
      if (this.snap.userRate !== 1) v.playbackRate = this.snap.userRate;
      this.seekWhenReady(v, startAt, mine);
    }, { once: true });
    void v.play().catch(() => {});
  }

  /**
   * A progressive `<video>` gave up. Find out whether that was about the DECODER.
   *
   * The old shape of this was four lines inside the `error` listener, and its
   * first line escalated `MEDIA_ERR_SRC_NOT_SUPPORTED` straight to libVLC on the
   * grounds that it "is the MKV / HEVC / AC-3 case almost every time". Measured,
   * on this panel, for episodes, it is not: see `serverVerdict` for the three
   * transport failures that all arrive here as that exact code, and for the 7 of
   * 26 sampled episodes that produce one.
   *
   * So the element's verdict is no longer taken at face value. One 1-byte ranged
   * GET of the same URL turns "code 4" into what the server actually said, and
   * the four outcomes want four different things:
   *
   *   media  the bytes are real, so the decoder genuinely refused them — this is
   *          the case libVLC is carried for, and the only one worth spending the
   *          single escalation on.
   *   busy   a flood reply. The panel is holding this account's one slot. Walk
   *          the other doors, and if they all say it, `refusalVerdict` already
   *          knows how to say "this is the subscription, not the moment".
   *   gone   the panel answered success and sent nothing playable. Another door
   *          is worth one try — they are different machines — but a decoder is
   *          not the answer and neither is a retry loop.
   *   error  4xx/5xx from the content edge. Same treatment as `gone`; the wording
   *          differs because the status is worth quoting back at a provider.
   *
   * ── failing soft, deliberately ──
   *
   * `askServer` returns null whenever it cannot get an answer — CORS, a dead
   * network, a timeout — and null means "behave exactly as this did before".
   * Every door this account uses answers `Access-Control-Allow-Origin: *`
   * (measured across 26 episodes, including the dead ones and the 400s), so the
   * probe works from the WebView; but a build pointed at a panel that does not
   * must not lose its escalation over it.
   */
  private async progressiveFailed(
    code: number | null,
    message: string,
    url: string,
    mine: number,
  ): Promise<void> {
    if (this.epoch !== mine) return;

    const decodeShaped = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      || code === MediaError.MEDIA_ERR_DECODE;

    /* Only for the codes that look like a decoder. A plain network error or an
       abort has never been mistaken for a codec and needs no second opinion. */
    const said = decodeShaped ? await this.askServer(url) : null;
    if (this.epoch !== mine) return;
    const verdict = said === null ? null : serverVerdict(said.status, said.type, said.bytes);
    const status = said === null ? 0 : said.status;
    if (said !== null) {
      this.note(`server says ${said.status} ${said.type || '(no type)'} `
        + `${said.bytes ? 'with' : 'without'} bytes → ${verdict}`, 'warn');
    }

    if (verdict === 'busy') {
      try { this.refusedOrigins.add(new URL(url).origin); } catch { /* relative */ }
      if (this.tryOtherLine(url, 400)) return;
      this.attempts = 0;
      this.patch({
        phase: 'error',
        recovering: 0,
        error: refusalVerdict(
          this.refusedOrigins.size,
          subscription()?.maxConnections ?? null,
          status,
        ),
      });
      return;
    }

    if (verdict === 'gone' || verdict === 'error') {
      if (!this.everPlayed && this.tryOtherLine(url, 0)) return;
      this.attempts = 0;
      this.patch({
        phase: 'error',
        recovering: 0,
        error: {
          message: verdict === 'gone'
            ? 'the panel has this title listed but serves nothing for it'
            : `the panel answered HTTP ${status} for this title`,
          hint: 'Nothing arrived to decode, so this is not your device and no other '
              + 'player would do better with it. The provider still lists the title; '
              + 'the file behind it is missing or its content server is refusing. '
              + 'Other episodes of the same series often play — try one, and report '
              + 'this title to the provider.',
        },
      });
      return;
    }

    /* `media`, or no answer at all. */
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        && this.escalate(message || 'container or codec unsupported')) return;
    if (code === MediaError.MEDIA_ERR_DECODE
        && this.escalate(message || 'decode failed')) return;
    /*
     * Network / abort on a film: walk panel mirrors before giving up. Live
     * already did this; progressive VOD used to error on the first door.
     *
     * But only when this door said NOTHING. It used to hop on any media error
     * before the first frame, which on a film is far too eager: a door that has
     * already handed over metadata or a few seconds of buffer is working, and
     * one reset mid-open is a reason to retry it rather than to open a second
     * session against a one-connection account on a door that may be worse.
     * `doorAnswering` is the same test the opening watchdog uses, so "no
     * response" means one thing in this file.
     */
    if (!this.everPlayed && !this.doorAnswering() && this.tryOtherLine(url, 0)) return;
    if (!this.everPlayed && this.tryPlainHttp(url, 0)) return;
    /*
      A film that was playing until the viewer moved the playhead gets the same
      film back, at the place they asked for, on the same door. See `seekBroke`.
    */
    if (seekBroke(this.everPlayed, this.lastSeekAt, Date.now(), this.seekRecovered)) {
      const spec = this.last;
      if (spec !== null) {
        this.seekRecovered = true;
        const at = this.seekTo;
        this.note(`seek to ${Math.round(at)}s broke the stream — reopening there`, 'warn');
        this.patch({ phase: 'loading', error: null });
        void this.load(spec.target, spec.label, { live: spec.live, key: spec.key, startAt: at });
        return;
      }
    }
    this.patch({
      phase: 'error',
      error: {
        message: message || `media error ${code ?? '?'}`,
        hint:
          code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? 'This browser cannot decode the container or codec. MKV, HEVC video and AC-3/E-AC-3 audio are the usual causes — they need transcoding or a native player.'
            : undefined,
      },
    });
  }

  /**
   * One byte, to learn what the element would not tell us.
   *
   * `Range: bytes=0-0` rather than HEAD: this panel answers HEAD for a stream
   * path with headers that do not match what a GET returns, and a one-byte range
   * is the smallest request that goes down the same code path the player did.
   * Redirects are followed — the interesting answer is often the content edge the
   * panel 302s to, not the panel — and the body is cancelled the instant the
   * first chunk lands so the account's single connection is held for milliseconds
   * rather than for a download.
   *
   * Only ever reached after playback has already failed, so it costs nothing on
   * a stream that works.
   */
  private async askServer(
    url: string,
  ): Promise<{ status: number; type: string; bytes: boolean; via: string } | null> {
    try {
      const r = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(SERVER_ASK_MS),
      });
      let bytes = false;
      const reader = r.body?.getReader();
      if (reader) {
        try {
          const first = await reader.read();
          bytes = !first.done && (first.value?.length ?? 0) > 0;
        } catch { /* reset mid-read counts as no bytes */ }
        try { await reader.cancel(); } catch { /* already gone */ }
      }
      /* `r.url` is where we ENDED after the 302, which is the media edge rather
         than the door — and the edge is the half worth naming in an error. */
      return { status: r.status, type: r.headers.get('content-type') ?? '', bytes, via: r.url };
    } catch {
      /* CORS, DNS, TLS, timeout — no answer is not an answer, and the caller
         falls back to the behaviour it had before this existed. */
      return null;
    }
  }

  /**
   * The native engine said no. Find out WHO said no before walking off.
   *
   * This used to be `if (this.tryOtherLine(target.url, 0)) return;` — hop, with
   * no delay and no question asked. On a list of eight doors that is eight
   * openings of the same film in six seconds, and it is what a debug
   * log caught: seven doors burned between 02:36:23 and 02:37:28, each dying
   * ~800ms in, and then `player_api.php` — which had been answering in 60ms all
   * evening — took 38 and then 43 seconds and failed. A provider watching seven
   * stream opens in six seconds from one address on a one-connection line will
   * throttle that address, so the storm did not merely fail to find a door: it
   * plausibly caused the outage that followed it. Reported before this, in
   * exactly these terms: "for movies and series i think its changing servers way
   * too quick, it should change if no response, other if its fetching something
   * then just wait".
   *
   * A door hop is only ever the answer to ONE failure — the DOOR refused. It is
   * never the answer to a bad edge, because every door hands the same film to
   * the same edge: measured 2026-09-08, all four working doors 302 stream
   * 2140935 to 203.0.113.10, and live to 203.0.113.20. So `askServer` (one
   * cancelled byte, already used by the error path below) is asked what actually
   * happened, and only a refusal moves us:
   *
   *   456/509/511/513      the panel is refusing the ACCOUNT's one connection —
   *                        not this door specifically. See `nativeAskVerdict` and
   *                        the report above the busy check below.
   *   401/403/404/410/451  the door refused — another door may hold this line.
   *   no answer at all     the door is unreachable — likewise.
   *   2xx WITH bytes       door and edge are both fine and the ENGINE failed;
   *                        hopping would open a second session to prove the same
   *                        thing again.
   *   2xx WITHOUT bytes    the edge accepted and then delivered nothing. Every
   *                        other door leads to that same edge, so say so.
   */
  private async nativeRefused(url: string, mine: number): Promise<void> {
    /*
      A seek that killed a film gets the film back before anything else runs.
      
      Checked ahead of `askServer` on purpose: the door is not the problem, so
      asking it costs a round trip and — on a one-connection account — risks the
      answer being a flood code caused by our own still-closing session. The
      `<video>` path does the same thing at the end of `progressiveFailed`; the
      native engine reaches it through here instead.
    */
    if (seekBroke(this.everPlayed, this.lastSeekAt, Date.now(), this.seekRecovered)) {
      const spec = this.last;
      if (spec !== null) {
        this.seekRecovered = true;
        const at = this.seekTo;
        this.note(`seek to ${Math.round(at)}s broke the native stream — reopening there`, 'warn');
        this.teardown();
        this.patch({ phase: 'loading', error: null });
        void this.load(spec.target, spec.label, { live: spec.live, key: spec.key, startAt: at });
        return;
      }
    }
    const answer = await this.askServer(url);
    if (this.epoch !== mine) return;
    const verdict = nativeAskVerdict(answer);

    /*
     * A busy line is a fifth answer `askServer` can bring back, and until now it
     * fell through every branch below to the last one — "accepted the request and
     * then sent nothing … Live television uses a different server". Photographed
     * on a customer's TV, Android TV app 1.17.0, a live channel, an active paid
     * account whose panel allows exactly one connection:
     *
     *   native  forced: the WebView already refused this stream
     *   native  load() accepted — waiting for the first frame
     *   player  native: buffering
     *   player  native: error — nothing arrived at all — the stream never delivered a byte
     *   fetch   456 stream.example.com/live/<redacted>/<redacted>/2023189.ts (130ms)
     *   player  the native engine could not open this stream — stream.example.com
     *           accepted the request and then sent nothing. Every door hands out
     *           that same server, so another door will not help — this is the
     *           path between this device and it. Live television uses a
     *           different server, which is why it still plays.
     *
     * Both halves of that last line were false: `fetch` shows the server answered
     * 456 — its own flood code — so it did not "accept the request and send
     * nothing"; and the channel failing this way WAS live television, so telling
     * the viewer live television uses a different server is a claim about itself.
     * Classify with `serverVerdict` first, exactly like the hls.js and
     * progressive-`<video>` paths: record the door, hop to another one, and only
     * name the account once every door has said the same thing — never spend the
     * one native escalation, or `recover()`, on a slot that is already taken.
     */
    if (verdict === 'busy' && answer !== null) {
      try { this.refusedOrigins.add(new URL(url).origin); } catch { /* keep going */ }
      this.note(`door refused: ${answer.status}`, 'warn');
      if (this.tryOtherLine(url, 400)) return;
      this.attempts = 0;
      this.patch({
        phase: 'error',
        recovering: 0,
        error: refusalVerdict(
          this.refusedOrigins.size,
          subscription()?.maxConnections ?? null,
          answer.status,
        ),
      });
      return;
    }

    const refused = verdict === 'refusedDoor';
    if (refused && this.tryOtherLine(url, DOOR_GAP_MS)) return;

    /*
     * Bytes are not video. An error page is bytes too.
     *
     * The first version of this asked only `answer.bytes` and then told the
     * viewer "the server delivered video" — which would have been a confident
     * lie for any panel answering 200 with an HTML page, and several do. The
     * content type is what separates a film from a sentence about a film.
     */
    const looksLikeMedia = verdict === 'media';

    /*
     * The engine failed on a file the server IS serving. Try it in software
     * before saying no.
     *
     * "make sure iff hardware dont support it, im sure there are milionms of
     * ways, netively or anything" — and there is exactly one that matters:
     * libVLC decodes in software what MediaCodec will not touch. Measured on
     * a test box the same evening: `Carmen Curlers S3E1` is H.264
     * High@5.1 at 3840x2160, and 4K H.264 is the awkward case — boxes ship 4K
     * decoders for HEVC and cap H.264 at Level 4.2, so MediaCodec refuses a
     * file that decodes perfectly on a CPU.
     *
     * Once per load (`triedSoftware`), and only when the server is demonstrably
     * serving media, so this can never become a second attempt at a 403.
     */
    if (looksLikeMedia && !this.triedSoftware && this.last !== null) {
      this.triedSoftware = true;
      this.softwareOnce = true;
      this.forceNative = true;
      this.note('hardware decoding refused it — trying again in software', 'warn');
      const spec = this.last;
      this.teardown();
      this.patch({ phase: 'loading', recovering: 0, error: null });
      const again = this.epoch;
      this.recoverTimer = window.setTimeout(() => {
        if (this.epoch !== again) return;
        void this.load(spec.target, spec.label,
          { live: spec.live, key: spec.key, startAt: this.resumePoint(spec.key, spec.live) });
      }, 250);
      return;
    }

    /* Named, because "it did not work" is not something anyone can act on and
       the address is the whole diagnosis — a netblock that answers here and not
       there is a network between the two, not a broken film. */
    let where = '';
    try { where = new URL(answer?.via ?? url).hostname; } catch { /* keep going */ }
    /* `this.last` still describes the stream that just failed — teardown only
       runs on the NEXT load, never before this error is reported — so this reads
       the same `live` flag `load()` set for it, with the snapshot as a fallback.
       `emptyStreamHint` is why this matters at all: see its docstring. */
    const live = this.last?.live ?? this.snap.live;

    const hint = answer === null
      ? `Nothing answered at ${where || 'the server'} — the door is unreachable from `
        + 'this network.'
      : refused
        ? `Every server address refused this stream (HTTP ${answer.status}). The account may `
          + 'not carry it, or the line is out of connections.'
        : looksLikeMedia
          /*
           * Say what happened; do NOT name a cause.
           *
           * This used to assert "4K H.264 is the usual cause — most boxes decode
           * 4K only as HEVC and stop at 1080p for H.264". Sometimes true, and it
           * was stated as the diagnosis whatever the file was. Measured against
           * the film it was photographed failing on: 1920x1072 H.264
           * High@4.1, yuv420p, 2.1 Mbps, a fast-start MP4 — the most ordinary
           * video in the catalogue, and 4K had nothing to do with it. A hint
           * that confidently names the wrong cause is worse than one that names
           * none: it is what sent the investigation at the decoder for an
           * evening while the log line that mattered said only "error".
           *
           * So the sentence reports the two facts that are certainly true and
           * points at the line that now carries the actual numbers.
           */
          ? 'The stream arrived and neither the hardware decoder nor the software one '
            + 'could open it. The debug log\u2019s "native: error" line says how '
            + 'many bytes arrived and how many frames decoded, which is what separates a '
            + 'decoder problem from a delivery one.'
          : answer.bytes
            ? `${where || 'The server'} answered with ${answer.type || 'something that is not video'} `
              + 'rather than a stream, so there is nothing here to play.'
            : emptyStreamHint(where, live);

    this.patch({
      phase: 'error',
      error: { message: 'the native engine could not open this stream', hint },
    });
  }

  /**
   * Same stream, next door.
   *
   * A 404 or a timeout on `panel.example.com` is not a verdict on the channel —
   * this account answers on seven hostnames. Each origin is tried once for this
   * load. 456 still walks them: they are other ways in, not proven to be the
   * same machine. Retry-storming the door that just refused is what used to
   * occupy the only slot.
   */
  private tryOtherLine(failedUrl: string, waitMs: number): boolean {
    const spec = this.last;
    if (spec === null || !isPanelStreamUrl(spec.target.url)) return false;
    const bases = streamBases();
    if (bases.length === 0) return false;
    /*
     * Any Xtream live/movie/series URL walks the door list. The old "current
     * origin must already be one of our bases" gate skipped failover for films:
     * VOD often lands on a CDN IP or a host that is not in `streamBases()`, so
     * one failure ended the play with no mirror attempt. `isPanelStreamUrl` is
     * enough to keep third-party M3U feeds off this path.
     */
    try { this.failedOrigins.add(new URL(failedUrl).origin); } catch { /* keep going */ }
    try { this.failedOrigins.add(new URL(spec.target.url).origin); } catch { /* keep going */ }
    const next = nextStreamOrigin(failedUrl, bases, this.failedOrigins);
    if (next === null) return false;
    const rewritten = rewriteStreamOrigin(spec.target.url, next);
    if (rewritten === spec.target.url) return false;
    /*
     * Remembered, NOT adopted — that comes when a frame actually arrives.
     *
     * `adoptStreamBase` used to run right here, before the new door had played a
     * single byte. So a failed hop PINNED the failure: on a line whose TLS port
     * is not even open (measured: `https://line.example.com` refuses 443,
     * while `http://` answers) the app hopped to the https door, failed, and then
     * started every LATER stream on that dead https door — which is exactly the
     * "why is it using strict HTTPS, I told you HTTP first" in the debug log. The
     * door is now only remembered once the stream is steady; see `markSteady`.
     */
    this.pendingBase = next;
    this.note(`try door → ${String(next)}`, 'warn');
    this.teardown();
    this.patch({ phase: 'loading', recovering: 0, error: null });
    const mine = this.epoch;
    this.recoverTimer = window.setTimeout(() => {
      if (this.epoch !== mine) return;
      void this.load({ ...spec.target, url: rewritten }, spec.label, {
        live: spec.live, key: spec.key, startAt: this.resumePoint(spec.key, spec.live),
      });
    }, waitMs);
    return true;
  }

  /**
   * Free / third-party HTTPS that the browser rejected — try plain HTTP once.
   *
   * Many public M3U hosts publish `https://` with an expired or mismatched
   * certificate (`5centscdn` still serves a 2020 Let's Encrypt leaf). A secure
   * page cannot ignore that, and also cannot fall back to `http://` (mixed
   * content). The Android shell and a plain-HTTP deployment can, so they get
   * one downgrade before we report failure.
   */
  private tryPlainHttp(failedUrl: string, waitMs: number): boolean {
    if (!fetchesItsOwnMedia()) return false;
    const spec = this.last;
    if (spec === null) return false;
    let u: URL;
    try { u = new URL(spec.target.url); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    /* Panel doors walk `tryOtherLine` instead — do not silently strip TLS there. */
    if (isPanelStreamUrl(spec.target.url) && streamBases().length > 0) {
      const origin = u.origin;
      const ours = streamBases().some((b) => {
        try {
          const raw = b.includes('://') ? b : `http://${b}`;
          return new URL(raw).origin === origin;
        } catch { return false; }
      });
      if (ours) return false;
    }
    if (this.failedOrigins.has(`http-downgrade:${u.host}`)) return false;
    this.failedOrigins.add(`http-downgrade:${u.host}`);
    try { this.failedOrigins.add(new URL(failedUrl).origin); } catch { /* keep going */ }
    u.protocol = 'http:';
    this.note('retry over plain http', 'warn');
    const rewritten = u.href;
    if (rewritten === spec.target.url) return false;
    this.teardown();
    this.patch({ phase: 'loading', recovering: 0, error: null });
    const mine = this.epoch;
    this.recoverTimer = window.setTimeout(() => {
      if (this.epoch !== mine) return;
      void this.load({ ...spec.target, url: rewritten }, spec.label, {
        live: spec.live, key: spec.key, startAt: this.resumePoint(spec.key, spec.live),
      });
    }, waitMs);
    return true;
  }

  /**
   * Re-open the current stream after a transport failure.
   *
   * Teardown runs first and the retry waits: this account allows ONE connection and
   * a panel keeps counting a session for 30-120s after it ends, so reconnecting
   * instantly is the reliable way to be refused. Backoff starts at 1s and doubles.
   */
  private recover(why: string): void {
    const spec = this.last;
    if (!spec) return;
    /* Another door before hammering the same one — films and live share this. */
    if (!this.everPlayed && this.tryOtherLine(spec.target.url, 400)) return;
    if (this.askPortalAgain(spec, why)) return;
    if (this.attempts >= 5) {
      this.patch({
        phase: 'error',
        recovering: 0,
        error: {
          message: why,
          hint:
            'The stream dropped repeatedly and reconnecting did not help. The channel is probably offline, or the single allowed connection is still held by a previous session — wait a minute, or try the Compatible (HLS) transport.',
        },
      });
      return;
    }
    this.attempts++;
    const wait = Math.min(8000, 700 * 2 ** (this.attempts - 1));
    this.note(`retry ${this.attempts}/5 in ${wait}ms: ${why}`, 'warn');
    this.patch({ phase: 'loading', recovering: 0, error: null });
    window.clearTimeout(this.recoverTimer);
    /**
     * The retry belongs to THIS stream, and to nothing that comes after it.
     *
     * `teardown()` clears the timer, so a normal channel change was safe. What was
     * not safe is the gap: picking another title resolves its stream BEFORE it
     * calls `load()`, and if that fails the load never happens — so nothing cleared this timer, and the stream the viewer had
     * just abandoned reconnected itself and started playing again under the new
     * title. Every teardown bumps the epoch, so comparing it here makes a stale
     * retry a no-op instead.
     */
    const mine = this.epoch;
    this.recoverTimer = window.setTimeout(() => {
      if (this.epoch !== mine) return;
      const again = this.last;
      if (!again) return;
      void this.load(again.target, again.label,
          { live: again.live, key: again.key, startAt: this.resumePoint(again.key, again.live) });
    }, wait);
  }

  /**
   * A portal's link is short-lived: when it fails, the cheapest likely fix is a
   * new one, not the same dead address five more times. Asked for ONCE per open
   * (`FreshLink`, cleared when something plays); a second failure falls into
   * the ordinary retries and, in the end, the ordinary error.
   */
  private askPortalAgain(
    spec: NonNullable<typeof this.last>, why: string,
  ): boolean {
    const again = this.freshLink.take(spec.key, spec.target.reresolve);
    if (again === null) return false;
    this.note(`link failed (${why}) — asking the source for a fresh one`, 'warn');
    this.patch({ phase: 'loading', recovering: 0, error: null });
    const mine = this.epoch;
    void again().then((fresh) => {
      if (this.epoch !== mine || this.last === null) return;
      void this.load({ ...fresh, reresolve: again }, spec.label, {
        live: spec.live, key: spec.key, startAt: this.resumePoint(spec.key, spec.live),
      });
    }).catch((err: unknown) => {
      if (this.epoch !== mine) return;
      this.patch({
        phase: 'error', recovering: 0,
        error: {
          message: err instanceof Error ? err.message : why,
          hint: 'The source would not give a new link for this one. Try again in a moment.',
        },
      });
    });
    return true;
  }

  /** A stream that has held up for a while has earned a fresh retry budget. */
  /**
   * libVLC took the stream and never said `playing`.
   *
   * Seen on the Android Studio television emulator: the plugin answers, `load()`
   * resolves, and then nothing — no event, no error, a spinner reading "opening
   * Tolo TV" until the heat death of the universe. The same shape would come
   * from a dead stream on a real box. Either way, fifteen seconds of silence is
   * an answer.
   *
   * Forced here by `escalate()` — the WebView already refused — so there is
   * nothing left: say so, with the trail. Chosen up front — a learned stream or
   * the engine preference — the WebView has not had its turn: unlearn the stream,
   * bar a second escalation, and reload with the native engine skipped.
   */
  /**
   * How long libVLC may say nothing before it is given up on.
   *
   * Longer for a film, because on a one-connection line a film can be silent
   * for a good reason: `OneConnectionRelay` holds libVLC's request for up to
   * 20s while the panel frees the slot the previous connection held, and
   * resuming needs two such requests (the index at the front, then the place).
   * Measured on the TV emulator on a cold start: the 25s window ran out while
   * the relay was still waiting, and the stream was reloaded — in the WebView.
   */
  private nativeWaitMs(): number {
    const url = this.last?.target.url ?? '';
    return !this.snap.live && isFilmUrl(url) ? NATIVE_FILM_WAIT_MS : NATIVE_WAIT_MS;
  }

  private nativeStalled(mine: number, forced: boolean): void {
    if (this.epoch !== mine) return;
    if (this.snap.phase === 'playing' || this.snap.phase === 'paused') return;
    const spec = this.last;
    if (spec === null) return;
    this.note(`native: nothing after ${this.nativeWaitMs() / 1000}s`, 'warn');
    /*
     * A film is never handed back to the WebView from here.
     *
     * That was the other half of the cold-start stall: a film the WebView had
     * already refused on this very television — a customer's MediaTek set and
     * the emulator both answer ordinary MP4 with "Format error" — was retried in
     * it, the WebView's one-byte probe took the line's only connection, and the
     * viewer watched "opening" for over a minute. libVLC is the engine films
     * go to on a TV (see `chooseEngine`); if it is silent this long, the honest
     * answer is a Retry, not the engine that cannot play it.
     */
    if (!spec.live && isFilmUrl(spec.target.url)) {
      this.teardown();
      this.patch({
        phase: 'error', label: spec.label, live: false, recovering: 0, permanent: false,
        error: {
          message: 'This is taking too long to open',
          hint: 'The film did not start in time — often the provider is still releasing the '
              + 'previous connection. Press Retry.',
        },
      });
      return;
    }
    this.escalated = spec.key;
    forgetNeedsNative(spec.key);
    const { label, live } = spec;
    this.teardown();
    if (forced) {
      this.patch({
        phase: 'error',
        label,
        live,
        error: {
          message: 'the native engine never started this stream',
          hint: 'The browser engine refused it first, then libVLC produced no picture in '
              + `${NATIVE_WAIT_MS / 1000} seconds. The stream is most likely offline — or this `
              + 'device cannot run the native player at all, which an emulator often cannot.',
        },
      });
      return;
    }
    this.skipNativeOnce = true;
    this.patch({ phase: 'loading', label, live, error: null });
    void this.load(spec.target, label, { live, key: spec.key, startAt: this.resumePoint(spec.key, live) });
  }

  /**
   * Nothing at all after `OPEN_WAIT_MS`: try the next door.
   *
   * Deliberately narrow. It fires only when the element has not buffered a
   * single byte and has no metadata — a door that is answering slowly has both,
   * and this leaves it alone. The native engine is excluded because it keeps its
   * own, longer watch (`nativeStalled`), and a stream with nowhere else to go is
   * left exactly as it was: this returns without touching anything, and the
   * error path reports whatever eventually arrives.
   */
  /**
   * Has this door produced anything at all?
   *
   * The one question worth asking before changing servers, and both places that
   * change servers now ask it. `readyState >= 2` means metadata arrived;
   * `buffered.length > 0` means bytes did. Either way the door is answering, and
   * a door that is answering deserves patience rather than a hop — on an account
   * with one connection, every hop is a new session against it.
   *
   * "For movies and series i think its changing servers way too quick, it should
   * change if no response, other if its fetching something then just wait."
   */
  private doorAnswering(): boolean {
    const v = this.video;
    if (v === null) return false;
    return doorIsAnswering(v.readyState, v.buffered.length, this.lastByteAt, Date.now());
  }

  private openStalled(mine: number, second = false): void {
    if (this.epoch !== mine) return;
    if (this.everPlayed) return;
    if (this.snap.phase === 'playing' || this.snap.phase === 'paused') return;
    if (this.nativeOwned !== null) return;
    const spec = this.last;
    if (spec === null) return;
    if (this.doorAnswering()) {
      /*
       * Bytes are arriving and nothing is playing.
       *
       * On the second look — twenty seconds in — that is not a slow door, it is
       * a file the browser cannot start: a progressive MP4 whose index sits at
       * the END, on a host that will not serve a range request, has to be
       * fetched in full before Chromium can play a frame of it. On a 2GB film
       * that is exactly "sometimes its stuck forever till its downloaded".
       *
       * libVLC demuxes progressively and does not need the index first, so the
       * answer is the engine rather than another door — changing door would
       * fetch the same file the same way. VOD only: a live stream buffering
       * slowly has its own machinery and must not spend its one escalation here.
       */
      if (second) {
        /*
         * Live counts too now, and it is the report this closes.
         *
         * This used to `return` for live, on the reasoning that "a live stream
         * buffering slowly has its own machinery". It has machinery for a stream
         * that is PLAYING — `watchPicture` escalates sound-without-picture — and
         * that machinery is spent in MEDIA TIME, deliberately, so a stall costs
         * it nothing. Which means the one case it can never fire on is the one
         * where media time never starts: bytes arriving, no first frame, the
         * playhead at zero. Nothing advanced, so nothing was measured, so nothing
         * escalated, and the channel sat there. "some get stuck."
         *
         * An MPEG-2 channel is exactly that shape on a box whose WebView has no
         * MPEG-2 decoder — and no browser does. It is also a stream libVLC plays
         * without difficulty, which is the whole argument for spending the one
         * escalation here rather than waiting for an error that is not coming.
         */
        const waited = Math.round((OPEN_WAIT_MS + (this.snap.live ? LIVE_SECOND_MS : OPEN_SECOND_MS)) / 1000);
        this.note('bytes arriving, nothing playing — handing it to libVLC', 'warn');
        this.escalate(`${waited}s of download with no first frame`);
        return;
      }
      this.note('slow, but answering — left alone');
      window.clearTimeout(this.openWatch);
      /* Live gets longer before the second look: a channel legitimately spends
         time filling a buffer before its first frame, and a film being fetched
         from a cold origin does not behave the same way. */
      this.openWatch = window.setTimeout(
        () => this.openStalled(mine, true),
        this.snap.live ? LIVE_SECOND_MS : OPEN_SECOND_MS,
      );
      return;
    }
    const url = spec.target.url;
    this.note(`nothing at all after ${OPEN_WAIT_MS / 1000}s — trying the next door`, 'warn');
    if (this.tryOtherLine(url, 0)) return;
    if (this.tryPlainHttp(url, 0)) return;
    /* No other door and no other scheme. Keep waiting rather than inventing a
       failure: the request may still answer, and the error path is what reports
       it if it does not. */
    this.note('no other door to try');
  }

  /**
   * Start a live picture only once `seconds` of it are in hand.
   *
   * "they added buffer but it didn't work, like 40 seconds": the setting grew a
   * forward buffer that a live channel can never fill, and playback started at
   * the live edge with nothing held, exactly as before. Holding the first play
   * until the reserve is there is what turns the number into protection. Media
   * info has already cleared the open watchdog by then (`markSteady`), and the
   * frozen-picture check counts media time, which does not move while held — so
   * neither reads the wait as a dead stream. A viewer pressing play starts it at
   * once; a feed too slow to ever build the reserve starts anyway, a little late.
   */
  private holdForReserve(v: HTMLVideoElement, play: () => unknown, seconds: number, mine: number): void {
    const started = performance.now();
    this.note(`holding ${seconds}s in hand before the picture starts`);
    const tick = () => {
      if (this.epoch !== mine) return;
      if (!v.paused) return;
      const b = v.buffered;
      const ahead = b.length > 0 ? b.end(b.length - 1) - v.currentTime : 0;
      if (ahead >= seconds || performance.now() - started > (seconds + 10) * 1000) {
        try { void (play() as Promise<void> | undefined)?.catch(() => {}); } catch { /* engine gone */ }
        return;
      }
      window.setTimeout(tick, 250);
    };
    tick();
  }

  private markSteady(): void {
    /* Something arrived, so no door needs trying. */
    window.clearTimeout(this.openWatch);
    /* This door works — only now is it worth starting later streams on. */
    if (this.pendingBase !== null) {
      adoptStreamBase(this.pendingBase);
      this.note(`door adopted: ${this.pendingBase}`);
      this.pendingBase = null;
    }
    this.everPlayed = true;
    this.freshLink.reset();
    /* Per LOAD, unlike `everPlayed` — see the watchdog armed in `load`. */
    this.playedEpoch = this.epoch;
    this.steadySince = performance.now();
    window.setTimeout(() => {
      if (performance.now() - this.steadySince >= 25_000) this.attempts = 0;
    }, 26_000);
  }

  // ── controls ────────────────────────────────────────────────────────────
  /** Playhead reported by the native engine, in seconds. */
  private nativeTime = 0;

  /** Where the page wants the native surface, in CSS pixels. */
  setSurfaceBounds(rect: { x: number; y: number; width: number; height: number }): void {
    void this.nativeOwned?.setBounds(rect);
  }

  /** True while the picture is an Android surface rather than the video element. */
  get nativeActive(): boolean {
    return this.nativeOwned !== null;
  }

  togglePlay(): void {
    if (this.nativeOwned) {
      void (this.snap.phase === 'playing' ? this.nativeOwned.pause() : this.nativeOwned.play());
      this.patch({ phase: this.snap.phase === 'playing' ? 'paused' : 'playing' });
      return;
    }
    const v = this.video;
    if (!v) return;
    v.paused ? void v.play().catch(() => {}) : v.pause();
  }
  seek(t: number): void {
    if (!Number.isFinite(t)) return;
    const v = this.video;
    if (this.nativeOwned === null && v === null) return;
    if (this.snap.live && this.nativeOwned === null && v !== null) {
      const win = liveHoldWindow(v);
      if (!win) return;
      /* Live stays immediate: the delay bar seeks inside what is already held,
         which costs no request, so there is nothing to coalesce. */
      v.currentTime = Math.min(win.end - 0.25, Math.max(win.start, t));
      return;
    }
    const d = this.nativeOwned !== null
      ? this.assumedDuration
      : (v !== null && Number.isFinite(v.duration) ? v.duration : 0);
    const to = d > 0 ? Math.min(Math.max(0, t), d) : Math.max(0, t);
    /* The viewer's intent, recorded before any engine has been asked. A seek
       that breaks the stream is the commonest reason for a reload, and that
       reload has to land where they were going, not where they came from. */
    if (this.last !== null && !this.snap.live) this.filmAt = { key: this.last.key, at: to };
    /*
     * A film this page took apart itself moves without a settle.
     *
     * The 350ms coalescing below exists because every press used to cost a
     * fetch. Here a move inside what is held is a property assignment, and a
     * move outside it is the remuxer reading from a different offset —
     * measured at 131 ms against a real panel. There is nothing to
     * save by making a viewer wait a third of a second first.
     */
    const device = this.deviceFilm;
    if (device !== null) {
      this.pendingSeek = null;
      this.seekTo = to;
      this.lastSeekAt = Date.now();
      void device.seek(to);
      this.patch({});
      return;
    }
    /* Shown now, issued once the burst settles — see `SEEK_SETTLE_MS`. */
    this.pendingSeek = to;
    if (this.nativeOwned !== null) {
      /* Drawn now, and the engine's contradicting reports stop being believed
         from this moment — not from the moment it is asked, 350ms later, which
         is 350ms of the bar springing back under the viewer's thumb.

         `from` is kept across a burst: during a drag every frame updates the
         target, but the position being travelled AWAY from is still where the
         drag started. Re-reading it from `nativeTime` here would read the last
         frame's optimistic target instead, and the test would then be met by
         any report at all. */
      this.nativeSeek = {
        to,
        from: this.nativeSeek?.from ?? this.nativeTime,
        at: Date.now(),
      };
      this.nativeTime = to;
    }
    this.patch({});
    window.clearTimeout(this.seekTimer);
    const mine = this.epoch;
    this.seekTimer = window.setTimeout(() => this.commitSeek(mine), SEEK_SETTLE_MS);
  }

  /** The one engine seek a settled burst turns into. */
  private commitSeek(mine: number): void {
    if (this.epoch !== mine) return;
    const to = this.pendingSeek;
    this.pendingSeek = null;
    if (to === null) return;
    /* Remembered at the moment the engine is actually asked, because that is the
       seek a failure could be blamed on — and once the engine errors it can no
       longer say where it was going. See `seekBroke`. */
    this.seekTo = to;
    this.lastSeekAt = Date.now();
    if (this.nativeOwned !== null) {
      void this.nativeOwned.seek(to * 1000);
      /* The give-up clock starts HERE, not when the burst began: a viewer who
         drags for four seconds has not given the engine four seconds to
         answer. */
      this.nativeSeek = { to, from: this.nativeSeek?.from ?? this.nativeTime, at: Date.now() };
      this.nativeTime = to;
    } else if (this.video !== null) {
      this.video.currentTime = to;
    }
    this.patch({});
  }

  private seekWhenReady(v: HTMLVideoElement, at: number, epoch: number): void {
    if (at <= 0) return;
    const go = () => {
      if (this.epoch !== epoch) return;
      if (Number.isFinite(v.duration) && at < v.duration - 2) v.currentTime = at;
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
  }
  /**
   * Where the playhead actually is, whichever engine is holding it.
   *
   * The snapshot above already knows this and says why: "the element is empty
   * while a surface owns the picture, so its currentTime is 0 and would read as
   * stuck at the start". Everything that needs a position must read it from the
   * same place, and `nudge` did not.
   */
  private get at(): number {
    if (this.nativeOwned) return this.nativeTime;
    const v = this.video;
    if (v === null) return 0;
    return v.currentTime;
  }

  /**
   * Skip, relative to where we are — which on a native stream was neither.
   *
   * `if (this.video) this.seek(this.video.currentTime + by)` failed twice over
   * on anything libVLC is playing, and libVLC plays most of this catalogue
   * (MKV, HEVC, AC-3, and anything 4K). With no element attached it did nothing
   * whatsoever, so the button was inert; with one attached it read a
   * `currentTime` of 0 from an element that is not decoding, so +30s meant
   * "seek to 30 seconds" from wherever you were, over and over.
   *
   * Reported as "dont forget the back and forth buttons and what not else tehy
   * get stuck as well as teh netive buttons of the smart tv" — and it is one
   * fault, not two: the on-screen skip controls and the remote's own
   * skip/forward/rewind keys all arrive here (see the `forward`, `back`,
   * `skipForward` and `skipBackward` intents in VideoPlayer).
   *
   * `seek` already branches correctly for both engines and clamps to the
   * duration, so this only has to hand it the right starting point.
   */
  nudge(by: number): void {
    if (this.nativeOwned === null && this.video === null) return;
    /* The film's length, for the same reason `seek` clamps against it: on an
       assembled pass the element's duration is what remains after the jump, and
       clamping a film-time target against that cuts every skip short. */
    const d = this.nativeOwned !== null
      ? this.assumedDuration
      : this.snap.duration > 0
        ? this.snap.duration
        : (this.video !== null && Number.isFinite(this.video.duration) ? this.video.duration : 0);
    /* From the seek still settling, not the playhead — see `nudgeTarget`. */
    this.seek(nudgeTarget(this.snap.live ? null : this.pendingSeek, this.at, by, d));
  }
  setVolume(x: number): void {
    if (!this.video) return;
    this.video.volume = Math.min(1, Math.max(0, x));
    if (this.video.volume > 0) this.video.muted = false;
  }
  toggleMute(): void {
    if (this.video) this.video.muted = !this.video.muted;
  }
  setLevel(id: number): void {
    if (!this.hls) return;
    // -1 restores ABR; a fixed index pins the rendition.
    this.hls.currentLevel = id;
    if (id === -1) this.hls.nextLevel = -1;
  }
  setAudio(id: number): void {
    if (this.nativeOwned) {
      void this.nativeOwned.selectTrack('audio', id);
      this.patch({ audioTracks: this.snap.audioTracks.map((t) => ({ ...t, active: t.id === id })) });
      return;
    }
    if (this.hls) { this.hls.audioTrack = id; return; }
    /* Taken apart on this device: a new remuxer on the other soundtrack, at the
       same second. The menu is redrawn by `onTracks` once it is playing. */
    if (this.deviceFilm !== null) {
      void this.deviceFilm.setAudio(id);
      this.patch({ audioTracks: this.snap.audioTracks.map((t) => ({ ...t, active: t.id === id })) });
      return;
    }
  }
  setSubtitle(id: number): void {
    if (this.nativeOwned) {
      // -1 is libVLC's "no subtitle track" as well as ours.
      void this.nativeOwned.selectTrack('subtitle', id);
      this.patch({ subtitleTracks: this.snap.subtitleTracks.map((t) => ({ ...t, active: t.id === id })) });
      return;
    }
    if (this.hls) this.hls.subtitleTrack = id;
    /* Taken apart on this device: its lines are already in a `<track>` each. */
    if (this.hls === null && this.deviceFilm !== null) {
      this.deviceFilm.showSubtitle(id === -1 ? null : id);
      return;
    }
    if (id === -1) return;
    // Embedded and external are mutually exclusive on screen.
    this.showExternal(null);
  }
  setAspect(a: AspectMode): void {
    this.patch({ aspect: a });
  }
  /** On-demand playback speed. Live is governed by the catch-up controller. */
  setUserRate(r: number): void {
    const rate = Math.min(4, Math.max(0.25, r));
    setStoredRate(rate);
    this.patch({ userRate: rate });
    if (this.video && !this.snap.live) this.video.playbackRate = rate;
  }
  /** Widen the live target so another subsystem has room to work. */
  setLagSlack(seconds: number): void {
    this.lagSlack = Math.min(10, Math.max(0, seconds));
  }

  // ── the engine, for one channel ────────────────────────────────────────────
  /**
   * Play what is on now in the BROWSER engine, for this stream only.
   *
   * ── what this is for ──
   *
   * Live captions listen to the `<video>` element. A channel libVLC or a
   * television's own player is showing has no audio in that element — the sound
   * comes out of a surface behind the page — so the feature could only ever
   * answer "switch engines in Settings", on a catalogue where every live channel
   * is a raw MPEG-TS and therefore always on the native engine. Photographed on
   * a television; that is what this closes.
   *
   * ── why it is this and not something cleverer ──
   *
   * The audio could also be lifted out of the stream by a server that was
   * already carrying it. It was, briefly, and it was the wrong answer: it puts
   * live video through a box that is meant to keep logs, and the bill for that
   * scales with the number of people watching. The only audio this app can reach
   * for free is the audio already in the page — so the page has to be the one
   * playing it.
   *
   * ── what it costs, said plainly ──
   *
   * The native engine is the default for a reason: `chooseEngine` records a
   * debug log off a real television where MSE demuxing MPEG-TS went black after
   * ten seconds and took the app with it. So this is offered, never taken: the
   * viewer asks for it, it applies to one channel, and `rememberNeedsNative`
   * deletes it the moment this stream is measured failing in the WebView.
   */
  playInBrowserEngine(): boolean {
    const a = this.asked;
    if (a === null) return false;
    rememberWantsBrowser(a.key);
    this.note('engine: this channel was asked for in the browser engine — for captions');
    this.reopen();
    return true;
  }

  /** Has this stream been pinned to the browser engine by the viewer? */
  get onBrowserEngine(): boolean {
    return this.asked !== null && wantsBrowser(this.asked.key);
  }

  /**
   * Open what the app last asked for again, with whatever `load()` decides now.
   *
   * A live channel resumes at the edge, which is what live means. Anything else
   * resumes where the viewer is, because re-opening at zero to change an engine
   * would be its own bug report.
   */
  private reopen(): void {
    const a = this.asked;
    if (a === null) return;
    void this.load(
      {
        url: a.url, container: a.container, codec: a.codec,
        ...(a.headers === undefined ? {} : { headers: a.headers }),
        ...(a.reresolve === undefined ? {} : { reresolve: a.reresolve }),
      },
      a.label,
      { live: a.live, key: a.key, ...(a.live ? {} : { startAt: this.snap.currentTime }) },
    );
  }

  setChaseLiveEdge(on: boolean): void {
    setChaseLiveEdge(on);
    this.patch({ chaseLiveEdge: on });
    if (this.hls) this.hls.config.maxLiveSyncPlaybackRate = on ? 1.08 : 1;
    if (!on && this.video) this.video.playbackRate = 1;
  }

  // ── external subtitles ──────────────────────────────────────────────────
  /**
   * Attach a WebVTT file as a text track.
   *
   * A file the viewer picked arrives as a `blob:` URL this page made, so the
   * `<track>`'s CORS rule never stands in the way. Rendering is the browser's own
   * cue renderer, which is why this works identically on every transport.
   */
  addExternalSub(url: string, label: string, lang: string, key: string | null): number {
    if (key !== null) {
      const hit = this.snap.externalSubs.find((s) => s.key === key);
      if (hit) {
        this.showExternal(hit.id);
        return hit.id;
      }
    }
    const v = this.video;
    if (!v) return -1;
    const id = ++this.subSeq;
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = label;
    el.srclang = lang;
    el.src = url;
    el.default = false;
    v.appendChild(el);
    this.subEls.set(id, el);
    // Cues only exist once loaded, so the offset is applied on arrival too.
    el.addEventListener('load', () => {
      this.placeTrack(el.track);
      if (this.snap.subtitleOffset !== 0) this.applyOffset(el, this.snap.subtitleOffset);
    });
    this.patch({
      externalSubs: [...this.snap.externalSubs, { id, label, lang, active: false, key }],
    });
    this.showExternal(id);
    return id;
  }

  showExternal(id: number | null): void {
    for (const [key, el] of this.subEls) {
      if (el.track) el.track.mode = key === id ? 'showing' : 'disabled';
    }
    if (id !== null && this.hls) this.hls.subtitleTrack = -1;
    this.patch({
      externalSubs: this.snap.externalSubs.map((s) => ({ ...s, active: s.id === id })),
      subtitleTracks: this.snap.subtitleTracks.map((t) => ({
        ...t,
        active: id === null ? t.active : t.id === -1,
      })),
    });
  }

  clearExternalSubs(): void {
    for (const el of this.subEls.values()) el.remove();
    this.subEls.clear();
    if (this.snap.externalSubs.length > 0 || this.snap.subtitleOffset !== 0) {
      this.patch({ externalSubs: [], subtitleOffset: 0 });
    }
  }

  /**
   * Shift every cue by `seconds`.
   *
   * Subtitle files are cut for a specific release, so a mismatch of a second or
   * two is normal and unfixable at the source. Cue times are mutable, and the
   * original timings are kept so repeated adjustments never accumulate error.
   */
  setSubtitleOffset(seconds: number): void {
    const off = Math.round(seconds * 10) / 10;
    for (const el of this.subEls.values()) this.applyOffset(el, off);
    this.patch({ subtitleOffset: off });
  }

  private applyOffset(el: HTMLTrackElement, off: number): void {
    const cues = el.track?.cues;
    if (!cues) return;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i]!;
      let base = this.cueBase.get(cue);
      if (!base) {
        base = { start: cue.startTime, end: cue.endTime };
        this.cueBase.set(cue, base);
      }
      cue.startTime = Math.max(0, base.start + off);
      cue.endTime = Math.max(0.1, base.end + off);
      this.placeCue(cue);
    }
  }

  private remPx(): number {
    return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  }

  private placeCue(cue: TextTrackCue): void {
    const h = this.video?.clientHeight ?? 0;
    const rem = this.remPx();
    if (cue instanceof VTTCue && this.liftedCues.has(cue)) {
      cue.line = cueBottomPercent(h, rem);
      return;
    }
    if (liftDefaultCue(cue, h, rem) && cue instanceof VTTCue) this.liftedCues.add(cue);
  }

  private placeTrack(track: TextTrack | null | undefined): void {
    const cues = track?.cues;
    if (!cues) return;
    for (let i = 0; i < cues.length; i++) this.placeCue(cues[i]!);
  }

  private watchTextTracks(video: HTMLVideoElement): void {
    const onTrack = (track: TextTrack) => {
      if (track.kind !== 'subtitles' && track.kind !== 'captions') return;
      this.placeTrack(track);
      track.addEventListener('cuechange', () => {
        const active = track.activeCues;
        if (!active) return;
        for (let i = 0; i < active.length; i++) this.placeCue(active[i]!);
      });
    };
    for (const t of video.textTracks) onTrack(t);
    video.textTracks.addEventListener('addtrack', (e) => {
      if (e.track) onTrack(e.track);
    });
    this.cueRo?.disconnect();
    this.cueRo = new ResizeObserver(() => {
      for (const t of video.textTracks) this.placeTrack(t);
    });
    this.cueRo.observe(video);
  }

  /** Jump back to the live edge after pausing a live stream. */
  goLive(): void {
    const v = this.video;
    if (!v) return;
    if (this.hls) this.hls.startLoad(-1);
    if (v.buffered.length) v.currentTime = v.buffered.end(v.buffered.length - 1) - 0.5;
    else if (v.seekable.length) v.currentTime = v.seekable.end(v.seekable.length - 1);
    void v.play().catch(() => {});
  }

  async togglePip(): Promise<void> {
    const v = this.video;
    if (!v || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* user gesture or unsupported source */
    }
  }
}

/**
 * Was this refused BY THE BROWSER, or answered by a server?
 *
 * The distinction is invisible in the console — both arrive at hls.js as a
 * network error — and it is the only one that matters to whoever is watching. A
 * server that answers 404 or 403 has been reached; the channel is the problem.
 * A request the browser blocked never went out, so the stream may be perfectly
 * healthy and playing everywhere that is not a web page.
 *
 * The tell is `response.code === 0`. XHR reports status 0 when it has nothing to
 * report — the response exists but the page is not allowed to see it. On this
 * catalogue that is nearly always CORS, in two flavours seen the same week:
 * `lsfb.avap.jilintv.cn` sends no `Access-Control-Allow-Origin` at all, and
 * `stream.starmenajo.com` sends it twice ("contains multiple values '*, *'"),
 * which browsers reject as malformed even though both values say yes. DNS and
 * TLS failures land here too, and the sentence — the request never left this
 * browser — is true of all of them.
 *
 * Only on the FIRST attempt at a manifest. A stream that has been playing and
 * then loses its connection is an ordinary blip, and those are worth retrying;
 * this is for the case where nothing has ever succeeded, so there is nothing to
 * reconnect to.
 *
 * Returns the host to name in the message, or null to retry as before.
 */
export function refusedByBrowser(
  data: { details?: unknown; url?: unknown; response?: unknown },
  attempts: number,
): string | null {
  if (attempts !== 0) return null;
  if (!/manifestLoadError/i.test(String(data.details ?? ''))) return null;
  const code = (data.response as { code?: unknown } | undefined)?.code;
  /* Anything else is a real answer from a real server: 404, 403, 502. Those are
     `UNREACHABLE`, and the existing retry is right for them. */
  if (code !== 0) return null;
  const url = String(data.url ?? '');
  try {
    return new URL(url).host;
  } catch {
    /* A relative or malformed URL has no host to name, but the diagnosis still
       holds — better a vague subject than the wrong error. */
    return url === '' ? 'that server' : url;
  }
}

/** What to tell the viewer when the browser blocked the stream request entirely. */
export function browserBlockHint(url: string): string {
  let https = false;
  try { https = new URL(url).protocol === 'https:'; } catch { /* keep going */ }
  if (https && !fetchesItsOwnMedia()) {
    return 'Usually a bad HTTPS certificate on that channel (expired or wrong name), '
      + 'or the server refusing cross-origin playback. A browser cannot ignore either. '
      + 'The Android app often can — try it there, or pick another channel.';
  }
  return 'Usually CORS or a TLS failure on that host. The stream may still play in the Android app.';
}

/**
 * The panel saying "not you, not now" — a connection limit, not a broken stream.
 *
 * Reported from a real session as a wall of
 * `…/live/<user>/<pass>/777860.m3u8: 456`, the same channel three times over,
 * across a dozen channels. 456 is not in anyone's HTTP registry; on Xtream panels
 * it is one of the flood-protection replies, alongside 509 and 511 — "you already
 * have as many streams open as you are allowed".
 *
 * ── why retrying makes it worse ─────────────────────────────────────────────
 *
 * `recover()` backs off 0.7s, 1.4s, 2.8s, 5.6s, 8s. That is the right shape for a
 * stream that answered once and then stumbled. It is precisely wrong here,
 * because on a line whose `max_connections` is 1 every retry OPENS A NEW SESSION,
 * and the panel holds a finished session for 30-120 seconds before releasing it.
 * So the retries occupy the very slot they are waiting for: five attempts, five
 * refusals, and a slot that is now held for two minutes rather than one. The
 * account this was measured on allows exactly one connection.
 *
 * ── what the other doors are for ────────────────────────────────────────────
 *
 * A 456 on `panel.example.com` is not proof the other six names are the same
 * machine. Playback tries each origin once (`tryOtherLine`) and only reports
 * the slot message when every door has refused. Retrying the same origin is
 * still harmful — that is what `recover()` must not do here.
 */
/* 429 joins them: Too Many Requests is the plainest way a server can say
   "stop asking", and treating it as a broken door is what sends a player to
   the next door, and the next, which is the opposite of stopping. */
const FLOOD_STATUS = new Set([429, 456, 509, 511, 513]);

/**
 * One door refusing is a busy slot. Every door refusing is the ACCOUNT.
 *
 * ── the report ──
 *
 * "When 456 comes from all mirrors, tell them they are blocked or something,
 * because now it's not enough." The old text said the same thing however many
 * doors had spoken: "this subscription allows one stream at a time, and one is
 * already open… a finished stream is held for up to two minutes". That is a
 * good sentence about ONE server. Said after six different machines have each
 * turned the account away, it sends somebody off to wait two minutes for a slot
 * that is never going to open, and it does it in a reassuring voice.
 *
 * ── why the count is the evidence ──
 *
 * The doors in `streamBases` are genuinely different machines — a provider's names
 * may be one origin server or several CDN edges. A connection allowance is counted per ACCOUNT, but a slot held by a
 * previous session is a transient thing, and the chance of catching every one of
 * several independent hosts inside the same 30-120s hold is not where the money
 * is. Two separate hosts giving the same account the same refusal is the account
 * being refused — the line blocked, expired, or genuinely at its limit
 * everywhere — and none of those is fixed by waiting a couple of minutes.
 *
 * So: one door, keep the slot explanation, because with one door that is all the
 * evidence there can be. Two or more, name it as the account and say what to do
 * about it.
 *
 * Split out from the player so the wording is testable without a video element.
 */
export function refusalVerdict(
  doorsRefused: number,
  maxConnections: number | null,
  code: number,
): { message: string; hint: string } {
  if (doorsRefused >= 2) {
    return {
      message: `Every server refused this account (HTTP ${code}).`,
      hint: `${doorsRefused} different servers each turned this account away. `
        + `${code} is what these panels send when a line is blocked, expired, or `
        + 'already using every connection it is allowed. One server saying it can be a '
        + 'slot that has not been released yet; several saying it is the account. '
        + 'Check it is still active and not playing on another device — if it is, the '
        + 'provider is the only one who can lift a block on the line or on this address.',
    };
  }
  return {
    message: maxConnections === 1
      ? 'This account allows one stream at a time, and one is already open.'
      : 'The panel refused another connection right now.',
    hint: 'A finished stream is held for up to two minutes before the slot is released. '
      + 'Retrying immediately opens another session and keeps the slot busy, so this waits '
      + 'for you instead.',
  };
}

/**
 * What the SERVER said, for the one engine that cannot tell you.
 *
 * ── the failure this exists to name ─────────────────────────────────────────
 *
 * hls.js and mpegts.js hand their errors over with the HTTP response attached,
 * which is why `connectionRefused` above can read a 456 off a live channel and
 * say "the line is already in use" instead of blaming a codec. A progressive
 * `<video src>` — every film and every episode — has no such thing. Its entire
 * vocabulary is `MediaError.code`, four numbers, and it collapses every
 * transport failure onto the same one.
 *
 * Measured in Chromium (2026-09-07), a `<video>` pointed at three responses that
 * have nothing to do with each other:
 *
 *   200, `Content-Type: text/html`, zero bytes
 *        → code 4, "DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed"
 *   400 with a `video/x-matroska` Content-Type and no body
 *        → code 4, "MEDIA_ELEMENT_ERROR: Format error"
 *   456, the panel's flood reply
 *        → code 4, "MEDIA_ELEMENT_ERROR: Format error"
 *
 * All three are `MEDIA_ERR_SRC_NOT_SUPPORTED`, and all three name the DEMUXER in
 * the message. So the comment that used to stand alone on that branch — "
 * SRC_NOT_SUPPORTED on a progressive file is the MKV / HEVC / AC-3 case almost
 * every time" — was reading a decoder complaint that the decoder never made.
 *
 * ── how often that is wrong here ────────────────────────────────────────────
 *
 * `scripts/series-probe.mjs`, 2026-09-07, against the live line: of 26 sampled
 * episodes, 19 served media and SEVEN served none — five answered 400 from the
 * content edge the panel redirects to, two answered `200 text/html` with zero
 * bytes from the panel itself. 27% of episodes, every one of them arriving at
 * this player as "your device cannot decode this container". The same probe put
 * films at 29/30. That gap is the report: "the movies in series still don't
 * play".
 *
 * ── why a codec answer is the expensive way to be wrong ─────────────────────
 *
 * `escalate()` allows ONE escalation per stream. Spending it on libVLC for a
 * title the server is not sending means libVLC also gets nothing, waits out
 * `NATIVE_WAIT_MS`, and the viewer reads "nothing here can decode this stream"
 * twenty-five seconds later — for a file that is simply gone, on a device that
 * would have played it perfectly.
 *
 * The classification: `media` means the bytes are real and the failure is
 * therefore genuinely the decoder's, which is the only case worth escalating.
 * 551 is the panel's "no such stream in that container" — measured by asking a
 * real `.mkv` episode for `.mp4` — and is a `gone`, not a busy line.
 */
export type ServerAnswer = 'media' | 'busy' | 'gone' | 'error';

export function serverVerdict(
  status: number,
  contentType: string | null,
  gotBytes: boolean,
): ServerAnswer {
  if (FLOOD_STATUS.has(status)) return 'busy';
  /* Not in FLOOD_STATUS on purpose: 551 is not a slot being held, it is this
     panel saying it has nothing under that name, and waiting two minutes for a
     slot will never make it appear. */
  if (status === 551) return 'gone';
  if (status >= 400) return 'error';
  if (status < 200) return 'error';
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  /* A body with no bytes is the same nothing whatever it calls itself, and a
     `text/html` answer to a stream request is this panel's way of saying the
     title is no longer on disk. `application/octet-stream` counts as media: some
     doors serve `.mkv` under it. */
  const looksMedia = type.startsWith('video/') || type.startsWith('audio/')
    || type === 'application/octet-stream';
  return gotBytes && looksMedia ? 'media' : 'gone';
}

export function connectionRefused(
  data: { details?: unknown; response?: unknown },
): number | null {
  if (!/manifestLoad|levelLoad|fragLoad/i.test(String(data.details ?? ''))) return null;
  const code = (data.response as { code?: unknown } | undefined)?.code;
  return typeof code === 'number' && FLOOD_STATUS.has(code) ? code : null;
}

/**
 * mpegts.js's own name for "the server answered, and it was not 2xx".
 *
 * hls.js hands a LOAD failure over as `{response: {code}}`, which is what
 * `connectionRefused` above reads. mpegts.js's shape is different and it is not
 * written down anywhere — read off the installed 1.8.2 source rather than the
 * README, which says nothing about the third callback argument:
 * `node_modules/mpegts.js/src/io/fetch-stream-loader.js` calls
 * `onError(LoaderErrors.HTTP_STATUS_CODE_INVALID, {code: res.status, msg:
 * res.statusText})` for any response that is not 2xx, and the player forwards it
 * as `Events.ERROR('NetworkError', 'HttpStatusCodeInvalid', {code, msg})`. Every
 * other `detail` — `EarlyEof`, `Exception`, `UnrecoverableEarlyEof` — carries no
 * HTTP status at all, because none of those is an HTTP answer.
 */
export function tsRefusal(detail: string, info?: { code?: unknown }): number | null {
  if (detail !== 'HttpStatusCodeInvalid') return null;
  const code = info?.code;
  return typeof code === 'number' && FLOOD_STATUS.has(code) ? code : null;
}

/**
 * The four things `askServer`'s answer means for the NATIVE engine, in the
 * order `nativeRefused` must act on them.
 *
 *   busy         a flood reply — see `serverVerdict`. The account's slot, not
 *                this stream; hop doors and never spend the one escalation on it.
 *   refusedDoor  no answer at all, or 401/403/404/410/451 — this DOOR refused or
 *                could not be reached; another door may still hold the line.
 *   media        real bytes with a media type: the server sent a stream and the
 *                engine still failed on it, which is what libVLC-in-software
 *                exists for.
 *   empty        a 2xx (or an unlisted status) with nothing playable behind it —
 *                every other door leads to the same edge, so say so.
 */
export type NativeAskVerdict = 'busy' | 'refusedDoor' | 'media' | 'empty';

export function nativeAskVerdict(
  answer: { status: number; type: string; bytes: boolean } | null,
): NativeAskVerdict {
  if (answer === null) return 'refusedDoor';
  if (serverVerdict(answer.status, answer.type, answer.bytes) === 'busy') return 'busy';
  if (answer.status === 401 || answer.status === 403 || answer.status === 404
      || answer.status === 410 || answer.status === 451) return 'refusedDoor';
  const type = answer.type.toLowerCase();
  const looksLikeMedia = answer.bytes
    && !type.startsWith('text/') && !type.includes('html') && !type.includes('json');
  return looksLikeMedia ? 'media' : 'empty';
}

/**
 * The "nothing arrived" sentence — said correctly about the stream that is
 * actually failing.
 *
 * The old wording always finished with "Live television uses a different
 * server, which is why it still plays", which only makes sense said about a
 * FILM: it contrasts the title that just failed with live TV, which on this same
 * device and account usually works. Said about a LIVE channel that failed this
 * exact way, it asserts that contrast against itself. See the report above the
 * busy check in `nativeRefused` for the debug log that caught it — a live channel,
 * "the native engine could not open this stream … Live television uses a
 * different server, which is why it still plays." So the sentence is appended
 * only for VOD; a live stream gets the plain fact and nothing more.
 */
export function emptyStreamHint(where: string, live: boolean): string {
  return `${where || 'The media server'} accepted the request and then sent nothing. `
    + 'Every door hands out that same server, so another door will not help — '
    + `this is the path between this device and it.${live ? '' : ' Live television uses '
      + 'a different server, which is why it still plays.'}`;
}

function hintFor(details: string): string | undefined {
  if (/manifestLoad|levelLoad|manifestParsing/i.test(details)) {
    return 'The panel refused this stream. With one allowed connection, the most common cause is the previous stream still being counted — panels hold a session for 30-120s after it ends.';
  }
  if (/bufferAppend|bufferAddCodec|bufferIncompatible/i.test(details)) {
    return 'The browser cannot decode this codec — usually HEVC video or AC-3/E-AC-3 audio.';
  }
  if (/fragLoad/i.test(details)) {
    return 'Segments stopped arriving. Either the channel is offline or the upstream is rate-limiting.';
  }
  return undefined;
}

const LIVE_MODE_KEY = 'iptv.liveMode';
/**
 * Unchanged on purpose.
 *
 * The feature was renamed away from "catch-up" (which now means archive replay), but
 * the stored key stays so nobody's preference silently resets over a rename.
 */
const CHASE_EDGE_KEY = 'iptv.catchUp';
const RATE_KEY = 'iptv.rate';

function read(key: string): string | null {
  try {
    return kv.get(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    kv.set(key, value);
  } catch {
    /* private mode */
  }
}

export function getChaseLiveEdge(): boolean {
  // Opt-in. Auto speed-up stole the delay choice the progress bar is for.
  return read(CHASE_EDGE_KEY) === 'on';
}
export function setChaseLiveEdge(on: boolean): void {
  write(CHASE_EDGE_KEY, on ? 'on' : 'off');
}
function setStoredRate(r: number): void {
  write(RATE_KEY, String(r));
}
export function getLiveMode(): LiveMode {
  const v = read(LIVE_MODE_KEY);
  return v === 'compatible' || v === 'lowLatency' ? v : 'auto';
}
export function setLiveMode(m: LiveMode): void {
  write(LIVE_MODE_KEY, m);
}

/* ── what auto resolves to ───────────────────────────────────────────────────
   The same shape as the decoder's learned list, and for the same reason: the
   question "can this stream be played the fast way" has no answer until it has
   been tried, and having tried it once there is no reason to try again.

   Keyed by stream id rather than by URL. A live URL carries credentials and 302s
   to a minted token path that changes every session, so the URL is useless as an
   identity; the id is what the route already has in hand. */

const COMPAT_KEY = 'iptv.liveMode.learned';
const COMPAT_MAX = 300;

/**
 * The learned list is emptied ONCE per device, by the first build that carries
 * `checkSound` — and this flag is how a device knows it already has been.
 *
 * Before that build, a live channel whose AUDIO the browser engine refused was
 * taken for a stream the engine could not play at all, and `auto` pinned it
 * here (gotcha #185). A pinned channel opens over HLS, and measured on
 * `DE| SKY BUNDESLIGA 1 HD` over HLS, hls.js drops the AC-3 track without raising
 * any event — so the refusal `checkSound` weighs never happens there, and the fix
 * could not reach precisely the devices that had met the bug. The list cannot say WHY a
 * channel is in it, so the pins made for a refused sound track cannot be picked
 * out; all of them go. That is cheap in the one direction it can be wrong: a
 * channel that genuinely needs HLS fails the fast path once more on its next
 * open and relearns it through the same escalation that put it here.
 *
 * Versioned rather than "the list is non-empty", for the reason
 * `clearEmptyAsksOnce` in localEpg.ts gives: what is relearned after the reset
 * is real, and must not be wiped again on every launch.
 */
const COMPAT_RESET_KEY = 'iptv.liveMode.learnedReset.v1';
const COMPAT_RESET_DONE = '1';

/**
 * The learned list as a read should see it, and whether the reset is still owed.
 *
 * Pure, so the rule is a value a test can hold: the flag not yet written means
 * the list is stale by definition and reads as empty; the flag written means
 * everything in the list was learned after the reset and stands. The caller
 * does the writing — see `compatList`.
 */
export function learnedAfterReset(
  flag: string | null,
  learned: readonly number[],
): { learned: readonly number[]; reset: boolean } {
  if (flag === COMPAT_RESET_DONE) return { learned, reset: false };
  return { learned: [], reset: true };
}

/* Asked once per launch. On the APK `kv` is a mirror filled before the first
   render; nothing reads this list at import time, so the first ask always
   sees the device's real flag. */
let compatResetAsked = false;

function compatList(): number[] {
  let stored: number[];
  try {
    const raw = read(COMPAT_KEY);
    const v: unknown = raw === null ? [] : JSON.parse(raw);
    stored = Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    stored = [];
  }
  if (compatResetAsked) return stored;
  compatResetAsked = true;
  const { learned, reset } = learnedAfterReset(read(COMPAT_RESET_KEY), stored);
  if (reset) {
    /* The list first, then the flag: if only one write lands, a lost flag means
       one more reset next launch (a relearn or two), where a lost list write
       after the flag would leave the stale pins in place for good. */
    write(COMPAT_KEY, '[]');
    write(COMPAT_RESET_KEY, COMPAT_RESET_DONE);
  }
  return [...learned];
}

/** Has this channel already proved it needs the compatible path? */
export function needsCompatible(id: number): boolean {
  return compatList().includes(id);
}

export function rememberNeedsCompatible(id: number): void {
  const list = compatList().filter((x) => x !== id);
  list.unshift(id);
  write(COMPAT_KEY, JSON.stringify(list.slice(0, COMPAT_MAX)));
}

export function forgetLearnedTransports(): void {
  write(COMPAT_KEY, '[]');
}

/**
 * The transport to actually request for one channel.
 *
 * An explicit choice always wins — the point of keeping the two visible is that
 * someone diagnosing a stream can pin it. Under `auto`, anything already known to
 * need HLS gets HLS, and everything else gets the fast path.
 *
 * Split into a pure `pickTransport` and a storage-reading `resolveLiveMode`, so the
 * rule is testable without a localStorage stand-in.
 */
export function pickTransport(
  mode: LiveMode,
  id: number | null,
  learned: readonly number[],
  /** Can this browser demux MPEG-TS at all? See the guard below. */
  mse = true,
  /** iOS plays HLS itself and cannot be asked for anything else. See `lib/platform.ts`. */
  ios = false,
): LiveTransport {
  /* iOS wants `.m3u8` whatever MSE exists: an iPad has MediaSource and would
     otherwise be sent down the mpegts.js path, which AVFoundation's own HLS
     player beats on battery, AirPlay and the system controls. */
  if (ios) return 'compatible';
  /*
   * No Media Source, no low-latency path — and this overrides an explicit
   * choice, which nothing else here does.
   *
   * `lowLatency` is MPEG-TS remuxed by mpegts.js, and mpegts.js is a MediaSource
   * program: without MSE it cannot start, whoever asked for it. Safari on an
   * iPhone has no MSE and never will — but it plays HLS natively, in the
   * element, which is how every iPhone on earth watches live video. So the one
   * transport that works there was the one the app never requested.
   *
   * Photographed from an iPhone: "This browser has no Media Source support.
   * Neither transport can work without it. Use the app build instead of this
   * browser." The second sentence was false. The panel serves these channels as
   * HLS — measured, `application/x-mpegurl` with a real `#EXTM3U` playlist —
   * and `playerCore` has had a native-HLS fallback for as long as it has had
   * hls.js. Nothing ever reached it, because the request went out asking for
   * `.ts` and died one branch earlier.
   *
   * Overriding the pin is the right call precisely because a pinned choice that
   * cannot work is not a choice, it is a dead end with a setting in front of it.
   */
  if (!mse) return 'compatible';
  if (mode !== 'auto') return mode;
  if (id !== null && learned.includes(id)) return 'compatible';
  return 'lowLatency';
}

/**
 * Does this browser have Media Source Extensions?
 *
 * `ManagedMediaSource` is deliberately NOT counted. iOS 17 added it and it is a
 * different API with a different contract; mpegts.js asks for `MediaSource` and
 * nothing else, so a browser that has only the managed one cannot run the
 * low-latency path either.
 */
function hasMse(): boolean {
  return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function';
}

export function resolveLiveMode(id: number | null): LiveTransport {
  return pickTransport(getLiveMode(), id, compatList(), hasMse(), isIos());
}

export const player = new PlayerCore();

if (typeof window !== 'undefined') {
  // A closed or reloaded tab must not leave the single connection held open.
  window.addEventListener('pagehide', () => player.teardown());
}
