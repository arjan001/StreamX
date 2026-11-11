import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search as SearchIcon, X } from 'lucide-react';
import { pushBackHandler } from '../lib/nativeBack';
import { useOkToType } from '../lib/okToType';
import { useShape } from '../lib/formFactor';
import { rowStep } from '../lib/liveRows';
import { VirtualList } from './VirtualList';

/**
 * One facet of a grid, picked from a list: categories, stars or studios.
 *
 * It replaces rows of chips that stood above a grid —
 * categories, stars and studios, each a horizontal strip — reported as "those 3
 * lines of categories and stuff, find a way to show it efficient and great for
 * TVs and remotes". What was wrong with them on a remote, concretely:
 *
 *   - A strip is walked sideways one chip at a time. Eighty stars is eighty
 *     presses of RIGHT, and the 4,000-odd after the eightieth were not there at
 *     all — the strip stopped and said "+4,114".
 *   - Three strips stacked is three rows DOWN has to cross before it reaches a
 *     film, and each crossing lands wherever the chip above happened to be.
 *   - They took 110px of a 540px television on every visit.
 *
 * So the toolbar keeps one button per facet and this panel does the choosing: a
 * column the D-pad walks up and down, every entry in it (windowed, so four
 * thousand rows cost what twenty do), a field at the top to narrow it by name,
 * and OK to toggle — it stays open, because picking two stars is two presses,
 * not two trips. BACK closes it and focus goes back to the button that opened it.
 *
 * What was chosen is listed first, in the order it was when the panel opened,
 * so reopening it shows the picks without a search; toggling while it is open
 * never moves a row out from under the highlight.
 */
export interface FacetOption {
  id: string;
  label: string;
  count: number;
}

export function FacetPicker({
  title,
  options,
  selected,
  onToggle,
  onClear,
  onClose,
  avatar,
}: {
  title: string;
  options: readonly FacetOption[];
  selected: readonly string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
  /** A picture per entry — the drawn monogram for people. */
  avatar?: (label: string) => string;
}) {
  const shape = useShape();
  const panel = useRef<HTMLDivElement>(null);
  const ok = useOkToType();
  const [needle, setNeedle] = useState('');

  useEffect(() => pushBackHandler(() => { onClose(); return true; }), [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* The picks at the top, frozen at the moment the panel opened. */
  const [leading] = useState(() => new Set(selected));
  const ordered = useMemo(() => {
    if (leading.size === 0) return options;
    const first = options.filter((o) => leading.has(o.id));
    return [...first, ...options.filter((o) => !leading.has(o.id))];
  }, [options, leading]);

  const shown = useMemo(() => {
    const n = fold(needle.trim());
    if (n === '') return ordered;
    return ordered.filter((o) => fold(o.label).includes(n));
  }, [ordered, needle]);

  const on = useMemo(() => new Set(selected), [selected]);

  /* Focus on the first entry, not the field: on a television a field that takes
     focus raises the keyboard over everything. Back where it came from on close. */
  useEffect(() => {
    const cameFrom = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      panel.current?.querySelector<HTMLElement>('[data-facet-row]')?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      if (cameFrom?.isConnected === true) cameFrom.focus();
    };
  }, []);

  /* Long lists get the field; a list that fits on the screen does not need one. */
  const searchable = options.length > 12;
  const step = rowStep(shape.ff, shape.touch);

  /* On <body>, not where it is written: the grid's glass pane is a stacking
     context of its own, and a fixed layer inside one sits UNDER the shell's
     header however high its z-index — the header's buttons were drawn over this
     panel's Done. Opaque, too: glass over a wall of posters is unreadable. */
  return createPortal((
    <div className="anim-fade fixed inset-0 z-[70] flex justify-end bg-black/70">
      <button
        type="button"
        data-nav-skip
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-nav-contain
        className="anim-slide relative z-10 flex h-full w-[min(26rem,90vw)] min-h-0 flex-col
                   border-l border-rule bg-ground pb-[var(--edge-b)] pt-[var(--edge-t)] shadow-2xl"
      >
        <div data-nav-scope className="flex shrink-0 items-center gap-2 border-b border-rule px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--t-2xs)] uppercase tracking-widest text-ink-3">
            {title}
            <span className="ml-2 normal-case tracking-normal text-ink-3">
              {selected.length > 0 ? `${selected.length} chosen` : `${options.length.toLocaleString()}`}
            </span>
          </span>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="tap shrink-0 border border-rule px-2 py-1 font-mono text-[length:var(--t-2xs)] uppercase
                         tracking-wider text-ink-2 hover:text-ink focus-visible:border-focus focus-visible:text-focus"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Done"
            className="tap flex shrink-0 items-center gap-1 border border-tally px-2 py-1 font-mono
                       text-[length:var(--t-2xs)] uppercase tracking-wider text-tally"
          >
            <X className="h-3 w-3" />
            Done
          </button>
        </div>
        {searchable && (
          <div data-nav-scope className="relative shrink-0 border-b border-rule p-2">
            <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <input
              value={needle}
              onChange={(e) => setNeedle(e.target.value)}
              aria-label={`Find in ${title.toLowerCase()}`}
              placeholder={`Find ${title.toLowerCase()}…`}
              enterKeyHint="search"
              {...ok.props}
              className="w-full border border-rule bg-ground/40 py-2 pl-9 pr-3 text-[length:var(--t-sm)] text-ink
                         placeholder:text-ink-3 focus:border-focus focus:outline-none"
            />
          </div>
        )}
        <div data-nav-scope className="relative min-h-0 flex-1">
          {shown.length === 0 ? (
            <p className="p-4 text-[length:var(--t-sm)] text-ink-3">Nothing called that.</p>
          ) : (
            <div className="absolute inset-0">
              <VirtualList
                key={needle.trim() === '' ? 'all' : 'found'}
                count={shown.length}
                rowHeight={step}
                navGroup={`facet-${title}`}
                className="h-full overflow-y-auto"
                render={(i) => {
                  const o = shown[i];
                  if (o === undefined) return null;
                  const picked = on.has(o.id);
                  return (
                    <button
                      type="button"
                      data-facet-row
                      aria-pressed={picked}
                      onClick={() => onToggle(o.id)}
                      className={`pick pick-row row-hover h-full border-b border-rule/40 px-3 ${picked ? 'is-on' : ''}`}
                    >
                      <span
                        aria-hidden
                        className={`flex h-5 w-5 shrink-0 items-center justify-center border ${
                          picked ? 'border-tally bg-tally text-ground' : 'border-rule'}`}
                      >
                        {picked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                      </span>
                      {avatar !== undefined && (
                        <img
                          src={avatar(o.label)}
                          alt=""
                          className="h-8 w-8 shrink-0 overflow-hidden object-cover"
                          style={{ borderRadius: '9999px' }}
                          loading="lazy"
                          decoding="async"
                        />
                      )}
                      <span className={`pick-title min-w-0 flex-1 truncate text-[length:var(--t-md)] ${
                        picked ? 'text-tally' : 'text-ink'}`}
                      >
                        {o.label}
                      </span>
                      <span className="shrink-0 font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
                        {o.count.toLocaleString()}
                      </span>
                    </button>
                  );
                }}
              />
            </div>
          )}
        </div>
      </aside>
    </div>
  ), document.body);
}

/** Case and accents out, so "eva" finds "Éva". */
function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
