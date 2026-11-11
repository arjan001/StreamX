/**
 * Searching what is ON TV, not what is in the catalogue.
 *
 * Asked for as two sentences from a partner testing the app: "in Live you might
 * want to search for the name of a channel, but at another moment for a specific
 * programme that is broadcast on TV", and "search on channel name and EPG
 * content". The channel-name half already existed — that is the Live chip. This
 * file is the second half: a programme TITLE, found in the guide listings the
 * device already holds.
 *
 * ── why this is not a second `core-store` search engine ──
 *
 * `packages/core-store/src/search.ts` exists because the catalogue is hundreds of
 * thousands of rows and has to answer a keystroke out of that. A device's cached
 * guide is nothing like that size — at most 400 channels (`MAX_CHANNELS` in
 * `localEpg.ts`) and, once the window below has thrown out everything outside it,
 * a handful of programmes each. So this file borrows the one piece of the
 * catalogue engine that still earns its cost at this size — `searchKey`'s fold, so
 * "florentina" finds a title however its accents were typed — and skips the rest:
 * no dictionary, no fuzzy correction, no candidate-row blob sweep. A plain array
 * of folded titles is fast enough at this size, and simple enough to read in one
 * sitting.
 *
 * ── the two halves, and why they are split ──
 *
 * `rankProgrammes` is pure: given a flat list of (channel, programme) candidates
 * already sitting in memory, fold the query, keep what matches, rank it, cap it.
 * Nothing here touches IndexedDB, the clock's own `Date.now()`, or React — `nowS`
 * arrives as an argument, exactly as `guide.ts` insists on throughout. That is
 * what makes it testable with hand-built fixtures and no browser, the same
 * discipline `searchScope.ts` and `guide.ts` both write about at length.
 *
 * `ensureEpgIndex` is the impure other half: it reads `localEpg.ts`'s cache and
 * the on-device catalogue, builds the candidate list ONCE, and holds it — see its
 * own comment for the window that keeps that list small and the reasons a
 * keystroke must never rebuild it.
 */
import {
  DAY, HOUR, clockOf, guideMaxTs, isPlayable, slotState,
} from './guide.ts';
import { cachedGuides } from './localEpg.ts';
import { localAllItems } from './localRead.ts';
import { searchKey } from '@iptv/core-xtream';

/* ── the shapes this file needs, and nothing it does not ──────────────────────
 *
 * Structural, like `searchScope.ts`'s `ScopedHit` — the tests build these by
 * hand, and a fixture importing the whole `Item` shape from `lib/api.ts` would be
 * a fixture nobody wants to update when an unrelated field is added to it.
 */

export interface EpgSearchChannel {
  /** Catalogue row id — the `/guide?ch=` fallback form; see `refOf`. */
  id: number;
  /** The refresh-proof `<kind>.<provider id>` form, when the row has one. */
  ref: string | null;
  /** Provider id. What `localEpg.ts` keys its cache by, and what favourites use. */
  streamId: number;
  name: string;
  logo: string | null;
  archive: boolean;
  archiveDays: number;
}

/** A listing, exactly as `guide.ts#Slot` and `core-store#Slot` both shape one. */
export interface EpgSearchSlot {
  title: string | null;
  description: string | null;
  startTs: number;
  stopTs: number | null;
  hasArchive?: boolean;
}

export interface ProgrammeCandidate {
  channel: EpgSearchChannel;
  slot: EpgSearchSlot;
}

/** What the result row marks: on air now, playable from the archive, or neither. */
export type ProgrammeState = 'live' | 'catchup' | null;

export interface ProgrammeHit {
  streamId: number;
  channelName: string;
  channelLogo: string | null;
  title: string;
  startTs: number;
  stopTs: number | null;
  state: ProgrammeState;
  favourite: boolean;
  /** "Today 20:30", "Tomorrow 09:00", "Yesterday 21:10". */
  when: string;
  /** Live -> the channel; catch-up -> that recording; later -> the guide. */
  href: string;
}

/* ── the window: which programmes are even candidates ──────────────────────── */

