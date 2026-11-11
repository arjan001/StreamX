/**
 * Xtream `player_api.php` client.
 *
 * Deliberately boring about concurrency: panels ship flood protection rather
 * than `429`, and exceeding a per-IP request rate gets you firewall-blocked for
 * minutes with no `Retry-After`. So requests are serialised through a single
 * queue with spacing, and `get_series_info` is never fanned out.
 *
 * See docs/02-xtream-api.md section 8.
 */
import { flexBool, flexEpoch, flexInt, flexStr, objOrNull, arrOf } from './coerce.ts';
import { baseUrl, normaliseServerUrl, type Credentials, type StreamBase } from './urls.ts';

export const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

export interface ClientOpts {
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
  /** Providers gate on this at the WAF layer. Same value everywhere. */
  readonly userAgent?: string;
  /** Minimum gap between requests. Panels flood-protect; do not lower blindly. */
  readonly minGapMs?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Byte-level progress while reading a response body. See `readCounted`. */
  readonly onBytes?: (p: { label: string; bytes: number; total: number | null }) => void;
}

export interface UserInfo {
  readonly auth: boolean;
  readonly status: string | null;
  readonly expDate: Date | null;
  readonly isTrial: boolean;
  readonly activeCons: number;
  readonly maxConnections: number | null;
  readonly allowedOutputFormats: string[];
}

export interface ServerInfo {
  readonly url: string | null;
  readonly port: number | null;
  readonly httpsPort: number | null;
  readonly protocol: string | null;
  readonly timezone: string | null;
  readonly timestampNow: number | null;
}

export class XtreamAuthError extends Error {
  /**
   * `auth: 0` means bad credentials OR the connection limit being exhausted —
   * the panel returns the same thing for both, which is why this carries the
   * ambiguity instead of claiming one.
   */
  constructor(msg: string) {
    super(msg);
    this.name = 'XtreamAuthError';
  }
}

