/**
 * Group hierarchy derived from provider category names.
 *
 * The panel has no tree: `get_live_categories` returns 829 flat names, and 829
 * tabs is not browsing. The names are systematic though — "US| NCAAF PACKAGE",
 * "|FR| CRIME | POLICIER", "AR| BEIN SPORTS NX 4K" — so a
 * market -> package -> group hierarchy can be recovered from the text, which is
 * the only structure this provider exposes at all.
 *
 * Pure by requirement, not by taste: paths are computed once at ingest, stored,
 * and then used as filter keys, so the same name must yield the same path forever
 * or a saved filter silently stops matching.
 */

/**
 * Market/language prefix: "|EN| DRAMA" (VOD) and "US| SPORTS" (live) are the two
 * spellings, and "ASIA | 24/7 INDIA" puts a space before the bar. The token is
 * bounded to 5 characters because that is the longest real code (MULTI, EXYU),
 * which also stops the nested " | " in "CRIME | POLICIER" reading as a prefix.
 */
const MARKET_RE = /^\s*\|?\s*([A-Z0-9]{2,5})\s*\|/;

/** Segment 1 for a name that carries no market prefix at all. */
const OTHER = 'OTHER';

/**
 * Five markets the provider spells out instead of coding: "SWEDEN VIAPLAY PPV",
 * "FINLAND MTV LIIGA", "NORWAY TV2 PLAY PPV". Same shape with the delimiter
 * missing — 74 live categories that would otherwise all land in OTHER. Live only:
 * these spellings appear nowhere in the VOD lists, and a movie group that happens
 * to open with a country name must not be reparented.
 */
const BARE_MARKETS = new Set(['SWEDEN', 'DENMARK', 'NORWAY', 'FINLAND', 'ICELAND']);

/** Two spellings of one market: "FI| FINLAND" alongside "FINLAND HD & HEVC". */
const MARKET_ALIASES: Record<string, string> = { FI: 'FINLAND' };

/**
 * Readable market names, verified against each code's member CHANNEL names rather
 * than guessed from the code — this provider's codes are not ISO. IS is Israel
 * here (YES/HOT/CELLCOM boxes), not Iceland; LA is Latvia (LV| channels), KA is
 * Kazakhstan (KZ|), CG is Montenegro (Crna Gora), BH is Bosnia (BA|).
 *
 * CH, HR and IR are deliberately absent: the provider reuses each for two
 * unrelated markets — CH is Switzerland and China/Hong Kong, HR is Croatia and
 * Horse Racing, IR is Ireland and Iran — so any label would be wrong half the
 * time, and the code itself is the honest label.
 */
export const MARKET_LABELS: Record<string, string> = {
  EN: 'English', FR: 'France', NL: 'Netherlands', QC: 'Québec', DE: 'Germany',
  ES: 'Spain', IT: 'Italy', PT: 'Portugal', PL: 'Poland', AT: 'Austria',
  BE: 'Belgium', UK: 'United Kingdom', US: 'United States', CA: 'Canada',
  MULTI: 'Multi-language', EU: 'Europe', NA: 'North America', LAT: 'Latin America',
  BR: 'Brazil', CRB: 'Caribbean', SU: 'Suriname', WC: 'World', SPT: 'Sports',
  MU: 'Music', BEE: 'beIN', AR: 'Arabic', TR: 'Turkey', IS: 'Israel',
  KU: 'Kurdish', AFG: 'Afghanistan', AZ: 'Azerbaijan', UZ: 'Uzbekistan',
  TJ: 'Tajikistan', GE: 'Georgia', AM: 'Armenia', KA: 'Kazakhstan',
  RU: 'Russia', BY: 'Belarus', UKR: 'Ukraine', GR: 'Greece', CY: 'Cyprus',
  MT: 'Malta', AL: 'Albania', KO: 'Kosovo', RS: 'Serbia',
  BH: 'Bosnia & Herzegovina', HU: 'Hungary', SL: 'Slovenia', MK: 'North Macedonia',
  CG: 'Montenegro', BG: 'Bulgaria', RO: 'Romania', CZ: 'Czechia', LT: 'Lithuania',
  LA: 'Latvia', EST: 'Estonia', EXYU: 'Ex-Yugoslavia', SWEDEN: 'Sweden',
  DENMARK: 'Denmark', NORWAY: 'Norway', FINLAND: 'Finland', ICELAND: 'Iceland',
  ASIA: 'Asia', BAN: 'Bangladesh', NP: 'Nepal', SG: 'Singapore', HK: 'Hong Kong',
  SK: 'South Korea', JP: 'Japan', TH: 'Thailand', TAI: 'Taiwan', VT: 'Vietnam',
  MY: 'Malaysia', ID: 'Indonesia', PH: 'Philippines', AU: 'Australia',
  NZ: 'New Zealand', AFR: 'Africa',
};


