/**
 * The catalogue, on this device.
 *
 * The app downloads the provider's own JSON once, normalises it here, stores it
 * in IndexedDB as columns, and answers every list, filter, count and search from
 * memory.
 *
 * The measured basis for doing it at all: a filtered, sorted page over 82,666
 * live rows takes 23ms here, a substring search over 124,157 rows takes 2.1ms,
 * and the whole catalogue is about 9MB stored. Reading it back cold is 38ms.
 * Those numbers are why this is a local database rather than a cache.
 *
 * Enabled by `VITE_DATA=local`, which every packaged build sets.
 */
import {
  buildCatalogue, clearCatalogue, indexedDbStore, loadCatalogue, memoryStore, saveCatalogue,
  type BlobStore, type Catalogue, type RawPayloads,
} from '@iptv/core-store';
import { CATALOGUE_RULES_VERSION } from '@iptv/core-xtream';
import { loadM3uCatalogue, streamPayloads } from './m3uCatalogue.ts';
import { loadStalkerCatalogue } from './stalkerCatalogue.ts';
import { setSide, sideKey, toSide, type SideMap } from './playSide.ts';
import {
  activeProvider, isPlaylistKind, notePanelFailure, panelClient, stalkerMessage, updateProvider, withStalker,
} from './providers/index.ts';
import type { ProviderKind } from './providers/index.ts';
import { kv } from './kv.ts';
import { squeeze, unsqueeze } from './squeeze.ts';
import { dlog } from './debugLog.ts';

export type Phase =
  | 'liveCategories' | 'vodCategories' | 'seriesCategories'
  | 'live' | 'vod' | 'series' | 'saving' | 'store' | 'packages';

export interface IngestStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  phase: Phase | null;
  step: number;
  steps: number;
  bytes: number;
  rows: number;
  error: string | null;
  /** When the stored catalogue was built, epoch ms, or null when there is none. */
  builtAt: number | null;
  /**
   * The local generation this copy was built from — see `storedGeneration`.
   *
   * The panel offers no deltas — every endpoint answers with a complete list — so
   * the only honest saving available is to not download at all when nothing has
   * changed. A weekly check therefore costs one small request in the normal case
   * and a full download only when the catalogue really moved.
   */
  generation: number | null;
  /** True while a check is running, so the button can say what it is doing. */
  checking: boolean;
}

const PHASES: { id: Phase; action: string; key: keyof RawPayloads; label: string }[] = [
  { id: 'liveCategories', action: 'get_live_categories', key: 'liveCategories', label: 'Channel groups' },
  { id: 'vodCategories', action: 'get_vod_categories', key: 'vodCategories', label: 'Film groups' },
  { id: 'seriesCategories', action: 'get_series_categories', key: 'seriesCategories', label: 'Series groups' },
  { id: 'live', action: 'get_live_streams', key: 'live', label: 'Channels' },
  { id: 'vod', action: 'get_vod_streams', key: 'vod', label: 'Films' },
  { id: 'series', action: 'get_series', key: 'series', label: 'Series' },
];

/** The three that actually carry weight; the category lists are fetched together. */
const STREAM_PHASES = PHASES.filter((p) => p.key === 'live' || p.key === 'vod' || p.key === 'series');

export const PHASE_LABELS: Record<Phase, string> = {
  ...Object.fromEntries(PHASES.map((p) => [p.id, p.label])),
  saving: 'Saving what was downloaded',
  store: 'Building the catalogue',
  packages: 'Downloading packages',
} as Record<Phase, string>;

let store: BlobStore | null = null;
/** Exported so the guide and detail caches share one database and one sweep. */
export function blobs(): BlobStore {
  if (store) return store;
  /* No IndexedDB — a locked-down webview, private mode in some browsers — is not
     a reason to fail. An in-memory store means the catalogue is rebuilt on every
     launch, which is slow and correct rather than fast and broken. */
  store = typeof indexedDB === 'undefined' ? memoryStore() : indexedDbStore();
  return store;
}

let catalogue: Catalogue | null = null;
/**
 * The highest generation this session has held, across sources.
 *
 * Switching source sets `catalogue = null` before the next one is built, so a
 * generation taken from the current catalogue restarted at 1 for every source.
 * Everything that caches by `cat.generation` (the stream-ref index, search,
 * topics, facets) then kept the PREVIOUS source's rows: opening a film on the
 * second source failed with "not on this device" because its ref was looked up
 * in the first source's index.
 */
let highestGeneration = 0;
let status: IngestStatus = {
  state: 'idle', phase: null, step: 0, steps: PHASES.length + 1, generation: null, checking: false,
  bytes: 0, rows: 0, error: null, builtAt: null,
};
const subs = new Set<(s: IngestStatus) => void>();

function publish(patch: Partial<IngestStatus>): void {
  status = { ...status, ...patch };
  for (const fn of subs) fn(status);
}

/**
 * Whether the catalogue is held on this device.
 *
 * Every packaged build is on-device by construction (`VITE_DATA=local`); any
 * other build reads the switch from `kv`, so the native store backs it too.
 *
 * On the device it costs ~19MB once and ~12MB stored, and then browsing costs
 * NOTHING — a substring search over 124,157 items measured at 2.1ms, a filter
 * and sort over 82,666 live rows at 23ms, cold read-back 38ms.
 */
const LOCAL_KEY = 'iptv.local.v1';

export function localEnabled(): boolean {
  if ((import.meta.env?.VITE_DATA as string | undefined) === 'local') return true;
  return kv.get(LOCAL_KEY) === 'on';
}

/**
 * Turn the on-device catalogue on or off.
 *
 * Switching ON starts the download immediately — the setting is only meaningful
 * once there is something on the device, and making someone reload to find that
 * out is how a switch gets described as "not working". Switching OFF deletes it:
 * a copy of the catalogue nobody is reading is 9MB of somebody's disk quota.
 */
export async function setLocalEnabled(on: boolean): Promise<void> {
  kv.set(LOCAL_KEY, on ? 'on' : 'off');
  if (on) {
    await initLocal();
    return;
  }
  catalogue = null;
  publish({ state: 'idle', phase: null, step: 0, bytes: 0, rows: 0, error: null, builtAt: null });
  try {
    const store = blobs();
    for (const key of await store.keys()) await store.delete(key);
  } catch {
    /* Nothing to delete, or no IndexedDB at all. Either way the reads are off. */
  }
}

/** The loaded catalogue, or null while there is none. Reads are synchronous. */
export function localCatalogue(): Catalogue | null {
  return catalogue;
}

