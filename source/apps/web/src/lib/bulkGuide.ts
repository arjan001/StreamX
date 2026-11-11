/**
 * The whole TV guide, downloaded once and kept on the device.
 *
 * "check if their server has a way to get EPG in bulk, because per channel is
 * not efficient … download the whole cache of the future … cached in their
 * device so the next time they visit it's already there … if you cannot find
 * that day you can fetch it again" — and, once the size was on the table: "its
 * fine if its big, you can download it for the first time when downloading the
 * whole playlist, show loadings", "each time proper clean up so it doesn't clog
 * up space".
 *
 * Every Xtream panel serves `xmltv.php`: the full guide in one file. Measured on
 * the owner's line, 16.7 MB on the wire (brotli) and 93 MB of XML — 291,789
 * programmes for 4,385 guide channels, yesterday morning to tomorrow morning.
 * Read as a stream (`xmltv.ts`), so the 93 MB is never one string, and parsed
 * in 2.2 s on this server; a television takes several times that, spread over a
 * download that is slower still.
 *
 * ── what is kept ──
 *
 * Only what can still be shown: programmes ending no earlier than two hours
 * ago, on channels this catalogue actually carries, with the description cut to
 * what a guide row and the player's line can display. Grouped by guide id — the
 * `epg_channel_id` a panel publishes and the `channel` XMLTV uses — and written
 * as `SHARDS` compressed records, so reading one channel's evening decompresses
 * a thirty-second of the guide, not all of it.
 *
 * ── cleaning up ──
 *
 * One guide per device, never several. A refresh writes the same shard keys
 * over the old ones, so the store never grows by a second copy; the ended
 * programmes are dropped at the moment of writing; the guide is deleted outright
 * when the account it belongs to is not the active one any more; and `MAX_KEPT`
 * bounds the whole thing whatever a panel sends.
 *
 * ── what it replaces, and what it does not ──
 *
 * The per-channel ask (`localEpg.ts`) stays, as the rung below: a channel the
 * bulk guide has nothing for is still asked for by itself, and a channel with
 * catch-up still asks, because only `get_simple_data_table` says which
 * programmes are replayable. Everything else stops costing a request per row —
 * which is also what stops a scrolled guide flooding a one-connection account.
 */
import type { Slot } from '@iptv/core-store';
import { KIND, readText } from '@iptv/core-store';
import { baseUrl } from '@iptv/core-xtream';
import { XmltvReader } from './xmltv.ts';
import { blobs, localCatalogue } from './localCatalogue.ts';
import { squeeze, unsqueeze } from './squeeze.ts';
import { kv } from './kv.ts';
import { activeProvider, credentials, panelClient, type Provider } from './providers/index.ts';
import { guideReader } from './guideBody.ts';
import { dlog } from './debugLog.ts';
import { breather } from './breather.ts';

const PREFIX = 'epg.bulk.v1.';
const META_KEY = `${PREFIX}meta`;
const NAMES_KEY = `${PREFIX}names`;
/** How many records the guide is split into. A power of two, for `shardOf`. */
export const SHARDS = 32;
/** Longest description kept. A guide row shows one line; the player's, three. */
const DESC_MAX = 160;
/** Programmes that ended longer ago than this are not kept. */
const KEEP_PAST_S = 2 * 3600;
/** A ceiling whatever a panel sends — about twice the owner's line. */
const MAX_KEPT = 400_000;

/**
 * When the guide is worth updating — and only the viewer updates it.
 *
 * It used to refresh itself: checked eight seconds after launch, then hourly,
 * and fetched again whenever it was twelve hours old or ran out within
 * eighteen. This panel publishes about a day ahead, so a guide fetched in the
 * morning already "ran out within eighteen hours" and the 17 MB download ran
 * roughly every hour, whatever was playing, on the same line as the picture.
 * "instead of auto update make it so there is a banner … your EPG is expired and
 * they update … that way it won't disturb the other connection". So nothing
 * here downloads on its own except a FIRST guide for an account (the library
 * has just been built and nothing is playing); after that the banner asks.
 */
