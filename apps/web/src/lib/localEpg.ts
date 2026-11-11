/**
 * The guide, on the device.
 *
 * The server used to own this entirely: an `epg_programme` table, an `epg_fetch`
 * table, a six-hour freshness rule and a process-wide queue that let two requests
 * run at a time 250ms apart. That queue was not politeness — a client asking the
 * panel per channel gets the household's IP flood-blocked, and the queue was the
 * one thing standing between a scrolled guide and a blocked account.
 *
 * All of it has to exist here now, and one part of it has to be BETTER. The
 * server's queue served every viewer at once, so no single person's press was
 * distinguishable and FIFO was fine. On a device every request either has someone
 * looking at it or does not, and 200 channels at 250ms puts a channel press fifty
 * seconds behind work nobody asked for. That is what `providers/scheduler.ts` is
 * for; this file is what it schedules.
 *
 * ── what is stored, and why it is capped ──
 *
 * One record per channel plus one index record, in the catalogue's own IndexedDB
 * store. The index is the on-device `epg_fetch`, and it exists for the identical
 * reason: "have we asked about this channel recently" is a question about the
 * CHANNEL, and a table of programmes cannot answer it once a channel legitimately
 * has none. One record also means a 200-row guide answers `known` in one read
 * rather than two hundred.
 *
 * A channel's listings are ~248 rows, about 30KB. Four hundred channels is 12MB
 * against a catalogue of 9-12MB — and `navigator.storage.persist()` was DENIED in
 * testing, so exceeding the quota does not evict the guide, it evicts the ORIGIN.
 * The cap is therefore not tidiness: an uncapped guide store takes the catalogue
 * with it. When something has to go, it is always this.
 */
import {
  channelKey, closeGaps, isFresh, nowNext, windowOf,
  type Coverage, type Slot,
} from '@iptv/core-store';
import { Kind, normaliseEpg, type EpgEntry } from '@iptv/core-xtream';
import { StalkerError } from '@iptv/core-stalker';
import { stalkerRefFor } from './playSide.ts';
import { stalkerActive, withStalker } from './providers/index.ts';
import { kv } from './kv.ts';
import { blobs } from './localCatalogue.ts';
import { panelClient } from './providers/panel.ts';
import { scheduler, type Band } from './providers/scheduler.ts';
import { clearBulkGuide } from './bulkGuide.ts';

/**
 * The cache is versioned, and this is why.
 *
 * Listings are stored as they were parsed, so a parsing bug is stored too. The
 * EPG titles arrive Base64-encoded and were being written to this cache still
 * encoded — `Buffer` does not exist in a browser, so `decodeMaybeBase64` fell
 * back to the raw string (see `coerce.ts`). Fixing the decode does not fix a
 * single row already on disk, and the freshness rule deliberately keeps them for
 * hours: the guide would have carried on showing "R2VlbiB1aXR6ZW5kaW5n" on a
 * build that knows perfectly well how to read it.
 *
 * So the prefix moves with the format. Bump it whenever what is WRITTEN here
 * changes meaning, and the old namespace is swept once on the next launch —
 * leaving it would be several megabytes of unreachable rows against a quota that
 * evicts the catalogue when it runs out.
 */
const CACHE_VERSION = 2;
const INDEX_KEY = `epg.v${CACHE_VERSION}.index`;
const chanKey = (streamId: number) => `epg.v${CACHE_VERSION}.ch.${streamId}`;
/** Everything this file has ever written under an older shape. */
const STALE_PREFIXES = ['epg.index', 'epg.ch.'];

let swept: Promise<void> | null = null;
/** Once per launch, and never on the path of a read. */
function sweepStale(): Promise<void> {
  swept ??= (async () => {
    try {
      const store = blobs();
      const keys = await store.keys();
      await Promise.all(
        keys.filter((k) => STALE_PREFIXES.some((p) => k === p || k.startsWith(p)))
          .map((k) => store.delete(k)),
      );
    } catch {
      /* A sweep that cannot run costs disk, not correctness: the new prefix is
         already what every read and write below uses. */
    }
  })();
  return swept;
}

/**
 * How many channels' listings to keep.
 *
 * 400 × ~30KB ≈ 12MB, chosen against a catalogue that is 9-12MB and a quota that
 * is not guaranteed at all. A guide is regenerable in one request per channel;
 * the catalogue is a 58MB download.
 */
const MAX_CHANNELS = 400;

/**
 * How long to wait for a channel that is being fetched right now.
 *
 * The same 2.5s the server used, and for the same reason: past this, whatever is
 * cached is a better answer than a spinner. The request is not cancelled — it
 * lands in the store and the next read gets it.
 */
const WAIT_MS = 2_500;

