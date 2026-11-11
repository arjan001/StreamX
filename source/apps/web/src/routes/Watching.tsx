import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PlayCircle } from 'lucide-react';
import { api, type Item } from '../lib/api';
import { useScope } from '../lib/scope';
import {
  forgetAllChannels, forgetAllTitles, forgetChannel, forgetTitle, recentChannels, titlesInProgress,
} from '../lib/watching';
import type { WatchRecord } from '../lib/prefs';
import { WatchTile } from '../components/WatchTile';
import { Nothing } from '../components/Nothing';

/**
 * Everything this profile is watching, on one page.
 *
 * "A page where they can just say see all and it will open a page with all the
 * items for movies and series and so on … on the top menu at the home page like a
 * proper area". The shelves on Movies and Series show a row; this shows all of
 * it — films and series with where they stopped, and the channels they had on —
 * with the same remove on every tile and a clear per tab.
 */
type Tab = 'all' | 'movies' | 'series' | 'live';
const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'movies', label: 'Films' },
  { id: 'series', label: 'Series' },
  { id: 'live', label: 'Channels' },
];

function useItems(section: 'movies' | 'series' | 'live', ids: number[], scope: object) {
  return useQuery({
    queryKey: ['watching', 'page', section, ids, scope],
    queryFn: () => api.items(section, { streamIds: ids, limit: ids.length, ...scope }),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
}

export default function Watching() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('s');
  const tab: Tab = raw === 'movies' || raw === 'series' || raw === 'live' ? raw : 'all';
  const { prefs, scope } = useScope();

  const films = useMemo(() => titlesInProgress('movies'), [prefs.history]);
  const series = useMemo(() => titlesInProgress('series'), [prefs.history]);
  const channels = useMemo(() => recentChannels(), [prefs.plays]);

  const filmItems = useItems('movies', films.map((r) => r.streamId), scope);
  const seriesItems = useItems('series', series.map((r) => r.streamId), scope);
  const channelItems = useItems('live', channels, scope);

  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const t = window.setTimeout(() => setConfirming(false), 3_000);
    return () => window.clearTimeout(t);
  }, [confirming]);
  useEffect(() => { setConfirming(false); }, [tab]);

  const pair = (recs: WatchRecord[], rows: Item[] | undefined) => {
    const byId = new Map((rows ?? []).map((i) => [i.streamId, i] as const));
    return recs.flatMap((rec) => { const item = byId.get(rec.streamId); return item ? [{ rec, item }] : []; });
  };
  const filmRows = pair(films, filmItems.data?.rows);
  const seriesRows = pair(series, seriesItems.data?.rows);
  const channelById = new Map((channelItems.data?.rows ?? []).map((i) => [i.streamId, i] as const));
  const channelRows = channels.flatMap((id) => { const item = channelById.get(id); return item ? [item] : []; });

  const counts: Record<Tab, number> = {
    all: filmRows.length + seriesRows.length + channelRows.length,
    movies: filmRows.length,
    series: seriesRows.length,
    live: channelRows.length,
  };
  const clear = () => {
    if (!confirming) { setConfirming(true); return; }
    setConfirming(false);
    if (tab === 'all' || tab === 'movies') forgetAllTitles('movies');
    if (tab === 'all' || tab === 'series') forgetAllTitles('series');
    if (tab === 'all' || tab === 'live') forgetAllChannels();
  };

  const block = (title: string, children: React.ReactNode, n: number) => n === 0 ? null : (
    <section className="mb-5">
      {tab === 'all' && (
        <h2 className="mb-2 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">{title} · {n}</h2>
      )}
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule/60 px-4 py-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === 'all' ? {} : { s: t.id }, { replace: true })}
            className={`tap rounded-[var(--r-sm)] border px-3 py-1 font-mono text-[length:var(--t-2xs)] uppercase
              tracking-wider ${tab === t.id ? 'border-tally text-tally' : 'border-rule text-ink-3'}`}
          >
            {t.label} <span className="text-ink-3">{counts[t.id]}</span>
          </button>
        ))}
        <span className="flex-1" />
        {counts[tab] > 0 && (
          <button
            type="button"
            onClick={clear}
            className={`tap border px-3 py-1 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider
              ${confirming ? 'border-alert text-alert' : 'border-rule text-ink-3'}`}
          >
            {confirming ? 'Press again to clear' : 'Clear'}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {counts[tab] === 0 ? (
          <Nothing
            Icon={PlayCircle}
            title="Nothing to carry on with yet"
            body="Films and episodes you start show up here with the place you stopped, and so do the channels you watch."
            actions={[{ to: '/movies', label: 'Browse films', primary: true }, { to: '/live', label: 'Live TV' }]}
          />
        ) : (
          <>
            {(tab === 'all' || tab === 'movies') && block('Films', filmRows.map(({ rec, item }) => (
              <WatchTile key={`m-${rec.streamId}`} size="large" item={item} section="movies" rec={rec}
                onRemove={() => forgetTitle('movies', rec.streamId)} />
            )), filmRows.length)}
            {(tab === 'all' || tab === 'series') && block('Series', seriesRows.map(({ rec, item }) => (
              <WatchTile key={`s-${rec.streamId}`} size="large" item={item} section="series" rec={rec}
                onRemove={() => forgetTitle('series', rec.streamId)} />
            )), seriesRows.length)}
            {(tab === 'all' || tab === 'live') && block('Channels', channelRows.map((item) => (
              <WatchTile key={`l-${item.streamId}`} size="large" item={item} section="live"
                onRemove={() => { if (item.streamId !== null) forgetChannel(item.streamId); }} />
            )), channelRows.length)}
          </>
        )}
      </div>
    </div>
  );
}
