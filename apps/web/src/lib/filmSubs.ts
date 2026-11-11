/**
 * A film's own subtitle lines, made into something a `<track>` can show.
 *
 * The device's remuxer (libav.js, see `deviceFilm.ts` and `libavRemux.ts`) hands every
 * text subtitle line out as it reads — measured on a Matroska with an SRT French
 * and an SRT English track: `{ streamIndex, start, end, content }`, with `start`
 * and `end` in MILLISECONDS and `content` the line as the file carries it. Nothing
 * showed them: the player counted the tracks into its log and dropped the rest,
 * which is "this is a dual language film but I don't see any language changers".
 *
 * Two dialects arrive here. SubRip keeps its own light markup (`<i>`, `<b>`,
 * `<font>`) and CRLF line ends. ASS/SSA arrives as an event line — read order,
 * layer, style, name, three margins and an effect, then the text — with its
 * override blocks (`{\an8}`) and its own line break (`\N`). Pure, so the rules
 * are tested without a browser.
 */

export interface FilmDialogue {
  streamIndex: number;
  /** Milliseconds from the start of the film. */
  start: number;
  end: number;
  content: string;
  fields?: Record<string, string>;
}

/** The nine comma-separated fields of an ASS event, the last of which is the text. */
const ASS_EVENT = /^\d+,-?\d+,[^,]*,[^,]*,-?\d+,-?\d+,-?\d+,[^,]*,/;

/** Markup WebVTT understands and SubRip uses; everything else is dropped, not shown. */
const KEEP_TAG = /^<\/?(i|b|u)>$/i;

/**
 * The words of one subtitle line, as WebVTT cue text.
 *
 * `&` and stray `<` are escaped, because cue text is parsed as markup and a
 * line reading "Tom & Jerry" or "x < y" would otherwise lose everything after
 * the character.
 */
export function cueText(raw: string, fields?: Record<string, string>): string {
  let text = typeof fields?.['Text'] === 'string' ? fields['Text'] : raw;
  if (ASS_EVENT.test(text)) text = text.replace(ASS_EVENT, '');
  text = text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .replace(/\r\n?/g, '\n');
  const out = text
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<') && part.endsWith('>')) {
        return KEEP_TAG.test(part) ? part.toLowerCase() : '';
      }
      return part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    })
    .join('');
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * What makes two arrivals of one line the same line.
 *
 * The remuxer hands a line out again when a seek re-reads the stretch it sits
 * in, and a `<track>` given the same cue twice shows it twice, stacked.
 */
export function dialogueKey(d: FilmDialogue): string {
  return `${d.start}|${d.end}|${d.content}`;
}

/**
 * A language code a `<track srclang>` accepts, or empty.
 *
 * Matroska files name languages in ISO 639-2 (`fre`, `eng`), and the attribute
 * wants a BCP 47 tag. The label the viewer sees does not come from here.
 */
export function trackLang(code: string): string {
  const c = code.trim().toLowerCase();
  if (c === '' || c === 'und') return '';
  return /^[a-z]{2,3}(-[a-z0-9]+)*$/.test(c) ? c : '';
}
