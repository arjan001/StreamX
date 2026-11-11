/**
 * Turn a provider title into something a person wants to read.
 *
 * Panel titles carry routing metadata in the display string: a market prefix, a
 * quality token, superscript VIP/RAW marks, sometimes a lead actor's name in caps,
 * and a year that the UI already shows in its own column. Rendering that raw gives
 * rows like "EN - The Shawshank Redemption (1994)" sitting directly above a second
 * "1994", which is what the catalogue looks like when nothing cleans it up.
 *
 * Deliberately conservative: it strips only patterns that are unambiguously
 * metadata. Dropping anything that MIGHT be part of a real title is worse than
 * leaving noise in, because a title you cannot recognise is unsearchable.
 */

import { parseEvent } from './eventName.ts';
import { stripMarks, unshout } from './titleCase.ts';

/**
 * The routing prefix, in its two delimiters — and they need different rules.
 *
 * A PIPE prefix is always routing metadata on these panels, and it is not always
 * a two or three letter market: measured on this catalogue, 3,959 of 12,341 live
 * titles kept a visible prefix because the old pattern only accepted
 * `[A-Za-z]{2,3}` and the real ones include `D+|`, `PLAY+|`, `PRIME|`, `4K|`,
 * `MOVISTAR+|` and `UK-BBCI|`. That is the "I still see categories in channels"
 * report: the group name, printed in front of every channel in it, while the
 * group is already the thing you picked in the sidebar.
 *
 * A DASH prefix stays SHORT, because a dash is ordinary title punctuation and a
 * rule that accepts a long first word eats real titles — "Mission - Impossible"
 * would become "Impossible". The length cap is what keeps that safe, not the
 * alphabet, so the alphabet is where this rule was wrong.
 *
 * ── what the letters-only rule left on the screen ──
 *
 * Measured over the frozen catalogue in `fixtures/catalogue.json` (894 series):
 * 884 rows carry a dash prefix and `[A-Za-z]{2,3}` matched only 655 of them.
 * The 229 it missed are the shapes that are not letters:
 *
 *     4K - 1883 (2021)                201 rows   a transcode, not a market
 *     D+ - Among the Stars             14 rows   Disney+
 *     A+ - Bad Sisters (2022)          13 rows   Apple TV+
 *
 * — a quarter of the series library reading "4K - " in front of its own name,
 * 269 rows across the whole catalogue once the films are counted. That is the
 * report this rule exists to answer, one library along from where it was first
 * answered. The live panel has since started pairing the two
 * ("4K-SC - Fallout (2024) (US)"), which is why the token may repeat across a
 * hyphen: the OLD pair rule was two markets (`UK-BBC`), and it is now any two of
 * these, so "4K-SC" peels in one pass instead of leaving "SC - Fallout".
 *
 * ── the token, character by character ──
 *
 * `4K|UHD|FHD|HD|SD` spelled out, because these are the only DIGIT-leading
 * tokens that are ever metadata; anything else starting with a digit is a title
 * ("24 - Legacy", "66-5"). Otherwise: a letter, then one or two more letters or
 * digits, or a single `+` — which is `A+`, `D+`, `NF`, `EN`, `QFR`, `SC`. Three
 * characters is the ceiling for the same reason it always was.
 */
const DASH_TOKEN = '(?:4K|UHD|FHD|HD|SD|[A-Za-z](?:[A-Za-z0-9]{1,2}|\\+))';
const MARKET_DASH = new RegExp(`^\\s*\\|?\\s*(${DASH_TOKEN})(?:-(${DASH_TOKEN}))?\\s*-\\s*`, 'i');
const MARKET_PIPE = /^\s*\|?\s*([A-Za-z0-9+.&]{1,10}(?:-[A-Za-z0-9+.&]{1,10})?)\s*\|\s*/;
/**
 * Leading words that are SCHEDULE STATE, not a group, and must survive.
 *
 * The PPV listings are pipe-delimited records whose first field says whether the
 * event is on now, coming up, or over — "ENDED | 2. BUNDESLIGA … | Fri 28 Aug".
 * Stripping that would turn a finished match into one that looks live, which is
 * worse than the noise it removes.
 */
const STATUS_PREFIX = /^(LIVE|NEXT|ENDED|NOW|SOON|TODAY|TOMORROW|VS)$/i;
/**
 * Superscript VIP/RAW/HD marks the panel decorates names with.
 *
 * Spelled out by codepoint rather than as a visual range: "ⱽ" (U+2C7D) lives in
 * Latin Extended-C, nowhere near the modifier-letter block, so a range that looks
 * complete leaves it behind and yields titles like "MACEDONIA ⱽ".
 */
