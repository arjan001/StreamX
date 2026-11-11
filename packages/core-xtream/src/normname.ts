/**
 * Name normalisation for search and EPG matching.
 *
 * Provider names are punctuation-heavy and carry quality/region noise:
 * "FR| TF1 HD", "EN - Grey's Anatomy (2005)", "UK: BBC One FHD". Matching and
 * searching both need a canonical form. Measured: 98.3% of playlist entries have
 * an empty tvg-id, so name matching is the PRIMARY EPG path here, not a
 * fallback. See docs/03-catchup-epg.md section 4.
 */

/** Quality / packaging tokens that never distinguish two real channels. */
const NOISE = new Set([
  'hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hevc', 'h265', 'h264',
  'raw', 'backup', 'vip', 'plus', 'multi', 'alt', 'src', 'source',
  'fps50', 'fps60', '50fps', '60fps', 'hq', 'lq',
]);

/** Leading market prefixes: "FR|", "UK:", "EN -", "US " */
const PREFIX_RE = /^\s*[A-Za-z]{2,4}\s*[|:\-–]\s*/;

/**
 * Canonical comparison key. Strips a market prefix, folds case and accents,
 * removes punctuation, and drops noise tokens.
 */
export function normName(input: string | null | undefined): string {
  if (!input) return '';
  let s = input.normalize('NFKC');
  // Strip repeated prefixes: "FR| EN - Name"
  for (let i = 0; i < 2 && PREFIX_RE.test(s); i++) s = s.replace(PREFIX_RE, '');
  s = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining accents
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (s === '') return '';
  const kept = s.split(' ').filter((tok) => tok !== '' && !NOISE.has(tok));
  // Never normalise a name out of existence — a channel called "HD" keeps it.
  return (kept.length > 0 ? kept : s.split(' ')).join(' ');
}

/** Looser key for search: keeps noise tokens so "bbc one hd" still matches. */
export function searchKey(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Punctuation-free key: letters and digits only, no spaces.
 *
 * Needed because apostrophes and hyphens split words in `normName`
 * ("Grey's Anatomy" -> "grey s anatomy"), so a user typing "greys anatomy"
 * would never match. Compacting both sides removes the whole class of problem.
 */
export function compactName(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}
