import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Horizontal chip / avatar strip with arrows.
 *
 * Scroll is only from the viewer: arrows, swipe, or bringing a selected chip
 * into view. No idle auto-nudge.
 */
export function HScroll({
  children,
  className,
  scrollKey,
  paged = false,
}: {
  children: React.ReactNode;
  className?: string;
  /** When this changes, scroll the pressed / current child into view. */
  scrollKey?: string | null;
  /**
   * A shelf of equal cards on a grid: the arrows sit OUTSIDE the cards rather
   * than over the first and last one, and each press moves a whole page, which
   * the children's `snap-start` lands on a card edge.
   */
  paged?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [reach, setReach] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setReach({ left: el.scrollLeft > 4, right: el.scrollLeft < max - 4 });
  }, []);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [measure, children]);

  const nudge = useCallback((dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * (paged ? el.clientWidth : Math.max(el.clientWidth * 0.7, 120)), behavior: 'smooth' });
  }, [paged]);

  useEffect(() => {
    if (scrollKey === null || scrollKey === undefined || scrollKey === '') return;
    const el = scroller.current;
    if (!el) return;
    const pressed = el.querySelector<HTMLElement>('[aria-pressed="true"]');
    pressed?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [scrollKey]);

  return (
    <div className="relative">
      <div
        ref={scroller}
        onScroll={measure}
        className={`rail flex flex-nowrap overflow-x-auto pb-1 ${paged ? 'snap-x snap-mandatory' : ''} ${className ?? 'gap-2'}`}
      >
        {children}
      </div>
      <StripArrow side="left" onClick={() => nudge(-1)} enabled={reach.left} outside={paged} />
      <StripArrow side="right" onClick={() => nudge(1)} enabled={reach.right} outside={paged} />
    </div>
  );
}

function StripArrow({
  side, onClick, enabled, outside = false,
}: {
  side: 'left' | 'right';
  onClick: () => void;
  enabled: boolean;
  outside?: boolean;
}) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      aria-label={side === 'left' ? 'Scroll left' : 'Scroll right'}
      className={`pill absolute top-1/2 z-20 grid h-8 w-8 -translate-y-1/2 place-items-center border
                  border-rule bg-ground/95 text-ink-2 shadow-lg transition-opacity
                  hover:border-tally hover:text-tally disabled:pointer-events-none disabled:opacity-0
                  ${outside
                    ? (side === 'left' ? '-left-11' : '-right-11')
                    : (side === 'left' ? 'left-0' : 'right-0')}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
