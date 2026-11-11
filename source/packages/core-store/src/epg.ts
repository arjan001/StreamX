/**
 * Guide arithmetic, with no idea where the listings came from.
 *
 * These were in `services/api/src/epg.ts`, operating on rows read out of
 * Postgres. Every one of them is a pure function of a list of slots, and the
 * device now needs exactly the same answers — so they moved here rather than
 * being written a second time. The server imported them from here until it
 * stopped having a guide at all.
 *
 * The subtle one is `isFresh`, and it is worth reading twice: a channel can have
 * been asked about recently AND hold nothing useful, because the window it
 * returned has since run out. Only checking the fetch time serves a stale seven
 * days for ever.
 */
export interface Slot {
  title: string | null;
  description: string | null;
  startTs: number;
  stopTs: number | null;
  hasArchive: boolean;
}

/**
 * The key a panel-sourced channel is stored under.
 *
 * Keyed on the provider's `stream_id`, never on a row id: 82% of this catalogue's
 * channels carry no `tvg_id` at all, and a row id changes every time the
 * catalogue is rebuilt. A guide filed under one would point at a different
 * channel after the next refresh.
 */
export function channelKey(streamId: number): string {
  return `sid:${streamId}`;
}

/**
 * How long a fetched guide is trusted.
 *
 * The panel hands over seven days at a time — measured at 455 listings over 10.8
 * days for one channel — so refetching sooner buys nothing but load. Six hours
 * keeps "now/next" honest across a day of viewing while making a walk down a
 * 200-channel list cost each channel exactly once.
 */
export const FRESH_S = 6 * 3600;
/**
 * How long an EMPTY answer is trusted — which is not the same question at all.
 *
 * A channel the panel answered for is settled for hours: seven days of listings
 * arrived and nothing will change them. A channel it answered NOTHING for is not
 * settled, it is unexplained. It may have no guide at all; the ask may have
 * failed on CORS or a timeout and been stored as a zero by `fetchChannel`'s catch
 * block; the panel may simply not have had it yet.
 *
 * Trusting those two the same way is why a channel list sits blank. Measured on
 * the built app with a real subscription: 55 channels in the index, **43 of them
 * stored with `listings: 0`**, and the Live screen making **zero** EPG requests
 * in thirty seconds — every one of those channels was inside its six hours, so
 * nothing asked again and no row could ever fill in. Reported as "the EPG is not
 * under the channel name, it doesn't show what's playing", and before that as
 * "those whats playing now, its not consistant and doesnt load always".
 *
 * Half an hour is the compromise the flood limit forces. Asking on every look is
 * what gets a household's address blocked (see `lib/localEpg.ts`); asking again
 * within one sitting is what makes a list fill in while somebody is watching it.
 */
export const EMPTY_FRESH_S = 30 * 60;

export interface Coverage {
  /** Epoch seconds of the last programme stored, or null when nothing is. */
  until: number | null;
  /** When the panel was last asked, epoch seconds, or null if never. */
  fetchedAt: number | null;
  listings: number;
}

/** True when the panel has been asked recently enough to leave it alone. */
export function isFresh(c: Coverage | undefined, nowS: number): boolean {
  if (!c || c.fetchedAt === null) return false;
  /* An answer that carried listings is settled for hours; an empty one is a
     question that has not been answered yet. See `EMPTY_FRESH_S`. */
  if (nowS - c.fetchedAt > (c.listings > 0 ? FRESH_S : EMPTY_FRESH_S)) return false;
  // Asked recently but the window has already run out: a stale seven days is no
  // more useful than none, so it has to be refetched even inside the window.
  if (c.listings > 0 && c.until !== null && c.until < nowS) return false;
  return true;
}

/**
 * Fill in end times the panel left out.
 *
 * A programme with no `stopTs` is bounded by the next one's start, which is what
 * a guide needs in order to give it a width. The last row of a window has nothing
 * after it, so it gets an hour — long enough to be visible, short enough not to
 * claim the rest of the day.
 */
export function closeGaps(slots: readonly Slot[]): Slot[] {
  return slots.map((s, i) => ({
    ...s,
    stopTs: s.stopTs ?? slots[i + 1]?.startTs ?? s.startTs + 3600,
  }));
}

export function nowNext(slots: readonly Slot[], nowS: number): { now: Slot | null; next: Slot[] } {
  const closed = closeGaps(slots);
  return {
    now: closed.find((s) => s.startTs <= nowS && nowS < (s.stopTs ?? 0)) ?? null,
    next: closed.filter((s) => s.startTs > nowS),
  };
}

/** The slots overlapping a window, in start order. */
export function windowOf(slots: readonly Slot[], fromTs: number, toTs: number): Slot[] {
  return closeGaps(slots)
    .filter((s) => s.startTs < toTs && (s.stopTs ?? s.startTs + 3600) > fromTs)
    .sort((a, b) => a.startTs - b.startTs);
}
