/**
 * The native engine, and when to use it.
 *
 * The APK used to be the website in a box: same WebView, same decoders, same
 * gaps. `StreamixPlayerPlugin` puts libVLC behind the page — hardware decoding
 * through MediaCodec where the device has it, software where it does not — which
 * is what makes HEVC, AC-3, E-AC-3, MP2 and MKV playable on a phone whose
 * Chromium refuses all five.
 *
 * Chosen per stream, never globally. H.264/AAC over HLS is perfectly happy in
 * the WebView, keeps every feature the page composites over the video (cue
 * offsets, the aspect override, the live-caption audio tap), and is debuggable
 * from here. The native engine is for the streams that otherwise do not play at
 * all — so a bug in it costs the codec tail, not the whole app.
 *
 * A hole-punched surface is a one-way door: once the picture is an Android
 * surface behind a transparent WebView, nothing the page draws can be composited
 * INTO it. That is why this is a fallback rather than the default.
 */
import { matchCodec, type CapabilityReport } from './codecs.ts';
import { kv } from './kv.ts';
import { currentPlatform, nativePluginsPossible } from './platform.ts';

export interface NativeCodec {
  mime: string;
  hardware: boolean;
  decoders: string[];
}

export interface NativeCapabilities {
  codecs: NativeCodec[];
  engine: 'libvlc';
  softwareFallback: boolean;
}

export interface NativeEvent {
  state: 'playing' | 'paused' | 'buffering' | 'ended' | 'error' | 'time' | 'length';
  timeMs?: number;
  lengthMs?: number;
  buffered?: number;
  /**
   * libVLC's own counters — on `error`, and once a second on `time`.
   *
   * `MediaPlayer.Event.EncounteredError` carries no message, so "native: error"
   * was the whole diagnosis — which cannot tell a film that never arrived from
   * one the decoder refused. These separate the two: `readBytes` is what the
   * network delivered, `demuxReadBytes` what the demuxer accepted, and
   * `decodedVideo` how many frames came out the other side.
   *
   * They ride along with `time` as well, because the worst version of this
   * failure raises no error at all: a hardware decoder that chokes mid-film
   * stops producing pictures while libVLC goes on playing, the clock goes on
   * advancing and the sound goes on coming out. `displayedPictures` standing
   * still against a moving clock is that failure, stated as a fact.
   */
  readBytes?: number;
  demuxReadBytes?: number;
  demuxCorrupted?: number;
  decodedVideo?: number;
  decodedAudio?: number;
  displayedPictures?: number;
  inputBitrate?: number;
}

