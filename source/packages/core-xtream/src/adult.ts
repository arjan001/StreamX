/**
 * Adult detection, by name.
 *
 * The app never lists adult titles, so nothing here decides what to SHOW; it
 * decides what to mark. A panel may flag a title itself (`is_adult`) or file it
 * under market `18|`, but many panels and nearly every M3U playlist do neither
 * and simply name the group "XXX Movies" or "Adults 18+". These two functions
 * read those names. Both are pure and run once per category / title at ingest.
 *
 * The word list errs toward catching, with explicit exemptions for the few
 * well-known innocent names that contain an adult word ("Adult Swim", "Young
 * Adult", "Adult Contemporary"). A word match is always whole-word, so a film
 * called "Adulthood" never matches.
 */

/** Lowercase, accent-stripped: "Erótico" and "EROTICO" read the same. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Innocent names that contain an adult word; removed before the test. */
const EXEMPT = /\b(?:adults?\s+swim|young\s+adults?|adults?\s+contemporary|adults?\s+education|adults?\s+learning)\b/g;

/**
 * Whole words and phrases that mark a category adult.
 *
 * `adult` alone is included because "Adult", "Adults" and "Adult Movies" are the
 * commonest spellings; the exemptions above carry the false positives.
 * Non-English forms: adulte(s) fr, adulto(s) es/pt, adulti it, erwachsene(n) de.
 */
const CATEGORY_WORDS = new RegExp(
  [
    String.raw`\bx{3,}\b`,
    String.raw`\badult(?:s|e|es|o|os|i)?\b`,
    String.raw`\bporn\w*`,
    String.raw`\berotic\w*`,
    String.raw`\berotik\w*`,
    String.raw`\bnsfw\b`,
    String.raw`\bhentai\b`,
    String.raw`\bx-rated\b`,
    String.raw`\berwachsenen?\b`,
    // 18+ / +18; not "1918+" or "2018+".
    String.raw`(?<!\d)18\s*\+`,
    String.raw`\+\s*18(?!\d)`,
  ].join('|'),
);

/** Is this category (Xtream category_name, or M3U group-title) an adult one? */
export function isAdultCategoryName(name: string | null | undefined): boolean {
  if (!name) return false;
  const s = fold(name).replace(EXEMPT, ' ');
  return CATEGORY_WORDS.test(s);
}

/**
 * A title that opens with an adult tag: "[X] Studio - Title", "[XXX] ...",
 * "(XXX) ...", or a bare "XXX |" / "XXX -" prefix. A bare "XXX: Return of
 * Xander Cage" or "xXx (2002)" is a real film and does not match.
 */
const ITEM_TAG = /^\s*(?:\[\s*x{1,3}\s*\]|\(\s*x{3}\s*\)|x{3}\s*(?:[|\]]|[-–]\s))/i;

export function isAdultTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return ITEM_TAG.test(title);
}
