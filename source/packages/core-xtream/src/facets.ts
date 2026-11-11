/**
 * Derive browsable facets from provider category names.
 *
 * The panel exposes no genre field on `get_vod_streams` — genre only appears in
 * `get_vod_info`, which is one request per title and therefore impossible across
 * 50,343 movies. But the category NAMES encode genre, region and source, in
 * three languages:
 *
 *   |EN| ACTION/THRILLER      |FR| HORREUR/EPOUVANTE     |NL| KINDEREN
 *   |EN| COMEDY               |FR| COMÉDIE/DRAME         NETFLIX MOVIES
 *
 * So genres are derived once at ingest by matching keywords, which turns 119
 * opaque group names into "Comedy / Action / Horror" tabs that span languages.
 *
 * This is the app's ONLY source of genre, and it is worth being blunt about its
 * ceiling: a package called "NETFLIX MOVIES" or "TOP IMDB/OSCAR MOVIES" carries
 * no genre in its name, and no amount of keyword matching will invent one. The
 * comedies inside it cannot be reached by a genre chip. See the note on RULES
 * for the two bugs that made this far worse than the ceiling required.
 */

export type Genre =
  | 'action' | 'adventure' | 'animation' | 'comedy' | 'crime' | 'documentary'
  | 'drama' | 'family' | 'fantasy' | 'horror' | 'music' | 'mystery' | 'romance'
  | 'scifi' | 'sport' | 'thriller' | 'war' | 'western' | 'anime' | 'reality'
  | 'standup' | 'christmas' | 'classic' | 'fourk';

/**
 * The chips that REFINE rather than classify.
 *
 * Every other genre answers "what kind of film is this", and a film is one of
 * them — so picking Crime and Thriller can only sensibly mean "either", because
 * no category is both. These three answer a different question entirely: what
 * format, what era, what season. A film is Action AND 4K, Horror AND a classic.
 *
 * Mixing the two in one any-of list is why multi-select read as broken from the
 * sofa: pressing 4K on top of Action gave MORE films than Action alone, when the
 * whole point of pressing it was to see fewer. So these AND against the rest and
 * the others OR among themselves — see `categoryMatchesGenres`.
 *
 * `standup` and `anime` deliberately stay out: both already carry their parent
 * genre (`['standup','comedy']`, `['anime','animation']`), so they classify, and
 * ANDing them would ask for a film that is stand-up on top of something else.
 */
export const REFINING: ReadonlySet<Genre> = new Set<Genre>(['fourk', 'classic', 'christmas']);

export const GENRE_LABELS: Record<Genre, string> = {
  action: 'Action', adventure: 'Adventure', animation: 'Animation', comedy: 'Comedy',
  crime: 'Crime', documentary: 'Documentary', drama: 'Drama', family: 'Kids & Family',
  fantasy: 'Fantasy', horror: 'Horror', music: 'Music', mystery: 'Mystery',
  romance: 'Romance', scifi: 'Sci-Fi', sport: 'Sport', thriller: 'Thriller',
  war: 'War', western: 'Western', anime: 'Anime', reality: 'Reality',
  standup: 'Stand-up', christmas: 'Christmas', classic: 'Classics', fourk: '4K / UHD',
};

/**
 * Keyword -> genre, matched against a normalised, accent-folded name.
 *
 * ── Two things this got wrong, both measured on the live catalogue ───────────
 *
 * **Spanish was missing entirely.** The header above said EN/FR/NL, `ES` was in
 * the region list, and the catalogue is full of `|ES|` packages — so `|ES|
 * COMEDIA`, `|ES| ACCION/CRIMEN`, `|ES| CIENCIA FICCION/FANTASIA` and
 * `|ES| NIÑOS/ANIMACION` all derived NO genre at all. Pressing Comedy showed
 * five packages out of a hundred and forty-nine and none of the Spanish ones,
 * which is what "the filter doesn't work" meant.
 *
 * **`\b` at the END of a stem loses every plural and compound.** `\bthriller\b`
 * does not match "JAREN 90 THRILLERS", `\bmusic\b` does not match
 * "BROADWAY/MUSICAL", and `\bkerst\b` does not match "KERSTFILMS" — the "s" and
 * the "al" are word characters, so there is no boundary there to match. Stems
 * that can take a suffix now end in `\w*`.
 *
 * The stems that must NOT take one are marked. `war\w*` would claim WARNER and
 * every WAREHOUSE; `science\w*` would claim SCIENCE AND NATURE documentaries.
 * A wrong genre is worse than a missing one: a missing genre leaves a package
 * where browsing finds it, and a wrong one files it where nobody looks.
 */
