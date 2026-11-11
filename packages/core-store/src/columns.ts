/**
 * The catalogue, as columns.
 *
 * This layout is not a preference, it is the measured difference between a
 * feature and a non-feature. Storing this provider's 124,157 items in IndexedDB
 * one record per item, then reading them back:
 *
 * | approach                            | write      | substring search |
 * | ----------------------------------- | ---------- | ---------------- |
 * | one IndexedDB record per item       | 124,395 ms | 3,948 ms         |
 * | columns: typed arrays + text blobs  |      55 ms |     2.1 ms       |
 *
 * Two minutes versus a twentieth of a second, for the same data. The reason is
 * per-record overhead: IndexedDB pays structured-clone and index maintenance on
 * every one of 124,157 objects, and pays it once on nine large ones.
 *
 * So an item is not an object here. It is an INDEX into parallel arrays:
 *
 * - numbers live in typed arrays, one element per row;
 * - strings live in one big `\n`-delimited blob per field, with an `Int32Array`
 *   of offsets — reading row 40,000's name is two array reads and a `substring`;
 * - low-cardinality strings (the container extension) live in a dictionary with
 *   a `Uint8Array` of indices;
 * - sparse fields (only 18% of channels carry a `tvg_id`) live in a plain object
 *   keyed by row, because an array of 124,157 mostly-empty slots is waste.
 *
 * The row index IS the id. Nothing else needs to be stored to identify a row.
 */

/** Bit positions in the flags column. */
export const FLAG = {
  archive: 1,
  /** The panel handed us a ready-made URL for this row. */
  direct: 2,
  adult: 4,
} as const;

export interface ItemColumns {
  count: number;
  kind: Uint8Array;
  streamId: Int32Array;
  categoryId: Int32Array;
  /**
   * Rating × 100.
   *
   * Not ×10, which was the first attempt: rounding 7.96 to 80 tenths made it
   * pass a `>= 8` filter the server excluded, and the conformance check counted
   * 74 films on the wrong side of that boundary. Two decimal places put the
   * rounding error at 0.005, which is below any threshold anyone filters on.
   */
  rating: Uint16Array;
  year: Uint16Array;
  flags: Uint8Array;
  archiveDays: Uint8Array;
  /** Provider sort order, which is the catalogue's own default ordering. */
  sortIndex: Int32Array;
  /** Panel `added` timestamp, seconds. 0 when absent. */
  added: Int32Array;
  /** `\n`-delimited blobs plus offsets. See `readText`. */
  names: TextColumn;
  logos: TextColumn;
  /** Punctuation-free lowercase names: this is what search scans. */
  compact: TextColumn;
  /**
   * Normalised name, for the live family collapse.
   *
   * Separate from `compact` because the two do different jobs: `compact` strips
   * everything so a search matches loosely, `norm` strips quality and market
   * noise so that FHD/HD/HEVC feeds of one channel share a key. Collapsing on
   * `compact` would merge channels that merely have similar names.
   */
  norm: TextColumn;
  /**
   * Cast, for the rows that have one. See `CastColumn`.
   *
   * Measured against this provider on 2026-09-07, and the measurement is the
   * whole reason this column exists in the shape it does:
   *
   *   get_vod_streams   211,168 rows, 16 fields, and NOT ONE of them is a cast,
   *                     a genre or a plot. Film cast comes only from
   *                     `get_vod_info`, which is one HTTP request per title.
   *   get_series         45,140 rows, and the BULK list carries `cast`,
   *                     `director`, `genre` and `plot` on every row. 33,636 of
   *                     them (74.5%) have a non-empty cast: 203,540 credits over
   *                     49,438 distinct people, 2.98MB of text.
   *
   * So cast is free for series and unaffordable for films, and this column is
   * exactly that asymmetry made explicit rather than an empty promise across
   * both. A film's cast reaches search only where the panel wrote it into the
   * TITLE — 4,523 films carry a shouted lead actor ("… (1993) LIAM NEESON") —
   * and those are already in `compact`, so they need no column at all.
   */
  cast: CastColumn;
  /** Container extension, dictionary-encoded. */
  extDict: string[];
  ext: Uint8Array;
  /** Sparse: row index -> tvg id. Only ~18% of channels have one. */
  tvgIds: Record<number, string>;
  /** Sparse: row index -> provider-supplied URL. Only playlists and third parties. */
  urls: Record<number, string>;
}

