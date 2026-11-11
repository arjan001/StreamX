import {
  forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ElementType, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useShape } from '../lib/formFactor';
import { useKeyLayer, type Binding } from '../lib/keys';
import { pushBackHandler } from '../lib/nativeBack';
import { useOkToType } from '../lib/okToType';

/**
 * The primitives. Everything that draws a surface goes through here.
 *
 * This file exists because of a bug that could not have happened if it already
 * did. The six tiles on the home page were written as a copied class string —
 * `border border-rule bg-panel px-3 py-3 hover:border-tally` — five of them on an
 * `<a>` and one on a `<button>`. The stylesheet's radius rule keys on element
 * names, so exactly one of the six was round and five were square. A style audit
 * over the computed styles then found **310 square surfaces in 9 shapes**: two
 * poster badges (263 of them), the guide's channel column, the wordmark tile, and
 * those menu tiles.
 *
 * Every one of those was a class string typed out again somewhere. So the rule
 * from here on is: a bordered or filled box is a `<Card>`, a label over artwork is
 * a `<Badge>`, a small toggle is a `<Chip>`, a control is a `<Button>`, and a
 * full-width strip is a `<Band>`. `scripts/style-audit.mjs` enforces it — it
 * fails on any surface with no radius that has not explicitly opted out.
 *
 * `as` rather than six near-identical components: a card is a card whether it
 * navigates, submits, or just sits there, and making the ELEMENT a parameter is
 * what stops "the same thing" being three different things again.
 */

type Tone = 'default' | 'raised' | 'quiet';

export interface CardProps {
  as?: ElementType;
  /** Lift and highlight on hover/focus. Off for a card that is not a target. */
  interactive?: boolean;
  tone?: Tone;
  className?: string;
  children?: ReactNode;
  /* The catch-all comes last and is typed loosely on purpose — these components
     forward `to`, `href`, `onClick`, `title` and aria attributes to whatever
     element `as` names, and enumerating the union of all of them would be a
     bigger surface than the components themselves. */
  [key: string]: unknown;
}

const TONE: Record<Tone, string> = {
  default: 'card',
  /** Sits on top of another surface, so it needs more separation. */
  raised: 'card bg-panel-2',
  /** Barely there: a grouping, not an object. */
  quiet: 'card bg-transparent',
};

/**
 * A bordered, filled, rounded box.
 *
 * The radius comes from `--r-md`, which is 0 under `data-ui='square'` — so the
 * squared instrument look is still one setting away and nothing here has to know
 * about it.
 */
export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { as, interactive = false, tone = 'default', className, children, ...rest }: CardProps, ref,
) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag
      ref={ref}
      className={`${TONE[tone as Tone]}${interactive ? ' card-hover tap' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </Tag>
  );
});

/**
 * A label over artwork: a rating, a year, a quality mark.
 *
 * Always a pill, always translucent-dark, never a bare box. These were 263 of the
 * 310 squares the audit found, in two shapes that differed only in position —
 * which is what happens when the same idea is written twice.
 */
export function Badge({
  children, className, tone = 'neutral',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'neutral' | 'accent' | 'live';
}) {
  const colour = tone === 'accent' ? 'text-tally' : tone === 'live' ? 'text-live' : 'text-ink-2';
  return (
    <span
      className={`pointer-events-none pill absolute z-30 flex items-center gap-0.5 bg-black/75 px-1.5
                  py-0.5 font-mono text-[length:var(--t-2xs)] ${colour}${className ? ` ${className}` : ''}`}
    >
      {children}
    </span>
  );
}

export interface ChipProps {
  as?: ElementType;
  /** Drives both the accent styling and `aria-pressed`, so they cannot disagree. */
  on?: boolean;
  className?: string;
  children?: ReactNode;
  [key: string]: unknown;
}

/** A small, fully rounded toggle or tag. */
export const Chip = forwardRef<HTMLElement, ChipProps>(function Chip(
  { as, on, className, children, ...rest }, ref,
) {
  const Tag = (as ?? 'button') as ElementType;
  return (
    <Tag
      ref={ref}
      className={`chip${on ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
      {...(Tag === 'button' ? { type: 'button', 'aria-pressed': on === undefined ? undefined : on } : {})}
      {...rest}
    >
      {children}
    </Tag>
  );
});

export interface ButtonProps {
  as?: ElementType;
  variant?: 'default' | 'primary' | 'ghost';
  /** Square-ish icon button: equal padding, no label. */
  icon?: boolean;
  pill?: boolean;
  className?: string;
  children?: ReactNode;
  [key: string]: unknown;
}

