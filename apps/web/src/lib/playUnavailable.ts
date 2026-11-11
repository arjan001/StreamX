/**
 * When playback cannot resolve a title, it says why, in words a viewer can act
 * on — a channel whose account is no longer signed in on this device and a
 * library still being built are different problems from a stale link.
 *
 * `localPlay`/`localEpisodePlay` (`lib/localRead.ts`) answer null for a handful
 * of distinct reasons. `whyNoPlay` turns the plain facts behind a null into one
 * of them, with no catalogue required to test it; `api.ts` reads those facts off
 * the real catalogue and throws this instead of ever reaching the network.
 */

export type PlayUnavailableReason = 'no-library' | 'not-found' | 'signed-out';

const SENTENCE: Record<PlayUnavailableReason, string> = {
  'no-library': 'The library is still being prepared on this device. Try again in a moment.',
  'not-found': 'This link is from before the list was last reloaded. Reload the list.',
  'signed-out': 'This title belongs to a source that is no longer on this device. '
    + 'Add it again under Settings to play it.',
};

export class PlayUnavailable extends Error {
  readonly reason: PlayUnavailableReason;

  constructor(reason: PlayUnavailableReason) {
    super(SENTENCE[reason]);
    this.name = 'PlayUnavailable';
    this.reason = reason;
  }
}

/**
 * Why `localPlay` (or `localEpisodePlay`) came back with nothing, from the plain
 * facts rather than the catalogue itself — the whole point being that this is
 * testable with none of `lib/localCatalogue.ts` in sight.
 *
 * The three checks are in order of how SURE they are, each a stronger statement
 * than the last: no catalogue at all beats a row not being in one, which beats a
 * row that is there but has nothing to build a stream from.
 */
export function whyNoPlay(input: {
  /** Is a catalogue built on this device at all? */
  hasCatalogue: boolean;
  /** Was a row found for the id inside it — false for a ref an old link carries. */
  rowFound: boolean;
  /** The active provider's stream base and credentials, both in hand. */
  hasCredentials: boolean;
  /** The row's own provider stream id — absent on a handful of malformed rows. */
  hasStreamId: boolean;
}): PlayUnavailableReason {
  if (!input.hasCatalogue) return 'no-library';
  if (!input.rowFound) return 'not-found';
  if (!input.hasCredentials) return 'signed-out';
  if (!input.hasStreamId) return 'not-found';
  /* Unreachable in practice: a row with credentials and a stream id is exactly
     what `localPlay` builds a URL from, so it would not have returned null. Kept
     total rather than partial so a future branch of `localPlay` cannot fall
     through this function silently. */
  return 'signed-out';
}

/**
 * What a caller should tell the viewer about a failed play — the `PlayUnavailable`
 * sentence when there is one, the stale-link wording for an error that reports a
 * 404, and the call site's own fallback for anything else.
 */
export function playFailureHint(err: unknown, fallback: string): string {
  if (err instanceof PlayUnavailable) return err.message;
  if (err instanceof Error && /404/.test(err.message)) {
    return 'The catalogue entry no longer exists — it is probably from before the last refresh. Reload the list.';
  }
  return fallback;
}
