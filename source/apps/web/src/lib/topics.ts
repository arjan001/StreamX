/**
 * What a channel is ABOUT, across every language and brand a panel uses.
 *
 * Asked for as a way to browse "by categories like this or by country": Football,
 * Rugby, Tennis, Cricket, Formula 1, Boxing, Darts, Golf, Horse Racing, Snooker,
 * Basketball, Athletics, Cycling, Ice Hockey, American Football. Sport only —
 * this module used to classify news/kids/documentary/music/religion/movies/
 * entertainment as well, for the Live "Categories" tab; that tab is gone and so
 * is the classification it alone used.
 *
 * ── why it cannot be read off the category name ──
 *
 * Measured against the frozen fixture (real rows from the owner's panel): 223
 * live categories, and sport hides behind brands and six languages —
 * `ES| M+ LALIGA`, `NL| ZIGGO SPORTS`, `BR| DESPORTO`, `UK| EPL PREMIER LEAGUE`,
 * `UK| APPLE TV F1 PPV`, `UK| UFC/BOXING PPV`, `NL| CLIPMYHORSE PPV`,
 * `BR| NBA PASS PPV`. And the big packages mix everything: `UK| SPORTS` holds
 * Sky Sports F1, Sky Sports Golf and Sky Sports Racing side by side, so a
 * channel's own name decides its sport, and its package only decides that it is
 * sport at all.
 *
 * So each channel is asked twice — its name first, because it is the more
 * specific, then its package — against keyword sets written in the languages
 * this catalogue actually carries. A channel can belong to more than one topic
 * (a football channel is also a sports channel), and one that matches nothing
 * belongs to none: it stays under Countries, where it always was.
 *
 * Pure, and tested against those real names in `topics.test.ts`.
 */

export interface Topic {
  id: string;
  label: string;
  /** Set on a sport: the topic it sits under in the list. */
  parent?: string;
}

/* ── the words ─────────────────────────────────────────────────────────────── */

/** A keyword list, written the way it reads; matched as whole words, see `phrases`. */
const words = (list: readonly string[]): readonly string[] => list;

interface Rule { topic: Topic; match: readonly string[] }

/* Order matters where two sports share a word: American football before
   football, basketball's "LIGA ACB" before football's "LIGA", horse racing's
   "RACING TV" before motorsport. The first sport that matches wins. */
