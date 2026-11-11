/**
 * Packages and countries as search results.
 *
 * "the search should search both tv categores as well as channals and in other
 * places aswell". Searching "sky" found every channel with Sky in its name and
 * said nothing about `UK| SKY SPORTS` — the package that holds them — so the one
 * press that would have shown the lot was the one the screen did not offer.
 *
 * Deliberately NOT a fifth scope. A scope is a kind of thing you watch (a
 * channel, a film, a programme on now) and these are places to go; putting them
 * in the same list would make "All 54" a count of two different nouns, and the
 * row of chips this feeds sits with the other places-to-go rows — people,
 * genres — above the results rather than inside them.
 *
 * Pure, so the ranking is checkable without a browser: the rule that a name
 * STARTING with what you typed beats one merely containing it is the whole
 * difference between "sky" offering SKY SPORTS and offering FREESKY MUSIC.
 */
import { fold } from './liveRows.ts';
import type { Section } from './api.ts';

/** The part of a category this needs — a subset of `Category`. */
export interface CategoryLike {
  id: number;
  name: string;
  count: number;
}

export interface CategoryHit {
  id: number;
  section: Section;
  /** The provider's own name, untouched — as every list in this app shows it. */
  label: string;
  count: number;
  /** Where pressing it goes: that section's grid or list, scoped to this one. */
  href: string;
}

/** Most to least like what was typed. */
function rank(name: string, q: string): number {
  const n = fold(name);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  /* A word inside the name beginning with the query — "sky" in "UK| SKY SPORTS"
     once the pipes are folded away — is the common shape here and beats a match
     buried mid-word, which is how FREESKY ends up below SKY. */
  if (n.includes(` ${q}`)) return 2;
  if (n.includes(q)) return 3;
  return -1;
}

/**
 * Categories worth offering for this query, best first.
 *
 * `limit` bounds the row rather than the search: a provider with 829 packages
 * will match dozens of them for a short word, and a chip row nobody can reach
 * the end of on a remote is worse than a short one.
 */
export function categoryHits(
  sections: readonly { section: Section; categories: readonly CategoryLike[] }[],
  query: string,
  limit = 12,
): CategoryHit[] {
  const q = fold(query);
  if (q.length < 2) return [];
  const scored: { hit: CategoryHit; r: number }[] = [];
  for (const { section, categories } of sections) {
    for (const c of categories) {
      if (c.count <= 0) continue;
      const r = rank(c.name, q);
      if (r < 0) continue;
      scored.push({
        r,
        hit: {
          id: c.id,
          section,
          label: c.name,
          count: c.count,
          href: `/${section}?category=${c.id}`,
        },
      });
    }
  }
  /* Rank first, then the bigger package — a category with 300 channels in it is
     more likely to be the one somebody meant than one with two. Stable within
     both, so the provider's own order breaks the last tie. */
  scored.sort((a, b) => (a.r - b.r) || (b.hit.count - a.hit.count));
  return scored.slice(0, limit).map((s) => s.hit);
}
