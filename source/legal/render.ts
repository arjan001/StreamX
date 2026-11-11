/**
 * The legal texts, rendered from one source.
 *
 * `terms.md`, `privacy.md` and `copyright.md` here are the only copy of the
 * wording. The website (apps/server) renders them at request time and the app
 * bundles them, so the two can never drift apart. Placeholders such as
 * `{{PUBLISHER_NAME}}` are filled from the `publisher` block of
 * brand.config.json; one that has no value renders as a visible
 * "[to be filled in]" marker and never as raw braces. Two fields are optional and
 * never show the marker: an empty `address` drops its line from the contact
 * block, and an empty `governingLaw` swaps the governing-law clause for a
 * general one (`GOVERNING_LAW_CLAUSE`).
 *
 * No imports and no platform APIs: this file runs under Node (type stripping)
 * and under Vite alike.
 */

export interface LegalBrand {
  name: string;
  publisher?: Partial<Record<
    'name' | 'email' | 'address' | 'website' | 'governingLaw' | 'termsEffectiveDate' | 'privacyEffectiveDate',
    string
  >>;
  captions?: { provider?: string; privacyUrl?: string };
}

export type LegalDoc = 'terms' | 'privacy' | 'copyright';

export const TODO_MARK = '[to be filled in]';

/** The governing-law clause when the publisher names no particular law. */
export const GENERAL_LAW_CLAUSE =
  'These terms are governed by the law that applies where you use the App. Nothing in them limits '
  + 'rights you have under the law of the country where you live. If a court finds part of these '
  + 'terms unenforceable, the rest still applies.';

/**
 * The artwork sentence of the privacy policy.
 *
 * True to the code: the app never wraps an address itself, but a playlist
 * often carries picture links that already point at the wsrv.nl resizing
 * service (`artwork.ts` resizes them in place), and a device that loads one
 * contacts that service. Naming it is the honest wording.
 */
export const IMAGE_PROXY_SENTENCE =
  ', including, where a playlist’s own picture links point to it, an image-resizing service (wsrv.nl), '
  + 'which then sees the image address and your IP address';

type Kind = 'text' | 'email' | 'url';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One placeholder's value as HTML, or the marker when it has none. */
function slot(value: string | undefined, kind: Kind): string {
  const v = (value ?? '').trim();
  if (v === '') return `<mark class="todo">${TODO_MARK}</mark>`;
  if (kind === 'email') return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  if (kind === 'url') return `<a href="${esc(v)}" rel="noopener">${esc(v)}</a>`;
  return esc(v);
}

export function legalValues(b: LegalBrand, doc: LegalDoc, extra: { version?: string; build?: string } = {}) {
  const p = b.publisher ?? {};
  const site = (p.website ?? '').trim().replace(/\/+$/, '');
  return {
    APP_NAME: [b.name, 'text'],
    SITE_URL: [site, 'text'],
    PUBLISHER_NAME: [p.name, 'text'],
    PUBLISHER_EMAIL: [p.email, 'email'],
    PUBLISHER_ADDRESS: [p.address, 'text'],
    GOVERNING_LAW_CLAUSE: [
      (p.governingLaw ?? '').trim() === ''
        ? GENERAL_LAW_CLAUSE
        : `These terms are governed by the laws of ${(p.governingLaw ?? '').trim()}, without affecting `
          + 'any consumer protection you have under the law of the country where you live.',
      'text',
    ],
    EFFECTIVE_DATE: [doc === 'privacy' ? p.privacyEffectiveDate : p.termsEffectiveDate, 'text'],
    CAPTIONS_PROVIDER: [b.captions?.provider, 'text'],
    CAPTIONS_PRIVACY_URL: [b.captions?.privacyUrl, 'url'],
    VERSION: [extra.version, 'text'],
    BUILD: [extra.build, 'text'],
  } as Record<string, [string | undefined, Kind]>;
}

/** Inline markup: escape first, then bold, code, links; placeholders last. */
function inline(text: string, values: Record<string, [string | undefined, Kind]>): string {
  let h = esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  h = h.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key: string) => {
    if (key === 'IMAGE_PROXY_SENTENCE') return esc(IMAGE_PROXY_SENTENCE);
    const v = values[key];
    return v === undefined ? slot('', 'text') : slot(v[0], v[1]);
  });
  return h;
}

/** Placeholders whose whole line disappears when they have no value. */
const OPTIONAL_LINES = new Set(['PUBLISHER_ADDRESS']);

const ONLY_TOKENS = /^(\{\{[A-Z_]+\}\}\s*)+$/;

/**
 * A small, strict Markdown subset: headings, paragraphs, `-` and `1.` lists
 * (with indented continuation lines), fenced code blocks, bold, code, links.
 * That is everything the three texts and the licence notice use.
 */
export function renderMarkdown(md: string, values: Record<string, [string | undefined, Kind]> = {}): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[][] } | null = null;
  let code: string[] | null = null;

  const flushPara = () => {
    para = para.filter((l) => {
      const m = /^\{\{([A-Z_]+)\}\}$/.exec(l.trim());
      return m === null || !OPTIONAL_LINES.has(m[1]!) || (values[m[1]!]?.[0] ?? '').trim() !== '';
    });
    if (para.length === 0) return;
    const br = para.length > 1 && para.every((l) => ONLY_TOKENS.test(l.trim()));
    out.push(`<p>${para.map((l) => inline(l.trim(), values)).join(br ? '<br>' : ' ')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list === null) return;
    out.push(`<${list.tag}>${list.items.map((it) => `<li>${inline(it.join(' '), values)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  for (const raw of lines) {
    if (code !== null) {
      if (raw.startsWith('```')) { out.push(`<pre>${esc(code.join('\n'))}</pre>`); code = null; } else code.push(raw);
      continue;
    }
    if (raw.startsWith('```')) { flushPara(); flushList(); code = []; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (h !== null) {
      flushPara(); flushList();
      const n = (h[1] ?? '#').length;
      out.push(`<h${n}>${inline((h[2] ?? '').trim(), values)}</h${n}>`);
      continue;
    }
    const li = /^(?:([-*])|(\d+)\.)\s+(.*)$/.exec(raw);
    if (li !== null) {
      flushPara();
      const tag = li[1] !== undefined ? 'ul' : 'ol';
      if (list !== null && list.tag !== tag) flushList();
      if (list === null) list = { tag, items: [] };
      list.items.push([li[3] ?? '']);
      continue;
    }
    if (raw.trim() === '') { flushPara(); flushList(); continue; }
    if (list !== null && /^\s+\S/.test(raw)) { list.items[list.items.length - 1]!.push(raw.trim()); continue; }
    if (list !== null) flushList();
    para.push(raw);
  }
  flushPara(); flushList();
  if (code !== null) out.push(`<pre>${esc(code.join('\n'))}</pre>`);
  return out.join('\n');
}

export function renderLegal(
  template: string, brand: LegalBrand, doc: LegalDoc, extra: { version?: string; build?: string } = {},
): string {
  return renderMarkdown(template, legalValues(brand, doc, extra));
}

/** Titles, in the order the pages list them. */
export const LEGAL_TITLES: Record<LegalDoc | 'licenses', string> = {
  terms: 'Terms of Use',
  privacy: 'Privacy Policy',
  copyright: 'Copyright',
  licenses: 'Open-source licences',
};