/**
 * Is this programme in scope at all, whatever the query says?
 *
 * Two rules, reusing `guide.ts` rather than restating it:
 *
 *   - not yet finished: admitted up to the end of tomorrow, `guideMaxTs` — the
 *     same ceiling the guide itself will not scroll past, for the same reason
 *     ("nothing here can ever be set to record").
 *   - already finished: admitted only when `isPlayable` says the channel's own
 *     catch-up window still reaches it. A channel with no archive contributes no
 *     past programmes at all, which is `isPlayable`'s first line, not a second
 *     check written here.
 *
 * A slot currently ON AIR passes the first branch unconditionally — its `startTs`
 * is at or before `nowS`, which is always inside the ceiling — so `live` needs no
 * case of its own here.
 */
export function admitCandidate(
  slot: EpgSearchSlot,
  channel: { archive: boolean; archiveDays: number },
  nowS: number,
): boolean {
  if (slot.title === null || slot.title.trim() === '') return false;
  if (slotState(slot, nowS) === 'past') return isPlayable(slot, channel, nowS);
  return slot.startTs <= guideMaxTs(nowS);
}

/** The state mark a row would carry right now. Never called on a slot that
 *  `admitCandidate` rejected — a rejected past slot has no honest state to show. */
export function programmeState(
  slot: EpgSearchSlot,
  channel: { archive: boolean; archiveDays: number },
  nowS: number,
): ProgrammeState {
  const state = slotState(slot, nowS);
  if (state === 'live') return 'live';
  if (state === 'past') return isPlayable(slot, channel, nowS) ? 'catchup' : null;
  return null;
}

/* ── the day/time label ────────────────────────────────────────────────────── */

/** Local midnight, epoch seconds. The same boundary `guide.ts#dayChips` counts
 *  from — kept here rather than imported because `guide.ts` does not export it,
 *  and it is four lines. */
function localMidnightS(ts: number): number {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** "Today", "Yesterday", "Tomorrow", or a short weekday for anything further —
 *  the exact wording `dayChips` uses, for a single timestamp rather than a strip
 *  of chips. */
export function dayLabel(ts: number, nowS: number): string {
  const diffDays = Math.round((localMidnightS(ts) - localMidnightS(nowS)) / DAY);
  if (diffDays === 0) return 'Today';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays === 1) return 'Tomorrow';
  return new Date(ts * 1000).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "Today 20:30". */
export function whenLabel(ts: number, nowS: number): string {
  return `${dayLabel(ts, nowS)} ${clockOf(ts)}`;
}

/* ── matching ───────────────────────────────────────────────────────────────── */

/**
 * How well a title answers a query, ladder style like `core-store`'s `EVIDENCE`
 * but three rungs rather than eight — a guide has nothing like a cast column, and
 * nothing here claims to correct a typo.
 *
 *   3  EXACT      the folded title and the folded query are the same string.
 *   2  PREFIX      the title begins with the query.
 *   1  SUBSTRING   every word of the query is somewhere in the title, in any
 *                  order — "verraders de" finds "De Verraders" for the same
 *                  reason `core-store`'s tokeniser does not require adjacency.
 *   0  no match.
 *
 * Folded with `searchKey`, the same accent/case fold `lib/liveRows.ts` uses for
 * the channel-name chip, so "florentina" finds a title however its accents were
 * typed and a search that already works for channel names works the same way
 * here.
 */
export function matchTier(title: string | null, query: string): 0 | 1 | 2 | 3 {
  const foldedQuery = searchKey(query);
  if (foldedQuery === '') return 0;
  const foldedTitle = searchKey(title);
  if (foldedTitle === '') return 0;
  if (foldedTitle === foldedQuery) return 3;
  if (foldedTitle.startsWith(foldedQuery)) return 2;
  const tokens = foldedQuery.split(' ').filter((t) => t !== '');
  return tokens.length > 0 && tokens.every((t) => foldedTitle.includes(t)) ? 1 : 0;
}

/* ── ranking ────────────────────────────────────────────────────────────────── */

/** However generous the cache, a remote shows a screenful. Same order of
 *  magnitude as `CORRECTION_FLOOR`'s companion caps in `core-store`. */
export const RESULT_CAP = 60;

function refOf(channel: EpgSearchChannel): string {
  return channel.ref ?? String(channel.id);
}

/**
 * Where OK/click on this row goes.
 *
 * Now airing opens the channel live; a finished, still-covered programme opens
 * catch-up at exactly that slot (`start`/`stop`, the param names `Catchup.tsx`
 * reads); anything later has nothing to play yet, so it opens the guide on that
 * channel instead. `linkId`'s own formula (`ref ?? String(id)`), not an import of
 * it — see the file header on why this module does not reach into `lib/api.ts`.
 */
function hrefFor(channel: EpgSearchChannel, slot: EpgSearchSlot, state: ProgrammeState): string {
  const ref = refOf(channel);
  if (state === 'live') return `/live?ch=${ref}`;
  if (state === 'catchup') {
    const stop = slot.stopTs ?? slot.startTs + HOUR;
    return `/catchup?ch=${ref}&start=${slot.startTs}&stop=${stop}`;
  }
  return `/guide?ch=${ref}`;
}

interface Scored {
  candidate: ProgrammeCandidate;
  tier: 1 | 2 | 3;
  live: boolean;
  distance: number;
  favourite: boolean;
}

/**
 * Best first: favourite channels, then whatever is on air right now, then
 * whichever of the rest is closest to this minute — a programme starting in ten
 * minutes and one that finished ten minutes ago are equally "soon" by that
 * measure, which is deliberate: both are the programme somebody is most likely to
 * mean right now. Match strength and a deterministic tail settle the remaining
 * ties, for the same reason `core-store#compareHits` ends in a row index — one
 * query has to mean one order, not "order, until two rows tie".
 *
 * This is the ranking the partner asked for in exactly the words given: "the
 * viewer's favourite channels first, then now-airing, then soonest", with the
 * match-strength and fold rules layered on after.
 */
function compareScored(a: Scored, b: Scored): number {
  if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
  if (a.live !== b.live) return a.live ? -1 : 1;
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.tier !== b.tier) return b.tier - a.tier;
  const an = a.candidate.channel.name;
  const bn = b.candidate.channel.name;
  if (an !== bn) return an < bn ? -1 : 1;
  const at = a.candidate.slot.title ?? '';
  const bt = b.candidate.slot.title ?? '';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.candidate.slot.startTs - b.candidate.slot.startTs
    || a.candidate.channel.streamId - b.candidate.channel.streamId;
}

