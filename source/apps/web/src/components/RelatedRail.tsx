import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, linkId } from '../lib/api';
import { Poster } from './Poster';
import { ArtTile } from './ui';
import { useTileRem } from './Rail';
import { displayName, groupLabel } from '../lib/displayName';

/**
 * "More like this" — the rest of the provider group this title sits in.
 *
 * A detail page that ends at the play button is a dead end, and grouping is the
 * only similarity signal the panel actually gives us (there is no genre field on
 * the list endpoints, only on per-title info). The rail owns its own query so a
 * slow related lookup never delays the hero.
 */
export function RelatedRail({
  id, kind, tileRem, artWidth,
}: {
  id: number;
  kind: 'movies' | 'series';
  /**
   * Tile width in rem, when the page has less room than a rail normally gets.
   *
   * Default is `useTileRem()` — about five across, the same as every rail on the
   * home screen, which is right when this is the last thing on a page somebody
   * scrolls to. The series screen is not that: the episode list and the picture
   * share the screen with it and there is no scrolling, so at the shared size
   * this band measured 450 of a 487px screen and left the two columns above it
   * nothing at all. Screenshotted, and it is the whole page gone.
   */
  tileRem?: number;
  /** Ask the artwork for the size it is drawn at. See lib/artwork.ts. */
  artWidth?: number;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['related', kind, id],
    queryFn: () => api.related(id, kind, 20),
    retry: false,
    staleTime: 300_000,
  });
  const rail = useRef<HTMLDivElement>(null);
  const rows = data?.rows ?? [];
  /* Was a hardcoded 132px, which is a phone tile on a phone and a postage stamp
     on a television. Same source of truth as every other rail in the app. */
  const shared = useTileRem();
  const tile = tileRem ?? shared;
  const TILE = 'shrink-0';
  const tilePx = Math.round(tile * 16);
  const tileStyle = { width: `${tilePx}px` };
  const listBase = kind === 'series' ? '/series' : '/movies';
  const itemBase = kind === 'series' ? '/series' : '/movie';

  // Never leave a titled section with nothing under it — a group of one, or a
  // failed lookup, means there is nothing to say here.
  if (!isLoading && rows.length === 0) return null;

  const nudge = (dir: -1 | 1) => {
    const el = rail.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth, behavior: 'smooth' });
  };

  return (
    <section
      className={`group/rail border-t border-rule sm:px-8 ${
        tileRem === undefined ? 'px-5 py-6' : 'px-5 py-3'
      }`}
    >
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">MORE LIKE THIS</h2>
        {data?.category && (
          /*
            A cursor's shortcut, never a D-pad's stop.

            It sits alone on the heading row, so rule 2 in `lib/spatialNav.ts` —
            a horizontal move stays in its row — leaves RIGHT and LEFT with no
            candidate at all, and it is higher than the tiles, so DOWN out of the
            list above landed HERE rather than on a picture. Measured on the
            series screen: seven presses of DOWN to reach the rail and then a
            dead key. The tiles are what this band is for; the category is a
            label that happens to be clickable.
          */
          <Link
            data-nav-skip
            to={`${listBase}?category=${data.category.id}`}
            className="min-w-0 truncate font-mono text-[length:var(--t-2xs)] text-ink-3 transition-colors hover:text-tally"
          >
            {groupLabel(data.category.cleanName)}
          </Link>
        )}
      </div>

      <div className="relative">
        {/* A strip, like every other rail — see components/Rail.tsx. */}
        <div ref={rail} data-nav-scope className="rail flex gap-3 overflow-x-auto pb-2">
          {isLoading
            ? Array.from({ length: 8 }, (_, i) => (
                <div key={i} className={TILE} style={tileStyle}>
                  <div className="skeleton aspect-[2/3] w-full" />
                  <div className="skeleton mt-1.5 h-3 w-4/5" />
                </div>
              ))
            : rows.map((it) => (
                <ArtTile
                  key={it.id}
                  as={Link}
                  to={`${itemBase}/${linkId(it)}`}
                  style={tileStyle}
                  className={TILE}
                >
                  {/* Asked for at the width it is drawn at, always: this rail
                      used to request master artwork for a 137px tile, which is
                      the single largest cost in the app — see lib/artwork.ts. */}
                  <Poster
                    src={it.logo}
                    alt={displayName(it.name, { dropYear: true })}
                    width={artWidth ?? tilePx}
                  />
                  {/* One line and no year where the band is short — two names of
                      different lengths make two different tile heights, and the
                      year is a badge on the artwork already. */}
                  <p
                    className={`tile-label mt-1.5 text-[length:var(--t-xs)] leading-snug text-ink-2 ${
                      tileRem === undefined ? 'line-clamp-2' : 'truncate'
                    }`}
                  >
                    {displayName(it.name, { dropYear: true })}
                  </p>
                  {it.year && tileRem === undefined && (
                    <p className="font-mono text-[length:var(--t-2xs)] text-ink-3">{it.year.slice(0, 4)}</p>
                  )}
                </ArtTile>
              ))}
        </div>

        {/* Hidden until the rail is hovered or a button is focused: on a TV UI the
            arrows are noise, on a mouse they are the only way past a trackpad. */}
        {rows.length > 0 && (
          <>
            <button
              onClick={() => nudge(-1)}
              aria-label="Scroll left"
              className="absolute left-0 top-1/2 hidden -translate-y-1/2 border border-rule bg-ground/90 p-1.5
                         text-ink-2 opacity-0 transition-opacity hover:border-tally hover:text-tally
                         focus-visible:opacity-100 group-hover/rail:opacity-100 sm:block"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => nudge(1)}
              aria-label="Scroll right"
              className="absolute right-0 top-1/2 hidden -translate-y-1/2 border border-rule bg-ground/90 p-1.5
                         text-ink-2 opacity-0 transition-opacity hover:border-tally hover:text-tally
                         focus-visible:opacity-100 group-hover/rail:opacity-100 sm:block"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </section>
  );
}
