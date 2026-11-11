/**
 * Names written in capitals, set in ordinary case.
 *
 * "read all types of categories and titles and so on, I want you to format them
 * well". Measured on the frozen fixture of the owner's line, after every other
 * rule in lib/displayName.ts had run: 205 of 223 live packages, 142 of 149 film
 * packages, 100 of 108 series packages and 1,388 of 1,989 channel names were
 * still ALL CAPS — "SKY SPORTS MAIN EVENT", "TDT ESPAÑA VIP", "NETFLIX KIDS".
 * On a television that is a wall of shouting, and it is the provider's typing,
 * not anything a viewer chose.
 *
 * Only a name with NO lower-case letters at all is touched: "TRON: Ares" and
 * "BBC One" were written by somebody on purpose and stay exactly as they are.
 * Inside a shouted name, what is a name stays one — BBC, ESPN, DAZN, F1, 4K,
 * FC, VIP — by three rules: a word with a digit, a word with no vowel, and a
 * short list of acronyms that happen to have one.
 */
const ACRONYMS = new Set([
  'ABC', 'AMC', 'AEW', 'ATP', 'WTA', 'EFL', 'EPL', 'NBA', 'UFC', 'WWE', 'PGA', 'LPGA', 'UEFA', 'FIFA', 'ESPN',
  'DAZN', 'HBO', 'NOS', 'ORF', 'ARD', 'RAI', 'TVE', 'ITV', 'NPO', 'VIP', 'PPV', 'UHD', 'USA', 'UK', 'US', 'EU',
  'UAE', 'AC', 'AS', 'AZ', 'OM', 'OL', 'OGC', 'PSG', 'PSV', 'AIK', 'IFK', 'KAA', 'KAS', 'GP', 'MMA', 'PFL',
  'BEIN', 'AXN', 'CGTN', 'RTBF', 'RTP', 'SIC', 'TVI', 'CBC', 'CTV', 'BFM', 'LCI', 'QVC', 'DMAX', 'IMDB', 'OTT',
  'SUV', 'NTSF', 'CSI', 'NCIS', 'SEAL', 'FBI', 'CIA',
]);
/* Brands that are written their own way — not guessable from any rule. */
const BRANDS: Record<string, string> = {
  BEIN: 'beIN', VTMGO: 'VTM GO', HBOMAX: 'HBO Max', SKYSHOWTIME: 'SkyShowtime', IPTV: 'IPTV', MUTV: 'MUTV',
  LALIGA: 'LaLiga', GOLTV: 'GolTV', CBEEBIES: 'CBeebies', JR: 'Jr', VIX: 'ViX', TELEFONICA: 'Telefónica', NBCSN: 'NBCSN', TVGO: 'TV GO', MOVISTAR: 'Movistar',
};
/* The small words of a title, in the languages this catalogue carries — lower
   case unless they open it: "Liga de Campeones", "Penoza the Final Chapter". */
/* Not VAN or VON: in a name they are usually written capitalised — Luca Van Assche. */
const PARTICLES = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'E', 'DA', 'DO', 'DOS', 'DAS',
  'DER', 'DEN', 'HET', 'OF', 'THE', 'AND', 'IN', 'ON', 'AT', 'FOR', 'A', 'AN', 'TO', 'EN', 'ET', 'LE', 'LES', 'DES',
  'DU', 'AU', 'AUX', 'DI', 'DELLA', 'UND']);
const VOWEL = /[AEIOUYÀ-ÖØ-Ýa-z]/;
const ROMAN = /^(?:II|III|IV|VI|VII|VIII|IX|XI|XII)$/;

function caseWord(w: string, first: boolean, prev: string): string {
  const bare = w.replace(/[^\p{L}\p{N}+]/gu, '');
  if (bare === '') return w;
  const brand = BRANDS[bare.replace(/\+$/, '')];
  if (brand !== undefined) return w.replace(bare.replace(/\+$/, ''), brand);
  if (/^(?:VS|V)\.?$/.test(bare)) return w.toLowerCase();
  /* 3RD, 1ST, 24TH: a number with its ordinal, written as a number is. */
  if (/^\d+(?:ST|ND|RD|TH)$/.test(bare)) return w.toLowerCase();
  if (!first && PARTICLES.has(bare)) return w.toLocaleLowerCase();
  if (/\d/.test(bare) || ROMAN.test(bare)) return w;
  /* M+, A+, D+ are marks; DISNEY+ and CANAL+ are words with a plus. */
  if (bare.length === 1 || /^\p{Lu}\+$/u.test(bare)) return w;
  /* "THE LAST OF US" is a pronoun; "US OPEN" is the country. */
  if (bare === 'US' && PARTICLES.has(prev)) return title(w);
  if (ACRONYMS.has(bare)) return w;
  if (!VOWEL.test(bare)) return w;
  return title(w);
}

function title(w: string): string {
  const lower = w.toLocaleLowerCase();
  /* #VAMOS → #Vamos, O'NEIL → O'Neil; MCDONALD stays Mcdonald — rare enough not to guess at. */
  return lower.replace(/(^\P{L}*|['’])(\p{L})/gu, (_m, pre: string, c: string) => pre + c.toLocaleUpperCase());
}

export function unshout(s: string): string {
  if (/\p{Ll}/u.test(s) || !/\p{Lu}/u.test(s)) return s;
  let first = true;
  let prev = '';
  let paren = false;
  return s.split(/(\s+|[-/:·|,()[\]&]|\.(?=\p{L}))/u).map((w) => {
    if (w === '' || /^\s+$/.test(w)) return w;
    /* A dot between letters joins two words, not a sentence: M.LALIGA is M.LaLiga. */
    if (w === '.') return w;
    /* After a separator a new phrase starts: "Liga de Campeones · La Final". */
    if (/^[-/:·|,()[\]&]$/.test(w)) {
      if (w === '(') paren = true;
      if (w === ')') paren = false;
      if (w !== '&') first = true;
      return w;
    }
    /* A three-letter word in brackets is a country: "(BRA)", "(CZE)". */
    const out = paren && /^\p{Lu}{2,3}$/u.test(w) ? w : caseWord(w, first, prev);
    first = false;
    prev = w.replace(/[^\p{L}\p{N}+]/gu, '');
    return out;
  }).join('');
}

/**
 * The superscript tier marks a panel appends — ᴿᴬᵂ, ᴴᴰ, ᴳᴼᴸᴰ, ʰᵉᵛᶜ — which are
 * modifier LETTERS, so no word rule ever sees them. Channels have long had them
 * removed; package names kept them ("SPAIN VIP ᴿᴬᵂ"). One rule for both.
 */
const MARKS = /[ʰ-˿ᴬ-ᵪᶛ-ᶿ⁰-₟]+/g;
export function stripMarks(s: string): string {
  return s.replace(MARKS, ' ').replace(/\s{2,}/g, ' ').trim();
}
