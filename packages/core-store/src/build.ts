/**
 * Panel JSON in, catalogue out.
 *
 * The same normalisation the server ingest performs, against the same
 * `core-xtream` functions — deliberately, because two different normalisations
 * would mean the device and the server disagree about what a title is called,
 * which genre it has, and which group it belongs to. The facet and path
 * derivations in particular are the app's only source of genres: the panel has no
 * genre field on its list endpoints.
 *
 * Measured on this provider: parsing 58MB of JSON is ~200ms of CPU and building
 * the columns is 14ms, against roughly four seconds of transfer. So this is not
 * where an ingest spends its time, and there is no need to be clever here — only
 * correct.
 */
import {
  Kind, compactName, deriveFacets, derivePath, isAdultCategoryName, isAdultTitle, isFillerName, normName, normaliseCategory,
  normaliseLive, normaliseSeries, normaliseVod, type ItemRow,
} from '@iptv/core-xtream';
import { buildColumns, type Catalogue, type CategoryRow, type ItemDraft } from './columns.ts';

export interface RawPayloads {
  liveCategories: unknown[];
  vodCategories: unknown[];
  seriesCategories: unknown[];
  live: unknown[];
  vod: unknown[];
  series: unknown[];
}

/**
 * Category ids are LOCAL to this build.
 *
 * The panel's `category_id` is a string and is not stable across providers, so
 * the store assigns its own sequential ids and keeps `remoteId` for matching. A
 * hidden-categories list therefore has to survive a rebuild by remote id, not by
 * this number — the same mistake the server made when `prefs.hideCats` stored
 * per-generation row ids.
 */