/**
 * Countries, for the free public lists — a SEPARATE namespace from the codes above.
 *
 * The provider's codes are not ISO and several of them mean something else: IS is
 * Israel here and Iceland in ISO, SK is South Korea here and Slovakia in ISO, LA
 * is Latvia here and Laos in ISO. Both kinds of channel now live in one catalogue,
 * so one lookup keyed on a bare two-letter code cannot be right for both.
 *
 * Free channels therefore carry the country code with an `F` suffix — `NLF`,
 * `ISF`, `SKF` — which no provider code collides with, and this table names them.
 * The suffix never reaches a viewer: `labelFor` resolves it to the country.
 */
const FREE_MARKET_RE = /^([A-Z]{2})F$/;

export const ISO_COUNTRY_LABELS: Record<string, string> = {
  AD: 'Andorra', AE: 'United Arab Emirates', AF: 'Afghanistan', AG: 'Antigua and Barbuda',
  AI: 'Anguilla', AL: 'Albania', AM: 'Armenia', AO: 'Angola', AQ: 'Antarctica',
  AR: 'Argentina', AS: 'American Samoa', AT: 'Austria', AU: 'Australia', AW: 'Aruba',
  AX: 'Aland', AZ: 'Azerbaijan', BA: 'Bosnia and Herzegovina', BB: 'Barbados',
  BD: 'Bangladesh', BE: 'Belgium', BF: 'Burkina Faso', BG: 'Bulgaria', BH: 'Bahrain',
  BI: 'Burundi', BJ: 'Benin', BL: 'Saint Barthélemy', BM: 'Bermuda', BN: 'Brunei',
  BO: 'Bolivia', BQ: 'Bonaire', BR: 'Brazil', BS: 'Bahamas', BT: 'Bhutan',
  BV: 'Bouvet Island', BW: 'Botswana', BY: 'Belarus', BZ: 'Belize', CA: 'Canada',
  CC: 'Cocos (Keeling) Islands', CD: 'Democratic Republic of the Congo',
  CF: 'Central African Republic', CG: 'Republic of the Congo', CH: 'Switzerland',
  CI: 'Ivory Coast', CK: 'Cook Islands', CL: 'Chile', CM: 'Cameroon', CN: 'China',
  CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba', CV: 'Cape Verde', CW: 'Curacao',
  CX: 'Christmas Island', CY: 'Cyprus', CZ: 'Czech Republic', DE: 'Germany', DJ: 'Djibouti',
  DK: 'Denmark', DM: 'Dominica', DO: 'Dominican Republic', DZ: 'Algeria', EC: 'Ecuador',
  EE: 'Estonia', EG: 'Egypt', EH: 'Western Sahara', ER: 'Eritrea', ES: 'Spain',
  ET: 'Ethiopia', FI: 'Finland', FJ: 'Fiji', FK: 'Falkland Islands', FM: 'Micronesia',
  FO: 'Faroe Islands', FR: 'France', GA: 'Gabon', GD: 'Grenada', GE: 'Georgia',
  GF: 'French Guiana', GG: 'Guernsey', GH: 'Ghana', GI: 'Gibraltar', GL: 'Greenland',
  GM: 'Gambia', GN: 'Guinea', GP: 'Guadeloupe', GQ: 'Equatorial Guinea', GR: 'Greece',
  GS: 'South Georgia and the South Sandwich Islands', GT: 'Guatemala', GU: 'Guam',
  GW: 'Guinea-Bissau', GY: 'Guyana', HK: 'Hong Kong',
  HM: 'Heard Island and McDonald Islands', HN: 'Honduras', HR: 'Croatia', HT: 'Haiti',
  HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel', IM: 'Isle of Man',
  IN: 'India', IO: 'British Indian Ocean Territory', IQ: 'Iraq', IR: 'Iran', IS: 'Iceland',
  IT: 'Italy', JE: 'Jersey', JM: 'Jamaica', JO: 'Jordan', JP: 'Japan', KE: 'Kenya',
  KG: 'Kyrgyzstan', KH: 'Cambodia', KI: 'Kiribati', KM: 'Comoros',
  KN: 'Saint Kitts and Nevis', KP: 'North Korea', KR: 'South Korea', KW: 'Kuwait',
  KY: 'Cayman Islands', KZ: 'Kazakhstan', LA: 'Laos', LB: 'Lebanon', LC: 'Saint Lucia',
  LI: 'Liechtenstein', LK: 'Sri Lanka', LR: 'Liberia', LS: 'Lesotho', LT: 'Lithuania',
  LU: 'Luxembourg', LV: 'Latvia', LY: 'Libya', MA: 'Morocco', MC: 'Monaco', MD: 'Moldova',
  ME: 'Montenegro', MF: 'Saint Martin', MG: 'Madagascar', MH: 'Marshall Islands',
  MK: 'North Macedonia', ML: 'Mali', MM: 'Myanmar', MN: 'Mongolia', MO: 'Macao',
  MP: 'Northern Mariana Islands', MQ: 'Martinique', MR: 'Mauritania', MS: 'Montserrat',
  MT: 'Malta', MU: 'Mauritius', MV: 'Maldives', MW: 'Malawi', MX: 'Mexico', MY: 'Malaysia',
  MZ: 'Mozambique', NA: 'Namibia', NC: 'New Caledonia', NE: 'Niger', NF: 'Norfolk Island',
  NG: 'Nigeria', NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway', NP: 'Nepal', NR: 'Nauru',
  NU: 'Niue', NZ: 'New Zealand', OM: 'Oman', PA: 'Panama', PE: 'Peru',
  PF: 'French Polynesia', PG: 'Papua New Guinea', PH: 'Philippines', PK: 'Pakistan',
  PL: 'Poland', PM: 'Saint Pierre and Miquelon', PN: 'Pitcairn Islands', PR: 'Puerto Rico',
  PS: 'Palestine', PT: 'Portugal', PW: 'Palau', PY: 'Paraguay', QA: 'Qatar', RE: 'Reunion',
  RO: 'Romania', RS: 'Serbia', RU: 'Russia', RW: 'Rwanda', SA: 'Saudi Arabia',
  SB: 'Solomon Islands', SC: 'Seychelles', SD: 'Sudan', SE: 'Sweden', SG: 'Singapore',
  SH: 'Saint Helena', SI: 'Slovenia', SJ: 'Svalbard and Jan Mayen', SK: 'Slovakia',
  SL: 'Sierra Leone', SM: 'San Marino', SN: 'Senegal', SO: 'Somalia', SR: 'Suriname',
  SS: 'South Sudan', ST: 'Sao Tome and Principe', SV: 'El Salvador', SX: 'Sint Maarten',
  SY: 'Syria', SZ: 'Swaziland', TC: 'Turks and Caicos Islands', TD: 'Chad',
  TF: 'French Southern Territories', TG: 'Togo', TH: 'Thailand', TJ: 'Tajikistan',
  TK: 'Tokelau', TL: 'East Timor', TM: 'Turkmenistan', TN: 'Tunisia', TO: 'Tonga',
  TR: 'Turkiye', TT: 'Trinidad and Tobago', TV: 'Tuvalu', TW: 'Taiwan', TZ: 'Tanzania',
  UA: 'Ukraine', UG: 'Uganda', UK: 'United Kingdom', UM: 'U.S. Minor Outlying Islands',
  US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan', VA: 'Vatican City',
  VC: 'Saint Vincent and the Grenadines', VE: 'Venezuela', VG: 'British Virgin Islands',
  VI: 'U.S. Virgin Islands', VN: 'Vietnam', VU: 'Vanuatu', WF: 'Wallis and Futuna',
  WS: 'Samoa', XK: 'Kosovo', YE: 'Yemen', YT: 'Mayotte', ZA: 'South Africa', ZM: 'Zambia',
  ZW: 'Zimbabwe'
};

