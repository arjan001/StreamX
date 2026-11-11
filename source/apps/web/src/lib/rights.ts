/**
 * Acceptance of the Terms of Use: a box ticked under the address of the first
 * source added (components/AddSource.tsx), and asked again whenever `TERMS_VERSION`
 * changes (bump it when the Terms of Use change in a way that needs a fresh
 * yes). The acceptance and its date live on this device only.
 */
import { kv } from './kv.ts';

/** Bump when the Terms change materially; every device is asked again. */
export const TERMS_VERSION = 1;

const KEY = 'iptv.rights.v1';

export interface RightsAcceptance {
  version: number;
  /** ISO date-time the box was ticked. */
  at: string;
}

export function rightsAcceptance(): RightsAcceptance | null {
  try {
    const raw = kv.get(KEY);
    if (raw === null) return null;
    const o = JSON.parse(raw) as Partial<RightsAcceptance>;
    return typeof o.version === 'number' && typeof o.at === 'string' ? { version: o.version, at: o.at } : null;
  } catch { return null; }
}

/** Has the current Terms version been accepted on this device? */
export function rightsAccepted(): boolean {
  return rightsAcceptance()?.version === TERMS_VERSION;
}

export function acceptRights(now: Date = new Date()): void {
  kv.set(KEY, JSON.stringify({ version: TERMS_VERSION, at: now.toISOString() } satisfies RightsAcceptance));
}