const SUPERSCRIPT = /[\u02B0-\u02FF\u1D2C-\u1D6A\u1D78\u1DBF\u2070-\u209C\u2C7C\u2C7D]+/g;
const QUALITY = '4K|UHD|FHD|HD|SD|HEVC|H\\.?26[45]|2160p?|1080p?|720p?|VIP|RAW|MULTI|MULTI-?AUDIO';
/**
 * Two of those tokens joined by a slash, which the panel writes as one word.
 *
 * The tail rule matched only the LAST half of such a pair, and the half it left
 * behind was the half with the punctuation on it. Counted over the frozen
 * catalogue in `fixtures/catalogue.json`: 14 names carry a slashed pair and every
 * one of them printed the slash — 28 rows across the two call shapes, one of
 * those names leaving an unclosed bracket as well —
 *
 *     ES| LA 1 4K/UHD              →  "LA 1 4K/"
 *     4K| KINO UHD/4K              →  "KINO UHD/"
 *     UK-BBCI| BBC EVENTS 1 (UHD/4K)  →  "BBC EVENTS 1 (UHD/"
 *
 * — the last one being the worse shape, because the optional `[\])]?` in the tail
 * rule swallowed the pair's closing bracket and orphaned its opener. A slash is
 * the only joiner the panel uses: measured over every name in the catalogue, the
 * one other character found between two of these tokens was an opening bracket
 * ("Troll 2 4K (MULTI-SUBS)"), which is already two separate annotations.
 *
 * `groupLabel` at the bottom of this file already knew the shape ("DK| DANSKE
 * SERIER 4K/UHD"), which is the tell that it belongs in the token itself rather
 * than in one rule's private copy of it.
 */
const QUALITY_RUN = `(?:${QUALITY})(?:\\s*/\\s*(?:${QUALITY}))*`;
const QUALITY_TAIL = new RegExp(`\\s*[\\[(]?\\b(?:${QUALITY_RUN})\\b[\\])]?\\s*$`, 'i');
/**
 * The same tokens, anywhere in the name — because that is where they are.
 *
 * Counted over the live line, 45,146 series: 139 rows print a quality token in
 * the MIDDLE of the name, and every one of them is the same shape — the panel
 * writes it before its own year. "NF - The Serpent 4K (2021)" reached the screen
 * as "The Serpent 4K", because the tail rule above correctly found no tail (the
 * year was still there) and `dropYear` removes the year AFTER it has run. So the
 * token is peeled wherever it stands, and the tail rule runs again at the end for
 * what dropping the year newly exposed.
 *
 * Parenthesised only, or bounded by spaces: a bare `4K` glued to a word is part
 * of that word, and a title that IS one of these tokens has nothing left to show
 * — `displayName` returns the raw name rather than an empty string for exactly
 * that case.
 */
const QUALITY_ANY = new RegExp(`(?:\\s*[\\[(]\\s*(?:${QUALITY_RUN})\\s*[\\])]|\\s+\\b(?:${QUALITY_RUN})\\b(?=\\s|$))`, 'gi');
/**
 * File annotations in brackets that are not places.
 *
 * 217 rows of the series library carry one: `(LQ)` on 148 — a low-quality
 * encode — `MULTI` on 69, plus VIP and RAW. They are facts about the file, and
 * unlike a country tag no two titles are told apart by them.
 *
 * `(DUB)` and `(SUB)` are deliberately NOT here, and neither is `(VF)`. Those
 * say which audio you get, the panel ships both rows for the same show, and
 * stripping them would put two identical names in one list — the same trade
 * `YEAR_THEN_COUNTRY` documents for "The Office (US)".
 */
/*
 * `[LIVEEVENT]` and its spellings are here for the same reason, added later.
 *
 * Counted over `fixtures/catalogue.json`: 33 names carry a square bracket, and 14
 * of them are this — `ES| M.LALIGA 3 FHD [LIVEEVENT]` on 11 channels, plus one
 * each of `[LIVE-EVENT]`, `[LIVE EVENT]` and `[EVENT]`. It says the feed only
 * lights up for a fixture, which is a fact about the feed and not about the
 * channel, and it was reaching a television verbatim: "raw provider markup is
 * leaking into the UI".
 *
 * The word list is narrow on purpose, and the rest of that measurement is why.
 * Six rows of the same fixture read `ES - Formula 1 2024 Abu Dhabi [RACE] [SPA]`,
 * `… [QUALY] [SPA]`, `… [FP1] [SPA]` — the bracket is the ONLY thing telling six
 * identically-named rows apart, and a rule that took every square bracket would
 * collapse the Abu Dhabi weekend into six copies of one line. Same for
 * `NL| F1 OLAV MOL [KWALI + RACE]`, `NF - BIGBANG - World Tour [MADE] Final In
 * Seoul` and the PPV placeholders `[TBC] VS [TBC]`. So: these words, spelled out.
 */
