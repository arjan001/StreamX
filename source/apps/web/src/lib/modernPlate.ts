/**
 * Atmospheric plate behind Modern browse screens (Live / Movies / Series).
 *
 * One shell setting (`skin.shell`) chooses Classic vs Modern. Inside Modern the
 * plate shifts with the section so Live / Movies / Series do not share one wash
 * — matching the mockup's "variable" browse rooms without a second setting.
 */
import { BRAND } from '../brand';
import { assetUrl } from './assetUrl';
import type { CSSProperties } from 'react';

export type ModernSection = 'live' | 'movies' | 'series' | 'home' | 'other';

export function modernSectionOf(pathname: string): ModernSection {
  /* `/discover` is the classic showcase, reachable from the logo in both
     shells — it opens on its own artwork (`Spotlight`), not a browse grid, so
     it gets the same answer as `/home`: no section wash, just the plate under
     whatever the page itself paints. */
  if (pathname === '/home' || pathname === '/discover' || pathname === '/') return 'home';
  if (pathname.startsWith('/live')) return 'live';
  if (pathname.startsWith('/movies') || pathname.startsWith('/movie')) {
    return 'movies';
  }
  if (pathname.startsWith('/series')) return 'series';
  return 'other';
}

/** File under `public/`, picked by light/dark. Section wash is CSS on `data-section`.
    Absolute, via `assetUrl` — see the note there for what a relative one does
    inside a custom property in the Android build. */
export function modernPlateUrl(mode: 'dark' | 'light'): string {
  const file = mode === 'light' ? 'modern-bg-light.jpg' : 'modern-bg-dark.jpg';
  return assetUrl(`${file}?v=${BRAND.rev}`);
}

export function modernPlateStyle(mode: 'dark' | 'light'): CSSProperties {
  return { '--shot': `url(${modernPlateUrl(mode)})` } as CSSProperties;
}