interface Entry extends Coverage { streamId: number; lastReadAt: number }
type Index = Record<string, Entry>;

/**
 * Every entry that recorded something, keeping none that recorded nothing.
 *
 * Pure and total — no storage, no clock — so `clearEmptyAsksOnce` below can
 * call it and a test can assert its output directly, without a `blobs()` or
 * `kv` mock. "Recorded nothing" means `listings === 0`, which is exactly what
 * `store()` writes from `fetchChannel`'s catch block: the ask happened, the
 * answer was empty. Never touches an entry with `listings > 0`.
 */
export function withoutEmptyAsks(idx: Index): Index {
  const out: Index = {};
  for (const [key, entry] of Object.entries(idx)) {
    if (entry.listings === 0) continue;
    out[key] = entry;
  }
  return out;
}

let index: Index | null = null;

/**
 * A one-time purge of empty-ask coverage entries, run the first time this
 * build reads the index.
 *
 * `fetchChannel`'s catch block stores `listings: 0` for a channel it could
 * not get a guide for, and `isFresh` (core-store) then leaves a channel with
 * such a record alone for `FRESH_S` (6h) — deliberately, so a channel that
 * genuinely has no guide is not re-asked on every press. The CORS fallback
 * documented on `fetchChannel` means a channel that used to fail with a
 * CORS-shaped error can often get a real guide now, via `get_short_epg` — but
 * every device that hit that failure on a build BEFORE the fallback existed
 * already stored the zero-listing record, and `isFresh` cannot tell "genuinely
 * nothing" apart from "asked before the fallback could help". Left alone,
 * those channels would sit fresh-with-nothing for up to six hours after the
 * very update that fixes them — measured on the built site as a guide page
 * making zero EPG requests and showing no programmes, where a fresh profile
 * shows them.
 *
 * So: once per device, drop every entry `withoutEmptyAsks` would drop, and
 * the per-channel record that goes with it — `store()` writes one even for an
 * empty `slots` array, so leaving it behind would let a stale empty array
 * keep answering `storedSlots` after its coverage entry is gone, which is
 * exactly the index/per-channel-record split going out of sync. Dropping the
 * entry is ALL this does — it makes the channel un-fresh again, nothing more.
 * No fetch happens here; the existing scheduler asks for the channel the next
 * time something visible wants it, same as any other cache miss.
 *
 * Guarded by its own kv flag rather than "the index still has zero-listing
 * entries": a channel that legitimately still has nothing after this runs
 * once must not be re-purged — and so re-un-freshed — on every later launch.
 */
const EMPTY_ASKS_CLEARED_KEY = 'iptv.epg.emptyAsksCleared.v1';

async function clearEmptyAsksOnce(): Promise<void> {
  if (index === null || kv.get(EMPTY_ASKS_CLEARED_KEY) === '1') return;
  kv.set(EMPTY_ASKS_CLEARED_KEY, '1');
  const idx = index;
  const keys = Object.keys(idx);
  const kept = withoutEmptyAsks(idx);
  if (keys.length === Object.keys(kept).length) return; // nothing to drop
  for (const k of keys) {
    if (k in kept) continue;
    delete idx[k];
    try { await blobs().delete(chanKey(Number(k))); } catch { /* already gone */ }
  }
  await writeIndex();
}

async function readIndex(): Promise<Index> {
  if (index !== null) return index;
  /* The first read of the launch is where the old namespace goes. Awaited so a
     sweep can never race a write into the keys it is deleting. */
  await sweepStale();
  let loaded: Index;
  try {
    const raw = await blobs().get(INDEX_KEY);
    loaded = raw !== null && typeof raw === 'object' ? raw as Index : {};
  } catch { loaded = {}; }
  index = loaded;
  /* Same one-shot shape as the sweep above, and awaited for the same reason:
     so nothing downstream of this call can read a stale empty-ask entry. */
  await clearEmptyAsksOnce();
  return loaded;
}

async function writeIndex(): Promise<void> {
  if (index === null) return;
  try { await blobs().put(INDEX_KEY, index); } catch { /* no storage; memory only */ }
}

/** Drop the least recently READ channels until the cap is met. */
async function sweep(): Promise<void> {
  const idx = await readIndex();
  const keys = Object.keys(idx);
  if (keys.length <= MAX_CHANNELS) return;
  const oldest = keys
    .sort((a, b) => (idx[a]!.lastReadAt) - (idx[b]!.lastReadAt))
    .slice(0, keys.length - MAX_CHANNELS);
  for (const k of oldest) {
    delete idx[k];
    try { await blobs().delete(chanKey(Number(k))); } catch { /* already gone */ }
  }
  await writeIndex();
}