export interface TextColumn {
  /** Every value, joined by `\n`. Never contains a raw newline in a value. */
  blob: string;
  /** `offsets[i]` is where row i starts; `offsets[i+1] - 1` is where it ends. */
  offsets: Int32Array;
}

/**
 * Cast names, for the minority of rows that have any.
 *
 * NOT one entry per catalogue row. 33,636 of 266,141 rows carry a cast (12.6%),
 * and a row-aligned `TextColumn` would spend 1.06MB of `Int32Array` offsets
 * describing 232,505 empty strings. This is the sparse shape `tvgIds` uses,
 * expressed as columns rather than as an object: an ascending `rows` array plus
 * a `TextColumn` indexed by ENTRY, which is 269KB of typed array against the
 * 2.9MB of text it describes. A plain `Record<number, string>` was the other
 * candidate and loses on both counts — 33,636 V8 property slots cost more than
 * one Int32Array, and it cannot be scanned as one blob, which is the thing the
 * search engine actually does with it (see `search.ts`).
 *
 * The text is FOLDED, not raw: lowercase, accents stripped, everything that is
 * not a letter or a digit collapsed to a single space — "Jennifer Aniston,
 * Courteney Cox" is stored as "jennifer aniston courteney cox". Folding at build
 * time is what keeps a keystroke's cost to `indexOf` over a blob; folding 33,636
 * rows per query is not affordable on a television. The space separator matters:
 * it stops "…aniston" and "courteney…" from running together into a substring
 * that matches "anistoncourteney", and it gives the ranker word boundaries for
 * free.
 */
export interface CastColumn {
  /** Catalogue rows that have a cast, ASCENDING — `entryOfRow` binary-searches it. */
  rows: Int32Array;
  /** One folded cast line per entry in `rows`, same order. */
  text: TextColumn;
}

export const EMPTY_CAST: CastColumn = {
  rows: new Int32Array(0),
  text: { blob: '', offsets: new Int32Array(1) },
};

/**
 * Fold a name the way `CastColumn` stores it, and the way a query is folded.
 *
 * Deliberately NOT `compactName`: that strips spaces too, which is right for the
 * `compact` column (so "grey's anatomy" matches "greysanatomy") and wrong here,
 * because a cast list needs its word boundaries to stay a list of people rather
 * than becoming one 2.9MB word.
 */
