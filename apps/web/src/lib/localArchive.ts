/**
 * Catch-up playback, built on the device — the archive twin of `localPlay` and
 * `localEpisodePlay` in `localRead.ts`. The device holds the credentials and
 * the panel's URL shape is public, so the device builds the URL.
 *
 * In order:
 *
 *   1. Validate `start`/`stop` as epoch seconds, `stop > start`.
 *   2. Resolve the row; `null` if it or its `streamId` is missing.
 *   3. Refuse "this channel keeps no archive" if `!row.archive`.
 *   4. Refuse "that programme has not aired yet" if `start > now`.
 *   5. Refuse "outside the archive window" if `now - start` exceeds
 *      `row.archiveDays` (floor of 1 day).
 *   6. Probe the URL family ('query' vs 'path' — `core-xtream`'s
 *      `buildArchiveUrl` builds both) once per provider and remember it
 *      (`probeArchiveFamily`, `cachedArchiveFamily` / `rememberArchiveFamily`).
 *      Probing per seek is unacceptable: on a `max_connections: 1` line a
 *      client that re-probed on every press would spend the one connection a
 *      real play needs on a question it already knows the answer to.
 *   7. Answer `{ url, container: 'mpegts', direct, isLive: false, minutes,
 *      notes }`.
 *
 * ── the timezone decision ────────────────────────────────────────────────
 *
 * `archiveStamp` in `packages/core-xtream/src/urls.ts` formats the programme
 * start in UTC, and nothing here shifts it into the panel's own timezone. The
 * two reference implementations genuinely disagree (Kodi: UTC via `gmtime_r`;
 * IPTVnator: `server_info.timezone`) and `docs/03-catchup-epg.md`'s own
 * "Resolution" paragraph recommends the latter as a default.
 *
 * Evidence beat that recommendation:
 *
 *   - Measured on a panel whose own `server_info.timezone` reads
 *     `Europe/Amsterdam`: a UTC stamp against a real programme from ~2 hours
 *     ago answered `206 video/mp2t` on the `query` family on the first
 *     attempt, and a locally-formatted one 404s on both families.
 *   - The auth response does carry a second clock, `server_info.timestamp_now`
 *     (`ServerInfo.timestampNow` in `core-xtream/client.ts`), but only
 *     `timezone` is persisted into the cached `Subscription`
 *     (`providers/panel.ts`'s `remember()`), so it is not available at play
 *     time without spending a fresh `authenticate()` call.
 *
 * So the timeshift wall clock is UTC regardless of what `server_info.timezone`
 * claims, matching Kodi's default rather than IPTVnator's.
 */
import {
  archiveMinutes, buildArchiveUrl, normaliseServerUrl,
  type ArchiveFamily, type ArchiveWindow, type Credentials, type StreamBase,
} from '@iptv/core-xtream';
import { activeProvider, credentials, stalkerActive, streamBase } from './providers/index.ts';
import { stalkerArchivePlay } from './stalkerPlay.ts';
import { localItem } from './localRead.ts';
import { kv } from './kv.ts';
import type { ArchiveTarget } from './api.ts';

/**
 * The fields `gateArchiveRequest` needs from a row — a subset of `Item`, kept
 * narrow so the check is testable with a plain object instead of a whole
 * catalogue row.
 */
export interface ArchiveGateInput {
  readonly archive: boolean;
  readonly archiveDays: number;
}

/**
 * Steps 1, 3, 4 and 5 of the header (step 2 — "does this id resolve to a row
 * with a stream id at all" — is a local-catalogue question, handled by the
 * caller before this runs, the same way `localPlay` returns `null` rather than
 * throwing when the row itself is missing).
 *
 * A string names what is wrong, so `Catchup.tsx`'s `setNote(err.message)` shows
 * it as is. `null` means the request may proceed. `nowTs` is a parameter rather than a
 * `Date.now()` read so this stays deterministic under test.
 */
export function gateArchiveRequest(
  row: ArchiveGateInput, startTs: number, stopTs: number, nowTs: number,
): string | null {
  if (!Number.isFinite(startTs) || !Number.isFinite(stopTs) || stopTs <= startTs) {
    return 'start and stop are required epoch seconds';
  }
  if (!row.archive) return 'this channel keeps no archive';
  if (startTs > nowTs) return 'that programme has not aired yet';
  const depth = (row.archiveDays > 0 ? row.archiveDays : 1) * 86_400;
  if (nowTs - startTs > depth) {
    return `outside the archive window — this channel keeps ${row.archiveDays} day(s)`;
  }
  return null;
}

