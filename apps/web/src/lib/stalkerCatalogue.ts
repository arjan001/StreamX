/**
 * A Stalker portal, read and turned into a catalogue ON THE DEVICE.
 *
 * The path a Provider of kind `stalker` takes, beside `m3uCatalogue.ts`. The
 * portal's rows (`@iptv/core-stalker`, which already speaks `core-xtream`'s row
 * shapes) are written back out as the raw payloads `buildCatalogue` consumes, so
 * lists, search, favourites, the guide and the permanent adult filter see a
 * portal exactly as they see an Xtream line.
 *
 * What a row cannot carry — the portal's `cmd` and id, which `create_link` and
 * the guide ask by — goes into the side map (`playSide.ts`). No playable URL is
 * ever stored: links are short-lived and are resolved at the moment of playback.
 */
import { isAdultCategoryName, isAdultTitle, Kind } from '@iptv/core-xtream';
import type { StalkerClient } from '@iptv/core-stalker';
import type { RawPayloads } from '@iptv/core-store';
import { breather } from './breather.ts';
import { emptySide, type SideMap } from './playSide.ts';

/** A hard cap per section, so one enormous portal cannot fill a phone. */
const MAX_LIVE = 40_000;
const MAX_VOD = 30_000;
const MAX_SERIES = 15_000;

export interface StalkerProgress { rows: number }

export interface StalkerLoad {
  payloads: RawPayloads;
  side: SideMap;
  rows: number;
  /** A section stopped at a page or row cap before the portal ran out. */
  truncated: boolean;
}

interface Cat { category_id: string; category_name: string; parent_id: number }

const toCat = (c: { remoteId: string; name: string; parentId: number }): Cat => (
  { category_id: c.remoteId, category_name: c.name, parent_id: c.parentId }
);

/** Categories that survive: not adult by name, and not emptied by the adult filter. */
function keepCategories(all: Cat[], used: ReadonlySet<string>, droppedAdult: ReadonlySet<string>): Cat[] {
  return all.filter((c) => !isAdultCategoryName(c.category_name)
    && (used.has(c.category_id) || !droppedAdult.has(c.category_id)));
}

export async function loadStalkerCatalogue(
  client: StalkerClient,
  opts: { signal?: AbortSignal; onProgress?: (p: StalkerProgress) => void } = {},
): Promise<StalkerLoad> {
  await client.connect();
  const side = emptySide();
  let truncated = false;
  let rows = 0;
  const report = () => opts.onProgress?.({ rows });
  const stop = () => { if (opts.signal?.aborted) throw new Error('Cancelled.'); };

  /* ── live ── */
  const live = await client.liveCatalogue();
  truncated ||= live.truncated;
  const liveOut: unknown[] = [];
  const liveUsed = new Set<string>();
  const liveAdult = new Set<string>();
  for (const r of live.rows) {
    if (r.streamId === null) continue;
    const cat = r.categoryRemoteId ?? '';
    if (r.isAdult || isAdultTitle(r.name)) { if (cat !== '') liveAdult.add(cat); continue; }
    if (liveOut.length >= MAX_LIVE) { truncated = true; break; }
    liveOut.push({
      num: r.number ?? liveOut.length + 1,
      name: r.name,
      stream_id: r.streamId,
      stream_icon: r.logo,
      epg_channel_id: r.tvgId,
      category_id: cat === '' ? null : cat,
      is_adult: 0,
      tv_archive: r.tvArchive ? 1 : 0,
      tv_archive_duration: r.tvArchiveDuration,
      added: null,
    });
    if (cat !== '') liveUsed.add(cat);
    side.stalker[`${Kind.Live}.${r.streamId}`] = { cmd: r.cmd, remoteId: r.remoteId };
  }
  rows += liveOut.length;
  report();
  stop();
  const liveCategories = keepCategories(live.categories.map(toCat), liveUsed, liveAdult)
    /* "All" is a view, not a category. */
    .filter((c) => c.category_id !== '*');

  /* ── films ── */
  const vodOut: unknown[] = [];
  const vodUsed = new Set<string>();
  const vodAdult = new Set<string>();
  let vodCats: Cat[] = [];
  try {
    vodCats = (await client.vodCategories()).map(toCat).filter((c) => c.category_id !== '*');
    for (const c of vodCats) {
      if (isAdultCategoryName(c.category_name)) continue;
      stop();
      if (vodOut.length >= MAX_VOD) { truncated = true; break; }
      const page = await client.vodList(c.category_id);
      truncated ||= page.truncated;
      for (const r of page.rows) {
        if (r.streamId === null) continue;
        if (r.isAdult || isAdultTitle(r.name)) { vodAdult.add(c.category_id); continue; }
        vodOut.push({
          stream_id: r.streamId,
          name: r.name,
          category_id: c.category_id,
          stream_icon: r.logo,
          rating: r.rating,
          year: r.year,
          added: r.added,
          container_extension: null,
          is_adult: 0,
        });
        vodUsed.add(c.category_id);
        side.stalker[`${Kind.Movie}.${r.streamId}`] = { cmd: r.cmd, remoteId: r.remoteId };
      }
      rows = liveOut.length + vodOut.length;
      report();
      await breather();
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Cancelled.') throw err;
    /* A portal with no film module is a live-only portal, not a failure. */
  }

  /* ── series ── */
  const seriesOut: unknown[] = [];
  const seriesUsed = new Set<string>();
  const seriesAdult = new Set<string>();
  let seriesCats: Cat[] = [];
  try {
    seriesCats = (await client.seriesCategories()).map(toCat).filter((c) => c.category_id !== '*');
    for (const c of seriesCats) {
      if (isAdultCategoryName(c.category_name)) continue;
      stop();
      if (seriesOut.length >= MAX_SERIES) { truncated = true; break; }
      const page = await client.seriesList(c.category_id);
      truncated ||= page.truncated;
      for (const r of page.rows) {
        if (r.isAdult || isAdultTitle(r.name)) { seriesAdult.add(c.category_id); continue; }
        seriesOut.push({
          series_id: r.seriesId,
          name: r.name,
          category_id: c.category_id,
          cover: r.cover,
          plot: r.plot,
          genre: r.genre,
          cast: r.cast,
          rating: r.rating,
          releaseDate: r.releaseDate,
          last_modified: r.lastModified,
        });
        seriesUsed.add(c.category_id);
        side.stalker[`${Kind.Episode}.${r.seriesId}`] = { cmd: r.cmd ?? '', remoteId: r.remoteId };
      }
      rows = liveOut.length + vodOut.length + seriesOut.length;
      report();
      await breather();
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Cancelled.') throw err;
  }

  if (liveOut.length + vodOut.length + seriesOut.length === 0) {
    throw new Error('The portal answered, but it has no channels for this MAC address. '
      + 'Check with your provider that it is active.');
  }
  return {
    payloads: {
      live: liveOut,
      vod: vodOut,
      series: seriesOut,
      liveCategories,
      vodCategories: keepCategories(vodCats, vodUsed, vodAdult),
      seriesCategories: keepCategories(seriesCats, seriesUsed, seriesAdult),
    },
    side,
    rows: liveOut.length + vodOut.length + seriesOut.length,
    truncated,
  };
}