/**
 * Search a prebuilt candidate list. Pure and synchronous — see the file header
 * for why building that list is a separate, async, memoised step.
 *
 * `admitCandidate` runs again here, on top of whatever `ensureEpgIndex` already
 * filtered the list down to. That looks redundant and is not: the index is built
 * once and held, but `nowS` moves every minute the search screen stays open — a
 * programme that was "later" when the index was built can have finished by the
 * time somebody actually types its name, and a channel with a short archive can
 * age a candidate out of catch-up entirely. Re-admitting the SURVIVORS of the
 * text match (a small set) against the CURRENT clock is cheap; re-admitting the
 * whole cache on every keystroke is exactly what building the index once exists
 * to avoid.
 */
export function rankProgrammes(
  candidates: readonly ProgrammeCandidate[],
  query: string,
  nowS: number,
  favouriteStreamIds: ReadonlySet<number>,
  limit: number = RESULT_CAP,
): ProgrammeHit[] {
  const foldedQuery = searchKey(query);
  if (foldedQuery === '') return [];

  const scored: Scored[] = [];
  for (const candidate of candidates) {
    const tier = matchTier(candidate.slot.title, query);
    if (tier === 0) continue;
    if (!admitCandidate(candidate.slot, candidate.channel, nowS)) continue;
    scored.push({
      candidate,
      tier,
      live: slotState(candidate.slot, nowS) === 'live',
      distance: Math.abs(candidate.slot.startTs - nowS),
      favourite: favouriteStreamIds.has(candidate.channel.streamId),
    });
  }
  scored.sort(compareScored);

  return scored.slice(0, limit).map(({ candidate, favourite }): ProgrammeHit => {
    const state = programmeState(candidate.slot, candidate.channel, nowS);
    return {
      streamId: candidate.channel.streamId,
      channelName: candidate.channel.name,
      channelLogo: candidate.channel.logo,
      title: candidate.slot.title ?? '',
      startTs: candidate.slot.startTs,
      stopTs: candidate.slot.stopTs,
      state,
      favourite,
      when: whenLabel(candidate.slot.startTs, nowS),
      href: hrefFor(candidate.channel, candidate.slot, state),
    };
  });
}