export class XtreamHttpError extends Error {
  readonly status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.name = 'XtreamHttpError';
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * SHA-256 as lowercase hex, via WebCrypto so this stays platform-neutral.
 *
 * `crypto.subtle` is only exposed on a secure context — which `https://` and
 * `http://localhost` are, but a plain-HTTP LAN address is not. Callers that may run
 * there need to handle the throw rather than assume a digest.
 */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class XtreamClient {
  readonly base: StreamBase;
  readonly cred: Credentials;
  private readonly ua: string;
  private readonly minGapMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Called while a response body is being read.
   *
   * An ingest of this catalogue is ~58MB over six requests, and the transfer is
   * essentially all of the elapsed time — parsing 17MB of JSON measures 46ms.
   * So a progress bar for an ingest is a DOWNLOAD progress bar, and this is
   * where the bytes are counted. `total` is null whenever the panel sends no
   * `content-length`, which it usually does not for chunked replies.
   */
  onBytes?: ((p: { label: string; bytes: number; total: number | null }) => void) | undefined;
  /** Serialises every request; see the class doc. */
  private tail: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(opts: ClientOpts) {
    this.base = normaliseServerUrl(opts.serverUrl);
    this.cred = { username: opts.username, password: opts.password };
    this.ua = opts.userAgent ?? DEFAULT_UA;
    this.minGapMs = opts.minGapMs ?? 200;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.log = opts.log ?? (() => {});
    this.onBytes = opts.onBytes;
  }

  /**
   * Read a body while reporting how much has arrived.
   *
   * Falls back to `res.text()` when the platform has no readable stream, which
   * is what makes this safe to enable unconditionally: the counter is a nicety
   * and the payload is not.
   */
  private async readCounted(res: Response, label: string): Promise<string> {
    const total = Number(res.headers.get('content-length') ?? '') || null;
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') return res.text();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        bytes += value.byteLength;
        this.onBytes?.({ label, bytes, total });
      }
    }
    const joined = new Uint8Array(bytes);
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.byteLength;
    }
    return new TextDecoder().decode(joined);
  }

  /** Credentials stay RAW in query strings; encoding them breaks some panels. */
  private apiUrl(params: Record<string, string | number>): string {
    const q = new URLSearchParams({
      username: this.cred.username,
      password: this.cred.password,
    });
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    return `${baseUrl(this.base)}/player_api.php?${q.toString()}`;
  }

  private async fetchJson(url: string, label: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.minGapMs - (Date.now() - this.lastAt);
      if (wait > 0) await sleep(wait);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': this.ua, Accept: 'application/json,*/*' },
          redirect: 'follow',
          signal: ac.signal,
        });
        this.lastAt = Date.now();
        if (!res.ok) {
          /*
           * Retry 5xx, 404, and 451.
           *
           * 512 is not a real status code and lands here for the same reason.
           * The 404 is the surprising one: `player_api.php` demonstrably exists —
           * it answers 200 from the same machine seconds earlier — but this panel
           * returns 404 for it while it is busy, which is one of several odd ways
           * it expresses flood protection (a wrong password is 513). Treating it
           * as permanent aborts a whole 58MB ingest over a moment of load.
           * 451 (Unavailable For Legal Reasons) is another flood-protection
           * disguise: some panels return it when the account is temporarily
           * rate-limited, and retrying with backoff clears the block.
           */
          const retryable = res.status >= 500 || res.status === 404 || res.status === 451;
          if (retryable && attempt < this.maxRetries) {
            const backoff = 500 * 2 ** attempt;
            this.log('retrying after server error', { label, status: res.status, backoff });
            await sleep(backoff);
            continue;
          }
          // The path, never the query: the query carries the subscription's
          // password, and this message reaches logs and the UI.
          const path = new URL(url).pathname;
          throw new XtreamHttpError(`${label}: HTTP ${res.status} from ${path}`, res.status);
        }
        const text = this.onBytes ? await this.readCounted(res, label) : await res.text();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          // Providers who disable endpoints often return an HTML page with 200.
          throw new XtreamHttpError(
            `${label}: expected JSON, got ${text.slice(0, 60).replace(/\s+/g, ' ')}`,
            res.status,
          );
        }
      } catch (err) {
        this.lastAt = Date.now();
        const retryable =
          err instanceof XtreamHttpError === false && attempt < this.maxRetries;
        if (retryable) {
          const backoff = 500 * 2 ** attempt;
          this.log('retrying after network error', { label, backoff, err: String(err) });
          await sleep(backoff);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** All calls funnel through here so nothing ever runs concurrently. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }

  private call<T>(params: Record<string, string | number>, label: string): Promise<T> {
    return this.enqueue(() => this.fetchJson(this.apiUrl(params), label) as Promise<T>);
  }

  async authenticate(): Promise<{ user: UserInfo; server: ServerInfo }> {
    const raw = (await this.enqueue(() =>
      this.fetchJson(this.apiUrl({}), 'auth'),
    )) as Record<string, unknown>;
    const ui = objOrNull(raw['user_info']) ?? {};
    const si = objOrNull(raw['server_info']) ?? {};

    const user: UserInfo = {
      auth: flexBool(ui['auth']),
      status: flexStr(ui['status']),
      expDate: flexEpoch(ui['exp_date']),
      isTrial: flexBool(ui['is_trial']),
      activeCons: flexInt(ui['active_cons']) ?? 0,
      maxConnections: flexInt(ui['max_connections']),
      allowedOutputFormats: arrOf<string>(ui['allowed_output_formats'])
        .map((f) => flexStr(f))
        .filter((f): f is string => f !== null),
    };
    if (!user.auth) {
      throw new XtreamAuthError(
        'panel returned auth:0 — bad credentials or connection limit reached',
      );
    }
    const server: ServerInfo = {
      url: flexStr(si['url']),
      port: flexInt(si['port']),
      httpsPort: flexInt(si['https_port']),
      protocol: flexStr(si['server_protocol']),
      timezone: flexStr(si['timezone']),
      timestampNow: flexInt(si['timestamp_now']),
    };
    return { user, server };
  }

  liveCategories = () => this.call<unknown[]>({ action: 'get_live_categories' }, 'live_categories');
  vodCategories = () => this.call<unknown[]>({ action: 'get_vod_categories' }, 'vod_categories');
  seriesCategories = () =>
    this.call<unknown[]>({ action: 'get_series_categories' }, 'series_categories');

  liveStreams = (categoryId?: string) =>
    this.call<unknown[]>(
      categoryId ? { action: 'get_live_streams', category_id: categoryId } : { action: 'get_live_streams' },
      'live_streams',
    );
  vodStreams = (categoryId?: string) =>
    this.call<unknown[]>(
      categoryId ? { action: 'get_vod_streams', category_id: categoryId } : { action: 'get_vod_streams' },
      'vod_streams',
    );
  series = (categoryId?: string) =>
    this.call<unknown[]>(
      categoryId ? { action: 'get_series', category_id: categoryId } : { action: 'get_series' },
      'series',
    );

  vodInfo = (vodId: number) =>
    this.call<Record<string, unknown>>({ action: 'get_vod_info', vod_id: vodId }, 'vod_info');
  /** Lazy by design — never call this in a loop over the catalogue. */
  seriesInfo = (seriesId: number) =>
    this.call<Record<string, unknown>>(
      { action: 'get_series_info', series_id: seriesId },
      'series_info',
    );
  shortEpg = (streamId: number, limit = 4) =>
    this.call<Record<string, unknown>>(
      { action: 'get_short_epg', stream_id: streamId, limit },
      'short_epg',
    );
  epgTable = (streamId: number) =>
    this.call<Record<string, unknown>>(
      { action: 'get_simple_data_table', stream_id: streamId },
      'epg_table',
    );

  /**
   * Cheap change probe: 79KB of category lists versus 168.8MB for the flat playlist.
   *
   * All THREE category lists, not just live. Hashing live alone made a VOD-only
   * change invisible, so an ingest would short-circuit and never see a new film
   * category — measured against a panel that publishes 829/119/95 of them.
   *
   * WebCrypto rather than `node:crypto`, because this has to run in a browser for
   * the standalone client. A dynamic `import('node:crypto')` gets externalised by
   * the bundler and throws at runtime there; `crypto.subtle` exists in Node 18+ and
   * in every browser on a secure context.
   */
  async catalogueFingerprint(): Promise<string> {
    const parts = [
      await this.liveCategories(),
      await this.vodCategories(),
      await this.seriesCategories(),
    ];
    return sha256Hex(JSON.stringify(parts));
  }
}