export async function storedSlots(streamId: number): Promise<Slot[] | null> {
  try {
    const raw = await blobs().get(chanKey(streamId));
    if (raw === null || raw === undefined || !Array.isArray(raw)) return null;
    const idx = await readIndex();
    const entry = idx[String(streamId)];
    if (entry !== undefined) { entry.lastReadAt = Date.now(); void writeIndex(); }
    return raw as Slot[];
  } catch { return null; }
}

/**
 * Every cached channel's listings, for something that wants to look at all of
 * them at once — programme search, in particular.
 *
 * Deliberately not a loop of `storedSlots`: that function counts each call as a
 * READ for the eviction sweep's LRU clock (`entry.lastReadAt = Date.now()`), and
 * a search that scans all 400 cached channels once per visit must not look like
 * 400 separate people asking for their guide — the sweep would then keep whatever
 * the search touched last and evict the channels somebody actually watches. This
 * reads the identical bytes and writes nothing at all, index included.
 *
 * Read in batches rather than one `Promise.all` over the whole index: 400
 * concurrent IndexedDB transactions opened at once is not friendlier than 400
 * sequential ones, and a batch boundary is a place to hand the thread back.
 */
const CACHED_GUIDES_BATCH = 40;

export async function cachedGuides(): Promise<{ streamId: number; slots: Slot[] }[]> {
  const idx = await readIndex();
  const ids = Object.values(idx)
    .filter((e) => e.listings > 0)
    .map((e) => e.streamId);
  const out: { streamId: number; slots: Slot[] }[] = [];
  for (let at = 0; at < ids.length; at += CACHED_GUIDES_BATCH) {
    const batch = ids.slice(at, at + CACHED_GUIDES_BATCH);
    const read = await Promise.all(batch.map(async (streamId) => {
      try {
        const raw = await blobs().get(chanKey(streamId));
        return raw !== null && raw !== undefined && Array.isArray(raw)
          ? { streamId, slots: raw as Slot[] } : null;
      } catch { return null; }
    }));
    for (const r of read) if (r !== null) out.push(r);
  }
  return out;
}

async function store(streamId: number, slots: Slot[]): Promise<void> {
  const idx = await readIndex();
  const until = slots.length === 0 ? null
    : Math.max(...slots.map((s) => s.stopTs ?? s.startTs + 3600));
  idx[String(streamId)] = {
    streamId, listings: slots.length, until,
    fetchedAt: Math.floor(Date.now() / 1000), lastReadAt: Date.now(),
  };
  try {
    await blobs().put(chanKey(streamId), slots);
  } catch {
    /* Out of quota. Halve the store and try once more; if it still refuses, the
       guide runs from memory for this session and the catalogue survives, which
       is the trade this cap exists to make. */
    const keys = Object.keys(idx);
    for (const k of keys.slice(0, Math.floor(keys.length / 2))) {
      delete idx[k];
      try { await blobs().delete(chanKey(Number(k))); } catch { /* gone */ }
    }
    try { await blobs().put(chanKey(streamId), slots); } catch { /* memory only */ }
  }
  await writeIndex();
  await sweep();
}

/**
 * How many CORS-shaped full-table failures, on one host, before every later
 * channel on that host skips straight to `get_short_epg`.
 *
 * Not one: `fetchJson` (core-xtream) already retries a raw network error up
 * to `maxRetries` times (four attempts, backoff to 4s) before it ever
 * reaches here, so a single failure has already cost five requests and
 * several seconds — too expensive a sample to act on from one draw. Two, on
 * the SAME host, is where it stops being a fluke: the measured failure is
 * deterministic (every `get_simple_data_table` request against the
 * misconfigured door fails, not some of them — see `corsFailuresByHost`
 * below), so a second failure confirms the first rather than merely
 * repeating it. Once tripped, every later channel saves the FULL five-
 * attempt penalty, not just one request — which is most of what "don't
 * double the request count" is actually worth here.
 */
const CORS_TRIP_AFTER = 2;

/**
 * CORS-shaped `get_simple_data_table` failures, per host, for this SESSION
 * only — a plain Map, never persisted.
 *
 * Measured against one provider's door, `panel.example.com` (behind a CDN): `get_simple_data_table` answers 200 `application/json` with
 * `Access-Control-Allow-Origin: https://localhost` NO MATTER WHAT ORIGIN
 * ASKED — a cache-busting param changes nothing, it is the origin server —
 * while `get_short_epg` and `get_live_categories` on the IDENTICAL door
 * correctly echo the request's own Origin. A browser therefore gets
 * `net::ERR_FAILED` on every listing request (13 of 13 on `/guide` in a real
 * run), while the APK's WebView — origin `https://localhost` — is
 * unaffected, which is exactly why this is keyed on the DOOR and not the
 * subscription: it is one endpoint's server-side misconfiguration on that
 * host, most likely reflecting whichever origin last asked, not the account
 * being blocked.
 *
 * Session-only on purpose: a reload is a fair reason to give a host another
 * chance, and a provider that switches doors (`adoptStreamBase`) must not
 * carry a dead door's verdict onto a working one.
 */