const SPORT_RULES: readonly Rule[] = [
  {
    topic: { id: 'nfl', label: 'American Football', parent: 'sports' },
    match: words(['NFL', 'AMERICAN FOOTBALL', 'SUPER BOWL', 'REDZONE', 'RED ZONE', 'NCAAF', 'COLLEGE FOOTBALL', 'CFL']),
  },
  {
    topic: { id: 'basketball', label: 'Basketball', parent: 'sports' },
    match: words(['BASKETBALL', 'BASKET', 'BALONCESTO', 'BASQUETE', 'NBA', 'WNBA', 'EUROLEAGUE', 'EUROLIGA', 'ACB', 'LIGA ACB', 'NCAAB']),
  },
  {
    topic: { id: 'icehockey', label: 'Ice Hockey', parent: 'sports' },
    match: words(['ICE HOCKEY', 'HOCKEY', 'NHL', 'KHL', 'IJSHOCKEY', 'EISHOCKEY', 'HOCKEY SOBRE HIELO']),
  },
  {
    topic: { id: 'horseracing', label: 'Horse Racing', parent: 'sports' },
    match: words(['HORSE', 'HORSES', 'HORSE RACING', 'RACING TV', 'RACING UK', 'SKY SPORTS RACING', 'AT THE RACES',
      /* Not TVG: in Spain that is TV Galicia. */
      'TRACKSIDE', 'EQUIDIA', 'CLIPMYHORSE', 'EQUESTRIAN', 'HIPICA', 'HIPODROMO', 'TURF', 'PMU']),
  },
  {
    topic: { id: 'motorsport', label: 'Formula 1 & Motorsport', parent: 'sports' },
    match: words(['F1', 'FORMULA 1', 'FORMULA1', 'FORMULA', 'FORMULE 1', 'FORMEL 1', 'MOTOGP', 'MOTO GP', 'NASCAR',
      'INDYCAR', 'INDY', 'WRC', 'RALLY', 'SUPERBIKE', 'WSBK', 'DTM', 'MOTORSPORT', 'MOTORSPORTS', 'MOTORS TV',
      'MOTOR', 'MOTORVISION', 'LE MANS', 'WEC']),
  },
  {
    topic: { id: 'rugby', label: 'Rugby', parent: 'sports' },
    match: words(['RUGBY', 'SIX NATIONS', '6 NATIONS', 'SUPER RUGBY', 'NRL', 'URC']),
  },
  {
    topic: { id: 'tennis', label: 'Tennis', parent: 'sports' },
    match: words(['TENNIS', 'TENIS', 'ATP', 'WTA', 'WIMBLEDON', 'ROLAND GARROS', 'US OPEN TENNIS', 'TENNIS CHANNEL']),
  },
  {
    topic: { id: 'cricket', label: 'Cricket', parent: 'sports' },
    match: words(['CRICKET', 'IPL', 'WILLOW', 'ASHES', 'T20']),
  },
  {
    topic: { id: 'boxing', label: 'Boxing & Fighting', parent: 'sports' },
    /* Not bare FIGHT: "Christmas Great Light Fight" is a lights show. */
    match: words(['BOXING', 'BOXEO', 'BOKSEN', 'BOXE', 'BOXEN', 'UFC', 'MMA', 'FIGHT PASS', 'FIGHT TIME',
      'FIGHT NETWORK', 'FIGHT SPORTS', 'FIGHTBOX', 'FIGHT NIGHT', 'FIGHTING', 'WWE',
      'WRESTLING', 'LUCHA', 'PFL', 'BELLATOR', 'KICKBOXING', 'ONE CHAMPIONSHIP']),
  },
  {
    topic: { id: 'darts', label: 'Darts', parent: 'sports' },
    match: words(['DARTS', 'DART', 'PDC', 'BDO']),
  },
  {
    topic: { id: 'golf', label: 'Golf', parent: 'sports' },
    match: words(['GOLF', 'PGA', 'LPGA', 'RYDER CUP', 'DP WORLD TOUR', 'LIV GOLF']),
  },
  {
    topic: { id: 'snooker', label: 'Snooker', parent: 'sports' },
    match: words(['SNOOKER', 'BILLIARD', 'BILLIARDS', 'BILLAR', 'POOL']),
  },
  {
    topic: { id: 'athletics', label: 'Athletics', parent: 'sports' },
    match: words(['ATHLETICS', 'ATLETISMO', 'ATLETIEK', 'LEICHTATHLETIK', 'ATHLETISME', 'MARATHON', 'OLYMPIC',
      'OLYMPICS', 'OLIMPICO', 'DIAMOND LEAGUE']),
  },
  {
    topic: { id: 'cycling', label: 'Cycling', parent: 'sports' },
    match: words(['CYCLING', 'CICLISMO', 'WIELRENNEN', 'RADSPORT', 'CYCLISME', 'TOUR DE FRANCE', 'GIRO', 'VUELTA', 'GCN']),
  },
  {
    topic: { id: 'football', label: 'Football', parent: 'sports' },
    match: words(['FOOTBALL', 'SOCCER', 'FUTBOL', 'FUTEBOL', 'VOETBAL', 'FUSSBALL', 'FUBBALL', 'CALCIO', 'FOOT',
      'LALIGA', 'LA LIGA', 'LIGA', 'LIGA DE CAMPEONES', 'CAMPEONES', 'CHAMPIONS LEAGUE', 'CHAMPIONS', 'PREMIER LEAGUE',
      'EPL', 'SERIE A', 'BUNDESLIGA', 'LIGUE 1', 'EREDIVISIE', 'JUPILER', 'PRO LEAGUE', 'UEFA', 'FIFA', 'MLS',
      'COPA', 'EFL', 'SPFL', 'SCOTTISH FOOTBALL', 'CYMRU FOOTBALL', 'MUTV', 'LFC TV', 'CHELSEA TV', 'BARCA TV',
      'REAL MADRID TV', 'R MADRID TV', 'GOLTV', 'GOL', 'BRASILEIRAO', 'LIGA MX', 'SUPERLIG']),
  },
];

