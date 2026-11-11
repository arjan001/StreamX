/**
 * Tolerant coercion for Xtream panel JSON.
 *
 * Panels emit integers as strings, booleans as 0/1 or "0"/"1", and objects as
 * empty arrays when a record has no data. Forks disagree with each other, and a
 * single response can mix conventions (measured: `auth` and `timestamp_now`
 * arrive as numbers while `exp_date` and `max_connections` arrive as strings in
 * the same payload). Every field read from a panel goes through here.
 *
 * See docs/02-xtream-api.md section 4.
 */

/** `"1"` | `1` | `"12"` -> number. `""`, `null`, `undefined`, junk -> null. */
export function flexInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

export function flexIntOr(v: unknown, fallback: number): number {
  return flexInt(v) ?? fallback;
}

/** `"8.2"` | `8.2` -> number. `""` / junk -> null. */
export function flexFloat(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * `1` | `"1"` | `true` -> true. Used for `auth`, `tv_archive`, `is_adult`,
 * `has_archive`, `now_playing`.
 */
export function flexBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    return t === '1' || t === 'true' || t === 'yes';
  }
  return false;
}

/** Trimmed string, or null for `""` / `null` / non-strings. */
export function flexStr(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Panels return `[]` instead of `{}` for absent nested records — notably
 * `get_vod_info.info` and `get_series_info.seasons` / `.episodes`. An empty
 * array here means "no data", not "a list".
 */
export function objOrNull(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return null;
  return typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** An array field that may arrive as a bare object, a scalar, or absent. */
export function arrOf<T = unknown>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v === null || v === undefined || v === '') return [];
  return [v as T];
}

/** `backdrop_path` is a string on some forks and an array on others. */
export function flexStrArray(v: unknown): string[] {
  return arrOf(v)
    .map((x) => flexStr(x))
    .filter((x): x is string => x !== null);
}

const B64_SHAPE = /^[A-Za-z0-9+/\s]+={0,2}$/;
// Control chars that indicate we decoded binary noise rather than text.
const CTRL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]');

/**
 * Base64 to bytes, in a browser as well as in Node.
 *
 * Not `Buffer.from(s, 'base64')` alone: the EPG is decoded on the device, and
 * `Buffer` does not exist in a browser — the reference would throw, the catch
 * below would return the raw string, and every programme in the guide would
 * render as its own base64 — `R2VlbiB1aXR6ZW5kaW5n` where "Geen uitzending"
 * should be. A fallback that hides a missing global is a fallback that turns a
 * crash into twenty thousand unreadable rows.
 *
 * `atob` is the one that exists in both (Node has had it since 16), so it leads
 * and `Buffer` is the fallback rather than the other way round.
 */
function base64Bytes(compact: string): Uint8Array | null {
  if (typeof atob === 'function') {
    const bin = atob(compact);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(compact, 'base64');
  return null;
}

/**
 * EPG `title` and `description` are Base64-encoded UTF-8 — but some forks
 * double-encode and some do not encode at all. Decode, validate the result is
 * plausible UTF-8 text, and fall back to the raw string when it is not.
 *
 * See docs/02-xtream-api.md section 5.
 */
export function decodeMaybeBase64(v: unknown): string | null {
  const raw = flexStr(v);
  if (raw === null) return null;
  const compact = raw.replace(/\s+/g, '');
  // Padded base64 is a multiple of 4; bail early so plain text that merely
  // looks base64-ish is never mangled.
  if (compact.length < 4 || compact.length % 4 !== 0 || !B64_SHAPE.test(raw)) return raw;
  try {
    const buf = base64Bytes(compact);
    if (buf === null || buf.length === 0) return raw;
    const out = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (CTRL.test(out)) return raw;
    return out.trim() === '' ? raw : out;
  } catch {
    return raw;
  }
}

/** Unix seconds (string or number) -> Date. null for never-expiring lines. */
export function flexEpoch(v: unknown): Date | null {
  const n = flexInt(v);
  if (n === null || n <= 0) return null;
  return new Date(n * 1000);
}