export function foldText(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Which entry holds this row's cast, or -1.
 *
 * Binary search rather than a `Map`: the map would be a second copy of the same
 * 33,636 numbers in a form structured clone has to walk on every load, and a
 * search never asks this question more than once per candidate row.
 */
export function entryOfRow(col: CastColumn, row: number): number {
  let lo = 0;
  let hi = col.rows.length - 1;
  /* An ascending array answers "outside my range" in one comparison, and that is
     the answer for almost every row: only series carry a cast, and the builder
     appends series last, so every live channel and every film is below `rows[0]`.
     Without this the search engine pays a fifteen-step binary search per
     candidate row to be told no — 300,000 steps on a two-letter query. */
  if (hi < 0 || row < col.rows[0]! || row > col.rows[hi]!) return -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = col.rows[mid]!;
    if (at === row) return mid;
    if (at < row) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** This row's folded cast line, or '' when the panel gave none. */
export function castText(col: CastColumn, row: number): string {
  const at = entryOfRow(col, row);
  return at < 0 ? '' : readText(col.text, at);
}

/** Read one value out of a text column. Two array reads and a substring. */
export function readText(col: TextColumn, row: number): string {
  const start = col.offsets[row];
  const end = col.offsets[row + 1];
  if (start === undefined || end === undefined) return '';
  // -1 drops the delimiter that follows every value including the last.
  return col.blob.slice(start, Math.max(start, end - 1));
}

/**
 * Build a text column.
 *
 * Newlines inside a value would corrupt every offset after it, so they are
 * replaced rather than escaped — a channel name containing a line break is a
 * provider bug, and silently flattening it is better than either throwing away
 * the row or shifting the whole column.
 */
export function buildText(values: readonly string[]): TextColumn {
  const offsets = new Int32Array(values.length + 1);
  let total = 0;
  const parts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const clean = values[i]!.includes('\n') ? values[i]!.replace(/[\r\n]+/g, ' ') : values[i]!;
    offsets[i] = total;
    parts.push(clean, '\n');
    total += clean.length + 1;
  }
  offsets[values.length] = total;
  return { blob: parts.join(''), offsets };
}

export interface CategoryRow {
  id: number;
  kind: number;
  remoteId: string;
  name: string;
  cleanName: string;
  genres: string[];
  region: string | null;
  source: string | null;
  /** Market / package / group, derived from the name at ingest. */
  path: string[];
  itemCount: number;
  sortIndex: number;
}

/**
 * The whole catalogue for one generation.
 *
 * Categories stay as objects: there are 1,040 of them against 124,157 items, so
 * the per-record cost that makes columns necessary for items is irrelevant here,
 * and objects keep the code that reads them obvious.
 */
export interface Catalogue {
  generation: number;
  builtAt: number;
  items: ItemColumns;
  categories: CategoryRow[];
  /** Provider ids per section, for favourite resolution without a scan. */
  counts: { live: number; movies: number; series: number };
}

export interface ItemDraft {
  kind: number;
  streamId: number | null;
  categoryId: number | null;
  name: string;
  logo: string | null;
  compactName: string;
  normName: string;
  /**
   * The panel's raw `cast` string, comma-separated, or null.
   *
   * Optional because almost nothing has one: `get_vod_streams` carries no cast
   * field at all and an M3U playlist has no such concept, so requiring it here
   * would make every other builder write `cast: null` to say nothing. Only
   * `get_series` populates it — see `ItemColumns.cast`.
   */
  cast?: string | null;
  ext: string | null;
  tvgId: string | null;
  url: string | null;
  archive: boolean;
  archiveDays: number;
  adult: boolean;
  direct: boolean;
  rating: number | null;
  year: string | null;
  added: number | null;
  sortIndex: number;
}

/**
 * Turn drafts into columns.
 *
 * One pass, pre-sized arrays. Measured at 14ms for this provider's 124,157 rows,
 * which is why the ingest is a download progress bar rather than a CPU one.
 */
export function buildColumns(drafts: readonly ItemDraft[]): ItemColumns {
  const n = drafts.length;
  const cols: ItemColumns = {
    count: n,
    kind: new Uint8Array(n),
    streamId: new Int32Array(n),
    categoryId: new Int32Array(n),
    rating: new Uint16Array(n),
    year: new Uint16Array(n),
    flags: new Uint8Array(n),
    archiveDays: new Uint8Array(n),
    sortIndex: new Int32Array(n),
    added: new Int32Array(n),
    names: { blob: '', offsets: new Int32Array(1) },
    logos: { blob: '', offsets: new Int32Array(1) },
    compact: { blob: '', offsets: new Int32Array(1) },
    norm: { blob: '', offsets: new Int32Array(1) },
    cast: EMPTY_CAST,
    extDict: [],
    ext: new Uint8Array(n),
    tvgIds: {},
    urls: {},
  };

  const names: string[] = new Array(n);
  const logos: string[] = new Array(n);
  const compact: string[] = new Array(n);
  const norm: string[] = new Array(n);
  /* Two parallel arrays rather than one array of pairs: they become the two
     halves of a `CastColumn` verbatim, with no second pass to split them. */
  const castRows: number[] = [];
  const castText: string[] = [];
  const extIndex = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const d = drafts[i]!;
    cols.kind[i] = d.kind;
    cols.streamId[i] = d.streamId ?? 0;
    cols.categoryId[i] = d.categoryId ?? 0;
    // Ratings above 10 exist in the wild; clamp rather than overflow the column.
    /* FLOOR, not round. The panel's rating is a float4, so a nominal 8.0 can be
       stored as 7.9999995 and `>= 8` excludes it on the server; rounding up put
       fourteen such films on the wrong side of a `minRating` filter. Flooring
       matches the server's comparison and costs a hundredth of a star. */
    cols.rating[i] = d.rating === null ? 0 : Math.min(65_535, Math.floor(d.rating * 100));
    const year = d.year === null ? 0 : Number.parseInt(d.year.slice(0, 4), 10);
    cols.year[i] = Number.isFinite(year) && year > 0 && year < 65_535 ? year : 0;
    cols.flags[i] = (d.archive ? FLAG.archive : 0) | (d.direct ? FLAG.direct : 0)
      | (d.adult ? FLAG.adult : 0);
    cols.archiveDays[i] = Math.min(255, Math.max(0, d.archiveDays));
    cols.sortIndex[i] = d.sortIndex;
    cols.added[i] = d.added ?? 0;
    names[i] = d.name;
    logos[i] = d.logo ?? '';
    compact[i] = d.compactName;
    norm[i] = d.normName;
    if (d.cast != null && d.cast !== '') {
      const folded = foldText(d.cast);
      /* A cast of pure punctuation folds to nothing, and an entry holding ''
         would cost eight bytes of typed array to say what its absence already
         says. `i` ascends, so `castRows` comes out sorted for `entryOfRow`. */
      if (folded !== '') {
        castRows.push(i);
        castText.push(folded);
      }
    }
    if (d.ext !== null && d.ext !== '') {
      let at = extIndex.get(d.ext);
      if (at === undefined) {
        // 0 is reserved for "no extension", so the dictionary starts at 1.
        at = cols.extDict.push(d.ext);
        extIndex.set(d.ext, at);
      }
      cols.ext[i] = Math.min(255, at);
    }
    if (d.tvgId !== null && d.tvgId !== '') cols.tvgIds[i] = d.tvgId;
    if (d.url !== null && d.url !== '') cols.urls[i] = d.url;
  }

  cols.names = buildText(names);
  cols.logos = buildText(logos);
  cols.compact = buildText(compact);
  cols.norm = buildText(norm);
  cols.cast = castRows.length === 0
    ? EMPTY_CAST
    : { rows: Int32Array.from(castRows), text: buildText(castText) };
  return cols;
}

