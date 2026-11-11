import { useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Info, ListVideo, Play, Star, StarOff } from 'lucide-react';
import { Poster } from './Poster';
import { ArtTile } from './ui';
import { useLongPress } from '../lib/longPress';
import { toggleFav } from '../lib/prefs';
import { usePrefs, type FavSection } from '../lib/prefs';
import { useShape } from '../lib/formFactor';
import { watchFraction } from '../lib/watch';
import { HoverPanel, useHoverDetail, type HoverKind } from './HoverCard';
import { HoldMenu, type HoldAction } from './HoldMenu';
import { displayName } from '../lib/displayName';
import type { Item } from '../lib/api';
import { getListArtReady, listArt, subscribeListArt } from '../lib/listArt';

/**
 * Grid tile.
 *
 * The title block is a fixed two-line box in pixels, not a wrapping paragraph in
 * rem: the virtualiser positions rows by a computed height, so a card that is
 * taller when its title is long puts every following row a few pixels out — which
 * is one half of what made rows overlap. useGridMetrics.LABEL mirrors these
 * numbers; change one and change both.
 *
 * `kind` also turns hover detail on. Live channels have no VOD record, so
 * leaving it off is what keeps a live grid from asking for one.
 */
export function PosterCard({
  item,
  to,
  kind,
  favSection,
  onPreview,
  artWidth,
  replace,
  subtitle,
  isAdult,
}: {
  item: Item;
  to: string;
  kind?: HoverKind;
  /** Which favourites list this tile belongs to. Omit to hide the star. */
  favSection?: FavSection;
  /** Called when focus or the pointer lands here. */
  onPreview?: (item: Item) => void;
  /**
   * One quiet line under the title, inside the card — a studio or a
   * channel, for instance. Text, not a link: the card is already the link, a link
   * inside a link is invalid, and on a remote a second focus stop on every card
   * doubles the presses it takes to cross a row.
   */
  subtitle?: string | null;
  /**
   * How wide this tile is drawn, in CSS pixels — from the grid's own measurement.
   *
   * The grid computes a card width every layout to fit its columns; passing it
   * down is what lets the poster be requested at that size rather than as the
   * origin's master copy. See lib/artwork.ts.
   */
  artWidth?: number;
  /**
   * Replace the history entry instead of pushing one.
   *
   * For a grid that is a PICKER rather than a doorway — the one under the series
   * desk, where every tile is an address on the page you are already on. Walking
   * six titles there must not put six entries between the viewer and BACK out of
   * the section.
   */
  replace?: boolean;
  /** Whether this is an adult content card for special hover styling. */
  isAdult?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [prefs] = usePrefs();
  /* A film whose own poster is on a dead host borrows a sibling's, and that
     index is built in idle time rather than blocking the first paint — so this
     tile repaints once it lands. See lib/listArt.ts. */
  useSyncExternalStore(subscribeListArt, getListArtReady, getListArtReady);
  /* Hold the tile to favourite it. The star used to be a `<button>` inside this
     `<Link>` — nested interactive elements, which is what made a D-pad moving
     RIGHT land on the star instead of the next poster. See lib/longPress.ts. */
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  /*
   * Hold opens the menu; it used to favourite outright.
   *
   * The star is still one press away inside it, and the trade is worth making:
   * an invisible gesture that did one invisible thing is now an invisible
   * gesture that SHOWS you everything it can do, including the destination
   * `openStyle` did not pick. Asked for as "on hold show menu ifthey wanna see
   * details page".
   */
  const holdFav = useLongPress(() => setMenu(true));
  const shape = useShape();
  /**
   * The preview panel is worth it where "point at a thing without committing to it"
   * is a real gesture: a cursor hovering, or a D-pad landing on a tile — on TV that
   * IS the detail view. On glass there is no such gesture; the only way to point at
   * a poster is to tap it, which already opens the full page. So the panel is off
   * on handhelds rather than flashing over the art on the way to navigating.
   */
  /* Always: the only layout is the one that wants previews. */
  const previews = true;
  // Display only — the raw name is what the API matches on, so it never leaves
  // this render. The year is a badge on the art, so it comes out of the title.
  const label = displayName(item.name, { dropYear: true });
  const { detail, loading } = useHoverDetail(item, kind ?? 'movies', hover && kind !== undefined && previews);
  const year = item.year ? item.year.slice(0, 4) : null;
  const rating = item.rating !== null && item.rating > 0 ? item.rating.toFixed(1) : null;
  /*
   * One meta line under the title: the rating, the year, and whatever the caller
   * adds (a studio, for instance).
   *
   * They were two badges in two corners on two different lines — rating top-left,
   * year top-right one row LOWER so it cleared the favourite star — so a grid of
   * posters carried two staggered columns of chips across every tile. The owner,
   * with a screenshot of the Series grid: "why do i see mutiple cols for date and
   * rating badges and soon". Now the corner holds one mark, and only on a
   * favourite; the facts sit with the title they describe, in one line, quieter
   * than the title because they are the less important two.
   */
  const meta = [year, subtitle != null && subtitle !== '' ? subtitle : null]
    .filter((x): x is string => x !== null);
  const showPanel = hover && kind !== undefined && previews;
  const rec =
    (kind === 'movies' || kind === 'series') && item.streamId !== null
      ? prefs.history.find((r) => r.section === kind && r.streamId === item.streamId) ?? null
      : null;
  const frac = watchFraction(rec);
  const starred = favSection !== undefined && item.streamId !== null
    && prefs.favs[favSection].includes(item.streamId);

  /*
   * Whichever destination the setting did NOT choose, plus the star.
   *
   * `to` already means "whatever openStyle says", so the menu only has to offer
   * the other one — and the two are genuinely different screens rather than two
   * routes to the same place, which is why both are named rather than one being
   * called "more".
   */
  const sep = to.includes('?') ? '&' : '?';
  const actions: HoldAction[] = [
    prefs.openStyle === 'fullscreen'
      ? {
        id: 'details',
        label: 'Show details',
        hint: 'plot, cast and specifications',
        Icon: Info,
        act: () => nav(`${to}${sep}details=1`),
      }
      : {
        id: 'play',
        label: kind === 'series' ? 'Episodes' : 'Play now',
        hint: kind === 'series' ? 'straight to the episode list' : 'straight to the picture',
        Icon: kind === 'series' ? ListVideo : Play,
        primary: true,
        act: () => nav(to),
      },
    ...(favSection !== undefined && item.streamId !== null
      ? [{
        id: 'fav',
        label: starred ? 'Remove from favourites' : 'Add to favourites',
        Icon: starred ? StarOff : Star,
        act: () => { toggleFav(favSection, item.streamId as number); },
      }]
      : []),
  ];

  return (
    <>
    <ArtTile
      as={Link}
      to={to}
      {...(replace === true ? { replace: true } : {})}
      /* What the remote's STAR button means when focus is on this tile. Read by
         the screen's RED/STAR binding — see `routes/Grid.tsx`. */
      data-stream-id={item.streamId ?? undefined}
      data-fav-section={favSection}
      onEnter={() => { setHover(true); onPreview?.(item); }}
      onLeave={() => setHover(false)}
      {...holdFav}
      className={isAdult && hover ? 'ring-2 ring-offset-2 ring-pink-500 ring-purple-500 rounded-lg' : ''}
    >
      <div className="relative">
        <Poster src={listArt(item)} alt={label} width={artWidth} />
        {/* The one corner mark, and only on a favourite. */}
        {favSection && item.streamId !== null && prefs.favs[favSection].includes(item.streamId) && (
          /* A mark, not a control — hold the tile, or press the remote's STAR key. */
          <span aria-hidden className="absolute right-1 top-1 z-10 bg-black/85 p-0.5">
            <Star className="h-3 w-3 fill-current text-tally" />
          </span>
        )}
        {frac !== null && (
          <span className="meter-edge pointer-events-none absolute inset-x-0 bottom-0 z-20 h-0.5 bg-black/50">
            <span className="block h-full bg-tally" style={{ width: `${frac * 100}%` }} />
          </span>
        )}
        {showPanel ? (
          <HoverPanel item={item} detail={detail} loading={loading} />
        ) : (
          /*
           * The title lives ON the artwork now.
           *
           * It was a separate two-line caption under every poster — 36px of text
           * block plus its margin, per card, per row — and on a five-across grid
           * that is what made the screen read as rows of pictures with sentences
           * floating between them: "also show titles inside it and also too much
           * spacing around, i mean, make it proper clean grid and details inside
           * it". With the caption inside, the card IS the poster, and the row
           * pitch in `useGridMetrics` loses the caption with it.
           *
           * The veil is taller and darker than the 40px fade it replaces, because
           * it now has a job: a lot of this catalogue's artwork is pale, and white
           * text at the bottom of a poster that is white at the bottom is not a
           * title. `text-white` rather than a theme token on purpose — this sits on
           * a photograph, not on the app's ground, so it must not turn dark in the
           * light palette. Two lines, clamped: a card that grows to fit
           * "Kenzie Anne & Emily Willis & Alina Lopez - Breaking Through" breaks
           * the rhythm this change is for. The full name is still the tooltip.
           *
           * Rating stays top-left and the year top-right, where they were: those
           * are glanceable facts, and the title is the thing to read — putting all
           * three in one block would make the least important two the loudest.
           */
          /*
           * NOT `.tile-veil`, which it first was and which made the title invisible:
           * `index.css` gives the veil `opacity: 0` and only fades it in on hover or
           * focus, because it was a decoration. A title is not a decoration — it
           * must be readable on every card, not only the one the remote is on — so
           * the caption is its own always-on layer with its own gradient.
           */
          <div
            className="tile-caption pointer-events-none absolute inset-x-0 bottom-0 z-10
                       bg-gradient-to-t from-black/90 via-black/55 to-transparent px-2 pb-1.5 pt-10"
          >
            <p
              className="line-clamp-2 text-[length:var(--t-xs)] font-medium leading-tight text-white"
              title={displayName(item.name)}
            >
              {label}
            </p>
            {(rating !== null || meta.length > 0) && (
              /* One line that truncates, never a third line: the studio folds in
                 here rather than growing the caption up the artwork. */
              <p className="mt-0.5 truncate text-[length:var(--t-2xs)] leading-tight text-white/70">
                {rating !== null && (
                  <span className="text-tally">
                    <Star aria-hidden className="mr-0.5 inline h-2.5 w-2.5 -translate-y-px fill-current align-middle" />
                    {rating}
                  </span>
                )}
                {rating !== null && meta.length > 0 && ' · '}
                {meta.join(' · ')}
              </p>
            )}
          </div>
        )}
      </div>
    </ArtTile>
    {menu && (
      <HoldMenu title={label} actions={actions} onClose={() => setMenu(false)} />
    )}
    </>
  );
}