export const Button = forwardRef<HTMLElement, ButtonProps>(function Button(
  { as, variant = 'default', icon = false, pill = true, className, children, ...rest }, ref,
) {
  const Tag = (as ?? 'button') as ElementType;
  return (
    <Tag
      ref={ref}
      className={`btn${variant === 'primary' ? ' btn-primary' : ''}`
        + `${variant === 'ghost' ? ' border-transparent bg-transparent' : ''}`
        + `${pill ? ' pill' : ''}${icon ? ' p-2.5' : ''}${className ? ` ${className}` : ''}`}
      {...(Tag === 'button' ? { type: 'button' } : {})}
      {...rest}
    >
      {children}
    </Tag>
  );
});

/**
 * A text field.
 *
 * There were ten of these, spelled out longhand in six files —
 * `border border-rule bg-ground px-2 py-1.5 font-mono text-[length:var(--t-xs)] …` — and they
 * had already drifted: three different paddings, two different text sizes, and
 * one that had lost its focus colour. A search box is a search box.
 *
 * The optional leading icon and clear button are here because every one of those
 * ten had both, written out again each time.
 *
 * On a TV remote, focus parks and OK starts typing (`useOkToType`) — so walking
 * past a field does not raise the IME. Pass `okToType={false}` to type on focus.
 */
export function Field({
  value, onValue, placeholder, icon, clearable = true, className, okToType = true, ...rest
}: {
  value: string;
  onValue: (next: string) => void;
  placeholder?: string;
  icon?: ReactNode;
  clearable?: boolean;
  className?: string;
  /** Opt out: type immediately on focus (default parks until OK/Enter). */
  okToType?: boolean;
  [key: string]: unknown;
}) {
  const {
    onKeyDown: ownKeyDown,
    onBlur: ownBlur,
    onPointerDown: ownPointerDown,
    ...inputRest
  } = rest as {
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
    onPointerDown?: (e: React.PointerEvent<HTMLInputElement>) => void;
    [key: string]: unknown;
  };
  const ok = useOkToType({ onKeyDown: ownKeyDown, onBlur: ownBlur });

  return (
    <span className={`relative block min-w-0${className ? ` ${className}` : ''}`}>
      {icon && (
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3">
          {icon}
        </span>
      )}
      <input
        value={value}
        onChange={(e) => onValue((e.target as HTMLInputElement).value)}
        placeholder={placeholder}
        /* A placeholder is not a name: it is gone the moment something is typed,
           and a tooltip or the hint bar has nothing to say about an unnamed
           field. A caller's own `aria-label` in `rest` still wins. */
        aria-label={placeholder}
        className={`w-full border border-rule bg-ground py-1.5 font-mono text-[length:var(--t-xs)] text-ink
                    outline-none placeholder:text-ink-3 focus:border-focus
                    ${icon ? 'pl-7' : 'pl-2'} ${clearable ? 'pr-7' : 'pr-2'}`}
        {...inputRest}
        {...(okToType
          ? {
              ...ok.props,
              onPointerDown: (e: React.PointerEvent<HTMLInputElement>) => {
                ok.props.onPointerDown(e);
                ownPointerDown?.(e);
              },
            }
          : {
              onKeyDown: ownKeyDown,
              onBlur: ownBlur,
              onPointerDown: ownPointerDown,
            })}
      />
      {clearable && value !== '' && (
        <button
          type="button"
          onClick={() => {
            onValue('');
            ok.park();
          }}
          aria-label="Clear"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
        >
          <XIcon />
        </button>
      )}
    </span>
  );
}


/** The clear affordance on a field, and small enough to sit inside one. */
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5"
         strokeLinecap="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/**
 * A floating panel: a dropdown, a menu, a settings popover.
 *
 * Three of these existed with the same class string and three different shadows.
 * The backdrop is part of the component because a popover without one traps the
 * next click, and two of the three had forgotten it.
 */