const FILE_WORDS = 'LQ|HQ|MULTI|MULTI-?AUDIO|VIP|RAW|REPACK|PROPER|LIVE[ -]?EVENT|EVENT';
const FILE_TAG = new RegExp(`\\s*[([]\\s*(?:${FILE_WORDS})\\s*[)\\]]`, 'gi');
/**
 * And the same thing written as a phrase: `(MULTI SUB)`, `(DUAL/MULTI SUB)`.
 *
 * 62 rows, all of them the newest additions to the line. The bracket goes only
 * when everything inside it is one of these words — so `(KOREAN ENG-SUB)`, which
 * tells a viewer something they cannot get anywhere else on the row, survives,
 * and so does a bare `(SUB)`. Two or more of them together is a description of
 * the file's audio tracks, which the player's own menu lists properly.
 */
const FILE_PHRASE = /\s*[([]\s*(?:MULTI|DUAL|SUB|SUBS|SUBTITLES|AUDIO|LQ|HQ)(?:[\s/-]+(?:MULTI|DUAL|SUB|SUBS|SUBTITLES|AUDIO|LQ|HQ)){1,3}\s*[)\]]/gi;
/**
 * The same tags, but at the HEAD of the name — where they block the prefix rules.
 *
 * `QUALITY_ANY` and `FILE_TAG` already peel a bracket wherever it stands, and
 * they run near the end of the pass. The prefix rules run at the start. So a
 * panel that writes both — `[4K] EN - …`, `[VIP] ES| …` — kept the prefix: the
 * pipe and dash patterns are anchored at `^`, and at `^` there was a bracket.
 * The name reached the screen as "EN - Some Film" with the market still on it,
 * which is the 3,959-rows-of-12,341 report all over again one bracket along.
 *
 * Hence a head peel, before the prefixes rather than after them. It removes
 * nothing the two rules below would not have removed anyway; what it changes is
 * WHEN, so that `^` means the title again by the time a prefix is looked for.
 *
 * The market half is the shape `cleanTitle` used to own privately — six rows of
 * `fixtures/catalogue.json` read `(MX) (VIX 01) | …` — and the lookahead is the
 * whole safety of it. `cleanTitle`'s rule had none, took any 1-8 characters, and
 * turned `NF - (Un)lucky Sisters (2024)` into "lucky Sisters" on the film page
 * while the rail beside it read "(Un)lucky Sisters". Requiring a SPACE after the
 * bracket is what separates a tag from the first syllable of a word, and
 * requiring SHOUTED letters is what keeps `QFR - (partie1) Anthony Kavanagh`
 * apart from `(partie2)` — two rows whose only difference is inside the bracket.
 * Measured over all 5,374 fixture names, `[A-Z]{2,3}` followed by a space matches
 * `(MX)` and nothing else.
 */
const LEADING_TAG = new RegExp(`^\\s*[[(]\\s*(?:${QUALITY_RUN}|${FILE_WORDS})\\s*[)\\]]\\s*`, 'i');
const LEADING_MARKET = /^\s*[[(]\s*[A-Z]{2,3}\s*[)\]](?=\s)\s*/;
/**
 * A trailing country tag with no year in front of it.
 *
 * ── the comment this replaces, and why it was wrong ──
 *
 * `YEAR_THEN_COUNTRY` below strips the pair the panel usually writes,
 * "Fallout (2024) (US)", and was anchored to the year on the grounds that a bare
 * tag might be the only thing telling two remakes apart: "The Office (US)" and
 * "The Office (UK)" are different programmes, and collapsing them into two
 * identical rows would be a bug. That was reasoning, not measurement, and it
 * left 671 rows of this library reading "(US)", "(GB)", "(DE)" — which the owner
 * has now twice called out as noise, alongside the 4K tokens.
 *
 * So it was measured, over all 45,146 series on the live line: 645 base titles
 * carry a tag of this shape, and exactly 17 of them carry TWO different ones.
 * Every one of those 17 is `DUB` against `SUB` — Turkish drama shipped in two
 * audio versions. Not one title on this line is distinguished by two different
 * COUNTRIES; the case the old rule was protecting does not occur in the data it
 * was protecting it against.
 *
 * Hence: strip the tag, and keep the words that are about audio rather than
 * about a place. If a line ever does ship "The Office" twice by country, the two
 * rows will read alike — and the poster, the year badge and the package they came
 * from still differ, which is a smaller price than 671 rows of routing data on a
 * screen read from three metres.
 */
