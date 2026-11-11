/**
 * The permanent adult exclusion.
 *
 * There is no option to show adult content, and no caller can forget to hide it:
 * every read in this package applies the exclusion itself. A category is adult
 * when the panel files it under market `18`, or when its name reads as adult
 * (see `isAdultCategoryName`); an item is adult when it carries `FLAG.adult`,
 * which ingest sets from `is_adult`, a tagged title, or an adult category. Both
 * are checked here so a catalogue persisted before the name detector existed is
 * still filtered.
 */
import { isAdultCategoryName } from '@iptv/core-xtream';
import { FLAG, type Catalogue, type CategoryRow } from './columns.ts';

export function isAdultCategory(c: Pick<CategoryRow, 'name' | 'path'>): boolean {
  return c.path[0] === '18' || isAdultCategoryName(c.name);
}

const memo = new WeakMap<readonly CategoryRow[], Set<number>>();

/** Ids of every adult category, all sections; computed once per catalogue. */
export function adultCategoryIds(cat: Catalogue): ReadonlySet<number> {
  let ids = memo.get(cat.categories);
  if (!ids) {
    ids = new Set<number>();
    for (const c of cat.categories) if (isAdultCategory(c)) ids.add(c.id);
    memo.set(cat.categories, ids);
  }
  return ids;
}

/** Is this row adult by its own flag or by the category it sits in? */
export function rowIsAdult(cat: Catalogue, row: number): boolean {
  if (((cat.items.flags[row] ?? 0) & FLAG.adult) !== 0) return true;
  const cid = cat.items.categoryId[row] ?? 0;
  return cid !== 0 && adultCategoryIds(cat).has(cid);
}
