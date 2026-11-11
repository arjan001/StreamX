import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { getShape } from '../lib/formFactor';

/**
 * The overlay the stacked layouts borrow space from.
 *
 * When there is no room for a permanent rail — a phone, a tablet in portrait — the
 * rail does not shrink, it moves here. Nothing about the panel inside changes; the
 * country tree is the same component in the same state whether it is a 232px pane
 * on a desktop or a sheet over a phone, which is the only reason this refactor is
 * additive rather than a second set of components.
 *
 * Bottom on a phone, right on a tablet: a phone is held one-handed and the bottom
 * is where the thumb is, while a tablet in portrait is 768px wide and a full-width
 * bottom sheet would be a 768x600 rectangle of country names.
 */
export function Sheet({
  title,
  onClose,
  children,
  side = 'bottom',
  /**
   * Bottom sheets stop short of the top so the page behind stays identifiable.
   *
   * A DEFINITE height, not a max: the panels that go in here end in a
   * `flex-1 overflow-y-auto` scroller, and a percentage height inside an
   * auto-height flex column resolves to auto — so the list would grow to its
   * natural size and get clipped instead of scrolling.
   */
  height = '78dvh',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  side?: 'bottom' | 'right';
  height?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Move focus in, so a remote or a keyboard is not left behind on the page below.
   *
   * Which element, though, is not a detail. `input` came first in that list, and
   * on a television that meant every sheet with a filter box in it opened the
   * platform IME on arrival — the whole screen taken over by a keyboard nobody
   * asked for, with the D-pad now belonging to it. Where there is no cursor, the
   * first CONTROL is the right landing place and the field is something you choose
   * to go to.
   */
  useEffect(() => {
    const remote = getShape().remote;
    const order = remote ? 'button, a[href], [tabindex]:not([tabindex="-1"])' : 'input, button, [tabindex]';
    panel.current?.querySelector<HTMLElement>(order)?.focus();
  }, []);

  const bottom = side === 'bottom';

  return (
    <div
      className={`anim-fade fixed inset-0 z-[60] flex bg-black/60 ${
        bottom ? 'items-end' : 'justify-end'
      }`}
    >
      {/* Inside the contained region, so without `data-nav-skip` this invisible
          full-screen button is what a D-pad lands on when the sheet opens — and
          pressing OK on it closes the sheet you just opened. */}
      <button data-nav-skip className="absolute inset-0 cursor-default" aria-label="Close" onClick={onClose} />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        /* A boundary: neither the arrows nor Tab may walk out of an open sheet
           onto the page behind it. See `spatialNav.chainOf`. */
        data-nav-contain
        style={bottom ? { height } : undefined}
        /* Glass under the modern shell, inert under the others — the same one
           class every other dialog carries, so a sheet is made of what the rest
           of the app is made of. */
        className={`glass-float sheet-panel relative z-10 flex min-h-0 flex-col border-rule bg-panel
          ${bottom
            ? 'anim-rise max-h-full w-full border-t pb-[var(--edge-b)]'
            : 'anim-slide h-full w-[min(22rem,85vw)] border-l pb-[var(--edge-b)] pt-[var(--edge-t)]'}`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-rule px-3 py-2">
          <span className="font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">
            {title.toUpperCase()}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ctl -mr-1 text-ink-3 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* min-h-0 all the way down, or the inner scroller grows instead of scrolling. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </aside>
    </div>
  );
}