const AUDIO_TAG = /^(?:DUB|SUB|VF|VFQ|VO|VOS|VOST|OV|ENG|MULTI)$/i;
const BARE_TAG = /\s*[([]([A-Za-z]{2,3})[)\]]\s*$/;
const COUNTRY_BEHIND_AUDIO =
  /\s*[([]\s*(?!DUB|SUB|VF|VFQ|VO|VOS|VOST|OV|ENG|MULTI)([A-Za-z]{2,3})\s*[)\]](\s*[([]\s*(?:DUB|SUB|VF|VFQ|VO|VOS|VOST|OV|ENG|MULTI)\s*[)\]])\s*$/i;
/** A parenthesised year anywhere: many titles carry a tag after it. */
const PAREN_YEAR = /\s*[([]\s*(?:19|20)\d{2}\s*[)\]]/g;
/**
 * The production country — but ONLY when it follows the year.
 *
 * The panel writes the pair at the end of a series name: "Fallout (2024) (US)",
 * "Carmen Curlers (2022) (DK)". 216 of this catalogue's 894 series carry one,
 * over 19 countries, and it is the "and country ithink" half of the report: it
 * is routing data about the file, printed on every row of a rail read from three
 * metres.
 *
 * Anchoring it to the year is what makes it safe, and the title it is protecting
 * is a real and famous one: "The Office (US)" and "The Office (UK)" are two
 * different series, and a bare `\([A-Z]{2,3}\)$` rule collapses them into two
 * identical rows. A country tag is only unambiguously the panel's own when it
 * comes straight after the panel's own year. Measured on this catalogue, that
 * leaves the tag standing on 6 rows of 894 — "FR - 22.11.63 (US)",
 * "QFR - American Dad! (VFQ)" — which is the correct trade: a stray tag on six
 * rows is noise, and two shows that lose the only thing telling them apart is a
 * bug.
 *
 * The year is a capture group because it is KEPT: the country goes, the year
 * stays for whoever is not passing `dropYear`.
 */
const YEAR_THEN_COUNTRY = /(\s*[([]\s*(?:19|20)\d{2}\s*[)\]])\s*[([]([A-Za-z]{2,3})[)\]]\s*$/;
/**
 * A trailing run of shouted words — the panel appends lead actors this way
 * ("Schindler's List (1993) LIAM NEESON").
 *
 * Only unparenthesised runs are stripped, which is what separates an actor tag
 * from a genuinely useful one like "(KOREAN ENG-SUB)". Requires lowercase earlier
 * in the title so an all-caps title is never eaten whole.
 */
