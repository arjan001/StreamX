/**
 * Which of a subscription's hosts to actually use: the server address the
 * viewer entered, and any further hosts they entered for the same account.
 *
 * These panels are plaintext-first: TLS is often closed, mis-issued, or CORS-
 * hostile from a browser. Every host is tried on HTTP first; HTTPS is only a
 * second pass when HTTP did not authenticate (connection refused, timeout, etc.).
 *
 * Two rules that look like paranoia and are not:
 *
 *   · Success is a parsed `user_info.auth === 1`, never a status code. A dead
 *     line answers HTTP 200 with an nginx welcome page; anything that trusts the
 *     status picks it and then shows an empty catalogue.
 *   · Probes are staggered with a gap. Firing them all at once is the documented
 *     way to be flood-blocked by these panels, and being blocked while probing is
 *     indistinguishable from having no working host at all.
 *   · The "try the remembered host first" shortcut is HTTP-only. A host that
 *     happened to answer over HTTPS once does not get to keep every later
 *     launch off plaintext — a hit there refreshes the memo that grants the
 *     shortcut, so a mixed-scheme memo could otherwise pin a device to TLS
 *     indefinitely. See `resolveHost`.
 */
import {
  XtreamClient, XtreamAuthError, XtreamHttpError, recognise, normaliseServerUrl, baseUrl,
  type UserInfo, type ServerInfo,
} from '@iptv/core-xtream';
import { kv } from '../kv.ts';

/** Short: somebody is waiting on a sign-in, and a host this slow is not the one. */
const PROBE_MS = 6_000;
/** The same spacing the panel client uses. Do not lower. */
const GAP_MS = 250;
/** Long enough for flood protection to forget, short enough to still be a sign-in. */
const BUSY_RETRY_MS = 2_500;

/**
 * What a host actually said, as a verdict rather than as prose.
 *
 * A regex over the error's TEXT gets this wrong: every HTTP failure on the
 * authentication call is built as `${label}: HTTP ${status} from ${path}` with
 * the label `'auth'`, so `auth: HTTP 404 from /player_api.php` would match
 * `/auth/` and a host that simply does not have this account would tell the
 * viewer their password was wrong. An account can exist on one host only, so
 * the others answer 404.
 *
 * A verdict cannot drift the way a regex over a message can, and the type of the
 * thrown error already knows the answer:
 *
 *   ok           `user_info.auth === 1`. This host has the account.
 *   refused      the panel parsed the credentials and said no (`auth: 0`).
 *                The panel conflates a wrong password with an exhausted
 *                connection limit; so does this, deliberately.
 *   busy         flood protection — 456/509/511/513. The panel is refusing the
 *                ACCOUNT, not failing: the same reasoning as `notePanelFailure`.
 *   notHere      403/404. The host answered and does not have this account.
 *   blocked      the host answered with something that is not an answer: a 5xx,
 *                or a 200 carrying an HTML challenge or an nginx welcome page.
 *   unreachable  nothing answered — timeout, DNS, TLS, connection refused, CORS.
 */
export type ProbeVerdict =
  | 'ok' | 'refused' | 'busy' | 'notHere' | 'blocked' | 'unreachable';

export interface HostProbe {
  readonly host: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly secure: boolean;
  readonly verdict: ProbeVerdict;
  /** The HTTP status, when a host answered with one. Kept for the debug log. */
  readonly status?: number;
  readonly info?: UserInfo;
  readonly server?: ServerInfo;
  readonly error?: string;
}

/** Flood protection, which every one of these panels expresses differently. */
const BUSY_STATUS = new Set([456, 509, 511, 513]);

/**
 * The verdict for whatever `authenticate()` threw.
 *
 * Pure and exported so it can be tested without a network: the mapping is the
 * whole fix, and it is the kind of thing that quietly rots.
 */
