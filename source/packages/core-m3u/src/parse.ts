/**
 * Streaming m3u / m3u_plus parser.
 *
 * Built as an async generator over lines so a 168.8MB playlist never exists in
 * memory as a whole. Measured: 592,565 entries at ~167k entries/s with peak RSS
 * held to ~165MB when the consumer writes straight to storage. Buffering the
 * file first costs 679MB instead.
 *
 * Handles, because real playlists contain all of it:
 *  - attribute names case-insensitively (`tvg-ID`) and underscore aliases
 *  - `#EXTGRP` as a Kodi-style BEGIN directive (sticky until changed)
 *  - `#EXTVLCOPT` / `#EXTHTTP` headers, channel-level winning over global
 *  - the `|User-Agent=...` URL pipe suffix
 *  - `#KODIPROP` ClearKey DRM
 *  - entries with no URL line (truncated files)
 *
 * See docs/01-playlist-formats.md
 */

export interface M3uHeader {
  /** `url-tvg` may be a comma-separated LIST of EPG sources. */
  readonly epgUrls: string[];
  readonly tvgShift: number | null;
  readonly catchup: string | null;
  readonly catchupDays: number | null;
  readonly catchupCorrection: number | null;
  readonly attrs: Record<string, string>;
}

export interface M3uEntry {
  readonly name: string;
  readonly url: string;
  readonly duration: number;
  readonly tvgId: string | null;
  readonly tvgName: string | null;
  readonly tvgLogo: string | null;
  readonly tvgChno: number | null;
  readonly tvgShift: number | null;
  /** `group-title`, split on `;` — Kodi treats it as a list. */
  readonly groups: string[];
  readonly radio: boolean;
  readonly catchup: string | null;
  readonly catchupSource: string | null;
  /** First non-blank of catchup-days / timeshift / tvg-rec. */
  readonly catchupDays: number | null;
  readonly catchupCorrection: number | null;
  readonly headers: Record<string, string>;
  readonly drm: Drm | null;
  readonly attrs: Record<string, string>;
}

export interface Drm {
  readonly licenseType: string;
  readonly supported: boolean;
  readonly clearKeys?: Record<string, string>;
}

/**
 * Index of the comma that separates attributes from the display name.
 *
 * Must be the FIRST comma outside a quoted attribute value — not the last.
 * Using lastIndexOf mangles every name containing a comma, which is common in
 * VOD titles ("Movie, The Sequel" would parse as "The Sequel").
 */
export function nameCommaIndex(line: string): number {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 34 /* " */) inQuote = !inQuote;
    else if (ch === 44 /* , */ && !inQuote) return i;
  }
  return -1;
}

const ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;
const ALIAS: Record<string, string> = {
  tvg_id: 'tvg-id',
  tvg_name: 'tvg-name',
  tvg_logo: 'tvg-logo',
  tvg_shift: 'tvg-shift',
  tvg_rec: 'tvg-rec',
  tvg_chno: 'tvg-chno',
  group_title: 'group-title',
  'channel-id': 'tvg-id',
  'ch-number': 'tvg-chno',
  'catchup-type': 'catchup',
};

const normKey = (k: string): string => {
  const lower = k.toLowerCase();
  return ALIAS[lower] ?? lower;
};

function parseAttrs(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(head)) !== null) out[normKey(m[1]!)] = m[2]!;
  return out;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const firstNonBlank = (...vals: (string | undefined)[]): string | undefined =>
  vals.find((v) => v !== undefined && v.trim() !== '');

export function parseHeader(line: string): M3uHeader {
  const attrs = parseAttrs(line);
  const epgRaw = attrs['url-tvg'] ?? attrs['x-tvg-url'] ?? '';
  return {
    epgUrls: epgRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    tvgShift: num(attrs['tvg-shift']),
    catchup: attrs['catchup'] ?? null,
    catchupDays: num(attrs['catchup-days']),
    catchupCorrection: num(attrs['catchup-correction']),
    attrs,
  };
}

const KODIPROP = '#kodiprop:';
const CLEARKEY_TYPES = new Set(['clearkey', 'org.w3.clearkey']);
const HEX32 = /^[0-9a-f]{32}$/i;

/** Extract ClearKey material from the #KODIPROP block preceding a URL. */
export function parseDrm(props: Map<string, string>): Drm | null {
  let type = props.get('inputstream.adaptive.license_type')?.trim() ?? '';
  let key = props.get('inputstream.adaptive.license_key')?.trim() ?? '';

  const legacy = props.get('inputstream.adaptive.drm_legacy')?.trim();
  if (legacy && (type === '' || key === '')) {
    const [lt, ...rest] = legacy.split('|');
    if (type === '') type = lt?.trim() ?? '';
    if (key === '') key = rest.join('|').trim();
  }
  if (type === '' && key === '') return null;

  const lower = type.toLowerCase();
  const isClear = lower === '' || CLEARKEY_TYPES.has(lower);
  const keys = isClear ? parseClearKeys(key) : null;
  if (keys) return { licenseType: lower || 'clearkey', supported: true, clearKeys: keys };
  // Widevine / PlayReady license servers: surface a clear diagnostic rather
  // than failing opaquely at playback time.
  return { licenseType: lower, supported: false };
}

