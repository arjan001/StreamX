import { useEffect, useRef, useState } from 'react';

export interface GridMetrics {
  cols: number;
  /** Row pitch: poster + title block + the gutter beneath it. */
  rowHeight: number;
  cardWidth: number;
}

/**
 * Grid geometry, in pixels and deliberately not in rem.
 *
 * The virtualiser puts row N at N * rowHeight, so the number computed here and
 * the gaps the browser actually paints must be the same number. A rem gap would
 * desync silently the moment the root font-size moves (the density switch does
 * exactly that) and the symptom is overlapping rows — so Grid.tsx paints these
 * same constants as inline pixel styles instead of Tailwind's rem spacing.
 *
 * ── and every one of them is now the focus lift, or twice it ──
 *
 * They were 12 and 12, inside 12px of pane padding: posters 24px in from the
 * glass, 12px apart. "too many paddings … why don't you just remove the
 * paddings". What a grid genuinely needs room for is the highlight, and the
 * highlight is `--lift` in index.css: `.tile:focus-visible .art` rises 4px and
 * recolours its 1px edge. So:
 *
 *   GRID_LIFT   inside the TOP of every row. Each virtual row is `contain:
 *               paint`, which clips at the row's own box — measured on 1.17.0,
 *               every focused poster lost its top 4px, its top edge included,
 *               and not only on the first row.
 *   GRID_PAD    the lift again, at the sides: the first and last column's
 *               recoloured edge would otherwise lie on the pane's own hairline,
 *               two parallel 1px lines that read as one unlit edge.
 *   GRID_GAP    twice the lift: a lifted poster still clears the one above it
 *               by the lift, so its bright top edge never touches a neighbour's.
 */
export const GRID_LIFT = 4;
export const GRID_GAP = 8;
/** Horizontal padding inside the scroller, per side. */
export const GRID_PAD = 4;

/**
 * PosterCard's caption block under the poster — which no longer exists.
 *
 * It was 36: a 6px margin and two 15px lines. The title moved ONTO the artwork
 * ("show titles inside it and also too much spacing around"), so the card is
 * exactly the poster and a row is exactly a poster plus its gutter. Kept as a
 * named zero rather than deleted, because this constant and PosterCard have to
 * agree and the next person to put text under a poster needs to find the other
 * half of that agreement here.
 */
const LABEL = 0;
/** height / width of a 2:3 poster. */
const POSTER_RATIO = 3 / 2;
/**
 * Room so subpixel rounding never clips into the next row.
 *
 * It was 8, and with a 12px gutter on top of it that put 20px between rows and
 * 12px between columns — an uneven grid, which was part of the complaint. The
 * focused card does not grow outward (`.tile:focus-visible .art-img` scales the
 * IMAGE inside its frame, and the ring is drawn inset), so all this has to absorb
 * is rounding: 2px, and the rows and columns now sit on nearly the same pitch.
 */
const ROW_SLACK = 2;

/**
 * A classic scrollbar eats width from the scroller's content box, and the ref
 * hangs on the scroller's PARENT (the scroll element itself belongs to
 * VirtualList) — so measure the gutter once rather than paying for it in a
 * card-width overshoot that shows up as a dead strip at the right edge.
 */
let sb: number | null = null;
function scrollbarWidth(): number {
  if (sb !== null) return sb;
  if (typeof document === 'undefined') return 10;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;top:-9999px;visibility:hidden;overflow-y:scroll;width:100px;height:100px';
  document.body.appendChild(probe);
  sb = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return sb;
}

/**
 * Poster width range for a television, as a fraction of the window.
 *
 * Floored at 0.6 rather than falling away with the width: below that the cards
 * stop being posters and start being thumbnails, and a small window is better
 * served by fewer columns than by unreadable ones.
 */
const TV_REF = 1920;
export function tvPosterRange(width: number): [number, number] {
  const scale = Math.min(1.2, Math.max(0.6, width / TV_REF));
  return [Math.round(175 * scale), Math.round(260 * scale)];
}

/** Card height for a given card width — the one place the arithmetic lives. */
export function cardHeightFor(cardWidth: number): number {
  return Math.ceil(cardWidth * POSTER_RATIO) + LABEL + ROW_SLACK;
}

/**
 * Measure the container and derive grid geometry.
 *
 * A hardcoded row height is what made rows overlap: a card is as tall as its
 * poster (width x 1.5) plus a two-line title, so any fixed guess is wrong at
 * every width but one. Only WIDTH is used, which is also why a filter strip
 * appearing above the grid cannot shift the geometry — it changes the scroller's
 * height, and nothing here depends on that.
 */
export function useGridMetrics(
  min = 168,
  max = 230,
  /** When set, ignore min/max fit and use exactly this many columns. */
  fixedCols?: number,
): [React.RefObject<HTMLDivElement | null>, GridMetrics] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [m, setM] = useState<GridMetrics>(() => ({
    cols: fixedCols ?? 6,
    cardWidth: 180,
    rowHeight: cardHeightFor(180) + GRID_GAP,
  }));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const avail = el.clientWidth - GRID_PAD * 2 - scrollbarWidth();
      if (avail <= 0) return;
      let cols: number;
      let cardWidth: number;
      if (fixedCols !== undefined && fixedCols >= 2) {
        cols = fixedCols;
        cardWidth = (avail - GRID_GAP * (cols - 1)) / cols;
      } else {
        // Most columns that still leaves every card at least `min` wide.
        cols = Math.max(2, Math.floor((avail + GRID_GAP) / (min + GRID_GAP)));
        cardWidth = (avail - GRID_GAP * (cols - 1)) / cols;
        // Do not let cards balloon on a very wide screen.
        if (cardWidth > max) {
          cols = Math.max(2, Math.ceil((avail + GRID_GAP) / (max + GRID_GAP)));
          cardWidth = (avail - GRID_GAP * (cols - 1)) / cols;
        }
      }
      setM((prev) =>
        prev.cols === cols && Math.abs(prev.cardWidth - cardWidth) < 0.5
          ? prev
          : { cols, cardWidth, rowHeight: cardHeightFor(cardWidth) + GRID_GAP },
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [min, max, fixedCols]);

  return [ref, m];
}