const corsFailuresByHost = new Map<string, number>();

/*
 * …and remembered for a few hours once tripped, after all.
 *
 * Session-only meant a website visitor paid the two refused requests again on
 * every page LOAD — photographed as the same `get_simple_data_table` CORS error
 * twice on /live, twice on /sports, twice on /movies, twice on /series and twice
 * on /discover. Six hours keeps the retry the note above wants (a provider that
 * fixes the header is believed by this evening) without a pair of red lines per
 * page in the meantime.
 */
const CORS_REMEMBER_KEY = 'iptv.epg.corsBlocked';
const CORS_REMEMBER_MS = 6 * 3_600_000;
function rememberedCors(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(kv.get(CORS_REMEMBER_KEY) ?? '{}');
    return v !== null && typeof v === 'object' ? v as Record<string, number> : {};
  } catch { return {}; }
}

/** Exported for the test that owns the "after two" rule — see localEpg.test.ts. */
export function hostIsCorsBlocked(host: string, now = Date.now()): boolean {
  if ((corsFailuresByHost.get(host) ?? 0) >= CORS_TRIP_AFTER) return true;
  return (rememberedCors()[host] ?? 0) > now;
}

export function noteCorsFailure(host: string, now = Date.now()): void {
  const n = (corsFailuresByHost.get(host) ?? 0) + 1;
  corsFailuresByHost.set(host, n);
  if (n !== CORS_TRIP_AFTER) return;
  const held = rememberedCors();
  for (const [h, until] of Object.entries(held)) if (until <= now) delete held[h];
  held[host] = now + CORS_REMEMBER_MS;
  try { kv.set(CORS_REMEMBER_KEY, JSON.stringify(held)); } catch { /* private mode */ }
}

/**
 * Doors that cannot answer for a guide AT ALL, and are therefore not asked.
 *
 * ── the bug this exists for ──
 *
 * A tester's television, reported as "List loading slower", "it keep loading
 * forever" and "it also gives milions of errors" with a DEBUG badge reading
 * 465. The log, sent from the box, was one line repeated:
 *
 *     fetch: TypeError: Failed to fetch panel.example.com/player_api.php
 *            ?…&action=get_short_epg&stream_id=1906058&limit=40 (35ms)
 *
 * Measured against that door from here, with the live line, on 2026-09-24:
 * `get_short_epg` answers **404 from nginx** and `get_simple_data_table`
 * answers **520**, on HTTP and HTTPS alike — and neither carries an
 * `access-control-allow-origin`, so in a WebView neither is a status at all.
 * They are opaque rejections, and `isCorsShapedFailure` is the only thing that
 * can see them.
 *
 * That door authenticates perfectly well, which is why it is the panel host:
 * it serves the catalogue and it serves streams. It simply does not implement
 * the guide.
 *
 * ── why it was catastrophic rather than merely empty ──
 *
 * The CORS memo above demotes `get_simple_data_table` to `get_short_epg` once,
 * for the session. Nothing demoted `get_short_epg`, because it WAS the
 * fallback — so every channel scrolled into view asked a door that would never
 * answer, and `fetchJson` retries a `TypeError` five times with 500/1000/2000/
 * 4000ms of backoff (`core-xtream/src/client.ts:230`). Seven and a half
 * seconds and five requests per channel, dozens of channels to a screen.
 *
 * The account noticed before the viewer did. Flood protection is account-wide
 * (gotcha: 456 and friends), and the second device in the same log was failing
 * films with "the panel answered HTTP 429 for this title", 130 times. So the
 * guide's retry storm was spending the subscription's goodwill and taking
 * PLAYBACK down with it — which is the loop behind all three of "slower",
 * "forever" and "millions of errors" at once.
 *
 * ── the rule ──
 *
 * Both EPG actions failing opaquely, `EPG_GIVE_UP` channels in a row, means
 * this door has no guide to give — the same threshold as the CORS memo above,
 * which is the same kind of evidence about the same kind of door. Session-only, like the CORS memo and for the same
 * reason: a reload is a fair moment to find out it was wrong. A single answer
 * of any kind clears the count, so a door having a bad minute is not written
 * off for it.
 *
 * Deliberately NOT `noteTransientFailure`'s resting backoff: resting is for a
 * door that is struggling and will recover. A 404 is a door that does not
 * implement the call, and asking it again in a minute, and then two, is just a
 * slower version of the same storm.
 */
const EPG_GIVE_UP = 2;
const noGuideByHost = new Map<string, number>();

