/**
 * What order the countries come in.
 *
 * Five rules about markets, in this order, and each one is a request:
 *
 *   1. **What the viewer moved, where they put it.** A partial order, the same
 *      idea as `catOrder` for packages: what is listed comes first in that
 *      sequence, everything else keeps the default after it. Ranking 178
 *      countries is not an instruction anybody gives; moving four to the top is.
 *   2. **The United Kingdom first**, always — `UK`, `UKF`, `GB`, `GBF`.
 *   3. **Then the rest of Europe**: a fixed short list
 *      of European markets — Spain, Netherlands, Belgium, Italy — in a fixed order, ahead of
 *      every other European market; then whatever Europe is left, by size:
 *      "show the eu countries on top" — this app is watched in Belgium and the
 *      Netherlands, and the default order before this rule existed was by
 *      channel count, which put the markets with the most rows first: US,
 *      Arabic and multi-language bundles. A viewer in Ghent had to scroll past
 *      4,000 American channels to reach their own country.
 *   4. **Then every other country, by size** — the US lands here, not because
 *      it is unwanted but because nobody has asked for it to go first.
 *   5. **Then everything that is not a country** — a language, a region or a
 *      topic, per `marketKind` — by size, same reasoning as rule 4.
 *
 * Rules 2-4 used to be one rule, "Europe, then by size", and nothing split
 * countries from languages/regions/topics at all. A LIST-mode photo of 1.19.1
 * came back reading US| PARAMOUNT+ PPV, NL| ODIDO VERMAAK, NL| RADIO LIVE,
 * US| ENTERTAINMENT, US| NBC NETWORK, US| FOX NETWORK, US| CBS NETWORK,
 * US| ABC NETWORK, UK| NOW TV, US| TUBI — the provider's raw category order,
 * with the owner's own words on it: "please at least fix the order always for
 * show UK then others UK and other Europe countries after it and then so on
 * and order it properly because right now it's mixed". That LIST-mode rail was
 * never sorted by this file at all (see `lib/liveRows.ts`'s `listRows`); it is
 * now — one ranking, read by the group tree, the flat list and the Organise
 * screen alike, rather than the tree being the only one of the three that knew
 * about Europe.
 *
 * ── why the Europe list is written out by hand ──
 *
 * The market ids in this app are not ISO country codes. They are the provider's
 * own segments (`BE`, `SWEDEN`, `EXYU`, `EU`), the free lists' country namespace
 * (`NLF` for the Dutch free list), and ISO codes where the two happen to agree.
 * iptv-org publishes a regions file that would answer this, but it is a network
 * fetch and this sort runs on every render of the country list, so the answer
 * has to be synchronous. See `MARKET_LABELS` in `@iptv/core-xtream` for the
 * namespace this mirrors.
 */
import type { Section } from './api.ts';

/**
 * European market ids, provider codes and ISO codes together.
 *
 * Geographic Europe rather than the political EU: a viewer who says "EU
 * countries" means the ones near them, and leaving out the United Kingdom,
 * Switzerland, Norway or Serbia to satisfy a treaty definition would be a
 * pedantic answer to a plain request.
 */
const EUROPE = new Set([
  /* The provider's own long-form segments. */
  'EU', 'EXYU', 'SWEDEN', 'DENMARK', 'NORWAY', 'FINLAND', 'ICELAND', 'UKR', 'KO',
  /* Two-letter codes: provider and ISO, which overlap almost entirely here. */
  'AD', 'AL', 'AT', 'AX', 'BA', 'BE', 'BG', 'BH', 'BY', 'CG', 'CH', 'CY', 'CZ',
  'DE', 'DK', 'EE', 'EST', 'ES', 'FI', 'FO', 'FR', 'GB', 'GE', 'GG', 'GI', 'GR',
  'HR', 'HU', 'IE', 'IM', 'IS', 'IT', 'JE', 'LA', 'LI', 'LT', 'LU', 'LV', 'MC',
  'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI',
  'SJ', 'SK', 'SL', 'SM', 'UA', 'UK', 'VA', 'XK',
]);

/*
 * Two ids that mean something else in this namespace, and must not be read as
 * European:
 *
 *   `IS`  the provider uses it for Israel (`MARKET_LABELS`), while ISO uses it
 *         for Iceland. The provider's meaning wins, because these ids come from
 *         the provider.
 *   `BH`  the provider uses it for Bosnia & Herzegovina; ISO uses it for
 *         Bahrain. Here the provider's meaning is the European one, so it stays.
 *
 * `IS` is therefore removed again rather than left in the list above, where it
 * would look like an oversight.
 */
EUROPE.delete('IS');

/** Is this market a European one? Free-list ids carry a trailing `F`. */
export function isEuropean(id: string): boolean {
  const up = id.toUpperCase();
  if (EUROPE.has(up)) return true;
  /* `NLF` -> `NL`: the free lists live in their own namespace, and a Dutch free
     list belongs beside the Dutch one rather than at the bottom of the world. */
  return up.length === 3 && up.endsWith('F') && EUROPE.has(up.slice(0, 2));
}

/**
 * The United Kingdom, and four other European markets. Eight ids in total, pinned
 * by `marketOrder.test.ts`.
 *
 * UK gets rule 2 outright, ahead of the other four. Those four keep the
 * owner's own order — Spain, Netherlands, Belgium, Italy — rather than being
 * sorted by size like everything below them: "in the owner's own order" is
 * rule 3's whole point, and sorting these four by channel count would put
 * whichever one the provider happens to carry the most of first, for a reason
 * no viewer asked for. US is not European and is not repeated here — it falls
 * through to rule 4 with every other country.
 */