export function localStatus(): IngestStatus {
  return status;
}

export function subscribeLocal(fn: (s: IngestStatus) => void): () => void {
  subs.add(fn);
  fn(status);
  return () => void subs.delete(fn);
}

/**
 * Download one endpoint, counting bytes as they arrive.
 *
 * The app holds the credentials and talks to the panel itself. `XtreamClient`
 * runs in a browser, serialises every request 250ms apart because panels
 * flood-protect rather than rate-limit, and counts bytes while reading a body.
 */
async function fetchPhase(
  action: string, onBytes: (n: number) => void, categoryId?: string,
): Promise<unknown[]> {
  const client = panelClient();
  if (client === null) throw new Error('no source on this device');

  /*
   * Progress is filtered by label rather than swapped in and out.
   *
   * There is ONE client — the panel counts requests per account, so a second one
   * would double the request rate against flood protection measured per IP — and
   * its `onBytes` is a single field. Category lists are asked for three at a time,
   * so whichever assigned last would otherwise report another phase's bytes as
   * this one's. The label makes each call hear only itself.
   */
  const want = LABELS[action];
  client.onBytes = (p) => { if (p.label === want) onBytes(p.bytes); };
  try {
    return await run(client, action, categoryId);
  } finally {
    client.onBytes = undefined;
  }
}

/** The one client call per panel action. */
async function run(
  client: NonNullable<ReturnType<typeof panelClient>>, action: string, categoryId?: string,
): Promise<unknown[]> {
  switch (action) {
    case 'get_live_categories': return await client.liveCategories();
    case 'get_vod_categories': return await client.vodCategories();
    case 'get_series_categories': return await client.seriesCategories();
    case 'get_live_streams': return await client.liveStreams(categoryId);
    case 'get_vod_streams': return await client.vodStreams(categoryId);
    case 'get_series': return await client.series(categoryId);
    default: throw new Error(`unknown action ${action}`);
  }
}

/** The label `XtreamClient` reports bytes under, per action. */
const LABELS: Record<string, string> = {
  get_live_categories: 'live_categories',
  get_vod_categories: 'vod_categories',
  get_series_categories: 'series_categories',
  get_live_streams: 'live_streams',
  get_vod_streams: 'vod_streams',
  get_series: 'series',
};

/**
 * Load from storage, and download only if there is nothing there.
 *
 * Called once at startup. An existing catalogue is used as-is however old it is:
 * a stale channel list is a working app, and a blocking download on every launch
 * is not. Refreshing is a deliberate act — see `refreshLocal`.
 */
/**
 * The generation this device's copy came from, and when it was last checked.
 *
 * Kept beside the catalogue rather than inside it: the catalogue blob is written
 * once per build and these two move on their own schedule.
 */
const GEN_KEY = 'iptv.local.generation';
const CHECKED_KEY = 'iptv.local.checkedAt';
/**
 * Which version of the ingest rules built the copy on this device.
 *
 * The generation id answers "has the provider published a new catalogue"; this
 * answers "do we still agree with ourselves about what a catalogue contains". The
 * two are independent, and only the first used to be checked — so when the rules
 * started dropping section headers and idle pay-per-view slots, every device that
 * already held a copy went on showing all 1,834 of them.
 */
const RULES_KEY = 'iptv.local.rules';

