/**
 * What a sound or subtitle track is CALLED, for somebody choosing one.
 *
 * libVLC hands back whatever the file says, and files say it in every shape
 * there is. Measured on this catalogue with ffprobe, a film with a dub carries
 * tracks tagged `fre`/`eng`, `spa`/`eng`, `ger`/`eng`; libVLC turns those into
 * descriptions like `Track 1 - [English]`, `Audio - [fre]`, sometimes just
 * `Track 2`, and always prepends a `Disable` entry to the subtitle list. Put
 * that list on a television unchanged and the viewer picks between "Track 1 -
 * [fre]" and "Track 2 - [eng]" — which is the file's vocabulary, not theirs.
 *
 * So this turns the label into the name of a language where it can, and leaves
 * it alone where it cannot. Never invents one: a track with nothing to go on
 * keeps whatever the engine said, because "Track 2" is at least true, while
 * guessing "English" for it would be a confident lie in the one place a viewer
 * cannot check the answer.
 */

/**
 * ISO 639 codes to language names, two-letter and three-letter together.
 *
 * Both halves are needed and they disagree: Matroska tags are usually the
 * three-letter bibliographic codes (`fre`, `ger`, `dut`), MP4 and HLS lean on
 * the two-letter ones (`fr`, `de`, `nl`), and ffprobe reports whichever the file
 * carries. The terminological three-letter codes (`fra`, `deu`, `nld`) appear
 * too, so both spellings are listed rather than being mapped to each other.
 *
 * The set is the catalogue's own: the languages this provider ships films and
 * dubs in, from the market prefixes on the titles (EN, NL, FR, DE, ES, IT, PT,
 * PL, SE, DK, NO, FI, TR, AR, RO, RU, GR, HU, CZ, SK, BG, HR, RS, AL, IN, MA)
 * plus the ones their audio tracks actually carried.
 */
const NAMES: Record<string, string> = {
  en: 'English', eng: 'English',
  nl: 'Dutch', dut: 'Dutch', nld: 'Dutch',
  fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German',
  es: 'Spanish', spa: 'Spanish',
  it: 'Italian', ita: 'Italian',
  pt: 'Portuguese', por: 'Portuguese',
  pl: 'Polish', pol: 'Polish',
  sv: 'Swedish', swe: 'Swedish',
  da: 'Danish', dan: 'Danish',
  no: 'Norwegian', nor: 'Norwegian', nb: 'Norwegian', nob: 'Norwegian',
  fi: 'Finnish', fin: 'Finnish',
  is: 'Icelandic', ice: 'Icelandic', isl: 'Icelandic',
  tr: 'Turkish', tur: 'Turkish',
  ar: 'Arabic', ara: 'Arabic',
  he: 'Hebrew', heb: 'Hebrew',
  fa: 'Persian', per: 'Persian', fas: 'Persian',
  ro: 'Romanian', rum: 'Romanian', ron: 'Romanian',
  ru: 'Russian', rus: 'Russian',
  uk: 'Ukrainian', ukr: 'Ukrainian',
  el: 'Greek', gre: 'Greek', ell: 'Greek',
  hu: 'Hungarian', hun: 'Hungarian',
  cs: 'Czech', cze: 'Czech', ces: 'Czech',
  sk: 'Slovak', slo: 'Slovak', slk: 'Slovak',
  sl: 'Slovenian', slv: 'Slovenian',
  bg: 'Bulgarian', bul: 'Bulgarian',
  hr: 'Croatian', hrv: 'Croatian',
  sr: 'Serbian', srp: 'Serbian',
  bs: 'Bosnian', bos: 'Bosnian',
  mk: 'Macedonian', mac: 'Macedonian', mkd: 'Macedonian',
  sq: 'Albanian', alb: 'Albanian', sqi: 'Albanian',
  lt: 'Lithuanian', lit: 'Lithuanian',
  lv: 'Latvian', lav: 'Latvian',
  et: 'Estonian', est: 'Estonian',
  hi: 'Hindi', hin: 'Hindi',
  ur: 'Urdu', urd: 'Urdu',
  bn: 'Bengali', ben: 'Bengali',
  ta: 'Tamil', tam: 'Tamil',
  te: 'Telugu', tel: 'Telugu',
  ml: 'Malayalam', mal: 'Malayalam',
  pa: 'Punjabi', pan: 'Punjabi',
  zh: 'Chinese', chi: 'Chinese', zho: 'Chinese',
  ja: 'Japanese', jpn: 'Japanese',
  ko: 'Korean', kor: 'Korean',
  th: 'Thai', tha: 'Thai',
  vi: 'Vietnamese', vie: 'Vietnamese',
  id: 'Indonesian', ind: 'Indonesian',
  ms: 'Malay', may: 'Malay', msa: 'Malay',
  tl: 'Filipino', fil: 'Filipino',
  so: 'Somali', som: 'Somali',
  sw: 'Swahili', swa: 'Swahili',
  am: 'Amharic', amh: 'Amharic',
  ku: 'Kurdish', kur: 'Kurdish',
  ps: 'Pashto', pus: 'Pashto',
};