export interface ItemView {
  /** The row index. This IS the id. */
  id: number;
  kind: number;
  streamId: number | null;
  categoryId: number | null;
  name: string;
  logo: string | null;
  ext: string | null;
  tvgId: string | null;
  url: string | null;
  archive: boolean;
  archiveDays: number;
  adult: boolean;
  direct: boolean;
  rating: number | null;
  year: string | null;
}

/** Materialise one row. Called for a page of results, never for the catalogue. */
export function viewItem(cols: ItemColumns, row: number): ItemView {
  const flags = cols.flags[row] ?? 0;
  const extAt = cols.ext[row] ?? 0;
  const rating = cols.rating[row] ?? 0;
  const year = cols.year[row] ?? 0;
  const streamId = cols.streamId[row] ?? 0;
  const categoryId = cols.categoryId[row] ?? 0;
  const logo = readText(cols.logos, row);
  return {
    id: row,
    kind: cols.kind[row] ?? 0,
    streamId: streamId === 0 ? null : streamId,
    categoryId: categoryId === 0 ? null : categoryId,
    name: readText(cols.names, row),
    logo: logo === '' ? null : logo,
    ext: extAt === 0 ? null : cols.extDict[extAt - 1] ?? null,
    tvgId: cols.tvgIds[row] ?? null,
    url: cols.urls[row] ?? null,
    archive: (flags & FLAG.archive) !== 0,
    archiveDays: cols.archiveDays[row] ?? 0,
    adult: (flags & FLAG.adult) !== 0,
    direct: (flags & FLAG.direct) !== 0,
    rating: rating === 0 ? null : rating / 100,
    year: year === 0 ? null : String(year),
  };
}