const SHOUTED_TAIL = /\s+(?:[A-Z][A-Z'’.-]{2,}\s+){1,3}[A-Z][A-Z'’.-]{2,}\s*$/;
/**
 * The same appended credits, written as a comma-separated list.
 *
 * The run above stops at a comma, and a provider that lists three people does not
 * — so "EN - The Godfather 4K (1972) MARLON BRANDO, AL PACINO, FRANCIS FORD
 * COPPOLA" lost its last three words and reached the rail as "The Godfather
 * MARLON BRANDO, AL PACINO," with the comma dangling. 17 names of the frozen
 * catalogue ended that way, 34 rows across the two call shapes, and a comma whose
 * other half has been removed is the same defect as a dangling dash.
 *
 * Measured before it was written, over all 5,374 names: 22 end in a
 * comma-separated run of shouted words, and all 22 are credits — "DICAPRIO, SEAN
 * PENN, BENICIO DEL TORO", "TIM BURTON, JOHNNY DEPP", "KIRK DOUGLAS, ANTHONY
 * QUINN". Not one is title text. So the comma is EVIDENCE and not a risk: this
 * rule is narrower than the bare run above, because a mixed-case title does not
 * end in two comma-separated shouted names, and 0 of those 5,374 names end in a
 * comma at all.
 *
 * Two characters is the floor for a word here, against three in the run above,
 * because these lists are full of "AL PACINO" and "DE NIRO". The
 * lowercase-somewhere guard at the call site is what stops an all-caps title
 * being read as its own cast list, and it covers this rule too.
 */
const SHOUTED_WORD = "[A-Z][A-Z'’.-]+";
const SHOUTED_LIST = new RegExp(
  `\\s+${SHOUTED_WORD}(?: ${SHOUTED_WORD})*(?:\\s*,\\s*${SHOUTED_WORD}(?: ${SHOUTED_WORD})*)+\\s*$`,
);
/**
 * A separator with nothing behind it any more.
 *
 * Every rule above takes a decoration off the end and leaves whatever introduced
 * it, and what introduces them is a dash:
 *
 *     ES - La gran aventura suiza - (2022)
 *         → "La gran aventura suiza -"   once `dropYear` took the year
 *     FR - La vengeance d'une blonde  (1994) - CHRISTIAN CLAVIER
 *         → "La vengeance d'une blonde -"   once the actor run went
 *
 * 11 names of the frozen catalogue, 18 rows across the two call shapes: 5 VOD
 * titles like the two above, plus 6 live placeholders the panel itself left
 * hanging ("UEFA | 01 -"), which no rule here truncated but which read the same
 * way on a screen. And then the list-shaped ones that write " - " in front of
 * their cast ("Inglourious Basterds 4K (2009) - TARANTINO, BRAD PITT, HARVEY
 * KEITEL"). This is the same report as the double space: punctuation standing in
 * a title with no word on the other side of it.
 *
 * Shaped like the wreckage rather than like punctuation in general, and scoped to
 * the two characters a removal in this file can orphan. A dash must be SPACED off
 * the last word, because a dash attached to one can be styling ("-Starting
 * Life-") and only the ASCII hyphen was measured; a comma needs no space in front
 * of it, because it never has one. Measured over the 5,374 raw names: not one
 * ends in a spaced dash or in a comma, so this rule can only ever be clearing up
 * after the rules above it.
 */
const ORPHAN_TAIL = /(?:\s*,|\s+-+)+\s*$/;

/**
 * The answers, kept — because the same forty names are cleaned over and over.
 *
 * This function is a peel loop over about thirty regexes, four passes deep, and
 * it runs on every render of every row: `PosterCard` alone calls it twice (the
 * label, and the tooltip that carries the year), and the channel list, the guide,
 * the search results and the rails all call it per row too. Nothing about a name
 * changes between renders, so every call after the first is recomputing a
 * constant.
 *
 * Measured on this device's own catalogue, walking /series with the wheel on a
 * 4x-throttled CPU (the speed of the boxes this ships on), `displayName` was the
 * largest remaining JS entry in the profile at 213ms of a 7.9s scroll — more
 * than React's own reconciliation of the same tiles.
 *
 * Bounded, because a catalogue of 210,000 rows must not become 210,000 cached
 * strings: 4,000 is about twenty screenfuls of a grid, which covers scrolling
 * back over what you just passed, and the whole map clears rather than evicting
 * one entry at a time — an LRU here would cost more bookkeeping per call than the
 * hit it protects. Keyed with a ` ` separator so `dropYear` cannot be
 * confused with a name that happens to end in "1".
 */
const CLEANED = new Map<string, string>();
const CLEANED_MAX = 4000;

/**
 * The grammar, then the two passes every name gets: an event channel's name is
 * read for its fixture (lib/eventName.ts — "End | Sassuolo - Frosinone | … |
 * BE: DAZN PPV 4" is "Sassuolo - Frosinone"), and a name the provider typed in
 * capitals is set in ordinary case (lib/titleCase.ts).
 */
function finish(name: string, opts?: { dropYear?: boolean }): string {
  const event = parseEvent(name);
  const base = event !== null ? event.title : peelName(slotName(name), opts);
  return unshout(stripMarks(base)) || base;
}

/* Country codes that open a "UK: …" name — a list rather than a pattern,
   because "WWE: WrestleMania" and "ALF: The Animated Series" have the same shape. */
const COLON_MARKETS = new Set(['UK', 'US', 'USA', 'ES', 'FR', 'DE', 'NL', 'BE', 'IT', 'PT', 'AR', 'MX', 'BR', 'CA',
  'AU', 'IE', 'PL', 'TR', 'SE', 'NO', 'DK', 'FI', 'CH', 'AT', 'GR', 'RO', 'HU', 'CZ', 'AL', 'RS', 'HR', 'BG', 'UA',
  'IN', 'PK', 'AF', 'IR', 'AE', 'SA', 'EG', 'MA', 'LAT', 'EN', 'EU', 'CL', 'CO', 'PE']);

/**
 * An event channel with no event in it: "UK: NETFLIX PPV 1  - | 8K EXCLUSIVE",
 * "(MX) (VIX 01) |  (2098-12-31 08:00:01)". What is left is the feed's own name.
 */
function slotName(name: string): string {
  let n = name
    .replace(/\|\s*\d+K\s+EXCLUSIVE\s*$/i, '')
    .replace(/\|\s*\(\s*2[01]\d\d-\d\d-\d\d[^)]*\)\s*$/, '')
    .replace(/[\s\-|]+$/, '');
  const m = /^([A-Z]{2,3}):\s+(.+)$/.exec(n);
  if (m !== null && COLON_MARKETS.has(m[1]!)) n = m[2]!;
  /* "(MX) (VIX 01)" → "VIX 01": a market in brackets, then the name in brackets. */
  n = n.replace(/^\([A-Z]{2,3}\)\s*/, '').replace(/^\(([^()]+)\)$/, '$1');
  return n.trim() === '' ? name : n;
}