/**
 * The words a file uses for "no language stated". Never shown as a name.
 *
 * `und` is the Matroska default — every single-audio film in the sample carried
 * it — so treating it as a language would label most of the catalogue
 * "Undetermined", which tells a viewer strictly less than "Track 1".
 */
const UNKNOWN = new Set(['und', 'unknown', 'undetermined', 'undefined', 'mis', 'zxx', 'qaa', '']);

/** Extra words a file adds about a track, kept because they change the choice. */
const QUALIFIERS: [RegExp, string][] = [
  [/\b(?:sdh|hearing[ -]impaired|hoh)\b/i, 'SDH'],
  [/\bforced\b/i, 'forced'],
  [/\bcommentary\b/i, 'commentary'],
  [/\bdescri(?:ptive|ption)|audio ?description\b/i, 'described'],
];

/** libVLC's own "turn this off" entry, which is not a track and not a language. */
export function isDisableTrack(id: number, label: string): boolean {
  return id === -1 || /^disable$/i.test(label.trim());
}

/**
 * A language code found anywhere in an engine's label, or null.
 *
 * Deliberately anchored to word boundaries and checked longest-first: `Track 1 -
 * [ita]` must not match `it` inside `Track`, and a bare `[nl]` must still be
 * found. Only codes this table knows count, which is what keeps `Track`, `Audio`
 * and `Stereo` from being read as languages.
 */
function codeIn(raw: string): string | null {
  const words = raw.toLowerCase().match(/[a-z]{2,3}/g) ?? [];
  for (const w of words) {
    if (UNKNOWN.has(w)) continue;
    if (NAMES[w] !== undefined) return w;
  }
  return null;
}

/**
 * The name to show for one track.
 *
 * `raw` is whatever the engine called it; `lang` is a language code when the
 * engine offered one separately (hls.js does, libVLC 3 does not). The engine's
 * own words win only when neither says anything a viewer would recognise.
 */
export function trackName(raw: string, lang?: string | null): string {
  const text = (raw ?? '').trim();
  const code = (lang ?? '').trim().toLowerCase();
  const found = (code !== '' && !UNKNOWN.has(code) && NAMES[code] !== undefined)
    ? code
    : codeIn(text);
  const extras = QUALIFIERS.filter(([re]) => re.test(text)).map(([, word]) => word);

  if (found === null) {
    /* Nothing recognisable. A full-word language name already in the label — a
       file that says "Nederlands" or "English" outright — is better than the
       engine's numbering, but only if it IS one; otherwise the label stands. */
    const spelled = Object.values(NAMES).find((n) => new RegExp(`\\b${n}\\b`, 'i').test(text));
    if (spelled !== undefined) return withExtras(spelled, extras);
    return text === '' ? 'Track' : text;
  }
  return withExtras(NAMES[found]!, extras);
}

function withExtras(name: string, extras: string[]): string {
  return extras.length === 0 ? name : `${name} (${extras.join(', ')})`;
}

/**
 * Name a whole list at once, numbering only what collides.
 *
 * Two French subtitle tracks are common — measured: one film carried two `fre`
 * ASS tracks, which are usually full and forced-only — and two rows both reading
 * "French" is a choice with no information in it. Numbering ONLY the duplicates
 * keeps the common case clean: a film with one French and one English track gets
 * "French" and "English", not "French 1" and "English 1".
 */
export function nameTracks<T extends { id: number; label: string; lang?: string | null }>(
  tracks: readonly T[],
): (T & { name: string })[] {
  const named = tracks.map((t) => ({
    ...t,
    name: isDisableTrack(t.id, t.label) ? 'Off' : trackName(t.label, t.lang ?? null),
  }));
  const counts = new Map<string, number>();
  for (const t of named) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return named.map((t) => {
    if ((counts.get(t.name) ?? 0) < 2) return t;
    const n = (seen.get(t.name) ?? 0) + 1;
    seen.set(t.name, n);
    return { ...t, name: `${t.name} ${n}` };
  });
}