/** Say so when the guide runs out sooner than this… */
const SOON_S = 3 * 3600;
/** …or when it was fetched longer ago than this, whatever it covers. */
const OLD_MS = 48 * 3600_000;
/** After a failure, leave the panel alone for this long, doubling to a cap. */
const RETRY_MS = 60 * 60_000;
const RETRY_MAX_MS = 12 * 3600_000;
/** How much of the guide is parsed before the screen gets a turn. */
const PIECE = 64 * 1024;
/** A download that goes this long without a byte is given up. */
const STALL_MS = 45_000;

const FAIL_KEY = 'iptv.epg.bulk.fail';

interface Meta {
  v: 1;
  /** The account this guide belongs to. */
  provider: number;
  fetchedAt: number;
  /** Unix seconds: the last programme's end. */
  until: number;
  programmes: number;
  channels: number;
  /** Decoded bytes read last time — what the next download's percentage is of. */
  bytes: number;
}

/** A programme as stored: [start, stop, title, description]. */
type Row = [number, number | null, string, string | null];

/**
 * How current the stored guide is, for the banner.
 *
 * `unknown` until the first check has read the record; `missing` when this
 * account has no guide on the device; `soon` when it runs out within
 * `SOON_S`; `expired` when it has run out; `old` when it still covers now but
 * was fetched more than `OLD_MS` ago; otherwise `fresh`.
 */
export type GuideFreshness = 'unknown' | 'missing' | 'fresh' | 'soon' | 'expired' | 'old';

export function guideFreshness(m: { until: number; fetchedAt: number } | null, nowMs: number): GuideFreshness {
  if (m === null) return 'missing';
  const left = m.until - nowMs / 1000;
  if (left <= 0) return 'expired';
  if (left < SOON_S) return 'soon';
  if (nowMs - m.fetchedAt > OLD_MS) return 'old';
  return 'fresh';
}

export interface BulkGuideStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  freshness: GuideFreshness;
  /** Unix seconds: when the stored guide runs out. Null with no guide. */
  until: number | null;
  /** When the stored guide was fetched. Null with no guide. */
  fetchedAt: number | null;
  /** Bumped each time a download lands, so screens know to read again. */
  landed: number;
  /** Decoded bytes so far. */
  bytes: number;
  /** Last run's total, when known — so progress can be a percentage. */
  expected: number | null;
  programmes: number;
  error: string | null;
}

let status: BulkGuideStatus = {
  state: 'idle', freshness: 'unknown', until: null, fetchedAt: null,
  landed: 0, bytes: 0, expected: null, programmes: 0, error: null,
};
const watchers = new Set<(s: BulkGuideStatus) => void>();

function publish(patch: Partial<BulkGuideStatus>): void {
  status = { ...status, ...patch };
  for (const fn of watchers) { try { fn(status); } catch { /* a watcher's problem */ } }
}

export function bulkGuideStatus(): BulkGuideStatus { return status; }

export function subscribeBulkGuide(fn: (s: BulkGuideStatus) => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

/** Which record a guide id lives in. Stable across refreshes, which is the point. */
export function shardOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) & (SHARDS - 1);
}

/**
 * A channel name reduced to what two spellings of it share.
 *
 * Most channels on a line carry no guide id — 8,733 of 10,849 on one measured
 * line — but the guide file names its channels, and the names are the panel's
 * own: `BE| VRT 1 ᴿᴬᵂ` in the list is `BE| VRT 1` in the file. Case, accents,
 * superscript tier marks, bracketed notes and quality words go; the country
 * prefix stays, because `BBC ONE` in Belgium and in Britain are different
 * guides. Measured: 358 more channels with a guide on that line, 1,405 → 1,763.
 */
