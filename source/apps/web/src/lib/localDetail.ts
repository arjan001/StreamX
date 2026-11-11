/**
 * Film and series detail, fetched and cached on the device.
 *
 * The panel's `get_vod_info` and `get_series_info` are per-title calls, which is
 * why the server cached them for seven days and twelve hours respectively — and
 * why they were among the last routes to move. What changes here is not the
 * caching but WHO pays for a miss: on the server one failing title cost one
 * request in one process, and on a device it costs one request per open, per
 * viewer, for ever.
 *
 * So a FAILURE is cached too, and that is mandatory rather than an optimisation.
 * `XtreamClient` deliberately retries a 404 — this panel returns 404 for
 * `player_api.php` while it is busy, which is one of several odd ways it expresses
 * flood protection — with 500/1000/2000/4000ms of backoff. That is 7.5 seconds of
 * a serialised queue blocked on a title the panel genuinely does not know, every
 * single time someone opens it, with everything else in the queue waiting behind.
 */
import {
  normaliseSeriesInfo, normaliseSeriesMeta, normaliseVodInfo,
} from '@iptv/core-xtream';
import { blobs } from './localCatalogue.ts';
import { panelClient } from './providers/panel.ts';
import { stalkerActive, withStalker } from './providers/index.ts';
import { rememberEpisode, stalkerRefFor } from './playSide.ts';
import { Kind } from '@iptv/core-xtream';
import { scheduler } from './providers/scheduler.ts';

/** `get_vod_info` for a title is effectively immutable; the TTL is for corrections. */
const MOVIE_TTL = 7 * 24 * 3600_000;
/** A running series grows an episode; by the next morning is soon enough. */
const SERIES_TTL = 12 * 3600_000;
/** Long enough that a title the panel does not know is asked about once a day. */
const FAIL_TTL = 24 * 3600_000;

interface Cached<T> { at: number; ok: boolean; value: T | null }

/* Keyed by prefix rather than by the server's negative-id trick — that existed
   only because films and series shared one SQL table. */
const key = (kind: 'movie' | 'series', id: number) => `detail.${kind}.${id}`;

async function read<T>(k: string): Promise<Cached<T> | null> {
  try {
    const raw = await blobs().get(k);
    return raw === null || raw === undefined ? null : raw as Cached<T>;
  } catch { return null; }
}

async function write<T>(k: string, v: Cached<T>): Promise<void> {
  try { await blobs().put(k, v); } catch { /* no storage; this session only */ }
}

function fresh(hit: Cached<unknown> | null, ttl: number): boolean {
  if (hit === null) return false;
  return Date.now() - hit.at < (hit.ok ? ttl : FAIL_TTL);
}

/**
 * One series' episode tree.
 *
 * At `foreground` priority: somebody has just pressed a title and is looking at a
 * loading state. Without a shared priority band a guide top-up in flight would put
 * this forty seconds behind.
 */
export async function seriesInfo(seriesId: number): Promise<{
  seasons: number[];
  episodes: ReturnType<typeof normaliseSeriesInfo>['episodes'];
  meta: ReturnType<typeof normaliseSeriesMeta> | null;
} | null> {
  /* A portal's episodes are listed fresh each time: their `cmd` is what plays them,
     and it is remembered in memory only (`playSide.ts`), never in the cache. */
  if (stalkerActive()) return portalSeries(seriesId) as never;
  const k = key('series', seriesId);
  const hit = await read<{ seasons: number[]; episodes: unknown[]; meta: unknown }>(k);
  if (fresh(hit, SERIES_TTL)) return hit!.value as never;

  const client = panelClient();
  if (client === null) return null;
  return scheduler.submit(`series:${seriesId}`, 'foreground', async () => {
    try {
      const raw = await client.seriesInfo(seriesId);
      const detail = normaliseSeriesInfo(raw);
      const meta = normaliseSeriesMeta(raw);
      const value = { seasons: detail.seasons, episodes: detail.episodes, meta };
      await write(k, { at: Date.now(), ok: true, value });
      return value as never;
    } catch {
      await write(k, { at: Date.now(), ok: false, value: null });
      return null;
    }
  });
}

async function portalSeries(seriesId: number): Promise<{
  seasons: number[]; episodes: ReturnType<typeof normaliseSeriesInfo>['episodes']; meta: null;
} | null> {
  const ref = stalkerRefFor(Kind.Episode, seriesId);
  if (ref === null) return null;
  try {
    const detail = await withStalker((c) => c.seriesDetail(ref.remoteId));
    for (const e of detail.episodes) rememberEpisode(e.episodeId, { cmd: e.cmd, seriesParam: e.seriesParam });
    return { seasons: detail.seasons, episodes: detail.episodes, meta: null };
  } catch { return null; }
}

/** One film's plot, cast, runtime and artwork. */
export async function movieInfo(streamId: number): Promise<ReturnType<typeof normaliseVodInfo> | null> {
  const k = key('movie', streamId);
  const hit = await read<ReturnType<typeof normaliseVodInfo>>(k);
  if (fresh(hit, MOVIE_TTL)) return hit!.value;

  const client = panelClient();
  if (client === null) return null;
  return scheduler.submit(`movie:${streamId}`, 'foreground', async () => {
    try {
      const value = normaliseVodInfo(await client.vodInfo(streamId));
      await write(k, { at: Date.now(), ok: true, value });
      return value;
    } catch {
      await write(k, { at: Date.now(), ok: false, value: null });
      return null;
    }
  });
}