/** The market segment a free channel from `<code>` belongs to. */
export function freeMarketCode(countryCode: string): string {
  return `${countryCode.toUpperCase()}F`;
}

/**
 * Decorative superscript markers: "MK| MACEDONIA ⱽᴵᴾ ᴿᴬᵂ", "US| PRIME ᴿᴬᵂ ⁶⁰ᶠᵖˢ",
 * "AR| STC EXCLUSIVE ʰᵉᵛᶜ". They mark stream flavour, never a different group, and
 * dropping them merges spellings of one group ("SLOVENIA" / "SLOVENIA ⱽᴵᴾ ᴿᴬᵂ").
 * The ASCII words stay: "MEXICO VIP" really is a different channel set from
 * "MEXICO", and PPV / PACKAGE / GROUP / REPLAY / 4K all carry meaning.
 */
const SUPERSCRIPT_RE = /[ª²³¹ºʰ-˿ᴬ-ᶿ⁰-₟ⱼⱽ]/g;

/** Nested group separators, longest first so ">>" never matches as ">". */
const NESTED_RE = /\s*(?:\|{1,2}|>>|>|\s&\s|\s-\s)\s*/;

/**
 * Tokens whose slash belongs to the token. Every entry but AC/DC and R&B (both
 * named in the brief, neither present in this catalogue) comes from a real name:
 * "24/7 SHOWS VIP", "US| B/R MAX SPORTS PPV", "IT| SERIE A/B/C".
 */