export function guideKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u1d2c-\u1d7f\u02b0-\u02ff\u1d9b-\u1dbf]+/g, '')
    .toUpperCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/\b(SD|HD|FHD|UHD|4K|8K|HEVC|H265|RAW|50FPS|60FPS|LQ|HQ)\b/g, '')
    .replace(/[^A-Z0-9|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Programmes worth keeping, grouped by guide id. Pure — the tests drive it.
 *
 * `wanted` is the set of guide ids the catalogue carries; null keeps everything.
 */
export class GuideCollector {
  readonly byChannel = new Map<string, Row[]>();
  kept = 0;
  until = 0;
  private readonly floor: number;
  private readonly wanted: ReadonlySet<string> | null;

  constructor(nowS: number, wanted: ReadonlySet<string> | null) {
    this.floor = nowS - KEEP_PAST_S;
    this.wanted = wanted;
  }

  add(p: { channel: string; start: number; stop: number | null; title: string; desc: string | null }): void {
    if (this.kept >= MAX_KEPT) return;
    if ((p.stop ?? p.start) < this.floor) return;
    if (this.wanted !== null && !this.wanted.has(p.channel)) return;
    let list = this.byChannel.get(p.channel);
    if (list === undefined) this.byChannel.set(p.channel, (list = []));
    const desc = p.desc === null ? null : (p.desc.length > DESC_MAX ? `${p.desc.slice(0, DESC_MAX - 1)}…` : p.desc);
    list.push([p.start, p.stop, p.title, desc]);
    this.kept++;
    const end = p.stop ?? p.start;
    if (end > this.until) this.until = end;
  }

  /**
   * The shards, each channel's programmes in time order with duplicates gone.
   * Sorted a few hundred channels at a time, handing the screen back between
   * them — 291,789 programmes in one go is seconds of a television's time.
   */
  async shards(): Promise<Record<string, Row[]>[]> {
    const out: Record<string, Row[]>[] = Array.from({ length: SHARDS }, () => ({}));
    let n = 0;
    for (const [id, rows] of this.byChannel) {
      rows.sort((a, b) => a[0] - b[0]);
      const clean = rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1]![0]);
      out[shardOf(id)]![id] = clean;
      // eslint-disable-next-line no-await-in-loop
      if (++n % 200 === 0) await breather();
    }
    return out;
  }
}

/* ── reading ─────────────────────────────────────────────────────────────── */

let meta: Meta | null | undefined;
const shardCache = new Map<number, Promise<Record<string, Row[]>>>();
let names: Promise<Record<string, string>> | null = null;

function nameIndex(): Promise<Record<string, string>> {
  if (names === null) {
    names = (async () => {
      try {
        const v = await unsqueeze(await blobs().get(NAMES_KEY));
        return (v !== null && typeof v === 'object' ? v : {}) as Record<string, string>;
      } catch { return {}; }
    })();
  }
  return names;
}

async function readMeta(): Promise<Meta | null> {
  if (meta !== undefined) return meta;
  try {
    const m = await blobs().get(META_KEY) as Meta | undefined;
    meta = m !== undefined && m !== null && m.v === 1 ? m : null;
  } catch { meta = null; }
  return meta;
}

function shard(i: number): Promise<Record<string, Row[]>> {
  let p = shardCache.get(i);
  if (p === undefined) {
    p = (async () => {
      try {
        const v = await unsqueeze(await blobs().get(`${PREFIX}s${i}`));
        return (v !== null && typeof v === 'object' ? v : {}) as Record<string, Row[]>;
      } catch { return {}; }
    })();
    shardCache.set(i, p);
  }
  return p;
}

/** The guide belongs to whoever is signed in now — or to nobody. */
async function usableMeta(): Promise<Meta | null> {
  const m = await readMeta();
  const p = activeProvider();
  if (m === null || p === null || m.provider !== p.id) return null;
  return m;
}

/**
 * Is there a current guide on this device for the signed-in account?
 *
 * When there is, it has the last word for every channel without catch-up: a
 * channel it has nothing for has nothing — the per-channel ask would come back
 * empty too (measured: a channel with no guide id answers `{"epg_listings":[]}`
 * by its stream number), and asking anyway is what kept rows on "…" and cost a
 * request per row.
 */
export async function bulkGuideUsable(): Promise<boolean> {
  return (await usableMeta()) !== null;
}