const RULES: [RegExp, Genre[]][] = [
  [/\b(action|accion|actie)\w*/, ['action']],
  [/\b(adventure|aventure|aventura|avontuur)\w*/, ['adventure']],
  [/\b(animation|animacion|animatie|animad|dessin)\w*/, ['animation']],
  [/\banime\b|\bmanga\w*/, ['anime', 'animation']],
  [/\b(comedy|comedi|komedie|humour|humor)\w*/, ['comedy']],
  [/\bstand ?-?up\w*/, ['standup', 'comedy']],
  [/\b(crime|crimen|krimi|gangster|mafia|policier|policiac)\w*/, ['crime']],
  /* `\bdocs?\b` covers bare DOC / DOCS packages (NETFLIX DOC). `docu\w*` still
     takes documentary / documentaire; bare `doc` alone used to derive nothing. */
  [/\b(documentar|documentaire|documental|docu)\w*|\bdocs?\b/, ['documentary']],
  [/\b(drama|drame)\w*/, ['drama']],
  [/\b(children|child|kids|kinderen|enfant|jeunesse|family|famille|familie|disney|ninos|infantil)\w*/, ['family']],
  [/\b(fantasy|fantasia|fantastique|fantasty|fantastiek)\w*/, ['fantasy']],
  [/\b(horror|horreur|epouvante|griezel)\w*|\bterror\b/, ['horror']],
  [/\b(music|musical|musique|muziek|concert)\w*/, ['music']],
  [/\b(mystery|mystere|misterio|misterie)\w*/, ['mystery']],
  [/\b(romance|romantic|romantique|romantiek)\w*/, ['romance']],
  /* Bare "science" is NOT science fiction. "SCIENCE AND NATURE" is a
     documentary strand and this rule used to claim every one of them; the
     compound forms below are the only ones that mean the genre. */
  [/\b(sci ?-?fi|science ?-?fiction|ciencia ?-?ficcion)\w*/, ['scifi']],
  [/\b(sport|voetbal|formule|deporte)\w*/, ['sport']],
  [/\b(thriller|suspense|suspenso)\w*/, ['thriller']],
  /* `war` stays bounded — `war\w*` claims WARNER, and half this catalogue's
     packages are studio names. The other languages are safe to extend. */
  [/\bwar\b|\b(guerre|guerra|oorlog|belic)\w*/, ['war']],
  [/\b(western|oeste)\w*/, ['western']],
  [/\b(reality|tele ?-?realite|realiteit|emission)\w*/, ['reality']],
  [/\b(christmas|noel|navidad|kerst)\w*/, ['christmas']],
  [/\b(classic|classique|clasic|klassiek)\w*/, ['classic']],
  /* Bounded: these are tokens, not stems. `4k\w*` would take "4KIDS". */
  [/\b(4k|uhd|hdr)\b/, ['fourk']],
];

/** Region/language tag, from the `|EN|`-style prefix most categories carry. */
/*
 * The provider's own region codes, plus the free lists' country namespace.
 *
 * `[A-Z]{2}F` is a free channel's country — `NLF|`, `USF|` — which has to be
 * stripped for display exactly like `NL|` is, or a package reads as "USF| General"
 * on the setup screen. See `freeMarketCode` in grouping.ts for why the suffix
 * exists at all.
 */
const REGION_RE = /^\s*\|?\s*(EN|FR|NL|QC|DE|ES|IT|AR|TR|PT|PL|MULTI|BE|UK|US|CA|[A-Z]{2}F)\s*\|/i;

/** Streaming source, for "show me only Netflix" style browsing. */
const SOURCES: [RegExp, string][] = [
  [/netflix/i, 'Netflix'],
  [/disney/i, 'Disney+'],
  [/amazon|prime/i, 'Amazon Prime'],
  [/apple ?tv/i, 'Apple TV+'],
  [/hbo|max\b/i, 'HBO / Max'],
  [/mycanal|canal\+/i, 'Canal+'],
  [/videoland/i, 'Videoland'],
  [/paramount/i, 'Paramount+'],
  [/hulu/i, 'Hulu'],
  [/peacock/i, 'Peacock'],
  [/bioscoop|cinema|cinéma/i, 'Cinema'],
];

export interface CategoryFacets {
  genres: Genre[];
  region: string | null;
  source: string | null;
  /** Category name with the region prefix stripped, for display. */
  cleanName: string;
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[|/\\_+&,;:()[\]-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function deriveFacets(categoryName: string): CategoryFacets {
  const regionMatch = REGION_RE.exec(categoryName);
  const region = regionMatch ? regionMatch[1]!.toUpperCase() : null;
  const cleanName = categoryName.replace(REGION_RE, '').replace(/^\s*\|\s*/, '').trim();

  const folded = fold(categoryName);
  const genres = new Set<Genre>();
  for (const [re, gs] of RULES) {
    if (re.test(folded)) for (const g of gs) genres.add(g);
  }

  let source: string | null = null;
  for (const [re, name] of SOURCES) {
    if (re.test(categoryName)) {
      source = name;
      break;
    }
  }

  return { genres: [...genres], region, source, cleanName: cleanName || categoryName };
}