const SLASH_TOKENS = ['24/7', 'AC/DC', 'R&B', 'B/R', 'S/W'];

/**
 * Quality words that sit either side of a slash as one token: "IT| ITALY UHD/4K",
 * "|FR| FILMS 4K/3D", "IT| ITALY FHD/HEVC".
 */
const QUALITY = new Set(['4K', '8K', '3D', 'HD', 'FHD', 'UHD', 'SD', 'HEVC', 'RAW']);

/**
 * Streaming families, canonical name first. The provider spells one brand several
 * ways across markets — "DISNEY +", "DISNEY+", "DISNEY PLUS"; "PRIME", "PRIME
 * VIDEO", "AMAZON PRIME +" — and buries sub-collections in the same string
 * ("NETFLIX KIDS"), so a match both canonicalises the name and pushes the rest
 * down a level. Aliases are tried longest-first, hence "AMAZON PRIME" before
 * "PRIME", and "HBO MAX PPV" lands under HBO rather than MAX.
 */
const FAMILIES: [string, string[]][] = [
  ['NETFLIX', ['NETFLIX']],
  ['DISNEY+', ['DISNEY+', 'DISNEY']],
  ['AMAZON PRIME', ['AMAZON PRIME+', 'AMAZON PRIME', 'PRIME VIDEO', 'PRIME+', 'PRIME']],
  ['APPLE TV+', ['APPLE TV+', 'APPLE TV', 'APPLE+', 'APPLE']],
  ['HBO', ['HBO']],
  ['PARAMOUNT+', ['PARAMOUNT+', 'PARAMOUNT']],
  ['HULU', ['HULU']],
  ['PEACOCK', ['PEACOCK']],
  ['DISCOVERY+', ['DISCOVERY+', 'DISCOVERY']],
  ['STARZPLAY', ['STARZPLAY', 'STARZ PLAY', 'STARZ']],
  ['VIAPLAY', ['VIAPLAY']],
  ['DAZN', ['DAZN']],
  ['MAX', ['MAX']],
  ['ESPN', ['ESPN+', 'ESPN']],
  ['SKY', ['SKY']],
  ['BEIN SPORTS', ['BEIN SPORTS']],
  ['CANAL+', ['MYCANAL', 'CANAL PLAY', 'CANAL+', 'CANAL']],
  ['MOVISTAR+', ['MOVISTAR+', 'MOVISTAR']],
  ['VIX', ['VIX+', 'VIX']],
  ['TV2 PLAY', ['TV2 PLAY']],
  ['TELIA PLAY', ['TELIA PLAY']],
  ['SHAHID', ['SHAHID']],
  ['FLO', ['FLO']],
  ['YUPP TV', ['YUPP TV']],
  ['WOW', ['WOW']],
  ['MAGENTA', ['MAGENTA']],
  ['RTL+', ['RTL+', 'RTL']],
  ['JOYN', ['JOYN']],
  ['ZIGGO', ['ZIGGO']],
  ['ODIDO', ['ODIDO']],
  ['SOLO', ['SOLO']],
  ['DIREC TV', ['DIREC TV']],
  ['TDT', ['TDT']],
  ['M+', ['M+']],
];

