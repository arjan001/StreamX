/**
 * Where "Open the store" goes.
 *
 * The app never downloads or installs anything itself; when a build is too old
 * to run, the only thing it can do is send the viewer to the store that shipped
 * it. One place holds the identifiers.
 */

/** The Android application id — the same one the Play listing uses. */
export const STORE_APP_ID = 'com.easyred.streamix';

/**
 * The App Store listing for iPhone and iPad. Set `VITE_APP_STORE_URL` at build
 * time once the listing exists; empty means the iOS build shows no button.
 */
export const APP_STORE_URL = ((import.meta.env?.VITE_APP_STORE_URL as string | undefined) ?? '').trim();

/** The store page for this device, or null when there is nowhere to send it. */
export function storeUrl(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string | null {
  if (/\b(?:tizen|web0s|webos|netcast|vidaa)\b/i.test(ua)) return null;
  if (/\b(?:iphone|ipad|ipod)\b/i.test(ua)) return APP_STORE_URL === '' ? null : APP_STORE_URL;
  if (/\bandroid\b/i.test(ua)) return `https://play.google.com/store/apps/details?id=${STORE_APP_ID}`;
  return null;
}
