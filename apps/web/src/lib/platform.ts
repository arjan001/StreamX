/**
 * Which platform is this, and what can its player do?
 *
 * One answer for the questions the player keeps asking: is there a native plugin
 * to call, which engine plays this container, what does a live channel get asked
 * for. The inputs are passed in so each rule is a pure function with a test; the
 * `current*` wrappers read the real environment.
 *
 * Five platforms, because they play differently:
 *
 *   android  Capacitor shell. libVLC (`StreamixPlayer`) behind the page; the web
 *            engines are the first try and libVLC the escalation.
 *   ios      Capacitor shell, WKWebView. NO native plugin: every `Streamix*`
 *            plugin is Android Java. HLS is played by the platform itself.
 *   tizen / webos  Packaged web build, no Capacitor, no libVLC.
 *   web      A browser tab.
 *
 * Tizen and webOS are told apart by user agent only; nothing branches on them
 * except this file, and the web path serves both.
 */

export type Platform = 'ios' | 'android' | 'fireos' | 'tizen' | 'webos' | 'web';

export interface PlatformEnv {
  /** `Capacitor.getPlatform()`, when Capacitor is present in the page. */
  capacitor?: string | null;
  userAgent?: string;
  /** `navigator.maxTouchPoints` — an iPad in desktop mode claims to be a Mac. */
  touchPoints?: number;
}

export function platformOf(env: PlatformEnv): Platform {
  const ua = env.userAgent ?? '';
  /*
   * Fire OS detection before Capacitor platform check.
   *
   * Fire OS 7 (Android 9) reports `android` from Capacitor, but its Amazon WebView
   * is a frozen Chromium build that cannot be updated independently. Detecting it
   * as 'fireos' allows targeted fixes for its known WebView limitations while
   * keeping the same native plugin path (libVLC works on Fire OS).
   */
  if (/FireTV|Fire TV|AFT|FDR|FN|AFTT/i.test(ua)) return 'fireos';
  const cap = (env.capacitor ?? '').toLowerCase();
  if (cap === 'ios' || cap === 'android') return cap;
  if (/Tizen/i.test(ua)) return 'tizen';
  if (/Web0S|webOS|NetCast/i.test(ua)) return 'webos';
  /* A bare Safari on iOS is the same engine and the same constraints as the
     app's WKWebView, so it takes the same player path. iPadOS 13+ sends a
     desktop-Safari string; the touch screen is what gives it away. */
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Macintosh/.test(ua) && (env.touchPoints ?? 0) > 1) return 'ios';
  if (/Android/i.test(ua) && cap !== '') return 'android';
  return 'web';
}

let cached: Platform | null = null;

/** The platform of the page we are running in; resolved once. */
export function currentPlatform(): Platform {
  if (cached !== null) return cached;
  const g = globalThis as { Capacitor?: { getPlatform?: () => string }; __streamixPlatform?: Platform };
  /* A test hook: a browser smoke test forces the iOS path by setting this before
     the bundle loads. Nothing in the product sets it. */
  if (g.__streamixPlatform !== undefined) return (cached = g.__streamixPlatform);
  let capacitor: string | null = null;
  try { capacitor = g.Capacitor?.getPlatform?.() ?? null; } catch { /* not in a shell */ }
  const nav = typeof navigator === 'undefined' ? null : navigator;
  cached = platformOf({
    capacitor,
    userAgent: nav?.userAgent ?? '',
    touchPoints: nav?.maxTouchPoints ?? 0,
  });
  return cached;
}

/** For tests: forget the cached answer. */
export function resetPlatformCache(): void {
  cached = null;
}

export function isIos(): boolean {
  return currentPlatform() === 'ios';
}

/**
 * Could the `Streamix*` Capacitor plugins exist on this platform?
 *
 * They are Java classes in the Android project (`StreamixPlayer`, `StreamixDevice`,
 * `StreamixListen`). The iOS project has none, and Capacitor's `registerPlugin`
 * returns a proxy either way — on iOS a call to it rejects with "not implemented",
 * and one that is never awaited is an unhandled rejection in the debug log. So
 * every place that reaches for one asks this first and gets `null` back.
 *
 * Phrased as "not iOS" rather than "is Android" on purpose: Android keeps the
 * probe it has always made (the only honest test there is a call the native side
 * must answer), and a page that has not yet seen Capacitor's bridge must not be
 * mistaken for a platform without plugins.
 */
export function streamixPluginsPossible(platform: Platform): boolean {
  return platform !== 'ios' && platform !== 'web' && platform !== 'tizen' && platform !== 'webos';
}