/**
 * One channel's programmes from the bulk guide, by its guide id or — when it
 * has none, or the file has nothing under it — by its name. Null when neither
 * finds anything.
 */
export async function bulkSlots(guideId: string | null, name?: string): Promise<Slot[] | null> {
  const m = await usableMeta();
  if (m === null) return null;
  let rows: Row[] | undefined;
  if (guideId !== null && guideId !== '') rows = (await shard(shardOf(guideId)))[guideId];
  if ((rows === undefined || rows.length === 0) && name !== undefined) {
    const alias = (await nameIndex())[guideKey(name)];
    if (alias !== undefined) rows = (await shard(shardOf(alias)))[alias];
  }
  if (rows === undefined || rows.length === 0) return null;
  const floor = Math.floor(Date.now() / 1000) - KEEP_PAST_S;
  const slots: Slot[] = [];
  for (const [startTs, stopTs, title, description] of rows) {
    if ((stopTs ?? startTs) < floor) continue;
    slots.push({ title, description, startTs, stopTs, hasArchive: false });
  }
  return slots.length === 0 ? null : slots;
}

/* ── downloading ─────────────────────────────────────────────────────────── */

function failures(): { at: number; n: number } {
  try {
    const v = JSON.parse(kv.get(FAIL_KEY) ?? 'null') as { at?: number; n?: number } | null;
    return { at: v?.at ?? 0, n: v?.n ?? 0 };
  } catch { return { at: 0, n: 0 }; }
}

function noteFailure(): void {
  const f = failures();
  try { kv.set(FAIL_KEY, JSON.stringify({ at: Date.now(), n: f.n + 1 })); } catch { /* private mode */ }
}

function clearFailures(): void {
  try { kv.remove(FAIL_KEY); } catch { /* private mode */ }
}

/**
 * What this catalogue can use: the guide ids its channels carry, and the names
 * of its channels (as `guideKey`s) for matching the ones that carry none.
 */
function catalogueKeys(): { ids: Set<string>; names: Set<string> } | null {
  const cat = localCatalogue();
  if (cat === null) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  const { kind, tvgIds } = cat.items;
  for (const k of Object.keys(tvgIds)) {
    const r = Number(k);
    if (kind[r] === KIND.Live) ids.add(tvgIds[r]!);
  }
  for (let r = 0; r < cat.items.count; r++) {
    if (kind[r] !== KIND.Live) continue;
    const key = guideKey(readText(cat.items.names, r));
    if (key !== '') names.add(key);
  }
  return { ids, names };
}

/**
 * Where this source's whole guide comes from.
 *
 * A panel serves `xmltv.php` from its own address. A playlist has no panel: its
 * guide is the link the viewer gave, else the one its header names. Several
 * header links are tried in order until one answers.
 */
