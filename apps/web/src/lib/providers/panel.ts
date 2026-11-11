/**
 * The one panel client, and what it learned when it authenticated.
 *
 * Two things matter beyond the catalogue:
 *
 *   allowed_formats   which container the account may ask for, which decides
 *                     `.m3u8` versus `.ts` for every live URL the app builds
 *   server_timezone   the offset every programme time in the guide is stated in
 *
 * Both come back from `authenticate()` and both are cached, because they change
 * roughly never and asking again costs a request against an account that allows
 * one connection.
 *
 * There is exactly one client per app rather than one per caller. The panel
 * counts requests per account, so two clients means two queues means twice the
 * request rate against flood protection that is measured per IP.
 */
import { XtreamClient, DEFAULT_UA } from '@iptv/core-xtream';
import { kv } from '../kv.ts';
import { sourceName } from '../sourceName.ts';
import {
  activeProvider, addProvider, allProviders, getProvider, setActiveProvider, updateProvider,
} from './store.ts';
import { candidatesBoth, forgetHost, forgetHostProbes, orderHosts, resolveHost, streamBaseFor, type HostProbe } from './hosts.ts';
import { getPrefs } from '../prefs.ts';
import { dlog } from '../debugLog.ts';
import { resetStalkerClient } from './stalker.ts';
import type { Provider, Subscription } from './types.ts';

/** The panel client's own spacing. Do not lower. */
const GAP_MS = 250;
const SUB_KEY = 'iptv.panel.subscription.v1';
const BASE_KEY = 'iptv.panel.base.v1';
let client: XtreamClient | null = null;
let clientFor = -1;

/**
 * The client for whichever subscription is active, or null on a playlist.
 *
 * Rebuilt when the active provider changes and never otherwise: a client carries
 * the request queue, and replacing it mid-download loses the spacing that queue
 * exists to enforce.
 */
export function panelClient(): XtreamClient | null {
  const p = activeProvider();
  if (p === null || p.kind !== 'xtream') { client = null; clientFor = -1; return null; }
  if (client !== null && clientFor === p.id) return client;
  const base = streamBaseFor(pinnedBase(p));
  client = new XtreamClient({
    serverUrl: base,
    username: p.username ?? '',
    password: p.password ?? '',
    userAgent: DEFAULT_UA,
    minGapMs: GAP_MS,
  });
  clientFor = p.id;
  return client;
}

/** Drop the cached client so the next call rebuilds it. */
export function resetPanelClient(): void { client = null; clientFor = -1; resetStalkerClient(); }

export function subscriptionOf(id: number): Subscription | null {
  const raw = kv.get(`${SUB_KEY}.${id}`);
  if (raw === null) return null;
  try { return JSON.parse(raw) as Subscription; } catch { return null; }
}

/** Everything this device remembered about one source's subscription and host. */
export function forgetPanelState(id: number): void {
  kv.remove(`${SUB_KEY}.${id}`);
  kv.remove(`${BASE_KEY}.${id}`);
}

export function subscription(): Subscription | null {
  const p = activeProvider();
  return p === null ? null : subscriptionOf(p.id);
}

function remember(id: number, probe: HostProbe): Subscription {
  const sub: Subscription = {
    status: probe.info?.status ?? null,
    expiresAt: probe.info?.expDate instanceof Date ? probe.info.expDate.getTime() : null,
    trial: probe.info?.isTrial ?? false,
    activeConnections: probe.info?.activeCons ?? 0,
    maxConnections: probe.info?.maxConnections ?? null,
    allowedFormats: probe.info?.allowedOutputFormats ?? [],
    timezone: probe.server?.timezone ?? null,
    host: probe.host,
    checkedAt: Date.now(),
  };
  kv.set(`${SUB_KEY}.${id}`, JSON.stringify(sub));
  kv.set(`${BASE_KEY}.${id}`, streamBaseFor(probe.host, probe.server));
  return sub;
}

/**
 * The remembered host, but only while it is still a host we know about.
 *
 * `adoptStreamBase` pins whatever last played so the next stream starts there,
 * and `streamBases()` puts that pin FIRST and untouched. A pin is honoured when
 * it is the address the viewer typed (`p.url`) or one the provider itself
 * published (`p.hosts`). Anything else is an adoption of a host that no longer
 * exists as far as this app is concerned, and the typed address is a better
 * answer than a fossil.
 */
