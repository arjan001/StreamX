/**
 * Stalker / Ministra middleware client.
 *
 * Flow: probe the API endpoint with a handshake -> `Bearer` token -> `get_profile`
 * (-> `do_auth` when the portal wants a login) -> catalogue reads. Every reply is
 * `{ "js": ... }`. A 401/403 or an "Authorization failed" body triggers ONE
 * re-handshake and retry.
 *
 * Stream links from `create_link` are short-lived and single-purpose: resolve
 * them right before playback (`resolveLiveUrl` / `resolveVodUrl`), never store
 * them in the catalogue.
 */
import {
  arrOf,
  flexInt,
  flexStr,
  objOrNull,
  type CategoryRow,
  type EpgEntry,
} from '@iptv/core-xtream';
import { makeDevice, sha1Hex, type DeviceIdentity, type DeviceInput } from './device.ts';
import { StalkerError } from './errors.ts';
import { endpointCandidates, parsePortalUrl, portalRootOf, type PortalUrl } from './portal.ts';
import {
  STB_USER_AGENT,
  STB_X_USER_AGENT,
  defaultStalkerFetch,
  type StalkerFetch,
} from './transport.ts';
import {
  normaliseChannel,
  normaliseEpgList,
  normaliseEpisodes,
  normaliseGenres,
  normaliseMovie,
  normaliseSeriesItem,
  seasonNumberOf,
  stripCmdPrefix,
  type NormOpts,
  type StalkerEpisodeRow,
  type StalkerItemRow,
  type StalkerSeriesRow,
} from './normalise.ts';

export interface StalkerOptions {
  portalUrl: string;
  device: DeviceInput;
  /** Injected HTTP layer. Devices need a native one (Cookie header). */
  fetch?: StalkerFetch;
  /** Only for portals that ask for a login after the MAC check. */
  login?: { username: string; password: string };
  /** IANA zone sent in the cookie; defaults to the runtime's. */
  timezone?: string;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  /** Pause between pagination requests. Default 0. */
  pageDelayMs?: number;
  /** Hard cap on pages per list. Default 500. */
  maxPages?: number;
  signal?: AbortSignal;
  /** Restore a cached session to skip the handshake. */
  session?: StalkerSession;
}

export interface StalkerSession {
  readonly endpoint: string;
  readonly token: string;
  readonly random: string | null;
}

export interface Paged<T> {
  readonly rows: T[];
  readonly total: number | null;
  /** True when `maxPages` stopped the walk before the portal ran out. */
  readonly truncated: boolean;
}

export interface LiveCatalogue {
  readonly categories: CategoryRow[];
  readonly rows: StalkerItemRow[];
  readonly truncated: boolean;
}

export interface SeriesDetail {
  readonly seasons: number[];
  readonly episodes: StalkerEpisodeRow[];
}

export interface StalkerProfile {
  readonly id: string | null;
  readonly name: string | null;
  readonly status: number | null;
  readonly raw: Record<string, unknown>;
}

const PROFILE_VER =
  'ImageDescription: 0.2.18-r14-pub-250; ImageDate: Fri Jan 15 15:20:44 EET 2016; ' +
  'PORTAL version: 5.1.0; API Version: JS API version: 343; STB API version: 146; Player Engine version: 0x58c';

type Module = 'itv' | 'vod' | 'series';

const AUTH_FAILED = /authori[sz]ation failed|access denied|not authori[sz]ed/i;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

function q(params: Record<string, string | number>): string {
  return (
    Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&') + '&JsHttpRequest=1-xml'
  );
}

export class StalkerClient {
  readonly portal: PortalUrl;
  readonly device: DeviceIdentity;
  private readonly transport: StalkerFetch;
  private readonly opts: StalkerOptions;
  private endpoint: string | null;
  private token: string | null;
  private random: string | null;
  /** Adult category ids per module: ids overlap between itv, vod and series. */
  private adult: Record<Module, Set<string>> = { itv: new Set(), vod: new Set(), series: new Set() };
  private loaded = new Set<Module>();
  private connecting: Promise<StalkerProfile> | null = null;

