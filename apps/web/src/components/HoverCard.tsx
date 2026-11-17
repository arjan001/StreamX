import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { displayName, marketOf } from '../lib/displayName';
import { api, type Item } from '../lib/api';

/**
 * Detail preview on hover.
 *
 * A catalogue row carries only what a tile needs, so the full record is fetched
 * on hover — after a delay, and cached for the session, because a mouse sweep
 * across a screenful of posters would otherwise fire a hundred requests at a
 * panel that rate-limits.
 */

/** What the panel renders. Movies and series arrive in different shapes; both land here. */
export interface HoverDetail {
  plot: string | null;
  genres: string[];
  cast: string[];
  duration: string | null;
  /** Vertical resolution, when the panel reports it. */
  height: number | null;
  /** Series only: "4 seasons · 62 episodes". */
  extent: string | null;
}

export type HoverKind = 'movies' | 'series';

/** Keyed by kind as well as id: the two detail endpoints are different records. */
const cache = new Map<string, HoverDetail | null>();
const CACHE_MAX = 64;

function rememberHover(key: string, detail: HoverDetail | null): void {
  cache.delete(key);
  cache.set(key, detail);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function splitGenres(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,/|]/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
    .slice(0, 4);
}

function castToStrings(cast: (string | { name: string })[] | undefined): string[] {
  if (!cast) return [];
  return cast.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean);
}

async function fetchDetail(id: number, kind: HoverKind): Promise<HoverDetail> {
  if (kind === 'series') {
    const r = await api.seriesDetail(id);
    const meta = r.meta ?? {};
    const seasons = r.detail.seasons.length;
    const episodes = r.detail.episodes.length;
    return {
      plot: r.series.plot ?? meta.plot ?? null,
      genres: meta.genres?.length ? meta.genres : splitGenres(r.series.genre),
      cast: castToStrings(meta.cast),
      duration: meta.duration ?? null,
      height: meta.video?.height ?? null,
      extent: seasons
        ? `${seasons} season${seasons > 1 ? 's' : ''}${episodes ? ` · ${episodes} ep` : ''}`
        : null,
    };
  }
  const r = await api.movieDetail(id);
  const d = r.detail;
  return {
    plot: d?.plot ?? null,
    genres: d?.genres ?? [],
    cast: castToStrings(d?.cast),
    duration: d?.duration ?? null,
    height: d?.video?.height ?? null,
    extent: null,
  };
}

export function useHoverDetail(
  item: Item | null,
  kind: HoverKind,
  enabled: boolean,
  delay = 420,
): { detail: HoverDetail | null; loading: boolean } {
  const key = item ? `${kind}:${item.id}` : '';
  const [detail, setDetail] = useState<HoverDetail | null>(() => cache.get(key) ?? null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!item || !enabled) {
      setDetail(null);
      return;
    }
    if (cache.has(key)) {
      setDetail(cache.get(key) ?? null);
      return;
    }
    let alive = true;
    // The delay is the flood protection: passing over a card on the way to
    // another one must not cost a request.
    const t = window.setTimeout(() => {
      setLoading(true);
      fetchDetail(item.id, kind)
        .then((d) => {
          rememberHover(key, d);
          if (alive) setDetail(d);
        })
        .catch(() => rememberHover(key, null))
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, delay);
    return () => {
      alive = false;
      window.clearTimeout(t);
      setLoading(false);
    };
  }, [item, kind, key, enabled, delay]);

  return { detail, loading };
}

/**
 * Overlay on the lower part of the art.
 *
 * Absolutely positioned inside the poster box and pointer-events-none, so it can
 * neither reflow the grid nor swallow the click that opens the detail page. It
 * covers the bottom 58% only — obscuring the whole poster while browsing is what
 * made the previous pass unusable.
 */
export function HoverPanel({
  item,
  detail,
  loading,
}: {
  item: Item;
  detail: HoverDetail | null;
  loading: boolean;
}) {
  const meta: string[] = [];
  // The market prefix is real information, just not part of the title.
  const market = marketOf(item.name);
  if (market) meta.push(market);
  if (item.year) meta.push(item.year.slice(0, 4));
  if (detail?.duration) meta.push(detail.duration);
  if (detail?.extent) meta.push(detail.extent);
  if (detail?.height) meta.push(`${detail.height}p`);
  if (item.ext) meta.push(item.ext);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 top-[42%] z-20 flex flex-col
                 justify-end gap-1 bg-gradient-to-t from-black via-black/95 to-transparent
                 px-[6px] pb-[6px] pt-6 anim-fade"
    >
      <p className="line-clamp-2 text-[length:var(--t-xs)] font-medium leading-[14px] text-ink">
        {displayName(item.name, { dropYear: true })}
      </p>
      <div className="flex flex-wrap items-center gap-x-1.5 font-mono text-[length:var(--t-2xs)] text-ink-3">
        {item.rating !== null && item.rating > 0 && (
          <span className="flex items-center gap-0.5 text-tally">
            <Star className="h-2 w-2 fill-current" />
            {item.rating.toFixed(1)}
          </span>
        )}
        {meta.map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>
      {detail?.genres.length ? (
        <p className="truncate font-mono text-[length:var(--t-2xs)] uppercase tracking-wide text-tally/80">
          {detail.genres.slice(0, 3).join(' · ')}
        </p>
      ) : null}
      {loading && !detail && <p className="font-mono text-[length:var(--t-2xs)] text-ink-3">loading…</p>}
      {detail?.plot && (
        <p className="line-clamp-3 text-[length:var(--t-2xs)] leading-[13px] text-ink-2">{detail.plot}</p>
      )}
      {detail?.cast.length ? (
        <p className="truncate text-[length:var(--t-2xs)] text-ink-3">{detail.cast.slice(0, 3).join(', ')}</p>
      ) : null}
    </div>
  );
}