export function hostHasNoGuide(host: string): boolean {
  return (noGuideByHost.get(host) ?? 0) >= EPG_GIVE_UP;
}

/**
 * A device with no network is not a door with no guide.
 *
 * `navigator.onLine` false is the one thing a device states about itself with
 * authority (the same reasoning as `codecs.ts` and `playerCore`): true can lie
 * — a captive portal is "online" — but false is always a device that knows it
 * has no network. Every fetch is then a `TypeError`, which is the same shape
 * as the opaque rejection this memo is built on, and two channels asked in a
 * tunnel would otherwise write the guide off for the rest of the session and
 * leave it blank long after the signal came back.
 *
 * So an offline failure is not counted, and coming back online clears what was
 * counted, because a memo built while the network was failing is a memo built
 * on no evidence.
 */
export function noteNoGuide(host: string): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  noGuideByHost.set(host, (noGuideByHost.get(host) ?? 0) + 1);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    noGuideByHost.clear();
    corsFailuresByHost.clear();
  });
}

/** Any answer at all means the door is talking to us. */
export function noteGuideAnswered(host: string): void {
  noGuideByHost.delete(host);
}

/** For the tests, and for a sign-in that changes which door we are on. */
export function forgetNoGuide(): void {
  noGuideByHost.clear();
}

/**
 * Is `err` a REJECTED fetch shaped like that CORS failure — as opposed to an
 * HTTP status, a parse failure, or our own timeout?
 *
 * A CORS-blocked response never reaches script: the browser rejects the
 * `fetch()` promise itself, with a plain `TypeError` and no status code at
 * all — `"Failed to fetch"` in Chromium, `"NetworkError when attempting to
 * fetch resource"` in Firefox, `"Load failed"` in Safari/WebKit. Two things
 * must NOT be read as that:
 *
 *   - `XtreamHttpError` — a real HTTP status (401/403/456/5xx included) or a
 *     200 that was not JSON. The panel answered; that already has its own
 *     handling (`notePanelFailure`, the flood-protection UI, …), and folding
 *     it into this one would fall back to short EPG on an expired
 *     subscription, which is a different bug wearing this one's fix.
 *   - `AbortError` — OUR OWN `timeoutMs` firing (`fetchJson`'s
 *     `ac.abort()`). Slow is not blocked, and must not flip a host into
 *     short-EPG-only for the rest of the session.
 *
 * `err instanceof TypeError` already excludes both — neither is a
 * `TypeError` — but the `AbortError` check stays explicit because excluding
 * it is a REQUIREMENT here, not an implementation detail this happens to
 * lean on.
 */
export function isCorsShapedFailure(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  return (err as { name?: unknown }).name !== 'AbortError';
}

/**
 * Statuses that mean "not now", as opposed to "not ever".
 *
 * 5xx is the panel failing. The rest are flood protection, which this product
 * is shaped by: `docs/08-gotchas.md` records that exceeding a per-IP rate gets
 * a door to answer with these rather than with `429`, and 456 is account-wide.
 * A subscription that allows one stream meets them regularly.
 */
const NOT_NOW = new Set([429, 456, 509, 511, 513]);

/**
 * Did the panel fail to answer, rather than answer that there is nothing?
 *
 * ── the bug this exists for ──
 *
 * `fetchChannel`'s catch stored `listings: 0` for ANY failure, and `isFresh`
 * then leaves such a channel alone for six hours. That is right for a channel
 * whose panel genuinely publishes no guide — which is most of them — and
 * wrong for every channel that happened to ask while the panel was 5xx-ing or
 * refusing for flood protection: one bad minute writes "no guide" across a
 * whole screen of channels and they stay that way for the rest of the day,
 * with no way to tell the two apart afterwards.
 *
 * `AbortError` is OUR timeout firing, which is the same kind of answer: we
 * never heard, so we know nothing. An `XtreamHttpError` with any other status
 * — 401, 403, a 200 that was not JSON — IS an answer, and keeps the existing
 * behaviour exactly.
 */
export function isTransientPanelFailure(err: unknown): boolean {
  if ((err as { name?: unknown })?.name === 'AbortError') return true;
  const status = (err as { status?: unknown })?.status;
  if (typeof status !== 'number') return false;
  return status >= 500 || NOT_NOW.has(status);
}

/** After this many transient failures in a row, a host is left alone. */
const REST_AFTER = 2;

/** How long to leave it alone, doubling each time it trips again. */
const REST_MS = 60_000;
const REST_MAX_MS = 30 * 60_000;