  constructor(opts: StalkerOptions) {
    this.opts = opts;
    this.portal = parsePortalUrl(opts.portalUrl);
    this.device = makeDevice(opts.device);
    this.transport = opts.fetch ?? defaultStalkerFetch;
    this.endpoint = opts.session?.endpoint ?? null;
    this.token = opts.session?.token ?? null;
    this.random = opts.session?.random ?? null;
  }

  get session(): StalkerSession | null {
    return this.endpoint && this.token
      ? { endpoint: this.endpoint, token: this.token, random: this.random }
      : null;
  }

  // ---- transport -------------------------------------------------------

  private headers(withToken: boolean): Record<string, string> {
    const tz = this.opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    const h: Record<string, string> = {
      'User-Agent': STB_USER_AGENT,
      'X-User-Agent': STB_X_USER_AGENT,
      Referer: this.portal.referer,
      Accept: '*/*',
      Cookie: `mac=${encodeURIComponent(this.device.mac)}; stb_lang=en; timezone=${tz}`,
    };
    if (withToken && this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  /** One HTTP round trip -> { status, text }. Maps transport failures to StalkerError. */
  private async get(url: string, withToken: boolean): Promise<{ status: number; text: string }> {
    const outer = this.opts.signal;
    if (outer?.aborted) throw new StalkerError('aborted', 'Request aborted');
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    outer?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 20_000);
    try {
      const res = await this.transport(url, { headers: this.headers(withToken), signal: ctl.signal });
      const text = await res.text();
      return { status: res.status, text };
    } catch (e) {
      if (outer?.aborted) throw new StalkerError('aborted', 'Request aborted');
      if (e instanceof StalkerError) throw e;
      throw new StalkerError('network', e instanceof Error ? e.message : 'Network error');
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  /** Decode the `{js}` envelope. HTML / empty bodies throw `bad_body`. */
  private unwrap(status: number, text: string): unknown {
    const body = text.replace(/^﻿/, '').trim();
    if (status === 401 || status === 403 || AUTH_FAILED.test(body.slice(0, 200))) {
      throw new StalkerError('auth', 'Portal rejected the credentials (authorization failed)', status);
    }
    if (status === 404) throw new StalkerError('unsupported', 'Not found on this portal', status);
    if (status >= 400) throw new StalkerError('http', `Portal answered HTTP ${status}`, status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new StalkerError('bad_body', body.startsWith('<') ? 'Portal returned an HTML page' : 'Portal returned a non-JSON reply', status);
    }
    const o = objOrNull(parsed);
    if (!o || !('js' in o)) throw new StalkerError('bad_body', 'Portal reply has no "js" envelope', status);
    return o['js'];
  }

  /** Authenticated API call with the single re-handshake retry. */
  private async call(params: Record<string, string | number>): Promise<unknown> {
    if (!this.endpoint || !this.token) await this.connect();
    const run = async () => {
      const { status, text } = await this.get(`${this.endpoint}?${q(params)}`, true);
      return this.unwrap(status, text);
    };
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof StalkerError) || e.code !== 'auth') throw e;
      this.token = null;
      await this.connect();
      return run();
    }
  }

  // ---- session ---------------------------------------------------------

  private async handshake(endpoint: string): Promise<{ token: string; random: string | null } | 'nojs'> {
    const url = `${endpoint}?${q({ type: 'stb', action: 'handshake', token: '' })}`;
    const { status, text } = await this.get(url, false);
    const js = objOrNull(this.unwrap(status, text));
    const token = js ? flexStr(js['token']) : null;
    if (!token) return 'nojs';
    return { token, random: js ? flexStr(js['random']) : null };
  }