export function displayName(name: string, opts?: { dropYear?: boolean }): string {
  const key = opts?.dropYear === true ? `1\0${name}` : `0\0${name}`;
  const held = CLEANED.get(key);
  if (held !== undefined) {
    /* Re-inserting moves it to the end, which is what makes the eviction below
       least-recently-USED rather than least-recently-written. */
    CLEANED.delete(key);
    CLEANED.set(key, held);
    return held;
  }
  const made = finish(name, opts);
  if (CLEANED.size >= CLEANED_MAX) {
    /*
     * Evict a quarter, oldest first — not the whole cache.
     *
     * `clear()` threw away the forty names on screen along with everything
     * else, so the next render put the entire visible grid back through this
     * grammar. Measured while walking the poster grid with a remote on a
     * four-times-throttled CPU: 404 ms of `peelName` across twenty presses, all
     * of it on names that had been computed already.
     */
    let drop = Math.floor(CLEANED_MAX / 4);
    for (const k of CLEANED.keys()) {
      if (drop-- <= 0) break;
      CLEANED.delete(k);
    }
  }
  CLEANED.set(key, made);
  return made;
}

/**
 * The same grammar, deliberately NOT remembered.
 *
 * For passes over the WHOLE catalogue — `lib/listArt`'s sibling index walks
 * every film there is — where remembering is worse than useless: fifty thousand
 * names cannot fit in a four-thousand-entry cache, and putting them through it
 * evicts the handful the screen is drawing. That is what made moving the
 * highlight across the poster grid cost 83 ms a press while nothing about the
 * names on it had changed.
 */
export function bulkTitle(raw: string): string {
  const out = peelName(raw, { dropYear: true }).replace(AUDIO_TAIL, '').trim();
  return out === '' ? raw.trim() : out;
}

/**
 * @param name  the catalogue title
 * @param opts.dropYear  strip a trailing "(1994)" — pass true wherever the year
 *                       is displayed as its own field, which is most places
 */
function peelName(name: string, opts?: { dropYear?: boolean }): string {
  let out = name.replace(SUPERSCRIPT, ' ');
  /* Brackets at the head come off FIRST, or the prefix rules below never see a
     `^` they recognise — see `LEADING_TAG`. Capped and guarded like every other
     peel here: a name that is nothing but tags keeps the last one rather than
     coming back empty. */
  for (let i = 0; i < 3; i += 1) {
    const shorter = out.replace(LEADING_TAG, '').replace(LEADING_MARKET, '');
    if (shorter === out || shorter.trim() === '') break;
    out = shorter;
  }
  /*
   * Peel until stable, because a prefix can repeat: this catalogue carries
   * `UK| UK| BEIN SPORTS ASIA 2` verbatim, and stripping once left the second one
   * on screen. Capped, like the quality peel below — a name that is nothing but
   * prefixes should stop, not loop.
   */
  for (let i = 0; i < 3; i++) {
    const piped = MARKET_PIPE.exec(out);
    if (!piped || STATUS_PREFIX.test(piped[1]!.trim())) break;
    out = out.slice(piped[0].length);
  }
  out = out.replace(MARKET_DASH, '');
  /* The country tag, and only the one that follows the year — see
     `YEAR_THEN_COUNTRY`. What it removes from the name is exactly what
     `titleTags` offers back as a filter, and that is a rule rather than a
     coincidence: a chip for a tag still printed in the row would be the same
     fact stated twice, and a tag stripped with no chip behind it would be a
     fact the viewer can no longer reach. */
  out = out.replace(YEAR_THEN_COUNTRY, '$1');
  // Quality can appear more than once ("VTM HD RAW"), so peel until stable.
  for (let i = 0; i < 3; i++) {
    const next = out.replace(QUALITY_TAIL, '');
    if (next === out) break;
    out = next;
  }
  /* Then wherever else it stands — see `QUALITY_ANY`. Guarded so a title that is
     nothing BUT a quality token keeps its name. */
  const peeled = out.replace(QUALITY_ANY, ' ').replace(/\s{2,}/g, ' ').trim();
  if (peeled !== '') out = peeled;

  /*
   * The END of the name, peeled until it stops changing.
   *
   * Every one of these rules used to run once, in a fixed order, and the order
   * was the bug — three times over, all of them measured on the live line:
   *
   *   "The Serpent 4K (2021)"            the quality tail is not a tail yet;
   *                                      `dropYear` uncovers it afterwards
   *   "At Home With The Furys (2023) (GB) TYSON FURY"
   *                                      the country is not a tail yet either;
   *                                      the shouted actor run is in front of it
   *   "La coleccionista (MULTI-SUBS) (2025) (ES)"
   *                                      three tails, in the wrong order for any
   *                                      single pass
   *
   * A loop states the actual rule — "the last thing on this name is metadata,
   * repeatedly" — instead of encoding one guess about which order a provider
   * writes its annotations in. Four passes is more than the deepest stack
   * observed (three), and each pass must shorten the string or it stops.
   */
  for (let pass = 0; pass < 4; pass += 1) {
    const before = out;
    out = out.replace(FILE_PHRASE, '').replace(FILE_TAG, '');
    out = out.replace(QUALITY_TAIL, '');
    if (/[a-z]/.test(out)) out = out.replace(SHOUTED_LIST, '').replace(SHOUTED_TAIL, '');
    if (opts?.dropYear) out = out.replace(PAREN_YEAR, '');
    /*
     * A country tag standing BEHIND an audio one: "… (SE) (DUB)".
     *
     * The audio tag is kept — it is the only thing telling two rows of the same
     * Turkish drama apart — and the loop below therefore stops at it, which left
     * the country in front of it untouched. This peels the one and keeps the
     * other, so the row reads "Diary Of A Ditched Girl (DUB)".
     */
    out = out.replace(COUNTRY_BEHIND_AUDIO, '$2');
    /* The country the panel put on the end, unless the tag is about audio. */
    const tag = BARE_TAG.exec(out);
    if (tag !== null && !AUDIO_TAG.test(tag[1]!)) {
      const shorter = out.slice(0, tag.index).trim();
      if (shorter !== '') out = shorter;
    }
    /* And the separator whatever went above just orphaned — see `ORPHAN_TAIL`.
       Last in the pass so it cleans up after all of them, and inside the loop so
       a dash uncovered by the NEXT pass gets the same treatment. Guarded like the
       country tag: a name that is nothing but punctuation keeps what it has
       rather than coming back empty. */
    const kept = out.replace(ORPHAN_TAIL, '');
    if (kept !== '') out = kept;
    out = out.replace(/\s{2,}/g, ' ').trim();
    if (out === before || out === '') { out = out === '' ? before : out; break; }
  }
  // Never return nothing: a title that was ENTIRELY metadata is better shown raw.
  return out === '' ? name.trim() : out;
}

