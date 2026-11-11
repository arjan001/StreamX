/**
 * Fetching a package the moment somebody looks at it.
 *
 * The on-demand library (see `lib/localCatalogue.ts`) holds the structure of a
 * subscription — every package, market and group, 78KB — and the contents of only
 * the packages that have been opened. This is what opens one: a hook that watches
 * whatever the current screen is filtered to and makes sure those packages are
 * actually here.
 *
 * ── why it lives in the React layer ──
 *
 * The read model is synchronous by design: `localItems` answers from typed arrays
 * with no awaiting anywhere, which is what makes a filtered page over 82,666 rows
 * take 23ms. A read that could go and fetch something would make every call site
 * asynchronous to serve the one case where the answer is not here yet. So the
 * fetch is a side effect beside the read, not inside it.
 *
 * ── what it deliberately does not do ──
 *
 * It never fetches "everything". A screen with no package filter — the unfiltered
 * channel list, a global search — is a question about the whole catalogue, and on
 * demand means that question is answered by what has been downloaded. Whoever
 * wants all of it can say so, once, in Settings.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Catalogue } from '@iptv/core-store';
import { ensurePackages, libraryMode, localCatalogue } from './localCatalogue.ts';
import type { ItemQuery, Section } from './api.ts';
import { forgetPagedLists } from './usePagedItems.ts';

const SECTION_KIND: Record<Section, number> = { live: 1, movies: 2, series: 3 };

/**
 * The packages a query is asking about, as provider ids.
 *
 * A path filter matches by PREFIX — picking "FR" means every package under it —
 * which is the same rule the read model applies, so what gets downloaded is
 * exactly what would be shown.
 */
export function packagesFor(
  cat: Catalogue | null, section: Section, q: Pick<ItemQuery, 'categoryId' | 'cats' | 'path' | 'paths'>,
): { kind: number; remoteId: string }[] {
  if (cat === null) return [];
  const kind = SECTION_KIND[section];
  const ids = new Set<number>([
    ...(q.categoryId != null ? [q.categoryId] : []),
    ...(q.cats ?? []),
  ]);
  const paths = [...(q.path ? [q.path] : []), ...(q.paths ?? [])]
    .map((p) => p.split('/').filter((x) => x !== ''));

  const out: { kind: number; remoteId: string }[] = [];
  for (const c of cat.categories) {
    if (c.kind !== kind) continue;
    const byId = ids.has(c.id);
    const byPath = paths.some((want) => want.every((seg, i) => c.path[i] === seg));
    if (byId || byPath) out.push({ kind: c.kind, remoteId: c.remoteId });
  }
  return out;
}

/**
 * Make sure the packages this screen is showing are on the device.
 *
 * Cheap when they already are: `ensurePackages` filters against what is loaded and
 * returns without a request. When something is fetched, the query cache is asked
 * to refetch — the rows the components are holding were correct answers to "what
 * is here", and what is here just changed.
 */
export function useEnsurePackages(
  section: Section,
  q: Pick<ItemQuery, 'categoryId' | 'cats' | 'path' | 'paths'>,
): void {
  const qc = useQueryClient();
  /* A stable string, so this runs when the FILTER changes rather than on every
     render — the query object is rebuilt by a `useMemo` on each of its inputs. */
  const key = [
    section, q.categoryId ?? '', (q.cats ?? []).join('+'), q.path ?? '', (q.paths ?? []).join('+'),
  ].join('|');

  useEffect(() => {
    if (libraryMode() !== 'ondemand') return;
    const cat = localCatalogue();
    if (cat === null) return;
    const want = packagesFor(cat, section, q);
    if (want.length === 0) return;
    let alive = true;
    /*
     * Round by round until the screen's packages are all here.
     *
     * `ensurePackages` caps each call at a screenful, so one round is not the
     * whole market — and the list has to keep filling rather than stopping at the
     * first twenty-four. Each round refetches the queries, so the rows appear as
     * they arrive instead of after the last one. Stops when a round fetches
     * nothing, which is either "all here" or "the panel refused", and neither is
     * a reason to keep asking.
     */
    const fill = async () => {
      for (;;) {
        const n = await ensurePackages(want);
        if (!alive) return;
        if (n === 0) return;
        /*
         * Both caches, because the app has two.
         *
         * The grids and channel lists are `usePagedItems`, which is deliberately
         * not react-query and so hears nothing from `invalidateQueries`. Missing
         * it here is what made opening a group look like it had done nothing:
         * 46 packages and 22,359 films arrived on the device and the page went
         * on reading "0 titles" until it was navigated away from and back.
         */
        forgetPagedLists();
        await qc.invalidateQueries();
      }
    };
    void fill();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