const ALIASES: [string, string][] = FAMILIES.flatMap(([canon, aliases]) =>
  aliases.map((a) => [a, canon] as [string, string]),
).sort((a, b) => b[0].length - a[0].length);

/** Stands in for a slash that belongs to a token; restored as "-" at the end. */
const HOLD = '\u0001';

function clean(s: string): string {
  let out = s
    .replace(SUPERSCRIPT_RE, ' ')
    .toUpperCase()
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // "DISNEY +" / "DISNEY PLUS" / "MOVISTAR PLUS+" are all one brand spelling. A
    // detached "+" only ever ends a name here; mid-name it means "and", as in
    // "FORMULA 1 + MOTO GP", which must not be glued into a brand.
    .replace(/\s+PLUS\b/g, '+')
    .replace(/\s+\+$/, '+')
    .replace(/\++/g, '+');
  for (const tok of SLASH_TOKENS) {
    out = out.split(tok).join(tok.split('/').join(HOLD));
  }
  return out;
}

/**
 * Drop separators a stripped superscript left dangling: "MAX ESPN ᴴᴰ/ᴿᴬᵂ" -> "MAX ESPN".
 * "+" is not in the set — it is the last character of DISNEY+, PARAMOUNT+ and M+.
 */
function trimEdges(s: string): string {
  return s.replace(/^[\s/&>|,;-]+/, '').replace(/[\s/&>|,;-]+$/, '').trim();
}

function splitSlashes(part: string): string[] {
  const out: string[] = [];
  let buf: string | null = null;
  for (const raw of part.split('/')) {
    const chunk = raw.trim();
    if (buf === null) {
      buf = chunk;
      continue;
    }
    const left = buf.slice(buf.lastIndexOf(' ') + 1);
    const right = chunk.split(' ')[0] ?? '';
    // A slash separates two groups only when both sides read as words: "IT| SERIE
    // A/B/C" lists single letters, "4K/3D" and "UHD/4K" pair two quality tokens. A
    // digit is a word here, so "FORMULA 1 / MOTOGP" still splits, and one quality
    // token is not enough — "PRE-RELEASES/SD CAM" is two groups.
    const glued =
      /^[A-Z]$/.test(left) || /^[A-Z]$/.test(right) || (QUALITY.has(left) && QUALITY.has(right));
    if (glued) {
      buf = `${buf}${HOLD}${chunk}`;
    } else {
      out.push(buf);
      buf = chunk;
    }
  }
  if (buf !== null) out.push(buf);
  return out;
}

/** Collapse a family alias to its canonical name, pushing the rest down a level. */
function applyFamily(part: string): string[] {
  for (const [alias, canon] of ALIASES) {
    if (part === alias) return [canon];
    if (part.startsWith(`${alias} `)) return [canon, part.slice(alias.length + 1).trim()];
  }
  return [part];
}

