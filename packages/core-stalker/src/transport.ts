/**
 * The HTTP seam. Stalker portals identify the box by a `Cookie: mac=...` header
 * (and a custom User-Agent). Browsers forbid both, so on the web a plain fetch
 * silently drops them and the portal answers "Authorization failed". Devices must
 * therefore inject a native HTTP layer (Capacitor HTTP) here; global
 * fetch is only the default for Node and tests.
 */
export interface StalkerResponse {
  readonly status: number;
  text(): Promise<string>;
}

export interface StalkerRequestInit {
  readonly headers: Record<string, string>;
  readonly signal?: AbortSignal | undefined;
}

export type StalkerFetch = (url: string, init: StalkerRequestInit) => Promise<StalkerResponse>;

/** Resolved at call time so tests may stub `globalThis.fetch`. */
export const defaultStalkerFetch: StalkerFetch = (url, init) =>
  globalThis.fetch(url, {
    headers: init.headers,
    ...(init.signal ? { signal: init.signal } : {}),
  });

export const STB_USER_AGENT =
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
export const STB_X_USER_AGENT = 'Model: MAG250; Link: WiFi';
