/**
 * An M3U playlist, fetched and turned into a catalogue ON THE DEVICE.
 *
 * This is the path a Provider of kind `m3u` (providers/types.ts) uses. The
 * playlist is the viewer's own: nothing is built in and nothing is fetched from
 * anywhere they did not point the app at.
 *
 * The pipeline reuses what already exists: `parseM3u` streams entries out of a
 * response body and `buildCatalogue` (packages/core-store) produces the columnar
 * store that `localRead` queries. This is the caller between the two. It does
 * not use `classifyEntry`: a playlist is treated as a channel list, see the note
 * at the row construction below.
 *
 * The result is returned as payloads rather than written, so the caller can fold
 * it in with whatever else the device holds. See `installM3uChannels` in
 * lib/localCatalogue.ts.
 */
import { parseM3u, syntheticId, tidyName, tidyGroups } from '@iptv/core-m3u';
import { isAdultCategoryName, isAdultTitle } from '@iptv/core-xtream';
import type { RawPayloads } from '@iptv/core-store';
import { breather } from './breather.ts';
import { emptySide, type SideMap } from './playSide.ts';

/** A hard cap, so one careless playlist cannot fill a phone. */
const MAX_ENTRIES = 40_000;

/**
 * Adult entries never enter the catalogue.
 *
 * The same detector the store applies at ingest (`@iptv/core-xtream`), run here
 * as well so an adult entry is not even kept in the payload: by group, by a
 * channel name that reads like an adult category, or by an adult title tag.
 */
function isAdultEntry(group: string, name: string): boolean {
  return isAdultCategoryName(group) || isAdultCategoryName(name) || isAdultTitle(name);
}

/** The lines of a response body, without buffering the whole thing first. */
async function* lines(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    for (const line of (await res.text()).split('\n')) yield line;
    return;
  }
  const decoder = new TextDecoder();
  let held = '';
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      // eslint-disable-next-line no-await-in-loop
      chunk = await reader.read();
    } catch (err) {
      /*
       * A body that was ABANDONED is the end of the lines, not a failure.
       *
       *     page: unhandled rejection: AbortError: BodyStreamBuffer was aborted
       *
       * A download still being read when the page navigates, or when whatever
       * asked for it gave up, rejects this `read()`. Nothing awaits this
       * generator's rejection by then — that is what "abandoned" means — so it
       * surfaced as an unhandled rejection in a viewer's log.
       *
       * Only an abort. Any other failure is a genuinely truncated catalogue and
       * must keep travelling, because silently yielding half a channel list is
       * the worse bug and the harder one to see.
       */
      if ((err as { name?: unknown })?.name !== 'AbortError') throw err;
      return;
    }
    const { done, value } = chunk;
    if (done) break;
    held += decoder.decode(value, { stream: true });
    const parts = held.split('\n');
    held = parts.pop() ?? '';
    for (const p of parts) yield p;
  }
  if (held !== '') yield held;
}

export interface M3uProgress {
  entries: number;
  bytes: number;
}

export interface M3uLoadOptions {
  /** An XMLTV feed for this playlist; returned as given for the guide to join on `tvg-id`. */
  epgUrl?: string;
  signal?: AbortSignal;
  onProgress?: (p: M3uProgress) => void;
}

export interface M3uLoad {
  payloads: RawPayloads;
  entries: number;
  epgUrl: string | null;
  /** The guide addresses the playlist's own header named (`url-tvg` / `x-tvg-url`). */
  headerGuideUrls: string[];
  /** Request headers the playlist asked for (`#EXTVLCOPT`, `#EXTHTTP`, `url|Header=value`), by stream id. */
  side: SideMap;
}

/**
 * Fetch one playlist and fold it into ONE set of payloads.
 *
 * Deduplicated on the stream URL: two entries pointing at one stream are one
 * channel, whatever they are called. Throws when the playlist cannot be fetched,
 * so the caller can say so rather than install an empty library.
 */
