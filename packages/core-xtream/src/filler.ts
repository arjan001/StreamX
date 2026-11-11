/**
 * Rows a provider publishes that are not channels.
 *
 * A panel's channel list is a flat sequence, so many
 * providers inject their own section headings into it as ordinary entries with
 * stream ids and logos:
 *
 *     ##### PT NOTICIAS #####
 *     ##### ABC ALABAMA #####
 *     ####### MOROCCO HD #######
 *
 * Measured on this line: 1,001 of 55,439 live channels. They sit at the top of
 * every group, they are the first thing the eye lands on, and pressing one plays
 * nothing. Nothing in the API distinguishes them; the only signal is the name,
 * which is the whole reason this module is a named, tested rule rather than a
 * regex buried in a query.
 *
 * The second family is the idle pay-per-view slot: **6,854** entries whose name
 * says, in the provider's own words, that there is nothing on.
 *
 *     ES: LALIGA+ PPV 4 - NO EVENT STREAMING -
 *     NL: DAZN PPV 12 - NO EVENT STREAMING - | NK EXCLUSIVE
 *     Matchroom Event 3 | No Event Scheduled
 *
 * Together that is 7,855 rows — one in seven of the live list — that cannot be
 * watched. They are excluded from listings, counts, search and the group tree by
 * default, and the exclusion is a flag rather than a deletion so it can be turned
 * off and so nothing is lost if this rule is ever wrong.
 *
 * ── the line this rule will not cross ──
 *
 * Decoration only counts when it wraps the name at BOTH ends. Plenty of real
 * channels open with punctuation — `- NO EVENT...` aside, this catalogue has
 * 3,946 names starting with `- ` and they are ordinary channels — so a leading
 * run alone proves nothing. A heading is symmetrical because it was typed to look
 * like one.
 */

/** Characters providers build separator bars out of. */
const BAR = '#=*_~+•·▬—–\\-<>|';
const RUN = new RegExp(`[${BAR}]{3,}`, 'gu');
const ENDS_IN_A_BAR = new RegExp(`[${BAR}]{3,}[^\\p{L}\\p{N}]*$`, 'u');
const NO_LETTERS = /^[^\p{L}\p{N}]+$/u;

/**
 * A heading dressed as a channel: `##### SPORTS #####`.
 *
 * Two bars, and the last of them closing the name. A single run proves nothing —
 * 3,946 ordinary channels on this line open with punctuation — but a name that is
 * *wrapped* was typed to look like a divider, and the closing bar is what makes
 * that unambiguous. A name with no letters or digits at all (`========`) is the
 * degenerate case of the same thing.
 *
 * The closing-bar test rather than an opening one is what catches
 * `TR| ##### TR DINI KANALLARI #####`, a heading that carries a country prefix
 * before its first bar — and it is what leaves `FR - My Dear F***ing Prince
 * (2023)` alone, which an "any two runs" rule would not.
 */
export function isSeparatorName(name: string): boolean {
  const n = name.trim();
  if (n === '') return true;
  if (NO_LETTERS.test(n)) return true;
  if (!ENDS_IN_A_BAR.test(n)) return false;
  RUN.lastIndex = 0;
  return (n.match(RUN) ?? []).length >= 2;
}

/**
 * A pay-per-view slot with nothing scheduled.
 *
 * Matched on the provider's own phrasing rather than on shape. Deliberately
 * narrow: "no event" and "no event scheduled" are statements that this entry is
 * empty right now, and a slot that later carries a match is renamed by the panel,
 * so hiding these corrects itself at the next refresh.
 */
export function isIdleEventName(name: string): boolean {
  return /\bno\s+event\b/i.test(name);
}

/** Either kind: something the provider listed that nobody can watch. */
export function isFillerName(name: string): boolean {
  return isSeparatorName(name) || isIdleEventName(name);
}

/**
 * The version of these rules, for cache invalidation.
 *
 * A device decides whether its stored catalogue is current by comparing the
 * panel's catalogue fingerprint — which answers "has the provider published a
 * new catalogue" and not "do we still agree with ourselves about what a
 * catalogue contains". Those are independent, and this answers the second.
 *
 * So when the on-device store finally learned these rules, every installation
 * already holding a copy would have gone on listing all 1,834 unwatchable rows
 * until the provider happened to re-publish. Bumping this invalidates those
 * copies exactly once. Bump it again whenever a change here alters which rows a
 * device should be holding. See `catalogueIsCurrent` in `lib/localCatalogue.ts`.
 */
export const CATALOGUE_RULES_VERSION = 3;