function storedRules(): number | null {
  const n = Number(kv.get(RULES_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A week. Long enough not to nag, short enough that a stale copy is noticed. */
export const CHECK_EVERY_MS = 7 * 24 * 3600_000;

/**
 * How many times this device has rebuilt from the panel.
 *
 * The panel publishes no version of its own, so this is a local counter, bumped
 * once per successful rebuild. It answers the only question anything asks of it
 * ("is what I am looking at the same build as a moment ago"), and it is what the
 * status line shows. What decides whether a refresh is NEEDED is the
 * fingerprint, not this.
 */
function storedGeneration(): number | null {
  const raw = kv.get(GEN_KEY);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function lastCheckedAt(): number {
  const n = Number(kv.get(CHECKED_KEY) ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * What the panel's catalogue looks like right now, in 64 hex characters.
 *
 * "Has the catalogue moved" has to be answered by the panel itself — and the
 * panel offers no version, no ETag and no Last-Modified worth the name. What it
 * does offer is three category lists totalling ~78KB against 18MB of streams,
 * which makes a cheap change probe (`XtreamClient.catalogueFingerprint`).
 *
 * The lists are KEPT rather than hashed and dropped. `catalogueFingerprint()`
 * fetches all three and throws them away, and every caller of this then
 * immediately re-fetches the same three — so the check cost twice what it needed
 * to. See `cachedLists`.
 *
 * It is a coarse signal and that is understood: it notices a package appearing or
 * disappearing, not three hundred new films inside one that already existed.
 * On-demand mode re-reads every held package on refresh, which catches the
 * second kind; full mode has the 30-day floor below for the same reason.
 */
type Lists = Pick<RawPayloads, 'liveCategories' | 'vodCategories' | 'seriesCategories'>;

const FP_KEY = 'iptv.local.fingerprint';
/** Hold the lists just long enough for the refresh that follows the check. */
const LIST_TTL_MS = 60_000;
let cachedLists: { at: number; lists: Lists } | null = null;

/**
 * SHA-256, or a stable fallback where WebCrypto is not available.
 *
 * `crypto.subtle` exists only in a secure context. `https://` and `localhost`
 * qualify; a plain-HTTP LAN address does not, and `direct.ts` exists because that
 * deployment is real. Without a fallback the digest throws, the check answers
 * "cannot tell", and such a device never refreshes its catalogue again — silently.
 * FNV-1a is not a cryptographic hash and does not need to be: nothing here is a
 * security boundary, it only has to change when the input changes.
 */
async function digest(text: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `fnv${h.toString(16).padStart(8, '0')}`;
  }
}

async function panelFingerprint(): Promise<string | null> {
  if (panelClient() === null) return null;
  try {
    const lists = await fetchCategoryLists();
    cachedLists = { at: Date.now(), lists };
    return await digest(JSON.stringify([
      lists.liveCategories, lists.vodCategories, lists.seriesCategories,
    ]));
  } catch { return null; }
}

/**
 * Scoped to the subscription, for the same reason the payload is.
 *
 * A fingerprint is a hash of ONE panel's category lists. Held globally it
 * answered "is the copy current?" with another account's evidence — so switching
 * to a subscription this device had never downloaded could look up to date and
 * never fetch anything.
 */
const fpKey = (): string => {
  const id = activeProvider()?.id;
  return id === undefined ? FP_KEY : `${FP_KEY}.${id}`;
};

function storedFingerprint(): string | null {
  const raw = kv.get(fpKey());
  return raw === null || raw === '' ? null : raw;
}

/**
 * Is this device's copy the current one?
 *
 * Returns null when the question cannot be answered — offline, or no subscription
 * — and null must never be treated as "out of date", or a flaky connection turns
 * into a repeated 19MB download.
 */
export async function catalogueIsCurrent(): Promise<boolean | null> {
  publish({ checking: true });
  try {
    const now = await panelFingerprint();
    if (now === null) return null;
    const mine = storedFingerprint();
    kv.set(CHECKED_KEY, String(Date.now()));
    /* Deliberately after the panel check, so an offline device still answers
       "cannot tell" rather than starting a download it cannot finish. */
    if (storedRules() !== CATALOGUE_RULES_VERSION) return false;
    return mine !== null && mine === now;
  } finally {
    publish({ checking: false });
  }
}

/** A saved playlist is re-read weekly; a single stream link has nothing to re-read. */
function isPlaylistActive(): boolean {
  const p = activeProvider();
  return p !== null && (p.kind === 'm3u' || p.kind === 'stalker');
}

/**
 * The weekly check, run at launch and never on a timer.
 *
 * Weekly, and a sync rather than a fresh download: the fingerprint compare
 * above means that in the normal week it is one request answering "no change",
 * and nothing is downloaded or thrown away. Only a real change costs a download.
 *
 * Never runs while something is already loading, and never on a device that has
 * not opted into keeping the catalogue locally.
 */
export async function weeklyCheck(now = Date.now()): Promise<void> {
  if (!localEnabled() || status.state === 'loading') return;
  if (now - lastCheckedAt() < CHECK_EVERY_MS) return;
  /* A playlist has no fingerprint to compare: once a week it is simply fetched again. */
  if (isPlaylistActive()) {
    kv.set(CHECKED_KEY, String(now));
    await refreshLocal();
    return;
  }
  const current = await catalogueIsCurrent();
  if (current === false) await refreshLocal();
}

/**
 * Only what they need: packages downloaded one at a time.
 *
 * Somebody who uses a couple of packages should not have to download the whole
 * library, and the panel supports that directly. Measured against an account:
 *
 *     get_live_categories                    834 rows      62KB   600ms
 *     get_vod_categories + get_series        217 rows      16KB
 *     get_live_streams (everything)       55,726 rows    18.4MB   900ms
 *     get_live_streams&category_id=1011        28 rows       9KB   330ms
 *     get_live_streams&category_id=2340       216 rows      75KB   380ms
 *     get_live_streams&category_id=999999       0 rows       0KB
 *
 * Two facts make it safe. The filter is HONOURED — every row in the answer carries
 * the category that was asked for — and a category that does not exist returns an
 * empty list rather than the whole catalogue, so a wrong id costs nothing instead
 * of quietly downloading 18MB.
 *
 * So the shape is: the category lists (78KB, the whole browsing structure) and
 * then the packages somebody opens, at 9-75KB each. A viewer who watches six
 * channels downloads about a megabyte instead of fifty-eight.
 *
 * ── what it costs, honestly ──
 *
 * A catalogue that is partly here cannot answer questions about the part that is
 * not. The unfiltered "all channels" list is the packages that have been
 * downloaded; search finds what is here. That is why this is a CHOICE rather than
 * the default for everyone — the whole library is right for a device that will be
 * browsed and searched, and this is right for a phone that watches six channels.
 */
/*
 * The panel payload belongs to ONE subscription, so its key carries that
 * subscription's id.
 *
 * It used to be this bare string for every account on the device, which is the
 * root of three separate reports: switching account showed the previous one's
 * library, deleting an account left it on screen, and a second subscription
 * overwrote the first one's 159MB so switching back re-downloaded it. One blob,
 * many owners — the id is what makes "whose rows are these" answerable.
 */
const PANEL_KEY_LEGACY = 'payloads.panel';
const panelKey = (id: number): string => `payloads.panel.${id}`;

/**
 * Which provider the catalogue currently on disk was built from.
 *
 * The catalogue is derived state that outlives its source: the provider list can
 * change without anything rebuilding. Recording the owner is what lets every
 * reader ask "is this mine?" instead of assuming — and the answer was `no` for
 * everybody who switched or deleted an account.
 */
const BUILT_FOR_KEY = 'iptv.local.builtFor';

function builtFor(): number | null {
  const raw = kv.get(BUILT_FOR_KEY);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** True when what is on disk was built from an account that is not the one selected. */
function catalogueIsStale(): boolean {
  const active = activeProvider();
  if (active === null) return builtFor() !== null;
  return builtFor() !== active.id;
}

/**
 * Forget everything downloaded for one subscription.
 *
 * Called when it is removed or evicted. Without it a deleted account's whole
 * library stayed in IndexedDB and on screen — the provider vanished from the
 * list and its 159MB of rows kept painting, which reads as "remove does nothing".
 */
export async function forgetAccountData(id: number): Promise<void> {
  try { await blobs().delete(panelKey(id)); } catch { /* nothing stored */ }
  try { await blobs().delete(m3uKey(id)); } catch { /* nothing stored */ }
  try { await blobs().delete(sideKey(id)); } catch { /* nothing stored */ }
  kv.remove(`${FP_KEY}.${id}`);
  if (builtFor() === id) {
    kv.remove(BUILT_FOR_KEY);
    catalogue = null;
    try { await clearCatalogue(blobs()); } catch { /* nothing stored */ }
  }
  await rebuild();
}
const MODE_KEY = 'iptv.local.mode';

export type LibraryMode = 'full' | 'ondemand';

/**
 * Everything by default, rather than a package at a time.
 *
 * The panel publishes no package counts (`fetchPackageCounts`), and a library of
 * packages all reading zero is how a working subscription looks broken. Full
 * mode derives real counts from the rows it holds.
 *
 * It costs ~58MB once, then every question is answered from memory — the right
 * setting for anything that will be browsed and searched, which a television is.
 */
export function libraryMode(): LibraryMode {
  return kv.get(MODE_KEY) === 'ondemand' ? 'ondemand' : 'full';
}

export function setLibraryMode(mode: LibraryMode): void {
  kv.set(MODE_KEY, mode);
}

/**
 * Is this failure the device refusing to KEEP the catalogue, as opposed to the
 * panel refusing to give it?
 *
 * On a plain-HTTP origin, which is not a secure context, `navigator.storage`
 * does not exist at all and IndexedDB runs on a small best-effort quota. A large
 * line — 55,852 channels, 212,686 films and 45,629 series, ~159MB of raw
 * payloads — does not fit. The write aborts.
 *
 * That is not an error to show and stop at. On-demand mode exists for exactly
 * this shape of device: it keeps the structure and only the packages somebody
 * has opened, which is kilobytes rather than megabytes. Falling back to it
 * turns "Catalogue failed" into a working app with a smaller appetite.
 *
 * Matched on the DOM name where there is one, and on the wording this store
 * raises otherwise — `QuotaExceededError` is what a browser calls it, and an
 * abort with no name at all is what several of them actually deliver.
 */
export function isStorageFull(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  if (name === 'QuotaExceededError') return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /would not store this|quota|no space/i.test(msg);
}

/** The panel half of the library, and which packages of it are here. */
interface PanelStore extends RawPayloads {
  /** `<kind>:<provider category id>` for every package downloaded. */
  loaded: string[];
  /**
   * How big each package is, whether or not it has been downloaded.
   *
   * Without this the structure is a list of zeroes — two hundred countries all
   * reading 0, which is how a working library looks broken. The numbers come from
   * the catalogue this installation already ingested for the line, which is one
   * request per section and about 80KB; the CONTENTS still arrive per package.
   */
  counts?: Record<string, number>;
}

const EMPTY_PANEL: PanelStore = {
  live: [], vod: [], series: [],
  liveCategories: [], vodCategories: [], seriesCategories: [], loaded: [], counts: {},
};

async function loadPanel(): Promise<PanelStore | null> {
  try {
    /* Reads a squeezed value or an older plain one — a device that upgrades
       must not lose the catalogue it already holds. */
    const active = activeProvider();
    if (active === null || active.kind !== 'xtream') return null;
    let stored = await blobs().get(panelKey(active.id));
    if (stored === null || stored === undefined) {
      /* Upgrading from the single-key era: the one blob on disk belongs to
         whichever subscription is selected now. Adopted rather than ignored —
         ignoring it would re-download 159MB from an account with one connection. */
      const legacy = await blobs().get(PANEL_KEY_LEGACY);
      if (legacy === null || legacy === undefined) return null;
      await blobs().put(panelKey(active.id), legacy);
      try { await blobs().delete(PANEL_KEY_LEGACY); } catch { /* best effort */ }
      stored = legacy;
    }
    const raw = await unsqueeze(stored);
    if (raw === null || typeof raw !== 'object') return null;
    const p = raw as Partial<PanelStore>;
    if (!Array.isArray(p.liveCategories)) return null;
    return {
      live: Array.isArray(p.live) ? p.live : [],
      vod: Array.isArray(p.vod) ? p.vod : [],
      series: Array.isArray(p.series) ? p.series : [],
      liveCategories: p.liveCategories,
      vodCategories: Array.isArray(p.vodCategories) ? p.vodCategories : [],
      seriesCategories: Array.isArray(p.seriesCategories) ? p.seriesCategories : [],
      loaded: Array.isArray(p.loaded) ? p.loaded.map(String) : [],
      counts: typeof p.counts === 'object' && p.counts !== null ? p.counts : {},
    };
  } catch { return null; }
}

/**
 * Package sizes before the packages are downloaded: there is no source for them.
 */
async function fetchPackageCounts(): Promise<Record<string, number>> {
  /*
   * The panel carries no counts in any category endpoint, and the only way to
   * get one is to download every stream, which is the entire thing on-demand
   * mode exists to avoid.
   *
   * So the honest answer is an empty map, and the UI shows no number rather than
   * a wrong one. `full` mode, which is now the default, derives real counts from
   * the rows it holds; a device that later switches to on-demand inherits those.
   * See `heldOrOffered` in localRead.ts for what a missing count means on screen.
   */
  return {};
}

async function savePanel(p: PanelStore): Promise<void> {
  /* Squeezed on the way in — 151.7MB of panel rows becomes single-figure MB,
     which is the difference between fitting on this origin and not. See
     `lib/squeeze.ts` for why the BUILT catalogue is deliberately left alone. */
  const active = activeProvider();
  if (active === null || active.kind !== 'xtream') return;
  await blobs().put(panelKey(active.id), await squeeze(p));
}

/**
 * One writer at a time.
 *
 * Every path here is read-modify-write across awaited network calls — fetch a
 * package, append it, save — and there are three of them that can overlap: the
 * launch refresh, the weekly check, and a viewer opening a package. Without this
 * they interleave, and the last save wins: thirteen packages were downloaded and
 * then erased by a refresh that had read the store before they existed, which
 * reads as "opening a package downloads nothing".
 *
 * A promise chain rather than a lock, because the operations are already async and
 * the queue is never more than a few deep.
 */
let panelQueue: Promise<unknown> = Promise.resolve();

function withPanel<T>(fn: () => Promise<T>): Promise<T> {
  const next = panelQueue.then(fn, fn);
  /* The chain must not stop at a rejection, or one failed download blocks every
     later one for the life of the page. */
  panelQueue = next.catch(() => undefined);
  return next;
}

/** One small request per list — the whole structure, none of the contents. */
async function fetchCategoryLists(): Promise<Pick<RawPayloads,
  'liveCategories' | 'vodCategories' | 'seriesCategories'>> {
  /* The freshness check just fetched these to hash them. Re-fetching would make
     every refresh pay 78KB twice for no new information. */
  const held = cachedLists;
  if (held !== null && Date.now() - held.at < LIST_TTL_MS) return held.lists;
  const [liveCategories, vodCategories, seriesCategories] = await Promise.all([
    fetchPhase('get_live_categories', () => {}),
    fetchPhase('get_vod_categories', () => {}),
    fetchPhase('get_series_categories', () => {}),
  ]);
  const lists = { liveCategories, vodCategories, seriesCategories };
  cachedLists = { at: Date.now(), lists };
  return lists;
}

/** Which action fetches items for a kind, and where they go. */
const KIND_FETCH: Record<number, { action: string; key: 'live' | 'vod' | 'series' }> = {
  1: { action: 'get_live_streams', key: 'live' },
  2: { action: 'get_vod_streams', key: 'vod' },
  3: { action: 'get_series', key: 'series' },
};

/**
 * Open a subscription without downloading it.
 *
 * The structure only: 1,051 categories in 78KB, which is every package, market and
 * group the app draws its navigation from. Contents arrive per package, when
 * somebody opens one.
 */
export async function openLibrary(): Promise<boolean> {
  if (status.state === 'loading') return false;
  publish({ state: 'loading', phase: 'liveCategories', step: 1, steps: 2, error: null, bytes: 0 });
  return withPanel(async () => {
  try {
    const [lists, counts] = await Promise.all([fetchCategoryLists(), fetchPackageCounts()]);
    const before = await loadPanel();
    await savePanel({
      ...lists,
      live: before?.live ?? [],
      vod: before?.vod ?? [],
      series: before?.series ?? [],
      loaded: before?.loaded ?? [],
      counts,
    });
    kv.set(LOCAL_KEY, 'on');
    setLibraryMode('ondemand');
    await rebuild();
    return true;
  } catch (err) {
    publish({ state: 'error', error: err instanceof Error ? err.message : String(err) });
    return false;
  }
  });
}

/** Packages already on this device, as `<kind>:<provider id>`. */
export async function loadedPackages(): Promise<Set<string>> {
  const p = await loadPanel();
  return new Set(p?.loaded ?? []);
}

/**
 * Download these packages if they are not already here, and nothing else.
 *
 * Sequential on purpose: six parallel requests to a panel that allows one
 * connection is a good way to be rate-limited, and each one takes about a third of
 * a second. Returns how many were actually fetched.
 */
export async function ensurePackages(
  wanted: { kind: number; remoteId: string }[],
): Promise<number> {
  return withPanel(async () => {
  const panel = await loadPanel();
  if (panel === null) return 0;
  const have = new Set(panel.loaded);
  const all = wanted.filter((w) => {
    const key = `${w.kind}:${w.remoteId}`;
    return !have.has(key) && KIND_FETCH[w.kind] !== undefined && /^\d{1,12}$/.test(w.remoteId);
  });
  /*
   * Capped per press.
   *
   * Opening a MARKET can mean ninety-eight packages — measured: the Arabic market
   * is 98 packages, 3,290 channels and 738KB, which is still a fiftieth of the
   * library but takes half a minute one request at a time. So a press fetches a
   * screenful and the rest arrive as somebody keeps looking: the effect on screen
   * is a list that fills rather than a spinner that lasts.
   */
  const todo = all.slice(0, 24);
  if (todo.length === 0) return 0;

  publish({ state: 'loading', phase: 'packages', step: 0, steps: todo.length, error: null, bytes: 0 });
  let done = 0;
  for (const [i, w] of todo.entries()) {
    const spec = KIND_FETCH[w.kind]!;
    try {
      // eslint-disable-next-line no-await-in-loop
      const rows = await fetchPhase(spec.action, () => {}, w.remoteId);
      panel[spec.key] = [...panel[spec.key], ...rows];
      panel.loaded.push(`${w.kind}:${w.remoteId}`);
      done += 1;
    } catch {
      /* One package failing is not a reason to lose the others; it stays
         un-downloaded and can be opened again. */
    }
    publish({ step: i + 1, rows: panel.live.length + panel.vod.length + panel.series.length });
  }
  await savePanel(panel);
  await rebuild();
  return done;
  });
}

/** Throw away the downloaded packages, keeping the structure. */
export async function clearPackages(): Promise<void> {
  return withPanel(async () => {
    const panel = await loadPanel();
    if (panel === null) return;
    await savePanel({ ...panel, live: [], vod: [], series: [], loaded: [] });
    await rebuild();
  });
}

/**
 * A playlist's channels, kept as payloads.
 *
 * An M3U provider's catalogue is built on the device from its playlist
 * (`lib/m3uCatalogue.ts`) and kept as the same payload shape the panel's
 * endpoints return, one blob per provider, so a rebuild needs no network and
 * switching between accounts never re-downloads a playlist.
 */
const m3uKey = (id: number): string => `payloads.m3u.${id}`;

/** Sources whose catalogue is built on the device and kept as one payload blob. */
function keepsOwnPayloads(kind: ProviderKind): boolean {
  return isPlaylistKind(kind) || kind === 'stalker';
}

/** The side map (play-time headers, portal ids) for the source in use, into memory. */
async function loadSide(id: number | null): Promise<void> {
  if (id === null) { setSide(null); return; }
  try { setSide(toSide(await blobs().get(sideKey(id)))); } catch { setSide(null); }
}

async function saveSide(id: number, side: SideMap): Promise<void> {
  await blobs().put(sideKey(id), side);
}

async function loadM3uPayloads(id: number): Promise<RawPayloads | null> {
  try {
    const raw = await blobs().get(m3uKey(id));
    if (raw === null || typeof raw !== 'object') return null;
    const p = raw as Partial<RawPayloads>;
    if (!Array.isArray(p.live)) return null;
    return {
      live: p.live,
      vod: Array.isArray(p.vod) ? p.vod : [],
      series: Array.isArray(p.series) ? p.series : [],
      liveCategories: Array.isArray(p.liveCategories) ? p.liveCategories : [],
      vodCategories: Array.isArray(p.vodCategories) ? p.vodCategories : [],
      seriesCategories: Array.isArray(p.seriesCategories) ? p.seriesCategories : [],
    };
  } catch { return null; }
}

/** Merge two payload sets. Order matters only for `sortIndex`, which is per kind. */
export function mergePayloads(a: RawPayloads | null, b: RawPayloads | null): RawPayloads {
  const empty: RawPayloads = {
    live: [], vod: [], series: [], liveCategories: [], vodCategories: [], seriesCategories: [],
  };
  const x = a ?? empty;
  const y = b ?? empty;
  return {
    live: [...x.live, ...y.live],
    vod: [...x.vod, ...y.vod],
    series: [...x.series, ...y.series],
    liveCategories: [...x.liveCategories, ...y.liveCategories],
    vodCategories: [...x.vodCategories, ...y.vodCategories],
    seriesCategories: [...x.seriesCategories, ...y.seriesCategories],
  };
}

/**
 * A source has just been attached to this device — fold it in.
 *
 * Every device downloads, and the only question is how much of it at once. The
 * panel's catalogue may still be building when this runs — a first sign-in
 * starts an ingest that takes minutes — in which case the rebuild simply finds no
 * generation yet and the next launch picks it up (see `weeklyCheck`).
 *
 * Only a panel has a structure to open on; a playlist is one download.
 */
export async function attachSubscription(): Promise<void> {
  kv.set(LOCAL_KEY, 'on');
  /*
   * The structure, not the contents.
   *
   * Signing in used to start a 58MB download on the spot, which is a strange
   * thing to do to somebody who has just typed a password on a phone — and most
   * of it is packages they will never open. 78KB gets the whole library
   * navigable; a package downloads when it is opened. `full` is a choice in
   * Settings for a device that would rather have everything.
   */
  if (libraryMode() === 'ondemand' && activeProvider()?.kind === 'xtream') await openLibrary();
  else await refreshLocal();
}

export async function initLocal(): Promise<void> {
  if (!localEnabled()) return;
  try {
    /* A copy built for an account that is no longer the selected one is not
       shown at all — it is rebuilt from whatever this account does hold. Reading
       it back on launch is how a removed subscription survived a restart. */
    const stored = catalogueIsStale() ? null : await loadCatalogue(blobs());
    if (stored) {
      await loadSide(activeProvider()?.id ?? null);
      catalogue = stored;
      /* A stored copy keeps the number it was saved with, which another source's
         copy may share: renumber it past anything this session has held. */
      if (stored.generation <= highestGeneration) {
        (stored as { generation: number }).generation = highestGeneration + 1;
      }
      highestGeneration = stored.generation;
      publish({
        state: 'ready', builtAt: stored.builtAt, rows: stored.items.count, phase: null,
        generation: storedGeneration(),
      });
      /* Not awaited, and deliberately after the stored copy is already in hand:
         the app opens on what is here, and the check happens behind it. */
      void weeklyCheck();
      return;
    }
  } catch (err) {
    // A corrupt or evicted store is a reason to rebuild, not to stop. Eviction is
    // a real event on the web: `navigator.storage.persist()` was DENIED in
    // testing, so the browser may drop this at any time.
    publish({ error: err instanceof Error ? err.message : String(err) });
  }
  /*
   * Not awaited.
   *
   * A first run has 58MB to fetch, and holding the first paint for it would mean
   * a blank window for the length of the download. The UI renders, shows the
   * progress, and fills in as the catalogue arrives — every list is already
   * written to cope with having no data yet, because that is also what a slow
   * panel looks like.
   */
  void refreshLocal();
}

/**
 * Build the catalogue from what is already on this device — no network at all.
 *
 * The active source's payloads go through here: whichever panel packages have
 * been downloaded, or the playlist's channels. It is called after every change
 * to either.
 *
 * The build itself is cheap — 124,157 rows measured at 14ms — so rebuilding on
 * every package is affordable and merging built columns is not worth inventing.
 */
async function rebuild(): Promise<void> {
  /*
   * One account at a time. The payloads of the others stay on disk so switching
   * back does not re-download, but they must not keep painting rows under the
   * selected account's name.
   */
  const active = activeProvider();
  const panel = (active !== null && active.kind === 'xtream')
    ? await loadPanel()
    : null;
  const m3u = (active !== null && keepsOwnPayloads(active.kind))
    ? await loadM3uPayloads(active.id)
    : null;
  await loadSide(active?.id ?? null);
  if (m3u === null && panel === null) {
    /*
     * Nothing to build from means an EMPTY library, not the previous one.
     *
     * Selecting an account this device holds no payload for must not leave the
     * last account's rows rendered, its categories in the sidebar and its blob on
     * disk. Showing one subscription's library under another's name is worse than
     * showing none.
     */
    catalogue = null;
    kv.remove(BUILT_FOR_KEY);
    try { await clearCatalogue(blobs()); } catch { /* nothing stored */ }
    publish({ state: 'idle', phase: null, step: 0, bytes: 0, rows: 0, error: null, builtAt: null });
    return;
  }
  publish({ phase: 'store' });
  const built = buildCatalogue(mergePayloads(panel, m3u), {
    generation: Math.max(catalogue?.generation ?? 0, highestGeneration) + 1,
    now: Date.now(),
    ...(panel?.counts ? { counts: panel.counts } : {}),
  });
  await saveCatalogue(blobs(), built);
  catalogue = built;
  highestGeneration = built.generation;
  /* Stamped with its owner so every later reader can tell whether it is looking
     at its own account's library — see `catalogueIsStale`. */
  if (active === null) kv.remove(BUILT_FOR_KEY);
  else kv.set(BUILT_FOR_KEY, String(active.id));
  publish({
    state: 'ready', phase: null, rows: built.items.count, builtAt: built.builtAt, error: null,
  });
}

/**
 * Fetch from the panel: everything, or a refresh of what is already here.
 *
 * `full` is the right one for a device that will be browsed and searched — 58MB
 * once, and then every question answered from memory. `ondemand` re-reads the structure and the packages this device
 * actually holds, which in the ordinary case is a few hundred KB.
 *
 * An installation nobody has signed into skips the network entirely: no active
 * source IS "there is no panel here", and this software ships with none.
 *
 * Safe to call again after a failure.
 */
/**
 * At most one refresh running, and at most one waiting behind it.
 *
 * This used to return immediately when `status.state === 'loading'`, which reads
 * as "one at a time" and is not: the caller's refresh was DROPPED, not deferred.
 * The failure was intermittent and total — signing in starts a refresh, and if the
 * launch check happened to still be running, the subscription's catalogue was
 * never downloaded at all. Sign-in reported success, the badge appeared, and the
 * library stayed empty until something else happened to trigger a pull.
 *
 * Dropping is never right here because the refreshes are not equivalent: the one
 * that was already running started before there was a subscription and would
 * answer for a device that had none. So a second request queues, and when it runs
 * it re-reads the state as it is by then. One slot, because a third request would
 * ask exactly the same question as the second.
 */
let refreshRunning: Promise<void> | null = null;
let refreshQueued: Promise<void> | null = null;

/**
 * Change which subscription the app is showing.
 *
 * Rebuilds from what this device already holds, and downloads only when it holds
 * nothing for that account. Calling `refreshLocal` unconditionally would
 * re-fetch ~159MB from a line that allows ONE connection every time somebody
 * looked at their other account — and leave the library empty on screen for the
 * ~40 seconds it took.
 *
 * Affordable only because the payload is per-account now; under one shared key
 * there was nothing to come back to. The rebuild itself is no-network and was
 * measured at 14ms for 124,157 rows.
 *
 * Freshness is deliberately left to `weeklyCheck`, which is where it already
 * lived. Switching accounts is not evidence that a catalogue has changed.
 */
export async function switchToAccount(): Promise<void> {
  const active = activeProvider();
  if (active !== null && active.kind === 'xtream') {
    const held = await blobs().get(panelKey(active.id));
    if (held !== null && held !== undefined) {
      publish({ state: 'loading', error: null, phase: 'store', step: 0, steps: 1, bytes: 0 });
      await rebuild();
      return;
    }
  }
  if (active !== null && keepsOwnPayloads(active.kind)) {
    const held = await blobs().get(m3uKey(active.id));
    if (held !== null && held !== undefined) {
      publish({ state: 'loading', error: null, phase: 'store', step: 0, steps: 1, bytes: 0 });
      await rebuild();
      return;
    }
  }
  await refreshLocal();
}

export function refreshLocal(): Promise<void> {
  if (refreshRunning === null) {
    refreshRunning = doRefreshLocal().finally(() => { refreshRunning = null; });
    return refreshRunning;
  }
  if (refreshQueued === null) {
    refreshQueued = refreshRunning
      .catch(() => undefined)
      .then(() => { refreshQueued = null; return refreshLocal(); });
  }
  return refreshQueued;
}

async function doRefreshLocal(): Promise<void> {
  publish({ state: 'loading', error: null, bytes: 0, step: 0, phase: null });

  /*
   * Drop another account's library BEFORE the download, not after it.
   *
   * A full refresh is ~40 seconds against this line. Leaving the old catalogue
   * resident for those 40 seconds is what made switching feel like it did
   * nothing at all — the name in ACCOUNTS changed and every row on screen stayed
   * put, with no way to tell a slow switch from a broken one. Empty and filling
   * is honest; full and wrong is not.
   */
  if (catalogueIsStale()) {
    catalogue = null;
    kv.remove(BUILT_FOR_KEY);
    try { await clearCatalogue(blobs()); } catch { /* nothing stored */ }
    publish({ rows: 0, builtAt: null });
  }

  return withPanel(async () => {
  let carried = 0;
  try {
    const active = activeProvider();
    const hasPanel = active !== null && active.kind === 'xtream' && panelClient() !== null;
    if (active !== null && active.kind === 'stream') {
      /* One address: nothing to download, the channel is built from the link. */
      publish({ phase: 'saving', step: 1, steps: 1 });
      await blobs().put(m3uKey(active.id), streamPayloads(active.url, active.name));
    } else if (active !== null && active.kind === 'm3u') {
      /* A playlist is one download, parsed and stored on the device. */
      publish({ phase: 'live', step: 1, steps: 2 });
      const res = await loadM3uCatalogue(active.url, {
        ...(active.epgUrl === undefined ? {} : { epgUrl: active.epgUrl }),
        onProgress: (p) => publish({ rows: p.entries, bytes: p.bytes }),
      });
      await blobs().put(m3uKey(active.id), res.payloads);
      await saveSide(active.id, res.side);
      /* The playlist's own header may name the guide (`url-tvg`); kept beside the
         address the viewer typed, which always wins. */
      if (res.headerGuideUrls.join('\n') !== (active.headerGuideUrls ?? []).join('\n')) {
        updateProvider(active.id, { headerGuideUrls: res.headerGuideUrls });
      }
      publish({ phase: 'saving', step: 2 });
    }
    else if (active !== null && active.kind === 'stalker') {
      /* A portal is read page by page through the native HTTP layer. */
      publish({ phase: 'live', step: 1, steps: 2 });
      const res = await withStalker((c) => loadStalkerCatalogue(c, {
        onProgress: (p) => publish({ rows: p.rows }),
      }), active.id);
      await blobs().put(m3uKey(active.id), res.payloads);
      await saveSide(active.id, res.side);
      if (res.truncated) dlog.info('catalogue', 'the portal list was cut at the size limit');
      publish({ phase: 'saving', step: 2 });
    }
    if (hasPanel) {
      if (libraryMode() === 'full') {
        /* The three category lists come from `fetchCategoryLists`, which returns
           the copy the freshness check just fetched to hash. Calling `fetchPhase`
           for them directly re-downloaded all three every refresh — three round
           trips against an account with one connection, for bytes already in
           hand. */
        const lists = await fetchCategoryLists();
        const panel: PanelStore = { ...EMPTY_PANEL, ...lists, loaded: ['*'] };
        publish({ steps: STREAM_PHASES.length + 1 });
        for (const [i, phase] of STREAM_PHASES.entries()) {
          publish({ phase: phase.id, step: i + 1 });
          const rows = await fetchPhase(phase.action, (n) => publish({ bytes: carried + n }));
          carried = status.bytes;
          panel[phase.key] = rows;
          publish({ rows: rows.length });
        }
        /*
         * Say what is happening between the last byte and the first row.
         *
         * The bar used to go on reading "Series (3/4)" through the save AND the
         * build, because the next `publish` was inside `rebuild`. So a stall
         * anywhere in those two steps looked identical to a stall in the series
         * DOWNLOAD — which sent a day of diagnosis at the network when the
         * network had already finished. A step that cannot be seen cannot be
         * blamed.
         */
        publish({ phase: 'saving', step: STREAM_PHASES.length + 1 });
        await savePanel(panel);
        /* Drop the raw stream arrays before rebuild reloads them from IDB —
           otherwise this closure and loadPanel() both hold ~tens of MB of the
           same JSON at once (fatal on a low-RAM WebView). */
        panel.live = [];
        panel.vod = [];
        panel.series = [];
      } else {
        /* On demand: the structure, and a re-read of the packages held here. A
           package that has gone from the panel simply comes back empty and is
           dropped, which is the correct answer to "it is not there any more". */
        const before = await loadPanel();
        const [lists, counts] = await Promise.all([fetchCategoryLists(), fetchPackageCounts()]);
        const panel: PanelStore = { ...EMPTY_PANEL, ...lists, loaded: [], counts };
        const want = before?.loaded ?? [];
        publish({ steps: want.length + 1, step: 1 });
        for (const [i, key] of want.entries()) {
          const [kind, remoteId] = key.split(':');
          const spec = KIND_FETCH[Number(kind)];
          if (spec === undefined || remoteId === undefined) continue;
          const rows = await fetchPhase(spec.action, () => {}, remoteId);
          panel[spec.key] = [...panel[spec.key], ...rows];
          panel.loaded.push(key);
          publish({ step: i + 2, rows: panel.live.length + panel.vod.length + panel.series.length });
        }
        await savePanel(panel);
        panel.live = [];
        panel.vod = [];
        panel.series = [];
      }
    }

    await rebuild();
    /* Recorded only after the store write succeeded. Writing it first would mean a
       failed save leaves the device claiming to hold a generation it does not
       have, and the weekly check would then never download it. */
    /* Recorded together and only now: the fingerprint says "this is the panel
       catalogue we hold", the counter says "this is the nth build of it". Written
       after the store write for the reason above — a device that claims a
       fingerprint it never stored will never download it. */
    if (hasPanel) {
      const fp = await panelFingerprint();
      if (fp !== null) kv.set(fpKey(), fp);
    }
    const gen2 = (storedGeneration() ?? 0) + 1;
    kv.set(GEN_KEY, String(gen2));
    // Same reasoning as the generation: only once the store write has succeeded.
    kv.set(RULES_KEY, String(CATALOGUE_RULES_VERSION));
    kv.set(CHECKED_KEY, String(Date.now()));
    publish({ generation: gen2 });
  } catch (err) {
    /*
     * The device would not keep it — so ask for less, rather than for nothing.
     *
     * Full mode holds every row; on-demand holds the structure and only the
     * packages somebody opens. A browser that cannot store 159MB can store
     * that comfortably, and the viewer gets a working library instead of a
     * failure they can do nothing about. Once only: if the smaller shape will
     * not fit either, the error is real and belongs on screen.
     */
    if (isStorageFull(err) && libraryMode() === 'full') {
      dlog.info('catalogue', 'this browser will not store the whole library — switching to on-demand');
      setLibraryMode('ondemand');
      publish({ state: 'loading', phase: null, error: null, step: 0, bytes: 0 });
      await refreshLocal();
      return;
    }
    /* If the host is what failed, stop trusting it — otherwise the remembered
       host stays selected for an hour and every retry goes back to the one that
       just broke. `notePanelFailure` decides; a flood status or a credential
       problem is left alone, because neither is the host's fault. */
    notePanelFailure(err);
    const said = activeProvider()?.kind === 'stalker' ? stalkerMessage(err) : null;
    /* On screen AND in the log: a library that would not build is the first
       thing to know about a television that "shows nothing", and it used to
       exist only in a bar the viewer may never have read out to anyone. */
    dlog.error('catalogue', `the library could not be built — ${err instanceof Error ? err.message : String(err)}`);
    publish({ state: 'error', error: said ?? (err instanceof Error ? err.message : String(err)) });
  }
  });
}

/**
 * The channel list again, between the weekly checks — names change daily.
 *
 * The weekly check downloads the lists again only when the panel's CATEGORY
 * lists hash differently. A PPV or event feed keeps its category and changes its
 * NAME every day to the event it is carrying — so a Football list could show
 * yesterday's snooker and tennis events on `FR: SOCCER PPV` feeds, while the
 * guide beside them was twelve hours old at most.
 *
 * So the live half is fetched on its own, every LIVE_REFRESH_MS: the live
 * categories and `get_live_streams` — two requests, about 3.6 MB of JSON on a
 * large line, where the whole library is sixty — spliced into the stored copy
 * in place of the old live rows, and the catalogue rebuilt from it on the device.
 * Films and series, and their categories, are untouched.
 *
 * Quiet by design: no loading state and no progress bar, because nothing on
 * screen is being replaced by nothing. The caller decides when (main.tsx waits
 * for the library to be ready and for nothing to be playing — the rebuild holds
 * the page for a moment on a slow television).
 */
/* Daily: the full re-read is what brings channels that are genuinely NEW. The
   renames it used to be run for are `lib/liveNames.ts`'s now, every half hour
   on Sports TV, without rebuilding anything. */
export const LIVE_REFRESH_MS = 24 * 3600_000;

/**
 * The panel's channel list as it is right now, on the same queue as every other
 * panel read — for `lib/liveNames.ts`, which only compares names and stores none
 * of this.
 */
export function fetchLiveListNow(): Promise<unknown[]> {
  return withPanel(() => fetchPhase('get_live_streams', () => {}));
}

/** Whether this device holds a whole library it could compare names against. */
export function canCompareLiveNames(): boolean {
  if (!localEnabled() || libraryMode() !== 'full' || status.state !== 'ready' || refreshRunning !== null) return false;
  const active = activeProvider();
  return active !== null && active.kind === 'xtream' && panelClient() !== null && !catalogueIsStale();
}
const liveAtKey = (): string => `iptv.local.liveAt.${activeProvider()?.id ?? 0}`;

export async function refreshLiveList(now = Date.now()): Promise<boolean> {
  if (!localEnabled() || libraryMode() !== 'full') return false;
  if (status.state !== 'ready' || refreshRunning !== null) return false;
  const active = activeProvider();
  if (active === null || active.kind !== 'xtream' || panelClient() === null) return false;
  if (catalogueIsStale()) return false;
  const raw = Number(kv.get(liveAtKey()) ?? 0);
  /* Never asked before: count from the last full download, which fetched the
     same list. */
  const last = Number.isFinite(raw) && raw > 0 ? raw : (status.builtAt ?? 0);
  if (now - last < LIVE_REFRESH_MS) return false;
  return withPanel(async () => {
    /* Stamped first: a line that fails this is asked again next time round,
       not in a loop. */
    kv.set(liveAtKey(), String(now));
    try {
      const [liveCategories, live] = [
        await fetchPhase('get_live_categories', () => {}),
        await fetchPhase('get_live_streams', () => {}),
      ];
      const before = await loadPanel();
      if (before === null || before.live.length === 0) return false;
      /* A panel that answers with a fraction of the list is having a bad
         minute, not a new line-up — keep what is here. */
      if (live.length === 0 || live.length < before.live.length * 0.5) {
        dlog.warn('catalogue', `channel list refresh skipped — the panel sent ${live.length} of ${before.live.length}`);
        return false;
      }
      await savePanel({ ...before, liveCategories, live });
      before.vod = [];
      before.series = [];
      before.live = [];
      if (refreshRunning !== null || catalogueIsStale()) return false;
      await rebuild();
      const gen = (storedGeneration() ?? 0) + 1;
      kv.set(GEN_KEY, String(gen));
      publish({ generation: gen });
      dlog.info('catalogue', `channel list refreshed: ${live.length} channels`);
      return true;
    } catch (err) {
      dlog.warn('catalogue', `channel list refresh failed — ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  });
}

/** Ask for persistence, and report honestly when it is refused. */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
