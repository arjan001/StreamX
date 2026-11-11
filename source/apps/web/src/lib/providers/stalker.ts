/**
 * The one Stalker client, its transport, and its remembered session.
 *
 * A portal identifies the box by a `Cookie: mac=...` header and a set-top-box
 * `User-Agent`. A browser forbids both, so the page's own `fetch` cannot talk to
 * one: on Android and iOS the requests go through Capacitor's native HTTP layer,
 * and on every other platform the source is not offered at all
 * (`stalkerSupported()` in `lib/platform.ts`).
 *
 * `CapacitorHttp.request` is called directly. Capacitor can also patch the global
 * `fetch` (`CapacitorHttp.enabled`), which would route every request in the app
 * through the native layer; that is deliberately left off, so only the portal
 * traffic changes path.
 *
 * Playback links are short-lived. Nothing here stores one: `resolveLive` and
 * `resolveVod` ask the portal at the moment of playback, every time.
 */
import {
  StalkerClient, StalkerError, isValidMac, type StalkerFetch, type StalkerSession,
} from '@iptv/core-stalker';
import { activeProvider, getProvider, updateProvider } from './store.ts';
import type { Provider } from './types.ts';

let override: StalkerFetch | null = null;

/** Tests inject a node transport; nothing in the product calls this. */
export function setStalkerTransport(fn: StalkerFetch | null): void {
  override = fn;
  resetStalkerClient();
}

/**
 * `CapacitorHttp.request` as a `StalkerFetch`.
 *
 * `responseType: 'text'` so a JSON body is not parsed behind our back, and the
 * body is stringified when a platform hands one back parsed anyway. The native
 * request cannot be cancelled from here, so an abort stops WAITING for it.
 */
export const nativeStalkerFetch: StalkerFetch = async (url, init) => {
  const { CapacitorHttp } = await import('@capacitor/core');
  const signal = init.signal;
  if (signal?.aborted) throw new Error('aborted');
  const request = CapacitorHttp.request({
    url,
    method: 'GET',
    headers: { ...init.headers },
    responseType: 'text',
    connectTimeout: 15_000,
    readTimeout: 20_000,
  });
  const res = await new Promise<Awaited<typeof request>>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    request.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
  });
  const data: unknown = res.data;
  const body = typeof data === 'string' ? data : data === undefined || data === null ? '' : JSON.stringify(data);
  return { status: res.status, text: async () => body };
};

/* ── the client ──────────────────────────────────────────────────────────── */

let client: StalkerClient | null = null;
let clientFor = '';

/** Same address, same box, same login = same client. Anything else rebuilds it. */
function identity(p: Provider): string {
  return [p.id, p.url, p.mac, p.serial, p.deviceId, p.deviceId2, p.signature, p.username, p.password].join('\u0000');
}

export function resetStalkerClient(): void {
  client = null;
  clientFor = '';
}

/** A client for one provider, restoring its last session. Not cached. */
export function buildStalkerClient(p: Provider, extra: { session?: StalkerSession | null } = {}): StalkerClient {
  const session = extra.session === undefined ? p.stalkerSession ?? null : extra.session;
  return new StalkerClient({
    portalUrl: p.url,
    device: {
      mac: p.mac ?? '',
      serial: p.serial,
      deviceId: p.deviceId,
      deviceId2: p.deviceId2,
      signature: p.signature,
    },
    fetch: override ?? nativeStalkerFetch,
    ...(p.username !== undefined && p.username !== ''
      ? { login: { username: p.username, password: p.password ?? '' } }
      : {}),
    ...(session === null ? {} : { session }),
  });
}

function same(a: StalkerSession | null, b: StalkerSession | null | undefined): boolean {
  if (a === null || b === null || b === undefined) return a === (b ?? null);
  return a.endpoint === b.endpoint && a.token === b.token && a.random === b.random;
}

/**
 * Run something against the active portal, then keep whatever session it ended
 * with, so the next launch skips the handshake. The session is stored with the
 * provider and sealed with its other secrets (`SECRET_FIELDS`).
 */
export async function withStalker<T>(fn: (c: StalkerClient) => Promise<T>, providerId?: number): Promise<T> {
  const p = providerId === undefined ? activeProvider() : getProvider(providerId);
  if (p === null || p.kind !== 'stalker') throw new StalkerError('bad_url', 'No portal is selected');
  const key = identity(p);
  if (client === null || clientFor !== key) {
    client = buildStalkerClient(p);
    clientFor = key;
  }
  const c = client;
  try {
    return await fn(c);
  } finally {
    const now = c.session;
    if (now !== null && !same(now, getProvider(p.id)?.stalkerSession ?? null)) {
      updateProvider(p.id, { stalkerSession: { endpoint: now.endpoint, token: now.token, random: now.random } });
    }
  }
}

export function stalkerActive(): boolean {
  return activeProvider()?.kind === 'stalker';
}

/** The MAC the way a viewer is asked to type it. */
export const MAC_EXAMPLE = '00:1A:79:XX:XX:XX';

export function macProblem(text: string): string | null {
  if (text.trim() === '') return `Enter the MAC address your provider registered, like ${MAC_EXAMPLE}.`;
  return isValidMac(text) ? null : `That is not a MAC address. It has 12 hex digits, like ${MAC_EXAMPLE}.`;
}

/** What went wrong, in words for a person rather than for a log. */
export function stalkerMessage(err: unknown): string {
  if (!(err instanceof StalkerError)) return err instanceof Error ? err.message : String(err);
  switch (err.code) {
    case 'bad_mac': return `That is not a MAC address. It has 12 hex digits, like ${MAC_EXAMPLE}.`;
    case 'bad_url': return 'Enter the portal address, starting with http:// or https://.';
    case 'auth': return 'The portal did not accept this MAC address. Check it with your provider, '
      + 'and add the serial number or login under Advanced if they gave you one.';
    case 'no_endpoint': return 'No portal answered at that address. Check the address and try again.';
    case 'network': return 'The portal could not be reached. Check the connection and the address.';
    case 'bad_body': return 'That address answered, but it does not look like a portal.';
    case 'no_link': return 'The portal did not give a link for this one. It may not be on your plan.';
    default: return err.message;
  }
}