/**
 * Hosts that are failing, and until when — session-only, like the CORS memo
 * above and for the same reason: a reload is a fair reason to try again.
 *
 * Without this, a panel having a bad minute is asked once per channel, and
 * each ask costs the FULL four-attempt retry inside `fetchJson` with backoff
 * to four seconds. A guide screen with a hundred visible channels is then
 * four hundred requests at a panel that is already struggling — which is one
 * of the ways a door decides to start refusing an account outright.
 */
const restingHosts = new Map<string, { failures: number; until: number }>();

export function hostIsResting(host: string, now = Date.now()): boolean {
  const rest = restingHosts.get(host);
  return rest !== undefined && rest.until > now;
}

export function noteTransientFailure(host: string, now = Date.now()): void {
  const had = restingHosts.get(host);
  const failures = (had?.failures ?? 0) + 1;
  if (failures < REST_AFTER) {
    restingHosts.set(host, { failures, until: 0 });
    return;
  }
  const step = Math.min(REST_MS * 2 ** (failures - REST_AFTER), REST_MAX_MS);
  restingHosts.set(host, { failures, until: now + step });
}

/** A host that answers again starts with a clean sheet. */
export function noteHostAnswered(host: string): void {
  restingHosts.delete(host);
}

/** For the tests, which must not inherit another test's memo. */
export function forgetHostRest(): void {
  restingHosts.clear();
}

/**
 * How many programmes to ask `get_short_epg` for when the full table is
 * unreachable — "roughly the rest of today and tomorrow" turned into a row
 * count, since `limit` counts programmes, not hours.
 *
 * Two measured rows/day rates on this reference panel: this file's own,
 * quoted below in `fetchChannel` (455 listings / 10.8 days ≈ 42/day), and a
 * fresh one taken while building this fallback, on a different sample
 * channel (173 listings / 10.7 days ≈ 16/day). Forty rows is ~1 day of
 * coverage at the busier rate and ~2.5 days at the quieter one —
 * "roughly" is doing real work in that phrase, because programme density is
 * per-channel and this fallback has no way to know which kind it is about to
 * ask for before the answer arrives. Chosen on the smaller side because
 * response size was the stated constraint, not coverage: a "roughly" that
 * undershoots costs a re-ask in six hours (the freshness window), one that
 * oversends costs bytes on every CORS-blocked channel for the rest of the
 * session.
 *
 * MEASURED, and worth recording because it contradicts the count this number
 * asks for: this reference panel ignores `limit` entirely. Requesting 4, 10,
 * 20, 36, 60 and 100 against the same channel all returned the same 4 rows,
 * reaching about 1.3 hours ahead — the four-row default, uncustomisable. So
 * on THIS panel the number below changes nothing; the real ceiling is the
 * panel's. It is still the right number to send: `get_short_epg`'s `limit`
 * is a documented, honoured parameter on other forks (docs/02-xtream-api.md
 * §3), and asking for less would silently cap the guide on any panel that
 * actually listens to it.
 */
const SHORT_EPG_LIMIT = 40;

/**
 * A normalised EPG row -> what this file stores.
 *
 * `upcomingOnly` is forced for everything sourced from `get_short_epg`.
 * Measured: asking both actions for the SAME channel on the SAME host, the
 * full table's rows carry `now_playing` and `has_archive`; the short table's
 * rows carry NEITHER key at all — so `hasArchive` would already decode to
 * `false` via `flexBool(undefined)` even without this flag. It is forced
 * explicitly anyway, because a fork that DOES send `has_archive` on
 * `get_short_epg` is not ruled out (docs/02-xtream-api.md §9 catalogues
 * several that diverge), and a several-programme forward window is never the
 * panel's authoritative per-programme archive signal — only
 * `get_simple_data_table` is (docs/03-catchup-epg.md §1, gating logic
 * priority 1). Trusting it either way would let `DetailSheet.tsx`'s "↺
 * replayable" badge, or `localRead.ts`'s `archive` count, claim catch-up on
 * a programme that has not aired yet — both read `Slot.hasArchive` on
 * `upcoming` slots with no past/future check of their own.
 */
export function toSlots(rows: readonly EpgEntry[], upcomingOnly: boolean): Slot[] {
  return rows
    .filter((r) => r.startTs !== null)
    .map((r) => ({
      title: r.title, description: r.description,
      startTs: r.startTs as number, stopTs: r.stopTs,
      hasArchive: upcomingOnly ? false : r.hasArchive === true,
    }))
    .sort((a, b) => a.startTs - b.startTs);
}