/* Sport, with the sport itself not named: brands and the word in six languages. */
const SPORT_GENERAL = words(['SPORT', 'SPORTS', 'DEPORTES', 'DEPORTE', 'DEPORTIVO', 'DESPORTO', 'DESPORTOS', 'ESPORTE',
  'ESPORTES', 'SPORTV', 'SPORTTV', 'DAZN', 'ESPN', 'EUROSPORT', 'BEIN', 'SKY SPORT', 'SKY SPORTS', 'TNT SPORT',
  'TNT SPORTS', 'BT SPORT', 'VIAPLAY SPORT', 'ZIGGO SPORT', 'ZIGGO SPORTS', 'CANAL+ SPORT', 'ARENA SPORT',
  'PREMIER SPORTS', 'MOVISTAR DEPORTES', 'ELEVEN', 'ELEVEN SPORTS', 'SPORT1', 'SPORTDIGITAL', 'SPORTKLUB', 'GAA',
  'VOLLEY', 'VOLLEYBALL', 'HANDBALL', 'BASEBALL', 'MLB', 'FANATIZ', 'POLSAT SPORT', 'NOVA SPORT', 'SUPERSPORT',
  'STAR SPORTS', 'SONY TEN', 'SONY SIX', 'FOX SPORTS', 'CBS SPORTS', 'NBC SPORTS', 'TYC SPORTS', 'TUDN', 'GOLAZO']);

/*
 * Sport that names itself and is none of the fifteen.
 *
 * These were only "sport" words, so a channel called one of them borrowed the
 * PACKAGE's sport — and a PPV feed keeps its package while its name changes to
 * whatever event it carries that day: the owner's Football list showed "U15
 * Baseball World Cup 2026 - Day 4" on `FR: SOCCER PPV 14`. Named here, the name
 * wins and the channel goes to Other sport.
 */
const OTHER_SPORT_NAMES = words(['BASEBALL', 'BEISBOL', 'BEISEBOL', 'MLB', 'KBO', 'NPB', 'SOFTBALL', 'HANDBALL',
  'BALONMANO', 'HANDEBOL', 'HANDBAL', 'VOLLEY', 'VOLLEYBALL', 'VOLEIBOL', 'VOLEI', 'VOLLEYBAL', 'BADMINTON',
  'SQUASH', 'LACROSSE', 'WATER POLO', 'WATERPOLO', 'BIATHLON', 'CURLING', 'ESPORTS', 'KABADDI', 'HURLING',
  'NETBALL', 'FLOORBALL', 'BANDY', 'SWIMMING', 'GYMNASTICS', 'SKIING', 'SKI JUMPING']);

/*
 * Two teams of one league, when nothing else in the name says the sport.
 *
 * "Eagles vs. Bears" on a soccer PPV feed names no sport at all, and was filed
 * under the package's. Both sides being teams of the same North American league
 * is as good as the name saying so. Both sides, and one league only: a lone
 * "Eagles" is also Crystal Palace, and "Giants vs Cardinals" is two leagues'.
 */
const LEAGUES: readonly { sport: string | null; teams: readonly string[] }[] = [
  { sport: 'nfl', teams: ['49ERS', 'BEARS', 'BENGALS', 'BILLS', 'BRONCOS', 'BROWNS', 'BUCCANEERS', 'BUCS', 'CARDINALS',
    'CHARGERS', 'CHIEFS', 'COLTS', 'COMMANDERS', 'COWBOYS', 'DOLPHINS', 'EAGLES', 'FALCONS', 'GIANTS', 'JAGUARS',
    'JETS', 'LIONS', 'PACKERS', 'PANTHERS', 'PATRIOTS', 'RAIDERS', 'RAMS', 'RAVENS', 'SAINTS', 'SEAHAWKS',
    'STEELERS', 'TEXANS', 'TITANS', 'VIKINGS'] },
  { sport: 'basketball', teams: ['76ERS', 'SIXERS', 'BUCKS', 'BULLS', 'CAVALIERS', 'CAVS', 'CELTICS', 'CLIPPERS',
    'GRIZZLIES', 'HAWKS', 'HEAT', 'HORNETS', 'JAZZ', 'KINGS', 'KNICKS', 'LAKERS', 'MAGIC', 'MAVERICKS', 'MAVS', 'NETS',
    'NUGGETS', 'PACERS', 'PELICANS', 'PISTONS', 'RAPTORS', 'ROCKETS', 'SPURS', 'SUNS', 'THUNDER', 'TIMBERWOLVES',
    'BLAZERS', 'TRAIL BLAZERS', 'WARRIORS', 'WIZARDS'] },
  { sport: 'icehockey', teams: ['AVALANCHE', 'BLACKHAWKS', 'BLUE JACKETS', 'BLUES', 'BRUINS', 'CANADIENS', 'CANUCKS',
    'CAPITALS', 'DEVILS', 'DUCKS', 'FLAMES', 'FLYERS', 'GOLDEN KNIGHTS', 'HURRICANES', 'ISLANDERS', 'JETS', 'KINGS',
    'KRAKEN', 'LIGHTNING', 'MAPLE LEAFS', 'OILERS', 'PANTHERS', 'PENGUINS', 'PREDATORS', 'RANGERS', 'RED WINGS',
    'SABRES', 'SENATORS', 'SHARKS', 'STARS', 'WILD', 'MAMMOTH'] },
  /* Baseball is not one of the fifteen: Other sport. */
  { sport: null, teams: ['ANGELS', 'ASTROS', 'ATHLETICS', 'BLUE JAYS', 'BRAVES', 'BREWERS', 'CARDINALS', 'CUBS',
    'DIAMONDBACKS', 'DODGERS', 'GIANTS', 'GUARDIANS', 'MARINERS', 'MARLINS', 'METS', 'NATIONALS', 'ORIOLES',
    'PADRES', 'PHILLIES', 'PIRATES', 'RANGERS', 'RAYS', 'RED SOX', 'REDS', 'ROCKIES', 'ROYALS', 'TIGERS', 'TWINS',
    'WHITE SOX', 'YANKEES'] },
];
const TEAM_LEAGUES = new Map<string, number[]>();
LEAGUES.forEach((l, i) => {
  for (const t of l.teams) TEAM_LEAGUES.set(t, [...(TEAM_LEAGUES.get(t) ?? []), i]);
});

