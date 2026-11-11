/**
 * The six things this console is built out of.
 *
 * Written down once because the last version of the admin screen rolled its own
 * `Stat`, `Section` and `Table` in the route file and used none of the app's
 * primitives — `.card`, `.btn` and `.chip` appeared zero times in five hundred
 * lines. Nothing looked broken, which is why it survived; it simply belonged to a
 * different application than the one around it, and every new panel was another
 * chance for the borders and the type sizes to drift again.
 */
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Card, Chip } from '../../components/ui';

/* ── formatting ────────────────────────────────────────────────────────────── */

/** "4m ago". The only clock an operator needs on a table. */
export function when(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  return ago(Math.max(0, Math.round((Date.now() - t) / 1000)));
}

/**
 * Round ONCE, then split.
 *
 * Rounding the hours and the minutes independently prints "3h 60m": 3,570
 * seconds is 0 hours by `floor` and 60 minutes by `round`, and neither half knows
 * the other exists. Converting to whole minutes first and dividing that makes the
 * carry impossible rather than unlikely.
 */
function spell(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  /* Each branch tests the value it has already rounded, so 86,399 seconds cannot
     come out as "24h 0m" on its way to being a day. */
  if (m < 1440) return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.round(m / 1440)}d`;
}
function ago(s: number): string { return `${spell(s)} ago`; }

export function bytes(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export const count = (n: number | null | undefined): string =>
  typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '—';

/* ── surfaces ──────────────────────────────────────────────────────────────── */

/**
 * A number with its own caveat attached.
 *
 * `hint` is not decoration. DEVICES SEEN read "500" for weeks — the server's
 * `LIMIT`, not the answer — three rows above a table that said 1,872, and the
 * only thing that would have caught it is a line under the number saying what it
 * counted. Every stat here says what it counted.
 */
export function Stat({
  label, value, hint, tone = 'default',
}: {
  label: string; value: ReactNode; hint?: ReactNode;
  tone?: 'default' | 'live' | 'alert';
}) {
  const colour = tone === 'live' ? 'text-live' : tone === 'alert' ? 'text-alert' : 'text-ink';
  return (
    <Card className="p-3">
      <p className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">{label}</p>
      <p className={`mt-1 truncate text-2xl ${colour}`}>{value}</p>
      {hint === undefined ? null : (
        <p className="mt-0.5 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">{hint}</p>
      )}
    </Card>
  );
}

/**
 * A titled block.
 *
 * `data-nav-scope` on every one, because this screen is reachable on a television
 * and a console of eight tables with no sections is the "I go to one menu and it
 * jumps to another" complaint with more rows in it.
 */
export function Panel({
  title, note, actions, children, className,
}: {
  title: string; note?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section data-nav-scope className={`mt-6${className ? ` ${className}` : ''}`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-[length:var(--t-xs)] uppercase tracking-widest text-ink-3">{title}</h2>
        {note === undefined ? null : (
          <p className="font-mono text-[length:var(--t-2xs)] text-ink-3">{note}</p>
        )}
        {actions === undefined ? null : <span className="ml-auto flex flex-wrap gap-2">{actions}</span>}
      </div>
      <Card className="overflow-x-auto">{children}</Card>
    </section>
  );
}

/** What a panel shows instead of a table when there is nothing, or when it broke. */
export function Empty({ children, tone = 'quiet' }: { children: ReactNode; tone?: 'quiet' | 'alert' }) {
  return (
    <p className={`p-4 font-mono text-[length:var(--t-xs)] ${tone === 'alert' ? 'text-alert' : 'text-ink-3'}`}>
      {children}
    </p>
  );
}

export interface Column<T> {
  key: string;
  head: string;
  /** Right-aligned and tabular: every column that holds a number should say so. */
  num?: boolean;
  cell: (row: T) => ReactNode;
}

export function Table<T>({
  columns, rows, empty, rowKey, onRow,
}: {
  columns: Column<T>[];
  rows: T[];
  empty: string;
  rowKey: (row: T, i: number) => string;
  /** When given, every row becomes a control — so the D-pad can reach it too. */
  onRow?: (row: T) => void;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <table className="w-full min-w-[38rem] text-left text-[length:var(--t-sm)]">
      <thead>
        <tr className="border-b border-rule">
          {columns.map((c) => (
            <th
              key={c.key}
              className={`px-3 py-2 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3
                          ${c.num === true ? 'text-right' : ''}`}
            >
              {c.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={rowKey(r, i)}
            {...(onRow === undefined ? {} : {
              tabIndex: 0,
              role: 'button',
              onClick: () => onRow(r),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRow(r); }
              },
              className: 'cursor-pointer border-b border-rule/50 last:border-0 hover:bg-panel-2',
            })}
            {...(onRow === undefined ? { className: 'border-b border-rule/50 last:border-0' } : {})}
          >
            {columns.map((c) => (
              <td
                key={c.key}
                className={`px-3 py-2 align-top text-ink-2 ${c.num === true ? 'text-right tabular-nums' : ''}`}
              >
                {c.cell(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Page controls that say where you are in what.
 *
 * "1–50 of 1,918" rather than a pair of arrows, because the number of rows behind
 * a table is the fact this console most often exists to report, and hiding it
 * inside the paging is how a screen ends up quoting its own page size as an
 * answer.
 */
export function Pager({
  page, size, total, onPage,
}: {
  page: number; size: number; total: number; onPage: (p: number) => void;
}) {
  const last = Math.max(0, Math.ceil(total / size) - 1);
  const from = total === 0 ? 0 : page * size + 1;
  const to = Math.min(total, (page + 1) * size);
  return (
    <div className="flex items-center gap-2 border-t border-rule px-3 py-2">
      <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">
        {count(from)}–{count(to)} of {count(total)}
      </span>
      <span className="ml-auto flex gap-2">
        <Button icon disabled={page <= 0} onClick={() => onPage(page - 1)} aria-label="Previous page"
          className="disabled:opacity-30">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button icon disabled={page >= last} onClick={() => onPage(page + 1)} aria-label="Next page"
          className="disabled:opacity-30">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </span>
    </div>
  );
}

/** A row of mutually exclusive filters. */
export function Picker<T extends string>({
  value, options, onPick, label,
}: {
  value: T; options: { value: T; label: string }[]; onPick: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Chip key={o.value} on={o.value === value} onClick={() => onPick(o.value)}>{o.label}</Chip>
      ))}
    </div>
  );
}