export function verdictFor(err: unknown): { verdict: ProbeVerdict; status?: number } {
  if (err instanceof XtreamAuthError) return { verdict: 'refused' };
  if (err instanceof XtreamHttpError) {
    const { status } = err;
    if (BUSY_STATUS.has(status)) return { verdict: 'busy', status };
    if (status === 403 || status === 404) return { verdict: 'notHere', status };
    /* Everything else a host ANSWERED with: a 5xx, or the 200 that carries an
       HTML page instead of JSON. Either way the host is there and this is not
       a verdict on the credentials. */
    return { verdict: 'blocked', status };
  }
  return { verdict: 'unreachable' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What each address did last time, so a dead one is not tried again today.
 *
 * A failure is remembered for a day and a success for an hour. Asymmetric on
 * purpose: a host that refused the connection is not going to appear this
 * afternoon, while a host that worked can go down at any moment and must be
 * re-checked often enough that a failover is quick.
 *
 * Keyed by full origin (`https://host` ≠ `http://host`): a TLS failure must not
 * skip the plaintext address on the same hostname.
 */
const MEMO_KEY = 'iptv.hosts.v2';
const DEAD_FOR_MS = 24 * 3600_000;
const ALIVE_FOR_MS = 3600_000;

type Memo = Record<string, { ok: boolean; ms: number; at: number }>;

function memo(): Memo {
  try {
    const raw = kv.get(MEMO_KEY);
    return raw === null ? {} : JSON.parse(raw) as Memo;
  } catch { return {}; }
}

function remember(host: string, ok: boolean, ms: number): void {
  try {
    const m = memo();
    m[host] = { ok, ms, at: Date.now() };
    kv.set(MEMO_KEY, JSON.stringify(m));
  } catch { /* private mode */ }
}

/** A candidate known to have refused recently, and not worth the console line. */
function skip(host: string, m: Memo): boolean {
  const hit = m[host];
  if (hit === undefined) return false;
  return !hit.ok && Date.now() - hit.at < DEAD_FOR_MS;
}

/** Forget every verdict. Offered because a network change invalidates all of them. */
export function forgetHostProbes(): void {
  try { kv.remove(MEMO_KEY); } catch { /* private mode */ }
}

/**
 * Forget ONE host, because it just let us down.
 *
 * The memo exists so that "nothing has changed" costs one request instead of
 * one per host, and a host that authenticated within the hour is tried first
 * and alone. Without this, nothing could dislodge the remembered host inside
 * that hour, so a host that authenticated at sign-in and then started failing
 * would stay the chosen one until the entry aged out.
 *
 * Deliberately one host and not the pool. Wiping every verdict on a single
 * failure would send the next resolve at every candidate — the burst that
 * gets the run challenged, which `resolveHost` is carefully built to avoid.
 * Dropping the one that failed means the next resolve re-races the others and
 * can settle somewhere better.
 *
 * Only for host-shaped failures. A flood status (456/509/511/513) is the ACCOUNT
 * refusing, so this host is not dead — but that is not the same as "the other
 * hosts are the same machine". Playback walks them on its own. Bad credentials
 * fail identically everywhere; forgetting a good host over those would trade a
 * working connection for a re-probe that cannot help.
 */
export function forgetHost(host: string): void {
  try {
    const m = memo();
    if (m[host] === undefined) return;
    delete m[host];
    kv.set(MEMO_KEY, JSON.stringify(m));
  } catch { /* private mode */ }
}

/** Scheme to prefer when talking to panel hosts — always plaintext. */
export function pageScheme(): 'http' | 'https' {
  return 'http';
}

/** Hostname (+port) only — scheme is decided by the page, not by the paste. */
function bareHost(raw: string): string {
  const t = raw.trim();
  if (t === '') return '';
  try {
    return new URL(/^https?:\/\//i.test(t) ? t : `http://${t}`).host;
  } catch {
    return t.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

function withScheme(raw: string, scheme: 'http' | 'https'): string {
  const host = bareHost(raw);
  return host === '' ? '' : `${scheme}://${host}`;
}

/**
 * Every address worth trying on ONE scheme.
 *
 * Pass `scheme` to pin it (tests, HTTPS second pass). Default is HTTP.
 */
export function candidates(
  url: string,
  extra: string[] = [],
  scheme: 'http' | 'https' = pageScheme(),
): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const full = withScheme(raw, scheme);
    if (full === '' || out.includes(full)) return;
    out.push(full);
  };
  push(url);
  for (const h of extra) push(h);
  return out;
}

/**
 * Every address, in try order: every host on HTTP, then every host on HTTPS.
 *
 * HTTPS is a fallback only — these panels usually refuse or mis-serve TLS, and
 * probing both schemes in one sweep spams the console with CORS / dead-443
 * noise while the plaintext address is still answering. Stream failover walks
 * the same list, so a channel tries every HTTP host before any HTTPS URL.
 */
export function candidatesBoth(url: string, extra: string[] = []): string[] {
  const hosts: string[] = [];
  for (const raw of [url, ...extra]) {
    const h = bareHost(raw);
    if (h !== '' && !hosts.includes(h)) hosts.push(h);
  }
  const out: string[] = [];
  for (const h of hosts) out.push(`http://${h}`);
  for (const h of hosts) out.push(`https://${h}`);
  return out;
}

/**
 * The same addresses, with what is remembered about them applied.
 *
 * Scheme is the primary key: every HTTP address in `rest` is ordered before any
 * HTTPS one, in full, and the memo only breaks ties INSIDE a scheme. Without
 * that grouping, a freshly-adopted HTTPS base — the address most likely to
 * carry a hit-just-now memo — would outrank an untried HTTP host on nothing
 * more than having the newer timestamp.
 *
 * Within a scheme, an address that refused within the day goes to the back
 * rather than being dropped — the memo is a guess about the future and a stream
 * failover must be allowed to prove it wrong — and one that authenticated
 * within the hour comes to the front.
 *
 * The first entry is never moved: it is the address in use, and the caller has
 * already decided it is where a stream starts. It is always HTTP —
 * `candidatesBoth`, which builds what this function is handed, emits the
 * plaintext form of the lead host before anything else.
 */
export function orderHosts(hosts: readonly string[]): string[] {
  if (hosts.length < 2) return [...hosts];
  const m = memo();
  const [head, ...rest] = hosts;
  const bySticky = (group: string[]): string[] => {
    const alive = group.filter((d) => m[d]?.ok === true && Date.now() - m[d]!.at < ALIVE_FOR_MS);
    const dead = group.filter((d) => skip(d, m));
    const unknown = group.filter((d) => !alive.includes(d) && !dead.includes(d));
    return [...alive, ...unknown, ...dead];
  };
  const restHttp = rest.filter((d) => d.startsWith('http:'));
  const restHttps = rest.filter((d) => d.startsWith('https:'));
  return [head!, ...bySticky(restHttp), ...bySticky(restHttps)];
}

/** True when this URL is an Xtream live/movie/series path, not a third-party feed. */
export function isPanelStreamUrl(url: string): boolean {
  try { return recognise(url).kind !== 0; } catch { return false; }
}

/**
 * Same path and credentials, different host.
 *
 * The hosts the viewer entered are one account reachable several ways. A 404 or
 * a timeout on one of them is not a verdict on the channel — it is a verdict on
 * that host.
 * The origin's scheme is kept: moving `https://a/...` onto an `http://b` base
 * must become http, and the reverse must become https.
 */
export function rewriteStreamOrigin(url: string, origin: string): string {
  const u = new URL(url);
  const b = new URL(/^https?:\/\//i.test(origin.trim()) ? origin.trim() : withScheme(origin, pageScheme()));
  u.protocol = b.protocol;
  u.host = b.host;
  return u.href;
}

/**
 * The next host that has not already been tried for this stream.
 *
 * `failedUrl` is whatever the engine actually requested — after a 302 that may
 * be an edge IP, not the hostname we built — so `used` must already contain the
 * origin we started from, not only the URL that failed.
 */
export function nextStreamOrigin(
  failedUrl: string,
  bases: readonly string[],
  used: ReadonlySet<string>,
): string | null {
  const seen = new Set(used);
  try { seen.add(new URL(failedUrl).origin); } catch { /* keep going */ }
  for (const b of bases) {
    try {
      const raw = b.trim();
      const o = new URL(/^https?:\/\//i.test(raw) ? raw : withScheme(raw, pageScheme())).origin;
      if (!seen.has(o)) return o;
    } catch { /* not a url */ }
  }
  return null;
}

/** Probe one address. */
async function probeOne(url: string, username: string, password: string): Promise<HostProbe> {
  const t0 = Date.now();
  const secure = url.startsWith('https:');
  try {
    const client = new XtreamClient({
      serverUrl: url, username, password, timeoutMs: PROBE_MS, maxRetries: 0, minGapMs: 0,
    });
    const { user, server } = await client.authenticate();
    remember(url, user.auth, Date.now() - t0);
    return {
      host: url, ok: user.auth, ms: Date.now() - t0, secure, verdict: 'ok', info: user, server,
    };
  } catch (e) {
    remember(url, false, Date.now() - t0);
    const { verdict, status } = verdictFor(e);
    return {
      host: url,
      ok: false,
      ms: Date.now() - t0,
      secure,
      verdict,
      ...(status === undefined ? {} : { status }),
      error: (e as Error).message,
    };
  }
}

/**
 * The host to use: the first, in the order the viewer listed them, that
 * authenticates.
 *
 *   correct   success is a parsed `user_info.auth === 1`, never a status code.
 *   ordered   the host list is an order of preference and an account may exist
 *             on one host only. So the winner is the first in that order among
 *             those that answered, not the quickest — the quickest host is
 *             often one with nothing behind it, which then 404s every stream.
 *   sticky    a host that authenticated within the hour is tried first and
 *             alone — but ONLY over HTTP. A remembered-good HTTPS address does
 *             not get this shortcut: it would let one lucky TLS probe, days ago,
 *             keep every later launch off plaintext for ever, since a hit here
 *             refreshes the memo that grants it. `forgetHost` is how a failure
 *             dislodges a sticky host.
 *   http-first  every HTTP address — known, unknown, or refused as recently as
 *             yesterday — gets a try before any HTTPS address does. One that
 *             refused within the day is moved to the back of THIS pass, not
 *             out of it and not down into the HTTPS fallback: a stream failover
 *             must be free to prove yesterday's verdict wrong. HTTPS is reached
 *             only once every HTTP address has failed or was tried and lost —
 *             and even there, a remembered-good HTTPS address goes first.
 *   quiet     one sweep per scheme, starts 250ms apart, awaited together. Flood
 *             protection measures the request RATE, so staggered starts satisfy
 *             it exactly as a serial loop would, while a dead host times out
 *             alongside the others rather than after them. Probing the same
 *             pool twice in quick succession gets the run challenged — so nothing
 *             here does that outside the deliberate busy-retry below.
 */
export async function resolveHost(
  url: string, username: string, password: string, extra: string[] = [],
): Promise<{ chosen: HostProbe | null; tried: HostProbe[] }> {
  const all = candidatesBoth(url, extra);
  const httpHosts = all.filter((u) => u.startsWith('http:'));
  const httpsHosts = all.filter((u) => u.startsWith('https:'));
  const m = memo();
  const fresh = (u: string) => m[u]?.ok === true && Date.now() - m[u]!.at < ALIVE_FOR_MS;
  const tried: HostProbe[] = [];
  const triedHosts = new Set<string>();

  /** Probe a group, staggered, and return the first IN GROUP ORDER that worked. */
  const sweep = async (group: string[]): Promise<HostProbe | null> => {
    if (group.length === 0) return null;
    const started = group.map(async (candidate, i) => {
      await sleep(GAP_MS * i);
      const probe = await probeOne(candidate, username, password);
      tried.push(probe);
      triedHosts.add(probe.host);
      return probe;
    });
    const results = await Promise.all(started);
    return results.find((t) => t.ok) ?? null;
  };

  /* Sticky quick path: HTTP only. See the `sticky` bullet above — a
     remembered-good HTTPS address must never take this shortcut. */
  const knownHttp = httpHosts.filter(fresh);
  if (knownHttp.length > 0) {
    const quick = await sweep(knownHttp.slice(0, 2));
    if (quick !== null) return { chosen: quick, tried };
  }

  /*
   * The lead host, alone, when it was the last one to let the account in.
   *
   * The sticky path above only trusts a host for an hour, so without this every
   * launch after that would sweep every host at once to re-check an account
   * that lives on one of them. A host the account is not on answers a 404 page
   * with no CORS header, and a browser prints that as an error with the whole
   * URL in it — "Access to fetch at 'http://panel.example.com/player_api.php?…'
   * has been blocked by CORS policy", on every visit. Asking the host that
   * worked last, first and by itself, is one request in the ordinary case, and
   * the sweep is still there the moment it fails. HTTP only, like the sticky
   * path — an HTTPS address never jumps the HTTP sweep.
   */
  const own = httpHosts[0];
  if (own !== undefined && !triedHosts.has(own) && m[own]?.ok === true) {
    const found = await sweep([own]);
    if (found !== null) return { chosen: found, tried };
  }

  /* Every remaining HTTP address — ALL of them, one sweep — before HTTPS gets
     a turn. Addresses with no verdict, or a stale one, start immediately; one
     that refused within the day is moved to the back of this same pass rather
     than dropped from it. */
  const httpRest = httpHosts.filter((u) => !triedHosts.has(u));
  const orderedHttp = [
    ...httpRest.filter((u) => !skip(u, m)),
    ...httpRest.filter((u) => skip(u, m)),
  ];
  const foundHttp = await sweep(orderedHttp);
  if (foundHttp !== null) return { chosen: foundHttp, tried };

  /* HTTPS only after every HTTP address failed or was tried and lost. One
     sweep, same shape: a remembered-good HTTPS address goes first, then the
     rest, then anything that refused within the day. */
  const httpsRest = httpsHosts.filter((u) => !triedHosts.has(u));
  const orderedHttps = [
    ...httpsRest.filter((u) => fresh(u)),
    ...httpsRest.filter((u) => !fresh(u) && !skip(u, m)),
    ...httpsRest.filter((u) => skip(u, m)),
  ];
  const foundHttps = await sweep(orderedHttps);
  if (foundHttps !== null) return { chosen: foundHttps, tried };

  /*
   * One more attempt, and ONLY at the hosts that said "busy".
   *
   * Flood protection measures the request RATE, and these panels express it as
   * 456/509/511/513 — an answer, from a host that is plainly there, that has
   * nothing to do with the password. Sending somebody away with "no server
   * answered" when a host said "not just now" wastes the one thing that would
   * have worked: waiting a moment.
   *
   * Deliberately not a second sweep of the pool. Probing the pool twice in quick
   * succession gets the run challenged, and then every request after it fails
   * on a host that answered seconds earlier. So this is the busy hosts only,
   * once, after a pause long enough to matter.
   */
  const busy = [...new Set(tried.filter((t) => t.verdict === 'busy').map((t) => t.host))];
  if (busy.length > 0) {
    await sleep(BUSY_RETRY_MS);
    const second = await sweep(busy);
    if (second !== null) return { chosen: second, tried };
  }

  return { chosen: null, tried };
}

/**
 * Where streams come from — which is the host that answered, not the one
 * `server_info` names.
 *
 * `server_info` can name a different host entirely. Following it by grafting the
 * scheme of the API host onto that name is wrong. The host that authenticated is
 * known to work; keep its scheme.
 */
export function streamBaseFor(apiUrl: string, _server?: ServerInfo): string {
  const t = apiUrl.trim();
  if (t === '') return t;
  if (/^https?:\/\//i.test(t)) return baseUrl(normaliseServerUrl(t));
  return withScheme(t, pageScheme());
}