function pinnedBase(p: Provider): string {
  const pin = kv.get(`${BASE_KEY}.${p.id}`);
  if (pin === null || pin === undefined || pin === '') return p.url;
  const host = hostName(pin);
  const known = new Set<string>([hostName(p.url)]);
  for (const h of p.hosts ?? []) known.add(hostName(h));
  if (known.has(host)) return pin;
  kv.remove(`${BASE_KEY}.${p.id}`);
  return p.url;
}

function hostName(raw: string): string {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname;
  } catch {
    return raw;
  }
}

/** The other hosts the viewer gave for this subscription. */
export function hostsFor(p: Provider): string[] {
  return p.hosts ?? [];
}

/**
 * Every origin this subscription can be reached on, current host first.
 *
 * This list is the remembered host, the typed address and the other hosts given
 * for it. Each host is tried on HTTP first; HTTPS only after.
 */
export function streamBases(): string[] {
  const p = activeProvider();
  if (p === null || p.kind !== 'xtream') return [];
  /*
   * A host the VIEWER picked outranks the one playback adopted.
   *
   * `adoptStreamBase` pins whatever last played, which is the right default and
   * the wrong answer when somebody has gone into Settings precisely because that
   * host is the one giving them trouble. An unknown or dropped hostname falls
   * through to the pin, so a stale setting can never strand anybody — see
   * `Prefs.server`, which stores the hostname and shows it as "Server 2".
   */
  const chosen = getPrefs().server;
  /* Every host this viewer could be sent to, for resolving their own choice. */
  const all = [p.url, ...hostsFor(p)];
  const known = chosen === null ? null
    : all.find((h) => hostName(h) === hostName(chosen)) ?? null;
  const preferred = known;
  const pinned = pinnedBase(p);
  const current = streamBaseFor(preferred ?? pinned).replace(/\/$/, '');
  const extra: string[] = [];
  const seen = new Set<string>([hostName(current)]);
  const push = (raw: string) => {
    const h = hostName(raw);
    if (h === '' || seen.has(h)) return;
    seen.add(h);
    extra.push(h);
  };
  /* The pin first among the fallbacks: if the typed address is the one that is
     wrong today, the host that actually played last is one hop away. */
  push(pinned);
  push(p.url);
  for (const h of hostsFor(p)) push(h);
  /* The host in use first and untouched; behind it, every HTTP address — known
     to answer, then unknown, then refused today — before any HTTPS address gets
     a turn at all (`orderHosts`). An adopted or viewer-picked HTTPS base does
     not skip that queue just for having the freshest memo. A stream that fails
     on the current host should reach a working one in a hop — and not by way of
     TLS on a host that answers HTTP. */
  return orderHosts(candidatesBoth(current, extra));
}

/** Playback found a host that answers. Catalogue and the next play use it. */
export function adoptStreamBase(host: string): void {
  const p = activeProvider();
  if (p === null || p.kind !== 'xtream') return;
  kv.set(`${BASE_KEY}.${p.id}`, streamBaseFor(host));
  resetPanelClient();
}

/** Where streams are built from, which `server_info` may move off the API host. */
export function streamBase(): string | null {
  const p = activeProvider();
  if (p === null || p.kind !== 'xtream') return null;
  return streamBaseFor(pinnedBase(p));
}

export function credentials(): { username: string; password: string } | null {
  const p = activeProvider();
  if (p === null || p.kind !== 'xtream' || p.username === undefined) return null;
  return { username: p.username, password: p.password ?? '' };
}

/**
 * Why a sign-in failed, in a form the FORM can act on.
 *
 * `notHere` is the one that earns this type: it is the only outcome where the
 * viewer can fix the problem themselves, and the only way to fix it is to type
 * the address their provider gave them. A message alone cannot reveal a field.
 */
export type SignInReason = 'refused' | 'busy' | 'notHere' | 'noAnswer';

export class SignInError extends Error {
  readonly tried: HostProbe[];
  readonly reason: SignInReason;
  constructor(msg: string, reason: SignInReason, tried: HostProbe[]) {
    super(msg);
    this.name = 'SignInError';
    this.reason = reason;
    this.tried = tried;
  }
}