/**
 * The audio version, which a HEADING does not need and a search cannot use.
 *
 * `displayName` keeps this on purpose and the reasoning is in `AUDIO_TAG`: 17
 * titles on this line ship twice, once `(DUB)` and once `(SUB)`, and in a list
 * the bracket is the only thing telling the two rows apart. A heading shows one
 * title and has no second row to be told apart from — and the same string is
 * handed to OpenSubtitles as the query, where "American Dad! (VFQ)" matches
 * nothing at all and "American Dad!" matches the show.
 */
const AUDIO_TAIL = /\s*[([]\s*(?:DUB|SUB|SUBS|VF|VFQ|VO|VOS|VOST|VOSTFR|OV|ENG|MULTI)\s*[)\]]\s*$/i;

/**
 * The title over a picture, and the one thing it wants that a rail does not.
 *
 * This used to live in `components/DetailHero.tsx` with its own prefix, year and
 * bracket rules, and two implementations of one grammar drift — which is exactly
 * what happened, twice. Measured by putting all 5,374 names of
 * `fixtures/catalogue.json` through both: 11 came out different on the two
 * screens, and the interesting ones were not cosmetic.
 *
 *     NF - (Un)lucky Sisters (2024)   rail "(Un)lucky Sisters" / hero "lucky Sisters"
 *     QFR - (partie1) Anthony Kavanagh …  the hero dropped the only thing that
 *     QFR - (partie2) Anthony Kavanagh …  told these two rows apart
 *     (MX) (VIX 01) | …               one bracket peeled on one screen, none on
 *                                     the other
 *
 * A heading and a rail label are now the SAME string by construction, plus the
 * year (which the hero shows as its own badge) and the audio tag above. It also
 * moved out of a component so it can be unit-tested at all: the suite only reads
 * `apps/web/src/lib/*.test.ts`, so the rules that were in the `.tsx` had no test
 * of their own and the `(Un)lucky` case went unnoticed until it was measured.
 */
export function cleanTitle(raw: string): string {
  const out = displayName(raw, { dropYear: true })
    .replace(AUDIO_TAIL, '')
    /* "SD/CAM - Moana": the copy's source, which the tags already carry. */
    .replace(/^(?:SD|HD|HQ)?\s*\/?\s*(?:CAM|TS|HDCAM|HDTS|TC)\s*-\s*/i, '')
    /* "Formula 1 2024 Abu Dhabi [RACE]" → "… · Race": a trailing bracket is the
       part of the event, and a bracket is not how a title reads. */
    .replace(/\s*\[([^\]]{2,20})\]\s*$/, (_m, tag: string) => ` · ${unshout(tag)}`)
    .trim();
  // Same guarantee as `displayName`: an h1 is never empty, however tagged the name.
  return out === '' ? raw.trim() : out;
}

