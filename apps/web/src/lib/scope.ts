/**
 * The scope every catalogue read carries, as one hook.
 *
 * `scopeParams()` folds three things into the query: the profile's countries, its
 * hidden paths and its hidden categories. Adult entries are not part of the
 * scope because they are never shown: core-store excludes them on every read.
 *
 * One hook, one dependency list, and no call site has to remember.
 *
 * ── the same scope is the same object ──
 *
 * Keyed on what the scope SAYS, not on `prefs`. Every preference write hands
 * every consumer a fresh `prefs` — the playhead every few seconds while
 * something plays, a remembered focus, a volume — and none of those change
 * which channels are in scope. Keyed on `prefs`, each of them produced a new
 * scope object, and every `useMemo` downstream of it started again: Sports
 * TV's rail counted all sixteen sports across the whole library (`sportCounts`,
 * a pass over 49,789 channels per sport) twice per render, which on the
 * emulator was 80 ms of script for every press of the remote and on a MediaTek
 * television most of a second — "10 seconds to move left right". Measured,
 * then fixed here rather than at the one call site, because nineteen
 * components read this and all of them paid it.
 */
import { useMemo } from 'react';
import { scopeParams, usePrefs, type Prefs } from './prefs.ts';

export interface Scoped {
  prefs: Prefs;
  scope: ReturnType<typeof scopeParams>;
}

/** What a scope says, as a string: equal scopes, equal keys. */
export function scopeKey(scope: ReturnType<typeof scopeParams>): string {
  return JSON.stringify(scope);
}

export function useScope(): Scoped {
  const [prefs] = usePrefs();
  const fresh = scopeParams(prefs);
  const key = scopeKey(fresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scope = useMemo(() => fresh, [key]);
  return { prefs, scope };
}