/**
 * Step 7 of the header. This device fetches its own archive the same way it
 * fetches its own live and VOD, so `direct` is always `true`.
 *
 * The note is deliberately prefixed `archive:` — `Catchup.tsx` already special-
 * cases `note.startsWith('archive')` to show it even with diagnostics off, so a
 * viewer on a phone or the TV app still sees which endpoint and how long, not
 * just a desktop with `showDiagnostics()` on.
 */
export function buildLocalArchiveTarget(
  base: StreamBase, cred: Credentials, streamId: number, win: ArchiveWindow, family: ArchiveFamily,
): ArchiveTarget {
  const minutes = archiveMinutes(win);
  return {
    url: buildArchiveUrl(base, cred, streamId, win, family),
    container: 'mpegts',
    direct: true,
    notes: [`archive: ${minutes} min via the ${family} endpoint`],
    isLive: false,
    minutes,
  };
}

/** Where the winning family is remembered, one entry per provider. */
const FAMILY_KEY = 'iptv.archive.family.v1';

/**
 * What was learned last time this provider's archive was played, or `null` if
 * it has never been probed (or storage is unavailable — `kv` degrades to that
 * silently, same as everywhere else it is used).
 */
export function cachedArchiveFamily(providerId: number): ArchiveFamily | null {
  const raw = kv.get(`${FAMILY_KEY}.${providerId}`);
  return raw === 'query' || raw === 'path' ? raw : null;
}

export function rememberArchiveFamily(providerId: number, family: ArchiveFamily): void {
  kv.set(`${FAMILY_KEY}.${providerId}`, family);
}

/** A tiny ranged GET, read and discarded — never a real download. */
const PROBE_RANGE = 'bytes=0-1023';
const PROBE_TIMEOUT_MS = 8_000;

async function answersWithMedia(url: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Range: PROBE_RANGE }, signal: ctl.signal });
    const type = res.headers.get('content-type') ?? '';
    if (res.body) void res.body.cancel().catch(() => {});
    return res.ok && !/text|html|json/i.test(type);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try both URL families and keep the one that answers with video.
 *
 * `query` first: it is the family measured to work (`docs/03-catchup-epg.md`,
 * and the header). Stops at the first success, so a panel that answers `query`
 * never pays for a `path` request too.
 */
export async function probeArchiveFamily(
  base: StreamBase, cred: Credentials, streamId: number, win: ArchiveWindow,
): Promise<ArchiveFamily | null> {
  for (const family of ['query', 'path'] as const) {
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential: one
    // connection at a time against a max_connections:1 line.
    if (await answersWithMedia(buildArchiveUrl(base, cred, streamId, win, family))) return family;
  }
  return null;
}

/**
 * `api.archivePlay`'s local half.
 *
 * `null` means "not answerable on this device" — no local catalogue row, or no
 * active xtream subscription — the same contract `localPlay` and
 * `localEpisodePlay` use. Anything else wrong
 * with the REQUEST (no archive, outside the window, panel answered neither
 * family) is a real answer this device is fully equipped to give, so it throws
 * instead — `Catchup.tsx` already renders `err.message` on the catch.
 */
export async function localArchivePlay(
  itemId: number | string, startTs: number, stopTs: number,
): Promise<ArchiveTarget | null> {
  const row = localItem(itemId);
  if (row === null || row.streamId === null) return null;
  if (stalkerActive()) {
    /* Same gate as a panel's catch-up: the channel must say it keeps an archive. */
    const refusal = gateArchiveRequest(row, startTs, stopTs, Math.floor(Date.now() / 1000));
    if (refusal !== null) throw new Error(`archive: ${refusal}`);
    return stalkerArchivePlay(itemId, startTs, stopTs);
  }

  const rawBase = streamBase();
  const cred = credentials();
  const provider = activeProvider();
  if (rawBase === null || cred === null || provider === null) return null;

  const problem = gateArchiveRequest(row, startTs, stopTs, Math.floor(Date.now() / 1000));
  if (problem !== null) throw new Error(`archive: ${problem}`);

  const base = normaliseServerUrl(rawBase);
  const win: ArchiveWindow = { startTs, stopTs };
  const streamId = row.streamId;

  const known = cachedArchiveFamily(provider.id);
  const family = known ?? await probeArchiveFamily(base, cred, streamId, win);
  if (family === null) {
    throw new Error(
      'archive: this panel answered neither archive endpoint — that is a panel-side '
      + 'limitation, not a device setting.',
    );
  }
  if (known === null) rememberArchiveFamily(provider.id, family);

  return buildLocalArchiveTarget(base, cred, streamId, win, family);
}
