import { useEffect, useRef } from 'react';
import { pushBackHandler } from '../lib/nativeBack';

/**
 * What holding OK on a tile offers.
 *
 * Hold used to favourite the title outright, and that was invisible: nothing on
 * a poster says "hold me", so the only people who ever found it were told. The
 * owner asked for the menu instead — "now like on hold show menu ifthey wanna
 * see details page" — and it earns its keep twice over now that `openStyle`
 * exists, because whichever destination the setting did NOT choose lives here.
 * One gesture, both answers, and the star stops being folklore.
 *
 * ── why it is a panel and not a row of icons on the tile ──
 *
 * A D-pad has no second button to press. Anything drawn ON the tile has to be
 * reachable by moving onto it, which is what put a star between two posters and
 * made RIGHT stop walking the rail — the bug that made `useLongPress` necessary
 * in the first place. A panel takes focus wholly and gives it back on close, so
 * the rail underneath is exactly where it was.
 *
 * ── containment ──
 *
 * `data-nav-contain` keeps arrows inside while it is open, `data-nav-first` puts
 * the remote on the top action, and BACK closes it through `pushBackHandler`
 * rather than leaving the screen — a menu that swallowed BACK by accident would
 * be worse than no menu.
 */
export interface HoldAction {
  id: string;
  label: string;
  /** The second line, when the label alone is not the whole story. */
  hint?: string;
  Icon: React.ComponentType<{ className?: string }>;
  act: () => void;
  /** Drawn in the tally colour — the one thing this menu is mostly for. */
  primary?: boolean;
}

export function HoldMenu({
  title,
  actions,
  onClose,
}: {
  title: string;
  actions: readonly HoldAction[];
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  /* BACK closes the menu and goes no further. Registered before the Escape
     listener so both routes out behave identically on a remote and on glass. */
  useEffect(() => pushBackHandler(() => { onClose(); return true; }), [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /*
   * Focus lands here, and goes back where it came from on close.
   *
   * Saved rather than recomputed: the tile that opened this is the tile the
   * viewer was on, and after a favourite it may have re-rendered — but it is the
   * same element, so a reference survives what a selector would not.
   */
  useEffect(() => {
    const cameFrom = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('[data-nav-first]');
    first?.focus();
    return () => { if (cameFrom?.isConnected === true) cameFrom.focus(); };
  }, []);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      {/* Dismiss by clicking away. `data-nav-skip` so a D-pad never lands on a
          full-screen invisible button — see spatialNav. */}
      <button
        type="button"
        data-nav-skip
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ground/80"
      />
      <div
        ref={panel}
        data-nav-contain
        data-nav-scope
        role="dialog"
        aria-label={title}
        className="glass-float sheet-panel relative w-[min(22rem,88vw)] border border-rule bg-panel shadow-2xl anim-rise"
      >
        <p className="truncate border-b border-rule px-3 py-2 font-mono
                      text-[length:var(--t-2xs)] uppercase tracking-widest text-ink-3">
          {title}
        </p>
        <div className="flex flex-col">
          {actions.map((a, i) => (
            <button
              key={a.id}
              type="button"
              {...(i === 0 ? { 'data-nav-first': true } : {})}
              onClick={() => { onClose(); a.act(); }}
              className={`tap flex items-center gap-2.5 border-b border-rule/50 px-3 py-2.5
                          text-left transition-colors last:border-b-0 ${
                a.primary ? 'text-tally' : 'text-ink-2 hover:text-ink'}`}
            >
              <a.Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[length:var(--t-sm)]">{a.label}</span>
                {a.hint !== undefined && (
                  <span className="block truncate font-mono text-[length:var(--t-2xs)] text-ink-3">
                    {a.hint}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
