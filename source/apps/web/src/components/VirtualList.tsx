import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useRef } from 'react';

/**
 * Windowed list over a paged endpoint.
 *
 * A single category here can hold tens of thousands of rows, and the catalogue is
 * 105,795 items — so rows are fetched a page at a time and only the visible
 * window is ever in the DOM. This is also what keeps the component usable on a
 * TV later, where the RAM ceiling is far lower.
 */
/**
 * How much room beyond the window stays rendered, in CSS pixels.
 *
 * A screenful at this app's own viewport (960x540 on the TV boxes it ships on,
 * of which the list owns roughly 430). Chosen as a round number rather than
 * derived from the element: it has to be known before the first measure, and a
 * value that changed with the pane would change the row range on every resize.
 */
const OVERSCAN_PX = 440;

/**
 * One row, drawn again only when the list's CONTENT changes — not when it scrolls.
 *
 * Measured on the TV emulator with a channel playing, CPU at a MediaTek box's
 * speed: handling a D-pad press took 36 ms and the frame after it 477 ms, and
 * most of that frame was this list re-rendering every mounted row (about
 * twenty-five) on every scroll event the keyline produced — the virtualiser
 * re-renders on each scroll, and every row was `render(i)` again. A press
 * moves the window by ONE row, so one row is new and the rest are exactly what
 * they were.
 *
 * `render` is the caller's closure and changes whenever the caller renders —
 * which is precisely when the rows may have changed (new data, a new playing
 * channel, a new guide). A scroll re-renders this list and not the caller, so
 * `render` is the same function and every row already on screen is skipped.
 */
const Row = memo(function Row({ index, render }: { index: number; render: (index: number) => React.ReactNode }) {
  return <>{render(index)}</>;
});

export function VirtualList<T>({
  count,
  rowHeight,
  render,
  onRangeChange,
  className,
  navGroup,
  scrollToIndex,
  scrollToken,
  column = false,
}: {
  count: number;
  rowHeight: number;
  render: (index: number) => React.ReactNode;
  onRangeChange?: (start: number, end: number) => void;
  className?: string;
  /**
   * Name this list for the D-pad.
   *
   * `lib/spatialNav.ts` remembers the last-focused element per named group, so
   * leaving a channel list for the player and coming back lands on the channel
   * you left rather than on whatever is geometrically nearest. Rows are
   * virtualised, so the memory holds an element reference and checks
   * `isConnected` — an index would mean nothing after a scroll.
   */
  navGroup?: string;
  /** Jump this row into view (Guide / deep link). */
  scrollToIndex?: number | null;
  /** Bump to re-scroll even when the index is unchanged (filter change). */
  scrollToken?: number;
  /**
   * One control per row, top to bottom — the channel list. Up and down then
   * move by counting rows instead of measuring the screen; see `columnStep` in
   * lib/spatialNav.ts. Not for a grid of posters, where a row holds several.
   */
  column?: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    /*
     * Let the browser draw the scroll before React catches up with it.
     *
     * The default renders synchronously inside the scroll handler (`flushSync`),
     * so the frame that shows a D-pad move waited for React. The row a move
     * brings into view is already mounted — the overscan below holds a screenful
     * either side — so nothing is missing from the frame if React runs after it.
     */
    useFlushSync: false,
    /*
     * Overscan in PIXELS, not in rows — the two lists using this component are
     * not the same size.
     *
     * A flat `4` means four rows either side of the window whatever a row is. On
     * the channel list, whose rows are 44px, that is 176px of headroom and a
     * flick outruns it. On the poster grid, whose rows are 262px at this
     * viewport, it is 1,048px either side: measured at 960x540, ~1.6 rows are
     * visible and 56 posters were mounted, so four tiles in five were off
     * screen — and each of them is a 342x513 decode the box has to hold. That is
     * the same "decode at tile size" cost that already had to be fixed twice in
     * this codebase, arriving from the count of tiles rather than their size.
     *
     * One screenful of headroom is the rule instead, floored at two rows so a
     * very tall row still has a neighbour ready. `rowHeight` is already a prop
     * and already re-measures this list, so nothing new has to be observed.
     */
    overscan: Math.max(2, Math.round(OVERSCAN_PX / Math.max(1, rowHeight))),
  });

  /* When column width changes, card height changes — without this the virtualiser
     keeps the old row pitch and posters overlap the row below. */
  useEffect(() => {
    v.measure();
  }, [rowHeight, v]);

  useEffect(() => {
    if (scrollToIndex == null || scrollToIndex < 0 || scrollToIndex >= count) return;
    v.scrollToIndex(scrollToIndex, { align: 'center' });
  }, [scrollToIndex, scrollToken, count, v]);

  const items = v.getVirtualItems();
  /* Told when the window MOVES, not on every render: `items` is a new array each
     time the virtualiser renders, which is every scroll event. */
  const lastRange = useRef('');
  const first = items[0]?.index ?? -1;
  const last = items[items.length - 1]?.index ?? -1;
  /* A new handler must hear the current range once, whatever it was — so this
     runs first, and the effect below then reports. */
  useEffect(() => { lastRange.current = ''; }, [onRangeChange]);
  useEffect(() => {
    if (!onRangeChange || first < 0) return;
    const key = `${first}:${last}:${count}`;
    if (key === lastRange.current) return;
    lastRange.current = key;
    onRangeChange(first, last);
  }, [first, last, count, onRangeChange]);

  return (
    <div
      ref={parentRef}
      {...(navGroup === undefined ? {} : { 'data-nav-group': navGroup, 'data-nav-memory': '' })}
      {...(column ? { 'data-nav-column': '' } : {})}
      className={className ?? 'h-full overflow-y-auto'}
    >
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {items.map((row) => (
          <div
            key={row.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: row.size,
              transform: `translateY(${row.start}px)`,
              /* A row's six to eight cards are its own business: `contain` keeps a
                 change inside one row — a poster finishing its decode, a skeleton
                 stopping — from invalidating layout and paint for the whole
                 scroller. Never `size`; the row's height is set right above and
                 containing it would collapse the row. */
              contain: 'layout paint',
            }}
          >
            <Row index={row.index} render={render} />
          </div>
        ))}
      </div>
    </div>
  );
}