/* ── the index: gathering candidates from the cache, once ─────────────────────
 *
 * Everything below is impure — IndexedDB through `localEpg.ts`, the in-memory
 * catalogue through `localRead.ts` — and none of it is exercised by
 * `epgSearch.test.ts`, which sticks to the pure half above.
 */

export interface EpgSearchIndex {
  candidates: readonly ProgrammeCandidate[];
  builtAt: number;
}

const EMPTY_INDEX: EpgSearchIndex = { candidates: [], builtAt: 0 };

/**
 * How long a built index is trusted before the next Search visit rebuilds it.
 *
 * There is no generation counter for the guide cache the way there is for the
 * catalogue (`ensureSearchIndex`) — channels get fetched one at a time, in the
 * background, on nobody's schedule in particular. Five minutes is short enough
 * that a channel filled in while the app sat on another screen shows up next time
 * search is opened, and long enough that reopening Search right after closing it
 * costs nothing.
 */
const REBUILD_AFTER_MS = 5 * 60_000;

/** How many channels' listings to fold and filter before handing the thread
 *  back. See `cachedGuides`'s own batch, which this mirrors on the CPU side of
 *  the same loop — that one bounds concurrent IndexedDB reads, this one bounds
 *  synchronous work between them. */
const BUILD_CHUNK = 40;

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void;
    }).requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 0);
  });
}

let indexPromise: Promise<EpgSearchIndex> | null = null;
let builtAtMs = 0;

async function buildEpgIndex(): Promise<EpgSearchIndex> {
  const nowS = Math.floor(Date.now() / 1000);
  let guides: { streamId: number; slots: EpgSearchSlot[] }[];
  try {
    guides = await cachedGuides();
  } catch {
    return { candidates: [], builtAt: nowS };
  }
  if (guides.length === 0) return { candidates: [], builtAt: nowS };

  /* One batched catalogue read rather than one per channel — `localAllItems` is
     synchronous and unclamped (unlike `localItems`'s 200-row page), and this is
     exactly the "which of these" question `streamIds` exists to answer cheaply. */
  const items = localAllItems('live', { streamIds: guides.map((g) => g.streamId) });
  const byStream = new Map<number, EpgSearchChannel>();
  for (const it of items) {
    if (it.streamId === null) continue;
    byStream.set(it.streamId, {
      id: it.id, ref: it.ref, streamId: it.streamId, name: it.name, logo: it.logo,
      archive: it.archive, archiveDays: it.archiveDays,
    });
  }

  const candidates: ProgrammeCandidate[] = [];
  let sinceYield = 0;
  for (const g of guides) {
    const channel = byStream.get(g.streamId);
    if (channel !== undefined) {
      for (const slot of g.slots) {
        if (admitCandidate(slot, channel, nowS)) candidates.push({ channel, slot });
      }
    }
    sinceYield += 1;
    if (sinceYield >= BUILD_CHUNK) {
      sinceYield = 0;
      // eslint-disable-next-line no-await-in-loop -- deliberate: hand the thread back between chunks.
      await yieldToMain();
    }
  }
  return { candidates, builtAt: nowS };
}

/**
 * Build once and hold it, or hand back the build already under way.
 *
 * Safe to call on every render of the search screen the way `ensureSearchIndex`
 * is: a fresh promise is only started when none is in flight and the last one is
 * older than `REBUILD_AFTER_MS`. `force` is for a caller that knows the cache
 * just changed — nothing in this app currently calls it that way, but a bare
 * `ensureEpgIndex()` on every mount is the "once per Search visit" the feature
 * asks for.
 */
export function ensureEpgIndex(force = false): Promise<EpgSearchIndex> {
  if (!force && indexPromise !== null && Date.now() - builtAtMs < REBUILD_AFTER_MS) {
    return indexPromise;
  }
  builtAtMs = Date.now();
  indexPromise = buildEpgIndex();
  return indexPromise;
}

/** For the tests, and for a caller that knows the cache changed and wants the
 *  next `ensureEpgIndex()` to rebuild unconditionally rather than wait out
 *  `REBUILD_AFTER_MS`. */
export function resetEpgIndex(): void {
  indexPromise = null;
  builtAtMs = 0;
}

export { EMPTY_INDEX };