/**
 * What to tell somebody whose sign-in found no host.
 *
 * Chosen from the hosts' VERDICTS, strongest first, and the order is the whole
 * point. A regex over the error text cannot do this: it always contains the
 * literal label `auth:`, because that is the label on the authentication
 * request itself, and an account can live on one host only, so a 404 from
 * another is what a healthy sign-in looks like.
 *
 * Strongest first, because these are claims of different strength:
 *
 *   refused   a host parsed the credentials and said no. That is a real verdict
 *             on the account and it outranks everything else.
 *   busy      a host is refusing the account for the moment. Not the password.
 *   notHere   hosts answered; none of them has this account. The credentials may
 *             be perfect and the address wrong — so this is the one that asks
 *             for the address instead of blaming the viewer.
 *   noAnswer  nothing answered at all. A network, not an account.
 *
 * Exported and pure so the mapping is tested rather than trusted.
 */
export function signInVerdict(
  tried: readonly HostProbe[],
): { reason: SignInReason; message: string } {
  const has = (v: HostProbe['verdict']) => tried.some((t) => t.verdict === v);
  if (has('refused')) {
    return {
      reason: 'refused',
      /* Deliberately still ambiguous: the panel answers `auth: 0` for a wrong
         password AND for a subscription whose connections are all in use, and
         claiming one of those would be inventing information we do not have. */
      message: 'The panel rejected that username and password. If the subscription is'
        + ' already playing on another device, stop it there and try again.',
    };
  }
  if (has('busy')) {
    /*
     * "Busy" is a guess, and on many providers it is usually the wrong one.
     *
     * Measured against `stream.example.com` on 2026-09-27, three calls, one
     * minute apart:
     *
     *   a made-up username and password   513
     *   a real line whose password changed 513
     *   no credentials at all             511
     *
     * So on such panels 513 is the panel saying "not these credentials", not
     * "not right now" — `core-xtream/src/client.ts` already records the same
     * thing in passing ("a wrong password is 513"). Telling somebody whose
     * password has been changed to wait a moment and try again sends them
     * round that loop for ever, and it is the likeliest reason a line that
     * worked yesterday stops: the provider resets it, or the viewer rotated it
     * after sharing it somewhere.
     *
     * The status alone cannot separate the two — a genuinely rate-limited
     * account answers the same way — so the message names both, busy first
     * because it is the one that costs nothing to wait out, and the password
     * second because it is the one that needs doing something about.
     */
    return {
      reason: 'busy',
      message: 'The server turned that down without saying why. Usually it is busy — '
        + 'wait a minute and try again. If it keeps happening, the password has '
        + 'probably been changed: check it with whoever sold you the subscription.',
    };
  }
  if (has('notHere')) {
    /* The viewer typed the address, so the useful thing to say is that it
       answered and did not know this account — which points at the address or
       the username. */
    return {
      reason: 'notHere',
      message: 'That server answered, but it does not have this subscription.'
        + ' Check the address and the username with your provider.',
    };
  }
  return {
    reason: 'noAnswer',
    message: 'No server answered. Check the connection, or try again in a moment.',
  };
}

/**
 * Attach a subscription.
 *
 * Deliberately AWAITED and validating: a typo should fail on the form, where it
 * can be corrected, rather than an hour later as an empty catalogue. What is not
 * awaited is everything after this — the catalogue download is started by the
 * caller and the app stays usable while it runs.
 *
 * Host probing is an optimisation and never a gate. If every backup is
 * unreachable from here but the address the viewer typed authenticates, that
 * address is correct and the backups are simply not reachable from this network.
 */
export async function signInXtream(
  opts: {
    url: string; username: string; password: string; hosts?: string[]; name?: string;
  },
): Promise<{ provider: Provider; subscription: Subscription }> {
  /* Drop remembered TLS wins so a prior https probe cannot stick the session. */
  forgetHostProbes();
  const { chosen, tried } = await resolveHost(opts.url, opts.username, opts.password, opts.hosts ?? []);
  if (chosen === null) {
    /* Say which failure it actually was. "Cannot sign in" over a working line
       with the connection already in use sends people to change a password that
       is fine — and telling somebody on another provider that their password is
       wrong sends them nowhere at all. */
    const { reason, message } = signInVerdict(tried);
    /*
     * Write down what every host said. One line per host — the origin, the
     * verdict, the status and how long it took — so the debug panel answers
     * "why was this sign-in rejected" in one screen. No credentials are in any
     * of it, and `dlog` redacts anyway.
     */
    dlog.error('signin', `no host: ${reason} — ${tried.length} tried`);
    for (const t of tried) {
      dlog.info('signin', `${t.host} ${t.verdict}${t.status === undefined ? '' : ` ${t.status}`} ${t.ms}ms`);
    }
    throw new SignInError(message, reason, tried);
  }
  const provider = addProvider({
    kind: 'xtream',
    name: sourceName(opts.name, opts.url, 'xtream', allProviders().map((p) => p.name)),
    url: chosen.host,
    username: opts.username,
    password: opts.password,
    ...(opts.hosts !== undefined && opts.hosts.length > 0 ? { hosts: opts.hosts } : {}),
    enabled: true,
  });
  /*
   * Explicitly made active, and this is not a formality.
   *
   * `addProvider` only adopts a new provider when there is no active one. With
   * a playlist already active, signing in would add the subscription and leave
   * the playlist selected — and `panelClient()` would keep answering null for
   * an m3u provider, so no film or series would ever arrive.
   */
  setActiveProvider(provider.id);
  const sub = remember(provider.id, chosen);
  resetPanelClient();
  return { provider, subscription: sub };
}

