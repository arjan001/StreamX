/**
 * A tooltip, and on this app it is not a nicety.
 *
 * There were 81 `title=` attributes doing this job. A native tooltip appears
 * after a browser-chosen delay, only on hover, only on a device with a cursor, in
 * the operating system's font at the operating system's size — which on a
 * television means it never appears at all, and a television is what this app is
 * for. Every hint written that way was invisible to exactly the people who needed
 * it most.
 *
 * So this behaves like the shadcn/Radix one, which is the behaviour people
 * recognise — delay, portal, side flip, arrow, fade-and-lift — with the two
 * changes a ten-foot interface needs:
 *
 *   1. FOCUS opens it, not only hover. On a D-pad, focus IS the pointer: moving
 *      onto a control is the same gesture as pointing at one, and a hint that
 *      requires hover is a hint a remote can never see.
 *   2. It can name the BUTTON that does the same thing, drawn per input by
 *      `KeyCap`. That is what turns a tooltip from a label into a teacher: the
 *      hint on the subtitle control says which remote button skips the menu.
 *
 * Not `@radix-ui/react-tooltip` itself, for two specific reasons rather than
 * taste: Radix's tooltip deliberately never opens on touch, and half this app's
 * users are on a phone; and it opens on hover-or-focus-visible only, where a TV
 * needs plain focus. A dependency whose two central rules both have to be fought
 * is not the shorter path.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShape } from '../lib/formFactor';
import { KeyCap } from './KeyCap';
import type { RemoteIntent } from '../lib/remoteKeys';

/** Long enough not to flash while a cursor crosses a toolbar. Radix uses 700. */
const HOVER_DELAY = 550;
/** Focus is deliberate — you pressed a direction to get here — so barely wait. */
const FOCUS_DELAY = 180;

interface Placement { x: number; y: number; above: boolean }

export function Tooltip({
  label, intent, children, side = 'top', className,
}: {
  /** The words. Short — this is a hint, not documentation. */
  label: ReactNode;
  /** The shortcut that does the same thing, if there is one. */
  intent?: RemoteIntent;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}) {
  const shape = useShape();
  const host = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<Placement | null>(null);

  /**
   * The element the tooltip points at.
   *
   * The wrapper is `display: contents`, so it has no box of its own — that is
   * what keeps a tooltip from changing the layout of the flex row it is added to,
   * and it means the rect has to come from the actual control inside.
   */
  const anchor = useCallback((): HTMLElement | null => {
    const el = host.current?.firstElementChild;
    return el instanceof HTMLElement ? el : null;
  }, []);

  const show = useCallback((delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  }, []);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setAt(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /* Measured after paint, because the flip depends on the tooltip's own height. */
  useLayoutEffect(() => {
    if (!open) return;
    const a = anchor()?.getBoundingClientRect();
    const t = tip.current?.getBoundingClientRect();
    if (!a || !t) return;
    const gap = 8;
    const wantAbove = side === 'top';
    const fitsAbove = a.top - t.height - gap > 4;
    const fitsBelow = a.bottom + t.height + gap < window.innerHeight - 4;
    const above = wantAbove ? fitsAbove || !fitsBelow : !(fitsBelow || !fitsAbove);
    const x = Math.min(
      Math.max(8 + t.width / 2, a.left + a.width / 2),
      window.innerWidth - 8 - t.width / 2,
    );
    setAt({ x, y: above ? a.top - gap : a.bottom + gap, above });
  }, [open, side, anchor]);

  /* Anything that moves the anchor invalidates the position, and a tooltip left
     behind after a scroll is worse than no tooltip. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, hide]);

  /*
    On glass, focus is a side effect of tapping — so a tooltip on focus would pop
    up after every single tap, on top of the thing just tapped. Hover does not
    exist there either, which leaves nothing to trigger it, and that is correct:
    a touch UI has to be legible without hints.
  */
  const byHover = shape.pointer === 'fine';
  const byFocus = shape.pointer !== 'coarse';

  return (
    <>
      <span
        ref={host}
        style={{ display: 'contents' }}
        onPointerEnter={byHover ? () => show(HOVER_DELAY) : undefined}
        onPointerLeave={byHover ? hide : undefined}
        onPointerDown={hide}
        onFocus={byFocus ? () => show(FOCUS_DELAY) : undefined}
        onBlur={hide}
      >
        {children}
      </span>
      {open
        && createPortal(
          <div
            ref={tip}
            role="tooltip"
            className={`tip${at === null ? ' tip-measuring' : ''}${className ? ` ${className}` : ''}`}
            style={at === null
              ? undefined
              : {
                left: at.x,
                top: at.y,
                transform: `translate(-50%, ${at.above ? '-100%' : '0'})`,
              }}
          >
            <span className="min-w-0">{label}</span>
            {intent !== undefined && <KeyCap intent={intent} />}
          </div>,
          document.body,
        )}
    </>
  );
}