export function guideUrlsFor(p: Provider): string[] {
  if (p.kind === 'xtream') {
    const client = panelClient();
    const cred = credentials();
    if (client === null || cred === null) return [];
    return [`${baseUrl(client.base)}/xmltv.php?username=${encodeURIComponent(cred.username)}`
      + `&password=${encodeURIComponent(cred.password)}`];
  }
  if (p.kind !== 'm3u') return [];
  const out: string[] = [];
  for (const u of [p.epgUrl, ...(p.headerGuideUrls ?? [])]) {
    if (u !== undefined && u !== '' && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * Can this source have a whole-guide file at all? A portal's guide is read per
 * channel (`localEpg.ts`), a single stream has none, and a playlist has one only
 * when its owner gave a link or its header names one.
 */
export function canHaveGuide(p: Provider | null): boolean {
  if (p === null) return false;
  if (p.kind === 'xtream') return true;
  return p.kind === 'm3u' && guideUrlsFor(p).length > 0;
}

let running: Promise<void> | null = null;

/** Read the record, drop another account's guide, and publish how current it is. */
async function assess(): Promise<{ providerId: number; current: Meta | null } | null> {
  const p = activeProvider();
  /* A portal's guide is read per channel (`localEpg.ts`); it has no whole-guide file. */
  if (p === null || localCatalogue() === null) return null;
  /* A single stream, a portal, a playlist with no guide link: nothing to keep,
     and nothing to ask for. Say so, or the "missing" a removed source left
     behind stays up as a prompt for a guide this source cannot have. */
  if (!canHaveGuide(p)) {
    publish({ freshness: 'unknown', until: null, fetchedAt: null, ...(status.state === 'error' ? { state: 'idle' as const, error: null } : {}) });
    return null;
  }
  const m = await readMeta();
  if (m !== null && m.provider !== p.id) await clearBulkGuide();
  const current = m !== null && m.provider === p.id ? m : null;
  publish({
    freshness: guideFreshness(current, Date.now()),
    until: current?.until ?? null,
    fetchedAt: current?.fetchedAt ?? null,
    ...(current !== null && status.state === 'idle' ? { state: 'ready' as const, programmes: current.programmes } : {}),
  });
  return { providerId: p.id, current };
}

/**
 * How current is the guide? One small read, never a download — what the hourly
 * check and the banner call.
 */
export function checkBulkGuide(): Promise<void> {
  if (running !== null) return running;
  return assess().then(() => undefined);
}

/**
 * A FIRST guide for this account, when there is none; otherwise only the check.
 *
 * The one download that still starts on its own: straight after a library is
 * built for a new account there is no guide at all, and a Live TV with every
 * row reading "…" until somebody finds a button is not a better first minute.
 * The caller does not call it while something plays. Never two downloads at
 * once, and never straight after a failure — see `RETRY_MS`.
 */
export function ensureBulkGuide(): Promise<void> {
  if (running !== null) return running;
  running = (async () => {
    const a = await assess();
    if (a === null || a.current !== null) return;
    const f = failures();
    const wait = Math.min(RETRY_MS * 2 ** Math.max(0, f.n - 1), RETRY_MAX_MS);
    if (f.n > 0 && Date.now() - f.at < wait) return;
    await download(a.providerId, null);
  })().finally(() => { running = null; });
  return running;
}

/** The viewer pressed Update: download now, whatever the last attempt did. */
export function updateBulkGuide(): Promise<void> {
  if (running !== null) return running;
  running = (async () => {
    const a = await assess();
    if (a === null) return;
    await download(a.providerId, a.current?.bytes ?? null);
    await assess();
  })().finally(() => { running = null; });
  return running;
}

async function download(providerId: number, expected: number | null): Promise<void> {
  const p = activeProvider();
  const urls = p === null ? [] : guideUrlsFor(p);
  if (urls.length === 0) return;
  publish({ state: 'loading', bytes: 0, expected, programmes: 0, error: null });
  const ctrl = new AbortController();
  let stall = setTimeout(() => ctrl.abort(), STALL_MS);
  const nowS = Math.floor(Date.now() / 1000);
  const keys = catalogueKeys();
  /* Grows while the channel list is read: a guide channel whose NAME matches
     one of ours is wanted as well as the ones whose id does. The channel list
     comes before every programme, so the set is complete before it is asked. */
  const wanted = keys === null ? null : new Set(keys.ids);
  const alias = new Map<string, string | null>();
  const collect = new GuideCollector(nowS, wanted);
  const reader = new XmltvReader((prog) => collect.add(prog), (id, displayNames) => {
    if (keys === null) return;
    for (const n of displayNames) {
      const key = guideKey(n);
      if (key === '' || !keys.names.has(key)) continue;
      const had = alias.get(key);
      /* Two guide channels under one name: neither is trusted for it. */
      alias.set(key, had === undefined || had === id ? id : null);
      wanted?.add(id);
    }
  });
  let bytes = 0;
  try {
    /* The first link that answers is the guide; the others are fallbacks. */
    let body: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let lastError: unknown = null;
    for (const url of urls) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok || res.body === null) throw new Error(`the guide answered ${res.status}`);
        // eslint-disable-next-line no-await-in-loop
        body = await guideReader(res);
        break;
      } catch (e) { lastError = e; }
    }
    if (body === null) throw lastError ?? new Error('the guide could not be fetched');
    const decoder = new TextDecoder();
    let lastPublish = 0;
    for (;;) {
      const { done, value } = await body.read();
      clearTimeout(stall);
      if (done) break;
      stall = setTimeout(() => ctrl.abort(), STALL_MS);
      const text = decoder.decode(value, { stream: true });
      bytes += text.length;
      /* In pieces, with the screen's turn between them: a fast line hands over
         chunks of a megabyte or more, and parsing one whole was a frozen remote
         on a television for as long as it took. */
      for (let at = 0; at < text.length; at += PIECE) {
        reader.push(text.slice(at, at + PIECE));
        // eslint-disable-next-line no-await-in-loop
        if (text.length > PIECE) await breather();
      }
      const t = Date.now();
      if (t - lastPublish > 400) {
        lastPublish = t;
        publish({ bytes, programmes: collect.kept });
      }
    }
    reader.push(decoder.decode());
    reader.finish();
    if (collect.kept === 0) throw new Error('the guide had nothing for these channels');
    const aliases: Record<string, string> = {};
    for (const [key, id] of alias) if (id !== null && collect.byChannel.has(id)) aliases[key] = id;
    await write(providerId, collect, bytes, aliases);
    clearFailures();
    publish({
      state: 'ready', landed: status.landed + 1, bytes, programmes: collect.kept,
      /* And how current it now is — or the banner goes on asking for the guide
         that has just arrived. */
      freshness: guideFreshness(meta ?? null, Date.now()), until: meta?.until ?? null, fetchedAt: meta?.fetchedAt ?? null,
    });
    dlog.info('epg', `bulk guide: ${collect.kept} programmes on ${collect.byChannel.size} channels, ${(bytes / 1e6).toFixed(0)} MB`);
  } catch (err) {
    noteFailure();
    const why = ctrl.signal.aborted ? 'the guide stopped arriving' : err instanceof Error ? err.message : String(err);
    /* Not an error the viewer has to act on: the per-channel guide carries on
       exactly as before. So it is a warning in the log, and a quiet status. */
    dlog.warn('epg', `bulk guide not downloaded — ${why}`);
    publish({ state: 'error', error: why });
  } finally {
    clearTimeout(stall);
  }
}