export function Popover({
  children, onClose, className, label, z = 50, anchor,
}: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
  label: string;
  /** Stacking order — bump when opening above a Sheet (z-60). */
  z?: number;
  /**
   * What this hangs from. With it, the panel leaves the page entirely — see
   * below — and is placed against this element's rectangle instead.
   */
  anchor?: React.RefObject<HTMLElement | null>;
}) {
  /*
   * Portalled to the body, and positioned against the anchor.
   *
   * It used to be an `absolute` child of whatever opened it, and that is why the
   * caption language list was cut in half: it sat inside the captions popover's
   * own `overflow-y-auto`, which sits inside the player stage's
   * `overflow-hidden` — "it overflows below the player", photographed. No amount
   * of z-index escapes an ancestor that clips; only leaving the subtree does.
   *
   * `Tooltip` already did this and was the only thing in the app that did. This
   * is the same shape, in the primitive every dropdown goes through, so nothing
   * has to decide it again.
   */
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const host = anchor?.current;
    const box = panel.current;
    if (!host || !box) return;
    const place = () => {
      const r = host.getBoundingClientRect();
      const h = box.offsetHeight || 0;
      const w = box.offsetWidth || r.width;
      const margin = 8;
      /* Below by default; above when there is no room below and more above —
         a list of sixteen languages at the bottom of a television otherwise
         renders off the screen entirely. */
      const below = window.innerHeight - r.bottom;
      const top = below >= h + margin || below >= r.top
        ? r.bottom + 4
        : Math.max(margin, r.top - h - 4);
      const left = Math.min(
        Math.max(margin, r.left),
        Math.max(margin, window.innerWidth - w - margin),
      );
      setAt({ left, top, width: r.width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  const body = (
    <>
      <button
        type="button"
        data-nav-skip
        className="fixed inset-0 cursor-default"
        style={{ zIndex: z - 1 }}
        aria-label={`Close ${label}`}
        onClick={onClose}
      />
      <div
        ref={panel}
        /* A menu contains focus. This is the primitive every dropdown in the app
           goes through, which is why the attribute belongs HERE and not on each
           of them — the containment bug was exactly the cost of deciding it
           per-component. */
        data-nav-contain
        /* `glass-float sheet-panel`, like every other panel in the app: the
           hand-rolled `card` here is why a dropdown wore a different corner and
           a flat fill beside the glass panels around it. */
        className={`glass-float sheet-panel anim-rise shadow-2xl ${anchor ? 'fixed' : 'absolute'}${
          className ? ` ${className}` : ''
        }`}
        style={
          anchor
            ? { zIndex: z, left: at?.left ?? -9999, top: at?.top ?? -9999, minWidth: at?.width }
            : { zIndex: z }
        }
        role="dialog"
        aria-label={label}
      >
        {children}
      </div>
    </>
  );

  return anchor ? createPortal(body, document.body) : body;
}

export interface SelectOption {
  value: string;
  label: string;
  /** Quiet secondary text on the right of a row (a count, a hint). */
  hint?: string;
}

/**
 * App select — not a native `<select>`.
 *
 * Native OS menus look like a browser form, ignore the skin, and on a television
 * remote they open platform chrome the rest of the UI never does. Same surface
 * language as the player menus: trigger + `menu-row` list.
 */
export function Select({
  value,
  onChange,
  options,
  label,
  className,
  fullWidth = false,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  options: SelectOption[];
  /** Accessible name for the control. */
  label: string;
  className?: string;
  fullWidth?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);
  const shown = current?.label ?? placeholder ?? label;
  /**
   * A field to narrow the list, once the list is long enough to need one.
   *
   * "the language selector is bad, no search". Sixteen caption languages and
   * fourteen subtitle ones are a long walk on a D-pad; eight is about where
   * reading the whole list stops being faster than typing two letters.
   */
  const searchable = options.length > 8;
  const listed = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (q === '') return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, find]);
  useEffect(() => { if (!open) setFind(''); }, [open]);
  /* The same rule as every other field: focus parks, OK types. */
  const listFilter = useOkToType();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <span className={`relative inline-block min-w-0${fullWidth ? ' w-full' : ''}${className ? ` ${className}` : ''}`}>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`tap flex w-full items-center gap-1.5 border border-rule bg-ground px-2 py-1.5
                    font-mono text-[length:var(--t-xs)] text-ink outline-none
                    hover:border-ink-3 focus:border-focus ${fullWidth ? '' : 'min-w-[7rem]'}`}
        style={{ borderRadius: 'var(--r-sm)' }}
      >
        <span className="min-w-0 flex-1 truncate text-left">{shown}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <Popover
          label={label}
          onClose={() => setOpen(false)}
          z={70}
          anchor={trigger}
          className="max-h-[min(20rem,60vh)] overflow-y-auto py-1 max-w-[min(22rem,90vw)]"
        >
          {searchable && (
            <div className="sticky top-0 z-10 border-b border-rule bg-panel/95 p-1.5">
              <input
                value={find}
                onChange={(e) => setFind(e.target.value)}
                aria-label={`Search ${label}`}
                placeholder="type to narrow…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                {...listFilter.props}
                className="w-full border border-rule bg-ground px-2 py-1 font-mono
                           text-[length:var(--t-2xs)] text-ink outline-none
                           placeholder:text-ink-3 focus:border-focus"
              />
            </div>
          )}
          {listed.length === 0 && (
            <p className="px-3 py-2 font-mono text-[length:var(--t-2xs)] text-ink-3">
              nothing matches “{find.trim()}”.
            </p>
          )}
          {listed.map((o) => {
            const on = o.value === value;
            return (
              <button
                key={o.value === '' ? '__empty' : o.value}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`menu-row ${on ? 'is-on' : ''}`}
              >
                <span className="dot" />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint !== undefined && (
                  <span className="ml-auto shrink-0 font-mono text-[length:var(--t-2xs)] text-ink-3">
                    {o.hint}
                  </span>
                )}
              </button>
            );
          })}
        </Popover>
      )}
    </span>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * A full-width strip: a toolbar, a filter row, a status bar.
 *
 * Deliberately square, and it says so. A band spans its container edge to edge,
 * and a rounded edge-to-edge strip reads as a mistake rather than as a card — so
 * this carries `no-round`, which is also what stops the style audit reporting it.
 * The distinction between "a card that happens to be wide" and "a band" is the one
 * judgement this file asks a caller to make.
 */