interface PluginShape {
  capabilities(): Promise<NativeCapabilities>;
  load(o: {
    url: string; userAgent?: string; startAtMs?: number;
    headers?: Record<string, string>;
    /** Decode in software, whatever MediaCodec thinks. See the plugin. */
    software?: boolean;
    /** false bypasses the device's own relay (the operator's off-switch). */
    relay?: boolean;
    /** A channel rather than a film — libVLC caches the two differently. */
    live?: boolean;
    /** Live only: libVLC `network-caching`, from the viewer's buffer setting. */
    bufferMs?: number;
  }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(o: { timeMs: number }): Promise<void>;
  setRate(o: { rate: number }): Promise<void>;
  setBounds(o: { x: number; y: number; width: number; height: number }): Promise<void>;
  /**
   * What the container carries, and which of it libVLC is currently playing.
   *
   * `audioSelected` / `subtitleSelected` are the plugin's own reading of
   * `getAudioTrack()` / `getSpuTrack()`. They are not decoration: a dubbed film
   * opens on whichever track the file marks default, which is not always the
   * first, and a list that marks the wrong row as on is worse than one that
   * marks none.
   */
  tracks(): Promise<{
    audio: { id: number; label: string }[];
    subtitles: { id: number; label: string }[];
    audioSelected?: number;
    subtitleSelected?: number;
    chapters?: { startS: number; label?: string }[];
  }>;
  selectTrack(o: { type: 'audio' | 'subtitle'; id: number }): Promise<void>;
  addListener(event: 'playerEvent', cb: (e: NativeEvent) => void): Promise<{ remove(): Promise<void> }>;
  setAwake(o: { on: boolean }): Promise<void>;
  setImmersive(o: { on: boolean }): Promise<void>;
  /**
   * The colour around the edge of the frame libVLC is showing.
   *
   * The one question a WebView cannot answer about this path: the film is on an
   * Android surface behind the page, so there is nothing in the document to
   * sample. `PixelCopy` reads the surface back on the native side — see
   * `ambient` in StreamixPlayerPlugin. `lit: false` carries `why`, which is
   * either temporary (nothing playing yet) or permanent (a protected buffer, or
   * a WebView older than API 24), and `lib/ambient.ts` decides which by name.
   */
  ambient(): Promise<{ lit: boolean; why?: string; r?: number; g?: number; b?: number }>;
}

let plugin: PluginShape | null = null;
/** Capacitor's proxy, which is registered once however many times it is probed. */
let proxy: PluginShape | null = null;
/**
 * How many times a failed probe is retried before the answer is taken as no.
 *
 * Three, which is one at boot and two more on the streams after it — enough to
 * outlast a bridge that was not ready, and few enough that a web build spends
 * nothing worth measuring on discovering it is a web build.
 */
const PROBE_TRIES = 3;
let probes = 0;

/**
 * The plugin, or null on the web.
 *
 * Loaded through Capacitor's registry rather than imported, so the web build
 * neither bundles it nor fails when it is absent — the same reason
 * `@capacitor/preferences` is a dynamic import in `kv.ts`.
 */
export async function nativeEngine(): Promise<PluginShape | null> {
  if (plugin !== null) return plugin;
  if ((import.meta.env?.VITE_PLATFORM as string | undefined) !== 'capacitor') return null;
  /* iOS has no StreamixPlayer: don't register a proxy that can only reject. */
  if (!nativePluginsPossible()) return null;
  /*
   * A FAILED probe is not an answer, and it used to be treated as one.
   *
   * `looked` was set before the probe and never cleared, so a single unlucky
   * `capabilities()` call — one that rejects because the plugin is still
   * starting, or because the bridge was busy at boot — marked an APK that ships
   * libVLC as "WebView only" for the whole session. A customer's own debug
   * report shows exactly that: `Native engine: none — WebView only`, from an
   * installed app on Android 14, where the plugin is in the package.
   *
   * The consequence is not subtle: with no native engine there is no HEVC, no
   * AC-3, no software fallback and no escalation, so every codec the WebView
   * refuses becomes a dead channel on a device that could have played it.
   *
   * So only a SUCCESS is remembered. A failure is retried, at most `PROBE_TRIES`
   * times, which bounds the cost on the web build and on an older APK that
   * genuinely has no plugin.
   */
  if (probes >= PROBE_TRIES) return null;
  probes += 1;
  try {
    const core = await import('@capacitor/core');
    if (!core.Capacitor.isNativePlatform()) {
      probes = PROBE_TRIES;
      return null;
    }
    /*
     * Registered ONCE, and kept.
     *
     * `registerPlugin` returns a proxy whether or not the native class exists, so
     * the only honest test is a call the native side has to answer — and the
     * retries above mean that call can happen three times. Asking Capacitor to
     * register the same name again is harmless (it warns and hands back the proxy
     * it already has) but the warning goes into the app's own debug log, where it
     * reads like a fault:
     *
     *     console  Capacitor plugin "StreamixPlayer" already registered.
     *              Cannot register plugins twice.
     *
     * Photographed off a television, above the line that says the native engine
     * was not found, which is exactly the wrong thing to have to rule out while
     * reading a report. One registration, kept across the retries; only the CALL
     * is repeated, which is the part that was ever in doubt.
     */
    if (proxy === null) proxy = core.registerPlugin<PluginShape>('StreamixPlayer');
    const candidate = proxy;
    lastCaps = await candidate.capabilities();
    plugin = unthenable(candidate, METHODS);
    return plugin;
  } catch {
    // No plugin, or an older APK without it: the WebView remains the player —
    // for now. The next stream asks again, until the tries run out.
    return null;
  }
}

const METHODS = [
  'capabilities', 'load', 'play', 'pause', 'stop', 'seek', 'setRate', 'setBounds',
  'tracks', 'selectTrack', 'addListener', 'setAwake', 'setImmersive', 'ambient',
] as const;

/* The proxy trap and the two features it cost now live in `lib/unthenable.ts`,
   because the updater rediscovered it three days after the player did. Imported
   for the call site below and re-exported so its test is unchanged. */
import { unthenable } from './unthenable.ts';

export { unthenable };

/**
 * Keep the screen on, by whichever route this platform offers.
 *
 * Two, because neither covers everything. The Screen Wake Lock API is the right
 * answer and works in a modern Chromium — but it needs a secure context and is
 * missing from the older WebViews on exactly the TV boxes that matter here. The
 * plugin sets `FLAG_KEEP_SCREEN_ON` on the window, which works everywhere the APK
 * runs and nowhere else. Asking both and ignoring the failures is smaller than
 * detecting which one to use.
 */
let sentinel: { release: () => Promise<void> } | null = null;

export async function setScreenAwake(on: boolean): Promise<void> {
  const engine = await nativeEngine().catch(() => null);
  if (engine) await engine.setAwake({ on }).catch(() => {});

  const wl = (navigator as Navigator & {
    wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
  }).wakeLock;
  if (!wl) return;
  try {
    if (on) {
      if (sentinel === null) sentinel = await wl.request('screen');
    } else if (sentinel !== null) {
      const held = sentinel;
      sentinel = null;
      await held.release();
    }
  } catch {
    /* Denied in a background tab, or unsupported. The flag above still applies. */
  }
}

/**
 * Hide the system bars while the video is fullscreen.
 *
 * A no-op on the web, where the Fullscreen API already does this. Failures are
 * swallowed for the same reason as everywhere else in this file: a missing plugin
 * method must not be able to stop playback.
 */
export async function setImmersive(on: boolean): Promise<void> {
  const engine = await nativeEngine().catch(() => null);
  if (engine) await engine.setImmersive({ on }).catch(() => {});
}

/**
 * Is there a native engine at all, answered synchronously?
 *
 * `nativeEngine()` is async because proving the plugin exists means calling it.
 * An escalation decision cannot wait for that — it happens inside an error
 * handler, and the alternative to answering now is showing an error box and then
 * changing our mind. So this reports what the probe already established, and is
 * only ever true after `nativeEngine()` has succeeded once, which
 * `primeCapabilities()` arranges shortly after the first paint.
 */
/**
 * What this box calls its decoders — for a report, not for a decision.
 *
 * `OMX.MS.AVC.Decoder` refusing a stream that `c2.android.avc.decoder` plays is
 * the shape of a vendor firmware fault, and it is invisible from the page: the
 * capability probe already asks for it and nothing ever kept the answer. Held
 * from the probe rather than asked again, because the plugin call costs a round
 * trip and the answer cannot change while the app is open.
 *
 * Empty in a browser, empty on an older APK, and deliberately capped: a report
 * is read by a person, and thirty decoder names is a wall rather than a clue.
 */
const DECODERS_SHOWN = 8;

let lastCaps: NativeCapabilities | null = null;

export function nativeDecoderNames(): string[] {
  const seen = new Set<string>();
  for (const c of lastCaps?.codecs ?? []) {
    for (const d of c.decoders) {
      if (seen.size >= DECODERS_SHOWN) break;
      seen.add(d);
    }
  }
  return [...seen];
}

export function hasNativeEngine(): boolean {
  return plugin !== null;
}

/**
 * Has anybody actually asked yet?
 *
 * `hasNativeEngine()` answers "no" both for a device that has no libVLC and for
 * one that has not been asked, and a report cannot tell those apart. One real
 * debug log is the case: the header said
 *
 *     Native engine: none — WebView only
 *
 * on a television whose next log line, half a second later, was "plugin answered
 * — libVLC available". The header was written before the probe ran, and it read
 * as a verdict. So a report can now say "not asked yet" instead of guessing.
 */
export function nativeEngineAsked(): boolean {
  return plugin !== null || probes > 0;
}

/** MIME types, per codec id, as the Android codec register names them. */
export const MIMES: Record<string, string[]> = {
  h264: ['video/avc'],
  hevc: ['video/hevc'],
  av1: ['video/av01'],
  vp9: ['video/x-vnd.on2.vp9'],
  /* Taken from AOSP's `MediaFormat` constants rather than guessed, because two of
     them are not what you would write down: TrueHD is `audio/vnd.dolby.mlp`, and
     DTS is `audio/vnd.dts` with separate HD and UHD registrations. */
  mpeg2: ['video/mpeg2'],
  mpeg4p2: ['video/mp4v-es'],
  dolbyvision: ['video/dolby-vision'],
  aac: ['audio/mp4a-latm'],
  ac3: ['audio/ac3'],
  eac3: ['audio/eac3', 'audio/eac3-joc'],
  ac4: ['audio/ac4'],
  dts: ['audio/vnd.dts', 'audio/vnd.dts.hd', 'audio/vnd.dts.uhd'],
  truehd: ['audio/vnd.dolby.mlp'],
  /*
   * `audio/mpeg` is MP3's MIME, and it was in this list — so "does this device
   * decode MPEG-2 Layer II" was answered yes by the presence of an MP3 decoder,
   * which every Android device has ever had. The answer was therefore always yes
   * and never meant anything. The layer-specific names are vendor spellings
   * rather than AOSP constants, so both casings are accepted and neither is
   * assumed.
   */
  mp2: ['audio/mpeg-L2', 'audio/mpeg-l2', 'audio/mpeg-L1', 'audio/mpeg-l1'],
  mp3: ['audio/mpeg'],
  opus: ['audio/opus'],
  flac: ['audio/flac'],
  vorbis: ['audio/vorbis'],
};

/**
 * Does the DEVICE have a decoder for this, whatever the WebView claims?
 *
 * The usual answer on Android is yes — a phone that refuses HEVC in Chromium
 * almost always has an HEVC decoder in `MediaCodecList`, because the browser's
 * refusal is a licensing decision rather than a hardware one. That gap is the
 * whole argument for shipping a native engine.
 */
export function deviceHasDecoder(caps: NativeCapabilities | null, codecId: string): boolean {
  if (!caps) return false;
  const wanted = MIMES[codecId] ?? [];
  return caps.codecs.some((c) => wanted.includes(c.mime));
}

export type EngineChoice = 'webview' | 'native';

/**
 * Which engine should play this.
 *
 * Deliberately conservative, in this order:
 *
 * 1. No native engine — the web build, or an APK without the plugin — is always
 *    the WebView.
 * 2. A container the browser cannot demux at all (MKV, AVI) is native.
 * 3. A codec the capability report says this WebView will not decode is native,
 *    because the alternative is a black screen.
 * 4. Everything else stays in the WebView, where the page can still composite
 *    over the picture.
 */
/* ── which engine, and the two things that decide it ──────────────────────────
   `chooseEngine` used to answer purely from what was known BEFORE pressing play:
   a hostile file extension, or a codec string the capability report had already
   condemned. For a film that is often enough. For a live channel it is almost
   never enough — the panel publishes no codec for one, so the answer was always
   "webview", and the WebView's decoder gaps are exactly the gaps libVLC exists to
   cover. Which is why the APK behaved identically to the website.

   Two additions close it:

   `EnginePref` — an explicit override, because "this device cannot play channel
   X" is something its owner can see and this code cannot.

   `rememberNeedsNative` — a decode failure escalates to libVLC once (see
   `PlayerCore.escalate`), and if libVLC plays it, that is recorded. The next
   press of play goes straight there. Keyed by stream rather than by codec because
   the codec is precisely what was unknown. */

export type EnginePref = 'auto' | 'webview' | 'native';

const PREF_KEY = 'iptv.engine';
const LEARNED_KEY = 'iptv.engine.learned';
/**
 * Channels the viewer has asked to play in the BROWSER engine, one at a time.
 *
 * The opposite of `LEARNED_KEY`, and it exists for one reason: live captions.
 * They listen to the `<video>` element, a channel the native engine is playing
 * has nothing in that element, and the only place the audio can be reached
 * without a second connection to the panel or a byte of anyone else's bandwidth
 * is the page itself. So "play this one in the browser engine" became a button
 * beside the captions instead of a trip to Settings and a preference that
 * changes every channel at once.
 */
const BROWSER_KEY = 'iptv.engine.browser';
/** Keep the lists small: a device's real codec tail is a handful of channels. */
const LEARNED_MAX = 200;

export function getEnginePref(): EnginePref {
  try {
    const v = kv.get(PREF_KEY);
    return v === 'webview' || v === 'native' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setEnginePref(v: EnginePref): void {
  try {
    kv.set(PREF_KEY, v);
  } catch {
    /* private mode */
  }
}

/**
 * A stable key for "this stream" — the FALLBACK, when the caller has no ref.
 *
 * Panel URLs carry credentials and, on live, redirect to a minted token path that
 * changes every session, so the full URL was never an identity. Nor are the last
 * two path segments: they are `<password>/<id>.ext`, and keying on them would
 * write the subscription's password into `kv` under `iptv.engine.learned`, where
 * it would sit for two hundred entries and reach anywhere that list is ever
 * printed.
 *
 * So the key is the KIND and the FINAL segment: `live/2116347.m3u8`. Unique per
 * stream within a subscription, stable across sessions, and carrying nothing
 * secret. Callers that can identify the row should still pass `PlayerCore.load`'s
 * `key` option — a catalogue ref is stable across subscriptions too, which is
 * what the learned list actually wants.
 */
export function streamKey(url: string): string {
  try {
    const u = new URL(url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean);
    // Indexed rather than `.at(-1)`: the oldest TV WebViews (Chrome < 92) lack it,
    // and `bundle-floor.mjs` flags it for that reason.
    const last = parts[parts.length - 1] ?? u.pathname;
    /* `live`, `movie` or `series` when the panel used the prefixed form. Anything
       else — a playlist entry, the legacy no-prefix live form — is keyed on its
       host instead, which is the only stable thing such a URL has. */
    const kind = parts.find((seg) => seg === 'live' || seg === 'movie' || seg === 'series');
    return kind === undefined ? `${u.host}/${last}` : `${kind}/${last}`;
  } catch {
    return url.slice(-64);
  }
}

function learned(): string[] {
  try {
    const raw = kv.get(LEARNED_KEY);
    const v: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** `key` is a catalogue ref when the caller had one, else a `streamKey`. */
export function needsNative(key: string): boolean {
  return learned().includes(key);
}

/** Record that the WebView could not decode this and libVLC could. */
export function rememberNeedsNative(key: string): void {
  /*
   * And drop any request to play it in the browser engine.
   *
   * That request is read BEFORE this list in `chooseEngine`, deliberately: an
   * explicit choice should be tried. But once the WebView has actually failed on
   * this stream and libVLC has actually played it, the choice has been answered
   * by the stream itself — and leaving it in would pin a channel to an engine
   * that has just been measured going black, with no way back.
   */
  forgetWantsBrowser(key);
  const list = learned().filter((k) => k !== key);
  list.unshift(key);
  try {
    kv.set(LEARNED_KEY, JSON.stringify(list.slice(0, LEARNED_MAX)));
  } catch {
    /* private mode */
  }
}

function browserPinned(): string[] {
  try {
    const raw = kv.get(BROWSER_KEY);
    const v: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Has the viewer asked for this one stream to play in the browser engine? */
export function wantsBrowser(key: string): boolean {
  return browserPinned().includes(key);
}

/** Remember it, for this stream only — not as a preference over all of them. */
export function rememberWantsBrowser(key: string): void {
  const list = browserPinned().filter((k) => k !== key);
  list.unshift(key);
  try {
    kv.set(BROWSER_KEY, JSON.stringify(list.slice(0, LEARNED_MAX)));
  } catch {
    /* private mode */
  }
}

export function forgetWantsBrowser(key: string): void {
  const list = browserPinned();
  if (!list.includes(key)) return;
  try {
    kv.set(BROWSER_KEY, JSON.stringify(list.filter((k) => k !== key)));
  } catch {
    /* private mode */
  }
}

/** This stream was pinned to libVLC and libVLC did not play it — unpin it. */
export function forgetNeedsNative(key: string): void {
  const list = learned();
  if (!list.includes(key)) return;
  try {
    kv.set(LEARNED_KEY, JSON.stringify(list.filter((k) => k !== key)));
  } catch {
    /* private mode */
  }
}

export function forgetLearnedEngines(): void {
  try { kv.set(BROWSER_KEY, '[]'); } catch { /* private mode */ }
  try {
    kv.set(LEARNED_KEY, '[]');
  } catch {
    /* private mode */
  }
}

/**
 * Containers to hand to libVLC when there IS a libVLC — the APK's rule.
 *
 * "Prefer the native engine for these", not "these are impossible". MKV and
 * MPEG-TS are on the list because the native engine is better at them, not
 * because nothing else can try: a browser plays plenty of MKV, and mpegts.js
 * remuxes TS in JavaScript. Doing that remux on a television is what made live
 * channels play for ten seconds and then take the app down, which is why the
 * APK routes both to libVLC — see `chooseEngine`.
 */
const NOT_DEMUXABLE = new Set(['mkv', 'avi', 'wmv', 'flv', 'vob', 'ts']);

export function browserCannotDemux(url: string): boolean {
  return extensionOf(url) !== null && NOT_DEMUXABLE.has(extensionOf(url)!);
}

/**
 * Containers with NO path at all in a browser — a much shorter list, and the
 * only one it is safe to refuse a file over.
 *
 * ── the bug this exists to not repeat ──
 *
 * These two questions were one list, and answering the second with the first
 * broke the website: "on the web version nothing plays anymore now", within a
 * day of shipping it. MKV is most of this catalogue — 53,168 films — and Chrome
 * plays Matroska carrying H.264/AAC perfectly well; `.ts` is demuxed in
 * JavaScript by mpegts.js, which the web player loads for exactly that. Refusing
 * both up front took the whole library off the web in one line.
 *
 * The complaint that prompted the refusal was real — 8.2 MB of ranged requests
 * and then "Playback failed" on an MKV — but the container was never the reason
 * that film failed, because MKVs beside it play. The codec inside it was, and
 * `lib/codecs.ts` already names that after the element refuses it. A guess made
 * before the first byte cannot tell those apart; only the element can.
 *
 * So what stays here is the set where the guess cannot be wrong: no browser
 * ships a demuxer for AVI, WMV, VOB or FLV, and nothing in this app supplies
 * one. Anything else gets to try.
 */
const NO_WEB_PATH = new Set(['avi', 'wmv', 'vob', 'flv']);

/** True only when no browser could open this container by any route we have. */
export function webHasNoPathFor(url: string): boolean {
  const ext = extensionOf(url);
  return ext !== null && NO_WEB_PATH.has(ext);
}

/**
 * A film or an episode, by the panel's own path for them.
 *
 * Expanded to match more VOD URL patterns because some panels use different
 * paths (vod, clip) or serve direct file URLs. Fire OS 7 especially benefits
 * from catching all VOD patterns so libVLC can play them instead of the
 * frozen WebView, which may not decode the codec.
 */
export function isFilmUrl(url: string): boolean {
  return /\/(movie|series|vod|clip)\//i.test(url)
    || /\.(mp4|mkv|avi|m4v|wmv|flv|mov)(?:[?#]|$)/i.test(url);
}

/** The file extension of a stream URL, lowercased, or null. */
function extensionOf(url: string): string | null {
  return /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? null;
}

export function chooseEngine(opts: {
  native: boolean;
  container: string | null;
  url: string;
  /** Catalogue ref when the caller has one; falls back to the URL's stream key. */
  key?: string;
  /** From the catalogue or the panel, when known before pressing play. */
  codec?: string | null;
  report?: CapabilityReport | null;
}): EngineChoice {
  if (!opts.native) return 'webview';

  const pref = getEnginePref();
  if (pref === 'native') return 'native';
  if (pref === 'webview') return 'webview';

  const key = opts.key ?? streamKey(opts.url);

  /*
   * The viewer asked for THIS stream in the browser engine — almost always to
   * get captions on it, which cannot hear a native surface.
   *
   * Read before the container rule below, because that rule is what sends every
   * `.ts` to libVLC and every live channel here is a `.ts`; a request that the
   * next line overrules is not a request. It is still one stream, not a
   * preference: everything else keeps going where it was going. And
   * `rememberNeedsNative` deletes it the moment the WebView is measured failing
   * on this stream, so a bad choice heals itself on the next play.
   */
  if (wantsBrowser(key)) return 'webview';

  // Learned the hard way, on this device, from this stream failing to decode.
  if (needsNative(key)) return 'native';
  /*
   * Fire OS forces libVLC for all VOD, bypassing the frozen WebView.
   *
   * Fire OS 7 ships an Amazon WebView (AWV) that is a frozen Chromium build
   * that cannot be updated independently. Even if a URL doesn't match the
   * known film patterns, the WebView is unreliable for VOD on this platform.
   * libVLC handles all codecs in hardware with software fallback.
   */
  const platform = currentPlatform();
  if (platform === 'fireos' && !opts.url.includes('.m3u8') && !opts.url.includes('.ts')) {
    return 'native';
  }

  /*
   * Films and episodes go to libVLC, whatever the container says.
   *
   * The WebView went first for an MP4 carrying H.264 and AAC, on the grounds
   * that it can decode that. Three things measured on 2026-09-28 say that is the
   * wrong question on a television:
   *
   *   - a real customer's MediaTek TV (Chromium 118) and the TV emulator both
   *     had the WebView refuse ordinary MP4 films outright — "Format error" —
   *     before a byte reached the panel;
   *   - the fall back from there runs a one-byte probe first, which on a line
   *     that allows ONE connection takes the slot, so libVLC opened after it
   *     and was refused: 25 seconds of black, then an error;
   *   - a `<video>` seek opens a new ranged request while the old one lingers,
   *     which a one-connection line refuses (see `lib/oneConnection.ts`).
   *
   * libVLC decodes in hardware and falls back to software per stream, and on
   * this device it plays through `OneConnectionRelay`, which waits for the
   * panel to free the slot instead of passing a refusal on — measured seeking,
   * rewinding and resuming after a 40-second pause on a one-connection panel.
   * A viewer who asked for the browser engine on a title (for captions) is
   * still answered above.
   */
  if (isFilmUrl(opts.url)) return 'native';

  /*
   * Containers no browser can demux — and MPEG-TS is one of them.
   *
   * `.ts` used to be listed here and then exempted, on the grounds that mpegts.js
   * remuxes it in the page and "usually works". A debug log photographed off a
   * real television is what removed the exemption:
   *
   *     20:30:47.192  player   opening VTM 2
   *     20:30:47.944  player   load mpegts …/812064.ts
   *     20:30:48.003  native   not chosen — the WebView goes first
   *     20:30:49.158  player   playing via mpegts
   *     20:30:49.492  console  [StartupStallJumper] > Playback seems stuck at 0,
   *                            seek to 0.132
   *
   * Every live channel on this line is a raw `.ts`, so every live channel was
   * being demuxed by JavaScript into MSE on a television — and mpegts.js is
   * fighting it inside a second of starting. What the viewer sees is "it works
   * for about ten seconds", then a black picture, then the app going away, which
   * is what an MSE buffer on a memory-tight box does when it loses.
   *
   * libVLC is in this APK precisely to demux MPEG-TS. It is a C demuxer feeding a
   * hardware decoder, it is what every other IPTV player on these boxes uses, and
   * it does not compete with the page for the renderer's memory. On a device that
   * HAS it, handing it the container it exists for is not an escalation — it is
   * the first answer.
   *
   * ── and captions ──
   *
   * Live captions listen to the `<video>` element, and a channel libVLC is
   * playing does not have one. The APK hears it instead by capturing its own
   * decoded sound on the device — see `lib/nativeListen.ts`.
   *
   * Nothing changes on the web build: `native` is false there and this function
   * has already returned.
   */
  if (browserCannotDemux(opts.url)) return 'native';

  /*
   * EVERY codec named, not the first one that matches.
   *
   * `matchCodec` takes one string and tests video patterns before audio ones, so
   * handing it `"h264,eac3"` returns H.264 and the E-AC-3 is never weighed — and
   * H.264 is exactly the codec every WebView says yes to. The result was a file
   * routed to the WebView on the strength of the half of it that was fine, which
   * plays a picture with no sound and raises no error while it does.
   *
   * That is not hypothetical for this catalogue: measured across 1,586 episodes
   * (`scripts/series-probe.mjs`, 2026-09-07), 19.5% carry AC-3, E-AC-3 or DTS
   * audio, and 4.2% are an `.mp4` — a container the extension rule above lets
   * through — carrying AC-3. Splitting on the separators panels actually use and
   * asking about each part is the whole fix.
   */
  const specs = String(opts.codec ?? '')
    .split(/[,+/|\s]+/)
    .map((part) => matchCodec(part))
    .filter((spec): spec is NonNullable<typeof spec> => spec !== null);
  for (const spec of specs) {
    if (!opts.report) break;
    const row = opts.report.codecs.find((c) => c.id === spec.id);
    /*
     * `browserVerdict`, NOT `verdict` — and the difference is the whole point.
     *
     * `verdict` now answers "can this APP play it", which on a build carrying
     * libVLC is yes for AC-3, E-AC-3 and MPEG audio precisely BECAUSE this
     * function sends them to the native engine. Reading it here would be circular:
     * the report would say yes, this would leave the stream in the WebView, the
     * WebView would fail to decode it, and `escalate()` would arrive at the native
     * engine anyway — one visible failure and one reload later than it should
     * have. The question at this line is the narrow one: will the WEBVIEW manage
     * it? That is what `browserVerdict` answers.
     */
    const browser = row?.browserVerdict ?? row?.verdict;
    if (row && (browser === 'no' || browser === 'unlikely' || row.disputed)) return 'native';
  }
  return 'webview';
}