/**
 * Ask the panel for one channel, at most once at a time.
 *
 * `get_simple_data_table` answers with an object holding `epg_listings`, and one
 * call covers about a week — measured at 455 listings over 10.8 days. Rows with
 * no start time are dropped, exactly as the server's ingest dropped them: a slot
 * with no beginning cannot be placed on a grid.
 *
 * ── the CORS fallback ──
 *
 * Some doors answer `get_simple_data_table` with the wrong
 * `Access-Control-Allow-Origin` while every other EPG action on the same
 * door is fine (`corsFailuresByHost` above has the measurement). A browser
 * cannot work around that from script — the fetch never yields a response to
 * inspect, it just rejects — so the only move is a DIFFERENT request:
 * `get_short_epg`, which the evidence shows is not blocked. This never
 * triggers on the APK, whose WebView origin the door already accepts (a
 * successful `epgTable` never throws, so the fallback below is simply never
 * reached), and never on a real HTTP error — auth, flood protection, a dead
 * host — those still fail exactly as they did before this existed.
 */
export function fetchChannel(streamId: number, band: Band = 'visible'): Promise<boolean> {
  return scheduler.submit(`epg:${streamId}`, band, async () => {
    if (stalkerActive()) return fetchPortalChannel(streamId);
    const client = panelClient();
    if (client === null) return false;
    const host = client.base.host;
    /* A panel that is failing is not asked again until it has had a moment.
       Nothing is stored for this channel, so it is still un-fresh and will be
       asked the next time something visible wants it — see
       `isTransientPanelFailure`. */
    if (hostIsResting(host)) return false;
    /* A door with no guide at all is asked three times and then left alone —
       see `hostHasNoGuide`. This is the difference between a screen of channels
       costing three requests and costing four hundred. */
    if (hostHasNoGuide(host)) return false;
    try {
      if (!hostIsCorsBlocked(host)) {
        try {
          /* `normaliseEpg` takes the WHOLE reply, not the array inside it: the
             panel answers `get_simple_data_table` with an object holding
             `epg_listings`, and base64-decoding the titles is part of what
             it does. */
          const slots = toSlots(normaliseEpg(await client.epgTable(streamId)), false);
          await store(streamId, slots);
          noteHostAnswered(host);
          noteGuideAnswered(host);
          return true;
        } catch (err) {
          if (!isCorsShapedFailure(err)) throw err;
          noteCorsFailure(host);
          /* Falls through to the short-EPG fallback below — THIS channel
             still gets a guide, even on the very failure that trips the host. */
        }
      }
      const slots = toSlots(normaliseEpg(await client.shortEpg(streamId, SHORT_EPG_LIMIT)), true);
      await store(streamId, slots);
      noteHostAnswered(host);
      noteGuideAnswered(host);
      return true;
    } catch (err) {
      /*
       * A panel that could not answer has told us nothing about this channel.
       *
       * Recording the ask is what stops a channel being asked again on every
       * press — the freshness rule is about the question, not the answer — but
       * that only holds when there WAS an answer. A 5xx or a flood-protection
       * refusal is not one, and writing "no guide" for it marks the channel
       * empty for six hours over one bad minute.
       */
      if (isTransientPanelFailure(err)) {
        noteTransientFailure(host);
        return false;
      }
      /*
       * The fallback itself rejected opaquely: there is nothing left to try.
       *
       * Counted against the HOST rather than stored against the channel. Both
       * are "we learned nothing", but storing it would mark this one channel
       * empty for six hours while the next channel repeats the whole seven
       * seconds — which is precisely the storm described at `hostHasNoGuide`.
       */
      if (isCorsShapedFailure(err)) {
        noteNoGuide(host);
        return false;
      }
      await store(streamId, []);
      return false;
    }
  });
}

/**
 * A portal channel's guide: `get_short_epg`, the programmes from now onward.
 *
 * A portal that has no guide for a channel answers an empty list, which is stored
 * as "asked, nothing" like any other channel; a failure to REACH it stores
 * nothing, so the channel is asked again when something next wants it.
 */
async function fetchPortalChannel(streamId: number): Promise<boolean> {
  const ref = stalkerRefFor(Kind.Live, streamId);
  if (ref === null) return false;
  try {
    const rows = await withStalker((c) => c.shortEpg(ref.remoteId, SHORT_EPG_LIMIT));
    await store(streamId, toSlots(rows, true));
    return true;
  } catch (err) {
    if (err instanceof StalkerError && (err.code === 'unsupported' || err.code === 'bad_body')) {
      await store(streamId, []);
    }
    return false;
  }
}

async function coverageOf(streamId: number): Promise<Coverage | undefined> {
  const idx = await readIndex();
  return idx[String(streamId)];
}

/**
 * One channel's guide, cache first.
 *
 * Races a 2.5s timer and then answers with whatever is stored, which is the
 * server's `EPG_WAIT_MS` behaviour preserved exactly. A channel that is slow to
 * arrive is not a channel that should hold up the screen; the answer lands in the
 * store and the next read has it.
 */
