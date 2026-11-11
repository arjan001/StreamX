/**
 * Completions for a half-typed search, from the results already on the page.
 *
 * The question this answers is "how is this possible at all without a backend",
 * and the answer is that the page is already holding the vocabulary. Search runs
 * on every keystroke with a 350ms pause and comes back with up to 24 titles per
 * section — those titles ARE the dictionary, and they are a better one than any
 * static word list because they are drawn from this subscription, already
 * filtered by the profile, and already known to have something behind them. No
 * index to build, no endpoint to add, and it works identically on a device
 * reading its own catalogue with no server in reach at all.
 *
 * What it is FOR is a remote control. On a D-pad every letter is three or four
 * presses on an on-screen keyboard, so "tolonews" is around thirty presses and
 * "tol" plus one press on a suggestion is four. On a keyboard it is a
 * convenience; on a television it is the difference between searching and not
 * bothering.
 */
import { displayName } from './displayName.ts';

/** Case- and punctuation-insensitive, so "sky-news" completes from "Sky News". */
function fold(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface Suggestible {
  name: string;
}

/**
 * Titles worth offering, best first.
 *
 * Ranked in three bands, and the order matters more than any scoring would:
 *
 *  1. Titles that START with what has been typed. This is what a completion
 *     means — the letters already pressed stay where they are.
 *  2. Titles where a later WORD starts with it, so typing "news" reaches
 *     "Sky News". Mid-word matches are excluded: "ews" completing to "Sky News"
 *     is a search result, not a completion, and the results are already below.
 *  3. Nothing else. A suggestion that does not contain what was typed reads as
 *     the app having misunderstood.
 *
 * Cleaned through `displayName` first, because the raw panel titles carry market
 * prefixes and quality tokens — offering "EN - Sky News FHD" as a completion
 * would put routing metadata into the field and the next search would find less
 * than the one before it.
 */
export function suggestions(
  query: string,
  pools: readonly (readonly Suggestible[])[],
  limit = 6,
): string[] {
  const q = fold(query);
  if (q.length < 2) return [];

  const starts: string[] = [];
  const word: string[] = [];
  /* Folded, so "Sky News" and "SKY NEWS  " are one suggestion rather than two
     that look identical on screen. */
  const seen = new Set<string>([q]);

  /* Round-robin across the sections rather than draining one.
     Concatenating them meant six live channels filled the list and a film with
     the better-matching title never appeared — the section you are standing on
     is already ranked first on the page, and this is a list of six. */
  const lists = pools.map((p) => [...p]);
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth; i++) {
    for (const list of lists) {
      const row = list[i];
      if (row === undefined) continue;
      const name = displayName(row.name).trim();
      if (name === '') continue;
      const folded = fold(name);
      if (folded === '' || seen.has(folded)) continue;
      if (folded.startsWith(q)) {
        seen.add(folded);
        starts.push(name);
      } else if (folded.includes(` ${q}`)) {
        seen.add(folded);
        word.push(name);
      }
    }
  }
  return [...starts, ...word].slice(0, limit);
}
