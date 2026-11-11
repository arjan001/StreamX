import { useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, Eye, EyeOff, GripVertical, RotateCcw, Search, Star,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, linkId, type Category, type Item, type Section } from '../lib/api';
import { displayName } from '../lib/displayName';
import { useCategories, marketName } from '../lib/groups';
import { Chip, Field } from './ui';
import { Tooltip } from './Tooltip';
import { reorderFrom } from '../lib/ordering';
import {
  scopeParams, setCatOrder, toggleHiddenCat, toggleHiddenStream, usePrefs,
} from '../lib/prefs';
import { useShape } from '../lib/formFactor';
import { useEnsurePackages } from '../lib/packages';
import { useTally } from '../lib/tally';

/**
 * A profile's packages and channels, in one screen.
 *
 * The packages are the provider's own: 829 live categories, 119 for films, 95 for
 * series, each with its country and its item count. Nothing here invents a
 * grouping — the market, the clean name and the count all come from the catalogue,
 * which is what "use the packages the API already gives you" means.
 *
 * ── three things a list of 829 needs ──
 *
 * **Grouped by country**, collapsed by default, because a flat 829-row list is not
 * something anyone edits — it is something they scroll past. The country is the
 * subcategory level the data actually has.
 *
 * **A partial order.** Dragging four packages to the top is a complete
 * instruction; ranking 829 is not. See `lib/ordering.ts`.
 *
 * **Reordering without a pointer.** A television has a D-pad and no drag gesture,
 * so every move is also two buttons — and those are not a lesser path: they are
 * the only path on the device this app is mostly used on. Pointer drag is the
 * addition, not the other way round.
 */
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'live', label: 'Channels' },
  { id: 'movies', label: 'Films' },
  { id: 'series', label: 'Series' },
];

type Filter = 'all' | 'visible' | 'hidden';

/**
 * The channels inside one package.
 *
 * The other half of what was asked for, and deliberately reached THROUGH a
 * package rather than offered as a flat list: 55,430 channels is not a screen, and
 * nobody hides one without knowing which package it came from. Opened on demand,
 * so the request only happens for the package someone actually opened.
 *
 * Hiding here is by PROVIDER id and it reaches the API, not just the render: the
 * page and the count come from the same WHERE clause, so a total that still counts
 * hidden channels cannot happen.
 */
