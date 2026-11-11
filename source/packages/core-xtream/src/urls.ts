/**
 * Stream URL construction and recognition.
 *
 * Two facts drive this module:
 *
 * 1. The path prefix IS the stream_type (`live` / `movie` / `series`), and the
 *    older no-prefix form `{base}/{user}/{pass}/{id}` is still served — measured
 *    as the ONLY form one production panel emits for live channels. A client
 *    that only understands `/live/` sees zero working channels there.
 *
 * 2. URLs are derivable from (kind, streamId, ext) plus credentials, so the
 *    catalogue stores ids rather than URLs. Measured: 591,486 of 592,565 URLs
 *    (99.8%) round-trip through `recognise`. That keeps ~40MB of redundant text
 *    out of the database and — more importantly — keeps subscriber credentials
 *    out of the shared catalogue entirely.
 *
 * See docs/07-architecture.md section 2.
 */

export const Kind = { Opaque: 0, Live: 1, Movie: 2, Episode: 3 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export const KIND_PATH: Record<Exclude<Kind, 0>, string> = {
  [Kind.Live]: 'live',
  [Kind.Movie]: 'movie',
  [Kind.Episode]: 'series',
};

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

/** Where streams are fetched from. Derived from `server_info`, never from user input. */
export interface StreamBase {
  readonly protocol: 'http' | 'https';
  readonly host: string;
  readonly port: number | null;
}

export interface RecognisedUrl {
  readonly kind: Kind;
  readonly streamId: number | null;
  readonly ext: string | null;
  /** Set only for kind === Opaque. */
  readonly url: string | null;
}

const RE_PREFIXED =
  /^(https?):\/\/([^/:]+)(?::(\d+))?\/(live|movie|series)\/([^/]+)\/([^/]+)\/(\d+)(?:\.([A-Za-z0-9]+))?$/;
const RE_LEGACY = /^(https?):\/\/([^/:]+)(?::(\d+))?\/([^/]+)\/([^/]+)\/(\d+)$/;

/**
 * Normalise a user-supplied server URL to a bare origin.
 * Accepts a full `get.php?...` playlist URL, a `player_api.php` URL, or a host.
 */
export function normaliseServerUrl(input: string): StreamBase {
  let raw = input.trim();
  if (raw === '') throw new Error('empty server url');
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  const u = new URL(raw);
  const protocol = u.protocol === 'https:' ? 'https' : 'http';
  const port = u.port === '' ? null : Number(u.port);
  return { protocol, host: u.hostname, port };
}

export function baseUrl(b: StreamBase): string {
  const defaultPort = b.protocol === 'https' ? 443 : 80;
  const suffix = b.port === null || b.port === defaultPort ? '' : `:${b.port}`;
  return `${b.protocol}://${b.host}${suffix}`;
}

/**
 * What a sign-in form actually receives from a reseller.
 *
 * Providers hand out `get.php?username=…&password=…` links far more often than
 * three separate fields. The username box has to accept that whole string —
 * otherwise the URL is sent to the panel as the username and auth always fails.
 */
export interface LineCredentials {
  /** Origin to try first, when the paste named a host. */
  readonly url: string | null;
  readonly username: string;
  readonly password: string;
}

/**
 * Resolve a username field (and optional password field) into panel credentials.
 *
 * Returns null when neither a complete link nor a username+password pair is present.
 */
export function parseLineCredentials(
  usernameOrUrl: string,
  password = '',
): LineCredentials | null {
  const raw = usernameOrUrl.trim();
  if (raw === '') return null;

  const looksLikeUrl =
    /^https?:\/\//i.test(raw)
    || /(?:^|[/?&#])(?:username|user|password|pass)=/i.test(raw)
    || /(?:^|\/)(?:get\.php|player_api\.php)/i.test(raw)
    || raw.includes('://');

  if (looksLikeUrl) {
    let withScheme = raw;
    if (!/^https?:\/\//i.test(withScheme)) withScheme = `http://${withScheme}`;
    let u: URL;
    try {
      u = new URL(withScheme);
    } catch {
      return null;
    }
    const fromQuery = (keys: string[]): string => {
      for (const k of keys) {
        const v = u.searchParams.get(k);
        if (v !== null && v !== '') return v;
      }
      return '';
    };
    const user = fromQuery(['username', 'user'])
      || (u.username !== '' ? decodeURIComponent(u.username) : '');
    const pass = fromQuery(['password', 'pass'])
      || (u.password !== '' ? decodeURIComponent(u.password) : '')
      || password;
    if (user === '' || pass === '') return null;
    return { url: baseUrl(normaliseServerUrl(withScheme)), username: user, password: pass };
  }

  if (password === '') return null;
  return { url: null, username: raw, password };
}

/**
 * Build the base from `server_info`, which is authoritative: multi-server panels
 * use it to steer clients at a load balancer, and it can differ from the host
 * the user typed.
 */
export function baseFromServerInfo(si: {
  url: string | null;
  port: number | null;
  httpsPort: number | null;
  protocol: string | null;
}): StreamBase | null {
  if (!si.url) return null;
  const wantHttps = si.protocol === 'https';
  return {
    protocol: wantHttps ? 'https' : 'http',
    host: si.url.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    port: wantHttps ? si.httpsPort : si.port,
  };
}

/** Credentials are percent-encoded in PATH segments (they contain @ + %). */
const seg = (s: string) => encodeURIComponent(s);

export interface BuildOpts {
  /** Force a container. Otherwise `ext`, then the account's preferred format. */
  readonly ext?: string | null;
  /** Emit the legacy no-prefix form for live. Required by some panels. */
  readonly legacyLive?: boolean;
}

export function buildStreamUrl(
  base: StreamBase,
  cred: Credentials,
  item: { kind: Kind; streamId: number | null; ext?: string | null; url?: string | null },
  opts: BuildOpts = {},
): string {
  if (item.kind === Kind.Opaque) {
    if (!item.url) throw new Error('opaque item has no stored url');
    return item.url;
  }
  if (item.streamId === null) throw new Error(`kind ${item.kind} item has no streamId`);

  const root = baseUrl(base);
  const u = seg(cred.username);
  const p = seg(cred.password);

  if (item.kind === Kind.Live && opts.legacyLive) {
    return `${root}/${u}/${p}/${item.streamId}`;
  }

  const ext = opts.ext ?? item.ext ?? null;
  const path = KIND_PATH[item.kind as Exclude<Kind, 0>];
  const dotExt = ext ? `.${ext}` : '';
  return `${root}/${path}/${u}/${p}/${item.streamId}${dotExt}`;
}

/**
 * Recognise a playlist URL so it can be stored as (kind, streamId, ext).
 * Returns an Opaque record when the shape is not an Xtream one.
 */
export function recognise(rawUrl: string): RecognisedUrl {
  const url = rawUrl.trim();

  const pre = RE_PREFIXED.exec(url);
  if (pre) {
    const kind =
      pre[4] === 'live' ? Kind.Live : pre[4] === 'movie' ? Kind.Movie : Kind.Episode;
    return { kind, streamId: Number(pre[7]), ext: pre[8] ?? null, url: null };
  }

  const leg = RE_LEGACY.exec(url);
  if (leg) {
    // Two path segments before a numeric id is the 1.x live form. Guard against
    // colliding with an unrelated `/a/b/123` URL by requiring no extension.
    return { kind: Kind.Live, streamId: Number(leg[6]), ext: null, url: null };
  }

  return { kind: Kind.Opaque, streamId: null, ext: null, url };
}

/**
 * Pick a live container. `allowed_output_formats` from `user_info` gates what the
 * account may request; "auto" prefers m3u8 (browser-playable) then ts.
 */
export function resolveLiveExt(
  allowed: readonly string[] | null,
  requested: string | 'auto' = 'auto',
): string {
  const norm = (allowed ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean);
  const want = requested.trim().toLowerCase();

  if (want !== 'auto' && want !== '') {
    if (norm.length === 0 || norm.includes(want)) return want;
    return norm[0]!;
  }
  if (norm.length === 0) return 'm3u8';
  if (norm.includes('m3u8')) return 'm3u8';
  if (norm.includes('ts')) return 'ts';
  return norm[0]!;
}

/* ── catch-up ───────────────────────────────────────────────────────────────
   Two URL families are in the wild and panels serve one or the other, never
   reliably both, so a client has to be able to build either and remember which
   one answered.

   Both take the START of the programme and a DURATION IN MINUTES — not an end
   time, and not seconds. Getting that unit wrong yields a stream that ends after
   a few seconds, which reads as "catch-up is broken" rather than as a unit bug.

   Credentials are raw in a query string and percent-encoded in a path segment.
   That asymmetry is not cosmetic: these passwords contain `@` and `%`, which a
   path segment must escape and a query value must not, or the panel rejects the
   request. */

export type ArchiveFamily = 'query' | 'path';

export interface ArchiveWindow {
  /** Programme start, epoch seconds. */
  readonly startTs: number;
  /** Programme end, epoch seconds. */
  readonly stopTs: number;
  /**
   * Extra minutes on the end.
   *
   * Panels cut archives on segment boundaries, so asking for exactly the
   * scheduled length reliably loses the last few seconds of the programme.
   */
  readonly tailMinutes?: number;
}

/** `YYYY-MM-DD:HH-MM` in UTC — the only spelling both families accept. */
export function archiveStamp(startTs: number): string {
  const d = new Date(startTs * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}:${p(d.getUTCHours())}-${p(d.getUTCMinutes())}`;
}

/** Duration in whole minutes, always at least one, plus the boundary tail. */
export function archiveMinutes(w: ArchiveWindow): number {
  const span = Math.max(0, w.stopTs - w.startTs);
  return Math.max(1, Math.ceil(span / 60)) + (w.tailMinutes ?? 2);
}

export function buildArchiveUrl(
  base: StreamBase,
  cred: Credentials,
  streamId: number,
  w: ArchiveWindow,
  family: ArchiveFamily,
  ext = 'ts',
): string {
  const root = baseUrl(base);
  const stamp = archiveStamp(w.startTs);
  const minutes = archiveMinutes(w);

  if (family === 'query') {
    const q = new URLSearchParams({
      username: cred.username,
      password: cred.password,
      stream: String(streamId),
      start: stamp,
      duration: String(minutes),
    });
    return `${root}/streaming/timeshift.php?${q.toString()}`;
  }
  return `${root}/timeshift/${seg(cred.username)}/${seg(cred.password)}/${minutes}/${stamp}/${streamId}.${ext}`;
}