/**
 * 1-3 UPPERCASE segments: market, primary group, nested group.
 *
 * Segments never contain "/" — a retained token slash becomes "-" ("24/7 SHOWS"
 * -> "24-7 SHOWS") because the API identifies a node by its slash-joined path, and
 * a slash inside a segment would make that id impossible to parse back.
 */
export function derivePath(categoryName: string, kind: number): string[] {
  const raw = clean(categoryName);
  let market = OTHER;
  let rest = raw;

  const m = MARKET_RE.exec(raw);
  if (m) {
    market = m[1]!;
    rest = raw.slice(m[0].length);
  } else if (kind === 1) {
    const first = raw.split(' ')[0] ?? '';
    if (BARE_MARKETS.has(first)) {
      market = first;
      rest = raw.slice(first.length);
    }
  }
  market = MARKET_ALIASES[market] ?? market;

  const parts = trimEdges(rest)
    .split(NESTED_RE)
    .flatMap((p) => splitSlashes(p))
    .map((p) => trimEdges(p).split(HOLD).join('-'))
    .filter((p) => p !== '');

  const head = parts.length > 0 ? applyFamily(parts[0]!) : [];
  const tail = [...head, ...parts.slice(1)].filter((p) => p !== '');
  // "FI| FINLAND" would otherwise nest FINLAND under FINLAND.
  if (tail[0] === market) tail.shift();
  return [market, ...tail.slice(0, 2)];
}

/**
 * Acronyms that must survive title-casing.
 *
 * Three rules cover most of them without a list: anything with a digit ("4K",
 * "F1", "3840P"), anything two characters or shorter ("UK", "FA", "M+") and
 * anything with no vowel at all ("PPV", "HD", "NHL"). These are the leftovers —
 * pronounceable acronyms that would otherwise come out as "Bein" or "Espn".
 */
const KEEP = new Set([
  'BEIN', 'DAZN', 'ESPN', 'HEVC', 'UEFA', 'IMDB', 'NCAAF', 'NCAAB', 'WNBA',
  'MILB', 'NBA', 'UFC', 'WWE', 'EPL', 'ABC', 'FOX', 'HBO', 'ITV', 'BBCI',
  'AHL', 'OHL', 'GAA', 'AMP', 'NPO', 'OSN', 'AFL', 'FIFA', 'IPL', 'NIFL',
  'LOI', 'RFEF', 'AMC', 'MGM', 'VIP', 'UHD', 'ATG', 'AZAM', 'MOTOGP', 'BET',
]);

function keepAsIs(word: string): boolean {
  if (/\d/.test(word)) return true;
  if (word.length <= 2) return true;
  // A trailing "+" is branding, not part of the acronym: FIFA+, AMC+, RTL+.
  if (KEEP.has(word.replace(/\+$/, ''))) return true;
  return !/[AEIOUYÁÉÍÓÚÀÈÊÎÔÛÄÖÜÅÆØ]/.test(word);
}

function titleCase(segment: string): string {
  return segment.replace(/[^\s'-]+/g, (word) =>
    keepAsIs(word) ? word : word.charAt(0) + word.slice(1).toLowerCase(),
  );
}

/** Display label for one path segment. Market codes are expanded at depth 1. */
export function labelFor(segment: string, depth: number): string {
  if (depth > 1) return titleCase(segment);
  if (segment === OTHER) return 'Other';
  const free = FREE_MARKET_RE.exec(segment);
  if (free !== null) {
    const name = ISO_COUNTRY_LABELS[free[1]!];
    /* Marked, because both kinds of channel share one library: a device with a
       subscription AND the free lists has two Dutch markets, and two rows both
       called "Netherlands" is a puzzle rather than a filter. */
    if (name !== undefined) return `${name} (free)`;
  }
  // An unlabelled code is one the provider reuses for two markets (CH, HR, IR):
  // the code itself is the only honest label.
  return MARKET_LABELS[segment] ?? segment;
}