export function Band({
  children, className, as,
}: {
  children?: ReactNode;
  className?: string;
  as?: ElementType;
}) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag className={`no-round border-rule bg-panel${className ? ` ${className}` : ''}`}>
      {children}
    </Tag>
  );
}

/* ── art tiles ──────────────────────────────────────────────────────────────
   The fourth place this file earns its keep, and the one that fixed a bug no
   audit of static classes could see.

   A tile — poster, channel logo, browse strip — was written out four times, in
   `PosterCard`, `Home`'s channel row and `Search`, each as
   `group block focus-visible:outline-none` plus a handful of `group-hover:`
   utilities on the children. `group-hover:` compiles to `.group:hover &`, which
   matches on ANY ancestor. `Rail`'s own section was also a `.group` — for
   nothing, as it turned out — so pointing at one poster lifted all twenty-four
   in the strip, dimmed all twenty-four gradients up, and brightened all
   twenty-four labels. Both files were individually correct.

   `ArtTile` owns that relationship instead: `.tile` is the hover scope, the
   stylesheet keys the frame, image, label and veil off it, and a rail cannot be
   a `.tile`. There is no `group-hover:` left in a card to get captured. */

export interface ArtTileProps {
  /** `Link` for a destination, `button` for an action. Same tile either way. */
  as?: ElementType;
  className?: string;
  children?: ReactNode;
  /** Hover/focus notifications for callers that fetch preview detail. */
  onEnter?: () => void;
  onLeave?: () => void;
  [key: string]: unknown;
}

export const ArtTile = forwardRef<HTMLElement, ArtTileProps>(function ArtTile(
  { as, className, children, onEnter, onLeave, ...rest }: ArtTileProps, ref,
) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag
      ref={ref}
      className={`tile block focus-visible:outline-none${className ? ` ${className}` : ''}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      {...rest}
    >
      {children}
    </Tag>
  );
});

/**
 * The caption under a tile's artwork.
 *
 * Fixed height in pixels, not a wrapping paragraph in rem: the grid virtualiser
 * positions rows by a computed height, so a card that grows when its title is
 * long puts every following row a few pixels out — which was one half of what
 * made rows overlap. `useGridMetrics.LABEL` mirrors these numbers.
 */
export function TileLabel({
  children, lines = 2, title, className,
}: {
  children?: ReactNode;
  /** 2 in a grid, where every row must be the same height; 1 in a dense rail. */
  lines?: 1 | 2;
  title?: string;
  className?: string;
}) {
  const shape = lines === 2
    ? 'mt-[6px] line-clamp-2 h-[30px] text-[length:var(--t-xs)] leading-[15px]'
    : 'mt-1 truncate text-[length:var(--t-2xs)]';
  return (
    <p className={`tile-label ${shape} text-ink-2${className ? ` ${className}` : ''}`} title={title}>
      {children}
    </p>
  );
}
