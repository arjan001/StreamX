/**
 * The bridge between `playerCore` and the native engine.
 *
 * Kept out of `playerCore.ts` on purpose. That file is 900 lines of hard-won
 * behaviour — the backoff that survives a panel holding a session for two
 * minutes, the rate-based drift correction that replaced seeking, the pagehide
 * teardown that releases the single allowed connection — and the native path must
 * be something it can ASK about in one call, not something threaded through it.
 *
 * Everything here fails soft. If the plugin is missing, if it throws, if the
 * stream is one the WebView handles perfectly well, this returns null and the
 * existing engines play it. A native player that cannot be debugged from this
 * machine must not be able to take the whole app's playback down with it.
 */
import { chooseEngine, getEnginePref, nativeEngine, needsNative, streamKey } from './nativePlayer.ts';
import { dlog } from './debugLog.ts';
import { nativeCachingMs, resolveBufferProfile } from './liveBuffer.ts';
import { deviceRelayAllowed } from './operatorFlags.ts';
import { getCapabilities } from './capabilityStore.ts';
import { logInfo } from './sentry.ts';
import { currentPlatform } from './platform.ts';
import type { NativeEvent } from './nativePlayer.ts';

export interface NativeHandle {
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(ms: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  setBounds(rect: { x: number; y: number; width: number; height: number }): Promise<void>;
  /**
   * The tracks libVLC found inside the container.
   *
   * Without this the subtitle and audio buttons do nothing on exactly the files
   * the native engine exists for — an MKV with three audio languages and two
   * subtitle tracks is the normal case there, and the WebView never saw any of
   * them because it could not open the file.
   */
  tracks(): Promise<{
    audio: TrackRow[];
    subtitles: TrackRow[];
    /**
     * The container's own chapters, when it has any.
     *
     * Optional because most streams have none and because an older plugin will
     * not send the field at all. Absent and empty mean the same thing — this
     * title has no chapters — and the player draws no chapter controls for it
     * rather than dividing the runtime into invented parts. See lib/chapters.ts.
     */
    chapters?: { startS: number; label?: string }[];
    /**
     * Which audio and subtitle track libVLC is actually playing right now.
     *
     * Optional for the same reason `chapters` is — an older plugin does not send
     * them — and read rather than assumed because a dubbed film opens on the
     * track the FILE marks default, which is regularly not the first one. A menu
     * that lights the wrong row is worse than one that lights none.
     */
    audioSelected?: number;
    subtitleSelected?: number;
  }>;
  selectTrack(type: 'audio' | 'subtitle', id: number): Promise<void>;
}

export interface TrackRow { id: number; label: string }

/** The User-Agent the panel's WAF expects, matching the relay and the WebView. */
const UA = 'VLC/3.0.20 LibVLC/3.0.20';

export async function tryNative(
  target: { url: string; container: string; codec?: string | null; headers?: Record<string, string> },
  opts: {
    label: string;
    live: boolean;
    startAtMs: number;
    /** Catalogue ref for this stream, for the learned-engine list. */
    key?: string;
    onEvent: (e: NativeEvent) => void;
    /**
     * Skip the engine choice and use libVLC if it exists at all.
     *
     * Set only by `PlayerCore.escalate`, after the WebView has already failed to
     * decode this stream. At that point there is nothing to weigh up: the
     * alternative to trying is a red error box.
     */
    force?: boolean;
    /**
     * Decode in software, whatever the device's MediaCodec says.
     *
     * Set only by `PlayerCore`'s retry, after a hardware attempt has already
     * errored on a stream the server was demonstrably serving. libVLC picks
     * hardware first on its own and now falls back by itself too (the plugin no
     * longer passes `force` to `setHWDecoderEnabled`) — this is the second,
     * explicit attempt for the case where MediaCodec does not fail, it simply
     * produces nothing.
     */
    software?: boolean;
  },
): Promise<NativeHandle | null> {
  /* Web build: never touch Capacitor. Awaiting the plugin probe used to insert a
     microtask (and a dynamic import attempt) on every channel press. */
  if ((import.meta.env?.VITE_PLATFORM as string | undefined) !== 'capacitor') return null;

  let engine;
  try {
    engine = await nativeEngine();
  } catch {
    return null;
  }
  if (!engine) {
    dlog.info('native', 'no plugin answered — the WebView plays everything');
    return null;
  }

  if (opts.force !== true) {
    const choice = chooseEngine({
      native: true,
      container: target.container,
      url: target.url,
      ...(opts.key !== undefined ? { key: opts.key } : {}),
      codec: target.codec ?? null,
      report: getCapabilities(),
    });
    if (choice !== 'native') {
      dlog.info('native', 'not chosen — the WebView goes first');
      return null;
    }
    const pref = getEnginePref();
    const key = opts.key ?? streamKey(target.url);
    dlog.info('native', `chosen up front: ${pref === 'native' ? 'engine preference' : needsNative(key) ? 'learned for this stream' : 'container or codec rule'}`);
  } else {
    dlog.info('native', 'forced: the WebView already refused this stream');
  }

  /* Log engine choice on Fire OS for Sentry diagnostics. */
  const platform = currentPlatform();
  if (platform === 'fireos') {
    logInfo('Native engine chosen for playback on Fire OS', {
      label: opts.label,
      live: opts.live,
      container: target.container,
      force: opts.force ?? false,
    });
  }

  try {
    const sub = await engine.addListener('playerEvent', opts.onEvent);
    /* What the stream asked for (a playlist's `#EXTVLCOPT` / `#EXTHTTP` / `url|…`).
       libVLC is the only engine that can send a User-Agent or a Referer. */
    const headers = target.headers !== undefined && Object.keys(target.headers).length > 0
      ? target.headers : null;
    const userAgent = headers === null
      ? UA
      : Object.entries(headers).find(([k]) => k.toLowerCase() === 'user-agent')?.[1] ?? UA;
    await engine.load({
      url: target.url,
      userAgent,
      ...(headers === null ? {} : { headers }),
      /*
       * Live, and how much of it to hold — both of which the plugin has always
       * read and this call never sent. Without `live` libVLC treated every
       * channel as a film and gave it the film's one-second cache, whatever the
       * buffer setting said: "they added buffer but it didn't work".
       */
      live: opts.live,
      ...(opts.live ? { bufferMs: nativeCachingMs(resolveBufferProfile(opts.key ?? null)) } : {}),
      ...(opts.startAtMs > 0 ? { startAtMs: opts.startAtMs } : {}),
      ...(opts.software === true ? { software: true } : {}),
      /* The operator's off-switch for the device relay — see
         `deviceRelayOff` in the server's config. */
      ...(deviceRelayAllowed() ? {} : { relay: false }),
    });
    dlog.info('native', opts.software === true
      ? 'load() accepted — software decoding, waiting for the first frame'
      : 'load() accepted — waiting for the first frame');
    return {
      play: () => engine.play(),
      pause: () => engine.pause(),
      seek: (ms) => engine.seek({ timeMs: ms }),
      setRate: (rate) => engine.setRate({ rate }),
      setBounds: (rect) => engine.setBounds(rect),
      tracks: () => engine.tracks(),
      selectTrack: (type, id) => engine.selectTrack({ type, id }),
      stop: async () => {
        await sub.remove().catch(() => {});
        await engine.stop().catch(() => {});
      },
    };
  } catch (err) {
    // The plugin exists but refused this stream: hand it back to the WebView
    // rather than showing an error for something that may well play.
    dlog.warn('native', `plugin refused: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
