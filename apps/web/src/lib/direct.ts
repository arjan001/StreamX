/**
 * Whether this client can load plaintext subresources itself.
 *
 * This file used to answer a bigger question — "can this client fetch its own
 * media, or must the server relay it" — and the header explained at length why a
 * browser had no choice but the relay: the provider was plaintext-only, an HTTPS
 * page blocks plaintext subresources, and `fetch` cannot set the User-Agent the
 * panel's WAF gates on.
 *
 * Two of those three turned out to be false when measured (`panel-probe.mjs`), and
 * the relay is gone. What is left is the one that is still true and always will
 * be: **an HTTPS page cannot load an `http://` image or stream.** That is not a
 * provider's policy, it is the browser's, and no measurement changes it.
 *
 * So this now answers only that, and it has two callers: whether a plaintext
 * channel needs a note explaining why it will not play here, and whether artwork
 * on a live plaintext host should go via the public image CDN.
 *
 * The APK has none of these constraints — `usesCleartextTraffic`,
 * `allowMixedContent` (which Capacitor turns into `MIXED_CONTENT_ALWAYS_ALLOW`),
 * a WebViewClient that accepts a bad certificate on a media host, and a native
 * libVLC engine that never involves a WebView at all.
 *
 * Answered at build time rather than by asking the bridge, because the very first
 * request the app makes has to know, and `Capacitor.isNativePlatform()` is behind
 * a dynamic import. The wrapper is its own build (`dist-app`), so the flag is
 * exact.
 */
import { getShape } from './formFactor.ts';

const NATIVE = (import.meta.env?.VITE_PLATFORM as string | undefined) === 'capacitor';

/**
 * A page already on plaintext can load plaintext.
 *
 * True for the dev server and for a LAN deployment over plain HTTP. There is no
 * mixed content to block and no reason to pay for the bytes.
 */
const PLAIN_PAGE = typeof location !== 'undefined' && location.protocol === 'http:';

export function isNativeShell(): boolean {
  return NATIVE;
}

/** Can this client load provider URLs without our help? */
export function fetchesItsOwnMedia(): boolean {
  return NATIVE || PLAIN_PAGE;
}

/*
 * `directHeaders()` was here, and with it `X-Iptv-Direct`.
 *
 * The server answered the same path two ways — a relay URL or a provider URL —
 * depending on what the caller said it could load, and `Vary: X-Iptv-Direct` kept
 * the two answers out of each other's caches. There is one answer now: the client
 * resolves everything itself, so there is nothing to tell the server and nothing
 * for it to vary on. `services/api/src/clientCtx.ts` went with it.
 */

/**
 * Should this client show playback diagnostics at all?
 *
 * "This container may not decode natively in a browser" is a useful sentence to a
 * developer looking at a failure on a desktop, and noise on a phone — where there
 * is no browser in the usual sense, the native engine plays the file anyway, and
 * the only effect of the line is to make a working film look broken. The server
 * already omits the browser-specific ones for a native client; this covers the
 * rest, including the ones the client writes itself.
 */
export function showDiagnostics(): boolean {
  if (NATIVE) return false;
  // A phone has no console to check the line against and no second engine to
  // switch to; the same sentence on a desktop is a diagnosis.
  return getShape().ff !== 'phone';
}