export async function localEpgFor(
  streamId: number, band: Band = 'foreground',
): Promise<{ slots: Slot[]; now: Slot | null; upcoming: Slot[]; known: boolean }> {
  const nowS = Math.floor(Date.now() / 1000);
  const cov = await coverageOf(streamId);
  if (!isFresh(cov, nowS)) {
    await Promise.race([fetchChannel(streamId, band), new Promise((r) => setTimeout(r, WAIT_MS))]);
  }
  const slots = (await storedSlots(streamId)) ?? [];
  const { now, next } = nowNext(slots, nowS);
  return { slots: closeGaps(slots), now, upcoming: next, known: cov !== undefined || slots.length > 0 };
}

/**
 * A window over many channels — CACHE ONLY, and that is an invariant.
 *
 * The guide polls this until `known` flips, so a version that fetched would turn
 * fast scrolling into a burst of hundreds of requests, which is exactly how an
 * account gets flood-blocked. Filling is `topUp`'s job, at `visible` priority,
 * and it is a separate call precisely so that scrolling can cancel it.
 */
export async function localEpgGrid(
  streamIds: readonly number[], fromTs: number, hours: number,
): Promise<Map<number, { slots: Slot[]; known: boolean; until: number | null }>> {
  const out = new Map<number, { slots: Slot[]; known: boolean; until: number | null }>();
  const toTs = fromTs + hours * 3600;
  const idx = await readIndex();
  const nowS = Math.floor(Date.now() / 1000);
  for (const id of streamIds) {
    const entry = idx[String(id)];
    const slots = entry === undefined ? [] : (await storedSlots(id)) ?? [];
    out.set(id, {
      slots: windowOf(slots, fromTs, toTs),
      /*
       * `known` means "there is nothing more to get", not "a record exists".
       *
       * It used to mean the second, and the two part company on exactly the
       * channels that matter. `fetchChannel`'s catch block writes a record with
       * no listings for a channel it could not get a guide for — a CORS-shaped
       * failure, a timeout, a panel that had nothing yet — and that record made
       * the channel `known`. The caller's whole use of this flag is to decide
       * what to ASK for (`Live.tsx` and `Guide.tsx` both top up the `!known`
       * ones), so a channel that failed once was never asked again.
       *
       * Measured on the built app with a real subscription: 55 channels in the
       * index, 43 of them stored with no listings, and the Live screen making
       * ZERO requests in thirty seconds — every one of those rows was blank for
       * ever, and the report was "the EPG is not under the channel name".
       *
       * So a record with no listings counts as known only while it is still
       * fresh (`isFresh`, which now gives an empty answer half an hour rather
       * than six hours). Nothing here fetches — that invariant is untouched;
       * this only stops lying to the thing that does.
       */
      known: slots.length > 0 || (entry !== undefined && isFresh(entry, nowS)),
      until: entry?.until ?? null,
    });
  }
  return out;
}

/**
 * Queue the channels on screen, and forget the ones that are not.
 *
 * `visible` is a stack that is cleared on every call, so scrolling replaces the
 * backlog rather than queueing behind it: the rows under someone's eyes are the
 * rows worth a request, and the ones they scrolled past three screens ago are not.
 */
export async function topUp(
  streamIds: readonly number[],
  opts: { replace?: boolean } = {},
): Promise<{ queued: number; known: number }> {
  const nowS = Math.floor(Date.now() / 1000);
  const idx = await readIndex();
  /*
   * Whether this ask SUPERSEDES the last one.
   *
   * It always did, and that was the bug behind "those whats playing now, its not
   * consistant and doesnt load always, or takes too long to load". The Guide
   * turns a page and the previous page's channels genuinely stop mattering — but
   * the channel list asks again every time the window moves, and each ask threw
   * away the rows the one before it had queued and not yet run. At a 250 ms gap
   * per request a screenful takes several seconds to drain, so a viewer walking
   * down the list cancelled the answers they were waiting for, over and over,
   * and the rows that happened to survive were the inconsistency they saw.
   *
   * In flight work was never touched either way — only what is still waiting.
   */
  if (opts.replace === true) scheduler.clear('visible');
  let queued = 0;
  let known = 0;
  for (const id of streamIds.slice(0, 60)) {
    const cov = idx[String(id)];
    if (cov !== undefined) known++;
    if (isFresh(cov, nowS)) continue;
    void fetchChannel(id, 'visible');
    queued++;
  }
  return { queued, known };
}

/** Forget every stored guide — the bulk one too. Used when a subscription is removed. */
export async function clearEpg(): Promise<void> {
  await clearBulkGuide();
  const idx = await readIndex();
  for (const k of Object.keys(idx)) {
    try { await blobs().delete(chanKey(Number(k))); } catch { /* gone */ }
  }
  index = {};
  await writeIndex();
}

export { channelKey };
