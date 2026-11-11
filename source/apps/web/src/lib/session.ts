/**
 * Who is using this app, and whether they have been set up.
 *
 * Two facts, both small, both device-durable, deliberately kept out of `prefs.ts`:
 * preferences are per-profile and are synced between devices, whereas signing in
 * is per-DEVICE and must never travel — a television that has been signed in
 * should not sign in a phone that has not.
 *
 * ── signing in ──
 *
 * There are no accounts. The credential is the line itself, and it is now checked
 * against the PANEL by the app itself rather than by `POST /api/signin` — there
 * is no server holding a subscription to check it against any more. What is
 * stored here is the account digest, `sha256(host|port|username|password)`, which
 * identifies the line without being usable as one.
 *
 * ── the password IS kept, and that is a reversal ──
 *
 * This file used to say "the password is not kept: it is sent once and
 * forgotten", and that was both true and safe, because the server could
 * re-authenticate on the viewer's behalf. Nothing can now. A client that talks to
 * the panel directly has to be able to re-authenticate on every launch, so the
 * password is stored — in `providers/store.ts`, not here, and the reasoning and
 * its cost are written down there. This file keeps only the digest, as before.
 *
 * ── the first run ──
 *
 * `onboardedAt` is recorded per account, so a second device on the same line
 * still gets asked (it has its own screen and its own opinions about which
 * countries matter), while a reinstall on a device is answered by the settings
 * backup rather than by a fresh set of questions. See routes/Welcome.tsx.
 */
import { kv } from './kv.ts';
import {
  SignInError, refreshSubscription, signInXtream, subscription,
  type SignInReason,
} from './providers/index.ts';
import { parseLineCredentials } from '@iptv/core-xtream';

const SESSION_KEY = 'iptv.session.v1';
/*
 * v2, and the bump is the fix for "I didn't get the onboarding".
 *
 * The first run changed shape — it was a sign-in wall, then a package picker, and
 * it is now free channels first with signing in optional. A device that answered
 * ANY of those older flows carries a marker saying "set up", so it never sees the
 * new one, and the only way out was clearing site data by hand. Versioning the key
 * makes a changed flow run once more on every device that has one, which is the
 * behaviour that was wanted every time this changed.
 */
const ONBOARDED_KEY = 'iptv.onboarded.v2';

export interface Session {
  /** sha256(host|port|username|password) — the same key /api/state uses. */
  account: string;
  at: number;
}

/** What the subscription contains, so nothing empty is ever advertised. */
export interface Inventory {
  generation: number | null;
  live: number;
  movies: number;
  series: number;
  archive: number;
  guide: number;
}

let current: Session | null = read();
const subs = new Set<(s: Session | null) => void>();

function read(): Session | null {
  try {
    const raw = kv.get(SESSION_KEY);
    if (raw === null) return null;
    const o = JSON.parse(raw) as Partial<Session>;
    if (typeof o.account !== 'string' || !/^[0-9a-f]{64}$/.test(o.account)) return null;
    return { account: o.account, at: Number(o.at ?? 0) };
  } catch { return null; }
}

/** Re-read after `hydrateKV()`, for the same reason prefs and skin do. */
export function reloadSession(): void {
  current = read();
  for (const fn of subs) fn(current);
}

export function getSession(): Session | null { return current; }

export function subscribeSession(fn: (s: Session | null) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

function write(next: Session | null): void {
  current = next;
  if (next === null) kv.remove(SESSION_KEY);
  else kv.set(SESSION_KEY, JSON.stringify(next));
  for (const fn of subs) fn(current);
}

export interface SignInResult {
  ok: boolean;
  message?: string;
  /**
   * Why it failed, when it failed — so the FORM can do something about it.
   *
   * `notHere` means the server answered and does not hold this subscription,
   * which points the viewer at the address or the username.
   */
  reason?: SignInReason;
  inventory?: Inventory;
  /** True when the subscription is new here and its catalogue is being built. */
  building?: boolean;
  subscription?: {
    status: string | null; expDate: string | null;
    isTrial: boolean; maxConnections: number | null;
  };
}

/**
 * The line's identity, computed here rather than handed over.
 *
 * `sha256(host|port|username|password)`, which is what the server used to return.
 * Falls back where WebCrypto is missing — a plain-HTTP LAN page is not a secure
 * context — because a device that cannot compute it must still be able to sign in;
 * it only has to be stable, not secret.
 */
async function accountDigest(host: string, username: string, password: string): Promise<string> {
  const u = new URL(host);
  const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
  const text = `${u.hostname}|${port}|${username}|${password}`;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0').repeat(8);
  }
}

