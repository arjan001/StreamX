/**
 * An XMLTV guide, read as it arrives.
 *
 * "check if their M3U or their server has a way to get EPG in bulk, because per
 * channel is not efficient" — it has: every Xtream panel answers `xmltv.php`
 * with the whole guide in one file. Measured on the owner's line: 93 MB of XML
 * (16.7 MB on the wire, brotli), 291,789 programmes for 4,385 guide channels,
 * from yesterday morning to tomorrow morning.
 *
 * Ninety-three megabytes cannot be held as one string on a television, and does
 * not need to be. This is fed the text a chunk at a time and hands each
 * programme out the moment its closing tag arrives; only the unfinished tail of
 * the last chunk is ever kept. No DOM parser — `DOMParser` wants the whole
 * document — and no dependency: the format is flat and regular enough that
 * finding `<programme …>…</programme>` and three fields inside it is the whole
 * job.
 *
 * Pure, and tested in `xmltv.test.ts` against the shapes panels actually send.
 */

export interface XmltvProgramme {
  /** The `channel` attribute — the same id a panel publishes as `epg_channel_id`. */
  channel: string;
  /** Unix seconds. */
  start: number;
  stop: number | null;
  title: string;
  desc: string | null;
}

/**
 * `20260928033400 +0000` → unix seconds.
 *
 * The offset is optional in the format and panels do drop it; without one the
 * time is taken as UTC, which is what every panel measured here meant by it.
 */
export function xmltvTime(raw: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?/.exec(raw.trim());
  if (m === null) return null;
  const utc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] === undefined ? 0 : +m[6]);
  if (!Number.isFinite(utc)) return null;
  const sign = m[7] === '-' ? -1 : 1;
  const offset = m[7] === undefined ? 0 : sign * ((+m[8]! * 60) + +m[9]!) * 60_000;
  return Math.floor((utc - offset) / 1000);
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Entities and CDATA out, whitespace folded — what a guide row can show. */
export function xmlText(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const s = cdata === null
    ? raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
      return NAMED[e.toLowerCase()] ?? whole;
    })
    : cdata[1]!;
  return s.replace(/\s+/g, ' ').trim();
}

const ATTR = /(\w+)="([^"]*)"/g;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(tag); m !== null; m = ATTR.exec(tag)) out[m[1]!] = m[2]!;
  return out;
}

/** The first `<name …>text</name>` inside a programme, or null. */
function field(body: string, name: string): string | null {
  const open = body.indexOf(`<${name}`);
  if (open < 0) return null;
  const gt = body.indexOf('>', open);
  if (gt < 0) return null;
  /* `<desc/>` — present and empty. */
  if (body[gt - 1] === '/') return null;
  const close = body.indexOf(`</${name}>`, gt);
  if (close < 0) return null;
  const text = xmlText(body.slice(gt + 1, close));
  return text === '' ? null : text;
}

/**
 * Push text in, get programmes out.
 *
 * `push` may split a programme anywhere — inside a tag, inside an attribute,
 * between `</title` and `>` — and the unfinished tail waits for the next push.
 * A malformed programme is skipped, never fatal: one broken row in a guide of
 * three hundred thousand is not a reason to have no guide.
 */
export class XmltvReader {
  private tail = '';
  private readonly emit: (p: XmltvProgramme) => void;
  private readonly onChannel: ((id: string, names: string[]) => void) | null;
  count = 0;

  constructor(emit: (p: XmltvProgramme) => void, onChannel?: (id: string, names: string[]) => void) {
    this.emit = emit;
    this.onChannel = onChannel ?? null;
  }

  push(text: string): void {
    const buf = this.tail === '' ? text : this.tail + text;
    const wantChannels = this.onChannel !== null;
    let at = 0;
    /*
     * Both element kinds, in document order, in one pass. A panel's file lists
     * every channel first; others interleave a channel with its programmes —
     * the fake panel does. Each "next" position is looked up once and only
     * moved on when its element is consumed, so a long run of one kind costs
     * one search for the other, not one per element (asking per channel was
     * what turned a 2 s parse into 23 s).
     */
    let nextC = wantChannels ? buf.indexOf('<channel ', at) : -1;
    let nextP = buf.indexOf('<programme', at);
    for (;;) {
      const chan = nextC >= 0 && (nextP < 0 || nextC < nextP);
      const start = chan ? nextC : nextP;
      if (start < 0) {
        /* Nothing starts here. Keep only what could be the beginning of a tag
           split across chunks — never the text before it. */
        this.tail = buf.slice(Math.max(at, buf.length - 16));
        return;
      }
      const closeTag = chan ? '</channel>' : '</programme>';
      const end = buf.indexOf(closeTag, start);
      if (end < 0) {
        this.tail = buf.slice(start);
        return;
      }
      if (chan) this.takeChannel(buf.slice(start, end));
      else this.take(buf.slice(start, end));
      at = end + closeTag.length;
      if (chan || (nextC >= 0 && nextC < at)) nextC = wantChannels ? buf.indexOf('<channel ', at) : -1;
      if (!chan || (nextP >= 0 && nextP < at)) nextP = buf.indexOf('<programme', at);
    }
  }

  /** Nothing more is coming; an unfinished tail is dropped. */
  finish(): void {
    this.tail = '';
  }

  private takeChannel(el: string): void {
    const gt = el.indexOf('>');
    if (gt < 0) return;
    const id = attrs(el.slice(0, gt))['id'];
    if (id === undefined || id === '') return;
    const names: string[] = [];
    const re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
    for (let m = re.exec(el); m !== null; m = re.exec(el)) {
      const n = xmlText(m[1]!);
      if (n !== '') names.push(n);
    }
    this.onChannel!(xmlText(id), names);
  }

  private take(el: string): void {
    const gt = el.indexOf('>');
    if (gt < 0) return;
    const a = attrs(el.slice(0, gt));
    const channel = a['channel'];
    const start = a['start'] === undefined ? null : xmltvTime(a['start']);
    if (channel === undefined || channel === '' || start === null) return;
    const title = field(el, 'title');
    if (title === null) return;
    const stop = a['stop'] === undefined ? null : xmltvTime(a['stop']);
    this.count++;
    this.emit({ channel: xmlText(channel), start, stop, title, desc: field(el, 'desc') });
  }
}
