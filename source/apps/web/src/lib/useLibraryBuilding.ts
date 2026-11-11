import { useEffect, useState } from 'react';
import { localStatus, subscribeLocal } from './localCatalogue.ts';

/**
 * Is the library still being assembled on this device?
 *
 * "nothing here." is a CLAIM about the library, and while the library is being
 * built there is no basis for it. On a first visit the app made that claim for
 * 2.3 seconds with its own progress bar contradicting it one line above:
 *
 *     +2.4s  Catalogue Building the catalogue (0/7)   — the bar
 *     +2.7s  skeleton rows                            — the list, correct
 *     +3.0s  nothing here.                            — the list, wrong
 *     +5.3s  channels
 *
 * Reported as "on free first visit i see an error briefly till channels are
 * loaded". It is not an error and nothing failed; a list whose own query had
 * settled empty simply answered a question the device could not yet answer.
 *
 * The race is structural rather than a slow path to tune away. Every list here
 * asks the on-device catalogue, and a catalogue that is MID-BUILD answers
 * honestly and emptily — so `loading` on the query is false and `total` is 0,
 * which is indistinguishable from a library that really holds none of this. The
 * one thing that tells them apart is the ingest's own state, which is what this
 * reads.
 *
 * Deliberately not folded into `usePagedItems`: the distinction is about what a
 * screen is allowed to SAY, not about what the query returned, and the skeleton
 * a caller shows instead is the caller's own.
 */
export function useLibraryBuilding(): boolean {
  const [building, setBuilding] = useState(() => localStatus().state === 'loading');
  useEffect(() => subscribeLocal((s) => setBuilding(s.state === 'loading')), []);
  return building;
}

/** What a list should draw, given its own query and the library's state. */
export type ListPhase = 'skeleton' | 'empty' | 'rows';

/**
 * The rule both browsing screens follow, in one place.
 *
 * Named rather than repeated as `(loading || building) && total === 0` at each
 * call site, because the interesting case is the one that is easy to leave out:
 * `loading` false, `building` true, `total` 0. That combination is a real
 * moment on every first visit — the query has settled against a catalogue that
 * is still being assembled — and it is the only one where an empty answer is
 * not evidence of an empty library.
 */
export function listPhase(loading: boolean, building: boolean, total: number): ListPhase {
  if (total > 0) return 'rows';
  return loading || building ? 'skeleton' : 'empty';
}
