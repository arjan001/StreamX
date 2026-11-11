import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useScope } from '../lib/scope';
import { forgetChannel, forgetTitle, recentChannels, titlesInProgress } from '../lib/watching';
import type { WatchRecord } from '../lib/prefs';
import { WatchTile } from './WatchTile';
import { HScroll } from './HScroll';

/** How many tiles the row holds — titles first, channels filling what is left. */
const LIMIT = 12;

/**
 * "Continue watching", under the launcher's five cards.
 *
 * "below it or somewhere add like continue watching or so on" — the same
 * history `routes/Watching.tsx` opens on "Everything": films and series in
 * progress, newest first, then the channels this profile had on lately.
 * Titles come first because a resume point is a more specific promise than
 * "you had this channel on".
 *
 * Not drawn at all with nothing to show — a heading over an empty row is
 * furniture on a screen this small. Reuses `WatchTile` / `forgetTitle` /
 * `forgetChannel` exactly as `routes/Watching.tsx` does, so there is one remove
 * behaviour for "in progress" everywhere it appears.
 *
 * The home pages are the only place it appears: "remove the continue watching
 * from all the sections, it will stay at the home page" — Movies and Series
 * had their own one-line shelf and no longer do.
 */
export function ContinueRow() {
  const { prefs, scope } = useScope();
  const titleRecords = useMemo(() => titlesInProgress().slice(0, LIMIT), [prefs.history]);
  const channelIds = useMemo(
    () => recentChannels(Math.max(0, LIMIT - titleRecords.length)),
    [prefs.plays, titleRecords.length],
  );

  const movieIds = titleRecords.filter((r) => r.section === 'movies').map((r) => r.streamId);
  const seriesIds = titleRecords.filter((r) => r.section === 'series').map((r) => r.streamId);

  const movies = useQuery({
    queryKey: ['continue', 'movies', movieIds, scope],
    queryFn: () => api.items('movies', { streamIds: movieIds, limit: movieIds.length, ...scope }),
    enabled: movieIds.length > 0,
    staleTime: 60_000,
  });
  const series = useQuery({
    queryKey: ['continue', 'series', seriesIds, scope],
    queryFn: () => api.items('series', { streamIds: seriesIds, limit: seriesIds.length, ...scope }),
    enabled: seriesIds.length > 0,
    staleTime: 60_000,
  });
  const channels = useQuery({
    queryKey: ['continue', 'live', channelIds, scope],
    queryFn: () => api.items('live', { streamIds: channelIds, limit: channelIds.length, ...scope }),
    enabled: channelIds.length > 0,
    staleTime: 60_000,
  });

  if (titleRecords.length === 0 && channelIds.length === 0) return null;

  const movieById = new Map((movies.data?.rows ?? []).map((i) => [i.streamId, i] as const));
  const seriesById = new Map((series.data?.rows ?? []).map((i) => [i.streamId, i] as const));
  const channelById = new Map((channels.data?.rows ?? []).map((i) => [i.streamId, i] as const));

  const titleRows = titleRecords.flatMap((rec: WatchRecord) => {
    const item = (rec.section === 'movies' ? movieById : seriesById).get(rec.streamId);
    return item ? [{ key: `${rec.section}-${rec.streamId}`, item, rec }] : [];
  });
  const channelRows = channelIds.flatMap((id) => {
    const item = channelById.get(id);
    return item ? [{ key: `live-${id}`, item, id }] : [];
  });

  const loading =
    (movies.isLoading && movieIds.length > 0)
    || (series.isLoading && seriesIds.length > 0)
    || (channels.isLoading && channelIds.length > 0);
  if (!loading && titleRows.length === 0 && channelRows.length === 0) return null;

  return (
    <section data-nav-group="continue" aria-label="Continue watching" className="w-full">
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-2">
          Continue watching
        </h2>
        <span className="flex-1" />
        <Link
          to="/watching"
          className="tap inline-flex items-center font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-tally"
        >
          See all
        </Link>
      </div>
      {/* The launcher's own gaps, card for card: the five cards above and the
          shelf below are one grid. */}
      <HScroll paged className="gap-3 sm:gap-4 tv:gap-6">
        <>
          {titleRows.map(({ key, item, rec }) => (
            <WatchTile
              key={key}
              item={item}
              section={rec.section}
              rec={rec}
              onRemove={() => forgetTitle(rec.section, rec.streamId)}
            />
          ))}
          {channelRows.map(({ key, item, id }) => (
            <WatchTile
              key={key}
              item={item}
              section="live"
              onRemove={() => forgetChannel(id)}
            />
          ))}
        </>
      </HScroll>
    </section>
  );
}