export function buildCatalogue(
  raw: RawPayloads,
  opts: {
    generation: number;
    now: number;
    /**
     * How many items each category holds UPSTREAM, keyed `<kind>:<provider id>`.
     *
     * For an on-demand library the device holds a package's contents only once
     * somebody opens it — so counting from rows would put a zero beside every
     * package that has not been opened, which is what a viewer saw: a sidebar of
     * two hundred countries all reading 0. These counts come from the catalogue
     * the server already ingested, so the numbers on screen are the real ones and
     * downloading is what changes what is IN a list, not what a list claims.
     */
    counts?: Record<string, number>;
  },
): Catalogue {
  const categories: CategoryRow[] = [];
  const index = new Map<string, number>();
  let nextId = 1;
  /* Categories the name detector (or the `18|` market) marks adult. Every item in
     one is flagged adult below, so the exclusion holds by row as well as by
     category. */
  const adultCategories = new Set<number>();

  const addCategories = (list: unknown[], kind: number) => {
    let sort = 0;
    for (const item of list) {
      const c = normaliseCategory(item);
      if (!c) continue;
      const facets = deriveFacets(c.name);
      const path = derivePath(c.name, kind);
      const id = nextId++;
      categories.push({
        id,
        kind,
        remoteId: c.remoteId,
        name: c.name,
        cleanName: facets.cleanName,
        genres: [...facets.genres],
        region: facets.region,
        source: facets.source,
        path: [...path],
        itemCount: 0,
        sortIndex: sort++,
      });
      index.set(`${kind}:${c.remoteId}`, id);
      if (path[0] === '18' || isAdultCategoryName(c.name)) adultCategories.add(id);
    }
  };
  addCategories(raw.liveCategories, Kind.Live);
  addCategories(raw.vodCategories, Kind.Movie);
  addCategories(raw.seriesCategories, Kind.Episode);

  const drafts: ItemDraft[] = [];
  const push = (row: ItemRow | null, kind: number, sortIndex: number) => {
    if (!row) return;
    /**
     * The provider's non-channels never enter the on-device store.
     *
     * The server has excluded section headings and idle pay-per-view slots since
     * `filler.ts` was written — it marks them `is_filler` at ingest and every
     * count, page, facet and search leaves them out. This store never learned the
     * rule, so a device that held its own catalogue listed all 1,834 of them
     * regardless, which is why they were still on screen after the server was
     * fixed. `localFirst()` prefers this store, so this is the copy people see.
     *
     * Skipped rather than flagged, unlike the server: `showFiller` is a
     * server-side query parameter that nothing in the app sets, so a row that can
     * never be displayed is a row not worth carrying in a typed-array store whose
     * whole point is fitting a 96,821-row catalogue on a television.
     */
    if (isFillerName(row.name)) return;
    const categoryId = row.categoryRemoteId
      ? index.get(`${kind}:${row.categoryRemoteId}`) ?? null
      : null;
    drafts.push({
      kind,
      streamId: row.streamId,
      categoryId,
      name: row.name,
      logo: row.logo,
      // Lowercased here so the search path is a plain `includes` with no
      // per-query normalisation of 124,157 rows.
      compactName: compactName(row.name).toLowerCase(),
      normName: normName(row.name),
      ext: row.ext,
      tvgId: row.tvgId,
      url: row.directSource,
      archive: row.tvArchive,
      archiveDays: row.tvArchiveDuration,
      adult: row.isAdult || isAdultTitle(row.name)
        || (categoryId !== null && adultCategories.has(categoryId)),
      direct: row.directSource !== null,
      rating: row.rating,
      year: row.year,
      added: row.added,
      sortIndex,
    });
  };

  let i = 0;
  for (const item of raw.live) push(normaliseLive(item), Kind.Live, i++);
  i = 0;
  for (const item of raw.vod) push(normaliseVod(item), Kind.Movie, i++);
  i = 0;
  for (const item of raw.series) {
    const s = normaliseSeries(item);
    if (!s) continue;
    /*
     * No filler test for series, deliberately.
     *
     * The rule applies to the live list, where providers inject headings and idle
     * pay-per-view slots. The `series` table has no `is_filler` column and the
     * server therefore never filters it, so testing it here would hide rows the
     * server shows — a drift that reads as a bug in this store. Measured: zero of
     * 20,525 series names match the rule anyway, and if one ever does the answer
     * is a column on `series`, not a silent skip here.
     */
    const seriesCategory = s.categoryRemoteId ? index.get(`3:${s.categoryRemoteId}`) ?? null : null;
    drafts.push({
      kind: Kind.Episode,
      // A series has no stream_id; its identity is series_id, which the read
      // model treats the same way because favourites key on whichever it is.
      streamId: s.seriesId,
      categoryId: seriesCategory,
      name: s.name,
      logo: s.cover,
      compactName: compactName(s.name).toLowerCase(),
      normName: normName(s.name),
      /* The one section with a cast anybody paid nothing for — see
         `SeriesRow.cast` and `ItemColumns.cast`. Films get no equivalent here
         because the panel's film list does not carry one. */
      cast: s.cast,
      ext: null,
      tvgId: null,
      url: null,
      archive: false,
      archiveDays: 0,
      adult: isAdultTitle(s.name) || (seriesCategory !== null && adultCategories.has(seriesCategory)),
      direct: false,
      rating: s.rating,
      year: s.releaseDate,
      added: s.lastModified,
      sortIndex: i++,
    });
  }

  const items = buildColumns(drafts);
  const counts = { live: 0, movies: 0, series: 0 };
  for (let row = 0; row < items.count; row++) {
    const kind = items.kind[row];
    if (kind === Kind.Live) counts.live++;
    else if (kind === Kind.Movie) counts.movies++;
    else if (kind === Kind.Episode) counts.series++;
  }

  // Stored for anything that wants a total without a scan; the read model still
  // recomputes every count it shows.
  for (const c of categories) {
    let n = 0;
    for (let row = 0; row < items.count; row++) if (items.categoryId[row] === c.id) n++;
    /* What is here, or — for a package nobody has downloaded yet — what is there
       to download. Never both: a package with rows counts its rows. */
    c.itemCount = n > 0 ? n : opts.counts?.[`${c.kind}:${c.remoteId}`] ?? 0;
  }

  return { generation: opts.generation, builtAt: opts.now, items, categories, counts };
}