/** Which league a "team vs team" name is, or undefined when it is not one — or
    could be more than one. `null` is a league outside the fifteen. */
function leagueOf(name: string): string | null | undefined {
  const w = name.trim().split(' ');
  const at = w.findIndex((x) => x === 'VS' || x === 'V' || x === 'VS.' || x === 'AT');
  if (at <= 0 || at >= w.length - 1) return undefined;
  const leaguesOf = (words: string[]): Set<number> => {
    const out = new Set<number>();
    for (let n = 1; n <= 2; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        for (const l of TEAM_LEAGUES.get(words.slice(i, i + n).join(' ')) ?? []) out.add(l);
      }
    }
    return out;
  };
  const left = leaguesOf(w.slice(Math.max(0, at - 2), at));
  const right = leaguesOf(w.slice(at + 1, at + 4));
  const both = [...left].filter((l) => right.has(l));
  return both.length === 1 ? LEAGUES[both[0]!]!.sport : undefined;
}

export const SPORTS_TOPIC: Topic = { id: 'sports', label: 'Sports' };

/**
 * The part of a channel name that says what it is carrying.
 *
 * An event listing ends with the FEED it is on: `Lei Peifan - Mark Selby British
 * Open | 2ª ronda | … | ES: SOCCER PPV 2`. Read whole, that name says SOCCER,
 * and every PPV event — snooker, cycling, baseball — was filed under Football.
 * So a `|` segment naming a PPV feed is left out, but only when something else
 * in the name is left to read: `UK| UFC/BOXING PPV` is a channel, not a listing,
 * and its PPV segment is the whole of what it says.
 */
export function eventCore(raw: string): string {
  if (!raw.includes('|') || !/PPV/i.test(raw)) return raw;
  const parts = raw.split('|').map((x) => x.trim()).filter((x) => x !== '');
  const feed = (x: string) => /\bPPV\b/i.test(x);
  const said = parts.filter((x) => !feed(x) && !/^[A-Z]{2,3}$/.test(x));
  if (said.length === 0) return raw;
  return parts.filter((x) => !feed(x)).join(' | ');
}

/* The order asked for — which is not the order the rules must be tried in. */
const SPORT_ORDER: readonly string[] = [
  'football', 'rugby', 'tennis', 'cricket', 'motorsport', 'boxing', 'darts', 'golf', 'horseracing',
  'snooker', 'basketball', 'athletics', 'cycling', 'icehockey', 'nfl',
];

/** The 15 sports, in the owner's own order — what the Sports rail lists. */
export const SPORTS: readonly Topic[] = SPORT_RULES.map((r) => r.topic)
  .sort((a, b) => SPORT_ORDER.indexOf(a.id) - SPORT_ORDER.indexOf(b.id));

/** Every topic, in the order the list shows them: Sports, then its sports. */
export const TOPICS: readonly Topic[] = [SPORTS_TOPIC, ...SPORTS];

export function topicById(id: string): Topic | undefined {
  return TOPICS.find((t) => t.id === id);
}