/**
 * Re-check an existing subscription's badge.
 *
 * Never awaited by anything that renders. The days-remaining line is worth having
 * and is never worth delaying a first screen for.
 */
/**
 * Ask the panel again, and hand back what every host said.
 *
 * `refreshSubscription` below answers "what is the subscription now" and, when
 * no host authenticates, quietly returns the one it had cached — the right
 * answer for a badge, and the wrong one for checking on each visit whether the
 * account still authenticates. A revoked or expired line would look valid for
 * ever. So this returns the evidence as well as the result, and
 * `lib/accountCheck.ts` decides.
 */
export async function recheckSubscription(
  id = activeProvider()?.id ?? -1,
): Promise<{ chosen: HostProbe | null; tried: HostProbe[]; sub: Subscription | null } | null> {
  const p = getProvider(id);
  if (p === null || p.kind !== 'xtream' || p.username === undefined) return null;
  const { chosen, tried } = await resolveHost(
    pinnedBase(p), p.username, p.password ?? '', hostsFor(p),
  );
  if (chosen === null) return { chosen, tried, sub: null };
  if (chosen.host !== p.url) updateProvider(p.id, { url: chosen.host });
  const sub = remember(p.id, chosen);
  resetPanelClient();
  return { chosen, tried, sub };
}

export async function refreshSubscription(id = activeProvider()?.id ?? -1): Promise<Subscription | null> {
  const p = getProvider(id);
  if (p === null || p.kind !== 'xtream' || p.username === undefined) return null;
  const { chosen } = await resolveHost(
    pinnedBase(p), p.username, p.password ?? '', hostsFor(p),
  );
  if (chosen === null) return subscriptionOf(id);
  if (chosen.host !== p.url) updateProvider(p.id, { url: chosen.host });
  const sub = remember(p.id, chosen);
  resetPanelClient();
  return sub;
}

/**
 * The chosen host just failed us — decide whether to stop trusting it.
 *
 * `resolveHost` remembers a working host for an hour so that the ordinary case
 * costs one request rather than one per host. Without this, nothing could
 * dislodge it inside that hour, so a host that authenticated at sign-in and
 * then went bad would stay selected until the entry aged out.
 *
 * Only host-shaped failures count, and the exclusions matter more than the rule:
 *
 *   * **flood protection (451/456/509/511/513) is the ACCOUNT refusing.** This
 *     host is not dead; do not mark it so. Playback still walks the other hosts
 *     — they are other ways in, not proven to be the same machine.
 *   * **bad credentials fail identically everywhere.** Forgetting a good host
 *     over a wrong password trades a working connection for nothing.
 *
 * What is left is the genuinely host-specific: a timeout, a DNS or TLS failure, a
 * CORS rejection, a 5xx. Those are reasons to let the next resolve look elsewhere.
 */
const HOST_SHAPED =
  /timeout|timed out|network|failed to fetch|load failed|CORS|ERR_|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|certificate|SSL|TLS|502|503|504/i;
const ACCOUNT_SHAPED = /\b(451|456|509|511|513)\b|auth|credential|password|unauthor/i;

export function notePanelFailure(err: unknown): void {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (ACCOUNT_SHAPED.test(text)) return;
  if (!HOST_SHAPED.test(text)) return;
  const p = activeProvider();
  if (p === null || p.kind !== 'xtream') return;
  /* The address actually in use, which after a successful resolve is the probed
     candidate rather than whatever was originally typed. */
  const inUse = pinnedBase(p);
  forgetHost(inUse);
  /* And the client bound to it, so the next call re-reads the base. */
  resetPanelClient();
}
