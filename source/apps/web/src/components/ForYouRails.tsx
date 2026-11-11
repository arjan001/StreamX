import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, linkId, type Item } from '../lib/api';
import { useScope } from '../lib/scope';
import { useCategories } from '../lib/groups';
import { idsFor } from '../lib/home';
import { buildTaste, filterRecommended, recommend, watchWeight, WEIGHTS, type Signal } from '../lib/taste';
import { PosterCard } from './PosterCard';
import { Rail, Tile } from './Rail';

/**
 * Rails built from what someone has actually watched.
 *
 * Everything the profile needs is already here or already cached: the watch
 * history and stars live on the device, each item row carries its `categoryId`,
 * and the category list — with its genres, provider and region — is the same
 * query the filter bar makes. So this costs one items request per rail and
 * nothing else. The alternative, one panel call per watched title to read its
 * genres, is not affordable on a panel that flood-protects.
 *
 * Renders nothing at all on a cold profile. A "recommended for you" strip built
 * from a single data point is a claim the viewer can see through, and seeing
 * through it once is enough to distrust every rail on the page.
 */
export function ForYouRails({ section }: { section: 'movies' | 'series' }) {
  const { prefs, scope } = useScope();
  const categories = useCategories(section, scope);

  const favIds = prefs.favs[section];
  const histIds = useMemo(() => idsFor(prefs.history, section), [prefs.history, section]);
  const ids = useMemo(
    () => [...new Set([...favIds, ...histIds])].slice(0, 60),
    [favIds, histIds],
  );

  /* The titles behind the signals. One request, and only for ids that are
     actually in the history or the favourites. */
  const seedRows = useQuery({
    queryKey: ['taste', 'seeds', section, ids, scope],
    queryFn: () => api.items(section, { streamIds: ids, limit: 60, ...scope }),
    enabled: ids.length > 0,
    staleTime: 300_000,
  });

  const taste = useMemo(() => {
    const rows = seedRows.data?.rows ?? [];
    const byStream = new Map(rows.map((r) => [r.streamId, r] as const));
    const signals: Signal[] = [];
    for (const id of favIds) {
      const row = byStream.get(id);
      if (row) signals.push({ item: row, weight: WEIGHTS.favourite });
    }
    for (const rec of prefs.history) {
      if (rec.section !== section) continue;
      const row = byStream.get(rec.streamId);
      // A starred title is already counted, and counting it twice makes one
      // choice look like two.
      if (!row || favIds.includes(rec.streamId)) continue;
      signals.push({ item: row, weight: watchWeight(rec) });
    }
    return buildTaste(
      signals,
      categories.map((c) => ({
        id: c.id, cleanName: c.cleanName, genres: c.genres, region: c.region, source: c.source,
      })),
      { now: Date.now(), history: prefs.history },
    );
  }, [seedRows.data, favIds, prefs.history, categories, section]);

  const picks = useMemo(() => recommend(taste, { section, limit: 2 }), [taste, section]);
  if (picks.length === 0) return null;

  return (
    <>
      {picks.map((pick) => (
        <PickRail key={pick.key} pick={pick} taste={taste} />
      ))}
    </>
  );
}

function PickRail({
  pick, taste,
}: {
  pick: ReturnType<typeof recommend>[number];
  taste: ReturnType<typeof buildTaste>;
}) {
  const { scope } = useScope();
  const q = useQuery({
    queryKey: ['taste', 'rail', pick.key, pick.section, scope],
    queryFn: () => api.items(pick.section, {
      limit: 24,
      sort: 'added',
      dir: 'desc',
      ...(pick.query.genres ? { genres: pick.query.genres } : {}),
      ...(pick.query.source ? { source: pick.query.source } : {}),
      ...(pick.query.region ? { region: pick.query.region } : {}),
      ...(pick.query.categoryId ? { categoryId: pick.query.categoryId } : {}),
      ...scope,
    }),
    staleTime: 300_000,
  });

  /* Filtered client-side rather than in the query: "not these 40 provider ids"
     is a long URL and a worse index scan than fetching 30 rows and dropping the
     handful already seen. */
  const rows = useMemo(
    () => filterRecommended(q.data?.rows ?? [], taste, pick.section),
    [q.data, taste, pick.section],
  );
  if (!q.isLoading && rows.length < 4) return null;

  const href = pick.query.categoryId
    ? `/${pick.section}?category=${pick.query.categoryId}`
    : pick.query.source
      ? `/${pick.section}?source=${encodeURIComponent(pick.query.source)}`
      : pick.query.genres
        ? `/${pick.section}?genres=${encodeURIComponent(pick.query.genres.join(','))}`
        : `/${pick.section}`;

  return (
    <Rail enter title={pick.title} to={href} loading={q.isLoading}>
      {rows.map((item: Item) => (
        <Tile key={item.id}>
          <PosterCard
            item={item}
            to={`${pick.section === 'series' ? '/series' : '/movie'}/${linkId(item)}`}
            kind={pick.section}
            favSection={pick.section}
          />
        </Tile>
      ))}
    </Rail>
  );
}