/**
 * Can a Stalker / MAG portal be used on this platform?
 *
 * A portal identifies the box by a `Cookie: mac=...` header and a set-top-box
 * `User-Agent`. Both are forbidden request headers in a browser, so a page's own
 * fetch cannot send them and the portal answers "Authorization failed". Only the
 * Capacitor shells have an HTTP layer (`CapacitorHttp`) that can. Tizen and webOS
 * are packaged WEB builds with the same restriction on the client side, so they
 * do not offer the source either.
 */
export function stalkerSupportedOn(platform: Platform): boolean {
  return platform === 'android' || platform === 'fireos' || platform === 'ios';
}

export function stalkerSupported(): boolean {
  return stalkerSupportedOn(currentPlatform());
}

/** `streamixPluginsPossible` for the running page. */
export function nativePluginsPossible(): boolean {
  return streamixPluginsPossible(currentPlatform());
}

/* ── which engine plays what ─────────────────────────────────────────────── */

export type WebEngine = 'native-hls' | 'hlsjs' | 'mpegts' | 'file' | 'unsupported';

export interface EngineFacts {
  platform: Platform;
  container: 'hls' | 'mpegts' | 'file';
  /** `video.canPlayType('application/vnd.apple.mpegurl')` is non-empty. */
  nativeHls: boolean;
  /** `Hls.isSupported()`; only asked for off iOS, so may be left false there. */
  hlsJs: boolean;
  /** `mpegts.isSupported()` — needs MediaSource (iPhone: ManagedMediaSource only). */
  mpegts: boolean;
}

/**
 * The page-side engine for a stream. libVLC (Android) is decided before this and
 * is not part of it.
 *
 * iOS prefers the platform's own HLS player over hls.js: hls.js there rides
 * ManagedMediaSource (iOS 17.1+ iPhone only; absent before that), which costs
 * battery and buys nothing over AVFoundation, which also handles AirPlay and the
 * system controls. Everywhere else hls.js stays first and native HLS (Safari) is
 * the fallback — exactly what the player did before iOS existed.
 */
export function pickWebEngine(f: EngineFacts): WebEngine {
  if (f.container === 'mpegts') return f.mpegts ? 'mpegts' : 'unsupported';
  if (f.container === 'file') return 'file';
  if (f.platform === 'ios') {
    if (f.nativeHls) return 'native-hls';
    return f.hlsJs ? 'hlsjs' : 'unsupported';
  }
  if (f.hlsJs) return 'hlsjs';
  return f.nativeHls ? 'native-hls' : 'unsupported';
}

/**
 * What to ask a panel for when the viewer wants live TV.
 *
 * An Xtream line offers `.ts` (raw MPEG-TS) and `.m3u8` (HLS). WKWebView cannot
 * demux `.ts` — no MediaSource on iPhone before iOS 17.1, ManagedMediaSource
 * after — but plays `.m3u8` natively, so iOS always asks for HLS. The requested
 * format is a hint everywhere else and stays one.
 */
export function liveFormatFor(
  platform: Platform,
  requested: 'ts' | 'm3u8' | undefined,
): 'ts' | 'm3u8' | 'auto' {
  if (platform === 'ios') return 'm3u8';
  return requested ?? 'auto';
}

/**
 * Whether the live-caption pipeline can run here.
 *
 * Captions transcribe the `<video>` element's audio through `captureStream()`
 * (or a MediaElementSource). On iOS neither works: WebKit has no
 * `HTMLMediaElement.captureStream`, and a MediaElementSource over a native-HLS
 * element yields silence because AVFoundation, not WebAudio, owns that audio.
 * Android uses `StreamixListen`, the only other route, which iOS does not have.
 */
export function liveCaptionsPossible(platform: Platform): boolean {
  return platform !== 'ios' && platform !== 'tizen' && platform !== 'webos';
}

/** The words for a stream iOS cannot open, shown instead of a decoder error. */
export const IOS_CANNOT_PLAY = {
  mpegts: {
    message: 'This channel cannot be played on iPhone or iPad',
    hint: 'It is only offered as raw MPEG-TS, which iOS cannot open. If the source also '
        + 'offers HLS (.m3u8), choose that format in the source settings.',
  },
  container: {
    message: 'This file format cannot be played on iPhone or iPad',
    hint: 'iOS plays MP4, M4V and MOV (H.264 or HEVC video with AAC or AC-3 sound). '
        + 'MKV and AVI files cannot be opened here.',
  },
} as const;

/** Containers WebKit on iOS will not open as a film. */
export function iosCannotOpenFile(url: string): boolean {
  return /\.(mkv|avi|wmv|flv|m2ts|mpg|mpeg|divx)(?:[?#]|$)/i.test(url);
}