function ChannelList({ section, category }: { section: Section; category: Category }) {
  const [prefs] = usePrefs();
  const hidden = new Set(prefs.hideStreams);
  /* On an on-demand library this is the screen where somebody deliberately opens
     a package they have not downloaded — so it has to be able to fetch one, like
     the lists do. */
  useEnsurePackages(section, { categoryId: category.id });
  const { data, isLoading } = useQuery({
    queryKey: ['manager', 'channels', section, category.id],
    queryFn: () => api.items(section, { categoryId: category.id, limit: 200, sort: 'default' }),
    staleTime: 120_000,
  });
  const rows: Item[] = data?.rows ?? [];

  if (isLoading) {
    return <div className="space-y-px px-3 py-2">{Array.from({ length: 5 }, (_, i) => (
      <div key={i} className="skeleton h-8" />
    ))}</div>;
  }
  return (
    <div className="border-b border-rule/40 bg-ground/40 px-3 py-1.5">
      {rows.length === 0 && (
        <p className="py-2 font-mono text-[length:var(--t-2xs)] text-ink-3">this package is empty right now.</p>
      )}
      {rows.map((it) => {
        const off = it.streamId !== null && hidden.has(it.streamId);
        return (
          <div key={linkId(it)} className="flex items-center gap-2 py-0.5">
            <span className={`min-w-0 flex-1 truncate text-[length:var(--t-sm)] ${off ? 'text-ink-3 line-through' : 'text-ink-2'}`}>
              {displayName(it.name)}
            </span>
            <button
              type="button"
              onClick={() => toggleHiddenStream(it.streamId)}
              aria-label={off ? `Show ${displayName(it.name)}` : `Hide ${displayName(it.name)}`}
              className={`tap border px-1 py-0.5 ${off
                ? 'border-alert text-alert'
                : 'border-rule text-ink-3 hover:border-tally hover:text-tally'}`}
            >
              {off ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </button>
          </div>
        );
      })}
      {rows.length >= 200 && (
        <p className="py-1 font-mono text-[length:var(--t-2xs)] text-ink-3">
          showing the first 200 of {category.count.toLocaleString()} — search narrows a package
          faster than scrolling one.
        </p>
      )}
    </div>
  );
}

export function PackageManager({ section: fixed }: {
  /**
   * Which section to manage, when the caller owns that choice.
   *
   * The organise screen has Channels, Films and Series as entries in its own
   * sidebar, so a second row of tabs inside this component would be two tab
   * strips on one screen — the thing that layout exists to stop. Unset keeps the
   * component self-contained, with its own switcher.
   */
  section?: Section;
} = {}) {
  const tallyOf = useTally();
  const [prefs] = usePrefs();
  const shape = useShape();
  const [ownSection, setSection] = useState<Section>('live');
  const section = fixed ?? ownSection;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  /** Which package's channels are expanded. One at a time: this is a request. */
  const [channelsOf, setChannelsOf] = useState<string | null>(null);

  /*
    Deliberately NOT scoped by the hidden list: this is the screen where hidden
    packages are un-hidden, so it has to be able to see them. Everything else in
    the app reads the same endpoint through `scopeParams`, which drops them.
  */
  const scope = useMemo(() => {
    const { hideCats: _a, hideCatRefs: _b, hidePaths: _c, ...rest } = scopeParams(prefs);
    return rest;
  }, [prefs]);
  const rows = useCategories(section, scope);

  const hidden = new Set(prefs.hideCatRefs);
  const order = prefs.catOrder[section] ?? [];

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((c) => {
      if (filter === 'hidden' && !hidden.has(c.ref)) return false;
      if (filter === 'visible' && hidden.has(c.ref)) return false;
      if (needle === '') return true;
      return c.cleanName.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle);
    });
  }, [rows, q, filter, prefs.hideCatRefs]);

  /** Country -> its packages, in the order the list is currently displayed in. */
  const groups = useMemo(() => {
    const by = new Map<string, Category[]>();
    for (const c of shown) {
      const key = c.region ?? '—';
      const list = by.get(key);
      if (list === undefined) by.set(key, [c]);
      else list.push(c);
    }
    return [...by.entries()];
  }, [shown]);

  /** A move is expressed against the whole displayed list, never against a group. */
  const move = (ref: string, delta: number) => {
    const from = shown.findIndex((c) => c.ref === ref);
    if (from < 0) return;
    setCatOrder(section, reorderFrom(shown, from, from + delta));
  };

  const drop = (target: string) => {
    if (dragging === null || dragging === target) return;
    const from = shown.findIndex((c) => c.ref === dragging);
    const to = shown.findIndex((c) => c.ref === target);
    if (from < 0 || to < 0) return;
    setCatOrder(section, reorderFrom(shown, from, to));
    setDragging(null);
  };

  const pinToTop = (ref: string) => {
    const from = shown.findIndex((c) => c.ref === ref);
    if (from < 0) return;
    setCatOrder(section, reorderFrom(shown, from, 0));
  };

  const visibleCount = rows.length - rows.filter((c) => hidden.has(c.ref)).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-rule px-3 py-2">
        {fixed === undefined && SECTIONS.map((s) => (
          <Chip key={s.id} on={section === s.id} onClick={() => setSection(s.id)} className="tap">
            {s.label}
          </Chip>
        ))}
        {fixed === undefined && <span className="w-2" />}
        {(['all', 'visible', 'hidden'] as Filter[]).map((f) => (
          <Chip key={f} on={filter === f} onClick={() => setFilter(f)} className="tap">
            {f === 'all' ? 'All' : f === 'visible' ? 'Showing' : 'Hidden'}
          </Chip>
        ))}
        <Field
          value={q}
          onValue={setQ}
          placeholder="find a package…"
          icon={<Search className="h-3 w-3" />}
          className="flex-1 basis-40"
        />
        <span className="font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
          {visibleCount}/{rows.length} showing
        </span>
        {order.length > 0 && (
          <Tooltip label="Back to the provider's own order">
            <button
              type="button"
              onClick={() => setCatOrder(section, [])}
              aria-label="Reset the order"
              className="tap border border-rule p-1.5 text-ink-3 hover:border-tally hover:text-tally"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <p className="p-6 font-mono text-xs text-ink-3">
            nothing here{q ? ` matching “${q}”` : ''}.
          </p>
        )}
        {groups.map(([region, list]) => {
          const isOpen = open.has(region) || q.trim() !== '' || groups.length === 1;
          const off = list.filter((c) => hidden.has(c.ref)).length;
          return (
            <section key={region}>
              <button
                type="button"
                onClick={() => setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(region)) next.delete(region);
                  else next.add(region);
                  return next;
                })}
                className="row-hover flex w-full items-center gap-2 border-b border-rule/60 bg-panel/60
                           px-3 py-2 text-left"
              >
                {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-ink-3" />
                  : <ChevronRight className="h-3.5 w-3.5 text-ink-3" />}
                <span className="min-w-0 flex-1 truncate text-[length:var(--t-sm)] text-ink">
                  {region === '—' ? 'Everything else' : marketName(region)}
                </span>
                <span className="font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
                  {list.length} package{list.length === 1 ? '' : 's'}
                  {off > 0 ? ` · ${off} hidden` : ''}
                </span>
              </button>

              {isOpen && list.map((c) => {
                const off2 = hidden.has(c.ref);
                const ranked = order.indexOf(c.ref);
                return (
                  <div
                    key={c.ref}
                    /* Pointer drag for a mouse; the buttons below are the path on
                       every other input, and the only one on a television. */
                    draggable={shape.pointer === 'fine'}
                    onDragStart={() => setDragging(c.ref)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => drop(c.ref)}
                    onDragEnd={() => setDragging(null)}
                    className={`flex items-center gap-2 border-b border-rule/40 px-3 py-1.5
                      ${dragging === c.ref ? 'opacity-40' : ''}
                      ${off2 ? 'opacity-55' : ''}`}
                  >
                    {shape.pointer === 'fine' && (
                      <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-ink-3" aria-hidden />
                    )}
                    <button
                      type="button"
                      onClick={() => setChannelsOf((cur) => (cur === c.ref ? null : c.ref))}
                      aria-label={`Channels in ${c.cleanName}`}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className={`block truncate text-[length:var(--t-sm)] ${off2 ? 'text-ink-3 line-through' : 'text-ink'}`}>
                        {channelsOf === c.ref ? '▾ ' : '▸ '}{c.cleanName}
                      </span>
                      <span className="block font-mono text-[length:var(--t-2xs)] text-ink-3">
                        {c.count > 0 ? `${tallyOf(c.count)} item${c.count === 1 ? '' : 's'}` : ''}
                        {c.source ? ` · ${c.source}` : ''}
                        {ranked >= 0 ? ` · pinned #${ranked + 1}` : ''}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => move(c.ref, -1)}
                      aria-label={`Move ${c.cleanName} up`}
                      className="tap border border-rule px-1.5 py-1 font-mono text-[length:var(--t-2xs)] text-ink-3
                                 hover:border-tally hover:text-tally"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => move(c.ref, 1)}
                      aria-label={`Move ${c.cleanName} down`}
                      className="tap border border-rule px-1.5 py-1 font-mono text-[length:var(--t-2xs)] text-ink-3
                                 hover:border-tally hover:text-tally"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      onClick={() => pinToTop(c.ref)}
                      aria-label={`Pin ${c.cleanName} to the top`}
                      className={`tap border px-1.5 py-1 ${ranked === 0
                        ? 'border-tally text-tally'
                        : 'border-rule text-ink-3 hover:border-tally hover:text-tally'}`}
                    >
                      <Star className={`h-3.5 w-3.5 ${ranked === 0 ? 'fill-current' : ''}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleHiddenCat(c.ref)}
                      aria-label={off2 ? `Show ${c.cleanName}` : `Hide ${c.cleanName}`}
                      className={`tap border px-1.5 py-1 ${off2
                        ? 'border-alert text-alert'
                        : 'border-rule text-ink-3 hover:border-tally hover:text-tally'}`}
                    >
                      {off2 ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                );
              })}
              {isOpen && list.some((c) => c.ref === channelsOf) && (
                <ChannelList
                  section={section}
                  category={list.find((c) => c.ref === channelsOf)!}
                />
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