async function write(
  providerId: number, collect: GuideCollector, bytes: number, aliases: Record<string, string>,
): Promise<void> {
  const store = blobs();
  const shards = await collect.shards();
  /* Meta goes first as "absent": a guide half rewritten must not be read as the
     old one's shards under the new one's dates. */
  meta = null;
  shardCache.clear();
  names = null;
  try { await store.delete(META_KEY); } catch { /* not there */ }
  for (let i = 0; i < SHARDS; i++) {
    await store.put(`${PREFIX}s${i}`, await squeeze(shards[i]));
  }
  await store.put(NAMES_KEY, await squeeze(aliases));
  const next: Meta = {
    v: 1, provider: providerId, fetchedAt: Date.now(), until: collect.until,
    programmes: collect.kept, channels: collect.byChannel.size, bytes,
  };
  await store.put(META_KEY, next);
  meta = next;
}

/** Delete the stored guide if it belongs to this source; another source's is left alone. */
export async function forgetGuideOf(providerId: number): Promise<void> {
  const m = await readMeta();
  if (m !== null && m.provider === providerId) await clearBulkGuide();
}

/** Delete the stored guide — an account removed or switched takes its guide with it. */
export async function clearBulkGuide(): Promise<void> {
  meta = null;
  shardCache.clear();
  names = null;
  const store = blobs();
  try {
    const keys = await store.keys();
    for (const k of keys) if (k.startsWith('epg.bulk.')) await store.delete(k);
  } catch { /* nothing stored */ }
  publish({
    state: 'idle', freshness: 'missing', until: null, fetchedAt: null,
    landed: status.landed + 1, bytes: 0, expected: null, programmes: 0, error: null,
  });
}