  /** Probe endpoints (first time only), handshake, get_profile, optional do_auth. */
  connect(): Promise<StalkerProfile> {
    this.connecting ??= this.doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async doConnect(): Promise<StalkerProfile> {
    const candidates = this.endpoint ? [this.endpoint] : endpointCandidates(this.portal);
    let got: { token: string; random: string | null } | null = null;
    let authErr: StalkerError | null = null;
    let netErr: StalkerError | null = null;
    for (const ep of candidates) {
      try {
        const r = await this.handshake(ep);
        if (r === 'nojs') continue;
        this.endpoint = ep;
        got = r;
        break;
      } catch (e) {
        if (!(e instanceof StalkerError)) throw e;
        if (e.code === 'aborted') throw e;
        // A JSON "authorization failed" on the real endpoint and a 403 on a wrong
        // path look alike; remember it and keep probing.
        if (e.code === 'auth') authErr ??= e;
        if (e.code === 'network') netErr ??= e;
      }
    }
    if (!got || !this.endpoint) {
      throw authErr ?? netErr ?? new StalkerError('no_endpoint', 'No Stalker API endpoint answered at this address');
    }
    this.token = got.token;
    this.random = got.random;
    let profile = await this.fetchProfile();
    if (this.opts.login) {
      const r = await this.getAuthed({
        type: 'stb', action: 'do_auth',
        login: this.opts.login.username, password: this.opts.login.password,
      });
      if (r === false || r === 0 || r === '') {
        throw new StalkerError('auth', 'Portal rejected the login');
      }
      profile = await this.fetchProfile();
    }
    return profile;
  }

  private async getAuthed(params: Record<string, string | number>): Promise<unknown> {
    const { status, text } = await this.get(`${this.endpoint}?${q(params)}`, true);
    return this.unwrap(status, text);
  }

  private async fetchProfile(): Promise<StalkerProfile> {
    const d = this.device;
    const mac = d.mac;
    const metrics = JSON.stringify({ mac, sn: d.serial, model: '', type: 'STB', uid: '', random: this.random ?? '' });
    const js = await this.getAuthed({
      type: 'stb', action: 'get_profile',
      hd: 1, ver: PROFILE_VER, num_banks: 2, sn: d.serial, stb_type: 'MAG250',
      client_type: 'STB', image_version: 218, video_out: 'hdmi',
      device_id: d.deviceId, device_id2: d.deviceId2, signature: d.signature,
      auth_second_step: 1, hw_version: '1.7-BD-00', not_valid_token: 0,
      metrics, hw_version_2: sha1Hex(mac.toLowerCase()),
      timestamp: Math.floor(Date.now() / 1000), api_signature: 262, prehash: '',
    });
    const raw = objOrNull(js) ?? {};
    return { id: flexStr(raw['id']), name: flexStr(raw['name']), status: flexInt(raw['status']), raw };
  }

  // ---- helpers ---------------------------------------------------------

  private norm(mod: Module): NormOpts {
    return {
      origin: this.portal.origin,
      portalRoot: portalRootOf(this.endpoint ?? `${this.portal.origin}${this.portal.prefix}/portal.php`),
      adultIds: this.adult[mod],
    };
  }

  private async categories(mod: Module, action: string): Promise<CategoryRow[]> {
    const js = await this.optional<unknown>([], () => this.call({ type: mod, action }));
    const info = normaliseGenres(js);
    this.adult[mod] = new Set(info.adultIds);
    this.loaded.add(mod);
    return info.categories;
  }

  private async ensureCategories(mod: Module): Promise<void> {
    if (!this.loaded.has(mod)) await this.categories(mod, mod === 'itv' ? 'get_genres' : 'get_categories');
  }

  /** Module missing -> empty result instead of an error. */
  private async optional<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StalkerError && (e.code === 'unsupported' || e.code === 'bad_body')) return fallback;
      throw e;
    }
  }

  /** Walk `get_ordered_list` pages sequentially. */
  private async paged(params: Record<string, string | number>): Promise<Paged<unknown>> {
    const rows: unknown[] = [];
    const maxPages = this.opts.maxPages ?? 500;
    let total: number | null = null;
    for (let p = 1; p <= maxPages; p++) {
      if (p > 1 && (this.opts.pageDelayMs ?? 0) > 0) await sleep(this.opts.pageDelayMs!, this.opts.signal);
      const js = objOrNull(await this.call({ ...params, p }));
      const data = js ? arrOf(js['data']) : [];
      if (js) total = flexInt(js['total_items']) ?? total;
      if (data.length === 0) return { rows, total, truncated: false };
      rows.push(...data);
      if (total !== null && rows.length >= total) return { rows, total, truncated: false };
    }
    return { rows, total, truncated: true };
  }

  // ---- live ------------------------------------------------------------

  liveCategories(): Promise<CategoryRow[]> {
    return this.categories('itv', 'get_genres');
  }

  /** Genres + channels. Falls back to paging `get_ordered_list` when needed. */
  async liveCatalogue(): Promise<LiveCatalogue> {
    const categories = await this.liveCategories();
    let raw: unknown[] = [];
    let truncated = false;
    const all = await this.optional<unknown>(null, () => this.call({ type: 'itv', action: 'get_all_channels' }));
    const allObj = objOrNull(all);
    raw = Array.isArray(all) ? all : allObj ? arrOf(allObj['data']) : [];
    if (raw.length === 0) {
      const pg = await this.optional<Paged<unknown>>(
        { rows: [], total: 0, truncated: false },
        () => this.paged({ type: 'itv', action: 'get_ordered_list', genre: '*' }),
      );
      raw = pg.rows;
      truncated = pg.truncated;
    }
    const n = this.norm('itv');
    const rows: StalkerItemRow[] = [];
    for (const r of raw) {
      const row = normaliseChannel(r, n);
      if (row) rows.push(row);
    }
    return { categories, rows, truncated };
  }

  /**
   * Fresh playable URL for a channel. Links embed a short-lived token: call this
   * immediately before handing the URL to the player, every time.
   */
  resolveLiveUrl(channel: Pick<StalkerItemRow, 'cmd'>): Promise<string> {
    return this.createLink('itv', channel.cmd);
  }

  /** Fresh playable URL for a movie or an episode (`series` = `seriesParam`). */
  resolveVodUrl(item: { cmd: string }, series = ''): Promise<string> {
    return this.createLink('vod', item.cmd, series);
  }

  private async createLink(type: 'itv' | 'vod', cmd: string, series = ''): Promise<string> {
    const js = await this.call({
      type, action: 'create_link', cmd, series,
      forced_storage: 'undefined', disable_ad: 0, download: 0,
    });
    return linkFrom(js);
  }

  /**
   * Catch-up link. UNVERIFIED against real portals: the `tv_archive` module takes
   * the archive `cmd` (for many portals `auto /media/archive/<ch>/<start>.mpg`
   * style, returned by the EPG listing). TODO: confirm the cmd shape on a portal
   * with archive and add programme-to-cmd mapping; until then callers must supply
   * the archive cmd themselves.
   */
  async resolveArchiveUrl(archiveCmd: string): Promise<string> {
    return linkFrom(await this.call({ type: 'tv_archive', action: 'create_link', cmd: archiveCmd }));
  }

  // ---- EPG -------------------------------------------------------------

  async shortEpg(channelRemoteId: string, size = 10): Promise<EpgEntry[]> {
    const js = await this.optional<unknown>([], () =>
      this.call({ type: 'itv', action: 'get_short_epg', ch_id: channelRemoteId, size }),
    );
    return normaliseEpgList(Array.isArray(js) ? js : objOrNull(js)?.['data']);
  }

  /** Whole-guide read: channel remoteId -> programmes for the next `hours`. */
  async epgInfo(hours = 6): Promise<Map<string, EpgEntry[]>> {
    const js = await this.optional<unknown>(null, () =>
      this.call({ type: 'itv', action: 'get_epg_info', period: hours }),
    );
    const data = objOrNull(objOrNull(js)?.['data']) ?? {};
    const out = new Map<string, EpgEntry[]>();
    for (const [id, list] of Object.entries(data)) out.set(id, normaliseEpgList(list));
    return out;
  }

  // ---- VOD -------------------------------------------------------------

  vodCategories(): Promise<CategoryRow[]> {
    return this.categories('vod', 'get_categories');
  }

  /** One category's movies, all pages. Series entries the VOD list mixes in are skipped. */
  async vodList(categoryId: string): Promise<Paged<StalkerItemRow>> {
    await this.ensureCategories('vod');
    const pg = await this.optional<Paged<unknown>>(
      { rows: [], total: 0, truncated: false },
      () => this.paged({ type: 'vod', action: 'get_ordered_list', category: categoryId }),
    );
    const n = this.norm('vod');
    const rows: StalkerItemRow[] = [];
    for (const r of pg.rows) {
      const o = objOrNull(r);
      if (o && (flexInt(o['is_series']) === 1)) continue;
      const row = normaliseMovie({ category_id: categoryId, ...o }, n);
      if (row) rows.push(row);
    }
    return { rows, total: pg.total, truncated: pg.truncated };
  }

  // ---- series ----------------------------------------------------------

  seriesCategories(): Promise<CategoryRow[]> {
    return this.categories('series', 'get_categories');
  }

  async seriesList(categoryId: string): Promise<Paged<StalkerSeriesRow & { isAdult: boolean }>> {
    await this.ensureCategories('series');
    const pg = await this.optional<Paged<unknown>>(
      { rows: [], total: 0, truncated: false },
      () => this.paged({ type: 'series', action: 'get_ordered_list', category: categoryId }),
    );
    const n = this.norm('series');
    const rows = pg.rows.flatMap((r) => {
      const row = normaliseSeriesItem({ category_id: categoryId, ...objOrNull(r) }, n);
      return row ? [row] : [];
    });
    return { rows, total: pg.total, truncated: pg.truncated };
  }

  /** Seasons then episodes for one series (`remoteId` from the list row). */
  async seriesDetail(seriesRemoteId: string): Promise<SeriesDetail> {
    const n = this.norm('series');
    const seasonRows = await this.optional<Paged<unknown>>(
      { rows: [], total: 0, truncated: false },
      () => this.paged({ type: 'series', action: 'get_ordered_list', movie_id: seriesRemoteId, season_id: 0, episode_id: 0 }),
    );
    const seasons: number[] = [];
    const episodes: StalkerEpisodeRow[] = [];
    for (const r of seasonRows.rows) {
      const s = objOrNull(r);
      if (!s) continue;
      const num = seasonNumberOf(s) ?? seasons.length + 1;
      if (!seasons.includes(num)) seasons.push(num);
      if (Array.isArray(s['series']) && s['cmd']) {
        episodes.push(...normaliseEpisodes(num, [s], n));
        continue;
      }
      const eps = await this.optional<Paged<unknown>>(
        { rows: [], total: 0, truncated: false },
        () => this.paged({ type: 'series', action: 'get_ordered_list', movie_id: seriesRemoteId, season_id: flexStr(s['id']) ?? num, episode_id: 0 }),
      );
      episodes.push(...normaliseEpisodes(num, eps.rows, n));
    }
    return { seasons: seasons.sort((a, b) => a - b), episodes };
  }
}

/** `create_link` reply -> bare URL. */
export function linkFrom(js: unknown): string {
  const o = objOrNull(js);
  const cmd = flexStr(o?.['cmd']) ?? flexStr(js);
  const url = cmd ? stripCmdPrefix(cmd) : '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    throw new StalkerError('no_link', 'Portal did not return a playable link');
  }
  return url;
}
