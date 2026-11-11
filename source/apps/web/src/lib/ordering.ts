/**
 * The viewer's own order for a list they did not write.
 *
 * A subscription here carries 829 live packages. Asking someone to rank those is
 * absurd; asking them to drag four to the top is not. So an order is a PARTIAL
 * list: everything named comes first, in the order named, and everything else
 * keeps the provider's order behind it. That is what makes the feature usable on
 * the first afternoon rather than after an hour of sorting.
 *
 * Stored as refs (`<kind>.<provider id>`) for the same reason the hidden list is:
 * row ids are reassigned by every re-ingest, so an order stored as ids would
 * silently start ranking different packages.
 *
 * Pure and tested, because reordering is the kind of code where an off-by-one is
 * invisible until somebody's carefully arranged list comes back shuffled.
 */

export interface Orderable {
  ref: string;
}

/**
 * Apply a partial order.
 *
 * Stable for the unnamed tail: two packages nobody has ranked stay in the order
 * the provider gave them, which is how the list looked before anyone touched it.
 * Refs in the order that no longer exist are ignored rather than removed — a
 * package that vanished from one refresh and comes back in the next keeps its
 * position, which is the behaviour someone who dragged it there expects.
 */
export function applyOrder<T extends Orderable>(rows: readonly T[], order: readonly string[]): T[] {
  if (order.length === 0) return [...rows];
  const rank = new Map<string, number>();
  order.forEach((ref, i) => { if (!rank.has(ref)) rank.set(ref, i); });
  const named: T[] = [];
  const rest: T[] = [];
  for (const row of rows) (rank.has(row.ref) ? named : rest).push(row);
  named.sort((a, b) => rank.get(a.ref)! - rank.get(b.ref)!);
  return [...named, ...rest];
}

/**
 * Move one item to a new index within the list as currently displayed.
 *
 * Takes and returns the full list, because a partial order that only names the
 * moved item cannot express "third". The caller stores the result.
 *
 * Generic in the id, because two things are ordered this way now: packages,
 * named by ref, and channels, named by provider stream id ("move it up and down
 * should be for both channels as well as categories"). The rule is identical and
 * a second copy of it would be a second place for an off-by-one to live.
 */
export function moveTo<T extends string | number>(refs: readonly T[], from: number, to: number): T[] {
  const out = [...refs];
  if (from < 0 || from >= out.length) return out;
  const clamped = Math.max(0, Math.min(out.length - 1, to));
  const [moved] = out.splice(from, 1);
  if (moved === undefined) return [...refs];
  out.splice(clamped, 0, moved);
  return out;
}

/**
 * The order that results from dragging `ref` to position `to` in the CURRENT view.
 *
 * The subtlety this exists for: the stored order is partial, but a drag happens in
 * the full list. Dropping something at index 12 of a list where only three items
 * are ranked has to produce an order that puts it after whatever is visually above
 * it — otherwise the row springs back to somewhere else the moment it is released,
 * which reads as the drag having failed.
 *
 * So the displayed order is materialised, the move is applied there, and the whole
 * thing becomes the new named order. A viewer who has arranged the top of a
 * 829-row list pays for it with 829 stored refs, which is 12KB — cheap enough
 * against the alternative of an order that does not do what the drag showed.
 */
export function reorderFrom<T extends Orderable>(
  displayed: readonly T[],
  from: number,
  to: number,
): string[] {
  return moveTo(displayed.map((r) => r.ref), from, to);
}