export async function signIn(
  username: string, password: string, url?: string,
): Promise<SignInResult> {
  const cred = parseLineCredentials(username, password);
  if (cred === null) {
    return {
      ok: false,
      message: 'Enter a username and password, or paste the full get.php link into username.',
    };
  }
  /* The address the viewer typed, or the one inside a pasted get.php link or
     http://user:pass@host. There is no built-in pool: the server is theirs. */
  const typed = url?.trim() !== '' && url !== undefined ? url.trim() : null;
  const first = typed ?? cred.url;
  if (first === null || first === undefined) {
    return { ok: false, message: 'Enter the server address your provider gave you.' };
  }
  try {
    const { subscription: sub } = await signInXtream({
      url: first, username: cred.username, password: cred.password,
    });
    write({
      account: await accountDigest(sub.host, cred.username, cred.password),
      at: Date.now(),
    });
    return {
      ok: true,
      building: true,
      subscription: {
        status: sub.status,
        expDate: sub.expiresAt === null ? null : new Date(sub.expiresAt).toISOString(),
        isTrial: sub.trial,
        maxConnections: sub.maxConnections,
      },
    };
  } catch (e) {
    if (e instanceof SignInError) return { ok: false, message: e.message, reason: e.reason };
    return { ok: false, message: 'Could not reach any server. Check the connection and try again.' };
  }
}

/**
 * A playlist or stream source is "signed in" too: there is nothing to check it
 * against, but the rest of the app asks one question — does this device have a
 * source — and the session is how it is answered. Idempotent while one exists.
 */
export async function startSourceSession(seed: string): Promise<void> {
  if (current !== null) return;
  write({ account: await accountDigest('http://source.invalid', 'source', seed), at: Date.now() });
}

/** The cached badge for the line that is signed in, if there is one. */
export function currentSubscription(): SignInResult['subscription'] | undefined {
  const sub = subscription();
  if (sub === null) return undefined;
  return {
    status: sub.status,
    expDate: sub.expiresAt === null ? null : new Date(sub.expiresAt).toISOString(),
    isTrial: sub.trial,
    maxConnections: sub.maxConnections,
  };
}

/** Re-check the badge. Never awaited by anything that renders. */
export function refreshLine(): void { void refreshSubscription(); }

/**
 * Sign out.
 *
 * Leaves preferences, favourites and history exactly where they are: they belong
 * to the line, not to this session, and the backup on the server holds them
 * anyway. Signing out is "stop showing me this account", not "erase the device".
 */
export function signOut(): void {
  write(null);
}

function onboardedMap(): Record<string, number> {
  try {
    const raw = kv.get(ONBOARDED_KEY);
    const o = raw === null ? {} : JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'number') out[k] = v;
    return out;
  } catch { return {}; }
}

export function isOnboarded(account: string): boolean {
  return onboardedMap()[account] !== undefined;
}

export function markOnboarded(account: string): void {
  const map = onboardedMap();
  map[account] = Date.now();
  /* Bounded: a device that has seen twenty lines is a shop demo, and the oldest
     entry there is worth less than the newest. */
  const keys = Object.keys(map);
  if (keys.length > 20) {
    keys.sort((a, b) => (map[a] ?? 0) - (map[b] ?? 0));
    for (const k of keys.slice(0, keys.length - 20)) delete map[k];
  }
  kv.set(ONBOARDED_KEY, JSON.stringify(map));
}

/** For "start the first run again" in settings, and for tests. */
export function forgetOnboarding(account: string): void {
  const map = onboardedMap();
  delete map[account];
  kv.set(ONBOARDED_KEY, JSON.stringify(map));
}