/**
 * Upper-case, accents off, the country prefix gone.
 *
 * `|ES| PELICULAS`, `NL| SPORT`, `UK: NEWS`, `[BR] DESPORTO` — the prefix is a
 * country, which is the OTHER tab's business, and `ES` would otherwise read as
 * a word.
 */
const NOT_ASCII = /[^\x00-\x7f]/;
const ACCENTS = /[̀-ͯ]/g;

export function normalise(s: string): string {
  /* Accents only when there are any: nearly every channel name is plain ASCII,
     and NFD is the costliest step here. */
  const plain = NOT_ASCII.test(s) ? s.normalize('NFD').replace(ACCENTS, '') : s;
  return plain
    .toUpperCase()
    .replace(/^\s*[|[(]?\s*[A-Z]{2,3}\s*[|\]):]\s*/, '')
    .replace(/[^A-Z0-9+]+/g, ' ')
    .trim();
}

/**
 * The topics one channel belongs to, most specific first.
 *
 * The channel's own name is asked before its package: `UK| SPORTS` says only
 * "sport", `SKY SPORTS F1 HD` says which one. A sport implies Sports.
 */
export function topicsOf(channelName: string, categoryName: string): string[] {
  return topicsOfNormal(` ${normalise(channelName)} `, ` ${normalise(categoryName)} `);
}

/*
 * Whole words, looked up — not patterns, scanned.
 *
 * The first version compiled each keyword list into one big alternation and
 * tested it against every name; 57,681 channels took a second on this server,
 * which is several seconds on a television. A name is split into words once and
 * every run of one to four words is looked up in a table built from the lists:
 * a handful of Map lookups per channel, the same answers (the tests pin them).
 */
const MAX_WORDS = 4;

/** What a run of words means: which sport rule, whether it says "sport". */
interface Entry { s?: number; g?: true; o?: true }

/* One table for both questions, so a name is walked once. The first rule
   to claim a phrase keeps it: rule order is priority. */
const TABLE = new Map<string, Entry>();
const entry = (k: string): Entry => {
  const key = normalise(k);
  let e = TABLE.get(key);
  if (e === undefined) TABLE.set(key, (e = {}));
  return e;
};
SPORT_RULES.forEach((r, i) => { for (const k of r.match) { const e = entry(k); if (e.s === undefined) e.s = i; } });
for (const k of SPORT_GENERAL) entry(k).g = true;
for (const k of OTHER_SPORT_NAMES) { const e = entry(k); e.g = true; e.o = true; }

interface Scan { sport: number; general: boolean; other: boolean }

function scan(text: string): Scan {
  const w = text.trim().split(' ');
  let sport = -1;
  let general = false;
  let other = false;
  for (let i = 0; i < w.length; i++) {
    let key = '';
    for (let n = 0; n < MAX_WORDS && i + n < w.length; n++) {
      key = n === 0 ? w[i]! : `${key} ${w[i + n]!}`;
      const e = TABLE.get(key);
      if (e === undefined) continue;
      if (e.s !== undefined && (sport === -1 || e.s < sport)) sport = e.s;
      if (e.g) general = true;
      if (e.o) other = true;
    }
  }
  return { sport, general, other };
}

/* A package's name is shared by every channel in it — thousands, on a big line. */
const packageScans = new Map<string, Scan>();
function scanPackage(cat: string): Scan {
  let hit = packageScans.get(cat);
  if (hit === undefined) {
    if (packageScans.size > 5_000) packageScans.clear();
    packageScans.set(cat, (hit = scan(cat)));
  }
  return hit;
}

/** `topicsOf`, for callers that normalise once and ask many times (a package's name). */
export function topicsOfNormal(name: string, cat: string): string[] {
  const out: string[] = [];
  const n = scan(name);
  const c = scanPackage(cat);
  /* The channel's own name decides the sport; the package only that it is sport.
     A name that says a sport outside the fifteen, or that is two teams of one
     league, has decided too — the package's sport is not borrowed for it. */
  let idx = n.sport;
  let named = n.sport !== -1 || n.other;
  if (!named) {
    const league = leagueOf(name);
    if (league !== undefined) {
      named = true;
      if (league !== null) idx = SPORT_RULES.findIndex((r) => r.topic.id === league);
      else n.general = true;
    }
  }
  if (!named) idx = c.sport;
  const sport = idx === -1 ? undefined : SPORT_RULES[idx];
  if (sport) out.push(sport.topic.id);
  if (sport || n.general || c.general) out.push(SPORTS_TOPIC.id);
  return out;
}
