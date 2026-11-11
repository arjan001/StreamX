/**
 * The legal texts, bundled.
 *
 * The wording is the repository's `legal/*.md` (the server renders the same files
 * for the website), imported as text so the screens work offline and on a
 * platform with no server. Placeholders are filled from `BRAND.publisher`.
 */
import { BRAND } from '../brand';
import { LEGAL_TITLES, renderLegal, renderMarkdown, type LegalBrand } from '../../../../legal/render.ts';
import terms from '../../../../legal/terms.md?raw';
import privacy from '../../../../legal/privacy.md?raw';
import copyright from '../../../../legal/copyright.md?raw';
import licenses from '../../../../legal/licenses.md?raw';

export type LegalPage = 'terms' | 'privacy' | 'copyright' | 'licenses';
export const LEGAL_PAGES: LegalPage[] = ['terms', 'privacy', 'copyright', 'licenses'];
export { LEGAL_TITLES };

export const isLegalPage = (s: string | undefined): s is LegalPage =>
  s !== undefined && (LEGAL_PAGES as string[]).includes(s);

const VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '';
const BUILD = (import.meta.env?.VITE_APP_BUILD as string | undefined) ?? '';

const brand: LegalBrand = { name: BRAND.name, publisher: BRAND.publisher, captions: BRAND.captions };

export function legalHtml(page: LegalPage): string {
  if (page === 'licenses') return renderMarkdown(licenses, {});
  const src = page === 'terms' ? terms : page === 'privacy' ? privacy : copyright;
  return renderLegal(src, brand, page, { version: VERSION, build: BUILD });
}

/** Version and build for the About list. A development build says so. */
export const appVersion = (): { version: string; build: string } => ({ version: VERSION, build: BUILD });