const UK_IDS = new Set(['UK', 'UKF', 'GB', 'GBF']);

const EUROPE_DEFAULTS: readonly (readonly string[])[] = [
  ['ES', 'ESF'], // Spain
  ['NL', 'NLF'], // Netherlands
  ['BE', 'BEF'], // Belgium
  ['IT', 'ITF'], // Italy
];

/** id (uppercase) -> its place among `EUROPE_DEFAULTS`, for an O(1) tie-break. */
const EUROPE_DEFAULT_RANK = new Map<string, number>();
EUROPE_DEFAULTS.forEach((ids, i) => ids.forEach((id) => EUROPE_DEFAULT_RANK.set(id, i)));

/**
 * What KIND of thing a market code names.
 *
 * The picker is headed "Country" and this line's codes are 26 countries, two
 * languages, five regions and four topics — so "English", "Music" and
 * "Sports" sat in the country list as if they were places. Reported as "show
 * really bad like languges and counties mixed", and the fix is to say which is
 * which rather than to drop any of them: a viewer who wants the Arabic films
 * wants that filter, just not under that heading.
 *
 * Anything not listed is a country, which is what the great majority are and
 * what an unknown two-letter code almost always is.
 *
 * Lives here rather than in `lib/groups.ts`, which used to define it, because
 * `marketSort` below needs the same split for rule 5 — non-country markets
 * rank after every country — and a second copy of the three lists below is
 * how a market ends up classified two different ways on two screens.
 * `groups.ts` re-exports both names, so nothing that imported them from there
 * has to change.
 */
export type MarketKind = 'country' | 'language' | 'region' | 'topic';

const LANGUAGE_MARKETS = new Set(['EN', 'AR', 'KU']);
const REGION_MARKETS = new Set([
  'AF', 'AFR', 'ASIA', 'EU', 'NA', 'LAT', 'LA', 'SCA', 'EXYU', 'EX', 'CRB',
  'WC', 'MULTI', 'QC',
]);
const TOPIC_MARKETS = new Set(['MU', 'SPT', '18', 'OTHER', 'BEE']);

export function marketKind(code: string, section?: Section): MarketKind {
  const up = code.toUpperCase();
  /* `LA` is a REGION in films and series (Latin America) and a country on the
     live side (Latvia) — the same split `marketName` in `groups.ts` handles
     for the label. */
  if (up === 'LA') return section === 'movies' || section === 'series' ? 'region' : 'country';
  if (LANGUAGE_MARKETS.has(up)) return 'language';
  if (REGION_MARKETS.has(up)) return 'region';
  if (TOPIC_MARKETS.has(up)) return 'topic';
  return 'country';
}

/**
 * Which of rules 2-5 a market falls under, as a number so the comparator below
 * is one subtraction: 0 the United Kingdom, 1 the owner's other European
 * defaults, 2 the rest of Europe, 3 every other country, 4 everything that is
 * not a country at all.
 */
function marketTier(id: string, section: Section | undefined): 0 | 1 | 2 | 3 | 4 {
  const up = id.toUpperCase();
  if (UK_IDS.has(up)) return 0;
  if (EUROPE_DEFAULT_RANK.has(up)) return 1;
  if (isEuropean(up)) return 2;
  return marketKind(up, section) === 'country' ? 3 : 4;
}

/**
 * Sort markets: the viewer's own order first, then rules 2-5 above for
 * everything they left unplaced.
 *
 * `section` is only needed for rule 5's country/not-country split — the one
 * market code this catalogue reuses across a boundary that matters here is
 * `LA` (Latvia on the live side, Latin America in films and series; see
 * `marketKind`) — and every caller inside this app has a section to give it.
 * Left out, `LA` reads as a country, which is right everywhere except a films
 * or series screen.
 *
 * Never sorts in place — these arrays come out of the query cache.
 */
export function marketSort<T extends { id: string; count: number }>(
  rows: T[],
  order: string[] = [],
  section?: Section,
): T[] {
  const rank = new Map<string, number>();
  order.forEach((id, i) => rank.set(id, i));
  return [...rows].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined || rb !== undefined) {
      /* Anything the viewer placed beats anything they did not, and among the
         placed ones their sequence is the whole answer. */
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    }
    const ta = marketTier(a.id, section);
    const tb = marketTier(b.id, section);
    if (ta !== tb) return ta - tb;
    if (ta === 1) {
      /* Both are one of the owner's own four — Spain before Netherlands before
         Belgium before Italy, not by size. */
      return EUROPE_DEFAULT_RANK.get(a.id.toUpperCase())! - EUROPE_DEFAULT_RANK.get(b.id.toUpperCase())!;
    }
    return b.count - a.count;
  });
}

/**
 * Move one market up or down in the viewer's order.
 *
 * The list handed in is what is ON SCREEN, in the order it is on screen, which
 * is what makes a move mean what it looks like: moving the fourth row up puts it
 * above the third row a viewer can see, not above whatever the third-ranked
 * market would be in some other sort. The result is a complete order for
 * everything above the moved row and nothing below it — the same partial-order
 * shape `reorderFrom` produces for packages.
 */
export function moveMarket(shown: { id: string }[], id: string, dir: -1 | 1): string[] {
  const ids = shown.map((m) => m.id);
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const to = from + dir;
  if (to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next[from] = ids[to]!;
  next[to] = ids[from]!;
  /* Trailing rows nobody has moved are dropped, so the stored order stays a
     statement about the front of the list rather than a snapshot of all 178. */
  return next.slice(0, Math.max(to, from) + 1);
}
