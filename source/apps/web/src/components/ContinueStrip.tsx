import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, linkId } from '../lib/api';
import { useScope } from '../lib/scope';
import { continueRows, idsFor } from '../lib/home';
import { resumeAt } from '../lib/watch';
import { PosterCard } from './PosterCard';
import { Rail, Tile } from './Rail';

/**
 * Continue watching, as one component both home pages use.
 *
 * The playhead lives on this device and the catalogue lives on the server, so
 * this resolves stored provider ids through the ordinary items endpoint. Nothing
 * about what anyone watched is stored server-side, and nothing needs to be.
 *
 * Hidden entirely when there is nothing to continue — a section headed "Continue
 * watching" with nothing under it is worse than no section.
 */
export function ContinueStrip() {
  const { prefs, scope } = useScope();
  const movieIds = useMemo(() => idsFor(prefs.history, 'movies'), [prefs.history]);
  const seriesIds = useMemo(() => idsFor(prefs.history, 'series'), [prefs.history]);

  const movies = useQuery({
    queryKey: ['home', 'continue', 'movies', movieIds, scope],
    queryFn: () => api.items('movies', { streamIds: movieIds, limit: 40, ...scope }),
    enabled: movieIds.length > 0,
    staleTime: 60_000,
  });
  const series = useQuery({
    queryKey: ['home', 'continue', 'series', seriesIds, scope],
    queryFn: () => api.items('series', { streamIds: seriesIds, limit: 40, ...scope }),
    enabled: seriesIds.length > 0,
    staleTime: 60_000,
  });

  const rows = useMemo(
    () => continueRows(
      prefs.history,
      { movies: movies.data?.rows ?? [], series: series.data?.rows ?? [] },
      (r) => resumeAt(r) !== undefined,
    ),
    [prefs.history, movies.data, series.data],
  );

  if (prefs.history.length === 0) return null;
  const loading =
    (movies.isLoading && movieIds.length > 0) || (series.isLoading && seriesIds.length > 0);
  if (!loading && rows.length === 0) return null;

  return (
    <Rail enter title="Continue watching" loading={loading} skeletons={8}>
      {rows.map(({ item, section, rec }) => (
        <Tile key={`${section}-${item.id}`}>
          {/*
            Straight into playback, from the playhead.

            "Continue watching" that lands on a detail page and asks you to press
            PLAY is not continuing anything. Both routes already resume themselves
            from these parameters — `?play=1` for a film, `?ep=<id>` for the
            episode this record is against — and both read the playhead from
            `watch.ts`, so the click is one action and the seek is already correct.
          */}
          <PosterCard
            item={item}
            to={section === 'series'
              ? `/series/${linkId(item)}${rec.episodeId === null ? '' : `?ep=${rec.episodeId}`}`
              : `/movie/${linkId(item)}?play=1`}
            kind={section}
            favSection={section}
          />
          <p className="mt-0.5 font-mono text-[length:var(--t-2xs)] text-ink-3">
            {Math.floor(rec.positionS / 60)} of {Math.floor(rec.durationS / 60)} min
          </p>
        </Tile>
      ))}
    </Rail>
  );
}