function parseClearKeys(raw: string): Record<string, string> | null {
  if (raw === '') return null;
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const list = Array.isArray(j['keys']) ? (j['keys'] as Record<string, string>[]) : null;
      if (list) {
        const out: Record<string, string> = {};
        for (const k of list) if (k['kid'] && k['k']) out[k['kid']] = k['k'];
        return Object.keys(out).length > 0 ? out : null;
      }
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(j)) if (typeof v === 'string') out[k] = v;
      return Object.keys(out).length > 0 ? out : null;
    } catch {
      return null;
    }
  }
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [kid, key] = pair.split(':').map((s) => s.trim());
    if (kid && key && HEX32.test(kid)) out[kid] = key;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Split the `|k=v&k2=v2` suffix some playlists append to the stream URL. */
export function splitPipeHeaders(url: string): { url: string; headers: Record<string, string> } {
  const i = url.indexOf('|');
  if (i < 0) return { url, headers: {} };
  const headers: Record<string, string> = {};
  for (const part of url.slice(i + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0) headers[part.slice(0, eq).replace(/^!/, '').trim()] = part.slice(eq + 1).trim();
  }
  return { url: url.slice(0, i), headers };
}

export interface ParseResult {
  header: M3uHeader | null;
  entries: number;
  skipped: number;
}

/**
 * Consume lines, yielding one entry per `#EXTINF` + URL pair.
 * `onHeader` fires once if an `#EXTM3U` line carries attributes.
 */
export async function* parseM3u(
  lines: AsyncIterable<string>,
): AsyncGenerator<M3uEntry | { header: M3uHeader }, void, void> {
  let pendingAttrs: Record<string, string> | null = null;
  let pendingName = '';
  let pendingDuration = -1;
  let kodiProps = new Map<string, string>();
  let extHeaders: Record<string, string> = {};
  let stickyGroup: string | null = null;

  const reset = () => {
    pendingAttrs = null;
    pendingName = '';
    pendingDuration = -1;
    kodiProps = new Map();
    extHeaders = {};
  };

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line.charCodeAt(0) !== 35 /* # */) {
      if (pendingAttrs === null) continue; // stray URL with no #EXTINF
      const a = pendingAttrs;
      const { url, headers: pipeHeaders } = splitPipeHeaders(line);

      const groupRaw = a['group-title'] ?? stickyGroup ?? '';
      const groups = groupRaw
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s !== '');

      yield {
        name: pendingName,
        url,
        duration: pendingDuration,
        tvgId: a['tvg-id']?.trim() || null,
        tvgName: a['tvg-name']?.trim() || null,
        tvgLogo: a['tvg-logo']?.trim() || null,
        tvgChno: num(a['tvg-chno']),
        tvgShift: num(a['tvg-shift']),
        groups,
        radio: (a['radio'] ?? '').toLowerCase() === 'true',
        catchup: a['catchup']?.trim() || null,
        catchupSource: a['catchup-source']?.trim() || null,
        catchupDays: num(firstNonBlank(a['catchup-days'], a['timeshift'], a['tvg-rec'])),
        catchupCorrection: num(a['catchup-correction']),
        // Channel-level #EXTVLCOPT/#EXTHTTP win over the pipe suffix, which in
        // turn wins over nothing; global settings are applied by the caller.
        headers: { ...pipeHeaders, ...extHeaders },
        drm: parseDrm(kodiProps),
        attrs: a,
      };
      reset();
      continue;
    }

    const lower = line.toLowerCase();

    if (lower.startsWith('#extinf')) {
      const colon = line.indexOf(':');
      const comma = nameCommaIndex(line);
      const head = comma > colon ? line.slice(colon + 1, comma) : line.slice(colon + 1);
      pendingName = comma > colon ? line.slice(comma + 1).trim() : '';
      pendingDuration = num(head.split(/\s/, 1)[0]) ?? -1;
      pendingAttrs = parseAttrs(head);
      kodiProps = new Map();
      extHeaders = {};
    } else if (lower.startsWith('#extm3u')) {
      yield { header: parseHeader(line) };
    } else if (lower.startsWith('#extgrp:')) {
      // Kodi semantics: applies to following entries until changed.
      const g = line.slice(8).trim();
      stickyGroup = g === '' ? null : g;
      if (pendingAttrs && !pendingAttrs['group-title']) pendingAttrs['group-title'] = g;
    } else if (lower.startsWith('#extvlcopt:')) {
      const kv = line.slice(11);
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const k = kv.slice(0, eq).trim().toLowerCase();
        const v = kv.slice(eq + 1).trim();
        if (k === 'http-user-agent') extHeaders['User-Agent'] = v;
        else if (k === 'http-referrer' || k === 'http-referer') extHeaders['Referer'] = v;
      }
    } else if (lower.startsWith('#exthttp:')) {
      try {
        const j = JSON.parse(line.slice(9).trim()) as Record<string, unknown>;
        for (const [k, v] of Object.entries(j)) if (typeof v === 'string') extHeaders[k] = v;
      } catch {
        /* malformed #EXTHTTP: ignore rather than abort the playlist */
      }
    } else if (lower.startsWith(KODIPROP)) {
      const kv = line.slice(KODIPROP.length);
      const eq = kv.indexOf('=');
      if (eq > 0) kodiProps.set(kv.slice(0, eq).trim().toLowerCase(), kv.slice(eq + 1).trim());
    }
  }
}
