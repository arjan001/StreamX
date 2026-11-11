import type { Section } from './api.ts';
import { marketKind } from './groups.ts';

/**
 * Provider market codes → ISO 3166-1 alpha-2 for flag artwork.
 *
 * Live codes are not ISO (`IS` is Israel, `LA` is Latvia, `SK` is South Korea).
 * Free-list markets use an `F` suffix (`NLF`) and map to the two letters before it.
 */
const PROVIDER_ISO: Record<string, string> = {
  UK: 'gb', IS: 'il', LA: 'lv', KA: 'kz', CG: 'me', BH: 'ba', SK: 'kr',
  KO: 'xk', SL: 'si', VT: 'vn', TAI: 'tw', BAN: 'bd', UKR: 'ua', EST: 'ee',
  AFG: 'af', SU: 'sr',
  SWEDEN: 'se', DENMARK: 'dk', NORWAY: 'no', FINLAND: 'fi', ICELAND: 'is',
};

/** ISO alpha-2 for a country market, or null when there is no flag. */
export function marketFlagIso(code: string, section?: Section): string | null {
  if (marketKind(code, section) !== 'country') return null;
  const up = code.toUpperCase();
  const free = /^([A-Z]{2})F$/.exec(up);
  if (free !== null) {
    const base = free[1]!;
    return base === 'UK' ? 'gb' : base.toLowerCase();
  }
  const mapped = PROVIDER_ISO[up];
  if (mapped !== undefined) return mapped;
  if (/^[A-Z]{2}$/.test(up)) return up.toLowerCase();
  return null;
}

/** Compact PNG from flagcdn — online devices only; caller hides on error. */
export function marketFlagUrl(code: string, section?: Section): string | null {
  const iso = marketFlagIso(code, section);
  if (iso === null) return null;
  return `https://flagcdn.com/w40/${iso}.png`;
}