export async function loadM3uCatalogue(url: string, opts: M3uLoadOptions = {}): Promise<M3uLoad> {
  const res = await fetch(url, opts.signal === undefined ? {} : { signal: opts.signal });
  if (!res.ok) throw new Error(`The playlist answered ${res.status}.`);
  const headerGuideUrls: string[] = [];

  const live: unknown[] = [];
  const liveCategories = new Map<string, unknown>();
  const seen = new Set<string>();
  const side = emptySide();
  let bytes = 0;
  let entries = 0;

  for await (const item of parseM3u(lines(res))) {
    if ('header' in item) {
      for (const g of item.header.epgUrls) if (/^https?:\/\//i.test(g) && !headerGuideUrls.includes(g)) headerGuideUrls.push(g);
      continue;
    }
    if (typeof item.url !== 'string') continue;
    const entry = item;
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);

    /*
     * A playlist is a channel list, so everything in it is a channel.
     *
     * `classifyEntry` is right for a provider playlist that mixes live, films and
     * episodes and asks the URL first; on a plain channel list both of its
     * fallbacks misfire (a live channel served as a file reads as a film). So
     * `vod`/`series` stay in the payload as the empty arrays the store expects.
     */
    /* The name a viewer sees, not the one the file carries: playlists put the
       machinery in the title (`A1 TV (1080p) [Not 24/7]`). Stripped once, here,
       so every list, search result and rail is clean. The original is kept on the
       row. See packages/core-m3u/src/tidy.ts. */
    const tidy = tidyName(entry.name);
    const groups = tidyGroups(entry.groups.join(';'));
    const cat = groups[0] ?? 'General';
    if (isAdultEntry(cat, entry.name)) continue;
    /* Identity stays on the RAW name: two feeds of one channel are two streams
       and must not collapse into one id, or the second overwrites the first. */
    const id = syntheticId(entry.name, entry.url);
    bytes += entry.url.length + entry.name.length;
    /* What the playlist said the stream wants sent with it. Kept beside the
       catalogue, not in it: most rows have none. */
    if (Object.keys(entry.headers).length > 0) side.headers[String(id)] = { ...entry.headers };

    live.push({
      /* `direct_source` is what makes a playlist entry playable at all: there are
         no credentials to build a URL from, so the URL IS the item. */
      num: entries + 1,
      name: tidy.quality === null ? tidy.name : `${tidy.name} ${tidy.quality}`,
      stream_id: id,
      stream_icon: entry.tvgLogo ?? null,
      epg_channel_id: entry.tvgId ?? null,
      category_id: `m3u:${cat}`,
      direct_source: entry.url,
      is_adult: 0,
      /* Catch-up is built from a panel's own URL shape (`lib/localArchive.ts`);
         a playlist's `catchup-source` template has no player behind it yet, so
         offering "play from the start" here would only fail. */
      tv_archive: 0,
      tv_archive_duration: 0,
      added: null,
    });
    /* Namespaced, so these ids cannot collide with a panel's own numeric ones. */
    liveCategories.set(cat, { category_id: `m3u:${cat}`, category_name: cat, parent_id: 0 });

    entries += 1;
    if (entries % 250 === 0) opts.onProgress?.({ entries, bytes });
    /* A 40,000-entry list is a long loop; hand the thread back so a remote press
       is not queued behind it. */
    if (entries % 2000 === 0) await breather();
    if (entries >= MAX_ENTRIES) break;
  }
  opts.onProgress?.({ entries, bytes });
  if (entries === 0) {
    throw new Error('No channels were found at that link. Check that it is a playlist (.m3u or .m3u8).');
  }

  return {
    payloads: {
      live,
      vod: [],
      series: [],
      liveCategories: [...liveCategories.values()],
      vodCategories: [],
      seriesCategories: [],
    },
    entries,
    epgUrl: opts.epgUrl ?? null,
    headerGuideUrls,
    side,
  };
}

/**
 * A single stream link as a one-channel library.
 *
 * Same payload shape as a playlist, so it is stored, rebuilt and switched like
 * one and nothing downstream needs to know the difference.
 */
export function streamPayloads(url: string, name: string): RawPayloads {
  const label = name.trim() === '' ? 'Stream' : name.trim();
  const cat = 'Stream';
  return {
    live: [{
      num: 1,
      name: label,
      stream_id: syntheticId(label, url),
      stream_icon: null,
      epg_channel_id: null,
      category_id: `m3u:${cat}`,
      direct_source: url,
      is_adult: 0,
      tv_archive: 0,
      tv_archive_duration: 0,
      added: null,
    }],
    vod: [],
    series: [],
    liveCategories: [{ category_id: `m3u:${cat}`, category_name: cat, parent_id: 0 }],
    vodCategories: [],
    seriesCategories: [],
  };
}