/**
 * What was taken OUT of a name, so it can be offered as a filter instead.
 *
 * The other half of every rule above, and it lives in this file for one reason:
 * the two must not drift. `displayName` decides what stops being text and
 * `titleTags` decides what becomes a chip, and if they read the name with
 * different patterns the rail ends up with a "4K" chip that matches nothing, or
 * a "(US)" still printed on a row that the country filter cannot see.
 *
 * Asked for as "that 4k shit and country ithink, name filters". The three tags
 * are the three things the panel writes into a title that are about the FILE
 * rather than the programme:
 *
 *     4K - Fallout (2024) (US)      quality 4K, country US
 *     4K-SC - Fallout (2024) (US)   quality 4K, source SC, country US
 *     A+ - Dear Edward (2023)       source A+
 *
 * Only the dash grammar, which is the VOD one. Channels carry their routing
 * behind a pipe and are browsed by the country tree instead; there is no rail
 * asking for these chips over `live`, so parsing it would be code with no reader.
 */
export interface TitleTags {
  /** The transcode the panel filed this copy under: 4K, UHD, FHD… */
  quality: string | null;
  /** The package it was routed through — `NF`, `D+`, `A+`, or a language code. */
  source: string | null;
  /** The production country, from the `(2024) (US)` pair at the end. */
  country: string | null;
}

const NO_TAGS: TitleTags = { quality: null, source: null, country: null };

/** Which half of a dash prefix is a transcode rather than a package. */
const QUALITY_TOKEN = /^(?:4K|UHD|FHD|HD|SD)$/i;

export function titleTags(name: string): TitleTags {
  let quality: string | null = null;
  let source: string | null = null;
  const prefix = MARKET_DASH.exec(name.replace(SUPERSCRIPT, ' '));
  if (prefix !== null) {
    for (const raw of [prefix[1], prefix[2]]) {
      if (raw === undefined) continue;
      const token = raw.toUpperCase();
      if (QUALITY_TOKEN.test(token)) { if (quality === null) quality = token; } else if (source === null) source = token;
    }
  }
  /*
   * The country, from either shape the panel writes it in.
   *
   * The pair after the year was the only one this read, because a BARE tag used
   * to be left in the name on purpose. It is stripped now — measured, 645 base
   * titles carry one and not a single one is distinguished from another by it —
   * so it has to be offered back here or the invariant this function exists for
   * breaks: every decoration the name loses is a tag the viewer can still reach.
   *
   * `AUDIO_TAG` is excluded for the same reason `displayName` keeps it: `(DUB)`
   * is not a place, and it stays in the name where a viewer can read it.
   */
  const pair = YEAR_THEN_COUNTRY.exec(name);
  const bare = BARE_TAG.exec(name.trim());
  const country = pair?.[2] !== undefined
    ? pair[2].toUpperCase()
    : bare?.[1] !== undefined && !AUDIO_TAG.test(bare[1]) ? bare[1].toUpperCase() : null;
  return { quality, source, country };
}

/** The market code a title was routed under, for a small badge. */
export function marketOf(name: string): string | null {
  const m = /^\s*\|?\s*([A-Za-z]{2,3}(?:-[A-Za-z]{2,3})?)\s*(?:\||-)\s*/.exec(name);
  return m?.[1] ? m[1].toUpperCase() : null;
}

/**
 * A provider group name, made readable — the label beside "MORE LIKE THIS".
 *
 * A category is not a title and does not go through `displayName`: its shape is
 * `|FR| NETFLIX CRIME | MYSTERE`, a region field, then a name that may itself be
 * two words joined by a pipe. `deriveFacets.cleanName` already takes the region
 * off, and 79 of this line's 232 series categories still reach the screen with
 * `4K` in them and their inner pipes intact — "DK| DANSKE SERIER 4K/UHD" is what
 * sat over the similar-titles rail.
 *
 * Applied at DISPLAY time on purpose. `cleanName` is computed once when the
 * catalogue is ingested and stored in the row (`core-store/build.ts`), so a
 * change to that rule reaches a television only after the next full re-ingest —
 * and this has to be right on the copy already on the device.
 */
export function groupLabel(name: string): string {
  const out = name
    /* A leading region field the ingest did not take, in either delimiter. */
    .replace(/^\s*\|?\s*[A-Za-z0-9+.&-]{1,10}\s*\|\s*/, '')
    /* Quality, wherever it stands, including the "4K/UHD" pair. */
    .replace(/\s*\b(?:4K|UHD|FHD|HD|SD|HEVC|2160p?|1080p?|720p?)(?:\s*\/\s*(?:4K|UHD|FHD|HD|SD))*\b/gi, ' ')
    /* What is left of a two-part name reads as one line, not as a pipe. */
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[·\s]+|[·\s]+$/g, '')
    .trim();
  /* Tier marks off, capitals set in ordinary case — see lib/titleCase.ts. */
  const done = unshout(stripMarks(out));
  return done === '' ? name.trim() : done;
}
