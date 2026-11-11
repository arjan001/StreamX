/**
 * What plays next when a film ends, and what played before it.
 *
 * ── the gap this fills ──
 *
 * "there is no way playing prev and next in movies and seires i think."
 *
 * Half of that was reachability and is fixed in the player itself: the bar's
 * Previous/Next were gated on the picture being big, which hid them on exactly
 * the screen — the series desk — where a D-pad had no other route. The other
 * half is this. An EPISODE has always had neighbours, because `SeriesDesk` holds
 * the season it came from and hands the player `onPrev`/`onNext`. A FILM never
 * had any: nothing on the film page knew what list the viewer had been looking
 * at, so the two buttons were not hidden, they did not exist.
 *
 * ── what "next" means, and the trade behind it ──
 *
 * The next title in the film's own PACKAGE, in the panel's order.
 *
 * The obvious alternative is "the next title in the list you came from", and it
 * is the better answer when it is available — but it is available nowhere.
 * Tiles link to `/movie/<ref>` from grids, rails, search, favourites, continue
 * watching and a deep link out of resume, and not one of
 * those carries its query into the address. Making it so is a change to every
 * one of those call sites for a button, and a film opened from a notification or
 * a bookmark would still have nothing.
 *
 * A package is on the row itself (`item.categoryId`), so it is known for every
 * film however it was opened, it is what the panel's operator arranged, and it
 * matches how these catalogues are actually browsed — NETFLIX MOVIES, 4K ACTION,
 * a box set. It is also the same order the grid shows by default, so for the
 * common case of opening a film from its own package's grid, "next" IS the tile
 * to the right.
 *
 * ── it wraps ──
 *
 * Next from the last title is the first one. Not for tidiness: a button that
 * disappears at the end of the list takes the focus ring with it, and on a
 * remote that means the selection jumps somewhere else mid-film. Wrapping is
 * also what every set-top box does at the end of the channel list. A package
 * holding one title has no neighbours and gets no buttons, which is the honest
 * answer rather than two buttons that reload the same film.
 *
 * Reads are synchronous against the on-device catalogue — no request, nothing to
 * await, so a film page can offer the buttons on its first frame.
 */
import type { Item, Section } from './api.ts';
import { localIndexOfItem, localItems } from './localRead.ts';

export interface Neighbours {
  prev: Item | null;
  next: Item | null;
}

export const NO_NEIGHBOURS: Neighbours = { prev: null, next: null };

/**
 * Where previous and next live in a list of `total`, given where you are.
 *
 * Pure, and separated from the catalogue read for the reason every other rule in
 * this codebase is: the edges are the whole of it — a list of one, a position
 * that is not in the list, the wrap at both ends — and none of that should need
 * a catalogue to pin.
 */
export function neighbourIndexes(
  index: number,
  total: number,
): { prev: number; next: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= total) return null;
  /* One title is not a playlist. Two are: prev and next are both the other one,
     which is what a viewer pressing either button expects of a pair. */
  if (total < 2) return null;
  return { prev: (index - 1 + total) % total, next: (index + 1) % total };
}

/**
 * The titles either side of this one in its own package.
 *
 * `{ categoryId }` and nothing else: no genre, no rating floor, no hidden-list
 * filtering. The viewer is inside this package already — the film is playing —
 * so narrowing it further would hand back a "next" that the list they can see
 * does not have.
 */
export function reelFor(section: Section, item: Item): Neighbours {
  const categoryId = item.categoryId;
  if (categoryId === null) return NO_NEIGHBOURS;
  const scope = { categoryId };
  const at = localIndexOfItem(section, scope, item.id);
  if (at < 0) return NO_NEIGHBOURS;
  /* One row, for its `total`. The store answers from typed arrays it already
     holds, so this is a filter pass rather than a fetch. */
  const sized = localItems(section, { ...scope, offset: at, limit: 1 });
  if (sized === null) return NO_NEIGHBOURS;
  const where = neighbourIndexes(at, sized.total);
  if (where === null) return NO_NEIGHBOURS;
  return {
    prev: localItems(section, { ...scope, offset: where.prev, limit: 1 })?.rows[0] ?? null,
    next: localItems(section, { ...scope, offset: where.next, limit: 1 })?.rows[0] ?? null,
  };
}
